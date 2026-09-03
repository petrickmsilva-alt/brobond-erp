import { useEffect, useState } from 'react';
import { apiFetch } from '../lib/api';

type Kpi = {
  valorEstoque?: string;
  itensAlerta?: number;
  producao?: number;
  vendas?: number;
};

export default function Dashboard() {
  const [kpi, setKpi] = useState<Kpi | null>(null);

  useEffect(() => {
    apiFetch('/dashboard')
      .then(setKpi)
      .catch(() => setKpi({}));
  }, []);

  const cards = [
    { label: 'Valor do Estoque', value: kpi?.valorEstoque ?? '—', icon: '📦' },
    { label: 'Itens em Alerta', value: kpi?.itensAlerta ?? '—', icon: '⚠️' },
    { label: 'Produção em Andamento', value: kpi?.producao ?? '—', icon: '⚙️' },
    { label: 'Pedidos de Venda', value: kpi?.vendas ?? '—', icon: '💰' },
  ];

  return (
    <div className="p-6">
      <h1 className="text-2xl font-bold text-slate-800 mb-1">Dashboard</h1>
      <p className="text-slate-500 mb-6">Visão geral da operação BROBOND.</p>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {cards.map((c) => (
          <div
            key={c.label}
            className="bg-white rounded-xl border border-slate-200 shadow-sm p-5"
          >
            <div className="text-2xl">{c.icon}</div>
            <div className="mt-3 text-2xl font-bold text-slate-800">
              {c.value}
            </div>
            <div className="text-sm text-slate-500">{c.label}</div>
          </div>
        ))}
      </div>

      <div className="mt-6 bg-white rounded-xl border border-slate-200 shadow-sm p-6 text-slate-400">
        Em breve: gráficos de giro de estoque, produção por período e ranking de
        produtos.
      </div>
    </div>
  );
}
