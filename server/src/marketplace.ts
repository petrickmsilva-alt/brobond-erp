// Marketplace (LEGADO) — sincronizacao simples por token de API.
// POST /api/marketplace/sincronizar   — importa pedidos do marketplace
// GET  /api/marketplace/status        — status da integracao
//
// EXPURGO 2026-10-05: o ramo da Shopee saiu junto com o conector nativo
// (decisao da diretoria — barreiras burocraticas da API). O canal de
// marketplace oficial do ERP e o modulo modules/connectors (Mercado
// Livre, Mercado Pago e Nuvemshop, a plataforma-ponte da triangulacao);
// este arquivo permanece apenas pelo endpoint legado por token.
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

function getConfig(): { mercadolivre: MarketplaceConfig | null } {
  return {
    mercadolivre: process.env.MERCADOLIVRE_TOKEN ? { provider: 'mercadolivre', token: process.env.MERCADOLIVRE_TOKEN, ativo: true } : null,
  };
}

export function marketplaceStatus(_req: Request, res: Response) {
  const cfg = getConfig();
  const loja = configLoja();
  res.json({
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
  if (!provider || !cfg.mercadolivre) {
    throw new HttpError(409, 'Nenhum marketplace configurado. Defina MERCADOLIVRE_TOKEN.');
  }

  const s = getStore();
  const resultados: Row[] = [];

  // Simulacao: em producao, chamaria a API do marketplace
  // Mercado Livre: GET https://api.mercadolibre.com/orders/search?seller={seller_id}

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
