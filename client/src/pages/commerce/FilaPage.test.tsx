// ============================================================================
// COMMERCE — /commerce/fila (observabilidade: outbox, publicações, webhooks).
// Contrato: estados/tentativas reais de CADA fila; sem modal; erro honesto.
// ============================================================================
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '../../components/ui';
import CommerceFilaPage from './FilaPage';

vi.mock('../../lib/api', () => ({
  apiFetch: vi.fn(),
  ApiError: class ApiError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.name = 'ApiError';
      this.status = status;
    }
  },
}));

import { apiFetch, ApiError } from '../../lib/api';
const fetchMock = vi.mocked(apiFetch);

const EVENTOS = {
  outbox: [
    { id: 1, tipo: 'pedido.convertido', chave: 'SAL1', estado: 'PENDENTE', tentativas: 0, ultimo_erro: null, proxima_tentativa_em: null, atualizado_em: '2026-10-28T12:00:00Z' },
    { id: 2, tipo: 'evento.enviado', chave: 'PED-2', estado: 'PROCESSADO', tentativas: 1, ultimo_erro: null, proxima_tentativa_em: null, atualizado_em: '2026-10-28T12:01:00Z' },
  ],
  publicacoes: [
    { id: 9, produto_id: 7, canal: 'MERCADOLIVRE', estado: 'ERROR', tentativas: 3, ultimo_erro: 'Timeout do canal', atualizado_em: '2026-10-28T09:00:00Z' },
  ],
  webhooks: [
    { id: 5, provider: 'mercadopago', status: 'processado', erro: null, criado_em: '2026-10-28T10:00:00Z', processado_em: '2026-10-28T10:00:02Z' },
  ],
};

// Painel multi-loja: DUAS lojas independentes, uma delas com pendência real.
const LOJAS = {
  multi_store_habilitado: true,
  dry_run: true,
  lojas: [
    {
      store_key: 'RETAIL',
      status: { store_key: 'RETAIL', habilitada: true, configurada: true, url: 'https://brobond.com.br', motivo: null },
      conexao: { ok: true },
      vinculos: { total: 12, por_status: { LINKED: 12 } },
      pendentes: [{ produto_id: 7, sku: 'BB-7', nome: 'Camiseta', motivo: 'Sem vínculo nesta loja.' }],
      estoque: { sincronizado_em: '2026-10-28T12:00:00Z' },
      pedidos_importados: 3,
      estado: { ultimo_pedido_em: '2026-10-28T11:00:00Z', ultima_sincronizacao_estoque_em: '2026-10-28T12:00:00Z', ultima_publicacao_em: null, ultimo_erro: null, tentativas: 0 },
    },
    {
      store_key: 'WHOLESALE',
      status: { store_key: 'WHOLESALE', habilitada: true, configurada: false, url: 'https://atacado.brobond.com.br', motivo: 'Faltam WOOCOMMERCE_WHOLESALE_CK/CS.' },
      conexao: null,
      vinculos: { total: 0, por_status: {} },
      pendentes: [],
      estoque: { sincronizado_em: null },
      pedidos_importados: 0,
      estado: { ultimo_pedido_em: null, ultima_sincronizacao_estoque_em: null, ultima_publicacao_em: null, ultimo_erro: 'Falha de autenticação (401) na última tentativa.', tentativas: 2 },
    },
  ],
};

/** Roteia por caminho: cada tela só recebe o formato que sabe ler. */
function rota(respostas: { eventos?: unknown; lojas?: unknown } = {}) {
  return async (caminho: string) => {
    const alvo = String(caminho);
    if (alvo.includes('/commerce/woocommerce/lojas')) {
      const r = respostas.lojas ?? LOJAS;
      if (r instanceof Error) throw r;
      return r;
    }
    const r = respostas.eventos ?? EVENTOS;
    if (r instanceof Error) throw r;
    return r;
  };
}

function renderPagina() {
  return render(
    <ToastProvider>
      <MemoryRouter initialEntries={['/commerce/fila']}>
        <CommerceFilaPage />
      </MemoryRouter>
    </ToastProvider>
  );
}

describe('Commerce — Fila de sincronização (/commerce/fila)', () => {
  beforeEach(() => {
    fetchMock.mockReset();
  });

  it('exibe outbox, publicações e webhooks com estados/tentativas reais', async () => {
    fetchMock.mockImplementation(rota());
    renderPagina();
    expect(await screen.findByText('pedido.convertido')).toBeInTheDocument();
    expect(screen.getByText('Timeout do canal')).toBeInTheDocument();
    expect(screen.getByText('mercadopago')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('sem eventos: estado vazio honesto (nunca linhas fictícias)', async () => {
    fetchMock.mockImplementation(rota({ eventos: { outbox: [], publicacoes: [], webhooks: [] } }));
    renderPagina();
    expect((await screen.findAllByText(/nenhum|vazia|vazio/i)).length).toBeGreaterThan(0);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('erro da API vira Alert honesto', async () => {
    fetchMock.mockImplementation(rota({ eventos: new ApiError(500, 'Outbox fora do ar.') }));
    renderPagina();
    expect(await screen.findByText('Outbox fora do ar.')).toBeInTheDocument();
  });
});

describe('Commerce — painel WooCommerce multi-loja (dentro de /commerce/fila)', () => {
  beforeEach(() => {
    fetchMock.mockReset();
  });

  it('mostra RETAIL e WHOLESALE como lojas INDEPENDENTES, com dado real de cada uma', async () => {
    fetchMock.mockImplementation(rota());
    renderPagina();
    expect(await screen.findByText('Varejo (brobond.com.br)')).toBeInTheDocument();
    expect(screen.getByText('Atacado (atacado.brobond.com.br)')).toBeInTheDocument();
    // RETAIL configurada e sincronizada; WHOLESALE incompleta, com erro próprio.
    expect(screen.getByText('Configurada')).toBeInTheDocument();
    expect(screen.getByText('Incompleta')).toBeInTheDocument();
    expect(screen.getByText('Faltam WOOCOMMERCE_WHOLESALE_CK/CS.')).toBeInTheDocument();
    expect(screen.getByText(/Último erro: Falha de autenticação/)).toBeInTheDocument();
    expect(screen.getByText('Nunca sincronizado')).toBeInTheDocument();
    // modo de homologação declarado na tela (nenhuma escrita foi feita)
    expect(screen.getByText('Homologação (sem escrita)')).toBeInTheDocument();
  });

  it('loja incompleta NÃO pode sincronizar; a configurada pode (ações independentes)', async () => {
    fetchMock.mockImplementation(rota());
    renderPagina();
    await screen.findByText('Varejo (brobond.com.br)');
    expect(screen.getByLabelText('Sincronizar estoque da loja RETAIL')).toBeEnabled();
    expect(screen.getByLabelText('Sincronizar estoque da loja WHOLESALE')).toBeDisabled();
    expect(screen.getByLabelText('Importar pedidos da loja WHOLESALE')).toBeDisabled();
  });

  it('erro no painel de lojas não derruba a fila: cada bloco erra por conta própria', async () => {
    fetchMock.mockImplementation(rota({ lojas: new ApiError(403, 'Apenas gerentes e administradores operam as lojas.') }));
    renderPagina();
    expect(await screen.findByText('Apenas gerentes e administradores operam as lojas.')).toBeInTheDocument();
    // A fila continua renderizando o próprio dado.
    expect(await screen.findByText('pedido.convertido')).toBeInTheDocument();
  });
});
