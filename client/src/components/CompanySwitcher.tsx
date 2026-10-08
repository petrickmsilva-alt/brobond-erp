// ============================================================================
// Seletor de empresa ativa (multiempresa).
//
// Usa a API existente: GET /api/empresas/ativa e POST /api/empresas/ativa.
// A troca devolve um token novo (claim `emp`), que substitui o atual; depois
// disso `onChange` pede ao Layout para remontar a tela corrente, para que
// nenhum dado da empresa anterior fique na tela. Sem empresa conhecida ou em
// erro de leitura, o componente não exibe nada (não inventa nome de empresa).
// ============================================================================
import { useEffect, useRef, useState } from 'react';
import { Building2, Check, ChevronDown, Loader2 } from 'lucide-react';
import { api, ApiError, setToken } from '../lib/api';
import { useToast } from './ui';

type EmpresaOpcao = { id: number; nome: string; cnpj: string | null; ativa: boolean };

type EmpresaAtivaResp = {
  empresa_id: number | null;
  empresa: string | null;
  consolidado: boolean;
  pode_consolidar: boolean;
  empresas: EmpresaOpcao[];
};

export default function CompanySwitcher({ onChange }: { onChange: () => void }) {
  const [data, setData] = useState<EmpresaAtivaResp | null>(null);
  const [open, setOpen] = useState(false);
  const [busyId, setBusyId] = useState<number | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const toast = useToast();

  useEffect(() => {
    let vivo = true;
    api
      .get<EmpresaAtivaResp>('/empresas/ativa')
      .then((d) => vivo && setData(d))
      .catch(() => vivo && setData(null));
    return () => {
      vivo = false;
    };
  }, []);

  // Fecha o menu ao clicar fora ou pressionar Esc.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (!data) return null;

  const nomeAtual = data.consolidado ? 'Todas as empresas' : data.empresa || 'Sem empresa ativa';
  const trocavel = data.empresas.length > 1;

  async function trocar(opcao: EmpresaOpcao) {
    if (opcao.ativa || busyId !== null) return;
    setBusyId(opcao.id);
    try {
      const r = await api.post<{ token: string; empresa: string }>('/empresas/ativa', { empresa_id: opcao.id });
      setToken(r.token);
      setData((prev) =>
        prev
          ? {
              ...prev,
              consolidado: false,
              empresa_id: opcao.id,
              empresa: opcao.nome,
              empresas: prev.empresas.map((e) => ({ ...e, ativa: e.id === opcao.id })),
            }
          : prev,
      );
      setOpen(false);
      toast.success(`Empresa ativa: ${opcao.nome}.`);
      onChange();
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : 'Não foi possível trocar de empresa. Tente novamente.';
      toast.error(msg);
    } finally {
      setBusyId(null);
    }
  }

  const rotulo = (
    <span className="flex min-w-0 items-center gap-2">
      <Building2 className="h-4 w-4 shrink-0 text-brand-500" aria-hidden="true" />
      <span className="hidden text-[11px] font-semibold uppercase tracking-wide text-slate-400 xl:inline dark:text-navy-300">Empresa</span>
      <span className="max-w-[12rem] truncate text-sm font-semibold text-slate-800 dark:text-slate-100" title={nomeAtual}>
        {nomeAtual}
      </span>
    </span>
  );

  if (!trocavel) {
    return (
      <div className="hidden min-w-0 items-center rounded-lg border border-slate-200 px-2.5 py-1.5 sm:flex dark:border-slate-800/60" aria-label={`Empresa ativa: ${nomeAtual}`}>
        {rotulo}
      </div>
    );
  }

  return (
    <div className="relative hidden sm:block" ref={wrapRef}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`Empresa ativa: ${nomeAtual}. Trocar empresa`}
        className="flex min-w-0 items-center gap-2 rounded-lg border border-slate-200 px-2.5 py-1.5 transition-colors hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-navy-500/40 dark:border-slate-800/60 dark:hover:bg-navy-800"
      >
        {rotulo}
        <ChevronDown className="h-4 w-4 shrink-0 text-slate-400" aria-hidden="true" />
      </button>

      {open && (
        <ul
          role="listbox"
          aria-label="Trocar empresa ativa"
          className="absolute left-0 z-30 mt-1 max-h-80 w-72 overflow-y-auto rounded-xl border border-slate-200 bg-white py-1 shadow-modal dark:border-navy-700 dark:bg-navy-900"
        >
          {data.empresas.map((e) => (
            <li key={e.id} role="option" aria-selected={e.ativa}>
              <button
                type="button"
                onClick={() => trocar(e)}
                disabled={busyId !== null}
                className="flex w-full items-center gap-3 px-3 py-2.5 text-left text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-60 dark:text-slate-200 dark:hover:bg-navy-800"
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{e.nome}</span>
                  {e.cnpj && <span className="block truncate text-xs text-slate-500 dark:text-navy-300">{e.cnpj}</span>}
                </span>
                {busyId === e.id ? (
                  <Loader2 className="h-4 w-4 animate-spin text-slate-400" aria-label="Trocando" />
                ) : e.ativa ? (
                  <Check className="h-4 w-4 text-brand-500" aria-label="Empresa ativa" />
                ) : null}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
