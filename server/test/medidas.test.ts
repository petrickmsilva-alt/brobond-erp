// Testes do módulo Tabela de Medidas (auditoria de 2026-09-08):
// validação de valores por unidade, trilha de auditoria na gravação,
// "atualizada em", resumo de completude por grade e fluxo de cópia entre grades.
// Rodam no banco em memória (modo demonstração) — não precisam de Postgres.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
delete process.env.DATABASE_URL;

const { RESOURCES } = await import('../src/resources');
const { createRecord, getStore } = await import('../src/services');
const { getMedidasGrade, resumoMedidasGrades, saveMedidasGrade, parseValorMedida, erroValorMedida, LIMITE_POR_UNIDADE } =
  await import('../src/medidas');

const admin = { id: 1, name: 'Admin', email: 'admin@brobond.com.br', perfil: 'admin' as const };

function fakeReq(params: Record<string, unknown> = {}, body: unknown = {}) {
  return { user: admin, params, query: {}, body, headers: {}, ip: '127.0.0.1' } as any;
}
function fakeRes() {
  const out: any = { code: 200, body: null as unknown };
  out.json = (b: unknown) => {
    out.body = b;
    return out;
  };
  out.status = (c: number) => {
    out.code = c;
    return out;
  };
  out.setHeader = () => out;
  return out;
}

async function putMedidas(gradeId: number, body: unknown) {
  const res = fakeRes();
  try {
    await saveMedidasGrade(fakeReq({ id: String(gradeId) }, body), res);
    return { code: 200, body: res.body };
  } catch (e: any) {
    return { code: e.status ?? 500, message: e.message, body: res.body };
  }
}
async function getMedidas(gradeId: number) {
  const res = fakeRes();
  await getMedidasGrade(fakeReq({ id: String(gradeId) }), res);
  return res.body as any;
}

const s = getStore();
const GRADE_A = 1; // "Camiseta PP-GG" — tamanhos 1..5 no seed
const GRADE_B = 2; // "Calça 36-48" — tamanhos 6..12 no seed

const TABELA_A = {
  medidas: [
    { nome: 'Largura (A)', unidade: 'cm' },
    { nome: 'Comprimento (B)', unidade: 'cm' },
  ],
  valores: [
    { medida_nome: 'Largura (A)', tamanho_id: 1, valor: '50' },
    { medida_nome: 'Largura (A)', tamanho_id: 2, valor: '52,5' },
    { medida_nome: 'Comprimento (B)', tamanho_id: 1, valor: 62 },
  ],
};

before(async () => {
  const grades = (await s.list(RESOURCES.grades, { page: 1, pageSize: 50 })).rows;
  assert.ok(grades.length >= 2, 'seed de demonstração precisa de ao menos 2 grades');
  const itensA = (await s.list(RESOURCES.grade_tamanhos, { page: 1, pageSize: 100, filter: { grade_id: GRADE_A } })).rows;
  assert.ok(itensA.length >= 2, 'a grade A precisa de ao menos 2 tamanhos');
});

test('parseValorMedida: vírgula decimal, vazio e lixo', () => {
  assert.equal(parseValorMedida('52,5'), 52.5);
  assert.equal(parseValorMedida('50'), 50);
  assert.equal(parseValorMedida('  '), null);
  assert.ok(Number.isNaN(parseValorMedida('abc') as number));
});

test('erroValorMedida: limites por unidade (cm ≤ 300, mm ≤ 3000, pol ≤ 150)', () => {
  assert.equal(erroValorMedida('Largura', 'cm', null), null);
  assert.equal(erroValorMedida('Largura', 'cm', 300), null);
  assert.match(erroValorMedida('Largura', 'cm', 301) ?? '', /fora do plausível/);
  assert.match(erroValorMedida('Largura', 'cm', -5) ?? '', /maior que 0/);
  assert.equal(erroValorMedida('Largura', 'mm', LIMITE_POR_UNIDADE.mm), null);
  assert.match(erroValorMedida('Largura', 'mm', LIMITE_POR_UNIDADE.mm + 1) ?? '', /fora do plausível/);
  assert.equal(erroValorMedida('Largura', 'pol', 150), null);
  assert.match(erroValorMedida('Largura', 'pol', 151) ?? '', /fora do plausível/);
  assert.match(erroValorMedida('Largura', 'cm', NaN) ?? '', /não numérico/);
});

test('GET /grades/medidas-resumo devolve o status de cada grade', async () => {
  const res = fakeRes();
  await resumoMedidasGrades(fakeReq(), res);
  const d = res.body as any;
  assert.equal(d.total, (await s.list(RESOURCES.grades, { page: 1, pageSize: 50 })).total);
  const gA = d.grades.find((g: any) => g.id === GRADE_A);
  assert.ok(gA, 'grade A deve aparecer no resumo');
  assert.equal(typeof gA.pct, 'number');
  assert.ok(gA.celulas_total >= gA.celulas_preenchidas);
});

test('PUT salva colunas + valores e devolve o resumo de completude', async () => {
  const r = await putMedidas(GRADE_A, TABELA_A);
  assert.equal(r.code, 200, r.message);
  assert.equal(r.body.medidas.length, 2);
  assert.equal(r.body.resumo.celulas_total, 2 * r.body.tamanhos.length);
  assert.equal(r.body.resumo.celulas_preenchidas, 3);
  assert.ok(r.body.resumo.atualizada_em, 'a tabela deve registrar quando foi atualizada');

  const g = await getMedidas(GRADE_A);
  const largM = g.medidas.find((m: any) => m.nome === 'Largura (A)');
  const val = g.valores.find((v: any) => v.medida_id === largM.id && v.tamanho_id === 2);
  assert.equal(val.valor, 52.5, 'vírgula decimal deve virar número');
});

test('toda gravação da tabela deixa entrada na auditoria', async () => {
  await putMedidas(GRADE_A, { ...TABELA_A, valores: [...TABELA_A.valores, { medida_nome: 'Comprimento (B)', tamanho_id: 2, valor: 64 }] });
  const eventos = (await s.list(RESOURCES.auditoria, { page: 1, pageSize: 100, filter: { registro_id: GRADE_A } })).rows;
  assert.ok(eventos.length >= 1, 'era esperada ao menos uma entrada de auditoria');
  const ultimo = eventos[eventos.length - 1];
  assert.equal(ultimo.acao, 'editar');
  assert.equal(ultimo.recurso, 'grades');
  assert.equal(ultimo.registro_id, GRADE_A);
  assert.match(String(ultimo.descricao), /Tabela de medidas/);
});

test('PUT rejeita valor negativo (antes: gravava)', async () => {
  const r = await putMedidas(GRADE_A, { ...TABELA_A, valores: [{ medida_nome: 'Largura (A)', tamanho_id: 1, valor: '-5' }] });
  assert.equal(r.code, 400);
  assert.match(r.message, /maior que 0/);
});

test('PUT rejeita valor fora do plausível da unidade', async () => {
  const r = await putMedidas(GRADE_A, { ...TABELA_A, valores: [{ medida_nome: 'Largura (A)', tamanho_id: 1, valor: 301 }] });
  assert.equal(r.code, 400);
  assert.match(r.message, /fora do plausível/);
  const ok = await putMedidas(GRADE_A, TABELA_A);
  assert.equal(ok.code, 200, 'valor no limite (300 cm) é aceitável');
});

test('PUT rejeita valor não numérico (antes: silenciosamente virava NULL)', async () => {
  const r = await putMedidas(GRADE_A, { ...TABELA_A, valores: [{ medida_nome: 'Largura (A)', tamanho_id: 1, valor: 'abc' }] });
  assert.equal(r.code, 400);
  assert.match(r.message, /não numérico/);
});

test('célula apagada na tela remove o valor no banco (PUT é substituição integral)', async () => {
  // Tabela com 2 valores
  await putMedidas(GRADE_A, {
    medidas: [{ nome: 'Largura (A)', unidade: 'cm' }],
    valores: [
      { medida_nome: 'Largura (A)', tamanho_id: 1, valor: 50 },
      { medida_nome: 'Largura (A)', tamanho_id: 2, valor: 52.5 },
    ],
  });
  // "Apaga" o PP (envia só o P — é assim que o front trata célula vazia)
  const r = await putMedidas(GRADE_A, {
    medidas: [{ nome: 'Largura (A)', unidade: 'cm' }],
    valores: [{ medida_nome: 'Largura (A)', tamanho_id: 2, valor: 52.5 }],
  });
  assert.equal(r.code, 200, r.message);
  const g = await getMedidas(GRADE_A);
  const largM = g.medidas.find((m: any) => m.nome === 'Largura (A)');
  assert.ok(!g.valores.find((v: any) => v.medida_id === largM.id && v.tamanho_id === 1), 'o valor do PP deveria ter sido removido');
  assert.ok(g.valores.find((v: any) => v.medida_id === largM.id && v.tamanho_id === 2), 'o valor do P continua');
});

test('PUT rejeita coluna duplicada', async () => {
  const r = await putMedidas(GRADE_A, {
    medidas: [
      { nome: 'Largura (A)', unidade: 'cm' },
      { nome: 'largura (a)', unidade: 'cm' },
    ],
    valores: [],
  });
  assert.equal(r.code, 400);
  assert.match(r.message, /duplicada/);
});

test('fluxo de cópia: tabela de uma grade pode ser reaproveitada em outra', async () => {
  // Monta a "origem" (o que o front faz: GET + PUT no destino)
  const origem = await getMedidas(GRADE_A);
  const payload = {
    medidas: origem.medidas.map((m: any) => ({ nome: m.nome, unidade: m.unidade })),
    valores: origem.valores
      .filter((v: any) => v.valor !== null)
      .map((v: any) => {
        const nome = origem.medidas.find((m: any) => m.id === v.medida_id).nome;
        return { medida_nome: nome, tamanho_id: v.tamanho_id, valor: v.valor };
      }),
  };
  const r = await putMedidas(GRADE_B, payload);
  assert.equal(r.code, 200, r.message);
  const destino = await getMedidas(GRADE_B);
  assert.equal(destino.medidas.length, origem.medidas.length);
  assert.equal(destino.resumo.celulas_preenchidas, origem.resumo.celulas_preenchidas);
});

test('valores gravados carregam atualizado_em (cliente vê a data)', async () => {
  const destino = await getMedidas(GRADE_B);
  assert.ok(destino.resumo.atualizada_em, 'a tabela da grade B deve ter data de atualização');
  // e a própria linha medida_valores carrega o carimbo — é o que alimenta o painel e o "atualizada em"
  for (const m of destino.medidas as any[]) {
    const linhas = (await s.list(RESOURCES.medida_valores, { page: 1, pageSize: 100, filter: { medida_id: m.id } })).rows;
    for (const l of linhas) {
      if (l.valor === null || l.valor === undefined) continue;
      assert.ok(l.atualizado_em, `valor da medida "${m.nome}" deveria ter atualizado_em`);
    }
  }
});

test('catálogo novo nasce com a tabela de medidas visível para o cliente', async () => {
  const sufixo = Date.now() % 1000000;
  const cat = await createRecord(RESOURCES.catalogos, { nome: `Cat Teste ${sufixo}` }, admin);
  assert.equal(cat.mostrar_medidas, true, 'catálogo novo deve expor a tabela de medidas por padrão');
});
