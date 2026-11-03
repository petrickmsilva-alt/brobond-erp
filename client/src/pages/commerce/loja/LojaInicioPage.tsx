// ============================================================================
// BROBOND STORE — HOME / VITRINE. Rota /loja.
//
// Seções SOMENTE com fonte real do servidor:
//   • Categorias reais do ERP (produtos publicados no canal BROBOND);
//   • Destaques (`produto.destaque`), Novidades (`criado_em`) e Ofertas
//     (preço promocional vigente calculado no servidor).
// Se uma seção não tem dados, ela é OCULTADA — nunca se inventa avaliação,
// quantidade de vendas, desconto, cliente, depoimento ou "mais vendidos".
//
// Performance: UM request de catálogo (com `secoes=1`) + UM de config (no
// shell). AbortController cancela a requisição anterior ao trocar filtro;
// imagens lazy com dimensões explícitas; nothing carrega a galeria inteira.
// ============================================================================
import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { PackageCheck, PackageSearch, ShieldCheck, Sparkles, Truck, X } from 'lucide-react';
import { apiFetch, ApiError } from '../../../lib/api';
import { LojaShell, precoLoja } from './LojaShell';
import CardProduto, { EsqueletoCard, type CardProdutoDados } from './CardProduto';
import HeroCarrossel from './HeroCarrossel';

type Categoria = { id: number; nome: string; slug: string; total: number };
type Secoes = { destaques: CardProdutoDados[]; novidades: CardProdutoDados[]; ofertas: CardProdutoDados[] };
type RespostaCatalogo = { total: number; total_colecao?: number; produtos: CardProdutoDados[]; categorias?: Categoria[]; secoes?: Secoes };

const ORDENACOES = [
  { valor: '', rotulo: 'Ordem padrão' },
  { valor: 'novidades', rotulo: 'Novidades' },
  { valor: 'preco-asc', rotulo: 'Menor preço' },
  { valor: 'preco-desc', rotulo: 'Maior preço' },
  { valor: 'destaque', rotulo: 'Destaques' },
];

function Secao({ id, titulo, subtitulo, produtos }: { id?: string; titulo: string; subtitulo?: string; produtos: CardProdutoDados[] }) {
  if (!produtos?.length) return null;
  return (
    <section id={id} className="scroll-mt-28 space-y-4" aria-labelledby={`secao-${id ?? titulo}`}>
      <div className="flex flex-wrap items-end justify-between gap-2 border-b border-line pb-3">
        <div>
          <h2 id={`secao-${id ?? titulo}`} className="text-lg font-semibold uppercase tracking-[0.12em] sm:text-xl">{titulo}</h2>
          {subtitulo && <p className="mt-1 text-xs text-muted sm:text-sm">{subtitulo}</p>}
        </div>
        <span className="text-[11px] uppercase tracking-wider text-muted">{produtos.length} {produtos.length === 1 ? 'peça' : 'peças'}</span>
      </div>
      <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-4 lg:grid-cols-4">
        {produtos.map((p, i) => <li key={`${p.id}-${i}`}><CardProduto produto={p} prioritario={i < 2} /></li>)}
      </ul>
    </section>
  );
}

/**
 * Deduplica as seções editoriais por `product_id`: um mesmo produto que é
 * destaque, oferta e novidade aparece UMA vez, na seção de maior prioridade
 * (ordem da lista: Destaques → Ofertas → Novidades). Não usa SKU como chave
 * para não esconder produto legítimo com código repetido.
 */
export function semRepeticaoEntreSecoes(listas: CardProdutoDados[][]): CardProdutoDados[][] {
  const vistos = new Set<number>();
  return listas.map((lista) => lista.filter((p) => {
    if (vistos.has(p.id)) return false;
    vistos.add(p.id);
    return true;
  }));
}

export default function LojaInicioPage() {
  const [params, setParams] = useSearchParams();
  const q = params.get('q') ?? '';
  const categoria = params.get('categoria') ?? '';
  const ordenar = params.get('ordenar') ?? '';
  const pagina = Math.max(1, Number(params.get('page')) || 1);
  const [resposta, setResposta] = useState<RespostaCatalogo | null>(null);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState('');

  useEffect(() => {
    const controller = new AbortController();
    let vivo = true;
    setCarregando(true);
    setErro('');
    const busca = new URLSearchParams({ page: String(pagina), pageSize: '48', secoes: '1' });
    if (q) busca.set('q', q);
    if (categoria) busca.set('categoria', categoria);
    if (ordenar) busca.set('ordenar', ordenar);
    apiFetch<RespostaCatalogo>(`/loja/produtos?${busca.toString()}`, { signal: controller.signal })
      .then((r) => { if (vivo) setResposta(r); })
      .catch((e) => { if (vivo && !controller.signal.aborted) setErro(e instanceof ApiError ? e.message : 'Não foi possível carregar a loja.'); })
      .finally(() => { if (vivo && !controller.signal.aborted) setCarregando(false); });
    return () => { vivo = false; controller.abort(); };
  }, [q, categoria, ordenar, pagina]);

  const atualizar = (chave: string, valor: string) => {
    const proximos = new URLSearchParams(params);
    if (valor) proximos.set(chave, valor); else proximos.delete(chave);
    if (chave !== 'page') proximos.delete('page');
    setParams(proximos);
  };

  const produtos = resposta?.produtos ?? [];
  const categorias = resposta?.categorias ?? [];
  const secoes = resposta?.secoes;
  const temFiltro = !!(q || categoria || ordenar);
  const temProdutoNasSecoes = !!(secoes && Object.values(secoes).some((lista) => lista.length > 0));
  const totalColecao = resposta?.total_colecao ?? resposta?.total ?? 0;
  const [destaquesUnicos, ofertasUnicas, novidadesUnicas] = semRepeticaoEntreSecoes([secoes?.destaques ?? [], secoes?.ofertas ?? [], secoes?.novidades ?? []]);

  return (
    <LojaShell>
      <div className="space-y-12">
        {/* HERO — carrossel com imagens REAIS da marca (HeroCarrossel). */}
        <HeroCarrossel />

        {/* CATEGORIAS REAIS */}
        {categorias.length > 0 && (
          <section id="categorias" className="scroll-mt-28 space-y-4" aria-labelledby="titulo-categorias">
            <h2 id="titulo-categorias" className="text-lg font-semibold uppercase tracking-[0.12em] sm:text-xl">Categorias</h2>
            <ul className="flex flex-wrap gap-2">
              <li>
                <button type="button" onClick={() => atualizar('categoria', '')}
                  className={`rounded-full border px-4 py-2 text-xs font-medium transition ${!categoria ? 'border-navy-900 bg-navy-900 text-white' : 'border-line bg-surface hover:border-primary'}`}>
                  Todas
                </button>
              </li>
              {categorias.map((c) => (
                <li key={c.id}>
                  <button type="button" onClick={() => atualizar('categoria', String(c.id))} aria-pressed={categoria === String(c.id)}
                    className={`rounded-full border px-4 py-2 text-xs font-medium transition ${categoria === String(c.id) ? 'border-navy-900 bg-navy-900 text-white' : 'border-line bg-surface hover:border-primary'}`}>
                    {c.nome} <span className="ml-1 opacity-60">{c.total}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}

        {/* DESTAQUES / OFERTAS / NOVIDADES — só com dados reais */}
        {!temFiltro && (
          <div className="space-y-12">
            <Secao titulo="Destaques" subtitulo="Peças marcadas como destaque no catálogo." produtos={destaquesUnicos} />
            <Secao titulo="Ofertas" subtitulo="Preço promocional vigente, calculado pelo servidor." produtos={ofertasUnicas} />
            <Secao id="novidades" titulo="Novidades" subtitulo="Cadastros mais recentes publicados na loja." produtos={novidadesUnicas} />
          </div>
        )}

        {/* COLEÇÃO COMPLETA */}
        <section id="colecao" className="scroll-mt-28 space-y-4" aria-labelledby="titulo-colecao">
          <div className="flex flex-wrap items-end justify-between gap-3 border-b border-line pb-3">
            <div>
              <h2 id="titulo-colecao" className="text-lg font-semibold uppercase tracking-[0.12em] sm:text-xl">Nossa coleção</h2>
              <p className="mt-1 text-xs text-muted sm:text-sm">
                {carregando ? 'Carregando…' : `${resposta?.total ?? 0} ${(resposta?.total ?? 0) === 1 ? 'produto publicado' : 'produtos publicados'}`}
                {q && <> · busca por “{q}”</>}
              </p>
            </div>
            <label className="flex items-center gap-2 text-xs text-muted">
              Ordenar
              <select className="input h-9 w-auto min-w-36 text-xs" value={ordenar} onChange={(e) => atualizar('ordenar', e.target.value)} aria-label="Ordenar produtos">
                {ORDENACOES.map((o) => <option key={o.valor} value={o.valor}>{o.rotulo}</option>)}
              </select>
            </label>
          </div>

          {temFiltro && (
            <div className="flex flex-wrap items-center gap-2">
              {q && <span className="inline-flex items-center gap-2 rounded-full bg-navy-50 px-3 py-1.5 text-xs text-navy-700">Busca: {q}
                <button type="button" aria-label="Limpar busca" onClick={() => atualizar('q', '')}><X className="h-3.5 w-3.5" aria-hidden="true" /></button>
              </span>}
              {categoria && <span className="inline-flex items-center gap-2 rounded-full bg-navy-50 px-3 py-1.5 text-xs text-navy-700">Categoria: {categorias.find((c) => String(c.id) === categoria)?.nome ?? categoria}
                <button type="button" aria-label="Limpar categoria" onClick={() => atualizar('categoria', '')}><X className="h-3.5 w-3.5" aria-hidden="true" /></button>
              </span>}
              <Link to="/loja" className="text-xs text-primary underline">Limpar filtros</Link>
            </div>
          )}

          {erro && (
            <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700" role="alert">{erro}</div>
          )}

          {carregando && !erro ? (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-4 lg:grid-cols-4" aria-busy="true" aria-live="polite">
              {[0, 1, 2, 3].map((i) => <EsqueletoCard key={i} />)}
              <span className="sr-only">Carregando produtos…</span>
            </div>
          ) : erro ? null : produtos.length === 0 && !temProdutoNasSecoes ? (
            <div className="flex flex-col items-center gap-3 rounded-2xl border border-dashed border-line bg-surface p-10 text-center">
              <PackageSearch className="h-8 w-8 text-muted" aria-hidden="true" />
              <h3 className="font-medium">{temFiltro ? 'Nada encontrado' : 'Nenhum produto disponível na loja.'}</h3>
              <p className="max-w-md text-sm text-muted">
                {temFiltro
                  ? 'Tente outro termo, outra categoria ou limpe os filtros.'
                  : 'A equipe pode publicar um produto existente em Commerce → Produtos → Publicar no canal BROBOND. A disponibilidade depende do estoque real.'}
              </p>
            </div>
          ) : (
            <>
              <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-4 lg:grid-cols-4">
                {produtos.map((p, i) => <li key={p.id}><CardProduto produto={p} prioritario={i < 2} /></li>)}
              </ul>
              {totalColecao > 48 && (
                <nav aria-label="Paginação da vitrine" className="flex items-center justify-center gap-3 pt-2">
                  <button type="button" className="btn-secondary" disabled={pagina <= 1} onClick={() => atualizar('page', String(pagina - 1))}>Anterior</button>
                <span className="text-xs tabular-nums text-muted">Página {pagina} de {Math.ceil(totalColecao / 48)}</span>
                <button type="button" className="btn-secondary" disabled={pagina * 48 >= totalColecao} onClick={() => atualizar('page', String(pagina + 1))}>Próxima</button>
                </nav>
              )}
            </>
          )}
        </section>

        {/* BENEFÍCIOS — conteúdo estático legítimo, sem números/promessas falsas. */}
        <section aria-label="Sobre a compra" className="grid gap-4 rounded-2xl border border-line bg-surface p-6 sm:grid-cols-2 lg:grid-cols-4">
          {[
            { icon: Sparkles, titulo: 'Catálogo real', texto: 'Somente produtos publicados e ativos aparecem na vitrine.' },
            { icon: ShieldCheck, titulo: 'Pagamento seguro', texto: 'A confirmação vem do processador, nunca do navegador.' },
            { icon: Truck, titulo: 'Entrega ou retirada', texto: 'O frete exibido é o configurado pela loja no momento da compra.' },
            { icon: PackageCheck, titulo: 'Pedido acompanhado', texto: 'Cada pedido tem um link próprio com status e rastreio.' },
          ].map((b) => (
            <div key={b.titulo} className="flex gap-3">
              <b.icon className="mt-0.5 h-5 w-5 shrink-0 text-accent" aria-hidden="true" />
              <div>
                <h3 className="text-sm font-semibold">{b.titulo}</h3>
                <p className="mt-1 text-xs leading-relaxed text-muted">{b.texto}</p>
              </div>
            </div>
          ))}
        </section>
      </div>
    </LojaShell>
  );
}

/** Reexportado para as seções que exibem o frete real da config (evita import circular). */
export { precoLoja };
