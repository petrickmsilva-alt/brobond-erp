// ============================================================================
// AGENTE LOCAL DE IMPRESSÃO (P1) — pareamento, machine identity e polling.
//
// O agente NÃO usa o JWT de usuário como credencial permanente. O fluxo é:
//
//   1. no ERP, um gerente/admin gera um código de pareamento temporário
//      (uso único, 10 min, só o hash é guardado) — POST /api/print/pairing;
//   2. no computador da loja, o agente troca o código por uma IDENTIDADE DE
//      MÁQUINA: machine_id + token próprio revogável (mostrado uma vez; no
//      banco fica só o SHA-256) — POST /api/print/agent/pair;
//   3. daí em diante o agente faz POLLING no ERP (Agent → ERP), nunca o
//      contrário: a Render pode hibernar e a loja pode estar atrás de NAT.
//      Cada chamada mutante carrega nonce + timestamp (replay protection);
//   4. revogar o agente no ERP invalida o token na hora e devolve os jobs
//      dele à fila (lease expirado imediatamente).
//
// As rotas /api/print/agent/* são montadas ANTES do requireAuth de usuário
// (o agente não é um usuário) e DEPOIS do bloqueioDeProntidao — ver index.ts.
// A autenticação delas é `autenticarAgente`/`exigirNonceAgente` abaixo.
// ============================================================================
import { randomBytes, randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { HttpError } from './errors';
import { getResource } from './resources';
import { escopoDe, getStore } from './services';
import { clientIp, currentUser } from './auth';
import { exigirRateLimit, registrarFalha, registrarSucesso } from './security';
import type { Row } from './store';
import { jobParaPrintIR } from './printIr';
import {
  atorDeAgente,
  atorDeUsuario,
  claimJob,
  estenderLease,
  hashConfere,
  hashTokenImpressao,
  jobPublico,
  marcarFailed,
  marcarPrinted,
  marcarPrinting,
  R_AGENTS,
  R_JOBS,
} from './printJobs';

const R_PAIRING = () => getResource('print_pairing_codes')!;
const R_NONCES = () => getResource('print_agent_nonces')!;

export const PAIRING_TTL_MS = 10 * 60_000;
const NONCE_JANELA_MS = 5 * 60_000;
const TOKEN_PREFIXO = 'bpa_';

const texto = (v: unknown, max: number): string | null => {
  const s = String(v ?? '').trim().slice(0, max);
  return s || null;
};

// ----------------------------------------------------------------------------
// Pareamento
// ----------------------------------------------------------------------------

/** Alfabeto sem caracteres ambíguos (0/O, 1/I) — o código é ditado/digitado. */
const ALFABETO = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function gerarCodigoPareamento(): string {
  const bytes = randomBytes(12);
  const chars = [...bytes].map((b) => ALFABETO[b % ALFABETO.length]);
  return `${chars.slice(0, 4).join('')}-${chars.slice(4, 8).join('')}-${chars.slice(8, 12).join('')}`;
}

const normalizarCodigo = (v: unknown) => String(v ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');

function gerarTokenMaquina(): string {
  return TOKEN_PREFIXO + randomBytes(32).toString('hex');
}

/** POST /api/print/pairing — gerente/admin (guard na rota). Código sai UMA vez. */
export async function criarCodigoPareamentoHandler(req: Request, res: Response): Promise<void> {
  const actor = currentUser(req);
  const escopo = escopoDe(actor);
  const codigo = gerarCodigoPareamento();
  const expiresAt = new Date(Date.now() + PAIRING_TTL_MS);
  const row = await getStore().insert(R_PAIRING(), {
    empresa_id: escopo.empresaId,
    code_hash: hashTokenImpressao(normalizarCodigo(codigo)),
    terminal: texto((req.body as any)?.terminal, 60),
    nome_sugerido: texto((req.body as any)?.nome, 80),
    expires_at: expiresAt.toISOString(),
    tentativas: 0,
    criado_por: actor.id || null,
  });
  await getStore().audit({
    usuario_id: actor.id || null,
    usuario: actor.name,
    acao: 'imprimir',
    recurso: 'print_agents',
    registro_id: Number(row.id),
    descricao: 'Código de pareamento de agente de impressão gerado',
    dados: { evento: 'print.pairing.created', terminal: row.terminal ?? null, expira_em: expiresAt.toISOString() },
    empresa_id: escopo.empresaId,
  });
  res.status(201).json({
    codigo,
    expira_em: expiresAt.toISOString(),
    instrucoes: 'Digite este código no agente local (tela de pareamento) em até 10 minutos. Ele só pode ser usado uma vez.',
  });
}

/**
 * POST /api/print/agent/pair — troca do código pela machine identity.
 * Público (o código É a credencial), rate-limitado por IP, uso único
 * garantido por UPDATE condicional em used_at IS NULL.
 */
export async function parearAgenteHandler(req: Request, res: Response): Promise<void> {
  const ip = clientIp(req);
  await exigirRateLimit('pairing', ip);
  const body = (req.body ?? {}) as Record<string, unknown>;
  const codigo = normalizarCodigo(body.codigo ?? body.code);
  if (!codigo) throw new HttpError(400, 'Informe o código de pareamento.');
  const s = getStore();
  const par = await s.findOneWhere(R_PAIRING(), { code_hash: hashTokenImpressao(codigo) });
  const invalido = async (msg: string) => {
    await registrarFalha('pairing', ip);
    throw new HttpError(400, msg);
  };
  if (!par) return void (await invalido('Código de pareamento inválido.'));
  if (par.used_at) return void (await invalido('Este código já foi usado. Gere um novo no ERP.'));
  if (new Date(String(par.expires_at)).getTime() <= Date.now()) return void (await invalido('Código de pareamento expirado. Gere um novo no ERP.'));

  const resultado = await s.transaction(async (tx) => {
    const consumido = await s.tryUpdateIf(R_PAIRING(), Number(par.id), { used_at: null }, { used_at: new Date().toISOString() }, tx);
    if (!consumido) return null; // outra troca simultânea venceu — uso único
    const token = gerarTokenMaquina();
    const agente = await s.insert(
      R_AGENTS(),
      {
        empresa_id: Number(par.empresa_id),
        machine_id: randomUUID(),
        nome: texto(body.nome, 80) || (par.nome_sugerido as string) || 'Agente de impressão',
        terminal: texto(body.terminal, 60) || (par.terminal as string) || null,
        token_hash: hashTokenImpressao(token),
        token_prefix: token.slice(0, 12),
        status: 'ativo',
        agent_version: texto(body.agent_version, 40),
        platform: texto(body.platform, 40),
        last_heartbeat_at: new Date().toISOString(),
        last_ip: ip,
        paired_by: par.criado_por ? Number(par.criado_por) : null,
      },
      tx
    );
    await s.update(R_PAIRING(), Number(par.id), { used_by_agent_id: Number(agente.id) }, tx);
    await s.audit(
      {
        usuario_id: null,
        usuario: atorDeAgente(agente).usuario,
        acao: 'imprimir',
        recurso: 'print_agents',
        registro_id: Number(agente.id),
        descricao: `Agente de impressão pareado (${agente.nome})`,
        dados: { evento: 'print.agent.paired', machine_id: agente.machine_id, terminal: agente.terminal ?? null },
        empresa_id: Number(par.empresa_id),
      },
      tx
    );
    return { agente, token };
  }, { isolation: 'read committed' });
  if (!resultado) return void (await invalido('Este código já foi usado. Gere um novo no ERP.'));
  await registrarSucesso('pairing', ip);
  res.status(201).json({
    machine_id: resultado.agente.machine_id,
    token: resultado.token, // exibido UMA vez — o agente guarda localmente
    empresa_id: Number(resultado.agente.empresa_id),
    terminal: resultado.agente.terminal ?? null,
    nome: resultado.agente.nome,
  });
}

// ----------------------------------------------------------------------------
// Autenticação de máquina + replay protection
// ----------------------------------------------------------------------------

type ReqAgente = Request & { printAgent?: Row };

/**
 * Autentica o agente por machine_id + token (Bearer). O token é comparado
 * pelo hash em tempo constante; agente revogado ou inexistente = 401 sempre
 * (sem distinguir os casos para quem está de fora).
 */
export async function autenticarAgente(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const machineId = String(req.header('x-print-machine-id') || '');
    const auth = String(req.header('authorization') || '');
    const token = /^Bearer\s+/i.test(auth) ? auth.replace(/^Bearer\s+/i, '').trim() : '';
    if (!machineId || !token) throw new HttpError(401, 'Agente não autenticado.');
    const agente = await getStore().findOneWhere(R_AGENTS(), { machine_id: machineId });
    if (!agente || agente.status !== 'ativo' || !hashConfere(agente.token_hash as string, token)) {
      throw new HttpError(401, 'Agente não autenticado.');
    }
    (req as ReqAgente).printAgent = agente;
    next();
  } catch (e) {
    next(e);
  }
}

/**
 * Replay protection das chamadas mutantes do agente: exige
 * `x-print-nonce` (único por agente — reaproveitar é 409) e
 * `x-print-timestamp` dentro de ±5 min. Um par (requisição capturada) não
 * pode ser reenviado para imprimir/cancelar de novo.
 */
export async function exigirNonceAgente(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const agente = (req as ReqAgente).printAgent;
    if (!agente) throw new HttpError(401, 'Agente não autenticado.');
    const nonce = String(req.header('x-print-nonce') || '').trim();
    const ts = Number(req.header('x-print-timestamp') || 0);
    if (!nonce || nonce.length > 120) throw new HttpError(400, 'x-print-nonce é obrigatório.');
    if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > NONCE_JANELA_MS) {
      throw new HttpError(400, 'x-print-timestamp fora da janela de 5 minutos (relógio do agente?).');
    }
    const s = getStore();
    const repetido = await s.findOneWhere(R_NONCES(), { agent_id: Number(agente.id), nonce });
    if (repetido) throw new HttpError(409, 'Nonce já utilizado (replay recusado).');
    try {
      await s.insert(R_NONCES(), { empresa_id: Number(agente.empresa_id), agent_id: Number(agente.id), nonce });
    } catch {
      // Índice único no Postgres pegou a corrida que a leitura não viu.
      throw new HttpError(409, 'Nonce já utilizado (replay recusado).');
    }
    next();
  } catch (e) {
    next(e);
  }
}

function agenteDaReq(req: Request): Row {
  const agente = (req as ReqAgente).printAgent;
  if (!agente) throw new HttpError(401, 'Agente não autenticado.');
  return agente;
}

const leaseDaReq = (req: Request) => String(req.header('x-print-lease-token') || (req.body as any)?.lease_token || '');

// ----------------------------------------------------------------------------
// Handlers do agente (polling)
// ----------------------------------------------------------------------------

/** POST /api/print/agent/heartbeat */
export async function heartbeatHandler(req: Request, res: Response): Promise<void> {
  const agente = agenteDaReq(req);
  const body = (req.body ?? {}) as Record<string, unknown>;
  let printers: unknown = agente.printers ?? null;
  if (Array.isArray(body.printers) && JSON.stringify(body.printers).length <= 4096) printers = body.printers;
  const row = await getStore().update(R_AGENTS(), Number(agente.id), {
    agent_version: texto(body.agent_version, 40) || (agente.agent_version as string) || null,
    platform: texto(body.platform, 40) || (agente.platform as string) || null,
    printers,
    last_heartbeat_at: new Date().toISOString(),
    last_ip: clientIp(req),
  });
  res.json({ ok: true, status: row?.status ?? agente.status });
}

/** POST /api/print/agent/claim — devolve 1 job (ou nenhum) com o PrintIR. */
export async function claimHandler(req: Request, res: Response): Promise<void> {
  const agente = agenteDaReq(req);
  const out = await claimJob(agente);
  if (!out) return void res.json({ job: null });
  res.json({
    job: { ...jobPublico(out.job), print_ir: jobParaPrintIR(out.job) },
    lease_token: out.leaseToken,
    lease_expires_at: out.job.lease_expires_at,
  });
}

/** POST /api/print/agent/jobs/:id/printing|printed|fail|lease */
export async function printingHandler(req: Request, res: Response): Promise<void> {
  const row = await marcarPrinting(agenteDaReq(req), String(req.params.id), leaseDaReq(req));
  res.json({ job: jobPublico(row) });
}

export async function printedHandler(req: Request, res: Response): Promise<void> {
  const row = await marcarPrinted(agenteDaReq(req), String(req.params.id), leaseDaReq(req), (req.body as any)?.deduplicado === true);
  res.json({ job: jobPublico(row) });
}

export async function failHandler(req: Request, res: Response): Promise<void> {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const row = await marcarFailed(agenteDaReq(req), String(req.params.id), leaseDaReq(req), {
    code: texto(body.error_code ?? body.code, 60) || undefined,
    message: texto(body.error, 500) || undefined,
    retryable: body.retryable === false ? false : body.retryable === true ? true : undefined,
  });
  res.json({ job: jobPublico(row) });
}

export async function leaseHandler(req: Request, res: Response): Promise<void> {
  const row = await estenderLease(agenteDaReq(req), String(req.params.id), leaseDaReq(req));
  res.json({ lease_expires_at: row.lease_expires_at });
}

// ----------------------------------------------------------------------------
// Gestão de agentes no ERP (gerente/admin — guard na rota)
// ----------------------------------------------------------------------------

export function agentePublico(a: Row): Record<string, unknown> {
  const { token_hash: _hash, ...resto } = a;
  return resto;
}

async function agenteDaEmpresa(req: Request): Promise<Row> {
  const actor = currentUser(req);
  const escopo = escopoDe(actor);
  const agente = await getStore().findOneWhere(R_AGENTS(), { empresa_id: escopo.empresaId, machine_id: String(req.params.id) });
  if (!agente) throw new HttpError(404, 'Agente não encontrado.');
  return agente;
}

/** GET /api/print/agents */
export async function listarAgentesHandler(req: Request, res: Response): Promise<void> {
  const actor = currentUser(req);
  const escopo = escopoDe(actor);
  const out = await getStore().list(R_AGENTS(), { page: 1, pageSize: 100, filter: { empresa_id: escopo.empresaId }, sort: 'criado_em', dir: 'desc' });
  res.json({ ...out, rows: out.rows.map(agentePublico) });
}

/** POST /api/print/agents/:id/revogar — invalida o token e libera os jobs. */
export async function revogarAgenteHandler(req: Request, res: Response): Promise<void> {
  const actor = currentUser(req);
  const agente = await agenteDaEmpresa(req);
  const s = getStore();
  const row = await s.transaction(async (tx) => {
    const revogado = await s.tryUpdateIf(R_AGENTS(), Number(agente.id), { status: 'ativo' }, {
      status: 'revogado',
      // token gira para um hash inalcançável: mesmo um bug que ignorasse o
      // status não autenticaria com o token antigo.
      token_hash: hashTokenImpressao(randomBytes(48).toString('hex')),
      revoked_at: new Date().toISOString(),
      revoked_by: actor.id || null,
    }, tx);
    const alvo = revogado || agente;
    // Jobs em voo deste agente: lease expira JÁ — outro agente assume.
    for (const status of ['CLAIMED', 'PRINTING'] as const) {
      const { rows } = await s.list(R_JOBS(), { page: 1, pageSize: 50, filter: { empresa_id: Number(agente.empresa_id), status, claimed_by_agent_id: Number(agente.id) } }, tx);
      for (const job of rows) {
        await s.tryUpdateIf(R_JOBS(), Number(job.id), { status }, { lease_expires_at: new Date(Date.now() - 1000).toISOString() }, tx);
      }
    }
    if (revogado) {
      await s.audit({
        ...atorDeUsuario(actor),
        acao: 'imprimir',
        recurso: 'print_agents',
        registro_id: Number(agente.id),
        descricao: `Agente de impressão revogado (${agente.nome})`,
        dados: { evento: 'print.agent.revoked', machine_id: agente.machine_id },
        empresa_id: Number(agente.empresa_id),
      }, tx);
    }
    return alvo;
  }, { isolation: 'read committed' });
  res.json({ agente: agentePublico(row) });
}

/** POST /api/print/agents/:id/rotacionar-token — novo token (uma vez). */
export async function rotacionarTokenHandler(req: Request, res: Response): Promise<void> {
  const actor = currentUser(req);
  const agente = await agenteDaEmpresa(req);
  if (agente.status !== 'ativo') throw new HttpError(409, 'Agente revogado não pode rotacionar token. Pareie novamente.');
  const token = gerarTokenMaquina();
  const row = await getStore().update(R_AGENTS(), Number(agente.id), {
    token_hash: hashTokenImpressao(token),
    token_prefix: token.slice(0, 12),
  });
  await getStore().audit({
    ...atorDeUsuario(actor),
    acao: 'imprimir',
    recurso: 'print_agents',
    registro_id: Number(agente.id),
    descricao: `Token do agente rotacionado (${agente.nome})`,
    dados: { evento: 'print.agent.token_rotated', machine_id: agente.machine_id },
    empresa_id: Number(agente.empresa_id),
  });
  res.json({ agente: agentePublico(row!), token });
}
