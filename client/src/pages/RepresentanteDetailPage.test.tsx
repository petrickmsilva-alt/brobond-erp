// ============================================================================
// REPRESENTANTE — PÁGINA DA FICHA + PAINEL (/representantes/:id).
//
// Trava o padrão LISTA → PÁGINA do BROBOND ERP e a divisão de responsabilidade
// entre servidor e tela:
//   • a página NÃO calcula indicador: consome um único contrato
//     (`GET /comercial/representantes/:id/painel`) que o servidor deriva das
//     fontes oficiais (vendas faturadas, metas, comissão, carteira, equipe);
//   • cadastro (identidade PF/PJ, contato, endereço), estrutura comercial
//     (território, equipe, hierarquia), carteira, metas, comissão e indicadores
//     aparecem como LEITURA — sem verdade manual e sem campo inventado;
//   • 404 = inexistente OU de outra empresa: a página continua sendo uma ROTA,
//     com caminho de volta (nenhum modal de erro);
//   • nenhum modal/drawer/sheet/overlay/portal é montado.
// ============================================================================
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import RepresentanteDetailPage from './RepresentanteDetailPage';
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
  return { ...actual, useParams: () => routeParams, useNavigate: () => navigateMock };
});

const PAINEL = {
  representante: {
    id: 4,
    codigo: 'REP00004',
    nome: 'Carlos Lima',
    tipo_pessoa: 'PF',
    tipo_representante: 'GERENTE',
    cpf: '52998224725',
    cnpj: null,
    razao_social: null,
    nome_fantasia: null,
    cargo: 'Gerente comercial',
    registro_profissional: 'CORE-1234',
    orgao_registro: 'CORE',
    data_nascimento: '1985-04-12',
    admissao: '2024-03-01',
    desligamento: null,
    ativo: true,
    comissao_pct: 3.5,
    contato: { telefone: '6233334444', celular: '62988887777', whatsapp: null, email: 'carlos@brobond.com.br' },
    endereco: {
      cep: '74000000',
      logradouro: 'Avenida Central',
      numero: '100',
      complemento: null,
      bairro: 'Setor Bueno',
      cidade: 'Goiânia',
      uf: 'GO',
      pais: 'Brasil',
    },
    regiao_legado: 'Centro-Oeste',
  },
  estrutura: {
    territorio: { id: 10, nome: 'Centro-Oeste', codigo: 'T-CO', tipo: 'regiao', uf: 'GO', cidade: null },
    equipes: [
      { equipe_id: 2, equipe: 'Equipe Alfa', papel: 'supervisor', participacao_pct: 100, entrada: '2026-01-01', saida: null, status: 'ativo', vigente: true },
    ],
    hierarquia: {
      supervisores: [{ representante_id: 9, nome: 'Marina Alves', nivel: 'gerente', inicio: '2026-01-01' }],
      subordinados: [{ representante_id: 11, nome: 'Ana Souza', nivel: 'supervisor', inicio: '2026-01-01' }],
    },
  },
  carteira: {
    vigentes: 1,
    encerrados: 1,
    cancelados: 0,
    total: 2,
    clientes_ativos: 1,
    clientes_inativos: 0,
    clientes: [
      { cliente_id: 30, cliente: 'Cliente Ativo Ltda', cliente_ativo: true, inicio: '2026-01-01', fim: null, status: 'ativo', participacao_pct: 100, vigente: true },
      { cliente_id: 31, cliente: 'Cliente Encerrado ME', cliente_ativo: true, inicio: '2025-01-01', fim: '2025-12-31', status: 'ativo', participacao_pct: 100, vigente: false },
    ],
  },
  metas: {
    total: 1,
    ativas: 1,
    linhas: [
      { meta_id: 5, alvo_tipo: 'representante', metrica: 'faturamento', periodo_inicio: '2026-01-01', periodo_fim: '2026-12-31', status: 'ativa', meta: 10000, realizado: 2500, atingimento_pct: 25, falta: 7500 },
    ],
  },
  comissao: { padrao_pct: 3.5, apurado_total: 250, estornado_total: 0, efetivado_total: 250, apuracoes: 1, eventos: 1 },
  indicadores: {
    vendas: 2,
    faturamento: 2500,
    pedidos: 2,
    clientes: 1,
    pecas: 10,
    ticket_medio: 1250,
    comissao: 250,
    meta: 10000,
    atingimento_pct: 25,
  },
  ranking: { posicao: 1, total: 4, faturamento: 2500 },
};

const apiGet = vi.mocked(api.get);

function montar() {
  return render(
    <MemoryRouter initialEntries={[`/representantes/${routeParams.id ?? ''}`]}>
      <ToastProvider>
        <RepresentanteDetailPage />
      </ToastProvider>
    </MemoryRouter>
  );
}

function semSobreposicao() {
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(document.querySelector('[aria-modal="true"]')).toBeNull();
  expect(document.querySelector('[data-drawer], [data-sheet]')).toBeNull();
}

beforeEach(() => {
  routeParams = { id: '4' };
  navigateMock.mockReset();
  apiGet.mockReset();
  apiGet.mockImplementation(async () => PAINEL as never);
});

describe('representante — página da ficha e painel', () => {
  it('carrega do servidor e apresenta cadastro, estrutura, carteira, metas, comissão e indicadores', async () => {
    montar();

    expect(await screen.findByRole('heading', { name: /Carlos Lima/ })).toBeInTheDocument();
    expect(apiGet).toHaveBeenCalledWith('/comercial/representantes/4/painel');

    // Identificação (cadastro mestre 2.0)
    expect(screen.getByText('(REP00004)')).toBeInTheDocument();
    expect(screen.getByText('529.982.247-25')).toBeInTheDocument();
    expect(screen.getByText('Gerente comercial')).toBeInTheDocument();
    expect(screen.getByText('CORE-1234 · CORE')).toBeInTheDocument();

    // Contato e endereço estruturado
    expect(screen.getByText('+55 (62) 3333-4444')).toBeInTheDocument();
    expect(screen.getByText('+55 (62) 98888-7777')).toBeInTheDocument();
    expect(screen.getByText('carlos@brobond.com.br')).toBeInTheDocument();
    expect(screen.getByText(/Avenida Central, 100 · Setor Bueno · Goiânia\/GO · 74000-000 · Brasil/)).toBeInTheDocument();

    // Estrutura comercial: território, equipe vigente e hierarquia
    expect(screen.getByText('Centro-Oeste (T-CO)')).toBeInTheDocument();
    expect(screen.getByText('Equipe Alfa')).toBeInTheDocument();
    expect(screen.getByText('Marina Alves (gerente)')).toBeInTheDocument();
    expect(screen.getByText('Ana Souza')).toBeInTheDocument();

    // Carteira: vigente x encerrado (histórico preservado)
    expect(screen.getByText('Cliente Ativo Ltda')).toBeInTheDocument();
    expect(screen.getByText('Cliente Encerrado ME')).toBeInTheDocument();
    expect(screen.getByText(/1 vigente\(s\) · 1 encerrado\(s\) · 0 cancelado\(s\)/)).toBeInTheDocument();

    // Metas: o realizado vem do servidor (vendas faturadas), nunca digitado
    // A meta aparece no StatCard, na tabela de metas e nos indicadores.
    expect(screen.getAllByText(/R\$\s*10\.000,00/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/R\$\s*2\.500,00/).length).toBeGreaterThan(0);
    expect(screen.getAllByText('25%').length).toBeGreaterThan(0);

    // Comissão: padrão do cadastro + motor
    expect(screen.getByText('Efetivado (recebimento)')).toBeInTheDocument();
    expect(screen.getByText('Apurado (motor)')).toBeInTheDocument();

    // Indicadores + ranking (mesma fonte do Painel Comercial)
    expect(screen.getByText('Ticket médio')).toBeInTheDocument();
    expect(screen.getByText('Ranking')).toBeInTheDocument();
    expect(screen.getByText('1º de 4')).toBeInTheDocument();

    semSobreposicao();
  });

  it('o botão "Editar cadastro" NAVEGA para a página de edição (sem sobreposição)', async () => {
    montar();
    await screen.findByRole('heading', { name: /Carlos Lima/ });
    screen.getByRole('button', { name: /Editar cadastro/ }).click();
    expect(navigateMock).toHaveBeenCalledWith('/representantes/4/editar');
    semSobreposicao();
  });

  it('tem caminho de volta para a lista (rota, não modal)', async () => {
    montar();
    await screen.findByRole('heading', { name: /Carlos Lima/ });
    expect(screen.getByRole('link', { name: /Voltar/ })).toHaveAttribute('href', '/representantes');
    const abrirModulo = screen.getAllByRole('link', { name: /Abrir módulo/ });
    expect(abrirModulo.some((a) => a.getAttribute('href') === '/carteira-clientes')).toBe(true);
    expect(abrirModulo.some((a) => a.getAttribute('href') === '/metas')).toBe(true);
  });

  it('404 (inexistente ou de outra empresa) mostra o caminho de volta, sem modal', async () => {
    apiGet.mockImplementation(async () => {
      throw new ApiError(404, 'Representante não encontrado.');
    });
    montar();

    expect(await screen.findByRole('heading', { name: /Representante não encontrado/ })).toBeInTheDocument();
    expect(screen.getByText(/Não encontramos este representante na empresa ativa/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Voltar para a lista/ })).toHaveAttribute('href', '/representantes');
    semSobreposicao();
  });

  it('falha de servidor mostra erro com "Tentar novamente" — nenhum número inventado', async () => {
    apiGet.mockImplementation(async () => {
      throw new ApiError(500, 'Falha ao montar o painel.');
    });
    montar();

    expect(await screen.findByText('Falha ao montar o painel.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Tentar novamente/ })).toBeInTheDocument();
    expect(screen.queryByText('Ranking')).toBeNull();
    semSobreposicao();
  });
});
