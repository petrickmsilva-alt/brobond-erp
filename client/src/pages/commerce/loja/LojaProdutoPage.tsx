// ============================================================================
// VITRINE — DETALHE DO PRODUTO. Rota /loja/produto/:slug.
// Preço, estoque por tamanho e publicação PUBLISHED conferidos no servidor
// (404 idêntico ao produto inexistente — nunca revela produto de outro tenant).
// ============================================================================
import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Check, ShoppingBag } from 'lucide-react';
import { apiFetch, ApiError } from '../../../lib/api';
import { LojaShell, precoLoja } from './LojaShell';
import { adicionarAoCarrinho } from './carinho';

type Detalhe = {
  empresa_id: number;
  produto: {
    id: number;
    sku: string;
    slug: string;
    nome: string;
    resumo: string | null;
    descricao: string;
    destaque: boolean;
    preco: number;
    preco_original: number | null;
    promocional: boolean;
    foto_url: string | null;
    fotos: unknown[];
  };
  tamanhos: { tamanho_id: number | null; codigo: string | null; fisico: number; disponivel: number; local: string | null; esgotado: boolean }[];
};

export default function LojaProdutoPage() {
  const { slug } = useParams();
  const navigate = useNavigate();
  const [detalhe, setDetalhe] = useState<Detalhe | null>(null);
  const [erro, setErro] = useState('');
  const [carregando, setCarregando] = useState(true);
  const [tamanhoSel, setTamanhoSel] = useState<number | null | undefined>(undefined);
  const [qtd, setQtd] = useState(1);
  const [adicionado, setAdicionado] = useState(false);

  useEffect(() => {
    let vivo = true;
    setCarregando(true);
    setErro('');
    apiFetch<Detalhe>(`/loja/produtos/${encodeURIComponent(String(slug))}`)
      .then((r) => {
        if (!vivo) return;
        setDetalhe(r);
        const comTamanho = r.tamanhos.some((t) => t.tamanho_id != null);
        setTamanhoSel(comTamanho ? null : null);
      })
      .catch((e) => {
        if (vivo) setErro(e instanceof ApiError ? e.message : 'Produto não encontrado.');
      })
      .finally(() => {
        if (vivo) setCarregando(false);
      });
    return () => {
      vivo = false;
    };
  }, [slug]);

  if (carregando) {
    return (
      <LojaShell>
        <div className="grid gap-6 md:grid-cols-2" aria-busy="true">
          <div className="h-80 animate-pulse rounded-2xl bg-surface" />
          <div className="space-y-3">
            <div className="h-8 w-2/3 animate-pulse rounded bg-surface" />
            <div className="h-4 w-1/3 animate-pulse rounded bg-surface" />
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
          <button type="button" className="btn-secondary mt-4" onClick={() => navigate('/loja')}>
            <ArrowLeft className="h-4 w-4" aria-hidden="true" /> Voltar à loja
          </button>
        </div>
      </LojaShell>
    );
  }

  const comTamanho = detalhe.tamanhos.some((t) => t.tamanho_id != null);
  const tamanhoEscolhido = detalhe.tamanhos.find((t) => t.tamanho_id === (tamanhoSel ?? null)) ?? null;
  const disponivelDoSelecionado = comTamanho ? (tamanhoEscolhido?.disponivel ?? 0) : detalhe.tamanhos.reduce((s, t) => s + t.disponivel, 0);
  const podeAdicionar = (!comTamanho || (tamanhoSel != null && tamanhoSel !== null)) && disponivelDoSelecionado >= qtd && disponivelDoSelecionado > 0;
  const precisaTamanho = comTamanho && (tamanhoSel === null || tamanhoSel === undefined);

  const adicionar = () => {
    if (!podeAdicionar) return;
    adicionarAoCarrinho({ produto_id: detalhe.produto.id, tamanho_id: comTamanho ? (tamanhoSel as number | null) : null, quantidade: qtd });
    setAdicionado(true);
    window.setTimeout(() => setAdicionado(false), 2200);
  };

  const fotoPrincipal = detalhe.produto.foto_url;

  return (
    <LojaShell>
      <button type="button" className="btn-ghost mb-4 -ml-2" onClick={() => navigate('/loja')}>
        <ArrowLeft className="h-4 w-4" aria-hidden="true" /> Voltar
      </button>

      <div className="grid gap-8 md:grid-cols-2">
        <div className="flex h-72 items-center justify-center overflow-hidden rounded-2xl border border-line bg-surface md:h-96">
          {fotoPrincipal ? (
            <img src={fotoPrincipal} alt={detalhe.produto.nome} className="h-full w-full object-cover" />
          ) : (
            <span className="text-7xl text-line" aria-hidden="true">👕</span>
          )}
        </div>

        <div className="space-y-5">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-xs text-muted">SKU {detalhe.produto.sku}</span>
              {detalhe.produto.destaque && <span className="rounded-full bg-accent/10 px-2 py-0.5 text-[10px] font-bold uppercase text-accent">Destaque</span>}
            </div>
            <h1 className="mt-1 text-3xl font-semibold tracking-tight">{detalhe.produto.nome}</h1>
            {detalhe.produto.resumo && <p className="mt-2 text-ink-soft">{detalhe.produto.resumo}</p>}
            <div className="mt-4 flex items-baseline gap-3">
              <span className="text-3xl font-semibold tabular-nums text-primary">{precoLoja(detalhe.produto.preco)}</span>
              {detalhe.produto.promocional && detalhe.produto.preco_original != null && (
                <span className="text-lg text-muted line-through tabular-nums">{precoLoja(detalhe.produto.preco_original)}</span>
              )}
            </div>
          </div>

          <fieldset>
            <legend className="text-sm font-medium text-ink-soft">{comTamanho ? 'Escolha o tamanho' : 'Quantidade'}</legend>
            {comTamanho ? (
              <div className="mt-2 flex flex-wrap gap-2">
                {detalhe.tamanhos.map((t) => {
                  const selecionado = tamanhoSel === t.tamanho_id;
                  return (
                    <button
                      key={`${t.tamanho_id}`}
                      type="button"
                      disabled={t.esgotado}
                      aria-pressed={selecionado}
                      onClick={() => setTamanhoSel(t.tamanho_id)}
                      className={`min-w-14 rounded-lg border px-3 py-2 text-sm font-medium transition ${
                        t.esgotado
                          ? 'cursor-not-allowed border-line bg-canvas text-muted line-through'
                          : selecionado
                            ? 'border-primary bg-primary text-white'
                            : 'border-line bg-surface hover:border-primary'
                      }`}
                      title={t.esgotado ? 'Esgotado' : `${t.disponivel} disponível(is)`}
                    >
                      {t.codigo ?? `#${t.tamanho_id}`}
                    </button>
                  );
                })}
              </div>
            ) : (
              <div className="mt-2 flex flex-wrap gap-2">
                <span className="rounded-lg border border-line bg-canvas px-3 py-2 text-sm">Único</span>
              </div>
            )}
            <p className="mt-2 text-xs text-muted" aria-live="polite">
              {precisaTamanho
                ? 'Selecione um tamanho para continuar.'
                : disponivelDoSelecionado > 0
                  ? `${disponivelDoSelecionado} peça(s) disponível(is) agora (estoque em tempo real).`
                  : 'Sem disponibilidade no momento.'}
            </p>
          </fieldset>

          <div className="flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-2 text-sm">
              <span className="text-ink-soft">Qtd.</span>
              <input
                className="input w-20"
                type="number"
                min={1}
                max={Math.max(1, Math.min(99, disponivelDoSelecionado))}
                value={qtd}
                onChange={(e) => setQtd(Math.max(1, Math.trunc(Number(e.target.value) || 1)))}
                aria-label="Quantidade"
              />
            </label>
            <button type="button" className="btn-accent" disabled={!podeAdicionar} onClick={adicionar}>
              {adicionado ? (
                <>
                  <Check className="h-4 w-4" aria-hidden="true" /> Adicionado
                </>
              ) : (
                <>
                  <ShoppingBag className="h-4 w-4" aria-hidden="true" /> Adicionar ao carrinho
                </>
              )}
            </button>
            <button type="button" className="btn-secondary" onClick={() => navigate('/loja/carrinho')} disabled={!podeAdicionar}>
              Ir para o carrinho
            </button>
          </div>

          {detalhe.produto.descricao && (
            <section className="border-t border-line pt-4" aria-labelledby="descricao">
              <h2 id="descricao" className="text-sm font-semibold uppercase tracking-wide text-muted">Descrição</h2>
              <p className="mt-2 whitespace-pre-line text-sm leading-relaxed text-ink-soft">{detalhe.produto.descricao}</p>
            </section>
          )}
        </div>
      </div>
    </LojaShell>
  );
}
