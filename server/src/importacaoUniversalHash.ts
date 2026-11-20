import { createHash } from 'node:crypto';

export function jsonCanonicoImportacaoUniversal(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (value instanceof Date) return JSON.stringify(value.toJSON()) ?? 'null';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) return '[' + value.map(jsonCanonicoImportacaoUniversal).join(',') + ']';
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    return '{' + Object.keys(obj)
      .filter((key) => obj[key] !== undefined && typeof obj[key] !== 'function' && typeof obj[key] !== 'symbol')
      .sort()
      .map((key) => JSON.stringify(key) + ':' + jsonCanonicoImportacaoUniversal(obj[key]))
      .join(',') + '}';
  }
  return 'null';
}

export function hashAprovacaoImportacaoUniversal(
  id: string,
  empresaId: number,
  sha256: string,
  versao: number,
  mapeamentoConfirmado: unknown,
  reconciliacao: unknown,
): string {
  return createHash('sha256').update(jsonCanonicoImportacaoUniversal({
    id,
    empresaId,
    sha256,
    versao,
    mapeamentoConfirmado,
    reconciliacao,
  })).digest('hex');
}
