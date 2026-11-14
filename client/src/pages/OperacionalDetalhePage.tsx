// ============================================================================
// OPERATIONAL CONTROL PLANE — DETALHE / APROVAÇÃO (/operacional/:id)
//
// Página própria do fluxo (padrão LISTA → PÁGINA): mostra o workflow e a BRANCH
// resolvidos do REGISTRO interno (nunca do cliente), os parâmetros, o motivo e o
// impacto; permite aprovar/rejeitar/cancelar com confirmação explícita e
// REAUTENTICAÇÃO e acompanhar a execução (run id, conclusão, link do GitHub).
//
// O agente MCP NÃO aprova: esta é uma sessão autenticada do ERP. A aprovação é de
// uso único e vinculada ao hash dos parâmetros — alterar parâmetros invalida a
// aprovação (regra do servidor). Nada aqui executa comando, SQL, deploy.
// ============================================================================
import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Ban, CheckCircle2, ExternalLink, Loader2, RefreshCw, XCircle } from 'lucide-react';
import { api, ApiError } from '../lib/api';
import { formatDateTime } from '../lib/format';
import { Alert, Badge, ConfirmacaoInline, PageHeader, Spinner, useToast } from '../components/ui';
import { Card, CardHeader, PageShell } from '../components/ui-kit-negocios';
import ReauthModal from '../components/ReauthModal';
import { ROTULO_STATUS, TOM_STATUS, type Capacidades, type Operacao } from './OperacionalPage';

type Contexto = {
  operation: Operacao;
  workflow: { key: string; repository: string; workflow_file: string; operation: string; requires_approval: boolean; enabled: boolean; allowed_refs: string[]; default_branch: string; maximum_concurrent_executions: number } | null;
  effective_ref: string;
  capabilities: Capacidades;
};

export default function OperacionalDetalhePage() {
  const { id = '' } = useParams();
  const toast = useToast();
  const navigate = useNavigate();
  const [ctx, setCtx] = useState<Contexto | null>(null);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState('');
  const [confirmacao, setConfirmacao] = useState('');
  const [motivoRejeicao, setMotivoRejeicao] = useState('');
  const [processando, setProcessando] = useState(false);
  const [reauthAberto, setReauthAberto] = useState(false);
  const [acao, setAcao] = useState<'approve' | 'reject' | 'cancel' | null>(null);
  const [confirmarCancelamento, setConfirmarCancelamento] = useState(false);

  const carregar = useCallback(async () => {
    setCarregando(true);
    setErro('');
    try {
      const dados = await api.get<Contexto & { ok: boolean }>(`/operational-control/operations/${id}/approval-context`);
      setCtx({ operation: dados.operation, workflow: dados.workflow, effective_ref: dados.effective_ref, capabilities: dados.capabilities });
    } catch (e) {
      setErro(e instanceof ApiError ? e.message : 'Não foi possível carregar a operação.');
    } finally {
      setCarregando(false);
    }
  }, [id]);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  const executar = useCallback(
    async (tipo: 'approve' | 'reject' | 'cancel') => {
      setProcessando(true);
      try {
        if (tipo === 'approve') await api.post(`/operational-control/operations/${id}/approve`, { decision: 'approve', confirmation: confirmacao });
        else if (tipo === 'reject') await api.post(`/operational-control/operations/${id}/reject`, { reason: motivoRejeicao || 'Operação não autorizada.' });
        else await api.post(`/operational-control/operations/${id}/cancel`, { reason: 'Cancelada pelo Diretor.' });
        toast.success(tipo === 'approve' ? 'Operação aprovada.' : tipo === 'reject' ? 'Operação rejeitada.' : 'Operação cancelada.');
        setAcao(null);
        setConfirmarCancelamento(false);
        await carregar();
      } catch (e) {
        if (e instanceof ApiError && e.code === 'reauth_necessaria') {
          setAcao(tipo);
          setReauthAberto(true);
        } else {
          toast.error(e instanceof ApiError ? e.message : 'Não foi possível concluir a ação.');
        }
      } finally {
        setProcessando(false);
      }
    },
    [id, confirmacao, motivoRejeicao, toast, carregar]
  );

  if (carregando) return <PageShell><Spinner label="Carregando operação…" /></PageShell>;
  if (erro || !ctx) {
    return (
      <PageShell>
        <PageHeader title="Operação" description="Controle Operacional" actions={<Link className="btn-ghost" to="/operacional">Voltar</Link>} />
        <Alert tone="red">{erro || 'Operação não encontrada.'}</Alert>
      </PageShell>
    );
  }

  const op = ctx.operation;
  const podeAprovar = op.status === 'pending_approval' && ctx.capabilities.workflow_approval;
  const podeCancelar = ['approved', 'dispatching', 'dispatched', 'running'].includes(op.status) && ctx.capabilities.workflow_request;

  return (
    <PageShell>
      <PageHeader
        title={`Operação ${op.id}`}
        description={ROTULO_STATUS[op.status] ?? op.status}
        actions={
          <div className="flex gap-2">
            <button type="button" className="btn-ghost inline-flex items-center gap-2" onClick={() => void carregar()}>
              <RefreshCw size={16} /> Atualizar
            </button>
            <button type="button" className="btn-ghost" onClick={() => navigate('/operacional')}>Voltar</button>
          </div>
        }
      />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <Card>
            <CardHeader title="Impacto da operação" subtitle="Resolvido do registro interno de workflows — o cliente nunca escolhe repositório, arquivo ou branch." />
            <dl className="grid grid-cols-1 gap-3 p-4 text-sm sm:grid-cols-2">
              <Info rotulo="Workflow" valor={op.workflow_key} />
              <Info rotulo="Repositório" valor={ctx.workflow?.repository ?? '—'} mono />
              <Info rotulo="Arquivo do workflow" valor={ctx.workflow?.workflow_file ?? '—'} mono />
              <Info rotulo="Tipo de operação" valor={ctx.workflow?.operation ?? op.operation_type} />
              <Info rotulo="Branch (resolvida)" valor={ctx.effective_ref || '—'} mono />
              <Info rotulo="Habilitado" valor={ctx.workflow?.enabled ? 'Sim' : 'Não (homologação)'} />
            </dl>
            {!ctx.workflow?.enabled && (
              <p className="mx-4 mb-4 rounded border border-amber-200 bg-amber-50 p-2 text-xs text-amber-700">
                Workflow desabilitado: a política recusa o dispatch até a homologação. Aprovar NÃO o habilita.
              </p>
            )}
          </Card>

          <Card>
            <CardHeader title="Motivo e parâmetros" subtitle="Os parâmetros definem o hash que vincula a aprovação (alterá-los a invalida)." />
            <div className="space-y-3 p-4">
              <div>
                <p className="text-xs font-medium text-slate-500">Motivo da solicitação</p>
                <p className="mt-1 whitespace-pre-wrap text-sm text-slate-700">{op.reason}</p>
              </div>
              <div>
                <p className="text-xs font-medium text-slate-500">Parâmetros</p>
                <pre className="mt-1 overflow-x-auto rounded bg-slate-50 p-2 text-xs text-slate-700">{JSON.stringify(op.parameters, null, 2)}</pre>
              </div>
            </div>
          </Card>
        </div>

        <div className="space-y-4">
          <Card>
            <CardHeader title="Estado" />
            <div className="space-y-3 p-4 text-sm">
              <div className="flex items-center gap-2">
                <Badge tone={TOM_STATUS[op.status] ?? 'slate'}>{ROTULO_STATUS[op.status] ?? op.status}</Badge>
                {op.requires_approval && <span className="text-xs text-slate-500">exige aprovação</span>}
              </div>
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <Badge tone={op.approval.approved ? 'green' : op.approval.decision === 'reject' ? 'red' : 'amber'}>
                  {op.approval.approved ? 'Aprovada' : op.approval.decision === 'reject' ? 'Rejeitada' : 'Sem decisão'}
                </Badge>
                {op.approval.consumed && <span className="text-slate-500">aprov. consumida (uso único)</span>}
              </div>
              <p className="text-xs text-slate-500">Expira em {formatDateTime(op.expires_at)}</p>
              <p className="text-xs text-slate-500">Criada em {formatDateTime(op.created_at)}</p>
            </div>
          </Card>

          {op.execution.status !== 'not_dispatched' && (
            <Card>
              <CardHeader title="Execução" />
              <div className="space-y-2 p-4 text-sm">
                <Badge tone={op.execution.conclusion === 'success' ? 'green' : op.execution.status === 'completed' ? 'slate' : 'blue'}>
                  {op.execution.status}{op.execution.conclusion ? ` · ${op.execution.conclusion}` : ''}
                </Badge>
                {op.execution.run_id && <p className="font-mono text-xs">run #{op.execution.run_id}</p>}
                {op.execution.html_url && (
                  <a className="inline-flex items-center gap-1 text-xs text-blue-600" href={op.execution.html_url} target="_blank" rel="noreferrer">
                    Abrir no GitHub <ExternalLink size={12} />
                  </a>
                )}
              </div>
            </Card>
          )}

          {podeAprovar && (
            <Card>
              <CardHeader title="Aprovação" subtitle="Exige a sua senha (confirmação humana recente). Vale uma única vez." />
              <div className="space-y-3 p-4">
                <label className="block text-sm">
                  <span className="mb-1 block text-xs font-medium text-slate-500">Confirmação (descreva o que autoriza)</span>
                  <input className="input w-full" value={confirmacao} maxLength={500} onChange={(e) => setConfirmacao(e.target.value)} placeholder="Confirmo a execução do diagnóstico read-only." />
                </label>
                <div className="flex flex-wrap gap-2">
                  <button type="button" className="btn-primary inline-flex items-center gap-2" disabled={processando || !confirmacao.trim()} onClick={() => void executar('approve')}>
                    {processando && acao === 'approve' ? <Loader2 className="animate-spin" size={16} /> : <CheckCircle2 size={16} />} Aprovar execução
                  </button>
                  <button type="button" className="btn-ghost inline-flex items-center gap-2" disabled={processando} onClick={() => setAcao('reject')}>
                    <XCircle size={16} /> Rejeitar
                  </button>
                </div>
                {acao === 'reject' && (
                  <div className="space-y-2 border-t border-slate-200 pt-3">
                    <input className="input w-full" value={motivoRejeicao} maxLength={500} onChange={(e) => setMotivoRejeicao(e.target.value)} placeholder="Motivo da rejeição" />
                    <button type="button" className="btn-danger inline-flex items-center gap-2" disabled={processando} onClick={() => void executar('reject')}>
                      {processando && acao === 'reject' ? <Loader2 className="animate-spin" size={16} /> : <Ban size={16} />} Confirmar rejeição
                    </button>
                  </div>
                )}
              </div>
            </Card>
          )}

          {podeCancelar && (
            <Card>
              <CardHeader title="Cancelamento" />
              <div className="p-4">
                <button type="button" className="btn-ghost inline-flex items-center gap-2" onClick={() => setConfirmarCancelamento(true)}>
                  <Ban size={16} /> Cancelar operação
                </button>
                <ConfirmacaoInline
                  open={confirmarCancelamento}
                  title="Cancelar operação"
                  message="Só é possível cancelar antes do despacho ao GitHub."
                  confirmLabel="Cancelar operação"
                  danger
                  busy={processando}
                  onConfirm={() => void executar('cancel')}
                  onCancel={() => setConfirmarCancelamento(false)}
                />
              </div>
            </Card>
          )}

          {!podeAprovar && op.status === 'pending_approval' && (
            <Alert tone="amber">Você não tem a permissão de aprovação (escopo OAuth e/ou perfil). A operação permanece pendente.</Alert>
          )}
        </div>
      </div>

      <ReauthModal
        open={reauthAberto}
        onClose={() => setReauthAberto(false)}
        titulo="Confirmação humana necessária"
        onConfirmed={() => {
          if (acao) void executar(acao);
        }}
      />
    </PageShell>
  );
}

function Info({ rotulo, valor, mono = false }: { rotulo: string; valor: string; mono?: boolean }) {
  return (
    <div>
      <dt className="text-xs text-slate-500">{rotulo}</dt>
      <dd className={mono ? 'font-mono text-xs text-slate-700' : 'text-sm text-slate-700'}>{valor}</dd>
    </div>
  );
}
