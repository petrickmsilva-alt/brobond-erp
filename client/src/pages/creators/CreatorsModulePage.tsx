import { useEffect, useState } from 'react';
import { NavLink } from 'react-router-dom';
import { RefreshCw } from 'lucide-react';
import type { Module } from '../../modules';
import { MODULES } from '../../modules';
import { Alert, Badge, EmptyState, PageHeader, Spinner } from '../../components/ui';
import { apiFetch, ApiError } from '../../lib/api';

type Capability = {
  fonte: string | null;
  consulta: boolean;
  criacao?: boolean;
  recomendacao?: boolean;
  geracao?: boolean;
  envio?: boolean;
};
type Capabilities = { empresa_id: number; modulos: Record<string, Capability> };

const CONTENT: Record<string, { title: string; empty: string; description: string; source: string }> = {
  creators: {
    title: 'CREATORS',
    empty: 'Cadastro de creators indisponível.',
    description: 'O cadastro de creators não possui persistência conectada nesta instalação. Por isso, não há ação de cadastro disponível nesta página.',
    source: 'Perfis e parcerias precisam de uma fonte própria de creators. Clientes e representantes do ERP não são convertidos automaticamente em creators.',
  },
  'creator-matches': {
    title: 'MATCHES',
    empty: 'Matching não configurado.',
    description: 'Para iniciar o processo, é necessário conectar uma base de creators, campanhas e um mecanismo de matching. Esta instalação não possui esse mecanismo.',
    source: 'Scores e recomendações só podem ser apresentados quando fornecidos por um mecanismo real de matching. Nenhuma afinidade é simulada.',
  },
  'outreach-ai': {
    title: 'OUTREACH AI',
    empty: 'Outreach sem integração configurada.',
    description: 'Quando houver creators ou oportunidades elegíveis em uma fonte conectada, elas poderão ser consultadas aqui. Não há pipeline de outreach conectado nesta instalação.',
    source: 'Não há integração de mensagens, geração por IA ou envio para creators nesta instalação. Nenhuma mensagem ou interação é simulada.',
  },
  campanhas: {
    title: 'CAMPANHAS',
    empty: 'Campanhas sem persistência instalada.',
    description: 'O cadastro de campanhas com creators não possui persistência conectada nesta instalação. Nenhuma ação de criação ou edição é oferecida sem esse fluxo.',
    source: 'Campanhas de aquisição do CRM pertencem a outro domínio e não são tratadas como campanhas com creators. Resultados e ROI não são estimados sem dados.',
  },
};

const NAVIGATION = MODULES.filter((item) => item.space === 'creators');

/**
 * Páginas do domínio Creators no layout nativo ERP/Commerce.
 * As capacidades vêm da API autenticada, não do antigo status de roadmap.
 * Sem persistência instalada, não se fabricam colunas, KPIs, registros ou CTAs.
 */
export default function CreatorsModulePage({ module }: { module: Module }) {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<
    | { status: 'loading' }
    | { status: 'error'; message: string }
    | { status: 'success'; capabilities: Capabilities }
  >({ status: 'loading' });
  const content = CONTENT[module.id];

  useEffect(() => {
    let active = true;
    setState({ status: 'loading' });
    apiFetch<Capabilities>('/creators/capabilities')
      .then((capabilities) => {
        if (!capabilities.modulos?.[module.id] || !Number.isInteger(capabilities.empresa_id) || capabilities.empresa_id <= 0) {
          throw new Error('Resposta de capacidades inválida.');
        }
        const capability = capabilities.modulos[module.id];
        if (capability.fonte !== null || capability.consulta !== false || Object.values(capability).includes(true)) {
          throw new Error('Contrato de capacidades incompatível com esta versão da página.');
        }
        if (active) setState({ status: 'success', capabilities });
      })
      .catch((error: unknown) => {
        if (active) setState({
          status: 'error',
          message: error instanceof ApiError ? error.message : 'Não foi possível verificar os recursos deste módulo. Tente novamente.',
        });
      });
    return () => { active = false; };
  }, [attempt, module.id]);

  if (!content) return <Alert tone="red">Módulo não registrado no domínio Creators.</Alert>;

  const refresh = (
    <button type="button" className="btn-secondary" onClick={() => setAttempt((value) => value + 1)}>
      <RefreshCw className="h-4 w-4" aria-hidden="true" />
      {state.status === 'error' ? 'Tentar novamente' : 'Atualizar'}
    </button>
  );
  const Icon = module.icon;

  return (
    <div className="min-w-0 space-y-4">
      <PageHeader title={content.title} description={module.description} />

      <nav aria-label="Módulos de Creators" className="flex flex-wrap gap-2 rounded-xl border border-line bg-surface p-3">
        {NAVIGATION.map((item) => (
          <NavLink
            key={item.id}
            to={item.path}
            end
            className={({ isActive }) => `${isActive ? 'btn-primary' : 'btn-secondary'} max-w-full`}
          >
            <item.icon className="h-4 w-4 shrink-0" aria-hidden="true" />
            {item.label}
          </NavLink>
        ))}
      </nav>

      <section aria-label={`Visão de ${module.label}`} aria-busy={state.status === 'loading'} className="min-w-0 rounded-xl border border-line bg-surface">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line p-4">
          <h2 className="text-sm font-semibold text-navy-900 dark:text-white">{module.label}</h2>
          {state.status !== 'loading' && refresh}
        </div>
        {state.status === 'loading' && <div role="status"><Spinner label="Verificando recursos do módulo…" /></div>}
        {state.status === 'error' && (
          <div className="p-4"><Alert tone="red">{state.message}</Alert></div>
        )}
        {state.status === 'success' && (
          <>
            <div className="px-4 pt-4">
              <div className="mb-3"><Badge tone="amber">PENDENTE DE CONFIGURAÇÃO</Badge></div>
              <Alert tone="blue">
                <strong>Sem fonte de dados conectada.</strong> Os recursos de dados deste módulo não estão instalados no servidor. Esta informação não representa uma consulta com total zero.
              </Alert>
            </div>
            <EmptyState icon={<Icon className="h-6 w-6" aria-hidden="true" />} title={content.empty} description={content.description} />
            <div className="border-t border-line p-4 text-sm text-slate-700 dark:text-slate-200">
              <p className="font-semibold">Origem dos dados</p>
              <p className="mt-1 break-words">{content.source}</p>
              <p className="mt-2">Não existe um fluxo de configuração ou cadastro instalado para este domínio. O responsável pela implantação precisa disponibilizar a persistência e as APIs antes de habilitar criação, edição ou consulta de registros. Não é possível resolver esta dependência com credenciais de outros módulos.</p>
            </div>
          </>
        )}
      </section>
    </div>
  );
}
