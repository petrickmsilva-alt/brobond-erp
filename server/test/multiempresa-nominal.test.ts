// ============================================================================
// MULTIEMPRESA — ISOLAMENTO A × B NOMINAL (cobertura do P1-02)
//
// O baseline ERP 3.0 (`npm run architecture:audit`) listou 22 recursos
// `empresa: true` SEM um teste que os citasse nominalmente. Este arquivo fecha
// esse gap para TODOS eles, um caso por recurso, provando isolamento de
// verdade — não a mera existência da coluna `empresa_id`:
//
//   Empresa A                            Empresa B
//   ─────────                            ─────────
//   cria o registro                      lê por id ......... 404
//   lê por id (200)                      lista com filtro .. registro ausente
//   aparece na listagem                  altera ............ 404 (nada muda em A)
//   altera o próprio registro            exclui ............ 404 (registro intacto)
//
// A semântica é a JÁ ADOTADA pelo ERP (`server/src/empresa.ts`): 404 e não 403,
// porque responder 403 confirmaria a existência do registro alheio. Nenhuma
// regra foi afrouxada para o teste passar.
//
// Camadas cobertas aqui: SERVICE (`getRecord`/`listRecords`/`updateRecord`/
// `deleteRecord`). A camada HTTP dos recursos que têm rota genérica é coberta em
// `server/test/pg/multiempresa-nominal-http.test.ts`, contra PostgreSQL real.
//
// Recursos `internal: true` (sem rota genérica) são semeados pelo STORE — é a
// mesma camada de persistência que os endpoints especializados usam — e o que
// se prova é o recorte por empresa nas quatro operações.
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
delete process.env.DATABASE_URL;

const { RESOURCES } = await import('../src/resources');
const { createRecord, deleteRecord, getRecord, listRecords, updateRecord, getStore } = await import('../src/services');
const { criarAtor, garantirAdmin, esperarErro } = await import('./_p1util');
type Row = Record<string, any>;

await garantirAdmin();

/** Tenta a operação e devolve o erro HTTP (ou null quando ela passou). */
async function capturarErro(fn: () => Promise<unknown>): Promise<any> {
  try {
    await fn();
    return null;
  } catch (e) {
    return e;
  }
}
const store = getStore();
const SUF = Date.now().toString(36).toUpperCase().slice(-6);

type Ctx = { empresaId: number; ator: any; suf: string };

// ---------------------------------------------------------------------------
// Fixtures de apoio (cada uma nasce na empresa do contexto)
// ---------------------------------------------------------------------------
async function fornecedor(ctx: Ctx, nome = `Forn ${ctx.empresaId} ${SUF}`): Promise<Row> {
  return createRecord(
    RESOURCES.fornecedores,
    { nome, pessoa: 'pj', indicador_ie: '1' },
    ctx.ator
  );
}

async function produto(ctx: Ctx, sku = `SKU-${ctx.empresaId}-${SUF}-${Math.random().toString(36).slice(2, 6)}`): Promise<Row> {
  return createRecord(RESOURCES.produtos, { sku, nome: `Produto ${sku}`, preco_venda: 100, custo: 40 }, ctx.ator);
}

async function cliente(ctx: Ctx, nome = `Cliente ${ctx.empresaId} ${SUF}`): Promise<Row> {
  return createRecord(RESOURCES.clientes, { nome, pessoa: 'pj' }, ctx.ator);
}

async function representante(ctx: Ctx, nome = `Rep ${ctx.empresaId} ${SUF}`): Promise<Row> {
  return createRecord(RESOURCES.representantes, { nome }, ctx.ator);
}

async function venda(ctx: Ctx): Promise<Row> {
  const c = await cliente(ctx, `Cliente venda ${ctx.empresaId} ${SUF}`);
  return createRecord(
    RESOURCES.vendas,
    { cliente_id: Number(c.id), data: '2026-10-20', status: 'aberta', total: 100 },
    ctx.ator
  );
}

async function conta(ctx: Ctx, nome = `Conta ${ctx.empresaId} ${SUF}`): Promise<Row> {
  return createRecord(RESOURCES.contas_financeiras, { nome, tipo: 'banco', saldo_inicial: 0 }, ctx.ator);
}

/** Semeia direto no store (recursos internal/append-only não têm CRUD público). */
async function semear(key: string, ctx: Ctx, dados: Row = {}): Promise<Row> {
  const r = RESOURCES[key];
  return store.insert(r, { empresa_id: ctx.empresaId, ...dados });
}

// ---------------------------------------------------------------------------
// Os 22 recursos apontados pelo audit + como obter um registro da empresa
// ---------------------------------------------------------------------------
type Caso = {
  key: string;
  /** Descrição do caminho usado para obter o registro (criação real ou semeada). */
  via: 'crud' | 'store';
  criar: (ctx: Ctx) => Promise<Row>;
  /** Campos aceitos no PUT da empresa dona. */
  patch: Row;
  /** Recurso permite DELETE pela API? (ops.delete) */
  excluivel: boolean;
  /** Registro alternativo para o DELETE quando o principal não é apagável. */
  criarParaExcluir?: (ctx: Ctx) => Promise<Row>;
};

const CASOS: Caso[] = [
  {
    key: 'fornecedor_contatos',
    via: 'crud',
    criar: async (ctx) => {
      const f = await fornecedor(ctx, `Forn contato ${ctx.empresaId} ${SUF}`);
      return createRecord(RESOURCES.fornecedor_contatos, { fornecedor_id: Number(f.id), nome: `Contato ${ctx.empresaId} ${SUF}`, email: `c${ctx.empresaId}${SUF}@x.test` }, ctx.ator);
    },
    patch: { cargo: 'Compras' },
    excluivel: true,
  },
  {
    key: 'produto_composicao',
    via: 'crud',
    criar: async (ctx) => {
      const p = await produto(ctx);
      const comp = await produto(ctx);
      return createRecord(RESOURCES.produto_composicao, { produto_id: Number(p.id), componente_id: Number(comp.id), quantidade: 2 }, ctx.ator);
    },
    patch: { quantidade: 3 },
    excluivel: true,
  },
  {
    key: 'regras_fiscais',
    via: 'crud',
    criar: (ctx) => createRecord(RESOURCES.regras_fiscais, { nome: `Regra ${ctx.empresaId} ${SUF}`, operacao: 'saida' }, ctx.ator),
    patch: { observacoes: 'ajustada pela empresa dona' },
    excluivel: true,
  },
  {
    key: 'documentos_fiscais_eventos',
    via: 'store',
    criar: async (ctx) => {
      const doc = await semear('documentos_fiscais', ctx, { status: `autorizado-${ctx.empresaId}-${SUF}` });
      return semear('documentos_fiscais_eventos', ctx, { documento_id: Number(doc.id), para_status: 'autorizado', evento: `emitido-${SUF}` });
    },
    patch: { mensagem: 'nao-deve-mudar' },
    excluivel: false,
  },
  {
    key: 'inutilizacoes_fiscais',
    via: 'store',
    criar: (ctx) => semear('inutilizacoes_fiscais', ctx, { serie: ctx.empresaId, numero_inicial: 1, numero_final: 2, justificativa: `teste ${SUF}` }),
    patch: { justificativa: 'nao-deve-mudar' },
    excluivel: false,
  },
  {
    key: 'importacoes_nfe',
    via: 'store',
    criar: (ctx) => semear('importacoes_nfe', ctx, { numero: String(ctx.empresaId), serie: '1', chave_acesso: `CHV${ctx.empresaId}${SUF}` }),
    patch: { numero: 'nao-deve-mudar' },
    excluivel: false,
  },
  {
    key: 'categorias_financeiras',
    via: 'crud',
    criar: (ctx) => createRecord(RESOURCES.categorias_financeiras, { nome: `Cat ${ctx.empresaId} ${SUF}`, tipo: 'despesa' }, ctx.ator),
    patch: { cor: '#123456' },
    excluivel: true,
  },
  {
    key: 'investidores',
    via: 'crud',
    criar: (ctx) => createRecord(RESOURCES.investidores, { nome: `Investidor ${ctx.empresaId} ${SUF}` }, ctx.ator),
    patch: { email: 'investidor@brobond.test' },
    excluivel: true,
  },
  {
    key: 'aportes',
    via: 'crud',
    criar: async (ctx) => {
      const inv = await createRecord(RESOURCES.investidores, { nome: `Inv aporte ${ctx.empresaId} ${SUF}` }, ctx.ator);
      return createRecord(
        RESOURCES.aportes,
        { investidor_id: Number(inv.id), data: '2026-10-01', tipo: 'aporte', valor: 5000, status: 'previsto' },
        ctx.ator
      );
    },
    patch: { observacoes: 'ajustado pela empresa dona' },
    excluivel: true,
  },
  {
    key: 'recorrencias_financeiras',
    via: 'crud',
    criar: (ctx) =>
      createRecord(
        RESOURCES.recorrencias_financeiras,
        { descricao: `Recorrência ${ctx.empresaId} ${SUF}`, tipo: 'despesa', valor: 200, frequencia: 'mensal', status: 'ativo' },
        ctx.ator
      ),
    patch: { descricao: `Recorrência editada ${SUF}` },
    excluivel: true,
  },
  {
    key: 'centros_custo',
    via: 'crud',
    criar: (ctx) => createRecord(RESOURCES.centros_custo, { codigo: `CC${ctx.empresaId}${SUF}`, nome: `Centro ${ctx.empresaId} ${SUF}` }, ctx.ator),
    patch: { descricao: 'ajustado pela empresa dona' },
    excluivel: true,
  },
  {
    key: 'transferencias_financeiras',
    via: 'crud',
    // Transferência CONFIRMADA movimenta as duas contas e não pode ser apagada
    // (o ERP exige cancelamento, que estorna o par preservando o histórico).
    // Por isso o caso de leitura/edição usa `confirmado` e o de exclusão usa uma
    // segunda transferência `cancelado` — sem afrouxar nenhuma regra.
    criar: async (ctx) => {
      const [origem, destino] = await Promise.all([conta(ctx, `Origem ${ctx.empresaId} ${SUF}`), conta(ctx, `Destino ${ctx.empresaId} ${SUF}`)]);
      return createRecord(
        RESOURCES.transferencias_financeiras,
        { data: '2026-10-10', conta_origem_id: Number(origem.id), conta_destino_id: Number(destino.id), valor: 150, status: 'confirmado' },
        ctx.ator
      );
    },
    criarParaExcluir: async (ctx) => {
      const [origem, destino] = await Promise.all([conta(ctx, `Origem2 ${ctx.empresaId} ${SUF}`), conta(ctx, `Destino2 ${ctx.empresaId} ${SUF}`)]);
      return createRecord(
        RESOURCES.transferencias_financeiras,
        { data: '2026-10-11', conta_origem_id: Number(origem.id), conta_destino_id: Number(destino.id), valor: 90, status: 'cancelado' },
        ctx.ator
      );
    },
    patch: { descricao: 'ajustada pela empresa dona' },
    excluivel: true,
  },
  {
    key: 'listas_preco_historico',
    via: 'store',
    criar: async (ctx) => {
      const lp = await createRecord(RESOURCES.listas_preco, { nome: `Lista ${ctx.empresaId} ${SUF}` }, ctx.ator);
      return semear('listas_preco_historico', ctx, { lista_id: Number(lp.id), preco_anterior: 0, preco_novo: 10 });
    },
    patch: { preco_novo: 99 },
    excluivel: false,
  },
  {
    key: 'proposta_itens',
    via: 'store',
    criar: async (ctx) => {
      const p = await produto(ctx);
      return semear('proposta_itens', ctx, { produto_id: Number(p.id), quantidade: 1, preco_unitario: 100, subtotal: 100 });
    },
    patch: { quantidade: 9 },
    excluivel: false,
  },
  {
    key: 'proposta_eventos',
    via: 'store',
    criar: (ctx) => semear('proposta_eventos', ctx, { de_status: 'rascunho', para_status: 'enviada', mensagem: `evento ${SUF}` }),
    patch: { mensagem: 'nao-deve-mudar' },
    excluivel: false,
  },
  {
    key: 'compra_recebimento_itens',
    via: 'store',
    criar: async (ctx) => {
      const p = await produto(ctx);
      return semear('compra_recebimento_itens', ctx, { produto_id: Number(p.id), quantidade: 1, preco_unitario: 50 });
    },
    patch: { quantidade: 9 },
    excluivel: false,
  },
  {
    key: 'print_pairing_codes',
    via: 'store',
    criar: (ctx) => semear('print_pairing_codes', ctx, { code_hash: `PAIR-${ctx.empresaId}-${SUF}`, expires_at: new Date(Date.now() + 300_000).toISOString() }),
    patch: { nome_sugerido: 'nao-deve-mudar' },
    excluivel: false,
  },
  {
    key: 'print_agent_nonces',
    via: 'store',
    criar: async (ctx) => {
      // FK real: o nonce pertence a um agente de impressão da MESMA empresa.
      const agente = await semear('print_agents', ctx, { machine_id: `MAQ-${ctx.empresaId}-${SUF}`, nome: `Agente ${ctx.empresaId} ${SUF}`, token_hash: `TH-${ctx.empresaId}-${SUF}` });
      return semear('print_agent_nonces', ctx, { agent_id: Number(agente.id), nonce: `NONCE-${ctx.empresaId}-${SUF}` });
    },
    patch: { nonce: 'nao-deve-mudar' },
    excluivel: false,
  },
  {
    key: 'print_terminals',
    via: 'store',
    criar: (ctx) => semear('print_terminals', ctx, { codigo: `T${ctx.empresaId}${SUF}`, nome: `Terminal ${ctx.empresaId} ${SUF}` }),
    patch: { nome: 'nao-deve-mudar' },
    excluivel: false,
  },
  {
    key: 'planos_comissao',
    via: 'crud',
    criar: (ctx) => createRecord(RESOURCES.planos_comissao, { nome: `Plano ${ctx.empresaId} ${SUF}`, vigencia_inicio: '2026-01-01', padrao: false }, ctx.ator),
    patch: { descricao: 'ajustado pela empresa dona' },
    excluivel: true,
  },
  {
    key: 'regras_comissao',
    via: 'crud',
    criar: async (ctx) => {
      const plano = await createRecord(RESOURCES.planos_comissao, { nome: `Plano regra ${ctx.empresaId} ${SUF}`, vigencia_inicio: '2026-01-01', padrao: false }, ctx.ator);
      return createRecord(
        RESOURCES.regras_comissao,
        { plano_id: Number(plano.id), escopo: 'geral', tipo_valor: 'percentual', valor: 5, base: 'bruto' },
        ctx.ator
      );
    },
    patch: { valor: 7 },
    excluivel: true,
  },
  {
    key: 'venda_atribuicao',
    via: 'crud',
    criar: async (ctx) => {
      const v = await venda(ctx);
      const rep = await representante(ctx, `Rep atrib ${ctx.empresaId} ${SUF}`);
      return createRecord(RESOURCES.venda_atribuicao, { venda_id: Number(v.id), representante_id: Number(rep.id) }, ctx.ator);
    },
    patch: { papel: 'secundario' },
    excluivel: true,
  },
];

// ---------------------------------------------------------------------------
// O caso A × B, executado uma vez por recurso
// ---------------------------------------------------------------------------
const atorA = await criarAtor(1, 'gerente');
const atorB = await criarAtor(2, 'gerente');
const ctxA: Ctx = { empresaId: 1, ator: atorA, suf: SUF };
const ctxB: Ctx = { empresaId: 2, ator: atorB, suf: SUF };

assert.equal(casosDeclarados(), 22, 'o P1-02 cobre exatamente os 22 recursos apontados pelo audit');
function casosDeclarados() {
  return CASOS.length;
}

for (const caso of CASOS) {
  test(`isolamento A × B nominal: ${caso.key}`, async (t) => {
    const r = RESOURCES[caso.key];
    assert.ok(r, `recurso ${caso.key} existe`);
    assert.equal(r.empresa, true, `${caso.key} é multiempresa por contrato`);

    // ---- Empresa A cria e enxerga o próprio registro ---------------------
    const criado = await caso.criar(ctxA);
    const id = Number(criado.id);
    assert.ok(id > 0, `${caso.key}: registro criado na empresa A`);
    assert.equal(Number(criado.empresa_id), 1, `${caso.key}: carimbado com a empresa A`);

    const lidoA = await getRecord(r, id, atorA);
    assert.equal(Number(lidoA.id), id, `${caso.key}: A lê o próprio registro`);
    const antes: Row = { ...lidoA };

    const listaA = await listRecords(r, { page: 1, pageSize: 500, filter: { id } }, atorA);
    assert.ok(listaA.rows.some((row: Row) => Number(row.id) === id), `${caso.key}: aparece na listagem de A`);

    // ---- Empresa B não lê ------------------------------------------------
    await t.test('B não lê o registro de A (404, sem vazar existência)', async () => {
      await esperarErro(() => getRecord(r, id, atorB), 404);
    });

    await t.test('B não vê o registro de A na listagem', async () => {
      const listaB = await listRecords(r, { page: 1, pageSize: 500, filter: { id } }, atorB);
      assert.equal(listaB.rows.length, 0, `${caso.key}: listagem de B não traz o registro de A`);
      assert.equal(Number(listaB.total), 0);
    });

    await t.test('B não altera o registro de A (404 e dados intactos)', async () => {
      await esperarErro(() => updateRecord(r, id, caso.patch, atorB), 404);
      assert.deepEqual({ ...(await getRecord(r, id, atorA)) }, antes, `${caso.key}: nada mudou depois da tentativa de B`);
    });

    await t.test('B não exclui o registro de A (404 e registro intacto)', async () => {
      await esperarErro(() => deleteRecord(r, id, atorB), 404);
      assert.deepEqual({ ...(await getRecord(r, id, atorA)) }, antes, `${caso.key}: o registro continua intacto para A`);
    });

    // ---- A continua operando o próprio registro --------------------------
    // A prova acima já é nominal: B recebe 404 (registro "inexistente" para ele)
    // enquanto A enxerga o mesmo id. Os passos abaixo confirmam que o bloqueio
    // veio do RECORTE DE EMPRESA e não de o registro ser imutável para todos.
    await t.test(r.ops.update ? 'A altera o próprio registro' : 'recurso interno: A não recebe 404 e o registro segue da empresa A', async () => {
      if (r.ops.update) {
        const atualizado = await updateRecord(r, id, caso.patch, atorA);
        for (const [campo, valor] of Object.entries(caso.patch)) {
          assert.equal(String(atualizado[campo] ?? ''), String(valor), `${caso.key}.${campo} foi gravado para A`);
        }
        return;
      }
      // Recursos `internal` não têm rota pública (`getPublicResource` → 404) e
      // todos os seus campos são somente-leitura: o que se prova aqui é que o
      // 404 visto por B vem do RECORTE DE EMPRESA, não de o registro ser
      // inacessível para todo mundo — o dono passa pelo gate (nunca 404).
      const erro = await capturarErro(() => updateRecord(r, id, { ...caso.patch, empresa_id: 2 }, atorA));
      assert.notEqual(Number(erro?.status ?? erro?.statusCode ?? 0), 404, `${caso.key}: o dono nunca recebe 404`);
      const depois = await getRecord(r, id, atorA);
      assert.equal(Number(depois.empresa_id), 1, `${caso.key}: empresa A não migra o registro para outra empresa`);
    });

    await t.test(caso.excluivel ? 'A exclui o próprio registro' : 'recurso interno: B não apaga e o registro segue íntegro para A', async () => {
      if (!caso.excluivel) {
        assert.equal(r.ops.delete, false, `${caso.key} não oferece delete no contrato`);
        const erro = await capturarErro(() => deleteRecord(r, id, atorB));
        assert.equal(Number(erro?.status ?? erro?.statusCode ?? 0), 404, `${caso.key}: B nunca apaga registro de A`);
        const depois = await getRecord(r, id, atorA);
        assert.equal(Number(depois.id), id, `${caso.key}: registro preservado para A`);
        assert.equal(Number(depois.empresa_id), 1, `${caso.key}: continua na empresa A`);
        return;
      }
      const alvo = caso.criarParaExcluir ? await caso.criarParaExcluir(ctxA) : criado;
      const alvoId = Number(alvo.id);
      await deleteRecord(r, alvoId, atorA);
      await esperarErro(() => getRecord(r, alvoId, atorA), 404);
    });
  });
}

// ---------------------------------------------------------------------------
// Guarda-corpo: nenhum dos 22 recursos perdeu o escopo declarado
// ---------------------------------------------------------------------------
test('os 22 recursos do P1-02 continuam declarando empresa: true', () => {
  const faltando = CASOS.filter((c) => RESOURCES[c.key]?.empresa !== true).map((c) => c.key);
  assert.deepEqual(faltando, [], `recursos sem escopo de empresa: ${faltando.join(', ')}`);
});
