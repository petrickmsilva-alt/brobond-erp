import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Calculator, ClipboardList, Loader2, Plus, Search, Tag } from 'lucide-react';
import { api } from '../lib/api';
import { useAuth } from '../auth/AuthContext';
import { Alert, EmptyState, PageHeader, Spinner } from '../components/ui';
import { ProductSelector } from '../components/ProductSelector';
import { formatMoney, formatNumber } from '../lib/format';

type Ficha = Record<string, any> & { id: number };

export default function CustoPage() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const podeCriar = user?.perfil !== 'operador';

  const [fichas, setFichas] = useState<Ficha[] | null>(null);
  const [error, setError] = useState('');
  const [q, setQ] = useState('');

  const carregar = async () => {
    setError('');
    try {
      const d = await api.get<{ rows: Ficha[] }>('/fichas?pageSize=300&sort=produto_id&dir=asc');
      setFichas(d.rows);
    } catch (e: any) {
      setError(e.message || 'Erro ao carregar as fichas.');
    }
  };

  useEffect(() => {
    carregar();
  }, []);

  const visiveis = useMemo(() => {
    if (!fichas) return [];
    const term = q.trim().toLowerCase();
    return term ? fichas.filter((f) => String(f.produto_id__label || '').toLowerCase().includes(term)) : fichas;
  }, [fichas, q]);

  const totais = useMemo(() => {
    if (!fichas) return null;
    const itens = fichas.reduce((a, f) => a + 1, 0);
    const custo = fichas.reduce((a, f) => a + Number(f.custo_calculado || 0), 0);
    const preco = fichas.reduce((a, f) => a + Number(f.preco_sugerido || 0), 0);
    return { itens, custo, preco };
  }, [fichas]);

  // ZERO MODAL: a criação de ficha é a página `/custo/nova`.
  const abrirNova = () => navigate('/custo/nova');

  return (
    <div className="p-4 pb-24 sm:p-6 md:pb-6">
      <PageHeader
        title={
          <span className="flex items-center gap-2.5">
            <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-navy-800 text-white">
              <Calculator className="h-5 w-5" />
            </span>
            Custo de Fabricação
          </span>
        }
        description="Custo unitário = Σ(insumo × (1 + perda%) × custo médio) + mão de obra + indiretos. Preço sugerido = custo × (1 + margem%)."
        actions={
          <>
            <div className="relative hidden min-w-[220px] sm:block">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
              <input className="input pl-9" placeholder="Buscar produto..." value={q} onChange={(e) => setQ(e.target.value)} />
            </div>
            {podeCriar && (
              <button className="btn-accent" onClick={abrirNova}>
                <Plus className="h-4 w-4" /> Nova ficha técnica
              </button>
            )}
          </>
        }
      />

      {error && <Alert tone="red">{error}</Alert>}
      {!fichas && !error && <Spinner />}

      {fichas && totais && (
        <>
          <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
            <div className="card p-4">
              <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Produtos com ficha</div>
              <div className="mt-1 text-lg font-bold text-navy-900">{formatNumber(totais.itens)}</div>
            </div>
            <div className="card p-4">
              <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Custo total (custo unitário × 1 peça)</div>
              <div className="mt-1 text-lg font-bold tabular-nums text-navy-900">{formatMoney(totais.custo)}</div>
            </div>
            <div className="card col-span-2 p-4 sm:col-span-1">
              <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Preço sugerido total</div>
              <div className="mt-1 text-lg font-bold tabular-nums text-brand-600">{formatMoney(totais.preco)}</div>
            </div>
          </div>

          {visiveis.length === 0 ? (
            <EmptyState
              icon={<ClipboardList className="h-6 w-6" />}
              title={q ? 'Nada encontrado' : 'Nenhuma ficha técnica cadastrada'}
              description={q ? undefined : 'Crie a ficha de um produto para calcular custo e preço sugerido com os custos médios dos insumos.'}
              action={
                !q && podeCriar ? (
                  <button className="btn-accent" onClick={abrirNova}>
                    <Plus className="h-4 w-4" /> Nova ficha técnica
                  </button>
                ) : undefined
              }
            />
          ) : (
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
              {visiveis.map((f) => (
                <button key={f.id} className="card group p-4 text-left transition-shadow hover:shadow-modal" onClick={() => navigate(`/fichas/${f.id}`)}>
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-semibold text-navy-900">{f.produto_id__label || `Produto #${f.produto_id}`}</div>
                      <div className="mt-0.5 text-xs text-slate-400">
                        Mão de obra {formatMoney(f.mao_obra)} · Indiretos {formatMoney(f.custos_indiretos)}
                      </div>
                    </div>
                    <span className="shrink-0 rounded-full bg-brand-50 px-2 py-0.5 text-xs font-bold text-brand-700">{formatNumber(f.margem_pct)}%</span>
                  </div>
                  <div className="mt-3 grid grid-cols-2 gap-2 text-sm">
                    <div className="rounded-lg bg-slate-50 p-2.5">
                      <div className="text-[10px] font-semibold uppercase text-slate-400">Custo</div>
                      <div className="font-bold tabular-nums text-navy-900">{f.custo_calculado != null ? formatMoney(f.custo_calculado) : '—'}</div>
                    </div>
                    <div className="rounded-lg bg-brand-50/60 p-2.5">
                      <div className="text-[10px] font-semibold uppercase text-brand-600">Preço sugerido</div>
                      <div className="font-bold tabular-nums text-brand-700">{f.preco_sugerido != null ? formatMoney(f.preco_sugerido) : '—'}</div>
                    </div>
                  </div>
                </button>
              ))}
            </div>
          )}
          <p className="mt-3 text-xs text-slate-400">
            Os valores refletem o custo médio atual dos insumos e são recalculados a cada alteração. O botão “Aplicar preço” na ficha copia o resultado para o produto.
          </p>
        </>
      )}

    </div>
  );
}
