// ============================================================================
// SUPPLY CHAIN — DEVOLUÇÕES AO FORNECEDOR (módulo /devolucoes-fornecedor)
//
// Documento com estados SOLICITADA → AUTORIZADA → EXPEDIDA → ENCERRADA (ou
// CANCELADA antes de expedir). Operação inversa do recebimento de compra.
//
// REGRA DE OURO na tela: só se devolve o que foi RECEBIDO. O saldo do estoque
// só baixa na EXPEDIÇÃO — esta página nunca calcula saldo, só dispara os
// endpoints oficiais.
//
// ZERO MODAL: a criação é um formulário INLINE; as ações de estado são botões na
// linha da lista; o cancelamento usa confirmação inline.
// ============================================================================
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Loader2, PackageOpen, Plus, RefreshCw, X } from 'lucide-react';
import { api, ApiError } from '../lib/api';
import { useMeta, type ListResult, type Option } from '../lib/meta';
import { Alert, Badge, ConfirmacaoInline, EmptyState, PageHeader, Spinner, useToast } from '../components/ui';
import { formatDateTime, formatMoney, formatNumber } from '../lib/format';

type Status = 'solicitada' | 'autorizada' | 'expedida' | 'encerrada' | 'cancelada';

type Devolucao = {
  id: number;
  numero: string | null;
  compra_id: number;
  fornecedor_id: number;
  status: Status;
  motivo: string;
  local_origem_id: number | null;
  expedida_em: string | null;
  solicitada_em: string | null;
};

type ItemCompra = {
  id: number;
  insumo_id: number | null;
  produto_id: number | null;
  tamanho_id: number | null;
  quantidade: number;
  quantidade_recebida: number;
};

type ItemDevolucao = { item_compra_id: number; quantidade: number; produto_id: number | null; insumo_id: number | null; custo_unitario: number };
type Detalhe = Devolucao & { itens: ItemDevolucao[]; resumo: { itens: number; total: number } };

type LinhaForm = { item_compra_id: string; quantidade: string };

const TOM_STATUS: Record<Status, 'amber' | 'blue' | 'green' | 'red'> = {
  solicitada: 'amber',
  autorizada: 'blue',
  expedida: 'blue',
  encerrada: 'green',
  cancelada: 'red',
};

const PROXIMO: Record<string, string | null> = {
  solicitada: 'autorizar',
  autorizada: 'expedir',
  expedida: 'encerrar',
};

const ROTULO_ACAO: Record<string, string> = {
  autorizar: 'Autorizar',
  expedir: 'Expedir',
  encerrar: 'Encerrar',
};

export default function DevolucoesFornecedorPage() {
  const meta = useMeta();
  const toast = useToast();

  const [dados, setDados] = useState<ListResult<Devolucao> | null>(null);
  const [erro, setErro] = useState('');
  const [carregando, setCarregando] = useState(true);
  const [ocupado, setOcupado] = useState<number | null>(null);
  const [detalhe, setDetalhe] = useState<Detalhe | null>(null);
  const [acao, setAcao] = useState<{ id: number } | null>(null);
  const [cancelarMotivo, setCancelarMotivo] = useState('');

  const [formAberto, setFormAberto] = useState(false);
  const [compraId, setCompraId] = useState('');
  const [motivo, setMotivo] = useState('');
  const [localOrigem, setLocalOrigem] = useState('');
  const [linhas, setLinhas] = useState<LinhaForm[]>([{ item_compra_id: '', quantidade: '' }]);
  const [itensCompra, setItensCompra] = useState<ItemCompra[]>([]);
  const [carregandoItens, setCarregandoItens] = useState(false);
  const [salvando, setSalvando] = useState(false);
  const [formErro, setFormErro] = useState('');

  const locais = useOptions('locais');
  const nomeLocal = useMemo(() => new Map(locais.map((l) => [l.value, l.label])), [locais]);

  const carregar = useCallback(async () => {
    setCarregando(true);
    setErro('');
    try {
      const lista = await api.get<ListResult<Devolucao>>('/devolucoes_fornecedor?page=1&pageSize=50');
      setDados(lista);
    } catch (e) {
      setErro(e instanceof ApiError ? e.message : 'Não foi possível carregar as devoluções.');
    } finally {
      setCarregando(false);
    }
  }, []);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  // Ao escolher o pedido de compra, busca os itens com o RECEBIDO de cada um —
  // é sobre o recebido que a devolução é limitada (nunca sobre o pedido).
  useEffect(() => {
    if (!compraId) {
      setItensCompra([]);
      return;
    }
    let vivo = true;
    setCarregandoItens(true);
    api
      .get<ItemCompra[]>(`/compras/${compraId}/itens`)
      .then((rows) => vivo && setItensCompra(Array.isArray(rows) ? rows : []))
      .catch(() => vivo && setItensCompra([]))
      .finally(() => vivo && setCarregandoItens(false));
    return () => {
      vivo = false;
    };
  }, [compraId]);

  async function abrirDetalhe(d: Devolucao) {
    setOcupado(d.id);
    try {
      const completo = await api.get<Detalhe>(`/devolucoes-fornecedor/${d.id}`);
      setDetalhe(completo);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Não foi possível abrir o documento.');
    } finally {
      setOcupado(null);
    }
  }

  async function acaoDeEstado(d: Devolucao) {
    const proximo = PROXIMO[d.status];
    if (!proximo) return;
    setOcupado(d.id);
    try {
      await api.post(`/devolucoes-fornecedor/${d.id}/${proximo}`, {});
      toast.success(
        proximo === 'autorizar'
          ? 'Devolução autorizada.'
          : proximo === 'expedir'
            ? 'Devolução expedida — saída de estoque lançada.'
            : 'Devolução encerrada.'
      );
      await carregar();
      if (detalhe?.id === d.id) await abrirDetalhe(d);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Não foi possível mudar o estado.');
    } finally {
      setOcupado(null);
    }
  }

  async function confirmarCancelamento() {
    if (!acao) return;
    if (!cancelarMotivo.trim()) {
      toast.error('Informe o motivo do cancelamento.');
      return;
    }
    setOcupado(acao.id);
    try {
      await api.post(`/devolucoes-fornecedor/${acao.id}/cancelar`, { motivo: cancelarMotivo.trim() });
      toast.success('Devolução cancelada.');
      setAcao(null);
      setCancelarMotivo('');
      await carregar();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Não foi possível cancelar.');
    } finally {
      setOcupado(null);
    }
  }

  function limparForm() {
    setCompraId('');
    setMotivo('');
    setLocalOrigem('');
    setLinhas([{ item_compra_id: '', quantidade: '' }]);
    setItensCompra([]);
    setFormErro('');
  }

  async function solicitar() {
    setFormErro('');
    if (!compraId) {
      setFormErro('Escolha o pedido de compra de origem.');
      return;
    }
    if (!motivo.trim()) {
      setFormErro('Descreva o motivo da devolução.');
      return;
    }
    const validas = linhas.filter((l) => l.item_compra_id && Number(l.quantidade) > 0);
    if (!validas.length) {
      setFormErro('Inclua ao menos um item com quantidade maior que zero.');
      return;
    }
    setSalvando(true);
    try {
      await api.post(`/compras/${compraId}/devolucoes`, {
        motivo: motivo.trim(),
        local_origem_id: localOrigem ? Number(localOrigem) : null,
        itens: validas.map((l) => ({ item_compra_id: Number(l.item_compra_id), quantidade: Number(l.quantidade) })),
      });
      toast.success('Devolução solicitada — aguardando autorização.');
      limparForm();
      setFormAberto(false);
      await carregar();
    } catch (e) {
      setFormErro(e instanceof ApiError ? e.message : 'Não foi possível solicitar a devolução.');
    } finally {
      setSalvando(false);
    }
  }

  const fornecedorNome = (d: Devolucao) => `Fornecedor #${d.fornecedor_id}`;

  return (
    <div className="p-4 sm:p-6">
      <PageHeader
        title="Devoluções ao fornecedor"
        description="Devolva mercadoria recebida (avaria, divergência, compra errada). Só se devolve o que foi recebido; o estoque só baixa na expedição."
        actions={
          <>
            <button className="btn-secondary" onClick={() => void carregar()} disabled={carregando}>
              <RefreshCw className={`h-4 w-4 ${carregando ? 'animate-spin' : ''}`} /> Atualizar
            </button>
            <button className="btn-accent" onClick={() => (formAberto ? (setFormAberto(false), limparForm()) : setFormAberto(true))}>
              {formAberto ? <X className="h-4 w-4" /> : <Plus className="h-4 w-4" />}
              {formAberto ? 'Fechar formulário' : 'Nova devolução'}
            </button>
          </>
        }
      />

      {erro && <Alert tone="red">{erro}</Alert>}

      {formAberto && (
        <section className="card mb-4 p-4" aria-label="Solicitar devolução ao fornecedor">
          <h2 className="mb-3 flex items-center gap-2 text-sm font-bold text-navy-900 dark:text-white">
            <PackageOpen className="h-4 w-4" /> Solicitar devolução ao fornecedor
          </h2>
          {formErro && (
            <div className="mb-3">
              <Alert tone="red">{formErro}</Alert>
            </div>
          )}
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="text-xs font-medium text-slate-500">
              Pedido de compra *
              <input
                className="input mt-1"
                inputMode="numeric"
                placeholder="Nº do pedido"
                value={compraId}
                onChange={(e) => setCompraId(e.target.value.replace(/\D/g, ''))}
              />
            </label>
            <label className="text-xs font-medium text-slate-500">
              Local de origem
              <select className="input mt-1" value={localOrigem} onChange={(e) => setLocalOrigem(e.target.value)}>
                <option value="">Local padrão</option>
                {locais.map((l) => (
                  <option key={l.value} value={l.value}>
                    {l.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <label className="mt-3 block text-xs font-medium text-slate-500">
            Motivo *
            <input className="input mt-1" value={motivo} onChange={(e) => setMotivo(e.target.value)} placeholder="Ex.: peças avariadas no transporte" />
          </label>

          <div className="mt-4">
            <p className="mb-2 text-xs font-medium text-slate-500">Itens (só o que foi recebido)</p>
            {carregandoItens ? (
              <Spinner label="Carregando itens do pedido..." />
            ) : compraId && itensCompra.length === 0 ? (
              <Alert tone="amber">O pedido informado não tem itens recebidos ou não foi encontrado nesta empresa.</Alert>
            ) : (
              <div className="space-y-2">
                {linhas.map((linha, idx) => {
                  const disponiveis = itensCompra.filter((it) => Number(it.quantidade_recebida) > 0);
                  const selecionado = itensCompra.find((it) => String(it.id) === linha.item_compra_id);
                  return (
                    <div key={idx} className="grid gap-2 sm:grid-cols-[3fr_1fr_auto]">
                      <select
                        className="input"
                        aria-label={`Item ${idx + 1}`}
                        value={linha.item_compra_id}
                        onChange={(e) => setLinhas((l) => l.map((x, i) => (i === idx ? { ...x, item_compra_id: e.target.value } : x)))}
                      >
                        <option value="">Item da compra</option>
                        {disponiveis.map((it) => (
                          <option key={it.id} value={it.id}>
                            #{it.id} — recebido {formatNumber(it.quantidade_recebida)}
                          </option>
                        ))}
                      </select>
                      <input
                        className="input"
                        inputMode="numeric"
                        placeholder="Qtd."
                        aria-label={`Quantidade do item ${idx + 1}`}
                        value={linha.quantidade}
                        onChange={(e) => setLinhas((l) => l.map((x, i) => (i === idx ? { ...x, quantidade: e.target.value } : x)))}
                      />
                      <button
                        type="button"
                        className="btn-secondary !px-2"
                        aria-label={`Remover item ${idx + 1}`}
                        onClick={() => setLinhas((l) => (l.length === 1 ? l : l.filter((_, i) => i !== idx)))}
                        disabled={linhas.length === 1}
                      >
                        <X className="h-4 w-4" />
                      </button>
                      {selecionado && (
                        <p className="sm:col-span-3 text-xs text-slate-400">
                          Máximo devolvível do item #{selecionado.id}: {formatNumber(selecionado.quantidade_recebida)}.
                        </p>
                      )}
                    </div>
                  );
                })}
                <button type="button" className="btn-secondary" onClick={() => setLinhas((l) => [...l, { item_compra_id: '', quantidade: '' }])}>
                  <Plus className="h-4 w-4" /> Adicionar item
                </button>
              </div>
            )}
          </div>

          <div className="mt-4 flex flex-wrap justify-end gap-2">
            <button className="btn-secondary" type="button" onClick={() => (setFormAberto(false), limparForm())} disabled={salvando}>
              Cancelar
            </button>
            <button className="btn-accent" type="button" onClick={() => void solicitar()} disabled={salvando}>
              {salvando ? <Loader2 className="h-4 w-4 animate-spin" /> : <PackageOpen className="h-4 w-4" />} Solicitar
            </button>
          </div>
        </section>
      )}

      {carregando && !dados ? (
        <Spinner label="Carregando devoluções..." />
      ) : !dados || dados.rows.length === 0 ? (
        <EmptyState
          title="Nenhuma devolução ao fornecedor"
          description="Devolva mercadoria recebida ao fornecedor. O estoque só baixa quando a devolução é expedida."
          action={
            <button className="btn-accent" onClick={() => setFormAberto(true)}>
              <Plus className="h-4 w-4" /> Nova devolução
            </button>
          }
        />
      ) : (
        <section className="card overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-400 dark:border-navy-800">
                <th className="px-4 py-2">#</th>
                <th className="px-4 py-2">Compra / Fornecedor</th>
                <th className="px-4 py-2">Status</th>
                <th className="px-4 py-2">Solicitada</th>
                <th className="px-4 py-2 text-right">Ações</th>
              </tr>
            </thead>
            <tbody>
              {dados.rows.map((d) => (
                <tr key={d.id} className="border-b border-slate-100 last:border-0 dark:border-navy-800">
                  <td className="px-4 py-2 tabular-nums text-slate-400">{d.numero ?? d.id}</td>
                  <td className="px-4 py-2">
                    <button className="text-left underline-offset-2 hover:underline" onClick={() => void abrirDetalhe(d)}>
                      Compra #{d.compra_id} · {fornecedorNome(d)}
                    </button>
                  </td>
                  <td className="px-4 py-2">
                    <Badge tone={TOM_STATUS[d.status]}>{d.status}</Badge>
                  </td>
                  <td className="px-4 py-2 text-xs text-slate-500">{formatDateTime(d.solicitada_em)}</td>
                  <td className="px-4 py-2">
                    <div className="flex flex-wrap items-center justify-end gap-1.5">
                      {PROXIMO[d.status] && (
                        <button className="btn-secondary !px-2.5 !py-1.5 text-xs" onClick={() => void acaoDeEstado(d)} disabled={ocupado === d.id}>
                          {ocupado === d.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                          {ROTULO_ACAO[PROXIMO[d.status]!]}
                        </button>
                      )}
                      {(d.status === 'solicitada' || d.status === 'autorizada') && (
                        <button className="btn-secondary !px-2.5 !py-1.5 text-xs !text-red-600" onClick={() => setAcao({ id: d.id })}>
                          Cancelar
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {detalhe && (
        <section className="mt-6 card p-4" aria-label="Detalhe da devolução">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="flex items-center gap-2 text-sm font-bold text-navy-900 dark:text-white">
              <PackageOpen className="h-4 w-4" /> Devolução #{detalhe.numero ?? detalhe.id}
            </h2>
            <button className="btn-secondary !px-2.5 !py-1.5 text-xs" onClick={() => setDetalhe(null)}>
              <X className="h-4 w-4" /> Fechar
            </button>
          </div>
          <dl className="grid gap-2 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-xs text-slate-400">Status</dt>
              <dd>
                <Badge tone={TOM_STATUS[detalhe.status]}>{detalhe.status}</Badge>
              </dd>
            </div>
            <div>
              <dt className="text-xs text-slate-400">Motivo</dt>
              <dd className="text-navy-900 dark:text-white">{detalhe.motivo}</dd>
            </div>
            <div>
              <dt className="text-xs text-slate-400">Local de origem</dt>
              <dd className="text-navy-900 dark:text-white">{detalhe.local_origem_id ? nomeLocal.get(detalhe.local_origem_id) ?? `#${detalhe.local_origem_id}` : 'Local padrão'}</dd>
            </div>
            <div>
              <dt className="text-xs text-slate-400">Total estimado</dt>
              <dd className="text-navy-900 dark:text-white">{formatMoney(detalhe.resumo.total)}</dd>
            </div>
          </dl>
          <table className="mt-4 w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-400 dark:border-navy-800">
                <th className="px-3 py-2">Item da compra</th>
                <th className="px-3 py-2 text-right">Quantidade</th>
                <th className="px-3 py-2 text-right">Custo unit.</th>
              </tr>
            </thead>
            <tbody>
              {detalhe.itens.map((it) => (
                <tr key={it.item_compra_id} className="border-b border-slate-100 last:border-0 dark:border-navy-800">
                  <td className="px-3 py-2">#{it.item_compra_id}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{formatNumber(it.quantidade)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{formatMoney(it.custo_unitario)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      <ConfirmacaoInline
        open={!!acao}
        title="Cancelar devolução?"
        danger
        confirmLabel="Cancelar devolução"
        cancelLabel="Voltar"
        busy={ocupado === acao?.id}
        onConfirm={() => void confirmarCancelamento()}
        onCancel={() => {
          if (ocupado) return;
          setAcao(null);
          setCancelarMotivo('');
        }}
        message={
          <div>
            <p>O documento fica CANCELADO e permanece no histórico. Só é possível cancelar antes da expedição — depois da baixa, é preciso estornar a movimentação.</p>
            <label className="mt-2 block text-xs font-medium text-slate-500">
              Motivo *
              <input className="input mt-1" value={cancelarMotivo} onChange={(e) => setCancelarMotivo(e.target.value)} />
            </label>
          </div>
        }
      />

      <p className="mt-4 text-xs text-slate-400">
        A devolução não movimenta estoque até ser expedida. Só se devolve a quantidade efetivamente recebida da compra.
        {meta?.mode === 'memory' ? ' (modo demonstração)' : ''}
      </p>
    </div>
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
