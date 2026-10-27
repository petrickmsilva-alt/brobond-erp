// ============================================================================
// PAINEL COMERCIAL (MA-08) — indicadores DERIVADOS.
//
// Responde, com número do servidor (nunca calculado no navegador):
//   • faturamento, pedidos, clientes, peças, ticket médio e comissão;
//   • meta × realizado × variação × % de atingimento;
//   • ranking por representante, por território e por equipe.
//
// Fonte única: `GET /api/comercial/indicadores` (server/src/comercial.ts), que
// apura a partir das vendas faturadas/entregues e recorta pela empresa ativa.
// Não existe "indicador manual" — não há campo em tela para digitar número.
// ============================================================================
import { useCallback, useEffect, useMemo, useState } from 'react';
import { BarChart3, Loader2, RefreshCw } from 'lucide-react';
import { api, ApiError } from '../lib/api';
import { useMeta, type Option } from '../lib/meta';
import { Alert, Badge, EmptyState, PageHeader, useToast } from '../components/ui';
import { Card, CardHeader, FilterBar } from '../components/ui-kit-negocios';
import { BarrasVerticais } from '../components/Charts';

type LinhaRep = {
  representante_id: number;
  representante: string;
  vendas: number;
  faturamento: number;
  pedidos: number;
  clientes: number;
  pecas: number;
  ticket_medio: number;
  comissao: number;
  meta: number | null;
  atingimento_pct: number | null;
};

type LinhaGrupo = { faturamento: number; pedidos: number };

type Indicadores = {
  janela: { de: string | null; ate: string | null };
  vendas: number;
  faturamento: number;
  pedidos: number;
  clientes: number;
  pecas: number;
  ticket_medio: number;
  comissao: number;
  meta: number | null;
  realizado: number | null;
  variacao: number | null;
  atingimento_pct: number | null;
  por_representante: LinhaRep[];
  por_territorio: ({ territorio_id: number; territorio: string } & LinhaGrupo)[];
  por_equipe: ({ equipe_id: number; equipe: string } & LinhaGrupo)[];
};

const moeda = (v: number) => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(v || 0);
const numero = (v: number) => new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 2 }).format(v || 0);

/** Último dia do mês corrente — janela padrão do painel. */
function hoje(): string {
  return new Date().toISOString().slice(0, 10);
}
function primeiroDiaDoAno(): string {
  return `${new Date().toISOString().slice(0, 4)}-01-01`;
}

export default function PainelComercialPage() {
  const toast = useToast();
  const meta = useMeta();
  const [de, setDe] = useState(primeiroDiaDoAno());
  const [ate, setAte] = useState(hoje());
  const [representanteId, setRepresentanteId] = useState('');
  const [territorioId, setTerritorioId] = useState('');
  const [equipeId, setEquipeId] = useState('');
  const [dados, setDados] = useState<Indicadores | null>(null);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState('');

  const params = useMemo(() => {
    const p = new URLSearchParams();
    if (de) p.set('de', de);
    if (ate) p.set('ate', ate);
    if (representanteId) p.set('representante_id', representanteId);
    if (territorioId) p.set('territorio_id', territorioId);
    if (equipeId) p.set('equipe_id', equipeId);
    return p.toString();
  }, [de, ate, representanteId, territorioId, equipeId]);

  const carregar = useCallback(async () => {
    setCarregando(true);
    try {
      const d = await api.get<Indicadores>(`/comercial/indicadores?${params}`);
      setDados(d);
      setErro('');
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : 'Não foi possível carregar os indicadores.';
      setErro(msg);
      toast.error(msg);
    } finally {
      setCarregando(false);
    }
  }, [params, toast]);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  // Opções dos filtros vêm do próprio meta/API (sem lista paralela).
  const representantes: Option[] = (meta as any).options?.representantes ?? [];
  const territorios: Option[] = (meta as any).options?.territorios ?? [];
  const equipes: Option[] = (meta as any).options?.equipes_comerciais ?? [];

  return (
    <div className="p-4 sm:p-6">
      <PageHeader
        title="Painel comercial"
        description="Indicadores derivados das vendas faturadas. Nenhum número é digitado — meta, variação e atingimento são calculados no servidor."
        actions={
          <button type="button" className="btn-secondary inline-flex" onClick={() => void carregar()} disabled={carregando}>
            {carregando ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />} Atualizar
          </button>
        }
      />

      <FilterBar
        actions={
          <div className="flex items-center gap-2">
            {(representanteId || territorioId || equipeId) && (
              <button
                type="button"
                className="btn-secondary"
                onClick={() => {
                  setRepresentanteId('');
                  setTerritorioId('');
                  setEquipeId('');
                }}
              >
                Limpar recortes
              </button>
            )}
          </div>
        }
      >
        <label className="flex flex-col gap-1 text-xs text-muted">
          <span>De</span>
          <input type="date" className="input !w-auto" value={de} onChange={(e) => setDe(e.target.value)} />
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted">
          <span>Até</span>
          <input type="date" className="input !w-auto" value={ate} onChange={(e) => setAte(e.target.value)} />
        </label>
        {representantes.length > 0 && (
          <label className="flex flex-col gap-1 text-xs text-muted">
            <span>Representante</span>
            <select className="input !w-auto" value={representanteId} onChange={(e) => setRepresentanteId(e.target.value)}>
              <option value="">Todos</option>
              {representantes.map((o) => (
                <option key={o.value} value={String(o.value)}>{o.label}</option>
              ))}
            </select>
          </label>
        )}
        {territorios.length > 0 && (
          <label className="flex flex-col gap-1 text-xs text-muted">
            <span>Território</span>
            <select className="input !w-auto" value={territorioId} onChange={(e) => setTerritorioId(e.target.value)}>
              <option value="">Todos</option>
              {territorios.map((o) => (
                <option key={o.value} value={String(o.value)}>{o.label}</option>
              ))}
            </select>
          </label>
        )}
        {equipes.length > 0 && (
          <label className="flex flex-col gap-1 text-xs text-muted">
            <span>Equipe</span>
            <select className="input !w-auto" value={equipeId} onChange={(e) => setEquipeId(e.target.value)}>
              <option value="">Todas</option>
              {equipes.map((o) => (
                <option key={o.value} value={String(o.value)}>{o.label}</option>
              ))}
            </select>
          </label>
        )}
      </FilterBar>

      {erro && (
        <div className="my-4">
          <Alert tone="red">{erro}</Alert>
        </div>
      )}

      {carregando && !dados ? (
        <div className="flex items-center justify-center py-16 text-sm text-muted">
          <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Apurando indicadores…
        </div>
      ) : !dados ? (
        <EmptyState icon={<BarChart3 className="h-6 w-6" />} title="Sem indicadores" description="Ajuste o período e tente novamente." />
      ) : (
        <div className="mt-4 space-y-4">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Card className="p-4">
              <p className="text-xs uppercase tracking-wide text-muted">Faturamento</p>
              <p className="mt-1 text-2xl font-bold tabular-nums text-navy-900 dark:text-white">{moeda(dados.faturamento)}</p>
              <p className="mt-1 text-xs text-muted">{numero(dados.pedidos)} pedido(s) no período</p>
            </Card>
            <Card className="p-4">
              <p className="text-xs uppercase tracking-wide text-muted">Ticket médio</p>
              <p className="mt-1 text-2xl font-bold tabular-nums text-navy-900 dark:text-white">{moeda(dados.ticket_medio)}</p>
              <p className="mt-1 text-xs text-muted">{numero(dados.clientes)} cliente(s) atendido(s)</p>
            </Card>
            <Card className="p-4">
              <p className="text-xs uppercase tracking-wide text-muted">Meta do período</p>
              <p className="mt-1 text-2xl font-bold tabular-nums text-navy-900 dark:text-white">
                {dados.meta === null ? '—' : moeda(dados.meta)}
              </p>
              <p className="mt-1">
                {dados.atingimento_pct === null ? (
                  <Badge tone="slate">Sem meta ativa</Badge>
                ) : dados.atingimento_pct >= 100 ? (
                  <Badge tone="green">{numero(dados.atingimento_pct)}% — atingida</Badge>
                ) : (
                  <Badge tone="amber">{numero(dados.atingimento_pct)}% atingido</Badge>
                )}
              </p>
            </Card>
            <Card className="p-4">
              <p className="text-xs uppercase tracking-wide text-muted">Comissão apurada</p>
              <p className="mt-1 text-2xl font-bold tabular-nums text-navy-900 dark:text-white">{moeda(dados.comissao)}</p>
              <p className="mt-1 text-xs text-muted">Valor congelado nas vendas — não é recálculo.</p>
            </Card>
          </div>

          {dados.por_representante.length > 0 && (
            <Card>
              <CardHeader title="Por representante" subtitle="Participação proporcional quando a venda tem mais de um representante." />
              <div className="px-4 pt-4">
                <BarrasVerticais
                  rotulos={dados.por_representante.slice(0, 8).map((r) => r.representante)}
                  valores={dados.por_representante.slice(0, 8).map((r) => r.faturamento)}
                  formatar={moeda}
                  titulo="Faturamento por representante"
                />
              </div>
              <div className="overflow-x-auto">
                <table className="table">
                  <caption className="sr-only">Indicadores por representante</caption>
                  <thead>
                    <tr>
                      <th scope="col" className="text-left">Representante</th>
                      <th scope="col" className="text-right">Faturamento</th>
                      <th scope="col" className="text-right">Pedidos</th>
                      <th scope="col" className="text-right">Clientes</th>
                      <th scope="col" className="text-right">Peças</th>
                      <th scope="col" className="text-right">Ticket médio</th>
                      <th scope="col" className="text-right">Comissão</th>
                      <th scope="col" className="text-right">Meta</th>
                      <th scope="col" className="text-right">Atingimento</th>
                    </tr>
                  </thead>
                  <tbody>
                    {dados.por_representante.map((r) => (
                      <tr key={r.representante_id}>
                        <td>{r.representante}</td>
                        <td className="text-right tabular-nums">{moeda(r.faturamento)}</td>
                        <td className="text-right tabular-nums">{numero(r.pedidos)}</td>
                        <td className="text-right tabular-nums">{numero(r.clientes)}</td>
                        <td className="text-right tabular-nums">{numero(r.pecas)}</td>
                        <td className="text-right tabular-nums">{moeda(r.ticket_medio)}</td>
                        <td className="text-right tabular-nums">{moeda(r.comissao)}</td>
                        <td className="text-right tabular-nums">{r.meta === null ? '—' : moeda(r.meta)}</td>
                        <td className="text-right tabular-nums">{r.atingimento_pct === null ? '—' : `${numero(r.atingimento_pct)}%`}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          )}

          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader title="Por território" subtitle="Território congelado na atribuição da venda." />
              {dados.por_territorio.length === 0 ? (
                <p className="px-4 py-6 text-sm text-muted">Nenhuma venda atribuída a território no período.</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="table">
                    <caption className="sr-only">Indicadores por território</caption>
                    <thead>
                      <tr>
                        <th scope="col" className="text-left">Território</th>
                        <th scope="col" className="text-right">Faturamento</th>
                        <th scope="col" className="text-right">Pedidos</th>
                      </tr>
                    </thead>
                    <tbody>
                      {dados.por_territorio.map((t) => (
                        <tr key={t.territorio_id}>
                          <td>{t.territorio}</td>
                          <td className="text-right tabular-nums">{moeda(t.faturamento)}</td>
                          <td className="text-right tabular-nums">{numero(t.pedidos)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>
            <Card>
              <CardHeader title="Por equipe" subtitle="Roll-up das vendas atribuídas a cada equipe." />
              {dados.por_equipe.length === 0 ? (
                <p className="px-4 py-6 text-sm text-muted">Nenhuma venda atribuída a equipe no período.</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="table">
                    <caption className="sr-only">Indicadores por equipe</caption>
                    <thead>
                      <tr>
                        <th scope="col" className="text-left">Equipe</th>
                        <th scope="col" className="text-right">Faturamento</th>
                        <th scope="col" className="text-right">Pedidos</th>
                      </tr>
                    </thead>
                    <tbody>
                      {dados.por_equipe.map((e) => (
                        <tr key={e.equipe_id}>
                          <td>{e.equipe}</td>
                          <td className="text-right tabular-nums">{moeda(e.faturamento)}</td>
                          <td className="text-right tabular-nums">{numero(e.pedidos)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>
          </div>
        </div>
      )}
    </div>
  );
}
