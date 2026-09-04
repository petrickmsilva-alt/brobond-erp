// ============================================================
// Portal do Cliente — o cliente final acompanha seus pedidos online.
//
// GET /api/portal/:token/pedidos  — lista pedidos do cliente (por CPF/CNPJ)
// GET /api/portal/:token/pedido/:id — detalhe de um pedido
//
// O "token" aqui é o CPF/CNPJ do cliente (hash SHA-256 para segurança).
// O link é gerado pelo sistema: /portal/<hash-do-cpf>
// ============================================================
import type { Request, Response } from 'express';
import { createHash } from 'node:crypto';
import { HttpError } from './errors';
import { getResource } from './resources';
import { getStore } from './services';
import { labelOf } from './store';
import { attachImages } from './uploads';

const RATE_LIMIT = 60; // requests por janela
const JANELA_MS = 10 * 60 * 1000;
const ips = new Map<string, { count: number; desde: number }>();

/** Rate limit para o portal público. */
export function rateLimitPortal(req: Request, res: Response, next: () => void) {
  const ip = String(req.headers['x-forwarded-for']?.toString().split(',')[0]?.trim() || req.socket.remoteAddress || '?');
  const agora = Date.now();
  let b = ips.get(ip);
  if (!b || agora - b.desde > JANELA_MS) b = { count: 0, desde: agora };
  b.count++;
  if (b.count > RATE_LIMIT) {
    res.setHeader('Retry-After', String(Math.ceil((JANELA_MS - (agora - b.desde)) / 1000)));
    return res.status(429).json({ error: 'Muitas solicitações. Tente novamente em alguns minutos.' });
  }
  ips.set(ip, b);
  if (ips.size > 5000) for (const [k, v] of ips) if (agora - v.desde > JANELA_MS) ips.delete(k);
  next();
}

/** Gera o hash do CPF/CNPJ para o link do portal. */
export function hashDocumento(documento: string): string {
  const limpo = documento.replace(/\D/g, '');
  return createHash('sha256').update(limpo).digest('hex').slice(0, 32);
}

/** GET /api/portal/:token/pedidos — lista pedidos do cliente. */
export async function portalPedidos(req: Request, res: Response) {
  const token = String(req.params.token || '').trim();
  if (!token || token.length < 16) throw new HttpError(404, 'Link inválido.');

  const s = getStore();

  // Busca clientes cujo hash do documento bate com o token
  const clientes = await s.list(getResource('clientes')!, { page: 1, pageSize: 2000 });
  let clienteId: number | null = null;
  let clienteNome = '';

  for (const c of clientes.rows) {
    const doc = String(c.cnpj_cpf || '').replace(/\D/g, '');
    if (doc && hashDocumento(doc) === token) {
      clienteId = Number(c.id);
      clienteNome = String(c.nome);
      break;
    }
  }

  if (!clienteId) throw new HttpError(404, 'Cliente não encontrado. Verifique o link.');

  // Busca pedidos do cliente (vendas)
  const vendas = await s.list(getResource('vendas')!, {
    page: 1,
    pageSize: 100,
    sort: 'data',
    dir: 'desc',
    filter: { cliente_id: clienteId },
  });

  const statusLabels: Record<string, string> = {
    aberta: 'Em preparação',
    faturada: 'Enviado',
    entregue: 'Entregue',
    cancelada: 'Cancelado',
    pendente_aprovacao: 'Em aprovação',
  };

  const pedidos = vendas.rows.map((v) => ({
    id: Number(v.id),
    data: String(v.data || '').slice(0, 10),
    status: String(v.status),
    status_label: statusLabels[String(v.status)] || v.status,
    total: Number(v.total || 0),
    previsao_entrega: v.previsao_entrega ? String(v.previsao_entrega).slice(0, 10) : null,
    faturada_em: v.faturada_em ? String(v.faturada_em).slice(0, 10) : null,
    condicao_pagamento: v.condicao_pagamento || null,
    observacoes: v.observacoes || null,
  }));

  res.json({
    cliente: clienteNome,
    total_pedidos: pedidos.length,
    pedidos,
  });
}

/** GET /api/portal/:token/pedido/:id — detalhe de um pedido. */
export async function portalPedidoDetalhe(req: Request, res: Response) {
  const token = String(req.params.token || '').trim();
  if (!token || token.length < 16) throw new HttpError(404, 'Link inválido.');
  const pedidoId = Number(req.params.id);
  if (!Number.isInteger(pedidoId) || pedidoId <= 0) throw new HttpError(400, 'ID inválido.');

  const s = getStore();

  // Autentica o cliente
  const clientes = await s.list(getResource('clientes')!, { page: 1, pageSize: 2000 });
  let clienteId: number | null = null;
  for (const c of clientes.rows) {
    const doc = String(c.cnpj_cpf || '').replace(/\D/g, '');
    if (doc && hashDocumento(doc) === token) {
      clienteId = Number(c.id);
      break;
    }
  }
  if (!clienteId) throw new HttpError(404, 'Cliente não encontrado.');

  // Busca o pedido
  const venda = await s.get(getResource('vendas')!, pedidoId);
  if (!venda || Number(venda.cliente_id) !== clienteId) {
    throw new HttpError(404, 'Pedido não encontrado.');
  }

  // Busca itens
  const itens = await s.list(getResource('itens_venda')!, { page: 1, pageSize: 500, filter: { venda_id: pedidoId } });
  const produtos = await s.list(getResource('produtos')!, { page: 1, pageSize: 2000 });
  const tamanhos = await s.list(getResource('tamanhos')!, { page: 1, pageSize: 200 });
  await attachImages(getResource('produtos')!, produtos.rows);

  const tamMap = new Map(tamanhos.rows.map((t) => [Number(t.id), String(t.codigo || '')]));
  const prodMap = new Map(produtos.rows.map((p) => [Number(p.id), p]));

  const itensDetalhe = itens.rows.map((it) => {
    const prod = prodMap.get(Number(it.produto_id));
    return {
      produto: prod ? labelOf(getResource('produtos')!, prod) : `#${it.produto_id}`,
      sku: prod?.sku || '',
      tamanho: tamMap.get(Number(it.tamanho_id)) || '',
      quantidade: Number(it.quantidade || 0),
      preco_unitario: Number(it.preco_unitario || 0),
      desconto_pct: Number(it.desconto_pct || 0),
      subtotal: Number(it.subtotal || 0),
      foto: prod?.foto_url || null,
    };
  });

  const statusLabels: Record<string, string> = {
    aberta: 'Em preparação',
    faturada: 'Enviado',
    entregue: 'Entregue',
    cancelada: 'Cancelado',
  };

  res.json({
    id: pedidoId,
    data: String(venda.data || '').slice(0, 10),
    status: String(venda.status),
    status_label: statusLabels[String(venda.status)] || venda.status,
    total: Number(venda.total || 0),
    frete: Number(venda.frete || 0),
    desconto: Number(venda.desconto || 0),
    previsao_entrega: venda.previsao_entrega ? String(venda.previsao_entrega).slice(0, 10) : null,
    condicao_pagamento: venda.condicao_pagamento || null,
    observacoes: venda.observacoes || null,
    itens: itensDetalhe,
  });
}
