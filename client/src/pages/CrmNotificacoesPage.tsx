// ============================================================================
// FASE 9.2 — CAIXA DE ENTRADA INTERNA DO CRM (/crm/notificacoes)
//
// Leitura de `GET /api/crm/notificacoes` (endpoint próprio, recortado por
// empresa E por usuário no servidor). A tela NÃO decide nada: o destinatário é
// sempre o próprio ator, a idempotência e a entrega são do servidor.
//
// Ações: marcar uma como lida (`POST /api/crm/notificacoes/:id/lida`) e marcar
// todas (`POST /api/crm/notificacoes/lidas`) — ambas idempotentes. A interface
// só reflete o resultado depois da resposta do servidor (nada de otimismo).
//
// ZERO MODAL: lista + navegação, sem sobreposição.
// ============================================================================
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { BellOff, CheckCheck, Inbox, RefreshCw } from 'lucide-react';
import { api, ApiError } from '../lib/api';
import { Alert, Badge, EmptyState, PageHeader, Spinner, useToast } from '../components/ui';
import { PageShell } from '../components/ui-kit-negocios';
import { formatRelative } from '../lib/format';
import type { Tone } from '../lib/meta';

type Notificacao = {
  id: number;
  atividade_id: number | null;
  tipo: string;
  severidade: string;
  titulo: string;
  detalhe: string;
  usuario_id: number | null;
  lida_em: string | null;
  criado_em: string;
};

type Caixa = {
  itens: Notificacao[];
  total: number;
  nao_lidas: number;
  page: number;
  pageSize: number;
};

const TIPO_LABEL: Record<string, string> = {
  atribuicao: 'Atribuição',
  lembrete: 'Lembrete',
  vencida: 'Vencida',
  alteracao_responsavel: 'Troca de responsável',
  conclusao: 'Conclusão',
  reagendamento: 'Reagendamento',
  cancelamento: 'Cancelamento',
  falha: 'Falha de processamento',
};

const TOM_SEVERIDADE: Record<string, Tone> = {
  baixa: 'slate',
  media: 'blue',
  alta: 'amber',
  critica: 'red',
};

const TIPOS = Object.keys(TIPO_LABEL);

export default function CrmNotificacoesPage() {
  const toast = useToast();
  const [caixa, setCaixa] = useState<Caixa | null>(null);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState('');
  const [tipo, setTipo] = useState('');
  const [marcando, setMarcando] = useState(false);

  const carregar = useCallback(async () => {
    setCarregando(true);
    setErro('');
    const qs = new URLSearchParams();
    if (tipo) qs.set('tipo', tipo);
    try {
      setCaixa(await api.get<Caixa>(`/crm/notificacoes${qs.size ? `?${qs}` : ''}`));
    } catch (e) {
      setErro(e instanceof ApiError ? e.message : 'Não foi possível carregar a caixa de entrada.');
    } finally {
      setCarregando(false);
    }
  }, [tipo]);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  async function marcarUma(n: Notificacao) {
    if (n.lida_em) return;
    try {
      await api.post(`/crm/notificacoes/${n.id}/lida`, {});
      await carregar();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Não foi possível marcar como lida.');
    }
  }

  async function marcarTodas() {
    setMarcando(true);
    try {
      const r = await api.post<{ marcadas: number }>('/crm/notificacoes/lidas', {});
      toast.success(r.marcadas > 0 ? `${r.marcadas} notificação(ões) marcada(s) como lida(s).` : 'Nada a marcar.');
      await carregar();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Não foi possível marcar as notificações.');
    } finally {
      setMarcando(false);
    }
  }

  const itens = caixa?.itens ?? [];

  return (
    <PageShell>
      <PageHeader
        title="Caixa de entrada do CRM"
        description="Avisos internos do ciclo de vida das atividades: atribuição, lembrete, vencida, troca de responsável, conclusão, reagendamento e cancelamento. Cada usuário vê apenas a própria caixa — nada é enviado por e-mail, WhatsApp ou SMS nesta fase."
        actions={
          <>
            <button type="button" className="btn-secondary" onClick={() => void carregar()} disabled={carregando}>
              <RefreshCw className="h-4 w-4" aria-hidden="true" /> Atualizar
            </button>
            <button
              type="button"
              className="btn-primary"
              onClick={() => void marcarTodas()}
              disabled={marcando || (caixa?.nao_lidas ?? 0) === 0}
            >
              <CheckCheck className="h-4 w-4" aria-hidden="true" /> Marcar todas como lidas
            </button>
          </>
        }
      />

      <div className="flex flex-wrap items-end gap-3 rounded-xl border border-slate-200 bg-white px-4 py-3 dark:border-navy-800 dark:bg-navy-900">
        <label className="text-xs text-slate-500 dark:text-navy-300">
          Tipo
          <select className="input mt-1" value={tipo} onChange={(e) => setTipo(e.target.value)} aria-label="Filtrar por tipo">
            <option value="">Todos</option>
            {TIPOS.map((t) => (
              <option key={t} value={t}>
                {TIPO_LABEL[t]}
              </option>
            ))}
          </select>
        </label>
        {tipo && (
          <button type="button" className="btn-ghost" onClick={() => setTipo('')}>
            Limpar filtro
          </button>
        )}
      </div>

      {erro ? (
        <div className="space-y-2">
          <Alert tone="red">{erro}</Alert>
          <button type="button" className="btn-secondary" onClick={() => void carregar()}>
            Tentar novamente
          </button>
        </div>
      ) : carregando && !caixa ? (
        <Spinner label="Carregando caixa de entrada..." />
      ) : itens.length === 0 ? (
        <EmptyState
          icon={<Inbox className="h-6 w-6" aria-hidden="true" />}
          title="Caixa de entrada vazia"
          description="Nenhuma notificação para os filtros atuais. Os avisos aparecem quando uma atividade é atribuída, lembrada, vencida ou alterada."
        />
      ) : (
        <ul className="divide-y divide-slate-100 rounded-xl border border-slate-200 bg-white dark:divide-navy-800 dark:border-navy-800 dark:bg-navy-900">
          {itens.map((n) => {
            const naoLida = !n.lida_em;
            return (
              <li key={n.id} className={`flex flex-wrap items-start gap-3 px-4 py-3 ${naoLida ? 'bg-brand-50/50 dark:bg-navy-800/40' : ''}`}>
                <span aria-hidden="true" className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${naoLida ? 'bg-brand-500' : 'bg-transparent'}`} />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-sm font-semibold text-navy-900 dark:text-white">{n.titulo}</p>
                    <Badge tone={TOM_SEVERIDADE[n.severidade] ?? 'slate'}>{TIPO_LABEL[n.tipo] ?? n.tipo}</Badge>
                    {naoLida && <Badge tone="blue">Não lida</Badge>}
                  </div>
                  {n.detalhe && <p className="mt-0.5 text-sm text-slate-500 dark:text-navy-300">{n.detalhe}</p>}
                  <p className="mt-0.5 text-xs text-slate-400">
                    {formatRelative(n.criado_em)}
                    {n.atividade_id ? (
                      <>
                        {' · '}
                        <Link className="underline" to={`/crm/atividades/${n.atividade_id}/editar`}>
                          Abrir atividade
                        </Link>
                      </>
                    ) : null}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  {naoLida ? (
                    <button type="button" className="btn-secondary !px-2.5 !py-1.5 text-xs" onClick={() => void marcarUma(n)}>
                      Marcar como lida
                    </button>
                  ) : (
                    <span className="text-xs text-slate-400">Lida</span>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {!erro && caixa && caixa.nao_lidas === 0 && itens.length > 0 && (
        <p className="flex items-center gap-2 text-xs text-slate-400">
          <BellOff className="h-3.5 w-3.5" aria-hidden="true" /> Tudo lido por aqui.
        </p>
      )}
    </PageShell>
  );
}
