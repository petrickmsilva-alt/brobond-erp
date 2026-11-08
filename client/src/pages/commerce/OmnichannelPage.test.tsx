// ============================================================================
// COMMERCE & OMNICHANNEL (FASE 6) — /commerce/omnichannel.
// Painel multicanal: divergências reais, saúde dos conectores e reconciliação
// com confirmação inline (ZERO MODAL).
// ============================================================================
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { ToastProvider } from '../../components/ui';
import CommerceOmnichannelPage from './OmnichannelPage';

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

const PAINEL = {
  empresa_id: 1,
  filtros: { canal: null, categoria: null, severidade: null },
  totais: { abertas: 2, por_categoria: { CATALOGO: 1, PRECO: 0, ESTOQUE: 1, PEDIDOS: 0 }, por_canal: { MERCADOLIVRE: 1 }, por_severidade: { alta: 1, baixa: 1 } },
  divergencias: [
    {
      id: 11, canal: 'MERCADOLIVRE', store_key: null, categoria: 'CATALOGO', tipo: 'publicacao_rejeitada',
      classificacao: 'HUMANA', severidade: 'alta', produto_id: 7, sku: 'SKU-7', referencia: '2',
      detalhe: 'Publicação rejeitada pelo canal MERCADOLIVRE.', acao_recomendada: 'Revisar o payload e corrigir.', detectada_em: '2026-10-28T11:00:00.000Z',
    },
    {
      id: 12, canal: 'BROBOND', store_key: null, categoria: 'ESTOQUE', tipo: 'estoque_zerado_publicado',
      classificacao: 'LEGITIMA', severidade: 'baixa', produto_id: 7, sku: 'SKU-7', referencia: null,
      detalhe: 'Produto publicado no canal BROBOND com estoque disponível zerado.', acao_recomendada: 'Repor estoque ou despublicar.', detectada_em: '2026-10-28T11:00:00.000Z',
    },
  ],
  woocommerce_lojas: [{ store_key: 'RETAIL', abertas: 1, por_categoria: { ESTOQUE: 1 } }],
  saude_conectores: [
    { canal: 'MERCADOLIVRE', divergencias_abertas: 1, pior_severidade: 'alta', outbox_pendente: 0, outbox_erro: 0, ultimo_erro: null },
    { canal: 'BROBOND', divergencias_abertas: 1, pior_severidade: 'baixa', outbox_pendente: 2, outbox_erro: 1, ultimo_erro: 'gateway 502' },
  ],
  gerado_em: '2026-10-28T12:00:00.000Z',
};

function renderPagina() {
  return render(
    <ToastProvider>
      <MemoryRouter initialEntries={['/commerce/omnichannel']}>
        <Routes>
          <Route path="/commerce/omnichannel" element={<CommerceOmnichannelPage />} />
          <Route path="/commerce/produtos/:id" element={<div>rota-produto</div>} />
        </Routes>
      </MemoryRouter>
    </ToastProvider>
  );
}

describe('Commerce — Omnichannel (/commerce/omnichannel)', () => {
  beforeEach(() => {
    fetchMock.mockReset();
  });

  it('renderiza as divergências REAIS e a saúde dos conectores', async () => {
    fetchMock.mockResolvedValue(PAINEL);
    renderPagina();
    expect(await screen.findByText('Publicação rejeitada pelo canal MERCADOLIVRE.')).toBeInTheDocument();
    expect(screen.getByText('Produto publicado no canal BROBOND com estoque disponível zerado.')).toBeInTheDocument();
    expect(screen.getByText('gateway 502')).toBeInTheDocument();
    expect(fetchMock.mock.calls[0][0]).toContain('/commerce/omnichannel/painel');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('reconcilia com confirmação inline (nunca modal)', async () => {
    fetchMock.mockImplementation(async (path: string) => {
      if (String(path).includes('/painel')) return PAINEL;
      return { detectadas: 2, abertas: 0, reabertas: 0, fechadas: 1 };
    });
    renderPagina();
    await screen.findByText('Publicação rejeitada pelo canal MERCADOLIVRE.');
    await userEvent.click(screen.getByRole('button', { name: /Reconciliar agora/ }));
    expect(screen.queryByRole('dialog')).toBeNull();
    const confirmar = await screen.findByRole('button', { name: 'Confirmar reconciliação' });
    await userEvent.click(confirmar);
    await vi.waitFor(() => {
      expect(fetchMock.mock.calls.some(([p, o]) => String(p).includes('/commerce/omnichannel/reconciliar') && o?.method === 'POST')).toBe(true);
    });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('estado vazio é honesto: sem divergências abertas', async () => {
    fetchMock.mockResolvedValue({ ...PAINEL, totais: { abertas: 0, por_categoria: {}, por_canal: {}, por_severidade: {} }, divergencias: [], woocommerce_lojas: [] });
    renderPagina();
    expect(await screen.findByText('Sem divergências abertas')).toBeInTheDocument();
  });
});
