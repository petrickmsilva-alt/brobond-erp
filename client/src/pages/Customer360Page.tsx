// ============================================================================
// CUSTOMER 360 (rota /clientes/:id/360)
//
// Consome UM endpoint derivado (`GET /api/customer360/:id`): receita, pedidos,
// ticket médio, frequência, recência, LTV, produtos, categorias, devoluções,
// pagamentos, tickets, interações e canais. Nenhum número é inventado no
// cliente — tudo vem do servidor (fonte única, recortado pela empresa ativa).
//
// ZERO MODAL: leitura pura, em página própria.
// ============================================================================
import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { Alert, PageHeader, Spinner } from '../components/ui';
import { StatCard } from '../components/ui-kit-negocios';
import { formatMoney } from '../lib/format';

type Metricas = {
  receita_total: number;
  pedidos: number;
  ticket_medio: number;
  primeira_compra: string | null;
  ultima_compra: string | null;
  recencia_dias: number | null;
  frequencia: number;
  ltv: number;
  devolucoes: number;
  tickets: number;
};
type Produto = { produto_id: number; nome: string; categoria: string | null; quantidade: number; receita: number };
type Ticket = { id: number; numero: string | null; assunto: string; status: string; prioridade: string; canal: string; criado_em: string; resolvido_em: string | null };
type Devolucao = { id: number; numero: string | null; status: string; motivo: string; criado_em: string };
type Customer360 = {
  cliente: { id: number; nome: string; email: string | null; telefone: string | null; tipo: string | null };
  metricas: Metricas;
  produtos: Produto[];
  devolucoes: Devolucao[];
  tickets: Ticket[];
  interacoes: { id: number; ticket_id: number; tipo: string; mensagem: string | null; criado_em: string }[];
  canais: string[];
  gerado_em: string;
};

const dataCurta = (v: string | null) => (v ? new Date(v).toLocaleDateString('pt-BR') : '—');

export default function Customer360Page() {
  const { id } = useParams();
  const [data, setData] = useState<Customer360 | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let ativo = true;
    setLoading(true);
    api.get<Customer360>(`/customer360/${id}`)
      .then((r) => { if (ativo) setData(r); })
      .catch((e: unknown) => { if (ativo) setError(e instanceof ApiError ? e.message : 'Não foi possível carregar o Customer 360.'); })
      .finally(() => { if (ativo) setLoading(false); });
    return () => { ativo = false; };
  }, [id]);

  if (loading) return <Spinner label="Carregando Customer 360…" />;
  if (error) return <Alert tone="red">{error}</Alert>;
  if (!data) return null;
  const m = data.metricas;

  return (
    <div className="min-w-0 space-y-4">
      <PageHeader
        title={`Customer 360 — ${data.cliente.nome}`}
        description="Visão consolidada do cliente a partir de pedidos, pagamentos, devoluções e atendimento reais."
      />
      <Link className="text-sm text-blue-700 hover:underline" to={`/clientes/${id}`}>← Voltar ao cliente</Link>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Receita total" value={formatMoney(m.receita_total)} />
        <StatCard label="Pedidos" value={String(m.pedidos)} />
        <StatCard label="Ticket médio" value={formatMoney(m.ticket_medio)} />
        <StatCard label="LTV" value={formatMoney(m.ltv)} />
        <StatCard label="Frequência" value={String(m.frequencia)} />
        <StatCard label="Recência" value={m.recencia_dias === null ? '—' : `${m.recencia_dias} dias`} />
        <StatCard label="Devoluções" value={String(m.devolucoes)} />
        <StatCard label="Tickets" value={String(m.tickets)} />
      </div>
      <p className="text-xs text-muted">
        Primeira compra: {dataCurta(m.primeira_compra)} · Última compra: {dataCurta(m.ultima_compra)} · Canais:{' '}
        {data.canais.length ? data.canais.join(', ') : 'não informados'}
      </p>

      <section className="rounded-xl border border-line bg-surface p-4">
        <h2 className="mb-3 font-semibold">Produtos mais comprados</h2>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead><tr><th>Produto</th><th>Categoria</th><th>Quantidade</th><th>Receita</th></tr></thead>
            <tbody>
              {data.produtos.map((p) => (
                <tr key={p.produto_id}><td>{p.nome}</td><td>{p.categoria || '—'}</td><td>{p.quantidade}</td><td>{formatMoney(p.receita)}</td></tr>
              ))}
              {!data.produtos.length && <tr><td colSpan={4}>Nenhuma compra registrada.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>

      <section className="rounded-xl border border-line bg-surface p-4">
        <h2 className="mb-3 font-semibold">Atendimento</h2>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead><tr><th>Número</th><th>Assunto</th><th>Situação</th><th>Prioridade</th><th>Canal</th><th>Aberto em</th></tr></thead>
            <tbody>
              {data.tickets.map((t) => (
                <tr key={t.id}><td>{t.numero || `#${t.id}`}</td><td>{t.assunto}</td><td>{t.status}</td><td>{t.prioridade}</td><td>{t.canal}</td><td>{dataCurta(t.criado_em)}</td></tr>
              ))}
              {!data.tickets.length && <tr><td colSpan={6}>Nenhum ticket para este cliente.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>

      <section className="rounded-xl border border-line bg-surface p-4">
        <h2 className="mb-3 font-semibold">Devoluções</h2>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead><tr><th>Número</th><th>Situação</th><th>Motivo</th><th>Criada em</th></tr></thead>
            <tbody>
              {data.devolucoes.map((d) => (
                <tr key={d.id}><td>{d.numero || `#${d.id}`}</td><td>{d.status}</td><td>{d.motivo}</td><td>{dataCurta(d.criado_em)}</td></tr>
              ))}
              {!data.devolucoes.length && <tr><td colSpan={4}>Nenhuma devolução registrada.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
