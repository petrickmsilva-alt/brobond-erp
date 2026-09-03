import { useEffect, useState } from 'react';
import { apiFetch } from '../lib/api';
import { Module } from '../modules';

export default function ModulePage({ module }: { module: Module }) {
  const [rows, setRows] = useState<any[] | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!module.resource) return;
    setRows(null);
    setError('');
    apiFetch(`/${module.resource}`)
      .then((d) => setRows(Array.isArray(d) ? d : []))
      .catch((e) => setError(e.message));
  }, [module.resource]);

  const cols = rows && rows.length ? Object.keys(rows[0]).slice(0, 6) : [];

  return (
    <div className="p-6">
      <div className="flex items-center gap-3 mb-1">
        <span className="text-2xl">{module.icon}</span>
        <h1 className="text-2xl font-bold text-slate-800">{module.label}</h1>
      </div>
      <p className="text-slate-500 mb-6">{module.description}</p>

      {module.resource ? (
        <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
          <div className="flex justify-between items-center px-4 py-3 border-b border-slate-100">
            <span className="text-sm text-slate-400">Registros</span>
            <button className="text-sm px-3 py-1.5 rounded-lg bg-brand-600 text-white font-medium hover:bg-brand-700 transition-colors">
              + Novo
            </button>
          </div>

          {error && <div className="p-4 text-red-600 text-sm">{error}</div>}
          {!rows && !error && (
            <div className="p-6 text-slate-400">Carregando...</div>
          )}
          {rows && rows.length === 0 && (
            <div className="p-6 text-slate-400">
              Nenhum registro ainda. Em breve: formulário de cadastro.
            </div>
          )}
          {rows && rows.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-slate-500">
                  <tr>
                    {cols.map((c) => (
                      <th key={c} className="text-left px-4 py-2 font-medium">
                        {c}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, i) => (
                    <tr key={i} className="border-t border-slate-100">
                      {cols.map((c) => (
                        <td key={c} className="px-4 py-2 text-slate-700">
                          {String(r[c])}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      ) : (
        <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-6 text-slate-400">
          Módulo em construção.
        </div>
      )}
    </div>
  );
}
