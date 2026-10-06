import { ArrowUpRight, CheckCircle2, Clock3, Inbox, Layers3, Sparkles } from 'lucide-react';
import type { Module } from '../modules';

const GLASS = 'rounded-xl border border-slate-800/80 bg-slate-900/40 backdrop-blur-md';

const DEFAULT_PLAN = [
  'Contrato visual e rota protegida já disponíveis no ERP.',
  'Modelo de dados e permissões serão conectados na próxima etapa.',
  'Indicadores operacionais aparecerão após a ativação do módulo.',
];

/**
 * Esqueleto comum do Commerce & Creators.
 *
 * As rotas são deliberadamente somente de apresentação: não há dados fake,
 * nem chamadas para endpoints que ainda não existem. O mesmo shell mantém a
 * linguagem Dark Slate do Hub enquanto cada domínio ganha seu caso de uso.
 */
export default function CommerceModulePage({ module }: { module: Module }) {
  const Icon = module.icon;
  const plan = module.planned?.length ? module.planned : DEFAULT_PLAN;

  return (
    <div className="min-h-full space-y-5 p-4 sm:p-6">
      <header className={`${GLASS} flex flex-wrap items-start justify-between gap-4 px-5 py-5 sm:px-6`}>
        <div className="flex min-w-0 items-start gap-3.5">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-brand-400/20 bg-brand-500/10 text-brand-300">
            <Icon className="h-5 w-5" aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <div className="mb-1 flex flex-wrap items-center gap-2">
              <span className="text-[10px] font-bold uppercase tracking-[0.16em] text-brand-300">{module.group}</span>
              <span className="rounded-full border border-emerald-400/20 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-emerald-300">
                rota pronta
              </span>
            </div>
            <h1 className="text-xl font-bold tracking-tight text-white sm:text-2xl">{module.label}</h1>
            <p className="mt-1 max-w-3xl text-sm leading-6 text-slate-400">{module.description}</p>
          </div>
        </div>
        <span className="inline-flex items-center gap-2 rounded-lg border border-slate-700/70 bg-slate-950/40 px-3 py-2 text-xs text-slate-400">
          <Clock3 className="h-3.5 w-3.5 text-brand-300" aria-hidden="true" />
          Em construção planejada
        </span>
      </header>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Metric label="Registros ativos" value="—" />
        <Metric label="Pendências" value="—" />
        <Metric label="Performance" value="—" />
        <Metric label="Disponibilidade" value="Em breve" accent />
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[1.15fr_0.85fr]">
        <section className={`${GLASS} min-h-[18rem]`}>
          <div className="flex items-center justify-between border-b border-slate-800/80 px-5 py-3.5">
            <div>
              <h2 className="text-[11px] font-bold uppercase tracking-[0.14em] text-slate-300">Visão operacional</h2>
              <p className="mt-1 text-xs text-slate-500">O painel será alimentado quando o domínio for ativado.</p>
            </div>
            <Layers3 className="h-4 w-4 text-slate-600" aria-hidden="true" />
          </div>
          <div className="flex min-h-[13rem] flex-col items-center justify-center px-6 py-10 text-center">
            <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-full border border-slate-800 bg-slate-950/40 text-slate-500">
              <Inbox className="h-5 w-5" aria-hidden="true" />
            </div>
            <p className="text-sm font-semibold text-slate-300">Nenhum registro para exibir</p>
            <p className="mt-1 max-w-sm text-xs leading-5 text-slate-500">
              Esta rota já está pronta para receber dados reais. Nenhuma informação fictícia é exibida enquanto a integração não estiver disponível.
            </p>
          </div>
        </section>

        <section className={`${GLASS} min-h-[18rem]`}>
          <div className="flex items-center justify-between border-b border-slate-800/80 px-5 py-3.5">
            <div>
              <h2 className="text-[11px] font-bold uppercase tracking-[0.14em] text-slate-300">Próximas capacidades</h2>
              <p className="mt-1 text-xs text-slate-500">Escopo inicial do módulo</p>
            </div>
            <Sparkles className="h-4 w-4 text-brand-300" aria-hidden="true" />
          </div>
          <ul className="space-y-3 px-5 py-5">
            {plan.map((item) => (
              <li key={item} className="flex items-start gap-2.5 text-sm leading-5 text-slate-400">
                <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-brand-300" aria-hidden="true" />
                <span>{item}</span>
              </li>
            ))}
          </ul>
        </section>
      </div>

      <section className={`${GLASS} overflow-hidden`}>
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800/80 px-5 py-3.5">
          <div>
            <h2 className="text-[11px] font-bold uppercase tracking-[0.14em] text-slate-300">Fila e atividade</h2>
            <p className="mt-1 text-xs text-slate-500">Eventos e operações recentes deste módulo.</p>
          </div>
          <button type="button" className="btn-secondary" disabled title="Disponível quando o módulo for ativado">
            <ArrowUpRight className="h-4 w-4" aria-hidden="true" /> Ações em breve
          </button>
        </div>
        <div className="px-5 py-8 text-center text-xs text-slate-500">A atividade aparecerá aqui após a primeira operação.</div>
      </section>
    </div>
  );
}

function Metric({ label, value, accent = false }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className={`${GLASS} min-w-0 px-4 py-3.5`}>
      <div className="truncate text-[10px] font-bold uppercase tracking-[0.12em] text-slate-500">{label}</div>
      <div className={`mt-1.5 truncate font-mono text-xl font-semibold tabular-nums tracking-tight ${accent ? 'text-brand-300' : 'text-slate-100'}`}>
        {value}
      </div>
    </div>
  );
}
