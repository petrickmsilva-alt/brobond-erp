// ============================================================================
// PAINEL DO CRM — dashboard comercial (módulo /crm/painel)
//
// Consome EXATAMENTE um endpoint derivado (`GET /api/crm/painel`): leads,
// pipeline por etapa, forecast ponderado, conversão por origem, atividades e
// desempenho por responsável. Nada aqui recalcula regra de negócio — se o
// número está errado, ele está errado no servidor (fonte única).
//
// ZERO MODAL: painel é leitura pura. Nenhum formulário, nenhuma sobreposição.
// ============================================================================
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Activity, AlertTriangle, ArrowRight, CalendarClock, TrendingUp, Users } from 'lucide-react';
import { api, ApiError } from '../lib/api';
import { Alert, Badge, EmptyState, PageHeader, Spinner } from '../components/ui';
import { StatCard } from '../components/ui-kit-negocios';
import { formatMoney } from '../lib/format';

type Pipeline = {
  etapa: string;
  nome: string;
  ordem: number;
  probabilidade: number;
  oportunidades: number;
  valor: number;
  forecast: number;
  avancos_registrados: number;
};

type Painel = {
  gerado_em: string;
  leads: {
    total: number;
    abertos: number;
    ganhos: number;
    perdidos: number;
    score_medio: number;
    score_alto: number;
    convertidos: number;
    conversao_pct: number;
  };
  oportunidades: {
    total: number;
    abertas: number;
    ganhas: number;
    perdidas: number;
    valor_aberto: number;
    valor_ganho: number;
    valor_perdido: number;
    ticket_medio_ganho: number;
    taxa_ganho_pct: number | null;
    forecast_ponderado: number;
  };
  pipeline: Pipeline[];
  conversao_por_origem: {
    origem: string;
    leads: number;
    oportunidades: number;
    ganhas: number;
    valor_ganho: number;
    conversao_lead_oportunidade_pct: number | null;
    conversao_ganho_pct: number | null;
  }[];
  campanhas: { total: number; investimento: number; custo_por_lead: number | null; custo_por_ganho: number | null };
  atividades: {
    total: number;
    pendentes: number;
    hoje: number;
    atrasadas: number;
    concluidas: number;
    por_prioridade: Record<string, number>;
  };
  por_responsavel: {
    responsavel: string;
    abertas: number;
    valor_aberto: number;
    forecast: number;
    ganhas: number;
    valor_ganho: number;
    atividades_pendentes: number;
    atividades_atrasadas: number;
  }[];
};

const pct = (v: number | null) => (v === null || v === undefined ? '—' : `${v.toFixed(1).replace('.', ',')}%`);

export default function CrmPainelPage() {
  const [dados, setDados] = useState<Painel | null>(null);
  const [erro, setErro] = useState('');
  const [carregando, setCarregando] = useState(true);

  const carregar = useCallback(async () => {
    setCarregando(true);
    setErro('');
    try {
      setDados(await api.get<Painel>('/crm/painel'));
    } catch (e) {
      setErro(e instanceof ApiError ? e.message : 'Não foi possível carregar o painel do CRM.');
    } finally {
      setCarregando(false);
    }
  }, []);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  const maiorPipeline = Math.max(1, ...(dados?.pipeline.map((p) => p.forecast) ?? [1]));

  return (
    <div className="p-4 sm:p-6">
      <PageHeader
        title="Painel do CRM"
        description="Leads, pipeline, previsão ponderada, conversão por origem e desempenho comercial. Todos os números vêm de um único endpoint derivado — nada é digitado à mão."
        actions={
          <button className="btn-secondary" onClick={() => void carregar()} disabled={carregando}>
            {carregando ? 'Atualizando...' : 'Atualizar'}
          </button>
        }
      />

      {erro && <Alert tone="red">{erro}</Alert>}
      {carregando && !dados && <Spinner label="Carregando painel..." />}

      {dados && (
        <div className="space-y-5">
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <StatCard label="Leads" value={String(dados.leads.total)} hint={`${dados.leads.abertos} em aberto · ${dados.leads.convertidos} convertidos`} />
            <StatCard label="Conversão lead → oportunidade" value={pct(dados.leads.conversao_pct)} hint="sobre o total de leads" />
            <StatCard label="Pipeline aberto" value={formatMoney(dados.oportunidades.valor_aberto)} hint={`${dados.oportunidades.abertas} oportunidade(s)`} />
            <StatCard
              label="Forecast ponderado"
              value={formatMoney(dados.oportunidades.forecast_ponderado)}
              hint="valor × probabilidade (o forecast NÃO é meta)"
            />
          </div>

          <section className="card p-4">
            <header className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <h2 className="flex items-center gap-2 text-sm font-bold text-navy-900 dark:text-white">
                <TrendingUp className="h-4 w-4" /> Pipeline por etapa
              </h2>
              <Link className="btn-secondary !px-2.5 !py-1.5 text-xs" to="/crm/oportunidades">
                Ver oportunidades <ArrowRight className="h-3.5 w-3.5" />
              </Link>
            </header>
            <div className="space-y-2">
              {dados.pipeline.map((p) => (
                <div key={p.etapa} className="grid grid-cols-1 items-center gap-2 sm:grid-cols-[minmax(0,12rem)_1fr_8rem_8rem]">
                  <div className="flex items-center gap-2">
                    <span className="w-5 text-xs tabular-nums text-slate-400">{p.ordem}</span>
                    <span className="text-sm font-semibold text-navy-900 dark:text-white">{p.nome}</span>
                    <Badge tone="slate">{p.probabilidade}%</Badge>
                  </div>
                  <div className="h-3 w-full overflow-hidden rounded-full bg-slate-100 dark:bg-navy-800">
                    <div className="h-full rounded-full bg-navy-700" style={{ width: `${Math.round((p.forecast / maiorPipeline) * 100)}%` }} />
                  </div>
                  <p className="text-xs text-slate-500">
                    {p.oportunidades} op. · {formatMoney(p.valor)}
                  </p>
                  <p className="text-sm font-semibold tabular-nums text-navy-900 dark:text-white">{formatMoney(p.forecast)}</p>
                </div>
              ))}
            </div>
          </section>

          <div className="grid gap-4 lg:grid-cols-2">
            <section className="card p-4">
              <h2 className="mb-3 flex items-center gap-2 text-sm font-bold text-navy-900 dark:text-white">
                <Users className="h-4 w-4" /> Conversão por origem
              </h2>
              {dados.conversao_por_origem.length === 0 ? (
                <EmptyState title="Sem dados de origem" description="Cadastre origens em CRM → Origens e classifique os leads para medir conversão." />
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-left text-xs uppercase tracking-wide text-slate-400">
                        <th className="py-1.5">Origem</th>
                        <th className="py-1.5 text-right">Leads</th>
                        <th className="py-1.5 text-right">Op.</th>
                        <th className="py-1.5 text-right">Lead→Op.</th>
                        <th className="py-1.5 text-right">Ganho</th>
                      </tr>
                    </thead>
                    <tbody>
                      {dados.conversao_por_origem.map((o) => (
                        <tr key={o.origem} className="border-t border-slate-100 dark:border-navy-800">
                          <td className="py-1.5">{o.origem}</td>
                          <td className="py-1.5 text-right tabular-nums">{o.leads}</td>
                          <td className="py-1.5 text-right tabular-nums">{o.oportunidades}</td>
                          <td className="py-1.5 text-right tabular-nums">{pct(o.conversao_lead_oportunidade_pct)}</td>
                          <td className="py-1.5 text-right tabular-nums">{pct(o.conversao_ganho_pct)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <p className="mt-3 text-xs text-slate-400">
                Campanhas: {dados.campanhas.total} · investimento {formatMoney(dados.campanhas.investimento)} · custo por lead{' '}
                {dados.campanhas.custo_por_lead === null ? '—' : formatMoney(dados.campanhas.custo_por_lead)}
              </p>
            </section>

            <section className="card p-4">
              <h2 className="mb-3 flex items-center gap-2 text-sm font-bold text-navy-900 dark:text-white">
                <Activity className="h-4 w-4" /> Atividades
              </h2>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                {[
                  { rotulo: 'Pendentes', valor: dados.atividades.pendentes },
                  { rotulo: 'Hoje', valor: dados.atividades.hoje },
                  { rotulo: 'Atrasadas', valor: dados.atividades.atrasadas },
                  { rotulo: 'Concluídas', valor: dados.atividades.concluidas },
                ].map((i) => (
                  <div key={i.rotulo} className="rounded-lg border border-slate-200 p-2.5 dark:border-navy-800">
                    <p className="text-xs text-slate-500">{i.rotulo}</p>
                    <p className="text-lg font-bold tabular-nums text-navy-900 dark:text-white">{i.valor}</p>
                  </div>
                ))}
              </div>
              {dados.atividades.atrasadas > 0 && (
                <div className="mt-3">
                  <Alert tone="amber">
                    {dados.atividades.atrasadas} atividade(s) vencida(s).{' '}
                    <Link className="underline" to="/crm/agenda">
                      Abrir agenda
                    </Link>
                  </Alert>
                </div>
              )}
              <h3 className="mt-4 flex items-center gap-2 text-xs font-bold uppercase tracking-wide text-slate-400">
                <CalendarClock className="h-3.5 w-3.5" /> Pendentes por prioridade
              </h3>
              <div className="mt-2 flex flex-wrap gap-2">
                {Object.entries(dados.atividades.por_prioridade).map(([prioridade, qtd]) => (
                  <Badge key={prioridade} tone={prioridade === 'urgente' ? 'red' : prioridade === 'alta' ? 'amber' : 'slate'}>
                    {prioridade}: {qtd}
                  </Badge>
                ))}
              </div>
            </section>
          </div>

          <section className="card p-4">
            <h2 className="mb-3 text-sm font-bold text-navy-900 dark:text-white">Desempenho por responsável</h2>
            {dados.por_responsavel.length === 0 ? (
              <EmptyState title="Sem oportunidades atribuídas" description="O desempenho aparece quando houver oportunidade com responsável." />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs uppercase tracking-wide text-slate-400">
                      <th className="py-1.5">Responsável</th>
                      <th className="py-1.5 text-right">Abertas</th>
                      <th className="py-1.5 text-right">Valor aberto</th>
                      <th className="py-1.5 text-right">Forecast</th>
                      <th className="py-1.5 text-right">Ganhas</th>
                      <th className="py-1.5 text-right">Atividades</th>
                    </tr>
                  </thead>
                  <tbody>
                    {dados.por_responsavel.map((r) => (
                      <tr key={r.responsavel} className="border-t border-slate-100 dark:border-navy-800">
                        <td className="py-1.5">{r.responsavel}</td>
                        <td className="py-1.5 text-right tabular-nums">{r.abertas}</td>
                        <td className="py-1.5 text-right tabular-nums">{formatMoney(r.valor_aberto)}</td>
                        <td className="py-1.5 text-right tabular-nums">{formatMoney(r.forecast)}</td>
                        <td className="py-1.5 text-right tabular-nums">{r.ganhas}</td>
                        <td className="py-1.5 text-right tabular-nums">
                          {r.atividades_pendentes}
                          {r.atividades_atrasadas > 0 && (
                            <span className="ml-1 inline-flex items-center gap-1 text-red-600">
                              <AlertTriangle className="h-3 w-3" />
                              {r.atividades_atrasadas}
                            </span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <p className="text-xs text-slate-400">
            Gerado em {new Date(dados.gerado_em).toLocaleString('pt-BR')} · taxas de ganho{' '}
            {pct(dados.oportunidades.taxa_ganho_pct)} · ticket médio ganho {formatMoney(dados.oportunidades.ticket_medio_ganho)}
          </p>
        </div>
      )}
    </div>
  );
}
