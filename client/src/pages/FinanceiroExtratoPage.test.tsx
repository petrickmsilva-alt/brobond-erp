import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import FinanceiroExtratoPage from './FinanceiroExtratoPage';
vi.mock('../lib/api', () => ({ api: { get: vi.fn(), post: vi.fn() } }));
import { api } from '../lib/api';
const linha = { id: 12, conta_id: 4, data: '2035-05-10', valor: 42, direcao: 'entrada', descricao: 'PIX', status: 'importada', motivo: null, lancamento_id: null, baixa_lancamento_id: null, fitid: 'FIT-123' };
function page(path: string) { return render(<MemoryRouter initialEntries={[path]}><Routes>
  <Route path="/financeiro/extrato" element={<FinanceiroExtratoPage modo="lista" />} />
  <Route path="/financeiro/extrato/:id" element={<FinanceiroExtratoPage modo="detalhe" />} />
  <Route path="/financeiro/extrato/:id/editar" element={<FinanceiroExtratoPage modo="editar" />} />
</Routes></MemoryRouter>); }
describe('Extrato persistente, sem sobreposições', () => {
  beforeEach(() => { vi.mocked(api.get).mockReset(); vi.mocked(api.post).mockReset(); });
  it('lista linhas paginadas sem ocultar indisponibilidade do servidor', async () => {
    vi.mocked(api.get).mockResolvedValue({ linhas: [linha], total: 31 }); page('/financeiro/extrato');
    expect(await screen.findByRole('link', { name: /#12 · PIX/ })).toHaveAttribute('href', '/financeiro/extrato/12');
    expect(screen.getByRole('navigation', { name: 'Paginação do extrato' })).toBeInTheDocument();
    expect(screen.getByText(/valor e data, por si só/i)).toBeInTheDocument(); expect(screen.queryByRole('dialog')).toBeNull();
  });
  it('confirmar usa rota dedicada e título informado', async () => {
    vi.mocked(api.get).mockResolvedValue({ linha }); vi.mocked(api.post).mockResolvedValue({}); page('/financeiro/extrato/12/editar');
    fireEvent.change(await screen.findByLabelText('ID do lançamento financeiro'), { target: { value: '44' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirmar conciliação' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/financeiro/extrato/12/conciliar', { lancamento_id: 44 }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });
  it('exibe erro, não uma lista vazia fictícia', async () => {
    vi.mocked(api.get).mockRejectedValue(new Error('Banco indisponível')); page('/financeiro/extrato');
    expect(await screen.findByText('Banco indisponível')).toBeInTheDocument(); expect(screen.queryByText('Nenhuma linha encontrada')).toBeNull();
  });
});
