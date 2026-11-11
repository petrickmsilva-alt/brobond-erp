// ============================================================================
// SANEAMENTO DE DADOS DE HOMOLOGAÇÃO — preparação para o go-live (Fase 2).
//
// O Diretor autorizou a limpeza dos dados fictícios. O ÚNICO dado operacional
// real a preservar é o ESTOQUE FÍSICO (tabela `estoques`).
//
// Princípios (ordem executiva §2, §5, §11):
//   • NUNCA apagar cadastros: produtos, SKUs, variantes, grades, cores,
//     tamanhos, coleções, empresas, usuários, permissões, configurações,
//     plano de contas, categorias, centros de custo, contas financeiras;
//   • NUNCA apagar o estoque físico (`estoques`) nem mexer em preços;
//   • NUNCA desabilitar constraints/triggers/auditoria;
//   • uma ÚNICA transação: ou limpa tudo, ou não limpa nada (nada parcial);
//   • preservar a POSIÇÃO FÍSICA: `estoques` é conferido byte a byte antes e
//     depois; qualquer divergência aborta;
//   • trilha de auditoria da intervenção (quem, quando, o quê, quantos).
//
// Este módulo NÃO conhece o banco publicado: ele recebe a lista de empresas e
// opera por ali. A execução no banco publicado é um ato separado e registrado
// (ver docs/OPERACAO-SANEAMENTO-GO-LIVE.md).
// ============================================================================
import type { Pool, PoolClient } from 'pg';
import { verificarCobertura } from './saneamento-cobertura';

/** Confirmação textual exigida para executar de verdade (evita acidente). */
export const CONFIRMACAO_EXECUCAO = 'LIMPAR-HOMOLOGACAO';

/** Recorte de empresa; vazio = todas as empresas do banco. */
export interface Escopo {
  empresaIds: number[];
}

export interface OpcoesSaneamento extends Escopo {
  /** 'dry-run' executa o plano em transação e faz ROLLBACK (não altera nada). */
  modo: 'dry-run' | 'executar';
  /** Obrigatória no modo 'executar'; precisa ser CONFIRMACAO_EXECUCAO. */
  confirmacao?: string;
  /** Identificação do operador/execução, gravada na auditoria. */
  ator: string;
}

export interface PassoPlano {
  id: string;
  tabela: string;
  descricao: string;
  /** Fragmento SQL após `DELETE FROM <tabela>` (usa `$1` = int[] de empresas). */
  where: string;
}

export interface ContagemPasso {
  id: string;
  tabela: string;
  descricao: string;
  removidos: number;
}

export interface LinhaEstoque {
  empresa_id: number | null;
  produto_id: number | null;
  sku: string | null;
  tamanho_id: number | null;
  tamanho: string | null;
  local: string | null;
  local_id: number | null;
  quantidade_fisica: number;
  reservado: number;
  disponivel: number;
  custo_unitario: number | null;
  valor_total: number | null;
}

// ---------------------------------------------------------------------------
// PLANO — ordem de exclusão respeitando as dependências (filhos antes dos pais).
//
// Cada passo é explícito. Nenhum passo toca cadastro, configuração, estrutura
// financeira ou a tabela `estoques`.
// ---------------------------------------------------------------------------
const POR_EMPRESA = 'empresa_id = ANY($1::int[])';
const VENDA_DAS_EMPRESAS = 'venda_id IN (SELECT id FROM vendas WHERE empresa_id = ANY($1::int[]))';
const CATALOGO_POR_VENDA = 'pedido_id IN (SELECT id FROM vendas WHERE empresa_id = ANY($1::int[]))';

export const PLANO: PassoPlano[] = [
  // Ordem topológica derivada do grafo de FKs (filhos antes dos pais).
  // Commerce: satélites do pedido.
  { id: 'commerce_notificacoes', tabela: 'commerce_notificacoes', descricao: 'Notificações de pedidos de teste', where: POR_EMPRESA },
  // Disputas de pagamento: evidências e eventos ANTES do cabeçalho.
  { id: 'payment_dispute_evidence', tabela: 'payment_dispute_evidence', descricao: 'Evidências de disputa de pagamento de teste', where: POR_EMPRESA },
  { id: 'payment_dispute_events', tabela: 'payment_dispute_events', descricao: 'Eventos de disputa de pagamento de teste', where: POR_EMPRESA },
  // Pagamentos / gateway.
  { id: 'payment_late_reviews', tabela: 'payment_late_reviews', descricao: 'Revisões tardias de pagamento de teste', where: POR_EMPRESA },
  { id: 'payment_attempts', tabela: 'payment_attempts', descricao: 'Tentativas de pagamento de teste', where: POR_EMPRESA },
  { id: 'payment_refunds', tabela: 'payment_refunds', descricao: 'Estornos de pagamento de teste', where: POR_EMPRESA },
  { id: 'payment_settlements', tabela: 'payment_settlements', descricao: 'Liquidações de pagamento de teste', where: POR_EMPRESA },
  { id: 'payment_disputes', tabela: 'payment_disputes', descricao: 'Disputas de pagamento de teste', where: POR_EMPRESA },
  { id: 'gateway_webhook_events', tabela: 'gateway_webhook_events', descricao: 'Webhooks de gateway de teste', where: POR_EMPRESA },
  // Comissões / afiliados.
  { id: 'affiliate_commissions', tabela: 'affiliate_commissions', descricao: 'Comissões de afiliados de teste', where: POR_EMPRESA },
  { id: 'comissoes_eventos', tabela: 'comissoes_eventos', descricao: 'Eventos de comissão de teste', where: POR_EMPRESA },
  // Satélites das vendas operacionais (`vendas`).
  { id: 'catalogo_eventos', tabela: 'catalogo_eventos', descricao: 'Eventos de catálogo ligados a pedido de teste', where: CATALOGO_POR_VENDA },
  { id: 'cotacao_decisoes', tabela: 'cotacao_decisoes', descricao: 'Decisões de cotação de venda de teste', where: VENDA_DAS_EMPRESAS },
  { id: 'divergencias_conferencia', tabela: 'divergencias_conferencia', descricao: 'Divergências de conferência de venda de teste', where: POR_EMPRESA },
  { id: 'expedicao_eventos', tabela: 'expedicao_eventos', descricao: 'Eventos de expedição de venda de teste', where: POR_EMPRESA },
  { id: 'envios', tabela: 'envios', descricao: 'Envios de venda de teste', where: POR_EMPRESA },
  { id: 'logistics_quotes', tabela: 'logistics_quotes', descricao: 'Cotações de logística de venda de teste', where: POR_EMPRESA },
  { id: 'commerce_rastreio', tabela: 'commerce_rastreio', descricao: 'Rastreio de pedido de teste', where: POR_EMPRESA },
  { id: 'loyalty_movements', tabela: 'loyalty_movements', descricao: 'Movimentos de fidelidade de teste', where: POR_EMPRESA },
  { id: 'pdv_pagamentos', tabela: 'pdv_pagamentos', descricao: 'Pagamentos de PDV de teste', where: POR_EMPRESA },
  { id: 'propostas', tabela: 'propostas', descricao: 'Propostas comerciais de teste', where: POR_EMPRESA },
  { id: 'vendas_status_historico', tabela: 'vendas_status_historico', descricao: 'Histórico de status de venda de teste', where: POR_EMPRESA },
  { id: 'documentos_fiscais', tabela: 'documentos_fiscais', descricao: 'Documentos fiscais de venda de teste (nunca transmitidos)', where: POR_EMPRESA },
  { id: 'devolucao_itens', tabela: 'devolucao_itens', descricao: 'Itens de devolução de teste', where: POR_EMPRESA },
  { id: 'service_tickets', tabela: 'service_tickets', descricao: 'Atendimentos de teste', where: POR_EMPRESA },
  // Inventário: itens (apontam para movimentações) antes das movimentações.
  { id: 'itens_inventario', tabela: 'itens_inventario', descricao: 'Itens de inventário de homologação', where: POR_EMPRESA },
  // Transferências de estoque artificiais (itens/eventos antes do cabeçalho).
  { id: 'estoque_transferencia_eventos', tabela: 'estoque_transferencia_eventos', descricao: 'Eventos de transferência de estoque de teste', where: POR_EMPRESA },
  { id: 'estoque_transferencia_itens', tabela: 'estoque_transferencia_itens', descricao: 'Itens de transferência de estoque de teste', where: POR_EMPRESA },
  // Vendas multicanal e operacionais.
  { id: 'sale_items', tabela: 'sale_items', descricao: 'Itens das vendas multicanal de teste', where: 'sale_id IN (SELECT id FROM sales WHERE empresa_id = ANY($1::int[]))' },
  { id: 'sales', tabela: 'sales', descricao: 'Vendas multicanal de teste', where: POR_EMPRESA },
  { id: 'itens_venda', tabela: 'itens_venda', descricao: 'Itens das vendas operacionais de teste', where: POR_EMPRESA },
  // Reservas de estoque de teste (NÃO alteram a quantidade física).
  { id: 'estoque_reservas', tabela: 'estoque_reservas', descricao: 'Reservas de estoque de teste', where: POR_EMPRESA },
  // Caixa / PDV.
  { id: 'transferencias_financeiras', tabela: 'transferencias_financeiras', descricao: 'Transferências financeiras de teste', where: POR_EMPRESA },
  { id: 'pdv_caixa_movimentos', tabela: 'pdv_caixa_movimentos', descricao: 'Movimentos de caixa do PDV de teste', where: POR_EMPRESA },
  { id: 'pdv_caixas', tabela: 'pdv_caixas', descricao: 'Caixas do PDV de teste', where: POR_EMPRESA },
  // Fila e sincronização (homologação).
  { id: 'commerce_outbox', tabela: 'commerce_outbox', descricao: 'Eventos da fila (outbox) de homologação — não reenfileirar', where: POR_EMPRESA },
  { id: 'commerce_reconciliacao', tabela: 'commerce_reconciliacao', descricao: 'Reconciliações de homologação', where: POR_EMPRESA },
  { id: 'connector_events', tabela: 'connector_events', descricao: 'Eventos de conector de homologação', where: POR_EMPRESA },
  { id: 'logistics_webhook_inbox', tabela: 'logistics_webhook_inbox', descricao: 'Inbox de webhooks de logística de homologação', where: POR_EMPRESA },
  // Payment Engine (intents depois das operações/estornos).
  { id: 'payment_operations', tabela: 'payment_operations', descricao: 'Operações do Payment Engine de teste', where: POR_EMPRESA },
  // Satélites de repasse (FK NÃO anulável → precisam ser apagados antes do pai).
  { id: 'payment_payout_unlinks', tabela: 'payment_payout_unlinks', descricao: 'Desvínculos de repasse de teste', where: POR_EMPRESA },
  { id: 'payment_payout_revisions', tabela: 'payment_payout_revisions', descricao: 'Revisões de repasse de teste', where: POR_EMPRESA },
  { id: 'payment_payouts', tabela: 'payment_payouts', descricao: 'Repasses de teste', where: POR_EMPRESA },
  { id: 'creator_attributions', tabela: 'creator_attributions', descricao: 'Atribuições de criadores em pedidos de teste', where: POR_EMPRESA },
  { id: 'comissoes_apuradas', tabela: 'comissoes_apuradas', descricao: 'Comissões apuradas de teste', where: POR_EMPRESA },
  { id: 'devolucoes', tabela: 'devolucoes', descricao: 'Devoluções de teste', where: POR_EMPRESA },
  // Movimentações de estoque ORIGINADAS POR TESTE (venda, transferência ou
  // inventário). NUNCA toca entradas reais de compra/produção.
  {
    id: 'movimentacoes_teste',
    tabela: 'movimentacoes',
    descricao: 'Movimentações de estoque originadas por venda/transferência/inventário de teste',
    where: `venda_id IN (SELECT id FROM vendas WHERE empresa_id = ANY($1::int[]))
            OR transferencia_id IN (SELECT id FROM estoque_transferencias WHERE empresa_id = ANY($1::int[]))
            OR inventario_id IN (SELECT id FROM inventarios WHERE empresa_id = ANY($1::int[]))`,
  },
  { id: 'estoque_transferencias', tabela: 'estoque_transferencias', descricao: 'Transferências de estoque de teste', where: POR_EMPRESA },
  { id: 'fin_extrato_transacoes', tabela: 'fin_extrato_transacoes', descricao: 'Transações de extrato de teste', where: POR_EMPRESA },
  { id: 'venda_atribuicao', tabela: 'venda_atribuicao', descricao: 'Atribuição de venda de teste', where: POR_EMPRESA },
  { id: 'payment_intents', tabela: 'payment_intents', descricao: 'Payment intents de teste', where: POR_EMPRESA },
  { id: 'inventarios', tabela: 'inventarios', descricao: 'Inventários de homologação', where: POR_EMPRESA },
  { id: 'commerce_pedidos', tabela: 'commerce_pedidos', descricao: 'Pedidos de commerce de teste', where: POR_EMPRESA },
  { id: 'gateway_cobrancas', tabela: 'gateway_cobrancas', descricao: 'Cobranças de gateway de teste', where: POR_EMPRESA },
  { id: 'lancamentos_financeiros', tabela: 'lancamentos_financeiros', descricao: 'Lançamentos financeiros de teste (mantém plano de contas e contas)', where: POR_EMPRESA },
  { id: 'vendas', tabela: 'vendas', descricao: 'Vendas operacionais de teste', where: POR_EMPRESA },
];

/**
 * Desvincula as FKs NO ACTION que apontam para as linhas de teste ANTES de
 * apagá-las, evitando violação de integridade referencial. Só desvincula as
 * colunas que apontam para os ALVOS do saneamento (vendas/documentos/propostas
 * de teste); nunca toca em dado que não é de teste. Não desabilita constraint
 * nenhuma — apenas zera a referência, e a própria constraint continua válida.
 */
export const DESVINCULOS: { tabela: string; sets: string[]; where: string }[] = [
  { tabela: 'catalogo_eventos', sets: ['pedido_id = NULL'], where: CATALOGO_POR_VENDA },
  { tabela: 'commerce_pedidos', sets: ['venda_id = NULL', 'sale_id = NULL', 'cobranca_id = NULL'], where: POR_EMPRESA },
  { tabela: 'devolucao_itens', sets: ['item_venda_id = NULL'], where: POR_EMPRESA },
  { tabela: 'devolucoes', sets: ['documento_fiscal_id = NULL'], where: POR_EMPRESA },
  { tabela: 'logistics_quotes', sets: ['venda_id = NULL'], where: POR_EMPRESA },
  { tabela: 'propostas', sets: ['venda_id = NULL'], where: POR_EMPRESA },
  { tabela: 'sales', sets: ['operational_venda_id = NULL'], where: POR_EMPRESA },
  // Ordens de fabricação PRESERVADAS (produção real): solta só o vínculo com o
  // ITEM DE VENDA de teste (FK composta empresa_id+demanda_item_id, anulável).
  {
    tabela: 'ordens_fabricacao',
    sets: ['demanda_item_id = NULL'],
    where: 'demanda_item_id IN (SELECT id FROM itens_venda WHERE empresa_id = ANY($1::int[]))',
  },
  { tabela: 'vendas', sets: ['documento_fiscal_id = NULL', 'proposta_id = NULL', 'pdv_caixa_id = NULL', 'envio_id = NULL'], where: POR_EMPRESA },
];

/** Tabelas que o saneamento NUNCA pode tocar (guarda anti-regressão). */
export const TABELAS_PROTEGIDAS = [
  'estoques',
  'produtos',
  'tamanhos',
  'cores',
  'colecoes',
  'empresas',
  'usuarios',
  'plano_contas',
  'contas_financeiras',
  'centros_custo',
  'categorias',
];

// ---------------------------------------------------------------------------
// FOTOGRAFIA DE ESTOQUE — posição física por SKU/variante/local, com custo e
// valorização, para comparação exata antes/depois.
// ---------------------------------------------------------------------------
export async function fotografiaEstoque(pool: Pool | PoolClient, empresaIds: number[]): Promise<LinhaEstoque[]> {
  const recorte = empresaIds.length ? 'WHERE e.empresa_id = ANY($1::int[])' : '';
  const { rows } = await pool.query(
    `WITH reservas AS (
       SELECT empresa_id, produto_id, tamanho_id, local_id, SUM(quantidade) AS qtd
         FROM estoque_reservas
        WHERE status = 'ativa'
        GROUP BY empresa_id, produto_id, tamanho_id, local_id
     )
     SELECT e.empresa_id,
            e.produto_id,
            p.sku,
            e.tamanho_id,
            t.codigo AS tamanho,
            e.local,
            e.local_id,
            COALESCE(e.quantidade, 0)::int AS quantidade_fisica,
            COALESCE(r.qtd, 0)::int       AS reservado,
            GREATEST(0, COALESCE(e.quantidade, 0) - COALESCE(r.qtd, 0))::int AS disponivel,
            p.custo                       AS custo_unitario,
            (COALESCE(e.quantidade, 0) * COALESCE(p.custo, 0))::numeric AS valor_total
       FROM estoques e
       LEFT JOIN produtos p ON p.id = e.produto_id
       LEFT JOIN tamanhos t ON t.id = e.tamanho_id
       LEFT JOIN reservas r
              ON r.empresa_id = e.empresa_id
             AND r.produto_id = e.produto_id
             AND COALESCE(r.tamanho_id, -1) = COALESCE(e.tamanho_id, -1)
             AND COALESCE(r.local_id, -1) = COALESCE(e.local_id, -1)
       ${recorte}
      ORDER BY e.empresa_id, p.sku, e.tamanho_id, e.local_id, e.local`,
    empresaIds.length ? [empresaIds] : []
  );
  return rows.map((r: any) => ({
    empresa_id: r.empresa_id === null ? null : Number(r.empresa_id),
    produto_id: r.produto_id === null ? null : Number(r.produto_id),
    sku: r.sku ?? null,
    tamanho_id: r.tamanho_id === null ? null : Number(r.tamanho_id),
    tamanho: r.tamanho ?? null,
    local: r.local ?? null,
    local_id: r.local_id === null ? null : Number(r.local_id),
    quantidade_fisica: Number(r.quantidade_fisica),
    reservado: Number(r.reservado),
    disponivel: Number(r.disponivel),
    custo_unitario: r.custo_unitario === null ? null : Number(r.custo_unitario),
    valor_total: r.valor_total === null ? null : Number(r.valor_total),
  }));
}

/** Chave estável da posição física (sem reservado/disponível — só o físico). */
export function chaveFisica(l: LinhaEstoque): string {
  return [l.empresa_id ?? '', l.produto_id ?? '', l.tamanho_id ?? '', l.local_id ?? '', l.local ?? ''].join('|');
}

export interface DivergenciaEstoque {
  chave: string;
  sku: string | null;
  campo: 'quantidade_fisica' | 'custo_unitario' | 'valor_total' | 'ausente_antes' | 'ausente_depois';
  antes: number | null;
  depois: number | null;
  delta: number | null;
}

/**
 * Compara duas fotografias célula a célula (SKU × variante × local) em TRÊS
 * dimensões: quantidade física, custo unitário e valorização. Qualquer
 * divergência em qualquer dimensão é reportada — a comparação de só a
 * quantidade deixaria passar mudança de custo.
 */
export function compararEstoque(antes: LinhaEstoque[], depois: LinhaEstoque[]): DivergenciaEstoque[] {
  const mapA = new Map(antes.map((l) => [chaveFisica(l), l]));
  const mapD = new Map(depois.map((l) => [chaveFisica(l), l]));
  const chaves = new Set([...mapA.keys(), ...mapD.keys()]);
  const divergencias: DivergenciaEstoque[] = [];
  const cmp = (
    chave: string,
    sku: string | null,
    campo: DivergenciaEstoque['campo'],
    a: number | null | undefined,
    d: number | null | undefined
  ) => {
    const va = a ?? null;
    const vd = d ?? null;
    if (va !== vd) divergencias.push({ chave, sku, campo, antes: va, depois: vd, delta: va !== null && vd !== null ? vd - va : null });
  };
  for (const chave of chaves) {
    const a = mapA.get(chave);
    const d = mapD.get(chave);
    if (!a) {
      divergencias.push({ chave, sku: d?.sku ?? null, campo: 'ausente_antes', antes: null, depois: d?.quantidade_fisica ?? null, delta: null });
      continue;
    }
    if (!d) {
      divergencias.push({ chave, sku: a.sku, campo: 'ausente_depois', antes: a.quantidade_fisica, depois: null, delta: null });
      continue;
    }
    cmp(chave, a.sku, 'quantidade_fisica', a.quantidade_fisica, d.quantidade_fisica);
    cmp(chave, a.sku, 'custo_unitario', a.custo_unitario, d.custo_unitario);
    cmp(chave, a.sku, 'valor_total', a.valor_total, d.valor_total);
  }
  return divergencias;
}

/** Soma total de peças físicas da fotografia. */
export function totalFisico(foto: LinhaEstoque[]): number {
  return foto.reduce((soma, l) => soma + l.quantidade_fisica, 0);
}

// ---------------------------------------------------------------------------
// EXECUÇÃO
// ---------------------------------------------------------------------------

/** Chave do advisory lock que serializa execuções concorrentes do saneamento. */
export const LOCK_SANEAMENTO = 'brobond:saneamento-go-live';

export interface LinhaRelatorio {
  tabela: string;
  descricao: string;
  removidos: number;
}

export interface RelatorioSku {
  sku: string | null;
  quantidadeFisica: number;
  custoUnitario: number | null;
  valorTotal: number | null;
  celulas: number;
}

export interface ResultadoSaneamento {
  modo: 'dry-run' | 'executar';
  empresas: number[];
  passos: ContagemPasso[];
  totalRemovido: number;
  estoqueAntes: LinhaEstoque[];
  estoqueDepois: LinhaEstoque[];
  estoquePreservado: boolean;
  divergencias: string[];
  /** Relatório por tabela (todas as tabelas limpas). */
  relatorio: LinhaRelatorio[];
  /** Relatório por SKU (fotografia final célula a célula, agregada por SKU). */
  relatorioSku: RelatorioSku[];
  /** Cobertura do grafo de FKs no momento da execução. */
  cobertura: { totalFks: number; alvos: number; bloqueios: number };
  auditoriaId: number | null;
}

/** Agrega a fotografia por SKU (soma peças, valorização e reservas). */
export function relatorioPorSku(foto: LinhaEstoque[]): RelatorioSku[] {
  const map = new Map<string, RelatorioSku>();
  for (const l of foto) {
    const sku = l.sku ?? `(produto ${l.produto_id ?? '—'})`;
    const atual = map.get(sku) ?? {
      sku: l.sku,
      quantidadeFisica: 0,
      custoUnitario: l.custo_unitario,
      valorTotal: 0,
      celulas: 0,
    };
    atual.quantidadeFisica += l.quantidade_fisica;
    atual.valorTotal = (atual.valorTotal ?? 0) + (l.valor_total ?? 0);
    atual.celulas += 1;
    map.set(sku, atual);
  }
  return [...map.values()].sort((a, b) => (a.sku ?? '').localeCompare(b.sku ?? ''));
}

/**
 * Executa o plano de saneamento numa ÚNICA transação, no pool informado.
 *
 * - `modo: 'dry-run'` executa tudo e faz ROLLBACK: prova que o plano aplica
 *   limpo (sem bloqueio de FK) sem alterar um único byte.
 * - `modo: 'executar'` exige `confirmacao === CONFIRMACAO_EXECUCAO` e commita.
 *
 * Garantias:
 *   • DUAS EXECUÇÕES CONCORRENTES — um advisory lock transacional
 *     (`pg_advisory_xact_lock`) serializa as execuções; a segunda espera ou
 *     falha, nunca corre em paralelo.
 *   • FOTOGRAFIA DENTRO DA TRANSAÇÃO — a posição inicial e final são lidas na
 *     MESMA transação, com `FOR UPDATE` em `estoques`/`estoque_reservas`: nenhuma
 *     escrita concorrente pode alterar o estoque entre a leitura e a limpeza.
 *   • COBERTURA DE FK — o grafo de FKs é conferido antes de apagar; FK
 *     bloqueante não tratada aborta antes de qualquer DELETE.
 *   • ROLLBACK TOTAL — qualquer erro (inclusive divergência de estoque) desfaz
 *     TUDO; nunca há execução parcial.
 */
export async function executarSaneamento(pool: Pool, opcoes: OpcoesSaneamento): Promise<ResultadoSaneamento> {
  if (opcoes.modo === 'executar' && opcoes.confirmacao !== CONFIRMACAO_EXECUCAO) {
    throw new Error(`Confirmação inválida. Use confirmacao="${CONFIRMACAO_EXECUCAO}" para executar.`);
  }
  const empresas = opcoes.empresaIds;
  if (!empresas.length) {
    throw new Error('Informe ao menos uma empresa (empresaIds). O saneamento nunca é global por omissão.');
  }

  const passos: ContagemPasso[] = [];
  let estoqueAntes: LinhaEstoque[] = [];
  let estoqueDepois: LinhaEstoque[] = [];
  let auditoriaId: number | null = null;
  let divergencias: DivergenciaEstoque[] = [];
  let coberturaInfo = { totalFks: 0, alvos: PLANO.length, bloqueios: 0 };

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // 0) Serializa execuções concorrentes (advisory lock transacional).
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [LOCK_SANEAMENTO]);

    // 1) Cobertura de FK: aborta ANTES de apagar se houver aresta bloqueante.
    const cobertura = await verificarCobertura(client, PLANO, DESVINCULOS);
    coberturaInfo = { totalFks: cobertura.totalFks, alvos: cobertura.alvos.length, bloqueios: cobertura.bloqueios.length };

    // 2) Fotografia inicial DENTRO da transação, com trava das linhas de estoque
    //    e reservas — impede alteração concorrente entre leitura e limpeza.
    await client.query(
      `SELECT 1 FROM estoques WHERE empresa_id = ANY($1::int[]) FOR UPDATE`,
      [empresas]
    );
    await client.query(
      `SELECT 1 FROM estoque_reservas WHERE empresa_id = ANY($1::int[]) FOR UPDATE`,
      [empresas]
    );
    estoqueAntes = await fotografiaEstoque(client, empresas);

    // 3) Desvincula referências NO ACTION (sem desabilitar constraint nenhuma).
    for (const d of DESVINCULOS) {
      await client.query(`UPDATE ${d.tabela} SET ${d.sets.join(', ')} WHERE ${d.where}`, [empresas]);
    }
    // 4) Apaga os dados de teste na ordem de dependência.
    for (const passo of PLANO) {
      const res = await client.query(`DELETE FROM ${passo.tabela} WHERE ${passo.where}`, [empresas]);
      passos.push({ id: passo.id, tabela: passo.tabela, descricao: passo.descricao, removidos: res.rowCount ?? 0 });
    }
    estoqueDepois = await fotografiaEstoque(client, empresas);
    divergencias = compararEstoque(estoqueAntes, estoqueDepois);
    if (divergencias.length > 0) {
      throw new Error(
        `SANEAMENTO ABORTADO: o estoque físico/custo/valorização divergiu em ${divergencias.length} célula(s): ` +
          divergencias.slice(0, 10).map((d) => `${d.sku ?? d.chave}.${d.campo} ${d.antes}→${d.depois}`).join('; ')
      );
    }
    if (opcoes.modo === 'executar') {
      const { rows } = await client.query(
        `INSERT INTO auditoria (usuario, acao, recurso, descricao, dados)
         VALUES ($1, $2, $3, $4, $5::jsonb) RETURNING id`,
        [
          opcoes.ator,
          'saneamento-homologacao',
          'saneamento',
          `Saneamento pré-go-live: ${passos.reduce((s, p) => s + p.removidos, 0)} linha(s) de teste removida(s); estoque físico preservado.`,
          JSON.stringify({ modo: opcoes.modo, empresas, passos, cobertura: coberturaInfo }),
        ]
      );
      auditoriaId = rows[0]?.id ?? null;
    }
    await client.query(opcoes.modo === 'executar' ? 'COMMIT' : 'ROLLBACK');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }

  const totalRemovido = passos.reduce((s, p) => s + p.removidos, 0);
  const relatorio = passos.map((p) => ({ tabela: p.tabela, descricao: p.descricao, removidos: p.removidos }));
  return {
    modo: opcoes.modo,
    empresas,
    passos,
    totalRemovido,
    estoqueAntes,
    estoqueDepois,
    estoquePreservado: divergencias.length === 0,
    divergencias: divergencias.map((d) => `${d.sku ?? d.chave}.${d.campo}: ${d.antes} → ${d.depois}`),
    relatorio,
    relatorioSku: relatorioPorSku(estoqueDepois),
    cobertura: coberturaInfo,
    auditoriaId,
  };
}
