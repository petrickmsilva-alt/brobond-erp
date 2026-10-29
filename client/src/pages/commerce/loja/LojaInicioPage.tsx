// ============================================================================
// VITRINE — VITRINE DE PRODUTOS. Rota /loja.
// Lista SOMENTE produtos com publicação PUBLISHED no canal BROBOND + ativos.
// Preço promocional (quando vigente) vem calculado no servidor.
// ============================================================================
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { PackageSearch, Search } from 'lucide-react';
import { apiFetch, ApiError } from '../../../lib/api';
import { LojaShell, precoLoja } from './LojaShell';

type ProdutoPublico = {
  id: number;
  sku: string;
  slug: string;
  nome: string;
  resumo: string | null;
  destaque: boolean;
  preco: number;
  preco_original: number | null;
  promocional: boolean;
  foto_url: string | null;
};

export default function LojaInicioPage() {
  const [produtos, setProdutos] = useState<ProdutoPublico[]>([]);
  const [pagina, setPagina] = useState(1);
  const [total, setTotal] = useState(0);
  const [busca, setBusca] = useState('');
  const [termo, setTermo] = useState('');
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState('');

  useEffect(() => {
    const t = window.setTimeout(() => { setTermo(busca.trim()); setPagina(1); }, 300);
    return () => window.clearTimeout(t);
  }, [busca]);

  useEffect(() => {
    let vivo = true;
    setCarregando(true);
    setErro('');
    apiFetch<{ total: number; produtos: ProdutoPublico[] }>(`/loja/produtos?page=${pagina}&pageSize=48${termo ? `&q=${encodeURIComponent(termo)}` : ''}`)
      .then((r) => {
        if (!vivo) return;
        setProdutos(r.produtos);
        setTotal(r.total);
      })
      .catch((e) => {
        if (vivo) setErro(e instanceof ApiError ? e.message : 'Não foi possível carregar a loja.');
      })
      .finally(() => {
        if (vivo) setCarregando(false);
      });
    return () => {
      vivo = false;
    };
  }, [termo, pagina]);

  return (
    <LojaShell>
      <div className="space-y-5">
        <div className="rounded-2xl border border-line bg-gradient-to-br from-navy-900 to-navy-700 p-6 text-white">
          <h1 className="text-2xl font-semibold tracking-tight">Vitrine BROBOND</h1>
          <p className="mt-1 max-w-xl text-sm text-navy-100">
            Peças direto da fonte: estoque em tempo real, pagamento seguro e pedido acompanhado do carrinho à entrega.
          </p>
        </div>

        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" aria-hidden="true" />
          <input
            className="input pl-9"
            type="search"
            value={busca}
            onChange={(e) => setBusca(e.target.value)}
            placeholder="Buscar produto…"
            aria-label="Buscar produtos na loja"
          />
        </div>

        {erro && (
          <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700" role="alert">
            {erro}
          </div>
        )}

        {carregando ? (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3" aria-busy="true" aria-live="polite">
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-56 animate-pulse rounded-2xl border border-line bg-surface" />
            ))}
            <span className="sr-only">Carregando produtos…</span>
          </div>
        ) : erro ? null : produtos.length === 0 ? (
          <div className="flex flex-col items-center gap-3 rounded-2xl border border-dashed border-line bg-surface p-10 text-center">
            <PackageSearch className="h-8 w-8 text-muted" aria-hidden="true" />
            <h2 className="font-medium">{termo ? 'Nada encontrado' : 'Nenhum produto disponível na loja.'}</h2>
            <p className="max-w-md text-sm text-muted">
              {termo
                ? 'Tente outro termo ou limpe a busca.'
                : 'A equipe pode publicar um produto existente em Commerce → Produtos → Publicar no canal BROBOND. A disponibilidade depende do estoque real.'}
            </p>
          </div>
        ) : (
          <>
            <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {produtos.map((p) => (
                <li key={p.id}>
                  <Link
                    to={`/loja/produto/${p.slug}`}
                    className="group flex h-full flex-col overflow-hidden rounded-2xl border border-line bg-surface transition hover:border-primary/60 hover:shadow-sm"
                  >
                    <div className="flex h-40 items-center justify-center overflow-hidden bg-canvas">
                      {p.foto_url ? (
                        <img src={p.foto_url} alt={p.nome} className="h-full w-full object-cover transition group-hover:scale-[1.02]" loading="lazy" />
                      ) : (
                        <span className="text-4xl text-line" aria-hidden="true">👕</span>
                      )}
                    </div>
                    <div className="flex flex-1 flex-col gap-1 p-4">
                      <div className="flex items-start justify-between gap-2">
                        <h3 className="font-medium leading-snug group-hover:text-primary">{p.nome}</h3>
                        {p.destaque && <span className="rounded-full bg-accent/10 px-2 py-0.5 text-[10px] font-bold uppercase text-accent">Destaque</span>}
                      </div>
                      {p.resumo && <p className="line-clamp-2 text-sm text-muted">{p.resumo}</p>}
                      <div className="mt-auto flex items-baseline gap-2 pt-2">
                        <span className="text-lg font-semibold tabular-nums text-primary">{precoLoja(p.preco)}</span>
                        {p.promocional && p.preco_original != null && (
                          <span className="text-sm text-muted line-through tabular-nums">{precoLoja(p.preco_original)}</span>
                        )}
                      </div>
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
            <p className="text-center text-xs text-muted">
              {total} produto(s) publicado(s)
              {total > 48 ? ` · página ${pagina} de ${Math.ceil(total / 48)}` : ''}
            </p>
            {total > 48 && <nav aria-label="Paginação da vitrine" className="flex justify-center gap-3">
              <button type="button" className="btn-secondary" disabled={pagina <= 1} onClick={() => setPagina((p) => p - 1)}>Anterior</button>
              <button type="button" className="btn-secondary" disabled={pagina * 48 >= total} onClick={() => setPagina((p) => p + 1)}>Próxima</button>
            </nav>}
          </>
        )}
      </div>
    </LojaShell>
  );
}
