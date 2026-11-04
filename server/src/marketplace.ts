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
import { empresaDoAtorAudit } from './empresa';
import { checkAccess, getStore } from './services';
import { getResource, RESOURCES } from './resources';
import { currentUser } from './auth';
import { configLoja } from './loja';
import type { Row } from './store';

type MarketplaceConfig = { provider: string; token: string; ativo: boolean };

function getConfig(): { mercadolivre: MarketplaceConfig | null } {
  return {
    mercadolivre: process.env.MERCADOLIVRE_TOKEN ? { provider: 'mercadolivre', token: process.env.MERCADOLIVRE_TOKEN, ativo: true } : null,
  };
}

/**
 * Ordem Final 2.4 — contrato explícito para o token ESTÁTICO de instalação (MERCADOLIVRE_TOKEN).
 * Formato: MERCADOLIVRE_TOKEN_ESTATICO_CONTRATO = "<empresa_id>:<referência do contrato>" (referência ≥ 8 caracteres).
 * Sem contrato válido para a empresa do ator, a rota legada NÃO chama o Mercado Livre.
 * A referência nunca é exibida nem registrada; só o resultado booleano sai.
 */
export function contratoTokenEstaticoMl(empresaId: number): boolean {
  const bruto = String(process.env.MERCADOLIVRE_TOKEN_ESTATICO_CONTRATO || '').trim();
  const m = /^(\d+):([^\s:]{8,})$/.exec(bruto);
  return !!m && Number(m[1]) === Number(empresaId) && Number(empresaId) > 0;
}

/**
 * GET /api/marketplace/status — configuração da instalação (token estático e URL da loja).
 * R-1 (Fase 4.3): é informação administrativa. Só administrador consulta; sem sessão, 401.
 */
export function marketplaceStatus(req: Request, res: Response) {
  const actor = currentUser(req);
  if (!actor) throw new HttpError(401, 'Não autenticado.');
  if (actor.perfil !== 'admin') throw new HttpError(403, 'Apenas administradores consultam o status de marketplace.');
  const cfg = getConfig();
  const loja = configLoja();
  res.json({
    mercadolivre: cfg.mercadolivre ? { configurado: true, ativo: cfg.mercadolivre.ativo, contrato_token_estatico: contratoTokenEstaticoMl(Number(actor.empresa_id)) } : { configurado: false },
    // Loja própria (brobond.com.br): pedidos + estoque são sincronizados pelos
    // endpoints /api/marketplace/loja/* — ver loja.ts.
    loja: loja ? { configurado: true, ativo: true, url: loja.url } : { configurado: false },
  });
}

export async function sincronizarPedidos(req: Request, res: Response) {
  const actor = currentUser(req);
  // R-1 (Fase 4.2): esta rota usa o token ESTÁTICO da instalação (MERCADOLIVRE_TOKEN), que
  // não pertence a nenhuma empresa. Por isso é restrita a administrador com empresa
  // explícita no contexto. Gerente e operador não podem disparar chamadas nem receber
  // pedidos de uma conta que não é da sua empresa. Não remover: a migração para o conector
  // OAuth por empresa (modules/connectors) é o destino (ver docs/auditoria/fase-4-2-correcoes.md).
  checkAccess(RESOURCES.vendas, actor, 'create');
  if (actor?.perfil !== 'admin') throw new HttpError(403, 'Apenas administradores podem usar a sincronização legada de marketplace.');
  if (!(Number(actor.empresa_id) > 0)) throw new HttpError(403, 'Contexto de empresa ausente para a sincronização legada.');
  const cfg = getConfig();
  const provider = String(req.body?.provider || '');
  if (!provider || !cfg.mercadolivre) {
    throw new HttpError(409, 'Nenhum marketplace configurado. Defina MERCADOLIVRE_TOKEN.');
  }

  // Ordem Final 2.4: o token estático da instalação só é usado com contrato válido para ESTA empresa.
  // Bloqueio antes de qualquer chamada externa e com registro de auditoria da tentativa.
  if (provider === 'mercadolivre' && !contratoTokenEstaticoMl(Number(actor.empresa_id))) {
    await getStore().audit({
      usuario_id: actor.id,
      usuario: actor.name,
      acao: 'seguranca',
      recurso: 'marketplace',
      registro_id: null,
      descricao: 'Sincronização legada do Mercado Livre bloqueada: token estático sem contrato válido para a empresa.',
      dados: { provider, motivo: 'contrato_token_estatico_ausente' },
      empresa_id: empresaDoAtorAudit(actor),
    });
    throw new HttpError(409, 'Token estático de instalação sem contrato válido para esta empresa. Rota legada bloqueada até a declaração do contrato.');
  }

  const s = getStore();
  const resultados: Row[] = [];

  // Mercado Livre (Fase 4.3, R-1/item 13): primeiro a identidade real do token (/users/me),
  // depois GET /orders/search?seller=<id>. Sem identidade, nenhuma busca é feita: o literal
  // "seller_id" nunca mais sai para a API.
  if (provider === 'mercadolivre' && cfg.mercadolivre) {
    try {
      // Identidade do token: não depende das credenciais OAuth do conector (rota legada, token estático).
      const idResp = await fetch('https://api.mercadolibre.com/users/me', {
        headers: { 'Authorization': `Bearer ${cfg.mercadolivre.token}` },
      });
      const eu = idResp.ok ? ((await idResp.json()) as { id?: unknown }) : null;
      if (eu?.id === undefined || eu?.id === null || String(eu.id).trim() === '') {
        throw new Error('identidade do vendedor indisponível');
      }
      const resp = await fetch(
        `https://api.mercadolibre.com/orders/search?seller=${encodeURIComponent(String(eu.id))}`,
        { headers: { 'Authorization': `Bearer ${cfg.mercadolivre.token}` } }
      );
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
    empresa_id: empresaDoAtorAudit(actor),
  });

  // R-1 (Fase 4.3): a resposta traz só a contagem. Os identificadores externos dos pedidos
  // ficam fora da resposta: vêm do token estático da instalação, que não pertence à empresa.
  res.json({ provider, sincronizados: resultados.length });
}
