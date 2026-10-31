import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import CreatorMatchesPage from './CreatorMatchesPage';
vi.mock('../../lib/api', () => ({ apiFetch: vi.fn() }));
let perfil = 'gerente';
vi.mock('../../auth/AuthContext', () => ({ useAuth: () => ({ user: { id: 1, perfil } }) }));
import { apiFetch } from '../../lib/api'; const api = vi.mocked(apiFetch);

function page(path: string) { return render(<MemoryRouter initialEntries={[path]}><Routes>
  <Route path="/matches" element={<CreatorMatchesPage />} />
  <Route path="/matches/novo" element={<CreatorMatchesPage />} />
  <Route path="/matches/:id" element={<CreatorMatchesPage />} />
  <Route path="/matches/:id/editar" element={<CreatorMatchesPage />} />
</Routes></MemoryRouter>); }
beforeEach(() => { api.mockReset(); perfil = 'gerente'; });

const opcoes = (path: string) => {
  if (path.startsWith('/creators/perfis')) return { rows: [{ id: 2, name: 'Ana', handle: 'ana' }], total: 1, pageSize: 100 };
  if (path.startsWith('/creators/campanhas')) return { rows: [{ id: 3, name: 'Verão', objective: 'x', starts_on: '2028-01-01', ends_on: '2028-02-01', status: 'DRAFT', version: 0 }], total: 1, pageSize: 100 };
  if (path.startsWith('/categorias/options')) return [{ value: 9, label: 'Vestidos' }];
  return { rows: [], total: 0, pageSize: 25 };
};

describe('Matches — afinidade real registrada por pessoa, ZERO MODAL', () => {
  it('lista afinidades sem sugerir nada e mostra o score factual', async () => {
    api.mockImplementation(async (path) => path.startsWith('/matches') || path.includes('/creators/matches')
      ? { rows: [{ id: 1, creator_id: 2, campaign_id: 3, categoria_id: 9, score: 7.5, evidencia: { publicos: ['moda'] }, status: 'sugerido', criado_em: '2026-01-01T00:00:00Z' }], total: 1, pageSize: 25 }
      : opcoes(path));
    const { container } = page('/matches');
    expect(await screen.findByText('7.50')).toBeInTheDocument();
    expect(screen.getByText('Sugerido')).toBeInTheDocument();
    expect(container.querySelector('dialog,[role="dialog"],[aria-modal]')).toBeNull();
  });

  it('cria a afinidade com score e evidência (JSON) e chave idempotente', async () => {
    api.mockImplementation(async (path, opts) => opts?.method === 'POST' ? { row: { id: 11 } } : opcoes(path));
    page('/matches/novo');
    fireEvent.change(await screen.findByLabelText('Creator'), { target: { value: '2' } });
    fireEvent.change(screen.getByLabelText('Score (0 a 100)'), { target: { value: '88.5' } });
    fireEvent.change(screen.getByLabelText('Evidência (JSON, opcional)'), { target: { value: '{"publicos":["moda"]}' } });
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));
    await waitFor(() => expect(api).toHaveBeenCalledWith('/creators/matches', expect.objectContaining({ method: 'POST', headers: expect.objectContaining({ 'Idempotency-Key': expect.any(String) }) })));
    const call = api.mock.calls.find(([p]) => p === '/creators/matches');
    expect(JSON.parse(String(call?.[1]?.body))).toMatchObject({ creator_id: 2, score: 88.5, evidencia: { publicos: ['moda'] }, status: 'sugerido' });
  });

  it('rejeita evidência que não é objeto JSON, sem gravar', async () => {
    api.mockImplementation(async (path, opts) => opts?.method === 'POST' ? { row: { id: 11 } } : opcoes(path));
    page('/matches/novo');
    fireEvent.change(await screen.findByLabelText('Creator'), { target: { value: '2' } });
    fireEvent.change(screen.getByLabelText('Evidência (JSON, opcional)'), { target: { value: '[1,2]' } });
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));
    expect(await screen.findByText(/objeto JSON/)).toBeInTheDocument();
    expect(api.mock.calls.some(([p, o]) => p === '/creators/matches' && o?.method === 'POST')).toBe(false);
  });

  it('detalhe exibe a evidência registrada e linka o parcerias manuais', async () => {
    api.mockImplementation(async (path) => path === '/creators/matches/4'
      ? { id: 4, creator_id: 2, campaign_id: null, categoria_id: null, score: 10, evidencia: { notas: 'ok' }, status: 'aceito', criado_em: '2026-01-01T00:00:00Z' }
      : opcoes(path));
    page('/matches/4');
    expect(await screen.findByText(/"notas": "ok"/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'parcerias manuais' })).toHaveAttribute('href', '/matches/parcerias');
  });

  it('operador não vê ação de criação', async () => {
    perfil = 'operador'; api.mockImplementation(async (path) => opcoes(path));
    page('/matches');
    expect(await screen.findByText('Nenhuma afinidade registrada.')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Nova afinidade/ })).not.toBeInTheDocument();
  });
});
