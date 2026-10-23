// ============================================================================
// CADASTRO DE PRODUTO — página própria (/produtos/novo, /produtos/:id/editar).
//
// Trava o contrato de UX: campos organizados por seção, máscaras nos campos de
// formato conhecido, erro junto do campo sem perder o que foi digitado, payload
// normalizado, e os fluxos criar / editar / cancelar.
// ============================================================================
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import ProdutoFormPage from './ProdutoFormPage';
import { ToastProvider } from '../components/ui';
import { api, ApiError } from '../lib/api';

const navigateMock = vi.fn();
let routeParams: Record<string, string> = {};

vi.mock('../lib/api', () => {
  class ApiErrorMock extends Error {
    status: number;
    fields?: Record<string, string>;
    code?: string;
    constructor(status: number, message: string, fields?: Record<string, string>, code?: string) {
      super(message);
      this.status = status;
      this.fields = fields;
      this.code = code;
    }
  }
  return {
    api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), del: vi.fn() },
    ApiError: ApiErrorMock,
    downloadFile: vi.fn(),
  };
});

vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>();
  return {
    ...actual,
    useParams: () => routeParams,
    useNavigate: () => navigateMock,
  };
});

// Metadados mínimos do recurso produtos, com as seções reais do domínio.
vi.mock('../lib/meta', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/meta')>();
  const produtos = {
    key: 'produtos',
    label: 'Produtos',
    singular: 'Produto',
    labelFields: ['sku', 'nome'],
    ops: { create: true, update: true, delete: true },
    images: { max: 5 },
    fields: [
      { name: 'sku', label: 'SKU / Referência', type: 'text', required: true, section: 'Informações básicas' },
      { name: 'nome', label: 'Nome', type: 'text', required: true, section: 'Informações básicas' },
      { name: 'categoria_id', label: 'Categoria', type: 'ref', ref: 'categorias', section: 'Classificação' },
      { name: 'grade_id', label: 'Grade de tamanhos', type: 'ref', ref: 'grades', section: 'Classificação' },
      { name: 'formato', label: 'Formato', type: 'select', default: 'simples', section: 'Classificação', options: [{ value: 'simples', label: 'Simples' }, { value: 'variacao', label: 'Com variação / grade' }] },
      { name: 'custo', label: 'Custo unitário', type: 'money', default: 0, section: 'Comercial' },
      { name: 'preco_venda', label: 'Preço de venda (varejo)', type: 'money', default: 0, section: 'Varejo e atacado' },
      { name: 'codigo_barras', label: 'Código de barras (EAN)', type: 'text', maxLength: 14, section: 'Identificação e catálogo' },
      { name: 'ncm', label: 'NCM', type: 'text', maxLength: 10, section: 'Fiscal' },
      { name: 'estoque_min', label: 'Estoque mínimo', type: 'integer', default: 0, section: 'Estoque e suprimento' },
      { name: 'estoque_max', label: 'Estoque máximo', type: 'integer', section: 'Estoque e suprimento' },
      { name: 'ativo', label: 'Ativo', type: 'boolean', default: true, section: 'Informações básicas' },
    ],
  };
  return {
    ...actual,
    useMeta: () => ({ resources: { produtos }, modules: [] }),
  };
});

const apiGet = vi.mocked(api.get);
const apiPost = vi.mocked(api.post);
const apiPut = vi.mocked(api.put);

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/produtos/novo']}>
      <ToastProvider>
        <ProdutoFormPage />
      </ToastProvider>
    </MemoryRouter>
  );
}

beforeEach(() => {
  routeParams = {};
  navigateMock.mockReset();
  apiGet.mockReset();
  apiPost.mockReset();
  apiPut.mockReset();
  apiGet.mockImplementation(async (path: string) => {
    if (String(path).endsWith('/options')) return [{ value: 1, label: 'Camisetas' }] as never;
    if (String(path).startsWith('/produtos/') && String(path).endsWith('/variacoes')) {
      return { produto_pai: { id: 1, sku: 'CAM-001', nome: 'Camiseta', formato: 'simples' }, total: 0, variacoes: [] } as never;
    }
    return { id: 7, sku: 'CAM-001', nome: 'Camiseta Polo', fotos: [] } as never;
  });
  apiPost.mockResolvedValue({ id: 99 } as never);
  apiPut.mockResolvedValue({ id: 7 } as never);
});

describe('página de cadastro — estrutura', () => {
  it('abre em /produtos/novo com as seções profissionais e sem modal', async () => {
    renderPage();
    expect(await screen.findByRole('heading', { name: /Informações básicas/i })).toBeTruthy();
    expect(screen.getByRole('heading', { name: /Classificação/i })).toBeTruthy();
    expect(screen.getByRole('heading', { name: /Fiscal/i })).toBeTruthy();
    expect(screen.getByRole('heading', { name: /Estoque e suprimento/i })).toBeTruthy();
    expect(screen.getAllByRole('button', { name: /Salvar produto/i })[0]).toBeTruthy();
  });

  it('marca os campos obrigatórios e associa label ao input', async () => {
    renderPage();
    const sku = await screen.findByLabelText(/SKU \/ Referência/);
    expect(sku.getAttribute('aria-invalid')).toBeNull();
    expect(screen.getByLabelText(/Nome/)).toBeTruthy();
  });

  it('não mostra fotos nem variações antes de salvar (não há id ainda)', () => {
    renderPage();
    expect(screen.queryByRole('heading', { name: /Imagens/i })).toBeNull();
    expect(screen.queryByRole('heading', { name: /Grade e variações/i })).toBeNull();
  });
});

describe('validação sem perder dados', () => {
  it('bloqueia o envio quando falta SKU e nome, mantendo o que foi digitado', async () => {
    renderPage();
    const preco = await screen.findByLabelText(/Preço de venda/);
    fireEvent.change(preco, { target: { value: '1500' } });
    expect((preco as HTMLInputElement).value).toBe('1.500');

    fireEvent.click(screen.getAllByRole('button', { name: /Salvar produto/i })[0]);

    expect(await screen.findByText(/Verifique os campos destacados/)).toBeTruthy();
    expect(apiPost).not.toHaveBeenCalled();
    // O valor digitado continua lá.
    expect((screen.getByLabelText(/Preço de venda/) as HTMLInputElement).value).toBe('1.500');
  });

  it('recusa NCM incompleto com mensagem junto do campo', async () => {
    renderPage();
    const sku = await screen.findByLabelText(/SKU \/ Referência/);
    const nome = screen.getByLabelText(/^Nome/);
    const ncm = screen.getByLabelText(/^NCM/);
    fireEvent.change(sku, { target: { value: 'CAM-001' } });
    fireEvent.change(nome, { target: { value: 'Camiseta Polo' } });
    fireEvent.change(ncm, { target: { value: '6205' } });
    fireEvent.click(screen.getAllByRole('button', { name: /Salvar produto/i })[0]);
    expect(await screen.findByText(/NCM deve ter 8 dígitos/)).toBeTruthy();
    expect(apiPost).not.toHaveBeenCalled();
  });

  it('máscara de NCM pontua o valor ao sair do campo', async () => {
    renderPage();
    const ncm = (await screen.findByLabelText(/^NCM/)) as HTMLInputElement;
    fireEvent.change(ncm, { target: { value: '62052000' } });
    fireEvent.blur(ncm);
    await waitFor(() => expect(ncm.value).toBe('6205.20.00'));
  });
});

describe('criação', () => {
  it('envia o payload normalizado e volta para a lista', async () => {
    renderPage();
    fireEvent.change(await screen.findByLabelText(/SKU \/ Referência/), { target: { value: ' cam-001 ' } });
    fireEvent.change(screen.getByLabelText(/^Nome/), { target: { value: 'Camiseta Polo' } });
    fireEvent.change(screen.getByLabelText(/Código de barras/), { target: { value: '7891234567895' } });
    fireEvent.change(screen.getByLabelText(/Preço de venda/), { target: { value: '89,90' } });

    fireEvent.click(screen.getAllByRole('button', { name: /Salvar produto/i })[0]);

    await waitFor(() => expect(apiPost).toHaveBeenCalledTimes(1));
    const [path, payload] = apiPost.mock.calls[0] as [string, Record<string, unknown>];
    expect(path).toBe('/produtos');
    expect(payload.sku).toBe('cam-001');
    expect(payload.nome).toBe('Camiseta Polo');
    expect(payload.codigo_barras).toBe('7891234567895');
    expect(payload.preco_venda).toBe(89.9);
    expect(payload.formato).toBe('simples');
    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith('/produtos'));
  });

  it('erro do servidor por campo mantém a página e mostra a mensagem', async () => {
    apiPost.mockRejectedValueOnce(new ApiError(409, 'Já existe um registro com este sku.', { sku: 'Já cadastrado' }));
    renderPage();
    fireEvent.change(await screen.findByLabelText(/SKU \/ Referência/), { target: { value: 'CAM-001' } });
    fireEvent.change(screen.getByLabelText(/^Nome/), { target: { value: 'Camiseta Polo' } });
    fireEvent.click(screen.getAllByRole('button', { name: /Salvar produto/i })[0]);

    expect(await screen.findByText(/Já existe um registro com este sku/)).toBeTruthy();
    expect(await screen.findByText('Já cadastrado')).toBeTruthy();
    expect(navigateMock).not.toHaveBeenCalled();
    expect((screen.getByLabelText(/SKU \/ Referência/) as HTMLInputElement).value).toBe('CAM-001');
  });
});

describe('edição', () => {
  it('carrega o produto, mostra fotos/variações e salva via PUT', async () => {
    routeParams = { id: '7' };
    renderPage();
    const sku = (await screen.findByLabelText(/SKU \/ Referência/)) as HTMLInputElement;
    await waitFor(() => expect(sku.value).toBe('CAM-001'));
    expect(screen.getByRole('heading', { name: /Imagens/i })).toBeTruthy();
    expect(screen.getByRole('heading', { name: /Grade e variações/i })).toBeTruthy();
    expect(screen.getAllByRole('button', { name: /Salvar alterações/i })[0]).toBeTruthy();

    fireEvent.change(sku, { target: { value: 'CAM-002' } });
    fireEvent.click(screen.getAllByRole('button', { name: /Salvar alterações/i })[0]);
    await waitFor(() => expect(apiPut).toHaveBeenCalledTimes(1));
    expect((apiPut.mock.calls[0] as unknown[])[0]).toBe('/produtos/7');
  });
});
