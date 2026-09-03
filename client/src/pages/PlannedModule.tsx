import { Link } from 'react-router-dom';
import { CheckCircle2, Construction } from 'lucide-react';
import type { Module } from '../modules';
import { PageHeader } from '../components/ui';

/** Página para módulos ainda não implementados: mostra o que está previsto. */
export default function PlannedModule({ module }: { module: Module }) {
  const Icon = module.icon;
  return (
    <div className="p-4 sm:p-6">
      <PageHeader
        title={
          <span className="flex items-center gap-2.5">
            <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-navy-800 text-white">
              <Icon className="h-5 w-5" />
            </span>
            {module.label}
          </span>
        }
        description={module.description}
      />

      <div className="card p-6 sm:p-8">
        <div className="flex items-start gap-4">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-brand-50 text-brand-600">
            <Construction className="h-5 w-5" />
          </div>
          <div className="min-w-0">
            <h2 className="text-base font-bold text-navy-900">Módulo em desenvolvimento</h2>
            <p className="mt-1 text-sm text-slate-500">
              Este módulo será construído sobre os cadastros que já funcionam. O que está previsto:
            </p>
            {module.planned && (
              <ul className="mt-4 space-y-2">
                {module.planned.map((p) => (
                  <li key={p} className="flex items-start gap-2 text-sm text-slate-700">
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
