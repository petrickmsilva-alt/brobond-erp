// ============================================================================
// COMMERCE — FORM DE PROMOÇÃO (página própria, ZERO MODAL).
// /commerce/promocoes/nova e /commerce/promocoes/:id/editar
// ============================================================================
import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Save } from 'lucide-react';
import { apiFetch, ApiError } from '../../lib/api';
import { Alert, PageHeader, Spinner, useToast } from '../../components/ui';

type Formulario = {
  nome: string;
  tipo: 'percentual' | 'valor';
  valor: string;
  minimo_pedido: string;
  data_inicio: string;
  data_fim: string;
  ativo: boolean;
};

const HOJE = new Date().toISOString().slice(0, 10);
const VAZIO: Formulario = { nome: '', tipo: 'percentual', valor: '', minimo_pedido: '0', data_inicio: HOJE, data_fim: '', ativo: true };

export default function CommercePromocaoFormPage() {
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
    apiFetch<{ promocoes?: { id: number; nome: string; tipo: string; valor: number; minimo_pedido: number; data_inicio: string; data_fim: string | null; ativo: boolean }[] }>(
      '/commerce/promocoes?page=1&pageSize=200'
    )
      .then((r) => {
        const p = (r.promocoes ?? []).find((x) => String(x.id ?? '') === String(id));
        if (!p) throw new ApiError(404, 'Promoção não encontrada.');
        if (vivo) {
          setForm({
            nome: p.nome,
            tipo: p.tipo === 'valor' ? 'valor' : 'percentual',
            valor: String(p.valor),
            minimo_pedido: String(p.minimo_pedido ?? 0),
            data_inicio: String(p.data_inicio || HOJE).slice(0, 10),
            data_fim: p.data_fim ? String(p.data_fim).slice(0, 10) : '',
            ativo: p.ativo !== false,
          });
        }
      })
      .catch((e) => {
        if (vivo) setErro(e instanceof ApiError ? e.message : 'Falha ao carregar a promoção.');
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
      const corpo = {
        nome: form.nome.trim(),
        tipo: form.tipo,
        valor: Number(form.valor),
        minimo_pedido: Number(form.minimo_pedido || 0),
        data_inicio: form.data_inicio,
        data_fim: form.data_fim || null,
        ativo: form.ativo,
      };
      if (!corpo.nome) throw new ApiError(400, 'Informe o nome da promoção.');
      if (!(corpo.valor >= 0)) throw new ApiError(400, 'Informe o valor do desconto.');
      if (corpo.tipo === 'percentual' && corpo.valor > 100) throw new ApiError(400, 'Percentual não pode passar de 100%.');
      if (editando) {
        await apiFetch(`/commerce/promocoes/${id}`, { method: 'PUT', body: JSON.stringify(corpo) });
        toast.success('Promoção atualizada.');
      } else {
        await apiFetch('/commerce/promocoes', { method: 'POST', body: JSON.stringify(corpo) });
        toast.success('Promoção criada.');
      }
      navigate('/commerce/promocoes');
    } catch (e) {
      setErro(e instanceof ApiError ? e.message : 'Falha ao salvar a promoção.');
    } finally {
      setSalvando(false);
    }
  };

  if (carregando) return <Spinner label="Carregando promoção…" />;

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <PageHeader
        title={editando ? 'Editar promoção' : 'Nova promoção'}
        description="Aplicada automaticamente no carrinho da loja própria quando o pedido atender ao mínimo. Não acumula com cupom."
        actions={
          <button type="button" className="btn-ghost" onClick={() => navigate('/commerce/promocoes')}>
            <ArrowLeft className="h-4 w-4" aria-hidden="true" /> Promoções
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
          <span className="text-ink-soft">Nome *</span>
          <input className="input mt-1" value={form.nome} maxLength={120} required onChange={(e) => setForm((f) => ({ ...f, nome: e.target.value }))} placeholder="Ex.: Volta às aulas" />
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
            <span className="text-ink-soft">Início *</span>
            <input type="date" className="input mt-1" required value={form.data_inicio} onChange={(e) => setForm((f) => ({ ...f, data_inicio: e.target.value }))} />
          </label>
          <label className="block text-sm">
            <span className="text-ink-soft">Fim (vazio = sem fim)</span>
            <input type="date" className="input mt-1" value={form.data_fim} min={form.data_inicio || undefined} onChange={(e) => setForm((f) => ({ ...f, data_fim: e.target.value }))} />
          </label>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={form.ativo} onChange={(e) => setForm((f) => ({ ...f, ativo: e.target.checked }))} />
          Promoção ativa
        </label>
        <div className="flex gap-3">
          <button type="submit" className="btn-primary" disabled={salvando}>
            <Save className="h-4 w-4" aria-hidden="true" /> {salvando ? 'Salvando…' : 'Salvar promoção'}
          </button>
          <button type="button" className="btn-secondary" onClick={() => navigate('/commerce/promocoes')}>
            Cancelar
          </button>
        </div>
      </form>
    </div>
  );
}
