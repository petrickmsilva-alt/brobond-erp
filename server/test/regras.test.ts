// Testes das regras de negócio (modo memória — não precisa de banco).
// Rodar: npm test (na pasta server) ou npm test na raiz.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
delete process.env.DATABASE_URL;

const { RESOURCES, getResource } = await import('../src/resources');
const { createRecord, updateRecord, deleteRecord, getRecord, listRecords, getStore } = await import('../src/services');
const { validatePayload } = await import('../src/validate');
const { HttpError } = await import('../src/errors');

const admin = { id: 1, name: 'Admin', perfil: 'admin' as const };
const operador = { id: 2, name: 'Op', perfil: 'operador' as const };

async function expectHttp(fn: () => Promise<unknown>, status: number, re?: RegExp) {
  try {
    await fn();
  } catch (e: any) {
    assert.ok(e instanceof HttpError, `esperava HttpError, veio ${e?.constructor?.name}: ${e?.message}`);
    assert.equal(e.status, status, `status ${e.status} ≠ ${status}: ${e.message}`);
    if (re) assert.match(e.message, re);
    return e;
  }
  assert.fail(`esperava erro ${status}`);
}

let produtoId: number;
before(async () => {
  getStore();
  const p = await createRecord(RESOURCES.produtos, { sku: 'T-001', nome: 'Camisa Teste', custo: 10, preco_venda: 25, cor_id: 3, categoria_id: 1 }, admin);
  produtoId = Number(p.id);
});

test('validação: EAN aceita 8/12/13/14 dígitos e rejeita o resto', () => {
  for (const ok of ['12345678', '123456789012', '7891234567895', '12345678901234']) {
    assert.equal(validatePayload(RESOURCES.produtos, { sku: 'x', nome: 'y', codigo_barras: ok }, 'create').codigo_barras, ok);
  }
  for (const bad of ['123', 'abc', '1234567890', '12345678901']) {
    assert.throws(() => validatePayload(RESOURCES.produtos, { sku: 'x', nome: 'y', codigo_barras: bad }, 'create'), /8, 12, 13 ou 14/);
  }
  assert.throws(() => validatePayload(RESOURCES.produtos, { sku: 'x', nome: 'y', codigo_barras: '123456789012345' }, 'create'), /Máximo de 14/);
});

test('validação: cor hexadecimal normaliza #abc → #AABBCC e rejeita inválidas', () => {
  assert.equal(validatePayload(RESOURCES.cores, { nome: 'a', hex: 'abc' }, 'create').hex, '#AABBCC');
  assert.equal(validatePayload(RESOURCES.cores, { nome: 'a', hex: '#1f3a5f' }, 'create').hex, '#1F3A5F');
  assert.throws(() => validatePayload(RESOURCES.cores, { nome: 'a', hex: 'zzz' }, 'create'), /hexadecimal/);
});

test('produto: rótulos de cor/categoria e amostra hex vêm na leitura', async () => {
  const p = await getRecord(RESOURCES.produtos, produtoId);
  assert.equal(p.cor_id__label, 'Azul marinho');
  assert.equal(p.cor_id__color, '#1F3A5F');
  assert.equal(p.categoria_id__label, 'Camisa');
  assert.deepEqual(p.fotos, []);
  assert.equal(p.foto_url, null);
});

test('produto: SKU e código de barras são únicos', async () => {
  await updateRecord(RESOURCES.produtos, produtoId, { codigo_barras: '7891234567895' }, admin);
  await expectHttp(() => createRecord(RESOURCES.produtos, { sku: 'T-001', nome: 'dup' }, admin), 409);
  await expectHttp(() => createRecord(RESOURCES.produtos, { sku: 'T-002', nome: 'dup', codigo_barras: '7891234567895' }, admin), 409);
});

test('estoque: saída sem saldo é bloqueada; entrada cria saldo', async () => {
  await expectHttp(() => createRecord(RESOURCES.movimentacoes, { tipo: 'saida', produto_id: produtoId, tamanho_id: 3, quantidade: 1 }, admin), 409, /Saldo insuficiente/);
  await createRecord(RESOURCES.movimentacoes, { tipo: 'entrada', produto_id: produtoId, tamanho_id: 3, quantidade: 10 }, admin);
  const saldo = await listRecords(RESOURCES.estoques, { page: 1, pageSize: 10, filter: { produto_id: produtoId } });
  assert.equal(saldo.rows.length, 1);
  assert.equal(Number(saldo.rows[0].quantidade), 10);
  await createRecord(RESOURCES.movimentacoes, { tipo: 'saida', produto_id: produtoId, tamanho_id: 3, quantidade: 4 }, admin);
  const depois = await getRecord(RESOURCES.estoques, Number(saldo.rows[0].id));
  assert.equal(Number(depois.quantidade), 6);
});

test('estoque: movimentações são imutáveis', async () => {
  const movs = await listRecords(RESOURCES.movimentacoes, { page: 1, pageSize: 1 });
  const id = Number(movs.rows[0].id);
  const { checkAccess } = await import('../src/services');
  assert.throws(() => checkAccess(RESOURCES.movimentacoes, admin, 'update'), /Não é possível alterar/);
  assert.throws(() => checkAccess(RESOURCES.movimentacoes, admin, 'delete'), /Não é possível excluir/);
  void id;
});

test('OP: concluir dá entrada no estoque; reabrir estorna; não exclui concluída', async () => {
  const op = await createRecord(RESOURCES.ordens, { produto_id: produtoId, tamanho_id: 4, quantidade: 20, status: 'planejada' }, admin);
  const antes = await listRecords(RESOURCES.estoques, { page: 1, pageSize: 10, filter: { produto_id: produtoId, tamanho_id: 4 } });
  assert.equal(antes.rows.length, 0);
  await updateRecord(RESOURCES.ordens, Number(op.id), { status: 'concluida' }, admin);
  const dep = await listRecords(RESOURCES.estoques, { page: 1, pageSize: 10, filter: { produto_id: produtoId, tamanho_id: 4 } });
  assert.equal(Number(dep.rows[0].quantidade), 20);
  await expectHttp(() => deleteRecord(RESOURCES.ordens, Number(op.id), admin), 409, /concluída/i);
  await updateRecord(RESOURCES.ordens, Number(op.id), { status: 'em_producao' }, admin);
  const est = await getRecord(RESOURCES.estoques, Number(dep.rows[0].id));
  assert.equal(Number(est.quantidade), 0);
});

test('permissões: operador não exclui; módulos admin-only bloqueiam gerente', async () => {
  const { checkAccess } = await import('../src/services');
  assert.throws(() => checkAccess(RESOURCES.produtos, operador, 'delete'), /Operadores não podem excluir/);
  assert.throws(() => checkAccess(RESOURCES.usuarios, { ...operador, perfil: 'gerente' }, 'read'), /administradores/);
  assert.doesNotThrow(() => checkAccess(RESOURCES.produtos, operador, 'create'));
});

test('usuários: não remove o último administrador', async () => {
  const u = await createRecord(RESOURCES.usuarios, { nome: 'Único Admin', email: 'unico@x.com', perfil: 'admin', senha: 'Forte#2024x' }, admin);
  await expectHttp(() => updateRecord(RESOURCES.usuarios, Number(u.id), { perfil: 'operador' }, { id: 99, name: 'outro', perfil: 'admin' }), 400, /único administrador/);
});

test('produto: excluir produto em uso é bloqueado (409); produto sem uso é excluído', async () => {
  await expectHttp(() => deleteRecord(RESOURCES.produtos, produtoId, admin), 409, /em uso/);
  const tmp = await createRecord(RESOURCES.produtos, { sku: 'TMP', nome: 'tmp' }, admin);
  await deleteRecord(RESOURCES.produtos, Number(tmp.id), admin);
  await expectHttp(() => getRecord(RESOURCES.produtos, Number(tmp.id)), 404);
});

test('catálogos públicos: cria com token, lista com rótulo da coleção e não vaza senha', async () => {
  const cat = await createRecord(
    RESOURCES.catalogos,
    { nome: 'Catálogo Verão reps', colecao_id: 1, mostrar_preco: true, mostrar_saldo: false },
    admin
  );
  assert.ok(typeof cat.token === 'string' && String(cat.token).length >= 24);
  assert.equal(cat.colecao_id, 1);
  assert.equal(cat.senha_hash, undefined);
  const lista = await listRecords(RESOURCES.catalogos, { page: 1, pageSize: 50 });
  const row = lista.rows.find((r) => Number(r.id) === Number(cat.id));
  assert.ok(row, 'catálogo deve aparecer na listagem');
  assert.equal(row!.colecao_id__label, 'Verão 2026');
  assert.equal(row!.senha_hash, undefined);

  const { filtrosDoCatalogo } = await import('../src/catalogos');
  assert.deepEqual(filtrosDoCatalogo(row!), { colecao_id: 1 });
  assert.deepEqual(filtrosDoCatalogo({ id: 0, filtros: { colecao_id: 2, categoria_id: 3 } }), { colecao_id: 2, categoria_id: 3 });
  assert.deepEqual(filtrosDoCatalogo({ id: 0, colecao_id: 9, filtros: { colecao_id: 2 } }), { colecao_id: 9 });
});

test('fase 4: tokens do portal usam SHA-256 completo e recursos são internos', async () => {
  const { hashPortalToken } = await import('../src/portal');
  const { getPublicResource, publicMeta } = await import('../src/resources');
  const token = 'b'.repeat(64);
  assert.equal(hashPortalToken(token).length, 64);
  assert.notEqual(hashPortalToken(token), token);
  assert.equal(getPublicResource('portal_acessos'), undefined);
  assert.equal(getPublicResource('cotacao_decisoes'), undefined);
  assert.ok(!('portal_acessos' in publicMeta()));
});

test('fase 3B: permissões comerciais herdam perfil e aceitam concessão/negação individual', async () => {
  const { podeComercial, checkAccess } = await import('../src/services');
  const vendedor: any = { id: 77, name: 'Vendedor', perfil: 'operador', perm_compartilhar: 'permitir' };
  assert.equal(podeComercial(vendedor, 'compartilhar'), true);
  assert.equal(podeComercial(vendedor, 'politicas'), false);
  assert.doesNotThrow(() => checkAccess(RESOURCES.catalogos, vendedor, 'read'));
  assert.throws(() => checkAccess(RESOURCES.catalogos, vendedor, 'update'), /permissão comercial/);
  const gerenteNegado: any = { id: 78, name: 'Gerente', perfil: 'gerente', perm_metricas: 'negar' };
  assert.equal(podeComercial(gerenteNegado, 'metricas'), false);
  assert.equal(podeComercial({ ...gerenteNegado, perfil: 'admin' }, 'metricas'), true);
});

test('fase 3B: permissão explícita controla aprovação de exceções', async () => {
  const { podeAprovar } = await import('../src/approval');
  assert.equal(podeAprovar({ id: 1, name: 'V', email: 'v@x', perfil: 'operador', perm_aprovar: 'permitir' }), true);
  assert.equal(podeAprovar({ id: 2, name: 'G', email: 'g@x', perfil: 'gerente', perm_aprovar: 'negar' }), false);
});

test('fase 3A: política mais específica prevalece e preço é calculado pelo servidor', async () => {
  const cat = await createRecord(RESOURCES.catalogos, { nome: 'Catálogo Política', colecao_id: 1, canal: 'atacado' }, admin);
  await createRecord(RESOURCES.politicas_comerciais, { nome: 'Geral 3%', escopo: 'geral', desconto_pct: 3, multiplo_qtd: 1, ativo: true }, admin);
  await createRecord(RESOURCES.politicas_comerciais, { nome: 'Coleção 8%', escopo: 'colecao', colecao_id: 1, desconto_pct: 8, pedido_min_pecas: 12, multiplo_qtd: 3, ativo: true }, admin);
  const { resolverPoliticaComercial, precoComPolitica } = await import('../src/politicasComerciais');
  const politica = await resolverPoliticaComercial({ catalogo: cat, canal: 'atacado' });
  assert.equal(politica?.nome, 'Coleção 8%');
  assert.equal(politica?.pedido_min_pecas, 12);
  assert.equal(politica?.multiplo_qtd, 3);
  assert.equal(precoComPolitica(100, politica), 92);
});

test('fase 3A: política rejeita escopo incompleto e vigência invertida', async () => {
  await expectHttp(() => createRecord(RESOURCES.politicas_comerciais, { nome: 'Inválida', escopo: 'cliente', multiplo_qtd: 1 }, admin), 400, /Informe cliente/);
  await expectHttp(() => createRecord(RESOURCES.politicas_comerciais, { nome: 'Datas', escopo: 'geral', inicio_em: '2027-12-01', fim_em: '2027-01-01', multiplo_qtd: 1 }, admin), 400, /vigência/);
});

test('fase 2: recursos de inteligência do catálogo são internos e tokens usam hash irreversível', async () => {
  const { getPublicResource, publicMeta } = await import('../src/resources');
  const { hashTokenPublico } = await import('../src/catalogos');
  assert.equal(getPublicResource('catalogo_compartilhamentos'), undefined);
  assert.equal(getPublicResource('catalogo_eventos'), undefined);
  assert.ok(!('catalogo_compartilhamentos' in publicMeta()));
  const token = 'a'.repeat(48);
  assert.equal(hashTokenPublico(token).length, 64);
  assert.notEqual(hashTokenPublico(token), token);
  assert.equal(hashTokenPublico(token), hashTokenPublico(token));
});

test('arquivos: recurso interno não é exposto na API genérica nem no /meta', async () => {
  const { getPublicResource, publicMeta } = await import('../src/resources');
  assert.equal(getPublicResource('arquivos'), undefined);
  assert.ok(!('arquivos' in publicMeta()));
  assert.ok('produtos' in publicMeta());
});

test('segurança: rate limit PERSISTENTE bloqueia após 5 falhas e libera após sucesso', async () => {
  const { loginRateLimit, registerLoginFailure, registerLoginSuccess } = await import('../src/security');
  const req: any = { body: { email: 'rl@x.com' }, headers: {}, socket: { remoteAddress: '10.0.0.1' } };
  let status = 0;
  const res: any = { status: (s: number) => ((status = s), res), json: () => res, setHeader: () => res };
  const proximo = () => (status = 200);
  for (let i = 0; i < 5; i++) await registerLoginFailure(req);
  await loginRateLimit(req, res, proximo);
  assert.equal(status, 429);
  await registerLoginSuccess(req);
  await loginRateLimit(req, res, proximo);
  assert.equal(status, 200);
});

test('financeiro: aporte confirmado gera lançamento de investimento e estorno cancela', async () => {
  const inv = await createRecord(RESOURCES.investidores, { nome: 'Anjo Teste', tipo: 'investidor' }, admin);
  const aporte = await createRecord(RESOURCES.aportes, { investidor_id: Number(inv.id), data: '2026-09-04', tipo: 'aporte', valor: 5000, forma_pagamento: 'pix', status: 'confirmado' }, admin);
  assert.ok(Number(aporte.fin_lancamento_id) > 0, 'aporte confirmado deve gerar lançamento');
  const lancs = await listRecords(RESOURCES.lancamentos_financeiros, { page: 1, pageSize: 50, filter: { referencia_tipo: 'aporte', referencia_id: Number(aporte.id) } });
  assert.equal(lancs.rows.length, 1);
  assert.equal(lancs.rows[0].tipo, 'investimento');
  assert.equal(Number(lancs.rows[0].valor), 5000);
  await updateRecord(RESOURCES.aportes, Number(aporte.id), { status: 'estornado' }, admin);
  const depois = await listRecords(RESOURCES.lancamentos_financeiros, { page: 1, pageSize: 50, filter: { referencia_tipo: 'aporte', referencia_id: Number(aporte.id) } });
  assert.equal(depois.rows[0].status, 'cancelado');
});

test('financeiro: venda faturada carrega vencimento e parcelas no lançamento', async () => {
  const cli = await createRecord(RESOURCES.clientes, { nome: 'Cliente Venc', tipo: 'loja' }, admin);
  const venda = await createRecord(
    RESOURCES.vendas,
    { cliente_id: Number(cli.id), data: '2026-09-04', status: 'aberta', canal_venda: 'site_varejo', fin_status: 'a_receber', fin_vencimento: '2026-09-25', fin_parcelas: 3 },
    admin
  );
  await getStore().insert(getResource('itens_venda')!, { venda_id: Number(venda.id), produto_id: 1, tamanho_id: 1, quantidade: 1, preco_unitario: 10, subtotal: 10 });
  await getStore().adjustStock(1, 1, 'loja', 10);
  await updateRecord(RESOURCES.vendas, Number(venda.id), { status: 'faturada' }, admin);
  const lancs = await listRecords(RESOURCES.lancamentos_financeiros, { page: 1, pageSize: 50, filter: { referencia_tipo: 'venda', referencia_id: Number(venda.id) } });
  // Parcelamento real (Onda B): 3 parcelas reais, vencimentos mensais a partir do informado
  assert.equal(lancs.rows.length, 3);
  const ordenadas = [...lancs.rows].sort((a, b) => Number(a.parcela) - Number(b.parcela));
  assert.deepEqual(ordenadas.map((p) => Number(p.parcela)), [1, 2, 3]);
  assert.deepEqual(ordenadas.map((p) => Number(p.total_parcelas)), [3, 3, 3]);
  assert.equal(String(ordenadas[0].vencimento || '').slice(0, 10), '2026-09-25');
  assert.equal(String(ordenadas[1].vencimento || '').slice(0, 10), '2026-10-25');
  assert.equal(String(ordenadas[2].vencimento || '').slice(0, 10), '2026-11-25');
});

test('financeiro: recorrência vencida é gerada como lançamento pendente', async () => {
  const { processarRecorrencias } = await import('../src/financeiro');
  const rec = await createRecord(RESOURCES.recorrencias_financeiras, { descricao: 'Aluguel teste', tipo: 'despesa', valor: 800, frequencia: 'mensal', dia: 1, proxima_geracao: '2026-08-01', status: 'ativo' }, admin);
  const out = await processarRecorrencias({ id: admin.id, name: admin.name });
  assert.ok(out.gerados >= 1);
  const lancs = await listRecords(RESOURCES.lancamentos_financeiros, { page: 1, pageSize: 50, filter: { referencia_tipo: 'recorrencia', referencia_id: Number(rec.id) } });
  assert.ok(lancs.rows.length >= 1);
  assert.equal(lancs.rows[0].status, 'pendente');
  assert.equal(lancs.rows[0].tipo, 'despesa');
  const rec2 = await getRecord(RESOURCES.recorrencias_financeiras, Number(rec.id));
  assert.ok(String(rec2.proxima_geracao || '') >= '2026-09-01', 'próxima geração atualizada para o futuro');
});

test('locais: único Local padrão; movimentação sem local usa o padrão', async () => {
  const s = getStore();
  const { getDefaultLocal } = await import('../src/services');

  // Garante estado inicial: loja é o padrão (mock).
  await updateRecord(RESOURCES.locais, 1, { padrao: true }, admin);
  assert.equal(await getDefaultLocal(), 'loja');

  // Marca "expedicao" como padrão via CRUD -> loja deve ser desmarcada (apenas 1 padrão).
  const expedicao = await s.findOneWhere(RESOURCES.locais, { nome: 'expedicao' });
  await updateRecord(RESOURCES.locais, Number(expedicao.id), { padrao: true }, admin);
  assert.equal(await getDefaultLocal(), 'expedicao', 'novo padrão de origem é a expedição');
  const loja = await s.findOneWhere(RESOURCES.locais, { nome: 'loja' });
  assert.equal(loja?.padrao, false, 'ao marcar outro padrão, o anterior é desmarcado');

  // Movimentação sem local informado cai no Local padrão.
  const p = await createRecord(RESOURCES.produtos, { sku: 'T-PAD', nome: 'Teste Padrão', custo: 30, preco_venda: 90 }, admin);
  const mov = await createRecord(RESOURCES.movimentacoes, { tipo: 'entrada', produto_id: Number(p.id), tamanho_id: 3, quantidade: 5 }, admin);
  assert.equal(String(mov.local), 'expedicao', 'entrada sem local usa o Local padrão');

  // Restaura o padrão original.
  await updateRecord(RESOURCES.locais, 1, { padrao: true }, admin);
  assert.equal(await getDefaultLocal(), 'loja');
});
