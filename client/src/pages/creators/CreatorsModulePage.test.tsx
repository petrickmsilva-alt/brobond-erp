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
const modules = MODULES.filter((item) => item.space === 'creators');
const capabilities = {
  empresa_id: 1,
  modulos: {
    creators: { fonte: null, consulta: false, criacao: false },
    'creator-matches': { fonte: null, consulta: false, recomendacao: false },
    'outreach-ai': { fonte: null, consulta: false, geracao: false, envio: false },
    campanhas: { fonte: null, consulta: false, criacao: false },
  },
};
const emptyTitles = [
  'Você ainda não possui creators cadastrados.',
  'Não existem matches disponíveis no momento.',
  'Nenhuma oportunidade de outreach encontrada.',
  'Nenhuma campanha cadastrada.',
];

function renderPage(path = '/creators') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>{modules.map((module) => <Route key={module.id} path={module.path} element={<CreatorsModulePage module={module} />} />)}</Routes>
    </MemoryRouter>
  );
}

beforeEach(() => {
  request.mockReset();
  request.mockResolvedValue(capabilities);
});

describe('Creators — páginas nativas, sem dados ou ações fabricadas', () => {
  modules.forEach((module, index) => {
    it(`${module.path}: consulta real de capacidades, empty state e navegação`, async () => {
      const { container } = renderPage(module.path);
      expect(await screen.findByText(emptyTitles[index])).toBeInTheDocument();
      expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(module.label.toUpperCase());
      expect(screen.getByText(module.description!)).toBeInTheDocument();
      expect(request).toHaveBeenCalledWith('/creators/capabilities');
      expect(screen.getByText('Sem fonte de dados conectada.')).toBeInTheDocument();
      expect(screen.getByRole('link', { name: module.label })).toHaveAttribute('aria-current', 'page');
      for (const target of modules) expect(screen.getByRole('link', { name: target.label })).toHaveAttribute('href', target.path);
      expect(container.textContent).not.toMatch(/em breve|em construção planejada|ações em breve|próximas capacidades|escopo inicial do módulo/i);
      expect(container.querySelector('[role="dialog"], [aria-modal], dialog')).toBeNull();
      expect(container.querySelector('table')).toBeNull();
      expect(screen.queryByRole('button', { name: /novo|criar|gerar|enviar/i })).not.toBeInTheDocument();
      expect(screen.queryByText(/^0$/)).not.toBeInTheDocument();
    });

    it(`${module.path}: loading não é confundido com ausência de dados`, async () => {
      let resolve!: (value: typeof capabilities) => void;
      request.mockReturnValueOnce(new Promise((done) => { resolve = done; }));
      renderPage(module.path);
      expect(screen.getByRole('status')).toHaveTextContent('Verificando recursos');
      expect(screen.queryByText(emptyTitles[index])).not.toBeInTheDocument();
      await act(async () => { resolve(capabilities); });
      expect(await screen.findByText(emptyTitles[index])).toBeInTheDocument();
    });

    it(`${module.path}: erro da API, retry e recuperação`, async () => {
      request.mockRejectedValueOnce(new ApiError(403, 'Você não tem permissão para esta ação.'));
      const user = userEvent.setup();
      renderPage(module.path);
      expect(await screen.findByRole('alert')).toHaveTextContent('Você não tem permissão');
      expect(screen.queryByText(emptyTitles[index])).not.toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: 'Tentar novamente' }));
      expect(await screen.findByText(emptyTitles[index])).toBeInTheDocument();
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      expect(request).toHaveBeenCalledTimes(2);
    });
  });

  it('links alternam entre os quatro módulos sem navegação fake', async () => {
    const user = userEvent.setup();
    renderPage();
    for (let index = 0; index < modules.length; index++) {
      await user.click(screen.getByRole('link', { name: modules[index].label }));
      expect(await screen.findByText(emptyTitles[index])).toBeInTheDocument();
    }
  });

  it('Atualizar verifica novamente o servidor', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText(emptyTitles[0]);
    await user.click(screen.getByRole('button', { name: 'Atualizar' }));
    await waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    expect(await screen.findByText(emptyTitles[0])).toBeInTheDocument();
  });

  it('resposta incompleta não é apresentada como consulta vazia bem-sucedida', async () => {
    request.mockResolvedValueOnce({ empresa_id: 1, modulos: {} });
    renderPage();
    expect(await screen.findByRole('alert')).toHaveTextContent('Não foi possível verificar');
    expect(screen.queryByText(emptyTitles[0])).not.toBeInTheDocument();
  });

  it('não oculta silenciosamente dados de uma versão de API incompatível', async () => {
    request.mockResolvedValueOnce({ empresa_id: 1, modulos: { creators: { fonte: 'creators', consulta: true } } });
    renderPage();
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.queryByText(emptyTitles[0])).not.toBeInTheDocument();
  });

  it('resposta atrasada do módulo anterior não sobrescreve a tela atual', async () => {
    let reject!: (reason: Error) => void;
    request.mockReturnValueOnce(new Promise((_, fail) => { reject = fail; }));
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole('link', { name: 'Campanhas' }));
    expect(await screen.findByText(emptyTitles[3])).toBeInTheDocument();
    await act(async () => { reject(new Error('Falha atrasada')); });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByText(emptyTitles[3])).toBeInTheDocument();
  });
});
