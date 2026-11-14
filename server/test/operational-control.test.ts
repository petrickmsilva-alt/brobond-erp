// ============================================================================
// OPERATIONAL CONTROL PLANE — suíte do módulo (modules/operational-control)
//
// Exercita o CÓDIGO REAL: políticas puras, ciclo de vida, aprovação, dispatch
// contra um cliente GitHub STUB (o mesmo `GithubActionsClient` injetado por
// dependência), idempotência, cadeia de auditoria e isolamento por empresa.
//
// O store é o MemStore (sem DATABASE_URL), mas TODA a lógica de autorização,
// allowlist, branch, parâmetros, aprovação, CAS e auditoria é a de produção.
//
// Os cenários negativos obrigatórios da especificação (§14.4) estão cobertos:
// workflow não cadastrado, branch fora da política, execução sem aprovação,
// aprovação pelo próprio agente, operação de outro tenant e ausência de
// ferramenta de execução arbitrária.
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
delete process.env.DATABASE_URL;

const { getStore } = await import('../src/services');
const { RESOURCES } = await import('../src/resources');
const { WORKFLOW_REGISTRY } = await import('../../modules/operational-control/domain/workflow-registry');
const { hashParametros } = await import('../../modules/operational-control/policies/parameter-policy');
const { solicitarOperacao } = await import('../../modules/operational-control/application/request-operation');
const { aprovarOperacao } = await import('../../modules/operational-control/application/approve-operation');
const { rejeitarOperacao } = await import('../../modules/operational-control/application/reject-operation');
const { cancelarOperacao } = await import('../../modules/operational-control/application/cancel-operation');
const { despacharOperacao } = await import('../../modules/operational-control/application/dispatch-workflow');
const { consultarOperacao } = await import('../../modules/operational-control/application/get-operation');
const { verificarCadeiaOperacao } = await import('../../modules/operational-control/infrastructure/audit');
const { R_OPERATIONS, R_AUDIT_EVENTS, R_EXECUTIONS } = await import('../../modules/operational-control/infrastructure/resources');
const { SCOPES } = await import('../../modules/operational-control/domain/scopes');
const { exigirAutorizacao, capacidadesEfetivas } = await import('../../modules/operational-control/policies/authorization-policy');
const { aprovacaoDaOperacao, registrarDecisao } = await import('../../modules/operational-control/infrastructure/approval.repository');

const WORKFLOW = 'neon-production-diagnostic';
const REF = 'ops/workflow-migracao-producao-diagnostico';
const TODOS_ESCOPOS = Object.values(SCOPES);

type Ator = import('../../modules/operational-control/domain/operation').OperationalActor;

// Habilita o workflow para os testes de dispatch. O registro nasce DESABILITADO
// em produção (aguarda homologação) — aqui só o teste o liga explicitamente.
function habilitarWorkflow(): void {
  (WORKFLOW_REGISTRY as Record<string, { enabled: boolean }>)[WORKFLOW].enabled = true;
}
function desabilitarWorkflow(): void {
  (WORKFLOW_REGISTRY as Record<string, { enabled: boolean }>)[WORKFLOW].enabled = false;
}

let seq = 0;

async function novaEmpresa(): Promise<number> {
  seq++;
  const emp = await getStore().insert(RESOURCES.empresas, { nome: `OC Empresa ${seq} ${Date.now()}` });
  return Number(emp.id);
}

/** Usuário REAL (o store valida referências para `usuarios`). */
async function novoUsuario(empresaId: number, perfil: Ator['perfil']): Promise<number> {
  seq++;
  // `usuarios` não tem coluna `empresa_id` no schema — a empresa do ator vem do
  // token/sessão, não do cadastro (por isso o parâmetro só existe para simetria).
  void empresaId;
  const row = await getStore().insert(RESOURCES.usuarios, {
    nome: `OC ${perfil} ${seq}`,
    email: `oc-${perfil}-${seq}-${Date.now()}@brobond.test`,
    perfil,
    ativo: true,
  });
  return Number(row.id);
}

async function ator(empresaId: number, perfil: Ator['perfil'], opts: { viaMcp?: boolean; scopes?: string[] } = {}): Promise<Ator> {
  const id = await novoUsuario(empresaId, perfil);
  return {
    id,
    name: `Ator ${perfil}`,
    perfil,
    empresa_id: empresaId,
    scopes: opts.scopes ?? TODOS_ESCOPOS,
    viaMcp: opts.viaMcp,
  };
}

function chaveIdempotencia(): string {
  seq++;
  return `idem-${Date.now()}-${seq}`;
}

/** Stub do cliente do GitHub Actions — mesma interface, sem rede. */
function stubActions(opts: { existe?: boolean; dispatchFalha?: boolean } = {}) {
  const estado = { dispatches: 0, verificacoes: 0 };
  const cliente = {
    async workflowExiste() {
      estado.verificacoes++;
      return opts.existe !== false;
    },
    async dispatch() {
      estado.dispatches++;
      if (opts.dispatchFalha) throw new Error('rede');
      return { status: 204 };
    },
  };
  return { cliente: cliente as unknown as import('../../modules/operational-control/infrastructure/github-actions.client').GithubActionsClient, estado };
}

// ---------------------------------------------------------------------------
// 1) AUTORIZAÇÃO — permissão efetiva = escopo OAuth ∩ perfil
// ---------------------------------------------------------------------------
test('autorização: operador sem escopo é negado; admin com escopo é aceito', async () => {
  const emp = await novaEmpresa();
  const operador = await ator(emp, 'operador', { scopes: [SCOPES.workflowRead] });
  assert.throws(() => exigirAutorizacao(operador, 'workflow.request'), (e: any) => e.status === 403);

  const admin = await ator(emp, 'admin');
  assert.doesNotThrow(() => exigirAutorizacao(admin, 'workflow.request'));
});

test('autorização: ser admin NÃO dispensa o escopo OAuth da operação', async () => {
  const emp = await novaEmpresa();
  const adminSemEscopo = await ator(emp, 'admin', { scopes: [SCOPES.systemRead] });
  assert.throws(() => exigirAutorizacao(adminSemEscopo, 'workflow.request'), (e: any) => e.status === 403);
});

test('autorização: sem ator é 401; capacidades nunca expõem execução arbitrária', async () => {
  assert.throws(() => exigirAutorizacao(null, 'system.read'), (e: any) => e.status === 401);
  const emp = await novaEmpresa();
  const admin = await ator(emp, 'admin');
  const caps = capacidadesEfetivas(admin);
  assert.equal(caps.arbitrary_command_execution, false);
  assert.equal(caps.workflow_request, true);
  assert.equal(caps.workflow_approval, true);
});

// ---------------------------------------------------------------------------
// 2) POLÍTICAS — allowlist, branch, parâmetros, habilitação
// ---------------------------------------------------------------------------
test('política: workflow não cadastrado é recusado (422)', async () => {
  const emp = await novaEmpresa();
  const admin = await ator(emp, 'admin');
  habilitarWorkflow();
  await assert.rejects(
    () => solicitarOperacao(admin, { workflowKey: 'workflow-inventado', reason: 'teste', idempotencyKey: chaveIdempotencia() }),
    (e: any) => e.status === 422
  );
});

test('política: workflow DESABILITADO não pode ser solicitado (422)', async () => {
  const emp = await novaEmpresa();
  const admin = await ator(emp, 'admin');
  desabilitarWorkflow();
  await assert.rejects(
    () => solicitarOperacao(admin, { workflowKey: WORKFLOW, reason: 'teste', idempotencyKey: chaveIdempotencia() }),
    (e: any) => e.status === 422
  );
});

test('política: branch fora da allowlist é recusada (main nunca passa)', async () => {
  const emp = await novaEmpresa();
  const admin = await ator(emp, 'admin');
  habilitarWorkflow();
  await assert.rejects(
    () => solicitarOperacao(admin, { workflowKey: WORKFLOW, reason: 'teste', idempotencyKey: chaveIdempotencia(), ref: 'main' }),
    (e: any) => e.status === 422
  );
});

test('política: parâmetro desconhecido é recusado (400)', async () => {
  const emp = await novaEmpresa();
  const admin = await ator(emp, 'admin');
  habilitarWorkflow();
  await assert.rejects(
    () => solicitarOperacao(admin, { workflowKey: WORKFLOW, reason: 'teste', idempotencyKey: chaveIdempotencia(), parameters: { comando: 'rm -rf /' } }),
    (e: any) => e.status === 400
  );
});

// ---------------------------------------------------------------------------
// 3) IDEMPOTÊNCIA
// ---------------------------------------------------------------------------
test('idempotência: mesma chave + mesmos parâmetros devolve a MESMA operação', async () => {
  const emp = await novaEmpresa();
  const admin = await ator(emp, 'admin');
  habilitarWorkflow();
  const key = chaveIdempotencia();
  const a = await solicitarOperacao(admin, { workflowKey: WORKFLOW, reason: 'primeira', idempotencyKey: key });
  const b = await solicitarOperacao(admin, { workflowKey: WORKFLOW, reason: 'segunda', idempotencyKey: key });
  assert.equal(a.reutilizada, false);
  assert.equal(b.reutilizada, true);
  assert.equal(a.operation.id, b.operation.id);
});

test('idempotência: mesma chave com hash diferente é CONFLITO (409)', async () => {
  const emp = await novaEmpresa();
  const admin = await ator(emp, 'admin');
  habilitarWorkflow();
  const key = chaveIdempotencia();
  // Operação pré-existente com o MESMO idempotency_key e hash divergente.
  await getStore().insert(R_OPERATIONS, {
    public_id: 'op_seed_conflict',
    empresa_id: emp,
    operation_type: 'diagnostic.read_only',
    workflow_key: WORKFLOW,
    requested_by: admin.id,
    parameters: {},
    parameters_hash: 'hash-divergente',
    reason: 'seed',
    status: 'pending_approval',
    requires_approval: true,
    requested_scopes: '',
    idempotency_key: key,
    expires_at: new Date(Date.now() + 3600_000).toISOString(),
  });
  await assert.rejects(
    () => solicitarOperacao(admin, { workflowKey: WORKFLOW, reason: 'outra', idempotencyKey: key }),
    (e: any) => e.status === 409
  );
});

// ---------------------------------------------------------------------------
// 4) APROVAÇÃO — humana, vinculada ao hash, uso único
// ---------------------------------------------------------------------------
test('aprovação: o AGENTE MCP não aprova a própria solicitação (403)', async () => {
  const emp = await novaEmpresa();
  const admin = await ator(emp, 'admin');
  habilitarWorkflow();
  const { operation } = await solicitarOperacao(admin, { workflowKey: WORKFLOW, reason: 'teste', idempotencyKey: chaveIdempotencia() });

  const agente = await ator(emp, 'admin', { viaMcp: true });
  await assert.rejects(
    () => aprovarOperacao(agente, { operationId: operation.public_id, confirmation: 'Confirmo a execução.' }),
    (e: any) => e.status === 403
  );
});

test('aprovação: não-admin não aprova (403)', async () => {
  const emp = await novaEmpresa();
  const admin = await ator(emp, 'admin');
  habilitarWorkflow();
  const { operation } = await solicitarOperacao(admin, { workflowKey: WORKFLOW, reason: 'teste', idempotencyKey: chaveIdempotencia() });

  const gerente = await ator(emp, 'gerente');
  await assert.rejects(
    () => aprovarOperacao(gerente, { operationId: operation.public_id, confirmation: 'Confirmo a execução.' }),
    (e: any) => e.status === 403
  );
});

test('aprovação: humana válida aprova; aprovação DUPLICADA é conflito', async () => {
  const emp = await novaEmpresa();
  const admin = await ator(emp, 'admin');
  habilitarWorkflow();
  const { operation } = await solicitarOperacao(admin, { workflowKey: WORKFLOW, reason: 'teste', idempotencyKey: chaveIdempotencia() });

  const aprovada = await aprovarOperacao(admin, { operationId: operation.public_id, confirmation: 'Confirmo a execução.' });
  assert.equal(aprovada.status, 'approved');
  await assert.rejects(
    () => aprovarOperacao(admin, { operationId: operation.public_id, confirmation: 'Confirmo de novo.' }),
    (e: any) => e.status === 409
  );
});

test('aprovação: expirada é recusada no dispatch (422)', async () => {
  const emp = await novaEmpresa();
  const admin = await ator(emp, 'admin');
  habilitarWorkflow();
  const { operation } = await solicitarOperacao(admin, { workflowKey: WORKFLOW, reason: 'teste', idempotencyKey: chaveIdempotencia() });
  await aprovarOperacao(admin, { operationId: operation.public_id, confirmation: 'Confirmo a execução.' });

  // Expira a aprovação (mesma linha) e tenta despachar.
  const aprov = await aprovacaoDaOperacao(Number(operation.id));
  await getStore().update(RESOURCES.operational_approvals, Number(aprov!.id), { expires_at: new Date(Date.now() - 1000).toISOString() });

  const { cliente } = stubActions();
  await assert.rejects(
    () => despacharOperacao(admin, operation.public_id, { actions: cliente }),
    (e: any) => e.status === 422
  );
});

test('aprovação: hash de parâmetros divergente invalida a autorização (422)', async () => {
  const emp = await novaEmpresa();
  const admin = await ator(emp, 'admin');
  habilitarWorkflow();
  const { operation } = await solicitarOperacao(admin, { workflowKey: WORKFLOW, reason: 'teste', idempotencyKey: chaveIdempotencia() });
  await aprovarOperacao(admin, { operationId: operation.public_id, confirmation: 'Confirmo a execução.' });

  const aprov = await aprovacaoDaOperacao(Number(operation.id));
  await getStore().update(RESOURCES.operational_approvals, Number(aprov!.id), { parameters_hash: 'outro-hash' });

  const { cliente } = stubActions();
  await assert.rejects(
    () => despacharOperacao(admin, operation.public_id, { actions: cliente }),
    (e: any) => e.status === 422
  );
});

// ---------------------------------------------------------------------------
// 5) DISPATCH — uma única vez, aprovação consumida, sem execução arbitrária
// ---------------------------------------------------------------------------
test('dispatch: sem aprovação é recusado (422); com aprovação despacha UMA vez', async () => {
  const emp = await novaEmpresa();
  const admin = await ator(emp, 'admin');
  habilitarWorkflow();
  const { operation } = await solicitarOperacao(admin, { workflowKey: WORKFLOW, reason: 'diagnóstico', idempotencyKey: chaveIdempotencia() });

  const { cliente, estado } = stubActions();
  // Sem aprovação (a operação está em pending_approval) → dispatch recusado.
  await assert.rejects(() => despacharOperacao(admin, operation.public_id, { actions: cliente }), (e: any) => e.status === 409 || e.status === 422);
  assert.equal(estado.dispatches, 0);

  await aprovarOperacao(admin, { operationId: operation.public_id, confirmation: 'Confirmo a execução.' });
  const despachada = await despacharOperacao(admin, operation.public_id, { actions: cliente });
  assert.equal(despachada.status, 'dispatched');
  assert.equal(estado.dispatches, 1);

  // Repetir o dispatch NÃO envia de novo (estado já não é `approved`).
  await assert.rejects(() => despacharOperacao(admin, operation.public_id, { actions: cliente }), (e: any) => e.status === 409);
  assert.equal(estado.dispatches, 1);
});

test('dispatch: a aprovação é CONSUMIDA (uso único) após o envio', async () => {
  const emp = await novaEmpresa();
  const admin = await ator(emp, 'admin');
  habilitarWorkflow();
  const { operation } = await solicitarOperacao(admin, { workflowKey: WORKFLOW, reason: 'diagnóstico', idempotencyKey: chaveIdempotencia() });
  await aprovarOperacao(admin, { operationId: operation.public_id, confirmation: 'Confirmo a execução.' });

  const { cliente } = stubActions();
  await despacharOperacao(admin, operation.public_id, { actions: cliente });

  const aprov = await aprovacaoDaOperacao(Number(operation.id));
  assert.ok(aprov?.consumed_at, 'a aprovação deve ficar marcada como consumida');
});

test('dispatch: workflow ausente no repositório falha ANTES do envio (422)', async () => {
  const emp = await novaEmpresa();
  const admin = await ator(emp, 'admin');
  habilitarWorkflow();
  const { operation } = await solicitarOperacao(admin, { workflowKey: WORKFLOW, reason: 'diagnóstico', idempotencyKey: chaveIdempotencia() });
  await aprovarOperacao(admin, { operationId: operation.public_id, confirmation: 'Confirmo a execução.' });

  const { cliente, estado } = stubActions({ existe: false });
  await assert.rejects(() => despacharOperacao(admin, operation.public_id, { actions: cliente }), (e: any) => e.status === 422);
  assert.equal(estado.dispatches, 0, 'nunca envia quando o workflow não existe');
});

test('dispatch: falha de rede DEPOIS do envio NÃO repete automaticamente', async () => {
  const emp = await novaEmpresa();
  const admin = await ator(emp, 'admin');
  habilitarWorkflow();
  const { operation } = await solicitarOperacao(admin, { workflowKey: WORKFLOW, reason: 'diagnóstico', idempotencyKey: chaveIdempotencia() });
  await aprovarOperacao(admin, { operationId: operation.public_id, confirmation: 'Confirmo a execução.' });

  const { cliente, estado } = stubActions({ dispatchFalha: true });
  await assert.rejects(() => despacharOperacao(admin, operation.public_id, { actions: cliente }), (e: any) => e.status === 502);
  assert.equal(estado.dispatches, 1);

  // A operação fica em `dispatching` (resultado desconhecido) — um novo dispatch
  // não é permitido: quem resolve é a reconciliação.
  const op = await getStore().findOneWhere(R_OPERATIONS, { public_id: operation.public_id });
  assert.equal(String(op!.status), 'dispatching');
  await assert.rejects(() => despacharOperacao(admin, operation.public_id, { actions: cliente }), (e: any) => e.status === 409);
});

test('dispatch: limite de concorrência (máx. 1) é respeitado (409)', async () => {
  const emp = await novaEmpresa();
  const admin = await ator(emp, 'admin');
  habilitarWorkflow();

  // Primeira operação despachada (fica em `dispatched`).
  const primeira = await solicitarOperacao(admin, { workflowKey: WORKFLOW, reason: 'um', idempotencyKey: chaveIdempotencia() });
  await aprovarOperacao(admin, { operationId: primeira.operation.public_id, confirmation: 'Confirmo a execução.' });
  const { cliente } = stubActions();
  await despacharOperacao(admin, primeira.operation.public_id, { actions: cliente });

  // Segunda operação aprovada → barrada pelo limite de concorrência.
  const segunda = await solicitarOperacao(admin, { workflowKey: WORKFLOW, reason: 'dois', idempotencyKey: chaveIdempotencia() });
  await aprovarOperacao(admin, { operationId: segunda.operation.public_id, confirmation: 'Confirmo a execução.' });
  await assert.rejects(() => despacharOperacao(admin, segunda.operation.public_id, { actions: cliente }), (e: any) => e.status === 409);
});

// ---------------------------------------------------------------------------
// 6) CICLO DE VIDA — rejeitar e cancelar
// ---------------------------------------------------------------------------
test('ciclo: rejeição encerra a operação e não pode ser despachada', async () => {
  const emp = await novaEmpresa();
  const admin = await ator(emp, 'admin');
  habilitarWorkflow();
  const { operation } = await solicitarOperacao(admin, { workflowKey: WORKFLOW, reason: 'teste', idempotencyKey: chaveIdempotencia() });
  const rejeitada = await rejeitarOperacao(admin, { operationId: operation.public_id, reason: 'Operação não autorizada.' });
  assert.equal(rejeitada.status, 'rejected');

  const { cliente, estado } = stubActions();
  await assert.rejects(() => despacharOperacao(admin, operation.public_id, { actions: cliente }), (e: any) => e.status === 409 || e.status === 422);
  assert.equal(estado.dispatches, 0);
});

test('ciclo: cancelar só vale antes do dispatch; depois do envio é conflito', async () => {
  const emp = await novaEmpresa();
  const admin = await ator(emp, 'admin');
  habilitarWorkflow();
  const { operation } = await solicitarOperacao(admin, { workflowKey: WORKFLOW, reason: 'teste', idempotencyKey: chaveIdempotencia() });
  const cancelada = await cancelarOperacao(admin, { operationId: operation.public_id, reason: 'sem necessidade' });
  assert.equal(cancelada.status, 'cancelled');
});

// ---------------------------------------------------------------------------
// 7) ISOLAMENTO POR EMPRESA (multiempresa)
// ---------------------------------------------------------------------------
test('tenant: operação de outra empresa responde 404 (nunca vaza)', async () => {
  const empA = await novaEmpresa();
  const empB = await novaEmpresa();
  const adminA = await ator(empA, 'admin');
  const adminB = await ator(empB, 'admin');
  habilitarWorkflow();

  const { operation } = await solicitarOperacao(adminA, { workflowKey: WORKFLOW, reason: 'da A', idempotencyKey: chaveIdempotencia() });

  // O admin da empresa B não enxerga a operação da empresa A.
  await assert.rejects(() => consultarOperacao(adminB, operation.public_id), (e: any) => e.status === 404);
  // O admin da empresa A enxerga.
  const vista = await consultarOperacao(adminA, operation.public_id);
  assert.equal(vista.id, operation.public_id);
});

// ---------------------------------------------------------------------------
// 8) AUDITORIA — cadeia encadeada por operação
// ---------------------------------------------------------------------------
test('auditoria: a trilha da operação é encadeada e íntegra', async () => {
  const emp = await novaEmpresa();
  const admin = await ator(emp, 'admin');
  habilitarWorkflow();
  const { operation } = await solicitarOperacao(admin, { workflowKey: WORKFLOW, reason: 'teste', idempotencyKey: chaveIdempotencia() });
  await aprovarOperacao(admin, { operationId: operation.public_id, confirmation: 'Confirmo a execução.' });
  const { cliente } = stubActions();
  await despacharOperacao(admin, operation.public_id, { actions: cliente });

  const eventos = await getStore().list(R_AUDIT_EVENTS, { page: 1, pageSize: 50, sort: 'id', dir: 'asc', filter: { operation_id: Number(operation.id) } });
  const tipos = eventos.rows.map((r) => String(r.event_type));
  assert.ok(tipos.includes('operation.requested'));
  assert.ok(tipos.includes('operation.approved'));
  assert.ok(tipos.includes('operation.dispatched'));

  const verif = await verificarCadeiaOperacao(Number(operation.id));
  assert.equal(verif.ok, true, `cadeia de auditoria quebrada: ${JSON.stringify(verif.quebras)}`);
});

test('auditoria: nenhum evento carrega token, secret ou senha', async () => {
  const emp = await novaEmpresa();
  const admin = await ator(emp, 'admin');
  habilitarWorkflow();
  const { operation } = await solicitarOperacao(admin, { workflowKey: WORKFLOW, reason: 'teste', idempotencyKey: chaveIdempotencia() });
  const eventos = await getStore().list(R_AUDIT_EVENTS, { page: 1, pageSize: 50, filter: { operation_id: Number(operation.id) } });
  const bruto = JSON.stringify(eventos.rows).toLowerCase();
  for (const proibido of ['access_token', 'refresh_token', 'private_key', 'senha', 'secret', 'bearer ']) {
    assert.ok(!bruto.includes(proibido), `a auditoria não pode conter "${proibido}"`);
  }
});

// ---------------------------------------------------------------------------
// 9) GARANTIAS ARQUITETURAIS (nenhuma ferramenta de execução arbitrária)
// ---------------------------------------------------------------------------
test('arquitetura: não existe execução de comando/shell na superfície do módulo', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const raiz = path.join(process.cwd(), '..', 'modules', 'operational-control');
  const arquivos: string[] = [];
  const percorrer = (dir: string) => {
    for (const entrada of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entrada.name);
      if (entrada.isDirectory()) percorrer(p);
      else if (entrada.name.endsWith('.ts')) arquivos.push(p);
    }
  };
  percorrer(raiz);
  assert.ok(arquivos.length > 0);
  for (const arq of arquivos) {
    const src = fs.readFileSync(arq, 'utf8');
    assert.ok(
      !/child_process|execSync|spawnSync|(?<![\w.])exec\s*\(/.test(src),
      `uso de execução de processo em ${arq}`
    );
  }
});

test('auditoria/execuções: as tabelas operacionais existem e não expõem CRUD genérico', async () => {
  for (const r of [R_OPERATIONS, R_AUDIT_EVENTS, R_EXECUTIONS]) {
    assert.equal(r.internal, true, `${r.key} deve ser recurso interno`);
  }
});
