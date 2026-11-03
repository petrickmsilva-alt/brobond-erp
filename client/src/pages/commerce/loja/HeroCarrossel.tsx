// ============================================================================
// BROBOND STORE — CARROSSEL DO HERO (homepage /loja).
//
// Slides com imagens REAIS da marca (pasta client/public/brand/hero, ver
// manifest.json). Sem imagens com marca d'água de terceiros.
//
// • 5 slides, logo, headline, CTA, overlay para leitura;
// • object-cover com object-position próprio por slide (desktop e mobile);
// • setas, dots, autoplay (pausa em hover e foco), swipe no mobile, teclado;
// • prefers-reduced-motion: sem autoplay;
// • 1º slide: eager + fetchpriority=high; demais: lazy + decoding=async;
// • srcSet 640w / 1024w, WebP.
// Sem modal, sem iframe.
// ============================================================================
import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';

type Slide = {
  id: string;
  src: string;
  alt: string;
  titulo: string;
  texto: string;
  cta: string;
  href: string;
  /** Enquadramento: retrato do modelo sempre com o rosto/peito visível. */
  posDesktop: string;
  posMobile: string;
};

export const SLIDES_HERO: Slide[] = [
  {
    id: 'costas',
    src: '/brand/hero/costas-1x.webp',
    alt: 'Camiseta preta BroBond, vista traseira, com a frase “Fala comigo”',
    titulo: 'Fala comigo.',
    texto: 'Camisetas BroBond com a assinatura da marca nas costas.',
    cta: 'Ver coleção',
    href: '#colecao',
    posDesktop: '50% 15%',
    posMobile: '50% 20%',
  },
  {
    id: 'preta',
    src: '/brand/hero/preta-1024.webp',
    alt: 'Homem com camiseta preta BroBond com logotipo branco',
    titulo: 'Own style. Original.',
    texto: 'Camiseta preta com o logotipo BroBond em destaque.',
    cta: 'Ver coleção',
    href: '#colecao',
    posDesktop: '50% 20%',
    posMobile: '50% 25%',
  },
  {
    id: 'branca',
    src: '/brand/hero/branca-1024.webp',
    alt: 'Homem com camiseta branca BroBond com logotipo preto',
    titulo: 'Own style.',
    texto: 'Camiseta branca com o logotipo BroBond em preto.',
    cta: 'Ver coleção',
    href: '#colecao',
    posDesktop: '50% 20%',
    posMobile: '50% 20%',
  },
  {
    id: 'vermelha',
    src: '/brand/hero/vermelha-1024.webp',
    alt: 'Homem com camiseta vermelha BroBond de corpo inteiro',
    titulo: 'Básicos BroBond.',
    texto: 'Camiseta vermelha com o monograma BroBond no peito.',
    cta: 'Ver coleção',
    href: '#colecao',
    posDesktop: '50% 25%',
    posMobile: '50% 25%',
  },
  {
    id: 'bege',
    src: '/brand/hero/bege-1024.webp',
    alt: 'Homem com camiseta bege BroBond e bermuda azul-marinho',
    titulo: 'Leve. Pronta pro dia.',
    texto: 'Camiseta bege com o monograma BroBond bordado.',
    cta: 'Ver coleção',
    href: '#colecao',
    posDesktop: '50% 20%',
    posMobile: '50% 20%',
  },
];

const INTERVALO_MS = 6000;

function srcSetDe(slide: Slide): string | undefined {
  if (slide.id === 'costas') return undefined; // única versão disponível (630px)
  const base = slide.src.replace(/-1024\.webp$/, '');
  return `${base}-640.webp 640w, ${base}-1024.webp 1024w`;
}

export default function HeroCarrossel() {
  const [atual, setAtual] = useState(0);
  const [pausado, setPausado] = useState(false);
  const [movimentoReduzido, setMovimentoReduzido] = useState(false);
  const toqueX = useRef<number | null>(null);
  const total = SLIDES_HERO.length;

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const atualiza = () => setMovimentoReduzido(mq.matches);
    atualiza();
    mq.addEventListener?.('change', atualiza);
    return () => mq.removeEventListener?.('change', atualiza);
  }, []);

  const ir = useCallback((i: number) => setAtual(((i % total) + total) % total), [total]);

  useEffect(() => {
    if (pausado || movimentoReduzido) return;
    const t = window.setInterval(() => setAtual((i) => (i + 1) % total), INTERVALO_MS);
    return () => window.clearInterval(t);
  }, [pausado, movimentoReduzido, total]);

  const onTouchStart = (e: React.TouchEvent) => { toqueX.current = e.touches[0].clientX; };
  const onTouchEnd = (e: React.TouchEvent) => {
    if (toqueX.current === null) return;
    const delta = e.changedTouches[0].clientX - toqueX.current;
    toqueX.current = null;
    if (Math.abs(delta) > 40) ir(atual + (delta < 0 ? 1 : -1));
  };

  const slide = SLIDES_HERO[atual];

  return (
    <section
      className="relative overflow-hidden rounded-3xl bg-navy-900 text-white"
      aria-roledescription="carrossel"
      aria-label="Destaques da coleção BroBond"
      onMouseEnter={() => setPausado(true)}
      onMouseLeave={() => setPausado(false)}
      onFocus={() => setPausado(true)}
      onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setPausado(false); }}
      onKeyDown={(e) => {
        if (e.key === 'ArrowRight') ir(atual + 1);
        if (e.key === 'ArrowLeft') ir(atual - 1);
      }}
      onTouchStart={onTouchStart}
      onTouchEnd={onTouchEnd}
    >
      <div className="relative aspect-[4/5] w-full sm:aspect-[16/9] lg:aspect-[21/9]">
        {SLIDES_HERO.map((s, i) => {
          const ativo = i === atual;
          return (
            <div
              key={s.id}
              className={`absolute inset-0 transition-opacity duration-700 ${ativo ? 'opacity-100' : 'pointer-events-none opacity-0'}`}
              aria-hidden={!ativo}
              role="group"
              aria-roledescription="slide"
              aria-label={`${i + 1} de ${total}`}
            >
              <picture>
                <img
                  src={s.src}
                  srcSet={srcSetDe(s)}
                  sizes="(min-width: 1024px) 1200px, 100vw"
                  alt={ativo ? s.alt : ''}
                  width={s.id === 'costas' ? 630 : 1024}
                  height={s.id === 'costas' ? 700 : 1536}
                  loading={i === 0 ? 'eager' : 'lazy'}
                  decoding={i === 0 ? 'sync' : 'async'}
                  {...(i === 0 ? { fetchpriority: 'high' } as Record<string, string> : {})}
                  className="h-full w-full object-cover [object-position:var(--pos-m)] sm:[object-position:var(--pos-d)]"
                  style={{ ['--pos-d' as string]: s.posDesktop, ['--pos-m' as string]: s.posMobile }}
                />
              </picture>
            </div>
          );
        })}

        {/* Overlay para leitura do texto */}
        <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/75 via-black/30 to-transparent" aria-hidden="true" />

        {/* Conteúdo do slide atual */}
        <div className="absolute inset-x-0 bottom-0 flex flex-col gap-3 p-6 sm:p-10 lg:max-w-xl">
          <h1 className="text-3xl font-semibold leading-tight tracking-tight sm:text-5xl" aria-live="polite">
            {slide.titulo}
          </h1>
          <p className="max-w-md text-sm leading-relaxed text-navy-100 sm:text-base">{slide.texto}</p>
          <div className="flex flex-wrap items-center gap-3">
            <a href={slide.href} className="inline-flex min-h-11 items-center rounded-full bg-white px-6 text-xs font-semibold uppercase tracking-wider text-navy-900 transition hover:bg-brand-100">
              {slide.cta}
            </a>
          </div>
        </div>

        {/* Logo BroBond */}
        <div className="absolute left-4 top-4 rounded-xl bg-white/95 px-3 py-2 sm:left-6 sm:top-6">
          <img src="/brand/hero/logo.webp" alt="BroBond Wear" width={120} height={150} className="h-8 w-auto object-contain sm:h-10" loading="eager" decoding="async" />
        </div>

        {/* Setas */}
        <button type="button" aria-label="Slide anterior" onClick={() => ir(atual - 1)}
          className="absolute left-2 top-1/2 flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full bg-black/40 text-white transition hover:bg-black/60 focus-visible:outline-2 focus-visible:outline-white">
          <ChevronLeft className="h-5 w-5" aria-hidden="true" />
        </button>
        <button type="button" aria-label="Próximo slide" onClick={() => ir(atual + 1)}
          className="absolute right-2 top-1/2 flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full bg-black/40 text-white transition hover:bg-black/60 focus-visible:outline-2 focus-visible:outline-white">
          <ChevronRight className="h-5 w-5" aria-hidden="true" />
        </button>

        {/* Dots */}
        <div className="absolute right-6 top-6 flex gap-2 sm:right-10 sm:top-auto sm:bottom-6" role="tablist" aria-label="Escolher slide">
          {SLIDES_HERO.map((s, i) => (
            <button key={s.id} type="button" role="tab" aria-selected={i === atual} aria-label={`Slide ${i + 1}`}
              onClick={() => ir(i)}
              className={`h-2.5 rounded-full transition-all ${i === atual ? 'w-7 bg-white' : 'w-2.5 bg-white/50 hover:bg-white/80'}`} />
          ))}
        </div>
      </div>
    </section>
  );
}
