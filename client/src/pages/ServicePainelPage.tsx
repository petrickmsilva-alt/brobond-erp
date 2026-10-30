// ============================================================================
// PAINEL DE ATENDIMENTO (módulo /service/painel)
//
// Consome UM endpoint derivado (`GET /api/service/painel`): contagens por
// situação, tickets fora do SLA e tempo médio de resolução. Nada é recalculado
// no cliente — se o número está errado, está errado no servidor (fonte única).
//
// ZERO MODAL: painel é leitura pura. Nenhum formulário, nenhuma sobreposição.
// ============================================================================
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, Clock, Headphones, TrendingUp } from 'lucide-react';
import { api, ApiError } from '../lib/api';
import { Alert, PageHeader, Spinner } from '../components/ui';
import { StatCard } from '../components/ui-kit-negocios';
type Painel = {
  total: number;
  por_status: Record<string, number>;
  abertos: number;
  estourados: number;
  fora_do_sla_resposta: number;
  tempo_medio_resolucao_horas: number;
  gerado_em: string;
};

const rotuloStatus: Record<string, string> = {
  aberto: 'Aberto',
  em_atendimento: 'Em atendimento',
  aguardando_cliente: 'Aguardando cliente',
  resolvido: 'Resolvido',
  fechado: 'Fechado',
  cancelado: 'Cancelado',
};

export default function ServicePainelPage() {
  const [data, setData] = useState<Painel | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let ativo = true;
    api.get<Painel>('/service/painel')
      .then((r) => { if (ativo) setData(r); })
      .catch((e: unknown) => {
        if (ativo) setError(e instanceof ApiError ? e.message : 'Não foi possível carregar o painel.');
      })
      .finally(() => { if (ativo) setLoading(false); });
    return () => { ativo = false; };
  }, []);

  if (loading) return <Spinner label="Carregando painel de atendimento…" />;
  if (error) return <Alert tone="red">{error}</Alert>;
  if (!data) return null;

  return (
    <div className="min-w-0 space-y-4">
      <PageHeader
        title="Painel de atendimento"
        description="Indicadores calculados sobre os tickets reais da empresa ativa. Atualizado a cada consulta."
      />
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Tickets abertos" value={String(data.abertos)} icon={Headphones} />
        <StatCard label="Fora do SLA de resolução" value={String(data.estourados)} icon={AlertTriangle} />
        <StatCard label="Sem primeira resposta no prazo" value={String(data.fora_do_sla_resposta)} icon={Clock} />
        <StatCard label="Tempo médio de resolução" value={`${data.tempo_medio_resolucao_horas} h`} icon={TrendingUp} />
      </div>
      <section className="rounded-xl border border-line bg-surface p-4">
        <h2 className="mb-3 font-semibold">Por situação</h2>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr><th>Situação</th><th>Quantidade</th></tr>
            </thead>
            <tbody>
              {Object.entries(data.por_status).map(([st, qtd]) => (
                <tr key={st}>
                  <td>{rotuloStatus[st] || st}</td>
                  <td>{qtd}</td>
                </tr>
              ))}
              {!Object.keys(data.por_status).length && (
                <tr><td colSpan={2}>Nenhum ticket registrado.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
      <p className="text-xs text-muted">
        Total de tickets: {data.total} · gerado em {new Date(data.gerado_em).toLocaleString('pt-BR')} ·{' '}
        <Link className="text-blue-700 hover:underline" to="/service/tickets">ver tickets</Link>
      </p>
    </div>
  );
}
