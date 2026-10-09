import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { AlertTriangle, ArrowLeft, ClipboardList, Cog, History, Loader2, Pencil, Plus, Play, CheckCircle2, RotateCcw, Trash2, Unlock, XCircle } from 'lucide-react';
import { api, ApiError } from '../lib/api';
import { useMeta, type Option } from '../lib/meta';
import { useAuth } from '../auth/AuthContext';
import { Alert, Badge, ConfirmDialog, Modal, PageHeader, Spinner, useToast } from '../components/ui';
import { formatDate, formatMoney, formatNumber } from '../lib/format';

type ItemOP = { id: number; tamanho_id?: number; quantidade: number; tamanho_id__label?: string; [k: string]: any };

// Os seis estados da E2. `liberada` = plano fechado e custo previsto congelado;
// `parcial` = chão de fábrica já apontou produção, mas ainda falta peça.
const STATUS_LABEL: Record<string, string> = {
  planejada: 'Planejada',
  liberada: 'Liberada',
  em_producao: 'Em produção',
  parcial: 'Parcial',
  concluida: 'Concluída',
  cancelada: 'Cancelada',
};
const STATUS_TONE: Record<string, 'slate' | 'blue' | 'green' | 'red' | 'amber'> = {
  planejada: 'slate',
  liberada: 'amber',
  em_producao: 'blue',
  parcial: 'blue',
  concluida: 'green',
  cancelada: 'red',
};

/** Em quais estados o chão de fábrica pode apontar produção. */
const PODE_APONTAR = ['liberada', 'em_producao', 'parcial'];

const EVENTO_LABEL: Record<string, string> = {
  criada: 'Criada',
  liberada: 'Liberada',
  iniciada: 'Iniciada',
  apontamento: 'Apontamento',
  perda: 'Perda',
  consumo: 'Consumo de insumo',
  parcial: 'Parcial',
  concluida: 'Concluída',
  reaberta: 'Reaberta',
  cancelada: 'Cancelada',
  atalho: 'Atalho de fluxo',
  edicao: 'Edição',
};
const EVENTO_TONE: Record<string, 'slate' | 'blue' | 'green' | 'red' | 'amber'> = {
  liberada: 'amber',
  iniciada: 'blue',
  apontamento: 'blue',
  perda: 'red',
  consumo: 'amber',
  parcial: 'blue',
  concluida: 'green',
  reaberta: 'amber',
  cancelada: 'red',
  atalho: 'amber',
};

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

  // apontamento de produção (chão de fábrica)
  const [apontOpen, setApontOpen] = useState(false);
  const [apontForm, setApontForm] = useState({ tamanho_id: '', quantidade_produzida: '1', quantidade_perdida: '0', observacoes: '' });
  const [apontErr, setApontErr] = useState('');
  const [savingApont, setSavingApont] = useState(false);
  const [apontamentos, setApontamentos] = useState<Record<string, any>[]>([]);
  const [eventos, setEventos] = useState<Record<string, any>[]>([]);
  const [trilhaAberta, setTrilhaAberta] = useState(false);
  // cancelar com motivo: a confirmação genérica não dá campo de texto
  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelMotivo, setCancelMotivo] = useState('');
  const [apontForcar, setApontForcar] = useState(false);
  // Uma chave por abertura do modal: repetir o clique não duplica o consumo.
  const [chaveIdem] = useState(() => `op-${ordemId}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [o, its, aps, evs] = await Promise.all([
        api.get<Record<string, any>>(`/ordens/${ordemId}`),
        api.get<ItemOP[]>(`/ordens/${ordemId}/itens`),
        api.get<Record<string, any>[]>(`/ordens/${ordemId}/apontamentos`).catch(() => [] as Record<string, any>[]),
        api.get<Record<string, any>[]>(`/ordens/${ordemId}/eventos`).catch(() => [] as Record<string, any>[]),
      ]);
      setOrdem(o);
      setItens(its);
      setApontamentos(aps);
      setEventos(evs);
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

  const grade0 = String(ordem?.tipo || '') === 'grade';
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

  /**
   * Liberação e início usam os endpoints de fluxo (não o PUT genérico): eles
   * gravam o custo previsto, os marcos de tempo e a trilha.
   */
  async function acaoFluxo(acao: 'liberar' | 'iniciar', mensagem: string) {
    setBusy(true);
    setError('');
    try {
      await api.post(`/ordens/${ordemId}/${acao}`, {});
      toast.success(mensagem);
      await load();
    } catch (e: any) {
      toast.error(e instanceof ApiError ? e.message : 'Não foi possível executar a ação.');
    } finally {
      setBusy(false);
    }
  }

  function abrirApontamento() {
    setApontForm({
      tamanho_id: grade0 ? String(itens[0]?.tamanho_id ?? '') : String(ordem?.tamanho_id ?? ''),
      quantidade_produzida: '1',
      quantidade_perdida: '0',
      observacoes: '',
    });
    setApontErr('');
    setApontOpen(true);
  }

  async function salvarApontamento(forcar = false) {
    const produzida = Number(apontForm.quantidade_produzida);
    const perdida = Number(apontForm.quantidade_perdida);
    if (!Number.isInteger(produzida) || produzida < 0) return setApontErr('Peças produzidas deve ser um inteiro maior ou igual a zero.');
    if (!Number.isInteger(perdida) || perdida < 0) return setApontErr('Peças refugadas deve ser um inteiro maior ou igual a zero.');
    if (produzida <= 0 && perdida <= 0) return setApontErr('Informe peças produzidas ou refugadas.');
    setSavingApont(true);
    setApontErr('');
    try {
      // A chave é gerada por abertura do modal: repetir o POST por rede instável
      // devolve o mesmo apontamento em vez de consumir insumo duas vezes.
      const r = await api.post<Record<string, any>>(
        `/ordens/${ordemId}/apontamentos${forcar ? '?forcar=true' : ''}`,
        {
          tamanho_id: apontForm.tamanho_id ? Number(apontForm.tamanho_id) : undefined,
          quantidade_produzida: produzida,
          quantidade_perdida: perdida,
          observacoes: apontForm.observacoes || undefined,
          idempotency_key: chaveIdem,
        }
      );
      toast.success(
        r?.idempotente
          ? 'Esse apontamento já tinha sido registrado — nada foi baixado de novo.'
          : 'Apontamento registrado: insumos baixados e produção acumulada.'
      );
      setApontOpen(false);
      await load();
    } catch (e: any) {
      const msg = e instanceof ApiError ? e.message : 'Não foi possível registrar o apontamento.';
      // Sem saldo de insumo: só gerente/admin pode forçar, e o custo fica negativo
      // de propósito (compra em atraso) — daí o alerta explicando o efeito.
      if (!forcar && e instanceof ApiError && e.status === 409 && ehGerente && /insumo/i.test(msg)) {
        setApontErr(`${msg} Você pode forçar a baixa: o saldo do insumo fica negativo e a ação fica auditada.`);
        setApontForcar(true);
      } else {
        setApontErr(msg);
      }
    } finally {
      setSavingApont(false);
    }
  }

  async function confirmarCancelamento() {
    setBusy(true);
    try {
      await api.post(`/ordens/${ordemId}/cancelar`, { motivo: cancelMotivo.trim() || null });
      toast.success('OP cancelada.');
      setCancelOpen(false);
      setCancelMotivo('');
      await load();
    } catch (e: any) {
      toast.error(e instanceof ApiError ? e.message : 'Não foi possível cancelar a OP.');
    } finally {
      setBusy(false);
    }
  }

  async function reabrir() {
    setBusy(true);
    try {
      await api.post(`/ordens/${ordemId}/reabrir`, {});
      toast.success('OP reaberta: peças e insumos foram estornados e os apontamentos descartados.');
      await load();
    } catch (e: any) {
      toast.error(e instanceof ApiError ? e.message : 'Não foi possível reabrir a OP.');
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
  const planoEditavel = ['planejada', 'liberada', 'em_producao'].includes(status);
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
            {podeEditar && planoEditavel && (
              <button className="btn-secondary" onClick={abrirEdicao}>
                <Pencil className="h-4 w-4" /> Editar
              </button>
            )}
            {status === 'planejada' && ehGerente && (
              <button className="btn-primary" disabled={busy} onClick={() => acaoFluxo('liberar', 'OP liberada: custo previsto congelado e pronta para o chão de fábrica.')}>
                <Unlock className="h-4 w-4" /> Liberar para produção
              </button>
            )}
            {['planejada', 'liberada', 'parcial'].includes(status) && (
              <button className="btn-primary" disabled={busy} onClick={() => acaoFluxo('iniciar', 'Produção iniciada.')}>
                <Play className="h-4 w-4" /> {status === 'parcial' ? 'Retomar produção' : 'Iniciar produção'}
              </button>
            )}
            {PODE_APONTAR.includes(status) && (
              <button className="btn-secondary" disabled={busy} onClick={abrirApontamento}>
                <ClipboardList className="h-4 w-4" /> Apontar produção
              </button>
            )}
            {['planejada', 'liberada', 'em_producao', 'parcial'].includes(status) && (
              <button className="btn-accent" disabled={busy} onClick={() => mudarStatus('concluida')}>
                <CheckCircle2 className="h-4 w-4" /> Concluir OP
              </button>
            )}
            {status === 'concluida' && ehGerente && (
              <button className="btn-secondary" disabled={busy} onClick={reabrir}>
                <RotateCcw className="h-4 w-4" /> Reabrir (estorna)
              </button>
            )}
            {aberta && ehGerente && (
              <button className="btn-danger" disabled={busy} onClick={() => setCancelOpen(true)}>
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
              {grade && podeEditar && planoEditavel && (
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
                        {podeEditar && planoEditavel && <th className="w-20 text-right">Ações</th>}
                      </tr>
                    </thead>
                    <tbody>
                      {itens.map((it) => (
                        <tr key={it.id}>
                          <td className="font-medium text-slate-800">{it.tamanho_id__label || tamanhoOpts.find((t) => t.value === Number(it.tamanho_id))?.label || `#${it.tamanho_id}`}</td>
                          <td className="text-right tabular-nums">{formatNumber(it.quantidade)}</td>
                          <td className="text-right tabular-nums text-slate-500">{formatNumber(it.produzido)}</td>
                          {podeEditar && planoEditavel && (
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
                        {podeEditar && planoEditavel && <th />}
                      </tr>
                    </tfoot>
                  </table>
                )}
              </>
            )}
          </div>
          {/* Apontamentos: o que o chão de fábrica realmente produziu */}
          <div className="card overflow-hidden">
            <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
              <h2 className="text-sm font-bold text-navy-900">Apontamentos de produção</h2>
              {PODE_APONTAR.includes(status) && (
                <button className="btn-secondary !py-1.5 text-xs" onClick={abrirApontamento}>
                  <ClipboardList className="h-4 w-4" /> Apontar
                </button>
              )}
            </div>
            {apontamentos.length === 0 ? (
              <div className="p-6 text-center text-sm text-slate-400">
                {PODE_APONTAR.includes(status)
                  ? 'Nenhuma produção apontada ainda. Ao concluir sem apontamento, entra a quantidade planejada inteira.'
                  : 'Esta OP não teve apontamentos.'}
              </div>
            ) : (
              <table className="table">
                <thead>
                  <tr>
                    <th>Quando</th>
                    <th>Tamanho</th>
                    <th className="text-right">Boas</th>
                    <th className="text-right">Refugadas</th>
                    <th>Quem</th>
                  </tr>
                </thead>
                <tbody>
                  {apontamentos.map((a) => (
                    <tr key={a.id}>
                      <td className="whitespace-nowrap text-slate-500">{formatDate(a.apontado_em)}</td>
                      <td className="font-medium text-slate-800">{a.tamanho_id__label || `#${a.tamanho_id ?? '—'}`}</td>
                      <td className="text-right tabular-nums">{formatNumber(a.quantidade_produzida)}</td>
                      <td className={`text-right tabular-nums ${Number(a.quantidade_perdida) > 0 ? 'font-semibold text-red-600' : 'text-slate-400'}`}>
                        {formatNumber(a.quantidade_perdida)}
                      </td>
                      <td className="text-slate-500">{a.usuario_id__label || '—'}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="bg-slate-50">
                    <th colSpan={2} className="text-right">Total</th>
                    <th className="text-right tabular-nums">{formatNumber(apontamentos.reduce((x, a) => x + Number(a.quantidade_produzida || 0), 0))}</th>
                    <th className="text-right tabular-nums text-red-600">{formatNumber(apontamentos.reduce((x, a) => x + Number(a.quantidade_perdida || 0), 0))}</th>
                    <th />
                  </tr>
                </tfoot>
              </table>
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
          {/* Custos: o previsto é congelado na liberação; o real vem da execução */}
          <div className="card p-5">
            <h2 className="text-sm font-bold text-navy-900">Custo da OP</h2>
            <dl className="mt-3 space-y-2.5 text-sm">
              <div className="flex items-baseline justify-between">
                <dt className="text-slate-500">Custo previsto</dt>
                <dd className="font-medium tabular-nums text-slate-800">
                  {ordem.custo_previsto == null ? '— (define ao liberar)' : formatMoney(ordem.custo_previsto)}
                </dd>
              </div>
              <div className="flex items-baseline justify-between">
                <dt className="text-slate-500">Custo real</dt>
                <dd className="text-base font-bold tabular-nums text-navy-900">{formatMoney(ordem.custo_real ?? 0)}</dd>
              </div>
              <div className="flex items-baseline justify-between">
                <dt className="text-slate-500">Peças boas / refugadas</dt>
                <dd className="tabular-nums">
                  <span className="font-semibold text-emerald-700">{formatNumber(ordem.quantidade_produzida ?? 0)}</span>
                  <span className="text-slate-400"> / </span>
                  <span className={Number(ordem.quantidade_perdida) > 0 ? 'font-semibold text-red-600' : 'text-slate-400'}>
                    {formatNumber(ordem.quantidade_perdida ?? 0)}
                  </span>
                </dd>
              </div>
              <div>
                <dt className="mb-1 text-slate-500">
                  Progresso — {formatNumber(ordem.quantidade_produzida ?? 0)} de {formatNumber(totalPecas)}
                </dt>
                <dd>
                  <div className="h-2 w-full overflow-hidden rounded-full bg-slate-100" role="presentation">
                    <div
                      className="h-full rounded-full bg-navy-600 transition-all"
                      style={{ width: `${totalPecas > 0 ? Math.min(100, (Number(ordem.quantidade_produzida ?? 0) / totalPecas) * 100) : 0}%` }}
                    />
                  </div>
                </dd>
              </div>
              {Number(ordem.custo_previsto) > 0 && Number(ordem.custo_real) > 0 && (
                <div className="flex justify-between border-t border-slate-100 pt-2">
                  <dt className="text-slate-500">Variação</dt>
                  <dd
                    className={`font-semibold tabular-nums ${
                      Number(ordem.custo_real) > Number(ordem.custo_previsto) ? 'text-red-600' : 'text-emerald-700'
                    }`}
                  >
                    {Number(ordem.custo_real) > Number(ordem.custo_previsto) ? '+' : ''}
                    {formatMoney(Number(ordem.custo_real) - Number(ordem.custo_previsto))}
                  </dd>
                </div>
              )}
            </dl>
          </div>

          {/* Trilha: quem moveu a OP e por quê */}
          <div className="card overflow-hidden">
            <button
              type="button"
              className="flex w-full items-center justify-between px-4 py-3 text-left"
              onClick={() => setTrilhaAberta((v) => !v)}
              aria-expanded={trilhaAberta}
            >
              <span className="flex items-center gap-2 text-sm font-bold text-navy-900">
                <History className="h-4 w-4 text-slate-400" /> Histórico da OP
              </span>
              <span className="text-xs text-slate-400">{eventos.length} evento(s)</span>
            </button>
            {trilhaAberta && (
              <ul className="divide-y divide-slate-100 border-t border-slate-200">
                {eventos.length === 0 ? (
                  <li className="p-4 text-center text-sm text-slate-400">Nenhum evento registrado.</li>
                ) : (
                  eventos.map((e) => (
                    <li key={e.id} className="px-4 py-2.5 text-sm">
                      <div className="flex items-center justify-between gap-2">
                        <Badge tone={EVENTO_TONE[String(e.evento)] || 'slate'}>{EVENTO_LABEL[String(e.evento)] || e.evento}</Badge>
                        <span className="whitespace-nowrap text-xs text-slate-400">{formatDate(e.criado_em)}</span>
                      </div>
                      {e.mensagem && <p className="mt-1 text-slate-600">{e.mensagem}</p>}
                      {e.usuario_id__label && <p className="mt-0.5 text-xs text-slate-400">por {e.usuario_id__label}</p>}
                    </li>
                  ))
                )}
              </ul>
            )}
          </div>

          <Alert tone={aberta ? 'blue' : 'slate'}>
            {status === 'planejada'
              ? 'Libere a OP para congelar o custo previsto. Concluir direto da planejada é permitido, mas pula liberação e produção e fica marcado no histórico.'
              : status === 'liberada'
                ? 'OP liberada: o custo previsto está congelado. Aponte a produção do chão de fábrica ou conclua para dar entrada das peças.'
                : PODE_APONTAR.includes(status)
                  ? 'Cada apontamento baixa os insumos da ficha (peça refugada também consome) e acumula a produção. A entrada no estoque acontece na conclusão.'
                  : status === 'concluida'
                    ? 'As peças já estão no estoque. Reabrir estorna tudo (peças, insumos e apontamentos) e exige perfil de gerente ou administrador.'
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

      {/* Modal de apontamento de produção */}
      <Modal
        open={apontOpen}
        onClose={() => setApontOpen(false)}
        title="Apontar produção"
        subtitle="Registre o que o chão de fábrica produziu. A peça refugada consome insumo e não entra no estoque."
        size="md"
      >
        {apontErr && <Alert tone="red">{apontErr}</Alert>}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <label className="block sm:col-span-2">
            <span className="label">Tamanho</span>
            {grade ? (
              <select className="input" value={apontForm.tamanho_id} onChange={(e) => setApontForm((v) => ({ ...v, tamanho_id: e.target.value }))}>
                <option value="">Selecione...</option>
                {itens.map((it) => (
                  <option key={it.id} value={it.tamanho_id}>
                    {it.tamanho_id__label || tamanhoOpts.find((t) => t.value === Number(it.tamanho_id))?.label || `#${it.tamanho_id}`} — planejado {formatNumber(it.quantidade)}
                  </option>
                ))}
              </select>
            ) : (
              <input className="input" value={nomeTamanho || `#${ordem.tamanho_id ?? ''}`} disabled readOnly />
            )}
          </label>
          <label className="block">
            <span className="label">Peças boas</span>
            <input
              className="input"
              type="number"
              min={0}
              step={1}
              inputMode="numeric"
              value={apontForm.quantidade_produzida}
              onChange={(e) => setApontForm((v) => ({ ...v, quantidade_produzida: e.target.value }))}
            />
          </label>
          <label className="block">
            <span className="label">Peças refugadas (perda)</span>
            <input
              className="input"
              type="number"
              min={0}
              step={1}
              inputMode="numeric"
              value={apontForm.quantidade_perdida}
              onChange={(e) => setApontForm((v) => ({ ...v, quantidade_perdida: e.target.value }))}
            />
            <span className="mt-1 block text-xs text-slate-400">Consome insumo da ficha e não gera estoque.</span>
          </label>
          <label className="block sm:col-span-2">
            <span className="label">Observações (opcional)</span>
            <textarea
              className="input"
              rows={2}
              maxLength={500}
              value={apontForm.observacoes}
              onChange={(e) => setApontForm((v) => ({ ...v, observacoes: e.target.value }))}
              placeholder="Turno, máquina, ocorrência..."
            />
          </label>
        </div>
        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <button className="btn-secondary" onClick={() => setApontOpen(false)} disabled={savingApont}>
            Cancelar
          </button>
          {apontForcar && ehGerente ? (
            <button className="btn-danger" disabled={savingApont} onClick={() => salvarApontamento(true)}>
              {savingApont ? <Loader2 className="h-4 w-4 animate-spin" /> : <AlertTriangle className="h-4 w-4" />} Apontar forçando a baixa
            </button>
          ) : (
            <button className="btn-primary" disabled={savingApont} onClick={() => salvarApontamento(false)}>
              {savingApont ? <Loader2 className="h-4 w-4 animate-spin" /> : <ClipboardList className="h-4 w-4" />} Registrar apontamento
            </button>
          )}
        </div>
      </Modal>

      {/* Cancelar com motivo: é operação sensível e o motivo vai para a trilha */}
      <Modal open={cancelOpen} onClose={() => setCancelOpen(false)} title="Cancelar ordem de produção" subtitle="A OP deixa de movimentar estoque. Esta ação é registrada no histórico." size="sm">
        <label className="block">
          <span className="label">Motivo (opcional)</span>
          <textarea
            className="input"
            rows={3}
            maxLength={500}
            value={cancelMotivo}
            onChange={(e) => setCancelMotivo(e.target.value)}
            placeholder="Ex.: cliente desistiu da cor, insumo indisponível..."
          />
        </label>
        <div className="mt-5 flex justify-end gap-2">
          <button className="btn-secondary" onClick={() => setCancelOpen(false)} disabled={busy}>
            Voltar
          </button>
          <button className="btn-danger" disabled={busy} onClick={confirmarCancelamento}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <XCircle className="h-4 w-4" />} Cancelar OP
          </button>
        </div>
      </Modal>
    </div>
  );
}
