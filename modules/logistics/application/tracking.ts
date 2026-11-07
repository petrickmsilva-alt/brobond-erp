// ============================================================================
// MOTOR DE FRETE › APLICAÇÃO › RASTREAMENTO
//
// O rastreio é o ponto onde dados de TERCEIROS entram no ERP. Três garantias
// inegociáveis:
//
//   1) IDEMPOTÊNCIA: um evento reentregue não vira duas linhas. A identidade é
//      (envio, código, status bruto, instante) — o índice único parcial
//      `uq_logistics_evento_dedupe` é a barreira final, e a checagem prévia dá
//      a mensagem amigável;
//   2) NÃO REGRESSÃO: um evento atrasado NUNCA faz um pedido entregue voltar
//      para "em trânsito". `podeAvancar` (domínio) decide; o histórico BRUTO é
//      sempre preservado, mesmo quando o status do envio não muda;
//   3) AUDITORIA: cada mudança de status é registrada com origem, código
//      externo e o payload do operador.
//
// A origem do evento é gravada (`webhook`, `polling`, `manual`) para que a
// reconciliação saiba de onde veio cada atualização.
// ============================================================================
import { createHash } from 'node:crypto';
import { getStore } from '../../../server/src/services';
import { getResource } from '../../../server/src/resources';
import { round2 } from '../../../server/src/utils';
import { normalizarStatus } from '../domain/status';
import { podeAvancar, ehStatusLogistico, type StatusLogistico } from '../domain/contract';
import type { EventoRastreioBruto } from '../providers/contract';
import { R_QUOTES } from '../infrastructure/resources';
import { auditarLogistica } from '../infrastructure/audit';
import type { Row, Tx } from '../../../server/src/store';

export type OrigemEvento = 'webhook' | 'polling' | 'manual';

export type ResultadoAplicacao = {
  gravados: number;
  ignorados: number;
  statusFinal: string;
  regrediu: boolean;
};

const R_ENVIO = () => getResource('envios')!;
const R_EVENTO = () => getResource('envio_eventos')!;

/** Identidade do evento para dedupe (estável entre reentregas). */
export function chaveDedupeEvento(ev: EventoRastreioBruto, envioId: number): string {
  const base = `${envioId}|${String(ev.codigo ?? '').trim()}|${String(ev.status ?? '').trim()}|${String(ev.em ?? '').trim()}|${String(ev.mensagem ?? '').trim().slice(0, 120)}`;
  return createHash('sha256').update(base).digest('hex').slice(0, 40);
}

/**
 * Aplica eventos de rastreio a um envio, com idempotência e não regressão.
 * Devolve quantos foram gravados/ignorados e o status final.
 */
export async function aplicarEventosRastreio(
  empresaId: number,
  envioId: number,
  eventos: EventoRastreioBruto[],
  origem: OrigemEvento,
  tx?: Tx
): Promise<ResultadoAplicacao> {
  const s = getStore();
  const envio = await s.get(R_ENVIO(), envioId, tx);
  if (!envio || Number(envio.empresa_id) !== empresaId) {
    throw new Error(`Envio ${envioId} não encontrado na empresa ${empresaId}.`);
  }
  let statusAtual: StatusLogistico = ehStatusLogistico(envio.status) ? envio.status : 'pendente';
  const statusInicial = statusAtual;
  let gravados = 0;
  let ignorados = 0;
  let regrediu = false;

  const jaGravados = await s.list(R_EVENTO(), { page: 1, pageSize: 1000, filter: { empresa_id: empresaId, envio_id: envioId } }, tx);
  const vistos = new Set(jaGravados.rows.map((e) => String(e.dedupe_key || '')).filter(Boolean));

  for (const ev of eventos) {
    const dedupe = chaveDedupeEvento(ev, envioId);
    if (vistos.has(dedupe)) {
      ignorados += 1;
      continue;
    }
    const normalizado = normalizarStatus(ev.status, statusAtual);
    const avanca = podeAvancar(statusAtual, normalizado);
    const alvo = avanca ? normalizado : statusAtual;
    if (!avanca && normalizado !== statusAtual) regrediu = true;
    try {
      await s.insert(
        R_EVENTO(),
        {
          empresa_id: empresaId,
          envio_id: envioId,
          de_status: statusAtual,
          para_status: alvo,
          status_normalizado: normalizado,
          codigo: ev.codigo || null,
          external_code: ev.status || null,
          origem,
          dedupe_key: dedupe,
          mensagem: ev.mensagem || null,
          local: ev.local ?? null,
          payload: ev.bruto === undefined ? null : ev.bruto,
        },
        tx
      );
      vistos.add(dedupe);
      gravados += 1;
    } catch {
      // Corrida: o índice único recusou a duplicata — conta como ignorado.
      ignorados += 1;
      continue;
    }
    if (alvo !== statusAtual) {
      statusAtual = alvo;
    }
  }

  if (statusAtual !== statusInicial) {
    await s.update(R_ENVIO(), envioId, { status: statusAtual }, tx);
    await auditarLogistica(
      {
        empresaId,
        entidade: 'envio',
        entidadeId: envioId,
        acao: 'rastreio',
        descricao: `Envio #${envioId}: ${statusInicial} → ${statusAtual} (${origem})`,
        dados: { de: statusInicial, para: statusAtual, origem, gravados, ignorados },
      },
      tx
    );
  }

  return { gravados, ignorados, statusFinal: statusAtual, regrediu };
}

/**
 * Consulta o operador (polling) e aplica os eventos novos. Usado pela
 * contingência quando não há webhook ou quando o webhook atrasou.
 */
export async function sincronizarRastreio(empresaId: number, envioId: number, adapter: import('../providers/contract').CarrierAdapter, tx?: Tx): Promise<ResultadoAplicacao & { ok: boolean; motivo?: string }> {
  const s = getStore();
  const envio = await s.get(R_ENVIO(), envioId, tx);
  if (!envio) return { gravados: 0, ignorados: 0, statusFinal: 'pendente', regrediu: false, ok: false, motivo: 'Envio não encontrado.' };
  const codigo = String(envio.codigo_rastreamento || '').trim();
  if (!codigo) return { gravados: 0, ignorados: 0, statusFinal: String(envio.status), regrediu: false, ok: false, motivo: 'Envio sem código de rastreamento.' };
  const r = await adapter.rastrear(empresaId, codigo);
  if (!r.ok) return { gravados: 0, ignorados: 0, statusFinal: String(envio.status), regrediu: false, ok: false, motivo: r.mensagem };
  const aplicado = await aplicarEventosRastreio(empresaId, envioId, r.data, 'polling', tx);
  return { ...aplicado, ok: true };
}

/** Fingerprint da cotação: mesma venda + parâmetros = mesma identidade lógica. */
export function fingerprintCotacao(partes: {
  empresaId: number;
  storeKey: string | null;
  vendaId: number | null;
  cepOrigem: string;
  cepDestino: string;
  pesoG: number;
  volumes: number;
  modalidade: string;
}): string {
  const base = [partes.empresaId, partes.storeKey ?? '', partes.vendaId ?? '', partes.cepOrigem, partes.cepDestino, partes.pesoG, partes.volumes, partes.modalidade].join('|');
  return createHash('sha256').update(base).digest('hex').slice(0, 32);
}

/** Cotações válidas ainda não expiradas para a empresa (para reuso). */
export async function cotacoesValidas(empresaId: number, fingerprint: string, tx?: Tx): Promise<Row[]> {
  const s = getStore();
  const out = await s.list(R_QUOTES(), { page: 1, pageSize: 5, filter: { empresa_id: empresaId, fingerprint, estado: 'OK' }, sort: 'id', dir: 'desc' }, tx);
  const agora = Date.now();
  return out.rows.filter((r) => {
    const valida = r.valida_ate ? Date.parse(String(r.valida_ate)) : 0;
    return !valida || valida > agora;
  });
}

export { round2 };
