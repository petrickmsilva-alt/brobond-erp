// ============================================================================
// FILA DE IMPRESSÃO (P0) + CLAIM/LEASE (P1) — print_jobs.
//
// Este arquivo é o único lugar que escreve em `print_jobs`. Espelha os
// padrões que o ERP já provou em produção:
//
//   • idempotência (empresa_id, idempotency_key) como em documentos fiscais
//     (fiscal.ts / migration 0020), ADAPTADA: a chave é obrigatória e vem
//     com content_hash — mesma chave + conteúdo diferente = 409, porque o
//     que está em jogo é uma impressão física, não um documento corrigível;
//   • transição atômica com `tryUpdateIf` (UPDATE condicional): dois agentes
//     reivindicando o mesmo job → exatamente um afeta a linha (equivalente
//     prático de FOR UPDATE SKIP LOCKED neste padrão de store);
//   • auditoria encadeada existente (`store.audit`, auditChain.ts) com
//     acao 'imprimir' e o evento fino em dados.evento;
//   • isolamento multiempresa: TODA leitura/escrita filtra por empresa_id
//     resolvido do ator (usuário) ou da machine identity (agente) — nunca
//     do corpo da requisição.
//
// Máquina de estados:
//
//   QUEUED ──claim──► CLAIMED ──printing──► PRINTING ──printed──► PRINTED
//     ▲                   │                      │
//     │                   └── lease expira ◄─────┘   (agente morreu: o job
//     │                                                volta a ser candidado)
//     └──── fail transitório (backoff, attempts < max) ────┘
//   QUEUED/CLAIMED/PRINTING ──cancel──► CANCELLED
//   PRINTING/CLAIMED ──fail permanente ou attempts = max──► FAILED
//   FAILED ──retry manual──► QUEUED        PRINTED ──reimprimir──► NOVO job
//
// Nada aqui toca estoque, venda ou financeiro: imprimir é efeito de borda.
// ============================================================================
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Request, Response } from 'express';
import { HttpError } from './errors';
import { getResource } from './resources';
import { checkFluxo, escopoDe, getStore } from './services';
import { currentUser, type AuthUser } from './auth';
import { assertRegistroDaEmpresa, type EscopoEmpresa } from './empresa';
import type { Row, Tx } from './store';
import { hashConteudoImpressao, jobParaPrintIR, validatePrintIR, type NovoJobImpressao } from './printIr';
import {
  PRINT_DOC_TYPES,
  PRINT_IR_VERSION,
  PRINT_LIMITS,
  PRINT_PERMANENT_ERRORS,
  PRINT_SOURCES,
} from '../../packages/domain/src/print/print-ir';

export const R_JOBS = () => getResource('print_jobs')!;
export const R_AGENTS = () => getResource('print_agents')!;

/** Lease padrão do claim: tempo de imprimir sem renovar (extensível). */
export const LEASE_MS = Number(process.env.PRINT_LEASE_MS) || 60_000;
/** Backoff do retry automático: base * 2^(tentativas-1), com teto. */
const RETRY_BASE_MS = Number(process.env.PRINT_RETRY_BASE_MS) || 5_000;
const RETRY_MAX_MS = 5 * 60_000;

export function backoffRetryMs(attempts: number): number {
  return Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1));
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
export const hashTokenImpressao = sha256;

/** Comparação de hash em tempo constante (tokens de lease/máquina). */
export function hashConfere(esperadoHash: string | null | undefined, token: string | null | undefined): boolean {
  if (!esperadoHash || !token) return false;
  const a = Buffer.from(String(esperadoHash));
  const b = Buffer.from(sha256(String(token)));
  return a.length === b.length && timingSafeEqual(a, b);
}

// ----------------------------------------------------------------------------
// Auditoria (cadeia existente — nenhuma trilha paralela)
// ----------------------------------------------------------------------------

type AtorImpressao = { usuario_id: number | null; usuario: string };

export function atorDeUsuario(actor: AuthUser): AtorImpressao {
  return { usuario_id: actor.id || null, usuario: actor.name };
}

export function atorDeAgente(agente: Row): AtorImpressao {
  return { usuario_id: null, usuario: `agente:${String(agente.token_prefix || agente.machine_id || '').slice(0, 24)}` };
}

export async function auditarImpressao(
  ator: AtorImpressao,
  evento: string,
  job: Row,
  descricao: string,
  dados: Record<string, unknown> = {},
  tx?: Tx
): Promise<void> {
  await getStore().audit(
    {
      usuario_id: ator.usuario_id,
      usuario: ator.usuario,
      acao: 'imprimir',
      recurso: 'print_jobs',
      registro_id: Number(job.id) || null,
      descricao,
      dados: { evento, public_id: job.public_id, doc_type: job.doc_type, status: job.status, ...dados },
      empresa_id: Number(job.empresa_id),
    },
    tx
  );
}

// ----------------------------------------------------------------------------
// Visões públicas (nunca expõem hashes internos)
// ----------------------------------------------------------------------------

export function jobPublico(job: Row): Record<string, unknown> {
  const { lease_token_hash: _lease, content_hash: _hash, ...resto } = job;
  return resto;
}

async function autorValidoImpressao(actorId: number | null, tx?: Tx): Promise<number | null> {
  if (!actorId) return null;
  const u = await getStore().findOneWhere(getResource('usuarios')!, { id: actorId }, tx);
  return u ? actorId : null;
}

// ----------------------------------------------------------------------------
// Criação (idempotente)
// ----------------------------------------------------------------------------

const texto = (v: unknown, max: number): string | null => {
  const s = String(v ?? '').trim().slice(0, max);
  return s || null;
};

/** Saneia o corpo de criação; lança 400 com a primeira causa (padrão validate). */
export function normalizarNovoJob(body: Record<string, unknown>, headerKey?: string | null): NovoJobImpressao {
  const docType = String(body.doc_type ?? body.docType ?? '');
  if (!(PRINT_DOC_TYPES as readonly string[]).includes(docType)) throw new HttpError(400, `doc_type inválido: ${docType || '(vazio)'}`);
  const source = String(body.source ?? '');
  if (!(PRINT_SOURCES as readonly string[]).includes(source)) throw new HttpError(400, `source inválida: ${source || '(vazia)'}`);
  const copies = Number(body.copies ?? 1);
  if (!Number.isInteger(copies) || copies < PRINT_LIMITS.copiesMin || copies > PRINT_LIMITS.copiesMax) {
    throw new HttpError(400, `copies deve ser ${PRINT_LIMITS.copiesMin}..${PRINT_LIMITS.copiesMax}`);
  }
  const priority = Number(body.priority ?? 0);
  if (!Number.isInteger(priority) || priority < PRINT_LIMITS.priorityMin || priority > PRINT_LIMITS.priorityMax) {
    throw new HttpError(400, `priority deve ser ${PRINT_LIMITS.priorityMin}..${PRINT_LIMITS.priorityMax}`);
  }
  const maxAttempts = Number(body.max_attempts ?? body.maxAttempts ?? 3);
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 20) throw new HttpError(400, 'max_attempts deve ser 1..20');
  const content = body.content;
  if (!Array.isArray(content)) throw new HttpError(400, 'content (blocos do PrintIR) é obrigatório');
  const metadata = (body.metadata ?? {}) as Record<string, unknown>;
  if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)) throw new HttpError(400, 'metadata deve ser um objeto');
  // Sem chave do cliente, geramos uma — a criação continua válida, mas um
  // retry de rede SEM chave é, por definição, um novo pedido (documentado).
  const idempotencyKey = texto(body.idempotency_key ?? body.idempotencyKey ?? headerKey, PRINT_LIMITS.idempotencyKeyMax) || randomUUID();
  return {
    docType,
    source,
    sourceRef: texto(body.source_ref ?? body.sourceRef, 120),
    terminal: texto(body.terminal, PRINT_LIMITS.terminalMax),
    printerName: texto(body.printer_name ?? body.printerName, PRINT_LIMITS.printerNameMax),
    copies,
    priority,
    content: content as NovoJobImpressao['content'],
    metadata,
    idempotencyKey,
    maxAttempts,
  };
}

/**
 * Cria o job na fila — ou devolve o existente quando a chave de idempotência
 * se repete com o MESMO conteúdo (`idempotente: true`). Mesma chave com
 * conteúdo diferente é 409: a chave foi reutilizada para outra impressão.
 */
export async function enfileirarJob(
  empresaId: number,
  ator: AtorImpressao,
  novo: NovoJobImpressao,
  opts: { reprintOf?: string | null } = {}
): Promise<{ job: Row; idempotente: boolean }> {
  const s = getStore();
  const publicId = randomUUID();
  const agora = new Date().toISOString();
  // O validador canônico roda sobre o PrintIR montado com o carimbo do
  // servidor (empresa/ator nunca vêm do corpo).
  const ir = {
    version: PRINT_IR_VERSION,
    jobId: publicId,
    tenantId: String(empresaId),
    companyId: String(empresaId),
    requestedBy: { userId: ator.usuario_id, userName: ator.usuario },
    terminal: novo.terminal,
    printerName: novo.printerName,
    source: novo.source,
    docType: novo.docType,
    related: null,
    copies: novo.copies,
    priority: novo.priority,
    content: novo.content,
    metadata: novo.metadata,
    idempotencyKey: novo.idempotencyKey,
    createdAt: agora,
  };
  const erros = validatePrintIR(ir);
  if (erros.length) throw new HttpError(400, `PrintIR inválido: ${erros[0]}`, { erros });

  const contentHash = hashConteudoImpressao({
    docType: novo.docType,
    source: novo.source,
    sourceRef: novo.sourceRef,
    terminal: novo.terminal,
    printerName: novo.printerName,
    copies: novo.copies,
    content: novo.content,
  });

  return s.transaction(async (tx) => {
    const existente = await s.findOneWhere(R_JOBS(), { empresa_id: empresaId, idempotency_key: novo.idempotencyKey }, tx);
    if (existente) {
      if (String(existente.content_hash) !== contentHash) {
        throw new HttpError(409, 'Esta chave de idempotência já foi usada para outra impressão.');
      }
      return { job: existente, idempotente: true };
    }
    let job: Row;
    try {
      job = await s.insert(
        R_JOBS(),
        {
          empresa_id: empresaId,
          public_id: publicId,
          ir_version: PRINT_IR_VERSION,
          doc_type: novo.docType,
          source: novo.source,
          source_ref: novo.sourceRef,
          terminal: novo.terminal,
          printer_name: novo.printerName,
          copies: novo.copies,
          priority: novo.priority,
          status: 'QUEUED',
          payload: novo.content,
          metadata: novo.metadata,
          idempotency_key: novo.idempotencyKey,
          content_hash: contentHash,
          attempts: 0,
          max_attempts: novo.maxAttempts,
          reprint_of: opts.reprintOf ?? null,
          requested_by: await autorValidoImpressao(ator.usuario_id, tx),
        },
        tx
      );
    } catch (e) {
      // Corrida no Postgres: o índice único venceu a leitura acima. O job
      // "perdedor" não existe — devolve o vencedor, como um retry faria.
      const vencedor = await s.findOneWhere(R_JOBS(), { empresa_id: empresaId, idempotency_key: novo.idempotencyKey }, tx).catch(() => null);
      if (vencedor && String(vencedor.content_hash) === contentHash) return { job: vencedor, idempotente: true };
      throw e;
    }
    await auditarImpressao(ator, 'print.job.created', job, `Impressão enfileirada (${novo.docType})`, {
      idempotency_key: novo.idempotencyKey,
      reprint_of: opts.reprintOf ?? undefined,
    }, tx);
    return { job, idempotente: false };
  }, { isolation: 'read committed' });
}

// ----------------------------------------------------------------------------
// Claim / lease / desfecho (usados pelas rotas do agente)
// ----------------------------------------------------------------------------

function leaseExpirado(job: Row, agoraMs: number): boolean {
  return !!job.lease_expires_at && new Date(String(job.lease_expires_at)).getTime() <= agoraMs;
}

function elegivel(job: Row, agente: Row, agoraMs: number): boolean {
  const terminalAgente = (agente.terminal as string) || null;
  const terminalJob = (job.terminal as string) || null;
  // Roteamento por terminal: job endereçado só é reivindicável pelo agente
  // daquele terminal; job sem endereço, por qualquer agente da empresa.
  if (terminalJob && terminalJob !== terminalAgente) return false;
  if (job.status === 'QUEUED') {
    return !job.next_retry_at || new Date(String(job.next_retry_at)).getTime() <= agoraMs;
  }
  // CLAIMED/PRINTING com lease vencido: o agente anterior morreu no meio —
  // o job volta a ser candidato (o journal local do novo agente e o
  // lease_token impedem a impressão duplicada; ver print-agent).
  if (job.status === 'CLAIMED' || job.status === 'PRINTING') return leaseExpirado(job, agoraMs);
  return false;
}

/**
 * Reivindica no máximo um job para o agente. Devolve o job + lease_token
 * (uma única vez — no banco fica só o hash) ou null se a fila está vazia
 * para este agente. O claim é um UPDATE condicional (tryUpdateIf): em
 * concorrência real no Postgres, só um agente afeta a linha.
 */
export async function claimJob(agente: Row): Promise<{ job: Row; leaseToken: string } | null> {
  const s = getStore();
  const agora = Date.now();
  const candidatos: Row[] = [];
  for (const status of ['QUEUED', 'CLAIMED', 'PRINTING'] as const) {
    const { rows } = await s.list(R_JOBS(), {
      page: 1,
      pageSize: 50,
      filter: { empresa_id: Number(agente.empresa_id), status },
    });
    candidatos.push(...rows.filter((j) => elegivel(j, agente, agora)));
  }
  candidatos.sort(
    (a, b) =>
      Number(b.priority || 0) - Number(a.priority || 0) ||
      new Date(String(a.criado_em)).getTime() - new Date(String(b.criado_em)).getTime() ||
      Number(a.id) - Number(b.id)
  );
  for (const cand of candidatos) {
    const leaseToken = randomBytes(32).toString('hex');
    const esperado: Record<string, unknown> = { status: String(cand.status) };
    if (cand.status !== 'QUEUED') {
      esperado.claimed_by_agent_id = cand.claimed_by_agent_id;
      esperado.lease_token_hash = cand.lease_token_hash;
    }
    // READ COMMITTED é requisito do claim: é nesse nível que o UPDATE
    // condicional espera o lock da linha e REAVALIA o WHERE — o perdedor
    // afeta 0 linhas e segue para o próximo candidato. No padrão
    // SERIALIZABLE do store, o mesmo UPDATE lançaria 40001 (provado contra
    // Postgres real em pg-print.test.ts). O catch de 40001 abaixo é o cinto:
    // se algum caminho futuro serializar, perder a corrida continua inócuo.
    const claimed = await s.transaction(async (tx) => {
      const row = await s.tryUpdateIf(R_JOBS(), Number(cand.id), esperado, {
        status: 'CLAIMED',
        claimed_by_agent_id: Number(agente.id),
        lease_token_hash: sha256(leaseToken),
        lease_expires_at: new Date(agora + LEASE_MS).toISOString(),
        attempts: Number(cand.attempts || 0) + 1,
        claimed_at: new Date(agora).toISOString(),
        printing_at: null,
        next_retry_at: null,
      }, tx);
      if (!row) return null;
      await auditarImpressao(atorDeAgente(agente), 'print.job.claimed', row, `Job reivindicado pelo agente ${agente.nome || agente.machine_id}`, {
        tentativa: Number(row.attempts),
        recuperado_de_lease: cand.status !== 'QUEUED' || undefined,
      }, tx);
      return row;
    }, { isolation: 'read committed' }).catch((e: unknown) => {
      if ((e as { code?: string })?.code === '40001') return null; // perdeu a corrida
      throw e;
    });
    if (claimed) return { job: claimed, leaseToken };
  }
  return null;
}

/** Job do agente, provando posse do lease. Erros são 404/409 — nunca vaza outro tenant. */
async function jobDoAgenteComLease(agente: Row, publicId: string, leaseToken: string): Promise<Row> {
  const job = await getStore().findOneWhere(R_JOBS(), { empresa_id: Number(agente.empresa_id), public_id: publicId });
  if (!job) throw new HttpError(404, 'Job não encontrado.');
  if (Number(job.claimed_by_agent_id) !== Number(agente.id)) throw new HttpError(409, 'Este job não está com este agente.');
  if (!hashConfere(job.lease_token_hash as string, leaseToken)) throw new HttpError(409, 'Lease inválido ou expirado. Reivindique o job novamente.');
  if (leaseExpirado(job, Date.now())) throw new HttpError(409, 'Lease expirado. Reivindique o job novamente.');
  return job;
}

export async function marcarPrinting(agente: Row, publicId: string, leaseToken: string): Promise<Row> {
  const s = getStore();
  const job = await jobDoAgenteComLease(agente, publicId, leaseToken);
  if (job.status === 'PRINTING') return job; // repetição do agente é inócua
  if (job.status !== 'CLAIMED') throw new HttpError(409, `Job em ${job.status} não pode entrar em impressão.`);
  const row = await s.tryUpdateIf(R_JOBS(), Number(job.id), { status: 'CLAIMED', lease_token_hash: job.lease_token_hash }, {
    status: 'PRINTING',
    printing_at: new Date().toISOString(),
    lease_expires_at: new Date(Date.now() + LEASE_MS).toISOString(),
  });
  if (!row) throw new HttpError(409, 'O job mudou de estado. Reivindique novamente.');
  await auditarImpressao(atorDeAgente(agente), 'print.job.printing', row, 'Impressão iniciada');
  return row;
}

export async function estenderLease(agente: Row, publicId: string, leaseToken: string): Promise<Row> {
  const job = await jobDoAgenteComLease(agente, publicId, leaseToken);
  const row = await getStore().tryUpdateIf(R_JOBS(), Number(job.id), { lease_token_hash: job.lease_token_hash }, {
    lease_expires_at: new Date(Date.now() + LEASE_MS).toISOString(),
  });
  if (!row) throw new HttpError(409, 'O job mudou de estado. Reivindique novamente.');
  return row;
}

export async function marcarPrinted(agente: Row, publicId: string, leaseToken: string, deduplicado = false): Promise<Row> {
  const s = getStore();
  const job = await jobDoAgenteComLease(agente, publicId, leaseToken);
  if (job.status !== 'CLAIMED' && job.status !== 'PRINTING') throw new HttpError(409, `Job em ${job.status} não pode ser concluído.`);
  const row = await s.tryUpdateIf(R_JOBS(), Number(job.id), { status: String(job.status), lease_token_hash: job.lease_token_hash }, {
    status: 'PRINTED',
    printed_at: new Date().toISOString(),
    lease_token_hash: null,
    lease_expires_at: null,
    last_error: null,
    last_error_code: null,
  });
  if (!row) throw new HttpError(409, 'O job mudou de estado. Reivindique novamente.');
  await auditarImpressao(atorDeAgente(agente), 'print.job.printed', row, deduplicado ? 'Impressão confirmada (já constava no journal do agente)' : 'Impresso', {
    deduplicado: deduplicado || undefined,
    tentativa: Number(row.attempts),
  });
  return row;
}

/**
 * Falha reportada pelo agente. Transitória e com tentativas restantes →
 * volta à fila com backoff; permanente ou esgotada → FAILED (retry manual
 * continua possível). O lease é sempre liberado.
 */
export async function marcarFailed(
  agente: Row,
  publicId: string,
  leaseToken: string,
  erro: { code?: string; message?: string; retryable?: boolean }
): Promise<Row> {
  const s = getStore();
  const job = await jobDoAgenteComLease(agente, publicId, leaseToken);
  if (job.status !== 'CLAIMED' && job.status !== 'PRINTING') throw new HttpError(409, `Job em ${job.status} não pode falhar.`);
  const code = texto(erro.code, 60) || 'UNKNOWN';
  const permanente = PRINT_PERMANENT_ERRORS.has(code) || erro.retryable === false;
  const attempts = Number(job.attempts || 0);
  const esgotou = attempts >= Number(job.max_attempts || 3);
  const agoraIso = new Date().toISOString();
  const patch: Record<string, unknown> = {
    lease_token_hash: null,
    lease_expires_at: null,
    claimed_by_agent_id: null,
    last_error_code: code,
    last_error: texto(erro.message, 500),
    permanent_error: permanente,
  };
  let evento: string;
  if (!permanente && !esgotou) {
    patch.status = 'QUEUED';
    patch.next_retry_at = new Date(Date.now() + backoffRetryMs(attempts)).toISOString();
    patch.printing_at = null;
    evento = 'print.job.retry_scheduled';
  } else {
    patch.status = 'FAILED';
    patch.failed_at = agoraIso;
    patch.next_retry_at = null;
    evento = 'print.job.failed';
  }
  const row = await s.tryUpdateIf(R_JOBS(), Number(job.id), { status: String(job.status), lease_token_hash: job.lease_token_hash }, patch);
  if (!row) throw new HttpError(409, 'O job mudou de estado. Reivindique novamente.');
  await auditarImpressao(atorDeAgente(agente), evento, row,
    evento === 'print.job.failed' ? `Impressão falhou (${code})` : `Falha transitória (${code}) — nova tentativa agendada`,
    { erro: texto(erro.message, 500), tentativa: attempts, permanente });
  return row;
}

// ----------------------------------------------------------------------------
// Handlers HTTP — área do usuário (JWT + RBAC existentes)
// ----------------------------------------------------------------------------

function escopoDaReq(req: Request): { actor: AuthUser; escopo: EscopoEmpresa } {
  const actor = currentUser(req);
  // Fila de impressão é fluxo operacional: exige leitura do recurso (perfil
  // válido); as rédeas finas (quem cancela/retenta o job de outro) estão nos
  // handlers abaixo, como checkFluxo prevê para recursos com ops fechadas.
  checkFluxo(R_JOBS(), actor);
  return { actor, escopo: escopoDe(actor) };
}

function podeVerTodos(actor: AuthUser): boolean {
  return actor.perfil === 'admin' || actor.perfil === 'gerente';
}

async function jobDoUsuario(req: Request): Promise<{ actor: AuthUser; escopo: EscopoEmpresa; job: Row }> {
  const { actor, escopo } = escopoDaReq(req);
  const publicId = String(req.params.id || '');
  const job = await getStore().findOneWhere(R_JOBS(), { empresa_id: escopo.empresaId, public_id: publicId });
  if (!job) throw new HttpError(404, 'Job de impressão não encontrado.');
  assertRegistroDaEmpresa(R_JOBS(), job, escopo);
  // Ownership: operador só alcança os próprios jobs; gerente/admin, os da empresa.
  if (!podeVerTodos(actor) && Number(job.requested_by) !== actor.id) {
    throw new HttpError(404, 'Job de impressão não encontrado.');
  }
  return { actor, escopo, job };
}

/** POST /api/print/jobs — enfileira (idempotente por chave). */
export async function criarJobHandler(req: Request, res: Response): Promise<void> {
  const { actor, escopo } = escopoDaReq(req);
  const novo = normalizarNovoJob((req.body ?? {}) as Record<string, unknown>, req.header('idempotency-key'));
  const { job, idempotente } = await enfileirarJob(escopo.empresaId, atorDeUsuario(actor), novo);
  res.status(idempotente ? 200 : 201).json({ job: jobPublico(job), idempotente });
}

/** GET /api/print/jobs — lista da empresa (operador: só os seus). */
export async function listarJobsHandler(req: Request, res: Response): Promise<void> {
  const { actor, escopo } = escopoDaReq(req);
  const filter: Record<string, unknown> = { empresa_id: escopo.empresaId };
  const status = texto(req.query.status, 20);
  if (status) filter.status = status;
  if (!podeVerTodos(actor)) filter.requested_by = actor.id;
  const page = Math.max(1, Number(req.query.page) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 20));
  const out = await getStore().list(R_JOBS(), { page, pageSize, filter, sort: 'criado_em', dir: 'desc' });
  res.json({ ...out, rows: out.rows.map(jobPublico) });
}

/** GET /api/print/jobs/:id — detalhe + PrintIR montado. */
export async function detalheJobHandler(req: Request, res: Response): Promise<void> {
  const { job } = await jobDoUsuario(req);
  res.json({ job: jobPublico(job), print_ir: jobParaPrintIR(job) });
}

/** POST /api/print/jobs/:id/cancelar */
export async function cancelarJobHandler(req: Request, res: Response): Promise<void> {
  const { actor, job } = await jobDoUsuario(req);
  if (!['QUEUED', 'CLAIMED', 'PRINTING'].includes(String(job.status))) {
    throw new HttpError(409, `Job em ${job.status} não pode ser cancelado.`);
  }
  const s = getStore();
  // Ao cancelar um job em voo, o lease é anulado: qualquer ack tardio do
  // agente falha na prova de posse e nada é impresso "por engano".
  const row = await s.tryUpdateIf(R_JOBS(), Number(job.id), { status: String(job.status) }, {
    status: 'CANCELLED',
    cancelled_at: new Date().toISOString(),
    lease_token_hash: null,
    lease_expires_at: null,
    claimed_by_agent_id: null,
    next_retry_at: null,
  });
  if (!row) throw new HttpError(409, 'O job mudou de estado. Recarregue a fila.');
  await auditarImpressao(atorDeUsuario(actor), 'print.job.cancelled', row, 'Impressão cancelada');
  res.json({ job: jobPublico(row) });
}

/** POST /api/print/jobs/:id/retry — retry manual de FAILED. */
export async function retryJobHandler(req: Request, res: Response): Promise<void> {
  const { actor, job } = await jobDoUsuario(req);
  if (job.status !== 'FAILED') throw new HttpError(409, 'Só um job FAILED pode ser retentado manualmente.');
  const row = await getStore().tryUpdateIf(R_JOBS(), Number(job.id), { status: 'FAILED' }, {
    status: 'QUEUED',
    attempts: 0,
    next_retry_at: null,
    failed_at: null,
    permanent_error: false,
    last_error: null,
    last_error_code: null,
  });
  if (!row) throw new HttpError(409, 'O job mudou de estado. Recarregue a fila.');
  await auditarImpressao(atorDeUsuario(actor), 'print.job.retry_manual', row, 'Retry manual solicitado');
  res.json({ job: jobPublico(row) });
}

/**
 * POST /api/print/jobs/:id/reimprimir — reimpressão é um job NOVO (nova
 * chave, novo id, `reprint_of` apontando à origem): o original PRINTED
 * nunca ressuscita, então a história e a idempotência ficam intactas.
 */
export async function reimprimirJobHandler(req: Request, res: Response): Promise<void> {
  const { actor, escopo, job } = await jobDoUsuario(req);
  if (!['PRINTED', 'FAILED', 'CANCELLED'].includes(String(job.status))) {
    throw new HttpError(409, `Job em ${job.status} ainda está em andamento — aguarde ou cancele.`);
  }
  const chave = texto((req.body as any)?.idempotency_key ?? req.header('idempotency-key'), PRINT_LIMITS.idempotencyKeyMax)
    || `reprint:${job.public_id}:${randomUUID()}`;
  const { job: novo, idempotente } = await enfileirarJob(
    escopo.empresaId,
    atorDeUsuario(actor),
    {
      docType: String(job.doc_type),
      source: String(job.source),
      sourceRef: (job.source_ref as string) || null,
      terminal: (job.terminal as string) || null,
      printerName: (job.printer_name as string) || null,
      copies: Number(job.copies) || 1,
      priority: Number(job.priority) || 0,
      content: (job.payload as NovoJobImpressao['content']) || [],
      metadata: { ...((job.metadata as Record<string, unknown>) || {}), reprint: true },
      idempotencyKey: chave,
      maxAttempts: Number(job.max_attempts) || 3,
    },
    { reprintOf: String(job.public_id) }
  );
  if (!idempotente) {
    await auditarImpressao(atorDeUsuario(actor), 'print.job.reprinted', novo, `Reimpressão do job ${job.public_id}`, { origem: job.public_id });
  }
  res.status(idempotente ? 200 : 201).json({ job: jobPublico(novo), idempotente });
}
