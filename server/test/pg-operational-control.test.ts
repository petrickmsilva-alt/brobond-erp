// ============================================================================
// OPERATIONAL CONTROL PLANE contra Postgres REAL
//
// Prova, no banco de verdade, o que a suíte de memória não pode provar:
//   A — a migração 0121 aplica e as tabelas existem com as colunas do contrato;
//   B — o `empresa_id` é carimbado no INSERT e o recorte por empresa chega ao SQL
//       (a operação de A não é visível para B);
//   C — o idempotency_key é ÚNICO por empresa (o banco recusa a duplicata);
//   D — a aprovação é de USO ÚNICO no banco (índice parcial de 'approve');
//   E — a cadeia de auditoria fecha com `occurred_at` devolvido como TIMESTAMPTZ
//       (Date) pelo driver — o caso que a memória não reproduz.
//
// Sem DATABASE_URL o arquivo se auto-pula (job `testes-postgres` do CI).
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

const temBanco = Boolean(process.env.DATABASE_URL);
const skip = temBanco ? false : 'requer DATABASE_URL (job testes-postgres do CI)';

process.env.NODE_ENV = 'test';

const sufixo = Date.now().toString(36).toUpperCase();

test('0121: as tabelas operacionais existem e a cadeia de auditoria fecha no PG', { skip }, async () => {
  const { migrate, query } = await import('../src/db');
  await migrate();
  const { getStore } = await import('../src/services');
  const { RESOURCES } = await import('../src/resources');
  const { solicitarOperacao } = await import('../../modules/operational-control/application/request-operation');
  const { aprovarOperacao } = await import('../../modules/operational-control/application/approve-operation');
  const { verificarCadeiaOperacao } = await import('../../modules/operational-control/infrastructure/audit');
  const { WORKFLOW_REGISTRY } = await import('../../modules/operational-control/domain/workflow-registry');
  const { R_OPERATIONS, R_APPROVALS } = await import('../../modules/operational-control/infrastructure/resources');

  // A — as tabelas da migração existem (nome exato) com o contrato de colunas.
  const { rows: tabelas } = await query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name IN
      ('operational_operations','operational_approvals','operational_executions','operational_audit_events','oauth_clients','oauth_authorization_codes','oauth_tokens','oauth_consents')`
  );
  assert.equal(tabelas.length, 8, 'as 8 tabelas da migração 0121 precisam existir');

  const { rows: colunas } = await query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='operational_operations'`
  );
  const nomes = new Set(colunas.map((c) => c.column_name));
  for (const c of ['public_id', 'empresa_id', 'workflow_key', 'parameters_hash', 'requires_approval', 'requested_scopes', 'idempotency_key', 'expires_at', 'criado_em', 'atualizado_em']) {
    assert.ok(nomes.has(c), `operational_operations precisa da coluna ${c}`);
  }

  // Empresas e usuários reais para satisfazer as FKs.
  const empA = await getStore().insert(RESOURCES.empresas, { nome: `OC PG A ${sufixo}` });
  const empB = await getStore().insert(RESOURCES.empresas, { nome: `OC PG B ${sufixo}` });
  const usuario = await getStore().insert(RESOURCES.usuarios, { nome: `OC PG user ${sufixo}`, email: `oc-pg-${sufixo}-${Math.random()}@brobond.test`, perfil: 'admin', ativo: true });

  (WORKFLOW_REGISTRY as Record<string, { enabled: boolean }>)['neon-production-diagnostic'].enabled = true;
  const base: Ator = { id: Number(usuario.id), name: 'Admin PG', perfil: 'admin', empresa_id: Number(empA.id), scopes: Object.values((await import('../../modules/operational-control/domain/scopes')).SCOPES), viaMcp: false };
  const atorB: Ator = { ...base, empresa_id: Number(empB.id) };

  // B — o INSERT carimba empresa_id; A enxerga, B NÃO (recorte no SQL).
  const { operation } = await solicitarOperacao(base, { workflowKey: 'neon-production-diagnostic', reason: 'PG A', idempotencyKey: `pg-${sufixo}-1` });
  const cru = await query<{ empresa_id: number }>(`SELECT empresa_id FROM operational_operations WHERE public_id = $1`, [operation.public_id]);
  assert.equal(Number(cru.rows[0].empresa_id), Number(empA.id), 'o INSERT carimba a empresa do ator');

  const deB = await getStore().findOneWhere(R_OPERATIONS, { empresa_id: Number(empB.id), public_id: operation.public_id });
  assert.equal(deB, null, 'a operação de A não pode ser visível para B');

  // C — idempotency_key é única por empresa: a segunda inserção crua é recusada.
  await assert.rejects(
    () =>
      query(`INSERT INTO operational_operations
        (public_id, empresa_id, operation_type, workflow_key, requested_by, parameters_hash, reason, idempotency_key, expires_at)
        VALUES ($1,$2,'diagnostic.read_only','neon-production-diagnostic',$3,'h','r',$4, now() + interval '1 hour')`,
        [`op_dup_${sufixo}`, Number(empA.id), Number(usuario.id), `pg-${sufixo}-1`]),
    /duplicate key|unique/i,
    'o banco precisa recusar a mesma idempotency_key na mesma empresa'
  );

  // D — aprovação humana no PG e o índice parcial de 'approve' barra a duplicata.
  const aprovada = await aprovarOperacao(base, { operationId: operation.public_id, confirmation: 'Confirmo a execução (PG).' });
  assert.equal(aprovada.status, 'approved');
  await assert.rejects(
    () =>
      query(`INSERT INTO operational_approvals (empresa_id, operation_id, approved_by, decision, parameters_hash, confirmation, expires_at)
             VALUES ($1,$2,$3,'approve',$4,'x', now() + interval '10 minutes')`,
        [Number(empA.id), Number(operation.id), Number(usuario.id), String(operation.parameters_hash)]),
    /duplicate key|unique/i,
    'só pode existir UMA aprovação "approve" por operação'
  );
  const aprovRow = await getStore().findOneWhere(R_APPROVALS, { operation_id: Number(operation.id), decision: 'approve' });
  assert.ok(aprovRow, 'a aprovação foi persistida');

  // E — a cadeia de auditoria fecha com occurred_at vindo como Date do driver.
  const verif = await verificarCadeiaOperacao(Number(operation.id));
  assert.equal(verif.ok, true, `cadeia quebrada no PG: ${JSON.stringify(verif.quebras)}`);
  assert.ok(verif.total >= 2, 'a trilha tem ao menos requested + approved');

  void atorB;
});

type Ator = import('../../modules/operational-control/domain/operation').OperationalActor;
