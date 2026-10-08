// Seletor de empresa ativa — contrato com GET/POST /api/empresas/ativa.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import CompanySwitcher from './CompanySwitcher';
import { ToastProvider } from './ui';
import { api, ApiError, setToken } from '../lib/api';

vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<typeof import('../lib/api')>('../lib/api');
  return { ...actual, api: { get: vi.fn(), post: vi.fn() }, setToken: vi.fn() };
});

const apiGet = vi.mocked(api.get);
const apiPost = vi.mocked(api.post);

const DUAS_EMPRESAS = {
  empresa_id: 1,
  empresa: 'BroBond Wear',
  consolidado: false,
  pode_consolidar: false,
  empresa_padrao: 1,
  empresas: [
    { id: 1, nome: 'BroBond Wear', cnpj: null, ativa: true },
    { id: 2, nome: 'BroBond Outlet', cnpj: '00.000.000/0001-00', ativa: false },
  ],
};

function renderSwitcher(onChange = vi.fn()) {
  render(
    <ToastProvider>
      <CompanySwitcher onChange={onChange} />
    </ToastProvider>,
  );
  return onChange;
}

describe('CompanySwitcher', () => {
  beforeEach(() => {
    apiGet.mockReset();
    apiPost.mockReset();
    vi.mocked(setToken).mockReset();
  });

  it('mostra a empresa ativa sem seletor quando há só uma empresa', async () => {
    apiGet.mockResolvedValue({ ...DUAS_EMPRESAS, empresas: [DUAS_EMPRESAS.empresas[0]] });
    renderSwitcher();
    expect(await screen.findByLabelText('Empresa ativa: BroBond Wear')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /trocar empresa/i })).not.toBeInTheDocument();
  });

  it('não exibe nada quando a API de empresas falha (sem inventar nome)', async () => {
    apiGet.mockRejectedValue(new Error('offline'));
    const { container } = render(
      <ToastProvider>
        <CompanySwitcher onChange={vi.fn()} />
      </ToastProvider>,
    );
    await waitFor(() => expect(apiGet).toHaveBeenCalled());
    expect(container.querySelector('button, [aria-label]')).toBeNull();
  });

  it('troca a empresa pelo contrato existente, grava o novo token e avisa o Layout', async () => {
    apiGet.mockResolvedValue(DUAS_EMPRESAS);
    apiPost.mockResolvedValue({ ok: true, token: 'novo-token', empresa_id: 2, empresa: 'BroBond Outlet' });
    const onChange = renderSwitcher();

    await userEvent.click(await screen.findByRole('button', { name: /trocar empresa/i }));
    await userEvent.click(screen.getByRole('button', { name: /BroBond Outlet/ }));

    expect(apiPost).toHaveBeenCalledWith('/empresas/ativa', { empresa_id: 2 });
    expect(setToken).toHaveBeenCalledWith('novo-token');
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('mostra a mensagem do servidor quando a troca é recusada e não troca o token', async () => {
    apiGet.mockResolvedValue(DUAS_EMPRESAS);
    apiPost.mockRejectedValue(new ApiError(403, 'Você não tem acesso a esta empresa.'));
    const onChange = renderSwitcher();

    await userEvent.click(await screen.findByRole('button', { name: /trocar empresa/i }));
    await userEvent.click(screen.getByRole('button', { name: /BroBond Outlet/ }));

    expect(await screen.findByText('Você não tem acesso a esta empresa.')).toBeInTheDocument();
    expect(setToken).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
  });
});
