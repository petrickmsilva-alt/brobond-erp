// ============================================================================
// SUGESTÃO DE COMPRA — §17
//
// A regra que esta tela respeita acima de todas: **a sugestão é um cálculo.**
// Nada aqui cria pedido de compra sozinho. O servidor devolve `automatico:
// false` e a tela exige ação explícita do comprador — revisar quantidades,
// escolher fornecedor e confirmar.
//
// Base do cálculo: estoque atual, mínimo e máximo, consumo do período,
// pedidos de venda em aberto e compras já em trânsito.
// ============================================================================
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Calculator, CheckCircle2, ShoppingCart } from 'lucide-react';
import { api, ApiError } from '../lib/api';
import { formatMoney, formatNumber } from '../lib/format';
import type { ListResult } from '../lib/meta';
import { Alert, Badge, EmptyState, PageHeader, Spinner, useToast } from '../components/ui';

type LinhaSugestao = {
  produto_id: number;
  sku: string | null;
  nome: string | null;
  estoque_atual: number;
  estoque_min: number;
  estoque_max: number;
  consumo_medio_mensal: number;
  em_pedidos_venda: number;
  em_compras_transito: number;
  disponivel_projetado: number;
  sugerido: number;
  fornecedor_id: number | null;
  codigo_fornecedor: string | null;
  custo_unitario: number;
  custo_total: number;
  motivo: string;
};

type Sugestao = {
  empresa_id: number;
  periodo_consumo_dias: number;
  automatico: boolean;
  total_itens: number;
  total_unidades: number;
  custo_estimado: number;
  por_fornecedor: Array<{ fornecedor_id: number | null; itens: number; unidades: number; custo: number }>;
  itens: LinhaSugestao[];
};

type Fornecedor = { id: number; nome: string };

const PERIODOS = [30, 60, 90, 180, 365];

export default function SugestaoCompraPage() {
  const toast = useToast();

  const [dias, setDias] = useState(90);
  const [carregando, setCarregando] = useState(true);
  const [sugestao, setSugestao] = useState<Sugestao | null>(null);
  const [fornecedores, setFornecedores] = useState<Fornecedor[]>([]);
  const [erro, setErro] = useState('');
  const [busca, setBusca] = useState('');
  const [soFornecedor, setSoFornecedor] = useState<string>('todos');
  // Quantidades revisadas pelo comprador — a sugestão é ponto de partida, não sentença.
  const [revisao, setRevisao] = useState<Record<number, number>>({});
  const [selecionados, setSelecionados] = useState<Set<number>>(new Set());
  const [gerando, setGerando] = useState(false);
  const [fornecedorEscolhido, setFornecedorEscolhido] = useState('');
  const [observacoes, setObservacoes] = useState('');
  const [previsaoEntrega, setPrevisaoEntrega] = useState('');
  const [criado, setCriado] = useState<{ id: number; total: number } | null>(null);

  const carregar = useCallback(async (periodo: number) => {
    setCarregando(true);
    try {
      const s = await api.get<Sugestao>(`/suprimentos/sugestao-compra?dias=${periodo}`);
      setSugestao(s);
      setRevisao(Object.fromEntries(s.itens.map((l) => [l.produto_id, l.sugerido])));
      setSelecionados(new Set(s.itens.map((l) => l.produto_id)));
      setErro('');
    } catch (e) {
      setErro(e instanceof ApiError ? e.message : 'Não foi possível calcular a sugestão.');
    } finally {
      setCarregando(false);
    }
  }, []);

  useEffect(() => {
    void carregar(dias);
  }, [dias, carregar]);

  useEffect(() => {
    api
      .get<ListResult<Fornecedor>>('/fornecedores?page=1&pageSize=200&sort=nome&dir=asc')
      .then((d) => setFornecedores(d.rows.map((f) => ({ id: Number(f.id), nome: String(f.nome) }))))
      .catch(() => setFornecedores([]));
  }, []);

  const nomeFornecedor = useCallback(
    (id: number | null) => (id === null ? 'Sem fornecedor' : fornecedores.find((f) => f.id === id)?.nome ?? `#${id}`),
    [fornecedores]
  );

  const linhas = useMemo(() => {
    if (!sugestao) return [];
    const q = busca.trim().toLowerCase();
    return sugestao.itens.filter((l) => {
      if (soFornecedor !== 'todos' && String(l.fornecedor_id ?? 'null') !== soFornecedor) return false;
      if (!q) return true;
      return `${l.sku ?? ''} ${l.nome ?? ''}`.toLowerCase().includes(q);
    });
  }, [sugestao, busca, soFornecedor]);

  const totais = useMemo(() => {
    const escolhidas = linhas.filter((l) => selecionados.has(l.produto_id));
    const unidades = escolhidas.reduce((acc, l) => acc + (revisao[l.produto_id] ?? l.sugerido), 0);
    const custo = escolhidas.reduce((acc, l) => acc + (revisao[l.produto_id] ?? l.sugerido) * l.custo_unitario, 0);
    return { itens: escolhidas.length, unidades, custo: Math.round(custo * 100) / 100 };
  }, [linhas, selecionados, revisao]);

  const alternar = (produtoId: number) => {
    setSelecionados((atual) => {
      const novo = new Set(atual);
      if (novo.has(produtoId)) novo.delete(produtoId);
      else novo.add(produtoId);
      return novo;
    });
  };

  const gerarPedido = async () => {
    if (!fornecedorEscolhido) {
      toast.error('Escolha o fornecedor do pedido.');
      return;
    }
    const itens = sugestao
      ? sugestao.itens
          .filter((l) => selecionados.has(l.produto_id) && (revisao[l.produto_id] ?? l.sugerido) > 0)
          .map((l) => ({ produto_id: l.produto_id, quantidade: revisao[l.produto_id] ?? l.sugerido }))
      : [];
    if (!itens.length) {
      toast.error('Selecione ao menos um item com quantidade maior que zero.');
      return;
    }
    setGerando(true);
    try {
      const r = await api.post<{ id: number; total: number }>('/suprimentos/sugestao-compra/gerar', {
        fornecedor_id: Number(fornecedorEscolhido),
        itens,
        previsao_entrega: previsaoEntrega || undefined,
        observacoes: observacoes || undefined,
      });
      setCriado({ id: Number(r.id), total: Number(r.total) });
      setGerando(false);
      setFornecedorEscolhido('');
      setObservacoes('');
      setPrevisaoEntrega('');
      toast.success(`Pedido de compra #${r.id} criado como pendente.`);
      await carregar(dias);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Não foi possível criar o pedido.');
      setGerando(false);
    }
  };

  return (
    <div>
      <PageHeader
        title="Sugestão de compra"
        description="Estoque atual, mínimo e máximo, consumo do período, pedidos em aberto e compras em trânsito. A sugestão nunca gera pedido sozinha."
        actions={
          <div className="flex items-center gap-2">
            <label className="label mb-0 text-xs">
              Consumo
              <select className="input" value={dias} onChange={(e) => setDias(Number(e.target.value))}>
                {PERIODOS.map((p) => (
                  <option key={p} value={p}>
                    {p} dias
                  </option>
                ))}
              </select>
            </label>
            <button className="btn-secondary" onClick={() => void carregar(dias)} disabled={carregando}>
              Recalcular
            </button>
          </div>
        }
      />

      {erro && (
        <div className="mb-4">
          <Alert tone="red">{erro}</Alert>
        </div>
      )}

      {sugestao && (
        <div className="mb-4">
          <Alert tone="blue">
            <div className="flex items-start gap-2">
              <Calculator className="mt-0.5 h-4 w-4 shrink-0" />
              <span>
                Isto é um cálculo <strong>não automático</strong> ({sugestao.automatico ? 'automático' : 'automático: não'}).
                Nada vira pedido sem você confirmar. Período de consumo: {sugestao.periodo_consumo_dias} dias.
              </span>
            </div>
          </Alert>
        </div>
      )}

      {criado && (
        <div className="mb-4">
          <Alert tone="green">
            <div className="flex items-start gap-2">
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
              <span>
                Pedido de compra <strong>#{criado.id}</strong> criado com {formatMoney(criado.total)}, status{' '}
                <strong>pendente</strong> — precisa de aprovação antes de qualquer recebimento.
                <button className="btn-ghost ml-2" onClick={() => setCriado(null)}>
                  dispensar
                </button>
              </span>
            </div>
          </Alert>
        </div>
      )}

      {carregando ? (
        <Spinner label="Calculando sugestão..." />
      ) : !sugestao || sugestao.total_itens === 0 ? (
        <div className="card">
          <EmptyState
            icon={<ShoppingCart className="h-6 w-6" />}
            title="Nada a comprar"
            description="Nenhum produto com estoque mínimo definido está abaixo do ponto de reposição. Produtos sem estoque_min não entram no cálculo."
          />
        </div>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
          <div className="space-y-3">
            <div className="card grid gap-2 p-3 sm:grid-cols-[1fr_200px]">
              <input
                className="input"
                placeholder="Buscar por SKU ou nome"
                value={busca}
                onChange={(e) => setBusca(e.target.value)}
              />
              <select className="input" value={soFornecedor} onChange={(e) => setSoFornecedor(e.target.value)}>
                <option value="todos">Todos os fornecedores</option>
                {sugestao.por_fornecedor.map((g) => (
                  <option key={String(g.fornecedor_id)} value={String(g.fornecedor_id ?? 'null')}>
                    {nomeFornecedor(g.fornecedor_id)} ({g.itens})
                  </option>
                ))}
              </select>
            </div>

            <div className="card overflow-hidden">
              <table className="w-full text-sm">
                <thead className="border-b border-slate-100 text-left text-xs uppercase text-slate-400 dark:border-navy-700">
                  <tr>
                    <th className="px-3 py-2" />
                    <th className="px-3 py-2">Produto</th>
                    <th className="px-2 py-2 text-right">Atual</th>
                    <th className="px-2 py-2 text-right">Mín</th>
                    <th className="px-2 py-2 text-right">Em venda</th>
                    <th className="px-2 py-2 text-right">Em trânsito</th>
                    <th className="px-2 py-2 text-right">Comprar</th>
                    <th className="px-3 py-2 text-right">Custo</th>
                  </tr>
                </thead>
                <tbody>
                  {linhas.map((l) => {
                    const qtd = revisao[l.produto_id] ?? l.sugerido;
                    const critico = l.estoque_atual <= 0;
                    return (
                      <tr key={l.produto_id} className="border-b border-slate-50 dark:border-navy-800">
                        <td className="px-3 py-2">
                          <input
                            type="checkbox"
                            checked={selecionados.has(l.produto_id)}
                            onChange={() => alternar(l.produto_id)}
                            aria-label={`Incluir ${l.sku ?? l.produto_id}`}
                          />
                        </td>
                        <td className="px-3 py-2">
                          <div className="font-medium text-navy-900 dark:text-white">{l.nome ?? `#${l.produto_id}`}</div>
                          <div className="text-xs text-slate-400">
                            {l.sku} · {nomeFornecedor(l.fornecedor_id)}
                            {l.codigo_fornecedor ? ` · cód. ${l.codigo_fornecedor}` : ''}
                          </div>
                          <div className="mt-0.5 text-[11px] text-slate-400">{l.motivo}</div>
                        </td>
                        <td className={`px-2 py-2 text-right tabular-nums ${critico ? 'font-semibold text-red-600' : ''}`}>
                          {formatNumber(l.estoque_atual)}
                        </td>
                        <td className="px-2 py-2 text-right tabular-nums text-slate-500">{formatNumber(l.estoque_min)}</td>
                        <td className="px-2 py-2 text-right tabular-nums text-slate-500">{formatNumber(l.em_pedidos_venda)}</td>
                        <td className="px-2 py-2 text-right tabular-nums text-slate-500">{formatNumber(l.em_compras_transito)}</td>
                        <td className="px-2 py-2 text-right">
                          <input
                            type="number"
                            min={0}
                            step={1}
                            className="input w-20 text-right"
                            value={qtd}
                            onChange={(e) =>
                              setRevisao((r) => ({ ...r, [l.produto_id]: Math.max(0, Math.trunc(Number(e.target.value) || 0)) }))
                            }
                          />
                          {qtd !== l.sugerido && (
                            <div className="text-[10px] text-amber-600">sugerido {l.sugerido}</div>
                          )}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">{formatMoney(qtd * l.custo_unitario)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {linhas.length === 0 && (
                <EmptyState icon={<ShoppingCart className="h-6 w-6" />} title="Nada neste filtro" />
              )}
            </div>
          </div>

          <div className="space-y-4">
            <div className="card p-4">
              <h3 className="mb-2 text-sm font-semibold text-navy-900 dark:text-white">Seleção</h3>
              <dl className="space-y-1 text-sm">
                <div className="flex justify-between">
                  <dt className="text-slate-500 dark:text-navy-300">Itens</dt>
                  <dd className="tabular-nums">{formatNumber(totais.itens)}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-slate-500 dark:text-navy-300">Unidades</dt>
                  <dd className="tabular-nums">{formatNumber(totais.unidades)}</dd>
                </div>
                <div className="flex items-baseline justify-between border-t border-slate-100 pt-2 dark:border-navy-700">
                  <dt className="font-semibold text-navy-900 dark:text-white">Custo estimado</dt>
                  <dd className="text-lg font-bold tabular-nums text-navy-900 dark:text-white">{formatMoney(totais.custo)}</dd>
                </div>
              </dl>
              <p className="mt-2 text-[11px] text-slate-400">
                Custo usa o custo unitário do cadastro. No pedido, vale o preço revisado ou o custo do produto.
              </p>
            </div>

            <div className="card p-4">
              <h3 className="mb-2 text-sm font-semibold text-navy-900 dark:text-white">Gerar pedido de compra</h3>
              <label className="label">
                Fornecedor
                <select className="input" value={fornecedorEscolhido} onChange={(e) => setFornecedorEscolhido(e.target.value)}>
                  <option value="">Selecione…</option>
                  {fornecedores.map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.nome}
                    </option>
                  ))}
                </select>
              </label>
              <label className="label">
                Previsão de entrega
                <input type="date" className="input" value={previsaoEntrega} onChange={(e) => setPrevisaoEntrega(e.target.value)} />
              </label>
              <label className="label">
                Observações
                <textarea
                  className="input min-h-20"
                  value={observacoes}
                  onChange={(e) => setObservacoes(e.target.value)}
                  placeholder="Gerado a partir da sugestão de compra."
                />
              </label>
              <button
                className="btn-accent mt-2 w-full"
                onClick={() => void gerarPedido()}
                disabled={gerando || !fornecedorEscolhido || totais.itens === 0}
              >
                <ShoppingCart className="h-4 w-4" />
                {gerando ? 'Criando…' : `Criar pedido (${totais.itens} itens)`}
              </button>
              <p className="mt-2 text-[11px] leading-snug text-slate-400">
                O pedido entra como <strong>pendente</strong> e só recebe estoque depois de aprovado e recebido.
              </p>
            </div>

            <div className="card p-4">
              <h3 className="mb-2 text-sm font-semibold text-navy-900 dark:text-white">Por fornecedor</h3>
              <ul className="space-y-1.5 text-sm">
                {sugestao.por_fornecedor.map((g) => (
                  <li key={String(g.fornecedor_id)} className="flex items-center justify-between gap-2">
                    <span className="truncate text-slate-600 dark:text-navy-200">{nomeFornecedor(g.fornecedor_id)}</span>
                    <Badge tone="slate">
                      {g.itens} itens · {formatNumber(g.unidades)} un · {formatMoney(g.custo)}
                    </Badge>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}
