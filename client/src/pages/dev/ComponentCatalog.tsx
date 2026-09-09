import { useState } from 'react';
import { Inbox, Plus, Search } from 'lucide-react';
import { Alert, Badge, ConfirmDialog, EmptyState, Modal, PageHeader, Spinner, useToast } from '../../components/ui';
import type { Tone } from '../../lib/meta';

const TONES: Tone[] = ['green', 'red', 'amber', 'blue', 'slate'];

/**
 * Catálogo leve dos componentes de `components/ui.tsx`, para conferir visualmente
 * (claro/escuro) e testar interações sem precisar navegar até uma tela de negócio
 * que os use de verdade. Não faz parte do menu — acessível só pela URL, restrito
 * a administradores (ver rota em App.tsx). Serve como documentação viva: quando um
 * componente muda aqui, dá pra ver o efeito em segundos.
 */
export default function ComponentCatalog() {
  const toast = useToast();
  const [modalOpen, setModalOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);

  return (
    <div className="p-4 sm:p-6">
      <PageHeader
        title="Catálogo de componentes"
        description="Referência visual dos componentes reutilizáveis de ui.tsx — use Ctrl/Cmd+K ou alterne o tema em Configurações para conferir o modo escuro aqui também."
      />

      <div className="space-y-6">
        <Secao titulo="Badge">
          <div className="flex flex-wrap gap-2">
            {TONES.map((t) => (
              <Badge key={t} tone={t}>
                {t}
              </Badge>
            ))}
          </div>
        </Secao>

        <Secao titulo="Alert">
          <div className="space-y-2">
            {TONES.map((t) => (
              <Alert key={t} tone={t}>
                Mensagem de exemplo no tom <b>{t}</b>.
              </Alert>
            ))}
          </div>
        </Secao>

        <Secao titulo="Botões">
          <div className="flex flex-wrap gap-2">
            <button className="btn-primary">Primário</button>
            <button className="btn-accent">Destaque</button>
            <button className="btn-secondary">Secundário</button>
            <button className="btn-ghost">Discreto</button>
            <button className="btn-danger">Perigo</button>
            <button className="btn-primary" disabled>
              Desabilitado
            </button>
          </div>
        </Secao>

        <Secao titulo="Toast">
          <div className="flex flex-wrap gap-2">
            <button className="btn-secondary" onClick={() => toast.success('Registro salvo com sucesso.')}>
              Disparar sucesso
            </button>
            <button className="btn-secondary" onClick={() => toast.error('Não foi possível salvar.')}>
              Disparar erro
            </button>
            <button className="btn-secondary" onClick={() => toast.info('Isso é uma informação.')}>
              Disparar info
            </button>
          </div>
        </Secao>

        <Secao titulo="Modal e ConfirmDialog">
          <div className="flex flex-wrap gap-2">
            <button className="btn-secondary" onClick={() => setModalOpen(true)}>
              Abrir modal
            </button>
            <button className="btn-danger" onClick={() => setConfirmOpen(true)}>
              Abrir confirmação
            </button>
          </div>
        </Secao>

        <Secao titulo="EmptyState">
          <div className="card">
            <EmptyState
              icon={<Inbox className="h-6 w-6" />}
              title="Nenhum item cadastrado"
              description="Clique no botão abaixo para o primeiro cadastro."
              action={
                <button className="btn-accent">
                  <Plus className="h-4 w-4" /> Novo item
                </button>
              }
            />
          </div>
        </Secao>

        <Secao titulo="Spinner">
          <div className="card">
            <Spinner label="Carregando exemplo..." />
          </div>
        </Secao>

        <Secao titulo="Input / Label">
          <div className="max-w-sm space-y-3">
            <label className="block">
              <span className="label">Campo normal</span>
              <div className="relative">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                <input className="input pl-9" placeholder="Buscar..." />
              </div>
            </label>
            <label className="block">
              <span className="label">Campo com erro</span>
              <input className="input input-error" defaultValue="valor inválido" />
              <p className="mt-1 text-xs font-medium text-red-600" role="alert">
                Este campo é obrigatório.
              </p>
            </label>
          </div>
        </Secao>
      </div>

      <Modal open={modalOpen} onClose={() => setModalOpen(false)} title="Exemplo de modal" subtitle="Subtítulo opcional" footer={<button className="btn-primary" onClick={() => setModalOpen(false)}>Fechar</button>}>
        Conteúdo qualquer do modal — formulário, texto, tabela...
      </Modal>

      <ConfirmDialog
        open={confirmOpen}
        title="Excluir item de exemplo?"
        message="Esta ação é só uma demonstração — nada será excluído de verdade."
        confirmLabel="Excluir"
        danger
        onConfirm={() => setConfirmOpen(false)}
        onCancel={() => setConfirmOpen(false)}
      />
    </div>
  );
}

function Secao({ titulo, children }: { titulo: string; children: React.ReactNode }) {
  return (
    <section className="card p-5">
      <h2 className="text-sm font-bold text-navy-900 dark:text-white">{titulo}</h2>
      <div className="mt-3">{children}</div>
    </section>
  );
}
