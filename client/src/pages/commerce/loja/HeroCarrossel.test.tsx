// Carrossel do hero: 5 slides reais, sem imagens com marca d'água, navegação acessível.
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fireEvent, render, screen } from '@testing-library/react';
import HeroCarrossel, { SLIDES_HERO } from './HeroCarrossel';

const PUBLIC = path.resolve(process.cwd(), process.cwd().endsWith('client') ? 'public' : 'client/public');

describe('HeroCarrossel — homepage /loja', () => {
  it('tem 5 slides, todos com imagem real da pasta de marca, alt e CTA', () => {
    expect(SLIDES_HERO).toHaveLength(5);
    for (const s of SLIDES_HERO) {
      expect(s.src.startsWith('/brand/hero/')).toBe(true);
      expect(existsSync(path.join(PUBLIC, s.src))).toBe(true);
      expect(s.alt.length).toBeGreaterThan(10);
      expect(s.cta).toBeTruthy();
    }
  });

  it('não usa as fotos com marca d\'água Dola AI (catálogo)', () => {
    const manifesto = readFileSync(path.join(PUBLIC, 'brand/hero/manifest.json'), 'utf8');
    expect(manifesto).toMatch(/Dola AI/);
    for (const s of SLIDES_HERO) expect(s.src).not.toMatch(/catalogo|catálogo/i);
  });

  it('navega por setas e dots; o slide ativo é o único visível para leitores de tela', () => {
    render(<HeroCarrossel />);
    expect(screen.getByRole('heading', { name: SLIDES_HERO[0].titulo })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Próximo slide' }));
    expect(screen.getByRole('heading', { name: SLIDES_HERO[1].titulo })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: 'Slide 5' }));
    expect(screen.getByRole('heading', { name: SLIDES_HERO[4].titulo })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Próximo slide' }));
    expect(screen.getByRole('heading', { name: SLIDES_HERO[0].titulo })).toBeInTheDocument();
  });

  it('o primeiro slide é eager e os demais são lazy', () => {
    const { container } = render(<HeroCarrossel />);
    const imgs = Array.from(container.querySelectorAll('img')).filter((i) => i.getAttribute('src')?.startsWith('/brand/hero/') && !i.getAttribute('src')?.includes('logo'));
    expect(imgs[0].getAttribute('loading')).toBe('eager');
    for (const img of imgs.slice(1)) expect(img.getAttribute('loading')).toBe('lazy');
  });
});
