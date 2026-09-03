import { HttpError } from './errors';
import type { Field, Resource } from './resources';
import { writableFields } from './resources';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function isBlank(v: unknown): boolean {
  return v === undefined || v === null || (typeof v === 'string' && v.trim() === '');
}

/** Converte "1.234,56" / "1234.56" / 1234.56 em número. */
export function parseNumber(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string') return null;
  let s = v.trim().replace(/\s|R\$|%/g, '');
  if (!s) return null;
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function parseBoolean(v: unknown): boolean | null {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (['true', '1', 'sim', 's', 'on', 'yes'].includes(s)) return true;
    if (['false', '0', 'nao', 'não', 'n', 'off', 'no'].includes(s)) return false;
  }
  return null;
}

/** Valida e normaliza um único campo. Retorna [valor, erro]. */
function coerce(f: Field, raw: unknown): [unknown, string | null] {
  if (isBlank(raw)) return [null, null];

  switch (f.type) {
    case 'text':
    case 'textarea':
    case 'phone':
    case 'document': {
      const s = String(raw).trim();
      if (f.maxLength && s.length > f.maxLength) return [s, `Máximo de ${f.maxLength} caracteres`];
      return [s, null];
    }
    case 'email': {
      const s = String(raw).trim().toLowerCase();
      if (!EMAIL_RE.test(s)) return [s, 'E-mail inválido'];
      if (f.maxLength && s.length > f.maxLength) return [s, `Máximo de ${f.maxLength} caracteres`];
      return [s, null];
    }
    case 'password': {
      const s = String(raw);
      if (f.min && s.length < f.min) return [s, `Mínimo de ${f.min} caracteres`];
      return [s, null];
    }
    case 'integer':
    case 'ref': {
      const n = parseNumber(raw);
      if (n === null || !Number.isInteger(n)) return [raw, 'Informe um número inteiro'];
      if (f.min !== undefined && n < f.min) return [n, `Mínimo: ${f.min}`];
      if (f.max !== undefined && n > f.max) return [n, `Máximo: ${f.max}`];
      return [n, null];
    }
    case 'number':
    case 'money':
    case 'percent': {
      const n = parseNumber(raw);
      if (n === null) return [raw, 'Informe um número válido'];
      if (f.min !== undefined && n < f.min) return [n, `Mínimo: ${f.min}`];
      if (f.max !== undefined && n > f.max) return [n, `Máximo: ${f.max}`];
      return [Math.round(n * 1000) / 1000, null];
    }
    case 'boolean': {
      const b = parseBoolean(raw);
      if (b === null) return [raw, 'Valor inválido'];
      return [b, null];
    }
    case 'date':
    case 'datetime': {
      const s = String(raw).trim();
      const d = new Date(s);
      if (Number.isNaN(d.getTime())) return [s, 'Data inválida'];
      // 'date' guarda só a parte da data (YYYY-MM-DD) para evitar fuso.
      return [f.type === 'date' ? s.slice(0, 10) : d.toISOString(), null];
    }
    case 'select': {
      const s = String(raw).trim();
      if (f.options && !f.options.some((o) => o.value === s)) return [s, 'Opção inválida'];
      return [s, null];
    }
    default:
      return [raw, null];
  }
}

export type ValidatedPayload = Record<string, unknown>;

/**
 * Valida o body de um POST/PUT contra a definição do recurso.
 * - mode 'create': aplica defaults e exige campos obrigatórios.
 * - mode 'update': valida apenas os campos enviados (PATCH semântico),
 *   mas não permite apagar um campo obrigatório.
 * Lança HttpError(400) com `fields` quando houver problemas.
 */
export function validatePayload(
  r: Resource,
  body: unknown,
  mode: 'create' | 'update'
): ValidatedPayload {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new HttpError(400, 'Corpo da requisição inválido');
  }
  const input = body as Record<string, unknown>;
  const out: ValidatedPayload = {};
  const errors: Record<string, string> = {};

  for (const f of writableFields(r)) {
    const has = Object.prototype.hasOwnProperty.call(input, f.name);
    let raw = has ? input[f.name] : undefined;

    if (mode === 'create' && isBlank(raw) && f.default !== undefined) raw = f.default;

    const [value, err] = coerce(f, raw);
    if (err) {
      errors[f.name] = err;
      continue;
    }

    const required = f.required || (mode === 'create' && f.requiredOnCreate);
    if (value === null) {
      if (required && (mode === 'create' || has)) {
        errors[f.name] = 'Campo obrigatório';
        continue;
      }
      if (mode === 'update' && !has) continue; // não enviado: mantém valor atual
      if (mode === 'create' && !has && f.type === 'password') continue;
    }

    out[f.name] = value;
  }

  if (Object.keys(errors).length) {
    const first = Object.values(errors)[0];
    throw new HttpError(400, `Verifique os campos: ${first}`, errors);
  }
  return out;
}

/** Valida um id de rota. */
export function parseId(v: unknown): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, 'ID inválido');
  return n;
}
