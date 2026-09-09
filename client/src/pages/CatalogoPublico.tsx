import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import {
  ChevronLeft,
  ChevronRight,
  Eye,
  EyeOff,
  ImageOff,
  Info,
  Link2,
  Lock,
  Minus,
  Plus,
  Ruler,
  Search,
  Send,
  Shirt,
  ShoppingBag,
  LayoutGrid,
  Table2,
  Upload,
  X,
} from 'lucide-react';
import { api, apiFetch, ApiError } from '../lib/api';
import { Logo } from '../components/Logo';
import { useToast } from '../components/ui';
import { formatDateTime, formatMoney, formatNumber } from '../lib/format';

type MedidasCatalogo = {
  medidas: { id: number; nome: string; unidade: string }[];
  linhas: { tamanho_id: number; codigo: string; valores: Record<string, number | null> }[];
  instrucoes: string | null;
  atualizada_em: string | null;
  resumo: { celulas_total: number; celulas_preenchidas: number; pct: number };
};

type ProdutoCatalogo = {
  id: number;
  sku: string | null;
  nome: string;
  cor: string | null;
  cor_hex: string | null;
  composicao: string | null;
  descricao: string | null;
  preco: number | null;
  preco_tipo: 'varejo' | 'atacado' | null;
  preco_venda: number | null;
  preco_atacado: number | null;
  disponivel_site: boolean;
  foto_url: string | null;
  fotos: { url: string; thumb_url: string }[];
  tamanhos: { tamanho_id: number; codigo: string; quantidade: number | null }[];
  medidas: MedidasCatalogo | null;
};

type CatResp = {
  nome: string;
  canal: string;
  tabela_preco: string;
  aceita_pedido_site: boolean;
  como_comprar: string | null;
  mostrar_preco: boolean;
  mostrar_saldo: boolean;
  mostrar_medidas: boolean;
  politica_comercial: { nome: string; desconto_pct: number; pedido_min_valor: number; pedido_min_pecas: number; produto_min_qtd: number; multiplo_qtd: number } | null;
  total: number;
  produtos: ProdutoCatalogo[];
};

type CartItem = { key: string; produto: ProdutoCatalogo; qtd: number; tamanho_id: number; tamanho_codigo: string };

export default function CatalogoPublico() {
  const toast = useToast();
  const { token } = useParams();
  const [senha, setSenha] = useState('');
  const [precisaSenha, setPrecisaSenha] = useState(false);
  const [err, setErr] = useState('');
  const [data, setData] = useState<CatResp | null>(null);
  const [busy, setBusy] = useState(false);
  const [showSenha, setShowSenha] = useState(false);
  const [cart, setCart] = useState<CartItem[]>([]);
  const [selTamanho, setSelTamanho] = useState<Record<number, number>>({});
  const [medidasAbertas, setMedidasAbertas] = useState<Record<number, boolean>>({});
  const [pedidoOpen, setPedidoOpen] = useState(false);
  const [pedidoEnviado, setPedidoEnviado] = useState(false);
  // Detalhe do produto (tudo que o cliente precisa em um só lugar)
  const [detalheId, setDetalheId] = useState<number | null>(null);
  const [busca, setBusca] = useState('');
  const [ordenacao, setOrdenacao] = useState<'nome' | 'menor_preco' | 'maior_preco'>('nome');
  const [somenteDisponiveis, setSomenteDisponiveis] = useState(false);
  const [modo, setModo] = useState<'vitrine' | 'rapido'>('vitrine');
  const [rascunhoCarregado, setRascunhoCarregado] = useState(false);

  const carregar = useCallback(
    async (comSenha: string) => {
      setBusy(true);
      setErr('');
      try {
        const d = await apiFetch<CatResp>(`/publico/catalogo/${token}`, {
          headers: comSenha ? { 'X-Catalogo-Senha': comSenha } : {},
        });
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

  // Deep link: o link do produto (#p-<id>) abre o detalhe direto — dá para
  // compartilhar a peça específica com o cliente.
  useEffect(() => {
    if (!data) return;
    const m = /#p-(\d+)/.exec(window.location.hash);
    if (m) {
      const id = Number(m[1]);
      if (data.produtos.some((p) => p.id === id)) setDetalheId(id);
    }
  }, [data]);

  useEffect(() => {
    if (!data) return;
    if (detalheId !== null) {
      history.replaceState(null, '', `#p-${detalheId}`);
    } else {
      history.replaceState(null, '', window.location.pathname + window.location.search);
    }
  }, [detalheId, data]);

  function abrirDetalhe(id: number, medidasAberta: boolean) {
    if (detalheId !== id) api.post(`/publico/catalogo/${token}/evento`, { tipo: 'produto_visualizado', produto_id: id }).catch(() => {});
    setDetalheId(id);
    if (medidasAberta) setMedidasAbertas((prev) => ({ ...prev, [id]: true }));
  }

  function addToCart(p: ProdutoCatalogo, tamanho?: { tamanho_id: number; codigo: string }) {
    const t = tamanho || p.tamanhos[0];
    if (cart.length === 0) api.post(`/publico/catalogo/${token}/evento`, { tipo: 'carrinho_iniciado', produto_id: p.id }).catch(() => {});
    const key = `${p.id}:${t?.tamanho_id ?? 0}`;
    setCart((prev) => {
      const found = prev.find((i) => i.key === key);
      if (found) return prev.map((i) => (i.key === key ? { ...i, qtd: i.qtd + 1 } : i));
      return [...prev, { key, produto: p, qtd: 1, tamanho_id: t?.tamanho_id ?? 0, tamanho_codigo: t?.codigo ?? '' }];
    });
    setPedidoEnviado(false);
  }

  function setQuantidade(p: ProdutoCatalogo, t: { tamanho_id: number; codigo: string }, qtd: number) {
    const key = `${p.id}:${t.tamanho_id}`;
    const quantidade = Math.max(0, Math.min(9999, Math.floor(qtd || 0)));
    setCart((prev) => {
      if (quantidade === 0) return prev.filter((i) => i.key !== key);
      const found = prev.some((i) => i.key === key);
      return found ? prev.map((i) => i.key === key ? { ...i, qtd: quantidade } : i) : [...prev, { key, produto: p, qtd: quantidade, tamanho_id: t.tamanho_id, tamanho_codigo: t.codigo }];
    });
    setPedidoEnviado(false);
  }

  function changeQtd(key: string, delta: number) {
    setCart((prev) => prev.map((i) => (i.key === key ? { ...i, qtd: Math.max(1, i.qtd + delta) } : i)).filter((i) => i.qtd > 0));
  }

  function removeFromCart(key: string) {
    setCart((prev) => prev.filter((i) => i.key !== key));
  }

  // Rascunho local por catálogo: recompra e retomada mesmo após fechar o navegador.
  useEffect(() => {
    if (!data || rascunhoCarregado) return;
    try {
      const raw = JSON.parse(localStorage.getItem(`brobond_catalogo_rascunho_${token}`) || '[]') as { produto_id: number; tamanho_id: number; qtd: number }[];
      const itens = raw.flatMap((x) => {
        const p = data.produtos.find((v) => v.id === x.produto_id);
        const t = p?.tamanhos.find((v) => v.tamanho_id === x.tamanho_id);
        return p && t && x.qtd > 0 ? [{ key: `${p.id}:${t.tamanho_id}`, produto: p, qtd: x.qtd, tamanho_id: t.tamanho_id, tamanho_codigo: t.codigo }] : [];
      });
      if (itens.length) setCart(itens);
    } catch { localStorage.removeItem(`brobond_catalogo_rascunho_${token}`); }
    setRascunhoCarregado(true);
  }, [data, token, rascunhoCarregado]);
  useEffect(() => {
    if (!rascunhoCarregado) return;
    localStorage.setItem(`brobond_catalogo_rascunho_${token}`, JSON.stringify(cart.map((i) => ({ produto_id: i.produto.id, tamanho_id: i.tamanho_id, qtd: i.qtd }))));
  }, [cart, token, rascunhoCarregado]);

  const totalPedido = cart.reduce((s, i) => s + (i.produto.preco || 0) * i.qtd, 0);
  const pedidoHabilitado = !!data?.aceita_pedido_site;
  const produtosVisiveis = useMemo(() => {
    if (!data) return [];
    const termo = busca.trim().toLocaleLowerCase('pt-BR');
    return data.produtos
      .filter((p) => !termo || [p.nome, p.sku, p.cor, p.composicao].some((v) => v?.toLocaleLowerCase('pt-BR').includes(termo)))
      .filter((p) => !somenteDisponiveis || p.tamanhos.length > 0)
      .sort((a, b) => {
        if (ordenacao === 'menor_preco') return (a.preco ?? Infinity) - (b.preco ?? Infinity);
        if (ordenacao === 'maior_preco') return (b.preco ?? -Infinity) - (a.preco ?? -Infinity);
        return a.nome.localeCompare(b.nome, 'pt-BR', { sensitivity: 'base' });
      });
  }, [data, busca, somenteDisponiveis, ordenacao]);
  const detalhe = detalheId !== null && data ? (data.produtos.find((p) => p.id === detalheId) ?? null) : null;

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
              <button
                type="button"
                className="absolute inset-y-0 right-0 flex items-center px-3 text-slate-400"
                onClick={() => setShowSenha((s) => !s)}
                title={showSenha ? 'Ocultar senha' : 'Mostrar senha'}
                aria-label={showSenha ? 'Ocultar senha' : 'Mostrar senha'}
              >
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
          {data.canal === 'atacado' ? ' · preços de atacado' : data.canal === 'varejo' ? ' · preços de varejo' : ''}
          {data.mostrar_medidas ? ' · tabela de medidas em cada produto' : ''}
        </p>
        {data.como_comprar && <p className="mx-auto mt-3 max-w-2xl whitespace-pre-line text-sm text-navy-200">{data.como_comprar}</p>}
        {pedidoHabilitado && (
          <button
            className="mx-auto mt-4 inline-flex items-center gap-2 rounded-xl bg-brand-500 px-4 py-2 text-sm font-semibold text-white shadow hover:bg-brand-600"
            onClick={() => setPedidoOpen(true)}
            disabled={!cart.length}
          >
            <ShoppingBag className="h-4 w-4" /> Montar pedido {cart.length > 0 && `(${cart.length})`}
          </button>
        )}
      </header>

      <main className="mx-auto max-w-6xl px-4 py-6 pb-24 sm:px-6">
        {data.politica_comercial && (
          <section className="mb-4 rounded-xl border border-brand-200 bg-brand-50 px-4 py-3 text-sm text-brand-900">
            <p className="font-bold">Condição comercial: {data.politica_comercial.nome}</p>
            <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-brand-800">
              {data.politica_comercial.desconto_pct > 0 && <span>{formatNumber(data.politica_comercial.desconto_pct)}% de desconto aplicado</span>}
              {data.politica_comercial.pedido_min_valor > 0 && <span>Pedido mínimo {formatMoney(data.politica_comercial.pedido_min_valor)}</span>}
              {data.politica_comercial.pedido_min_pecas > 0 && <span>Mínimo de {data.politica_comercial.pedido_min_pecas} peças</span>}
              {data.politica_comercial.produto_min_qtd > 0 && <span>Mínimo de {data.politica_comercial.produto_min_qtd} por item</span>}
              {data.politica_comercial.multiplo_qtd > 1 && <span>Quantidades em múltiplos de {data.politica_comercial.multiplo_qtd}</span>}
            </div>
          </section>
        )}
        {data.produtos.length > 0 && (
          <section className="mb-5 rounded-2xl border border-slate-200 bg-white p-3 shadow-sm" aria-label="Busca e filtros">
            <div className="flex flex-col gap-3 sm:flex-row">
              <label className="relative flex-1">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                <input className="input !pl-9" type="search" placeholder="Buscar por produto, SKU, cor ou composição" value={busca} onChange={(e) => setBusca(e.target.value)} />
              </label>
              <select className="input sm:w-48" value={ordenacao} onChange={(e) => setOrdenacao(e.target.value as typeof ordenacao)} aria-label="Ordenar produtos">
                <option value="nome">Nome: A–Z</option>
                {data.mostrar_preco && <option value="menor_preco">Menor preço</option>}
                {data.mostrar_preco && <option value="maior_preco">Maior preço</option>}
              </select>
              <label className="flex cursor-pointer items-center gap-2 whitespace-nowrap px-1 text-sm text-slate-600">
                <input type="checkbox" checked={somenteDisponiveis} onChange={(e) => setSomenteDisponiveis(e.target.checked)} className="h-4 w-4 rounded border-slate-300 text-brand-600" />
                Com estoque
              </label>
            </div>
            <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
              <p className="text-xs text-slate-400" aria-live="polite">{produtosVisiveis.length} de {data.total} produtos</p>
              {pedidoHabilitado && <div className="inline-flex rounded-lg border border-slate-200 bg-slate-50 p-0.5">
                <button className={`rounded-md px-2.5 py-1 text-xs font-semibold ${modo === 'vitrine' ? 'bg-white text-navy-800 shadow-sm' : 'text-slate-500'}`} onClick={() => setModo('vitrine')}><LayoutGrid className="mr-1 inline h-3.5 w-3.5" />Vitrine</button>
                <button className={`rounded-md px-2.5 py-1 text-xs font-semibold ${modo === 'rapido' ? 'bg-white text-navy-800 shadow-sm' : 'text-slate-500'}`} onClick={() => setModo('rapido')}><Table2 className="mr-1 inline h-3.5 w-3.5" />Pedido rápido</button>
              </div>}
            </div>
          </section>
        )}
        {data.produtos.length === 0 ? (
          <p className="py-16 text-center text-sm text-slate-400">Este catálogo ainda não tem produtos.</p>
        ) : modo === 'rapido' && pedidoHabilitado ? (
          <PedidoRapido produtos={produtosVisiveis} cart={cart} politica={data.politica_comercial} mostrarSaldo={data.mostrar_saldo} onQuantidade={setQuantidade} />
        ) : (
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
            {produtosVisiveis.length === 0 && <p className="col-span-full py-16 text-center text-sm text-slate-500">Nenhum produto corresponde aos filtros.</p>}
            {produtosVisiveis.map((p) => (
              <article
                key={p.id}
                className="card cursor-pointer overflow-hidden !p-0 transition-shadow hover:shadow-lg"
                onClick={() => abrirDetalhe(p.id, true)}
              >
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
                          <span
                            key={t.codigo}
                            className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${(t.quantidade ?? 0) > 0 ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-400'}`}
                          >
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

                  {/* Preço varejo/atacado */}
                  {data.mostrar_preco && p.preco !== null && (
                    <div className="mt-2">
                      <p className="text-base font-bold tabular-nums text-brand-600">{formatMoney(p.preco)}</p>
                      {p.preco_atacado !== null && p.preco_atacado !== p.preco_venda && (
                        <p className="text-[11px] tabular-nums text-slate-400">Atacado {formatMoney(p.preco_atacado)}</p>
                      )}
                      <span className="text-[10px] uppercase tracking-wide text-slate-400">
                        {p.preco_tipo === 'atacado' ? 'Preço atacado' : 'Preço varejo'}
                      </span>
                    </div>
                  )}

                  {pedidoHabilitado && p.disponivel_site && p.tamanhos.length > 0 && (
                    <select
                      className="input mt-2 !py-1 text-xs"
                      value={selTamanho[p.id] ?? p.tamanhos[0].tamanho_id}
                      onChange={(e) => {
                        e.stopPropagation();
                        setSelTamanho((prev) => ({ ...prev, [p.id]: Number(e.target.value) }));
                      }}
                      aria-label={`Tamanho de ${p.nome}`}
                    >
                      {p.tamanhos.map((t) => (
                        <option key={t.tamanho_id} value={t.tamanho_id}>
                          Tamanho {t.codigo}
                          {data.mostrar_saldo ? ` · ${formatNumber(t.quantidade)}` : ''}
                        </option>
                      ))}
                    </select>
                  )}

                  {p.descricao && <p className="mt-1 line-clamp-2 text-[11px] leading-relaxed text-slate-400">{p.descricao}</p>}

                  {data.mostrar_medidas && p.medidas && p.medidas.medidas.length > 0 && (
                    <button
                      type="button"
                      className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-lg border border-navy-100 bg-navy-50/60 px-2 py-1.5 text-[11px] font-semibold text-navy-700 hover:bg-navy-50"
                      onClick={(e) => {
                        e.stopPropagation();
                        abrirDetalhe(p.id, true);
                      }}
                    >
                      <Ruler className="h-3.5 w-3.5" /> Ver tabela de medidas
                    </button>
                  )}

                  {pedidoHabilitado &&
                    p.disponivel_site &&
                    (() => {
                      const selected = p.tamanhos.find((t) => t.tamanho_id === (selTamanho[p.id] ?? p.tamanhos[0]?.tamanho_id));
                      const item = cart.find((i) => i.produto.id === p.id && i.tamanho_id === selected?.tamanho_id);
                      return (
                        <div className="mt-2 flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
                          {item ? (
                            <>
                              <button
                                className="btn-secondary h-8 w-8 !p-0"
                                onClick={() => changeQtd(item.key, -1)}
                                disabled={item.qtd === 1}
                                aria-label="Diminuir"
                              >
                                <Minus className="h-3.5 w-3.5" />
                              </button>
                              <span className="w-7 text-center text-sm font-semibold tabular-nums">{item.qtd}</span>
                              <button className="btn-secondary h-8 w-8 !p-0" onClick={() => changeQtd(item.key, 1)} aria-label="Aumentar">
                                <Plus className="h-3.5 w-3.5" />
                              </button>
                            </>
                          ) : (
                            <button
                              className="btn-secondary flex-1 justify-center !px-2 !py-1.5 text-xs"
                              onClick={() => addToCart(p, selected)}
                            >
                              <Plus className="h-3.5 w-3.5" /> Pedir
                            </button>
                          )}
                        </div>
                      );
                    })()}
                </div>
              </article>
            ))}
          </div>
        )}
        <p className="mt-8 text-center text-[11px] text-slate-400">
          Catálogo gerado no BROBOND ERP · preços sujeitos a alteração sem aviso
        </p>
      </main>

      {cart.length > 0 && (
        <div className="fixed inset-x-0 bottom-0 z-30 border-t border-slate-200 bg-white px-4 py-3 shadow-[0_-8px_24px_rgba(0,0,0,.08)]">
          <div className="mx-auto flex max-w-6xl items-center justify-between gap-3">
            <div>
              <p className="text-sm font-semibold text-navy-900">{cart.length} produto(s)</p>
              <p className="text-xs text-slate-400">Total {formatMoney(totalPedido)}</p>
            </div>
            <button className="btn-accent" onClick={() => setPedidoOpen(true)}>
              <ShoppingBag className="h-4 w-4" /> Enviar pedido
            </button>
          </div>
        </div>
      )}

      {detalhe && (
        <ProdutoDetalhe
          p={detalhe}
          data={data}
          medidasAberta={!!medidasAbertas[detalhe.id]}
          onToggleMedidas={() => setMedidasAbertas((prev) => ({ ...prev, [detalhe.id]: !prev[detalhe.id] }))}
          selTamanho={selTamanho[detalhe.id] ?? detalhe.tamanhos[0]?.tamanho_id}
          onSelTamanho={(tid) => setSelTamanho((prev) => ({ ...prev, [detalhe.id]: tid }))}
          onAdd={() => {
            const selected = detalhe.tamanhos.find((t) => t.tamanho_id === (selTamanho[detalhe.id] ?? detalhe.tamanhos[0]?.tamanho_id));
            addToCart(detalhe, selected);
          }}
          onShare={async () => {
            const url = `${window.location.origin}${window.location.pathname}#p-${detalhe.id}`;
            try {
              await navigator.clipboard.writeText(url);
              toast.success('Link do produto copiado — envie para o cliente.');
            } catch {
              window.prompt('Copie o link do produto:', url);
            }
          }}
          onClose={() => setDetalheId(null)}
        />
      )}

      {pedidoOpen && (
        <CatalogoPedidoModal
          cart={cart}
          total={totalPedido}
          canal={data.canal}
          senha={senha}
          onQty={changeQtd}
          onRemove={removeFromCart}
          onClose={() => setPedidoOpen(false)}
          onEnviado={() => {
            setPedidoOpen(false);
            setPedidoEnviado(true);
            setCart([]);
          }}
        />
      )}

      {pedidoEnviado && (
        <div
          className="pointer-events-none fixed inset-0 z-40 flex items-end justify-center bg-black/30 p-4 sm:items-center"
          onClick={() => setPedidoEnviado(false)}
        >
          <div className="pointer-events-auto card max-w-md !p-6 text-center" onClick={(e) => e.stopPropagation()}>
            <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-emerald-50 text-emerald-600">
              <Send className="h-6 w-6" />
            </div>
            <h2 className="mt-3 text-lg font-bold text-navy-900">Pedido enviado!</h2>
            <p className="mt-1 text-sm text-slate-500">
              Recebemos sua solicitação. Nossa equipe entra em contato para confirmar disponibilidade e finalizar.
            </p>
            <button className="btn-primary mt-4 w-full justify-center" onClick={() => setPedidoEnviado(false)}>
              Fechar
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ----------------------------------------------------------------------------
// Detalhe do produto — tudo o que o cliente precisa decidir, em um só lugar:
// fotos (todas), descrição completa, composição, preço, tamanhos com saldo e a
// tabela de medidas profissional (unidade por coluna, instruções, atualização).
// ----------------------------------------------------------------------------
function ProdutoDetalhe({
  p,
  data,
  medidasAberta,
  onToggleMedidas,
  selTamanho,
  onSelTamanho,
  onAdd,
  onShare,
  onClose,
}: {
  p: ProdutoCatalogo;
  data: CatResp;
  medidasAberta: boolean;
  onToggleMedidas: () => void;
  selTamanho: number | undefined;
  onSelTamanho: (tid: number) => void;
  onAdd: () => void;
  onShare: () => void;
  onClose: () => void;
}) {
  const [fotoIdx, setFotoIdx] = useState(0);
  useEffect(() => setFotoIdx(0), [p.id]);

  const fotos = p.fotos?.length ? p.fotos : [];
  const pedidoHabilitado = data.aceita_pedido_site;
  const medShow = data.mostrar_medidas && p.medidas && p.medidas.medidas.length > 0;
  const sel = p.tamanhos.find((t) => t.tamanho_id === selTamanho);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
    };
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center sm:p-4" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-navy-950/50 backdrop-blur-[2px]" onClick={onClose} />
      <div className="relative flex max-h-[94vh] w-full max-w-3xl flex-col overflow-hidden rounded-t-2xl bg-white shadow-modal animate-fade-in sm:rounded-2xl">
        <div className="flex items-center justify-between border-b border-slate-200 px-5 py-3">
          <div className="flex items-center gap-2">
            <h2 className="truncate text-base font-bold text-navy-900">{p.nome}</h2>
            {p.sku && <span className="hidden shrink-0 font-mono text-[10px] text-slate-400 sm:inline">{p.sku}</span>}
          </div>
          <div className="flex items-center gap-1">
            <button className="btn-icon" onClick={onShare} title="Copiar link deste produto" aria-label="Copiar link deste produto">
              <Link2 className="h-4 w-4" />
            </button>
            <button className="btn-icon" onClick={onClose} aria-label="Fechar">
              <X className="h-5 w-5" />
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto">
          <div className="grid gap-5 p-5 sm:grid-cols-[minmax(0,280px)_1fr]">
            {/* Fotos */}
            <div>
              <div className="relative overflow-hidden rounded-xl bg-slate-100">
                {fotos.length ? (
                  <img src={fotos[fotoIdx].url} alt={`${p.nome} — foto ${fotoIdx + 1}`} className="aspect-[3/4] w-full object-cover" />
                ) : (
                  <div className="flex aspect-[3/4] w-full items-center justify-center">
                    <Shirt className="h-10 w-10 text-slate-300" />
                  </div>
                )}
                {fotos.length > 1 && (
                  <>
                    <button
                      className="absolute left-1.5 top-1/2 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-full bg-white/90 text-navy-800 shadow hover:bg-white"
                      onClick={() => setFotoIdx((i) => (i - 1 + fotos.length) % fotos.length)}
                      aria-label="Foto anterior"
                    >
                      <ChevronLeft className="h-4 w-4" />
                    </button>
                    <button
                      className="absolute right-1.5 top-1/2 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-full bg-white/90 text-navy-800 shadow hover:bg-white"
                      onClick={() => setFotoIdx((i) => (i + 1) % fotos.length)}
                      aria-label="Próxima foto"
                    >
                      <ChevronRight className="h-4 w-4" />
                    </button>
                    <span className="absolute bottom-1.5 right-1.5 rounded-full bg-navy-950/70 px-2 py-0.5 text-[10px] font-medium text-white">
                      {fotoIdx + 1}/{fotos.length}
                    </span>
                  </>
                )}
              </div>
              {fotos.length > 1 && (
                <div className="mt-2 flex gap-1.5 overflow-x-auto pb-1">
                  {fotos.map((f, i) => (
                    <button
                      key={i}
                      className={`h-14 w-11 shrink-0 overflow-hidden rounded-md border-2 ${i === fotoIdx ? 'border-brand-500' : 'border-transparent opacity-70 hover:opacity-100'}`}
                      onClick={() => setFotoIdx(i)}
                      aria-label={`Ver foto ${i + 1}`}
                    >
                      <img src={f.thumb_url || f.url} alt="" className="h-full w-full object-cover" />
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Informações */}
            <div className="space-y-4">
              <div>
                <h3 className="text-lg font-bold leading-snug text-navy-900">{p.nome}</h3>
                <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500">
                  {p.cor && (
                    <span className="flex items-center gap-1.5">
                      {p.cor_hex ? <span className="h-3 w-3 rounded-full ring-1 ring-black/10" style={{ background: p.cor_hex }} /> : null}
                      {p.cor}
                    </span>
                  )}
                  {p.composicao && <span>{p.composicao}</span>}
                  {p.sku && <span className="font-mono text-slate-400">{p.sku}</span>}
                </div>
                {data.mostrar_preco && p.preco !== null && (
                  <div className="mt-3 flex items-end gap-2">
                    <span className="text-2xl font-bold tabular-nums text-brand-600">{formatMoney(p.preco)}</span>
                    <span className="pb-0.5 text-[10px] uppercase tracking-wide text-slate-400">
                      {p.preco_tipo === 'atacado' ? 'preço atacado' : 'preço varejo'}
                    </span>
                    {p.preco_atacado !== null && p.preco_atacado !== p.preco_venda && (
                      <span className="pb-0.5 text-xs tabular-nums text-slate-400">Atacado {formatMoney(p.preco_atacado)}</span>
                    )}
                  </div>
                )}
              </div>

              {p.descricao && <p className="whitespace-pre-line text-sm leading-relaxed text-slate-600">{p.descricao}</p>}

              {p.tamanhos.length > 0 && (
                <div>
                  <p className="label">Tamanhos disponíveis</p>
                  <div className="mt-1.5 flex flex-wrap gap-1.5">
                    {p.tamanhos.map((t) => (
                      <button
                        key={t.tamanho_id}
                        className={`rounded-lg border px-3 py-1.5 text-sm font-semibold transition-colors ${
                          t.tamanho_id === selTamanho
                            ? 'border-brand-500 bg-brand-50 text-brand-700'
                            : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300'
                        }`}
                        onClick={() => pedidoHabilitado && p.disponivel_site && onSelTamanho(t.tamanho_id)}
                        title={data.mostrar_saldo ? `${t.quantidade} em estoque` : undefined}
                      >
                        {t.codigo}
                        {data.mostrar_saldo && (
                          <span className="ml-1 text-[10px] font-normal text-slate-400">({formatNumber(t.quantidade)})</span>
                        )}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {pedidoHabilitado && p.disponivel_site && p.tamanhos.length > 0 && (
                <button className="btn-accent w-full justify-center sm:w-auto" onClick={onAdd}>
                  <Plus className="h-4 w-4" /> Adicionar ao pedido {sel ? `— tamanho ${sel.codigo}` : ''}
                </button>
              )}
              {pedidoHabilitado && !p.disponivel_site && (
                <p className="text-xs text-slate-400">Este produto não aceita pedido pelo site — fale com a equipe.</p>
              )}

              {/* Tabela de medidas — o coração da decisão do cliente */}
              {medShow && (
                <div className="rounded-xl border border-navy-100 bg-navy-50/40 p-3.5">
                  <button type="button" className="flex w-full items-center justify-between" onClick={onToggleMedidas}>
                    <span className="flex items-center gap-2 text-sm font-bold text-navy-800">
                      <Ruler className="h-4 w-4 text-navy-500" /> Tabela de medidas
                    </span>
                    <span className="text-xs text-slate-400">{medidasAberta ? 'ocultar' : 'ver medidas'}</span>
                  </button>

                  {medidasAberta && (
                    <div className="mt-3">
                      <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
                        <table className="w-full min-w-[420px] text-sm">
                          <thead className="bg-slate-50">
                            <tr>
                              <th className="px-3 py-2 text-left text-xs font-semibold text-slate-500">Tamanho</th>
                              {p.medidas!.medidas.map((m) => (
                                <th key={m.id} className="px-2 py-2 text-center">
                                  <span className="block text-xs font-semibold text-slate-700">{m.nome}</span>
                                  <span className="block text-[10px] font-normal text-slate-400">{m.unidade}</span>
                                </th>
                              ))}
                            </tr>
                          </thead>
                          <tbody>
                            {p.medidas!.linhas.map((l) => (
                              <tr
                                key={l.tamanho_id}
                                className={`border-t border-slate-100 ${l.tamanho_id === selTamanho ? 'bg-brand-50/70' : ''}`}
                              >
                                <td
                                  className={`px-3 py-2 font-semibold ${l.tamanho_id === selTamanho ? 'text-brand-700' : 'text-navy-900'}`}
                                >
                                  {l.codigo}
                                  {l.tamanho_id === selTamanho && (
                                    <span className="ml-1.5 text-[10px] font-normal text-brand-500">selecionado</span>
                                  )}
                                </td>
                                {p.medidas!.medidas.map((m) => {
                                  const v = l.valores[String(m.id)];
                                  return (
                                    <td
                                      key={m.id}
                                      className={`px-2 py-2 text-center tabular-nums ${l.tamanho_id === selTamanho ? 'font-semibold text-brand-800' : 'text-slate-600'}`}
                                    >
                                      {v === null || v === undefined ? '—' : formatNumber(v)}
                                    </td>
                                  );
                                })}
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>

                      {p.medidas!.instrucoes && (
                        <div className="mt-2.5 flex gap-2 rounded-lg bg-white/70 p-2.5 text-xs leading-relaxed text-slate-600">
                          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-navy-400" />
                          <span>
                            <b className="text-slate-700">Como medir:</b> {p.medidas!.instrucoes}
                          </span>
                        </div>
                      )}

                      <p className="mt-2 text-[11px] text-slate-400">
                        {p.medidas!.resumo.celulas_preenchidas < p.medidas!.resumo.celulas_total
                          ? `Algumas medidas ainda não foram informadas (${p.medidas!.resumo.celulas_preenchidas} de ${p.medidas!.resumo.celulas_total}).`
                          : 'Tabela completa.'}
                        {p.medidas!.atualizada_em ? ` Atualizada em ${formatDateTime(p.medidas!.atualizada_em)}.` : ''}
                      </p>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function CatalogoPedidoModal({
  cart,
  total,
  canal,
  senha,
  onQty,
  onRemove,
  onClose,
  onEnviado,
}: {
  cart: CartItem[];
  total: number;
  canal: string;
  senha: string;
  onQty: (key: string, delta: number) => void;
  onRemove: (key: string) => void;
  onClose: () => void;
  onEnviado: () => void;
}) {
  const [nome, setNome] = useState('');
  const [email, setEmail] = useState('');
  const [telefone, setTelefone] = useState('');
  const [observacoes, setObservacoes] = useState('');
  const [erro, setErro] = useState('');
  const [busy, setBusy] = useState(false);
  const { token } = useParams();

  async function enviar() {
    setErro('');
    if (!nome.trim()) return setErro('Informe seu nome.');
    if (!cart.length) return setErro('Adicione ao menos um item ao pedido.');
    setBusy(true);
    try {
      await api.post(`/publico/catalogo/${token}/pedido`, {
        nome,
        senha,
        email,
        telefone,
        canal: canal === 'atacado' ? 'atacado' : 'varejo',
        observacoes,
        itens: cart.map((i) => ({
          produto_id: i.produto.id,
          tamanho_id: i.tamanho_id,
          quantidade: i.qtd,
          preco_unitario: i.produto.preco,
        })),
      });
      onEnviado();
    } catch (e: any) {
      setErro(e instanceof ApiError ? e.message : 'Não foi possível enviar o pedido. Tente novamente.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-navy-950/50 p-0 sm:items-center sm:p-4">
      <div className="card max-h-[92vh] w-full max-w-lg overflow-y-auto !rounded-b-none !rounded-t-2xl sm:!rounded-2xl !p-0">
        <div className="flex items-center justify-between border-b border-slate-200 px-5 py-4">
          <div>
            <h2 className="text-lg font-bold text-navy-900">Montar pedido</h2>
            <p className="text-xs text-slate-400">Envie sua solicitação — a equipe confirma o pedido.</p>
          </div>
          <button className="btn-icon" onClick={onClose} aria-label="Fechar">
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="max-h-[38vh] space-y-2 overflow-y-auto px-5 py-4">
          {cart.length === 0 && <p className="py-6 text-center text-sm text-slate-400">Seu pedido está vazio.</p>}
          {cart.map((i) => (
            <div key={i.key} className="flex items-center justify-between gap-2 rounded-lg border border-slate-100 px-3 py-2">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-navy-900">{i.produto.nome}</p>
                <p className="text-[11px] tabular-nums text-slate-400">
                  Tamanho {i.tamanho_codigo || '—'} · {i.produto.preco_tipo === 'atacado' ? 'Atacado' : 'Varejo'} ·{' '}
                  {formatMoney(i.produto.preco || 0)} · Total {formatMoney((i.produto.preco || 0) * i.qtd)}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <button
                  className="btn-secondary h-7 w-7 !p-0"
                  onClick={() => onQty(i.key, -1)}
                  disabled={i.qtd === 1}
                  aria-label="Diminuir"
                >
                  <Minus className="h-3 w-3" />
                </button>
                <span className="w-6 text-center text-xs font-semibold">{i.qtd}</span>
                <button className="btn-secondary h-7 w-7 !p-0" onClick={() => onQty(i.key, 1)} aria-label="Aumentar">
                  <Plus className="h-3 w-3" />
                </button>
                <button
                  className="btn-icon h-7 w-7 hover:!bg-red-50 hover:!text-red-600"
                  onClick={() => onRemove(i.key)}
                  aria-label="Remover"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          ))}
        </div>
        <div className="space-y-3 border-t border-slate-100 px-5 py-4">
          {erro && <p className="text-sm text-red-600">{erro}</p>}
          <input className="input" placeholder="Seu nome *" value={nome} onChange={(e) => setNome(e.target.value)} />
          <input className="input" placeholder="E-mail (opcional)" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          <input
            className="input"
            placeholder="Telefone / WhatsApp (opcional)"
            value={telefone}
            onChange={(e) => setTelefone(e.target.value)}
          />
          <textarea
            className="input"
            placeholder="Observações (opcional)"
            rows={2}
            value={observacoes}
            onChange={(e) => setObservacoes(e.target.value)}
          />
          <div className="flex items-center justify-between rounded-lg bg-slate-50 px-3 py-2">
            <span className="text-sm text-slate-600">Total estimado</span>
            <span className="text-base font-bold tabular-nums text-navy-900">{formatMoney(total)}</span>
          </div>
          <button className="btn-accent w-full justify-center" onClick={enviar} disabled={busy || !cart.length}>
            <Send className="h-4 w-4" /> Enviar pedido {busy ? '...' : ''}
          </button>
          <p className="text-[11px] text-slate-400">
            Ao enviar, você autoriza o contato para confirmação. Não é pagamento online — a cobrança é combinada com a equipe.
          </p>
        </div>
      </div>
    </div>
  );
}

function PedidoRapido({ produtos, cart, politica, mostrarSaldo, onQuantidade }: {
  produtos: ProdutoCatalogo[]; cart: CartItem[];
  politica: CatResp['politica_comercial']; mostrarSaldo: boolean;
  onQuantidade: (p: ProdutoCatalogo, t: { tamanho_id: number; codigo: string }, qtd: number) => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const toast = useToast();
  const qtd = (pid: number, tid: number) => cart.find((i) => i.produto.id === pid && i.tamanho_id === tid)?.qtd || 0;
  async function importar(file?: File) {
    if (!file) return;
    const linhas = (await file.text()).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    let aplicados = 0;
    for (const linha of linhas.slice(1)) {
      const [sku, tamanho, quantidadeRaw] = linha.split(/[;,\t]/).map((x) => x.trim());
      const p = produtos.find((x) => String(x.sku || '').toLocaleLowerCase('pt-BR') === sku.toLocaleLowerCase('pt-BR'));
      const t = p?.tamanhos.find((x) => x.codigo.toLocaleLowerCase('pt-BR') === tamanho.toLocaleLowerCase('pt-BR'));
      const quantidade = Number(quantidadeRaw);
      if (p && t && Number.isInteger(quantidade) && quantidade >= 0) { onQuantidade(p, t, quantidade); aplicados++; }
    }
    toast[aplicados ? 'success' : 'error'](aplicados ? `${aplicados} quantidade(s) importada(s).` : 'Nenhuma linha válida. Use: SKU;Tamanho;Quantidade.');
    if (fileRef.current) fileRef.current.value = '';
  }
  return <section className="card overflow-hidden !p-0">
    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 px-4 py-3">
      <div><h2 className="text-sm font-bold text-navy-900">Pedido rápido por grade</h2><p className="text-xs text-slate-400">Digite as quantidades e use Tab para avançar. O rascunho é salvo automaticamente.</p></div>
      <><input ref={fileRef} type="file" accept=".csv,.txt" className="hidden" onChange={(e) => importar(e.target.files?.[0])} /><button className="btn-secondary text-xs" onClick={() => fileRef.current?.click()}><Upload className="h-3.5 w-3.5" /> Importar CSV</button></>
    </div>
    {politica && (politica.produto_min_qtd > 0 || politica.multiplo_qtd > 1) && <p className="border-b border-brand-100 bg-brand-50 px-4 py-2 text-xs text-brand-800">{politica.produto_min_qtd > 0 ? `Mínimo ${politica.produto_min_qtd} por item. ` : ''}{politica.multiplo_qtd > 1 ? `Use múltiplos de ${politica.multiplo_qtd}.` : ''}</p>}
    <div className="overflow-x-auto"><table className="table min-w-[700px]"><thead><tr><th className="sticky left-0 z-10 bg-slate-50">Produto</th><th>Preço</th><th>Grade / quantidades</th><th className="text-right">Subtotal</th></tr></thead><tbody>{produtos.map((p) => {
      const itens = cart.filter((i) => i.produto.id === p.id); const sub = itens.reduce((n, i) => n + (p.preco || 0) * i.qtd, 0);
      return <tr key={p.id}><td className="sticky left-0 bg-white"><div className="font-semibold text-navy-900">{p.nome}</div><div className="font-mono text-[10px] text-slate-400">{p.sku || 'sem SKU'}</div></td><td className="whitespace-nowrap font-semibold text-brand-700">{formatMoney(p.preco || 0)}</td><td><div className="flex flex-wrap gap-2">{p.tamanhos.map((t) => <label key={t.tamanho_id} className="flex items-center gap-1 rounded-lg border border-slate-200 bg-slate-50 p-1"><span className="min-w-6 text-center text-xs font-bold text-slate-600">{t.codigo}</span><input type="number" min={0} max={mostrarSaldo ? (t.quantidade ?? 9999) : 9999} step={politica?.multiplo_qtd || 1} value={qtd(p.id, t.tamanho_id) || ''} placeholder="0" onChange={(e) => onQuantidade(p, t, Number(e.target.value))} className="h-7 w-16 rounded border border-slate-200 bg-white px-1 text-center text-sm tabular-nums outline-none focus:border-brand-500" aria-label={`${p.nome}, tamanho ${t.codigo}`} /></label>)}</div></td><td className="text-right font-semibold tabular-nums text-navy-900">{formatMoney(sub)}</td></tr>;
    })}</tbody></table></div>
    {!produtos.length && <p className="py-12 text-center text-sm text-slate-400">Nenhum produto corresponde à busca.</p>}
  </section>;
}
