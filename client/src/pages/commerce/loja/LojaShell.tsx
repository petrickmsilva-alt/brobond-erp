// ============================================================================
// BROBOND STORE — casca pública (/loja/*).
//
// Identidade 100% pública: vem de /api/loja/config. Nenhum link para
// /commerce, /dashboard, /admin ou /conectores — o ERP permanece invisível.
// ZERO MODAL: busca, categorias e carrinho são navegação real (URL + rota).
//
// Performance: uma ÚNICA requisição de config por montagem (AbortController
// cancela em unmount); as páginas filhas leem `useConfigDoShell()` em vez de
// buscar /loja/config de novo (o checkout fazia isso e duplicava o request).
// ============================================================================
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { Search, ShoppingBag, ShieldCheck, Truck, PackageCheck, Sparkles } from 'lucide-react';
import { apiFetch } from '../../../lib/api';
import { totalItens, useCarrinho } from './carinho';

export type ConfigLoja = {
  loja_nome: string;
  loja_descricao: string | null;
  frete: { provedor: string; valor: number; gratis_acima: number | null; prazo_dias: number | null; disponivel: boolean; motivo?: string };
  checkout_expira_minutos: number;
  checkout_disponivel?: boolean;
};

// ---------------------------------------------------------------------------
// Store público de configuração: UM único GET /loja/config por montagem do
// fluxo, compartilhado por LojaShell + TODAS as páginas filhas. Antes, cada
// página buscava de novo (checkout fazia 2 requisições) e, pior, o contexto
// ficava DENTRO de LojaShell — página é componente PAI, então recebia null.
//
// É um store de módulo (useSyncExternalStore), não um contexto: qualquer
// componente da árvore lê o mesmo snapshot estável sem duplicar request.
// Cache é APENAS de conteúdo estático (nome/frete/descrição/preço de entrega
// configurado) — preço final, estoque, reserva, total e pagamento continuam
// sendo consultados no servidor a cada operação.
// ---------------------------------------------------------------------------
type EstadoConfig = { config: ConfigLoja | null; erro: string | null };
const CONFIG_VAZIO: EstadoConfig = { config: null, erro: null };
let snapshotConfig: EstadoConfig = CONFIG_VAZIO;
let requisicaoConfig: AbortController | null = null;
let resolvidoNesteCiclo = false;
let consumidores = 0;
const ouvintesConfig = new Set<() => void>();

function publicarConfig(proximo: EstadoConfig) {
  snapshotConfig = proximo;
  for (const fn of ouvintesConfig) fn();
}

function iniciarConfig() {
  if (requisicaoConfig || resolvidoNesteCiclo) return;
  // Novo ciclo de montagem: nunca reaproveita config de outra empresa/tenant.
  publicarConfig(CONFIG_VAZIO);
  const controller = new AbortController();
  requisicaoConfig = controller;
  apiFetch<ConfigLoja>('/loja/config', { signal: controller.signal })
    .then((config) => {
      if (controller.signal.aborted) return;
      resolvidoNesteCiclo = true;
      publicarConfig({ config, erro: null });
    })
    .catch((e) => {
      if (controller.signal.aborted) return;
      resolvidoNesteCiclo = true;
      publicarConfig({ config: null, erro: e instanceof Error ? e.message : 'Loja indisponível.' });
    })
    .finally(() => { if (requisicaoConfig === controller) requisicaoConfig = null; });
}

function assinarConfig(fn: () => void): () => void {
  ouvintesConfig.add(fn);
  consumidores += 1;
  iniciarConfig();
  return () => {
    ouvintesConfig.delete(fn);
    consumidores -= 1;
    if (consumidores <= 0) agendarResetConfig();
  };
}

// O reset é adiado para a microtask seguinte: no StrictMode o React desmonta e
// remonta os efeitos no mesmo commit, e um reset imediato abortaria o GET e
// geraria uma segunda requisição. Se novo assinante chegar, o reset é cancelado.
let resetPendente = false;
function agendarResetConfig() {
  if (resetPendente) return;
  resetPendente = true;
  queueMicrotask(() => {
    resetPendente = false;
    if (consumidores > 0) return;
    requisicaoConfig?.abort();
    requisicaoConfig = null;
    resolvidoNesteCiclo = false;
    snapshotConfig = CONFIG_VAZIO;
  });
}

export function useConfigLoja(): EstadoConfig {
  return useSyncExternalStore(assinarConfig, () => snapshotConfig, () => snapshotConfig);
}

/** Alias semântico usado pelas páginas: config pública já carregada, sem 2º GET. */
export function useConfigDoShell(): EstadoConfig {
  return useConfigLoja();
}

export function LojaShell({ children, titulo, tituloDocumento }: { children: ReactNode; titulo?: string; tituloDocumento?: string }) {
  const carrinho = useCarrinho();
  const { config, erro } = useConfigLoja();
  const location = useLocation();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const total = totalItens(carrinho);
  const [busca, setBusca] = useState(params.get('q') ?? '');
  const qDaUrl = params.get('q') ?? '';
  const editando = useRef(false);
  const naHome = location.pathname === '/loja';

  useEffect(() => {
    if (!editando.current) setBusca(qDaUrl);
  }, [qDaUrl]);

  useEffect(() => {
    const nome = config?.loja_nome ?? 'BROBOND';
    const parte = tituloDocumento ?? titulo;
    document.title = parte ? `${parte} — ${nome}` : nome;
  }, [config?.loja_nome, titulo, tituloDocumento]);

  // Busca rápida COM debounce na home (atualiza a URL, sem request por tecla).
  // Nas demais páginas o formulário navega para /loja?q=... (rota real).
  useEffect(() => {
    if (!naHome) return;
    const t = window.setTimeout(() => {
      const valor = busca.trim();
      if (valor === qDaUrl) return;
      const proximos = new URLSearchParams(params);
      if (valor) proximos.set('q', valor);
      else proximos.delete('q');
      editando.current = true;
      setParams(proximos, { replace: true });
      window.setTimeout(() => { editando.current = false; }, 0);
    }, 300);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busca, naHome, qDaUrl]);

  const submeterBusca = (e: React.FormEvent) => {
    e.preventDefault();
    const valor = busca.trim();
    if (naHome) return;
    navigate(valor ? `/loja?q=${encodeURIComponent(valor)}` : '/loja');
  };

  const nome = config?.loja_nome ?? 'BROBOND';

  return (
      <div className="flex min-h-screen flex-col bg-canvas text-ink">
        {/* Faixa institucional — conteúdo legítimo, sem números inventados. */}
        <div className="hidden bg-navy-900 px-4 py-1.5 text-center text-[11px] tracking-[0.18em] text-navy-100 sm:block">
          {nome.toUpperCase()} · LOJA OFICIAL · COMPRA SEGURA
        </div>
        <header className="sticky top-0 z-20 border-b border-line bg-surface/95 backdrop-blur">
          <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-3 px-4 py-3 sm:gap-5">
            <Link to="/loja" className="flex shrink-0 items-center gap-2.5" aria-label={`${nome} — início`}>
              <span className="flex h-9 w-9 items-center justify-center rounded-full bg-navy-900 text-sm font-bold tracking-tight text-white">B</span>
              <span className="max-w-[9rem] truncate text-base font-semibold uppercase tracking-[0.14em] sm:max-w-none">{nome}</span>
            </Link>

            <nav className="order-3 flex w-full items-center gap-5 text-xs font-medium uppercase tracking-wider sm:order-none sm:w-auto sm:text-sm" aria-label="Navegação da loja">
              <Link className={naHome && !qDaUrl ? 'text-primary' : 'text-ink-soft hover:text-primary'} to="/loja">Produtos</Link>
              <Link className="text-ink-soft hover:text-primary" to="/loja#categorias">Categorias</Link>
              <Link className="text-ink-soft hover:text-primary" to="/loja#novidades">Novidades</Link>
            </nav>

            <form onSubmit={submeterBusca} role="search" className="relative order-4 w-full sm:order-none sm:ml-auto sm:w-56 md:w-72">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" aria-hidden="true" />
              <input
                className="input h-9 rounded-full border-line bg-canvas pl-9 text-sm"
                type="search"
                value={busca}
                onChange={(e) => { editando.current = true; setBusca(e.target.value); }}
                placeholder="Buscar produto, SKU ou categoria"
                aria-label="Buscar na loja"
              />
            </form>

            <Link
              className="relative ml-auto flex shrink-0 items-center gap-2 rounded-full border border-line px-3 py-2 text-sm text-ink-soft transition hover:border-primary hover:text-primary sm:ml-0"
              to="/loja/carrinho"
              aria-label={`Carrinho com ${total} item(ns)`}
            >
              <ShoppingBag className="h-5 w-5" aria-hidden="true" />
              <span className="hidden sm:inline">Carrinho</span>
              {total > 0 && (
                <span className="absolute -right-2 -top-2 flex h-5 min-w-5 items-center justify-center rounded-full bg-accent px-1 text-[10px] font-bold text-white">
                  {total}
                </span>
              )}
            </Link>
          </div>
          {config?.loja_descricao && naHome && (
            <div className="border-t border-line bg-canvas">
              <p className="mx-auto max-w-7xl px-4 py-2 text-xs text-muted sm:text-sm">{config.loja_descricao}</p>
            </div>
          )}
        </header>

        {erro && (
          <div className="mx-auto mt-4 w-full max-w-7xl px-4">
            <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700" role="alert">
              {erro}
            </div>
          </div>
        )}

        <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-6 sm:py-8">
          {titulo && <h1 className="mb-5 text-2xl font-semibold tracking-tight">{titulo}</h1>}
          {children}
        </main>

        <footer className="mt-10 border-t border-line bg-navy-900 text-navy-100">
          <div className="mx-auto grid max-w-7xl gap-8 px-4 py-10 sm:grid-cols-2 lg:grid-cols-4">
            <div>
              <div className="flex items-center gap-2">
                <span className="flex h-8 w-8 items-center justify-center rounded-full bg-white text-sm font-bold text-navy-900">B</span>
                <span className="text-sm font-semibold uppercase tracking-[0.14em] text-white">{nome}</span>
              </div>
              <p className="mt-3 max-w-xs text-xs leading-relaxed text-navy-200">
                {config?.loja_descricao || 'Loja oficial. Preço, disponibilidade e pagamento são sempre confirmados pelo servidor.'}
              </p>
            </div>
            <div>
              <h2 className="text-xs font-semibold uppercase tracking-[0.18em] text-white">Navegue</h2>
              <ul className="mt-3 space-y-2 text-xs">
                <li><Link className="hover:text-white" to="/loja">Todos os produtos</Link></li>
                <li><Link className="hover:text-white" to="/loja#categorias">Categorias</Link></li>
                <li><Link className="hover:text-white" to="/loja#novidades">Novidades</Link></li>
                <li><Link className="hover:text-white" to="/loja/carrinho">Meu carrinho</Link></li>
              </ul>
            </div>
            <div>
              <h2 className="text-xs font-semibold uppercase tracking-[0.18em] text-white">Sua compra</h2>
              <ul className="mt-3 space-y-2.5 text-xs text-navy-200">
                <li className="flex items-center gap-2"><ShieldCheck className="h-4 w-4 shrink-0" aria-hidden="true" /> Pagamento processado com segurança</li>
                <li className="flex items-center gap-2"><PackageCheck className="h-4 w-4 shrink-0" aria-hidden="true" /> Pedido acompanhado por link próprio</li>
                <li className="flex items-center gap-2"><Sparkles className="h-4 w-4 shrink-0" aria-hidden="true" /> Disponibilidade consultada no estoque real</li>
                <li className="flex items-center gap-2"><Truck className="h-4 w-4 shrink-0" aria-hidden="true" /> Entrega ou retirada conforme a configuração da loja</li>
              </ul>
            </div>
            <div>
              <h2 className="text-xs font-semibold uppercase tracking-[0.18em] text-white">Pagamento</h2>
              <p className="mt-3 text-xs leading-relaxed text-navy-200">
                O pedido só é confirmado após a aprovação do pagamento pelo processador. Nenhuma confirmação é feita pelo navegador.
              </p>
            </div>
          </div>
          <div className="border-t border-white/10 px-4 py-4 text-center text-[11px] text-navy-300">
            © {new Date().getFullYear()} {nome} · loja oficial
          </div>
        </footer>
      </div>
  );
}

/** Formata preço local (a vitrine mostra o número REAL vindo do servidor). */
export function precoLoja(valor: number): string {
  if (!Number.isFinite(Number(valor))) return '—';
  return Number(valor).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}
