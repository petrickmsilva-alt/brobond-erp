// ============================================================================
// ADAPTADOR — WOOCOMMERCE (site próprio)
//
// Fonte de configuração: o MESMO trio de ambiente que a integração existente
// usa (WOOCOMMERCE_URL/CK/CS) — não há credencial nova para o operador.
// A API é a REST v3 do WooCommerce (Basic Auth sobre HTTPS), a mesma que
// `server/src/loja.ts` já usa em produção.
//
// Webhook: `X-WC-Webhook-Signature` = base64(HMAC-SHA256(corpo cru, CS)).
// ============================================================================
import { createHmac, timingSafeEqual } from 'node:crypto';
import { configLoja, type ConfigLoja } from '../../loja';
import {
  type CanalComercio,
  type CapacidadesCanal,
  type CommerceProvider,
  type ContextoChamada,
  type EventoWebhook,
  type PedidoExterno,
  type ProdutoExterno,
  type ResultadoEstoque,
  type ResultadoPreco,
  CredencialAusenteError,
  ErroCanalError,
  httpJson,
  numero,
} from '../contrato';

const CANAL: CanalComercio = 'WOOCOMMERCE';
const TIMEOUT_MS = Number(process.env.WOOCOMMERCE_TIMEOUT_MS) || 20_000;

const CAPACIDADES: CapacidadesCanal = {
  pedidos: true,
  produtos: true,
  estoque: true,
  preco: true,
  rastreio: 'recebe',
  webhook: true,
  polling: true,
};

export type DepsWooCommerce = {
  /** Injetável nos testes. */
  config?: () => ConfigLoja | null;
  fetchImpl?: typeof fetch;
};

function baseUrl(cfg: ConfigLoja): string {
  return `${cfg.url}/wp-json/wc/v3`;
}

function authInit(cfg: ConfigLoja, init: Parameters<typeof fetch>[1] = {}): Parameters<typeof fetch>[1] {
  const auth = Buffer.from(`${cfg.ck}:${cfg.cs}`).toString('base64');
  return {
    ...init,
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: {
      Authorization: `Basic ${auth}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...((init.headers as Record<string, string>) || {}),
    },
  };
}

export function criarWooCommerceAdapter(deps: DepsWooCommerce = {}): CommerceProvider {
  const lerConfig = deps.config ?? configLoja;
  const chamar = (op: string, cfg: ConfigLoja, caminho: string, init: Parameters<typeof fetch>[1], ctx: ContextoChamada) =>
    httpJson(CANAL, op, `${baseUrl(cfg)}${caminho}`, authInit(cfg, init), { ...ctx, fetchImpl: deps.fetchImpl ?? ctx.fetchImpl });

  const exigirConfig = (op: string, ctx: ContextoChamada): ConfigLoja => {
    const cfg = lerConfig();
    if (!cfg) throw new CredencialAusenteError(CANAL, op, 'defina WOOCOMMERCE_URL, WOOCOMMERCE_CK e WOOCOMMERCE_CS');
    void ctx;
    return cfg;
  };

  return {
    canal: CANAL,
    rotulo: 'WooCommerce (site próprio)',
    capacidades: CAPACIDADES,
    requerCredencial: true,

    configurado() {
      const cfg = lerConfig();
      return cfg ? { ok: true } : { ok: false, motivo: 'WOOCOMMERCE_URL/CK/CS não configuradas no servidor' };
    },

    async testar(ctx = {}) {
      if (!lerConfig()) return { ok: false, mensagem: 'Credenciais do WooCommerce ausentes no servidor.' };
      try {
        const cfg = exigirConfig('testar', ctx);
        const loja = await chamar('testar', cfg, '/system_status', { method: 'GET' }, ctx);
        return { ok: true, externoId: String(loja?.environment?.site_url || cfg.url), mensagem: 'Conexão OK.' };
      } catch (e: any) {
        return { ok: false, mensagem: e?.message || 'Falha ao testar a conexão.' };
      }
    },

    async listarPedidos(ctx) {
      const cfg = exigirConfig('listarPedidos', ctx);
      const status = String(process.env.WOOCOMMERCE_STATUS || 'processing').trim() || 'processing';
      const limite = Math.min(100, Math.max(1, ctx.limite || 50));
      const depois = ctx.desde.toISOString();
      const pedidos = await chamar(
        'listarPedidos',
        cfg,
        `/orders?status=${encodeURIComponent(status)}&after=${encodeURIComponent(depois)}&per_page=${limite}&orderby=date&order=desc`,
        { method: 'GET' },
        ctx
      );
      if (!Array.isArray(pedidos)) return [];
      return pedidos.map((p: any) => mapearPedido(p));
    },

    async listarProdutos(ctx) {
      const cfg = exigirConfig('listarProdutos', ctx);
      const limite = Math.min(100, Math.max(1, ctx.limite || 100));
      const produtos = await chamar('listarProdutos', cfg, `/products?per_page=${limite}&status=publish`, { method: 'GET' }, ctx);
      if (!Array.isArray(produtos)) return [];
      return produtos.map<ProdutoExterno>((p: any) => ({
        externalId: String(p.id),
        sku: p.sku ? String(p.sku) : null,
        nome: String(p.name || ''),
        preco: p.price !== undefined && p.price !== '' ? numero(p.price, 0) : null,
        estoque: p.stock_quantity === null || p.stock_quantity === undefined ? null : numero(p.stock_quantity),
        ativo: String(p.status || '') === 'publish',
      }));
    },

    /**
     * Saldo: usa o `externoId` do mapeamento quando existe; sem mapeamento,
     * tenta o SKU exato do produto simples. O que não for encontrado volta em
     * `semMapeamento` — nunca se cria/edita produto "chutando" id.
     */
    async publicarEstoque(itens, ctx) {
      const cfg = exigirConfig('publicarEstoque', ctx);
      const resultado: ResultadoEstoque = { atualizados: [], semMapeamento: [], falhas: [] };
      for (const item of itens) {
        try {
          const alvo = await resolverAlvoWoo(cfg, item, ctx);
          if (!alvo) {
            resultado.semMapeamento.push(item.sku);
            continue;
          }
          await chamar(
            'publicarEstoque',
            cfg,
            `/products/${alvo.productId}`,
            { method: 'PUT', body: JSON.stringify({ stock_quantity: Math.max(0, Math.trunc(item.quantidade)), manage_stock: true }) },
            ctx
          );
          resultado.atualizados.push({ sku: item.sku, externalId: String(alvo.productId) });
        } catch (e: any) {
          resultado.falhas.push({ sku: item.sku, mensagem: e?.message || 'falha', transitorio: e instanceof ErroCanalError ? e.transitorio : true });
        }
      }
      return resultado;
    },

    async publicarPreco(itens, ctx) {
      const cfg = exigirConfig('publicarPreco', ctx);
      const resultado: ResultadoPreco = { atualizados: [], semMapeamento: [], falhas: [] };
      for (const item of itens) {
        try {
          const alvo = await resolverAlvoWoo(cfg, item, ctx);
          if (!alvo) {
            resultado.semMapeamento.push(item.sku);
            continue;
          }
          await chamar(
            'publicarPreco',
            cfg,
            `/products/${alvo.productId}`,
            { method: 'PUT', body: JSON.stringify({ regular_price: String(item.preco) }) },
            ctx
          );
          resultado.atualizados.push({ sku: item.sku, externalId: String(alvo.productId) });
        } catch (e: any) {
          resultado.falhas.push({ sku: item.sku, mensagem: e?.message || 'falha', transitorio: e instanceof ErroCanalError ? e.transitorio : true });
        }
      }
      return resultado;
    },

    validarWebhook(corpoBruto, headers) {
      const cfg = lerConfig();
      if (!cfg) return false;
      const recebida = String(headers['x-wc-webhook-signature'] || headers['X-WC-Webhook-Signature'] || '');
      if (!recebida) return false;
      const esperada = createHmac('sha256', cfg.cs).update(corpoBruto, 'utf8').digest('base64');
      const a = Buffer.from(recebida);
      const b = Buffer.from(esperada);
      return a.length === b.length && timingSafeEqual(a, b);
    },

    lerWebhook(corpoBruto, headers) {
      const p = JSON.parse(corpoBruto || '{}');
      const topico = String(headers['x-wc-webhook-topic'] || headers['X-WC-Webhook-Topic'] || 'order.updated');
      const id = String(p?.id ?? '');
      const recebidoEm = new Date().toISOString();
      const eventos: EventoWebhook[] = [
        {
          // O WooCommerce pode reenviar o mesmo evento; a chave inclui o tópico
          // e o estado atualizado da entrega para não fundir dois updates reais.
          externalId: `${topico}:${id}:${String(headers['x-wc-webhook-delivery-id'] || p?.date_modified_gmt || recebidoEm)}`,
          tipo: topico,
          pedidoExternoId: topico.startsWith('order') ? id : null,
          recebidoEm,
          payload: p,
        },
      ];
      return eventos;
    },
  };
}

/** Id do produto na loja: mapeamento explícito ou SKU exato de produto simples. */
async function resolverAlvoWoo(
  cfg: ConfigLoja,
  item: { sku: string; externoId?: string | null },
  ctx: ContextoChamada
): Promise<{ productId: number } | null> {
  if (item.externoId && /^\d+$/.test(item.externoId)) return { productId: Number(item.externoId) };
  const encontrados = await httpJson(
    CANAL,
    'resolverSku',
    `${baseUrl(cfg)}/products?sku=${encodeURIComponent(item.sku)}&per_page=1`,
    authInit(cfg, { method: 'GET' }),
    ctx
  );
  if (Array.isArray(encontrados) && encontrados[0]?.id) return { productId: Number(encontrados[0].id) };
  return null;
}

function mapearPedido(p: any): PedidoExterno {
  const billing = p?.billing || {};
  const nome = [billing.first_name, billing.last_name].filter(Boolean).join(' ').trim() || String(billing.email || '') || `Cliente loja ${p?.id ?? ''}`;
  return {
    externalId: String(p?.id ?? ''),
    numero: String(p?.number ?? p?.id ?? ''),
    status: String(p?.status || 'processing'),
    criadoEm: String(p?.date_created_gmt || p?.date_created || new Date().toISOString()),
    atualizadoEm: p?.date_modified_gmt ? String(p.date_modified_gmt) : null,
    moeda: String(p?.currency || 'BRL'),
    frete: numero(p?.shipping_total),
    desconto: numero(p?.discount_total),
    cliente: {
      nome,
      email: billing.email ? String(billing.email).trim().toLowerCase() : null,
      telefone: billing.phone ? String(billing.phone) : null,
      documento: billing.cnpj || billing.cpf || null,
    },
    itens: (Array.isArray(p?.line_items) ? p.line_items : []).map((l: any) => ({
      sku: l?.sku ? String(l.sku).trim() : null,
      externalItemId: l?.variation_id ? String(l.variation_id) : l?.product_id ? String(l.product_id) : null,
      titulo: String(l?.name || ''),
      quantidade: Math.max(1, Math.trunc(numero(l?.quantity, 1))),
      precoUnitario: numero(l?.price),
      desconto: numero(l?.discount_total ?? l?.total_tax ?? 0) && numero(l?.subtotal) > numero(l?.total) ? numero(l?.subtotal) - numero(l?.total) : 0,
    })),
    rastreio: null,
    bruto: p,
  };
}
