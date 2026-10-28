// ============================================================================
// IMPRESSÃO — PAREAR NOVO AGENTE LOCAL em PÁGINA PRÓPRIA
// ----------------------------------------------------------------------------
// ZERO MODAL / ZERO PAINEL TRANSACIONAL: gerar o código de pareamento é um
// fluxo operacional do módulo, então é uma rota (`/config/impressao/agentes/novo`).
//
// Exceção de UX preservada e explícita: o CÓDIGO é um segredo de uso único.
// Ele aparece UMA vez, nesta página, com validade de 10 minutos — não é
// recuperável depois (o servidor guarda apenas o hash).
// ============================================================================
import { useState } from 'react';
import { KeyRound, Loader2, ShieldCheck } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { gerarCodigoPareamentoAgente, getPreferredTerminal } from '../lib/printAgent';
import { Alert, PageHeader, useToast } from '../components/ui';
import { useAuth } from '../auth/AuthContext';

function fmtDataHora(iso?: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleString('pt-BR');
}

export default function ImpressaoAgenteNovaPage() {
  const navigate = useNavigate();
  const toast = useToast();
  const { user } = useAuth();
  const isGestor = user?.perfil === 'admin' || user?.perfil === 'gerente';

  const [nome, setNome] = useState('');
  const [terminal, setTerminal] = useState(() => getPreferredTerminal());
  const [codigo, setCodigo] = useState<{ codigo: string; expiresAt?: string } | null>(null);
  const [erro, setErro] = useState('');
  const [gerando, setGerando] = useState(false);

  async function gerar() {
    setGerando(true);
    setErro('');
    try {
      const out = await gerarCodigoPareamentoAgente({
        nome: nome || undefined,
        terminal: terminal || undefined,
      });
      setCodigo({ codigo: out.codigo, expiresAt: out.expires_at });
    } catch (e) {
      const msg = (e as Error).message || 'Erro ao gerar código.';
      setErro(msg);
      toast.error(msg);
    } finally {
      setGerando(false);
    }
  }

  if (!isGestor) {
    return (
      <div className="space-y-4 p-4 sm:p-6">
        <PageHeader title="Parear novo agente local" description="Pareamento de máquinas de impressão." />
        <Alert tone="amber">Somente gerentes e administradores pareiam agentes de impressão.</Alert>
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
            <ShieldCheck className="h-5 w-5 text-navy-600" />
            Parear novo agente local
          </span>
        }
        description="Código temporário de uso único (expira em 10 minutos). Ele é exibido apenas uma vez."
        actions={
          <div className="flex gap-2">
            <button type="button" className="btn btn-secondary" onClick={() => navigate('/config/impressao')}>
              Voltar
            </button>
            {!codigo && (
              <button type="button" className="btn btn-primary" onClick={() => void gerar()} disabled={gerando}>
                {gerando ? <Loader2 className="h-4 w-4 animate-spin" /> : <KeyRound className="h-4 w-4" />}
                Gerar código
              </button>
            )}
          </div>
        }
      />

      {erro && <Alert tone="red">{erro}</Alert>}

      <div className="card mx-auto max-w-2xl space-y-4 p-5">
        {!codigo ? (
          <>
            <label className="label" htmlFor="agente-nome">
              Nome sugerido da máquina
              <input
                id="agente-nome"
                type="text"
                className="input"
                placeholder="Ex.: PC Caixa 01"
                value={nome}
                onChange={(e) => setNome(e.target.value)}
              />
            </label>
            <label className="label" htmlFor="agente-terminal">
              Terminal (opcional)
              <input
                id="agente-terminal"
                type="text"
                className="input font-mono uppercase"
                placeholder="Ex.: CAIXA-1"
                value={terminal}
                onChange={(e) => setTerminal(e.target.value.toUpperCase())}
              />
            </label>
            <p className="text-xs text-slate-400">
              O código vale por 10 minutos e só pode ser usado uma vez. Quem parear a máquina recebe a credencial do agente.
            </p>
          </>
        ) : (
          <div className="space-y-3 text-center">
            <div className="rounded-xl border-2 border-dashed border-brand-400 bg-brand-50/40 p-4 font-mono text-2xl font-bold tracking-widest text-navy-900 dark:bg-navy-800 dark:text-white">
              {codigo.codigo}
            </div>
            <p className="text-xs text-slate-600 dark:text-navy-300">
              Execute na máquina local:{' '}
              <code className="rounded bg-slate-100 px-1.5 py-0.5 dark:bg-navy-800">brobond-print-agent --pair {codigo.codigo}</code>
            </p>
            <p className="text-[11px] text-amber-700">Válido até {fmtDataHora(codigo.expiresAt)} (exibido apenas uma vez).</p>
            <div className="flex justify-center gap-2">
              <button type="button" className="btn-secondary" onClick={() => setCodigo(null)}>
                Gerar outro código
              </button>
              <button type="button" className="btn-primary" onClick={() => navigate('/config/impressao')}>
                Concluir
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
