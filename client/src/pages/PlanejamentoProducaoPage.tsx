// ============================================================================
// PLANEJAMENTO DE PRODUÇÃO — E2
//
// Duas perguntas, respondidas com dado real do domínio:
//   1) o que está planejado por semana, quanto já foi produzido e o que atrasou;
//   2) quais insumos faltam para executar o plano (necessidade da ficha ×
//      peças que faltam produzir − saldo atual).
//
// Nada aqui é estimado nem preenchido com valor de exemplo: sem OP no período,
// a tela mostra o estado vazio; sem ficha técnica no produto, o insumo não
// aparece na necessidade (e a tela diz por quê).
// ============================================================================
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, CalendarDays, Factory, Scissors, TriangleAlert } from 'lucide-react';
import { api, ApiError } from '../lib/api';
import { formatDate, formatMoney, formatNumber } from '../lib/format';
import { Alert, Badge, EmptyState, PageHeader, Spinner } from '../components/ui';

type LinhaPlanejada = {
  id: number;
  produto: string;
  produto_id: number;
  status: string;
  previsao: string | null;
  semana: string;
  planejadas: number;
  produzidas: number;
  perdidas: number;
  faltam: number;
  atrasada: boolean;
  custo_previsto: number;
  responsavel: string | null;
};

type Semana = { semana: string; ops: number; planejadas: number; produzidas: number; atrasadas: number; custo_previsto: number };

type InsumoNecessario = {
  insumo_id: number;
  nome: string;
  unidade: string;
  necessaria: number;
  disponivel: number;
  faltando: number;
};

type Planejamento = {
  de: string;
  ate: string;
  hoje: string;
  resumo: {
    ops: number;
    planejadas: number;
    produzidas: number;
    perdidas: number;
    faltam: number;
    atrasadas: number;
    custo_previsto: number;
    insumos_em_falta: number;
  };
  porSemana: Semana[];
  ordens: LinhaPlanejada[];
  insumos: InsumoNecessario[];
};

const STATUS_LABEL: Record<string, string> = {
  planejada: 'Planejada',
  liberada: 'Liberada',
  em_producao: 'Em produção',
  parcial: 'Parcial',
};
const STATUS_TONE: Record<string, 'slate' | 'blue' | 'amber'> = { planejada: 'slate', liberada: 'amber', em_producao: 'blue', parcial: 'blue' };

/** Segunda-feira da semana de uma data (o plano é semanal). */
function segundaDaSemana(iso: string): string {
  const d = new Date(`${iso}T12:00:00Z`);
  const dia = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - dia);
  return d.toISOString().slice(0, 10);
}

export default function PlanejamentoProducaoPage() {
  const [de, setDe] = useState(() => segundaDaSemana(new Date().toISOString().slice(0, 10)));
  const [ate, setAte] = useState(() => {
    const d = new Date(`${segundaDaSemana(new Date().toISOString().slice(0, 10))}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + 55);
    return d.toISOString().slice(0, 10);
  });
  const [dados, setDados] = useState<Planejamento | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const r = await api.get<Planejamento>(`/producao/planejamento?de=${de}&ate=${ate}`);
      setDados(r);
    } catch (e: any) {
      setError(e instanceof ApiError ? e.message : 'Não foi possível carregar o planejamento.');
      setDados(null);
    } finally {
      setLoading(false);
    }
  }, [de, ate]);

  useEffect(() => {
    load();
  }, [load]);

  const emFalta = useMemo(() => (dados?.insumos || []).filter((i) => i.faltando > 0), [dados]);

  return (
    <div className="p-4 pb-24 sm:p-6 md:pb-6">
      <PageHeader
        title={
          <span className="flex items-center gap-2.5">
            <Factory className="h-5 w-5 text-navy-600" /> Planejamento de produção
          </span>
        }
        description="Ordens planejadas por semana e os insumos que faltam para executá-las."
        actions={
          <div className="flex flex-wrap items-end gap-2">
            <label className="block">
              <span className="label">De</span>
              <input type="date" className="input" value={de} onChange={(e) => setDe(e.target.value)} />
            </label>
            <label className="block">
              <span className="label">Até</span>
              <input type="date" className="input" value={ate} onChange={(e) => setAte(e.target.value)} />
            </label>
            <button className="btn-secondary" onClick={load} disabled={loading}>
              {loading ? <Spinner /> : <CalendarDays className="h-4 w-4" />} Atualizar
            </button>
          </div>
        }
      />

      {error && (
        <Alert tone="red">
          {error}{' '}
          <button className="underline" onClick={load}>
            Tentar de novo
          </button>
        </Alert>
      )}

      {loading && !dados ? (
        <Spinner />
      ) : !dados ? null : (
        <>
          {/* Resumo */}
          <div className="mt-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
            {[
              { label: 'OPs no período', valor: formatNumber(dados.resumo.ops), tom: 'text-navy-900' },
              { label: 'Peças planejadas', valor: formatNumber(dados.resumo.planejadas), tom: 'text-navy-900' },
              {
                label: 'Produzidas / refugadas',
                valor: `${formatNumber(dados.resumo.produzidas)} / ${formatNumber(dados.resumo.perdidas)}`,
                tom: dados.resumo.perdidas > 0 ? 'text-red-600' : 'text-navy-900',
              },
              { label: 'Custo previsto', valor: formatMoney(dados.resumo.custo_previsto), tom: 'text-navy-900' },
            ].map((c) => (
              <div key={c.label} className="card p-4">
                <span className="label">{c.label}</span>
                <div className={`mt-1 text-xl font-bold tabular-nums ${c.tom}`}>{c.valor}</div>
              </div>
            ))}
          </div>

          {(dados.resumo.atrasadas > 0 || dados.resumo.insumos_em_falta > 0) && (
            <div className="mt-4">
              <Alert tone={dados.resumo.insumos_em_falta > 0 ? 'red' : 'amber'}>
                <span className="flex items-center gap-2">
                  <TriangleAlert className="h-4 w-4" />
                  {dados.resumo.insumos_em_falta > 0
                    ? `${dados.resumo.insumos_em_falta} insumo(s) em falta para cumprir o plano do período.`
                    : ''}
                  {dados.resumo.atrasadas > 0 ? ` ${dados.resumo.atrasadas} OP(s) com previsão vencida.` : ''}
                </span>
              </Alert>
            </div>
          )}

          <div className="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-3">
            {/* Insumos em falta */}
            <div className="card overflow-hidden xl:col-span-1">
              <div className="border-b border-slate-200 px-4 py-3">
                <h2 className="flex items-center gap-2 text-sm font-bold text-navy-900">
                  <Scissors className="h-4 w-4 text-slate-400" /> Necessidade de insumos
                </h2>
                <p className="mt-0.5 text-xs text-slate-400">Consumo da ficha × peças que faltam produzir, menos o saldo atual.</p>
              </div>
              {dados.insumos.length === 0 ? (
                <EmptyState
                  icon={<Scissors className="h-8 w-8" />}
                  title="Nenhuma necessidade de insumo"
                  description="Não há OP aberta no período, ou os produtos planejados não têm ficha técnica cadastrada."
                />
              ) : (
                <table className="table">
                  <thead>
                    <tr>
                      <th>Insumo</th>
                      <th className="text-right">Necessário</th>
                      <th className="text-right">Disponível</th>
                      <th className="text-right">Falta</th>
                    </tr>
                  </thead>
                  <tbody>
                    {dados.insumos.map((i) => (
                      <tr key={i.insumo_id} className={i.faltando > 0 ? 'bg-red-50/40' : ''}>
                        <td className="font-medium text-slate-800">{i.nome}</td>
                        <td className="text-right tabular-nums text-slate-600">
                          {formatNumber(i.necessaria)} {i.unidade}
                        </td>
                        <td className="text-right tabular-nums text-slate-600">
                          {formatNumber(i.disponivel)} {i.unidade}
                        </td>
                        <td className={`text-right font-semibold tabular-nums ${i.faltando > 0 ? 'text-red-600' : 'text-emerald-700'}`}>
                          {i.faltando > 0 ? `${formatNumber(i.faltando)} ${i.unidade}` : 'ok'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              {emFalta.length > 0 && (
                <div className="border-t border-slate-200 p-3">
                  <Link to="/sugestao-compra" className="btn-secondary w-full justify-center">
                    <AlertTriangle className="h-4 w-4" /> Abrir sugestão de compra
                  </Link>
                </div>
              )}
            </div>

            {/* Plano por semana */}
            <div className="space-y-4 xl:col-span-2">
              {dados.porSemana.length === 0 ? (
                <div className="card">
                  <EmptyState
                    icon={<Factory className="h-8 w-8" />}
                    title="Nenhuma OP no período"
                    description="Nenhuma ordem planejada, liberada, em produção ou parcial entre as datas escolhidas. Ajuste o período ou crie uma OP."
                    action={
                      <Link to="/ordens" className="btn-primary">
                        Ir para Cadeias de Fabricação
                      </Link>
                    }
                  />
                </div>
              ) : (
                <>
                  <div className="card overflow-hidden">
                    <div className="border-b border-slate-200 px-4 py-3">
                      <h2 className="text-sm font-bold text-navy-900">Por semana</h2>
                    </div>
                    <table className="table">
                      <thead>
                        <tr>
                          <th>Semana</th>
                          <th className="text-right">OPs</th>
                          <th className="text-right">Planejadas</th>
                          <th className="text-right">Produzidas</th>
                          <th className="text-right">Atrasadas</th>
                          <th className="text-right">Custo previsto</th>
                        </tr>
                      </thead>
                      <tbody>
                        {dados.porSemana.map((sm) => (
                          <tr key={sm.semana}>
                            <td className="font-medium text-slate-800">
                              semana de {formatDate(sm.semana)}
                              {sm.semana === segundaDaSemana(dados.hoje) && <Badge tone="blue">atual</Badge>}
                            </td>
                            <td className="text-right tabular-nums">{formatNumber(sm.ops)}</td>
                            <td className="text-right tabular-nums">{formatNumber(sm.planejadas)}</td>
                            <td className="text-right tabular-nums text-slate-500">{formatNumber(sm.produzidas)}</td>
                            <td className={`text-right tabular-nums ${sm.atrasadas > 0 ? 'font-semibold text-red-600' : 'text-slate-400'}`}>
                              {formatNumber(sm.atrasadas)}
                            </td>
                            <td className="text-right tabular-nums">{formatMoney(sm.custo_previsto)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>

                  <div className="card overflow-hidden">
                    <div className="border-b border-slate-200 px-4 py-3">
                      <h2 className="text-sm font-bold text-navy-900">Ordens do período</h2>
                    </div>
                    <table className="table">
                      <thead>
                        <tr>
                          <th>OP</th>
                          <th>Produto</th>
                          <th>Status</th>
                          <th className="text-right">Planejadas</th>
                          <th className="text-right">Faltam</th>
                          <th className="text-right">Previsão</th>
                        </tr>
                      </thead>
                      <tbody>
                        {dados.ordens.map((o) => (
                          <tr key={o.id}>
                            <td>
                              <Link to={`/ordens/${o.id}`} className="font-medium text-navy-700 hover:underline">
                                #{o.id}
                              </Link>
                            </td>
                            <td className="text-slate-700">{o.produto}</td>
                            <td>
                              <Badge tone={STATUS_TONE[o.status] || 'slate'}>{STATUS_LABEL[o.status] || o.status}</Badge>
                              {o.atrasada && (
                                <span className="ml-1.5 text-xs font-semibold text-red-600">
                                  <AlertTriangle className="inline h-3.5 w-3.5" /> atrasada
                                </span>
                              )}
                            </td>
                            <td className="text-right tabular-nums">{formatNumber(o.planejadas)}</td>
                            <td className="text-right tabular-nums text-slate-500">{formatNumber(o.faltam)}</td>
                            <td className={`text-right ${o.atrasada ? 'font-semibold text-red-600' : 'text-slate-500'}`}>{formatDate(o.previsao)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
