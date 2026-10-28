// ============================================================================
// HOMOLOGAÇÃO FINAL — os fluxos de módulo convertidos são PÁGINAS
// ----------------------------------------------------------------------------
// Cada teste aqui prova uma coisa só, e prova pelo comportamento:
//   1. a página existe e renderiza como rota (sem `role="dialog"`, sem overlay);
//   2. ela fala com o endpoint canônico do módulo;
//   3. o caminho antigo (painel inline) não existe mais.
//
// As rotas estão registradas em `client/src/App.tsx`; o gate `npm run audit:ux`
// exige que TODAS continuem lá (ver `scripts/ux-guard.mjs` → FLUXOS_PAGINA).
// ============================================================================
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import EmpresaFormPage from './EmpresaFormPage';
import NovaFichaPage from './NovaFichaPage';
import DevolucaoNovaPage from './DevolucaoNovaPage';
import WebhookFormPage from './WebhookFormPage';
import ImportarPage from './ImportarPage';
import { ToastProvider } from '../components/ui';
import { api } from '../lib/api';

vi.mock('../lib/api', () => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), del: vi.fn() },
  downloadFile: vi.fn(),
  lerArquivoParaImportacao: vi.fn(),
  ApiError: class ApiError extends Error {
    status: number;
    code?: string;
    fields?: Record<string, string>;
    constructor(status: number, message: string, code?: string, fields?: Record<string, string>) {
      super(message);
      this.name = 'ApiError';
      this.status = status;
      this.code = code;
      this.fields = fields;
    }
  },
}));

// ReauthModal é infraestrutura (step-up) — nos testes de página ele é inerte.
vi.mock('../components/ReauthModal', () => ({ default: () => null }));
vi.mock('../components/ProductSelector', () => ({
  ProductSelector: ({ onChange }: { onChange: (id: number, p: unknown) => void }) => (
    <button type="button" onClick={() => onChange(42, { id: 42, produto_pai_id: 42 })}>
      escolher produto
    </button>
  ),
}));

const mockUser: { perfil: 'admin' | 'gerente' | 'operador' } = { perfil: 'admin' };
vi.mock('../auth/AuthContext', () => ({ useAuth: () => ({ user: mockUser }) }));

const apiGet = vi.mocked(api.get);
const apiPost = vi.mocked(api.post);
const apiPut = vi.mocked(api.put);

const semDialogo = () => expect(document.querySelector('[role="dialog"]')).toBeNull();
const semOverlay = () => expect(document.querySelector('.fixed.inset-0')).toBeNull();

function montar(elemento: JSX.Element, url = '/', padrao = url) {
  return render(
    <MemoryRouter initialEntries={[url]}>
      <ToastProvider>
        <Routes>
          <Route path={padrao} element={elemento} />
          <Route path="/empresas" element={<div>LISTA EMPRESAS</div>} />
          <Route path="/webhooks" element={<div>LISTA WEBHOOKS</div>} />
          <Route path="/devolucoes" element={<div>LISTA DEVOLUÇÕES</div>} />
          <Route path="/fichas/:id" element={<div>FICHA CRIADA</div>} />
          <Route path="*" element={<div>DESTINO DESCONHECIDO</div>} />
        </Routes>
      </ToastProvider>
    </MemoryRouter>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockUser.perfil = 'admin';
});

describe('EmpresaFormPage — cadastro em página', () => {
  it('cria empresa pelo POST canônico e volta para a lista', async () => {
    apiPost.mockResolvedValue({ id: 9 } as never);
    montar(<EmpresaFormPage modo="novo" />, '/empresas/novo');
    expect(await screen.findByText('Nova empresa')).toBeInTheDocument();
    semDialogo();
    semOverlay();
    fireEvent.change(screen.getByLabelText('Nome *'), { target: { value: 'FILIAL NORTE' } });
    fireEvent.change(screen.getByLabelText('CNPJ'), { target: { value: '11222333000181' } });
    fireEvent.click(screen.getByRole('button', { name: /^Salvar$/ }));
    await waitFor(() =>
      expect(apiPost).toHaveBeenCalledWith('/empresas', {
        nome: 'FILIAL NORTE',
        razao_social: null,
        nome_fantasia: null,
        cnpj: '11222333000181',
        telefone: null,
        email: null,
      })
    );
    expect(await screen.findByText('LISTA EMPRESAS')).toBeInTheDocument();
  });

  it('exige nome antes de chamar a API', async () => {
    montar(<EmpresaFormPage modo="novo" />, '/empresas/novo');
    fireEvent.click(await screen.findByRole('button', { name: /^Salvar$/ }));
    expect(await screen.findByText('Informe o nome da empresa.')).toBeInTheDocument();
    expect(apiPost).not.toHaveBeenCalled();
  });

  it('edição carrega o registro e envia PUT com o `ativo`', async () => {
    apiGet.mockResolvedValue({ rows: [{ id: 7, nome: 'FILIAL SUL', cnpj: '11222333000181', ativo: true }] } as never);
    apiPut.mockResolvedValue({ id: 7 } as never);
    montar(<EmpresaFormPage modo="editar" />, '/empresas/7/editar', '/empresas/:id/editar');
    await waitFor(() => expect((screen.getByLabelText('Nome *') as HTMLInputElement).value).toBe('FILIAL SUL'));
    fireEvent.change(screen.getByLabelText('Nome *'), { target: { value: 'FILIAL SUL II' } });
    fireEvent.click(screen.getByRole('button', { name: /^Salvar$/ }));
    await waitFor(() => expect(apiPut).toHaveBeenCalledWith('/empresas/7', expect.objectContaining({ nome: 'FILIAL SUL II', ativo: true })));
  });
});

describe('NovaFichaPage — criação de ficha em página', () => {
  it('cria a ficha e abre a página da ficha', async () => {
    apiPost.mockResolvedValue({ id: 77 } as never);
    montar(<NovaFichaPage />, '/custo/nova');
    expect(await screen.findByText('Nova ficha técnica')).toBeInTheDocument();
    semDialogo();
    fireEvent.click(screen.getByText('escolher produto'));
    fireEvent.change(screen.getByLabelText('Mão de obra (R$)'), { target: { value: '10,50' } });
    fireEvent.click(screen.getByRole('button', { name: /Criar ficha/ }));
    await waitFor(() => expect(apiPost).toHaveBeenCalledWith('/fichas', { produto_id: 42, mao_obra: 10.5, custos_indiretos: 0, margem_pct: 0 }));
    expect(await screen.findByText('FICHA CRIADA')).toBeInTheDocument();
  });

  it('sem produto não chama a API e explica', async () => {
    montar(<NovaFichaPage />, '/custo/nova');
    fireEvent.click(await screen.findByRole('button', { name: /Criar ficha/ }));
    expect(await screen.findByText('Selecione o produto.')).toBeInTheDocument();
    expect(apiPost).not.toHaveBeenCalled();
  });
});

describe('DevolucaoNovaPage — solicitação em página', () => {
  it('só habilita com pedido e motivo ≥ 5 e envia o POST canônico', async () => {
    apiPost.mockResolvedValue({ id: 44 } as never);
    montar(<DevolucaoNovaPage />, '/devolucoes/nova');
    const botao = await screen.findByRole('button', { name: /^Solicitar$/ });
    expect((botao as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/Pedido \(venda\)/), { target: { value: '55' } });
    fireEvent.change(screen.getByLabelText('Motivo'), { target: { value: 'no' } });
    expect((screen.getByRole('button', { name: /^Solicitar$/ }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Motivo'), { target: { value: 'Cliente desistiu da compra' } });
    fireEvent.click(screen.getByRole('button', { name: /^Solicitar$/ }));
    await waitFor(() =>
      expect(apiPost).toHaveBeenCalledWith('/devolucoes', { venda_id: 55, motivo: 'Cliente desistiu da compra', tipo: 'devolucao' })
    );
    expect(await screen.findByText('LISTA DEVOLUÇÕES')).toBeInTheDocument();
  });

  it('erro do servidor (pedido não faturado) aparece na página', async () => {
    const { ApiError } = await import('../lib/api');
    apiPost.mockRejectedValue(new ApiError(409, 'Só pedido faturado ou entregue pode ser devolvido.') as never);
    montar(<DevolucaoNovaPage />, '/devolucoes/nova');
    fireEvent.change(await screen.findByLabelText(/Pedido \(venda\)/), { target: { value: '9' } });
    fireEvent.change(screen.getByLabelText('Motivo'), { target: { value: 'Peça com defeito' } });
    fireEvent.click(screen.getByRole('button', { name: /^Solicitar$/ }));
    expect(await screen.findByText('Só pedido faturado ou entregue pode ser devolvido.')).toBeInTheDocument();
  });
});

describe('WebhookFormPage — cadastro em página', () => {
  const LISTA = {
    webhooks: [{ id: 5, nome: 'SIEM', url: 'https://siem.local/hook', eventos: ['usuario.criado'], ativo: true, tem_segredo: true }],
    eventos_disponiveis: [
      { id: 'usuario.criado', label: 'Usuário criado' },
      { id: 'usuario.desativado', label: 'Usuário desativado' },
    ],
  };

  it('cria o webhook e mostra o segredo UMA vez na própria página', async () => {
    apiGet.mockResolvedValue(LISTA as never);
    apiPost.mockResolvedValue({ segredo: 'seg-123' } as never);
    montar(<WebhookFormPage modo="novo" />, '/webhooks/novo');
    fireEvent.change(await screen.findByLabelText('Nome *'), { target: { value: 'SIEM' } });
    fireEvent.change(screen.getByLabelText(/URL do receptor/), { target: { value: 'https://siem.local/hook' } });
    fireEvent.click(screen.getByLabelText(/Usuário criado/));
    fireEvent.click(screen.getByRole('button', { name: /Salvar webhook/ }));
    await waitFor(() =>
      expect(apiPost).toHaveBeenCalledWith('/webhooks', {
        nome: 'SIEM',
        url: 'https://siem.local/hook',
        eventos: ['usuario.criado'],
        ativo: true,
      })
    );
    expect(await screen.findByDisplayValue('seg-123')).toBeInTheDocument();
    expect(screen.getByText(/aparece/)).toBeInTheDocument();
    expect(apiPut).not.toHaveBeenCalled();
  });

  it('edição carrega o registro, envia PUT e volta para a lista', async () => {
    apiGet.mockResolvedValue(LISTA as never);
    apiPut.mockResolvedValue({} as never);
    montar(<WebhookFormPage modo="editar" />, '/webhooks/5/editar', '/webhooks/:id/editar');
    await waitFor(() => expect((screen.getByLabelText('Nome *') as HTMLInputElement).value).toBe('SIEM'));
    fireEvent.click(screen.getByRole('button', { name: /Salvar webhook/ }));
    await waitFor(() =>
      expect(apiPut).toHaveBeenCalledWith('/webhooks/5', { nome: 'SIEM', url: 'https://siem.local/hook', eventos: ['usuario.criado'], ativo: true })
    );
    expect(await screen.findByText('LISTA WEBHOOKS')).toBeInTheDocument();
  });

  it('não salva sem evento escolhido', async () => {
    apiGet.mockResolvedValue(LISTA as never);
    montar(<WebhookFormPage modo="novo" />, '/webhooks/novo');
    fireEvent.change(await screen.findByLabelText('Nome *'), { target: { value: 'X' } });
    fireEvent.change(screen.getByLabelText(/URL do receptor/), { target: { value: 'https://x.local' } });
    expect((screen.getByRole('button', { name: /Salvar webhook/ }) as HTMLButtonElement).disabled).toBe(true);
    expect(apiPost).not.toHaveBeenCalled();
  });
});

describe('ImportarPage — tipo inválido é recusado na página', () => {
  it('mostra os tipos aceitos quando a rota não existe', async () => {
    montar(<ImportarPage />, '/importar/planilha-magica');
    expect(await screen.findByText(/Não existe importação para/)).toBeInTheDocument();
    // Nenhuma chamada ao servidor: o tipo é validado antes.
    expect(apiPost).not.toHaveBeenCalled();
  });
});
