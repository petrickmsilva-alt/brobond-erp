import { useCallback, useEffect, useState } from 'react';

export type ThemePref = 'light' | 'dark' | 'system';

const KEY = 'brobond_theme';

function systemPrefersDark() {
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
}

function apply(pref: ThemePref) {
  const dark = pref === 'dark' || (pref === 'system' && systemPrefersDark());
  document.documentElement.classList.toggle('dark', dark);
}

/** Lê a preferência salva (ou 'dark' — padrão Brobond AI ERP — se nunca escolhida). */
export function getStoredTheme(): ThemePref {
  try {
    const raw = localStorage.getItem(KEY);
    return raw === 'light' || raw === 'dark' || raw === 'system' ? raw : 'dark';
  } catch {
    return 'dark';
  }
}

/** Deve ser chamado o quanto antes (fora do React) para evitar "flash" de tema errado. */
export function applyStoredTheme() {
  apply(getStoredTheme());
}

/**
 * Hook de tema claro/escuro/automático. Persiste no navegador (chave própria,
 * separada de `brobond_prefs`, pois é lido antes do React montar) e reage a
 * mudanças do tema do sistema operacional quando em modo 'system'.
 */
export function useTheme(): [ThemePref, (p: ThemePref) => void] {
  const [pref, setPref] = useState<ThemePref>(getStoredTheme);

  useEffect(() => {
    apply(pref);
    try {
      localStorage.setItem(KEY, pref);
    } catch {
      /* sem persistência: o tema vale só para esta sessão */
    }
  }, [pref]);

  useEffect(() => {
    if (pref !== 'system') return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => apply('system');
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [pref]);

  const update = useCallback((p: ThemePref) => setPref(p), []);
  return [pref, update];
}
