import { providerRegistry } from '../../modules/payments/providers/registry';
import { webhookCompatibility } from '../../modules/payments/providers/legacy-webhook';
import { intencaoMercadoPago, mercadopagoProvider } from '../../modules/payments/providers/mercado-pago/legacy';
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
import { gatewayAmbienteDaVitrine } from './commerce/pagamento-ambiente';
import { HttpError } from './errors';
import { getResource, type Resource } from './resources';
import { checkAccess, getStore } from './services';
import { currentUser, exigirReautenticacao, type AuthUser } from './auth';
import { aplicarFiltroEmpresa, assertRegistroDaEmpresa, escopoDoAtor, empresaDoRegistroAudit, empresaExplicitaAudit, type EscopoEmpresa } from './empresa';
import { round2, diaISO } from './utils';
import { calcularLiquido, efetuarBaixa } from './financeiro';
import { registrarEstornoComissao } from './comissoes';
import { cifrarSegredo, decifrarSegredo, pareceCifrado } from './segredos';
import { reportarErro } from './log';
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
    { name: 'payment_policy', label: 'Política', type: 'json' },
    { name: 'health_status', label: 'Saúde', type: 'text' },
    { name: 'health_checked_at', label: 'Verificado em', type: 'datetime' },
    { name: 'last_error', label: 'Erro', type: 'text' },
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
    // `gateway_cobrancas.payload` é JSONB no banco (db/schema.sql): declarar
    // como 'json' mantém o tipo do recurso igual ao da coluna.
    { name: 'payload', label: 'Payload', type: 'json' },
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
    // `gateway_webhook_events.payload` é JSONB no banco (db/schema.sql). A
    // divergência entre o tipo declarado aqui (textarea) e a coluna real foi a
    // origem do P0-02: o código lia o payload como texto e `String(objeto)`
    // produzia "[object Object]".
    { name: 'payload', label: 'Payload', type: 'json' },
    { name: 'assinatura_ok', label: 'Assinatura OK', type: 'boolean' },
    { name: 'status', label: 'Status', type: 'text' },
    { name: 'tentativas', label: 'Tentativas', type: 'integer' },
    { name: 'proxima_tentativa_em', label: 'Próxima tentativa', type: 'datetime' },
    { name: 'ultima_tentativa_em', label: 'Última tentativa', type: 'datetime' },
    { name: 'erro', label: 'Erro', type: 'text' },
    { name: 'cobranca_id', label: 'Cobrança', type: 'integer' },
    { name: 'lancamento_id', label: 'Lançamento', type: 'integer' },
    { name: 'payload_hash', label: 'Hash', type: 'text' },
    { name: 'correlation_id', label: 'Correlação', type: 'text' },
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
  operationKey?: string;
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

// ----------------------------------------------------------------------------
// GANCHO pós-evento (Commerce OS)
//
// O checkout /loja precisa reagir quando a cobrança muda de estado — e SÓ
// depois que o evento do webhook foi de fato processado (nunca antes, nunca
// pelo frontend). O listener é best-effort: falha dele não derruba o
// processamento financeiro; o commerce registra o próprio outbox de retry.
// ----------------------------------------------------------------------------

export type CobrancaAlteradaEvento = {
  cobrancaId: number;
  empresaId: number;
  intencao: 'paga' | 'cancelada' | 'expirada' | 'estornada';
};

let onCobrancaAlterada: ((evento: CobrancaAlteradaEvento) => Promise<void>) | null = null;

/** Registra (ou desliga com null) o ouvinte de mudança de cobrança. */
export function setOnCobrancaAlterada(fn: ((evento: CobrancaAlteradaEvento) => Promise<void>) | null): void {
  onCobrancaAlterada = fn;
}

async function notificarCobrancaAlterada(evento: CobrancaAlteradaEvento): Promise<void> {
  if (!onCobrancaAlterada) return;
  try {
    await onCobrancaAlterada(evento);
  } catch {
    console.warn('⚠️  Ouvinte de cobrança (commerce) indisponível; detalhes sensíveis omitidos.');
  }
}

/** SQLSTATE de um erro do driver, sem presumir o formato do que foi lançado. */
function codigoDoErro(e: unknown): string {
  if (e && typeof e === 'object' && 'code' in e) return String((e as { code?: unknown }).code ?? '');
  return '';
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

export { mercadopagoProvider } from '../../modules/payments/providers/mercado-pago/legacy';

registrarProvider(mockProvider);
registrarProvider(mercadopagoProvider);
for (const code of ['PAGBANK', 'STRIPE'] as const) registrarProvider(webhookCompatibility(providerRegistry.get(code)));

// ----------------------------------------------------------------------------
// Configuração por empresa
// ----------------------------------------------------------------------------

export async function configDaEmpresa(empresaId: number, provider: string, tx?: Tx): Promise<Row | null> {
  const s = getStore();
  const id = String(provider || '').toLowerCase();
  const persistida = await s.findOneWhere(R_GATEWAY_CONFIGS, { empresa_id: empresaId, provider: id }, tx);
  if (persistida || id !== 'mercadopago') return persistida;
  return gatewayAmbienteDaVitrine(empresaId);
}

export async function contextoDoProvider(empresaId: number, provider: string): Promise<GatewayContext> {
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

  // Escrita considera apenas a linha persistida, nunca o fallback transitório do deploy.
  const existente = await s.findOneWhere(R_GATEWAY_CONFIGS, { empresa_id: escopo.empresaId, provider });
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
    empresa_id: empresaDoRegistroAudit(R_GATEWAY_CONFIGS, row, actor),
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

// ----------------------------------------------------------------------------
// Criação de cobrança — núcleo compartilhado (rota financeira + checkout /loja)
// ----------------------------------------------------------------------------

export type CriarCobrancaGatewayParams = {
  provider: string;
  metodo: MetodoCobranca;
  valor: number;
  taxaPct?: number;
  parcelas?: number;
  descricao?: string;
  vencimento?: string | null;
  expiraEm?: string | null;
  payerEmail?: string | null;
  token?: string | null;
  idempotencyKey: string;
  lancamento?: Row | null;
  venda?: Row | null;
  contaId?: number | null;
  observacoes?: string | null;
  actor: { id: number | null; name: string };
};

/**
 * Normaliza um instante (Date, ISO ou `Date.prototype.toString`) para ISO —
 * `gateway_cobrancas.expira_em` é `timestamptz` e o provedor também exige
 * formato reconhecível. Inválido → 400 honesto (nunca 502 mudo).
 */
export function instanteIso(valor?: string | number | Date | null): string | null {
  if (valor === null || valor === undefined || valor === '') return null;
  const d = new Date(valor);
  if (Number.isNaN(d.getTime())) throw new HttpError(400, `Data de expiração inválida: ${String(valor).slice(0, 60)}`);
  return d.toISOString();
}

/**
 * Núcleo idempotente de criação de cobrança (índice empresa+provider+chave).
 * A rota financeira e o checkout da vitrine usam ESTE caminho — uma regra só.
 * Não autoriza acessos: quem chama é responsável pelo RBAC do seu fluxo.
 */
export async function criarCobrancaGateway(
  escopo: EscopoEmpresa,
  params: CriarCobrancaGatewayParams
): Promise<{ cobranca: Row; resultado: CobrancaProviderResult | null; idempotente: boolean }> {
  const s = getStore();
  const providerId = String(params.provider || '').toLowerCase();
  const metodo = params.metodo;
  const provider = getProvider(providerId);
  if (!provider) throw new HttpError(404, `Provedor "${providerId}" não está registrado.`);

  const lancamento = params.lancamento ?? null;
  const venda = params.venda ?? null;
  const valor = round2(lancamento ? Number(lancamento.valor || 0) : Number(params.valor || 0));
  if (!(valor > 0)) throw new HttpError(400, 'Informe um valor maior que zero (ou vincule um lançamento).', { valor: 'Inválido' });
  const taxaPct = Math.min(99.99, Math.max(0, params.taxaPct ?? 0));
  const parcelas = metodo === 'cartao_credito' ? Math.max(1, Math.trunc(params.parcelas ?? 1)) : 1;
  const idempotencyKey = params.idempotencyKey.slice(0, 120);

  const existente = await s.findOneWhere(R_GATEWAY_COBRANCAS, {
    empresa_id: escopo.empresaId,
    provider: providerId,
    idempotency_key: idempotencyKey,
  });
  if (existente && String(existente.status) !== 'falhou') {
    return { cobranca: existente, resultado: null, idempotente: true };
  }

  const ctx = await contextoDoProvider(escopo.empresaId, providerId);
  const input: CobrancaInput = {
    valor,
    metodo,
    descricao: params.descricao
      ? String(params.descricao).slice(0, 200)
      : lancamento
        ? String(lancamento.descricao)
        : venda
          ? `Venda #${venda.id}`
          : 'Cobrança',
    vencimento: params.vencimento
      ? String(params.vencimento).slice(0, 10)
      : lancamento?.vencimento
        ? diaISO(lancamento.vencimento)
        : null,
    expira_em: instanteIso(params.expiraEm),
    parcelas,
    payer_email: params.payerEmail ? String(params.payerEmail) : null,
    token: params.token ? String(params.token) : null,
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
    conta_id: params.contaId ?? null,
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
    observacoes: params.observacoes ? String(params.observacoes).slice(0, 500) : null,
  };

  let row: Row;
  if (existente) {
    row = (await s.update(R_GATEWAY_COBRANCAS, Number(existente.id), { ...dados, atualizado_em: new Date().toISOString() }))!;
  } else {
    row = await s.insert(R_GATEWAY_COBRANCAS, dados);
  }
  await s.audit({
    usuario_id: params.actor.id,
    usuario: params.actor.name,
    acao: 'criar',
    recurso: 'gateway_cobrancas',
    registro_id: Number(row.id),
    descricao: `Cobrança ${metodo} de ${valor.toFixed(2)} criada via ${providerId} (${resultado.provider_ref})`,
    dados: { provider: providerId, metodo, valor, idempotency_key: idempotencyKey, lancamento_id: dados.lancamento_id, venda_id: dados.venda_id },
    // row.empresa_id é a fonte (escopo passado pelo chamador); sem linha, o
    // fallback nulo cai na empresa do registro — nunca em outra.
    empresa_id: empresaDoRegistroAudit(R_GATEWAY_COBRANCAS, row, null),
  });
  return { cobranca: row, resultado, idempotente: false };
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

  const idempotencyKey = body.idempotency_key
    ? String(body.idempotency_key).slice(0, 120)
    : lancamento
      ? `lanc-${lancamento.id}`
      : venda
        ? `venda-${venda.id}-${metodo}`
        : `avulsa-${createHash('sha1').update(JSON.stringify(body)).digest('hex').slice(0, 20)}`;

  const criada = await criarCobrancaGateway(escopo, {
    provider: providerId,
    metodo,
    valor: Number(body.valor || 0),
    taxaPct: Number(body.taxa_pct || 0),
    parcelas: body.parcelas ? Number(body.parcelas) : undefined,
    descricao: body.descricao ? String(body.descricao) : undefined,
    vencimento: body.vencimento ? String(body.vencimento) : null,
    expiraEm: instanteIso(body.expira_em as string | null),
    payerEmail: body.payer_email ? String(body.payer_email) : null,
    token: body.token ? String(body.token) : null,
    idempotencyKey,
    lancamento,
    venda,
    contaId,
    observacoes: body.observacoes ? String(body.observacoes) : null,
    actor: { id: actor.id || null, name: actor.name },
  });
  if (criada.idempotente) return res.json({ ok: true, idempotente: true, cobranca: publicaCobranca(criada.cobranca) });
  res.status(201).json({ ok: true, cobranca: publicaCobranca(criada.cobranca) });
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
  const { R_INTENTS } = await import('../../modules/payments/infrastructure/resources');
  const intent = await s.findOneWhere(R_INTENTS,{empresa_id:escopo.empresaId,cobranca_id:Number(row.id)});
  if(intent){const {paymentEngine}=await import('../../modules/payments/orchestration/payment-orchestrator');res.json(await paymentEngine.mutate(escopo.empresaId,Number(intent.id),'cancel',String(req.get('Idempotency-Key')||'')));return;}
  if (!['pendente', 'autorizada'].includes(String(row.status))) {
    throw new HttpError(409, `Cobrança "${row.status}" não pode ser cancelada (só pendente/autorizada).`);
  }
  const ctx = await contextoDoProvider(escopo.empresaId, String(row.provider));
  const provider = getProvider(String(row.provider))!;
  await provider.cancelaCobranca(ctx, String(row.provider_ref));
  const atualizada = await s.tryUpdateIf(R_GATEWAY_COBRANCAS, Number(row.id), { empresa_id: escopo.empresaId, status: row.status }, { status: 'cancelada', atualizado_em: new Date().toISOString() });
  if (!atualizada) throw new HttpError(409, 'Cobrança mudou durante o cancelamento externo; concilie antes de continuar.');
  await s.audit({
    usuario_id: actor.id || null,
    usuario: actor.name,
    acao: 'editar',
    recurso: 'gateway_cobrancas',
    registro_id: Number(row.id),
    descricao: `Cobrança #${row.id} cancelada no ${row.provider} (${row.provider_ref})`,
    empresa_id: empresaDoRegistroAudit(R_GATEWAY_COBRANCAS, row, actor),
    dados: { status: 'cancelada' },
  });
  await notificarCobrancaAlterada({ cobrancaId: Number(row.id), empresaId: Number(row.empresa_id), intencao: 'cancelada' });
  res.json({ ok: true, cobranca: publicaCobranca(atualizada) });
}

/** Called only after an authoritative provider response proved a full refund. */
async function resolverRevisaoLegadaComprovada(cobranca: Row, tx: Tx): Promise<void> {
  const order = await getStore().findOneWhere(getResource('commerce_pedidos')!,
    { empresa_id: Number(cobranca.empresa_id), cobranca_id: Number(cobranca.id) }, tx);
  if (order && ['EXPIRADO', 'CANCELADO'].includes(String(order.estado))) {
    const { resolveLateRefund } = await import('../../modules/payments/application/late-reviews');
    await resolveLateRefund(Number(cobranca.empresa_id), order, tx);
  }
}

/** POST /api/financeiro/gateway/cobrancas/:id/estornar — devolve dinheiro. */
export async function estornarCobranca(req: Request, res: Response) {
  const actor = currentUser(req);
  checkAccess(getResourceLancamentos(), actor, 'update');
  const escopo = escopoDoAtor(actor as unknown as AuthUser);
  const s = getStore();
  const row = assertRegistroDaEmpresa(R_GATEWAY_COBRANCAS, await s.get(R_GATEWAY_COBRANCAS, Number(req.params.id)), escopo);
  const { R_INTENTS } = await import('../../modules/payments/infrastructure/resources');
  const intent = await s.findOneWhere(R_INTENTS,{empresa_id:escopo.empresaId,cobranca_id:Number(row.id)});
  if(intent){const {paymentEngine}=await import('../../modules/payments/orchestration/payment-orchestrator');res.json(await paymentEngine.mutate(escopo.empresaId,Number(intent.id),'refund',String(req.get('Idempotency-Key')||''),req.body?.valor!=null?Math.round(Number(req.body.valor)*100):undefined));return;}
  if (String(row.status) !== 'paga') throw new HttpError(409, 'Só se estorna cobrança paga.');
  const ctx = await contextoDoProvider(escopo.empresaId, String(row.provider));
  const provider = getProvider(String(row.provider))!;
  const valor = req.body?.valor != null && req.body.valor !== '' ? Number(req.body.valor) : undefined;
  if (valor !== undefined && (!Number.isFinite(valor) || valor <= 0 || valor > Number(row.valor) + 0.009)) {
    throw new HttpError(400, 'Valor de estorno inválido (deve estar entre 0 e o valor da cobrança).', { valor: 'Inválido' });
  }
  if (valor !== undefined && round2(valor) !== round2(Number(row.valor))) {
    throw new HttpError(409, 'Estorno parcial de cobrança legada não é suportado com segurança; use o Payment Engine ou concilie manualmente.');
  }
  // Legacy refunds lack an operation ledger. For Mercado Pago, use one
  // deterministic provider key and reconcile before and after the write;
  // ambiguous/partial outcomes are never projected as complete. Other real
  // legacy adapters must use the engine or manual reconciliation instead.
  const testeMock = process.env.NODE_ENV === 'test' && provider.id === 'mock';
  if (!testeMock && provider.id !== 'mercadopago')
    throw new HttpError(409, 'Estorno legado sem confirmação de valor não é suportado; use o Payment Engine ou concilie manualmente.');
  const legacyCtx = { ...ctx, operationKey: `legacy-refund:${escopo.empresaId}:${row.id}` };
  const verificar = async (): Promise<'paga' | 'estornada'> => {
    const remote = await provider.consultaCobranca(legacyCtx, String(row.provider_ref));
    const bruto = remote?.bruto;
    const total = Number(bruto?.transaction_amount);
    const devolvido = Number(bruto?.transaction_amount_refunded);
    if (!bruto || String(bruto.id) !== String(row.provider_ref) || bruto.currency_id !== 'BRL' || !Number.isFinite(total) || round2(total) !== round2(Number(row.valor)) ||
        !Number.isFinite(devolvido) || devolvido < 0 || devolvido > total)
      throw new HttpError(409, 'Valor do estorno legado não pôde ser confirmado; concilie antes de continuar.');
    if (bruto.status === 'refunded' && round2(devolvido) === round2(total)) return 'estornada';
    if (bruto.status === 'approved' && devolvido === 0) return 'paga';
    throw new HttpError(409, 'Estorno legado parcial, pendente ou contestado exige conciliação manual.');
  };
  if (testeMock) await provider.estornaCobranca(legacyCtx, String(row.provider_ref), Number(row.valor));
  else if (await verificar() === 'paga') {
    await provider.estornaCobranca(legacyCtx, String(row.provider_ref), Number(row.valor));
    if (await verificar() !== 'estornada')
      throw new HttpError(409, 'Estorno enviado, mas ainda sem confirmação integral; concilie antes de repetir.');
  }

  const resultado = await s.transaction(async (tx) => {
    const atualizada = await s.tryUpdateIf(R_GATEWAY_COBRANCAS, Number(row.id), { status: 'paga' }, { status: 'estornada', atualizado_em: new Date().toISOString() }, tx);
    if (!atualizada) throw new HttpError(409, 'A cobrança mudou durante o estorno.');
    const estornoLancamentoId = await reverterFinanceiroDaCobranca(row, round2(valor ?? Number(row.valor)), { id: actor.id || null, name: actor.name }, tx);
    if (provider.id === 'mercadopago') await resolverRevisaoLegadaComprovada(atualizada, tx);
    await s.audit({
      usuario_id: actor.id || null,
      usuario: actor.name,
      acao: 'editar',
      recurso: 'gateway_cobrancas',
      registro_id: Number(row.id),
      descricao: `Cobrança #${row.id} ESTORNADA integralmente no ${row.provider} (${row.provider_ref})`,
      empresa_id: empresaDoRegistroAudit(R_GATEWAY_COBRANCAS, row, actor),
      dados: { status: 'estornada', valor: valor ?? Number(row.valor), estorno_lancamento_id: estornoLancamentoId },
    }, tx);
    return { atualizada, estornoLancamentoId };
  }, { isolation: 'serializable' });
  await notificarCobrancaAlterada({ cobrancaId: Number(row.id), empresaId: Number(row.empresa_id), intencao: 'estornada' });
  res.json({ ok: true, cobranca: publicaCobranca(resultado.atualizada), estorno_lancamento_id: resultado.estornoLancamentoId });
}

/**
 * Reversão financeira de um estorno/devolução de cobrança: o dinheiro que
 * voltou vira lançamento de estorno (o caixa volta a bater) e a comissão
 * efetivada sobre esse dinheiro é estornada. Idempotente por estado do
 * lançamento (só reverte o que está confirmado).
 */
export async function reverterFinanceiroDaCobranca(
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
        empresa_id: empresaDoRegistroAudit(getResourceLancamentos(), estorno, actor),
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
    // A referência do corpo NÃO é autenticação. Ela só identifica a cobrança
    // candidata; o segredo é o da empresa dona da cobrança, nunca o de outra
    // config do mesmo provedor. Referência ambígua não autoriza nenhum efeito.
    const cobrancas = parsed.provider_ref
      ? await s.list(R_GATEWAY_COBRANCAS, { page: 1, pageSize: 2, filter: { provider: providerId, provider_ref: parsed.provider_ref } })
      : null;
    if (cobrancas && cobrancas.total > 1) return res.status(409).json({ error: 'Referência de cobrança ambígua.' });
    const empresaId = cobrancas?.rows[0] ? Number(cobrancas.rows[0].empresa_id) : null;
    let config = empresaId === null ? null : await configDaEmpresa(empresaId, providerId);
    if(empresaId!==null && !config && ['stripe','pagbank'].includes(providerId)){const {account}=await import('../../modules/payments/application/configuration');config=(await account(empresaId,providerId==='stripe'?'STRIPE':'PAGBANK')).config;}
    if (empresaId !== null && (!config || config.ativo === false)) return res.status(401).json({ error: 'Assinatura inválida.' });
    let segredo = config ? decifrarSegredo(config.webhook_segredo_cifrado as string | null) : null;
    if(!segredo && providerId==='pagbank' && config){try{segredo=JSON.parse(decifrarSegredo(config.credenciais_cifradas)||'{}').access_token||null;}catch{/* fail closed */}}
    const ctxLocal: GatewayContext | null = config && empresaId !== null
      ? { empresaId, config, credenciais: (() => { try { return JSON.parse(decifrarSegredo(config.credenciais_cifradas) || '{}'); } catch { return null; } })(), webhookSegredo: segredo }
      : null;
    const assinaturaOk = !!segredo && !!ctxLocal && provider.verificaAssinatura(ctxLocal, corpo, req.headers as Record<string, string | undefined>);

    if (providerId !== 'mock' && !segredo) return res.status(401).json({error:'Assinatura inválida ou provider não configurado.'});

    // Verifique a assinatura ANTES de responder "duplicado". Caso contrário,
    // um terceiro obtém ACK de evento de outro tenant sem autenticar.
    // IDEMPOTÊNCIA: rejeições ('ignorado') não envenenam o retry assinado.
    const anteriores = await s.list(R_GATEWAY_WEBHOOK_EVENTS, { page: 1, pageSize: 2, filter: { provider: providerId, evento_id: parsed.evento_id } });
    const anterior = anteriores.rows[0] ?? null;
    const rejeicaoLegadaSemEmpresa = anterior?.empresa_id == null && anterior?.status === 'ignorado';
    if (anterior && ((!rejeicaoLegadaSemEmpresa && Number(anterior.empresa_id || 0) !== Number(empresaId || 0))
      || extrairRefDoPayload(provider, lerPayloadWebhook(anterior.payload)) !== parsed.provider_ref)) {
      return res.status(409).json({ error: 'Evento já registrado para outra cobrança.' });
    }
    // Um evento que entrou em erro quando a empresa ainda não exigia assinatura
    // não pode ser pago pelo cron após o admin ativar o segredo. Somente uma
    // nova entrega com assinatura válida pode promovê-lo a recebido.
    const aceito = anteriores.rows.find((r) => String(r.status) !== 'ignorado'
      && !(segredo && r.status === 'erro' && r.assinatura_ok !== true));
    const jaRejeitado = aceito ? null : anterior;

    if (segredo && !assinaturaOk) {
      // Nunca atualizar nem dar ACK de duplicata de um evento já aceito
      // quando a entrega atual não foi autenticada.
      if (aceito) return res.status(401).json({ error: 'Assinatura inválida.' });
      // Registro forense + rejeição: assinatura inválida não processa nada.
      // Repetição de rejeição só atualiza o carimbo — não empilha linhas.
      const evento = jaRejeitado
        ? await s.update(R_GATEWAY_WEBHOOK_EVENTS, Number(jaRejeitado.id), { recebido_em: new Date().toISOString(), payload: payloadSeguroInbox(providerId, corpo) })
        : await s.insert(R_GATEWAY_WEBHOOK_EVENTS, {
            empresa_id: empresaId,
            provider: providerId,
            evento_id: parsed.evento_id,
            evento: parsed.evento,
            payload: payloadSeguroInbox(providerId, corpo),
            assinatura_ok: false,
            status: 'ignorado',
            erro: 'Assinatura inválida.',
            recebido_em: new Date().toISOString(),
          });
      const registroId = jaRejeitado ? Number(jaRejeitado.id) : Number((evento as Row).id);
      await s.audit({ usuario_id: null, usuario: 'webhook', acao: 'seguranca', recurso: 'gateway_webhook_events', registro_id: registroId, descricao: `Webhook ${providerId} rejeitado: assinatura inválida (evento ${parsed.evento_id})`, dados: { provider: providerId, evento_id: parsed.evento_id }, empresa_id: empresaExplicitaAudit(empresaId, null) });
      return res.status(401).json({ error: 'Assinatura inválida.' });
    }
    if (aceito) return res.json({ ok: true, duplicado: true, evento_id: parsed.evento_id });

    // Persistência ANTES do processamento: mesmo que o processamento falhe,
    // o evento está gravado e entra no retry — sem duplicar (índice único).
    const dadosEvento = {
      empresa_id: empresaId,
      provider: providerId,
      evento_id: parsed.evento_id,
      evento: parsed.evento,
      payload: payloadSeguroInbox(providerId, corpo),
      payload_hash: createHash('sha256').update(corpo).digest('hex'),
      correlation_id: randomBytes(16).toString('hex'),
      assinatura_ok: assinaturaOk,
      status: 'recebido',
      tentativas: 0,
      recebido_em: new Date().toISOString(),
    };
    let evento: Row;
    try {
      // Notificação anterior REJEITADA (ex.: assinatura inválida) é reaproveitada
      // em vez de inserir uma segunda linha: o índice único é (provider, evento_id),
      // então a inserção nova violaria a trava e devolvia 202 com o nome da
      // constraint. Rejeitar não pode envenenar o retry legítimo do provedor.
      evento = jaRejeitado
        ? (await s.update(R_GATEWAY_WEBHOOK_EVENTS, Number(jaRejeitado.id), dadosEvento))!
        : await s.insert(R_GATEWAY_WEBHOOK_EVENTS, dadosEvento);
    } catch (e) {
      // Corrida entre duas entregas idênticas: a trava do banco deixou uma
      // passar; a outra é duplicata por definição, não erro.
      if (codigoDoErro(e) === '23505') {
        const atual = await s.findOneWhere(R_GATEWAY_WEBHOOK_EVENTS, { provider: providerId, evento_id: parsed.evento_id });
        if (!atual || Number(atual.empresa_id || 0) !== Number(empresaId || 0)
          || extrairRefDoPayload(provider, lerPayloadWebhook(atual.payload)) !== parsed.provider_ref) {
          return res.status(409).json({ error: 'Evento já registrado para outra cobrança.' });
        }
        return res.json({ ok: true, duplicado: true, evento_id: parsed.evento_id });
      }
      throw e;
    }

    // ACK imediato ao provedor; processamento a seguir. Se falhar, o evento
    // fica com status 'erro' e o retry (cron/manual) tenta de novo.
    try {
      const { resultado } = await processarEvento(evento);
      // `processado` reflete o efeito real: evento sem efeito financeiro é
      // ignorado, não "processado" (antes o ACK dizia true em qualquer caso).
      return res.json({ ok: true, evento_id: parsed.evento_id, resultado, processado: !['ignorado', 'erro'].includes(resultado) });
    } catch {
      // Do not send arbitrary provider/driver messages or raw event IDs to logs.
      reportarErro(new Error('Falha ao processar webhook de pagamento.'), { rota: 'POST /api/gateway/webhooks/:provider', empresa_id: empresaId, correlation_id: evento.correlation_id });
      return res.json({ ok: true, evento_id: parsed.evento_id, resultado: 'erro', processado: false });
    }
  } catch {
    // Neither the public response nor logs may expose driver/provider secrets.
    reportarErro(new Error('Falha ao registrar webhook de pagamento.'), { rota: 'POST /api/gateway/webhooks/:provider' });
    return res.status(202).json({ ok: false, erro: 'Falha interna ao registrar o evento. A próxima tentativa do provedor reprocessa.' });
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

  // O payload vem de uma coluna JSONB: o driver já o entrega como OBJETO. Ler
  // com `String(...)` produzia "[object Object]" e o evento legítimo caía em
  // "Nenhuma cobrança deste provedor com essa referência." (P0-02). Também
  // aceita string JSON (modo demonstração / registros antigos gravados como
  // texto) — a leitura nunca depende do tipo que o driver devolveu.
  const payload = lerPayloadWebhook(evento.payload);
  const parsed: WebhookParse = { evento_id: String(evento.evento_id), evento: String(evento.evento || ''), provider_ref: extrairRefDoPayload(provider, payload) };

  const tentativas = Number(evento.tentativas || 0) + 1;
  try {
    // Contexto: empresa vem da cobrança (o webhook não carrega tenant).
    let cobranca: Row | null = null;
    if (parsed.provider_ref) {
      const achadas = await s.list(R_GATEWAY_COBRANCAS, { page: 1, pageSize: 2, filter: { provider: providerId, provider_ref: parsed.provider_ref } });
      if (achadas.total > 1) {
        await marcarErro('Referência de cobrança ambígua.', tentativas);
        return { resultado: 'erro' };
      }
      cobranca = achadas.rows[0] ?? null;
    }
    if (!cobranca) {
      await s.update(R_GATEWAY_WEBHOOK_EVENTS, Number(evento.id), { status: 'ignorado', erro: 'Nenhuma cobrança deste provedor com essa referência.', tentativas, ultima_tentativa_em: new Date().toISOString() });
      return { resultado: 'ignorado' };
    }

    if (evento.empresa_id != null && Number(evento.empresa_id) !== Number(cobranca.empresa_id)) {
      await marcarErro('Empresa do evento diverge da cobrança.', tentativas);
      return { resultado: 'erro' };
    }
    let ctx = await contextoDoProvider(Number(cobranca.empresa_id), providerId).catch(() => null);
    if(!ctx && ['stripe','pagbank'].includes(providerId)){const {account}=await import('../../modules/payments/application/configuration');const a=await account(Number(cobranca.empresa_id),providerId==='stripe'?'STRIPE':'PAGBANK');if(a.config)ctx={empresaId:Number(cobranca.empresa_id),config:a.config,credenciais:a.context.credentials,webhookSegredo:a.context.webhookSecret};}
    if (!ctx) {
      await marcarErro('Configuração do gateway ausente/inativa.', tentativas);
      return { resultado: 'erro' };
    }
    // A política de autenticação vigente também vale para retry pelo cron e
    // pelo admin: sem esta guarda, um evento persistido antes de ativar o
    // segredo (assinatura_ok=false) poderia baixar a cobrança depois dele.
    if (ctx.webhookSegredo && evento.assinatura_ok !== true) {
      await marcarErro('Nova entrega assinada necessária para reprocessar.', tentativas);
      return { resultado: 'erro' };
    }

    const { processEngineWebhook } = await import('../../modules/payments/application/webhooks');
    const engineResult = await processEngineWebhook(evento, providerId, String(parsed.provider_ref || ''));
    if (engineResult) return engineResult;

    let intencao: IntencaoWebhook = null;
    // Provedor com consulta oficial é a autoridade, inclusive quando retorna
    // null (pendente). Nunca promover status de um campo não assinado do body.
    if (providerId === 'mercadopago') {
      const remote = await provider.consultaCobranca(ctx, String(parsed.provider_ref));
      const bruto = remote?.bruto;
      if (!remote || !bruto || String(bruto.id) !== String(parsed.provider_ref) || bruto.currency_id !== 'BRL' ||
          !Number.isFinite(Number(bruto.transaction_amount)) || round2(Number(bruto.transaction_amount)) !== round2(Number(cobranca.valor)))
        throw new HttpError(409, 'Valor, moeda ou referência divergente; conciliação necessária.');
      intencao = intencaoMercadoPago(remote);
    } else if (provider.resolveWebhook) intencao = await provider.resolveWebhook(ctx, parsed, payload);
    else intencao = intencaoDoPayload(payload);
    if (!intencao) {
      await s.update(R_GATEWAY_WEBHOOK_EVENTS, Number(evento.id), { status: 'ignorado', erro: 'Evento sem efeito financeiro (status irrelevante).', tentativas, ultima_tentativa_em: new Date().toISOString(), cobranca_id: Number(cobranca.id) });
      return { resultado: 'ignorado' };
    }

    const efeito = await s.transaction(async (tx) => {
      const atual = await s.findOneWhere(R_GATEWAY_COBRANCAS, { id: Number(cobranca!.id), empresa_id: Number(cobranca!.empresa_id) }, tx);
      if (!atual) throw new HttpError(404, 'Cobrança não encontrada.');
      if (round2(Number(atual.valor)) !== round2(Number(cobranca!.valor))) throw new HttpError(409, 'Cobrança mudou durante a consulta; conciliação necessária.');
      const applied = await aplicarIntencao(providerId, atual, intencao!, Number(evento.id), tx);
      if (providerId === 'mercadopago' && intencao === 'estornada') await resolverRevisaoLegadaComprovada(atual, tx);
      return applied;
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
    // PAGAMENTO NUNCA CONFIRMADO PELO FRONTEND: só aqui, após o evento
    // processado, o commerce (checkout /loja) projeta o pedido e converte.
    await notificarCobrancaAlterada({
      cobrancaId: Number(cobranca.id),
      empresaId: Number(cobranca.empresa_id),
      intencao,
    });
    return { resultado: intencao };
  } catch (e: any) {
    const mensagem = 'Não foi possível processar o evento; revise a configuração e a conciliação.';
    await marcarErro(mensagem, tentativas);
    throw new HttpError(e instanceof HttpError ? e.status : 502, mensagem);
  }
}

function extrairRefDoPayload(provider: PaymentProvider, payload: Record<string, unknown>): string | null {
  const parsed = provider.parseWebhook(JSON.stringify(payload));
  return parsed?.provider_ref ?? null;
}

/**
 * Lê o payload de um evento de webhook sem presumir o tipo entregue pelo driver.
 * A coluna é JSONB: o Postgres devolve objeto; no modo demonstração (e em
 * registros antigos gravados como texto) chega string. `String({...})` vira
 * "[object Object]" — foi exatamente o defeito P0-02, que fazia todo webhook de
 * pagamento legítimo terminar em 'ignorado'.
 */
export function lerPayloadWebhook(bruto: unknown): Record<string, unknown> {
  if (bruto === null || bruto === undefined) return {};
  if (Buffer.isBuffer(bruto)) return lerPayloadWebhook(bruto.toString('utf8'));
  if (typeof bruto === 'object') return bruto as Record<string, unknown>;
  const texto = String(bruto);
  if (!texto.trim()) return {};
  try {
    const valor = JSON.parse(texto);
    return valor && typeof valor === 'object' ? (valor as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * Prepara o corpo cru para a coluna JSONB `payload`. Corpo JSON vira o objeto
 * (é o que a coluna guarda de fato — permite consultar `payload->>'data'`);
 * corpo não-JSON (form-encoded, texto) é preservado dentro do envelope
 * `{ bruto }`, porque uma coluna JSONB não aceita texto puro.
 */
function payloadSeguroInbox(provider: string, raw: string): Record<string, unknown> {
  if (provider === 'mock') return payloadParaArmazenar(raw);
  const b = lerPayloadWebhook(raw);
  // Only references required by parseWebhook. No card, payer, token or arbitrary raw payload.
  const safe = (value: unknown) => typeof value === 'string' || typeof value === 'number' ? String(value).slice(0,200) : undefined;
  const data = b.data && typeof b.data === 'object' ? b.data as Record<string,unknown> : {};
  const object = data.object && typeof data.object === 'object' ? data.object as Record<string,unknown> : {};
  return {id:safe(b.id),type:safe(b.type),topic:safe(b.topic),action:safe(b.action),date_created:safe(b.date_created),data:{id:safe(data.id),object:{id:safe(object.id)}}};
}

export function payloadParaArmazenar(corpo: unknown): Record<string, unknown> {
  const texto = Buffer.isBuffer(corpo) ? corpo.toString('utf8') : String(corpo ?? '');
  const limitado = texto.slice(0, 20_000);
  try {
    const valor = JSON.parse(limitado);
    if (valor && typeof valor === 'object') return valor as Record<string, unknown>;
  } catch {
    // corpo não-JSON: mantém a evidência no envelope abaixo
  }
  return { bruto: limitado };
}

function intencaoDoPayload(payload: Record<string, unknown>): IntencaoWebhook {
  const status = String(payload.status || '').toLowerCase();
  if (['pago', 'paga', 'paid', 'approved'].includes(status)) return 'paga';
  if (['cancelado', 'cancelled', 'rejected'].includes(status)) return 'cancelada';
  if (['estornado', 'refunded'].includes(status)) return 'estornada';
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
    if (['cancelada', 'expirada'].includes(statusAtual)) {
      // A verified late legacy payment must be visible without reviving the
      // order or settling a financial title automatically.
      const order = await s.findOneWhere(getResource('commerce_pedidos')!, { empresa_id: Number(cobranca.empresa_id), cobranca_id: Number(cobranca.id) }, tx);
      if (!order || !['CANCELADO', 'EXPIRADO'].includes(String(order.estado)))
        throw new HttpError(409, 'Pagamento tardio requer conciliação manual.');
      const atualizada = await s.tryUpdateIf(R_GATEWAY_COBRANCAS, Number(cobranca.id), { empresa_id: Number(cobranca.empresa_id), status: statusAtual },
        { status: 'paga', webhook_evento_id: String(eventoId), atualizado_em: new Date().toISOString() }, tx);
      if (!atualizada) throw new HttpError(409, 'A cobrança mudou durante o processamento do webhook.');
      const { recordLatePayment } = await import('../../modules/payments/application/late-reviews');
      await recordLatePayment(Number(cobranca.empresa_id), order, Number(cobranca.id), tx);
      await s.audit({ usuario_id: null, usuario: `webhook:${providerId}`, acao: 'ajuste', recurso: 'gateway_cobrancas', registro_id: Number(cobranca.id),
        descricao: 'Pagamento tardio confirmado; conciliação necessária, sem baixa automática', dados: { evento_id: eventoId }, empresa_id: Number(cobranca.empresa_id) }, tx);
      return { lancamento_id: lancId || null };
    }
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
    await s.audit({ usuario_id: null, usuario: `webhook:${providerId}`, acao: 'editar', recurso: 'gateway_cobrancas', registro_id: Number(cobranca.id), descricao: `Cobrança #${cobranca.id} confirmada PAGA pelo webhook ${providerId} (${cobranca.provider_ref})`, dados: { intencao, evento_id: eventoId }, empresa_id: empresaDoRegistroAudit(R_GATEWAY_COBRANCAS, cobranca, null) }, tx);
    return { lancamento_id: lancId || null };
  }

  if (intencao === 'cancelada' || intencao === 'expirada') {
    if (['cancelada', 'expirada', 'estornada'].includes(statusAtual)) return { lancamento_id: lancId || null };
    if (statusAtual === 'paga') throw new HttpError(409, 'Cobrança paga não pode ser cancelada por notificação; requer conciliação.');
    const novoStatus = intencao === 'expirada' ? 'expirada' : 'cancelada';
    const cancelada = await s.tryUpdateIf(R_GATEWAY_COBRANCAS, Number(cobranca.id), { status: statusAtual }, { status: novoStatus, webhook_evento_id: String(eventoId), atualizado_em: new Date().toISOString() }, tx);
    if (!cancelada) throw new HttpError(409, 'A cobrança mudou durante o processamento do webhook.');
    // O título segue pendente no financeiro: a cobrança expirou, a dívida não.
    await s.audit({ usuario_id: null, usuario: `webhook:${providerId}`, acao: 'editar', recurso: 'gateway_cobrancas', registro_id: Number(cobranca.id), descricao: `Cobrança #${cobranca.id} marcada ${novoStatus.toUpperCase()} pelo webhook ${providerId}`, dados: { intencao, evento_id: eventoId }, empresa_id: empresaDoRegistroAudit(R_GATEWAY_COBRANCAS, cobranca, null) }, tx);
    return { lancamento_id: lancId || null };
  }

  // estornada — devolução notificada pelo gateway. Se o ERP ainda não tinha
  // estornado (fluxo explícito), aplica a reversão financeira agora.
  if (statusAtual === 'estornada') return { lancamento_id: lancId || null };
  const estornada = await s.tryUpdateIf(R_GATEWAY_COBRANCAS, Number(cobranca.id), { status: 'paga' }, { status: 'estornada', webhook_evento_id: String(eventoId), atualizado_em: new Date().toISOString() }, tx);
  if (!estornada) throw new HttpError(409, 'Estorno sem cobrança paga exige conciliação.');
  if (estornada) {
    await reverterFinanceiroDaCobranca(cobranca, Number(cobranca.valor), { id: null, name: `webhook:${providerId}` }, tx);
    await s.audit({ usuario_id: null, usuario: `webhook:${providerId}`, acao: 'editar', recurso: 'gateway_cobrancas', registro_id: Number(cobranca.id), descricao: `Cobrança #${cobranca.id} ESTORNADA notificada pelo webhook ${providerId}`, dados: { intencao, evento_id: eventoId }, empresa_id: empresaDoRegistroAudit(R_GATEWAY_COBRANCAS, cobranca, null) }, tx);
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
    await s.audit({ usuario_id: actor.id || null, usuario: actor.name, acao: 'editar', recurso: 'gateway_webhook_events', registro_id: Number(evento.id), descricao: `Evento de webhook reprocessado manualmente (${evento.provider}/${evento.evento_id})`, dados: { resultado: out.resultado }, empresa_id: empresaDoRegistroAudit(R_GATEWAY_WEBHOOK_EVENTS, evento, actor) });
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
