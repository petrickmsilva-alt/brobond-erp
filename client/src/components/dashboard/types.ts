// Contratos de resposta usados pelo Dashboard. Espelham o servidor:
//   GET /api/empresas/ativa, /api/negocios/resumo, /api/negocios/abc,
//   /api/negocios/canais, /api/dashboard, /api/financeiro/resumo.
// Valores monetários do motor vêm em CENTAVOS (sufixo Cents).

export type EmpresaAtivaResp = {
  empresa_id: number | null;
  empresa: string | null;
  consolidado: boolean;
  pode_consolidar: boolean;
  empresas: { id: number; nome: string; cnpj: string | null; ativa: boolean }[];
};

export type CanaisResp = {
  grupos: { grupo: string; label: string; canais: { canal: string; label: string }[] }[];
};

export type ResumoBI = {
  filtros: { de: string | null; ate: string | null; empresa_id: number | null; canal: string | null; grupo: string | null; status: string | null };
  kpis: {
    faturamentoCents: number;
    pedidos: number;
    ticketMedioCents: number;
    cmvCents: number;
    impostosCents: number;
    freteCents: number;
    lucroBrutoCents: number;
    margemPct: number;
    pedidosPendentes: number;
    semMargemCalculada: number;
  };
  porCanal: { grupo: string; label: string; canais: string[]; faturamentoCents: number; lucroBrutoCents: number; margemPct: number; pedidos: number }[];
  porMes: { mes: string; faturamentoCents: number; lucroBrutoCents: number }[];
  topProdutos: { productId: number; sku: string | null; produto: string | null; faturamentoCents: number; quantidade: number }[];
  abc: { resumo: { classe: 'A' | 'B' | 'C'; itens: number; faturamentoCents: number }[]; totalFaturamentoCents: number };
};

export type AbcResp = {
  resumo: { classe: 'A' | 'B' | 'C'; itens: number; faturamentoCents: number }[];
  totalFaturamentoCents: number;
  linhas: {
    empresaId: number;
    produtoId: number;
    sku: string | null;
    produto: string | null;
    classe: 'A' | 'B' | 'C';
    faturamentoCents: number;
    pctTotal: number;
    pctAcumulado: number;
  }[];
};

export type Valorizacao = {
  pecas: number;
  custo: number;
  atacado: number;
  varejo: number;
  produtosComSaldo: number;
  semPrecoAtacado: number;
  colecoes: { colecao: string; pecas: number; custo: number; atacado: number; varejo: number }[];
  produtos: {
    id: number;
    produto: string;
    colecao: string | null;
    pecas: number;
    custo_unit: number;
    atacado_unit: number;
    varejo_unit: number;
    atacado_definido: boolean;
    custo: number;
    atacado: number;
    varejo: number;
  }[];
};

/** GET /api/dashboard — indicadores operacionais (não filtrados por período). */
export type DashboardData = {
  valorEstoque: number;
  pecasEstoque: number;
  valorizacao: Valorizacao;
  itensAlerta: number;
  producao: number;
  vendasAbertas: number;
  comprasPendentes: number;
  vendasMes: number;
  comissoesPagar: number;
  vendasPorMes: { mes: string; total: number }[];
  alertas: { produto: string; tamanho: string; local: string; quantidade: number; estoque_min: number }[];
  insumosAlerta: { insumo: string; quantidade: number; estoque_min: number }[];
  ordens: { id: number; produto: string; tamanho: string; quantidade: number; status: string; previsao: string | null }[];
  totais: { produtos: number; clientes: number; fornecedores: number; insumos: number };
};

/** GET /api/financeiro/resumo — gerente/admin (só os campos usados pelo painel). */
export type ResumoFin = {
  saldoContasTotal: number;
  aReceberVencidas: number;
  aPagarVencidas: number;
  aPagar30: number;
  aReceber30: number;
  /** Contas em aberto com vencimento — base do alerta "vencem hoje". */
  aReceberLista: { vencimento: string | null; valor: number }[];
  aPagarLista: { vencimento: string | null; valor: number }[];
};
