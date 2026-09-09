// Medidor de força de senha com checklist da política (espelha o servidor:
// mínimo 8, sem conter o e-mail, fora da lista de óbvias).
import { useMemo } from 'react';
import { Check, X } from 'lucide-react';

const OBVIAS = ['123456', '12345678', '123456789', 'senha', 'senha123', 'password', 'password123', 'qwerty', 'abc123', 'brobond', 'brobond123', 'admin', 'administrador', 'brasil', 'batata'];

export type CheckSenha = { ok: boolean; texto: string };

export function avaliarSenha(senha: string, email?: string, nome?: string): { nivel: number; rotulo: string; cor: string; checks: CheckSenha[] } {
  const s = senha || '';
  const lower = s.toLowerCase();
  const parteEmail = String(email || '').split('@')[0].toLowerCase();
  const primeiroNome = String(nome || '').trim().split(/\s+/)[0]?.toLowerCase() || '';
  const contemEmail = parteEmail.length >= 4 && lower.includes(parteEmail);
  const contemNome = primeiroNome.length >= 4 && lower.includes(primeiroNome);
  const obvia = OBVIAS.includes(lower) || /^(.)\1{6,}$/.test(lower);

  const checks: CheckSenha[] = [
    { ok: s.length >= 8, texto: 'Pelo menos 8 caracteres' },
    { ok: /[a-z]/.test(s) && /[A-Z]/.test(s), texto: 'Maiúsculas e minúsculas' },
    { ok: /\d/.test(s), texto: 'Ao menos um número' },
    { ok: /[^a-zA-Z0-9]/.test(s), texto: 'Ao menos um símbolo (!@#…)' },
    { ok: !contemEmail && !contemNome, texto: 'Sem o seu e-mail ou nome' },
    { ok: !obvia, texto: 'Fora da lista de senhas óbvias' },
  ];
  const politicaOk = s.length >= 8 && !contemEmail && !obvia;
  if (!s) return { nivel: 0, rotulo: '', cor: 'bg-slate-200', checks };
  if (!politicaOk) return { nivel: 1, rotulo: 'Inválida — ajuste os itens abaixo', cor: 'bg-red-500', checks };
  const pontos = checks.filter((c) => c.ok).length;
  if (pontos <= 3) return { nivel: 1, rotulo: 'Fraca', cor: 'bg-orange-500', checks };
  if (pontos === 4) return { nivel: 2, rotulo: 'Razoável', cor: 'bg-amber-500', checks };
  if (pontos === 5) return { nivel: 3, rotulo: 'Boa', cor: 'bg-lime-500', checks };
  return { nivel: 4, rotulo: 'Forte', cor: 'bg-emerald-500', checks };
}

export default function ForcaSenha({ senha, email, nome }: { senha: string; email?: string; nome?: string }) {
  const aval = useMemo(() => avaliarSenha(senha, email, nome), [senha, email, nome]);
  if (!senha) return null;
  return (
    <div className="mt-2" aria-live="polite">
      <div className="flex items-center gap-2">
        <div className="flex flex-1 gap-1">
          {[1, 2, 3, 4].map((i) => (
            <span key={i} className={`h-1.5 flex-1 rounded-full ${i <= aval.nivel ? aval.cor : 'bg-slate-200'}`} />
          ))}
        </div>
        <span className="text-xs font-semibold text-slate-600">{aval.rotulo}</span>
      </div>
      {aval.checks.some((c) => !c.ok) && (
        <ul className="mt-1.5 space-y-0.5">
          {aval.checks.map((c) => (
            <li key={c.texto} className={`flex items-center gap-1.5 text-xs ${c.ok ? 'text-slate-300' : 'text-slate-500'}`}>
              {c.ok ? <Check className="h-3 w-3 text-emerald-500" /> : <X className="h-3 w-3 text-slate-300" />}
              {c.texto}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
