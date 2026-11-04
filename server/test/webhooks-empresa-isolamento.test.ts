// R-14 (Ordem integral, Fase 4.3) — webhooks de saída associados à empresa.
// LOCAL: store em memória; sem rede (a entrega real não é exercitada aqui: os alvos e a leitura são testados
// diretamente). Regras: evento de empresa só vai para webhook da mesma empresa; evento sem empresa só para
// webhook global; webhook de outra empresa é invisível (404); entrega só aparece para a empresa dona.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
process.env.NODE_ENV = 'test';
delete process.env.DATABASE_URL;

const W: any = await import('../src/webhooks');
const { getStore } = await import('../src/services');
const { getResource } = await import('../src/resources');
const { registrarReautenticacao } = await import('../src/auth');
const s: any = getStore();
const ler = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

function resDe() {
  const r: any = { statusCode: 200, body: undefined };
  r.status = (c: number) => { r.statusCode = c; return r; };
  r.json = (b: unknown) => { r.body = b; return r; };
  return r;
}
async function chamar(fn: (req: any, res: any) => unknown, req: any) {
  const res = resDe();
  try { await fn(req, res); return { res, erro: null as any, status: res.statusCode }; }
  catch (e: any) { return { res, erro: e, status: e?.status ?? res.statusCode }; }
}

const sufixo = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
const empA = 9000 + Math.floor(Math.random() * 500);
const empB = empA + 1;
const adminA = { id: 501, name: 'Adm A', perfil: 'admin', email: `adm-a.${sufixo}@teste.local`, empresa_id: empA };
const adminB = { id: 502, name: 'Adm B', perfil: 'admin', email: `adm-b.${sufixo}@teste.local`, empresa_id: empB };
const EVT = 'usuario.criado';

let wA: any, wB: any, wG: any, eA: any, eB: any, eLegado: any;
async function cenario() {
  if (wA) return;
  wA = await s.insert(W.R_WEBHOOKS, { nome: `WH-A-${sufixo}`, url: 'https://a.exemplo.test/h', eventos: JSON.stringify([EVT]), ativo: true, segredo_cifrado: 'x', empresa_id: empA } as any);
  wB = await s.insert(W.R_WEBHOOKS, { nome: `WH-B-${sufixo}`, url: 'https://b.exemplo.test/h', eventos: JSON.stringify([EVT]), ativo: true, segredo_cifrado: 'x', empresa_id: empB } as any);
  wG = await s.insert(W.R_WEBHOOKS, { nome: `WH-G-${sufixo}`, url: 'https://g.exemplo.test/h', eventos: JSON.stringify([EVT, 'usuario.ativado']), ativo: true, segredo_cifrado: 'x' } as any);
  eA = await s.insert(W.R_ENTREGAS, { webhook_id: Number(wA.id), evento: `EV-A-${sufixo}`, payload: '{}', estado: 'ok', tentativas: 1, empresa_id: empA, concluida_em: new Date().toISOString() } as any);
  eB = await s.insert(W.R_ENTREGAS, { webhook_id: Number(wB.id), evento: `EV-B-${sufixo}`, payload: '{}', estado: 'ok', tentativas: 1, empresa_id: empB, concluida_em: new Date().toISOString() } as any);
  // Entrega legada: webhook global, sem empresa. Pode conter dados de qualquer empresa (recebia tudo antes).
  eLegado = await s.insert(W.R_ENTREGAS, { webhook_id: Number(wG.id), evento: `EV-LEGADO-${sufixo}`, payload: '{}', estado: 'ok', tentativas: 1, concluida_em: new Date().toISOString() } as any);
}

test('alvos: evento de uma empresa vai só para webhooks dessa empresa (não para B, nem para global)', async () => {
  await cenario();
  assert.equal(typeof W.alvosDoEvento, 'function', 'alvosDoEvento exportada');
  const ids = (await W.alvosDoEvento(EVT, empA)).map((w: any) => Number(w.id));
  assert.ok(ids.includes(Number(wA.id)), 'webhook de A recebe evento de A');
  assert.equal(ids.includes(Number(wB.id)), false, 'webhook de B NÃO recebe evento de A');
  assert.equal(ids.includes(Number(wG.id)), false, 'webhook global NÃO recebe dados de empresa');
});

test('alvos: evento sem empresa vai só para webhooks globais', async () => {
  await cenario();
  const ids = (await W.alvosDoEvento('usuario.ativado', undefined)).map((w: any) => Number(w.id));
  assert.ok(ids.includes(Number(wG.id)), 'global recebe evento global');
  assert.equal(ids.includes(Number(wA.id)), false, 'webhook de A não recebe evento sem empresa');
  assert.equal(ids.includes(Number(wB.id)), false, 'webhook de B não recebe evento sem empresa');
});

test('alvos: webhook inativo não recebe', async () => {
  await cenario();
  const inativo = await s.insert(W.R_WEBHOOKS, { nome: `WH-OFF-${sufixo}`, url: 'https://o.exemplo.test/h', eventos: JSON.stringify([EVT]), ativo: false, segredo_cifrado: 'x', empresa_id: empA } as any);
  const ids = (await W.alvosDoEvento(EVT, empA)).map((w: any) => Number(w.id));
  assert.equal(ids.includes(Number(inativo.id)), false);
});

test('listar: admin de A vê só webhooks de A (nem globais, nem de B)', async () => {
  await cenario();
  const r = await chamar(W.listarWebhooks, { user: adminA, query: {}, params: {}, headers: {}, body: {} });
  assert.equal(r.status, 200);
  const txt = JSON.stringify(r.res.body);
  assert.ok(txt.includes(`WH-A-${sufixo}`), 'webhook de A listado');
  assert.equal(txt.includes(`WH-G-${sufixo}`), false, 'webhook global NÃO listado para empresa (fora de escopo)');
  assert.equal(txt.includes(`WH-B-${sufixo}`), false, 'webhook de B NÃO listado para A');
});

test('gerenciar: admin de A não altera, exclui, testa nem reenvia webhook de B (404)', async () => {
  await cenario();
  registrarReautenticacao(adminA.id);
  const up = await chamar(W.atualizarWebhook, { user: adminA, params: { id: String(wB.id) }, body: { nome: 'X' }, query: {}, headers: {} });
  assert.equal(up.status, 404, 'atualizar: 404');
  const del = await chamar(W.excluirWebhook, { user: adminA, params: { id: String(wB.id) }, body: {}, query: {}, headers: {} });
  assert.equal(del.status, 404, 'excluir: 404');
  const teste = await chamar(W.testarWebhook, { user: adminA, params: { id: String(wB.id) }, body: {}, query: {}, headers: {} });
  assert.equal(teste.status, 404, 'testar: 404');
  const reenv = await chamar(W.reenviarEntrega, { user: adminA, params: { id: String(eB.id) }, body: {}, query: {}, headers: {} });
  assert.equal(reenv.status, 404, 'reenviar entrega de B: 404');
  // Nada mudou na linha de B.
  const atual = await s.findOneWhere(W.R_WEBHOOKS, { id: Number(wB.id) });
  assert.equal(atual.nome, `WH-B-${sufixo}`, 'webhook de B preservado');
});

test('entregas: admin de A vê só entregas de A; entrega legada sem empresa fica oculta', async () => {
  await cenario();
  const ver = (w: any) => chamar(W.listarEntregas, { user: adminA, params: { id: String(w.id) }, query: {}, body: {}, headers: {} });
  const dea = await ver(wA);
  assert.equal(dea.status, 200);
  assert.ok(JSON.stringify(dea.res.body).includes(`EV-A-${sufixo}`), 'entrega de A aparece');
  const deb = await ver(wB);
  assert.equal(deb.status, 404, 'entregas do webhook de B: 404 para A');
  const deg = await ver(wG);
  assert.equal(deg.status, 404, 'webhook global fora do escopo: 404');
  assert.equal(JSON.stringify(deg.res.body ?? {}).includes(`EV-LEGADO-${sufixo}`), false, 'entrega legada sem empresa NÃO aparece');
});

test('criação: o webhook recebe a empresa do administrador, nunca a que vier no corpo', async () => {
  await cenario();
  registrarReautenticacao(adminA.id);
  const r = await chamar(W.criarWebhook, { user: adminA, params: {}, query: {}, headers: {}, body: { nome: `NOVO-${sufixo}`, url: 'https://n.exemplo.test/h', eventos: [EVT], empresa_id: empB } });
  assert.equal(r.status, 201, `criado (status ${r.status}: ${r.erro?.message ?? ''})`);
  const row = await s.findOneWhere(W.R_WEBHOOKS, { nome: `NOVO-${sufixo}` });
  assert.equal(Number(row.empresa_id), empA, 'empresa do admin A, não B');
});

test('migração 0097: colunas empresa_id nullable nas duas tabelas e sem backfill', () => {
  const sql = ler('../../db/migrations/0097_webhooks_empresa.sql');
  assert.match(sql, /ALTER TABLE webhooks ADD COLUMN IF NOT EXISTS empresa_id INTEGER NULL/i);
  assert.match(sql, /ALTER TABLE webhook_entregas ADD COLUMN IF NOT EXISTS empresa_id INTEGER NULL/i);
  assert.equal(/NOT NULL/i.test(sql.replace(/--.*$/gm, '')), false, 'nenhuma coluna NOT NULL');
  assert.equal(/\bUPDATE\b/i.test(sql.replace(/--.*$/gm, '')), false, 'nenhum backfill automático');
});

test('entrega registra a empresa do webhook que a gerou (contrato de gravação)', () => {
  const src = ler('../src/webhooks.ts');
  const i = src.indexOf('export async function entregar(');
  const trecho = src.slice(i, src.indexOf('\n}\n', i));
  assert.match(trecho, /empresa_id:\s*(webhook\.empresa_id|empresaDoWebhook)/, 'entrega grava empresa_id');
});

test('contexto: empresa do evento vem da sessão do ator; sem empresa única = global (undefined)', async () => {
  assert.equal(W.empresaDoContexto(adminA), empA, 'admin de A → empresa A');
  assert.equal(W.empresaDoContexto({ ...adminA, empresa_id: 0 }), undefined, 'sem vínculo: não infere empresa padrão');
  assert.equal(W.empresaDoContexto({ ...adminA, empresa_id: undefined }), undefined, 'sem empresa_id: não infere');
  assert.equal(W.empresaDoContexto({ ...adminA, consolidar: true, pode_consolidar: true }), undefined, 'consolidado: ambíguo, global');
  assert.equal(W.empresaDoContexto(null), undefined, 'sem ator');
});

test('contexto: payload com empresa_id não altera a empresa do evento', async () => {
  // O evento de usuário é associado pelo contexto do ator; o corpo/payload não entra na decisão.
  const dados = { usuario_id: 1, empresa_id: empB, email: `x.${sufixo}@teste.local` };
  const alvo = W.empresaDoContexto(adminA);
  assert.equal(alvo, empA);
  assert.notEqual(alvo, dados.empresa_id);
});
