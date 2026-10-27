// ============================================================================
// ACOMPANHAMENTO DE META (MA-04) — página própria, somente leitura.
//
// Mostra o que a meta significa em número:
//   meta · realizado (DERIVADO das vendas faturadas) · variação · % atingimento
//   · quanto falta · distribuição mensal do planejado
//
// NADA aqui é digitável. O realizado vem de `GET /api/comercial/metas/:id/acompanhamento`,
// que apura no servidor a partir das vendas faturadas no período, recortadas
// pelo alvo (representante/equipe/território/empresa) e pelo recorte
// (produto/categoria/coleção). A tela só formata — não recalcula indicador.
// ============================================================================
import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Loader2, RefreshCw, Target } from 'lucide-react';
import { api, ApiError } from '../lib/api';
import { Alert, Badge, EmptyState, PageHeader, useToast } from '../components/ui';
import { Card, CardHeader } from '../components/ui-kit-negocios';
import { BarrasVerticais } from '../components/Charts';

type Indicadores = {
  faturamento: number;
  pedidos: number;
  clientes: number;
  pecas: number;
  ticket_medio: number;
  comissao: number;
  por_representante: {
    representante_id: number;
    representante: string;
    faturamento: number;
    pedidos: number;
    clientes: number;
    ticket_medio: number;
    comissao: number;
  }[];
};

type Acompanhamento = {
  meta: Record<string, any>;
  metrica: string;
  meta_valor: number;
  realizado: number;
  variacao: number;
  atingimento_pct: number | null;
  falta: number;
  dias_periodo: number;
  distribuicao_mensal: { mes: string; dias: number; meta: number }[];
  indicadores: Indicadores;
};

const ROTULO_METRICA: Record<string, string> = {
  faturamento: 'Faturamento',
  quantidade: 'Quantidade (peças)',
  margem: 'Margem',
  pedidos: 'Pedidos',
  clientes: 'Clientes atendidos',
};

const moeda = (v: number) => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(v || 0);
const numero = (v: number) => new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 2 }).format(v || 0);

export default function MetaAcompanhamentoPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const [dados, setDados] = useState<Acompanhamento | null>(null);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState('');

  const carregar = useCallback(async () => {
    setCarregando(true);
    try {
      const d = await api.get<Acompanhamento>(`/comercial/metas/${id}/acompanhamento`);
      setDados(d);
      setErro('');
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : 'Não foi possível carregar o acompanhamento.';
      setErro(msg);
      toast.error(msg);
    } finally {
      setCarregando(false);
    }
  }, [id, toast]);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  const ehMoeda = dados ? ['faturamento', 'margem'].includes(dados.metrica) : true;
  const fmt = (v: number) => (ehMoeda ? moeda(v) : numero(v));

  return (
    <div className="p-4 sm:p-6">
      <PageHeader
        title={dados?.meta?.nome ? `Acompanhamento — ${dados.meta.nome}` : 'Acompanhamento de meta'}
        description="O realizado é calculado a partir das vendas faturadas do período. Nenhum número desta tela é digitado."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" className="btn-secondary inline-flex" onClick={() => navigate('/metas')}>
              <ArrowLeft className="h-4 w-4" /> Voltar às metas
            </button>
            <button type="button" className="btn-secondary inline-flex" onClick={() => void carregar()} disabled={carregando}>
              {carregando ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />} Atualizar
            </button>
          </div>
        }
      />

      {erro && (
        <div className="mb-4">
          <Alert tone="red">{erro}</Alert>
        </div>
      )}

      {carregando && !dados ? (
        <div className="flex items-center justify-center py-16 text-sm text-muted">
          <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Apurando realizado…
        </div>
      ) : !dados ? (
        <EmptyState icon={<Target className="h-6 w-6" />} title="Meta não encontrada" description="Verifique se a meta ainda existe nesta empresa." />
      ) : (
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Card className="p-4">
              <p className="text-xs uppercase tracking-wide text-muted">Meta</p>
              <p className="mt-1 text-2xl font-bold tabular-nums text-navy-900 dark:text-white">{fmt(dados.meta_valor)}</p>
              <p className="mt-1 text-xs text-muted">{ROTULO_METRICA[dados.metrica] ?? dados.metrica}</p>
            </Card>
            <Card className="p-4">
              <p className="text-xs uppercase tracking-wide text-muted">Realizado (derivado)</p>
              <p className="mt-1 text-2xl font-bold tabular-nums text-navy-900 dark:text-white">{fmt(dados.realizado)}</p>
              <p className="mt-1 text-xs text-muted">
                {dados.meta?.periodo_inicio} → {dados.meta?.periodo_fim} · {dados.dias_periodo} dia(s)
              </p>
            </Card>
            <Card className="p-4">
              <p className="text-xs uppercase tracking-wide text-muted">Atingimento</p>
              <p className="mt-1 text-2xl font-bold tabular-nums text-navy-900 dark:text-white">
                {dados.atingimento_pct === null ? '—' : `${numero(dados.atingimento_pct)}%`}
              </p>
              <p className="mt-1">
                {dados.atingimento_pct === null ? (
                  <Badge tone="slate">Sem meta definida</Badge>
                ) : dados.atingimento_pct >= 100 ? (
                  <Badge tone="green">Meta atingida</Badge>
                ) : dados.atingimento_pct >= 70 ? (
                  <Badge tone="amber">Em andamento</Badge>
                ) : (
                  <Badge tone="red">Abaixo do esperado</Badge>
                )}
              </p>
            </Card>
            <Card className="p-4">
              <p className="text-xs uppercase tracking-wide text-muted">Variação / falta</p>
              <p className="mt-1 text-2xl font-bold tabular-nums text-navy-900 dark:text-white">{fmt(dados.variacao)}</p>
              <p className="mt-1 text-xs text-muted">Falta {fmt(dados.falta)} para a meta</p>
            </Card>
          </div>

          <Card>
            <CardHeader
              title="Distribuição mensal do planejado"
              subtitle={
                dados.meta?.distribuicao === 'unica'
                  ? 'Meta única do período (sem rateio mensal).'
                  : 'Rateio proporcional aos dias de cada mês — planejamento, não realizado.'
              }
              icon={Target}
            />
            {dados.meta?.distribuicao === 'unica' || dados.distribuicao_mensal.length === 0 ? (
              <p className="px-4 py-6 text-sm text-muted">Sem distribuição mensal para esta meta.</p>
            ) : (
              <div className="px-4 py-4">
                <BarrasVerticais
                  rotulos={dados.distribuicao_mensal.map((m) => m.mes)}
                  valores={dados.distribuicao_mensal.map((m) => m.meta)}
                  formatar={fmt}
                  titulo="Meta por mês"
                />
              </div>
            )}
          </Card>

          <Card>
            <CardHeader title="Vendas do período" subtitle="Somente vendas faturadas ou entregues entram no realizado." icon={Target} />
            <div className="overflow-x-auto">
              <table className="table">
                <caption className="sr-only">Indicadores do período da meta</caption>
                <thead>
                  <tr>
                    <th scope="col" className="text-left">Indicador</th>
                    <th scope="col" className="text-right">Valor</th>
                  </tr>
                </thead>
                <tbody>
                  <tr><td>Faturamento</td><td className="text-right tabular-nums">{moeda(dados.indicadores.faturamento)}</td></tr>
                  <tr><td>Pedidos</td><td className="text-right tabular-nums">{numero(dados.indicadores.pedidos)}</td></tr>
                  <tr><td>Peças</td><td className="text-right tabular-nums">{numero(dados.indicadores.pecas)}</td></tr>
                  <tr><td>Clientes atendidos</td><td className="text-right tabular-nums">{numero(dados.indicadores.clientes)}</td></tr>
                  <tr><td>Ticket médio</td><td className="text-right tabular-nums">{moeda(dados.indicadores.ticket_medio)}</td></tr>
                  <tr><td>Comissão apurada (congelada na venda)</td><td className="text-right tabular-nums">{moeda(dados.indicadores.comissao)}</td></tr>
                </tbody>
              </table>
            </div>
          </Card>

          {dados.indicadores.por_representante.length > 0 && (
            <Card>
              <CardHeader title="Por representante" subtitle="Participação proporcional quando a venda tem atribuição compartilhada." />
              <div className="overflow-x-auto">
                <table className="table">
                  <caption className="sr-only">Indicadores por representante</caption>
                  <thead>
                    <tr>
                      <th scope="col" className="text-left">Representante</th>
                      <th scope="col" className="text-right">Faturamento</th>
                      <th scope="col" className="text-right">Pedidos</th>
                      <th scope="col" className="text-right">Clientes</th>
                      <th scope="col" className="text-right">Ticket médio</th>
                      <th scope="col" className="text-right">Comissão</th>
                    </tr>
                  </thead>
                  <tbody>
                    {dados.indicadores.por_representante.map((r) => (
                      <tr key={r.representante_id}>
                        <td>{r.representante}</td>
                        <td className="text-right tabular-nums">{moeda(r.faturamento)}</td>
                        <td className="text-right tabular-nums">{numero(r.pedidos)}</td>
                        <td className="text-right tabular-nums">{numero(r.clientes)}</td>
                        <td className="text-right tabular-nums">{moeda(r.ticket_medio)}</td>
                        <td className="text-right tabular-nums">{moeda(r.comissao)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          )}
        </div>
      )}
    </div>
  );
}
