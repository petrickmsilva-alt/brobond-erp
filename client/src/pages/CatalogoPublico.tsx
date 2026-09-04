import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Eye, EyeOff, ImageOff, Lock, Shirt } from 'lucide-react';
import { api, ApiError } from '../lib/api';
import { Logo } from '../components/Logo';
import { formatMoney, formatNumber } from '../lib/format';

type ProdutoCatalogo = {
  id: number;
  sku: string | null;
  nome: string;
  cor: string | null;
  cor_hex: string | null;
  composicao: string | null;
  descricao: string | null;
  preco: number | null;
  foto_url: string | null;
  fotos: { url: string; thumb_url: string }[];
  tamanhos: { codigo: string; quantidade: number }[];
};

type CatResp = { nome: string; mostrar_preco: boolean; mostrar_saldo: boolean; total: number; produtos: ProdutoCatalogo[] };

export default function CatalogoPublico() {
  const { token } = useParams();
  const [senha, setSenha] = useState('');
  const [precisaSenha, setPrecisaSenha] = useState(false);
  const [err, setErr] = useState('');
  const [data, setData] = useState<CatResp | null>(null);
  const [busy, setBusy] = useState(false);

  const carregar = useCallback(
    async (comSenha: string) => {
      setBusy(true);
      setErr('');
      try {
        const q = comSenha ? `?senha=${encodeURIComponent(comSenha)}` : '';
        const d = await api.get<CatResp>(`/publico/catalogo/${token}${q}`);
        setData(d);
        setPrecisaSenha(false);
      } catch (e: any) {
        if (e instanceof ApiError && e.message === 'senha_necessaria') {
          setPrecisaSenha(true);
        } else {
          setErr(e instanceof ApiError ? e.message : 'Catálogo indisponível.');
        }
      } finally {
        setBusy(false);
      }
    },
    [token]
  );

  useEffect(() => {
    carregar('');
  }, [carregar]);

  const [showSenha, setShowSenha] = useState(false);

  if (err)
    return (
      <div className="flex min-h-full flex-col items-center justify-center bg-white p-8 text-center">
        <ImageOff className="h-10 w-10 text-slate-300" />
        <h1 className="mt-4 text-lg font-bold text-navy-900">Catálogo não encontrado</h1>
        <p className="mt-1 max-w-sm text-sm text-slate-500">{err}</p>
        <p className="mt-6 text-xs text-slate-400">BROBOND ERP · catálogo público</p>
      </div>
    );

  if (!data)
    return (
      <div className="flex min-h-full flex-col items-center justify-center bg-white p-8 text-center">
        {precisaSenha ? (
          <form
            className="w-full max-w-sm space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              carregar(senha);
            }}
          >
            <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-navy-50">
              <Lock className="h-6 w-6 text-navy-500" />
            </div>
            <h1 className="text-xl font-bold text-navy-900">Catálogo protegido</h1>
            <p className="text-sm text-slate-500">Digite a senha enviada junto com o link deste catálogo.</p>
            <div className="relative">
              <input
                type={showSenha ? 'text' : 'password'}
                className="input pr-10"
                placeholder="Senha do catálogo"
                value={senha}
                onChange={(e) => setSenha(e.target.value)}
                autoFocus
                required
              />
              <button type="button" className="absolute inset-y-0 right-0 flex items-center px-3 text-slate-400" onClick={() => setShowSenha((s) => !s)} aria-label="Mostrar senha">
                {showSenha ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
            <button className="btn-primary w-full justify-center" disabled={busy || !senha}>
              Acessar catálogo
            </button>
          </form>
        ) : (
          <div className="text-sm text-slate-400">Carregando catálogo...</div>
        )}
      </div>
    );

  return (
    <div className="min-h-full bg-slate-50">
      <header className="bg-navy-900 px-6 py-10 text-center text-white">
        <div className="flex justify-center">
          <Logo variant="light" height={44} />
        </div>
        <h1 className="mt-4 text-2xl font-bold tracking-tight">{data.nome}</h1>
        <p className="mt-1 text-sm text-navy-300">
          {data.total} produto{data.total === 1 ? '' : 's'}
          {data.mostrar_preco ? ' · preços para revenda' : ''}
        </p>
      </header>

      <main className="mx-auto max-w-6xl px-4 py-6 sm:px-6">
        {data.produtos.length === 0 ? (
          <p className="py-16 text-center text-sm text-slate-400">Este catálogo ainda não tem produtos.</p>
        ) : (
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
            {data.produtos.map((p) => (
              <article key={p.id} className="card overflow-hidden !p-0">
                {p.fotos?.[0]?.url ? (
                  <img src={p.fotos[0].url} alt={p.nome} className="aspect-[3/4] w-full object-cover" loading="lazy" />
                ) : (
                  <div className="flex aspect-[3/4] w-full items-center justify-center bg-slate-100">
                    <Shirt className="h-10 w-10 text-slate-300" />
                  </div>
                )}
                <div className="p-3">
                  <div className="flex items-start justify-between gap-2">
                    <h2 className="text-sm font-semibold leading-snug text-navy-900">{p.nome}</h2>
                    {p.sku && <span className="shrink-0 font-mono text-[10px] text-slate-400">{p.sku}</span>}
                  </div>
                  {p.cor && (
                    <p className="mt-1 flex items-center gap-1.5 text-xs text-slate-500">
                      {p.cor_hex ? <span className="h-3 w-3 rounded-full ring-1 ring-black/10" style={{ background: p.cor_hex }} /> : null}
                      {p.cor}
                    </p>
                  )}
                  {p.composicao && <p className="mt-0.5 text-[11px] text-slate-400">{p.composicao}</p>}
                  <div className="mt-2 flex flex-wrap items-center gap-1">
                    {p.tamanhos.length > 0 ? (
                      p.tamanhos.map((t) =>
                        data.mostrar_saldo ? (
                          <span key={t.codigo} className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${t.quantidade > 0 ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-400'}`}>
                            {t.codigo}
                            <span className="ml-1 tabular-nums opacity-70">{formatNumber(t.quantidade)}</span>
                          </span>
                        ) : (
                          <span key={t.codigo} className="rounded bg-slate-100 px-1.5 py-0.5 text-[11px] font-medium text-slate-600">
                            {t.codigo}
                          </span>
                        )
                      )
                    ) : (
                      <span className="text-[11px] text-slate-300">sem tamanhos</span>
                    )}
                  </div>
                  {data.mostrar_preco && p.preco !== null && <p className="mt-2 text-base font-bold tabular-nums text-brand-600">{formatMoney(p.preco)}</p>}
                  {p.descricao && <p className="mt-1 line-clamp-2 text-[11px] leading-relaxed text-slate-400">{p.descricao}</p>}
                </div>
              </article>
            ))}
          </div>
        )}
        <p className="mt-8 text-center text-[11px] text-slate-400">Catálogo gerado no BROBOND ERP · preços sujeitos a alteração sem aviso</p>
      </main>
    </div>
  );
}
