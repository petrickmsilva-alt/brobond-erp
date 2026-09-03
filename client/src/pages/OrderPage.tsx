import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Loader2, Plus, Printer, Save, Trash2, X } from 'lucide-react';
import { api } from '../lib/api';
import { useMeta, type Option, type ResourceMeta } from '../lib/meta';
import { useAuth } from '../auth/AuthContext';
import { Alert, Badge, ConfirmDialog, PageHeader, Spinner, useToast } from '../components/ui';
import { Thumb } from '../components/ImageField';
import { formatDate, formatMoney } from '../lib/format';

type Tipo = 'venda' | 'compra';
type Item = {
  id: number;
  produto_id?: number;
  insumo_id?: number;
  tamanho_id?: number;
  quantidade: number | string;
  preco_unitario: number | string;
  desconto_pct?: number | string;
  subtotal?: number;
  produto_id__label?: string;
  insumo_id__label?: string;
  tamanho_id__label?: string;
  produto_id__foto?: string | null;
  [k: string]: any;
};

const STATUS_TONE: Record<string, 'green' | 'red' | 'amber' | 'blue' | 'slate'> = {
  aberta: 'amber',
  faturada: 'green',
  entregue: 'blue',
  cancelada: 'red',
  pendente: 'amber',
  recebido: 'green',
  cancelado: 'red',
};

export default function OrderPage({ tipo }: { tipo: Tipo }) {
  const { id } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const { user } = useAuth();
  const meta = useMeta();
  const pedidoId = Number(id);

  const resVendas = meta.resources['vendas'];
  const resCompras = meta.resources['compras'];
  const resource: ResourceMeta = tipo === 'venda' ? resVendas : resCompras;

  const [pedido, setPedido] = useState<Record<string, any> | null>(null);
  const [itens, setItens] = useState<Item[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [busyItem, setBusyItem] = useState<number | 'new' | null>(null);
  const [toDelete, setToDelete] = useState<Item | null>(null);
  const [actionStatus, setActionStatus] = useState<string | null>(null);

  // rótulos para selects
  const [parceiroOpts, setParceiroOpts] = useState<Option[]>([]);
  const [repOpts, setRepOpts] = useState<Option[]>([]);
  const [produtos, setProdutos] = useState<Record<string, any>[]>([]);
  const [insumoOpts, setInsumoOpts] = useState<Option[]>([]);
  const [tamanhoOpts, setTamanhoOpts] = useState<Option[]>([]);

  const produtoOpts: (Option & { preco_venda?: number })[] = useMemo(
    () => produtos.map((r) => ({ value: r.id, label: `${r.sku} — ${r.nome}`, preco_venda: r.preco_venda })),
    [produtos]
  );

  // item novo (linha de edição)
  const blank: Item = useMemo(
    () =>
      tipo === 'venda'
        ? { id: 0, produto_id: undefined, tamanho_id: undefined, quantidade: 1, preco_unitario: '', desconto_pct: 0 }
        : { id: 0, insumo_id: undefined, quantidade: 1, preco_unitario: '' },
    [tipo]
  );
  const [novo, setNovo] = useState<Item>(blank);

  const fechado =
    tipo === 'venda' ? ['faturada', 'entregue'].includes(String(pedido?.status)) : String(pedido?.status) === 'recebido';
  const cancelado = tipo === 'venda' ? pedido?.status === 'cancelada' : pedido?.status === 'cancelado';
  // Operadores incluem/alteram, mas não excluem (itens nem pedidos).
  const podeExcluir = user?.perfil !== 'operador';

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [p, it] = await Promise.all([
        api.get<Record<string, any>>(`/${tipo === 'venda' ? 'vendas' : 'compras'}/${pedidoId}`),
        api.get<Item[]>(`/${tipo === 'venda' ? 'vendas' : 'compras'}/${pedidoId}/itens`),
      ]);
      setPedido(p);
      setItens(it);
    } catch (e: any) {
      setError(e.message || 'Erro ao carregar o pedido.');
    } finally {
      setLoading(false);
    }
  }, [pedidoId, tipo]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    const base = tipo === 'venda' ? 'vendas' : 'compras';
    api.get<Option[]>(`/${tipo === 'venda' ? 'clientes' : 'fornecedores'}/options`).then(setParceiroOpts).catch(() => {});
    api.get<Option[]>(`/tamanhos/options`).then(setTamanhoOpts).catch(() => {});
    if (tipo === 'venda') {
      api.get<Option[]>('/representantes/options').then(setRepOpts).catch(() => {});
      api
        .get<{ rows: any[] }>(`/produtos?pageSize=200&sort=nome`)
        .then((d) => setProdutos(d.rows))
        .catch(() => {});
    } else {
      api.get<Option[]>('/insumos/options').then(setInsumoOpts).catch(() => {});
    }
  }, [tipo]);

  const totalItens = useMemo(
    () =>
      itens.reduce((s, it) => {
        if (tipo === 'venda') return s + Number(it.subtotal || 0);
        return s + Number(it.quantidade) * Number(it.preco_unitario || 0);
      }, 0),
    [itens, tipo]
  );

  function subtotalNovo(): number {
    if (tipo === 'venda') {
      const q = Number(novo.quantidade) || 0;
      const p = Number(novo.preco_unitario) || 0;
      const d = Number(novo.desconto_pct) || 0;
      return Math.round(q * p * (1 - d / 100) * 100) / 100;
    }
    return Math.round((Number(novo.quantidade) || 0) * (Number(novo.preco_unitario) || 0) * 100) / 100;
  }

  async function saveHeader(field: string, value: unknown) {
    setSaving(true);
    try {
      const atual = await api.put<Record<string, any>>(`/${tipo === 'venda' ? 'vendas' : 'compras'}/${pedidoId}`, { [field]: value });
      setPedido(atual);
      toast.success('Pedido atualizado.');
    } catch (e: any) {
      toast.error(e.message || 'Não foi possível salvar.');
      await load();
    } finally {
      setSaving(false);
    }
  }

  async function addItem() {
    const refField = tipo === 'venda' ? 'produto_id' : 'insumo_id';
    if (!novo[refField]) return toast.error(tipo === 'venda' ? 'Selecione o produto.' : 'Selecione o insumo.');
    if (tipo === 'venda' && !novo.tamanho_id) return toast.error('Selecione o tamanho.');
    if (!(Number(novo.quantidade) > 0)) return toast.error('Informe a quantidade.');
    if (!(Number(novo.preco_unitario) >= 0)) return toast.error('Informe o preço unitário.');
    setBusyItem('new');
    try {
      const payload: Record<string, unknown> = {
        [refField]: Number(novo[refField]),
        quantidade: Number(novo.quantidade),
        preco_unitario: Number(novo.preco_unitario),
      };
      if (tipo === 'venda') {
        payload.tamanho_id = Number(novo.tamanho_id);
        payload.desconto_pct = Number(novo.desconto_pct || 0);
      }
      await api.post(`/${tipo === 'venda' ? 'vendas' : 'compras'}/${pedidoId}/itens`, payload);
      toast.success('Item adicionado.');
      setNovo(blank);
      await load();
    } catch (e: any) {
      toast.error(e.message || 'Não foi possível adicionar o item.');
    } finally {
      setBusyItem(null);
    }
  }

  async function removeItem() {
    if (!toDelete) return;
    setBusyItem(toDelete.id);
    try {
      await api.del(`/${tipo === 'venda' ? 'vendas' : 'compras'}/${pedidoId}/itens/${toDelete.id}`);
      toast.success('Item removido.');
      setToDelete(null);
      await load();
    } catch (e: any) {
      toast.error(e.message || 'Não foi possível remover o item.');
    } finally {
      setBusyItem(null);
    }
  }

  async function mudarStatus(status: string) {
    setActionStatus(status);
    try {
      const atual = await api.put<Record<string, any>>(`/${tipo === 'venda' ? 'vendas' : 'compras'}/${pedidoId}`, { status });
      setPedido(atual);
      toast.success(tipo === 'venda' ? 'Pedido atualizado.' : 'Compra atualizada.');
      await load();
    } catch (e: any) {
      toast.error(e.message || 'Não foi possível alterar o status.');
    } finally {
      setActionStatus(null);
    }
  }

  function prefillPreco() {
    if (tipo === 'venda' && novo.produto_id) {
      const p = produtoOpts.find((o) => o.value === Number(novo.produto_id));
      if (p?.preco_venda && !novo.preco_unitario) setNovo((n) => ({ ...n, preco_unitario: p.preco_venda! }));
    }
  }

  const statusOptions = resource?.fields.find((f) => f.name === 'status')?.options || [];
  const labelParceiro = tipo === 'venda' ? 'Cliente' : 'Fornecedor';
  const labelItemRef = tipo === 'venda' ? 'Produto' : 'Insumo';

  if (loading) return <Spinner />;
  if (error)
    return (
      <div className="p-4 sm:p-6">
        <Alert tone="red">{error}</Alert>
        <button className="btn-secondary mt-4" onClick={() => navigate(tipo === 'venda' ? '/vendas' : '/compras')}>
          <ArrowLeft className="h-4 w-4" /> Voltar
        </button>
      </div>
    );
  if (!pedido) return null;

  return (
    <div className="p-4 sm:p-6">
      <PageHeader
        title={
          <span className="flex items-center gap-2.5">
            <button className="btn-icon" onClick={() => navigate(tipo === 'venda' ? '/vendas' : '/compras')} title="Voltar">
              <ArrowLeft className="h-4 w-4" />
            </button>
            {tipo === 'venda' ? 'Pedido de venda' : 'Pedido de compra'} #{pedido.id}
            <Badge tone={STATUS_TONE[String(pedido.status)] || 'slate'}>{statusOptions.find((o) => o.value === String(pedido.status))?.label || pedido.status}</Badge>
          </span>
        }
        description={tipo === 'venda' ? 'Itens do pedido, totais, faturamento e impressão.' : 'Itens da compra, totais e recebimento de insumos.'}
        actions={
          <div className="flex flex-wrap gap-2">
            {tipo === 'venda' && (
              <button className="btn-secondary" onClick={() => imprimirPedido(tipo, pedido, itens, parceiroOpts, repOpts)}>
                <Printer className="h-4 w-4" /> Imprimir
              </button>
            )}
            {!fechado && !cancelado && (
              <button className="btn-primary" disabled={!!actionStatus} onClick={() => mudarStatus(tipo === 'venda' ? 'faturada' : 'recebido')}>
                {actionStatus ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                {tipo === 'venda' ? 'Faturar pedido' : 'Marcar como recebido'}
              </button>
            )}
            {!cancelado && (
              <button className="btn-secondary text-red-600" disabled={!!actionStatus} onClick={() => mudarStatus(tipo === 'venda' ? 'cancelada' : 'cancelado')}>
                {actionStatus === (tipo === 'venda' ? 'cancelada' : 'cancelado') ? <Loader2 className="h-4 w-4 animate-spin" /> : <X className="h-4 w-4" />}
                Cancelar
              </button>
            )}
          </div>
        }
      />

      {fechado && (
        <div className="mb-4">
          <Alert tone="green">
            {tipo === 'venda'
              ? `Pedido faturado${pedido.faturada_em ? ` em ${formatDate(pedido.faturada_em)}` : ''}: as peças já saíram do estoque${
                  pedido.comissao_valor ? ` e a comissão do representante (${formatMoney(pedido.comissao_valor)}) foi congelada` : ''
                }. Os itens não podem mais ser alterados.`
              : `Compra recebida${pedido.recebida_em ? ` em ${formatDate(pedido.recebida_em)}` : ''}: os insumos entraram no estoque e o custo médio foi atualizado. Os itens não podem mais ser alterados.`}
          </Alert>
        </div>
      )}
      {cancelado && (
        <div className="mb-4">
          <Alert tone="red">
            {tipo === 'venda' ? 'Este pedido foi cancelado' : 'Esta compra foi cancelada'}
            {fechado ? ' e os movimentos de estoque foram estornados' : ''}. Não é possível reabri-lo.
          </Alert>
        </div>
      )}

      {/* Cabeçalho do pedido */}
      <div className="card p-5">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <HeaderSelect
            label={labelParceiro}
            value={tipo === 'venda' ? pedido.cliente_id : pedido.fornecedor_id}
            options={parceiroOpts}
            disabled={fechado || cancelado || saving}
            onChange={(v) => saveHeader(tipo === 'venda' ? 'cliente_id' : 'fornecedor_id', v)}
          />
          {tipo === 'venda' && (
            <HeaderSelect
              label="Representante"
              value={pedido.representante_id}
              options={repOpts}
              disabled={fechado || cancelado || saving}
              onChange={(v) => saveHeader('representante_id', v)}
              optional
            />
          )}
          <HeaderDate
            label="Data"
            value={String(pedido.data || '').slice(0, 10)}
            disabled={fechado || cancelado || saving}
            onChange={(v) => saveHeader('data', v)}
          />
          <HeaderDate
            label="Previsão de entrega"
            value={pedido.previsao_entrega || ''}
            disabled={fechado || cancelado || saving}
            onChange={(v) => saveHeader('previsao_entrega', v || null)}
            optional
          />
          <HeaderText
            label="Condição de pagamento"
            value={pedido.condicao_pagamento || ''}
            disabled={fechado || cancelado || saving}
            onChange={(v) => saveHeader('condicao_pagamento', v || null)}
            placeholder="À vista, 30/60 dias..."
            optional
          />
          {tipo === 'venda' ? (
            <>
              <HeaderMoney label="Desconto (R$)" value={pedido.desconto ?? ''} disabled={fechado || cancelado || saving} onChange={(v) => saveHeader('desconto', v)} optional />
              <HeaderText
                label="Local de saída"
                value={pedido.local_saida || 'almoxarifado'}
                disabled={fechado || cancelado || saving}
                onChange={(v) => saveHeader('local_saida', v || 'almoxarifado')}
                placeholder="expedicao / almoxarifado"
              />
              <HeaderText label="Pedido do cliente" value={pedido.pedido_cliente || ''} disabled={fechado || cancelado || saving} onChange={(v) => saveHeader('pedido_cliente', v || null)} placeholder="Nº no cliente" optional />
            </>
          ) : (
            <>
              <HeaderText label="Nota fiscal" value={pedido.nota_fiscal || ''} disabled={fechado || cancelado || saving} onChange={(v) => saveHeader('nota_fiscal', v || null)} placeholder="Número da NF" optional />
            </>
          )}
          <HeaderMoney label="Frete (R$)" value={pedido.frete ?? ''} disabled={fechado || cancelado || saving} onChange={(v) => saveHeader('frete', v)} optional />
        </div>
        <div className="mt-4">
          <label className="label">Observações</label>
          <textarea
            className="input"
            rows={2}
            defaultValue={pedido.observacoes || ''}
            disabled={fechado || cancelado || saving}
            onBlur={(e) => {
              const v = e.target.value;
              if (v !== (pedido.observacoes || '')) saveHeader('observacoes', v || null);
            }}
          />
        </div>
      </div>

      {/* Itens */}
      <div className="card mt-4 overflow-hidden">
        <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
          <h2 className="text-sm font-bold text-navy-900">Itens do pedido ({itens.length})</h2>
        </div>
        <div className="overflow-x-auto">
          <table className="table">
            <thead>
              <tr>
                {tipo === 'venda' && <th className="w-12" />}
                <th>{labelItemRef}</th>
                {tipo === 'venda' && <th className="w-28">Tamanho</th>}
                <th className="w-24 text-right">Qtd.</th>
                <th className="w-32 text-right">Preço un.</th>
                {tipo === 'venda' && <th className="w-24 text-right">Desc. %</th>}
                <th className="w-32 text-right">Subtotal</th>
                <th className="w-16" />
              </tr>
            </thead>
            <tbody>
              {itens.map((it) => (
                <tr key={it.id}>
                  {tipo === 'venda' && (
                    <td>
                      <Thumb src={it.produto_id__foto} alt="" />
                    </td>
                  )}
                  <td className="font-medium text-slate-800">{tipo === 'venda' ? it.produto_id__label : it.insumo_id__label}</td>
                  {tipo === 'venda' && <td>{it.tamanho_id__label}</td>}
                  <td className="text-right tabular-nums">{it.quantidade}</td>
                  <td className="text-right tabular-nums">{formatMoney(it.preco_unitario)}</td>
                  {tipo === 'venda' && <td className="text-right tabular-nums">{Number(it.desconto_pct || 0) ? `${it.desconto_pct}%` : '—'}</td>}
                  <td className="text-right font-semibold tabular-nums">{formatMoney(tipo === 'venda' ? it.subtotal : Number(it.quantidade) * Number(it.preco_unitario))}</td>
                  <td className="text-right">
                    {!fechado && !cancelado && podeExcluir && (
                      <button className="btn-icon hover:!bg-red-50 hover:!text-red-600" disabled={busyItem === it.id} onClick={() => setToDelete(it)} title="Remover item">
                        <Trash2 className="h-4 w-4" />
                      </button>
                    )}
                  </td>
                </tr>
              ))}

              {!fechado && !cancelado && (
                <tr className="bg-navy-50/40">
                  {tipo === 'venda' && <td />}
                  <td>
                    <select
                      className="input"
                      value={novo.produto_id ?? (novo.insumo_id ?? '')}
                      onChange={(e) => {
                        const v = e.target.value ? Number(e.target.value) : undefined;
                        setNovo((n) => ({ ...n, [tipo === 'venda' ? 'produto_id' : 'insumo_id']: v }));
                        setTimeout(prefillPreco, 0);
                      }}
                    >
                      <option value="">Selecione {labelItemRef.toLowerCase()}...</option>
                      {(tipo === 'venda' ? produtoOpts : insumoOpts).map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                  </td>
                  {tipo === 'venda' && (
                    <td>
                      <select className="input" value={novo.tamanho_id ?? ''} onChange={(e) => setNovo((n) => ({ ...n, tamanho_id: e.target.value ? Number(e.target.value) : undefined }))}>
                        <option value="">Tam.</option>
                        {tamanhoOpts.map((o) => (
                          <option key={o.value} value={o.value}>
                            {o.label}
                          </option>
                        ))}
                      </select>
                    </td>
                  )}
                  <td>
                    <input
                      type="number"
                      min={tipo === 'venda' ? 1 : 0.001}
                      step={tipo === 'venda' ? 1 : 0.001}
                      className="input text-right"
                      value={novo.quantidade}
                      onChange={(e) => setNovo((n) => ({ ...n, quantidade: e.target.value }))}
                    />
                  </td>
                  <td>
                    <input type="number" min={0} step="0.01" className="input text-right" placeholder="0,00" value={novo.preco_unitario} onChange={(e) => setNovo((n) => ({ ...n, preco_unitario: e.target.value }))} />
                  </td>
                  {tipo === 'venda' && (
                    <td>
                      <input type="number" min={0} max={100} step="0.1" className="input text-right" value={novo.desconto_pct ?? 0} onChange={(e) => setNovo((n) => ({ ...n, desconto_pct: e.target.value }))} />
                    </td>
                  )}
                  <td className="text-right font-semibold tabular-nums">{formatMoney(subtotalNovo())}</td>
                  <td className="text-right">
                    <button className="btn-primary" disabled={busyItem === 'new'} onClick={addItem} title="Adicionar item">
                      {busyItem === 'new' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
                    </button>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {/* Totais */}
        <div className="border-t border-slate-200 px-4 py-3">
          <div className="ml-auto max-w-xs space-y-1.5 text-sm">
            <div className="flex justify-between">
              <span className="text-slate-500">Total dos itens</span>
              <span className="tabular-nums font-medium">{formatMoney(totalItens)}</span>
            </div>
            {tipo === 'venda' && Number(pedido.desconto) > 0 && (
              <div className="flex justify-between text-red-600">
                <span>Desconto</span>
                <span className="tabular-nums">− {formatMoney(pedido.desconto)}</span>
              </div>
            )}
            {Number(pedido.frete) > 0 && (
              <div className="flex justify-between">
                <span className="text-slate-500">Frete</span>
                <span className="tabular-nums">+ {formatMoney(pedido.frete)}</span>
              </div>
            )}
            <div className="flex justify-between border-t border-slate-200 pt-1.5 text-base font-bold text-navy-900">
              <span>Total</span>
              <span className="tabular-nums">{formatMoney(pedido.total)}</span>
            </div>
            {tipo === 'venda' && pedido.comissao_valor != null && Number(pedido.comissao_valor) > 0 && (
              <div className="flex justify-between text-xs text-slate-500">
                <span>Comissão representante ({Number(pedido.comissao_pct || 0).toString().replace('.', ',')}%)</span>
                <span className="tabular-nums">{formatMoney(pedido.comissao_valor)}</span>
              </div>
            )}
          </div>
        </div>
      </div>

      <ConfirmDialog
        open={!!toDelete}
        title="Remover item?"
        danger
        confirmLabel="Remover"
        busy={busyItem === toDelete?.id}
        onCancel={() => setToDelete(null)}
        onConfirm={removeItem}
        message={
          <p>
            Remover <strong>{tipo === 'venda' ? toDelete?.produto_id__label : toDelete?.insumo_id__label}</strong> do pedido? O total será recalculado.
          </p>
        }
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Campos do cabeçalho
// ---------------------------------------------------------------------------
function HeaderSelect({ label, value, options, onChange, disabled, optional }: { label: string; value: any; options: Option[]; onChange: (v: number | null) => void; disabled?: boolean; optional?: boolean }) {
  return (
    <label className="block">
      <span className="label">
        {label}
        {!optional && <span className="text-red-500"> *</span>}
      </span>
      <select className="input" value={value ?? ''} disabled={disabled} onChange={(e) => onChange(e.target.value ? Number(e.target.value) : null)}>
        <option value="">{optional ? '— nenhum —' : 'Selecione...'}</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function HeaderDate({ label, value, onChange, disabled, optional }: { label: string; value: string; onChange: (v: string) => void; disabled?: boolean; optional?: boolean }) {
  return (
    <label className="block">
      <span className="label">
        {label}
        {!optional && <span className="text-red-500"> *</span>}
      </span>
      <input type="date" className="input" value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}

function HeaderText({ label, value, onChange, disabled, placeholder, optional }: { label: string; value: string; onChange: (v: string) => void; disabled?: boolean; placeholder?: string; optional?: boolean }) {
  return (
    <label className="block">
      <span className="label">{label}</span>
      <input type="text" className="input" defaultValue={value} placeholder={placeholder} disabled={disabled} onBlur={(e) => onChange(e.target.value)} />
    </label>
  );
}

function HeaderMoney({ label, value, onChange, disabled, optional }: { label: string; value: any; onChange: (v: number) => void; disabled?: boolean; optional?: boolean }) {
  return (
    <label className="block">
      <span className="label">
        {label}
        {!optional && <span className="text-red-500"> *</span>}
      </span>
      <input
        type="number"
        min={0}
        step="0.01"
        className="input"
        defaultValue={value ?? 0}
        disabled={disabled}
        onBlur={(e) => onChange(Math.max(0, Number(e.target.value.replace(',', '.')) || 0))}
      />
    </label>
  );
}

// ---------------------------------------------------------------------------
// Impressão do pedido (HTML em nova janela — mesma técnica das etiquetas)
// ---------------------------------------------------------------------------
function esc(s: unknown): string {
  return String(s ?? '').replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]!);
}

function imprimirPedido(tipo: Tipo, pedido: Record<string, any>, itens: Item[], parceiros: Option[], reps: Option[]) {
  const nomeParceiro = parceiros.find((o) => o.value === Number(tipo === 'venda' ? pedido.cliente_id : pedido.fornecedor_id))?.label || '—';
  const nomeRep = reps.find((o) => o.value === Number(pedido.representante_id))?.label;
  const statusLabel = tipo === 'venda' ? { aberta: 'Aberta', faturada: 'Faturada', entregue: 'Entregue', cancelada: 'Cancelada' }[String(pedido.status)] : { pendente: 'Pendente', recebido: 'Recebido', cancelado: 'Cancelado' }[String(pedido.status)];

  // Grade: agrupa itens por produto/cor (venda); compra usa tabela simples.
  const linhas =
    tipo === 'venda'
      ? [...itens]
          .sort((a, b) => String(a.produto_id__label).localeCompare(String(b.produto_id__label)) || String(a.tamanho_id__label).localeCompare(String(b.tamanho_id__label)))
          .map((it) => ({
            produto: it.produto_id__label || `#${it.produto_id}`,
            tamanho: it.tamanho_id__label || '',
            qtd: Number(it.quantidade),
            preco: Number(it.preco_unitario),
            desc: Number(it.desconto_pct || 0),
            subtotal: Number(it.subtotal || 0),
          }))
      : itens.map((it) => ({ insumo: it.insumo_id__label || `#${it.insumo_id}`, qtd: Number(it.quantidade), preco: Number(it.preco_unitario), subtotal: Number(it.quantidade) * Number(it.preco_unitario) }));

  const totalItens = linhas.reduce((s, l: any) => s + l.subtotal, 0);

  const corpoVenda = `
    <table>
      <thead><tr><th>Produto</th><th>Tam.</th><th class="r">Qtd.</th><th class="r">Preço</th><th class="r">Desc.</th><th class="r">Subtotal</th></tr></thead>
      <tbody>
        ${(linhas as any[])
          .map(
            (l) => `<tr><td>${esc(l.produto)}</td><td>${esc(l.tamanho)}</td><td class="r">${l.qtd}</td><td class="r">${formatMoney(l.preco)}</td><td class="r">${l.desc ? l.desc + '%' : ''}</td><td class="r">${formatMoney(l.subtotal)}</td></tr>`
          )
          .join('')}
      </tbody>
    </table>`;
  const corpoCompra = `
    <table>
      <thead><tr><th>Insumo</th><th class="r">Qtd.</th><th class="r">Preço un.</th><th class="r">Subtotal</th></tr></thead>
      <tbody>
        ${(linhas as any[]).map((l) => `<tr><td>${esc(l.insumo)}</td><td class="r">${l.qtd}</td><td class="r">${formatMoney(l.preco)}</td><td class="r">${formatMoney(l.subtotal)}</td></tr>`).join('')}
      </tbody>
    </table>`;

  const html = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>${tipo === 'venda' ? 'Pedido de venda' : 'Pedido de compra'} #${pedido.id}</title>
  <style>
    @page{size:A4;margin:15mm}
    body{margin:0;font-family:Arial,Helvetica,sans-serif;color:#000;font-size:10pt}
    .top{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:2px solid #1f3a5f;padding-bottom:8px;margin-bottom:12px}
    .brand{font-size:18pt;font-weight:800;letter-spacing:2px;color:#1f3a5f}
    .tag{font-size:8pt;color:#555;letter-spacing:1px}
    .doc{text-align:right;font-size:9pt}
    .doc h1{font-size:14pt;margin:0 0 4px}
    .dados{display:grid;grid-template-columns:1fr 1fr;gap:4px 20px;margin-bottom:12px;font-size:9pt}
    .dados b{color:#1f3a5f}
    table{width:100%;border-collapse:collapse;margin-top:8px}
    th,td{border:0.3mm solid #999;padding:4px 6px;text-align:left;font-size:9pt}
    th{background:#eef2f7}
    .r{text-align:right}
    .totais{margin-left:auto;width:260px;margin-top:10px;font-size:9pt}
    .totais div{display:flex;justify-content:space-between;padding:2px 0}
    .totais .grand{border-top:1px solid #000;font-weight:800;font-size:11pt;padding-top:4px}
    .obs{margin-top:14px;font-size:8.5pt;color:#333;white-space:pre-wrap}
    .foot{margin-top:24px;text-align:center;color:#777;font-size:7.5pt}
  </style></head>
  <body>
    <div class="top">
      <div><div class="brand">BROBOND</div><div class="tag">CONFECÇÃO MASCULINA</div></div>
      <div class="doc">
        <h1>${tipo === 'venda' ? 'PEDIDO DE VENDA' : 'PEDIDO DE COMPRA'} Nº ${pedido.id}</h1>
        <div>Status: <b>${esc(statusLabel)}</b></div>
        <div>Data: ${formatDate(pedido.data)}</div>
      </div>
    </div>
    <div class="dados">
      <div><b>${tipo === 'venda' ? 'Cliente' : 'Fornecedor'}:</b> ${esc(nomeParceiro)}</div>
      <div><b>Previsão de entrega:</b> ${pedido.previsao_entrega ? formatDate(pedido.previsao_entrega) : '—'}</div>
      ${tipo === 'venda' ? `<div><b>Representante:</b> ${esc(nomeRep || '—')}</div><div><b>Pedido do cliente:</b> ${esc(pedido.pedido_cliente || '—')}</div>` : `<div><b>Nota fiscal:</b> ${esc(pedido.nota_fiscal || '—')}</div><div></div>`}
      <div><b>Condição de pagamento:</b> ${esc(pedido.condicao_pagamento || '—')}</div>
      <div><b>Frete:</b> ${formatMoney(pedido.frete || 0)}</div>
    </div>
    ${tipo === 'venda' ? corpoVenda : corpoCompra}
    <div class="totais">
      <div><span>Total dos itens</span><span>${formatMoney(totalItens)}</span></div>
      ${tipo === 'venda' && Number(pedido.desconto) > 0 ? `<div><span>Desconto</span><span>− ${formatMoney(pedido.desconto)}</span></div>` : ''}
      ${Number(pedido.frete) > 0 ? `<div><span>Frete</span><span>+ ${formatMoney(pedido.frete)}</span></div>` : ''}
      <div class="grand"><span>TOTAL</span><span>${formatMoney(pedido.total)}</span></div>
    </div>
    ${pedido.observacoes ? `<div class="obs"><b>Observações:</b><br>${esc(pedido.observacoes)}</div>` : ''}
    <div class="foot">Documento gerado pelo BROBOND ERP em ${formatDate(new Date().toISOString())}</div>
    <script>window.onload=function(){setTimeout(function(){window.print()},200)}</script>
  </body></html>`;

  const w = window.open('', '_blank', 'width=900,height=700');
  if (!w) return alert('O navegador bloqueou a janela de impressão. Permita pop-ups para este site.');
  w.document.open();
  w.document.write(html);
  w.document.close();
}
