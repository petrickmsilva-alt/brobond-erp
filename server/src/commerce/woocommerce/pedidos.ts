// ============================================================================
// COMMERCE OS — WOOCOMMERCE MULTI-STORE › IMPORTAÇÃO DE PEDIDOS POR LOJA.
//
// Cada loja importa os próprios pedidos, com referência PRÓPRIA:
//
//   RETAIL     → WOO-RETAIL-<id>
//   WHOLESALE  → WOO-WHOLESALE-<id>
//
// A referência é gravada em `vendas.pedido_cliente` e a idempotência FORTE vem
// do índice único `uq_vendas_pedido_externo (empresa_id, pedido_externo_canal,
// pedido_externo_id)` (migration 0034), com o canal gravado POR LOJA
// (`WOOCOMMERCE_RETAIL` / `WOOCOMMERCE_WHOLESALE`): o MESMO id de pedido nas
// duas lojas gera duas vendas legítimas, e reimportar NUNCA duplica — nem sob
// concorrência (o INSERT perdedor recebe 23505 e é tratado como já importado).
//
// INCREMENTAL: a água-marca é `woocommerce_sync_state.ultimo_pedido_em` DA LOJA.
// A primeira carga usa a janela `dias`; as seguintes pedem `after=<água-marca>`.
// A água-marca nunca retrocede.
//
// REGRAS DE OURO (as mesmas do fluxo single-store):
//   • item sem SKU no ERP NÃO entra calado — volta em `pendentes`;
//   • os valores financeiros do pedido (total, frete, desconto, forma de
//     pagamento) são preservados;
//   • cancelamento/reembolso NÃO é aplicado automaticamente — o pedido é
//     apenas reportado; quem decide é o operador.
// ============================================================================
import { HttpError } from '../../errors';
import { getStore, validarTamanhoNaGrade } from '../../services';
import type { Row } from '../../store';
import { getResource } from '../../resources';
import { recalcularTotal } from '../../itens';
import { escopoDeSistema, type EscopoEmpresa } from '../../empresa';
import type { ConfigStore, StoreKey } from './registry';
import { wooStoreFetch, ehDryRun } from './cliente';
import { estadoDaStore, avancarAguaMarcaPedidos, registrarSincronizacao } from './estado';

const R_VENDAS = () => getResource('vendas')!;
const R_ITENS = () => getResource('itens_venda')!;
const R_CLIENTES = () => getResource('clientes')!;
const R_PRODUTOS = () => getResource('produtos')!;
const R_TAMANHOS = () => getResource('tamanhos')!;
const R_ESTOQUES = () => getResource('estoques')!;

type LinhaWoo = {
  sku?: string;
  name?: string;
  quantity?: number;
  price?: number;
  total?: string;
  meta_data?: { key?: string; value?: unknown }[];
};
export type PedidoWoo = {
  id?: number;
  number?: string;
  status?: string;
  date_created?: string;
  total?: string;
  shipping_total?: string;
  discount_total?: string;
  payment_method_title?: string;
  customer_note?: string;
  billing?: { first_name?: string; last_name?: string; email?: string; phone?: string; cpf?: string; cnpj?: string };
  line_items?: LinhaWoo[];
};

export type ResultadoPedidosLoja = {
  store_key: StoreKey;
  ok: boolean;
  importados: { pedido: string; venda_id: number; total: number }[];
  ignorados: string[];
  pendentes: { pedido: string; motivo: string; itens: string[] }[];
  total_encontrados: number;
  erro?: string;
};

/** Desfecho da importação de UM pedido (usado pelo lote e pelo webhook). */
export type DesfechoPedido =
  | { tipo: 'importado'; pedido: string; venda_id: number; total: number; pendentes: string[] }
  | { tipo: 'ignorado'; pedido: string }
  | { tipo: 'pendente'; pedido: string; motivo: string; itens: string[] };

/** Índices do ERP carregados uma vez por operação (SKU → produto, código → tamanho). */
export type ContextoImportacao = {
  empresaId: number;
  escopo: EscopoEmpresa;
  produtoPorSku: Map<string, Row>;
  tamanhoPorCodigo: Map<string, Row>;
  primeiroTamanhoComSaldo: (produtoId: number) => number | null;
  tamanhoFallback: number;
};

/** Referência lógica imutável do pedido da loja. */
export function referenciaPedido(store: StoreKey, pedidoId: number | string): string {
  return `WOO-${store}-${String(pedidoId).trim()}`;
}

/**
 * Referência LEGADA do fluxo single-store (`WOO-<id>`). Um pedido já importado
 * antes da migração multi-loja tem essa forma; adotá-la evita criar uma
 * SEGUNDA venda para o mesmo pedido (o histórico é preservado como está).
 */
function referenciaLegada(pedidoId: number | string): string {
  return `WOO-${String(pedidoId).trim()}`;
}

/** Venda já existente para o pedido (referência nova OU legada). */
async function vendaExistente(empresaId: number, referencia: string, legada: string): Promise<Row | null> {
  const s = getStore();
  const porNova = await s.findOneWhere(R_VENDAS(), { empresa_id: empresaId, pedido_cliente: referencia });
  if (porNova) return porNova;
  return s.findOneWhere(R_VENDAS(), { empresa_id: empresaId, pedido_cliente: legada });
}

/** Tamanho vindo da variação (meta_data do item: pa_tamanho, Tamanho, tamanho…). */
function extrairTamanho(linha: LinhaWoo): string {
  for (const m of linha.meta_data || []) {
    const chave = String(m?.key || '').toLowerCase();
    if (!chave) continue;
    if (chave === 'tamanho' || chave === 'pa_tamanho' || chave.endsWith('_tamanho') || chave.endsWith('-tamanho')) {
      return String(m?.value ?? '').trim().toUpperCase();
    }
  }
  return '';
}

function rotuloLinha(linha: LinhaWoo): string {
  return String(linha?.name || linha?.sku || 'item sem nome').trim();
}

/**
 * Busca pedidos da loja em páginas de 100 (paginação real), respeitando a
 * janela incremental. Devolve o instante do pedido mais recente para avançar a
 * água-marca.
 *
 * `order=asc` é obrigatório: a água-marca (`after`) avança para o pedido mais
 * recente da janela. Com `order=desc`, quando a janela tem mais pedidos do que
 * `limite`, a paginação é truncada ANTES dos pedidos mais novos — a água-marca
 * ficaria presa no mais novo que coube e a próxima rodada pediria `after` dele,
 * pulando para sempre os que sobraram. Em ordem crescente o truncamento deixa
 * de fora apenas os mais novos, que a próxima execução pega.
 */
async function buscarPedidos(
  cfg: ConfigStore,
  status: string,
  depoisIso: string,
  limite: number
): Promise<{ pedidos: PedidoWoo[]; maisRecente: string | null; dry_run: boolean }> {
  const pedidos: PedidoWoo[] = [];
  let maisRecente: string | null = null;
  const porPagina = 100;
  const maxPaginas = Math.max(1, Math.ceil(limite / porPagina));
  for (let pagina = 1; pagina <= maxPaginas; pagina++) {
    const lote = await wooStoreFetch<PedidoWoo[]>(
      cfg,
      `/orders?status=${encodeURIComponent(status)}&after=${encodeURIComponent(depoisIso)}&per_page=${porPagina}&page=${pagina}&orderby=date&order=asc`
    );
    if (ehDryRun(lote)) return { pedidos: [], maisRecente: null, dry_run: true };
    if (!Array.isArray(lote) || !lote.length) break;
    for (const p of lote) {
      pedidos.push(p);
      const data = String(p.date_created || '');
      if (data && (!maisRecente || Date.parse(data) > Date.parse(maisRecente))) maisRecente = data;
    }
    if (lote.length < porPagina) break;
    if (pedidos.length >= limite) break;
  }
  return { pedidos: pedidos.slice(0, limite), maisRecente, dry_run: false };
}

/**
 * Confirma UM pedido na API oficial da loja. O webhook é NOTIFICAÇÃO, não
 * fonte de verdade: antes de aplicar qualquer atualização sensível, o ERP lê o
 * estado REAL do pedido na loja. `null` quando o pedido não existe lá.
 */
export async function buscarPedidoDaLoja(cfg: ConfigStore, pedidoId: number | string): Promise<PedidoWoo | null> {
  const id = String(pedidoId).trim();
  if (!id) return null;
  const resposta = await wooStoreFetch<PedidoWoo>(cfg, `/orders/${encodeURIComponent(id)}`);
  if (ehDryRun(resposta)) return null;
  return resposta && typeof resposta === 'object' && !Array.isArray(resposta) ? resposta : null;
}

/**
 * Carrega os índices do ERP uma vez por operação (SKU → produto, código →
 * tamanho, primeiro tamanho com saldo). Duplicidade de SKU ou de código de
 * tamanho BLOQUEIA a importação — associar o pedido ao produto errado é pior
 * que não importar.
 */
export async function carregarContextoImportacao(empresaId: number): Promise<ContextoImportacao> {
  const s = getStore();
  const [produtosR, tamanhosR, estoquesR] = await Promise.all([
    s.list(R_PRODUTOS(), { page: 1, pageSize: 20000, filter: { empresa_id: empresaId } }),
    s.list(R_TAMANHOS(), { page: 1, pageSize: 20000, sort: 'ordem', dir: 'asc' }),
    s.list(R_ESTOQUES(), { page: 1, pageSize: 20000, filter: { empresa_id: empresaId } }),
  ]);
  const produtoPorSku = new Map<string, Row>();
  for (const p of produtosR.rows) {
    const sku = String(p.sku || '').trim().toUpperCase();
    if (sku && produtoPorSku.has(sku)) {
      throw new HttpError(409, 'Há SKUs duplicados nesta empresa. A importação WooCommerce foi bloqueada para não associar o pedido ao produto errado.');
    }
    if (sku) produtoPorSku.set(sku, p);
  }
  const tamanhoPorCodigo = new Map<string, Row>();
  for (const t of tamanhosR.rows) {
    const codigo = String(t.codigo || '').trim().toUpperCase();
    if (codigo && tamanhoPorCodigo.has(codigo)) throw new HttpError(409, 'Há códigos de tamanho duplicados. A importação WooCommerce foi bloqueada.');
    if (codigo) tamanhoPorCodigo.set(codigo, t);
  }
  const primeiroTamanhoComSaldo = (produtoId: number): number | null => {
    const comSaldo = estoquesR.rows.find((e) => Number(e.produto_id) === produtoId && Number(e.quantidade || 0) > 0);
    return comSaldo ? Number(comSaldo.tamanho_id) : null;
  };
  return {
    empresaId,
    escopo: escopoDeSistema(empresaId),
    produtoPorSku,
    tamanhoPorCodigo,
    primeiroTamanhoComSaldo,
    tamanhoFallback: Number(tamanhosR.rows[0]?.id ?? 0),
  };
}

/**
 * Importa UM pedido da loja. Extraído do lote para que o WEBHOOK reusa
 * exatamente a mesma lógica — o webhook não reimplementa a importação, ele
 * confirma o pedido na API oficial e chama isto.
 *
 * Idempotente: pedido já importado (referência nova ou legada) volta
 * `ignorado`; corrida com o índice único parcial também vira `ignorado`.
 */
export async function importarUmPedido(cfg: ConfigStore, ctx: ContextoImportacao, pedido: PedidoWoo): Promise<DesfechoPedido> {
  const s = getStore();
  const empresaId = ctx.empresaId;
  const canal = cfg.canal;
  const numero = String(pedido.number ?? pedido.id ?? '').trim();
  const referencia = referenciaPedido(cfg.store_key, pedido.id ?? numero);
  const legada = referenciaLegada(pedido.id ?? numero);
  const jaExiste = await vendaExistente(empresaId, referencia, legada);
  if (jaExiste) {
    // Pedido já importado. Reimportar não duplica e NÃO altera pagamento,
    // status ou valores — mudanças de status externas são apenas reportadas.
    return { tipo: 'ignorado', pedido: numero || referencia };
  }

  const itensResolvidos: { produto: Row; tamanhoId: number; quantidade: number; preco: number }[] = [];
  const itensPendentes: string[] = [];
  for (const linha of pedido.line_items || []) {
    const sku = String(linha.sku || '').trim().toUpperCase();
    const produto = sku ? ctx.produtoPorSku.get(sku) : undefined;
    if (!produto) {
      itensPendentes.push(`${rotuloLinha(linha)}${sku ? ` (SKU ${sku})` : ' (sem SKU)'}`);
      continue;
    }
    const pedidoTamanho = extrairTamanho(linha);
    const tamanho = pedidoTamanho ? ctx.tamanhoPorCodigo.get(pedidoTamanho) : undefined;
    const tamanhoId = tamanho ? Number(tamanho.id) : (ctx.primeiroTamanhoComSaldo(Number(produto.id)) ?? ctx.tamanhoFallback);
    if (!tamanhoId) {
      itensPendentes.push(`${rotuloLinha(linha)} (sem tamanho no ERP)`);
      continue;
    }
    await validarTamanhoNaGrade(Number(produto.id), tamanhoId, undefined, ctx.escopo);
    const quantidade = Math.max(1, Math.trunc(Number(linha.quantity) || 1));
    const precoInformado = Number(linha.price);
    const totalLinha = Number(String(linha.total ?? '').replace(',', '.'));
    const preco =
      Number.isFinite(precoInformado) && precoInformado > 0
        ? precoInformado
        : Number.isFinite(totalLinha) && totalLinha > 0
          ? Math.round((totalLinha / quantidade) * 100) / 100
          : Number(canal === 'site_atacado' ? produto.preco_atacado || produto.preco_venda || 0 : produto.preco_venda || 0);
    itensResolvidos.push({ produto, tamanhoId, quantidade, preco });
  }

  if (!itensResolvidos.length) {
    return { tipo: 'pendente', pedido: numero || referencia, motivo: 'nenhum item com SKU cadastrado no ERP', itens: itensPendentes };
  }

  try {
    const criado = await s.transaction(async (tx) => {
      const billing = pedido.billing || {};
      const email = String(billing.email || '').trim().toLowerCase();
      const nome = [billing.first_name, billing.last_name].filter(Boolean).join(' ').trim() || email || `Cliente loja ${numero || referencia}`;
      let cliente = email ? await s.findOneWhere(R_CLIENTES(), { email, empresa_id: empresaId }, tx) : null;
      if (!cliente) cliente = await s.findOneWhere(R_CLIENTES(), { nome, empresa_id: empresaId }, tx);
      if (!cliente) {
        cliente = await s.insert(
          R_CLIENTES(),
          {
            empresa_id: empresaId,
            nome,
            email: email || null,
            telefone: billing.phone ? String(billing.phone) : null,
            tipo: canal === 'site_atacado' ? 'atacadista' : 'varejo',
            ativo: true,
          },
          tx
        );
      }
      const venda = await s.insert(
        R_VENDAS(),
        {
          empresa_id: empresaId,
          cliente_id: Number(cliente.id),
          data: String(pedido.date_created || new Date().toISOString()).slice(0, 10),
          // "Cotação / Pedido do site": entra para conferência, não baixa estoque.
          status: 'cotacao',
          canal_venda: canal,
          pedido_cliente: referencia,
          pedido_externo_canal: `WOOCOMMERCE_${cfg.store_key}`,
          pedido_externo_id: String(pedido.id ?? numero),
          frete: Math.max(0, Number(pedido.shipping_total || 0)),
          desconto: Math.max(0, Number(pedido.discount_total || 0)),
          condicao_pagamento: pedido.payment_method_title ? String(pedido.payment_method_title) : null,
          fin_status: 'a_receber',
          observacoes: [
            `Pedido importado da loja ${cfg.store_key} (${cfg.url}) — nº ${numero || referencia}`,
            pedido.customer_note ? `Observação do cliente: ${String(pedido.customer_note).trim()}` : null,
            itensPendentes.length ? `Itens NÃO importados (conferir cadastro de SKU): ${itensPendentes.join('; ')}` : null,
          ]
            .filter(Boolean)
            .join('\n'),
        },
        tx
      );
      for (const item of itensResolvidos) {
        await s.insert(
          R_ITENS(),
          {
            empresa_id: empresaId,
            venda_id: Number(venda.id),
            produto_id: Number(item.produto.id),
            tamanho_id: item.tamanhoId,
            quantidade: item.quantidade,
            preco_unitario: item.preco,
            desconto_pct: 0,
            subtotal: Math.round(item.quantidade * item.preco * 100) / 100,
          },
          tx
        );
      }
      const total = await recalcularTotal('venda', Number(venda.id), tx);
      return { vendaId: Number(venda.id), total };
    });
    return { tipo: 'importado', pedido: numero || referencia, venda_id: criado.vendaId, total: criado.total, pendentes: itensPendentes };
  } catch (e) {
    // Corrida: duas importações simultâneas gravaram a MESMA referência e o
    // índice único parcial arbitrou. Idempotência manda tratar como já
    // importado, nunca como erro.
    const pg = e as { code?: string; cause?: { code?: string }; message?: string };
    if (pg?.code === '23505' || pg?.cause?.code === '23505') return { tipo: 'ignorado', pedido: numero || referencia };
    return { tipo: 'pendente', pedido: numero || referencia, motivo: pg?.message || 'falha ao gravar o pedido', itens: itensPendentes };
  }
}

/**
 * Importa os pedidos de UMA loja.
 *
 * `dias` define a janela da primeira carga; `incremental` usa a água-marca da
 * loja. Idempotente e seguro sob concorrência (índice único parcial).
 */
export async function importarPedidosDaLoja(
  cfg: ConfigStore,
  empresaId: number,
  opcoes: { dias?: number; status?: string; limite?: number; incremental?: boolean; actor?: { id: number | null; name: string } } = {}
): Promise<ResultadoPedidosLoja> {
  const s = getStore();
  const escopo: EscopoEmpresa = escopoDeSistema(empresaId);
  const status = String(opcoes.status || 'processing').trim() || 'processing';
  const limite = Math.min(500, Math.max(1, Number(opcoes.limite) || 100));
  const dias = Math.min(90, Math.max(1, Number(opcoes.dias) || 7));

  const estado = await estadoDaStore(empresaId, cfg.store_key);
  const incremental = opcoes.incremental === true && Boolean(estado.ultimo_pedido_em);
  const depoisIso = incremental
    ? estado.ultimo_pedido_em!
    : new Date(Date.now() - dias * 86400_000).toISOString();

  const { pedidos, maisRecente, dry_run } = await buscarPedidos(cfg, status, depoisIso, limite);
  if (dry_run) {
    return { store_key: cfg.store_key, ok: true, importados: [], ignorados: [], pendentes: [], total_encontrados: 0 };
  }

  const contexto = await carregarContextoImportacao(empresaId);
  const importados: { pedido: string; venda_id: number; total: number }[] = [];
  const ignorados: string[] = [];
  const pendentes: { pedido: string; motivo: string; itens: string[] }[] = [];

  for (const pedido of pedidos) {
    const desfecho = await importarUmPedido(cfg, contexto, pedido);
    if (desfecho.tipo === 'importado') {
      importados.push({ pedido: desfecho.pedido, venda_id: desfecho.venda_id, total: desfecho.total });
      if (desfecho.pendentes.length) {
        pendentes.push({ pedido: desfecho.pedido, motivo: 'itens sem SKU no ERP ficaram de fora', itens: desfecho.pendentes });
      }
    } else if (desfecho.tipo === 'ignorado') {
      ignorados.push(desfecho.pedido);
    } else {
      pendentes.push({ pedido: desfecho.pedido, motivo: desfecho.motivo, itens: desfecho.itens });
    }
  }

  if (maisRecente) await avancarAguaMarcaPedidos(empresaId, cfg.store_key, maisRecente);
  await registrarSincronizacao(empresaId, cfg.store_key, { erro: null });

  await s
    .audit({
      usuario_id: opcoes.actor?.id ?? null,
      usuario: opcoes.actor?.name ?? 'WooCommerce multi-store',
      acao: 'importar',
      recurso: 'marketplace',
      registro_id: null,
      descricao: `Importação da loja ${cfg.store_key} (${cfg.url}, status ${status}): ${importados.length} novo(s), ${ignorados.length} já importado(s), ${pendentes.length} pendente(s)`,
      dados: { origem: 'woocommerce', store_key: cfg.store_key, status, incremental, importados, ignorados, pendentes },
      empresa_id: empresaId,
    })
    .catch(() => undefined);

  return {
    store_key: cfg.store_key,
    ok: true,
    importados,
    ignorados,
    pendentes,
    total_encontrados: pedidos.length,
  };
}
