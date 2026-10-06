// Erro HTTP com status e (opcionalmente) erros por campo e um código estável
// para o front reagir (ex.: 'reauth_necessaria' → abrir modal de reautenticação).
export class HttpError extends Error {
  status: number;
  fields?: Record<string, unknown>;
  code?: string;

  constructor(status: number, message: string, fields?: Record<string, unknown>, code?: string) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.fields = fields;
    this.code = code;
  }
}

export function isHttpError(e: unknown): e is HttpError {
  return e instanceof HttpError;
}
