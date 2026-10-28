// ============================================================================
// ESTOQUE — REGRA CANÔNICA ÚNICA (identidade, agregação e disponibilidade)
//
// Este módulo é a ÚNICA definição de "quanto tem" e "quanto pode vender" neste
// ERP. Grade/Estoque Físico, PDV, Vendas, busca de produtos, faturamento e
// estorno leem o saldo por aqui. Nenhum outro lugar soma `estoques` por conta
// própria — foi exatamente essa duplicação de regras que produziu a divergência
// "Grade M = 10 × PDV M = 1" (cada tela agregava uma dimensão diferente).
//
// ---------------------------------------------------------------------------
// 1. Identidade canônica da célula de estoque
// ---------------------------------------------------------------------------
//
//     empresa_id + produto_id + tamanho_id + local_id
//
// - `produto_id` é SEMPRE o produto dono do saldo. No modelo deste ERP a venda
//   e o estoque pertencem ao produto PAI; a variação empresta SKU, cor e preço.
//   Saldo do pai e saldo das variações nunca são somados: a variação é uma
//   visão comercial da MESMA célula do pai (ver `productSearch.ts`).
// - `tamanho_id` é a coluna da grade (`NULL` = "sem tamanho"). Vender 1 peça de
//   M mexe APENAS na célula do M.
// - `local_id` é o local de estoque dentro da empresa. O texto `local` existe
//   só para compatibilidade histórica; quem manda é o ID. Linhas antigas sem
//   `local_id` são vinculadas ao local pelo NOME quando ele é único na empresa
//   (mesma regra do backfill da migration 0030) — sem escrever nada no banco.
//
// Duas linhas que resolvem para a MESMA identidade são dado corrompido: a
// leitura falha fechada (409) em vez de somar em dobro ou escolher uma delas.
//
// ---------------------------------------------------------------------------
// 2. Estoque físico × estoque disponível para venda
// ---------------------------------------------------------------------------
//
// São duas perguntas diferentes e agora ambas são explícitas:
//
//   • ESTOQUE FÍSICO — soma de todas as células (produto, tamanho) em TODOS os
//     locais da empresa. É o que a Grade/Estoque Físico mostra com "Todos os
//     locais (soma)" e o que a coluna "Total" de um produto significa.
//   • ESTOQUE VENDÁVEL — o que UMA linha de venda consegue baixar. O
//     faturamento debita UM local por item: o local de saída da venda e, se ele
//     não cobre a quantidade, o Local padrão da empresa (ver `faturarVenda` em
//     `itens.ts`). Logo o vendável é o MAIOR entre essas duas células — nunca a
//     soma dos locais, e nunca um local escolhido pela tela.
//
// RESERVAS — desde a migration 0052 (`estoque_reservas`) existem quantidades
// COMPROMETIDAS que não podem ser vendidas: `reserva` (venda em separação),
// `empenho` (OP programada) e `bloqueio` (qualidade). A regra canônica passou a
// ser
//
//     disponível = físico − reservado − empenhado − bloqueado
//
// e ela é aplicada AQUI, uma única vez, em `reservasAtivasPorCelula` +
// `saldoDisponivelCelula` + `saldoVendavel`. O faturamento usa exatamente a
// mesma função (`itens.ts` → `saldoDisponivelCelula`), então a tela não promete
// saldo que a baixa recusa — e estoque bloqueado/empenhado não é vendido.
// `saldoCelula` continua sendo o FÍSICO puro, para quem precisa dele (estorno,
// transferência, conferência).
// ============================================================================
import { HttpError } from './errors';
import type { EscopoEmpresa } from './empresa';
import { getResource } from './resources';
import { getStore } from './services';
import type { Row, Tx } from './store';

/** Local de estoque resolvido (o ID é a identidade; o nome é rótulo). */
export type LocalEstoque = { id: number; nome: string; ativo?: boolean };

/** Célula de estoque já na identidade canônica. */
export type CelulaCanonica = {
  produto_id: number;
  tamanho_id: number | null;
  /** `null` somente quando a linha histórica não pôde ser vinculada a um local da empresa. */
  local_id: number | null;
  local: string;
  quantidade: number;
  estoque_min: number;
  /** O vínculo veio do próprio ID (`true`) ou do nome histórico (`false`). */
  vinculo_canonico: boolean;
};

/** Saldo agregado de um tamanho (em um local ou em todos). */
export type SaldoTamanho = { tamanho_id: number | null; quantidade: number; estoque_min: number };

/** Resposta canônica de "quanto posso vender deste tamanho". */
export type SaldoVendavel = {
  tamanho_id: number | null;
  /**
   * Quantidade que UMA linha de venda consegue baixar (maior célula DISPONÍVEL
   * dos locais de saída, já descontados reserva/empenho/bloqueio).
   */
  quantidade: number;
  /** Local que fornece essa quantidade (o de saída quando ele cobre, senão o padrão). */
  local_id: number | null;
  local: string | null;
  /** Detalhe por local de saída — auditável e exibível. */
  por_local: { local_id: number; local: string; quantidade: number }[];
  /** Soma de todas as células do produto+tamanho na empresa (estoque físico). */
  fisico: number;
  /** Células em locais que a venda não usa — não entram em `quantidade`. */
  outros_locais: number;
};

const LIMITE_CELULAS = 20_000;

export function normalizarTamanho(valor: unknown): number | null {
  if (valor === null || valor === undefined || valor === '') return null;
  const n = Number(valor);
  return Number.isFinite(n) ? n : null;
}

export function quantidade(valor: unknown): number {
  const n = Number(valor);
  return Number.isFinite(n) ? n : 0;
}

/** Chave da coluna de tamanho (0 = "sem tamanho", que a API usa como sentinela). */
export function chaveTamanho(tamanhoId: number | null): number {
  return tamanhoId === null ? 0 : tamanhoId;
}

// ---------------------------------------------------------------------------
// Locais
// ---------------------------------------------------------------------------

/** Local da empresa pelo ID. 404 quando não existe NESTA empresa (isolamento). */
export async function localDaEmpresa(escopo: EscopoEmpresa, localId: number, tx?: Tx): Promise<LocalEstoque> {
  if (!Number.isInteger(localId) || localId <= 0) throw new HttpError(404, 'Local não encontrado.');
  const local = await getStore().findOneWhere(getResource('locais')!, { id: localId, empresa_id: escopo.empresaId }, tx);
  if (!local) throw new HttpError(404, 'Local não encontrado.');
  return { id: Number(local.id), nome: String(local.nome), ativo: local.ativo !== false };
}

/**
 * Local padrão da empresa — o mesmo que o faturamento usa como fallback.
 * A regra é a de `getDefaultLocalInfo` em `services.ts` (um único padrão ativo,
 * senão o único local ativo), aqui reduzida ao que a leitura de saldo precisa:
 * nunca provisiona nem altera cadastro.
 */
export async function localPadraoDaEmpresa(escopo: EscopoEmpresa, tx?: Tx): Promise<LocalEstoque | null> {
  const s = getStore();
  const locais = getResource('locais')!;
  const padroes = await s.list(locais, { page: 1, pageSize: 2, filter: { empresa_id: escopo.empresaId, padrao: true } }, tx);
  if (padroes.total > 1) {
    throw new HttpError(409, 'A empresa ativa possui mais de um local padrão. Corrija a configuração antes de consultar o estoque.');
  }
  const padrao = padroes.rows[0];
  if (padrao && padrao.ativo !== false) return { id: Number(padrao.id), nome: String(padrao.nome) };
  const ativos = await s.list(locais, {
    page: 1,
    pageSize: 2,
    sort: 'nome',
    dir: 'asc',
    filter: { empresa_id: escopo.empresaId, ativo: true },
  }, tx);
  if (ativos.total > 1) return null;
  const unico = ativos.rows[0];
  return unico ? { id: Number(unico.id), nome: String(unico.nome) } : null;
}

/**
 * Locais em que uma linha de venda pode debitar, na ordem de preferência:
 * local de saída informado e, se diferente, o Local padrão.
 *
 * É a MESMA lista usada por `faturarVenda` (itens.ts) e pela disponibilidade
 * exibida no PDV/Vendas — por isso a tela nunca promete um saldo que o
 * faturamento não consegue baixar.
 */
export async function locaisDeSaida(
  escopo: EscopoEmpresa,
  localPreferidoId: number | null | undefined,
  tx?: Tx
): Promise<{ preferido: LocalEstoque; padrao: LocalEstoque | null; candidatos: LocalEstoque[] }> {
  const padrao = await localPadraoDaEmpresa(escopo, tx);
  const solicitado = localPreferidoId === null || localPreferidoId === undefined || localPreferidoId === ('' as unknown as number)
    ? padrao
    : await localDaEmpresa(escopo, Number(localPreferidoId), tx);
  const preferidoAtivo = solicitado && solicitado.ativo !== false ? solicitado : padrao;
  if (!preferidoAtivo) {
    throw new HttpError(409, 'A empresa ativa não possui um local de estoque ativo. Cadastre um local antes de vender.');
  }
  const candidatos = padrao && padrao.id !== preferidoAtivo.id ? [preferidoAtivo, padrao] : [preferidoAtivo];
  return { preferido: preferidoAtivo, padrao, candidatos };
}

// ---------------------------------------------------------------------------
// RESERVAS / EMPENHO / BLOQUEIO — a parte variável do "disponível"
// ---------------------------------------------------------------------------

/** Chave da célula usada pelo mapa de reservas. */
function chaveCelula(produtoId: number, tamanhoId: number | null, localId: number | null): string {
  return `${produtoId}:${tamanhoId === null ? 'null' : tamanhoId}:${localId === null ? 'null' : localId}`;
}

export type ReservasAtivas = {
  /** Total ativo por célula exata (produto + tamanho + local). */
  porCelula: Map<string, number>;
  /** Total ativo SEM local definido (produto + tamanho) — vale para qualquer local. */
  semLocal: Map<string, number>;
};

/**
 * Reservas ATIVAS (`status = 'ativa'`) da empresa, agregadas por célula.
 *
 * Uma reserva sem `local_id` é um compromisso do produto+tamanho como um todo;
 * ela é descontada de QUALQUER local candidato (critério conservador: melhor
 * recusar uma venda a prometer peça já comprometida).
 */
export async function reservasAtivasPorCelula(
  escopo: EscopoEmpresa,
  filtro: { produtoId?: number } = {},
  tx?: Tx
): Promise<ReservasAtivas> {
  const s = getStore();
  const where: Record<string, unknown> = { empresa_id: escopo.empresaId, status: 'ativa' };
  if (filtro.produtoId !== undefined) where.produto_id = filtro.produtoId;
  const lista = await s.list(getResource('estoque_reservas')!, { page: 1, pageSize: 100_000, filter: where }, tx);
  const porCelula = new Map<string, number>();
  const semLocal = new Map<string, number>();
  for (const r of lista.rows) {
    const qtd = quantidade(r.quantidade);
    if (!(qtd > 0)) continue;
    const produtoId = Number(r.produto_id);
    const tamanhoId = normalizarTamanho(r.tamanho_id);
    const localId = r.local_id === null || r.local_id === undefined || r.local_id === '' ? null : Number(r.local_id);
    if (localId === null) {
      const chave = chaveCelula(produtoId, tamanhoId, null);
      semLocal.set(chave, (semLocal.get(chave) ?? 0) + qtd);
    } else {
      const chave = chaveCelula(produtoId, tamanhoId, localId);
      porCelula.set(chave, (porCelula.get(chave) ?? 0) + qtd);
    }
  }
  return { porCelula, semLocal };
}

/** Reservado ativo de uma célula (inclui as reservas sem local do produto+tamanho). */
export function reservadoDaCelula(
  reservas: ReservasAtivas,
  produtoId: number,
  tamanhoId: number | null,
  localId: number
): number {
  return (
    (reservas.porCelula.get(chaveCelula(produtoId, tamanhoId, localId)) ?? 0) +
    (reservas.semLocal.get(chaveCelula(produtoId, tamanhoId, null)) ?? 0)
  );
}

/**
 * DISPONÍVEL da célula = físico − reservado − empenhado − bloqueado.
 *
 * Nunca negativo: um bloqueio maior que o saldo torna a célula indisponível
 * (0), não um crédito para vender.
 */
export async function saldoDisponivelCelula(
  escopo: EscopoEmpresa,
  produtoId: number,
  tamanhoId: number | null,
  localId: number,
  tx?: Tx
): Promise<{ fisico: number; reservado: number; disponivel: number }> {
  const alvo = normalizarTamanho(tamanhoId);
  const fisico = await saldoCelula(escopo, produtoId, alvo, localId, tx);
  const reservas = await reservasAtivasPorCelula(escopo, { produtoId }, tx);
  const reservado = reservadoDaCelula(reservas, produtoId, alvo, localId);
  return { fisico, reservado, disponivel: Math.max(0, fisico - reservado) };
}

// ---------------------------------------------------------------------------
// Células canônicas
// ---------------------------------------------------------------------------

type LocaisDaEmpresa = { localPorId: Map<number, string>; idPorNome: Map<string, number> };

async function locaisDaEmpresa(escopo: EscopoEmpresa, tx?: Tx): Promise<LocaisDaEmpresa> {
  const locais = await getStore().list(
    getResource('locais')!,
    { page: 1, pageSize: 5000, sort: 'nome', dir: 'asc', filter: { empresa_id: escopo.empresaId } },
    tx
  );
  if (locais.total > locais.rows.length) throw new HttpError(409, 'Os locais da empresa excedem o limite seguro de leitura do estoque.');
  const localPorId = new Map(locais.rows.map((local) => [Number(local.id), String(local.nome)]));
  const idPorNome = new Map<string, number>();
  for (const local of locais.rows) idPorNome.set(String(local.nome), Number(local.id));
  return { localPorId, idPorNome };
}

/** Converte as linhas de `estoques` para a identidade canônica, falhando fechado. */
function canonicalizar(saldos: Row[], locais: LocaisDaEmpresa): CelulaCanonica[] {
  const celulas: CelulaCanonica[] = [];
  const vistas = new Map<string, CelulaCanonica>();
  for (const row of saldos) {
    const produtoId = Number(row.produto_id);
    const tamanhoId = normalizarTamanho(row.tamanho_id);
    const texto = String(row.local ?? '').trim();
    const bruto = row.local_id === null || row.local_id === undefined || row.local_id === '' ? null : Number(row.local_id);
    let localId: number | null = null;
    if (bruto !== null) {
      if (!locais.localPorId.has(bruto)) {
        throw new HttpError(409, 'Há saldo vinculado a um local que não pertence a esta empresa. Nenhum saldo foi retornado.');
      }
      localId = bruto;
    } else if (texto && locais.idPorNome.has(texto)) {
      localId = locais.idPorNome.get(texto)!;
    }
    const local = localId !== null ? String(locais.localPorId.get(localId)) : texto;
    const celula: CelulaCanonica = {
      produto_id: produtoId,
      tamanho_id: tamanhoId,
      local_id: localId,
      local,
      quantidade: quantidade(row.quantidade),
      estoque_min: quantidade(row.estoque_min),
      vinculo_canonico: bruto !== null,
    };
    const chave = `${produtoId}:${chaveTamanho(tamanhoId)}:${localId === null ? `texto:${local.trim().toLowerCase()}` : localId}`;
    if (vistas.has(chave)) {
      throw new HttpError(
        409,
        `Há saldos duplicados para o produto #${produtoId}${tamanhoId === null ? '' : ` tam. #${tamanhoId}`} em "${local || 'local sem vínculo'}". ` +
          'Nenhum saldo foi retornado: somar as linhas inventaria estoque. Revise os registros duplicados antes de vender ou consultar.'
      );
    }
    vistas.set(chave, celula);
    celulas.push(celula);
  }
  return celulas;
}

/**
 * Todas as células de estoque de um produto, já na identidade canônica.
 *
 * - recorta pelo tenant (nunca vê saldo de outra empresa);
 * - vincula linhas históricas sem `local_id` pelo nome do local na empresa;
 * - falha fechada (409) quando a mesma identidade aparece duas vezes — somar
 *   seria inventar estoque e escolher uma linha seria esconder o dado.
 */
export async function celulasDoProduto(escopo: EscopoEmpresa, produtoId: number, tx?: Tx): Promise<CelulaCanonica[]> {
  const s = getStore();
  const empresaId = escopo.empresaId;
  if (!Number.isInteger(produtoId) || produtoId <= 0) throw new HttpError(404, 'Produto não encontrado.');
  const produto = await s.findOneWhere(getResource('produtos')!, { id: produtoId, empresa_id: empresaId }, tx);
  if (!produto) throw new HttpError(404, 'Produto não encontrado.');
  const saldos = await s.list(
    getResource('estoques')!,
    { page: 1, pageSize: LIMITE_CELULAS, filter: { empresa_id: empresaId, produto_id: produtoId } },
    tx
  );
  if (saldos.total > saldos.rows.length) {
    throw new HttpError(409, 'O produto excede o limite seguro de células de estoque. Nenhum saldo parcial foi retornado.');
  }
  return canonicalizar(saldos.rows, await locaisDaEmpresa(escopo, tx));
}

/**
 * Mesma regra canônica em lote (Grade/Estoque Físico): uma leitura de saldos e
 * uma de locais para a empresa inteira, sem N+1 e sem agregação paralela.
 */
export async function celulasDaEmpresa(escopo: EscopoEmpresa, tx?: Tx): Promise<CelulaCanonica[]> {
  const s = getStore();
  const saldos = await s.list(getResource('estoques')!, { page: 1, pageSize: LIMITE_CELULAS, filter: { empresa_id: escopo.empresaId } }, tx);
  if (saldos.total > saldos.rows.length) {
    throw new HttpError(409, 'O estoque da empresa excede o limite seguro de células. Nenhum saldo parcial foi retornado.');
  }
  return canonicalizar(saldos.rows, await locaisDaEmpresa(escopo, tx));
}

/** Célula exata (produto + tamanho + local) — a identidade do faturamento. */
export async function saldoCelula(
  escopo: EscopoEmpresa,
  produtoId: number,
  tamanhoId: number | null,
  localId: number,
  tx?: Tx
): Promise<number> {
  const alvo = normalizarTamanho(tamanhoId);
  const local = await localDaEmpresa(escopo, localId, tx);
  const celulas = await celulasDoProduto(escopo, produtoId, tx);
  return celulas
    .filter((celula) => chaveTamanho(celula.tamanho_id) === chaveTamanho(alvo) && celula.local_id === local.id)
    .reduce((soma, celula) => soma + celula.quantidade, 0);
}

/** Agrega células por tamanho. A soma é sempre dentro da MESMA identidade. */
export function agregarPorTamanho(celulas: CelulaCanonica[]): Map<number, SaldoTamanho> {
  const porTamanho = new Map<number, SaldoTamanho>();
  for (const celula of celulas) {
    const chave = chaveTamanho(celula.tamanho_id);
    const atual = porTamanho.get(chave) ?? { tamanho_id: celula.tamanho_id, quantidade: 0, estoque_min: 0 };
    atual.quantidade += celula.quantidade;
    atual.estoque_min += celula.estoque_min;
    porTamanho.set(chave, atual);
  }
  return porTamanho;
}

/**
 * Saldo por tamanho. Sem `localId`, soma TODOS os locais (estoque físico).
 * Com `localId`, devolve a célula daquele local — nunca a soma dos locais.
 */
export async function saldoPorTamanho(
  escopo: EscopoEmpresa,
  produtoId: number,
  opcoes: { localId?: number | null } = {},
  tx?: Tx
): Promise<Map<number, SaldoTamanho>> {
  const celulas = await celulasDoProduto(escopo, produtoId, tx);
  const localId = opcoes.localId === null || opcoes.localId === undefined || opcoes.localId === ('' as unknown as number)
    ? null
    : Number(opcoes.localId);
  if (localId !== null) await localDaEmpresa(escopo, localId, tx);
  const escopoLocal = localId === null ? celulas : celulas.filter((celula) => celula.local_id === localId);
  return agregarPorTamanho(escopoLocal);
}

/**
 * Disponibilidade de venda de um tamanho: o que UMA linha consegue baixar.
 *
 * Regra (idêntica à de `faturarVenda`): o faturamento debita o local de saída e,
 * se ele não cobrir a quantidade, o Local padrão. Portanto a quantidade
 * vendável é a MAIOR célula entre os locais candidatos; `local_id`/`local`
 * devolvem de onde ela sai. O físico total aparece em `fisico` para a tela
 * explicar a diferença sem recalcular nada.
 */
export async function saldoVendavel(
  escopo: EscopoEmpresa,
  produtoId: number,
  tamanhoId: number | null,
  localPreferidoId: number | null | undefined,
  tx?: Tx
): Promise<SaldoVendavel> {
  const alvo = normalizarTamanho(tamanhoId);
  const { candidatos } = await locaisDeSaida(escopo, localPreferidoId, tx);
  const celulas = await celulasDoProduto(escopo, produtoId, tx).then((todas) =>
    todas.filter((celula) => chaveTamanho(celula.tamanho_id) === chaveTamanho(alvo))
  );
  // DISPONÍVEL = físico − reservado/empenhado/bloqueado, por local candidato.
  // Sem isso a tela oferecia peça já comprometida (bloqueio de qualidade, OP
  // empenhada) e o faturamento recusava depois — duas regras de disponibilidade.
  const reservas = await reservasAtivasPorCelula(escopo, { produtoId }, tx);
  const porLocal = candidatos.map((local) => ({
    local_id: local.id,
    local: local.nome,
    quantidade: Math.max(
      0,
      celulas.filter((celula) => celula.local_id === local.id).reduce((soma, celula) => soma + celula.quantidade, 0) -
        reservadoDaCelula(reservas, produtoId, alvo, local.id)
    ),
  }));
  const fisico = celulas.reduce((soma, celula) => soma + celula.quantidade, 0);
  let melhor = porLocal[0];
  for (const item of porLocal.slice(1)) if (item.quantidade > melhor.quantidade) melhor = item;
  const dosCandidatos = porLocal.reduce((soma, item) => soma + item.quantidade, 0);
  return {
    tamanho_id: alvo,
    quantidade: melhor?.quantidade ?? 0,
    local_id: melhor?.local_id ?? null,
    local: melhor?.local ?? null,
    por_local: porLocal,
    fisico,
    outros_locais: Math.max(0, fisico - dosCandidatos),
  };
}
