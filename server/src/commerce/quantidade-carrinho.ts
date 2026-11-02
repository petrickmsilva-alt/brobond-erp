// ============================================================================
// CARRINHO — VALIDAÇÃO ESTRITA DA ALTERAÇÃO DE QUANTIDADE (server-side).
//
// Este módulo é PURO (sem banco, sem Request/Response) para poder ser testado
// isoladamente. A regra é simples e inegociável:
//
//   • `quantity` só é aceito como NUMBER inteiro, finito, 1..99;
//   • strings (mesmo "2"), null, undefined, boolean, objeto, array, 0,
//     negativos, decimais, NaN e ±Infinity são REJEITADOS (nunca coerced);
//   • só os campos produto_id / tamanho_id / quantidade / cupom são lidos.
//     `total`, `unit_price`, `discount`, `freight`, `preco`, `empresa_id`
//     enviados pelo browser são IGNORADOS — o servidor é a única autoridade.
//
// A empresa NUNCA vem do corpo: o handler resolve o tenant por
// `exigirVitrine()` (env/unicidade da configuração) e o carrinho é resolvido
// por `carregarVitrine(empresaId)`, que filtra por `empresa_id`.
// ============================================================================
import { HttpError } from '../errors';

/** Limite operacional do carrinho (mesmo teto do preview e do checkout). */
export const QUANTIDADE_MAXIMA_CARRINHO = 99;

/** Devolve a quantidade válida ou `null` — NUNCA converte tipo. */
export function quantidadeValida(valor: unknown): number | null {
  if (typeof valor !== 'number') return null;
  if (!Number.isFinite(valor) || !Number.isInteger(valor)) return null;
  if (valor < 1 || valor > QUANTIDADE_MAXIMA_CARRINHO) return null;
  return valor;
}

export type LinhaQuantidade = {
  produto_id: number;
  tamanho_id: number | null;
  quantidade: number;
};

export type CorpoQuantidade = {
  alvo: LinhaQuantidade;
  itens: LinhaQuantidade[];
  cupom: string;
};

function erro(mensagem: string): never {
  throw new HttpError(400, mensagem, { itens: 'Quantidade inválida' });
}

function objeto(valor: unknown): valor is Record<string, unknown> {
  return !!valor && typeof valor === 'object' && !Array.isArray(valor);
}

function idProduto(valor: unknown): number {
  if (typeof valor !== 'number' || !Number.isSafeInteger(valor) || valor <= 0) erro('Item do carrinho sem produto.');
  return valor;
}

function idTamanho(valor: unknown): number | null {
  if (valor == null || valor === '') return null;
  if (typeof valor !== 'number' || !Number.isSafeInteger(valor) || valor <= 0) erro('Tamanho inválido no carrinho.');
  return valor;
}

function linha(bruto: unknown): LinhaQuantidade {
  if (!objeto(bruto)) erro('Item do carrinho inválido.');
  const quantidade = quantidadeValida(bruto.quantidade);
  if (quantidade === null) erro('Quantidade inválida (1 a 99) no carrinho.');
  return {
    produto_id: idProduto(bruto.produto_id),
    tamanho_id: idTamanho(bruto.tamanho_id),
    quantidade,
  };
}

export function chaveLinha(linhaAlvo: Pick<LinhaQuantidade, 'produto_id' | 'tamanho_id'>): string {
  return `${linhaAlvo.produto_id}:${linhaAlvo.tamanho_id ?? ''}`;
}

/**
 * Valida o corpo de POST /api/loja/carrinho/quantidade e devolve SOMENTE os
 * campos que o servidor aceita. Qualquer campo monetário/de tenant é descartado
 * aqui (não existe caminho para ele chegar ao cálculo).
 */
export function validarCorpoQuantidade(bruto: unknown): CorpoQuantidade {
  if (!objeto(bruto)) erro('Corpo da requisição inválido.');
  const alvo = linha(bruto.alvo);
  if (!Array.isArray(bruto.itens) || bruto.itens.length === 0 || bruto.itens.length > 30) erro('O carrinho está vazio ou excede 30 linhas.');
  const itens = bruto.itens.map(linha);
  const chaves = new Set<string>();
  for (const item of itens) {
    const chave = chaveLinha(item);
    if (chaves.has(chave)) erro('Item duplicado no carrinho. Atualize a quantidade na mesma linha.');
    chaves.add(chave);
  }
  const alvoNoCarrinho = itens.find((i) => chaveLinha(i) === chaveLinha(alvo));
  if (!alvoNoCarrinho || alvoNoCarrinho.quantidade !== alvo.quantidade) {
    erro('A quantidade solicitada não corresponde ao carrinho enviado.');
  }
  const cupom = typeof bruto.cupom === 'string' ? bruto.cupom.slice(0, 40) : '';
  return { alvo, itens, cupom };
}
