// ============================================================================
// Consulta à API com estado explícito (carregando / erro / dados) e nova
// tentativa. Ao trocar o caminho (ex.: outro período), os dados anteriores são
// descartados antes da nova resposta — a tela nunca mostra números de um filtro
// com a legenda de outro.
// ============================================================================
import { useCallback, useEffect, useState } from 'react';
import { api } from './api';

export type ApiQueryState<T> = {
  data: T | null;
  error: string | null;
  loading: boolean;
  reload: () => void;
};

/** `path` nulo = consulta desligada (ex.: espera a empresa ativa). */
export function useApiQuery<T>(path: string | null): ApiQueryState<T> {
  const [estado, setEstado] = useState<{ data: T | null; error: string | null; loading: boolean }>({
    data: null,
    error: null,
    loading: path !== null,
  });
  const [tentativa, setTentativa] = useState(0);

  useEffect(() => {
    if (path === null) {
      setEstado({ data: null, error: null, loading: false });
      return;
    }
    let vivo = true;
    setEstado({ data: null, error: null, loading: true });
    api
      .get<T>(path)
      .then((data) => {
        if (vivo) setEstado({ data, error: null, loading: false });
      })
      .catch((err: unknown) => {
        if (vivo) setEstado({ data: null, error: err instanceof Error ? err.message : 'Erro inesperado.', loading: false });
      });
    return () => {
      vivo = false;
    };
  }, [path, tentativa]);

  const reload = useCallback(() => setTentativa((n) => n + 1), []);
  return { ...estado, reload };
}
