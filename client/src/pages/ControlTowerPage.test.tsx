// ============================================================================
// FASE 8 — AI CONTROL TOWER (/ai/control-tower).
// A tela NÃO calcula: exibe indicadores, saúde, previsões e recomendações que
// vêm do servidor, com definição/fórmula/limitações declaradas.
// ============================================================================
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import ControlTowerPage from './ControlTowerPage';

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

import { api } from '../lib/api';
const getMock = vi.mocked(api.get);

const TOWER = {
  empresa_id: 1,
  periodo: { atual: '2026-10', anterior: '2026-09' },
  indicadores: [
    {
      chave: 'receita',
      label: 'Receita (2026-10)',
      valor: 12345.67,
      unidade: 'moeda',
      definicao: 'Soma do total das vendas faturadas/entregues no período.',
      formula: 'Σ vendas.total',
      origem: ['vendas'],
      limitacoes: [],
    },
    {
      chave: 'margem_pct',
      label: 'Margem bruta (%)',
      valor: 42.5,
      unidade: 'percentual',
      definicao: 'Margem bruta sobre a receita.',
      formula: '(receita − CMV) / receita × 100',
      origem: ['vendas', 'itens_venda', 'produtos'],
      limitacoes: ['O custo é o unitário atual do cadastro, não o do lote da venda.'],
    },
  ],
  saude_operacional: {
    outbox_pendente: 2,
    outbox_erro: 1,
    pedidos_parados: 3,
    tickets_abertos: 4,
    tickets_sla_estourado: 1,
    alertas_abertos: 5,
    alertas_criticos: 2,
  },
  alertas: {
    totais: { abertos: 5, cientes: 1, resolvidos: 2, silenciados: 0, por_dominio: { estoque: 3 }, por_severidade: { alta: 2 } },
    criticos: [
      { id: 1, dominio: 'estoque', severidade: 'alta', titulo: 'Ruptura de estoque', detalhe: 'Produto X zerado', evidencia: { produto_id: 9 } },
    ],
  },
  previsoes: {
    demanda: [{ produto_id: 9, produto: 'Camiseta X', periodo: '2026-11', forecast: 120, metodo: 'media_movel' }],
    suprimento: [{ produto_id: 9, produto: 'Camiseta X', periodo: '2026-11', necessidade: 80, status: 'pendente' }],
    acuracia: { periodos_avaliados: 3, mae: 15.2, mape_pct: 8.4 },
    limitacoes: ['Previsões são estimativas: não são certeza.'],
  },
  recomendacoes: {
    pendentes: [
      {
        id: 7,
        dominio: 'estoque',
        score: 0.8,
        recomendacao: 'Repor o produto X',
        evidencia: { produto_id: 9, necessidade_valor: 1500 },
        status: 'pendente',
        criado_em: '2026-10-28T12:00:00.000Z',
        impacto_estimado: 1500,
        confianca: 'alta',
        requer_aprovacao: true,
      },
    ],
    total_pendentes: 1,
  },
  pendencias_criticas: [
    { origem: 'financeiro', descricao: 'A receber vencido de 900.00.', severidade: 'alta', evidencia: { valor_vencido: 900 } },
  ],
  limitacoes: ['Indicadores de CAC/LTV não são calculados aqui.'],
  gerado_em: '2026-10-28T12:00:00.000Z',
};

function renderPagina() {
  return render(
    <MemoryRouter>
      <ControlTowerPage />
    </MemoryRouter>
  );
}

describe('Fase 8 — AI Control Tower', () => {
  beforeEach(() => getMock.mockReset());

  it('renderiza indicadores, saúde, previsões e recomendações vindos do servidor', async () => {
    getMock.mockResolvedValue(TOWER);
    renderPagina();
    expect(await screen.findByText('Receita (2026-10)')).toBeInTheDocument();
    expect(screen.getByText('Margem bruta (%)')).toBeInTheDocument();
    expect(screen.getAllByText('Ruptura de estoque').length).toBeGreaterThan(0);
    expect(screen.getByText('Repor o produto X')).toBeInTheDocument();
    expect(screen.getAllByText('Camiseta X · 2026-11').length).toBe(2);
    expect(getMock.mock.calls[0][0]).toContain('/control-tower/painel');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('mostra limitações declaradas quando o dado é insuficiente', async () => {
    getMock.mockResolvedValue({
      ...TOWER,
      indicadores: [],
      previsoes: { demanda: [], suprimento: [], acuracia: null, limitacoes: ['Nenhuma previsão materializada.'] },
      recomendacoes: { pendentes: [], total_pendentes: 0 },
      pendencias_criticas: [],
    });
    renderPagina();
    expect(await screen.findByText('Nenhum indicador disponível.')).toBeInTheDocument();
    expect(screen.getAllByText('Nenhuma previsão materializada.').length).toBeGreaterThan(0);
    expect(screen.getByText('Nenhuma recomendação pendente.')).toBeInTheDocument();
  });
});
