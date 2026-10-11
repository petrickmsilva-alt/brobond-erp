// ============================================================================
// INUTILIZAÇÕES DE NUMERAÇÃO — contrato de tela (ERP-05, fecha o P1-03).
//
// `inutilizacoes_fiscais` tinha API (`POST /api/fiscal/inutilizar`) e NENHUM
// consumo no cliente. O que estes testes travam é a REGRA DE HONESTIDADE do
// módulo Fiscal:
//   • 200 com `homologado: true` → a tela diz homologada, com protocolo;
//   • 202 com `homologado: false` → a tela diz que o provedor AINDA NÃO
//     homologou (nunca "homologada"), mostrando o status real gravado;
//   • as validações da SEFAZ (série, faixa e justificativa de 15+) barram o
//     pedido ANTES de sair, sem chamar a API;
//   • operador não vê o formulário (o servidor exige gerente);
//   • erro do servidor aparece na tela, com a mensagem real.
// ============================================================================
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import InutilizacoesPage from './InutilizacoesPage';
import { ToastProvider } from '../components/ui';
import { api, ApiError } from '../lib/api';

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

const HISTORICO = {
  rows: [
    {
      id: 4,
      modelo: '55',
      serie: 3,
      numero_inicial: 100,
      numero_final: 110,
      justificativa: 'Quebra de sequência por falha de energia no servidor',
      ambiente: 'homologacao',
      status: 'homologado',
      protocolo: '135260000123456',
      motivo: 'Inutilizacao homologada',
      provider: 'focus',
      criado_em: '2026-10-01T12:00:00Z',
    },
    {
      id: 3,
      modelo: '65',
      serie: 1,
      numero_inicial: 500,
      numero_final: 500,
      justificativa: 'Numeração descartada na virada do sistema',
      ambiente: 'homologacao',
      status: 'pendente',
      protocolo: null,
      motivo: null,
      provider: 'nenhum',
      criado_em: '2026-09-28T12:00:00Z',
    },
  ],
};

function montar() {
  return render(
    <ToastProvider>
      <InutilizacoesPage />
    </ToastProvider>
  );
}

function preencherFaixa(inicial = '200', final = '210', justificativa = 'Faixa descartada por falha de energia no servidor') {
  fireEvent.change(screen.getByPlaceholderText('100'), { target: { value: inicial } });
  fireEvent.change(screen.getByPlaceholderText('110'), { target: { value: final } });
  fireEvent.change(screen.getByPlaceholderText(/Quebra de sequência/), { target: { value: justificativa } });
}

describe('InutilizacoesPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUser.perfil = 'gerente';
    apiGet.mockResolvedValue(HISTORICO);
  });

  it('lista o histórico com status real, faixa e protocolo', async () => {
    montar();
    expect(await screen.findByText('100 a 110')).toBeInTheDocument();
    expect(screen.getByText('Homologada')).toBeInTheDocument();
    expect(screen.getByText('Pendente')).toBeInTheDocument();
    expect(screen.getByText('135260000123456')).toBeInTheDocument();
    expect(screen.getByText('NFC-e (65)')).toBeInTheDocument();
    expect(apiGet).toHaveBeenCalledWith(expect.stringContaining('/inutilizacoes_fiscais'));
  });

  it('homologação confirmada (200) mostra protocolo e status gravado', async () => {
    apiPost.mockResolvedValue({
      id: 9,
      modelo: '55',
      serie: 3,
      numero_inicial: 200,
      numero_final: 210,
      status: 'homologado',
      protocolo: '135260000999999',
      provider: 'focus',
      homologado: true,
      mensagem: 'Inutilizacao homologada',
    });
    montar();
    await screen.findByText('100 a 110');
    preencherFaixa();
    fireEvent.click(screen.getByRole('button', { name: 'Solicitar inutilização' }));

    await waitFor(() => expect(apiPost).toHaveBeenCalledWith('/fiscal/inutilizar', {
      modelo: '55',
      serie: 1,
      numero_inicial: 200,
      numero_final: 210,
      justificativa: 'Faixa descartada por falha de energia no servidor',
    }));
    expect(await screen.findByText('Inutilização homologada pelo provedor.')).toBeInTheDocument();
    expect(screen.getByText(/protocolo 135260000999999/)).toBeInTheDocument();
  });

  it('202 (provedor não confirmou) NUNCA aparece como homologada', async () => {
    apiPost.mockResolvedValue({
      id: 10,
      modelo: '55',
      serie: 3,
      numero_inicial: 300,
      numero_final: 305,
      status: 'pendente',
      protocolo: null,
      provider: 'nenhum',
      homologado: false,
      mensagem: 'Nenhum provedor fiscal configurado: solicitação registrada para transmissão.',
    });
    montar();
    await screen.findByText('100 a 110');
    preencherFaixa('300', '305');
    fireEvent.click(screen.getByRole('button', { name: 'Solicitar inutilização' }));

    expect(await screen.findByText('Solicitação registrada — o provedor ainda não homologou.')).toBeInTheDocument();
    expect(screen.queryByText('Inutilização homologada pelo provedor.')).not.toBeInTheDocument();
    expect(screen.getByText(/Status gravado:/)).toBeInTheDocument();
    expect(screen.getByText(/sem protocolo/)).toBeInTheDocument();
    expect(screen.getByText(/Nenhum provedor fiscal configurado/)).toBeInTheDocument();
  });

  it('justificativa curta é barrada aqui (exigência da SEFAZ) e a API não é chamada', async () => {
    montar();
    await screen.findByText('100 a 110');
    preencherFaixa('200', '210', 'curta demais');
    fireEvent.click(screen.getByRole('button', { name: 'Solicitar inutilização' }));
    expect(await screen.findByText(/pelo menos 15 caracteres/)).toBeInTheDocument();
    expect(apiPost).not.toHaveBeenCalled();
  });

  it('faixa inválida (final < inicial) é barrada antes de sair', async () => {
    montar();
    await screen.findByText('100 a 110');
    preencherFaixa('300', '200');
    fireEvent.click(screen.getByRole('button', { name: 'Solicitar inutilização' }));
    expect(await screen.findByText(/maior ou igual ao inicial/)).toBeInTheDocument();
    expect(apiPost).not.toHaveBeenCalled();
  });

  it('erro do servidor aparece na tela com a mensagem real', async () => {
    apiPost.mockRejectedValue(new ApiError(409, 'Empresa ativa não encontrada. Selecione uma empresa válida antes de emitir.'));
    montar();
    await screen.findByText('100 a 110');
    preencherFaixa();
    fireEvent.click(screen.getByRole('button', { name: 'Solicitar inutilização' }));
    expect(await screen.findByText('Empresa ativa não encontrada. Selecione uma empresa válida antes de emitir.')).toBeInTheDocument();
  });

  it('operador sem alçada não vê o formulário de solicitação (o servidor exige gerente)', async () => {
    mockUser.perfil = 'operador';
    montar();
    await screen.findByText('100 a 110');
    expect(screen.queryByRole('button', { name: 'Solicitar inutilização' })).not.toBeInTheDocument();
    expect(screen.queryByText('Solicitar inutilização')).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText('100')).not.toBeInTheDocument();
  });

  it('busca filtra por faixa, status e protocolo', async () => {
    montar();
    await screen.findByText('100 a 110');
    fireEvent.change(screen.getByPlaceholderText('Buscar por faixa, status, protocolo...'), { target: { value: '500' } });
    await waitFor(() => expect(screen.queryByText('100 a 110')).not.toBeInTheDocument());
    expect(screen.getByText('500')).toBeInTheDocument();
  });
});
