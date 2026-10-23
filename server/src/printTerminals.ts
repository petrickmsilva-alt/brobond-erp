// ============================================================================
// printTerminals.ts — Configuração multi-impressora por terminal (P5).
//
// Cada empresa pode ter múltiplos terminais operacionais (CAIXA-1, CAIXA-2,
// EXPEDICAO, ESTOQUE, ESCRITORIO), cada um com sua impressora padrão, de
// recibo (ESC/POS), de etiquetas (ZPL/EPL2/A4), de documentos (PDF/ESC/POS) e
// política de contingência e reimpressão.
// ============================================================================
import type { Request, Response } from 'express';
import { hasAsciiControl, isSafePrinterName, PRINT_LIMITS } from '../../packages/domain/src/print/print-ir';
import { currentUser, type AuthUser } from './auth';
import { assertRegistroDaEmpresa } from './empresa';
import { HttpError } from './errors';
import { RESOURCES } from './resources';
import { checkFluxo, escopoDe, getStore } from './services';
import type { Row, Tx } from './store';

const R_TERMINALS = () => RESOURCES.print_terminals;
const R_AGENTS = () => RESOURCES.print_agents;

const CODIGO_TERMINAL_RE = /^[A-Za-z0-9][A-Za-z0-9_\-.]{0,59}$/;
const RECEIPT_PROTOCOLS = new Set(['escpos', 'text']);
const LABEL_PROTOCOLS = new Set(['zpl', 'epl2', 'a4']);
const DOC_PROTOCOLS = new Set(['pdf', 'escpos', 'text']);
const FALLBACK_MODES = new Set(['browser_pdf', 'browser_html', 'queue_only', 'none']);
const VALID_WIDTH_COLS = new Set([32, 42, 48]);

function exigirAdminImpressao(actor: AuthUser): void {
  if (actor.perfil !== 'admin' && actor.perfil !== 'gerente') {
    throw new HttpError(403, 'Apenas administradores e gerentes podem configurar terminais de impressão.');
  }
}

export function normalizarCodigoTerminal(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  const s = String(v).trim().toUpperCase();
  if (!s) return null;
  if (!CODIGO_TERMINAL_RE.test(s)) {
    throw new HttpError(400, 'Código do terminal inválido (use letras, números, hífen ou sublinhado, máx. 60 caracteres).');
  }
  return s;
}

export function validarNomeImpressoraOpcional(v: unknown, rotulo = 'Impressora'): string | null {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  if (!s) return null;
  if (!isSafePrinterName(s)) {
    throw new HttpError(
      400,
      `${rotulo} inválida: use nome do spooler (sem barras, '..' ou metacaracteres) ou tcp://host:porta (máx. ${PRINT_LIMITS.printerNameMax} caracteres).`
    );
  }
  return s;
}

export function terminalPublico(t: Row, agente?: Row | null) {
  const hb = agente?.last_heartbeat_at ? Date.parse(String(agente.last_heartbeat_at)) : 0;
  const online = Boolean(agente && agente.status === 'ativo' && hb > 0 && Date.now() - hb <= 120_000);
  return {
    id: Number(t.id),
    codigo: String(t.codigo),
    nome: String(t.nome),
    agent_id: t.agent_id != null ? Number(t.agent_id) : null,
    agent_nome: agente ? String(agente.nome || agente.machine_id) : null,
    agent_machine_id: agente ? String(agente.machine_id) : null,
    agent_online: online,
    agent_printers: Array.isArray(agente?.printers) ? agente!.printers : [],
    default_printer: (t.default_printer as string) ?? null,
    receipt_printer: (t.receipt_printer as string) ?? null,
    receipt_protocol: String(t.receipt_protocol || 'escpos'),
    receipt_width_cols: Number(t.receipt_width_cols || 48),
    label_printer: (t.label_printer as string) ?? null,
    label_protocol: String(t.label_protocol || 'zpl'),
    document_printer: (t.document_printer as string) ?? null,
    document_protocol: String(t.document_protocol || 'pdf'),
    fallback_mode: String(t.fallback_mode || 'browser_pdf'),
    auto_print_pdv: t.auto_print_pdv !== false,
    allow_operator_reprint: t.allow_operator_reprint !== false,
    copies_recibo: Number(t.copies_recibo || 1),
    copies_documento: Number(t.copies_documento || 1),
    ativo: t.ativo !== false,
    criado_em: t.criado_em,
    atualizado_em: t.atualizado_em ?? null,
  };
}

export type UsoImpressao = 'recibo' | 'etiqueta' | 'documento' | 'padrao';

export type DestinoImpressaoResolvido = {
  terminal: string | null;
  terminalConfig: Row | null;
  printerName: string | null;
  protocol: string;
  widthCols: number;
  fallbackMode: string;
  autoPrintPdv: boolean;
  allowOperatorReprint: boolean;
  copiesDefault: number;
};

/**
 * Resolve terminal, impressora física e protocolo para uma solicitação de
 * impressão da empresa, sem assumir impressora única.
 */
export async function resolverDestinoImpressao(
  empresaId: number,
  uso: UsoImpressao,
  opts: {
    terminal?: string | null;
    printerName?: string | null;
    protocol?: string | null;
    tx?: Tx;
  } = {}
): Promise<DestinoImpressaoResolvido> {
  const s = getStore();
  const termPed = opts.terminal ? String(opts.terminal).trim() : '';
  const printerOverride = validarNomeImpressoraOpcional(opts.printerName, 'Impressora');
  const protoOverride = opts.protocol ? String(opts.protocol).trim().toLowerCase() : '';

  let termRow: Row | null = null;
  if (termPed) {
    // Busca tolerante a caixa (ex.: "Caixa 1" do PDV ou "CAIXA-1" cadastrado)
    const { rows } = await s.list(
      R_TERMINALS(),
      { page: 1, pageSize: 100, filter: { empresa_id: empresaId } },
      opts.tx
    );
    const upper = termPed.toUpperCase();
    const slug = upper.replace(/\s+/g, '-');
    termRow =
      rows.find((r) => r.ativo !== false && (String(r.codigo).toUpperCase() === upper || String(r.codigo).toUpperCase() === slug || String(r.nome).toUpperCase() === upper)) ??
      null;
  } else {
    const { rows } = await s.list(
      R_TERMINALS(),
      { page: 1, pageSize: 10, filter: { empresa_id: empresaId, ativo: true } },
      opts.tx
    );
    if (rows.length === 1) {
      termRow = rows[0];
    }
  }

  let defaultProto = 'text';
  if (uso === 'recibo') defaultProto = String(termRow?.receipt_protocol || 'escpos');
  else if (uso === 'etiqueta') {
    const lp = String(termRow?.label_protocol || 'zpl');
    defaultProto = lp === 'a4' ? 'zpl' : lp;
  } else if (uso === 'documento') {
    const dp = String(termRow?.document_protocol || 'text');
    defaultProto = dp === 'pdf' ? 'text' : dp;
  }

  const protocol = protoOverride || defaultProto;
  let usoPrinter: string | null = null;
  if (termRow) {
    if (uso === 'recibo') usoPrinter = (termRow.receipt_printer as string) || (termRow.default_printer as string) || null;
    else if (uso === 'etiqueta') usoPrinter = (termRow.label_printer as string) || (termRow.default_printer as string) || null;
    else if (uso === 'documento') usoPrinter = (termRow.document_printer as string) || (termRow.default_printer as string) || null;
    else usoPrinter = (termRow.default_printer as string) || null;
  }

  // Importante para compatibilidade com agentes pareados: se o terminal do PDV
  // (ex.: caixa "1") não tem configuração explícita nem agente exclusivo com
  // aquele código, só carimba `terminal` no job quando o cliente pediu ou
  // quando há agente ativo naquele terminal — evitando travar fila de loja com
  // um único agente sem terminal fixo.
  let resolvedTerminal: string | null = termRow ? String(termRow.codigo) : termPed || null;
  if (!termRow && termPed && !opts.terminal) {
    resolvedTerminal = null;
  }

  return {
    terminal: resolvedTerminal,
    terminalConfig: termRow,
    printerName: printerOverride || usoPrinter || null,
    protocol,
    widthCols: Number(termRow?.receipt_width_cols || 48),
    fallbackMode: String(termRow?.fallback_mode || 'browser_pdf'),
    autoPrintPdv: termRow ? termRow.auto_print_pdv !== false : true,
    allowOperatorReprint: termRow ? termRow.allow_operator_reprint !== false : true,
    copiesDefault:
      uso === 'recibo'
        ? Math.max(1, Math.min(10, Number(termRow?.copies_recibo || 1)))
        : uso === 'documento'
          ? Math.max(1, Math.min(10, Number(termRow?.copies_documento || 1)))
          : 1,
  };
}

async function validarPayloadTerminal(
  empresaId: number,
  body: Record<string, unknown>,
  parcial: boolean
): Promise<Record<string, unknown>> {
  const s = getStore();
  const patch: Record<string, unknown> = {};

  if (!parcial || body.codigo !== undefined) {
    const codigo = normalizarCodigoTerminal(body.codigo);
    if (!codigo) throw new HttpError(400, 'Informe o código do terminal (ex.: CAIXA-1).');
    patch.codigo = codigo;
  }

  if (!parcial || body.nome !== undefined) {
    const nome = String(body.nome ?? '').trim().slice(0, 120);
    if (!nome || hasAsciiControl(nome)) throw new HttpError(400, 'Informe o nome do terminal.');
    patch.nome = nome;
  }

  if (body.agent_id !== undefined) {
    if (body.agent_id === null || body.agent_id === '') {
      patch.agent_id = null;
    } else {
      const aid = Number(body.agent_id);
      if (!Number.isInteger(aid) || aid <= 0) throw new HttpError(400, 'agent_id inválido.');
      const ag = await s.findOneWhere(R_AGENTS(), { id: aid, empresa_id: empresaId });
      if (!ag) throw new HttpError(404, 'Agente informado não pertence a esta empresa.');
      patch.agent_id = aid;
    }
  }

  for (const [k, label] of [
    ['default_printer', 'Impressora padrão'],
    ['receipt_printer', 'Impressora de recibo'],
    ['label_printer', 'Impressora de etiquetas'],
    ['document_printer', 'Impressora de documentos'],
  ] as const) {
    if (body[k] !== undefined) {
      patch[k] = validarNomeImpressoraOpcional(body[k], label);
    }
  }

  if (body.receipt_protocol !== undefined) {
    const v = String(body.receipt_protocol).trim().toLowerCase();
    if (!RECEIPT_PROTOCOLS.has(v)) throw new HttpError(400, 'Protocolo de recibo inválido (use escpos ou text).');
    patch.receipt_protocol = v;
  } else if (!parcial) patch.receipt_protocol = 'escpos';

  if (body.receipt_width_cols !== undefined) {
    const v = Number(body.receipt_width_cols);
    if (!VALID_WIDTH_COLS.has(v)) throw new HttpError(400, 'Largura do cupom inválida (use 32, 42 ou 48 colunas).');
    patch.receipt_width_cols = v;
  } else if (!parcial) patch.receipt_width_cols = 48;

  if (body.label_protocol !== undefined) {
    const v = String(body.label_protocol).trim().toLowerCase();
    if (!LABEL_PROTOCOLS.has(v)) throw new HttpError(400, 'Protocolo de etiquetas inválido (use zpl, epl2 ou a4).');
    patch.label_protocol = v;
  } else if (!parcial) patch.label_protocol = 'zpl';

  if (body.document_protocol !== undefined) {
    const v = String(body.document_protocol).trim().toLowerCase();
    if (!DOC_PROTOCOLS.has(v)) throw new HttpError(400, 'Protocolo de documentos inválido (use pdf, escpos ou text).');
    patch.document_protocol = v;
  } else if (!parcial) patch.document_protocol = 'pdf';

  if (body.fallback_mode !== undefined) {
    const v = String(body.fallback_mode).trim().toLowerCase();
    if (!FALLBACK_MODES.has(v)) throw new HttpError(400, 'Modo de contingência inválido.');
    patch.fallback_mode = v;
  } else if (!parcial) patch.fallback_mode = 'browser_pdf';

  if (body.auto_print_pdv !== undefined) patch.auto_print_pdv = Boolean(body.auto_print_pdv);
  else if (!parcial) patch.auto_print_pdv = true;

  if (body.allow_operator_reprint !== undefined) patch.allow_operator_reprint = Boolean(body.allow_operator_reprint);
  else if (!parcial) patch.allow_operator_reprint = true;

  for (const k of ['copies_recibo', 'copies_documento'] as const) {
    if (body[k] !== undefined) {
      const n = Number(body[k]);
      if (!Number.isInteger(n) || n < 1 || n > 10) {
        throw new HttpError(400, `${k} deve ser um inteiro entre 1 e 10.`);
      }
      patch[k] = n;
    } else if (!parcial) {
      patch[k] = 1;
    }
  }

  if (body.ativo !== undefined) patch.ativo = Boolean(body.ativo);
  else if (!parcial) patch.ativo = true;

  return patch;
}

/** GET /api/print/terminals — lista terminais da empresa (acessível a operadores para seleção). */
export async function listarTerminaisHandler(req: Request, res: Response): Promise<void> {
  const actor = currentUser(req);
  checkFluxo(R_TERMINALS(), actor);
  const escopo = escopoDe(actor);
  const s = getStore();
  const [terms, agents] = await Promise.all([
    s.list(R_TERMINALS(), { page: 1, pageSize: 200, filter: { empresa_id: escopo.empresaId }, sort: 'codigo', dir: 'asc' }),
    s.list(R_AGENTS(), { page: 1, pageSize: 200, filter: { empresa_id: escopo.empresaId } }),
  ]);
  const agentMap = new Map<number, Row>();
  for (const a of agents.rows) agentMap.set(Number(a.id), a);
  res.json({
    rows: terms.rows.map((t) => terminalPublico(t, t.agent_id ? agentMap.get(Number(t.agent_id)) : null)),
    total: terms.total,
  });
}

/** POST /api/print/terminals — cadastra novo terminal (admin/gerente). */
export async function criarTerminalHandler(req: Request, res: Response): Promise<void> {
  const actor = currentUser(req);
  exigirAdminImpressao(actor);
  const escopo = escopoDe(actor);
  const s = getStore();
  const dados = await validarPayloadTerminal(escopo.empresaId, (req.body ?? {}) as Record<string, unknown>, false);

  const dup = await s.findOneWhere(R_TERMINALS(), { empresa_id: escopo.empresaId, codigo: dados.codigo });
  if (dup) throw new HttpError(409, `Já existe um terminal com o código "${String(dados.codigo)}" nesta empresa.`);

  const row = await s.insert(R_TERMINALS(), {
    ...dados,
    empresa_id: escopo.empresaId,
    criado_por: actor.id,
  });
  await s.audit({
    usuario_id: actor.id,
    usuario: actor.name,
    acao: 'criar',
    recurso: 'print_terminals',
    registro_id: Number(row.id),
    descricao: `Terminal de impressão configurado (${row.codigo})`,
    dados: { codigo: row.codigo, nome: row.nome },
    empresa_id: escopo.empresaId,
  });
  const ag = row.agent_id ? await s.findOneWhere(R_AGENTS(), { id: Number(row.agent_id), empresa_id: escopo.empresaId }) : null;
  res.status(201).json({ terminal: terminalPublico(row, ag) });
}

/** PATCH /api/print/terminals/:id — atualiza configuração do terminal (admin/gerente). */
export async function atualizarTerminalHandler(req: Request, res: Response): Promise<void> {
  const actor = currentUser(req);
  exigirAdminImpressao(actor);
  const escopo = escopoDe(actor);
  const s = getStore();
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, 'ID de terminal inválido.');

  const atual = await s.findOneWhere(R_TERMINALS(), { id, empresa_id: escopo.empresaId });
  if (!atual) throw new HttpError(404, 'Terminal de impressão não encontrado.');
  assertRegistroDaEmpresa(R_TERMINALS(), atual, escopo);

  const patch = await validarPayloadTerminal(escopo.empresaId, (req.body ?? {}) as Record<string, unknown>, true);
  if (patch.codigo && patch.codigo !== atual.codigo) {
    const dup = await s.findOneWhere(R_TERMINALS(), { empresa_id: escopo.empresaId, codigo: patch.codigo });
    if (dup && Number(dup.id) !== id) {
      throw new HttpError(409, `Já existe outro terminal com o código "${String(patch.codigo)}".`);
    }
  }

  const row = await s.update(R_TERMINALS(), id, patch);
  if (!row) throw new HttpError(404, 'Terminal de impressão não encontrado.');
  await s.audit({
    usuario_id: actor.id,
    usuario: actor.name,
    acao: 'editar',
    recurso: 'print_terminals',
    registro_id: id,
    descricao: `Terminal de impressão atualizado (${row.codigo})`,
    dados: { codigo: row.codigo, campos: Object.keys(patch) },
    empresa_id: escopo.empresaId,
  });
  const ag = row.agent_id ? await s.findOneWhere(R_AGENTS(), { id: Number(row.agent_id), empresa_id: escopo.empresaId }) : null;
  res.json({ terminal: terminalPublico(row, ag) });
}

/** DELETE /api/print/terminals/:id — remove terminal (admin/gerente). */
export async function removerTerminalHandler(req: Request, res: Response): Promise<void> {
  const actor = currentUser(req);
  exigirAdminImpressao(actor);
  const escopo = escopoDe(actor);
  const s = getStore();
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, 'ID de terminal inválido.');

  const atual = await s.findOneWhere(R_TERMINALS(), { id, empresa_id: escopo.empresaId });
  if (!atual) throw new HttpError(404, 'Terminal de impressão não encontrado.');
  assertRegistroDaEmpresa(R_TERMINALS(), atual, escopo);

  await s.remove(R_TERMINALS(), id);
  await s.audit({
    usuario_id: actor.id,
    usuario: actor.name,
    acao: 'excluir',
    recurso: 'print_terminals',
    registro_id: id,
    descricao: `Terminal de impressão removido (${atual.codigo})`,
    dados: { codigo: atual.codigo },
    empresa_id: escopo.empresaId,
  });
  res.json({ ok: true });
}
