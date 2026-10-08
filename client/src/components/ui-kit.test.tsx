import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import {
  BulkActions,
  Breadcrumb,
  Checkbox,
  Combobox,
  DataTable,
  DatePicker,
  DateRangePicker,
  Dropdown,
  Pagination,
  Switch,
  Tabs,
  type Column,
} from './ui-kit';

// ----------------------------------------------------------------------------
// Checkbox
// ----------------------------------------------------------------------------
describe('Checkbox', () => {
  it('expõe o estado indeterminado ao leitor de tela', () => {
    render(<Checkbox checked={false} indeterminate onChange={() => {}} aria-label="Todas" />);
    expect(screen.getByRole('checkbox', { name: 'Todas' })).toBePartiallyChecked();
  });

  it('chama onChange com o novo valor e respeita disabled', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const { rerender } = render(<Checkbox checked={false} onChange={onChange} label="Aceito" />);
    await user.click(screen.getByRole('checkbox', { name: 'Aceito' }));
    expect(onChange).toHaveBeenLastCalledWith(true);
    rerender(<Checkbox checked={false} disabled onChange={onChange} label="Aceito" />);
    onChange.mockClear();
    await user.click(screen.getByRole('checkbox', { name: 'Aceito' }));
    expect(onChange).not.toHaveBeenCalled();
  });
});

// ----------------------------------------------------------------------------
// Switch
// ----------------------------------------------------------------------------
describe('Switch', () => {
  it('é role="switch" com aria-checked e alterna por clique e por teclado', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Switch checked={false} onChange={onChange} label="Notificações" />);
    const sw = screen.getByRole('switch', { name: 'Notificações' });
    expect(sw).toHaveAttribute('aria-checked', 'false');
    await user.click(sw);
    expect(onChange).toHaveBeenLastCalledWith(true);
    sw.focus();
    await user.keyboard(' ');
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it('não alterna quando desabilitado', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Switch checked disabled onChange={onChange} label="Ativo" />);
    await user.click(screen.getByRole('switch', { name: 'Ativo' }));
    expect(onChange).not.toHaveBeenCalled();
  });
});

// ----------------------------------------------------------------------------
// Tabs
// ----------------------------------------------------------------------------
describe('Tabs', () => {
  function Harness() {
    const [v, setV] = useState('a');
    return (
      <Tabs
        label="Seções"
        value={v}
        onValueChange={setV}
        items={[
          { id: 'a', label: 'Alfa', content: <p>Conteúdo A</p> },
          { id: 'b', label: 'Beta', disabled: true, content: <p>Conteúdo B</p> },
          { id: 'c', label: 'Gama', content: <p>Conteúdo C</p> },
        ]}
      />
    );
  }

  it('mostra só o painel ativo, com ARIA ligando aba e painel', () => {
    render(<Harness />);
    expect(screen.getByRole('tab', { name: 'Alfa' })).toHaveAttribute('aria-selected', 'true');
    const painel = screen.getByRole('tabpanel');
    expect(painel).toHaveTextContent('Conteúdo A');
    expect(painel).toHaveAttribute('aria-labelledby', screen.getByRole('tab', { name: 'Alfa' }).id);
  });

  it('setas trocam a aba pulando as desabilitadas; Home/End vão às pontas', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    screen.getByRole('tab', { name: 'Alfa' }).focus();
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: 'Gama' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tabpanel')).toHaveTextContent('Conteúdo C');
    await user.keyboard('{Home}');
    expect(screen.getByRole('tab', { name: 'Alfa' })).toHaveAttribute('aria-selected', 'true');
    await user.keyboard('{End}');
    expect(screen.getByRole('tab', { name: 'Gama' })).toHaveAttribute('aria-selected', 'true');
  });
});

// ----------------------------------------------------------------------------
// Dropdown
// ----------------------------------------------------------------------------
describe('Dropdown', () => {
  it('abre por clique, executa a ação escolhida e fecha', async () => {
    const user = userEvent.setup();
    const editar = vi.fn();
    render(
      <Dropdown label="Mais" trigger="…" items={[{ id: 'e', label: 'Editar', onSelect: editar }]} />
    );
    const gatilho = screen.getByRole('button', { name: 'Mais' });
    expect(gatilho).toHaveAttribute('aria-expanded', 'false');
    await user.click(gatilho);
    expect(gatilho).toHaveAttribute('aria-expanded', 'true');
    await user.click(screen.getByRole('menuitem', { name: 'Editar' }));
    expect(editar).toHaveBeenCalledOnce();
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('seta para baixo leva o foco ao primeiro item; Esc fecha e devolve o foco', async () => {
    const user = userEvent.setup();
    render(
      <Dropdown label="Mais" trigger="…" items={[{ id: 'a', label: 'Um', onSelect: () => {} }, { id: 'b', label: 'Dois', onSelect: () => {} }]} />
    );
    const gatilho = screen.getByRole('button', { name: 'Mais' });
    gatilho.focus();
    await user.keyboard('{ArrowDown}');
    expect(screen.getByRole('menuitem', { name: 'Um' })).toHaveFocus();
    await user.keyboard('{ArrowDown}');
    expect(screen.getByRole('menuitem', { name: 'Dois' })).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).toBeNull();
    expect(gatilho).toHaveFocus();
  });

  it('item desabilitado não executa e a navegação por teclado o pula', async () => {
    const user = userEvent.setup();
    const apagar = vi.fn();
    render(
      <Dropdown label="Mais" trigger="…" items={[{ id: 'x', label: 'Apagar', onSelect: apagar, disabled: true }, { id: 'y', label: 'Ver', onSelect: () => {} }]} />
    );
    await user.click(screen.getByRole('button', { name: 'Mais' }));
    // Ao abrir, o foco vai ao primeiro item HABILITADO: "Apagar" é pulado.
    expect(screen.getByRole('menuitem', { name: 'Ver' })).toHaveFocus();
    expect(screen.getByRole('menuitem', { name: 'Apagar' })).toBeDisabled();
    // O item desabilitado não tem handler: clicar nele (se alcançado) não executa.
    await user.click(screen.getByRole('menuitem', { name: 'Apagar' }));
    expect(apagar).not.toHaveBeenCalled();
  });
});

// ----------------------------------------------------------------------------
// Pagination
// ----------------------------------------------------------------------------
describe('Pagination', () => {
  it('desabilita primeira/anterior na primeira página e informa o total', () => {
    render(<Pagination page={1} pageSize={10} total={25} onPageChange={() => {}} />);
    expect(screen.getByRole('navigation', { name: 'Paginação' })).toHaveTextContent('Página 1 de 3');
    expect(screen.getByRole('button', { name: 'Primeira página' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Página anterior' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Próxima página' })).toBeEnabled();
  });

  it('na última página, próxima/última ficam desabilitadas', () => {
    render(<Pagination page={3} pageSize={10} total={25} onPageChange={() => {}} />);
    expect(screen.getByRole('button', { name: 'Próxima página' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Última página' })).toBeDisabled();
  });

  it('sem registros mostra 1 de 1 e 0 registros', () => {
    render(<Pagination page={1} pageSize={10} total={0} onPageChange={() => {}} />);
    expect(screen.getByRole('navigation')).toHaveTextContent('Página 1 de 1');
    expect(screen.getByRole('navigation')).toHaveTextContent('0 registros');
  });

  it('chama onPageChange com a página certa e troca o tamanho', async () => {
    const user = userEvent.setup();
    const onPage = vi.fn();
    const onSize = vi.fn();
    render(<Pagination page={2} pageSize={10} total={50} onPageChange={onPage} pageSizeOptions={[10, 20]} onPageSizeChange={onSize} />);
    await user.click(screen.getByRole('button', { name: 'Próxima página' }));
    expect(onPage).toHaveBeenLastCalledWith(3);
    await user.click(screen.getByRole('button', { name: 'Primeira página' }));
    expect(onPage).toHaveBeenLastCalledWith(1);
    await user.selectOptions(screen.getByLabelText('Por página'), '20');
    expect(onSize).toHaveBeenCalledWith(20);
  });
});

// ----------------------------------------------------------------------------
// Combobox
// ----------------------------------------------------------------------------
describe('Combobox', () => {
  const opcoes = [
    { value: 'sp', label: 'São Paulo' },
    { value: 'rj', label: 'Rio de Janeiro' },
    { value: 'sc', label: 'Santa Catarina', disabled: true },
  ];

  it('filtra sem diferenciar acento e caixa, e escolhe com Enter', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Combobox label="Estado" options={opcoes} value={null} onChange={onChange} />);
    const campo = screen.getByRole('combobox', { name: 'Estado' });
    await user.type(campo, 'SAO');
    expect(screen.getAllByRole('option')).toHaveLength(1);
    await user.keyboard('{ArrowDown}{Enter}');
    expect(onChange).toHaveBeenCalledWith('sp');
  });

  it('mostra estado vazio quando nada casa e Esc fecha a lista', async () => {
    const user = userEvent.setup();
    render(<Combobox label="Estado" options={opcoes} value={null} onChange={() => {}} emptyText="Sem resultados" />);
    const campo = screen.getByRole('combobox', { name: 'Estado' });
    await user.type(campo, 'xyz');
    expect(screen.getByRole('status')).toHaveTextContent('Sem resultados');
    await user.keyboard('{Escape}');
    expect(campo).toHaveAttribute('aria-expanded', 'false');
  });

  it('opção desabilitada não é escolhida', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Combobox label="Estado" options={opcoes} value={null} onChange={onChange} />);
    await user.click(screen.getByRole('combobox', { name: 'Estado' }));
    await user.click(screen.getByRole('option', { name: 'Santa Catarina' }));
    expect(onChange).not.toHaveBeenCalled();
  });
});

// ----------------------------------------------------------------------------
// DatePicker / DateRangePicker
// ----------------------------------------------------------------------------
describe('DatePicker', () => {
  it('mostra a data em dd/mm/aaaa e o placeholder quando vazio', () => {
    const { rerender } = render(<DatePicker label="Data" value="" onChange={() => {}} />);
    expect(screen.getByRole('button', { name: /Data/ })).toHaveTextContent('dd/mm/aaaa');
    rerender(<DatePicker label="Data" value="2026-10-08" onChange={() => {}} />);
    expect(screen.getByRole('button', { name: /Data/ })).toHaveTextContent('08/10/2026');
  });

  it('escolhe um dia pelo clique e devolve AAAA-MM-DD', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<DatePicker label="Data" value="2026-10-08" onChange={onChange} />);
    await user.click(screen.getByRole('button', { name: /Data/ }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /quinta-feira, 15 de outubro de 2026/ }));
    expect(onChange).toHaveBeenCalledWith('2026-10-15');
  });

  it('teclado: setas movem o dia, PageDown muda o mês, Enter confirma', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<DatePicker label="Data" value="2026-01-31" onChange={onChange} />);
    await user.click(screen.getByRole('button', { name: /Data/ }));
    await user.keyboard('{PageDown}');
    // 31/jan + 1 mês → 28/fev (2026 não é bissexto); foco vai para a célula de 28.
    expect(screen.getByRole('button', { name: /28 de fevereiro de 2026/ })).toHaveFocus();
    await user.keyboard('{ArrowRight}{Enter}');
    expect(onChange).toHaveBeenCalledWith('2026-03-01');
  });

  it('dias fora de min/max ficam desabilitados e não são escolhidos', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<DatePicker label="Data" value="2026-10-08" min="2026-10-05" onChange={onChange} />);
    await user.click(screen.getByRole('button', { name: /Data/ }));
    const antes = screen.getByRole('button', { name: 'domingo, 4 de outubro de 2026' });
    expect(antes).toBeDisabled();
    await user.click(antes);
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('DateRangePicker', () => {
  function Harness({ inicial }: { inicial: { de: string; ate: string } }) {
    const [v, setV] = useState(inicial);
    return <DateRangePicker idPrefix="p" value={v} onChange={setV} />;
  }

  it('sinaliza datas invertidas com mensagem e aria-invalid', () => {
    render(<Harness inicial={{ de: '2026-10-31', ate: '2026-10-01' }} />);
    expect(screen.getByRole('alert')).toHaveTextContent('posterior à data final');
    expect(screen.getAllByRole('button', { name: /Data (inicial|final)/ }).every((b) => b.getAttribute('aria-invalid') === 'true')).toBe(true);
  });

  it('intervalo válido não mostra erro', () => {
    render(<Harness inicial={{ de: '2026-10-01', ate: '2026-10-31' }} />);
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

// ----------------------------------------------------------------------------
// DataTable
// ----------------------------------------------------------------------------
type Linha = { id: string; nome: string; valor: number | null };
const linhas: Linha[] = [
  { id: '1', nome: 'Camisa', valor: 30 },
  { id: '2', nome: 'Calça', valor: null },
  { id: '3', nome: 'Bermuda', valor: 10 },
];
const colunas: Column<Linha>[] = [
  { id: 'nome', header: 'Produto', cell: (l) => l.nome, sortValue: (l) => l.nome },
  { id: 'valor', header: 'Valor', cell: (l) => (l.valor === null ? '—' : l.valor), sortValue: (l) => l.valor, align: 'right' },
  { id: 'obs', header: 'Obs', cell: () => 'x', hideOnMobile: true },
];

describe('DataTable', () => {
  it('renderiza cabeçalhos, linhas e a caption acessível', () => {
    render(<DataTable caption="Produtos" columns={colunas} rows={linhas} rowKey={(l) => l.id} />);
    expect(screen.getByRole('table', { name: 'Produtos' })).toBeInTheDocument();
    expect(screen.getAllByRole('row')).toHaveLength(4);
    expect(screen.getByRole('columnheader', { name: 'Obs' })).toHaveClass('hidden', 'md:table-cell');
  });

  it('ordena ao clicar no cabeçalho, com aria-sort, e vazios vão para o fim', async () => {
    const user = userEvent.setup();
    render(<DataTable caption="Produtos" columns={colunas} rows={linhas} rowKey={(l) => l.id} />);
    const cab = screen.getByRole('columnheader', { name: /Valor/ });
    expect(cab).toHaveAttribute('aria-sort', 'none');
    await user.click(within(cab).getByRole('button'));
    expect(cab).toHaveAttribute('aria-sort', 'ascending');
    let nomes = screen.getAllByRole('row').slice(1).map((r) => r.querySelector('td')?.textContent);
    expect(nomes).toEqual(['Bermuda', 'Camisa', 'Calça']); // Calça (null) por último
    await user.click(within(cab).getByRole('button'));
    expect(cab).toHaveAttribute('aria-sort', 'descending');
    nomes = screen.getAllByRole('row').slice(1).map((r) => r.querySelector('td')?.textContent);
    expect(nomes).toEqual(['Camisa', 'Bermuda', 'Calça']);
  });

  it('seleção: marcar todas e estado indeterminado parcial', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const { rerender } = render(
      <DataTable caption="Produtos" columns={colunas} rows={linhas} rowKey={(l) => l.id} selection={{ selected: ['1'], onChange, rowLabel: (l) => l.nome }} />
    );
    const todas = screen.getByRole('checkbox', { name: 'Selecionar todas as linhas' });
    expect(todas).toBePartiallyChecked();
    expect(screen.getByRole('checkbox', { name: 'Selecionar Camisa' })).toBeChecked();
    await user.click(todas);
    expect(onChange).toHaveBeenLastCalledWith(['1', '2', '3']);
    rerender(
      <DataTable caption="Produtos" columns={colunas} rows={linhas} rowKey={(l) => l.id} selection={{ selected: ['1', '2', '3'], onChange }} />
    );
    expect(screen.getByRole('checkbox', { name: 'Selecionar todas as linhas' })).toBeChecked();
  });

  it('estado de carregamento: aria-busy e status, sem linhas falsas', () => {
    render(<DataTable caption="Produtos" columns={colunas} rows={[]} rowKey={(l) => l.id} loading />);
    expect(screen.getByRole('table').parentElement).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByRole('status')).toHaveTextContent('Carregando');
  });

  it('estado vazio com mensagem e ações por linha', () => {
    const { rerender } = render(<DataTable caption="Produtos" columns={colunas} rows={[]} rowKey={(l) => l.id} emptyMessage="Nada aqui" />);
    expect(screen.getByText('Nada aqui')).toBeInTheDocument();
    rerender(
      <DataTable caption="Produtos" columns={colunas} rows={linhas} rowKey={(l) => l.id} actions={(l) => <button>Abrir {l.nome}</button>} />
    );
    expect(screen.getByRole('button', { name: 'Abrir Camisa' })).toBeInTheDocument();
  });

  it('onRowActivate dispara com Enter na linha', async () => {
    const user = userEvent.setup();
    const onRowActivate = vi.fn();
    render(<DataTable caption="Produtos" columns={colunas} rows={linhas} rowKey={(l) => l.id} onRowActivate={onRowActivate} />);
    screen.getAllByRole('row')[1].focus();
    await user.keyboard('{Enter}');
    expect(onRowActivate).toHaveBeenCalledWith(linhas[0]);
  });
});

// ----------------------------------------------------------------------------
// BulkActions / Breadcrumb
// ----------------------------------------------------------------------------
describe('BulkActions', () => {
  it('não aparece sem seleção', () => {
    const { container } = render(<BulkActions selectedCount={0} actions={[]} onClear={() => {}} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('mostra a contagem, só expõe callbacks e move excedentes para "Mais"', async () => {
    const user = userEvent.setup();
    const exportar = vi.fn();
    const excluir = vi.fn();
    const imprimir = vi.fn();
    const onClear = vi.fn();
    render(
      <BulkActions
        selectedCount={2}
        onClear={onClear}
        maxVisible={1}
        actions={[
          { id: 'exp', label: 'Exportar', onRun: exportar },
          { id: 'del', label: 'Excluir', onRun: excluir, danger: true },
          { id: 'imp', label: 'Imprimir', onRun: imprimir },
        ]}
      />
    );
    expect(screen.getByRole('region', { name: 'Ações em lote' })).toHaveTextContent('2 selecionados');
    expect(exportar).not.toHaveBeenCalled(); // nada roda sozinho
    await user.click(screen.getByRole('button', { name: 'Exportar' }));
    expect(exportar).toHaveBeenCalledOnce();
    await user.click(screen.getByRole('button', { name: 'Mais ações em lote' }));
    await user.click(screen.getByRole('menuitem', { name: 'Excluir' }));
    expect(excluir).toHaveBeenCalledOnce();
    await user.click(screen.getByRole('button', { name: 'Limpar seleção' }));
    expect(onClear).toHaveBeenCalledOnce();
  });
});

describe('Breadcrumb', () => {
  it('marca a página atual e navega pelos links', async () => {
    const user = userEvent.setup();
    const onNavigate = vi.fn();
    render(
      <Breadcrumb items={[{ label: 'Início', onNavigate }, { label: 'Financeiro', href: '/financeiro' }, { label: 'Contas' }]} />
    );
    expect(screen.getByRole('navigation', { name: 'Trilha de navegação' })).toBeInTheDocument();
    expect(screen.getByText('Contas')).toHaveAttribute('aria-current', 'page');
    await user.click(screen.getByRole('button', { name: 'Início' }));
    expect(onNavigate).toHaveBeenCalledOnce();
    expect(screen.getByRole('link', { name: 'Financeiro' })).toHaveAttribute('href', '/financeiro');
  });
});
