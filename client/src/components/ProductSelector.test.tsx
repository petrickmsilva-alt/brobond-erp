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
    expect(screen.getAllByText('G 8').length).toBeGreaterThan(0);
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
    expect(onSelect).toHaveBeenCalledWith(segundo, expect.objectContaining({
      produto: segundo,
      produto_id: 2,
      tamanho_id: null,
    }));
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

// ============================================================================
// Seleção hierárquica — produto PAI → tamanho → variação
//
// O defeito real: o pai mostrava P/M/G/GG, mas não havia como escolher o
// tamanho — a linha entrava sem tamanho e travava no faturamento. Estes testes
// garantem que a combinação é explícita, que o saldo continua sendo uma única
// célula (pai + tamanho + local) e que o pai nunca é devolvido sozinho quando
// há mais de uma combinação possível.
// ============================================================================

const TAMANHOS_PADRAO = [
  { tamanho_id: 1, tamanho: 'P', quantidade: 4 },
  { tamanho_id: 2, tamanho: 'M', quantidade: 2 },
  { tamanho_id: 3, tamanho: 'G', quantidade: 6 },
  { tamanho_id: 4, tamanho: 'GG', quantidade: 3 },
];

function produtoComGrade(overrides: Partial<SearchProduct> = {}): SearchProduct {
  const tamanhos = overrides.tamanhos ?? TAMANHOS_PADRAO;
  return product(10, {
    sku: 'CAM-PREM',
    nome: 'Camiseta Premium',
    preco_venda: 79.9,
    estoque_disponivel: tamanhos.reduce((total, t) => total + t.quantidade, 0),
    tamanhos,
    ...overrides,
  });
}

async function abrirBusca(termo = 'camiseta') {
  const input = screen.getByRole('combobox', { name: 'Produto' }) as HTMLInputElement;
  await search(input, termo);
  return input;
}

function opcao(nome: RegExp | string) {
  return screen.getByRole('option', { name: nome });
}

describe('ProductSelector — seleção hierárquica de tamanho', () => {
  it('produto com vários tamanhos: o pai deixa de ser uma escolha e os tamanhos viram opções', async () => {
    vi.useFakeTimers();
    vi.spyOn(api, 'get').mockResolvedValue(response([produtoComGrade()]));
    const onSelect = vi.fn().mockResolvedValue(true);
    render(<ProductSelector onSelect={onSelect} requiresStock aria-label="Produto" />);
    await abrirBusca();

    // O pai continua visível como cabeçalho da família, mas está marcado como
    // não selecionável — clicar nele não pode disparar onSelect.
    const pai = opcao(/CAM-PREM/);
    expect(pai).toHaveAttribute('aria-disabled', 'true');
    expect(pai).toHaveTextContent('Escolha um tamanho abaixo');

    // Cada tamanho é uma opção com tamanho + saldo.
    expect(opcao(/Tamanho P: 4 disponível/)).toHaveAttribute('data-tamanho-id', '1');
    expect(opcao(/Tamanho M: 2 disponível/)).toHaveAttribute('data-tamanho-id', '2');
    expect(opcao(/Tamanho G: 6 disponível/)).toHaveAttribute('data-tamanho-id', '3');
    expect(opcao(/Tamanho GG: 3 disponível/)).toHaveAttribute('data-tamanho-id', '4');
    expect(screen.getByText('P 4')).toBeInTheDocument();

    fireEvent.click(pai);
    expect(onSelect).not.toHaveBeenCalled();
    expect(screen.getByRole('status')).toHaveTextContent('Escolha o tamanho de Camiseta Premium');
  });

  it.each([
    ['P', 1],
    ['M', 2],
    ['G', 3],
    ['GG', 4],
  ])('seleciona explicitamente o tamanho %s', async (tamanho, tamanhoId) => {
    vi.useFakeTimers();
    const pai = produtoComGrade();
    vi.spyOn(api, 'get').mockResolvedValue(response([pai]));
    const onSelect = vi.fn().mockResolvedValue(true);
    const onChange = vi.fn();
    render(<ProductSelector onSelect={onSelect} onChange={onChange} requiresStock aria-label="Produto" />);
    const input = await abrirBusca();

    fireEvent.click(opcao(new RegExp(`Tamanho ${tamanho}:`)));
    await act(async () => { await Promise.resolve(); });

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith(pai, {
      produto: pai,
      produto_id: 10,
      produto_pai_id: null,
      variacao: null,
      sku: 'CAM-PREM',
      preco: 79.9,
      tamanho_id: tamanhoId,
      tamanho,
      quantidade_disponivel: TAMANHOS_PADRAO[tamanhoId - 1].quantidade,
    });
    // O formulário recebe a mesma combinação (pai + tamanho).
    expect(onChange).toHaveBeenCalledWith('10', pai, expect.objectContaining({ tamanho_id: tamanhoId }));
    // E o campo passa a exibir o tamanho escolhido, sem esconder o produto.
    expect(input.value).toBe(`CAM-PREM — Camiseta Premium · ${tamanho}`);
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('tamanho sem estoque aparece, mas fica indisponível quando o contexto exige saldo', async () => {
    vi.useFakeTimers();
    const pai = produtoComGrade({
      tamanhos: [
        { tamanho_id: 1, tamanho: 'P', quantidade: 4 },
        { tamanho_id: 2, tamanho: 'M', quantidade: 0 },
      ],
      estoque_disponivel: 4,
    });
    vi.spyOn(api, 'get').mockResolvedValue(response([pai]));
    const onSelect = vi.fn().mockResolvedValue(true);
    render(<ProductSelector onSelect={onSelect} requiresStock aria-label="Produto" />);
    await abrirBusca();

    const semSaldo = opcao(/Tamanho M: 0 disponível/);
    expect(semSaldo).toBeInTheDocument();
    expect(semSaldo).toBeDisabled();
    expect(semSaldo).toHaveAttribute('aria-disabled', 'true');
    expect(semSaldo).toHaveTextContent('M 0');

    fireEvent.click(semSaldo);
    await act(async () => { await Promise.resolve(); });
    expect(onSelect).not.toHaveBeenCalled();
    // O saldo zero não impede a navegação para o tamanho seguinte.
    const input = screen.getByRole('combobox', { name: 'Produto' });
    expect(input).toHaveAttribute('aria-activedescendant', expect.stringContaining('p-10'));
  });

  it('fora de venda (sem exigir estoque) o tamanho zerado continua selecionável', async () => {
    vi.useFakeTimers();
    const pai = produtoComGrade({
      tamanhos: [
        { tamanho_id: 1, tamanho: 'P', quantidade: 4 },
        { tamanho_id: 2, tamanho: 'M', quantidade: 0 },
      ],
      estoque_disponivel: 4,
    });
    vi.spyOn(api, 'get').mockResolvedValue(response([pai]));
    const onSelect = vi.fn().mockResolvedValue(true);
    render(<ProductSelector onSelect={onSelect} aria-label="Produto" />);
    await abrirBusca();

    const semSaldo = opcao(/Tamanho M: 0 disponível/);
    expect(semSaldo).not.toBeDisabled();
    fireEvent.click(semSaldo);
    await act(async () => { await Promise.resolve(); });
    expect(onSelect).toHaveBeenCalledWith(pai, expect.objectContaining({ tamanho_id: 2, tamanho: 'M', quantidade_disponivel: 0 }));
  });

  it('produto com variações: a variação escolhida carrega pai, SKU, preço e tamanho sem duplicar saldo', async () => {
    vi.useFakeTimers();
    const varianteP = product(110, {
      produto_pai_id: 10,
      sku: 'CAM-PREM-P',
      nome: 'Camiseta Premium P',
      variacao_tamanho_id: 1,
      preco_venda: 84.9,
      estoque_disponivel: 4,
      tamanhos: [{ tamanho_id: 1, tamanho: 'P', quantidade: 4 }],
    });
    const varianteM = product(111, {
      produto_pai_id: 10,
      sku: 'CAM-PREM-M',
      nome: 'Camiseta Premium M',
      variacao_tamanho_id: 2,
      preco_venda: 84.9,
      estoque_disponivel: 2,
      tamanhos: [{ tamanho_id: 2, tamanho: 'M', quantidade: 2 }],
    });
    const pai = produtoComGrade({ variacoes: [varianteP, varianteM], estoque_disponivel: 6 });
    vi.spyOn(api, 'get').mockResolvedValue(response([pai]));
    const onSelect = vi.fn().mockResolvedValue(true);
    render(<ProductSelector onSelect={onSelect} requiresStock aria-label="Produto" />);
    const input = await abrirBusca('camiseta');

    // O pai é cabeçalho: não é uma escolha quando existem variações.
    expect(opcao(/^CAM-PREM —/)).toHaveAttribute('aria-disabled', 'true');
    // Os tamanhos já cobertos por variação não são oferecidos de novo pelo pai.
    expect(screen.queryByRole('option', { name: /Tamanho P:/ })).not.toBeInTheDocument();

    fireEvent.click(opcao(/CAM-PREM-M/));
    await act(async () => { await Promise.resolve(); });

    expect(onSelect).toHaveBeenCalledWith(varianteM, {
      produto: pai,
      produto_id: 10,
      produto_pai_id: 10,
      variacao: varianteM,
      sku: 'CAM-PREM-M',
      preco: 84.9,
      tamanho_id: 2,
      tamanho: 'M',
      // Saldo da célula do pai — as variações não são somadas.
      quantidade_disponivel: 2,
    });
    expect(input.value).toBe('CAM-PREM-M — Camiseta Premium M');
    expect(pai.estoque_disponivel).toBe(6);
  });

  it('produto com variações e tamanho sem variação: o tamanho restante é vendido pelo pai', async () => {
    vi.useFakeTimers();
    const varianteP = product(110, {
      produto_pai_id: 10,
      sku: 'CAM-PREM-P',
      nome: 'Camiseta Premium P',
      variacao_tamanho_id: 1,
      estoque_disponivel: 4,
      tamanhos: [{ tamanho_id: 1, tamanho: 'P', quantidade: 4 }],
    });
    const pai = produtoComGrade({
      tamanhos: [
        { tamanho_id: 1, tamanho: 'P', quantidade: 4 },
        { tamanho_id: 3, tamanho: 'G', quantidade: 6 },
      ],
      variacoes: [varianteP],
      estoque_disponivel: 10,
    });
    vi.spyOn(api, 'get').mockResolvedValue(response([pai]));
    const onSelect = vi.fn().mockResolvedValue(true);
    render(<ProductSelector onSelect={onSelect} requiresStock aria-label="Produto" />);
    await abrirBusca();

    // Só o tamanho sem variação aparece como opção do pai.
    expect(opcao(/Tamanho G: 6 disponível/)).toHaveAttribute('data-tamanho-id', '3');
    expect(screen.queryByRole('option', { name: /Tamanho P:/ })).not.toBeInTheDocument();

    fireEvent.click(opcao(/Tamanho G:/));
    await act(async () => { await Promise.resolve(); });
    expect(onSelect).toHaveBeenCalledWith(pai, expect.objectContaining({
      produto_id: 10,
      variacao: null,
      tamanho_id: 3,
      tamanho: 'G',
    }));
  });

  it('produto sem variação e com um único tamanho continua com seleção direta', async () => {
    vi.useFakeTimers();
    const unico = product(20, {
      sku: 'BONE-UNICO',
      nome: 'Boné Único',
      preco_venda: 49.9,
      tamanhos: [{ tamanho_id: 9, tamanho: 'Único', quantidade: 7 }],
      estoque_disponivel: 7,
    });
    vi.spyOn(api, 'get').mockResolvedValue(response([unico]));
    const onSelect = vi.fn().mockResolvedValue(true);
    render(<ProductSelector onSelect={onSelect} requiresStock aria-label="Produto" />);
    await abrirBusca('bone');

    // Sem grade: nenhum botão de tamanho, apenas a informação de saldo.
    expect(screen.queryByRole('option', { name: /Tamanho Único:/ })).not.toBeInTheDocument();
    fireEvent.click(opcao(/BONE-UNICO/));
    await act(async () => { await Promise.resolve(); });

    expect(onSelect).toHaveBeenCalledWith(unico, expect.objectContaining({
      produto_id: 20,
      tamanho_id: 9,
      tamanho: 'Único',
      quantidade_disponivel: 7,
    }));
  });

  it('produto sem tamanho é selecionado diretamente com tamanho_id nulo', async () => {
    vi.useFakeTimers();
    const semTamanho = product(30, { sku: 'SERV-01', nome: 'Serviço de ajuste', tamanhos: [], estoque_disponivel: 0 });
    vi.spyOn(api, 'get').mockResolvedValue(response([semTamanho]));
    const onSelect = vi.fn().mockResolvedValue(true);
    render(<ProductSelector onSelect={onSelect} requiresStock aria-label="Produto" />);
    await abrirBusca('ajuste');

    fireEvent.click(opcao(/SERV-01/));
    await act(async () => { await Promise.resolve(); });
    expect(onSelect).toHaveBeenCalledWith(semTamanho, expect.objectContaining({ tamanho_id: null, tamanho: null }));
  });

  it('tentar selecionar o pai com múltiplos tamanhos pelo teclado leva à escolha do tamanho', async () => {
    vi.useFakeTimers();
    const pai = produtoComGrade();
    vi.spyOn(api, 'get').mockResolvedValue(response([pai]));
    const onSelect = vi.fn().mockResolvedValue(true);
    render(<ProductSelector onSelect={onSelect} requiresStock aria-label="Produto" />);
    const input = await abrirBusca();

    input.focus();
    // Enter no pai: não chama onSelect, move o foco virtual para o primeiro
    // tamanho disponível e anuncia o motivo.
    fireEvent.keyDown(input, { key: 'Enter' });
    await act(async () => { await Promise.resolve(); });
    expect(onSelect).not.toHaveBeenCalled();
    const primeiroTamanho = opcao(/Tamanho P: 4/);
    expect(input).toHaveAttribute('aria-activedescendant', primeiroTamanho.id);

    // O segundo Enter escolhe o tamanho ativo — combinação completa.
    fireEvent.keyDown(input, { key: 'Enter' });
    await act(async () => { await Promise.resolve(); });
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith(pai, expect.objectContaining({ tamanho_id: 1, tamanho: 'P', produto_id: 10 }));
  });

  it('setas navegam do pai para os tamanhos, Escape recolhe a instrução e fecha, Tab não escolhe', async () => {
    vi.useFakeTimers();
    vi.spyOn(api, 'get').mockResolvedValue(response([produtoComGrade()]));
    const onSelect = vi.fn().mockResolvedValue(true);
    render(<ProductSelector onSelect={onSelect} requiresStock aria-label="Produto" />);
    const input = await abrirBusca();

    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(input).toHaveAttribute('aria-activedescendant', expect.stringContaining('s-10-1'));

    fireEvent.click(screen.getByRole('option', { name: /CAM-PREM/ }));
    expect(screen.getByRole('status')).toHaveTextContent(/Escolha o tamanho/);
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.getByRole('listbox')).toBeInTheDocument();

    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(onSelect).not.toHaveBeenCalled();

    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Tab' });
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('cadastro/filtro sem onSelect: o pai continua selecionável como referência, sem inventar combinação', async () => {
    vi.useFakeTimers();
    const variante = product(110, {
      produto_pai_id: 10,
      sku: 'CAM-PREM-P',
      nome: 'Camiseta Premium P',
      variacao_tamanho_id: 1,
      estoque_disponivel: 4,
      tamanhos: [{ tamanho_id: 1, tamanho: 'P', quantidade: 4 }],
    });
    const pai = produtoComGrade({
      tamanhos: [{ tamanho_id: 1, tamanho: 'P', quantidade: 4 }],
      variacoes: [variante],
      estoque_disponivel: 4,
    });
    vi.spyOn(api, 'get').mockResolvedValue(response([pai]));
    const onChange = vi.fn();
    render(<ProductSelector onChange={onChange} aria-label="Produto" />);
    const input = await abrirBusca();

    const paiOpcao = opcao(/^CAM-PREM —/);
    expect(paiOpcao).not.toHaveAttribute('aria-disabled');
    fireEvent.click(paiOpcao);
    await act(async () => { await Promise.resolve(); });

    // Referência administrativa: produto pai + id, sem `selection` e sem
    // transformar o cadastro em uma linha de venda.
    expect(onChange).toHaveBeenCalledWith('10', pai);
    expect(input.value).toBe('CAM-PREM — Camiseta Premium');
  });

  it('falha do consumidor mantém a combinação em aberto para nova tentativa', async () => {
    vi.useFakeTimers();
    vi.spyOn(api, 'get').mockResolvedValue(response([produtoComGrade()]));
    const onSelect = vi.fn().mockResolvedValue(false);
    render(<ProductSelector onSelect={onSelect} requiresStock aria-label="Produto" />);
    await abrirBusca();

    fireEvent.click(opcao(/Tamanho G:/));
    await act(async () => { await Promise.resolve(); });
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    const campo = screen.getByRole('combobox', { name: 'Produto' }) as HTMLInputElement;
    expect(campo.value).not.toMatch(/· G/);
  });
});

describe('ProductSelector — apresentação profissional dos resultados', () => {
  it('mantém nome, foto, estoque total e os cinco tamanhos legíveis no caso real', async () => {
    vi.useFakeTimers();
    const tamanhos = [
      { tamanho_id: 1, tamanho: 'P', quantidade: 7 },
      { tamanho_id: 2, tamanho: 'M', quantidade: 10 },
      { tamanho_id: 3, tamanho: 'G', quantidade: 10 },
      { tamanho_id: 4, tamanho: 'GG', quantidade: 10 },
      { tamanho_id: 5, tamanho: 'EG', quantidade: 10 },
    ];
    const item = product(77, {
      sku: 'CAM-BAS-PREM-PRET-"B"',
      nome: 'COTTON "B"',
      categoria: 'Camisetas básicas premium',
      cor: 'Preta',
      marca: 'BroBond',
      descricao: 'Malha de algodão premium',
      foto_url: '/api/files/77/principal.jpg?thumb=1',
      estoque_disponivel: 47,
      tamanhos,
    });
    const get = vi.spyOn(api, 'get').mockResolvedValue(response([item]));
    render(<ProductSelector onSelect={vi.fn()} requiresStock aria-label="Produto" />);
    await abrirBusca('cotton');

    const card = opcao(/CAM-BAS-PREM-PRET/);
    const nome = screen.getByText('COTTON "B"');
    expect(nome).toHaveClass('break-words', 'font-semibold');
    expect(nome).toHaveAttribute('title', 'COTTON "B"');
    expect(nome.className).not.toContain('truncate');
    expect(card).toHaveTextContent('Camisetas básicas premium');
    expect(card).toHaveTextContent('Preta');
    expect(card).toHaveTextContent('SKU CAM-BAS-PREM-PRET-"B"');
    expect(card).toHaveTextContent('Estoque total: 47 un.');
    expect(card).not.toHaveTextContent('Malha de algodão premium');

    const foto = screen.getByRole('img', { name: 'COTTON "B"' });
    expect(foto).toHaveAttribute('src', '/api/files/77/principal.jpg?thumb=1');
    expect(foto).toHaveClass('object-cover');
    expect(foto.parentElement).toHaveStyle({ width: '44px', height: '44px' });

    const grade = screen.getByRole('group', { name: 'Tamanhos de COTTON "B"' });
    expect(grade).toHaveClass('flex', 'flex-wrap');
    expect(grade.className).not.toContain('shrink-0');
    expect(grade.querySelectorAll('[role="option"]')).toHaveLength(5);
    for (const tamanho of tamanhos) {
      expect(opcao(new RegExp(`Tamanho ${tamanho.tamanho}: ${tamanho.quantidade} disponível`)))
        .toHaveTextContent(`${tamanho.tamanho} ${tamanho.quantidade}`);
    }
    expect(card).toHaveAttribute('aria-selected', 'true');
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('quebra nome e SKU longos, mostra placeholder e não omite tamanhos em uma página cheia', async () => {
    vi.useFakeTimers();
    const nomeLongo = 'Camiseta premium de algodão penteado com modelagem oversized e identificação completa para conferência visual no atendimento';
    const skuLongo = `SKU-${'BROBOND-PREMIUM-PRETA-'.repeat(4)}EDICAO-LIMITADA`;
    const tamanhos = ['P', 'M', 'G', 'GG', 'EG', 'XG', 'XXG', '3G'].map((tamanho, index) => ({
      tamanho_id: index + 1,
      tamanho,
      quantidade: index + 1,
    }));
    const semFoto = product(90, {
      sku: skuLongo,
      nome: nomeLongo,
      foto_url: null,
      estoque_disponivel: 36,
      tamanhos,
    });
    const rows = [
      semFoto,
      ...Array.from({ length: 19 }, (_, index) => product(200 + index, {
        nome: `Produto catálogo ${index + 1}`,
      })),
    ];
    const get = vi.spyOn(api, 'get').mockResolvedValue(response(rows, { total: 100, hasMore: true }));
    render(<ProductSelector onSelect={vi.fn()} requiresStock aria-label="Produto" />);
    await abrirBusca('premium');

    const nome = screen.getByText(nomeLongo);
    const card = nome.closest('[role="option"]');
    expect(card).not.toBeNull();
    expect(nome).toHaveClass('break-words');
    expect(screen.getByTitle(skuLongo)).toHaveClass('[overflow-wrap:anywhere]');
    expect(card).toHaveTextContent('Estoque total: 36 un.');
    expect(screen.getByRole('img', { name: `Sem foto de ${nomeLongo}` })).toBeInTheDocument();

    const grade = screen.getByRole('group', { name: `Tamanhos de ${nomeLongo}` });
    expect(grade).toHaveClass('flex-wrap');
    expect(grade.querySelectorAll('[role="option"]')).toHaveLength(8);
    for (const tamanho of tamanhos) {
      expect(opcao(new RegExp(`Tamanho ${tamanho.tamanho}: ${tamanho.quantidade} disponível`)))
        .toHaveTextContent(`${tamanho.tamanho} ${tamanho.quantidade}`);
    }

    expect(screen.getAllByRole('option', { name: /Produto catálogo/ })).toHaveLength(19);
    expect(screen.getByRole('button', { name: /Mostrar mais/ })).toBeInTheDocument();
    const listbox = screen.getByRole('listbox');
    expect(listbox).toHaveClass('max-h-96', 'overflow-y-auto', 'overflow-x-hidden', 'min-w-0');
    expect(listbox.className).not.toContain('min-w-[22rem]');
    expect(get).toHaveBeenCalledTimes(1);
  });
});
