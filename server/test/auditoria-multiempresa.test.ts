// ============================================================================
// AUDITORIA MULTIEMPRESA — Etapa 2.1, Parte 3.
//
// Toda entrada de auditoria carrega a empresa do fato, resolvida NO MOMENTO
// DO EVENTO (nunca inferida depois), e o feed (/api/auditoria → listRecords
// com o escopo do ator) respeita empresa ativa + permissão, com consolidação
// só quando explicitamente autorizada (política existente).
//
//   A — evento criado pela empresa A aparece para A;
//   B — evento da empresa B NÃO aparece para A (e vice-versa);
//   C — sem permissão para B não se consulta B (injeção, id direto, perfil);
//   D — consolidação somente quando explicitamente autorizada.
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
delete process.env.DATABASE_URL;

const { RESOURCES } = await import('../src/resources');
const { checkAccess, createRecord, deleteRecord, getRecord, getStore, listRecords, updateRecord } = await import('../src/services');

type Ator = {
  id: number;
  name: string;
  perfil: 'admin' | 'gerente' | 'operador';
  empresa_id: number;
  empresas: number[];
  pode_consolidar?: boolean;
  consolidar?: boolean;
};

// O feed de auditoria é adminOnly: os leitores do teste são administradores
// de cada empresa (é o perfil que consulta a trilha).
const EMPRESA_A = 1;
let EMPRESA_B = 0;

const anaAdminA: Ator = { id: 201, name: 'Ana (admin A)', perfil: 'admin', empresa_id: EMPRESA_A, empresas: [EMPRESA_A] };
let brunoAdminB: Ator;
let auditorSemConsolidar: Ator;
let auditorConsolidado: Ator;
let intrusoComFlag: Ator;

async function prepararEmpresas() {
  if (EMPRESA_B) return;
  const b = await createRecord(RESOURCES.empresas, { nome: 'AUDITORIA FILIAL B' }, anaAdminA);
  EMPRESA_B = Number(b.id);
  brunoAdminB = { id: 202, name: 'Bruno (admin B)', perfil: 'admin', empresa_id: EMPRESA_B, empresas: [EMPRESA_B] };
  auditorSemConsolidar = { id: 203, name: 'Auditor', perfil: 'admin', empresa_id: EMPRESA_A, empresas: [EMPRESA_A, EMPRESA_B], pode_consolidar: true };
  auditorConsolidado = { ...auditorSemConsolidar, consolidar: true };
  intrusoComFlag = { id: 204, name: 'Intruso', perfil: 'admin', empresa_id: EMPRESA_A, empresas: [EMPRESA_A], consolidar: true };
}

/** Lê a trilha SEM recorte (o que foi gravado de verdade). */
async function trilhaCrua() {
  return getStore().list(RESOURCES.auditoria, { page: 1, pageSize: 5000, sort: 'id', dir: 'asc' });
}

async function feedDe(ator: Ator, filter?: Record<string, unknown>) {
  return listRecords(RESOURCES.auditoria, { page: 1, pageSize: 5000, sort: 'id', dir: 'asc', filter }, ator as any);
}

// ---------------------------------------------------------------------------
// A — evento criado pela empresa A aparece para A (carimbado no evento)
// ---------------------------------------------------------------------------

test('A: CRUD pela empresa A grava o evento com empresa_id=A e o feed de A mostra', async () => {
  await prepararEmpresas();
  const antes = (await trilhaCrua()).total;

  const cliente = await createRecord(RESOURCES.clientes, { nome: 'Cliente Auditoria A' }, anaAdminA);
  await updateRecord(RESOURCES.clientes, Number(cliente.id), { nome: 'Cliente Auditoria A (editado)' }, anaAdminA);

  const depois = await trilhaCrua();
  assert.equal(depois.total - antes, 2, 'criar + editar geram 2 eventos');
  const novos = depois.rows.slice(antes);
  assert.ok(novos.every((e) => Number(e.empresa_id) === EMPRESA_A), 'os eventos nascem carimbados com a empresa do fato');
  assert.ok(novos.every((e) => e.empresa_id__label), 'o feed resolve o nome da empresa (ref)');

  const feed = await feedDe(anaAdminA);
  const ids = new Set(feed.rows.map((e) => Number(e.id)));
  assert.ok(novos.every((e) => ids.has(Number(e.id))), 'o feed da empresa A mostra os eventos da A');
});

test('A: update/delete pela empresa B carimbam B (linha ANTES da operação)', async () => {
  await prepararEmpresas();
  const cliente = await createRecord(RESOURCES.clientes, { nome: 'Cliente Auditoria B' }, brunoAdminB);
  await updateRecord(RESOURCES.clientes, Number(cliente.id), { nome: 'Cliente Auditoria B (editado)' }, brunoAdminB);
  await deleteRecord(RESOURCES.clientes, Number(cliente.id), brunoAdminB);

  const trilha = await trilhaCrua();
  const eventos = trilha.rows.filter((e) => Number(e.registro_id) === Number(cliente.id) && e.recurso === 'clientes');
  assert.equal(eventos.length, 3, 'criar + editar + excluir');
  assert.ok(eventos.every((e) => Number(e.empresa_id) === EMPRESA_B), 'update/delete usam a empresa do registro');

  const feedB = await feedDe(brunoAdminB);
  const idsB = new Set(feedB.rows.map((e) => Number(e.id)));
  assert.ok(eventos.every((e) => idsB.has(Number(e.id))), 'o feed da empresa B mostra os eventos da B');
});

// ---------------------------------------------------------------------------
// B — isolamento do feed
// ---------------------------------------------------------------------------

test('B: evento da empresa B NÃO aparece para A (e vice-versa)', async () => {
  await prepararEmpresas();
  const feedA = await feedDe(anaAdminA);
  const feedB = await feedDe(brunoAdminB);

  assert.ok(feedA.total > 0 && feedB.total > 0, 'sanidade: ambas têm eventos');
  assert.ok(feedA.rows.every((e) => Number(e.empresa_id) === EMPRESA_A), 'toda linha do feed de A é da empresa A');
  assert.ok(feedB.rows.every((e) => Number(e.empresa_id) === EMPRESA_B), 'toda linha do feed de B é da empresa B');

  const nomesA = feedA.rows.map((e) => String(e.descricao));
  const nomesB = feedB.rows.map((e) => String(e.descricao));
  assert.ok(!nomesA.some((d) => d.includes('Auditoria B')), 'A enxergou um evento da B');
  assert.ok(!nomesB.some((d) => d.includes('Auditoria A')), 'B enxergou um evento da A');
});

// ---------------------------------------------------------------------------
// C — sem permissão para B não se consulta B
// ---------------------------------------------------------------------------

test('C: injetar f.empresa_id=B na consulta NÃO fura o feed de A', async () => {
  await prepararEmpresas();
  const tentativa = await feedDe(anaAdminA, { empresa_id: EMPRESA_B });
  assert.ok(tentativa.total > 0, 'sanidade: A tem eventos');
  assert.ok(
    tentativa.rows.every((e) => Number(e.empresa_id) === EMPRESA_A),
    'o filtro do cliente sobrescreveu o recorte do servidor'
  );
});

test('C: leitura direta por id de um evento de B responde 404 para A (nunca 403)', async () => {
  await prepararEmpresas();
  const feedB = await feedDe(brunoAdminB);
  const eventoB = feedB.rows[0];
  assert.ok(eventoB, 'sanidade: B tem ao menos um evento');

  // 404 de propósito: um 403 confirmaria que o id existe na outra empresa.
  await assert.rejects(() => getRecord(RESOURCES.auditoria, Number(eventoB.id), anaAdminA as any), (e: any) => {
    assert.equal(e.status, 404);
    return true;
  });
  // E o dono continua lendo normalmente.
  const lido = await getRecord(RESOURCES.auditoria, Number(eventoB.id), brunoAdminB as any);
  assert.equal(Number(lido.id), Number(eventoB.id));
});

test('C: perfil sem alçada (operador/gerente) não consulta a auditoria — 403', async () => {
  const operador = { id: 205, name: 'Operador', perfil: 'operador', empresa_id: EMPRESA_A } as any;
  const gerente = { id: 206, name: 'Gerente', perfil: 'gerente', empresa_id: EMPRESA_A } as any;
  assert.throws(() => checkAccess(RESOURCES.auditoria, operador, 'read'), (e: any) => e.status === 403);
  assert.throws(() => checkAccess(RESOURCES.auditoria, gerente, 'read'), (e: any) => e.status === 403);
  assert.doesNotThrow(() => checkAccess(RESOURCES.auditoria, anaAdminA as any, 'read'));
});

// ---------------------------------------------------------------------------
// D — consolidação somente quando explicitamente autorizada
// ---------------------------------------------------------------------------

test('D: auditor consolidado vê A+B; sem a flag (ou sem o privilégio) vê só a ativa', async () => {
  await prepararEmpresas();
  const consolidado = await feedDe(auditorConsolidado);
  const empresasVistas = new Set(consolidado.rows.map((e) => Number(e.empresa_id)));
  assert.ok(empresasVistas.has(EMPRESA_A) && empresasVistas.has(EMPRESA_B), 'consolidação autorizada mostra as duas empresas');

  const semFlag = await feedDe(auditorSemConsolidar);
  assert.ok(semFlag.rows.every((e) => Number(e.empresa_id) === EMPRESA_A), 'pode_consolidar sem pedido explícito NÃO consolida');

  const intruso = await feedDe(intrusoComFlag);
  assert.ok(intruso.rows.every((e) => Number(e.empresa_id) === EMPRESA_A), 'flag consolidar sem privilégio NÃO consolida');
});

// ---------------------------------------------------------------------------
// Rede de segurança dos stores
// ---------------------------------------------------------------------------

test('stores nunca gravam evento sem empresa (fallback para a padrão)', async () => {
  const s = getStore();
  const antes = (await trilhaCrua()).total;
  await s.audit({ usuario_id: null, usuario: 'legado', acao: 'seguranca', recurso: null, registro_id: null, descricao: 'chamada direta sem empresa' } as any);
  const depois = await trilhaCrua();
  assert.equal(depois.total - antes, 1);
  assert.equal(Number(depois.rows[depois.rows.length - 1].empresa_id), 1);
});
