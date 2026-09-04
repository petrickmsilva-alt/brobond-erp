// Integração com Sentry para monitoramento de erros no frontend.
// Inicializa apenas se SENTRY_DSN estiver definido (variável de ambiente Vite).
// Uso: import './sentry' no main.tsx ANTES do ReactDOM.render.

import * as Sentry from '@sentry/react';

const SENTRY_DSN = import.meta.env.VITE_SENTRY_DSN as string | undefined;

if (SENTRY_DSN) {
  Sentry.init({
    dsn: SENTRY_DSN,
    environment: import.meta.env.MODE || 'development',
    // Captura 10% das transações para performance monitoring (ajuste conforme necessidade)
    tracesSampleRate: 0.1,
    // Captura erros de renderização (integrado com ErrorBoundary)
    integrations: [
      Sentry.browserTracingIntegration(),
      Sentry.replayIntegration({
        maskAllText: false,
        blockAllMedia: false,
      }),
    ],
    // Replay: grava a sessão do usuário quando ocorre erro (privacidade respeitada)
    replaysSessionSampleRate: 0,
    replaysOnErrorSampleRate: 1.0,
  });
}

/** Captura erro manualmente (para usar em catch blocks). */
export function captureError(error: unknown, context?: Record<string, unknown>): void {
  if (SENTRY_DSN) {
    Sentry.captureException(error, { extra: context });
  }
  // Sempre loga no console também
  console.error('[Sentry]', error, context);
}

/** Define o usuário atual no Sentry (para rastreabilidade). */
export function setSentryUser(user: { id: number; email: string; name: string } | null): void {
  if (!SENTRY_DSN) return;
  if (user) {
    Sentry.setUser({ id: String(user.id), email: user.email, username: user.name });
  } else {
    Sentry.setUser(null);
  }
}

/** Adiciona breadcrumb (navegação, ações do usuário) para contexto no erro. */
export function addBreadcrumb(message: string, category?: string, data?: Record<string, unknown>): void {
  if (!SENTRY_DSN) return;
  Sentry.addBreadcrumb({ message, category, data, level: 'info' });
}

export const sentryEnabled = !!SENTRY_DSN;
