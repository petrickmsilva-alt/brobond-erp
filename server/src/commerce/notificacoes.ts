// ============================================================================
// NOTIFICATION ORCHESTRATOR — comunicação TRANSACIONAL do pedido.
//
//   DOMAIN EVENT → OUTBOX (commerce_outbox, `sincronizacao`/acao=notificacao)
//                → commerce_notificacoes (1 linha por evento/canal/destinatário)
//                → EMAIL ADAPTER (mail.ts / SMTP)
//                → WHATSAPP ADAPTER (Meta WhatsApp Business Cloud API)
//
// Regras inegociáveis desta rodada:
//   • NENHUM envio acontece dentro do checkout: o pedido só registra o evento
//     no outbox. Provedor indisponível → pedido continua válido + retry.
//   • Idempotência: chave única (empresa, pedido, evento, canal, destinatário).
//     Webhook duplicado nunca reenvia mensagem.
//   • Marketing é OUTRA coisa: `marketing_opt_in` vive em
//     commerce_pedidos.comprador e NÃO gera evento aqui nesta rodada.
//   • WhatsApp: SOMENTE a API oficial Cloud da Meta, com template aprovado.
//     Sem API unofficial, sem Web automation, sem token no frontend.
//   • Nada de Access Token, CPF, e-mail ou telefone completo em logs/erros.
// ============================================================================
import { createHash, randomUUID } from 'node:crypto';
import { getStore } from '../services';
import { getResource } from '../resources';
import { enfileirarOutbox } from './outbox';
import { enviarEmail, smtpConfigurado, escaparHtml, corpoEmail, blocoLinkEmail } from '../mail';
import { log } from '../log';
import type { Row, Tx } from '../store';

export const EVENTOS_NOTIFICACAO = [
  'ORDER_CREATED',
  'PIX_GENERATED',
  'PAYMENT_PENDING',
  'PAYMENT_APPROVED',
  'PAYMENT_REJECTED',
  'ORDER_PROCESSING',
  'ORDER_SHIPPED',
  'ORDER_DELIVERED',
  'ORDER_CANCELLED',
] as const;

/**
 * Vocabulário de negócio (português, usado na homologação) → constantes
 * persistidas. Mantém UMA única lista canônica (`EVENTOS_NOTIFICACAO`), sem
 * criar um segundo catálogo de eventos nem tabela paralela.
 */
export const MAPA_EVENTOS_HOMOLOGACAO = {
  PEDIDO_CRIADO: 'ORDER_CREATED',
  PIX_GENERATED: 'PIX_GENERATED',
  PAGAMENTO_APROVADO: 'PAYMENT_APPROVED',
  PAGAMENTO_RECUSADO: 'PAYMENT_REJECTED',
  PEDIDO_PROCESSANDO: 'ORDER_PROCESSING',
  PEDIDO_ENVIADO: 'ORDER_SHIPPED',
  PEDIDO_ENTREGUE: 'ORDER_DELIVERED',
  PEDIDO_CANCELADO: 'ORDER_CANCELLED',
} as const satisfies Partial<Record<string, (typeof EVENTOS_NOTIFICACAO)[number]>>;
export type EventoNotificacao = (typeof EVENTOS_NOTIFICACAO)[number];
export type CanalNotificacao = 'EMAIL' | 'WHATSAPP';

const R_NOTIFICACOES = () => getResource('commerce_notificacoes')!;

/** Textos transacionais curtos — NUNCA marketing, NUNCA dado inventado. */
export const MENSAGENS: Record<EventoNotificacao, string> = {
  ORDER_CREATED: 'Recebemos seu pedido.',
  PIX_GENERATED: 'Seu PIX foi gerado.',
  PAYMENT_PENDING: 'Estamos aguardando a confirmação do pagamento.',
  PAYMENT_APPROVED: 'Pagamento aprovado.',
  PAYMENT_REJECTED: 'Não conseguimos confirmar o pagamento. Seu pedido foi cancelado e o estoque foi liberado.',
  ORDER_PROCESSING: 'Seu pedido está sendo preparado.',
  ORDER_SHIPPED: 'Seu pedido foi enviado.',
  ORDER_DELIVERED: 'Pedido entregue.',
  ORDER_CANCELLED: 'Seu pedido foi cancelado.',
};

export type ContatoPedido = {
  nome?: string | null;
  email?: string | null;
  whatsapp?: string | null;
  telefone?: string | null;
};

export type ContextoEvento = {
  empresaId: number;
  pedidoId: number;
  evento: EventoNotificacao;
  /** Dados REAIS do pedido, já persistidos no servidor. */
  pedidoExterno?: string | null;
  checkoutToken?: string | null;
  total?: number | null;
};

const EMAIL_OK = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Normaliza telefone brasileiro para E.164 (só dígitos). Nunca loga o valor. */
export function normalizarWhatsApp(valor: unknown): string | null {
  const digitos = String(valor ?? '').replace(/\D/g, '');
  if (!digitos) return null;
  if (digitos.length === 10 || digitos.length === 11) return `55${digitos}`;
  if (/^55\d{10,11}$/.test(digitos)) return digitos;
  if (digitos.length >= 12 && digitos.length <= 15) return digitos;
  return null;
}

/** Hash do destinatário: a chave de idempotência não expõe PII em índice/log. */
function chaveIdempotencia(pedidoId: number, evento: string, canal: string, destinatario: string): string {
  const hash = createHash('sha256').update(`${canal}:${destinatario}`).digest('hex').slice(0, 20);
  return `${pedidoId}:${evento}:${canal}:${hash}`;
}

/**
 * Registra um evento de domínio. Chamada pelo checkout/pagamento/fulfillment,
 * SEMPRE fora do caminho crítico e SEM esperar provedor externo.
 * Devolve o número de linhas novas (0 = evento já registrado = idempotente).
 */
export async function registrarEventoPedido(
  contato: ContatoPedido,
  ctx: ContextoEvento,
  tx?: Tx
): Promise<number> {
  if (!EVENTOS_NOTIFICACAO.includes(ctx.evento)) return 0;
  const s = getStore();
  const agora = new Date().toISOString();
  const email = String(contato.email || '').trim().toLowerCase();
  const whatsapp = normalizarWhatsApp(contato.whatsapp || contato.telefone);
  const destinatarios: { canal: CanalNotificacao; destinatario: string; template: string | null }[] = [];
  if (EMAIL_OK.test(email)) destinatarios.push({ canal: 'EMAIL', destinatario: email.slice(0, 160), template: null });
  if (whatsapp) {
    // Templates aprovados na Meta são configurados por evento no backend.
    destinatarios.push({ canal: 'WHATSAPP', destinatario: whatsapp, template: templateWhatsApp(ctx.evento) });
  }
  if (!destinatarios.length) return 0;

  let novas = 0;
  for (const d of destinatarios) {
    const chave = chaveIdempotencia(ctx.pedidoId, ctx.evento, d.canal, d.destinatario);
    const existente = await s.findOneWhere(R_NOTIFICACOES(), { empresa_id: ctx.empresaId, chave_idempotencia: chave }, tx);
    if (existente) continue;
    await s.insert(
      R_NOTIFICACOES(),
      {
        empresa_id: ctx.empresaId,
        pedido_id: ctx.pedidoId,
        evento: ctx.evento,
        canal: d.canal,
        destinatario: d.destinatario,
        template: d.template,
        estado: 'PENDENTE',
        tentativas: 0,
        ultimo_erro: null,
        chave_idempotencia: chave,
        criado_em: agora,
        atualizado_em: agora,
        enviado_em: null,
      },
      tx
    );
    novas += 1;
  }
  // Um único trabalho no outbox por evento: o orchestrator resolve TODOS os
  // canais. A chave é estável → webhook duplicado não cria segundo trabalho.
  // `sincronizacao` + `acao='notificacao'`: entrega externa dentro do conjunto
  // de tipos aceito por TODA a cadeia de migrations (0068/0090). Um tipo novo
  // faria a 0090 falhar ao ser reaplicada em banco com dados (CHECK mais
  // estreito), degradando o ERP — causa real do FAIL `testes-postgres` no CI.
  await enfileirarOutbox(ctx.empresaId, 'sincronizacao', `pedido:${ctx.pedidoId}:${ctx.evento}`, {
    acao: 'notificacao',
    pedido_id: ctx.pedidoId,
    evento: ctx.evento,
    pedido_externo: ctx.pedidoExterno ?? null,
    checkout_token: ctx.checkoutToken ?? null,
  }, tx);
  log.info('notificacao_evento_registrado', {
    empresa_id: ctx.empresaId, pedido_id: ctx.pedidoId, evento: ctx.evento,
    canais: destinatarios.length, linhas_novas: novas, correlation_id: randomUUID(),
  });
  return novas;
}

/** Envoltório à prova de falha: comunicação NUNCA invalida pedido/pagamento. */
export async function registrarEventoSeguro(contato: ContatoPedido, ctx: ContextoEvento): Promise<void> {
  try {
    await registrarEventoPedido(contato, ctx);
  } catch (e) {
    log.warn('notificacao_evento_nao_registrado', {
      empresa_id: ctx.empresaId, pedido_id: ctx.pedidoId, evento: ctx.evento,
      motivo: e instanceof Error ? e.message.slice(0, 160) : 'falha desconhecida',
    });
  }
}

// ----------------------------------------------------------------------------
// Adapters
// ----------------------------------------------------------------------------

function basePublica(): string {
  return String(process.env.APP_URL || process.env.PUBLIC_BASE_URL || '').trim().replace(/\/+$/, '');
}

/** Template oficial aprovado na Meta, por evento (configurado só no backend). */
function templateWhatsApp(evento: EventoNotificacao): string | null {
  const especifico = process.env[`WHATSAPP_TEMPLATE_${evento}`];
  const geral = process.env.WHATSAPP_TEMPLATE_TRANSACIONAL;
  return (especifico || geral || '').trim() || null;
}

function whatsappConfigurado(): { token: string; phoneId: string; versao: string } | null {
  const token = String(process.env.WHATSAPP_CLOUD_API_TOKEN || '').trim();
  const phoneId = String(process.env.WHATSAPP_PHONE_NUMBER_ID || '').trim();
  if (!token || !phoneId) return null;
  return { token, phoneId, versao: String(process.env.WHATSAPP_API_VERSION || 'v21.0').trim() };
}

// PENDENTE = provedor indisponível/não configurado: NÃO é desfecho terminal.
// A linha volta para a fila com backoff; o pedido continua válido.
type ResultadoAdapter = {
  estado: 'ENVIADO' | 'IGNORADO' | 'PENDENTE';
  erro?: string;
  providerMessageId?: string | null;
  providerStatus?: string | null;
};

async function adapterEmail(row: Row, ctx: Record<string, unknown>): Promise<ResultadoAdapter> {
  if (!smtpConfigurado()) return { estado: 'PENDENTE', erro: 'SMTP não configurado — notificação permanece registrada para retry.' };
  const pedido = escaparHtml(String(ctx.pedido_externo || 'seu pedido'));
  const mensagem = escaparHtml(MENSAGENS[String(row.evento) as EventoNotificacao] ?? 'Atualização do seu pedido.');
  const base = basePublica();
  const token = String(ctx.checkout_token || '');
  const link = base && /^[a-f0-9]{64}$/.test(token) ? `${base}/loja/pedido/${token}` : '';
  const html = corpoEmail([
    `<p style="font-size:17px;font-weight:600;margin:0 0 12px;">${mensagem}</p>`,
    `<p style="margin:0 0 8px;color:#475569;">Pedido <strong>${pedido}</strong>.</p>`,
    link ? blocoLinkEmail(link, 'Acompanhar meu pedido') : '<p style="color:#64748b;font-size:13px;">Acompanhe pelo link recebido no momento da compra.</p>',
    '<p style="margin-top:24px;color:#94a3b8;font-size:12px;">Mensagem transacional automática da loja. Não responda a este e-mail.</p>',
  ]);
  const resultado = await enviarEmail({ to: String(row.destinatario), assunto: `${mensagem.replace(/&amp;/g, '&')} · Pedido ${String(ctx.pedido_externo || '')}`.trim(), html });
  if (resultado !== 'enviado') return { estado: 'PENDENTE', erro: 'Transporte SMTP indisponível no momento.' };
  return { estado: 'ENVIADO', providerStatus: 'SMTP_ACCEPTED' };
}

/**
 * Adapter oficial Meta WhatsApp Business Cloud API.
 * Usa EXCLUSIVAMENTE `template` aprovado (a plataforma exige template para
 * mensagens iniciadas pela empresa fora da janela de 24h). Nunca improvisa
 * texto livre, nunca usa API não oficial e nunca expõe o token.
 */
async function adapterWhatsApp(row: Row, ctx: Record<string, unknown>): Promise<ResultadoAdapter> {
  const cfg = whatsappConfigurado();
  if (!cfg) return { estado: 'PENDENTE', erro: 'WhatsApp Cloud API não configurada (token/phone number id).' };
  const nome = String(row.template || templateWhatsApp(String(row.evento) as EventoNotificacao) || '').trim();
  if (!nome) return { estado: 'PENDENTE', erro: 'Template aprovado não configurado para este evento; nada foi enviado.' };
  try {
    const res = await fetch(`https://graph.facebook.com/${encodeURIComponent(cfg.versao)}/${encodeURIComponent(cfg.phoneId)}/messages`, {
      method: 'POST',
      headers: { authorization: `Bearer ${cfg.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: String(row.destinatario),
        type: 'template',
        template: {
          name: nome,
          language: { code: String(process.env.WHATSAPP_TEMPLATE_IDIOMA || 'pt_BR') },
          components: [{
            type: 'body',
            parameters: [
              { type: 'text', text: String(ctx.pedido_externo || '') },
              { type: 'text', text: MENSAGENS[String(row.evento) as EventoNotificacao] ?? 'Atualização do pedido' },
            ],
          }],
        },
      }),
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const payload = await res.json().catch(() => null) as { messages?: Array<{ id?: unknown }>; message_status?: unknown } | null;
    const messageId = payload?.messages?.[0]?.id;
    if (typeof messageId !== 'string' || !messageId.trim()) {
      throw new Error('Meta aceitou HTTP sem retornar messages[0].id; recibo não confirmado.');
    }
    return {
      estado: 'ENVIADO',
      providerMessageId: messageId,
      // API accepted the request. Delivery/read are confirmed only by a
      // provider status webhook, never inferred from HTTP 200.
      providerStatus: 'REQUEST_ACCEPTED',
    };
  } catch (e) {
    // Só o código/motivo genérico: nunca URL com phone id, token ou destinatário.
    const motivo = e instanceof Error ? e.message.slice(0, 160) : 'falha de rede';
    throw new Error(`WhatsApp Cloud API indisponível (${motivo}).`);
  }
}

// ----------------------------------------------------------------------------
// Orchestrator (consumido pelo outbox)
// ----------------------------------------------------------------------------

export type DesfechoNotificacao = { status: 'processado' | 'retry'; erro?: string };

/**
 * Processa um evento do outbox. Cada linha é independente: um canal com
 * provedor fora do ar não impede o outro. Linhas ENVIADO/IGNORADO jamais são
 * reenviadas (idempotência); PENDENTE/ERRO/PROCESSANDO tentam de novo.
 */
export async function processarEventoNotificacao(payload: Record<string, unknown>): Promise<DesfechoNotificacao> {
  const s = getStore();
  const empresaId = Number(payload.empresa_id);
  const pedidoId = Number(payload.pedido_id);
  const evento = String(payload.evento || '');
  if (!Number.isInteger(empresaId) || empresaId <= 0 || !Number.isInteger(pedidoId) || pedidoId <= 0 || !EVENTOS_NOTIFICACAO.includes(evento as EventoNotificacao)) {
    return { status: 'processado' }; // payload inválido não é retry infinito
  }
  const lista = await s.list(R_NOTIFICACOES(), {
    page: 1, pageSize: 50, filter: { empresa_id: empresaId, pedido_id: pedidoId, evento }, sort: 'id', dir: 'asc',
  });
  const ctx = { pedido_externo: payload.pedido_externo ?? null, checkout_token: payload.checkout_token ?? null };
  let falhas = 0;
  for (const row of lista.rows) {
    const estado = String(row.estado);
    // An atomic claim keeps concurrent outbox workers from sending the same
    // channel twice. A crashed PROCESSANDO lease is recoverable after 10 min.
    if (estado === 'ENVIADO' || estado === 'IGNORADO') continue;
    const staleProcessing = estado === 'PROCESSANDO' &&
      (!row.atualizado_em || Date.now() - Date.parse(String(row.atualizado_em)) > 10 * 60_000);
    if (estado === 'PROCESSANDO' && !staleProcessing) continue;
    if (!['PENDENTE', 'ERRO', 'PROCESSANDO'].includes(estado)) continue;
    const antesTentativas = Number(row.tentativas || 0);
    const claimed = await s.tryUpdateIf(R_NOTIFICACOES(), Number(row.id), {
      empresa_id: empresaId,
      estado,
      tentativas: antesTentativas,
    }, {
      estado: 'PROCESSANDO',
      tentativas: antesTentativas + 1,
      atualizado_em: new Date().toISOString(),
    });
    if (!claimed) continue;
    const tentativas = antesTentativas + 1;
    const canal = String(row.canal);
    try {
      const resultado = canal === 'EMAIL' ? await adapterEmail(row, ctx) : canal === 'WHATSAPP' ? await adapterWhatsApp(row, ctx) : { estado: 'IGNORADO' as const, erro: 'Canal desconhecido.' };
      if (resultado.estado === 'PENDENTE') falhas += 1;
      await s.tryUpdateIf(R_NOTIFICACOES(), Number(row.id), {
        empresa_id: empresaId, estado: 'PROCESSANDO', tentativas,
      }, {
        estado: resultado.estado,
        ultimo_erro: resultado.erro ?? null,
        provider_message_id: resultado.providerMessageId ?? null,
        provider_status: resultado.providerStatus ?? (resultado.estado === 'ENVIADO' ? 'REQUEST_ACCEPTED' : null),
        enviado_em: resultado.estado === 'ENVIADO' ? new Date().toISOString() : null,
        atualizado_em: new Date().toISOString(),
      });
    } catch (e) {
      falhas += 1;
      const mensagem = e instanceof Error ? e.message.slice(0, 300) : 'Falha no provedor de notificação.';
      // A notification failure remains re-drivable. Outbox retry/backoff
      // governs automatic attempts; after exhaustion its administrative
      // re-drive reuses this same idempotent notification row.
      await s.tryUpdateIf(R_NOTIFICACOES(), Number(row.id), {
        empresa_id: empresaId, estado: 'PROCESSANDO', tentativas,
      }, {
        estado: 'PENDENTE', ultimo_erro: mensagem, enviado_em: null,
        provider_status: null, atualizado_em: new Date().toISOString(),
      });
    }
  }
  return falhas ? { status: 'retry', erro: `${falhas} canal(is) aguardando retry.` } : { status: 'processado' };
}
