// ============================================================================
// CONTAGEM CÍCLICA ABC — CAPACIDADE PróPRIA (Árvore Master)
// ----------------------------------------------------------------------------
// Superfície dedicada da capacidade operacional "Contagem Cíclica ABC", sob
// Estoque & Suprimentos → Estoque. Ela não duplica inventário, saldo nem
// motor: reutiliza o backend canônico do PR #94
// (`server/src/contagemCiclica.ts`) e a visualização compartilhada
// (`components/contagemCiclica.tsx`), que também serve a `InventarioModulePage`.
//
// Padrão UX: LISTA → DETALHE, sem modal. O planejamento de um novo plano é um
// bloco inline da própria página (nunca sobreposto à lista).
// ============================================================================
import { useCallback, useEffect, useState } from 'react';
import { ArrowRight, ClipboardList, Plus, RefreshCw, Search } from 'lucide-react';
import { api } from '../lib/api';
import { useAuth } from '../auth/AuthContext';
import { Alert, Badge, PageHeader, Spinner, useToast } from '../components/ui';
import { formatDateTime } from '../lib/format';
import { ContagemCiclicaView, PlanejarCiclicoPanel, podePlanejar, type Inv } from '../components/contagemCiclica';

export default function ContagemCiclicaPage() {
  const { user } = useAuth();
  const toast = useToast();
  const podePlanejarAcao = podePlanejar(user?.perfil);

  const [lista, setLista] = useState<Inv[] | null>(null);
  const [aberto, setAberto] = useState<Inv | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [q, setQ] = useState('');
  const [locais, setLocais] = useState<{ value: number; label: string }[]>([]);
  const [planejarOpen, setPlanejarOpen] = useState(false);

  const carregar = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const d = await api.get<Inv[]>('/inventarios/ciclicas');
      setLista(d);
    } catch (e: any) {
      setError(e.message || 'Erro ao carregar os planos cíclicos.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    carregar();
    api
      .get<{ value: number; label: string }[]>('/locais/options')
      .then(setLocais)
      .catch(() => {});
  }, [carregar]);

  async function abrir(id: number) {
    setLoading(true);
    setError('');
    try {
      const inv = await api.get<Inv>(`/inventarios/${id}`);
      setAberto(inv);
    } catch (e: any) {
      setError(e.message || 'Erro ao carregar o plano.');
    } finally {
      setLoading(false);
    }
  }

  const visiveis = (() => {
    if (!lista) return [];
    const term = q.trim().toLowerCase();
    if (!term) return lista;
    return lista.filter(
      (inv) =>
        String(inv.local_id__label || inv.local || '').toLowerCase().includes(term) ||
        String(inv.classificacao_abc || '').toLowerCase().includes(term) ||
        String(inv.contagem_status || '').toLowerCase().includes(term)
    );
  })();

  if (aberto) return <ContagemCiclicaView inventario={aberto} onBack={() => { setAberto(null); carregar(); }} />;

  return (
    <div className="p-4 pb-24 sm:p-6 md:pb-6">
      <PageHeader
        title={
          <span className="flex items-center gap-2.5">
            <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-navy-800 text-white">
              <ClipboardList className="h-5 w-5" />
            </span>
            Contagem Cíclica ABC
          </span>
        }
        description="Classificação determinística de itens por saídas reais no período e contagem rotativa por classe. A classe é calculada no servidor; o saldo é snapshot imutável e os ajustes só ocorrem após conferência e aprovação."
        actions={
          <>
            <button className="btn-secondary" onClick={carregar} disabled={loading}>
              <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} /> Atualizar
            </button>
            {podePlanejarAcao && (
              <button className="btn-accent" onClick={() => setPlanejarOpen((v) => !v)}>
                <Plus className="h-4 w-4" /> Planejar novo plano
              </button>
            )}
          </>
        }
      />

      {!podePlanejarAcao && (
        <Alert tone="blue">
          Você pode acompanhar os planos cíclicos, mas <strong>planejar</strong> um novo plano exige perfil de gerente ou administrador.
        </Alert>
      )}

      {error && <Alert tone="red">{error}</Alert>}
      {!lista && !error && <Spinner />}

      {lista && lista.length === 0 && !error && (
        <div className="card p-10 text-center text-sm text-slate-400">
          <ClipboardList className="mx-auto mb-3 h-8 w-8 text-slate-300" />
          Nenhum plano cíclico ainda.{' '}
          {podePlanejarAcao ? 'Clique em “Planejar novo plano” para classificar os itens por saída.' : 'Solicite a criação de um plano a um gerente.'}
        </div>
      )}

      {lista && lista.length > 0 && (
        <>
          <div className="mb-3">
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
              <input className="input pl-9" placeholder="Buscar local, classe ou estado..." value={q} onChange={(e) => setQ(e.target.value)} />
            </div>
          </div>
          <div className="card overflow-hidden">
            <table className="table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Local</th>
                  <th>Classe</th>
                  <th>Período ABC</th>
                  <th>Estado</th>
                  <th>Planejado</th>
                  <th className="text-right">Ações</th>
                </tr>
              </thead>
              <tbody>
                {visiveis.map((inv) => (
                  <tr key={inv.id}>
                    <td className="font-mono text-xs text-slate-400">#{inv.id}</td>
                    <td className="font-medium text-slate-800">{inv.local_id__label || inv.local}</td>
                    <td><span className="text-xs font-medium">{inv.classificacao_abc || '—'}</span></td>
                    <td className="text-xs text-slate-500">{inv.abc_periodo_inicio} a {inv.abc_periodo_fim}</td>
                    <td>{inv.contagem_status === 'CANCELADA' ? <Badge tone="red">Cancelada</Badge> : inv.status === 'fechado' ? <Badge tone="green">Fechado</Badge> : <Badge tone="amber">{inv.contagem_status || 'Em contagem'}</Badge>}</td>
                    <td className="text-xs text-slate-500">{inv.data_planejada ? formatDateTime(inv.data_planejada) : '—'}</td>
                    <td className="text-right">
                      <button className="btn-secondary !py-1.5 text-xs" onClick={() => abrir(inv.id)}>
                        {inv.status === 'aberto' ? 'Continuar contagem' : 'Ver resultado'} <ArrowRight className="h-3.5 w-3.5" />
                      </button>
                    </td>
                  </tr>
                ))}
                {visiveis.length === 0 && (
                  <tr>
                    <td colSpan={7} className="p-8 text-center text-sm text-slate-400">Nenhuma linha neste filtro.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}

      <PlanejarCiclicoPanel
        open={planejarOpen}
        onClose={() => setPlanejarOpen(false)}
        locais={locais}
        onCriado={(inv) => { toast.success(`Plano #${inv.id} criado.`); void carregar(); abrir(inv.id); }}
      />
    </div>
  );
}
