// ============================================================================
// CONTROL PLANE › APLICAÇÃO › DISPATCH DO WORKFLOW
//
// É o ÚNICO ponto que fala com o GitHub Actions. Antes de enviar:
//   1. autoriza (escopo + perfil);
//   2. resolve o workflow do REGISTRO e exige habilitado;
//   3. confere a REF contra a allowlist (branch validada no servidor);
//   4. exige APROVAÇÃO VÁLIDA e vinculada ao hash dos parâmetros;
//   5. confere prazo e não-expiração;
//   6. confere o LIMITE DE CONCORRÊNCIA;
//   7. CONSUME a aprovação atomicamente e leva a operação a `dispatching`
//      sob CAS — duas instâncias jamais despacham a mesma operação;
//   8. registra a INTENÇÃO antes do envio;
//   9. despacha UMA ÚNICA VEZ.
//
// Timeout/erro de rede DEPOIS do envio: a operação fica em `dispatching`
// (resultado DESCONHECIDO) e a RECONCILIAÇÃO resolve — nunca repetimos
// automaticamente um dispatch cujo resultado é incerto.
// ============================================================================
import { OperationalError } from '../domain/errors';
import { exigirAutorizacao } from '../policies/authorization-policy';
import { exigirWorkflowRegistrado, exigirWorkflowHabilitado } from '../policies/workflow-allowlist';
import { resolverRef } from '../policies/branch-policy';
import { hashParametros } from '../policies/parameter-policy';
import { exigirAprovacaoValida } from '../domain/approval-policy';
import { estadoEfetivo, exigirTransicao } from '../domain/operation-status';
import { operacaoPorPublicId, transicionarStatus, listarOperacoes } from '../infrastructure/operation.repository';
import { aprovacaoDaOperacao, consumirAprovacao } from '../infrastructure/approval.repository';
import { criarExecucao, execucaoDaOperacao } from '../infrastructure/execution.repository';
import { auditarOperacao } from '../infrastructure/audit';
import { githubActions } from '../infrastructure/github-actions.client';
import type { GithubActionsClient } from '../infrastructure/github-actions.client';
import type { OperationalActor, OperationRow } from '../domain/operation';

/** Estados de operação que contam como "execução em andamento" para o limite. */
const EM_ANDAMENTO = ['dispatching', 'dispatched', 'running'] as const;

export type DispatchDeps = { actions?: GithubActionsClient };

export async function despacharOperacao(actor: OperationalActor, operationId: string, deps: DispatchDeps = {}): Promise<OperationRow> {
  exigirAutorizacao(actor, 'workflow.request');
  const actions = deps.actions ?? githubActions;

  const op = await operacaoPorPublicId(actor.empresa_id, operationId);
  if (!op) throw new OperationalError('NAO_ENCONTRADO', 'Operação não encontrada.');

  const statusEfetivo = estadoEfetivo(op.status, op.expires_at);
  if (statusEfetivo === 'expired') throw new OperationalError('POLITICA_REJEITOU', 'A operação expirou.');
  exigirTransicao(statusEfetivo, 'dispatching');
  if (statusEfetivo !== 'approved') {
    throw new OperationalError('CONFLITO', `A operação está em "${statusEfetivo}"; o dispatch exige "approved".`);
  }

  const def = exigirWorkflowRegistrado(op.workflow_key);
  exigirWorkflowHabilitado(def);

  const params = (op.parameters ?? {}) as Record<string, unknown>;
  const ref = resolverRef(def, params.ref);
  const inputs = { ...params };
  delete inputs.ref;
  // O hash cobre `ref` + parâmetros — o MESMO cálculo da solicitação.
  const parametersHash = hashParametros({ ref, ...inputs });
  if (parametersHash !== String(op.parameters_hash)) {
    throw new OperationalError('POLITICA_REJEITOU', 'Os parâmetros da operação divergem do hash registrado.');
  }

  const aprovacao = await aprovacaoDaOperacao(Number(op.id));
  exigirAprovacaoValida(aprovacao, parametersHash);

  // LIMITE DE CONCORRÊNCIA: conta as execuções da MESMA empresa/workflow em curso.
  const emCurso = await listarOperacoes(actor.empresa_id, { workflowKey: def.key, limit: 100 });
  const concorrentes = emCurso.filter((o) => Number(o.id) !== Number(op.id) && (EM_ANDAMENTO as readonly string[]).includes(String(o.status))).length;
  if (concorrentes >= def.maximumConcurrentExecutions) {
    throw new OperationalError('CONFLITO', `O limite de ${def.maximumConcurrentExecutions} execução(ões) simultânea(s) do workflow "${def.key}" foi atingido.`);
  }

  // PASSO CRÍTICO — CAS: consome a aprovação e trava a operação em `dispatching`.
  const consumiu = await consumirAprovacao(actor.empresa_id, Number(aprovacao!.id));
  if (!consumiu) throw new OperationalError('CONFLITO', 'A aprovação já foi consumida por outra execução.');
  const travada = await transicionarStatus(actor.empresa_id, Number(op.id), op.status, 'dispatching');
  if (!travada) throw new OperationalError('CONFLITO', 'Outra instância já iniciou o dispatch desta operação.');

  // Registra a INTENÇÃO antes de enviar ao GitHub (rastreabilidade do desconhecido).
  await auditarOperacao({
    empresaId: actor.empresa_id,
    operationId: Number(op.id),
    actorId: actor.id,
    eventType: 'operation.dispatched',
    payload: { workflow_key: def.key, ref, fase: 'intencao' },
  });

  let execucao = await execucaoDaOperacao(Number(op.id));
  if (!execucao) execucao = await criarExecucao({ empresaId: actor.empresa_id, operationId: Number(op.id), workflowKey: def.key, branch: ref });

  // O workflow ainda existe no repositório? (verificação 9) — antes do envio.
  let existe = true;
  try {
    existe = await actions.workflowExiste(def.repository, def.workflowFile);
  } catch (e) {
    // Falha de comunicação ANTES do envio: pode voltar a `approved` com segurança.
    await transicionarStatus(actor.empresa_id, Number(op.id), 'dispatching', 'dispatch_failed');
    await auditarOperacao({
      empresaId: actor.empresa_id,
      operationId: Number(op.id),
      actorId: actor.id,
      eventType: 'github.communication_failed',
      payload: { fase: 'preflight', erro: e instanceof Error ? e.message.slice(0, 200) : 'erro' },
    });
    throw e instanceof OperationalError ? e : new OperationalError('GITHUB_INDISPONIVEL', 'Falha ao verificar o workflow no GitHub.');
  }
  if (!existe) {
    await transicionarStatus(actor.empresa_id, Number(op.id), 'dispatching', 'dispatch_failed');
    await auditarOperacao({
      empresaId: actor.empresa_id,
      operationId: Number(op.id),
      actorId: actor.id,
      eventType: 'operation.dispatch_failed',
      payload: { motivo: 'workflow_ausente' },
    });
    throw new OperationalError('POLITICA_REJEITOU', 'O workflow registrado não existe mais no repositório.');
  }

  try {
    await actions.dispatch(def.repository, def.workflowFile, ref, inputs);
  } catch {
    // ERRO DEPOIS do envio: o resultado é DESCONHECIDO. NÃO repetimos —
    // a reconciliação é quem confirma. A operação fica em `dispatching`.
    await auditarOperacao({
      empresaId: actor.empresa_id,
      operationId: Number(op.id),
      actorId: actor.id,
      eventType: 'github.communication_failed',
      payload: { fase: 'dispatch', resultado: 'desconhecido' },
    });
    throw new OperationalError(
      'GITHUB_INDISPONIVEL',
      'O envio ao GitHub não foi confirmado; o resultado é desconhecido e será reconciliado (nenhum reenvio automático).'
    );
  }

  // Sucesso confirmado (204): a execução fica aguardando o run id na reconciliação.
  const atualizada = await transicionarStatus(actor.empresa_id, Number(op.id), 'dispatching', 'dispatched');
  return atualizada ?? travada;
}
