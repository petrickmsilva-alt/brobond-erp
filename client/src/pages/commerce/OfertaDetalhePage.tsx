// ============================================================================
// COMMERCE — DETALHE DA OFERTA. Rota /commerce/ofertas/:id.
//
// Uma linha de `commerce_precos` com a precedência server-side explicitada e
// o estado da publicação no canal. Ações: editar (página própria) e abrir o
// produto (fila/publicações).
// ============================================================================
import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Pencil, Store } from 'lucide-react';
import { apiFetch, ApiError } from '../../lib/api';
import { Alert, Badge, PageHeader, Spinner } from '../../components/ui';
import { EstadoBadge, ROTULO_PUBLICACAO, TONE_PUBLICACAO, dataHora, grana, rotuloCanal } from './shared';
import type { Oferta } from './OfertasPage';

const TONE_VIGENCIA: Record<string, 'slate' | 'blue' | 'amber' | 'green' | 'red'> = {
  vigente: 'green',
  futura: 'amber',
  vencida: 'amber',
  sem_vigencia: 'blue',
};

export default function CommerceOfertaDetalhePage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState('');
  const [oferta, setOferta] = useState<Oferta | null>(null);

  const carregar = useCallback(async () => {
    setCarregando(true);
    setErro('');
    try {
      const r = await apiFetch<{ oferta: Oferta }>(`/commerce/ofertas/${id}`);
      setOferta(r.oferta);
    } catch (e) {
      setErro(e instanceof ApiError ? e.message : 'Não foi possível carregar a oferta.');
    } finally {
      setCarregando(false);
    }
  }, [id]);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  if (carregando) return <Spinner label="Carregando oferta…" />;

  if (!oferta) {
    return (
      <div className="space-y-4">
        <PageHeader title="Oferta" actions={<button className="btn-ghost" onClick={() => navigate('/commerce/ofertas')}>Voltar</button>} />
        <Alert tone="red">{erro || 'Oferta não encontrada.'}</Alert>
      </div>
    );
  }

  const situacao = !oferta.vigencia_inicio && !oferta.vigencia_fim
    ? { chave: 'sem_vigencia', rotulo: 'Sem vigência (sempre ativa)' }
    : oferta.vigente
      ? { chave: 'vigente', rotulo: 'Vigente' }
      : { chave: 'vencida', rotulo: 'Fora da vigência — vale a tabela' };

  return (
    <div className="space-y-4">
      <PageHeader
        title={`Oferta · ${oferta.nome}`}
        description={`${rotuloCanal(oferta.canal)} — preço por canal da empresa (tenant do ator). O preço final é recalculado no servidor.`}
        actions={
          <>
            <button type="button" className="btn-ghost" onClick={() => navigate('/commerce/ofertas')}>
              <ArrowLeft className="h-4 w-4" aria-hidden="true" /> Ofertas
            </button>
            <button type="button" className="btn-primary" onClick={() => navigate(`/commerce/ofertas/${oferta.id}/editar`)}>
              <Pencil className="h-4 w-4" aria-hidden="true" /> Editar
            </button>
          </>
        }
      />
      {erro && <Alert tone="red">{erro}</Alert>}

      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-xl border border-line bg-surface p-4">
          <div className="text-xs font-semibold uppercase tracking-wide text-muted">Preço do canal</div>
          <div className="mt-1 font-mono text-xl font-semibold tabular-nums">{grana(oferta.preco)}</div>
          <div className="text-xs text-muted">tabela: {grana(oferta.preco_base)}</div>
        </div>
        <div className="rounded-xl border border-line bg-surface p-4">
          <div className="text-xs font-semibold uppercase tracking-wide text-muted">Preço promocional</div>
          <div className="mt-1 font-mono text-xl font-semibold tabular-nums">{oferta.preco_promo != null ? grana(oferta.preco_promo) : '—'}</div>
          <div className="text-xs text-muted">soma com cupom? não — vence o maior desconto</div>
        </div>
        <div className="rounded-xl border border-line bg-surface p-4">
          <div className="text-xs font-semibold uppercase tracking-wide text-muted">Vigência</div>
          <div className="mt-1 text-sm tabular-nums">
            {oferta.vigencia_inicio ?? '—'} → {oferta.vigencia_fim ?? 'sem fim'}
          </div>
          <Badge tone={TONE_VIGENCIA[situacao.chave]}>{situacao.rotulo}</Badge>
        </div>
        <div className="rounded-xl border border-line bg-surface p-4">
          <div className="text-xs font-semibold uppercase tracking-wide text-muted">Preço final (servidor)</div>
          <div className="mt-1 font-mono text-xl font-semibold tabular-nums">{grana(oferta.preco_efetivo.preco)}</div>
          <div className="text-xs text-muted">
            {oferta.preco_efetivo.promo != null ? `promo ${grana(oferta.preco_efetivo.promo)} · ` : ''}
            {oferta.preco_efetivo.origem === 'canal' ? 'linha do canal' : 'tabela'}
          </div>
        </div>
      </section>

      <section className="rounded-xl border border-line bg-surface p-4" aria-labelledby="precedencia-oferta">
        <h2 id="precedencia-oferta" className="mb-2 text-sm font-semibold uppercase tracking-wide text-muted">
          Precedência (server-side)
        </h2>
        <ol className="list-decimal space-y-1 pl-5 text-sm text-ink-soft">
          <li>Linha de preço do canal COM vigência ativa vale acima da tabela.</li>
          <li>Sem vigência ativa (futura/vencida), vale o preço de tabela do produto.</li>
          <li>Preço promocional só vale quando menor que o preço do canal.</li>
          <li>No carrinho, promoção e cupom não acumulam — vence o maior desconto.</li>
        </ol>
      </section>

      <section className="rounded-xl border border-line bg-surface p-4">
        <dl className="grid gap-3 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-ink-soft">Produto</dt>
            <dd>
              <Link className="font-medium hover:underline" to={`/commerce/produtos/${oferta.produto_id}`}>
                {oferta.nome}
              </Link>
              <span className="ml-2 text-xs text-muted">{oferta.sku}</span>
            </dd>
          </div>
          <div>
            <dt className="text-ink-soft">Publicação no canal</dt>
            <dd>
              {oferta.publicacao_estado ? (
                <Link to={`/commerce/publicacoes/${oferta.publicacao_id}`}>
                  <EstadoBadge estado={oferta.publicacao_estado} mapa={TONE_PUBLICACAO} rotulos={ROTULO_PUBLICACAO} />
                </Link>
              ) : (
                <span className="text-muted">não publicada</span>
              )}
            </dd>
          </div>
        </dl>
      </section>

      <div className="flex flex-wrap gap-3">
        <Link className="btn-secondary" to={`/commerce/produtos/${oferta.produto_id}`}>
          <Store className="h-4 w-4" aria-hidden="true" /> Abrir produto
        </Link>
        {oferta.publicacao_id != null && (
          <Link className="btn-secondary" to={`/commerce/publicacoes/${oferta.publicacao_id}`}>
            Ver publicação
          </Link>
        )}
        <span className="self-center text-xs text-muted">Atualizada {dataHora(oferta.atualizado_em ?? null)}</span>
      </div>
    </div>
  );
}
