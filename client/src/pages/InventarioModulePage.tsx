import { useCallback, useEffect, useState } from 'react';
import { ArrowRight, ClipboardCheck, ClipboardList, Loader2, Plus, RefreshCw } from 'lucide-react';
import { api } from '../lib/api';
import { useAuth } from '../auth/AuthContext';
import { Alert, Badge, PageHeader, Spinner, useToast } from '../components/ui';
import { formatDateTime } from '../lib/format';
import { ContagemCiclicaView, PlanejarCiclicoPanel, podePlanejar, type Inv } from '../components/contagemCiclica';

export default function InventarioModulePage() {
  const { user } = useAuth();
  const toast = useToast();
  const podeFechar = podePlanejar(user?.perfil);

  const [lista, setLista] = useState<Inv[] | null>(null);
  const [aberto, setAberto] = useState<Inv | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [novoOpen, setNovoOpen] = useState(false);
  const [locais, setLocais] = useState<{ value: number; label: string }[]>([]);
  const [novo, setNovo] = useState({ local_id: '', observacoes: '' });
  const [criando, setCriando] = useState(false);
  const [cicloOpen, setCicloOpen] = useState(false);

  const carregarLista = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const d = await api.get<{ rows: Inv[] }>('/inventarios?pageSize=100&sort=id&dir=desc');
      setLista(d.rows);
    } catch (e: any) {
      setError(e.message || 'Erro ao carregar inventários.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    carregarLista();
    api
      .get<{ value: number; label: string }[]>('/locais/options')
      .then(setLocais)
      .catch(() => {});
  }, [carregarLista]);

  async function abrirNovo() {
    if (!novo.local_id) return toast.error('Selecione o local da contagem.');
    setCriando(true);
    try {
      const criado = await api.post<Inv>('/inventarios', { local_id: Number(novo.local_id), observacoes: novo.observacoes || null });
      toast.success(`Inventário #${criado.id} aberto em “${criado.local || novo.local_id}”. Registre as contagens.`);
      setNovoOpen(false);
      setNovo({ local_id: '', observacoes: '' });
      await carregarLista();
      await abrirDetalhe(criado.id);
    } catch (e: any) {
      toast.error(e.message || 'Não foi possível abrir o inventário.');
    } finally {
      setCriando(false);
    }
  }

  const abrirDetalhe = useCallback(async (id: number) => {
    setLoading(true);
    setError('');
    try {
      const inv = await api.get<Inv>(`/inventarios/${id}`);
      setAberto(inv);
    } catch (e: any) {
      setError(e.message || 'Erro ao carregar o inventário.');
    } finally {
      setLoading(false);
    }
  }, []);

  if (aberto) return <ContagemCiclicaView inventario={aberto} onBack={() => { setAberto(null); carregarLista(); }} />;

  return (
    <div className="p-4 pb-24 sm:p-6 md:pb-6">
      <PageHeader
        title={
          <span className="flex items-center gap-2.5">
            <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-navy-800 text-white">
              <ClipboardCheck className="h-5 w-5" />
            </span>
            Inventário
          </span>
        }
        description="Contagem física por local. Ao fechar, o sistema gera os ajustes de estoque automaticamente (uma única vez)."
        actions={
          <>
            <button className="btn-secondary" onClick={carregarLista} disabled={loading}>
              <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} /> Atualizar
            </button>
            <button className="btn-accent" onClick={() => setNovoOpen(true)}>
              <Plus className="h-4 w-4" /> Abrir contagem
            </button>
            {podeFechar && <button className="btn-secondary" onClick={() => setCicloOpen((v) => !v)}><ClipboardList className="h-4 w-4" /> Planejar ciclo ABC</button>}
          </>
        }
      />

      {error && <Alert tone="red">{error}</Alert>}
      {!lista && !error && <Spinner />}

      {lista && lista.length === 0 && !error && (
        <div className="card p-10 text-center text-sm text-slate-400">
          <ClipboardList className="mx-auto mb-3 h-8 w-8 text-slate-300" />
          Nenhuma contagem ainda. Clique em “Abrir contagem”, escolha o local e registre as quantidades contadas.
        </div>
      )}

      {lista && lista.length > 0 && (
        <div className="card overflow-hidden">
          <table className="table">
            <thead>
              <tr>
                <th>#</th>
                <th>Local</th>
                <th>Tipo / classe</th>
                <th>Estado</th>
                <th>Aberto</th>
                <th>Fechado</th>
                <th className="text-right">Ações</th>
              </tr>
            </thead>
            <tbody>
              {lista.map((inv) => (
                <tr key={inv.id}>
                  <td className="font-mono text-xs text-slate-400">#{inv.id}</td>
                  <td className="font-medium text-slate-800">{inv.local_id__label || inv.local}</td>
                  <td>{inv.modalidade === 'ciclica_abc' ? <span className="text-xs font-medium">Cíclica ABC · {inv.classificacao_abc || '—'}</span> : <span className="text-xs">Inventário</span>}</td>
                  <td>{inv.contagem_status === 'CANCELADA' ? <Badge tone="red">Cancelada</Badge> : inv.status === 'fechado' ? <Badge tone="green">Fechado</Badge> : <Badge tone="amber">{inv.contagem_status || 'Em contagem'}</Badge>}</td>
                  <td className="text-slate-500">{formatDateTime(inv.aberto_em)}</td>
                  <td className="text-slate-500">{inv.fechado_em ? formatDateTime(inv.fechado_em) : '—'}</td>
                  <td className="text-right">
                    <button className="btn-secondary !py-1.5 text-xs" onClick={() => abrirDetalhe(inv.id)}>
                      {inv.status === 'aberto' ? 'Continuar contagem' : 'Ver resultado'} <ArrowRight className="h-3.5 w-3.5" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {novoOpen && <section className="card mb-4 p-5"><h2 className="text-base font-semibold text-navy-900">Abrir contagem simples</h2><p className="mb-4 mt-1 text-sm text-slate-500">O saldo do sistema é congelado neste momento (snapshot).</p>
        <div className="space-y-4">
          <label className="block">
            <span className="label">Local</span>
            <select className="input" value={novo.local_id} onChange={(e) => setNovo((n) => ({ ...n, local_id: e.target.value }))}>
              <option value="">Selecione o local...</option>
              {locais.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="label">Observações (opcional)</span>
            <textarea className="input" rows={2} value={novo.observacoes} onChange={(e) => setNovo((n) => ({ ...n, observacoes: e.target.value }))} />
          </label>
          <Alert tone="blue">Somente gerentes e administradores podem fechar a contagem e gerar os ajustes.</Alert>
          <div className="flex justify-end gap-2">
            <button className="btn-secondary" onClick={() => setNovoOpen(false)}>Cancelar</button>
            <button className="btn-primary" onClick={abrirNovo} disabled={criando}>
              {criando && <Loader2 className="h-4 w-4 animate-spin" />} Abrir e congelar saldos
            </button>
          </div>
        </div>
      </section>}

      {/* Planejamento cíclico ABC — bloco inline da própria página (nunca modal).
          Reutiliza o painel canônico usado pela página própria da capacidade. */}
      <PlanejarCiclicoPanel
        open={cicloOpen}
        onClose={() => setCicloOpen(false)}
        locais={locais}
        onCriado={() => { void carregarLista(); }}
      />

      {!aberto && (
        <button className="btn-accent fixed bottom-5 right-5 z-40 rounded-full px-4 py-3.5 shadow-modal md:hidden" onClick={() => setNovoOpen(true)} aria-label="Abrir contagem">
          <Plus className="h-5 w-5" />
        </button>
      )}
    </div>
  );
}
