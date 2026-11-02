// ============================================================================
// CARRINHO — CONTROLADOR DE QUANTIDADE (+ / −) COM CONFIRMAÇÃO DO SERVIDOR.
//
// Antes: `onClick` chamava `alterarQuantidade()` direto, escrevendo a intenção
// no localStorage SEM nenhuma confirmação. A única ida ao servidor era o
// preview "dispare e esqueça" (que podia ser abortado/descartado pela guarda
// de sequência ou falhar), de modo que a UI podia ficar em quantidade que o
// servidor nunca aceitou — e o "+" era travado por um `disponivel` em cache no
// navegador, sem nenhuma explicação.
//
// Agora o fluxo é ponta a ponta:
//
//   clique → intenção (memória, NÃO persistida) → POST /loja/carrinho/quantidade
//          → validação estrita + tenant + estoque REAL no servidor → resposta
//          → SÓ ENTÃO `alterarQuantidade()` grava o estado confirmado
//          → preview recalcula subtotal/desconto/frete/total → UI
//
// Proteções: uma única requisição em voo por linha, AbortController + número
// de sequência por linha (resposta antiga nunca sobrescreve a nova), intenção
// mais nova sempre substitui a anterior, erro inline com nova tentativa e
// ZERO optimistic update. `Remover` continua sendo a única ação de exclusão.
// ============================================================================
import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch, ApiError } from '../../../lib/api';
import { QUANTIDADE_MAXIMA, alterarQuantidade, normalizarQuantidade, type Carrinho, type ItemCarrinho } from './carinho';
import type { Cotacao } from './cotacao';

export const CAMINHO_QUANTIDADE = '/loja/carrinho/quantidade';
export const MENSAGEM_ERRO_QUANTIDADE = 'Não foi possível atualizar a quantidade. Tente novamente.';

type RespostaQuantidade = {
  produto_id: number;
  tamanho_id: number | null;
  quantidade: number;
  disponivel: number;
  cotacao?: Cotacao;
};

/** Chave estável de uma linha (produto + tamanho/variação). */
export function chaveLinhaCarrinho(item: Pick<ItemCarrinho, 'produto_id' | 'tamanho_id'>): string {
  return `${item.produto_id}:${item.tamanho_id ?? ''}`;
}

export type EstadoQuantidadeLinha = {
  /** Há mutação em voo (ou intenção aguardando confirmação) para esta linha. */
  pendente: boolean;
  /** Quantidade proposta, ainda NÃO confirmada pelo servidor. */
  desejada: number | null;
  erro: string;
  aviso: string;
  /** Repete a última intenção recusada (botão inline "Tentar novamente"). */
  temRetry: boolean;
};

function semChave(map: Record<string, string>, chave: string): Record<string, string> {
  if (!(chave in map)) return map;
  const proximo = { ...map };
  delete proximo[chave];
  return proximo;
}

export function useQuantidadeCarrinho(carrinho: Carrinho): {
  estado: (item: ItemCarrinho) => EstadoQuantidadeLinha;
  alterar: (item: ItemCarrinho, delta: 1 | -1) => void;
  tentarNovamente: (item: ItemCarrinho) => void;
} {
  const carrinhoRef = useRef(carrinho);
  carrinhoRef.current = carrinho;

  /** Última intenção por linha (não é o estado confirmado!). */
  const desejada = useRef(new Map<string, number>());
  /** Última intenção recusada, para retry inline. */
  const ultimaRecusada = useRef(new Map<string, number>());
  /** Guarda de sequência por linha: só a resposta da última requisição vale. */
  const sequencia = useRef(new Map<string, number>());
  const controladores = useRef(new Map<string, AbortController>());
  const emVoo = useRef(new Map<string, boolean>());

  const [pendentes, setPendentes] = useState<Record<string, number>>({});
  const [erros, setErros] = useState<Record<string, string>>({});
  const [avisos, setAvisos] = useState<Record<string, string>>({});
  const [retries, setRetries] = useState<Record<string, boolean>>({});

  const limparMensagens = useCallback((chave: string) => {
    setErros((prev) => semChave(prev, chave));
    setAvisos((prev) => semChave(prev, chave));
    setRetries((prev) => {
      if (!prev[chave]) return prev;
      const proximo = { ...prev };
      delete proximo[chave];
      return proximo;
    });
    ultimaRecusada.current.delete(chave);
  }, []);

  const encerrarPendente = useCallback((chave: string) => {
    setPendentes((prev) => {
      if (!(chave in prev)) return prev;
      const proximo = { ...prev };
      delete proximo[chave];
      return proximo;
    });
  }, []);

  /** Envia a intenção atual de uma linha. Nunca chamado sem intenção válida. */
  const enviar = useCallback((chave: string): void => {
    const destino = desejada.current.get(chave);
    if (destino === undefined || emVoo.current.get(chave)) return;
    const atual = carrinhoRef.current;
    const linha = atual.itens.find((i) => chaveLinhaCarrinho(i) === chave);
    if (!linha) {
      desejada.current.delete(chave);
      encerrarPendente(chave);
      return;
    }

    const minha = (sequencia.current.get(chave) ?? 0) + 1;
    sequencia.current.set(chave, minha);
    const controlador = new AbortController();
    controladores.current.set(chave, controlador);
    emVoo.current.set(chave, true);

    // Só identidade + quantidade + cupom viajam. Nunca preço/desconto/frete/total.
    const itens = atual.itens.map((i) => ({
      produto_id: i.produto_id,
      tamanho_id: i.tamanho_id ?? null,
      quantidade: chaveLinhaCarrinho(i) === chave ? destino : i.quantidade,
    }));

    apiFetch<RespostaQuantidade>(CAMINHO_QUANTIDADE, {
      method: 'POST',
      signal: controlador.signal,
      body: JSON.stringify({
        alvo: { produto_id: linha.produto_id, tamanho_id: linha.tamanho_id ?? null, quantidade: destino },
        itens,
        ...(atual.cupom ? { cupom: atual.cupom } : {}),
      }),
    })
      .then((resposta) => {
        if (minha !== sequencia.current.get(chave)) return; // resposta obsoleta: descartada
        const confirmada = normalizarQuantidade(resposta?.quantidade);
        if (resposta?.produto_id !== linha.produto_id || confirmada === null) {
          throw new ApiError(0, 'Resposta de quantidade inválida.');
        }
        // Uma intenção mais nova surgiu: não grava esta resposta.
        if (desejada.current.get(chave) !== destino) {
          emVoo.current.set(chave, false);
          void enviar(chave);
          return;
        }
        // ESTADO CONFIRMADO PELO SERVIDOR: único ponto de escrita no carrinho.
        alterarQuantidade(linha.produto_id, linha.tamanho_id ?? null, confirmada);
        desejada.current.delete(chave);
        encerrarPendente(chave);
        limparMensagens(chave);
      })
      .catch((e: unknown) => {
        if (minha !== sequencia.current.get(chave)) return; // resposta antiga
        if (e instanceof DOMException && e.name === 'AbortError') return;
        if (desejada.current.get(chave) !== destino) {
          emVoo.current.set(chave, false);
          void enviar(chave);
          return;
        }
        desejada.current.delete(chave);
        encerrarPendente(chave);
        ultimaRecusada.current.set(chave, destino);
        setRetries((prev) => ({ ...prev, [chave]: true }));
        const status = e instanceof ApiError ? e.status : (e as { status?: number } | null)?.status;
        if (status === 409) {
          // Mensagem do SERVIDOR (estoque real), nunca estoque do navegador.
          setAvisos((prev) => ({ ...prev, [chave]: e instanceof ApiError && e.message ? e.message : 'Só há poucas unidades disponíveis.' }));
        } else {
          setErros((prev) => ({ ...prev, [chave]: MENSAGEM_ERRO_QUANTIDADE }));
        }
      })
      .finally(() => {
        if (minha !== sequencia.current.get(chave)) return;
        emVoo.current.set(chave, false);
        controladores.current.delete(chave);
      });
  }, [encerrarPendente, limparMensagens]);

  const alterar = useCallback((item: ItemCarrinho, delta: 1 | -1) => {
    const chave = chaveLinhaCarrinho(item);
    // Confirmed vem do REF (não do render): entre cliques rápidos o React pode
    // ainda não ter re-renderizado a página.
    const confirmada = carrinhoRef.current.itens.find((i) => chaveLinhaCarrinho(i) === chave)?.quantidade ?? item.quantidade;
    // Base = última intenção (se houver) ou quantidade confirmada. Usar o
    // valor do render aqui criaria o clássico "1 → 1 → 1" por estado stale.
    const base = desejada.current.get(chave) ?? confirmada;
    const proxima = base + delta;
    if (normalizarQuantidade(proxima) === null || proxima > QUANTIDADE_MAXIMA) return;
    limparMensagens(chave);

    if (proxima === confirmada) {
      // Voltou ao estado confirmado: cancela a mutação obsoleta, se houver.
      desejada.current.delete(chave);
      encerrarPendente(chave);
      if (emVoo.current.get(chave)) {
        sequencia.current.set(chave, (sequencia.current.get(chave) ?? 0) + 1);
        controladores.current.get(chave)?.abort();
        emVoo.current.set(chave, false);
      }
      return;
    }

    desejada.current.set(chave, proxima);
    setPendentes((prev) => ({ ...prev, [chave]: proxima }));
    if (emVoo.current.get(chave)) {
      // Intenção mais recente: aborta a anterior e invalida a resposta dela.
      sequencia.current.set(chave, (sequencia.current.get(chave) ?? 0) + 1);
      controladores.current.get(chave)?.abort();
      emVoo.current.set(chave, false);
    }
    void enviar(chave);
  }, [encerrarPendente, enviar, limparMensagens]);

  const tentarNovamente = useCallback((item: ItemCarrinho) => {
    const chave = chaveLinhaCarrinho(item);
    const ultima = ultimaRecusada.current.get(chave);
    if (ultima === undefined) return;
    limparMensagens(chave);
    desejada.current.set(chave, ultima);
    setPendentes((prev) => ({ ...prev, [chave]: ultima }));
    if (emVoo.current.get(chave)) {
      sequencia.current.set(chave, (sequencia.current.get(chave) ?? 0) + 1);
      controladores.current.get(chave)?.abort();
      emVoo.current.set(chave, false);
    }
    void enviar(chave);
  }, [enviar, limparMensagens]);

  // Desmontagem (navegação para o checkout, por exemplo): não deixa resposta
  // tardia escrever no carrinho de uma página que não existe mais.
  useEffect(() => () => {
    for (const [, ctrl] of controladores.current) ctrl.abort();
    controladores.current.clear();
    for (const chave of sequencia.current.keys()) sequencia.current.set(chave, -1);
  }, []);

  const estado = useCallback((item: ItemCarrinho): EstadoQuantidadeLinha => {
    const chave = chaveLinhaCarrinho(item);
    return {
      pendente: chave in pendentes,
      desejada: pendentes[chave] ?? null,
      erro: erros[chave] ?? '',
      aviso: avisos[chave] ?? '',
      temRetry: !!retries[chave],
    };
  }, [pendentes, erros, avisos, retries]);

  return { estado, alterar, tentarNovamente };
}
