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

/** CEP: 00000-000 (o servidor guarda só os dígitos). */
export function maskCep(v: string): string {
  const d = v.replace(/\D/g, '').slice(0, 8);
  return d.length > 5 ? `${d.slice(0, 5)}-${d.slice(5)}` : d;
}

export function maskPhone(v: string): string {
  const d = v.replace(/\D/g, '').slice(0, 11);
  if (d.length <= 10) {
    return d.replace(/^(\d{2})(\d)/, '($1) $2').replace(/(\d{4})(\d{1,4})$/, '$1-$2');
  }
  return d.replace(/^(\d{2})(\d)/, '($1) $2').replace(/(\d{5})(\d{1,4})$/, '$1-$2');
}

export const ACAO_LABEL: Record<string, string> = {
  criar: 'Inclusão',
  editar: 'Alteração',
  excluir: 'Exclusão',
  login: 'Login',
  login_falha: 'Login (falha)',
  senha: 'Troca de senha',
};
