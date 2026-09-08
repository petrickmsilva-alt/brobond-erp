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
// O pedido guarda também o ESTADO do documento (vendas.nfe_status):
// nao_emitida | simulada | emitida | cancelada. Ele é escrito apenas pelos
// endpoints deste módulo — o CRUD de vendas descarta esses campos — para que
// uma simulação de teste jamais apareça como nota emitida.
//
// Configuração (env):
//   NFE_API_KEY=sua-chave       (serviço de NF-e)
//   NFE_MODO=simulacao          (permite só o fluxo de treino, sem valor fiscal)
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
import { round2 } from './utils';

const fmtMoney = round2;


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

/**
 * POST /api/vendas/:id/nfe/emitir — solicita a emissão da NF-e.
 *
 * A emissão fiscal de verdade pertence a um serviço integrado (NFe.io, eNotas,
 * Focus). Este build não fala com nenhum deles, então a regra é não deixar
 * margem para interpretação:
 *   • sem NFE_PROVIDER/NFE_API_KEY  → 409 (nada configurado);
 *   • NFE_MODO=simulacao            → grava nfe_status=\'simulada\' com número
 *     prefixado de SIM-: é treino de fluxo, sem valor fiscal, e é isso que a UI
 *     e a auditoria vão dizer;
 *   • provedor configurado sem NFE_MODO=simulacao → 503. Gravar \'emitida\' aqui
 *     seria inventar um documento fiscal que nunca existiu.
 *
 * A escrita é condicionada ao status lido (tryUpdateIf): dois cliques simultâneos
 * não geram duas notas para o mesmo pedido.
 */
export async function nfeEmitir(req: Request, res: Response) {
  const actor = currentUser(req);
  const r = getResource('vendas')!;
  checkAccess(r, actor, 'update');
  const id = parseId(req.params.id);
  const s = getStore();

  const apiKey = (process.env.NFE_API_KEY || '').trim();
  const provider = (process.env.NFE_PROVIDER || '').trim();
  const modo = (process.env.NFE_MODO || '').trim().toLowerCase();

  if (!apiKey && !provider) {
    throw new HttpError(409, 'Serviço de NF-e não configurado. Defina NFE_PROVIDER e NFE_API_KEY no painel (ou NFE_MODO=simulacao para exercitar o fluxo sem valor fiscal).');
  }
  if (modo !== 'simulacao') {
    throw new HttpError(
      503,
      `A integração com o emissor "${provider || 'NFE_PROVIDER'}" ainda não está implementada neste build. Use NFE_MODO=simulacao para testar o fluxo (sem valor fiscal) ou conecte o emissor antes de emitir.`
    );
  }

  const venda = await s.get(r, id);
  if (!venda) throw new HttpError(404, 'Pedido não encontrado.');
  const statusAtual = venda.nfe_status === null || venda.nfe_status === undefined ? null : String(venda.nfe_status);
  if (statusAtual === 'emitida') throw new HttpError(409, `Este pedido já tem NF-e emitida${venda.nfe_numero ? ` (${venda.nfe_numero})` : ''}.`);
  if (statusAtual === 'simulada') throw new HttpError(409, `Este pedido já tem uma simulação de NF-e (${venda.nfe_numero || 'sem número'}).`);

  const dados = await prepararDadosNFe(id);
  const numero = `SIM-${id}-${Date.now().toString(36).toUpperCase()}`;
  const emitidaEm = new Date().toISOString();

  const gravado = await s.transaction(async (tx) => {
    const row = await s.tryUpdateIf(r, id, { nfe_status: statusAtual }, { nfe_status: 'simulada', nfe_numero: numero, nfe_emitida_em: emitidaEm, nfe_provider: provider }, tx);
    if (!row) return null;
    await s.audit(
      {
        usuario_id: actor.id,
        usuario: actor.name,
        acao: 'editar',
        recurso: 'vendas',
        registro_id: id,
        descricao: `NF-e SIMULADA ${numero} registrada na venda #${id} (provedor ${provider || '-'}, sem valor fiscal)`,
        dados: { acao: 'nfe_simular', provider, numero, simulacao: true },
      },
      tx
    );
    return row;
  });
  if (!gravado) throw new HttpError(409, 'O estado fiscal deste pedido mudou durante a operação. Recarregue e tente de novo.');

  res.json({
    ok: true,
    simulacao: true,
    nfe_status: 'simulada',
    nfe_numero: numero,
    mensagem: `NF-e ${numero} é uma SIMULAÇÃO: não foi transmitida a nenhum emissor e não tem valor fiscal. Configure a integração real (NFE_PROVIDER/NFE_API_KEY) para emitir.`,
    dados,
  });
}

/** GET /api/vendas/:id/nfe/status — status real do documento (inclusive "simulada"). */
export async function nfeStatus(req: Request, res: Response) {
  const actor = currentUser(req);
  const r = getResource('vendas')!;
  checkAccess(r, actor, 'read');
  const id = parseId(req.params.id);
  const s = getStore();

  const venda = await s.get(r, id);
  if (!venda) throw new HttpError(404, 'Pedido não encontrado.');

  const status = String(venda.nfe_status || 'nao_emitida');
  res.json({
    venda_id: id,
    nfe_status: status,
    nfe_numero: venda.nfe_numero || null,
    nfe_emitida_em: venda.nfe_emitida_em || null,
    nfe_provider: venda.nfe_provider || null,
    /** true quando existe um número, mas ele não representa um documento fiscal. */
    simulacao: status === 'simulada',
    configurado: !!(process.env.NFE_API_KEY && process.env.NFE_PROVIDER),
    modo: (process.env.NFE_MODO || '').trim().toLowerCase() || null,
  });
}
