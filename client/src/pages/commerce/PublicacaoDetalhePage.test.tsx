// ============================================================================
// COMMERCE — /commerce/publicacoes/:id: detalhe REAL da fila com reprocessar
// e despublicar (confirmação inline). ZERO MODAL.
// ============================================================================
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { ToastProvider } from '../../components/ui';
import CommercePublicacaoDetalhePage from './PublicacaoDetalhePage';

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
  publicacao: {
    id: 2,
    produto_id: 7,
    canal: 'MERCADOLIVRE',
    versao: 3,
    estado: 'ERROR',
    external_id: null,
    tentativas: 4,
    ultimo_erro: 'Credencial ML inválida',
    proxima_tentativa_em: '2026-10-29T10:00:00.000Z',
    publicado_em: null,
    atualizado_em: '2026-10-28T11:00:00.000Z',
  },
  produto: { id: 7, sku: 'SKU-7', nome: 'Camiseta Brobond', preco_base: 89.9, na_vitrine: true },
  preco: { preco: 120, promo: null, origem: 'canal', linha: { preco: 120, preco_promo: null, vigencia_inicio: null, vigencia_fim: null } },
  metadados: { ml_category_id: 'MLB123' },
};

function renderPagina(rota = '/commerce/publicacoes/2') {
  return render(
    <ToastProvider>
      <MemoryRouter initialEntries={[rota]}>
        <Routes>
          <Route path="/commerce/publicacoes/:id" element={<CommercePublicacaoDetalhePage />} />
          <Route path="/commerce/publicacoes/:id/editar" element={<div>rota-editar</div>} />
          <Route path="/commerce/publicacoes" element={<div>rota-fila</div>} />
          <Route path="/commerce/produtos/:id" element={<div>rota-produto</div>} />
          <Route path="/commerce/eventos" element={<div>rota-eventos</div>} />
        </Routes>
      </MemoryRouter>
    </ToastProvider>
  );
}

describe('Commerce — Detalhe da publicação (/commerce/publicacoes/:id)', () => {
  beforeEach(() => {
    fetchMock.mockReset();
  });

  it('renderiza o detalhe REAL: estado, versão, erro do canal, preço e metadados', async () => {
    fetchMock.mockResolvedValue(DETALHE);
    renderPagina();
    expect(await screen.findByText('Credencial ML inválida')).toBeInTheDocument();
    expect(screen.getByText(/Fila de publicação v3/)).toBeInTheDocument();
    expect(screen.getAllByText('R$ 120,00').length).toBeGreaterThan(0);
    expect(screen.getAllByText(/ml_category_id/).length).toBeGreaterThan(0);
    expect(String(fetchMock.mock.calls[0][0])).toContain('/commerce/publicacoes/2');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('reprocessar chama o POST da fila e recarrega', async () => {
    fetchMock.mockResolvedValue(DETALHE);
    renderPagina();
    await screen.findByText('Credencial ML inválida');
    fetchMock.mockClear();
    fetchMock.mockImplementation(async (path: string) =>
      String(path).includes('reprocessar') ? { ok: true, publicacao: { ...DETALHE.publicacao, estado: 'QUEUED' } } : DETALHE
    );
    await userEvent.click(screen.getByRole('button', { name: /Reprocessar/ }));
    await vi.waitFor(() => {
      expect(fetchMock.mock.calls.some(([p, o]) => String(p).includes('/commerce/publicacoes/2/reprocessar') && o?.method === 'POST')).toBe(true);
    });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('despublicar (BROBOND) usa confirmação INLINE — nunca modal', async () => {
    const publicado = {
      ...DETALHE,
      publicacao: { ...DETALHE.publicacao, canal: 'BROBOND', estado: 'PUBLISHED', external_id: 'slug-camiseta' },
      preco: { preco: 89.9, promo: null, origem: 'base', linha: null },
    };
    fetchMock.mockResolvedValue(publicado);
    renderPagina();
    await screen.findByText('Camiseta Brobond');
    await userEvent.click(screen.getByRole('button', { name: /Despublicar da vitrine/ }));
    expect(screen.queryByRole('dialog')).toBeNull();
    fetchMock.mockClear();
    fetchMock.mockImplementation(async (path: string) =>
      String(path).includes('despublicar') ? { ok: true } : publicado
    );
    await userEvent.click(screen.getByRole('button', { name: 'Despublicar' }));
    await vi.waitFor(() => {
      expect(fetchMock.mock.calls.some(([p, o]) => String(p).includes('/commerce/produtos/7/despublicar') && o?.method === 'POST')).toBe(true);
    });
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
