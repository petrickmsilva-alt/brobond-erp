// ============================================================================
// FISCAL — tributação, segredos, provedores e a regra que não se negocia:
//
//   O SISTEMA NUNCA DIZ QUE EMITIU UMA NOTA QUE NÃO EXISTE.
//
// Cobertura:
//   1) resolução determinística de tributação (ordem de especificidade);
//   2) pendências explícitas em vez de alíquota inventada;
//   3) cifra dos segredos de provedor (AES-256-GCM, chave própria);
//   4) provedor nulo — jamais autoriza;
//   5) emissão sem configuração: 409, nada de nota, NADA de baixa de estoque;
//   6) provedor que mente ("autorizado" sem chave/protocolo) é recusado;
//   7) emissão autorizada de verdade: venda faturada, estoque baixado,
//      financeiro lançado, carimbos de efeito colateral aplicados UMA vez;
//   8) idempotência: duas chamadas com a mesma chave = um documento;
//   9) numeração não retrocede.
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
process.env.SEGREDOS_ENCRYPTION_KEY = 'chave-de-teste-fiscal';

const { RESOURCES } = await import('../src/resources');
const { getStore, createRecord } = await import('../src/services');
const {
  resolverTributacao,
  pendenciasFiscais,
  ordenarPorEspecificidade,
  regraAplicavel,
  impostoCentavos,
  ncmDigitos,
} = await import('../src/fiscalRegras');
const { cifrarSegredo, decifrarSegredo, mascararSegredo, pareceCifrado } = await import('../src/segredos');
const { provedorNulo, obterFiscalProvider, registrarFiscalProvider, centsParaDecimal, semSegredos } = await import(
  '../src/fiscalProvider'
);
const { montarDocumentoDaVenda } = await import('../src/fiscal');

const CTX = {
  empresaId: 1,
  modelo: '55' as const,
  operacao: 'saida' as const,
  ufDestino: 'RJ',
  ufEmitente: 'SP',
  consumidorFinal: false,
  regime: '3',
};
const PADRAO = { cfop_dentro: '5102', cfop_fora: '6102' };

// ---------------------------------------------------------------------------
// 1) Resolução de tributação
// ---------------------------------------------------------------------------

test('regra mais específica vence: prioridade, depois NCM mais longo, depois UF', () => {
  const geral = { id: 1, empresa_id: 1, operacao: 'saida', ncm: '', uf_destino: null, prioridade: 0, cfop: '6101', ativo: true };
  const porNcm = { id: 2, empresa_id: 1, operacao: 'saida', ncm: '6109', uf_destino: null, prioridade: 0, cfop: '6102', ativo: true };
  const porUf = { id: 3, empresa_id: 1, operacao: 'saida', ncm: '6109', uf_destino: 'RJ', prioridade: 0, cfop: '6103', ativo: true };
  const forcada = { id: 4, empresa_id: 1, operacao: 'saida', ncm: '', uf_destino: null, prioridade: 99, cfop: '6999', ativo: true };

  const ordem = ordenarPorEspecificidade([geral, porNcm, porUf]).map((r) => r.id);
  assert.deepEqual(ordem, [3, 2, 1], 'UF específica > NCM longo > curinga');

  const produto = { ncm: '6109.10.00' };
  assert.equal(resolverTributacao(produto, CTX, [geral, porNcm, porUf], PADRAO).cfop, '6103');
  // Prioridade passa por cima de qualquer especificidade.
  assert.equal(resolverTributacao(produto, CTX, [geral, porNcm, porUf, forcada], PADRAO).cfop, '6999');
});

test('o CFOP do produto vence a regra, e o padrão da empresa é o último recurso', () => {
  const regra = { id: 1, empresa_id: 1, operacao: 'saida', ncm: '6109', prioridade: 0, cfop: '6102', ativo: true };
  const comCfop = resolverTributacao({ ncm: '61091000', cfop_saida: '5405' }, CTX, [regra], PADRAO);
  assert.equal(comCfop.cfop, '5405');
  assert.deepEqual(comCfop.origem_regra.produto, ['cfop']);

  // Sem produto e sem regra: cai no padrão — e o padrão depende só de a
  // operação ser interna ou interestadual, o que nunca é um chute.
  const interestadual = resolverTributacao({ ncm: '61091000' }, CTX, [], PADRAO);
  assert.equal(interestadual.cfop, '6102');
  const interna = resolverTributacao({ ncm: '61091000' }, { ...CTX, ufDestino: 'SP' }, [], PADRAO);
  assert.equal(interna.cfop, '5102');
});

test('vigência e filtros de contexto são respeitados', () => {
  const base = { id: 1, empresa_id: 1, operacao: 'saida', ncm: '6109', prioridade: 0, cfop: '6102', ativo: true };
  const hoje = '2026-03-15';
  assert.equal(regraAplicavel(base, CTX, '61091000', hoje), true);
  assert.equal(regraAplicavel({ ...base, ativo: false }, CTX, '61091000', hoje), false);
  assert.equal(regraAplicavel({ ...base, empresa_id: 2 }, CTX, '61091000', hoje), false, 'regra de outra empresa não aplica');
  assert.equal(regraAplicavel({ ...base, ncm: '7318' }, CTX, '61091000', hoje), false);
  assert.equal(regraAplicavel({ ...base, uf_destino: 'MG' }, CTX, '61091000', hoje), false);
  assert.equal(regraAplicavel({ ...base, modelo: '65' }, CTX, '61091000', hoje), false);
  assert.equal(regraAplicavel({ ...base, consumidor_final: true }, CTX, '61091000', hoje), false);
  assert.equal(regraAplicavel({ ...base, vigencia_inicio: '2026-04-01' }, CTX, '61091000', hoje), false, 'ainda não vigente');
  assert.equal(regraAplicavel({ ...base, vigencia_fim: '2026-01-31' }, CTX, '61091000', hoje), false, 'já expirada');
});

test('Simples Nacional usa CSOSN; regime normal usa CST de ICMS', () => {
  const regra = { id: 1, empresa_id: 1, operacao: 'saida', ncm: '', prioridade: 0, icms_cst: '00', csosn: '102', ativo: true };
  const normal = resolverTributacao({ ncm: '61091000' }, CTX, [regra], PADRAO);
  assert.equal(normal.icms_cst, '00');
  assert.equal(normal.csosn, null);

  const simples = resolverTributacao({ ncm: '61091000' }, { ...CTX, regime: '1' }, [regra], PADRAO);
  assert.equal(simples.csosn, '102');
  assert.equal(simples.icms_cst, null);
});

test('o que falta vira pendência explícita — nunca uma alíquota inventada', () => {
  const semNada = resolverTributacao({}, CTX, [], PADRAO);
  assert.equal(semNada.icms_aliquota, null, 'não existe alíquota padrão chutada');
  const faltas = pendenciasFiscais(semNada, CTX);
  assert.ok(faltas.includes('NCM do produto'));
  assert.ok(faltas.includes('CST do ICMS'));
  assert.ok(faltas.includes('CST do PIS'));

  const completo = resolverTributacao(
    { ncm: '6109.10.00', cfop_saida: '5102', icms_cst: '00', icms_aliquota: 18, pis_cst: '01', pis_aliquota: 1.65, cofins_cst: '01', cofins_aliquota: 7.6 },
    CTX,
    [],
    PADRAO
  );
  assert.deepEqual(pendenciasFiscais(completo, CTX), []);
});

test('imposto em centavos e normalização de NCM', () => {
  assert.equal(ncmDigitos('6109.10.00'), '61091000');
  assert.equal(impostoCentavos(10_000, 18), 1800);
  assert.equal(impostoCentavos(10_000, null), 0, 'sem alíquota, imposto zero — não um chute');
  assert.equal(impostoCentavos(3333, 1.65), 55);
  assert.equal(centsParaDecimal(123456), '1234.56');
});

// ---------------------------------------------------------------------------
// 2) Segredos
// ---------------------------------------------------------------------------

test('token de provedor nunca fica em texto puro e volta mascarado', () => {
  const token = 'focus-token-super-secreto-123';
  const cifrado = cifrarSegredo(token)!;
  assert.ok(!cifrado.includes(token), 'o texto puro não aparece no valor gravado');
  assert.ok(pareceCifrado(cifrado));
  assert.equal(decifrarSegredo(cifrado), token);
  assert.equal(decifrarSegredo('v1.lixo.lixo.lixo'), null, 'payload corrompido não derruba a requisição');
  assert.equal(decifrarSegredo(null), null);
  assert.equal(cifrarSegredo(''), null);

  const mascara = mascararSegredo(token)!;
  assert.ok(mascara.endsWith('-123'));
  assert.ok(!mascara.includes('secreto'));
});

test('o eco do provedor é gravado sem credenciais', () => {
  const limpo = semSegredos({ status: 'autorizado', token: 'abc', dados: { certificado_senha: 'x', chave: '123' } })!;
  assert.equal(limpo.token, undefined);
  assert.equal((limpo.dados as any).certificado_senha, undefined);
  assert.equal((limpo.dados as any).chave, '123');
});

// ---------------------------------------------------------------------------
// 3) Provedor nulo
// ---------------------------------------------------------------------------

test('sem provedor configurado o estado é "nao_configurado" em TODAS as operações', async () => {
  const cred = { provider: 'nenhum', token: null, base_url: null, ambiente: 'homologacao' as const, cnpj: '' };
  const vazio = {} as any;
  for (const r of [
    await provedorNulo.emitir(vazio, cred),
    await provedorNulo.consultar('x', cred),
    await provedorNulo.cancelar('x', 'justificativa suficiente', cred),
    await provedorNulo.inutilizar({ serie: 1, numero_inicial: 1, numero_final: 2, justificativa: 'x'.repeat(20), modelo: '55' }, cred),
  ]) {
    assert.equal(r.status, 'nao_configurado');
    assert.match(r.mensagem, /NÃO EMITIDO|não está ligado|NÃO configurada/i);
    assert.equal(r.chave_acesso ?? null, null);
  }
  assert.equal(obterFiscalProvider('inexistente').nome, 'nenhum', 'provedor desconhecido cai no nulo, nunca em emissão');
  assert.equal(obterFiscalProvider('focus').nome, 'focus');
  assert.equal(obterFiscalProvider(null).configurado({ ...cred }), false);
});

test('Focus e PlugNotas sem token não emitem', async () => {
  const cred = { provider: 'focus', token: null, base_url: null, ambiente: 'homologacao' as const, cnpj: '123' };
  for (const nome of ['focus', 'plugnotas']) {
    const p = obterFiscalProvider(nome);
    assert.equal(p.configurado(cred), false);
    const r = await p.emitir({} as any, cred);
    assert.equal(r.status, 'nao_configurado', `${nome} não pode emitir sem credencial`);
  }
});

// ---------------------------------------------------------------------------
// 4) Fluxo de emissão sobre o banco em memória
// ---------------------------------------------------------------------------

const ADMIN = { id: 1, name: 'Admin', perfil: 'admin' as const, empresa_id: 1, empresas: [1] };

/** Mesmo local usado na baixa de estoque do faturamento. */
const LOCAL = 'loja';

type Cenario = { vendaId: number; produtoId: number; tamanhoId: number; clienteId: number };

async function montarCenario(nome: string): Promise<Cenario> {
  const s = getStore();
  await s.update(RESOURCES.empresas, 1, {
    razao_social: 'BROBOND CONFECCOES LTDA',
    cnpj: '11222333000181',
    ie: '1234567890',
    crt: '3',
    cep: '01001000',
    logradouro: 'Praça da Sé',
    numero: '1',
    bairro: 'Sé',
    cidade: 'São Paulo',
    codigo_municipio: '3550308',
    uf: 'SP',
  });

  const cliente = await createRecord(
    RESOURCES.clientes,
    {
      nome: `Cliente ${nome}`,
      pessoa: 'pj',
      cnpj_cpf: '19131243000197',
      indicador_ie: '1',
      rg_ie: '111222333',
      cep: '20040002',
      logradouro: 'Av. Rio Branco',
      numero: '100',
      bairro: 'Centro',
      cidade: 'Rio de Janeiro',
      codigo_municipio: '3304557',
      uf: 'RJ',
    },
    ADMIN
  );

  const produto = await createRecord(
    RESOURCES.produtos,
    {
      sku: `FISCAL-${nome}`,
      nome: `Camiseta ${nome}`,
      ncm: '61091000',
      origem: '0',
      cfop_saida: '6102',
      icms_cst: '00',
      icms_aliquota: 12,
      pis_cst: '01',
      pis_aliquota: 1.65,
      cofins_cst: '01',
      cofins_aliquota: 7.6,
      preco_venda: 100,
      unidade: 'un',
    },
    ADMIN
  );

  const tamanho = (await s.list(RESOURCES.tamanhos, { page: 1, pageSize: 1 })).rows[0];
  await s.adjustStock(Number(produto.id), Number(tamanho.id), LOCAL, 50);

  const venda = await createRecord(
    RESOURCES.vendas,
    { cliente_id: Number(cliente.id), status: 'aberta', data: new Date().toISOString().slice(0, 10), local_saida: LOCAL },
    ADMIN
  );
  await createRecord(
    RESOURCES.itens_venda,
    { venda_id: Number(venda.id), produto_id: Number(produto.id), tamanho_id: Number(tamanho.id), quantidade: 2, preco_unitario: 100, subtotal: 200 },
    ADMIN
  );
  // O total do cabeçalho é recalculado pelo endpoint de itens; aqui os itens
  // entram pelo serviço, então o total é fixado explicitamente.
  await s.update(RESOURCES.vendas, Number(venda.id), { total: 200 });

  return { vendaId: Number(venda.id), produtoId: Number(produto.id), tamanhoId: Number(tamanho.id), clienteId: Number(cliente.id) };
}

async function saldo(c: Cenario): Promise<number> {
  const row = await getStore().findOneWhere(RESOURCES.estoques, {
    produto_id: c.produtoId,
    tamanho_id: c.tamanhoId,
    local: LOCAL,
  });
  return Number(row?.quantidade ?? 0);
}

test('montagem do documento: totais em centavos e tributação resolvida por item', async () => {
  const c = await montarCenario('MONTA');
  const { payload, pendencias } = await montarDocumentoDaVenda(c.vendaId, '55', 1, null, 'teste');

  assert.deepEqual(pendencias, [], `não deveria haver pendências: ${pendencias.join(', ')}`);
  assert.equal(payload.itens.length, 1);
  const item = payload.itens[0];
  assert.equal(item.valor_total_cents, 20_000, '2 × R$100,00 = 20000 centavos');
  assert.equal(item.cfop, '6102', 'SP → RJ usa o CFOP do produto');
  assert.equal(item.icms_valor_cents, 2400, '12% de 20000');
  assert.equal(item.pis_valor_cents, 330);
  assert.equal(item.cofins_valor_cents, 1520);
  assert.equal(payload.total_produtos_cents, 20_000);
  assert.equal(payload.emitente.cnpj, '11222333000181');
  assert.equal(payload.destinatario.indicador_ie, '1');
  assert.equal(payload.destinatario.endereco.codigo_municipio, '3304557');
});

test('produto sem NCM vira pendência explícita — e não vai para a SEFAZ', async () => {
  const c = await montarCenario('SEMNCM');
  await getStore().update(RESOURCES.produtos, c.produtoId, { ncm: null, cfop_saida: null, icms_cst: null, pis_cst: null, cofins_cst: null });
  const { pendencias } = await montarDocumentoDaVenda(c.vendaId, '55', 1, null, 'teste');
  assert.ok(pendencias.some((p) => p.startsWith('NCM do produto')), pendencias.join(' | '));
  assert.ok(pendencias.some((p) => p.startsWith('CST do ICMS')));
});

// --- A partir daqui, o fluxo HTTP completo ---------------------------------

const express = (await import('express')).default;
const request = (await import('supertest')).default;
const { emitirDocumento, situacaoFiscalVenda, salvarConfigFiscal, obterConfigFiscal } = await import('../src/fiscal');

function app() {
  const a = express();
  a.use(express.json());
  a.use((req, _res, next) => {
    (req as any).user = { ...ADMIN, pode_consolidar: false };
    next();
  });
  const wrap = (fn: any) => (req: any, res: any, next: any) => Promise.resolve(fn(req, res)).catch(next);
  a.post('/api/vendas/:id/fiscal/emitir', wrap(emitirDocumento));
  a.get('/api/vendas/:id/fiscal', wrap(situacaoFiscalVenda));
  a.get('/api/fiscal/config', wrap(obterConfigFiscal));
  a.put('/api/fiscal/config', wrap(salvarConfigFiscal));
  a.use((err: any, _req: any, res: any, _next: any) => {
    res.status(err.status || 500).json({ error: err.message });
  });
  return a;
}

test('sem configuração fiscal: 409, documento NÃO emitido e estoque intacto', async () => {
  const c = await montarCenario('SEMCFG');
  const antes = await saldo(c);

  const resp = await request(app()).post(`/api/vendas/${c.vendaId}/fiscal/emitir`).send({ modelo: '55' });

  assert.equal(resp.status, 409);
  assert.match(resp.body.error, /NÃO emitido/i);
  assert.equal(await saldo(c), antes, 'estoque NÃO pode ser baixado sem autorização');

  const venda = await getStore().get(RESOURCES.vendas, c.vendaId);
  assert.notEqual(String(venda!.status), 'faturada', 'a venda não pode ser faturada sem nota autorizada');
  assert.equal(venda!.nfe_chave ?? null, null);

  const situacao = await request(app()).get(`/api/vendas/${c.vendaId}/fiscal`);
  assert.equal(situacao.body.emitido, false);
  assert.equal(situacao.body.documento, null);
  assert.equal(situacao.body.documentos[0].status, 'pendente');
  assert.match(situacao.body.documentos[0].motivo, /não está habilitada|não configurad/i);
});

test('habilitar emissão sem token é recusado', async () => {
  const resp = await request(app()).put('/api/fiscal/config').send({ provider: 'focus', habilitado: true });
  assert.equal(resp.status, 409);
  assert.match(resp.body.error, /sem um provedor com token/i);
});

test('o token gravado volta mascarado pela API, nunca em claro', async () => {
  await request(app()).put('/api/fiscal/config').send({ provider: 'focus', provider_token: 'token-secreto-abc1' });
  const resp = await request(app()).get('/api/fiscal/config');
  assert.equal(resp.status, 200);
  assert.ok(String(resp.body.provider_token).endsWith('abc1'));
  assert.ok(!String(resp.body.provider_token).includes('token-secreto'));
  assert.equal(JSON.stringify(resp.body).includes('token-secreto-abc1'), false);

  const bruto = await getStore().findOneWhere(RESOURCES.empresa_fiscal_config, { empresa_id: 1 });
  assert.ok(!String(bruto!.provider_token_cifrado).includes('token-secreto'), 'o banco guarda o token CIFRADO');
});

test('a numeração fiscal não pode retroceder', async () => {
  await request(app()).put('/api/fiscal/config').send({ proximo_numero_nfe: 500 });
  const resp = await request(app()).put('/api/fiscal/config').send({ proximo_numero_nfe: 10 });
  assert.equal(resp.status, 409);
  assert.match(resp.body.error, /não pode retroceder/i);
  await request(app()).put('/api/fiscal/config').send({ proximo_numero_nfe: 501 });
});

/** Provedor de teste: devolve exatamente o que o cenário mandar. */
function provedorFalso(nome: string, resposta: any) {
  registrarFiscalProvider({
    nome,
    configurado: () => true,
    emitir: async () => resposta,
    consultar: async () => resposta,
    cancelar: async () => resposta,
    inutilizar: async () => resposta,
  } as any);
}

async function habilitar(nome: string) {
  const s = getStore();
  const cfg = await s.findOneWhere(RESOURCES.empresa_fiscal_config, { empresa_id: 1 });
  await s.update(RESOURCES.empresa_fiscal_config, Number(cfg!.id), {
    provider: nome,
    provider_token_cifrado: cifrarSegredo('token-de-teste'),
    habilitado: true,
    ambiente: 'homologacao',
  });
}

test('provedor que diz "autorizado" sem chave e protocolo NÃO autoriza nada', async () => {
  const c = await montarCenario('MENTIROSO');
  const antes = await saldo(c);
  provedorFalso('mentiroso', { status: 'autorizado', mensagem: 'tudo certo, confie em mim' });
  await habilitar('mentiroso');

  const resp = await request(app()).post(`/api/vendas/${c.vendaId}/fiscal/emitir`).send({ modelo: '55' });

  assert.equal(resp.body.emitido, false, 'sem prova não há autorização');
  assert.equal(resp.body.status, 'erro');
  assert.equal(resp.body.chave_acesso, null);
  assert.equal(await saldo(c), antes, 'estoque intacto');
  const venda = await getStore().get(RESOURCES.vendas, c.vendaId);
  assert.notEqual(String(venda!.status), 'faturada');
});

test('rejeição da SEFAZ: motivo registrado, estoque intacto, número devolvido à série', async () => {
  const c = await montarCenario('REJEITADO');
  const antes = await saldo(c);
  provedorFalso('rejeitador', { status: 'rejeitado', mensagem: 'Rejeicao: CFOP incompativel com a operacao' });
  await habilitar('rejeitador');

  const s = getStore();
  const antesCfg = await s.findOneWhere(RESOURCES.empresa_fiscal_config, { empresa_id: 1 });
  const proximoAntes = Number(antesCfg!.proximo_numero_nfe);

  const resp = await request(app()).post(`/api/vendas/${c.vendaId}/fiscal/emitir`).send({ modelo: '55' });

  assert.equal(resp.body.status, 'rejeitado');
  assert.equal(resp.body.emitido, false);
  assert.match(resp.body.motivo, /CFOP incompativel/);
  assert.equal(resp.body.numero, null, 'número rejeitado não fica preso ao documento');
  assert.equal(await saldo(c), antes, 'rejeição NÃO baixa estoque');

  const depoisCfg = await s.findOneWhere(RESOURCES.empresa_fiscal_config, { empresa_id: 1 });
  assert.equal(Number(depoisCfg!.proximo_numero_nfe), proximoAntes, 'o número volta para a série e pode ser reusado');
});

test('autorização real: venda faturada, estoque baixado, financeiro lançado — uma única vez', async () => {
  const c = await montarCenario('AUTORIZADO');
  const antes = await saldo(c);
  const chave = '35260111222333000181550010000001231234567890';
  provedorFalso('bomprovedor', {
    status: 'autorizado',
    mensagem: 'Autorizado o uso da NF-e',
    chave_acesso: chave,
    protocolo: '135260000123456',
    numero: 1,
    serie: 1,
    xml: '<nfeProc>...</nfeProc>',
    danfe_url: 'https://exemplo/danfe.pdf',
  });
  await habilitar('bomprovedor');

  const resp = await request(app())
    .post(`/api/vendas/${c.vendaId}/fiscal/emitir`)
    .set('idempotency-key', `teste-autorizado-${c.vendaId}`)
    .send({ modelo: '55' });

  assert.equal(resp.status, 200, JSON.stringify(resp.body));
  assert.equal(resp.body.emitido, true);
  assert.equal(resp.body.status, 'autorizado');
  assert.equal(resp.body.chave_acesso, chave);

  assert.equal(await saldo(c), antes - 2, 'estoque baixado na autorização');

  const venda = await getStore().get(RESOURCES.vendas, c.vendaId);
  assert.equal(String(venda!.status), 'faturada');
  assert.equal(venda!.nfe_chave, chave);
  assert.equal(String(venda!.nfe_status), 'emitida');
  assert.equal(Number(venda!.documento_fiscal_id), Number(resp.body.documento_id));

  const doc = await getStore().get(RESOURCES.documentos_fiscais, Number(resp.body.documento_id));
  assert.ok(doc!.estoque_baixado_em, 'carimbo de efeito aplicado');
  assert.ok(doc!.financeiro_lancado_em);

  // --- Idempotência: mesma chave, mesmo documento, sem segunda baixa --------
  const repetida = await request(app())
    .post(`/api/vendas/${c.vendaId}/fiscal/emitir`)
    .set('idempotency-key', `teste-autorizado-${c.vendaId}`)
    .send({ modelo: '55' });

  assert.equal(Number(repetida.body.documento_id), Number(resp.body.documento_id), 'o MESMO documento é devolvido');
  assert.equal(await saldo(c), antes - 2, 'a repetição não baixa estoque de novo');

  // --- Nova tentativa com outra chave bate no "já tem nota autorizada" ------
  const outra = await request(app())
    .post(`/api/vendas/${c.vendaId}/fiscal/emitir`)
    .set('idempotency-key', `outra-chave-${c.vendaId}`)
    .send({ modelo: '55' });
  assert.equal(outra.status, 409);
  assert.match(outra.body.error, /já tem NF-e autorizada/i);
});
