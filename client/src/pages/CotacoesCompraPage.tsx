// ============================================================================
// COTAÇÃO DE COMPRA — E3
//
// A tela existe para responder uma pergunta só: **quem tem o menor preço pelo
// item que eu preciso, e o que isso me economiza?** Tudo o mais é apoio.
//
// Regras de interface que espelham o servidor (server/src/cotacoesCompra.ts):
//
//  • NENHUM PREÇO É INVENTADO. Item sem cotação aparece com "—" e a decisão
//    por menor preço é BLOQUEADA pelo servidor; a tela diz o porquê.
//  • DECIDIR GERA O PEDIDO UMA ÚNICA VEZ. Se o usuário clicar duas vezes, a
//    segunda chamada devolve o mesmo pedido e a tela mostra isso — nunca um
//    segundo pedido.
//  • Decidir e cancelar são atos de gerente; para operador os botões ficam
//    desabilitados com explicação, não simplesmente escondidos.
// ============================================================================
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  Factory,
  FileSpreadsheet,
  Plus,
  RefreshCw,
  Scale,
  Trash2,
  X,
} from 'lucide-react';
import { api, ApiError } from '../lib/api';
import { formatDateTime, formatMoney, formatNumber } from '../lib/format';
import type { ListResult } from '../lib/meta';
import { useAuth } from '../auth/AuthContext';
import { Alert, Badge, ConfirmDialog, EmptyState, Modal, PageHeader, Spinner, useToast } from '../components/ui';

// ---------------------------------------------------------------------------
// Tipos espelhando a resposta de GET /api/cotacoes-compra/:id/comparativo
// ---------------------------------------------------------------------------
type PrecoLinha = {
  convite_id: number;
  fornecedor_id: number;
  fornecedor: string | null;
  preco_unitario: number;
  prazo_entrega_dias: number | null;
  total: number;
  /** false = o fornecedor informou que não tem. Aparece riscado e não compete no menor preço. */
  disponivel: boolean;
};

type LinhaComparativo = {
  item_id: number;
  descricao: string;
  quantidade: number;
  unidade: string | null;
  cotacoes_recebidas: number;
  precos: PrecoLinha[];
  menor_preco: number | null;
  melhor_fornecedor: string | null;
  melhor_prazo_dias: number | null;
  economia_potencial: number;
  escolhido_fornecedor_id: number | null;
  escolhido_preco: number | null;
};

type FornecedorComparativo = {
  convite_id: number;
  fornecedor_id: number;
  fornecedor: string;
  status: 'convidado' | 'cotado' | 'recusado' | string;
  itens_cotados: number;
  total_cotado: number | null;
  frete: number;
  prazo_entrega_dias: number | null;
  condicao_pagamento: string | null;
  respondeu_em: string | null;
};

type Comparativo = {
  cotacao: { id: number; titulo: string; status: string; criterio: string | null; prazo_validade: string | null; compra_id: number | null };
  resumo: {
    itens: number;
    fornecedores: number;
    fornecedores_que_cotaram: number;
    itens_sem_cotacao: number;
    economia_potencial_total: number;
  };
  itens: LinhaComparativo[];
  fornecedores: FornecedorComparativo[];
};

type CotacaoResumo = { id: number; titulo: string; status: string; criterio: string | null; compra_id: number | null; criado_em: string };
type Opcao = { id: number; nome: string };

const CRITERIOS = [
  { value: 'menor_preco', label: 'Menor preço por item', hint: 'Escolhe o fornecedor mais barato de cada item. Pode gerar pedido com mais de um fornecedor.' },
  { value: 'menor_preco_total', label: 'Menor preço total (fornecedor único)', hint: 'Compara só quem cotou TODOS os itens, já considerando o frete.' },
  { value: 'prazo', label: 'Menor prazo de entrega', hint: 'Prefere quem entrega antes; desempate por preço.' },
  { value: 'qualidade', label: 'Escolha manual por qualidade', hint: 'Você escolhe o fornecedor de cada item.' },
] as const;

const TOM_STATUS: Record<string, 'amber' | 'blue' | 'green' | 'red' | 'slate'> = {
  rascunho: 'slate',
  cotando: 'amber',
  decidida: 'green',
  cancelada: 'red',
};

const ROTULO_STATUS: Record<string, string> = {
  rascunho: 'Rascunho',
  cotando: 'Aguardando fornecedores',
  decidida: 'Decidida',
  cancelada: 'Cancelada',
};

function mensagemErro(e: unknown, padrao: string): string {
  if (e instanceof ApiError) return e.message;
  return padrao;
}

/** Só gerente/admin decide e cancela — mesma trava do servidor. */
function podeDecidir(perfil?: string): boolean {
  return perfil === 'admin' || perfil === 'gerente';
}

export default function CotacoesCompraPage() {
  const toast = useToast();
  const auth = useAuth();
  const perfil = auth.user?.perfil;
  const gerente = podeDecidir(perfil);

  const [lista, setLista] = useState<CotacaoResumo[]>([]);
  const [carregandoLista, setCarregandoLista] = useState(true);
  const [erroLista, setErroLista] = useState('');
  const [selecionada, setSelecionada] = useState<number | null>(null);

  const [comp, setComp] = useState<Comparativo | null>(null);
  const [carregandoComp, setCarregandoComp] = useState(false);
  const [erroComp, setErroComp] = useState('');

  const [insumos, setInsumos] = useState<Opcao[]>([]);
  const [fornecedores, setFornecedores] = useState<Opcao[]>([]);

  const [novaAberta, setNovaAberta] = useState(false);
  const [novoTitulo, setNovoTitulo] = useState('');
  const [novoCriterio, setNovoCriterio] = useState<string>('menor_preco');
  const [novoPrazo, setNovoPrazo] = useState('');
  const [salvando, setSalvando] = useState(false);

  const [addItemAberto, setAddItemAberto] = useState(false);
  const [itemInsumo, setItemInsumo] = useState('');
  const [itemQtd, setItemQtd] = useState('1');
  const [addConviteAberto, setAddConviteAberto] = useState(false);
  const [conviteFornecedores, setConviteFornecedores] = useState<number[]>([]);

  const [cotandoConvite, setCotandoConvite] = useState<FornecedorComparativo | null>(null);
  const [cotandoPrecos, setCotandoPrecos] = useState<Record<number, { preco: string; prazo: string; disponivel: boolean }>>({});
  const [cotandoFrete, setCotandoFrete] = useState('');

  const [decidindo, setDecidindo] = useState(false);
  const [confirmarDecisao, setConfirmarDecisao] = useState(false);
  const [confirmarCancelamento, setConfirmarCancelamento] = useState(false);
  const [cancelando, setCancelando] = useState(false);
  const [itemRemover, setItemRemover] = useState<LinhaComparativo | null>(null);

  // -------------------------------------------------------------------------
  // Carga
  // -------------------------------------------------------------------------
  const carregarLista = useCallback(async () => {
    setCarregandoLista(true);
    setErroLista('');
    try {
      const d = await api.get<ListResult<CotacaoResumo>>('/cotacoes_compra?page=1&pageSize=100&sort=id&dir=desc');
      setLista(d.rows);
      setSelecionada((atual) => atual ?? (d.rows[0] ? Number(d.rows[0].id) : null));
    } catch (e) {
      setErroLista(mensagemErro(e, 'Não foi possível carregar as cotações.'));
    } finally {
      setCarregandoLista(false);
    }
  }, []);

  const carregarComparativo = useCallback(async (id: number) => {
    setCarregandoComp(true);
    setErroComp('');
    try {
      setComp(await api.get<Comparativo>(`/cotacoes-compra/${id}/comparativo`));
    } catch (e) {
      setErroComp(mensagemErro(e, 'Não foi possível carregar a cotação.'));
      setComp(null);
    } finally {
      setCarregandoComp(false);
    }
  }, []);

  useEffect(() => {
    void carregarLista();
  }, [carregarLista]);

  useEffect(() => {
    if (selecionada === null) return;
    void carregarComparativo(selecionada);
  }, [selecionada, carregarComparativo]);

  useEffect(() => {
    api
      .get<ListResult<Opcao>>('/insumos?page=1&pageSize=500&sort=nome&dir=asc')
      .then((d) => setInsumos(d.rows.map((r) => ({ id: Number(r.id), nome: String(r.nome ?? r.id) }))))
      .catch(() => setInsumos([]));
    api
      .get<ListResult<Opcao>>('/fornecedores?page=1&pageSize=200&sort=nome&dir=asc')
      .then((d) => setFornecedores(d.rows.map((r) => ({ id: Number(r.id), nome: String(r.nome ?? r.id) }))))
      .catch(() => setFornecedores([]));
  }, []);

  const recarregar = useCallback(async () => {
    await carregarLista();
    if (selecionada !== null) await carregarComparativo(selecionada);
  }, [carregarLista, carregarComparativo, selecionada]);

  const editavel = comp ? comp.cotacao.status === 'rascunho' || comp.cotacao.status === 'cotando' : false;
  const cotando = comp?.cotacao.status === 'cotando';

  // -------------------------------------------------------------------------
  // Ações
  // -------------------------------------------------------------------------
  async function criarCotacao() {
    if (!novoTitulo.trim()) {
      toast.error('Dê um título à cotação.');
      return;
    }
    setSalvando(true);
    try {
      const criada = await api.post<{ id: number }>('/cotacoes_compra', {
        titulo: novoTitulo.trim(),
        criterio: novoCriterio,
        prazo_validade: novoPrazo || null,
      });
      toast.success('Cotação criada. Adicione os itens e convide os fornecedores.');
      setNovaAberta(false);
      setNovoTitulo('');
      setNovoPrazo('');
      await carregarLista();
      setSelecionada(Number(criada.id));
    } catch (e) {
      toast.error(mensagemErro(e, 'Não foi possível criar a cotação.'));
    } finally {
      setSalvando(false);
    }
  }

  async function adicionarItem() {
    if (!selecionada) return;
    if (!itemInsumo) {
      toast.error('Escolha o insumo.');
      return;
    }
    const quantidade = Number(String(itemQtd).replace(',', '.'));
    if (!(quantidade > 0)) {
      toast.error('A quantidade deve ser maior que zero.');
      return;
    }
    try {
      await api.post(`/cotacoes-compra/${selecionada}/itens`, { insumo_id: Number(itemInsumo), quantidade });
      toast.success('Item adicionado.');
      setAddItemAberto(false);
      setItemQtd('1');
      await carregarComparativo(selecionada);
    } catch (e) {
      toast.error(mensagemErro(e, 'Não foi possível adicionar o item.'));
    }
  }

  async function removerItem() {
    if (!selecionada || !itemRemover) return;
    try {
      await api.del(`/cotacoes-compra/${selecionada}/itens/${itemRemover.item_id}`);
      toast.success('Item removido.');
      setItemRemover(null);
      await carregarComparativo(selecionada);
    } catch (e) {
      toast.error(mensagemErro(e, 'Não foi possível remover o item.'));
    }
  }

  async function convidar() {
    if (!selecionada || !conviteFornecedores.length) return;
    try {
      const r = await api.post<{ convidados: number; ja_convidados: number[] }>(`/cotacoes-compra/${selecionada}/convidar`, {
        fornecedor_ids: conviteFornecedores,
      });
      toast.success(
        r.convidados
          ? `${r.convidados} fornecedor(es) convidado(s). A cotação está aberta para respostas.`
          : 'Esse(s) fornecedor(es) já estava(m) convidado(s).'
      );
      setAddConviteAberto(false);
      setConviteFornecedores([]);
      await carregarComparativo(selecionada);
      await carregarLista();
    } catch (e) {
      toast.error(mensagemErro(e, 'Não foi possível convidar os fornecedores.'));
    }
  }

  function abrirCotacaoDeFornecedor(f: FornecedorComparativo) {
    setCotandoConvite(f);
    setCotandoFrete(f.frete ? String(f.frete) : '');
    setCotandoPrecos(
      Object.fromEntries(
        (comp?.itens ?? []).map((i) => {
          const atual = i.precos.find((p) => p.convite_id === f.convite_id);
          return [
            i.item_id,
            {
              preco: atual ? String(atual.preco_unitario) : '',
              prazo: atual?.prazo_entrega_dias !== null && atual?.prazo_entrega_dias !== undefined ? String(atual.prazo_entrega_dias) : '',
              disponivel: atual ? atual.disponivel : true,
            },
          ];
        })
      )
    );
  }

  async function gravarCotacaoFornecedor() {
    if (!selecionada || !cotandoConvite) return;
    const precos = Object.entries(cotandoPrecos)
      .filter(([, v]) => v.preco.trim() !== '')
      .map(([itemId, v]) => ({
        item_id: Number(itemId),
        preco_unitario: Number(v.preco.replace(',', '.')),
        prazo_entrega_dias: v.prazo.trim() === '' ? null : Number(v.prazo),
        disponivel: v.disponivel,
      }));
    if (!precos.length) {
      toast.error('Preencha o preço de pelo menos um item.');
      return;
    }
    try {
      await api.post(`/cotacoes-compra/${selecionada}/cotar`, {
        convite_id: cotandoConvite.convite_id,
        frete: cotandoFrete.trim() === '' ? undefined : Number(cotandoFrete.replace(',', '.')),
        precos,
      });
      toast.success('Cotação registrada. Reenviar atualiza os preços em vez de duplicar.');
      setCotandoConvite(null);
      await carregarComparativo(selecionada);
    } catch (e) {
      toast.error(mensagemErro(e, 'Não foi possível registrar a cotação.'));
    }
  }

  async function recusarFornecedor(f: FornecedorComparativo) {
    if (!selecionada) return;
    try {
      await api.post(`/cotacoes-compra/${selecionada}/recusar`, { convite_id: f.convite_id });
      toast.success('Recusa registrada.');
      await carregarComparativo(selecionada);
    } catch (e) {
      toast.error(mensagemErro(e, 'Não foi possível registrar a recusa.'));
    }
  }

  async function decidir() {
    if (!selecionada) return;
    setDecidindo(true);
    setConfirmarDecisao(false);
    try {
      const r = await api.post<{ compra_id: number; idempotente: boolean; mensagem: string; total: number }>(
        `/cotacoes-compra/${selecionada}/decidir`,
        {}
      );
      if (r.idempotente) {
        toast.success(`Esta cotação já havia gerado o pedido #${r.compra_id}. Nenhum pedido duplicado foi criado.`);
      } else {
        toast.success(`Pedido de compra #${r.compra_id} criado (${formatMoney(r.total)}).`);
      }
      await recarregar();
    } catch (e) {
      toast.error(mensagemErro(e, 'Não foi possível decidir a cotação.'));
    } finally {
      setDecidindo(false);
    }
  }

  async function cancelar() {
    if (!selecionada) return;
    setCancelando(true);
    setConfirmarCancelamento(false);
    try {
      await api.post(`/cotacoes-compra/${selecionada}/cancelar`, { motivo: 'Cancelada pela tela de cotações' });
      toast.success('Cotação cancelada.');
      await recarregar();
    } catch (e) {
      toast.error(mensagemErro(e, 'Não foi possível cancelar a cotação.'));
    } finally {
      setCancelando(false);
    }
  }

  // -------------------------------------------------------------------------
  // Derivados
  // -------------------------------------------------------------------------
  const totalEscolhido = useMemo(() => {
    if (!comp) return 0;
    return Math.round(
      comp.itens.reduce((acc, l) => {
        const p = l.escolhido_preco ?? l.menor_preco;
        return p === null ? acc : acc + p * l.quantidade;
      }, 0) * 100
    ) / 100;
  }, [comp]);

  const itensSemCotacao = comp?.resumo.itens_sem_cotacao ?? 0;
  const criterioInfo = CRITERIOS.find((c) => c.value === (comp?.cotacao.criterio ?? 'menor_preco'));

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------
  return (
    <div className="space-y-4">
      <PageHeader
        title="Cotação de compra"
        description="Peça preço a vários fornecedores, compare lado a lado e gere o pedido de compra uma única vez."
        actions={
          <div className="flex gap-2">
            <button type="button" className="btn btn-secondary" onClick={() => void recarregar()}>
              <RefreshCw className="h-4 w-4" aria-hidden /> Recarregar
            </button>
            <button type="button" className="btn btn-accent" onClick={() => setNovaAberta(true)}>
              <Plus className="h-4 w-4" aria-hidden /> Nova cotação
            </button>
          </div>
        }
      />

      {!gerente && (
        <Alert tone="amber">
          Você pode montar cotações e registrar respostas de fornecedores, mas <strong>decidir</strong> (gerar o pedido) e
          cancelar exigem perfil de gerente ou administrador.
        </Alert>
      )}

      {erroLista && (
        <Alert tone="red">
          {erroLista}{' '}
          <button type="button" className="btn btn-ghost ml-2" onClick={() => void carregarLista()}>
            Tentar de novo
          </button>
        </Alert>
      )}

      <div className="grid gap-4 lg:grid-cols-[minmax(280px,340px)_1fr]">
        {/* ------------------------------------------------- lista de cotações */}
        <div className="card overflow-hidden">
          <div className="border-b border-slate-100 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-slate-400 dark:border-navy-700">
            Cotações ({lista.length})
          </div>
          {carregandoLista ? (
            <Spinner label="Carregando cotações..." />
          ) : lista.length === 0 ? (
            <EmptyState
              icon={<FileSpreadsheet className="h-6 w-6" />}
              title="Nenhuma cotação ainda"
              description="Crie a primeira cotação para comparar preços entre fornecedores antes de emitir o pedido."
              action={
                <button type="button" className="btn btn-accent" onClick={() => setNovaAberta(true)}>
                  <Plus className="h-4 w-4" aria-hidden /> Nova cotação
                </button>
              }
            />
          ) : (
            <ul className="max-h-[70vh] divide-y divide-slate-50 overflow-y-auto dark:divide-navy-800">
              {lista.map((c) => {
                const ativa = Number(c.id) === Number(selecionada);
                return (
                  <li key={c.id}>
                    <button
                      type="button"
                      onClick={() => setSelecionada(Number(c.id))}
                      aria-current={ativa ? 'true' : undefined}
                      className={`flex w-full items-center gap-2 px-3 py-2.5 text-left transition hover:bg-slate-50 dark:hover:bg-navy-800 ${
                        ativa ? 'bg-slate-50 dark:bg-navy-800' : ''
                      }`}
                    >
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-medium text-navy-900 dark:text-white">
                          #{c.id} {c.titulo}
                        </div>
                        <div className="mt-0.5 flex items-center gap-2 text-xs text-slate-400">
                          <Badge tone={TOM_STATUS[c.status] ?? 'slate'}>{ROTULO_STATUS[c.status] ?? c.status}</Badge>
                          {c.compra_id ? <span className="tabular-nums">pedido #{c.compra_id}</span> : null}
                        </div>
                      </div>
                      <ChevronRight className="h-4 w-4 shrink-0 text-slate-300" aria-hidden />
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {/* --------------------------------------------------------- detalhe */}
        <div className="min-w-0 space-y-4">
          {selecionada === null ? (
            <div className="card p-8">
              <EmptyState
                icon={<FileSpreadsheet className="h-6 w-6" />}
                title="Selecione uma cotação"
                description="Escolha uma cotação na lista ou crie uma nova para começar."
              />
            </div>
          ) : carregandoComp ? (
            <Spinner label="Carregando comparativo..." />
          ) : erroComp ? (
            <Alert tone="red">
              {erroComp}{' '}
              <button type="button" className="btn btn-ghost ml-2" onClick={() => void carregarComparativo(selecionada)}>
                Tentar de novo
              </button>
            </Alert>
          ) : !comp ? null : (
            <>
              {/* cabeçalho da cotação */}
              <div className="card p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h2 className="text-base font-semibold text-navy-900 dark:text-white">
                      #{comp.cotacao.id} {comp.cotacao.titulo}
                    </h2>
                    <p className="mt-1 text-xs text-slate-400">
                      Critério: <strong>{criterioInfo?.label ?? comp.cotacao.criterio}</strong>
                      {comp.cotacao.prazo_validade ? ` · propostas até ${comp.cotacao.prazo_validade}` : ''}
                    </p>
                    {criterioInfo?.hint ? <p className="mt-1 max-w-2xl text-[11px] text-slate-400">{criterioInfo.hint}</p> : null}
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone={TOM_STATUS[comp.cotacao.status] ?? 'slate'}>{ROTULO_STATUS[comp.cotacao.status] ?? comp.cotacao.status}</Badge>
                    {editavel && (
                      <button type="button" className="btn btn-secondary" onClick={() => setAddItemAberto(true)}>
                        <Plus className="h-4 w-4" aria-hidden /> Item
                      </button>
                    )}
                    {editavel && (
                      <button type="button" className="btn btn-secondary" onClick={() => setAddConviteAberto(true)}>
                        <Factory className="h-4 w-4" aria-hidden /> Convidar
                      </button>
                    )}
                    {cotando && (
                      <button
                        type="button"
                        className="btn btn-accent"
                        disabled={!gerente || decidindo || itensSemCotacao > 0}
                        title={
                          !gerente
                            ? 'Somente gerentes e administradores decidem cotações.'
                            : itensSemCotacao > 0
                              ? 'Há itens sem nenhuma cotação. Aguarde as respostas ou use escolha manual.'
                              : 'Gera o pedido de compra'
                        }
                        onClick={() => setConfirmarDecisao(true)}
                      >
                        <Scale className="h-4 w-4" aria-hidden /> {decidindo ? 'Decidindo...' : 'Decidir e gerar pedido'}
                      </button>
                    )}
                    {editavel && (
                      <button
                        type="button"
                        className="btn btn-ghost text-red-600"
                        disabled={!gerente}
                        title={!gerente ? 'Somente gerentes e administradores cancelam cotações.' : 'Cancelar cotação'}
                        onClick={() => setConfirmarCancelamento(true)}
                      >
                        <X className="h-4 w-4" aria-hidden /> Cancelar
                      </button>
                    )}
                  </div>
                </div>

                {comp.cotacao.compra_id ? (
                  <Alert tone="green">
                    <CheckCircle2 className="h-4 w-4" aria-hidden /> Esta cotação gerou o{' '}
                    <strong>pedido de compra #{comp.cotacao.compra_id}</strong>. Repetir a decisão não cria um segundo pedido.
                  </Alert>
                ) : null}
                {itensSemCotacao > 0 && cotando ? (
                  <Alert tone="amber">
                    <AlertTriangle className="h-4 w-4" aria-hidden /> {itensSemCotacao} item(ns) sem nenhuma cotação. A decisão por
                    menor preço fica bloqueada até que alguém responda — o sistema não inventa preço de compra.
                  </Alert>
                ) : null}
              </div>

              {/* resumo */}
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                {[
                  ['Itens', formatNumber(comp.resumo.itens)],
                  ['Fornecedores que cotaram', `${comp.resumo.fornecedores_que_cotaram}/${comp.resumo.fornecedores}`],
                  ['Total estimado (menores preços)', formatMoney(totalEscolhido)],
                  ['Economia potencial', formatMoney(comp.resumo.economia_potencial_total)],
                ].map(([rotulo, valor]) => (
                  <div key={rotulo} className="card p-3">
                    <div className="text-[11px] uppercase tracking-wide text-slate-400">{rotulo}</div>
                    <div className="mt-1 text-lg font-semibold tabular-nums text-navy-900 dark:text-white">{valor}</div>
                  </div>
                ))}
              </div>

              {/* matriz comparativa */}
              <div className="card overflow-hidden">
                <div className="border-b border-slate-100 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-slate-400 dark:border-navy-700">
                  Comparativo item × fornecedor
                </div>
                {comp.itens.length === 0 ? (
                  <EmptyState
                    icon={<FileSpreadsheet className="h-6 w-6" />}
                    title="Nenhum item nesta cotação"
                    description="Adicione os insumos que você quer orçar antes de convidar fornecedores."
                    action={
                      editavel ? (
                        <button type="button" className="btn btn-accent" onClick={() => setAddItemAberto(true)}>
                          <Plus className="h-4 w-4" aria-hidden /> Adicionar item
                        </button>
                      ) : undefined
                    }
                  />
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead className="border-b border-slate-100 text-left text-xs uppercase text-slate-400 dark:border-navy-700">
                        <tr>
                          <th scope="col" className="px-3 py-2">Item</th>
                          <th scope="col" className="px-2 py-2 text-right">Qtd</th>
                          {comp.fornecedores.map((f) => (
                            <th scope="col" key={f.convite_id} className="px-2 py-2 text-right">
                              <div className="max-w-[9rem] truncate" title={f.fornecedor}>{f.fornecedor}</div>
                              <div className="text-[10px] font-normal normal-case text-slate-400">
                                {f.status === 'cotado' ? `${f.itens_cotados} item(ns)` : f.status === 'recusado' ? 'recusou' : 'aguardando'}
                              </div>
                            </th>
                          ))}
                          <th scope="col" className="px-2 py-2 text-right">Melhor</th>
                          <th scope="col" className="px-3 py-2 text-right">Economia</th>
                          {editavel ? <th scope="col" className="px-2 py-2"><span className="sr-only">Ações</span></th> : null}
                        </tr>
                      </thead>
                      <tbody>
                        {comp.itens.map((l) => (
                          <tr key={l.item_id} className="border-b border-slate-50 dark:border-navy-800">
                            <td className="px-3 py-2">
                              <div className="font-medium text-navy-900 dark:text-white">{l.descricao}</div>
                              {l.escolhido_preco !== null ? (
                                <div className="text-[11px] text-emerald-600">
                                  escolhido: {formatMoney(l.escolhido_preco)}
                                </div>
                              ) : null}
                            </td>
                            <td className="px-2 py-2 text-right tabular-nums">
                              {formatNumber(l.quantidade)}
                              {l.unidade ? <span className="ml-1 text-xs text-slate-400">{l.unidade}</span> : null}
                            </td>
                            {comp.fornecedores.map((f) => {
                              const p = l.precos.find((x) => x.convite_id === f.convite_id);
                              const melhor = !!p && p.disponivel && l.menor_preco !== null && p.preco_unitario === l.menor_preco;
                              return (
                                <td
                                  key={f.convite_id}
                                  className={`px-2 py-2 text-right tabular-nums ${melhor ? 'bg-emerald-50 font-semibold text-emerald-700 dark:bg-emerald-950/40' : ''}`}
                                >
                                  {p ? (
                                    <>
                                      {p.disponivel === false ? <span className="text-slate-400 line-through">{formatMoney(p.preco_unitario)}</span> : formatMoney(p.preco_unitario)}
                                      {p.prazo_entrega_dias !== null ? (
                                        <div className="text-[10px] font-normal text-slate-400">{p.prazo_entrega_dias}d</div>
                                      ) : null}
                                    </>
                                  ) : (
                                    <span className="text-slate-300" title="Este fornecedor não cotou este item">—</span>
                                  )}
                                </td>
                              );
                            })}
                            <td className="px-2 py-2 text-right tabular-nums">
                              {l.menor_preco !== null ? (
                                <>
                                  <div className="font-semibold">{formatMoney(l.menor_preco)}</div>
                                  <div className="max-w-[8rem] truncate text-[10px] text-slate-400" title={l.melhor_fornecedor ?? ''}>
                                    {l.melhor_fornecedor}
                                  </div>
                                </>
                              ) : (
                                <span className="text-amber-600">sem cotação</span>
                              )}
                            </td>
                            <td className="px-3 py-2 text-right tabular-nums text-emerald-600">
                              {l.economia_potencial > 0 ? formatMoney(l.economia_potencial) : '—'}
                            </td>
                            {editavel ? (
                              <td className="px-2 py-2 text-right">
                                <button
                                  type="button"
                                  className="btn btn-ghost text-red-600"
                                  aria-label={`Remover ${l.descricao} da cotação`}
                                  onClick={() => setItemRemover(l)}
                                >
                                  <Trash2 className="h-4 w-4" aria-hidden />
                                </button>
                              </td>
                            ) : null}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>

              {/* fornecedores */}
              <div className="card overflow-hidden">
                <div className="border-b border-slate-100 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-slate-400 dark:border-navy-700">
                  Fornecedores convidados
                </div>
                {comp.fornecedores.length === 0 ? (
                  <EmptyState
                    icon={<Factory className="h-6 w-6" />}
                    title="Nenhum fornecedor convidado"
                    description="Convide os fornecedores que devem responder esta cotação."
                  />
                ) : (
                  <ul className="divide-y divide-slate-50 dark:divide-navy-800">
                    {comp.fornecedores.map((f) => (
                      <li key={f.convite_id} className="flex flex-wrap items-center gap-3 px-3 py-2.5">
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm font-medium text-navy-900 dark:text-white">{f.fornecedor}</div>
                          <div className="text-xs text-slate-400">
                            {f.status === 'cotado' ? (
                              <>
                                {f.itens_cotados} de {comp.resumo.itens} item(ns)
                                {f.total_cotado !== null ? ` · total ${formatMoney(f.total_cotado)}` : ' · cotação parcial'}
                                {f.frete > 0 ? ` · frete ${formatMoney(f.frete)}` : ''}
                                {f.prazo_entrega_dias !== null ? ` · ${f.prazo_entrega_dias} dias` : ''}
                                {f.condicao_pagamento ? ` · ${f.condicao_pagamento}` : ''}
                              </>
                            ) : f.status === 'recusado' ? (
                              'Recusou participar'
                            ) : (
                              'Aguardando resposta'
                            )}
                            {f.respondeu_em ? ` · ${formatDateTime(f.respondeu_em)}` : ''}
                          </div>
                        </div>
                        <Badge tone={f.status === 'cotado' ? 'green' : f.status === 'recusado' ? 'red' : 'amber'}>
                          {f.status === 'cotado' ? 'Cotou' : f.status === 'recusado' ? 'Recusou' : 'Convidado'}
                        </Badge>
                        {cotando ? (
                          <>
                            <button type="button" className="btn btn-secondary" onClick={() => abrirCotacaoDeFornecedor(f)}>
                              {f.status === 'cotado' ? 'Editar preços' : 'Registrar cotação'}
                            </button>
                            {f.status === 'convidado' && (
                              <button type="button" className="btn btn-ghost" onClick={() => void recusarFornecedor(f)}>
                                Recusou
                              </button>
                            )}
                          </>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </>
          )}
        </div>
      </div>

      {/* ------------------------------------------------------- nova cotação */}
      <Modal
        open={novaAberta}
        onClose={() => setNovaAberta(false)}
        title="Nova cotação de compra"
        footer={
          <>
            <button type="button" className="btn-secondary" onClick={() => setNovaAberta(false)} disabled={salvando}>Cancelar</button>
            <button type="button" className="btn-accent" disabled={salvando} onClick={() => void criarCotacao()}>
              {salvando ? 'Criando...' : 'Criar cotação'}
            </button>
          </>
        }
      >
        <div className="space-y-3">
          <div>
            <label className="label" htmlFor="cot-titulo">Título</label>
            <input
              id="cot-titulo"
              className="input w-full"
              value={novoTitulo}
              onChange={(e) => setNovoTitulo(e.target.value)}
              placeholder="Ex.: Cotação de tecidos — outubro"
              autoFocus
            />
          </div>
          <div>
            <label className="label" htmlFor="cot-criterio">Critério de decisão</label>
            <select id="cot-criterio" className="input w-full" value={novoCriterio} onChange={(e) => setNovoCriterio(e.target.value)}>
              {CRITERIOS.map((c) => (
                <option key={c.value} value={c.value}>{c.label}</option>
              ))}
            </select>
            <p className="mt-1 text-xs text-slate-400">{CRITERIOS.find((c) => c.value === novoCriterio)?.hint}</p>
          </div>
          <div>
            <label className="label" htmlFor="cot-prazo">Validade das propostas</label>
            <input id="cot-prazo" type="date" className="input w-full" value={novoPrazo} onChange={(e) => setNovoPrazo(e.target.value)} />
          </div>
          <Alert tone="blue">Depois de criada, adicione os itens e convide os fornecedores. Convidar já abre a cotação para respostas.</Alert>
        </div>
      </Modal>

      {/* ------------------------------------------------------- adicionar item */}
      <Modal
        open={addItemAberto}
        onClose={() => setAddItemAberto(false)}
        title="Adicionar item à cotação"
        size="sm"
        footer={
          <>
            <button type="button" className="btn-secondary" onClick={() => setAddItemAberto(false)}>Cancelar</button>
            <button type="button" className="btn-accent" onClick={() => void adicionarItem()}>Adicionar</button>
          </>
        }
      >
        <div className="space-y-3">
          <div>
            <label className="label" htmlFor="cot-item-insumo">Insumo</label>
            <select id="cot-item-insumo" className="input w-full" value={itemInsumo} onChange={(e) => setItemInsumo(e.target.value)} autoFocus>
              <option value="">Selecione...</option>
              {insumos.map((i) => (
                <option key={i.id} value={i.id}>{i.nome}</option>
              ))}
            </select>
            {insumos.length === 0 ? <p className="mt-1 text-xs text-amber-600">Nenhum insumo cadastrado.</p> : null}
          </div>
          <div>
            <label className="label" htmlFor="cot-item-qtd">Quantidade</label>
            <input
              id="cot-item-qtd"
              type="text"
              inputMode="decimal"
              placeholder="1"
              autoComplete="off"
              className="input w-full"
              value={itemQtd}
              onChange={(e) => setItemQtd(e.target.value)}
            />
          </div>
        </div>
      </Modal>

      {/* ---------------------------------------------------------- convidar */}
      <Modal
        open={addConviteAberto}
        onClose={() => setAddConviteAberto(false)}
        title="Convidar fornecedores"
        footer={
          <>
            <button type="button" className="btn-secondary" onClick={() => setAddConviteAberto(false)}>Cancelar</button>
            <button type="button" className="btn-accent" disabled={!conviteFornecedores.length} onClick={() => void convidar()}>
              Convidar {conviteFornecedores.length ? `(${conviteFornecedores.length})` : ''}
            </button>
          </>
        }
      >
        <div className="max-h-72 space-y-1 overflow-y-auto">
          {fornecedores.map((f) => {
            const ja = comp?.fornecedores.some((x) => x.fornecedor_id === f.id) ?? false;
            const marcado = conviteFornecedores.includes(f.id);
            return (
              <label key={f.id} className={`flex items-center gap-2 rounded px-2 py-1.5 text-sm ${ja ? 'opacity-50' : 'hover:bg-slate-50 dark:hover:bg-navy-800'}`}>
                <input
                  type="checkbox"
                  checked={marcado}
                  disabled={ja}
                  onChange={(e) =>
                    setConviteFornecedores((atual) => (e.target.checked ? [...atual, f.id] : atual.filter((x) => x !== f.id)))
                  }
                />
                <span className="text-navy-900 dark:text-white">{f.nome}</span>
                {ja ? <span className="ml-auto text-xs text-slate-400">já convidado</span> : null}
              </label>
            );
          })}
          {fornecedores.length === 0 ? <p className="px-2 py-1 text-xs text-amber-600">Nenhum fornecedor cadastrado.</p> : null}
        </div>
      </Modal>

      {/* --------------------------------------------- preços do fornecedor */}
      <Modal
        open={cotandoConvite !== null}
        onClose={() => setCotandoConvite(null)}
        title={`Cotação de ${cotandoConvite?.fornecedor ?? ''}`}
        footer={
          <>
            <button type="button" className="btn-secondary" onClick={() => setCotandoConvite(null)}>Cancelar</button>
            <button type="button" className="btn-accent" onClick={() => void gravarCotacaoFornecedor()}>Registrar cotação</button>
          </>
        }
      >
        <div className="space-y-3">
          <Alert tone="blue">Preencha só os itens que este fornecedor orçou. Reenviar atualiza os preços — não duplica linha.</Alert>
          <div>
            <label className="label" htmlFor="cot-frete">Frete total (R$)</label>
            {/* text + inputMode=decimal, igual ao RecordForm: type="number"
                recusaria a vírgula que o teclado brasileiro digita. */}
            <input id="cot-frete" type="text" inputMode="decimal" placeholder="0,00" autoComplete="off" className="input w-full" value={cotandoFrete} onChange={(e) => setCotandoFrete(e.target.value)} />
          </div>
          <div className="overflow-hidden rounded border border-slate-100 dark:border-navy-700">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-left text-xs uppercase text-slate-400 dark:bg-navy-800">
                <tr>
                  <th scope="col" className="px-2 py-1.5">Item</th>
                  <th scope="col" className="px-2 py-1.5 text-right">Preço unit. (R$)</th>
                  <th scope="col" className="px-2 py-1.5 text-right">Prazo (d)</th>
                  <th scope="col" className="px-2 py-1.5 text-center">Tem</th>
                </tr>
              </thead>
              <tbody>
                {(comp?.itens ?? []).map((l) => {
                  const v = cotandoPrecos[l.item_id] ?? { preco: '', prazo: '', disponivel: true };
                  return (
                    <tr key={l.item_id} className="border-t border-slate-100 dark:border-navy-700">
                      <td className="px-2 py-1.5">
                        <div className="text-navy-900 dark:text-white">{l.descricao}</div>
                        <div className="text-[11px] text-slate-400">{formatNumber(l.quantidade)} {l.unidade}</div>
                      </td>
                      <td className="px-2 py-1.5">
                        <input
                          type="text"
                          inputMode="decimal"
                          placeholder="0,00"
                          autoComplete="off"
                          aria-label={`Preço unitário de ${l.descricao}`}
                          className="input w-24 text-right"
                          value={v.preco}
                          onChange={(e) => setCotandoPrecos((p) => ({ ...p, [l.item_id]: { ...v, preco: e.target.value } }))}
                        />
                      </td>
                      <td className="px-2 py-1.5">
                        <input
                          type="number"
                          min={0}
                          step="1"
                          aria-label={`Prazo de entrega de ${l.descricao}`}
                          className="input w-20 text-right"
                          value={v.prazo}
                          onChange={(e) => setCotandoPrecos((p) => ({ ...p, [l.item_id]: { ...v, prazo: e.target.value } }))}
                        />
                      </td>
                      <td className="px-2 py-1.5 text-center">
                        <input
                          type="checkbox"
                          aria-label={`Disponível: ${l.descricao}`}
                          checked={v.disponivel}
                          onChange={(e) => setCotandoPrecos((p) => ({ ...p, [l.item_id]: { ...v, disponivel: e.target.checked } }))}
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </Modal>

      {/* ---------------------------------------------------- confirmações */}
      <ConfirmDialog
        open={confirmarDecisao}
        title="Decidir cotação e gerar pedido de compra"
        message={
          comp
            ? `Será criado um pedido de compra com ${comp.resumo.itens} item(ns) pelo critério "${criterioInfo?.label ?? comp.cotacao.criterio}", totalizando aproximadamente ${formatMoney(totalEscolhido)}. O pedido nasce como "Pendente" e passa pelo fluxo normal de aprovação e recebimento.`
            : ''
        }
        confirmLabel={decidindo ? 'Gerando...' : 'Gerar pedido de compra'}
        busy={decidindo}
        onConfirm={() => void decidir()}
        onCancel={() => setConfirmarDecisao(false)}
      />
      <ConfirmDialog
        open={confirmarCancelamento}
        title="Cancelar esta cotação?"
        message="A cotação e as propostas recebidas saem do fluxo. Nada de estoque ou financeiro é afetado — nenhuma compra é criada."
        danger
        busy={cancelando}
        confirmLabel={cancelando ? 'Cancelando...' : 'Cancelar cotação'}
        onConfirm={() => void cancelar()}
        onCancel={() => setConfirmarCancelamento(false)}
      />
      <ConfirmDialog
        open={itemRemover !== null}
        title="Remover item da cotação?"
        message={itemRemover ? `"${itemRemover.descricao}" sai do carrinho. Os preços já recebidos para ele deixam de contar no comparativo.` : ''}
        danger
        confirmLabel="Remover item"
        onConfirm={() => void removerItem()}
        onCancel={() => setItemRemover(null)}
      />
    </div>
  );
}
