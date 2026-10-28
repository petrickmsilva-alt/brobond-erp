// ============================================================================
// IMPRESSÃO — CONFIGURAR AGENTE em PÁGINA PRÓPRIA
// ----------------------------------------------------------------------------
// ZERO MODAL / ZERO PAINEL TRANSACIONAL: configurar um agente (nome e terminal
// vinculado) é edição de módulo e vive na rota
// `/config/impressao/agentes/:machineId/editar`.
//
// A identidade usada na API é o `machine_id` (string), não o id numérico: é o
// que o agente local apresenta no heartbeat. A página carrega a lista de
// agentes e encontra o registro; se não existir nesta empresa, diz isso.
// ============================================================================
import { useCallback, useEffect, useState } from 'react';
import { Loader2, Save, Wrench } from 'lucide-react';
import { useNavigate, useParams } from 'react-router-dom';
import { atualizarAgenteImpressao, listarAgentesImpressao, type AgenteRemotoCliente } from '../lib/printAgent';
import { Alert, Badge, PageHeader, Spinner, useToast } from '../components/ui';
import { useAuth } from '../auth/AuthContext';

function fmtDataHora(iso?: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleString('pt-BR');
}

export default function ImpressaoAgenteEdicaoPage() {
  const navigate = useNavigate();
  const toast = useToast();
  const { machineId } = useParams();
  const { user } = useAuth();
  const isGestor = user?.perfil === 'admin' || user?.perfil === 'gerente';

  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState('');
  const [agente, setAgente] = useState<AgenteRemotoCliente | null>(null);
  const [nome, setNome] = useState('');
  const [terminal, setTerminal] = useState('');
  const [salvando, setSalvando] = useState(false);

  const carregar = useCallback(async () => {
    setCarregando(true);
    setErro('');
    try {
      const d = await listarAgentesImpressao();
      const alvo = (d.rows || []).find((a) => String(a.machine_id) === String(machineId)) ?? null;
      if (!alvo) {
        setErro('Agente não encontrado nesta empresa.');
        return;
      }
      setAgente(alvo);
      setNome(alvo.nome);
      setTerminal(alvo.terminal || '');
    } catch (e) {
      setErro((e as Error).message || 'Não foi possível carregar o agente.');
    } finally {
      setCarregando(false);
    }
  }, [machineId]);

  useEffect(() => {
    if (isGestor) void carregar();
  }, [carregar, isGestor]);

  async function salvar() {
    if (!agente) return;
    setSalvando(true);
    setErro('');
    try {
      await atualizarAgenteImpressao(agente.machine_id, { nome, terminal: terminal || null });
      toast.success('Agente atualizado.');
      navigate('/config/impressao');
    } catch (e) {
      setErro((e as Error).message || 'Erro ao atualizar agente.');
    } finally {
      setSalvando(false);
    }
  }

  if (!isGestor) {
    return (
      <div className="space-y-4 p-4 sm:p-6">
        <PageHeader title="Configurar agente" description="Configuração de agentes de impressão." />
        <Alert tone="amber">Somente gerentes e administradores configuram agentes de impressão.</Alert>
        <button className="btn-secondary" onClick={() => navigate('/config/impressao')}>
          Voltar
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-4 p-4 sm:p-6">
      <PageHeader
        title={
          <span className="flex items-center gap-2.5">
            <Wrench className="h-5 w-5 text-navy-600" />
            Configurar agente
          </span>
        }
        description="O terminal vinculado define de qual fila o agente puxa impressão. Vazio = atende a fila geral da empresa."
        actions={
          <div className="flex gap-2">
            <button type="button" className="btn btn-secondary" onClick={() => navigate('/config/impressao')} disabled={salvando}>
              Cancelar
            </button>
            <button type="button" className="btn btn-primary" onClick={() => void salvar()} disabled={salvando || carregando || !agente}>
              {salvando ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              Salvar
            </button>
          </div>
        }
      />

      {carregando && <Spinner label="Carregando agente..." />}
      {erro && <Alert tone="red">{erro}</Alert>}

      {agente && !carregando && (
        <div className="card mx-auto max-w-2xl space-y-4 p-5">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <Badge tone={agente.status === 'revogado' ? 'red' : agente.online ? 'green' : 'amber'}>
              {agente.status === 'revogado' ? 'Revogado' : agente.online ? 'Online' : 'Offline'}
            </Badge>
            <span className="font-mono text-xs text-slate-500">{agente.machine_id}</span>
            <span className="text-xs text-slate-400">Último heartbeat: {fmtDataHora(agente.last_heartbeat_at)}</span>
          </div>

          <label className="label" htmlFor="agente-nome-edit">
            Nome do agente
            <input id="agente-nome-edit" type="text" className="input" value={nome} onChange={(e) => setNome(e.target.value)} />
          </label>
          <label className="label" htmlFor="agente-terminal-edit">
            Terminal vinculado (vazio = atende fila geral da empresa)
            <input
              id="agente-terminal-edit"
              type="text"
              className="input font-mono uppercase"
              value={terminal}
              onChange={(e) => setTerminal(e.target.value.toUpperCase())}
            />
          </label>
          <p className="text-xs text-slate-400">
            Credenciais e reimpressão auditada ficam na aba de impressão. Esta página altera apenas nome e terminal.
          </p>
        </div>
      )}
    </div>
  );
}
