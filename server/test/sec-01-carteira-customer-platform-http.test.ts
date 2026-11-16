// ============================================================================
// SEC-01 — CARTEIRA DO REPRESENTANTE NO CUSTOMER PLATFORM (HTTP REAL).
//
// O achado (SEC-01): as telas de segmentação/RFM do Customer Platform
// (`/api/customer-segments/rfm`, `/api/customer-segments/:id/avaliar` e a irmã
// `/api/customer360/:id`) leem `clientes` e `vendas` filtrando APENAS por
// `empresa_id` — ignoram `escopo.carteira`. Com isso, um usuário REPRESENTANTE
// (perfil operador vinculado a um representante) enxerga a empresa inteira,
// furando o recorte que `listRecords` já aplica em `/api/clientes` (A06-14).
//
// Este arquivo passa pelo PIPELINE HTTP real (express + requireAuth com
// JWT/sessão/carteira relida do banco) e prova, com DUAS empresas e DOIS
// representantes, que o representante NÃO acessa cliente fora da sua carteira.
// ============================================================================
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import express, { type NextFunction, type Request, type Response } from 'express';
import request from 'supertest';

process.env.NODE_ENV = 'test';
delete process.env.DATABASE_URL;

const { RESOURCES } = await import('../src/resources');
const { getStore, listRecords, getRecord, createRecord, updateRecord, checkAccess } = await import('../src/services');
const { currentUser, requireAuth, signToken } = await import('../src/auth');
const { exportarDadosTitular } = await import('../src/lgpd');

const { abrirSessao } = await import('../src/sessoes');
const { invalidarCacheCarteira } = await import('../src/empresasAcesso');
const { avaliarSegmento, analiseRfm, customer360 } = await import('../src/service');

function wrap(fn: (req: Request, res: Response) => Promise<unknown>) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res).catch(next);
  };
}

const app = express();
app.use(express.json());
app.use('/api', requireAuth);
app.get('/api/clientes', wrap(async (req, res) => {
  const actor = currentUser(req);
  checkAccess(RESOURCES.clientes, actor, 'read');
  res.json(await listRecords(RESOURCES.clientes, { page: 1, pageSize: 100 }, actor as any));
}));
app.get('/api/clientes/:id', wrap(async (req, res) => {
  const actor = currentUser(req);
  checkAccess(RESOURCES.clientes, actor, 'read');
  res.json(await getRecord(RESOURCES.clientes, Number(req.params.id), actor as any));
}));
app.put('/api/clientes/:id', wrap(async (req, res) => {
  const actor = currentUser(req);
  checkAccess(RESOURCES.clientes, actor, 'update');
  res.json(await updateRecord(RESOURCES.clientes, Number(req.params.id), req.body, actor as any));
}));
app.post('/api/clientes', wrap(async (req, res) => {
  const actor = currentUser(req);
  checkAccess(RESOURCES.clientes, actor, 'create');
  res.status(201).json(await createRecord(RESOURCES.clientes, req.body, actor as any));
}));
app.post('/api/representante_cliente', wrap(async (req, res) => {
  const actor = currentUser(req);
  checkAccess(RESOURCES.representante_cliente, actor, 'create');
  res.status(201).json(await createRecord(RESOURCES.representante_cliente, req.body, actor as any));
}));
app.get('/api/clientes/:id/dados-lgpd', wrap(exportarDadosTitular as any));
app.get('/api/customer360/:id', wrap(customer360 as any));
app.get('/api/customer-segments/:id/avaliar', wrap(avaliarSegmento as any));
app.get('/api/customer-segments/rfm', wrap(analiseRfm as any));
app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  res.status(err?.status || 500).json({ error: err?.message || 'erro' });
});

const s = getStore();
let seq = 0;

let EMPRESA_A = 0;
let EMPRESA_B = 0;
// Carteiras (representantes) da empresa A.
let REP_A1 = 0; // dono do usuário "ana"
let REP_A2 = 0; // outro representante da MESMA empresa
// Carteira da empresa B.
let REP_B1 = 0;
// Clientes.
let CLI_A1 = 0; // carteira REP_A1
let CLI_A2 = 0; // carteira REP_A2
let CLI_A_SEM = 0; // sem representante na empresa A
let CLI_A_PAG = 0; // 500 vínculos expirados antes do vínculo vigente (regressão de paginação)
let CLI_A_FUT = 0; // vínculo futuro não concede acesso antecipado
let CLI_A_HIST = 0; // vínculo encerrado: leitura e histórico preservados
let CLI_A_CANCEL = 0; // vínculo cancelado nunca concede acesso
let CLI_A2_SEM_COMPRA = 0; // carteira REP_A2, sem compra (discrimina `sem_compra` do RFM)
let CLI_B1 = 0; // empresa B
// Segmento da empresa A.
let SEG_A = 0;

async function usuario(perfil: 'admin' | 'gerente' | 'operador', empresaId: number, nome: string): Promise<number> {
  seq++;
  const row = await s.insert(RESOURCES.usuarios, {
    nome: `${nome} ${seq}`,
    email: `sec01-${seq}-${Date.now()}@brobond.test`,
    perfil,
    ativo: true,
    senha_hash: 'x',
  } as any);
  const id = Number(row.id);
  const tabela = (s as any).table('usuarios');
  Object.assign(tabela.rows.get(id), { empresa_id: empresaId, token_versao: 0 });
  return id;
}

async function tokenPara(usuarioId: number): Promise<string> {
  const row = await s.findOneWhere(RESOURCES.usuarios, { id: usuarioId });
  const sid = await abrirSessao({ usuarioId, lembrar: false, req: { headers: {}, socket: { remoteAddress: '127.0.0.1' } } as any });
  const user: any = { id: usuarioId, name: String(row!.nome), email: String(row!.email), perfil: String(row!.perfil), empresa_id: Number(row!.empresa_id) };
  return signToken(user, { ver: Number(row!.token_versao || 0), sid });
}

async function cliente(empresaId: number, nome: string, representanteId?: number): Promise<number> {
  seq++;
  const c = await s.insert(RESOURCES.clientes, {
    empresa_id: empresaId,
    nome: `${nome} ${seq}`,
    pessoa: 'pf',
    ativo: true,
    ...(representanteId ? { representante_id: representanteId } : {}),
  } as any);
  return Number(c.id);
}

async function venda(empresaId: number, clienteId: number, representanteId: number, total: number, data = new Date().toISOString()) {
  seq++;
  const hoje = data;
  const v = await s.insert(RESOURCES.vendas, {
    empresa_id: empresaId,
    cliente_id: clienteId,
    representante_id: representanteId,
    status: 'faturada',
    total,
    faturada_em: hoje,
    data: hoje,
  } as any);
  return Number(v.id);
}

before(async () => {
  EMPRESA_A = Number((await s.insert(RESOURCES.empresas, { nome: `SEC01 A ${Date.now()}` } as any)).id);
  EMPRESA_B = Number((await s.insert(RESOURCES.empresas, { nome: `SEC01 B ${Date.now()}` } as any)).id);

  REP_A1 = Number((await s.insert(RESOURCES.representantes, { empresa_id: EMPRESA_A, nome: 'Rep A1', ativo: true } as any)).id);
  REP_A2 = Number((await s.insert(RESOURCES.representantes, { empresa_id: EMPRESA_A, nome: 'Rep A2', ativo: true } as any)).id);
  REP_B1 = Number((await s.insert(RESOURCES.representantes, { empresa_id: EMPRESA_B, nome: 'Rep B1', ativo: true } as any)).id);

  CLI_A1 = await cliente(EMPRESA_A, 'Cliente carteira A1', REP_A1);
  CLI_A2 = await cliente(EMPRESA_A, 'Cliente carteira A2', REP_A2);
  // Campo legado aponta para A1, mas NÃO existe vínculo temporal: não pode autorizar.
  CLI_A_SEM = await cliente(EMPRESA_A, 'Cliente sem vínculo temporal', REP_A1);
  CLI_A_PAG = await cliente(EMPRESA_A, 'Cliente carteira paginada', REP_A1);
  CLI_A_FUT = await cliente(EMPRESA_A, 'Cliente vínculo futuro', REP_A1);
  CLI_A_HIST = await cliente(EMPRESA_A, 'Cliente carteira histórica', REP_A2);
  CLI_A_CANCEL = await cliente(EMPRESA_A, 'Cliente vínculo cancelado', REP_A1);
  // Sem compra, na carteira de OUTRO representante — discrimina o `sem_compra` do RFM.
  CLI_A2_SEM_COMPRA = await cliente(EMPRESA_A, 'Cliente A2 sem compra', REP_A2);
  CLI_B1 = await cliente(EMPRESA_B, 'Cliente empresa B', REP_B1);

  // A fonte de autorização é a carteira temporal; clientes.representante_id é legado.
  const carteira = RESOURCES.representante_cliente;
  // Carteira compartilhada: A1=40%, A2=60%. Ambos acessam o cliente, mas cada um vê somente suas vendas históricas.
  await s.insert(carteira, { empresa_id: EMPRESA_A, representante_id: REP_A1, cliente_id: CLI_A1, inicio: '2026-01-01', status: 'ativo', participacao_pct: 40 } as any);
  await s.insert(carteira, { empresa_id: EMPRESA_A, representante_id: REP_A2, cliente_id: CLI_A1, inicio: '2026-01-01', status: 'ativo', participacao_pct: 60 } as any);
  // Regressão: a checagem direta precisa percorrer a segunda página; 500 vínculos ativos já expirados vêm antes do vigente.
  for (let i = 0; i < 500; i += 1) {
    await s.insert(carteira, { empresa_id: EMPRESA_A, representante_id: REP_A1, cliente_id: CLI_A_PAG, inicio: '2025-01-01', fim: '2025-01-02', status: 'ativo', participacao_pct: 100 } as any);
  }
  await s.insert(carteira, { empresa_id: EMPRESA_A, representante_id: REP_A1, cliente_id: CLI_A_PAG, inicio: '2026-01-01', status: 'ativo', participacao_pct: 100 } as any);
  await s.insert(carteira, { empresa_id: EMPRESA_A, representante_id: REP_A1, cliente_id: CLI_A_FUT, inicio: '2099-01-01', status: 'ativo', participacao_pct: 100 } as any);
  await s.insert(carteira, { empresa_id: EMPRESA_A, representante_id: REP_A1, cliente_id: CLI_A_HIST, inicio: '2025-01-01', fim: '2025-12-31', status: 'encerrado', participacao_pct: 100 } as any);
  await s.insert(carteira, { empresa_id: EMPRESA_A, representante_id: REP_A1, cliente_id: CLI_A_CANCEL, inicio: '2025-01-01', fim: '2025-06-30', status: 'cancelado', participacao_pct: 100 } as any);
  await s.insert(carteira, { empresa_id: EMPRESA_A, representante_id: REP_A2, cliente_id: CLI_A2, inicio: '2026-01-01', status: 'ativo', participacao_pct: 100 } as any);
  await s.insert(carteira, { empresa_id: EMPRESA_A, representante_id: REP_A2, cliente_id: CLI_A2_SEM_COMPRA, inicio: '2026-01-01', status: 'ativo', participacao_pct: 100 } as any);
  await s.insert(carteira, { empresa_id: EMPRESA_B, representante_id: REP_B1, cliente_id: CLI_B1, inicio: '2026-01-01', status: 'ativo', participacao_pct: 100 } as any);
  // Inconsistência proposital no campo legado: não pode conceder nem retirar acesso.
  await s.update(RESOURCES.clientes, CLI_A1, { representante_id: REP_A2 } as any);

  await venda(EMPRESA_A, CLI_A1, REP_A1, 1000);
  await venda(EMPRESA_A, CLI_A1, REP_A2, 7777); // histórico congelado de outro representante não entra nas métricas de A1.
  await venda(EMPRESA_A, CLI_A2, REP_A2, 5000);
  await venda(EMPRESA_A, CLI_A_SEM, REP_A1, 100);
  await venda(EMPRESA_A, CLI_A_PAG, REP_A1, 300); // o cliente da regressão de paginação também tem compra própria.
  await venda(EMPRESA_A, CLI_A_HIST, REP_A1, 321, '2025-06-01T12:00:00.000Z'); // histórico do cliente encerrado permanece visível para o representante.
  await venda(EMPRESA_B, CLI_B1, REP_B1, 9999);

  SEG_A = Number((await s.insert(RESOURCES.customer_segments, {
    empresa_id: EMPRESA_A, nome: 'Segmento A', regra: JSON.stringify({ valor_min: 0 }),
  } as any)).id);
});

async function sessaoRepresentanteA1(): Promise<string> {
  const id = await usuario('operador', EMPRESA_A, 'Ana Rep');
  // Vincula o usuário ao representante REP_A1 (dono de CLI_A1) — a carteira vem
  // do vínculo cadastral, relida do banco pelo requireAuth.
  await s.update(RESOURCES.representantes, REP_A1, { usuario_id: id } as any);
  invalidarCacheCarteira();
  return tokenPara(id);
}

async function sessaoRepresentanteA2(): Promise<string> {
  const id = await usuario('operador', EMPRESA_A, 'Bruno Rep');
  await s.update(RESOURCES.representantes, REP_A2, { usuario_id: id } as any);
  invalidarCacheCarteira();
  return tokenPara(id);
}

// ---------------------------------------------------------------------------
test('BL-017: listagem e acesso direto a clientes usam apenas a carteira temporal', async () => {
  const token = await sessaoRepresentanteA1();
  const lista = await request(app).get('/api/clientes').set('Authorization', 'Bearer ' + token);
  assert.equal(lista.status, 200);
  const ids = (lista.body.rows as any[]).map((c) => Number(c.id));
  assert.ok(ids.includes(CLI_A1), 'o vínculo temporal concede acesso mesmo com representante_id legado divergente');
  assert.ok(!ids.includes(CLI_A2), 'representante_id legado não concede acesso sem vínculo temporal');
  assert.ok(!ids.includes(CLI_A_SEM), 'cliente sem vínculo temporal não entra na carteira');
  assert.ok(!ids.includes(CLI_A_FUT), 'vínculo com início futuro não concede acesso antecipado');
  assert.ok(ids.includes(CLI_A_HIST), 'vínculo encerrado preserva leitura e histórico do cliente da própria carteira');
  assert.ok(!ids.includes(CLI_A_CANCEL), 'vínculo cancelado nunca concede acesso');
  assert.ok(ids.includes(CLI_A_PAG), 'o vínculo vigente é encontrado mesmo depois de 500 vínculos expirados');
  assert.ok(!ids.includes(CLI_B1), 'cliente de outra empresa não entra na carteira');

  const proprio = await request(app).get('/api/clientes/' + CLI_A1).set('Authorization', 'Bearer ' + token);
  assert.equal(proprio.status, 200, 'o acesso direto aceita o vínculo temporal vigente');
  const alheio = await request(app).get('/api/clientes/' + CLI_A2).set('Authorization', 'Bearer ' + token);
  assert.equal(alheio.status, 404, 'o acesso direto não confia no representante_id legado');
  const legado = await request(app).get('/api/clientes/' + CLI_A_SEM).set('Authorization', 'Bearer ' + token);
  assert.equal(legado.status, 404, 'um representante_id legado igual ao ator não substitui vínculo temporal');
  const futuro = await request(app).get('/api/clientes/' + CLI_A_FUT).set('Authorization', 'Bearer ' + token);
  assert.equal(futuro.status, 404, 'vínculo futuro não autoriza leitura antes da data de início');
  const paginado = await request(app).get('/api/clientes/' + CLI_A_PAG).set('Authorization', 'Bearer ' + token);
  assert.equal(paginado.status, 200, 'a leitura reconhece clientes históricos da própria carteira');
  const historico = await request(app).get('/api/clientes/' + CLI_A_HIST).set('Authorization', 'Bearer ' + token);
  assert.equal(historico.status, 200, 'cliente de vínculo encerrado permanece disponível para consulta histórica');
  const cancelado = await request(app).get('/api/clientes/' + CLI_A_CANCEL).set('Authorization', 'Bearer ' + token);
  assert.equal(cancelado.status, 404, 'vínculo cancelado não autoriza consulta');
  const escritaHistorica = await request(app).put('/api/clientes/' + CLI_A_HIST).set('Authorization', 'Bearer ' + token).send({ nome: 'Não pode editar cliente histórico' });
  assert.equal(escritaHistorica.status, 404, 'histórico é somente leitura; edição exige vínculo vigente');
  const escritaPaginada = await request(app).put('/api/clientes/' + CLI_A_PAG).set('Authorization', 'Bearer ' + token).send({ nome: 'Cliente paginado atual' });
  assert.equal(escritaPaginada.status, 200, 'a escrita percorre a paginação e exige encontrar o vínculo vigente');

  const atualizacao = await request(app).put('/api/clientes/' + CLI_A1).set('Authorization', 'Bearer ' + token).send({ nome: 'Cliente compartilhado atualizado' });
  assert.equal(atualizacao.status, 200, 'o vínculo temporal autoriza atualização mesmo quando o campo legado aponta para outro representante');
  const persistido = await s.get(RESOURCES.clientes, CLI_A1);
  assert.equal(Number(persistido?.representante_id), REP_A2, 'a atualização não reescreve o campo legado nem altera o histórico de atribuição');
});

test('BL-017: exportação LGPD respeita a carteira temporal', async () => {
  const token = await sessaoRepresentanteA1();
  const proprio = await request(app).get('/api/clientes/' + CLI_A1 + '/dados-lgpd').set('Authorization', 'Bearer ' + token);
  assert.equal(proprio.status, 200);
  const historico = await request(app).get('/api/clientes/' + CLI_A_HIST + '/dados-lgpd').set('Authorization', 'Bearer ' + token);
  assert.equal(historico.status, 200, 'a exportação LGPD mantém acesso ao histórico da própria carteira');
  const cancelado = await request(app).get('/api/clientes/' + CLI_A_CANCEL + '/dados-lgpd').set('Authorization', 'Bearer ' + token);
  assert.equal(cancelado.status, 404, 'vínculo cancelado não autoriza exportação');
  const alheio = await request(app).get('/api/clientes/' + CLI_A2 + '/dados-lgpd').set('Authorization', 'Bearer ' + token);
  assert.equal(alheio.status, 404, 'a exportação não usa o representante_id legado');
});

test('BL-017: representante não pode se autoatribuir cliente fora da carteira', async () => {
  const token = await sessaoRepresentanteA1();
  const r = await request(app).post('/api/representante_cliente').set('Authorization', 'Bearer ' + token).send({
    cliente_id: CLI_A2,
    representante_id: REP_A1,
    inicio: new Date().toISOString().slice(0, 10),
    status: 'ativo',
    participacao_pct: 10,
  });
  assert.equal(r.status, 404, 'a tentativa de autoatribuição não deve confirmar nem conceder acesso ao cliente');
});



test('BL-017: carteira compartilhada autoriza ambos os representantes sem misturar vendas históricas', async () => {
  const token = await sessaoRepresentanteA2();
  const lista = await request(app).get('/api/clientes').set('Authorization', 'Bearer ' + token);
  assert.equal(lista.status, 200);
  const ids = (lista.body.rows as any[]).map((c) => Number(c.id));
  assert.ok(ids.includes(CLI_A1), 'o segundo representante acessa o cliente compartilhado');
  assert.ok(ids.includes(CLI_A2), 'o segundo representante mantém sua carteira exclusiva');

  const customer360Compartilhado = await request(app).get(`/api/customer360/${CLI_A1}`).set('Authorization', `Bearer ${token}`);
  assert.equal(customer360Compartilhado.status, 200);
  assert.equal(customer360Compartilhado.body.metricas.receita_total, 7777, 'o representante compartilhado só recebe as vendas historicamente atribuídas a ele');
});

test('SEC-01: representante NÃO acessa cliente fora da carteira em /customer360 (404)', async () => {
  const token = await sessaoRepresentanteA1();
  // Próprio cliente: 200.
  const ok = await request(app).get(`/api/customer360/${CLI_A1}`).set('Authorization', `Bearer ${token}`);
  assert.equal(ok.status, 200, `o cliente da própria carteira abre, veio ${ok.status}`);
  assert.equal(ok.body.metricas.receita_total, 1000, 'Customer 360 soma apenas vendas historicamente atribuídas ao representante autenticado');
  const historico = await request(app).get(`/api/customer360/${CLI_A_HIST}`).set('Authorization', `Bearer ${token}`);
  assert.equal(historico.status, 200, 'Customer 360 mantém acesso a cliente de vínculo encerrado');
  assert.equal(historico.body.metricas.receita_total, 321, 'Customer 360 preserva a venda histórica atribuída ao representante');

  // Cliente de OUTRO representante da MESMA empresa: 404 (não vaza existência).
  const alheio = await request(app).get(`/api/customer360/${CLI_A2}`).set('Authorization', `Bearer ${token}`);
  assert.equal(alheio.status, 404, `cliente de outra carteira deveria ser 404, veio ${alheio.status}`);
});

test('SEC-01: /customer-segments/:id/avaliar é bloqueado por RBAC para o representante (403)', async () => {
  // O recurso `customer_segments` exige perfil gerente; o representante (operador)
  // é recusado ANTES de qualquer leitura. Ainda assim o handler aplica o recorte
  // de carteira (defesa em profundidade) — ver a asserção de RFM abaixo.
  const token = await sessaoRepresentanteA1();
  const r = await request(app).get(`/api/customer-segments/${SEG_A}/avaliar`).set('Authorization', `Bearer ${token}`);
  assert.equal(r.status, 403, 'a segmentação exige gerente/admin');
  assert.equal(r.body.clientes, undefined, 'a resposta negada não traz clientes');
});

test('SEC-01: /customer-segments/rfm recorta a carteira do representante', async () => {
  const token = await sessaoRepresentanteA1();
  const r = await request(app).get('/api/customer-segments/rfm').set('Authorization', `Bearer ${token}`);
  assert.equal(r.status, 200);
  const ids = (r.body.clientes as any[]).map((c) => Number(c.cliente_id));
  assert.ok(ids.includes(CLI_A1), 'a compra do próprio cliente entra no RFM');
  assert.ok(ids.includes(CLI_A_HIST), 'cliente com vínculo encerrado permanece nos dados históricos do RFM');
  assert.ok(!ids.includes(CLI_A2), 'a compra de outra carteira NÃO entra no RFM');
  assert.ok(!ids.includes(CLI_B1), 'a compra de outra empresa NÃO entra no RFM');
  // O `sem_compra` também é recortado: o cliente sem compra de OUTRA carteira
  // (CLI_A2_SEM_COMPRA) não pode ser contado.
  assert.equal(r.body.sem_compra, 0, 'o representante A1 não tem cliente sem compra na própria carteira');
});

test('SEC-01: gerente e admin continuam vendo a empresa inteira (nada foi afrouxado nem apertado a mais)', async () => {
  const gerente = await tokenPara(await usuario('gerente', EMPRESA_A, 'Gerente A'));
  const g = await request(app).get(`/api/customer-segments/${SEG_A}/avaliar`).set('Authorization', `Bearer ${gerente}`);
  assert.equal(g.status, 200);
  const idsG = (g.body.clientes as any[]).map((c) => Number(c.id));
  assert.ok(idsG.includes(CLI_A1) && idsG.includes(CLI_A2), 'o gerente vê as duas carteiras da empresa');
  assert.ok(!idsG.includes(CLI_B1), 'o gerente não vê a outra empresa');

  const admin = await tokenPara(await usuario('admin', EMPRESA_A, 'Admin A'));
  const a = await request(app).get('/api/customer-segments/rfm').set('Authorization', `Bearer ${admin}`);
  assert.equal(a.status, 200);
  const idsA = (a.body.clientes as any[]).map((c) => Number(c.cliente_id));
  assert.ok(idsA.includes(CLI_A1) && idsA.includes(CLI_A2), 'o admin vê as duas carteiras da empresa');
  assert.ok(!idsA.includes(CLI_B1), 'o admin não vê a outra empresa');
});

test('SEC-01: operador de backoffice SEM vínculo não é recortado (regra A06-14 preservada)', async () => {
  const token = await tokenPara(await usuario('operador', EMPRESA_A, 'Backoffice A'));
  const r = await request(app).get('/api/customer-segments/rfm').set('Authorization', `Bearer ${token}`);
  assert.equal(r.status, 200);
  const ids = (r.body.clientes as any[]).map((c) => Number(c.cliente_id));
  assert.ok(ids.includes(CLI_A1) && ids.includes(CLI_A2), 'sem vínculo de representante, sem recorte de carteira');
});

test('BL-017: cliente criado pelo representante recebe vínculo temporal inicial na mesma transação', async () => {
  const token = await sessaoRepresentanteA1();
  const r = await request(app).post('/api/clientes').set('Authorization', 'Bearer ' + token).send({
    nome: 'Novo cliente temporal ' + Date.now(),
    pessoa: 'pf',
    tipo: 'loja',
    indicador_ie: '9',
    ativo: true,
  });
  assert.equal(r.status, 201, 'criação do cliente deve funcionar, veio ' + r.status + ': ' + JSON.stringify(r.body));
  const id = Number(r.body.id);
  assert.ok(id > 0);
  const link = await s.findOneWhere(RESOURCES.representante_cliente, {
    empresa_id: EMPRESA_A,
    cliente_id: id,
    representante_id: REP_A1,
    status: 'ativo',
  });
  assert.ok(link, 'o vínculo temporal inicial precisa ser persistido junto ao cliente');
  const leitura = await request(app).get('/api/clientes/' + id).set('Authorization', 'Bearer ' + token);
  assert.equal(leitura.status, 200, 'o representante passa a acessar o cliente pela relação temporal recém-criada');
});
