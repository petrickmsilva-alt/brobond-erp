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
const { getStore } = await import('../src/services');
const { requireAuth, signToken } = await import('../src/auth');
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

async function venda(empresaId: number, clienteId: number, representanteId: number, total: number) {
  seq++;
  const hoje = new Date().toISOString();
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
  CLI_A_SEM = await cliente(EMPRESA_A, 'Cliente sem representante');
  CLI_B1 = await cliente(EMPRESA_B, 'Cliente empresa B', REP_B1);

  await venda(EMPRESA_A, CLI_A1, REP_A1, 1000);
  await venda(EMPRESA_A, CLI_A2, REP_A2, 5000);
  await venda(EMPRESA_A, CLI_A_SEM, REP_A1, 100);
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

// ---------------------------------------------------------------------------
test('SEC-01: representante NÃO acessa cliente fora da carteira em /customer360 (404)', async () => {
  const token = await sessaoRepresentanteA1();
  // Próprio cliente: 200.
  const ok = await request(app).get(`/api/customer360/${CLI_A1}`).set('Authorization', `Bearer ${token}`);
  assert.equal(ok.status, 200, `o cliente da própria carteira abre, veio ${ok.status}`);

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
  assert.ok(!ids.includes(CLI_A2), 'a compra de outra carteira NÃO entra no RFM');
  assert.ok(!ids.includes(CLI_B1), 'a compra de outra empresa NÃO entra no RFM');
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
