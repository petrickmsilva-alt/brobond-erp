// ============================================================================
// EMPRESAS — contrato de tela (ERP-07, fecha o P1-04 do lado do front).
//
// O recurso `empresas` tinha CRUD na API e era invisível: nenhuma entrada em
// `MODULES`, nenhum consumo no cliente, e — o que a auditoria só viu depois —
// nenhuma alçada no servidor (o `audit:menu` não sinalizava: ponto cego P2-05).
// O que estes testes travam:
//   • a tela lê e escreve pelo SERVIDOR (`/empresas`), sem regra própria;
//   • a empresa padrão (id 1) aparece avisada e NÃO pode ser desativada nem
//     excluída pela tela (e o servidor também recusa — teste em `empresas-admin`);
//   • a mensagem da GUARDA do servidor é o que aparece quando a exclusão é
//     recusada (não um "erro" genérico);
//   • os ACESSOS usam os endpoints de `usuario_empresas` (conceder/revogar).
// ============================================================================
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import EmpresasPage from './EmpresasPage';
import { ToastProvider } from '../components/ui';
import { api } from '../lib/api';

vi.mock('../lib/api', () => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), del: vi.fn() },
  ApiError: class ApiError extends Error {
    status: number;
    fields?: Record<string, string>;
    constructor(status: number, message: string, fields?: Record<string, string>) {
      super(message);
      this.name = 'ApiError';
      this.status = status;
      this.fields = fields;
    }
  },
}));

const mockUser: { perfil: 'admin' | 'gerente' | 'operador' } = { perfil: 'admin' };
vi.mock('../auth/AuthContext', () => ({ useAuth: () => ({ user: mockUser }) }));

const apiGet = vi.mocked(api.get);
const apiPost = vi.mocked(api.post);
const apiPut = vi.mocked(api.put);
const apiDel = vi.mocked(api.del);
const { ApiError } = await import('../lib/api');

const EMPRESAS = {
  rows: [
    { id: 1, nome: 'BROBOND', razao_social: 'BROBOND CONFECÇÕES LTDA', cnpj: '11222333000181', ativo: true },
    { id: 7, nome: 'FILIAL SUL', razao_social: 'FILIAL SUL LTDA', cnpj: '11444777000161', ativo: false },
  ],
};

const USUARIOS = {
  rows: [
    { id: 11, nome: 'Ana Admin', email: 'ana@teste.local', perfil: 'admin', ativo: true },
    { id: 12, nome: 'Bruno Gerente', email: 'bruno@teste.local', perfil: 'gerente', ativo: true },
  ],
};

function responder(routes: Record<string, unknown> = {}) {
  apiGet.mockImplementation(async (path: string) => {
    for (const [chave, valor] of Object.entries(routes)) {
      if (path.startsWith(chave)) {
        if (valor instanceof Error) throw valor;
        return valor as any;
      }
    }
    if (path.startsWith('/empresas')) return EMPRESAS as any;
    if (path.startsWith('/usuarios/11/empresas')) return { usuario_id: 11, empresas: [{ id: 1, nome: 'BROBOND' }] } as any;
    if (path.startsWith('/usuarios/12/empresas')) return { usuario_id: 12, empresas: [] } as any;
    if (path.startsWith('/usuarios')) return USUARIOS as any;
    throw new Error(`rota não esperada no teste: ${path}`);
  });
}

function montar() {
  return render(
    <ToastProvider>
      <EmpresasPage />
    </ToastProvider>
  );
}

describe('EmpresasPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    responder();
  });

  it('lista as empresas do servidor com situação e CNPJ mascarado', async () => {
    montar();

    await waitFor(() => expect(screen.getByText('FILIAL SUL')).toBeTruthy());
    expect(apiGet).toHaveBeenCalledWith(expect.stringContaining('/empresas?page=1'));
    expect(screen.getByText(/11\.222\.333\/0001-81/)).toBeTruthy();
    expect(screen.getByText('FILIAL SUL')).toBeTruthy();
    expect(screen.getByText('ativa')).toBeTruthy();
    expect(screen.getByText('desativada')).toBeTruthy();
    expect(screen.getByText(/11\.222\.333\/0001-81/)).toBeTruthy();
  });

  it('avisa que a empresa padrão não é excluível e desabilita as ações destrutivas dela', async () => {
    montar();
    await waitFor(() => expect(screen.getByText('FILIAL SUL')).toBeTruthy());

    expect(screen.getByText(/empresa padrão \(id 1\)/i)).toBeTruthy();
    // A ordem das linhas é a do servidor: BROBOND (padrão) primeiro.
    const desativar = screen.getAllByRole('button', { name: /^Desativar$/ });
    const excluir = screen.getAllByRole('button', { name: /^Excluir$/ });
    expect(desativar).toHaveLength(1);
    expect(desativar[0]).toBeDisabled();
    expect(excluir[0]).toBeDisabled();
    expect(excluir[1]).not.toBeDisabled();
  });

  it('cria empresa pelo servidor', async () => {
    apiPost.mockResolvedValue({ id: 9 } as any);
    montar();
    await waitFor(() => expect(screen.getByText('FILIAL SUL')).toBeTruthy());

    await userEvent.click(screen.getByRole('button', { name: /Nova empresa/i }));
    await userEvent.type(screen.getByLabelText(/Nome \*/i), 'FILIAL NORTE');
    await userEvent.type(screen.getByLabelText('CNPJ'), '11222333000181');
    await userEvent.click(screen.getByRole('button', { name: /^Salvar$/i }));

    await waitFor(() =>
      expect(apiPost).toHaveBeenCalledWith('/empresas', expect.objectContaining({ nome: 'FILIAL NORTE', cnpj: '11222333000181' }))
    );
  });

  it('edita empresa (PUT) e alterna a situação', async () => {
    apiPut.mockResolvedValue({} as any);
    montar();
    await waitFor(() => expect(screen.getByText('FILIAL SUL')).toBeTruthy());

    await userEvent.click(screen.getAllByTitle('Editar')[1]);
    const campoNome = screen.getByLabelText(/Nome \*/i);
    await userEvent.clear(campoNome);
    await userEvent.type(campoNome, 'FILIAL SUL II');
    await userEvent.click(screen.getByRole('button', { name: /^Salvar$/i }));

    await waitFor(() => expect(apiPut).toHaveBeenCalledWith('/empresas/7', expect.objectContaining({ nome: 'FILIAL SUL II' })));

    await userEvent.click(screen.getAllByTitle('Reativar')[0]);
    await waitFor(() => expect(apiPut).toHaveBeenCalledWith('/empresas/7', { ativo: true }));
  });

  it('excluir: a RECUSA do servidor aparece como veio (guarda de empresa com dados)', async () => {
    apiDel.mockRejectedValue(
      new ApiError(409, 'A empresa "FILIAL SUL" tem registros de Produtos (3) vinculados a ela. Excluir apagaria vínculos do histórico — desative a empresa em vez de excluí-la.')
    );
    montar();
    await waitFor(() => expect(screen.getByText('FILIAL SUL')).toBeTruthy());

    // Linha 0 é a empresa padrão (botão desabilitado): a exclusão é a da FILIAL SUL.
    await userEvent.click(screen.getAllByTitle('Excluir')[1]);
    // O diálogo tem um botão "Excluir" próprio, além do ícone da linha.
    const botoesExcluir = screen.getAllByRole('button', { name: /^Excluir$/ });
    await userEvent.click(botoesExcluir[botoesExcluir.length - 1]);

    await waitFor(() => expect(apiDel).toHaveBeenCalledWith('/empresas/7'));
    await waitFor(() => expect(screen.getByText(/tem registros de Produtos \(3\)/)).toBeTruthy());
  });

  it('acessos: mostra quem entra na empresa e concede para quem não tem', async () => {
    apiPost.mockResolvedValue({ ok: true } as any);
    montar();
    await waitFor(() => expect(screen.getByText('FILIAL SUL')).toBeTruthy());

    // Acesso é gerenciado pela empresa (linha 7 = FILIAL SUL, sem acessos).
    await userEvent.click(screen.getAllByTitle('Acessos')[1]);

    await waitFor(() => expect(screen.getByText('Ana Admin')).toBeTruthy());
    expect(screen.getByText('Bruno Gerente')).toBeTruthy();
    expect(screen.getAllByText('sem acesso').length).toBe(2);

    await userEvent.click(screen.getAllByRole('button', { name: /Conceder/ })[0]);
    await waitFor(() => expect(apiPost).toHaveBeenCalledWith('/usuarios/11/empresas', { empresa_id: 7 }));
  });

  it('acessos: revoga o acesso de quem já tem', async () => {
    apiDel.mockResolvedValue({} as any);
    montar();
    await waitFor(() => expect(screen.getByText('FILIAL SUL')).toBeTruthy());

    // Acesso gerenciado pela BROBOND (id 1): Ana tem, Bruno não.
    await userEvent.click(screen.getAllByTitle('Acessos')[0]);
    await waitFor(() => expect(screen.getByText('Ana Admin')).toBeTruthy());
    await waitFor(() => expect(screen.getByText('com acesso')).toBeTruthy());

    await userEvent.click(screen.getByRole('button', { name: /Revogar/ }));
    await waitFor(() => expect(apiDel).toHaveBeenCalledWith('/usuarios/11/empresas/1'));
  });

  it('erro do servidor ao carregar aparece na tela', async () => {
    responder({ '/empresas': new ApiError(403, 'Apenas administradores acessam este módulo.') });
    montar();

    await waitFor(() => expect(screen.getByText('Apenas administradores acessam este módulo.')).toBeTruthy());
  });
});
