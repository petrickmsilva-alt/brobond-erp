// ============================================================
// Geração de PDF para pedidos de venda e compra.
//
// GET /api/vendas/:id/pdf  → PDF do pedido de venda
// GET /api/compras/:id/pdf → PDF do pedido de compra
//
// Usa pdfkit (dependência instalada) para gerar o PDF no servidor.
// O PDF inclui: logo BROBOND, dados do cliente/fornecedor, itens em tabela,
// totais, condição de pagamento, frete e observações.
// ============================================================
import type { Request, Response } from 'express';
import PDFDocument from 'pdfkit';
import { HttpError } from './errors';
import { getResource } from './resources';
import { checkAccess, getStore } from './services';
import { currentUser } from './auth';
import { parseId } from './validate';
import { labelOf } from './store';
import { attachImages } from './uploads';
import { round2 } from './utils';

const fmtMoney = (n: number) =>
  n.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtDate = (v: unknown) => {
  if (!v) return '—';
  const s = String(v);
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return `${m[3]}/${m[2]}/${m[1]}`;
  return s.slice(0, 10);
};

/** Cabeçalho do PDF com identificação BROBOND */
function pdfHeader(doc: InstanceType<typeof PDFDocument>) {
  doc.fontSize(20).font('Helvetica-Bold').fillColor('#1B2A4A').text('BROBOND', 50, 40, { align: 'left' });
  doc.fontSize(9).font('Helvetica').fillColor('#666666').text('Wear — Confecção Masculina', 50, 62);
  doc.fontSize(8).fillColor('#999999').text('CNPJ: —  |  Tel: —  |  contato@brobond.com.br', 50, 76);

  // Linha separadora
  doc.moveTo(50, 92).lineTo(545, 92).strokeColor('#1B2A4A').lineWidth(1.5).stroke();
}

/** Rodapé com numeração de página */
function pdfFooter(doc: InstanceType<typeof PDFDocument>, pageNum: number) {
  const pageHeight = (doc as any).page?.height || 842; // A4 height in points
  doc.fontSize(7).font('Helvetica').fillColor('#999999');
  doc.text(`BROBOND ERP — Documento gerado em ${new Date().toLocaleString('pt-BR')}`, 50, pageHeight - 40, {
    width: 350,
    align: 'left',
  });
  doc.text(`Página ${pageNum}`, 450, pageHeight - 40, { width: 100, align: 'right' });
}

/** Gera o PDF do pedido de venda. */
export async function vendaPDF(req: Request, res: Response) {
  const actor = currentUser(req);
  const r = getResource('vendas')!;
  checkAccess(r, actor, 'read');
  const id = parseId(req.params.id);
  const s = getStore();

  const venda = await s.get(r, id);
  if (!venda) throw new HttpError(404, 'Pedido de venda não encontrado.');

  // Busca dados relacionados
  const [cliente, representante, itens, tamanhos, produtos] = await Promise.all([
    venda.cliente_id ? s.findOneWhere(getResource('clientes')!, { id: Number(venda.cliente_id) }) : null,
    venda.representante_id ? s.findOneWhere(getResource('representantes')!, { id: Number(venda.representante_id) }) : null,
    s.list(getResource('itens_venda')!, { page: 1, pageSize: 500, filter: { venda_id: id } }),
    s.list(getResource('tamanhos')!, { page: 1, pageSize: 200, sort: 'ordem', dir: 'asc' }),
    s.list(getResource('produtos')!, { page: 1, pageSize: 2000 }),
  ]);
  await attachImages(getResource('produtos')!, produtos.rows);

  const tamMap = new Map(tamanhos.rows.map((t) => [Number(t.id), String(t.codigo || '')]));
  const prodMap = new Map(produtos.rows.map((p) => [Number(p.id), p]));

  // Cria o PDF
  const doc = new PDFDocument({ size: 'A4', margin: 50, bufferPages: true });
  res.setHeader('Content-Type', 'application/pdf');
  const filename = `venda-${id}-${new Date().toISOString().slice(0, 10)}.pdf`;
  res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
  doc.pipe(res);

  // Cabeçalho
  pdfHeader(doc);

  // Título do documento
  doc.moveDown(1.5);
  doc.fontSize(14).font('Helvetica-Bold').fillColor('#1B2A4A').text(`PEDIDO DE VENDA Nº ${id}`, { align: 'center' });
  doc.moveDown(0.3);

  const statusLabel: Record<string, string> = {
    aberta: 'Aberta',
    faturada: 'Faturada',
    entregue: 'Entregue',
    cancelada: 'Cancelada',
  };
  doc.fontSize(10).font('Helvetica').fillColor('#666666').text(`Status: ${statusLabel[String(venda.status)] || venda.status}`, { align: 'center' });
  doc.moveDown(1);

  // Dados do pedido (caixa)
  const boxTop = doc.y;
  doc.rect(50, boxTop, 500, 60).fillAndStroke('#F7F9FC', '#E2E8F0');
  doc.fillColor('#333333');
  doc.fontSize(8).font('Helvetica-Bold').text('DATA', 60, boxTop + 8);
  doc.fontSize(8).font('Helvetica').text(fmtDate(venda.data), 60, boxTop + 20);
  doc.fontSize(8).font('Helvetica-Bold').text('CLIENTE', 170, boxTop + 8);
  doc.fontSize(8).font('Helvetica').text(cliente ? labelOf(getResource('clientes')!, cliente) : '—', 170, boxTop + 20);
  doc.fontSize(8).font('Helvetica-Bold').text('REPRESENTANTE', 350, boxTop + 8);
  doc.fontSize(8).font('Helvetica').text(representante ? labelOf(getResource('representantes')!, representante) : '—', 350, boxTop + 20);
  if (venda.condicao_pagamento) {
    doc.fontSize(8).font('Helvetica-Bold').text('PAGAMENTO', 60, boxTop + 38);
    doc.fontSize(8).font('Helvetica').text(String(venda.condicao_pagamento), 60, boxTop + 50);
  }
  if (venda.previsao_entrega) {
    doc.fontSize(8).font('Helvetica-Bold').text('PREVISÃO ENTREGA', 350, boxTop + 38);
    doc.fontSize(8).font('Helvetica').text(fmtDate(venda.previsao_entrega), 350, boxTop + 50);
  }
  doc.y = boxTop + 70;

  // Tabela de itens
  doc.moveDown(0.5);
  const tableTop = doc.y;
  const colX = [50, 120, 270, 330, 380, 430, 490]; // x positions
  const headers = ['#', 'Produto', 'Tamanho', 'Qtd.', 'Preço Unit.', 'Desc.%', 'Subtotal'];

  // Header da tabela
  doc.rect(50, tableTop, 500, 18).fillAndStroke('#1B2A4A', '#1B2A4A');
  doc.fillColor('#FFFFFF').fontSize(8).font('Helvetica-Bold');
  headers.forEach((h, i) => {
    const align = i >= 3 ? 'right' : 'left';
    doc.text(h, colX[i] + (i >= 3 ? 0 : 4), tableTop + 5, { width: colX[i + 1] - colX[i] - 8, align });
  });

  // Linhas da tabela
  let y = tableTop + 18;
  doc.fillColor('#333333').fontSize(8).font('Helvetica');
  itens.rows.forEach((item: any, idx: number) => {
    if (y > 700) {
      doc.addPage();
      y = 50;
    }
    const bgColor = idx % 2 === 0 ? '#FFFFFF' : '#F7F9FC';
    doc.rect(50, y, 500, 18).fillAndStroke(bgColor, '#E2E8F0');
    doc.fillColor('#333333');

    const prod = prodMap.get(Number(item.produto_id));
    const prodLabel = prod ? `${prod.sku} — ${prod.nome}` : `#${item.produto_id}`;
    const tam = tamMap.get(Number(item.tamanho_id)) || '';
    const subtotal = Number(item.subtotal || 0);

    doc.text(String(idx + 1), colX[0] + 4, y + 5, { width: colX[1] - colX[0] - 8 });
    doc.text(prodLabel.slice(0, 40), colX[1] + 4, y + 5, { width: colX[2] - colX[1] - 8 });
    doc.text(tam, colX[2] + 4, y + 5, { width: colX[3] - colX[2] - 8, align: 'center' });
    doc.text(String(item.quantidade), colX[3], y + 5, { width: colX[4] - colX[3] - 8, align: 'right' });
    doc.text(fmtMoney(Number(item.preco_unitario || 0)), colX[4], y + 5, { width: colX[5] - colX[4] - 8, align: 'right' });
    doc.text(`${Number(item.desconto_pct || 0)}%`, colX[5], y + 5, { width: colX[6] - colX[5] - 8, align: 'right' });
    doc.text(fmtMoney(subtotal), colX[6] - 60, y + 5, { width: 55, align: 'right' });

    y += 18;
  });

  // Totais
  y += 8;
  const total = Number(venda.total || 0);
  const frete = Number(venda.frete || 0);
  const desconto = Number(venda.desconto || 0);
  const subtotalItens = itens.rows.reduce((sum: number, it: any) => sum + Number(it.subtotal || 0), 0);

  doc.font('Helvetica').fontSize(9);
  const totX = 380;
  doc.fillColor('#666666').text(`Subtotal itens:`, totX, y, { width: 100, align: 'right' });
  doc.text(fmtMoney(subtotalItens), 490, y, { width: 60, align: 'right' });
  y += 14;
  if (frete > 0) {
    doc.text(`Frete:`, totX, y, { width: 100, align: 'right' });
    doc.text(fmtMoney(frete), 490, y, { width: 60, align: 'right' });
    y += 14;
  }
  if (desconto > 0) {
    doc.fillColor('#C53030').text(`Desconto:`, totX, y, { width: 100, align: 'right' });
    doc.text(`- ${fmtMoney(desconto)}`, 490, y, { width: 60, align: 'right' });
    y += 14;
  }
  y += 4;
  doc.rect(totX - 10, y - 2, 170, 22).fillAndStroke('#1B2A4A', '#1B2A4A');
  doc.fillColor('#FFFFFF').fontSize(11).font('Helvetica-Bold').text(`TOTAL: R$ ${fmtMoney(total)}`, totX, y + 4, { width: 160, align: 'right' });

  // Observações
  if (venda.observacoes) {
    y += 40;
    doc.fillColor('#333333').fontSize(9).font('Helvetica-Bold').text('Observações:', 50, y);
    doc.font('Helvetica').fontSize(8).fillColor('#666666').text(String(venda.observacoes), 50, y + 14, { width: 500 });
  }

  // Comissão
  if (venda.comissao_valor && representante) {
    const comY = Math.min(y + 60, 750);
    doc.fillColor('#333333').fontSize(8).font('Helvetica')
      .text(`Comissão do representante: ${Number(venda.comissao_pct || 0)}% = R$ ${fmtMoney(Number(venda.comissao_valor))}`, 50, comY, { width: 500 });
  }

  // Rodapé em todas as páginas
  const pages = doc.bufferedPageRange();
  for (let i = 0; i < pages.count; i++) {
    doc.switchToPage(i);
    pdfFooter(doc, i + 1);
  }

  doc.end();
}

/** Gera o PDF do pedido de compra. */
export async function compraPDF(req: Request, res: Response) {
  const actor = currentUser(req);
  const r = getResource('compras')!;
  checkAccess(r, actor, 'read');
  const id = parseId(req.params.id);
  const s = getStore();

  const compra = await s.get(r, id);
  if (!compra) throw new HttpError(404, 'Pedido de compra não encontrado.');

  const [fornecedor, itens, insumos] = await Promise.all([
    compra.fornecedor_id ? s.findOneWhere(getResource('fornecedores')!, { id: Number(compra.fornecedor_id) }) : null,
    s.list(getResource('itens_compra')!, { page: 1, pageSize: 500, filter: { compra_id: id } }),
    s.list(getResource('insumos')!, { page: 1, pageSize: 2000 }),
  ]);

  const insMap = new Map(insumos.rows.map((i) => [Number(i.id), i]));

  const doc = new PDFDocument({ size: 'A4', margin: 50, bufferPages: true });
  res.setHeader('Content-Type', 'application/pdf');
  const filename = `compra-${id}-${new Date().toISOString().slice(0, 10)}.pdf`;
  res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
  doc.pipe(res);

  pdfHeader(doc);
  doc.moveDown(1.5);
  doc.fontSize(14).font('Helvetica-Bold').fillColor('#1B2A4A').text(`PEDIDO DE COMPRA Nº ${id}`, { align: 'center' });
  doc.moveDown(0.3);

  const statusLabel: Record<string, string> = {
    pendente: 'Pendente',
    recebido: 'Recebido',
    cancelado: 'Cancelado',
  };
  doc.fontSize(10).font('Helvetica').fillColor('#666666').text(`Status: ${statusLabel[String(compra.status)] || compra.status}`, { align: 'center' });
  doc.moveDown(1);

  // Dados
  const boxTop = doc.y;
  doc.rect(50, boxTop, 500, 50).fillAndStroke('#F7F9FC', '#E2E8F0');
  doc.fillColor('#333333');
  doc.fontSize(8).font('Helvetica-Bold').text('DATA', 60, boxTop + 8);
  doc.fontSize(8).font('Helvetica').text(fmtDate(compra.data), 60, boxTop + 20);
  doc.fontSize(8).font('Helvetica-Bold').text('FORNECEDOR', 200, boxTop + 8);
  doc.fontSize(8).font('Helvetica').text(fornecedor ? labelOf(getResource('fornecedores')!, fornecedor) : '—', 200, boxTop + 20);
  if (compra.condicao_pagamento) {
    doc.fontSize(8).font('Helvetica-Bold').text('PAGAMENTO', 400, boxTop + 8);
    doc.fontSize(8).font('Helvetica').text(String(compra.condicao_pagamento), 400, boxTop + 20);
  }
  doc.fontSize(8).font('Helvetica-Bold').text('PREVISÃO ENTREGA', 60, boxTop + 35);
  doc.fontSize(8).font('Helvetica').text(fmtDate(compra.previsao_entrega), 60, boxTop + 47);
  doc.y = boxTop + 60;

  // Tabela de itens
  doc.moveDown(0.5);
  const tableTop = doc.y;
  const colX = [50, 250, 340, 420, 490];
  const headers = ['#', 'Insumo', 'Unidade', 'Quantidade', 'Preço Unit.', 'Total'];

  doc.rect(50, tableTop, 500, 18).fillAndStroke('#1B2A4A', '#1B2A4A');
  doc.fillColor('#FFFFFF').fontSize(8).font('Helvetica-Bold');
  headers.forEach((h, i) => {
    const align = i >= 2 ? 'right' : 'left';
    doc.text(h, colX[i] + (i >= 2 ? 0 : 4), tableTop + 5, { width: (colX[i + 1] || 550) - colX[i] - 8, align });
  });

  let y = tableTop + 18;
  doc.fillColor('#333333').fontSize(8).font('Helvetica');
  itens.rows.forEach((item: any, idx: number) => {
    if (y > 700) {
      doc.addPage();
      y = 50;
    }
    const bgColor = idx % 2 === 0 ? '#FFFFFF' : '#F7F9FC';
    doc.rect(50, y, 500, 18).fillAndStroke(bgColor, '#E2E8F0');
    doc.fillColor('#333333');

    const ins = insMap.get(Number(item.insumo_id));
    const insLabel = ins ? ins.nome : `#${item.insumo_id}`;
    const un = ins?.unidade || 'un';
    const subtotal = round2(Number(item.quantidade) * Number(item.preco_unitario));

    doc.text(String(idx + 1), colX[0] + 4, y + 5, { width: colX[1] - colX[0] - 8 });
    doc.text(insLabel.slice(0, 40), colX[1] + 4, y + 5, { width: colX[2] - colX[1] - 8 });
    doc.text(un, colX[2], y + 5, { width: colX[3] - colX[2] - 8, align: 'right' });
    doc.text(String(item.quantidade), colX[3] - 60, y + 5, { width: 55, align: 'right' });
    doc.text(fmtMoney(Number(item.preco_unitario)), colX[3], y + 5, { width: colX[4] - colX[3] - 8, align: 'right' });
    doc.text(fmtMoney(subtotal), colX[4] - 10, y + 5, { width: 65, align: 'right' });

    y += 18;
  });

  // Total
  y += 8;
  const frete = Number(compra.frete || 0);
  const total = Number(compra.total || 0);

  doc.font('Helvetica').fontSize(9);
  const totX = 400;
  if (frete > 0) {
    doc.fillColor('#666666').text(`Frete:`, totX, y, { width: 80, align: 'right' });
    doc.text(fmtMoney(frete), 490, y, { width: 60, align: 'right' });
    y += 14;
  }
  y += 4;
  doc.rect(totX - 10, y - 2, 160, 22).fillAndStroke('#1B2A4A', '#1B2A4A');
  doc.fillColor('#FFFFFF').fontSize(11).font('Helvetica-Bold').text(`TOTAL: R$ ${fmtMoney(total)}`, totX, y + 4, { width: 150, align: 'right' });

  if (compra.observacoes) {
    y += 40;
    doc.fillColor('#333333').fontSize(9).font('Helvetica-Bold').text('Observações:', 50, y);
    doc.font('Helvetica').fontSize(8).fillColor('#666666').text(String(compra.observacoes), 50, y + 14, { width: 500 });
  }

  const pages = doc.bufferedPageRange();
  for (let i = 0; i < pages.count; i++) {
    doc.switchToPage(i);
    pdfFooter(doc, i + 1);
  }

  doc.end();
}
