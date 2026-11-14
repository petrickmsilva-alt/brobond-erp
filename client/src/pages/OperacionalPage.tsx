// ============================================================================
// OPERATIONAL CONTROL PLANE — LISTA (/operacional)
//
// Visão do Diretor: capacidades efetivas, solicitações pendentes e histórico de
// operações. Segue o padrão do ERP — LISTA → PÁGINA: o detalhe, a aprovação e o
// acompanhamento vivem na página própria `/operacional/:id`. Nada executa
// comando, SQL, deploy ou migration.
// ============================================================================
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ExternalLink, GitBranch, History, RefreshCw, ShieldCheck } from 'lucide-react';
import { api, ApiError } from '../lib/api';
import { formatDateTime } from '../lib/format';
import { Alert, Badge, EmptyState, PageHeader, Spinner } from '../components/ui';
import { Card, CardHeader, DataTable, PageShell, StatCard, type DataTableColumn } from '../components/ui-kit-negocios';

export type Capacidades = {
  repository_read: boolean;
  workflow_read: boolean;
  workflow_request: boolean;
  workflow_approval: boolean;
  arbitrary_command_execution: boolean;
  github_app_configured?: boolean;
  workflows?: { key: string; operation: string; enabled: boolean; requiresApproval: boolean; branch: string; allowedRefs: string[] }[];
};

export type Operacao = {
  id: string;
  operation_type: string;
  workflow_key: string;
  requested_by: number;
  parameters: Record<string, unknown>;
  reason: string;
  status: string;
  requires_approval: boolean;
  expires_at: string;
  created_at: string;
  updated_at: string;
  approval: { required: boolean; approved: boolean; decision: string | null; approved_by?: number; decided_at?: string; consumed?: boolean };
  execution: { id: string | null; run_id: number | null; status: string; conclusion: string | null; html_url: string | null };
};

export const TOM_STATUS: Record<string, 'green' | 'red' | 'amber' | 'blue' | 'slate'> = {
  requested: 'slate',
  pending_approval: 'amber',
  approved: 'blue',
  rejected: 'red',
  expired: 'slate',
  dispatching: 'amber',
  dispatch_failed: 'red',
  dispatched: 'blue',
  running: 'blue',
  completed: 'green',
  failed: 'red',
  cancelled: 'slate',
};

export const ROTULO_STATUS: Record<string, string> = {
  requested: 'Solicitada',
  pending_approval: 'Aguardando aprovação',
  approved: 'Aprovada',
  rejected: 'Rejeitada',
  expired: 'Expirada',
  dispatching: 'Despachando',
  dispatch_failed: 'Falha no despacho',
  dispatched: 'Despachada',
  running: 'Em execução',
  completed: 'Concluída',
  failed: 'Falhou',
  cancelled: 'Cancelada',
};

export default function OperacionalPage() {
  const [caps, setCaps] = useState<Capacidades | null>(null);
  const [operacoes, setOperacoes] = useState<Operacao[]>([]);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState('');
  const [filtroStatus, setFiltroStatus] = useState('');

  const carregar = useCallback(async () => {
    setCarregando(true);
    setErro('');
    try {
      const [c, o] = await Promise.all([
        api.get<{ capabilities: Capacidades }>('/operational-control/capabilities'),
        api.get<{ operations: Operacao[] }>('/operational-control/operations'),
      ]);
      setCaps(c.capabilities);
      setOperacoes(o.operations || []);
    } catch (e) {
      setErro(e instanceof ApiError ? e.message : 'Não foi possível carregar o painel operacional.');
    } finally {
      setCarregando(false);
    }
  }, []);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  const operacoesFiltradas = useMemo(
    () => (filtroStatus ? operacoes.filter((o) => o.status === filtroStatus) : operacoes),
    [operacoes, filtroStatus]
  );
  const pendentes = useMemo(() => operacoes.filter((o) => o.status === 'pending_approval'), [operacoes]);
  const emAndamento = useMemo(() => operacoes.filter((o) => ['dispatching', 'dispatched', 'running'].includes(o.status)), [operacoes]);
  const concluidas = useMemo(() => operacoes.filter((o) => ['completed', 'failed'].includes(o.status)), [operacoes]);

  const colunas: DataTableColumn<Operacao>[] = [
    { key: 'id', header: 'Operação', render: (o) => <Link className="font-mono text-xs text-blue-600 hover:underline" to={`/operacional/${o.id}`}>{o.id}</Link> },
    { key: 'workflow_key', header: 'Workflow', render: (o) => o.workflow_key },
    { key: 'status', header: 'Estado', render: (o) => <Badge tone={TOM_STATUS[o.status] ?? 'slate'}>{ROTULO_STATUS[o.status] ?? o.status}</Badge> },
    { key: 'reason', header: 'Motivo', render: (o) => <span className="line-clamp-2 max-w-xs text-xs text-slate-600">{o.reason}</span> },
    { key: 'created_at', header: 'Criada em', render: (o) => <span className="text-xs">{formatDateTime(o.created_at)}</span> },
    { key: 'run', header: 'Execução', render: (o) => (o.execution.html_url ? <a className="inline-flex items-center gap-1 text-xs text-blue-600" href={o.execution.html_url} target="_blank" rel="noreferrer">run #{o.execution.run_id} <ExternalLink size={12} /></a> : <span className="text-xs text-slate-400">—</span>) },
  ];

  if (carregando) return <PageShell><Spinner label="Carregando painel operacional…" /></PageShell>;

  return (
    <PageShell>
      <PageHeader
        title="Controle Operacional"
        description="Solicitações, aprovações e execuções de workflows autorizados. Aprovar não é executar: a execução depende de aprovação humana e da política."
        actions={
          <button type="button" className="btn-ghost inline-flex items-center gap-2" onClick={() => void carregar()}>
            <RefreshCw size={16} /> Atualizar
          </button>
        }
      />

      {erro && <Alert tone="red">{erro}</Alert>}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatCard label="Pendentes de aprovação" value={pendentes.length} />
        <StatCard label="Em andamento" value={emAndamento.length} />
        <StatCard label="Concluídas" value={concluidas.length} />
        <StatCard label="Execução arbitrária" value={caps?.arbitrary_command_execution ? 'ATIVA' : 'Bloqueada'} hint="Nunca é habilitada por desenho" />
      </div>

      <Card>
        <CardHeader title="Suas capacidades" subtitle="Calculadas das suas permissões e da política operacional — nunca presumidas." icon={ShieldCheck} />
        <div className="flex flex-wrap gap-2 p-4">
          <Capacidade ativa={!!caps?.repository_read} texto="Ler repositório" />
          <Capacidade ativa={!!caps?.workflow_read} texto="Ler workflows" />
          <Capacidade ativa={!!caps?.workflow_request} texto="Solicitar execução" />
          <Capacidade ativa={!!caps?.workflow_approval} texto="Aprovar execução" />
          <Capacidade ativa={!!caps?.github_app_configured} texto="GitHub App configurada" />
        </div>
        {caps?.workflows?.length ? (
          <div className="border-t border-slate-100 p-4">
            <p className="mb-2 text-xs font-medium text-slate-500">Workflows registrados (fonte interna — o cliente nunca escolhe repositório, arquivo ou branch)</p>
            <ul className="space-y-1 text-xs text-slate-600">
              {caps.workflows.map((w) => (
                <li key={w.key} className="flex flex-wrap items-center gap-2">
                  <span className="font-mono">{w.key}</span>
                  <Badge tone={w.enabled ? 'green' : 'slate'}>{w.enabled ? 'Habilitado' : 'Desabilitado (homologação)'}</Badge>
                  <span className="inline-flex items-center gap-1"><GitBranch size={12} /> {w.branch}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </Card>

      <Card>
        <CardHeader
          title="Operações"
          subtitle="Solicitações e seu estado. A aprovação é de uso único e vinculada aos parâmetros."
          icon={History}
          actions={
            <select className="input" value={filtroStatus} onChange={(e) => setFiltroStatus(e.target.value)} aria-label="Filtrar por estado">
              <option value="">Todos os estados</option>
              {Object.keys(ROTULO_STATUS).map((s) => (
                <option key={s} value={s}>{ROTULO_STATUS[s]}</option>
              ))}
            </select>
          }
        />
        <div className="p-4">
          {operacoesFiltradas.length === 0 ? (
            <EmptyState icon={<History size={20} />} title="Nenhuma operação" description="Quando uma solicitação for criada (pelo ERP ou pelo MCP), ela aparece aqui." />
          ) : (
            <DataTable columns={colunas} rows={operacoesFiltradas} caption="Operações operacionais" empty="Nenhuma operação neste filtro." getRowKey={(o) => o.id} />
          )}
        </div>
      </Card>
    </PageShell>
  );
}

function Capacidade({ ativa, texto }: { ativa: boolean; texto: string }) {
  return <Badge tone={ativa ? 'green' : 'slate'}>{ativa ? '✓' : '—'} {texto}</Badge>;
}
