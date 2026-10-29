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
};

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
          .filter((i): i is ItemCarrinho => !!i && typeof i.produto_id === 'number')
          .map((i) => ({
            produto_id: i.produto_id,
            tamanho_id: i.tamanho_id ?? null,
            quantidade: Math.max(1, Math.min(99, Math.trunc(i.quantidade || 1))),
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

export function adicionarAoCarrinho(item: ItemCarrinho): void {
  const existente = estado.itens.find(
    (i) => i.produto_id === item.produto_id && (i.tamanho_id ?? null) === (item.tamanho_id ?? null)
  );
  estado = { ...estado, chave: novaChave(), itens: existente
    ? estado.itens.map((i) => i === existente ? { ...i, quantidade: Math.min(99, i.quantidade + item.quantidade) } : i)
    : [...estado.itens, { ...item }] };
  persistir();
}

export function alterarQuantidade(produtoId: number, tamanhoId: number | null, quantidade: number): void {
  const qtd = Math.trunc(quantidade);
  estado = {
    ...estado,
    chave: novaChave(),
    itens: estado.itens
      .map((i) => (i.produto_id === produtoId && (i.tamanho_id ?? null) === tamanhoId ? { ...i, quantidade: qtd } : i))
      .filter((i) => i.quantidade > 0),
  };
  persistir();
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
