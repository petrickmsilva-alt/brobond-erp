import { createHash } from 'node:crypto';
import ExcelJS from 'exceljs';
import { parseCSV } from './csv';

export type CelulaOriginal = {
  endereco: string;
  tipo: string;
  valor: unknown;
  formula?: string;
  formulaCompartilhada?: string;
  resultadoFormula?: unknown;
};

export type LinhaTabela = {
  linhaOrigem: number;
  valores: Record<string, unknown>;
};

export type AbaInventariada = {
  nome: string;
  indice: number;
  totalLinhas: number;
  totalColunas: number;
  linhaCabecalho: number | null;
  cabecalhos: string[];
  linhas: LinhaTabela[];
  celulas: CelulaOriginal[];
  vazia: boolean;
};

export type ArquivoInventariado = {
  nome: string;
  sha256: string;
  tamanhoBytes: number;
  tipo: 'xlsx' | 'csv';
  abas: AbaInventariada[];
};

export type OpcoesLeituraUniversal = {
  nomeArquivo: string;
  bytes: Buffer | Uint8Array;
  maxBytes?: number;
  maxCelulas?: number;
};

const MAX_BYTES_PADRAO = 20 * 1024 * 1024;
const MAX_CELULAS_PADRAO = 500_000;
const MAX_LINHAS_CABECALHO = 15;

function serializarValor(valor: unknown): unknown {
  if (valor === null || valor === undefined) return null;
  if (valor instanceof Date) return valor.toISOString();
  if (typeof valor === 'string' || typeof valor === 'number' || typeof valor === 'boolean') return valor;
  if (Array.isArray(valor)) return valor.map(serializarValor);
  if (typeof valor === 'object') {
    const obj = valor as Record<string, unknown>;
    if ('text' in obj && 'hyperlink' in obj) return { text: obj.text, hyperlink: obj.hyperlink };
    if ('richText' in obj) return { richText: serializarValor(obj.richText) };
    if ('formula' in obj || 'sharedFormula' in obj) {
      return {
        formula: obj.formula ?? null,
        sharedFormula: obj.sharedFormula ?? null,
        result: serializarValor(obj.result),
      };
    }
    if ('error' in obj) return { error: obj.error };
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) result[k] = serializarValor(v);
    return result;
  }
  return String(valor);
}

function normalizarCabecalho(valor: unknown, indice: number): string {
  const texto = String(serializarValor(valor) ?? '').trim();
  const normal = texto.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return normal || `coluna_${indice + 1}`;
}

function detectarCabecalho(matriz: unknown[][]): { indice: number; cabecalhos: string[] } | null {
  let melhor: { indice: number; cabecalhos: string[]; pontuacao: number } | null = null;
  const limite = Math.min(matriz.length, MAX_LINHAS_CABECALHO);
  for (let i = 0; i < limite; i++) {
    const row = matriz[i] || [];
    const preenchidos = row.filter(v => v !== null && v !== undefined && String(v).trim() !== '').length;
    if (preenchidos < 2) continue;
    const distintos = new Set(row.filter(v => v !== null && v !== undefined && String(v).trim() !== '')
      .map(v => normalizarCabecalho(v, 0))).size;
    const pontuacao = preenchidos * 2 + distintos - i * 0.15;
    if (!melhor || pontuacao > melhor.pontuacao) {
      const headers = row.map((v, j) => normalizarCabecalho(v, j));
      const seen = new Map<string, number>();
      const unique = headers.map(h => {
        const n = seen.get(h) ?? 0;
        seen.set(h, n + 1);
        return n ? `${h}_${n + 1}` : h;
      });
      melhor = { indice: i, cabecalhos: unique, pontuacao };
    }
  }
  return melhor ? { indice: melhor.indice, cabecalhos: melhor.cabecalhos } : null;
}

function inventariarMatriz(nome: string, indice: number, matriz: unknown[][], celulas: CelulaOriginal[]): AbaInventariada {
  const header = detectarCabecalho(matriz);
  const rows: LinhaTabela[] = [];
  if (header) {
    for (let i = header.indice + 1; i < matriz.length; i++) {
      const row = matriz[i] || [];
      if (row.every(v => v === null || v === undefined || String(serializarValor(v) ?? '').trim() === '')) continue;
      const values: Record<string, unknown> = {};
      header.cabecalhos.forEach((key, j) => {
        const val = serializarValor(row[j]);
        if (val !== null && val !== undefined && val !== '') values[key] = val;
      });
      rows.push({ linhaOrigem: i + 1, valores: values });
    }
  }
  const populatedRows = matriz.filter(r => r.some(v => v !== null && v !== undefined && String(serializarValor(v) ?? '').trim() !== '')).length;
  const maxColumns = matriz.reduce((m, r) => Math.max(m, r.length), 0);
  return {
    nome, indice, totalLinhas: matriz.length, totalColunas: maxColumns,
    linhaCabecalho: header ? header.indice + 1 : null,
    cabecalhos: header?.cabecalhos ?? [], linhas: rows, celulas,
    vazia: populatedRows === 0,
  };
}

export async function inventariarArquivoUniversal(opts: OpcoesLeituraUniversal): Promise<ArquivoInventariado> {
  const bytes = Buffer.from(opts.bytes);
  const maxBytes = opts.maxBytes ?? MAX_BYTES_PADRAO;
  const maxCelulas = opts.maxCelulas ?? MAX_CELULAS_PADRAO;
  if (!bytes.length) throw new Error('Arquivo vazio.');
  if (bytes.length > maxBytes) throw new Error(`Arquivo excede o limite de ${maxBytes} bytes.`);
  const ext = opts.nomeArquivo.toLowerCase().split('.').pop();
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (ext === 'csv') {
    const text = bytes.toString('utf8').replace(/^\uFEFF/, '');
    const parsed = parseCSV(text);
    const matriz = parsed.linhas.map(row => Object.values(row));
    const headers = parsed.colunas;
    const rows = parsed.linhas.map((row, i) => ({
      linhaOrigem: i + 2,
      valores: Object.fromEntries(Object.entries(row).map(([k, v]) => [k, v])),
    }));
    const sheet: AbaInventariada = {
      nome: opts.nomeArquivo, indice: 0, totalLinhas: rows.length + 1,
      totalColunas: headers.length, linhaCabecalho: rows.length ? 1 : null,
      cabecalhos: headers, linhas: rows, celulas: [],
      vazia: rows.length === 0,
    };
    return { nome: opts.nomeArquivo, sha256, tamanhoBytes: bytes.length, tipo: 'csv', abas: [sheet] };
  }
  if (ext !== 'xlsx' && ext !== 'xlsm') throw new Error('Formato não suportado. Envie XLSX, XLSM ou CSV.');
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(bytes);
  let cellCount = 0;
  const sheets: AbaInventariada[] = workbook.worksheets.map((ws, idx) => {
    const matrix: unknown[][] = [];
    const cells: CelulaOriginal[] = [];
    ws.eachRow({ includeEmpty: true }, (row, rowNumber) => {
      const rowVals: unknown[] = [];
      row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
        cellCount++;
        if (cellCount > maxCelulas) throw new Error(`Arquivo excede o limite de ${maxCelulas} células.`);
        const raw = cell.value as any;
        const formula = raw && typeof raw === 'object' && 'formula' in raw ? String(raw.formula ?? '') : undefined;
        const sharedFormula = raw && typeof raw === 'object' && 'sharedFormula' in raw ? String(raw.sharedFormula ?? '') : undefined;
        const result = raw && typeof raw === 'object' && ('formula' in raw || 'sharedFormula' in raw) ? serializarValor(raw.result) : undefined;
        cells.push({
          endereco: cell.address, tipo: cell.type.toString(), valor: serializarValor(raw),
          ...(formula ? { formula } : {}), ...(sharedFormula ? { formulaCompartilhada: sharedFormula } : {}),
          ...(result !== undefined ? { resultadoFormula: result } : {}),
        });
        rowVals[colNumber - 1] = serializarValor(raw);
      });
      matrix[rowNumber - 1] = rowVals;
    });
    return inventariarMatriz(ws.name, idx, matrix, cells);
  });
  return { nome: opts.nomeArquivo, sha256, tamanhoBytes: bytes.length, tipo: 'xlsx', abas: sheets };
}
