// ============================================================================
// CONTAGEM CÍCLICA ABC — contrato de tela da capacidade própria (PR #95)
//
// O que estes testes existem para proteger:
//   • a capacidade é uma superfície NAVEGÁVEL da árvore Master (não ficou
//     escondida dentro de Inventário);
//   • a listagem carrega os planos cíclicos e o fluxo segue LISTA → DETALHE;
//   • o planejamento de um novo plano é bloco INLINE da página, nunca modal;
//   • RBAC: operador NÃO descobre a ação de planejar (que exige gerente/admin).
// ============================================================================
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import ContagemCiclicaPage from './ContagemCiclicaPage';
import { ToastProvider } from '../components/ui';
import { api } from '../lib/api';

vi.mock('../lib/api', () => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), del: vi.fn() },
  ApiError: class ApiError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.name = 'ApiError';
      this.status = status;
    }
  },
}));

const authMock = { user: { perfil: 'gerente' } as { perfil: string } | null };
vi.mock('../auth/AuthContext', () => ({
  useAuth: () => authMock,
}));

const apiGet = vi.mocked(api.get);

const PLANO = {
  id: 31,
  local_id: 2,
  local_id__label: 'Depósito Principal',
  modalidade: 'ciclica_abc',
  classificacao_abc: 'A',
  contagem_status: 'EM_CONTAGEM',
  status: 'aberto',
  abc_periodo_inicio: '2026-10-01',
  abc_periodo_fim: '2026-10-31',
  data_planejada: '2026-10-20',
};

beforeEach(() => {
  vi.clearAllMocks();
  apiGet.mockImplementation(async (path: string) => {
    if (path.startsWith('/inventarios/ciclicas')) return [PLANO] as never;
    if (path.startsWith('/locais/options')) return [{ value: 2, label: 'Depósito Principal' }] as never;
    if (path.startsWith('/inventarios/')) return PLANO as never;
    return [] as never;
  });
});

function renderPage() {
  return render(
    <ToastProvider>
      <ContagemCiclicaPage />
    </ToastProvider>
  );
}

describe('Contagem Cíclica ABC — capacidade própria', () => {
  it('mostra a listagem de planos cíclicos com cabeçalho e classificação', async () => {
    renderPage();
    expect(await screen.findByText('Contagem Cíclica ABC')).toBeInTheDocument();
    expect(screen.getByText('Depósito Principal')).toBeInTheDocument();
    expect(screen.getByText('A')).toBeInTheDocument();
  });

  it('operador não descobre a ação de planejar (RBAC)', async () => {
    authMock.user = { perfil: 'operador' };
    renderPage();
    await screen.findByText('Contagem Cíclica ABC');
    expect(screen.queryByRole('button', { name: /planejar novo plano/i })).not.toBeInTheDocument();
  });

  it('gerente vê a ação de planejar e o fluxo é inline, sem modal', async () => {
    authMock.user = { perfil: 'gerente' };
    renderPage();
    await screen.findByText('Contagem Cíclica ABC');
    expect(screen.getByRole('button', { name: /planejar novo plano/i })).toBeInTheDocument();
    // ZERO MODAL: a página não pode usar role=dialog/aria-modal/overlay fixo.
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.querySelector('[aria-modal="true"]')).toBeNull();
  });

  it('lista vazia exibe estado vazio em vez de inventar dados', async () => {
    apiGet.mockImplementation(async (path: string) => {
      if (path.startsWith('/inventarios/ciclicas')) return [] as never;
      if (path.startsWith('/locais/options')) return [{ value: 2, label: 'Depósito Principal' }] as never;
      return [] as never;
    });
    renderPage();
    expect(await screen.findByText('Contagem Cíclica ABC')).toBeInTheDocument();
    expect(screen.getByText(/Nenhum plano cíclico ainda/i)).toBeInTheDocument();
  });
});

describe('Capacidade — navegabilidade na árvore Master', () => {
  it('a capacidade possui módulo, grupo Estoque e rota própria', async () => {
    const { MODULES } = await import('../modules');
    const mod = MODULES.find((m) => m.id === 'contagem-ciclica-abc');
    expect(mod).toBeDefined();
    expect(mod?.label).toBe('Contagem Cíclica ABC');
    expect(mod?.area).toBe('Estoque & Suprimentos');
    expect(mod?.group).toBe('Estoque');
    expect(mod?.path).toBe('/contagem-ciclica-abc');
    expect(mod?.resource).toBe('inventarios');
    expect(mod?.minPerfil).toBe('gerente');
  });
});
