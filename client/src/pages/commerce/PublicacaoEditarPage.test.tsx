// ============================================================================
// COMMERCE — /commerce/publicacoes/:id/editar: EDITAR → SALVAR (preço do canal
// + metadados) com contrato real de PUT. ZERO MODAL.
// ============================================================================
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { ToastProvider } from '../../components/ui';
import CommercePublicacaoEditarPage from './PublicacaoEditarPage';

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
vi.mock('../../auth/AuthContext', () => ({ useAuth: () => ({ user: { id: 1, perfil: 'gerente' } }) }));

import { apiFetch } from '../../lib/api';
const fetchMock = vi.mocked(apiFetch);

const DETALHE = {
  publicacao: { id: 2, produto_id: 7, canal: 'MERCADOLIVRE', versao: 3, estado: 'ERROR' },
  produto: { id: 7, sku: 'SKU-7', nome: 'Camiseta Brobond', preco_base: 89.9 },
  preco: { linha: { preco: 120, preco_promo: null, vigencia_inicio: null, vigencia_fim: null } },
  metadados: { ml_category_id: 'MLB123' },
};

function renderPagina(rota = '/commerce/publicacoes/2/editar') {
  return render(
    <ToastProvider>
      <MemoryRouter initialEntries={[rota]}>
        <Routes>
          <Route path="/commerce/publicacoes/:id/editar" element={<CommercePublicacaoEditarPage />} />
          <Route path="/commerce/publicacoes/:id" element={<div>rota-detalhe</div>} />
        </Routes>
      </MemoryRouter>
    </ToastProvider>
  );
}

describe('Commerce — Editar publicação (/commerce/publicacoes/:id/editar)', () => {
  beforeEach(() => {
    fetchMock.mockReset();
  });

  it('carrega o detalhe REAL e preenche preço/vigência/metadados', async () => {
    fetchMock.mockResolvedValue(DETALHE);
    renderPagina();
    expect(await screen.findByDisplayValue('120')).toBeInTheDocument();
    expect(screen.getByDisplayValue(/ml_category_id/)).toBeInTheDocument();
    expect(String(fetchMock.mock.calls[0][0])).toContain('/commerce/publicacoes/2');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('SALVAR grava preço via PUT /produtos/:id/precos + metadados via PUT /produtos/:id', async () => {
    fetchMock.mockResolvedValue(DETALHE);
    renderPagina();
    await screen.findByDisplayValue('120');
    fetchMock.mockClear();
    fetchMock.mockResolvedValue({ ok: true });
    const precoInput = screen.getByDisplayValue('120');
    await userEvent.clear(precoInput);
    await userEvent.type(precoInput, '139.9');
    await userEvent.click(screen.getByRole('button', { name: /^Salvar$/ }));
    await vi.waitFor(() => {
      const precos = fetchMock.mock.calls.find(([p, o]) => p === '/commerce/produtos/7/precos' && o?.method === 'PUT');
      const vitrine = fetchMock.mock.calls.find(([p, o]) => p === '/commerce/produtos/7' && o?.method === 'PUT');
      expect(precos).toBeTruthy();
      expect(String(precos![1]?.body)).toContain('"canal":"MERCADOLIVRE"');
      expect(String(precos![1]?.body)).toContain('"preco":139.9');
      expect(vitrine).toBeTruthy();
      expect(String(vitrine![1]?.body)).toContain('canal_metadados');
    });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('bloqueia preço promocional maior/equal ao preço (validação antes do PUT)', async () => {
    fetchMock.mockResolvedValue(DETALHE);
    renderPagina();
    await screen.findByDisplayValue('120');
    const promo = screen.getByLabelText(/Preço promocional/);
    await userEvent.type(promo, '150');
    fetchMock.mockClear();
    await userEvent.click(screen.getByRole('button', { name: /^Salvar$/ }));
    expect(await screen.findByText('O preço promocional precisa ser menor que o preço do canal.')).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([, o]) => o?.method === 'PUT')).toBe(false);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('"Salvar e reprocessar" também chama o retry da fila', async () => {
    fetchMock.mockResolvedValue(DETALHE);
    renderPagina();
    await screen.findByDisplayValue('120');
    fetchMock.mockClear();
    fetchMock.mockResolvedValue({ ok: true });
    await userEvent.click(screen.getByRole('button', { name: /Salvar e reprocessar/ }));
    await vi.waitFor(() => {
      expect(fetchMock.mock.calls.some(([p, o]) => String(p).includes('/commerce/publicacoes/2/reprocessar') && o?.method === 'POST')).toBe(true);
    });
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
