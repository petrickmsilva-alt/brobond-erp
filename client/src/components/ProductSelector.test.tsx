import { useState } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProductSelector } from './ProductSelector';
import { api } from '../lib/api';
import type { ProductSearchResponse, SearchProduct } from '../lib/productSearch';

function product(id: number, overrides: Partial<SearchProduct> = {}): SearchProduct {
  return {
    id,
    produto_pai_id: null,
    sku: `SKU-${id}`,
    nome: `Produto ${id}`,
    codigo_barras: null,
    descricao: null,
    cor: null,
    categoria: null,
    marca: null,
    preco_venda: 50,
    ativo: true,
    variacao_tamanho_id: null,
    estoque_disponivel: 0,
    tamanhos: [],
    variacoes: [],
    ...overrides,
  };
}

function response(rows: SearchProduct[], overrides: Partial<ProductSearchResponse> = {}): ProductSearchResponse {
  return { rows, total: rows.length, page: 1, pageSize: 20, hasMore: false, ...overrides };
}

async function search(input: HTMLElement, term: string, debounceMs = 200) {
  fireEvent.change(input, { target: { value: term } });
  await act(async () => {
    vi.advanceTimersByTime(debounceMs);
    await Promise.resolve();
  });
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('ProductSelector — Smart Product Search compartilhado', () => {
  it('faz debounce de 200 ms, envia múltiplos termos ao backend e mostra atributos/variações/saldos', async () => {
    vi.useFakeTimers();
    const variante = product(11, {
      produto_pai_id: 10,
      sku: 'CAM-VERM-G',
      nome: 'Camiseta Premium Vermelha G',
      codigo_barras: '7895550001112',
      cor: 'Vermelha',
      categoria: 'Camisetas',
      marca: 'BroBond',
      variacao_tamanho_id: 4,
      estoque_disponivel: 8,
      tamanhos: [{ tamanho_id: 4, tamanho: 'G', quantidade: 8 }],
    });
    const pai = product(10, {
      sku: 'CAM-PREM',
      nome: 'Camiseta Premium',
      estoque_disponivel: 15,
      tamanhos: [{ tamanho_id: 4, tamanho: 'G', quantidade: 8 }],
      variacoes: [variante],
    });
    const get = vi.spyOn(api, 'get').mockResolvedValue(response([pai]));
    render(<ProductSelector selectParentsWithVariants={false} aria-label="Produto" />);
    const input = screen.getByRole('combobox', { name: 'Produto' });

    fireEvent.change(input, { target: { value: 'c' } });
    fireEvent.change(input, { target: { value: 'cam' } });
    fireEvent.change(input, { target: { value: 'camiseta vermelha' } });
    expect(get).not.toHaveBeenCalled();
    await act(async () => { vi.advanceTimersByTime(199); });
    expect(get).not.toHaveBeenCalled();
    await act(async () => {
      vi.advanceTimersByTime(1);
      await Promise.resolve();
    });

    expect(get).toHaveBeenCalledTimes(1);
    const url = String(get.mock.calls[0][0]);
    expect(url).toContain('/produtos/busca?');
    expect(url).toContain('q=camiseta+vermelha');
    expect(url).toContain('page=1');
    expect(url).toContain('pageSize=20');
    expect(screen.getByText(/Escolha uma variação\/tamanho abaixo/)).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /CAM-VERM-G/ })).toBeInTheDocument();
    expect(screen.getByText('EAN 7895550001112')).toBeInTheDocument();
    expect(screen.getByText('Vermelha')).toBeInTheDocument();
    expect(screen.getByText('Camisetas')).toBeInTheDocument();
    expect(screen.getByText('BroBond')).toBeInTheDocument();
    expect(screen.getAllByText('G: 8').length).toBeGreaterThan(0);
  });

  it('navega com setas, seleciona com Enter, limpa e devolve foco à busca', async () => {
    vi.useFakeTimers();
    const primeiro = product(1, { sku: 'PRIMEIRO', nome: 'Primeiro' });
    const segundo = product(2, { sku: 'SEGUNDO', nome: 'Segundo' });
    vi.spyOn(api, 'get').mockResolvedValue(response([primeiro, segundo]));
    const onSelect = vi.fn().mockResolvedValue(true);
    render(<ProductSelector clearOnSelect onSelect={onSelect} aria-label="Produto" />);
    const input = screen.getByRole('combobox', { name: 'Produto' }) as HTMLInputElement;
    input.focus();
    await search(input, 'produto');

    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });
    await act(async () => { await Promise.resolve(); });
    expect(onSelect).toHaveBeenCalledWith(segundo);
    expect(input.value).toBe('');
    expect(input).toHaveFocus();
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('Escape fecha, Tab não escolhe acidentalmente e Enter sem lista mantém o caminho exato', async () => {
    vi.useFakeTimers();
    vi.spyOn(api, 'get').mockResolvedValue(response([product(1)]));
    const onSubmit = vi.fn().mockResolvedValue(true);
    const onSelect = vi.fn();
    render(<ProductSelector clearOnSelect onSubmit={onSubmit} onSelect={onSelect} aria-label="Produto" />);
    const input = screen.getByRole('combobox', { name: 'Produto' });

    fireEvent.change(input, { target: { value: '7891234567890' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await act(async () => { await Promise.resolve(); });
    expect(onSubmit).toHaveBeenCalledWith('7891234567890');
    expect(onSelect).not.toHaveBeenCalled();

    await search(input, 'produto');
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(onSelect).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Tab' });
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('pagina com Mostrar mais sem recarregar o catálogo inteiro', async () => {
    vi.useFakeTimers();
    const get = vi.spyOn(api, 'get')
      .mockResolvedValueOnce(response([product(1)], { total: 2, hasMore: true }))
      .mockResolvedValueOnce(response([product(2)], { total: 2, page: 2, hasMore: false }));
    render(<ProductSelector aria-label="Produto" />);
    await search(screen.getByRole('combobox', { name: 'Produto' }), 'prod');

    fireEvent.click(screen.getByRole('button', { name: /Mostrar mais/ }));
    await act(async () => { await Promise.resolve(); });
    expect(get).toHaveBeenCalledTimes(2);
    expect(String(get.mock.calls[1][0])).toContain('page=2');
    expect(screen.getByRole('option', { name: /SKU-1/ })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /SKU-2/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Mostrar mais/ })).not.toBeInTheDocument();
  });

  it('carrega a próxima página com ArrowDown no último resultado', async () => {
    vi.useFakeTimers();
    const get = vi.spyOn(api, 'get')
      .mockResolvedValueOnce(response([product(1)], { total: 2, hasMore: true }))
      .mockResolvedValueOnce(response([product(2)], { total: 2, page: 2, hasMore: false }));
    render(<ProductSelector aria-label="Produto" />);
    const input = screen.getByRole('combobox', { name: 'Produto' });
    await search(input, 'prod');
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    await act(async () => { await Promise.resolve(); });
    expect(get).toHaveBeenCalledTimes(2);
    expect(String(get.mock.calls[1][0])).toContain('page=2');
    expect(screen.getByRole('option', { name: /SKU-2/ })).toBeInTheDocument();
  });

  it('não deixa uma resposta antiga do ID sobrescrever digitação mais recente', async () => {
    vi.useFakeTimers();
    let resolverId!: (value: ProductSearchResponse) => void;
    const get = vi.spyOn(api, 'get').mockImplementation((path: string) => {
      if (path.includes('id=99')) return new Promise<ProductSearchResponse>((resolve) => { resolverId = resolve; });
      return Promise.resolve(response([]));
    });
    render(<ProductSelector value={99} aria-label="Produto" />);
    const input = screen.getByRole('combobox', { name: 'Produto' }) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'digitação nova' } });
    await act(async () => {
      resolverId(response([product(99, { sku: 'ANTIGO', nome: 'Registro antigo' })]));
      await Promise.resolve();
    });
    expect(input.value).toBe('digitação nova');
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('preserva a primeira tecla ao editar uma seleção em formulário controlado', async () => {
    vi.useFakeTimers();
    const get = vi.spyOn(api, 'get').mockImplementation((path: string) => {
      if (path.includes('id=42')) return Promise.resolve(response([product(42, { sku: 'EDIT-42', nome: 'Produto em edição' })]));
      return Promise.resolve(response([]));
    });
    function ControlledSelector() {
      const [value, setValue] = useState('42');
      return <ProductSelector value={value} onChange={setValue} aria-label="Produto" />;
    }
    render(<ControlledSelector />);
    await act(async () => { await Promise.resolve(); });
    const input = screen.getByRole('combobox', { name: 'Produto' }) as HTMLInputElement;
    expect(input.value).toBe('EDIT-42 — Produto em edição');

    fireEvent.change(input, { target: { value: 'camiseta' } });
    expect(input.value).toBe('camiseta');
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('mantém a variação exibida quando o formulário controlado persiste o produto pai', async () => {
    vi.useFakeTimers();
    const variante = product(101, {
      produto_pai_id: 10,
      sku: 'CAM-VERM-G',
      nome: 'Camiseta Premium Vermelha G',
      variacao_tamanho_id: 4,
      tamanhos: [{ tamanho_id: 4, tamanho: 'G', quantidade: 8 }],
    });
    const pai = product(10, { sku: 'CAM-PREM', nome: 'Camiseta Premium', variacoes: [variante] });
    const get = vi.spyOn(api, 'get').mockResolvedValue(response([pai]));
    function CanonicalSelector() {
      const [value, setValue] = useState('');
      return <ProductSelector
        value={value}
        selectParentsWithVariants={false}
        onChange={(id, selectedProduct) => setValue(selectedProduct ? String(selectedProduct.produto_pai_id ?? selectedProduct.id) : id)}
        aria-label="Produto"
      />;
    }
    render(<CanonicalSelector />);
    const input = screen.getByRole('combobox', { name: 'Produto' }) as HTMLInputElement;
    await search(input, 'camiseta vermelha');
    fireEvent.click(screen.getByRole('option', { name: /CAM-VERM-G/ }));
    await act(async () => { await Promise.resolve(); });

    expect(input.value).toBe('CAM-VERM-G — Camiseta Premium Vermelha G');
    expect(get).toHaveBeenCalledTimes(1);
    expect(String(get.mock.calls[0][0])).not.toContain('id=10');
  });

  it('recupera somente o ID em edição e apresenta busca vazia sem inventar resultado', async () => {
    vi.useFakeTimers();
    const get = vi.spyOn(api, 'get').mockImplementation((path: string) => {
      if (path.includes('id=42')) return Promise.resolve(response([product(42, { sku: 'EDIT-42', nome: 'Produto em edição' })]));
      return Promise.resolve(response([]));
    });
    render(<ProductSelector value={42} aria-label="Produto" />);
    await act(async () => { await Promise.resolve(); });
    expect((screen.getByRole('combobox', { name: 'Produto' }) as HTMLInputElement).value).toBe('EDIT-42 — Produto em edição');
    expect(get).toHaveBeenCalledTimes(1);
    expect(String(get.mock.calls[0][0])).toContain('includeInactive=true');

    fireEvent.change(screen.getByRole('combobox', { name: 'Produto' }), { target: { value: '0000000000000' } });
    await act(async () => {
      vi.advanceTimersByTime(200);
      await Promise.resolve();
    });
    expect(screen.getByText(/Nenhum produto encontrado/)).toBeInTheDocument();
  });
});
