// ============================================================================
// VITRINE /loja — cabeçalho/rodapé comuns da loja pública da empresa.
// Sem dependência do ERP logado: identidade vem de /api/loja/config.
// ============================================================================
import { useEffect, useState, type ReactNode } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { ShoppingBag } from 'lucide-react';
import { apiFetch } from '../../../lib/api';
import { totalItens, useCarrinho } from './carinho';

export type ConfigLoja = {
  loja_nome: string;
  loja_descricao: string | null;
  frete: { provedor: string; valor: number; gratis_acima: number | null; prazo_dias: number | null; disponivel: boolean; motivo?: string };
  checkout_expira_minutos: number;
  checkout_disponivel?: boolean;
};

export function useConfigLoja(): { config: ConfigLoja | null; erro: string | null } {
  const [config, setConfig] = useState<ConfigLoja | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  useEffect(() => {
    apiFetch<ConfigLoja>('/loja/config')
      .then(setConfig)
      .catch((e) => setErro(e instanceof Error ? e.message : 'Loja indisponível.'));
  }, []);
  return { config, erro };
}

export function LojaShell({ children, titulo }: { children: ReactNode; titulo?: string }) {
  const carrinho = useCarrinho();
  const { config, erro } = useConfigLoja();
  const location = useLocation();
  const total = totalItens(carrinho);

  return (
    <div className="flex min-h-screen flex-col bg-canvas text-ink">
      <header className="sticky top-0 z-20 border-b border-line bg-surface/95 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center gap-4 px-4 py-3">
          <Link to="/loja" className="flex items-center gap-2 font-semibold tracking-tight">
            <span className="flex h-8 w-8 items-center justify-center rounded-full bg-primary text-white">B</span>
            <span className="truncate">{config?.loja_nome ?? 'BROBOND'}</span>
          </Link>
          <nav className="ml-auto flex items-center gap-4 text-sm" aria-label="Loja">
            <Link className={location.pathname === '/loja' ? 'text-primary' : 'text-ink-soft hover:text-primary'} to="/loja">
              Produtos
            </Link>
            <Link className="relative flex items-center gap-1.5 text-ink-soft hover:text-primary" to="/loja/carrinho" aria-label={`Carrinho com ${total} item(ns)`}>
              <ShoppingBag className="h-5 w-5" aria-hidden="true" />
              {total > 0 && (
                <span className="absolute -right-2 -top-2 flex h-4 min-w-4 items-center justify-center rounded-full bg-accent px-1 text-[10px] font-bold text-white">
                  {total}
                </span>
              )}
              Carrinho
            </Link>
          </nav>
        </div>
        {config?.loja_descricao && location.pathname === '/loja' && (
          <div className="border-t border-line bg-canvas">
            <p className="mx-auto max-w-6xl px-4 py-2 text-sm text-muted">{config.loja_descricao}</p>
          </div>
        )}
      </header>

      {erro && (
        <div className="mx-auto mt-4 w-full max-w-6xl px-4">
          <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700" role="alert">
            {erro}
          </div>
        </div>
      )}

      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6">
        {titulo && <h1 className="mb-4 text-2xl font-semibold tracking-tight">{titulo}</h1>}
        {children}
      </main>

      <footer className="border-t border-line bg-surface">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-2 px-4 py-4 text-xs text-muted">
          <span>{config?.loja_nome ?? 'BROBOND'} · loja oficial</span>
          <span>Pagamentos processados com segurança — o pedido só é confirmado após a aprovação do pagamento.</span>
        </div>
      </footer>
    </div>
  );
}

/** Formata preço local (a vitrine mostra o número REAL vindo do servidor). */
export function precoLoja(valor: number): string {
  return Number(valor).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}
