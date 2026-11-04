// R-4 (Fase 4.2) — contrato do cron e separação de recorrências financeiras.
// LOCAL: store em memória; nenhuma recorrência real é criada; nenhuma rede.
// Regras: (1) relatórios não executam recorrências financeiras; (2) execução de recorrências
// tem fluxo e confirmação próprios; (3) o cron autentica SOMENTE por CRON_SECRET, falha fechado
// sem a variável e não aceita sessão; (4) o cron é montado antes da guarda de sessão.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
process.env.NODE_ENV = 'test';
delete process.env.DATABASE_URL;

const S = await import('../src/scheduled');
const F = await import('../src/financeiro');
const ler = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const trecho = (src: string, assinatura: string): string => {
  const i = src.indexOf(assinatura);
  if (i < 0) return '';
  const prox = src.indexOf('\nexport ', i + assinatura.length);
  return src.slice(i, prox < 0 ? undefined : prox);
};

function resDe() {
  const r: any = { statusCode: 200, body: undefined };
  r.status = (c: number) => { r.statusCode = c; return r; };
  r.json = (b: unknown) => { r.body = b; return r; };
  return r;
}
async function chamar(fn: (req: any, res: any) => Promise<unknown>, req: any) {
  const res = resDe();
  let erro: any = null;
  try { await fn(req, res); } catch (e: any) { erro = e; }
  return { erro, res };
}

test('cron: sem CRON_SECRET configurado, falha fechado e não executa nada (503)', async (t) => {
  t.after(() => { delete process.env.CRON_SECRET; });
  delete process.env.CRON_SECRET;
  const { erro, res } = await chamar(S.cronScheduled as any, { headers: {}, user: undefined });
  assert.ok(erro?.status === 503 || res.statusCode === 503, 'cron sem segredo deve responder 503');
  assert.equal(res.body?.executados, undefined, 'nada foi executado');
});

test('cron: sessão de usuário (Bearer de sessão) não autentica o cron (401)', async (t) => {
  t.after(() => { delete process.env.CRON_SECRET; });
  process.env.CRON_SECRET = 'segredo-cron-de-teste-0123456789';
  const { erro, res } = await chamar(S.cronScheduled as any, { headers: { authorization: 'Bearer sessao-do-admin-xyz' }, user: { id: 1, perfil: 'admin' } });
  // R-4 (Fase 4.3): a recusa é respondida diretamente (res.status), sem exceção. Lê-se o status de qualquer canal.
  assert.equal(erro?.status ?? res.statusCode, 401);
});

test('cron: com CRON_SECRET correto, responde 200 (controle do contrato)', async (t) => {
  t.after(() => { delete process.env.CRON_SECRET; });
  process.env.CRON_SECRET = 'segredo-cron-de-teste-0123456789';
  const { erro, res } = await chamar(S.cronScheduled as any, { headers: { authorization: `Bearer ${process.env.CRON_SECRET}` } });
  assert.equal(erro, null, erro?.message);
  assert.equal(res.statusCode, 200);
});

test('relatórios e cron não executam recorrências financeiras (efeito financeiro fora do agendador)', () => {
  const src = ler('../src/scheduled.ts');
  assert.equal(trecho(src, 'export async function runScheduled').includes('processarRecorrencias'), false, 'runScheduled não processa recorrências');
  assert.equal(trecho(src, 'export async function cronScheduled').includes('processarRecorrencias'), false, 'cronScheduled não processa recorrências');
  assert.equal(src.includes('processarRecorrencias'), false, 'scheduled.ts não importa a execução de recorrências');
});

test('execução de recorrências: exige confirmação explícita e não roda sem ela', async () => {
  const admin = { id: 1, name: 'Admin', perfil: 'admin', empresa_id: 1 };
  const { erro, res } = await chamar(F.cronRecorrencias as any, { headers: {}, body: {}, user: admin });
  assert.equal(erro?.status, 400, 'sem confirmação, a execução é recusada (400)');
  assert.equal(res.body?.gerados, undefined, 'nada é gerado sem confirmação');
});

test('execução de recorrências: usa o escopo da empresa do administrador (sem processamento global)', () => {
  const src = ler('../src/financeiro.ts');
  const corpo = trecho(src, 'export async function cronRecorrencias');
  assert.ok(corpo.includes('escopoDoAtor'), 'a execução é restrita ao escopo do ator');
  assert.equal(corpo.includes('CRON_SECRET'), false, 'sem ramo de autenticação por segredo dentro da execução financeira');
  assert.equal(corpo.includes("name: 'Agendador'"), false, 'sem identidade fictícia de agendador');
});

test('estrutura: o cron é montado ANTES da guarda de sessão e fora de /api/admin', () => {
  const index = ler('../src/index.ts');
  const guardaSessao = index.indexOf("app.use('/api', wrap(requireAuth))");
  const posCron = index.indexOf("app.post('/api/admin/scheduled/cron'");
  assert.ok(guardaSessao > 0 && posCron > 0, 'rota e guarda existem');
  assert.ok(posCron < guardaSessao, 'o cron autentica por CRON_SECRET, não por sessão: deve vir antes de requireAuth');
  assert.equal(index.includes("app.post('/api/admin/scheduled/cron', wrap(cronScheduled));\n") && posCron > index.indexOf("app.use('/api/admin', requireRole('admin'))"), false, 'não pode ficar atrás da guarda de administrador');
});

test('estrutura: a rota administrativa de recorrências continua atrás de sessão + administrador', () => {
  const index = ler('../src/index.ts');
  const guardaAdmin = index.indexOf("app.use('/api/admin', requireRole('admin'))");
  const pos = index.indexOf("app.post('/api/admin/financeiro/recorrencias'");
  assert.ok(guardaAdmin > 0 && pos > guardaAdmin, 'execução de recorrências continua exigindo administrador');
});
