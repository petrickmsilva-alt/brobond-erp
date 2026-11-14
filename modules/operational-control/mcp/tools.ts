// ============================================================================
// OPERATIONAL CONTROL › MCP › FERRAMENTAS
//
// Ferramentas DELIBERADAMENTE pequenas, tipadas e específicas. Nenhuma é
// genérica: não existe HTTP livre, shell, SQL, filesystem, deploy, merge ou
// push. Cada ferramenta declara a AÇÃO OPERACIONAL que exige — o servidor MCP
// aplica a mesma `exigirAutorizacao` do Control Plane (escopo OAuth ∩ perfil ∩
// política). Nenhum parâmetro do cliente escolhe repositório, branch, arquivo
// ou comando: isso vem do REGISTRO INTERNO.
//
// A projeção de saída é EXPLÍCITA: devolvemos só os campos públicos (metadados),
// nunca token, secret, variável de ambiente ou corpo remoto bruto.
// ============================================================================
import { dbStatus } from '../../../server/src/db';
import { exigirAutorizacao, type AcaoOperacional } from '../policies/authorization-policy';
import { obterWorkflow, WORKFLOW_REGISTRY, type WorkflowDefinition } from '../domain/workflow-registry';
import { githubActions, type GithubBranch, type GithubCommit, type GithubPullRequest } from '../infrastructure/github-actions.client';
import { listarOperacoesDoAtor, consultarExecucao } from '../application/list-operations';
import { consultarOperacao } from '../application/get-operation';
import { listarExecucoes } from '../application/list-executions';
import { listarEventosAuditoria } from '../application/list-audit';
import { solicitarOperacao } from '../application/request-operation';
import { OperationalError } from '../domain/errors';
import type { OperationalActor } from '../domain/operation';

const VERSAO = process.env.npm_package_version || '0.6.0';
const LIMITE_PADRAO = 10;
const LIMITE_MAX = 50;

export type CtxFerramenta = { actor: OperationalActor; args: Record<string, unknown>; actions?: typeof githubActions };

export type FerramentaMcp = {
  name: string;
  title: string;
  description: string;
  /** Ação operacional exigida (o servidor chama `exigirAutorizacao`). `null` = só identidade. */
  acao: AcaoOperacional | null;
  /** JSON Schema dos argumentos. `additionalProperties: false` recusa campo desconhecido. */
  inputSchema: Record<string, unknown>;
  handler: (ctx: CtxFerramenta) => Promise<unknown>;
};

// ---------------------------------------------------------------------------
// Helpers de argumento (validação explícita, fail-closed)
// ---------------------------------------------------------------------------
function texto(args: Record<string, unknown>, campo: string, { max = 200, obrigatorio = false } = {}): string {
  const v = args[campo];
  const s = v === undefined || v === null ? '' : String(v).trim();
  if (obrigatorio && !s) throw new OperationalError('PARAMETRO_INVALIDO', `O argumento "${campo}" é obrigatório.`, { [campo]: 'obrigatório' });
  if (s.length > max) throw new OperationalError('PARAMETRO_INVALIDO', `O argumento "${campo}" excede ${max} caracteres.`, { [campo]: 'muito longo' });
  return s;
}

function limite(args: Record<string, unknown>): number {
  const n = Number(args.limit);
  if (!Number.isFinite(n) || n <= 0) return LIMITE_PADRAO;
  return Math.min(Math.floor(n), LIMITE_MAX);
}

/** Repositório FIXO do registro interno (nunca vem do cliente). */
function repositorioDoRegistro(): string {
  const primeiro = Object.values(WORKFLOW_REGISTRY)[0];
  if (!primeiro) throw new OperationalError('DEPENDENCIA_INDISPONIVEL', 'Nenhum workflow registrado.');
  return primeiro.repository;
}

/** O workflow de diagnóstico read-only registrado (chave fixa do servidor). */
function workflowDiagnostico(): WorkflowDefinition {
  const def = obterWorkflow('neon-production-diagnostic');
  if (!def) throw new OperationalError('DEPENDENCIA_INDISPONIVEL', 'O diagnóstico não está registrado.');
  return def;
}

// ---------------------------------------------------------------------------
// Projeções (nunca devolvem token/secret/campo interno)
// ---------------------------------------------------------------------------
const projetarBranch = (b: GithubBranch) => ({ name: b.name, sha: b.commit?.sha ?? null, protected: b.protected ?? false });
const projetarCommit = (c: GithubCommit) => ({ sha: c.sha, message: c.commit?.message ?? null, author: c.commit?.author?.name ?? null, date: c.commit?.author?.date ?? null, html_url: c.html_url });
const projetarPr = (p: GithubPullRequest) => ({ number: p.number, title: p.title, state: p.state, html_url: p.html_url, user: p.user?.login ?? null, head: p.head?.ref ?? null, base: p.base?.ref ?? null });

// ---------------------------------------------------------------------------
// Ferramentas
// ---------------------------------------------------------------------------
export const FERRAMENTAS: readonly FerramentaMcp[] = [
  {
    name: 'brobond_system_status',
    title: 'Estado do sistema',
    description: 'Estado operacional do Brobond ERP (saúde do banco e versão). Não retorna connection strings, variáveis privadas nem detalhes internos de infraestrutura.',
    acao: null,
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
    handler: async () => {
      const status = dbStatus(); // 'demo' | 'ready' | 'degraded'
      return {
        status: status === 'ready' ? 'healthy' : status === 'degraded' ? 'degraded' : 'demo',
        database: status === 'ready' ? 'connected' : status === 'degraded' ? 'degraded' : 'demo',
        version: VERSAO,
      };
    },
  },
  {
    name: 'brobond_database_status',
    title: 'Estado do banco',
    description: 'Estado do banco de dados do ERP (pronto/demonstração/degradado). Nunca devolve connection string nem credencial.',
    acao: 'system.read',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
    handler: async ({ actor }) => {
      const status = dbStatus();
      return { status, ready: status === 'ready', empresa_id: actor.empresa_id };
    },
  },
  {
    name: 'brobond_github_branches',
    title: 'Branches do repositório',
    description: 'Lista branches do repositório do ERP (fixo no servidor) com o SHA. Filtro opcional por texto.',
    acao: 'github.read',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: { query: { type: 'string', maxLength: 200 }, limit: { type: 'integer', minimum: 1, maximum: LIMITE_MAX } },
    },
    handler: async ({ args, actions = githubActions }) => {
      const branches = await actions.branches(repositorioDoRegistro(), { query: texto(args, 'query'), limit: limite(args) });
      return { repository: repositorioDoRegistro(), branches: branches.map(projetarBranch) };
    },
  },
  {
    name: 'brobond_github_commits',
    title: 'Commits recentes',
    description: 'Lista commits recentes de uma branch do repositório do ERP.',
    acao: 'github.read',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: { branch: { type: 'string', maxLength: 200 }, limit: { type: 'integer', minimum: 1, maximum: LIMITE_MAX } },
    },
    handler: async ({ args, actions = githubActions }) => {
      const branch = texto(args, 'branch') || 'main';
      const commits = await actions.commits(repositorioDoRegistro(), branch, limite(args));
      return { repository: repositorioDoRegistro(), branch, commits: commits.map(projetarCommit) };
    },
  },
  {
    name: 'brobond_pull_requests',
    title: 'Pull requests',
    description: 'Lista pull requests do repositório do ERP. Somente leitura.',
    acao: 'github.read',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: { state: { type: 'string', enum: ['open', 'closed', 'all'] }, limit: { type: 'integer', minimum: 1, maximum: LIMITE_MAX } },
    },
    handler: async ({ args, actions = githubActions }) => {
      const state = texto(args, 'state') || 'open';
      const prs = await actions.pullRequests(repositorioDoRegistro(), { state, limit: limite(args) });
      return { repository: repositorioDoRegistro(), state, pull_requests: prs.map(projetarPr) };
    },
  },
  {
    name: 'brobond_workflow_runs',
    title: 'Execuções de workflow',
    description: 'Lista as execuções registradas dos workflows autorizados (metadados do GitHub Actions: run id, status, conclusão e URL). Nunca devolve logs brutos nem variáveis de ambiente.',
    acao: 'workflow.read',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: { workflow_key: { type: 'string', maxLength: 120 }, status: { type: 'string', maxLength: 40 }, limit: { type: 'integer', minimum: 1, maximum: LIMITE_MAX }, cursor: { type: 'string', maxLength: 200 } },
    },
    handler: async ({ actor, args }) => {
      const { executions, next_cursor } = await listarExecucoes(actor, {
        workflowKey: texto(args, 'workflow_key') || undefined,
        status: texto(args, 'status') || undefined,
        limit: limite(args),
        cursor: texto(args, 'cursor') || undefined,
      });
      return { executions, next_cursor };
    },
  },
  {
    name: 'brobond_operations_list',
    title: 'Listar operações',
    description: 'Lista as operações operacionais da empresa do usuário (solicitações e seu estado). Somente leitura.',
    acao: 'workflow.read',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: { workflow_key: { type: 'string', maxLength: 120 }, status: { type: 'string', maxLength: 40 }, limit: { type: 'integer', minimum: 1, maximum: LIMITE_MAX } },
    },
    handler: async ({ actor, args }) => {
      const operations = await listarOperacoesDoAtor(actor, {
        workflowKey: texto(args, 'workflow_key') || undefined,
        status: texto(args, 'status') || undefined,
        limit: limite(args),
      });
      return { operations };
    },
  },
  {
    name: 'brobond_operation_status',
    title: 'Detalhe da operação',
    description: 'Detalha uma operação pelo id opaco (op_...): estado, aprovação, execução e parâmetros. Recorte por empresa (operação de outro tenant responde não encontrada).',
    acao: 'workflow.read',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['operation_id'],
      properties: { operation_id: { type: 'string', maxLength: 120 } },
    },
    handler: async ({ actor, args }) => {
      const id = texto(args, 'operation_id', { obrigatorio: true, max: 120 });
      return { operation: await consultarOperacao(actor, id) };
    },
  },
  {
    name: 'brobond_execution_status',
    title: 'Status da execução',
    description: 'Consulta uma execução específica pelo id opaco (exec_...): run id do GitHub, estado, conclusão e URL. Recorte por empresa — execução de outro tenant responde não encontrada.',
    acao: 'workflow.read',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['execution_id'],
      properties: { execution_id: { type: 'string', maxLength: 120 } },
    },
    handler: async ({ actor, args }) => {
      const id = texto(args, 'execution_id', { obrigatorio: true, max: 120 });
      return { execution: await consultarExecucao(actor, id) };
    },
  },
  {
    name: 'brobond_audit_history',
    title: 'Histórico de auditoria',
    description: 'Histórico autorizado de eventos operacionais da empresa do usuário (metadados e payload minimizado). Nunca devolve token, secret ou senha.',
    acao: 'audit.read',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: { limit: { type: 'integer', minimum: 1, maximum: LIMITE_MAX } },
    },
    handler: async ({ actor, args }) => {
      const events = await listarEventosAuditoria(actor, limite(args));
      return { events };
    },
  },
  {
    name: 'brobond_request_diagnostic',
    title: 'Solicitar diagnóstico',
    description:
      'Cria uma SOLICITAÇÃO para executar o diagnóstico read-only registrado. NÃO executa nada: a operação fica pendente de APROVAÇÃO HUMANA no ERP. O agente não aprova.',
    acao: 'workflow.request',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['reason'],
      properties: { reason: { type: 'string', maxLength: 500 }, idempotency_key: { type: 'string', maxLength: 200 } },
    },
    handler: async ({ actor, args }) => {
      const reason = texto(args, 'reason', { obrigatorio: true, max: 500 });
      const def = workflowDiagnostico();
      // A chave de idempotência evita solicitações duplicadas em retry. Se o
      // cliente não informar, o servidor gera uma — a operação continua sujeita
      // à aprovação humana e a política (workflow desabilitado → 422).
      const idempotencyKey = texto(args, 'idempotency_key') || `mcp-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const { operation, reutilizada } = await solicitarOperacao(actor, {
        workflowKey: def.key,
        parameters: {},
        reason,
        idempotencyKey,
      });
      return {
        operation_id: operation.public_id,
        status: operation.status,
        requires_human_approval: operation.requires_approval,
        idempotent_replay: reutilizada,
        workflow_key: def.key,
      };
    },
  },
];

export function ferramentaPorNome(nome: string): FerramentaMcp | undefined {
  return FERRAMENTAS.find((f) => f.name === nome);
}

/** Ferramentas que o ator PODE usar (filtro de `tools/list` pela permissão efetiva). */
export function ferramentasAutorizadas(actor: OperationalActor): FerramentaMcp[] {
  return FERRAMENTAS.filter((f) => {
    if (!f.acao) return true;
    try {
      exigirAutorizacao(actor, f.acao);
      return true;
    } catch {
      return false;
    }
  });
}
