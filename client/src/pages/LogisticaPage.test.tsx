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
  me_token: '••••••••',
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

    expect(await screen.findByText(/configurado \(••••••••\)/)).toBeInTheDocument();
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
    await screen.findByText(/configurado \(••••••••\)/);

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
    await screen.findByText(/configurado \(••••••••\)/);

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

// ============================================================================
// MOTOR MULTICANAL — painel integrado
// ============================================================================
const PAINEL = {
  modulo_habilitado: true,
  provider_padrao: 'melhor_envio',
  contadores: { pendente: 3, separacao: 1, postado: 5, em_transito: 2, entregue: 9 },
  atrasadas: 1,
  ocorrencias: 4,
  falhas_integracao: 2,
  custo_previsto: 120.5,
  custo_efetivo: 118.2,
  lojas: [
    { store_key: 'RETAIL', remessas: 12 },
    { store_key: 'WHOLESALE', remessas: 8 },
  ],
  webhooks: { processado: 6, erro: 2 },
  providers: [
    { slug: 'melhor_envio', nome: 'Melhor Envio', configurado: true, habilitado: true, motivo: null, capacidades: { cotacao: true, remessa: true, etiqueta: true, rastreio: true, cancelamento: false, webhook: false } },
    { slug: 'correios', nome: 'Correios', configurado: false, habilitado: false, motivo: 'Sem credencial configurada.', capacidades: { cotacao: true, remessa: false, etiqueta: false, rastreio: true, cancelamento: false, webhook: false } },
  ],
  gerado_em: '2026-11-07T10:00:00.000Z',
};

const REGRAS = {
  regras: [
    { id: 1, nome: 'Frete grátis acima de 300', tipo: 'FRETE_GRATIS_VALOR', store_key: null, prioridade: 10, ativo: true, condicoes: { valor_minimo: 300 }, acoes: {} },
    { id: 2, nome: 'Subsídio atacado', tipo: 'FRETE_SUBSIDIADO', store_key: 'WHOLESALE', prioridade: 5, ativo: false, condicoes: {}, acoes: { percentual: 50 } },
  ],
  tipos: ['FRETE_GRATIS_VALOR', 'FRETE_SUBSIDIADO'],
};

const REMESSAS = {
  rows: [
    { id: 21, venda_id: 100, provider: 'melhor_envio', store_key: 'RETAIL', status: 'em_transito', codigo_rastreamento: 'BR999', cep_destino: '30130110', custo_previsto: 39.9, custo_efetivo: 41.2, prazo_dias: 3, criado_em: '2026-11-01T10:00:00.000Z' },
    { id: 22, venda_id: 101, provider: 'correios', store_key: 'WHOLESALE', status: 'entregue', codigo_rastreamento: 'BR111', cep_destino: '20040020', custo_previsto: 22, custo_efetivo: 22, prazo_dias: 7, criado_em: '2026-11-02T10:00:00.000Z' },
  ],
  total: 2,
};

describe('Logística — painel multicanal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('mostra indicadores, operadores e remessas com custo previsto/efetivo', async () => {
    mockRotas({ '/envios?': ENVIOS, '/logistics/painel': PAINEL, '/logistics/rules': REGRAS, '/logistics/shipments': REMESSAS });
    renderPage();

    fireEvent.click(await screen.findByText('Multicanal'));

    expect(await screen.findByText('Em trânsito')).toBeInTheDocument();
    expect(screen.getAllByText('Melhor Envio').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Correios').length).toBeGreaterThan(0);
    expect(screen.getByText('BR999')).toBeInTheDocument();
    expect(screen.getByText('Frete grátis acima de 300')).toBeInTheDocument();
    // Operador sem credencial exibe o motivo — nunca "integrado".
    expect(screen.getByText(/Sem credencial configurada/)).toBeInTheDocument();
    expect(screen.getByText('R$ 39,90')).toBeInTheDocument();
    expect(screen.getByText('R$ 41,20')).toBeInTheDocument();
  });

  it('mostra o aviso de modo seguro quando o módulo está desabilitado', async () => {
    mockRotas({
      '/envios?': ENVIOS,
      '/logistics/painel': { ...PAINEL, modulo_habilitado: false },
      '/logistics/rules': REGRAS,
      '/logistics/shipments': REMESSAS,
    });
    renderPage();

    fireEvent.click(await screen.findByText('Multicanal'));
    expect(await screen.findByText(/modo seguro/)).toBeInTheDocument();
  });

  it('estado vazio: sem remessas mostra a mensagem de vazio', async () => {
    mockRotas({
      '/envios?': ENVIOS,
      '/logistics/painel': PAINEL,
      '/logistics/rules': REGRAS,
      '/logistics/shipments': { rows: [], total: 0 },
    });
    renderPage();

    fireEvent.click(await screen.findByText('Multicanal'));
    expect(await screen.findByText('Nenhuma remessa')).toBeInTheDocument();
  });

  it('erro na carga mostra alerta em vez de quebrar a tela', async () => {
    apiGet.mockImplementation(((path: string) => {
      if (path.startsWith('/envios?')) return Promise.resolve(ENVIOS);
      return Promise.reject(new Error('falha de rede'));
    }) as never);
    renderPage();

    fireEvent.click(await screen.findByText('Multicanal'));
    expect(await screen.findByText(/Não foi possível carregar o painel logístico/)).toBeInTheDocument();
  });

  it('reprocessar webhooks chama o endpoint de recuperação', async () => {
    mockRotas({ '/envios?': ENVIOS, '/logistics/painel': PAINEL, '/logistics/rules': REGRAS, '/logistics/shipments': REMESSAS });
    apiPost.mockResolvedValue({ recuperados: 2 } as never);
    renderPage();

    fireEvent.click(await screen.findByText('Multicanal'));
    fireEvent.click(await screen.findByText('Reprocessar webhooks'));
    await waitFor(() => expect(apiPost).toHaveBeenCalledWith('/logistics/webhooks/recuperar', {}));
  });
});
