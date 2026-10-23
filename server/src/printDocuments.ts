// ============================================================================
// printDocuments.ts — Impressão, reimpressão e contingência de documentos ERP (P3 + P5).
//
// Documentos suportados (100% existentes no domínio BroBond ERP):
//   • vendas           -> Pedido de Venda / Orçamento de Venda
//   • compras          -> Pedido de Compra
//   • propostas        -> Proposta Comercial
//   • cotacoes-compra  -> Mapa / Solicitação de Cotação de Compra
//   • ordens           -> Ordem de Produção / Ficha OP
//   • usuarios         -> Ficha Cadastral de Acesso (admin/gerente)
// ============================================================================
import { randomUUID } from 'node:crypto';
import type { Request, Response } from 'express';
import { PRINT_IR_VERSION, PRINT_LIMITS, type PrintIR } from '../../packages/domain/src/print/print-ir';
import { currentUser, type AuthUser } from './auth';
import { assertRegistroDaEmpresa, type EscopoEmpresa } from './empresa';
import { HttpError } from './errors';
import { enviarHtmlSeguro, renderPrintIrHtml, renderPrintIrPdf } from './printFallback';
import { atorDeUsuario, auditarImpressao, enfileirarJob, jobPublico, MAX_COPIAS_REIMPRESSAO, R_JOBS } from './printJobs';
import {
  construirCotacaoCompraPrintIR,
  construirFichaUsuarioPrintIR,
  construirOrdemProducaoPrintIR,
  construirPedidoCompraPrintIR,
  construirPedidoVendaPrintIR,
  construirPropostaComercialPrintIR,
  type DocumentoConstruido,
} from './printTemplates';
import { resolverDestinoImpressao } from './printTerminals';
import { getResource, RESOURCES } from './resources';
import { checkAccess, escopoDe, getStore } from './services';

const TIPOS_VALIDOS = new Set(['vendas', 'compras', 'propostas', 'cotacoes-compra', 'ordens', 'usuarios']);
const PROTOCOLOS_DOC = new Set(['text', 'escpos']);

function validarTipoEId(req: Request): { tipo: string; id: number } {
  const tipo = String(req.params.tipo || '').trim().toLowerCase();
  if (!TIPOS_VALIDOS.has(tipo)) {
    throw new HttpError(400, `Tipo de documento inválido para impressão: "${tipo}".`);
  }
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    throw new HttpError(400, 'ID do documento inválido.');
  }
  return { tipo, id };
}

async function construirDocumentoPorTipo(
  tipo: string,
  id: number,
  actor: AuthUser,
  escopo: EscopoEmpresa
): Promise<DocumentoConstruido> {
  switch (tipo) {
    case 'vendas':
      checkAccess(getResource('vendas')!, actor, 'read');
      return construirPedidoVendaPrintIR(id, escopo);
    case 'compras':
      checkAccess(getResource('compras')!, actor, 'read');
      return construirPedidoCompraPrintIR(id, escopo);
    case 'propostas':
      checkAccess(getResource('propostas')!, actor, 'read');
      return construirPropostaComercialPrintIR(id, escopo);
    case 'cotacoes-compra':
      checkAccess(getResource('cotacoes_compra')!, actor, 'read');
      return construirCotacaoCompraPrintIR(id, escopo);
    case 'ordens':
      checkAccess(getResource('ordens')!, actor, 'read');
      return construirOrdemProducaoPrintIR(id, escopo);
    case 'usuarios':
      return construirFichaUsuarioPrintIR(id, escopo, actor);
    default:
      throw new HttpError(400, `Tipo de documento desconhecido: "${tipo}".`);
  }
}

function montarPrintIrEfemero(
  doc: DocumentoConstruido,
  empresaId: number,
  actor: AuthUser,
  copies = 1
): PrintIR {
  return {
    version: PRINT_IR_VERSION,
    jobId: randomUUID(),
    tenantId: String(empresaId),
    companyId: String(empresaId),
    requestedBy: { userId: actor.id || null, userName: actor.name },
    source: doc.source,
    docType: doc.docType,
    related: doc.related,
    copies,
    priority: 0,
    content: doc.blocks,
    metadata: doc.metadata,
    idempotencyKey: `preview:${doc.sourceRef}`,
    createdAt: new Date().toISOString(),
  };
}

/** POST /api/print/documentos/:tipo/:id — enfileira impressão de documento ERP. */
export async function imprimirDocumentoHandler(req: Request, res: Response): Promise<void> {
  const actor = currentUser(req);
  const escopo = escopoDe(actor);
  const { tipo, id } = validarTipoEId(req);
  const body = (req.body ?? {}) as Record<string, unknown>;

  const doc = await construirDocumentoPorTipo(tipo, id, actor, escopo);
  const rawProto = body.protocol != null && body.protocol !== '' ? String(body.protocol).trim().toLowerCase() : null;
  if (rawProto && !PROTOCOLOS_DOC.has(rawProto)) {
    throw new HttpError(400, `Protocolo "${rawProto}" inválido para fila de documentos (use escpos ou text, ou contingência PDF/HTML).`);
  }

  const dest = await resolverDestinoImpressao(escopo.empresaId, 'documento', {
    terminal: body.terminal != null ? String(body.terminal) : null,
    printerName: body.printer_name != null ? String(body.printer_name) : null,
    protocol: rawProto,
  });

  const copies = body.copies !== undefined ? Number(body.copies) : dest.copiesDefault;
  if (!Number.isInteger(copies) || copies < 1 || copies > MAX_COPIAS_REIMPRESSAO) {
    throw new HttpError(400, `Número de cópias deve ser um inteiro entre 1 e ${MAX_COPIAS_REIMPRESSAO}.`);
  }

  const idempotencyKey =
    String(body.idempotency_key ?? req.header('idempotency-key') ?? '').trim().slice(0, PRINT_LIMITS.idempotencyKeyMax) ||
    `doc:${doc.sourceRef}:${randomUUID()}`;

  const protocolEfetivo = PROTOCOLOS_DOC.has(dest.protocol) ? dest.protocol : 'text';

  const { job, idempotente } = await enfileirarJob(escopo.empresaId, atorDeUsuario(actor), {
    docType: doc.docType,
    source: doc.source,
    sourceRef: doc.sourceRef,
    terminal: dest.terminal,
    printerName: dest.printerName,
    copies,
    priority: 5,
    content: doc.blocks,
    metadata: {
      ...doc.metadata,
      protocol: protocolEfetivo,
    },
    idempotencyKey,
    maxAttempts: 3,
  });

  res.status(idempotente ? 200 : 201).json({
    job: jobPublico(job),
    idempotente,
    fallback_pdf_url: (doc.metadata.fallback_pdf_url as string) || `/api/print/documentos/${tipo}/${id}/pdf`,
    fallback_html_url: `/api/print/documentos/${tipo}/${id}/html`,
  });
}

/** POST /api/print/documentos/:tipo/:id/reimprimir — reimpressão auditada de documento ERP. */
export async function reimprimirDocumentoHandler(req: Request, res: Response): Promise<void> {
  const actor = currentUser(req);
  const escopo = escopoDe(actor);
  const { tipo, id } = validarTipoEId(req);
  const body = (req.body ?? {}) as Record<string, unknown>;

  const doc = await construirDocumentoPorTipo(tipo, id, actor, escopo);
  const rawProto = body.protocol != null && body.protocol !== '' ? String(body.protocol).trim().toLowerCase() : null;
  if (rawProto && !PROTOCOLOS_DOC.has(rawProto)) {
    throw new HttpError(400, `Protocolo "${rawProto}" inválido para fila de documentos.`);
  }

  const dest = await resolverDestinoImpressao(escopo.empresaId, 'documento', {
    terminal: body.terminal != null ? String(body.terminal) : null,
    printerName: body.printer_name != null ? String(body.printer_name) : null,
    protocol: rawProto,
  });

  if (actor.perfil === 'operador' && !dest.allowOperatorReprint) {
    throw new HttpError(403, 'Reimpressão neste terminal exige perfil gerente ou administrador.');
  }

  const copies = body.copies !== undefined ? Number(body.copies) : dest.copiesDefault;
  if (!Number.isInteger(copies) || copies < 1 || copies > MAX_COPIAS_REIMPRESSAO) {
    throw new HttpError(400, `Número de cópias deve ser um inteiro entre 1 e ${MAX_COPIAS_REIMPRESSAO}.`);
  }

  const motivo = String(body.motivo ?? body.reprint_reason ?? '').trim().slice(0, 240) || null;
  const s = getStore();
  const anteriores = await s.list(R_JOBS(), {
    page: 1,
    pageSize: 5,
    filter: { empresa_id: escopo.empresaId, source_ref: doc.sourceRef },
    sort: 'criado_em',
    dir: 'desc',
  });
  const jobOrigem = anteriores.rows[0] ?? null;
  const reprintOf = jobOrigem ? String(jobOrigem.reprint_of || jobOrigem.public_id) : `doc:${doc.sourceRef}`;

  const idempotencyKey =
    String(body.idempotency_key ?? req.header('idempotency-key') ?? '').trim().slice(0, PRINT_LIMITS.idempotencyKeyMax) ||
    `reprint:doc:${doc.sourceRef}:${randomUUID()}`;

  const protocolEfetivo = PROTOCOLOS_DOC.has(dest.protocol) ? dest.protocol : 'text';

  const { job, idempotente } = await enfileirarJob(
    escopo.empresaId,
    atorDeUsuario(actor),
    {
      docType: doc.docType,
      source: doc.source,
      sourceRef: doc.sourceRef,
      terminal: dest.terminal,
      printerName: dest.printerName,
      copies,
      priority: 5,
      content: doc.blocks,
      metadata: {
        ...doc.metadata,
        protocol: protocolEfetivo,
        reprint: true,
        ...(motivo ? { reprint_reason: motivo } : {}),
      },
      idempotencyKey,
      maxAttempts: 3,
    },
    { reprintOf, reprintReason: motivo }
  );

  if (!idempotente) {
    await auditarImpressao(
      atorDeUsuario(actor),
      'print.document.reprinted',
      job,
      motivo ? `Reimpressão de ${doc.titulo} (${motivo})` : `Reimpressão de ${doc.titulo}`,
      { origem: reprintOf, source_ref: doc.sourceRef, motivo: motivo ?? undefined, copies }
    );
  }

  res.status(idempotente ? 200 : 201).json({
    job: jobPublico(job),
    idempotente,
    fallback_pdf_url: (doc.metadata.fallback_pdf_url as string) || `/api/print/documentos/${tipo}/${id}/pdf`,
    fallback_html_url: `/api/print/documentos/${tipo}/${id}/html`,
  });
}

/** GET /api/print/documentos/:tipo/:id/html — contingência HTML do documento ERP. */
export async function fallbackDocumentoHtmlHandler(req: Request, res: Response): Promise<void> {
  const actor = currentUser(req);
  const escopo = escopoDe(actor);
  const { tipo, id } = validarTipoEId(req);
  const copies = Math.max(1, Math.min(10, Number(req.query.copies) || 1));
  const doc = await construirDocumentoPorTipo(tipo, id, actor, escopo);
  const ir = montarPrintIrEfemero(doc, escopo.empresaId, actor, copies);
  const html = await renderPrintIrHtml(ir, { title: doc.titulo });
  enviarHtmlSeguro(res, html);
}

/** GET /api/print/documentos/:tipo/:id/pdf — contingência PDF do documento ERP. */
export async function fallbackDocumentoPdfHandler(req: Request, res: Response): Promise<void> {
  const actor = currentUser(req);
  const escopo = escopoDe(actor);
  const { tipo, id } = validarTipoEId(req);
  const copies = Math.max(1, Math.min(10, Number(req.query.copies) || 1));
  const doc = await construirDocumentoPorTipo(tipo, id, actor, escopo);
  const ir = montarPrintIrEfemero(doc, escopo.empresaId, actor, copies);
  await renderPrintIrPdf(ir, res, `${tipo}-${id}.pdf`);
}

/** POST /api/print/terminals/:id/teste — página diagnóstica de teste no terminal. */
export async function imprimirTesteTerminalHandler(req: Request, res: Response): Promise<void> {
  const actor = currentUser(req);
  if (actor.perfil !== 'admin' && actor.perfil !== 'gerente') {
    throw new HttpError(403, 'Apenas administradores e gerentes podem disparar teste de terminal.');
  }
  const escopo = escopoDe(actor);
  const s = getStore();
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, 'ID de terminal inválido.');

  const term = await s.findOneWhere(RESOURCES.print_terminals, { id, empresa_id: escopo.empresaId });
  if (!term) throw new HttpError(404, 'Terminal não encontrado.');
  assertRegistroDaEmpresa(RESOURCES.print_terminals, term, escopo);

  const usoRaw = String((req.body as any)?.uso || 'recibo').trim().toLowerCase();
  const uso = usoRaw === 'etiqueta' ? 'etiqueta' : usoRaw === 'documento' ? 'documento' : 'recibo';
  const dest = await resolverDestinoImpressao(escopo.empresaId, uso, { terminal: String(term.codigo) });

  const protocol = uso === 'etiqueta' ? (dest.protocol === 'epl2' ? 'epl2' : 'zpl') : dest.protocol === 'escpos' ? 'escpos' : 'text';
  const agoraStr = new Date().toISOString();

  const { job } = await enfileirarJob(escopo.empresaId, atorDeUsuario(actor), {
    docType: uso === 'etiqueta' ? 'etiqueta_produto' : 'teste',
    source: 'sistema',
    sourceRef: `terminal:${term.codigo}`,
    terminal: String(term.codigo),
    printerName: dest.printerName,
    copies: 1,
    priority: 20,
    content: [
      { kind: 'text', text: 'BROBOND ERP — TESTE DE IMPRESSÃO', align: 'center', emphasis: 'title' },
      { kind: 'separator' },
      { kind: 'kv', label: 'Terminal', value: `${term.codigo} (${term.nome})` },
      { kind: 'kv', label: 'Função testada', value: uso.toUpperCase() },
      { kind: 'kv', label: 'Protocolo', value: protocol.toUpperCase() },
      { kind: 'kv', label: 'Impressora', value: dest.printerName || '(padrão do agente)' },
      { kind: 'kv', label: 'Data/Hora', value: agoraStr },
      { kind: 'barcode', value: '7891000315507', symbology: 'ean13', caption: '7891000315507' },
      { kind: 'cut' },
    ],
    metadata: {
      protocol,
      widthCols: dest.widthCols,
      labelWidthMm: 50,
      labelHeightMm: 30,
      teste_terminal_id: id,
    },
    idempotencyKey: `teste:terminal:${id}:${uso}:${randomUUID()}`,
    maxAttempts: 2,
  });

  res.status(201).json({ job: jobPublico(job) });
}
