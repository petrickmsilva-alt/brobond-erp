// ============================================================================
// AGENDA DO CRM — hoje / atrasadas / próximas (módulo /crm/agenda)
//
// Leitura de `GET /api/crm/atividades/agenda` (endpoint derivado). A conclusão
// de uma atividade é feita no formulário da própria atividade
// (`/crm/atividades/:id/editar`), na página do recurso — nunca em modal.
//
// ZERO MODAL: a página inteira é lista + navegação. Concluir/cancelar aqui é
// um botão que grava status (mesma API do CRUD) e recarrega a agenda.
// ============================================================================
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { CalendarClock, CheckCircle2, Clock, AlertTriangle, Plus } from 'lucide-react';
import { api, ApiError } from '../lib/api';
import { Alert, Badge, ConfirmacaoInline, EmptyState, PageHeader, Spinner, useToast } from '../components/ui';

type Atividade = {
  id: number;
  tipo: string | null;
  resumo: string | null;
  prioridade: string;
  status: string;
  data_atividade: string | null;
  lembrete_em: string | null;
  dia: string | null;
  concluida_em: string | null;
  responsavel: string;
  lead: string | null;
  oportunidade: string | null;
  proxima_acao: string | null;
  vencida: boolean;
  hoje: boolean;
};

type Agenda = {
  hoje: Atividade[];
  atrasadas: Atividade[];
  proximas: Atividade[];
  concluidas: Atividade[];
  totais: { pendentes: number; hoje: number; atrasadas: number; concluidas: number };
};

const TIPO_LABEL: Record<string, string> = {
  chamada: 'Chamada',
  visita: 'Visita',
  email: 'E-mail',
  reuniao: 'Reunião',
  tarefa: 'Tarefa',
  follow_up: 'Follow-up',
};

const TOM_PRIORIDADE: Record<string, 'red' | 'amber' | 'blue' | 'slate'> = {
  urgente: 'red',
  alta: 'amber',
  media: 'blue',
  baixa: 'slate',
};

function quando(v: string | null): string {
  if (!v) return '—';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return String(v);
  return d.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export default function CrmAgendaPage() {
  const toast = useToast();
  const [dados, setDados] = useState<Agenda | null>(null);
  const [erro, setErro] = useState('');
  const [carregando, setCarregando] = useState(true);
  const [concluindo, setConcluindo] = useState<Atividade | null>(null);
  const [salvando, setSalvando] = useState(false);

  const carregar = useCallback(async () => {
    setCarregando(true);
    setErro('');
    try {
      setDados(await api.get<Agenda>('/crm/atividades/agenda'));
    } catch (e) {
      setErro(e instanceof ApiError ? e.message : 'Não foi possível carregar a agenda.');
    } finally {
      setCarregando(false);
    }
  }, []);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  async function concluir() {
    if (!concluindo) return;
    setSalvando(true);
    try {
      await api.put(`/crm_atividades/${concluindo.id}`, { status: 'concluida' });
      toast.success('Atividade concluída.');
      setConcluindo(null);
      await carregar();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Não foi possível concluir a atividade.');
    } finally {
      setSalvando(false);
    }
  }

  const grupos = useMemo(() => {
    if (!dados) return [];
    return [
      { id: 'atrasadas', titulo: 'Atrasadas', icone: <AlertTriangle className="h-4 w-4 text-red-600" />, lista: dados.atrasadas, vazio: 'Nada vencido. Agenda em dia.' },
      { id: 'hoje', titulo: 'Hoje', icone: <CalendarClock className="h-4 w-4 text-navy-700" />, lista: dados.hoje, vazio: 'Nenhum compromisso para hoje.' },
      { id: 'proximas', titulo: 'Próximas', icone: <Clock className="h-4 w-4 text-slate-500" />, lista: dados.proximas, vazio: 'Nenhum compromisso futuro registrado.' },
    ];
  }, [dados]);

  return (
    <div className="p-4 sm:p-6">
      <PageHeader
        title="Agenda do CRM"
        description="Compromissos por lembrete: o que venceu, o que é hoje e o que vem. A conclusão é registrada na própria atividade."
        actions={
          <>
            <button className="btn-secondary" onClick={() => void carregar()} disabled={carregando}>
              {carregando ? 'Atualizando...' : 'Atualizar'}
            </button>
            <Link className="btn-accent" to="/crm/atividades/novo">
              <Plus className="h-4 w-4" /> Nova atividade
            </Link>
          </>
        }
      />

      {erro && <Alert tone="red">{erro}</Alert>}
      {carregando && !dados && <Spinner label="Carregando agenda..." />}

      {dados && (
        <>
          <div className="mb-4 flex flex-wrap gap-2">
            <Badge tone={dados.totais.atrasadas > 0 ? 'red' : 'slate'}>{dados.totais.atrasadas} atrasada(s)</Badge>
            <Badge tone="blue">{dados.totais.hoje} para hoje</Badge>
            <Badge tone="slate">{dados.totais.pendentes} pendente(s)</Badge>
            <Badge tone="green">{dados.totais.concluidas} concluída(s)</Badge>
          </div>

          <div className="space-y-4">
            {grupos.map((g) => (
              <section key={g.id} className="card overflow-hidden">
                <header className="flex items-center gap-2 border-b border-slate-200 px-4 py-2.5 dark:border-navy-800">
                  {g.icone}
                  <h2 className="text-sm font-bold text-navy-900 dark:text-white">{g.titulo}</h2>
                  <span className="text-xs text-slate-400">({g.lista.length})</span>
                </header>
                {g.lista.length === 0 ? (
                  <div className="px-4 py-6">
                    <EmptyState title={g.vazio} description="Registre uma atividade para acompanhar o compromisso aqui." />
                  </div>
                ) : (
                  <ul className="divide-y divide-slate-100 dark:divide-navy-800">
                    {g.lista.map((a) => (
                      <li key={a.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-semibold text-navy-900 dark:text-white">
                            {TIPO_LABEL[a.tipo ?? ''] ?? a.tipo ?? 'Atividade'} — {a.resumo || `#${a.id}`}
                          </p>
                          <p className="mt-0.5 text-xs text-slate-500">
                            {quando(a.lembrete_em ?? a.data_atividade)} · {a.responsavel}
                            {a.lead ? ` · lead: ${a.lead}` : ''}
                            {a.oportunidade ? ` · oportunidade: ${a.oportunidade}` : ''}
                          </p>
                        </div>
                        <Badge tone={TOM_PRIORIDADE[a.prioridade] ?? 'slate'}>{a.prioridade}</Badge>
                        <Link className="btn-secondary !px-2.5 !py-1.5 text-xs" to={`/crm/atividades/${a.id}/editar`}>
                          Abrir
                        </Link>
                        <button className="btn-secondary !px-2.5 !py-1.5 text-xs" onClick={() => setConcluindo(a)}>
                          <CheckCircle2 className="h-3.5 w-3.5" /> Concluir
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            ))}
          </div>

          <ConfirmacaoInline
            open={!!concluindo}
            title="Concluir atividade?"
            message={
              <>
                <p>
                  <strong>{concluindo?.resumo || `Atividade #${concluindo?.id}`}</strong> será marcada como concluída com a data/hora atual.
                </p>
                <p className="mt-1 text-slate-500">A atividade continua no histórico — nada é apagado.</p>
              </>
            }
            confirmLabel="Concluir"
            busy={salvando}
            onConfirm={() => void concluir()}
            onCancel={() => !salvando && setConcluindo(null)}
          />
        </>
      )}
    </div>
  );
}
