// ============================================================================
// CONTROL PLANE › HTTP › ERROS
//
// Reexporta o domínio para o HTTP e garante que a mensagem pública NÃO revela
// detalhe interno. O middleware global do ERP já serializa `HttpError` com
// `status`, `error`, `fields` e `code`; aqui só normalizamos a taxonomia.
// ============================================================================
export { OperationalError, ehErroOperacional } from '../domain/errors';
export type { OperationalErrorCode } from '../domain/errors';
