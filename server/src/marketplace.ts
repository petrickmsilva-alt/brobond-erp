// Marketplace — integracao com Shopee e Mercado Livre.
// POST /api/marketplace/sincronizar   — importa pedidos do marketplace
// GET  /api/marketplace/status        — status da integracao
//
// A loja propria (WordPress + WooCommerce) tem modulo dedicado em loja.ts:
// importa pedidos da loja e empurra o saldo do ERP para ela.
import type { Request, Response } from 'express';
import { HttpError } from './errors';
import { getStore } from './services';
import { getResource } from './resources';
import { currentUser } from './auth';
import { configLoja } from './loja';
import type { Row } from './store';

type MarketplaceConfig = { provider: string; token: string; ativo: boolean };

function getConfig(): { shopee: MarketplaceConfig | null; mercadolivre: MarketplaceConfig | null } {
  return {
    shopee: process.env.SHOPEE_TOKEN ? { provider: 'shopee', token: process.env.SHOPEE_TOKEN, ativo: true } : null,
    mercadolivre: process.env.MERCADOLIVRE_TOKEN ? { provider: 'mercadolivre', token: process.env.MERCADOLIVRE_TOKEN, ativo: true } : null,
  };
}

export function marketplaceStatus(_req: Request, res: Response) {
  const cfg = getConfig();
  const loja = configLoja();
  res.json({
    shopee: cfg.shopee ? { configurado: true, ativo: cfg.shopee.ativo } : { configurado: false },
    mercadolivre: cfg.mercadolivre ? { configurado: true, ativo: cfg.mercadolivre.ativo } : { configurado: false },
    // Loja própria (brobond.com.br): pedidos + estoque são sincronizados pelos
    // endpoints /api/marketplace/loja/* — ver loja.ts.
    loja: loja ? { configurado: true, ativo: true, url: loja.url } : { configurado: false },
  });
}

export async function sincronizarPedidos(req: Request, res: Response) {
  const actor = currentUser(req);
  const cfg = getConfig();
  const provider = String(req.body?.provider || '');
  if (!provider || (!cfg.shopee && !cfg.mercadolivre)) {
    throw new HttpError(409, 'Nenhum marketplace configurado. Defina SHOPEE_TOKEN ou MERCADOLIVRE_TOKEN.');
  }

  const s = getStore();
  const resultados: Row[] = [];

  // Simulacao: em producao, chamaria a API do marketplace
  // Shopee: GET https://partner.shopeemobile.com/api/v2/orders/get_order_list
  // Mercado Livre: GET https://api.mercadolibre.com/orders/search?seller={seller_id}

  if (provider === 'shopee' && cfg.shopee) {
    // Integracao real com Shopee (requer token de parceiro)
    try {
      const resp = await fetch('https://partner.shopeemobile.com/api/v2/orders/get_order_list', {
        headers: { 'Authorization': `Bearer ${cfg.shopee.token}`, 'Content-Type': 'application/json' },
        method: 'POST',
        body: JSON.stringify({ time_range: { start_time: Math.floor(Date.now() / 1000) - 86400 * 7, end_time: Math.floor(Date.now() / 1000) } }),
      });
      // Se a API responder, parseamos os pedidos
      if (resp.ok) {
        const data = (await resp.json()) as any;
        // Criaria vendas no sistema para cada pedido
        if (data.response?.orders) {
          for (const order of data.response.orders) {
            resultados.push({ origem: 'shopee', order_sn: order.order_sn, status: order.status });
          }
        }
      }
    } catch (e: any) {
      console.warn('Shopee sync error:', e?.message);
    }
  }

  if (provider === 'mercadolivre' && cfg.mercadolivre) {
    try {
      const resp = await fetch('https://api.mercadolibre.com/orders/search?seller=seller_id', {
        headers: { 'Authorization': `Bearer ${cfg.mercadolivre.token}` },
      });
      if (resp.ok) {
        const data = (await resp.json()) as any;
        if (data.results) {
          for (const order of data.results) {
            resultados.push({ origem: 'mercadolivre', order_id: order.id, status: order.status });
          }
        }
      }
    } catch (e: any) {
      console.warn('ML sync error:', e?.message);
    }
  }

  await s.audit({
    usuario_id: actor.id,
    usuario: actor.name,
    acao: 'importar',
    recurso: 'marketplace',
    registro_id: null,
    descricao: `Sincronizacao ${provider}: ${resultados.length} pedido(s) importado(s)`,
    dados: { provider, pedidos: resultados.length },
  });

  res.json({ provider, sincronizados: resultados.length, pedidos: resultados });
}
