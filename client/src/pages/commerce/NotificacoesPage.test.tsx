import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import App from '../../App';
import type { User } from '../../auth/AuthContext';
import { ToastProvider } from '../../components/ui';
import { clearToken, setToken } from '../../lib/api';
import { MetaContext, type Meta } from '../../lib/meta';
import { MODULES, PAGES_ESPECIAIS, moduleOfPath, visibleModules } from '../../modules';
import CommerceNotificacoesPage, { type StatusNotificacoes } from './NotificacoesPage';

let usuario: User | null;
const meta: Meta = { resources: {}, mode: 'memory' };
vi.mock('../../auth/AuthContext', () => ({
  useAuth: () => ({ user: usuario, meta, loading: false, logout: vi.fn() }),
}));
vi.mock('../Dashboard', () => ({ default: () => <h1>Início de teste</h1> }));
vi.mock('../Login', () => ({ default: () => <h1>Entrar no ERP de teste</h1> }));

// apiFetch NÃO é mockado: os testes percorrem o cliente HTTP canônico, inclusive
// a injeção de Authorization, retry, AbortSignal e o contrato de erro HTTP.
const fetchMock = vi.fn<typeof fetch>();
const endpoint = '/api/commerce/notificacoes/status';
const eventosComMensagem = [
  'ORDER_CREATED',
  'PAYMENT_APPROVED',
  'PAYMENT_REJECTED',
  'ORDER_SHIPPED',
  'ORDER_DELIVERED',
  'ORDER_CANCELLED',
  'ORDER_EXPIRED',
];
const variaveisEmail = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM'];
const variaveisWhatsApp = [
  'WHATSAPP_CLOUD_API_TOKEN',
  'WHATSAPP_PHONE_NUMBER_ID',
  'WHATSAPP_TEMPLATE_ORDER_CREATED',
  'WHATSAPP_TEMPLATE_PAYMENT_APPROVED',
  'WHATSAPP_TEMPLATE_TRANSACIONAL',
  'WHATSAPP_TEMPLATE_IDIOMA',
];

function completo(): StatusNotificacoes {
  return {
    ok: true,
    consultado_em: '2026-11-03T16:01:00.000Z',
    email: { status_configuracao: 'CONFIGURADO', smtp_configurado: true, remetente_dedicado: true, variaveis_ausentes: [] },
    whatsapp: {
      status_configuracao: 'CONFIGURADO',
      token_configurado: true,
      phone_number_id_configurado: true,
      modelos_configurados: {
        WHATSAPP_TEMPLATE_ORDER_CREATED: true,
        WHATSAPP_TEMPLATE_PAYMENT_APPROVED: true,
        WHATSAPP_TEMPLATE_TRANSACIONAL: true,
      },
      templates: Object.fromEntries(eventosComMensagem.map((evento) => [evento, true])),
      eventos_sem_template: [],
      idioma: 'pt_BR',
      idioma_configurado: true,
      variaveis_ausentes: [],
    },
    link_publico: { status_configuracao: 'CONFIGURADO', variaveis_ausentes: [] },
  };
}

function ausente(): StatusNotificacoes {
  const dados = completo();
  dados.email = {
    status_configuracao: 'NAO_CONFIGURADO',
    smtp_configurado: false,
    remetente_dedicado: false,
    variaveis_ausentes: variaveisEmail,
  };
  dados.whatsapp = {
    ...dados.whatsapp,
    status_configuracao: 'NAO_CONFIGURADO',
    token_configurado: false,
    phone_number_id_configurado: false,
    modelos_configurados: {
      WHATSAPP_TEMPLATE_ORDER_CREATED: false,
      WHATSAPP_TEMPLATE_PAYMENT_APPROVED: false,
      WHATSAPP_TEMPLATE_TRANSACIONAL: false,
    },
    templates: Object.fromEntries(eventosComMensagem.map((evento) => [evento, false])),
    eventos_sem_template: eventosComMensagem,
    idioma_configurado: false,
    variaveis_ausentes: variaveisWhatsApp,
  };
  dados.link_publico = { status_configuracao: 'NAO_CONFIGURADO', variaveis_ausentes: ['APP_URL', 'PUBLIC_BASE_URL'] };
  return dados;
}

function json(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

function pendente<T>() {
  let resolver!: (resposta: T) => void;
  const promise = new Promise<T>((resolve) => {
    resolver = resolve;
  });
  return { promise, resolver };
}

function cartao(nome: string) {
  return screen.getByRole('region', { name: nome });
}

function listaAusentes(nome: string) {
  return within(cartao(nome)).getByRole('heading', { name: 'Variáveis ausentes' }).parentElement!;
}

beforeEach(() => {
  usuario = { id: 1, name: 'Admin de teste', email: 'admin@example.invalid', perfil: 'admin' };
  setToken('jwt-fixture-empresa-a');
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(json(completo()));
  vi.stubGlobal('fetch', fetchMock);
  window.history.replaceState({}, '', '/');
});

afterEach(() => {
  cleanup();
  clearToken();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('Central de Notificações — página e HTTP autenticado', () => {
  it('usa apiFetch real com Bearer existente, rota relativa e somente GET, sem autenticação paralela', async () => {
    render(<CommerceNotificacoesPage />);
    expect(await screen.findByRole('region', { name: 'E-mail' })).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opcoes] = fetchMock.mock.calls[0];
    expect(url).toBe(endpoint);
    expect(new Headers(opcoes?.headers).get('Authorization')).toBe('Bearer jwt-fixture-empresa-a');
    expect(opcoes?.method ?? 'GET').toBe('GET');
    expect(opcoes?.body).toBeUndefined();
    const fonte = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), 'NotificacoesPage.tsx'), 'utf8');
    expect(fonte).not.toMatch(/\bfetch\s*\(|localStorage|sessionStorage|\bgetToken\b|\bsetToken\b/);
    expect(fonte).toContain("from '../../lib/api'");
  });

  it('apresenta os três cards, nomes das variáveis ausentes, modelos de referência e eventos sem modelo', async () => {
    fetchMock.mockResolvedValue(json(ausente()));
    render(<CommerceNotificacoesPage />);
    expect(screen.getByRole('heading', { name: 'Central de Notificações' })).toBeInTheDocument();
    expect(screen.getByText('Diagnóstico dos canais transacionais da BroBond.')).toBeInTheDocument();
    await screen.findByRole('region', { name: 'E-mail' });
    for (const variavel of variaveisEmail) expect(within(listaAusentes('E-mail')).getByText(variavel)).toBeInTheDocument();
    for (const variavel of variaveisWhatsApp)
      expect(within(listaAusentes('WhatsApp — Meta Cloud API')).getByText(variavel)).toBeInTheDocument();
    for (const variavel of ['APP_URL', 'PUBLIC_BASE_URL'])
      expect(within(listaAusentes('Link Público do pedido')).getByText(variavel)).toBeInTheDocument();
    for (const modelo of ['brobond_pedido_recebido', 'brobond_pagamento_confirmado', 'brobond_transacional'])
      expect(screen.getByText(modelo)).toBeInTheDocument();
    expect(screen.getByText(/Pedido recebido/)).toBeInTheDocument();
    expect(screen.getByText('(ORDER_CREATED)')).toBeInTheDocument();
    expect(screen.getByText('(PAYMENT_APPROVED)')).toBeInTheDocument();
    expect(screen.getByText('pt_BR (padrão; variável ausente)')).toBeInTheDocument();
    expect(within(cartao('Pendências de configuração')).getByText(/WHATSAPP_CLOUD_API_TOKEN ausente/)).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('configurado significa apenas configuração local; não afirma conexão, entrega ou aprovação Meta', async () => {
    const dados = {
      ...completo(),
      email: { ...completo().email, status: 'CONECTADO' },
      whatsapp: { ...completo().whatsapp, status: 'CONECTADO' },
    };
    fetchMock.mockResolvedValue(json(dados));
    render(<CommerceNotificacoesPage />);
    await screen.findByRole('region', { name: 'E-mail' });
    expect(screen.getByText('Configuração local não comprova conexão nem entrega.')).toBeInTheDocument();
    expect(screen.getByText(/não verifica a aprovação dos modelos na Meta/)).toBeInTheDocument();
    expect(screen.getByText('pt_BR (configurado)')).toBeInTheDocument();
    expect(screen.getByText('Nenhuma pendência de configuração identificada. Conexão e entrega não foram testadas.')).toBeInTheDocument();
    expect(screen.queryByText(/^CONECTADO$/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/^entregue$|^aprovado na Meta$/i)).not.toBeInTheDocument();
  });

  it('diferencia cobertura parcial por evento de fallback completo, sem exigir todos os modelos específicos', async () => {
    const dados = completo();
    dados.whatsapp.eventos_sem_template = ['PAYMENT_APPROVED'];
    dados.whatsapp.templates.PAYMENT_APPROVED = false;
    dados.whatsapp.modelos_configurados.WHATSAPP_TEMPLATE_TRANSACIONAL = false;
    dados.whatsapp.variaveis_ausentes = ['WHATSAPP_TEMPLATE_TRANSACIONAL'];
    fetchMock.mockResolvedValueOnce(json(dados));
    render(<CommerceNotificacoesPage />);
    expect(await screen.findByText('Configuração parcial')).toBeInTheDocument();
    expect(screen.getByText('(PAYMENT_APPROVED)')).toBeInTheDocument();
    expect(screen.getByText(/1 evento\(s\) sem modelo/)).toBeInTheDocument();
    const fallback = completo();
    fallback.whatsapp.modelos_configurados.WHATSAPP_TEMPLATE_PAYMENT_APPROVED = false;
    fallback.whatsapp.variaveis_ausentes = ['WHATSAPP_TEMPLATE_PAYMENT_APPROVED'];
    fetchMock.mockResolvedValueOnce(json(fallback));
    await userEvent.click(screen.getByRole('button', { name: 'Atualizar Status' }));
    expect(await screen.findByText('Todos os eventos com mensagem têm modelo local.')).toBeInTheDocument();
    expect(screen.queryByText('Configuração parcial')).not.toBeInTheDocument();
    expect(screen.getByText('Nenhuma pendência de configuração identificada. Conexão e entrega não foram testadas.')).toBeInTheDocument();
  });

  it('ignora segredos em campos extras, erros legados, nomes arbitrários, idioma inválido e tokens de pedidos', async () => {
    const segredo = 'SEGREDO-PRIVADO-NAO-EXIBIR';
    const tokenPedido = 'ab'.repeat(32);
    const base = completo();
    fetchMock.mockResolvedValue(
      json({
        ...base,
        consultado_em: segredo,
        email: { ...base.email, smtp_user: segredo, smtp_pass: segredo, ultimo_erro: segredo, variaveis_ausentes: [segredo] },
        whatsapp: {
          ...base.whatsapp,
          token: segredo,
          phone_number_id: '100000000000077',
          idioma: segredo,
          template: segredo,
          provider_message_id: segredo,
          ultimo_erro: segredo,
          eventos_sem_template: [segredo],
          variaveis_ausentes: [segredo],
        },
        link_publico: { ...base.link_publico, base: `https://privado.example.invalid/${tokenPedido}`, checkout_token: tokenPedido },
      })
    );
    const { container } = render(<CommerceNotificacoesPage />);
    await screen.findByRole('region', { name: 'E-mail' });
    expect(screen.getByText('Inválido (valor oculto)')).toBeInTheDocument();
    for (const privado of [segredo, tokenPedido, '100000000000077', 'https://privado.example.invalid'])
      expect(container.innerHTML).not.toContain(privado);
  });

  it('mostra carregamento, bloqueia consultas simultâneas e Atualizar Status refaz GET e atualiza a data/hora', async () => {
    const primeira = pendente<Response>();
    const segunda = pendente<Response>();
    fetchMock.mockReturnValueOnce(primeira.promise).mockReturnValueOnce(segunda.promise);
    const { container } = render(<CommerceNotificacoesPage />);
    const atualizar = screen.getByRole('button', { name: 'Atualizar Status' });
    expect(screen.getByText('Consultando configuração dos canais…')).toBeInTheDocument();
    expect(atualizar).toBeDisabled();
    expect(screen.getByText(/ainda não realizada/)).toBeInTheDocument();
    await act(async () => {
      primeira.resolver(json(ausente()));
    });
    expect(await screen.findByRole('region', { name: 'E-mail' })).toBeInTheDocument();
    expect(container.querySelector('time')).toHaveAttribute('datetime', '2026-11-03T16:01:00.000Z');
    await userEvent.click(atualizar);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(atualizar).toBeDisabled();
    expect(screen.queryByRole('region', { name: 'E-mail' })).not.toBeInTheDocument();
    const novo = completo();
    novo.consultado_em = '2026-11-03T16:02:30.000Z';
    await act(async () => {
      segunda.resolver(json(novo));
    });
    expect(await screen.findByRole('region', { name: 'E-mail' })).toBeInTheDocument();
    expect(container.querySelector('time')).toHaveAttribute('datetime', novo.consultado_em);
    expect(atualizar).toBeEnabled();
    expect(fetchMock.mock.calls.every(([url, opcoes]) => url === endpoint && (opcoes?.method ?? 'GET') === 'GET' && !opcoes?.body)).toBe(
      true
    );
  });

  it('falha de rede usa o retry canônico, exibe mensagem segura e permite tentar novamente', async () => {
    vi.useFakeTimers();
    fetchMock.mockRejectedValue(new Error('detalhe-interno-com-segredo'));
    render(<CommerceNotificacoesPage />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_100);
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Sem conexão com o servidor. Verifique sua internet e tente Atualizar Status novamente.'
    );
    expect(document.body.textContent).not.toContain('detalhe-interno-com-segredo');
    expect(screen.queryByRole('region', { name: 'E-mail' })).not.toBeInTheDocument();
    vi.useRealTimers();
    fetchMock.mockResolvedValue(json(completo()));
    await userEvent.click(screen.getByRole('button', { name: 'Atualizar Status' }));
    expect(await screen.findByRole('region', { name: 'E-mail' })).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('403 do servidor apresenta ausência de permissão sem diagnóstico nem erro bruto', async () => {
    fetchMock.mockResolvedValue(json({ error: 'detalhe-privado-403' }, 403));
    render(<CommerceNotificacoesPage />);
    expect(await screen.findByRole('heading', { name: 'Sem permissão' })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'E-mail' })).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain('detalhe-privado-403');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('perda de permissão na atualização remove o diagnóstico anterior, sem deixar indicadores antigos', async () => {
    render(<CommerceNotificacoesPage />);
    await screen.findByRole('region', { name: 'E-mail' });
    fetchMock.mockResolvedValueOnce(json({ error: 'Permissão revogada' }, 403));
    await userEvent.click(screen.getByRole('button', { name: 'Atualizar Status' }));
    expect(await screen.findByRole('heading', { name: 'Sem permissão' })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'E-mail' })).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'WhatsApp — Meta Cloud API' })).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Pendências de configuração' })).not.toBeInTheDocument();
    expect(chamadasStatus()).toHaveLength(2);
  });

  it('operador não inicia consulta e encontra estado explícito de ausência de permissão', () => {
    usuario!.perfil = 'operador';
    render(<CommerceNotificacoesPage />);
    expect(screen.getByRole('heading', { name: 'Sem permissão' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Atualizar Status' })).toBeDisabled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('401 usa mensagem de sessão expirada sem copiar mensagens arbitrárias do backend', async () => {
    clearToken(); // Evita navegação global no jsdom; o tratamento de sessão continua no apiFetch real.
    fetchMock.mockResolvedValue(json({ error: 'segredo-no-erro-401' }, 401));
    render(<CommerceNotificacoesPage />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Sessão expirada. Entre novamente no ERP.');
    expect(document.body.textContent).not.toContain('segredo-no-erro-401');
    expect(screen.queryByRole('region', { name: 'E-mail' })).not.toBeInTheDocument();
  });

  it('erro HTTP 500 não vira diagnóstico vazio/configurado e permite nova tentativa', async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValue(json({ error: 'segredo-no-erro-500' }, 500));
    render(<CommerceNotificacoesPage />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_100);
    });
    expect(screen.getByRole('alert')).toHaveTextContent('Não foi possível consultar o status das notificações.');
    expect(screen.queryByRole('region', { name: 'E-mail' })).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain('segredo-no-erro-500');
    expect(screen.getByRole('button', { name: 'Atualizar Status' })).toBeEnabled();
  });

  it('desmontar cancela a consulta pendente pelo AbortSignal do cliente existente', async () => {
    fetchMock.mockImplementation(
      (_url, opcoes) =>
        new Promise((_resolve, reject) => {
          opcoes?.signal?.addEventListener('abort', () => reject(new DOMException('Cancelado', 'AbortError')));
        })
    );
    const pagina = render(<CommerceNotificacoesPage />);
    const signal = fetchMock.mock.calls[0][1]?.signal;
    expect(signal?.aborted).toBe(false);
    await act(async () => {
      pagina.unmount();
    });
    expect(signal?.aborted).toBe(true);
  });
});

const empresas = {
  empresa_id: 1,
  empresa: 'Empresa A',
  consolidado: false,
  pode_consolidar: false,
  empresas: [
    { id: 1, nome: 'Empresa A', cnpj: null, ativa: true },
    { id: 2, nome: 'Empresa B', cnpj: null, ativa: false },
  ],
};

function abrirRota() {
  window.history.pushState({}, '', '/commerce/notificacoes');
  return render(
    <MetaContext.Provider value={meta}>
      <ToastProvider>
        <App />
      </ToastProvider>
    </MetaContext.Provider>
  );
}

function chamadasStatus() {
  return fetchMock.mock.calls.filter(([url]) => url === endpoint);
}

function configurarApiEmpresas(status: (opcoes?: RequestInit) => Promise<Response>) {
  fetchMock.mockImplementation(async (url, opcoes) => {
    if (url === '/api/empresas/ativa') {
      return opcoes?.method === 'POST'
        ? json({ ok: true, token: 'jwt-fixture-empresa-b', empresa_id: 2, empresa: 'Empresa B' })
        : json(empresas);
    }
    if (url === endpoint) return status(opcoes);
    throw new Error(`Requisição não prevista no teste: ${String(url)}`);
  });
}

describe('Central de Notificações — App, navegação e troca de empresa reais', () => {
  it('registra página própria na fonte única de menu/rotas, com RBAC gerente/admin', () => {
    const modulo = MODULES.find((m) => m.id === 'commerce-notificacoes')!;
    expect(modulo).toMatchObject({
      path: '/commerce/notificacoes',
      space: 'commerce',
      group: 'Integrações',
      resource: 'commerce_notificacoes',
      minPerfil: 'gerente',
    });
    expect(PAGES_ESPECIAIS).toContain(modulo.id);
    expect(moduleOfPath(modulo.path)?.id).toBe(modulo.id);
    expect(visibleModules({ perfil: 'admin' })).toContain(modulo);
    expect(visibleModules({ perfil: 'gerente' })).toContain(modulo);
    expect(visibleModules({ perfil: 'operador' })).not.toContain(modulo);
  });

  it('App abre /commerce/notificacoes no Layout autenticado, com link no menu Commerce e sem sobreposição', async () => {
    configurarApiEmpresas(async () => json(completo()));
    const { container } = abrirRota();
    expect(await screen.findByRole('heading', { name: 'Central de Notificações' }, { timeout: 10_000 })).toBeInTheDocument();
    expect(await screen.findByRole('region', { name: 'E-mail' })).toBeInTheDocument();
    expect(window.location.pathname).toBe('/commerce/notificacoes');
    expect(container.querySelector('[role="dialog"], [aria-modal="true"]')).toBeNull();
    const menu = screen.getByTestId('top-navigation');
    await userEvent.click(within(menu).getByRole('button', { name: /^Commerce/ }));
    expect(within(menu).getByRole('menuitem', { name: 'Central de Notificações' })).toHaveAttribute('href', '/commerce/notificacoes');
    expect(chamadasStatus()).toHaveLength(1);
  });

  it('URL direta de operador respeita ModuleAccess e não consulta o diagnóstico', async () => {
    usuario!.perfil = 'operador';
    configurarApiEmpresas(async () => json(completo()));
    abrirRota();
    expect(await screen.findByRole('heading', { name: 'Início de teste' })).toBeInTheDocument();
    expect(window.location.pathname).toBe('/');
    expect(chamadasStatus()).toHaveLength(0);
  });

  it('URL direta sem sessão respeita Protected e encaminha para o login existente', async () => {
    usuario = null;
    clearToken();
    abrirRota();
    expect(await screen.findByRole('heading', { name: 'Entrar no ERP de teste' })).toBeInTheDocument();
    expect(window.location.pathname).toBe('/login');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('troca de empresa remonta a página, descarta dados antigos e consulta com o novo JWT canônico', async () => {
    const consultaB = pendente<Response>();
    configurarApiEmpresas(async (opcoes) =>
      new Headers(opcoes?.headers).get('Authorization') === 'Bearer jwt-fixture-empresa-b' ? consultaB.promise : json(ausente())
    );
    const { container } = abrirRota();
    await screen.findByRole('region', { name: 'E-mail' });
    expect(within(cartao('E-mail')).getByText('SMTP_PASS')).toBeInTheDocument();
    await userEvent.click(await screen.findByRole('button', { name: /Empresa ativa: Empresa A. Trocar empresa/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Empresa B' }));
    await waitFor(() => expect(chamadasStatus()).toHaveLength(2));
    expect(screen.queryByRole('region', { name: 'E-mail' })).not.toBeInTheDocument();
    expect(container.querySelector('time')).toBeNull();
    const dadosB = completo();
    dadosB.consultado_em = '2026-11-03T17:30:00.000Z';
    await act(async () => {
      consultaB.resolver(json(dadosB));
    });
    await screen.findByRole('region', { name: 'E-mail' });
    expect(container.querySelector('time')).toHaveAttribute('datetime', dadosB.consultado_em);
    expect(chamadasStatus().map(([, opcoes]) => new Headers(opcoes?.headers).get('Authorization'))).toEqual([
      'Bearer jwt-fixture-empresa-a',
      'Bearer jwt-fixture-empresa-b',
    ]);
    const troca = fetchMock.mock.calls.find(([url, opcoes]) => url === '/api/empresas/ativa' && opcoes?.method === 'POST');
    expect(troca?.[1]?.body).toBe(JSON.stringify({ empresa_id: 2 }));
    expect(chamadasStatus().every(([, opcoes]) => (opcoes?.method ?? 'GET') === 'GET')).toBe(true);
  });

  it('resposta atrasada da empresa anterior não reaparece após a troca de empresa', async () => {
    const consultaA = pendente<Response>();
    configurarApiEmpresas(async (opcoes) =>
      new Headers(opcoes?.headers).get('Authorization') === 'Bearer jwt-fixture-empresa-a' ? consultaA.promise : json(completo())
    );
    abrirRota();
    await screen.findByRole('heading', { name: 'Central de Notificações' });
    await waitFor(() => expect(chamadasStatus()).toHaveLength(1));
    const sinalAntigo = chamadasStatus()[0][1]?.signal;
    await userEvent.click(await screen.findByRole('button', { name: /Empresa ativa: Empresa A. Trocar empresa/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Empresa B' }));
    await screen.findByRole('region', { name: 'E-mail' });
    expect(sinalAntigo?.aborted).toBe(true);
    await act(async () => {
      consultaA.resolver(json(ausente()));
    });
    expect(within(cartao('E-mail')).queryByText('SMTP_PASS')).not.toBeInTheDocument();
    expect(screen.getByText('Nenhuma pendência de configuração identificada. Conexão e entrega não foram testadas.')).toBeInTheDocument();
  });
});
