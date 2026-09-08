import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Eye, EyeOff, ImageOff, Lock, Minus, Plus, Ruler, Send, Shirt, ShoppingBag, X } from 'lucide-react';
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
  preco_tipo: 'varejo' | 'atacado' | null;
  preco_venda: number | null;
  preco_atacado: number | null;
  disponivel_site: boolean;
  foto_url: string | null;
  fotos: { url: string; thumb_url: string }[];
  tamanhos: { tamanho_id: number; codigo: string; quantidade: number }[];
  medidas: { medidas: { id: number; nome: string; unidade: string }[]; linhas: { tamanho_id: number; codigo: string; valores: Record<string, number | null> }[] } | null;
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
  total: number;
  produtos: ProdutoCatalogo[];
};

type CartItem = { key: string; produto: ProdutoCatalogo; qtd: number; tamanho_id: number; tamanho_codigo: string };

export default function CatalogoPublico() {
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

  function addToCart(p: ProdutoCatalogo, tamanho?: { tamanho_id: number; codigo: string }) {
    const t = tamanho || p.tamanhos[0];
    const key = `${p.id}:${t?.tamanho_id ?? 0}`;
    setCart((prev) => {
      const found = prev.find((i) => i.key === key);
      if (found) return prev.map((i) => (i.key === key ? { ...i, qtd: i.qtd + 1 } : i));
      return [...prev, { key, produto: p, qtd: 1, tamanho_id: t?.tamanho_id ?? 0, tamanho_codigo: t?.codigo ?? '' }];
    });
    setPedidoEnviado(false);
  }

  function changeQtd(key: string, delta: number) {
    setCart((prev) =>
      prev
        .map((i) => (i.key === key ? { ...i, qtd: Math.max(1, i.qtd + delta) } : i))
        .filter((i) => i.qtd > 0)
    );
  }

  function removeFromCart(key: string) {
    setCart((prev) => prev.filter((i) => i.key !== key));
  }

  const totalPedido = cart.reduce((s, i) => s + (i.produto.preco || 0) * i.qtd, 0);
  const pedidoHabilitado = !!data?.aceita_pedido_site;

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
              <button type="button" className="absolute inset-y-0 right-0 flex items-center px-3 text-slate-400" onClick={() => setShowSenha((s) => !s)} title={showSenha ? 'Ocultar senha' : 'Mostrar senha'} aria-label={showSenha ? 'Ocultar senha' : 'Mostrar senha'}>
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
          {data.mostrar_preco ? ' · preços para revenda' : ''}
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

                  {/* Preço varejo/atacado */}
                  {data.mostrar_preco && p.preco !== null && (
                    <div className="mt-2">
                      <p className="text-base font-bold tabular-nums text-brand-600">{formatMoney(p.preco)}</p>
                      {p.preco_atacado !== null && p.preco_atacado !== p.preco_venda && (
                        <p className="text-[11px] tabular-nums text-slate-400">Atacado {formatMoney(p.preco_atacado)}</p>
                      )}
                      <span className="text-[10px] uppercase tracking-wide text-slate-400">{p.preco_tipo === 'atacado' ? 'Preço atacado' : 'Preço varejo'}</span>
                    </div>
                  )}

                  {pedidoHabilitado && p.disponivel_site && p.tamanhos.length > 0 && (
                    <select
                      className="input mt-2 !py-1 text-xs"
                      value={selTamanho[p.id] ?? p.tamanhos[0].tamanho_id}
                      onChange={(e) => setSelTamanho((prev) => ({ ...prev, [p.id]: Number(e.target.value) }))}
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
                    <div className="mt-2 border-t border-slate-100 pt-2">
                      <button
                        type="button"
                        className="flex items-center gap-1 text-[11px] font-semibold text-navy-700 hover:underline"
                        onClick={() => setMedidasAbertas((prev) => ({ ...prev, [p.id]: !prev[p.id] }))}
                      >
                        <Ruler className="h-3.5 w-3.5" /> Tabela de medidas
                      </button>
                      {medidasAbertas[p.id] && (
                        <div className="mt-1.5 overflow-x-auto rounded border border-slate-100">
                          <table className="w-full text-[10px]">
                            <thead className="bg-slate-50 text-slate-500">
                              <tr>
                                <th className="px-1.5 py-1 text-left font-semibold">Tam.</th>
                                {p.medidas.medidas.map((m) => (
                                  <th key={m.id} className="px-1 py-1 text-center font-semibold">
                                    {m.nome}
                                  </th>
                                ))}
                              </tr>
                            </thead>
                            <tbody>
                              {p.medidas!.linhas.map((l) => (
                                <tr key={l.tamanho_id} className="border-t border-slate-100">
                                  <td className="px-1.5 py-1 font-semibold text-navy-900">{l.codigo}</td>
                                  {p.medidas!.medidas.map((m) => {
                                    const v = l.valores[String(m.id)];
                                    return (
                                      <td key={m.id} className="px-1 py-1 text-center tabular-nums text-slate-600">
                                        {v === null || v === undefined ? '—' : formatNumber(v)}
                                      </td>
                                    );
                                  })}
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </div>
                  )}

                  {pedidoHabilitado && p.disponivel_site && (
                    (() => {
                      const selected = p.tamanhos.find((t) => t.tamanho_id === (selTamanho[p.id] ?? p.tamanhos[0]?.tamanho_id));
                      const item = cart.find((i) => i.produto.id === p.id && i.tamanho_id === selected?.tamanho_id);
                      return (
                        <div className="mt-2 flex items-center gap-1.5">
                          {item ? (
                            <>
                              <button className="btn-secondary h-8 w-8 !p-0" onClick={() => changeQtd(item.key, -1)} disabled={item.qtd === 1} aria-label="Diminuir">
                                <Minus className="h-3.5 w-3.5" />
                              </button>
                              <span className="w-7 text-center text-sm font-semibold tabular-nums">{item.qtd}</span>
                              <button className="btn-secondary h-8 w-8 !p-0" onClick={() => changeQtd(item.key, 1)} aria-label="Aumentar">
                                <Plus className="h-3.5 w-3.5" />
                              </button>
                            </>
                          ) : (
                            <button className="btn-secondary flex-1 justify-center !px-2 !py-1.5 text-xs" onClick={() => addToCart(p, selected)}>
                              <Plus className="h-3.5 w-3.5" /> Pedir
                            </button>
                          )}
                        </div>
                      );
                    })()
                  )}
                </div>
              </article>
            ))}
          </div>
        )}
        <p className="mt-8 text-center text-[11px] text-slate-400">Catálogo gerado no BROBOND ERP · preços sujeitos a alteração sem aviso</p>
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

      {pedidoOpen && (
        <CatalogoPedidoModal
          cart={cart}
          total={totalPedido}
          canal={data.canal}
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
        <div className="pointer-events-none fixed inset-0 z-40 flex items-end justify-center bg-black/30 p-4 sm:items-center" onClick={() => setPedidoEnviado(false)}>
          <div className="pointer-events-auto card max-w-md !p-6 text-center" onClick={(e) => e.stopPropagation()}>
            <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-emerald-50 text-emerald-600">
              <Send className="h-6 w-6" />
            </div>
            <h2 className="mt-3 text-lg font-bold text-navy-900">Pedido enviado!</h2>
            <p className="mt-1 text-sm text-slate-500">Recebemos sua solicitação. Nossa equipe entra em contato para confirmar disponibilidade e finalizar.</p>
            <button className="btn-primary mt-4 w-full justify-center" onClick={() => setPedidoEnviado(false)}>
              Fechar
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function CatalogoPedidoModal({
  cart,
  total,
  canal,
  onQty,
  onRemove,
  onClose,
  onEnviado,
}: {
  cart: CartItem[];
  total: number;
  canal: string;
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
    if (!cart.length) return setErro('Adicione ao menos um produto.');
    setBusy(true);
    try {
      await api.post(`/publico/catalogo/${token}/pedido`, {
        nome,
        email,
        telefone,
        canal: canal === 'atacado' ? 'atacado' : 'varejo',
        observacoes,
        itens: cart.map((i) => ({ produto_id: i.produto.id, tamanho_id: i.tamanho_id, quantidade: i.qtd, preco_unitario: i.produto.preco })),
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
                  Tamanho {i.tamanho_codigo || '—'} · {i.produto.preco_tipo === 'atacado' ? 'Atacado' : 'Varejo'} · {formatMoney(i.produto.preco || 0)} · Total {formatMoney((i.produto.preco || 0) * i.qtd)}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <button className="btn-secondary h-7 w-7 !p-0" onClick={() => onQty(i.key, -1)} disabled={i.qtd === 1} aria-label="Diminuir">
                  <Minus className="h-3 w-3" />
                </button>
                <span className="w-6 text-center text-xs font-semibold">{i.qtd}</span>
                <button className="btn-secondary h-7 w-7 !p-0" onClick={() => onQty(i.key, 1)} aria-label="Aumentar">
                  <Plus className="h-3 w-3" />
                </button>
                <button className="btn-icon h-7 w-7 hover:!bg-red-50 hover:!text-red-600" onClick={() => onRemove(i.key)} aria-label="Remover">
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
          <input className="input" placeholder="Telefone / WhatsApp (opcional)" value={telefone} onChange={(e) => setTelefone(e.target.value)} />
          <textarea className="input" placeholder="Observações (opcional)" rows={2} value={observacoes} onChange={(e) => setObservacoes(e.target.value)} />
          <div className="flex items-center justify-between rounded-lg bg-slate-50 px-3 py-2">
            <span className="text-sm text-slate-600">Total estimado</span>
            <span className="text-base font-bold tabular-nums text-navy-900">{formatMoney(total)}</span>
          </div>
          <button className="btn-accent w-full justify-center" onClick={enviar} disabled={busy || !cart.length}>
            <Send className="h-4 w-4" /> Enviar pedido {busy ? '...' : ''}
          </button>
          <p className="text-[11px] text-slate-400">Ao enviar, você autoriza o contato para confirmação. Não é pagamento online — a cobrança é combinada com a equipe.</p>
        </div>
      </div>
    </div>
  );
}
