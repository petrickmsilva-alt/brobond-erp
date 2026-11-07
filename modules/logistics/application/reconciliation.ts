// ============================================================================
// MOTOR DE FRETE › APLICAÇÃO › RECONCILIAÇÃO
//
// Compara o que o ERP acredita com o que o OPERADOR informa e classifica cada
// divergência:
//
//   • LEGITIMA   — não é divergência real (ex.: o operador ainda não propagou um
//                  evento recente); não requer ação.
//   • AUTOMATICA — segura para correção automática (ex.: status do ERP atrás do
//                  operador, código de rastreio ausente mas já informado).
//   • HUMANA     — financeira, de identidade ou ambígua: exige decisão humana.
//
// SOMENTE divergências AUTOMATICAS são corrigidas automaticamente, e a correção
// PRESERVA o histórico (grava evento de origem `reconciliacao`) e registra a
// origem da correção. Divergências financeiras e de identidade NUNCA são
// corrigidas por código.
// ============================================================================
import { getStore } from '../../../server/src/services';
import { getResource } from '../../../server/src/resources';
import { ehStatusLogistico, pesoDoStatus, type StatusLogistico } from '../domain/contract';
import { normalizarStatus, indicaEntrega } from '../domain/status';
import { carrier, CARRIER_NULO } from '../providers/contract';
import { aplicarEventosRastreio } from './tracking';
import { auditarLogistica } from '../infrastructure/audit';
import type { Row, Tx } from '../../../server/src/store';

const R_ENVIO = () => getResource('envios')!;

export type ClassificacaoDivergencia = 'LEGITIMA' | 'AUTOMATICA' | 'HUMANA';

export type Divergencia = {
  envio_id: number;
  venda_id: number;
  store_key: string | null;
  tipo: string;
  classificacao: ClassificacaoDivergencia;
  detalhe: string;
  esperado: string | null;
  observado: string | null;
  corrigivel: boolean;
};

/** Um status é "mais avançado" que outro? (compara peso de progresso) */
function statusMaisAvancado(a: string, b: string): boolean {
  const sa: StatusLogistico = ehStatusLogistico(a) ? a : 'pendente';
  const sb: StatusLogistico = ehStatusLogistico(b) ? b : 'pendente';
  return pesoDoStatus(sa) > pesoDoStatus(sb);
}

export type ResultadoReconciliacao = {
  analisados: number;
  divergencias: Divergencia[];
  corrigidas: number;
  requerHumano: number;
};

/**
 * Reconcilia UMA remessa contra o operador. Consulta o rastreio oficial e
 * compara status e código. NÃO toca financeiro nem identidade de pedido.
 */
export async function reconciliarRemessa(empresaId: number, envioId: number, tx?: Tx): Promise<Divergencia[]> {
  const s = getStore();
  const envio = await s.get(R_ENVIO(), envioId, tx);
  if (!envio || Number(envio.empresa_id) !== empresaId) return [];
  const divergencias: Divergencia[] = [];
  const statusErp: StatusLogistico = ehStatusLogistico(envio.status) ? envio.status : 'pendente';
  const codigoErp = String(envio.codigo_rastreamento || '').trim();
  const adapter = carrier(String(envio.provider)) ?? CARRIER_NULO;

  // Código de rastreamento ausente mas a remessa existe no operador.
  if (!codigoErp && envio.provider_ref) {
    divergencias.push({
      envio_id: envioId,
      venda_id: Number(envio.venda_id),
      store_key: envio.store_key ? String(envio.store_key) : null,
      tipo: 'CODIGO_RASTREIO_AUSENTE',
      classificacao: 'HUMANA',
      detalhe: 'A remessa tem referência no operador, mas o ERP não tem código de rastreamento. Confirme o código no portal do operador.',
      esperado: null,
      observado: String(envio.provider_ref),
      corrigivel: false,
    });
  }

  // Estados terminais do ERP: nada a reconciliar por rastreio (evita regressão).
  if (statusErp === 'entregue' || statusErp === 'cancelado') return divergencias;

  if (!codigoErp) return divergencias;

  const r = await adapter.rastrear(empresaId, codigoErp);
  if (!r.ok) {
    // Operador indisponível NÃO é divergência do pedido — é indisponibilidade.
    return divergencias;
  }
  if (!r.data.length) {
    divergencias.push({
      envio_id: envioId,
      venda_id: Number(envio.venda_id),
      store_key: envio.store_key ? String(envio.store_key) : null,
      tipo: 'SEM_EVENTOS_OPERADOR',
      classificacao: 'LEGITIMA',
      detalhe: 'O operador ainda não devolveu eventos para este código.',
      esperado: null,
      observado: codigoErp,
      corrigivel: false,
    });
    return divergencias;
  }

  // Deriva o status mais avançado que o operador informa, a partir do início
  // (pendente) — não do status do ERP. Começar do status do ERP mascararia o
  // caso em que o operador está ATRÁS (que exige verificação humana).
  let statusOperador: StatusLogistico = 'pendente';
  for (const ev of r.data) {
    const normalizado = normalizarStatus(ev.status, statusOperador);
    if (statusMaisAvancado(normalizado, statusOperador)) statusOperador = normalizado;
  }
  if (indicaEntrega(r.data.map((e) => e.status).join(' '))) statusOperador = 'entregue';

  if (statusMaisAvancado(statusOperador, statusErp)) {
    divergencias.push({
      envio_id: envioId,
      venda_id: Number(envio.venda_id),
      store_key: envio.store_key ? String(envio.store_key) : null,
      tipo: 'STATUS_ATRASADO_ERP',
      classificacao: 'AUTOMATICA',
      detalhe: `O operador indica "${statusOperador}" e o ERP está em "${statusErp}". Correção segura (avanço de status).`,
      esperado: statusOperador,
      observado: statusErp,
      corrigivel: true,
    });
  } else if (statusMaisAvancado(statusErp, statusOperador)) {
    divergencias.push({
      envio_id: envioId,
      venda_id: Number(envio.venda_id),
      store_key: envio.store_key ? String(envio.store_key) : null,
      tipo: 'STATUS_ADIANTADO_ERP',
      classificacao: 'HUMANA',
      detalhe: `O ERP está em "${statusErp}" e o operador em "${statusOperador}". Ambíguo — exige verificação humana (possível evento perdido).`,
      esperado: statusOperador,
      observado: statusErp,
      corrigivel: false,
    });
  }
  return divergencias;
}

/**
 * Reconcilia as remessas vivas da empresa e CORRIGE somente as AUTOMATICAS.
 * Preserva o histórico (evento com origem `reconciliacao`).
 */
export async function reconciliarEmpresa(empresaId: number, limite = 50, tx?: Tx): Promise<ResultadoReconciliacao> {
  const s = getStore();
  const vivas = await s.list(R_ENVIO(), { page: 1, pageSize: limite, filter: { empresa_id: empresaId }, sort: 'atualizado_em', dir: 'asc' }, tx);
  const divergencias: Divergencia[] = [];
  let corrigidas = 0;
  let requerHumano = 0;
  for (const envio of vivas.rows) {
    const status = String(envio.status);
    if (status === 'entregue' || status === 'cancelado' || status === 'pendente') continue;
    const ds = await reconciliarRemessa(empresaId, Number(envio.id), tx);
    divergencias.push(...ds);
    for (const d of ds) {
      if (d.classificacao === 'AUTOMATICA' && d.corrigivel) {
        const adapter = carrier(String(envio.provider)) ?? CARRIER_NULO;
        const codigo = String(envio.codigo_rastreamento || '');
        const r = await adapter.rastrear(empresaId, codigo);
        if (r.ok && r.data.length) {
          await aplicarEventosRastreio(empresaId, Number(envio.id), r.data, 'polling', tx);
          corrigidas += 1;
          await auditarLogistica(
            { empresaId, entidade: 'envio', entidadeId: Number(envio.id), acao: 'reconciliacao_corrigida', descricao: `Divergência ${d.tipo} corrigida automaticamente: ${d.detalhe}`, dados: { tipo: d.tipo, esperado: d.esperado, observado: d.observado } },
            tx
          );
        }
      } else if (d.classificacao === 'HUMANA') {
        requerHumano += 1;
      }
    }
  }
  return { analisados: vivas.rows.length, divergencias, corrigidas, requerHumano };
}

/** Reexporta para o painel. */
export type { Row };
