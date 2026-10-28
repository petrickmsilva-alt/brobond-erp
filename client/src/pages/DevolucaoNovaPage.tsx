// ============================================================================
// DEVOLUÇÕES — solicitação em PÁGINA PRÓPRIA
// ----------------------------------------------------------------------------
// ZERO MODAL / ZERO PAINEL TRANSACIONAL: "Solicitar devolução" navega para
// `/devolucoes/nova`. Depois de criar, a devolução abre no detalhe da listagem
// (`/devolucoes`), que é onde as ações de autorizar/rastrear/receber vivem.
//
// A tela não decide nada: o servidor valida se o pedido está faturado/entregue
// e devolve a mensagem. Sem itens explícitos, a devolução cobre o pedido todo.
// ============================================================================
import { useState } from 'react';
import { Loader2, RotateCcw } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { Alert, PageHeader, useToast } from '../components/ui';

const TIPOS = [
  { value: 'devolucao', label: 'Devolução' },
  { value: 'troca', label: 'Troca' },
  { value: 'garantia', label: 'Garantia' },
  { value: 'arrependimento', label: 'Arrependimento' },
];

export default function DevolucaoNovaPage() {
  const navigate = useNavigate();
  const toast = useToast();

  const [nova, setNova] = useState({ venda_id: '', motivo: '', tipo: 'devolucao' });
  const [erro, setErro] = useState('');
  const [ocupado, setOcupado] = useState(false);

  const podeEnviar = !!Number(nova.venda_id) && nova.motivo.trim().length >= 5;

  async function solicitar() {
    setOcupado(true);
    setErro('');
    try {
      const r = await api.post<{ id: number }>('/devolucoes', {
        venda_id: Number(nova.venda_id),
        motivo: nova.motivo,
        tipo: nova.tipo,
      });
      toast.success(`Devolução #${r.id} solicitada.`);
      navigate('/devolucoes');
    } catch (e) {
      setErro(e instanceof ApiError ? e.message : 'Não foi possível solicitar a devolução.');
    } finally {
      setOcupado(false);
    }
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title={
          <span className="flex items-center gap-2.5">
            <RotateCcw className="h-5 w-5 text-navy-600" />
            Solicitar devolução
          </span>
        }
        description="Só pedido faturado ou entregue pode ser devolvido. Sem itens explícitos, a devolução cobre o pedido inteiro."
        actions={
          <div className="flex gap-2">
            <button type="button" className="btn btn-secondary" onClick={() => navigate('/devolucoes')} disabled={ocupado}>
              Cancelar
            </button>
            <button type="button" className="btn btn-accent" onClick={() => void solicitar()} disabled={ocupado || !podeEnviar}>
              {ocupado ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              Solicitar
            </button>
          </div>
        }
      />

      {erro && <Alert tone="red">{erro}</Alert>}

      <div className="card mx-auto max-w-2xl space-y-4 p-5">
        <label className="label" htmlFor="devolucao-venda">
          Pedido (venda)
          <input
            id="devolucao-venda"
            type="number"
            min={1}
            className="input"
            value={nova.venda_id}
            onChange={(e) => setNova((n) => ({ ...n, venda_id: e.target.value }))}
          />
        </label>
        <label className="label" htmlFor="devolucao-tipo">
          Tipo
          <select id="devolucao-tipo" className="input" value={nova.tipo} onChange={(e) => setNova((n) => ({ ...n, tipo: e.target.value }))}>
            {TIPOS.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
        </label>
        <label className="label" htmlFor="devolucao-motivo">
          Motivo
          <textarea
            id="devolucao-motivo"
            className="input min-h-20"
            value={nova.motivo}
            onChange={(e) => setNova((n) => ({ ...n, motivo: e.target.value }))}
            placeholder="Mínimo 5 caracteres."
          />
        </label>
        {!podeEnviar && (
          <p className="text-[11px] text-slate-400">
            Informe o número do pedido e um motivo com pelo menos 5 caracteres.
          </p>
        )}
      </div>
    </div>
  );
}
