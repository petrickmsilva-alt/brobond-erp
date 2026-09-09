// ============================================================
// Política de senha configurável (Onda 4 — governança).
//
// O administrador define composição (tamanho, complexidade), histórico
// (não repetir as últimas N) e expiração (dias). Persistida em
// `configuracoes` (chave `politica_senha`, JSON); o padrão reproduz
// exatamente a política antiga (mínimo 8 + sem óbvias), então nada muda
// para quem não configurar.
//
// Pontos de aplicação (todos passam por validarSenhaUsuario):
//   • aceitar convite, redefinição por link, troca de senha
//   • login: senha vencida vira troca obrigatória (trocar_senha)
// Senhas temporárias (geradas pelo servidor) e senhas de catálogo seguem
// isentas — validadas pela regra fixa de sempre.
// ============================================================
import { getStore } from './services';
import { verifyPassword } from './password';
import type { Resource } from './resources';

export type PoliticaSenha = {
  /** Tamanho mínimo (6–64). Padrão 8. */
  tamanho_minimo: number;
  /** Exigir maiúsculas E minúsculas. Padrão false. */
  exigir_maiuscula_minuscula: boolean;
  /** Exigir ao menos um número. Padrão false. */
  exigir_numero: boolean;
  /** Exigir ao menos um símbolo. Padrão false. */
  exigir_simbolo: boolean;
  /** Barrar a lista de senhas óbvias. Padrão true. */
  proibir_obvias: boolean;
  /** Não repetir as últimas N senhas (0 = sem histórico). Padrão 0. */
  historico_qtd: number;
  /** Senha vence após N dias (0 = nunca expira). Padrão 0. */
  expiracao_dias: number;
};

export const POLITICA_SENHA_PADRAO: PoliticaSenha = {
  tamanho_minimo: 8,
  exigir_maiuscula_minuscula: false,
  exigir_numero: false,
  exigir_simbolo: false,
  proibir_obvias: true,
  historico_qtd: 0,
  expiracao_dias: 0,
};

export const LIMITES_POLITICA = {
  tamanho_minimo: { min: 6, max: 64 },
  historico_qtd: { min: 0, max: 10 },
  /** 0 = nunca; ou de 7 a 365 dias. */
  expiracao_dias: { min: 7, max: 365 },
} as const;

const CHAVE = 'politica_senha';

/** Recurso interno (fora de RESOURCES: sem CRUD genérico, só via endpoints próprios). */
export const R_CONFIGURACOES: Resource = {
  key: 'configuracoes',
  table: 'configuracoes',
  label: 'Configurações',
  singular: 'Configuração',
  labelFields: ['chave'],
  internal: true,
  ops: { create: false, update: false, delete: false },
  fields: [
    { name: 'chave', label: 'Chave', type: 'text' },
    { name: 'valor', label: 'Valor', type: 'textarea' },
    { name: 'atualizado_em', label: 'Atualizado em', type: 'datetime', readonly: true },
    { name: 'atualizado_por', label: 'Atualizado por', type: 'text', readonly: true },
  ],
};

function normalizarPolitica(v: unknown): PoliticaSenha {
  const p = { ...POLITICA_SENHA_PADRAO, ...((v && typeof v === 'object' ? v : {}) as Partial<PoliticaSenha>) };
  const num = (x: unknown, fb: number) => (Number.isFinite(Number(x)) ? Number(x) : fb);
  return {
    tamanho_minimo: Math.trunc(num(p.tamanho_minimo, 8)),
    exigir_maiuscula_minuscula: p.exigir_maiuscula_minuscula === true,
    exigir_numero: p.exigir_numero === true,
    exigir_simbolo: p.exigir_simbolo === true,
    proibir_obvias: p.proibir_obvias !== false,
    historico_qtd: Math.trunc(num(p.historico_qtd, 0)),
    expiracao_dias: Math.trunc(num(p.expiracao_dias, 0)),
  };
}

/** Lê a política vigente (padrão quando nunca configurada). */
export async function obterPolitica(): Promise<PoliticaSenha> {
  try {
    const row = await getStore().findOneWhere(R_CONFIGURACOES, { chave: CHAVE });
    if (!row?.valor) return { ...POLITICA_SENHA_PADRAO };
    return normalizarPolitica(JSON.parse(String(row.valor)));
  } catch {
    return { ...POLITICA_SENHA_PADRAO };
  }
}

/** Valida e grava a política (o chamador audita). Devolve a política vigente. */
export function validarPoliticaPatch(patch: unknown): { ok: true; politica: PoliticaSenha } | { ok: false; erro: string } {
  const base = normalizarPolitica(patch);
  const L = LIMITES_POLITICA;
  if (base.tamanho_minimo < L.tamanho_minimo.min || base.tamanho_minimo > L.tamanho_minimo.max) {
    return { ok: false, erro: `Tamanho mínimo deve estar entre ${L.tamanho_minimo.min} e ${L.tamanho_minimo.max}.` };
  }
  if (base.historico_qtd < L.historico_qtd.min || base.historico_qtd > L.historico_qtd.max) {
    return { ok: false, erro: `Histórico deve estar entre ${L.historico_qtd.min} (desligado) e ${L.historico_qtd.max}.` };
  }
  if (base.expiracao_dias !== 0 && (base.expiracao_dias < L.expiracao_dias.min || base.expiracao_dias > L.expiracao_dias.max)) {
    return { ok: false, erro: `Expiração deve ser 0 (nunca) ou entre ${L.expiracao_dias.min} e ${L.expiracao_dias.max} dias.` };
  }
  return { ok: true, politica: base };
}

export async function salvarPolitica(patch: unknown, atualizadoPor: string): Promise<PoliticaSenha> {
  const v = validarPoliticaPatch(patch);
  if (!v.ok) throw new Error(v.erro);
  const store = getStore();
  const existente = await store.findOneWhere(R_CONFIGURACOES, { chave: CHAVE });
  const valor = JSON.stringify(v.politica);
  if (existente) {
    await store.update(R_CONFIGURACOES, Number(existente.id), { valor, atualizado_em: new Date().toISOString(), atualizado_por: atualizadoPor });
  } else {
    await store.insert(R_CONFIGURACOES, { chave: CHAVE, valor, atualizado_por: atualizadoPor });
  }
  return v.politica;
}

/** Regras públicas (composição) — o que o medidor de senha precisa saber. */
export function regrasPublicas(p: PoliticaSenha): { tamanho_minimo: number; exigir_maiuscula_minuscula: boolean; exigir_numero: boolean; exigir_simbolo: boolean } {
  return {
    tamanho_minimo: p.tamanho_minimo,
    exigir_maiuscula_minuscula: p.exigir_maiuscula_minuscula,
    exigir_numero: p.exigir_numero,
    exigir_simbolo: p.exigir_simbolo,
  };
}

// ----------------------------------------------------------------------------
// Validação de senha de usuário (composição + histórico)
// ----------------------------------------------------------------------------
const SENHAS_OBVIAS = ['123456', '12345678', '123456789', '1234567890', 'senha', 'senha123', 'password', 'password123', 'qwerty', 'abc123', 'brobond', 'brobond123', 'admin', 'administrador', 'lojinha', 'brasil', 'batata'];

/** Composição pura (síncrona): mesma mensagem da regra antiga quando a política é a padrão. */
export function validarComposicao(senha: string, email: string | undefined, p: PoliticaSenha): string | null {
  const s = String(senha ?? '');
  if (!s) return 'Informe uma senha.';
  if (s.length < p.tamanho_minimo) return `A senha deve ter pelo menos ${p.tamanho_minimo} caracteres.`;
  const lower = s.toLowerCase();
  if (email && lower === String(email).trim().toLowerCase()) return 'A senha não pode ser igual ao e-mail.';
  const parteEmail = String(email || '').split('@')[0].toLowerCase();
  if (parteEmail.length >= 4 && lower.includes(parteEmail)) return 'A senha não pode conter o e-mail.';
  if (p.exigir_maiuscula_minuscula && !(/[a-z]/.test(s) && /[A-Z]/.test(s))) return 'A senha deve ter maiúsculas e minúsculas.';
  if (p.exigir_numero && !/\d/.test(s)) return 'A senha deve ter ao menos um número.';
  if (p.exigir_simbolo && !/[^a-zA-Z0-9]/.test(s)) return 'A senha deve ter ao menos um símbolo (ex.: !@#).';
  if (p.proibir_obvias && (SENHAS_OBVIAS.includes(lower) || /^(.)\1{6,}$/.test(lower))) return 'Escolha uma senha menos óbvia.';
  return null;
}

export type ContextoSenha = {
  email?: string;
  /** Hashes anteriores (coluna senha_historico, JSON) — checados contra a nova senha. */
  historico?: unknown;
  /** Hash atual — a nova senha deve ser diferente. */
  hashAtual?: string | null;
};

/**
 * Validação completa de senha de USUÁRIO (convite, reset, troca).
 * Devolve a mensagem de erro ou null. `rotuloNova` troca "A senha" por
 * "A nova senha" nas mensagens de composição.
 */
export async function validarSenhaUsuario(senha: unknown, ctx: ContextoSenha = {}, rotuloNova = false): Promise<string | null> {
  const p = await obterPolitica();
  const s = String(senha ?? '');
  let erro = validarComposicao(s, ctx.email, p);
  if (erro && rotuloNova) erro = erro.replace(/A senha deve ter/, 'A nova senha deve ter');
  if (erro) return erro;
  if (ctx.hashAtual && (await verifyPassword(s, ctx.hashAtual))) {
    return 'A nova senha deve ser diferente da atual.';
  }
  if (p.historico_qtd > 0) {
    for (const h of lerHistorico(ctx.historico)) {
      if (await verifyPassword(s, h)) return 'Essa senha já foi usada recentemente. Escolha outra.';
    }
  }
  return null;
}

// ----------------------------------------------------------------------------
// Histórico (coluna senha_historico: JSON com os últimos hashes)
// ----------------------------------------------------------------------------
export function lerHistorico(v: unknown): string[] {
  if (!v) return [];
  try {
    const arr = typeof v === 'string' ? JSON.parse(v) : v;
    return Array.isArray(arr) ? arr.filter((x) => typeof x === 'string' && x.length > 10) : [];
  } catch {
    return [];
  }
}

/** Empilha o hash antigo no histórico, respeitando o limite da política. */
export function empurrarHistorico(historicoAtual: unknown, hashAntigo: string | null | undefined, p: PoliticaSenha): string | null {
  if (!p.historico_qtd || !hashAntigo) return p.historico_qtd ? JSON.stringify(lerHistorico(historicoAtual)) : null;
  const arr = [hashAntigo, ...lerHistorico(historicoAtual).filter((h) => h !== hashAntigo)].slice(0, p.historico_qtd);
  return JSON.stringify(arr);
}

// ----------------------------------------------------------------------------
// Expiração (calculada sobre senha_definida_em + política vigente)
// ----------------------------------------------------------------------------
export type Vencimento = { expirada: boolean; venceEmDias: number | null; expiraEm: string | null };

export function vencimentoSenha(row: { senha_definida_em?: unknown }, p: PoliticaSenha, agoraMs: number = Date.now()): Vencimento {
  if (!p.expiracao_dias || !row.senha_definida_em) return { expirada: false, venceEmDias: null, expiraEm: null };
  const definidaMs = new Date(String(row.senha_definida_em)).getTime();
  if (!Number.isFinite(definidaMs)) return { expirada: false, venceEmDias: null, expiraEm: null };
  const expiraMs = definidaMs + p.expiracao_dias * 24 * 3600_000;
  if (expiraMs <= agoraMs) return { expirada: true, venceEmDias: 0, expiraEm: new Date(expiraMs).toISOString() };
  return { expirada: false, venceEmDias: Math.ceil((expiraMs - agoraMs) / (24 * 3600_000)), expiraEm: new Date(expiraMs).toISOString() };
}
