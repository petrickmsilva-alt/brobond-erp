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
//   • o preço OFICIAL da condição é o preço FINAL daquela forma de pagamento:
//     um desconto adicional só incide com autorização EXPLÍCITA
//     (`politicas_comerciais.autoriza_cumulativo` ou uma regra de
//     `politica_comercial_descontos_cumulativos`). Sem isso, o preço de lista e
//     a política comercial NÃO são aplicados sobre a condição;
//   • preço de ATACADO ausente NÃO cai para o de varejo: o canal fica sem preço
//     (`null`) e a venda é recusada — nunca se cobra o preço de outro canal;
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
const dia = (v: unknown): string | null => (v === null || v === undefined || v === '' ? null : String(v).slice(0, 10));
const hoje = (): string => new Date().toISOString().slice(0, 10);
const R_CONDICAO_PRECO = () => getResource('produto_precos_condicao')!;
const R_POLITICA_MIN = () => getResource('politica_preco_minimo')!;
const R_MEMORIA = () => getResource('precificacao_memoria')!;
const R_CUMULATIVO = () => getResource('politica_comercial_descontos_cumulativos')!;

/**
 * Preço-base do canal na ficha do produto.
 *
 * ATACADO: usa `preco_atacado`; se ele NÃO existe, o canal fica SEM preço-base
 * (`null`) — nunca cai para o varejo. Cair para o varejo cobraria, no atacado, o
 * preço cheio do consumidor; é preferível recusar a venda a inventar um preço.
 * VAREJO: usa `preco_venda`.
 */
export function precoBaseDoCanal(produto: Row, canal: Canal): number | null {
  if (canal === 'atacado') {
    const v = Number(produto.preco_atacado);
    return Number.isFinite(v) && v > 0 ? round2(v) : null;
  }
  const v = Number(produto.preco_venda);
  return Number.isFinite(v) && v > 0 ? round2(v) : null;
}

// ----------------------------------------------------------------------------
// 1) Preço por condição de pagamento (dado de ENTRADA)
// ----------------------------------------------------------------------------

export type PrecoCondicaoDetalhe = {
  preco: number;
  id: number;
  vigencia_inicio: string | null;
  vigencia_fim: string | null;
};

/**
 * Preço oficial VIGENTE do produto para (canal, condição). Ausente → `null`
 * (nunca chute). Quando `referencia` é informada, devolve o preço que VALIA
 * naquela data (vigência início/fim); sem referência, só a linha vigente
 * (`vigencia_fim IS NULL`). A vigência é o que permite responder "quanto
 * custava nesta condição em maio?" sem apagar o preço anterior.
 */
export async function precoCondicaoDetalhe(
  produtoId: number,
  canal: Canal,
  condicao: string | null | undefined,
  escopo: EscopoEmpresa,
  tx?: Tx,
  referencia?: string
): Promise<PrecoCondicaoDetalhe | null> {
  if (!condicao) return null;
  const { rows } = await getStore().list(
    R_CONDICAO_PRECO(),
    { page: 1, pageSize: 500, filter: { empresa_id: escopo.empresaId, produto_id: produtoId, canal, condicao } },
    tx
  );
  const ref = dia(referencia);
  const validos = rows.filter((r) => {
    const ini = dia(r.vigencia_inicio);
    const fim = dia(r.vigencia_fim);
    if (ref) return (ini === null || ini <= ref) && (fim === null || fim >= ref);
    return fim === null;
  });
  // Preço vigente mais recente (maior `vigencia_inicio`; desempate por id).
  validos.sort(
    (a, b) => String(dia(b.vigencia_inicio) ?? '').localeCompare(String(dia(a.vigencia_inicio) ?? '')) || Number(b.id) - Number(a.id)
  );
  const linha = validos[0];
  if (!linha) return null;
  return {
    preco: round2(num(linha.preco)),
    id: Number(linha.id),
    vigencia_inicio: dia(linha.vigencia_inicio),
    vigencia_fim: dia(linha.vigencia_fim),
  };
}

/** Preço oficial do produto para (canal, condição). Ausente → `null` (nunca chute). */
export async function precoCondicao(
  produtoId: number,
  canal: Canal,
  condicao: string | null | undefined,
  escopo: EscopoEmpresa,
  tx?: Tx,
  referencia?: string
): Promise<number | null> {
  const d = await precoCondicaoDetalhe(produtoId, canal, condicao, escopo, tx, referencia);
  return d ? d.preco : null;
}

// ----------------------------------------------------------------------------
// 1b) Desconto ADICIONAL cumulativo (autorização explícita)
// ----------------------------------------------------------------------------

/**
 * Regra que AUTORIZA um desconto adicional sobre o preço oficial da condição.
 * Sem política que autorize e sem regra que case, o preço oficial é FINAL —
 * nenhum desconto é inventado.
 */
export async function descontoCumulativo(opts: {
  empresaId: number;
  canal: Canal;
  condicao?: string | null;
  clienteId?: number | null;
  produtoId?: number | null;
  referencia?: string;
  tx?: Tx;
}): Promise<{ id: number; nome: string; desconto_pct: number; escopo: string } | null> {
  const { rows } = await getStore().list(
    R_CUMULATIVO(),
    { page: 1, pageSize: 500, filter: { empresa_id: opts.empresaId } },
    opts.tx
  );
  const ref = dia(opts.referencia) ?? hoje();
  const peso: Record<string, number> = { geral: 0, canal: 1, condicao: 2, cliente: 3, produto: 4 };
  const validas = rows
    .filter((r) => r.ativo !== false)
    .filter((r) => {
      const ini = dia(r.inicio_em);
      const fim = dia(r.fim_em);
      return (ini === null || ini <= ref) && (fim === null || fim >= ref);
    })
    .filter((r) => r.canal === null || r.canal === undefined || r.canal === 'todos' || r.canal === opts.canal)
    .filter((r) => r.escopo !== 'condicao' || (!!opts.condicao && String(r.condicao) === String(opts.condicao)))
    .filter((r) => r.escopo !== 'cliente' || (opts.clienteId != null && Number(r.cliente_id) === Number(opts.clienteId)))
    .filter((r) => r.escopo !== 'produto' || (opts.produtoId != null && Number(r.produto_id) === Number(opts.produtoId)))
    .sort(
      (a, b) =>
        (peso[String(b.escopo)] ?? -1) - (peso[String(a.escopo)] ?? -1) ||
        num(b.prioridade) - num(a.prioridade) ||
        Number(b.id) - Number(a.id)
    );
  const r = validas[0];
  return r ? { id: Number(r.id), nome: String(r.nome), desconto_pct: num(r.desconto_pct), escopo: String(r.escopo) } : null;
}

// ----------------------------------------------------------------------------
// 2) Preço comercial resolvido (orquestração determinística e explicável)
// ----------------------------------------------------------------------------
export type PrecoComercial = {
  preco_lista: number | null; // preço da lista vigente (ou base do canal); null = canal sem preço
  preco_base: number | null; // base por canal (ficha), antes de lista/condição
  preco_condicao: number | null; // preço oficial da condição, se houver
  preco_aplicado: number | null; // após condição + desconto autorizado
  origem_preco: string; // 'lista' | 'condicao' | 'produto'
  desconto_pct: number; // desconto ADICIONAL autorizado (0 quando o preço é final)
  politica: PoliticaAplicada | null;
  regras: Record<string, unknown>; // trilha explicável (vai para a memória)
};

/**
 * Resolve o preço comercial de um produto para um canal e (opcionalmente) uma
 * condição de pagamento. A ORDEM é fixa e documentada:
 *
 *   1. preço OFICIAL da condição (se existir) — é o preço FINAL daquela forma
 *      de pagamento; só recebe desconto adicional com autorização explícita;
 *   2. senão, lista vigente → desconto da política comercial;
 *   3. senão, base do canal (`preco_atacado`/`preco_venda`) → desconto da
 *      política comercial. Se o canal não tem base, `preco_aplicado` é `null`.
 *
 * Cumulatividade: o desconto da política comercial sobre o preço de condição
 * SÓ incide quando a própria política traz `autoriza_cumulativo` OU existe uma
 * regra de `politica_comercial_descontos_cumulativos` que case. Caso contrário
 * a condição é final e o desconto adicional é 0 — evitando "desconto sobre
 * desconto" silencioso.
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

  // Política comercial (desconto por escopo/canal). Opcional: sem catálogo,
  // as regras de catálogo simplesmente não casam (o resolver já trata isso).
  const politica = await resolverPoliticaComercial({
    empresaId: escopo.empresaId,
    catalogo: opts.catalogo ?? { id: null, empresa_id: escopo.empresaId, colecao_id: produto.colecao_id ?? null },
    clienteId: opts.clienteId ?? null,
    canal,
  });

  // Condição de pagamento (preço oficial). Ausente → mantém o de lista.
  const condDet = await precoCondicaoDetalhe(produtoId, canal, opts.condicao, escopo, tx, opts.referencia);

  let precoAplicado: number | null;
  let origem: string;
  let descontoPct = 0;
  let cumulativo: { id: number; nome: string; desconto_pct: number; escopo: string } | null = null;

  if (condDet !== null) {
    origem = 'condicao';
    const autorizaPolitica = politica?.autoriza_cumulativo === true;
    cumulativo = await descontoCumulativo({
      empresaId: escopo.empresaId,
      canal,
      condicao: opts.condicao,
      clienteId: opts.clienteId ?? null,
      produtoId,
      referencia: opts.referencia,
      tx,
    });
    if (autorizaPolitica) descontoPct += politica?.desconto_pct ?? 0;
    if (cumulativo) descontoPct += cumulativo.desconto_pct;
    // Desconto adicional NUNCA passa de 100% (nem soma dois descontos absurdos).
    descontoPct = Math.min(100, descontoPct);
    precoAplicado = round2(condDet.preco * (1 - descontoPct / 100));
  } else if (precoLista !== null) {
    origem = resolvido.origem;
    precoAplicado = round2(precoComPolitica(precoLista, politica));
    descontoPct = politica?.desconto_pct ?? 0;
  } else {
    // Canal sem base e sem lista e sem condição: sem preço. NUNCA inventar.
    origem = 'produto';
    precoAplicado = null;
  }

  return {
    preco_base: base,
    preco_lista: precoLista,
    preco_condicao: condDet ? condDet.preco : null,
    preco_aplicado: precoAplicado,
    origem_preco: origem,
    desconto_pct: descontoPct,
    politica,
    regras: {
      canal,
      condicao: opts.condicao ?? null,
      lista_id: resolvido.lista_id,
      lista_nome: resolvido.lista_nome,
      condicao_preco_id: condDet?.id ?? null,
      condicao_vigencia_inicio: condDet?.vigencia_inicio ?? null,
      condicao_vigencia_fim: condDet?.vigencia_fim ?? null,
      politica_id: politica?.id ?? null,
      politica_escopo: politica?.escopo ?? null,
      politica_desconto_pct: politica?.desconto_pct ?? 0,
      autoriza_cumulativo: politica?.autoriza_cumulativo === true,
      desconto_cumulativo_id: cumulativo?.id ?? null,
      desconto_cumulativo_pct: cumulativo?.desconto_pct ?? 0,
      desconto_total_pct: descontoPct,
      preco_ausente: precoAplicado === null,
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
