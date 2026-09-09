import { Component, type ErrorInfo, type ReactNode } from 'react';
import { AlertTriangle } from 'lucide-react';

type Props = {
  children: ReactNode;
  fallback?: ReactNode;
};

type State = {
  hasError: boolean;
  error: Error | null;
};

/**
 * Error Boundary global — captura erros de renderização em qualquer componente
 * descendente e exibe uma tela amigável em vez de deixar a página em branco.
 *
 * Uso: envolva <App /> ou trechos críticos.
 */
export default class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    // Log para console (em produção, enviar para Sentry se configurado)
    console.error('ErrorBoundary capturou erro:', error, errorInfo);
  }

  handleReload = () => {
    window.location.reload();
  };

  handleReset = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) return this.props.fallback;

      return (
        <div className="flex min-h-screen items-center justify-center bg-slate-50 p-6 dark:bg-navy-950" role="alert" aria-live="assertive">
          <div className="max-w-md rounded-2xl bg-white p-8 text-center shadow-lg dark:bg-navy-900">
            <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-red-100 dark:bg-red-950/40">
              <AlertTriangle className="h-8 w-8 text-red-600" />
            </div>
            <h1 className="mb-2 text-xl font-bold text-slate-900 dark:text-white">Ops! Algo deu errado</h1>
            <p className="mb-4 text-sm text-slate-600 dark:text-navy-300">
              Ocorreu um erro inesperado na aplicação. Tente recarregar a página. Se o problema persistir, entre em contato com o administrador.
            </p>
            {this.state.error && (
              <details className="mb-4 rounded-lg bg-slate-50 p-3 text-left">
                <summary className="cursor-pointer text-xs font-medium text-slate-500">Detalhes técnicos</summary>
                <pre className="mt-2 overflow-auto text-xs text-slate-600">{this.state.error.message}</pre>
              </details>
            )}
            <div className="flex gap-3">
              <button
                onClick={this.handleReload}
                className="flex-1 rounded-lg bg-navy-800 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-navy-700"
              >
                Recarregar página
              </button>
              <button
                onClick={this.handleReset}
                className="flex-1 rounded-lg border border-slate-300 px-4 py-2.5 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-50"
              >
                Tentar novamente
              </button>
            </div>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
