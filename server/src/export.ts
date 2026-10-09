// ============================================================
// Fase 5 — Exportação CSV/XLSX de listas e relatórios.
//
// CSV nativo: BOM + ";" (abre certo no Excel pt-BR). XLSX usa exceljs
// (única dependência nova, instalada em server/package.json).
// ============================================================
import type { Request, Response } from 'express';
import ExcelJS from 'exceljs';
import { HttpError } from './errors';
import { getPublicResource, type Resource } from './resources';
import { aplicarFiltroEmpresa } from './empresa';
import { checkAccess, escopoDe, getStore, validarReferenciasDeSaida } from './services';
import { currentUser } from './auth';
import type { Row } from './store';

// ----------------------------------------------------------------------------
// Formatação de valores (pt-BR)
// ----------------------------------------------------------------------------
function money(n: unknown): string {
  const v = Number(n);
  if (!Number.isFinite(v)) return '0,00';
  return v.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function number(n: unknown): string {
  const v = Number(n);
  if (!Number.isFinite(v)) return '';
  return String(v).replace('.', ',');
}
function percent(n: unknown): string {
  const v = Number(n);
  return `${String(v).replace('.', ',')}%`;
}
function date(v: unknown): string {
  if (!v) return '';
  const s = String(v);
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return `${m[3]}/${m[2]}/${m[1]}`;
  return s;
}

export type ColunaExport = { key: string; label: string; tipo?: 'text' | 'money' | 'number' | 'percent' | 'date' | 'boolean' };

export function valorCelula(col: ColunaExport, row: Row): string {
  const v = row[col.key];
  if (v === null || v === undefined || v === '') return '';
  switch (col.tipo) {
    case 'money':
      return money(v);
    case 'number':
      return number(v);
    case 'percent':
      return percent(v);
    case 'date':
      return date(v);
    case 'boolean':
      return v ? 'Sim' : 'Não';
    default:
      return String(v);
  }
}

// ----------------------------------------------------------------------------
// Montagem dos arquivos
// ----------------------------------------------------------------------------
function csvBytes(colunas: ColunaExport[], linhas: Row[]): Buffer {
  const escape = (s: string) => (/[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  const cab = colunas.map((c) => escape(c.label)).join(';');
  const corpo = linhas.map((r) => colunas.map((c) => escape(valorCelula(c, r))).join(';')).join('\r\n');
  return Buffer.from(`\uFEFF${cab}\r\n${corpo}`, 'utf8');
}

async function xlsxBuffer(colunas: ColunaExport[], linhas: Row[], sheetName: string): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(sheetName.slice(0, 30));
  ws.columns = colunas.map((c) => ({ header: c.label, key: c.key, width: Math.max(10, Math.min(40, c.label.length + 4)) }));
  ws.getRow(1).font = { bold: true };
  ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF0F4FA' } };
  for (const r of linhas) {
    const vals: Record<string, unknown> = {};
    for (const c of colunas) {
      const raw = r[c.key];
      vals[c.key] =
        c.tipo === 'money' || c.tipo === 'number' || c.tipo === 'percent'
          ? Number(raw) || 0
          : c.tipo === 'date'
            ? raw
              ? String(raw).slice(0, 10)
              : undefined
            : valorCelula(c, r);
    }
    ws.addRow(vals);
  }
  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf);
}

export async function enviarArquivo(res: Response, nome: string, formato: string, colunas: ColunaExport[], linhas: Row[], sheetName?: string) {
  const fmt = (formato || 'csv').toLowerCase();
  const agora = new Date().toISOString().slice(0, 10);
  if (fmt === 'xlsx') {
    const buf = await xlsxBuffer(colunas, linhas, sheetName || nome);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${nome}-${agora}.xlsx"`);
    res.end(buf);
    return;
  }
  if (fmt !== 'csv') throw new HttpError(400, 'Formato inválido. Use format=csv ou format=xlsx.');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${nome}-${agora}.csv"`);
  res.end(csvBytes(colunas, linhas));
}

// ----------------------------------------------------------------------------
// GET /api/:resource/export — respeita q, sort, f.* (mesmos filtros da listagem)
// ----------------------------------------------------------------------------
export async function exportarRecurso(req: Request, res: Response, resourceKey: string) {
  const r: Resource | undefined = getPublicResource(resourceKey);
  if (!r) throw new HttpError(404, 'Recurso não encontrado');
  const actor = currentUser(req);
  checkAccess(r, actor, 'read');
  const escopo = escopoDe(actor);
  const formato = String(req.query.format || 'csv');

  // Mesmos filtros da listagem
  const filter: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(req.query)) {
    if (k.startsWith('f.') && typeof v === 'string' && v !== '') filter[k.slice(2)] = v;
    if ((k === 'f.data_de' || k === 'f.data_ate') && typeof v === 'string' && v) filter[k] = v;
  }
  const sort = typeof req.query.sort === 'string' && req.query.sort ? req.query.sort : undefined;
  const dir = String(req.query.dir || 'asc').toLowerCase() === 'desc' ? 'desc' : 'asc';
  const q = typeof req.query.q === 'string' ? req.query.q : undefined;

  // Reúne todas as páginas
  const s = getStore();
  // Filtros virtuais de usuários (status consolidado, MFA, parados 30d, senha, acesso) filtram em JS.
  const filtroStatus = r.key === 'usuarios' && typeof filter.status === 'string' ? String(filter.status) : '';
  const filtroMfa = r.key === 'usuarios' ? String(filter.mfa || '') : '';
  const filtroParado = r.key === 'usuarios' ? String(filter.parado30d || '') : '';
  const filtroSenha = r.key === 'usuarios' && typeof filter.senha === 'string' ? String(filter.senha) : '';
  const filtroAcesso = r.key === 'usuarios' && typeof filter.acesso === 'string' ? String(filter.acesso) : '';
  if (r.key === 'usuarios') {
    delete filter.status;
    delete filter.mfa;
    delete filter.parado30d;
    delete filter.senha;
    delete filter.acesso;
  }
  // Exportar seleção: ?ids=1,2,3 (ações em lote do módulo Usuários).
  const idsSel = new Set<number>();
  if (r.key === 'usuarios' && typeof req.query.ids === 'string') {
    for (const pedaco of req.query.ids.split(',')) {
      const n = Number(pedaco.trim());
      if (Number.isInteger(n) && n > 0) idsSel.add(n);
    }
  }
  // MULTIEMPRESA (Etapa 2.1): a exportação usa o MESMO recorte da listagem —
  // sem isto, /api/auditoria/export (e qualquer recurso com escopo) vazava
  // dados de todas as empresas. Consolidação segue o privilégio existente.
  const filtroEscopo = aplicarFiltroEmpresa(r, filter, escopo);
  let linhas: Row[] = [];
  let page = 1;
  let totalEsperado = 0;
  for (;;) {
    const resul = await s.list(r, { q, page, pageSize: 500, sort, dir, filter: filtroEscopo });
    totalEsperado = resul.total;
    await validarReferenciasDeSaida(r, resul.rows, escopo);
    linhas.push(...resul.rows);
    if (page * 500 >= resul.total) break;
    page++;
    if (page > 60) throw new HttpError(409, 'A exportação excede o limite seguro de 30.000 registros. Nenhum arquivo parcial foi enviado.');
  }
  if (linhas.length < totalEsperado) throw new HttpError(409, 'A exportação ficou incompleta. Nenhum arquivo parcial foi enviado.');
  if (idsSel.size) linhas = linhas.filter((u) => idsSel.has(Number(u.id)));
  if (r.key === 'usuarios' && (filtroStatus || filtroMfa || filtroParado || filtroSenha || filtroAcesso)) {
    const agora = Date.now();
    const statusDe = (u: Row): string => {
      const convExp = u.convite_expira_em ? new Date(String(u.convite_expira_em)).getTime() < agora : false;
      const bloq = u.bloqueio_manual === true || (!!u.bloqueado_ate && new Date(String(u.bloqueado_ate)).getTime() > agora);
      const exp = !!u.acesso_expira_em && new Date(String(u.acesso_expira_em)).getTime() < agora;
      return u.ativo === false
        ? 'inativo'
        : bloq
          ? 'bloqueado'
          : exp
            ? 'expirado'
            : !u.senha_definida_em
              ? convExp
                ? 'convite_expirado'
                : 'convite_pendente'
              : u.trocar_senha
                ? 'provisoria'
                : 'ativo';
    };
    const senhaDe = (u: Row): string => (!u.senha_definida_em ? 'convite_pendente' : u.trocar_senha ? 'provisoria' : 'propria');

    if (filtroStatus) linhas = linhas.filter((u) => statusDe(u) === filtroStatus);
    if (filtroSenha) linhas = linhas.filter((u) => senhaDe(u) === filtroSenha);
    if (filtroMfa === 'sim') linhas = linhas.filter((u) => !!u.mfa_ativado_em);
    else if (filtroMfa === 'nao') linhas = linhas.filter((u) => !u.mfa_ativado_em);
    if (filtroAcesso === 'recente') {
      linhas = linhas.filter((u) => u.ultimo_login && agora - new Date(String(u.ultimo_login)).getTime() <= 7 * 86400000);
    } else if (filtroAcesso === 'parado30d' || filtroParado === 'sim') {
      const ha30d = agora - 30 * 24 * 3600_000;
      linhas = linhas.filter((u) => {
        if (u.ativo === false || !u.senha_definida_em) return false;
        const loginMs = u.ultimo_login ? new Date(String(u.ultimo_login)).getTime() : 0;
        return !loginMs || loginMs < ha30d;
      });
    } else if (filtroAcesso === 'nunca') {
      linhas = linhas.filter((u) => !u.ultimo_login);
    }
  }

  const colunas: ColunaExport[] = [{ key: 'id', label: '#', tipo: 'number' }];
  for (const f of r.fields) {
    if (f.list === false || f.virtual || f.type === 'password' || f.type === 'images' || f.type === 'color') continue;
    const tipo =
      f.type === 'money' ? 'money' : f.type === 'number' || f.type === 'integer' ? 'number' : f.type === 'percent' ? 'percent' : f.type === 'date' || f.type === 'datetime' ? 'date' : f.type === 'boolean' ? 'boolean' : 'text';
    // ref/select: exporta o rótulo legível (ex.: cor_id__label)
    const chave = f.type === 'ref' && linhas.length && `${f.name}__label` in linhas[0] ? `${f.name}__label` : f.type === 'ref' ? f.name : f.name;
    colunas.push({ key: chave, label: f.label, tipo });
    if (f.type === 'select' && linhas.length) {
      // converte valor → rótulo
      for (const row of linhas) {
        const val = row[f.name];
        const opt = f.options?.find((o) => o.value === String(val));
        if (opt) row[`${f.name}__label`] = opt.label;
      }
    }
    if (f.type === 'ref') {
      for (const row of linhas) row[chave] = row[chave] ?? row[f.name];
    }
  }

  await enviarArquivo(res, r.key, formato, colunas, linhas, r.label);
}
