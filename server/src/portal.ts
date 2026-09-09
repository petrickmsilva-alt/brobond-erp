import type { Request, Response } from 'express';
import { createHash, randomBytes } from 'node:crypto';
import { HttpError } from './errors';
import { RESOURCES } from './resources';
import { getStore } from './services';
import { labelOf, type Row } from './store';
import { attachImages } from './uploads';

const RATE_LIMIT = 60;
const JANELA_MS = 10 * 60 * 1000;
const ips = new Map<string, { count: number; desde: number }>();

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

export function hashDocumento(documento: string): string {
  return createHash('sha256').update(documento.replace(/\D/g, '')).digest('hex').slice(0, 32);
}
export function hashPortalToken(token: string): string { return createHash('sha256').update(token).digest('hex'); }

export async function criarAcessoPortal(clienteId: number, baseUrl: string, validadeDias = 90) {
  const token = randomBytes(32).toString('hex');
  const expira_em = new Date(Date.now() + Math.min(365, Math.max(1, validadeDias)) * 86400000).toISOString();
  await getStore().insert(RESOURCES.portal_acessos, { cliente_id: clienteId, token_hash: hashPortalToken(token), expira_em, acessos: 0 });
  return { token, url: `${baseUrl.replace(/\/$/, '')}/portal/${token}`, expira_em };
}

async function autenticar(token: string): Promise<{ cliente: Row; acesso: Row | null }> {
  if (!/^[a-f0-9]{16,128}$/i.test(token)) throw new HttpError(404, 'Link inválido.');
  const s = getStore();
  const acesso = await s.findOneWhere(RESOURCES.portal_acessos, { token_hash: hashPortalToken(token) });
  if (acesso) {
    if (acesso.revogado_em || (acesso.expira_em && new Date(String(acesso.expira_em)).getTime() < Date.now())) throw new HttpError(410, 'Este acesso expirou ou foi revogado. Solicite um novo link.');
    const cliente = await s.get(RESOURCES.clientes, Number(acesso.cliente_id));
    if (!cliente || cliente.ativo === false) throw new HttpError(404, 'Cliente não encontrado.');
    await s.update(RESOURCES.portal_acessos, Number(acesso.id), { ultimo_acesso_em: new Date().toISOString(), acessos: Number(acesso.acessos || 0) + 1 });
    return { cliente, acesso };
  }
  throw new HttpError(404, 'Acesso não encontrado. Solicite um novo link seguro.');
}

const statusLabels: Record<string, string> = { cotacao: 'Aguardando sua decisão', aberta: 'Confirmado', pendente_aprovacao: 'Em aprovação', faturada: 'Enviado', entregue: 'Entregue', cancelada: 'Cancelado' };

export async function portalPedidos(req: Request, res: Response) {
  const { cliente, acesso } = await autenticar(String(req.params.token || ''));
  const vendas = await getStore().list(RESOURCES.vendas, { page: 1, pageSize: 200, sort: 'data', dir: 'desc', filter: { cliente_id: Number(cliente.id) } });
  const pedidos = vendas.rows.map((v) => ({ id: Number(v.id), data: String(v.data || '').slice(0, 10), status: String(v.status), status_label: statusLabels[String(v.status)] || v.status, total: Number(v.total || 0), previsao_entrega: v.previsao_entrega ? String(v.previsao_entrega).slice(0, 10) : null, faturada_em: v.faturada_em || null, condicao_pagamento: v.condicao_pagamento || null }));
  res.json({ cliente: { id: Number(cliente.id), nome: cliente.nome, email: cliente.email || null }, acesso_seguro: !!acesso, total_pedidos: pedidos.length, pedidos });
}

export async function portalPedidoDetalhe(req: Request, res: Response) {
  const { cliente } = await autenticar(String(req.params.token || ''));
  const pedidoId = Number(req.params.id);
  if (!Number.isInteger(pedidoId) || pedidoId <= 0) throw new HttpError(400, 'ID inválido.');
  const s = getStore();
  const venda = await s.get(RESOURCES.vendas, pedidoId);
  if (!venda || Number(venda.cliente_id) !== Number(cliente.id)) throw new HttpError(404, 'Pedido não encontrado.');
  const [itens, produtos, tamanhos, decisoes] = await Promise.all([
    s.list(RESOURCES.itens_venda, { page: 1, pageSize: 500, filter: { venda_id: pedidoId } }),
    s.list(RESOURCES.produtos, { page: 1, pageSize: 2000 }), s.list(RESOURCES.tamanhos, { page: 1, pageSize: 200 }),
    s.list(RESOURCES.cotacao_decisoes, { page: 1, pageSize: 100, filter: { venda_id: pedidoId }, sort: 'criado_em', dir: 'desc' }),
  ]);
  await attachImages(RESOURCES.produtos, produtos.rows);
  const tam = new Map(tamanhos.rows.map((t) => [Number(t.id), String(t.codigo || '')]));
  const prod = new Map(produtos.rows.map((p) => [Number(p.id), p]));
  const linhas = itens.rows.map((it) => { const p = prod.get(Number(it.produto_id)); return { produto_id: Number(it.produto_id), produto: p ? labelOf(RESOURCES.produtos, p) : `#${it.produto_id}`, sku: p?.sku || '', tamanho_id: Number(it.tamanho_id), tamanho: tam.get(Number(it.tamanho_id)) || '', quantidade: Number(it.quantidade || 0), preco_unitario: Number(it.preco_unitario || 0), desconto_pct: Number(it.desconto_pct || 0), subtotal: Number(it.subtotal || 0), foto: p?.foto_url || null }; });
  res.json({ id: pedidoId, data: String(venda.data || '').slice(0, 10), status: String(venda.status), status_label: statusLabels[String(venda.status)] || venda.status, total: Number(venda.total || 0), frete: Number(venda.frete || 0), desconto: Number(venda.desconto || 0), previsao_entrega: venda.previsao_entrega || null, condicao_pagamento: venda.condicao_pagamento || null, observacoes: venda.observacoes || null, pode_decidir: venda.status === 'cotacao', itens: linhas, decisoes: decisoes.rows.map((d) => ({ decisao: d.decisao, responsavel: d.responsavel, mensagem: d.mensagem, criado_em: d.criado_em })) });
}

export async function decidirCotacao(req: Request, res: Response) {
  const { cliente } = await autenticar(String(req.params.token || ''));
  const id = Number(req.params.id); const decisao = String(req.body?.decisao || '');
  const responsavel = String(req.body?.responsavel || '').trim(); const mensagem = String(req.body?.mensagem || '').trim().slice(0, 2000);
  if (!['aceitar','recusar','alteracao'].includes(decisao)) throw new HttpError(400, 'Decisão inválida.');
  if (responsavel.length < 2) throw new HttpError(400, 'Informe o nome do responsável pelo aceite.');
  if (decisao !== 'aceitar' && !mensagem) throw new HttpError(400, 'Informe uma justificativa ou a alteração desejada.');
  const s = getStore();
  await s.transaction(async (tx) => {
    const venda = await s.get(RESOURCES.vendas, id, tx);
    if (!venda || Number(venda.cliente_id) !== Number(cliente.id)) throw new HttpError(404, 'Cotação não encontrada.');
    if (venda.status !== 'cotacao') throw new HttpError(409, 'Esta cotação já foi respondida ou não está mais disponível.');
    const itens = await s.list(RESOURCES.itens_venda, { page: 1, pageSize: 500, filter: { venda_id: id } }, tx);
    const proposta_hash = createHash('sha256').update(JSON.stringify({ venda: { id, total: venda.total, frete: venda.frete, desconto: venda.desconto }, itens: itens.rows.map((i) => ({ produto_id: i.produto_id, tamanho_id: i.tamanho_id, quantidade: i.quantidade, preco_unitario: i.preco_unitario, subtotal: i.subtotal })) })).digest('hex');
    await s.insert(RESOURCES.cotacao_decisoes, { venda_id: id, cliente_id: Number(cliente.id), decisao, responsavel, mensagem: mensagem || null, proposta_hash, ip: String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim(), user_agent: String(req.headers['user-agent'] || '').slice(0, 500) }, tx);
    const status = decisao === 'aceitar' ? 'aberta' : decisao === 'recusar' ? 'cancelada' : 'cotacao';
    await s.update(RESOURCES.vendas, id, { status, observacoes: [venda.observacoes, `[Portal: ${responsavel} — ${decisao}${mensagem ? `: ${mensagem}` : ''}]`].filter(Boolean).join('\n') }, tx);
    await s.audit({ usuario_id: null, usuario: `Portal — ${responsavel}`, acao: 'editar', recurso: 'vendas', registro_id: id, descricao: `Cotação #${id}: cliente decidiu ${decisao}`, dados: { decisao, proposta_hash } }, tx);
  });
  res.json({ ok: true, mensagem: decisao === 'aceitar' ? 'Cotação aceita e pedido confirmado.' : decisao === 'recusar' ? 'Cotação recusada.' : 'Solicitação de alteração enviada.' });
}
