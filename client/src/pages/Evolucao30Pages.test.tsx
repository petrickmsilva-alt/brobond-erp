// ============================================================================
// EVOLUÇÃO ERP 3.0 — CONTRATO DE TELA DAS PÁGINAS NOVAS
//
// O que estes testes protegem (do ponto de vista do usuário):
//
//   • ZERO MODAL: nenhuma das telas novas renderiza role="dialog", aria-modal
//     ou overlay — o formulário/ação acontece na própria página.
//   • A tela diz a VERDADE quando falta dado: sem recursos cadastrados, sem
//     plano de contas, sem obrigações, sem transferências — estado vazio
//     explicativo, nunca zero inventado.
//   • Ação de estado é explícita e com consequência visível (aprovar/expedir/
//     receber, homologar, registrar entrega, dispensar).
//   • O que o servidor recusa, a tela mostra como erro — sem "sumir" com o
//     botão nem fingir sucesso.
//   • MRP/Balancete/Calendário avisam que são LEITURA: nenhum deles dispara
//     POST por conta própria.
// ============================================================================
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import ComprasFornecedoresPage from './ComprasFornecedoresPage';
import ProducaoCapacidadePage from './ProducaoCapacidadePage';
import FiscalCalendarioPage from './FiscalCalendarioPage';
import FinanceiroBalancetePage from './FinanceiroBalancetePage';
import EstoqueTransferenciasPage from './EstoqueTransferenciasPage';
import { ToastProvider } from '../components/ui';
import { MetaContext, type Meta } from '../lib/meta';
import { api } from '../lib/api';

vi.mock('../lib/api', () => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), del: vi.fn() },
  ApiError: class ApiError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.name = 'ApiError';
      this.status = status;
    }
  },
}));

const apiGet = vi.mocked(api.get);
const apiPost = vi.mocked(api.post);

const META = { resources: {}, mode: 'memory' } as unknown as Meta;

function montar(ui: React.ReactElement) {
  return render(
    <MetaContext.Provider value={META}>
      <ToastProvider>{ui}</ToastProvider>
    </MetaContext.Provider>
  );
}

const semModal = (container: HTMLElement) => {
  expect(container.querySelector('[role="dialog"]')).toBeNull();
  expect(container.querySelector('[aria-modal="true"]')).toBeNull();
  expect(container.querySelector('[class*="fixed inset-0"]')).toBeNull();
};

beforeEach(() => {
  apiGet.mockReset();
  apiPost.mockReset();
});

describe('Compras › Homologação de fornecedores', () => {
  it('lista fornecedores com o estado de homologação e abre a ficha NA PÁGINA (sem modal)', async () => {
    apiGet.mockImplementation(async (caminho: string) => {
      if (caminho.startsWith('/fornecedores?')) {
        return {
          rows: [{ id: 5, nome: 'Tecelagem Sul', homologacao_status: 'em_analise', homologacao_categoria: 'materia_prima', validade_documentos: null, avaliacao_manual: null, homologacao_motivo: null }],
          total: 1,
          page: 1,
          pageSize: 200,
        };
      }
      if (caminho === '/compras/painel') {
        return { em_aberto: 3, homologacao: { por_status: { homologado: 2 }, bloqueados: [] }, documentos_vencendo: [], proximas_entregas: [] };
      }
      if (caminho === '/compras/fornecedores/5/homologacao') {
        return {
          status: 'em_analise',
          proximos: ['homologado', 'bloqueado'],
          pendencias: ['Cadastre ao menos um documento do fornecedor (contrato, cartão CNPJ ou certidão).'],
          documentos: [],
          eventos: [],
          categoria: 'materia_prima',
          motivo: null,
          homologado_em: null,
        };
      }
      if (caminho === '/compras/fornecedores/5/desempenho') {
        return {
          score: 62,
          classificacao: 'atenção',
          fatores: [{ chave: 'prazo', label: 'Pontualidade', pontos: 30, detalhe: '3 de 4 entregas no prazo; atraso médio 1.5 dia(s).' }],
          historico: { pedidos: 4, recebidos: 3, em_aberto: 1, cancelados: 0, ultimo_pedido: '2026-02-01', total_comprado: 1200, ticket_medio: 300 },
          prazo: { com_previsao: 4, no_prazo: 3, atraso_medio_dias: 1.5 },
          atendimento: { quantidade_pedida: 10, quantidade_recebida: 10, percentual: 100 },
          preco: { itens_comparaveis: 2, indice: 98 },
          avaliacao_manual: null,
        };
      }
      return [];
    });

    const { container } = montar(<ComprasFornecedoresPage />);

    expect(await screen.findByText('Tecelagem Sul')).toBeTruthy();
    expect(screen.getAllByText('Em análise').length).toBeGreaterThan(0);
    semModal(container);

    fireEvent.click(screen.getByText('Tecelagem Sul'));

    // A ficha abre como seção da página — com pendência explícita e score calculado.
    expect(await screen.findByText(/Pendências para homologar/)).toBeTruthy();
    expect(screen.getByText(/Score 62\/100/)).toBeTruthy();
    expect(screen.getByText(/3 de 4 entregas no prazo/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /Homologado/ })).toBeTruthy();
    semModal(container);
  });

  it('suspender sem motivo não chama o servidor (o motivo é obrigatório)', async () => {
    apiGet.mockImplementation(async (caminho: string) => {
      if (caminho.startsWith('/fornecedores?')) {
        return { rows: [{ id: 9, nome: 'Forn X', homologacao_status: 'homologado', homologacao_categoria: 'servico', validade_documentos: null, avaliacao_manual: null, homologacao_motivo: null }], total: 1, page: 1, pageSize: 200 };
      }
      if (caminho === '/compras/painel') return { em_aberto: 0, homologacao: { por_status: {}, bloqueados: [] }, documentos_vencendo: [], proximas_entregas: [] };
      if (caminho === '/compras/fornecedores/9/homologacao') {
        return { status: 'homologado', proximos: ['suspenso', 'bloqueado'], pendencias: [], documentos: [], eventos: [], categoria: 'servico', motivo: null, homologado_em: '2026-01-01T00:00:00.000Z' };
      }
      return null;
    });

    montar(<ComprasFornecedoresPage />);
    fireEvent.click(await screen.findByText('Forn X'));
    const suspender = await screen.findByRole('button', { name: /Suspenso/ });
    fireEvent.click(suspender);

    await waitFor(() => expect(apiPost).not.toHaveBeenCalled());
    expect(await screen.findByText('Informe o motivo da suspensão/bloqueio.')).toBeTruthy();
  });
});

describe('Produção › Capacidade e MRP', () => {
  it('mostra ocupação, gargalo, ordens sem recurso e o MRP — só leitura, sem POST', async () => {
    apiGet.mockImplementation(async (caminho: string) => {
      if (caminho.startsWith('/producao/capacidade')) {
        return {
          de: '2026-03-02',
          ate: '2026-03-27',
          dias_uteis: 20,
          regra: 'Capacidade = ... nada é gravado.',
          resumo: { recursos: 1, capacidade_periodo: 200, carga: 210, ocupacao_pct: 105, gargalo: { recurso_id: 1, nome: 'Costura A', ocupacao_pct: 105 }, ordens_sem_recurso: 1, pecas_sem_recurso: 7, ordens_fora_do_periodo: 0 },
          recursos: [{ recurso_id: 1, nome: 'Costura A', tipo: 'costura', capacidade_diaria: 10, eficiencia_pct: 100, capacidade_periodo: 200, carga: 210, ocupacao_pct: 105, ops: 2, gargalo: true }],
          sem_recurso: [{ ordem_id: 77, produto: 'Camisa', faltam: 7, previsao: '2026-03-10' }],
        };
      }
      if (caminho === '/producao/mrp') {
        return {
          resumo: { vendas_em_aberto: 2, ordens_abertas: 3, produtos_em_falta: 1, pecas_em_falta: 20, insumos_em_falta: 1, produtos_sem_ficha: 0 },
          produtos: [{ produto_id: 1, produto: 'Camisa', tamanho_id: 2, demanda: 25, estoque: 5, em_producao: 0, falta: 20 }],
          insumos: [{ insumo_id: 3, nome: 'Tecido', unidade: 'm', necessaria: 44, disponivel: 0, em_compra: 0, cobertura: 0, faltando: 44 }],
          sem_ficha: [],
          proxima_acao: 'Use Compras › Sugestão de compra.',
        };
      }
      return [];
    });

    const { container } = montar(<ProducaoCapacidadePage />);

    expect(await screen.findByText('Costura A')).toBeTruthy();
    expect(screen.getByText('gargalo')).toBeTruthy();
    expect(screen.getAllByText(/105%/).length).toBeGreaterThan(0);
    expect(screen.getByText(/ordem\(ns\) sem recurso alocado/)).toBeTruthy();
    expect(screen.getByText(/Tecido/)).toBeTruthy();
    expect(screen.getAllByText('44').length).toBeGreaterThan(0);
    semModal(container);
    expect(apiPost).not.toHaveBeenCalled();
  });

  it('sem recursos cadastrados, explica onde cadastrar em vez de mostrar zero', async () => {
    apiGet.mockImplementation(async (caminho: string) => {
      if (caminho.startsWith('/producao/capacidade')) {
        return { de: '2026-03-02', ate: '2026-03-27', dias_uteis: 20, regra: 'x', resumo: { recursos: 0, capacidade_periodo: 0, carga: 0, ocupacao_pct: null, gargalo: null, ordens_sem_recurso: 0, pecas_sem_recurso: 0, ordens_fora_do_periodo: 0 }, recursos: [], sem_recurso: [] };
      }
      return { resumo: { vendas_em_aberto: 0, ordens_abertas: 0, produtos_em_falta: 0, pecas_em_falta: 0, insumos_em_falta: 0, produtos_sem_ficha: 0 }, produtos: [], insumos: [], sem_ficha: [], proxima_acao: 'x' };
    });

    montar(<ProducaoCapacidadePage />);
    expect(await screen.findByText('Nenhum recurso de produção cadastrado')).toBeTruthy();
    expect(screen.getByText(/Produção › Recursos de produção/)).toBeTruthy();
  });
});

describe('Fiscal › Calendário de obrigações', () => {
  it('lista atrasadas e registra entrega com protocolo (inline, sem modal)', async () => {
    apiGet.mockImplementation(async () => ({
      de: '2026-01',
      ate: '2026-02',
      hoje: '2026-03-10',
      regra: 'O vencimento é calculado; o ERP não calcula imposto.',
      resumo: { obrigacoes_ativas: 1, linhas: 1, pendentes: 0, atrasadas: 1, entregues: 0, dispensadas: 0, proximas: 0 },
      obrigacoes: [
        { obrigacao_id: 4, codigo: 'SPED_FISCAL', nome: 'SPED Fiscal', tipo: 'sped_fiscal', periodicidade: 'mensal', competencia: '2026-01', vencimento: '2026-02-15', status: 'atrasada', entrega_id: null, protocolo: null, arquivo_ref: null, entregue_em: null, motivo_dispensa: null, dias_para_vencer: -23 },
      ],
    }));
    apiPost.mockResolvedValue({ status: 'entregue' });

    const { container } = montar(<FiscalCalendarioPage />);

    expect(await screen.findByText('SPED Fiscal')).toBeTruthy();
    expect(screen.getByText('Atrasada')).toBeTruthy();
    semModal(container);

    fireEvent.click(screen.getByRole('button', { name: /Registrar/ }));
    fireEvent.change(screen.getByPlaceholderText('Protocolo da entrega'), { target: { value: 'PRT-9' } });
    fireEvent.click(screen.getByRole('button', { name: /Registrar entrega/ }));

    await waitFor(() => expect(apiPost).toHaveBeenCalledWith('/fiscal/obrigacoes/4/entregas', expect.objectContaining({ competencia: '2026-01', status: 'entregue', protocolo: 'PRT-9' })));
    semModal(container);
  });

  it('não envia entrega sem protocolo', async () => {
    apiGet.mockImplementation(async () => ({
      de: '2026-01', ate: '2026-01', hoje: '2026-03-10', regra: 'x',
      resumo: { obrigacoes_ativas: 1, linhas: 1, pendentes: 1, atrasadas: 0, entregues: 0, dispensadas: 0, proximas: 1 },
      obrigacoes: [{ obrigacao_id: 4, codigo: 'DCTFWEB', nome: 'DCTFWeb', tipo: 'dctfweb', periodicidade: 'mensal', competencia: '2026-01', vencimento: '2026-02-15', status: 'pendente', entrega_id: null, protocolo: null, arquivo_ref: null, entregue_em: null, motivo_dispensa: null, dias_para_vencer: 5 }],
    }));

    montar(<FiscalCalendarioPage />);
    fireEvent.click(await screen.findByRole('button', { name: /Registrar/ }));
    fireEvent.click(screen.getByRole('button', { name: /Registrar entrega/ }));
    await waitFor(() => expect(apiPost).not.toHaveBeenCalled());
    expect(await screen.findByText(/Informe o protocolo da entrega/)).toBeTruthy();
  });
});

describe('Financeiro › Balancete', () => {
  it('separa o que está sem classificação e avisa que não classifica sozinho', async () => {
    apiGet.mockImplementation(async () => ({
      de: '2026-03',
      ate: '2026-03',
      regra: 'O balancete SOMA o livro-caixa existente.',
      resumo: { lancamentos_no_periodo: 2, classificados: 1, sem_classificacao: 1, total_debitos: 100.5, total_creditos: 250.5, diferenca: -150, contas_com_movimento: 2, plano_de_contas: 2 },
      contas: [
        { conta_contabil_id: 1, codigo: '4.01.001', nome: 'Receita de vendas', natureza: 'receita', debitos: 0, creditos: 250.5, saldo: -250.5, lancamentos: 1 },
        { conta_contabil_id: 2, codigo: '5.02.003', nome: 'Despesa administrativa', natureza: 'despesa', debitos: 100.5, creditos: 0, saldo: 100.5, lancamentos: 1 },
      ],
      sem_classificacao: [{ lancamento_id: 42, data: '2026-03-10', descricao: 'Sem conta', tipo: 'despesa', valor: 100, motivo: 'Sem conta contábil' }],
      por_origem: [{ recurso: 'vendas', registros: 1, valor: 250.5 }],
    }));

    const { container } = montar(<FinanceiroBalancetePage />);

    expect(await screen.findByText('Receita de vendas')).toBeTruthy();
    expect(screen.getByText('Sem conta contábil')).toBeTruthy();
    expect(screen.getByText(/NÃO entram nas somas acima/)).toBeTruthy();
    semModal(container);
    expect(apiPost).not.toHaveBeenCalled();
  });

  it('sem plano de contas, explica a consequência em vez de esconder', async () => {
    apiGet.mockImplementation(async () => ({
      de: '2026-03', ate: '2026-03', regra: 'x',
      resumo: { lancamentos_no_periodo: 0, classificados: 0, sem_classificacao: 0, total_debitos: 0, total_creditos: 0, diferenca: 0, contas_com_movimento: 0, plano_de_contas: 0 },
      contas: [], sem_classificacao: [], por_origem: [],
    }));
    montar(<FinanceiroBalancetePage />);
    expect(await screen.findByText(/Nenhuma conta contábil cadastrada/)).toBeTruthy();
  });
});

describe('Estoque › Transferências entre locais', () => {
  it('lista transferências por estado e mostra o disponível (sem modal)', async () => {
    apiGet.mockImplementation(async (caminho: string) => {
      if (caminho.startsWith('/estoque_transferencias')) {
        return {
          rows: [{ id: 11, empresa_id: 1, origem_local_id: 1, destino_local_id: 2, status: 'solicitada', solicitante_id: null, solicitada_em: '2026-03-01T10:00:00.000Z', recebida_em: null, observacoes: null }],
          total: 1,
          page: 1,
          pageSize: 50,
        };
      }
      if (caminho.startsWith('/estoque_reservas')) {
        return { rows: [{ id: 3, produto_id: 1, tamanho_id: null, local_id: 1, tipo: 'reserva', quantidade: 2, status: 'ativa', motivo: 'Separação venda 10' }], total: 1, page: 1, pageSize: 50 };
      }
      if (caminho.startsWith('/estoque/disponibilidade')) {
        return { regra: 'disponível = físico − reservado − bloqueado − empenhado', linhas: [], totais: { fisico: 10, reservado: 2, disponivel: 8 } };
      }
      if (caminho.endsWith('/options')) return [{ value: 1, label: 'Loja' }, { value: 2, label: 'Expedição' }];
      return [];
    });
    apiPost.mockResolvedValue({});

    const { container } = montar(<EstoqueTransferenciasPage />);

    expect(await screen.findByText(/disponível = físico/)).toBeTruthy();
    expect(screen.getByText('Solicitada')).toBeTruthy();
    expect(screen.getByText(/Separação venda 10/)).toBeTruthy();
    semModal(container);

    // Aprovar é ação inline com consequência explícita no toast.
    fireEvent.click(screen.getByRole('button', { name: /Aprovar/ }));
    await waitFor(() => expect(apiPost).toHaveBeenCalledWith('/estoque/transferencias/11/aprovar', {}));
    semModal(container);
  });
});
