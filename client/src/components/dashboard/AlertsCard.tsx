import { Link } from 'react-router-dom';
import { AlertTriangle, ChevronRight, CheckCircle2 } from 'lucide-react';
import { CardHeader } from '../ui-kit';

export type Alerta = {
  id: string;
  rotulo: string;
  detalhe: string;
  to: string;
};

/**
 * "Atenção": só o que exige ação agora. Cada item é um link para a tela que
 * resolve o problema. Itens sem dado disponível para o perfil não aparecem
 * (a nota no rodapé explica o que não foi verificado).
 */
export default function AlertsCard({ alertas, semVerificacao }: { alertas: Alerta[]; semVerificacao: string[] }) {
  return (
    <section aria-labelledby="atencao-titulo" className="flex flex-col rounded-xl border border-line bg-surface shadow-card dark:shadow-none">
      <CardHeader
        title={<span id="atencao-titulo">Precisa de atenção</span>}
        icon={AlertTriangle}
        subtitle={alertas.length ? `${alertas.length} item(ns) pedem ação` : 'O que exige ação agora'}
      />

      {alertas.length === 0 ? (
        <p className="flex items-center gap-2 px-4 py-6 text-sm text-ink-soft">
          <CheckCircle2 className="h-4 w-4 text-success" aria-hidden="true" />
          Nada exige ação imediata.
        </p>
      ) : (
        <ul className="divide-y divide-line">
          {alertas.map((a) => (
            <li key={a.id}>
              <Link to={a.to} className="group flex items-center justify-between gap-3 px-4 py-3 transition-colors hover:bg-line/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-ink">{a.rotulo}</p>
                  <p className="text-xs text-muted">{a.detalhe}</p>
                </div>
                <ChevronRight className="h-4 w-4 shrink-0 text-muted transition-transform group-hover:translate-x-0.5" aria-hidden="true" />
              </Link>
            </li>
          ))}
        </ul>
      )}

      {semVerificacao.length > 0 && (
        <p className="border-t border-line px-4 py-2.5 text-xs text-muted">Não verificado nesta tela: {semVerificacao.join('; ')}.</p>
      )}
    </section>
  );
}
