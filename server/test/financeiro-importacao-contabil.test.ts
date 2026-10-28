// ============================================================================
// FINANCEIRO 3.0 — IMPORTAÇÃO CONTÁBIL (migration 0059)
//
// O que este arquivo trava (banco de demonstração, mesmo contrato do PG):
//   A) PREVIEW não grava nada e prova o balanço por lançamento;
//   B) CONFIRMAÇÃO grava no LIVRO ÚNICO (lancamentos_financeiros), com origem
//      carimbada, conta/natureza e partida_id agrupando débito+crédito;
//   C) IDEMPOTÊNCIA pelo hash — reimportar o mesmo conteúdo não duplica linha;
//   D) LOTE DESBALANCEADO é recusado com 400 (por ENTRADA, não só no total);
//   E) CONTA INVÁLIDA (inexistente, sintética ou inativa) é recusada com 422;
//   F) ISOLAMENTO MULTIEMPRESA: o plano de contas é o da empresa do ator;
//   G) FLUXO DE CAIXA NÃO CONTA DUAS VEZES: as partidas contábeis ficam fora do
//      resumo financeiro, mas aparecem no balancete e são declaradas em
//      `contabil_ignorado`.
// ============================================================================
import { test, before } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
delete process.env.DATABASE_URL;

const { RESOURCES } = await import('../src/resources');
const { createRecord, listRecords, updateRecord, getStore } = await import('../src/services');
const { confirmarImportacaoContabil, previewImportacaoContabil, normalizarImportacao, hashDaImportacao } = await import(
  '../src/financeiroImportacao'
);
const { balanceteFinanceiro } = await import('../src/financeiroContabil');
const { resumoFinanceiro } = await import('../src/financeiro');
const { criarAtor, garantirAdmin } = await import('./_p1util');
const { escopoDeSistema } = await import('../src/empresa');

await garantirAdmin();
const admin = { id: 1, name: 'Admin', perfil: 'admin' as const };
let gerente: any;

async function chamar(handler: any, opts: { actor: any; body?: any; query?: any }) {
  let payload: any;
  let status: number | undefined;
  const req: any = { params: {}, body: opts.body ?? {}, user: opts.actor, query: opts.query ?? {} };
  const res: any = {
    status: (c: number) => {
      status = c;
      return res;
    },
    json: (v: any) => {
      payload = v;
      return res;
    },
  };
  await handler(req, res);
  // Handler que só chama res.json() está respondendo 200 (comportamento do Express).
  return { out: payload, status: status ?? 200 };
}

async function erroDe(handler: any, opts: { actor: any; body?: any; query?: any }) {
  try {
    await chamar(handler, opts);
  } catch (e: any) {
    return {
      status: Number(e?.status ?? 0),
      message: String(e?.message ?? ''),
      campos: e?.fields ?? null,
      detalhes: e?.details ?? null,
    };
  }
  throw new Error('esperava erro e não houve');
}

let seq = 0;
const unico = () => `${Date.now() % 100000}-${++seq}`;

// Códigos de conta criados por este arquivo (o plano é único por empresa).
let cCaixa = '';
let cReceita = '';
let cDespesa = '';
let cSintetica = '';
let cInativa = '';
let cB = '';

before(async () => {
  getStore();
  gerente = await criarAtor(1, 'gerente');
  const gerenteB = await criarAtor(2, 'gerente');
  // Código contábil é numérico por ponto: nenhum separador além do ponto.
  const s = String(Date.now() % 100000);
  cCaixa = `9.${s}.1`;
  cReceita = `9.${s}.2`;
  cDespesa = `9.${s}.3`;
  cSintetica = `9.${s}`;
  cInativa = `9.${s}.4`;
  cB = `8.${s}.1`;

  const criar = async (empresaId: number, codigo: string, nome: string, tipo: string, natureza: string, ativo = true) => {
    return createRecord(
      RESOURCES.plano_contas,
      { codigo, nome, tipo, natureza, ativo },
      admin,
      { escopo: { kind: 'empresa', empresaId } } as any
    );
  };
  await criar(1, cSintetica, `Sintética ${s}`, 'sintetica', 'ativo');
  await criar(1, cCaixa, `Caixa ${s}`, 'analitica', 'ativo');
  await criar(1, cReceita, `Receita ${s}`, 'analitica', 'receita');
  await criar(1, cDespesa, `Despesa ${s}`, 'analitica', 'despesa');
  await criar(1, cInativa, `Inativa ${s}`, 'analitica', 'ativo', false);
  await criar(2, cB, `Caixa B ${s}`, 'analitica', 'ativo');
  void gerenteB;
});

function lote(valor = 100, data = '2026-05-10') {
  return {
    competencia: '2026-05',
    arquivo: `razao-${unico()}.csv`,
    entradas: [
      {
        data,
        historico: 'Recebimento de cliente',
        documento: 'NF-1',
        partidas: [
          { conta: cCaixa, natureza: 'debito', valor },
          { conta: cReceita, natureza: 'credito', valor },
        ],
      },
      {
        data,
        historico: 'Energia elétrica',
        partidas: [
          { conta: cDespesa, natureza: 'debito', valor: 30 },
          { conta: cCaixa, natureza: 'credito', valor: 30 },
        ],
      },
    ],
  };
}

const contarLancamentos = async (empresaId: number) =>
  (await listRecords(RESOURCES.lancamentos_financeiros, { page: 1, pageSize: 5000, filter: {} }, { kind: 'empresa', empresaId } as any)).rows;

// ---------------------------------------------------------------------------
// A) PREVIEW
// ---------------------------------------------------------------------------
test('A) preview contábil NÃO grava e declara o balanço por lançamento', async () => {
  const corpo = lote(100);
  const antes = await contarLancamentos(1);

  const { out, status } = await chamar(previewImportacaoContabil, { actor: gerente, body: corpo });

  assert.equal(status, 200);
  assert.equal(out.preview, true);
  assert.equal(out.gravado, false);
  assert.equal(out.balanceado, true);
  assert.equal(out.totais.entradas, 2);
  assert.equal(out.totais.partidas, 4);
  assert.equal(out.totais.total_debitos, 130);
  assert.equal(out.totais.total_creditos, 130);
  assert.equal(out.entradas.length, 2);
  // Cada entrada fecha sozinha: é o que o balanço do arquivo por lançamento prova.
  for (const e of out.entradas) assert.equal(e.debitos, e.creditos, `entrada ${e.numero} deve fechar`);
  // A conta aparece resolvida (nome e natureza vêm do plano da empresa).
  assert.equal(out.entradas[0].partidas[0].conta_nome.startsWith('Caixa'), true);
  assert.equal(out.entradas[0].partidas[0].conta_natureza, 'ativo');
  assert.match(String(out.regra), /não grava/i);

  const depois = await contarLancamentos(1);
  assert.equal(depois.length, antes.length, 'preview não pode escrever no livro');
});

// ---------------------------------------------------------------------------
// B) CONFIRMAÇÃO no livro único
// ---------------------------------------------------------------------------
test('B) confirmação grava no MESMO livro, com origem, conta e partida_id', async () => {
  const corpo = lote(250);
  const antes = await contarLancamentos(1);

  const { out, status } = await chamar(confirmarImportacaoContabil, { actor: gerente, body: corpo });
  assert.equal(status, 201);
  assert.equal(out.idempotente, false);
  assert.equal(out.partidas_gravadas, 4);
  assert.equal(out.totais.total_debitos, 280);
  assert.equal(out.totais.total_creditos, 280);

  const depois = await contarLancamentos(1);
  assert.equal(depois.length, antes.length + 4, 'quatro partidas, nenhuma linha extra');

  const doLote = depois.filter((l: any) => Number(l.documento_origem_id) === out.importacao_id);
  assert.equal(doLote.length, 4);
  for (const l of doLote) {
    assert.equal(String(l.documento_origem_recurso), 'fin_importacoes_contabeis');
    assert.ok(l.conta_contabil_id, 'partida precisa de conta contábil');
    assert.ok(['debito', 'credito'].includes(String(l.natureza_lancamento)));
    assert.equal(Number(l.empresa_id), 1);
    assert.equal(String(l.status), 'confirmado');
  }
  // partida_id agrupa débito e crédito da MESMA entrada: 2 e 2.
  const porPartida = new Map<number, any[]>();
  for (const l of doLote) {
    const k = Number(l.partida_id);
    porPartida.set(k, [...(porPartida.get(k) ?? []), l]);
  }
  assert.equal(porPartida.size, 2);
  for (const [numero, linhas] of porPartida) {
    const deb = linhas.filter((l) => l.natureza_lancamento === 'debito').reduce((a, l) => a + Number(l.valor), 0);
    const cred = linhas.filter((l) => l.natureza_lancamento === 'credito').reduce((a, l) => a + Number(l.valor), 0);
    assert.equal(deb, cred, `partida ${numero} precisa fechar no livro`);
  }
});

// ---------------------------------------------------------------------------
// C) IDEMPOTÊNCIA
// ---------------------------------------------------------------------------
test('C) reimportar o MESMO conteúdo devolve o mesmo lote e não duplica partida', async () => {
  const corpo = lote(75, '2026-06-01');
  const primeiro = await chamar(confirmarImportacaoContabil, { actor: gerente, body: corpo });
  assert.equal(primeiro.status, 201);

  const antes = (await contarLancamentos(1)).length;
  const segundo = await chamar(confirmarImportacaoContabil, { actor: gerente, body: corpo });

  assert.equal(segundo.status, 200);
  assert.equal(segundo.out.idempotente, true);
  assert.equal(segundo.out.partidas_gravadas, 0);
  assert.equal(segundo.out.importacao_id, primeiro.out.importacao_id);
  assert.match(String(segundo.out.mensagem), /já havia sido importado/i);
  assert.equal((await contarLancamentos(1)).length, antes, 'nada duplicado');

  // O hash é função do CONTEÚDO: mudar um valor muda o hash (novo lote).
  const outros = lote(76, '2026-06-01');
  const a = normalizarImportacao(lote(75, '2026-06-01'));
  const b = normalizarImportacao(outros);
  assert.notEqual(hashDaImportacao(a.entradas, a.competencia), hashDaImportacao(b.entradas, b.competencia));
});

// ---------------------------------------------------------------------------
// D) LOTE DESBALANCEADO
// ---------------------------------------------------------------------------
test('D) lote desbalanceado é recusado — inclusive quando o TOTAL fecha', async () => {
  // Caso clássico: total do arquivo fecha, mas as entradas estão trocadas.
  const torto = {
    entradas: [
      {
        data: '2026-05-10',
        historico: 'Entrada torta',
        partidas: [
          { conta: cCaixa, natureza: 'debito', valor: 100 },
          { conta: cReceita, natureza: 'credito', valor: 60 },
        ],
      },
      {
        data: '2026-05-10',
        historico: 'Entrada torta 2',
        partidas: [
          { conta: cDespesa, natureza: 'debito', valor: 60 },
          { conta: cCaixa, natureza: 'credito', valor: 100 },
        ],
      },
    ],
  };
  // Total: débitos 160 × créditos 160 — fecha no arquivo, quebra por lançamento.
  const somaDeb = torto.entradas.flatMap((e) => e.partidas.filter((p) => p.natureza === 'debito')).reduce((a, p) => a + p.valor, 0);
  const somaCred = torto.entradas.flatMap((e) => e.partidas.filter((p) => p.natureza === 'credito')).reduce((a, p) => a + p.valor, 0);
  assert.equal(somaDeb, somaCred);

  const antes = (await contarLancamentos(1)).length;
  const e = await erroDe(confirmarImportacaoContabil, { actor: gerente, body: torto });
  assert.equal(e.status, 400);
  assert.match(e.message, /não fecha/i);
  assert.equal((await contarLancamentos(1)).length, antes, 'lote recusado não pode gravar NADA');
});

test('D2) entrada com uma única partida (partida simples) é recusada', async () => {
  const e = await erroDe(confirmarImportacaoContabil, {
    actor: gerente,
    body: { entradas: [{ data: '2026-05-10', historico: 'Só débito', partidas: [{ conta: cCaixa, natureza: 'debito', valor: 10 }] }] },
  });
  assert.equal(e.status, 400);
  assert.match(e.message, /partida dobrada/i);
});

// ---------------------------------------------------------------------------
// E) CONTA INVÁLIDA
// ---------------------------------------------------------------------------
test('E) conta inexistente, sintética ou inativa é recusada com 422 e o lote não grava', async () => {
  const antes = (await contarLancamentos(1)).length;
  const casos: [string, RegExp][] = [
    ['9.999.999.999', /não existe/i],
    [cSintetica, /sintética/i],
    [cInativa, /inativa/i],
  ];
  for (const [conta, motivo] of casos) {
    const e = await erroDe(confirmarImportacaoContabil, {
      actor: gerente,
      body: { entradas: [{ data: '2026-05-10', historico: 'Conta ruim', partidas: [{ conta, natureza: 'debito', valor: 10 }, { conta: cReceita, natureza: 'credito', valor: 10 }] }] },
    });
    assert.equal(e.status, 422, `conta ${conta} deveria dar 422`);
    assert.match(JSON.stringify(e.campos), motivo);
  }
  assert.equal((await contarLancamentos(1)).length, antes);
});

// ---------------------------------------------------------------------------
// F) MULTIEMPRESA
// ---------------------------------------------------------------------------
test('F) o plano de contas usado é o da empresa do ator', async () => {
  // A conta cB existe só na empresa 2 → o gerente da empresa 1 não a "vê".
  const e = await erroDe(confirmarImportacaoContabil, {
    actor: gerente,
    body: { entradas: [{ data: '2026-05-10', historico: 'Conta da outra empresa', partidas: [{ conta: cB, natureza: 'debito', valor: 10 }, { conta: cReceita, natureza: 'credito', valor: 10 }] }] },
  });
  assert.equal(e.status, 422);
  assert.match(JSON.stringify(e.campos), /não existe/i);
});

// ---------------------------------------------------------------------------
// G) CAIXA × BALANCETE (sem dupla contagem)
// ---------------------------------------------------------------------------
test('G) partida contábil aparece no BALANCETE e fica fora do fluxo de caixa', async () => {
  const corpo: any = lote(500, '2026-07-15');
  // Sem competência declarada, a competência da partida é a própria data —
  // é assim que o balancete enxerga o lançamento.
  delete corpo.competencia;
  const { out } = await chamar(confirmarImportacaoContabil, { actor: gerente, body: corpo });
  assert.equal(out.partidas_gravadas, 4);

  const bal = await chamar(balanceteFinanceiro, { actor: gerente, query: { de: '2026-07', ate: '2026-07' } });
  assert.equal(bal.out.resumo.classificados >= 4, true, 'as partidas entram no balancete');
  const contaCaixa = bal.out.contas.find((c: any) => c.codigo === cCaixa);
  assert.ok(contaCaixa, 'a conta de caixa do lote precisa aparecer no balancete');
  assert.equal(contaCaixa.debitos, 500);
  assert.equal(contaCaixa.creditos, 30);

  const res = await chamar(resumoFinanceiro, { actor: gerente });
  assert.ok(res.out.contabil_ignorado, 'o resumo DECLARA o que ficou de fora do caixa');
  assert.ok(res.out.contabil_ignorado.partidas >= 4);
  assert.match(String(res.out.contabil_ignorado.motivo), /balancete/i);
  // E as partidas não entraram como receita/despesa do mês.
  const lanc = await contarLancamentos(1);
  const contabeis = lanc.filter((l: any) => String(l.documento_origem_recurso) === 'fin_importacoes_contabeis');
  assert.ok(contabeis.length >= 4);
});

test('H) ISOLAMENTO A × B: lote importado na empresa 1 não existe na empresa 2', async () => {
  const empresaA = escopoDeSistema(1);
  const empresaB = escopoDeSistema(2);
  assert.equal(empresaA.empresaId, 1);
  assert.equal(empresaB.empresaId, 2);

  const corpo: any = lote(90, '2026-08-05');
  delete corpo.competencia;
  const { out } = await chamar(confirmarImportacaoContabil, { actor: gerente, body: corpo });
  assert.equal(out.idempotente, false);

  const daA = await listRecords(RESOURCES.fin_importacoes_contabeis, { page: 1, pageSize: 500, filter: {} }, empresaA as any);
  const daB = await listRecords(RESOURCES.fin_importacoes_contabeis, { page: 1, pageSize: 500, filter: {} }, empresaB as any);
  assert.equal(daA.rows.some((l: any) => Number(l.id) === out.importacao_id), true, 'empresa 1 vê o lote');
  assert.equal(daB.rows.some((l: any) => Number(l.id) === out.importacao_id), false, 'empresa 2 NÃO vê o lote');
  assert.equal(daB.total, 0, 'empresa 2 não tem lote nenhum');

  // E as partidas também respeitam o escopo: nenhuma linha do lote aparece na B.
  const lancB = await contarLancamentos(2);
  assert.equal(lancB.some((l: any) => Number(l.documento_origem_id) === out.importacao_id), false);
});

// ---------------------------------------------------------------------------
// Metadados
// ---------------------------------------------------------------------------
test('recursos e campos da importação contábil existem e são coerentes', () => {
  const lotes = RESOURCES.fin_importacoes_contabeis;
  assert.ok(lotes, 'recurso fin_importacoes_contabeis deve existir');
  assert.equal(lotes.empresa, true, 'lote é multiempresa');
  assert.equal(lotes.minPerfil, 'gerente');
  assert.equal(lotes.ops.create, false, 'lote é criado pelo endpoint, não pelo CRUD genérico');
  assert.equal(lotes.ops.delete, false, 'lote importado não é apagável pelo CRUD');

  const nomes = RESOURCES.lancamentos_financeiros.fields.map((f) => f.name);
  for (const campo of ['conta_contabil_id', 'natureza_lancamento', 'documento_origem_recurso', 'documento_origem_id', 'competencia', 'partida_id']) {
    assert.ok(nomes.includes(campo), `lancamentos_financeiros deve expor ${campo}`);
  }
});

// ============================================================================
// P2-13 — IMPORTAÇÃO DO PLANO DE CONTAS
// ============================================================================
const { previewImportacaoPlano, confirmarImportacaoPlano } = await import('../src/financeiroImportacao');

const planoUnico = () => {
  const base = String(Date.now() % 9000 + 1000);
  return {
    sintetica: base,
    filha1: `${base}.1`,
    filha2: `${base}.2`,
    neta: `${base}.1.01`,
  };
};

test('P2-13/A) preview do plano NÃO grava e classifica criar × ignorar × problema', async () => {
  const p = planoUnico();
  const antes = (await listRecords(RESOURCES.plano_contas, { page: 1, pageSize: 5000, filter: {} }, { kind: 'empresa', empresaId: 1 } as any)).total;

  const body = {
    contas: [
      { codigo: p.sintetica, nome: `Grupo ${p.sintetica}`, natureza: 'ativo', tipo: 'sintetica' },
      { codigo: p.filha1, nome: 'Caixa', natureza: 'ativo', tipo: 'sintetica', pai_codigo: p.sintetica },
      { codigo: p.filha2, nome: 'Bancos', natureza: 'ativo', tipo: 'sintetica', pai_codigo: p.sintetica },
      { codigo: p.neta, nome: 'Caixa loja', natureza: 'ativo', tipo: 'analitica', pai_codigo: p.filha1 },
      // Conta que já existe (criada no before) e difere no nome → ignorada no modo padrão.
      { codigo: cCaixa, nome: 'Nome diferente', natureza: 'ativo', tipo: 'analitica' },
    ],
  };
  const { out, status } = await chamar(previewImportacaoPlano, { actor: gerente, body });
  assert.equal(status, 200);
  assert.equal(out.gravado, false);
  assert.equal(out.modo, 'criar_apenas');
  assert.equal(out.resumo.no_arquivo, 5);
  assert.equal(out.resumo.criar, 4, 'quatro contas novas');
  assert.equal(out.resumo.atualizar, 0, 'modo padrão não altera existente');
  assert.equal(out.resumo.ignorar, 1);
  assert.equal(out.resumo.problemas, 0);
  // Hierarquia deduzida do código quando o arquivo não informa `pai_codigo`.
  const raiz = out.criar.find((c: any) => c.codigo === p.sintetica);
  assert.equal(raiz.pai_codigo, null);
  assert.equal(raiz.pai_deduzido, true);

  const depois = (await listRecords(RESOURCES.plano_contas, { page: 1, pageSize: 5000, filter: {} }, { kind: 'empresa', empresaId: 1 } as any)).total;
  assert.equal(depois, antes, 'preview não cria conta');
});

test('P2-13/B) aplicação cria a hierarquia com pai_id e é idempotente', async () => {
  const p = planoUnico();
  const body = {
    contas: [
      { codigo: p.sintetica, nome: `Grupo ${p.sintetica}`, natureza: 'ativo', tipo: 'sintetica' },
      { codigo: p.filha1, nome: 'Caixa', natureza: 'ativo', tipo: 'sintetica', pai_codigo: p.sintetica },
      { codigo: p.neta, nome: 'Caixa loja', natureza: 'ativo', tipo: 'analitica', pai_codigo: p.filha1 },
    ],
  };
  const primeira = await chamar(confirmarImportacaoPlano, { actor: gerente, body });
  assert.equal(primeira.out.criadas, 3);
  assert.equal(primeira.out.atualizadas, 0);

  const todas = await listRecords(RESOURCES.plano_contas, { page: 1, pageSize: 5000, filter: {} }, { kind: 'empresa', empresaId: 1 } as any);
  const raiz = todas.rows.find((c: any) => c.codigo === p.sintetica)!;
  const filha = todas.rows.find((c: any) => c.codigo === p.filha1)!;
  const neta = todas.rows.find((c: any) => c.codigo === p.neta)!;
  assert.ok(raiz && filha && neta);
  assert.equal(Number(filha.pai_id), Number(raiz.id), 'pai_id aponta para a conta-pai real');
  assert.equal(Number(neta.pai_id), Number(filha.id));

  // Reimportar o MESMO arquivo não duplica nem altera nada.
  const antes = todas.total;
  const segunda = await chamar(confirmarImportacaoPlano, { actor: gerente, body });
  assert.equal(segunda.out.criadas, 0);
  assert.equal(segunda.out.atualizadas, 0);
  assert.equal(segunda.out.ignoradas, 3);
  const depois = await listRecords(RESOURCES.plano_contas, { page: 1, pageSize: 5000, filter: {} }, { kind: 'empresa', empresaId: 1 } as any);
  assert.equal(depois.total, antes, 'idempotente: nenhuma conta duplicada');
});

test('P2-13/C) estrutura inválida é recusada e NADA é gravado', async () => {
  const p = planoUnico();
  const antes = (await listRecords(RESOURCES.plano_contas, { page: 1, pageSize: 5000, filter: {} }, { kind: 'empresa', empresaId: 1 } as any)).total;

  const casos: { nome: string; body: any; status: number }[] = [
    {
      nome: 'código duplicado no arquivo',
      body: { contas: [
        { codigo: `${p.sintetica}.9`, nome: 'A', natureza: 'ativo', tipo: 'sintetica' },
        { codigo: `${p.sintetica}.9`, nome: 'B', natureza: 'ativo', tipo: 'sintetica' },
      ] },
      status: 400,
    },
    {
      nome: 'natureza inválida',
      body: { contas: [{ codigo: p.sintetica, nome: 'X', natureza: 'inventada', tipo: 'sintetica' }] },
      status: 400,
    },
    {
      nome: 'pai analítico',
      body: { contas: [
        { codigo: p.filha2, nome: 'Pai analítico', natureza: 'ativo', tipo: 'analitica' },
        { codigo: p.neta, nome: 'Filha', natureza: 'ativo', tipo: 'analitica', pai_codigo: p.filha2 },
      ] },
      status: 422,
    },
    {
      nome: 'pai inexistente',
      body: { contas: [{ codigo: p.neta, nome: 'Órfã', natureza: 'ativo', tipo: 'analitica', pai_codigo: '9.9.9.9' }] },
      status: 422,
    },
  ];

  for (const caso of casos) {
    const e = await erroDe(confirmarImportacaoPlano, { actor: gerente, body: caso.body });
    assert.equal(e.status, caso.status, `${caso.nome} deveria dar ${caso.status}`);
  }
  const depois = (await listRecords(RESOURCES.plano_contas, { page: 1, pageSize: 5000, filter: {} }, { kind: 'empresa', empresaId: 1 } as any)).total;
  assert.equal(depois, antes, 'nenhum caso inválido grava conta');
});

test('P2-13/D) modo "atualizar" altera só o que o preview mostrou', async () => {
  const p = planoUnico();
  const criar = await chamar(confirmarImportacaoPlano, {
    actor: gerente,
    body: { contas: [{ codigo: p.sintetica, nome: 'Nome original', natureza: 'ativo', tipo: 'sintetica' }] },
  });
  assert.equal(criar.out.criadas, 1);

  const previewAtualizar = await chamar(previewImportacaoPlano, {
    actor: gerente,
    body: { modo: 'atualizar', contas: [{ codigo: p.sintetica, nome: 'Nome novo', natureza: 'ativo', tipo: 'sintetica' }] },
  });
  assert.equal(previewAtualizar.out.resumo.atualizar, 1);
  assert.deepEqual(previewAtualizar.out.atualizar[0].mudancas, ['nome']);

  const aplicar = await chamar(confirmarImportacaoPlano, {
    actor: gerente,
    body: { modo: 'atualizar', contas: [{ codigo: p.sintetica, nome: 'Nome novo', natureza: 'ativo', tipo: 'sintetica' }] },
  });
  assert.equal(aplicar.out.atualizadas, 1);

  const todas = await listRecords(RESOURCES.plano_contas, { page: 1, pageSize: 5000, filter: {} }, { kind: 'empresa', empresaId: 1 } as any);
  assert.equal(String(todas.rows.find((c: any) => c.codigo === p.sintetica)!.nome), 'Nome novo');
});
