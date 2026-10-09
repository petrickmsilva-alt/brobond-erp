import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, ClipboardList, Loader2, Pencil, Plus, Scissors, Tag, Trash2 } from 'lucide-react';
import { api, ApiError } from '../lib/api';
import { useMeta, type Option } from '../lib/meta';
import { useAuth } from '../auth/AuthContext';
import { Alert, Badge, ConfirmDialog, Modal, PageHeader, Spinner, useToast } from '../components/ui';
import { formatMoney, formatNumber } from '../lib/format';

type InsumoLinha = Record<string, any> & { id: number };

function num(v: unknown): number {
  const n = Number(String(v ?? '').replace(/\./g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : 0;
}

export default function FichaDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const meta = useMeta();
  const { user } = useAuth();
  const toast = useToast();
  const fichaId = Number(id);
  const resource = meta.resources.fichas;
  const podeEditar = resource?.ops.update ?? false;

  const [ficha, setFicha] = useState<Record<string, any> | null>(null);
  const [produto, setProduto] = useState<Record<string, any> | null>(null);
  const [insumos, setInsumos] = useState<InsumoLinha[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // edição do cabeçalho (custos e margem)
  const [editOpen, setEditOpen] = useState(false);
  const [editVal, setEditVal] = useState<Record<string, string>>({});
  const [editErr, setEditErr] = useState('');
  const [savingEdit, setSavingEdit] = useState(false);

  // insumo (incluir/editar)
  const [insumoModal, setInsumoModal] = useState<InsumoLinha | 'novo' | null>(null);
  const [insumoOpts, setInsumoOpts] = useState<Option[]>([]);
  const [insumoDetalhe, setInsumoDetalhe] = useState<Map<number, { unidade: string; custo_medio: number }>>(new Map());
  const [form, setForm] = useState<Record<string, string>>({ insumo_id: '', consumo: '1', perda_pct: '0' });
  const [formErr, setFormErr] = useState('');
  const [saving, setSaving] = useState(false);
  const [toDelete, setToDelete] = useState<InsumoLinha | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [aplicando, setAplicando] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [f, its] = await Promise.all([api.get<Record<string, any>>(`/fichas/${fichaId}`), api.get<InsumoLinha[]>(`/fichas/${fichaId}/insumos`)]);
      setFicha(f);
      setInsumos(its);
      setError('');
      if (f.produto_id) {
        api
          .get<Record<string, any>>(`/produtos/${f.produto_id}`)
          .then(setProduto)
          .catch(() => {});
      }
    } catch (e: any) {
      setError(e.message || 'Erro ao carregar a ficha técnica.');
    } finally {
      setLoading(false);
    }
  }, [fichaId]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    api
      .get<Option[]>('/insumos/options')
      .then(setInsumoOpts)
      .catch(() => {});
    api
      .get<{ rows: Record<string, any>[] }>('/insumos?pageSize=300')
      .then((d) => setInsumoDetalhe(new Map(d.rows.map((r) => [Number(r.id), { unidade: r.unidade || '', custo_medio: num(r.custo_medio) }]))))
      .catch(() => {});
  }, []);

  function abrirEdicao() {
    if (!ficha) return;
    setEditVal({
      mao_obra: String(Number(ficha.mao_obra || 0)).replace('.', ','),
      custos_indiretos: String(Number(ficha.custos_indiretos || 0)).replace('.', ','),
      margem_pct: String(Number(ficha.margem_pct || 0)).replace('.', ','),
    });
    setEditErr('');
    setEditOpen(true);
  }

  async function salvarCabecalho() {
    setSavingEdit(true);
    setEditErr('');
    try {
      await api.put(`/fichas/${fichaId}`, {
        mao_obra: num(editVal.mao_obra),
        custos_indiretos: num(editVal.custos_indiretos),
        margem_pct: num(editVal.margem_pct),
      });
      toast.success('Ficha atualizada — custo recalculado.');
      setEditOpen(false);
      await load();
    } catch (e: any) {
      setEditErr(e instanceof ApiError ? e.message : 'Não foi possível salvar.');
    } finally {
      setSavingEdit(false);
    }
  }

  function abrirInsumo(linha: InsumoLinha | 'novo') {
    if (linha === 'novo') {
      setForm({ insumo_id: '', consumo: '1', perda_pct: '0' });
    } else {
      setForm({ insumo_id: String(linha.insumo_id ?? ''), consumo: String(linha.consumo ?? '').replace('.', ','), perda_pct: String(linha.perda_pct ?? 0).replace('.', ',') });
    }
    setFormErr('');
    setInsumoModal(linha);
  }

  async function salvarInsumo() {
    if (!form.insumo_id) return setFormErr('Selecione o insumo.');
    if (!(num(form.consumo) > 0)) return setFormErr('O consumo por peça deve ser maior que zero.');
    setSaving(true);
    setFormErr('');
    const payload = { insumo_id: Number(form.insumo_id), consumo: num(form.consumo), perda_pct: num(form.perda_pct) };
    try {
      if (insumoModal === 'novo') {
        await api.post(`/fichas/${fichaId}/insumos`, payload);
        toast.success('Insumo adicionado — custo recalculado.');
      } else if (insumoModal) {
        await api.put(`/fichas/${fichaId}/insumos/${insumoModal.id}`, payload);
        toast.success('Insumo atualizado — custo recalculado.');
      }
      setInsumoModal(null);
      await load();
    } catch (e: any) {
      setFormErr(e instanceof ApiError ? e.message : 'Não foi possível salvar o insumo.');
    } finally {
      setSaving(false);
    }
  }

  async function removerInsumo() {
    if (!toDelete) return;
    setDeleting(true);
    try {
      await api.del(`/fichas/${fichaId}/insumos/${toDelete.id}`);
      toast.success('Insumo removido — custo recalculado.');
      setToDelete(null);
      await load();
    } catch (e: any) {
      toast.error(e.message || 'Não foi possível remover.');
    } finally {
      setDeleting(false);
    }
  }

  async function aplicarPreco() {
    if (!ficha) return;
    setAplicando(true);
    try {
      const r = await api.post<{ custo: number; preco_venda: number }>(`/fichas/${fichaId}/aplicar-preco`, {});
      toast.success(`Preço aplicado ao produto: custo ${formatMoney(r.custo)} · venda ${formatMoney(r.preco_venda)}.`);
      await load();
    } catch (e: any) {
      toast.error(e.message || 'Não foi possível aplicar o preço.');
    } finally {
      setAplicando(false);
    }
  }

  if (loading) return <Spinner />;
  if (error || !ficha)
    return (
      <div className="p-4 sm:p-6">
        <Alert tone="red">{error}</Alert>
        <Link to="/fichas" className="btn-secondary mt-4">
          <ArrowLeft className="h-4 w-4" /> Voltar para Fichas
        </Link>
      </div>
    );

  const ehGerente = user?.perfil === 'admin' || user?.perfil === 'gerente';

  function custoLinha(l: InsumoLinha): number {
    const d = insumoDetalhe.get(Number(l.insumo_id));
    const custo = d?.custo_medio ?? 0;
    return num(l.consumo) * (1 + num(l.perda_pct) / 100) * custo;
  }
  const totalInsumos = insumos.reduce((acc, l) => acc + custoLinha(l), 0);

  return (
    <div className="p-4 pb-20 sm:p-6 md:pb-6">
      <PageHeader
        title={
          <span className="flex items-center gap-2.5">
            <button className="btn-icon" onClick={() => navigate('/fichas')} aria-label="Voltar">
              <ArrowLeft className="h-4 w-4" />
            </button>
            <ClipboardList className="h-5 w-5 text-navy-600" />
            Ficha técnica {produto ? `— ${produto.nome}` : `#${ficha.id}`}
            {produto?.sku && <span className="font-mono text-xs text-slate-400">{produto.sku}</span>}
          </span>
        }
        description="Lista de insumos por peça (consumo × custo médio) + mão de obra e custos indiretos → preço sugerido."
        actions={
          <>
            {podeEditar && (
              <button className="btn-secondary" onClick={abrirEdicao}>
                <Pencil className="h-4 w-4" /> Editar custos e margem
              </button>
            )}
            {/* Escreve custo e preço de venda no produto: só gerente/admin, na
                mesma régua do servidor (aplicarPrecoFicha). */}
            {podeEditar && ehGerente && (
              <button className="btn-accent" onClick={aplicarPreco} disabled={aplicando || !ficha.custo_calculado}>
                {aplicando ? <Loader2 className="h-4 w-4 animate-spin" /> : <Tag className="h-4 w-4" />} Aplicar preço ao produto
              </button>
            )}
          </>
        }
      />

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <div className="space-y-4 xl:col-span-2">
          {/* Insumos */}
          <div className="card overflow-hidden">
            <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
              <h2 className="flex items-center gap-2 text-sm font-bold text-navy-900">
                <Scissors className="h-4 w-4 text-navy-400" /> Insumos (BOM)
              </h2>
              {podeEditar && (
                <button className="btn-secondary !py-1.5 text-xs" onClick={() => abrirInsumo('novo')}>
                  <Plus className="h-4 w-4" /> Adicionar insumo
                </button>
              )}
            </div>
            {insumos.length === 0 ? (
              <div className="p-6 text-center text-sm text-slate-400">
                Nenhum insumo nesta ficha ainda. Adicione o primeiro para o custo aparecer.
              </div>
            ) : (
              <table className="table">
                <thead>
                  <tr>
                    <th>Insumo</th>
                    <th className="text-right">Consumo/peça</th>
                    <th className="text-right">Perda</th>
                    <th className="text-right">Custo/peça*</th>
                    {podeEditar && <th className="w-20 text-right">Ações</th>}
                  </tr>
                </thead>
                <tbody>
                  {insumos.map((linha) => (
                    <tr key={linha.id}>
                      <td className="font-medium text-slate-800">{linha.insumo_id__label || `#${linha.insumo_id}`}</td>
                      <td className="text-right tabular-nums">
                        {formatNumber(linha.consumo)} {insumoDetalhe.get(Number(linha.insumo_id))?.unidade || ''}
                      </td>
                      <td className="text-right tabular-nums text-slate-500">{Number(linha.perda_pct || 0) > 0 ? `${formatNumber(linha.perda_pct)}%` : '—'}</td>
                      <td className="text-right tabular-nums text-slate-700">{formatMoney(custoLinha(linha))}</td>
                      {podeEditar && (
                        <td className="text-right">
                          <div className="inline-flex gap-1">
                            <button className="btn-icon" onClick={() => abrirInsumo(linha)} aria-label="Editar insumo">
                              <Pencil className="h-4 w-4" />
                            </button>
                            <button className="btn-icon hover:!bg-red-50 hover:!text-red-600" onClick={() => setToDelete(linha)} aria-label="Remover insumo">
                              <Trash2 className="h-4 w-4" />
                            </button>
                          </div>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <div className="border-t border-slate-100 bg-slate-50 px-4 py-2 text-xs text-slate-500">* Custo por peça = consumo × (1 + perda ÷ 100) × custo médio atual do insumo.</div>
          </div>
        </div>

        {/* Custo calculado */}
        <div className="space-y-4">
          <div className="card p-5">
            <h2 className="text-sm font-bold text-navy-900">Custo calculado</h2>
            <dl className="mt-4 space-y-2.5 text-sm">
              <div className="flex justify-between">
                <dt className="text-slate-500">Insumos (custo médio)</dt>
                <dd className="font-medium tabular-nums">{formatMoney(totalInsumos)}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-slate-500">Mão de obra</dt>
                <dd className="tabular-nums">{formatMoney(ficha.mao_obra)}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-slate-500">Custos indiretos</dt>
                <dd className="tabular-nums">{formatMoney(ficha.custos_indiretos)}</dd>
              </div>
              <div className="flex justify-between border-t border-slate-100 pt-2">
                <dt className="font-semibold text-navy-900">Custo unitário</dt>
                <dd className="text-lg font-bold tabular-nums text-navy-900">{formatMoney(ficha.custo_calculado)}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-slate-500">Margem aplicada</dt>
                <dd className="tabular-nums">{formatNumber(ficha.margem_pct)}%</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-slate-500">Preço sugerido</dt>
                <dd className="text-base font-bold tabular-nums text-brand-600">{formatMoney(ficha.preco_sugerido)}</dd>
              </div>
              {ficha.calculado_em && <p className="pt-1 text-[11px] text-slate-400">Recalculado automaticamente a cada alteração.</p>}
            </dl>
          </div>
          {ficha.custo_calculado && ehGerente && (
            <Alert tone="blue">O preço sugerido considera a margem da ficha. Ao clicar em “Aplicar preço”, o custo e o preço de venda do produto são atualizados (fica registrado na auditoria).</Alert>
          )}
        </div>
      </div>

      {/* Modal cabeçalho */}
      <Modal open={editOpen} onClose={() => setEditOpen(false)} title="Editar custos e margem" subtitle="Ao salvar, custo e preço sugerido são recalculados." size="sm">
        {editErr && <Alert tone="red">{editErr}</Alert>}
        <div className="space-y-4">
          <label className="block">
            <span className="label">Mão de obra (R$ por peça)</span>
            <input className="input" value={editVal.mao_obra ?? ''} onChange={(e) => setEditVal((v) => ({ ...v, mao_obra: e.target.value }))} inputMode="decimal" placeholder="0,00" />
          </label>
          <label className="block">
            <span className="label">Custos indiretos (R$ por peça)</span>
            <input className="input" value={editVal.custos_indiretos ?? ''} onChange={(e) => setEditVal((v) => ({ ...v, custos_indiretos: e.target.value }))} inputMode="decimal" placeholder="0,00" />
          </label>
          <label className="block">
            <span className="label">Margem (%)</span>
            <input className="input" value={editVal.margem_pct ?? ''} onChange={(e) => setEditVal((v) => ({ ...v, margem_pct: e.target.value }))} inputMode="decimal" placeholder="0" />
          </label>
          <div className="flex justify-end gap-2">
            <button className="btn-secondary" onClick={() => setEditOpen(false)}>Cancelar</button>
            <button className="btn-primary" onClick={salvarCabecalho} disabled={savingEdit}>
              {savingEdit && <Loader2 className="h-4 w-4 animate-spin" />} Salvar
            </button>
          </div>
        </div>
      </Modal>

      {/* Modal insumo */}
      <Modal
        open={!!insumoModal}
        onClose={() => setInsumoModal(null)}
        title={insumoModal === 'novo' ? 'Adicionar insumo' : 'Editar insumo'}
        subtitle="Consumo = quanto desse insumo é usado em 1 peça."
        size="sm"
      >
        {formErr && <Alert tone="red">{formErr}</Alert>}
        <div className="space-y-4">
          <label className="block">
            <span className="label">Insumo</span>
            <select className="input" value={form.insumo_id} disabled={insumoModal !== 'novo'} onChange={(e) => setForm((f) => ({ ...f, insumo_id: e.target.value }))}>
              <option value="">Selecione...</option>
              {insumoOpts.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="label">Consumo por peça</span>
              <input className="input" value={form.consumo} onChange={(e) => setForm((f) => ({ ...f, consumo: e.target.value }))} inputMode="decimal" />
            </label>
            <label className="block">
              <span className="label">Perda (%)</span>
              <input className="input" value={form.perda_pct} onChange={(e) => setForm((f) => ({ ...f, perda_pct: e.target.value }))} inputMode="decimal" placeholder="0" />
            </label>
          </div>
          <div className="flex justify-end gap-2">
            <button className="btn-secondary" onClick={() => setInsumoModal(null)}>Cancelar</button>
            <button className="btn-primary" onClick={salvarInsumo} disabled={saving}>
              {saving && <Loader2 className="h-4 w-4 animate-spin" />} Salvar
            </button>
          </div>
        </div>
      </Modal>

      <ConfirmDialog
        open={!!toDelete}
        title="Remover insumo da ficha?"
        danger
        confirmLabel="Remover"
        busy={deleting}
        onCancel={() => setToDelete(null)}
        onConfirm={removerInsumo}
        message={<p>O custo da ficha será recalculado sem este insumo.</p>}
      />
    </div>
  );
}
