// ============================================================================
// FINANCEIRO — BALANCETE E CLASSIFICAÇÃO CONTÁBIL (módulo /financeiro/balancete)
//
// O BROBOND NÃO É UM SISTEMA CONTÁBIL e esta página não finge que é:
//   • soma o MESMO livro-caixa (lançamentos), por conta do plano de contas;
//   • mostra separadamente o que está SEM classificação — a soma nunca "fecha"
//     escondendo lançamento sem conta;
//   • rastreia o documento de origem (venda, compra, aporte...) e a competência.
// Não existe partida dobrada automática nem plano de contas padrão semeado.
//
// ZERO MODAL: leitura em tabelas; nada de sobreposição.
// ============================================================================
import { useCallback, useEffect, useState } from 'react';
import { BookOpen, RefreshCw } from 'lucide-react';
import { api, ApiError } from '../lib/api';
import { Alert, EmptyState, PageHeader, Spinner } from '../components/ui';
import { StatCard } from '../components/ui-kit-negocios';

type Conta = {
  conta_contabil_id: number;
  codigo: string;
  nome: string;
  natureza: string;
  debitos: number;
  creditos: number;
  saldo: number;
  lancamentos: number;
};

type Balancete = {
  de: string;
  ate: string;
  regra: string;
  resumo: {
    lancamentos_no_periodo: number;
    classificados: number;
    sem_classificacao: number;
    total_debitos: number;
    total_creditos: number;
    diferenca: number;
    contas_com_movimento: number;
    plano_de_contas: number;
  };
  contas: Conta[];
  sem_classificacao: { lancamento_id: number; data: string; descricao: string; tipo: string; valor: number; motivo: string }[];
  por_origem: { recurso: string; registros: number; valor: number }[];
};

const brl = (v: number) => v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const mesAtual = () => new Date().toISOString().slice(0, 7);

export default function FinanceiroBalancetePage() {
  const [de, setDe] = useState(mesAtual());
  const [ate, setAte] = useState(mesAtual());
  const [dados, setDados] = useState<Balancete | null>(null);
  const [erro, setErro] = useState('');
  const [carregando, setCarregando] = useState(true);

  const carregar = useCallback(async () => {
    setCarregando(true);
    setErro('');
    try {
      setDados(await api.get<Balancete>(`/financeiro/balancete?de=${de}&ate=${ate}`));
    } catch (e) {
      setErro(e instanceof ApiError ? e.message : 'Não foi possível carregar o balancete.');
    } finally {
      setCarregando(false);
    }
  }, [de, ate]);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  return (
    <div className="space-y-4">
      <PageHeader
        title="Balancete e classificação"
        description="Estrutura contábil já preparada: débito/crédito por conta, competência e documento de origem. O ERP soma o livro-caixa existente — não apura imposto nem gera partida dobrada."
        actions={
          <button type="button" onClick={() => void carregar()} className="inline-flex items-center gap-2 rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50">
            <RefreshCw className="h-4 w-4" /> Atualizar
          </button>
        }
      />

      <div className="flex flex-wrap items-end gap-3 rounded-xl border border-slate-200 bg-white p-3">
        <label className="text-sm">
          <span className="mb-1 block font-medium text-slate-600">Competência inicial</span>
          <input type="month" value={de} onChange={(e) => setDe(e.target.value)} className="rounded-lg border border-slate-300 px-3 py-2" />
        </label>
        <label className="text-sm">
          <span className="mb-1 block font-medium text-slate-600">Competência final</span>
          <input type="month" value={ate} onChange={(e) => setAte(e.target.value)} className="rounded-lg border border-slate-300 px-3 py-2" />
        </label>
      </div>

      {erro && <Alert tone="red">{erro}</Alert>}

      {carregando ? (
        <div className="flex justify-center py-16"><Spinner /></div>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard label="Débitos" value={brl(dados?.resumo.total_debitos ?? 0)} hint="Lançamentos classificados." />
            <StatCard label="Créditos" value={brl(dados?.resumo.total_creditos ?? 0)} hint="Lançamentos classificados." />
            <StatCard label="Diferença" value={brl(dados?.resumo.diferenca ?? 0)} hint="Débitos − créditos (só do que está classificado)." />
            <StatCard
              label="Sem classificação"
              value={String(dados?.resumo.sem_classificacao ?? 0)}
              hint={`de ${dados?.resumo.lancamentos_no_periodo ?? 0} lançamento(s) no período`}
            />
          </div>

          {dados && dados.resumo.plano_de_contas === 0 && (
            <Alert tone="amber">
              Nenhuma conta contábil cadastrada: o balancete fica vazio até o plano de contas da empresa ser cadastrado em Financeiro › Plano de contas. Nada é classificado automaticamente.
            </Alert>
          )}

          <section className="rounded-xl border border-slate-200 bg-white">
            <header className="flex items-center gap-2 border-b border-slate-100 px-4 py-3 text-sm font-semibold text-slate-700">
              <BookOpen className="h-4 w-4" /> Movimento por conta
            </header>
            {!dados || dados.contas.length === 0 ? (
              <EmptyState title="Nenhum lançamento classificado no período" description="Classifique os lançamentos com conta contábil e débito/crédito para que apareçam aqui." />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                    <tr>
                      <th className="px-4 py-2">Código</th>
                      <th className="px-4 py-2">Conta</th>
                      <th className="px-4 py-2">Natureza</th>
                      <th className="px-4 py-2 text-right">Débitos</th>
                      <th className="px-4 py-2 text-right">Créditos</th>
                      <th className="px-4 py-2 text-right">Saldo</th>
                      <th className="px-4 py-2 text-right">Lançamentos</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {dados.contas.map((c) => (
                      <tr key={c.conta_contabil_id}>
                        <td className="px-4 py-2 font-mono text-xs text-slate-500">{c.codigo}</td>
                        <td className="px-4 py-2 text-slate-700">{c.nome}</td>
                        <td className="px-4 py-2 text-slate-500">{String(c.natureza).replace(/_/g, ' ')}</td>
                        <td className="px-4 py-2 text-right text-slate-600">{brl(c.debitos)}</td>
                        <td className="px-4 py-2 text-right text-slate-600">{brl(c.creditos)}</td>
                        <td className={`px-4 py-2 text-right font-medium ${c.saldo < 0 ? 'text-red-600' : 'text-slate-800'}`}>{brl(c.saldo)}</td>
                        <td className="px-4 py-2 text-right text-slate-500">{c.lancamentos}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <p className="border-t border-slate-100 px-4 py-2 text-xs text-slate-500">{dados?.regra}</p>
          </section>

          {dados && dados.sem_classificacao.length > 0 && (
            <section className="rounded-xl border border-amber-200 bg-amber-50 p-4">
              <h3 className="text-sm font-semibold text-amber-800">Lançamentos sem classificação contábil</h3>
              <p className="mt-1 text-xs text-amber-700">
                Estes valores NÃO entram nas somas acima. Classifique-os no lançamento (conta contábil + débito/crédito) — o ERP não escolhe a conta no seu lugar.
              </p>
              <table className="mt-2 w-full text-sm">
                <thead className="text-left text-xs uppercase tracking-wide text-amber-700/70">
                  <tr><th className="py-1">Data</th><th className="py-1">Descrição</th><th className="py-1">Tipo</th><th className="py-1 text-right">Valor</th><th className="py-1">Pendência</th></tr>
                </thead>
                <tbody className="divide-y divide-amber-200/60">
                  {dados.sem_classificacao.slice(0, 20).map((l) => (
                    <tr key={l.lancamento_id}>
                      <td className="py-1.5 text-amber-900">{l.data}</td>
                      <td className="py-1.5 text-amber-900">{l.descricao}</td>
                      <td className="py-1.5 text-amber-800">{l.tipo}</td>
                      <td className="py-1.5 text-right text-amber-900">{brl(l.valor)}</td>
                      <td className="py-1.5 text-xs text-amber-700">{l.motivo}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}

          {dados && dados.por_origem.length > 0 && (
            <section className="rounded-xl border border-slate-200 bg-white p-4">
              <h3 className="mb-2 text-sm font-semibold text-slate-700">Origem dos lançamentos</h3>
              <ul className="grid gap-1 text-sm sm:grid-cols-2">
                {dados.por_origem.map((o) => (
                  <li key={o.recurso} className="flex items-center justify-between gap-2">
                    <span className="text-slate-600">{o.recurso === '(manual)' ? 'Lançamento manual' : o.recurso}</span>
                    <span className="text-xs text-slate-500">{o.registros} registro(s) · {brl(o.valor)}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}
    </div>
  );
}
