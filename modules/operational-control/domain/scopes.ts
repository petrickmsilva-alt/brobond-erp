// ============================================================================
// CONTROL PLANE › DOMÍNIO › ESCOPOS OAUTH
//
// Escopos iniciais — NENHUM escopo de escrita genérica. Os escopos são o teto
// concedido ao cliente OAuth; a autorização EFETIVA é a interseção com a
// permissão do usuário e a política operacional (ver authorization-policy.ts).
// ============================================================================
export const SCOPES = {
  systemRead: 'brobond:system:read',
  githubRead: 'brobond:github:read',
  workflowRead: 'brobond:workflow:read',
  workflowRequest: 'brobond:workflow:request',
  workflowApprove: 'brobond:workflow:approve',
  auditRead: 'brobond:audit:read',
} as const;

export type ScopeName = (typeof SCOPES)[keyof typeof SCOPES];

export const TODOS_OS_SCOPES: readonly ScopeName[] = Object.values(SCOPES);

/** Normaliza uma lista de escopos (string com espaço ou array) para um Set válido. */
export function normalizarEscopos(entrada: string | readonly string[] | null | undefined): string[] {
  const bruto = Array.isArray(entrada) ? entrada : String(entrada ?? '').split(/\s+/);
  const vistos = new Set<string>();
  for (const s of bruto) {
    const t = String(s).trim();
    if (t && (TODOS_OS_SCOPES as readonly string[]).includes(t)) vistos.add(t);
  }
  return [...vistos];
}

/** O escopo está presente? (interseção OAuth × permissão) */
export function temEscopo(scopes: readonly string[], necessario: string | readonly string[]): boolean {
  const exigidos = Array.isArray(necessario) ? necessario : [necessario];
  return exigidos.some((e) => scopes.includes(e));
}
