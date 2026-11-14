// ============================================================================
// ETAPA 05 — CONTRATOS DA PLATAFORMA DE IA (gate antes das Etapas 06/07/08).
//
// A missão exige validar a base existente por checklist + testes de contrato
// ANTES de construir Trend Hunter / Creator Intelligence / AI Studio-CEO.
// Este arquivo trava os contratos REAIS da plataforma (schema + resources +
// engine determinística), sem criar plataforma paralela:
//
//   C1  prompts versionados: (empresa, chave, versao) único no schema;
//   C2  execuções auditáveis: READ_ONLY no CRUD, custo >= 0, estados fechados,
//       chave de idempotência com índice único parcial por empresa;
//   C3  recomendações: score 0..1, evidência JSONB, decisão humana registrada
//       (decidido_por/em), aplicação NUNCA automática;
//   C4  engine determinística reproduzível: mesma entrada ⇒ mesma saída,
//       modelo declarado 'heuristica-interna', custo 0 (sem LLM externo);
//   C5  RBAC: providers/prompts admin; executions/recommendations gerente;
//   C6  tenant A×B nos 4 recursos ai_*;
//   C7  Control Tower é leitura: não escreva operação; null ≠ 0.
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

process.env.NODE_ENV = 'test';
delete process.env.DATABASE_URL;

const { RESOURCES } = await import('../src/resources');
const { getStore, checkAccess } = await import('../src/services');
const { escopoDeSistema } = await import('../src/empresa');
const { listRecords, getRecord } = await import('../src/services');

const schema = readFileSync(new URL('../../db/schema.sql', import.meta.url), 'utf8');
const s = getStore();

test('C1 — ai_prompts: versão é parte da identidade (empresa, chave, versao) e não se sobrescreve', () => {
  assert.match(schema, /ai_prompts_empresa_chave_versao_uq[\s\S]{0,120}\(empresa_id, chave, versao\)/);
  const r = RESOURCES.ai_prompts;
  assert.equal(r.empresa, true);
  const versao = r.fields.find((f) => f.name === 'versao');
  assert.ok(versao?.required, 'versao obrigatória');
  assert.match(schema, /ai_prompts_versao_valida CHECK \(versao >= 1\)/);
});

test('C2 — ai_executions: append-only, custo não-negativo, estados fechados, idempotência por empresa', () => {
  const r = RESOURCES.ai_executions;
  assert.equal(r.empresa, true);
  assert.equal(r.ops.create, false);
  assert.equal(r.ops.update, false);
  assert.equal(r.ops.delete, false);
  assert.match(schema, /ai_executions_custo_valido CHECK \(custo >= 0\)/);
  assert.match(schema, /ai_executions_estado_valido CHECK \(estado IN \('sucesso','falha','fallback'\)\)/);
  assert.match(schema, /ai_executions_empresa_chave_uq[\s\S]{0,160}\(empresa_id, chave_idempotencia\) WHERE chave_idempotencia IS NOT NULL/);
});

test('C3 — ai_recommendations: score limitado, evidência obrigatória por tipo, decisão humana', async () => {
  assert.match(schema, /ai_recommendations_score_valido CHECK \(score >= 0 AND score <= 1\)/);
  assert.match(schema, /ai_recommendations_status_valido CHECK \(status IN \('pendente','aceita','rejeitada','aplicada'\)\)/);
  assert.match(schema, /decidido_por INTEGER REFERENCES usuarios\(id\)/);
  const { decidirRecomendacao } = await import('../src/enterprise45');
  // O autor da decisão precisa ser um usuário REAL (decidido_por é FK validada).
  const usuario = await s.insert(RESOURCES.usuarios, { nome: 'Gestor IA', email: `gestor-ia-${Date.now()}@brobond.test`, perfil: 'gerente', empresa_id: 1, ativo: true });
  const actor = { id: Number(usuario.id), name: 'Gestor IA', perfil: 'gerente' as const, empresa_id: 1, empresas: [1] };
  const rec = await s.insert(RESOURCES.ai_recommendations, { empresa_id: 1, dominio: 'inventory', modelo: 'heuristica-interna', score: 0.5, evidencia: { produto_id: 1 }, recomendacao: 'Repor item de teste.', status: 'pendente' });
  let payload: any;
  const req: any = { params: { id: String(rec.id) }, body: { status: 'aceita' }, user: actor, query: {} };
  const res: any = { json: (v: any) => (payload = v), status: () => res };
  await decidirRecomendacao(req, res);
  const decidida = await s.get(RESOURCES.ai_recommendations, Number(rec.id));
  assert.equal(decidida!.status, 'aceita');
  assert.equal(Number(decidida!.decidido_por), actor.id, 'a decisão registra QUEM decidiu');
  assert.ok(decidida!.decidido_em);
  // Nenhuma operação de estoque/pagamento foi executada pela decisão (só o registro).
  void payload;
});

test('C4 — engine determinística: mesma entrada ⇒ mesma saída; modelo e custo declarados', async () => {
  const { gerarRecomendacoes } = await import('../src/enterprise45');
  const usuario = await s.insert(RESOURCES.usuarios, { nome: 'Gerente Det', email: `gerente-det-${Date.now()}@brobond.test`, perfil: 'gerente', empresa_id: 1, ativo: true });
  const actor = { id: Number(usuario.id), name: 'Gerente Det', perfil: 'gerente' as const, empresa_id: 1, empresas: [1] };
  const chamar = async () => {
    let payload: any;
    const req: any = { body: { dominio: 'inventory' }, user: actor, query: {}, params: {} };
    const res: any = { json: (v: any) => (payload = v), status: () => res };
    await gerarRecomendacoes(req, res);
    return payload;
  };
  const a = await chamar();
  const b = await chamar();
  const essencial = (x: any) => x.recomendacoes.map((r: any) => ({ dominio: r.dominio, modelo: r.modelo, score: String(r.score), evidencia: r.evidencia, recomendacao: r.recomendacao }));
  assert.deepEqual(essencial(a), essencial(b), 'reproduzibilidade: entradas iguais produzem as mesmas recomendações');
  for (const r of a.recomendacoes) {
    assert.equal(r.modelo, 'heuristica-interna', 'o modelo real é declarado — nunca um LLM inexistente');
    assert.ok(Number(r.score) >= 0 && Number(r.score) <= 1);
  }
  const exec = await s.get(RESOURCES.ai_executions, Number(a.execucao_id));
  assert.equal(Number(exec!.custo), 0, 'heurística interna tem custo 0 — sem custo fabricado');
  assert.equal(exec!.estado, 'sucesso');
});

test('C5 — RBAC da plataforma: providers/prompts exigem admin; executions/recommendations exigem gerente', () => {
  const admin = { id: 1, name: 'a', perfil: 'admin' } as any;
  const gerente = { id: 2, name: 'g', perfil: 'gerente' } as any;
  const operador = { id: 3, name: 'o', perfil: 'operador' } as any;
  for (const key of ['ai_providers', 'ai_prompts'] as const) {
    assert.doesNotThrow(() => checkAccess(RESOURCES[key], admin, 'read'));
    assert.throws(() => checkAccess(RESOURCES[key], gerente, 'read'), (e: any) => e.status === 403);
  }
  for (const key of ['ai_executions', 'ai_recommendations'] as const) {
    assert.doesNotThrow(() => checkAccess(RESOURCES[key], gerente, 'read'));
    assert.throws(() => checkAccess(RESOURCES[key], operador, 'read'), (e: any) => e.status === 403);
  }
});

test('C6 — tenant A×B nos quatro recursos ai_*', async () => {
  const A = escopoDeSistema(1);
  const B = escopoDeSistema(2);
  const linhas: Array<[string, Record<string, unknown>]> = [
    ['ai_providers', { empresa_id: 1, nome: `Provider A ${Date.now()}`, tipo: 'heuristica' }],
    ['ai_prompts', { empresa_id: 1, chave: `chave-${Date.now()}`, versao: 1, conteudo: 'prompt de teste' }],
    ['ai_executions', { empresa_id: 1, finalidade: 'teste-tenant', estado: 'sucesso', custo: 0 }],
    ['ai_recommendations', { empresa_id: 1, dominio: 'sales', score: 0.4, evidencia: {}, recomendacao: 'teste tenant', status: 'pendente' }],
  ];
  for (const [key, body] of linhas) {
    const r = RESOURCES[key];
    const row = await s.insert(r, body);
    await assert.rejects(() => getRecord(r, Number(row.id), B), (e: any) => e.status === 404, `${key}: B não lê A`);
    const listaB = await listRecords(r, { page: 1, pageSize: 500 }, B);
    assert.ok(!listaB.rows.some((x) => Number(x.id) === Number(row.id)), `${key}: listagem de B não contém A`);
  }
});

test('C7 — Control Tower: contrato de leitura com definição/fórmula/origem/limitações e null ≠ 0', async () => {
  const { painelControlTower } = await import('../src/controlTower');
  const painel = await painelControlTower(2);
  assert.equal(painel.empresa_id, 2);
  assert.ok(painel.indicadores.length > 0);
  for (const ind of painel.indicadores) {
    assert.ok(ind.definicao, `indicador ${ind.chave} tem definição`);
    assert.ok(ind.formula, `indicador ${ind.chave} tem fórmula`);
    assert.ok(Array.isArray(ind.origem) && ind.origem.length > 0, `indicador ${ind.chave} tem origem`);
    assert.ok(Array.isArray(ind.limitacoes));
    assert.ok(ind.valor === null || Number.isFinite(Number(ind.valor)), 'valor é null ou número — nunca texto inventado');
  }
  assert.ok(painel.gerado_em, 'data de referência do painel');
  assert.ok(Array.isArray(painel.limitacoes));
  // Recomendações pendentes carregam confiança/aprovação — nunca aplicadas sozinhas.
  for (const r of painel.recomendacoes.pendentes) {
    assert.ok(['baixa', 'media', 'alta'].includes(r.confianca));
    assert.equal(typeof r.requer_aprovacao, 'boolean');
  }
});

test('C8 — não existe adapter LLM externo silencioso: nenhum SDK de proveedor no código de produção', () => {
  // A plataforma declara.tipo 'externo' como configuração, mas nenhum adapter
  // executa chamadas externas hoje. Este contrato evita que alguém anuncie
  // capacidade generativa sem o adapter homologado (Etapa 05 §alvo).
  const pkg = JSON.parse(readFileSync(new URL('../../server/package.json', import.meta.url), 'utf8'));
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  for (const sdk of ['openai', '@anthropic-ai/sdk', '@google/generative-ai', 'langchain']) {
    assert.equal(deps[sdk], undefined, `${sdk} não pode aparecer sem a arquitetura-alvo implementada e homologada`);
  }
});
