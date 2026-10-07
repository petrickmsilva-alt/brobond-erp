// ============================================================================
// EXPEDIÇÃO — §14 (packing / conferência) e divergências
//
// Separar → Conferir → Embalar → Expedir. A conferência é por código de
// barras: o que foi LIDO é comparado com o que foi PEDIDO, e divergência não
// some — vira registro auditável em `divergencias_conferencia`.
//
// Nada aqui movimenta estoque ou financeiro: isso é `expedir`, e quem decide é
// o servidor.
// ============================================================================
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, Package, PackageCheck, ScanBarcode, Search, Truck, X } from 'lucide-react';
import { api, ApiError } from '../lib/api';
import { formatDateTime, formatNumber } from '../lib/format';
import type { ListResult } from '../lib/meta';
import { Alert, Badge, EmptyState, Modal, PageHeader, Spinner, useToast } from '../components/ui';
import BarcodeScanner from '../components/BarcodeScanner';

type Etapa = 'pendente' | 'separacao' | 'conferida' | 'embalada' | 'expedida';

const ROTULO_ETAPA: Record<Etapa, string> = {
  pendente: 'Pendente',
  separacao: 'Em separação',
  conferida: 'Conferida',
  embalada: 'Embalada',
  expedida: 'Expedida',
};

const TOM_ETAPA: Record<Etapa, 'slate' | 'blue' | 'amber' | 'green'> = {
  pendente: 'slate',
  separacao: 'blue',
  conferida: 'amber',
  embalada: 'amber',
  expedida: 'green',
};

type ItemExpedicao = {
  produto_id: number;
  sku: string | null;
  nome: string | null;
  codigo_barras: string | null;
  tamanho_id: number | null;
  quantidade: number;
};

type EventoExpedicao = {
  id: number;
  etapa: string;
  mensagem: string | null;
  usuario: string | null;
  criado_em: string;
};

type Divergencia = {
  id: number;
  venda_id: number;
  esperado: number;
  lido: number;
  faltando: number;
  sobrando: number;
  resolvido_em: string | null;
  resolucao: string | null;
  criado_em: string;
};

type Situacao = {
  venda_id: number;
  status_venda: string;
  etapa: Etapa;
  etapas: Etapa[];
  itens: ItemExpedicao[];
  eventos: EventoExpedicao[];
  divergencias: Divergencia[];
};

type VendaResumo = {
  id: number;
  cliente_id__label?: string | null;
  data: string | null;
  total: number | string;
  status: string;
  expedicao_etapa: Etapa | null;
};

const FILTROS_FILA: Array<{ value: string; label: string }> = [
  { value: 'pendente', label: 'Pendentes' },
  { value: 'separacao', label: 'Em separação' },
  { value: 'conferida', label: 'Conferidas' },
  { value: 'embalada', label: 'Prontas para expedir' },
];

export default function ExpedicaoPage() {
  const toast = useToast();

  const [carregando, setCarregando] = useState(true);
  const [fila, setFila] = useState<VendaResumo[]>([]);
  const [filtro, setFiltro] = useState('pendente');
  const [busca, setBusca] = useState('');
  const [selecionada, setSelecionada] = useState<number | null>(null);
  const [situacao, setSituacao] = useState<Situacao | null>(null);
  const [lidos, setLidos] = useState<string[]>([]);
  const [leitura, setLeitura] = useState('');
  const [scannerAberto, setScannerAberto] = useState(false);
  const [ocupado, setOcupado] = useState(false);
  const [erro, setErro] = useState('');
  const [divergencias, setDivergencias] = useState<Divergencia[]>([]);
  const [aba, setAba] = useState<'fila' | 'divergencias'>('fila');
  const [resolvendo, setResolvendo] = useState<Divergencia | null>(null);
  const [resolucao, setResolucao] = useState('');

  const inputLeitura = useRef<HTMLInputElement>(null);

  // -------------------------------------------------------------------------
  // Fila
  // -------------------------------------------------------------------------

  const carregarFila = useCallback(async () => {
    setCarregando(true);
    try {
      const d = await api.get<ListResult<VendaResumo>>(
        `/vendas?page=1&pageSize=50&sort=id&dir=desc&f.expedicao_etapa=${encodeURIComponent(filtro)}`
      );
      setFila(d.rows);
      setErro('');
    } catch (e) {
      setErro(e instanceof ApiError ? e.message : 'Não foi possível carregar a fila.');
    } finally {
      setCarregando(false);
    }
  }, [filtro]);

  useEffect(() => {
    void carregarFila();
  }, [carregarFila]);

  const carregarDivergencias = useCallback(async () => {
    try {
      const d = await api.get<ListResult<Divergencia>>('/expedicao/divergencias?page=1&pageSize=50');
      setDivergencias(d.rows);
    } catch {
      /* a aba de divergências é secundária; não derruba a fila */
    }
  }, []);

  useEffect(() => {
    void carregarDivergencias();
  }, [carregarDivergencias]);

  // -------------------------------------------------------------------------
  // Situação do pedido
  // -------------------------------------------------------------------------

  const carregarSituacao = useCallback(async (vendaId: number, manterErro = false) => {
    try {
      const s = await api.get<Situacao>(`/vendas/${vendaId}/expedicao`);
      setSituacao(s);
      setLidos([]);
      // Recarregar não pode apagar o resultado que acabou de acontecer — senão a
      // divergência some da tela antes do operador ler.
      if (!manterErro) setErro('');
    } catch (e) {
      setErro(e instanceof ApiError ? e.message : 'Não foi possível ler a expedição.');
    }
  }, []);

  const abrir = (vendaId: number) => {
    setSelecionada(vendaId);
    void carregarSituacao(vendaId);
  };

  const avancar = async (acao: 'separar' | 'embalar' | 'expedir') => {
    if (!selecionada) return;
    setOcupado(true);
    try {
      await api.post(`/vendas/${selecionada}/expedicao/${acao}`, {});
      toast.success(
        acao === 'separar' ? 'Separação iniciada.' : acao === 'embalar' ? 'Pedido embalado.' : 'Pedido expedido.'
      );
      await carregarSituacao(selecionada);
      await carregarFila();
      await carregarDivergencias();
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : 'Ação recusada.';
      setErro(msg);
      toast.error(msg);
    } finally {
      setOcupado(false);
    }
  };

  // -------------------------------------------------------------------------
  // Conferência — leitura por código de barras
  // -------------------------------------------------------------------------

  const registrarLeitura = (codigo: string) => {
    const limpo = codigo.trim();
    if (!limpo) return;
    setLidos((atual) => [...atual, limpo]);
    setLeitura('');
  };

  const conferidosPorCodigo = useMemo(() => {
    const mapa = new Map<string, number>();
    for (const c of lidos) mapa.set(c, (mapa.get(c) || 0) + 1);
    return mapa;
  }, [lidos]);

  const conferir = async () => {
    if (!selecionada) return;
    setOcupado(true);
    setErro('');
    try {
      await api.post(`/vendas/${selecionada}/expedicao/conferir`, { codigos: lidos });
      toast.success('Conferência aprovada — sem divergência.');
      await carregarSituacao(selecionada);
      await carregarFila();
    } catch (e) {
      if (e instanceof ApiError && e.status === 422) {
        // Divergência não é exceção: é o resultado esperado quando falta peça.
        const f = (e.fields || {}) as Record<string, unknown>;
        setErro(
          `Divergência registrada (#${String(f.divergencia_id ?? '?')}): faltando ${String(f.faltando ?? 0)}, sobrando ${String(
            f.sobrando ?? 0
          )}. Nenhum estoque foi movimentado.`
        );
        await carregarSituacao(selecionada, true);
        await carregarDivergencias();
      } else {
        const msg = e instanceof ApiError ? e.message : 'Não foi possível conferir.';
        setErro(msg);
        toast.error(msg);
      }
    } finally {
      setOcupado(false);
    }
  };

  const resolverDivergencia = async () => {
    if (!resolvendo) return;
    setOcupado(true);
    try {
      await api.post(`/expedicao/divergencias/${resolvendo.id}/resolver`, { resolucao });
      toast.success('Divergência resolvida.');
      setResolvendo(null);
      setResolucao('');
      await carregarDivergencias();
      if (selecionada) await carregarSituacao(selecionada);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Não foi possível registrar a resolução.');
    } finally {
      setOcupado(false);
    }
  };

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  const filtroAplicado = useMemo(() => {
    const q = busca.trim().toLowerCase();
    if (!q) return fila;
    return fila.filter((v) => String(v.id).includes(q) || String(v.cliente_id__label ?? '').toLowerCase().includes(q));
  }, [fila, busca]);

  return (
    <div>
      <PageHeader
        title="Expedição"
        description="Separação → conferência → embalagem → expedição. Divergência de conferência fica registrada e não movimenta estoque."
        actions={
          <div className="flex gap-2">
            <button className={aba === 'fila' ? 'btn-primary' : 'btn-secondary'} onClick={() => setAba('fila')}>
              Fila
            </button>
            <button className={aba === 'divergencias' ? 'btn-primary' : 'btn-secondary'} onClick={() => setAba('divergencias')}>
              Divergências {divergencias.some((d) => !d.resolvido_em) && <span className="ml-1">•</span>}
            </button>
          </div>
        }
      />

      {erro && (
        <div className="mb-4">
          <Alert tone="amber">{erro}</Alert>
        </div>
      )}

      {aba === 'divergencias' ? (
        <div className="card overflow-hidden">
          {divergencias.length === 0 ? (
            <EmptyState icon={<PackageCheck className="h-6 w-6" />} title="Nenhuma divergência" description="Tudo conferido até agora." />
          ) : (
            <table className="w-full text-sm">
              <thead className="border-b border-slate-100 text-left text-xs uppercase text-slate-400 dark:border-navy-700">
                <tr>
                  <th className="px-4 py-2">#</th>
                  <th className="px-4 py-2">Pedido</th>
                  <th className="px-4 py-2 text-right">Esperado</th>
                  <th className="px-4 py-2 text-right">Lido</th>
                  <th className="px-4 py-2 text-right">Faltando</th>
                  <th className="px-4 py-2 text-right">Sobrando</th>
                  <th className="px-4 py-2">Situação</th>
                  <th className="px-4 py-2" />
                </tr>
              </thead>
              <tbody>
                {divergencias.map((d) => (
                  <tr key={d.id} className="border-b border-slate-50 dark:border-navy-800">
                    <td className="px-4 py-2 text-slate-400">{d.id}</td>
                    <td className="px-4 py-2">
                      <button className="btn-ghost" onClick={() => { setAba('fila'); abrir(d.venda_id); }}>
                        #{d.venda_id}
                      </button>
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums">{formatNumber(d.esperado)}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{formatNumber(d.lido)}</td>
                    <td className="px-4 py-2 text-right tabular-nums text-red-600">{formatNumber(d.faltando)}</td>
                    <td className="px-4 py-2 text-right tabular-nums text-amber-600">{formatNumber(d.sobrando)}</td>
                    <td className="px-4 py-2">
                      {d.resolvido_em ? (
                        <span className="text-xs text-emerald-600" title={d.resolucao ?? undefined}>
                          resolvida {formatDateTime(d.resolvido_em)}
                        </span>
                      ) : (
                        <Badge tone="red">aberta</Badge>
                      )}
                    </td>
                    <td className="px-4 py-2 text-right">
                      {!d.resolvido_em && (
                        <button
                          className="btn-secondary"
                          onClick={() => {
                            setResolvendo(d);
                            setResolucao('');
                          }}
                        >
                          Resolver
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[340px_1fr]">
          {/* ------------------------------------------------ fila */}
          <div className="space-y-3">
            <div className="card p-3">
              <select className="input" value={filtro} onChange={(e) => setFiltro(e.target.value)}>
                {FILTROS_FILA.map((f) => (
                  <option key={f.value} value={f.value}>
                    {f.label}
                  </option>
                ))}
              </select>
              <div className="relative mt-2">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                <input
                  className="input pl-9"
                  placeholder="Pedido ou cliente"
                  value={busca}
                  onChange={(e) => setBusca(e.target.value)}
                />
              </div>
            </div>

            <div className="card overflow-hidden">
              {carregando ? (
                <Spinner label="Carregando fila..." />
              ) : filtroAplicado.length === 0 ? (
                <EmptyState icon={<Package className="h-6 w-6" />} title="Fila vazia" description="Nenhum pedido nesta etapa." />
              ) : (
                <ul className="divide-y divide-slate-50 dark:divide-navy-800">
                  {filtroAplicado.map((v) => (
                    <li key={v.id}>
                      <button
                        className={`w-full px-4 py-3 text-left transition-colors hover:bg-slate-50 dark:hover:bg-navy-800 ${
                          selecionada === v.id ? 'bg-navy-50 dark:bg-navy-800' : ''
                        }`}
                        onClick={() => abrir(v.id)}
                      >
                        <div className="flex items-center justify-between">
                          <span className="font-semibold text-navy-900 dark:text-white">Pedido #{v.id}</span>
                          <Badge tone={TOM_ETAPA[(v.expedicao_etapa ?? 'pendente') as Etapa]}>
                            {ROTULO_ETAPA[(v.expedicao_etapa ?? 'pendente') as Etapa]}
                          </Badge>
                        </div>
                        <div className="mt-0.5 text-xs text-slate-500 dark:text-navy-300">
                          {v.cliente_id__label ?? '—'} · {v.data ? String(v.data).slice(0, 10) : '—'}
                        </div>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>

          {/* ------------------------------------------------ detalhe */}
          <div className="space-y-4">
            {!situacao ? (
              <div className="card p-10 text-center">
                <Truck className="mx-auto mb-3 h-10 w-10 text-slate-300" />
                <p className="text-sm text-slate-500 dark:text-navy-300">Selecione um pedido na fila.</p>
              </div>
            ) : (
              <>
                <div className="card p-4">
                  <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                    <h3 className="text-base font-bold text-navy-900 dark:text-white">
                      Pedido #{situacao.venda_id}
                      <span className="ml-2 text-sm font-normal text-slate-500">venda: {situacao.status_venda}</span>
                    </h3>
                    <Badge tone={TOM_ETAPA[situacao.etapa]}>{ROTULO_ETAPA[situacao.etapa]}</Badge>
                  </div>

                  {/* esteira de etapas */}
                  <ol className="mb-4 flex flex-wrap items-center gap-1 text-xs">
                    {situacao.etapas.map((e, i) => {
                      const atual = situacao.etapa === e;
                      const feita = situacao.etapas.indexOf(situacao.etapa) > i;
                      return (
                        <li key={e} className="flex items-center gap-1">
                          <span
                            className={`rounded-full px-2 py-1 ${
                              atual
                                ? 'bg-navy-600 text-white'
                                : feita
                                  ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300'
                                  : 'bg-slate-100 text-slate-500 dark:bg-navy-800 dark:text-navy-300'
                            }`}
                          >
                            {feita && <CheckCircle2 className="mr-1 inline h-3 w-3" />}
                            {ROTULO_ETAPA[e]}
                          </span>
                          {i < situacao.etapas.length - 1 && <span className="text-slate-300">→</span>}
                        </li>
                      );
                    })}
                  </ol>

                  <div className="flex flex-wrap gap-2">
                    <button className="btn-secondary" onClick={() => void avancar('separar')} disabled={ocupado || situacao.etapa !== 'pendente'}>
                      Iniciar separação
                    </button>
                    <button className="btn-accent" onClick={() => void conferir()} disabled={ocupado || !lidos.length}>
                      <PackageCheck className="h-4 w-4" /> Conferir {lidos.length ? `(${lidos.length})` : ''}
                    </button>
                    <button className="btn-secondary" onClick={() => void avancar('embalar')} disabled={ocupado || situacao.etapa !== 'conferida'}>
                      Embalar
                    </button>
                    <button className="btn-primary" onClick={() => void avancar('expedir')} disabled={ocupado || situacao.etapa !== 'embalada'}>
                      <Truck className="h-4 w-4" /> Expedir
                    </button>
                  </div>
                  <p className="mt-2 text-[11px] text-slate-400">
                    Expedir é o que fatura, baixa estoque e lança o financeiro — por isso só fica habilitado depois de embalado.
                  </p>
                </div>

                {/* leitura */}
                {situacao.etapa === 'separacao' || situacao.etapa === 'conferida' ? (
                  <div className="card p-4">
                    <h4 className="mb-2 flex items-center gap-2 text-sm font-semibold text-navy-900 dark:text-white">
                      <ScanBarcode className="h-4 w-4" /> Conferência por código de barras
                    </h4>
                    <div className="flex gap-2">
                      <input
                        ref={inputLeitura}
                        className="input flex-1"
                        placeholder="Leia o código de barras — Enter para registrar"
                        value={leitura}
                        onChange={(e) => setLeitura(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault();
                            registrarLeitura(leitura);
                          }
                        }}
                      />
                      <button className="btn-secondary" onClick={() => setScannerAberto(true)}>
                        <ScanBarcode className="h-4 w-4" />
                      </button>
                      <button className="btn-ghost" onClick={() => setLidos([])} disabled={!lidos.length}>
                        Limpar
                      </button>
                    </div>
                    <table className="mt-3 w-full text-sm">
                      <thead className="text-left text-xs uppercase text-slate-400">
                        <tr>
                          <th className="py-1">Item</th>
                          <th className="py-1">Código</th>
                          <th className="py-1 text-right">Pedido</th>
                          <th className="py-1 text-right">Lido</th>
                        </tr>
                      </thead>
                      <tbody>
                        {situacao.itens.map((i) => {
                          const lido = i.codigo_barras ? conferidosPorCodigo.get(i.codigo_barras) || 0 : 0;
                          const ok = lido >= i.quantidade;
                          return (
                            <tr key={`${i.produto_id}-${i.tamanho_id ?? 'x'}`} className="border-t border-slate-50 dark:border-navy-800">
                              <td className="py-1">
                                {i.nome ?? `#${i.produto_id}`}
                                <span className="ml-1 text-xs text-slate-400">{i.sku}</span>
                              </td>
                              <td className="py-1 font-mono text-xs text-slate-500">
                                {i.codigo_barras ?? <span className="text-amber-600">sem código</span>}
                              </td>
                              <td className="py-1 text-right tabular-nums">{formatNumber(i.quantidade)}</td>
                              <td className={`py-1 text-right tabular-nums ${ok ? 'text-emerald-600' : 'text-amber-600'}`}>
                                {formatNumber(lido)}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                    {situacao.itens.some((i) => !i.codigo_barras) && (
                      <div className="mt-2">
                        <Alert tone="amber">
                          <div className="flex items-start gap-2">
                            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                            <span>Há item sem código de barras. O servidor recusa a conferência (409) até todos terem.</span>
                          </div>
                        </Alert>
                      </div>
                    )}
                  </div>
                ) : null}

                {/* divergências do pedido + histórico */}
                <div className="grid gap-4 md:grid-cols-2">
                  <div className="card p-4">
                    <h4 className="mb-2 text-sm font-semibold text-navy-900 dark:text-white">Divergências do pedido</h4>
                    {situacao.divergencias.length === 0 ? (
                      <p className="text-sm text-slate-500 dark:text-navy-300">Nenhuma.</p>
                    ) : (
                      <ul className="space-y-2 text-sm">
                        {situacao.divergencias.map((d) => (
                          <li key={d.id} className="rounded border border-slate-100 p-2 dark:border-navy-700">
                            <div className="flex items-center justify-between">
                              <span className="text-xs text-slate-400">#{d.id} · {formatDateTime(d.criado_em)}</span>
                              {d.resolvido_em ? <Badge tone="green">resolvida</Badge> : <Badge tone="red">aberta</Badge>}
                            </div>
                            <div className="mt-1 text-xs">
                              esperado {formatNumber(d.esperado)} · lido {formatNumber(d.lido)} · faltando{' '}
                              <span className="text-red-600">{formatNumber(d.faltando)}</span> · sobrando{' '}
                              <span className="text-amber-600">{formatNumber(d.sobrando)}</span>
                            </div>
                            {d.resolucao && <div className="mt-1 text-xs text-slate-500">{d.resolucao}</div>}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>

                  <div className="card p-4">
                    <h4 className="mb-2 text-sm font-semibold text-navy-900 dark:text-white">Histórico</h4>
                    {situacao.eventos.length === 0 ? (
                      <p className="text-sm text-slate-500 dark:text-navy-300">Sem eventos.</p>
                    ) : (
                      <ul className="space-y-1.5 text-sm">
                        {situacao.eventos.map((e) => (
                          <li key={e.id} className="flex items-baseline justify-between gap-2">
                            <span className="text-slate-600 dark:text-navy-200">
                              <span className="font-medium">{e.etapa}</span>
                              {e.mensagem ? ` — ${e.mensagem}` : ''}
                            </span>
                            <span className="shrink-0 text-xs text-slate-400">{formatDateTime(e.criado_em)}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      <Modal open={scannerAberto} onClose={() => setScannerAberto(false)} title="Ler código de barras">
        <BarcodeScanner
          onScan={(codigo) => {
            registrarLeitura(codigo);
            setScannerAberto(false);
            inputLeitura.current?.focus();
          }}
          onClose={() => setScannerAberto(false)}
          onError={(e) => toast.error(e)}
        />
      </Modal>

      <Modal
        open={resolvendo !== null}
        onClose={() => setResolvendo(null)}
        title={`Resolver divergência #${resolvendo?.id ?? ''}`}
        subtitle="Descreva o que foi feito. A resolução fica auditada."
      >
        <label className="label">
          Resolução
          <textarea
            className="input min-h-24"
            value={resolucao}
            onChange={(e) => setResolucao(e.target.value)}
            placeholder="Ex.: peça localizada no depósito e reposta na caixa; cliente avisado."
          />
        </label>
        <div className="mt-4 flex justify-end gap-2">
          <button className="btn-ghost" onClick={() => setResolvendo(null)}>
            Cancelar
          </button>
          <button className="btn-accent" onClick={() => void resolverDivergencia()} disabled={ocupado || resolucao.trim().length < 5}>
            Registrar resolução
          </button>
        </div>
      </Modal>

      {aba === 'fila' && selecionada && (
        <button className="btn-icon fixed bottom-4 right-4 lg:hidden" onClick={() => setSelecionada(null)} title="Fechar pedido">
          <X className="h-4 w-4" />
        </button>
      )}
    </div>
  );
}
