// ============================================================================
// FASE 8 — ALERTAS (/alertas)
//
// Painel operacional do motor de alertas. Consome endpoints derivados:
//   GET  /api/alerts/painel        → ocorrências + totais + catálogo de detectores
//   POST /api/alerts/avaliar       → roda os detectores sobre dados canônicos
//   POST /api/alerts/:id/reconhecer|resolver|silenciar → transições auditadas
//
// A tela NÃO decide nada: severidade, deduplicação (fingerprint), janela
// anti-spam e silenciamento são do servidor. Alertar não é agir — nenhuma ação
// aqui altera estoque, preço, pedido, pagamento ou campanha.
// ============================================================================
import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, Bell, RefreshCw, ShieldAlert, Zap } from 'lucide-react';
import { api, ApiError } from '../lib/api';
import { Alert, Badge, EmptyState, PageHeader, Spinner, useToast } from '../components/ui';
import { DataTable, FilterBar, PageShell, StatCard, type DataTableColumn } from '../components/ui-kit-negocios';

type Ocorrencia = {
  id: number;
  regra_chave: string;
  dominio: string;
  severidade: string;
  titulo: string;
  detalhe: string;
  evidencia: Record<string, unknown>;
  status: string;
  ocorrencias: number;
  primeira_deteccao: string | null;
  ultima_deteccao: string | null;
  reconhecido_em: string | null;
  resolvido_em: string | null;
  silenciado_ate: string | null;
};

type Catalogo = { chave: string; nome: string; dominio: string; severidade: string; limiar: Record<string, number> };

type Painel = {
  totais: { abertos: number; cientes: number; resolvidos: number; silenciados: number; por_dominio: Record<string, number>; por_severidade: Record<string, number> };
  alertas: Ocorrencia[];
  catálogo: Catalogo[];
  gerado_em: string;
};

const DOMINIOS = ['estoque', 'vendas', 'financeiro', 'operacao', 'atendimento', 'marketing', 'integracoes'];
const SEVERIDADES = ['baixa', 'media', 'alta', 'critica'];
const STATUS = ['ABERTO', 'CIENTE', 'RESOLVIDO', 'SILENCIADO'];

const ROTULO_DOMINIO: Record<string, string> = {
  estoque: 'Estoque',
  vendas: 'Vendas',
  financeiro: 'Financeiro',
  operacao: 'Operação',
  atendimento: 'Atendimento',
  marketing: 'Marketing',
  integracoes: 'Integrações',
};

const TOM_SEVERIDADE: Record<string, 'green' | 'blue' | 'amber' | 'red' | 'slate'> = {
  baixa: 'slate',
  media: 'blue',
  alta: 'amber',
  critica: 'red',
};

const TOM_STATUS: Record<string, 'green' | 'red' | 'amber' | 'blue' | 'slate'> = {
  ABERTO: 'red',
  CIENTE: 'amber',
  RESOLVIDO: 'green',
  SILENCIADO: 'slate',
};

const dataHora = (iso: string | null) => (iso ? new Date(iso).toLocaleString('pt-BR') : '—');

export default function AlertasPage() {
  const toast = useToast();
  const [painel, setPainel] = useState<Painel | null>(null);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState('');
  const [dominio, setDominio] = useState('');
  const [severidade, setSeveridade] = useState('');
  const [status, setStatus] = useState('');
  const [avaliando, setAvaliando] = useState(false);
  const [acaoId, setAcaoId] = useState<number | null>(null);
  const [resolvendo, setResolvendo] = useState<Ocorrencia | null>(null);
  const [textoResolucao, setTextoResolucao] = useState('');
  const [silenciando, setSilenciando] = useState<Ocorrencia | null>(null);
  const [silenciarAte, setSilenciarAte] = useState('');

  const carregar = useCallback(async () => {
    setCarregando(true);
    setErro('');
    const qs = new URLSearchParams();
    if (dominio) qs.set('dominio', dominio);
    if (severidade) qs.set('severidade', severidade);
    if (status) qs.set('status', status);
    try {
      setPainel(await api.get<Painel>(`/alerts/painel${qs.size ? `?${qs}` : ''}`));
    } catch (e) {
      setErro(e instanceof ApiError ? e.message : 'Não foi possível carregar os alertas.');
    } finally {
      setCarregando(false);
    }
  }, [dominio, severidade, status]);

  useEffect(() => { void carregar(); }, [carregar]);

  const avaliar = async () => {
    setAvaliando(true);
    setErro('');
    try {
      const r = await api.post<{ detectadas: number; abertas: number; reabertas: number; resolvidas: number }>('/alerts/avaliar', {});
      toast.success(`Avaliação concluída: ${r.detectadas} ocorrência(s) detectada(s), ${r.resolvidas} resolvida(s).`);
      await carregar();
    } catch (e) {
      setErro(e instanceof ApiError ? e.message : 'Falha ao avaliar os alertas.');
    } finally {
      setAvaliando(false);
    }
  };

  const transicionar = async (a: Ocorrencia, acao: 'reconhecer' | 'resolver' | 'silenciar', body: Record<string, unknown>) => {
    setAcaoId(a.id);
    setErro('');
    try {
      await api.post(`/alerts/${a.id}/${acao}`, body);
      toast.success(acao === 'reconhecer' ? 'Alerta reconhecido.' : acao === 'resolver' ? 'Alerta resolvido.' : 'Alerta silenciado.');
      setResolvendo(null);
      setSilenciando(null);
      setTextoResolucao('');
      await carregar();
    } catch (e) {
      setErro(e instanceof ApiError ? e.message : 'Não foi possível atualizar o alerta.');
    } finally {
      setAcaoId(null);
    }
  };

  const colunas: DataTableColumn<Ocorrencia>[] = [
    {
      key: 'severidade',
      header: 'Severidade',
      render: (a) => <Badge tone={TOM_SEVERIDADE[a.severidade] ?? 'slate'}>{a.severidade}</Badge>,
    },
    { key: 'dominio', header: 'Domínio', render: (a) => <span className="text-sm">{ROTULO_DOMINIO[a.dominio] ?? a.dominio}</span> },
    {
      key: 'titulo',
      header: 'Alerta',
      render: (a) => (
        <div className="max-w-xl">
          <div className="font-medium">{a.titulo}</div>
          <div className="text-xs text-muted">{a.detalhe}</div>
        </div>
      ),
    },
    { key: 'detector', header: 'Detector', render: (a) => <span className="font-mono text-xs">{a.regra_chave}</span> },
    { key: 'status', header: 'Status', render: (a) => <Badge tone={TOM_STATUS[a.status] ?? 'slate'}>{a.status}</Badge> },
    { key: 'ocorrencias', header: 'Ocorrências', align: 'right', render: (a) => <span className="tabular-nums">{a.ocorrencias}</span> },
    { key: 'ultima', header: 'Última detecção', render: (a) => <span className="text-sm text-muted">{dataHora(a.ultima_deteccao)}</span> },
    {
      key: 'acoes',
      header: 'Ações',
      render: (a) => (
        <div className="flex flex-wrap gap-1">
          {a.status === 'ABERTO' && (
            <button type="button" className="btn-ghost text-xs" disabled={acaoId === a.id} onClick={() => void transicionar(a, 'reconhecer', {})}>
              Reconhecer
            </button>
          )}
          {a.status !== 'RESOLVIDO' && (
            <button type="button" className="btn-ghost text-xs" disabled={acaoId === a.id} onClick={() => { setResolvendo(a); setTextoResolucao(''); }}>
              Resolver
            </button>
          )}
          {a.status !== 'SILENCIADO' && (
            <button type="button" className="btn-ghost text-xs" disabled={acaoId === a.id} onClick={() => { setSilenciando(a); setSilenciarAte(''); }}>
              Silenciar
            </button>
          )}
        </div>
      ),
    },
  ];

  const totais = painel?.totais;
  const alertas = painel?.alertas ?? [];

  return (
    <PageShell>
      <PageHeader
        title="Alertas"
        description="Ocorrências detectadas por regras reais sobre os dados canônicos do ERP. Cada alerta traz severidade, evidência rastreável e histórico de reconhecimento, resolução e silenciamento. Alertar não é agir: nenhum alerta altera estoque, preço, pedido ou pagamento."
        actions={
          <div className="flex items-center gap-2">
            <button type="button" className="btn-ghost" onClick={() => void carregar()}>
              <RefreshCw className="h-4 w-4" aria-hidden="true" /> Atualizar
            </button>
            <button type="button" className="btn-primary" onClick={() => void avaliar()} disabled={avaliando}>
              <Zap className="h-4 w-4" aria-hidden="true" /> Avaliar agora
            </button>
          </div>
        }
      />

      {erro && <Alert tone="red">{erro}</Alert>}

      {carregando ? (
        <Spinner label="Carregando alertas…" />
      ) : !painel ? (
        <EmptyState icon={<AlertTriangle className="h-6 w-6" aria-hidden="true" />} title="Painel indisponível" description="Não foi possível ler os alertas." />
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard label="Abertos" value={String(totais?.abertos ?? 0)} icon={Bell} />
            <StatCard label="Cientes" value={String(totais?.cientes ?? 0)} icon={Bell} />
            <StatCard label="Resolvidos" value={String(totais?.resolvidos ?? 0)} icon={Bell} />
            <StatCard label="Silenciados" value={String(totais?.silenciados ?? 0)} icon={Bell} />
          </div>

          <section className="rounded-xl border border-line bg-surface p-4">
            <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold">
              <ShieldAlert className="h-4 w-4" aria-hidden="true" /> Detectores disponíveis ({painel.catálogo.length})
            </h2>
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {painel.catálogo.map((c) => (
                <div key={c.chave} className="rounded-lg border border-line p-3">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium">{c.nome}</span>
                    <Badge tone={TOM_SEVERIDADE[c.severidade] ?? 'slate'}>{c.severidade}</Badge>
                  </div>
                  <div className="mt-1 font-mono text-xs text-muted">{c.chave} · {ROTULO_DOMINIO[c.dominio] ?? c.dominio}</div>
                </div>
              ))}
            </div>
          </section>

          <FilterBar
            actions={
              (dominio || severidade || status) ? (
                <button type="button" className="btn-ghost" onClick={() => { setDominio(''); setSeveridade(''); setStatus(''); }}>
                  Limpar filtros
                </button>
              ) : undefined
            }
          >
            <label className="text-xs text-muted">
              Domínio
              <select className="input mt-1" value={dominio} onChange={(e) => setDominio(e.target.value)}>
                <option value="">Todos</option>
                {DOMINIOS.map((d) => <option key={d} value={d}>{ROTULO_DOMINIO[d] ?? d}</option>)}
              </select>
            </label>
            <label className="text-xs text-muted">
              Severidade
              <select className="input mt-1" value={severidade} onChange={(e) => setSeveridade(e.target.value)}>
                <option value="">Todas</option>
                {SEVERIDADES.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </label>
            <label className="text-xs text-muted">
              Status
              <select className="input mt-1" value={status} onChange={(e) => setStatus(e.target.value)}>
                <option value="">Todos</option>
                {STATUS.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </label>
          </FilterBar>

          {resolvendo && (
            <section className="rounded-xl border-2 border-navy-200 bg-navy-50/70 p-4 dark:border-navy-700 dark:bg-navy-900/40">
              <p className="text-sm font-bold">Resolver alerta</p>
              <p className="mt-1 text-sm text-slate-600 dark:text-navy-300">{resolvendo.titulo}</p>
              <textarea
                className="input mt-2 w-full"
                rows={2}
                placeholder="Descreva a resolução aplicada."
                value={textoResolucao}
                onChange={(e) => setTextoResolucao(e.target.value)}
              />
              <div className="mt-2 flex justify-end gap-2">
                <button type="button" className="btn-secondary" onClick={() => setResolvendo(null)} disabled={acaoId === resolvendo.id}>Cancelar</button>
                <button
                  type="button"
                  className="btn-primary"
                  disabled={acaoId === resolvendo.id || !textoResolucao.trim()}
                  onClick={() => void transicionar(resolvendo, 'resolver', { resolucao: textoResolucao })}
                >
                  Confirmar resolução
                </button>
              </div>
            </section>
          )}

          {silenciando && (
            <section className="rounded-xl border-2 border-navy-200 bg-navy-50/70 p-4 dark:border-navy-700 dark:bg-navy-900/40">
              <p className="text-sm font-bold">Silenciar alerta</p>
              <p className="mt-1 text-sm text-slate-600 dark:text-navy-300">{silenciando.titulo}</p>
              <label className="mt-2 block text-xs text-muted">
                Silenciar até
                <input type="datetime-local" className="input mt-1" value={silenciarAte} onChange={(e) => setSilenciarAte(e.target.value)} />
              </label>
              <div className="mt-2 flex justify-end gap-2">
                <button type="button" className="btn-secondary" onClick={() => setSilenciando(null)} disabled={acaoId === silenciando.id}>Cancelar</button>
                <button
                  type="button"
                  className="btn-primary"
                  disabled={acaoId === silenciando.id || !silenciarAte}
                  onClick={() => void transicionar(silenciando, 'silenciar', { silenciado_ate: new Date(silenciarAte).toISOString() })}
                >
                  Confirmar silenciamento
                </button>
              </div>
            </section>
          )}

          {alertas.length === 0 ? (
            <EmptyState
              icon={<Bell className="h-6 w-6" aria-hidden="true" />}
              title="Sem alertas"
              description="Nenhuma ocorrência para os filtros atuais. Rode a avaliação para verificar o estado atual."
            />
          ) : (
            <DataTable
              caption="Ocorrências de alerta"
              columns={colunas}
              rows={alertas}
              getRowKey={(a) => String(a.id)}
              empty="Nenhum alerta."
            />
          )}

          <p className="text-xs text-muted">
            Painel gerado em {dataHora(painel.gerado_em)}. A mesma ocorrência reabre quando volta a existir; a janela anti-spam evita avisos repetidos.
          </p>
        </>
      )}
    </PageShell>
  );
}
