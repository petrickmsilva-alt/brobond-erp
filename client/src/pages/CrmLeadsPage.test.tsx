// ============================================================================
// CRM 3.0 — AÇÃO "CONVERTER EM OPORTUNIDADE" NA LISTA DE LEADS
//
// A conversão Lead → Oportunidade é do SERVIDOR (POST /api/crm/leads/:id/converter,
// transacional, idempotente e auditável). Este teste trava só o contrato da
// TELA, que é o que o usuário opera:
//
//   A. a linha de um lead EM ABERTO oferece a ação de converter;
//   B. clicar chama a MESMA rota do backend e recarrega a lista;
//   C. lead já convertido NÃO mostra a ação (nada de converter duas vezes);
//   D. lead encerrado (ganho/perdido) NÃO mostra a ação;
//   E. a resposta idempotente informa a oportunidade existente (não finge criar
//      uma nova);
//   F. erro do servidor vira mensagem — a tela não engole a falha.
// ============================================================================
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import ModulePage from './ModulePage';
import { ToastProvider } from '../components/ui';
import { api, ApiError } from '../lib/api';
import type { Module } from '../modules';

const auth = vi.hoisted(() => ({
  user: { id: 1, name: 'Gerente', perfil: 'gerente' as 'admin' | 'gerente' | 'operador' },
}));

vi.mock('../lib/api', () => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), del: vi.fn() },
  ApiError: class ApiError extends Error {
    status: number;
    fields?: Record<string, string>;
    code?: string;
    details?: Record<string, unknown>;
    constructor(status: number, message: string, fields?: Record<string, string>, code?: string, details?: Record<string, unknown>) {
      super(message);
      this.name = 'ApiError';
      this.status = status;
      this.fields = fields;
      this.code = code;
      this.details = details;
    }
  },
  downloadFile: vi.fn(),
}));

vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({ user: auth.user }),
}));

vi.mock('../lib/meta', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/meta')>();
  // Espelho de server/src/resources.ts › crm_leads (campos relevantes).
  const crmLeads = {
    key: 'crm_leads',
    label: 'Leads',
    singular: 'Lead',
    labelFields: ['nome'],
    empresa: true,
    ops: { create: true, update: true, delete: true },
    minPerfil: 'gerente',
    filterFields: ['status', 'origem', 'responsavel_id', 'ativo'],
    fields: [
      { name: 'nome', label: 'Nome', type: 'text', required: true, search: true, list: true },
      {
        name: 'status',
        label: 'Status',
        type: 'select',
        required: true,
        search: true,
        list: true,
        options: [
          { value: 'novo', label: 'Novo' },
          { value: 'contato', label: 'Contato' },
          { value: 'qualificacao', label: 'Qualificação' },
          { value: 'proposta', label: 'Proposta' },
          { value: 'ganho', label: 'Ganho' },
          { value: 'perdido', label: 'Perdido' },
        ],
      },
      { name: 'origem', label: 'Origem', type: 'text', list: true },
      { name: 'lead_convertido_em', label: 'Convertido em', type: 'datetime', readonly: true, list: false },
    ],
  };
  return {
    ...actual,
    useMeta: () => ({ resources: { crm_leads: crmLeads }, modules: [], mode: 'memory' }),
  };
});

const apiGet = vi.mocked(api.get);
const apiPost = vi.mocked(api.post);

const MODULE = {
  id: 'crm-leads',
  label: 'Leads',
  icon: (() => null) as unknown as Module['icon'],
  space: 'erp',
  area: 'Vendas',
  group: 'Comercial',
  subgroup: 'Funil',
  path: '/crm/leads',
  resource: 'crm_leads',
  description: 'Topo do funil: contato potencial ainda não convertido em cliente.',
} as unknown as Module;

const LINHAS = [
  { id: 11, nome: 'Lead novo', status: 'novo', origem: 'site' },
  { id: 12, nome: 'Lead convertido', status: 'qualificacao', origem: 'site', lead_convertido_em: '2026-10-20T10:00:00.000Z' },
  { id: 13, nome: 'Lead perdido', status: 'perdido', origem: 'feira' },
];

function renderPagina() {
  return render(
    <MemoryRouter initialEntries={['/crm/leads']}>
      <ToastProvider>
        <Routes>
          <Route path="/crm/leads" element={<ModulePage module={MODULE} />} />
          <Route path="/crm/leads/:id/editar" element={<div>Editar lead</div>} />
        </Routes>
      </ToastProvider>
    </MemoryRouter>
  );
}

/** Linha da tabela pelo nome do lead. */
function linha(nome: string): HTMLElement {
  const celula = screen.getByText(nome);
  const tr = celula.closest('tr');
  if (!tr) throw new Error(`linha "${nome}" não encontrada`);
  return tr as HTMLElement;
}

const botaoConverter = (nome: string) =>
  within(linha(nome)).queryByRole('button', { name: new RegExp(`Converter ${nome} em oportunidade`, 'i') });

beforeEach(() => {
  vi.clearAllMocks();
  apiGet.mockImplementation(async (url: string) => {
    if (String(url).startsWith('/crm_leads?')) {
      return { rows: LINHAS, total: LINHAS.length, page: 1, pageSize: 25 } as never;
    }
    return { rows: [], total: 0, page: 1, pageSize: 25 } as never;
  });
  apiPost.mockResolvedValue({ ok: true, oportunidade_id: 77, idempotente: false } as never);
});

describe('CRM — converter lead em oportunidade pela lista', () => {
  it('A. lead em aberto oferece a ação de converter', async () => {
    renderPagina();
    await screen.findByText('Lead novo');
    expect(botaoConverter('Lead novo')).not.toBeNull();
  });

  it('B. clicar chama a rota do backend e recarrega a lista', async () => {
    renderPagina();
    await screen.findByText('Lead novo');
    fireEvent.click(botaoConverter('Lead novo')!);

    await waitFor(() => expect(apiPost).toHaveBeenCalledWith('/crm/leads/11/converter', {}));
    await waitFor(() => {
      const chamadas = apiGet.mock.calls.map(([p]) => String(p)).filter((p) => p.startsWith('/crm_leads?'));
      expect(chamadas.length).toBeGreaterThanOrEqual(2);
    });
    expect(await screen.findByText(/oportunidade #77/i)).toBeInTheDocument();
  });

  it('C. lead já convertido não oferece a ação', async () => {
    renderPagina();
    await screen.findByText('Lead convertido');
    expect(botaoConverter('Lead convertido')).toBeNull();
  });

  it('D. lead encerrado (perdido) não oferece a ação', async () => {
    renderPagina();
    await screen.findByText('Lead perdido');
    expect(botaoConverter('Lead perdido')).toBeNull();
  });

  it('E. resposta idempotente informa a oportunidade existente', async () => {
    apiPost.mockResolvedValue({ ok: true, oportunidade_id: 77, idempotente: true } as never);
    renderPagina();
    await screen.findByText('Lead novo');
    fireEvent.click(botaoConverter('Lead novo')!);
    expect(await screen.findByText(/já estava convertido — oportunidade #77/i)).toBeInTheDocument();
  });

  it('F. erro do servidor é exibido ao usuário', async () => {
    apiPost.mockRejectedValue(new ApiError(409, 'Este lead acabou de ser convertido por outra operação.') as never);
    renderPagina();
    await screen.findByText('Lead novo');
    fireEvent.click(botaoConverter('Lead novo')!);
    expect(await screen.findByText(/acabou de ser convertido por outra operação/i)).toBeInTheDocument();
  });
});
