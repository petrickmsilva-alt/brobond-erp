// ============================================================================
// MULTIEMPRESA — isolamento de empresa nas leituras e escritas do BI
// (/api/negocios/*), testado por HTTP REAL contra o pipeline de autenticação:
//
//   requireAuth (JWT + sessão + concessões vigentes em usuario_empresas)
//     → handler de negócios (aplicarEscopoEmpresaBi / validarVendaManual)
//
// Não é um teste de handler com requisição falsa: cada caso passa por login
// real (POST /api/auth/login), recebe o token da sessão e chama a API.
//
// Casos cobertos:
//   A) empresa autorizada → 200 com dados SOMENTE da empresa pedida;
//   B) empresa não autorizada → 403 (resumo, ABC, margens e escrita);
//   C) ausência de empresa → empresa ATIVA da sessão, nunca consolidação
//      silenciosa; consolidar só com pode_consolidar + ?consolidado=1;
//   D) chamada direta à API (sem passar pelo frontend).
// ============================================================================
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import express, { type NextFunction, type Request, type Response } from 'express';
import request from 'supertest';

process.env.NODE_ENV = 'test';
delete process.env.DATABASE_URL;

const { RESOURCES } = await import('../src/resources');
const { createRecord, getStore } = await import('../src/services');
const { login, requireAuth } = await import('../src/auth');
const { hashPassword } = await import('../src/password');
const { trocarEmpresaAtiva } = await import('../src/empresasApi');
const neg = await import('../src/negocios');
const { __reiniciarMemoriaNegocios } = neg;

// Mesmo contrato de erro do index.ts: HttpError → status + mensagem.
function wrap(fn: (req: Request, res: Response) => Promise<unknown>) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res).catch(next);
  };
}

const app = express();
app.use(express.json());
app.post('/api/auth/login', wrap(login as any));
app.post('/api/empresas/ativa', requireAuth, wrap(trocarEmpresaAtiva as any));
app.get('/api/negocios/canais', requireAuth, wrap(neg.negociosCanais as any));
app.get('/api/negocios/resumo', requireAuth, wrap(neg.negociosResumo as any));
app.get('/api/negocios/abc', requireAuth, wrap(neg.negociosABC as any));
app.get('/api/negocios/margens', requireAuth, wrap(neg.negociosMargens as any));
app.post('/api/negocios/vendas', requireAuth, wrap(neg.negociosVendaManual as any));
app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  res.status(err?.status || 500).json({ error: err?.message || 'erro' });
});

const SENHA = 'Seguranca#2026';
const admin = { id: 1, name: 'Admin', perfil: 'admin' as const };

let EMPRESA_A = 0;
let EMPRESA_B = 0;
let EMPRESA_C = 0;
let PRODUTO = 0;

type Sessao = { token: string; userId: number };

/**
 * `usuarios.empresa_id` e `usuarios.pode_consolidar` existem no banco, mas NÃO
 * estão em `fields` do recurso `usuarios`: o CRUD genérico descarta essas
 * colunas (memória e Postgres). Não há endpoint que as defina. Para montar o
 * cenário, o teste grava as colunas direto no store de memória — exatamente o
 * que o `requireAuth` lê ao montar o ator. (Pendência registrada no relatório.)
 */
function gravarColunasDoUsuario(userId: number, colunas: Record<string, unknown>) {
  const tabela = (getStore() as any).table(RESOURCES.usuarios.table);
  Object.assign(tabela.rows.get(userId), colunas);
}

let seq = 0;
/** Cria um gerente REAL com empresa padrão e concessões explícitas. */
async function criarGerente(nome: string, empresaPadrao: number, concessoes: number[], extras: Record<string, unknown> = {}) {
  seq++;
  const s = getStore();
  const row = await s.insert(RESOURCES.usuarios, {
    nome,
    email: `${nome.toLowerCase().replace(/\W+/g, '')}${seq}@brobond.test`,
    senha_hash: await hashPassword(SENHA),
    perfil: 'gerente',
    ativo: true,
  });
  const userId = Number(row.id);
  gravarColunasDoUsuario(userId, { empresa_id: empresaPadrao, ...extras });
  for (const empresaId of concessoes) {
    if (empresaId === empresaPadrao) continue; // a padrão já entra sempre
    await s.insert(RESOURCES.usuario_empresas, { usuario_id: userId, empresa_id: empresaId });
  }
  return userId;
}

async function entrar(email: string): Promise<Sessao> {
  const res = await request(app).post('/api/auth/login').send({ email, password: SENHA });
  assert.equal(res.status, 200, `login falhou: ${JSON.stringify(res.body)}`);
  assert.ok(res.body.token, 'login devolve token de sessão');
  const row = await getStore().findOneWhere(RESOURCES.usuarios, { email });
  return { token: res.body.token, userId: Number(row!.id) };
}

async function emailDe(userId: number): Promise<string> {
  const row = await getStore().findOneWhere(RESOURCES.usuarios, { id: userId });
  return String(row!.email);
}

/** Venda manual pela API (o caminho real de registro). */
async function venderPela(sessao: Sessao, empresaId: number | null, valorCents: number, dia = '2026-06-10') {
  const body: Record<string, unknown> = {
    canal: 'LOJA_FISICA',
    status: 'PAID',
    occurred_at: dia,
    itens: [{ product_id: PRODUTO, quantity: 1, unit_price_cents: valorCents }],
  };
  if (empresaId !== null) body.empresa_id = empresaId;
  return request(app).post('/api/negocios/vendas').set('Authorization', `Bearer ${sessao.token}`).send(body);
}

before(async () => {
  __reiniciarMemoriaNegocios();
  const admMemoria = { ...admin };
  EMPRESA_A = Number((await createRecord(RESOURCES.empresas, { nome: 'Empresa A Sec', razao_social: 'A SEC LTDA' }, admMemoria)).id);
  EMPRESA_B = Number((await createRecord(RESOURCES.empresas, { nome: 'Empresa B Sec', razao_social: 'B SEC LTDA' }, admMemoria)).id);
  EMPRESA_C = Number((await createRecord(RESOURCES.empresas, { nome: 'Empresa C Sec', razao_social: 'C SEC LTDA' }, admMemoria)).id);
  const produto = await createRecord(
    RESOURCES.produtos,
    { sku: 'SEC-1', nome: 'Camiseta Segurança', ncm: '6109.10.00', custo: 10, preco_venda: 50 },
    { ...admMemoria, empresa_id: EMPRESA_A, empresas: [EMPRESA_A] } as any
  );
  PRODUTO = Number(produto.id);
});

// ----------------------------------------------------------------------------
// Atores: A (só A), multi (A + B, padrão A), auditor (A + B, pode consolidar)
// ----------------------------------------------------------------------------

async function prepararAtores() {
  const ana = await criarGerente('Ana Sec', EMPRESA_A, [EMPRESA_A]);
  const multi = await criarGerente('Multi Sec', EMPRESA_A, [EMPRESA_A, EMPRESA_B]);
  const auditor = await criarGerente('Auditor Sec', EMPRESA_A, [EMPRESA_A, EMPRESA_B], { pode_consolidar: true });
  return {
    ana: await entrar(await emailDe(ana)),
    multi: await entrar(await emailDe(multi)),
    auditor: await entrar(await emailDe(auditor)),
  };
}

// ----------------------------------------------------------------------------
// A/B/D — empresa autorizada × não autorizada, por chamada direta à API
// ----------------------------------------------------------------------------

test('A) empresa autorizada: GET /api/negocios/resumo?empresa_id=A → 200 só com dados da A', async () => {
  __reiniciarMemoriaNegocios();
  const { ana, multi } = await prepararAtores();
  await venderPela(ana, EMPRESA_A, 10_000);
  // venda da B registrada por quem tem concessão à B
  await venderPela(multi, EMPRESA_B, 99_000);

  const r = await request(app).get(`/api/negocios/resumo?empresa_id=${EMPRESA_A}`).set('Authorization', `Bearer ${ana.token}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.filtros.empresa_id, EMPRESA_A);
  assert.equal(r.body.kpis.faturamentoCents, 10_000, 'a venda da B (99.000) não aparece');
  assert.equal(r.body.kpis.pedidos, 1);

  const canais = await request(app).get(`/api/negocios/canais?empresa_id=${EMPRESA_A}`).set('Authorization', `Bearer ${ana.token}`);
  assert.equal(canais.status, 200, 'o escopo explícito autorizado é aceito também no catálogo de canais');
  assert.ok(Array.isArray(canais.body.grupos));
});

test('B) empresa NÃO autorizada: GET /api/negocios/resumo?empresa_id=B → 403 e nenhum dado', async () => {
  const { ana } = await prepararAtores();
  const r = await request(app).get(`/api/negocios/resumo?empresa_id=${EMPRESA_B}`).set('Authorization', `Bearer ${ana.token}`);
  assert.equal(r.status, 403);
  assert.match(r.body.error, /acesso a esta empresa/);
  assert.equal(r.body.kpis, undefined, 'a resposta negada não traz KPIs');
});

test('B) empresa NÃO autorizada: GET /api/negocios/abc?empresa_id=B → 403', async () => {
  const { ana } = await prepararAtores();
  const r = await request(app).get(`/api/negocios/abc?empresa_id=${EMPRESA_B}`).set('Authorization', `Bearer ${ana.token}`);
  assert.equal(r.status, 403);
  assert.equal(r.body.linhas, undefined, 'a resposta negada não traz linhas da curva');
});

test('B) empresa NÃO autorizada: GET /api/negocios/margens?empresa_id=B → 403', async () => {
  const { ana } = await prepararAtores();
  const r = await request(app).get(`/api/negocios/margens?empresa_id=${EMPRESA_B}`).set('Authorization', `Bearer ${ana.token}`);
  assert.equal(r.status, 403);
  assert.equal(r.body.linhas, undefined);
});

test('B) escrita cruzada: POST /api/negocios/vendas com empresa_id=B por usuário da A → 403 e nada gravado', async () => {
  const { ana, multi } = await prepararAtores();
  __reiniciarMemoriaNegocios();
  const antes = await request(app).get(`/api/negocios/resumo?empresa_id=${EMPRESA_B}`).set('Authorization', `Bearer ${multi.token}`);
  assert.equal(antes.body.kpis.pedidos, 0, 'filial B começa sem vendas');

  const r = await venderPela(ana, EMPRESA_B, 5_000);
  assert.equal(r.status, 403);

  const depois = await request(app).get(`/api/negocios/resumo?empresa_id=${EMPRESA_B}`).set('Authorization', `Bearer ${multi.token}`);
  assert.equal(depois.body.kpis.pedidos, 0, 'a venda recusada não foi gravada na B');
});

test('B) GET /api/negocios/canais?empresa_id=B valida concessão apesar de retornar só metadados', async () => {
  const { ana } = await prepararAtores();
  const r = await request(app).get(`/api/negocios/canais?empresa_id=${EMPRESA_B}`).set('Authorization', `Bearer ${ana.token}`);
  assert.equal(r.status, 403);
  assert.equal(r.body.grupos, undefined);
});

test('B) empresa inexistente e não concedida também responde 403 (sem enumerar empresas)', async () => {
  const { ana } = await prepararAtores();
  const r = await request(app).get('/api/negocios/resumo?empresa_id=987654').set('Authorization', `Bearer ${ana.token}`);
  assert.equal(r.status, 403);
});

test('B) concessão revogada deixa de valer na próxima chamada', async () => {
  const id = await criarGerente('Revog Sec', EMPRESA_A, [EMPRESA_A, EMPRESA_C]);
  const sessao = await entrar(await emailDe(id));
  const antes = await request(app).get(`/api/negocios/resumo?empresa_id=${EMPRESA_C}`).set('Authorization', `Bearer ${sessao.token}`);
  assert.equal(antes.status, 200, 'com concessão, a C é consultável');

  const vinculo = await getStore().findOneWhere(RESOURCES.usuario_empresas, { usuario_id: id, empresa_id: EMPRESA_C });
  await getStore().remove(RESOURCES.usuario_empresas, Number(vinculo!.id));
  const { invalidarCacheEmpresas } = await import('../src/empresasAcesso');
  invalidarCacheEmpresas(id);

  const depois = await request(app).get(`/api/negocios/resumo?empresa_id=${EMPRESA_C}`).set('Authorization', `Bearer ${sessao.token}`);
  assert.equal(depois.status, 403, 'revogado → 403');
});

// ----------------------------------------------------------------------------
// C — ausência de empresa: nunca consolidação silenciosa
// ----------------------------------------------------------------------------

test('C) sem empresa_id, usuário com várias concessões vê SÓ a empresa ativa (padrão)', async () => {
  __reiniciarMemoriaNegocios();
  const { ana, multi } = await prepararAtores();
  await venderPela(ana, EMPRESA_A, 10_000);
  await venderPela(multi, EMPRESA_B, 70_000);

  const r = await request(app).get('/api/negocios/resumo').set('Authorization', `Bearer ${multi.token}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.filtros.empresa_id, EMPRESA_A, "empresa ativa = padrão do usuário");
  assert.equal(r.body.kpis.faturamentoCents, 10_000, 'não soma a B (70.000)');
});

test('C) ?consolidado=1 SEM pode_consolidar NÃO consolida', async () => {
  const { multi } = await prepararAtores();
  const r = await request(app).get('/api/negocios/resumo?consolidado=1').set('Authorization', `Bearer ${multi.token}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.filtros.empresa_id, EMPRESA_A, "continua na empresa ativa");
  assert.equal(r.body.kpis.faturamentoCents, 10_000);
});

test('C) sem empresa_id, ABC também fica na empresa ativa (não mistura as empresas)', async () => {
  const { multi } = await prepararAtores();
  const r = await request(app).get('/api/negocios/abc').set('Authorization', `Bearer ${multi.token}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.filtros.empresa_id, EMPRESA_A);
  assert.ok(r.body.linhas.every((l: any) => Number(l.empresaId) === EMPRESA_A), 'nenhuma linha da B');
});

test('C) troca de empresa ativa na sessão muda o recorte padrão — sem consolidar', async () => {
  __reiniciarMemoriaNegocios();
  const { ana, multi } = await prepararAtores();
  await venderPela(ana, EMPRESA_A, 10_000);
  await venderPela(multi, EMPRESA_B, 70_000);

  const troca = await request(app).post('/api/empresas/ativa').set('Authorization', `Bearer ${multi.token}`).send({ empresa_id: EMPRESA_B });
  assert.equal(troca.status, 200);
  const r = await request(app).get('/api/negocios/resumo').set('Authorization', `Bearer ${troca.body.token}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.filtros.empresa_id, EMPRESA_B);
  assert.equal(r.body.kpis.faturamentoCents, 70_000, 'agora vê a B, e só a B');
});

test('C) empresa_id explícito tem precedência sobre a empresa ativa, e exige concessão', async () => {
  const { multi } = await prepararAtores();
  const ok = await request(app).get(`/api/negocios/resumo?empresa_id=${EMPRESA_B}`).set('Authorization', `Bearer ${multi.token}`);
  assert.equal(ok.status, 200);
  assert.equal(ok.body.filtros.empresa_id, EMPRESA_B);

  const negada = await request(app).get(`/api/negocios/resumo?empresa_id=${EMPRESA_C}`).set('Authorization', `Bearer ${multi.token}`);
  assert.equal(negada.status, 403);
});

test('C) consolidação só com pode_consolidar + ?consolidado=1 (privilégio explícito, leitura)', async () => {
  __reiniciarMemoriaNegocios();
  const { ana, auditor } = await prepararAtores();
  await venderPela(ana, EMPRESA_A, 10_000);
  await venderPela(auditor, EMPRESA_B, 70_000);

  const r = await request(app).get('/api/negocios/resumo?consolidado=1').set('Authorization', `Bearer ${auditor.token}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.filtros.empresa_id, null, "consolidado: sem recorte de empresa");
  assert.equal(r.body.kpis.faturamentoCents, 80_000, 'soma das empresas concedidas ao auditor');
});

test('C) venda sem empresa_id no corpo é gravada na empresa ativa, nunca na 1 por padrão fixo', async () => {
  __reiniciarMemoriaNegocios();
  const multi = await prepararAtores().then((a) => a.multi);
  const troca = await request(app).post('/api/empresas/ativa').set('Authorization', `Bearer ${multi.token}`).send({ empresa_id: EMPRESA_B });
  const r = await venderPela({ ...multi, token: troca.body.token }, null, 3_000);
  assert.equal(r.status, 201);
  assert.equal(r.body.venda.empresaId, EMPRESA_B);
});

// ----------------------------------------------------------------------------
// Sem autenticação: nada
// ----------------------------------------------------------------------------

test('sem token, nenhuma leitura de BI responde dados', async () => {
  const r = await request(app).get(`/api/negocios/resumo?empresa_id=${EMPRESA_A}`);
  assert.equal(r.status, 401);
  assert.equal(r.body.kpis, undefined);
});
