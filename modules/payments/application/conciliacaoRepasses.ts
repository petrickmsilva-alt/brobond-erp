// ============================================================================
// PAYMENTS › CONCILIAÇÃO AUTOMÁTICA DE REPASSES (repasse ↔ extrato)
//
// O que já existia: `POST /payouts/:id/match` casa UM repasse com UMA linha de
// extrato, sob trava `payout-bank-match`. O que faltava: o operador precisava
// abrir repasse por repasse. Este módulo faz a VARREDURA — para cada repasse
// importado e ainda sem vínculo, procura no extrato a linha bancária de mesma
// entrada e mesmo valor líquido e aplica o MESMO `conciliarRepasse`.
//
// PRINCÍPIOS (não negociáveis)
//   • NÃO existe motor paralelo. A automação chama `conciliarRepasse`, o mesmo
//     núcleo do endpoint manual, sob a mesma trava. Não há como o automático
//     aplicar um efeito que o manual não aplicaria.
//   • Não move dinheiro. Vincula evidências e grava taxas de liquidação pelo
//     `aplicarTaxasSettlement` já existente — exatamente como o manual.
//   • Conservadora por padrão: desligada. Só roda para empresas que ligaram a
//     chave `payments_auto_match:<empresa>`.
//   • Casamento AMBÍGUO não é decidido: se houver mais de uma linha de extrato
//     candidata, nada é conciliado e a pendência é sinalizada para revisão
//     humana. Adivinhar seria criar evidência falsa.
//   • Multiempresa: só enxerga repasses e extratos da própria empresa.
//   • Idempotente: repasse já conciliado não é reprocessado; reexecutar não
//     duplica efeito (o núcleo devolve `idempotente: true`).
// ============================================================================
import { lerConfig, gravarConfig, R_CONFIGURACOES } from '../../../server/src/configuracoes';
import { R_EXTRATO } from '../../../server/src/extrato';
import { log } from '../../../server/src/log';
import { getStore } from '../../../server/src/services';
import type { Store, Tx } from '../../../server/src/store';
import { R_PAYOUTS } from '../infrastructure/resources';
import { locked } from '../infrastructure/locking';
import { conciliarRepasse } from './payouts';

/** Ator sintético gravado na auditoria das conciliações feitas pela varredura. */
const ATOR_AUTOMATICO = { id: null, name: 'Conciliação automática' } as const;

const chaveConfig = (empresaId: number) => `payments_auto_match:${empresaId}`;

export type ConfigConciliacao = { habilitado: boolean };

/** Lê a configuração da empresa. Ausente/ilegível ⇒ desligada (padrão seguro). */
export async function configConciliacaoAutomatica(empresaId: number): Promise<ConfigConciliacao> {
  const bruto = await lerConfig(chaveConfig(empresaId));
  if (!bruto) return { habilitado: false };
  try {
    const parsed = JSON.parse(bruto) as { habilitado?: unknown };
    return { habilitado: parsed?.habilitado === true };
  } catch {
    return { habilitado: false };
  }
}

/** Liga/desliga a varredura para a empresa. Ligar é decisão do administrador. */
export async function definirConciliacaoAutomatica(empresaId: number, habilitado: boolean, atualizadoPor: string): Promise<ConfigConciliacao> {
  await gravarConfig(chaveConfig(empresaId), JSON.stringify({ habilitado: habilitado === true }), atualizadoPor);
  return { habilitado: habilitado === true };
}

/** Empresas com a varredura ligada (para o cron, que roda fora de um tenant). */
export async function empresasComConciliacaoAutomatica(): Promise<number[]> {
  const { rows } = await getStore().list(R_CONFIGURACOES, { page: 1, pageSize: 1000 });
  const ids: number[] = [];
  for (const row of rows) {
    const m = /^payments_auto_match:(\d+)$/.exec(String(row.chave));
    if (!m) continue;
    try {
      if ((JSON.parse(String(row.valor)) as { habilitado?: unknown })?.habilitado === true) ids.push(Number(m[1]));
    } catch {
      /* configuração ilegível não liga nada */
    }
  }
  return ids;
}

type Candidato = { id: number; valor: number };

/**
 * Linha de extrato candidata a casar com um repasse: entrada, não divergente,
 * ainda não aplicada a um título e de valor líquido idêntico (em centavos).
 * Devolve a ÚNICA candidata, ou o motivo da recusa — nunca escolhe entre duas.
 */
async function extratoCandidato(s: Store, empresaId: number, netCentavos: number, tx?: Tx): Promise<{ unico: Candidato | null; ambiguo: boolean }> {
  const { rows } = await s.list(R_EXTRATO, { page: 1, pageSize: 2000, filter: { empresa_id: empresaId, direcao: 'entrada', status: 'importada' } }, tx);
  const candidatos = rows.filter(
    (l) => !l.lancamento_id && !l.baixa_lancamento_id && Math.round(Number(l.valor) * 100) === netCentavos
  );
  if (candidatos.length === 0) return { unico: null, ambiguo: false };
  if (candidatos.length > 1) return { unico: null, ambiguo: true };
  return { unico: { id: Number(candidatos[0].id), valor: Number(candidatos[0].valor) }, ambiguo: false };
}

export interface ResultadoConciliacao {
  conciliados: number;
  ambiguos: number;
  sem_extrato: number;
  falhas: number;
}

/**
 * Varre os repasses IMPORTADOS da empresa e concilia os que têm UMA linha de
 * extrato inequívoca. Não lança por repasse problemático: acumula no resultado
 * para que a operação veja o que ficou pendente sem que a varredura inteira caia.
 */
export async function executarConciliacaoAutomatica(empresaId: number): Promise<ResultadoConciliacao> {
  const s = getStore();
  const resultado: ResultadoConciliacao = { conciliados: 0, ambiguos: 0, sem_extrato: 0, falhas: 0 };
  const payouts = await s.list(R_PAYOUTS, {
    page: 1,
    pageSize: 500,
    filter: { empresa_id: empresaId, status: 'IMPORTED' },
    sort: 'id',
    dir: 'asc',
  });
  for (const payout of payouts.rows) {
    const netCentavos = Math.round(Number(payout.net_amount));
    const { unico, ambiguo } = await extratoCandidato(s, empresaId, netCentavos);
    if (ambiguo) {
      resultado.ambiguos++;
      log.warn('conciliacao_repasses_ambiguo', { empresa_id: empresaId, payout_id: Number(payout.id) });
      continue;
    }
    if (!unico) {
      resultado.sem_extrato++;
      continue;
    }
    try {
      await locked(
        empresaId,
        'payout-bank-match',
        (tx) => conciliarRepasse(s, empresaId, ATOR_AUTOMATICO, Number(payout.id), unico.id, tx),
        'read committed'
      );
      resultado.conciliados++;
      log.info('conciliacao_repasse_automatica', { empresa_id: empresaId, payout_id: Number(payout.id), extrato_id: unico.id });
    } catch (error) {
      // Divergência de evidência, concorrência ou repasse que mudou: fica para o
      // operador. Não é silenciado — o contador alimenta a observabilidade.
      resultado.falhas++;
      log.warn('conciliacao_repasses_falha', { empresa_id: empresaId, payout_id: Number(payout.id), erro: (error as Error)?.message });
    }
  }
  return resultado;
}

/** Varredura para TODAS as empresas habilitadas. É o que o cron chama. */
export async function executarConciliacaoAutomaticaGlobal(): Promise<ResultadoConciliacao> {
  const empresas = await empresasComConciliacaoAutomatica();
  const total: ResultadoConciliacao = { conciliados: 0, ambiguos: 0, sem_extrato: 0, falhas: 0 };
  for (const empresaId of empresas) {
    const r = await executarConciliacaoAutomatica(empresaId);
    total.conciliados += r.conciliados;
    total.ambiguos += r.ambiguos;
    total.sem_extrato += r.sem_extrato;
    total.falhas += r.falhas;
  }
  return total;
}
