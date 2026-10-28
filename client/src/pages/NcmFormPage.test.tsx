// ============================================================================
// NCM — cadastro/edição em PÁGINA (ZERO MODAL)
//
// O que estes testes travam:
//   • a página lê a lista canônica do servidor e encontra o registro a editar;
//   • a chave é enviada só com dígitos e a alíquota como número (7,5 → 7.5);
//   • alíquota fora de 0–100 é recusada ANTES de chamar a API;
//   • registro inexistente diz isso na tela (não abre formulário vazio);
//   • operador não escreve (o servidor exige gerente) e a página explica.
// ============================================================================
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import NcmFormPage from './NcmFormPage';
import { ToastProvider } from '../components/ui';
import { api } from '../lib/api';

vi.mock('../lib/api', () => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), del: vi.fn() },
  ApiError: class ApiError extends Error {
    status: number;
    fields?: Record<string, string>;
    constructor(status: number, message: string, fields?: Record<string, string>) {
      super(message);
      this.name = 'ApiError';
      this.status = status;
      this.fields = fields;
    }
  },
}));

const mockUser: { perfil: 'admin' | 'gerente' | 'operador' } = { perfil: 'gerente' };
vi.mock('../auth/AuthContext', () => ({ useAuth: () => ({ user: mockUser }) }));

const apiGet = vi.mocked(api.get);
const apiPost = vi.mocked(api.post);
const apiPut = vi.mocked(api.put);

const LINHAS = {
  rows: [
    { id: 7, ncm: null, descricao: 'Padrão da casa', aliquota_pct: 5 },
    { id: 2, ncm: '6109', descricao: 'Malha (prefixo)', aliquota_pct: 8.5 },
  ],
};

function montar(rota = '/ncm/novo') {
  return render(
    <MemoryRouter initialEntries={[rota]}>
      <ToastProvider>
        <Routes>
          <Route path="/ncm/novo" element={<NcmFormPage modo="novo" />} />
          <Route path="/ncm/:id/editar" element={<NcmFormPage modo="editar" />} />
          <Route path="/ncm" element={<div>LISTA NCM</div>} />
        </Routes>
      </ToastProvider>
    </MemoryRouter>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockUser.perfil = 'gerente';
  apiGet.mockResolvedValue(LINHAS);
});

describe('NcmFormPage', () => {
  it('é uma PÁGINA: o formulário aparece com as três entradas e sem sobreposição', async () => {
    montar();
    expect(await screen.findByText('Nova alíquota por NCM')).toBeInTheDocument();
    expect(screen.getByLabelText(/NCM \(chave\)/)).toBeInTheDocument();
    expect(screen.getByLabelText('Alíquota (%)')).toBeInTheDocument();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it('cadastra enviando a chave só com dígitos e a alíquota numérica', async () => {
    apiPost.mockResolvedValue({ id: 9 });
    montar();
    fireEvent.change(await screen.findByLabelText(/NCM \(chave\)/), { target: { value: '6109-10' } });
    fireEvent.change(screen.getByLabelText('Alíquota (%)'), { target: { value: '7,5' } });
    fireEvent.click(screen.getByRole('button', { name: /^Salvar$/ }));
    await waitFor(() => expect(apiPost).toHaveBeenCalledWith('/impostos_ncm', { ncm: '610910', descricao: null, aliquota_pct: 7.5 }));
    expect(await screen.findByText('LISTA NCM')).toBeInTheDocument();
  });

  it('recusa alíquota fora de 0–100 sem chamar a API', async () => {
    montar();
    fireEvent.change(await screen.findByLabelText('Alíquota (%)'), { target: { value: '150' } });
    fireEvent.click(screen.getByRole('button', { name: /^Salvar$/ }));
    expect(await screen.findByText('Informe uma alíquota entre 0 e 100.')).toBeInTheDocument();
    expect(apiPost).not.toHaveBeenCalled();
  });

  it('recusa chave com menos de 2 dígitos', async () => {
    montar();
    fireEvent.change(await screen.findByLabelText(/NCM \(chave\)/), { target: { value: '6' } });
    fireEvent.change(screen.getByLabelText('Alíquota (%)'), { target: { value: '12' } });
    fireEvent.click(screen.getByRole('button', { name: /^Salvar$/ }));
    expect(await screen.findByText(/Use apenas dígitos \(2 a 8\)/)).toBeInTheDocument();
    expect(apiPost).not.toHaveBeenCalled();
  });

  it('edita o registro certo com PUT e volta para a lista', async () => {
    apiPut.mockResolvedValue({ id: 2 });
    montar('/ncm/2/editar');
    expect(await screen.findByText('Editar alíquota por NCM')).toBeInTheDocument();
    await waitFor(() => expect((screen.getByLabelText(/NCM \(chave\)/) as HTMLInputElement).value).toBe('6109'));
    fireEvent.change(screen.getByLabelText('Alíquota (%)'), { target: { value: '9' } });
    fireEvent.click(screen.getByRole('button', { name: /^Salvar$/ }));
    await waitFor(() =>
      expect(apiPut).toHaveBeenCalledWith('/impostos_ncm/2', { ncm: '6109', descricao: 'Malha (prefixo)', aliquota_pct: 9 })
    );
    expect(await screen.findByText('LISTA NCM')).toBeInTheDocument();
  });

  it('registro inexistente é dito na tela', async () => {
    montar('/ncm/999/editar');
    expect(await screen.findByText('Alíquota não encontrada nesta empresa.')).toBeInTheDocument();
    expect(screen.queryByLabelText('Alíquota (%)')).not.toBeInTheDocument();
  });

  it('operador não escreve: a página explica e não mostra o formulário', async () => {
    mockUser.perfil = 'operador';
    montar();
    expect(await screen.findByText(/Seu perfil não pode cadastrar tributos/)).toBeInTheDocument();
    expect(screen.queryByLabelText('Alíquota (%)')).not.toBeInTheDocument();
  });
});
