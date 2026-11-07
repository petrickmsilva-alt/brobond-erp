// ============================================================================
// MOTOR DE FRETE › APLICAÇÃO › JOBS (WORKER DO OUTBOX)
//
// As ações logísticas assíncronas rodam no worker do `commerce_outbox` de
// sempre (claim CAS, retry com backoff, dead-letter). Aqui ficam os
// processadores:
//
//   • logistics-webhook      — processa a entrega do inbox (rastreio);
//   • logistics-rastreio     — polling de um envio específico;
//   • logistics-woo-tracking — publica o rastreio na loja de origem;
//   • logistics-reconciliar  — reconciliação (lote).
//
// O processamento é IDEMPOTENTE: reprocessar a mesma entrega não duplica
// eventos (dedupe por evento) nem duplica a publicação na loja (chave única).
// ============================================================================
import { getStore } from '../../../server/src/services';
import { getResource } from '../../../server/src/resources';
import { carrier, CARRIER_NULO } from '../providers/contract';
import { aplicarEventosRastreio, sincronizarRastreio } from './tracking';
import { publicarRastreioLoja } from '../integration/woocommerce';
import { reconciliarEmpresa } from './reconciliation';
import { entregaPorId, marcarProcessamento } from '../infrastructure/webhookInbox';
import type { EventoRastreioBruto } from '../providers/contract';

const R_ENVIO = () => getResource('envios')!;

/** Desfecho compatível com `processarEntrada` do outbox. */
export type Desfecho = { status: 'processado' | 'retry' | 'erro'; erro?: string };

/**
 * Extrai eventos de rastreio de um payload de webhook de transportadora.
 * Formato defensivo: aceita lista em `events`/`tracking`/raiz, ou um evento
 * único. NUNCA inventa dados: campo ausente fica nulo.
 */
export function eventosDoPayload(payload: Record<string, unknown>): { codigo: string | null; eventos: EventoRastreioBruto[] } {
  const codigo = String(payload.tracking_number ?? payload.codigo ?? payload.code ?? payload.tracking ?? '').trim() || null;
  const b = payload as Record<string, unknown>;
  const listaBruta = Array.isArray(payload)
    ? (payload as unknown[])
    : Array.isArray(b.events)
      ? (b.events as unknown[])
      : Array.isArray(b.tracking_events)
        ? (b.tracking_events as unknown[])
        : b.status || b.evento
          ? [payload]
          : [];
  const eventos: EventoRastreioBruto[] = listaBruta.map((e) => {
    const r = (e ?? {}) as Record<string, unknown>;
    const quando = r.data ?? r.date ?? r.created_at ?? r.timestamp ?? payload.timestamp;
    return {
      codigo: String(r.codigo ?? r.code ?? codigo ?? ''),
      status: String(r.status ?? r.descricao ?? r.description ?? r.event ?? ''),
      mensagem: String(r.mensagem ?? r.message ?? r.description ?? r.descricao ?? ''),
      local: r.local ? String(r.local) : r.location ? String(r.location) : null,
      em: quando ? String(quando) : null,
      bruto: e,
    };
  });
  return { codigo, eventos };
}

/**
 * Ponto de entrada chamado pelo outbox. `storeKeyArg` vem de `row.store_key`
 * quando o evento é por loja (o payload também carrega `store_key`).
 */
export async function processarAcaoLogistica(acao: string, payload: Record<string, unknown>, empresaId: number, _storeKeyArg: number | null): Promise<Desfecho> {
  const s = getStore();

  if (acao === 'logistics-webhook') {
    const inboxId = Number(payload.inbox_id);
    if (!Number.isInteger(inboxId) || inboxId <= 0) return { status: 'erro', erro: 'Evento de webhook sem inbox_id.' };
    const entrega = await entregaPorId(empresaId, inboxId);
    if (!entrega) return { status: 'erro', erro: 'Entrega de webhook não encontrada na empresa do evento.' };
    if (String(entrega.assinatura_ok) === 'false' || entrega.assinatura_ok === false) {
      await marcarProcessamento(empresaId, inboxId, { status: 'erro', erro: 'Entrega com assinatura inválida.' });
      return { status: 'erro', erro: 'Entrega com assinatura inválida.' };
    }

    const body = (entrega.payload && typeof entrega.payload === 'object' ? entrega.payload : {}) as Record<string, unknown>;
    const { codigo, eventos } = eventosDoPayload(body);
    if (!eventos.length) {
      await marcarProcessamento(empresaId, inboxId, { status: 'processado' });
      return { status: 'processado' };
    }
    // Localiza a remessa pelo código de rastreamento (na empresa do evento).
    let envio: Record<string, unknown> | null = null;
    if (codigo) envio = await s.findOneWhere(R_ENVIO(), { empresa_id: empresaId, codigo_rastreamento: codigo });
    // Fallback: o payload pode trazer o id do pedido/remessa do ERP.
    if (!envio && payload.envio_id) envio = await s.get(R_ENVIO(), Number(payload.envio_id));
    if (!envio) {
      await marcarProcessamento(empresaId, inboxId, { status: 'processado' });
      // Sem remessa correspondente: entrega reconhecida e arquivada (não é erro
      // permanente — a remessa pode ainda não existir no ERP).
      return { status: 'processado' };
    }
    const envioId = Number(envio.id);
    try {
      await aplicarEventosRastreio(empresaId, envioId, eventos, 'webhook');
      await marcarProcessamento(empresaId, inboxId, { status: 'processado' });
      // Após atualizar, propaga o rastreio para a loja de origem (se houver).
      try {
        await import('../integration/woocommerce').then((m) => m.enfileirarRastreioLoja(empresaId, envioId));
      } catch {
        /* publicação é best-effort; a fila própria dela cobre retry */
      }
      return { status: 'processado' };
    } catch (e) {
      const mensagem = e instanceof Error ? e.message : 'Falha ao aplicar rastreio.';
      await marcarProcessamento(empresaId, inboxId, { status: 'erro', erro: mensagem });
      return { status: 'retry', erro: mensagem };
    }
  }

  if (acao === 'logistics-rastreio') {
    const envioId = Number(payload.envio_id);
    if (!Number.isInteger(envioId) || envioId <= 0) return { status: 'erro', erro: 'Polling sem envio_id.' };
    const envio = await s.get(R_ENVIO(), envioId);
    if (!envio || Number(envio.empresa_id) !== empresaId) return { status: 'erro', erro: 'Envio não encontrado na empresa do evento.' };
    const adapter = carrier(String(envio.provider)) ?? CARRIER_NULO;
    const r = await sincronizarRastreio(empresaId, envioId, adapter);
    if (r.ok) {
      try {
        await import('../integration/woocommerce').then((m) => m.enfileirarRastreioLoja(empresaId, envioId));
      } catch {
        /* best-effort */
      }
      return { status: 'processado' };
    }
    // Operador indisponível: retry com backoff (transitório).
    return { status: 'retry', erro: r.motivo ?? 'Operador indisponível.' };
  }

  if (acao === 'logistics-woo-tracking') {
    const envioId = Number(payload.envio_id);
    if (!Number.isInteger(envioId) || envioId <= 0) return { status: 'erro', erro: 'Publicação de rastreio sem envio_id.' };
    const r = await publicarRastreioLoja(empresaId, envioId);
    if (r === 'erro') return { status: 'retry', erro: 'Falha ao publicar rastreio na loja.' };
    return { status: 'processado' };
  }

  if (acao === 'logistics-reconciliar') {
    const limite = Number(payload.limite) || 50;
    await reconciliarEmpresa(empresaId, limite);
    return { status: 'processado' };
  }

  return { status: 'erro', erro: `Ação logística desconhecida: ${acao}` };
}
