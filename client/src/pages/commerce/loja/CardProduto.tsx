// ============================================================================
// BROBOND STORE — card de produto (vitrine, seções e relacionados).
// Todos os dados vêm do SERVIDOR: preço, preço promocional real, destaque,
// miniatura. Nenhum selo, desconto, avaliação ou disponidade é inventado.
// Imagem: miniatura (240 px) com dimensões explícitas, lazy loading fora do
// primeiro viewport e decoding assíncrono — evita CLS e bloqueio de render.
// ============================================================================
import { Link } from 'react-router-dom';
import { precoLoja } from './LojaShell';

export type CardProdutoDados = {
  id: number;
  sku?: string;
  slug: string;
  nome: string;
  resumo?: string | null;
  destaque?: boolean;
  preco: number;
  preco_original?: number | null;
  promocional?: boolean;
  foto_url?: string | null;
  disponivel?: number | null;
};

export function rotuloDisponibilidade(disponivel: number | null | undefined): string | null {
  if (disponivel == null || !Number.isFinite(disponivel)) return null;
  if (disponivel <= 0) return 'Sem disponibilidade no momento';
  if (disponivel === 1) return 'Última unidade disponível';
  if (disponivel <= 5) return `Últimas ${disponivel} unidades disponíveis`;
  return `${disponivel} unidades disponíveis`;
}

export default function CardProduto({ produto, prioritario = false }: { produto: CardProdutoDados; prioritario?: boolean }) {
  const href = `/loja/produto/${produto.slug}`;
  const rotulo = rotuloDisponibilidade(produto.disponivel);
  return (
    <article className="group flex h-full flex-col overflow-hidden rounded-2xl border border-line bg-surface transition duration-200 hover:border-primary/50 hover:shadow-md">
      <Link to={href} className="relative block aspect-[4/5] overflow-hidden bg-canvas" aria-label="Ver detalhes do produto" tabIndex={-1}>
        {produto.foto_url ? (
          <img
            src={produto.foto_url}
            alt={produto.nome}
            width={320}
            height={400}
            loading={prioritario ? 'eager' : 'lazy'}
            {...(prioritario ? ({ fetchpriority: 'high' } as Record<string, string>) : {})}
            decoding="async"
            className="h-full w-full object-cover transition duration-500 group-hover:scale-[1.04]"
          />
        ) : (
          <span className="flex h-full w-full items-center justify-center text-5xl text-line" aria-hidden="true">👕</span>
        )}
        {produto.promocional && produto.preco_original != null && (
          <span className="absolute left-3 top-3 rounded-full bg-accent px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider text-white">Oferta</span>
        )}
      </Link>
      <div className="flex flex-1 flex-col gap-1.5 p-4">
        <div className="flex items-start justify-between gap-2">
          <h3 className="text-sm font-semibold leading-snug tracking-tight">
            <Link to={href} className="hover:text-primary hover:underline">{produto.nome}</Link>
          </h3>
          {produto.destaque && <span className="shrink-0 rounded-full bg-navy-50 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-navy-700">Destaque</span>}
        </div>
        {produto.resumo && <p className="line-clamp-2 text-xs leading-relaxed text-muted">{produto.resumo}</p>}
        <div className="mt-auto flex flex-wrap items-baseline gap-2 pt-3">
          <span className="text-lg font-semibold tabular-nums text-primary">{precoLoja(produto.preco)}</span>
          {produto.promocional && produto.preco_original != null && (
            <span className="text-sm text-muted line-through tabular-nums">{precoLoja(produto.preco_original)}</span>
          )}
        </div>
        {rotulo && (
          <p className={`text-[11px] ${produto.disponivel! <= 0 ? 'text-danger' : produto.disponivel! <= 5 ? 'text-amber-800' : 'text-muted'}`}>{rotulo}</p>
        )}
        <Link
          to={href}
          className="mt-3 inline-flex min-h-11 items-center justify-center rounded-lg border border-navy-900 px-4 text-xs font-semibold uppercase tracking-wider text-navy-900 transition hover:bg-navy-900 hover:text-white"
        >
          Ver produto
        </Link>
      </div>
    </article>
  );
}

export function EsqueletoCard() {
  return <div className="h-80 animate-pulse rounded-2xl border border-line bg-surface" aria-hidden="true" />;
}
