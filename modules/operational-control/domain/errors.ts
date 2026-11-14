// ============================================================================
// CONTROL PLANE › DOMÍNIO › ERROS
//
// Erros do domínio operacional carregam um CÓDIGO ESTÁVEL (o front e o MCP
// reagem por ele, nunca pela mensagem). `status` é o HTTP correspondente —
// mantém o contrato da especificação sem espalhar números pelo código.
// ============================================================================
import { HttpError } from '../../../server/src/errors';

export type OperationalErrorCode =
  | 'PARAMETRO_INVALIDO'
  | 'NAO_AUTENTICADO'
  | 'SEM_PERMISSAO'
  | 'NAO_ENCONTRADO'
  | 'CONFLITO'
  | 'POLITICA_REJEITOU'
  | 'LIMITE_EXCEDIDO'
  | 'GITHUB_INDISPONIVEL'
  | 'DEPENDENCIA_INDISPONIVEL'
  | 'OPERACAO_NAO_HABILITADA';

const STATUS: Record<OperationalErrorCode, number> = {
  PARAMETRO_INVALIDO: 400,
  NAO_AUTENTICADO: 401,
  SEM_PERMISSAO: 403,
  NAO_ENCONTRADO: 404,
  CONFLITO: 409,
  POLITICA_REJEITOU: 422,
  LIMITE_EXCEDIDO: 429,
  GITHUB_INDISPONIVEL: 502,
  DEPENDENCIA_INDISPONIVEL: 503,
  OPERACAO_NAO_HABILITADA: 422,
};

/** Erro de domínio do Control Plane. Nunca carrega segredo nem corpo remoto. */
export class OperationalError extends HttpError {
  readonly codigo: OperationalErrorCode;

  constructor(codigo: OperationalErrorCode, mensagem: string, fields?: Record<string, unknown>) {
    super(STATUS[codigo], mensagem, fields, codigo);
    this.name = 'OperationalError';
    this.codigo = codigo;
  }
}

export function ehErroOperacional(e: unknown): e is OperationalError {
  return e instanceof OperationalError;
}
