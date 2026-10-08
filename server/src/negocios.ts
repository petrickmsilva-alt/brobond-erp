// ============================================================
// 1. MEU NEGÓCIOS — Motor analítico real (sem mocks).
//
// Substitui os mocks de relatórios por cálculo MATEMÁTICO ABSOLUTO
// sobre a tabela `sales`, em CENTAVOS INTEIROS (Int — a mesma
// convenção do motor financeiro do commerce: zero erro de ponto
// flutuante).
//
//   1) MARGEM POR PEDIDO ("query robusta" em SQL — migration 0016):
//
//        Lucro bruto = Valor Líquido (amount_cents)
//                    − CMV (custo médio da ficha técnica)
//                    − Impostos (Σ subtotal × alíquota do NCM)
//                    − Frete pago (freight_cents)
//
//      O resultado é MATERIALIZADO nas colunas reais de `sales`
//      (net_cents, cmv_cents, tax_cents, gross_profit_cents,
//      margin_pct) pela query única `recalcularMargens`.
//
//   2) CURVA ABC CONTÍNUA: faturamento acumulado por produto
//      (status PAID) classificado A/B/C — Classe A até cruzar 80%
//      do acumulado, Classe B até 95%, Classe C nos 5% restantes —
//      persistida em `produto_abc` e mantida fresca pela rotina em
//      segundo plano (boot + intervalo + pós-ingestão + cron).
//
//   3) AGREGADORES DE BI com filtros ESTRITOS: período De/Até
//      (dia CIVIL de America/Sao_Paulo, não UTC), empresa e canal de
//      venda agrupado em Loja Física / E-commerce / Marketplaces.
//
//   4) MULTIEMPRESA: a empresa das leituras é decidida no SERVIDOR
//      (aplicarEscopoEmpresaBi). `empresa_id` da query é apenas um
//      PEDIDO, validado contra as concessões do ator (403 se negado).
//      Sem pedido, vale a empresa ativa da sessão — nunca todas.
//
// Duas implementações do mesmo contrato (padrão store.ts do ERP):
//   • SQL (Postgres — produção/DATABASE_URL): queries reais;
//   • Memória (modo demonstração/testes): mesma matemática em JS,
//     lendo catálogo/fichas/impostos do store e mantendo `sales` em
//     estado do módulo. Nenhuma implementação fabrica dados.
// ============================================================
import type { Request, Response } from 'express';
import type { PoolClient } from 'pg';
import { hasDatabaseUrl, query, withTransaction } from './db';
import { RESOURCES } from './resources';
import { checkAccess, getStore } from './services';
import { currentUser, type AuthUser } from './auth';
import { HttpError } from './errors';
import { escopoDoAtor, exigirEmpresaPermitida } from './empresa';
import { setOnSaleIngested } from '../../modules/connectors/index';

// ----------------------------------------------------------------------------
// 1) Constantes de domínio
// ----------------------------------------------------------------------------

/** Canais do enum `sale_channel` (tabela sales). */
export const CANAIS_VENDA = ['BROBOND', 'INSTAGRAM_SHOPPING', 'MERCADOLIVRE', 'MERCADOPAGO', 'NUVEMSHOP', 'LOJA_FISICA'] as const;
export type CanalVenda = (typeof CANAIS_VENDA)[number];

/** Grupos de canal exigidos pelo módulo 1. MEU NEGÓCIOS. */
export type CanalGrupo = 'loja_fisica' | 'ecommerce' | 'marketplace';

/**
 * Mapeamento canônico (aprovado pela diretoria):
 *   • Loja Física  — vendas presenciais (canal próprio LOJA_FISICA);
 *   • E-commerce   — checkouts próprios: loja BROBOND, Nuvemshop,
 *                    Instagram Shopping e Mercado Pago (links/pgto);
 *   • Marketplaces — Mercado Livre.
 */
export const GRUPOS_CANAL: Record<CanalGrupo, { label: string; canais: CanalVenda[] }> = {
  loja_fisica: { label: 'Loja Física', canais: ['LOJA_FISICA'] },
  ecommerce: { label: 'E-commerce', canais: ['BROBOND', 'NUVEMSHOP', 'INSTAGRAM_SHOPPING', 'MERCADOPAGO'] },
  marketplace: { label: 'Marketplaces', canais: ['MERCADOLIVRE'] },
};

const CANAL_PARA_GRUPO: Record<string, CanalGrupo> = Object.fromEntries(
  (Object.keys(GRUPOS_CANAL) as CanalGrupo[]).flatMap((grupo) => GRUPOS_CANAL[grupo].canais.map((canal) => [canal, grupo]))
) as Record<string, CanalGrupo>;

export const CANAL_LABEL: Record<string, string> = {
  BROBOND: 'Loja própria (brobond.com.br)',
  INSTAGRAM_SHOPPING: 'Instagram Shopping',
  MERCADOLIVRE: 'Mercado Livre',
  MERCADOPAGO: 'Mercado Pago (checkout)',
  NUVEMSHOP: 'Nuvemshop',
  LOJA_FISICA: 'Loja física',
};

/** Status que conta como FATURAMENTO no motor (receita confirmada). */
export const STATUS_FATURAMENTO = 'PAID';
export const STATUS_VENDA = ['PENDING', 'PAID', 'REFUNDED', 'CANCELLED'] as const;

/** Limites da curva ABC: A = 80% do faturamento acumulado, B = 15% (até 95%), C = 5%. */
export const ABC_LIMITE_A_PCT = 80;
export const ABC_LIMITE_B_PCT = 95;

/** Códigos de erro para valores ausentes (nunca fabricados). */

// ----------------------------------------------------------------------------
// 2) Motor puro — matemática compartilhada por SQL e memória (testada)
// ----------------------------------------------------------------------------

/** Arredonda em 4 casas, metade para LONGE do zero — idêntico ao ROUND(x, 4) do Postgres. */
export function round4(n: number): number {
  const sinal = n < 0 ? -1 : 1;
  return (sinal * Math.round(Math.abs(n) * 10000)) / 10000;
}

/** Arredonda em centavos inteiros, metade para LONGE do zero — idêntico ao ROUND(x) do Postgres. */
export function roundCents(n: number): number {
  const sinal = n < 0 ? -1 : 1;
  return sinal * Math.round(Math.abs(n));
}

/** NCM normalizado: apenas dígitos, no máximo 8 (6109.10.00 → 61091000). */
export function normalizarNcm(ncm: string | number | null | undefined): string {
  return String(ncm ?? '').replace(/[^0-9]/g, '').slice(0, 8);
}

/**
 * Alíquota efetiva de um NCM dado o cadastro de `impostos_ncm`.
 *
 * As chaves são NCMs normalizados: 8 dígitos (exato), 6/4/2 (prefixo) ou
 * '' (a linha-padrão — `ncm IS NULL` no banco). Vence sempre a chave MAIS
 * LONGA que é prefixo do NCM do produto — a chave vazia casa com qualquer
 * NCM e serve de padrão. Sem nenhuma chave casando: 0% (o motor nunca
 * inventa imposto). Espelha exatamente o COALESCE de subqueries do SQL.
 */
export function resolverAliquota(ncmProduto: string | null | undefined, chaves: Map<string, number>): number {
  const ncm = normalizarNcm(ncmProduto);
  let melhorChave: string | null = null;
  for (const chave of chaves.keys()) {
    // '' é prefixo de qualquer string — espelha o `LIKE chave || '%'` do SQL.
    if (ncm.startsWith(chave) && (melhorChave === null || chave.length > melhorChave.length)) {
      melhorChave = chave;
    }
  }
  return melhorChave === null ? 0 : Number(chaves.get(melhorChave)) || 0;
}

/** Fórmula exata do lucro bruto (tudo em centavos inteiros). */
export function calcularLucroBrutoCents(valorLiquidoCents: number, cmvCents: number, impostosCents: number, freteCents: number): number {
  return valorLiquidoCents - cmvCents - impostosCents - freteCents;
}

/** Margem percentual = lucro ÷ valor líquido × 100 (0 quando o líquido é 0/negativo). */
export function calcularMargemPct(lucroBrutoCents: number, valorLiquidoCents: number): number {
  return valorLiquidoCents > 0 ? round4((lucroBrutoCents * 100) / valorLiquidoCents) : 0;
}

export type LinhaFaturamento = { produtoId: number; faturamentoCents: number };
export type LinhaClassificada = LinhaFaturamento & { pctTotal: number; pctAcumulado: number; classe: 'A' | 'B' | 'C' };

/**
 * Curva ABC nativa: ordena por faturamento decrescente (empate pelo menor
 * produto_id, determinístico como no SQL) e classifica pelo ACUMULADO
 * ANTES da linha — a linha que CRUZA o limite pertence à classe anterior,
 * garantindo que a Classe A seja o menor prefixo que atinge 80% do
 * faturamento (o primeiro produto é sempre A, mesmo sozinho com 100%).
 * Total zero/negativo → sem classificação (nada é fabricado).
 */
export function classificarCurvaABC(linhas: LinhaFaturamento[]): LinhaClassificada[] {
  const ordenado = [...linhas].sort((a, b) => b.faturamentoCents - a.faturamentoCents || a.produtoId - b.produtoId);
  const total = ordenado.reduce((s, l) => s + l.faturamentoCents, 0);
  if (total <= 0) return [];
  let acumulado = 0;
  return ordenado.map((linha) => {
    const acumuladoAntes = acumulado;
    acumulado += linha.faturamentoCents;
    // Comparação inteira exata — idêntica ao SQL `(acum - fat) * 100 < total * limite`.
    const classe: 'A' | 'B' | 'C' =
      acumuladoAntes * 100 < total * ABC_LIMITE_A_PCT ? 'A' : acumuladoAntes * 100 < total * ABC_LIMITE_B_PCT ? 'B' : 'C';
    return {
      ...linha,
      pctTotal: round4((linha.faturamentoCents * 100) / total),
      pctAcumulado: round4((acumulado * 100) / total),
      classe,
    };
  });
}

export function grupoDoCanal(canal: string): CanalGrupo {
  return CANAL_PARA_GRUPO[canal] || 'ecommerce';
}

// ----------------------------------------------------------------------------
// Fuso do negócio: o DIA CIVIL é o de America/Sao_Paulo (Brasília).
//
// O filtro De/Até e o campo `data` de cada venda seguem o dia civil local.
// Sem isso, uma venda às 22h de Brasília (01h UTC do dia seguinte) caía no
// dia errado e no mês errado. Brasil não usa horário de verão desde 2019,
// então o deslocamento é fixo em UTC−03:00.
// ----------------------------------------------------------------------------

/** Deslocamento de Brasília em relação ao UTC, em horas (UTC−03:00). */
export const DESLOCAMENTO_NEGOCIO_HORAS = 3;

/** Instante UTC em que começa o dia civil `dia` (AAAA-MM-DD) em Brasília. */
export function inicioDiaNegocio(dia: string): Date {
  const [ano, mes, diaDoMes] = dia.split('-').map(Number);
  return new Date(Date.UTC(ano, mes - 1, diaDoMes, DESLOCAMENTO_NEGOCIO_HORAS, 0, 0, 0));
}

/** Instante UTC em que termina (exclusivo) o dia civil `dia` em Brasília. */
export function fimExclusivoDiaNegocio(dia: string): Date {
  return new Date(inicioDiaNegocio(dia).getTime() + 24 * 3600_000);
}

/** Dia civil (AAAA-MM-DD) de Brasília ao qual pertence um instante. */
export function diaDoNegocio(instante: Date): string {
  return new Date(instante.getTime() - DESLOCAMENTO_NEGOCIO_HORAS * 3600_000).toISOString().slice(0, 10);
}

// ----------------------------------------------------------------------------
// Escopo de empresa das leituras de BI (MULTIEMPRESA)
// ----------------------------------------------------------------------------

/**
 * Decide a empresa de uma leitura de BI a partir do ATOR autenticado.
 *
 *   • `empresa_id` pedido → exige concessão (403 se o ator não tem acesso);
 *   • sem pedido → empresa ativa da sessão (nunca "todas as empresas");
 *   • consolidar → só com `pode_consolidar` E `?consolidado=1` (escopo.consolidado).
 *
 * O valor vindo do cliente nunca vira autorização por si só.
 */
export function aplicarEscopoEmpresaBi(actor: AuthUser | null | undefined, filtros: FiltrosBi): FiltrosBi {
  if (filtros.empresaId !== null) {
    exigirEmpresaPermitida(actor as unknown as AuthUser, filtros.empresaId);
    return filtros;
  }
  const escopo = escopoDoAtor(actor as unknown as AuthUser);
  if (escopo.consolidado) return filtros;
  return { ...filtros, empresaId: escopo.empresaId };
}

// ----------------------------------------------------------------------------
// 3) Tipos de entrada/saída (contrato da API)
// ----------------------------------------------------------------------------

export type VendaNegocios = {
  id: string;
  reference: string;
  externalOrderId: string | null;
  status: string;
  canal: string;
  canalLabel: string;
  canalGrupo: CanalGrupo;
  grupoLabel: string;
  /** Dia civil de Brasília (YYYY-MM-DD) — o mesmo usado nos filtros De/Até. */
  data: string;
  mes: string;
  occurredAt: string;
  empresaId: number;
  quantidade: number;
  amountCents: number;
  netCents: number | null;
  cmvCents: number | null;
  taxCents: number | null;
  freightCents: number;
  grossProfitCents: number | null;
  marginPct: number | null;
  margemCalculadaEm: string | null;
  itens: number;
};

export type ItemVendaNegocios = {
  saleId: string;
  productId: number | null;
  sku: string | null;
  produto: string | null;
  tamanho: string | null;
  quantity: number;
  subtotalCents: number;
};

export type LinhaAbc = {
  empresaId: number;
  produtoId: number;
  sku: string | null;
  produto: string | null;
  classe: 'A' | 'B' | 'C';
  faturamentoCents: number;
  pctTotal: number;
  pctAcumulado: number;
};

/** Filtros ESTRITOS — nada além disto é aplicado; valores inválidos dão 400. */
export type FiltrosBi = {
  de: string | null;
  ate: string | null;
  empresaId: number | null;
  /** Valor original do filtro de canal (grupo ou canal específico). */
  canal: string | null;
  /** Canais resolvidos do filtro (null = todos). */
  canais: string[] | null;
  status: string | null;
  /** Escopo interno por ids (recalculo de venda específica). */
  ids: string[] | null;
};

export type JanelaAbc = { de: string | null; ate: string | null };

// ----------------------------------------------------------------------------
// 4) Validação estrita dos filtros de BI
// ----------------------------------------------------------------------------

function primeiroValor(v: unknown): string | null {
  if (typeof v === 'string') return v;
  if (Array.isArray(v) && typeof v[0] === 'string') return v[0] as string;
  return null;
}

function parseDataEstrita(valor: unknown, campo: 'De' | 'Até'): string | null {
  const bruto = primeiroValor(valor);
  if (bruto === null || bruto === '') return null;
  const dia = bruto.trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dia)) {
    throw new HttpError(400, `Período inválido: "${campo}" deve ser uma data no formato AAAA-MM-DD.`);
  }
  const d = new Date(`${dia}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== dia) {
    throw new HttpError(400, `Período inválido: "${campo}" não é uma data real (recebi "${dia}").`);
  }
  return dia;
}

/** Valida e normaliza os filtros estritos de período/empresa/canal/status. */
export function parseFiltrosBi(q: Record<string, unknown>): FiltrosBi {
  const de = parseDataEstrita(q.de, 'De');
  const ate = parseDataEstrita(q.ate, 'Até');
  if (de && ate && de > ate) {
    throw new HttpError(400, `Período inválido: "De" (${de}) é posterior a "Até" (${ate}).`);
  }

  let empresaId: number | null = null;
  const empresaBruta = primeiroValor(q.empresa_id);
  if (empresaBruta !== null && empresaBruta !== '') {
    const n = Number(empresaBruta);
    if (!Number.isInteger(n) || n <= 0) {
      throw new HttpError(400, `Filtro inválido: empresa_id deve ser um inteiro positivo (recebi "${empresaBruta}").`);
    }
    empresaId = n;
  }

  let canal: string | null = null;
  let canais: string[] | null = null;
  const canalBruto = primeiroValor(q.canal);
  if (canalBruto !== null && canalBruto !== '') {
    const valor = canalBruto.trim();
    const grupo = (Object.keys(GRUPOS_CANAL) as CanalGrupo[]).find((g) => g === valor);
    if (grupo) {
      canal = valor;
      canais = [...GRUPOS_CANAL[grupo].canais];
    } else if ((CANAIS_VENDA as readonly string[]).includes(valor)) {
      canal = valor;
      canais = [valor];
    } else {
      throw new HttpError(
        400,
        `Filtro inválido: canal desconhecido ("${valor}"). Use um grupo (${Object.keys(GRUPOS_CANAL).join(', ')}) ou um canal (${CANAIS_VENDA.join(', ')}).`
      );
    }
  }

  let status: string | null = null;
  const statusBruto = primeiroValor(q.status);
  if (statusBruto !== null && statusBruto !== '') {
    if (!(STATUS_VENDA as readonly string[]).includes(statusBruto)) {
      throw new HttpError(400, `Filtro inválido: status desconhecido ("${statusBruto}"). Use ${STATUS_VENDA.join(', ')}.`);
    }
    status = statusBruto;
  }

  return { de, ate, empresaId, canal, canais, status, ids: null };
}

// ----------------------------------------------------------------------------
// 5) Contrato do repositório (SQL × memória)
// ----------------------------------------------------------------------------

export type VendaManualInput = {
  canal: CanalVenda;
  empresaId: number;
  status: 'PAID' | 'PENDING';
  occurredAt: Date;
  freightCents: number;
  externalOrderId: string | null;
  currency: string;
  itens: { productId: number; sizeId: number | null; quantity: number; unitPriceCents: number; discountCents: number; subtotalCents: number }[];
  amountCents: number;
  quantidade: number;
};

export interface NegociosRepo {
  readonly kind: 'postgres' | 'memory';
  recalcularMargens(ids?: string[]): Promise<{ atualizadas: number }>;
  recalcularCurvaABC(janela?: JanelaAbc): Promise<{ classificados: number; empresas: number }>;
  listarVendas(f: FiltrosBi, limit?: number | null, offset?: number): Promise<VendaNegocios[]>;
  contarVendas(f: FiltrosBi): Promise<number>;
  listarItensVenda(f: FiltrosBi): Promise<ItemVendaNegocios[]>;
  curvaABC(empresaId: number | null, classe: string | null): Promise<LinhaAbc[]>;
  criarVendaManual(input: VendaManualInput, actor: AuthUser): Promise<VendaNegocios>;
}

function canalDeLinha(r: Record<string, any>): string {
  return String(r.channel ?? r.canal ?? 'BROBOND');
}

function paraVendaNegocios(r: Record<string, any>): VendaNegocios {
  const canal = canalDeLinha(r);
  const grupo = grupoDoCanal(canal);
  const occurredAt = r.occurred_at instanceof Date ? r.occurred_at.toISOString() : String(r.occurred_at || '');
  const instante = new Date(occurredAt);
  const data = Number.isNaN(instante.getTime()) ? '' : diaDoNegocio(instante);
  return {
    id: String(r.id),
    reference: String(r.reference || ''),
    externalOrderId: r.external_order_id === null || r.external_order_id === undefined ? null : String(r.external_order_id),
    status: String(r.status || 'PENDING'),
    canal,
    canalLabel: CANAL_LABEL[canal] || canal,
    canalGrupo: grupo,
    grupoLabel: GRUPOS_CANAL[grupo].label,
    data,
    mes: data.slice(0, 7),
    occurredAt,
    empresaId: Number(r.empresa_id || 1),
    quantidade: Number(r.quantity || 0),
    amountCents: Number(r.amount_cents || 0),
    netCents: r.net_cents === null || r.net_cents === undefined ? null : Number(r.net_cents),
    cmvCents: r.cmv_cents === null || r.cmv_cents === undefined ? null : Number(r.cmv_cents),
    taxCents: r.tax_cents === null || r.tax_cents === undefined ? null : Number(r.tax_cents),
    freightCents: Number(r.freight_cents || 0),
    grossProfitCents: r.gross_profit_cents === null || r.gross_profit_cents === undefined ? null : Number(r.gross_profit_cents),
    marginPct: r.margin_pct === null || r.margin_pct === undefined ? null : Number(r.margin_pct),
    margemCalculadaEm: r.margem_calculada_em ? (r.margem_calculada_em instanceof Date ? r.margem_calculada_em.toISOString() : String(r.margem_calculada_em)) : null,
    itens: Number(r.itens || 0),
  };
}

// ----------------------------------------------------------------------------
// 6) Repositório SQL — o motor de verdade (Postgres)
// ----------------------------------------------------------------------------

function q(text: string, params: unknown[] = [], tx?: PoolClient | null) {
  return tx ? tx.query(text, params as any[]) : query(text, params);
}

/** WHERE estrito e SARIAVÉL de `sales` a partir dos filtros de BI. */
function condicoesDeVenda(f: FiltrosBi, params: unknown[]): string[] {
  const conds: string[] = ['TRUE'];
  if (f.ids) {
    params.push(f.ids);
    conds.push(`s.id = ANY($${params.length}::text[])`);
  }
  if (f.status) {
    params.push(f.status);
    conds.push(`s.status::text = $${params.length}`);
  }
  if (f.de) {
    params.push(inicioDiaNegocio(f.de).toISOString());
    conds.push(`s.occurred_at >= $${params.length}::timestamptz`);
  }
  if (f.ate) {
    params.push(fimExclusivoDiaNegocio(f.ate).toISOString());
    conds.push(`s.occurred_at < $${params.length}::timestamptz`);
  }
  if (f.empresaId) {
    params.push(f.empresaId);
    conds.push(`s.empresa_id = $${params.length}::int`);
  }
  if (f.canais) {
    params.push(f.canais);
    conds.push(`s.channel::text = ANY($${params.length}::text[])`);
  }
  return conds;
}

/**
 * A QUERY ROBUSTA do motor de margem: UMA instrução UPDATE que recalcula
 * (e materializa nas colunas reais) o lucro bruto e a margem percentual de
 * cada venda, com:
 *
 *   • CMV — custo médio unitário por produto a partir da FICHA TÉCNICA,
 *     computada AO VIVO (Σ consumo × (1 + perda%) × custo médio do insumo
 *     + mão de obra + custos indiretos); se a ficha viva zerar, cai para o
 *     `custo_calculado` persistido e, por fim, para o `produtos.custo`;
 *   • IMPOSTOS — por item: ROUND(subtotal × alíquota/100), onde a alíquota
 *     vem do `impostos_ncm` pela chave (NCM exato > prefixo > padrão '');
 *   • FRETE PAGO — sales.freight_cents;
 *   • LÍQUIDO — sales.amount_cents (total pago, líquido de descontos).
 */
const SQL_RECALCULAR_MARGENS = `
  WITH vendas_escopo AS (
    SELECT s.id
      FROM sales s
     WHERE {{IDS}}
  ),
  produtos_escopo AS (
    SELECT DISTINCT si.product_id AS produto_id
      FROM sale_items si
      JOIN vendas_escopo ve ON ve.id = si.sale_id
     WHERE si.product_id IS NOT NULL
  ),
  custo_unit AS (
    SELECT pe.produto_id,
           (
             SELECT ROUND((COALESCE(fi.total, 0) + COALESCE(ft.mao_obra, 0) + COALESCE(ft.custos_indiretos, 0)) * 100)::bigint
               FROM fichas_tecnicas ft
               LEFT JOIN LATERAL (
                 SELECT SUM(COALESCE(ift.consumo, 0) * (1 + COALESCE(ift.perda_pct, 0) / 100) * COALESCE(i.custo_medio, 0)) AS total
                   FROM itens_ficha_tecnica ift
                   LEFT JOIN insumos i ON i.id = ift.insumo_id
                  WHERE ift.ficha_id = ft.id
               ) fi ON true
              WHERE ft.produto_id = pe.produto_id
              ORDER BY ft.id DESC
              LIMIT 1
           ) AS ficha_live_cents,
           (
             SELECT ROUND(ft2.custo_calculado * 100)::bigint
               FROM fichas_tecnicas ft2
              WHERE ft2.produto_id = pe.produto_id AND COALESCE(ft2.custo_calculado, 0) > 0
              ORDER BY ft2.id DESC
              LIMIT 1
           ) AS ficha_persistido_cents,
           (SELECT ROUND(COALESCE(p.custo, 0) * 100)::bigint FROM produtos p WHERE p.id = pe.produto_id) AS produto_custo_cents
      FROM produtos_escopo pe
  ),
  custo_final AS (
    SELECT cu.produto_id,
           CASE
             WHEN cu.ficha_live_cents IS NOT NULL AND cu.ficha_live_cents > 0 THEN cu.ficha_live_cents
             WHEN COALESCE(cu.ficha_persistido_cents, 0) > 0 THEN cu.ficha_persistido_cents
             ELSE COALESCE(cu.produto_custo_cents, 0)
           END AS cmv_unit_cents
      FROM custo_unit cu
  ),
  item_calc AS (
    SELECT si.sale_id,
           si.quantity,
           si.subtotal_cents,
           COALESCE(cf.cmv_unit_cents, 0) AS cmv_unit_cents,
           -- Alíquota por NCM: chave mais longa que casa com o NCM do
           -- produto (8 > 6 > 4 > 2 dígitos); sem casamento, a linha-padrão
           -- (ncm IS NULL); sem nada, 0%. Nunca inventa imposto.
           COALESCE(
             (SELECT a.aliquota_pct
                FROM impostos_ncm a
               WHERE a.ncm IS NOT NULL
                 AND regexp_replace(COALESCE(p.ncm, ''), '\\D', '', 'g') LIKE a.ncm || '%'
               ORDER BY LENGTH(a.ncm) DESC, a.id ASC
               LIMIT 1),
             (SELECT d.aliquota_pct FROM impostos_ncm d WHERE d.ncm IS NULL LIMIT 1),
             0
           ) AS aliquota_pct
      FROM sale_items si
      JOIN vendas_escopo ve ON ve.id = si.sale_id
      LEFT JOIN produtos p ON p.id = si.product_id
      LEFT JOIN custo_final cf ON cf.produto_id = si.product_id
  ),
  pedido_calc AS (
    SELECT s.id AS sale_id,
           s.amount_cents,
           COALESCE(s.freight_cents, 0) AS freight_cents,
           COALESCE(SUM(ic.quantity * ic.cmv_unit_cents), 0)::bigint AS cmv_cents,
           COALESCE(SUM(ROUND(ic.subtotal_cents * ic.aliquota_pct / 100)), 0)::bigint AS tax_cents
      FROM sales s
      LEFT JOIN item_calc ic ON ic.sale_id = s.id
     WHERE {{IDS}}
     GROUP BY s.id, s.amount_cents, s.freight_cents
  )
  UPDATE sales s
     SET net_cents            = pc.amount_cents,
         cmv_cents            = pc.cmv_cents,
         tax_cents            = pc.tax_cents,
         freight_cents        = pc.freight_cents,
         gross_profit_cents   = (pc.amount_cents - pc.cmv_cents - pc.tax_cents - pc.freight_cents),
         margin_pct           = CASE
                                  WHEN pc.amount_cents > 0 THEN
                                    ROUND((pc.amount_cents - pc.cmv_cents - pc.tax_cents - pc.freight_cents)::numeric * 100 / pc.amount_cents, 4)
                                  ELSE 0
                                END,
         margem_calculada_em  = now(),
         updated_at           = now()
    FROM pedido_calc pc
   WHERE s.id = pc.sale_id
  RETURNING s.id`;

/**
 * Escopo da query de margem: sem ids recalcula TODAS as vendas; com ids,
 * apenas as vendas informadas (recálculo cirúrgico pós-ingestão/venda
 * manual). O placeholder {{IDS}} aparece nas CTEs vendas_escopo e
 * pedido_calc — as duas varreduras ficam sempre no MESMO escopo.
 */
function sqlRecalcularMargens(ids?: string[]): { sql: string; params: unknown[] } {
  if (!ids || !ids.length) return { sql: SQL_RECALCULAR_MARGENS.replaceAll('{{IDS}}', 'TRUE'), params: [] };
  const cond = `s.id = ANY($1::text[])`;
  return { sql: SQL_RECALCULAR_MARGENS.replaceAll('{{IDS}}', cond), params: [ids] };
}

const sqlRepo: NegociosRepo = {
  kind: 'postgres',

  async recalcularMargens(ids?: string[]): Promise<{ atualizadas: number }> {
    const { sql, params } = sqlRecalcularMargens(ids);
    const { rowCount } = await q(sql, params);
    return { atualizadas: Number(rowCount ?? 0) };
  },

  async recalcularCurvaABC(janela?: JanelaAbc): Promise<{ classificados: number; empresas: number }> {
    const params: unknown[] = [];
    const janelaConds: string[] = [];
    if (janela?.de) {
      params.push(inicioDiaNegocio(janela.de).toISOString());
      janelaConds.push(`s.occurred_at >= $${params.length}::timestamptz`);
    }
    if (janela?.ate) {
      params.push(fimExclusivoDiaNegocio(janela.ate).toISOString());
      janelaConds.push(`s.occurred_at < $${params.length}::timestamptz`);
    }
    const janelaWhere = janelaConds.length ? `AND ${janelaConds.join(' AND ')}` : '';

    // Limites da janela gravados na classificação (início do dia civil de Brasília).
    const finalParams = [...params];
    let idxDe = 0;
    let idxAte = 0;
    if (janela?.de) {
      finalParams.push(inicioDiaNegocio(janela.de).toISOString());
      idxDe = finalParams.length;
    }
    if (janela?.ate) {
      finalParams.push(inicioDiaNegocio(janela.ate).toISOString());
      idxAte = finalParams.length;
    }

    return withTransaction(async (tx) => {
      await tx.query('DELETE FROM produto_abc');
      const { rows, rowCount } = await tx.query(
        `
        WITH faturamento AS (
          SELECT s.empresa_id, si.product_id, SUM(si.subtotal_cents)::bigint AS faturamento_cents
            FROM sales s
            JOIN sale_items si ON si.sale_id = s.id
           WHERE s.status = 'PAID'::sale_status
             AND si.product_id IS NOT NULL
             ${janelaWhere}
           GROUP BY s.empresa_id, si.product_id
        ),
        ordenado AS (
          SELECT f.*,
                 SUM(f.faturamento_cents) OVER (
                   PARTITION BY f.empresa_id
                   ORDER BY f.faturamento_cents DESC, f.product_id ASC
                   ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
                 ) AS acumulado_cents
            FROM faturamento f
        ),
        totais AS (
          SELECT empresa_id, SUM(faturamento_cents) AS total_cents FROM faturamento GROUP BY empresa_id
        )
        INSERT INTO produto_abc (empresa_id, produto_id, faturamento_cents, pct_total, pct_acumulado, classe, janela_de, janela_ate, calculado_em)
        SELECT o.empresa_id,
               o.product_id,
               o.faturamento_cents,
               CASE WHEN t.total_cents > 0 THEN ROUND(o.faturamento_cents::numeric * 100 / t.total_cents, 4) ELSE 0 END,
               CASE WHEN t.total_cents > 0 THEN ROUND(o.acumulado_cents::numeric * 100 / t.total_cents, 4) ELSE 0 END,
               CASE
                 WHEN t.total_cents <= 0 THEN 'C'
                 WHEN (o.acumulado_cents - o.faturamento_cents) * 100 < t.total_cents * ${ABC_LIMITE_A_PCT} THEN 'A'
                 WHEN (o.acumulado_cents - o.faturamento_cents) * 100 < t.total_cents * ${ABC_LIMITE_B_PCT} THEN 'B'
                 ELSE 'C'
               END,
               ${idxDe ? `$${idxDe}::timestamptz` : 'NULL'},
               ${idxAte ? `$${idxAte}::timestamptz` : 'NULL'},
               now()
          FROM ordenado o
          JOIN totais t ON t.empresa_id = o.empresa_id
        ON CONFLICT (empresa_id, produto_id) DO UPDATE SET
          faturamento_cents = EXCLUDED.faturamento_cents,
          pct_total = EXCLUDED.pct_total,
          pct_acumulado = EXCLUDED.pct_acumulado,
          classe = EXCLUDED.classe,
          janela_de = EXCLUDED.janela_de,
          janela_ate = EXCLUDED.janela_ate,
          calculado_em = EXCLUDED.calculado_em
        RETURNING empresa_id`,
        finalParams
      );
      const empresas = new Set(rows.map((r: Record<string, unknown>) => Number(r.empresa_id))).size;
      return { classificados: Number(rowCount ?? 0), empresas };
    });
  },

  async listarVendas(f: FiltrosBi, limit: number | null = 200, offset = 0): Promise<VendaNegocios[]> {
    const params: unknown[] = [];
    const conds = condicoesDeVenda(f, params);
    const limite = limit === null ? '' : `LIMIT ${Math.max(1, Math.trunc(limit))} OFFSET ${Math.max(0, Math.trunc(offset))}`;
    const { rows } = await q(
      `SELECT s.id, s.reference, s.external_order_id, s.status::text AS status,
              s.channel::text AS channel, s.occurred_at, s.empresa_id, s.quantity,
              s.amount_cents, s.net_cents, s.cmv_cents, s.tax_cents, s.freight_cents,
              s.gross_profit_cents, s.margin_pct, s.margem_calculada_em,
              (SELECT COUNT(*)::int FROM sale_items si WHERE si.sale_id = s.id) AS itens
         FROM sales s
        WHERE ${conds.join(' AND ')}
        ORDER BY s.occurred_at DESC, s.id DESC
        ${limite}`,
      params
    );
    return rows.map(paraVendaNegocios);
  },

  async contarVendas(f: FiltrosBi): Promise<number> {
    const params: unknown[] = [];
    const conds = condicoesDeVenda(f, params);
    const { rows } = await q(`SELECT COUNT(*)::int AS total FROM sales s WHERE ${conds.join(' AND ')}`, params);
    return Number(rows[0]?.total || 0);
  },

  async listarItensVenda(f: FiltrosBi): Promise<ItemVendaNegocios[]> {
    const params: unknown[] = [];
    const conds = condicoesDeVenda(f, params);
    const { rows } = await q(
      `SELECT si.sale_id, si.product_id, si.quantity, si.subtotal_cents,
              p.sku, p.nome, t.codigo AS tamanho_codigo
         FROM sale_items si
         JOIN sales s ON s.id = si.sale_id
         LEFT JOIN produtos p ON p.id = si.product_id
         LEFT JOIN tamanhos t ON t.id = si.size_id
        WHERE ${conds.join(' AND ')}
        ORDER BY si.sale_id, si.id`,
      params
    );
    return rows.map(
      (r: Record<string, any>): ItemVendaNegocios => ({
        saleId: String(r.sale_id),
        productId: r.product_id === null || r.product_id === undefined ? null : Number(r.product_id),
        sku: r.sku === null || r.sku === undefined ? null : String(r.sku),
        produto: r.nome === null || r.nome === undefined ? null : String(r.nome),
        tamanho: r.tamanho_codigo === null || r.tamanho_codigo === undefined ? null : String(r.tamanho_codigo),
        quantity: Number(r.quantity || 0),
        subtotalCents: Number(r.subtotal_cents || 0),
      })
    );
  },

  async curvaABC(empresaId: number | null, classe: string | null): Promise<LinhaAbc[]> {
    const params: unknown[] = [];
    const conds: string[] = ['TRUE'];
    if (empresaId) {
      params.push(empresaId);
      conds.push(`abc.empresa_id = $${params.length}::int`);
    }
    if (classe && ['A', 'B', 'C'].includes(classe)) {
      params.push(classe);
      conds.push(`abc.classe = $${params.length}`);
    }
    const { rows } = await q(
      `SELECT abc.empresa_id, abc.produto_id, abc.faturamento_cents, abc.pct_total, abc.pct_acumulado, abc.classe,
              p.sku, p.nome
         FROM produto_abc abc
         LEFT JOIN produtos p ON p.id = abc.produto_id
        WHERE ${conds.join(' AND ')}
        ORDER BY abc.faturamento_cents DESC, abc.produto_id ASC`,
      params
    );
    return rows.map((r: Record<string, any>) => ({
      empresaId: Number(r.empresa_id),
      produtoId: Number(r.produto_id),
      sku: r.sku === null || r.sku === undefined ? null : String(r.sku),
      produto: r.nome === null || r.nome === undefined ? null : String(r.nome),
      classe: String(r.classe) as 'A' | 'B' | 'C',
      faturamentoCents: Number(r.faturamento_cents || 0),
      pctTotal: Number(r.pct_total || 0),
      pctAcumulado: Number(r.pct_acumulado || 0),
    }));
  },

  async criarVendaManual(input: VendaManualInput, actor: AuthUser): Promise<VendaNegocios> {
    const id = crypto.randomUUID();
    const reference = `manual:${id}`;
    return withTransaction(async (tx) => {
      await tx.query(
        `INSERT INTO sales (id, reference, quantity, amount_cents, currency, status, occurred_at,
                           channel, external_order_id, usuario_id, empresa_id, freight_cents, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6::sale_status, $7, $8::sale_channel, $9, $10, $11, $12, now(), now())`,
        [
          id,
          reference,
          input.quantidade,
          input.amountCents,
          input.currency,
          input.status,
          input.occurredAt,
          input.canal,
          input.externalOrderId,
          actor.id,
          input.empresaId,
          input.freightCents,
        ]
      );
      for (const item of input.itens) {
        await tx.query(
          `INSERT INTO sale_items (id, sale_id, product_id, size_id, variacao_externa, quantity,
                                   unit_price_cents, discount_cents, subtotal_cents, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())`,
          [
            crypto.randomUUID(),
            id,
            item.productId,
            item.sizeId,
            null,
            item.quantity,
            item.unitPriceCents,
            item.discountCents,
            item.subtotalCents,
          ]
        );
      }
      // Margem da venda nova já sai materializada — a MESMA query do motor,
      // escopada à venda criada, dentro da MESMA transação.
      const { sql, params } = sqlRecalcularMargens([id]);
      await q(sql, params, tx);
      const { rows } = await tx.query(
        `SELECT s.id, s.reference, s.external_order_id, s.status::text AS status,
                s.channel::text AS channel, s.occurred_at, s.empresa_id, s.quantity,
                s.amount_cents, s.net_cents, s.cmv_cents, s.tax_cents, s.freight_cents,
                s.gross_profit_cents, s.margin_pct, s.margem_calculada_em,
                (SELECT COUNT(*)::int FROM sale_items si WHERE si.sale_id = s.id) AS itens
           FROM sales s
          WHERE s.id = $1
          LIMIT 1`,
        [id]
      );
      return paraVendaNegocios(rows[0]);
    });
  },
};

// ----------------------------------------------------------------------------
// 7) Repositório em memória (modo demonstração / suíte de testes)
// ----------------------------------------------------------------------------

type MemVenda = {
  id: string;
  reference: string;
  quantity: number;
  amount_cents: number;
  currency: string;
  status: string;
  occurred_at: Date;
  channel: string;
  external_order_id: string | null;
  usuario_id: number;
  empresa_id: number;
  freight_cents: number;
  net_cents: number | null;
  cmv_cents: number | null;
  tax_cents: number | null;
  gross_profit_cents: number | null;
  margin_pct: number | null;
  margem_calculada_em: Date | null;
  created_at: Date;
  updated_at: Date;
};

type MemItem = {
  id: string;
  sale_id: string;
  product_id: number | null;
  size_id: number | null;
  quantity: number;
  unit_price_cents: number;
  discount_cents: number;
  subtotal_cents: number;
  created_at: Date;
};

type MemAbc = {
  empresa_id: number;
  produto_id: number;
  faturamento_cents: number;
  pct_total: number;
  pct_acumulado: number;
  classe: 'A' | 'B' | 'C';
  janela_de: string | null;
  janela_ate: string | null;
  calculado_em: Date;
};

/** Estado do modo demonstração (não há `sales` sem Postgres). */
const memoria = {
  vendas: [] as MemVenda[],
  itens: [] as MemItem[],
  abc: [] as MemAbc[],
};

/** Reinicia o estado em memória (higienização entre cenários de teste). */
export function __reiniciarMemoriaNegocios(): void {
  memoria.vendas = [];
  memoria.itens = [];
  memoria.abc = [];
}

/** Custo médio unitário (centavos) pela ficha técnica — cadeia idêntica ao SQL. */
async function cmvUnitarioMemoria(custoPorProduto: Map<number, number>, produtoId: number): Promise<void> {
  if (custoPorProduto.has(produtoId)) return;
  const s = getStore();
  const produtos = await s.list(RESOURCES.produtos, { page: 1, pageSize: 100000 });
  const fichas = await s.list(RESOURCES.fichas, { page: 1, pageSize: 100000 });
  const linhasFicha = await s.list(RESOURCES.itens_ficha_tecnica, { page: 1, pageSize: 100000 });
  const insumos = await s.list(RESOURCES.insumos, { page: 1, pageSize: 100000 });
  const custoInsumo = new Map(insumos.rows.map((i) => [Number(i.id), Number(i.custo_medio || 0)]));

  const custoDe = (produtoId: number): number => {
    const produto = produtos.rows.find((p) => Number(p.id) === produtoId);
    if (!produto) return 0;
    const ficha = [...fichas.rows].filter((f) => Number(f.produto_id) === produtoId).sort((a, b) => Number(b.id) - Number(a.id))[0];
    if (ficha) {
      // Ficha viva: Σ consumo × (1 + perda%) × custo médio do insumo + mão de obra + indiretos.
      let insumosTotal = 0;
      for (const linha of linhasFicha.rows.filter((l) => Number(l.ficha_id) === Number(ficha.id))) {
        const consumo = Number(linha.consumo || 0);
        const perda = Number(linha.perda_pct || 0);
        insumosTotal += consumo * (1 + perda / 100) * (custoInsumo.get(Number(linha.insumo_id)) || 0);
      }
      const live = roundCents((insumosTotal + Number(ficha.mao_obra || 0) + Number(ficha.custos_indiretos || 0)) * 100);
      if (live > 0) return live;
      const persistido = roundCents(Number(ficha.custo_calculado || 0) * 100);
      if (persistido > 0) return persistido;
    }
    return roundCents(Number(produto.custo || 0) * 100);
  };

  for (const p of produtos.rows) custoPorProduto.set(Number(p.id), custoDe(Number(p.id)));
  if (!custoPorProduto.has(produtoId)) custoPorProduto.set(produtoId, 0);
}

/** Alíquotas cadastradas em `impostos_ncm` (via store — CRUD normal). */
async function chavesAliquotaMemoria(): Promise<Map<string, number>> {
  const s = getStore();
  const impostos = await s.list(RESOURCES.impostos_ncm, { page: 1, pageSize: 10000 });
  const chaves = new Map<string, number>();
  for (const row of impostos.rows) {
    const chave = normalizarNcm(String(row.ncm ?? ''));
    chaves.set(chave, Number(row.aliquota_pct || 0));
  }
  return chaves;
}

function passaFiltrosMemoria(v: MemVenda, f: FiltrosBi): boolean {
  const data = diaDoNegocio(v.occurred_at);
  if (f.ids && !f.ids.includes(v.id)) return false;
  if (f.status && v.status !== f.status) return false;
  if (f.de && data < f.de) return false;
  if (f.ate && data > f.ate) return false;
  if (f.empresaId && v.empresa_id !== f.empresaId) return false;
  if (f.canais && !f.canais.includes(v.channel)) return false;
  return true;
}

const memRepo: NegociosRepo = {
  kind: 'memory',

  async recalcularMargens(ids?: string[]): Promise<{ atualizadas: number }> {
    const escopo = ids && ids.length ? new Set(ids) : null;
    const alvo = memoria.vendas.filter((v) => !escopo || escopo.has(v.id));
    if (!alvo.length) return { atualizadas: 0 };

    // Catálogo + alíquotas em lote: custo médio (ficha técnica) e NCM.
    const s = getStore();
    const produtos = await s.list(RESOURCES.produtos, { page: 1, pageSize: 100000 });
    const ncmPorProduto = new Map(produtos.rows.map((p) => [Number(p.id), String(p.ncm ?? '')]));
    const custoPorProduto = new Map<number, number>();
    const chaves = await chavesAliquotaMemoria();

    let atualizadas = 0;
    for (const v of alvo) {
      const itens = memoria.itens.filter((i) => i.sale_id === v.id);
      let cmv = 0;
      let impostos = 0;
      for (const item of itens) {
        const pid = item.product_id;
        if (pid === null) continue;
        if (!custoPorProduto.has(pid)) await cmvUnitarioMemoria(custoPorProduto, pid);
        cmv += item.quantity * (custoPorProduto.get(pid) || 0);
        const aliquota = resolverAliquota(ncmPorProduto.get(pid) || '', chaves);
        impostos += roundCents((item.subtotal_cents * aliquota) / 100);
      }
      const net = v.amount_cents;
      const frete = v.freight_cents || 0;
      const lucro = calcularLucroBrutoCents(net, cmv, impostos, frete);
      v.net_cents = net;
      v.cmv_cents = cmv;
      v.tax_cents = impostos;
      v.gross_profit_cents = lucro;
      v.margin_pct = calcularMargemPct(lucro, net);
      v.margem_calculada_em = new Date();
      v.updated_at = new Date();
      atualizadas += 1;
    }
    return { atualizadas };
  },

  async recalcularCurvaABC(janela?: JanelaAbc): Promise<{ classificados: number; empresas: number }> {
    const faturamento = new Map<string, { empresa_id: number; produto_id: number; faturamento_cents: number }>();
    for (const v of memoria.vendas) {
      if (v.status !== STATUS_FATURAMENTO) continue;
      // Mesma semântica do SQL: dia civil de Brasília entre De e Até (inclusivos).
      const data = diaDoNegocio(v.occurred_at);
      if (janela?.de && data < janela.de) continue;
      if (janela?.ate && data > janela.ate) continue;
      for (const item of memoria.itens.filter((i) => i.sale_id === v.id)) {
        if (item.product_id === null) continue;
        const chave = `${v.empresa_id}:${item.product_id}`;
        const atual = faturamento.get(chave) || { empresa_id: v.empresa_id, produto_id: item.product_id, faturamento_cents: 0 };
        atual.faturamento_cents += item.subtotal_cents;
        faturamento.set(chave, atual);
      }
    }
    const porEmpresa = new Map<number, { empresa_id: number; produto_id: number; faturamento_cents: number }[]>();
    for (const linha of faturamento.values()) {
      const lista = porEmpresa.get(linha.empresa_id) || [];
      lista.push(linha);
      porEmpresa.set(linha.empresa_id, lista);
    }
    const linhas: MemAbc[] = [];
    const agora = new Date();
    for (const [empresaId, lista] of porEmpresa) {
      const classificadas = classificarCurvaABC(lista.map((l) => ({ produtoId: l.produto_id, faturamentoCents: l.faturamento_cents })));
      for (const c of classificadas) {
        linhas.push({
          empresa_id: empresaId,
          produto_id: c.produtoId,
          faturamento_cents: c.faturamentoCents,
          pct_total: c.pctTotal,
          pct_acumulado: c.pctAcumulado,
          classe: c.classe,
          janela_de: janela?.de ? `${janela.de}T00:00:00.000Z` : null,
          janela_ate: janela?.ate ? `${janela.ate}T00:00:00.000Z` : null,
          calculado_em: agora,
        });
      }
    }
    memoria.abc = linhas;
    return { classificados: linhas.length, empresas: porEmpresa.size };
  },

  async listarVendas(f: FiltrosBi, limit: number | null = 200, offset = 0): Promise<VendaNegocios[]> {
    const itensPorVenda = new Map<string, number>();
    for (const i of memoria.itens) itensPorVenda.set(i.sale_id, (itensPorVenda.get(i.sale_id) || 0) + 1);
    let linhas = memoria.vendas.filter((v) => passaFiltrosMemoria(v, f));
    linhas = linhas.sort((a, b) => b.occurred_at.getTime() - a.occurred_at.getTime() || (a.id < b.id ? 1 : -1));
    if (limit !== null) linhas = linhas.slice(Math.max(0, offset), Math.max(0, offset) + Math.max(1, limit));
    return linhas.map((v) => paraVendaNegocios({ ...v, itens: itensPorVenda.get(v.id) || 0 }));
  },

  async contarVendas(f: FiltrosBi): Promise<number> {
    return memoria.vendas.filter((v) => passaFiltrosMemoria(v, f)).length;
  },

  async listarItensVenda(f: FiltrosBi): Promise<ItemVendaNegocios[]> {
    const s = getStore();
    const produtos = await s.list(RESOURCES.produtos, { page: 1, pageSize: 100000 });
    const tamanhos = await s.list(RESOURCES.tamanhos, { page: 1, pageSize: 1000 });
    const produtoPorId = new Map(produtos.rows.map((p) => [Number(p.id), p]));
    const tamanhoPorId = new Map(tamanhos.rows.map((t) => [Number(t.id), String(t.codigo || '')]));
    const vendas = new Set(memoria.vendas.filter((v) => passaFiltrosMemoria(v, f)).map((v) => v.id));
    return memoria.itens
      .filter((i) => vendas.has(i.sale_id))
      .map((i) => {
        const produto = i.product_id !== null ? produtoPorId.get(i.product_id) : undefined;
        return {
          saleId: i.sale_id,
          productId: i.product_id,
          sku: produto ? String(produto.sku || '') || null : null,
          produto: produto ? String(produto.nome || '') || null : null,
          tamanho: i.size_id !== null ? tamanhoPorId.get(i.size_id) || null : null,
          quantity: i.quantity,
          subtotalCents: i.subtotal_cents,
        };
      });
  },

  async curvaABC(empresaId: number | null, classe: string | null): Promise<LinhaAbc[]> {
    const s = getStore();
    const produtos = await s.list(RESOURCES.produtos, { page: 1, pageSize: 100000 });
    const produtoPorId = new Map(produtos.rows.map((p) => [Number(p.id), p]));
    return memoria.abc
      .filter((l) => (empresaId ? l.empresa_id === empresaId : true) && (classe ? l.classe === classe : true))
      .sort((a, b) => b.faturamento_cents - a.faturamento_cents || a.produto_id - b.produto_id)
      .map((l) => {
        const produto = produtoPorId.get(l.produto_id);
        return {
          empresaId: l.empresa_id,
          produtoId: l.produto_id,
          sku: produto ? String(produto.sku || '') || null : null,
          produto: produto ? String(produto.nome || '') || null : null,
          classe: l.classe,
          faturamentoCents: l.faturamento_cents,
          pctTotal: l.pct_total,
          pctAcumulado: l.pct_acumulado,
        };
      });
  },

  async criarVendaManual(input: VendaManualInput, actor: AuthUser): Promise<VendaNegocios> {
    const id = crypto.randomUUID();
    const agora = new Date();
    const venda: MemVenda = {
      id,
      reference: `manual:${id}`,
      quantity: input.quantidade,
      amount_cents: input.amountCents,
      currency: input.currency,
      status: input.status,
      occurred_at: input.occurredAt,
      channel: input.canal,
      external_order_id: input.externalOrderId,
      usuario_id: actor.id || 0,
      empresa_id: input.empresaId,
      freight_cents: input.freightCents,
      net_cents: null,
      cmv_cents: null,
      tax_cents: null,
      gross_profit_cents: null,
      margin_pct: null,
      margem_calculada_em: null,
      created_at: agora,
      updated_at: agora,
    };
    memoria.vendas.push(venda);
    for (const item of input.itens) {
      memoria.itens.push({
        id: crypto.randomUUID(),
        sale_id: id,
        product_id: item.productId,
        size_id: item.sizeId,
        quantity: item.quantity,
        unit_price_cents: item.unitPriceCents,
        discount_cents: item.discountCents,
        subtotal_cents: item.subtotalCents,
        created_at: agora,
      });
    }
    await memRepo.recalcularMargens([id]);
    const vendas = await memRepo.listarVendas({ de: null, ate: null, empresaId: null, canal: null, canais: null, status: null, ids: [id] }, 1, 0);
    return vendas[0];
  },
};

/** Repositório ativo: SQL real quando há banco; memória no modo demonstração. */
export function repoNegocios(): NegociosRepo {
  return hasDatabaseUrl() ? sqlRepo : memRepo;
}

// ----------------------------------------------------------------------------
// 8) Agregadores do Dashboard (BI) — mesma matemática para os dois repositórios
// ----------------------------------------------------------------------------

const LIMITE_VENDAS_BI = 100_000;

function somarCents(vendas: VendaNegocios[], campo: 'netCents' | 'grossProfitCents' | 'cmvCents' | 'taxCents'): number {
  let total = 0;
  for (const v of vendas) {
    const valor = v[campo];
    if (valor !== null) total += valor;
  }
  return total;
}

/** KPIs + quebras do módulo 1. MEU NEGÓCIOS sobre as vendas filtradas. */
export function agregarResumo(vendas: VendaNegocios[], itens: ItemVendaNegocios[], abc: LinhaAbc[]) {
  const faturadas = vendas.filter((v) => v.status === STATUS_FATURAMENTO);
  const faturamentoCents = somarCents(faturadas, 'netCents');
  const cmvCents = somarCents(faturadas, 'cmvCents');
  const impostosCents = somarCents(faturadas, 'taxCents');
  const freteCents = faturadas.reduce((s, v) => s + (v.freightCents || 0), 0);
  const lucroBrutoCents = somarCents(faturadas, 'grossProfitCents');
  const semMargemCalculada = faturadas.filter((v) => v.grossProfitCents === null).length;

  const idsFaturadas = new Set(faturadas.map((v) => v.id));
  const grupos = Object.keys(GRUPOS_CANAL) as CanalGrupo[];
  const porCanal = grupos.map((grupo) => {
    const doGrupo = faturadas.filter((v) => v.canalGrupo === grupo);
    const fatGrupo = somarCents(doGrupo, 'netCents');
    const lucroGrupo = somarCents(doGrupo, 'grossProfitCents');
    return {
      grupo,
      label: GRUPOS_CANAL[grupo].label,
      canais: GRUPOS_CANAL[grupo].canais,
      faturamentoCents: fatGrupo,
      lucroBrutoCents: lucroGrupo,
      margemPct: calcularMargemPct(lucroGrupo, fatGrupo),
      pedidos: doGrupo.length,
    };
  });

  const porStatus = [...STATUS_VENDA].map((status) => {
    const doStatus = vendas.filter((v) => v.status === status);
    return { status, pedidos: doStatus.length, valorCents: somarCents(doStatus, 'netCents') };
  });

  const porMesMap = new Map<string, { faturamentoCents: number; lucroBrutoCents: number }>();
  for (const v of faturadas) {
    const atual = porMesMap.get(v.mes) || { faturamentoCents: 0, lucroBrutoCents: 0 };
    atual.faturamentoCents += v.netCents ?? 0;
    atual.lucroBrutoCents += v.grossProfitCents ?? 0;
    porMesMap.set(v.mes, atual);
  }
  const porMes = [...porMesMap.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([mes, valores]) => ({ mes, ...valores }));

  const itensFaturados = itens.filter((i) => idsFaturadas.has(i.saleId) && i.productId !== null);
  const porProduto = new Map<number, { productId: number; sku: string | null; produto: string | null; faturamentoCents: number; quantidade: number }>();
  for (const item of itensFaturados) {
    const pid = item.productId as number;
    const atual = porProduto.get(pid) || { productId: pid, sku: item.sku, produto: item.produto, faturamentoCents: 0, quantidade: 0 };
    atual.faturamentoCents += item.subtotalCents;
    atual.quantidade += item.quantity;
    porProduto.set(pid, atual);
  }
  const topProdutos = [...porProduto.values()].sort((a, b) => b.faturamentoCents - a.faturamentoCents).slice(0, 10);

  const abcResumo = (['A', 'B', 'C'] as const).map((classe) => {
    const linhas = abc.filter((l) => l.classe === classe);
    const faturamento = linhas.reduce((s, l) => s + l.faturamentoCents, 0);
    return { classe, itens: linhas.length, faturamentoCents: faturamento };
  });

  return {
    kpis: {
      faturamentoCents,
      pedidos: faturadas.length,
      ticketMedioCents: faturadas.length ? Math.round(faturamentoCents / faturadas.length) : 0,
      cmvCents,
      impostosCents,
      freteCents,
      lucroBrutoCents,
      margemPct: calcularMargemPct(lucroBrutoCents, faturamentoCents),
      pedidosPendentes: vendas.filter((v) => v.status === 'PENDING').length,
      /** Vendas PAID ainda sem margem materializada (motor a caminho). */
      semMargemCalculada,
    },
    porCanal,
    porStatus,
    porMes,
    topProdutos,
    abc: { resumo: abcResumo, totalFaturamentoCents: abc.reduce((s, l) => s + l.faturamentoCents, 0) },
  };
}

// ----------------------------------------------------------------------------
// 9) Validação da venda manual (Loja Física e checkouts próprios)
// ----------------------------------------------------------------------------

function inteiroObrigatorio(valor: unknown, campo: string, minimo = 0): number {
  const n = Number(valor);
  if (!Number.isInteger(n) || n < minimo) {
    throw new HttpError(400, `Campo inválido: ${campo} deve ser um inteiro ≥ ${minimo}.`);
  }
  return n;
}

export type VendaManualPayload = {
  canal?: string;
  empresa_id?: unknown;
  status?: string;
  occurred_at?: string;
  freight_cents?: unknown;
  external_order_id?: string | null;
  currency?: string;
  itens?: { product_id?: unknown; size_id?: unknown; quantity?: unknown; unit_price_cents?: unknown; discount_cents?: unknown }[];
};

/**
 * Normaliza e valida o payload da venda manual (400 em qualquer inconsistência).
 *
 * MULTIEMPRESA: `empresa_id` do corpo exige concessão do ator (403); sem ele, a
 * venda vai para a empresa ativa da sessão do ator.
 */
export async function validarVendaManual(body: unknown, actor?: AuthUser | null): Promise<VendaManualInput> {
  const payload = (body || {}) as VendaManualPayload;
  const canalBruto = String(payload.canal || 'LOJA_FISICA').trim();
  if (!(CANAIS_VENDA as readonly string[]).includes(canalBruto)) {
    throw new HttpError(400, `Canal inválido ("${canalBruto}"). Use: ${CANAIS_VENDA.join(', ')}.`);
  }
  const canal = canalBruto as CanalVenda;

  let empresaId = escopoDoAtor(actor as unknown as AuthUser).empresaId;
  if (payload.empresa_id !== undefined && payload.empresa_id !== null && payload.empresa_id !== '') {
    empresaId = inteiroObrigatorio(payload.empresa_id, 'empresa_id', 1);
    exigirEmpresaPermitida(actor as unknown as AuthUser, empresaId);
  }

  const statusBruto = String(payload.status || 'PAID').trim();
  if (!['PAID', 'PENDING'].includes(statusBruto)) {
    throw new HttpError(400, `Status inválido ("${statusBruto}"). Vendas manuais aceitam PAID ou PENDING.`);
  }

  let occurredAt: Date;
  if (payload.occurred_at === undefined || payload.occurred_at === null || payload.occurred_at === '') {
    occurredAt = new Date();
  } else {
    const bruto = String(payload.occurred_at).trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(bruto)) {
      occurredAt = new Date(`${bruto}T12:00:00.000Z`); // meio-dia UTC = 09h em Brasília: mesmo dia civil
    } else {
      occurredAt = new Date(bruto);
    }
    if (Number.isNaN(occurredAt.getTime())) throw new HttpError(400, 'Campo inválido: occurred_at deve ser uma data (AAAA-MM-DD ou ISO 8601).');
  }

  const freightCents = payload.freight_cents === undefined || payload.freight_cents === null ? 0 : inteiroObrigatorio(payload.freight_cents, 'freight_cents', 0);

  const currencyBruta = String(payload.currency || 'BRL').trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currencyBruta)) throw new HttpError(400, 'Campo inválido: currency deve ter 3 letras (ex.: BRL).');

  let externalOrderId: string | null = null;
  if (payload.external_order_id !== undefined && payload.external_order_id !== null && String(payload.external_order_id).trim() !== '') {
    externalOrderId = String(payload.external_order_id).trim().slice(0, 120);
  }

  if (!Array.isArray(payload.itens) || payload.itens.length === 0) {
    throw new HttpError(400, 'A venda manual precisa de ao menos um item (campo itens).');
  }
  if (payload.itens.length > 200) {
    throw new HttpError(400, 'A venda manual aceita no máximo 200 itens por pedido.');
  }

  // Integridade referencial validada ANTES de escrever: empresa ativa,
  // produtos do catálogo e tamanhos cadastrados (via store — vale para
  // Postgres e modo demonstração).
  const s = getStore();
  const empresas = await s.list(RESOURCES.empresas, { page: 1, pageSize: 1000 });
  if (!empresas.rows.some((e) => Number(e.id) === empresaId && e.ativo !== false)) {
    throw new HttpError(400, `Empresa inexistente ou inativa: empresa_id=${empresaId}.`);
  }

  const itens = payload.itens.map((item, indice) => {
    const productId = inteiroObrigatorio(item?.product_id, `itens[${indice}].product_id`, 1);
    const quantity = item?.quantity === undefined || item?.quantity === null ? 1 : inteiroObrigatorio(item?.quantity, `itens[${indice}].quantity`, 1);
    const unitPriceCents = inteiroObrigatorio(item?.unit_price_cents, `itens[${indice}].unit_price_cents`, 0);
    const discountCents = item?.discount_cents === undefined || item?.discount_cents === null ? 0 : inteiroObrigatorio(item?.discount_cents, `itens[${indice}].discount_cents`, 0);
    if (discountCents > quantity * unitPriceCents) {
      throw new HttpError(400, `Campo inválido: itens[${indice}].discount_cents não pode superar o total do item (${quantity * unitPriceCents}).`);
    }
    const subtotalCents = quantity * unitPriceCents - discountCents;
    let sizeId: number | null = null;
    if (item?.size_id !== undefined && item?.size_id !== null && item?.size_id !== '') {
      sizeId = inteiroObrigatorio(item?.size_id, `itens[${indice}].size_id`, 1);
    }
    return { productId, sizeId, quantity, unitPriceCents, discountCents, subtotalCents };
  });

  const produtos = await s.list(RESOURCES.produtos, { page: 1, pageSize: 100000 });
  const produtosExistentes = new Set(produtos.rows.map((p) => Number(p.id)));
  const faltando = [...new Set(itens.map((i) => i.productId))].filter((id) => !produtosExistentes.has(id));
  if (faltando.length) {
    throw new HttpError(400, `Produto(s) inexistente(s) no catálogo: ${faltando.join(', ')}.`);
  }

  const tamanhosPedidos = [...new Set(itens.filter((i) => i.sizeId !== null).map((i) => i.sizeId as number))];
  if (tamanhosPedidos.length) {
    const tamanhos = await s.list(RESOURCES.tamanhos, { page: 1, pageSize: 1000 });
    const existentes = new Set(tamanhos.rows.map((t) => Number(t.id)));
    const tamanhoFaltando = tamanhosPedidos.filter((id) => !existentes.has(id));
    if (tamanhoFaltando.length) {
      throw new HttpError(400, `Tamanho(s) inexistente(s): ${tamanhoFaltando.join(', ')}.`);
    }
  }

  return {
    canal,
    empresaId,
    status: statusBruto as 'PAID' | 'PENDING',
    occurredAt,
    freightCents,
    externalOrderId,
    currency: currencyBruta,
    itens,
    amountCents: itens.reduce((s, i) => s + i.subtotalCents, 0),
    quantidade: itens.reduce((s, i) => s + i.quantity, 0),
  };
}

// ----------------------------------------------------------------------------
// 10) Handlers HTTP (rotas montadas em index.ts)
// ----------------------------------------------------------------------------

function exigirGerente(actor: AuthUser): void {
  if (!['admin', 'gerente'].includes(actor.perfil || 'operador')) {
    throw new HttpError(403, 'Apenas gerentes e administradores acessam este módulo.');
  }
}

function queryDeRequisicao(req: Request): Record<string, unknown> {
  return (req.query || {}) as Record<string, unknown>;
}

function filtrosEco(f: FiltrosBi) {
  return {
    de: f.de,
    ate: f.ate,
    empresa_id: f.empresaId,
    canal: f.canal,
    grupo: f.canal && (Object.keys(GRUPOS_CANAL) as CanalGrupo[]).includes(f.canal as CanalGrupo) ? f.canal : null,
    status: f.status,
  };
}

/** GET /api/negocios/canais — mapa de canais × grupos (para filtros da UI). */
export async function negociosCanais(_req: Request, res: Response) {
  res.json({
    grupos: (Object.keys(GRUPOS_CANAL) as CanalGrupo[]).map((grupo) => ({
      grupo,
      label: GRUPOS_CANAL[grupo].label,
      canais: GRUPOS_CANAL[grupo].canais.map((canal) => ({ canal, label: CANAL_LABEL[canal] })),
    })),
    canais: CANAIS_VENDA.map((canal) => ({ canal, label: CANAL_LABEL[canal], grupo: grupoDoCanal(canal) })),
    statusFaturamento: STATUS_FATURAMENTO,
  });
}

/** GET /api/negocios/resumo — agregadores do Dashboard com filtros estritos. */
export async function negociosResumo(req: Request, res: Response) {
  const actor = currentUser(req);
  checkAccess(RESOURCES.vendas, actor, 'read');
  const filtros = aplicarEscopoEmpresaBi(actor, parseFiltrosBi(queryDeRequisicao(req)));
  const repo = repoNegocios();
  const [vendas, itens, abc] = await Promise.all([
    repo.listarVendas(filtros, LIMITE_VENDAS_BI, 0),
    repo.listarItensVenda(filtros),
    repo.curvaABC(filtros.empresaId, null),
  ]);
  res.json({ filtros: filtrosEco(filtros), ...agregarResumo(vendas, itens, abc) });
}

/** GET /api/negocios/margens — margem real por pedido (lucro bruto + margem %). */
export async function negociosMargens(req: Request, res: Response) {
  const actor = currentUser(req);
  checkAccess(RESOURCES.vendas, actor, 'read');
  exigirGerente(actor);
  const filtros = aplicarEscopoEmpresaBi(actor, parseFiltrosBi(queryDeRequisicao(req)));
  const limit = Math.min(1000, Math.max(1, Number(primeiroValor(req.query.limit)) || 200));
  const offset = Math.max(0, Number(primeiroValor(req.query.offset)) || 0);
  const repo = repoNegocios();
  const [todas, total] = await Promise.all([repo.listarVendas(filtros, LIMITE_VENDAS_BI, 0), repo.contarVendas(filtros)]);
  const linhas = todas.slice(offset, offset + limit);

  const valorLiquidoCents = somarCents(todas, 'netCents');
  const lucroBrutoCents = somarCents(todas, 'grossProfitCents');
  res.json({
    filtros: filtrosEco(filtros),
    totais: {
      pedidos: todas.length,
      valorLiquidoCents,
      cmvCents: somarCents(todas, 'cmvCents'),
      impostosCents: somarCents(todas, 'taxCents'),
      freteCents: todas.reduce((s, v) => s + (v.freightCents || 0), 0),
      lucroBrutoCents,
      margemPct: calcularMargemPct(lucroBrutoCents, valorLiquidoCents),
      semMargemCalculada: todas.filter((v) => v.grossProfitCents === null).length,
    },
    paginacao: { total, limit, offset },
    linhas,
  });
}

/** POST /api/negocios/margens/recalcular — dispara o motor de margem (gerente/admin). */
export async function negociosMargensRecalcular(req: Request, res: Response) {
  const actor = currentUser(req);
  checkAccess(RESOURCES.vendas, actor, 'read');
  exigirGerente(actor);
  const inicio = Date.now();
  const { atualizadas } = await repoNegocios().recalcularMargens();
  res.json({ ok: true, vendas: atualizadas, duracaoMs: Date.now() - inicio });
}

/** GET /api/negocios/abc — curva ABC persistida (classificação contínua). */
export async function negociosABC(req: Request, res: Response) {
  const actor = currentUser(req);
  checkAccess(RESOURCES.vendas, actor, 'read');
  const filtros = aplicarEscopoEmpresaBi(actor, parseFiltrosBi(queryDeRequisicao(req)));
  const classe = primeiroValor(req.query.classe);
  if (classe !== null && classe !== '' && !['A', 'B', 'C'].includes(classe)) {
    throw new HttpError(400, `Filtro inválido: classe deve ser A, B ou C (recebi "${classe}").`);
  }
  const repo = repoNegocios();
  const linhas = await repo.curvaABC(filtros.empresaId, classe || null);
  const resumo = (['A', 'B', 'C'] as const).map((c) => {
    const doGrupo = linhas.filter((l) => l.classe === c);
    return { classe: c, itens: doGrupo.length, faturamentoCents: doGrupo.reduce((s, l) => s + l.faturamentoCents, 0) };
  });
  const totalFaturamentoCents = linhas.reduce((s, l) => s + l.faturamentoCents, 0);
  res.json({
    filtros: { empresa_id: filtros.empresaId, classe: classe || null },
    resumo,
    totalFaturamentoCents,
    linhas,
  });
}

/** POST /api/negocios/abc/recalcular — reclassifica a curva (gerente/admin). */
export async function negociosABCRecalcular(req: Request, res: Response) {
  const actor = currentUser(req);
  checkAccess(RESOURCES.vendas, actor, 'read');
  exigirGerente(actor);
  const janela = parseFiltrosBi(queryDeRequisicao(req));
  const body = (req.body || {}) as Record<string, unknown>;
  const de = janela.de || (typeof body.de === 'string' ? parseDataEstrita(body.de, 'De') : null);
  const ate = janela.ate || (typeof body.ate === 'string' ? parseDataEstrita(body.ate, 'Até') : null);
  const inicio = Date.now();
  const { classificados, empresas } = await repoNegocios().recalcularCurvaABC(de || ate ? { de, ate } : undefined);
  res.json({ ok: true, produtos: classificados, empresas, janela: { de, ate }, duracaoMs: Date.now() - inicio });
}

/** POST /api/negocios/vendas — registra venda manual (Loja Física e checkouts). */
export async function negociosVendaManual(req: Request, res: Response) {
  const actor = currentUser(req);
  checkAccess(RESOURCES.vendas, actor, 'create');
  if (!actor?.id) throw new HttpError(401, 'Usuário autenticado é obrigatório para registrar uma venda manual.');
  const input = await validarVendaManual(req.body, actor);
  const repo = repoNegocios();
  const venda = await repo.criarVendaManual(input, actor);
  // Curva ABC atualizada na hora — classificação contínua.
  await repo.recalcularCurvaABC();
  await getStore().audit({
    usuario_id: actor.id || null,
    usuario: actor.name,
    acao: 'criar',
    recurso: 'sales',
    registro_id: null,
    descricao: `Venda manual ${venda.reference} (${CANAL_LABEL[venda.canal] || venda.canal}) — R$ ${(venda.amountCents / 100).toFixed(2)} em ${venda.quantidade} peça(s)`,
    dados: { id: venda.id, canal: venda.canal, empresa_id: venda.empresaId, amount_cents: venda.amountCents, frete_cents: venda.freightCents },
  });
  const itens = await repo.listarItensVenda({ de: null, ate: null, empresaId: null, canal: null, canais: null, status: null, ids: [venda.id] });
  res.status(201).json({ venda, itens });
}

// ----------------------------------------------------------------------------
// 11) Rotina em segundo plano — motor contínuo (margem + ABC)
// ----------------------------------------------------------------------------

let cicloRodando = false;
const vendasPendentes = new Set<string>();
let timerDebounce: ReturnType<typeof setTimeout> | null = null;
let timerCiclo: ReturnType<typeof setInterval> | null = null;

/** Intervalo do ciclo contínuo (env NEGOCIOS_AUTO_REFRESH_MS; padrão 15 min; 0 desliga). */
export const AUTO_REFRESH_MS_PADRAO = 15 * 60_000;

async function cicloDoMotor(): Promise<{ margens: number; abc: number } | null> {
  if (!hasDatabaseUrl() || cicloRodando) return null;
  cicloRodando = true;
  try {
    const repo = repoNegocios();
    const margens = await repo.recalcularMargens();
    const abc = await repo.recalcularCurvaABC();
    return { margens: margens.atualizadas, abc: abc.classificados };
  } catch (e) {
    console.warn('⚠️  Motor 1. MEU NEGÓCIOS: falha no ciclo de recálculo —', e instanceof Error ? e.message : e);
    return null;
  } finally {
    cicloRodando = false;
  }
}

/** Executa um ciclo completo do motor (usado pelo cron de agendados e testes). */
export async function atualizarMotorNegocios(): Promise<{ margens: number; abc: number }> {
  const resultado = await cicloDoMotor();
  return resultado ?? { margens: 0, abc: 0 };
}

/** Enfileira vendas ingeridas: recálculo coalescido (debounce) margem+ABC. */
export function agendarRecalculo(ids: string[]): void {
  if (!hasDatabaseUrl()) return;
  for (const id of ids) vendasPendentes.add(id);
  if (timerDebounce) return;
  timerDebounce = setTimeout(() => {
    timerDebounce = null;
    const pendentes = [...vendasPendentes];
    vendasPendentes.clear();
    if (!pendentes.length) return;
    void (async () => {
      try {
        const repo = repoNegocios();
        await repo.recalcularMargens(pendentes);
        await repo.recalcularCurvaABC();
      } catch (e) {
        console.warn('⚠️  Motor 1. MEU NEGÓCIOS: recálculo pós-ingestão falhou —', e instanceof Error ? e.message : e);
      }
    })();
  }, 5_000);
  timerDebounce.unref?.();
}

/**
 * Liga o motor no boot: escuta a ingestão de marketplaces (margem da venda
 * nova em segundos), roda um ciclo inicial e mantém a classificação ABC
 * contínua por intervalo. Só existe com Postgres — o modo demonstração não
 * tem `sales` ingeridas e nada é fabricado.
 */
export function initNegociosEngine(): void {
  if (!hasDatabaseUrl()) return;
  setOnSaleIngested(({ saleId }) => {
    agendarRecalculo([saleId]);
  });
  if (process.env.NODE_ENV === 'test') return;
  const intervalo = Number(process.env.NEGOCIOS_AUTO_REFRESH_MS ?? AUTO_REFRESH_MS_PADRAO);
  if (!Number.isFinite(intervalo) || intervalo <= 0) return;
  const inicial = setTimeout(() => {
    void cicloDoMotor().then((r) => {
      if (r) console.log(`📊 Motor 1. MEU NEGÓCIOS: ${r.margens} venda(s) com margem real, ${r.abc} produto(s) na curva ABC.`);
    });
  }, 10_000);
  inicial.unref?.();
  timerCiclo = setInterval(() => void cicloDoMotor(), intervalo);
  timerCiclo.unref?.();
}

/** Desliga timers (higienização de teste). */
export function __desligarMotorNegocios(): void {
  if (timerCiclo) clearInterval(timerCiclo);
  timerCiclo = null;
  if (timerDebounce) clearTimeout(timerDebounce);
  timerDebounce = null;
  vendasPendentes.clear();
}
