// ============================================================================
// CONTROL PLANE › DOMÍNIO › POLÍTICA DE APROVAÇÃO (PURO)
//
// Regras (especificação §10.2):
//   • vinculada a UMA operação específica;
//   • vinculada ao HASH dos parâmetros — mudar o parâmetro invalida;
//   • com prazo de validade;
//   • de USO ÚNICO (consumida atomicamente no dispatch);
//   • feita por usuário AUTORIZADO (admin/aprovador designado);
//   • o AGENTE MCP não aprova a própria solicitação.
// ============================================================================
import { OperationalError } from './errors';
import type { ApprovalRow, OperationalActor } from './operation';

/** O agente MCP nunca aprova — nem por conveniência operacional. */
export function exigirAprovadorHumano(actor: OperationalActor): void {
  if (actor.viaMcp) {
    throw new OperationalError('SEM_PERMISSAO', 'O agente MCP não pode aprovar a própria solicitação. A aprovação é humana e ocorre no ERP.');
  }
  if (actor.perfil !== 'admin') {
    throw new OperationalError('SEM_PERMISSAO', 'Somente o aprovador designado (administrador) pode aprovar operações.');
  }
}

/** A aprovação é válida para ESTA operação e ESTE hash, dentro do prazo e não consumida? */
export function aprovacaoValida(
  aprovacao: ApprovalRow | null | undefined,
  parametersHash: string,
  agora: Date = new Date()
): boolean {
  if (!aprovacao) return false;
  if (aprovacao.decision !== 'approve') return false;
  if (aprovacao.consumed_at) return false;
  if (aprovacao.parameters_hash !== parametersHash) return false;
  if (new Date(aprovacao.expires_at).getTime() <= agora.getTime()) return false;
  return true;
}

/** Exige uma aprovação válida; lança 422 quando não há. */
export function exigirAprovacaoValida(
  aprovacao: ApprovalRow | null | undefined,
  parametersHash: string,
  agora: Date = new Date()
): ApprovalRow {
  if (!aprovacao) throw new OperationalError('POLITICA_REJEITOU', 'A operação exige aprovação humana antes do dispatch.');
  if (aprovacao.consumed_at) throw new OperationalError('CONFLITO', 'A aprovação já foi consumida (uso único).');
  if (aprovacao.parameters_hash !== parametersHash) {
    throw new OperationalError('POLITICA_REJEITOU', 'A aprovação não corresponde aos parâmetros atuais da operação.');
  }
  if (new Date(aprovacao.expires_at).getTime() <= agora.getTime()) {
    throw new OperationalError('POLITICA_REJEITOU', 'A aprovação expirou.');
  }
  if (aprovacao.decision !== 'approve') throw new OperationalError('POLITICA_REJEITOU', 'A operação foi rejeitada.');
  return aprovacao;
}
