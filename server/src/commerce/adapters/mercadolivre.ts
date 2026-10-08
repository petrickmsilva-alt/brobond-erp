// ============================================================================
// ADAPTADOR — MERCADO LIVRE
//
// Chamadas reais à API pública da Meli (`api.mercadolibre.com`) usando o token
// da conexão do conector (OAuth2 já existente no módulo de conectores). Sem
// token, o adaptador NÃO inventa uma integração: lança `CredencialAusenteError`
// (definitivo, exige reconectar).
//
// Estoque/preço usam o MAPEAMENTO EXPLÍCITO (`commerce_mapeamentos`): o id do
// anúncio no ML não se deduz do SKU do ERP sem risco de escrever no anúncio
// errado — quem não tem mapeamento volta em `semMapeamento`.
//
// Webhook: a Meli entrega notificações não assinadas; a proteção da rota é o
// token de webhook do canal (caminho secreto) — documentado no relatório.
// ============================================================================
import {
  type CanalComercio,
  type CapacidadesCanal,
  type CommerceProvider,
  CredencialAusenteError,
  httpJson,
  numero,
} from '../contrato';

const CANAL: CanalComercio = 'MERCADOLIVRE';
const BASE = process.env.MERCADOLIVRE_API_BASE_URL?.trim() || 'https://api.mercadolibre.com';
const TIMEOUT_MS = Number(process.env.MERCADOLIVRE_TIMEOUT_MS) || 20_000;

const CAPACIDADES: CapacidadesCanal = {
  pedidos: true,
  produtos: true,
  estoque: true,
  preco: true,
  rastreio: 'recebe',
  webhook: true,
  polling: true,
};

export type DepsMercadoLivre = { fetchImpl?: typeof fetch; baseUrl?: string };

function headers(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, Accept: 'application/json', 'Content-Type': 'application/json' };
}

export function criarMercadoLivreAdapter(deps: DepsMercadoLivre = {}): CommerceProvider {
  const base = (deps.baseUrl || BASE).replace(/\/+$/, '');
  const chamar = (op: string, url: string, init: Parameters<typeof fetch>[1], ctx: any, token: string) =>
    httpJson(CANAL, op, url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS), headers: { ...headers(token), ...((init?.headers as any) || {}) } }, {
      ...ctx,
      fetchImpl: deps.fetchImpl ?? ctx?.fetchImpl,
    });

  const tokenDe = (ctx: any, op: string): string => {
    const token = String(ctx?.credencial?.token || '').trim();
    if (!token) throw new CredencialAusenteError(CANAL, op);
    return token;
  };

  return {
    canal: CANAL,
    rotulo: 'Mercado Livre',
    capacidades: CAPACIDADES,
    requerCredencial: true,

    configurado(ctx) {
      return ctx?.credencial?.token ? { ok: true } : { ok: false, motivo: 'conta do Mercado Livre não conectada' };
    },

    async testar(ctx = {}) {
      try {
        const token = tokenDe(ctx, 'testar');
        const eu = await chamar('testar', `${base}/users/me`, { method: 'GET' }, ctx, token);
        return { ok: true, externoId: eu?.id ? String(eu.id) : null, mensagem: `Conectado como ${eu?.nickname || eu?.id || 'usuário'}.` };
      } catch (e: any) {
        return { ok: false, mensagem: e?.message || 'Falha ao testar a conexão.' };
      }
    },

    async listarPedidos(ctx) {
      const token = tokenDe(ctx, 'listarPedidos');
      const vendedor = String(ctx.credencial?.lojaId || '').trim();
      if (!vendedor) throw new CredencialAusenteError(CANAL, 'listarPedidos', 'o id do vendedor (seller) não foi guardado na conexão');
      const limite = Math.min(50, Math.max(1, ctx.limite || 50));
      const url = `${base}/orders/search?seller=${encodeURIComponent(vendedor)}&order.date_created.from=${encodeURIComponent(ctx.desde.toISOString())}&sort=date_desc&limit=${limite}`;
      const corpo = await chamar('listarPedidos', url, { method: 'GET' }, ctx, token);
      const resultados: any[] = Array.isArray(corpo?.results) ? corpo.results : [];
      return resultados.map((o) => ({
        externalId: String(o.id),
        numero: String(o.id),
        status: String(o.status || ''),
        criadoEm: String(o.date_created || new Date().toISOString()),
        atualizadoEm: o.last_updated ? String(o.last_updated) : null,
        moeda: String(o.currency_id || 'BRL'),
        frete: numero(o?.shipping?.cost ?? 0),
        desconto: 0,
        cliente: {
          nome: String(o?.buyer?.nickname || o?.buyer?.first_name || `Comprador ${o?.buyer?.id ?? ''}`),
          email: o?.buyer?.email ? String(o.buyer.email) : null,
          telefone: o?.buyer?.phone?.number ? String(o.buyer.phone.number) : null,
          documento: o?.buyer?.billing_info?.identification?.number ? String(o.buyer.billing_info.identification.number) : null,
        },
        itens: (Array.isArray(o?.order_items) ? o.order_items : []).map((i: any) => ({
          sku: i?.item?.seller_sku ? String(i.item.seller_sku) : i?.item?.seller_custom_field ? String(i.item.seller_custom_field) : null,
          externalItemId: i?.item?.id ? String(i.item.id) : null,
          titulo: String(i?.item?.title || ''),
          quantidade: Math.max(1, Math.trunc(numero(i?.quantity, 1))),
          precoUnitario: numero(i?.unit_price),
          desconto: numero(i?.discount ?? 0),
        })),
        rastreio: null,
        bruto: o,
      }));
    },

    async listarProdutos(ctx) {
      const token = tokenDe(ctx, 'listarProdutos');
      const vendedor = String(ctx.credencial?.lojaId || '').trim();
      if (!vendedor) throw new CredencialAusenteError(CANAL, 'listarProdutos', 'o id do vendedor (seller) não foi guardado na conexão');
      const limite = Math.min(50, Math.max(1, ctx.limite || 50));
      const busca = await chamar('listarProdutos', `${base}/users/${encodeURIComponent(vendedor)}/items/search?limit=${limite}`, { method: 'GET' }, ctx, token);
      const ids: string[] = Array.isArray(busca?.results) ? busca.results.map(String) : [];
      if (!ids.length) return [];
      const saida: any[] = [];
      for (let i = 0; i < ids.length; i += 20) {
        const lote = ids.slice(i, i + 20).join(',');
        const itens = await chamar('listarProdutos', `${base}/items?ids=${encodeURIComponent(lote)}`, { method: 'GET' }, ctx, token);
        for (const entrada of Array.isArray(itens) ? itens : []) {
          const item = entrada?.body;
          if (!item) continue;
          saida.push({
            externalId: String(item.id),
            sku: item.seller_sku ? String(item.seller_sku) : null,
            nome: String(item.title || ''),
            preco: item.price === undefined ? null : numero(item.price),
            estoque: item.available_quantity === undefined ? null : numero(item.available_quantity),
            ativo: String(item.status || '') === 'active',
          });
        }
      }
      return saida;
    },

    async publicarEstoque(itens, ctx) {
      const token = tokenDe(ctx, 'publicarEstoque');
      const resultado = { atualizados: [] as { sku: string; externalId: string }[], semMapeamento: [] as string[], falhas: [] as any[] };
      for (const item of itens) {
        const externoId = String(item.externoId || '').trim();
        if (!externoId) {
          resultado.semMapeamento.push(item.sku);
          continue;
        }
        try {
          await chamar(
            'publicarEstoque',
            `${base}/items/${encodeURIComponent(externoId)}`,
            { method: 'PUT', body: JSON.stringify({ available_quantity: Math.max(0, Math.trunc(item.quantidade)) }) },
            ctx,
            token
          );
          resultado.atualizados.push({ sku: item.sku, externalId: externoId });
        } catch (e: any) {
          resultado.falhas.push({ sku: item.sku, mensagem: e?.message || 'falha', transitorio: e?.transitorio === true });
        }
      }
      return resultado;
    },

    async publicarPreco(itens, ctx) {
      const token = tokenDe(ctx, 'publicarPreco');
      const resultado = { atualizados: [] as { sku: string; externalId: string }[], semMapeamento: [] as string[], falhas: [] as any[] };
      for (const item of itens) {
        const externoId = String(item.externoId || '').trim();
        if (!externoId) {
          resultado.semMapeamento.push(item.sku);
          continue;
        }
        try {
          await chamar(
            'publicarPreco',
            `${base}/items/${encodeURIComponent(externoId)}`,
            { method: 'PUT', body: JSON.stringify({ price: item.preco }) },
            ctx,
            token
          );
          resultado.atualizados.push({ sku: item.sku, externalId: externoId });
        } catch (e: any) {
          resultado.falhas.push({ sku: item.sku, mensagem: e?.message || 'falha', transitorio: e?.transitorio === true });
        }
      }
      return resultado;
    },

    // Notificação da Meli não é assinada; a rota do hub exige token secreto do
    // canal (ver `server/src/commerce/hub.ts`). Sem assinatura, este adaptador
    // não mente dizendo "validei criptograficamente".
    validarWebhook() {
      return true;
    },

    lerWebhook(corpoBruto, headers) {
      const p = JSON.parse(corpoBruto || '{}');
      const recebidoEm = new Date().toISOString();
      const id = String(p?.id ?? p?.resource ?? '');
      return [
        {
          externalId: `${String(p?.topic || 'notification')}:${id}:${String(p?._id || recebidoEm)}`,
          tipo: String(p?.topic || 'notification'),
          pedidoExternoId: String(p?.topic || '').startsWith('orders') ? String(p?.resource || '').split('/').pop() || null : null,
          recebidoEm,
          payload: p,
        },
      ];
    },
  };
}
