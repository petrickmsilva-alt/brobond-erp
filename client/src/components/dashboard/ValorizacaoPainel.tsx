import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, Package, Search } from 'lucide-react';
import { Tabs } from '../ui-kit';
import { formatMoney, formatNumber } from '../../lib/format';
import type { Valorizacao } from './types';

type Nivel = 'unidade' | 'colecao' | 'total';

const NIVEIS: { key: Nivel; label: string; desc: string }[] = [
  { key: 'unidade', label: 'Por unidade', desc: 'Custo da unidade de cada produto e o total das peças em estoque dele.' },
  { key: 'colecao', label: 'Por coleção', desc: 'Custo do valor total de cada coleção (peças em estoque dos produtos dela).' },
  { key: 'total', label: 'Todas as peças', desc: 'Custo de todas as peças no estoque, somando tamanhos, locais e coleções.' },
];

const BASES = [
  { key: 'custo' as const, label: 'Produção', cor: 'text-navy-900 dark:text-white' },
  { key: 'atacado' as const, label: 'Atacado', cor: 'text-brand-700 dark:text-brand-400' },
  { key: 'varejo' as const, label: 'Varejo', cor: 'text-emerald-700 dark:text-emerald-400' },
];

/** Painel "Estoque valorizado": as três bases (produção, atacado, varejo) em três níveis. */
export default function ValorizacaoPainel({ val }: { val: Valorizacao }) {
  const [nivel, setNivel] = useState<Nivel>('colecao');
  const [q, setQ] = useState('');

  const produtos = useMemo(() => {
    const term = q.trim().toLowerCase();
    if (!term) return val.produtos;
    return val.produtos.filter((p) => `${p.produto} ${p.colecao || ''}`.toLowerCase().includes(term));
  }, [val.produtos, q]);

  const semSaldo = val.produtosComSaldo === 0;
  const atual = NIVEIS.find((n) => n.key === nivel)!;

  return (
    <section className="card mt-4 overflow-hidden" data-testid="valorizacao">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-4 py-3 dark:border-navy-800">
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-navy-900 dark:text-white">
            <Package className="h-4 w-4 text-brand-500" /> Estoque valorizado
          </h2>
          <p className="text-xs text-slate-400 dark:text-navy-300">{atual.desc}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {nivel === 'unidade' && (
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
              <input className="input !py-1.5 pl-8 text-xs sm:w-56" placeholder="Buscar produto ou coleção..." value={q} onChange={(e) => setQ(e.target.value)} aria-label="Buscar produto" />
            </div>
          )}
          <Tabs tabs={NIVEIS.map((n) => ({ key: n.key, label: n.label }))} value={nivel} onChange={setNivel} label="Nível da valorização" />
        </div>
      </div>

      {semSaldo ? (
        <p className="px-4 py-8 text-center text-sm text-slate-400 dark:text-navy-300">Nenhuma peça em estoque para valorizar.</p>
      ) : nivel === 'total' ? (
        <div className="grid grid-cols-1 divide-y divide-slate-100 sm:grid-cols-3 sm:divide-x sm:divide-y-0 dark:divide-navy-800">
          {BASES.map((b) => (
            <div key={b.key} className="px-4 py-5 text-center">
              <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-400 dark:text-navy-300">Custo de todas as peças · {b.label}</div>
              <div className={`mt-1 text-2xl font-bold tabular-nums ${b.cor}`}>{formatMoney(val[b.key])}</div>
              <div className="mt-1 text-xs text-slate-400 dark:text-navy-300">
                {formatNumber(val.pecas)} peças · média {formatMoney(val.pecas ? val[b.key] / val.pecas : 0)}/peça
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="max-h-[420px] overflow-auto">
          <table className="table table-compact">
            <thead>
              <tr>
                <th>{nivel === 'colecao' ? 'Coleção' : 'Produto'}</th>
                {nivel === 'unidade' && <th className="hidden md:table-cell">Coleção</th>}
                <th className="text-right">Peças</th>
                {nivel === 'unidade' && (
                  <>
                    <th className="text-right">Custo unit.</th>
                    <th className="text-right">Atacado unit.</th>
                    <th className="text-right">Varejo unit.</th>
                  </>
                )}
                <th className="text-right">Produção</th>
                <th className="text-right">Atacado</th>
                <th className="text-right">Varejo</th>
              </tr>
            </thead>
            <tbody>
              {nivel === 'colecao'
                ? val.colecoes.map((c) => (
                    <tr key={c.colecao}>
                      <td className="font-medium text-navy-900 dark:text-slate-100">{c.colecao}</td>
                      <td className="text-right tabular-nums">{formatNumber(c.pecas)}</td>
                      <td className="text-right tabular-nums font-semibold">{formatMoney(c.custo)}</td>
                      <td className="text-right tabular-nums">{formatMoney(c.atacado)}</td>
                      <td className="text-right tabular-nums">{formatMoney(c.varejo)}</td>
                    </tr>
                  ))
                : produtos.map((p) => (
                    <tr key={p.id}>
                      <td>
                        <Link to={`/produtos/${p.id}`} className="font-medium text-navy-900 hover:underline dark:text-slate-100">
                          {p.produto}
                        </Link>
                      </td>
                      <td className="hidden text-slate-500 md:table-cell dark:text-navy-300">{p.colecao || '—'}</td>
                      <td className="text-right tabular-nums">{formatNumber(p.pecas)}</td>
                      <td className="text-right tabular-nums">{formatMoney(p.custo_unit)}</td>
                      <td className="text-right tabular-nums" title={p.atacado_definido ? undefined : 'Sem preço de atacado cadastrado — usa o preço de varejo'}>
                        {formatMoney(p.atacado_unit)}
                        {!p.atacado_definido && <span className="ml-1 text-[10px] text-amber-600">*</span>}
                      </td>
                      <td className="text-right tabular-nums">{formatMoney(p.varejo_unit)}</td>
                      <td className="text-right tabular-nums font-semibold">{formatMoney(p.custo)}</td>
                      <td className="text-right tabular-nums">{formatMoney(p.atacado)}</td>
                      <td className="text-right tabular-nums">{formatMoney(p.varejo)}</td>
                    </tr>
                  ))}
              {nivel === 'unidade' && produtos.length === 0 && (
                <tr>
                  <td colSpan={9} className="py-6 text-center text-slate-400 dark:text-navy-300">Nenhum produto encontrado.</td>
                </tr>
              )}
            </tbody>
            <tfoot>
              <tr className="bg-slate-50 font-semibold dark:bg-navy-800/60">
                <td className="px-4 py-2 text-navy-900 dark:text-white">Todas as peças</td>
                {nivel === 'unidade' && <td className="hidden md:table-cell" />}
                <td className="px-4 py-2 text-right tabular-nums">{formatNumber(val.pecas)}</td>
                {nivel === 'unidade' && <td colSpan={3} />}
                <td className="px-4 py-2 text-right tabular-nums text-navy-900 dark:text-white">{formatMoney(val.custo)}</td>
                <td className="px-4 py-2 text-right tabular-nums">{formatMoney(val.atacado)}</td>
                <td className="px-4 py-2 text-right tabular-nums">{formatMoney(val.varejo)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 px-4 py-2 text-xs text-slate-400 dark:border-navy-800 dark:text-navy-300">
        <span>
          Produção = custo unitário do produto (ficha técnica). Atacado/varejo = preço de tabela × peças.
          {val.semPrecoAtacado > 0 && <> * Sem preço de atacado cadastrado, vale o preço de varejo.</>}
          {nivel === 'unidade' && val.produtosComSaldo > val.produtos.length && <> Exibindo os {formatNumber(val.produtos.length)} produtos de maior custo (de {formatNumber(val.produtosComSaldo)}).</>}
        </span>
        <Link to="/relatorios?relatorio=estoque-posicao" className="inline-flex items-center gap-1 font-medium text-navy-700 hover:underline dark:text-navy-200">
          Relatório completo <ArrowRight className="h-3 w-3" />
        </Link>
      </div>
    </section>
  );
}
