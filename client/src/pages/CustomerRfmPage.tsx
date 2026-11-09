// ============================================================================
// ANÁLISE RFM (FASE 7 — CRM & SEGMENTAÇÃO)
//
// Consome UM endpoint derivado (`GET /api/customer-segments/rfm`): os quintis de
// recência, frequência e valor monetário são calculados no SERVIDOR sobre as
// vendas reais da empresa ativa. O navegador não recalcula nada — se o número
// está errado, está errado na fonte.
//
// RFM é leitura pura (ZERO MODAL). Clientes sem compra são contados à parte:
// não existe nota RFM sem histórico.
// ============================================================================
import { useEffect, useState } from 'react';
import { AlertTriangle, RefreshCw, Users } from 'lucide-react';
import { api, ApiError } from '../lib/api';
import { Alert, Badge, EmptyState, PageHeader, Spinner } from '../components/ui';
import { DataTable, PageShell, StatCard, type DataTableColumn } from '../components/ui-kit-negocios';

type Linha = {
  cliente_id: number;
  nome: string;
  recencia_dias: number | null;
  frequencia: number;
  receita_total: number;
  r: number;
  f: number;
  m: number;
  segmento: string;
};

type Resumo = { segmento: string; clientes: number; receita: number };

type Rfm = {
  base: number;
  sem_compra: number;
  cortes: { recencia: number[]; frequencia: number[]; valor: number[] } | null;
  resumo: Resumo[];
  clientes: Linha[];
  gerado_em: string;
};

const ROTULO_SEGMENTO: Record<string, string> = {
  campeoes: 'Campeões',
  leais: 'Leais',
  potenciais_leais: 'Potenciais leais',
  novos_promissores: 'Novos promissores',
  em_risco_alto_valor: 'Em risco (alto valor)',
  em_risco: 'Em risco',
  precisa_atencao: 'Precisa de atenção',
  hibernando: 'Hibernando',
};

const TOM_SEGMENTO: Record<string, 'green' | 'blue' | 'amber' | 'red' | 'slate'> = {
  campeoes: 'green',
  leais: 'green',
  potenciais_leais: 'blue',
  novos_promissores: 'blue',
  em_risco_alto_valor: 'red',
  em_risco: 'amber',
  precisa_atencao: 'amber',
  hibernando: 'slate',
};

const moeda = (v: number) => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(v || 0);

function Nota({ n }: { n: number }) {
  return (
    <span className="inline-flex h-6 w-6 items-center justify-center rounded-full border border-line text-xs font-semibold tabular-nums" title={`Nota ${n} de 5`}>
      {n}
    </span>
  );
}

export default function CustomerRfmPage() {
  const [dados, setDados] = useState<Rfm | null>(null);
  const [erro, setErro] = useState('');
  const [carregando, setCarregando] = useState(true);

  const carregar = () => {
    setCarregando(true);
    setErro('');
    api.get<Rfm>('/customer-segments/rfm')
      .then(setDados)
      .catch((e: unknown) => setErro(e instanceof ApiError ? e.message : 'Não foi possível carregar a análise RFM.'))
      .finally(() => setCarregando(false));
  };

  useEffect(() => { carregar(); }, []);

  const colunas: DataTableColumn<Linha>[] = [
    { key: 'nome', header: 'Cliente', render: (l) => <span className="font-medium">{l.nome}</span> },
    { key: 'r', header: 'R', render: (l) => <Nota n={l.r} /> },
    { key: 'f', header: 'F', render: (l) => <Nota n={l.f} /> },
    { key: 'm', header: 'M', render: (l) => <Nota n={l.m} /> },
    { key: 'recencia', header: 'Recência', render: (l) => <span className="tabular-nums">{l.recencia_dias ?? '—'} dia(s)</span> },
    { key: 'frequencia', header: 'Compras', render: (l) => <span className="tabular-nums">{l.frequencia}</span> },
    { key: 'receita', header: 'Receita', render: (l) => <span className="tabular-nums">{moeda(l.receita_total)}</span> },
    { key: 'segmento', header: 'Segmento', render: (l) => <Badge tone={TOM_SEGMENTO[l.segmento] ?? 'slate'}>{ROTULO_SEGMENTO[l.segmento] ?? l.segmento}</Badge> },
  ];

  return (
    <PageShell>
      <PageHeader
        title="Análise RFM"
        description="Recência, frequência e valor monetário em quintis (1 a 5) sobre as compras reais da empresa ativa. Os cortes saem da distribuição real — clientes sem compra não recebem nota."
        actions={
          <button type="button" className="btn-ghost" onClick={carregar}>
            <RefreshCw className="h-4 w-4" aria-hidden="true" /> Atualizar
          </button>
        }
      />

      {erro && <Alert tone="red">{erro}</Alert>}

      {carregando ? (
        <Spinner label="Calculando RFM…" />
      ) : !dados ? (
        <EmptyState icon={<AlertTriangle className="h-6 w-6" aria-hidden="true" />} title="Sem dados" description="Não foi possível calcular a análise." />
      ) : dados.base === 0 ? (
        <EmptyState
          icon={<Users className="h-6 w-6" aria-hidden="true" />}
          title="Sem clientes com compra"
          description="A base ainda não tem compras faturadas suficientes para calcular quintis de RFM."
        />
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-3">
            <StatCard label="Clientes na base RFM" value={String(dados.base)} icon={Users} />
            <StatCard label="Clientes sem compra" value={String(dados.sem_compra)} icon={Users} />
            <StatCard label="Segmentos" value={String(dados.resumo.length)} icon={Users} />
          </div>

          <section className="rounded-xl border border-line bg-surface p-4">
            <h2 className="mb-3 text-sm font-semibold">Resumo por segmento</h2>
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {dados.resumo.map((s) => (
                <div key={s.segmento} className="rounded-lg border border-line p-3">
                  <div className="flex items-center justify-between">
                    <span className="font-medium">{ROTULO_SEGMENTO[s.segmento] ?? s.segmento}</span>
                    <Badge tone={TOM_SEGMENTO[s.segmento] ?? 'slate'}>{s.clientes}</Badge>
                  </div>
                  <div className="mt-1 text-xs text-muted">Receita: {moeda(s.receita)}</div>
                </div>
              ))}
            </div>
          </section>

          <DataTable
            caption="Clientes por RFM"
            columns={colunas}
            rows={dados.clientes}
            getRowKey={(l) => String(l.cliente_id)}
            empty="Nenhum cliente na base RFM."
          />

          <p className="text-xs text-muted">
            Gerado em {new Date(dados.gerado_em).toLocaleString('pt-BR')}. Cortes de recência (dias): {dados.cortes?.recencia.join(' · ')}.
          </p>
        </>
      )}
    </PageShell>
  );
}
