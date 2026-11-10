// ============================================================================
// FASE 9.6 — ENTERPRISE VALIDATION (PostgreSQL REAL).
//
// Prova, em PostgreSQL de verdade, as cadeias entre domínios e os gates de
// segurança que sustentam as Fases 9.4/9.5 — sem memória e sem mock de banco:
//
//   A) TENANCY: duas empresas independentes. A lê/escreve/exclui o seu; B não
//      alcança o de A (404, sem vazar existência) e não o vê na listagem.
//   B) RBAC: operador NÃO cria plano de contas (minPerfil gerente) — o gate é
//      do SERVIDOR, não da tela.
//   C) FISCAL: o leiaute versionado da migração 0115 resolve por período; o
//      validador estrutural aceita o arquivo bem-formado e reprova o inválido.
//   D) UNIDADES: conversão declarada (rolo→m), recusa entre grandezas e
//      ausência de regra → null (nunca estima); regra isolada por empresa.
//   E) CADEIA Produto → Estoque → Venda → Financeiro → Balancete: o faturamento
//      baixa o estoque, gera o título e o balancete lê o MESMO livro.
//
// Sem DATABASE_URL este arquivo FALHA: a prova deste ciclo é PostgreSQL.
// ============================================================================
import { test, before } from 'node:test';
import assert from 'node:assert/strict';

if (!process.env.DATABASE_URL) {
  throw new Error('fase9-6-enterprise-validation.test.ts exige DATABASE_URL e PostgreSQL real; não é permitido pular esta prova.');
}
process.env.NODE_ENV = 'test';

const { migrate } = await import('../../src/db');
const { RESOURCES } = await import('../../src/resources');
const {
  createRecord, listRecords, getRecord, updateRecord, deleteRecord, getStore,
} = await import('../../src/services');
const { reqDe, resFake, esperarErro } = await import('../_p1util');
const { balanceteFinanceiro } = await import('../../src/financeiroContabil');
const { calcularConversao, converterQuantidade, regrasDeConversao } = await import('../../src/unidades');
const { validarEfd, resolverLeiauteVigente } = await import('../../src/fiscalLayouts');
const { createItem } = await import('../../src/itens');

await migrate();
const s = getStore();
const SUF = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`.toUpperCase().slice(0, 8);
const DATA = '2026-03-15';
const HOJE = '2026-03';

type Ator = { id: number; name: string; perfil: 'admin' | 'gerente' | 'operador'; empresa_id: number; empresas: number[] };

async function criarEmpresa(nome: string): Promise<number> {
  const admin = { id: 1, name: 'Admin', perfil: 'admin' as const };
  const e = await createRecord(RESOURCES.empresas, { nome: `${nome} ${SUF}` }, admin);
  return Number(e.id);
}

async function criarUsuario(empresaId: number, perfil: Ator['perfil']): Promise<Ator> {
  const row = await s.insert(RESOURCES.usuarios, {
    nome: `U ${perfil} ${SUF}`,
    email: `${perfil}-${empresaId}-${SUF}@brobond.test`,
    perfil,
    empresa_id: empresaId,
    ativo: true,
  });
  return { id: Number(row.id), name: String(row.nome), perfil, empresa_id: empresaId, empresas: [empresaId] };
}

/** Executa um handler HTTP falso e devolve o corpo; lança se o status não casar. */
async function chamar(handler: any, req: any, esperado = 200): Promise<any> {
  const { res, saida } = resFake();
  await handler(req, res);
  const status = saida.status ?? 200;
  assert.equal(status, esperado, `esperava HTTP ${esperado}, veio ${status}: ${JSON.stringify(saida.json)}`);
  return saida.json;
}

const statusDeErro = async (fn: () => Promise<unknown>): Promise<number> => {
  try { await fn(); } catch (e: any) { return Number(e?.status ?? e?.statusCode ?? 0); }
  return 0;
};

let empresaA: number;
let empresaB: number;
let adminA: Ator;
let gerenteA: Ator;
let operadorA: Ator;
let gerenteB: Ator;

before(async () => {
  empresaA = await criarEmpresa('F96 A');
  empresaB = await criarEmpresa('F96 B');
  adminA = await criarUsuario(empresaA, 'admin');
  gerenteA = await criarUsuario(empresaA, 'gerente');
  operadorA = await criarUsuario(empresaA, 'operador');
  gerenteB = await criarUsuario(empresaB, 'gerente');
});

// ---------------------------------------------------------------------------
// A) TENANCY — duas empresas independentes, sem acesso cruzado
// ---------------------------------------------------------------------------
test('9.6/A tenancy: plano de contas de A não é lido, alterado nem excluído por B', async () => {
  const conta = await createRecord(RESOURCES.plano_contas, {
    codigo: `9.6.${SUF}`, nome: 'Receita de vendas A', natureza: 'receita', tipo: 'analitica',
  }, adminA);
  const id = Number(conta.id);
  assert.equal(Number(conta.empresa_id), empresaA, 'a conta nasce na empresa do ator');

  // B não enxerga na listagem.
  const listaB = await listRecords(RESOURCES.plano_contas, { page: 1, pageSize: 1000 }, gerenteB);
  assert.equal(listaB.rows.some((r: any) => Number(r.id) === id), false, 'B não vê a conta de A');

  // B não lê/altera/exclui por id previsível → 404 (não vaza existência).
  assert.equal(await statusDeErro(() => getRecord(RESOURCES.plano_contas, id, gerenteB)), 404);
  assert.equal(await statusDeErro(() => updateRecord(RESOURCES.plano_contas, id, { nome: 'invadido' }, gerenteB)), 404);
  assert.equal(await statusDeErro(() => deleteRecord(RESOURCES.plano_contas, id, gerenteB)), 404);

  // A continua dona e intacta.
  const listaA = await listRecords(RESOURCES.plano_contas, { page: 1, pageSize: 1000 }, gerenteA);
  assert.equal(listaA.rows.some((r: any) => Number(r.id) === id), true);
  const lido = await getRecord(RESOURCES.plano_contas, id, gerenteA);
  assert.equal(String(lido.nome), 'Receita de vendas A');
});

// ---------------------------------------------------------------------------
// B) RBAC — o gate é do servidor (a autorização vive no backend, não na tela)
// ---------------------------------------------------------------------------
test('9.6/B RBAC: operador é barrado em plano de contas (minPerfil gerente); gerente passa', async () => {
  const { checkAccess } = await import('../../src/services');
  // A autorização é do SERVIDOR: o guard recusa o operador (403) e libera o
  // gerente. A mesma regra vale para TODOS os recursos em `rbac-matrix.test.ts`.
  assert.throws(() => checkAccess(RESOURCES.plano_contas, operadorA as any, 'create'), (e: any) => e.status === 403);
  assert.throws(() => checkAccess(RESOURCES.plano_contas, operadorA as any, 'read'), (e: any) => e.status === 403);
  assert.doesNotThrow(() => checkAccess(RESOURCES.plano_contas, gerenteA as any, 'create'));
  // E o serviço, quando chamado por quem passou no guard, cria de fato.
  const ok = await createRecord(RESOURCES.plano_contas, { codigo: `9.6b.${SUF}`, nome: 'Ativo 9.6', natureza: 'ativo', tipo: 'analitica' }, gerenteA);
  assert.ok(Number(ok.id) > 0);
  assert.equal(Number(ok.empresa_id), empresaA);
});

// ---------------------------------------------------------------------------
// C) FISCAL — leiaute versionado (migração 0115) + validador estrutural
// ---------------------------------------------------------------------------
test('9.6/C fiscal: leiaute vigente por período vem do banco; período sem leiaute lança', async () => {
  const l2025 = await resolverLeiauteVigente('EFD_ICMS_IPI', '2025-01');
  assert.equal(l2025.codigo_versao, '020', '2025 usa o leiaute 020 (migração 0115)');
  assert.ok(l2025.fonte_url.includes('sped.rfb.gov.br'), 'a fonte oficial é declarada');
  const l2024 = await resolverLeiauteVigente('EFD_ICMS_IPI', '2024-06');
  assert.equal(l2024.codigo_versao, '019');
  // Período sem leiaute cadastrado NÃO presume a versão mais nova: lança 422.
  assert.equal(await statusDeErro(() => resolverLeiauteVigente('EFD_ICMS_IPI', '2020-01')), 422);
});

test('9.6/C fiscal: validador estrutural aprova o arquivo bem-formado e reprova o inválido', async () => {
  const L = (...c: (string | number)[]) => `|${c.join('|')}|`;
  const chave = '35250111111111000191550010000001231000001234';
  const valido = [
    L('0000', '020', '0', '01032026', '31032026', 'EMPRESA TESTE', '11111111000191', '', 'SP', '111111111111', '3550308', '', '', 'A', '1'),
    L('0001', '0'),
    L('0150', 'FORNEC1', 'FORNECEDOR', '1058', '22222222000191', '', '', '3550308', '', 'Rua A', '100', '', 'Centro'),
    L('0190', 'UN', 'UNIDADE'),
    L('0200', 'PROD1', 'PRODUTO', '', '', 'UN', '00', '61091000', '', '', '', '', ''),
    L('0990', '5'),
    L('C001', '0'),
    L('C100', '0', '1', 'FORNEC1', '55', '00', '', '123', chave, '01032026', '01032026', '100,00', '0', '', '', '100,00', '9', '', '', '', '', '', '', '', '', '', '', '', ''),
    L('C170', '1', 'PROD1', 'PRODUTO', '10,00000', 'UN', '100,00', '', '0', '000', '1102', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', ''),
    L('C190', '000', '1102', '', '100,00', '', '', '', '', '', '', ''),
    L('C990', '5'),
    L('9999', '12'),
  ];
  const ok = validarEfd('EFD_ICMS_IPI', '020', valido);
  assert.equal(ok.valido, true, JSON.stringify(ok.erros));

  // Registro desconhecido reprova (não se aceita leiaute inventado).
  const invalido = [...valido, L('X999', 'lixo')];
  const bad = validarEfd('EFD_ICMS_IPI', '020', invalido);
  assert.equal(bad.valido, false, 'o arquivo inválido é reprovado');
  assert.ok(bad.erros.some((e) => e.codigo === 'REGISTRO_DESCONHECIDO' || e.registro === 'X999'), JSON.stringify(bad.erros));

  // Campo numérico com texto reprova (QTD do C170).
  const semNumero = valido.map((l) => (l.startsWith('|C170|') ? l.replace('|10,00000|', '|dez|') : l));
  assert.equal(validarEfd('EFD_ICMS_IPI', '020', semNumero).valido, false);
});

// ---------------------------------------------------------------------------
// D) UNIDADES — conversão declarada, recusa entre grandezas, isolamento
// ---------------------------------------------------------------------------
test('9.6/D unidades: converte só o declarado; recusa entre grandezas; sem regra → null', async () => {
  await createRecord(RESOURCES.unidades_medida, { codigo: 'rl', nome: 'Rolo', grandeza: 'comprimento', casas_decimais: 2 }, gerenteA);
  await createRecord(RESOURCES.unidades_medida, { codigo: 'm', nome: 'Metro', grandeza: 'comprimento', casas_decimais: 2 }, gerenteA);
  await createRecord(RESOURCES.unidades_medida, { codigo: 'kg', nome: 'Quilo', grandeza: 'massa', casas_decimais: 3 }, gerenteA);
  await createRecord(RESOURCES.unidades_medida, { codigo: 'l', nome: 'Litro', grandeza: 'volume', casas_decimais: 3 }, gerenteA);
  await createRecord(RESOURCES.unidade_conversoes, { de_codigo: 'rl', para_codigo: 'm', fator: 50, ativo: true }, gerenteA);

  const regras = await regrasDeConversao(empresaA);
  assert.equal(calcularConversao('rl', 'm', regras)?.fator, 50);
  assert.equal(calcularConversao('m', 'rl', regras)?.fator, 1 / 50, 'a regra vale nos dois sentidos');
  assert.equal(calcularConversao('rl', 'rl', regras)?.origem, 'identica');
  // Sem regra declarada → null (nunca estima).
  assert.equal(calcularConversao('m', 'kg', regras), null);

  const convertido = await converterQuantidade(empresaA, 2, 'rl', 'm');
  assert.equal(convertido?.quantidade, 100);

  // Grandeza diferente (massa × volume) é recusada NO CADASTRO → 400.
  const e = await esperarErro(
    () => createRecord(RESOURCES.unidade_conversoes, { de_codigo: 'kg', para_codigo: 'l', fator: 1, ativo: true }, gerenteA),
    400
  );
  assert.ok(e, 'conversão entre grandezas é recusada');

  // Isolamento: a regra da empresa A NÃO vale para B.
  assert.equal(await converterQuantidade(empresaB, 2, 'rl', 'm'), null, 'a regra é da empresa');
});

// ---------------------------------------------------------------------------
// E) CADEIA Produto → Estoque → Venda → Financeiro → Balancete
// ---------------------------------------------------------------------------
test('9.6/E cadeia: faturamento baixa o estoque, gera o título e o balancete lê o MESMO livro', async () => {
  const local = await createRecord(RESOURCES.locais, { nome: `Local ${SUF}`, tipo: 'loja', padrao: true, ativo: true }, adminA);
  const produto = await createRecord(RESOURCES.produtos, { sku: `F96-${SUF}`, nome: 'Produto 9.6', preco_venda: 100, custo: 40 }, adminA);
  const tamanho = await createRecord(RESOURCES.tamanhos, { nome: `Tam ${SUF}`, codigo: SUF.slice(0, 6) }, adminA);
  const cliente = await createRecord(RESOURCES.clientes, { nome: 'Cliente 9.6', pessoa: 'pf', documento: '52998224725' }, adminA);

  // Estoque inicial: 10 unidades.
  await createRecord(RESOURCES.movimentacoes, {
    tamanho_id: tamanho.id, produto_id: produto.id, tipo: 'entrada', quantidade: 10, local_id: local.id, motivo: 'Carga inicial 9.6',
  }, adminA);

  const venda = await createRecord(RESOURCES.vendas, { cliente_id: cliente.id, status: 'aberta', data: DATA, total: 200 }, adminA);
  const vendaId = Number(venda.id);
  // Dois itens de 1 unidade (a regra de estoque é produto+tamanho+local).
  const addItem = (req: any) => createItem(req, resFake().res);
  await addItem({ ...reqDe({ produto_id: produto.id, tamanho_id: tamanho.id, quantidade: 1, preco_unitario: 100 }, { params: { id: vendaId }, user: adminA }), path: `/vendas/${vendaId}/itens` });
  await addItem({ ...reqDe({ produto_id: produto.id, tamanho_id: tamanho.id, quantidade: 1, preco_unitario: 100 }, { params: { id: vendaId }, user: adminA }), path: `/vendas/${vendaId}/itens` });

  // Fatura: dispara baixa de estoque + título financeiro (mesma transação).
  await updateRecord(RESOURCES.vendas, vendaId, { status: 'faturada' }, adminA);

  // 1) ESTOQUE: saiu do saldo físico.
  const saldo = (await s.list(RESOURCES.estoques, { page: 1, pageSize: 1000, filter: { empresa_id: empresaA, produto_id: Number(produto.id) } })).rows
    .reduce((acc, r: any) => acc + Number(r.quantidade || 0), 0);
  assert.equal(saldo, 8, '10 inicial − 2 vendidas = 8');

  // 2) MOVIMENTAÇÃO: registrada a saída vinculada à venda.
  const saidas = await s.list(RESOURCES.movimentacoes, { page: 1, pageSize: 1000, filter: { empresa_id: empresaA, venda_id: vendaId, tipo: 'saida' } });
  assert.equal(saidas.rows.length, 2, 'duas movimentações de saída (uma por item)');

  // 3) FINANCEIRO: título da venda criado no livro único.
  const titulo = (await s.list(RESOURCES.lancamentos_financeiros, { page: 1, pageSize: 100, filter: { empresa_id: empresaA, referencia_tipo: 'venda', referencia_id: vendaId } })).rows;
  assert.equal(titulo.length, 1, 'um título de venda');
  assert.equal(Number(titulo[0].valor), 200, 'valor do título = total da venda');

  // 4) BALANCETE: classifica o título e lê o MESMO livro (sem segundo livro).
  const contaReceita = await createRecord(RESOURCES.plano_contas, { codigo: `4.9.${SUF}`, nome: 'Receita 9.6', natureza: 'receita', tipo: 'analitica' }, adminA);
  await updateRecord(RESOURCES.lancamentos_financeiros, Number(titulo[0].id), {
    conta_contabil_id: Number(contaReceita.id), natureza_lancamento: 'credito', competencia: DATA, documento_origem_recurso: 'vendas', documento_origem_id: vendaId,
  }, adminA);
  const out = await chamar(balanceteFinanceiro, reqDe({}, { query: { de: HOJE, ate: HOJE }, user: gerenteA }));
  const linha = out.contas.find((c: any) => c.conta_contabil_id === Number(contaReceita.id));
  assert.ok(linha, 'a conta aparece no balancete');
  assert.equal(linha.creditos, 200, 'o crédito da venda é somado');
  assert.ok(out.por_origem.some((o: any) => o.recurso === 'vendas'), 'a origem "vendas" é rastreada');

  // 5) ISOLAMENTO da cadeia: a empresa B não vê nada do que A produziu.
  const titulosB = await s.list(RESOURCES.lancamentos_financeiros, { page: 1, pageSize: 100, filter: { empresa_id: empresaB, referencia_tipo: 'venda', referencia_id: vendaId } });
  assert.equal(titulosB.rows.length, 0, 'B não alcança o título de A pelo id da venda');
  assert.equal(await statusDeErro(() => getRecord(RESOURCES.vendas, vendaId, gerenteB)), 404);
});
