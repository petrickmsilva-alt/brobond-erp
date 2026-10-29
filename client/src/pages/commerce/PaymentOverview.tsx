import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { apiFetch } from '../../lib/api';
type Readiness = { configured: boolean; providers: { status: string }[]; methods: { code: string }[]; routing: string };
export function PaymentOverview() {
  const [data, setData] = useState<Readiness | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    Promise.resolve()
      .then(() => apiFetch<Readiness>('/commerce/payments'))
      .then((r) => {
        if (active && r.providers && r.methods) setData(r);
      })
      .catch(() => {
        if (active) setError('Não foi possível consultar a prontidão do Payment Engine.');
      });
    return () => {
      active = false;
    };
  }, []);
  return (
    <section aria-label="Prontidão do Payment Engine" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      {error ? (
        <p role="alert">{error}</p>
      ) : (
        [
          ['Payment Engine', data ? (data.configured ? 'CONFIGURADO' : 'NOT_CONFIGURED') : 'Consultando…'],
          ['Providers conectados', data ? String(data.providers.filter((p) => p.status === 'CONNECTED').length) : '—'],
          ['Métodos disponíveis', data ? String(data.methods.length) : '—'],
          ['Roteamento', data?.routing || '—'],
        ].map(([label, value]) => (
          <Link to="/commerce/pagamentos/provedores" key={label} className="rounded-xl border border-line bg-surface p-4">
            <p className="text-xs font-medium uppercase tracking-wide text-muted">{label}</p>
            <p className="mt-2 text-lg font-semibold text-ink">{value}</p>
          </Link>
        ))
      )}
    </section>
  );
}
