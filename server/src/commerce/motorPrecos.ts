// ============================================================================
// COMMERCE ENGINE › MOTOR DE PREÇOS E RENTABILIDADE (Fase 3)
//
// Este módulo NÃO é um segundo motor: ele ORQUESTRA os serviços canônicos já
// existentes e acrescenta apenas o que faltava (condição de pagamento, preço
// mínimo e memória de cálculo):
//
//   • `listasPreco.precoDe`          → preço de lista vigente (tabela/versão);
//   • `politicasComerciais`          → desconto/limites por escopo e canal;
//   • `produtos.preco_venda`/`preco_atacado` → base por canal (compatibilidade);
//   • `produto_precos_condicao`      → preço OFICIAL por condição de pagamento
//                                       (novo; dado de ENTRADA, não fórmula);
//   • `politica_preco_minimo`        → bloqueio/alçada (novo; desligado por padrão).
//
// Princípios herdados do ERP:
//   • o servidor é a AUTORIDADE: nada de preço/desconto/imposto vindo do front;
//   • nunca inventar valor: condição/limite ausente é `null`, nunca um chute;
//   • margem é INFORMAÇÃO até que o bloqueio seja ligado explicitamente;
//   • toda decisão de preço pode ser registrada em `precificacao_memoria`
//     (append-only) — o "por que este preço?".
// ============================================================================
import { getResource } from '../resources';
import { getStore } from '../services';
import { round2 } from '../utils';
import { precoDe, type PrecoResolvido } from '../listasPreco';
import { resolverPoliticaComercial, precoComPolitica, type PoliticaAplicada } from '../politicasComerciais';
import type { EscopoEmpresa } from '../empresa';
import type { Row, Tx } from '../store';

export type Canal = 'atacado' | 'varejo';

const num = (v: unknown, padrao = 0): number => (Number.isFinite(Number(v)) ? Number(v) : padrao);
const R_CONDICAO_PRECO = () => getResource('produto_precos_condicao')!;
const R_POLITICA_MIN = () => getResource('politica_preco_minimo')!;
const R_MEMORIA = () => getResource('precificacao_memoria')!;

/** Preço-base do canal na ficha do produto (compatibilidade canônica). */
export function precoBaseDoCanal(produto: Row, canal: Canal): number {
  if (canal === 'atacado') return round2(num(produto.preco_atacado) || num(produto.preco_venda));
  return round2(num(produto.preco_venda));
}

// ----------------------------------------------------------------------------
// 1) Preço por condição de pagamento (dado de ENTRADA)
// ----------------------------------------------------------------------------

/** Preço oficial do produto para (canal, condição). Ausente → `null` (nunca chute). */
export async function precoCondicao(
  produtoId: number,
  canal: Canal,
  condicao: string | null | undefined,
  escopo: EscopoEmpresa,
  tx?: Tx
): Promise<number | null> {
  if (!condicao) return null;
  const linha = await getStore().findOneWhere(
    R_CONDICAO_PRECO(),
    { empresa_id: escopo.empresaId, produto_id: produtoId, canal, condicao },
    tx
  );
  return linha ? round2(num(linha.preco)) : null;
}

// ----------------------------------------------------------------------------
// 2) Preço comercial resolvido (orquestração determinística e explicável)
// ----------------------------------------------------------------------------
export type PrecoComercial = {
  preco_lista: number; // preço da lista vigente (ou base do canal)
  preco_base: number; // base por canal (ficha), antes de lista/condição
  preco_condicao: number | null; // preço oficial da condição, se houver
  preco_aplicado: number; // após condição + desconto de política
  origem_preco: string; // 'lista' | 'condicao' | 'produto'
  desconto_pct: number; // desconto da política comercial aplicado
  politica: PoliticaAplicada | null;
  regras: Record<string, unknown>; // trilha explicável (vai para a memória)
};

/**
 * Resolve o preço comercial de um produto para um canal e (opcionalmente) uma
 * condição de pagamento. A ORDEM é fixa e documentada:
 *   base do canal → lista vigente → condição de pagamento → desconto da política.
 * O desconto da política incide sobre o preço da condição quando ela existe
 * (a condição já é o preço comercial daquela forma de pagamento).
 */
export async function resolverPrecoComercial(opts: {
  produto: Row;
  canal: Canal;
  condicao?: string | null;
  escopo: EscopoEmpresa;
  catalogo?: Row | null;
  clienteId?: number | null;
  tx?: Tx;
  referencia?: string;
}): Promise<PrecoComercial> {
  const { produto, canal, escopo, tx } = opts;
  const produtoId = Number(produto.id);
  const base = precoBaseDoCanal(produto, canal);

  // Preço de lista (tabela versionada). `precoDe` cai na ficha (`preco_venda`)
  // quando não há lista; para o canal ATACADO a base correta é `preco_atacado`,
  // então só usamos o valor da lista quando ela realmente existe.
  const resolvido: PrecoResolvido = await precoDe(produto, escopo, tx, opts.referencia);
  const precoLista = resolvido.origem === 'lista' ? round2(resolvido.preco) : base;

  // Condição de pagamento (preço oficial). Ausente → mantém o de lista.
  const cond = await precoCondicao(produtoId, canal, opts.condicao, escopo, tx);
  const antesDesconto = cond !== null ? cond : precoLista;

  // Política comercial (desconto por escopo/canal). Opcional: sem catálogo,
  // as regras de catálogo simplesmente não casam (o resolver já trata isso).
  const politica = await resolverPoliticaComercial({
    empresaId: escopo.empresaId,
    catalogo: opts.catalogo ?? { id: null, empresa_id: escopo.empresaId, colecao_id: produto.colecao_id ?? null },
    clienteId: opts.clienteId ?? null,
    canal,
  });
  const precoAplicado = round2(precoComPolitica(antesDesconto, politica));

  const origem = cond !== null ? 'condicao' : resolvido.origem;
  return {
    preco_base: base,
    preco_lista: precoLista,
    preco_condicao: cond,
    preco_aplicado: precoAplicado,
    origem_preco: origem,
    desconto_pct: politica?.desconto_pct ?? 0,
    politica,
    regras: {
      canal,
      condicao: opts.condicao ?? null,
      lista_id: resolvido.lista_id,
      lista_nome: resolvido.lista_nome,
      politica_id: politica?.id ?? null,
      politica_escopo: politica?.escopo ?? null,
      desconto_politica_pct: politica?.desconto_pct ?? 0,
    },
  };
}

// ----------------------------------------------------------------------------
// 3) Rentabilidade (margem de contribuição) — função PURA
// ----------------------------------------------------------------------------
export type Rentabilidade = {
  receita_liquida: number;
  custo: number;
  impostos: number;
  frete: number;
  taxas: number;
  margem_valor: number;
  margem_pct: number | null;
};

/**
 * Margem de contribuição: receita líquida − custo − impostos − frete − taxas.
 * A receita líquida é o preço aplicado × quantidade (o desconto já está no
 * preço aplicado — evita dupla contagem). `margem_pct` é `null` quando a receita
 * é zero (nunca um 0% enganoso).
 */
export function avaliarRentabilidade(entrada: {
  preco_aplicado: number;
  quantidade: number;
  custo: number;
  impostos?: number;
  frete?: number;
  taxas?: number;
}): Rentabilidade {
  const qtd = Math.max(1, Math.floor(num(entrada.quantidade, 1)));
  const receita = round2(num(entrada.preco_aplicado) * qtd);
  const custo = round2(num(entrada.custo) * qtd);
  const impostos = round2(num(entrada.impostos));
  const frete = round2(num(entrada.frete));
  const taxas = round2(num(entrada.taxas));
  const margemValor = round2(receita - custo - impostos - frete - taxas);
  const margemPct = receita > 0 ? round2((margemValor / receita) * 100) : null;
  return { receita_liquida: receita, custo, impostos, frete, taxas, margem_valor: margemValor, margem_pct: margemPct };
}

// ----------------------------------------------------------------------------
// 4) Preço mínimo / alçada — função PURA
// ----------------------------------------------------------------------------
export type PoliticaMinimo = {
  margem_minima_pct: number | null;
  desconto_max_pct: number | null;
  bloqueio_ativo: boolean;
  exige_justificativa: boolean;
};

export type AvaliacaoMinimo = {
  margem_pct: number | null;
  bloqueado: boolean;
  exige_justificativa: boolean;
  motivos: string[];
};

/** Lê a política de preço mínimo da empresa (ausente → sem bloqueio). */
export async function politicaMinimo(empresaId: number, tx?: Tx): Promise<PoliticaMinimo | null> {
  const r = await getStore().findOneWhere(R_POLITICA_MIN(), { empresa_id: empresaId }, tx);
  if (!r) return null;
  return {
    margem_minima_pct: r.margem_minima_pct === null || r.margem_minima_pct === undefined ? null : num(r.margem_minima_pct),
    desconto_max_pct: r.desconto_max_pct === null || r.desconto_max_pct === undefined ? null : num(r.desconto_max_pct),
    bloqueio_ativo: r.bloqueio_ativo === true,
    exige_justificativa: r.exige_justificativa !== false,
  };
}

/**
 * Avalia a margem contra a política. Enquanto `bloqueio_ativo` for falso, a
 * função apenas INFORMA (`bloqueado: false`) — a missão proíbe inventar limite
 * e proíbe bloquear venda com valor arbitrário. Só bloqueia com parâmetro
 * cadastrado E bloqueio ligado.
 */
export function avaliarPrecoMinimo(entrada: {
  rentabilidade: Rentabilidade;
  desconto_pct: number;
  politica: PoliticaMinimo | null;
}): AvaliacaoMinimo {
  const p = entrada.politica;
  const motivos: string[] = [];
  if (!p || !p.bloqueio_ativo) {
    return { margem_pct: entrada.rentabilidade.margem_pct, bloqueado: false, exige_justificativa: false, motivos };
  }
  if (p.margem_minima_pct !== null && entrada.rentabilidade.margem_pct !== null && entrada.rentabilidade.margem_pct < p.margem_minima_pct) {
    motivos.push(`Margem ${entrada.rentabilidade.margem_pct}% abaixo do mínimo ${p.margem_minima_pct}%.`);
  }
  if (p.desconto_max_pct !== null && entrada.desconto_pct > p.desconto_max_pct) {
    motivos.push(`Desconto ${entrada.desconto_pct}% acima do máximo ${p.desconto_max_pct}%.`);
  }
  return {
    margem_pct: entrada.rentabilidade.margem_pct,
    bloqueado: motivos.length > 0,
    exige_justificativa: motivos.length > 0 && p.exige_justificativa,
    motivos,
  };
}

// ----------------------------------------------------------------------------
// 5) Memória de precificação (append-only)
// ----------------------------------------------------------------------------
export type MemoriaPrecificacao = {
  canal: Canal | 'todos';
  cliente_id?: number | null;
  venda_id?: number | null;
  produto_id: number;
  quantidade: number;
  condicao?: string | null;
  preco_lista: number;
  preco_aplicado: number;
  desconto_pct: number;
  custo: number;
  impostos?: number;
  frete?: number;
  taxas?: number;
  margem_valor: number;
  margem_pct: number | null;
  origem_preco: string;
  regras?: Record<string, unknown>;
  criado_por?: number | null;
};

/** Grava uma linha de memória de precificação. Nunca falha a operação chamadora
 * por causa de trilha: o chamador decide se usa `tx`. */
export async function registrarMemoriaPrecificacao(entrada: MemoriaPrecificacao, tx?: Tx): Promise<number | null> {
  const linha = await getStore().insert(
    R_MEMORIA(),
    {
      canal: entrada.canal,
      cliente_id: entrada.cliente_id ?? null,
      venda_id: entrada.venda_id ?? null,
      produto_id: entrada.produto_id,
      quantidade: Math.max(1, Math.floor(num(entrada.quantidade, 1))),
      condicao: entrada.condicao ?? null,
      preco_lista: round2(entrada.preco_lista),
      preco_aplicado: round2(entrada.preco_aplicado),
      desconto_pct: round2(entrada.desconto_pct),
      custo: round2(entrada.custo),
      impostos: round2(num(entrada.impostos)),
      frete: round2(num(entrada.frete)),
      taxas: round2(num(entrada.taxas)),
      margem_valor: round2(entrada.margem_valor),
      margem_pct: entrada.margem_pct === null ? null : round2(entrada.margem_pct),
      origem_preco: entrada.origem_preco,
      regras: entrada.regras ?? {},
      criado_por: entrada.criado_por ?? null,
    },
    tx
  );
  return linha ? Number(linha.id) : null;
}
