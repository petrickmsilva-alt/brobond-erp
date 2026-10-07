// ============================================================================
// MOTOR DE REGRAS FISCAIS — resolve a tributação de UM item de documento.
//
// Existe para que nenhuma alíquota viva dentro de um `if` espalhado pelo
// código. A resolução é determinística e tem três camadas, nesta ordem:
//
//   1) O PRODUTO. Se o cadastro do produto define CFOP/CST/alíquota, ele
//      vence — é a exceção mais específica que existe.
//   2) A REGRA FISCAL (`regras_fiscais`) mais específica que casa com o
//      contexto (NCM, UF de destino, operação, modelo, consumidor final,
//      regime). Critério de desempate, nesta ordem: maior `prioridade`,
//      depois NCM mais longo, depois UF específica antes de curinga, depois
//      a regra mais nova.
//   3) O PADRÃO DA EMPRESA (`empresa_fiscal_config`): CFOP dentro/fora do
//      estado. O resto fica em branco — e em branco é melhor do que
//      inventado: a emissão recusa o documento incompleto em vez de mandar
//      um imposto errado para a SEFAZ.
//
// IMPORTANTE: isto NÃO substitui o cálculo de margem do módulo
// "1. MEU NEGÓCIOS". Aquele motor usa `impostos_ncm` (carga efetiva) e
// continua intocado. São duas perguntas diferentes: "quanto eu realmente
// pago de imposto?" (margem) e "o que vai escrito no documento fiscal?".
// ============================================================================
import { getResource } from './resources';
import { getStore } from './services';
import type { Row, Tx } from './store';
import { EMPRESA_PADRAO } from './empresa';

export type ContextoFiscal = {
  empresaId: number;
  /** '55' NF-e | '65' NFC-e */
  modelo: '55' | '65';
  operacao: 'saida' | 'entrada';
  /** UF do destinatário (ou do emitente, na entrada). */
  ufDestino: string | null;
  /** UF do emitente — decide CFOP 5xxx (interno) vs 6xxx (interestadual). */
  ufEmitente: string | null;
  consumidorFinal: boolean;
  /** CRT da empresa (1/2 = Simples, 3 = normal). */
  regime: string | null;
};

export type TributacaoItem = {
  cfop: string | null;
  ncm: string | null;
  cest: string | null;
  origem: string;
  icms_cst: string | null;
  icms_aliquota: number | null;
  icms_reducao_pct: number | null;
  icms_mod_bc: string | null;
  csosn: string | null;
  pis_cst: string | null;
  pis_aliquota: number | null;
  cofins_cst: string | null;
  cofins_aliquota: number | null;
  ipi_cst: string | null;
  ipi_aliquota: number | null;
  /** De onde veio cada decisão — vai para a auditoria do documento. */
  origem_regra: { produto: string[]; regra: string[]; padrao: string[]; regra_id: number | null };
};

/** Mantém só os dígitos do NCM (o cadastro aceita "6205.20.00"). */
export function ncmDigitos(valor: unknown): string {
  return String(valor ?? '').replace(/\D/g, '');
}

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function texto(v: unknown): string | null {
  const s = String(v ?? '').trim();
  return s === '' ? null : s;
}

/** A regra casa com o contexto e com o NCM do produto? */
export function regraAplicavel(regra: Row, ctx: ContextoFiscal, ncm: string, hoje: string): boolean {
  if (regra.ativo === false) return false;
  if (Number(regra.empresa_id ?? EMPRESA_PADRAO) !== ctx.empresaId) return false;
  if (String(regra.operacao || 'saida') !== ctx.operacao) return false;

  const modelo = texto(regra.modelo);
  if (modelo && modelo !== ctx.modelo) return false;

  const uf = texto(regra.uf_destino);
  if (uf && uf.toUpperCase() !== String(ctx.ufDestino || '').toUpperCase()) return false;

  const regime = texto(regra.regime);
  if (regime && regime !== String(ctx.regime || '')) return false;

  if (regra.consumidor_final !== null && regra.consumidor_final !== undefined) {
    if (Boolean(regra.consumidor_final) !== ctx.consumidorFinal) return false;
  }

  const ncmRegra = ncmDigitos(regra.ncm);
  if (ncmRegra && !ncm.startsWith(ncmRegra)) return false;

  const inicio = texto(regra.vigencia_inicio);
  if (inicio && String(inicio).slice(0, 10) > hoje) return false;
  const fim = texto(regra.vigencia_fim);
  if (fim && String(fim).slice(0, 10) < hoje) return false;

  return true;
}

/**
 * Ordena da MAIS específica para a mais genérica.
 * Prioridade → NCM mais longo → UF específica → mais recente.
 */
export function ordenarPorEspecificidade(regras: Row[]): Row[] {
  return [...regras].sort((a, b) => {
    const prio = Number(b.prioridade || 0) - Number(a.prioridade || 0);
    if (prio !== 0) return prio;
    const ncm = ncmDigitos(b.ncm).length - ncmDigitos(a.ncm).length;
    if (ncm !== 0) return ncm;
    const uf = (texto(b.uf_destino) ? 1 : 0) - (texto(a.uf_destino) ? 1 : 0);
    if (uf !== 0) return uf;
    return Number(b.id || 0) - Number(a.id || 0);
  });
}

/** Carrega as regras ativas da empresa (uma consulta por documento). */
export async function carregarRegras(empresaId: number, tx?: Tx): Promise<Row[]> {
  const r = getResource('regras_fiscais');
  if (!r) return [];
  const { rows } = await getStore().list(
    r,
    { page: 1, pageSize: 1000, filter: { empresa_id: empresaId, ativo: true } },
    tx
  );
  return rows;
}

/**
 * Resolve a tributação de um item.
 *
 * `regras` vem pré-carregado para não consultar o banco item a item.
 */
export function resolverTributacao(
  produto: Row,
  ctx: ContextoFiscal,
  regras: Row[],
  padrao: { cfop_dentro: string; cfop_fora: string },
  hoje: string = new Date().toISOString().slice(0, 10)
): TributacaoItem {
  const ncm = ncmDigitos(produto.ncm);
  const deProduto: string[] = [];
  const deRegra: string[] = [];
  const dePadrao: string[] = [];

  const candidatas = ordenarPorEspecificidade(regras.filter((r) => regraAplicavel(r, ctx, ncm, hoje)));
  const regra = candidatas[0] ?? null;

  /** Produto vence; depois a regra; depois nada (null, nunca um chute). */
  function escolher<T>(campo: string, doProduto: T | null, daRegra: T | null): T | null {
    if (doProduto !== null && doProduto !== undefined) {
      deProduto.push(campo);
      return doProduto;
    }
    if (daRegra !== null && daRegra !== undefined) {
      deRegra.push(campo);
      return daRegra;
    }
    return null;
  }

  // CFOP tem um terceiro nível: o padrão da empresa, que depende apenas de a
  // operação ser interna ou interestadual — isso nunca é um chute.
  let cfop = escolher<string>('cfop', texto(produto.cfop_saida), regra ? texto(regra.cfop) : null);
  if (cfop === null && ctx.operacao === 'saida') {
    const mesmaUf =
      !!ctx.ufEmitente && !!ctx.ufDestino && ctx.ufEmitente.toUpperCase() === ctx.ufDestino.toUpperCase();
    cfop = mesmaUf ? padrao.cfop_dentro : padrao.cfop_fora;
    dePadrao.push('cfop');
  }

  const simples = ctx.regime === '1' || ctx.regime === '2';

  return {
    cfop,
    ncm: ncm || null,
    cest: texto(produto.cest),
    origem: texto(produto.origem) || '0',
    // No Simples Nacional quem vai no XML é o CSOSN; no regime normal, o CST.
    icms_cst: simples ? null : escolher('icms_cst', texto(produto.icms_cst), regra ? texto(regra.icms_cst) : null),
    csosn: simples ? escolher('csosn', texto(produto.icms_cst), regra ? texto(regra.csosn) : null) : null,
    icms_aliquota: escolher('icms_aliquota', num(produto.icms_aliquota), regra ? num(regra.icms_aliquota) : null),
    icms_reducao_pct: regra ? num(regra.icms_reducao_pct) : null,
    icms_mod_bc: regra ? texto(regra.icms_mod_bc) : null,
    pis_cst: escolher('pis_cst', texto(produto.pis_cst), regra ? texto(regra.pis_cst) : null),
    pis_aliquota: escolher('pis_aliquota', num(produto.pis_aliquota), regra ? num(regra.pis_aliquota) : null),
    cofins_cst: escolher('cofins_cst', texto(produto.cofins_cst), regra ? texto(regra.cofins_cst) : null),
    cofins_aliquota: escolher('cofins_aliquota', num(produto.cofins_aliquota), regra ? num(regra.cofins_aliquota) : null),
    ipi_cst: escolher('ipi_cst', texto(produto.ipi_cst), regra ? texto(regra.ipi_cst) : null),
    ipi_aliquota: escolher('ipi_aliquota', num(produto.ipi_aliquota), regra ? num(regra.ipi_aliquota) : null),
    origem_regra: { produto: deProduto, regra: deRegra, padrao: dePadrao, regra_id: regra ? Number(regra.id) : null },
  };
}

/**
 * O que falta para o item poder ir para a SEFAZ.
 * Devolver a lista (em vez de preencher com um valor plausível) é a diferença
 * entre recusar o documento e emitir um imposto errado.
 */
export function pendenciasFiscais(trib: TributacaoItem, ctx: ContextoFiscal): string[] {
  const faltas: string[] = [];
  if (!trib.ncm) faltas.push('NCM do produto');
  if (!trib.cfop) faltas.push('CFOP');
  const simples = ctx.regime === '1' || ctx.regime === '2';
  if (simples) {
    if (!trib.csosn) faltas.push('CSOSN (Simples Nacional)');
  } else if (!trib.icms_cst) {
    faltas.push('CST do ICMS');
  }
  if (!trib.pis_cst) faltas.push('CST do PIS');
  if (!trib.cofins_cst) faltas.push('CST do COFINS');
  return faltas;
}

/** Imposto em CENTAVOS sobre uma base em centavos (meio-para-cima). */
export function impostoCentavos(baseCents: number, aliquotaPct: number | null): number {
  if (!aliquotaPct || !Number.isFinite(aliquotaPct)) return 0;
  return Math.round((baseCents * aliquotaPct) / 100);
}
