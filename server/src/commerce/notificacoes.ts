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
import type { Request, Response } from 'express';
import { checkAccess, getStore } from '../services';
import { currentUser } from '../auth';
import { escopoDoAtor } from '../empresa';
import { getResource } from '../resources';
import { enfileirarOutbox } from './outbox';
import { enviarEmail, smtpConfigurado, escaparHtml, corpoEmail, blocoLinkEmail } from '../mail';
import { log } from '../log';
import type { Row, Tx } from '../store';
import { nomesProdutos } from './grade';
import { R_GATEWAY_COBRANCAS } from '../gateway';
import { copiaColaPixValido, ticketUrlPixValida } from '../../../modules/payments/domain/pix-instrument';

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
  'ORDER_EXPIRED',
] as const;

/**
 * Vocabulário de negócio (português, usado na homologação) → constantes
 * persistidas. Mantém UMA única lista canônica (`EVENTOS_NOTIFICACAO`), sem
 * criar um segundo catálogo de eventos nem tabela paralela.
 */
export const MAPA_EVENTOS_HOMOLOGACAO = {
  PEDIDO_CRIADO: 'ORDER_CREATED',
  PIX_GENERATED: 'PIX_GENERATED',
  PAGAMENTO_PENDENTE: 'PAYMENT_PENDING',
  PAGAMENTO_APROVADO: 'PAYMENT_APPROVED',
  PAGAMENTO_RECUSADO: 'PAYMENT_REJECTED',
  PEDIDO_PROCESSANDO: 'ORDER_PROCESSING',
  PEDIDO_ENVIADO: 'ORDER_SHIPPED',
  PEDIDO_ENTREGUE: 'ORDER_DELIVERED',
  PEDIDO_CANCELADO: 'ORDER_CANCELLED',
  PEDIDO_EXPIRADO: 'ORDER_EXPIRED',
} as const satisfies Partial<Record<string, (typeof EVENTOS_NOTIFICACAO)[number]>>;
export type EventoNotificacao = (typeof EVENTOS_NOTIFICACAO)[number];
export type CanalNotificacao = 'EMAIL' | 'WHATSAPP';

/** Sinônimos aceitos na entrada; persistido SEMPRE como a constante canônica. */
export const ALIASES_EVENTO: Record<string, EventoNotificacao> = { PAYMENT_FAILED: 'PAYMENT_REJECTED' };

/**
 * Eventos emitidos JUNTO com um evento principal cujo conteúdo já os cobre.
 * O evento é registrado (rastreabilidade), mas a mensagem não é duplicada:
 * no checkout o cliente recebe UMA mensagem "Pedido recebido" com status
 * "aguardando pagamento" e as instruções do PIX; na aprovação, UMA mensagem
 * "Pagamento confirmado".
 */
export const EVENTOS_CONSOLIDADOS: Partial<Record<EventoNotificacao, EventoNotificacao>> = {
  PAYMENT_PENDING: 'ORDER_CREATED',
  PIX_GENERATED: 'ORDER_CREATED',
  ORDER_PROCESSING: 'PAYMENT_APPROVED',
};

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
  ORDER_EXPIRED: 'O prazo de pagamento terminou e o pedido expirou. Nenhum valor foi cobrado e os itens voltaram para o estoque.',
};

/** Título do e-mail/mensagem por evento (assunto: "BroBond — Pedido #X: <título>"). */
export const TITULOS: Record<EventoNotificacao, string> = {
  ORDER_CREATED: 'Pedido recebido',
  PIX_GENERATED: 'PIX gerado',
  PAYMENT_PENDING: 'Aguardando pagamento',
  PAYMENT_APPROVED: 'Pagamento confirmado',
  PAYMENT_REJECTED: 'Pagamento não aprovado',
  ORDER_PROCESSING: 'Pedido em preparação',
  ORDER_SHIPPED: 'Pedido enviado',
  ORDER_DELIVERED: 'Pedido entregue',
  ORDER_CANCELLED: 'Pedido cancelado',
  ORDER_EXPIRED: 'Pedido expirado',
};

const NOME_LOJA = () => String(process.env.COMMERCE_STORE_NAME || 'BroBond').trim() || 'BroBond';

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
  ctxBruto: ContextoEvento,
  tx?: Tx
): Promise<number> {
  const ctx: ContextoEvento = { ...ctxBruto, evento: (ALIASES_EVENTO[String(ctxBruto.evento)] ?? ctxBruto.evento) as EventoNotificacao };
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
  const principal = EVENTOS_CONSOLIDADOS[ctx.evento];

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
        // Consolidado: registrado para rastreabilidade, sem segunda mensagem.
        estado: principal ? 'IGNORADO' : 'PENDENTE',
        tentativas: 0,
        ultimo_erro: principal ? `Consolidado na mensagem '${TITULOS[principal]}' (${principal}); nenhuma mensagem duplicada.` : null,
        provider_status: principal ? 'CONSOLIDADO' : null,
        chave_idempotencia: chave,
        criado_em: agora,
        atualizado_em: agora,
        enviado_em: null,
      },
      tx
    );
    novas += 1;
  }
  if (principal) {
    log.info('notificacao_evento_consolidado', { empresa_id: ctx.empresaId, pedido_id: ctx.pedidoId, evento: ctx.evento, principal });
    return novas;
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
// Configuração dos canais (status honesto, só NOMES de variáveis)
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

const vazio = (nome: string) => !String(process.env[nome] ?? '').trim();
const EVENTOS_COM_MENSAGEM = EVENTOS_NOTIFICACAO.filter((e) => !EVENTOS_CONSOLIDADOS[e]);

export type StatusConfiguracaoCanal = 'CONFIGURADO' | 'NAO_CONFIGURADO';
export type StatusCanal = StatusConfiguracaoCanal | 'CONECTADO' | 'ERRO';

const VARIAVEIS_MODELOS = [
  'WHATSAPP_TEMPLATE_ORDER_CREATED',
  'WHATSAPP_TEMPLATE_PAYMENT_APPROVED',
  'WHATSAPP_TEMPLATE_TRANSACIONAL',
] as const;

/**
 * Diagnóstico LOCAL e somente leitura: nenhuma conexão SMTP/Meta é aberta.
 * `status_configuracao` não se confunde com o histórico de tentativas retornado
 * por `situacaoCanaisNotificacao`. Preserva os campos legados e acrescenta
 * presenças booleanas e NOMES de variáveis, nunca credenciais ou seus valores.
 * A única informação textual do ambiente é o código de idioma, validado antes
 * da exposição (uma configuração inválida não pode virar um segredo na UI).
 */
export function statusCanaisNotificacao() {
  const faltandoEmail = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS'].filter(vazio);
  const faltandoWhats = ['WHATSAPP_CLOUD_API_TOKEN', 'WHATSAPP_PHONE_NUMBER_ID'].filter(vazio);
  const templates = Object.fromEntries(EVENTOS_COM_MENSAGEM.map((e) => [e, !!templateWhatsApp(e)])) as Record<string, boolean>;
  const semTemplate = EVENTOS_COM_MENSAGEM.filter((e) => !templates[e]);
  const statusEmail: StatusConfiguracaoCanal = faltandoEmail.length ? 'NAO_CONFIGURADO' : 'CONFIGURADO';
  const statusWhats: StatusConfiguracaoCanal = faltandoWhats.length || semTemplate.length === EVENTOS_COM_MENSAGEM.length ? 'NAO_CONFIGURADO' : 'CONFIGURADO';
  const statusLink: StatusConfiguracaoCanal = basePublica() ? 'CONFIGURADO' : 'NAO_CONFIGURADO';
  // Mesmo padrão/default do adapter, sem alterar a resolução usada nos envios.
  const idioma = String(process.env.WHATSAPP_TEMPLATE_IDIOMA || 'pt_BR');
  return {
    email: {
      status: statusEmail as StatusCanal,
      status_configuracao: statusEmail,
      smtp_configurado: faltandoEmail.length === 0,
      faltando: faltandoEmail,
      variaveis_ausentes: [...faltandoEmail, ...(vazio('SMTP_FROM') ? ['SMTP_FROM'] : [])],
      remetente_dedicado: !vazio('SMTP_FROM'),
    },
    whatsapp: {
      status: statusWhats as StatusCanal,
      status_configuracao: statusWhats,
      token_configurado: !vazio('WHATSAPP_CLOUD_API_TOKEN'),
      phone_number_id_configurado: !vazio('WHATSAPP_PHONE_NUMBER_ID'),
      faltando: [
        ...faltandoWhats,
        ...(semTemplate.length === EVENTOS_COM_MENSAGEM.length ? ['WHATSAPP_TEMPLATE_TRANSACIONAL (ou WHATSAPP_TEMPLATE_<EVENTO>)'] : []),
      ],
      variaveis_ausentes: [...faltandoWhats, ...VARIAVEIS_MODELOS.filter(vazio), ...(vazio('WHATSAPP_TEMPLATE_IDIOMA') ? ['WHATSAPP_TEMPLATE_IDIOMA'] : [])],
      modelos_configurados: Object.fromEntries(VARIAVEIS_MODELOS.map((nome) => [nome, !vazio(nome)])),
      idioma: /^[a-z]{2,3}(?:_[A-Z]{2})?$/.test(idioma) ? idioma : null,
      idioma_configurado: !vazio('WHATSAPP_TEMPLATE_IDIOMA'),
      templates,
      eventos_sem_template: semTemplate,
    },
    link_publico: {
      status: statusLink as StatusCanal,
      status_configuracao: statusLink,
      faltando: basePublica() ? [] : ['APP_URL (ou PUBLIC_BASE_URL)'],
      variaveis_ausentes: basePublica() ? [] : ['APP_URL', 'PUBLIC_BASE_URL'],
    },
  };
}

function motivoNaoConfigurado(canal: CanalNotificacao, evento: EventoNotificacao): string | null {
  const st = statusCanaisNotificacao();
  if (canal === 'EMAIL' && st.email.faltando.length) return `NÃO CONFIGURADO: defina ${st.email.faltando.join(', ')} para enviar e-mails.`;
  if (canal === 'WHATSAPP') {
    if (st.whatsapp.faltando.length && !whatsappConfigurado()) return `NÃO CONFIGURADO: defina ${st.whatsapp.faltando.join(', ')} (Meta WhatsApp Cloud API).`;
    if (!templateWhatsApp(evento)) return `NÃO CONFIGURADO: template aprovado ausente — defina WHATSAPP_TEMPLATE_${evento} ou WHATSAPP_TEMPLATE_TRANSACIONAL.`;
  }
  return null;
}

// ----------------------------------------------------------------------------
// Conteúdo — dados REAIS do pedido, lidos UMA vez por evento
// ----------------------------------------------------------------------------

export type DadosPedidoNotificacao = {
  numero: string;
  nome: string | null;
  itens: { nome: string; tamanho: string | null; quantidade: number; subtotal: number }[];
  frete: number;
  desconto: number;
  total: number | null;
  metodo: string;
  estado: string | null;
  link: string | null;
  pix: { copiaCola: string | null; ticketUrl: string | null; expiraEm: string | null } | null;
};

const ROTULO_METODO: Record<string, string> = { pix: 'PIX', PIX: 'PIX', boleto: 'Boleto', cartao_credito: 'Cartão de crédito', cartao_debito: 'Cartão de débito' };
const ROTULO_STATUS: Record<string, string> = {
  AGUARDANDO_PAGAMENTO: 'aguardando confirmação do pagamento',
  PAGAMENTO_AUTORIZADO: 'pagamento autorizado',
  PAGO: 'pagamento confirmado',
  AGUARDANDO_CORRECAO: 'pagamento confirmado — em preparação',
  CONVERTIDO: 'pagamento confirmado — em preparação',
  CANCELADO: 'pedido cancelado',
  EXPIRADO: 'pedido expirado',
  ESTORNADO: 'pagamento estornado',
  ERRO: 'pedido não confirmado',
};
/** Status exibido por evento (o evento manda: a linha pode ser lida depois). */
const STATUS_DO_EVENTO: Partial<Record<EventoNotificacao, string>> = {
  ORDER_CREATED: 'aguardando confirmação do pagamento',
  PAYMENT_PENDING: 'aguardando confirmação do pagamento',
  PIX_GENERATED: 'aguardando confirmação do pagamento',
  PAYMENT_APPROVED: 'pagamento confirmado',
  PAYMENT_REJECTED: 'pagamento não aprovado',
  ORDER_PROCESSING: 'em preparação',
  ORDER_SHIPPED: 'enviado',
  ORDER_DELIVERED: 'entregue',
  ORDER_CANCELLED: 'pedido cancelado',
  ORDER_EXPIRED: 'pedido expirado',
};

const brl = (v: number) => v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

function linkDoPedido(token: unknown): string | null {
  const base = basePublica();
  const t = String(token || '').toLowerCase();
  return base && /^[a-f0-9]{64}$/.test(t) ? `${base}/loja/pedido/${t}` : null;
}

/** Lê pedido, itens (com nomes) e instrumentos PIX UMA vez por evento. */
export async function carregarDadosPedido(empresaId: number, pedidoId: number, payload: Record<string, unknown> = {}): Promise<DadosPedidoNotificacao> {
  const s = getStore();
  const pedido = await s.findOneWhere(getResource('commerce_pedidos')!, { empresa_id: empresaId, id: pedidoId });
  const numero = String(pedido?.pedido_externo || payload.pedido_externo || pedidoId);
  const link = linkDoPedido(pedido?.checkout_token || payload.checkout_token);
  if (!pedido) return { numero, nome: null, itens: [], frete: 0, desconto: 0, total: null, metodo: 'PIX', estado: null, link, pix: null };
  const comprador = (pedido.comprador && typeof pedido.comprador === 'object' ? pedido.comprador : {}) as Record<string, unknown>;
  const itensBrutos = pedido.sale_id
    ? (await s.list(getResource('sale_items')!, { page: 1, pageSize: 100, filter: { sale_id: String(pedido.sale_id) } })).rows
    : [];
  const nomes = await nomesProdutos(empresaId, itensBrutos.map((i) => Number(i.product_id || 0)).filter(Boolean));
  const tamanhos = new Map<number, string>();
  for (const id of [...new Set(itensBrutos.map((i) => Number(i.size_id || 0)).filter(Boolean))]) {
    const t = await s.findOneWhere(getResource('tamanhos')!, { id });
    if (t) tamanhos.set(id, String(t.codigo || ''));
  }
  const cobranca = pedido.cobranca_id ? await s.findOneWhere(R_GATEWAY_COBRANCAS, { empresa_id: empresaId, id: Number(pedido.cobranca_id) }) : null;
  const metodo = ROTULO_METODO[String(cobranca?.metodo || 'pix')] ?? 'PIX';
  const copia = copiaColaPixValido(cobranca?.copia_cola) ? String(cobranca!.copia_cola).trim() : copiaColaPixValido(cobranca?.qr_code) ? String(cobranca!.qr_code).trim() : null;
  const ticket = ticketUrlPixValida(cobranca?.ticket_url) ? String(cobranca!.ticket_url).trim() : null;
  return {
    numero,
    nome: comprador.nome ? String(comprador.nome).trim().split(/\s+/)[0] || null : null,
    itens: itensBrutos.map((i) => ({
      nome: nomes.get(Number(i.product_id || 0)) ?? 'Produto',
      tamanho: i.size_id ? tamanhos.get(Number(i.size_id)) ?? null : i.variacao_externa ? String(i.variacao_externa) : null,
      quantidade: Number(i.quantity || 0),
      subtotal: Number(i.subtotal_cents ?? Number(i.quantity || 0) * Number(i.unit_price_cents || 0)) / 100,
    })),
    frete: Number(pedido.frete_valor || 0),
    desconto: Number(pedido.desconto || 0),
    total: pedido.total != null ? Number(pedido.total) : null,
    metodo,
    estado: pedido.estado ? String(pedido.estado) : null,
    link,
    pix: metodo === 'PIX' && (copia || ticket)
      ? { copiaCola: copia, ticketUrl: ticket, expiraEm: cobranca?.expires_em ? String(cobranca.expires_em) : pedido.expira_em ? String(pedido.expira_em) : null }
      : null,
  };
}

function statusParaCliente(evento: EventoNotificacao, d: DadosPedidoNotificacao): string {
  return STATUS_DO_EVENTO[evento] ?? (d.estado ? ROTULO_STATUS[d.estado] ?? d.estado.toLowerCase() : 'atualizado');
}

/**
 * E-mail transacional do pedido. Assunto "BroBond — Pedido #X recebido" (ou
 * "BroBond — Pedido #X: <título>"). Corpo com nome, número, itens, total,
 * método, status, link seguro e — quando aguardando PIX — as instruções com o
 * Copia e Cola REAL devolvido pelo provedor. Nunca CPF, nunca token interno,
 * nunca imagem de QR fabricada.
 */
export function montarEmailPedido(evento: EventoNotificacao, d: DadosPedidoNotificacao): { assunto: string; html: string } {
  const loja = NOME_LOJA();
  const titulo = TITULOS[evento];
  const assunto = evento === 'ORDER_CREATED' ? `${loja} — Pedido #${d.numero} recebido` : `${loja} — Pedido #${d.numero}: ${titulo}`;
  const aguardandoPix = ['ORDER_CREATED', 'PAYMENT_PENDING', 'PIX_GENERATED'].includes(evento) && !!d.pix && (!d.estado || d.estado === 'AGUARDANDO_PAGAMENTO');
  const linhasItens = d.itens.map((i) =>
    `<tr><td style="padding:4px 0;">${escaparHtml(i.nome)}${i.tamanho ? ` <span style="color:#64748b;">(${escaparHtml(i.tamanho)})</span>` : ''} × ${i.quantidade}</td><td style="padding:4px 0;text-align:right;white-space:nowrap;">${escaparHtml(brl(i.subtotal))}</td></tr>`
  ).join('');
  const html = corpoEmail([
    `<p style="font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:#64748b;margin:0 0 4px;">${escaparHtml(loja)}</p>`,
    `<p style="font-size:20px;font-weight:700;margin:0 0 12px;">${escaparHtml(titulo)}</p>`,
    `<p style="margin:0 0 12px;">Olá${d.nome ? `, ${escaparHtml(d.nome)}` : ''}! ${escaparHtml(MENSAGENS[evento])}</p>`,
    `<p style="margin:0 0 4px;"><strong>Pedido:</strong> #${escaparHtml(d.numero)}</p>`,
    d.itens.length ? `<table style="width:100%;border-collapse:collapse;margin:12px 0;font-size:14px;">${linhasItens}</table>` : '',
    d.frete > 0 ? `<p style="margin:0;">Frete: ${escaparHtml(brl(d.frete))}</p>` : '',
    d.desconto > 0 ? `<p style="margin:0;">Desconto: −${escaparHtml(brl(d.desconto))}</p>` : '',
    d.total != null ? `<p style="margin:4px 0;"><strong>Total:</strong> ${escaparHtml(brl(d.total))}</p>` : '',
    `<p style="margin:4px 0;"><strong>Pagamento:</strong> ${escaparHtml(d.metodo)}</p>`,
    `<p style="margin:4px 0 16px;"><strong>Status:</strong> ${escaparHtml(statusParaCliente(evento, d))}</p>`,
    aguardandoPix
      ? [
          '<div style="border:1px solid #e2e8f0;border-radius:8px;padding:12px 16px;margin:0 0 16px;">',
          '<p style="margin:0 0 8px;font-weight:600;">Como pagar com PIX</p>',
          '<p style="margin:0 0 8px;">Abra a página do pedido para escanear o QR Code no aplicativo do seu banco, ou copie o código PIX Copia e Cola abaixo e cole na área PIX do app.</p>',
          d.pix!.copiaCola ? `<p style="margin:0 0 8px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;word-break:break-all;background:#f8fafc;padding:8px;border-radius:6px;">${escaparHtml(d.pix!.copiaCola)}</p>` : '',
          d.pix!.ticketUrl ? blocoLinkEmail(d.pix!.ticketUrl, 'Abrir pagamento do Mercado Pago') : '',
          d.pix!.expiraEm ? `<p style="margin:0;color:#64748b;font-size:13px;">Pague até ${escaparHtml(new Date(d.pix!.expiraEm).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }))}. O pedido é confirmado automaticamente após a aprovação do pagamento.</p>` : '<p style="margin:0;color:#64748b;font-size:13px;">O pedido é confirmado automaticamente após a aprovação do pagamento.</p>',
          '</div>',
        ].join('')
      : '',
    d.link ? blocoLinkEmail(d.link, 'Acompanhar meu pedido') : '<p style="color:#64748b;font-size:13px;">Acompanhe pelo link recebido no momento da compra.</p>',
    '<p style="margin-top:24px;color:#94a3b8;font-size:12px;">Mensagem transacional automática da loja. Não responda a este e-mail.</p>',
  ]);
  return { assunto, html };
}

/**
 * Parâmetros do template oficial do WhatsApp (5, nesta ordem):
 *   {{1}} número do pedido · {{2}} valor · {{3}} método · {{4}} status · {{5}} link
 * Os textos dos templates (aprovados na Meta) estão em docs/STOREFRONT-ENTERPRISE.md.
 */
export function parametrosWhatsApp(evento: EventoNotificacao, d: DadosPedidoNotificacao): string[] {
  return [
    d.numero,
    d.total != null ? brl(d.total) : '-',
    d.metodo,
    statusParaCliente(evento, d),
    d.link ?? 'link enviado no e-mail do pedido',
  ].map((v) => String(v).replace(/\s+/g, ' ').trim().slice(0, 900) || '-');
}

// ----------------------------------------------------------------------------
// Adapters
// ----------------------------------------------------------------------------

// PENDENTE = provedor indisponível/não configurado: NÃO é desfecho terminal.
// A linha volta para a fila com backoff; o pedido continua válido.
// `provider_status = 'NAO_CONFIGURADO'` distingue "falta configuração" de
// "provedor fora do ar" — e jamais é exibido como ENVIADO.
type ResultadoAdapter = {
  estado: 'ENVIADO' | 'IGNORADO' | 'PENDENTE';
  erro?: string;
  providerMessageId?: string | null;
  providerStatus?: string | null;
};

async function adapterEmail(row: Row, dados: DadosPedidoNotificacao): Promise<ResultadoAdapter> {
  const evento = String(row.evento) as EventoNotificacao;
  const naoConfigurado = motivoNaoConfigurado('EMAIL', evento);
  if (naoConfigurado || !smtpConfigurado()) return { estado: 'PENDENTE', erro: naoConfigurado ?? 'NÃO CONFIGURADO: SMTP incompleto.', providerStatus: 'NAO_CONFIGURADO' };
  const { assunto, html } = montarEmailPedido(evento, dados);
  const resultado = await enviarEmail({ to: String(row.destinatario), assunto, html });
  if (resultado !== 'enviado') return { estado: 'PENDENTE', erro: 'Transporte SMTP indisponível no momento; nova tentativa agendada.' };
  return { estado: 'ENVIADO', providerStatus: 'SMTP_ACCEPTED' };
}

/**
 * Adapter oficial Meta WhatsApp Business Cloud API.
 * Usa EXCLUSIVAMENTE `template` aprovado (a plataforma exige template para
 * mensagens iniciadas pela empresa fora da janela de 24h). Nunca improvisa
 * texto livre, nunca usa API não oficial e nunca expõe o token.
 */
async function adapterWhatsApp(row: Row, dados: DadosPedidoNotificacao): Promise<ResultadoAdapter> {
  const evento = String(row.evento) as EventoNotificacao;
  const cfg = whatsappConfigurado();
  const nome = String(row.template || templateWhatsApp(evento) || '').trim();
  if (!cfg || !nome) {
    return { estado: 'PENDENTE', erro: motivoNaoConfigurado('WHATSAPP', evento) ?? 'NÃO CONFIGURADO: WhatsApp Cloud API incompleta.', providerStatus: 'NAO_CONFIGURADO' };
  }
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
            parameters: parametrosWhatsApp(evento, dados).map((text) => ({ type: 'text', text })),
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
 * Os dados do pedido são lidos UMA vez por evento e compartilhados pelos canais.
 */
export async function processarEventoNotificacao(payload: Record<string, unknown>): Promise<DesfechoNotificacao> {
  const s = getStore();
  const empresaId = Number(payload.empresa_id);
  const pedidoId = Number(payload.pedido_id);
  const evento = String(ALIASES_EVENTO[String(payload.evento || '')] ?? payload.evento ?? '');
  if (!Number.isInteger(empresaId) || empresaId <= 0 || !Number.isInteger(pedidoId) || pedidoId <= 0 || !EVENTOS_NOTIFICACAO.includes(evento as EventoNotificacao)) {
    return { status: 'processado' }; // payload inválido não é retry infinito
  }
  const lista = await s.list(R_NOTIFICACOES(), {
    page: 1, pageSize: 50, filter: { empresa_id: empresaId, pedido_id: pedidoId, evento }, sort: 'id', dir: 'asc',
  });
  let dados: DadosPedidoNotificacao | null = null;
  const dadosDoPedido = async () => (dados ??= await carregarDadosPedido(empresaId, pedidoId, payload));
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
      const resultado = canal === 'EMAIL' ? await adapterEmail(row, await dadosDoPedido())
        : canal === 'WHATSAPP' ? await adapterWhatsApp(row, await dadosDoPedido())
          : { estado: 'IGNORADO' as const, erro: 'Canal desconhecido.' };
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

/**
 * Situação real de cada canal = configuração + evidência mais recente:
 *   NAO_CONFIGURADO (variável obrigatória ausente) · CONECTADO (o provedor
 *   ACEITOU o último envio) · ERRO (configurado, mas o último envio falhou no
 *   provedor) · CONFIGURADO (configurado, ainda sem envio para comprovar).
 */
export async function situacaoCanaisNotificacao(empresaId: number) {
  const s = getStore();
  const config = statusCanaisNotificacao();
  const recentes = (await s.list(R_NOTIFICACOES(), { page: 1, pageSize: 100, sort: 'id', dir: 'desc', filter: { empresa_id: empresaId } })).rows
    .filter((r) => String(r.estado) !== 'IGNORADO' && Number(r.tentativas || 0) > 0 && String(r.provider_status || '') !== 'NAO_CONFIGURADO');
  const evidencia = (canal: CanalNotificacao, base: StatusCanal): { status: StatusCanal; ultimo_envio_em: string | null; ultimo_erro: string | null } => {
    const ultima = recentes.find((r) => String(r.canal) === canal);
    if (base === 'NAO_CONFIGURADO' || !ultima) return { status: base, ultimo_envio_em: null, ultimo_erro: null };
    if (String(ultima.estado) === 'ENVIADO') {
      const enviadoEm = new Date(String(ultima.enviado_em || ''));
      return { status: 'CONECTADO', ultimo_envio_em: Number.isFinite(enviadoEm.getTime()) ? enviadoEm.toISOString() : null, ultimo_erro: null };
    }
    // Erros persistidos/provindos do provedor podem conter credenciais, URLs
    // privadas ou dados de pedidos. Diagnóstico não é um endpoint de logs:
    // devolve somente um resumo fixo, sem copiar o texto bruto para a resposta.
    return { status: 'ERRO', ultimo_envio_em: null, ultimo_erro: 'A última tentativa de envio não foi concluída pelo provedor.' };
  };
  return {
    email: { ...config.email, ...evidencia('EMAIL', config.email.status) },
    whatsapp: { ...config.whatsapp, ...evidencia('WHATSAPP', config.whatsapp.status) },
    link_publico: config.link_publico,
  };
}

/** GET /api/commerce/notificacoes/status — situação dos canais (sem segredos). */
export async function statusNotificacoesCommerce(req: Request, res: Response) {
  const actor = currentUser(req);
  const escopo = escopoDoAtor(actor);
  checkAccess(R_NOTIFICACOES(), actor, 'read');
  const canais = await situacaoCanaisNotificacao(escopo.empresaId);
  res.setHeader('Cache-Control', 'no-store');
  res.json({ ok: true, ...canais, consultado_em: new Date().toISOString() });
}
