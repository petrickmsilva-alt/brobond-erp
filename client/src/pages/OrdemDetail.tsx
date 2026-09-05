import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { AlertTriangle, ArrowLeft, Cog, Loader2, Pencil, Plus, Play, CheckCircle2, RotateCcw, Trash2, XCircle } from 'lucide-react';
import { api, ApiError } from '../lib/api';
import { useMeta, type Option } from '../lib/meta';
import { useAuth } from '../auth/AuthContext';
import { Alert, Badge, ConfirmDialog, Modal, PageHeader, Spinner, useToast } from '../components/ui';
import { formatDate, formatNumber } from '../lib/format';

type ItemOP = { id: number; tamanho_id?: number; quantidade: number; tamanho_id__label?: string; [k: string]: any };

const STATUS_LABEL: Record<string, string> = { planejada: 'Planejada', em_producao: 'Em produção', concluida: 'Concluída', cancelada: 'Cancelada' };
const STATUS_TONE: Record<string, 'slate' | 'blue' | 'green' | 'red'> = { planejada: 'slate', em_producao: 'blue', concluida: 'green', cancelada: 'red' };

export default function OrdemDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const meta = useMeta();
  const { user } = useAuth();
  const toast = useToast();
  const ordemId = Number(id);
  const resource = meta.resources.ordens;
  const podeEditar = resource?.ops.update ?? false;
  const ehGerente = user?.perfil === 'admin' || user?.perfil === 'gerente';

  const [ordem, setOrdem] = useState<Record<string, any> | null>(null);
  const [itens, setItens] = useState<ItemOP[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const [produtoOpts, setProdutoOpts] = useState<Option[]>([]);
  const [tamanhoOpts, setTamanhoOpts] = useState<Option[]>([]);
  const etapaOptions = resource?.fields.find((f) => f.name === 'etapa')?.options || [];

  // edição do cabeçalho
  const [editOpen, setEditOpen] = useState(false);
  const [editVal, setEditVal] = useState<Record<string, string>>({});
  const [editErr, setEditErr] = useState('');
  const [savingEdit, setSavingEdit] = useState(false);

  // itens de grade
  const [itemModal, setItemModal] = useState<ItemOP | 'novo' | null>(null);
  const [itemForm, setItemForm] = useState<Record<string, string>>({ tamanho_id: '', quantidade: '1' });
  const [itemErr, setItemErr] = useState('');
  const [savingItem, setSavingItem] = useState(false);
  const [toDelete, setToDelete] = useState<ItemOP | null>(null);

  // conclusão forçada (falta de insumo)
  const [forceOpen, setForceOpen] = useState(false);
  const [forceMsg, setForceMsg] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [o, its] = await Promise.all([api.get<Record<string, any>>(`/ordens/${ordemId}`), api.get<ItemOP[]>(`/ordens/${ordemId}/itens`)]);
      setOrdem(o);
      setItens(its);
      setError('');
    } catch (e: any) {
      setError(e.message || 'Erro ao carregar a ordem de fabricação.');
    } finally {
      setLoading(false);
    }
  }, [ordemId]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    api.get<Option[]>('/produtos/options').then(setProdutoOpts).catch(() => {});
    api.get<Option[]>('/tamanhos/options').then(setTamanhoOpts).catch(() => {});
  }, []);

  const totalPecas = useMemo(() => {
    if (!ordem) return 0;
    return ordem.tipo === 'grade' ? itens.reduce((a, i) => a + Number(i.quantidade || 0), 0) : Number(ordem.quantidade || 0);
  }, [ordem, itens]);

  const tamanhosNaGrade = useMemo(() => new Set(itens.map((i) => Number(i.tamanho_id))), [itens]);
  const nomeProduto = produtoOpts.find((p) => p.value === Number(ordem?.produto_id))?.label;
  const nomeTamanho = tamanhoOpts.find((t) => t.value === Number(ordem?.tamanho_id))?.label;

  const status = String(ordem?.status || '');

  function abrirEdicao() {
    if (!ordem) return;
    setEditVal({
      produto_id: ordem.produto_id ? String(ordem.produto_id) : '',
      tipo: String(ordem.tipo || 'tamanho'),
      tamanho_id: ordem.tamanho_id ? String(ordem.tamanho_id) : '',
      quantidade: ordem.quantidade ? String(ordem.quantidade) : '',
      inicio: ordem.inicio ? String(ordem.inicio).slice(0, 10) : '',
      previsao: ordem.previsao ? String(ordem.previsao).slice(0, 10) : '',
      etapa: ordem.etapa || '',
      faccao: ordem.faccao || '',
      observacoes: ordem.observacoes || '',
    });
    setEditErr('');
    setEditOpen(true);
  }

  async function salvarCabecalho() {
    setSavingEdit(true);
    setEditErr('');
    const grade = editVal.tipo === 'grade';
    const payload: Record<string, unknown> = {
      produto_id: editVal.produto_id ? Number(editVal.produto_id) : null,
      tipo: editVal.tipo,
      inicio: editVal.inicio || null,
      previsao: editVal.previsao || null,
      etapa: editVal.etapa || null,
      faccao: editVal.faccao || null,
      observacoes: editVal.observacoes || null,
    };
    if (grade) {
      payload.tamanho_id = null;
      payload.quantidade = null;
    } else {
      payload.tamanho_id = editVal.tamanho_id ? Number(editVal.tamanho_id) : null;
      payload.quantidade = editVal.quantidade ? Number(editVal.quantidade) : null;
    }
    try {
      await api.put(`/ordens/${ordemId}`, payload);
      toast.success('OP atualizada.');
      setEditOpen(false);
      await load();
    } catch (e: any) {
      setEditErr(e instanceof ApiError ? e.message : 'Não foi possível salvar.');
    } finally {
      setSavingEdit(false);
    }
  }

  async function mudarStatus(statusNovo: string, forcar = false) {
    setBusy(true);
    setError('');
    try {
      await api.put(`/ordens/${ordemId}${forcar ? '?forcar=true' : ''}`, { status: statusNovo });
      toast.success(
        statusNovo === 'concluida' ? 'OP concluída: peças entraram no estoque e insumos foram baixados.' : statusNovo === 'cancelada' ? 'OP cancelada.' : 'OP atualizada.'
      );
      setForceOpen(false);
      await load();
    } catch (e: any) {
      const msg = e instanceof ApiError ? e.message : 'Não foi possível alterar o status.';
      if (statusNovo === 'concluida' && e instanceof ApiError && e.status === 409 && ehGerente) {
        setForceMsg(msg);
        setForceOpen(true);
      } else {
        toast.error(msg);
      }
    } finally {
      setBusy(false);
    }
  }

  function abrirItem(linha: ItemOP | 'novo') {
    if (linha === 'novo') setItemForm({ tamanho_id: '', quantidade: '1' });
    else setItemForm({ tamanho_id: String(linha.tamanho_id ?? ''), quantidade: String(linha.quantidade ?? '') });
    setItemErr('');
    setItemModal(linha);
  }

  async function salvarItem() {
    if (!itemForm.tamanho_id) return setItemErr('Selecione o tamanho.');
    if (!(Number(itemForm.quantidade) > 0)) return setItemErr('Informe uma quantidade maior que zero.');
    setSavingItem(true);
    setItemErr('');
    const payload = { tamanho_id: Number(itemForm.tamanho_id), quantidade: Number(itemForm.quantidade) };
    try {
      if (itemModal === 'novo') await api.post(`/ordens/${ordemId}/itens`, payload);
      else if (itemModal) await api.put(`/ordens/${ordemId}/itens/${itemModal.id}`, payload);
      toast.success(itemModal === 'novo' ? 'Tamanho adicionado à grade.' : 'Quantidade atualizada.');
      setItemModal(null);
      await load();
    } catch (e: any) {
      setItemErr(e instanceof ApiError ? e.message : 'Não foi possível salvar o item.');
    } finally {
      setSavingItem(false);
    }
  }

  async function removerItem() {
    if (!toDelete) return;
    setBusy(true);
    try {
      await api.del(`/ordens/${ordemId}/itens/${toDelete.id}`);
      toast.success('Tamanho removido da grade.');
      setToDelete(null);
      await load();
    } catch (e: any) {
      toast.error(e.message || 'Não foi possível remover.');
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <Spinner />;
  if (error || !ordem)
    return (
      <div className="p-4 sm:p-6">
        <Alert tone="red">{error}</Alert>
        <Link to="/ordens" className="btn-secondary mt-4">
          <ArrowLeft className="h-4 w-4" /> Voltar para Ordens
        </Link>
      </div>
    );

  const aberta = !['concluida', 'cancelada'].includes(status);
  const grade = ordem.tipo === 'grade';

  return (
    <div className="p-4 pb-24 sm:p-6 md:pb-6">
      <PageHeader
        title={
          <span className="flex items-center gap-2.5">
            <button className="btn-icon" onClick={() => navigate('/ordens')} aria-label="Voltar">
              <ArrowLeft className="h-4 w-4" />
            </button>
            <Cog className="h-5 w-5 text-navy-600" />
            Ordem de fabricação #{ordem.id}
            <Badge tone={STATUS_TONE[status] || 'slate'}>{STATUS_LABEL[status] || status}</Badge>
            {grade && <Badge tone="blue">Por grade</Badge>}
          </span>
        }
        description={nomeProduto ? `${nomeProduto} · ${totalPecas} peça(s)` : `${totalPecas} peça(s)`}
        actions={
          <>
            {podeEditar && aberta && (
              <button className="btn-secondary" onClick={abrirEdicao}>
                <Pencil className="h-4 w-4" /> Editar
              </button>
            )}
            {status === 'planejada' && (
              <button className="btn-primary" disabled={busy} onClick={() => mudarStatus('em_producao')}>
                <Play className="h-4 w-4" /> Iniciar produção
              </button>
            )}
            {status === 'em_producao' && (
              <button className="btn-accent" disabled={busy} onClick={() => mudarStatus('concluida')}>
                <CheckCircle2 className="h-4 w-4" /> Concluir OP
              </button>
            )}
            {status === 'concluida' && ehGerente && (
              <button className="btn-secondary" disabled={busy} onClick={() => mudarStatus('planejada')}>
                <RotateCcw className="h-4 w-4" /> Reabrir (estorna)
              </button>
            )}
            {aberta && (
              <button className="btn-danger" disabled={busy} onClick={() => mudarStatus('cancelada')}>
                <XCircle className="h-4 w-4" /> Cancelar
              </button>
            )}
          </>
        }
      />

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <div className="space-y-4 xl:col-span-2">
          {/* Itens / grade */}
          <div className="card overflow-hidden">
            <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
              <h2 className="text-sm font-bold text-navy-900">{grade ? 'Grade de produção (por tamanho)' : 'Produção (por tamanho único)'}</h2>
              {grade && podeEditar && aberta && (
                <button className="btn-secondary !py-1.5 text-xs" onClick={() => abrirItem('novo')}>
                  <Plus className="h-4 w-4" /> Adicionar tamanho
                </button>
              )}
            </div>
            {!grade ? (
              <dl className="grid grid-cols-2 gap-4 p-4 text-sm sm:grid-cols-4">
                <div>
                  <dt className="label">Produto</dt>
                  <dd className="font-medium text-slate-800">{nomeProduto || `#${ordem.produto_id}`}</dd>
                </div>
                <div>
                  <dt className="label">Tamanho</dt>
                  <dd className="font-medium text-slate-800">{nomeTamanho || '—'}</dd>
                </div>
                <div>
                  <dt className="label">Quantidade</dt>
                  <dd className="text-lg font-bold text-navy-900">{formatNumber(ordem.quantidade)}</dd>
                </div>
                <div>
                  <dt className="label">Entregue no estoque</dt>
                  <dd>{status === 'concluida' ? 'Sim' : 'Ao concluir'}</dd>
                </div>
              </dl>
            ) : (
              <>
                {itens.length === 0 ? (
                  <div className="p-6 text-center text-sm text-slate-400">Nenhum tamanho na grade. Adicione os tamanhos que serão produzidos.</div>
                ) : (
                  <table className="table">
                    <thead>
                      <tr>
                        <th>Tamanho</th>
                        <th className="text-right">Quantidade</th>
                        <th className="text-right">Produzido</th>
                        {podeEditar && aberta && <th className="w-20 text-right">Ações</th>}
                      </tr>
                    </thead>
                    <tbody>
                      {itens.map((it) => (
                        <tr key={it.id}>
                          <td className="font-medium text-slate-800">{it.tamanho_id__label || tamanhoOpts.find((t) => t.value === Number(it.tamanho_id))?.label || `#${it.tamanho_id}`}</td>
                          <td className="text-right tabular-nums">{formatNumber(it.quantidade)}</td>
                          <td className="text-right tabular-nums text-slate-500">{formatNumber(it.produzido)}</td>
                          {podeEditar && aberta && (
                            <td className="text-right">
                              <div className="inline-flex gap-1">
                                <button className="btn-icon" onClick={() => abrirItem(it)} aria-label="Editar quantidade">
                                  <Pencil className="h-4 w-4" />
                                </button>
                                <button className="btn-icon hover:!bg-red-50 hover:!text-red-600" onClick={() => setToDelete(it)} aria-label="Remover tamanho">
                                  <Trash2 className="h-4 w-4" />
                                </button>
                              </div>
                            </td>
                          )}
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr className="bg-slate-50">
                        <th className="text-right">Total</th>
                        <th className="text-right tabular-nums">{formatNumber(totalPecas)}</th>
                        <th />
                        {podeEditar && aberta && <th />}
                      </tr>
                    </tfoot>
                  </table>
                )}
              </>
            )}
          </div>
          {ordem.observacoes && (
            <div className="card p-4 text-sm">
              <span className="label">Observações</span>
              <p className="whitespace-pre-wrap text-slate-700">{ordem.observacoes}</p>
            </div>
          )}
        </div>

        <div className="space-y-4">
          <div className="card p-5">
            <h2 className="text-sm font-bold text-navy-900">Detalhes</h2>
            <dl className="mt-3 space-y-2.5 text-sm">
              <div className="flex justify-between">
                <dt className="text-slate-500">Etapa</dt>
                <dd>{etapaOptions.find((o) => o.value === ordem.etapa)?.label || '—'}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-slate-500">Facção</dt>
                <dd>{ordem.faccao || '—'}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-slate-500">Início</dt>
                <dd>{formatDate(ordem.inicio)}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-slate-500">Previsão</dt>
                <dd>{formatDate(ordem.previsao)}</dd>
              </div>
              {ordem.concluida_em && (
                <div className="flex justify-between">
                  <dt className="text-slate-500">Concluída em</dt>
                  <dd>{formatDate(ordem.concluida_em)}</dd>
                </div>
              )}
            </dl>
          </div>
          <Alert tone={aberta ? 'blue' : 'slate'}>
            {status === 'planejada'
              ? 'Ao concluir, a OP dá entrada das peças no estoque (no Local padrão) e baixa os insumos da ficha técnica, considerando a perda.'
              : status === 'em_producao'
                ? 'A OP já pode ser concluída: entrada de peças + baixa automática de insumos com a perda da ficha técnica.'
                : status === 'concluida'
                  ? 'As peças já estão no estoque. Reabrir estorna tudo (peças e insumos) e exige perfil de gerente ou administrador.'
                  : 'Esta OP está cancelada e não movimenta o estoque.'}
          </Alert>
        </div>
      </div>

      {/* Modal cabeçalho */}
      <Modal open={editOpen} onClose={() => setEditOpen(false)} title="Editar ordem de fabricação" subtitle="Tipo de OP: por tamanho único ou por grade (vários tamanhos)." size="md">
        {editErr && <Alert tone="red">{editErr}</Alert>}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <label className="block sm:col-span-2">
            <span className="label">Produto</span>
            <select className="input" value={editVal.produto_id} onChange={(e) => setEditVal((v) => ({ ...v, produto_id: e.target.value }))}>
              <option value="">Selecione...</option>
              {produtoOpts.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="label">Tipo</span>
            <select
              className="input"
              value={editVal.tipo}
              onChange={(e) => {
                const tipo = e.target.value;
                setEditVal((v) => ({ ...v, tipo, tamanho_id: tipo === 'grade' ? '' : v.tamanho_id, quantidade: tipo === 'grade' ? '' : v.quantidade }));
              }}
            >
              <option value="tamanho">Por tamanho único</option>
              <option value="grade">Por grade (vários tamanhos)</option>
            </select>
          </label>
          {editVal.tipo === 'grade' ? (
            <div className="flex items-end pb-1 text-xs text-slate-400">A grade é preenchida pelos tamanhos abaixo da lista.</div>
          ) : (
            <>
              <label className="block">
                <span className="label">Tamanho</span>
                <select className="input" value={editVal.tamanho_id} onChange={(e) => setEditVal((v) => ({ ...v, tamanho_id: e.target.value }))}>
                  <option value="">Selecione...</option>
                  {tamanhoOpts.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="label">Quantidade</span>
                <input className="input" type="number" min={1} value={editVal.quantidade} onChange={(e) => setEditVal((v) => ({ ...v, quantidade: e.target.value }))} />
              </label>
            </>
          )}
          <label className="block">
            <span className="label">Início</span>
            <input type="date" className="input" value={editVal.inicio} onChange={(e) => setEditVal((v) => ({ ...v, inicio: e.target.value }))} />
          </label>
          <label className="block">
            <span className="label">Previsão</span>
            <input type="date" className="input" value={editVal.previsao} onChange={(e) => setEditVal((v) => ({ ...v, previsao: e.target.value }))} />
          </label>
          <label className="block">
            <span className="label">Etapa</span>
            <select className="input" value={editVal.etapa} onChange={(e) => setEditVal((v) => ({ ...v, etapa: e.target.value }))}>
              <option value="">—</option>
              {etapaOptions.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="label">Facção</span>
            <input className="input" value={editVal.faccao} onChange={(e) => setEditVal((v) => ({ ...v, faccao: e.target.value }))} />
          </label>
          <label className="block sm:col-span-2">
            <span className="label">Observações</span>
            <textarea className="input" rows={2} value={editVal.observacoes} onChange={(e) => setEditVal((v) => ({ ...v, observacoes: e.target.value }))} />
          </label>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <button className="btn-secondary" onClick={() => setEditOpen(false)}>Cancelar</button>
          <button className="btn-primary" onClick={salvarCabecalho} disabled={savingEdit}>
            {savingEdit && <Loader2 className="h-4 w-4 animate-spin" />} Salvar
          </button>
        </div>
      </Modal>

      {/* Modal item de grade */}
      <Modal
        open={!!itemModal}
        onClose={() => setItemModal(null)}
        title={itemModal === 'novo' ? 'Adicionar tamanho à grade' : 'Editar quantidade'}
        size="sm"
      >
        {itemErr && <Alert tone="red">{itemErr}</Alert>}
        <div className="space-y-4">
          <label className="block">
            <span className="label">Tamanho</span>
            <select className="input" value={itemForm.tamanho_id} disabled={itemModal !== 'novo'} onChange={(e) => setItemForm((f) => ({ ...f, tamanho_id: e.target.value }))}>
              <option value="">Selecione...</option>
              {tamanhoOpts
                .filter((o) => itemModal === 'novo' ? !tamanhosNaGrade.has(o.value) : true)
                .map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
            </select>
          </label>
          <label className="block">
            <span className="label">Quantidade</span>
            <input className="input" type="number" min={1} value={itemForm.quantidade} onChange={(e) => setItemForm((f) => ({ ...f, quantidade: e.target.value }))} />
          </label>
          <div className="flex justify-end gap-2">
            <button className="btn-secondary" onClick={() => setItemModal(null)}>Cancelar</button>
            <button className="btn-primary" onClick={salvarItem} disabled={savingItem}>
              {savingItem && <Loader2 className="h-4 w-4 animate-spin" />} Salvar
            </button>
          </div>
        </div>
      </Modal>

      <ConfirmDialog
        open={!!toDelete}
        title="Remover tamanho da grade?"
        danger
        confirmLabel="Remover"
        busy={busy}
        onCancel={() => setToDelete(null)}
        onConfirm={removerItem}
        message={<p>O tamanho sairá da grade da OP. As quantidades produzidas já registradas não são apagadas.</p>}
      />

      <ConfirmDialog
        open={forceOpen}
        title="Concluir mesmo sem saldo de insumos?"
        danger
        confirmLabel="Concluir mesmo assim (forçar)"
        busy={busy}
        onCancel={() => setForceOpen(false)}
        onConfirm={() => mudarStatus('concluida', true)}
        message={
          <div className="space-y-2">
            <AlertTriangle className="h-5 w-5 text-brand-500" />
            <p className="whitespace-pre-wrap">{forceMsg}</p>
            <p className="text-xs text-slate-500">O saldo dos insumos em falta ficará negativo e o fato será registrado na auditoria.</p>
          </div>
        }
      />
    </div>
  );
}
