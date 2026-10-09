// ============================================================================
// CUSTO DE FABRICAÇÃO — contrato de tela (fecha GAP-PROD-CUSTO-SEM-TESTE)
//
// `CustoPage.tsx` era a única tela de dinheiro da Produção sem `.test.tsx`.
// O que estes testes travam:
//   • a fórmula exibida é a do servidor (não uma conta paralela no front);
//   • os totais somam as fichas que vieram, e ficha sem cálculo mostra "—";
//   • sem ficha cadastrada há estado vazio com ação, e a busca que não acha nada
//     diz "Nada encontrado" em vez de fingir que a lista está vazia;
//   • erro de rede aparece com a mensagem real;
//   • operador não vê "Nova ficha técnica" (o servidor exige gerente para aplicar
//     o preço, e criar ficha sem poder aplicá-la é beco sem saída).
// ============================================================================
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import CustoPage from './CustoPage';
import { ToastProvider } from '../components/ui';
import { api } from '../lib/api';

vi.mock('../lib/api', () => ({
  api: { get: vi.fn(), post: vi.fn() },
  ApiError: class ApiError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.name = 'ApiError';
      this.status = status;
    }
  },
}));

vi.mock('react-router-dom', () => ({ useNavigate: () => vi.fn() }));

const mockUser: { perfil: 'admin' | 'gerente' | 'operador' } = { perfil: 'gerente' };
vi.mock('../auth/AuthContext', () => ({ useAuth: () => ({ user: mockUser }) }));

const apiGet = vi.mocked(api.get);

const FICHAS = {
  rows: [
    { id: 1, produto_id: 5, produto_id__label: 'Camisa Polo', mao_obra: 5, custos_indiretos: 3, margem_pct: 100, custo_calculado: 30, preco_sugerido: 60 },
    { id: 2, produto_id: 6, produto_id__label: 'Calça Jeans', mao_obra: 8, custos_indiretos: 2, margem_pct: 80, custo_calculado: 50, preco_sugerido: 90 },
    { id: 3, produto_id: 7, produto_id__label: 'Boné', mao_obra: 0, custos_indiretos: 0, margem_pct: 0, custo_calculado: null, preco_sugerido: null },
  ],
};

function mockFichas(rows: unknown) {
  apiGet.mockImplementation((path: string) => {
    if (String(path).startsWith('/fichas')) return Promise.resolve(rows);
    if (String(path).includes('/options')) return Promise.resolve([{ value: 5, label: 'Camisa Polo' }]);
    return Promise.resolve([]);
  });
}

function montar() {
  return render(
    <ToastProvider>
      <CustoPage />
    </ToastProvider>
  );
}

describe('CustoPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUser.perfil = 'gerente';
  });

  it('mostra a fórmula do servidor no cabeçalho', async () => {
    mockFichas(FICHAS);
    montar();
    expect(await screen.findByText('Custo de Fabricação')).toBeInTheDocument();
    expect(screen.getByText(/Custo unitário = Σ\(insumo × \(1 \+ perda%\) × custo médio\) \+ mão de obra \+ indiretos/)).toBeInTheDocument();
  });

  it('lista as fichas com custo e preço vindos do servidor, e "—" quando ainda não foi calculado', async () => {
    mockFichas(FICHAS);
    montar();
    expect(await screen.findByText('Camisa Polo')).toBeInTheDocument();
    expect(screen.getByText('Calça Jeans')).toBeInTheDocument();
    expect(screen.getByText('Boné')).toBeInTheDocument();
    expect(screen.getByText('R$ 30,00')).toBeInTheDocument();
    expect(screen.getByText('R$ 60,00')).toBeInTheDocument();
    expect(screen.getByText('R$ 50,00')).toBeInTheDocument();
    expect(screen.getByText('R$ 90,00')).toBeInTheDocument();
    // ficha sem cálculo não inventa zero: mostra traço
    expect(screen.getAllByText('—')).toHaveLength(2);
  });

  it('os totais somam as fichas que vieram (30+50 = 80 de custo, 60+90 = 150 de preço)', async () => {
    mockFichas(FICHAS);
    montar();
    await screen.findByText('Camisa Polo');
    expect(screen.getByText('R$ 80,00')).toBeInTheDocument();
    expect(screen.getByText('R$ 150,00')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
  });

  it('busca que não acha nada diz "Nada encontrado" e não o vazio de cadastro', async () => {
    mockFichas(FICHAS);
    montar();
    fireEvent.change(await screen.findByPlaceholderText('Buscar produto...'), { target: { value: 'inexistente' } });
    expect(await screen.findByText('Nada encontrado')).toBeInTheDocument();
    expect(screen.queryByText('Nenhuma ficha técnica cadastrada')).not.toBeInTheDocument();
  });

  it('busca filtra pelo rótulo do produto', async () => {
    mockFichas(FICHAS);
    montar();
    fireEvent.change(await screen.findByPlaceholderText('Buscar produto...'), { target: { value: 'jeans' } });
    await waitFor(() => expect(screen.queryByText('Camisa Polo')).not.toBeInTheDocument());
    expect(screen.getByText('Calça Jeans')).toBeInTheDocument();
  });

  it('sem ficha cadastrada mostra estado vazio com a ação de criar', async () => {
    mockFichas({ rows: [] });
    montar();
    expect(await screen.findByText('Nenhuma ficha técnica cadastrada')).toBeInTheDocument();
    expect(screen.getByText(/Crie a ficha de um produto/)).toBeInTheDocument();
    expect(screen.getAllByText('Nova ficha técnica').length).toBeGreaterThan(0);
  });

  it('erro de rede mostra a mensagem do servidor', async () => {
    apiGet.mockRejectedValue(new Error('Banco indisponível'));
    montar();
    expect(await screen.findByText(/Banco indisponível/)).toBeInTheDocument();
  });

  it('operador não vê o botão de criar ficha', async () => {
    mockUser.perfil = 'operador';
    mockFichas(FICHAS);
    montar();
    await screen.findByText('Camisa Polo');
    expect(screen.queryByText('Nova ficha técnica')).not.toBeInTheDocument();
  });
});
