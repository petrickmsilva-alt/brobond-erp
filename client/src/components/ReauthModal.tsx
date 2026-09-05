// Modal de reautenticação (step-up): confirma a senha do usuário logado para
// liberar ações sensíveis por 5 minutos no servidor (rate limited + auditado).
import { useState } from 'react';
import { Loader2, ShieldCheck } from 'lucide-react';
import { api, ApiError } from '../lib/api';
import { Alert, Modal } from './ui';

type Props = {
  open: boolean;
  onClose: () => void;
  /** Chamado quando o servidor confirma a senha (janela de reautenticação aberta). */
  onConfirmed: () => void;
  titulo?: string;
};

export default function ReauthModal({ open, onClose, onConfirmed, titulo = 'Autorização necessária' }: Props) {
  const [senha, setSenha] = useState('');
  const [busy, setBusy] = useState(false);
  const [erro, setErro] = useState('');

  async function confirmar() {
    if (!senha) return;
    setBusy(true);
    setErro('');
    try {
      await api.post('/auth/reautenticar', { senha });
      setSenha('');
      onConfirmed();
      onClose();
    } catch (e: any) {
      setErro(e instanceof ApiError ? e.message : 'Não foi possível confirmar. Tente novamente.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title={titulo} subtitle="Confirme a sua senha para executar esta ação sensível." size="sm">
      <div className="space-y-4">
        <div>
          <label className="label" htmlFor="reauth-senha">
            Sua senha
          </label>
          <input
            id="reauth-senha"
            className="input w-full"
            type="password"
            autoComplete="current-password"
            value={senha}
            onChange={(e) => setSenha(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && confirmar()}
            autoFocus
          />
        </div>
        {erro && <Alert tone="red">{erro}</Alert>}
        <div className="flex items-center justify-between">
          <p className="flex items-center gap-1.5 text-xs text-slate-400">
            <ShieldCheck className="h-3.5 w-3.5" /> A autorização vale por 5 minutos.
          </p>
          <div className="flex gap-2">
            <button className="btn-secondary" onClick={onClose} type="button">
              Cancelar
            </button>
            <button className="btn-primary" onClick={confirmar} disabled={busy || !senha} type="button">
              {busy && <Loader2 className="h-4 w-4 animate-spin" />} Confirmar
            </button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
