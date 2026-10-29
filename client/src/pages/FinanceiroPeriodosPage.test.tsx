import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import FinanceiroPeriodosPage from './FinanceiroPeriodosPage';
vi.mock('../lib/api', () => ({ api: { get: vi.fn(), post: vi.fn() }, ApiError: class ApiError extends Error {} }));
vi.mock('../auth/AuthContext', () => ({ useAuth: () => ({ user: { perfil: 'admin' } }) }));
import { api } from '../lib/api';
function page(path: string) { return render(<MemoryRouter initialEntries={[path]}><Routes>
  <Route path="/financeiro/periodos" element={<FinanceiroPeriodosPage modo="lista" />} />
  <Route path="/financeiro/periodos/novo" element={<FinanceiroPeriodosPage modo="novo" />} />
  <Route path="/financeiro/periodos/:competencia" element={<FinanceiroPeriodosPage modo="detalhe" />} />
</Routes></MemoryRouter>); }
describe('Períodos da escrituração — rotas próprias', () => {
  beforeEach(() => { vi.mocked(api.get).mockReset(); vi.mocked(api.post).mockReset(); });
  it('lista dados reais e explica o alcance limitado do fechamento', async () => {
    vi.mocked(api.get).mockResolvedValue({ rows: [{ id: 1, competencia: '2028-05-01', estado: 'fechado', motivo: 'Conferido' }], pageSize: 30, total: 1 });
    page('/financeiro/periodos');
    expect(await screen.findByRole('link', { name: '2028-05' })).toHaveAttribute('href', '/financeiro/periodos/2028-05');
    expect(screen.getByText(/Controla somente a importação/)).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).toBeNull();
  });
  it('envia fechamento com competência e motivo à API', async () => {
    vi.mocked(api.post).mockResolvedValue({}); vi.mocked(api.get).mockResolvedValue({ competencia: '2028-05', estado: 'fechado', registrado: true, periodo: { motivo: 'Fechamento validado' } });
    page('/financeiro/periodos/novo');
    fireEvent.change(screen.getByLabelText('Competência'), { target: { value: '2028-05' } });
    fireEvent.change(screen.getByLabelText('Motivo da ação'), { target: { value: 'Fechamento validado' } });
    fireEvent.click(screen.getByRole('button', { name: 'Fechar escrituração' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/financeiro/periodos/2028-05/fechar', { motivo: 'Fechamento validado' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
