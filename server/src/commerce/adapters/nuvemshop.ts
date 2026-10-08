// ============================================================================
// ADAPTADOR — NUVEMSHOP (Tiendanube)
//
// A Nuvemshop é a PLATAFORMA-PONTE do hub (decisão de 2026-10-05, documentada
// em `modules/connectors/README.md`): Shopee/TikTok saíram, e o pedido do
// TikTok chega ao ERP triangulado por ela.
//
// Particularidades reais da API (as mesmas que o conector já trata):
//   • `Authentication: bearer <token>` (não `Authorization`) e User-Agent
//     identificando a aplicação;
//   • o id da LOJA é obrigatório no caminho: /v1/{store_id}/…;
//   • o token é permanente (não expira, não há refresh);
//   • webhook assinado com HMAC-SHA256 HEX do CORPO CRU no cabeçalho
//     `x-linkedstore-hmac-sha256`, chave = client secret do app.
// ============================================================================
import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  type CanalComercio,
  type CapacidadesCanal,
  type CommerceProvider,
  CredencialAusenteError,
  httpJson,
  numero,
} from '../contrato';

const CANAL: CanalComercio = 'NUVEMSHOP';
const BASE = process.env.NUVEMSHOP_API_BASE_URL?.trim() || 'https://api.nuvemshop.com.br/v1';
const TIMEOUT_MS = Number(process.env.NUVEMSHOP_TIMEOUT_MS) || 20_000;
const USER_AGENT = process.env.NUVEMSHOP_USER_AGENT || 'Brobond AI ERP (contato@brobond.com.br)';

const CAPACIDADES: CapacidadesCanal = {
  pedidos: true,
  produtos: true,
  estoque: true,
  preco: true,
  rastreio: 'recebe',
  webhook: true,
  polling: true,
};

export type DepsNuvemshop = { fetchImpl?: typeof fetch; baseUrl?: string; clientSecret?: string | null };

export function criarNuvemshopAdapter(deps: DepsNuvemshop = {}): CommerceProvider {
  const base = (deps.baseUrl || BASE).replace(/\/+$/, '');
  const chamar = (op: string, caminho: string, init: Parameters<typeof fetch>[1], ctx: any, token: string) =>
    httpJson(
      CANAL,
      op,
      `${base}${caminho}`,
      {
        ...init,
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: { Authentication: `bearer ${token}`, 'User-Agent': USER_AGENT, Accept: 'application/json', 'Content-Type': 'application/json' },
      },
      { ...ctx, fetchImpl: deps.fetchImpl ?? ctx?.fetchImpl }
    );

  const exigir = (ctx: any, op: string): { token: string; loja: string } => {
    const token = String(ctx?.credencial?.token || '').trim();
    const loja = String(ctx?.credencial?.lojaId || '').trim();
    if (!token || !loja) throw new CredencialAusenteError(CANAL, op, 'loja da Nuvemshop não conectada');
    return { token, loja };
  };

  return {
    canal: CANAL,
    rotulo: 'Nuvemshop',
    capacidades: CAPACIDADES,
    requerCredencial: true,

    configurado(ctx) {
      return ctx?.credencial?.token && ctx?.credencial?.lojaId
        ? { ok: true }
        : { ok: false, motivo: 'loja da Nuvemshop não conectada (token + id da loja)' };
    },

    async testar(ctx = {}) {
      try {
        const { token, loja } = exigir(ctx, 'testar');
        const dados = await chamar('testar', `/${encodeURIComponent(loja)}/store`, { method: 'GET' }, ctx, token);
        return { ok: true, externoId: loja, mensagem: `Loja ${dados?.name?.pt || dados?.name || loja} conectada.` };
      } catch (e: any) {
        return { ok: false, mensagem: e?.message || 'Falha ao testar a conexão.' };
      }
    },

    async listarPedidos(ctx) {
      const { token, loja } = exigir(ctx, 'listarPedidos');
      const limite = Math.min(200, Math.max(1, ctx.limite || 50));
      const url = `/${encodeURIComponent(loja)}/orders?created_at_min=${encodeURIComponent(ctx.desde.toISOString())}&per_page=${limite}`;
      const pedidos = await chamar('listarPedidos', url, { method: 'GET' }, ctx, token);
      if (!Array.isArray(pedidos)) return [];
      return pedidos.map((o: any) => ({
        externalId: String(o.id),
        numero: String(o.number ?? o.id),
        status: String(o.status || ''),
        criadoEm: String(o.created_at || new Date().toISOString()),
        atualizadoEm: o.updated_at ? String(o.updated_at) : null,
        moeda: String(o.currency || 'BRL'),
        frete: numero(o?.shipping_cost_customer ?? o?.shipping_cost_owner ?? 0),
        desconto: numero(o?.discount ?? 0),
        cliente: {
          nome: String(o?.customer?.name || [o?.customer?.first_name, o?.customer?.last_name].filter(Boolean).join(' ') || `Cliente ${o?.number ?? ''}`),
          email: o?.customer?.email ? String(o.customer.email).trim().toLowerCase() : (o?.contact_email ? String(o.contact_email).trim().toLowerCase() : null),
          telefone: o?.customer?.phone ? String(o.customer.phone) : (o?.contact_phone ? String(o.contact_phone) : null),
          documento: o?.customer?.identification ? String(o.customer.identification) : null,
        },
        itens: (Array.isArray(o?.products) ? o.products : []).map((i: any) => ({
          sku: i?.sku ? String(i.sku).trim() : null,
          externalItemId: i?.variant_id ? String(i.variant_id) : i?.product_id ? String(i.product_id) : null,
          titulo: String(i?.name || ''),
          quantidade: Math.max(1, Math.trunc(numero(i?.quantity, 1))),
          precoUnitario: numero(i?.price),
          desconto: 0,
        })),
        rastreio: o?.shipping_tracking_number
          ? { codigo: String(o.shipping_tracking_number), transportadora: o?.shipping_carrier_name ? String(o.shipping_carrier_name) : null, url: o?.shipping_tracking_url ? String(o.shipping_tracking_url) : null }
          : null,
        bruto: o,
      }));
    },

    async listarProdutos(ctx) {
      const { token, loja } = exigir(ctx, 'listarProdutos');
      const limite = Math.min(200, Math.max(1, ctx.limite || 100));
      const produtos = await chamar('listarProdutos', `/${encodeURIComponent(loja)}/products?per_page=${limite}`, { method: 'GET' }, ctx, token);
      if (!Array.isArray(produtos)) return [];
      const saida: any[] = [];
      for (const p of produtos) {
        const variantes: any[] = Array.isArray(p?.variants) ? p.variants : [];
        if (!variantes.length) {
          saida.push({ externalId: String(p.id), sku: null, nome: String(p?.name?.pt || p?.name || ''), preco: null, estoque: null, ativo: String(p?.published) === 'true' });
          continue;
        }
        for (const v of variantes) {
          saida.push({
            externalId: `${String(p.id)}:${String(v.id)}`,
            sku: v?.sku ? String(v.sku) : null,
            nome: `${String(p?.name?.pt || p?.name || '')}${v?.values?.length ? ` — ${v.values.map((x: any) => x?.pt || x).join('/')}` : ''}`,
            preco: v?.price === undefined ? null : numero(v.price),
            estoque: v?.stock === undefined || v?.stock === null ? null : numero(v.stock),
            ativo: String(p?.published) === 'true',
          });
        }
      }
      return saida;
    },

    async publicarEstoque(itens, ctx) {
      const { token, loja } = exigir(ctx, 'publicarEstoque');
      const resultado = { atualizados: [] as { sku: string; externalId: string }[], semMapeamento: [] as string[], falhas: [] as any[] };
      for (const item of itens) {
        const alvo = alvoNuvemshop(String(item.externoId || ''));
        if (!alvo) {
          resultado.semMapeamento.push(item.sku);
          continue;
        }
        try {
          await chamar(
            'publicarEstoque',
            `/${encodeURIComponent(loja)}/products/${alvo.produto}/variants/${alvo.variante}`,
            { method: 'PUT', body: JSON.stringify({ stock: Math.max(0, Math.trunc(item.quantidade)) }) },
            ctx,
            token
          );
          resultado.atualizados.push({ sku: item.sku, externalId: `${alvo.produto}:${alvo.variante}` });
        } catch (e: any) {
          resultado.falhas.push({ sku: item.sku, mensagem: e?.message || 'falha', transitorio: e?.transitorio === true });
        }
      }
      return resultado;
    },

    async publicarPreco(itens, ctx) {
      const { token, loja } = exigir(ctx, 'publicarPreco');
      const resultado = { atualizados: [] as { sku: string; externalId: string }[], semMapeamento: [] as string[], falhas: [] as any[] };
      for (const item of itens) {
        const alvo = alvoNuvemshop(String(item.externoId || ''));
        if (!alvo) {
          resultado.semMapeamento.push(item.sku);
          continue;
        }
        try {
          await chamar(
            'publicarPreco',
            `/${encodeURIComponent(loja)}/products/${alvo.produto}/variants/${alvo.variante}`,
            { method: 'PUT', body: JSON.stringify({ price: String(item.preco) }) },
            ctx,
            token
          );
          resultado.atualizados.push({ sku: item.sku, externalId: `${alvo.produto}:${alvo.variante}` });
        } catch (e: any) {
          resultado.falhas.push({ sku: item.sku, mensagem: e?.message || 'falha', transitorio: e?.transitorio === true });
        }
      }
      return resultado;
    },

    validarWebhook(corpoBruto, headers, ctx) {
      const segredo = String(deps.clientSecret || process.env.NUVEMSHOP_CLIENT_SECRET || ctx?.credencial?.clientSecret || '').trim();
      const recebida = String(headers['x-linkedstore-hmac-sha256'] || headers['X-Linkedstore-Hmac-Sha256'] || '').trim();
      if (!segredo || !recebida) return false; // sem segredo não se valida: nunca "libera por padrão"
      const esperada = createHmac('sha256', segredo).update(corpoBruto, 'utf8').digest('hex');
      const a = Buffer.from(recebida.toLowerCase());
      const b = Buffer.from(esperada);
      return a.length === b.length && timingSafeEqual(a, b);
    },

    lerWebhook(corpoBruto, headers) {
      const p = JSON.parse(corpoBruto || '{}');
      const recebidoEm = new Date().toISOString();
      const evento = String(headers['x-linkedstore-event'] || p?.event || 'order/updated');
      const id = String(p?.id ?? '');
      return [
        {
          externalId: `${evento}:${id}:${String(p?.updated_at || recebidoEm)}`,
          tipo: evento,
          pedidoExternoId: evento.startsWith('order') ? id : null,
          recebidoEm,
          payload: p,
        },
      ];
    },
  };
}

/** Mapeamento da Nuvemshop é "produto:variante" — sem ele não se escreve nada. */
function alvoNuvemshop(externoId: string): { produto: string; variante: string } | null {
  const bruto = externoId.includes(':') ? externoId.split(':') : [];
  if (bruto.length === 2 && bruto.every((x) => /^\d+$/.test(x))) return { produto: bruto[0], variante: bruto[1] };
  return null;
}
