import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { DeltaBadge, Drawer, ErrorState, LoadingState, StatCard, StatusBadge, Tooltip } from './ui-kit';

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
