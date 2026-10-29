// ============================================================================
// COMMERCE — /commerce/devoluções: lista as devoluções do ERP CANÔNICO
// (recurso `devolucoes`) e navega para a venda original. NÃO cria um segundo
// financeiro. ZERO MODAL.
// ============================================================================
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { ToastProvider } from '../../components/ui';
import CommerceDevolucoesPage from './DevolucoesPage';

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

import { apiFetch } from '../../lib/api';
const fetchMock = vi.mocked(apiFetch);

const DEVOLUCAO = {
  id: 3,
  numero: 'DEV-0003',
  venda_id: 55,
  cliente_id: 12,
  status: 'autorizada',
  tipo: 'troca',
  motivo: 'Tamanho errado',
  atualizado_em: '2026-10-22T08:00:00.000Z',
  criado_em: '2026-10-21T08:00:00.000Z',
};

function renderPagina(rota = '/commerce/devolucoes') {
  return render(
    <ToastProvider>
      <MemoryRouter initialEntries={[rota]}>
        <Routes>
          <Route path="/commerce/devolucoes" element={<CommerceDevolucoesPage />} />
          <Route path="/vendas/:id" element={<div>rota-venda-55</div>} />
          <Route path="/devolucoes" element={<div>rota-erp-devolucoes</div>} />
        </Routes>
      </MemoryRouter>
    </ToastProvider>
  );
}

describe('Commerce — Devoluções (/commerce/devolucoes)', () => {
  beforeEach(() => {
    fetchMock.mockReset();
  });

  it('lista devoluções do ERP canônico com vínculo à venda', async () => {
    fetchMock.mockResolvedValue({ total: 1, rows: [DEVOLUCAO], page: 1, pageSize: 100 });
    renderPagina();
    expect(await screen.findByText('DEV-0003')).toBeInTheDocument();
    expect(screen.getAllByText('Autorizada').length).toBeGreaterThan(0);
    expect(screen.getByText('Tamanho errado')).toBeInTheDocument();
    expect(String(fetchMock.mock.calls[0][0])).toContain('/devolucoes');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('filtro de status usa o contrato real da rota genérica (?f.status=), não filter.status', async () => {
    fetchMock.mockResolvedValue({ total: 1, rows: [DEVOLUCAO], page: 1, pageSize: 100 });
    renderPagina();
    await screen.findByText('DEV-0003');
    fireEvent.change(screen.getByLabelText(/Status/), { target: { value: 'autorizada' } });
    await waitFor(() => {
      const urls = fetchMock.mock.calls.map((c) => String(c[0]));
      expect(urls.some((u) => u.includes('f.status=autorizada'))).toBe(true);
      expect(urls.some((u) => u.includes('filter.status'))).toBe(false);
    });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('navega para a venda ERP original e para a tela canônica de devoluções', async () => {
    fetchMock.mockResolvedValue({ total: 1, rows: [DEVOLUCAO], page: 1, pageSize: 100 });
    renderPagina();
    await screen.findByText('DEV-0003');
    const vendaLink = screen.getByText('Venda #55').closest('a');
    expect(vendaLink).toHaveAttribute('href', '/vendas/55');
    const erpLink = screen.getByText('Abrir no ERP').closest('a');
    expect(erpLink).toHaveAttribute('href', '/devolucoes');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('estado vazio é honesto', async () => {
    fetchMock.mockResolvedValue({ total: 0, rows: [], page: 1, pageSize: 100 });
    renderPagina();
    expect(await screen.findByText('Nenhuma devolução')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
