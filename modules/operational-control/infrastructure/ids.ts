// ============================================================================
// CONTROL PLANE › INFRA › IDENTIFICADORES OPACOS
//
// O id exposto pela API (`op_...`, `exec_...`) é OPACO e aleatório: não revela
// ordem de criação nem permite adivinhar o id do vizinho (evita IDOR por
// enumeração). A chave primária no banco continua sendo `id SERIAL` (convenção
// do ERP) e vive só internamente.
// ============================================================================
import { randomBytes } from 'node:crypto';

/** Alfabeto Crockford base32 (sem I, L, O, U) — legível e estável. */
const ALFABETO = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function aleatorio(tamanho = 26): string {
  const bytes = randomBytes(tamanho);
  let saida = '';
  for (let i = 0; i < tamanho; i++) saida += ALFABETO[bytes[i] % 32];
  return saida;
}

export function novoIdOperacao(): string {
  return `op_${aleatorio()}`;
}

export function novoIdExecucao(): string {
  return `exec_${aleatorio()}`;
}
