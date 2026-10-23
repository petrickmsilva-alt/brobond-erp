// ============================================================
// Auditoria segura — cadeia de hashes (tamper-evidence).
//
// Cada evento grava hash_anterior + hash = SHA-256(hash_anterior | payload
// canônico). Editar um evento quebra o hash dele; remover um evento quebra a
// cadeia do seguinte. `verificarCadeiaAuditoria` percorre tudo em ordem de id
// e lista os registros comprometidos.
// ============================================================
import { createHash } from 'node:crypto';
import type { AuditEntry, AuditoriaVerificacao } from './store';

/**
 * Formato persistido de um instante na auditoria: ISO-8601 em **UTC com
 * milissegundos** (`Date.prototype.toISOString()`), ex.: `2026-10-17T12:34:56.789Z`.
 *
 * É o formato que `JSON.stringify`/JSONB e o Express já produzem, então o
 * instante gravado e o lido de volta são idênticos. Instante inválido devolve
 * `null` (mesma semântica de `JSON.stringify(new Date(NaN))`).
 */
export function instanteAuditoriaISO(d: Date): string | null {
  const ms = d.getTime();
  return Number.isNaN(ms) ? null : d.toISOString();
}

/**
 * Normaliza recursivamente o payload de auditoria para o formato persistido,
 * substituindo todo `Date` pelo seu ISO-8601 UTC com milissegundos.
 *
 * JSONB não tem tipo nativo de data: sem isto, `JSON.stringify` (persistência)
 * converte o `Date` em string, mas a assinatura da cadeia seria calculada sobre
 * o objeto cru — o instante nunca entrava no hash e a cadeia "quebrava" na
 * releitura. Objetos e arrays são percorridos em profundidade. Um `Date`
 * inválido é recusado explicitamente (nunca silenciosamente descartado).
 */
export function normalizarPayloadAuditoria(v: unknown): unknown {
  if (v instanceof Date) {
    const iso = instanteAuditoriaISO(v);
    if (iso === null) throw new Error('Auditoria: instante inválido (Invalid Date) não pode ser persistido.');
    return iso;
  }
  if (Array.isArray(v)) return v.map(normalizarPayloadAuditoria);
  if (v !== null && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = normalizarPayloadAuditoria(val);
    return out;
  }
  return v;
}

/**
 * JSON canônico (chaves ordenadas) — estável entre Postgres (JSONB) e memória.
 *
 * INVARIANTE: `jsonCanônico(x)` precisa ser igual a
 * `jsonCanônico(JSON.parse(JSON.stringify(x)))`. A assinatura é calculada sobre
 * o objeto em memória, mas o que fica gravado é o JSON serializado; se os dois
 * divergirem, a cadeia "quebra" na releitura sem que ninguém tenha adulterado
 * nada.
 *
 * `JSON.stringify` DESCARTA chaves de valor `undefined` dentro de objetos —
 * então o canônico também precisa descartá-las. Antes, `{reprint_of: undefined}`
 * era assinado como `{"reprint_of":null}` e persistido como `{}`, o que fazia a
 * verificação acusar quebra nos eventos que montam o payload com `?? undefined`
 * (ex.: `reprint_of` e `recuperado_de_lease` em printJobs.ts).
 */
export function jsonCanônico(v: unknown): string {
  if (v === null || v === undefined) return 'null';
  // Rede de segurança: se um Date chegar aqui sem passar por
  // normalizarPayloadAuditoria, use o MESMO formato persistido — assim a
  // assinatura na gravação e na releitura nunca divergem. Um Date inválido
  // seria assinado como `null` (`JSON.stringify(null)`) e descartado em
  // silêncio; para manter a regra documentada, é recusado aqui também.
  if (v instanceof Date) {
    const iso = instanteAuditoriaISO(v);
    if (iso === null) throw new Error('Auditoria: instante inválido (Invalid Date) não pode ser assinado.');
    return JSON.stringify(iso);
  }
  if (typeof v !== 'object') return JSON.stringify(v);
  // Array: `JSON.stringify` converte `undefined` em `null` (não descarta), e é
  // isso que o canônico faz — `jsonCanônico(undefined)` já devolve 'null'.
  if (Array.isArray(v)) return '[' + v.map(jsonCanônico).join(',') + ']';
  const obj = v as Record<string, unknown>;
  return '{' + Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort()
    .map((k) => JSON.stringify(k) + ':' + jsonCanônico(obj[k]))
    .join(',') + '}';
}

/** Campos que entram na assinatura (id, data, hash* ficam de fora). */
function payloadAssinavel(e: AuditEntry | Record<string, any>): string {
  return jsonCanônico({
    usuario_id: e.usuario_id ?? null,
    usuario: e.usuario ?? null,
    acao: e.acao,
    recurso: e.recurso ?? null,
    registro_id: e.registro_id ?? null,
    descricao: e.descricao ?? '',
    dados: e.dados ?? null,
  });
}

export function hashCadeiaAuditoria(hashAnterior: string, entry: AuditEntry | Record<string, any>): string {
  return createHash('sha256').update(`${hashAnterior}|${payloadAssinavel(entry)}`).digest('hex');
}

type LinhaAuditoria = Record<string, any>;

/** Percorre a trilha em ordem de id e devolve o resultado da verificação. */
export function verificarCadeiaAuditoria(rows: LinhaAuditoria[]): AuditoriaVerificacao {
  const ordenadas = [...rows].sort((a, b) => Number(a?.id ?? 0) - Number(b?.id ?? 0));
  const quebras: number[] = [];
  let anterior = '';
  let verificadas = 0;
  for (const row of ordenadas) {
    const esperado = hashCadeiaAuditoria(anterior, row);
    const hashGravado = row.hash ? String(row.hash) : '';
    const anteriorGravado = row.hash_anterior ? String(row.hash_anterior) : '';
    if (hashGravado !== esperado || anteriorGravado !== anterior) quebras.push(Number(row.id));
    else verificadas++;
    anterior = hashGravado || anterior;
  }
  return { ok: quebras.length === 0, total: ordenadas.length, verificadas, quebras };
}
