import { useCallback, useEffect, useState } from 'react';

/**
 * Preferência booleana persistida no navegador (ex.: densidade de tabela).
 * Falha silenciosamente se localStorage não estiver disponível (modo privado etc.).
 */
export function useLocalStorageBool(key: string, def: boolean): [boolean, (v: boolean) => void] {
  const [value, setValue] = useState<boolean>(() => {
    try {
      const raw = localStorage.getItem(key);
      return raw === null ? def : raw === '1';
    } catch {
      return def;
    }
  });

  const update = useCallback(
    (v: boolean) => {
      setValue(v);
      try {
        localStorage.setItem(key, v ? '1' : '0');
      } catch {
        /* sem persistência: preferência vale só para esta sessão */
      }
    },
    [key]
  );

  return [value, update];
}

/**
 * Conjunto de strings persistido no navegador (ex.: nomes de colunas ocultas por
 * recurso). Devolve o Set atual e uma função para alternar um item.
 */
export function useLocalStorageSet(key: string): [Set<string>, (item: string) => void] {
  const [value, setValue] = useState<Set<string>>(() => {
    try {
      const raw = localStorage.getItem(key);
      return raw ? new Set(JSON.parse(raw)) : new Set();
    } catch {
      return new Set();
    }
  });

  // Recarrega quando a chave muda (ex.: trocou de recurso/tela).
  useEffect(() => {
    try {
      const raw = localStorage.getItem(key);
      setValue(raw ? new Set(JSON.parse(raw)) : new Set());
    } catch {
      setValue(new Set());
    }
  }, [key]);

  const toggle = useCallback(
    (item: string) => {
      setValue((cur) => {
        const next = new Set(cur);
        if (next.has(item)) next.delete(item);
        else next.add(item);
        try {
          localStorage.setItem(key, JSON.stringify(Array.from(next)));
        } catch {
          /* sem persistência: preferência vale só para esta sessão */
        }
        return next;
      });
    },
    [key]
  );

  return [value, toggle];
}
