// ============================================================================
// PDV — Ponto de Venda de balcão (§8)
//
// A regra que esta tela nunca quebra: **o total não é calculado aqui.**
// O que aparece enquanto o operador digita é uma PRÉVIA, marcada como tal.
// O valor que vale é o que o servidor devolve em `calculo` depois do POST —
// preço, desconto, frete, impostos e total são recalculados lá.
//
// Fluxo: abrir caixa → ler código de barras / SKU → montar itens → receber
// pagamento → finalizar (fatura, baixa estoque, financeiro) → fechar caixa.
// ============================================================================
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  Banknote,
  CheckCircle2,
  CreditCard,
  Minus,
  Plus,
  Receipt,
  ScanBarcode,
  Search,
  ShoppingCart,
  Trash2,
  Wallet,
  X,
} from 'lucide-react';
import { api, ApiError } from '../lib/api';
import { formatMoney } from '../lib/format';
import { Alert, Badge, Modal, PageHeader, Spinner, useToast } from '../components/ui';
import BarcodeScanner from '../components/BarcodeScanner';
import { useAuth } from '../auth/AuthContext';

// ---------------------------------------------------------------------------
// Tipos — espelham o contrato de /api/pdv/*
// ---------------------------------------------------------------------------

type ResumoCaixa = {
  caixa_id: number;
  status: string;
  quantidade_vendas: number;
  quantidade_canceladas: number;
  total_vendido: number;
  por_forma: Record<string, number>;
  suprimentos: number;
  sangrias: number;
  valor_abertura: number;
  esperado_em_dinheiro: number;
};

type Caixa = {
  id: number;
  numero: string;
  local: string | null;
  status: string;
  valor_abertura: number;
  abertura_em: string | null;
  fechamento_em: string | null;
};

type ProdutoResolvido = {
  produto_id: number;
  sku: string;
  sku_produto: string;
  nome: string;
  unidade: string | null;
  codigo_barras: string | null;
  tamanho_id: number | null;
  tamanho: string | null;
  eh_variacao: boolean;
  preco: number;
  preco_tabela: number;
  origem_preco: string;
  lista_preco_id: number | null;
  disponivel_no_tamanho: number | null;
  estoque_disponivel: number;
};

type Linha = {
  produto_id: number;
  sku: string;
  nome: string;
  tamanho_id: number | null;
  tamanho: string | null;
  quantidade: number;
  preco: number;
  preco_tabela: number;
  desconto_pct: number;
  /** Preço digitado pelo operador — exceção registrada pelo servidor. */
  preco_manual: number | null;
  origem_preco: string;
  disponivel: number | null;
};

type Pagamento = { forma: string; valor: number; parcelas: number };

type CalculoServidor = {
  subtotal_itens: number;
  desconto: number;
  frete: number;
  total: number;
  total_pago: number;
  troco: number;
};

/** O servidor informa se a venda é elegível a NFC-e; nada mais é usado na tela. */
type SituacaoFiscal = { elegivel?: boolean; modelo?: string } | null;

type RespostaVenda = {
  venda_id: number;
  calculo: CalculoServidor;
  fiscal: SituacaoFiscal;
  divergencias_de_preco: unknown[];
};

const FORMAS: Array<{ value: string; label: string }> = [
  { value: 'dinheiro', label: 'Dinheiro' },
  { value: 'pix', label: 'Pix' },
  { value: 'cartao_credito', label: 'Cartão de crédito' },
  { value: 'cartao_debito', label: 'Cartão de débito' },
  { value: 'vale', label: 'Vale' },
  { value: 'boleto', label: 'Boleto' },
  { value: 'transferencia', label: 'Transferência' },
  { value: 'outros', label: 'Outros' },
];

const ROTULO_FORMA: Record<string, string> = Object.fromEntries(FORMAS.map((f) => [f.value, f.label]));

const arredonda = (n: number) => Math.round((Number(n) || 0) * 100) / 100;
const rotuloForma = (f: string) => ROTULO_FORMA[f] ?? f;

export default function PdvPage() {
  const toast = useToast();
  const { user } = useAuth();

  const [carregando, setCarregando] = useState(true);
  const [caixa, setCaixa] = useState<Caixa | null>(null);
  const [resumo, setResumo] = useState<ResumoCaixa | null>(null);
  const [linhas, setLinhas] = useState<Linha[]>([]);
  const [pagamentos, setPagamentos] = useState<Pagamento[]>([]);
  const [descontoCupom, setDescontoCupom] = useState(0);
  const [frete, setFrete] = useState(0);
  const [busca, setBusca] = useState('');
  const [buscando, setBuscando] = useState(false);
  const [scannerAberto, setScannerAberto] = useState(false);
  const [aberturaAberta, setAberturaAberta] = useState(false);
  const [movAberto, setMovAberto] = useState<'suprimento' | 'sangria' | null>(null);
  const [fechando, setFechando] = useState(false);
  const [ocupado, setOcupado] = useState(false);
  const [ultimaVenda, setUltimaVenda] = useState<{ id: number; calculo: CalculoServidor; fiscal: SituacaoFiscal } | null>(null);
  /**
   * Emissão fiscal da última venda. Enquanto for `null`, não se afirma nada:
   * só o servidor sabe se a nota foi autorizada — a tela nunca marca como
   * emitida por conta própria.
   */
  const [emissao, setEmissao] = useState<{ estado: 'emitindo' | 'autorizada' | 'recusada'; texto: string } | null>(null);
  const [erro, setErro] = useState('');

  const inputBusca = useRef<HTMLInputElement>(null);

  // -------------------------------------------------------------------------
  // Caixa
  // -------------------------------------------------------------------------

  const carregarCaixa = useCallback(async () => {
    setCarregando(true);
    try {
      const r = await api.get<{ caixa: Caixa | null; resumo?: ResumoCaixa }>('/pdv/caixas/aberto');
      setCaixa(r.caixa);
      setResumo(r.resumo ?? null);
      setErro('');
    } catch (e) {
      setErro(e instanceof ApiError ? e.message : 'Não foi possível ler o caixa.');
    } finally {
      setCarregando(false);
    }
  }, []);

  useEffect(() => {
    void carregarCaixa();
  }, [carregarCaixa]);

  const atualizarResumo = useCallback(async () => {
    if (!caixa) return;
    try {
      setResumo(await api.get<ResumoCaixa>(`/pdv/caixas/${caixa.id}/resumo`));
    } catch {
      /* o resumo é conveniência; não interrompe a operação */
    }
  }, [caixa]);

  // -------------------------------------------------------------------------
  // Busca por código de barras / SKU — o servidor resolve preço e tamanho
  // -------------------------------------------------------------------------

  const resolver = useCallback(
    async (codigo: string) => {
      const limpo = codigo.trim();
      if (!limpo) return;
      setBuscando(true);
      setErro('');
      try {
        const p = await api.get<ProdutoResolvido>(`/pdv/buscar?codigo=${encodeURIComponent(limpo)}`);
        setLinhas((atual) => {
          const idx = atual.findIndex((l) => l.produto_id === p.produto_id && l.tamanho_id === p.tamanho_id);
          if (idx >= 0) {
            const copia = atual.slice();
            copia[idx] = { ...copia[idx], quantidade: arredonda(copia[idx].quantidade + 1) };
            return copia;
          }
          return [
            ...atual,
            {
              produto_id: p.produto_id,
              sku: p.sku,
              nome: p.nome,
              tamanho_id: p.tamanho_id,
              tamanho: p.tamanho,
              quantidade: 1,
              preco: p.preco,
              preco_tabela: p.preco_tabela,
              desconto_pct: 0,
              preco_manual: null,
              origem_preco: p.origem_preco,
              disponivel: p.disponivel_no_tamanho,
            },
          ];
        });
        setBusca('');
        inputBusca.current?.focus();
      } catch (e) {
        const msg = e instanceof ApiError ? e.message : 'Não foi possível resolver o código.';
        setErro(msg);
        toast.error(msg);
      } finally {
        setBuscando(false);
      }
    },
    [toast]
  );

  // -------------------------------------------------------------------------
  // Prévia — SÓ para a tela. O total que vale é o do servidor.
  // -------------------------------------------------------------------------

  const previa = useMemo(() => {
    const subtotal = linhas.reduce(
      (acc, l) => acc + arredonda(arredonda(l.quantidade * l.preco) * (1 - l.desconto_pct / 100)),
      0
    );
    const total = Math.max(0, arredonda(subtotal) - descontoCupom + frete);
    const pago = pagamentos.reduce((acc, p) => acc + p.valor, 0);
    return { subtotal: arredonda(subtotal), total: arredonda(total), pago: arredonda(pago), troco: arredonda(pago - total) };
  }, [linhas, descontoCupom, frete, pagamentos]);

  const alterarLinha = (produtoId: number, tamanhoId: number | null, patch: Partial<Linha>) => {
    setLinhas((atual) =>
      atual.map((l) => (l.produto_id === produtoId && l.tamanho_id === tamanhoId ? { ...l, ...patch } : l))
    );
  };

  const removerLinha = (produtoId: number, tamanhoId: number | null) => {
    setLinhas((atual) => atual.filter((l) => !(l.produto_id === produtoId && l.tamanho_id === tamanhoId)));
  };

  // -------------------------------------------------------------------------
  // Aberturas, movimentos e fechamento de caixa
  // -------------------------------------------------------------------------

  const [formAbertura, setFormAbertura] = useState({ numero: '', valor_abertura: '', local: 'loja', observacoes: '' });

  const abrirCaixa = async () => {
    setOcupado(true);
    try {
      const novo = await api.post<Caixa>('/pdv/caixas', {
        numero: formAbertura.numero || undefined,
        valor_abertura: Number(formAbertura.valor_abertura || 0),
        local: formAbertura.local || undefined,
        observacoes: formAbertura.observacoes || undefined,
      });
      setCaixa(novo);
      setAberturaAberta(false);
      setFormAbertura({ numero: '', valor_abertura: '', local: 'loja', observacoes: '' });
      toast.success(`Caixa ${novo.numero} aberto.`);
      await atualizarResumo();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Não foi possível abrir o caixa.');
    } finally {
      setOcupado(false);
    }
  };

  const [mov, setMov] = useState({ valor: '', motivo: '' });

  const registrarMovimento = async () => {
    if (!caixa || !movAberto) return;
    setOcupado(true);
    try {
      await api.post(`/pdv/caixas/${caixa.id}/movimentos`, {
        tipo: movAberto,
        valor: Number(mov.valor || 0),
        motivo: mov.motivo || undefined,
      });
      toast.success(`${movAberto === 'suprimento' ? 'Suprimento' : 'Sangria'} registrado.`);
      setMovAberto(null);
      setMov({ valor: '', motivo: '' });
      await atualizarResumo();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Não foi possível registrar o movimento.');
    } finally {
      setOcupado(false);
    }
  };

  const [valorContado, setValorContado] = useState('');
  const [resultadoFechamento, setResultadoFechamento] = useState<{ diferenca: number; alerta: string | null } | null>(null);

  const fecharCaixa = async () => {
    if (!caixa) return;
    setOcupado(true);
    try {
      const r = await api.post<{ ok: boolean; diferenca: number; alerta: string | null }>(`/pdv/caixas/${caixa.id}/fechar`, {
        valor_fechamento: Number(valorContado || 0),
      });
      setResultadoFechamento({ diferenca: r.diferenca, alerta: r.alerta });
      setCaixa(null);
      setResumo(null);
      setFechando(false);
      setValorContado('');
      toast.success('Caixa fechado.');
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Não foi possível fechar o caixa.');
    } finally {
      setOcupado(false);
    }
  };

  // -------------------------------------------------------------------------
  // Finalizar venda — quem calcula é o servidor
  // -------------------------------------------------------------------------

  const finalizarVenda = async (faturar: boolean) => {
    if (!caixa) return;
    if (!linhas.length) {
      toast.error('Adicione ao menos um item.');
      return;
    }
    if (!pagamentos.length) {
      toast.error('Informe ao menos um pagamento.');
      return;
    }
    setOcupado(true);
    setErro('');
    try {
      const r = await api.post<RespostaVenda>(
        '/pdv/vendas',
        {
          caixa_id: caixa.id,
          itens: linhas.map((l) => ({
            produto_id: l.produto_id,
            tamanho_id: l.tamanho_id,
            quantidade: l.quantidade,
            desconto_pct: l.desconto_pct,
            preco_manual: l.preco_manual,
          })),
          pagamentos: pagamentos.map((p) => ({ forma: p.forma, valor: p.valor, parcelas: p.parcelas })),
          desconto: descontoCupom || undefined,
          frete: frete || undefined,
          faturar,
        }
      );
      setUltimaVenda({ id: r.venda_id, calculo: r.calculo, fiscal: r.fiscal });
      setEmissao(null);
      setLinhas([]);
      setPagamentos([]);
      setDescontoCupom(0);
      setFrete(0);
      // Se o servidor recalculou diferente da prévia, o operador precisa ver.
      if (Math.abs(r.calculo.total - previa.total) > 0.009) {
        toast.info(`Total recalculado pelo servidor: ${formatMoney(r.calculo.total)}`);
      } else {
        toast.success(`Venda #${r.venda_id} registrada.`);
      }
      await atualizarResumo();
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : 'Não foi possível registrar a venda.';
      setErro(msg);
      toast.error(msg);
    } finally {
      setOcupado(false);
    }
  };

  /**
   * Emitir NFC-e (modelo 65) da última venda.
   *
   * A tela NÃO decide se a nota saiu: ela chama `/api/vendas/:id/fiscal/emitir`
   * e mostra o que o servidor respondeu. Se o provedor recusar, aparece como
   * recusada — nunca como emitida.
   */
  const emitirNfce = async () => {
    if (!ultimaVenda) return;
    setEmissao({ estado: 'emitindo', texto: 'Enviando para a SEFAZ…' });
    try {
      const r = await api.post<{ status?: string; chave?: string | null; protocolo?: string | null; mensagem?: string; error?: string }>(
        `/vendas/${ultimaVenda.id}/fiscal/emitir`,
        { modelo: '65' }
      );
      const status = String(r.status ?? '');
      if (status === 'autorizado') {
        setEmissao({
          estado: 'autorizada',
          texto: `NFC-e autorizada.${r.protocolo ? ` Protocolo ${r.protocolo}.` : ''}${r.chave ? ` Chave ${r.chave}.` : ''}`,
        });
        toast.success('NFC-e autorizada.');
      } else if (status === 'processando') {
        setEmissao({ estado: 'emitindo', texto: 'Enviada — aguardando autorização da SEFAZ.' });
        toast.info('Nota enviada, aguardando autorização.');
      } else {
        // Rejeição é resultado, não exceção: o operador precisa ver o motivo.
        setEmissao({ estado: 'recusada', texto: r.mensagem || r.error || `Não autorizada (status: ${status || 'desconhecido'}).` });
        toast.error('A NFC-e não foi autorizada.');
      }
    } catch (e) {
      setEmissao({ estado: 'recusada', texto: e instanceof ApiError ? e.message : 'Falha ao emitir a NFC-e.' });
      toast.error('Falha ao emitir a NFC-e.');
    }
  };

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  if (carregando) return <Spinner label="Carregando PDV..." />;

  return (
    <div>
      <PageHeader
        title="PDV — venda de balcão"
        description="Preço, desconto, frete, impostos e total são recalculados pelo servidor. A tela mostra apenas uma prévia."
        actions={
          caixa ? (
            <>
              <button className="btn-ghost" onClick={() => setMovAberto('suprimento')}>
                <Plus className="h-4 w-4" /> Suprimento
              </button>
              <button className="btn-ghost" onClick={() => setMovAberto('sangria')}>
                <Minus className="h-4 w-4" /> Sangria
              </button>
              <button className="btn-danger" onClick={() => setFechando(true)}>
                Fechar caixa
              </button>
            </>
          ) : (
            <button className="btn-accent" onClick={() => setAberturaAberta(true)}>
              <Wallet className="h-4 w-4" /> Abrir caixa
            </button>
          )
        }
      />

      {erro && (
        <div className="mb-4">
          <Alert tone="red">{erro}</Alert>
        </div>
      )}

      {resultadoFechamento && (
        <div className="mb-4">
          <Alert tone={resultadoFechamento.alerta ? 'amber' : 'green'}>
            Caixa fechado. Diferença de {formatMoney(resultadoFechamento.diferenca)}
            {resultadoFechamento.alerta ? ` — ${resultadoFechamento.alerta}` : ' (conferido).'}
            <button className="btn-ghost ml-2" onClick={() => setResultadoFechamento(null)}>
              dispensar
            </button>
          </Alert>
        </div>
      )}

      {!caixa ? (
        <div className="card p-10 text-center">
          <Wallet className="mx-auto mb-3 h-10 w-10 text-slate-300" />
          <h2 className="text-base font-semibold text-navy-900 dark:text-white">Nenhum caixa aberto</h2>
          <p className="mx-auto mt-1 max-w-md text-sm text-slate-500 dark:text-navy-300">
            O PDV só registra venda com caixa aberto — é o que amarra o pagamento ao fechamento do dia.
          </p>
          <button className="btn-accent mx-auto mt-4" onClick={() => setAberturaAberta(true)}>
            Abrir caixa
          </button>
        </div>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[1fr_360px]">
          {/* -------------------------------------------------- itens */}
          <div className="space-y-4">
            <div className="card p-4">
              <div className="flex gap-2">
                <div className="relative flex-1">
                  <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                  <input
                    ref={inputBusca}
                    className="input pl-9"
                    placeholder="Código de barras, SKU ou nome — Enter para adicionar"
                    value={busca}
                    onChange={(e) => setBusca(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        void resolver(busca);
                      }
                    }}
                    disabled={!caixa}
                  />
                </div>
                <button className="btn-secondary" onClick={() => setScannerAberto(true)} title="Ler com a câmera">
                  <ScanBarcode className="h-4 w-4" />
                </button>
                <button className="btn-primary" onClick={() => void resolver(busca)} disabled={buscando || !busca.trim()}>
                  {buscando ? <Spinner label="" /> : 'Adicionar'}
                </button>
              </div>
            </div>

            <div className="card overflow-hidden">
              {linhas.length === 0 ? (
                <div className="p-10 text-center text-sm text-slate-500 dark:text-navy-300">
                  <ShoppingCart className="mx-auto mb-2 h-8 w-8 text-slate-300" />
                  Nenhum item. Leia um código de barras ou digite o SKU.
                </div>
              ) : (
                <table className="w-full text-sm">
                  <thead className="border-b border-slate-100 text-left text-xs uppercase text-slate-400 dark:border-navy-700">
                    <tr>
                      <th className="px-4 py-2">Produto</th>
                      <th className="px-2 py-2 text-center">Qtd</th>
                      <th className="px-2 py-2 text-right">Preço</th>
                      <th className="px-2 py-2 text-right">Desc %</th>
                      <th className="px-2 py-2 text-right">Subtotal</th>
                      <th className="px-2 py-2" />
                    </tr>
                  </thead>
                  <tbody>
                    {linhas.map((l) => (
                      <tr key={`${l.produto_id}-${l.tamanho_id ?? 'x'}`} className="border-b border-slate-50 dark:border-navy-800">
                        <td className="px-4 py-2">
                          <div className="font-medium text-navy-900 dark:text-white">{l.nome}</div>
                          <div className="text-xs text-slate-400">
                            {l.sku}
                            {l.tamanho ? ` · ${l.tamanho}` : ''} · {l.origem_preco}
                            {l.disponivel !== null && l.disponivel !== undefined && (
                              <span className={l.disponivel >= l.quantidade ? ' text-emerald-600' : ' text-amber-600'}>
                                {' '}
                                · disp. {l.disponivel}
                              </span>
                            )}
                          </div>
                        </td>
                        <td className="px-2 py-2 text-center">
                          <input
                            type="number"
                            min={0.01}
                            step={1}
                            className="input w-20 text-center"
                            value={l.quantidade}
                            onChange={(e) => alterarLinha(l.produto_id, l.tamanho_id, { quantidade: Number(e.target.value) || 0 })}
                          />
                        </td>
                        <td className="px-2 py-2 text-right">
                          <input
                            type="number"
                            min={0}
                            step={0.01}
                            className="input w-24 text-right"
                            value={l.preco_manual ?? l.preco}
                            onChange={(e) =>
                              alterarLinha(l.produto_id, l.tamanho_id, {
                                preco: Number(e.target.value) || 0,
                                preco_manual: Number(e.target.value) || 0,
                              })
                            }
                            title="Preço manual é exceção e fica registrado"
                          />
                          {l.preco_manual !== null && l.preco_manual !== l.preco_tabela && (
                            <div className="text-[10px] text-amber-600">manual (tabela {formatMoney(l.preco_tabela)})</div>
                          )}
                        </td>
                        <td className="px-2 py-2 text-right">
                          <input
                            type="number"
                            min={0}
                            max={100}
                            step={1}
                            className="input w-16 text-right"
                            value={l.desconto_pct}
                            onChange={(e) => alterarLinha(l.produto_id, l.tamanho_id, { desconto_pct: Number(e.target.value) || 0 })}
                          />
                        </td>
                        <td className="px-2 py-2 text-right tabular-nums">
                          {formatMoney(arredonda(l.quantidade * l.preco) * (1 - l.desconto_pct / 100))}
                        </td>
                        <td className="px-2 py-2 text-right">
                          <button className="btn-icon" onClick={() => removerLinha(l.produto_id, l.tamanho_id)} title="Remover">
                            <Trash2 className="h-4 w-4 text-red-500" />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            {ultimaVenda && (
              <Alert tone="green">
                <div className="flex items-start gap-2">
                  <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
                  <div>
                    <div className="font-semibold">Venda #{ultimaVenda.id} registrada.</div>
                    <div className="mt-1 text-xs">
                      Subtotal {formatMoney(ultimaVenda.calculo.subtotal_itens)} · desconto{' '}
                      {formatMoney(ultimaVenda.calculo.desconto)} · frete {formatMoney(ultimaVenda.calculo.frete)} ·{' '}
                      <strong>total {formatMoney(ultimaVenda.calculo.total)}</strong> · pago{' '}
                      {formatMoney(ultimaVenda.calculo.total_pago)} · troco {formatMoney(ultimaVenda.calculo.troco)}
                    </div>
                    {ultimaVenda.fiscal?.elegivel && (
                      <div className="mt-2">
                        <div className="text-xs">
                          NFC-e elegível (modelo {ultimaVenda.fiscal.modelo ?? '65'}).
                        </div>
                        <button
                          className="btn-secondary mt-1"
                          onClick={() => void emitirNfce()}
                          disabled={emissao?.estado === 'emitindo'}
                        >
                          {emissao?.estado === 'emitindo' ? 'Enviando…' : 'Emitir NFC-e'}
                        </button>
                        {emissao && (
                          <div
                            className={`mt-1 text-xs ${
                              emissao.estado === 'autorizada'
                                ? 'text-emerald-700 dark:text-emerald-300'
                                : emissao.estado === 'recusada'
                                  ? 'text-red-700 dark:text-red-300'
                                  : 'text-slate-500'
                            }`}
                          >
                            {emissao.texto}
                          </div>
                        )}
                      </div>
                    )}
                    <button className="btn-ghost mt-1" onClick={() => setUltimaVenda(null)}>
                      dispensar
                    </button>
                  </div>
                </div>
              </Alert>
            )}
          </div>

          {/* -------------------------------------------------- pagamento e caixa */}
          <div className="space-y-4">
            <div className="card p-4">
              <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold text-navy-900 dark:text-white">
                <Banknote className="h-4 w-4" /> Pagamento
              </h3>
              <PagamentoEditor
                valorDevido={Math.max(0, previa.total - previa.pago)}
                onChange={setPagamentos}
                pagamentos={pagamentos}
              />
            </div>

            <div className="card p-4">
              <h3 className="mb-3 text-sm font-semibold text-navy-900 dark:text-white">Prévia do cupom</h3>
              <div className="mb-3 grid grid-cols-2 gap-2">
                <label className="label">
                  Desconto (R$)
                  <input
                    type="number"
                    min={0}
                    step={0.01}
                    className="input"
                    value={descontoCupom || ''}
                    onChange={(e) => setDescontoCupom(Number(e.target.value) || 0)}
                  />
                </label>
                <label className="label">
                  Frete (R$)
                  <input
                    type="number"
                    min={0}
                    step={0.01}
                    className="input"
                    value={frete || ''}
                    onChange={(e) => setFrete(Number(e.target.value) || 0)}
                  />
                </label>
              </div>

              <dl className="space-y-1 text-sm">
                <Linha2 rotulo="Subtotal" valor={formatMoney(previa.subtotal)} />
                <Linha2 rotulo="Desconto" valor={`− ${formatMoney(descontoCupom)}`} />
                <Linha2 rotulo="Frete" valor={formatMoney(frete)} />
                <Linha2 rotulo="Pago" valor={formatMoney(previa.pago)} />
                <div className="flex items-baseline justify-between border-t border-slate-100 pt-2 dark:border-navy-700">
                  <dt className="text-base font-bold text-navy-900 dark:text-white">Total</dt>
                  <dd className="text-xl font-bold tabular-nums text-navy-900 dark:text-white">{formatMoney(previa.total)}</dd>
                </div>
                {previa.troco > 0 && <Linha2 rotulo="Troco" valor={formatMoney(previa.troco)} destaque />}
              </dl>

              <p className="mt-2 text-[11px] leading-snug text-slate-400">
                Prévia calculada na tela. O servidor recalcula preço, desconto, frete, impostos e total ao registrar.
              </p>

              <div className="mt-3 flex flex-col gap-2">
                <button className="btn-accent" onClick={() => void finalizarVenda(true)} disabled={ocupado || !linhas.length}>
                  <Receipt className="h-4 w-4" /> Finalizar e faturar
                </button>
                <button className="btn-secondary" onClick={() => void finalizarVenda(false)} disabled={ocupado || !linhas.length}>
                  Registrar sem faturar
                </button>
              </div>
            </div>

            {resumo && (
              <div className="card p-4">
                <h3 className="mb-2 flex items-center justify-between text-sm font-semibold text-navy-900 dark:text-white">
                  Caixa {caixa.numero}
                  <Badge tone={caixa.status === 'aberto' ? 'green' : 'slate'}>{caixa.status}</Badge>
                </h3>
                <dl className="space-y-1 text-sm">
                  <Linha2 rotulo="Abertura" valor={formatMoney(resumo.valor_abertura)} />
                  <Linha2 rotulo="Vendas" valor={`${resumo.quantidade_vendas}`} />
                  <Linha2 rotulo="Vendido" valor={formatMoney(resumo.total_vendido)} />
                  <Linha2 rotulo="Suprimentos" valor={formatMoney(resumo.suprimentos)} />
                  <Linha2 rotulo="Sangrias" valor={formatMoney(resumo.sangrias)} />
                  <div className="flex items-baseline justify-between border-t border-slate-100 pt-2 dark:border-navy-700">
                    <dt className="font-semibold text-navy-900 dark:text-white">Esperado em dinheiro</dt>
                    <dd className="font-bold tabular-nums text-navy-900 dark:text-white">
                      {formatMoney(resumo.esperado_em_dinheiro)}
                    </dd>
                  </div>
                </dl>
                {Object.keys(resumo.por_forma || {}).length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1">
                    {Object.entries(resumo.por_forma).map(([f, v]) => (
                      <Badge key={f} tone="slate">
                        {rotuloForma(f)} {formatMoney(v)}
                      </Badge>
                    ))}
                  </div>
                )}
                <div className="mt-2 text-[11px] text-slate-400">Operador: {user?.name ?? '—'}</div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* --------------------------------------------------------- modais */}
      <Modal open={aberturaAberta} onClose={() => setAberturaAberta(false)} title="Abrir caixa">
        <div className="space-y-3">
          <label className="label">
            Número / terminal
            <input
              className="input"
              placeholder="Ex.: CAIXA-01"
              value={formAbertura.numero}
              onChange={(e) => setFormAbertura((f) => ({ ...f, numero: e.target.value }))}
            />
          </label>
          <label className="label">
            Valor de abertura (troco)
            <input
              type="number"
              min={0}
              step={0.01}
              className="input"
              value={formAbertura.valor_abertura}
              onChange={(e) => setFormAbertura((f) => ({ ...f, valor_abertura: e.target.value }))}
            />
          </label>
          <label className="label">
            Local
            <input
              className="input"
              value={formAbertura.local}
              onChange={(e) => setFormAbertura((f) => ({ ...f, local: e.target.value }))}
            />
          </label>
          <label className="label">
            Observações
            <input
              className="input"
              value={formAbertura.observacoes}
              onChange={(e) => setFormAbertura((f) => ({ ...f, observacoes: e.target.value }))}
            />
          </label>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button className="btn-ghost" onClick={() => setAberturaAberta(false)}>
            Cancelar
          </button>
          <button className="btn-accent" onClick={() => void abrirCaixa()} disabled={ocupado}>
            Abrir
          </button>
        </div>
      </Modal>

      <Modal
        open={movAberto !== null}
        onClose={() => setMovAberto(null)}
        title={movAberto === 'suprimento' ? 'Suprimento de caixa' : 'Sangria de caixa'}
        subtitle={movAberto === 'suprimento' ? 'Entrada de dinheiro (troco).' : 'Retirada de dinheiro do caixa.'}
      >
        <div className="space-y-3">
          <label className="label">
            Valor
            <input
              type="number"
              min={0.01}
              step={0.01}
              className="input"
              value={mov.valor}
              onChange={(e) => setMov((m) => ({ ...m, valor: e.target.value }))}
            />
          </label>
          <label className="label">
            Motivo
            <input className="input" value={mov.motivo} onChange={(e) => setMov((m) => ({ ...m, motivo: e.target.value }))} />
          </label>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button className="btn-ghost" onClick={() => setMovAberto(null)}>
            Cancelar
          </button>
          <button className="btn-accent" onClick={() => void registrarMovimento()} disabled={ocupado || !(Number(mov.valor) > 0)}>
            Registrar
          </button>
        </div>
      </Modal>

      <Modal
        open={fechando}
        onClose={() => setFechando(false)}
        title="Fechar caixa"
        subtitle={resumo ? `O sistema espera ${formatMoney(resumo.esperado_em_dinheiro)} em dinheiro.` : undefined}
      >
        {resumo && Math.abs(arredonda(Number(valorContado || 0) - resumo.esperado_em_dinheiro)) > 0.009 && Number(valorContado) > 0 && (
          <div className="mb-3">
            <Alert tone="amber">
              <div className="flex items-start gap-2">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>
                  Diferença de {formatMoney(arredonda(Number(valorContado) - resumo.esperado_em_dinheiro))}. Ela será registrada
                  no fechamento — divergência não some, fica auditada.
                </span>
              </div>
            </Alert>
          </div>
        )}
        <label className="label">
          Valor contado na gaveta
          <input
            type="number"
            min={0}
            step={0.01}
            className="input"
            value={valorContado}
            onChange={(e) => setValorContado(e.target.value)}
          />
        </label>
        <div className="mt-4 flex justify-end gap-2">
          <button className="btn-ghost" onClick={() => setFechando(false)}>
            Cancelar
          </button>
          <button className="btn-danger" onClick={() => void fecharCaixa()} disabled={ocupado || valorContado === ''}>
            Fechar caixa
          </button>
        </div>
      </Modal>

      <Modal open={scannerAberto} onClose={() => setScannerAberto(false)} title="Ler código de barras">
        <BarcodeScanner
          onScan={(codigo) => {
            void resolver(codigo);
            setScannerAberto(false);
          }}
          onClose={() => setScannerAberto(false)}
          onError={(e) => toast.error(e)}
        />
      </Modal>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Apoios de apresentação
// ---------------------------------------------------------------------------

function Linha2({ rotulo, valor, destaque }: { rotulo: string; valor: string; destaque?: boolean }) {
  return (
    <div className="flex items-baseline justify-between">
      <dt className="text-slate-500 dark:text-navy-300">{rotulo}</dt>
      <dd className={`tabular-nums ${destaque ? 'font-semibold text-emerald-600' : 'text-navy-900 dark:text-white'}`}>{valor}</dd>
    </div>
  );
}

function PagamentoEditor({
  pagamentos,
  onChange,
  valorDevido,
}: {
  pagamentos: Pagamento[];
  onChange: (p: Pagamento[]) => void;
  valorDevido: number;
}) {
  const adicionar = () => onChange([...pagamentos, { forma: 'dinheiro', valor: 0, parcelas: 1 }]);
  const alterar = (i: number, patch: Partial<Pagamento>) => onChange(pagamentos.map((p, idx) => (idx === i ? { ...p, ...patch } : p)));
  const remover = (i: number) => onChange(pagamentos.filter((_, idx) => idx !== i));

  return (
    <div className="space-y-2">
      {pagamentos.map((p, i) => (
        <div key={i} className="flex items-end gap-2">
          <label className="label flex-1">
            Forma
            <select className="input" value={p.forma} onChange={(e) => alterar(i, { forma: e.target.value })}>
              {FORMAS.map((f) => (
                <option key={f.value} value={f.value}>
                  {f.label}
                </option>
              ))}
            </select>
          </label>
          <label className="label w-28">
            Valor
            <input
              type="number"
              min={0}
              step={0.01}
              className="input"
              value={p.valor || ''}
              onChange={(e) => alterar(i, { valor: Number(e.target.value) || 0 })}
            />
          </label>
          {p.forma === 'cartao_credito' && (
            <label className="label w-20">
              Parc.
              <input
                type="number"
                min={1}
                max={12}
                className="input"
                value={p.parcelas}
                onChange={(e) => alterar(i, { parcelas: Number(e.target.value) || 1 })}
              />
            </label>
          )}
          <button className="btn-icon" onClick={() => remover(i)} title="Remover pagamento">
            <X className="h-4 w-4 text-red-500" />
          </button>
        </div>
      ))}
      <div className="flex items-center justify-between pt-1">
        <button className="btn-secondary" onClick={adicionar}>
          <CreditCard className="h-4 w-4" /> Adicionar pagamento
        </button>
        <button
          className="btn-ghost text-xs"
          onClick={() => onChange([{ forma: 'dinheiro', valor: arredonda(valorDevido), parcelas: 1 }])}
          disabled={valorDevido <= 0}
          title="Preenche com o valor devido"
        >
          Exato
        </button>
      </div>
    </div>
  );
}
