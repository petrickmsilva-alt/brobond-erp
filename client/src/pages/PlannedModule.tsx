import { Link } from 'react-router-dom';
import { CheckCircle2, Construction } from 'lucide-react';
import type { Module } from '../modules';
import { PageHeader } from '../components/ui';

/**
 * Página para módulos ainda não implementados: mostra o que está previsto.
 * Hoje todo módulo sem `resource` (dashboard, estoque, inventário, custo,
 * financeiro, relatórios, medidas, usuários, webhooks, ajuda, config) já tem
 * um caso especial tratado em ModulePage antes de chegar aqui — este
 * componente funciona como rede de segurança para quando um novo módulo for
 * cadastrado em modules.ts sem `resource` e sem página própria ainda.
 */
export default function PlannedModule({ module }: { module: Module }) {
  const Icon = module.icon;
  return (
    <div className="p-4 sm:p-6">
      <PageHeader
        title={
          <span className="flex items-center gap-2.5">
            <span className="flex h-9 w-9 items-center justify-center rounded-lg border border-slate-800/60 bg-slate-900/60 text-brand-400">
              <Icon className="h-5 w-5" />
            </span>
            {module.label}
          </span>
        }
        description={module.description}
      />

      <div className="card p-6 sm:p-8">
        <div className="flex items-start gap-4">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-brand-500/10 text-brand-400">
            <Construction className="h-5 w-5" />
          </div>
          <div className="min-w-0">
            <h2 className="text-base font-bold text-navy-900 dark:text-white">Módulo em desenvolvimento</h2>
            <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
              Este módulo será construído sobre os cadastros que já funcionam. O que está previsto:
            </p>
            {module.planned && (
              <ul className="mt-4 space-y-2">
                {module.planned.map((p) => (
                  <li key={p} className="flex items-start gap-2 text-sm text-slate-700 dark:text-slate-300">
                    <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-navy-300" />
                    {p}
                  </li>
                ))}
              </ul>
            )}
            <div className="mt-6 flex flex-wrap gap-2">
              <Link to="/" className="btn-secondary">
                Voltar ao Dashboard
              </Link>
              {module.id === 'inventario' && (
                <Link to="/estoque" className="btn-primary">
                  Ir para Estoque Físico
                </Link>
              )}
              {module.id === 'custo' && (
                <Link to="/fichas" className="btn-primary">
                  Ir para Ficha Técnica
                </Link>
              )}
              {module.id === 'relatorios' && (
                <Link to="/movimentacoes" className="btn-primary">
                  Ver Movimentações
                </Link>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
