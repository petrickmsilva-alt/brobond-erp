import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { Combobox, DataTable, DatePicker, DateRangePicker, DeltaBadge, Drawer, ErrorState, LoadingState, Pagination, StatCard, StatusBadge, Tabs, Tooltip } from './ui-kit';

describe('StatusBadge', () => {
  it('mostra o texto do status (nunca só a cor)', () => {
    render(<StatusBadge status="vencido" />);
    expect(screen.getByText('Vencido')).toBeInTheDocument();
  });

  it('aceita rótulo próprio do domínio', () => {
    render(<StatusBadge status="parcial" label="Parcial · 2 de 5" />);
    expect(screen.getByText('Parcial · 2 de 5')).toBeInTheDocument();
  });
});

describe('DeltaBadge', () => {
  it('informa o sentido da variação em texto para leitores de tela', () => {
    render(<DeltaBadge valor={12.4} />);
    expect(screen.getByText('aumento de 12,4% em relação ao período anterior', { exact: false })).toBeInTheDocument();
  });

  it('para custo, subir é ruim (mesmo sinal, leitura invertida)', () => {
    render(<DeltaBadge valor={5} inverter />);
    const texto = screen.getByText('5%');
    expect(texto.closest('.text-danger')).not.toBeNull();
  });

  it('sem base de comparação avisa em vez de mostrar 0%', () => {
    render(<DeltaBadge valor={null} />);
    expect(screen.getByText('sem comparação')).toBeInTheDocument();
  });
});

describe('StatCard', () => {
  it('vira link quando recebe destino', () => {
    render(
      <MemoryRouter>
        <StatCard label="Faturamento" value="R$ 10,00" to="/vendas" delta={3} />
      </MemoryRouter>,
    );
    expect(screen.getByRole('link', { name: /Faturamento/ })).toHaveAttribute('href', '/vendas');
  });
});

describe('ErrorState e LoadingState', () => {
  it('ErrorState chama onRetry ao clicar em tentar novamente', async () => {
    const onRetry = vi.fn();
    render(<ErrorState message="Falha de rede" onRetry={onRetry} />);
    expect(screen.getByRole('alert')).toHaveTextContent('Falha de rede');
    await userEvent.click(screen.getByRole('button', { name: /tentar novamente/i }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('LoadingState anuncia o carregamento', () => {
    render(<LoadingState label="Carregando vendas" />);
    expect(screen.getByRole('status')).toHaveTextContent('Carregando vendas');
  });
});

describe('Drawer', () => {
  it('abre como diálogo e fecha com Esc', async () => {
    const onClose = vi.fn();
    render(
      <Drawer open onClose={onClose} title="Filtros avançados">
        <p>conteúdo</p>
      </Drawer>,
    );
    expect(screen.getByRole('dialog', { name: 'Filtros avançados' })).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalled();
  });

  it('não renderiza quando fechado', () => {
    render(
      <Drawer open={false} onClose={() => {}} title="Oculto">
        <p>x</p>
      </Drawer>,
    );
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});

describe('Tooltip', () => {
  it('associa o texto ao elemento via aria-describedby', () => {
    render(
      <Tooltip content="Margem bruta">
        <button>M%</button>
      </Tooltip>,
    );
    const botao = screen.getByRole('button', { name: 'M%' });
    const id = botao.closest('span')?.getAttribute('aria-describedby');
    expect(id).toBeTruthy();
    expect(document.getElementById(id as string)).toHaveTextContent('Margem bruta');
  });
});

describe('Tabs', () => {
  const ABAS = [
    { key: 'unidade', label: 'Por unidade' },
    { key: 'colecao', label: 'Por coleção' },
    { key: 'total', label: 'Todas as peças' },
  ] as const;

  function Hospedeiro() {
    const [valor, setValor] = useState<'unidade' | 'colecao' | 'total'>('colecao');
    return <Tabs tabs={[...ABAS]} value={valor} onChange={setValor} label="Nível da valorização" />;
  }

  it('marca a aba ativa com aria-selected e alterna no clique', async () => {
    const user = userEvent.setup();
    render(<Hospedeiro />);
    expect(screen.getByRole('tab', { name: 'Por coleção', selected: true })).toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: 'Por unidade' }));
    expect(screen.getByRole('tab', { name: 'Por unidade', selected: true })).toBeInTheDocument();
  });

  it('navega com setas e Home/End levando o foco junto', async () => {
    const user = userEvent.setup();
    render(<Hospedeiro />);
    const colecao = screen.getByRole('tab', { name: 'Por coleção' });
    colecao.focus();
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: 'Todas as peças', selected: true })).toHaveFocus();
    await user.keyboard('{Home}');
    expect(screen.getByRole('tab', { name: 'Por unidade', selected: true })).toHaveFocus();
    await user.keyboard('{End}');
    expect(screen.getByRole('tab', { name: 'Todas as peças', selected: true })).toHaveFocus();
  });

  it('só a aba ativa entra na ordem de Tab (roving tabindex)', () => {
    render(<Hospedeiro />);
    const abas = screen.getAllByRole('tab');
    expect(abas.map((a) => a.getAttribute('tabindex'))).toEqual(['-1', '0', '-1']);
  });
});

describe('Combobox', () => {
  const OPCOES = [
    { value: '', label: 'Todos os canais' },
    { value: 'loja_fisica', label: 'Loja Física' },
    { value: 'ecommerce', label: 'E-commerce' },
  ];

  function Hospedeiro({ inicial = '' }: { inicial?: string }) {
    const [valor, setValor] = useState(inicial);
    return <Combobox label="Canal" value={valor} onChange={setValor} options={OPCOES} />;
  }

  it('mostra o rótulo da opção selecionada e escolhe outra pelo mouse', async () => {
    const user = userEvent.setup();
    render(<Hospedeiro />);
    const campo = screen.getByRole('combobox', { name: 'Canal' });
    expect(campo).toHaveValue('Todos os canais');
    await user.click(campo);
    await user.click(screen.getByRole('option', { name: 'E-commerce' }));
    expect(campo).toHaveValue('E-commerce');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('filtra as opções pelo texto digitado', async () => {
    const user = userEvent.setup();
    render(<Hospedeiro />);
    await user.click(screen.getByRole('combobox', { name: 'Canal' }));
    await user.type(screen.getByRole('combobox', { name: 'Canal' }), 'loja');
    const opcoes = screen.getAllByRole('option');
    expect(opcoes).toHaveLength(1);
    expect(opcoes[0]).toHaveTextContent('Loja Física');
  });

  it('avisa quando nada corresponde à busca, sem inventar opção', async () => {
    const user = userEvent.setup();
    render(<Hospedeiro />);
    await user.click(screen.getByRole('combobox', { name: 'Canal' }));
    await user.type(screen.getByRole('combobox', { name: 'Canal' }), 'xyz');
    expect(screen.queryByRole('option')).not.toBeInTheDocument();
    expect(screen.getByText('Nenhuma opção encontrada.')).toBeInTheDocument();
  });

  it('navega com setas + Enter e fecha com Esc sem escolher', async () => {
    const user = userEvent.setup();
    render(<Hospedeiro inicial="loja_fisica" />);
    const campo = screen.getByRole('combobox', { name: 'Canal' });
    campo.focus();
    await user.keyboard('{ArrowDown}{ArrowDown}{Enter}');
    expect(campo).toHaveValue('E-commerce');

    await user.click(campo);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(campo).toHaveValue('E-commerce');
  });
});

describe('DatePicker e DateRangePicker', () => {
  it('DatePicker associa rótulo, erro e aria-invalid ao campo', () => {
    render(<DatePicker label="De" value="" onChange={() => {}} error="Informe a data inicial." />);
    const campo = screen.getByLabelText('De');
    expect(campo).toHaveAttribute('type', 'date');
    expect(campo).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByText('Informe a data inicial.')).toBeInTheDocument();
  });

  it('DateRangePicker monta De/Até e anuncia o erro do intervalo', () => {
    const onChange = vi.fn();
    render(<DateRangePicker legend="Período personalizado" de="2026-10-10" ate="2026-10-01" onChange={onChange} error="A data inicial deve ser anterior ou igual à final." />);
    expect(screen.getByLabelText('De')).toHaveValue('2026-10-10');
    expect(screen.getByLabelText('Até')).toHaveValue('2026-10-01');
    const erro = screen.getByText('A data inicial deve ser anterior ou igual à final.');
    expect(erro).toHaveAttribute('aria-live', 'polite');

    // Alterar o campo "De" propaga { de, ate } ao chamador.
    fireEvent.change(screen.getByLabelText('De'), { target: { value: '2026-10-01' } });
    expect(onChange).toHaveBeenCalledWith({ de: '2026-10-01', ate: '2026-10-01' });
  });
});

describe('DataTable', () => {
  type Linha = { id: number; produto: string; receita: string };
  const COLUNAS = [
    { key: 'produto', header: 'Produto', render: (r: Linha) => r.produto },
    { key: 'receita', header: 'Receita', align: 'right' as const, render: (r: Linha) => r.receita },
  ];

  it('renderiza cabeçalho, linhas e legenda acessível', () => {
    render(
      <DataTable
        columns={COLUNAS}
        rows={[
          { id: 1, produto: 'Camisa', receita: 'R$ 10,00' },
          { id: 2, produto: 'Bermuda', receita: 'R$ 20,00' },
        ]}
        caption="Produtos por receita"
        empty="Nada aqui."
        getRowKey={(r) => r.id}
      />,
    );
    expect(screen.getByRole('columnheader', { name: 'Produto' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Receita' })).toHaveClass('text-right');
    expect(screen.getByRole('cell', { name: 'Camisa' })).toBeInTheDocument();
    expect(screen.getByRole('table', { name: 'Produtos por receita' })).toBeInTheDocument();
  });

  it('sem linhas, mostra o estado vazio em vez de tabela vazia', () => {
    render(<DataTable columns={COLUNAS} rows={[]} caption="Produtos por receita" empty="Nenhum produto faturado." getRowKey={(r) => r.id} />);
    expect(screen.getByText('Nenhum produto faturado.')).toBeInTheDocument();
    expect(screen.queryByRole('cell', { name: 'Camisa' })).not.toBeInTheDocument();
  });
});

describe('Pagination', () => {
  it('não renderiza nada com uma página só', () => {
    const { container } = render(<Pagination page={1} totalPages={1} onChange={() => {}} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('marca a página atual e navega pelos botões', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<Pagination page={2} totalPages={5} onChange={onChange} />);
    const nav = screen.getByRole('navigation', { name: 'Paginação' });
    expect(within(nav).getByRole('button', { name: 'Página 2', current: 'page' })).toBeInTheDocument();
    await user.click(within(nav).getByRole('button', { name: 'Próxima página' }));
    expect(onChange).toHaveBeenCalledWith(3);
    await user.click(within(nav).getByRole('button', { name: 'Página 5' }));
    expect(onChange).toHaveBeenCalledWith(5);
  });

  it('desabilita os extremos (primeira e última página)', () => {
    const { rerender } = render(<Pagination page={1} totalPages={4} onChange={() => {}} />);
    expect(screen.getByRole('button', { name: 'Primeira página' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Página anterior' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Próxima página' })).toBeEnabled();

    rerender(<Pagination page={4} totalPages={4} onChange={() => {}} />);
    expect(screen.getByRole('button', { name: 'Próxima página' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Última página' })).toBeDisabled();
  });

  it('acima de 7 páginas, compacta o meio com reticências', () => {
    render(<Pagination page={5} totalPages={12} onChange={() => {}} />);
    const nav = screen.getByRole('navigation', { name: 'Paginação' });
    expect(within(nav).getByRole('button', { name: 'Página 1' })).toBeInTheDocument();
    expect(within(nav).getByRole('button', { name: 'Página 12' })).toBeInTheDocument();
    expect(within(nav).getByRole('button', { name: 'Página 5', current: 'page' })).toBeInTheDocument();
    // Páginas distantes da janela ficam ocultas.
    expect(within(nav).queryByRole('button', { name: 'Página 9' })).not.toBeInTheDocument();
  });
});
