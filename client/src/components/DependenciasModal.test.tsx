// "Ver vínculos" — o modal que substitui o toast genérico de "registro em uso".
import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DependenciasModal, agruparPorModulo, type DiagnosticoDependencias, type VinculoDependencia } from './DependenciasModal';

function vinculo(p: Partial<VinculoDependencia> & Pick<VinculoDependencia, 'tabela' | 'modulo' | 'quantidade'>): VinculoDependencia {
  return {
    icone: 'estoque',
    colunas: ['venda_id'],
    recurso: null,
    ids: [],
    idsTruncados: false,
    unidade: ['registro', 'registros'],
    tipo: 'historico',
    politica: 'seguir',
    acao: 'NO_ACTION',
    impeditivo: true,
    protegido: false,
    bloqueia: true,
    motivo: 'vínculo de teste',
    ...p,
  };
}

const DIAG: DiagnosticoDependencias = {
  recurso: 'vendas',
  recursoLabel: 'Pedidos de venda',
  singular: 'Pedido de venda',
  id: 4,
  empresaId: 1,
  rotulo: '#4',
  status: 'cancelada',
  origem: 'postgresql',
  bloqueado: true,
  podeExcluir: false,
  titulo: 'Não é possível excluir Pedido de venda #4',
  resumo: 'Venda cancelada com histórico. A exclusão física não é permitida — 3 registros vinculados em Estoque e Financeiro.',
  orientacao: 'Este pedido deve permanecer como CANCELADO.',
  totalRegistros: 9,
  totalBloqueantes: 3,
  modulos: ['Estoque', 'Financeiro', 'Itens da venda', 'Auditoria'],
  modulosBloqueantes: ['Estoque', 'Financeiro'],
  geradoEm: '2026-10-24T12:00:00.000Z',
  vinculos: [
    vinculo({
      tabela: 'movimentacoes',
      modulo: 'Estoque',
      icone: 'estoque',
      quantidade: 2,
      ids: [12, 13],
      recurso: 'movimentacoes',
      unidade: ['movimentação', 'movimentações'],
      motivo: 'histórico de movimentação de estoque (saída e estorno do pedido)',
    }),
    vinculo({
      tabela: 'lancamentos_financeiros',
      modulo: 'Financeiro',
      icone: 'financeiro',
      quantidade: 1,
      ids: [7],
      recurso: 'lancamentos_financeiros',
      politica: 'proteger',
      protegido: true,
      acao: 'LOGICO',
      unidade: ['lançamento', 'lançamentos'],
      motivo: 'histórico financeiro (contas a receber/pagar)',
    }),
    vinculo({
      tabela: 'itens_venda',
      modulo: 'Itens da venda',
      icone: 'itens',
      quantidade: 1,
      ids: [3],
      tipo: 'composicao',
      acao: 'CASCADE',
      impeditivo: false,
      bloqueia: false,
      motivo: 'faz parte da composição do próprio registro',
    }),
    vinculo({
      tabela: 'auditoria',
      modulo: 'Auditoria',
      icone: 'auditoria',
      quantidade: 5,
      ids: [1, 2],
      idsTruncados: false,
      tipo: 'trilha',
      acao: 'LOGICO',
      impeditivo: false,
      bloqueia: false,
      unidade: ['evento', 'eventos'],
      motivo: 'trilha preservada',
    }),
  ],
};

describe('DependenciasModal', () => {
  it('mostra a mensagem, os módulos bloqueantes e as quantidades', () => {
    render(<DependenciasModal diag={DIAG} onClose={() => {}} />);

    expect(screen.getByText('Exclusão bloqueada por vínculos')).toBeInTheDocument();
    expect(screen.getByText(/Venda cancelada com histórico/)).toBeInTheDocument();
    expect(screen.getByText(/deve permanecer como CANCELADO/)).toBeInTheDocument();

    const estoque = screen.getByText('Estoque').closest('li')!;
    expect(within(estoque).getByText('2 registros')).toBeInTheDocument();
    const financeiro = screen.getByText('Financeiro').closest('li')!;
    expect(within(financeiro).getByText('1 registro')).toBeInTheDocument();

    // Vínculos que NÃO bloqueiam aparecem separados — o usuário entende que a
    // auditoria e os itens não são o motivo da recusa.
    expect(screen.getByText('Também vinculados (não impedem a exclusão)')).toBeInTheDocument();
    expect(screen.getByText('Itens da venda')).toBeInTheDocument();
    expect(screen.getByText('Auditoria')).toBeInTheDocument();
  });

  it('"Ver vínculos" abre o detalhe com tabela, ids e motivo', async () => {
    const user = userEvent.setup();
    render(<DependenciasModal diag={DIAG} onClose={() => {}} />);

    expect(screen.queryByText(/movimentacoes\./)).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Ver vínculos/i }));

    expect(screen.getByText('movimentacoes.venda_id')).toBeInTheDocument();
    expect(screen.getByText('#12, #13')).toBeInTheDocument();
    expect(screen.getByText('#7')).toBeInTheDocument();
    expect(screen.getAllByText('Histórico').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Bloqueia').length).toBe(2);
    expect(screen.getByText(/catálogo do PostgreSQL/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Ocultar vínculos/i }));
    expect(screen.queryByText('movimentacoes.venda_id')).not.toBeInTheDocument();
  });

  it('leva ao módulo do vínculo quando o recurso é navegável', async () => {
    const user = userEvent.setup();
    const onAbrirModulo = vi.fn();
    render(<DependenciasModal diag={DIAG} onClose={() => {}} onAbrirModulo={onAbrirModulo} />);

    const estoque = screen.getByText('Estoque').closest('li')!;
    await user.click(within(estoque).getByRole('button', { name: /Abrir módulo/i }));
    expect(onAbrirModulo).toHaveBeenCalledWith('movimentacoes');
  });

  it('não renderiza nada sem diagnóstico e fecha pelo botão', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const { rerender } = render(<DependenciasModal diag={null} onClose={onClose} />);
    expect(screen.queryByText('Exclusão bloqueada por vínculos')).not.toBeInTheDocument();

    rerender(<DependenciasModal diag={DIAG} onClose={onClose} />);
    // Há dois "Fechar": o ícone do cabeçalho do Modal e o botão do rodapé.
    const fechar = screen.getAllByRole('button', { name: 'Fechar' });
    await user.click(fechar[fechar.length - 1]);
    expect(onClose).toHaveBeenCalled();
  });
});

describe('agruparPorModulo', () => {
  it('soma por módulo e coloca os bloqueantes primeiro', () => {
    const grupos = agruparPorModulo(DIAG);
    expect(grupos.map((g) => g.modulo)).toEqual(['Estoque', 'Financeiro', 'Auditoria', 'Itens da venda']);
    expect(grupos[0]).toMatchObject({ modulo: 'Estoque', total: 2, bloqueia: true });
    expect(grupos[2]).toMatchObject({ modulo: 'Auditoria', total: 5, bloqueia: false });
  });
});
