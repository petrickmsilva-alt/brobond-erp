import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  AlertTriangle,
  ArrowLeft,
  Check,
  CheckCircle2,
  Edit3,
  Loader2,
  PackageCheck,
  Plus,
  Printer,
  RefreshCw,
  Save,
  Trash2,
  Truck,
  X,
} from 'lucide-react';
import { api } from '../lib/api';
import { useMeta, type Option, type ResourceMeta } from '../lib/meta';
import { useAuth } from '../auth/AuthContext';
import { Alert, Badge, ConfirmacaoInline, PageHeader, Spinner, useToast } from '../components/ui';
import { DocumentPrintButton } from '../components/DocumentPrintButton';
import { Thumb } from '../components/ImageField';
import RecebimentoCompraModal from '../components/RecebimentoCompraModal';
import { ProductSelector } from '../components/ProductSelector';
import { searchProducts } from '../lib/productSearch';
import { formatDate, formatDocumento, formatMoney, formatNumber, parseMoneyInput } from '../lib/format';
import {
  arredondarMoeda,
  descontoUnitarioDe,
  linhaDePreco,
  normalizarPctVenda,
  pctDeDescontoUnitario,
  resumoVenda,
} from '../lib/precoVenda';
import { hojeCivilIso, maskDataBR, parseDataBR } from '../lib/datas';
import { buildProductSelection, requiresExplicitChoice, type ProductSelection } from '../lib/productSelection';
import {
  CampoDataVenda,
  CampoMoedaVenda,
  ContasAReceberDaVenda,
  formatarCampoMoeda,
  previaParcelasReais,
  SecaoVenda,
  SeletorModoPessoa,
  type ModoPessoaVenda,
} from '../components/venda/VendaCampos';
import {
  ClienteVendaSelector,
  inferirModoPessoaCliente,
  type ClienteVendaRegistro,
} from '../components/venda/ClienteVendaSelector';
import { FiscalVendaCard } from '../components/venda/FiscalVendaCard';

type Tipo = 'venda' | 'compra';
export type ModoPaginaVenda = 'novo' | 'detalhe' | 'editar';

type Item = {
  id: number;
  produto_id?: number;
  insumo_id?: number;
  tamanho_id?: number;
  quantidade: number | string;
  /** Preço de VENDA praticado — a BASE do desconto percentual e em R$. */
  preco_unitario: number | string;
  desconto_pct?: number | string;
  subtotal?: number;
  /** Preço de TABELA (referência da precificação). NÃO é base do desconto. */
  preco_tabela?: number | string | null;
  lista_preco_id?: number | null;
  produto_id__label?: string;
  insumo_id__label?: string;
  tamanho_id__label?: string;
  produto_id__foto?: string | null;
  sku?: string | null;
  cor?: string | null;
  codigo_barras?: string | null;
  estoque_disponivel?: number | null;
  persistido?: boolean;
  [k: string]: any;
};

type LocalAtivo = {
  id: number;
  nome: string;
  ativo?: boolean;
};

type FormVenda = {
  modoPessoa: ModoPessoaVenda;
  cliente_id: number | null;
  statusInicial: 'aberta' | 'cotacao';
  dataBr: string;
  canal_venda: string;
  representante_id: string;
  local_saida: string;
  pedido_cliente: string;
  previsao_entrega_br: string;
  desconto_texto: string;
  frete_texto: string;
  fin_status: string;
  fin_forma_pagamento: string;
  fin_parcelas: string;
  condicao_pagamento: string;
  fin_vencimento_br: string;
  fin_recebido_em_br: string;
  fin_conta_id: string;
  fin_documento: string;
  observacoes: string;
};

const STATUS_TONE: Record<string, 'green' | 'red' | 'amber' | 'blue' | 'slate'> = {
  cotacao: 'slate',
  aberta: 'amber',
  pendente_aprovacao: 'amber',
  faturada: 'green',
  entregue: 'blue',
  cancelada: 'red',
  pendente: 'amber',
  recebido: 'green',
  cancelado: 'red',
};

const STATUS_VENDA_LABEL: Record<string, string> = {
  cotacao: 'Cotação',
  aberta: 'Aberta',
  pendente_aprovacao: 'Aguardando aprovação',
  faturada: 'Faturada',
  entregue: 'Entregue',
  cancelada: 'Cancelada',
};

const CANAL_VENDA_OPCOES = [
  { value: 'balcao', label: 'Balcão' },
  { value: 'pdv', label: 'PDV (caixa)' },
  { value: 'representante', label: 'Representante' },
  { value: 'whatsapp', label: 'WhatsApp' },
  { value: 'site_varejo', label: 'Site varejo' },
  { value: 'site_atacado', label: 'Site atacado' },
  { value: 'marketplace', label: 'Marketplace' },
  { value: 'outro', label: 'Outro' },
];

const FIN_STATUS_OPCOES = [
  { value: 'a_receber', label: 'A receber' },
  { value: 'recebido', label: 'Recebido' },
  { value: 'cancelado', label: 'Cancelado' },
];

const FIN_FORMA_OPCOES = [
  { value: '', label: 'Não informada' },
  { value: 'pix', label: 'PIX' },
  { value: 'cartao_credito', label: 'Cartão de crédito' },
  { value: 'cartao_debito', label: 'Cartão de débito' },
  { value: 'boleto', label: 'Boleto' },
  { value: 'dinheiro', label: 'Dinheiro' },
  { value: 'transferencia', label: 'Transferência' },
  { value: 'outros', label: 'Outros' },
];

function arredondar2(n: number): number {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function parsePrecoUnitario(v: unknown): number {
  if (typeof v === 'number') return Number.isFinite(v) ? v : NaN;
  const s = String(v ?? '').trim();
  if (!s) return NaN;
  const parsed = parseMoneyInput(s);
  return parsed === null ? NaN : parsed;
}

function criarFormInicialVenda(localPadrao: string): FormVenda {
  return {
    modoPessoa: 'pf',
    cliente_id: null,
    statusInicial: 'aberta',
    dataBr: maskDataBR(hojeCivilIso()),
    canal_venda: 'balcao',
    representante_id: '',
    local_saida: localPadrao,
    pedido_cliente: '',
    previsao_entrega_br: '',
    desconto_texto: formatarCampoMoeda(0),
    frete_texto: formatarCampoMoeda(0),
    fin_status: 'a_receber',
    fin_forma_pagamento: '',
    fin_parcelas: '1',
    condicao_pagamento: '',
    fin_vencimento_br: '',
    fin_recebido_em_br: '',
    fin_conta_id: '',
    fin_documento: '',
    observacoes: '',
  };
}

function hidratarFormDePedido(p: Record<string, any>, localPadrao: string, modoAtual: ModoPessoaVenda): FormVenda {
  return {
    modoPessoa: modoAtual,
    cliente_id: p.cliente_id != null ? Number(p.cliente_id) : null,
    statusInicial: p.status === 'cotacao' ? 'cotacao' : 'aberta',
    dataBr: p.data ? maskDataBR(String(p.data).slice(0, 10)) : maskDataBR(hojeCivilIso()),
    canal_venda: String(p.canal_venda || 'balcao'),
    representante_id: p.representante_id != null ? String(p.representante_id) : '',
    local_saida: String(p.local_saida || localPadrao),
    pedido_cliente: String(p.pedido_cliente || ''),
    previsao_entrega_br: p.previsao_entrega ? maskDataBR(String(p.previsao_entrega).slice(0, 10)) : '',
    desconto_texto: formatarCampoMoeda(p.desconto ?? 0),
    frete_texto: formatarCampoMoeda(p.frete ?? 0),
    fin_status: String(p.fin_status || 'a_receber'),
    fin_forma_pagamento: String(p.fin_forma_pagamento || ''),
    fin_parcelas: String(Math.max(1, Number(p.fin_parcelas || 1))),
    condicao_pagamento: String(p.condicao_pagamento || ''),
    fin_vencimento_br: p.fin_vencimento ? maskDataBR(String(p.fin_vencimento).slice(0, 10)) : '',
    fin_recebido_em_br: p.fin_recebido_em ? maskDataBR(String(p.fin_recebido_em).slice(0, 10)) : '',
    fin_conta_id: p.fin_conta_id != null ? String(p.fin_conta_id) : '',
    fin_documento: String(p.fin_documento || ''),
    observacoes: String(p.observacoes || ''),
  };
}

export default function OrderPage({ tipo, modo }: { tipo: Tipo; modo?: ModoPaginaVenda }) {
  if (tipo === 'compra') {
    return <CompraOrderEngine />;
  }
  return <VendaOrderEngine modo={modo} />;
}

// ============================================================================
// MOTOR ÚNICO DE VENDAS (PF — CPF e PJ — CNPJ · /vendas/novo · /:id · /:id/editar)
// ============================================================================
function VendaOrderEngine({ modo }: { modo?: ModoPaginaVenda }) {
  const { id } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const { user } = useAuth();
  const meta = useMeta();

  const modoRota: ModoPaginaVenda = modo ?? (!id ? 'novo' : 'detalhe');
  const ehRotaNovo = modoRota === 'novo';
  const ehRotaEditar = modoRota === 'editar';
  const localPadrao = meta?.defaultLocal?.nome || 'loja';

  // Quando `/vendas/novo` cria o cabeçalho e falha num passo seguinte (item/faturar),
  // guardamos o ID criado para não duplicar o pedido na nova tentativa.
  const [vendaCriadaId, setVendaCriadaId] = useState<number | null>(null);
  const vendaIdAtiva = ehRotaNovo ? vendaCriadaId : Number(id) || null;

  const [pedido, setPedido] = useState<Record<string, any> | null>(null);
  const [form, setForm] = useState<FormVenda>(() => criarFormInicialVenda(localPadrao));
  const [sujo, setSujo] = useState(false);
  const [clienteObj, setClienteObj] = useState<ClienteVendaRegistro | null>(null);

  const [itens, setItens] = useState<Item[]>([]);
  const rascunhoSeq = useRef(0);

  const [loading, setLoading] = useState(!ehRotaNovo);
  const [loadError, setLoadError] = useState('');
  const [erros, setErros] = useState<Record<string, string>>({});
  const [erroGeral, setErroGeral] = useState('');
  const resumoErrosRef = useRef<HTMLDivElement>(null);

  const [salvando, setSalvando] = useState<'salvar' | 'finalizar' | 'entregar' | 'cancelar' | null>(null);
  const [confirmarCancelamento, setConfirmarCancelamento] = useState(false);
  const [busyItem, setBusyItem] = useState<number | 'new' | null>(null);
  const [toDelete, setToDelete] = useState<Item | null>(null);
  const [itemEditandoId, setItemEditandoId] = useState<number | null>(null);
  // Formação de preço da linha em edição. `preco_unitario` guarda o PREÇO DE
  // VENDA praticado (a base do desconto) e `desconto_rs` o desconto unitário em
  // R$. O `preco_tabela` é a referência comercial: só é editável por quem tem
  // autorização (o servidor recusa a alteração de quem não tem).
  const [itemEditDraft, setItemEditDraft] = useState<{
    quantidade: string;
    preco_tabela: string;
    preco_unitario: string;
    desconto_pct: string;
    desconto_rs: string;
  }>({
    quantidade: '1',
    preco_tabela: '0',
    preco_unitario: '0',
    desconto_pct: '0',
    desconto_rs: '0',
  });

  // Opções auxiliares
  const [repOpts, setRepOpts] = useState<Option[]>([]);
  const [tamanhoOpts, setTamanhoOpts] = useState<Option[]>([]);
  const [locaisAtivos, setLocaisAtivos] = useState<LocalAtivo[]>([]);
  const [contasOpts, setContasOpts] = useState<Option[]>([]);

  const podeGerirFinanceiro = user?.perfil === 'gerente' || user?.perfil === 'admin';
  const podeExcluir = user?.perfil !== 'operador';
  // Alterar o preço de tabela exige autorização explícita — validada no servidor.
  const podeEditarTabela = user?.perfil === 'admin' || user?.perm_preco_tabela === 'permitir';

  const statusAtual = ehRotaNovo && !pedido ? form.statusInicial : String(pedido?.status || 'aberta');
  const fechado = !ehRotaNovo && ['faturada', 'entregue'].includes(statusAtual);
  const cancelado = !ehRotaNovo && statusAtual === 'cancelada';
  const itensBloqueados = fechado || cancelado;
  // No servidor, campos financeiros e observações ainda aceitam reconciliação enquanto não cancelada.
  const financeiroBloqueado = cancelado;

  // Linha de inclusão de novo produto via Smart Product Search global (`ProductSelector`)
  const blankItem: Item = useMemo(
    () => ({ id: 0, produto_id: undefined, tamanho_id: undefined, quantidade: 1, preco_unitario: '', desconto_pct: 0, preco_tabela: '' }),
    []
  );
  const [novo, setNovo] = useState<Item>(blankItem);
  const [selecaoProduto, setSelecaoProduto] = useState<ProductSelection | null>(null);
  const [tamanhosDoProduto, setTamanhosDoProduto] = useState<Array<{ tamanho_id: number; tamanho: string; quantidade: number }>>([]);
  const [erroNovoItem, setErroNovoItem] = useState('');
  /**
   * Disponibilidade canônica vinda de `GET /estoques/disponivel` — o MESMO
   * número que o faturamento vai baixar (célula do local de saída, com o
   * fallback do Local padrão). A tela não soma estoque; só mostra o que o
   * servidor devolveu, com o local explícito.
   */
  const [disponibilidade, setDisponibilidade] = useState<{
    quantidade: number;
    local: string | null;
    estoque_fisico: number;
    tamanho_id: number | null;
  } | null>(null);

  // Carrega opções de apoio sem quebrar quando alguma rota não está mockada ou restrita por RBAC.
  useEffect(() => {
    api.get<Option[]>('/tamanhos/options').then(setTamanhoOpts).catch(() => {});
    api.get<Option[]>('/representantes/options').then(setRepOpts).catch(() => {});
    api
      .get<{ rows?: LocalAtivo[] }>('/locais?f.ativo=true&pageSize=100')
      .then((r) => {
        if (Array.isArray(r?.rows)) setLocaisAtivos(r.rows);
      })
      .catch(() => {});
    if (podeGerirFinanceiro) {
      api.get<Option[]>('/contas_financeiras/options').then(setContasOpts).catch(() => {});
    }
  }, [podeGerirFinanceiro]);

  const carregarClienteDetalhe = useCallback(async (clienteId: number | null | undefined) => {
    if (!clienteId || clienteId < 1) {
      setClienteObj(null);
      return;
    }
    try {
      const cli = await api.get<ClienteVendaRegistro>(`/clientes/${clienteId}`);
      if (cli && cli.id) {
        setClienteObj(cli);
        const modoInferido = inferirModoPessoaCliente(cli);
        setForm((f) => ({ ...f, modoPessoa: modoInferido, cliente_id: Number(cli.id) }));
      }
    } catch {
      // Preserva cliente_id__label do pedido se a rota individual não estiver mockada.
    }
  }, []);

  const recarregarPedido = useCallback(
    async (idAlvo?: number, sobrescreverForm = false) => {
      const alvo = idAlvo ?? (ehRotaNovo ? vendaCriadaId : Number(id));
      if (!alvo) return;
      if (!pedido) setLoading(true);
      setLoadError('');
      try {
        const [p, it] = await Promise.all([
          api.get<Record<string, any>>(`/vendas/${alvo}`),
          api.get<Item[]>(`/vendas/${alvo}/itens`),
        ]);
        setPedido(p);
        setItens((it || []).map((x) => ({ ...x, persistido: true })));
        if (sobrescreverForm || !sujo) {
          setForm((atual) => hidratarFormDePedido(p, localPadrao, atual.modoPessoa));
          setSujo(false);
        }
        if (p?.cliente_id) {
          void carregarClienteDetalhe(Number(p.cliente_id));
        } else {
          setClienteObj(null);
        }
      } catch (e: any) {
        setLoadError(e?.message || 'Erro ao carregar o pedido de venda.');
      } finally {
        setLoading(false);
      }
    },
    [carregarClienteDetalhe, ehRotaNovo, id, localPadrao, pedido, sujo, vendaCriadaId]
  );

  // Carrega venda existente ao entrar em `/vendas/:id` ou `/vendas/:id/editar`
  const carregouInicialRef = useRef<number | null>(null);
  useEffect(() => {
    if (ehRotaNovo) {
      setLoading(false);
      return;
    }
    const numId = Number(id);
    if (!numId || carregouInicialRef.current === numId) return;
    carregouInicialRef.current = numId;
    void recarregarPedido(numId, true);
  }, [ehRotaNovo, id, recarregarPedido]);

  const setCampo = useCallback(<K extends keyof FormVenda>(chave: K, valor: FormVenda[K]) => {
    setForm((atual) => ({ ...atual, [chave]: valor }));
    setSujo(true);
    setErros((ant) => {
      if (!ant[chave]) return ant;
      const copia = { ...ant };
      delete copia[chave];
      return copia;
    });
  }, []);

  // ID do local de saída selecionado (para filtrar/ordenar saldos no ProductSelector)
  const localSaidaId = useMemo(() => {
    const nome = form.local_saida.trim().toLowerCase();
    if (!nome) return null;
    const achado = locaisAtivos.find((l) => String(l.nome || '').trim().toLowerCase() === nome);
    return achado ? achado.id : null;
  }, [form.local_saida, locaisAtivos]);

  /**
   * Formação de preço de cada linha, do jeito que o operador precisa enxergar:
   * preço de tabela → preço de venda → desconto % → desconto R$ → subtotal.
   *
   * A BASE do desconto é o PREÇO DE VENDA (`preco_unitario`); o preço de tabela
   * é apenas referência (não entra na conta). O subtotal usa a mesma fórmula
   * canônica do servidor (`linhaDePreco`), para a tela nunca divergir.
   */
  const linhasPreco = useMemo(
    () =>
      itens.map((it) => {
        const qtd = Number(it.quantidade) || 0;
        const precoVenda = parsePrecoUnitario(it.preco_unitario) || 0;
        const tabela = it.preco_tabela != null ? Number(it.preco_tabela) : precoVenda;
        const pct = Number(it.desconto_pct) || 0;
        const l = linhaDePreco(qtd, precoVenda, pct, tabela);
        // A linha persistida já traz o subtotal autoritativo do servidor.
        const subtotal = it.subtotal !== undefined && it.subtotal !== null ? arredondarMoeda(Number(it.subtotal)) : l.subtotal;
        return { ...l, item: it, quantidade: qtd, subtotal, desconto: arredondarMoeda(l.bruto - subtotal) };
      }),
    [itens]
  );

  // Totais calculados ao vivo (espelhando a fórmula canônica `recalcularTotal` do servidor)
  const subtotalItens = useMemo(
    () => arredondarMoeda(linhasPreco.reduce((acc, l) => acc + l.subtotal, 0)),
    [linhasPreco]
  );

  const totalPecas = useMemo(
    () => itens.reduce((acc, it) => acc + Math.max(0, Number(it.quantidade) || 0), 0),
    [itens]
  );

  const valorDesconto = useMemo(() => Math.max(0, parseMoneyInput(form.desconto_texto) ?? 0), [form.desconto_texto]);
  const valorFrete = useMemo(() => Math.max(0, parseMoneyInput(form.frete_texto) ?? 0), [form.frete_texto]);
  const totalCalculado = useMemo(
    () => arredondarMoeda(Math.max(0, subtotalItens + valorFrete - valorDesconto)),
    [subtotalItens, valorDesconto, valorFrete]
  );
  const totalExibido = !ehRotaNovo && !sujo && pedido?.total !== undefined ? Number(pedido.total) : totalCalculado;

  // Resumo consolidado: preço bruto → desconto real → subtotal líquido → frete → total.
  const resumo = useMemo(
    () => resumoVenda(linhasPreco, valorDesconto, valorFrete),
    [linhasPreco, valorDesconto, valorFrete]
  );

  const qtdParcelasNum = Math.max(1, Math.min(60, Math.trunc(Number(form.fin_parcelas) || 1)));
  const parcelasPrevia = useMemo(
    () => previaParcelasReais(totalExibido, qtdParcelasNum),
    [qtdParcelasNum, totalExibido]
  );

  function subtotalNovo(): number {
    const q = Number(novo.quantidade) || 0;
    const p = parsePrecoUnitario(novo.preco_unitario);
    const d = normalizarPctVenda(Number(novo.desconto_pct) || 0);
    if (!Number.isFinite(p) || p < 0 || q <= 0) return 0;
    return linhaDePreco(q, p, d).subtotal;
  }

  /**
   * Fecha a linha em edição a partir do campo que o operador acabou de mexer.
   * A base é SEMPRE o preço de venda; o preço de tabela não participa.
   */
  function atualizarDraftItem(campo: 'preco_tabela' | 'preco_unitario' | 'desconto_pct' | 'desconto_rs', valor: string) {
    setItemEditDraft((d) => {
      if (campo === 'preco_tabela') {
        // Alterar a tabela NÃO mexe no preço de venda nem no desconto: a tabela
        // é referência, não base de cálculo.
        return { ...d, preco_tabela: valor };
      }
      const precoVenda = parsePrecoUnitario(d.preco_unitario) || 0;
      if (campo === 'desconto_pct') {
        const pct = normalizarPctVenda(Number(String(valor).replace(',', '.')) || 0);
        return {
          ...d,
          desconto_pct: valor,
          desconto_rs: String(descontoUnitarioDe(precoVenda, pct)),
        };
      }
      if (campo === 'preco_unitario') {
        // Alterou o preço de venda: MANTÉM o desconto atual e recalcula o R$.
        const preco = parseMoneyInput(valor) ?? 0;
        const pct = normalizarPctVenda(Number(d.desconto_pct) || 0);
        return { ...d, preco_unitario: valor, desconto_rs: String(descontoUnitarioDe(preco, pct)) };
      }
      const rs = parseMoneyInput(valor) ?? 0;
      const pct = pctDeDescontoUnitario(precoVenda, rs);
      return { ...d, desconto_rs: valor, desconto_pct: String(pct) };
    });
  }

  /**
   * Recalcula a linha NOVA (ainda não adicionada) quando o operador mexe em
   * preço de venda, desconto % ou desconto R$ — sempre sobre o PREÇO DE VENDA.
   * Só um campo é a fonte; os outros dois são derivados, sem loop.
   */
  function atualizarNovoPreco(campo: 'preco_tabela' | 'preco_unitario' | 'desconto_pct' | 'desconto_rs', valor: string) {
    setNovo((n) => {
      if (campo === 'preco_tabela') {
        // Referência apenas — não altera o preço de venda nem o desconto.
        return { ...n, preco_tabela: valor };
      }
      const precoVenda = parsePrecoUnitario(n.preco_unitario) || 0;
      if (campo === 'desconto_pct') {
        const pct = normalizarPctVenda(Number(String(valor).replace(',', '.')) || 0);
        return { ...n, desconto_pct: valor, desconto_rs: String(descontoUnitarioDe(precoVenda, pct)) };
      }
      if (campo === 'preco_unitario') {
        const preco = parseMoneyInput(valor) ?? 0;
        const pct = normalizarPctVenda(Number(n.desconto_pct) || 0);
        return { ...n, preco_unitario: valor, desconto_rs: String(descontoUnitarioDe(preco, pct)) };
      }
      const rs = parseMoneyInput(valor) ?? 0;
      const pct = pctDeDescontoUnitario(precoVenda, rs);
      return { ...n, desconto_rs: valor, desconto_pct: String(pct) };
    });
  }

  // Opções de tamanho do item novo: prioriza a grade real do produto selecionado
  const opcoesTamanhoItemNovo = useMemo(() => {
    if (tamanhosDoProduto.length > 0) {
      return tamanhosDoProduto
        .filter((t) => t.tamanho_id != null)
        .map((t) => ({
          value: Number(t.tamanho_id),
          label: t.tamanho,
          quantidade: t.quantidade,
        }));
    }
    return tamanhoOpts.map((o) => ({ value: Number(o.value), label: o.label, quantidade: undefined as number | undefined }));
  }, [tamanhoOpts, tamanhosDoProduto]);

  // Busca a disponibilidade canônica sempre que produto/tamanho/local mudam.
  // `requiresStock` e o aviso de quantidade passam a ler o mesmo contrato do
  // faturamento — nenhuma soma de estoque acontece no navegador.
  useEffect(() => {
    if (!novo.produto_id || !novo.tamanho_id) {
      setDisponibilidade(null);
      return;
    }
    let vivo = true;
    const params = new URLSearchParams({
      produto_id: String(novo.produto_id),
      tamanho_id: String(novo.tamanho_id),
    });
    if (localSaidaId) params.set('local_id', String(localSaidaId));
    api
      .get<{ quantidade: number; local: string | null; estoque_fisico: number; tamanho_id: number | null }>(
        `/estoques/disponivel?${params.toString()}`
      )
      .then((r) => {
        if (vivo) setDisponibilidade(r);
      })
      .catch(() => {
        if (vivo) setDisponibilidade(null);
      });
    return () => {
      vivo = false;
    };
  }, [novo.produto_id, novo.tamanho_id, localSaidaId]);

  const estoqueTamanhoSelecionado = useMemo(() => {
    if (
      disponibilidade &&
      Number.isFinite(Number(disponibilidade.quantidade)) &&
      Number(disponibilidade.tamanho_id ?? novo.tamanho_id) === Number(novo.tamanho_id)
    ) {
      return Number(disponibilidade.quantidade);
    }
    if (novo.tamanho_id && tamanhosDoProduto.length > 0) {
      const t = tamanhosDoProduto.find((x) => Number(x.tamanho_id) === Number(novo.tamanho_id));
      if (t) return Number(t.quantidade);
    }
    return selecaoProduto?.quantidade_disponivel ?? null;
  }, [disponibilidade, novo.tamanho_id, selecaoProduto, tamanhosDoProduto]);

  /** Local que a disponibilidade acima representa (o de saída da venda). */
  const localDisponibilidade = disponibilidade?.local || form.local_saida || localPadrao;

  // Inclusão de produto (em rascunho em `/vendas/novo`, ou direto via API quando pedido já existe)
  async function addItem() {
    setErroNovoItem('');
    if (!novo.produto_id) {
      const msg = 'Selecione o produto (por nome, SKU ou código de barras) antes de adicionar.';
      setErroNovoItem(msg);
      toast.error(msg);
      return;
    }
    if (!novo.tamanho_id) {
      const msg = 'Selecione explicitamente a variação e o tamanho (ex.: P, M, G, GG).';
      setErroNovoItem(msg);
      toast.error(msg);
      return;
    }
    const qtd = Number(novo.quantidade);
    if (!Number.isInteger(qtd) || qtd < 1) {
      const msg = 'Informe uma quantidade inteira maior ou igual a 1.';
      setErroNovoItem(msg);
      toast.error(msg);
      return;
    }
    const preco = parsePrecoUnitario(novo.preco_unitario);
    if (!Number.isFinite(preco) || preco < 0) {
      const msg = 'Informe um preço de venda válido.';
      setErroNovoItem(msg);
      toast.error(msg);
      return;
    }
    const descPct = normalizarPctVenda(Number(novo.desconto_pct || 0));
    // O backend recebe o PREÇO DE VENDA (base do desconto) e o desconto %.
    // O preço de tabela só é enviado por quem tem autorização — e só vale como
    // referência, nunca como base de cálculo.
    const tabela = parsePrecoUnitario(novo.preco_tabela) || 0;

    // Se ainda estamos montando uma nova venda sem ID persistido no banco: adiciona ao rascunho local
    if (!vendaIdAtiva) {
      const tamLabel =
        opcoesTamanhoItemNovo.find((o) => Number(o.value) === Number(novo.tamanho_id))?.label ||
        selecaoProduto?.tamanho ||
        `#${novo.tamanho_id}`;
      const sub = linhaDePreco(qtd, preco, descPct).subtotal;
      const tempId = --rascunhoSeq.current;
      const alvoProd = selecaoProduto?.variacao ?? selecaoProduto?.produto ?? null;
      const itemRascunho: Item = {
        id: tempId,
        produto_id: Number(novo.produto_id),
        tamanho_id: Number(novo.tamanho_id),
        quantidade: qtd,
        preco_unitario: preco,
        desconto_pct: descPct,
        subtotal: sub,
        preco_tabela: tabela > 0 ? tabela : preco,
        produto_id__label:
          novo.produto_id__label ||
          (selecaoProduto && alvoProd ? `${selecaoProduto.sku} — ${alvoProd.nome}` : `Produto #${novo.produto_id}`),
        tamanho_id__label: tamLabel,
        sku: selecaoProduto?.sku ?? null,
        cor: alvoProd?.cor ?? null,
        codigo_barras: alvoProd?.codigo_barras ?? null,
        estoque_disponivel: estoqueTamanhoSelecionado,
        persistido: false,
      };
      setItens((atuais) => [...atuais, itemRascunho]);
      setNovo(blankItem);
      setSelecaoProduto(null);
      setTamanhosDoProduto([]);
      setErros((ant) => {
        if (!ant.itens) return ant;
        const c = { ...ant };
        delete c.itens;
        return c;
      });
      return;
    }

    // Pedido já existente: persiste imediatamente via contrato canônico `POST /vendas/:id/itens`
    setBusyItem('new');
    try {
      const payloadItem: Record<string, unknown> = {
        produto_id: Number(novo.produto_id),
        tamanho_id: Number(novo.tamanho_id),
        quantidade: qtd,
        preco_unitario: preco,
        desconto_pct: descPct,
      };
      // Só quem tem autorização envia o preço de tabela; o servidor valida de novo.
      if (podeEditarTabela && tabela > 0) payloadItem.preco_tabela = tabela;
      await api.post(`/vendas/${vendaIdAtiva}/itens`, payloadItem);
      toast.success('Item adicionado ao pedido.');
      setNovo(blankItem);
      setSelecaoProduto(null);
      setTamanhosDoProduto([]);
      await recarregarPedido(vendaIdAtiva, false);
    } catch (e: any) {
      const msg = e?.message || 'Não foi possível adicionar o item.';
      setErroNovoItem(msg);
      toast.error(msg);
    } finally {
      setBusyItem(null);
    }
  }

  async function salvarEdicaoItem(item: Item) {
    const qtd = Number(itemEditDraft.quantidade);
    const precoVenda = parsePrecoUnitario(itemEditDraft.preco_unitario);
    const desc = normalizarPctVenda(Number(itemEditDraft.desconto_pct || 0));
    if (!Number.isInteger(qtd) || qtd < 1) return toast.error('A quantidade deve ser um inteiro maior ou igual a 1.');
    if (!Number.isFinite(precoVenda) || precoVenda < 0) return toast.error('Preço de venda inválido.');
    if (desc < 0 || desc > 100) return toast.error('Desconto deve ficar entre 0% e 100%.');

    // O servidor recebe o PREÇO DE VENDA (base do desconto) e o desconto %. O
    // preço de tabela é referência: só é enviado por quem tem autorização.
    const tabela = parsePrecoUnitario(itemEditDraft.preco_tabela) || 0;

    if (!item.persistido || !vendaIdAtiva) {
      setItens((atuais) =>
        atuais.map((it) =>
          it.id === item.id
            ? {
                ...it,
                quantidade: qtd,
                preco_unitario: precoVenda,
                desconto_pct: desc,
                subtotal: linhaDePreco(qtd, precoVenda, desc).subtotal,
                preco_tabela: tabela > 0 ? tabela : precoVenda,
              }
            : it
        )
      );
      setItemEditandoId(null);
      return;
    }

    setBusyItem(item.id);
    try {
      const payloadItem: Record<string, unknown> = {
        produto_id: Number(item.produto_id),
        tamanho_id: Number(item.tamanho_id),
        quantidade: qtd,
        preco_unitario: precoVenda,
        desconto_pct: desc,
      };
      if (podeEditarTabela && tabela > 0) payloadItem.preco_tabela = tabela;
      await api.put(`/vendas/${vendaIdAtiva}/itens/${item.id}`, payloadItem);
      toast.success('Item atualizado.');
      setItemEditandoId(null);
      await recarregarPedido(vendaIdAtiva, false);
    } catch (e: any) {
      toast.error(e?.message || 'Não foi possível atualizar o item.');
    } finally {
      setBusyItem(null);
    }
  }

  async function removeItem() {
    if (!toDelete) return;
    if (!toDelete.persistido || !vendaIdAtiva) {
      setItens((atuais) => atuais.filter((i) => i.id !== toDelete.id));
      setToDelete(null);
      return;
    }
    setBusyItem(toDelete.id);
    try {
      await api.del(`/vendas/${vendaIdAtiva}/itens/${toDelete.id}`);
      toast.success('Item removido.');
      setToDelete(null);
      await recarregarPedido(vendaIdAtiva, false);
    } catch (e: any) {
      toast.error(e?.message || 'Não foi possível remover o item.');
    } finally {
      setBusyItem(null);
    }
  }

  // Validação completa do formulário antes de salvar ou finalizar
  function validarEConstruirPayload(finalizar: boolean): { ok: true; payload: Record<string, unknown> } | { ok: false } {
    const novosErros: Record<string, string> = {};

    if (!form.cliente_id) {
      novosErros.cliente_id =
        form.modoPessoa === 'pf'
          ? 'Selecione um cliente Pessoa Física (CPF) antes de salvar a venda.'
          : 'Selecione um cliente Pessoa Jurídica (CNPJ) antes de salvar a venda.';
    }

    const dataIso = parseDataBR(form.dataBr);
    if (!dataIso) {
      novosErros.dataBr = 'Informe uma data válida no formato dd/mm/aaaa.';
    }

    let previsaoIso: string | null = null;
    if (form.previsao_entrega_br.trim()) {
      const p = parseDataBR(form.previsao_entrega_br);
      if (!p) novosErros.previsao_entrega_br = 'Previsão de entrega inválida. Use dd/mm/aaaa.';
      else previsaoIso = p;
    }

    let vencimentoIso: string | null = null;
    if (form.fin_vencimento_br.trim()) {
      const v = parseDataBR(form.fin_vencimento_br);
      if (!v) novosErros.fin_vencimento_br = 'Vencimento inválido. Use dd/mm/aaaa.';
      else vencimentoIso = v;
    }

    let recebidoIso: string | null = null;
    if (form.fin_recebido_em_br.trim()) {
      const r = parseDataBR(form.fin_recebido_em_br);
      if (!r) novosErros.fin_recebido_em_br = 'Data de recebimento inválida. Use dd/mm/aaaa.';
      else recebidoIso = r;
    }

    const descNum = parseMoneyInput(form.desconto_texto) ?? 0;
    if (!Number.isFinite(descNum) || descNum < 0) {
      novosErros.desconto_texto = 'Informe um valor de desconto válido (>= R$ 0,00).';
    }

    const freteNum = parseMoneyInput(form.frete_texto) ?? 0;
    if (!Number.isFinite(freteNum) || freteNum < 0) {
      novosErros.frete_texto = 'Informe um valor de frete válido (>= R$ 0,00).';
    }

    const parcelasInt = Number(form.fin_parcelas);
    if (!Number.isInteger(parcelasInt) || parcelasInt < 1 || parcelasInt > 60) {
      novosErros.fin_parcelas = 'Informe entre 1 e 60 parcelas.';
    } else if (finalizar && totalCalculado > 0 && Math.round(totalCalculado * 100) < parcelasInt) {
      novosErros.fin_parcelas = 'O valor total da venda é menor que a quantidade de parcelas informada.';
    }

    if (finalizar && itens.length === 0) {
      novosErros.itens = 'Adicione ao menos um produto antes de finalizar/faturar a venda.';
    }

    if (Object.keys(novosErros).length > 0) {
      setErros(novosErros);
      setErroGeral('Confira os campos destacados antes de prosseguir. Nenhum dado digitado foi perdido.');
      window.setTimeout(() => resumoErrosRef.current?.focus(), 0);
      return { ok: false };
    }

    setErros({});
    setErroGeral('');

    const payload: Record<string, unknown> = {
      data: dataIso,
      canal_venda: form.canal_venda || 'balcao',
      representante_id: form.representante_id ? Number(form.representante_id) : null,
      condicao_pagamento: form.condicao_pagamento.trim() || null,
      fin_status: form.fin_status || 'a_receber',
      fin_forma_pagamento: form.fin_forma_pagamento || null,
      fin_parcelas: parcelasInt,
      fin_vencimento: vencimentoIso,
      fin_recebido_em: recebidoIso,
      fin_documento: form.fin_documento.trim() || null,
      observacoes: form.observacoes.trim() || null,
    };

    // Conta financeira: só envia se o usuário puder gerir ou se já veio preenchida; preserva a existente para operador.
    if (podeGerirFinanceiro) {
      payload.fin_conta_id = form.fin_conta_id ? Number(form.fin_conta_id) : null;
    } else if (form.fin_conta_id) {
      payload.fin_conta_id = Number(form.fin_conta_id);
    }

    // Campos comerciais editáveis enquanto o pedido não está faturado/entregue
    if (!fechado) {
      payload.cliente_id = Number(form.cliente_id);
      payload.local_saida = form.local_saida.trim() || localPadrao;
      payload.pedido_cliente = form.pedido_cliente.trim() || null;
      payload.previsao_entrega = previsaoIso;
      payload.desconto = arredondar2(descNum);
      payload.frete = arredondar2(freteNum);
    }

    return { ok: true, payload };
  }

  // Salvar pedido (aberta/cotação ou alterações de cabeçalho) OU Finalizar/Faturar venda
  async function submeterVenda(finalizar: boolean) {
    const validacao = validarEConstruirPayload(finalizar);
    if (!validacao.ok) return;

    setSalvando(finalizar ? 'finalizar' : 'salvar');
    setErroGeral('');

    try {
      let idAlvo = vendaIdAtiva;

      // Etapa 1: cria ou atualiza o cabeçalho do pedido
      if (!idAlvo) {
        const statusCriacao = finalizar ? 'aberta' : form.statusInicial;
        const criada = await api.post<Record<string, any>>('/vendas', {
          ...validacao.payload,
          status: statusCriacao,
        });
        idAlvo = Number(criada.id);
        setVendaCriadaId(idAlvo);
        setPedido(criada);
      } else {
        const atualizada = await api.put<Record<string, any>>(`/vendas/${idAlvo}`, validacao.payload);
        setPedido(atualizada);
      }

      // Etapa 2: grava quaisquer itens em rascunho ainda não persistidos (marcando um a um para evitar duplicação em retry)
      const pendentes = itens.filter((it) => !it.persistido);
      for (const item of pendentes) {
        const gravado = await api.post<Record<string, any>>(`/vendas/${idAlvo}/itens`, {
          produto_id: Number(item.produto_id),
          tamanho_id: Number(item.tamanho_id),
          quantidade: Number(item.quantidade),
          preco_unitario: parsePrecoUnitario(item.preco_unitario),
          desconto_pct: Number(item.desconto_pct || 0),
        });
        setItens((atuais) =>
          atuais.map((x) =>
            x.id === item.id
              ? { ...x, id: Number(gravado?.id || x.id), persistido: true }
              : x
          )
        );
      }

      // Etapa 3: se o operador clicou em Finalizar/Faturar, transiciona `status: 'faturada'`
      if (finalizar) {
        const faturada = await api.put<Record<string, any>>(`/vendas/${idAlvo}`, { status: 'faturada' });
        setPedido(faturada);
        setSujo(false);
        if (String(faturada?.status) === 'pendente_aprovacao') {
          toast.info('Pedido enviado para aprovação gerencial conforme política comercial.');
        } else {
          toast.success('Venda finalizada e faturada com sucesso.');
        }
        if (ehRotaNovo || ehRotaEditar) {
          navigate(`/vendas/${idAlvo}`);
        } else {
          await recarregarPedido(idAlvo, true);
        }
        return;
      }

      setSujo(false);
      toast.success(ehRotaNovo ? 'Pedido de venda criado com sucesso.' : 'Alterações da venda salvas.');
      if (ehRotaNovo || ehRotaEditar) {
        navigate(`/vendas/${idAlvo}`);
      } else {
        await recarregarPedido(idAlvo, true);
      }
    } catch (e: any) {
      const msg = e?.message || 'Não foi possível concluir a operação. Seus dados foram preservados.';
      setErroGeral(msg);
      toast.error(msg);
    } finally {
      setSalvando(null);
    }
  }

  async function alterarStatusDireto(novoStatus: 'entregue' | 'cancelada') {
    if (!vendaIdAtiva) return;
    setSalvando(novoStatus === 'cancelada' ? 'cancelar' : 'entregar');
    setErroGeral('');
    try {
      const atual = await api.put<Record<string, any>>(`/vendas/${vendaIdAtiva}`, { status: novoStatus });
      setPedido(atual);
      setConfirmarCancelamento(false);
      toast.success(novoStatus === 'cancelada' ? 'Pedido de venda cancelado.' : 'Pedido marcado como entregue.');
      await recarregarPedido(vendaIdAtiva, true);
    } catch (e: any) {
      const msg = e?.message || 'Não foi possível alterar o status do pedido.';
      setErroGeral(msg);
      toast.error(msg);
    } finally {
      setSalvando(null);
    }
  }

  if (loading) return <Spinner label="Carregando venda..." />;

  if (loadError) {
    return (
      <div className="p-4 sm:p-6">
        <Alert tone="red">{loadError}</Alert>
        <button type="button" className="btn-secondary mt-4" onClick={() => navigate('/vendas')}>
          <ArrowLeft className="h-4 w-4" /> Voltar para Vendas
        </button>
      </div>
    );
  }

  if (!ehRotaNovo && !pedido) return null;

  const tituloPagina = ehRotaNovo
    ? vendaCriadaId
      ? `Nova venda #${vendaCriadaId}`
      : 'Nova venda'
    : ehRotaEditar
      ? `Editar pedido de venda #${pedido?.id}`
      : `Pedido de venda #${pedido?.id}`;

  const listaErrosResumo = Object.values(erros);

  return (
    <div className="mx-auto max-w-6xl space-y-5 p-4 sm:p-6">
      <PageHeader
        title={
          <span className="flex flex-wrap items-center gap-2.5">
            <button
              type="button"
              className="btn-icon"
              onClick={() => navigate(ehRotaEditar && vendaIdAtiva ? `/vendas/${vendaIdAtiva}` : '/vendas')}
              title="Voltar"
              aria-label="Voltar"
            >
              <ArrowLeft className="h-4 w-4" />
            </button>
            <span>{tituloPagina}</span>
            <Badge tone={STATUS_TONE[statusAtual] || 'slate'}>
              {ehRotaNovo && !vendaCriadaId
                ? `Nova (${STATUS_VENDA_LABEL[form.statusInicial] || 'Aberta'})`
                : STATUS_VENDA_LABEL[statusAtual] || statusAtual}
            </Badge>
            <Badge tone={form.modoPessoa === 'pj' ? 'blue' : 'amber'}>
              {form.modoPessoa === 'pj' ? 'PJ · CNPJ' : 'PF · CPF'}
            </Badge>
          </span>
        }
        description={
          ehRotaNovo
            ? 'Fluxo completo de venda Pessoa Física (CPF) ou Pessoa Jurídica (CNPJ), produtos por variação/tamanho, financeiro e fiscal.'
            : 'Gestão completa do pedido de venda, itens, condições financeiras e emissão fiscal.'
        }
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              className="btn-secondary"
              onClick={() => navigate('/vendas')}
            >
              <ArrowLeft className="h-4 w-4" />
              Lista de vendas
            </button>

            {vendaIdAtiva && (
              <>
                <DocumentPrintButton tipo="vendas" documentoId={Number(vendaIdAtiva)} label="Fila de impressão" />
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => window.open(`/api/vendas/${vendaIdAtiva}/pdf`, '_blank')}
                >
                  <Printer className="h-4 w-4" />
                  Imprimir PDF
                </button>
              </>
            )}

            {!ehRotaNovo && !ehRotaEditar && !cancelado && vendaIdAtiva && (
              <button
                type="button"
                className="btn-secondary"
                onClick={() => navigate(`/vendas/${vendaIdAtiva}/editar`)}
              >
                <Edit3 className="h-4 w-4" />
                Editar pedido
              </button>
            )}

            {!cancelado && (
              <button
                type="button"
                className="btn-secondary"
                disabled={!!salvando}
                onClick={() => void submeterVenda(false)}
              >
                {salvando === 'salvar' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                {ehRotaNovo && !vendaCriadaId ? 'Salvar pedido' : 'Salvar alterações'}
              </button>
            )}

            {!fechado && !cancelado && (
              <button
                type="button"
                className="btn-primary"
                disabled={!!salvando}
                onClick={() => void submeterVenda(true)}
              >
                {salvando === 'finalizar' ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <CheckCircle2 className="h-4 w-4" />
                )}
                {ehRotaNovo ? 'Finalizar venda' : 'Faturar pedido'}
              </button>
            )}

            {statusAtual === 'faturada' && vendaIdAtiva && (
              <button
                type="button"
                className="btn-primary"
                disabled={!!salvando}
                onClick={() => void alterarStatusDireto('entregue')}
              >
                {salvando === 'entregar' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Truck className="h-4 w-4" />}
                Marcar entregue
              </button>
            )}

            {!ehRotaNovo && !cancelado && vendaIdAtiva && (
              <button
                type="button"
                className="btn-secondary text-red-600"
                disabled={!!salvando}
                onClick={() => setConfirmarCancelamento(true)}
              >
                {salvando === 'cancelar' ? <Loader2 className="h-4 w-4 animate-spin" /> : <X className="h-4 w-4" />}
                Cancelar pedido
              </button>
            )}
          </div>
        }
      />

      {/* Alertas de ciclo de vida e erros preservando dados digitados */}
      {(erroGeral || listaErrosResumo.length > 0) && (
        <div
          ref={resumoErrosRef}
          tabIndex={-1}
          role="alert"
          aria-live="assertive"
          className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800 focus:outline-none focus:ring-2 focus:ring-red-400 dark:border-red-800/60 dark:bg-red-950/30 dark:text-red-300"
        >
          <div className="flex items-start gap-2.5">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-red-600" aria-hidden="true" />
            <div className="min-w-0 flex-1">
              <p className="font-semibold">{erroGeral || 'Verifique os campos obrigatórios antes de continuar.'}</p>
              {listaErrosResumo.length > 0 && (
                <ul className="mt-1 list-disc space-y-0.5 pl-5 text-xs">
                  {listaErrosResumo.map((msg, i) => (
                    <li key={i}>{msg}</li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </div>
      )}

      {statusAtual === 'pendente_aprovacao' && (
        <Alert tone="amber">
          Este pedido aguarda aprovação comercial gerencial antes de concluir o faturamento e a baixa de estoque.
        </Alert>
      )}

      {fechado && (
        <Alert tone="green">
          Pedido {statusAtual === 'entregue' ? 'entregue' : 'faturado'}
          {pedido?.faturada_em ? ` em ${formatDate(pedido.faturada_em)}` : ''}: as peças já saíram do estoque
          {pedido?.comissao_valor ? ` e a comissão do representante (${formatMoney(pedido.comissao_valor)}) foi registrada` : ''}.
          Os itens e o cliente estão bloqueados para preservar a integridade de estoque e fiscal.
        </Alert>
      )}

      {cancelado && (
        <Alert tone="red">
          Este pedido de venda está cancelado. Os movimentos de estoque e lançamentos financeiros vinculados foram estornados e o registro permanece somente para consulta.
        </Alert>
      )}

      {/* 1. IDENTIFICAÇÃO DA VENDA */}
      <SecaoVenda
        etapa={1}
        titulo="Identificação da Venda"
        subtitulo="Defina a modalidade do cliente (CPF ou CNPJ), data, canal comercial, representante e local de saída de estoque."
      >
        <div className="space-y-4">
          <SeletorModoPessoa
            valor={form.modoPessoa}
            disabled={itensBloqueados || !!salvando}
            onChange={(novoModo) => {
              setCampo('modoPessoa', novoModo);
              if (clienteObj && inferirModoPessoaCliente(clienteObj) !== novoModo) {
                setClienteObj(null);
                setCampo('cliente_id', null);
              }
            }}
          />

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <CampoDataVenda
              id="venda-data"
              rotulo="Data da venda"
              obrigatorio
              mostrarAtalhoHoje
              disabled={itensBloqueados || !!salvando}
              valorBr={form.dataBr}
              erro={erros.dataBr}
              onChangeBr={(v) => setCampo('dataBr', v)}
            />

            <div>
              <label htmlFor="venda-canal" className="label">
                Canal de venda
              </label>
              <select
                id="venda-canal"
                className="input w-full"
                disabled={itensBloqueados || !!salvando}
                value={form.canal_venda}
                onChange={(e) => setCampo('canal_venda', e.target.value)}
              >
                {CANAL_VENDA_OPCOES.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </div>

            {ehRotaNovo && !vendaCriadaId ? (
              <div>
                <label htmlFor="venda-status-inicial" className="label">
                  Situação ao salvar
                </label>
                <select
                  id="venda-status-inicial"
                  className="input w-full"
                  disabled={!!salvando}
                  value={form.statusInicial}
                  onChange={(e) => setCampo('statusInicial', e.target.value === 'cotacao' ? 'cotacao' : 'aberta')}
                >
                  <option value="aberta">Aberta (pedido ativo)</option>
                  <option value="cotacao">Cotação / Orçamento</option>
                </select>
              </div>
            ) : (
              <div>
                <label htmlFor="venda-representante" className="label">
                  Representante / Vendedor
                </label>
                <select
                  id="venda-representante"
                  className="input w-full"
                  disabled={cancelado || !!salvando}
                  value={form.representante_id}
                  onChange={(e) => setCampo('representante_id', e.target.value)}
                >
                  <option value="">— Nenhum —</option>
                  {repOpts.map((o) => (
                    <option key={o.value} value={String(o.value)}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </div>
            )}

            <div>
              <label htmlFor="venda-local-saida" className="label">
                Local de saída do estoque
              </label>
              {locaisAtivos.length > 0 ? (
                <select
                  id="venda-local-saida"
                  className="input w-full"
                  disabled={itensBloqueados || !!salvando}
                  value={form.local_saida}
                  onChange={(e) => setCampo('local_saida', e.target.value)}
                >
                  {!locaisAtivos.some((l) => l.nome === form.local_saida) && form.local_saida && (
                    <option value={form.local_saida}>{form.local_saida}</option>
                  )}
                  {locaisAtivos.map((l) => (
                    <option key={l.id} value={l.nome}>
                      {l.nome}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  id="venda-local-saida"
                  type="text"
                  className="input w-full"
                  disabled={itensBloqueados || !!salvando}
                  value={form.local_saida}
                  placeholder={localPadrao}
                  onChange={(e) => setCampo('local_saida', e.target.value)}
                />
              )}
            </div>

            {ehRotaNovo && !vendaCriadaId && (
              <div>
                <label htmlFor="venda-representante" className="label">
                  Representante / Vendedor
                </label>
                <select
                  id="venda-representante"
                  className="input w-full"
                  disabled={!!salvando}
                  value={form.representante_id}
                  onChange={(e) => setCampo('representante_id', e.target.value)}
                >
                  <option value="">— Nenhum —</option>
                  {repOpts.map((o) => (
                    <option key={o.value} value={String(o.value)}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </div>
            )}

            <div>
              <label htmlFor="venda-pedido-cliente" className="label">
                Nº pedido no cliente
              </label>
              <input
                id="venda-pedido-cliente"
                type="text"
                maxLength={60}
                className="input w-full"
                placeholder="Ordem de compra / referência"
                disabled={itensBloqueados || !!salvando}
                value={form.pedido_cliente}
                onChange={(e) => setCampo('pedido_cliente', e.target.value)}
              />
            </div>
          </div>
        </div>
      </SecaoVenda>

      {/* 2. CLIENTE (PF ou PJ — ANTES DOS PRODUTOS) */}
      <SecaoVenda
        etapa={2}
        titulo={form.modoPessoa === 'pf' ? 'Cliente — Pessoa Física (CPF)' : 'Cliente — Pessoa Jurídica (CNPJ)'}
        subtitulo={
          form.modoPessoa === 'pf'
            ? 'Pesquise por nome completo, CPF (com ou sem máscara) ou telefone para vincular um cadastro existente.'
            : 'Pesquise por CNPJ (com ou sem máscara), razão social ou nome fantasia respeitando a empresa ativa.'
        }
      >
        <ClienteVendaSelector
          modo={form.modoPessoa}
          onAlternarModo={(m) => setCampo('modoPessoa', m)}
          cliente={clienteObj}
          clienteLabelFallback={!clienteObj && form.cliente_id ? String(pedido?.cliente_id__label || `Cliente #${form.cliente_id}`) : null}
          disabled={itensBloqueados || !!salvando}
          erro={erros.cliente_id}
          onNavigate={(rota) => navigate(rota)}
          onSelecionar={(escolhido) => {
            setClienteObj(escolhido);
            setCampo('cliente_id', escolhido ? Number(escolhido.id) : null);
            if (escolhido) {
              const modoDet = inferirModoPessoaCliente(escolhido);
              if (modoDet !== form.modoPessoa) setCampo('modoPessoa', modoDet);
              if (escolhido.representante_id && !form.representante_id) {
                setCampo('representante_id', String(escolhido.representante_id));
              }
            }
          }}
        />
      </SecaoVenda>

      {/* 3. PRODUTOS (Smart Product Search global, variações e tamanhos explícitos) */}
      <SecaoVenda
        etapa={3}
        titulo={`Produtos da Venda (${itens.length})`}
        subtitulo="Busque por nome, SKU ou código de barras. Produtos com variações ou grade exigem escolha explícita de variação e tamanho."
        direita={
          <Badge tone={itens.length > 0 ? 'green' : 'slate'}>
            {totalPecas} {totalPecas === 1 ? 'peça' : 'peças'} · {formatMoney(subtotalItens)}
          </Badge>
        }
      >
        {erros.itens && (
          <div className="mb-3">
            <Alert tone="red">{erros.itens}</Alert>
          </div>
        )}

        {!itensBloqueados && (
          <div className="mb-4 rounded-xl border border-slate-200 bg-navy-50/35 p-4 dark:border-navy-700 dark:bg-navy-800/40">
            <div className="grid grid-cols-1 gap-3 md:grid-cols-12 md:items-end">
              <div className="md:col-span-5">
                <label htmlFor="venda-busca-produto" className="label">
                  Produto / Variação / Código de barras <span className="text-red-500">*</span>
                </label>
                <ProductSelector
                  id="venda-busca-produto"
                  value={novo.produto_id}
                  aria-label="Buscar produto da venda"
                  placeholder="Nome, SKU ou código de barras..."
                  selectParentsWithVariants={false}
                  requiresStock={true}
                  inStockFirst={true}
                  localId={localSaidaId}
                  onSelect={(product, selection) => {
                    // Garante que jamais um produto pai ambíguo seja aceito na venda.
                    if (requiresExplicitChoice(product) && !selection.tamanho_id) {
                      return false;
                    }
                    return true;
                  }}
                  onSubmit={async (termo) => {
                    const codigo = termo.trim().toLowerCase();
                    if (!codigo) return false;
                    const resp = await searchProducts(termo.trim(), {
                      pageSize: 5,
                      inStockFirst: true,
                      localId: localSaidaId,
                    });
                    for (const fam of resp.rows || []) {
                      const variacoes = fam.variacoes || [];
                      const varExata = variacoes.find(
                        (v) =>
                          String(v.codigo_barras || '').toLowerCase() === codigo ||
                          String(v.sku || '').toLowerCase() === codigo
                      );
                      if (varExata) {
                        if (varExata.tamanhos.length === 1 && Number(varExata.tamanhos[0].quantidade) > 0) {
                          const sel = buildProductSelection(varExata, varExata.tamanhos[0], fam);
                          setSelecaoProduto(sel);
                          setTamanhosDoProduto(
                            varExata.tamanhos
                              .filter((t) => t.tamanho_id != null)
                              .map((t) => ({
                                tamanho_id: Number(t.tamanho_id),
                                tamanho: t.tamanho,
                                quantidade: Number(t.quantidade || 0),
                              }))
                          );
                          setNovo((n) => ({
                            ...n,
                            produto_id: sel.produto_id,
                            tamanho_id: sel.tamanho_id ?? undefined,
                            preco_unitario: sel.preco,
                            preco_tabela: sel.preco,
                            desconto_pct: 0,
                            produto_id__label: `${sel.sku} — ${varExata.nome}`,
                          }));
                          setErroNovoItem('');
                          return true;
                        }
                        setErroNovoItem('Escolha o tamanho disponível da variação na lista.');
                        return false;
                      }
                      const paiExato =
                        variacoes.length === 0 &&
                        (String(fam.codigo_barras || '').toLowerCase() === codigo ||
                          String(fam.sku || '').toLowerCase() === codigo);
                      if (paiExato) {
                        if (requiresExplicitChoice(fam)) {
                          setErroNovoItem(`Escolha explicitamente o tamanho de ${fam.nome} na lista antes de adicionar.`);
                          return false;
                        }
                        if (fam.tamanhos.length === 1 && Number(fam.tamanhos[0].quantidade) > 0) {
                          const sel = buildProductSelection(fam, fam.tamanhos[0], null);
                          setSelecaoProduto(sel);
                          setTamanhosDoProduto([
                            {
                              tamanho_id: Number(fam.tamanhos[0].tamanho_id),
                              tamanho: fam.tamanhos[0].tamanho,
                              quantidade: Number(fam.tamanhos[0].quantidade || 0),
                            },
                          ]);
                          setNovo((n) => ({
                            ...n,
                            produto_id: sel.produto_id,
                            tamanho_id: sel.tamanho_id ?? undefined,
                            preco_unitario: sel.preco,
                            preco_tabela: sel.preco,
                            desconto_pct: 0,
                            produto_id__label: `${sel.sku} — ${fam.nome}`,
                          }));
                          setErroNovoItem('');
                          return true;
                        }
                      }
                    }
                    return false;
                  }}
                  onChange={(_id, product, selection) => {
                    setErroNovoItem('');
                    if (!product) {
                      setSelecaoProduto(null);
                      setTamanhosDoProduto([]);
                      setNovo((n) => ({ ...n, produto_id: undefined, tamanho_id: undefined, produto_id__label: undefined, preco_tabela: '', desconto_pct: 0 }));
                      return;
                    }
                    setSelecaoProduto(selection ?? null);
                    setTamanhosDoProduto(
                      Array.isArray(product.tamanhos)
                        ? product.tamanhos
                            .filter((t) => t.tamanho_id != null)
                            .map((t) => ({
                              tamanho_id: Number(t.tamanho_id),
                              tamanho: t.tamanho,
                              quantidade: Number(t.quantidade || 0),
                            }))
                        : []
                    );
                    const tamanho =
                      selection?.tamanho_id ??
                      product.variacao_tamanho_id ??
                      (product.tamanhos.length === 1 ? product.tamanhos[0].tamanho_id : null);
                    const alvoProd = selection?.variacao ?? selection?.produto ?? product;
                    const precoTabela = selection?.preco ?? product.preco_venda;
                    setNovo((n) => ({
                      ...n,
                      produto_id: selection?.produto_id ?? product.produto_pai_id ?? product.id,
                      tamanho_id: tamanho ?? undefined,
                      preco_unitario: precoTabela,
                      preco_tabela: precoTabela,
                      desconto_pct: 0,
                      produto_id__label: `${selection?.sku ?? product.sku} — ${alvoProd.nome}`,
                    }));
                  }}
                />
              </div>

              <div className="md:col-span-2">
                <label htmlFor="venda-novo-tamanho" className="label">
                  Tamanho <span className="text-red-500">*</span>
                </label>
                <select
                  id="venda-novo-tamanho"
                  className="input w-full"
                  value={novo.tamanho_id ?? ''}
                  onChange={(e) => {
                    setErroNovoItem('');
                    setNovo((n) => ({ ...n, tamanho_id: e.target.value ? Number(e.target.value) : undefined }));
                  }}
                >
                  <option value="">Tam.</option>
                  {opcoesTamanhoItemNovo.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </div>

              <div className="md:col-span-1">
                <label htmlFor="venda-novo-qtd" className="label">
                  Qtd. <span className="text-red-500">*</span>
                </label>
                <input
                  id="venda-novo-qtd"
                  type="number"
                  min={1}
                  step={1}
                  className="input w-full text-right tabular-nums"
                  value={novo.quantidade}
                  onChange={(e) => setNovo((n) => ({ ...n, quantidade: e.target.value }))}
                />
              </div>

              <div className="md:col-span-1">
                <label htmlFor="venda-novo-preco-tabela" className="label">
                  Preço tabela
                </label>
                {podeEditarTabela ? (
                  <input
                    id="venda-novo-preco-tabela"
                    type="text"
                    inputMode="decimal"
                    aria-label="Preço de tabela"
                    title="Preço de tabela da precificação (referência — não é a base do desconto)"
                    className="input w-full text-right tabular-nums"
                    value={novo.preco_tabela ?? ''}
                    onChange={(e) => atualizarNovoPreco('preco_tabela', e.target.value)}
                  />
                ) : (
                  <input
                    id="venda-novo-preco-tabela"
                    type="text"
                    readOnly
                    aria-readonly="true"
                    title="Preço de tabela da precificação (somente quem tem autorização altera)"
                    className="input w-full cursor-not-allowed bg-slate-100 text-right tabular-nums text-slate-500 dark:bg-navy-800/70 dark:text-navy-300"
                    value={novo.preco_tabela ? formatMoney(parsePrecoUnitario(novo.preco_tabela) || 0) : '—'}
                  />
                )}
              </div>

              <div className="md:col-span-1">
                <label htmlFor="venda-novo-preco" className="label">
                  Preço venda (R$) <span className="text-red-500">*</span>
                </label>
                <input
                  id="venda-novo-preco"
                  type="text"
                  inputMode="decimal"
                  className="input w-full text-right tabular-nums"
                  placeholder="0,00"
                  value={novo.preco_unitario}
                  onChange={(e) => atualizarNovoPreco('preco_unitario', e.target.value)}
                />
              </div>

              <div className="md:col-span-1">
                <label htmlFor="venda-novo-desc" className="label">
                  Desc. %
                </label>
                <input
                  id="venda-novo-desc"
                  type="number"
                  min={0}
                  max={100}
                  step="0.01"
                  className="input w-full text-right tabular-nums"
                  value={novo.desconto_pct ?? 0}
                  onChange={(e) => atualizarNovoPreco('desconto_pct', e.target.value)}
                />
              </div>

              <div className="md:col-span-1">
                <label htmlFor="venda-novo-desc-rs" className="label">
                  Desc. R$
                </label>
                <input
                  id="venda-novo-desc-rs"
                  type="text"
                  inputMode="decimal"
                  className="input w-full text-right tabular-nums"
                  placeholder="0,00"
                  value={novo.desconto_rs ?? ''}
                  onChange={(e) => atualizarNovoPreco('desconto_rs', e.target.value)}
                />
              </div>

              <div className="md:col-span-2">
                <button
                  type="button"
                  className="btn-primary w-full justify-center"
                  disabled={busyItem === 'new'}
                  onClick={() => void addItem()}
                  title="Adicionar item"
                  aria-label="Adicionar item"
                >
                  {busyItem === 'new' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
                  <span className="md:sr-only">Adicionar item</span>
                </button>
              </div>
            </div>

            {/* Resumo instantâneo da variação/tamanho/saldo antes de incluir */}
            <div className="mt-2.5 flex flex-wrap items-center justify-between gap-2 text-xs text-slate-600 dark:text-navy-200">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                {selecaoProduto ? (
                  <>
                    <span className="font-mono font-semibold text-navy-900 dark:text-white">{selecaoProduto.sku}</span>
                    {(selecaoProduto.variacao?.cor ?? selecaoProduto.produto.cor) && (
                      <span>Cor: {selecaoProduto.variacao?.cor ?? selecaoProduto.produto.cor}</span>
                    )}
                    {(selecaoProduto.variacao?.codigo_barras ?? selecaoProduto.produto.codigo_barras) && (
                      <span className="font-mono">EAN: {selecaoProduto.variacao?.codigo_barras ?? selecaoProduto.produto.codigo_barras}</span>
                    )}
                    {estoqueTamanhoSelecionado !== null && (
                      <span
                        className={`font-semibold ${
                          Number(novo.quantidade) > estoqueTamanhoSelecionado
                            ? 'text-amber-700 dark:text-amber-300'
                            : 'text-emerald-700 dark:text-emerald-400'
                        }`}
                      >
                        Estoque disponível em {localDisponibilidade}: {formatNumber(estoqueTamanhoSelecionado)} un.
                        {Number(novo.quantidade) > estoqueTamanhoSelecionado ? ' (acima do saldo atual!)' : ''}
                        {disponibilidade && disponibilidade.estoque_fisico > disponibilidade.quantidade ? (
                          <span className="ml-1 font-normal text-slate-500">
                            (físico total: {formatNumber(disponibilidade.estoque_fisico)} un. em todos os locais)
                          </span>
                        ) : null}
                      </span>
                    )}
                  </>
                ) : (
                  <span className="text-slate-500">
                    Selecione um produto para visualizar SKU, cor, tamanho e saldo disponível no local de saída.
                  </span>
                )}
              </div>
              <span className="font-semibold tabular-nums text-navy-900 dark:text-white">
                Subtotal do item: {formatMoney(subtotalNovo())}
              </span>
            </div>

            {erroNovoItem && (
              <p role="alert" className="mt-2 text-xs font-medium text-red-600 dark:text-red-400">
                {erroNovoItem}
              </p>
            )}
          </div>
        )}

        {itens.length === 0 ? (
          <div className="rounded-xl border border-dashed border-slate-200 px-4 py-8 text-center text-sm text-slate-500 dark:border-navy-700 dark:text-navy-300">
            Nenhum produto adicionado ainda. Utilize a busca inteligente acima para incluir variações e tamanhos na venda.
          </div>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-slate-200 dark:border-navy-800">
            <table className="table min-w-[880px]">
              <thead>
                <tr>
                  <th className="w-12" />
                  <th>Produto / Variação</th>
                  <th className="w-24">Tamanho</th>
                  <th className="w-20 text-right">Qtd.</th>
                  <th className="w-28 text-right">Preço tabela</th>
                  <th className="w-28 text-right">Preço venda</th>
                  <th className="w-24 text-right">Desc. %</th>
                  <th className="w-24 text-right">Desc. R$</th>
                  <th className="w-28 text-right">Subtotal</th>
                  <th className="w-24 text-right">Ações</th>
                </tr>
              </thead>
              <tbody>
                {itens.map((it) => {
                  const emEdicao = itemEditandoId === it.id && !itensBloqueados;
                  const linha = linhasPreco.find((l) => l.item.id === it.id);
                  const tabela = linha?.tabela ?? (parsePrecoUnitario(it.preco_unitario) || 0);
                  const precoVenda = linha?.precoVenda ?? (parsePrecoUnitario(it.preco_unitario) || 0);
                  const descontoRs = linha?.descontoUnitario ?? 0;
                  const subLinha = linha?.subtotal ?? 0;
                  return (
                    <tr key={it.id}>
                      <td>
                        <Thumb src={it.produto_id__foto} alt="" />
                      </td>
                      <td>
                        <div className="font-medium text-slate-800 dark:text-slate-100">{it.produto_id__label}</div>
                        {(it.cor || it.codigo_barras || it.estoque_disponivel != null) && (
                          <div className="mt-0.5 flex flex-wrap gap-x-2 text-[11px] text-slate-500">
                            {it.cor && <span>{it.cor}</span>}
                            {it.codigo_barras && <span className="font-mono">EAN {it.codigo_barras}</span>}
                            {it.estoque_disponivel != null && <span>Saldo: {formatNumber(it.estoque_disponivel)} un.</span>}
                          </div>
                        )}
                      </td>
                      <td>
                        <span className="rounded bg-slate-100 px-2 py-0.5 font-mono text-xs font-semibold text-slate-700 dark:bg-navy-800 dark:text-slate-200">
                          {it.tamanho_id__label || `#${it.tamanho_id}`}
                        </span>
                      </td>
                      <td className="text-right tabular-nums">
                        {emEdicao ? (
                          <input
                            type="number"
                            min={1}
                            step={1}
                            aria-label={`Quantidade de ${it.produto_id__label}`}
                            className="input !py-1 text-right tabular-nums"
                            value={itemEditDraft.quantidade}
                            onChange={(e) => setItemEditDraft((d) => ({ ...d, quantidade: e.target.value }))}
                          />
                        ) : (
                          it.quantidade
                        )}
                      </td>
                      <td className="text-right tabular-nums text-slate-500 dark:text-navy-300">
                        {emEdicao && podeEditarTabela ? (
                          <input
                            type="text"
                            inputMode="decimal"
                            aria-label={`Preço de tabela de ${it.produto_id__label}`}
                            className="input !py-1 text-right tabular-nums"
                            value={itemEditDraft.preco_tabela}
                            onChange={(e) => atualizarDraftItem('preco_tabela', e.target.value)}
                          />
                        ) : (
                          <span title={podeEditarTabela ? undefined : 'Somente quem tem autorização altera o preço de tabela'}>
                            {formatMoney(tabela)}
                          </span>
                        )}
                      </td>
                      <td className="text-right tabular-nums">
                        {emEdicao ? (
                          <input
                            type="text"
                            inputMode="decimal"
                            aria-label={`Preço de venda de ${it.produto_id__label}`}
                            className="input !py-1 text-right tabular-nums"
                            value={itemEditDraft.preco_unitario}
                            onChange={(e) => atualizarDraftItem('preco_unitario', e.target.value)}
                          />
                        ) : (
                          formatMoney(precoVenda)
                        )}
                      </td>
                      <td className="text-right tabular-nums">
                        {emEdicao ? (
                          <input
                            type="number"
                            min={0}
                            max={100}
                            step="0.01"
                            aria-label={`Desconto percentual de ${it.produto_id__label}`}
                            className="input !py-1 text-right tabular-nums"
                            value={itemEditDraft.desconto_pct}
                            onChange={(e) => atualizarDraftItem('desconto_pct', e.target.value)}
                          />
                        ) : Number(it.desconto_pct || 0) ? (
                          `${formatNumber(it.desconto_pct)}%`
                        ) : (
                          '—'
                        )}
                      </td>
                      <td className="text-right tabular-nums">
                        {emEdicao ? (
                          <input
                            type="text"
                            inputMode="decimal"
                            aria-label={`Desconto em reais de ${it.produto_id__label}`}
                            className="input !py-1 text-right tabular-nums"
                            value={itemEditDraft.desconto_rs}
                            onChange={(e) => atualizarDraftItem('desconto_rs', e.target.value)}
                          />
                        ) : descontoRs ? (
                          formatMoney(descontoRs)
                        ) : (
                          '—'
                        )}
                      </td>
                      <td className="text-right font-semibold tabular-nums">{formatMoney(subLinha)}</td>
                      <td className="text-right">
                        {!itensBloqueados && (
                          <div className="inline-flex items-center justify-end gap-1">
                            {emEdicao ? (
                              <>
                                <button
                                  type="button"
                                  className="btn-icon text-emerald-700 hover:!bg-emerald-50"
                                  disabled={busyItem === it.id}
                                  onClick={() => void salvarEdicaoItem(it)}
                                  title="Confirmar edição do item"
                                  aria-label={`Salvar item ${it.produto_id__label}`}
                                >
                                  <Check className="h-4 w-4" />
                                </button>
                                <button
                                  type="button"
                                  className="btn-icon"
                                  onClick={() => setItemEditandoId(null)}
                                  title="Cancelar edição do item"
                                  aria-label="Cancelar edição do item"
                                >
                                  <X className="h-4 w-4" />
                                </button>
                              </>
                            ) : (
                              <>
                                <button
                                  type="button"
                                  className="btn-icon"
                                  disabled={busyItem === it.id}
                                  onClick={() => {
                                    setItemEditandoId(it.id);
                                    const tabelaAtual = linha?.tabela ?? (parsePrecoUnitario(it.preco_unitario) || 0);
                                    const precoVendaAtual = linha?.precoVenda ?? (parsePrecoUnitario(it.preco_unitario) || 0);
                                    const pctAtual = normalizarPctVenda(Number(it.desconto_pct ?? 0));
                                    setItemEditDraft({
                                      quantidade: String(it.quantidade),
                                      preco_tabela: String(tabelaAtual),
                                      preco_unitario: String(precoVendaAtual),
                                      desconto_pct: String(pctAtual),
                                      desconto_rs: String(descontoUnitarioDe(precoVendaAtual, pctAtual)),
                                    });
                                  }}
                                  title="Editar quantidade, preço de venda ou desconto"
                                  aria-label={`Editar item ${it.produto_id__label}`}
                                >
                                  <Edit3 className="h-4 w-4" />
                                </button>
                                {(podeExcluir || !it.persistido) && (
                                  <button
                                    type="button"
                                    className="btn-icon hover:!bg-red-50 hover:!text-red-600"
                                    disabled={busyItem === it.id}
                                    onClick={() => setToDelete(it)}
                                    title="Remover item"
                                    aria-label={`Remover item ${it.produto_id__label}`}
                                  >
                                    <Trash2 className="h-4 w-4" />
                                  </button>
                                )}
                              </>
                            )}
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </SecaoVenda>

      {/* 4. DESCONTOS, FRETE E ENTREGA */}
      <SecaoVenda
        etapa={4}
        titulo="Descontos, Frete e Entrega"
        subtitulo="Ajustes comerciais sobre o pedido, previsão de entrega e observações operacionais."
      >
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <CampoMoedaVenda
            id="venda-desconto"
            rotulo="Desconto comercial (R$)"
            disabled={itensBloqueados || !!salvando}
            valorTexto={form.desconto_texto}
            erro={erros.desconto_texto}
            dica="Abatido do total dos itens."
            onChangeTexto={(v) => setCampo('desconto_texto', v)}
          />

          <CampoMoedaVenda
            id="venda-frete"
            rotulo="Frete (R$)"
            disabled={itensBloqueados || !!salvando}
            valorTexto={form.frete_texto}
            erro={erros.frete_texto}
            dica="Somado ao total do pedido."
            onChangeTexto={(v) => setCampo('frete_texto', v)}
          />

          <CampoDataVenda
            id="venda-previsao-entrega"
            rotulo="Previsão de entrega"
            disabled={itensBloqueados || !!salvando}
            valorBr={form.previsao_entrega_br}
            erro={erros.previsao_entrega_br}
            onChangeBr={(v) => setCampo('previsao_entrega_br', v)}
          />
        </div>

        <div className="mt-4">
          <label htmlFor="venda-observacoes" className="label">
            Observações do pedido / entrega / financeiro
          </label>
          <textarea
            id="venda-observacoes"
            rows={2}
            maxLength={2000}
            disabled={cancelado || !!salvando}
            placeholder="Instruções de separação, transportadora, negociação comercial ou observações para a nota..."
            className="input w-full"
            value={form.observacoes}
            onChange={(e) => setCampo('observacoes', e.target.value)}
          />
        </div>
      </SecaoVenda>

      {/* 5. FINANCEIRO DA VENDA */}
      <SecaoVenda
        etapa={5}
        titulo="Financeiro"
        subtitulo="Forma de pagamento, parcelamento, vencimento, conta financeira e documento comprobatório."
        direita={
          <Badge
            tone={
              form.fin_status === 'recebido' ? 'green' : form.fin_status === 'cancelado' ? 'red' : 'amber'
            }
          >
            {FIN_STATUS_OPCOES.find((o) => o.value === form.fin_status)?.label || form.fin_status}
          </Badge>
        }
      >
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <label htmlFor="venda-fin-status" className="label">
              Situação financeira
            </label>
            <select
              id="venda-fin-status"
              className="input w-full"
              disabled={financeiroBloqueado || !!salvando}
              value={form.fin_status}
              onChange={(e) => setCampo('fin_status', e.target.value)}
            >
              {FIN_STATUS_OPCOES.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label htmlFor="venda-fin-forma" className="label">
              Forma de pagamento
            </label>
            <select
              id="venda-fin-forma"
              className="input w-full"
              disabled={financeiroBloqueado || !!salvando}
              value={form.fin_forma_pagamento}
              onChange={(e) => setCampo('fin_forma_pagamento', e.target.value)}
            >
              {FIN_FORMA_OPCOES.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label htmlFor="venda-fin-parcelas" className="label">
              Nº de parcelas
            </label>
            <input
              id="venda-fin-parcelas"
              type="number"
              min={1}
              max={60}
              step={1}
              disabled={financeiroBloqueado || !!salvando}
              value={form.fin_parcelas}
              aria-invalid={!!erros.fin_parcelas || undefined}
              aria-describedby={erros.fin_parcelas ? 'venda-fin-parcelas-erro' : undefined}
              onChange={(e) => setCampo('fin_parcelas', e.target.value)}
              className={`input w-full tabular-nums ${
                erros.fin_parcelas ? 'border-red-400 focus:border-red-500 focus:ring-red-200' : ''
              }`}
            />
            {erros.fin_parcelas ? (
              <p id="venda-fin-parcelas-erro" role="alert" className="mt-1 text-xs font-medium text-red-600">
                {erros.fin_parcelas}
              </p>
            ) : parcelasPrevia.length > 0 && totalExibido > 0 ? (
              <p className="mt-1 text-xs text-slate-500 dark:text-navy-300">
                {qtdParcelasNum}x de {formatMoney(parcelasPrevia[parcelasPrevia.length - 1])}
                {parcelasPrevia[0] !== parcelasPrevia[parcelasPrevia.length - 1]
                  ? ` (1ª de ${formatMoney(parcelasPrevia[0])})`
                  : ''}
              </p>
            ) : null}
          </div>

          <div>
            <label htmlFor="venda-condicao-pagamento" className="label">
              Condição de pagamento
            </label>
            <input
              id="venda-condicao-pagamento"
              type="text"
              maxLength={60}
              disabled={financeiroBloqueado || !!salvando}
              placeholder="À vista, 30/60/90 dias..."
              className="input w-full"
              value={form.condicao_pagamento}
              onChange={(e) => setCampo('condicao_pagamento', e.target.value)}
            />
          </div>

          <CampoDataVenda
            id="venda-fin-vencimento"
            rotulo="1º Vencimento / Previsão"
            mostrarAtalhoHoje
            disabled={financeiroBloqueado || !!salvando}
            valorBr={form.fin_vencimento_br}
            erro={erros.fin_vencimento_br}
            dica="Demais parcelas avançam mês a mês."
            onChangeBr={(v) => setCampo('fin_vencimento_br', v)}
          />

          <CampoDataVenda
            id="venda-fin-recebido-em"
            rotulo="Recebido em"
            mostrarAtalhoHoje
            disabled={financeiroBloqueado || !!salvando}
            valorBr={form.fin_recebido_em_br}
            erro={erros.fin_recebido_em_br}
            dica="Preencha quando o pagamento já entrou."
            onChangeBr={(v) => setCampo('fin_recebido_em_br', v)}
          />

          <div>
            <label htmlFor="venda-fin-conta" className="label">
              Conta financeira
            </label>
            {podeGerirFinanceiro ? (
              <select
                id="venda-fin-conta"
                className="input w-full"
                disabled={financeiroBloqueado || !!salvando}
                value={form.fin_conta_id}
                onChange={(e) => setCampo('fin_conta_id', e.target.value)}
              >
                <option value="">— Conta padrão da empresa —</option>
                {contasOpts.map((o) => (
                  <option key={o.value} value={String(o.value)}>
                    {o.label}
                  </option>
                ))}
              </select>
            ) : (
              <input
                id="venda-fin-conta"
                type="text"
                disabled
                className="input w-full bg-slate-50 text-slate-600"
                value={String(pedido?.fin_conta_id__label || 'Definida pelo financeiro (conta padrão)')}
              />
            )}
          </div>

          <div>
            <label htmlFor="venda-fin-documento" className="label">
              Comprovante / Nº documento
            </label>
            <input
              id="venda-fin-documento"
              type="text"
              maxLength={80}
              disabled={financeiroBloqueado || !!salvando}
              placeholder="NSU, ID PIX, nº boleto..."
              className="input w-full"
              value={form.fin_documento}
              onChange={(e) => setCampo('fin_documento', e.target.value)}
            />
          </div>
        </div>

        {vendaIdAtiva && (
          <ContasAReceberDaVenda
            vendaId={vendaIdAtiva}
            pedidoStatus={statusAtual}
            finStatus={form.fin_status}
            finParcelas={qtdParcelasNum}
            podeVerLancamentos={podeGerirFinanceiro}
          />
        )}
      </SecaoVenda>

      {/* 6. RESUMO DA VENDA */}
      <SecaoVenda
        etapa={6}
        titulo="Resumo da Venda"
        subtitulo="Conferência consolidada de cliente, peças, descontos, frete, parcelamento e valor total."
      >
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-12">
          <div className="space-y-2 rounded-xl border border-slate-200 bg-slate-50/70 p-4 text-xs lg:col-span-7 dark:border-navy-700 dark:bg-navy-800/40">
            <div className="flex flex-wrap justify-between gap-2">
              <span className="font-semibold text-slate-500">Modalidade / Cliente</span>
              <span className="font-semibold text-navy-900 dark:text-white">
                {clienteObj
                  ? `${form.modoPessoa === 'pj' ? clienteObj.razao_social || clienteObj.nome : clienteObj.nome}${
                      clienteObj.cnpj_cpf ? ` (${formatDocumento(clienteObj.cnpj_cpf)})` : ''
                    }`
                  : pedido?.cliente_id__label || 'Cliente ainda não selecionado'}
              </span>
            </div>
            <div className="flex flex-wrap justify-between gap-2">
              <span className="font-semibold text-slate-500">Data · Canal · Local de saída</span>
              <span className="text-slate-700 dark:text-slate-200">
                {form.dataBr || '—'} · {CANAL_VENDA_OPCOES.find((o) => o.value === form.canal_venda)?.label || form.canal_venda} ·{' '}
                {form.local_saida || localPadrao}
              </span>
            </div>
            <div className="flex flex-wrap justify-between gap-2">
              <span className="font-semibold text-slate-500">Itens e peças</span>
              <span className="tabular-nums text-slate-700 dark:text-slate-200">
                {itens.length} {itens.length === 1 ? 'item' : 'itens'} ({totalPecas} {totalPecas === 1 ? 'peça' : 'peças'})
              </span>
            </div>
            <div className="flex flex-wrap justify-between gap-2">
              <span className="font-semibold text-slate-500">Pagamento</span>
              <span className="text-slate-700 dark:text-slate-200">
                {FIN_FORMA_OPCOES.find((o) => o.value === form.fin_forma_pagamento)?.label || 'Não informada'} ·{' '}
                {qtdParcelasNum}x · {FIN_STATUS_OPCOES.find((o) => o.value === form.fin_status)?.label || form.fin_status}
              </span>
            </div>
            {pedido?.comissao_valor != null && Number(pedido.comissao_valor) > 0 && (
              <div className="flex flex-wrap justify-between gap-2 border-t border-slate-200/80 pt-2 dark:border-navy-700">
                <span className="font-semibold text-slate-500">
                  Comissão representante ({String(pedido.comissao_pct || 0).replace('.', ',')}%)
                </span>
                <span className="font-semibold tabular-nums text-slate-800 dark:text-slate-100">
                  {formatMoney(pedido.comissao_valor)}
                </span>
              </div>
            )}
          </div>

          <div className="flex flex-col justify-between rounded-xl border border-navy-200 bg-navy-50/50 p-4 lg:col-span-5 dark:border-navy-700 dark:bg-navy-800/60">
            <div className="space-y-1.5 text-sm">
              <div className="flex justify-between">
                <span className="text-slate-600 dark:text-navy-200">Preço bruto da venda</span>
                <span className="font-medium tabular-nums">{formatMoney(resumo.bruto)}</span>
              </div>
              <div className="flex justify-between text-red-600 dark:text-red-400">
                <span className="flex flex-wrap items-center gap-1.5">
                  Descontos concedidos
                  {resumo.descontoTotal > 0 && (
                    <span className="rounded bg-red-100 px-1.5 py-0.5 text-[11px] font-semibold text-red-700 dark:bg-red-500/20 dark:text-red-300">
                      {formatNumber(resumo.descontoPct)}%
                    </span>
                  )}
                </span>
                <span className="tabular-nums">− {formatMoney(resumo.descontoTotal)}</span>
              </div>
              {resumo.descontoPedido > 0 && (
                <div className="flex justify-between text-[11px] text-red-500 dark:text-red-400">
                  <span className="pl-3">↳ desconto do pedido</span>
                  <span className="tabular-nums">− {formatMoney(resumo.descontoPedido)}</span>
                </div>
              )}
              <div className="flex justify-between">
                <span className="text-slate-600 dark:text-navy-200">Subtotal líquido</span>
                <span className="font-medium tabular-nums">{formatMoney(resumo.subtotalLiquido)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-600 dark:text-navy-200">Frete</span>
                <span className="tabular-nums">+ {formatMoney(resumo.frete)}</span>
              </div>
              <div className="flex justify-between border-t border-navy-200 pt-2 text-lg font-extrabold text-navy-900 dark:border-navy-600 dark:text-white">
                <span>Total da venda</span>
                <span className="tabular-nums">{formatMoney(totalExibido)}</span>
              </div>
            </div>

            {!cancelado && (
              <div className="mt-4 flex flex-wrap justify-end gap-2 border-t border-navy-200/70 pt-3 dark:border-navy-700">
                <button
                  type="button"
                  className="btn-secondary"
                  disabled={!!salvando}
                  onClick={() => navigate(ehRotaEditar && vendaIdAtiva ? `/vendas/${vendaIdAtiva}` : '/vendas')}
                >
                  Voltar
                </button>
                <button
                  type="button"
                  className="btn-secondary"
                  disabled={!!salvando}
                  onClick={() => void submeterVenda(false)}
                >
                  {salvando === 'salvar' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                  {ehRotaNovo && !vendaCriadaId ? 'Salvar pedido' : 'Salvar alterações'}
                </button>
                {!fechado && (
                  <button
                    type="button"
                    className="btn-primary"
                    disabled={!!salvando}
                    onClick={() => void submeterVenda(true)}
                  >
                    {salvando === 'finalizar' ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <PackageCheck className="h-4 w-4" />
                    )}
                    {ehRotaNovo ? 'Finalizar venda' : 'Finalizar e faturar'}
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      </SecaoVenda>

      {/* 7. FISCAL (NF-e / NFC-e) */}
      <FiscalVendaCard
        etapa={7}
        vendaId={vendaIdAtiva}
        pedido={pedido}
        modoPessoa={form.modoPessoa}
        cliente={clienteObj}
        onNavigate={(rota) => navigate(rota)}
        onFiscalAtualizado={() => (vendaIdAtiva ? recarregarPedido(vendaIdAtiva, true) : undefined)}
      />

      {/* Confirmação de remoção de item */}
      <ConfirmacaoInline
        open={!!toDelete}
        title="Remover item?"
        danger
        confirmLabel="Remover"
        busy={busyItem === toDelete?.id}
        onCancel={() => setToDelete(null)}
        onConfirm={() => void removeItem()}
        message={
          <p>
            Remover <strong>{toDelete?.produto_id__label}</strong> ({toDelete?.tamanho_id__label}) da venda? O total será recalculado.
          </p>
        }
      />

      {/* Confirmação de cancelamento da venda */}
      <ConfirmacaoInline
        open={confirmarCancelamento}
        title="Cancelar pedido de venda?"
        danger
        confirmLabel="Confirmar cancelamento"
        busy={salvando === 'cancelar'}
        onCancel={() => setConfirmarCancelamento(false)}
        onConfirm={() => void alterarStatusDireto('cancelada')}
        message={
          <p>
            Tem certeza que deseja cancelar o pedido <strong>#{vendaIdAtiva}</strong>?{' '}
            {fechado
              ? 'Como o pedido já foi faturado, a baixa de estoque e os lançamentos financeiros em aberto serão estornados.'
              : 'O pedido ficará encerrado e não poderá ser reaberto.'}
          </p>
        }
      />
    </div>
  );
}

// ============================================================================
// MOTOR DE COMPRAS (`/compras/:id`) — preservado integralmente sem regressão
// ============================================================================
function CompraOrderEngine() {
  const { id } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const { user } = useAuth();
  const meta = useMeta();
  const pedidoId = Number(id);

  const resource: ResourceMeta = meta.resources['compras'];

  const [pedido, setPedido] = useState<Record<string, any> | null>(null);
  const [itens, setItens] = useState<Item[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [busyItem, setBusyItem] = useState<number | 'new' | null>(null);
  const [toDelete, setToDelete] = useState<Item | null>(null);
  const [actionStatus, setActionStatus] = useState<string | null>(null);
  const [recebendo, setRecebendo] = useState(false);

  const [parceiroOpts, setParceiroOpts] = useState<Option[]>([]);
  const [insumoOpts, setInsumoOpts] = useState<Option[]>([]);

  const blank: Item = useMemo(() => ({ id: 0, insumo_id: undefined, quantidade: 1, preco_unitario: '' }), []);
  const [novo, setNovo] = useState<Item>(blank);

  const fechado = String(pedido?.status) === 'recebido';
  const cancelado = pedido?.status === 'cancelado';
  const podeExcluir = user?.perfil !== 'operador';

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [p, it] = await Promise.all([
        api.get<Record<string, any>>(`/compras/${pedidoId}`),
        api.get<Item[]>(`/compras/${pedidoId}/itens`),
      ]);
      setPedido(p);
      setItens(it);
    } catch (e: any) {
      setError(e.message || 'Erro ao carregar o pedido.');
    } finally {
      setLoading(false);
    }
  }, [pedidoId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    api.get<Option[]>('/fornecedores/options').then(setParceiroOpts).catch(() => {});
    api.get<Option[]>('/insumos/options').then(setInsumoOpts).catch(() => {});
  }, []);

  const totalItens = useMemo(
    () => itens.reduce((s, it) => s + Number(it.quantidade) * Number(it.preco_unitario || 0), 0),
    [itens]
  );

  function subtotalNovo(): number {
    return Math.round((Number(novo.quantidade) || 0) * (Number(novo.preco_unitario) || 0) * 100) / 100;
  }

  async function saveHeader(field: string, value: unknown) {
    setSaving(true);
    try {
      const atual = await api.put<Record<string, any>>(`/compras/${pedidoId}`, { [field]: value });
      setPedido(atual);
      toast.success('Compra atualizada.');
    } catch (e: any) {
      toast.error(e.message || 'Não foi possível salvar.');
      await load();
    } finally {
      setSaving(false);
    }
  }

  async function addItem() {
    if (!novo.insumo_id) return toast.error('Selecione o insumo.');
    if (!(Number(novo.quantidade) > 0)) return toast.error('Informe a quantidade.');
    if (!(Number(novo.preco_unitario) >= 0)) return toast.error('Informe o preço unitário.');
    setBusyItem('new');
    try {
      await api.post(`/compras/${pedidoId}/itens`, {
        insumo_id: Number(novo.insumo_id),
        quantidade: Number(novo.quantidade),
        preco_unitario: Number(novo.preco_unitario),
      });
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
      await api.del(`/compras/${pedidoId}/itens/${toDelete.id}`);
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
      const atual = await api.put<Record<string, any>>(`/compras/${pedidoId}`, { status });
      setPedido(atual);
      toast.success('Compra atualizada.');
      await load();
    } catch (e: any) {
      toast.error(e.message || 'Não foi possível alterar o status.');
    } finally {
      setActionStatus(null);
    }
  }

  const statusOptions = resource?.fields.find((f) => f.name === 'status')?.options || [];

  if (loading) return <Spinner />;
  if (error) {
    return (
      <div className="p-4 sm:p-6">
        <Alert tone="red">{error}</Alert>
        <button className="btn-secondary mt-4" onClick={() => navigate('/compras')}>
          <ArrowLeft className="h-4 w-4" /> Voltar
        </button>
      </div>
    );
  }
  if (!pedido) return null;

  return (
    <div className="p-4 sm:p-6">
      <PageHeader
        title={
          <span className="flex items-center gap-2.5">
            <button className="btn-icon" onClick={() => navigate('/compras')} title="Voltar">
              <ArrowLeft className="h-4 w-4" />
            </button>
            Pedido de compra #{pedido.id}
            <Badge tone={STATUS_TONE[String(pedido.status)] || 'slate'}>
              {statusOptions.find((o) => o.value === String(pedido.status))?.label || pedido.status}
            </Badge>
          </span>
        }
        description="Itens da compra, totais e recebimento de insumos."
        actions={
          <div className="flex flex-wrap gap-2">
            <DocumentPrintButton tipo="compras" documentoId={Number(pedido.id)} label="Fila de impressão" />
            <button className="btn-secondary" onClick={() => window.open(`/api/compras/${pedido.id}/pdf`, '_blank')}>
              <Printer className="h-4 w-4" /> Imprimir PDF
            </button>
            {!fechado && !cancelado && (
              <button className="btn-primary" onClick={() => setRecebendo(true)}>
                <Save className="h-4 w-4" /> Receber compra
              </button>
            )}
            {!cancelado && (
              <button className="btn-secondary text-red-600" disabled={!!actionStatus} onClick={() => mudarStatus('cancelado')}>
                {actionStatus === 'cancelado' ? <Loader2 className="h-4 w-4 animate-spin" /> : <X className="h-4 w-4" />}
                Cancelar
              </button>
            )}
          </div>
        }
      />

      {fechado && (
        <div className="mb-4">
          <Alert tone="green">
            {`Compra recebida${pedido.recebida_em ? ` em ${formatDate(pedido.recebida_em)}` : ''}: os insumos entraram no estoque e o custo médio foi atualizado. Os itens não podem mais ser alterados.`}
          </Alert>
        </div>
      )}
      {cancelado && (
        <div className="mb-4">
          <Alert tone="red">
            Esta compra foi cancelada{fechado ? ' e os movimentos de estoque foram estornados' : ''}. Não é possível reabri-la.
          </Alert>
        </div>
      )}

      <div className="card p-5">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <HeaderSelect
            label="Fornecedor"
            value={pedido.fornecedor_id}
            options={parceiroOpts}
            disabled={fechado || cancelado || saving}
            onChange={(v) => saveHeader('fornecedor_id', v)}
          />
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
          />
          <HeaderText
            label="Nota fiscal"
            value={pedido.nota_fiscal || ''}
            disabled={fechado || cancelado || saving}
            onChange={(v) => saveHeader('nota_fiscal', v || null)}
            placeholder="Número da NF"
          />
          <HeaderMoney
            label="Frete (R$)"
            value={pedido.frete ?? ''}
            disabled={fechado || cancelado || saving}
            onChange={(v) => saveHeader('frete', v)}
            optional
          />
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

      <div className="card mt-4 overflow-hidden">
        <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
          <h2 className="text-sm font-bold text-navy-900">Itens do pedido ({itens.length})</h2>
        </div>
        <div className="overflow-x-auto">
          <table className="table">
            <thead>
              <tr>
                <th>Insumo</th>
                <th className="w-24 text-right">Qtd.</th>
                <th className="w-32 text-right">Preço un.</th>
                <th className="w-32 text-right">Subtotal</th>
                <th className="w-16" />
              </tr>
            </thead>
            <tbody>
              {itens.map((it) => (
                <tr key={it.id}>
                  <td className="font-medium text-slate-800">{it.insumo_id__label}</td>
                  <td className="text-right tabular-nums">{it.quantidade}</td>
                  <td className="text-right tabular-nums">{formatMoney(it.preco_unitario)}</td>
                  <td className="text-right font-semibold tabular-nums">
                    {formatMoney(Number(it.quantidade) * Number(it.preco_unitario))}
                  </td>
                  <td className="text-right">
                    {!fechado && !cancelado && podeExcluir && (
                      <button
                        className="btn-icon hover:!bg-red-50 hover:!text-red-600"
                        disabled={busyItem === it.id}
                        onClick={() => setToDelete(it)}
                        title="Remover item"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    )}
                  </td>
                </tr>
              ))}

              {!fechado && !cancelado && (
                <tr className="bg-navy-50/40">
                  <td>
                    <select
                      className="input"
                      value={novo.insumo_id ?? ''}
                      onChange={(e) => setNovo((n) => ({ ...n, insumo_id: e.target.value ? Number(e.target.value) : undefined }))}
                    >
                      <option value="">Selecione insumo...</option>
                      {insumoOpts.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <input
                      type="number"
                      min={0.001}
                      step={0.001}
                      className="input text-right"
                      value={novo.quantidade}
                      onChange={(e) => setNovo((n) => ({ ...n, quantidade: e.target.value }))}
                    />
                  </td>
                  <td>
                    <input
                      type="number"
                      min={0}
                      step="0.01"
                      className="input text-right"
                      placeholder="0,00"
                      value={novo.preco_unitario}
                      onChange={(e) => setNovo((n) => ({ ...n, preco_unitario: e.target.value }))}
                    />
                  </td>
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

        <div className="border-t border-slate-200 px-4 py-3">
          <div className="ml-auto max-w-xs space-y-1.5 text-sm">
            <div className="flex justify-between">
              <span className="text-slate-500">Total dos itens</span>
              <span className="tabular-nums font-medium">{formatMoney(totalItens)}</span>
            </div>
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
          </div>
        </div>
      </div>

      <ContasAPagarDaCompra compraId={Number(pedidoId)} pedido={pedido} />

      {recebendo && (
        <RecebimentoCompraModal compraId={Number(pedidoId)} onClose={() => setRecebendo(false)} onRecebido={() => void load()} />
      )}

      <ConfirmacaoInline
        open={!!toDelete}
        title="Remover item?"
        danger
        confirmLabel="Remover"
        busy={busyItem === toDelete?.id}
        onCancel={() => setToDelete(null)}
        onConfirm={removeItem}
        message={
          <p>
            Remover <strong>{toDelete?.insumo_id__label}</strong> do pedido? O total será recalculado.
          </p>
        }
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Campos auxiliares de Compras
// ---------------------------------------------------------------------------
function HeaderSelect({
  label,
  value,
  options,
  onChange,
  disabled,
  optional,
}: {
  label: string;
  value: any;
  options: Option[];
  onChange: (v: number | null) => void;
  disabled?: boolean;
  optional?: boolean;
}) {
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

function HeaderDate({
  label,
  value,
  onChange,
  disabled,
  optional,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
  optional?: boolean;
}) {
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

function HeaderText({
  label,
  value,
  onChange,
  disabled,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
  placeholder?: string;
}) {
  return (
    <label className="block">
      <span className="label">{label}</span>
      <input type="text" className="input" defaultValue={value} placeholder={placeholder} disabled={disabled} onBlur={(e) => onChange(e.target.value)} />
    </label>
  );
}

function HeaderMoney({
  label,
  value,
  onChange,
  disabled,
  optional,
}: {
  label: string;
  value: any;
  onChange: (v: number) => void;
  disabled?: boolean;
  optional?: boolean;
}) {
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

function ContasAPagarDaCompra({ compraId, pedido }: { compraId: number; pedido: Record<string, any> }) {
  const [parcelas, setParcelas] = useState<Record<string, any>[]>([]);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState<string | null>(null);

  const carregar = useCallback(async () => {
    setCarregando(true);
    setErro(null);
    try {
      const r = await api.get<{ rows: Record<string, any>[] }>(
        `/lancamentos_financeiros?f.referencia_tipo=compra&f.referencia_id=${compraId}&pageSize=100`
      );
      const rows = [...(r.rows || [])].sort((a, b) => Number(a.parcela || 1) - Number(b.parcela || 1));
      setParcelas(rows);
    } catch (e: any) {
      setErro(e?.message || 'Não foi possível carregar as contas a pagar.');
    } finally {
      setCarregando(false);
    }
  }, [compraId]);

  useEffect(() => {
    void carregar();
  }, [carregar, pedido?.status, pedido?.fin_status]);

  const total = parcelas.reduce((a, p) => a + Number(p.valor || 0), 0);
  const pagas = parcelas.filter((p) => String(p.status) === 'confirmado');
  const totalPago = pagas.reduce((a, p) => a + Number(p.valor || 0), 0);

  return (
    <div className="card mt-4 overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 px-4 py-3">
        <h2 className="text-sm font-bold text-navy-900">Contas a pagar</h2>
        <div className="flex items-center gap-2">
          {pedido.condicao_pagamento && <Badge tone="slate">{pedido.condicao_pagamento}</Badge>}
          <button className="btn-icon" onClick={() => void carregar()} title="Recarregar" aria-label="Recarregar contas a pagar">
            <RefreshCw className="h-4 w-4" />
          </button>
        </div>
      </div>

      <div className="px-4 py-3">
        {carregando && <Spinner label="Carregando contas a pagar..." />}

        {!carregando && erro && (
          <div className="space-y-2">
            <Alert tone="red">{erro}</Alert>
            <button className="btn-secondary" onClick={() => void carregar()}>
              <RefreshCw className="h-4 w-4" /> Tentar novamente
            </button>
          </div>
        )}

        {!carregando && !erro && parcelas.length === 0 && (
          <p className="text-sm text-slate-500">
            {String(pedido.status) === 'recebido'
              ? 'Esta compra não gerou conta a pagar. Verifique o valor total do pedido — pedido de valor zero não gera obrigação financeira.'
              : 'Nenhuma conta a pagar ainda. O financeiro é gerado quando a compra for totalmente recebida — enquanto estiver parcial, não existe obrigação a pagar.'}
          </p>
        )}

        {!carregando && !erro && parcelas.length > 0 && (
          <>
            <div className="overflow-x-auto">
              <table className="table">
                <thead>
                  <tr>
                    <th>Parcela</th>
                    <th>Vencimento</th>
                    <th className="text-right">Valor</th>
                    <th>Forma de pagamento</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {parcelas.map((p) => (
                    <tr key={p.id}>
                      <td className="tabular-nums">
                        {p.parcela || 1}/{p.total_parcelas || 1}
                      </td>
                      <td>{p.vencimento ? formatDate(p.vencimento) : 'Não informado'}</td>
                      <td className="text-right tabular-nums font-medium">{formatMoney(p.valor)}</td>
                      <td>{p.forma_pagamento || 'Não informada'}</td>
                      <td>
                        <Badge tone={String(p.status) === 'confirmado' ? 'green' : String(p.status) === 'cancelado' ? 'red' : 'amber'}>
                          {String(p.status || 'pendente')}
                        </Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-sm">
              <span>
                Total a pagar: <strong className="tabular-nums">{formatMoney(total)}</strong>
              </span>
              <span>
                Pago: <strong className="tabular-nums">{formatMoney(totalPago)}</strong>
              </span>
              <span>
                Em aberto: <strong className="tabular-nums">{formatMoney(total - totalPago)}</strong>
              </span>
            </div>
            <p className="mt-2 text-xs text-slate-500">
              A baixa é feita em <strong>Financeiro → Lançamentos</strong>: esta tela mostra a obrigação, quem dá baixa é o financeiro.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
