// ============================================================================
// ESTOQUE — TRANSFERÊNCIAS ENTRE LOCAIS E RESERVAS (módulo /estoque/transferencias)
//
// Uma página, dois assuntos do MESMO domínio de estoque:
//   1) TRANSFERÊNCIA FORMAL — documento com estados SOLICITADA → APROVADA →
//      EM_TRANSITO → RECEBIDA (ou CANCELADA antes da expedição). O saldo só
//      muda na expedição (saída na origem) e no recebimento (entrada no
//      destino), pelos endpoints oficiais — esta tela não calcula saldo.
//   2) RESERVA / EMPENHO / BLOQUEIO — comprometimento com checagem de
//      disponível (físico − reservado − bloqueado − empenhado).
//
// ZERO MODAL: a criação é um formulário INLINE no topo da própria página e as
// ações de estado são botões na linha da lista. Nada sobrepõe a tela.
// ============================================================================
import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, ArrowRight, ArrowRightLeft, Loader2, Plus, RefreshCw, X } from 'lucide-react';
import { api, ApiError } from '../lib/api';
import { useMeta, type ListResult, type Option } from '../lib/meta';
import { Alert, Badge, ConfirmacaoInline, EmptyState, PageHeader, Spinner, useToast } from '../components/ui';
import { formatDateTime } from '../lib/format';

type Status = 'solicitada' | 'aprovada' | 'em_transito' | 'recebida' | 'cancelada';

type Transferencia = {
  id: number;
  empresa_id: number;
  origem_local_id: number;
  destino_local_id: number;
  status: Status;
  solicitante_id: number | null;
  solicitada_em: string | null;
  recebida_em: string | null;
  observacoes: string | null;
};

type Reserva = {
  id: number;
  produto_id: number;
  tamanho_id: number | null;
  local_id: number | null;
  tipo: 'reserva' | 'empenho' | 'bloqueio';
  quantidade: number;
  status: string;
  motivo: string | null;
};

type Item = { produto_id: string; tamanho_id: string; quantidade: string };

const TOM_STATUS: Record<Status, 'amber' | 'blue' | 'green' | 'red' | 'slate'> = {
  solicitada: 'amber',
  aprovada: 'blue',
  em_transito: 'blue',
  recebida: 'green',
  cancelada: 'red',
};

const PROXIMO: Record<string, string | null> = {
  solicitada: 'aprovar',
  aprovada: 'expedir',
  em_transito: 'receber',
};

export default function EstoqueTransferenciasPage() {
  const meta = useMeta();
  const toast = useToast();

  const [dados, setDados] = useState<ListResult<Transferencia> | null>(null);
  const [reservas, setReservas] = useState<Reserva[]>([]);
  const [disponibilidade, setDisponibilidade] = useState<{ linhas: any[]; totais: any } | null>(null);
  const [erro, setErro] = useState('');
  const [carregando, setCarregando] = useState(true);
  const [acao, setAcao] = useState<{ tipo: 'cancelar'; id: number } | null>(null);
  const [cancelarMotivo, setCancelarMotivo] = useState('');
  const [ocupado, setOcupado] = useState<number | null>(null);

  const [formAberto, setFormAberto] = useState(false);
  const [origem, setOrigem] = useState('');
  const [destino, setDestino] = useState('');
  const [itens, setItens] = useState<Item[]>([{ produto_id: '', tamanho_id: '', quantidade: '' }]);
  const [salvando, setSalvando] = useState(false);
  const [formErro, setFormErro] = useState('');

  const locais = useOptions('locais');
  const produtos = useOptions('produtos');
  const tamanhos = useOptions('tamanhos');

  const nomeLocal = useMemo(() => new Map(locais.map((l) => [l.value, l.label])), [locais]);
  const nomeProduto = useMemo(() => new Map(produtos.map((p) => [p.value, p.label])), [produtos]);

  const carregar = useCallback(async () => {
    setCarregando(true);
    setErro('');
    try {
      const [lista, res, disp] = await Promise.all([
        api.get<ListResult<Transferencia>>('/estoque_transferencias?page=1&pageSize=50'),
        api.get<ListResult<Reserva>>('/estoque_reservas?page=1&pageSize=50&f.status=ativa').catch(() => ({ rows: [], total: 0, page: 1, pageSize: 50 }) as ListResult<Reserva>),
        api.get<{ linhas: any[]; totais: any }>('/estoque/disponibilidade').catch(() => null),
      ]);
      setDados(lista);
      setReservas(res.rows);
      setDisponibilidade(disp);
    } catch (e) {
      setErro(e instanceof ApiError ? e.message : 'Não foi possível carregar as transferências.');
    } finally {
      setCarregando(false);
    }
  }, []);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  async function acaoDeEstado(t: Transferencia) {
    const proximo = PROXIMO[t.status];
    if (!proximo) return;
    setOcupado(t.id);
    try {
      await api.post(`/estoque/transferencias/${t.id}/${proximo}`, {});
      toast.success(
        proximo === 'aprovar'
          ? 'Transferência aprovada.'
          : proximo === 'expedir'
            ? 'Transferência expedida — saída lançada na origem.'
            : 'Transferência recebida — entrada lançada no destino.'
      );
      await carregar();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Não foi possível mudar o estado da transferência.');
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
      await api.post(`/estoque/transferencias/${acao.id}/cancelar`, { motivo: cancelarMotivo.trim() });
      toast.success('Transferência cancelada.');
      setAcao(null);
      setCancelarMotivo('');
      await carregar();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Não foi possível cancelar.');
    } finally {
      setOcupado(null);
    }
  }

  async function liberar(r: Reserva) {
    setOcupado(r.id);
    try {
      await api.post(`/estoque/reservas/${r.id}/liberar`, {});
      toast.success('Reserva liberada — a quantidade voltou ao disponível.');
      await carregar();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Não foi possível liberar a reserva.');
    } finally {
      setOcupado(null);
    }
  }

  function limparForm() {
    setOrigem('');
    setDestino('');
    setItens([{ produto_id: '', tamanho_id: '', quantidade: '' }]);
    setFormErro('');
  }

  async function solicitar() {
    setFormErro('');
    if (!origem || !destino) {
      setFormErro('Escolha o local de origem e o de destino.');
      return;
    }
    if (origem === destino) {
      setFormErro('Origem e destino precisam ser locais diferentes.');
      return;
    }
    const validos = itens.filter((i) => i.produto_id && Number(i.quantidade) > 0);
    if (!validos.length) {
      setFormErro('Inclua ao menos um item com produto e quantidade maior que zero.');
      return;
    }
    setSalvando(true);
    try {
      await api.post('/estoque/transferencias', {
        origem_local_id: Number(origem),
        destino_local_id: Number(destino),
        itens: validos.map((i) => ({
          produto_id: Number(i.produto_id),
          tamanho_id: i.tamanho_id ? Number(i.tamanho_id) : null,
          quantidade: Number(i.quantidade),
        })),
      });
      toast.success('Transferência solicitada — aguardando aprovação.');
      limparForm();
      setFormAberto(false);
      await carregar();
    } catch (e) {
      setFormErro(e instanceof ApiError ? e.message : 'Não foi possível solicitar a transferência.');
    } finally {
      setSalvando(false);
    }
  }

  return (
    <div className="p-4 sm:p-6">
      <PageHeader
        title="Transferências entre locais"
        description="Documento com aprovação e trânsito. O saldo só muda na expedição (saída na origem) e no recebimento (entrada no destino)."
        actions={
          <>
            <button className="btn-secondary" onClick={() => void carregar()} disabled={carregando}>
              <RefreshCw className={`h-4 w-4 ${carregando ? 'animate-spin' : ''}`} /> Atualizar
            </button>
            <button className="btn-accent" onClick={() => (formAberto ? (setFormAberto(false), limparForm()) : setFormAberto(true))}>
              {formAberto ? <X className="h-4 w-4" /> : <Plus className="h-4 w-4" />}
              {formAberto ? 'Fechar formulário' : 'Nova transferência'}
            </button>
          </>
        }
      />

      {erro && <Alert tone="red">{erro}</Alert>}

      {disponibilidade && (
        <div className="mb-4">
          <Alert tone="blue">
            Regra de disponibilidade: <strong>disponível = físico − reservado − bloqueado − empenhado</strong>. Hoje:{' '}
            físico {disponibilidade.totais.fisico} · reservado {disponibilidade.totais.reservado} · bloqueado {disponibilidade.totais.bloqueado} · empenhado{' '}
            {disponibilidade.totais.empenhado} · em trânsito {disponibilidade.totais.em_transito} · <strong>disponível {disponibilidade.totais.disponivel}</strong>.
          </Alert>
        </div>
      )}

      {formAberto && (
        // Formulário INLINE: criação do documento na própria página.
        <section className="card mb-4 p-4" aria-label="Solicitar transferência">
          <h2 className="mb-3 flex items-center gap-2 text-sm font-bold text-navy-900 dark:text-white">
            <ArrowRightLeft className="h-4 w-4" /> Solicitar transferência
          </h2>
          {formErro && (
            <div className="mb-3">
              <Alert tone="red">{formErro}</Alert>
            </div>
          )}
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="text-xs font-medium text-slate-500">
              Local de origem *
              <select className="input mt-1" value={origem} onChange={(e) => setOrigem(e.target.value)}>
                <option value="">Selecione</option>
                {locais.map((l) => (
                  <option key={l.value} value={l.value}>
                    {l.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-xs font-medium text-slate-500">
              Local de destino *
              <select className="input mt-1" value={destino} onChange={(e) => setDestino(e.target.value)}>
                <option value="">Selecione</option>
                {locais.map((l) => (
                  <option key={l.value} value={l.value}>
                    {l.label}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="mt-3 space-y-2">
            {itens.map((item, idx) => (
              <div key={idx} className="grid gap-2 sm:grid-cols-[2fr_1fr_1fr_auto]">
                <select
                  className="input"
                  aria-label={`Produto do item ${idx + 1}`}
                  value={item.produto_id}
                  onChange={(e) => setItens((l) => l.map((x, i) => (i === idx ? { ...x, produto_id: e.target.value } : x)))}
                >
                  <option value="">Produto</option>
                  {produtos.map((p) => (
                    <option key={p.value} value={p.value}>
                      {p.label}
                    </option>
                  ))}
                </select>
                <select
                  className="input"
                  aria-label={`Tamanho do item ${idx + 1}`}
                  value={item.tamanho_id}
                  onChange={(e) => setItens((l) => l.map((x, i) => (i === idx ? { ...x, tamanho_id: e.target.value } : x)))}
                >
                  <option value="">Sem tamanho</option>
                  {tamanhos.map((t) => (
                    <option key={t.value} value={t.value}>
                      {t.label}
                    </option>
                  ))}
                </select>
                <input
                  className="input"
                  inputMode="numeric"
                  placeholder="Qtd."
                  aria-label={`Quantidade do item ${idx + 1}`}
                  value={item.quantidade}
                  onChange={(e) => setItens((l) => l.map((x, i) => (i === idx ? { ...x, quantidade: e.target.value } : x)))}
                />
                <button
                  type="button"
                  className="btn-secondary !px-2"
                  aria-label={`Remover item ${idx + 1}`}
                  onClick={() => setItens((l) => (l.length === 1 ? l : l.filter((_, i) => i !== idx)))}
                  disabled={itens.length === 1}
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            ))}
            <button type="button" className="btn-secondary" onClick={() => setItens((l) => [...l, { produto_id: '', tamanho_id: '', quantidade: '' }])}>
              <Plus className="h-4 w-4" /> Adicionar item
            </button>
          </div>

          <div className="mt-4 flex flex-wrap justify-end gap-2">
            <button
              className="btn-secondary"
              type="button"
              onClick={() => {
                setFormAberto(false);
                limparForm();
              }}
              disabled={salvando}
            >
              Cancelar
            </button>
            <button className="btn-accent" type="button" onClick={() => void solicitar()} disabled={salvando}>
              {salvando ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowRightLeft className="h-4 w-4" />} Solicitar
            </button>
          </div>
        </section>
      )}

      {carregando && !dados ? (
        <Spinner label="Carregando transferências..." />
      ) : !dados || dados.rows.length === 0 ? (
        <EmptyState
          title="Nenhuma transferência registrada"
          description="Solicite uma transferência entre locais. O estoque só se move quando ela é expedida e recebida."
          action={
            <button className="btn-accent" onClick={() => setFormAberto(true)}>
              <Plus className="h-4 w-4" /> Nova transferência
            </button>
          }
        />
      ) : (
        <section className="card overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-400 dark:border-navy-800">
                <th className="px-4 py-2">#</th>
                <th className="px-4 py-2">Trajeto</th>
                <th className="px-4 py-2">Status</th>
                <th className="px-4 py-2">Solicitada</th>
                <th className="px-4 py-2 text-right">Ações</th>
              </tr>
            </thead>
            <tbody>
              {dados.rows.map((t) => (
                <tr key={t.id} className="border-b border-slate-100 last:border-0 dark:border-navy-800">
                  <td className="px-4 py-2 tabular-nums text-slate-400">{t.id}</td>
                  <td className="px-4 py-2">
                    <span className="inline-flex items-center gap-1.5">
                      {nomeLocal.get(t.origem_local_id) ?? `#${t.origem_local_id}`}
                      <ArrowRight className="h-3.5 w-3.5 text-slate-400" />
                      {nomeLocal.get(t.destino_local_id) ?? `#${t.destino_local_id}`}
                    </span>
                  </td>
                  <td className="px-4 py-2">
                    <Badge tone={TOM_STATUS[t.status]}>{t.status.replace('_', ' ')}</Badge>
                  </td>
                  <td className="px-4 py-2 text-xs text-slate-500">{formatDateTime(t.solicitada_em)}</td>
                  <td className="px-4 py-2">
                    <div className="flex flex-wrap items-center justify-end gap-1.5">
                      {PROXIMO[t.status] && (
                        <button className="btn-secondary !px-2.5 !py-1.5 text-xs" onClick={() => void acaoDeEstado(t)} disabled={ocupado === t.id}>
                          {ocupado === t.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                          {PROXIMO[t.status] === 'aprovar' ? 'Aprovar' : PROXIMO[t.status] === 'expedir' ? 'Expedir' : 'Receber'}
                        </button>
                      )}
                      {(t.status === 'solicitada' || t.status === 'aprovada') && (
                        <button className="btn-secondary !px-2.5 !py-1.5 text-xs !text-red-600" onClick={() => setAcao({ tipo: 'cancelar', id: t.id })}>
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

      <ConfirmacaoInline
        open={!!acao}
        title="Cancelar transferência?"
        danger
        confirmLabel="Cancelar transferência"
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
            <p>O documento fica CANCELADO e permanece no histórico. A transferência só pode ser cancelada antes da expedição.</p>
            <label className="mt-2 block text-xs font-medium text-slate-500">
              Motivo *
              <input className="input mt-1" value={cancelarMotivo} onChange={(e) => setCancelarMotivo(e.target.value)} />
            </label>
          </div>
        }
      />

      <section className="mt-6 card p-4">
        <h2 className="mb-3 flex items-center gap-2 text-sm font-bold text-navy-900 dark:text-white">
          <AlertTriangle className="h-4 w-4 text-amber-500" /> Reservas ativas (comprometem o disponível)
        </h2>
        {reservas.length === 0 ? (
          <p className="text-sm text-slate-500">Nenhuma reserva ativa. Reservas são criadas pelos documentos que comprometem estoque (venda em separação, OP, qualidade).</p>
        ) : (
          <ul className="divide-y divide-slate-100 dark:divide-navy-800">
            {reservas.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center gap-2 py-2 text-sm">
                <Badge tone={r.tipo === 'bloqueio' ? 'red' : r.tipo === 'empenho' ? 'amber' : 'blue'}>{r.tipo}</Badge>
                <span className="font-semibold text-navy-900 dark:text-white">{nomeProduto.get(r.produto_id) ?? `Produto #${r.produto_id}`}</span>
                <span className="text-slate-500">
                  {r.quantidade} un. {r.local_id ? `· ${nomeLocal.get(r.local_id) ?? `#${r.local_id}`}` : ''} {r.motivo ? `· ${r.motivo}` : ''}
                </span>
                <button className="btn-secondary ml-auto !px-2.5 !py-1.5 text-xs" onClick={() => void liberar(r)} disabled={ocupado === r.id}>
                  Liberar
                </button>
              </li>
            ))}
          </ul>
        )}
        <p className="mt-3 text-xs text-slate-400">
          Catálogo de reservas em{' '}
          <a className="underline" href="/estoque/reservas">
            Reservas de estoque
          </a>
          . Reserva NÃO movimenta saldo — apenas reduz o disponível até ser liberada ou consumida.
          {meta?.mode === 'memory' ? ' (modo demonstração)' : ''}
        </p>
      </section>
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
