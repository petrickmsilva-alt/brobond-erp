// ============================================================================
// REMOTE MCP SERVER — protocolo JSON-RPC 2.0, autenticação OAuth e ferramentas
//
// Exercita o servidor MCP REAL (mcpRouter) com o MemStore:
//   • 401 sem token / com token inválido (a sessão do ERP é HS256 → recusada);
//   • `initialize`, `tools/list` (filtrado pela permissão) e `tools/call`;
//   • negativa por escopo/perfil sem contornar o RBAC (isError, auditada);
//   • projeções: nenhuma ferramenta devolve token/secret/env; sem shell/SQL/HTTP.
// O `pg-operational-control` cobre o que o MemStore não prova (índices UNIQUE).
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express, { type NextFunction, type Request, type Response } from 'express';

process.env.NODE_ENV = 'test';
delete process.env.DATABASE_URL;

const request = (await import('supertest')).default;
const { getStore } = await import('../src/services');
const { RESOURCES } = await import('../src/resources');
const { HttpError } = await import('../src/errors');
const { mcpRouter } = await import('../../modules/operational-control/mcp/server');
const { FERRAMENTAS } = await import('../../modules/operational-control/mcp/tools');
const { emitirAccessToken } = await import('../../modules/operational-control/oauth/tokens');
const { SCOPES, TODOS_OS_SCOPES } = await import('../../modules/operational-control/domain/scopes');

const store = getStore();
let seq = 0;
async function empresa(): Promise<number> {
  seq++;
  const r = await store.insert(RESOURCES.empresas, { nome: `MCP ${seq} ${Date.now()}` });
  return Number(r.id);
}
async function usuario(perfil: 'admin' | 'gerente' | 'operador' = 'admin', empresaId = 1): Promise<number> {
  seq++;
  const r = await store.insert(RESOURCES.usuarios, { nome: `MCP ${seq}`, email: `mcp-${seq}-${Date.now()}@b.test`, perfil, ativo: true });
  const id = Number(r.id);
  // Concede acesso explícito à empresa: `empresasDoUsuario` inclui a concessão
  // em `usuario_empresas`, então o token fica válido para o tenant do teste.
  if (empresaId !== 1) await store.insert(RESOURCES.usuario_empresas, { usuario_id: id, empresa_id: empresaId });
  return id;
}

const app = express();
app.use(express.json());
app.use(mcpRouter);
app.use((erro: unknown, _req: Request, res: Response, _next: NextFunction) => {
  res.status(erro instanceof HttpError ? erro.status : 500).json({ error: erro instanceof HttpError ? erro.message : 'Falha interna.' });
});

async function token(u: number, e: number, scopes: readonly string[] = TODOS_OS_SCOPES): Promise<string> {
  const { token } = await emitirAccessToken({ usuarioId: u, empresaId: e, clientId: 'chatgpt-client', scopes });
  return token;
}

function rpc(corpo: Record<string, unknown>, tok?: string) {
  const r = request(app).post('/mcp');
  if (tok) r.set('Authorization', `Bearer ${tok}`);
  return r.send(corpo);
}

// ---------------------------------------------------------------------------
// 1) Autenticação
// ---------------------------------------------------------------------------
test('MCP: POST /mcp sem Bearer responde 401 e anuncia resource_metadata', async () => {
  const res = await request(app).post('/mcp').send({ jsonrpc: '2.0', id: 1, method: 'initialize' });
  assert.equal(res.status, 401);
  assert.match(String(res.headers['www-authenticate'] ?? ''), /resource_metadata=/);
});

test('MCP: token inválido/assinatura errada responde 401', async () => {
  const res = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize' }, 'aaa.bbb.ccc');
  assert.equal(res.status, 401);
});

test('MCP: a SESSÃO do ERP (HS256) NÃO é aceita como token do MCP', async () => {
  const { signToken } = await import('../src/auth');
  const hs = signToken({ id: 1, name: 'x', email: 'x@b.test', perfil: 'admin' }, { sid: 's', emp: 1 });
  const res = await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, hs);
  assert.equal(res.status, 401, 'o MCP é Resource Server: só aceita o token OAuth (RS256)');
});

// ---------------------------------------------------------------------------
// 2) Handshake e listagem
// ---------------------------------------------------------------------------
test('MCP: initialize anuncia protocolo, capacidades de tools e nome do servidor', async () => {
  const e = await empresa();
  const u = await usuario('admin', e);
  const res = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }, await token(u, e));
  assert.equal(res.status, 200);
  assert.equal(res.body.result.serverInfo.name, 'brobond-operational-control');
  assert.ok(res.body.result.capabilities.tools);
});

test('MCP: tools/list é filtrado pela permissão efetiva (operador vê menos que admin)', async () => {
  const e = await empresa();
  const admin = await usuario('admin', e);
  const operador = await usuario('operador', e);
  // Operador: só system.read (escopo) e perfil operador.
  const tOp = await token(operador, e, [SCOPES.systemRead]);
  const listaOp = await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, tOp);
  const nomesOp = listaOp.body.result.tools.map((t: { name: string }) => t.name);
  assert.ok(nomesOp.includes('brobond_system_status'), 'system.read é do operador');
  assert.ok(!nomesOp.includes('brobond_github_branches'), 'operador não tem github.read');
  assert.ok(!nomesOp.includes('brobond_request_diagnostic'), 'operador não solicita');

  const tAdmin = await token(admin, e, TODOS_OS_SCOPES);
  const listaAdmin = await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, tAdmin);
  const nomesAdmin = listaAdmin.body.result.tools.map((t: { name: string }) => t.name);
  for (const esperada of ['brobond_system_status', 'brobond_github_branches', 'brobond_workflow_runs', 'brobond_request_diagnostic']) {
    assert.ok(nomesAdmin.includes(esperada), `admin deveria ver ${esperada}`);
  }
});

test('MCP: nenhuma ferramenta executa shell/SQL/HTTP genérico (lista fechada)', async () => {
  const proibidos = ['execute_shell', 'run_command', 'execute_sql', 'read_env', 'read_secrets', 'deploy_anything', 'merge_any_pull_request', 'push_to_branch', 'modify_database', 'dispatch_arbitrary_workflow', 'http_request', 'fetch'];
  for (const f of FERRAMENTAS) {
    assert.ok(!proibidos.includes(f.name), `ferramenta proibida exposta: ${f.name}`);
    assert.equal(f.inputSchema.additionalProperties, false, `${f.name} deve recusar campos desconhecidos`);
  }
});

// ---------------------------------------------------------------------------
// 3) tools/call — autorização e comportamento
// ---------------------------------------------------------------------------
test('MCP: brobond_system_status devolve estado sem vazar infraestrutura', async () => {
  const e = await empresa();
  const u = await usuario('admin', e);
  const res = await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'brobond_system_status', arguments: {} } }, await token(u, e));
  assert.equal(res.status, 200);
  const dados = res.body.result.structuredContent;
  assert.ok(['healthy', 'degraded', 'demo'].includes(dados.status));
  const texto = JSON.stringify(dados).toLowerCase();
  for (const vazamento of ['password', 'secret', 'token', 'connection', 'postgres://', 'database_url']) {
    assert.ok(!texto.includes(vazamento), `não pode conter ${vazamento}`);
  }
});

test('MCP: ferramenta desconhecida → isError (não executa nada)', async () => {
  const e = await empresa();
  const u = await usuario('admin', e);
  const res = await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'execute_shell', arguments: { cmd: 'rm -rf /' } } }, await token(u, e));
  assert.equal(res.status, 200);
  assert.equal(res.body.result.isError, true);
});

test('MCP: chamada sem o escopo exigido é NEGADA (isError) — RBAC não é contornado', async () => {
  const e = await empresa();
  const u = await usuario('admin', e);
  // Token só com system.read: pedir github.read deve ser negado.
  const res = await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'brobond_github_branches', arguments: {} } }, await token(u, e, [SCOPES.systemRead]));
  assert.equal(res.status, 200);
  assert.equal(res.body.result.isError, true);
  assert.match(res.body.result.content[0].text, /escopo|permiss/i);
});

test('MCP: brobond_request_diagnostic NÃO executa — cria operação pendente de aprovação humana', async () => {
  const e = await empresa();
  const u = await usuario('admin', e);
  const res = await rpc(
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'brobond_request_diagnostic', arguments: { reason: 'Diagnóstico read-only.' } } },
    await token(u, e)
  );
  assert.equal(res.status, 200);
  // O workflow nasce `enabled:false` (homologação): a política recusa com 422 e a
  // ferramenta devolve isError — nunca "executa mesmo assim".
  const r = res.body.result;
  if (r.isError) {
    assert.match(r.content[0].text, /desabilitad|habilita|pol[íi]tica/i);
  } else {
    assert.equal(r.structuredContent.status, 'pending_approval');
    assert.equal(r.structuredContent.requires_human_approval, true);
  }
});

test('MCP: notificação (sem id) responde 202 sem corpo', async () => {
  const e = await empresa();
  const u = await usuario('admin', e);
  const res = await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' }, await token(u, e));
  assert.equal(res.status, 202);
});

test('MCP: método desconhecido → erro JSON-RPC method not found', async () => {
  const e = await empresa();
  const u = await usuario('admin', e);
  const res = await rpc({ jsonrpc: '2.0', id: 7, method: 'resources/list' }, await token(u, e));
  assert.equal(res.status, 200);
  assert.equal(res.body.error.code, -32601);
});

test('MCP: o ator de OUTRA empresa não vê operações do tenant alheio', async () => {
  const eA = await empresa();
  const eB = await empresa();
  const uB = await usuario('admin', eB);
  // Cria uma operação crua na empresa A.
  const opA = await store.insert(RESOURCES.operational_operations, {
    public_id: `op_${Math.random().toString(36).slice(2)}`,
    empresa_id: eA,
    operation_type: 'diagnostic.read_only',
    workflow_key: 'neon-production-diagnostic',
    requested_by: uB,
    parameters: { ref: 'x' },
    parameters_hash: 'h',
    reason: 'r',
    status: 'pending_approval',
    requires_approval: true,
    requested_scopes: '',
    idempotency_key: `k-${Math.random()}`,
    expires_at: new Date(Date.now() + 3600_000).toISOString(),
  });
  // Token do usuário na empresa B: consultar a operação de A responde não encontrada.
  const res = await rpc(
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'brobond_operation_status', arguments: { operation_id: String((opA as Record<string, unknown>).public_id) } } },
    await token(uB, eB)
  );
  assert.equal(res.body.result.isError, true);
  assert.match(res.body.result.content[0].text, /n[ãa]o encontrada/i);
});

test('MCP: brobond_execution_status recorta por empresa (execução de outro tenant não é encontrada)', async () => {
  const eA = await empresa();
  const eB = await empresa();
  const uB = await usuario('admin', eB);
  const execA = await store.insert(RESOURCES.operational_executions, {
    public_id: `exec_${Math.random().toString(36).slice(2)}`,
    empresa_id: eA,
    operation_id: 1,
    workflow_key: 'neon-production-diagnostic',
    branch: 'ops/workflow-migracao-producao-diagnostico',
    github_run_id: 123,
    status: 'completed',
    conclusion: 'success',
    html_url: 'https://github.com/x/y/actions/runs/123',
  });
  const res = await rpc(
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'brobond_execution_status', arguments: { execution_id: String((execA as Record<string, unknown>).public_id) } } },
    await token(uB, eB)
  );
  assert.equal(res.body.result.isError, true);
  assert.match(res.body.result.content[0].text, /n[ãa]o encontrada/i);
});

test('MCP: brobond_audit_history exige o escopo audit.read (admin sem escopo é negado)', async () => {
  const e = await empresa();
  const u = await usuario('admin', e);
  const negado = await rpc(
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'brobond_audit_history', arguments: {} } },
    await token(u, e, [SCOPES.systemRead])
  );
  assert.equal(negado.body.result.isError, true);
  assert.match(negado.body.result.content[0].text, /escopo|permiss/i);

  const permitido = await rpc(
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'brobond_audit_history', arguments: { limit: 5 } } },
    await token(u, e, TODOS_OS_SCOPES)
  );
  assert.equal(permitido.body.result.isError, undefined);
  assert.ok(Array.isArray(permitido.body.result.structuredContent.events));
});
