import type { Field } from './meta';

const brl = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
const num = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 3 });
const dateFmt = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short' });
const dateTimeFmt = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' });

export function formatMoney(v: unknown): string {
  const n = Number(v);
  return Number.isFinite(n) ? brl.format(n) : '—';
}

export function formatNumber(v: unknown): string {
  const n = Number(v);
  return Number.isFinite(n) ? num.format(n) : '—';
}

export function formatDate(v: unknown): string {
  if (!v) return '—';
  const s = String(v);
  // Datas puras (YYYY-MM-DD) não devem sofrer deslocamento de fuso
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m && s.length <= 10) return `${m[3]}/${m[2]}/${m[1]}`;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? '—' : dateFmt.format(d);
}

export function formatDateTime(v: unknown): string {
  if (!v) return '—';
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? '—' : dateTimeFmt.format(d);
}

export function formatRelative(v: unknown): string {
  if (!v) return '—';
  const d = new Date(String(v)).getTime();
  if (Number.isNaN(d)) return '—';
  const diff = Date.now() - d;
  // Datas futuras (ex.: expiração de convite/acesso): "em X".
  if (diff < 0) {
    const min = Math.round(-diff / 60000);
    if (min < 1) return 'agora';
    if (min < 60) return `em ${min} min`;
    const h = Math.round(min / 60);
    if (h < 48) return `em ${h} h`;
    const days = Math.round(h / 24);
    if (days < 30) return `em ${days} d`;
    return formatDate(v);
  }
  const min = Math.round(diff / 60000);
  if (min < 1) return 'agora';
  if (min < 60) return `há ${min} min`;
  const h = Math.round(min / 60);
  if (h < 24) return `há ${h} h`;
  const days = Math.round(h / 24);
  if (days < 30) return `há ${days} d`;
  return formatDate(v);
}

/** Formata um valor de célula conforme o tipo do campo. */
export function formatCell(f: Field, row: Record<string, any>): string {
  const v = row[f.name];
  if (f.type === 'ref') {
    const label = row[`${f.name}__label`];
    return label ?? (v === null || v === undefined ? '—' : `#${v}`);
  }
  if (v === null || v === undefined || v === '') return '—';
  switch (f.type) {
    case 'money':
      return formatMoney(v);
    case 'percent':
      return `${formatNumber(v)}%`;
    case 'number':
    case 'integer':
      return formatNumber(v);
    case 'boolean':
      return v ? 'Sim' : 'Não';
    case 'date':
      return formatDate(v);
    case 'datetime':
      return formatDateTime(v);
    case 'select':
      return f.options?.find((o) => o.value === String(v))?.label ?? String(v);
    case 'images':
      return Array.isArray(v) ? `${v.length} foto${v.length === 1 ? '' : 's'}` : '—';
    case 'phone':
      return formatPhone(v) || '—';
    case 'document':
      return formatDocumento(v) || '—';
    default:
      return String(v);
  }
}

export function formatBytes(n: unknown): string {
  const b = Number(n);
  if (!Number.isFinite(b)) return '—';
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(0)} KB`;
  return `${(b / 1024 / 1024).toFixed(1)} MB`;
}

/** Converte valor vindo da API em valor de input (string) para o formulário. */
export function toInputValue(f: Field, v: unknown): string {
  if (v === null || v === undefined) return '';
  switch (f.type) {
    case 'date': {
      const s = String(v);
      return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : '';
    }
    case 'datetime': {
      const d = new Date(String(v));
      if (Number.isNaN(d.getTime())) return '';
      const pad = (n: number) => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
    }
    case 'money':
    case 'number':
    case 'percent': {
      const n = Number(v);
      return Number.isFinite(n) ? String(n).replace('.', ',') : '';
    }
    default:
      return String(v);
  }
}

// ----------------------------------------------------------------------------
// MÁSCARAS E NORMALIZAÇÃO BRASILEIRAS — CPF, CNPJ, telefone, CEP, moeda.
//
// Cada campo tem 3 camadas: máscara de digitação (maskX), validação (xValido /
// erroX) e normalização de envio (normalizeX → só dígitos / número). O servidor
// revalida tudo (nunca se confia só no front), mas o usuário vê o erro na hora.
// ----------------------------------------------------------------------------

/** Mantém apenas dígitos. */
export function soDigitos(v: unknown): string {
  return String(v ?? '').replace(/\D/g, '');
}

/** CPF: 000.000.000-00 enquanto digita. */
export function maskCpf(v: string): string {
  const d = soDigitos(v).slice(0, 11);
  return d
    .replace(/^(\d{3})(\d)/, '$1.$2')
    .replace(/^(\d{3})\.(\d{3})(\d)/, '$1.$2.$3')
    .replace(/\.(\d{3})(\d{1,2})$/, '.$1-$2');
}

/** CNPJ: 00.000.000/0000-00 enquanto digita. */
export function maskCnpj(v: string): string {
  const d = soDigitos(v).slice(0, 14);
  return d
    .replace(/^(\d{2})(\d)/, '$1.$2')
    .replace(/^(\d{2})\.(\d{3})(\d)/, '$1.$2.$3')
    .replace(/\.(\d{3})(\d)/, '.$1/$2')
    .replace(/(\d{4})(\d{1,2})$/, '$1-$2');
}

/** Máscara do documento conforme o tipo de pessoa (nunca CPF e CNPJ ao mesmo tempo). */
export function maskDocumentoTipo(v: string, pessoa: 'pf' | 'pj' | string): string {
  return pessoa === 'pf' ? maskCpf(v) : pessoa === 'pj' ? maskCnpj(v) : soDigitos(v).slice(0, 16);
}

/** Dígito verificador por soma ponderada módulo 11 (comum a CPF e CNPJ). */
function digitoMod11(digitos: number[], pesos: number[]): number {
  const soma = digitos.reduce((acc, d, i) => acc + d * pesos[i], 0);
  const resto = soma % 11;
  return resto < 2 ? 0 : 11 - resto;
}

/** CPF válido? (11 dígitos + 2 DVs — sequências repetidas não contam). */
export function cpfValido(valor: unknown): boolean {
  const cpf = soDigitos(valor);
  if (cpf.length !== 11 || /^(\d)\1{10}$/.test(cpf)) return false;
  const d = cpf.split('').map(Number);
  if (digitoMod11(d.slice(0, 9), [10, 9, 8, 7, 6, 5, 4, 3, 2]) !== d[9]) return false;
  return digitoMod11(d.slice(0, 10), [11, 10, 9, 8, 7, 6, 5, 4, 3, 2]) === d[10];
}

/** CNPJ válido? (14 dígitos + 2 DVs — sequências repetidas não contam). */
export function cnpjValido(valor: unknown): boolean {
  const cnpj = soDigitos(valor);
  if (cnpj.length !== 14 || /^(\d)\1{13}$/.test(cnpj)) return false;
  const d = cnpj.split('').map(Number);
  if (digitoMod11(d.slice(0, 12), [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]) !== d[12]) return false;
  return digitoMod11(d.slice(0, 13), [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]) === d[13];
}

/** Mensagem de erro do documento (null quando válido ou vazio). */
export function erroDocumento(valor: unknown, tipo: 'pf' | 'pj'): string | null {
  const d = soDigitos(valor);
  if (!d) return null;
  return tipo === 'pf' ? (cpfValido(d) ? null : 'CPF inválido.') : cnpjValido(d) ? null : 'CNPJ inválido.';
}

/** Exibição: 000.000.000-00 / 00.000.000/0000-00. */
export function formatDocumento(v: unknown): string {
  const d = soDigitos(v);
  if (d.length === 11) return maskCpf(d);
  if (d.length === 14) return maskCnpj(d);
  return v === null || v === undefined ? '' : String(v);
}

// ---- Telefone -------------------------------------------------------------

/** DDDs brasileiros válidos (67 códicos — espelha server/src/documentos.ts). */
export const DDDS_BRASIL = new Set([
  '11', '12', '13', '14', '15', '16', '17', '18', '19',
  '21', '22', '24', '27', '28',
  '31', '32', '33', '34', '35', '37', '38',
  '41', '42', '43', '44', '45', '46', '47', '48', '49',
  '51', '53', '54', '55',
  '61', '62', '63', '64', '65', '66', '67', '68', '69',
  '71', '73', '74', '75', '77', '79',
  '81', '82', '83', '84', '85', '86', '87', '88', '89',
  '91', '92', '93', '94', '95', '96', '97', '98', '99',
]);

export const MSG_TELEFONE_INVALIDO = 'Telefone inválido. Use DDD + número (ex.: (62) 99999-9999).';

/**
 * Telefone BR → DDD+número (10–11 dígitos). Internacional (+DDI) → dígitos
 * com DDI. Inválido/ausente → null. É o valor que vai ao backend/banco.
 */
export function normalizePhone(v: unknown): string | null {
  const texto = String(v ?? '').trim();
  if (!texto) return null;
  const d = soDigitos(texto);
  // +55 (ou 55… com 12–13 dígitos) é SEMPRE Brasil: tem que fechar como
  // DDD+número — nunca cai no "internacional livre".
  const comDdi55 = d.length >= 12 && d.length <= 13 && d.startsWith('55');
  const local = comDdi55 ? d.slice(2) : d;
  if (local.length === 10 || local.length === 11) {
    if (DDDS_BRASIL.has(local.slice(0, 2))) {
      const inicio = local[2];
      if (local.length === 11 && inicio === '9') return local;
      if (local.length === 10 && '2345'.includes(inicio)) return local;
    }
    if (comDdi55) return null;
  }
  if (!comDdi55 && texto.startsWith('+') && d.length >= 8 && d.length <= 15) return d;
  return null;
}

/** Mensagem de erro do telefone (null quando válido ou vazio). */
export function erroTelefone(v: unknown): string | null {
  const texto = String(v ?? '').trim();
  if (!texto) return null;
  return normalizePhone(texto) === null ? MSG_TELEFONE_INVALIDO : null;
}

/**
 * Máscara de digitação: +55 (62) 99999-9999 (celular) ou +55 (62) 3333-4444
 * (fixo) — adaptativa pelo primeiro dígito do número. Com "+" e DDI estrangeiro
 * deixa o número livre. Aceita o que já estiver com máscara e remascara.
 */
export function maskPhone(v: string): string {
  const texto = String(v ?? '');
  const comMais = texto.trim().startsWith('+');
  const d0 = soDigitos(texto);
  // "+55…" é SEMPRE o Brasil (DDI 55); "+<outro DDI>" fica livre. Sem "+",
  // 12–13 dígitos começando com 55 também são DDI 55.
  const brComDdi = (comMais && d0.startsWith('55')) || (!comMais && d0.length >= 12 && d0.length <= 13 && d0.startsWith('55'));
  if (comMais && !brComDdi) return `+${d0.slice(0, 15)}`;
  let d = brComDdi ? d0.slice(2) : d0;
  d = d.slice(0, 11);
  if (!d) return brComDdi ? '+55 (' : '';
  const ddd = d.slice(0, 2);
  const numero = d.slice(2);
  if (d.length <= 2) return `+55 (${ddd}`;
  // Celular (9 dígitos, começa com 9): 99999-9999. Fixo: 3333-4444.
  const corta = numero.length >= 9 || numero.startsWith('9') ? 5 : 4;
  return numero.length <= corta
    ? `+55 (${ddd}) ${numero}`
    : `+55 (${ddd}) ${numero.slice(0, corta)}-${numero.slice(corta)}`;
}

/** Exibição de telefone armazenado (legado com máscara, dígitos, +55…). */
export function formatPhone(v: unknown): string {
  const texto = String(v ?? '').trim();
  if (!texto) return '';
  const mascarado = maskPhone(texto);
  return soDigitos(mascarado) || !texto ? mascarado || '—' : texto;
}

// ---- CEP ------------------------------------------------------------------

/** CEP: 00000-000 (o servidor guarda só os 8 dígitos). */
export function maskCep(v: string): string {
  const d = soDigitos(v).slice(0, 8);
  return d.length > 5 ? `${d.slice(0, 5)}-${d.slice(5)}` : d;
}

// ---- Moeda ----------------------------------------------------------------

/**
 * Máscara monetária BR enquanto digita: "1500,5" → "1.500,5" → "1.500,50".
 * O campo exibe "R$" como prefixo fixo; o valor só traz "1.500,50".
 */
export function maskMoneyInput(v: string): string {
  const sujo = String(v ?? '');
  const i = sujo.indexOf(',');
  if (i === -1) {
    const inteiro = soDigitos(sujo).replace(/^0+(?=\d)/, '').slice(0, 12);
    return inteiro ? Number(inteiro).toLocaleString('pt-BR') : '';
  }
  const antes = soDigitos(sujo.slice(0, i)).replace(/^0+(?=\d)/, '').slice(0, 12);
  const depois = soDigitos(sujo.slice(i + 1)).slice(0, 2);
  const fmt = antes ? Number(antes).toLocaleString('pt-BR') : '0';
  return `${fmt},${depois}`;
}

/**
 * "1.500,50" → 1500.50. Mesma semântica do servidor (vírgula = decimal;
 * pontos só milhar quando há vírgula). Aceita "R$", espaços e %.
 */
export function parseMoneyInput(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (v === null || v === undefined) return null;
  let s = String(v).trim().replace(/\s|R\$|%/g, '');
  if (!s) return null;
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

// ---- UFs ------------------------------------------------------------------

/** Somente UFs brasileiras válidas — select fechado, nunca texto livre. */
export const UFS_BRASIL = [
  'AC', 'AL', 'AP', 'AM', 'BA', 'CE', 'DF', 'ES', 'GO', 'MA', 'MT', 'MS', 'MG',
  'PA', 'PB', 'PR', 'PE', 'PI', 'RJ', 'RN', 'RS', 'RO', 'RR', 'SC', 'SP', 'SE', 'TO',
] as const;

/** Máscaras simples de digitação (documento/telefone). */
export function maskDocument(v: string): string {
  const d = v.replace(/\D/g, '').slice(0, 14);
  if (d.length <= 11) {
    return d
      .replace(/^(\d{3})(\d)/, '$1.$2')
      .replace(/^(\d{3})\.(\d{3})(\d)/, '$1.$2.$3')
      .replace(/\.(\d{3})(\d{1,2})$/, '.$1-$2');
  }
  return d
    .replace(/^(\d{2})(\d)/, '$1.$2')
    .replace(/^(\d{2})\.(\d{3})(\d)/, '$1.$2.$3')
    .replace(/\.(\d{3})(\d)/, '.$1/$2')
    .replace(/(\d{4})(\d{1,2})$/, '$1-$2');
}

export const ACAO_LABEL: Record<string, string> = {
  criar: 'Inclusão',
  editar: 'Alteração',
  excluir: 'Exclusão',
  login: 'Login',
  login_falha: 'Login (falha)',
  senha: 'Troca de senha',
};

/** Valores do motor financeiro vêm em centavos inteiros; a tela mostra reais. */
export function centavosParaReais(c: unknown): number {
  const n = Number(c);
  return Number.isFinite(n) ? n / 100 : NaN;
}

/** Percentual com uma casa decimal (0–100). */
export function formatPct(v: unknown): string {
  const n = Number(v);
  return Number.isFinite(n) ? `${n.toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%` : '—';
}
