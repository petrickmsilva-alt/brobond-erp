// ============================================================================
// AUD-01 — TRANSIÇÕES DE ALERTA POR HTTP REAL (regressão da correção).
//
// Achado: reconhecer/resolver/silenciar chamavam `checkAccess(alert_events,
// 'update')`, mas o recurso declara `ops.update = false` (o CRUD genérico não
// pode editar uma ocorrência). Resultado: HTTP 405 para TODO ator — inclusive
// gerente/admin autorizados. A correção troca a guarda por `checkFluxoEscrita`,
// o helper canônico dos ENDPOINTS DE FLUXO (ops fechada + endpoint é o caminho
// legítimo), preservando a alçada (autenticação, minPerfil, RBAC) e mantendo o
// CRUD genérico BLOQUEADO.
//
// Este arquivo passa pelo PIPELINE HTTP real: express + express.json +
// requireAuth (JWT + sessão + concessões relidas do banco) + handler + wrap de
// erro. Nada de requisição falsa com `user` injetado à mão.
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express, { type NextFunction, type Request, type Response } from 'express';
import request from 'supertest';

process.env.NODE_ENV = 'test';
delete process.env.DATABASE_URL;

const { RESOURCES, getPublicResource } = await import('../src/resources');
const { getStore, updateRecord, createRecord, deleteRecord } = await import('../src/services');
const { requireAuth, currentUser, signToken } = await import('../src/auth');
const { abrirSessao } = await import('../src/sessoes');
const {
  reconhecerAlertaHandler,
  resolverAlertaHandler,
  silenciarAlertaHandler,
} = await import('../src/alerts');

function wrap(fn: (req: Request, res: Response) => Promise<unknown>) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res).catch(next);
  };
}

function resourceParam(req: Request, _res: Response, next: NextFunction) {
  const r = getPublicResource(String(req.params.resource));
  if (!r) return next(Object.assign(new Error('Recurso não encontrado'), { status: 404 }));
  (req as any).resource = r;
  next();
}

// Espelha o bloco genérico do index.ts (mesma guarda `checkAccess`): é o que
// precisa continuar recusando a edição de `alert_events`.
const updateHandler = wrap(async (req: Request, res: Response) => {
  const r = (req as any).resource;
  const actor = currentUser(req);
  const { checkAccess } = await import('../src/services');
  checkAccess(r, actor, 'update');
  res.json(await updateRecord(r, Number(req.params.id), req.body, actor));
});

const app = express();
app.use(express.json());
app.use('/api', requireAuth);
// CRUD genérico (subset fiel ao index.ts) — o caminho que DEVE seguir fechado.
app.post('/api/:resource', resourceParam, wrap(async (req, res) => {
  const r = (req as any).resource;
  const actor = currentUser(req);
  const { checkAccess } = await import('../src/services');
  checkAccess(r, actor, 'create');
  res.status(201).json(await createRecord(r, req.body, actor));
}));
app.put('/api/:resource/:id', resourceParam, updateHandler);
app.patch('/api/:resource/:id', resourceParam, updateHandler);
app.delete('/api/:resource/:id', resourceParam, wrap(async (req, res) => {
  const r = (req as any).resource;
  const actor = currentUser(req);
  const { checkAccess } = await import('../src/services');
  checkAccess(r, actor, 'delete');
  await deleteRecord(r, Number(req.params.id), actor);
  res.json({ ok: true });
}));
// Endpoints de FLUXO (AUD-01).
app.post('/api/alerts/:id/reconhecer', wrap(reconhecerAlertaHandler));
app.post('/api/alerts/:id/resolver', wrap(resolverAlertaHandler));
app.post('/api/alerts/:id/silenciar', wrap(silenciarAlertaHandler));
app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  res.status(err?.status || 500).json({ error: err?.message || 'erro' });
});

const s = getStore();
let seq = 0;

async function novaEmpresa(nome: string): Promise<number> {
  seq++;
  const emp = await s.insert(RESOURCES.empresas, { nome: `${nome} ${Date.now()} ${seq}` } as any);
  return Number(emp.id);
}

/** Usuário REAL + colunas de tenant/sessão como o `requireAuth` as lê. */
async function criarUsuario(perfil: 'admin' | 'gerente' | 'operador', empresaId: number, extra: Record<string, unknown> = {}): Promise<number> {
  seq++;
  const row = await s.insert(RESOURCES.usuarios, {
    nome: `Usuário ${perfil} ${seq}`,
    email: `aud01-${perfil}-${seq}-${Date.now()}@brobond.test`,
    perfil,
    ativo: true,
    senha_hash: 'x',
  } as any);
  const id = Number(row.id);
  const tabela = (s as any).table('usuarios');
  Object.assign(tabela.rows.get(id), { empresa_id: empresaId, token_versao: 0, ...extra });
  return id;
}

/** Emite um token de acesso real (sessão em `sessoes` + JWT com sid/ver). */
async function tokenPara(usuarioId: number, empresaSessao?: number): Promise<string> {
  const row = await s.findOneWhere(RESOURCES.usuarios, { id: usuarioId });
  const sid = await abrirSessao({ usuarioId, lembrar: false, req: { headers: {}, socket: { remoteAddress: '127.0.0.1' } } as any });
  const user: any = { id: usuarioId, name: String(row!.nome), email: String(row!.email), perfil: String(row!.perfil), empresa_id: Number(row!.empresa_id) };
  const token = signToken(user, { ver: Number(row!.token_versao || 0), sid });
  // O claim `emp` (seletor de empresa da sessão) é montado no signToken a partir
  // de `empresa_sessao`; sem ele vale a empresa padrão do usuário.
  void empresaSessao;
  return token;
}

async function criarAlerta(empresaId: number, status = 'ABERTO', extra: Record<string, unknown> = {}): Promise<number> {
  seq++;
  const a = await s.insert(RESOURCES.alert_events, {
    empresa_id: empresaId,
    titulo: `Alerta AUD-01 ${seq}`,
    dominio: 'estoque',
    severidade: 'alta',
    regra_chave: 'ruptura_estoque',
    fingerprint: `fp-${empresaId}-${seq}-${Date.now()}`,
    status,
    ocorrencias: 1,
    ...extra,
  } as any);
  return Number(a.id);
}

const post = (rota: string, token?: string) => {
  const r = request(app).post(rota);
  return token ? r.set('Authorization', `Bearer ${token}`) : r;
};

// ---------------------------------------------------------------------------
// Cenários de AUTORIZAÇÃO (o núcleo do AUD-01)
// ---------------------------------------------------------------------------
test('AUD-01: gerente autorizado reconhece/resolve/silencia → 200 (antes: 405)', async () => {
  const emp = await novaEmpresa('AUD01 Gerente');
  const gerente = await tokenPara(await criarUsuario('gerente', emp));

  const idRec = await criarAlerta(emp);
  const rec = await post(`/api/alerts/${idRec}/reconhecer`, gerente);
  assert.equal(rec.status, 200, `reconhecer deveria ser 200, veio ${rec.status}: ${JSON.stringify(rec.body)}`);
  assert.equal(rec.body.status, 'CIENTE');

  const idRes = await criarAlerta(emp);
  const res1 = await post(`/api/alerts/${idRes}/resolver`, gerente).send({ resolucao: 'Reposto pelo comprador.' });
  assert.equal(res1.status, 200);
  assert.equal(res1.body.status, 'RESOLVIDO');

  const idSil = await criarAlerta(emp);
  const sil = await post(`/api/alerts/${idSil}/silenciar`, gerente).send({ silenciado_ate: new Date(Date.now() + 86_400_000).toISOString() });
  assert.equal(sil.status, 200);
  assert.equal(sil.body.status, 'SILENCIADO');
});

test('AUD-01: administrador autorizado também transiciona → 200', async () => {
  const emp = await novaEmpresa('AUD01 Admin');
  const admin = await tokenPara(await criarUsuario('admin', emp));
  const id = await criarAlerta(emp);
  const r = await post(`/api/alerts/${id}/reconhecer`, admin);
  assert.equal(r.status, 200);
  assert.equal(r.body.status, 'CIENTE');
});

test('AUD-01: usuário sem permissão (operador) → 403 em todas as transições', async () => {
  const emp = await novaEmpresa('AUD01 Operador');
  const operador = await tokenPara(await criarUsuario('operador', emp));
  const id = await criarAlerta(emp);
  assert.equal((await post(`/api/alerts/${id}/reconhecer`, operador)).status, 403);
  assert.equal((await post(`/api/alerts/${id}/resolver`, operador).send({ resolucao: 'x' })).status, 403);
  assert.equal((await post(`/api/alerts/${id}/silenciar`, operador).send({ silenciado_ate: new Date().toISOString() })).status, 403);
});

test('AUD-01: não autenticado → 401 (nenhum token)', async () => {
  const emp = await novaEmpresa('AUD01 Anon');
  const id = await criarAlerta(emp);
  assert.equal((await post(`/api/alerts/${id}/reconhecer`)).status, 401);
  assert.equal((await post(`/api/alerts/${id}/resolver`).send({ resolucao: 'x' })).status, 401);
  assert.equal((await post(`/api/alerts/${id}/silenciar`).send({ silenciado_ate: new Date().toISOString() })).status, 401);
});

test('AUD-01: alerta inexistente → 404', async () => {
  const emp = await novaEmpresa('AUD01 Inexistente');
  const gerente = await tokenPara(await criarUsuario('gerente', emp));
  assert.equal((await post('/api/alerts/99999999/reconhecer', gerente)).status, 404);
  assert.equal((await post('/api/alerts/99999999/resolver', gerente).send({ resolucao: 'x' })).status, 404);
});

// ---------------------------------------------------------------------------
// ISOLAMENTO MULTIEMPRESA
// ---------------------------------------------------------------------------
test('AUD-01: alerta de OUTRA empresa → bloqueio seguro (404), sem transição', async () => {
  const empA = await novaEmpresa('AUD01 A');
  const empB = await novaEmpresa('AUD01 B');
  const gerenteB = await tokenPara(await criarUsuario('gerente', empB));
  const idA = await criarAlerta(empA);

  assert.equal((await post(`/api/alerts/${idA}/reconhecer`, gerenteB)).status, 404);
  assert.equal((await post(`/api/alerts/${idA}/resolver`, gerenteB).send({ resolucao: 'x' })).status, 404);
  assert.equal((await post(`/api/alerts/${idA}/silenciar`, gerenteB).send({ silenciado_ate: new Date().toISOString() })).status, 404);

  // O alerta da empresa A permanece intacto.
  const row = await s.findOneWhere(RESOURCES.alert_events, { id: idA });
  assert.equal(String(row!.status), 'ABERTO');
  assert.equal(row!.reconhecido_em ?? null, null);
});

test('AUD-01: `empresa_id` forjado no payload não abre acesso cruzado', async () => {
  const empA = await novaEmpresa('AUD01 ForjaA');
  const empB = await novaEmpresa('AUD01 ForjaB');
  const gerenteB = await tokenPara(await criarUsuario('gerente', empB));
  const idA = await criarAlerta(empA);

  // Tentar reconhecer o alerta da A declarando empresa_id=A no corpo: a empresa
  // vem SEMPRE do escopo do servidor → 404 (não vaza existência).
  const r = await post(`/api/alerts/${idA}/reconhecer`, gerenteB).send({ empresa_id: empA });
  assert.equal(r.status, 404);
  const rowA = await s.findOneWhere(RESOURCES.alert_events, { id: idA });
  assert.equal(String(rowA!.status), 'ABERTO');

  // Declarar empresa_id=A no alerta da PRÓPRIA empresa B não move o registro.
  const idB = await criarAlerta(empB);
  const r2 = await post(`/api/alerts/${idB}/reconhecer`, gerenteB).send({ empresa_id: empA });
  assert.equal(r2.status, 200);
  const rowB = await s.findOneWhere(RESOURCES.alert_events, { id: idB });
  assert.equal(Number(rowB!.empresa_id), empB, 'o alerta continua na empresa B');
});

// ---------------------------------------------------------------------------
// CONTRATO / IDEMPOTÊNCIA / HISTÓRICO
// ---------------------------------------------------------------------------
test('AUD-01: transição inválida → erro conforme contrato (400)', async () => {
  const emp = await novaEmpresa('AUD01 Contrato');
  const gerente = await tokenPara(await criarUsuario('gerente', emp));
  const id = await criarAlerta(emp);
  // Resolução vazia.
  assert.equal((await post(`/api/alerts/${id}/resolver`, gerente).send({ resolucao: '   ' })).status, 400);
  // Data de silenciamento inválida.
  assert.equal((await post(`/api/alerts/${id}/silenciar`, gerente).send({ silenciado_ate: 'não-é-data' })).status, 400);
  // Id inválido (não inteiro positivo).
  assert.equal((await post('/api/alerts/abc/reconhecer', gerente)).status, 400);
});

test('AUD-01: requisição repetida é IDEMPOTENTE e preserva a 1ª transição', async () => {
  const emp = await novaEmpresa('AUD01 Idem');
  const gerente = await tokenPara(await criarUsuario('gerente', emp));
  const id = await criarAlerta(emp);

  const r1 = await post(`/api/alerts/${id}/reconhecer`, gerente);
  assert.equal(r1.status, 200);
  const reconhecidoEm1 = r1.body.reconhecido_em;

  const r2 = await post(`/api/alerts/${id}/reconhecer`, gerente);
  assert.equal(r2.status, 200, 'repetir é idempotente, não erro');
  assert.equal(r2.body.reconhecido_em, reconhecidoEm1, 'a data da 1ª transição é preservada');

  // O histórico aponta o autor e a hora; nenhuma linha duplicada de alerta.
  const row = await s.findOneWhere(RESOURCES.alert_events, { id });
  assert.equal(Number(row!.reconhecido_por), await usuarioDoToken(gerente));
  assert.ok(row!.reconhecido_em);
  const total = (await s.list(RESOURCES.alert_events, { page: 1, pageSize: 100, filter: { empresa_id: emp } })).total;
  assert.equal(total, 1, 'a transição não cria ocorrência nova');
});

test('AUD-01: transições ficam AUDITADAS (autor, recurso e registro)', async () => {
  const emp = await novaEmpresa('AUD01 Auditoria');
  const gerenteId = await criarUsuario('gerente', emp);
  const gerente = await tokenPara(gerenteId);
  const id = await criarAlerta(emp);
  await post(`/api/alerts/${id}/reconhecer`, gerente);
  await post(`/api/alerts/${id}/resolver`, gerente).send({ resolucao: 'Resolvido no teste.' });

  const aud = await s.list(RESOURCES.auditoria, { page: 1, pageSize: 50, filter: { empresa_id: emp, recurso: 'alert_events' } });
  assert.ok(aud.rows.length >= 2, 'reconhecer e resolver deixam trilha');
  assert.ok(aud.rows.some((a) => Number(a.usuario_id) === gerenteId), 'o autor é registrado');
});

// ---------------------------------------------------------------------------
// O CRUD GENÉRICO CONTINUA FECHADO (a correção não afrouxou nada)
// ---------------------------------------------------------------------------
test('AUD-01: CRUD genérico de alert_events segue bloqueado (405)', async () => {
  const emp = await novaEmpresa('AUD01 CRUD');
  const gerente = await tokenPara(await criarUsuario('gerente', emp));
  const id = await criarAlerta(emp);

  const put = await request(app).put(`/api/alert_events/${id}`).set('Authorization', `Bearer ${gerente}`).send({ status: 'CIENTE' });
  assert.equal(put.status, 405, 'PUT genérico não edita alert_events');
  const patch = await request(app).patch(`/api/alert_events/${id}`).set('Authorization', `Bearer ${gerente}`).send({ status: 'CIENTE' });
  assert.equal(patch.status, 405, 'PATCH genérico não edita alert_events');
  const post = await request(app).post('/api/alert_events').set('Authorization', `Bearer ${gerente}`).send({ titulo: 'x' });
  assert.equal(post.status, 405, 'POST genérico não cria alert_events');
  const del = await request(app).delete(`/api/alert_events/${id}`).set('Authorization', `Bearer ${gerente}`);
  assert.equal(del.status, 405, 'DELETE genérico não exclui alert_events');

  // O registro permanece como estava.
  const row = await s.findOneWhere(RESOURCES.alert_events, { id });
  assert.equal(String(row!.status), 'ABERTO');
});

// ---------------------------------------------------------------------------
// CONCORRÊNCIA — duas transições simultâneas não corrompem o estado
// ---------------------------------------------------------------------------
test('AUD-01: transições concorrentes convergem sem estado inconsistente', async () => {
  const emp = await novaEmpresa('AUD01 Corrida');
  const gerente = await tokenPara(await criarUsuario('gerente', emp));
  const id = await criarAlerta(emp);

  const [a, b, c] = await Promise.all([
    post(`/api/alerts/${id}/reconhecer`, gerente),
    post(`/api/alerts/${id}/resolver`, gerente).send({ resolucao: 'A' }),
    post(`/api/alerts/${id}/reconhecer`, gerente),
  ]);
  for (const r of [a, b, c]) assert.equal(r.status, 200, `transição concorrente deveria ser 200, veio ${r.status}`);

  // O estado final é um dos válidos (CIENTE ou RESOLVIDO) — nunca nulo/lixo.
  const row = await s.findOneWhere(RESOURCES.alert_events, { id });
  assert.ok(['CIENTE', 'RESOLVIDO'].includes(String(row!.status)), `status final inesperado: ${row!.status}`);
});

/** Descobre o id do usuário a partir do token (para conferir o autor auditado). */
async function usuarioDoToken(token: string): Promise<number> {
  const { verifyToken } = await import('../src/auth');
  return Number((verifyToken(token) as any).id);
}
