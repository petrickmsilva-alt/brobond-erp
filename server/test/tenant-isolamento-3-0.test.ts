// ============================================================================
// TENANT ISOLATION — RECURSOS DA EVOLUÇÃO 3.0
//
// Prova, de verdade (não por regex), que os recursos novos das migrations
// 0052..0056 são isolados por EMPRESA em todas as operações do CRUD genérico:
//
//   estoque_transferencias, estoque_transferencia_itens, estoque_transferencia_eventos,
//   estoque_reservas, fornecedor_documentos, fornecedor_homologacao_eventos,
//   producao_recursos, fiscal_obrigacoes, fiscal_obrigacao_entregas, plano_contas
//
// Para cada um: o registro criado na empresa A
//   • NÃO aparece na listagem de B;
//   • NÃO pode ser lido por id em B (404);
//   • NÃO pode ser alterado nem excluído por B (404);
//   • nasce carimbado com o empresa_id do ATOR (nunca com o enviado no corpo).
//
// E a regra de tenancy do produto: Empresa = tenant, Usuário = identidade.
// Nenhum `usuario_id`/`responsavel` é usado como recorte de empresa.
// ============================================================================
import { test, before } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
delete process.env.DATABASE_URL;

const { RESOURCES } = await import('../src/resources');
const { createRecord, listRecords, getRecord, updateRecord, deleteRecord, getStore } = await import('../src/services');
const { escopoDeSistema } = await import('../src/empresa');
const { criarAtor, garantirAdmin } = await import('./_p1util');

await garantirAdmin();
const admin = { id: 1, name: 'Admin', perfil: 'admin' as const };
const empresaA = escopoDeSistema(1);
const empresaB = escopoDeSistema(2);

let atorA: any;
let atorB: any;

/** Contexto mínimo compartilhado (produto/fornecedor/usuário) nas duas empresas. */
let produtoA: number;
let produtoB: number;
let fornecedorA: number;
let fornecedorB: number;
let usuarioA: number;
let usuarioB: number;
let localA: number;
let localA2: number;

const erro = async (fn: () => Promise<unknown>): Promise<number> => {
  try {
    await fn();
  } catch (e: any) {
    return Number(e.status ?? e.statusCode ?? 0);
  }
  return 0;
};

before(async () => {
  getStore();
  atorA = await criarAtor(1, 'gerente');
  atorB = await criarAtor(2, 'gerente');
  usuarioA = Number(atorA.id);
  usuarioB = Number(atorB.id);

  const pa = await createRecord(RESOURCES.produtos, { sku: `TEN-A-${Date.now() % 100000}`, nome: 'Produto A', custo: 1, preco_venda: 2 }, admin);
  produtoA = Number(pa.id);
  const pb = await createRecord(RESOURCES.produtos, { sku: `TEN-B-${Date.now() % 100000}`, nome: 'Produto B', custo: 1, preco_venda: 2 }, { ...admin, empresa_id: 2, empresas: [2] });
  produtoB = Number(pb.id);

  const fa = await createRecord(RESOURCES.fornecedores, { nome: `Forn A ${Date.now() % 100000}`, pessoa: 'pj', indicador_ie: '1' }, admin);
  fornecedorA = Number(fa.id);
  const fb = await createRecord(RESOURCES.fornecedores, { nome: `Forn B ${Date.now() % 100000}`, pessoa: 'pj', indicador_ie: '1' }, { ...admin, empresa_id: 2, empresas: [2] });
  fornecedorB = Number(fb.id);

  const la = await createRecord(RESOURCES.locais, { nome: `local-a-${Date.now() % 100000}`, tipo: 'loja' }, admin);
  localA = Number(la.id);
  const la2 = await createRecord(RESOURCES.locais, { nome: `local-a2-${Date.now() % 100000}`, tipo: 'expedicao' }, admin);
  localA2 = Number(la2.id);
});

/**
 * Exercita o contrato completo de isolamento para um recurso.
 * `dados` é o payload válido NA EMPRESA A.
 */
async function isolar(recurso: keyof typeof RESOURCES, dados: Record<string, unknown>, opts: { update?: Record<string, unknown> } = {}) {
  const r = RESOURCES[recurso]!;
  const criado = await createRecord(r, dados, atorA);
  assert.ok(criado.id, `${r.key}: criado`);
  assert.equal(Number(criado.empresa_id), empresaA.empresaId, `${r.key}: nasce na empresa do ator`);

  // Listagem de B: nunca traz linha de A.
  const listaB = await listRecords(r, { page: 1, pageSize: 500 }, atorB);
  assert.equal(listaB.rows.some((x: any) => Number(x.id) === Number(criado.id)), false, `${r.key}: não aparece na listagem de B`);

  // Leitura / escrita / exclusão por id em B: 404 (não vaza existência).
  assert.equal(await erro(() => getRecord(r, Number(criado.id), atorB)), 404, `${r.key}: leitura de B por id é 404`);
  assert.equal(await erro(() => updateRecord(r, Number(criado.id), opts.update ?? {}, atorB)), 404, `${r.key}: escrita de B por id é 404`);
  assert.equal(await erro(() => deleteRecord(r, Number(criado.id), atorB)), 404, `${r.key}: exclusão de B por id é 404`);

  // A continua enxergando (o isolamento não quebrou o dono).
  const listaA = await listRecords(r, { page: 1, pageSize: 500 }, atorA);
  assert.equal(listaA.rows.some((x: any) => Number(x.id) === Number(criado.id)), true, `${r.key}: A enxerga o próprio registro`);
  return criado;
}

test('estoque_transferencias: documento de A não existe para B', async () => {
  await isolar('estoque_transferencias', {
    origem_local_id: localA,
    destino_local_id: localA2,
    status: 'solicitada',
    solicitante_id: usuarioA,
  });
});

test('estoque_transferencia_itens: item de A não existe para B', async () => {
  const doc = await createRecord(RESOURCES.estoque_transferencias, { origem_local_id: localA, destino_local_id: localA2, status: 'solicitada' }, atorA);
  await isolar('estoque_transferencia_itens', {
    transferencia_id: Number(doc.id),
    produto_id: produtoA,
    quantidade: 3,
  });
});

test('estoque_transferencia_eventos: evento de A não existe para B', async () => {
  const doc = await createRecord(RESOURCES.estoque_transferencias, { origem_local_id: localA, destino_local_id: localA2, status: 'solicitada' }, atorA);
  await isolar('estoque_transferencia_eventos', {
    transferencia_id: Number(doc.id),
    status_anterior: 'solicitada',
    status_novo: 'aprovada',
    usuario_id: usuarioA,
  });
});

test('estoque_reservas: reserva de A não existe para B', async () => {
  await isolar('estoque_reservas', {
    produto_id: produtoA,
    local_id: localA,
    tipo: 'reserva',
    quantidade: 2,
    status: 'ativa',
    criado_por: usuarioA,
  });
});

test('fornecedor_documentos: documento de A não existe para B', async () => {
  await isolar('fornecedor_documentos', {
    fornecedor_id: fornecedorA,
    tipo: 'cartao_cnpj',
    numero: 'DOC-A',
    validade: '2099-12-31',
    situacao: 'aprovado',
  });
});

test('fornecedor_homologacao_eventos: trilha de A não existe para B', async () => {
  await isolar('fornecedor_homologacao_eventos', {
    fornecedor_id: fornecedorA,
    status_anterior: 'pendente',
    status_novo: 'em_analise',
    usuario_id: usuarioA,
  });
});

test('producao_recursos: recurso de A não existe para B', async () => {
  await isolar('producao_recursos', {
    nome: `Costura A ${Date.now() % 100000}`,
    tipo: 'costura',
    capacidade_diaria: 10,
    eficiencia_pct: 100,
  });
});

test('fiscal_obrigacoes: obrigação de A não existe para B', async () => {
  await isolar('fiscal_obrigacoes', {
    codigo: `SPED_A_${Date.now() % 100000}`,
    nome: 'SPED Fiscal A',
    tipo: 'sped_fiscal',
    periodicidade: 'mensal',
    dia_vencimento: 15,
  });
});

test('fiscal_obrigacao_entregas: entrega de A não existe para B', async () => {
  const ob = await createRecord(RESOURCES.fiscal_obrigacoes, { codigo: `SPED_E_${Date.now() % 100000}`, nome: 'SPED E', tipo: 'sped_fiscal', periodicidade: 'mensal', dia_vencimento: 15 }, atorA);
  await isolar('fiscal_obrigacao_entregas', {
    obrigacao_id: Number(ob.id),
    competencia: '2026-01',
    status: 'entregue',
    protocolo: 'P-A',
    entregue_em: '2026-02-10T10:00:00.000Z',
  });
});

test('plano_contas: conta de A não existe para B', async () => {
  await isolar('plano_contas', {
    codigo: `1.1.${String(Date.now() % 900 + 100)}`,
    nome: 'Caixa A',
    natureza: 'ativo',
    tipo: 'analitica',
  }, { update: { nome: 'Caixa A (alterado por B)' } });
});

test('dados da empresa B não são visíveis para A (o isolamento é simétrico)', async () => {
  const reservaB = await createRecord(
    RESOURCES.estoque_reservas,
    { produto_id: produtoB, tipo: 'bloqueio', quantidade: 1, status: 'ativa' },
    atorB
  );
  assert.equal(Number(reservaB.empresa_id), empresaB.empresaId);
  const listaA = await listRecords(RESOURCES.estoque_reservas, { page: 1, pageSize: 500 }, atorA);
  assert.equal(listaA.rows.some((x: any) => Number(x.id) === Number(reservaB.id)), false);
  assert.equal(await erro(() => getRecord(RESOURCES.estoque_reservas, Number(reservaB.id), atorA)), 404);

  // Fornecedor de B também não recebe documento de A nem aparece em A.
  const docsB = await listRecords(RESOURCES.fornecedor_documentos, { page: 1, pageSize: 500 }, atorA);
  assert.equal(docsB.rows.some((x: any) => Number(x.fornecedor_id) === fornecedorB), false);
});

test('empresa_id enviado no corpo NÃO sobrepõe a empresa do ator', async () => {
  // Tentativa de "furar" o tenant pelo payload: o servidor carimba a empresa
  // do ator e ignora a do corpo.
  const criado = await createRecord(
    RESOURCES.plano_contas,
    { codigo: `9.9.${String(Date.now() % 900 + 100)}`, nome: 'Tentativa cross-tenant', natureza: 'despesa', tipo: 'analitica', empresa_id: 2 },
    atorA
  );
  assert.equal(Number(criado.empresa_id), 1, 'a empresa do ator vence o empresa_id do corpo');
});
