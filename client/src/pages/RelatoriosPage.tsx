import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { BarChart3, Download, Loader2, RefreshCw, Table2 } from 'lucide-react';
import { api, downloadFile } from '../lib/api';
import { Alert, PageHeader, Spinner, useToast } from '../components/ui';
import { formatDate, formatMoney, formatNumber } from '../lib/format';

type Coluna = { key: string; label: string; tipo?: 'text' | 'money' | 'number' | 'percent' | 'date' | 'boolean' };
type RelResp = { nome: string; titulo: string; colunas: Coluna[]; linhas: Record<string, any>[]; resumo: Record<string, any> | null };

const RELATORIOS: { nome: string; rotulo: string; desc: string }[] = [
  { nome: 'estoque-posicao', rotulo: 'Posição de estoque (valorizado)', desc: 'Peças e valor a custo por produto, local, categoria ou coleção.' },
  { nome: 'movimentacoes-periodo', rotulo: 'Movimentações por período', desc: 'Entradas, saídas, ajustes e transferências em um intervalo.' },
  { nome: 'producao-periodo', rotulo: 'Produção concluída', desc: 'OPs concluídas e peças produzidas por período.' },
  { nome: 'vendas', rotulo: 'Vendas (faturadas)', desc: 'Valor e comissão por cliente, representante, coleção ou categoria.' },
  { nome: 'abc', rotulo: 'Curva ABC de produtos', desc: 'Produtos por faturamento com percentual e classe A/B/C.' },
  { nome: 'insumos-minimo', rotulo: 'Insumos abaixo do mínimo', desc: 'Insumos em alerta por local/estoque geral, com o quanto falta.' },
];

const RESUMO_LABEL: Record<string, string> = {
  pecas: 'Peças',
  valor: 'Valor (custo)',
  registros: 'Registros',
  ordens: 'OPs',
  comissao: 'Comissão',
  faturamento: 'Faturamento',
  itens: 'Linhas',
};

type Filtros = Record<string, string>;

type Controle = { tipo: 'de' | 'ate' | 'local' | 'select'; name?: string; opcoes?: { value: string; label: string }[] };
const CONTROLES: Record<string, Controle[]> = {
  'estoque-posicao': [
    { tipo: 'select', name: 'grupo', opcoes: [
      { value: 'produto', label: 'Agrupar por produto' },
      { value: 'local', label: 'Agrupar por local' },
      { value: 'categoria', label: 'Agrupar por categoria' },
      { value: 'colecao', label: 'Agrupar por coleção' },
    ] },
    { tipo: 'local' },
  ],
  'movimentacoes-periodo': [
    { tipo: 'de' },
    { tipo: 'ate' },
    { tipo: 'select', name: 'tipo', opcoes: [
      { value: '', label: 'Todos os tipos' },
      { value: 'entrada', label: 'Entradas' },
      { value: 'saida', label: 'Saídas' },
      { value: 'ajuste', label: 'Ajustes' },
    ] },
    { tipo: 'local' },
  ],
  'producao-periodo': [{ tipo: 'de' }, { tipo: 'ate' }],
  vendas: [
    { tipo: 'de' },
    { tipo: 'ate' },
    { tipo: 'select', name: 'por', opcoes: [
      { value: 'cliente', label: 'Por cliente' },
      { value: 'representante', label: 'Por representante' },
      { value: 'colecao', label: 'Por coleção' },
      { value: 'categoria', label: 'Por categoria' },
    ] },
  ],
  abc: [],
  'insumos-minimo': [],
};

export default function RelatoriosPage() {
  const toast = useToast();
  const [params] = useSearchParams();
  const inicial = RELATORIOS.some((r) => r.nome === (params.get('relatorio') || '')) ? params.get('relatorio')! : 'estoque-posicao';
  const [nome, setNome] = useState(inicial);
  const [filtros, setFiltros] = useState<Filtros>({ grupo: 'produto', tipo: '', de: '', ate: '', local: '', por: 'cliente' });
  const [data, setData] = useState<RelResp | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [locais, setLocais] = useState<{ value: number; label: string }[]>([]);

  const rel = RELATORIOS.find((r) => r.nome === nome)!;

  const carregar = useCallback(
    async (nm: string, fs: Filtros) => {
      setLoading(true);
      setError('');
      try {
        const params = new URLSearchParams();
        for (const [k, v] of Object.entries(fs)) if (v) params.set(k, v);
        const d = await api.get<RelResp>(`/relatorios/${nm}?${params.toString()}`);
        setData(d);
      } catch (e: any) {
        setError(e.message || 'Erro ao gerar o relatório.');
      } finally {
        setLoading(false);
      }
    },
    []
  );

  useEffect(() => {
    carregar(nome, filtros);
  }, [nome, filtros, carregar]);

  useEffect(() => {
    api
      .get<{ value: number; label: string }[]>('/locais/options')
      .then(setLocais)
      .catch(() => {});
  }, []);

  function setFiltro(chave: string, valor: string) {
    setFiltros((f) => ({ ...f, [chave]: valor }));
  }

  async function exportar(formato: 'csv' | 'xlsx') {
    try {
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(filtros)) if (v) params.set(k, v);
      await downloadFile(`/relatorios/${nome}?format=${formato}&${params.toString()}`, `${nome}.${formato}`);
      toast.success(`Relatório exportado em ${formato.toUpperCase()}.`);
    } catch (e: any) {
      toast.error(e.message || 'Não foi possível exportar.');
    }
  }

  return (
    <div className="p-4 pb-20 sm:p-6 md:pb-6">
      <PageHeader
        title={
          <span className="flex items-center gap-2.5">
            <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-navy-800 text-white">
              <BarChart3 className="h-5 w-5" />
            </span>
            Relatórios
          </span>
        }
        description="Visões de estoque, produção e vendas. Exporte em CSV (Excel) ou XLSX."
        actions={
          <>
            <button className="btn-secondary" onClick={() => carregar(nome, filtros)} disabled={loading}>
              <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} /> Atualizar
            </button>
            <button className="btn-secondary" onClick={() => exportar('csv')} disabled={!data}>
              <Download className="h-4 w-4" /> CSV
            </button>
            <button className="btn-secondary" onClick={() => exportar('xlsx')} disabled={!data}>
              <Download className="h-4 w-4 text-emerald-600" /> XLSX
            </button>
          </>
        }
      />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[260px_1fr]">
        <aside className="space-y-1">
          {RELATORIOS.map((r) => (
            <button
              key={r.nome}
              onClick={() => {
                setNome(r.nome);
                setData(null);
              }}
              className={`w-full rounded-xl border p-3 text-left transition-colors ${nome === r.nome ? 'border-brand-300 bg-brand-50' : 'border-slate-200 bg-white hover:border-slate-300'}`}
            >
              <div className="flex items-center gap-2 text-sm font-semibold text-navy-900">
                <Table2 className={`h-4 w-4 ${nome === r.nome ? 'text-brand-600' : 'text-slate-400'}`} />
                {r.rotulo}
              </div>
              <p className="mt-1 text-xs text-slate-500">{r.desc}</p>
            </button>
          ))}
        </aside>

        <div className="min-w-0">
          {/* Filtros */}
          <div className="mb-4 flex flex-wrap items-end gap-3 rounded-xl border border-slate-200 bg-white p-3">
            {(CONTROLES[nome] || []).map((c, i) => {
              if (c.tipo === 'de' || c.tipo === 'ate')
                return (
                  <label key={i} className="block">
                    <span className="label">{c.tipo === 'de' ? 'De' : 'Até'}</span>
                    <input type="date" className="input" value={filtros[c.tipo] || ''} onChange={(e) => setFiltro(c.tipo, e.target.value)} />
                  </label>
                );
              if (c.tipo === 'local')
                return (
                  <label key={i} className="block">
                    <span className="label">Local</span>
                    <select className="input" value={filtros.local || ''} onChange={(e) => setFiltro('local', e.target.value)}>
                      <option value="">Todos</option>
                      {locais.map((o) => (
                        <option key={o.value} value={o.label}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                  </label>
                );
              const campo = c.name || '';
              return (
                <label key={i} className="block">
                  <span className="label">Opções</span>
                  <select className="input" value={filtros[campo] ?? ''} onChange={(e) => setFiltro(campo, e.target.value)}>
                    {c.opcoes?.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                </label>
              );
            })}
            {error && <div className="w-full"><Alert tone="red">{error}</Alert></div>}
          </div>

          {!data && !error && <Spinner label="Gerando relatório..." />}

          {data && (
            <div className="card overflow-hidden">
              <div className="border-b border-slate-200 px-4 py-3">
                <h2 className="text-sm font-bold text-navy-900">{data.titulo}</h2>
                {data.resumo && (
                  <div className="mt-2 flex flex-wrap gap-2 text-xs">
                    {Object.entries(data.resumo).map(([k, v]) => (
                      <span key={k} className="rounded-lg bg-slate-50 px-2.5 py-1 text-slate-600">
                        {RESUMO_LABEL[k] || k}: <strong className="tabular-nums text-navy-900">{formataResumo(k, v)}</strong>
                      </span>
                    ))}
                  </div>
                )}
              </div>
              {data.linhas.length === 0 ? (
                <div className="p-10 text-center text-sm text-slate-400">Nenhum registro para os filtros selecionados.</div>
              ) : (
                <div className="max-h-[70vh] overflow-auto">
                  <table className="table">
                    <thead className="sticky top-0">
                      <tr>
                        {data.colunas.map((c) => (
                          <th key={c.key}>{c.label}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {data.linhas.map((l, i) => (
                        <tr key={i}>
                          {data.colunas.map((c) => (
                            <td key={c.key} className={c.tipo === 'money' || c.tipo === 'number' || c.tipo === 'percent' ? 'text-right tabular-nums' : ''}>
                              {valorCelula(c, l[c.key])}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {data.linhas.length >= 1000 && <div className="border-t border-slate-100 px-4 py-2 text-xs text-slate-400">Exibindo as primeiras 1.000 linhas (exporte para ver tudo).</div>}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function valorCelula(c: Coluna, v: unknown): React.ReactNode {
  if (v === null || v === undefined || v === '') return <span className="text-slate-300">—</span>;
  switch (c.tipo) {
    case 'money':
      return formatMoney(v);
    case 'number':
      return formatNumber(v);
    case 'percent':
      return `${formatNumber(v)}%`;
    case 'date':
      return formatDate(v);
    case 'boolean':
      return v ? 'Sim' : 'Não';
    default:
      return String(v);
  }
}

function formataResumo(k: string, v: unknown): string {
  if (k === 'valor' || k === 'comissao' || k === 'faturamento') return formatMoney(v);
  return formatNumber(v);
}
