// ============================================================================
// COMISSÕES — contrato de tela (ERP-06, fecha o P1-05 do lado do front).
//
// O cálculo e o livro de efetivação já existiam e estavam testados no servidor
// (`server/test/financeiro-p2.test.ts`, `pg/comissoes-periodo.test.ts`), mas
// nenhuma tela os consumia. O que estes testes travam:
//   • a tela fala com o SERVIDOR (`/financeiro/comissoes`), não recalcula;
//   • APURADA, EFETIVADA, ESTORNADA e SALDO aparecem separados — apurado não é
//     "pago", e a tela diz isso (a regra é efetivar conforme o recebimento);
//   • o fechamento do período é CONFERÊNCIA: o botão compara com o relatório
//     `comissoes` do MESMO período e mostra o resultado (inclusive divergência);
//   • o drill-down busca as vendas do representante e o livro de cada venda;
//   • venda apurada e não recebida aparece com livro vazio, sem inventar baixa.
// ============================================================================
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ComissoesPage from './ComissoesPage';
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
const { ApiError } = await import('../lib/api');

const RESUMO = {
  periodo: { de: '2026-10-01', ate: '2026-10-31' },
  linhas: [
    { representante_id: 4, representante: 'Ana Representante', apurada: 300, efetivada: 120, estornada: 0, saldo: 120, vendas: 2 },
    { representante_id: 9, representante: 'Beto Representante', apurada: 50, efetivada: 0, estornada: 10, saldo: -10, vendas: 1 },
  ],
  resumo: { apurada: 350, efetivada: 120, estornada: 10, saldo: 110 },
};

const VENDAS = {
  rows: [
    { id: 12, data: '2026-10-03', faturada_em: '2026-10-03T12:00:00Z', status: 'faturada', total: 2000, comissao_pct: 10, comissao_valor: 200 },
    { id: 15, data: '2026-10-09', faturada_em: '2026-10-09T12:00:00Z', status: 'faturada', total: 1000, comissao_pct: 10, comissao_valor: 100 },
  ],
};

/** Roteia as chamadas da tela por rota, deixando cada teste sobrescrever o que quiser. */
function responder(routes: Record<string, unknown> = {}) {
  apiGet.mockImplementation(async (path: string) => {
    for (const [chave, valor] of Object.entries(routes)) {
      if (path.startsWith(chave)) {
        if (valor instanceof Error) throw valor;
        return valor as any;
      }
    }
    if (path.startsWith('/financeiro/comissoes/venda/')) {
      return { venda_id: 12, apurada: 200, pct: 10, efetivada: 0, eventos: [] } as any;
    }
    if (path.startsWith('/financeiro/comissoes')) return RESUMO as any;
    if (path.startsWith('/relatorios/comissoes')) return { linhas: [{ representante: 'Ana Representante', comissao: 350 }] } as any;
    if (path.startsWith('/vendas')) return VENDAS as any;
    throw new Error(`rota não esperada no teste: ${path}`);
  });
}

function montar() {
  return render(
    <ToastProvider>
      <ComissoesPage />
    </ToastProvider>
  );
}

describe('ComissoesPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    responder();
  });

  it('lê o resumo do servidor para o período e mostra os quatro números separados', async () => {
    montar();

    await waitFor(() => expect(screen.getByText('Ana Representante')).toBeTruthy());
    expect(apiGet).toHaveBeenCalledWith(expect.stringContaining('/financeiro/comissoes?de='));

    // Apurada ≠ efetivada: a tela não colapsa "foi faturada" em "foi paga".
    const corpo = document.body.textContent || '';
    expect(corpo).toContain('Apurada no período');
    expect(corpo).toContain('Efetivada (recebida)');
    expect(corpo).toContain('Saldo a receber do representante');
    // Totais do rodapé, em valores reais do servidor (R$ 350 apurados, R$ 120 efetivados).
    // O `formatMoney` usa `toLocaleString('pt-BR')`, cujo espaço é NBSP — daí a regex.
    expect(corpo).toMatch(/R\$\s*350,00/);
    expect(corpo).toMatch(/R\$\s*120,00/);
  });

  it('explica que a comissão é efetivada pelo recebimento e que saldo negativo é estorno', async () => {
    montar();
    await waitFor(() => expect(screen.getByText('Beto Representante')).toBeTruthy());

    const texto = document.body.textContent || '';
    expect(texto).toMatch(/Recebimento parcial efetiva a parte proporcional/);
    expect(texto).toMatch(/não é comissão devida/);
  });

  it('mudar o período refaz a consulta com as novas datas', async () => {
    montar();
    await waitFor(() => expect(screen.getByText('Ana Representante')).toBeTruthy());

    const campoDe = screen.getByLabelText('De') as HTMLInputElement;
    await userEvent.clear(campoDe);
    await userEvent.type(campoDe, '2026-09-01');

    await waitFor(() =>
      expect(apiGet).toHaveBeenCalledWith(expect.stringContaining('de=2026-09-01'))
    );
  });

  it('conferir com o relatório: soma igual confirma o fechamento do período', async () => {
    montar();
    await waitFor(() => expect(screen.getByText('Ana Representante')).toBeTruthy());

    await userEvent.click(screen.getByRole('button', { name: /Conferir com o relatório/i }));

    await waitFor(() =>
      expect(apiGet).toHaveBeenCalledWith(expect.stringContaining('/relatorios/comissoes?de='))
    );
    await waitFor(() => expect(screen.getByText(/Confere com o relatório de comissões/i)).toBeTruthy());
  });

  it('conferir com o relatório: divergência aparece como divergência (não é escondida)', async () => {
    responder({ '/relatorios/comissoes': { linhas: [{ representante: 'Ana Representante', comissao: 300 }] } });
    montar();
    await waitFor(() => expect(screen.getByText('Ana Representante')).toBeTruthy());

    await userEvent.click(screen.getByRole('button', { name: /Conferir com o relatório/i }));

    await waitFor(() => expect(screen.getByText(/Divergência entre a tela e o relatório/i)).toBeTruthy());
  });

  it('abre as vendas do representante com o período escolhido e mostra o livro da venda', async () => {
    montar();
    await waitFor(() => expect(screen.getByText('Ana Representante')).toBeTruthy());

    await userEvent.click(screen.getAllByRole('button', { name: 'Ver vendas' })[0]);

    await waitFor(() => expect(screen.getByText('#12')).toBeTruthy());
    expect(apiGet).toHaveBeenCalledWith(expect.stringContaining('f.representante_id=4'));
    expect(apiGet).toHaveBeenCalledWith(expect.stringContaining('f.data_de='));
    expect(screen.getByText('R$ 200,00')).toBeTruthy();

    await userEvent.click(screen.getAllByRole('button', { name: 'Livro' })[0]);

    await waitFor(() => expect(apiGet).toHaveBeenCalledWith('/financeiro/comissoes/venda/12'));
    await waitFor(() => expect(screen.getByText(/Livro da venda #12/)).toBeTruthy());
  });

  it('venda apurada e NÃO recebida: o livro vazio diz que nada foi efetivado', async () => {
    responder({
      '/financeiro/comissoes/venda/': { venda_id: 12, apurada: 200, pct: 10, efetivada: 0, eventos: [] },
    });
    montar();
    await waitFor(() => expect(screen.getByText('Ana Representante')).toBeTruthy());

    await userEvent.click(screen.getAllByRole('button', { name: 'Ver vendas' })[0]);
    await waitFor(() => expect(screen.getByText('#12')).toBeTruthy());
    await userEvent.click(screen.getAllByRole('button', { name: 'Livro' })[0]);

    await waitFor(() =>
      expect(screen.getByText(/a comissão está apurada e ainda/i)).toBeTruthy()
    );
  });

  it('erro do servidor aparece na tela, não em alerta genérico', async () => {
    responder({ '/financeiro/comissoes': new ApiError(403, 'Você não tem permissão para ver comissões.') });
    montar();

    await waitFor(() =>
      expect(screen.getByText('Você não tem permissão para ver comissões.')).toBeTruthy()
    );
  });
});
