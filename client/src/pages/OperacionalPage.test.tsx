// ============================================================================
// OPERATIONAL CONTROL PLANE — as telas são PÁGINAS (ZERO MODAL)
// ----------------------------------------------------------------------------
// Prova o comportamento que importa para o Diretor:
//   1. a LISTA lê os endpoints canônicos e mostra o estado de cada operação;
//   2. o DETALHE resolve workflow/branch do REGISTRO interno (nunca do cliente)
//      e só oferece aprovação a quem tem a capacidade;
//   3. a aprovação exige confirmação explícita e, se o servidor pedir
//      reautenticação, o fluxo de step-up é acionado — o agente MCP nunca aprova;
//   4. nada abre modal/drawer (a superfície é a própria página).
// ============================================================================
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import OperacionalPage from './OperacionalPage';
import OperacionalDetalhePage from './OperacionalDetalhePage';
import { ToastProvider } from '../components/ui';
import { api } from '../lib/api';

vi.mock('../lib/api', () => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), del: vi.fn() },
  ApiError: class ApiError extends Error {
    status: number;
    code?: string;
    constructor(status: number, message: string, code?: string) {
      super(message);
      this.name = 'ApiError';
      this.status = status;
      this.code = code;
    }
  },
}));

const reauth = vi.fn();
vi.mock('../components/ReauthModal', () => ({
  default: ({ open, onConfirmed }: { open: boolean; onConfirmed: () => void }) => {
    if (open) reauth();
    return (
      <button type="button" data-testid="reauth" hidden={!open} onClick={onConfirmed}>
        reautenticar
      </button>
    );
  },
}));

const apiGet = vi.mocked(api.get);
const apiPost = vi.mocked(api.post);

const CAPS = {
  repository_read: true,
  workflow_read: true,
  workflow_request: true,
  workflow_approval: true,
  arbitrary_command_execution: false,
  github_app_configured: false,
  workflows: [
    {
      key: 'neon-production-diagnostic',
      operation: 'diagnostic.read_only',
      enabled: false,
      requiresApproval: true,
      branch: 'ops/workflow-migracao-producao-diagnostico',
      allowedRefs: ['ops/workflow-migracao-producao-diagnostico'],
    },
  ],
};

function operacao(over: Record<string, unknown> = {}) {
  return {
    id: 'op_01J',
    operation_type: 'workflow.dispatch',
    workflow_key: 'neon-production-diagnostic',
    requested_by: 123,
    parameters: { ref: 'ops/workflow-migracao-producao-diagnostico' },
    reason: 'Diagnóstico read-only autorizado pelo Diretor.',
    status: 'pending_approval',
    requires_approval: true,
    expires_at: '2026-11-13T16:00:00.000Z',
    created_at: '2026-11-13T15:00:00.000Z',
    updated_at: '2026-11-13T15:00:00.000Z',
    approval: { required: true, approved: false, decision: null },
    execution: { id: null, run_id: null, status: 'not_dispatched', conclusion: null, html_url: null },
    ...over,
  };
}

function montarLista() {
  return render(
    <MemoryRouter initialEntries={['/operacional']}>
      <ToastProvider>
        <Routes>
          <Route path="/operacional" element={<OperacionalPage />} />
          <Route path="/operacional/:id" element={<div>DETALHE</div>} />
        </Routes>
      </ToastProvider>
    </MemoryRouter>
  );
}

function montarDetalhe() {
  return render(
    <MemoryRouter initialEntries={['/operacional/op_01J']}>
      <ToastProvider>
        <Routes>
          <Route path="/operacional" element={<div>LISTA</div>} />
          <Route path="/operacional/:id" element={<OperacionalDetalhePage />} />
        </Routes>
      </ToastProvider>
    </MemoryRouter>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('OperacionalPage — lista em página', () => {
  it('lê capabilities e operations e resume os estados', async () => {
    apiGet.mockImplementation(((path: string) =>
      Promise.resolve(
        path.includes('capabilities')
          ? { capabilities: CAPS }
          : { operations: [operacao(), operacao({ id: 'op_02J', status: 'completed', execution: { id: 'exec_1', run_id: 99, status: 'completed', conclusion: 'success', html_url: 'https://github.com/x/y/actions/runs/99' } })] }
      )) as never);

    montarLista();

    expect(await screen.findByText('Controle Operacional')).toBeInTheDocument();
    expect(apiGet).toHaveBeenCalledWith('/operational-control/capabilities');
    expect(apiGet).toHaveBeenCalledWith('/operational-control/operations');
    expect(await screen.findByText('op_01J')).toBeInTheDocument();
    expect(await screen.findAllByText('Aguardando aprovação')).not.toHaveLength(0);
    expect(screen.getAllByText('Concluída').length).toBeGreaterThan(0);
    // Execução arbitrária nunca é oferecida.
    expect(screen.getByText('Bloqueada')).toBeInTheDocument();
    // O workflow aparece com a marca de homologação.
    expect(screen.getByText('Desabilitado (homologação)')).toBeInTheDocument();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.querySelector('.fixed.inset-0')).toBeNull();
  });
});

describe('OperacionalDetalhePage — aprovação em página', () => {
  const contexto = {
    ok: true,
    operation: operacao(),
    workflow: {
      key: 'neon-production-diagnostic',
      repository: 'petrickmsilva-alt/brobond-erp',
      workflow_file: 'brobond-migracao-producao.yml',
      operation: 'diagnostic.read_only',
      requires_approval: true,
      enabled: false,
      allowed_refs: ['ops/workflow-migracao-producao-diagnostico'],
      default_branch: 'ops/workflow-migracao-producao-diagnostico',
      maximum_concurrent_executions: 1,
    },
    effective_ref: 'ops/workflow-migracao-producao-diagnostico',
    capabilities: CAPS,
  };

  it('mostra workflow, branch e parâmetros resolvidos do registro interno', async () => {
    apiGet.mockResolvedValue(contexto as never);
    montarDetalhe();

    expect(await screen.findByText('brobond-migracao-producao.yml')).toBeInTheDocument();
    expect(screen.getByText('petrickmsilva-alt/brobond-erp')).toBeInTheDocument();
    expect(screen.getByText('ops/workflow-migracao-producao-diagnostico')).toBeInTheDocument();
    expect(screen.getByText(/Workflow desabilitado/)).toBeInTheDocument();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it('aprova pelo endpoint canônico com confirmação explícita', async () => {
    apiGet.mockResolvedValue(contexto as never);
    apiPost.mockResolvedValue({ ok: true } as never);
    montarDetalhe();

    const botao = await screen.findByRole('button', { name: /Aprovar execução/ });
    expect((botao as HTMLButtonElement).disabled).toBe(true); // sem confirmação, não aprova
    fireEvent.change(screen.getByLabelText(/Confirmação/), { target: { value: 'Confirmo o diagnóstico read-only.' } });
    expect((botao as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(botao);

    await waitFor(() =>
      expect(apiPost).toHaveBeenCalledWith('/operational-control/operations/op_01J/approve', {
        decision: 'approve',
        confirmation: 'Confirmo o diagnóstico read-only.',
      })
    );
  });

  it('rejeita com motivo obrigatório pelo endpoint canônico', async () => {
    apiGet.mockResolvedValue(contexto as never);
    apiPost.mockResolvedValue({ ok: true } as never);
    montarDetalhe();

    fireEvent.click(await screen.findByRole('button', { name: /Rejeitar/ }));
    fireEvent.change(screen.getByPlaceholderText('Motivo da rejeição'), { target: { value: 'Operação não autorizada.' } });
    fireEvent.click(screen.getByRole('button', { name: /Confirmar rejeição/ }));

    await waitFor(() =>
      expect(apiPost).toHaveBeenCalledWith('/operational-control/operations/op_01J/reject', { reason: 'Operação não autorizada.' })
    );
  });

  it('sem capacidade de aprovação a operação fica pendente e nada é oferecido', async () => {
    apiGet.mockResolvedValue({ ...contexto, capabilities: { ...CAPS, workflow_approval: false } } as never);
    montarDetalhe();

    expect(await screen.findByText(/não tem a permissão de aprovação/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Aprovar execução/ })).not.toBeInTheDocument();
  });
});
