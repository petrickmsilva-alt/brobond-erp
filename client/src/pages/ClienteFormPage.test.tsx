// ============================================================================
// Cadastro de clientes PF/PJ — página própria (fora do modal).
//
// Trava o contrato de UX: seletor PF/PJ acessível que troca os campos
// dinamicamente (nunca CPF e CNPJ juntos), máscaras brasileiras, validação com
// mensagem próxima ao campo, normalização no payload, aviso de duplicidade com
// [Abrir cliente], e os fluxos criar/editar/cancelar/salvar sem perder o que
// foi digitado quando o backend recusa.
// ============================================================================
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import ClienteFormPage from './ClienteFormPage';
import { ToastProvider } from '../components/ui';
import { api, ApiError } from '../lib/api';

const navigateMock = vi.fn();
let routeParams: Record<string, string> = {};

vi.mock('../lib/api', () => {
  class ApiErrorMock extends Error {
    status: number;
    fields?: Record<string, string>;
    code?: string;
    constructor(status: number, message: string, fields?: Record<string, string>, code?: string) {
      super(message);
      this.status = status;
      this.fields = fields;
      this.code = code;
    }
  }
  return {
    api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), del: vi.fn() },
    ApiError: ApiErrorMock,
    downloadFile: vi.fn(),
  };
});

vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>();
  return {
    ...actual,
    useParams: () => routeParams,
    useNavigate: () => navigateMock,
  };
});

vi.mock('../lib/meta', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/meta')>();
  const clientes = {
    key: 'clientes',
    label: 'Clientes',
    singular: 'Cliente',
    labelFields: ['nome'],
    ops: { create: true, update: true, delete: true },
    fields: [],
  };
  return {
    ...actual,
    useMeta: () => ({ resources: { clientes }, modules: [] }),
  };
});

const apiGet = vi.mocked(api.get);
const apiPost = vi.mocked(api.post);
const apiPut = vi.mocked(api.put);

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/clientes/novo']}>
      <ToastProvider>
        <ClienteFormPage />
      </ToastProvider>
    </MemoryRouter>
  );
}

beforeEach(() => {
  routeParams = {};
  navigateMock.mockReset();
  apiGet.mockReset();
  apiPost.mockReset();
  apiPut.mockReset();
  apiGet.mockImplementation(async (path: string) => {
    if (String(path).startsWith('/representantes/options')) return [] as never;
    if (String(path).startsWith('/clientes/por-documento')) return { cliente: null, disponivel: true } as never;
    return {} as never;
  });
  apiPost.mockResolvedValue({ id: 99 } as never);
  apiPut.mockResolvedValue({ id: 5 } as never);
});

describe('seletor PF/PJ', () => {
  it('começa em PJ com CNPJ, razão social e nome fantasia — sem CPF', async () => {
    renderPage();
    expect(await screen.findByLabelText(/Razão social/)).toBeTruthy();
    expect(screen.getByLabelText(/Nome fantasia/)).toBeTruthy();
    expect(screen.getByLabelText(/CNPJ/)).toBeTruthy();
    expect(screen.queryByLabelText(/^CPF/)).toBeNull();
    expect(screen.queryByLabelText(/Nome completo/)).toBeNull();
  });

  it('trocar para Pessoa Física mostra CPF e nome completo e esconde os campos PJ', async () => {
    renderPage();
    const radioPF = await screen.findByLabelText(/Pessoa Física/);
    fireEvent.click(radioPF);
    expect(await screen.findByLabelText(/^CPF/)).toBeTruthy();
    expect(screen.getByLabelText(/Nome completo/)).toBeTruthy();
    expect(screen.getByLabelText(/^RG/)).toBeTruthy();
    expect(screen.queryByLabelText(/Razão social/)).toBeNull();
    expect(screen.queryByLabelText(/Nome fantasia/)).toBeNull();
    expect(screen.queryByLabelText(/Inscrição estadual/)).toBeNull();
  });

  it('trocar PF↔PJ limpa o documento quando o tamanho não bate com o novo tipo', async () => {
    renderPage();
    fireEvent.click(await screen.findByLabelText(/Pessoa Física/));
    const cpf = screen.getByLabelText(/^CPF/) as HTMLInputElement;
    fireEvent.change(cpf, { target: { value: '52998224725' } });
    expect(cpf.value).toBe('529.982.247-25');

    fireEvent.click(screen.getByLabelText(/Pessoa Jurídica/));
    const cnpj = screen.getByLabelText(/CNPJ/) as HTMLInputElement;
    // o CPF de 11 dígitos não sobrevive à troca para PJ
    expect(cnpj.value).toBe('');

    fireEvent.change(cnpj, { target: { value: '11222333000181' } });
    expect(cnpj.value).toBe('11.222.333/0001-81');
    fireEvent.click(screen.getByLabelText(/Pessoa Física/));
    expect((screen.getByLabelText(/^CPF/) as HTMLInputElement).value).toBe('');
  });

  it('o seletor é um radiogroup acessível por teclado (radios nativos)', async () => {
    renderPage();
    const radioPF = (await screen.findByLabelText(/Pessoa Física/)) as HTMLInputElement;
    expect(radioPF.type).toBe('radio');
    expect(radioPF.name).toBe('pessoa');
    fireEvent.keyDown(radioPF, { key: 'ArrowRight' });
    // foco/estado: o radio PJ continua sendo input nativo (navegação padrão do browser)
    expect((screen.getByLabelText(/Pessoa Jurídica/) as HTMLInputElement).type).toBe('radio');
  });
});

describe('máscaras brasileiras', () => {
  it('CPF: 000.000.000-00 · CNPJ: 00.000.000/0000-00 · CEP: 00000-000 · telefone: +55 (DD) …', async () => {
    renderPage();
    fireEvent.click(await screen.findByLabelText(/Pessoa Física/));
    const cpf = screen.getByLabelText(/^CPF/) as HTMLInputElement;
    fireEvent.change(cpf, { target: { value: '52998224725' } });
    expect(cpf.value).toBe('529.982.247-25');

    const telefone = screen.getByLabelText(/^Telefone/) as HTMLInputElement;
    fireEvent.change(telefone, { target: { value: '6233334444' } });
    // fixo com 8 dígitos
    expect(telefone.value).toBe('+55 (62) 3333-4444');
    fireEvent.change(telefone, { target: { value: '62999999999' } });
    // celular com 9 dígitos
    expect(telefone.value).toBe('+55 (62) 99999-9999');

    const cep = screen.getByLabelText(/^CEP/) as HTMLInputElement;
    fireEvent.change(cep, { target: { value: '74000000' } });
    expect(cep.value).toBe('74000-000');

    fireEvent.click(screen.getByLabelText(/Pessoa Jurídica/));
    const cnpj = screen.getByLabelText(/CNPJ/) as HTMLInputElement;
    fireEvent.change(cnpj, { target: { value: '11222333000181' } });
    expect(cnpj.value).toBe('11.222.333/0001-81');
  });

  it('limite de crédito usa máscara monetária BR (R$ 1.500,50)', async () => {
    renderPage();
    const limite = await screen.findByLabelText(/Limite de crédito/) as HTMLInputElement;
    fireEvent.change(limite, { target: { value: '1500,50' } });
    expect(limite.value).toBe('1.500,50');
    fireEvent.change(limite, { target: { value: '25999,90' } });
    expect(limite.value).toBe('25.999,90');
  });

  it('UF é select fechado com as 27 UFs (não aceita texto livre)', async () => {
    renderPage();
    const uf = (await screen.findByLabelText(/^UF$/)) as HTMLSelectElement;
    expect(uf.tagName).toBe('SELECT');
    const opcoes = Array.from(uf.options).map((o) => o.value).filter(Boolean);
    expect(opcoes).toHaveLength(27);
    expect(opcoes).toContain('GO');
    expect(opcoes).toContain('SP');
  });
});

describe('validação com mensagem clara', () => {
  it('CPF inválido mostra "CPF inválido." e não chama a API', async () => {
    renderPage();
    fireEvent.click(await screen.findByLabelText(/Pessoa Física/));
    fireEvent.change(screen.getByLabelText(/^CPF/), { target: { value: '529.982.247-26' } });
    fireEvent.change(screen.getByLabelText(/Nome completo/), { target: { value: 'Maria da Silva' } });
    fireEvent.click(screen.getAllByRole('button', { name: /Salvar cliente/ })[0]);
    expect(await screen.findByText('CPF inválido.')).toBeTruthy();
    expect(apiPost).not.toHaveBeenCalled();
  });

  it('CNPJ inválido mostra "CNPJ inválido."', async () => {
    renderPage();
    fireEvent.change(await screen.findByLabelText(/CNPJ/), { target: { value: '11.222.333/0001-82' } });
    fireEvent.change(screen.getByLabelText(/Razão social/), { target: { value: 'Loja Centro LTDA' } });
    fireEvent.click(screen.getAllByRole('button', { name: /Salvar cliente/ })[0]);
    expect(await screen.findByText('CNPJ inválido.')).toBeTruthy();
    expect(apiPost).not.toHaveBeenCalled();
  });

  it('razão social obrigatória em PJ; nome completo obrigatório em PF', async () => {
    renderPage();
    fireEvent.click(screen.getAllByRole('button', { name: /Salvar cliente/ })[0]);
    expect(await screen.findByText('Informe a razão social.')).toBeTruthy();

    fireEvent.click(screen.getByLabelText(/Pessoa Física/));
    fireEvent.click(screen.getAllByRole('button', { name: /Salvar cliente/ })[0]);
    expect(await screen.findByText('Informe o nome completo.')).toBeTruthy();
    expect(apiPost).not.toHaveBeenCalled();
  });

  it('e-mail inválido mostra "E-mail inválido."', async () => {
    renderPage();
    fireEvent.change(await screen.findByLabelText(/Razão social/), { target: { value: 'Loja Centro LTDA' } });
    fireEvent.change(screen.getByLabelText(/E-mail/), { target: { value: 'fulano@sem-dominio' } });
    fireEvent.click(screen.getAllByRole('button', { name: /Salvar cliente/ })[0]);
    expect(await screen.findByText('E-mail inválido.')).toBeTruthy();
    expect(apiPost).not.toHaveBeenCalled();
  });

  it('telefone com letra/tamanho errado é recusado com mensagem profissional', async () => {
    renderPage();
    const telefone = (await screen.findByLabelText(/^Telefone/)) as HTMLInputElement;
    fireEvent.change(telefone, { target: { value: '62 89999-9999' } });
    fireEvent.change(screen.getByLabelText(/Razão social/), { target: { value: 'Loja Centro LTDA' } });
    fireEvent.click(screen.getAllByRole('button', { name: /Salvar cliente/ })[0]);
    expect(await screen.findByText(/Telefone inválido/)).toBeTruthy();
    expect(apiPost).not.toHaveBeenCalled();
    // o valor digitado NÃO é limpo pelo erro
    expect((screen.getByLabelText(/^Telefone/) as HTMLInputElement).value).toBe('+55 (62) 89999-9999');
  });
});

describe('duplicidade de CPF/CNPJ', () => {
  it('avisa "Já existe um cliente cadastrado com este CPF." e oferece [Abrir cliente]', async () => {
    apiGet.mockImplementation(async (path: string) => {
      if (String(path).startsWith('/representantes/options')) return [] as never;
      if (String(path).startsWith('/clientes/por-documento')) {
        return { cliente: { id: 42, nome: 'Maria Antiga', cnpj_cpf: '529.982.247-25' }, disponivel: false } as never;
      }
      return {} as never;
    });
    renderPage();
    fireEvent.click(await screen.findByLabelText(/Pessoa Física/));
    fireEvent.change(screen.getByLabelText(/^CPF/), { target: { value: '52998224725' } });

    expect(await screen.findByText(/Já existe um cliente cadastrado com este CPF/)).toBeTruthy();
    const link = screen.getByRole('link', { name: /Abrir cliente/ });
    expect(link.getAttribute('href')).toBe('/clientes/42/editar');
  });

  it('o servidor é a decisão final: recusa 409 do backend vira o mesmo aviso', async () => {
    apiPost.mockRejectedValue(
      new ApiError(409, 'Já existe um cliente cadastrado com este CPF.', { cnpj_cpf: 'Já existe um cliente cadastrado com este CPF.' }, 'cliente_duplicado')
    );
    apiGet.mockImplementation(async (path: string) => {
      if (String(path).startsWith('/representantes/options')) return [] as never;
      if (String(path).startsWith('/clientes/por-documento')) {
        return { cliente: { id: 7, nome: 'Dono Atual', cnpj_cpf: '529.982.247-25' }, disponivel: false } as never;
      }
      return {} as never;
    });
    renderPage();
    fireEvent.click(await screen.findByLabelText(/Pessoa Física/));
    fireEvent.change(screen.getByLabelText(/^CPF/), { target: { value: '52998224725' } });
    fireEvent.change(screen.getByLabelText(/Nome completo/), { target: { value: 'Maria Nova' } });
    fireEvent.click(screen.getAllByRole('button', { name: /Salvar cliente/ })[0]);

    const avisos = await screen.findAllByText(/Já existe um cliente cadastrado com este CPF/);
    expect(avisos.length).toBeGreaterThanOrEqual(1);
    expect(screen.getByRole('link', { name: /Abrir cliente/ }).getAttribute('href')).toBe('/clientes/7/editar');
    // nada foi perdido
    expect((screen.getByLabelText(/Nome completo/) as HTMLInputElement).value).toBe('Maria Nova');
  });
});

describe('fluxos', () => {
  it('criar: envia payload NORMALIZADO (documento/telefone/CEP em dígitos, moeda em número) e volta à lista', async () => {
    renderPage();
    fireEvent.click(await screen.findByLabelText(/Pessoa Física/));
    fireEvent.change(screen.getByLabelText(/^CPF/), { target: { value: '529.982.247-25' } });
    fireEvent.change(screen.getByLabelText(/Nome completo/), { target: { value: '  Maria   da  Silva ' } });
    fireEvent.change(screen.getByLabelText(/^Telefone/), { target: { value: '62 3333-4444' } });
    fireEvent.change(screen.getByLabelText(/E-mail/), { target: { value: ' cliente@empresa.com.br ' } });
    fireEvent.change(screen.getByLabelText(/^CEP/), { target: { value: '74000-000' } });
    fireEvent.change(screen.getByLabelText(/Limite de crédito/), { target: { value: '1.500,50' } });

    fireEvent.click(screen.getAllByRole('button', { name: /Salvar cliente/ })[0]);

    await waitFor(() => expect(apiPost).toHaveBeenCalledTimes(1));
    const [path, payload] = apiPost.mock.calls[0] as [string, any];
    expect(path).toBe('/clientes');
    expect(payload.pessoa).toBe('pf');
    expect(payload.cnpj_cpf).toBe('52998224725');
    expect(payload.telefone).toBe('6233334444');
    expect(payload.email).toBe('cliente@empresa.com.br');
    expect(payload.cep).toBe('74000000');
    expect(payload.limite_credito).toBe(1500.5);
    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith('/clientes'));
  });

  it('editar: carrega o registro, aplica máscaras e envia PUT', async () => {
    routeParams = { id: '5' };
    apiGet.mockImplementation(async (path: string) => {
      if (String(path).startsWith('/representantes/options')) return [] as never;
      if (String(path).startsWith('/clientes/por-documento')) return { cliente: null, disponivel: true } as never;
      return {
        id: 5,
        pessoa: 'pj',
        nome: 'Loja Centro',
        razao_social: 'Loja Centro Comércio LTDA',
        nome_fantasia: 'Loja Centro',
        cnpj_cpf: '11222333000181',
        telefone: '6233334444',
        email: 'loja@exemplo.com.br',
        limite_credito: 25999.9,
        ativo: true,
      } as never;
    });
    renderPage();

    const razao = (await screen.findByLabelText(/Razão social/)) as HTMLInputElement;
    await waitFor(() => expect(razao.value).toBe('Loja Centro Comércio LTDA'));
    expect((screen.getByLabelText(/CNPJ/) as HTMLInputElement).value).toBe('11.222.333/0001-81');
    expect((screen.getByLabelText(/^Telefone/) as HTMLInputElement).value).toBe('+55 (62) 3333-4444');
    expect((screen.getByLabelText(/Limite de crédito/) as HTMLInputElement).value).toBe('25.999,90');

    fireEvent.click(screen.getAllByRole('button', { name: /Salvar alterações/ })[0]);
    await waitFor(() => expect(apiPut).toHaveBeenCalledTimes(1));
    const [path, payload] = apiPut.mock.calls[0] as [string, any];
    expect(path).toBe('/clientes/5');
    expect(payload.cnpj_cpf).toBe('11222333000181');
    expect(payload.telefone).toBe('6233334444');
    expect(payload.limite_credito).toBe(25999.9);
    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith('/clientes'));
  });

  it('cancelar volta para a lista sem chamar a API', async () => {
    renderPage();
    fireEvent.click((await screen.findAllByRole('button', { name: /Cancelar/ }))[0]);
    expect(navigateMock).toHaveBeenCalledWith('/clientes');
    expect(apiPost).not.toHaveBeenCalled();
    expect(apiPut).not.toHaveBeenCalled();
  });

  it('erro do backend mantém o que foi digitado e mostra a mensagem', async () => {
    apiPost.mockRejectedValue(new ApiError(400, 'Verifique os campos: E-mail inválido.', { email: 'E-mail inválido.' }));
    renderPage();
    fireEvent.click(await screen.findByLabelText(/Pessoa Física/));
    fireEvent.change(screen.getByLabelText(/^CPF/), { target: { value: '52998224725' } });
    fireEvent.change(screen.getByLabelText(/Nome completo/), { target: { value: 'Maria da Silva' } });
    fireEvent.change(screen.getByLabelText(/E-mail/), { target: { value: 'maria@empresa.com.br' } });
    fireEvent.click(screen.getAllByRole('button', { name: /Salvar cliente/ })[0]);

    expect(await screen.findByText(/Verifique os campos/)).toBeTruthy();
    expect(screen.getByText('E-mail inválido.')).toBeTruthy();
    // o form não pode ser limpo
    expect((screen.getByLabelText(/Nome completo/) as HTMLInputElement).value).toBe('Maria da Silva');
    await waitFor(() => expect(navigateMock).not.toHaveBeenCalled());
  });

  it('exibe estado de carregamento ao abrir para edição', async () => {
    routeParams = { id: '5' };
    apiGet.mockImplementation(async (path: string) => {
      if (String(path).startsWith('/representantes/options')) return [] as never;
      if (String(path).startsWith('/clientes/por-documento')) return { cliente: null } as never;
      await new Promise((r) => setTimeout(r, 30));
      return { id: 5, pessoa: 'pf', nome: 'Maria', cnpj_cpf: '52998224725' } as never;
    });
    renderPage();
    expect(screen.getByText(/Carregando cliente/)).toBeTruthy();
    expect(await screen.findByLabelText(/Nome completo/)).toBeTruthy();
  });
});
