// ============================================================================
// ERP-01 — WEBHOOK DE PAGAMENTO CONTRA POSTGRESQL REAL (fecha o P0-02).
//
// O que o modo demonstração NÃO tinha como provar e este arquivo prova:
//
//   • `gateway_webhook_events.payload` é JSONB: o driver entrega OBJETO. A
//     leitura com `JSON.parse(String(payload))` produzia "[object Object]",
//     nenhum `provider_ref` era encontrado e TODO webhook de pagamento legítimo
//     terminava em 'ignorado' com a cobrança presa em 'pendente';
//   • a notificação repetida responde `duplicado: true` (200) — antes a
//     inserção batia no índice único `uq_gateway_webhook_evento` e o endpoint
//     PÚBLICO devolvia 202 com o NOME DA CONSTRAINT no corpo;
//   • notificação anterior 'ignorado' (assinatura inválida ou evento sem
//     efeito) é REAPROVEITADA no retry legítimo — uma linha por evento, sem
//     envenenar o índice único;
//   • pagamento confirma a cobrança e baixa o título UMA vez (idempotência no
//     banco, não na memória);
//   • nenhuma resposta de endpoint anônimo carrega nome de tabela, coluna ou
//     constraint.
//
// O caminho exercitado é HTTP real (servidor de verdade, corpo cru sem
// express.json) → rota pública → processarEvento → PgStore → PostgreSQL.
// Sem DATABASE_URL este arquivo FALHA: a prova deste ciclo é PostgreSQL.
// ============================================================================
import assert from 'node:assert/strict';
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { createHmac, randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import type { Readable } from 'node:stream';
import { test } from 'node:test';

if (!process.env.DATABASE_URL) {
  throw new Error('e01-gateway-webhook-postgresql.test.ts exige DATABASE_URL e PostgreSQL real; não é permitido pular esta prova.');
}

process.env.NODE_ENV = 'test';
// A chave dos segredos de integração precisa ser a MESMA no processo de teste
// (que cifra o segredo do webhook) e no servidor spawnado (que o decifra).
process.env.SEGREDOS_ENCRYPTION_KEY = process.env.SEGREDOS_ENCRYPTION_KEY || 'erp01-segredos-de-teste';

const { migrate, query } = await import('../../src/db');
await migrate();
const { RESOURCES } = await import('../../src/resources');
const { getStore } = await import('../../src/services');
const { R_GATEWAY_COBRANCAS, R_GATEWAY_CONFIGS, R_GATEWAY_WEBHOOK_EVENTS } = await import('../../src/gateway');
const { cifrarSegredo } = await import('../../src/segredos');

const SERVER_DIR = fileURLToPath(new URL('../../', import.meta.url));
type Child = ChildProcessByStdio<null, Readable, Readable>;

const RODADA = `e01${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
let contador = 0;
const unico = (prefixo: string) => `${prefixo}-${RODADA}-${++contador}`;

/** Todo corpo de resposta passa por aqui: nenhum pode expor o schema. */
const corposPublicos: string[] = [];
const LEAK = /constraint|duplicate key|SQLSTATE|violates|relation "|column "|gateway_|pg_/i;
function semVazamento(texto: string, contexto: string): void {
  corposPublicos.push(`${contexto}: ${texto}`);
  assert.ok(!LEAK.test(texto), `${contexto}: resposta anônima vazou detalhe de banco → ${texto.slice(0, 300)}`);
}

async function reservePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Não foi possível reservar porta TCP para o harness.');
  const port = address.port;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function startRealServer(port: number): Promise<{ child: Child; baseUrl: string; logs: () => string }> {
  const env: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: 'test', PORT: String(port) };
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], { cwd: SERVER_DIR, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  const append = (chunk: string | Buffer) => { output = `${output}${String(chunk)}`.slice(-40_000); };
  child.stdout.on('data', append);
  child.stderr.on('data', append);
  const baseUrl = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`O servidor encerrou antes do health check.\n${output}`);
    try {
      const r = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(1_000) });
      if (r.ok) {
        const h = await r.json() as { ok?: boolean; db?: string };
        if (h.ok === true && h.db === 'postgres') return { child, baseUrl, logs: () => output };
      }
    } catch {
      // bootstrap/migrations em andamento
    }
    await delay(200);
  }
  throw new Error(`Health check não confirmou db=postgres em 90 s.\n${output}`);
}

async function stopServer(child: Child): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    const t = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 5_000);
    child.once('exit', () => { clearTimeout(t); resolve(); });
    child.kill('SIGTERM');
  });
}

type RespostaWebhook = { status: number; body: any; texto: string };

async function enviarWebhook(baseUrl: string, corpo: string, headers: Record<string, string> = {}): Promise<RespostaWebhook> {
  const r = await fetch(`${baseUrl}/api/gateway/webhooks/mock`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: corpo,
  });
  const texto = await r.text();
  let body: any = null;
  try { body = JSON.parse(texto); } catch { body = null; }
  return { status: r.status, body, texto };
}

// ---------------------------------------------------------------------------
// Fixtures — criados DIRETO no store (PgStore). O alvo do teste é a rota
// pública do webhook, não a criação da cobrança.
// ---------------------------------------------------------------------------

type Tenant = { empresaId: number; refCobranca: string; cobrancaId: number; lancamentoId: number; configId: number };

/** Configs criadas nesta rodada — removidas no fim para não contaminar a próxima execução. */
const configsDaRodada: number[] = [];

async function novoTenant(opcoes: { comSegredo?: boolean } = {}): Promise<Tenant> {
  const s = getStore();
  const empresa = await query<{ id: number }>(
    `INSERT INTO empresas (nome, razao_social, ativo) VALUES ($1, $2, true) RETURNING id`,
    [unico('Empresa E01'), unico('Empresa E01')],
  );
  const empresaId = Number(empresa.rows[0].id);

  const config = await s.insert(R_GATEWAY_CONFIGS, {
    empresa_id: empresaId,
    provider: 'mock',
    ambiente: 'teste',
    ativo: true,
    credenciais_cifradas: cifrarSegredo(JSON.stringify({ fake: 'cred' })),
    ...(opcoes.comSegredo ? { webhook_segredo_cifrado: cifrarSegredo(SEGREDO_WEBHOOK) } : {}),
  });
  configsDaRodada.push(Number(config!.id));

  const lancamento = await s.insert(RESOURCES.lancamentos_financeiros, {
    empresa_id: empresaId,
    data: new Date().toISOString().slice(0, 10),
    tipo: 'receita',
    descricao: unico('Título E01'),
    valor: 120,
    status: 'pendente',
    referencia_tipo: 'outro',
  });

  const refCobranca = unico('mock-e01');
  const cobranca = await s.insert(R_GATEWAY_COBRANCAS, {
    empresa_id: empresaId,
    provider: 'mock',
    metodo: 'pix',
    lancamento_id: Number(lancamento!.id),
    valor: 120,
    status: 'pendente',
    provider_ref: refCobranca,
    idempotency_key: refCobranca,
  });

  return { empresaId, refCobranca, cobrancaId: Number(cobranca!.id), lancamentoId: Number(lancamento!.id), configId: Number(config!.id) };
}

/**
 * A validação de assinatura varre TODAS as configs do provedor (sem filtro de
 * empresa): enquanto uma config com segredo existir no banco, webhook não
 * assinado de QUALQUER empresa é recusado com 401. Isso é o defeito P1-11
 * (documentado em docs/RELATORIO-ERP-ONLY.md) e é a razão de os cenários sem
 * assinatura rodarem antes do cenário assinado — e das configs serem removidas
 * no fim (limpeza também para a próxima execução da suíte).
 */
async function limparConfigsDaRodada(): Promise<void> {
  const s = getStore();
  for (const id of configsDaRodada.splice(0)) {
    await s.remove(R_GATEWAY_CONFIGS, id).catch(() => undefined);
  }
}

/** Segredo suspenso para isolar a prova do P1-11 — restaurado ao final. */
type SegredoSuspenso = { id: number; valor: string };

async function suspenderSegredosExistentes(): Promise<SegredoSuspenso[]> {
  const linhas = await query<{ id: number; webhook_segredo_cifrado: string }>(
    `SELECT id, webhook_segredo_cifrado FROM gateway_configs WHERE webhook_segredo_cifrado IS NOT NULL`,
  );
  if (linhas.rows.length) {
    await query(`UPDATE gateway_configs SET webhook_segredo_cifrado = NULL WHERE webhook_segredo_cifrado IS NOT NULL`);
  }
  return linhas.rows.map((r) => ({ id: Number(r.id), valor: r.webhook_segredo_cifrado }));
}

async function restaurarSegredos(suspensos: SegredoSuspenso[]): Promise<void> {
  for (const item of suspensos) {
    await query(`UPDATE gateway_configs SET webhook_segredo_cifrado = $2 WHERE id = $1`, [item.id, item.valor]).catch(() => undefined);
  }
}

const SEGREDO_WEBHOOK = `segredo-e01-${RODADA}`;

async function eventosDoEvento(t: Tenant, eventoId: string): Promise<any[]> {
  const s = getStore();
  const r = await s.list(R_GATEWAY_WEBHOOK_EVENTS, { page: 1, pageSize: 20, filter: { provider: 'mock', evento_id: eventoId } });
  void t;
  return r.rows;
}

async function filhosDaBaixa(lancamentoId: number): Promise<number> {
  const r = await query<{ total: string }>(
    `SELECT count(*)::text AS total FROM lancamentos_financeiros WHERE referencia_tipo = 'baixa' AND referencia_id = $1`,
    [lancamentoId],
  );
  return Number(r.rows[0].total);
}

// ---------------------------------------------------------------------------

test('ERP-01: webhook de pagamento processa em PostgreSQL, é idempotente e não vaza schema', async (t) => {
  const s = getStore();
  // Enquanto o P1-11 existir (assinatura varre TODAS as configs do provedor,
  // sem empresa), um segredo residual de qualquer execução anterior recusaria
  // as notificações não assinadas desta prova. Os segredos pré-existentes são
  // suspensos aqui e restaurados no fim — a prova fica isolada do estado.
  const suspensos = await suspenderSegredosExistentes();
  t.after(async () => restaurarSegredos(suspensos));
  const porta = await reservePort();
  const { child, baseUrl, logs } = await startRealServer(porta);
  t.after(async () => stopServer(child));
  t.after(async () => limparConfigsDaRodada());
  void logs;

  // ---------------------------------------------------------------- A) pagamento
  const a = await novoTenant();
  const eventoA = unico('evt-pago');
  const corpoA = JSON.stringify({ event: 'payment.paid', event_id: eventoA, data: { id: a.refCobranca }, status: 'pago' });

  const w1 = await enviarWebhook(baseUrl, corpoA);
  semVazamento(w1.texto, 'A: 1ª notificação');
  assert.equal(w1.status, 200, `1ª notificação deveria ser 200; veio ${w1.status} ${w1.texto}`);
  assert.equal(w1.body?.processado, true, `evento de pagamento precisa ser processado: ${w1.texto}`);
  assert.equal(w1.body?.resultado, 'paga', `intenção resolvida deveria ser 'paga': ${w1.texto}`);

  const cobrancaA = await s.get(R_GATEWAY_COBRANCAS, a.cobrancaId);
  assert.equal(cobrancaA!.status, 'paga', 'a cobrança precisa sair de pendente — era o defeito P0-02');
  const tituloA = await s.get(RESOURCES.lancamentos_financeiros, a.lancamentoId);
  assert.equal(tituloA!.status, 'confirmado', 'o título do lançamento precisa ser baixado pelo webhook');
  assert.match(String(tituloA!.observacoes), /webhook/i, 'a baixa precisa registrar a origem webhook');

  const eventosA = await eventosDoEvento(a, eventoA);
  assert.equal(eventosA.length, 1, `um único evento persistido por (provider, evento_id); veio ${eventosA.length}`);
  assert.equal(eventosA[0].status, 'processado');
  assert.equal(Number(eventosA[0].empresa_id), a.empresaId, 'o evento precisa ser atribuído à empresa da cobrança');

  // A coluna é JSONB de verdade: o payload precisa ser OBJETO consultável
  // (`payload->>'event_id'`), não uma string com JSON dentro.
  const forma = await query<{ tipo: string; evento_id: string | null }>(
    `SELECT jsonb_typeof(payload) AS tipo, payload->>'event_id' AS evento_id FROM gateway_webhook_events WHERE id = $1`,
    [Number(eventosA[0].id)],
  );
  assert.equal(forma.rows[0].tipo, 'object', 'payload precisa estar gravado como objeto JSONB');
  assert.equal(forma.rows[0].evento_id, eventoA, 'o payload precisa ser consultável por chave (->>)');

  // Mesma notificação de novo: duplicata explícita, sem segunda baixa.
  const w2 = await enviarWebhook(baseUrl, corpoA);
  semVazamento(w2.texto, 'A: 2ª notificação idêntica');
  assert.equal(w2.status, 200, `notificação repetida deveria ser 200; veio ${w2.status} ${w2.texto}`);
  assert.equal(w2.body?.duplicado, true, `notificação repetida precisa responder duplicado:true — ${w2.texto}`);
  assert.equal((await eventosDoEvento(a, eventoA)).length, 1, 'a repetida não pode criar segunda linha de evento');
  assert.equal(await filhosDaBaixa(a.lancamentoId), 0, 'baixa total não pode gerar título filho');
  const tituloDepois = await s.get(RESOURCES.lancamentos_financeiros, a.lancamentoId);
  // Cada baixa acrescenta exatamente uma linha "Baixa em ..." — a segunda
  // notificação não pode acrescentar nenhuma.
  assert.equal((String(tituloDepois!.observacoes).match(/Baixa em /g) || []).length, 1, 'a baixa não pode ser aplicada duas vezes');

  // ------------------------------------------------- B) ignorado → retry legítimo
  const b = await novoTenant();
  const eventoB = unico('evt-retry');
  const semEfeito = await enviarWebhook(baseUrl, JSON.stringify({ event: 'payment.updated', event_id: eventoB, data: { id: b.refCobranca }, status: 'aguardando' }));
  semVazamento(semEfeito.texto, 'B: evento sem efeito');
  assert.equal(semEfeito.status, 200);
  assert.equal(semEfeito.body?.resultado, 'ignorado', `evento sem efeito financeiro é ignorado: ${semEfeito.texto}`);
  assert.equal(semEfeito.body?.processado, false, 'evento ignorado NÃO pode ser anunciado como processado');
  const eventosBIgnorado = await eventosDoEvento(b, eventoB);
  assert.equal(eventosBIgnorado.length, 1);
  assert.equal(eventosBIgnorado[0].status, 'ignorado');
  assert.equal((await s.get(R_GATEWAY_COBRANCAS, b.cobrancaId))!.status, 'pendente', 'ignorado não muda a cobrança');

  // Retry do provedor para o MESMO evento_id, agora com status de pagamento:
  // precisa processar (reaproveitando a linha ignorada) — antes batia no índice
  // único e o endpoint público devolvia 202 com o nome da constraint.
  const retry = await enviarWebhook(baseUrl, JSON.stringify({ event: 'payment.paid', event_id: eventoB, data: { id: b.refCobranca }, status: 'pago' }));
  semVazamento(retry.texto, 'B: retry legítimo');
  assert.equal(retry.status, 200, `retry legítimo deveria ser 200; veio ${retry.status} ${retry.texto}`);
  assert.notEqual(retry.body?.duplicado, true, 'retry de evento ignorado não é duplicata — precisa processar');
  assert.equal(retry.body?.resultado, 'paga', `retry precisa confirmar o pagamento: ${retry.texto}`);
  const eventosBDepois = await eventosDoEvento(b, eventoB);
  assert.equal(eventosBDepois.length, 1, `retry não pode criar segunda linha para o mesmo evento; veio ${eventosBDepois.length}`);
  assert.equal(eventosBDepois[0].status, 'processado');
  assert.equal((await s.get(R_GATEWAY_COBRANCAS, b.cobrancaId))!.status, 'paga', 'o retry precisa confirmar a cobrança');

  // ------------------------------------------------- D) corrida: duas entregas iguais
  const d = await novoTenant();
  const eventoD = unico('evt-corrida');
  const corpoD = JSON.stringify({ event: 'payment.paid', event_id: eventoD, data: { id: d.refCobranca }, status: 'pago' });
  const [c1, c2] = await Promise.all([enviarWebhook(baseUrl, corpoD), enviarWebhook(baseUrl, corpoD)]);
  semVazamento(c1.texto, 'D: entrega concorrente 1');
  semVazamento(c2.texto, 'D: entrega concorrente 2');
  for (const [i, r] of [c1, c2].entries()) {
    assert.equal(r.status, 200, `entrega concorrente ${i + 1} precisa ser 200 (duplicata é resposta válida); veio ${r.status} ${r.texto}`);
    assert.equal(r.body?.ok, true, `entrega concorrente ${i + 1} precisa ack ok: ${r.texto}`);
  }
  const eventosD = await eventosDoEvento(d, eventoD);
  assert.equal(eventosD.length, 1, `concorrência não pode duplicar o evento; linhas=${eventosD.length}`);
  assert.equal(eventosD[0].status, 'processado');
  assert.equal((await s.get(R_GATEWAY_COBRANCAS, d.cobrancaId))!.status, 'paga');
  const tituloD = await s.get(RESOURCES.lancamentos_financeiros, d.lancamentoId);
  assert.equal(tituloD!.status, 'confirmado');
  assert.equal(await filhosDaBaixa(d.lancamentoId), 0, 'uma única baixa, mesmo com duas entregas simultâneas');

  // ------------------------------------------------- C) assinatura inválida → retry assinado
  // (por último entre os cenários sem assinatura: a config com segredo desta
  //  empresa passa a exigir assinatura também das outras — P1-11.)
  const c = await novoTenant({ comSegredo: true });
  const eventoC = unico('evt-assinado');
  const corpoSemAssinatura = JSON.stringify({ event: 'payment.paid', event_id: eventoC, data: { id: c.refCobranca }, status: 'pago' });
  const recusado = await enviarWebhook(baseUrl, corpoSemAssinatura);
  semVazamento(recusado.texto, 'C: sem assinatura');
  assert.equal(recusado.status, 401, `sem assinatura precisa ser 401; veio ${recusado.status} ${recusado.texto}`);
  const eventosC = await eventosDoEvento(c, eventoC);
  assert.equal(eventosC.length, 1, 'a rejeição precisa ficar registrada para auditoria');
  assert.equal(eventosC[0].status, 'ignorado');
  assert.equal(eventosC[0].assinatura_ok, false);

  const assinatura = createHmac('sha256', SEGREDO_WEBHOOK).update(corpoSemAssinatura, 'utf8').digest('hex');
  const aceito = await enviarWebhook(baseUrl, corpoSemAssinatura, { 'x-mock-signature': assinatura });
  semVazamento(aceito.texto, 'C: retry assinado');
  assert.equal(aceito.status, 200, `retry assinado deveria ser 200; veio ${aceito.status} ${aceito.texto}`);
  assert.equal(aceito.body?.resultado, 'paga', `retry assinado precisa confirmar o pagamento: ${aceito.texto}`);
  const eventosCDepois = await eventosDoEvento(c, eventoC);
  assert.equal(eventosCDepois.length, 1, `a rejeição anterior não pode bloquear o retry legítimo; linhas=${eventosCDepois.length}`);
  assert.equal(eventosCDepois[0].status, 'processado');
  assert.equal(eventosCDepois[0].assinatura_ok, true);
  assert.equal((await s.get(R_GATEWAY_COBRANCAS, c.cobrancaId))!.status, 'paga');

  // ------------------------------------------------- E) o coletor de vazamentos
  assert.ok(corposPublicos.length >= 8, 'as respostas públicas precisam ter sido inspecionadas');
});

test('ERP-01: o payload JSONB é lido nos dois formatos (objeto e string)', async () => {
  // Guarda de unidade da causa-raiz: a leitura não pode depender do tipo que o
  // driver devolveu. Sem isto, uma futura mudança de driver reintroduz o P0-02.
  const { lerPayloadWebhook, payloadParaArmazenar } = await import('../../src/gateway');
  const corpo = JSON.stringify({ event: 'payment.paid', data: { id: 'mock-x' }, status: 'pago' });

  assert.deepEqual(lerPayloadWebhook(JSON.parse(corpo)), JSON.parse(corpo), 'objeto (JSONB via driver) precisa ser lido');
  assert.deepEqual(lerPayloadWebhook(corpo), JSON.parse(corpo), 'string JSON (demonstração/registro antigo) precisa ser lida');
  assert.deepEqual(lerPayloadWebhook(Buffer.from(corpo)), JSON.parse(corpo), 'Buffer precisa ser lido');
  assert.deepEqual(lerPayloadWebhook(null), {}, 'nulo vira objeto vazio');
  assert.deepEqual(lerPayloadWebhook('[object Object]'), {}, 'texto inválido não vira lixo');
  assert.deepEqual(lerPayloadWebhook(''), {});

  assert.deepEqual(payloadParaArmazenar(corpo), JSON.parse(corpo), 'corpo JSON é gravado como objeto');
  assert.deepEqual(payloadParaArmazenar('a=1&b=2').bruto, 'a=1&b=2', 'corpo não-JSON é preservado no envelope');
});

// ============================================================================
// P1-11 (registrado nesta prova, NÃO corrigido em ERP-01) — ESCOPO DA ASSINATURA
//
// A validação de assinatura do webhook varre TODAS as configs do provedor
// (`s.list(R_GATEWAY_CONFIGS, { filter: { provider } })`, sem `empresa_id`):
// basta UMA empresa ter segredo configurado para que notificações de TODAS as
// empresas passem a exigir assinatura — e a notificação legítima de quem não
// configurou segredo é recusada com 401. O caminho inverso também impressiona:
// a assinatura validada marca `empresaId` da config que a aceitou, e o evento
// pode ficar atribuído a uma empresa diferente da dona da cobrança.
//
// O teste abaixo descreve o comportamento CORRETO e está marcado como `todo`
// (falha esperada) até o ciclo que decidir o escopo multiempresa do endpoint.
// ============================================================================
test('ERP-01/P1-11: segredo de UMA empresa não pode recusar webhook de OUTRA', { todo: 'P1-11 — assinatura global por provedor (sem empresa); correção depende da decisão de escopo multiempresa' }, async (t) => {
  const s = getStore();
  const porta = await reservePort();
  const { child, baseUrl } = await startRealServer(porta);
  t.after(async () => stopServer(child));
  t.after(async () => limparConfigsDaRodada());

  const comSegredo = await novoTenant({ comSegredo: true });
  const semSegredo = await novoTenant();
  assert.ok(comSegredo.empresaId !== semSegredo.empresaId);

  const evento = unico('evt-outra-empresa');
  const corpo = JSON.stringify({ event: 'payment.paid', event_id: evento, data: { id: semSegredo.refCobranca }, status: 'pago' });
  const resposta = await enviarWebhook(baseUrl, corpo);
  semVazamento(resposta.texto, 'P1-11: webhook de empresa sem segredo');
  assert.equal(resposta.status, 200, `a empresa que não configurou segredo não pode ser recusada por causa de outra; veio ${resposta.status} ${resposta.texto}`);
  assert.equal(resposta.body?.resultado, 'paga');
  assert.equal((await s.get(R_GATEWAY_COBRANCAS, semSegredo.cobrancaId))!.status, 'paga');
});
