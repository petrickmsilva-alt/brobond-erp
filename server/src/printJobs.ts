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
  isSafePrinterName,
  PRINT_DOC_TYPES,
  PRINT_IR_VERSION,
  PRINT_LIMITS,
  PRINT_PERMANENT_ERRORS,
  PRINT_SOURCES,
} from '../../packages/domain/src/print/print-ir';
import { resolverDestinoImpressao, validarNomeImpressoraOpcional } from './printTerminals';

export const R_JOBS = () => getResource('print_jobs')!;
export const R_AGENTS = () => getResource('print_agents')!;
const R_NONCES = () => getResource('print_agent_nonces')!;
const R_PAIRING = () => getResource('print_pairing_codes')!;
const R_TERMINALS = () => getResource('print_terminals')!;
const SUPPORTED_JOB_PROTOCOLS = new Set(['text', 'escpos', 'zpl', 'epl2', 'pdf', 'html']);

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

function semUndefined(v: unknown): unknown {
  if (Array.isArray(v)) return v.map((x) => (x === undefined ? null : semUndefined(x)));
  if (v && typeof v === 'object' && !(v instanceof Date)) {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (val !== undefined) out[k] = semUndefined(val);
    }
    return out;
  }
  return v;
}

export async function auditarImpressao(
  ator: AtorImpressao,
  evento: string,
  job: Row,
  descricao: string,
  dados: Record<string, unknown> = {},
  tx?: Tx
): Promise<void> {
  const payload = semUndefined({ evento, public_id: job.public_id, doc_type: job.doc_type, status: job.status, ...dados }) as Record<string, unknown>;
  await getStore().audit(
    {
      usuario_id: ator.usuario_id,
      usuario: ator.usuario,
      acao: 'imprimir',
      recurso: 'print_jobs',
      registro_id: Number(job.id) || null,
      descricao,
      dados: payload,
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
  if (metadata.protocol !== undefined && metadata.protocol !== null && metadata.protocol !== '') {
    const proto = String(metadata.protocol).trim().toLowerCase();
    if (!SUPPORTED_JOB_PROTOCOLS.has(proto)) {
      throw new HttpError(400, `Protocolo de impressão não suportado: "${proto}".`);
    }
    metadata.protocol = proto;
  }
  const rawPrinterName = texto(body.printer_name ?? body.printerName, PRINT_LIMITS.printerNameMax);
  if (rawPrinterName && !isSafePrinterName(rawPrinterName)) {
    throw new HttpError(400, 'printer_name inválido ou contém caracteres inseguros.');
  }
  // Sem chave do cliente, geramos uma — a criação continua válida, mas um
  // retry de rede SEM chave é, por definição, um novo pedido (documentado).
  const idempotencyKey = texto(body.idempotency_key ?? body.idempotencyKey ?? headerKey, PRINT_LIMITS.idempotencyKeyMax) || randomUUID();
  return {
    docType,
    source,
    sourceRef: texto(body.source_ref ?? body.sourceRef, 120),
    terminal: texto(body.terminal, PRINT_LIMITS.terminalMax),
    printerName: rawPrinterName,
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
  opts: { reprintOf?: string | null; reprintReason?: string | null } = {}
): Promise<{ job: Row; idempotente: boolean }> {
  const s = getStore();
  const publicId = randomUUID();
  const agora = new Date().toISOString();
  if (novo.metadata?.protocol !== undefined && novo.metadata?.protocol !== null && novo.metadata?.protocol !== '') {
    const p = String(novo.metadata.protocol).trim().toLowerCase();
    if (!SUPPORTED_JOB_PROTOCOLS.has(p)) {
      throw new HttpError(400, `Protocolo de impressão não suportado: "${p}".`);
    }
  }
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

  const printerProtocol = typeof novo.metadata?.protocol === 'string' && novo.metadata.protocol
    ? String(novo.metadata.protocol).toLowerCase()
    : null;
  const reprintReason = texto(opts.reprintReason ?? novo.metadata?.reprint_reason, 240);

  try {
    return await s.transaction(async (tx) => {
      const existente = await s.findOneWhere(R_JOBS(), { empresa_id: empresaId, idempotency_key: novo.idempotencyKey }, tx);
      if (existente) {
        if (String(existente.content_hash) !== contentHash) {
          throw new HttpError(409, 'Esta chave de idempotência já foi usada para outra impressão.');
        }
        return { job: existente, idempotente: true };
      }
      const job = await s.insert(
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
          printer_protocol: printerProtocol,
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
          reprint_reason: reprintReason,
          requested_by: await autorValidoImpressao(ator.usuario_id, tx),
        },
        tx
      );
      await auditarImpressao(ator, 'print.job.created', job, `Impressão enfileirada (${novo.docType})`, {
        idempotency_key: novo.idempotencyKey,
        reprint_of: opts.reprintOf ?? undefined,
        reprint_reason: reprintReason ?? undefined,
        protocol: printerProtocol ?? undefined,
      }, tx);
      return { job, idempotente: false };
    }, { isolation: 'read committed' });
  } catch (e) {
    if (e instanceof HttpError) throw e;
    // Corrida em PostgreSQL real: 23505 aborta a transação interna, então a
    // leitura do vencedor PRECISA ocorrer fora da tx abortada.
    const vencedor = await s.findOneWhere(R_JOBS(), { empresa_id: empresaId, idempotency_key: novo.idempotencyKey }).catch(() => null);
    if (vencedor) {
      if (String(vencedor.content_hash) === contentHash) return { job: vencedor, idempotente: true };
      throw new HttpError(409, 'Esta chave de idempotência já foi usada para outra impressão.');
    }
    throw e;
  }
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
    // Se um lease expirado já atingiu max_attempts (agente caiu repetidamente
    // neste mesmo job), encerra em FAILED permanente em vez de loop infinito.
    if (
      (cand.status === 'CLAIMED' || cand.status === 'PRINTING') &&
      Number(cand.attempts || 0) >= Number(cand.max_attempts || 3)
    ) {
      await s.tryUpdateIf(
        R_JOBS(),
        Number(cand.id),
        { status: String(cand.status), lease_token_hash: cand.lease_token_hash },
        {
          status: 'FAILED',
          failed_at: new Date(agora).toISOString(),
          lease_token_hash: null,
          lease_expires_at: null,
          claimed_by_agent_id: null,
          next_retry_at: null,
          permanent_error: true,
          last_error_code: 'LEASE_EXPIRED_MAX_ATTEMPTS',
          last_error: 'Lease expirou após esgotar o número máximo de tentativas.',
        }
      ).then(async (falhou) => {
        if (falhou) {
          await auditarImpressao(atorDeAgente(agente), 'print.job.failed', falhou, 'Impressão falhou (lease expirado após máximo de tentativas)');
        }
      }).catch(() => {});
      continue;
    }

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

export async function obterJobDoUsuario(req: Request): Promise<{ actor: AuthUser; escopo: EscopoEmpresa; job: Row }> {
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

const jobDoUsuario = obterJobDoUsuario;

/** POST /api/print/jobs — enfileira (idempotente por chave). */
export async function criarJobHandler(req: Request, res: Response): Promise<void> {
  const { actor, escopo } = escopoDaReq(req);
  const novo = normalizarNovoJob((req.body ?? {}) as Record<string, unknown>, req.header('idempotency-key'));
  const { job, idempotente } = await enfileirarJob(escopo.empresaId, atorDeUsuario(actor), novo);
  res.status(idempotente ? 200 : 201).json({ job: jobPublico(job), idempotente });
}

/**
 * GET /api/print/jobs — lista e histórico auditável da empresa com filtros
 * operacionais (status, doc_type, source, source_ref, terminal, printer_name,
 * agent_id, usuario_id, reprint_only, de, ate, q). Operador vê só os próprios.
 */
export async function listarJobsHandler(req: Request, res: Response): Promise<void> {
  const { actor, escopo } = escopoDaReq(req);
  const s = getStore();
  const filter: Record<string, unknown> = { empresa_id: escopo.empresaId };

  const status = texto(req.query.status, 20);
  if (status) filter.status = status;
  const docType = texto(req.query.doc_type, 40);
  if (docType) filter.doc_type = docType;
  const source = texto(req.query.source, 40);
  if (source) filter.source = source;
  const sourceRef = texto(req.query.source_ref, 120);
  if (sourceRef) filter.source_ref = sourceRef;
  const terminal = texto(req.query.terminal, 60);
  if (terminal) filter.terminal = terminal;
  const printerName = texto(req.query.printer_name, 120);
  if (printerName) filter.printer_name = printerName;

  if (req.query.agent_id !== undefined && req.query.agent_id !== '') {
    const aid = Number(req.query.agent_id);
    if (Number.isInteger(aid) && aid > 0) filter.claimed_by_agent_id = aid;
  }

  if (!podeVerTodos(actor)) {
    filter.requested_by = actor.id;
  } else if (req.query.usuario_id !== undefined && req.query.usuario_id !== '') {
    const uid = Number(req.query.usuario_id);
    if (Number.isInteger(uid) && uid > 0) filter.requested_by = uid;
  }

  const page = Math.max(1, Number(req.query.page) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 20));
  const qRaw = texto(req.query.q, 80)?.toLowerCase() || '';
  const reprintOnly = req.query.reprint_only === 'true' || req.query.reprint_only === '1';
  const deStr = texto(req.query.de, 30);
  const ateStr = texto(req.query.ate, 30);
  const deMs = deStr ? Date.parse(deStr.length === 10 ? `${deStr}T00:00:00.000Z` : deStr) : NaN;
  const ateMs = ateStr ? Date.parse(ateStr.length === 10 ? `${ateStr}T23:59:59.999Z` : ateStr) : NaN;

  const precisaFiltroPos = Boolean(qRaw || reprintOnly || !Number.isNaN(deMs) || !Number.isNaN(ateMs));

  let rows: Row[];
  let total: number;

  if (!precisaFiltroPos) {
    const out = await s.list(R_JOBS(), { page, pageSize, filter, sort: 'criado_em', dir: 'desc' });
    rows = out.rows;
    total = out.total;
  } else {
    // Janela limitada (máx. 1000 mais recentes nos índices por empresa) para filtros textuais/período
    const scan = await s.list(R_JOBS(), { page: 1, pageSize: 1000, filter, sort: 'criado_em', dir: 'desc' });
    const filtrados = scan.rows.filter((r) => {
      if (reprintOnly && !r.reprint_of) return false;
      const criadoMs = r.criado_em ? Date.parse(String(r.criado_em)) : NaN;
      if (!Number.isNaN(deMs) && (Number.isNaN(criadoMs) || criadoMs < deMs)) return false;
      if (!Number.isNaN(ateMs) && (Number.isNaN(criadoMs) || criadoMs > ateMs)) return false;
      if (qRaw) {
        const alvo = [
          r.public_id,
          r.source_ref,
          r.terminal,
          r.printer_name,
          r.last_error,
          r.last_error_code,
          r.reprint_of,
          r.reprint_reason,
        ]
          .filter(Boolean)
          .join(' ')
          .toLowerCase();
        if (!alvo.includes(qRaw)) return false;
      }
      return true;
    });
    total = filtrados.length;
    const offset = (page - 1) * pageSize;
    rows = filtrados.slice(offset, offset + pageSize);
  }

  // Enriquecimento leve de nomes (somente registros da mesma empresa)
  const [usersRes, agentsRes] = await Promise.all([
    s.list(getResource('usuarios')!, { page: 1, pageSize: 200, filter: { empresa_id: escopo.empresaId } }),
    s.list(R_AGENTS(), { page: 1, pageSize: 200, filter: { empresa_id: escopo.empresaId } }),
  ]);
  const userMap = new Map<number, string>();
  for (const u of usersRes.rows) userMap.set(Number(u.id), String(u.nome || u.email || `#${u.id}`));
  const agentMap = new Map<number, string>();
  for (const a of agentsRes.rows) agentMap.set(Number(a.id), String(a.nome || a.machine_id || `#${a.id}`));

  const enriquecidos = rows.map((r) => ({
    ...jobPublico(r),
    requested_by_nome: r.requested_by ? userMap.get(Number(r.requested_by)) ?? null : null,
    agent_nome: r.claimed_by_agent_id ? agentMap.get(Number(r.claimed_by_agent_id)) ?? null : null,
  }));

  res.json({ rows: enriquecidos, total, page, pageSize });
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

export const MAX_COPIAS_REIMPRESSAO = 10;

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
  const body = (req.body ?? {}) as Record<string, unknown>;
  const terminalAlvo = body.terminal !== undefined ? texto(body.terminal, PRINT_LIMITS.terminalMax) : ((job.terminal as string) || null);
  const printerAlvo =
    body.printer_name !== undefined
      ? validarNomeImpressoraOpcional(body.printer_name, 'Impressora')
      : ((job.printer_name as string) || null);

  if (!podeVerTodos(actor) && terminalAlvo) {
    const dest = await resolverDestinoImpressao(escopo.empresaId, 'padrao', { terminal: terminalAlvo });
    if (!dest.allowOperatorReprint) {
      throw new HttpError(403, 'Reimpressão neste terminal exige perfil gerente ou administrador.');
    }
  }

  const copies = Number(body.copies ?? job.copies ?? 1);
  if (!Number.isInteger(copies) || copies < 1 || copies > MAX_COPIAS_REIMPRESSAO) {
    throw new HttpError(400, `Número de cópias na reimpressão deve estar entre 1 e ${MAX_COPIAS_REIMPRESSAO}.`);
  }

  const motivo = texto(body.motivo ?? body.reprint_reason, 240);
  const chave = texto(body.idempotency_key ?? req.header('idempotency-key'), PRINT_LIMITS.idempotencyKeyMax)
    || `reprint:${job.public_id}:${randomUUID()}`;

  const metadataBase = ((job.metadata as Record<string, unknown>) || {});
  const { job: novo, idempotente } = await enfileirarJob(
    escopo.empresaId,
    atorDeUsuario(actor),
    {
      docType: String(job.doc_type),
      source: String(job.source),
      sourceRef: (job.source_ref as string) || null,
      terminal: terminalAlvo,
      printerName: printerAlvo,
      copies,
      priority: Number(job.priority) || 0,
      content: (job.payload as NovoJobImpressao['content']) || [],
      metadata: {
        ...metadataBase,
        reprint: true,
        ...(motivo ? { reprint_reason: motivo } : {}),
      },
      idempotencyKey: chave,
      maxAttempts: Number(job.max_attempts) || 3,
    },
    { reprintOf: String(job.public_id), reprintReason: motivo }
  );
  if (!idempotente) {
    await auditarImpressao(
      atorDeUsuario(actor),
      'print.job.reprinted',
      novo,
      motivo ? `Reimpressão do job ${job.public_id} (${motivo})` : `Reimpressão do job ${job.public_id}`,
      { origem: job.public_id, motivo: motivo ?? undefined, copies }
    );
  }
  res.status(idempotente ? 200 : 201).json({ job: jobPublico(novo), idempotente });
}

// ----------------------------------------------------------------------------
// Recuperação de órfãos, observabilidade e retenção/limpeza periódica (P5/P6)
// ----------------------------------------------------------------------------

/**
 * Recupera jobs presos em CLAIMED/PRINTING cujo lease expirou (ex.: agente
 * caiu e não voltou). Respeita `max_attempts` para evitar loop infinito.
 */
export async function recuperarJobsOrfaos(empresaId?: number): Promise<{ reabertos: number; falhados: number }> {
  const s = getStore();
  const agora = Date.now();
  const agoraIso = new Date(agora).toISOString();
  let reabertos = 0;
  let falhados = 0;

  for (const status of ['CLAIMED', 'PRINTING'] as const) {
    const filter: Record<string, unknown> = { status };
    if (empresaId !== undefined) filter.empresa_id = empresaId;
    const { rows } = await s.list(R_JOBS(), { page: 1, pageSize: 200, filter, sort: 'criado_em', dir: 'asc' });
    for (const j of rows) {
      if (!leaseExpirado(j, agora)) continue;
      const esgotou = Number(j.attempts || 0) >= Number(j.max_attempts || 3);
      if (esgotou) {
        const up = await s.tryUpdateIf(
          R_JOBS(),
          Number(j.id),
          { status, lease_token_hash: j.lease_token_hash },
          {
            status: 'FAILED',
            failed_at: agoraIso,
            lease_token_hash: null,
            lease_expires_at: null,
            claimed_by_agent_id: null,
            next_retry_at: null,
            permanent_error: true,
            last_error_code: 'LEASE_EXPIRED_MAX_ATTEMPTS',
            last_error: 'Lease expirou após esgotar o número máximo de tentativas.',
          }
        );
        if (up) {
          falhados++;
          await auditarImpressao(
            { usuario_id: null, usuario: 'sistema:manutencao' },
            'print.job.orphan_failed',
            up,
            'Job órfão encerrado em FAILED após esgotar tentativas'
          );
        }
      } else {
        const up = await s.tryUpdateIf(
          R_JOBS(),
          Number(j.id),
          { status, lease_token_hash: j.lease_token_hash },
          {
            status: 'QUEUED',
            lease_token_hash: null,
            lease_expires_at: null,
            claimed_by_agent_id: null,
            printing_at: null,
            next_retry_at: null,
          }
        );
        if (up) {
          reabertos++;
          await auditarImpressao(
            { usuario_id: null, usuario: 'sistema:manutencao' },
            'print.job.lease_recovered',
            up,
            'Lease expirado recuperado automaticamente para QUEUED'
          );
        }
      }
    }
  }
  return { reabertos, falhados };
}

/**
 * Política de retenção e limpeza periódica (P6.7):
 *   • Nonces de replay vencidos (> 24h por padrão, janela ativa é 5 min);
 *   • Códigos de pareamento expirados há mais de 7 dias;
 *   • Jobs terminais (PRINTED, FAILED, CANCELLED) com mais de N dias
 *     (`PRINT_JOBS_RETENTION_DAYS`, padrão 90 dias), preservando a trilha
 *     assinada em `auditoria`.
 */
export async function limparFilaImpressaoPeriodica(opts: {
  nonceMaxAgeMs?: number;
  pairingMaxAgeMs?: number;
  jobRetentionDays?: number;
} = {}): Promise<{
  orfaosReabertos: number;
  orfaosFalhados: number;
  noncesRemovidos: number;
  pairingsRemovidos: number;
  jobsAntigosRemovidos: number;
}> {
  const s = getStore();
  const agora = Date.now();
  const nonceCorte = agora - (opts.nonceMaxAgeMs ?? 24 * 3600_000);
  const pairingCorte = agora - (opts.pairingMaxAgeMs ?? 7 * 24 * 3600_000);
  const retentionDays = opts.jobRetentionDays ?? Math.max(7, Number(process.env.PRINT_JOBS_RETENTION_DAYS) || 90);
  const jobCorte = agora - retentionDays * 24 * 3600_000;

  const orfaos = await recuperarJobsOrfaos();

  let noncesRemovidos = 0;
  const nonces = await s.list(R_NONCES(), { page: 1, pageSize: 500, sort: 'criado_em', dir: 'asc' });
  for (const n of nonces.rows) {
    const t = n.criado_em ? Date.parse(String(n.criado_em)) : NaN;
    if (!Number.isNaN(t) && t < nonceCorte) {
      if (await s.remove(R_NONCES(), Number(n.id))) noncesRemovidos++;
    }
  }

  let pairingsRemovidos = 0;
  const pairings = await s.list(R_PAIRING(), { page: 1, pageSize: 300, sort: 'criado_em', dir: 'asc' });
  for (const p of pairings.rows) {
    const exp = p.expires_at ? Date.parse(String(p.expires_at)) : NaN;
    if (!Number.isNaN(exp) && exp < pairingCorte) {
      if (await s.remove(R_PAIRING(), Number(p.id))) pairingsRemovidos++;
    }
  }

  let jobsAntigosRemovidos = 0;
  for (const status of ['PRINTED', 'FAILED', 'CANCELLED'] as const) {
    const antigos = await s.list(R_JOBS(), { page: 1, pageSize: 300, filter: { status }, sort: 'criado_em', dir: 'asc' });
    for (const j of antigos.rows) {
      const t = j.criado_em ? Date.parse(String(j.criado_em)) : NaN;
      if (!Number.isNaN(t) && t < jobCorte) {
        if (await s.remove(R_JOBS(), Number(j.id))) jobsAntigosRemovidos++;
      }
    }
  }

  return {
    orfaosReabertos: orfaos.reabertos,
    orfaosFalhados: orfaos.falhados,
    noncesRemovidos,
    pairingsRemovidos,
    jobsAntigosRemovidos,
  };
}

/**
 * GET /api/print/resumo — observabilidade operacional da fila por empresa,
 * sem vazar segredos, tokens ou dados de outros tenants.
 */
export async function resumoOperacionalImpressaoHandler(req: Request, res: Response): Promise<void> {
  const { actor, escopo } = escopoDaReq(req);
  const s = getStore();
  const baseFilter: Record<string, unknown> = { empresa_id: escopo.empresaId };
  if (!podeVerTodos(actor)) baseFilter.requested_by = actor.id;

  const [queued, claimed, printing, failed, cancelled, recentJobs, agents, terminals] = await Promise.all([
    s.countWhere(R_JOBS(), { ...baseFilter, status: 'QUEUED' }),
    s.countWhere(R_JOBS(), { ...baseFilter, status: 'CLAIMED' }),
    s.countWhere(R_JOBS(), { ...baseFilter, status: 'PRINTING' }),
    s.countWhere(R_JOBS(), { ...baseFilter, status: 'FAILED' }),
    s.countWhere(R_JOBS(), { ...baseFilter, status: 'CANCELLED' }),
    s.list(R_JOBS(), { page: 1, pageSize: 200, filter: baseFilter, sort: 'criado_em', dir: 'desc' }),
    s.list(R_AGENTS(), { page: 1, pageSize: 100, filter: { empresa_id: escopo.empresaId } }),
    s.list(R_TERMINALS(), { page: 1, pageSize: 100, filter: { empresa_id: escopo.empresaId, ativo: true } }),
  ]);

  const agora = Date.now();
  const corte24h = agora - 24 * 3600_000;
  let printed24h = 0;
  let reprints24h = 0;
  let orphanLeases = 0;
  for (const j of recentJobs.rows) {
    const criadoMs = j.criado_em ? Date.parse(String(j.criado_em)) : 0;
    if (j.status === 'PRINTED' && criadoMs >= corte24h) printed24h++;
    if (j.reprint_of && criadoMs >= corte24h) reprints24h++;
    if ((j.status === 'CLAIMED' || j.status === 'PRINTING') && leaseExpirado(j, agora)) orphanLeases++;
  }

  let agentsOnline = 0;
  let agentsAtivos = 0;
  let agentsRevogados = 0;
  for (const a of agents.rows) {
    if (a.status === 'ativo') {
      agentsAtivos++;
      const hb = a.last_heartbeat_at ? Date.parse(String(a.last_heartbeat_at)) : 0;
      if (hb > 0 && agora - hb <= 120_000) agentsOnline++;
    } else {
      agentsRevogados++;
    }
  }

  res.json({
    fila: {
      queued,
      claimed,
      printing,
      failed,
      cancelled,
      printed_24h: printed24h,
      reprints_24h: reprints24h,
      orphan_leases: orphanLeases,
    },
    agentes: {
      total: agents.total,
      ativos: agentsAtivos,
      online: agentsOnline,
      revogados: agentsRevogados,
    },
    terminais_ativos: terminals.total,
  });
}

/** POST /api/print/manutencao — recupera órfãos da empresa sob demanda (gerente/admin). */
export async function manutencaoImpressaoHandler(req: Request, res: Response): Promise<void> {
  const actor = currentUser(req);
  if (actor.perfil !== 'admin' && actor.perfil !== 'gerente') {
    throw new HttpError(403, 'Apenas administradores e gerentes podem executar manutenção da fila.');
  }
  const escopo = escopoDe(actor);
  const out = await recuperarJobsOrfaos(escopo.empresaId);
  res.json({ ok: true, ...out });
}
