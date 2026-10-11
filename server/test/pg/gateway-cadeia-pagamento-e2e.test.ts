// ============================================================================
// ERP-01 — A CADEIA INTEIRA DO PAGAMENTO, POR HTTP AUTENTICADO, EM POSTGRESQL.
//
// O arquivo `e01-gateway-webhook-postgresql.test.ts` prova a ROTA PÚBLICA do
// webhook (idempotência, payload JSONB, vazamento, concorrência) com as
// fixtures criadas direto no store. Este arquivo prova o que faltava para
// fechar a cadeia da especificação do ERP-01:
//
//   PAGAMENTO  → título criado por HTTP (sessão real de gerente no PostgreSQL)
//   COBRANÇA   → POST /api/financeiro/gateway/cobrancas (PIX do provedor mock)
//   WEBHOOK    → notificação ASSINADA (HMAC) na rota pública anônima
//   RECEBIMENTO→ cobrança 'paga' + título 'confirmado' + UMA única baixa
//   CONCILIAÇÃO→ leitura autenticada: cobrança paga, evento 'processado'
//                ligado à cobrança e à empresa, e nenhum payload bruto exposto
//
// Nada aqui é memória, mock de store ou chamada direta a handler: o processo
// do servidor é real (`src/index.ts`), o login é HTTP, o JWT é de sessão e o
// banco é PostgreSQL (o arquivo FALHA sem DATABASE_URL).
//
// A única fixture que não passa por HTTP é a CONFIGURAÇÃO do provedor: a rota
// `PUT /api/financeiro/gateway/config` exige administrador + reautenticação por
// senha (+ MFA quando ativo), superfície já coberta pelo smoke (que faz esse
// caminho com admin real). A configuração não é parte da cadeia do pagamento —
// é pré-requisito — e por isso entra por `insert` no store, como no arquivo
// `e01`. O webhook, porém, é ASSINADO com o segredo dessa configuração: a
// cadeia é provada com a validação de assinatura LIGADA.
// ============================================================================
import assert from 'node:assert/strict';
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { createHmac, randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import type { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';

if (!process.env.DATABASE_URL) {
  throw new Error('gateway-cadeia-pagamento-e2e.test.ts exige DATABASE_URL e PostgreSQL real; não é permitido pular esta prova.');
}

process.env.NODE_ENV = 'test';
// A mesma chave no processo de teste (que cifra o segredo do webhook e a senha
// do gerente) e no servidor spawnado (que os decifra) — sem isso o login e a
// verificação de assinatura falhariam por chave diferente.
process.env.SEGREDOS_ENCRYPTION_KEY = process.env.SEGREDOS_ENCRYPTION_KEY || 'erp01-segredos-de-teste';

const { migrate, query } = await import('../../src/db');
await migrate();
const { getStore } = await import('../../src/services');
const { R_GATEWAY_CONFIGS, R_GATEWAY_WEBHOOK_EVENTS } = await import('../../src/gateway');
const { hashPassword } = await import('../../src/password');
const { cifrarSegredo } = await import('../../src/segredos');

const SERVER_DIR = fileURLToPath(new URL('../../', import.meta.url));
type Child = ChildProcessByStdio<null, Readable, Readable>;

const RODADA = `cadeia${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
let contador = 0;
const unico = (prefixo: string) => `${prefixo}-${RODADA}-${++contador}`;

/** Todo corpo público de webhook passa por aqui: nenhum pode expor o schema. */
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
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return port;
}

async function startRealServer(port: number): Promise<{ child: Child; baseUrl: string; logs: () => string }> {
  const env: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: 'test', PORT: String(port) };
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], { cwd: SERVER_DIR, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  const append = (chunk: string | Buffer) => {
    output = `${output}${String(chunk)}`.slice(-40_000);
  };
  child.stdout.on('data', append);
  child.stderr.on('data', append);
  const baseUrl = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`O servidor encerrou antes do health check.\n${output}`);
    try {
      const r = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(1_000) });
      if (r.ok) {
        const h = (await r.json()) as { ok?: boolean; db?: string };
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
    const t = setTimeout(() => {
      child.kill('SIGKILL');
      resolve();
    }, 5_000);
    child.once('exit', () => {
      clearTimeout(t);
      resolve();
    });
    child.kill('SIGTERM');
  });
}

type Resposta = { status: number; body: any; texto: string };

async function http(baseUrl: string, method: string, rota: string, token: string | null, body?: unknown): Promise<Resposta> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const r = await fetch(`${baseUrl}/api${rota}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const texto = await r.text();
  let corpo: any = null;
  try {
    corpo = JSON.parse(texto);
  } catch {
    corpo = null;
  }
  return { status: r.status, body: corpo, texto };
}

// ---------------------------------------------------------------------------
// Fixtures — empresa + gerente (login HTTP real) e a configuração do provedor
// ---------------------------------------------------------------------------

type Tenant = { empresaId: number; email: string; senha: string; segredo: string; configId: number };

async function novoTenant(): Promise<Tenant> {
  const s = getStore();
  const nome = unico('Empresa Cadeia');
  const empresa = await query<{ id: number }>(`INSERT INTO empresas (nome, razao_social, ativo) VALUES ($1, $2, true) RETURNING id`, [nome, nome]);
  const empresaId = Number(empresa.rows[0].id);

  const email = `${unico('gerente')}@example.test`;
  const senha = `Cadeia-${randomUUID()}!`;
  const senhaHash = await hashPassword(senha);
  const usuario = await query<{ id: number }>(
    `INSERT INTO usuarios (nome, email, senha_hash, perfil, ativo, empresa_id, pode_consolidar, trocar_senha, senha_provisoria, senha_definida_em)
     VALUES ($1, $2, $3, 'gerente', true, $4, false, false, false, now()) RETURNING id`,
    [`Gerente Cadeia ${RODADA}`, email, senhaHash, empresaId],
  );
  const usuarioId = Number(usuario.rows[0].id);
  await query(`INSERT INTO usuario_empresas (usuario_id, empresa_id) VALUES ($1, $2) ON CONFLICT (usuario_id, empresa_id) DO NOTHING`, [usuarioId, empresaId]);

  // Pré-requisito da cobrança (não parte da cadeia): config ativa do provedor
  // mock para ESTA empresa, COM segredo de webhook — a notificação do teste é
  // assinada, então a cadeia roda com a validação de assinatura ligada.
  const segredo = `segredo-${unico('webhook')}`;
  const config = await s.insert(R_GATEWAY_CONFIGS, {
    empresa_id: empresaId,
    provider: 'mock',
    ambiente: 'teste',
    ativo: true,
    credenciais_cifradas: cifrarSegredo(JSON.stringify({ fake: 'cred' })),
    webhook_segredo_cifrado: cifrarSegredo(segredo),
  });

  return { empresaId, email, senha, segredo, configId: Number(config!.id) };
}

async function login(baseUrl: string, t: Tenant): Promise<string> {
  const r = await http(baseUrl, 'POST', '/auth/login', null, { email: t.email, password: t.senha });
  assert.equal(r.status, 200, `login do gerente no PostgreSQL deveria ser 200; veio ${r.status} ${r.texto}`);
  const token = String(r.body?.token || '');
  assert.ok(token.length > 20, 'o login precisa emitir JWT de sessão');
  return token;
}

async function eventosDoEvento(eventoId: string): Promise<any[]> {
  const s = getStore();
  const r = await s.list(R_GATEWAY_WEBHOOK_EVENTS, { page: 1, pageSize: 20, filter: { provider: 'mock', evento_id: eventoId } });
  return r.rows;
}

/** Baixas registradas no título (linhas filhas) — uma baixa total não cria filho. */
async function filhosDaBaixa(lancamentoId: number): Promise<number> {
  const r = await query<{ total: string }>(`SELECT count(*)::text AS total FROM lancamentos_financeiros WHERE referencia_tipo = 'baixa' AND referencia_id = $1`, [lancamentoId]);
  return Number(r.rows[0].total);
}

// ---------------------------------------------------------------------------

test('ERP-01: PAGAMENTO → WEBHOOK → COBRANÇA → RECEBIMENTO → CONCILIAÇÃO fecha por HTTP autenticado em PostgreSQL', async (t) => {
  const porta = await reservePort();
  const { child, baseUrl } = await startRealServer(porta);
  t.after(async () => stopServer(child));

  const a = await novoTenant();
  const tokenA = await login(baseUrl, a);

  // A empresa ativa da sessão é a do gerente — o carimbo não vem do corpo.
  const ativa = await http(baseUrl, 'GET', '/empresas/ativa', tokenA);
  assert.equal(ativa.status, 200);
  assert.equal(Number(ativa.body?.empresa_id), a.empresaId, 'a sessão precisa operar na empresa do cadastro do gerente');

  // ------------------------------------------------------------- 1) PAGAMENTO
  const descricao = unico('Título cadeia');
  const tituloCriado = await http(baseUrl, 'POST', '/financeiro/lancamentos', tokenA, {
    tipo: 'receita',
    valor: 120,
    descricao,
    status: 'pendente',
    vencimento: new Date(Date.now() + 86_400_000).toISOString().slice(0, 10),
    empresa_id: 999_999, // tentativa de falsificação: o servidor carimba a empresa do ator
  });
  assert.equal(tituloCriado.status, 201, `criar o título deveria ser 201; veio ${tituloCriado.status} ${tituloCriado.texto}`);
  const tituloId = Number(tituloCriado.body?.id);
  assert.ok(tituloId > 0, 'o título precisa ser persistido com id');
  assert.equal(Number(tituloCriado.body?.empresa_id), a.empresaId, 'o título pertence à empresa do ator, não à do corpo');
  assert.equal(String(tituloCriado.body?.status), 'pendente');

  // ------------------------------------------------------------- 2) COBRANÇA
  const idempotencyKey = unico('cadeia-key');
  const cobrancaCriada = await http(baseUrl, 'POST', '/financeiro/gateway/cobrancas', tokenA, {
    provider: 'mock',
    metodo: 'pix',
    lancamento_id: tituloId,
    idempotency_key: idempotencyKey,
    descricao,
  });
  assert.equal(cobrancaCriada.status, 201, `criar a cobrança deveria ser 201; veio ${cobrancaCriada.status} ${cobrancaCriada.texto}`);
  const cobranca = cobrancaCriada.body?.cobranca;
  const cobrancaId = Number(cobranca?.id);
  const providerRef = String(cobranca?.provider_ref || '');
  assert.ok(cobrancaId > 0 && providerRef.startsWith('mock-'), `cobrança precisa existir com provider_ref; veio ${cobrancaCriada.texto}`);
  assert.equal(String(cobranca?.status), 'pendente');
  assert.equal(Number(cobranca?.lancamento_id), tituloId, 'a cobrança precisa apontar para o título');
  assert.equal(Number(cobranca?.valor), 120);
  assert.match(String(cobranca?.qr_code), /^MOCK-PIX-QR-/, 'PIX do provedor mock devolve QR');
  // O payload BRUTO do provedor não vai para o cliente (só o indicador).
  assert.equal(cobranca?.payload, undefined, 'a resposta não pode carregar o payload bruto do provedor');
  assert.equal(cobranca?.bruto_disponivel, true);

  // Idempotência da CRIAÇÃO (mesma chave): devolve a mesma cobrança, não uma segunda.
  const repetida = await http(baseUrl, 'POST', '/financeiro/gateway/cobrancas', tokenA, {
    provider: 'mock',
    metodo: 'pix',
    lancamento_id: tituloId,
    idempotency_key: idempotencyKey,
    descricao,
  });
  assert.equal(repetida.status, 200, `repetição da criação é resposta idempotente; veio ${repetida.status} ${repetida.texto}`);
  assert.equal(repetida.body?.idempotente, true);
  assert.equal(Number(repetida.body?.cobranca?.id), cobrancaId, 'não pode nascer uma segunda cobrança para a mesma chave');

  // --------------------------------------------------------------- 3) WEBHOOK
  const eventoId = unico('evt-cadeia');
  const corpoWebhook = JSON.stringify({ event: 'payment.paid', event_id: eventoId, data: { id: providerRef }, status: 'pago' });
  const assinatura = createHmac('sha256', a.segredo).update(corpoWebhook, 'utf8').digest('hex');
  const webhook = await fetch(`${baseUrl}/api/gateway/webhooks/mock`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-mock-signature': assinatura },
    body: corpoWebhook,
  });
  const webhookTexto = await webhook.text();
  semVazamento(webhookTexto, 'notificação assinada');
  const webhookBody = JSON.parse(webhookTexto) as { ok?: boolean; resultado?: string; processado?: boolean; duplicado?: boolean };
  assert.equal(webhook.status, 200, `a notificação assinada deveria ser 200; veio ${webhook.status} ${webhookTexto}`);
  assert.equal(webhookBody.ok, true);
  assert.equal(webhookBody.resultado, 'paga', `a cadeia precisa confirmar o pagamento: ${webhookTexto}`);
  assert.equal(webhookBody.processado, true);

  // ----------------------------------------------------------- 4) RECEBIMENTO
  const detalhe = await http(baseUrl, 'GET', `/financeiro/gateway/cobrancas/${cobrancaId}`, tokenA);
  assert.equal(detalhe.status, 200, `o detalhe da cobrança deveria ser 200; veio ${detalhe.status} ${detalhe.texto}`);
  assert.equal(String(detalhe.body?.cobranca?.status), 'paga', 'a cobrança precisa sair de pendente — era o P0-02');
  const eventoDaCobranca = Number(detalhe.body?.cobranca?.webhook_evento_id);
  assert.ok(eventoDaCobranca > 0, 'a cobrança precisa apontar para o evento que a confirmou (rastreabilidade/conciliação)');

  const titulo = await http(baseUrl, 'GET', `/lancamentos_financeiros/${tituloId}`, tokenA);
  assert.equal(titulo.status, 200);
  assert.equal(String(titulo.body?.status), 'confirmado', 'o título precisa ser baixado pelo webhook');
  assert.match(String(titulo.body?.observacoes), /webhook/i, 'a baixa precisa registrar a origem webhook');
  assert.equal((String(titulo.body?.observacoes).match(/Baixa em /g) || []).length, 1, 'a baixa precisa ter sido aplicada exatamente uma vez');
  assert.equal(await filhosDaBaixa(tituloId), 0, 'baixa total não gera título filho (uma única baixa efetiva)');

  // ---------------------------------------------------------- 5) CONCILIAÇÃO
  const eventos = await http(baseUrl, 'GET', `/financeiro/gateway/webhooks?provider=mock&pageSize=200`, tokenA);
  assert.equal(eventos.status, 200, `a lista de eventos deveria ser 200; veio ${eventos.status} ${eventos.texto}`);
  const nossoEvento = (eventos.body?.eventos || []).find((e: any) => String(e.evento_id) === eventoId);
  assert.ok(nossoEvento, `o evento conciliado precisa aparecer na lista autenticada: ${eventos.texto.slice(0, 300)}`);
  assert.equal(String(nossoEvento.status), 'processado');
  assert.equal(Number(nossoEvento.cobranca_id), cobrancaId, 'o evento precisa estar ligado à cobrança que ele confirmou');
  assert.equal(Number(nossoEvento.empresa_id), a.empresaId, 'o evento precisa pertencer à empresa dona da cobrança');
  assert.equal(nossoEvento.payload, undefined, 'a listagem não pode devolver o payload bruto');
  assert.equal(nossoEvento.tem_payload, true);

  const pagas = await http(baseUrl, 'GET', `/financeiro/gateway/cobrancas?status=paga&pageSize=200`, tokenA);
  assert.equal(pagas.status, 200);
  assert.ok(
    (pagas.body?.cobrancas || []).some((c: any) => Number(c.id) === cobrancaId),
    'a cobrança paga precisa aparecer na visão de conciliação (lista por status)',
  );

  // ------------------------------------- 6) IDEMPOTÊNCIA: repetição do webhook
  const repetido = await fetch(`${baseUrl}/api/gateway/webhooks/mock`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-mock-signature': assinatura },
    body: corpoWebhook,
  });
  const repetidoTexto = await repetido.text();
  semVazamento(repetidoTexto, 'notificação repetida');
  const repetidoBody = JSON.parse(repetidoTexto) as { ok?: boolean; duplicado?: boolean };
  assert.equal(repetido.status, 200, `a repetição deveria ser 200; veio ${repetido.status} ${repetidoTexto}`);
  assert.equal(repetidoBody.duplicado, true, `a repetição precisa ser duplicata explícita: ${repetidoTexto}`);

  const tituloDepois = await http(baseUrl, 'GET', `/lancamentos_financeiros/${tituloId}`, tokenA);
  assert.equal(String(tituloDepois.body?.status), 'confirmado');
  assert.equal((String(tituloDepois.body?.observacoes).match(/Baixa em /g) || []).length, 1, 'a repetição não pode aplicar segunda baixa');
  assert.equal(await filhosDaBaixa(tituloId), 0, 'a repetição não pode gerar segunda baixa');
  assert.equal((await eventosDoEvento(eventoId)).length, 1, 'a repetição não pode criar segunda linha de evento');
  assert.equal((await http(baseUrl, 'GET', `/financeiro/gateway/cobrancas/${cobrancaId}`, tokenA)).body?.cobranca?.status, 'paga');

  // --------------------------------- 7) MULTIEMPRESA: a outra empresa não lê nada
  const b = await novoTenant();
  const tokenB = await login(baseUrl, b);
  assert.notEqual(b.empresaId, a.empresaId);

  const alheia = await http(baseUrl, 'GET', `/financeiro/gateway/cobrancas/${cobrancaId}`, tokenB);
  assert.equal(alheia.status, 404, `a cobrança da empresa A não pode ser lida pela empresa B; veio ${alheia.status} ${alheia.texto}`);

  const listaB = await http(baseUrl, 'GET', '/financeiro/gateway/cobrancas?pageSize=200', tokenB);
  assert.equal(listaB.status, 200);
  assert.ok(!(listaB.body?.cobrancas || []).some((c: any) => Number(c.id) === cobrancaId), 'a lista da empresa B não pode conter a cobrança de A');

  const eventosB = await http(baseUrl, 'GET', '/financeiro/gateway/webhooks?provider=mock&pageSize=200', tokenB);
  assert.equal(eventosB.status, 200);
  assert.ok(!(eventosB.body?.eventos || []).some((e: any) => String(e.evento_id) === eventoId), 'o evento da empresa A não pode aparecer para a empresa B');

  // O efeito financeiro de A continua único e intacto depois de tudo.
  assert.equal((await eventosDoEvento(eventoId))[0]?.empresa_id, a.empresaId);
  assert.equal((await http(baseUrl, 'GET', `/lancamentos_financeiros/${tituloId}`, tokenA)).body?.status, 'confirmado');

  // -------------------------------------------------- 8) coletor de vazamentos
  assert.ok(corposPublicos.length >= 2, 'as respostas anônimas precisam ter sido inspecionadas');
});

// ============================================================================
// ERP-01 — ATOMICIDADE E EVENTO DE NEGÓCIO INVÁLIDO (§12 e §10, item 5).
//
// Uma notificação de pagamento para uma cobrança que NÃO pode ser paga
// ('cancelada') precisa terminar em estado consistente:
//
//   • a cobrança continua 'cancelada' (nada de "cobrança paga + evento falho");
//   • o título continua 'pendente' — NENHUMA baixa foi aplicada;
//   • o evento fica em 'erro' com tentativas e próxima tentativa agendada,
//     pronto para o retry (não é descartado nem vira 'ignorado');
//   • a resposta ao provedor é controlada (ACK 200, processado:false) e não
//     carrega mensagem de driver, tabela, coluna, constraint nem SQL.
//
// É a prova de que o efeito financeiro roda dentro de UMA transação: a recusa
// no meio do caminho não deixa efeito parcial.
// ============================================================================

test('ERP-01: pagamento de cobrança cancelada não produz efeito parcial (rollback + evento em retry)', async (t) => {
  const porta = await reservePort();
  const { child, baseUrl } = await startRealServer(porta);
  t.after(async () => stopServer(child));

  const t1 = await novoTenant();
  const token = await login(baseUrl, t1);

  const descricao = unico('Título cancelada');
  const titulo = await http(baseUrl, 'POST', '/financeiro/lancamentos', token, {
    tipo: 'receita',
    valor: 90,
    descricao,
    status: 'pendente',
    vencimento: new Date(Date.now() + 86_400_000).toISOString().slice(0, 10),
  });
  assert.equal(titulo.status, 201, titulo.texto);
  const tituloId = Number(titulo.body?.id);

  const criada = await http(baseUrl, 'POST', '/financeiro/gateway/cobrancas', token, {
    provider: 'mock',
    metodo: 'pix',
    lancamento_id: tituloId,
    idempotency_key: unico('cancelada-key'),
    descricao,
  });
  assert.equal(criada.status, 201, criada.texto);
  const cobrancaId = Number(criada.body?.cobranca?.id);
  const providerRef = String(criada.body?.cobranca?.provider_ref);

  // A cobrança é cancelada pela API antes de o provedor notificar o pagamento.
  const cancelada = await http(baseUrl, 'POST', `/financeiro/gateway/cobrancas/${cobrancaId}/cancelar`, token);
  assert.equal(cancelada.status, 200, `cancelar a cobrança deveria ser 200; veio ${cancelada.status} ${cancelada.texto}`);
  assert.equal(String(cancelada.body?.cobranca?.status), 'cancelada');

  // Notificação de pagamento ASSINADA para a cobrança cancelada.
  const eventoId = unico('evt-cancelada');
  const corpo = JSON.stringify({ event: 'payment.paid', event_id: eventoId, data: { id: providerRef }, status: 'pago' });
  const assinatura = createHmac('sha256', t1.segredo).update(corpo, 'utf8').digest('hex');
  const r = await fetch(`${baseUrl}/api/gateway/webhooks/mock`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-mock-signature': assinatura },
    body: corpo,
  });
  const texto = await r.text();
  semVazamento(texto, 'pagamento de cobrança cancelada');
  const body = JSON.parse(texto) as { ok?: boolean; resultado?: string; processado?: boolean };
  assert.equal(r.status, 200, `um evento de negócio recusado não pode derrubar o ACK; veio ${r.status} ${texto}`);
  assert.equal(body.ok, true);
  assert.equal(body.resultado, 'erro', `o evento precisa ficar em erro/retry, não em ignorado: ${texto}`);
  assert.equal(body.processado, false, `nada foi processado: ${texto}`);

  // NADA mudou no financeiro: nem a cobrança, nem o título, nem uma baixa.
  const cobrancaDepois = await http(baseUrl, 'GET', `/financeiro/gateway/cobrancas/${cobrancaId}`, token);
  assert.equal(cobrancaDepois.status, 200);
  assert.equal(String(cobrancaDepois.body?.cobranca?.status), 'cancelada', 'a cobrança cancelada não pode virar paga por webhook');
  const tituloDepois = await http(baseUrl, 'GET', `/lancamentos_financeiros/${tituloId}`, token);
  assert.equal(String(tituloDepois.body?.status), 'pendente', 'nenhuma baixa pode ser aplicada quando o pagamento é recusado');
  assert.ok(!/Baixa em /.test(String(tituloDepois.body?.observacoes || '')), 'o título não pode registrar baixa');
  assert.equal(await filhosDaBaixa(tituloId), 0, 'a recusa no meio do caminho não pode deixar baixa parcial');

  // O evento está registrado em 'erro', com retry agendado — e continua auditável.
  const eventos = await eventosDoEvento(eventoId);
  assert.equal(eventos.length, 1, `um evento, uma linha; veio ${eventos.length}`);
  assert.equal(String(eventos[0].status), 'erro', 'evento recusado entra no retry, não é descartado');
  assert.ok(Number(eventos[0].tentativas) >= 1, 'a tentativa precisa ser contada');
  assert.ok(eventos[0].proxima_tentativa_em, 'o retry precisa ter próxima tentativa agendada');
  assert.equal(Number(eventos[0].cobranca_id ?? 0), 0, 'a cobrança não foi confirmada, então o evento não pode apontá-la como processada');

  // E o evento aparece na visão autenticada de conciliação (auditável pelo operador).
  const lista = await http(baseUrl, 'GET', `/financeiro/gateway/webhooks?provider=mock&status=erro&pageSize=200`, token);
  assert.equal(lista.status, 200);
  assert.ok(
    (lista.body?.eventos || []).some((e: any) => String(e.evento_id) === eventoId),
    'o evento recusado precisa estar visível para reprocessamento',
  );
});
