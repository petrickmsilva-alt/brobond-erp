// ============================================================================
// BROBOND STORE — GALERIA PROFISSIONAL (sem modal/dialog/drawer/overlay).
//
// Desktop: foto principal grande, miniaturas, navegação, contador e ZOOM
// INLINE (painel no fluxo do documento, nunca sobreposição) com origem seguindo
// o ponteiro. Mobile: carrossel horizontal com scroll-snap/swipe e indicador.
//
// Regra de mídia: variante COM fotos próprias → usa só as dela; sem fotos
// próprias → fallback para as fotos do produto. Produto sem imagem → placeholder
// honesto (nunca imagem falsa). Nenhuma imagem em resolução cheia é carregada
// para as miniaturas; fora do primeiro viewport tudo é lazy.
// ============================================================================
import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, ZoomIn, ZoomOut } from 'lucide-react';

export type MidiaLoja = {
  id: number;
  url: string;
  thumb_url: string;
  alt_text: string;
  principal: boolean;
  variante_id: number | null;
};

// React 18 ainda não reconhece `fetchPriority` camelCase; espalhamos o
// atributo lowercase equivalente (HTML padrão) sem gerar aviso no console.
const PRIORIDADE_ALTA = { fetchpriority: 'high' } as Record<string, string>;

type Props = {
  fotos: MidiaLoja[];
  galeriasPorVariante?: Record<string, MidiaLoja[]>;
  varianteId?: number | null;
  nome: string;
};

export function galeriaDaVariante(
  fotos: MidiaLoja[],
  galeriasPorVariante: Record<string, MidiaLoja[]> | undefined,
  varianteId: number | null | undefined
): MidiaLoja[] {
  if (varianteId == null) return fotos;
  const especificas = galeriasPorVariante?.[String(varianteId)];
  return especificas && especificas.length ? especificas : fotos;
}

export default function GaleriaProduto({ fotos, galeriasPorVariante, varianteId, nome }: Props) {
  const lista = useMemo(() => galeriaDaVariante(fotos, galeriasPorVariante, varianteId), [fotos, galeriasPorVariante, varianteId]);
  const [indice, setIndice] = useState(0);
  const [zoom, setZoom] = useState(false);
  const [origem, setOrigem] = useState({ x: 50, y: 50 });
  const trilha = useRef<HTMLDivElement | null>(null);

  // Troca de variante pode reduzir a galeria: mantém o índice válido.
  useEffect(() => { setIndice(0); setZoom(false); }, [varianteId]);
  useEffect(() => { if (indice >= lista.length) setIndice(0); }, [indice, lista.length]);

  const ir = (delta: number) => {
    if (!lista.length) return;
    setIndice((atual) => (atual + delta + lista.length) % lista.length);
  };

  const selecionar = (i: number) => {
    setIndice(i);
    trilha.current?.children[i]?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
  };

  const onScroll = () => {
    const el = trilha.current;
    if (!el || !lista.length) return;
    const i = Math.round(el.scrollLeft / Math.max(1, el.clientWidth));
    if (i !== indice && i >= 0 && i < lista.length) setIndice(i);
  };

  const moverLente = (e: React.MouseEvent<HTMLElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    setOrigem({
      x: Math.min(100, Math.max(0, ((e.clientX - r.left) / r.width) * 100)),
      y: Math.min(100, Math.max(0, ((e.clientY - r.top) / r.height) * 100)),
    });
  };

  if (!lista.length) {
    return (
      <div className="flex aspect-[4/5] items-center justify-center rounded-2xl border border-line bg-surface" role="img" aria-label={`${nome} sem foto cadastrada`}>
        <div className="text-center">
          <span className="text-7xl text-line" aria-hidden="true">👕</span>
          <p className="mt-3 text-xs text-muted">Foto ainda não cadastrada</p>
        </div>
      </div>
    );
  }

  const atual = lista[indice];

  return (
    <section aria-label={`Galeria de imagens de ${nome}`} className="space-y-3">
      {/* ---------- Foto principal (desktop) ---------- */}
      <div className="relative hidden aspect-[4/5] overflow-hidden rounded-2xl border border-line bg-surface md:block">
        <img
          key={atual.id}
          src={atual.url}
          alt={atual.alt_text || nome}
          width={800}
          height={1000}
          loading="eager"
          decoding="async"
          {...PRIORIDADE_ALTA}
          className="h-full w-full object-contain"
          style={zoom ? { transform: 'scale(2.1)', transformOrigin: `${origem.x}% ${origem.y}%`, transition: 'transform-origin 80ms linear' } : undefined}
          onMouseMove={zoom ? moverLente : undefined}
        />
        {lista.length > 1 && (
          <>
            <button type="button" onClick={() => ir(-1)} aria-label="Imagem anterior" className="absolute left-3 top-1/2 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full border border-line bg-surface/90 text-ink hover:border-primary">
              <ChevronLeft className="h-5 w-5" aria-hidden="true" />
            </button>
            <button type="button" onClick={() => ir(1)} aria-label="Próxima imagem" className="absolute right-3 top-1/2 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full border border-line bg-surface/90 text-ink hover:border-primary">
              <ChevronRight className="h-5 w-5" aria-hidden="true" />
            </button>
            <span className="absolute bottom-3 left-3 rounded-full bg-navy-900/80 px-3 py-1 text-[11px] font-medium tabular-nums text-white">
              {indice + 1} / {lista.length}
            </span>
          </>
        )}
        <button
          type="button"
          onClick={() => setZoom((z) => !z)}
          onMouseMove={moverLente}
          aria-pressed={zoom}
          className="absolute bottom-3 right-3 flex h-10 items-center gap-2 rounded-full border border-line bg-surface/95 px-3 text-xs font-semibold text-ink hover:border-primary"
        >
          {zoom ? <ZoomOut className="h-4 w-4" aria-hidden="true" /> : <ZoomIn className="h-4 w-4" aria-hidden="true" />}
          {zoom ? 'Reduzir' : 'Ampliar'}
        </button>
      </div>

      {/* ---------- Carrossel touch (mobile) ---------- */}
      <div className="md:hidden">
        <div
          ref={trilha}
          onScroll={onScroll}
          className="flex aspect-[4/5] snap-x snap-mandatory overflow-x-auto overscroll-x-contain rounded-2xl border border-line bg-surface [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          aria-label={`Fotos de ${nome} — deslize para navegar`}
        >
          {lista.map((f, i) => (
            <div key={f.id} className="flex h-full w-full shrink-0 snap-center items-center justify-center">
              <img
                src={f.url}
                alt={f.alt_text || nome}
                width={800}
                height={1000}
                loading={i === 0 ? 'eager' : 'lazy'}
                decoding="async"
                className="h-full w-full object-contain"
              />
            </div>
          ))}
        </div>
        {lista.length > 1 && (
          <div className="mt-2 flex items-center justify-center gap-3">
            <button type="button" onClick={() => { ir(-1); trilha.current?.scrollTo({ left: (indice - 1 + lista.length) % lista.length * (trilha.current?.clientWidth ?? 0), behavior: 'smooth' }); }} aria-label="Imagem anterior" className="flex h-9 w-9 items-center justify-center rounded-full border border-line bg-surface">
              <ChevronLeft className="h-4 w-4" aria-hidden="true" />
            </button>
            <span className="text-xs tabular-nums text-muted" aria-live="polite">{indice + 1} / {lista.length}</span>
            <button type="button" onClick={() => { ir(1); trilha.current?.scrollTo({ left: (indice + 1) % lista.length * (trilha.current?.clientWidth ?? 0), behavior: 'smooth' }); }} aria-label="Próxima imagem" className="flex h-9 w-9 items-center justify-center rounded-full border border-line bg-surface">
              <ChevronRight className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>
        )}
      </div>

      {/* ---------- Miniaturas ---------- */}
      {lista.length > 1 && (
        <div className="flex gap-2 overflow-x-auto pb-1" role="group" aria-label="Miniaturas das fotos">
          {lista.map((f, i) => (
            <button
              key={f.id}
              type="button"
              onClick={() => selecionar(i)}
              aria-label={`Ver foto ${i + 1} de ${lista.length}: ${f.alt_text || nome}`}
              aria-pressed={i === indice}
              className={`h-16 w-16 shrink-0 overflow-hidden rounded-lg border-2 bg-canvas transition sm:h-20 sm:w-20 ${i === indice ? 'border-primary' : 'border-line hover:border-primary/60'}`}
            >
              <img src={f.thumb_url} alt="" width={80} height={80} loading="lazy" decoding="async" className="h-full w-full object-cover" />
            </button>
          ))}
        </div>
      )}
      {zoom && (
        <p className="text-xs text-muted" aria-live="polite">Zoom inline ativo — mova o ponteiro sobre a imagem para explorar os detalhes. Clique em “Reduzir” para voltar.</p>
      )}
    </section>
  );
}
