// ============================================================================
// printLabels.ts — Impressão Profissional de Etiquetas de Produto (P4).
//
// Integra o domínio de produtos/variações e o LabelSheet à arquitetura:
//   Produto (DB) -> PrintIR (etiqueta_produto) -> print_jobs -> ZPL / EPL2
//
// Garantias (P4 + P6):
//   • Autoridade total do backend: SKU, nome, cor, tamanho, preço e código de
//     barras vêm do banco filtrados por `empresa_id`;
//   • Validação estrita de EAN-8 / UPC-A / EAN-13 / GTIN-14 via `validarGtin`:
//     dígito verificador inválido NUNCA é falsificado -> retorna 422 INVALID_EAN;
//   • Código alfanumérico / SKU interno usa Code128 com segurança;
//   • Protocolos térmicos suportados: `zpl` e `epl2` — protocolo desconhecido
//     retorna 400 UNSUPPORTED_PROTOCOL (nunca imprime formato errado em silêncio);
//   • Limite de segurança de lote/cópias (máx. 100 variações e 500 etiquetas/job).
// ============================================================================
import { randomUUID } from 'node:crypto';
import type { Request, Response } from 'express';
import { PRINT_LIMITS, stripAsciiControl, type PrintBarcodeSymbology, type PrintBlock } from '../../packages/domain/src/print/print-ir';
import { currentUser, type AuthUser } from './auth';
import { erroGtin, gtinKind, isValidGtin, type GtinKind } from './ean';
import { assertRegistroDaEmpresa, type EscopoEmpresa } from './empresa';
import { HttpError } from './errors';
import { atorDeUsuario, auditarImpressao, enfileirarJob, jobPublico } from './printJobs';
import { moedaBrl } from './printTemplates';
import { resolverDestinoImpressao } from './printTerminals';
import { getResource, RESOURCES } from './resources';
import { checkAccess, escopoDe, getStore } from './services';
import type { Row, Tx } from './store';

export const MAX_ITENS_LOTE_ETIQUETA = 100;
export const MAX_QTD_POR_ITEM_ETIQUETA = 200;
export const MAX_TOTAL_ETIQUETAS_JOB = 500;
const LABEL_THERMAL_PROTOCOLS = new Set(['zpl', 'epl2']);

export type ItemEtiquetaEntrada = {
  produto_id: number;
  tamanho_id?: number | null;
  cor?: string | null;
  quantidade: number;
};

function mapearFormatoGtin(formato: GtinKind): PrintBarcodeSymbology {
  switch (formato) {
    case 'GTIN-8':
      return 'ean8';
    case 'GTIN-12':
      return 'upca';
    case 'GTIN-13':
      return 'ean13';
    case 'GTIN-14':
      return 'gtin14';
  }
}

/**
 * Resolve e valida o código de barras de um produto/variação sem jamais
 * falsificar dígito verificador GS1.
 */
export function resolverCodigoBarrasEtiqueta(
  rawCodigoBarras: unknown,
  rawSku: unknown,
  produtoId: number,
  tamanhoCodigo?: string | null
): { value: string; symbology: PrintBarcodeSymbology } {
  const cb = stripAsciiControl(String(rawCodigoBarras ?? '')).trim();

  if (cb) {
    // Se parece GTIN numérico (8, 12, 13 ou 14 dígitos), EXIGE dígito GS1 válido
    const kind = gtinKind(cb);
    if (kind) {
      if (/^0+$/.test(cb) || !isValidGtin(cb)) {
        const motivo = /^0+$/.test(cb) ? 'código todo zerado' : (erroGtin(cb) || 'dígito verificador inválido');
        throw new HttpError(
          422,
          `Código EAN/GTIN inválido ("${cb}"): ${motivo}. O sistema nunca falsifica dígito verificador — corrija o código de barras do produto.`,
          { code: 'INVALID_EAN', valor: cb }
        );
      }
      return { value: cb, symbology: mapearFormatoGtin(kind) };
    }

    // Código alfanumérico ou numérico de outro comprimento permitido em Code128
    if (cb.length > PRINT_LIMITS.maxBarcodeLength || !/^[\x20-\x7e]+$/.test(cb)) {
      throw new HttpError(
        422,
        `Código de barras "${cb.slice(0, 40)}" contém caracteres inválidos para Code128.`,
        { code: 'INVALID_BARCODE' }
      );
    }
    return { value: cb, symbology: 'code128' };
  }

  // Sem codigo_barras cadastrado: usa SKU (com tamanho quando aplicável) em Code128
  const skuBase = stripAsciiControl(String(rawSku ?? '')).trim() || `PROD-${produtoId}`;
  const cleanTam = tamanhoCodigo ? String(tamanhoCodigo).replace(/[^A-Za-z0-9_-]/g, '') : '';
  const fallbackCode = (cleanTam && !skuBase.endsWith(`-${cleanTam}`) ? `${skuBase}-${cleanTam}` : skuBase).slice(
    0,
    PRINT_LIMITS.maxBarcodeLength
  );
  if (!/^[\x20-\x7e]+$/.test(fallbackCode)) {
    return { value: `PROD-${produtoId}`, symbology: 'code128' };
  }
  return { value: fallbackCode, symbology: 'code128' };
}

export async function construirEtiquetasPrintIR(
  escopo: EscopoEmpresa,
  itens: ItemEtiquetaEntrada[],
  opts: {
    incluirPreco?: boolean;
    incluirMarca?: boolean;
    labelWidthMm?: number;
    labelHeightMm?: number;
    dpi?: number;
    copies?: number;
    tx?: Tx;
  } = {}
): Promise<{
  blocks: PrintBlock[];
  totalEtiquetas: number;
  sourceRef: string;
  metadata: Record<string, unknown>;
}> {
  if (!Array.isArray(itens) || itens.length === 0) {
    throw new HttpError(400, 'Informe ao menos um item para impressão de etiquetas.');
  }
  if (itens.length > MAX_ITENS_LOTE_ETIQUETA) {
    throw new HttpError(400, `Máximo de ${MAX_ITENS_LOTE_ETIQUETA} itens distintos por lote de etiquetas.`);
  }

  const copies = opts.copies ?? 1;
  if (!Number.isInteger(copies) || copies < 1 || copies > 10) {
    throw new HttpError(400, 'Número de cópias do lote deve ser um inteiro entre 1 e 10.');
  }

  let somaQuantidades = 0;
  for (const [idx, it] of itens.entries()) {
    const pid = Number(it?.produto_id);
    const qtd = Number(it?.quantidade);
    if (!Number.isInteger(pid) || pid <= 0) {
      throw new HttpError(400, `Item ${idx + 1}: produto_id inválido.`);
    }
    if (!Number.isInteger(qtd) || qtd < 1 || qtd > MAX_QTD_POR_ITEM_ETIQUETA) {
      throw new HttpError(400, `Item ${idx + 1}: quantidade deve ser um inteiro entre 1 e ${MAX_QTD_POR_ITEM_ETIQUETA}.`);
    }
    somaQuantidades += qtd;
  }

  const totalEtiquetas = somaQuantidades * copies;
  if (totalEtiquetas > MAX_TOTAL_ETIQUETAS_JOB) {
    throw new HttpError(
      400,
      `Limite de segurança excedido: solicitado ${totalEtiquetas} etiquetas (máximo permitido por job: ${MAX_TOTAL_ETIQUETAS_JOB}).`
    );
  }

  const s = getStore();
  const tx = opts.tx;
  const rProd = getResource('produtos')!;
  const empresa = await s.get(RESOURCES.empresas, escopo.empresaId, tx);
  const marcaEmpresa = String(empresa?.nome_fantasia || empresa?.nome || 'BROBOND').trim().toUpperCase();

  const incluirPreco = opts.incluirPreco !== false;
  const incluirMarca = opts.incluirMarca !== false;
  const labelWidthMm = Math.max(25, Math.min(150, Number(opts.labelWidthMm) || 50));
  const labelHeightMm = Math.max(15, Math.min(200, Number(opts.labelHeightMm) || 30));
  const dpi = Number(opts.dpi) === 300 ? 300 : 203;

  const blocks: PrintBlock[] = [];
  const skusEnvolvidos: string[] = [];

  for (const it of itens) {
    const produto = await s.findOneWhere(rProd, { id: Number(it.produto_id), empresa_id: escopo.empresaId }, tx);
    if (!produto) throw new HttpError(404, `Produto #${it.produto_id} não encontrado nesta empresa.`);
    assertRegistroDaEmpresa(rProd, produto, escopo);

    let tamanhoCodigo: string | null = null;
    let variacao: Row | null = null;
    if (it.tamanho_id != null && Number(it.tamanho_id) > 0) {
      const tam = await s.get(getResource('tamanhos')!, Number(it.tamanho_id), tx);
      if (!tam) throw new HttpError(404, `Tamanho #${it.tamanho_id} não encontrado.`);
      tamanhoCodigo = String(tam.codigo || tam.nome || '').trim() || null;
      variacao = await s.findOneWhere(
        rProd,
        { empresa_id: escopo.empresaId, produto_pai_id: Number(produto.id), variacao_tamanho_id: Number(it.tamanho_id) },
        tx
      );
    }

    let corNome = String(variacao?.cor || produto.cor || '').trim();
    const corId = variacao?.cor_id ?? produto.cor_id;
    if (!corNome && corId) {
      const corRow = await s.findOneWhere(getResource('cores')!, { id: Number(corId), empresa_id: escopo.empresaId }, tx);
      if (corRow?.nome) corNome = String(corRow.nome).trim();
    }

    const skuEfetivo = String(variacao?.sku || produto.sku || `PROD-${produto.id}`).trim();
    const nomeEfetivo = String(produto.nome || variacao?.nome || `Produto #${produto.id}`).trim();
    const precoEfetivo = Number(variacao?.preco_venda ?? produto.preco_venda ?? 0);
    const marca = String(produto.marca || marcaEmpresa).trim().toUpperCase();

    const barcode = resolverCodigoBarrasEtiqueta(
      variacao?.codigo_barras ?? produto.codigo_barras,
      skuEfetivo,
      Number(produto.id),
      tamanhoCodigo
    );

    if (incluirMarca && marca) {
      blocks.push({ kind: 'text', text: marca, align: 'left', emphasis: 'bold', size: 'small' });
    }
    blocks.push({ kind: 'text', text: nomeEfetivo, align: 'left', emphasis: 'title' });

    const metaPartes = [
      `SKU: ${skuEfetivo}`,
      corNome ? `Cor: ${corNome}` : '',
      tamanhoCodigo ? `Tam: ${tamanhoCodigo}` : '',
    ].filter(Boolean);
    blocks.push({ kind: 'text', text: metaPartes.join(' · '), align: 'left', size: 'small' });

    blocks.push({
      kind: 'barcode',
      value: barcode.value,
      symbology: barcode.symbology,
      caption: barcode.value,
    });

    if (incluirPreco && precoEfetivo > 0) {
      blocks.push({ kind: 'text', text: moedaBrl(precoEfetivo), align: 'right', emphasis: 'bold', size: 'large' });
    }

    blocks.push({ kind: 'cut', repeat: Number(it.quantidade) });
    if (!skusEnvolvidos.includes(skuEfetivo)) skusEnvolvidos.push(skuEfetivo);
  }

  const prodIdsUnicos = [...new Set(itens.map((i) => Number(i.produto_id)))];
  const sourceRef = prodIdsUnicos.length === 1 ? `produto:${prodIdsUnicos[0]}` : `lote_produtos:${prodIdsUnicos.slice(0, 5).join(',')}`;

  return {
    blocks,
    totalEtiquetas,
    sourceRef,
    metadata: {
      labelWidthMm,
      labelHeightMm,
      dpi,
      total_labels: totalEtiquetas,
      distinct_items: itens.length,
      skus: skusEnvolvidos.slice(0, 20),
    },
  };
}

/** POST /api/print/etiquetas — enfileira lote/etiquetas térmicas (ZPL ou EPL2). */
export async function imprimirEtiquetasHandler(req: Request, res: Response): Promise<void> {
  const actor: AuthUser = currentUser(req);
  checkAccess(getResource('produtos')!, actor, 'read');
  const escopo = escopoDe(actor);
  const body = (req.body ?? {}) as Record<string, unknown>;

  const rawProto = body.protocol !== undefined && body.protocol !== null && body.protocol !== ''
    ? String(body.protocol).trim().toLowerCase()
    : null;
  if (rawProto && !LABEL_THERMAL_PROTOCOLS.has(rawProto)) {
    throw new HttpError(
      400,
      `Protocolo de etiqueta "${rawProto}" não é suportado. Protocolos térmicos suportados: zpl, epl2.`,
      { code: 'UNSUPPORTED_PROTOCOL' }
    );
  }

  const dest = await resolverDestinoImpressao(escopo.empresaId, 'etiqueta', {
    terminal: body.terminal != null ? String(body.terminal) : null,
    printerName: body.printer_name != null ? String(body.printer_name) : null,
    protocol: rawProto,
  });

  if (!LABEL_THERMAL_PROTOCOLS.has(dest.protocol)) {
    throw new HttpError(
      400,
      `Protocolo "${dest.protocol}" inválido para fila térmica de etiquetas. Configure zpl ou epl2 no terminal ou use impressão A4/PDF.`,
      { code: 'UNSUPPORTED_PROTOCOL' }
    );
  }

  const copies = body.copies !== undefined ? Number(body.copies) : 1;
  const itensBrutos = Array.isArray(body.itens)
    ? (body.itens as ItemEtiquetaEntrada[])
    : body.produto_id
      ? [
          {
            produto_id: Number(body.produto_id),
            tamanho_id: body.tamanho_id != null ? Number(body.tamanho_id) : null,
            quantidade: Number(body.quantidade ?? 1),
          },
        ]
      : [];

  const construido = await construirEtiquetasPrintIR(escopo, itensBrutos, {
    incluirPreco: body.incluir_preco !== false,
    incluirMarca: body.incluir_marca !== false,
    labelWidthMm: body.label_width_mm != null ? Number(body.label_width_mm) : undefined,
    labelHeightMm: body.label_height_mm != null ? Number(body.label_height_mm) : undefined,
    dpi: body.dpi != null ? Number(body.dpi) : undefined,
    copies,
  });

  const idempotencyKey =
    String(body.idempotency_key ?? req.header('idempotency-key') ?? '').trim().slice(0, PRINT_LIMITS.idempotencyKeyMax) ||
    `etiqueta:${escopo.empresaId}:${randomUUID()}`;

  const { job, idempotente } = await enfileirarJob(escopo.empresaId, atorDeUsuario(actor), {
    docType: 'etiqueta_produto',
    source: 'produto',
    sourceRef: construido.sourceRef,
    terminal: dest.terminal,
    printerName: dest.printerName,
    copies,
    priority: 10,
    content: construido.blocks,
    metadata: {
      ...construido.metadata,
      protocol: dest.protocol,
    },
    idempotencyKey,
    maxAttempts: 3,
  });

  if (!idempotente) {
    await auditarImpressao(
      atorDeUsuario(actor),
      'print.labels.queued',
      job,
      `Etiquetas enfileiradas (${construido.totalEtiquetas} un. via ${dest.protocol.toUpperCase()})`,
      { total_etiquetas: construido.totalEtiquetas, protocol: dest.protocol }
    );
  }

  res.status(idempotente ? 200 : 201).json({
    job: jobPublico(job),
    idempotente,
    total_etiquetas: construido.totalEtiquetas,
    protocol: dest.protocol,
    fallback_pdf_url: `/api/print/jobs/${job.public_id}/pdf`,
    fallback_html_url: `/api/print/jobs/${job.public_id}/html`,
  });
}

/** POST /api/produtos/:id/etiquetas — atalho por produto. */
export async function imprimirEtiquetasProdutoHandler(req: Request, res: Response): Promise<void> {
  const produtoId = Number(req.params.id);
  if (!Number.isInteger(produtoId) || produtoId <= 0) throw new HttpError(400, 'ID de produto inválido.');
  const body = (req.body ?? {}) as Record<string, unknown>;
  if (!Array.isArray(body.itens)) {
    req.body = { ...body, produto_id: produtoId };
  }
  await imprimirEtiquetasHandler(req, res);
}
