import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import CreatorsRecordsPage from './CreatorsRecordsPage';
vi.mock('../../lib/api', () => ({ apiFetch: vi.fn() }));
let perfil = 'gerente';
vi.mock('../../auth/AuthContext', () => ({ useAuth: () => ({ user: { id: 1, perfil } }) }));
import { apiFetch } from '../../lib/api'; const api = vi.mocked(apiFetch);
function page(path: string) { return render(<MemoryRouter initialEntries={[path]}><Routes>
  <Route path="/creators" element={<CreatorsRecordsPage kind="profile" />} />
  <Route path="/creators/novo" element={<CreatorsRecordsPage kind="profile" />} />
  <Route path="/creators/:id" element={<CreatorsRecordsPage kind="profile" />} />
  <Route path="/campanhas/:id/editar" element={<CreatorsRecordsPage kind="campaign" />} />
  <Route path="/campanhas/:id" element={<CreatorsRecordsPage kind="campaign" />} />
  <Route path="/matches/parcerias/:id" element={<CreatorsRecordsPage kind="partnership" />} />
</Routes></MemoryRouter>); }
beforeEach(() => { api.mockReset(); perfil = 'gerente'; });
describe('Creators — páginas com persistência e sem modal', () => {
  it('lista e cria perfil por API com chave idempotente', async () => {
    api.mockImplementation(async (path, opts) => opts?.method === 'POST' ? { row: { id: 7 } } : path.includes('/7') ? { id: 7, name: 'Teste', platform: 'INSTAGRAM', handle: 'teste', status: 'ACTIVE' } : { rows: [], total: 0, pageSize: 25 });
    const { container } = page('/creators/novo');
    fireEvent.change(screen.getByLabelText('Nome'), { target: { value: 'Criador Teste' } });
    fireEvent.change(screen.getByLabelText('Identificador do perfil'), { target: { value: 'teste' } });
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));
    await waitFor(() => expect(api).toHaveBeenCalledWith('/creators/perfis', expect.objectContaining({ method: 'POST', headers: expect.objectContaining({ 'Idempotency-Key': expect.any(String) }) })));
    const call = api.mock.calls.find(([path]) => path === '/creators/perfis'); expect(JSON.parse(String(call?.[1]?.body))).toEqual({ name: 'Criador Teste', platform: 'INSTAGRAM', handle: 'teste', niche: null });
    expect(container.querySelector('dialog,[role="dialog"],[aria-modal]')).toBeNull();
  });
  it('edição de campanha transmite versão otimista', async () => {
    const row = { id: 3, name: 'Campanha', objective: 'Divulgação real', starts_on: '2028-01-01', ends_on: '2029-01-01', status: 'DRAFT', version: 2 };
    api.mockImplementation(async (_path, opts) => opts?.method === 'PUT' ? { row } : row);
    page('/campanhas/3/editar'); await screen.findByLabelText('Objetivo');
    fireEvent.change(screen.getByLabelText('Situação'), { target: { value: 'ACTIVE' } }); fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));
    await waitFor(() => expect(api).toHaveBeenCalledWith('/creators/campanhas/3', expect.objectContaining({ method: 'PUT' })));
    const call = api.mock.calls.find(([, opts]) => opts?.method === 'PUT'); expect(JSON.parse(String(call?.[1]?.body))).toMatchObject({ expected_version: 2, status: 'ACTIVE' });
  });
  it('parceria mostra status do checkout sem fabricar comissão', async () => {
    api.mockImplementation(async (path) => path.includes('/atribuicoes') ? { rows: [{ id: 1, order_id: 10, estado: 'AGUARDANDO_PAGAMENTO', pagamento_estado: 'PENDING', total: 100 }], total: 1, pageSize: 25 } : { id: 5, creator_id: 2, campaign_id: 3, coupon_id: 4, status: 'ACTIVE' });
    page('/matches/parcerias/5'); expect(await screen.findByText('AGUARDANDO_PAGAMENTO')).toBeInTheDocument();
    expect(screen.getByText(/não representam receita líquida nem comissão/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '#2' })).toHaveAttribute('href', '/creators/2');
  });
  it('operador não vê ação de criação', async () => {
    perfil = 'operador'; api.mockResolvedValue({ rows: [], total: 0, pageSize: 25 }); page('/creators');
    expect(await screen.findByText('Nenhum registro encontrado.')).toBeInTheDocument(); expect(screen.queryByRole('link', { name: /Novo creator/ })).not.toBeInTheDocument();
  });
});
