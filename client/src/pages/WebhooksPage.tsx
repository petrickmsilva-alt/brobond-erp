// ============================================================================
// Webhooks — integrações de eventos de usuários (Onda 4).
//
//   • Cadastro de URLs assinantes (nome, URL, eventos, ativo/inativo)
//   • Segredo HMAC por webhook, exibido UMA única vez (criação/regeneração)
//   • Teste de entrega, log com estado/resposta/erro e reenvio manual
//   • Criar/alterar/excluir exigem reautenticação (step-up)
// ============================================================================
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { CheckCircle2, FlaskConical, History, Loader2, Plus, Power, RefreshCw, RotateCcw, Trash2, Webhook as WebhookIcon, XCircle } from 'lucide-react';
import { api, ApiError } from '../lib/api';
import { formatDateTime, formatRelative } from '../lib/format';
import { Alert, Badge, ConfirmacaoInline, EmptyState, PainelInline, PageHeader, Spinner, useToast } from '../components/ui';
import ReauthModal from '../components/ReauthModal';

type Webhook = {
  id: number;
  nome: string;
  url: string;
  eventos: string[];
  ativo: boolean;
  tem_segredo: boolean;
  criado_em: string | null;
  entregas_24h: number;
  erros_24h: number;
  ultima_entrega_em: string | null;
  ultimo_estado: string | null;
};

type EventoInfo = { id: string; label: string };

type Entrega = {
  id: number;
  evento: string;
  estado: string;
  tentativas: number;
  resposta_status: number | null;
  resposta_corpo: string | null;
  erro: string | null;
  criada_em: string | null;
  concluida_em: string | null;
  payload: Record<string, any> | null;
};

export default function WebhooksPage() {
  const navigate = useNavigate();
  const toast = useToast();
  const [webhooks, setWebhooks] = useState<Webhook[]>([]);
  const [eventos, setEventos] = useState<EventoInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [toDelete, setToDelete] = useState<Webhook | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [reauth, setReauth] = useState<{ acao: 'excluir' | 'alternar'; titulo: string } | null>(null);
  const [testBusy, setTestBusy] = useState<number | null>(null);
  const [toggleBusy, setToggleBusy] = useState<number | null>(null);
  const [logDe, setLogDe] = useState<Webhook | null>(null);

  const carregar = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const d = await api.get<{ webhooks: Webhook[]; eventos_disponiveis: EventoInfo[] }>('/webhooks');
      setWebhooks(d.webhooks || []);
      setEventos(d.eventos_disponiveis || []);
    } catch (e: any) {
      setError(e.message || 'Erro ao carregar');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    carregar();
  }, [carregar]);

  function rotuloEvento(id: string): string {
    return eventos.find((e) => e.id === id)?.label || id;
  }

  async function alternarAtivo(w: Webhook) {
    setToggleBusy(w.id);
    try {
      await api.put(`/webhooks/${w.id}`, { ativo: !w.ativo });
      toast.success(w.ativo ? `"${w.nome}" pausado.` : `"${w.nome}" ativado.`);
      await carregar();
    } catch (e: any) {
      if (e instanceof ApiError && e.code === 'reauth_necessaria') {
        setReauth({ acao: 'alternar', titulo: `Autorizar ${w.ativo ? 'pausa' : 'ativação'} — ${w.nome}` });
        // guarda o alvo na sessão do modal de confirmação reutilizada abaixo
        setToDelete(w);
        return;
      }
      toast.error(e instanceof ApiError ? e.message : 'Não foi possível alternar.');
    } finally {
      setToggleBusy(null);
    }
  }

  // ZERO MODAL: criar/editar é PÁGINA própria (/webhooks/novo e
  // /webhooks/:id/editar). O segredo de uso único é exibido lá, não aqui.
  const abrirNovo = () => navigate('/webhooks/novo');
  const abrirEdicao = (w: Webhook) => navigate(`/webhooks/${w.id}/editar`);

  async function excluirAtual() {
    if (!toDelete || reauth?.acao === 'alternar') return;
    setDeleting(true);
    try {
      await api.del(`/webhooks/${toDelete.id}`);
      toast.success(`"${toDelete.nome}" excluído com o log de entregas.`);
      setToDelete(null);
      await carregar();
    } catch (e: any) {
      if (e instanceof ApiError && e.code === 'reauth_necessaria') {
        setReauth({ acao: 'excluir', titulo: `Autorizar exclusão — ${toDelete.nome}` });
        return;
      }
      toast.error(e instanceof ApiError ? e.message : 'Não foi possível excluir.');
    } finally {
      setDeleting(false);
    }
  }

  async function testar(w: Webhook) {
    setTestBusy(w.id);
    try {
      const d = await api.post<{ ok: boolean; estado: string; resposta_status: number | null; ms: number }>(`/webhooks/${w.id}/testar`, {});
      if (d.ok) toast.success(`Teste entregue (HTTP ${d.resposta_status}, ${d.ms} ms).`);
      else toast.error(`Teste falhou (HTTP ${d.resposta_status ?? '—'}). Veja o log.`);
      await carregar();
    } catch (e: any) {
      toast.error(e instanceof ApiError ? e.message : 'Não foi possível testar.');
    } finally {
      setTestBusy(null);
    }
  }

  return (
    <div className="p-4 sm:p-6">
      <PageHeader
        title={
          <span className="flex items-center gap-2.5">
            <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-navy-800 text-white">
              <WebhookIcon className="h-5 w-5" />
            </span>
            Webhooks
          </span>
        }
        description="Avise sistemas externos (SIEM, intranet, automações) sobre o ciclo de vida dos usuários. Cada entrega é assinada (HMAC) e registrada."
        actions={
          <>
            <button className="btn-secondary" onClick={carregar} disabled={loading} title="Atualizar">
              <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
              <span className="hidden sm:inline">Atualizar</span>
            </button>
            <button className="btn-accent" onClick={abrirNovo}>
              <Plus className="h-4 w-4" /> Novo webhook
            </button>
          </>
        }
      />

      <div className="card overflow-hidden">
        {error && (
          <div className="p-4">
            <Alert tone="red">{error}</Alert>
          </div>
        )}
        {loading && !webhooks.length && !error && <Spinner />}
        {!loading && !error && !webhooks.length && (
          <EmptyState
            icon={<WebhookIcon className="h-6 w-6" />}
            title="Nenhum webhook cadastrado"
            description="Cadastre a URL do sistema que deve ser avisado (ex.: SIEM da matriz) e escolha os eventos."
            action={
              <button className="btn-accent" onClick={abrirNovo}>
                <Plus className="h-4 w-4" /> Novo webhook
              </button>
            }
          />
        )}
        {!!webhooks.length && (
          <ul className="divide-y divide-slate-100">
            {webhooks.map((w) => (
              <li key={w.id} className={`px-4 py-3.5 ${w.ativo ? '' : 'bg-slate-50/60'}`}>
                <div className="flex flex-wrap items-start gap-3">
                  <span className={`mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${w.ativo ? 'bg-navy-800 text-white' : 'bg-slate-200 text-slate-500'}`}>
                    <WebhookIcon className="h-4 w-4" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="flex flex-wrap items-center gap-1.5 text-sm font-semibold text-navy-900">
                      {w.nome}
                      {w.ativo ? <Badge tone="green">Ativo</Badge> : <Badge tone="slate">Pausado</Badge>}
                      {w.erros_24h > 0 && <Badge tone="red">{w.erros_24h} falha(s) 24h</Badge>}
                    </p>
                    <p className="mt-0.5 truncate font-mono text-xs text-slate-500" title={w.url}>
                      {w.url}
                    </p>
                    <div className="mt-1.5 flex flex-wrap gap-1">
                      {w.eventos.map((e) => (
                        <Badge key={e} tone="blue">{rotuloEvento(e)}</Badge>
                      ))}
                    </div>
                    <p className="mt-1.5 text-xs text-slate-400">
                      {w.entregas_24h} entrega(s) nas 24h
                      {w.ultima_entrega_em ? (
                        <>
                          {' '}· última {formatRelative(w.ultima_entrega_em)}:{' '}
                          {w.ultimo_estado === 'ok' ? (
                            <span className="font-medium text-emerald-600">ok</span>
                          ) : (
                            <span className="font-medium text-red-600">falhou</span>
                          )}
                        </>
                      ) : (
                        ' · nunca entregou'
                      )}
                    </p>
                  </div>
                  <div className="flex shrink-0 flex-wrap gap-1.5">
                    <button
                      className="btn-secondary !px-2.5 !py-1.5 text-xs"
                      onClick={() => setLogDe(w)}
                      title="Ver log de entregas"
                    >
                      <History className="h-3.5 w-3.5" /> Log
                    </button>
                    <button
                      className="btn-secondary !px-2.5 !py-1.5 text-xs"
                      onClick={() => testar(w)}
                      disabled={testBusy === w.id || !w.ativo}
                      title={w.ativo ? 'Enviar um evento de teste agora' : 'Ative para testar'}
                    >
                      {testBusy === w.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FlaskConical className="h-3.5 w-3.5" />} Testar
                    </button>
                    <button
                      className="btn-secondary !px-2.5 !py-1.5 text-xs"
                      onClick={() => alternarAtivo(w)}
                      disabled={toggleBusy === w.id}
                      title={w.ativo ? 'Pausar entregas' : 'Retomar entregas'}
                    >
                      {toggleBusy === w.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Power className="h-3.5 w-3.5" />}
                      {w.ativo ? 'Pausar' : 'Ativar'}
                    </button>
                    <button
                      className="btn-secondary !px-2.5 !py-1.5 text-xs"
                      onClick={() => abrirEdicao(w)}
                    >
                      Editar
                    </button>
                    <button
                      className="btn-secondary !px-2.5 !py-1.5 text-xs hover:!border-red-300 hover:!text-red-600"
                      onClick={() => setToDelete(w)}
                      title="Excluir webhook e o log"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      <p className="mt-3 text-xs text-slate-400">
        Segurança: cada POST leva <span className="font-mono">X-Brobond-Signature: sha256=HMAC(segredo, corpo)</span> — o receptor valida a origem. O log guarda as 200 entregas mais recentes por webhook.
      </p>

      {/* Exclusão */}
      <ConfirmacaoInline
        open={!!toDelete && reauth?.acao !== 'alternar'}
        title="Excluir webhook?"
        danger
        confirmLabel="Excluir"
        busy={deleting}
        onCancel={() => !deleting && setToDelete(null)}
        onConfirm={excluirAtual}
        message={
          <p>
            <strong>{toDelete?.nome}</strong> para de receber eventos e o <strong>log de entregas é apagado junto</strong>. Exige a sua senha (reautenticação).
          </p>
        }
      />

      {/* Log de entregas */}
      {logDe && <LogEntregas webhook={logDe} onClose={() => { setLogDe(null); carregar(); }} />}

      {/* Reautenticação */}
      <ReauthModal
        open={!!reauth}
        onClose={() => {
          // alternar usa toDelete como "alvo guardado" — limpa junto
          if (reauth?.acao === 'alternar') setToDelete(null);
          setReauth(null);
        }}
        onConfirmed={() => {
          const r = reauth;
          setReauth(null);
          if (r?.acao === 'excluir') void excluirAtual();
          else if (r?.acao === 'alternar' && toDelete) {
            const alvo = toDelete;
            setToDelete(null);
            void alternarAtivo(alvo);
          }
        }}
        titulo={reauth?.titulo || 'Autorização necessária'}
      />
    </div>
  );
}

/** PainelInline do log de entregas de um webhook, com filtro e reenvio. */
function LogEntregas({ webhook, onClose }: { webhook: Webhook; onClose: () => void }) {
  const toast = useToast();
  const [entregas, setEntregas] = useState<Entrega[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [filtro, setFiltro] = useState('');
  const [retryBusy, setRetryBusy] = useState<number | null>(null);
  const [aberto, setAberto] = useState<number | null>(null);

  const carregar = useCallback(async () => {
    setLoading(true);
    try {
      const d = await api.get<{ total: number; entregas: Entrega[] }>(`/webhooks/${webhook.id}/entregas${filtro ? `?estado=${filtro}` : ''}`);
      setEntregas(d.entregas || []);
      setTotal(d.total);
    } catch (e: any) {
      toast.error(e.message || 'Não foi possível carregar o log.');
    } finally {
      setLoading(false);
    }
  }, [webhook.id, filtro, toast]);

  useEffect(() => {
    carregar();
  }, [carregar]);

  async function reenviar(id: number) {
    setRetryBusy(id);
    try {
      const d = await api.post<{ ok: boolean; estado: string; tentativas: number }>(`/webhooks/entregas/${id}/reenviar`, {});
      toast[d.ok ? 'success' : 'error'](d.ok ? `Entrega refeita (tentativa ${d.tentativas}).` : 'Reenvio falhou de novo — veja o motivo.');
      await carregar();
    } catch (e: any) {
      toast.error(e instanceof ApiError ? e.message : 'Não foi possível reenviar.');
    } finally {
      setRetryBusy(null);
    }
  }

  return (
    <PainelInline open onClose={onClose} title={`Log — ${webhook.nome}`} subtitle={`${total} entrega(s) registrada(s)`} size="lg">
      <div className="mb-3 flex items-center gap-2">
        <select className="input w-auto" value={filtro} onChange={(e) => setFiltro(e.target.value)} aria-label="Filtrar por estado">
          <option value="">Todas</option>
          <option value="ok">Só entregues</option>
          <option value="erro">Só falhas</option>
        </select>
        <button className="btn-secondary ml-auto !px-2.5 !py-1.5 text-xs" onClick={carregar} disabled={loading}>
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} /> Atualizar
        </button>
      </div>
      {loading && !entregas.length ? (
        <Spinner />
      ) : !entregas.length ? (
        <EmptyState icon={<History className="h-6 w-6" />} title="Sem entregas" description={filtro ? 'Nada com este estado.' : 'Use "Testar" ou aguarde um evento assinado.'} />
      ) : (
        <ul className="max-h-[55vh] space-y-2 overflow-auto pr-1">
          {entregas.map((e) => (
            <li key={e.id} className="rounded-lg border border-slate-200 p-2.5 text-sm">
              <div className="flex flex-wrap items-center gap-1.5">
                {e.estado === 'ok' ? (
                  <Badge tone="green"><CheckCircle2 className="mr-1 inline h-3 w-3" />Entregue</Badge>
                ) : (
                  <Badge tone="red"><XCircle className="mr-1 inline h-3 w-3" />Falhou</Badge>
                )}
                <span className="font-mono text-xs text-navy-800">{e.evento}</span>
                <span className="ml-auto text-xs text-slate-400" title={formatDateTime(e.concluida_em)}>
                  {e.concluida_em ? formatRelative(e.concluida_em) : '—'}
                  {e.resposta_status ? ` · HTTP ${e.resposta_status}` : ''}
                  {e.tentativas > 1 ? ` · ${e.tentativas} tentativas` : ''}
                </span>
              </div>
              {e.erro && <p className="mt-1 text-xs text-red-600">{e.erro}</p>}
              {e.resposta_corpo && <p className="mt-1 truncate font-mono text-[11px] text-slate-400" title={e.resposta_corpo}>{e.resposta_corpo}</p>}
              <div className="mt-1.5 flex gap-1.5">
                <button className="btn-ghost !px-2 !py-1 text-xs" onClick={() => setAberto(aberto === e.id ? null : e.id)}>
                  {aberto === e.id ? 'Ocultar payload' : 'Ver payload'}
                </button>
                <button className="btn-secondary !px-2 !py-1 text-xs" onClick={() => reenviar(e.id)} disabled={retryBusy === e.id}>
                  {retryBusy === e.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5" />} Reenviar
                </button>
              </div>
              {aberto === e.id && (
                <pre className="mt-1.5 max-h-48 overflow-auto rounded-md bg-slate-900 p-2.5 font-mono text-[11px] leading-5 text-slate-100">
                  {JSON.stringify(e.payload, null, 2)}
                </pre>
              )}
            </li>
          ))}
        </ul>
      )}
    </PainelInline>
  );
}
