// Erro HTTP com status e (opcionalmente) erros por campo — usado por validação e regras de negócio.
export class HttpError extends Error {
  status: number;
  fields?: Record<string, string>;

  constructor(status: number, message: string, fields?: Record<string, string>) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.fields = fields;
  }
}

export function isHttpError(e: unknown): e is HttpError {
  return e instanceof HttpError;
}
