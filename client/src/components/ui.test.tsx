import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Alert, Badge, ConfirmacaoInline, EmptyState, PainelInline, PageHeader, ToastProvider, useToast } from './ui';

describe('Badge', () => {
  it('renderiza o texto e aplica o tom informado', () => {
    render(<Badge tone="green">Ativo</Badge>);
    const badge = screen.getByText('Ativo');
    expect(badge).toBeInTheDocument();
    expect(badge.className).toMatch(/emerald/);
  });

  it('usa o tom slate como padrão quando nenhum é informado', () => {
    render(<Badge>Neutro</Badge>);
    expect(screen.getByText('Neutro').className).toMatch(/slate/);
  });
});

describe('Alert', () => {
  it('marca alertas de erro com role="alert" para leitores de tela', () => {
    render(<Alert tone="red">Algo deu errado</Alert>);
    expect(screen.getByRole('alert')).toHaveTextContent('Algo deu errado');
  });

  it('alertas informativos não usam role="alert" (não interrompem o leitor de tela)', () => {
    render(<Alert tone="blue">Aviso qualquer</Alert>);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByText('Aviso qualquer')).toBeInTheDocument();
  });
});

describe('EmptyState', () => {
  it('mostra título, descrição e ação', () => {
    render(<EmptyState title="Nada por aqui" description="Cadastre o primeiro item." action={<button>Novo item</button>} />);
    expect(screen.getByText('Nada por aqui')).toBeInTheDocument();
    expect(screen.getByText('Cadastre o primeiro item.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Novo item' })).toBeInTheDocument();
  });
});

describe('PageHeader', () => {
  it('renderiza título e ações', () => {
    render(<PageHeader title="Produtos" description="Catálogo de peças" actions={<button>Novo</button>} />);
    expect(screen.getByRole('heading', { name: 'Produtos' })).toBeInTheDocument();
    expect(screen.getByText('Catálogo de peças')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Novo' })).toBeInTheDocument();
  });
});

describe('PainelInline', () => {
  it('não renderiza nada quando fechado', () => {
    render(
      <PainelInline open={false} onClose={() => {}} title="Título">
        conteúdo
      </PainelInline>
    );
    expect(screen.queryByText('conteúdo')).not.toBeInTheDocument();
  });

  it('renderiza o conteúdo na própria página, sem semântica de modal', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <PainelInline open onClose={onClose} title="Conferência">
        conteúdo do painel
      </PainelInline>
    );
    expect(screen.getByText('conteúdo do painel')).toBeInTheDocument();
    // Regra ZERO MODAL: nada de role="dialog", aria-modal nem overlay fixo.
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(document.querySelector('[aria-modal="true"]')).toBeNull();
    expect(document.querySelector('.fixed.inset-0')).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Fechar painel' }));
    expect(onClose).toHaveBeenCalledTimes(1);

    // O painel NÃO captura ESC: fechar é decisão explícita do usuário.
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('ConfirmacaoInline', () => {
  it('chama onConfirm e onCancel a partir dos botões corretos', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(<ConfirmacaoInline open title="Excluir produto?" message="Esta ação não pode ser desfeita." danger confirmLabel="Excluir" onConfirm={onConfirm} onCancel={onCancel} />);

    expect(screen.getByText('Esta ação não pode ser desfeita.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Excluir' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole('button', { name: 'Cancelar' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('desabilita os botões quando busy=true (evita clique duplo)', () => {
    render(<ConfirmacaoInline open title="Excluir?" message="..." busy onConfirm={() => {}} onCancel={() => {}} />);
    expect(screen.getByRole('button', { name: 'Cancelar' })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Confirmar/ })).toBeDisabled();
  });
});

describe('ToastProvider / useToast', () => {
  function Disparador() {
    const toast = useToast();
    return (
      <div>
        <button onClick={() => toast.success('Salvo com sucesso!')}>Salvar</button>
        <button onClick={() => toast.error('Falha ao salvar.')}>Falhar</button>
      </div>
    );
  }

  it('exibe um toast de sucesso como status e um de erro como alert', async () => {
    const user = userEvent.setup();
    render(
      <ToastProvider>
        <Disparador />
      </ToastProvider>
    );

    await user.click(screen.getByRole('button', { name: 'Salvar' }));
    expect(await screen.findByText('Salvo com sucesso!')).toBeInTheDocument();
    expect(screen.getByText('Salvo com sucesso!').closest('[role="status"]')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Falhar' }));
    const erro = await screen.findByText('Falha ao salvar.');
    expect(erro.closest('[role="alert"]')).toBeInTheDocument();
  });

  it('fecha o toast ao clicar no X', async () => {
    const user = userEvent.setup();
    render(
      <ToastProvider>
        <Disparador />
      </ToastProvider>
    );
    await user.click(screen.getByRole('button', { name: 'Salvar' }));
    await screen.findByText('Salvo com sucesso!');
    await user.click(screen.getByRole('button', { name: 'Fechar' }));
    await waitFor(() => expect(screen.queryByText('Salvo com sucesso!')).not.toBeInTheDocument());
  });

  it('useToast lança erro fora do provider (garante uso correto do contexto)', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    function Fora() {
      useToast();
      return null;
    }
    expect(() => render(<Fora />)).toThrow('useToast deve ser usado dentro de ToastProvider');
    consoleError.mockRestore();
  });
});
