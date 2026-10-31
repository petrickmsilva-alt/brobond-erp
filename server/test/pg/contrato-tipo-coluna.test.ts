// ============================================================================
// CONTRATO TIPO × COLUNA — a guarda estrutural do P0-02 (ERP-03).
//
// O defeito que a auditoria provou: `gateway_webhook_events.payload` declarado
// `textarea` sobre uma coluna `jsonb`. O E4.2.3 corrigiu o lado da ESCRITA
// (`lerPayloadWebhook` lê pelo tipo real); este teste ataca a RECORRÊNCIA —
// nenhuma declaração de recurso pode divergir da coluna que existe no banco.
//
// Quatro regras, todas contra o PostgreSQL real, para os 88 recursos do
// sistema (os de `resources.ts` + os que cada módulo declara por fora):
//
//   1. existência — campo não-virtual tem coluna na tabela;
//   2. tipo       — o tipo declarado aceita o tipo da coluna (P0-02);
//   3. unicidade  — `unique` ⇒ índice único global; `uniqueEmpresa` ⇒ índice
//                   de (empresa_id, coluna). É o que o modo memória replica:
//                   declarar `unique` onde o banco tem unicidade por empresa
//                   fazia a memória recusar o mesmo SKU em outra empresa;
//   4. interface  — campo `json` editável em recurso público (o cliente não
//                   renderiza json e gravaria "[object Object]").
//
// O último teste é a PROVA DE MUTAÇÃO: um recurso sintético com a mesma
// declaração errada do P0-02 precisa ser reprovado pelo inspetor. Sem isso, o
// teste seria uma tautologia — passa sempre e não protege nada.
//
// Sem DATABASE_URL o arquivo se auto-pula (job `testes-postgres` do CI).
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

const temBanco = Boolean(process.env.DATABASE_URL);
const skip = temBanco ? false : 'requer DATABASE_URL (job testes-postgres do CI)';

process.env.NODE_ENV = 'test';

test('CONTRATO tipo × coluna: os 88 recursos batem com o banco real', { skip }, async (t) => {
  const { migrate, query } = await import('../../src/db');
  await migrate();
  const { RESOURCES } = await import('../../src/resources');
  const { inspecionar, indicesUnicosDe } = await import('./contratoTipos');
  const gateway = await import('../../src/gateway');
  const webhooks = await import('../../src/webhooks');
  const comissoes = await import('../../src/comissoes');
  const configuracoes = await import('../../src/configuracoes');
  const extrato = await import('../../src/extrato');

  // Recursos que não vivem em resources.ts (declarados pelos próprios módulos).
  // Se um destes imports deixar de exportar o recurso, o guarda abaixo acusa.
  const dosModulos = [
    ['gateway.R_GATEWAY_CONFIGS', gateway.R_GATEWAY_CONFIGS],
    ['gateway.R_GATEWAY_COBRANCAS', gateway.R_GATEWAY_COBRANCAS],
    ['gateway.R_GATEWAY_WEBHOOK_EVENTS', gateway.R_GATEWAY_WEBHOOK_EVENTS],
    ['webhooks.R_WEBHOOKS', webhooks.R_WEBHOOKS],
    ['webhooks.R_ENTREGAS', webhooks.R_ENTREGAS],
    ['comissoes.R_COMISSOES_EVENTOS', comissoes.R_COMISSOES_EVENTOS],
    ['configuracoes.R_CONFIGURACOES', configuracoes.R_CONFIGURACOES],
    ['extrato.R_EXTRATO', extrato.R_EXTRATO],
  ] as const;

  await t.test('nenhum recurso de módulo desapareceu da varredura', () => {
    for (const [nome, r] of dosModulos) assert.ok(r && r.table && r.fields?.length, `${nome} não foi carregado`);
  });

  const todos = [...Object.values(RESOURCES), ...dosModulos.map(([, r]) => r)];
  assert.ok(todos.length >= 85, `esperava os recursos do sistema, achei ${todos.length}`);

  const entrada = [];
  for (const r of todos) {
    const cols = await query(`SELECT c.column_name,
              CASE WHEN c.data_type = 'USER-DEFINED' AND t.typtype = 'e' THEN 'text'
                   ELSE c.data_type END AS data_type
         FROM information_schema.columns c
         LEFT JOIN pg_type t ON t.typname = c.udt_name
        WHERE c.table_name = $1`, [r.table]);
    const idx = await query(`SELECT indexname, indexdef FROM pg_indexes WHERE tablename = $1`, [r.table]);
    entrada.push({
      recurso: r,
      colunas: new Map<string, string>(cols.rows.map((c: any) => [c.column_name, c.data_type])),
      indices: indicesUnicosDe(idx.rows as any),
    });
  }

  const achados = inspecionar(entrada);
  assert.deepEqual(
    achados,
    [],
    `declarações fora do contrato:\n${achados.map((a) => ` [${a.regra}] ${a.recurso}.${a.campo} (${a.tabela}): ${a.detalhe}`).join('\n')}`
  );
});

test('CONTRATO: o inspetor REPROVA a declaração errada do P0-02 (prova de mutação)', { skip }, async () => {
  const { inspecionar } = await import('./contratoTipos');
  const { RESOURCES } = await import('../../src/resources');
  const { query, migrate } = await import('../../src/db');
  await migrate();

  // Colunas e índices REAIS da tabela do webhook.
  const tabela = 'gateway_webhook_events';
  const cols = await query(`SELECT c.column_name,
              CASE WHEN c.data_type = 'USER-DEFINED' AND t.typtype = 'e' THEN 'text'
                   ELSE c.data_type END AS data_type
         FROM information_schema.columns c
         LEFT JOIN pg_type t ON t.typname = c.udt_name
        WHERE c.table_name = $1`, [tabela]);
  const idx = await query(`SELECT indexname, indexdef FROM pg_indexes WHERE tablename = $1`, [tabela]);
  const colunas = new Map<string, string>(cols.rows.map((c: any) => [c.column_name, c.data_type]));
  const indices = (await import('./contratoTipos')).indicesUnicosDe(idx.rows as any);

  // (1) A declaração EXATA que causou o P0-02: `payload` como textarea sobre jsonb.
  const mutante = {
    ...RESOURCES.produtos, // estrutura qualquer; os campos são substituídos
    key: 'gateway_webhook_events',
    table: tabela,
    label: 'Mutante',
    singular: 'Mutante',
    labelFields: ['evento_id'],
    // Interno: as regras de tipo/unicidade são testadas isoladamente; a regra de
    // interface (json editável em recurso público) tem o seu próprio caso (4).
    internal: true,
    fields: [
      { name: 'payload', label: 'Payload', type: 'textarea' },
      { name: 'evento_id', label: 'Evento', type: 'text' },
    ],
  } as any;
  const achados = inspecionar([{ recurso: mutante, colunas, indices }]);
  assert.equal(achados.length, 1, 'o inspetor precisa reprovar textarea sobre jsonb');
  assert.equal(achados[0].regra, 'tipo');
  assert.match(achados[0].detalhe, /jsonb/);

  // (2) A declaração com a qual o P0-02 deixaria de existir: `json` sobre jsonb.
  const correto = { ...mutante, fields: [{ name: 'payload', label: 'Payload', type: 'json' }] };
  assert.deepEqual(inspecionar([{ recurso: correto, colunas, indices }]), []);

  // (3) Unicidade: declarar `unique` (global) onde o banco só tem índice por
  //     empresa — o caso de produtos.sku/empresas.nome antes deste ciclo.
  const produtos = RESOURCES.produtos;
  const colsP = await query(`SELECT c.column_name,
              CASE WHEN c.data_type = 'USER-DEFINED' AND t.typtype = 'e' THEN 'text'
                   ELSE c.data_type END AS data_type
         FROM information_schema.columns c
         LEFT JOIN pg_type t ON t.typname = c.udt_name
        WHERE c.table_name = 'produtos'`);
  const idxP = await query(`SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'produtos'`);
  const mutanteUnico = {
    ...produtos,
    fields: produtos.fields.filter((f) => f.name === 'sku').map((f) => ({ ...f, unique: true, uniqueEmpresa: false })),
  } as any;
  const achadosU = inspecionar([
    {
      recurso: mutanteUnico,
      colunas: new Map<string, string>(colsP.rows.map((c: any) => [c.column_name, c.data_type])),
      indices: (await import('./contratoTipos')).indicesUnicosDe(idxP.rows as any),
    },
  ]);
  assert.equal(achadosU.length, 1);
  assert.equal(achadosU[0].regra, 'unicidade');
  assert.match(achadosU[0].detalhe, /uniqueEmpresa|empresa_id/);

  // (4) Interface: campo json editável em recurso público. O cliente TEM editor
  // de JSON (RecordForm), então a declaração é aceita; o inspetor só a
  // reprovaria se o renderizador deixasse de existir (CLIENTE_SUPORTA_JSON).
  const mutanteInterface = {
    ...mutante,
    internal: false,
    fields: [{ name: 'payload', label: 'Payload', type: 'json' }],
  } as any;
  const achadosI = inspecionar([{ recurso: mutanteInterface, colunas, indices }]);
  assert.deepEqual(
    achadosI,
    [],
    'com o editor de JSON no cliente, campo json público editável é válido'
  );
  const { CLIENTE_SUPORTA_JSON } = await import('./contratoTipos');
  assert.equal(CLIENTE_SUPORTA_JSON, true, 'o cliente declara suporte a json — RecordForm.json.test.tsx prova o editor');
});
