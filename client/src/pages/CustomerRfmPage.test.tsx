// ============================================================================
// FASE 7 — ANÁLISE RFM (/customer-segments/rfm).
// A tela NÃO recalcula: exibe os quintis e segmentos que vêm do servidor.
// ============================================================================
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import CustomerRfmPage from './CustomerRfmPage';

vi.mock('../lib/api', () => ({
  api: { get: vi.fn() },
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

const RFM = {
  base: 3,
  sem_compra: 2,
  cortes: { recencia: [1, 2, 3, 4, 5], frequencia: [1, 1, 2, 3, 5], valor: [30, 50, 100, 300, 500] },
  resumo: [
    { segmento: 'campeoes', clientes: 1, receita: 500 },
    { segmento: 'em_risco', clientes: 1, receita: 400 },
    { segmento: 'novos_promissores', clientes: 1, receita: 50 },
  ],
  clientes: [
    { cliente_id: 1, nome: 'Ana Campeã', recencia_dias: 5, frequencia: 5, receita_total: 500, r: 5, f: 5, m: 5, segmento: 'campeoes' },
    { cliente_id: 2, nome: 'Beto Risco', recencia_dias: 200, frequencia: 4, receita_total: 400, r: 1, f: 4, m: 4, segmento: 'em_risco' },
    { cliente_id: 3, nome: 'Caio Novo', recencia_dias: 2, frequencia: 1, receita_total: 50, r: 5, f: 1, m: 1, segmento: 'novos_promissores' },
  ],
  gerado_em: '2026-10-28T12:00:00.000Z',
};

function renderPagina() {
  return render(
    <MemoryRouter>
      <CustomerRfmPage />
    </MemoryRouter>
  );
}

describe('Fase 7 — Análise RFM', () => {
  beforeEach(() => getMock.mockReset());

  it('renderiza clientes, notas e segmentos vindos do servidor', async () => {
    getMock.mockResolvedValue(RFM);
    renderPagina();
    expect(await screen.findByText('Ana Campeã')).toBeInTheDocument();
    expect(screen.getByText('Beto Risco')).toBeInTheDocument();
    expect(screen.getAllByText('Campeões').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Em risco').length).toBeGreaterThan(0);
    expect(getMock.mock.calls[0][0]).toContain('/customer-segments/rfm');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('mostra estado vazio honesto quando não há base RFM', async () => {
    getMock.mockResolvedValue({ base: 0, sem_compra: 4, cortes: null, resumo: [], clientes: [], gerado_em: '2026-10-28T12:00:00.000Z' });
    renderPagina();
    expect(await screen.findByText('Sem clientes com compra')).toBeInTheDocument();
  });
});
