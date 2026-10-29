// ============================================================================
// COMMERCE — NOVA PUBLICAÇÃO (fila multicanal). Rota /commerce/publicacoes/novo.
//
// CRIA a publicação produto × canais (POST /commerce/publicacoes). O histórico
// e o retry ficam em /commerce/publicacoes; a edição do conteúdo de um canal
// é /commerce/publicacoes/:id/editar. ZERO MODAL: página própria.
// ============================================================================
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Rocket, Search } from 'lucide-react';
import { apiFetch, ApiError } from '../../lib/api';
import { Alert, Badge, EmptyState, PageHeader, Spinner, useToast } from '../../components/ui';
import { CANAIS_PUBLICACAO, grana } from './shared';

type Produto = {
  id: number;
  sku: string;
  nome: string;
  preco_base: number;
  disponivel: number;
  publicacoes: Record<string, { estado: string }>;
};

export default function CommercePublicacaoNovaPage() {
  const navigate = useNavigate();
  const toast = useToast();

  const [busca, setBusca] = useState('');
  const [buscando, setBuscando] = useState(false);
  const [produtos, setProdutos] = useState<Produto[]>([]);
  const [selecionado, setSelecionado] = useState<Produto | null>(null);
  const [canais, setCanais] = useState<string[]>([]);
  const [salvando, setSalvando] = useState(false);
  const [erro, setErro] = useState('');

  const buscar = async (termo: string) => {
    if (termo.trim().length < 2) {
      setProdutos([]);
      return;
    }
    setBuscando(true);
    setErro('');
    try {
      const r = await apiFetch<{ produtos: Produto[] }>(`/commerce/produtos?q=${encodeURIComponent(termo.trim())}`);
      setProdutos(r.produtos.slice(0, 12));
    } catch (e) {
      setErro(e instanceof ApiError ? e.message : 'Falha ao buscar produtos.');
    } finally {
      setBuscando(false);
    }
  };

  useEffect(() => {
    const t = window.setTimeout(() => void buscar(busca), 300);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busca]);

  const alternarCanal = (canal: string) => {
    setCanais((c) => (c.includes(canal) ? c.filter((x) => x !== canal) : [...c, canal]));
  };

  const publicar = async () => {
    setSalvando(true);
    setErro('');
    try {
      if (!selecionado) throw new ApiError(400, 'Selecione o produto que será publicado.');
      if (!canais.length) throw new ApiError(400, 'Marque ao menos um canal.');
      await apiFetch('/commerce/publicacoes', {
        method: 'POST',
        body: JSON.stringify({ produto_id: selecionado.id, canais }),
      });
      toast.success(`${selecionado.nome}: publicação enviada para a fila (${canais.join(', ')}).`);
      navigate('/commerce/publicacoes');
    } catch (e) {
      setErro(e instanceof ApiError ? e.message : 'Falha ao enfileirar a publicação.');
    } finally {
      setSalvando(false);
    }
  };

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <PageHeader
        title="Nova publicação"
        description="Enfileira o produto nos canais escolhidos. O PUBLISHED só vem depois da confirmação da API externa — sem credencial, o erro real aparece na fila."
        actions={
          <button type="button" className="btn-ghost" onClick={() => navigate('/commerce/publicacoes')}>
            <ArrowLeft className="h-4 w-4" aria-hidden="true" /> Fila
          </button>
        }
      />
      {erro && <Alert tone="red">{erro}</Alert>}

      <section className="rounded-xl border border-line bg-surface p-4" aria-labelledby="sel-produto">
        <h2 id="sel-produto" className="mb-2 flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-muted">
          <Search className="h-4 w-4" aria-hidden="true" /> 1. Produto
        </h2>
        <label className="block text-sm">
          <span className="text-ink-soft">Buscar produto (SKU ou nome)</span>
          <input
            className="input mt-1"
            value={busca}
            onChange={(e) => {
              setBusca(e.target.value);
              setSelecionado(null);
            }}
            placeholder="Ex.: SKU-100 ou Camiseta"
          />
        </label>
        {buscando && <Spinner label="Buscando…" />}
        {!buscando && busca.trim().length >= 2 && produtos.length === 0 && (
          <p className="mt-2 text-sm text-muted">Nenhum produto encontrado.</p>
        )}
        {produtos.length > 0 && !selecionado && (
          <ul className="mt-2 divide-y divide-line rounded-lg border border-line">
            {produtos.map((p) => (
              <li key={p.id}>
                <button
                  type="button"
                  className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm hover:bg-surface2"
                  onClick={() => {
                    setSelecionado(p);
                    setProdutos([]);
                  }}
                >
                  <span className="min-w-0">
                    <span className="block truncate font-medium">{p.nome}</span>
                    <span className="text-xs text-muted">
                      {p.sku} · {grana(p.preco_base)} · disponível {p.disponivel}
                    </span>
                  </span>
                  <Badge tone="blue">{Object.keys(p.publicacoes ?? {}).length} canal(is)</Badge>
                </button>
              </li>
            ))}
          </ul>
        )}
        {selecionado && (
          <div className="mt-3 flex items-center justify-between gap-3 rounded-lg border border-brand-400/40 bg-brand-500/5 px-3 py-2">
            <span className="min-w-0 text-sm">
              <span className="font-medium">{selecionado.nome}</span>
              <span className="ml-2 text-xs text-muted">
                {selecionado.sku} · {grana(selecionado.preco_base)}
              </span>
            </span>
            <button type="button" className="btn-ghost" onClick={() => setSelecionado(null)}>
              Trocar
            </button>
          </div>
        )}
      </section>

      <section className="rounded-xl border border-line bg-surface p-4" aria-labelledby="sel-canais">
        <h2 id="sel-canais" className="mb-2 flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-muted">
          <Rocket className="h-4 w-4" aria-hidden="true" /> 2. Canais
        </h2>
        <ul className="space-y-2">
          {CANAIS_PUBLICACAO.map((c) => {
            const estadoAtual = selecionado?.publicacoes?.[c.valor]?.estado;
            return (
              <li key={c.valor}>
                <label className="flex items-start gap-2 text-sm">
                  <input type="checkbox" className="mt-1" checked={canais.includes(c.valor)} onChange={() => alternarCanal(c.valor)} />
                  <span>
                    <span className="font-medium">{c.rotulo}</span>
                    {estadoAtual && <span className="ml-2 text-xs text-muted">estado atual: {estadoAtual}</span>}
                    {c.valor === 'INSTAGRAM_SHOPPING' && (
                      <span className="block text-xs text-muted">
                        A Graph API não publica item individual — a fila responderá REJECTED com o motivo real (documentado).
                      </span>
                    )}
                    {c.valor === 'BROBOND' && (
                      <span className="block text-xs text-muted">Exige o produto projetado na vitrine (slug) antes de publicar.</span>
                    )}
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
      </section>

      {produtos.length === 0 && !selecionado && busca.trim().length < 2 && (
        <EmptyState icon={<Search className="h-6 w-6" aria-hidden="true" />} title="Busque um produto" description="Digite ao menos 2 caracteres para escolher o produto a publicar." />
      )}

      <div className="flex gap-3">
        <button type="button" className="btn-primary" disabled={salvando} onClick={() => void publicar()}>
          <Rocket className="h-4 w-4" aria-hidden="true" /> {salvando ? 'Enfileirando…' : 'Publicar nos canais'}
        </button>
        <button type="button" className="btn-secondary" onClick={() => navigate('/commerce/publicacoes')}>
          Cancelar
        </button>
      </div>
    </div>
  );
}
