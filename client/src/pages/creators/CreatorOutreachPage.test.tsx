import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import CreatorOutreachPage from './CreatorOutreachPage';
vi.mock('../../lib/api', () => ({ apiFetch: vi.fn() }));
let perfil = 'gerente';
vi.mock('../../auth/AuthContext', () => ({ useAuth: () => ({ user: { id: 1, perfil } }) }));
import { apiFetch } from '../../lib/api'; const api = vi.mocked(apiFetch);

function page(path: string) { return render(<MemoryRouter initialEntries={[path]}><Routes>
  <Route path="/outreach-ai" element={<CreatorOutreachPage />} />
  <Route path="/outreach-ai/novo" element={<CreatorOutreachPage />} />
  <Route path="/outreach-ai/:id" element={<CreatorOutreachPage />} />
  <Route path="/outreach-ai/:id/editar" element={<CreatorOutreachPage />} />
</Routes></MemoryRouter>); }
beforeEach(() => { api.mockReset(); perfil = 'gerente'; });
const opcoes = (path: string) => path.startsWith('/creators/perfis') ? { rows: [{ id: 2, name: 'Ana', handle: 'ana' }], total: 1, pageSize: 100 } : { rows: [], total: 0, pageSize: 25 };

describe('Outreach — registro manual do contato, sem envio simulado', () => {
  it('lista contatos reais e declara que nada é enviado automaticamente', async () => {
    api.mockImplementation(async (path) => path.startsWith('/creators/outreach')
      ? { rows: [{ id: 1, creator_id: 2, partnership_id: null, canal: 'email', assunto: 'Convite', mensagem: 'olá', status: 'rascunho', enviado_em: null, respondido_em: null, criado_em: '2026-01-01T00:00:00Z' }], total: 1, pageSize: 25 }
      : opcoes(path));
    const { container } = page('/outreach-ai');
    expect(await screen.findByText('Convite')).toBeInTheDocument();
    expect(screen.getByText(/nada é transmitido automaticamente/)).toBeInTheDocument();
    expect(container.querySelector('dialog,[role="dialog"],[aria-modal]')).toBeNull();
  });

  it('cria o contato manual com canal e mensagem, sem campo de envio', async () => {
    api.mockImplementation(async (path, opts) => opts?.method === 'POST' ? { row: { id: 9 } } : opcoes(path));
    page('/outreach-ai/novo');
    fireEvent.change(await screen.findByLabelText('Creator'), { target: { value: '2' } });
    fireEvent.change(screen.getByLabelText('Assunto (opcional)'), { target: { value: 'Convite' } });
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));
    await waitFor(() => expect(api).toHaveBeenCalledWith('/creators/outreach', expect.objectContaining({ method: 'POST', headers: expect.objectContaining({ 'Idempotency-Key': expect.any(String) }) })));
    const call = api.mock.calls.find(([p]) => p === '/creators/outreach');
    expect(JSON.parse(String(call?.[1]?.body))).toMatchObject({ creator_id: 2, canal: 'email', assunto: 'Convite', status: 'rascunho' });
    expect(screen.queryByRole('button', { name: /Enviar/ })).not.toBeInTheDocument();
  });

  it('edição oferece apenas transições válidas de situação', async () => {
    api.mockImplementation(async (path) => path === '/creators/outreach/5'
      ? { id: 5, creator_id: 2, partnership_id: null, canal: 'whatsapp', assunto: null, mensagem: null, status: 'rascunho', enviado_em: null, respondido_em: null, criado_em: '2026-01-01T00:00:00Z' }
      : opcoes(path));
    page('/outreach-ai/5/editar');
    const select = await screen.findByLabelText('Situação');
    const valores = [...select.querySelectorAll('option')].map((o) => o.value);
    expect(valores).toEqual(['rascunho', 'enviado', 'sem_resposta']);
  });

  it('operador não vê ação de criação', async () => {
    perfil = 'operador'; api.mockImplementation(async (path) => opcoes(path));
    page('/outreach-ai');
    expect(await screen.findByText('Nenhum contato registrado.')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Novo contato/ })).not.toBeInTheDocument();
  });
});
