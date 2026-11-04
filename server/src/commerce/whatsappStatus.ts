// P1-05 — webhook de status do WhatsApp Cloud API (sent / delivered / read / failed).
//
// Regras de segurança:
//  • fail-closed: sem segredo de app autorizado, GET responde 403 e POST responde 401;
//  • POST só é aceito com `x-hub-signature-256` (HMAC-SHA256 do corpo bruto) válido;
//  • o segredo NÃO é lido de variável nova: `segredoAppWhatsApp()` devolve null até a
//    decisão (d) do Diretor autorizar a fonte do segredo. Enquanto isso o endpoint recusa tudo.
//
// Regras de estado: a entrega só avança (REQUEST_ACCEPTED < SENT < DELIVERED < READ);
// FAILED é terminal e não sobrescreve DELIVERED nem READ; evento atrasado é ignorado.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { Router, raw, type Request, type Response } from 'express';
import { getResource } from '../resources';
import { getStore } from '../services';

export type StatusEntregaWhatsApp = 'sent' | 'delivered' | 'read' | 'failed';

export interface EventoStatusWhatsApp {
  messageId: string;
  status: StatusEntregaWhatsApp;
  /** Código e título genéricos do provedor, sem telefone nem conteúdo da mensagem. */
  erro?: string;
}

/** Posição de cada estado persistido. FAILED não entra: é tratado à parte. */
const ORDEM_PERSISTIDA: Record<string, number> = { REQUEST_ACCEPTED: 0, SENT: 1, DELIVERED: 2, READ: 3 };
const ORDEM_EVENTO: Record<Exclude<StatusEntregaWhatsApp, 'failed'>, number> = { sent: 1, delivered: 2, read: 3 };

/** Segredo do app Meta para validar assinaturas. Null = não autorizado (fail-closed). */
export function segredoAppWhatsApp(): string | null {
  return null;
}

/** Token do desafio de verificação (GET). Null = não autorizado (fail-closed). */
export function segredoVerificacaoWhatsApp(): string | null {
  return null;
}

function iguaisSeguro(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

/** Valida `sha256=<hex>` contra o HMAC do corpo bruto, em tempo constante. */
export function assinaturaWhatsAppValida(corpo: Buffer, cabecalho: string | undefined, segredo: string): boolean {
  if (!cabecalho || !cabecalho.startsWith('sha256=')) return false;
  const recebida = Buffer.from(cabecalho.slice('sha256='.length).trim(), 'hex');
  const esperada = createHmac('sha256', segredo).update(corpo).digest();
  return recebida.length === esperada.length && timingSafeEqual(recebida, esperada);
}

/** Desafio de inscrição do webhook (GET). Devolve o challenge só com token idêntico. */
export function responderDesafioWhatsApp(query: Record<string, unknown>, tokenEsperado: string | null): string | null {
  if (!tokenEsperado) return null;
  if (query['hub.mode'] !== 'subscribe') return null;
  const token = query['hub.verify_token'];
  if (typeof token !== 'string' || !iguaisSeguro(token, tokenEsperado)) return null;
  const desafio = query['hub.challenge'];
  return typeof desafio === 'string' && desafio.length > 0 ? desafio : null;
}

const STATUS_ACEITOS = new Set<string>(['sent', 'delivered', 'read', 'failed']);

/** Extrai só os campos de status. Telefone do destinatário e corpo da mensagem são descartados. */
export function extrairEventosStatusWhatsApp(corpo: unknown): EventoStatusWhatsApp[] {
  const eventos: EventoStatusWhatsApp[] = [];
  const entradas = (corpo as { entry?: unknown } | null)?.entry;
  if (!Array.isArray(entradas)) return eventos;
  for (const entrada of entradas) {
    const mudancas = (entrada as { changes?: unknown } | null)?.changes;
    if (!Array.isArray(mudancas)) continue;
    for (const mudanca of mudancas) {
      const statuses = (mudanca as { value?: { statuses?: unknown } } | null)?.value?.statuses;
      if (!Array.isArray(statuses)) continue;
      for (const st of statuses as Array<Record<string, unknown>>) {
        const messageId = typeof st?.id === 'string' ? st.id.trim() : '';
        const status = typeof st?.status === 'string' ? st.status : '';
        if (!messageId || !STATUS_ACEITOS.has(status)) continue;
        const primeiroErro = Array.isArray(st.errors) ? (st.errors[0] as Record<string, unknown> | undefined) : undefined;
        const evento: EventoStatusWhatsApp = { messageId, status: status as StatusEntregaWhatsApp };
        if (status === 'failed') {
          const codigo = primeiroErro?.code != null ? String(primeiroErro.code).slice(0, 20) : 'sem código';
          const titulo = typeof primeiroErro?.title === 'string' ? primeiroErro.title.slice(0, 160) : 'falha reportada pelo provedor';
          evento.erro = `Meta: ${titulo} (código ${codigo})`;
        }
        eventos.push(evento);
      }
    }
  }
  return eventos;
}

/** Decide se o evento muda o estado persistido. Função pura. */
export function decidirTransicaoWhatsApp(atual: string | null | undefined, evento: StatusEntregaWhatsApp): 'aplicar' | 'ignorar' {
  const persistido = String(atual ?? '').toUpperCase();
  if (persistido === 'FAILED') return 'ignorar';
  const posicaoAtual = ORDEM_PERSISTIDA[persistido] ?? -1;
  if (evento === 'failed') return posicaoAtual >= ORDEM_PERSISTIDA.DELIVERED ? 'ignorar' : 'aplicar';
  return ORDEM_EVENTO[evento] > posicaoAtual ? 'aplicar' : 'ignorar';
}

export type ResultadoEventoWhatsApp = 'aplicado' | 'sem_alteracao' | 'desconhecida';

/**
 * Aplica um evento à notificação de mesmo `provider_message_id` (o wamid gravado no envio).
 * A escrita é condicionada ao estado lido (`tryUpdateIf`): dois eventos simultâneos não se sobrescrevem.
 */
export async function aplicarEventoStatusWhatsApp(evento: EventoStatusWhatsApp): Promise<ResultadoEventoWhatsApp> {
  const s = getStore();
  const R = getResource('commerce_notificacoes')!;
  const linha = await s.findOneWhere(R, { provider_message_id: evento.messageId });
  if (!linha) return 'desconhecida';
  const atual = (linha.provider_status as string | null) ?? null;
  if (decidirTransicaoWhatsApp(atual, evento.status) === 'ignorar') return 'sem_alteracao';
  const patch: Record<string, unknown> = {
    provider_status: evento.status === 'failed' ? 'FAILED' : evento.status.toUpperCase(),
  };
  if (evento.status === 'failed') patch.ultimo_erro = evento.erro ?? 'Falha reportada pelo provedor.';
  const atualizada = await s.tryUpdateIf(R, Number(linha.id), { provider_status: atual }, patch);
  return atualizada ? 'aplicado' : 'sem_alteracao';
}

export interface DependenciasWebhookWhatsApp {
  segredoApp(): string | null;
  segredoVerificacao(): string | null;
  aplicar(evento: EventoStatusWhatsApp): Promise<ResultadoEventoWhatsApp>;
}

const DEPENDENCIAS_PRODUCAO: DependenciasWebhookWhatsApp = {
  segredoApp: segredoAppWhatsApp,
  segredoVerificacao: segredoVerificacaoWhatsApp,
  aplicar: aplicarEventoStatusWhatsApp,
};

/** Router do webhook. Deve ser montado ANTES de `/api/webhooks/:provider` e do express.json. */
export function criarRouterWebhookStatusWhatsApp(deps: DependenciasWebhookWhatsApp = DEPENDENCIAS_PRODUCAO): Router {
  const router = Router();

  router.get('/api/webhooks/whatsapp', (req: Request, res: Response) => {
    const desafio = responderDesafioWhatsApp(req.query as Record<string, unknown>, deps.segredoVerificacao());
    if (desafio === null) {
      res.sendStatus(403);
      return;
    }
    res.type('text/plain').send(desafio);
  });

  router.post('/api/webhooks/whatsapp', raw({ type: '*/*', limit: '256kb' }), async (req: Request, res: Response) => {
    const segredo = deps.segredoApp();
    const corpo = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (!segredo || !assinaturaWhatsAppValida(corpo, req.get('x-hub-signature-256'), segredo)) {
      res.status(401).json({ error: 'Assinatura inválida.' });
      return;
    }
    let json: unknown;
    try {
      json = JSON.parse(corpo.toString('utf8'));
    } catch {
      res.status(400).json({ error: 'Corpo inválido.' });
      return;
    }
    try {
      for (const evento of extrairEventosStatusWhatsApp(json)) await deps.aplicar(evento);
      // 200 só depois de gravar: falha de banco vira 500 e a Meta reentrega.
      res.sendStatus(200);
    } catch {
      res.sendStatus(500);
    }
  });

  return router;
}
