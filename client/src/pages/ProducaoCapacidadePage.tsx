// ============================================================================
// PRODUÇÃO — CAPACIDADE, GARGALO E MRP (módulo /producao/capacidade)
//
// Duas leituras que o planejador usa juntas:
//   1) CAPACIDADE × CARGA por recurso produtivo no período — ocupação e gargalo.
//      Capacidade é cadastro (peças/dia × dias úteis × eficiência); carga é o
//      que ainda falta produzir nas OPs alocadas. Nada aqui é editável: para
//      mudar capacidade, edita-se o recurso; para mudar carga, mexe-se na OP.
//   2) MRP — o que falta de produto e de insumo, cruzando vendas em aberto,
//      estoque, OPs abertas, ficha técnica (com perda) e compras em aberto.
//      O MRP SUGERE; não cria pedido. O botão leva à sugestão de compra, onde a
//      geração exige confirmação explícita.
//
// ZERO MODAL: tudo é tabela e faixa inline nesta mesma página.
// ============================================================================
import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, BarChart3, Factory, Loader2, RefreshCw } from 'lucide-react';
import { api, ApiError } from '../lib/api';
import { Alert, Badge, EmptyState, PageHeader, Spinner } from '../components/ui';
import { StatCard } from '../components/ui-kit-negocios';
import { formatDate, formatNumber } from '../lib/format';

type RecursoCapacidade = {
  recurso_id: number;
  nome: string;
  tipo: string;
  capacidade_diaria: number;
  eficiencia_pct: number;
  capacidade_periodo: number;
  carga: number;
  ocupacao_pct: number;
  ops: number;
  gargalo: boolean;
};

type Capacidade = {
  de: string;
  ate: string;
  dias_uteis: number;
  regra: string;
  resumo: {
    recursos: number;
    capacidade_periodo: number;
    carga: number;
    ocupacao_pct: number | null;
    gargalo: { recurso_id: number; nome: string; ocupacao_pct: number } | null;
    ordens_sem_recurso: number;
    pecas_sem_recurso: number;
    ordens_fora_do_periodo: number;
  };
  recursos: RecursoCapacidade[];
  sem_recurso: { ordem_id: number; produto: string | null; faltam: number; previsao: string | null }[];
};

type Mrp = {
  resumo: {
    vendas_em_aberto: number;
    ordens_abertas: number;
    produtos_em_falta: number;
    pecas_em_falta: number;
    insumos_em_falta: number;
    produtos_sem_ficha: number;
  };
  produtos: { produto_id: number; produto: string; tamanho_id: number | null; demanda: number; estoque: number; em_producao: number; falta: number }[];
  insumos: { insumo_id: number; nome: string; unidade: string; necessaria: number; disponivel: number; em_compra: number; cobertura: number; faltando: number }[];
  sem_ficha: { produto_id: number; produto: string }[];
  proxima_acao: string;
};

const semanaISO = (d: Date) => {
  const copia = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dia = copia.getUTCDay() || 7;
  copia.setUTCDate(copia.getUTCDate() - (dia - 1));
  return copia.toISOString().slice(0, 10);
};

const somarDias = (iso: string, dias: number) => {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
};

const corOcupacao = (pct: number) => (pct > 100 ? 'bg-red-500' : pct >= 85 ? 'bg-amber-500' : pct >= 60 ? 'bg-emerald-500' : 'bg-sky-500');

export default function ProducaoCapacidadePage() {
  const hoje = new Date();
  const [de, setDe] = useState(semanaISO(hoje));
  const [ate, setAte] = useState(somarDias(semanaISO(hoje), 55));
  const [capacidade, setCapacidade] = useState<Capacidade | null>(null);
  const [mrp, setMrp] = useState<Mrp | null>(null);
  const [erro, setErro] = useState('');
  const [carregando, setCarregando] = useState(true);

  const carregar = useCallback(async () => {
    setCarregando(true);
    setErro('');
    try {
      const [cap, plano] = await Promise.all([
        api.get<Capacidade>(`/producao/capacidade?de=${de}&ate=${ate}`),
        api.get<Mrp>('/producao/mrp'),
      ]);
      setCapacidade(cap);
      setMrp(plano);
    } catch (e) {
      setErro(e instanceof ApiError ? e.message : 'Não foi possível carregar capacidade e MRP.');
    } finally {
      setCarregando(false);
    }
  }, [de, ate]);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  return (
    <div className="space-y-5">
      <PageHeader
        title="Capacidade e MRP"
        description="Quanto cabe na fábrica no período (e onde está o gargalo) e o que falta comprar para atender a demanda em aberto — números calculados, nenhum pedido criado automaticamente."
        actions={
          <button type="button" onClick={() => void carregar()} className="inline-flex items-center gap-2 rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50">
            <RefreshCw className="h-4 w-4" /> Atualizar
          </button>
        }
      />

      <div className="flex flex-wrap items-end gap-3 rounded-xl border border-slate-200 bg-white p-3">
        <label className="text-sm">
          <span className="mb-1 block font-medium text-slate-600">De</span>
          <input type="date" value={de} onChange={(e) => setDe(e.target.value)} className="rounded-lg border border-slate-300 px-3 py-2" />
        </label>
        <label className="text-sm">
          <span className="mb-1 block font-medium text-slate-600">Até</span>
          <input type="date" value={ate} onChange={(e) => setAte(e.target.value)} className="rounded-lg border border-slate-300 px-3 py-2" />
        </label>
        {capacidade && <span className="pb-2 text-xs text-slate-500">{capacidade.dias_uteis} dia(s) útil(eis) no período</span>}
      </div>

      {erro && <Alert tone="red">{erro}</Alert>}

      {carregando ? (
        <div className="flex justify-center py-16"><Spinner /></div>
      ) : (
        <>
          {/* ---------------- CAPACIDADE ---------------- */}
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard label="Recursos ativos" value={String(capacidade?.resumo.recursos ?? '—')} hint="Cadastro de recursos produtivos." />
            <StatCard label="Capacidade do período" value={formatNumber(capacidade?.resumo.capacidade_periodo ?? 0)} hint="Peças possíveis no período." />
            <StatCard label="Carga alocada" value={formatNumber(capacidade?.resumo.carga ?? 0)} hint="Peças que ainda faltam produzir." />
            <StatCard
              label="Ocupação"
              value={capacidade?.resumo.ocupacao_pct != null ? `${capacidade.resumo.ocupacao_pct}%` : '—'}
              hint={capacidade?.resumo.gargalo ? `Gargalo: ${capacidade.resumo.gargalo.nome}` : 'Sem gargalo no período.'}
            />
          </div>

          <section className="rounded-xl border border-slate-200 bg-white">
            <header className="flex items-center gap-2 border-b border-slate-100 px-4 py-3 text-sm font-semibold text-slate-700">
              <BarChart3 className="h-4 w-4" /> Capacidade por recurso
            </header>
            {!capacidade || capacidade.recursos.length === 0 ? (
              <EmptyState
                title="Nenhum recurso de produção cadastrado"
                description="Cadastre os recursos (corte, costura, estamparia...) com a capacidade diária em Produção › Recursos de produção."
              />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                    <tr>
                      <th className="px-4 py-2">Recurso</th>
                      <th className="px-4 py-2">Tipo</th>
                      <th className="px-4 py-2 text-right">Capacidade/dia</th>
                      <th className="px-4 py-2 text-right">Capacidade no período</th>
                      <th className="px-4 py-2 text-right">Carga</th>
                      <th className="px-4 py-2 text-right">Ocupação</th>
                      <th className="px-4 py-2">Situação</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {capacidade.recursos.map((r) => (
                      <tr key={r.recurso_id}>
                        <td className="px-4 py-2 font-medium text-slate-700">
                          {r.nome} {r.gargalo && <Badge tone="red">gargalo</Badge>}
                        </td>
                        <td className="px-4 py-2 text-slate-500">{r.tipo}</td>
                        <td className="px-4 py-2 text-right text-slate-600">
                          {r.capacidade_diaria}
                          {r.eficiencia_pct !== 100 && <span className="ml-1 text-xs text-slate-400">× {r.eficiencia_pct}%</span>}
                        </td>
                        <td className="px-4 py-2 text-right text-slate-600">{formatNumber(r.capacidade_periodo)}</td>
                        <td className="px-4 py-2 text-right text-slate-700">{formatNumber(r.carga)}</td>
                        <td className="px-4 py-2 text-right font-medium text-slate-800">{r.ocupacao_pct}%</td>
                        <td className="px-4 py-2">
                          <div className="h-2 w-28 overflow-hidden rounded-full bg-slate-100">
                            <div className={`h-full ${corOcupacao(r.ocupacao_pct)}`} style={{ width: `${Math.min(100, r.ocupacao_pct)}%` }} />
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <p className="border-t border-slate-100 px-4 py-2 text-xs text-slate-500">{capacidade?.regra}</p>
          </section>

          {capacidade && capacidade.sem_recurso.length > 0 && (
            <section className="rounded-xl border border-amber-200 bg-amber-50 p-4">
              <h3 className="flex items-center gap-2 text-sm font-semibold text-amber-800">
                <AlertTriangle className="h-4 w-4" /> {capacidade.sem_recurso.length} ordem(ns) sem recurso alocado ({formatNumber(capacidade.resumo.pecas_sem_recurso)} peças)
              </h3>
              <p className="mt-1 text-xs text-amber-700">
                Sem recurso a carga não entra em nenhum recurso — o gargalo pareceria menor do que é. Aloque a OP em Produção › Cadeias de Fabricação.
              </p>
              <ul className="mt-2 grid gap-1 text-sm text-amber-800 sm:grid-cols-2">
                {capacidade.sem_recurso.slice(0, 12).map((o) => (
                  <li key={o.ordem_id} className="flex items-center justify-between gap-2">
                    <span>OP #{o.ordem_id}{o.produto ? ` · ${o.produto}` : ''}</span>
                    <span className="text-xs">{formatNumber(o.faltam)} peças{o.previsao ? ` · ${formatDate(o.previsao)}` : ''}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {/* ---------------- MRP ---------------- */}
          <section className="rounded-xl border border-slate-200 bg-white">
            <header className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-4 py-3">
              <h2 className="flex items-center gap-2 text-sm font-semibold text-slate-700">
                <Factory className="h-4 w-4" /> MRP — necessidade a partir da demanda em aberto
              </h2>
              <span className="text-xs text-slate-500">
                {mrp?.resumo.vendas_em_aberto ?? 0} venda(s) em aberto · {mrp?.resumo.ordens_abertas ?? 0} OP(s) aberta(s)
              </span>
            </header>

            <div className="grid gap-3 border-b border-slate-100 p-4 sm:grid-cols-3">
              <StatCard label="Produtos em falta" value={String(mrp?.resumo.produtos_em_falta ?? 0)} hint={`${formatNumber(mrp?.resumo.pecas_em_falta ?? 0)} peças para produzir`} />
              <StatCard label="Insumos em falta" value={String(mrp?.resumo.insumos_em_falta ?? 0)} hint="Já descontando estoque e compras em aberto." />
              <StatCard label="Produtos sem ficha técnica" value={String(mrp?.resumo.produtos_sem_ficha ?? 0)} hint="Sem BOM não há explosão honesta de insumos." />
            </div>

            <div className="grid gap-4 p-4 lg:grid-cols-2">
              <div>
                <h3 className="mb-2 text-sm font-semibold text-slate-700">Produtos a produzir</h3>
                {!mrp || mrp.produtos.length === 0 ? (
                  <p className="text-sm text-slate-500">Nenhuma falta de produto: a demanda em aberto está coberta por estoque e OPs.</p>
                ) : (
                  <table className="w-full text-sm">
                    <thead className="text-left text-xs uppercase tracking-wide text-slate-400">
                      <tr><th className="py-1">Produto</th><th className="py-1 text-right">Demanda</th><th className="py-1 text-right">Estoque</th><th className="py-1 text-right">Em OP</th><th className="py-1 text-right">Falta</th></tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {mrp.produtos.slice(0, 20).map((p) => (
                        <tr key={`${p.produto_id}-${p.tamanho_id ?? 0}`}>
                          <td className="py-1.5 text-slate-700">{p.produto}{p.tamanho_id ? ` · #${p.tamanho_id}` : ''}</td>
                          <td className="py-1.5 text-right text-slate-600">{formatNumber(p.demanda)}</td>
                          <td className="py-1.5 text-right text-slate-600">{formatNumber(p.estoque)}</td>
                          <td className="py-1.5 text-right text-slate-600">{formatNumber(p.em_producao)}</td>
                          <td className="py-1.5 text-right font-medium text-amber-700">{formatNumber(p.falta)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>

              <div>
                <h3 className="mb-2 text-sm font-semibold text-slate-700">Insumos a comprar</h3>
                {!mrp || mrp.insumos.length === 0 ? (
                  <p className="text-sm text-slate-500">Nenhuma necessidade de insumo calculada.</p>
                ) : (
                  <table className="w-full text-sm">
                    <thead className="text-left text-xs uppercase tracking-wide text-slate-400">
                      <tr><th className="py-1">Insumo</th><th className="py-1 text-right">Necessário</th><th className="py-1 text-right">Disponível</th><th className="py-1 text-right">Em compra</th><th className="py-1 text-right">Faltando</th></tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {mrp.insumos.slice(0, 20).map((i) => (
                        <tr key={i.insumo_id}>
                          <td className="py-1.5 text-slate-700">{i.nome} <span className="text-xs text-slate-400">({i.unidade})</span></td>
                          <td className="py-1.5 text-right text-slate-600">{formatNumber(i.necessaria)}</td>
                          <td className="py-1.5 text-right text-slate-600">{formatNumber(i.disponivel)}</td>
                          <td className="py-1.5 text-right text-slate-600">{formatNumber(i.em_compra)}</td>
                          <td className={`py-1.5 text-right font-medium ${i.faltando > 0 ? 'text-red-600' : 'text-emerald-600'}`}>{formatNumber(i.faltando)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </div>

            {mrp && mrp.sem_ficha.length > 0 && (
              <div className="border-t border-slate-100 px-4 py-3">
                <p className="text-xs text-slate-500">
                  Sem ficha técnica (necessidade de insumo não calculada para): {mrp.sem_ficha.slice(0, 10).map((p) => p.produto).join(', ')}
                  {mrp.sem_ficha.length > 10 ? ` e mais ${mrp.sem_ficha.length - 10}.` : '.'}
                </p>
              </div>
            )}

            <p className="border-t border-slate-100 px-4 py-2 text-xs text-slate-500">
              {mrp?.proxima_acao ?? 'O MRP sugere; a compra é decisão humana.'}
            </p>
          </section>
        </>
      )}

      {carregando && (
        <span className="sr-only"><Loader2 className="animate-spin" /> carregando</span>
      )}
    </div>
  );
}
