// ============================================================================
// TABELA DE MEDIDAS — chegada por link vindo do cadastro de Grades.
//
// O módulo de medidas NÃO foi recriado: a lista de grades ganhou a ação
// "Tabela de medidas", que abre /medidas?grade=<id>. Este arquivo trava as duas
// pontas desse acordo:
//   1. com o parâmetro, a grade já chega selecionada e a tabela dela é carregada
//      (o operador não precisa procurar a grade na lista);
//   2. sem o parâmetro, o módulo continua exatamente como era — só o painel de
//      completude é carregado, nenhuma tabela é aberta por conta própria.
// ============================================================================
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import MedidasPage from './MedidasPage';
import { ToastProvider } from '../components/ui';
import { api } from '../lib/api';

vi.mock('../lib/api', () => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), del: vi.fn() },
  ApiError: class ApiError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
    }
  },
  downloadFile: vi.fn(),
}));

vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({ user: { id: 1, name: 'Admin', perfil: 'admin' } }),
}));

const apiGet = vi.mocked(api.get);

const RESUMO = {
  total: 2,
  grades: [
    { id: 7, nome: 'Camiseta PP-GG', ativo: true, tamanhos: 2, colunas: 1, celulas_total: 2, celulas_preenchidas: 1, pct: 50, atualizada_em: '2026-10-01T12:00:00.000Z' },
    { id: 8, nome: 'Calça 36-48', ativo: true, tamanhos: 3, colunas: 0, celulas_total: 0, celulas_preenchidas: 0, pct: 0, atualizada_em: null },
  ],
};

const TABELA_GRADE_7 = {
  grade: { id: 7, nome: 'Camiseta PP-GG', instrucoes_medidas: 'Meça a peça sobre uma superfície plana.' },
  medidas: [{ id: 11, nome: 'Largura (A)', unidade: 'cm', ordem: 1 }],
  tamanhos: [
    { id: 2, codigo: 'P' },
    { id: 3, codigo: 'M' },
  ],
  valores: [{ id: 31, medida_id: 11, tamanho_id: 2, valor: 50 }],
  resumo: { celulas_total: 2, celulas_preenchidas: 1, pct: 50, atualizada_em: '2026-10-01T12:00:00.000Z' },
};

function abrir(url: string) {
  return render(
    <MemoryRouter initialEntries={[url]}>
      <ToastProvider>
        <MedidasPage />
      </ToastProvider>
    </MemoryRouter>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  apiGet.mockImplementation(async (url: string) => {
    const caminho = String(url);
    if (caminho === '/grades/medidas-resumo') return RESUMO as never;
    if (caminho === '/grades/7/medidas') return TABELA_GRADE_7 as never;
    return {} as never;
  });
});

describe('Tabela de medidas — deep link do cadastro de grades', () => {
  it('?grade=<id> já abre a tabela daquela grade (sem procurar na lista)', async () => {
    abrir('/medidas?grade=7');

    await waitFor(() => expect(apiGet).toHaveBeenCalledWith('/grades/7/medidas'));
    // A tabela carregada é a da grade do link: coluna, valores e orientações.
    // As colunas são editáveis, então o nome da medida aparece como valor de input.
    expect(await screen.findByDisplayValue('Largura (A)')).toBeInTheDocument();
    expect(screen.getByDisplayValue('50')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Meça a peça sobre uma superfície plana.')).toBeInTheDocument();
    // O painel de completude continua sendo o mesmo (nada foi recriado).
    expect((await screen.findAllByText('Camiseta PP-GG')).length).toBeGreaterThan(0);
    expect(screen.getAllByText('Calça 36-48').length).toBeGreaterThan(0);
  });

  it('aplica o link uma única vez (não briga com a navegação da própria página)', async () => {
    abrir('/medidas?grade=7');

    await waitFor(() => expect(apiGet).toHaveBeenCalledWith('/grades/7/medidas'));
    await screen.findByDisplayValue('Largura (A)');
    expect(apiGet.mock.calls.filter(([p]) => String(p) === '/grades/7/medidas')).toHaveLength(1);
  });

  it('sem o parâmetro o módulo se comporta como antes: só o painel de completude', async () => {
    abrir('/medidas');

    expect((await screen.findAllByText('Camiseta PP-GG')).length).toBeGreaterThan(0);
    await waitFor(() => expect(apiGet).toHaveBeenCalledWith('/grades/medidas-resumo'));
    expect(apiGet.mock.calls.filter(([p]) => /\/grades\/\d+\/medidas$/.test(String(p)))).toHaveLength(0);
  });

  it('parâmetro inválido não abre tabela nenhuma', async () => {
    abrir('/medidas?grade=abc');

    expect((await screen.findAllByText('Camiseta PP-GG')).length).toBeGreaterThan(0);
    expect(apiGet.mock.calls.filter(([p]) => /\/grades\/\d+\/medidas$/.test(String(p)))).toHaveLength(0);
  });
});
