// ============================================================================
// GATEWAY DE PAGAMENTO (P2 §7–§9) — arquitetura de ADAPTER.
//
// O ERP NÃO é acoplado a um gateway: tudo passa pela interface
// `PaymentProvider` (criar, consultar, cancelar, estornar, processar
// webhook). Provedores se registram no registry; hoje existem dois:
//
//   • `mock`        — determinístico, SOMENTE fora de produção (testes);
//   • `mercadopago` — escrito contra a API pública oficial; sem credencial
//                     responde 503 (nunca inventa resposta de gateway).
//
// Suporta PIX, boleto e cartão (este via token — o ERP não toca dados de
// cartão; tokenização é responsabilidade do front/SDK com a public key).
//
// Webhooks de ENTRADA (P2 §8):
//   • validação de assinatura quando houver segredo configurado;
//   • idempotência por (provedor, evento) — índice único: a mesma
//     notificação JAMAIS processa duas vezes (e nunca gera duas baixas);
//   • evento persistido ANTES de processar (recebido → processado|erro);
//   • retry com backoff exponencial (cron/manual) sem duplicar efeito — o
//     processamento é todo idempotente (guarda de status + baixa condicional).
//
// Segredos: credenciais e segredo de webhook cifrados em repouso
// (AES-256-GCM, segredos.ts). Nunca voltam em texto puro pela API.
// ============================================================================
import { createHmac, createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Request, Response, Router } from 'express';
import express from 'express';
import { HttpError } from './errors';
import { getResource, type Resource } from './resources';
import { checkAccess, getStore } from './services';
import { currentUser, exigirReautenticacao, type AuthUser } from './auth';
import { aplicarFiltroEmpresa, assertRegistroDaEmpresa, escopoDoAtor } from './empresa';
import { round2 } from './utils';
import { calcularLiquido, efetuarBaixa } from './financeiro';
import { registrarEstornoComissao } from './comissoes';
import { cifrarSegredo, decifrarSegredo, pareceCifrado } from './segredos';
import type { Row, Tx } from './store';

// ----------------------------------------------------------------------------
// Recursos internos (fora de RESOURCES: sem CRUD genérico)
// ----------------------------------------------------------------------------

export const R_GATEWAY_CONFIGS: Resource = {
  key: 'gateway_configs',
  table: 'gateway_configs',
  label: 'Configurações de gateway',
  singular: 'Configuração de gateway',
  labelFields: ['provider'],
  internal: true,
  empresa: true,
  ops: { create: false, update: false, delete: false },
  orderBy: { field: 'id', dir: 'asc' },
  fields: [
    { name: 'empresa_id', label: 'Empresa', type: 'integer', readonly: true },
    { name: 'provider', label: 'Provedor', type: 'text' },
    { name: 'ambiente', label: 'Ambiente', type: 'text' },
    { name: 'credenciais_cifradas', label: 'Credenciais', type: 'text', readonly: true },
    { name: 'webhook_segredo_cifrado', label: 'Segredo do webhook', type: 'text', readonly: true },
    { name: 'ativo', label: 'Ativo', type: 'boolean' },
    { name: 'observacoes', label: 'Observações', type: 'text' },
    { name: 'criado_em', label: 'Criado em', type: 'datetime', readonly: true },
    { name: 'atualizado_em', label: 'Atualizado em', type: 'datetime', readonly: true },
  ],
};

export const R_GATEWAY_COBRANCAS: Resource = {
  key: 'gateway_cobrancas',
  table: 'gateway_cobrancas',
  label: 'Cobranças de gateway',
  singular: 'Cobrança',
  labelFields: ['id'],
  internal: true,
  empresa: true,
  ops: { create: false, update: false, delete: false },
  orderBy: { field: 'id', dir: 'desc' },
  fields: [
    { name: 'empresa_id', label: 'Empresa', type: 'integer', readonly: true },
    { name: 'provider', label: 'Provedor', type: 'text' },
    { name: 'metodo', label: 'Método', type: 'text' },
    { name: 'venda_id', label: 'Venda', type: 'integer' },
    { name: 'lancamento_id', label: 'Lançamento', type: 'integer' },
    { name: 'conta_id', label: 'Conta', type: 'integer' },
    { name: 'valor', label: 'Valor', type: 'money' },
    { name: 'taxa_pct', label: 'Taxa (%)', type: 'percent' },
    { name: 'valor_liquido', label: 'Líquido', type: 'money' },
    { name: 'parcelas', label: 'Parcelas', type: 'integer' },
    { name: 'status', label: 'Status', type: 'text' },
    { name: 'provider_ref', label: 'Ref. no provedor', type: 'text' },
    { name: 'idempotency_key', label: 'Chave de idempotência', type: 'text' },
    { name: 'expires_em', label: 'Expira em', type: 'datetime' },
    { name: 'nosso_numero', label: 'Nosso número', type: 'text' },
    { name: 'linha_digitavel', label: 'Linha digitável', type: 'text' },
    { name: 'qr_code', label: 'QR Code', type: 'text' },
    { name: 'copia_cola', label: 'Copia e cola', type: 'text' },
    { name: 'nsu', label: 'NSU', type: 'text' },
    { name: 'webhook_evento_id', label: 'Evento de confirmação', type: 'text' },
    { name: 'payload', label: 'Payload', type: 'textarea' },
    { name: 'observacoes', label: 'Observações', type: 'text' },
    { name: 'criado_em', label: 'Criado em', type: 'datetime', readonly: true },
    { name: 'atualizado_em', label: 'Atualizado em', type: 'datetime', readonly: true },
  ],
};

export const R_GATEWAY_WEBHOOK_EVENTS: Resource = {
  key: 'gateway_webhook_events',
  table: 'gateway_webhook_events',
  label: 'Eventos de webhook',
  singular: 'Evento de webhook',
  labelFields: ['evento_id'],
  internal: true,
  empresa: true,
  ops: { create: false, update: false, delete: false },
  orderBy: { field: 'id', dir: 'desc' },
  fields: [
    { name: 'empresa_id', label: 'Empresa', type: 'integer', readonly: true },
    { name: 'provider', label: 'Provedor', type: 'text' },
    { name: 'evento_id', label: 'Evento (id)', type: 'text' },
    { name: 'evento', label: 'Evento', type: 'text' },
    { name: 'payload', label: 'Payload', type: 'textarea' },
    { name: 'assinatura_ok', label: 'Assinatura OK', type: 'boolean' },
    { name: 'status', label: 'Status', type: 'text' },
    { name: 'tentativas', label: 'Tentativas', type: 'integer' },
    { name: 'proxima_tentativa_em', label: 'Próxima tentativa', type: 'datetime' },
    { name: 'ultima_tentativa_em', label: 'Última tentativa', type: 'datetime' },
    { name: 'erro', label: 'Erro', type: 'text' },
    { name: 'cobranca_id', label: 'Cobrança', type: 'integer' },
    { name: 'lancamento_id', label: 'Lançamento', type: 'integer' },
    { name: 'recebido_em', label: 'Recebido em', type: 'datetime', readonly: true },
    { name: 'processado_em', label: 'Processado em', type: 'datetime', readonly: true },
  ],
};

// ----------------------------------------------------------------------------
// Contrato do adapter
// ----------------------------------------------------------------------------

export type MetodoCobranca = 'pix' | 'boleto' | 'cartao_credito' | 'cartao_debito';
export const METODOS_SUPORTADOS: MetodoCobranca[] = ['pix', 'boleto', 'cartao_credito', 'cartao_debito'];

export type GatewayContext = {
  empresaId: number;
  config: Row | null;
  /** Credenciais decifradas (JSON) — só vivem durante a requisição. */
  credenciais: Record<string, string> | null;
  /** Segredo do webhook decifrado (ou null). */
  webhookSegredo: string | null;
};

export type CobrancaInput = {
  valor: number;
  metodo: MetodoCobranca;
  descricao?: string;
  vencimento?: string | null;
  expira_em?: string | null;
  parcelas?: number;
  payer_email?: string | null;
  /** Token de cartão (gerado pelo SDK do provedor no front — PCI). */
  token?: string | null;
  referencia?: string;
};

export type CobrancaProviderResult = {
  provider_ref: string;
  status: 'pendente' | 'autorizada' | 'paga' | 'falhou';
  qr_code?: string | null;
  copia_cola?: string | null;
  linha_digitavel?: string | null;
  nosso_numero?: string | null;
  nsu?: string | null;
  expires_em?: string | null;
  bruto?: Record<string, unknown> | null;
};

export type WebhookParse = {
  evento_id: string;
  evento: string | null;
  provider_ref: string | null;
};

export type IntencaoWebhook = 'paga' | 'cancelada' | 'expirada' | 'estornada' | null;

export interface PaymentProvider {
  readonly id: string;
  readonly nome: string;
  readonly metodos: MetodoCobranca[];
  criaCobranca(ctx: GatewayContext, input: CobrancaInput): Promise<CobrancaProviderResult>;
  consultaCobranca(ctx: GatewayContext, providerRef: string): Promise<CobrancaProviderResult | null>;
  cancelaCobranca(ctx: GatewayContext, providerRef: string): Promise<{ status: string }>;
  estornaCobranca(ctx: GatewayContext, providerRef: string, valor?: number): Promise<{ status: string }>;
  /** Identifica o evento no corpo cru. NÃO valida assinatura. */
  parseWebhook(corpo: string): WebhookParse | null;
  /** Assinatura válida OU segredo não configurado (validação opcional, P2 §8). */
  verificaAssinatura(ctx: GatewayContext, corpo: string, headers: Record<string, string | undefined>): boolean;
  /** Resolve o estado final do evento (provedores que só mandam referência). */
  resolveWebhook?(ctx: GatewayContext, parsed: WebhookParse, payload: Record<string, unknown>): Promise<IntencaoWebhook>;
}

// ----------------------------------------------------------------------------
// Registry
// ----------------------------------------------------------------------------

const registry = new Map<string, PaymentProvider>();

export function registrarProvider(p: PaymentProvider): void {
  registry.set(p.id.toLowerCase(), p);
}

export function getProvider(id: string): PaymentProvider | null {
  return registry.get(String(id || '').toLowerCase()) || null;
}

export function listarProviders(): PaymentProvider[] {
  return [...registry.values()];
}

function hmacHex(segredo: string, dados: string): string {
  return createHmac('sha256', segredo).update(dados, 'utf8').digest('hex');
}

function compararConstante(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

// ----------------------------------------------------------------------------
// Provedor MOCK — determinístico, apenas fora de produção (P2 §9: "Mocks
// somente em testes"). Simula o ciclo PIX/boleto: cria pendente e o teste
// confirma via webhook, como um gateway real faria.
// ----------------------------------------------------------------------------

const mockEstado = new Map<string, string>(); // provider_ref → status simulado

export const mockProvider: PaymentProvider = {
  id: 'mock',
  nome: 'Gateway de teste (mock)',
  metodos: ['pix', 'boleto', 'cartao_credito', 'cartao_debito'],
  async criaCobranca(ctx: GatewayContext, input: CobrancaInput): Promise<CobrancaProviderResult> {
    exigirForaDeProducao();
    const ref = `mock-${randomBytes(6).toString('hex')}`;
    mockEstado.set(ref, 'pendente');
    const base: CobrancaProviderResult = { provider_ref: ref, status: 'pendente', expires_em: input.expira_em ?? null, bruto: { simulado: true, empresa: ctx.empresaId } };
    if (input.metodo === 'pix') return { ...base, qr_code: `MOCK-PIX-QR-${ref}`, copia_cola: `000201MOCK${ref}6304` };
    if (input.metodo === 'boleto') return { ...base, linha_digitavel: `23790.00000 00000.000000 00000.000000 1 99990000${Math.trunc(input.valor).toFixed(2).replace(/\D/g, '').slice(0, 8)}`, nosso_numero: ref.replace('mock-', '') };
    return { ...base, status: 'autorizada', nsu: `NSU${ref.slice(-8)}` };
  },
  async consultaCobranca(_ctx: GatewayContext, providerRef: string): Promise<CobrancaProviderResult | null> {
    exigirForaDeProducao();
    const status = mockEstado.get(providerRef);
    if (!status) return null;
    return { provider_ref: providerRef, status: status === 'paga' ? 'paga' : status === 'cancelada' ? 'pendente' : 'pendente' };
  },
  async cancelaCobranca(_ctx: GatewayContext, providerRef: string): Promise<{ status: string }> {
    exigirForaDeProducao();
    mockEstado.set(providerRef, 'cancelada');
    return { status: 'cancelada' };
  },
  async estornaCobranca(_ctx: GatewayContext, providerRef: string): Promise<{ status: string }> {
    exigirForaDeProducao();
    mockEstado.set(providerRef, 'estornada');
    return { status: 'estornada' };
  },
  parseWebhook(corpo: string): WebhookParse | null {
    try {
      const body = JSON.parse(corpo) as Record<string, unknown>;
      const data = (body.data && typeof body.data === 'object' ? (body.data as Record<string, unknown>) : body) || {};
      const ref = String(data.id || data.ref || body.resource_id || '');
      if (!ref) return null;
      const evento = String(body.event || body.type || 'mock.event');
      const hash = createHash('sha256').update(corpo).digest('hex').slice(0, 24);
      return { evento_id: String(body.event_id || body.request_id || `${evento}:${ref}:${hash}`), evento, provider_ref: ref };
    } catch {
      return null;
    }
  },
  verificaAssinatura(ctx: GatewayContext, corpo: string, headers: Record<string, string | undefined>): boolean {
    const segredo = ctx.webhookSegredo;
    if (!segredo) return true; // sem segredo configurado: validação opcional
    const recebido = String(headers['x-mock-signature'] || '');
    if (!recebido) return false;
    return compararConstante(recebido, hmacHex(segredo, corpo));
  },
  async resolveWebhook(_ctx: GatewayContext, _parsed: WebhookParse, payload: Record<string, unknown>): Promise<IntencaoWebhook> {
    const status = String(payload.status || payload.result || '').toLowerCase();
    const evento = String(payload.event || payload.type || '').toLowerCase();
    if (['pago', 'paga', 'paid', 'approved'].includes(status) || evento.includes('paid') || evento.includes('approved')) return 'paga';
    if (['cancelado', 'cancelled', 'rejected'].includes(status) || evento.includes('cancel')) return 'cancelada';
    if (['estornado', 'refunded'].includes(status) || evento.includes('refund')) return 'estornada';
    if (['expirado', 'expired'].includes(status) || evento.includes('expire')) return 'expirada';
    return null;
  },
};

function exigirForaDeProducao(): void {
  if (process.env.NODE_ENV === 'production') {
    throw new HttpError(409, 'O gateway de teste (mock) não pode operar em produção.');
  }
}

// ----------------------------------------------------------------------------
// Provedor MERCADO PAGO — escrito contra a API pública oficial.
// Sem credencial configurada responde 503 — nunca inventa resposta.
// ----------------------------------------------------------------------------

const MP_API_BASE = () => process.env.GATEWAY_MP_API_BASE_URL?.trim() || 'https://api.mercadopago.com';

function mpToken(ctx: GatewayContext): string {
  const token = ctx.credenciais?.access_token || ctx.credenciais?.accessToken || '';
  if (!token) throw new HttpError(503, 'Gateway Mercado Pago não configurado. Cadastre o Access Token em Financeiro → Gateway.');
  return String(token);
}

async function mpFetch(caminho: string, init: RequestInit, ctx: GatewayContext): Promise<Record<string, unknown>> {
  let res: globalThis.Response;
  try {
    res = await fetch(new URL(caminho, MP_API_BASE()), {
      ...init,
      headers: { accept: 'application/json', 'content-type': 'application/json', authorization: `Bearer ${mpToken(ctx)}`, ...(init.headers || {}) },
      cache: 'no-store',
    });
  } catch {
    throw new HttpError(503, 'Falha de rede ao contatar o Mercado Pago.');
  }
  const payload = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const msg = (payload as { message?: string }).message || `HTTP ${res.status}`;
    throw new HttpError(res.status >= 500 ? 502 : 400, `Mercado Pago recusou: ${msg}`);
  }
  return payload;
}

function mpMapeiaStatus(status: string): CobrancaProviderResult['status'] {
  switch (status) {
    case 'approved':
      return 'paga';
    case 'authorized':
      return 'autorizada';
    case 'rejected':
      return 'falhou';
    default:
      return 'pendente';
  }
}

function mpExtraiInstrumento(p: Record<string, unknown>, metodo: MetodoCobranca): Partial<CobrancaProviderResult> {
  if (metodo === 'pix') {
    const poi = (p.point_of_interaction || {}) as Record<string, unknown>;
    const td = (poi.transaction_data || {}) as Record<string, unknown>;
    return { qr_code: (td.qr_code_base64 as string) || null, copia_cola: (td.qr_code as string) || null };
  }
  if (metodo === 'boleto') {
    const td = (p.transaction_details || {}) as Record<string, unknown>;
    return { linha_digitavel: (td.digitable_line as string) || null, nosso_numero: (p.statement_descriptor as string) || null };
  }
  const td = (p.transaction_details || {}) as Record<string, unknown>;
  return { nsu: (td.payment_method_reference_id as string) || null };
}

export const mercadopagoProvider: PaymentProvider = {
  id: 'mercadopago',
  nome: 'Mercado Pago',
  metodos: ['pix', 'boleto', 'cartao_credito', 'cartao_debito'],
  async criaCobranca(ctx: GatewayContext, input: CobrancaInput): Promise<CobrancaProviderResult> {
    const body: Record<string, unknown> = {
      transaction_amount: round2(input.valor),
      description: input.descricao || 'Cobrança BROBOND ERP',
      external_reference: input.referencia || null,
    };
    if (input.metodo === 'pix') {
      if (!input.payer_email) throw new HttpError(400, 'Cobrança PIX exige o e-mail do pagador (payer_email).', { payer_email: 'Obrigatório' });
      body.payment_method_id = 'pix';
      body.payer = { email: input.payer_email };
      if (input.expira_em) body.date_of_expiration = input.expira_em;
    } else if (input.metodo === 'boleto') {
      if (!input.payer_email) throw new HttpError(400, 'Cobrança boleto exige o e-mail do pagador (payer_email).', { payer_email: 'Obrigatório' });
      body.payment_method_id = 'bolbradesco';
      body.payer = { email: input.payer_email };
      if (input.vencimento) body.date_of_expiration = `${input.vencimento}T23:59:59.000-03:00`;
    } else {
      if (!input.token) {
        throw new HttpError(503, 'Pagamento com cartão exige token gerado pelo SDK do Mercado Pago (PCI). O ERP não captura dados de cartão.');
      }
      body.token = input.token;
      body.installments = Math.max(1, Math.trunc(input.parcelas || 1));
      body.capture = true; // autorização + captura
    }
    const p = await mpFetch('/v1/payments', { method: 'POST', body: JSON.stringify(body) }, ctx);
    return {
      provider_ref: String(p.id),
      status: mpMapeiaStatus(String(p.status || 'pending')),
      expires_em: (p.date_of_expiration as string) || null,
      nsu: mpExtraiInstrumento(p, input.metodo).nsu ?? null,
      qr_code: mpExtraiInstrumento(p, input.metodo).qr_code ?? null,
      copia_cola: mpExtraiInstrumento(p, input.metodo).copia_cola ?? null,
      linha_digitavel: mpExtraiInstrumento(p, input.metodo).linha_digitavel ?? null,
      bruto: p,
    };
  },
  async consultaCobranca(ctx: GatewayContext, providerRef: string): Promise<CobrancaProviderResult | null> {
    const p = await mpFetch(`/v1/payments/${encodeURIComponent(providerRef)}`, { method: 'GET' }, ctx);
    return { provider_ref: String(p.id || providerRef), status: mpMapeiaStatus(String(p.status || '')), bruto: p };
  },
  async cancelaCobranca(ctx: GatewayContext, providerRef: string): Promise<{ status: string }> {
    await mpFetch(`/v1/payments/${encodeURIComponent(providerRef)}`, { method: 'PUT', body: JSON.stringify({ status: 'cancelled' }) }, ctx);
    return { status: 'cancelada' };
  },
  async estornaCobranca(ctx: GatewayContext, providerRef: string, valor?: number): Promise<{ status: string }> {
    const body = valor && valor > 0 ? { amount: round2(valor) } : {};
    await mpFetch(`/v1/payments/${encodeURIComponent(providerRef)}/refunds`, { method: 'POST', body: JSON.stringify(body) }, ctx);
    return { status: 'estornada' };
  },
  parseWebhook(corpo: string): WebhookParse | null {
    try {
      const body = JSON.parse(corpo) as Record<string, unknown>;
      const tipo = String(body.type || body.topic || '');
      const data = (body.data && typeof body.data === 'object' ? (body.data as Record<string, unknown>) : {}) as Record<string, unknown>;
      const ref = String(data.id || body.id || '');
      if (!ref || !/^payment/i.test(tipo)) return null;
      return { evento_id: String(body['x-request-id'] || body.request_id || `${tipo}:${ref}`), evento: tipo, provider_ref: ref };
    } catch {
      return null;
    }
  },
  verificaAssinatura(ctx: GatewayContext, corpo: string, headers: Record<string, string | undefined>): boolean {
    const segredo = ctx.webhookSegredo;
    if (!segredo) return true;
    const assinatura = String(headers['x-signature'] || '');
    const m = assinatura.match(/ts=([^,]+),\s*v1=([a-f0-9]+)/i);
    if (!m) return false;
    const [, ts, v1] = m;
    let id = '';
    try {
      const body = JSON.parse(corpo) as Record<string, unknown>;
      const data = (body.data || {}) as Record<string, unknown>;
      id = String((data as Record<string, unknown>).id || '');
    } catch {
      return false;
    }
    const reqId = String(headers['x-request-id'] || '');
    const manifest = `id:${id.toLowerCase()};request-id:${reqId.toLowerCase()};ts:${ts}`;
    return compararConstante(v1.toLowerCase(), hmacHex(segredo, manifest));
  },
  async resolveWebhook(ctx: GatewayContext, parsed: WebhookParse): Promise<IntencaoWebhook> {
    // O Mercado Pago manda só a referência: o estado real vem da consulta.
    const atual = await this.consultaCobranca(ctx, parsed.provider_ref!);
    if (!atual) return null;
    const st = String(atual.bruto?.status || '');
    if (st === 'approved') return 'paga';
    if (st === 'cancelled' || st === 'rejected') return 'cancelada';
    if (st === 'refunded' || st === 'charged_back') return 'estornada';
    return null;
  },
};

registrarProvider(mockProvider);
registrarProvider(mercadopagoProvider);

// ----------------------------------------------------------------------------
// Configuração por empresa
// ----------------------------------------------------------------------------

async function configDaEmpresa(empresaId: number, provider: string, tx?: Tx): Promise<Row | null> {
  const s = getStore();
  return s.findOneWhere(R_GATEWAY_CONFIGS, { empresa_id: empresaId, provider: String(provider || '').toLowerCase() }, tx);
}

async function contextoDoProvider(empresaId: number, provider: string): Promise<GatewayContext> {
  const config = await configDaEmpresa(empresaId, provider);
  if (!config || config.ativo === false) {
    throw new HttpError(503, `Gateway "${provider}" não configurado para esta empresa. Configure em Financeiro → Gateway antes de criar cobranças.`);
  }
  let credenciais: Record<string, string> | null = null;
  const bruto = decifrarSegredo(config.credenciais_cifradas as string | null);
  if (bruto) {
    try {
      credenciais = JSON.parse(bruto) as Record<string, string>;
    } catch {
      credenciais = null;
    }
  }
  return { empresaId, config, credenciais, webhookSegredo: decifrarSegredo(config.webhook_segredo_cifrado as string | null) };
}

/** GET /api/financeiro/gateway/providers — adapters + situação da config. */
export async function listarGateways(req: Request, res: Response) {
  const actor = currentUser(req);
  checkAccess(getResourceLancamentos(), actor, 'read');
  const escopo = escopoDoAtor(actor as unknown as AuthUser);
  const s = getStore();
  const configs = await s.list(R_GATEWAY_CONFIGS, { page: 1, pageSize: 100, filter: aplicarFiltroEmpresa(R_GATEWAY_CONFIGS, undefined, escopo) });
  res.json({
    providers: listarProviders().map((p) => ({
      id: p.id,
      nome: p.nome,
      metodos: p.metodos,
      disponivel_em_producao: p.id !== 'mock',
    })),
    configs: configs.rows.map((c) => ({
      id: Number(c.id),
      provider: c.provider,
      ambiente: c.ambiente,
      ativo: c.ativo !== false,
      tem_credenciais: !!c.credenciais_cifradas,
      tem_segredo_webhook: !!c.webhook_segredo_cifrado,
    })),
  });
}

/** PUT /api/financeiro/gateway/config — cria/atualiza (admin, reautenticação). */
export async function configurarGateway(req: Request, res: Response) {
  const actor = currentUser(req);
  if (actor.perfil !== 'admin') throw new HttpError(403, 'Apenas administradores configuram gateways.');
  exigirReautenticacao(req);
  const escopo = escopoDoAtor(actor as unknown as AuthUser);
  const body = (req.body || {}) as Record<string, unknown>;
  const provider = String(body.provider || '').toLowerCase().trim();
  if (!getProvider(provider)) throw new HttpError(400, `Provedor desconhecido: "${provider}".`);
  if (provider === 'mock' && process.env.NODE_ENV === 'production') throw new HttpError(409, 'O gateway mock não pode ser configurado em produção.');
  const ambiente = ['producao', 'homologacao', 'teste'].includes(String(body.ambiente)) ? String(body.ambiente) : 'producao';
  const s = getStore();

  const patch: Record<string, unknown> = { ambiente, atualizado_em: new Date().toISOString() };
  if (body.credenciais !== undefined && body.credenciais !== null) {
    if (typeof body.credenciais !== 'object') throw new HttpError(400, 'credenciais deve ser um objeto (ex.: {access_token: "..."}).');
    patch.credenciais_cifradas = cifrarSegredo(JSON.stringify(body.credenciais));
  }
  if (body.webhook_secret !== undefined && body.webhook_secret !== null && body.webhook_secret !== '') {
    patch.webhook_segredo_cifrado = cifrarSegredo(String(body.webhook_secret));
  } else if (body.webhook_secret === null) {
    patch.webhook_segredo_cifrado = null;
  }
  if (body.credenciais === null) {
    patch.credenciais_cifradas = null;
  }
  if (body.ativo !== undefined) patch.ativo = body.ativo !== false;

  const existente = await configDaEmpresa(escopo.empresaId, provider);
  let row: Row;
  if (existente) {
    row = (await s.update(R_GATEWAY_CONFIGS, Number(existente.id), patch))!;
  } else {
    row = await s.insert(R_GATEWAY_CONFIGS, { empresa_id: escopo.empresaId, provider, ativo: true, ...patch });
  }
  await s.audit({
    usuario_id: actor.id || null,
    usuario: actor.name,
    acao: 'seguranca',
    recurso: 'gateway_configs',
    registro_id: Number(row.id),
    descricao: `Configuração de gateway "${provider}" salva por ${actor.name} (ambiente ${ambiente}${body.credenciais ? '; credenciais atualizadas' : ''}${body.webhook_secret ? '; segredo de webhook atualizado' : ''})`,
    dados: { provider, ambiente },
  });
  res.json({ ok: true, provider, ambiente, ativo: row.ativo !== false, tem_credenciais: !!row.credenciais_cifradas, tem_segredo_webhook: !!row.webhook_segredo_cifrado });
}

// ----------------------------------------------------------------------------
// Cobranças — criação idempotente, cancelamento e estorno
// ----------------------------------------------------------------------------

function metodoValido(m: unknown): MetodoCobranca {
  const metodo = String(m || '').toLowerCase();
  if (!METODOS_SUPORTADOS.includes(metodo as MetodoCobranca)) {
    throw new HttpError(400, `Método inválido: "${metodo}". Use ${METODOS_SUPORTADOS.join(', ')}.`, { metodo: 'Inválido' });
  }
  return metodo as MetodoCobranca;
}

/** POST /api/financeiro/gateway/cobrancas — cria uma cobrança via gateway. */
export async function criarCobranca(req: Request, res: Response) {
  const actor = currentUser(req);
  checkAccess(getResourceLancamentos(), actor, 'create');
  const escopo = escopoDoAtor(actor as unknown as AuthUser);
  const body = (req.body || {}) as Record<string, unknown>;
  const providerId = String(body.provider || '').toLowerCase();
  const metodo = metodoValido(body.metodo);
  const s = getStore();

  // Vínculos opcionais validados no escopo (evita cobrar título alheio).
  let lancamento: Row | null = null;
  if (body.lancamento_id) {
    lancamento = assertRegistroDaEmpresa(getResourceLancamentos(), await s.get(getResourceLancamentos(), Number(body.lancamento_id)), escopo);
    if (!['pendente'].includes(String(lancamento.status))) throw new HttpError(409, 'Só se cria cobrança para lançamento pendente.');
  }
  let venda: Row | null = null;
  if (body.venda_id) {
    venda = assertRegistroDaEmpresa(getResource('vendas')!, await s.get(getResource('vendas')!, Number(body.venda_id)), escopo);
  }
  const contaId: number | null = body.conta_id ? Number(body.conta_id) : lancamento?.conta_id ? Number(lancamento.conta_id) : null;
  if (body.conta_id) {
    assertRegistroDaEmpresa(getResource('contas_financeiras')!, await s.get(getResource('contas_financeiras')!, Number(body.conta_id)), escopo);
  }

  const valor = round2(lancamento ? Number(lancamento.valor || 0) : Number(body.valor || 0));
  if (!(valor > 0)) throw new HttpError(400, 'Informe um valor maior que zero (ou vincule um lançamento).', { valor: 'Inválido' });
  const taxaPct = Math.min(99.99, Math.max(0, Number(body.taxa_pct || 0)));
  const parcelas = metodo === 'cartao_credito' ? Math.max(1, Math.trunc(Number(body.parcelas || 1))) : 1;
  const idempotencyKey = body.idempotency_key
    ? String(body.idempotency_key).slice(0, 120)
    : lancamento
      ? `lanc-${lancamento.id}`
      : venda
        ? `venda-${venda.id}-${metodo}`
        : `avulsa-${createHash('sha1').update(JSON.stringify(body)).digest('hex').slice(0, 20)}`;

  const existente = await s.findOneWhere(R_GATEWAY_COBRANCAS, { empresa_id: escopo.empresaId, provider: providerId, idempotency_key: idempotencyKey });
  if (existente && String(existente.status) !== 'falhou') {
    return res.json({ ok: true, idempotente: true, cobranca: publicaCobranca(existente) });
  }

  const ctx = await contextoDoProvider(escopo.empresaId, providerId);
  const provider = getProvider(providerId)!;
  const input: CobrancaInput = {
    valor,
    metodo,
    descricao: body.descricao ? String(body.descricao).slice(0, 200) : lancamento ? String(lancamento.descricao) : venda ? `Venda #${venda.id}` : 'Cobrança',
    vencimento: body.vencimento ? String(body.vencimento).slice(0, 10) : lancamento?.vencimento ? String(lancamento.vencimento).slice(0, 10) : null,
    expira_em: body.expira_em ? String(body.expira_em) : null,
    parcelas,
    payer_email: body.payer_email ? String(body.payer_email) : null,
    token: body.token ? String(body.token) : null,
    referencia: idempotencyKey,
  };

  let resultado: CobrancaProviderResult;
  try {
    resultado = await provider.criaCobranca(ctx, input);
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(502, `O gateway "${providerId}" falhou ao criar a cobrança.`);
  }

  const dados: Row = {
    empresa_id: escopo.empresaId,
    provider: providerId,
    metodo,
    venda_id: venda ? Number(venda.id) : lancamento?.referencia_tipo === 'venda' ? Number(lancamento.referencia_id) : null,
    lancamento_id: lancamento ? Number(lancamento.id) : null,
    conta_id: contaId,
    valor,
    taxa_pct: taxaPct,
    valor_liquido: calcularLiquido(valor, taxaPct),
    parcelas,
    status: resultado.status,
    provider_ref: resultado.provider_ref,
    idempotency_key: idempotencyKey,
    expires_em: resultado.expires_em ?? null,
    nosso_numero: resultado.nosso_numero ?? null,
    linha_digitavel: resultado.linha_digitavel ?? null,
    qr_code: resultado.qr_code ?? null,
    copia_cola: resultado.copia_cola ?? null,
    nsu: resultado.nsu ?? null,
    payload: resultado.bruto ?? null,
    observacoes: body.observacoes ? String(body.observacoes).slice(0, 500) : null,
  };

  let row: Row;
  if (existente) {
    row = (await s.update(R_GATEWAY_COBRANCAS, Number(existente.id), { ...dados, atualizado_em: new Date().toISOString() }))!;
  } else {
    row = await s.insert(R_GATEWAY_COBRANCAS, dados);
  }
  await s.audit({
    usuario_id: actor.id || null,
    usuario: actor.name,
    acao: 'criar',
    recurso: 'gateway_cobrancas',
    registro_id: Number(row.id),
    descricao: `Cobrança ${metodo} de ${valor.toFixed(2)} criada via ${providerId} (${resultado.provider_ref})`,
    dados: { provider: providerId, metodo, valor, idempotency_key: idempotencyKey, lancamento_id: dados.lancamento_id, venda_id: dados.venda_id },
  });
  res.status(201).json({ ok: true, cobranca: publicaCobranca(row) });
}

/** GET /api/financeiro/gateway/cobrancas — lista do escopo. */
export async function listarCobrancas(req: Request, res: Response) {
  const actor = currentUser(req);
  checkAccess(getResourceLancamentos(), actor, 'read');
  const escopo = escopoDoAtor(actor as unknown as AuthUser);
  const s = getStore();
  const filtro: Record<string, unknown> = {};
  if (req.query.status) filtro.status = String(req.query.status);
  if (req.query.venda_id) filtro.venda_id = Number(req.query.venda_id);
  if (req.query.provider) filtro.provider = String(req.query.provider);
  const out = await s.list(R_GATEWAY_COBRANCAS, { page: Math.max(1, Number(req.query.page) || 1), pageSize: Math.min(200, Number(req.query.pageSize) || 50), filter: aplicarFiltroEmpresa(R_GATEWAY_COBRANCAS, filtro, escopo) });
  res.json({ total: out.total, cobrancas: out.rows.map(publicaCobranca) });
}

/** GET /api/financeiro/gateway/cobrancas/:id — detalhe (+ consulta no provedor). */
export async function detalheCobranca(req: Request, res: Response) {
  const actor = currentUser(req);
  checkAccess(getResourceLancamentos(), actor, 'read');
  const escopo = escopoDoAtor(actor as unknown as AuthUser);
  const s = getStore();
  const row = assertRegistroDaEmpresa(R_GATEWAY_COBRANCAS, await s.get(R_GATEWAY_COBRANCAS, Number(req.params.id)), escopo);
  res.json({ ok: true, cobranca: publicaCobranca(row) });
}

/** POST /api/financeiro/gateway/cobrancas/:id/cancelar */
export async function cancelarCobranca(req: Request, res: Response) {
  const actor = currentUser(req);
  checkAccess(getResourceLancamentos(), actor, 'update');
  const escopo = escopoDoAtor(actor as unknown as AuthUser);
  const s = getStore();
  const row = assertRegistroDaEmpresa(R_GATEWAY_COBRANCAS, await s.get(R_GATEWAY_COBRANCAS, Number(req.params.id)), escopo);
  if (!['pendente', 'autorizada'].includes(String(row.status))) {
    throw new HttpError(409, `Cobrança "${row.status}" não pode ser cancelada (só pendente/autorizada).`);
  }
  const ctx = await contextoDoProvider(escopo.empresaId, String(row.provider));
  const provider = getProvider(String(row.provider))!;
  await provider.cancelaCobranca(ctx, String(row.provider_ref));
  const atualizada = (await s.update(R_GATEWAY_COBRANCAS, Number(row.id), { status: 'cancelada', atualizado_em: new Date().toISOString() }))!;
  await s.audit({
    usuario_id: actor.id || null,
    usuario: actor.name,
    acao: 'editar',
    recurso: 'gateway_cobrancas',
    registro_id: Number(row.id),
    descricao: `Cobrança #${row.id} cancelada no ${row.provider} (${row.provider_ref})`,
    dados: { status: 'cancelada' },
  });
  res.json({ ok: true, cobranca: publicaCobranca(atualizada) });
}

/** POST /api/financeiro/gateway/cobrancas/:id/estornar — devolve dinheiro. */
export async function estornarCobranca(req: Request, res: Response) {
  const actor = currentUser(req);
  checkAccess(getResourceLancamentos(), actor, 'update');
  const escopo = escopoDoAtor(actor as unknown as AuthUser);
  const s = getStore();
  const row = assertRegistroDaEmpresa(R_GATEWAY_COBRANCAS, await s.get(R_GATEWAY_COBRANCAS, Number(req.params.id)), escopo);
  if (String(row.status) !== 'paga') throw new HttpError(409, 'Só se estorna cobrança paga.');
  const ctx = await contextoDoProvider(escopo.empresaId, String(row.provider));
  const provider = getProvider(String(row.provider))!;
  const valor = req.body?.valor ? Number(req.body.valor) : undefined;
  if (valor !== undefined && (!Number.isFinite(valor) || valor <= 0 || valor > Number(row.valor) + 0.009)) {
    throw new HttpError(400, 'Valor de estorno inválido (deve estar entre 0 e o valor da cobrança).', { valor: 'Inválido' });
  }
  await provider.estornaCobranca(ctx, String(row.provider_ref), valor);

  const resultado = await s.transaction(async (tx) => {
    const atualizada = await s.tryUpdateIf(R_GATEWAY_COBRANCAS, Number(row.id), { status: 'paga' }, { status: 'estornada', atualizado_em: new Date().toISOString() }, tx);
    if (!atualizada) throw new HttpError(409, 'A cobrança mudou durante o estorno.');
    const estornoLancamentoId = await reverterFinanceiroDaCobranca(row, round2(valor ?? Number(row.valor)), { id: actor.id || null, name: actor.name }, tx);
    await s.audit({
      usuario_id: actor.id || null,
      usuario: actor.name,
      acao: 'editar',
      recurso: 'gateway_cobrancas',
      registro_id: Number(row.id),
      descricao: `Cobrança #${row.id} ESTORNADA no ${row.provider} (${row.provider_ref})${valor ? ` — valor parcial ${round2(valor).toFixed(2)}` : ''}`,
      dados: { status: 'estornada', valor: valor ?? Number(row.valor), estorno_lancamento_id: estornoLancamentoId },
    }, tx);
    return { atualizada, estornoLancamentoId };
  });
  res.json({ ok: true, cobranca: publicaCobranca(resultado.atualizada), estorno_lancamento_id: resultado.estornoLancamentoId });
}

/**
 * Reversão financeira de um estorno/devolução de cobrança: o dinheiro que
 * voltou vira lançamento de estorno (o caixa volta a bater) e a comissão
 * efetivada sobre esse dinheiro é estornada. Idempotente por estado do
 * lançamento (só reverte o que está confirmado).
 */
async function reverterFinanceiroDaCobranca(
  cobranca: Row,
  valor: number,
  actor: { id: number | null; name: string },
  tx: Tx
): Promise<number | null> {
  const s = getStore();
  let estornoId: number | null = null;
  const lancId = Number(cobranca.lancamento_id || 0);
  if (lancId) {
    const lanc = await s.get(getResourceLancamentos(), lancId, tx);
    if (lanc && String(lanc.status) === 'confirmado') {
      const tipoEstorno = String(lanc.tipo) === 'receita' ? 'despesa' : 'receita';
      const estorno = await s.insert(
        getResourceLancamentos(),
        {
          empresa_id: lanc.empresa_id ?? cobranca.empresa_id,
          data: new Date().toISOString().slice(0, 10),
          tipo: tipoEstorno,
          categoria_id: lanc.categoria_id ?? null,
          conta_id: cobranca.conta_id ?? lanc.conta_id ?? null,
          descricao: `Estorno (${cobranca.provider}) — ${String(lanc.descricao)}`,
          valor: round2(valor),
          taxa_pct: 0,
          valor_liquido: round2(valor),
          forma_pagamento: lanc.forma_pagamento ?? null,
          status: 'confirmado',
          referencia_tipo: 'estorno',
          referencia_id: lancId,
          observacoes: `Estorno da cobrança #${cobranca.id} (${cobranca.provider_ref})`,
        },
        tx
      );
      estornoId = Number(estorno.id);
      await s.audit({
        usuario_id: actor.id || null,
        usuario: actor.name,
        acao: 'criar',
        recurso: 'lancamentos_financeiros',
        registro_id: estornoId,
        descricao: `Lançamento de estorno — cobrança #${cobranca.id} (${cobranca.provider})`,
        dados: { valor, lancamento_origem: lancId },
      }, tx);
    }
  }
  // Comissão: o dinheiro devolvido deixa de justificar comissão efetivada.
  if (cobranca.venda_id) {
    const venda = await s.get(getResource('vendas')!, Number(cobranca.venda_id), tx);
    if (venda) {
      await registrarEstornoComissao(venda, valor, 'estorno_gateway', `Estorno da cobrança #${cobranca.id} (${cobranca.provider})`, actor, tx);
    }
  }
  return estornoId;
}

/** Forma pública da cobrança (payload bruto do provedor sai — pode ter dado sensível). */
function publicaCobranca(row: Row): Record<string, unknown> {
  const { payload, ...resto } = row;
  void payload;
  return {
    ...resto,
    bruto_disponivel: payload != null,
  };
}

// ----------------------------------------------------------------------------
// WEBHOOKS DE ENTRADA — persistir, validar, processar, retry
// ----------------------------------------------------------------------------

/**
 * Recebe webhook público (montado ANTES do express.json, com corpo cru —
 * a assinatura é calculada sobre os bytes originais).
 */
export const publicGatewayRouter: Router = express.Router();
const rawBody = express.raw({ type: '*/*', limit: '1mb' });

publicGatewayRouter.post('/api/gateway/webhooks/:provider', rawBody, async (req: Request, res: Response) => {
  try {
    const providerId = String(req.params.provider || '').toLowerCase();
    const provider = getProvider(providerId);
    const corpo = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : String(req.body || '');
    if (!provider) return res.status(404).json({ error: 'Provedor desconhecido.' });
    if (!corpo.trim()) return res.status(400).json({ error: 'Corpo vazio.' });

    const parsed = provider.parseWebhook(corpo);
    if (!parsed) return res.status(202).json({ ok: true, ignorado: true, motivo: 'Evento fora do escopo de pagamento.' });

    const s = getStore();
    // IDEMPOTÊNCIA: a mesma notificação (provedor × evento_id) entra UMA vez.
    // Atenção: notificações REJEITADAS por assinatura (status 'ignorado') NÃO
    // contam — senão um evento forjado travaria o retry legítimo do provedor.
    const anteriores = await s.list(R_GATEWAY_WEBHOOK_EVENTS, { page: 1, pageSize: 10, filter: { provider: providerId, evento_id: parsed.evento_id } });
    const aceito = anteriores.rows.find((r) => String(r.status) !== 'ignorado');
    if (aceito) return res.json({ ok: true, duplicado: true, evento_id: parsed.evento_id });
    const jaRejeitado = anteriores.rows[0] ?? null;

    // Assinatura: validada quando há segredo em alguma config do provedor.
    let assinaturaOk = false;
    let empresaId: number | null = null;
    const configs = await s.list(R_GATEWAY_CONFIGS, { page: 1, pageSize: 50, filter: { provider: providerId } });
    const headers = req.headers as Record<string, string | undefined>;
    let temSegredo = false;
    for (const c of configs.rows) {
      const segredo = decifrarSegredo(c.webhook_segredo_cifrado as string | null);
      if (!segredo) continue;
      temSegredo = true;
      const ctxLocal: GatewayContext = { empresaId: Number(c.empresa_id), config: c, credenciais: null, webhookSegredo: segredo };
      if (provider.verificaAssinatura(ctxLocal, corpo, headers)) {
        assinaturaOk = true;
        empresaId = Number(c.empresa_id);
        break;
      }
    }
    if (temSegredo && !assinaturaOk) {
      // Registro forense + rejeição: assinatura inválida não processa nada.
      // Repetição de rejeição só atualiza o carimbo — não empilha linhas.
      const evento = jaRejeitado
        ? await s.update(R_GATEWAY_WEBHOOK_EVENTS, Number(jaRejeitado.id), { recebido_em: new Date().toISOString(), payload: corpo.slice(0, 20000) })
        : await s.insert(R_GATEWAY_WEBHOOK_EVENTS, {
            provider: providerId,
            evento_id: parsed.evento_id,
            evento: parsed.evento,
            payload: corpo.slice(0, 20000),
            assinatura_ok: false,
            status: 'ignorado',
            erro: 'Assinatura inválida.',
            recebido_em: new Date().toISOString(),
          });
      const registroId = jaRejeitado ? Number(jaRejeitado.id) : Number((evento as Row).id);
      await s.audit({ usuario_id: null, usuario: 'webhook', acao: 'seguranca', recurso: 'gateway_webhook_events', registro_id: registroId, descricao: `Webhook ${providerId} rejeitado: assinatura inválida (evento ${parsed.evento_id})`, dados: { provider: providerId, evento_id: parsed.evento_id } });
      return res.status(401).json({ error: 'Assinatura inválida.' });
    }

    // Persistência ANTES do processamento: mesmo que o processamento falhe,
    // o evento está gravado e entra no retry — sem duplicar (índice único).
    const evento = await s.insert(R_GATEWAY_WEBHOOK_EVENTS, {
      empresa_id: empresaId,
      provider: providerId,
      evento_id: parsed.evento_id,
      evento: parsed.evento,
      payload: corpo.slice(0, 20000),
      assinatura_ok: assinaturaOk,
      status: 'recebido',
      tentativas: 0,
      recebido_em: new Date().toISOString(),
    });

    // ACK imediato ao provedor; processamento a seguir. Se falhar, o evento
    // fica com status 'erro' e o retry (cron/manual) tenta de novo.
    try {
      await processarEvento(evento);
      return res.json({ ok: true, evento_id: parsed.evento_id, processado: true });
    } catch (e: any) {
      return res.json({ ok: true, evento_id: parsed.evento_id, processado: false, erro: String(e?.message || e).slice(0, 200) });
    }
  } catch (e: any) {
    // Nunca derruba o ack com 500 por erro interno não mapeado.
    return res.status(202).json({ ok: false, erro: String(e?.message || e).slice(0, 200) });
  }
});

/** Processa um evento persistido. Idempotente em todas as etapas. */
export async function processarEvento(evento: Row): Promise<{ resultado: string }> {
  const s = getStore();
  const providerId = String(evento.provider);
  const provider = getProvider(providerId);
  const marcarErro = async (erro: string, tentativas: number) => {
    const proxima = new Date(Date.now() + Math.min(60, 2 ** Math.min(tentativas, 6)) * 60_000).toISOString();
    await s.update(R_GATEWAY_WEBHOOK_EVENTS, Number(evento.id), { status: 'erro', erro: erro.slice(0, 500), tentativas, ultima_tentativa_em: new Date().toISOString(), proxima_tentativa_em: proxima });
  };

  if (!provider) {
    await s.update(R_GATEWAY_WEBHOOK_EVENTS, Number(evento.id), { status: 'ignorado', erro: 'Provedor não registrado.' });
    return { resultado: 'ignorado' };
  }

  let payload: Record<string, unknown> = {};
  try {
    payload = JSON.parse(String(evento.payload || '{}')) as Record<string, unknown>;
  } catch {
    payload = {};
  }
  const parsed: WebhookParse = { evento_id: String(evento.evento_id), evento: String(evento.evento || ''), provider_ref: extrairRefDoPayload(provider, payload) };

  const tentativas = Number(evento.tentativas || 0) + 1;
  try {
    // Contexto: empresa vem da cobrança (o webhook não carrega tenant).
    let cobranca: Row | null = null;
    if (parsed.provider_ref) {
      const achadas = await s.list(R_GATEWAY_COBRANCAS, { page: 1, pageSize: 5, filter: { provider: providerId, provider_ref: parsed.provider_ref } });
      cobranca = achadas.rows[0] ?? null;
    }
    if (!cobranca) {
      await s.update(R_GATEWAY_WEBHOOK_EVENTS, Number(evento.id), { status: 'ignorado', erro: 'Nenhuma cobrança deste provedor com essa referência.', tentativas, ultima_tentativa_em: new Date().toISOString() });
      return { resultado: 'ignorado' };
    }

    const ctx = await contextoDoProvider(Number(cobranca.empresa_id), providerId).catch(() => null);
    if (!ctx) {
      await marcarErro('Configuração do gateway ausente/inativa.', tentativas);
      return { resultado: 'erro' };
    }

    let intencao: IntencaoWebhook = null;
    if (provider.resolveWebhook) intencao = await provider.resolveWebhook(ctx, parsed, payload);
    if (!intencao) intencao = intencaoDoPayload(payload);
    if (!intencao) {
      await s.update(R_GATEWAY_WEBHOOK_EVENTS, Number(evento.id), { status: 'ignorado', erro: 'Evento sem efeito financeiro (status irrelevante).', tentativas, ultima_tentativa_em: new Date().toISOString(), cobranca_id: Number(cobranca.id) });
      return { resultado: 'ignorado' };
    }

    const efeito = await s.transaction(async (tx) => {
      return aplicarIntencao(providerId, cobranca!, intencao!, Number(evento.id), tx);
    }, { isolation: 'serializable' });

    await s.update(R_GATEWAY_WEBHOOK_EVENTS, Number(evento.id), {
      status: 'processado',
      empresa_id: Number(cobranca.empresa_id),
      cobranca_id: Number(cobranca.id),
      lancamento_id: efeito.lancamento_id,
      tentativas,
      ultima_tentativa_em: new Date().toISOString(),
      processado_em: new Date().toISOString(),
      erro: null,
    });
    return { resultado: intencao };
  } catch (e: any) {
    await marcarErro(String(e?.message || e), tentativas);
    throw e;
  }
}

function extrairRefDoPayload(provider: PaymentProvider, payload: Record<string, unknown>): string | null {
  const parsed = provider.parseWebhook(JSON.stringify(payload));
  return parsed?.provider_ref ?? null;
}

function intencaoDoPayload(payload: Record<string, unknown>): IntencaoWebhook {
  const status = String(payload.status || '').toLowerCase();
  if (['pago', 'paga', 'paid', 'approved'].includes(status)) return 'paga';
  if (['cancelado', 'cancelled', 'rejected'].includes(status)) return 'cancelada';
  if (['estornado', 'refunded', 'charged_back'].includes(status)) return 'estornada';
  if (['expirado', 'expired'].includes(status)) return 'expirada';
  return null;
}

/**
 * Aplica o efeito financeiro do evento — dentro de UMA transação, com guardas
 * de estado em cada passo. Reprocessar o mesmo evento não duplica nada:
 * cobrança só muda de estado válido, e baixa só acontece em título pendente.
 */
async function aplicarIntencao(providerId: string, cobranca: Row, intencao: IntencaoWebhook, eventoId: number, tx: Tx): Promise<{ lancamento_id: number | null }> {
  const s = getStore();
  const statusAtual = String(cobranca.status);
  const lancId = Number(cobranca.lancamento_id || 0);

  if (intencao === 'paga') {
    if (statusAtual === 'paga') return { lancamento_id: lancId || null }; // já aplicado
    if (!['pendente', 'autorizada'].includes(statusAtual)) {
      throw new HttpError(409, `Cobrança "${statusAtual}" não pode ser paga.`);
    }
    const paga = await s.tryUpdateIf(R_GATEWAY_COBRANCAS, Number(cobranca.id), { status: statusAtual }, { status: 'paga', webhook_evento_id: String(eventoId), atualizado_em: new Date().toISOString() }, tx);
    if (!paga) throw new HttpError(409, 'A cobrança mudou durante o processamento do webhook.');

    if (lancId) {
      const metodoForma = String(cobranca.metodo || '');
      // A baixa é condicional (título pendente): webhook duplicado/reprocessado
      // nunca gera segunda baixa — segunda tentativa encontra o título baixado.
      const lanc = await s.get(getResourceLancamentos(), lancId, tx);
      if (lanc && String(lanc.status) === 'pendente') {
        await efetuarBaixa(
          { id: null, name: `webhook:${providerId}` },
          lancId,
          {
            valor: Number(cobranca.valor),
            conta_id: cobranca.conta_id ?? lanc.conta_id ?? null,
            forma_pagamento: lanc.forma_pagamento ?? metodoForma,
            origem: 'webhook',
            nota: `Confirmado pelo webhook ${providerId} (evento ${eventoId}, ref ${cobranca.provider_ref})`,
          },
          tx
        );
      }
    }
    await s.audit({ usuario_id: null, usuario: `webhook:${providerId}`, acao: 'editar', recurso: 'gateway_cobrancas', registro_id: Number(cobranca.id), descricao: `Cobrança #${cobranca.id} confirmada PAGA pelo webhook ${providerId} (${cobranca.provider_ref})`, dados: { intencao, evento_id: eventoId } }, tx);
    return { lancamento_id: lancId || null };
  }

  if (intencao === 'cancelada' || intencao === 'expirada') {
    if (['cancelada', 'expirada', 'estornada'].includes(statusAtual)) return { lancamento_id: lancId || null };
    const novoStatus = intencao === 'expirada' ? 'expirada' : 'cancelada';
    await s.tryUpdateIf(R_GATEWAY_COBRANCAS, Number(cobranca.id), { status: statusAtual }, { status: novoStatus, webhook_evento_id: String(eventoId), atualizado_em: new Date().toISOString() }, tx);
    // O título segue pendente no financeiro: a cobrança expirou, a dívida não.
    await s.audit({ usuario_id: null, usuario: `webhook:${providerId}`, acao: 'editar', recurso: 'gateway_cobrancas', registro_id: Number(cobranca.id), descricao: `Cobrança #${cobranca.id} marcada ${novoStatus.toUpperCase()} pelo webhook ${providerId}`, dados: { intencao, evento_id: eventoId } }, tx);
    return { lancamento_id: lancId || null };
  }

  // estornada — devolução notificada pelo gateway. Se o ERP ainda não tinha
  // estornado (fluxo explícito), aplica a reversão financeira agora.
  if (statusAtual === 'estornada') return { lancamento_id: lancId || null };
  const estornada = await s.tryUpdateIf(R_GATEWAY_COBRANCAS, Number(cobranca.id), { status: 'paga' }, { status: 'estornada', webhook_evento_id: String(eventoId), atualizado_em: new Date().toISOString() }, tx);
  if (estornada) {
    await reverterFinanceiroDaCobranca(cobranca, Number(cobranca.valor), { id: null, name: `webhook:${providerId}` }, tx);
    await s.audit({ usuario_id: null, usuario: `webhook:${providerId}`, acao: 'editar', recurso: 'gateway_cobrancas', registro_id: Number(cobranca.id), descricao: `Cobrança #${cobranca.id} ESTORNADA notificada pelo webhook ${providerId}`, dados: { intencao, evento_id: eventoId } }, tx);
  }
  return { lancamento_id: lancId || null };
}

/** GET /api/financeiro/gateway/webhooks — eventos recebidos (auditoria). */
export async function listarEventosWebhook(req: Request, res: Response) {
  const actor = currentUser(req);
  checkAccess(getResourceLancamentos(), actor, 'read');
  const escopo = escopoDoAtor(actor as unknown as AuthUser);
  const s = getStore();
  const filtro: Record<string, unknown> = {};
  if (req.query.status) filtro.status = String(req.query.status);
  if (req.query.provider) filtro.provider = String(req.query.provider);
  const out = await s.list(R_GATEWAY_WEBHOOK_EVENTS, { page: Math.max(1, Number(req.query.page) || 1), pageSize: Math.min(200, Number(req.query.pageSize) || 50), filter: aplicarFiltroEmpresa(R_GATEWAY_WEBHOOK_EVENTS, filtro, escopo) });
  res.json({ total: out.total, eventos: out.rows.map((e) => ({ ...e, payload: undefined, tem_payload: !!e.payload })) });
}

/** POST /api/financeiro/gateway/webhooks/:id/reprocessar — retry manual. */
export async function reprocessarEvento(req: Request, res: Response) {
  const actor = currentUser(req);
  checkAccess(getResourceLancamentos(), actor, 'update');
  const escopo = escopoDoAtor(actor as unknown as AuthUser);
  const s = getStore();
  const evento = assertRegistroDaEmpresa(R_GATEWAY_WEBHOOK_EVENTS, await s.get(R_GATEWAY_WEBHOOK_EVENTS, Number(req.params.id)), escopo);
  if (['processado', 'ignorado'].includes(String(evento.status))) {
    throw new HttpError(409, `Evento já ${String(evento.status)} — nada para reprocessar.`);
  }
  try {
    const out = await processarEvento(evento);
    await s.audit({ usuario_id: actor.id || null, usuario: actor.name, acao: 'editar', recurso: 'gateway_webhook_events', registro_id: Number(evento.id), descricao: `Evento de webhook reprocessado manualmente (${evento.provider}/${evento.evento_id})`, dados: { resultado: out.resultado } });
    res.json({ ok: true, resultado: out.resultado });
  } catch (e: any) {
    throw new HttpError(409, `Reprocessamento falhou: ${String(e?.message || e).slice(0, 200)}`);
  }
}

/** POST /api/admin/financeiro/gateway/webhooks/processar — cron de retry. */
export async function cronWebhooks(req: Request, res: Response) {
  const token = String(req.headers.authorization || '').replace('Bearer ', '');
  const secret = process.env.CRON_SECRET || '';
  if (secret && token !== secret) throw new HttpError(401, 'Token inválido.');
  const s = getStore();
  const pendentes = await s.list(R_GATEWAY_WEBHOOK_EVENTS, { page: 1, pageSize: 100, filter: { status: 'erro' } });
  const agora = new Date().toISOString();
  let processados = 0;
  let falhas = 0;
  for (const e of pendentes.rows) {
    const proxima = e.proxima_tentativa_em ? String(e.proxima_tentativa_em) : '';
    if (proxima && proxima > agora) continue;
    try {
      const out = await processarEvento(e);
      if (out.resultado !== 'erro') processados++;
      else falhas++;
    } catch {
      falhas++;
    }
  }
  res.json({ ok: true, candidatos: pendentes.rows.length, processados, falhas });
}

// Helpers locais ------------------------------------------------------------

function getResourceLancamentos(): Resource {
  return getResource('lancamentos_financeiros')!;
}
