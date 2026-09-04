// Leitor de CSV (e tabelas) para a importação por planilha.
// Detecta o delimitador (; ou ,), respeita aspas e normaliza o cabeçalho
// (minúsculas, sem acentos, espaços → _) para casar com os campos da API.
export function normalizarCabecalho(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/** Quebra uma linha CSV respeitando aspas. */
function splitLinha(linha: string, delim: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inAspas = false;
  for (let i = 0; i < linha.length; i++) {
    const ch = linha[i];
    if (inAspas) {
      if (ch === '"') {
        if (linha[i + 1] === '"') {
          cur += '"';
          i++;
        } else inAspas = false;
      } else cur += ch;
    } else if (ch === '"') inAspas = true;
    else if (ch === delim) {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

export function detectarDelimitador(texto: string): string {
  const primeira = texto.split(/\r?\n/).find((l) => l.trim().length > 0) || '';
  const ponto = (primeira.match(/;/g) || []).length;
  const virgula = (primeira.match(/,/g) || []).length;
  return ponto > virgula ? ';' : ',';
}

export type TabelaCSV = { colunas: string[]; linhas: Record<string, string>[] };

/** Converte texto CSV em linhas de objeto (cabeçalho normalizado). */
export function parseCSV(texto: string): TabelaCSV {
  const delim = detectarDelimitador(texto);
  const linhasBrutas = texto
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .filter((l) => l.trim().length > 0);
  if (!linhasBrutas.length) return { colunas: [], linhas: [] };
  const cabecalho = splitLinha(linhasBrutas[0], delim).map(normalizarCabecalho);
  const linhas: Record<string, string>[] = [];
  for (let i = 1; i < linhasBrutas.length; i++) {
    const celulas = splitLinha(linhasBrutas[i], delim);
    const obj: Record<string, string> = {};
    cabecalho.forEach((c, j) => {
      if (c) obj[c] = (celulas[j] ?? '').trim();
    });
    linhas.push(obj);
  }
  return { colunas: cabecalho, linhas };
}

/** Converte um valor textual em número aceitando "1.234,56" e "1234.56". */
export function parseNumeroTexto(v: string | undefined | null): number | null {
  if (v === undefined || v === null) return null;
  let s = String(v).trim().replace(/\s|R\$|%/g, '');
  if (!s) return null;
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}
