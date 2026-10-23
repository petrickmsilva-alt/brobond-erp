// ============================================================================
// printFallback.ts — Contingência segura HTML e PDF a partir do PrintIR (P2/P3/P4/P6).
//
// Quando o agente local ou a impressora térmica estiver offline, qualquer job
// ou documento pode ser aberto em HTML sanitizado (CSP restritiva, sem CDN/URL
// externa, zero XSS/SSRF) ou baixado em PDF gerado no servidor (pdfkit).
// ============================================================================
import type { Request, Response } from 'express';
import PDFDocument from 'pdfkit';
import QRCode from 'qrcode';
import { stripAsciiControl, type PrintBlock, type PrintIR } from '../../packages/domain/src/print/print-ir';
import { jobParaPrintIR } from './printIr';
import { obterJobDoUsuario } from './printJobs';

export function escapeHtmlStrict(raw: unknown): string {
  const s = stripAsciiControl(String(raw ?? ''), true);
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function stripCtrlPdf(raw: unknown): string {
  return stripAsciiControl(String(raw ?? ''), true);
}

async function qrDataUriSafe(value: string): Promise<string | null> {
  const clean = stripCtrlPdf(value).trim();
  if (!clean || clean.length > 1024) return null;
  try {
    return await QRCode.toDataURL(clean, { errorCorrectionLevel: 'M', margin: 1, width: 140 });
  } catch {
    return null;
  }
}

type SectionPage = { blocks: PrintBlock[]; repeat: number };

function splitIrSections(blocks: PrintBlock[]): SectionPage[] {
  const pages: SectionPage[] = [];
  let cur: PrintBlock[] = [];
  for (const b of blocks) {
    if (b.kind === 'cut') {
      if (cur.length > 0) {
        pages.push({ blocks: cur, repeat: Math.max(1, Math.min(200, b.repeat ?? 1)) });
        cur = [];
      }
      continue;
    }
    cur.push(b);
  }
  if (cur.length > 0) pages.push({ blocks: cur, repeat: 1 });
  return pages;
}

async function renderBlocksToHtml(blocks: PrintBlock[]): Promise<string> {
  const parts: string[] = [];
  for (const b of blocks) {
    switch (b.kind) {
      case 'text': {
        const align = b.align === 'center' ? 'center' : b.align === 'right' ? 'right' : 'left';
        const cls = [
          'blk-text',
          b.emphasis === 'title' ? 'emp-title' : b.emphasis === 'bold' ? 'emp-bold' : '',
          b.size === 'large' ? 'sz-large' : b.size === 'small' ? 'sz-small' : '',
        ]
          .filter(Boolean)
          .join(' ');
        parts.push(`<div class="${cls}" style="text-align:${align}">${escapeHtmlStrict(b.text).replace(/\n/g, '<br>')}</div>`);
        break;
      }
      case 'kv':
        parts.push(
          `<div class="blk-kv"><span class="kv-label">${escapeHtmlStrict(b.label)}</span><span class="kv-val">${escapeHtmlStrict(b.value)}</span></div>`
        );
        break;
      case 'separator':
        parts.push('<hr class="blk-sep" />');
        break;
      case 'spacer': {
        const h = Math.max(0, Math.min(20, b.lines ?? 1)) * 8;
        if (h > 0) parts.push(`<div style="height:${h}px"></div>`);
        break;
      }
      case 'table': {
        const ths = b.columns
          .map((c) => {
            const al = c.align === 'right' ? 'right' : c.align === 'center' ? 'center' : 'left';
            return `<th style="text-align:${al}">${escapeHtmlStrict(c.header)}</th>`;
          })
          .join('');
        const trs = b.rows
          .map(
            (r) =>
              `<tr>${r
                .map((cell, i) => {
                  const al = b.columns[i]?.align === 'right' ? 'right' : b.columns[i]?.align === 'center' ? 'center' : 'left';
                  return `<td style="text-align:${al}">${escapeHtmlStrict(cell)}</td>`;
                })
                .join('')}</tr>`
          )
          .join('');
        parts.push(`<table class="blk-table"><thead><tr>${ths}</tr></thead><tbody>${trs}</tbody></table>`);
        break;
      }
      case 'barcode': {
        parts.push(
          `<div class="blk-barcode"><div class="barcode-bars" aria-hidden="true">|| ||| | |||| || | ||| || |||| | ||</div><div class="barcode-code">${escapeHtmlStrict(b.caption || b.value)}</div></div>`
        );
        break;
      }
      case 'qrcode': {
        const uri = await qrDataUriSafe(b.value);
        parts.push(
          `<div class="blk-qr">${uri ? `<img src="${uri}" alt="QR Code" width="120" height="120" />` : ''}<div>${escapeHtmlStrict(b.caption || b.value)}</div></div>`
        );
        break;
      }
      case 'cut':
        break;
    }
  }
  return parts.join('\n');
}

export async function renderPrintIrHtml(ir: PrintIR, opts: { title?: string } = {}): Promise<string> {
  const isReceipt = ir.docType === 'recibo_pdv';
  const isLabel = ir.docType === 'etiqueta_produto';
  const title = escapeHtmlStrict(opts.title || `BroBond ERP — Impressão (${ir.docType})`);
  const pages = splitIrSections(ir.content);
  const copies = Math.max(1, Math.min(20, Number(ir.copies) || 1));

  const renderedSections: string[] = [];
  let count = 0;
  for (let c = 0; c < copies && count < 500; c++) {
    for (const p of pages) {
      const htmlInner = await renderBlocksToHtml(p.blocks);
      for (let r = 0; r < p.repeat && count < 500; r++) {
        count++;
        renderedSections.push(`<section class="print-unit">${htmlInner}</section>`);
      }
    }
  }

  const pageCss = isReceipt
    ? `@page { size: 80mm auto; margin: 4mm; }
       body { font-family: 'Courier New', Courier, monospace; font-size: 12px; background: #f8fafc; color: #0f172a; margin: 0; padding: 16px; }
       .sheet { max-width: 76mm; margin: 0 auto; background: #fff; padding: 12px; border: 1px solid #cbd5e1; border-radius: 6px; }
       .print-unit + .print-unit { border-top: 2px dashed #94a3b8; margin-top: 16px; padding-top: 16px; page-break-before: always; }`
    : isLabel
      ? `@page { size: A4 portrait; margin: 8mm; }
         body { font-family: system-ui, -apple-system, sans-serif; font-size: 11px; background: #f8fafc; color: #0f172a; margin: 0; padding: 16px; }
         .sheet { max-width: 194mm; margin: 0 auto; display: grid; grid-template-columns: repeat(3, 1fr); gap: 4mm; }
         .print-unit { background: #fff; border: 1px dashed #94a3b8; border-radius: 4px; padding: 3mm; break-inside: avoid; }`
      : `@page { size: A4 portrait; margin: 12mm; }
         body { font-family: system-ui, -apple-system, sans-serif; font-size: 12px; background: #f8fafc; color: #0f172a; margin: 0; padding: 20px; }
         .sheet { max-width: 190mm; margin: 0 auto; background: #fff; padding: 20px 24px; border: 1px solid #e2e8f0; border-radius: 8px; }
         .print-unit + .print-unit { page-break-before: always; margin-top: 24px; padding-top: 24px; border-top: 1px dashed #cbd5e1; }`;

  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${title}</title>
  <style>
    ${pageCss}
    .toolbar { max-width: 190mm; margin: 0 auto 12px; display: flex; justify-content: space-between; align-items: center; font-family: system-ui, sans-serif; font-size: 12px; color: #475569; }
    .blk-text { margin: 2px 0; line-height: 1.35; }
    .emp-bold { font-weight: 700; }
    .emp-title { font-weight: 800; font-size: 1.18em; letter-spacing: 0.02em; margin: 4px 0; }
    .sz-large { font-size: 1.25em; font-weight: 700; }
    .sz-small { font-size: 0.88em; color: #334155; }
    .blk-kv { display: flex; justify-content: space-between; gap: 12px; margin: 2px 0; line-height: 1.35; }
    .kv-label { color: #334155; }
    .kv-val { font-weight: 600; text-align: right; }
    .blk-sep { border: 0; border-top: 1px dashed #94a3b8; margin: 6px 0; }
    .blk-table { width: 100%; border-collapse: collapse; margin: 6px 0; font-size: 0.94em; }
    .blk-table th { border-bottom: 1px solid #64748b; padding: 4px 3px; font-weight: 700; }
    .blk-table td { border-bottom: 1px dotted #e2e8f0; padding: 4px 3px; vertical-align: top; }
    .blk-barcode { text-align: center; margin: 6px 0; }
    .barcode-bars { font-family: monospace; font-size: 16px; letter-spacing: -1px; font-weight: 900; color: #0f172a; }
    .barcode-code { font-family: monospace; font-size: 11px; margin-top: 2px; }
    .blk-qr { text-align: center; margin: 8px 0; font-size: 10px; }
    @media print {
      body { background: #fff; padding: 0; }
      .toolbar { display: none !important; }
      .sheet { border: none; padding: 0; max-width: none; }
    }
  </style>
</head>
<body>
  <div class="toolbar">
    <span>Contingência de impressão · Job <strong>${escapeHtmlStrict(ir.jobId)}</strong></span>
    <span>Use Ctrl+P / Imprimir do navegador para enviar à impressora local</span>
  </div>
  <main class="sheet">
    ${renderedSections.join('\n')}
  </main>
</body>
</html>`;
}

export function enviarHtmlSeguro(res: Response, html: string): void {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'none'; style-src 'unsafe-inline'; img-src data:; frame-ancestors 'self'; base-uri 'none'; form-action 'none'"
  );
  res.send(html);
}

export async function renderPrintIrPdf(ir: PrintIR, res: Response, filename: string): Promise<void> {
  const safeFile = filename.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 80) || 'impressao.pdf';
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${safeFile}"`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'no-store');

  const isReceipt = ir.docType === 'recibo_pdv';
  const isLabel = ir.docType === 'etiqueta_produto';
  const pages = splitIrSections(ir.content);
  const copies = Math.max(1, Math.min(20, Number(ir.copies) || 1));

  const pageSize: [number, number] | 'A4' = isReceipt
    ? [226.77, 841.89] // 80mm largura
    : isLabel
      ? [
          Math.round((Math.max(25, Math.min(150, Number(ir.metadata?.labelWidthMm) || 50)) * 72) / 25.4),
          Math.round((Math.max(15, Math.min(200, Number(ir.metadata?.labelHeightMm) || 30)) * 72) / 25.4),
        ]
      : 'A4';

  const margin = isReceipt ? 12 : isLabel ? 6 : 36;
  const doc = new PDFDocument({ size: pageSize, margin, autoFirstPage: false });

  await new Promise<void>((resolve, reject) => {
    doc.on('error', reject);
    res.on('finish', resolve);
    res.on('error', reject);
    doc.pipe(res);

    let totalUnits = 0;
    for (let c = 0; c < copies && totalUnits < 500; c++) {
      for (const p of pages) {
        for (let r = 0; r < p.repeat && totalUnits < 500; r++) {
          totalUnits++;
          doc.addPage({ size: pageSize, margin });
          const usableW = doc.page.width - margin * 2;

          for (const b of p.blocks) {
            switch (b.kind) {
              case 'text': {
                const sz = b.size === 'large' ? (isLabel ? 11 : 13) : b.size === 'small' ? (isLabel ? 7 : 8) : isLabel ? 8.5 : 10;
                const bold = b.emphasis === 'bold' || b.emphasis === 'title' || b.size === 'large';
                doc
                  .font(bold ? 'Helvetica-Bold' : 'Helvetica')
                  .fontSize(b.emphasis === 'title' ? sz + 1.5 : sz)
                  .fillColor('#0f172a')
                  .text(stripCtrlPdf(b.text), { width: usableW, align: b.align || 'left' });
                break;
              }
              case 'kv': {
                const sz = isLabel ? 7.5 : isReceipt ? 8.5 : 9.5;
                const startY = doc.y;
                doc.font('Helvetica').fontSize(sz).fillColor('#334155').text(stripCtrlPdf(b.label), margin, startY, {
                  width: usableW * 0.58,
                  align: 'left',
                });
                const leftEndY = doc.y;
                doc.font('Helvetica-Bold').fontSize(sz).fillColor('#0f172a').text(stripCtrlPdf(b.value), margin + usableW * 0.58, startY, {
                  width: usableW * 0.42,
                  align: 'right',
                });
                doc.y = Math.max(leftEndY, doc.y);
                doc.x = margin;
                break;
              }
              case 'separator': {
                const y = doc.y + 3;
                doc
                  .save()
                  .moveTo(margin, y)
                  .lineTo(margin + usableW, y)
                  .lineWidth(0.5)
                  .dash(2, { space: 2 })
                  .strokeColor('#64748b')
                  .stroke()
                  .undash()
                  .restore();
                doc.y = y + 5;
                break;
              }
              case 'spacer': {
                doc.moveDown(Math.max(0, Math.min(5, (b.lines ?? 1) * 0.4)));
                break;
              }
              case 'table': {
                const n = b.columns.length;
                const colW = usableW / Math.max(1, n);
                const sz = isReceipt ? 7.5 : 8.5;
                let rowY = doc.y + 2;
                doc.font('Helvetica-Bold').fontSize(sz).fillColor('#0f172a');
                b.columns.forEach((col, idx) => {
                  doc.text(stripCtrlPdf(col.header), margin + idx * colW, rowY, {
                    width: colW - 2,
                    align: col.align || 'left',
                  });
                });
                rowY = doc.y + 3;
                doc.moveTo(margin, rowY).lineTo(margin + usableW, rowY).lineWidth(0.5).strokeColor('#94a3b8').stroke();
                rowY += 3;
                doc.font('Helvetica').fontSize(sz).fillColor('#1e293b');
                for (const row of b.rows) {
                  if (rowY > doc.page.height - margin - 24) {
                    doc.addPage({ size: pageSize, margin });
                    rowY = margin;
                  }
                  let maxNextY = rowY;
                  row.forEach((cell, idx) => {
                    doc.text(stripCtrlPdf(cell), margin + idx * colW, rowY, {
                      width: colW - 2,
                      align: b.columns[idx]?.align || 'left',
                    });
                    if (doc.y > maxNextY) maxNextY = doc.y;
                  });
                  rowY = maxNextY + 2;
                }
                doc.y = rowY + 2;
                doc.x = margin;
                break;
              }
              case 'barcode': {
                const sz = isLabel ? 8 : 9;
                doc.moveDown(0.2);
                doc
                  .font('Courier-Bold')
                  .fontSize(sz)
                  .fillColor('#0f172a')
                  .text(`|| ${stripCtrlPdf(b.caption || b.value)} ||`, margin, doc.y, { width: usableW, align: 'center' });
                break;
              }
              case 'qrcode': {
                doc
                  .font('Courier')
                  .fontSize(7.5)
                  .fillColor('#334155')
                  .text(`[QR] ${stripCtrlPdf(b.caption || b.value)}`, margin, doc.y, { width: usableW, align: 'center' });
                break;
              }
              case 'cut':
                break;
            }
          }
        }
      }
    }
    doc.end();
  });
}

/** GET /api/print/jobs/:id/html — contingência HTML do job para o navegador. */
export async function fallbackHtmlJobHandler(req: Request, res: Response): Promise<void> {
  const { job } = await obterJobDoUsuario(req);
  const ir = jobParaPrintIR(job);
  const html = await renderPrintIrHtml(ir, { title: `Job ${job.public_id} (${job.doc_type})` });
  enviarHtmlSeguro(res, html);
}

/** GET /api/print/jobs/:id/pdf — contingência PDF do job gerada no servidor. */
export async function fallbackPdfJobHandler(req: Request, res: Response): Promise<void> {
  const { job } = await obterJobDoUsuario(req);
  const ir = jobParaPrintIR(job);
  await renderPrintIrPdf(ir, res, `${String(job.doc_type)}-${String(job.public_id).slice(0, 8)}.pdf`);
}
