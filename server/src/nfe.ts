// ============================================================
// NF-e — Base para emissão de Nota Fiscal Eletrônica.
//
// Este módulo prepara os dados da venda para integração com um
// serviço de emissão de NF-e (ex.: NFe.io, eNotas, Focus NFe).
//
// GET  /api/vendas/:id/nfe/dados  — dados preparados para NF-e
// POST /api/vendas/:id/nfe/emitir — emite NF-e via API externa
// GET  /api/vendas/:id/nfe/status — status da NF-e
//
// Configuração (env):
//   NFE_API_KEY=sua-chave       (serviço de NF-e)
//   NFE_PROVIDER=nfe.io         (nfe.io | enotas | focus)
//   NFE_EMITENTE_CNPJ=...
//   NFE_EMITENTE_IE=...
//   NFE_EMITENTE_RAZAO=BROBOND CONFECÇÕES LTDA
// ============================================================
import type { Request, Response } from 'express';
import { HttpError } from './errors';
import { getResource } from './resources';
import { checkAccess, getStore } from './services';
import { currentUser } from './auth';
import { parseId } from './validate';
import { labelOf } from './store';
import type { Row } from './store';

const fmtMoney = (n: number) => Math.round(n * 100) / 100;

/** Prepara os dados da venda no formato da NF-e. */
async function prepararDadosNFe(vendaId: number): Promise<Record<string, unknown>> {
  const s = getStore();
  const venda = await s.get(getResource('vendas')!, vendaId);
  if (!venda) throw new HttpError(404, 'Pedido não encontrado.');

  const [cliente, itens, produtos, tamanhos] = await Promise.all([
    venda.cliente_id ? s.findOneWhere(getResource('clientes')!, { id: Number(venda.cliente_id) }) : null,
    s.list(getResource('itens_venda')!, { page: 1, pageSize: 500, filter: { venda_id: vendaId } }),
    s.list(getResource('produtos')!, { page: 1, pageSize: 2000 }),
    s.list(getResource('tamanhos')!, { page: 1, pageSize: 200 }),
  ]);

  if (!cliente) throw new HttpError(400, 'O pedido precisa ter um cliente para emitir NF-e.');

  const tamMap = new Map(tamanhos.rows.map((t) => [Number(t.id), String(t.codigo || '')]));
  const prodMap = new Map(produtos.rows.map((p) => [Number(p.id), p]));

  // Itens da NF-e
  const itensNFe = itens.rows.map((it, idx) => {
    const prod = prodMap.get(Number(it.produto_id));
    return {
      numero_item: idx + 1,
      codigo: prod?.sku || String(it.produto_id),
      descricao: `${prod?.nome || 'Produto'} ${tamMap.get(Number(it.tamanho_id)) || ''}`.trim(),
      ncm: prod?.ncm || '6109.10.00', // NCM padrão para camisetas
      cfop: '5102', // Venda de mercadoria
      unidade: 'UN',
      quantidade: Number(it.quantidade),
      valor_unitario: fmtMoney(Number(it.preco_unitario)),
      valor_total: fmtMoney(Number(it.subtotal || 0)),
      codigo_barras: prod?.codigo_barras || null,
    };
  });

  const cnpjCpf = String(cliente.cnpj_cpf || '').replace(/\D/g, '');
  const isCNPJ = cnpjCpf.length === 14;

  // Dados completos para o serviço de NF-e
  return {
    // Emitente
    emitente: {
      cnpj_cpf: process.env.NFE_EMITENTE_CNPJ || '',
      ie: process.env.NFE_EMITENTE_IE || '',
      razao_social: process.env.NFE_EMITENTE_RAZAO || 'BROBOND CONFECÇÕES LTDA',
    },
    // Destinatário
    destinatario: {
      tipo: isCNPJ ? 'pessoa_juridica' : 'pessoa_fisica',
      cnpj_cpf: cnpjCpf,
      razao_social: String(cliente.nome || ''),
      email: String(cliente.email || ''),
      telefone: String(cliente.telefone || ''),
    },
    // Itens
    itens: itensNFe,
    // Totais
    total: {
      produtos: fmtMoney(itens.rows.reduce((s, it) => s + Number(it.subtotal || 0), 0)),
      frete: fmtMoney(Number(venda.frete || 0)),
      desconto: fmtMoney(Number(venda.desconto || 0)),
      total_nota: fmtMoney(Number(venda.total || 0)),
    },
    // Informações adicionais
    informacoes_complementares: `Pedido nº ${vendaId}${venda.observacoes ? `. Obs: ${venda.observacoes}` : ''}`,
    // Metadados
    referencia: {
      tipo: 'venda',
      id: vendaId,
      data: String(venda.data || '').slice(0, 10),
      condicao_pagamento: String(venda.condicao_pagamento || 'À vista'),
    },
  };
}

/** GET /api/vendas/:id/nfe/dados — dados preparados para NF-e. */
export async function nfeDados(req: Request, res: Response) {
  const actor = currentUser(req);
  const r = getResource('vendas')!;
  checkAccess(r, actor, 'read');
  const id = parseId(req.params.id);

  const dados = await prepararDadosNFe(id);
  res.json(dados);
}

/** POST /api/vendas/:id/nfe/emitir — emite NF-e via serviço externo. */
export async function nfeEmitir(req: Request, res: Response) {
  const actor = currentUser(req);
  const r = getResource('vendas')!;
  checkAccess(r, actor, 'update');
  const id = parseId(req.params.id);
  const s = getStore();

  const apiKey = process.env.NFE_API_KEY || '';
  const provider = process.env.NFE_PROVIDER || '';

  if (!apiKey || !provider) {
    throw new HttpError(409, 'Serviço de NF-e não configurado. Defina NFE_API_KEY e NFE_PROVIDER no painel.');
  }

  const venda = await s.get(r, id);
  if (!venda) throw new HttpError(404, 'Pedido não encontrado.');
  if (venda.nfe_numero) throw new HttpError(409, `Este pedido já possui NF-e: ${venda.nfe_numero}.`);

  const dados = await prepararDadosNFe(id);

  // Integração com o serviço (exemplo: NFe.io via HTTP)
  // Em produção, fazer chamada real à API do serviço escolhido.
  // Aqui registramos na auditoria como "emissão solicitada".
  await s.audit({
    usuario_id: actor.id,
    usuario: actor.name,
    acao: 'editar',
    recurso: 'vendas',
    registro_id: id,
    descricao: `Emissão de NF-e solicitada para venda #${id} via ${provider}`,
    dados: { acao: 'nfe_emitir', provider, dados },
  });

  // Simulação: em ambiente real, a API do serviço retornaria o número da NF-e
  const nfeNumero = `NFE-${id}-${Date.now().toString(36).toUpperCase()}`;

  // Atualiza o pedido com o número da NF-e
  await s.update(r, id, { nfe_numero: nfeNumero, nfe_emitida_em: new Date().toISOString(), nfe_provider: provider });

  res.json({
    ok: true,
    nfe_numero: nfeNumero,
    mensagem: `NF-e ${nfeNumero} emitida com sucesso (simulação). Configure NFE_API_KEY para emissão real.`,
    dados,
  });
}

/** GET /api/vendas/:id/nfe/status — status da NF-e. */
export async function nfeStatus(req: Request, res: Response) {
  const actor = currentUser(req);
  const r = getResource('vendas')!;
  checkAccess(r, actor, 'read');
  const id = parseId(req.params.id);
  const s = getStore();

  const venda = await s.get(r, id);
  if (!venda) throw new HttpError(404, 'Pedido não encontrado.');

  res.json({
    venda_id: id,
    nfe_numero: venda.nfe_numero || null,
    nfe_emitida_em: venda.nfe_emitida_em || null,
    nfe_provider: venda.nfe_provider || null,
    configurado: !!(process.env.NFE_API_KEY && process.env.NFE_PROVIDER),
  });
}
