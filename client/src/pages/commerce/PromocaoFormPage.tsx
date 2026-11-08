// ============================================================================
// COMMERCE — FORM DE PROMOÇÃO (página própria, ZERO MODAL).
// /commerce/promocoes/nova e /commerce/promocoes/:id/editar
//
// Escopo (0108): pedido inteiro, produtos específicos ou categorias. Alvos são
// produtos OU categorias, nunca os dois. Canal restringe a elegibilidade e
// `prioridade` desempata quando dois descontos empatam.
// ============================================================================
import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Save, X } from 'lucide-react';
import { apiFetch, ApiError } from '../../lib/api';
import { Alert, PageHeader, Spinner, useToast } from '../../components/ui';

type Escopo = 'pedido' | 'produto' | 'categoria';
type Canal = 'todos' | 'varejo' | 'atacado';

type Formulario = {
  nome: string;
  tipo: 'percentual' | 'valor';
  valor: string;
  escopo: Escopo;
  canal: Canal;
  prioridade: string;
  minimo_pedido: string;
  data_inicio: string;
  data_fim: string;
  ativo: boolean;
  produtos: number[];
  categorias: number[];
};

type ProdutoOpcao = { id: number; sku: string; nome: string };
type CategoriaOpcao = { value: number; label: string };

const HOJE = new Date().toISOString().slice(0, 10);
const VAZIO: Formulario = {
  nome: '',
  tipo: 'percentual',
  valor: '',
  escopo: 'pedido',
  canal: 'todos',
  prioridade: '0',
  minimo_pedido: '0',
  data_inicio: HOJE,
  data_fim: '',
  ativo: true,
  produtos: [],
  categorias: [],
};

type PromocaoApi = {
  id: number;
  nome: string;
  tipo: string;
  valor: number;
  escopo?: string;
  canal?: string;
  prioridade?: number;
  minimo_pedido: number;
  data_inicio: string;
  data_fim: string | null;
  ativo: boolean;
  produtos?: number[];
  categorias?: number[];
};

export default function CommercePromocaoFormPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const editando = !!id;

  const [form, setForm] = useState<Formulario>(VAZIO);
  const [carregando, setCarregando] = useState(editando);
  const [salvando, setSalvando] = useState(false);
  const [erro, setErro] = useState('');
  const [buscaProduto, setBuscaProduto] = useState('');
  const [produtos, setProdutos] = useState<ProdutoOpcao[]>([]);
  const [categorias, setCategorias] = useState<CategoriaOpcao[]>([]);

  // Categorias (opções do cadastro global) — uma vez.
  useEffect(() => {
    let vivo = true;
    void (async () => {
      try {
        const r = await apiFetch<CategoriaOpcao[]>('/categorias/options');
        if (vivo) setCategorias(Array.isArray(r) ? r : []);
      } catch {
        /* a seleção de categoria fica vazia; o servidor ainda valida o escopo */
      }
    })();
    return () => {
      vivo = false;
    };
  }, []);

  // Busca de produtos (mesmo endpoint do catálogo usado nas ofertas).
  useEffect(() => {
    if (form.escopo !== 'produto') return;
    const termo = buscaProduto.trim();
    if (termo.length < 2) {
      setProdutos([]);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const r = await apiFetch<{ produtos: ProdutoOpcao[] }>(`/commerce/produtos?q=${encodeURIComponent(termo)}`, { signal: controller.signal });
          setProdutos((r?.produtos ?? []).slice(0, 20));
        } catch {
          /* busca cancelada/falha: a lista some; nada crítico */
        }
      })();
    }, 250);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [buscaProduto, form.escopo]);

  useEffect(() => {
    if (!id) return;
    let vivo = true;
    apiFetch<{ promocoes?: PromocaoApi[] }>('/commerce/promocoes?page=1&pageSize=200')
      .then((r) => {
        const p = (r.promocoes ?? []).find((x) => String(x.id ?? '') === String(id));
        if (!p) throw new ApiError(404, 'Promoção não encontrada.');
        if (vivo) {
          setForm({
            nome: p.nome,
            tipo: p.tipo === 'valor' ? 'valor' : 'percentual',
            valor: String(p.valor),
            escopo: p.escopo === 'produto' || p.escopo === 'categoria' ? p.escopo : 'pedido',
            canal: p.canal === 'varejo' || p.canal === 'atacado' ? p.canal : 'todos',
            prioridade: String(p.prioridade ?? 0),
            minimo_pedido: String(p.minimo_pedido ?? 0),
            data_inicio: String(p.data_inicio || HOJE).slice(0, 10),
            data_fim: p.data_fim ? String(p.data_fim).slice(0, 10) : '',
            ativo: p.ativo !== false,
            produtos: p.produtos ?? [],
            categorias: p.categorias ?? [],
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
        escopo: form.escopo,
        canal: form.canal,
        prioridade: Number(form.prioridade || 0),
        minimo_pedido: Number(form.minimo_pedido || 0),
        data_inicio: form.data_inicio,
        data_fim: form.data_fim || null,
        ativo: form.ativo,
        produtos: form.escopo === 'produto' ? form.produtos : [],
        categorias: form.escopo === 'categoria' ? form.categorias : [],
      };
      if (!corpo.nome) throw new ApiError(400, 'Informe o nome da promoção.');
      if (!(corpo.valor >= 0)) throw new ApiError(400, 'Informe o valor do desconto.');
      if (corpo.tipo === 'percentual' && corpo.valor > 100) throw new ApiError(400, 'Percentual não pode passar de 100%.');
      if (!Number.isInteger(corpo.prioridade) || corpo.prioridade < 0) throw new ApiError(400, 'Prioridade deve ser um inteiro ≥ 0.');
      if (corpo.escopo === 'produto' && corpo.produtos.length === 0) throw new ApiError(400, 'Selecione ao menos um produto.');
      if (corpo.escopo === 'categoria' && corpo.categorias.length === 0) throw new ApiError(400, 'Selecione ao menos uma categoria.');
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

  const adicionarProduto = (p: ProdutoOpcao) => {
    setForm((f) => (f.produtos.includes(p.id) ? f : { ...f, produtos: [...f.produtos, p.id] }));
    setBuscaProduto('');
    setProdutos([]);
  };
  const removerProduto = (produtoId: number) => setForm((f) => ({ ...f, produtos: f.produtos.filter((x) => x !== produtoId) }));
  const alternarCategoria = (categoriaId: number) =>
    setForm((f) => ({
      ...f,
      categorias: f.categorias.includes(categoriaId) ? f.categorias.filter((x) => x !== categoriaId) : [...f.categorias, categoriaId],
    }));

  if (carregando) return <Spinner label="Carregando promoção…" />;

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <PageHeader
        title={editando ? 'Editar promoção' : 'Nova promoção'}
        description="Aplicada automaticamente no carrinho da loja própria. Escopo produto/categoria desconta só o subtotal elegível. Não acumula com cupom — vence o maior desconto."
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
        <div className="grid gap-4 sm:grid-cols-3">
          <label className="block text-sm">
            <span className="text-ink-soft">Escopo *</span>
            <select className="input mt-1" value={form.escopo} onChange={(e) => setForm((f) => ({ ...f, escopo: e.target.value as Escopo }))}>
              <option value="pedido">Pedido inteiro</option>
              <option value="produto">Produtos específicos</option>
              <option value="categoria">Categorias</option>
            </select>
            <span className="mt-1 block text-xs text-ink-soft">Produto/categoria descontam só o subtotal elegível.</span>
          </label>
          <label className="block text-sm">
            <span className="text-ink-soft">Canal *</span>
            <select className="input mt-1" value={form.canal} onChange={(e) => setForm((f) => ({ ...f, canal: e.target.value as Canal }))}>
              <option value="todos">Todos os canais</option>
              <option value="varejo">Varejo</option>
              <option value="atacado">Atacado</option>
            </select>
          </label>
          <label className="block text-sm">
            <span className="text-ink-soft">Prioridade</span>
            <input className="input mt-1" inputMode="numeric" value={form.prioridade} onChange={(e) => setForm((f) => ({ ...f, prioridade: e.target.value }))} />
            <span className="mt-1 block text-xs text-ink-soft">Desempate no mesmo desconto (maior vence).</span>
          </label>
        </div>
        {form.escopo === 'produto' && (
          <div className="rounded-lg border border-line p-3">
            <span className="text-sm text-ink-soft">Produtos elegíveis *</span>
            <input
              className="input mt-1"
              value={buscaProduto}
              onChange={(e) => setBuscaProduto(e.target.value)}
              placeholder="Buscar produto por nome ou SKU (mín. 2 letras)"
            />
            {produtos.length > 0 && (
              <ul className="mt-2 max-h-48 overflow-auto rounded border border-line">
                {produtos.map((p) => (
                  <li key={p.id}>
                    <button type="button" className="flex w-full items-center justify-between px-3 py-2 text-left text-sm hover:bg-surface" onClick={() => adicionarProduto(p)}>
                      <span>{p.nome}</span>
                      <span className="text-xs text-muted">{p.sku}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {form.produtos.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-2">
                {form.produtos.map((pid) => (
                  <span key={pid} className="inline-flex items-center gap-1 rounded-full bg-surface px-3 py-1 text-xs">
                    Produto #{pid}
                    <button type="button" aria-label={`Remover produto ${pid}`} onClick={() => removerProduto(pid)}>
                      <X className="h-3 w-3" aria-hidden="true" />
                    </button>
                  </span>
                ))}
              </div>
            )}
          </div>
        )}
        {form.escopo === 'categoria' && (
          <div className="rounded-lg border border-line p-3">
            <span className="text-sm text-ink-soft">Categorias elegíveis *</span>
            {categorias.length === 0 ? (
              <p className="mt-1 text-xs text-muted">Nenhuma categoria cadastrada.</p>
            ) : (
              <div className="mt-2 grid max-h-48 grid-cols-2 gap-2 overflow-auto">
                {categorias.map((c) => (
                  <label key={c.value} className="flex items-center gap-2 text-sm">
                    <input type="checkbox" checked={form.categorias.includes(c.value)} onChange={() => alternarCategoria(c.value)} />
                    {c.label}
                  </label>
                ))}
              </div>
            )}
          </div>
        )}
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
