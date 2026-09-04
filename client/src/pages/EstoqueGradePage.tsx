import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeftRight, Download, FileUp, Loader2, RefreshCw, Search, Warehouse } from 'lucide-react';
import { api, downloadFile } from '../lib/api';
import { Alert, Modal, PageHeader, Spinner, useToast } from '../components/ui';
import { IMPORT_TIPOS, ImportModal } from '../components/ImportModal';
import { formatNumber } from '../lib/format';

type GradeResp = {
  colunas: { id: number; codigo: string }[];
  local: string;
  locaisDisponiveis: string[];
  totalPecas: number;
  linhas: {
    produto: { id: number; sku: string; nome: string; cor: string | null; cor_hex: string | null; categoria_id__label: string | null; foto_url: string | null };
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
  const [data, setData] = useState<GradeResp | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [local, setLocal] = useState('');
  const [colecaoId, setColecaoId] = useState('');
  const [categoriaId, setCategoriaId] = useState('');
  const [q, setQ] = useState('');
  const [opts, setOpts] = useState<Record<string, { value: number; label: string }[]>>({});
  const [cel, setCel] = useState<Cel | null>(null);
  const tipoImport = IMPORT_TIPOS.find((t) => t.recurso === 'estoques');
  const [importOpen, setImportOpen] = useState(false);
  const [mov, setMov] = useState({ tipo: 'ajuste', quantidade: '1', motivo: 'Ajuste pela grade de estoque' });
  const [movErr, setMovErr] = useState('');
  const [salvando, setSalvando] = useState(false);

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

  const linhasVisiveis = useMemo(() => {
    if (!data) return [];
    const term = q.trim().toLowerCase();
    if (!term) return data.linhas;
    return data.linhas.filter((l) => `${l.produto.sku} ${l.produto.nome} ${l.produto.cor || ''} ${l.produto.categoria_id__label || ''}`.toLowerCase().includes(term));
  }, [data, q]);

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
    const localEscolhido = local || 'almoxarifado';
    setCel({ produto: linha.produto, tamanho, quantidade: c?.quantidade ?? 0, estoque_min: c?.estoque_min ?? 0, local: localEscolhido });
    setMov({ tipo: 'ajuste', quantidade: '1', motivo: 'Ajuste pela grade de estoque' });
    setMovErr('');
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
      <Modal open={!!cel} onClose={() => setCel(null)} title="Lançar movimentação" subtitle={cel ? `${cel.produto.sku} — ${cel.produto.nome} · tam. ${cel.tamanho.codigo}` : ''} size="sm">
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
          </div>
        )}
      </Modal>
    </div>
  );
}
