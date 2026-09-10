// ============================================================
// Valorização do estoque em três bases (Dashboard e relatórios).
//
//   • custo de produção → produtos.custo (alimentado pela ficha técnica)
//   • atacado           → produtos.preco_atacado; sem atacado cadastrado vale o
//                         varejo — a mesma regra do catálogo e do portal
//                         (`preco_atacado || preco_venda`)
//   • varejo            → produtos.preco_venda
//
// Cada base é apresentada em três níveis: unidade (por produto), coleção e o
// total de todas as peças em estoque. A função é pura: cada store (Postgres ou
// memória) agrega o saldo por produto do jeito que lhe é natural e entrega as
// linhas aqui, garantindo o mesmo resultado nos dois modos.
// ============================================================
import { VALORIZACAO_MAX_PRODUTOS, type ValorizacaoEstoque } from './store';
import { round2, somaMoeda } from './utils';

/** Saldo agregado de um produto (todas as peças, em todos os locais). */
export type LinhaSaldoProduto = {
  id: number;
  produto: string;
  colecao: string | null;
  pecas: number;
  custo: unknown;
  preco_venda: unknown;
  preco_atacado: unknown;
};

const SEM_COLECAO = 'Sem coleção';

function n(v: unknown): number {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
}

export function valorizarEstoque(linhas: LinhaSaldoProduto[], maxProdutos = VALORIZACAO_MAX_PRODUTOS): ValorizacaoEstoque {
  const produtos: ValorizacaoEstoque['produtos'] = [];
  for (const l of linhas) {
    const pecas = Math.trunc(n(l.pecas));
    if (pecas <= 0) continue; // sem saldo não há o que valorizar
    const custoUnit = n(l.custo);
    const varejoUnit = n(l.preco_venda);
    const atacadoDefinido = n(l.preco_atacado) > 0;
    const atacadoUnit = atacadoDefinido ? n(l.preco_atacado) : varejoUnit;
    produtos.push({
      id: Number(l.id),
      produto: l.produto,
      colecao: l.colecao ?? null,
      pecas,
      custo_unit: custoUnit,
      atacado_unit: atacadoUnit,
      varejo_unit: varejoUnit,
      atacado_definido: atacadoDefinido,
      custo: round2(pecas * custoUnit),
      atacado: round2(pecas * atacadoUnit),
      varejo: round2(pecas * varejoUnit),
    });
  }

  const porColecao = new Map<string, ValorizacaoEstoque['colecoes'][number]>();
  for (const p of produtos) {
    const nome = p.colecao || SEM_COLECAO;
    const c = porColecao.get(nome) || { colecao: nome, pecas: 0, custo: 0, atacado: 0, varejo: 0 };
    c.pecas += p.pecas;
    c.custo = somaMoeda([c.custo, p.custo]);
    c.atacado = somaMoeda([c.atacado, p.atacado]);
    c.varejo = somaMoeda([c.varejo, p.varejo]);
    porColecao.set(nome, c);
  }
  // Coleções pelo maior custo imobilizado; "Sem coleção" sempre por último.
  const colecoes = [...porColecao.values()].sort((a, b) => {
    if (a.colecao === SEM_COLECAO) return 1;
    if (b.colecao === SEM_COLECAO) return -1;
    return b.custo - a.custo || b.pecas - a.pecas || a.colecao.localeCompare(b.colecao);
  });

  produtos.sort((a, b) => b.custo - a.custo || b.pecas - a.pecas || a.produto.localeCompare(b.produto));

  return {
    pecas: produtos.reduce((s, p) => s + p.pecas, 0),
    custo: somaMoeda(produtos.map((p) => p.custo)),
    atacado: somaMoeda(produtos.map((p) => p.atacado)),
    varejo: somaMoeda(produtos.map((p) => p.varejo)),
    produtosComSaldo: produtos.length,
    semPrecoAtacado: produtos.filter((p) => !p.atacado_definido).length,
    colecoes,
    produtos: produtos.slice(0, maxProdutos),
  };
}
