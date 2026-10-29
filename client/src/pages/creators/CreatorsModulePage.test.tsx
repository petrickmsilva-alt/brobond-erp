import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { MODULES } from '../../modules';
import { apiFetch, ApiError } from '../../lib/api';
import CreatorsModulePage from './CreatorsModulePage';

vi.mock('../../lib/api', async () => {
  const actual = await vi.importActual<typeof import('../../lib/api')>('../../lib/api');
  return { ...actual, apiFetch: vi.fn() };
});
const request = vi.mocked(apiFetch);
const module = MODULES.find((item) => item.id === 'outreach-ai')!;
const capabilities = { empresa_id: 1, modulos: { 'outreach-ai': { fonte: null, consulta: false, geracao: false, envio: false } } };
function renderPage() { return render(<MemoryRouter initialEntries={['/outreach-ai']}><Routes><Route path="/outreach-ai" element={<CreatorsModulePage module={module} />} /></Routes></MemoryRouter>); }
beforeEach(() => { request.mockReset(); request.mockResolvedValue(capabilities); });
describe('Outreach — nenhuma integração externa é simulada', () => {
  it('consulta capacidades e mostra indisponibilidade sem formulário ou modal', async () => {
    const { container } = renderPage(); expect(await screen.findByText('Outreach sem integração configurada.')).toBeInTheDocument();
    expect(request).toHaveBeenCalledWith('/creators/capabilities'); expect(screen.getByText('Sem fonte de dados conectada.')).toBeInTheDocument();
    for (const target of MODULES.filter((item) => item.space === 'creators')) expect(screen.getByRole('link', { name: target.label })).toHaveAttribute('href', target.path);
    expect(container.querySelector('[role="dialog"], [aria-modal], dialog')).toBeNull(); expect(container.querySelector('table')).toBeNull();
    expect(screen.queryByRole('button', { name: /criar|gerar|enviar/i })).not.toBeInTheDocument();
  });
  it('não confunde carregamento com consulta vazia', async () => {
    let resolve!: (value: typeof capabilities) => void; request.mockReturnValueOnce(new Promise((done) => { resolve = done; }));
    renderPage(); expect(screen.getByRole('status')).toHaveTextContent('Verificando recursos');
    await act(async () => { resolve(capabilities); }); expect(await screen.findByText('Outreach sem integração configurada.')).toBeInTheDocument();
  });
  it('erro e retry são explícitos', async () => {
    request.mockRejectedValueOnce(new ApiError(403, 'Você não tem permissão para esta ação.'));
    const user = userEvent.setup(); renderPage(); expect(await screen.findByRole('alert')).toHaveTextContent('Você não tem permissão');
    await user.click(screen.getByRole('button', { name: 'Tentar novamente' }));
    expect(await screen.findByText('Outreach sem integração configurada.')).toBeInTheDocument(); await waitFor(() => expect(request).toHaveBeenCalledTimes(2));
  });
  it('resposta incompatível não é apresentada como ausência de dados', async () => {
    request.mockResolvedValueOnce({ empresa_id: 1, modulos: { 'outreach-ai': { fonte: 'outreach', consulta: true } } });
    renderPage(); expect(await screen.findByRole('alert')).toBeInTheDocument(); expect(screen.queryByText('Outreach sem integração configurada.')).not.toBeInTheDocument();
  });
});
