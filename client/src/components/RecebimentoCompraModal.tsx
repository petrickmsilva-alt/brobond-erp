import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Box, CheckCircle2, ChevronRight, History, Landmark, Loader2, RefreshCw, TriangleAlert, Warehouse, X } from 'lucide-react';
import { api } from '../lib/api';
import { Alert, Badge, Modal, Spinner, useToast } from './ui';
import { formatDate, formatMoney, formatNumber } from '../lib/format';

/**
 * Recebimento de compra — E3.2.
 *
 * O que esta tela existe para impedir
 * ----------------------------------
 * Antes só havia um botão "Marcar como recebido" que recebia o pedido INTEIRO.
 * O recebimento parcial (`POST /compras/:id/receber`) existia no backend e não
 * tinha tela, então ninguém conseguia receber 40 de 100 — e ninguém via o custo
 * que estava entrando.
 *
 * Regra de ouro desta tela: **nenhum número é calculado aqui**. O impacto
 * projetado vem de `POST /compras/:id/receber { previsao: true }`, que roda a
 * MESMA rotina canônica de custo (`server/src/custoRecebimento.ts`) dentro de
 * uma transação desfeita. Recalcular no cliente criaria uma segunda regra que
 * fatalmente divergiria da que grava.
 *
 * Quando o backend não sabe algo, a tela diz "não informado" / "não calculado".
 * Nunca preenche com estimativa.
 */

type ItemCompra = {
  item_compra_id: number;
  quantidade: number;
  quantidade_recebida: number;
  restante: number;
  // campos que vêm da listagem de itens (podem faltar em respostas antigas)
  produto_id?: number | null;
  insumo_id?: number | null;
  tamanho_id?: number | null;
  preco_unitario?: number | string;
  codigo_fornecedor?: string | null;
  unidade?: string | null;
  ncm?: string | null;
  cfop?: string | null;
  custo_frete_rateado?: number | string;
  custo_impostos?: number | string;
  label?: string;
  sku?: string | null;
};

type RecebimentoAnterior = {
  id: number;
  data?: string;
  criado_em?: string;
  total?: number | string;
  completo?: boolean;
  documento?: string | null;
  observacoes?: string | null;
};

type CustoDaLinha = {
  item_compra_id: number;
  custo_frete_rateado: number;
  custo_impostos: number;
  custo_unitario_efetivo: number;
  custo_medio_antes: number;
  custo_medio_depois: number;
  quantidade: number;
  insumo_id: number | null;
  produto_id: number | null;
  local?: string;
};

type Previsao = {
  custos: CustoDaLinha[];
  total: number;
  local: string;
  completo: boolean;
  itens: { item_compra_id: number; quantidade: number; quantidade_recebida: number; restante: number }[];
};

type Resultado = {
  recebimento_id?: number;
  status?: string;
  custos?: CustoDaLinha[];
  entradas?: unknown[];
  total?: number;
};

const NAO_INFORMADO = 'Não informado';
const NAO_CALCULADO = 'Não calculado';

const num = (v: unknown): number => {
  const n = typeof v === 'string' ? Number(String(v).replace(',', '.')) : Number(v);
  return Number.isFinite(n) ? n : 0;
};
/** Aceita "40", "40,5" e "1.234,5" — o teclado brasileiro usa vírgula. */
const parseQtd = (texto: string): number => {
  const limpo = texto.trim().replace(/\./g, '').replace(',', '.');
  if (!limpo) return 0;
  const n = Number(limpo);
  return Number.isFinite(n) ? n : 0;
};

export default function RecebimentoCompraModal({
  compraId,
  onClose,
  onRecebido,
}: {
  compraId: number;
  onClose: () => void;
  onRecebido: () => void;
}) {
  const toast = useToast();
  const [compra, setCompra] = useState<Record<string, any> | null>(null);
  const [itens, setItens] = useState<ItemCompra[]>([]);
  const [historico, setHistorico] = useState<RecebimentoAnterior[]>([]);
  const [qtd, setQtd] = useState<Record<number, string>>({});
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState<string | null>(null);
  const [previsao, setPrevisao] = useState<Previsao | null>(null);
  const [prevendo, setPrevendo] = useState(false);
  const [erroPrevisao, setErroPrevisao] = useState<string | null>(null);
  const [confirmando, setConfirmando] = useState(false);
  const [etapa, setEtapa] = useState<'edicao' | 'confirmacao' | 'sucesso'>('edicao');
  const [resultado, setResultado] = useState<Resultado | null>(null);

  const carregar = useCallback(async () => {
    setCarregando(true);
    setErro(null);
    try {
      const [c, rec] = await Promise.all([
        api.get<Record<string, any>>(`/compras/${compraId}`),
        api.get<{ itens: any[]; recebimentos: RecebimentoAnterior[] }>(`/compras/${compraId}/recebimentos`),
      ]);
      setCompra(c);
      const detalhe = await api.get<any[]>(`/compras/${compraId}/itens`);
      const porId = new Map(detalhe.map((d) => [Number(d.id), d]));
      const linhas: ItemCompra[] = (rec.itens || []).map((i) => {
        const d = porId.get(Number(i.item_compra_id)) || {};
        return {
          ...i,
          produto_id: d.produto_id ?? null,
          insumo_id: d.insumo_id ?? null,
          tamanho_id: d.tamanho_id ?? null,
          preco_unitario: d.preco_unitario,
          codigo_fornecedor: d.codigo_fornecedor ?? null,
          unidade: d.unidade ?? null,
          ncm: d.ncm ?? null,
          cfop: d.cfop ?? null,
          custo_frete_rateado: d.custo_frete_rateado,
          custo_impostos: d.custo_impostos,
          label: d.produto_id__label || d.insumo_id__label || d.codigo_fornecedor || `Item #${i.item_compra_id}`,
          sku: d.sku ?? d.codigo ?? null,
        };
      });
      setItens(linhas);
      setHistorico(rec.recebimentos || []);
      // Quantidade sugerida: o que falta. É o caso mais comum e evita digitar.
      setQtd(Object.fromEntries(linhas.map((l) => [l.item_compra_id, l.restante > 0 ? String(l.restante) : ''])));
      setPrevisao(null);
      setErroPrevisao(null);
    } catch (e: any) {
      setErro(e?.message || 'Não foi possível carregar o recebimento.');
    } finally {
      setCarregando(false);
    }
  }, [compraId]);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  const linhasValidas = useMemo(
    () =>
      itens
        .map((i) => ({ item_compra_id: i.item_compra_id, quantidade: parseQtd(qtd[i.item_compra_id] ?? '') }))
        .filter((l) => l.quantidade > 0),
    [itens, qtd]
  );

  /** Erros de quantidade — bloqueiam a prévia E a confirmação. */
  const errosQtd = useMemo(() => {
    const out: string[] = [];
    for (const i of itens) {
      const v = parseQtd(qtd[i.item_compra_id] ?? '');
      if (v < 0) out.push(`${i.label}: a quantidade não pode ser negativa.`);
      if (v > i.restante) out.push(`${i.label}: restam ${formatNumber(i.restante)} — não é possível receber ${formatNumber(v)}.`);
    }
    return out;
  }, [itens, qtd]);

  const totalInformado = useMemo(() => linhasValidas.reduce((a, l) => a + l.quantidade, 0), [linhasValidas]);

  const calcularPrevia = useCallback(async () => {
    if (!linhasValidas.length || errosQtd.length) return;
    setPrevendo(true);
    setErroPrevisao(null);
    try {
      const pv = await api.post<Previsao>(`/compras/${compraId}/receber`, { previsao: true, itens: linhasValidas });
      setPrevisao(pv);
    } catch (e: any) {
      setPrevisao(null);
      setErroPrevisao(e?.message || 'Não foi calcular o impacto deste recebimento.');
    } finally {
      setPrevendo(false);
    }
  }, [compraId, linhasValidas, errosQtd.length]);

  // A prévia fica obsoleta assim que uma quantidade muda.
  useEffect(() => {
    setPrevisao((p) => (p ? null : p));
  }, [qtd]);

  const confirmar = useCallback(async () => {
    if (!previsao) return;
    setConfirmando(true);
    try {
      const r = await api.post<Resultado>(`/compras/${compraId}/receber`, { itens: linhasValidas });
      setResultado(r);
      setEtapa('sucesso');
      toast.success(`Recebimento #${r.recebimento_id ?? '—'} registrado.`);
      onRecebido();
    } catch (e: any) {
      toast.error(e?.message || 'Não foi possível registrar o recebimento.');
      setEtapa('edicao');
    } finally {
      setConfirmando(false);
    }
  }, [compraId, linhasValidas, onRecebido, previsao, toast]);

  const custoPor = useMemo(() => {
    const m = new Map<number, CustoDaLinha>();
    for (const c of previsao?.custos || []) m.set(Number(c.item_compra_id), c);
    return m;
  }, [previsao]);

  const valorIncorporado = useMemo(
    () => (previsao?.custos || []).reduce((a, c) => a + num(c.quantidade) * num(c.custo_unitario_efetivo), 0),
    [previsao]
  );
  const freteDaPrevia = useMemo(() => (previsao?.custos || []).reduce((a, c) => a + num(c.custo_frete_rateado), 0), [previsao]);
  const impostosDaPrevia = useMemo(() => (previsao?.custos || []).reduce((a, c) => a + num(c.custo_impostos), 0), [previsao]);

  const jaRecebidoTotal = useMemo(() => itens.reduce((a, i) => a + num(i.quantidade_recebida), 0), [itens]);
  const pedidoTotal = useMemo(() => itens.reduce((a, i) => a + num(i.quantidade), 0), [itens]);
  const pendenteTotal = useMemo(() => itens.reduce((a, i) => a + num(i.restante), 0), [itens]);

  const podeConfirmar = Boolean(previsao) && errosQtd.length === 0 && linhasValidas.length > 0 && !confirmando;

  return (
    <Modal open onClose={onClose} title={`Receber compra #${compraId}`} subtitle="Quantidade recebida, custo efetivo e impacto no estoque antes de confirmar." size="lg">
      {carregando && <Spinner label="Carregando itens e histórico do pedido..." />}

      {!carregando && erro && (
        <div className="space-y-3">
          <Alert tone="red">{erro}</Alert>
          <button className="btn-secondary" onClick={() => void carregar()}>
            <RefreshCw className="h-4 w-4" /> Tentar novamente
          </button>
        </div>
      )}

      {!carregando && !erro && etapa === 'sucesso' && resultado && (
        <ResultadoRecebimento resultado={resultado} onFechar={onClose} onNovo={async () => { setEtapa('edicao'); setResultado(null); await carregar(); }} />
      )}

      {!carregando && !erro && etapa !== 'sucesso' && (
        <div className="space-y-5">
          {/* ---- contadores: o usuário nunca pode confundir as quatro quantidades ---- */}
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4" role="group" aria-label="Situação do pedido">
            <Contador rotulo="PEDIDO" valor={pedidoTotal} tom="slate" ajuda="Quantidade total comprada" />
            <Contador rotulo="RECEBIDO" valor={jaRecebidoTotal} tom="green" ajuda="O que já entrou em recebimentos anteriores" />
            <Contador rotulo="AGORA" valor={totalInformado} tom="blue" ajuda="O que este recebimento vai dar entrada" />
            <Contador rotulo="PENDENTE" valor={Math.max(0, pendenteTotal - totalInformado)} tom="amber" ajuda="O que continuará faltando depois deste recebimento" />
          </div>

          {etapa === 'confirmacao' && previsao ? (
            <Confirmacao
              previsao={previsao}
              compra={compra}
              itens={itens}
              custoPor={custoPor}
              valorIncorporado={valorIncorporado}
              freteDaPrevia={freteDaPrevia}
              impostosDaPrevia={impostosDaPrevia}
              conf={historico.length}
              onVoltar={() => setEtapa('edicao')}
              onConfirmar={() => void confirmar()}
              confirmando={confirmando}
            />
          ) : (
            <>
              {itens.length === 0 ? (
                <Alert tone="amber">Esta compra não tem itens. Adicione itens ao pedido antes de receber.</Alert>
              ) : (
                <div className="overflow-x-auto">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>Produto / SKU</th>
                        <th className="text-right">Pedido</th>
                        <th className="text-right">Recebido</th>
                        <th className="text-right">A receber</th>
                        <th className="text-right">Neste recebimento</th>
                        <th className="text-right">Restará</th>
                        <th className="text-right">Custo unitário</th>
                        <th className="text-right">Custo efetivo</th>
                      </tr>
                    </thead>
                    <tbody>
                      {itens.map((i) => {
                        const agora = parseQtd(qtd[i.item_compra_id] ?? '');
                        const restara = Math.max(0, num(i.restante) - agora);
                        const excede = agora > num(i.restante);
                        const c = custoPor.get(Number(i.item_compra_id));
                        return (
                          <tr key={i.item_compra_id}>
                            <td>
                              <div className="font-medium">{i.label}</div>
                              <div className="text-xs text-slate-500">
                                {i.sku ? `SKU ${i.sku}` : 'SKU não informado'}
                                {i.codigo_fornecedor ? ` · cód. fornecedor ${i.codigo_fornecedor}` : ''}
                                {i.unidade ? ` · ${i.unidade}` : ''}
                              </div>
                            </td>
                            <td className="text-right tabular-nums">{formatNumber(i.quantidade)}</td>
                            <td className="text-right tabular-nums text-emerald-700">{formatNumber(i.quantidade_recebida)}</td>
                            <td className="text-right tabular-nums text-amber-700">{formatNumber(i.restante)}</td>
                            <td className="text-right">
                              <input
                                aria-label={`Quantidade a receber de ${i.label}`}
                                className={`input w-24 text-right ${excede ? 'border-red-400' : ''}`}
                                type="text"
                                inputMode="numeric"
                                value={qtd[i.item_compra_id] ?? ''}
                                placeholder="0"
                                onChange={(e) => setQtd((m) => ({ ...m, [i.item_compra_id]: e.target.value }))}
                              />
                              {excede && <div className="text-xs text-red-600">máx. {formatNumber(i.restante)}</div>}
                            </td>
                            <td className="text-right tabular-nums">{formatNumber(restara)}</td>
                            <td className="text-right tabular-nums">{i.preco_unitario === undefined ? NAO_INFORMADO : formatMoney(i.preco_unitario)}</td>
                            <td className="text-right tabular-nums">{c ? formatMoney(c.custo_unitario_efetivo) : <span className="text-slate-400">calcule a prévia</span>}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}

              {errosQtd.length > 0 && (
                <Alert tone="red">
                  <ul className="list-inside list-disc space-y-1">
                    {errosQtd.map((e) => (
                      <li key={e}>{e}</li>
                    ))}
                  </ul>
                </Alert>
              )}
              {erroPrevisao && <Alert tone="red">{erroPrevisao}</Alert>}

              {previsao && <PreviaImpacto previsao={previsao} compra={compra} valorIncorporado={valorIncorporado} freteDaPrevia={freteDaPrevia} impostosDaPrevia={impostosDaPrevia} />}

              <div className="flex flex-wrap items-center gap-2 border-t pt-4">
                <button
                  className="btn-secondary"
                  disabled={prevendo || errosQtd.length > 0 || !linhasValidas.length}
                  onClick={() => void calcularPrevia()}
                >
                  {prevendo ? <Loader2 className="h-4 w-4 animate-spin" /> : <Box className="h-4 w-4" />}
                  Calcular impacto
                </button>
                <button
                  className="btn-primary"
                  disabled={!podeConfirmar}
                  onClick={() => setEtapa('confirmacao')}
                  title={previsao ? '' : 'Calcule o impacto antes de confirmar'}
                >
                  <ChevronRight className="h-4 w-4" /> Continuar
                </button>
                {!previsao && <span className="text-xs text-slate-500">Calcule o impacto para ver o custo e o estoque antes de confirmar.</span>}
              </div>

              <HistoricoRecebimentos historico={historico} totalRecebido={jaRecebidoTotal} pendente={pendenteTotal} />
            </>
          )}
        </div>
      )}
    </Modal>
  );
}

function Contador({ rotulo, valor, tom, ajuda }: { rotulo: string; valor: number; tom: 'slate' | 'green' | 'blue' | 'amber'; ajuda: string }) {
  const cores: Record<string, string> = {
    slate: 'border-slate-200 bg-slate-50 text-slate-700',
    green: 'border-emerald-200 bg-emerald-50 text-emerald-700',
    blue: 'border-blue-200 bg-blue-50 text-blue-700',
    amber: 'border-amber-200 bg-amber-50 text-amber-700',
  };
  return (
    <div className={`rounded-lg border px-3 py-2 ${cores[tom]}`} title={ajuda}>
      <div className="text-[11px] font-semibold tracking-wide uppercase opacity-80">{rotulo}</div>
      <div className="text-xl font-bold tabular-nums">{formatNumber(valor)}</div>
    </div>
  );
}

function PreviaImpacto({
  previsao,
  compra,
  valorIncorporado,
  freteDaPrevia,
  impostosDaPrevia,
}: {
  previsao: Previsao;
  compra: Record<string, any> | null;
  valorIncorporado: number;
  freteDaPrevia: number;
  impostosDaPrevia: number;
}) {
  const totalQtde = previsao.custos.reduce((a, c) => a + num(c.quantidade), 0);
  return (
    <div className="grid grid-cols-1 gap-3 lg:grid-cols-3" aria-label="Impacto projetado">
      <section className="card p-4">
        <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold"><Warehouse className="h-4 w-4" /> Estoque</h3>
        <dl className="space-y-1 text-sm">
          <Linha k="Quantidade que entrará" v={formatNumber(totalQtde)} />
          <Linha k="Local" v={previsao.local || NAO_INFORMADO} />
          <Linha k="Valor incorporado" v={formatMoney(valorIncorporado)} forte />
        </dl>
      </section>

      <section className="card p-4">
        <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold"><TriangleAlert className="h-4 w-4" /> Custo</h3>
        <dl className="space-y-1 text-sm">
          {previsao.custos.length === 0 && <div className="text-slate-500">{NAO_CALCULADO}</div>}
          {previsao.custos.map((c) => (
            <div key={`${c.item_compra_id}-${c.insumo_id ?? c.produto_id}`} className="border-b border-slate-100 py-1 last:border-0">
              <div className="text-xs text-slate-500">{c.insumo_id ? `Insumo #${c.insumo_id}` : `Produto #${c.produto_id}`}</div>
              <Linha k="Custo médio atual" v={formatMoney(c.custo_medio_antes)} />
              <Linha k="Custo deste recebimento" v={formatMoney(c.custo_unitario_efetivo)} />
              <Linha k="Custo médio projetado" v={formatMoney(c.custo_medio_depois)} forte />
              <Linha k="Frete rateado na linha" v={formatMoney(c.custo_frete_rateado)} />
              <Linha k="Impostos na linha" v={formatMoney(c.custo_impostos)} />
            </div>
          ))}
        </dl>
      </section>

      <section className="card p-4">
        <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold"><Landmark className="h-4 w-4" /> Financeiro</h3>
        <dl className="space-y-1 text-sm">
          <Linha k="Valor da compra" v={compra?.total === undefined ? NAO_INFORMADO : formatMoney(compra?.total)} />
          <Linha k="Frete" v={formatMoney(freteDaPrevia)} />
          <Linha k="Impostos" v={formatMoney(impostosDaPrevia)} />
          <Linha k="Condição de pagamento" v={compra?.condicao_pagamento || NAO_INFORMADO} />
          <Linha k="Parcelas" v={num(compra?.fin_parcelas) > 0 ? `${num(compra?.fin_parcelas)}×` : NAO_INFORMADO} />
          <Linha k="Vencimento" v={compra?.fin_vencimento ? formatDate(compra.fin_vencimento) : NAO_INFORMADO} />
          <Linha k="Forma de pagamento" v={compra?.fin_forma_pagamento || NAO_INFORMADO} />
          <div className="mt-2 border-t pt-2 text-xs">
            {previsao.completo ? (
              <span className="text-emerald-700">
                Este recebimento completa o pedido — a conta a pagar será gerada com{' '}
                {num(compra?.fin_parcelas) > 0 ? `${num(compra?.fin_parcelas)} parcela(s)` : '1 parcela'}.
              </span>
            ) : (
              <span className="text-amber-700">
                A compra continuará <strong>parcial</strong>: nenhuma conta a pagar é gerada agora. O financeiro nasce quando o
                pedido for totalmente recebido.
              </span>
            )}
          </div>
        </dl>
      </section>
    </div>
  );
}

function Linha({ k, v, forte }: { k: string; v: string; forte?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <dt className="text-slate-500">{k}</dt>
      <dd className={`tabular-nums ${forte ? 'font-semibold' : ''}`}>{v}</dd>
    </div>
  );
}

function Confirmacao({
  previsao,
  compra,
  itens,
  custoPor,
  valorIncorporado,
  freteDaPrevia,
  impostosDaPrevia,
  conf,
  onVoltar,
  onConfirmar,
  confirmando,
}: {
  previsao: Previsao;
  compra: Record<string, any> | null;
  itens: ItemCompra[];
  custoPor: Map<number, CustoDaLinha>;
  valorIncorporado: number;
  freteDaPrevia: number;
  impostosDaPrevia: number;
  conf: number;
  onVoltar: () => void;
  onConfirmar: () => void;
  confirmando: boolean;
}) {
  const porId = new Map(itens.map((i) => [Number(i.item_compra_id), i]));
  return (
    <div className="space-y-4">
      <Alert tone="amber">
        <div className="flex gap-2">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <p className="font-medium">Este recebimento irá movimentar o estoque e atualizar o custo dos produtos.</p>
        </div>
      </Alert>

      <div className="card p-4">
        <h3 className="mb-2 text-sm font-semibold">Resumo do que será gravado</h3>
        <table className="table">
          <thead>
            <tr>
              <th>Item</th>
              <th className="text-right">Quantidade</th>
              <th className="text-right">Custo efetivo</th>
              <th className="text-right">Total</th>
            </tr>
          </thead>
          <tbody>
            {previsao.custos.map((c) => {
              const i = porId.get(Number(c.item_compra_id));
              return (
                <tr key={c.item_compra_id}>
                  <td>{i?.label ?? `Item #${c.item_compra_id}`}</td>
                  <td className="text-right tabular-nums">{formatNumber(c.quantidade)}</td>
                  <td className="text-right tabular-nums">{formatMoney(c.custo_unitario_efetivo)}</td>
                  <td className="text-right tabular-nums">{formatMoney(num(c.quantidade) * num(c.custo_unitario_efetivo))}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <div className="mt-3 grid grid-cols-1 gap-2 text-sm sm:grid-cols-3">
          <Linha k="Valor incorporado ao estoque" v={formatMoney(valorIncorporado)} forte />
          <Linha k="Frete rateado" v={formatMoney(freteDaPrevia)} />
          <Linha k="Impostos" v={formatMoney(impostosDaPrevia)} />
        </div>
        <p className="mt-2 text-xs text-slate-500">
          Local de entrada: <strong>{previsao.local || NAO_INFORMADO}</strong>
          {conf > 0 ? ` · este será o ${conf + 1}º recebimento do pedido` : ''}.
        </p>
      </div>

      <div className="flex flex-wrap gap-2">
        <button className="btn-secondary" onClick={onVoltar} disabled={confirmando}>
          <X className="h-4 w-4" /> Voltar e revisar
        </button>
        <button className="btn-primary" onClick={onConfirmar} disabled={confirmando}>
          {confirmando ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
          Confirmar recebimento
        </button>
      </div>
    </div>
  );
}

function ResultadoRecebimento({ resultado, onFechar, onNovo }: { resultado: Resultado; onFechar: () => void; onNovo: () => void }) {
  const custos = resultado.custos || [];
  const totalQtde = custos.reduce((a, c) => a + num(c.quantidade), 0);
  const valor = custos.reduce((a, c) => a + num(c.quantidade) * num(c.custo_unitario_efetivo), 0);
  return (
    <div className="space-y-4">
      <Alert tone="green">
        <div className="flex items-start gap-2">
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
          <div>
            <p className="font-medium">Recebimento #{resultado.recebimento_id ?? '—'} registrado com sucesso.</p>
            <p className="text-sm">O pedido ficou com status <Badge tone={resultado.status === 'recebido' ? 'green' : 'amber'}>{resultado.status || '—'}</Badge></p>
          </div>
        </div>
      </Alert>

      <div className="card p-4">
        <h3 className="mb-2 text-sm font-semibold">O que mudou</h3>
        <dl className="space-y-1 text-sm">
          <Linha k="Estoque movimentado" v={`${formatNumber(totalQtde)} unidade(s) em "${custos[0]?.local || NAO_INFORMADO}"`} forte />
          <Linha k="Valor incorporado" v={formatMoney(valor)} />
          {custos.map((c) => (
            <div key={c.item_compra_id} className="border-t border-slate-100 pt-1">
              <Linha
                k={`Custo médio ${c.insumo_id ? `do insumo #${c.insumo_id}` : `do produto #${c.produto_id}`}`}
                v={`${formatMoney(c.custo_medio_antes)} → ${formatMoney(c.custo_medio_depois)}`}
                forte
              />
            </div>
          ))}
          {resultado.status === 'recebido' ? (
            <div className="border-t pt-1 text-xs text-emerald-700">
              Pedido completo: a conta a pagar foi gerada no financeiro (veja o plano de parcelas no pedido).
            </div>
          ) : (
            <div className="border-t pt-1 text-xs text-amber-700">
              Pedido ainda parcial: nenhuma conta a pagar foi gerada. Ela nasce quando o pedido for totalmente recebido.
            </div>
          )}
        </dl>
      </div>

      <div className="flex flex-wrap gap-2">
        <button className="btn-secondary" onClick={onNovo}>
          <Box className="h-4 w-4" /> Receber mais um lote
        </button>
        <button className="btn-primary" onClick={onFechar}>
          Concluir
        </button>
      </div>
    </div>
  );
}

function HistoricoRecebimentos({
  historico,
  totalRecebido,
  pendente,
}: {
  historico: RecebimentoAnterior[];
  totalRecebido: number;
  pendente: number;
}) {
  return (
    <section className="card p-4" aria-label="Recebimentos anteriores">
      <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold">
        <History className="h-4 w-4" /> Recebimentos anteriores ({historico.length})
      </h3>
      {historico.length === 0 ? (
        <p className="text-sm text-slate-500">Nenhum recebimento registrado ainda — este será o primeiro.</p>
      ) : (
        <ul className="space-y-1 text-sm">
          {historico.map((h, idx) => (
            <li key={h.id} className="flex flex-wrap items-baseline justify-between gap-2 border-b border-slate-100 py-1 last:border-0">
              <span className="font-medium">
                Recebimento #{String(idx + 1).padStart(3, '0')}
                {h.completo ? ' <span class="text-xs text-slate-500">(fechou o pedido)</span>' : ''}
              </span>
              <span className="text-slate-600">{formatDate(h.data || h.criado_em)}</span>
              <span className="tabular-nums">{h.total === undefined ? NAO_INFORMADO : formatMoney(h.total)}</span>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-2 text-xs text-slate-500">
        Total recebido: <strong className="tabular-nums">{formatNumber(totalRecebido)}</strong> · Pendente:{' '}
        <strong className="tabular-nums">{formatNumber(pendente)}</strong>
      </p>
    </section>
  );
}
