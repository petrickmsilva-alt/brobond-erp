// ============================================================================
// Painel analítico do Hub Omnichannel — contrato de tela.
//
// Estes testes travam o GABARITO exigido pela diretoria para os QUATRO
// canais: KPIs superiores, bloco central dividido, bloco inferior largo,
// pulsação "CONECTADO COM SUCESSO" e — ponto de compliance — a AUSÊNCIA
// definitiva de campos de credencial do Mercado Pago em tela.
//
// Desde 2026-10-06 o Instagram Shopping deixou de ser bloco de
// prontidão: tem conector próprio ligado à Graph API da Meta, consulta
// a mesma rota de painel dos outros e NÃO existe mais nenhum selo de
// homologação na tela.
// ============================================================================
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import ConectorPage from './ConectorPage';
import { ToastProvider } from '../components/ui';
import { MODULES, type Module } from '../modules';
import { api } from '../lib/api';

vi.mock('../lib/api', () => ({
  api: { get: vi.fn(), post: vi.fn(), del: vi.fn() },
  ApiError: class ApiError extends Error {},
}));

const apiGet = vi.mocked(api.get);
const apiPost = vi.mocked(api.post);

function statusFixture(overrides: Record<string, unknown> = {}) {
  return {
    provider: 'MERCADOLIVRE',
    label: 'Mercado Livre',
    description: 'Meli API oficial.',
    authModel: 'oauth2',
    status: 'CONNECTED',
    statusLabel: 'Conectado',
    connected: true,
    configured: true,
    missingEnv: [],
    shopId: '123',
    shopName: 'Loja BROBOND',
    expiresAt: null,
    lastSyncAt: null,
    lastError: null,
    importedCount: 0,
    duplicatedCount: 0,
    failedCount: 0,
    syncCount: 0,
    environmentCredentialsAvailable: false,
    requiresReauth: false,
    updatedAt: null,
    ...overrides,
  };
}

const EMPTY_PANEL = { provider: 'MERCADOLIVRE', revenueCents: 0, salesCount: 0, eventCount: 0, sales: [], events: [], importedContent: [] };

const moduleOf = (id: string): Module => MODULES.find((m) => m.id === id) as Module;

function renderPage(module: Module) {
  return render(
    <ToastProvider>
      <ConectorPage module={module} />
    </ToastProvider>
  );
}

describe('ConectorPage — gabarito analítico do Hub', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiGet.mockResolvedValue({ connector: statusFixture(), panel: EMPTY_PANEL });
    apiPost.mockResolvedValue({});
  });

  it('monta os três blocos do gabarito com os KPIs e os estados vazios canônicos', async () => {
    renderPage(moduleOf('conector-mercadolivre'));

    expect(await screen.findByText('Pedidos Importados')).toBeInTheDocument();
    expect(screen.getByText('Pedidos Ignorados')).toBeInTheDocument();
    expect(screen.getByText('Falhas')).toBeInTheDocument();
    expect(screen.getByText('Receita do Canal')).toBeInTheDocument();
    expect(screen.getByText('Última Sincronização')).toBeInTheDocument();
    expect(screen.getByText('R$ 0,00')).toBeInTheDocument();

    expect(screen.getByText('Vendas do canal')).toBeInTheDocument();
    expect(screen.getByText('Nenhuma venda registrada')).toBeInTheDocument();
    expect(screen.getByText('Webhooks — eventos recebidos')).toBeInTheDocument();
    expect(screen.getByText('Nenhum evento recebido')).toBeInTheDocument();
    expect(screen.getByText('Conteúdo importado desta plataforma')).toBeInTheDocument();
    expect(screen.getByText('Nenhum conteúdo importado')).toBeInTheDocument();
  });

  it('exibe a pulsação verde "CONECTADO COM SUCESSO" nos canais validados', async () => {
    const { container } = renderPage(moduleOf('conector-nuvemshop'));
    expect(await screen.findByText('CONECTADO COM SUCESSO')).toBeInTheDocument();
    expect(container.querySelector('.animate-ping.bg-green-500')).not.toBeNull();
  });

  it('Mercado Pago: nenhum campo de credencial em tela — a validação é de ambiente', async () => {
    apiGet.mockResolvedValue({
      connector: statusFixture({ provider: 'MERCADOPAGO', authModel: 'credentials', connected: false, environmentCredentialsAvailable: true }),
      panel: EMPTY_PANEL,
    });
    apiPost.mockResolvedValue({ connector: statusFixture({ provider: 'MERCADOPAGO', authModel: 'credentials' }) });

    renderPage(moduleOf('conector-mercadopago'));

    await screen.findByText('Pedidos Importados');
    expect(screen.queryByLabelText(/access token/i)).toBeNull();
    expect(screen.queryByLabelText(/public key/i)).toBeNull();
    expect(screen.queryByRole('button', { name: /salvar credenciais/i })).toBeNull();
    expect(screen.queryByRole('textbox')).toBeNull();

    // A ativação acontece em segundo plano, direto do ambiente da Render.
    await waitFor(() => expect(apiPost).toHaveBeenCalledWith('/connectors/mercadopago/conectar-ambiente', {}));
  });

  it('Instagram Shopping consulta o conector real e pulsa em verde quando conectado', async () => {
    apiGet.mockResolvedValue({
      connector: statusFixture({ provider: 'INSTAGRAM', label: 'Instagram Shopping', shopName: '@brobond' }),
      panel: { ...EMPTY_PANEL, provider: 'INSTAGRAM' },
    });

    const { container } = renderPage(moduleOf('conector-instagram'));

    // O canal tem motor no servidor: a página fala com a rota dele.
    await waitFor(() => expect(apiGet).toHaveBeenCalledWith('/connectors/instagram/painel'));
    expect(await screen.findByText('CONECTADO COM SUCESSO')).toBeInTheDocument();
    expect(container.querySelector('.animate-ping.bg-green-500')).not.toBeNull();
    expect(screen.getByText('Nenhuma venda registrada')).toBeInTheDocument();
    expect(screen.getByText('Nenhum evento recebido')).toBeInTheDocument();
    expect(screen.getByText('Nenhum conteúdo importado')).toBeInTheDocument();
  });

  it('o selo ocre de homologação da Meta não existe mais em nenhum canal', async () => {
    for (const id of ['conector-instagram', 'conector-mercadolivre', 'conector-mercadopago', 'conector-nuvemshop']) {
      const { unmount } = renderPage(moduleOf(id));
      await screen.findByText('Pedidos Importados');
      expect(screen.queryByText(/HOMOLOGAÇÃO/i)).toBeNull();
      unmount();
    }
  });

  it('Instagram desconectado mostra o status real do canal, nunca a pulsação verde', async () => {
    apiGet.mockResolvedValue({
      connector: statusFixture({
        provider: 'INSTAGRAM',
        status: 'DISCONNECTED',
        statusLabel: 'Desconectado',
        connected: false,
        shopId: null,
        shopName: null,
      }),
      panel: { ...EMPTY_PANEL, provider: 'INSTAGRAM' },
    });

    renderPage(moduleOf('conector-instagram'));

    expect(await screen.findByText('Desconectado')).toBeInTheDocument();
    expect(screen.queryByText('CONECTADO COM SUCESSO')).toBeNull();
  });
});
