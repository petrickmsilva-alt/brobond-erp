// ============================================================================
// BROBOND STORE — PÁGINA DE PRODUTO. Rota /loja/produto/:slug.
//
// Preço, estoque por variação e publicação conferidos no SERVIDOR (404
// idêntico para produto inexistente/despublicado/de outro tenant). Galeria
// profissional inline (sem overlay), relacionados pela categoria real,
// quantidade com botões e disponibilidade sempre server-authoritative.
// ============================================================================
import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Check, Minus, Plus, ShoppingBag, ShieldCheck, Truck } from 'lucide-react';
import { apiFetch, ApiError } from '../../../lib/api';
import { LojaShell, precoLoja, useConfigDoShell } from './LojaShell';
import { adicionarAoCarrinho, normalizarQuantidade } from './carinho';
import GaleriaProduto, { type MidiaLoja } from './GaleriaProduto';
import CardProduto, { rotuloDisponibilidade, type CardProdutoDados } from './CardProduto';

type Detalhe = {
  empresa_id: number;
  produto: {
    id: number;
    sku: string;
    slug: string;
    nome: string;
    resumo: string | null;
    descricao: string;
    composicao?: string | null;
    destaque: boolean;
    preco: number;
    preco_original: number | null;
    promocional: boolean;
    foto_url: string | null;
    imagem_principal?: string | null;
    fotos?: MidiaLoja[];
    galerias_por_variante?: Record<string, MidiaLoja[]>;
    categoria?: { id: number; nome: string; slug: string } | null;
    criado_em?: string | null;
  };
  relacionados?: CardProdutoDados[];
  tamanhos: { tamanho_id: number | null; codigo: string | null; fisico: number; disponivel: number; local: string | null; esgotado: boolean }[];
};

/** Compatibilidade com a resposta antiga: uma única `foto_url` vira 1 mídia. */
function midiasDoDetalhe(p: Detalhe['produto']): MidiaLoja[] {
  if (p.fotos?.length) return p.fotos;
  const url = p.imagem_principal || p.foto_url;
  return url ? [{ id: 0, url, thumb_url: p.foto_url || url, alt_text: p.nome, principal: true, variante_id: null }] : [];
}

export default function LojaProdutoPage() {
  const { slug } = useParams();
  const navigate = useNavigate();
  const configShell = useConfigDoShell();
  const [detalhe, setDetalhe] = useState<Detalhe | null>(null);
  const [erro, setErro] = useState('');
  const [carregando, setCarregando] = useState(true);
  const [tamanhoSel, setTamanhoSel] = useState<number | null | undefined>(undefined);
  const [qtd, setQtd] = useState(1);
  const [adicionado, setAdicionado] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    let vivo = true;
    setCarregando(true);
    setErro('');
    apiFetch<Detalhe>(`/loja/produtos/${encodeURIComponent(String(slug))}`, { signal: controller.signal })
      .then((r) => {
        if (!vivo) return;
        setDetalhe(r);
        setTamanhoSel(null);
      })
      .catch((e) => { if (vivo && !controller.signal.aborted) setErro(e instanceof ApiError ? e.message : 'Produto não encontrado.'); })
      .finally(() => { if (vivo && !controller.signal.aborted) setCarregando(false); });
    return () => { vivo = false; controller.abort(); };
  }, [slug]);

  if (carregando) {
    return (
      <LojaShell>
        <div className="grid gap-8 md:grid-cols-2" aria-busy="true" aria-live="polite">
          <div className="aspect-[4/5] animate-pulse rounded-2xl border border-line bg-surface" />
          <div className="space-y-4">
            <div className="h-8 w-2/3 animate-pulse rounded bg-surface" />
            <div className="h-5 w-1/3 animate-pulse rounded bg-surface" />
            <div className="h-32 animate-pulse rounded bg-surface" />
          </div>
        </div>
      </LojaShell>
    );
  }

  if (!detalhe) {
    return (
      <LojaShell>
        <div className="rounded-2xl border border-line bg-surface p-8 text-center">
          <h1 className="text-lg font-medium">Produto não encontrado</h1>
          <p className="mt-1 text-sm text-muted">{erro || 'Ele pode ter saído da vitrine.'}</p>
          <Link to="/loja" className="btn-secondary mt-4 inline-flex">
            <ArrowLeft className="h-4 w-4" aria-hidden="true" /> Voltar à loja
          </Link>
        </div>
      </LojaShell>
    );
  }

  const p = detalhe.produto;
  const comTamanho = detalhe.tamanhos.some((t) => t.tamanho_id != null);
  const tamanhoEscolhido = detalhe.tamanhos.find((t) => t.tamanho_id === (tamanhoSel ?? null)) ?? null;
  const disponivelDoSelecionado = comTamanho ? (tamanhoEscolhido?.disponivel ?? 0) : detalhe.tamanhos.reduce((s, t) => s + t.disponivel, 0);
  const precisaTamanho = comTamanho && (tamanhoSel === null || tamanhoSel === undefined);
  const podeAdicionar = Number.isFinite(p.preco) && p.preco > 0 && (!comTamanho || tamanhoSel != null) && disponivelDoSelecionado >= qtd && disponivelDoSelecionado > 0;
  const maxQtd = Math.max(1, Math.min(99, disponivelDoSelecionado));
  const midias = midiasDoDetalhe(p);
  const rotulo = rotuloDisponibilidade(disponivelDoSelecionado);
  const frete = configShell?.config?.frete;

  const adicionar = (irParaCheckout = false) => {
    if (!podeAdicionar) return;
    const ok = adicionarAoCarrinho({
      produto_id: p.id,
      tamanho_id: comTamanho ? (tamanhoSel as number | null) : null,
      quantidade: qtd,
      nome: p.nome,
      sku: p.sku,
      foto_url: p.foto_url,
    });
    if (!ok) return;
    if (irParaCheckout) { navigate('/loja/checkout'); return; }
    setAdicionado(true);
    window.setTimeout(() => setAdicionado(false), 2200);
  };

  return (
    <LojaShell tituloDocumento={p.nome}>
      <nav aria-label="Trilha de navegação" className="mb-5 flex flex-wrap items-center gap-1.5 text-xs text-muted">
        <Link to="/loja" className="hover:text-primary">Início</Link>
        <span aria-hidden="true">/</span>
        {p.categoria ? (
          <>
            <Link to={`/loja?categoria=${p.categoria.id}`} className="hover:text-primary">{p.categoria.nome}</Link>
            <span aria-hidden="true">/</span>
          </>
        ) : null}
        <span className="font-medium text-ink" aria-current="page">Detalhes do produto</span>
      </nav>

      <div className="grid gap-8 lg:grid-cols-2 lg:gap-12">
        <div className="lg:sticky lg:top-28 lg:self-start">
          <GaleriaProduto fotos={midias} galeriasPorVariante={p.galerias_por_variante} varianteId={tamanhoSel ?? null} nome={p.nome} />
        </div>

        <div className="space-y-6">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-[11px] uppercase tracking-wider text-muted">SKU {p.sku}</span>
              {p.destaque && <span className="rounded-full bg-navy-50 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-navy-700">Destaque</span>}
            </div>
            <h1 className="mt-2 text-3xl font-semibold leading-tight tracking-tight sm:text-4xl">{p.nome}</h1>
            {p.resumo && <p className="mt-2 text-sm leading-relaxed text-ink-soft sm:text-base">{p.resumo}</p>}
            <div className="mt-5 flex flex-wrap items-baseline gap-3">
              <span className="text-3xl font-semibold tabular-nums text-primary">{precoLoja(p.preco)}</span>
              {p.promocional && p.preco_original != null && (
                <span className="text-lg text-muted line-through tabular-nums">{precoLoja(p.preco_original)}</span>
              )}
            </div>
            <p className="mt-1 text-xs text-muted">Preço e disponibilidade confirmados pelo servidor.</p>
          </div>

          {/* VARIAÇÕES */}
          <fieldset>
            <legend className="text-sm font-semibold uppercase tracking-wider text-ink-soft">
              {comTamanho ? 'Escolha a variação' : 'Variação'}
            </legend>
            {comTamanho ? (
              <div className="mt-3 flex flex-wrap gap-2">
                {detalhe.tamanhos.map((t) => {
                  const selecionado = tamanhoSel === t.tamanho_id;
                  return (
                    <button key={`${t.tamanho_id}`} type="button" disabled={t.esgotado} aria-pressed={selecionado}
                      onClick={() => { setTamanhoSel(t.tamanho_id); setQtd(1); }}
                      className={`min-h-11 min-w-14 rounded-lg border px-4 text-sm font-semibold transition ${
                        t.esgotado ? 'cursor-not-allowed border-line bg-canvas text-muted line-through'
                          : selecionado ? 'border-navy-900 bg-navy-900 text-white'
                            : 'border-line bg-surface hover:border-primary'}`}
                      title={t.esgotado ? 'Esgotado' : `${t.disponivel} disponível(is)`}>
                      {t.codigo ?? `#${t.tamanho_id}`}
                    </button>
                  );
                })}
              </div>
            ) : (
              <div className="mt-3"><span className="inline-flex min-h-11 items-center rounded-lg border border-line bg-canvas px-4 text-sm">Tamanho único</span></div>
            )}
            {precisaTamanho && <p className="mt-2 text-xs text-muted" aria-live="polite">Selecione uma variação para continuar.</p>}
          </fieldset>

          {/* QUANTIDADE + DISPONIBILIDADE */}
          <div className="flex flex-wrap items-center gap-4">
            <div>
              <span className="mb-2 block text-sm font-semibold uppercase tracking-wider text-ink-soft">Quantidade</span>
              <div className="inline-flex h-11 items-center rounded-lg border border-line bg-surface">
                <button type="button" className="flex h-full w-11 items-center justify-center text-ink hover:text-primary disabled:text-muted" aria-label="Diminuir quantidade"
                  disabled={qtd <= 1} onClick={() => setQtd((v) => Math.max(1, v - 1))}>
                  <Minus className="h-4 w-4" aria-hidden="true" />
                </button>
                <input className="w-12 border-x border-line bg-transparent text-center text-sm font-semibold tabular-nums" type="number" min={1} max={maxQtd}
                  value={qtd} onChange={(e) => setQtd(normalizarQuantidade(e.target.value) ?? 1)} aria-label="Quantidade" />
                <button type="button" className="flex h-full w-11 items-center justify-center text-ink hover:text-primary disabled:text-muted" aria-label="Aumentar quantidade"
                  disabled={qtd >= maxQtd} onClick={() => setQtd((v) => Math.min(maxQtd, v + 1))}>
                  <Plus className="h-4 w-4" aria-hidden="true" />
                </button>
              </div>
            </div>
            {!precisaTamanho && rotulo && (
              <p className={`mt-6 text-sm ${disponivelDoSelecionado <= 0 ? 'font-medium text-danger' : disponivelDoSelecionado <= 5 ? 'font-medium text-amber-800' : 'text-muted'}`} aria-live="polite">
                {rotulo}
              </p>
            )}
          </div>

          {/* CTAs — passam SEMPRE pelo carrinho/checkout oficial */}
          <div className="flex flex-col gap-3 sm:flex-row">
            <button type="button" className="btn-accent min-h-12 flex-1 text-sm uppercase tracking-wider" disabled={!podeAdicionar} onClick={() => adicionar(false)}>
              {adicionado ? <><Check className="h-4 w-4" aria-hidden="true" /> Adicionado</> : <><ShoppingBag className="h-4 w-4" aria-hidden="true" /> Adicionar ao carrinho</>}
            </button>
            <button type="button" className="btn-secondary min-h-12 flex-1 text-sm uppercase tracking-wider" disabled={!podeAdicionar} onClick={() => adicionar(true)}>
              Comprar agora
            </button>
          </div>
          {adicionado && <Link to="/loja/carrinho" className="text-xs font-medium text-primary underline">Ver meu carrinho</Link>}

          {/* FRETE / RETIRADA — dado real da config pública, nunca inventado */}
          <div className="space-y-2 rounded-xl border border-line bg-surface p-4 text-sm">
            <div className="flex items-center gap-2 font-medium"><Truck className="h-4 w-4 text-accent" aria-hidden="true" /> Entrega</div>
            {frete?.disponivel ? (
              <p className="text-xs leading-relaxed text-muted">
                {frete.provedor === 'retirada'
                  ? 'Retirada na loja — sem entrega no endereço.'
                  : `Frete ${precoLoja(frete.valor)}${frete.gratis_acima != null ? ` · grátis acima de ${precoLoja(frete.gratis_acima)}` : ''}${frete.prazo_dias != null ? ` · prazo de ${frete.prazo_dias} dia(s)` : ''}.`}
              </p>
            ) : <p className="text-xs text-muted">{frete?.motivo ?? 'Frete não configurado — o checkout informará a disponibilidade.'}</p>}
            <p className="flex items-center gap-2 pt-1 text-xs text-muted"><ShieldCheck className="h-4 w-4" aria-hidden="true" /> Pagamento confirmado apenas pelo processador.</p>
          </div>

          {/* INFORMAÇÕES REAIS */}
          {p.descricao && (
            <section className="border-t border-line pt-5" aria-labelledby="descricao">
              <h2 id="descricao" className="text-xs font-semibold uppercase tracking-[0.18em] text-muted">Descrição</h2>
              <p className="mt-3 whitespace-pre-line text-sm leading-relaxed text-ink-soft">{p.descricao}</p>
            </section>
          )}
          {(p.composicao || p.categoria) && (
            <section className="border-t border-line pt-5" aria-labelledby="detalhes">
              <h2 id="detalhes" className="text-xs font-semibold uppercase tracking-[0.18em] text-muted">Detalhes do produto</h2>
              <dl className="mt-3 grid grid-cols-2 gap-3 text-sm">
                <div><dt className="text-xs text-muted">Referência</dt><dd className="font-medium">{p.sku}</dd></div>
                {p.categoria && <div><dt className="text-xs text-muted">Categoria</dt><dd className="font-medium">{p.categoria.nome}</dd></div>}
                {p.composicao && <div className="col-span-2"><dt className="text-xs text-muted">Composição</dt><dd className="font-medium">{p.composicao}</dd></div>}
              </dl>
            </section>
          )}
        </div>
      </div>

      {/* RELACIONADOS — mesma categoria, dados reais */}
      {!!detalhe.relacionados?.length && (
        <section className="mt-14 space-y-4" aria-labelledby="relacionados">
          <div className="border-b border-line pb-3">
            <h2 id="relacionados" className="text-lg font-semibold uppercase tracking-[0.12em] sm:text-xl">Você também pode gostar</h2>
            <p className="mt-1 text-xs text-muted">Outras peças da mesma categoria, publicadas na loja.</p>
          </div>
          <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-4 lg:grid-cols-4">
            {detalhe.relacionados.map((r) => <li key={r.id}><CardProduto produto={r} /></li>)}
          </ul>
        </section>
      )}
    </LojaShell>
  );
}
