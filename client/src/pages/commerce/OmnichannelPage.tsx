// ============================================================================
// COMMERCE & OMNICHANNEL (FASE 6) — PAINEL OPERACIONAL DE SINCRONIZAÇÃO.
// Rota /commerce/omnichannel.
//
// Uma tela para a operação comercial multicanal: divergências entre o ERP e o
// estado REGISTRADO de cada canal (catálogo, preço, estoque, pedidos, fila),
// com gravidade, ação recomendada e a saúde de cada conector. A reconciliação
// WooCommerce multi-loja (0101) aparece agrupada por loja.
//
// A tela NÃO inventa dado: tudo vem de /commerce/omnichannel/painel e da
// reconciliação real. Reconciliar é uma ação explícita (gerente+).
// ============================================================================
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, PlugZap, RefreshCw, ShieldAlert } from 'lucide-react';
import { apiFetch, ApiError } from '../../lib/api';
import { Alert, Badge, ConfirmacaoInline, EmptyState, PageHeader, Spinner, useToast } from '../../components/ui';
import { DataTable, FilterBar, type DataTableColumn } from '../../components/ui-kit-negocios';
import { useAuth } from '../../auth/AuthContext';
import { dataHora, rotuloCanal } from './shared';
import CanaisComerciaisPanel from './CanaisComerciaisPanel';

type Divergencia = {
  id: number;
  canal: string;
  store_key: string | null;
  categoria: string;
  tipo: string;
  classificacao: 'LEGITIMA' | 'AUTOMATICA' | 'HUMANA';
  severidade: 'baixa' | 'media' | 'alta' | 'critica';
  produto_id: number | null;
  sku: string | null;
  referencia: string | null;
  detalhe: string;
  acao_recomendada: string | null;
  detectada_em: string | null;
};

type SaudeConector = {
  canal: string;
  divergencias_abertas: number;
  pior_severidade: string | null;
  outbox_pendente: number;
  outbox_erro: number;
  ultimo_erro: string | null;
};

type Painel = {
  empresa_id: number;
  filtros: { canal: string | null; categoria: string | null; severidade: string | null };
  totais: { abertas: number; por_categoria: Record<string, number>; por_canal: Record<string, number>; por_severidade: Record<string, number> };
  divergencias: Divergencia[];
  woocommerce_lojas: { store_key: string; abertas: number; por_categoria: Record<string, number> }[];
  saude_conectores: SaudeConector[];
  gerado_em: string;
};

const ROTULO_CATEGORIA: Record<string, string> = {
  CATALOGO: 'Catálogo',
  PRECO: 'Preço',
  ESTOQUE: 'Estoque',
  PEDIDOS: 'Pedidos',
  CONECTOR: 'Conector / fila',
};

const TOM_SEVERIDADE: Record<string, 'slate' | 'blue' | 'amber' | 'red'> = {
  baixa: 'slate',
  media: 'blue',
  alta: 'amber',
  critica: 'red',
};

const TOM_CLASSIFICACAO: Record<string, 'slate' | 'amber' | 'red'> = {
  LEGITIMA: 'slate',
  AUTOMATICA: 'amber',
  HUMANA: 'red',
};

const ROTULO_CLASSIFICACAO: Record<string, string> = {
  LEGITIMA: 'Legítima',
  AUTOMATICA: 'Automática',
  HUMANA: 'Humana',
};

const ROTULO_LOJA: Record<string, string> = {
  RETAIL: 'Varejo (brobond.com.br)',
  WHOLESALE: 'Atacado (atacado.brobond.com.br)',
};

export default function CommerceOmnichannelPage() {
  const toast = useToast();
  const { user } = useAuth();
  const podeGerir = user?.perfil === 'gerente' || user?.perfil === 'admin';

  const [painel, setPainel] = useState<Painel | null>(null);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState('');
  const [canal, setCanal] = useState('');
  const [categoria, setCategoria] = useState('');
  const [severidade, setSeveridade] = useState('');
  const [reconciliando, setReconciliando] = useState(false);
  const [confirmar, setConfirmar] = useState(false);

  const carregar = useCallback(async () => {
    setCarregando(true);
    setErro('');
    const qs = new URLSearchParams();
    if (canal) qs.set('canal', canal);
    if (categoria) qs.set('categoria', categoria);
    if (severidade) qs.set('severidade', severidade);
    try {
      setPainel(await apiFetch<Painel>(`/commerce/omnichannel/painel${qs.size ? `?${qs}` : ''}`));
    } catch (e) {
      setErro(e instanceof ApiError ? e.message : 'Não foi possível carregar o painel omnichannel.');
    } finally {
      setCarregando(false);
    }
  }, [canal, categoria, severidade]);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  const reconciliar = async () => {
    setReconciliando(true);
    setErro('');
    try {
      const r = await apiFetch<{ detectadas: number; abertas: number; reabertas: number; fechadas: number }>('/commerce/omnichannel/reconciliar', { method: 'POST' });
      toast.success(`Reconciliação concluída: ${r.detectadas} divergência(s), ${r.fechadas} fechada(s).`);
      setConfirmar(false);
      await carregar();
    } catch (e) {
      setErro(e instanceof ApiError ? e.message : 'Falha ao reconciliar.');
    } finally {
      setReconciliando(false);
    }
  };

  const colunas: DataTableColumn<Divergencia>[] = [
    {
      key: 'canal',
      header: 'Canal',
      render: (d) => (
        <div className="flex flex-col">
          <span className="font-medium">{rotuloCanal(d.canal)}</span>
          {d.store_key && <span className="text-xs text-muted">{ROTULO_LOJA[d.store_key] ?? d.store_key}</span>}
        </div>
      ),
    },
    { key: 'categoria', header: 'Categoria', render: (d) => <Badge tone="slate">{ROTULO_CATEGORIA[d.categoria] ?? d.categoria}</Badge> },
    { key: 'tipo', header: 'Tipo', render: (d) => <span className="font-mono text-xs">{d.tipo}</span> },
    { key: 'severidade', header: 'Severidade', render: (d) => <Badge tone={TOM_SEVERIDADE[d.severidade] ?? 'slate'}>{d.severidade}</Badge> },
    { key: 'classificacao', header: 'Classificação', render: (d) => <Badge tone={TOM_CLASSIFICACAO[d.classificacao] ?? 'slate'}>{ROTULO_CLASSIFICACAO[d.classificacao] ?? d.classificacao}</Badge> },
    {
      key: 'referencia',
      header: 'Referência',
      render: (d) =>
        d.produto_id ? (
          <Link className="font-medium hover:underline" to={`/commerce/produtos/${d.produto_id}`}>
            {d.sku || `#${d.produto_id}`}
          </Link>
        ) : (
          <span className="font-medium">{d.referencia || '—'}</span>
        ),
    },
    {
      key: 'detalhe',
      header: 'Detalhe',
      render: (d) => (
        <div className="max-w-xl">
          <div className="text-sm">{d.detalhe}</div>
          {d.acao_recomendada && <div className="mt-1 text-xs text-muted">→ {d.acao_recomendada}</div>}
        </div>
      ),
    },
    { key: 'detectada_em', header: 'Detectada', render: (d) => <span className="text-sm text-muted">{dataHora(d.detectada_em)}</span> },
  ];

  const totais = painel?.totais;
  const divergencias = painel?.divergencias ?? [];

  return (
    <div className="space-y-4">
      <PageHeader
        title="Omnichannel"
        description="Operação comercial multicanal em uma tela: divergências entre o ERP e o estado registrado de cada canal, com gravidade, ação recomendada e saúde dos conectores. O ERP continua sendo a autoridade."
        actions={
          <div className="flex items-center gap-2">
            <button type="button" className="btn-ghost" onClick={() => void carregar()}>
              <RefreshCw className="h-4 w-4" aria-hidden="true" /> Atualizar
            </button>
            {podeGerir && (
              <button type="button" className="btn-primary" onClick={() => setConfirmar(true)} disabled={reconciliando}>
                <PlugZap className="h-4 w-4" aria-hidden="true" /> Reconciliar agora
              </button>
            )}
          </div>
        }
      />

      {erro && <Alert tone="red">{erro}</Alert>}

      {carregando ? (
        <Spinner label="Carregando painel omnichannel…" />
      ) : !painel ? (
        <EmptyState icon={<AlertTriangle className="h-6 w-6" aria-hidden="true" />} title="Painel indisponível" description="Não foi possível ler o painel." />
      ) : (
        <>
          {/* Cards de totais — números REAIS do registro. */}
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div className="rounded-xl border border-line bg-surface p-4">
              <div className="text-xs uppercase tracking-wide text-muted">Divergências abertas</div>
              <div className="mt-1 text-2xl font-semibold tabular-nums text-ink">{totais?.abertas ?? 0}</div>
            </div>
            {(['CATALOGO', 'PRECO', 'ESTOQUE', 'PEDIDOS'] as const).map((c) => (
              <div key={c} className="rounded-xl border border-line bg-surface p-4">
                <div className="text-xs uppercase tracking-wide text-muted">{ROTULO_CATEGORIA[c]}</div>
                <div className="mt-1 text-2xl font-semibold tabular-nums text-ink">{totais?.por_categoria?.[c] ?? 0}</div>
              </div>
            ))}
          </div>

          {/* Canais comerciais oficiais (Fase 9.4) — identidade e conexão REAIS. */}
          <CanaisComerciaisPanel />

          {/* Saúde por conector. */}
          <section className="rounded-xl border border-line bg-surface p-4">
            <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold">
              <ShieldAlert className="h-4 w-4" aria-hidden="true" /> Saúde dos conectores
            </h2>
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {painel.saude_conectores.map((s) => (
                <div key={s.canal} className="rounded-lg border border-line p-3">
                  <div className="flex items-center justify-between">
                    <span className="font-medium">{rotuloCanal(s.canal)}</span>
                    {s.pior_severidade ? <Badge tone={TOM_SEVERIDADE[s.pior_severidade] ?? 'slate'}>{s.pior_severidade}</Badge> : <Badge tone="green">ok</Badge>}
                  </div>
                  <div className="mt-2 text-xs text-muted">
                    {s.divergencias_abertas} divergência(s) aberta(s) · fila: {s.outbox_pendente} pendente(s), {s.outbox_erro} em erro
                  </div>
                  {s.ultimo_erro && <div className="mt-1 line-clamp-2 text-xs text-danger" title={s.ultimo_erro}>{s.ultimo_erro}</div>}
                </div>
              ))}
            </div>
          </section>

          {/* WooCommerce multi-loja (0101) agrupado por loja. */}
          {painel.woocommerce_lojas.length > 0 && (
            <section className="rounded-xl border border-line bg-surface p-4">
              <h2 className="mb-3 text-sm font-semibold">WooCommerce multi-loja — divergências por loja</h2>
              <div className="grid gap-2 sm:grid-cols-2">
                {painel.woocommerce_lojas.map((l) => (
                  <div key={l.store_key} className="rounded-lg border border-line p-3">
                    <div className="font-medium">{ROTULO_LOJA[l.store_key] ?? l.store_key}</div>
                    <div className="mt-1 text-xs text-muted">
                      {l.abertas} aberta(s) —{' '}
                      {Object.entries(l.por_categoria).map(([c, n]) => `${ROTULO_CATEGORIA[c] ?? c}: ${n}`).join(' · ')}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}

          <FilterBar
            actions={
              (canal || categoria || severidade) ? (
                <button type="button" className="btn-ghost" onClick={() => { setCanal(''); setCategoria(''); setSeveridade(''); }}>
                  Limpar filtros
                </button>
              ) : undefined
            }
          >
            <label className="text-xs text-muted">
              Canal
              <select className="input mt-1" value={canal} onChange={(e) => setCanal(e.target.value)}>
                <option value="">Todos</option>
                {['BROBOND', 'MERCADOLIVRE', 'NUVEMSHOP', 'WOOCOMMERCE', 'INSTAGRAM_SHOPPING', 'MERCADOPAGO'].map((c) => (
                  <option key={c} value={c}>{rotuloCanal(c)}</option>
                ))}
              </select>
            </label>
            <label className="text-xs text-muted">
              Categoria
              <select className="input mt-1" value={categoria} onChange={(e) => setCategoria(e.target.value)}>
                <option value="">Todas</option>
                {Object.keys(ROTULO_CATEGORIA).map((c) => (
                  <option key={c} value={c}>{ROTULO_CATEGORIA[c]}</option>
                ))}
              </select>
            </label>
            <label className="text-xs text-muted">
              Severidade
              <select className="input mt-1" value={severidade} onChange={(e) => setSeveridade(e.target.value)}>
                <option value="">Todas</option>
                {['baixa', 'media', 'alta', 'critica'].map((s) => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
            </label>
          </FilterBar>

          {divergencias.length === 0 ? (
            <EmptyState
              icon={<ShieldAlert className="h-6 w-6" aria-hidden="true" />}
              title="Sem divergências abertas"
              description="Nenhuma divergência para os filtros atuais. Rode a reconciliação para verificar o estado atual dos canais."
            />
          ) : (
            <DataTable
              caption="Divergências multicanal"
              columns={colunas}
              rows={divergencias}
              getRowKey={(d) => String(d.id)}
              empty="Nenhuma divergência."
            />
          )}

          <p className="text-xs text-muted">
            Painel gerado em {dataHora(painel.gerado_em)}. O ERP é a autoridade: nenhuma divergência sobrescreve preço, estoque, pedido ou catálogo automaticamente.
          </p>
        </>
      )}

      {confirmar && (
        <ConfirmacaoInline
          open
          title="Rodar a reconciliação multicanal?"
          message="O ERP compara o que ele tem com o estado registrado de cada canal e registra as divergências. Nada é sobrescrito automaticamente e nenhuma credencial externa é usada sem homologação."
          confirmLabel="Confirmar reconciliação"
          busy={reconciliando}
          onCancel={() => setConfirmar(false)}
          onConfirm={() => void reconciliar()}
        />
      )}
    </div>
  );
}
