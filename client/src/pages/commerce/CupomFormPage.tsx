// ============================================================================
// COMMERCE — FORM DE CUPOM (página própria, ZERO MODAL).
// /commerce/cupons/novo e /commerce/cupons/:id/editar
// ============================================================================
import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Save } from 'lucide-react';
import { apiFetch, ApiError } from '../../lib/api';
import { Alert, PageHeader, Spinner, useToast } from '../../components/ui';

type Formulario = {
  codigo: string;
  tipo: 'percentual' | 'valor';
  valor: string;
  minimo_pedido: string;
  uso_maximo: string;
  validade: string;
  ativo: boolean;
};

const VAZIO: Formulario = { codigo: '', tipo: 'percentual', valor: '', minimo_pedido: '0', uso_maximo: '', validade: '', ativo: true };

export default function CommerceCupomFormPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const editando = !!id;

  const [form, setForm] = useState<Formulario>(VAZIO);
  const [carregando, setCarregando] = useState(editando);
  const [salvando, setSalvando] = useState(false);
  const [erro, setErro] = useState('');

  useEffect(() => {
    if (!id) return;
    let vivo = true;
    apiFetch<{ cupons?: { id: number; codigo: string; tipo: string; valor: number; minimo_pedido: number; uso_maximo: number | null; validade: string | null; ativo: boolean }[] }>(
      '/commerce/cupons?page=1&pageSize=200'
    )
      .then((r) => {
        const c = (r.cupons ?? []).find((x) => String(x.id ?? '') === String(id));
        if (!c) throw new ApiError(404, 'Cupom não encontrado.');
        if (vivo) {
          setForm({
            codigo: c.codigo,
            tipo: c.tipo === 'valor' ? 'valor' : 'percentual',
            valor: String(c.valor),
            minimo_pedido: String(c.minimo_pedido ?? 0),
            uso_maximo: c.uso_maximo != null ? String(c.uso_maximo) : '',
            validade: c.validade ? String(c.validade).slice(0, 10) : '',
            ativo: c.ativo !== false,
          });
        }
      })
      .catch((e) => {
        if (vivo) setErro(e instanceof ApiError ? e.message : 'Falha ao carregar o cupom.');
      })
      .finally(() => {
        if (vivo) setCarregando(false);
      });
    return () => {
      vivo = false;
    };
  }, [id]);

  const salvar = async () => {
    setSalvando(true);
    setErro('');
    try {
      const codigo = form.codigo.trim().toUpperCase();
      if (!/^[A-Z0-9_-]{2,40}$/.test(codigo)) {
        throw new ApiError(400, 'Código inválido: use letras, números, hífen ou sublinhado (2–40 caracteres).');
      }
      const corpo = {
        codigo,
        tipo: form.tipo,
        valor: Number(form.valor),
        minimo_pedido: Number(form.minimo_pedido || 0),
        uso_maximo: form.uso_maximo.trim() ? Math.trunc(Number(form.uso_maximo)) : null,
        validade: form.validade || null,
        ativo: form.ativo,
      };
      if (!(corpo.valor >= 0)) throw new ApiError(400, 'Informe o valor do desconto.');
      if (corpo.tipo === 'percentual' && corpo.valor > 100) throw new ApiError(400, 'Percentual não pode passar de 100%.');
      if (editando) {
        await apiFetch(`/commerce/cupons/${id}`, { method: 'PUT', body: JSON.stringify(corpo) });
        toast.success('Cupom atualizado.');
      } else {
        await apiFetch('/commerce/cupons', { method: 'POST', body: JSON.stringify(corpo) });
        toast.success('Cupom criado.');
      }
      navigate('/commerce/cupons');
    } catch (e) {
      setErro(e instanceof ApiError ? e.message : 'Falha ao salvar o cupom.');
    } finally {
      setSalvando(false);
    }
  };

  if (carregando) return <Spinner label="Carregando cupom…" />;

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <PageHeader
        title={editando ? 'Editar cupom' : 'Novo cupom'}
        description="O cliente digita o código no carrinho; o servidor valida vigência, mínimo e limite de uso de forma atômica (a corrida do último uso só deixa passar um pedido)."
        actions={
          <button type="button" className="btn-ghost" onClick={() => navigate('/commerce/cupons')}>
            <ArrowLeft className="h-4 w-4" aria-hidden="true" /> Cupons
          </button>
        }
      />
      {erro && <Alert tone="red">{erro}</Alert>}
      <form
        className="space-y-4 rounded-xl border border-line bg-surface p-4"
        onSubmit={(e) => {
          e.preventDefault();
          void salvar();
        }}
      >
        <label className="block text-sm">
          <span className="text-ink-soft">Código *</span>
          <input
            className="input mt-1 font-mono uppercase"
            value={form.codigo}
            maxLength={40}
            required
            disabled={editando}
            onChange={(e) => setForm((f) => ({ ...f, codigo: e.target.value }))}
            placeholder="EX.: BEMVINDO10"
          />
          {editando && <span className="mt-1 block text-xs text-muted">O código não muda depois de criado (pedidos já usaram).</span>}
        </label>
        <div className="grid gap-4 sm:grid-cols-3">
          <label className="block text-sm">
            <span className="text-ink-soft">Tipo *</span>
            <select className="input mt-1" value={form.tipo} onChange={(e) => setForm((f) => ({ ...f, tipo: e.target.value as Formulario['tipo'] }))}>
              <option value="percentual">Percentual (%)</option>
              <option value="valor">Valor fixo (R$)</option>
            </select>
          </label>
          <label className="block text-sm">
            <span className="text-ink-soft">Valor *</span>
            <input className="input mt-1" inputMode="decimal" required value={form.valor} onChange={(e) => setForm((f) => ({ ...f, valor: e.target.value }))} />
          </label>
          <label className="block text-sm">
            <span className="text-ink-soft">Pedido mínimo (R$)</span>
            <input className="input mt-1" inputMode="decimal" value={form.minimo_pedido} onChange={(e) => setForm((f) => ({ ...f, minimo_pedido: e.target.value }))} />
          </label>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block text-sm">
            <span className="text-ink-soft">Limite de usos (vazio = ilimitado)</span>
            <input type="number" min={1} className="input mt-1" value={form.uso_maximo} onChange={(e) => setForm((f) => ({ ...f, uso_maximo: e.target.value }))} />
          </label>
          <label className="block text-sm">
            <span className="text-ink-soft">Válido até (vazio = sem prazo)</span>
            <input type="date" className="input mt-1" value={form.validade} onChange={(e) => setForm((f) => ({ ...f, validade: e.target.value }))} />
          </label>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={form.ativo} onChange={(e) => setForm((f) => ({ ...f, ativo: e.target.checked }))} />
          Cupom ativo
        </label>
        <div className="flex gap-3">
          <button type="submit" className="btn-primary" disabled={salvando}>
            <Save className="h-4 w-4" aria-hidden="true" /> {salvando ? 'Salvando…' : 'Salvar cupom'}
          </button>
          <button type="button" className="btn-secondary" onClick={() => navigate('/commerce/cupons')}>
            Cancelar
          </button>
        </div>
      </form>
    </div>
  );
}
