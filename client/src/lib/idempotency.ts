import { useRef } from 'react';

/** Mantém a mesma chave em reenvios do mesmo corpo após timeout; muda com os dados. */
export function useIdempotencyKey() {
  const last = useRef<{ body: string; key: string } | null>(null);
  return (body: string) => {
    if (!last.current || last.current.body !== body) last.current = { body, key: crypto.randomUUID() };
    return last.current.key;
  };
}
