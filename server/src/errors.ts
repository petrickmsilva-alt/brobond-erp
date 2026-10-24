// Erro HTTP com status e (opcionalmente) erros por campo e um código estável
// para o front reagir (ex.: 'reauth_necessaria' → abrir modal de reautenticação).
export class HttpError extends Error {
  status: number;
  fields?: Record<string, unknown>;
  code?: string;
  /**
   * Dados estruturados que acompanham o erro (ex.: o diagnóstico de
   * dependências em `{ dependencias: {...} }`). O middleware de erro devolve
   * isso em `details`; `fields` continua reservado a erros por campo.
   */
  details?: Record<string, unknown>;

  constructor(status: number, message: string, fields?: Record<string, unknown>, code?: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.fields = fields;
    this.code = code;
    this.details = details;
  }
}

export function isHttpError(e: unknown): e is HttpError {
  return e instanceof HttpError;
}
