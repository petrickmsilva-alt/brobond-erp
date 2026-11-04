// ============================================================
// Webhooks de eventos de usuário (Onda 4 — governança).
//
// O administrador cadastra URLs que recebem POST JSON a cada evento do
// ciclo de vida das contas (criação, bloqueio, MFA, certificação...).
// Cada entrega é assinada (HMAC-SHA256 do corpo, header
// X-Brobond-Signature) e registrada em `webhook_entregas` com estado,
// resposta e erro — com reenvio manual.
//
// Desenho:
//   • Recursos internos (fora de RESOURCES): CRUD só pelos endpoints
//     próprios; o segredo sai da API UMA vez (criação/regeneração) e
//     dorme cifrado (AES-GCM, mesma chave do MFA).
//   • O disparo é fire-and-forget e NUNCA derruba a ação principal:
//     `disparar()` engole qualquer erro interno.
//   • Log aparado: 200 entregas por webhook (as mais recentes).
// ============================================================
import { createHmac, randomBytes } from 'node:crypto';
import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { Request, Response } from 'express';
import { HttpError } from './errors';
import { empresaDoAtorAudit, escopoDoAtor } from './empresa';
import { currentUser, exigirReautenticacao } from './auth';
import { getStore } from './services';
import type { Resource } from './resources';
import type { Row } from './store';

export const R_WEBHOOKS: Resource = {
  key: 'webhooks',
  table: 'webhooks',
  label: 'Webhooks',
  singular: 'Webhook',
  labelFields: ['nome'],
  internal: true,
  ops: { create: false, update: false, delete: false },
  orderBy: { field: 'id', dir: 'asc' },
  fields: [
    { name: 'nome', label: 'Nome', type: 'text', search: true },
    { name: 'url', label: 'URL', type: 'text', search: true },
    { name: 'segredo_cifrado', label: 'Segredo', type: 'text', readonly: true },
    { name: 'eventos', label: 'Eventos', type: 'textarea' },
    { name: 'ativo', label: 'Ativo', type: 'boolean', default: true },
    { name: 'criado_em', label: 'Criado em', type: 'datetime', readonly: true },
    { name: 'criado_por', label: 'Criado por', type: 'text', readonly: true },
    { name: 'atualizado_em', label: 'Atualizado em', type: 'datetime', readonly: true },
    // R-14: NULL = global. Sem default: nunca inferido (migração 0097).
    { name: 'empresa_id', label: 'Empresa', type: 'integer', readonly: true },
  ],
};

export const R_ENTREGAS: Resource = {
  key: 'webhook_entregas',
  table: 'webhook_entregas',
  label: 'Entregas de webhook',
  singular: 'Entrega',
  labelFields: ['id'],
  internal: true,
  ops: { create: false, update: false, delete: false },
  orderBy: { field: 'id', dir: 'desc' },
  fields: [
    { name: 'webhook_id', label: 'Webhook', type: 'integer' },
    { name: 'evento', label: 'Evento', type: 'text' },
    { name: 'payload', label: 'Payload', type: 'textarea' },
    { name: 'estado', label: 'Estado', type: 'text' },
    { name: 'tentativas', label: 'Tentativas', type: 'integer' },
    { name: 'resposta_status', label: 'HTTP', type: 'integer' },
    { name: 'resposta_corpo', label: 'Resposta', type: 'textarea' },
    { name: 'erro', label: 'Erro', type: 'text' },
    { name: 'criada_em', label: 'Criada em', type: 'datetime', readonly: true },
    { name: 'concluida_em', label: 'Concluída em', type: 'datetime', readonly: true },
    // R-14: herda a empresa do webhook que gerou a entrega; NULL = global/legado (oculto a empresas).
    { name: 'empresa_id', label: 'Empresa', type: 'integer', readonly: true },
  ],
};

/** Catálogo de eventos assináveis (ids estáveis — viram contrato). */
export const EVENTOS_WEBHOOK: { id: string; label: string }[] = [
  { id: 'usuario.criado', label: 'Usuário criado' },
  { id: 'usuario.convite_enviado', label: 'Convite enviado' },
  { id: 'usuario.desativado', label: 'Usuário desativado' },
  { id: 'usuario.ativado', label: 'Usuário reativado' },
  { id: 'usuario.bloqueado', label: 'Acesso bloqueado' },
  { id: 'usuario.desbloqueado', label: 'Acesso desbloqueado' },
  { id: 'usuario.senha_temporaria', label: 'Senha temporária gerada' },
  { id: 'usuario.mfa_resetado', label: 'MFA resetado' },
  { id: 'usuario.acesso_certificado', label: 'Acesso certificado' },
];

const EVENTO_TESTE = 'webhook.teste';
const TIMEOUT_MS = 6000;
const MANTEM_ENTREGAS = 200;

function exigirAdminLocal(actor: { perfil?: string }, acao: string): void {
  if (actor?.perfil !== 'admin') throw new HttpError(403, `Apenas administradores ${acao}.`);
}

/**
 * Empresa do CONTEXTO autenticado do ator (R-14). Nunca vem do corpo da requisição nem do payload.
 * Devolve `undefined` quando não há empresa única e confiável (sem vínculo, ou modo consolidado):
 * nesses casos a operação não é associada automaticamente a uma empresa.
 */
export function empresaDoContexto(actor: any): number | undefined {
  if (!actor || !(Number(actor.empresa_id) > 0)) return undefined;
  const escopo = escopoDoAtor(actor);
  if (escopo.consolidado) return undefined;
  return escopo.empresaId > 0 ? escopo.empresaId : undefined;
}

/** Empresa gravada no registro (null = global). Entregas herdam a empresa do webhook que as gerou. */
export function empresaDoWebhook(w: { empresa_id?: unknown } | null | undefined): number | null {
  const n = Number(w?.empresa_id);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** Webhook gerenciável por este ator: pertence à empresa do contexto. Global/legado = fora de escopo. */
function webhookDoEscopo(w: Row | null | undefined, actor: any): boolean {
  const empresa = empresaDoContexto(actor);
  return !!w && empresa !== undefined && empresaDoWebhook(w) === empresa;
}

export function lerEventos(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter((x) => typeof x === 'string');
  if (typeof v === 'string') {
    try {
      const arr = JSON.parse(v);
      return Array.isArray(arr) ? arr.filter((x) => typeof x === 'string') : [];
    } catch {
      return [];
    }
  }
  return [];
}

/**
 * Endereço que um webhook de saída não pode alcançar: loopback, rede privada,
 * CGNAT, link-local (inclui metadados de nuvem 169.254.169.254), reservados,
 * multicast e equivalentes IPv6 (inclusive IPv4 mapeado: ::ffff:10.0.0.1).
 */
export function enderecoInterno(endereco: string): boolean {
  const a = String(endereco).toLowerCase().replace(/^\[|\]$/g, '');
  const mapeado = a.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapeado) return enderecoInterno(mapeado[1]);
  // O WHATWG URL normaliza ::ffff:a.b.c.d para a forma hexadecimal ::ffff:xxxx:yyyy.
  const mapeadoHex = a.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mapeadoHex) {
    const hi = parseInt(mapeadoHex[1], 16);
    const lo = parseInt(mapeadoHex[2], 16);
    return enderecoInterno(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  }
  const versao = isIP(a);
  if (versao === 4) {
    const [p1, p2] = a.split('.').map(Number);
    return (
      p1 === 0 || p1 === 10 || p1 === 127 ||
      (p1 === 100 && p2 >= 64 && p2 <= 127) ||
      (p1 === 169 && p2 === 254) ||
      (p1 === 172 && p2 >= 16 && p2 <= 31) ||
      (p1 === 192 && (p2 === 168 || p2 === 0)) ||
      (p1 === 198 && (p2 === 18 || p2 === 19)) ||
      p1 >= 224
    );
  }
  if (versao === 6) {
    return a === '::' || a === '::1' || /^f[cd]/.test(a) || /^fe[89ab]/.test(a) || a.startsWith('ff');
  }
  return false;
}

/** Nome de host que aponta para a rede interna por convenção (sem resolver DNS). */
export function hostnameInterno(host: string): boolean {
  const h = String(host).toLowerCase().replace(/\.$/, '');
  if (isIP(h.replace(/^\[|\]$/g, ''))) return enderecoInterno(h);
  return (
    h === 'localhost' || h === 'metadata.google.internal' ||
    /\.(localhost|local|internal|localdomain)$/.test(h)
  );
}

export type ResolvedorDns = (host: string) => Promise<string[]>;
const resolverPadrao: ResolvedorDns = async (host) =>
  (await dnsLookup(host, { all: true, verbatim: true })).map((r) => r.address);

/**
 * Confere TODOS os endereços que o host resolve agora. Falha fechada: se não
 * resolver, a entrega não acontece. Mensagem nunca revela o endereço.
 * Limite conhecido: um DNS que mude depois desta checagem (rebinding) não é
 * coberto aqui; a mitigação completa exige fixar o IP na conexão.
 */
export async function destinoInterno(host: string, resolver: ResolvedorDns = resolverPadrao): Promise<string | null> {
  if (hostnameInterno(host)) return 'Em produção, webhooks não podem apontar para a rede interna.';
  if (isIP(host.replace(/^\[|\]$/g, ''))) return null;
  let enderecos: string[];
  try {
    enderecos = await resolver(host);
  } catch {
    return 'Não foi possível resolver o destino do webhook.';
  }
  if (!enderecos.length) return 'Não foi possível resolver o destino do webhook.';
  return enderecos.some(enderecoInterno) ? 'O destino do webhook resolve para a rede interna.' : null;
}

/** Valida a URL (em produção, barra rede interna — anti-SSRF). */
export function validarUrlWebhook(url: unknown): string | null {
  let u: URL;
  try {
    u = new URL(String(url || ''));
  } catch {
    return 'Informe uma URL válida (https://...).';
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return 'A URL deve começar com http:// ou https://.';
  if (process.env.NODE_ENV === 'production') {
    if (hostnameInterno(u.hostname)) return 'Em produção, webhooks não podem apontar para a rede interna.';
  }
  return null;
}

function validarEventos(v: unknown): { ok: true; eventos: string[] } | { ok: false; erro: string } {
  const ids = new Set(EVENTOS_WEBHOOK.map((e) => e.id));
  const lista = [...new Set(lerEventos(v))];
  if (!lista.length) return { ok: false, erro: 'Escolha ao menos um evento.' };
  const estranho = lista.find((e) => !ids.has(e));
  if (estranho) return { ok: false, erro: `Evento desconhecido: ${estranho}.` };
  return { ok: true, eventos: lista };
}

/** HMAC-SHA256 do corpo bruto, no formato do header (sha256=hex). */
export function assinarCorpo(segredo: string, corpo: string): string {
  return `sha256=${createHmac('sha256', segredo).update(corpo, 'utf8').digest('hex')}`;
}

function gerarSegredo(): string {
  return randomBytes(24).toString('hex');
}

async function cifrar(segredo: string): Promise<string> {
  const { cifrarSegredoMfa } = await import('./mfa');
  return cifrarSegredoMfa(segredo);
}

async function decifrar(cifrado: unknown): Promise<string | null> {
  const { decifrarSegredoMfa } = await import('./mfa');
  return decifrarSegredoMfa(typeof cifrado === 'string' ? cifrado : null);
}

/** Forma pública: sem o segredo, com eventos parseados e contadores. */
function publicar(w: Row, contadores?: { entregas_24h: number; erros_24h: number; ultima_entrega_em: string | null; ultimo_estado: string | null }): Record<string, unknown> {
  return {
    id: Number(w.id),
    nome: w.nome,
    url: w.url,
    eventos: lerEventos(w.eventos),
    ativo: w.ativo !== false,
    tem_segredo: !!w.segredo_cifrado,
    criado_em: w.criado_em || null,
    criado_por: w.criado_por || null,
    atualizado_em: w.atualizado_em || null,
    ...(contadores || {}),
  };
}

// ----------------------------------------------------------------------------
// Entrega (transporte + registro)
// ----------------------------------------------------------------------------
type ResultadoEntrega = { estado: 'ok' | 'erro'; status: number | null; corpo: string | null; erro: string | null; ms: number };

export type DepsPostagem = { fetch?: typeof fetch; resolver?: ResolvedorDns; producao?: boolean };

export async function postar(
  url: string,
  corpo: string,
  evento: string,
  segredo: string | null,
  deps: DepsPostagem = {}
): Promise<ResultadoEntrega> {
  const inicio = Date.now();
  try {
    const producao = deps.producao ?? process.env.NODE_ENV === 'production';
    if (producao) {
      const bloqueio = await destinoInterno(new URL(url).hostname, deps.resolver);
      if (bloqueio) return { estado: 'erro', status: null, corpo: null, erro: bloqueio, ms: Date.now() - inicio };
    }
    const doFetch = deps.fetch ?? fetch;
    // Redirecionamento NÃO é seguido: um 3xx poderia levar a um destino interno.
    const res = await doFetch(url, {
      redirect: 'manual',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Brobond-Event': evento,
        ...(segredo ? { 'X-Brobond-Signature': assinarCorpo(segredo, corpo) } : {}),
      },
      body: corpo,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const texto = await res.text().catch(() => '');
    const ok = res.status >= 200 && res.status < 300;
    const erro = ok ? null : res.status >= 300 && res.status < 400 ? `Redirecionamento não seguido (HTTP ${res.status})` : `HTTP ${res.status}`;
    return { estado: ok ? 'ok' : 'erro', status: res.status, corpo: texto.slice(0, 2000) || null, erro, ms: Date.now() - inicio };
  } catch (e: any) {
    const msg = e?.name === 'TimeoutError' ? `Tempo esgotado (${TIMEOUT_MS / 1000}s)` : e?.message || 'Falha de rede';
    return { estado: 'erro', status: null, corpo: null, erro: String(msg).slice(0, 500), ms: Date.now() - inicio };
  }
}

/** Apaga entregas antigas além das 200 mais recentes do webhook. */
async function apararEntregas(webhookId: number): Promise<void> {
  try {
    const store = getStore();
    const todas = await store.list(R_ENTREGAS, { page: 1, pageSize: 1000, sort: 'id', dir: 'asc', filter: { webhook_id: webhookId } });
    if (todas.total <= MANTEM_ENTREGAS + 20) return;
    const excedentes = todas.rows.slice(0, todas.total - MANTEM_ENTREGAS).slice(0, 500);
    for (const e of excedentes) await store.remove(R_ENTREGAS, Number(e.id)).catch(() => false);
  } catch {
    /* indiferente */
  }
}

export type EntregaFeita = { entrega_id: number; estado: 'ok' | 'erro'; resposta_status: number | null; ms: number };

/**
 * Entrega um evento a UM webhook e registra o resultado. Nunca lança
 * (o registro pode falhar com o banco fora — o fluxo principal segue).
 */
export async function entregar(webhook: Row, evento: string, dados: Record<string, unknown>): Promise<EntregaFeita | null> {
  const corpo = JSON.stringify({ evento, ocorrido_em: new Date().toISOString(), dados });
  let resultado: ResultadoEntrega;
  try {
    resultado = await postar(String(webhook.url), corpo, evento, await decifrar(webhook.segredo_cifrado));
  } catch {
    resultado = { estado: 'erro', status: null, corpo: null, erro: 'Falha inesperada no envio', ms: 0 };
  }
  try {
    const store = getStore();
    const reg = await store.insert(R_ENTREGAS, {
      webhook_id: Number(webhook.id),
      empresa_id: empresaDoWebhook(webhook),
      evento,
      payload: corpo,
      estado: resultado.estado,
      tentativas: 1,
      resposta_status: resultado.status,
      resposta_corpo: resultado.corpo,
      erro: resultado.erro,
      concluida_em: new Date().toISOString(),
    });
    void apararEntregas(Number(webhook.id));
    return { entrega_id: Number(reg.id), estado: resultado.estado, resposta_status: resultado.status, ms: resultado.ms };
  } catch {
    return null;
  }
}

/**
 * Webhooks ativos que assinam o evento, no escopo informado (R-14):
 *  - com empresa: somente webhooks DESSA empresa (nunca globais, nunca de outra empresa);
 *  - sem empresa: somente webhooks GLOBAIS (empresa_id NULL).
 * A empresa nunca é inferida do payload.
 */
export async function alvosDoEvento(evento: string, empresaId: number | null | undefined): Promise<Row[]> {
  const store = getStore();
  const escopo = Number(empresaId) > 0 ? Number(empresaId) : null;
  const todos = escopo
    ? await store.list(R_WEBHOOKS, { page: 1, pageSize: 1000, sort: 'id', dir: 'asc', filter: { empresa_id: escopo } })
    : await store.list(R_WEBHOOKS, { page: 1, pageSize: 1000, sort: 'id', dir: 'asc' });
  return (todos.rows || []).filter(
    (w) =>
      w.ativo !== false &&
      lerEventos(w.eventos).includes(evento) &&
      (escopo ? empresaDoWebhook(w) === escopo : empresaDoWebhook(w) === null),
  );
}

/**
 * Dispara um evento para os webhooks ativos assinantes do escopo (ver alvosDoEvento).
 * Fire-and-forget: resolve sempre (nunca rejeita, nunca lança).
 */
export async function disparar(evento: string, dados: Record<string, unknown>, empresaId?: number | null): Promise<void> {
  try {
    const alvos = await alvosDoEvento(evento, empresaId);
    await Promise.allSettled(alvos.map((w) => entregar(w, evento, dados)));
  } catch {
    /* o fluxo principal nunca pode cair por causa de integração */
  }
}

// ----------------------------------------------------------------------------
// Endpoints — gestão
// ----------------------------------------------------------------------------
/** GET /api/webhooks — lista com contadores de 24h + catálogo de eventos. */
export async function listarWebhooks(req: Request, res: Response) {
  const actor = currentUser(req);
  exigirAdminLocal(actor, 'gerenciam webhooks');
  const empresa = empresaDoContexto(actor);
  if (empresa === undefined) throw new HttpError(403, 'Selecione uma empresa para gerenciar webhooks.');
  const store = getStore();
  const todos = await store.list(R_WEBHOOKS, { page: 1, pageSize: 100, sort: 'id', dir: 'asc', filter: { empresa_id: empresa } });
  const ha24h = Date.now() - 24 * 3600_000;
  const itens = [];
  for (const w of todos.rows || []) {
    const contadores = { entregas_24h: 0, erros_24h: 0, ultima_entrega_em: null as string | null, ultimo_estado: null as string | null };
    try {
      const ent = await store.list(R_ENTREGAS, { page: 1, pageSize: 500, sort: 'id', dir: 'desc', filter: { webhook_id: Number(w.id) } });
      const rows = ent.rows || [];
      if (rows[0]) {
        contadores.ultima_entrega_em = String(rows[0].concluida_em || rows[0].criada_em || '');
        contadores.ultimo_estado = String(rows[0].estado || '');
      }
      for (const e of rows) {
        const ms = new Date(String(e.concluida_em || e.criada_em || 0)).getTime();
        if (ms >= ha24h) {
          contadores.entregas_24h++;
          if (e.estado !== 'ok') contadores.erros_24h++;
        }
      }
    } catch {
      /* indiferente */
    }
    itens.push(publicar(w, contadores));
  }
  res.json({ webhooks: itens, eventos_disponiveis: EVENTOS_WEBHOOK });
}

/** POST /api/webhooks — cria (reautenticação). O segredo volta UMA vez. */
export async function criarWebhook(req: Request, res: Response) {
  const actor = currentUser(req);
  exigirAdminLocal(actor, 'criam webhooks');
  exigirReautenticacao(req);
  const nome = String(req.body?.nome || '').trim();
  const url = String(req.body?.url || '').trim();
  if (!nome) throw new HttpError(400, 'Dê um nome ao webhook (ex.: "SIEM da matriz").');
  if (nome.length > 80) throw new HttpError(400, 'Nome com no máximo 80 caracteres.');
  const erroUrl = validarUrlWebhook(url);
  if (erroUrl) throw new HttpError(400, erroUrl);
  const ev = validarEventos(req.body?.eventos);
  if (!ev.ok) throw new HttpError(400, ev.erro);
  const empresa = empresaDoContexto(actor);
  if (empresa === undefined) throw new HttpError(403, 'Selecione uma empresa para criar webhooks.');
  const segredo = gerarSegredo();
  const store = getStore();
  // A empresa vem do contexto autenticado; o corpo da requisição não decide tenant (R-14).
  const row = await store.insert(R_WEBHOOKS, {
    nome,
    url,
    segredo_cifrado: await cifrar(segredo),
    eventos: JSON.stringify(ev.eventos),
    ativo: req.body?.ativo !== false,
    criado_por: actor.name || null,
    empresa_id: empresa,
  });
  await store
    .audit({
      usuario_id: actor.id,
      usuario: actor.name,
      acao: 'seguranca',
      recurso: 'webhooks',
      registro_id: Number(row.id),
      descricao: `Webhook "${nome}" criado por ${actor.name} (${ev.eventos.length} evento(s))`,
      empresa_id: empresaDoAtorAudit(actor),
    })
    .catch(() => undefined);
  res.status(201).json({ ...(publicar(row) as object), segredo });
}

/** PUT /api/webhooks/:id — atualiza (reautenticação). */
export async function atualizarWebhook(req: Request, res: Response) {
  const actor = currentUser(req);
  exigirAdminLocal(actor, 'alteram webhooks');
  exigirReautenticacao(req);
  const store = getStore();
  const id = Number(req.params.id);
  const atual = await store.findOneWhere(R_WEBHOOKS, { id });
  if (!atual || !webhookDoEscopo(atual, actor)) throw new HttpError(404, 'Webhook não encontrado.');
  const patch: Record<string, unknown> = {};
  if (req.body?.nome !== undefined) {
    const nome = String(req.body.nome || '').trim();
    if (!nome) throw new HttpError(400, 'O nome não pode ficar vazio.');
    if (nome.length > 80) throw new HttpError(400, 'Nome com no máximo 80 caracteres.');
    patch.nome = nome;
  }
  if (req.body?.url !== undefined) {
    const url = String(req.body.url || '').trim();
    const erroUrl = validarUrlWebhook(url);
    if (erroUrl) throw new HttpError(400, erroUrl);
    patch.url = url;
  }
  if (req.body?.eventos !== undefined) {
    const ev = validarEventos(req.body.eventos);
    if (!ev.ok) throw new HttpError(400, ev.erro);
    patch.eventos = JSON.stringify(ev.eventos);
  }
  if (req.body?.ativo !== undefined) patch.ativo = req.body.ativo !== false;
  let segredoNovo: string | undefined;
  if (req.body?.regenerar_segredo === true) {
    segredoNovo = gerarSegredo();
    patch.segredo_cifrado = await cifrar(segredoNovo);
  }
  if (!Object.keys(patch).length) throw new HttpError(400, 'Nada para atualizar.');
  patch.atualizado_em = new Date().toISOString();
  const row = await store.update(R_WEBHOOKS, id, patch);
  await store
    .audit({
      usuario_id: actor.id,
      usuario: actor.name,
      acao: 'seguranca',
      recurso: 'webhooks',
      registro_id: id,
      descricao: `Webhook "${String(atual.nome)}" alterado por ${actor.name}${segredoNovo ? ' (segredo regenerado)' : ''}`,
      empresa_id: empresaDoAtorAudit(actor),
    })
    .catch(() => undefined);
  res.json({ ...((row ? publicar(row) : publicar({ ...atual, ...patch })) as object), ...(segredoNovo ? { segredo: segredoNovo } : {}) });
}

/** DELETE /api/webhooks/:id — exclui com o log (reautenticação). */
export async function excluirWebhook(req: Request, res: Response) {
  const actor = currentUser(req);
  exigirAdminLocal(actor, 'excluem webhooks');
  exigirReautenticacao(req);
  const store = getStore();
  const id = Number(req.params.id);
  const atual = await store.findOneWhere(R_WEBHOOKS, { id });
  if (!atual || !webhookDoEscopo(atual, actor)) throw new HttpError(404, 'Webhook não encontrado.');
  // Apaga o log junto (no Postgres o ON DELETE CASCADE já faria; no modo
  // memória a limpeza é manual).
  for (;;) {
    const ent = await store.list(R_ENTREGAS, { page: 1, pageSize: 200, filter: { webhook_id: id } });
    if (!ent.rows?.length) break;
    for (const e of ent.rows) await store.remove(R_ENTREGAS, Number(e.id)).catch(() => false);
    if (ent.rows.length < 200) break;
  }
  await store.remove(R_WEBHOOKS, id);
  await store
    .audit({
      usuario_id: actor.id,
      usuario: actor.name,
      acao: 'seguranca',
      recurso: 'webhooks',
      registro_id: id,
      descricao: `Webhook "${String(atual.nome)}" excluído por ${actor.name}`,
      empresa_id: empresaDoAtorAudit(actor),
    })
    .catch(() => undefined);
  res.json({ ok: true });
}

/** POST /api/webhooks/:id/testar — dispara um evento de teste e devolve o resultado. */
export async function testarWebhook(req: Request, res: Response) {
  const actor = currentUser(req);
  exigirAdminLocal(actor, 'testam webhooks');
  const store = getStore();
  const id = Number(req.params.id);
  const w = await store.findOneWhere(R_WEBHOOKS, { id });
  if (!w || !webhookDoEscopo(w, actor)) throw new HttpError(404, 'Webhook não encontrado.');
  if (w.ativo === false) throw new HttpError(409, 'Ative o webhook antes de testar.');
  const feito = await entregar(w, EVENTO_TESTE, { mensagem: 'Evento de teste do BROBOND ERP. Se chegou, a integração funciona.' });
  if (!feito) throw new HttpError(500, 'Não foi possível registrar a entrega.');
  res.json({ ok: feito.estado === 'ok', ...feito });
}

/** GET /api/webhooks/:id/entregas — log (50 recentes, filtro por estado). */
export async function listarEntregas(req: Request, res: Response) {
  const actor = currentUser(req);
  exigirAdminLocal(actor, 'veem entregas de webhooks');
  const store = getStore();
  const id = Number(req.params.id);
  const w = await store.findOneWhere(R_WEBHOOKS, { id });
  if (!w || !webhookDoEscopo(w, actor)) throw new HttpError(404, 'Webhook não encontrado.');
  // Entregas só da própria empresa: entregas sem empresa (legado/global) nunca aparecem aqui.
  const empresa = empresaDoWebhook(w);
  const estado = String(req.query.estado || '');
  const limite = Math.min(200, Math.max(1, Number(req.query.limite) || 50));
  const ent = await store.list(R_ENTREGAS, {
    page: 1,
    pageSize: limite,
    sort: 'id',
    dir: 'desc',
    filter: { webhook_id: id, empresa_id: empresa, ...(estado === 'ok' || estado === 'erro' ? { estado } : {}) },
  });
  res.json({
    webhook: { id, nome: String(w.nome) },
    total: ent.total,
    entregas: (ent.rows || []).map((e) => ({
      id: Number(e.id),
      evento: e.evento,
      estado: e.estado,
      tentativas: Number(e.tentativas || 1),
      resposta_status: e.resposta_status ?? null,
      resposta_corpo: e.resposta_corpo ?? null,
      erro: e.erro ?? null,
      criada_em: e.criada_em || null,
      concluida_em: e.concluida_em || null,
      payload: (() => {
        try {
          return JSON.parse(String(e.payload || '{}'));
        } catch {
          return null;
        }
      })(),
    })),
  });
}

/** POST /api/webhooks/entregas/:id/reenviar — tenta de novo e atualiza o registro. */
export async function reenviarEntrega(req: Request, res: Response) {
  const actor = currentUser(req);
  exigirAdminLocal(actor, 'reencaminham entregas');
  const store = getStore();
  const id = Number(req.params.id);
  const ent = await store.findOneWhere(R_ENTREGAS, { id });
  const empresa = empresaDoContexto(actor);
  if (!ent || empresa === undefined || empresaDoWebhook(ent) !== empresa) throw new HttpError(404, 'Entrega não encontrada.');
  const w = await store.findOneWhere(R_WEBHOOKS, { id: Number(ent.webhook_id) });
  if (!w || !webhookDoEscopo(w, actor)) throw new HttpError(404, 'Webhook de origem não existe mais.');
  let evento = String(ent.evento);
  let dados: Record<string, unknown> = {};
  try {
    const p = JSON.parse(String(ent.payload || '{}'));
    if (p && typeof p === 'object') {
      if (typeof p.evento === 'string') evento = p.evento;
      if (p.dados && typeof p.dados === 'object') dados = p.dados as Record<string, unknown>;
    }
  } catch {
    /* payload ilegível: reenvia só o evento */
  }
  const corpo = JSON.stringify({ evento, ocorrido_em: new Date().toISOString(), dados, reenvio_de: id });
  const resultado = await postar(String(w.url), corpo, evento, await decifrar(w.segredo_cifrado));
  const tentativas = Number(ent.tentativas || 1) + 1;
  await store.update(R_ENTREGAS, id, {
    estado: resultado.estado,
    tentativas,
    resposta_status: resultado.status,
    resposta_corpo: resultado.corpo,
    erro: resultado.erro,
    concluida_em: new Date().toISOString(),
  });
  res.json({ ok: resultado.estado === 'ok', entrega_id: id, estado: resultado.estado, tentativas, resposta_status: resultado.status, ms: resultado.ms });
}
