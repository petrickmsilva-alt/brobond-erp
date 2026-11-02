// ============================================================================
// COTAÇÃO DO CARRINHO (cliente) — consome POST /api/loja/preview.
//
// O servidor é a ÚNICA autoridade de preço, estoque, desconto, frete e total.
// Este hook só:
//   • envia produto/tamanho/quantidade/cupom (nunca valores monetários);
//   • serializa as consultas (a mais recente SEMPRE vence: AbortController +
//     número de sequência — resposta antiga nunca sobrescreve a nova);
//   • expõe um estado EXPLÍCITO: LOADING | READY | EMPTY | ERROR | INVALID.
// ============================================================================
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { apiFetch, ApiError } from '../../../lib/api';
import type { Carrinho } from './carinho';

export type ItemCotacao = {
  produto_id: number;
  tamanho_id: number | null;
  quantidade: number;
  nome: string;
  sku: string;
  variante?: string | null;
  foto_url?: string | null;
  preco_unitario: number;
  preco_original: number | null;
  disponivel: number;
  subtotal: number;
  ok: boolean;
  aviso?: string;
  indisponivel?: boolean;
};

export type Cotacao = {
  payment_methods?: { code: string; max_installments: number; required_fields?: string[] }[];
  payment_methods_erro?: boolean;
  itens: ItemCotacao[];
  subtotal: number;
  cupom: { codigo: string; valido: boolean; aplicado: boolean; desconto: number; erro?: string } | null;
  promocao: { nome: string; desconto: number } | null;
  frete:
    | { disponivel: true; provedor: string; valor: number; gratis: boolean; prazoDias: number | null; observacao?: string }
    | { disponivel: false; provedor: string; motivo: string };
  desconto: number;
  desconto_origem: 'promocao' | 'cupom' | null;
  totais: { subtotal: number; desconto: number; frete: number; total: number };
  frete_indisponivel: boolean;
  frete_motivo?: string;
  pronto_para_checkout?: boolean;
  calculado_em?: string;
};

export type EstadoCarrinho = 'LOADING' | 'READY' | 'EMPTY' | 'ERROR' | 'INVALID';

export const MENSAGEM_ERRO_COTACAO = 'Não foi possível calcular o carrinho. Tente novamente.';

/** Chave estável do que o servidor precisa saber (itens + cupom). */
export function chaveDoCarrinho(c: Pick<Carrinho, 'itens' | 'cupom'>): string {
  return JSON.stringify([c.itens.map((i) => [i.produto_id, i.tamanho_id ?? null, i.quantidade]), c.cupom || '']);
}

/** Motivos (legíveis) pelos quais o carrinho não pode seguir ao checkout. */
export function motivosBloqueio(cotacao: Cotacao): string[] {
  const motivos: string[] = [];
  for (const i of cotacao.itens) if (!i.ok) motivos.push(`${i.nome}: ${i.aviso ?? 'indisponível'}`);
  if (cotacao.frete_indisponivel) motivos.push('Frete indisponível para esta configuração.');
  if (cotacao.cupom && !cotacao.cupom.valido) motivos.push(`Cupom ${cotacao.cupom.codigo}: ${cotacao.cupom.erro ?? 'não aplicado'}.`);
  if (cotacao.payment_methods_erro) motivos.push('Pagamento temporariamente indisponível. Tente novamente em instantes.');
  else if (cotacao.payment_methods && cotacao.payment_methods.length === 0 && motivos.length === 0) {
    motivos.push('Nenhum método de pagamento disponível para este pedido.');
  }
  if (cotacao.pronto_para_checkout === false && motivos.length === 0) motivos.push('O carrinho precisa de revisão antes do checkout.');
  return motivos;
}

export type CotacaoCarrinho = {
  estado: EstadoCarrinho;
  /** Última cotação recebida do servidor (pode estar defasada: veja `sincronizada`). */
  cotacao: Cotacao | null;
  /** `true` quando a cotação corresponde EXATAMENTE aos itens/cupom atuais. */
  sincronizada: boolean;
  /** Há uma consulta em andamento. */
  atualizando: boolean;
  erro: string;
  detalheErro: string;
  motivos: string[];
  recarregar: () => void;
};

const ATRASO_REVALIDACAO_MS = 120;

export function useCotacaoCarrinho(carrinho: Pick<Carrinho, 'itens' | 'cupom'>): CotacaoCarrinho {
  const chave = useMemo(() => chaveDoCarrinho(carrinho), [carrinho]);
  const itensRef = useRef(carrinho);
  itensRef.current = carrinho;

  const [cotacao, setCotacao] = useState<Cotacao | null>(null);
  const [chaveCotacao, setChaveCotacao] = useState<string | null>(null);
  const [atualizando, setAtualizando] = useState(false);
  const [erro, setErro] = useState('');
  const [detalheErro, setDetalheErro] = useState('');
  const [tentativa, setTentativa] = useState(0);

  const sequencia = useRef(0);
  const controlador = useRef<AbortController | null>(null);
  const jaTeveCotacao = useRef(false);

  const vazio = carrinho.itens.length === 0;

  useEffect(() => {
    // Cada execução invalida as anteriores (número de sequência) e aborta a requisição em voo.
    const minha = ++sequencia.current;
    controlador.current?.abort();
    if (vazio) {
      controlador.current = null;
      setCotacao(null);
      setChaveCotacao(null);
      setErro('');
      setDetalheErro('');
      setAtualizando(false);
      jaTeveCotacao.current = false;
      return;
    }
    const ctrl = new AbortController();
    controlador.current = ctrl;
    setAtualizando(true);
    setErro('');
    setDetalheErro('');
    const disparar = async () => {
      const { itens, cupom } = itensRef.current;
      try {
        const r = await apiFetch<Cotacao>('/loja/preview', {
          method: 'POST',
          signal: ctrl.signal,
          body: JSON.stringify({
            itens: itens.map((i) => ({ produto_id: i.produto_id, tamanho_id: i.tamanho_id, quantidade: i.quantidade })),
            cupom: cupom || undefined,
          }),
        });
        if (minha !== sequencia.current) return; // resposta antiga: descartada
        if (!r || !Array.isArray(r.itens) || !r.totais) throw new ApiError(0, 'Resposta de cotação inválida.');
        jaTeveCotacao.current = true;
        setCotacao(r);
        setChaveCotacao(chaveDoCarrinho(itensRef.current));
        setAtualizando(false);
      } catch (e) {
        if (minha !== sequencia.current) return;
        if (e instanceof DOMException && e.name === 'AbortError') return;
        setErro(MENSAGEM_ERRO_COTACAO);
        setDetalheErro(e instanceof ApiError && e.message ? e.message : '');
        setCotacao(null);
        setChaveCotacao(null);
        setAtualizando(false);
      }
    };
    // Primeira consulta imediata; mudanças seguintes são agrupadas por instantes.
    const timer = window.setTimeout(() => void disparar(), jaTeveCotacao.current ? ATRASO_REVALIDACAO_MS : 0);
    return () => {
      window.clearTimeout(timer);
      ctrl.abort();
    };
  }, [chave, vazio, tentativa]);

  const recarregar = useCallback(() => setTentativa((n) => n + 1), []);

  const sincronizada = !!cotacao && chaveCotacao === chave && !atualizando;
  const motivos = cotacao ? motivosBloqueio(cotacao) : [];

  let estado: EstadoCarrinho;
  if (vazio) estado = 'EMPTY';
  else if (erro) estado = 'ERROR';
  else if (!cotacao) estado = 'LOADING';
  else if (motivos.length > 0) estado = 'INVALID';
  else estado = 'READY';

  return { estado, cotacao, sincronizada, atualizando, erro, detalheErro, motivos, recarregar };
}
