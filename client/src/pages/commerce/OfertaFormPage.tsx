// ============================================================================
// COMMERCE — FORM DE OFERTA (preço por canal). ZERO MODAL.
// /commerce/ofertas/novo e /commerce/ofertas/:id/editar
//
// Grava em `commerce_precos` via PUT /produtos/:id/precos — mesma linha que a
// publicação usa. O servidor recalcula a precedência e reenfileira os canais
// publicados; a tela só envia números validados.
// ============================================================================
import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Save } from 'lucide-react';
import { apiFetch, ApiError } from '../../lib/api';
import { Alert, PageHeader, Spinner, useToast } from '../../components/ui';
import { CANAIS_PUBLICACAO, rotuloCanal } from './shared';
import type { Oferta } from './OfertasPage';

type ProdutoOpcao = { id: number; sku: string; nome: string; preco_base: number };

type Formulario = {
  produto_id: string;
  canal: string;
  preco: string;
  preco_promo: string;
  vigencia_inicio: string;
  vigencia_fim: string;
};

const VAZIO: Formulario = { produto_id: '', canal: 'BROBOND', preco: '', preco_promo: '', vigencia_inicio: '', vigencia_fim: '' };

export default function CommerceOfertaFormPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const editando = !!id;

  const [form, setForm] = useState<Formulario>(VAZIO);
  const [produtoBusca, setProdutoBusca] = useState('');
  const [produtos, setProdutos] = useState<ProdutoOpcao[]>([]);
  const [produtoEscolhido, setProdutoEscolhido] = useState<ProdutoOpcao | null>(null);
  const [carregando, setCarregando] = useState(editando);
  const [salvando, setSalvando] = useState(false);
  const [erro, setErro] = useState('');

  // Edição: carrega a oferta pelo id e preenche o form + produto.
  useEffect(() => {
    if (!id) return;
    let vivo = true;
    (async () => {
      try {
        const r = await apiFetch<{ oferta: Oferta }>(`/commerce/ofertas/${id}`);
        if (!vivo) return;
        const o = r.oferta;
        setForm({
          produto_id: String(o.produto_id),
          canal: o.canal,
          preco: String(o.preco),
          preco_promo: o.preco_promo != null ? String(o.preco_promo) : '',
          vigencia_inicio: o.vigencia_inicio ?? '',
          vigencia_fim: o.vigencia_fim ?? '',
        });
        setProdutoEscolhido({ id: o.produto_id, sku: o.sku, nome: o.nome, preco_base: o.preco_base });
        setProdutoBusca(o.nome);
      } catch (e) {
        if (vivo) setErro(e instanceof ApiError ? e.message : 'Falha ao carregar a oferta.');
      } finally {
        if (vivo) setCarregando(false);
      }
    })();
    return () => {
      vivo = false;
    };
  }, [id]);

  // Busca de produtos (novo).
  useEffect(() => {
    if (editando) return;
    const termo = produtoBusca.trim();
    if (termo.length < 2) {
      setProdutos([]);
      return;
    }
    const t = window.setTimeout(async () => {
      try {
        const r = await apiFetch<{ produtos: ProdutoOpcao[] }>(`/commerce/produtos?q=${encodeURIComponent(termo)}`);
        setProdutos(r.produtos.slice(0, 10));
      } catch {
        setProdutos([]);
      }
    }, 300);
    return () => window.clearTimeout(t);
  }, [produtoBusca, editando]);

  const salvar = async () => {
    setSalvando(true);
    setErro('');
    try {
      const preco = Number(form.preco);
      if (!Number.isFinite(preco) || preco < 0) throw new ApiError(400, 'Informe um preço maior ou igual a zero.');
      const promo = form.preco_promo.trim() ? Number(form.preco_promo) : null;
      if (promo !== null && (!Number.isFinite(promo) || promo < 0)) throw new ApiError(400, 'Preço promocional inválido.');
      if (promo !== null && promo >= preco) throw new ApiError(400, 'O preço promocional precisa ser menor que o preço do canal.');
      if (form.vigencia_fim && form.vigencia_inicio && form.vigencia_fim < form.vigencia_inicio) {
        throw new ApiError(400, 'A vigência final não pode ser anterior ao início.');
      }
      const produtoId = Number(form.produto_id || produtoEscolhido?.id || 0);
      if (!produtoId) throw new ApiError(400, 'Selecione o produto da oferta.');

      await apiFetch(`/commerce/produtos/${produtoId}/precos`, {
        method: 'PUT',
        body: JSON.stringify({
          canal: form.canal,
          preco,
          preco_promo: promo,
          vigencia_inicio: form.vigencia_inicio || null,
          vigencia_fim: form.vigencia_fim || null,
        }),
      });
      toast.success(
        editando
          ? `Oferta de ${rotuloCanal(form.canal)} atualizada — canais publicados ganham nova versão.`
          : `Oferta criada: ${rotuloCanal(form.canal)} com preço ${preco.toFixed(2).replace('.', ',')}.`
      );
      navigate('/commerce/ofertas');
    } catch (e) {
      setErro(e instanceof ApiError ? e.message : 'Falha ao salvar a oferta.');
    } finally {
      setSalvando(false);
    }
  };

  if (carregando) return <Spinner label="Carregando oferta…" />;

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <PageHeader
        title={editando ? 'Editar oferta' : 'Nova oferta'}
        description="Preço por canal com vigência opcional, por cima da tabela. Sem linha vigente, o canal usa o preço de tabela — a precedência é do servidor."
        actions={
          <button type="button" className="btn-ghost" onClick={() => navigate('/commerce/ofertas')}>
            <ArrowLeft className="h-4 w-4" aria-hidden="true" /> Ofertas
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
        {!editando && (
          <label className="block text-sm">
            <span className="text-ink-soft">Produto *</span>
            <input
              className="input mt-1"
              value={produtoBusca}
              onChange={(e) => {
                setProdutoBusca(e.target.value);
                setProdutoEscolhido(null);
                setForm((f) => ({ ...f, produto_id: '' }));
              }}
              placeholder="Buscar por SKU ou nome (mín. 2 caracteres)"
              required
            />
            {!produtoEscolhido && produtos.length > 0 && (
              <ul className="mt-1 divide-y divide-line rounded-lg border border-line">
                {produtos.map((p) => (
                  <li key={p.id}>
                    <button
                      type="button"
                      className="w-full px-3 py-2 text-left text-sm hover:bg-surface2"
                      onClick={() => {
                        setProdutoEscolhido(p);
                        setProdutoBusca(`${p.nome} (${p.sku})`);
                        setForm((f) => ({ ...f, produto_id: String(p.id), preco: f.preco || String(p.preco_base) }));
                        setProdutos([]);
                      }}
                    >
                      <span className="font-medium">{p.nome}</span>
                      <span className="ml-2 text-xs text-muted">{p.sku}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {produtoEscolhido && (
              <span className="mt-1 block text-xs text-muted">
                Produto: <strong>{produtoEscolhido.nome}</strong> · tabela {produtoEscolhido.preco_base.toFixed(2).replace('.', ',')}
              </span>
            )}
          </label>
        )}
        {editando && produtoEscolhido && (
          <div className="rounded-lg border border-line px-3 py-2 text-sm">
            <span className="text-ink-soft">Produto: </span>
            <span className="font-medium">{produtoEscolhido.nome}</span>
            <span className="ml-2 text-xs text-muted">{produtoEscolhido.sku}</span>
          </div>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block text-sm">
            <span className="text-ink-soft">Canal *</span>
            <select
              className="input mt-1"
              value={form.canal}
              disabled={editando}
              onChange={(e) => setForm((f) => ({ ...f, canal: e.target.value }))}
            >
              {CANAIS_PUBLICACAO.map((c) => (
                <option key={c.valor} value={c.valor}>
                  {c.rotulo}
                </option>
              ))}
            </select>
            {editando && <span className="mt-1 block text-xs text-muted">O canal é a identidade da oferta e não muda.</span>}
          </label>
          <label className="block text-sm">
            <span className="text-ink-soft">Preço (R$) *</span>
            <input className="input mt-1" inputMode="decimal" required value={form.preco} onChange={(e) => setForm((f) => ({ ...f, preco: e.target.value }))} />
          </label>
          <label className="block text-sm">
            <span className="text-ink-soft">Preço promocional (R$)</span>
            <input
              className="input mt-1"
              inputMode="decimal"
              value={form.preco_promo}
              onChange={(e) => setForm((f) => ({ ...f, preco_promo: e.target.value }))}
              placeholder="vazio = sem promoção"
            />
          </label>
          <div />
          <label className="block text-sm">
            <span className="text-ink-soft">Vigência — início</span>
            <input type="date" className="input mt-1" value={form.vigencia_inicio} onChange={(e) => setForm((f) => ({ ...f, vigencia_inicio: e.target.value }))} />
          </label>
          <label className="block text-sm">
            <span className="text-ink-soft">Vigência — fim (vazio = sem fim)</span>
            <input
              type="date"
              className="input mt-1"
              value={form.vigencia_fim}
              min={form.vigencia_inicio || undefined}
              onChange={(e) => setForm((f) => ({ ...f, vigencia_fim: e.target.value }))}
            />
          </label>
        </div>

        <div className="flex gap-3">
          <button type="submit" className="btn-primary" disabled={salvando}>
            <Save className="h-4 w-4" aria-hidden="true" /> {salvando ? 'Salvando…' : 'Salvar oferta'}
          </button>
          <button type="button" className="btn-secondary" onClick={() => navigate('/commerce/ofertas')}>
            Cancelar
          </button>
        </div>
      </form>
    </div>
  );
}
