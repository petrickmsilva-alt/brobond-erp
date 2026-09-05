import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, ArrowLeftRight, Boxes, ClipboardCheck, Download, FileUp, History, Loader2, Package, RefreshCw, RotateCcw, Search, Warehouse, Wallet } from 'lucide-react';
import { api, downloadFile } from '../lib/api';
import { useMeta } from '../lib/meta';
import { Alert, Badge, ConfirmDialog, Modal, PageHeader, Spinner, useToast } from '../components/ui';
import { IMPORT_TIPOS, ImportModal } from '../components/ImportModal';
import { formatMoney, formatNumber } from '../lib/format';
import { formatDateTime } from '../lib/format';

type GradeResp = {
  colunas: { id: number; codigo: string }[];
  local: string;
  locaisDisponiveis: string[];
  totalPecas: number;
  linhas: {
    produto: { id: number; sku: string; nome: string; cor: string | null; cor_hex: string | null; categoria_id__label: string | null; colecao_id__label: string | null; foto_url: string | null; preco_venda: number; custo: number };
    celulas: { tamanho_id: number; quantidade: number; estoque_min: number }[];
    total: number;
  }[];
};

type Cel = { produto: GradeResp['linhas'][number]['produto']; tamanho: { id: number; codigo: string }; quantidade: number; estoque_min: number; local: string };

function num(v: unknown): number {
  const n = Number(String(v ?? '').replace(',', '.'));
  return Number.isFinite(n) ? n : 0;
}

export default function EstoqueGradePage() {
  const toast = useToast();
  const meta = useMeta();
  const [data, setData] = useState<GradeResp | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [local, setLocal] = useState('');
  const [colecaoId, setColecaoId] = useState('');
  const [categoriaId, setCategoriaId] = useState('');
  const [q, setQ] = useState('');
  const [soAlertas, setSoAlertas] = useState(false);
  const [opts, setOpts] = useState<Record<string, { value: number; label: string }[]>>({});
  const [cel, setCel] = useState<Cel | null>(null);
  const tipoImport = IMPORT_TIPOS.find((t) => t.recurso === 'estoques');
  const [importOpen, setImportOpen] = useState(false);
  const [mov, setMov] = useState({ tipo: 'ajuste', quantidade: '1', motivo: 'Ajuste pela grade de estoque' });
  const [movErr, setMovErr] = useState('');
  const [salvando, setSalvando] = useState(false);
  const [historico, setHistorico] = useState<any[]>([]);
  const [carregandoHistorico, setCarregandoHistorico] = useState(false);
  const [historicoErr, setHistoricoErr] = useState('');
  // Identifica a requisição de histórico mais recente (evita que uma resposta
  // atrasada de uma célula anterior sobrescreva a célula aberta agora).
  const historicoReq = useRef(0);
  const [movParaEstornar, setMovParaEstornar] = useState<any>(null);
  const [estornando, setEstornando] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams();
      if (local) params.set('local', local);
      if (colecaoId) params.set('colecao_id', colecaoId);
      if (categoriaId) params.set('categoria_id', categoriaId);
      const d = await api.get<GradeResp>(`/estoques/grade?${params.toString()}`);
      setData(d);
      if (!local && d.locaisDisponiveis.length) setLocal((l) => l || '');
    } catch (e: any) {
      setError(e.message || 'Erro ao carregar a grade.');
    } finally {
      setLoading(false);
    }
  }, [local, colecaoId, categoriaId]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    Promise.all([
      api.get<{ value: number; label: string }[]>('/colecoes/options').then((o) => ({ k: 'colecoes', o })),
      api.get<{ value: number; label: string }[]>('/categorias/options').then((o) => ({ k: 'categorias', o })),
      api.get<{ value: number; label: string }[]>('/locais/options').then((o) => ({ k: 'locais', o })),
    ])
      .then((pairs) => setOpts(Object.fromEntries(pairs.map((p) => [p.k, p.o]))))
      .catch(() => {});
    try {
      const prefs = JSON.parse(localStorage.getItem('brobond_prefs') || '{}');
      if (prefs.gradeLocal) setLocal((l) => l || String(prefs.gradeLocal));
    } catch {
      /* sem preferência salva */
    }
  }, []);

  useEffect(() => {
    if (!local) return;
    try {
      const prefs = JSON.parse(localStorage.getItem('brobond_prefs') || '{}');
      prefs.gradeLocal = local;
      localStorage.setItem('brobond_prefs', JSON.stringify(prefs));
    } catch {
      /* ok */
    }
  }, [local]);

  // Cockpit — KPIs calculados a partir da própria grade
  const alertasGrade = useMemo(() => {
    if (!data) return [] as { produto: GradeResp['linhas'][number]['produto']; tamanho: string; quantidade: number; estoque_min: number; faltando: number }[];
    const out: { produto: GradeResp['linhas'][number]['produto']; tamanho: string; quantidade: number; estoque_min: number; faltando: number }[] = [];
    const codPorId = new Map(data.colunas.map((c) => [c.id, c.codigo]));
    for (const l of data.linhas) {
      for (const c of l.celulas) {
        if (c.estoque_min > 0 && c.quantidade <= c.estoque_min) {
          out.push({ produto: l.produto, tamanho: codPorId.get(c.tamanho_id) || `#${c.tamanho_id}`, quantidade: c.quantidade, estoque_min: c.estoque_min, faltando: c.estoque_min - c.quantidade });
        }
      }
    }
    return out.sort((a, b) => b.faltando - a.faltando);
  }, [data]);

  const valorEstoque = useMemo(() => (data ? data.linhas.reduce((a, l) => a + l.total * Number(l.produto.custo || 0), 0) : 0), [data]);
  const valorVenda = useMemo(() => (data ? data.linhas.reduce((a, l) => a + l.total * Number(l.produto.preco_venda || 0), 0) : 0), [data]);

  const linhasVisiveis = useMemo(() => {
    if (!data) return [];
    const term = q.trim().toLowerCase();
    return data.linhas.filter((l) => {
      if (soAlertas && !l.celulas.some((c) => c.estoque_min > 0 && c.quantidade <= c.estoque_min)) return false;
      if (!term) return true;
      return `${l.produto.sku} ${l.produto.nome} ${l.produto.cor || ''} ${l.produto.categoria_id__label || ''}`.toLowerCase().includes(term);
    });
  }, [data, q, soAlertas]);

  async function lancarMovimentacao() {
    if (!cel) return;
    const qtd = num(mov.quantidade);
    if (!(qtd > 0)) return setMovErr('Informe uma quantidade maior que zero.');
    setSalvando(true);
    setMovErr('');
    try {
      await api.post('/movimentacoes', {
        tipo: mov.tipo,
        produto_id: cel.produto.id,
        tamanho_id: cel.tamanho.id,
        local: cel.local,
        quantidade: qtd,
        motivo: mov.motivo || undefined,
      });
      toast.success(`${mov.tipo === 'entrada' ? 'Entrada' : mov.tipo === 'saida' ? 'Saída' : 'Ajuste'} de ${formatNumber(qtd)} lançado(a).`);
      setCel(null);
      await load();
    } catch (e: any) {
      setMovErr(e.message || 'Não foi possível lançar a movimentação.');
    } finally {
      setSalvando(false);
    }
  }

  function abrirCelula(linha: GradeResp['linhas'][number], tamanho: { id: number; codigo: string }) {
    const c = linha.celulas.find((x) => x.tamanho_id === tamanho.id);
    const localEscolhido = local || meta?.defaultLocal?.nome || 'almoxarifado';
    setCel({ produto: linha.produto, tamanho, quantidade: c?.quantidade ?? 0, estoque_min: c?.estoque_min ?? 0, local: localEscolhido });
    setMov({ tipo: 'ajuste', quantidade: '1', motivo: 'Ajuste pela grade de estoque' });
    setMovErr('');
    // Carrega as últimas movimentações desta célula
    carregarHistorico(linha.produto.id, tamanho.id);
  }

  const carregarHistorico = useCallback(async (produtoId: number, tamanhoId: number) => {
    const req = ++historicoReq.current;
    setCarregandoHistorico(true);
    setHistoricoErr('');
    setHistorico([]);
    try {
      const params = new URLSearchParams({
        pageSize: '50',
        sort: 'id',
        dir: 'desc',
        'f.produto_id': String(produtoId),
        'f.tamanho_id': String(tamanhoId),
      });
      const resp = await api.get<any>(`/movimentacoes?${params.toString()}`);
      if (req !== historicoReq.current) return; // resposta obsoleta
      setHistorico(Array.isArray(resp?.rows) ? resp.rows.slice(0, 10) : []);
    } catch (e: any) {
      if (req !== historicoReq.current) return;
      setHistorico([]);
      setHistoricoErr(e?.message || 'Não foi possível carregar o histórico desta célula.');
    } finally {
      if (req === historicoReq.current) setCarregandoHistorico(false);
    }
  }, []);

  async function estornarMovimento(mov: any) {
    setEstornando(true);
    try {
      await api.post(`/movimentacoes/${mov.id}/estornar`, {});
      toast.success('Movimentação estornada. O saldo foi ajustado automaticamente.');
      setMovParaEstornar(null);
      if (cel) {
        carregarHistorico(cel.produto.id, cel.tamanho.id);
      }
      await load();
    } catch (e: any) {
      toast.error(e.message || 'Não foi possível estornar.');
      setMovParaEstornar(null);
    } finally {
      setEstornando(false);
    }
  }

  return (
    <div className="p-4 pb-24 sm:p-6 md:pb-6">
      <PageHeader
        title={
          <span className="flex items-center gap-2.5">
            <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-navy-800 text-white">
              <Warehouse className="h-5 w-5" />
            </span>
            Estoque Físico — Grade
          </span>
        }
        description="Matriz de saldo por produto × tamanho. Clique em uma célula para lançar entrada, saída ou ajuste."
        actions={
          <>
            <button className="btn-secondary" onClick={load} disabled={loading}>
              <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} /> Atualizar
            </button>
            <button
              className="btn-secondary"
              onClick={() => downloadFile(`/estoques/export?format=csv${local ? `&f.local=${encodeURIComponent(local)}` : ''}`, 'estoques.csv').catch((e) => toast.error(e.message))}
            >
              <Download className="h-4 w-4" /> Exportar
            </button>
            {tipoImport && (
              <button className="btn-secondary" onClick={() => setImportOpen(true)} title="Importar saldos iniciais de CSV/XLSX">
                <FileUp className="h-4 w-4" /> Importar saldos
              </button>
            )}
            {!data?.locaisDisponiveis?.length && (
              <Link to="/locais" className="btn-accent">
                Cadastrar local
              </Link>
            )}
          </>
        }
      />

      {error && <Alert tone="red">{error}</Alert>}
      {!data && !error && <Spinner />}

      {data && (
        <>
          {/* Cockpit do estoque — resumo em 4 cartões + atalhos */}
          <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <CockpitKPI icon={Boxes} label="Peças em estoque" value={formatNumber(data.totalPecas)} sub={local ? `Local: ${local}` : `${data.locaisDisponiveis.length} local(is) ativo(s)`} accent="bg-navy-800" />
            <CockpitKPI icon={Wallet} label="Valor a custo" value={formatMoney(valorEstoque)} sub={`A preço de venda: ${formatMoney(valorVenda)}`} accent="bg-brand-500" />
            <CockpitKPI
              icon={AlertTriangle}
              label="Abaixo do mínimo"
              value={formatNumber(alertasGrade.length)}
              sub={alertasGrade.length ? `${formatNumber(alertasGrade.reduce((a, x) => a + x.faltando, 0))} peça(s) faltando` : 'Tudo acima do mínimo'}
              accent={alertasGrade.length ? 'bg-red-600' : 'bg-slate-500'}
              onClick={() => setSoAlertas((v) => !v)}
              active={soAlertas}
            />
            <div className="card flex flex-col justify-between p-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">Atalhos</p>
              <div className="mt-2 flex flex-wrap gap-1.5">
                <Link to="/movimentacoes" className="btn-secondary !px-2.5 !py-1.5 text-xs">
                  <ArrowLeftRight className="h-3.5 w-3.5" /> Movimentar
                </Link>
                <Link to="/inventario" className="btn-secondary !px-2.5 !py-1.5 text-xs">
                  <ClipboardCheck className="h-3.5 w-3.5" /> Inventário
                </Link>
                <Link to="/relatorios?relatorio=estoque-minimo" className="btn-secondary !px-2.5 !py-1.5 text-xs">
                  <AlertTriangle className="h-3.5 w-3.5" /> Relatório de mínimos
                </Link>
              </div>
            </div>
          </div>

          {/* Painel de alertas (só quando existe algo abaixo do mínimo) */}
          {alertasGrade.length > 0 && soAlertas && (
            <div className="card mb-4 overflow-hidden border-red-200">
              <div className="flex items-center justify-between border-b border-slate-200 bg-red-50/60 px-4 py-2.5">
                <h3 className="flex items-center gap-2 text-sm font-bold text-red-700">
                  <AlertTriangle className="h-4 w-4" /> Abaixo do estoque mínimo ({alertasGrade.length})
                </h3>
                <Link to="/relatorios?relatorio=estoque-minimo" className="text-xs font-semibold text-red-700 underline-offset-2 hover:underline">
                  Abrir relatório completo →
                </Link>
              </div>
              <div className="max-h-48 overflow-auto">
                <table className="table text-sm">
                  <thead>
                    <tr>
                      <th>Produto</th>
                      <th>Tam.</th>
                      <th className="text-right">Saldo</th>
                      <th className="text-right">Mínimo</th>
                      <th className="text-right">Faltando</th>
                    </tr>
                  </thead>
                  <tbody>
                    {alertasGrade.slice(0, 20).map((a, i) => (
                      <tr key={i}>
                        <td className="font-medium text-navy-900">
                          {a.produto.sku} — {a.produto.nome}
                        </td>
                        <td>{a.tamanho}</td>
                        <td className="text-right tabular-nums">{formatNumber(a.quantidade)}</td>
                        <td className="text-right tabular-nums">{formatNumber(a.estoque_min)}</td>
                        <td className="text-right font-bold tabular-nums text-red-600">{formatNumber(a.faltando)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Controles */}
          <div className="mb-4 flex flex-wrap items-center gap-3">
            <label className="block">
              <span className="label">Local</span>
              <select className="input" value={local} onChange={(e) => setLocal(e.target.value)}>
                <option value="">Todos os locais (soma)</option>
                {data.locaisDisponiveis.map((l) => (
                  <option key={l} value={l}>
                    {l}
                  </option>
                ))}
                {opts.locais?.map((o) => (data.locaisDisponiveis.includes(o.label) ? null : (
                  <option key={o.value} value={o.label}>
                    {o.label}
                  </option>
                )))}
              </select>
            </label>
            <label className="block">
              <span className="label">Coleção</span>
              <select className="input" value={colecaoId} onChange={(e) => setColecaoId(e.target.value)}>
                <option value="">Todas</option>
                {opts.colecoes?.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="label">Categoria</span>
              <select className="input" value={categoriaId} onChange={(e) => setCategoriaId(e.target.value)}>
                <option value="">Todas</option>
                {opts.categorias?.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
            <div className="relative min-w-[200px] flex-1 sm:max-w-xs">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
              <input className="input pl-9" placeholder="Buscar produto/SKU/cor..." value={q} onChange={(e) => setQ(e.target.value)} />
            </div>
            <div className="ml-auto text-right text-sm text-slate-500">
              Total: <strong className="tabular-nums">{formatNumber(data.totalPecas)}</strong> peças
            </div>
          </div>

          {/* Matriz */}
          {linhasVisiveis.length === 0 ? (
            <div className="card p-10 text-center text-sm text-slate-400">Nenhum produto com estoque neste filtro.</div>
          ) : (
            <div className="card overflow-hidden">
              <div className="overflow-x-auto">
                <table className="table text-sm">
                  <thead>
                    <tr>
                      <th className="sticky left-0 bg-white text-left">Produto</th>
                      {data.colunas.map((c) => (
                        <th key={c.id} className="text-center">
                          {c.codigo || `#${c.id}`}
                        </th>
                      ))}
                      <th className="text-right">Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {linhasVisiveis.map((linha) => (
                      <tr key={linha.produto.id}>
                        <td className="sticky left-0 max-w-[220px] bg-white">
                          <div className="font-medium text-navy-900">
                            {linha.produto.sku} — {linha.produto.nome}
                          </div>
                          <div className="text-xs text-slate-400">
                            {linha.produto.cor ? <span className="mr-2">{linha.produto.cor}</span> : null}
                            {linha.produto.categoria_id__label}
                          </div>
                        </td>
                        {data.colunas.map((c) => {
                          const celula = linha.celulas.find((x) => x.tamanho_id === c.id);
                          const qtd = celula?.quantidade ?? 0;
                          const alerta = qtd > 0 && qtd <= (celula?.estoque_min ?? 0);
                          return (
                            <td key={c.id} className="text-center">
                              <button
                                onClick={() => abrirCelula(linha, c)}
                                className={`min-w-[46px] rounded-md border px-1.5 py-1 text-xs font-semibold tabular-nums transition-colors ${
                                  qtd === 0
                                    ? 'border-slate-200 text-slate-300 hover:border-brand-400 hover:text-brand-600'
                                    : alerta
                                      ? 'border-amber-200 bg-amber-50 text-amber-700 hover:bg-amber-100'
                                      : 'border-slate-200 text-navy-800 hover:border-brand-400 hover:bg-brand-50'
                                }`}
                                title={`${linha.produto.sku} tam. ${c.codigo}: ${qtd} peça(s)`}
                              >
                                {qtd}
                              </button>
                            </td>
                          );
                        })}
                        <td className="text-right font-bold tabular-nums text-navy-900">{formatNumber(linha.total)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
          <p className="mt-2 text-xs text-slate-400">
            Célula amarela = saldo igual ou abaixo do estoque mínimo. Com “Todos os locais” os valores somam os locais; selecione um local para ver o saldo dele.
          </p>
        </>
      )}

      {tipoImport && <ImportModal open={importOpen} onClose={() => setImportOpen(false)} tipoConfig={tipoImport} onDone={() => load()} />}

      {/* Modal de movimentação a partir da célula */}
      <Modal open={!!cel} onClose={() => setCel(null)} title="Lançar movimentação" subtitle={cel ? `${cel.produto.sku} — ${cel.produto.nome} · tam. ${cel.tamanho.codigo}` : ''} size="md">
        {movErr && <Alert tone="red">{movErr}</Alert>}
        {cel && (
          <div className="space-y-4">
            <p className="text-sm text-slate-500">
              Saldo atual em <strong>{cel.local}</strong>: <strong className="tabular-nums">{formatNumber(cel.quantidade)}</strong> peça(s).
              {cel.estoque_min > 0 && ` Estoque mínimo: ${formatNumber(cel.estoque_min)}.`}
            </p>
            <label className="block">
              <span className="label">Tipo</span>
              <select className="input" value={mov.tipo} onChange={(e) => setMov((m) => ({ ...m, tipo: e.target.value }))}>
                <option value="entrada">Entrada</option>
                <option value="saida">Saída</option>
                <option value="ajuste">Ajuste (acerto de saldo)</option>
              </select>
            </label>
            <label className="block">
              <span className="label">Quantidade</span>
              <input type="number" min={1} className="input" value={mov.quantidade} onChange={(e) => setMov((m) => ({ ...m, quantidade: e.target.value }))} />
            </label>
            <label className="block">
              <span className="label">Motivo</span>
              <input className="input" value={mov.motivo} onChange={(e) => setMov((m) => ({ ...m, motivo: e.target.value }))} placeholder="Ex.: produção, devolução, contagem..." />
            </label>
            <div className="flex justify-end gap-2">
              <button className="btn-secondary" onClick={() => setCel(null)}>
                Cancelar
              </button>
              <button className="btn-primary" onClick={lancarMovimentacao} disabled={salvando}>
                {salvando ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowLeftRight className="h-4 w-4" />} Lançar
              </button>
            </div>

            {/* Histórico de movimentações recentes */}
            <div className="mt-4 border-t border-slate-200 pt-4">
              <h4 className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500">
                <History className="h-3.5 w-3.5" />
                Últimas movimentações
              </h4>
              {carregandoHistorico ? (
                <div className="flex items-center gap-2 py-3 text-xs text-slate-400">
                  <Loader2 className="h-3 w-3 animate-spin" /> Carregando...
                </div>
              ) : historicoErr ? (
                <div className="flex flex-wrap items-center gap-2 rounded-md border border-amber-200 bg-amber-50 px-2.5 py-2 text-xs text-amber-800">
                  <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                  <span className="flex-1">{historicoErr}</span>
                  <button
                    type="button"
                    className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-semibold text-amber-900 transition-colors hover:bg-amber-100"
                    onClick={() => cel && carregarHistorico(cel.produto.id, cel.tamanho.id)}
                  >
                    <RefreshCw className="h-3 w-3" /> Tentar novamente
                  </button>
                </div>
              ) : historico.length === 0 ? (
                <p className="py-3 text-xs text-slate-400">Nenhuma movimentação registrada.</p>
              ) : (
                <div className="max-h-52 overflow-auto rounded-md border border-slate-200">
                  <table className="w-full text-xs">
                    <thead className="sticky top-0 bg-slate-50">
                      <tr className="text-left text-[10px] uppercase tracking-wide text-slate-400">
                        <th className="px-2 py-1.5">#</th>
                        <th className="px-2 py-1.5">Data</th>
                        <th className="px-2 py-1.5">Tipo</th>
                        <th className="px-2 py-1.5 text-right">Qtd</th>
                        <th className="px-2 py-1.5">Motivo</th>
                        <th className="px-2 py-1.5 text-center">Ação</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {historico.map((m: any) => {
                        const estornado = m.estornado === true || m.estornado === 1;
                        const tipoLabel = m.tipo === 'entrada' ? 'Entrada' : m.tipo === 'saida' ? 'Saída' : m.tipo === 'ajuste' ? 'Ajuste' : m.tipo === 'transferencia' ? 'Transf.' : m.tipo;
                        const tipoTone = m.tipo === 'entrada' ? 'green' : m.tipo === 'saida' ? 'red' : m.tipo === 'ajuste' ? 'amber' : 'blue';
                        return (
                          <tr key={m.id} className={estornado ? 'opacity-40' : ''}>
                            <td className="px-2 py-1 font-mono text-slate-400">{m.id}</td>
                            <td className="whitespace-nowrap px-2 py-1 text-slate-500">{formatDateTime(m.data)}</td>
                            <td className="px-2 py-1">
                              <Badge tone={estornado ? 'slate' : tipoTone}>{estornado ? 'Estornado' : tipoLabel}</Badge>
                            </td>
                            <td className="px-2 py-1 text-right font-semibold tabular-nums">{formatNumber(m.quantidade)}</td>
                            <td className="max-w-[140px] truncate px-2 py-1 text-slate-500" title={m.motivo}>{m.motivo || '—'}</td>
                            <td className="px-2 py-1 text-center">
                              {!estornado && (
                                <button
                                  className="inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[10px] font-semibold text-amber-700 transition-colors hover:bg-amber-50"
                                  onClick={() => setMovParaEstornar(m)}
                                  title="Estornar esta movimentação"
                                >
                                  <RotateCcw className="h-3 w-3" /> Estornar
                                </button>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
              <p className="mt-1.5 text-[10px] text-slate-400">
                Lançou errado? Clique em "Estornar" para reverter. O saldo é ajustado automaticamente e a movimentação original é preservada no histórico.
              </p>
            </div>
          </div>
        )}
      </Modal>

      {/* Diálogo de confirmação de estorno */}
      <ConfirmDialog
        open={!!movParaEstornar}
        title="Estornar movimentação?"
        danger
        confirmLabel="Estornar"
        busy={estornando}
        onCancel={() => !estornando && setMovParaEstornar(null)}
        onConfirm={() => estornarMovimento(movParaEstornar)}
        message={
          <>
            <p>
              Deseja estornar a movimentação <strong>#{movParaEstornar?.id}</strong> ({movParaEstornar?.tipo} de {movParaEstornar?.quantidade} peça(s))?
            </p>
            <p className="mt-2 text-slate-600">
              Será criado um lançamento inverso para reverter o efeito no estoque. A movimentação original será marcada como estornada e preservada no histórico.
            </p>
          </>
        }
      />
    </div>
  );
}

/** Cartão de KPI do cockpit (estilo Dashboard). */
function CockpitKPI({
  icon: Icon,
  label,
  value,
  sub,
  accent,
  onClick,
  active,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string;
  sub: string;
  accent: string;
  onClick?: () => void;
  active?: boolean;
}) {
  const inner = (
    <>
      <span className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-white ${accent}`}>
        <Icon className="h-5 w-5" />
      </span>
      <div className="min-w-0">
        <div className="truncate text-xl font-bold tabular-nums text-navy-900">{value}</div>
        <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">{label}</div>
        <div className="truncate text-xs text-slate-400">{sub}</div>
      </div>
    </>
  );
  if (onClick) {
    return (
      <button
        onClick={onClick}
        className={`card flex items-center gap-3 p-4 text-left transition-colors ${active ? 'border-red-300 bg-red-50/40' : 'hover:border-navy-300'}`}
        title={active ? 'Clique para voltar a ver todos os produtos' : 'Clique para ver só o que está abaixo do mínimo'}
      >
        {inner}
      </button>
    );
  }
  return <div className="card flex items-center gap-3 p-4">{inner}</div>;
}
