// ============================================================================
// CONTROL PLANE › HTTP › ROTAS  (prefixo /api/operational-control)
//
// Todas as rotas exigem identidade (OAuth do MCP OU sessão do ERP), autorização
// específica, validação de entrada, rate limit e auditoria. O ator é resolvido
// por `identidadeOperacional` — NUNCA do corpo da requisição.
//
// Endpoints (especificação §6):
//   GET  /capabilities
//   POST /operations                      (Idempotency-Key)
//   GET  /operations                      (histórico autorizado)
//   GET  /operations/:id
//   POST /operations/:id/approve
//   POST /operations/:id/reject
//   POST /operations/:id/cancel
//   POST /operations/:id/dispatch
//   GET  /executions
//   GET  /executions/:id
//   POST /executions/reconciliar
//   GET  /audit
// ============================================================================
import { type NextFunction, type Request, type Response, Router } from 'express';
import { getStore } from '../../../server/src/services';
import { R_OPERATIONS } from '../infrastructure/resources';
import { exigirAutorizacao, capacidadesEfetivas } from '../policies/authorization-policy';
import { resumoRegistro, obterWorkflow } from '../domain/workflow-registry';
import { githubAppConfigurada } from '../infrastructure/token-vault';
import { limitarOperacao } from '../infrastructure/rate-limit';
import { identidadeOperacional, atorOperacional, exigirConfirmacaoHumana } from './operational-control.middleware';
import { validarSolicitar, validarAprovar, validarRejeitar, validarCancelar, validarFiltroExecucoes, idempotencyKeyDe } from './operational-control.schemas';
import { solicitarOperacao } from '../application/request-operation';
import { aprovarOperacao } from '../application/approve-operation';
import { rejeitarOperacao } from '../application/reject-operation';
import { cancelarOperacao } from '../application/cancel-operation';
import { despacharOperacao } from '../application/dispatch-workflow';
import { consultarOperacao } from '../application/get-operation';
import { listarOperacoesDoAtor, consultarExecucao } from '../application/list-operations';
import { listarExecucoes } from '../application/list-executions';
import { listarEventosAuditoria } from '../application/list-audit';
import { reconciliarEmpresa, reconciliarExecucao } from '../application/reconcile-execution';
import { serializarOperacao } from '../application/serialize';

const wrap = (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response, next: NextFunction) => {
  Promise.resolve(fn(req, res)).catch(next);
};

/** Wrapper para middleware de 3 argumentos (identidade/autenticação). */
const wrapMw = (fn: (req: Request, res: Response, next: NextFunction) => Promise<void>) => (req: Request, res: Response, next: NextFunction) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

export const operationalControlRouter: Router = Router();

// Toda a superfície exige identidade resolvida do token.
operationalControlRouter.use(wrapMw(identidadeOperacional));

// ---- GET /capabilities -----------------------------------------------------
operationalControlRouter.get('/capabilities', wrap(async (req, res) => {
  const actor = atorOperacional(req);
  await limitarOperacao(`capabilities|${actor.id}`);
  const caps = capacidadesEfetivas(actor);
  res.json({
    ok: true,
    capabilities: {
      ...caps,
      // Diagnóstico honesto: informa se a GitHub App e cada workflow estão prontos.
      github_app_configured: await githubAppConfigurada(),
      workflows: resumoRegistro(),
    },
  });
}));

// ---- POST /operations ------------------------------------------------------
operationalControlRouter.post('/operations', wrap(async (req, res) => {
  const actor = atorOperacional(req);
  await limitarOperacao(`solicitar|${actor.id}`);
  const entrada = validarSolicitar(req.body);
  const idempotencyKey = idempotencyKeyDe(req.headers['idempotency-key']);
  const { operation, reutilizada } = await solicitarOperacao(actor, { ...entrada, idempotencyKey });
  res.status(reutilizada ? 200 : 201).json({
    ok: true,
    operation: serializarOperacao(operation),
    idempotent_replay: reutilizada,
  });
}));

// ---- GET /operations (histórico autorizado) --------------------------------
operationalControlRouter.get('/operations', wrap(async (req, res) => {
  const actor = atorOperacional(req);
  await limitarOperacao(`listar|${actor.id}`);
  const operacoes = await listarOperacoesDoAtor(actor, validarFiltroExecucoes(req.query as Record<string, unknown>));
  res.json({ ok: true, operations: operacoes });
}));

// ---- GET /operations/:id ---------------------------------------------------
operationalControlRouter.get('/operations/:id', wrap(async (req, res) => {
  const actor = atorOperacional(req);
  await limitarOperacao(`ver|${actor.id}`);
  res.json({ ok: true, operation: await consultarOperacao(actor, String(req.params.id)) });
}));

// ---- GET /operations/:id/approval-context ----------------------------------
// Contexto de APROVAÇÃO para a interface do ERP: a operação + o workflow/branch
// resolvidos do REGISTRO interno (nunca do cliente) e a matriz de capacidades
// do ator. É leitura — a aprovação continua exigindo confirmação humana recente.
operationalControlRouter.get('/operations/:id/approval-context', wrap(async (req, res) => {
  const actor = atorOperacional(req);
  await limitarOperacao(`contexto|${actor.id}`);
  const operation = await consultarOperacao(actor, String(req.params.id));
  const workflowKey = String((operation as Record<string, unknown>).workflow_key ?? '');
  const def = obterWorkflow(workflowKey);
  const parametros = ((operation as Record<string, unknown>).parameters ?? {}) as Record<string, unknown>;
  res.json({
    ok: true,
    operation,
    workflow: def
      ? {
          key: def.key,
          repository: def.repository,
          workflow_file: def.workflowFile,
          operation: def.operation,
          requires_approval: def.requiresApproval,
          enabled: def.enabled,
          allowed_refs: [...def.allowedRefs],
          default_branch: def.branch,
          maximum_concurrent_executions: def.maximumConcurrentExecutions,
        }
      : null,
    // Branch que será usada (a ref efetiva da operação), destacada para o aprovador.
    effective_ref: String(parametros.ref ?? def?.branch ?? ''),
    capabilities: capacidadesEfetivas(actor),
  });
}));

// ---- POST /operations/:id/approve ------------------------------------------
operationalControlRouter.post('/operations/:id/approve', wrap(async (req, res) => {
  const actor = atorOperacional(req);
  await limitarOperacao(`aprovar|${actor.id}`);
  // A aprovação exige CONFIRMAÇÃO HUMANA RECENTE (reautenticação). O agente
  // MCP nunca satisfaz: não há sessão de navegador por trás de um token OAuth.
  exigirConfirmacaoHumana(req);
  const { confirmation } = validarAprovar(req.body);
  const op = await aprovarOperacao(actor, { operationId: String(req.params.id), confirmation });
  res.json({ ok: true, operation: serializarOperacao(op) });
}));

// ---- POST /operations/:id/reject -------------------------------------------
operationalControlRouter.post('/operations/:id/reject', wrap(async (req, res) => {
  const actor = atorOperacional(req);
  await limitarOperacao(`rejeitar|${actor.id}`);
  const { reason } = validarRejeitar(req.body);
  const op = await rejeitarOperacao(actor, { operationId: String(req.params.id), reason });
  res.json({ ok: true, operation: serializarOperacao(op) });
}));

// ---- POST /operations/:id/cancel -------------------------------------------
operationalControlRouter.post('/operations/:id/cancel', wrap(async (req, res) => {
  const actor = atorOperacional(req);
  await limitarOperacao(`cancelar|${actor.id}`);
  const { reason } = validarCancelar(req.body);
  const op = await cancelarOperacao(actor, { operationId: String(req.params.id), reason });
  res.json({ ok: true, operation: serializarOperacao(op) });
}));

// ---- POST /operations/:id/dispatch -----------------------------------------
operationalControlRouter.post('/operations/:id/dispatch', wrap(async (req, res) => {
  const actor = atorOperacional(req);
  await limitarOperacao(`dispatch|${actor.id}`);
  const op = await despacharOperacao(actor, String(req.params.id));
  res.status(202).json({ ok: true, operation: serializarOperacao(op) });
}));

// ---- GET /executions -------------------------------------------------------
operationalControlRouter.get('/executions', wrap(async (req, res) => {
  const actor = atorOperacional(req);
  await limitarOperacao(`execucoes|${actor.id}`);
  const { executions, next_cursor } = await listarExecucoes(actor, validarFiltroExecucoes(req.query as Record<string, unknown>));
  res.json({ ok: true, executions, next_cursor });
}));

// ---- POST /executions/reconciliar ------------------------------------------
operationalControlRouter.post('/executions/reconciliar', wrap(async (req, res) => {
  const actor = atorOperacional(req);
  await limitarOperacao(`reconciliar|${actor.id}`);
  exigirAutorizacao(actor, 'workflow.read');
  const resultado = await reconciliarEmpresa(actor.empresa_id);
  res.json({ ok: true, ...resultado });
}));

// ---- GET /executions/:id ---------------------------------------------------
operationalControlRouter.get('/executions/:id', wrap(async (req, res) => {
  const actor = atorOperacional(req);
  await limitarOperacao(`execucao|${actor.id}`);
  res.json({ ok: true, execution: await consultarExecucao(actor, String(req.params.id)) });
}));

// ---- GET /audit ------------------------------------------------------------
operationalControlRouter.get('/audit', wrap(async (req, res) => {
  const actor = atorOperacional(req);
  await limitarOperacao(`auditoria|${actor.id}`);
  // Histórico autorizado: metadados e payload minimizado; nunca token/secret.
  res.json({ ok: true, events: await listarEventosAuditoria(actor, req.query.limit) });
}));

// ---- POST /reconciliar-execucao (interno/administrativo, por id público) ----
operationalControlRouter.post('/operations/:id/reconciliar', wrap(async (req, res) => {
  const actor = atorOperacional(req);
  await limitarOperacao(`reconciliar-uma|${actor.id}`);
  exigirAutorizacao(actor, 'workflow.read');
  const publicId = String(req.params.id);
  const op = await getStore().findOneWhere(R_OPERATIONS, { empresa_id: actor.empresa_id, public_id: publicId });
  const workflow = op ? obterWorkflow(String((op as Record<string, unknown>).workflow_key)) : undefined;
  await reconciliarExecucao(publicId, actor.empresa_id);
  res.json({ ok: true, reconciliada: !!workflow });
}));
