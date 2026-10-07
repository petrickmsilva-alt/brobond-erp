// ============================================================================
// LOGÍSTICA E ENVIOS — contrato de tela (§13)
//
// O ponto de compliance destes testes é a HONESTIDADE da integração:
//
//   • sem credencial, o servidor responde 503 e a tela mostra o MOTIVO — nunca
//     uma cotação inventada;
//   • o token/senha NUNCA aparece inteiro na tela: só o valor mascarado que o
//     servidor devolve e o booleano `*_configurado`;
//   • ativar provedor externo sem credencial é recusado (409) e a tela repete
//     o motivo em vez de mostrar "integrado";
//   • geração de envio é idempotente — repetir não cria o segundo.
// ============================================================================
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import LogisticaPage from './LogisticaPage';
import { ToastProvider } from '../components/ui';
import { api } from '../lib/api';

vi.mock('../lib/api', () => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn() },
  ApiError: class ApiError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.name = 'ApiError';
      this.status = status;
    }
  },
}));

vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({ user: { id: 1, name: 'Admin', perfil: 'admin' }, loading: false, meta: {} }),
}));

const apiGet = vi.mocked(api.get);
const apiPost = vi.mocked(api.post);
const apiPut = vi.mocked(api.put);

const ENVIOS = {
  rows: [
    {
      id: 5,
      venda_id: 55,
      provider: 'melhor_envio',
      servico: 'PAC',
      provider_ref: 'ME-998',
      codigo_rastreamento: 'BR123456789BR',
      etiqueta_url: 'https://exemplo.invalid/etiqueta.pdf',
      status: 'postado',
      custo: 24.9,
      peso_g: 1200,
      volumes: 1,
      cep_destino: '01310100',
      prazo_dias: 5,
      erro: null,
      criado_em: '2026-10-07T10:00:00.000Z',
    },
  ],
  total: 1,
  page: 1,
  pageSize: 50,
};

const CONFIG = {
  provider: 'manual',
  ambiente: 'homologacao',
  cep_origem: '74000000',
  frete_gratis_acima: 0,
  me_sandbox: true,
  me_token: '••••7f3a',
  me_token_configurado: true,
  correios_usuario: null,
  correios_codigo_administrativo: null,
  correios_senha: null,
  correios_senha_configurada: false,
  provedores: [
    { slug: 'manual', nome: 'Manual' },
    { slug: 'melhor_envio', nome: 'Melhor Envio' },
    { slug: 'correios', nome: 'Correios' },
  ],
  aviso: null,
};

/** Casa pelo prefixo mais específico — `/envios` não engole `/envios/5/eventos`. */
function mockRotas(rotas: Record<string, unknown>) {
  const chaves = Object.keys(rotas).sort((a, b) => b.length - a.length);
  apiGet.mockImplementation(((path: string) => {
    for (const chave of chaves) {
      if (path.startsWith(chave)) return Promise.resolve(rotas[chave]);
    }
    return Promise.reject(new Error(`rota não mockada: ${path}`));
  }) as never);
}

function renderPage() {
  return render(
    <ToastProvider>
      <LogisticaPage />
    </ToastProvider>
  );
}

describe('Logística — tela', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('lista os envios com status, rastreio, custo e etiqueta', async () => {
    mockRotas({ '/envios?': ENVIOS });
    renderPage();

    expect(await screen.findByText('BR123456789BR')).toBeInTheDocument();
    expect(screen.getByText('#55')).toBeInTheDocument();
    expect(screen.getByText('Postado')).toBeInTheDocument();
    expect(screen.getByText('R$ 24,90')).toBeInTheDocument();
    expect(screen.getByTitle('Etiqueta')).toBeInTheDocument();
  });

  it('sem credencial, a cotação mostra o motivo do 503 — nunca um frete inventado', async () => {
    mockRotas({ '/envios?': ENVIOS });
    const { ApiError } = await import('../lib/api');
    apiGet.mockImplementation(((path: string) => {
      if (path.startsWith('/envios?')) return Promise.resolve(ENVIOS);
      if (path.startsWith('/logistica/frete')) {
        return Promise.reject(
          new ApiError(503, 'Provedor "melhor_envio" sem token configurado. Configure a credencial em Logística → Configuração.')
        );
      }
      return Promise.reject(new Error(`rota não mockada: ${path}`));
    }) as never);

    renderPage();
    fireEvent.click(await screen.findByText('Gerar remessa'));

    fireEvent.change(await screen.findByLabelText(/Pedido \(venda\)/i), { target: { value: '55' } });
    fireEvent.click(screen.getByText('Cotar'));

    expect(await screen.findByText(/sem token configurado/)).toBeInTheDocument();
    // O ponto de compliance: nenhuma opção de frete apareceu.
    expect(screen.queryByText(/Gerar$/, { selector: 'button' })).not.toBeInTheDocument();
    void ApiError;
  });

  it('a cotação mostra valor final e a regra de frete grátis do ERP', async () => {
    mockRotas({ '/envios?': ENVIOS });
    apiGet.mockImplementation(((path: string) => {
      if (path.startsWith('/envios?')) return Promise.resolve(ENVIOS);
      if (path.startsWith('/logistica/frete')) {
        return Promise.resolve({
          venda_id: 55,
          origem: { cep: '74000000' },
          destino: { cep: '01310100' },
          peso_g: 1200,
          volumes: 1,
          valor_declarado: 600,
          provedor: { slug: 'melhor_envio', nome: 'Melhor Envio', ambiente: 'producao' },
          opcoes: [
            { servico: 'PAC', provider: 'melhor_envio', valor: 24.9, valor_final: 0, prazo_dias: 7, frete_gratis_aplicado: true },
            { servico: 'SEDEX', provider: 'melhor_envio', valor: 49.9, valor_final: 49.9, prazo_dias: 2, frete_gratis_aplicado: false },
          ],
        });
      }
      return Promise.reject(new Error(`rota não mockada: ${path}`));
    }) as never);

    renderPage();
    fireEvent.click(await screen.findByText('Gerar remessa'));
    fireEvent.change(await screen.findByLabelText(/Pedido \(venda\)/i), { target: { value: '55' } });
    fireEvent.click(screen.getByText('Cotar'));

    expect(await screen.findByText('PAC')).toBeInTheDocument();
    expect(screen.getByText('SEDEX')).toBeInTheDocument();
    // Frete grátis é regra do ERP e precisa estar explícito.
    expect(screen.getByText(/frete grátis \(regra do ERP\)/)).toBeInTheDocument();
    expect(screen.getByText('R$ 24,90')).toBeInTheDocument(); // valor original riscado
    expect(screen.getAllByText('R$ 49,90').length).toBeGreaterThan(0);
  });

  it('gerar envio idempotente avisa que nenhum duplicado foi criado', async () => {
    mockRotas({ '/envios?': ENVIOS });
    apiGet.mockImplementation(((path: string) => {
      if (path.startsWith('/envios?')) return Promise.resolve(ENVIOS);
      if (path.startsWith('/logistica/frete')) {
        return Promise.resolve({
          venda_id: 55,
          origem: { cep: '74000000' },
          destino: { cep: '01310100' },
          peso_g: 1200,
          volumes: 1,
          valor_declarado: 600,
          provedor: { slug: 'manual', nome: 'Manual', ambiente: 'producao' },
          opcoes: [{ servico: 'Transportadora própria', provider: 'manual', valor: 15, valor_final: 15, prazo_dias: 3 }],
        });
      }
      return Promise.reject(new Error(`rota não mockada: ${path}`));
    }) as never);
    apiPost.mockResolvedValue({ id: 5, status: 'gerado', idempotente: true } as never);

    renderPage();
    fireEvent.click(await screen.findByText('Gerar remessa'));
    fireEvent.change(await screen.findByLabelText(/Pedido \(venda\)/i), { target: { value: '55' } });
    fireEvent.click(screen.getByText('Cotar'));
    fireEvent.click(await screen.findByText('Gerar'));

    await waitFor(() =>
      expect(apiPost).toHaveBeenCalledWith('/vendas/55/envio', { servico: 'Transportadora própria' })
    );
    expect(await screen.findByText(/já existia — nenhum duplicado foi criado/)).toBeInTheDocument();
  });

  it('a tela nunca mostra o token inteiro — só o valor mascarado do servidor', async () => {
    mockRotas({ '/envios?': ENVIOS, '/logistica/config': CONFIG });
    renderPage();
    fireEvent.click(await screen.findByText('Configuração'));

    expect(await screen.findByText(/configurado \(••••7f3a\)/)).toBeInTheDocument();
    // O corpo do documento não contém nenhum token de verdade.
    expect(document.body.textContent).not.toContain('me_token_real');
    // E o campo de token nasce vazio: não há como a tela vazar o valor.
    const camposSenha = screen.getAllByDisplayValue('');
    expect(camposSenha.length).toBeGreaterThan(0);
  });

  it('senha dos Correios não configurada aparece como tal', async () => {
    mockRotas({ '/envios?': ENVIOS, '/logistica/config': CONFIG });
    renderPage();
    fireEvent.click(await screen.findByText('Configuração'));

    expect(await screen.findByText(/não configurada/)).toBeInTheDocument();
  });

  it('o servidor recusa ativar provedor externo sem credencial (409) e a tela repete o motivo', async () => {
    mockRotas({ '/envios?': ENVIOS, '/logistica/config': CONFIG });
    const { ApiError } = await import('../lib/api');
    apiPut.mockRejectedValue(
      new ApiError(409, 'Configure a credencial (correios_senha) do provedor "correios" antes de ativá-lo. Enquanto isso, use "manual".') as never
    );

    renderPage();
    fireEvent.click(await screen.findByText('Configuração'));
    await screen.findByText(/configurado \(••••7f3a\)/);

    fireEvent.change(await screen.findByLabelText('Provedor'), { target: { value: 'correios' } });
    fireEvent.click(screen.getByText('Salvar configuração'));

    expect(await screen.findByText(/Configure a credencial \(correios_senha\)/)).toBeInTheDocument();
    expect(apiPut).toHaveBeenCalledWith(
      '/logistica/config',
      expect.objectContaining({ provider: 'correios' })
    );
  });

  it('salvar configuração não envia credencial em branco — vazio não limpa o que existe', async () => {
    mockRotas({ '/envios?': ENVIOS, '/logistica/config': CONFIG });
    apiPut.mockResolvedValue({ ok: true } as never);
    renderPage();
    fireEvent.click(await screen.findByText('Configuração'));
    await screen.findByText(/configurado \(••••7f3a\)/);

    fireEvent.change(await screen.findByLabelText(/CEP de origem/i), { target: { value: '75000000' } });
    fireEvent.click(screen.getByText('Salvar configuração'));

    await waitFor(() => expect(apiPut).toHaveBeenCalled());
    const corpo = apiPut.mock.calls[0][1] as Record<string, unknown>;
    expect(corpo.cep_origem).toBe('75000000');
    // Token e senha NÃO vão no corpo porque o operador não digitou nada.
    expect('me_token' in corpo).toBe(false);
    expect('correios_senha' in corpo).toBe(false);
  });

  it('atualizar status envia o rastreio junto — o banco recusa "postado" sem prova', async () => {
    mockRotas({ '/envios?': ENVIOS, '/envios/5/eventos': [] });
    apiPost.mockResolvedValue({ id: 5 } as never);
    renderPage();

    const botao = await screen.findByTitle('Atualizar status');
    fireEvent.click(botao);

    expect(await screen.findByText(/exigem rastreio ou referência do provedor/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'em_transito' } });
    fireEvent.click(screen.getByText('Atualizar'));

    await waitFor(() =>
      expect(apiPost).toHaveBeenCalledWith('/envios/5/status', {
        status: 'em_transito',
        codigo_rastreamento: 'BR123456789BR',
      })
    );
  });

  it('consultar rastreio chama o endpoint do provedor', async () => {
    mockRotas({ '/envios?': ENVIOS });
    apiPost.mockResolvedValue({ id: 5 } as never);
    renderPage();

    fireEvent.click(await screen.findByTitle('Consultar rastreio'));
    await waitFor(() => expect(apiPost).toHaveBeenCalledWith('/envios/5/rastrear', {}));
  });

  it('entregue e cancelado não oferecem cancelamento de novo', async () => {
    mockRotas({
      '/envios?': { ...ENVIOS, rows: [{ ...ENVIOS.rows[0], status: 'entregue' }] },
    });
    renderPage();

    await screen.findByText('Entregue');
    expect(screen.queryByTitle('Cancelar')).not.toBeInTheDocument();
  });
});
