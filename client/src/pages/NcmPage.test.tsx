// ============================================================================
// NCM / TRIBUTAÇÃO — contrato de tela (ERP-05, fecha o P1-02 do lado do front).
//
// `impostos_ncm` tinha CRUD na API e NENHUM consumo no cliente (o `audit:menu`
// acusava `[RECURSO_SEM_MENU]`). O que estes testes travam:
//   • a tela lê o servidor (`GET /impostos_ncm`) e não calcula imposto sozinha;
//   • a linha de chave vazia aparece como PADRÃO — e a tela DIZ qual é a
//     alíquota padrão; sem ela, avisa que os NCMs sem chave ficam em 0%;
//   • cadastrar/editar/excluir chamam a API do recurso, com a alíquota numérica;
//   • operador (que não pode alterar no servidor) não vê os botões de escrita;
//   • erro do servidor aparece na tela, não num alerta genérico.
// ============================================================================
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import NcmPage from './NcmPage';
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

const mockUser: { perfil: 'admin' | 'gerente' | 'operador' } = { perfil: 'gerente' };
vi.mock('../auth/AuthContext', () => ({ useAuth: () => ({ user: mockUser }) }));

const apiGet = vi.mocked(api.get);
const apiPost = vi.mocked(api.post);
const apiPut = vi.mocked(api.put);
const apiDel = vi.mocked(api.del);

const LINHAS = {
  rows: [
    { id: 7, ncm: null, descricao: 'Padrão da casa', aliquota_pct: 5, criado_em: '2026-10-01T12:00:00Z' },
    { id: 3, ncm: '61091000', descricao: 'Camisetas de malha', aliquota_pct: 12, atualizado_em: '2026-10-02T12:00:00Z' },
    { id: 2, ncm: '6109', descricao: 'Malha (prefixo)', aliquota_pct: 8.5, criado_em: '2026-09-30T12:00:00Z' },
  ],
};

function montar() {
  return render(
    <ToastProvider>
      <NcmPage />
    </ToastProvider>
  );
}

describe('NcmPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUser.perfil = 'gerente';
    apiGet.mockResolvedValue(LINHAS);
  });

  it('lê as alíquotas do servidor e mostra a chave, o percentual e o PADRÃO', async () => {
    montar();
    expect(await screen.findByText('61091000')).toBeInTheDocument();
    expect(screen.getByText('6109')).toBeInTheDocument();
    expect(screen.getByText('PADRÃO')).toBeInTheDocument();
    expect(screen.getByText('12%')).toBeInTheDocument();
    expect(screen.getByText('8,5%')).toBeInTheDocument();
    expect(screen.getByText('Camisetas de malha')).toBeInTheDocument();
    expect(apiGet).toHaveBeenCalledWith(expect.stringContaining('/impostos_ncm'));
  });

  it('diz qual é a alíquota padrão vigente (não deixa o operador adivinhar)', async () => {
    montar();
    expect(await screen.findByText(/alíquota padrão \(NCMs sem chave cadastrada\) é 5%/)).toBeInTheDocument();
  });

  it('sem linha padrão, avisa que o imposto dos NCMs sem chave fica em 0%', async () => {
    apiGet.mockResolvedValue({ rows: [LINHAS.rows[1]] });
    montar();
    expect(await screen.findByText(/NÃO existe linha padrão/)).toBeInTheDocument();
  });

  it('cadastra uma alíquota nova enviando a chave só com dígitos e o percentual numérico', async () => {
    apiPost.mockResolvedValue({ id: 9 });
    montar();
    fireEvent.click(await screen.findByText('Nova alíquota'));
    fireEvent.change(screen.getByPlaceholderText(/61091000/), { target: { value: '6109-10' } });
    fireEvent.change(screen.getByPlaceholderText('12'), { target: { value: '7,5' } });
    fireEvent.click(screen.getByText('Salvar'));

    await waitFor(() =>
      expect(apiPost).toHaveBeenCalledWith('/impostos_ncm', { ncm: '610910', descricao: null, aliquota_pct: 7.5 })
    );
  });

  it('recusa alíquota fora de 0–100 sem chamar a API', async () => {
    montar();
    fireEvent.click(await screen.findByText('Nova alíquota'));
    fireEvent.change(screen.getByPlaceholderText('12'), { target: { value: '150' } });
    fireEvent.click(screen.getByText('Salvar'));
    expect(await screen.findByText('Informe uma alíquota entre 0 e 100.')).toBeInTheDocument();
    expect(apiPost).not.toHaveBeenCalled();
  });

  it('edita a linha existente com PUT no registro certo', async () => {
    apiPut.mockResolvedValue({ id: 2 });
    montar();
    await screen.findByText('6109');
    const botoes = screen.getAllByTitle('Editar');
    // A lista vem na ordem do servidor: [PADRÃO(7), 61091000(3), 6109(2)].
    fireEvent.click(botoes[2]);
    expect(await screen.findByText('Editar chave 6109')).toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText('12'), { target: { value: '9' } });
    fireEvent.click(screen.getByText('Salvar'));
    await waitFor(() => expect(apiPut).toHaveBeenCalledWith('/impostos_ncm/2', { ncm: '6109', descricao: 'Malha (prefixo)', aliquota_pct: 9 }));
  });

  it('excluir exige confirmação e explica o efeito da linha PADRÃO antes de apagar', async () => {
    apiDel.mockResolvedValue({ ok: true });
    montar();
    await screen.findByText('PADRÃO');
    fireEvent.click(screen.getAllByTitle('Excluir')[0]);
    expect(await screen.findByText(/é o que define o imposto dos NCMs sem chave/)).toBeInTheDocument();
    fireEvent.click(screen.getByText('Excluir', { selector: 'button' }));
    await waitFor(() => expect(apiDel).toHaveBeenCalledWith('/impostos_ncm/7'));
  });

  it('busca filtra por chave e por descrição', async () => {
    montar();
    await screen.findByText('61091000');
    fireEvent.change(screen.getByPlaceholderText('Buscar NCM ou descrição...'), { target: { value: '61091000' } });
    await waitFor(() => expect(screen.queryByText('8,5%')).not.toBeInTheDocument());
    expect(screen.getByText('12%')).toBeInTheDocument();
    expect(screen.queryByText('PADRÃO')).not.toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText('Buscar NCM ou descrição...'), { target: { value: 'padrão da casa' } });
    expect(await screen.findByText('PADRÃO')).toBeInTheDocument();
    expect(screen.queryByText('12%')).not.toBeInTheDocument();
  });

  it('operador vê a lista, mas não os botões de escrita (o servidor exige gerente)', async () => {
    mockUser.perfil = 'operador';
    montar();
    await screen.findByText('61091000');
    expect(screen.queryByText('Nova alíquota')).not.toBeInTheDocument();
    expect(screen.queryAllByTitle('Editar')).toHaveLength(0);
    expect(screen.queryAllByTitle('Excluir')).toHaveLength(0);
  });

  it('erro do servidor ao salvar aparece na tela', async () => {
    apiPost.mockRejectedValue(new Error('Banco indisponível'));
    montar();
    fireEvent.click(await screen.findByText('Nova alíquota'));
    fireEvent.change(screen.getByPlaceholderText('12'), { target: { value: '5' } });
    fireEvent.click(screen.getByText('Salvar'));
    await waitFor(() => expect(screen.getByText('Não foi possível salvar.')).toBeInTheDocument());
  });
});
