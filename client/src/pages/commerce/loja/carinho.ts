// ============================================================================
// CARRINHO DA VITRINE — estado local (localStorage) + chave de idempotência.
//
// O carrinho do cliente é só conveniência: PREÇO, ESTOQUE e TOTAL vêm do
// servidor em /api/loja/preview a cada mudança (revalidação). A `chave` viaja
// no checkout para o servidor deduplicar o reenvio (mesmo carrinho → mesmo
// pedido, mesma reserva, mesma cobrança).
// ============================================================================
import { useSyncExternalStore } from 'react';

export type ItemCarrinho = {
  produto_id: number;
  tamanho_id: number | null;
  quantidade: number;
  /**
   * Snapshot SÓ DE EXIBIÇÃO (mostrar a linha enquanto o servidor recalcula ou
   * se a cotação falhar). Nunca é enviado como preço e nunca é autoridade:
   * nome/SKU/preço/estoque reais vêm sempre de /api/loja/preview.
   */
  nome?: string;
  sku?: string;
  foto_url?: string | null;
};

export const QUANTIDADE_MAXIMA = 99;

/**
 * Quantidade válida de linha: inteiro de 1 a 99. Rejeita (null) 0, negativos,
 * NaN, ±Infinity, decimais "quebrados" e strings que não sejam inteiros.
 * Acima de 99 trava em 99 (limite do servidor).
 */
export function normalizarQuantidade(valor: unknown): number | null {
  let n: number;
  if (typeof valor === 'number') n = valor;
  else if (typeof valor === 'string' && /^\s*\d+\s*$/.test(valor)) n = Number(valor);
  else return null;
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) return null;
  return Math.min(QUANTIDADE_MAXIMA, n);
}

function textoCurto(v: unknown, max: number): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined;
}

export type Carrinho = {
  chave: string;
  cupom?: string;
  itens: ItemCarrinho[];
};

const CHAVE_STORAGE = 'brobond-loja-carrinho';

function novaChave(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

function ler(): Carrinho {
  if (typeof localStorage === 'undefined') return { chave: novaChave(), itens: [] };
  try {
    const bruto = localStorage.getItem(CHAVE_STORAGE);
    if (!bruto) return { chave: novaChave(), itens: [] };
    const parsed = JSON.parse(bruto) as Partial<Carrinho>;
    const itens = Array.isArray(parsed.itens)
      ? parsed.itens
          .filter((i): i is ItemCarrinho => !!i && typeof i.produto_id === 'number' && Number.isSafeInteger(i.produto_id) && i.produto_id > 0)
          .map((i) => ({
            produto_id: i.produto_id,
            tamanho_id: typeof i.tamanho_id === 'number' && Number.isSafeInteger(i.tamanho_id) && i.tamanho_id > 0 ? i.tamanho_id : null,
            quantidade: normalizarQuantidade(i.quantidade) ?? 1,
            nome: textoCurto(i.nome, 160),
            sku: textoCurto(i.sku, 120),
            foto_url: typeof i.foto_url === 'string' && /^(https?:)?\//.test(i.foto_url) ? i.foto_url.slice(0, 500) : null,
          }))
      : [];
    return { chave: typeof parsed.chave === 'string' && parsed.chave.length >= 8 ? parsed.chave : novaChave(), itens, cupom: typeof parsed.cupom === 'string' ? parsed.cupom.slice(0, 40) : '' };
  } catch {
    return { chave: novaChave(), itens: [] };
  }
}

let estado: Carrinho = typeof localStorage === 'undefined' ? { chave: 'inicial-sem-storage', itens: [] } : ler();
const ouvintes = new Set<() => void>();

function persistir() {
  try {
    localStorage.setItem(CHAVE_STORAGE, JSON.stringify(estado));
  } catch {
    /* storage indisponível (modo privado): o carrinho vive só em memória */
  }
  for (const fn of ouvintes) fn();
}

/**
 * Sincroniza abas: o carrinho vive no storage do navegador e outra aba pode
 * ter alterado. Só relê quando o conteúdo realmente mudou (referência estável
 * do snapshot para o useSyncExternalStore).
 */
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('storage', (ev) => {
    if (ev.key !== null && ev.key !== CHAVE_STORAGE) return;
    const lido = ler();
    if (JSON.stringify(lido) === JSON.stringify(estado)) return;
    estado = lido;
    for (const fn of ouvintes) fn();
  });
}

export function assinarCarrinho(fn: () => void): () => void {
  ouvintes.add(fn);
  return () => ouvintes.delete(fn);
}

export function lerCarrinho(): Carrinho {
  return estado;
}

export function useCarrinho(): Carrinho {
  return useSyncExternalStore(assinarCarrinho, lerCarrinho, lerCarrinho);
}

/** Adiciona (ou soma) uma linha. Devolve false e NÃO altera o carrinho se a quantidade for inválida. */
export function adicionarAoCarrinho(item: ItemCarrinho): boolean {
  const qtd = normalizarQuantidade(item.quantidade);
  if (qtd === null || !Number.isSafeInteger(item.produto_id) || item.produto_id <= 0) return false;
  const existente = estado.itens.find(
    (i) => i.produto_id === item.produto_id && (i.tamanho_id ?? null) === (item.tamanho_id ?? null)
  );
  estado = { ...estado, chave: novaChave(), itens: existente
    ? estado.itens.map((i) => i === existente ? { ...i, ...(item.nome ? { nome: item.nome, sku: item.sku, foto_url: item.foto_url ?? null } : {}), quantidade: Math.min(QUANTIDADE_MAXIMA, i.quantidade + qtd) } : i)
    : [...estado.itens, { ...item, tamanho_id: item.tamanho_id ?? null, quantidade: qtd }] };
  persistir();
  return true;
}

/**
 * Define a quantidade de uma linha (1–99). Valor inválido (0, negativo, NaN,
 * Infinity, string) é IGNORADO — nunca remove nem corrompe a linha. Para
 * remover use `removerDoCarrinho`.
 */
export function alterarQuantidade(produtoId: number, tamanhoId: number | null, quantidade: unknown): boolean {
  const qtd = normalizarQuantidade(quantidade);
  if (qtd === null) return false;
  const alvo = estado.itens.find((i) => i.produto_id === produtoId && (i.tamanho_id ?? null) === tamanhoId);
  if (!alvo || alvo.quantidade === qtd) return false;
  estado = {
    ...estado,
    chave: novaChave(),
    itens: estado.itens.map((i) => (i === alvo ? { ...i, quantidade: qtd } : i)),
  };
  persistir();
  return true;
}

export function removerDoCarrinho(produtoId: number, tamanhoId: number | null): void {
  estado = { ...estado, chave: novaChave(), itens: estado.itens.filter((i) => !(i.produto_id === produtoId && (i.tamanho_id ?? null) === tamanhoId)) };
  persistir();
}

export function limparCarrinho(): void {
  estado = { chave: novaChave(), itens: [] };
  persistir();
}

export function totalItens(c: Carrinho): number {
  return c.itens.reduce((s, i) => s + i.quantidade, 0);
}

export function definirCupom(codigo: string): void {
  const cupom = codigo.trim().toUpperCase().slice(0, 40);
  if ((estado.cupom || '') === cupom) return;
  estado = { ...estado, chave: novaChave(), cupom };
  persistir();
}
