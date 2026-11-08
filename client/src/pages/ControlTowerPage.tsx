// ============================================================================
// FASE 8 — AI CONTROL TOWER (/ai/control-tower)
//
// Camada de LEITURA executiva. Consome UM endpoint derivado
// (`GET /api/control-tower/painel`): indicadores, saúde operacional, alertas,
// previsões, recomendações e pendências críticas — tudo recortado por empresa
// no servidor. A tela NÃO calcula nada e NÃO executa operação: recomendar não
// é agir. Cada indicador mostra definição, fórmula e limitações conhecidas.
// ============================================================================
import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, Activity, Bell, Gauge, Lightbulb, RefreshCw, TrendingUp } from 'lucide-react';
import { api, ApiError } from '../lib/api';
import { Alert, Badge, EmptyState, PageHeader, Spinner } from '../components/ui';
import { DataTable, StatCard, type DataTableColumn } from '../components/ui-kit-negocios';

type Indicador = {
  chave: string;
  label: string;
  valor: number | null;
  unidade: 'moeda' | 'quantidade' | 'percentual' | 'dias';
  definicao: string;
  formula: string;
  origem: string[];
  limitacoes: string[];
};

type Recomendacao = {
  id: number;
  dominio: string;
  score: number;
  recomendacao: string;
  evidencia: Record<string, unknown>;
  status: string;
  criado_em: string | null;
  impacto_estimado: number | null;
  confianca: 'baixa' | 'media' | 'alta';
  requer_aprovacao: boolean;
};

type Tower = {
  empresa_id: number;
  periodo: { atual: string; anterior: string };
  indicadores: Indicador[];
  saude_operacional: {
    outbox_pendente: number;
    outbox_erro: number;
    pedidos_parados: number;
    tickets_abertos: number;
    tickets_sla_estourado: number;
    alertas_abertos: number;
    alertas_criticos: number;
  };
  alertas: {
    totais: { abertos: number; cientes: number; resolvidos: number; silenciados: number; por_dominio: Record<string, number>; por_severidade: Record<string, number> };
    criticos: Array<{ id: number; dominio: string; severidade: string; titulo: string; detalhe: string; evidencia: Record<string, unknown> }>;
  };
  previsoes: {
    demanda: Array<{ produto_id: number; produto: string | null; periodo: string; forecast: number; metodo: string }>;
    suprimento: Array<{ produto_id: number; produto: string | null; periodo: string; necessidade: number; status: string }>;
    acuracia: { periodos_avaliados: number; mae: number | null; mape_pct: number | null } | null;
    limitacoes: string[];
  };
  recomendacoes: { pendentes: Recomendacao[]; total_pendentes: number };
  pendencias_criticas: Array<{ origem: string; descricao: string; severidade: string; evidencia: Record<string, unknown> }>;
  limitacoes: string[];
  gerado_em: string;
};

const TOM_SEVERIDADE: Record<string, 'green' | 'blue' | 'amber' | 'red' | 'slate'> = {
  baixa: 'slate',
  media: 'blue',
  alta: 'amber',
  critica: 'red',
};

const TOM_CONFIANCA: Record<string, 'green' | 'blue' | 'amber' | 'slate'> = {
  alta: 'green',
  media: 'blue',
  baixa: 'slate',
};

const ROTULO_UNIDADE: Record<Indicador['unidade'], (v: number) => string> = {
  moeda: (v) => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(v),
  quantidade: (v) => new Intl.NumberFormat('pt-BR').format(v),
  percentual: (v) => `${v.toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 2 })}%`,
  dias: (v) => `${v.toLocaleString('pt-BR')} dia(s)`,
};

const moeda = ROTULO_UNIDADE.moeda;
const dataHora = (iso: string | null) => (iso ? new Date(iso).toLocaleString('pt-BR') : '—');

function formatarIndicador(i: Indicador): string {
  if (i.valor == null) return 'n/d';
  return ROTULO_UNIDADE[i.unidade](i.valor);
}

export default function ControlTowerPage() {
  const [dados, setDados] = useState<Tower | null>(null);
  const [erro, setErro] = useState('');
  const [carregando, setCarregando] = useState(true);

  const carregar = useCallback(() => {
    setCarregando(true);
    setErro('');
    api.get<Tower>('/control-tower/painel')
      .then(setDados)
      .catch((e: unknown) => setErro(e instanceof ApiError ? e.message : 'Não foi possível carregar a Control Tower.'))
      .finally(() => setCarregando(false));
  }, []);

  useEffect(() => { void carregar(); }, [carregar]);

  const colunasIndicadores: DataTableColumn<Indicador>[] = [
    { key: 'label', header: 'Indicador', render: (i) => <span className="font-medium">{i.label}</span> },
    { key: 'valor', header: 'Valor', align: 'right', render: (i) => <span className="tabular-nums font-semibold">{formatarIndicador(i)}</span> },
    { key: 'definicao', header: 'Definição', render: (i) => <span className="text-xs text-muted">{i.definicao}</span> },
    {
      key: 'origem',
      header: 'Origem',
      render: (i) => (
        <div className="flex flex-wrap gap-1">
          {i.origem.map((o) => <Badge key={o} tone="slate">{o}</Badge>)}
        </div>
      ),
    },
    {
      key: 'limitacoes',
      header: 'Limitações',
      render: (i) =>
        i.limitacoes.length === 0 ? (
          <span className="text-xs text-muted">—</span>
        ) : (
          <ul className="list-disc pl-4 text-xs text-muted">
            {i.limitacoes.map((l) => <li key={l}>{l}</li>)}
          </ul>
        ),
    },
  ];

  const colunasRecomendacoes: DataTableColumn<Recomendacao>[] = [
    { key: 'dominio', header: 'Domínio', render: (r) => <Badge tone="slate">{r.dominio}</Badge> },
    { key: 'recomendacao', header: 'Recomendação', render: (r) => <span className="text-sm">{r.recomendacao}</span> },
    { key: 'score', header: 'Score', align: 'right', render: (r) => <span className="tabular-nums">{r.score.toFixed(2)}</span> },
    { key: 'confianca', header: 'Confiança', render: (r) => <Badge tone={TOM_CONFIANCA[r.confianca] ?? 'slate'}>{r.confianca}</Badge> },
    {
      key: 'impacto',
      header: 'Impacto estimado',
      align: 'right',
      render: (r) => <span className="tabular-nums">{r.impacto_estimado == null ? '—' : moeda(r.impacto_estimado)}</span>,
    },
    {
      key: 'aprovacao',
      header: 'Aprovação',
      render: (r) => (r.requer_aprovacao ? <Badge tone="amber">exige humana</Badge> : <Badge tone="green">automática</Badge>),
    },
  ];

  return (
    <div className="min-w-0 space-y-4">
      <PageHeader
        title="Control Tower"
        description="Leitura executiva consolidada: indicadores com definição e fórmula, saúde operacional, alertas, previsões, recomendações rastreáveis e pendências críticas. O ERP continua sendo a autoridade — a Tower lê e recomenda, não executa."
        actions={
          <button type="button" className="btn-ghost" onClick={() => void carregar()}>
            <RefreshCw className="h-4 w-4" aria-hidden="true" /> Atualizar
          </button>
        }
      />

      {erro && <Alert tone="red">{erro}</Alert>}

      {carregando ? (
        <Spinner label="Consolidando a Control Tower…" />
      ) : !dados ? (
        <EmptyState icon={<AlertTriangle className="h-6 w-6" aria-hidden="true" />} title="Tower indisponível" description="Não foi possível ler os indicadores." />
      ) : (
        <>
          {/* Saúde operacional — números REAIS do ERP. */}
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard label="Alertas abertos" value={String(dados.saude_operacional.alertas_abertos)} hint={`${dados.saude_operacional.alertas_criticos} crítico(s)/alto(s)`} icon={Bell} />
            <StatCard label="Fila (outbox) pendente" value={String(dados.saude_operacional.outbox_pendente)} hint={`${dados.saude_operacional.outbox_erro} em erro`} icon={Activity} />
            <StatCard label="Pedidos parados (>24h)" value={String(dados.saude_operacional.pedidos_parados)} icon={AlertTriangle} />
            <StatCard label="SLA de atendimento estourado" value={String(dados.saude_operacional.tickets_sla_estourado)} hint={`${dados.saude_operacional.tickets_abertos} ticket(s) aberto(s)`} icon={Gauge} />
          </div>

          {/* Pendências críticas — consolidação rastreável. */}
          <section className="rounded-xl border border-line bg-surface p-4">
            <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold">
              <AlertTriangle className="h-4 w-4" aria-hidden="true" /> Pendências críticas
            </h2>
            {dados.pendencias_criticas.length === 0 ? (
              <p className="text-sm text-muted">Nenhuma pendência crítica identificada nos dados atuais.</p>
            ) : (
              <ul className="space-y-2">
                {dados.pendencias_criticas.map((p, idx) => (
                  <li key={`${p.origem}-${idx}`} className="flex items-start justify-between gap-3 rounded-lg border border-line p-3">
                    <div className="min-w-0">
                      <div className="text-sm font-medium">{p.descricao}</div>
                      <div className="mt-0.5 text-xs text-muted">Origem: {p.origem}</div>
                    </div>
                    <Badge tone={TOM_SEVERIDADE[p.severidade] ?? 'slate'}>{p.severidade}</Badge>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {/* Indicadores executivos com definição/fórmula/limitações. */}
          <section className="rounded-xl border border-line bg-surface p-4">
            <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold">
              <TrendingUp className="h-4 w-4" aria-hidden="true" /> Indicadores ({dados.periodo.atual})
            </h2>
            <DataTable
              caption="Indicadores executivos com definição, origem e limitações"
              columns={colunasIndicadores}
              rows={dados.indicadores}
              getRowKey={(i) => i.chave}
              empty="Nenhum indicador disponível."
            />
          </section>

          {/* Previsões — com limitações explícitas. */}
          <section className="rounded-xl border border-line bg-surface p-4">
            <h2 className="mb-3 text-sm font-semibold">Previsões</h2>
            {dados.previsoes.acuracia ? (
              <p className="mb-3 text-xs text-muted">
                Acurácia observada em {dados.previsoes.acuracia.periodos_avaliados} período(s): MAE {dados.previsoes.acuracia.mae ?? '—'} · MAPE {dados.previsoes.acuracia.mape_pct ?? '—'}%.
              </p>
            ) : (
              <p className="mb-3 text-xs text-muted">Sem previsão de período fechado para medir acurácia.</p>
            )}
            <div className="grid gap-4 lg:grid-cols-2">
              <div>
                <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">Demanda (top)</h3>
                {dados.previsoes.demanda.length === 0 ? (
                  <p className="text-sm text-muted">Nenhuma previsão materializada.</p>
                ) : (
                  <ul className="space-y-1 text-sm">
                    {dados.previsoes.demanda.map((d) => (
                      <li key={`${d.produto_id}-${d.periodo}`} className="flex justify-between gap-2">
                        <span className="truncate">{d.produto ?? `#${d.produto_id}`} · {d.periodo}</span>
                        <span className="tabular-nums text-muted">{d.forecast} ({d.metodo})</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <div>
                <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">Necessidade de suprimento (top)</h3>
                {dados.previsoes.suprimento.length === 0 ? (
                  <p className="text-sm text-muted">Nenhum plano de suprimento materializado.</p>
                ) : (
                  <ul className="space-y-1 text-sm">
                    {dados.previsoes.suprimento.map((p) => (
                      <li key={`${p.produto_id}-${p.periodo}`} className="flex justify-between gap-2">
                        <span className="truncate">{p.produto ?? `#${p.produto_id}`} · {p.periodo}</span>
                        <span className="tabular-nums text-muted">{p.necessidade} ({p.status})</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
            <ul className="mt-3 list-disc pl-4 text-xs text-muted">
              {dados.previsoes.limitacoes.map((l) => <li key={l}>{l}</li>)}
            </ul>
          </section>

          {/* Recomendações — rastreáveis, exigem decisão humana. */}
          <section className="rounded-xl border border-line bg-surface p-4">
            <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold">
              <Lightbulb className="h-4 w-4" aria-hidden="true" /> Recomendações pendentes ({dados.recomendacoes.total_pendentes})
            </h2>
            <DataTable
              caption="Recomendações pendentes com score, evidência e confiança"
              columns={colunasRecomendacoes}
              rows={dados.recomendacoes.pendentes}
              getRowKey={(r) => String(r.id)}
              empty="Nenhuma recomendação pendente."
            />
            <p className="mt-2 text-xs text-muted">Nenhuma recomendação executa operação: alterar preço, estoque, pagamento ou campanha exige aprovação humana registrada.</p>
          </section>

          {/* Alertas críticos. */}
          <section className="rounded-xl border border-line bg-surface p-4">
            <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold">
              <Bell className="h-4 w-4" aria-hidden="true" /> Alertas críticos e altos
            </h2>
            {dados.alertas.criticos.length === 0 ? (
              <p className="text-sm text-muted">Nenhum alerta crítico ou alto em aberto.</p>
            ) : (
              <ul className="space-y-2">
                {dados.alertas.criticos.map((a) => (
                  <li key={a.id} className="flex items-start justify-between gap-3 rounded-lg border border-line p-3">
                    <div className="min-w-0">
                      <div className="text-sm font-medium">{a.titulo}</div>
                      <div className="mt-0.5 text-xs text-muted">{a.detalhe}</div>
                    </div>
                    <Badge tone={TOM_SEVERIDADE[a.severidade] ?? 'slate'}>{a.severidade}</Badge>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="rounded-xl border border-line bg-surface p-4">
            <h2 className="mb-2 text-sm font-semibold">Limitações conhecidas</h2>
            <ul className="list-disc pl-4 text-xs text-muted">
              {dados.limitacoes.map((l) => <li key={l}>{l}</li>)}
            </ul>
            <p className="mt-2 text-xs text-muted">Gerado em {dataHora(dados.gerado_em)}.</p>
          </section>
        </>
      )}
    </div>
  );
}
