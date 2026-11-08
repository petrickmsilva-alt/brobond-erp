// ============================================================================
// COMMERCE — /commerce/promocoes/nova|:id (formulário em ROTA PRÓPIRA).
// Contrato: ZERO MODAL — criação/edição acontecem na rota; validação honesta
// (percentual ≤ 100) sem tocar na API; sucesso navega de volta para a lista.
// ============================================================================
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { ToastProvider } from '../../components/ui';
import CommercePromocaoFormPage from './PromocaoFormPage';

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
vi.mock('../../auth/AuthContext', () => ({ useAuth: () => ({ user: { id: 1, perfil: 'admin' } }) }));

import { apiFetch } from '../../lib/api';
const fetchMock = vi.mocked(apiFetch);

function renderPagina(rota = '/commerce/promocoes/nova') {
  return render(
    <ToastProvider>
      <MemoryRouter initialEntries={[rota]}>
        <Routes>
          <Route path="/commerce/promocoes/nova" element={<CommercePromocaoFormPage />} />
          <Route path="/commerce/promocoes/:id" element={<CommercePromocaoFormPage />} />
          <Route path="/commerce/promocoes" element={<div>rota-lista-promocoes</div>} />
        </Routes>
      </MemoryRouter>
    </ToastProvider>
  );
}

function preencherCriacao() {
  const obrigatorios = document.querySelectorAll<HTMLInputElement>('input[required]');
  expect(obrigatorios.length).toBeGreaterThanOrEqual(3);
  fireEvent.change(obrigatorios[0], { target: { value: 'Black Friday Brobond' } }); // nome
  fireEvent.change(obrigatorios[1], { target: { value: '15' } }); // valor
  fireEvent.change(obrigatorios[2], { target: { value: '2026-11-01' } }); // data_inicio
}

describe('Commerce — Formulário de promoção (/commerce/promocoes/nova)', () => {
  beforeEach(() => {
    fetchMock.mockReset();
  });

  it('cria via POST e navega de volta para a lista — rota própria, ZERO MODAL', async () => {
    fetchMock.mockResolvedValue({ ok: true });
    const user = userEvent.setup();
    renderPagina();
    await screen.findByPlaceholderText('Ex.: Volta às aulas');
    expect(screen.queryByRole('dialog')).toBeNull();
    preencherCriacao();
    await user.click(screen.getByRole('button', { name: /salvar/i }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/commerce/promocoes', expect.objectContaining({ method: 'POST' })));
    expect(await screen.findByText('rota-lista-promocoes')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('validação de percentual > 100 falha ANTES da API (erro honesto, sem modal)', async () => {
    fetchMock.mockClear();
    const user = userEvent.setup();
    renderPagina();
    await screen.findByPlaceholderText('Ex.: Volta às aulas');
    preencherCriacao();
    const obrigatorios = document.querySelectorAll<HTMLInputElement>('input[required]');
    fireEvent.change(obrigatorios[1], { target: { value: '150' } });
    await user.click(screen.getByRole('button', { name: /salvar/i }));
    expect(await screen.findByText(/100%/)).toBeInTheDocument();
    expect(fetchMock.mock.calls.some((c) => c[0] === '/commerce/promocoes')).toBe(false);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('escopo produto exige alvo e envia escopo+produtos ao criar (0108)', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.startsWith('/categorias/options')) return [];
      if (url.startsWith('/commerce/produtos')) return { produtos: [{ id: 7, sku: 'S7', nome: 'Camiseta Alvo' }] };
      return { ok: true };
    });
    const user = userEvent.setup();
    renderPagina();
    await screen.findByPlaceholderText('Ex.: Volta às aulas');
    preencherCriacao();

    await user.selectOptions(screen.getByLabelText(/escopo/i), 'produto');
    await user.click(screen.getByRole('button', { name: /salvar/i }));
    expect(await screen.findByText(/ao menos um produto/i)).toBeInTheDocument();

    await user.type(screen.getByPlaceholderText(/buscar produto/i), 'camiseta');
    const alvo = await screen.findByRole('button', { name: /camiseta alvo/i });
    await user.click(alvo);

    await user.click(screen.getByRole('button', { name: /salvar/i }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/commerce/promocoes', expect.objectContaining({ method: 'POST' })));
    const chamada = fetchMock.mock.calls.find((c) => c[0] === '/commerce/promocoes' && (c[1] as { method?: string })?.method === 'POST');
    const corpo = JSON.parse(String((chamada?.[1] as { body?: string })?.body));
    expect(corpo.escopo).toBe('produto');
    expect(corpo.produtos).toEqual([7]);
    expect(corpo.categorias).toEqual([]);
  });
});
