// ============================================================================
// COMMERCE — /commerce/cupons/novo|:id (formulário em ROTA PRÓPRRIA).
// Contrato: validação de código EXETA na frente (2–40 [A-Z0-9_-]) sem chamada
// de rede, criação por POST, navegação de volta — ZERO MODAL.
// ============================================================================
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { ToastProvider } from '../../components/ui';
import CommerceCupomFormPage from './CupomFormPage';

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

function renderPagina(rota = '/commerce/cupons/novo') {
  return render(
    <ToastProvider>
      <MemoryRouter initialEntries={[rota]}>
        <Routes>
          <Route path="/commerce/cupons/novo" element={<CommerceCupomFormPage />} />
          <Route path="/commerce/cupons/:id" element={<CommerceCupomFormPage />} />
          <Route path="/commerce/cupons" element={<div>rota-lista-cupons</div>} />
        </Routes>
      </MemoryRouter>
    </ToastProvider>
  );
}

function preencherCriacao() {
  const codigo = screen.getByPlaceholderText('EX.: BEMVINDO10');
  fireEvent.change(codigo, { target: { value: 'FRETEGRATIS' } });
  const obrigatorios = Array.from(document.querySelectorAll<HTMLInputElement>('input[required]')).filter(
    (i) => i !== codigo
  );
  fireEvent.change(obrigatorios[0], { target: { value: '20' } }); // valor
}

describe('Commerce — Formulário de cupom (/commerce/cupons/novo)', () => {
  beforeEach(() => {
    fetchMock.mockReset();
  });

  it('cria via POST e volta para a lista — rota própria, ZERO MODAL', async () => {
    fetchMock.mockResolvedValue({ ok: true });
    const user = userEvent.setup();
    renderPagina();
    await screen.findByPlaceholderText('EX.: BEMVINDO10');
    expect(screen.queryByRole('dialog')).toBeNull();
    preencherCriacao();
    await user.click(screen.getByRole('button', { name: /salvar/i }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/commerce/cupons', expect.objectContaining({ method: 'POST' })));
    expect(await screen.findByText('rota-lista-cupons')).toBeInTheDocument();
  });

  it('código inválido é bloqueado na frente (sem rede, sem modal)', async () => {
    fetchMock.mockClear();
    const user = userEvent.setup();
    renderPagina();
    await screen.findByPlaceholderText('EX.: BEMVINDO10');
    const codigo = screen.getByPlaceholderText('EX.: BEMVINDO10');
    fireEvent.change(codigo, { target: { value: '!!' } });
    const obrigatorios = Array.from(document.querySelectorAll<HTMLInputElement>('input[required]')).filter(
      (i) => i !== codigo
    );
    fireEvent.change(obrigatorios[0], { target: { value: '20' } });
    await user.click(screen.getByRole('button', { name: /salvar/i }));
    expect(await screen.findByText(/Código inválido/)).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
