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

/** JSON canônico (chaves ordenadas) — estável entre Postgres (JSONB) e memória. */
export function jsonCanônico(v: unknown): string {
  if (v === null || v === undefined) return 'null';
  if (typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(jsonCanônico).join(',') + ']';
  const obj = v as Record<string, unknown>;
  return '{' + Object.keys(obj)
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
