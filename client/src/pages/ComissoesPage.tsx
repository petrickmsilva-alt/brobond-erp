// ============================================================================
// COMISSÕES — o livro de efetivação visto por quem paga.
//
// A REGRA (e a tela diz isso em voz alta, para não inventar outra):
//   • APURADA    — congela no faturamento (`vendas.comissao_valor`), por
//                  representante, no período;
//   • EFETIVADA  — só vira comissão devida quando o DINHEIRO da venda entra
//                  (baixa, conciliação, pagamento no balcão/PDV). Recebimento
//                  parcial efetiva a parte proporcional;
//   • ESTORNADA  — venda cancelada devolve o que já havia sido efetivado;
//   • SALDO      — efetivada − estornada: é o que o representante tem a
//                  receber pelo que já entrou.
//
// Nada aqui paga, marca "pago" ou fecha estado: esse estado não existe no
// servidor e a tela NÃO inventa um. O "fechamento do período" desta tela é a
// CONFERÊNCIA — os mesmos números que o relatório de comissões publica, com o
// livro de cada venda a um clique e a igualdade conferida na frente do
// operador (botão "Conferir com o relatório").
// ============================================================================
import { useCallback, useEffect, useMemo, useState } from 'react';
import { BadgeDollarSign, CalendarRange, ClipboardCheck, Receipt, Undo2 } from 'lucide-react';
import { api, ApiError } from '../lib/api';
import { formatDate, formatMoney, formatNumber, formatPct } from '../lib/format';
import { Alert, Badge, EmptyState, Modal, PageHeader, Spinner, useToast } from '../components/ui';

type LinhaComissao = {
  representante_id: number;
  representante: string;
  apurada: number;
  efetivada: number;
  estornada: number;
  saldo: number;
  vendas: number;
};

type ResumoComissoes = {
  periodo: { de: string | null; ate: string | null };
  linhas: LinhaComissao[];
  resumo: { apurada: number; efetivada: number; estornada: number; saldo: number };
};

type EventoComissao = {
  id: number;
  tipo: string;
  base: number | string;
  pct: number | string;
  valor: number | string;
  origem: string | null;
  usuario: string | null;
  observacoes: string | null;
  criado_em: string | null;
};

type LivroDaVenda = {
  venda_id: number;
  apurada: number;
  pct: number;
  efetivada: number;
  eventos: EventoComissao[];
};

type VendaDoRepresentante = {
  id: number;
  data: string | null;
  faturada_em: string | null;
  status: string;
  total: number | string;
  comissao_pct: number | string | null;
  comissao_valor: number | string | null;
};

type LinhaRelatorio = { representante_id?: number; representante: string; comissao: number };

type RelatorioComissoes = {
  linhas: LinhaRelatorio[];
  resumo?: { comissao: number; valor: number };
};

function hoje(): string {
  const agora = new Date();
  return new Date(agora.getTime() - agora.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
}

/** Primeiro dia do mês corrente (o fechamento mais frequente é o do mês). */
function inicioDoMes(): string {
  return `${hoje().slice(0, 7)}-01`;
}

function mesAnterior(): { de: string; ate: string } {
  const [ano, mes] = hoje().split('-').map(Number);
  const primeiro = new Date(Date.UTC(ano, mes - 2, 1));
  const ultimo = new Date(Date.UTC(ano, mes - 1, 0));
  return { de: primeiro.toISOString().slice(0, 10), ate: ultimo.toISOString().slice(0, 10) };
}

const ORDEM_EVENTO: Record<string, string> = { realizada: 'efetivada', estornada: 'estornada' };

export default function ComissoesPage() {
  const toast = useToast();

  const [de, setDe] = useState(inicioDoMes());
  const [ate, setAte] = useState(hoje());
  const [dados, setDados] = useState<ResumoComissoes | null>(null);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState('');

  const [conferencia, setConferencia] = useState<{ comissao: number; confere: boolean } | null>(null);
  const [conferindo, setConferindo] = useState(false);

  // Drill-down do representante: as vendas do período e o livro de cada uma.
  const [detalhe, setDetalhe] = useState<LinhaComissao | null>(null);
  const [vendas, setVendas] = useState<VendaDoRepresentante[]>([]);
  const [carregandoVendas, setCarregandoVendas] = useState(false);
  const [livro, setLivro] = useState<LivroDaVenda | null>(null);

  const carregar = useCallback(async () => {
    setCarregando(true);
    try {
      const d = await api.get<ResumoComissoes>(`/financeiro/comissoes?de=${de}&ate=${ate}`);
      setDados(d);
      setErro('');
    } catch (e) {
      setErro(e instanceof ApiError ? e.message : 'Não foi possível carregar as comissões.');
    } finally {
      setCarregando(false);
    }
  }, [de, ate]);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  // A conferência (critério de aceite do ERP-06): a soma APURADA da tela tem de
  // bater com o total do relatório `comissoes` para o MESMO período.
  const conferirComRelatorio = async () => {
    setConferindo(true);
    try {
      const r = await api.get<RelatorioComissoes>(`/relatorios/comissoes?de=${de}&ate=${ate}`);
      const totalRelatorio = Number(r.resumo?.comissao ?? r.linhas.reduce((s, l) => s + Number(l.comissao || 0), 0));
      const totalTela = Number(dados?.resumo.apurada ?? 0);
      const confere = Math.abs(totalRelatorio - totalTela) < 0.005;
      setConferencia({ comissao: totalRelatorio, confere });
      if (confere) toast.success(`Confere: ${formatMoney(totalTela)} apurados nos dois lados.`);
      else toast.error(`Divergência: tela ${formatMoney(totalTela)} × relatório ${formatMoney(totalRelatorio)}.`);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Não foi possível ler o relatório de comissões.');
    } finally {
      setConferindo(false);
    }
  };

  const abrirRepresentante = async (linha: LinhaComissao) => {
    setDetalhe(linha);
    setLivro(null);
    setVendas([]);
    setCarregandoVendas(true);
    try {
      const d = await api.get<{ rows: VendaDoRepresentante[] }>(
        `/vendas?page=1&pageSize=200&sort=id&dir=desc&f.representante_id=${linha.representante_id}&f.data_de=${de}&f.data_ate=${ate}`
      );
      setVendas(d.rows);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Não foi possível carregar as vendas do representante.');
    } finally {
      setCarregandoVendas(false);
    }
  };

  const abrirLivro = async (vendaId: number) => {
    try {
      setLivro(await api.get<LivroDaVenda>(`/financeiro/comissoes/venda/${vendaId}`));
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Não foi possível ler o livro da venda.');
    }
  };

  const linhas = dados?.linhas ?? [];
  const cards = useMemo(
    () => [
      { rotulo: 'Apurada no período', valor: Number(dados?.resumo.apurada ?? 0), tom: 'text-slate-900 dark:text-slate-100' },
      { rotulo: 'Efetivada (recebida)', valor: Number(dados?.resumo.efetivada ?? 0), tom: 'text-emerald-600 dark:text-emerald-400' },
      { rotulo: 'Estornada', valor: Number(dados?.resumo.estornada ?? 0), tom: 'text-red-600 dark:text-red-400' },
      { rotulo: 'Saldo a receber do representante', valor: Number(dados?.resumo.saldo ?? 0), tom: 'text-blue-600 dark:text-blue-400' },
    ],
    [dados]
  );

  return (
    <div>
      <PageHeader
        title="Comissões"
        description="Apuração no faturamento, efetivação conforme o RECEBIMENTO da venda. Esta tela confere e fecha o período — ela não marca comissão como paga, porque esse estado não existe: quem efetiva é o dinheiro que entra."
        actions={
          <button className="btn-secondary" onClick={() => void conferirComRelatorio()} disabled={conferindo || carregando}>
            <ClipboardCheck className="mr-1 h-4 w-4" /> {conferindo ? 'Conferindo…' : 'Conferir com o relatório'}
          </button>
        }
      />

      <div className="card mb-4 flex flex-wrap items-end gap-3 p-4">
        <div>
          <label className="label" htmlFor="comissoes-de">
            De
          </label>
          <input id="comissoes-de" type="date" className="input" value={de} onChange={(e) => setDe(e.target.value)} />
        </div>
        <div>
          <label className="label" htmlFor="comissoes-ate">
            Até
          </label>
          <input id="comissoes-ate" type="date" className="input" value={ate} onChange={(e) => setAte(e.target.value)} />
        </div>
        <button className="btn-secondary" onClick={() => { setDe(inicioDoMes()); setAte(hoje()); }}>
          <CalendarRange className="mr-1 h-4 w-4" /> Mês atual
        </button>
        <button
          className="btn-secondary"
          onClick={() => {
            const m = mesAnterior();
            setDe(m.de);
            setAte(m.ate);
          }}
        >
          Mês anterior
        </button>
      </div>

      {erro && (
        <div className="mb-4">
          <Alert tone="amber">{erro}</Alert>
        </div>
      )}

      <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {cards.map((c) => (
          <div key={c.rotulo} className="card p-4">
            <p className="text-xs uppercase tracking-wide text-slate-400">{c.rotulo}</p>
            <p className={`mt-1 text-xl font-semibold tabular-nums ${c.tom}`}>{formatMoney(c.valor)}</p>
          </div>
        ))}
      </div>

      <div className="mb-4">
        <Alert tone="blue">
          O período mostra <strong>apurado</strong> (congelado no faturamento), <strong>efetivado</strong> (recebido) e{' '}
          <strong>estornado</strong>. Recebimento parcial efetiva a parte proporcional; cancelar a venda estorna o que já
          havia sido efetivado. Comissão <strong>apurada e ainda não recebida não é comissão devida</strong>.
        </Alert>
      </div>

      {conferencia && (
        <div className="mb-4">
          <Alert tone={conferencia.confere ? 'green' : 'red'}>
            {conferencia.confere
              ? `Confere com o relatório de comissões: ${formatMoney(conferencia.comissao)} apurados no período.`
              : `Divergência entre a tela e o relatório: relatório ${formatMoney(conferencia.comissao)}.`}
          </Alert>
        </div>
      )}

      <div className="card overflow-hidden">
        {carregando ? (
          <div className="flex justify-center p-10">
            <Spinner />
          </div>
        ) : linhas.length === 0 ? (
          <EmptyState
            icon={<BadgeDollarSign className="h-6 w-6" />}
            title="Nenhuma comissão no período"
            description="Só entram vendas faturadas ou entregues com representante definido."
          />
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Representante</th>
                <th className="text-right">Vendas</th>
                <th className="text-right">Apurada</th>
                <th className="text-right">Efetivada</th>
                <th className="text-right">Estornada</th>
                <th className="text-right">Saldo</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {linhas.map((l) => (
                <tr key={l.representante_id}>
                  <td>{l.representante}</td>
                  <td className="text-right tabular-nums">{formatNumber(l.vendas)}</td>
                  <td className="text-right tabular-nums">{formatMoney(l.apurada)}</td>
                  <td className="text-right tabular-nums text-emerald-600 dark:text-emerald-400">{formatMoney(l.efetivada)}</td>
                  <td className="text-right tabular-nums text-red-600 dark:text-red-400">
                    {Number(l.estornada) > 0 ? formatMoney(l.estornada) : '—'}
                  </td>
                  <td className="text-right tabular-nums font-medium">{formatMoney(l.saldo)}</td>
                  <td className="text-right">
                    <button className="btn-ghost" onClick={() => void abrirRepresentante(l)}>
                      Ver vendas
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t border-slate-100 dark:border-navy-700">
                <td className="px-4 py-2 font-medium">Total</td>
                <td className="px-4 py-2 text-right tabular-nums">{formatNumber(linhas.reduce((s, l) => s + Number(l.vendas || 0), 0))}</td>
                <td className="px-4 py-2 text-right tabular-nums font-medium">{formatMoney(dados?.resumo.apurada ?? 0)}</td>
                <td className="px-4 py-2 text-right tabular-nums font-medium">{formatMoney(dados?.resumo.efetivada ?? 0)}</td>
                <td className="px-4 py-2 text-right tabular-nums font-medium">{formatMoney(dados?.resumo.estornada ?? 0)}</td>
                <td className="px-4 py-2 text-right tabular-nums font-semibold">{formatMoney(dados?.resumo.saldo ?? 0)}</td>
                <td />
              </tr>
            </tfoot>
          </table>
        )}
      </div>

      <Modal
        open={detalhe !== null}
        onClose={() => setDetalhe(null)}
        title={detalhe ? `Comissões de ${detalhe.representante}` : 'Comissões'}
        subtitle={`Vendas de ${de} a ${ate} — apurada ${formatMoney(detalhe?.apurada ?? 0)} · efetivada ${formatMoney(detalhe?.efetivada ?? 0)}`}
        size="lg"
      >
        {carregandoVendas ? (
          <div className="flex justify-center p-8">
            <Spinner />
          </div>
        ) : vendas.length === 0 ? (
          <EmptyState icon={<Receipt className="h-6 w-6" />} title="Nenhuma venda faturada no período" description="A apuração só existe para venda faturada ou entregue." />
        ) : (
          <div className="overflow-x-auto">
            <table className="table">
              <thead>
                <tr>
                  <th>Venda</th>
                  <th>Faturada em</th>
                  <th className="text-right">Total</th>
                  <th className="text-right">%</th>
                  <th className="text-right">Comissão</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {vendas.map((v) => (
                  <tr key={v.id}>
                    <td>
                      #{v.id} <Badge tone="slate">{v.status}</Badge>
                    </td>
                    <td>{formatDate(v.faturada_em || v.data)}</td>
                    <td className="text-right tabular-nums">{formatMoney(v.total)}</td>
                    <td className="text-right tabular-nums">{v.comissao_pct != null ? formatPct(v.comissao_pct) : '—'}</td>
                    <td className="text-right tabular-nums">{formatMoney(v.comissao_valor ?? 0)}</td>
                    <td className="text-right">
                      <button className="btn-ghost" onClick={() => void abrirLivro(v.id)}>
                        Livro
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {livro && (
          <div className="mt-4 rounded-lg border border-slate-100 p-3 dark:border-navy-700">
            <div className="mb-2 flex items-center justify-between">
              <p className="text-sm font-medium">
                Livro da venda #{livro.venda_id} — apurada {formatMoney(livro.apurada)} · efetivada {formatMoney(livro.efetivada)}
              </p>
              <button className="btn-ghost" onClick={() => setLivro(null)}>
                Fechar livro
              </button>
            </div>
            {livro.eventos.length === 0 ? (
              <p className="text-sm text-slate-500 dark:text-slate-400">
                Nenhum evento: a comissão está apurada e ainda <strong>não foi efetivada</strong> — nada entrou no caixa desta venda.
              </p>
            ) : (
              <table className="table">
                <thead>
                  <tr>
                    <th>Quando</th>
                    <th>Evento</th>
                    <th className="text-right">Base (recebido)</th>
                    <th className="text-right">%</th>
                    <th className="text-right">Valor</th>
                    <th>Origem</th>
                  </tr>
                </thead>
                <tbody>
                  {livro.eventos.map((e) => (
                    <tr key={e.id}>
                      <td>{formatDate(e.criado_em)}</td>
                      <td>
                        <Badge tone={e.tipo === 'estornada' ? 'red' : 'green'}>{ORDEM_EVENTO[e.tipo] ?? e.tipo}</Badge>
                      </td>
                      <td className="text-right tabular-nums">{formatMoney(e.base)}</td>
                      <td className="text-right tabular-nums">{formatPct(e.pct)}</td>
                      <td className="text-right tabular-nums">{formatMoney(e.valor)}</td>
                      <td className="text-xs text-slate-500 dark:text-slate-400">
                        {e.origem ?? '—'}
                        {e.usuario ? ` · ${e.usuario}` : ''}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}

        <p className="mt-3 flex items-center gap-1 text-xs text-slate-500 dark:text-slate-400">
          <Undo2 className="h-3 w-3" /> Venda cancelada gera evento de <strong>estorno</strong> no livro — o saldo cai junto.
        </p>
      </Modal>
    </div>
  );
}
