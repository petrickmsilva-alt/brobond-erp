// ============================================================================
// FASE 9.2 — CRM LIFECYCLE AUTOMATION em PostgreSQL REAL (BL-012/GAP-P2-06).
//
// Prova, sobre as constraints e o UNIQUE reais de `crm_notificacoes`:
//   1. a tabela existe com o UNIQUE `(empresa_id, chave_idempotencia)` — a
//      idempotência é garantida pelo BANCO, não só pelo código;
//   2. reprocessar o MESMO fato (mesma chave) não insere segunda linha;
//   3. o CHECK de `tipo` recusa vocabulário fora do contrato;
//   4. o CHECK de `severidade` recusa valor fora do contrato;
//   5. `titulo` em branco é recusado;
//   6. o isolamento por tenant funciona no SQL (empresa A não lê a caixa de B);
//   7. `atividade_id` inválido (órfão) é recusado pela FK;
//   8. a notificação não altera o estado da atividade (é aviso, não ação).
//
// Sem DATABASE_URL o arquivo se auto-pula (job `testes-postgres` do CI).
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

const temBanco = Boolean(process.env.DATABASE_URL);
const skip = temBanco ? false : 'requer DATABASE_URL (job testes-postgres do CI)';

process.env.NODE_ENV = 'test';

test('Fase 9.2: caixa interna do CRM é idempotente e isolada por empresa (PostgreSQL real)', { skip }, async () => {
  const { migrate, query } = await import('../../src/db');
  await migrate();
  const { getResource } = await import('../../src/resources');
  const { getStore } = await import('../../src/services');
  const crmN = await import('../../src/crmNotificacoes');

  const sufixo = Date.now().toString(36).toUpperCase();
  const linha = async <T = any>(sql: string, params: unknown[] = []): Promise<T[]> => (await query(sql, params)).rows as T[];

  const [empA] = await linha<{ id: number }>(`INSERT INTO empresas (nome, razao_social, ativo) VALUES ($1,$2,true) RETURNING id`, [`F92 A ${sufixo}`, `F92 A ${sufixo} LTDA`]);
  const [empB] = await linha<{ id: number }>(`INSERT INTO empresas (nome, razao_social, ativo) VALUES ($1,$2,true) RETURNING id`, [`F92 B ${sufixo}`, `F92 B ${sufixo} LTDA`]);
  const aId = Number(empA.id);
  const bId = Number(empB.id);
  const [usrA] = await linha<{ id: number }>(`INSERT INTO usuarios (nome,email,perfil,ativo,empresa_id) VALUES ($1,$2,'gerente',true,$3) RETURNING id`, [`F92 A ${sufixo}`, `f92a-${sufixo}@brobond.test`, aId]);
  const [usrB] = await linha<{ id: number }>(`INSERT INTO usuarios (nome,email,perfil,ativo,empresa_id) VALUES ($1,$2,'gerente',true,$3) RETURNING id`, [`F92 B ${sufixo}`, `f92b-${sufixo}@brobond.test`, bId]);

  const s = getStore();
  const R_ATIV = getResource('crm_atividades')!;
  const R_NOTIF = getResource('crm_notificacoes')!;

  const atA = await s.insert(R_ATIV, { empresa_id: aId, status: 'pendente', tipo: 'chamada', resumo: `F92 A ${sufixo}`, data_atividade: new Date().toISOString(), responsavel_id: usrA.id } as any);

  // (1) idempotência: o MESMO fato não duplica (o UNIQUE do banco é a rede).
  const primeira = await crmN.notificarAtividadeCriada(atA);
  const segunda = await crmN.notificarAtividadeCriada(atA);
  assert.equal(primeira, true, 'primeiro aviso criado');
  assert.equal(segunda, false, 'mesmo fato não duplica');
  const naCaixaA = await s.list(R_NOTIF, { page: 1, pageSize: 100, filter: { empresa_id: aId } });
  assert.equal(naCaixaA.rows.length, 1, 'exatamente uma notificação na empresa A');

  // (2) o UNIQUE existe de fato no DDL.
  const [idx] = await linha<{ indexdef: string }>(
    `SELECT indexdef FROM pg_indexes WHERE tablename = 'crm_notificacoes' AND indexname = 'uq_crm_notificacoes_idempotencia'`
  );
  assert.ok(idx, 'UNIQUE (empresa_id, chave_idempotencia) existe no banco');
  assert.match(idx.indexdef, /UNIQUE/);

  // (3) CHECK de tipo recusa vocabulário fora do contrato.
  await assert.rejects(
    () => linha(`INSERT INTO crm_notificacoes (empresa_id, tipo, titulo, chave_idempotencia, usuario_id) VALUES ($1,'inventado','x',$2,$3)`, [aId, `bad-${sufixo}`, usrA.id]),
    /check|constraint/i,
  );

  // (4) CHECK de severidade recusa valor fora do contrato.
  await assert.rejects(
    () => linha(`INSERT INTO crm_notificacoes (empresa_id, tipo, severidade, titulo, chave_idempotencia, usuario_id) VALUES ($1,'lembrete','urgentissimo','x',$2,$3)`, [aId, `badsev-${sufixo}`, usrA.id]),
    /check|constraint/i,
  );

  // (5) título em branco é recusado.
  await assert.rejects(
    () => linha(`INSERT INTO crm_notificacoes (empresa_id, tipo, titulo, chave_idempotencia, usuario_id) VALUES ($1,'lembrete','   ',$2,$3)`, [aId, `branco-${sufixo}`, usrA.id]),
    /check|constraint/i,
  );

  // (6) isolamento por tenant no SQL.
  const caixaB = await s.list(R_NOTIF, { page: 1, pageSize: 100, filter: { empresa_id: bId } });
  assert.equal(caixaB.rows.length, 0, 'empresa B não enxerga a caixa de A');
  const [contagemB] = await linha<{ n: string }>(`SELECT count(*)::text AS n FROM crm_notificacoes WHERE empresa_id = $1`, [bId]);
  assert.equal(contagemB.n, '0', 'nenhuma linha de B no SQL');

  // (7) FK: atividade de outro tenant/inexistente é recusada.
  await assert.rejects(
    () => linha(`INSERT INTO crm_notificacoes (empresa_id, atividade_id, tipo, titulo, chave_idempotencia, usuario_id) VALUES ($1, 99999999, 'lembrete','x',$2,$3)`, [aId, `orfao-${sufixo}`, usrA.id]),
    /foreign key|violates/i,
  );

  // (8) a notificação não altera a atividade (é aviso, não ação).
  const [ativDepois] = await linha<{ status: string; lembrete_enviado_em: string | null }>(
    `SELECT status, lembrete_enviado_em FROM crm_atividades WHERE id = $1`, [Number(atA.id)]
  );
  assert.equal(ativDepois.status, 'pendente', 'status intacto');
  assert.equal(ativDepois.lembrete_enviado_em, null, 'nenhum carimbo de envio por criar notificação interna');
});
