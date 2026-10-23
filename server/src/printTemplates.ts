// ============================================================================
// printTemplates.ts — Construtores canônicos de PrintIR no servidor (P2 + P3).
//
// REGRA DE OURO: O backend é a ÚNICA autoridade sobre dados impressos.
// Nenhum construtor aqui aceita preços, totais, descontos, impostos, cliente ou
// itens vindos do navegador — tudo é reconstruído do banco e filtrado por
// `escopo.empresaId`. Campos ausentes no banco são omitidos com elegância,
// jamais inventados.
// ============================================================================
import type { PrintBlock, PrintDocType, PrintSource } from '../../packages/domain/src/print/print-ir';
import type { AuthUser } from './auth';
import { formatarDocumento, formatarTelefone } from './documentos';
import { assertRegistroDaEmpresa, type EscopoEmpresa } from './empresa';
import { HttpError } from './errors';
import { getResource, RESOURCES } from './resources';
import { getStore } from './services';
import type { Row, Tx } from './store';

export type DocumentoConstruido = {
  docType: PrintDocType;
  source: PrintSource;
  sourceRef: string;
  related: { type: string; id: string };
  blocks: PrintBlock[];
  metadata: Record<string, unknown>;
  caixaNumero?: string | null;
  titulo: string;
};

const round2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;

export function moedaBrl(v: unknown): string {
  const n = Number(v) || 0;
  return `R$ ${n.toFixed(2).replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, '.')}`;
}

export function numCompacto(v: unknown): string {
  const n = Number(v) || 0;
  return Number.isInteger(n) ? String(n) : n.toFixed(2).replace('.', ',');
}

function dataHoraLegivel(raw: unknown): string {
  if (!raw) return '';
  const s = String(raw);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const [a, m, d] = s.split('-');
    return `${d}/${m}/${a}`;
  }
  const dt = new Date(s);
  if (Number.isNaN(dt.getTime())) return s;
  const pad = (x: number) => String(x).padStart(2, '0');
  return `${pad(dt.getDate())}/${pad(dt.getMonth() + 1)}/${dt.getFullYear()} ${pad(dt.getHours())}:${pad(dt.getMinutes())}`;
}

function enderecoLinha(row: Row | null | undefined): string | null {
  if (!row) return null;
  const p1 = [row.logradouro, row.numero, row.complemento].map((v) => String(v ?? '').trim()).filter(Boolean).join(', ');
  const p2 = [row.bairro, [row.cidade, row.uf].filter(Boolean).join('/'), row.cep ? `CEP ${row.cep}` : '']
    .map((v) => String(v ?? '').trim())
    .filter(Boolean)
    .join(' - ');
  const full = [p1, p2].filter(Boolean).join(' — ');
  return full || null;
}

const ROTULO_PAGAMENTO: Record<string, string> = {
  dinheiro: 'Dinheiro',
  pix: 'PIX',
  cartao_credito: 'Cartão de Crédito',
  cartao_debito: 'Cartão de Débito',
  boleto: 'Boleto',
  transferencia: 'Transferência',
  vale: 'Vale / Crédito',
  outros: 'Outros',
};

function rotuloFormaPagamento(forma: unknown, parcelas?: unknown, bandeira?: unknown): string {
  const base = ROTULO_PAGAMENTO[String(forma ?? '').toLowerCase()] || String(forma || 'Pagamento');
  const parc = Number(parcelas || 1);
  const band = String(bandeira ?? '').trim();
  const sufixos = [band, parc > 1 ? `${parc}x` : ''].filter(Boolean).join(' ');
  return sufixos ? `${base} (${sufixos})` : base;
}

async function cabecalhoEmpresaBlocks(empresaId: number, tx?: Tx): Promise<{ empresa: Row | null; blocks: PrintBlock[] }> {
  const s = getStore();
  const empresa = await s.get(RESOURCES.empresas, empresaId, tx);
  const blocks: PrintBlock[] = [];
  const nomePrincipal = String(empresa?.nome_fantasia || empresa?.razao_social || empresa?.nome || 'Empresa').trim();
  blocks.push({ kind: 'text', text: nomePrincipal, align: 'center', emphasis: 'title', size: 'large' });

  const razao = String(empresa?.razao_social ?? '').trim();
  if (razao && razao.toLowerCase() !== nomePrincipal.toLowerCase()) {
    blocks.push({ kind: 'text', text: razao, align: 'center', size: 'small' });
  }

  const docFiscal: string[] = [];
  if (empresa?.cnpj) docFiscal.push(`CNPJ: ${formatarDocumento(String(empresa.cnpj))}`);
  if (empresa?.ie) docFiscal.push(`IE: ${String(empresa.ie).trim()}`);
  if (docFiscal.length) {
    blocks.push({ kind: 'text', text: docFiscal.join(' · '), align: 'center', size: 'small' });
  }

  const end = enderecoLinha(empresa);
  if (end) {
    blocks.push({ kind: 'text', text: end, align: 'center', size: 'small' });
  }

  const contato: string[] = [];
  if (empresa?.telefone) contato.push(`Tel: ${formatarTelefone(String(empresa.telefone))}`);
  if (empresa?.email) contato.push(String(empresa.email).trim());
  if (contato.length) {
    blocks.push({ kind: 'text', text: contato.join(' · '), align: 'center', size: 'small' });
  }

  return { empresa, blocks };
}

// ============================================================================
// P2 — Cupom Térmico Canônico do PDV (venda -> PrintIR docType='recibo_pdv')
// ============================================================================
export async function construirCupomPdvPrintIR(
  vendaId: number,
  escopo: EscopoEmpresa,
  opts: { tx?: Tx } = {}
): Promise<DocumentoConstruido> {
  const s = getStore();
  const tx = opts.tx;
  const rVendas = getResource('vendas')!;
  const venda = await s.findOneWhere(rVendas, { id: vendaId, empresa_id: escopo.empresaId }, tx);
  if (!venda) throw new HttpError(404, 'Venda não encontrada.');
  assertRegistroDaEmpresa(rVendas, venda, escopo);

  const [{ blocks: empBlocks }, itensRes, pagsRes, docsFiscaisRes] = await Promise.all([
    cabecalhoEmpresaBlocks(escopo.empresaId, tx),
    s.list(getResource('itens_venda')!, { page: 1, pageSize: 500, filter: { venda_id: vendaId, empresa_id: escopo.empresaId } }, tx),
    s.list(getResource('pdv_pagamentos')!, { page: 1, pageSize: 50, filter: { venda_id: vendaId, empresa_id: escopo.empresaId } }, tx),
    s.list(getResource('documentos_fiscais')!, { page: 1, pageSize: 10, filter: { venda_id: vendaId, empresa_id: escopo.empresaId } }, tx),
  ]);

  const caixa = venda.pdv_caixa_id
    ? await s.findOneWhere(getResource('pdv_caixas')!, { id: Number(venda.pdv_caixa_id), empresa_id: escopo.empresaId }, tx)
    : null;
  const operadorId = venda.pdv_operador_id ?? caixa?.usuario_id ?? null;
  const operador = operadorId
    ? await s.findOneWhere(getResource('usuarios')!, { id: Number(operadorId) }, tx)
    : null;
  const cliente = venda.cliente_id
    ? await s.findOneWhere(getResource('clientes')!, { id: Number(venda.cliente_id), empresa_id: escopo.empresaId }, tx)
    : null;

  // Mapas de produtos e tamanhos dos itens
  const prodIds = [...new Set(itensRes.rows.map((i) => Number(i.produto_id)).filter(Boolean))];
  const tamIds = [...new Set(itensRes.rows.map((i) => Number(i.tamanho_id)).filter(Boolean))];
  const prodMap = new Map<number, Row>();
  for (const pid of prodIds) {
    const p = await s.findOneWhere(getResource('produtos')!, { id: pid, empresa_id: escopo.empresaId }, tx);
    if (p) prodMap.set(pid, p);
  }
  const tamMap = new Map<number, Row>();
  for (const tid of tamIds) {
    const t = await s.get(getResource('tamanhos')!, tid, tx);
    if (t) tamMap.set(tid, t);
  }

  const blocks: PrintBlock[] = [...empBlocks, { kind: 'separator' }];

  const nfceAutorizada = docsFiscaisRes.rows.find((d) => String(d.status) === 'autorizada' && String(d.modelo) === '65');
  if (nfceAutorizada) {
    blocks.push({
      kind: 'text',
      text: `DANFE NFC-e — Nº ${nfceAutorizada.numero || venda.id} Série ${nfceAutorizada.serie || '1'}`,
      align: 'center',
      emphasis: 'bold',
    });
  } else {
    blocks.push({ kind: 'text', text: `CUPOM DE VENDA #${venda.id}`, align: 'center', emphasis: 'bold' });
    blocks.push({ kind: 'text', text: 'COMPROVANTE NÃO FISCAL', align: 'center', size: 'small' });
  }

  const dataStr = dataHoraLegivel(venda.criado_em || venda.data);
  if (dataStr) blocks.push({ kind: 'kv', label: 'Data/Hora', value: dataStr });
  if (caixa?.numero) blocks.push({ kind: 'kv', label: 'Caixa / Terminal', value: String(caixa.numero) });
  if (operador?.nome) blocks.push({ kind: 'kv', label: 'Operador', value: String(operador.nome) });
  if (venda.local_saida) blocks.push({ kind: 'kv', label: 'Local', value: String(venda.local_saida) });

  // Cliente — omite silenciosamente se for o consumidor padrão anônimo sem CPF
  if (cliente) {
    const nomeCli = String(cliente.nome || '').trim();
    const docCli = cliente.cnpj_cpf ? formatarDocumento(String(cliente.cnpj_cpf)) : '';
    const ehConsumidorAnonimo = /^consumidor final(\s*\(pdv\))?$/i.test(nomeCli) && !docCli;
    if (!ehConsumidorAnonimo && nomeCli) {
      blocks.push({ kind: 'kv', label: 'Cliente', value: nomeCli });
      if (docCli) blocks.push({ kind: 'kv', label: 'CPF/CNPJ', value: docCli });
    }
  }

  blocks.push({ kind: 'separator' });

  // Tabela de itens com cálculo autoritativo de bruto e descontos de item
  let totalBrutoItens = 0;
  let subtotalLiquidoItens = 0;
  let temDescontoItem = false;

  const linhasTabela: string[][] = [];
  for (const item of itensRes.rows) {
    const prod = prodMap.get(Number(item.produto_id));
    const tam = item.tamanho_id ? tamMap.get(Number(item.tamanho_id)) : null;
    const sku = prod?.sku ? String(prod.sku).trim() : `#${item.produto_id}`;
    const nomeProd = prod?.nome ? String(prod.nome).trim() : `Produto #${item.produto_id}`;
    const sufixoTam = tam?.codigo ? ` (${String(tam.codigo)})` : '';
    const descItem = `${sku} ${nomeProd}${sufixoTam}`.trim();

    const qtd = Number(item.quantidade || 0);
    const unit = round2(Number(item.preco_unitario || 0));
    const descPct = round2(Number(item.desconto_pct || 0));
    const brutoLinha = round2(qtd * unit);
    const liquidoLinha = item.subtotal != null ? round2(Number(item.subtotal)) : round2(brutoLinha * (1 - descPct / 100));
    const valorDescLinha = round2(Math.max(0, brutoLinha - liquidoLinha));

    totalBrutoItens = round2(totalBrutoItens + brutoLinha);
    subtotalLiquidoItens = round2(subtotalLiquidoItens + liquidoLinha);
    if (valorDescLinha > 0.009) temDescontoItem = true;

    linhasTabela.push([
      descItem,
      numCompacto(qtd),
      unit.toFixed(2).replace('.', ','),
      valorDescLinha > 0.009 ? `-${valorDescLinha.toFixed(2).replace('.', ',')}` : '-',
      liquidoLinha.toFixed(2).replace('.', ','),
    ]);
  }

  if (linhasTabela.length > 0) {
    const colunas = temDescontoItem
      ? [
          { header: 'Item', align: 'left' as const },
          { header: 'Qtd', align: 'right' as const },
          { header: 'Unit', align: 'right' as const },
          { header: 'Desc', align: 'right' as const },
          { header: 'Total', align: 'right' as const },
        ]
      : [
          { header: 'Item', align: 'left' as const },
          { header: 'Qtd', align: 'right' as const },
          { header: 'Unit', align: 'right' as const },
          { header: 'Total', align: 'right' as const },
        ];
    const rows = temDescontoItem ? linhasTabela : linhasTabela.map(([it, q, u, _d, tot]) => [it, q, u, tot]);
    blocks.push({ kind: 'table', columns: colunas, rows });
  }

  blocks.push({ kind: 'separator' });

  const descontoItensTotal = round2(Math.max(0, totalBrutoItens - subtotalLiquidoItens));
  const descontoCupom = round2(Number(venda.desconto || 0));
  const frete = round2(Number(venda.frete || 0));
  const totalLiquido = round2(Number(venda.total ?? Math.max(0, subtotalLiquidoItens - descontoCupom + frete)));
  const descontoTotalGeral = round2(descontoItensTotal + descontoCupom);

  blocks.push({ kind: 'kv', label: 'Total bruto', value: moedaBrl(totalBrutoItens) });
  if (descontoItensTotal > 0.009) {
    blocks.push({ kind: 'kv', label: 'Desconto nos itens', value: `- ${moedaBrl(descontoItensTotal)}` });
  }
  if (descontoCupom > 0.009) {
    blocks.push({ kind: 'kv', label: 'Desconto no cupom', value: `- ${moedaBrl(descontoCupom)}` });
  }
  if (descontoTotalGeral > 0.009 && descontoItensTotal > 0.009 && descontoCupom > 0.009) {
    blocks.push({ kind: 'kv', label: 'Desconto total', value: `- ${moedaBrl(descontoTotalGeral)}` });
  }
  if (frete > 0.009) {
    blocks.push({ kind: 'kv', label: 'Frete / Entrega', value: moedaBrl(frete) });
  }
  blocks.push({ kind: 'text', text: `TOTAL A PAGAR: ${moedaBrl(totalLiquido)}`, align: 'right', emphasis: 'bold', size: 'large' });

  // Formas de pagamento, valor recebido e troco
  blocks.push({ kind: 'separator' });
  blocks.push({ kind: 'text', text: 'PAGAMENTO', emphasis: 'bold' });

  let somaInformadaPagamentos = 0;
  if (pagsRes.rows.length > 0) {
    for (const p of pagsRes.rows) {
      const valExibido = round2(Number(p.valor_informado ?? p.valor ?? 0));
      somaInformadaPagamentos = round2(somaInformadaPagamentos + valExibido);
      blocks.push({
        kind: 'kv',
        label: rotuloFormaPagamento(p.forma, p.parcelas, p.bandeira),
        value: moedaBrl(valExibido),
      });
    }
  } else if (venda.fin_forma_pagamento) {
    somaInformadaPagamentos = totalLiquido;
    blocks.push({
      kind: 'kv',
      label: rotuloFormaPagamento(venda.fin_forma_pagamento, venda.fin_parcelas),
      value: moedaBrl(totalLiquido),
    });
  }

  const valorRecebido = venda.pdv_valor_recebido != null
    ? round2(Number(venda.pdv_valor_recebido))
    : Math.max(totalLiquido, somaInformadaPagamentos);
  const troco = venda.pdv_troco != null
    ? round2(Number(venda.pdv_troco))
    : round2(Math.max(0, valorRecebido - totalLiquido));

  // Caso especial: cliente entregou dinheiro que foi 100% devolvido em troco além de outro meio
  if (valorRecebido > somaInformadaPagamentos + 0.009) {
    blocks.push({ kind: 'kv', label: 'Dinheiro entregue', value: moedaBrl(round2(valorRecebido - somaInformadaPagamentos)) });
  }

  blocks.push({ kind: 'kv', label: 'Valor recebido', value: moedaBrl(valorRecebido) });
  if (troco > 0.009) {
    blocks.push({ kind: 'kv', label: 'Troco', value: moedaBrl(troco) });
  }

  if (venda.observacoes && String(venda.observacoes).trim()) {
    blocks.push({ kind: 'separator' });
    blocks.push({ kind: 'text', text: `Obs.: ${String(venda.observacoes).trim()}`, size: 'small' });
  }

  blocks.push({ kind: 'separator' });
  if (nfceAutorizada?.chave_acesso) {
    const chave = String(nfceAutorizada.chave_acesso).trim();
    blocks.push({ kind: 'text', text: `Chave NFC-e: ${chave}`, align: 'center', size: 'small' });
    blocks.push({
      kind: 'qrcode',
      value: String(nfceAutorizada.danfe_url || chave),
      caption: nfceAutorizada.protocolo ? `Protocolo: ${nfceAutorizada.protocolo}` : 'Consulta NFC-e',
    });
  }
  blocks.push({
    kind: 'barcode',
    value: `VENDA-${venda.id}`,
    symbology: 'code128',
    caption: `VENDA #${venda.id}`,
  });
  blocks.push({ kind: 'text', text: 'Obrigado pela preferência!', align: 'center', size: 'small' });
  blocks.push({ kind: 'cut' });

  return {
    docType: 'recibo_pdv',
    source: 'pdv',
    sourceRef: `venda:${venda.id}`,
    related: { type: 'venda', id: String(venda.id) },
    blocks,
    caixaNumero: caixa?.numero ? String(caixa.numero) : null,
    titulo: `Cupom PDV #${venda.id}`,
    metadata: {
      venda_id: Number(venda.id),
      caixa_id: venda.pdv_caixa_id != null ? Number(venda.pdv_caixa_id) : null,
      caixa_numero: caixa?.numero ? String(caixa.numero) : null,
      total: totalLiquido,
      troco,
    },
  };
}

// ============================================================================
// P3.1 — Pedido de Venda / Orçamento (vendas -> PrintIR)
// ============================================================================
export async function construirPedidoVendaPrintIR(
  vendaId: number,
  escopo: EscopoEmpresa,
  opts: { tx?: Tx } = {}
): Promise<DocumentoConstruido> {
  const s = getStore();
  const tx = opts.tx;
  const rVendas = getResource('vendas')!;
  const venda = await s.findOneWhere(rVendas, { id: vendaId, empresa_id: escopo.empresaId }, tx);
  if (!venda) throw new HttpError(404, 'Pedido de venda não encontrado.');
  assertRegistroDaEmpresa(rVendas, venda, escopo);

  const [{ blocks: empBlocks }, itensRes] = await Promise.all([
    cabecalhoEmpresaBlocks(escopo.empresaId, tx),
    s.list(getResource('itens_venda')!, { page: 1, pageSize: 500, filter: { venda_id: vendaId, empresa_id: escopo.empresaId } }, tx),
  ]);

  const cliente = venda.cliente_id
    ? await s.findOneWhere(getResource('clientes')!, { id: Number(venda.cliente_id), empresa_id: escopo.empresaId }, tx)
    : null;
  const representante = venda.representante_id
    ? await s.findOneWhere(getResource('representantes')!, { id: Number(venda.representante_id), empresa_id: escopo.empresaId }, tx)
    : null;

  const prodMap = new Map<number, Row>();
  const tamMap = new Map<number, Row>();
  for (const it of itensRes.rows) {
    const pid = Number(it.produto_id);
    if (pid && !prodMap.has(pid)) {
      const p = await s.findOneWhere(getResource('produtos')!, { id: pid, empresa_id: escopo.empresaId }, tx);
      if (p) prodMap.set(pid, p);
    }
    const tid = Number(it.tamanho_id);
    if (tid && !tamMap.has(tid)) {
      const t = await s.get(getResource('tamanhos')!, tid, tx);
      if (t) tamMap.set(tid, t);
    }
  }

  const ehCotacao = String(venda.status) === 'cotacao';
  const docType: PrintDocType = ehCotacao ? 'orcamento' : 'pedido';
  const titulo = ehCotacao ? `ORÇAMENTO DE VENDA #${venda.id}` : `PEDIDO DE VENDA #${venda.id}`;

  const blocks: PrintBlock[] = [
    ...empBlocks,
    { kind: 'separator' },
    { kind: 'text', text: titulo, align: 'center', emphasis: 'title' },
    { kind: 'kv', label: 'Data de emissão', value: dataHoraLegivel(venda.data || venda.criado_em) },
    { kind: 'kv', label: 'Status', value: String(venda.status || '').toUpperCase() },
  ];

  if (venda.previsao_entrega) blocks.push({ kind: 'kv', label: 'Previsão de entrega', value: dataHoraLegivel(venda.previsao_entrega) });
  if (venda.pedido_cliente) blocks.push({ kind: 'kv', label: 'Pedido do cliente', value: String(venda.pedido_cliente) });
  if (representante?.nome) blocks.push({ kind: 'kv', label: 'Representante', value: String(representante.nome) });

  if (cliente) {
    blocks.push({ kind: 'separator' });
    blocks.push({ kind: 'text', text: 'DADOS DO CLIENTE', emphasis: 'bold' });
    blocks.push({ kind: 'kv', label: 'Nome / Razão Social', value: String(cliente.razao_social || cliente.nome) });
    if (cliente.cnpj_cpf) blocks.push({ kind: 'kv', label: 'CPF / CNPJ', value: formatarDocumento(String(cliente.cnpj_cpf)) });
    if (cliente.telefone) blocks.push({ kind: 'kv', label: 'Telefone', value: formatarTelefone(String(cliente.telefone)) });
    const endCli = enderecoLinha(cliente);
    if (endCli) blocks.push({ kind: 'text', text: `Endereço: ${endCli}`, size: 'small' });
  }

  blocks.push({ kind: 'separator' });
  let subtotalItens = 0;
  const rows: string[][] = [];
  for (const it of itensRes.rows) {
    const prod = prodMap.get(Number(it.produto_id));
    const tam = it.tamanho_id ? tamMap.get(Number(it.tamanho_id)) : null;
    const qtd = Number(it.quantidade || 0);
    const unit = round2(Number(it.preco_unitario || 0));
    const descPct = round2(Number(it.desconto_pct || 0));
    const sub = it.subtotal != null ? round2(Number(it.subtotal)) : round2(qtd * unit * (1 - descPct / 100));
    subtotalItens = round2(subtotalItens + sub);
    rows.push([
      String(prod?.sku || `#${it.produto_id}`),
      String(prod?.nome || `Produto #${it.produto_id}`) + (tam?.codigo ? ` (${tam.codigo})` : ''),
      numCompacto(qtd),
      moedaBrl(unit),
      descPct > 0 ? `${numCompacto(descPct)}%` : '-',
      moedaBrl(sub),
    ]);
  }

  if (rows.length > 0) {
    blocks.push({
      kind: 'table',
      columns: [
        { header: 'SKU', align: 'left' },
        { header: 'Descrição', align: 'left' },
        { header: 'Qtd', align: 'right' },
        { header: 'Unit.', align: 'right' },
        { header: 'Desc.', align: 'right' },
        { header: 'Subtotal', align: 'right' },
      ],
      rows,
    });
  } else {
    blocks.push({ kind: 'text', text: 'Nenhum item registrado neste pedido.', size: 'small' });
  }

  blocks.push({ kind: 'separator' });
  const desconto = round2(Number(venda.desconto || 0));
  const frete = round2(Number(venda.frete || 0));
  const total = round2(Number(venda.total ?? Math.max(0, subtotalItens - desconto + frete)));

  blocks.push({ kind: 'kv', label: 'Subtotal dos itens', value: moedaBrl(subtotalItens) });
  if (desconto > 0) blocks.push({ kind: 'kv', label: 'Desconto', value: `- ${moedaBrl(desconto)}` });
  if (frete > 0) blocks.push({ kind: 'kv', label: 'Frete', value: moedaBrl(frete) });
  blocks.push({ kind: 'text', text: `TOTAL DO DOCUMENTO: ${moedaBrl(total)}`, align: 'right', emphasis: 'bold', size: 'large' });

  if (venda.condicao_pagamento) blocks.push({ kind: 'kv', label: 'Condição de pagamento', value: String(venda.condicao_pagamento) });
  if (venda.fin_forma_pagamento) {
    blocks.push({
      kind: 'kv',
      label: 'Forma de pagamento',
      value: rotuloFormaPagamento(venda.fin_forma_pagamento, venda.fin_parcelas),
    });
  }
  if (venda.observacoes && String(venda.observacoes).trim()) {
    blocks.push({ kind: 'separator' });
    blocks.push({ kind: 'text', text: `Observações: ${String(venda.observacoes).trim()}`, size: 'small' });
  }

  blocks.push({
    kind: 'barcode',
    value: `PEDIDO-${venda.id}`,
    symbology: 'code128',
    caption: `PEDIDO #${venda.id}`,
  });
  blocks.push({ kind: 'cut' });

  return {
    docType,
    source: 'pedido',
    sourceRef: `venda:${venda.id}`,
    related: { type: 'venda', id: String(venda.id) },
    blocks,
    titulo,
    metadata: {
      venda_id: Number(venda.id),
      status: venda.status,
      total,
      fallback_pdf_url: `/api/vendas/${venda.id}/pdf`,
    },
  };
}

// ============================================================================
// P3.2 — Pedido de Compra (compras -> PrintIR)
// ============================================================================
export async function construirPedidoCompraPrintIR(
  compraId: number,
  escopo: EscopoEmpresa,
  opts: { tx?: Tx } = {}
): Promise<DocumentoConstruido> {
  const s = getStore();
  const tx = opts.tx;
  const rCompras = getResource('compras')!;
  const compra = await s.findOneWhere(rCompras, { id: compraId, empresa_id: escopo.empresaId }, tx);
  if (!compra) throw new HttpError(404, 'Pedido de compra não encontrado.');
  assertRegistroDaEmpresa(rCompras, compra, escopo);

  const [{ blocks: empBlocks }, itensRes] = await Promise.all([
    cabecalhoEmpresaBlocks(escopo.empresaId, tx),
    s.list(getResource('itens_compra')!, { page: 1, pageSize: 500, filter: { compra_id: compraId, empresa_id: escopo.empresaId } }, tx),
  ]);

  const fornecedor = compra.fornecedor_id
    ? await s.findOneWhere(getResource('fornecedores')!, { id: Number(compra.fornecedor_id), empresa_id: escopo.empresaId }, tx)
    : null;

  const titulo = `PEDIDO DE COMPRA #${compra.id}`;
  const blocks: PrintBlock[] = [
    ...empBlocks,
    { kind: 'separator' },
    { kind: 'text', text: titulo, align: 'center', emphasis: 'title' },
    { kind: 'kv', label: 'Data', value: dataHoraLegivel(compra.data || compra.criado_em) },
    { kind: 'kv', label: 'Status', value: String(compra.status || '').toUpperCase() },
  ];

  if (compra.previsao_entrega) blocks.push({ kind: 'kv', label: 'Previsão de entrega', value: dataHoraLegivel(compra.previsao_entrega) });
  if (compra.nota_fiscal) blocks.push({ kind: 'kv', label: 'Nota fiscal', value: String(compra.nota_fiscal) });
  if (compra.local_entrada) blocks.push({ kind: 'kv', label: 'Local de entrada', value: String(compra.local_entrada) });

  if (fornecedor) {
    blocks.push({ kind: 'separator' });
    blocks.push({ kind: 'text', text: 'FORNECEDOR', emphasis: 'bold' });
    blocks.push({ kind: 'kv', label: 'Razão Social / Nome', value: String(fornecedor.razao_social || fornecedor.nome) });
    if (fornecedor.cnpj) blocks.push({ kind: 'kv', label: 'CNPJ / CPF', value: formatarDocumento(String(fornecedor.cnpj)) });
    if (fornecedor.contato) blocks.push({ kind: 'kv', label: 'Contato', value: String(fornecedor.contato) });
    if (fornecedor.telefone) blocks.push({ kind: 'kv', label: 'Telefone', value: formatarTelefone(String(fornecedor.telefone)) });
  }

  blocks.push({ kind: 'separator' });
  let subtotalItens = 0;
  const rows: string[][] = [];
  for (const it of itensRes.rows) {
    let codigo = String(it.codigo_fornecedor || '');
    let desc = '';
    if (it.produto_id) {
      const p = await s.findOneWhere(getResource('produtos')!, { id: Number(it.produto_id), empresa_id: escopo.empresaId }, tx);
      const t = it.tamanho_id ? await s.get(getResource('tamanhos')!, Number(it.tamanho_id), tx) : null;
      codigo = codigo || String(p?.sku || `P-${it.produto_id}`);
      desc = String(p?.nome || `Produto #${it.produto_id}`) + (t?.codigo ? ` (${t.codigo})` : '');
    } else if (it.insumo_id) {
      const ins = await s.findOneWhere(getResource('insumos')!, { id: Number(it.insumo_id), empresa_id: escopo.empresaId }, tx);
      codigo = codigo || String(ins?.codigo || `I-${it.insumo_id}`);
      desc = String(ins?.nome || `Insumo #${it.insumo_id}`);
    } else {
      desc = 'Item de compra';
    }
    const qtd = Number(it.quantidade || 0);
    const unit = round2(Number(it.preco_unitario || 0));
    const sub = round2(qtd * unit);
    subtotalItens = round2(subtotalItens + sub);
    rows.push([
      codigo || '-',
      desc,
      `${numCompacto(qtd)}${it.unidade ? ' ' + String(it.unidade) : ''}`,
      moedaBrl(unit),
      moedaBrl(sub),
    ]);
  }

  if (rows.length > 0) {
    blocks.push({
      kind: 'table',
      columns: [
        { header: 'Código', align: 'left' },
        { header: 'Item', align: 'left' },
        { header: 'Qtd', align: 'right' },
        { header: 'Custo Unit.', align: 'right' },
        { header: 'Subtotal', align: 'right' },
      ],
      rows,
    });
  }

  blocks.push({ kind: 'separator' });
  const frete = round2(Number(compra.frete || 0));
  const total = round2(Number(compra.total ?? subtotalItens + frete));
  blocks.push({ kind: 'kv', label: 'Subtotal dos itens', value: moedaBrl(subtotalItens) });
  if (frete > 0) blocks.push({ kind: 'kv', label: 'Frete', value: moedaBrl(frete) });
  blocks.push({ kind: 'text', text: `TOTAL DA COMPRA: ${moedaBrl(total)}`, align: 'right', emphasis: 'bold', size: 'large' });

  if (compra.condicao_pagamento) blocks.push({ kind: 'kv', label: 'Condição de pagamento', value: String(compra.condicao_pagamento) });
  if (compra.observacoes && String(compra.observacoes).trim()) {
    blocks.push({ kind: 'separator' });
    blocks.push({ kind: 'text', text: `Observações: ${String(compra.observacoes).trim()}`, size: 'small' });
  }
  blocks.push({ kind: 'barcode', value: `COMPRA-${compra.id}`, symbology: 'code128', caption: `COMPRA #${compra.id}` });
  blocks.push({ kind: 'cut' });

  return {
    docType: 'compra',
    source: 'compra',
    sourceRef: `compra:${compra.id}`,
    related: { type: 'compra', id: String(compra.id) },
    blocks,
    titulo,
    metadata: {
      compra_id: Number(compra.id),
      status: compra.status,
      total,
      fallback_pdf_url: `/api/compras/${compra.id}/pdf`,
    },
  };
}

// ============================================================================
// P3.3 — Proposta Comercial / Orçamento B2B (propostas -> PrintIR)
// ============================================================================
export async function construirPropostaComercialPrintIR(
  propostaId: number,
  escopo: EscopoEmpresa,
  opts: { tx?: Tx } = {}
): Promise<DocumentoConstruido> {
  const s = getStore();
  const tx = opts.tx;
  const rProp = getResource('propostas')!;
  const proposta = await s.findOneWhere(rProp, { id: propostaId, empresa_id: escopo.empresaId }, tx);
  if (!proposta) throw new HttpError(404, 'Proposta comercial não encontrada.');
  assertRegistroDaEmpresa(rProp, proposta, escopo);

  const [{ blocks: empBlocks }, itensRes] = await Promise.all([
    cabecalhoEmpresaBlocks(escopo.empresaId, tx),
    s.list(getResource('proposta_itens')!, { page: 1, pageSize: 500, filter: { proposta_id: propostaId, empresa_id: escopo.empresaId } }, tx),
  ]);

  const cliente = proposta.cliente_id
    ? await s.findOneWhere(getResource('clientes')!, { id: Number(proposta.cliente_id), empresa_id: escopo.empresaId }, tx)
    : null;
  const representante = proposta.representante_id
    ? await s.findOneWhere(getResource('representantes')!, { id: Number(proposta.representante_id), empresa_id: escopo.empresaId }, tx)
    : null;

  const numProp = String(proposta.numero || `#${proposta.id}`);
  const titulo = `PROPOSTA COMERCIAL ${numProp}`;
  const blocks: PrintBlock[] = [
    ...empBlocks,
    { kind: 'separator' },
    { kind: 'text', text: titulo, align: 'center', emphasis: 'title' },
    { kind: 'kv', label: 'Data', value: dataHoraLegivel(proposta.data || proposta.criado_em) },
    { kind: 'kv', label: 'Status', value: String(proposta.status || '').toUpperCase() },
  ];
  if (proposta.valida_ate) blocks.push({ kind: 'kv', label: 'Validade da proposta', value: dataHoraLegivel(proposta.valida_ate) });
  if (representante?.nome) blocks.push({ kind: 'kv', label: 'Representante', value: String(representante.nome) });

  if (cliente) {
    blocks.push({ kind: 'separator' });
    blocks.push({ kind: 'text', text: 'CLIENTE', emphasis: 'bold' });
    blocks.push({ kind: 'kv', label: 'Nome', value: String(cliente.razao_social || cliente.nome) });
    if (cliente.cnpj_cpf) blocks.push({ kind: 'kv', label: 'CPF / CNPJ', value: formatarDocumento(String(cliente.cnpj_cpf)) });
    if (cliente.email) blocks.push({ kind: 'kv', label: 'E-mail', value: String(cliente.email) });
  }

  blocks.push({ kind: 'separator' });
  let subtotal = 0;
  const rows: string[][] = [];
  for (const it of itensRes.rows) {
    const p = it.produto_id ? await s.findOneWhere(getResource('produtos')!, { id: Number(it.produto_id), empresa_id: escopo.empresaId }, tx) : null;
    const t = it.tamanho_id ? await s.get(getResource('tamanhos')!, Number(it.tamanho_id), tx) : null;
    const qtd = Number(it.quantidade || 0);
    const unit = round2(Number(it.preco_unitario || 0));
    const descPct = round2(Number(it.desconto_pct || 0));
    const sub = it.subtotal != null ? round2(Number(it.subtotal)) : round2(qtd * unit * (1 - descPct / 100));
    subtotal = round2(subtotal + sub);
    rows.push([
      String(p?.sku || `#${it.produto_id}`),
      String(p?.nome || `Produto #${it.produto_id}`) + (t?.codigo ? ` (${t.codigo})` : ''),
      numCompacto(qtd),
      moedaBrl(unit),
      descPct > 0 ? `${numCompacto(descPct)}%` : '-',
      moedaBrl(sub),
    ]);
  }
  if (rows.length > 0) {
    blocks.push({
      kind: 'table',
      columns: [
        { header: 'SKU', align: 'left' },
        { header: 'Produto', align: 'left' },
        { header: 'Qtd', align: 'right' },
        { header: 'Unit.', align: 'right' },
        { header: 'Desc.', align: 'right' },
        { header: 'Subtotal', align: 'right' },
      ],
      rows,
    });
  }

  blocks.push({ kind: 'separator' });
  const desconto = round2(Number(proposta.desconto || 0));
  const frete = round2(Number(proposta.frete || 0));
  const total = round2(Number(proposta.total ?? Math.max(0, subtotal - desconto + frete)));
  blocks.push({ kind: 'kv', label: 'Subtotal', value: moedaBrl(subtotal) });
  if (desconto > 0) blocks.push({ kind: 'kv', label: 'Desconto', value: `- ${moedaBrl(desconto)}` });
  if (frete > 0) blocks.push({ kind: 'kv', label: 'Frete', value: moedaBrl(frete) });
  blocks.push({ kind: 'text', text: `TOTAL DA PROPOSTA: ${moedaBrl(total)}`, align: 'right', emphasis: 'bold', size: 'large' });

  if (proposta.condicao_pagamento) blocks.push({ kind: 'kv', label: 'Condição de pagamento', value: String(proposta.condicao_pagamento) });
  if (proposta.observacoes && String(proposta.observacoes).trim()) {
    blocks.push({ kind: 'separator' });
    blocks.push({ kind: 'text', text: `Observações: ${String(proposta.observacoes).trim()}`, size: 'small' });
  }
  blocks.push({ kind: 'barcode', value: `PROP-${proposta.id}`, symbology: 'code128', caption: numProp });
  blocks.push({ kind: 'cut' });

  return {
    docType: 'orcamento',
    source: 'pedido',
    sourceRef: `proposta:${proposta.id}`,
    related: { type: 'proposta', id: String(proposta.id) },
    blocks,
    titulo,
    metadata: {
      proposta_id: Number(proposta.id),
      numero: numProp,
      total,
      fallback_html_url: `/api/propostas/${proposta.id}/html`,
      fallback_pdf_url: `/api/print/documentos/propostas/${proposta.id}/pdf`,
    },
  };
}

// ============================================================================
// P3.4 — Cotação de Compra (cotacoes_compra -> PrintIR)
// ============================================================================
export async function construirCotacaoCompraPrintIR(
  cotacaoId: number,
  escopo: EscopoEmpresa,
  opts: { tx?: Tx } = {}
): Promise<DocumentoConstruido> {
  const s = getStore();
  const tx = opts.tx;
  const rCot = getResource('cotacoes_compra')!;
  const cotacao = await s.findOneWhere(rCot, { id: cotacaoId, empresa_id: escopo.empresaId }, tx);
  if (!cotacao) throw new HttpError(404, 'Cotação de compra não encontrada.');
  assertRegistroDaEmpresa(rCot, cotacao, escopo);

  const [{ blocks: empBlocks }, itensRes] = await Promise.all([
    cabecalhoEmpresaBlocks(escopo.empresaId, tx),
    s.list(getResource('cotacao_compra_itens')!, { page: 1, pageSize: 500, filter: { cotacao_id: cotacaoId, empresa_id: escopo.empresaId } }, tx),
  ]);

  const titulo = `COTAÇÃO DE COMPRA #${cotacao.id} — ${String(cotacao.titulo || '').trim() || 'Mapa de Cotação'}`;
  const blocks: PrintBlock[] = [
    ...empBlocks,
    { kind: 'separator' },
    { kind: 'text', text: titulo, align: 'center', emphasis: 'title' },
    { kind: 'kv', label: 'Status', value: String(cotacao.status || '').toUpperCase() },
  ];
  if (cotacao.criterio) blocks.push({ kind: 'kv', label: 'Critério', value: String(cotacao.criterio) });
  if (cotacao.prazo_validade) blocks.push({ kind: 'kv', label: 'Prazo de resposta', value: dataHoraLegivel(cotacao.prazo_validade) });
  if (cotacao.previsao_compra) blocks.push({ kind: 'kv', label: 'Previsão de compra', value: dataHoraLegivel(cotacao.previsao_compra) });

  blocks.push({ kind: 'separator' });
  const rows: string[][] = [];
  for (const it of itensRes.rows) {
    let nomeItem = `Item #${it.id}`;
    if (it.produto_id) {
      const p = await s.findOneWhere(getResource('produtos')!, { id: Number(it.produto_id), empresa_id: escopo.empresaId }, tx);
      if (p) nomeItem = `${p.sku ? p.sku + ' - ' : ''}${p.nome}`;
    } else if (it.insumo_id) {
      const ins = await s.findOneWhere(getResource('insumos')!, { id: Number(it.insumo_id), empresa_id: escopo.empresaId }, tx);
      if (ins) nomeItem = `${ins.codigo ? ins.codigo + ' - ' : ''}${ins.nome}`;
    }
    const forn = it.escolhido_fornecedor_id
      ? await s.findOneWhere(getResource('fornecedores')!, { id: Number(it.escolhido_fornecedor_id), empresa_id: escopo.empresaId }, tx)
      : null;
    rows.push([
      nomeItem,
      `${numCompacto(it.quantidade)}${it.unidade ? ' ' + String(it.unidade) : ''}`,
      forn ? String(forn.nome) : '-',
      it.escolhido_preco != null ? moedaBrl(it.escolhido_preco) : '-',
    ]);
  }
  if (rows.length > 0) {
    blocks.push({
      kind: 'table',
      columns: [
        { header: 'Item Solicitado', align: 'left' },
        { header: 'Qtd', align: 'right' },
        { header: 'Fornecedor Vencedor', align: 'left' },
        { header: 'Preço Escolhido', align: 'right' },
      ],
      rows,
    });
  }

  if (cotacao.observacoes && String(cotacao.observacoes).trim()) {
    blocks.push({ kind: 'separator' });
    blocks.push({ kind: 'text', text: `Observações: ${String(cotacao.observacoes).trim()}`, size: 'small' });
  }
  blocks.push({ kind: 'barcode', value: `COT-${cotacao.id}`, symbology: 'code128', caption: `COTACAO #${cotacao.id}` });
  blocks.push({ kind: 'cut' });

  return {
    docType: 'orcamento',
    source: 'compra',
    sourceRef: `cotacao_compra:${cotacao.id}`,
    related: { type: 'cotacao_compra', id: String(cotacao.id) },
    blocks,
    titulo,
    metadata: {
      cotacao_id: Number(cotacao.id),
      status: cotacao.status,
      fallback_pdf_url: `/api/print/documentos/cotacoes-compra/${cotacao.id}/pdf`,
    },
  };
}

// ============================================================================
// P3.5 — Ordem de Produção / Ficha OP (ordens -> PrintIR)
// ============================================================================
export async function construirOrdemProducaoPrintIR(
  ordemId: number,
  escopo: EscopoEmpresa,
  opts: { tx?: Tx } = {}
): Promise<DocumentoConstruido> {
  const s = getStore();
  const tx = opts.tx;
  const rOrdens = getResource('ordens')!;
  const ordem = await s.findOneWhere(rOrdens, { id: ordemId, empresa_id: escopo.empresaId }, tx);
  if (!ordem) throw new HttpError(404, 'Ordem de produção não encontrada.');
  assertRegistroDaEmpresa(rOrdens, ordem, escopo);

  const [{ blocks: empBlocks }, itensRes] = await Promise.all([
    cabecalhoEmpresaBlocks(escopo.empresaId, tx),
    s.list(getResource('itens_ordem')!, { page: 1, pageSize: 200, filter: { ordem_id: ordemId, empresa_id: escopo.empresaId } }, tx),
  ]);

  const produto = ordem.produto_id
    ? await s.findOneWhere(getResource('produtos')!, { id: Number(ordem.produto_id), empresa_id: escopo.empresaId }, tx)
    : null;
  const responsavel = ordem.responsavel_id
    ? await s.findOneWhere(getResource('usuarios')!, { id: Number(ordem.responsavel_id) }, tx)
    : null;

  const titulo = `ORDEM DE PRODUÇÃO #${ordem.id}`;
  const blocks: PrintBlock[] = [
    ...empBlocks,
    { kind: 'separator' },
    { kind: 'text', text: titulo, align: 'center', emphasis: 'title' },
    { kind: 'kv', label: 'Status', value: String(ordem.status || '').toUpperCase() },
  ];
  if (ordem.etapa) blocks.push({ kind: 'kv', label: 'Etapa atual', value: String(ordem.etapa) });
  if (produto) blocks.push({ kind: 'kv', label: 'Produto', value: `${produto.sku ? produto.sku + ' — ' : ''}${produto.nome}` });
  blocks.push({ kind: 'kv', label: 'Qtd. planejada', value: numCompacto(ordem.quantidade) });
  if (ordem.quantidade_produzida != null) blocks.push({ kind: 'kv', label: 'Qtd. produzida', value: numCompacto(ordem.quantidade_produzida) });
  if (ordem.inicio) blocks.push({ kind: 'kv', label: 'Início', value: dataHoraLegivel(ordem.inicio) });
  if (ordem.previsao) blocks.push({ kind: 'kv', label: 'Previsão', value: dataHoraLegivel(ordem.previsao) });
  if (ordem.faccao) blocks.push({ kind: 'kv', label: 'Facção / Oficina', value: String(ordem.faccao) });
  if (responsavel?.nome) blocks.push({ kind: 'kv', label: 'Responsável', value: String(responsavel.nome) });

  if (itensRes.rows.length > 0) {
    blocks.push({ kind: 'separator' });
    const rows: string[][] = [];
    for (const it of itensRes.rows) {
      const tam = it.tamanho_id ? await s.get(getResource('tamanhos')!, Number(it.tamanho_id), tx) : null;
      rows.push([
        String(tam?.codigo || tam?.nome || '-'),
        numCompacto(it.quantidade),
        numCompacto(it.produzido ?? 0),
        numCompacto(it.perdido ?? 0),
      ]);
    }
    blocks.push({
      kind: 'table',
      columns: [
        { header: 'Tamanho', align: 'left' },
        { header: 'Planejado', align: 'right' },
        { header: 'Produzido', align: 'right' },
        { header: 'Perda', align: 'right' },
      ],
      rows,
    });
  }

  if (ordem.observacoes && String(ordem.observacoes).trim()) {
    blocks.push({ kind: 'separator' });
    blocks.push({ kind: 'text', text: `Observações: ${String(ordem.observacoes).trim()}`, size: 'small' });
  }
  blocks.push({ kind: 'barcode', value: `OP-${ordem.id}`, symbology: 'code128', caption: `OP #${ordem.id}` });
  blocks.push({ kind: 'cut' });

  return {
    docType: 'ordem_producao',
    source: 'producao',
    sourceRef: `ordem:${ordem.id}`,
    related: { type: 'ordem', id: String(ordem.id) },
    blocks,
    titulo,
    metadata: {
      ordem_id: Number(ordem.id),
      status: ordem.status,
      fallback_pdf_url: `/api/print/documentos/ordens/${ordem.id}/pdf`,
    },
  };
}

// ============================================================================
// P3.6 — Ficha Cadastral de Usuário (usuarios -> PrintIR, sem segredos!)
// ============================================================================
export async function construirFichaUsuarioPrintIR(
  usuarioId: number,
  escopo: EscopoEmpresa,
  actor: AuthUser,
  opts: { tx?: Tx } = {}
): Promise<DocumentoConstruido> {
  if (actor.perfil !== 'admin' && actor.perfil !== 'gerente') {
    throw new HttpError(403, 'Apenas administradores e gerentes podem imprimir fichas de usuários.');
  }
  const s = getStore();
  const tx = opts.tx;
  const rUsers = getResource('usuarios')!;
  const u = await s.findOneWhere(rUsers, { id: usuarioId }, tx);
  if (!u) throw new HttpError(404, 'Usuário não encontrado nesta empresa.');
  if (u.empresa_id != null && Number(u.empresa_id) !== escopo.empresaId) {
    const vinculo = await s.findOneWhere(
      getResource('usuarios_empresas')!,
      { usuario_id: usuarioId, empresa_id: escopo.empresaId },
      tx
    );
    if (!vinculo) throw new HttpError(404, 'Usuário não encontrado nesta empresa.');
  }

  const { blocks: empBlocks } = await cabecalhoEmpresaBlocks(escopo.empresaId, tx);
  const titulo = `FICHA CADASTRAL DE ACESSO — #${u.id}`;
  const blocks: PrintBlock[] = [
    ...empBlocks,
    { kind: 'separator' },
    { kind: 'text', text: titulo, align: 'center', emphasis: 'title' },
    { kind: 'kv', label: 'Nome completo', value: String(u.nome || '') },
    { kind: 'kv', label: 'E-mail', value: String(u.email || '') },
    { kind: 'kv', label: 'Perfil de acesso', value: String(u.perfil || '').toUpperCase() },
    { kind: 'kv', label: 'Situação', value: u.ativo === false ? 'INATIVO' : 'ATIVO' },
  ];
  if (u.cargo) blocks.push({ kind: 'kv', label: 'Cargo', value: String(u.cargo) });
  if (u.departamento) blocks.push({ kind: 'kv', label: 'Departamento', value: String(u.departamento) });
  if (u.telefone) blocks.push({ kind: 'kv', label: 'Telefone', value: formatarTelefone(String(u.telefone)) });
  blocks.push({ kind: 'kv', label: 'MFA ativo', value: u.mfa_ativo ? 'SIM' : 'NÃO' });
  if (u.ultimo_login) blocks.push({ kind: 'kv', label: 'Último acesso', value: dataHoraLegivel(u.ultimo_login) });
  blocks.push({ kind: 'separator' });
  blocks.push({ kind: 'text', text: `Emitido por ${actor.name} em ${dataHoraLegivel(new Date().toISOString())}`, size: 'small' });
  blocks.push({ kind: 'cut' });

  return {
    docType: 'ficha_usuario',
    source: 'usuario',
    sourceRef: `usuario:${u.id}`,
    related: { type: 'usuario', id: String(u.id) },
    blocks,
    titulo,
    metadata: {
      usuario_id: Number(u.id),
      fallback_pdf_url: `/api/print/documentos/usuarios/${u.id}/pdf`,
    },
  };
}
