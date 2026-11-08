// ============================================================================
// SUPPLY CHAIN — RASTREABILIDADE (módulo /rastreabilidade)
//
// Responde às duas perguntas da operação: "de onde veio esta peça?" e "para
// onde foi o lote X?". A tela é uma SUPERFÍCIE DE LEITURA sobre o motor
// canônico: o saldo do lote é DERIVADO das movimentações (o servidor soma), e a
// cadeia é montada pelos vínculos formais que já existem (compra → recebimento
// → movimentação → expedição). Nada aqui grava saldo.
//
// A única escrita é o CADASTRO do lote (código do fornecedor + validade), que
// passa pelo mesmo CRUD genérico do ERP (`POST /api/lotes`) — nenhum endpoint
// paralelo é criado.
//
// ZERO MODAL: o cadastro do lote é um bloco inline; o detalhe abre abaixo da
// lista. Nada sobrepõe a tela.
// ============================================================================
import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Boxes, CheckCircle2, History, Plus, RefreshCw, Search, X } from 'lucide-react';
import { api, ApiError } from '../lib/api';
import { useMeta, type ListResult, type Option } from '../lib/meta';
import { Alert, Badge, EmptyState, PageHeader, Spinner, useToast } from '../components/ui';
import { formatDate, formatDateTime, formatNumber } from '../lib/format';

type Lote = {
  id: number;
  codigo: string;
  produto_id: number | null;
  insumo_id: number | null;
  fornecedor_id: number | null;
  fabricacao: string | null;
  validade: string | null;
  observacoes: string | null;
  ativo: boolean;
};

type Movimentacao = {
  movimentacao_id: number;
  tipo: string;
  quantidade: number;
  data: string | null;
  local: string | null;
  motivo: string | null;
  compra_id: number | null;
  recebimento_id: number | null;
  ordem_id: number | null;
  venda_id: number | null;
  devolucao_fornecedor_id: number | null;
};

type DetalheLote = {
  lote: Lote;
  fornecedor: { id: number; nome: string } | null;
  saldo: number;
  movimentacoes: Movimentacao[];
  total_movimentacoes: number;
  semantica: string;
};

type Painel = {
  lotes: { total: number; com_saldo: number; vencidos: number; vencendo_30d: number };
  movimentacoes: { total: number; sem_lote: number; cobertura_lote_pct: number };
  alertas: { vencidos: { id: number; codigo: string; validade: string }[]; vencendo_30d: { id: number; codigo: string; validade: string }[] };
};

type LinhaForm = { codigo: string; produto_id: string; insumo_id: string; fornecedor_id: string; fabricacao: string; validade: string; observacoes: string };

const FORM_VAZIO: LinhaForm = { codigo: '', produto_id: '', insumo_id: '', fornecedor_id: '', fabricacao: '', validade: '', observacoes: '' };

export default function RastreabilidadePage() {
  const meta = useMeta();
  const toast = useToast();

  const [painel, setPainel] = useState<Painel | null>(null);
  const [dados, setDados] = useState<ListResult<Lote> | null>(null);
  const [erro, setErro] = useState('');
  const [carregando, setCarregando] = useState(true);
  const [filtro, setFiltro] = useState('');

  const [detalhe, setDetalhe] = useState<DetalheLote | null>(null);
  const [carregandoDetalhe, setCarregandoDetalhe] = useState(false);

  const [buscaCodigo, setBuscaCodigo] = useState('');
  const [resultadoCodigo, setResultadoCodigo] = useState<{ lote: Lote; candidatos: number } | null>(null);
  const [erroCodigo, setErroCodigo] = useState('');

  const [formAberto, setFormAberto] = useState(false);
  const [form, setForm] = useState<LinhaForm>(FORM_VAZIO);
  const [salvando, setSalvando] = useState(false);
  const [formErro, setFormErro] = useState('');

  const produtos = useOptions('produtos');
  const insumos = useOptions('insumos');
  const fornecedores = useOptions('fornecedores');

  const nomeProduto = useMemo(() => new Map(produtos.map((o) => [o.value, o.label])), [produtos]);
  const nomeInsumo = useMemo(() => new Map(insumos.map((o) => [o.value, o.label])), [insumos]);
  const nomeFornecedor = useMemo(() => new Map(fornecedores.map((o) => [o.value, o.label])), [fornecedores]);

  const rotuloItem = useCallback(
    (l: Lote) => (l.produto_id ? nomeProduto.get(l.produto_id) ?? `Produto #${l.produto_id}` : l.insumo_id ? nomeInsumo.get(l.insumo_id) ?? `Insumo #${l.insumo_id}` : '—'),
    [nomeProduto, nomeInsumo]
  );

  const carregar = useCallback(async () => {
    setCarregando(true);
    setErro('');
    try {
      const [p, lista] = await Promise.all([
        api.get<Painel>('/rastreabilidade/painel'),
        api.get<ListResult<Lote>>('/lotes?page=1&pageSize=100'),
      ]);
      setPainel(p);
      setDados(lista);
    } catch (e) {
      setErro(e instanceof ApiError ? e.message : 'Não foi possível carregar a rastreabilidade.');
    } finally {
      setCarregando(false);
    }
  }, []);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  const abrirLote = useCallback(async (id: number) => {
    setCarregandoDetalhe(true);
    setResultadoCodigo(null);
    try {
      const d = await api.get<DetalheLote>(`/rastreabilidade/lotes/${id}`);
      setDetalhe(d);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Não foi possível abrir o lote.');
    } finally {
      setCarregandoDetalhe(false);
    }
  }, [toast]);

  async function buscarPorCodigo() {
    const codigo = buscaCodigo.trim();
    if (!codigo) return;
    setErroCodigo('');
    setResultadoCodigo(null);
    setDetalhe(null);
    try {
      const r = await api.get<{ lote: Lote; candidatos: number }>(`/rastreabilidade/lote-por-codigo?codigo=${encodeURIComponent(codigo)}`);
      setResultadoCodigo(r);
      void abrirLote(r.lote.id);
    } catch (e) {
      setErroCodigo(e instanceof ApiError ? e.message : 'Nenhum lote encontrado.');
    }
  }

  async function salvarLote() {
    setSalvando(true);
    setFormErro('');
    try {
      const payload: Record<string, unknown> = {
        codigo: form.codigo.trim(),
        observacoes: form.observacoes.trim() || null,
      };
      if (form.produto_id) payload.produto_id = Number(form.produto_id);
      if (form.insumo_id) payload.insumo_id = Number(form.insumo_id);
      if (form.fornecedor_id) payload.fornecedor_id = Number(form.fornecedor_id);
      if (form.fabricacao) payload.fabricacao = form.fabricacao;
      if (form.validade) payload.validade = form.validade;
      await api.post('/lotes', payload);
      toast.success('Lote cadastrado.');
      setForm(FORM_VAZIO);
      setFormAberto(false);
      await carregar();
    } catch (e) {
      setFormErro(e instanceof ApiError ? e.message : 'Não foi possível cadastrar o lote.');
    } finally {
      setSalvando(false);
    }
  }

  const lotes = dados?.rows ?? [];
  const visiveis = useMemo(() => {
    const term = filtro.trim().toLowerCase();
    if (!term) return lotes;
    return lotes.filter(
      (l) => l.codigo.toLowerCase().includes(term) || rotuloItem(l).toLowerCase().includes(term) || String(l.fornecedor_id ?? '').includes(term)
    );
  }, [lotes, filtro, rotuloItem]);

  const hoje = new Date();
  const vencido = (v: string | null) => Boolean(v) && new Date(String(v)) < hoje;

  return (
    <div className="p-4 pb-24 sm:p-6 md:pb-6">
      <PageHeader
        title={
          <span className="flex items-center gap-2.5">
            <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-navy-800 text-white">
              <History className="h-5 w-5" />
            </span>
            Rastreabilidade
          </span>
        }
        description="Cadeia ponta a ponta por lote: origem (fornecedor/recebimento), movimentações e saldo derivado. O saldo do lote é a soma das movimentações — nunca um saldo gravado."
        actions={
          <>
            <button className="btn-secondary" onClick={carregar} disabled={carregando}>
              <RefreshCw className={`h-4 w-4 ${carregando ? 'animate-spin' : ''}`} /> Atualizar
            </button>
            <button className="btn-accent" onClick={() => setFormAberto((v) => !v)}>
              {formAberto ? <X className="h-4 w-4" /> : <Plus className="h-4 w-4" />} {formAberto ? 'Fechar' : 'Novo lote'}
            </button>
          </>
        }
      />

      {erro && <Alert tone="red">{erro}</Alert>}
      {carregando && !dados && <Spinner />}

      {painel && (
        <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <Indicador titulo="Lotes" valor={formatNumber(painel.lotes.total)} />
          <Indicador titulo="Com saldo" valor={formatNumber(painel.lotes.com_saldo)} />
          <Indicador titulo="Vencendo (30d)" valor={formatNumber(painel.lotes.vencendo_30d)} tom="amber" />
          <Indicador titulo="Vencidos" valor={formatNumber(painel.lotes.vencidos)} tom="red" />
          <Indicador titulo="Movimentações" valor={formatNumber(painel.movimentacoes.total)} />
          <Indicador titulo="Cobertura de lote" valor={`${painel.movimentacoes.cobertura_lote_pct}%`} tom={painel.movimentacoes.cobertura_lote_pct >= 50 ? 'green' : 'slate'} />
        </div>
      )}

      {formAberto && (
        <div className="card mb-4 p-4">
          <h3 className="mb-3 text-sm font-semibold text-slate-700">Cadastrar lote</h3>
          <p className="mb-3 text-xs text-slate-500">
            Informe o <strong>produto OU o insumo</strong> — nunca os dois. O lote é opcional no ERP: sem ele, a operação continua; com ele, a rastreabilidade fica completa.
          </p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <Campo label="Código do lote *">
              <input className="input" value={form.codigo} maxLength={60} onChange={(e) => setForm((f) => ({ ...f, codigo: e.target.value }))} placeholder="Ex.: L2026-07" />
            </Campo>
            <Campo label="Produto">
              <select className="input" value={form.produto_id} onChange={(e) => setForm((f) => ({ ...f, produto_id: e.target.value, insumo_id: '' }))}>
                <option value="">— nenhum —</option>
                {produtos.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </Campo>
            <Campo label="Insumo">
              <select className="input" value={form.insumo_id} onChange={(e) => setForm((f) => ({ ...f, insumo_id: e.target.value, produto_id: '' }))}>
                <option value="">— nenhum —</option>
                {insumos.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </Campo>
            <Campo label="Fornecedor de origem">
              <select className="input" value={form.fornecedor_id} onChange={(e) => setForm((f) => ({ ...f, fornecedor_id: e.target.value }))}>
                <option value="">— nenhum —</option>
                {fornecedores.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </Campo>
            <Campo label="Fabricação">
              <input type="date" className="input" value={form.fabricacao} onChange={(e) => setForm((f) => ({ ...f, fabricacao: e.target.value }))} />
            </Campo>
            <Campo label="Validade">
              <input type="date" className="input" value={form.validade} onChange={(e) => setForm((f) => ({ ...f, validade: e.target.value }))} />
            </Campo>
          </div>
          <div className="mt-3">
            <Campo label="Observações">
              <textarea className="input" rows={2} maxLength={500} value={form.observacoes} onChange={(e) => setForm((f) => ({ ...f, observacoes: e.target.value }))} />
            </Campo>
          </div>
          {formErro && <div className="mt-3"><Alert tone="red">{formErro}</Alert></div>}
          <div className="mt-3 flex justify-end gap-2">
            <button className="btn-secondary" onClick={() => { setFormAberto(false); setFormErro(''); }} disabled={salvando}>Cancelar</button>
            <button className="btn-primary" onClick={salvarLote} disabled={salvando || !form.codigo.trim() || (!form.produto_id && !form.insumo_id)}>
              {salvando ? <RefreshCw className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />} Salvar lote
            </button>
          </div>
        </div>
      )}

      <div className="card mb-4 p-4">
        <h3 className="mb-2 text-sm font-semibold text-slate-700">Buscar por código do lote</h3>
        <div className="flex flex-wrap items-end gap-2">
          <div className="flex-1 min-w-[220px]">
            <input
              className="input"
              value={buscaCodigo}
              onChange={(e) => setBuscaCodigo(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && buscarPorCodigo()}
              placeholder="O que está em mãos: código do fornecedor"
            />
          </div>
          <button className="btn-secondary" onClick={buscarPorCodigo} disabled={!buscaCodigo.trim()}>
            <Search className="h-4 w-4" /> Buscar
          </button>
        </div>
        {erroCodigo && <div className="mt-2"><Alert tone="amber">{erroCodigo}</Alert></div>}
        {resultadoCodigo && resultadoCodigo.candidatos > 1 && (
          <div className="mt-2 text-xs text-amber-600">Há {resultadoCodigo.candidatos} lotes com este código — informado o produto/insumo o resultado é exato.</div>
        )}
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div className="card p-4">
          <div className="mb-3 flex items-center justify-between gap-2">
            <h3 className="text-sm font-semibold text-slate-700">Lotes</h3>
            <div className="flex items-center gap-2">
              <Search className="h-4 w-4 text-slate-400" />
              <input className="input" value={filtro} onChange={(e) => setFiltro(e.target.value)} placeholder="Filtrar nesta página" />
            </div>
          </div>
          {!dados && !erro && <Spinner />}
          {dados && visiveis.length === 0 && (
            <EmptyState icon={<Boxes className="h-8 w-8 text-slate-300" />} title="Nenhum lote" description="Cadastre um lote para rastrear a origem e o destino das peças." />
          )}
          {visiveis.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs uppercase text-slate-400">
                    <th className="py-2 pr-2">Código</th>
                    <th className="py-2 pr-2">Item</th>
                    <th className="py-2 pr-2">Fornecedor</th>
                    <th className="py-2 pr-2">Validade</th>
                    <th className="py-2" />
                  </tr>
                </thead>
                <tbody>
                  {visiveis.map((l) => (
                    <tr key={l.id} className={`border-t border-slate-100 ${detalhe?.lote.id === l.id ? 'bg-slate-50' : ''}`}>
                      <td className="py-2 pr-2 font-medium text-slate-700">{l.codigo}</td>
                      <td className="py-2 pr-2 text-slate-600">{rotuloItem(l)}</td>
                      <td className="py-2 pr-2 text-slate-600">{l.fornecedor_id ? nomeFornecedor.get(l.fornecedor_id) ?? `#${l.fornecedor_id}` : '—'}</td>
                      <td className="py-2 pr-2">
                        {l.validade ? (
                          <span className={vencido(l.validade) ? 'text-red-600 font-medium' : 'text-slate-600'}>{formatDate(l.validade)}</span>
                        ) : (
                          <span className="text-slate-400">—</span>
                        )}
                      </td>
                      <td className="py-2 text-right">
                        <button className="btn-secondary" onClick={() => abrirLote(l.id)}>Abrir</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="card p-4">
          {!detalhe && !carregandoDetalhe && (
            <div className="flex h-full min-h-[200px] items-center justify-center text-center text-sm text-slate-400">
              Selecione um lote para ver a trilha e o saldo derivado.
            </div>
          )}
          {carregandoDetalhe && <Spinner label="Carregando trilha..." />}
          {detalhe && (
            <div>
              <div className="mb-3 flex items-start justify-between gap-2">
                <div>
                  <h3 className="text-sm font-semibold text-slate-700">Lote {detalhe.lote.codigo}</h3>
                  <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-slate-500">
                    <span>{rotuloItem(detalhe.lote)}</span>
                    {detalhe.fornecedor && <Badge tone="slate">Origem: {detalhe.fornecedor.nome}</Badge>}
                    {detalhe.lote.validade && (
                      <Badge tone={vencido(detalhe.lote.validade) ? 'red' : 'green'}>Validade {formatDate(detalhe.lote.validade)}</Badge>
                    )}
                  </div>
                </div>
                <button className="btn-secondary" onClick={() => setDetalhe(null)}><X className="h-4 w-4" /></button>
              </div>

              <div className="mb-3 flex items-center gap-3 rounded-lg bg-slate-50 p-3">
                <div>
                  <div className="text-xs uppercase text-slate-400">Saldo derivado</div>
                  <div className={`text-xl font-semibold ${detalhe.saldo < 0 ? 'text-red-600' : 'text-slate-800'}`}>{formatNumber(detalhe.saldo)}</div>
                </div>
                <div className="text-xs text-slate-500">{detalhe.total_movimentacoes} movimentação(ões) · {detalhe.semantica.replace(/_/g, ' ')}</div>
              </div>

              {detalhe.saldo < 0 && (
                <div className="mb-3">
                  <Alert tone="amber"><AlertTriangle className="mr-1 inline h-4 w-4" /> Saldo negativo no lote: houve saída sem entrada correspondente registrada com este lote.</Alert>
                </div>
              )}

              {detalhe.movimentacoes.length === 0 && <div className="text-sm text-slate-400">Nenhuma movimentação vinculada a este lote.</div>}
              {detalhe.movimentacoes.length > 0 && (
                <div className="max-h-[360px] overflow-y-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-left text-xs uppercase text-slate-400">
                        <th className="py-2 pr-2">#</th>
                        <th className="py-2 pr-2">Tipo</th>
                        <th className="py-2 pr-2">Qtd</th>
                        <th className="py-2 pr-2">Origem</th>
                        <th className="py-2">Data</th>
                      </tr>
                    </thead>
                    <tbody>
                      {detalhe.movimentacoes.map((m) => (
                        <tr key={m.movimentacao_id} className="border-t border-slate-100">
                          <td className="py-2 pr-2 text-slate-400">{m.movimentacao_id}</td>
                          <td className="py-2 pr-2"><Badge tone={m.tipo === 'entrada' ? 'green' : m.tipo === 'saida' ? 'amber' : 'slate'}>{m.tipo}</Badge></td>
                          <td className="py-2 pr-2 text-slate-700">{formatNumber(m.quantidade)}</td>
                          <td className="py-2 pr-2 text-xs text-slate-500">{origemLabel(m)}</td>
                          <td className="py-2 text-xs text-slate-500">{m.data ? formatDateTime(m.data) : '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      <p className="mt-4 text-xs text-slate-400">
        O saldo do lote é calculado no servidor a partir das movimentações (entrada soma, saída subtrai, ajuste aplica o delta). Nenhuma tela grava saldo.
        {meta?.mode === 'memory' ? ' (modo demonstração)' : ''}
      </p>
    </div>
  );
}

function origemLabel(m: Movimentacao): string {
  if (m.compra_id) return `Compra #${m.compra_id}`;
  if (m.recebimento_id) return `Recebimento #${m.recebimento_id}`;
  if (m.ordem_id) return `OP #${m.ordem_id}`;
  if (m.venda_id) return `Venda #${m.venda_id}`;
  if (m.devolucao_fornecedor_id) return `Devolução #${m.devolucao_fornecedor_id}`;
  return m.motivo || '—';
}

function Indicador({ titulo, valor, tom = 'slate' }: { titulo: string; valor: string; tom?: 'slate' | 'green' | 'amber' | 'red' }) {
  const cor = tom === 'green' ? 'text-emerald-600' : tom === 'amber' ? 'text-amber-600' : tom === 'red' ? 'text-red-600' : 'text-slate-800';
  return (
    <div className="card p-3">
      <div className="text-xs uppercase text-slate-400">{titulo}</div>
      <div className={`text-xl font-semibold ${cor}`}>{valor}</div>
    </div>
  );
}

function Campo({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-slate-500">{label}</span>
      {children}
    </label>
  );
}

/** Opções (id + rótulo) de um recurso, para os seletores da página. */
function useOptions(recurso: string): Option[] {
  const [opts, setOpts] = useState<Option[]>([]);
  useEffect(() => {
    let vivo = true;
    api
      .get<Option[]>(`/${recurso}/options`)
      .then((o) => vivo && setOpts(o))
      .catch(() => vivo && setOpts([]));
    return () => {
      vivo = false;
    };
  }, [recurso]);
  return opts;
}
