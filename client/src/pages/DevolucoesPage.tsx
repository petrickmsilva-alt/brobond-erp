// ============================================================================
// DEVOLUÇÃO / LOGÍSTICA REVERSA — §15
//
// Solicitar → Autorizar → Rastrear → Receber → Conferir.
//
// Duas regras desta tela, e as duas vêm do servidor:
//
//   1. **O que pode ser feito agora é o que `proximas_acoes` diz.** A tela não
//      decide o fluxo — ela pergunta. Se o servidor mudar a máquina de estados,
//      a tela acompanha sem edição.
//   2. **Só item em estado `bom` volta ao estoque.** Avaria, uso e acessório
//      faltando ficam registrados e NÃO somam saldo. Receber é conferência,
//      não carimbo.
//
// Mercadoria sem código de rastreamento não entra: o servidor responde 409 e a
// tela explica o porquê em vez de só mostrar o erro.
// ============================================================================
import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, Package, RotateCcw, Truck } from 'lucide-react';
import { api, ApiError } from '../lib/api';
import { formatDateTime, formatNumber } from '../lib/format';
import type { ListResult } from '../lib/meta';
import { Alert, Badge, EmptyState, Modal, PageHeader, Spinner, useToast } from '../components/ui';

type StatusDevolucao = 'solicitada' | 'autorizada' | 'em_transito' | 'recebida' | 'recusada' | 'cancelada';

const ROTULO: Record<StatusDevolucao, string> = {
  solicitada: 'Solicitada',
  autorizada: 'Autorizada',
  em_transito: 'Em trânsito',
  recebida: 'Recebida',
  recusada: 'Recusada',
  cancelada: 'Cancelada',
};

const TOM: Record<StatusDevolucao, 'slate' | 'blue' | 'amber' | 'green' | 'red'> = {
  solicitada: 'amber',
  autorizada: 'blue',
  em_transito: 'blue',
  recebida: 'green',
  recusada: 'red',
  cancelada: 'slate',
};

const TIPOS = [
  { value: 'devolucao', label: 'Devolução' },
  { value: 'troca', label: 'Troca' },
  { value: 'garantia', label: 'Garantia' },
  { value: 'arrependimento', label: 'Arrependimento' },
];

/** Só `bom` volta ao estoque. Os outros ficam registrados sem somar saldo. */
const ESTADOS = [
  { value: 'bom', label: 'Bom — volta ao estoque', volta: true },
  { value: 'avariado', label: 'Avariado — não volta', volta: false },
  { value: 'usado', label: 'Usado — não volta', volta: false },
  { value: 'faltando_acessorio', label: 'Faltando acessório — não volta', volta: false },
];

type ItemDevolucao = {
  id: number;
  produto_id: number;
  sku: string | null;
  produto: string | null;
  tamanho_id: number | null;
  quantidade_solicitada: number;
  quantidade_recebida: number | null;
  estado: string | null;
};

type Detalhe = {
  id: number;
  numero: string | null;
  venda_id: number;
  cliente_id__label?: string | null;
  status: StatusDevolucao;
  motivo: string;
  tipo: string;
  codigo_rastreamento: string | null;
  transportadora: string | null;
  autorizacao_codigo: string | null;
  autorizada_em: string | null;
  recebida_em: string | null;
  local_entrada: string | null;
  observacoes: string | null;
  criado_em: string;
  itens: ItemDevolucao[];
  proximas_acoes: string[];
};

type ListaDevolucao = {
  id: number;
  numero: string | null;
  venda_id: number;
  status: StatusDevolucao;
  tipo: string;
  motivo: string;
  codigo_rastreamento: string | null;
  criado_em: string;
};

const ROTULO_ACAO: Record<string, string> = {
  autorizar: 'Autorizar',
  recusar: 'Recusar',
  cancelar: 'Cancelar',
  registrar_rastreamento: 'Registrar rastreio',
  receber: 'Receber mercadoria',
};

const FILTROS: Array<{ value: string; label: string }> = [
  { value: 'solicitada', label: 'Solicitadas' },
  { value: 'autorizada', label: 'Autorizadas' },
  { value: 'em_transito', label: 'Em trânsito' },
  { value: 'recebida', label: 'Recebidas' },
  { value: 'todas', label: 'Todas' },
];

export default function DevolucoesPage() {
  const toast = useToast();

  const [carregando, setCarregando] = useState(true);
  const [lista, setLista] = useState<ListaDevolucao[]>([]);
  const [filtro, setFiltro] = useState('solicitada');
  const [selecionada, setSelecionada] = useState<number | null>(null);
  const [detalhe, setDetalhe] = useState<Detalhe | null>(null);
  const [ocupado, setOcupado] = useState(false);
  const [erro, setErro] = useState('');
  const [novaAberta, setNovaAberta] = useState(false);
  const [acaoAberta, setAcaoAberta] = useState<string | null>(null);

  // Formulários
  const [nova, setNova] = useState({ venda_id: '', motivo: '', tipo: 'devolucao' });
  const [autorizacao, setAutorizacao] = useState({ codigo: '', transportadora: '' });
  const [rastreio, setRastreio] = useState({ codigo: '', transportadora: '' });
  const [motivoRecusa, setMotivoRecusa] = useState('');
  const [localEntrada, setLocalEntrada] = useState('');
  // Conferência por item: { [itemDevolucaoId]: { quantidade_recebida, estado } }
  const [conferencia, setConferencia] = useState<Record<number, { quantidade_recebida: number; estado: string }>>({});

  const carregarLista = useCallback(async () => {
    setCarregando(true);
    try {
      const filtroSql = filtro === 'todas' ? '' : `&f.status=${encodeURIComponent(filtro)}`;
      const d = await api.get<ListResult<ListaDevolucao>>(`/devolucoes?page=1&pageSize=50&sort=id&dir=desc${filtroSql}`);
      setLista(d.rows);
      setErro('');
    } catch (e) {
      setErro(e instanceof ApiError ? e.message : 'Não foi possível carregar as devoluções.');
    } finally {
      setCarregando(false);
    }
  }, [filtro]);

  useEffect(() => {
    void carregarLista();
  }, [carregarLista]);

  const carregarDetalhe = useCallback(async (id: number) => {
    try {
      const d = await api.get<Detalhe>(`/devolucoes/${id}`);
      setDetalhe(d);
      // Pré-preenche a conferência com o solicitado — o operador ajusta o que divergir.
      setConferencia(
        Object.fromEntries(
          d.itens.map((i) => [i.id, { quantidade_recebida: Number(i.quantidade_solicitada), estado: 'bom' }])
        )
      );
      setErro('');
    } catch (e) {
      setErro(e instanceof ApiError ? e.message : 'Não foi possível ler a devolução.');
    }
  }, []);

  const abrir = (id: number) => {
    setSelecionada(id);
    void carregarDetalhe(id);
  };

  const pode = (acao: string) => Boolean(detalhe?.proximas_acoes?.includes(acao));

  const rodarAcao = async (acao: string, corpo: Record<string, unknown>, sucesso: string) => {
    if (!selecionada) return;
    setOcupado(true);
    setErro('');
    try {
      await api.post(`/devolucoes/${selecionada}/${acao}`, corpo);
      toast.success(sucesso);
      setAcaoAberta(null);
      await carregarDetalhe(selecionada);
      await carregarLista();
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : 'Ação recusada.';
      setErro(msg);
      toast.error(msg);
    } finally {
      setOcupado(false);
    }
  };

  const criarDevolucao = async () => {
    setOcupado(true);
    try {
      const r = await api.post<{ id: number }>('/devolucoes', {
        venda_id: Number(nova.venda_id),
        motivo: nova.motivo,
        tipo: nova.tipo,
      });
      toast.success(`Devolução #${r.id} solicitada.`);
      setNovaAberta(false);
      setNova({ venda_id: '', motivo: '', tipo: 'devolucao' });
      await carregarLista();
      abrir(Number(r.id));
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Não foi possível solicitar a devolução.');
    } finally {
      setOcupado(false);
    }
  };

  /** O que a conferência vai fazer com o estoque — calculado na tela só para exibir. */
  const resumoConferencia = useMemo(() => {
    if (!detalhe) return { volta: 0, naoVolta: 0, faltando: 0 };
    let volta = 0;
    let naoVolta = 0;
    let faltando = 0;
    for (const i of detalhe.itens) {
      const c = conferencia[i.id] ?? { quantidade_recebida: 0, estado: 'bom' };
      if (c.estado === 'bom') volta += c.quantidade_recebida;
      else naoVolta += c.quantidade_recebida;
      faltando += Math.max(0, Number(i.quantidade_solicitada) - c.quantidade_recebida);
    }
    return { volta, naoVolta, faltando };
  }, [detalhe, conferencia]);

  return (
    <div>
      <PageHeader
        title="Devoluções e logística reversa"
        description="Solicitar → autorizar → rastrear → receber. Só item em bom estado volta ao estoque."
        actions={
          <button className="btn-accent" onClick={() => setNovaAberta(true)}>
            <RotateCcw className="h-4 w-4" /> Solicitar devolução
          </button>
        }
      />

      {erro && (
        <div className="mb-4">
          <Alert tone="red">{erro}</Alert>
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-[340px_1fr]">
        {/* ------------------------------------------------ lista */}
        <div className="space-y-3">
          <div className="card p-3">
            <select className="input" value={filtro} onChange={(e) => setFiltro(e.target.value)}>
              {FILTROS.map((f) => (
                <option key={f.value} value={f.value}>
                  {f.label}
                </option>
              ))}
            </select>
          </div>
          <div className="card overflow-hidden">
            {carregando ? (
              <Spinner label="Carregando..." />
            ) : lista.length === 0 ? (
              <EmptyState icon={<RotateCcw className="h-6 w-6" />} title="Nada aqui" description="Nenhuma devolução neste filtro." />
            ) : (
              <ul className="divide-y divide-slate-50 dark:divide-navy-800">
                {lista.map((d) => (
                  <li key={d.id}>
                    <button
                      className={`w-full px-4 py-3 text-left transition-colors hover:bg-slate-50 dark:hover:bg-navy-800 ${
                        selecionada === d.id ? 'bg-navy-50 dark:bg-navy-800' : ''
                      }`}
                      onClick={() => abrir(d.id)}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-semibold text-navy-900 dark:text-white">
                          {d.numero ? `${d.numero}` : `Devolução #${d.id}`}
                        </span>
                        <Badge tone={TOM[d.status]}>{ROTULO[d.status]}</Badge>
                      </div>
                      <div className="mt-0.5 truncate text-xs text-slate-500 dark:text-navy-300">
                        pedido #{d.venda_id} · {d.motivo}
                      </div>
                      <div className="text-[11px] text-slate-400">{formatDateTime(d.criado_em)}</div>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        {/* ------------------------------------------------ detalhe */}
        <div className="space-y-4">
          {!detalhe ? (
            <div className="card p-10 text-center">
              <Package className="mx-auto mb-3 h-10 w-10 text-slate-300" />
              <p className="text-sm text-slate-500 dark:text-navy-300">Selecione uma devolução.</p>
            </div>
          ) : (
            <>
              <div className="card p-4">
                <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                  <h3 className="text-base font-bold text-navy-900 dark:text-white">
                    {detalhe.numero ?? `Devolução #${detalhe.id}`}
                    <span className="ml-2 text-sm font-normal text-slate-500">
                      pedido #{detalhe.venda_id} · {TIPOS.find((t) => t.value === detalhe.tipo)?.label ?? detalhe.tipo}
                    </span>
                  </h3>
                  <Badge tone={TOM[detalhe.status]}>{ROTULO[detalhe.status]}</Badge>
                </div>

                <p className="text-sm text-slate-600 dark:text-navy-200">{detalhe.motivo}</p>

                <dl className="mt-3 grid gap-x-4 gap-y-1 text-sm sm:grid-cols-2">
                  <Info rotulo="Rastreamento" valor={detalhe.codigo_rastreamento ?? '—'} />
                  <Info rotulo="Transportadora" valor={detalhe.transportadora ?? '—'} />
                  <Info rotulo="Autorização" valor={detalhe.autorizacao_codigo ?? '—'} />
                  <Info
                    rotulo="Autorizada em"
                    valor={detalhe.autorizada_em ? formatDateTime(detalhe.autorizada_em) : '—'}
                  />
                  <Info
                    rotulo="Recebida em"
                    valor={detalhe.recebida_em ? formatDateTime(detalhe.recebida_em) : '—'}
                  />
                  <Info rotulo="Entrada" valor={detalhe.local_entrada ?? '—'} />
                </dl>

                {/* As ações vêm do servidor — a tela não decide o fluxo. */}
                <div className="mt-4 flex flex-wrap gap-2">
                  {detalhe.proximas_acoes.length === 0 && (
                    <span className="text-sm text-slate-500 dark:text-navy-300">
                      Nenhuma ação disponível — devolução {ROTULO[detalhe.status].toLowerCase()}.
                    </span>
                  )}
                  {detalhe.proximas_acoes.map((a) => (
                    <button
                      key={a}
                      className={a === 'receber' ? 'btn-accent' : a === 'recusar' || a === 'cancelar' ? 'btn-danger' : 'btn-secondary'}
                      onClick={() => {
                        setAcaoAberta(a);
                        setMotivoRecusa('');
                      }}
                    >
                      {ROTULO_ACAO[a] ?? a}
                    </button>
                  ))}
                </div>
              </div>

              {/* conferência */}
              {pode('receber') && (
                <div className="card p-4">
                  <h4 className="mb-2 text-sm font-semibold text-navy-900 dark:text-white">Conferência do recebimento</h4>
                  {!detalhe.codigo_rastreamento && (
                    <div className="mb-3">
                      <Alert tone="amber">
                        <div className="flex items-start gap-2">
                          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                          <span>
                            Sem código de rastreamento o servidor recusa o recebimento (409). Mercadoria sem
                            rastreabilidade não entra no estoque.
                          </span>
                        </div>
                      </Alert>
                    </div>
                  )}
                  <table className="w-full text-sm">
                    <thead className="text-left text-xs uppercase text-slate-400">
                      <tr>
                        <th className="py-1">Item</th>
                        <th className="py-1 text-right">Solicitado</th>
                        <th className="py-1 text-right">Recebido</th>
                        <th className="py-1">Estado</th>
                      </tr>
                    </thead>
                    <tbody>
                      {detalhe.itens.map((i) => {
                        const c = conferencia[i.id] ?? { quantidade_recebida: 0, estado: 'bom' };
                        return (
                          <tr key={i.id} className="border-t border-slate-50 dark:border-navy-800">
                            <td className="py-1">
                              {i.produto ?? `#${i.produto_id}`}
                              <span className="ml-1 text-xs text-slate-400">{i.sku}</span>
                            </td>
                            <td className="py-1 text-right tabular-nums">{formatNumber(i.quantidade_solicitada)}</td>
                            <td className="py-1 text-right">
                              <input
                                type="number"
                                min={0}
                                max={Number(i.quantidade_solicitada)}
                                className="input w-20 text-right"
                                value={c.quantidade_recebida}
                                onChange={(e) =>
                                  setConferencia((atual) => ({
                                    ...atual,
                                    [i.id]: {
                                      ...c,
                                      quantidade_recebida: Math.min(
                                        Number(i.quantidade_solicitada),
                                        Math.max(0, Math.trunc(Number(e.target.value) || 0))
                                      ),
                                    },
                                  }))
                                }
                              />
                            </td>
                            <td className="py-1">
                              <select
                                className="input"
                                value={c.estado}
                                onChange={(e) => setConferencia((atual) => ({ ...atual, [i.id]: { ...c, estado: e.target.value } }))}
                              >
                                {ESTADOS.map((es) => (
                                  <option key={es.value} value={es.value}>
                                    {es.label}
                                  </option>
                                ))}
                              </select>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>

                  <div className="mt-3 flex flex-wrap gap-2 text-sm">
                    <Badge tone="green">{resumoConferencia.volta} un voltam ao estoque</Badge>
                    {resumoConferencia.naoVolta > 0 && (
                      <Badge tone="amber">{resumoConferencia.naoVolta} un NÃO voltam</Badge>
                    )}
                    {resumoConferencia.faltando > 0 && (
                      <Badge tone="red">{resumoConferencia.faltando} un não recebidas</Badge>
                    )}
                  </div>

                  <label className="label mt-3">
                    Local de entrada
                    <input
                      className="input"
                      placeholder="padrão do cadastro"
                      value={localEntrada}
                      onChange={(e) => setLocalEntrada(e.target.value)}
                    />
                  </label>
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {/* --------------------------------------------------------- modais */}
      <Modal open={novaAberta} onClose={() => setNovaAberta(false)} title="Solicitar devolução">
        <div className="space-y-3">
          <label className="label">
            Pedido (venda)
            <input
              type="number"
              min={1}
              className="input"
              value={nova.venda_id}
              onChange={(e) => setNova((n) => ({ ...n, venda_id: e.target.value }))}
            />
          </label>
          <label className="label">
            Tipo
            <select className="input" value={nova.tipo} onChange={(e) => setNova((n) => ({ ...n, tipo: e.target.value }))}>
              {TIPOS.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </select>
          </label>
          <label className="label">
            Motivo
            <textarea
              className="input min-h-20"
              value={nova.motivo}
              onChange={(e) => setNova((n) => ({ ...n, motivo: e.target.value }))}
              placeholder="Mínimo 5 caracteres."
            />
          </label>
          <p className="text-[11px] text-slate-400">
            Sem itens explícitos, a devolução cobre o pedido inteiro. Só pedido faturado ou entregue pode ser devolvido.
          </p>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button className="btn-ghost" onClick={() => setNovaAberta(false)}>
            Cancelar
          </button>
          <button
            className="btn-accent"
            onClick={() => void criarDevolucao()}
            disabled={ocupado || !Number(nova.venda_id) || nova.motivo.trim().length < 5}
          >
            Solicitar
          </button>
        </div>
      </Modal>

      <Modal
        open={acaoAberta === 'autorizar'}
        onClose={() => setAcaoAberta(null)}
        title="Autorizar devolução"
        subtitle="A autorização libera o rastreio e o recebimento."
      >
        <div className="space-y-3">
          <label className="label">
            Código de autorização
            <input
              className="input"
              value={autorizacao.codigo}
              onChange={(e) => setAutorizacao((a) => ({ ...a, codigo: e.target.value }))}
            />
          </label>
          <label className="label">
            Transportadora
            <input
              className="input"
              value={autorizacao.transportadora}
              onChange={(e) => setAutorizacao((a) => ({ ...a, transportadora: e.target.value }))}
            />
          </label>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button className="btn-ghost" onClick={() => setAcaoAberta(null)}>
            Cancelar
          </button>
          <button
            className="btn-accent"
            onClick={() =>
              void rodarAcao(
                'autorizar',
                {
                  autorizacao_codigo: autorizacao.codigo || undefined,
                  transportadora: autorizacao.transportadora || undefined,
                },
                'Devolução autorizada.'
              )
            }
            disabled={ocupado}
          >
            Autorizar
          </button>
        </div>
      </Modal>

      <Modal
        open={acaoAberta === 'registrar_rastreamento'}
        onClose={() => setAcaoAberta(null)}
        title="Registrar rastreamento"
        subtitle="Sem rastreio o servidor não aceita o recebimento."
      >
        <div className="space-y-3">
          <label className="label">
            Código de rastreamento
            <input
              className="input"
              value={rastreio.codigo}
              onChange={(e) => setRastreio((r) => ({ ...r, codigo: e.target.value }))}
            />
          </label>
          <label className="label">
            Transportadora
            <input
              className="input"
              value={rastreio.transportadora}
              onChange={(e) => setRastreio((r) => ({ ...r, transportadora: e.target.value }))}
            />
          </label>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button className="btn-ghost" onClick={() => setAcaoAberta(null)}>
            Cancelar
          </button>
          <button
            className="btn-accent"
            onClick={() =>
              void rodarAcao(
                'rastreamento',
                { codigo_rastreamento: rastreio.codigo, transportadora: rastreio.transportadora || undefined },
                'Rastreamento registrado.'
              )
            }
            disabled={ocupado || rastreio.codigo.trim().length < 5}
          >
            Registrar
          </button>
        </div>
      </Modal>

      <Modal
        open={acaoAberta === 'receber'}
        onClose={() => setAcaoAberta(null)}
        title="Receber mercadoria"
        subtitle="Confirme a conferência abaixo. Só item em bom estado volta ao estoque."
      >
        <div className="space-y-2 text-sm">
          <div className="flex items-start gap-2">
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
            <span>{resumoConferencia.volta} unidade(s) voltam ao estoque.</span>
          </div>
          {resumoConferencia.naoVolta > 0 && (
            <div className="flex items-start gap-2">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
              <span>{resumoConferencia.naoVolta} unidade(s) NÃO voltam (avaria, uso ou acessório faltando).</span>
            </div>
          )}
          <p className="text-[11px] text-slate-400">
            Devolução total cancela o pedido e reverte o financeiro. Parcial não. Quem decide é o servidor, a partir do
            que você conferir aqui.
          </p>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button className="btn-ghost" onClick={() => setAcaoAberta(null)}>
            Voltar
          </button>
          <button
            className="btn-accent"
            onClick={() =>
              void rodarAcao(
                'receber',
                {
                  local: localEntrada || undefined,
                  itens: detalhe?.itens.map((i) => ({
                    id: i.id,
                    quantidade_recebida: conferencia[i.id]?.quantidade_recebida ?? 0,
                    estado: conferencia[i.id]?.estado ?? 'bom',
                  })),
                },
                'Devolução recebida e conferida.'
              )
            }
            disabled={ocupado || !detalhe?.codigo_rastreamento}
          >
            Confirmar recebimento
          </button>
        </div>
      </Modal>

      <Modal
        open={acaoAberta === 'recusar' || acaoAberta === 'cancelar'}
        onClose={() => setAcaoAberta(null)}
        title={acaoAberta === 'recusar' ? 'Recusar devolução' : 'Cancelar devolução'}
      >
        <label className="label">
          Motivo
          <textarea className="input min-h-20" value={motivoRecusa} onChange={(e) => setMotivoRecusa(e.target.value)} />
        </label>
        <div className="mt-4 flex justify-end gap-2">
          <button className="btn-ghost" onClick={() => setAcaoAberta(null)}>
            Voltar
          </button>
          <button
            className="btn-danger"
            onClick={() =>
              void rodarAcao(
                acaoAberta!,
                { motivo: motivoRecusa || undefined },
                acaoAberta === 'recusar' ? 'Devolução recusada.' : 'Devolução cancelada.'
              )
            }
            disabled={ocupado}
          >
            Confirmar
          </button>
        </div>
      </Modal>

      {detalhe?.status === 'autorizada' && !detalhe.codigo_rastreamento && (
        <div className="pointer-events-none fixed bottom-4 left-1/2 -translate-x-1/2 lg:hidden">
          <Badge tone="amber">
            <Truck className="mr-1 inline h-3 w-3" /> Registre o rastreio para receber
          </Badge>
        </div>
      )}
    </div>
  );
}

function Info({ rotulo, valor }: { rotulo: string; valor: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <dt className="text-slate-500 dark:text-navy-300">{rotulo}</dt>
      <dd className="truncate text-navy-900 dark:text-white">{valor}</dd>
    </div>
  );
}
