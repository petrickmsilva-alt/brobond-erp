// ============================================================================
// MOTOR DE FRETE › APLICAÇÃO › PAINEL (INDICADORES)
//
// Agrega os números do painel operacional a partir das tabelas REAIS:
//
//   • remessas por status (aguardando expedição, separação, expedidas, em
//     trânsito, concluídas, atrasadas);
//   • ocorrências e falhas de integração (inbox de webhook);
//   • custo de frete PREVISTO e EFETIVO;
//   • estado dos operadores (health/configuração).
//
// Nada é inventado: indicador sem dado é 0. Recorte por empresa (e,
// opcionalmente, por loja).
// ============================================================================
import { getStore } from '../../../server/src/services';
import { getResource } from '../../../server/src/resources';
import { round2, somaMoeda } from '../../../server/src/utils';
import { carriers } from '../providers/contract';
import { obterConfigCarrier } from '../infrastructure/config';
import { listarEntregas, contarEntregas } from '../infrastructure/webhookInbox';
import { logisticsHabilitado, provedorPadrao } from './quotes';
import { cepValido, type StoreKey } from '../domain/contract';
import type { Row } from '../../../server/src/store';

const R_ENVIO = () => getResource('envios')!;

export type IndicadoresPainel = {
  modulo_habilitado: boolean;
  provider_padrao: string;
  contadores: Record<string, number>;
  atrasadas: number;
  ocorrencias: number;
  falhas_integracao: number;
  custo_previsto: number;
  custo_efetivo: number;
  lojas: { store_key: string; remessas: number }[];
  webhooks: Record<string, number>;
  providers: { slug: string; nome: string; configurado: boolean; habilitado: boolean; motivo: string | null; capacidades: unknown }[];
  gerado_em: string;
};

/** A remessa está "atrasada"? (prazo estourado e ainda não entregue) */
function estaAtrasada(envio: Row, agora: number): boolean {
  const status = String(envio.status);
  if (['entregue', 'cancelado', 'devolvido', 'extraviado'].includes(status)) return false;
  const prazo = Number(envio.prazo_dias);
  if (!Number.isFinite(prazo) || prazo <= 0) return false;
  const base = Date.parse(String(envio.criado_em || ''));
  if (!Number.isFinite(base)) return false;
  return agora > base + prazo * 24 * 60 * 60 * 1000;
}

export async function coletarIndicadores(empresaId: number, store: StoreKey | null = null): Promise<IndicadoresPainel> {
  const s = getStore();
  const filtro: Record<string, unknown> = { empresa_id: empresaId };
  if (store) filtro.store_key = store;
  const envios = await s.list(R_ENVIO(), { page: 1, pageSize: 5000, filter: filtro, sort: 'id', dir: 'desc' });

  const contadores: Record<string, number> = {};
  let atrasadas = 0;
  let custoPrevisto = 0;
  let custoEfetivo = 0;
  const porLoja = new Map<string, number>();
  const agora = Date.now();
  for (const e of envios.rows) {
    const status = String(e.status || 'pendente');
    contadores[status] = (contadores[status] ?? 0) + 1;
    if (estaAtrasada(e, agora)) atrasadas += 1;
    custoPrevisto = round2(custoPrevisto + Number(e.custo_previsto || 0));
    custoEfetivo = round2(custoEfetivo + Number(e.custo_efetivo || e.custo || 0));
    const loja = e.store_key ? String(e.store_key) : 'ERP';
    porLoja.set(loja, (porLoja.get(loja) ?? 0) + 1);
  }

  // Ocorrências (envio_ocorrencias — TMS).
  let ocorrencias = 0;
  try {
    const oc = await s.countWhere(getResource('envio_ocorrencias')!, { empresa_id: empresaId });
    ocorrencias = Number(oc) || 0;
  } catch {
    ocorrencias = 0;
  }

  const entregas = await listarEntregas(empresaId, {});
  const webhooks = contarEntregas(entregas);
  const falhasIntegracao = (webhooks.erro ?? 0) + (webhooks.rejeitado ?? 0);

  const providers = await Promise.all(
    carriers().map(async (c) => {
      const disp = await c.disponivel(empresaId).catch(() => ({ configurado: false, habilitado: false, motivo: 'Falha ao avaliar.' }));
      const cfg = await obterConfigCarrier(empresaId, c.slug);
      return { slug: c.slug, nome: c.nome, configurado: disp.configurado, habilitado: cfg.habilitado && disp.configurado, motivo: disp.motivo, capacidades: c.capacidades };
    })
  );

  return {
    modulo_habilitado: logisticsHabilitado(),
    provider_padrao: provedorPadrao(),
    contadores,
    atrasadas,
    ocorrencias,
    falhas_integracao: falhasIntegracao,
    custo_previsto: custoPrevisto,
    custo_efetivo: custoEfetivo,
    lojas: [...porLoja.entries()].map(([store_key, remessas]) => ({ store_key, remessas })),
    webhooks,
    providers,
    gerado_em: new Date().toISOString(),
  };
}

export { somaMoeda, cepValido };
