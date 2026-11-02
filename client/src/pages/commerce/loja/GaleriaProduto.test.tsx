// ============================================================================
// STOREFRONT ENTERPRISE — galeria inline profissional.
// Garante as regras de aceite: zero overlay/modal/dialog, uma/muitas fotos,
// contador, miniaturas, zoom INLINE, imagens por variação com fallback e
// placeholder honesto quando não existe mídia. Dimensões explícitas e lazy
// loading fora do primeiro viewport (CLS/performance).
// ============================================================================
import { describe, expect, it } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import GaleriaProduto, { galeriaDaVariante, type MidiaLoja } from './GaleriaProduto';

const midia = (id: number, extra: Partial<MidiaLoja> = {}): MidiaLoja => ({
  id,
  url: `/api/arquivos/${id}/conteudo`,
  thumb_url: `/api/arquivos/${id}/conteudo?thumb=1`,
  alt_text: `Foto ${id}`,
  principal: false,
  variante_id: null,
  ...extra,
});

const ZERO_OVERLAY = /modal|dialog|drawer|sheet|overlay|fixed inset-0|createPortal/i;

describe('GaleriaProduto — sem overlay, dados reais', () => {
  it('sem mídia → placeholder honesto, nenhuma imagem inventada', () => {
    const { container } = render(<GaleriaProduto fotos={[]} nome="COTTON B" />);
    expect(screen.getByRole('img', { name: /sem foto cadastrada/i })).toBeInTheDocument();
    expect(container.querySelectorAll('img')).toHaveLength(0);
    expect(container.innerHTML).not.toMatch(ZERO_OVERLAY);
  });

  it('uma foto → imagem principal com dimensões, alt text real e sem contador', () => {
    const { container } = render(<GaleriaProduto fotos={[midia(1, { principal: true })]} nome="COTTON B" />);
    const img = container.querySelector('img[fetchpriority="high"]') as HTMLImageElement;
    expect(img).toBeTruthy();
    expect(img.getAttribute('width')).toBe('800');
    expect(img.getAttribute('height')).toBe('1000');
    expect(img.getAttribute('alt')).toBe('Foto 1');
    expect(screen.queryByText(/1 \/ 1/)).toBeNull();
  });

  it('muitas fotos → contador 1 / 3, miniaturas lazy e navegação real', () => {
    const { container } = render(<GaleriaProduto fotos={[midia(1, { principal: true }), midia(2), midia(3)]} nome="COTTON B" />);
    expect(screen.getAllByText('1 / 3').length).toBeGreaterThan(0);
    const miniaturas = screen.getAllByRole('button', { name: /ver foto \d de 3/i });
    expect(miniaturas).toHaveLength(3);
    for (const m of miniaturas) expect((m.querySelector('img') as HTMLImageElement).getAttribute('loading')).toBe('lazy');
    fireEvent.click(screen.getAllByRole('button', { name: 'Próxima imagem' })[0]);
    expect(screen.getAllByText('2 / 3').length).toBeGreaterThan(0);
  });

  it('zoom é INLINE (painel no fluxo), nunca modal/overlay', () => {
    const { container } = render(<GaleriaProduto fotos={[midia(1)]} nome="COTTON B" />);
    const botao = screen.getByRole('button', { name: 'Ampliar' });
    fireEvent.click(botao);
    expect(screen.getByRole('button', { name: 'Reduzir' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(container.innerHTML).not.toMatch(ZERO_OVERLAY);
  });

  it('variante com mídia própria troca a galeria; sem mídia própria faz fallback', () => {
    const gerais = [midia(1, { principal: true }), midia(2)];
    const mapa = { '7': [midia(3, { variante_id: 7, principal: true })], '8': [] };
    expect(galeriaDaVariante(gerais, mapa, 7).map((f) => f.id)).toEqual([3]);
    expect(galeriaDaVariante(gerais, mapa, 8).map((f) => f.id)).toEqual([1, 2]);
    expect(galeriaDaVariante(gerais, mapa, null).map((f) => f.id)).toEqual([1, 2]);
    const { container, rerender } = render(<GaleriaProduto fotos={gerais} galeriasPorVariante={mapa} varianteId={7} nome="COTTON B" />);
    expect((container.querySelector('img[fetchpriority="high"]') as HTMLImageElement).getAttribute('src')).toContain('/3/');
    rerender(<GaleriaProduto fotos={gerais} galeriasPorVariante={mapa} varianteId={8} nome="COTTON B" />);
    expect((container.querySelector('img[fetchpriority="high"]') as HTMLImageElement).getAttribute('src')).toContain('/1/');
  });
});
