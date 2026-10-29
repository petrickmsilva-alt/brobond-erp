// ============================================================================
// COMMERCE — /commerce/produtos/:id (detalhe: projeção, preço por canal,
// publicações e disponibilidade do motor canônico).
// Contrato: ZERO MODAL (edições inline em SEÇÕES da própria rota), preço por
// canal editado AQUI (capacidade commerce-precos), sem dado fake.
// ============================================================================
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { ToastProvider } from '../../components/ui';
import CommerceProdutoDetalhePage from './ProdutoDetalhePage';

vi.mock('../../lib/api', () => ({
  apiFetch: vi.fn(),
  ApiError: class ApiError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.name = 'ApiError';
      this.status = status;
    }
  },
}));
vi.mock('../../auth/AuthContext', () => ({
  useAuth: () => ({ user: { id: 1, name: 'Gerente Teste', perfil: 'admin' } }),
}));

import { apiFetch, ApiError } from '../../lib/api';
const fetchMock = vi.mocked(apiFetch);

const DETALHE = {
  produto: { id: 7, sku: 'CAM-001', nome: 'Camiseta Brobond', descricao: 'Malha penteada', ativo: true, preco_base: 89.9, foto_url: null, fotos: [] },
  projecao: { id: 3, slug: 'camiseta-brobond', resumo: 'Camiseta oficial', ordem: 10, canal_metadados: {} },
  precos: [{ canal: 'MERCADOLIVRE', preco: 99.9, preco_promo: 94.9, vigencia_inicio: null, vigencia_fim: null }],
  publicacoes: [
    { id: 44, canal: 'BROBOND', versao: 2, estado: 'PUBLISHED', external_id: 'camiseta-brobond', tentativas: 1, ultimo_erro: null, proxima_tentativa_em: null, publicado_em: '2026-10-20T12:00:00Z', atualizado_em: '2026-10-20T12:00:00Z' },
    { id: 45, canal: 'WOOCOMMERCE', versao: 1, estado: 'ERROR', external_id: null, tentativas: 3, ultimo_erro: 'WooCommerce não configurado', proxima_tentativa_em: '2026-10-29T12:00:00Z', publicado_em: null, atualizado_em: '2026-10-28T10:00:00Z' },
  ],
  disponibilidade: [{ tamanho_id: 4, codigo: 'U', fisico: 15, disponivel: 12, local: 'loja' }],
};

function renderPagina(rota = '/commerce/produtos/7') {
  return render(
    <ToastProvider>
      <MemoryRouter initialEntries={[rota]}>
        <Routes>
          <Route path="/commerce/produtos/:id" element={<CommerceProdutoDetalhePage />} />
        </Routes>
      </MemoryRouter>
    </ToastProvider>
  );
}

describe('Commerce — Detalhe do produto (/commerce/produtos/:id)', () => {
  beforeEach(() => {
    fetchMock.mockReset();
  });

  it('carrega e exibe projeção, preço por canal, publicações e disponibilidade real', async () => {
    fetchMock.mockResolvedValue(DETALHE);
    renderPagina();
    expect(await screen.findByText('Camiseta Brobond')).toBeInTheDocument();
    expect(screen.getByText('camiseta-brobond')).toBeInTheDocument();
    expect((await screen.findAllByText('Mercado Livre')).length).toBeGreaterThan(0);
    expect((await screen.findAllByText('WooCommerce')).length).toBeGreaterThan(0);
    expect(screen.getByText(/WooCommerce não configurado/)).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('edição da projeção salva via PUT na própria rota (ZERO MODAL)', async () => {
    fetchMock.mockImplementation(async (caminho: string, init?: RequestInit) => {
      if (init?.method === 'PUT') return { ok: true };
      return DETALHE;
    });
    const user = userEvent.setup();
    renderPagina();
    await screen.findByText('Camiseta Brobond');
    const botoes = screen.getAllByRole('button');
    const salvar = botoes.find((b) => /salvar conte[uú]do|salvar/i.test(b.textContent ?? ''));
    expect(salvar).toBeTruthy();
    await user.click(salvar!);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/commerce/produtos/7', expect.objectContaining({ method: 'PUT' })));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('erro da API vira Alert honesto (nada renderizado por baixo)', async () => {
    fetchMock.mockImplementation(async () => { throw new ApiError(404, 'Produto não encontrado.'); });
    renderPagina();
    expect(await screen.findByText('Produto não encontrado.')).toBeInTheDocument();
  });
});
