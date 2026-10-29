// ============================================================================
// COMMERCE — DETALHE DA PUBLICAÇÃO. Rota /commerce/publicacoes/:id.
//
// Uma linha da fila × produto × canal com versão, tentativas, erro real do
// canal, preço vigente e metadados. Ações: editar (página própria),
// reprocessar (retry manual) e despublicar (vitrine própria, com confirmação
// inline — ZERO MODAL).
// ============================================================================
import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Pencil, RefreshCw, Rocket, Store } from 'lucide-react';
import { apiFetch, ApiError } from '../../lib/api';
import { Alert, Badge, ConfirmacaoInline, PageHeader, Spinner, useToast } from '../../components/ui';
import { CANAIS_PUBLICACAO, EstadoBadge, ROTULO_PUBLICACAO, TONE_PUBLICACAO, dataHora, grana, rotuloCanal } from './shared';

type Detalhe = {
  publicacao: {
    id: number;
    produto_id: number;
    canal: string;
    versao: number;
    estado: string;
    external_id: string | null;
    tentativas: number;
    ultimo_erro: string | null;
    proxima_tentativa_em: string | null;
    publicado_em: string | null;
    atualizado_em: string | null;
  };
  produto: { id: number; sku: string; nome: string; preco_base: number; na_vitrine: boolean };
  preco: {
    preco: number;
    promo: number | null;
    origem: string;
    linha: { preco: number; preco_promo: number | null; vigencia_inicio: string | null; vigencia_fim: string | null } | null;
  };
  metadados: Record<string, unknown>;
};

export default function CommercePublicacaoDetalhePage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const toast = useToast();

  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState('');
  const [detalhe, setDetalhe] = useState<Detalhe | null>(null);
  const [ocupado, setOcupado] = useState(false);
  const [confirmandoDespublicar, setConfirmandoDespublicar] = useState(false);

  const carregar = useCallback(async () => {
    setCarregando(true);
    setErro('');
    try {
      const r = await apiFetch<Detalhe>(`/commerce/publicacoes/${id}`);
      setDetalhe(r);
    } catch (e) {
      setErro(e instanceof ApiError ? e.message : 'Não foi possível carregar a publicação.');
    } finally {
      setCarregando(false);
    }
  }, [id]);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  const reprocessar = async () => {
    setOcupado(true);
    setErro('');
    try {
      await apiFetch(`/commerce/publicacoes/${id}/reprocessar`, { method: 'POST' });
      toast.success('Publicação reenfileirada — a fila tenta de novo agora.');
      await carregar();
    } catch (e) {
      setErro(e instanceof ApiError ? e.message : 'Falha ao reprocessar.');
    } finally {
      setOcupado(false);
    }
  };

  const despublicar = async () => {
    if (!detalhe) return;
    setOcupado(true);
    setErro('');
    try {
      await apiFetch(`/commerce/produtos/${detalhe.produto.id}/despublicar`, {
        method: 'POST',
        body: JSON.stringify({ canal: detalhe.publicacao.canal }),
      });
      toast.success('Produto despublicado da vitrine própria.');
      setConfirmandoDespublicar(false);
      await carregar();
    } catch (e) {
      setErro(e instanceof ApiError ? e.message : 'Falha ao despublicar.');
    } finally {
      setOcupado(false);
    }
  };

  if (carregando) return <Spinner label="Carregando publicação…" />;
  if (!detalhe) {
    return (
      <div className="space-y-4">
        <PageHeader title="Publicação" actions={<button className="btn-ghost" onClick={() => navigate('/commerce/publicacoes')}>Voltar</button>} />
        <Alert tone="red">{erro || 'Publicação não encontrada.'}</Alert>
      </div>
    );
  }

  const { publicacao, produto, preco, metadados } = detalhe;
  const rotulo = rotuloCanal(publicacao.canal);
  const reprocessavel = !['PUBLISHED', 'REJECTED', 'PUBLISHING'].includes(publicacao.estado);
  const podeDespublicar = publicacao.canal === 'BROBOND' && publicacao.estado === 'PUBLISHED';

  return (
    <div className="space-y-4">
      <PageHeader
        title={`${rotulo} · ${produto.nome}`}
        description={`Fila de publicação v${publicacao.versao} — PUBLISHED só com confirmação do canal. Estado por (empresa, produto, canal, versão).`}
        actions={
          <>
            <button type="button" className="btn-ghost" onClick={() => navigate('/commerce/publicacoes')}>
              <ArrowLeft className="h-4 w-4" aria-hidden="true" /> Fila
            </button>
            <button type="button" className="btn-secondary" onClick={() => navigate(`/commerce/publicacoes/${publicacao.id}/editar`)}>
              <Pencil className="h-4 w-4" aria-hidden="true" /> Editar
            </button>
            {reprocessavel && (
              <button type="button" className="btn-primary" disabled={ocupado} onClick={() => void reprocessar()}>
                <RefreshCw className="h-4 w-4" aria-hidden="true" /> Reprocessar
              </button>
            )}
          </>
        }
      />
      {erro && <Alert tone="red">{erro}</Alert>}

      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-xl border border-line bg-surface p-4">
          <div className="text-xs font-semibold uppercase tracking-wide text-muted">Estado</div>
          <div className="mt-2">
            <EstadoBadge estado={publicacao.estado} mapa={TONE_PUBLICACAO} rotulos={ROTULO_PUBLICACAO} />
          </div>
        </div>
        <div className="rounded-xl border border-line bg-surface p-4">
          <div className="text-xs font-semibold uppercase tracking-wide text-muted">Tentativas</div>
          <div className="mt-1 font-mono text-xl font-semibold tabular-nums">{publicacao.tentativas}</div>
          {publicacao.proxima_tentativa_em && publicacao.estado === 'ERROR' && (
            <div className="text-xs text-muted">próxima {dataHora(publicacao.proxima_tentativa_em)}</div>
          )}
        </div>
        <div className="rounded-xl border border-line bg-surface p-4">
          <div className="text-xs font-semibold uppercase tracking-wide text-muted">Preço do canal (server-side)</div>
          <div className="mt-1 font-mono text-xl font-semibold tabular-nums">{grana(preco.preco)}</div>
          <div className="text-xs text-muted">
            {preco.promo != null ? `promo ${grana(preco.promo)} · ` : ''}
            origem: {preco.origem === 'canal' ? 'linha do canal' : 'tabela'}
          </div>
        </div>
        <div className="rounded-xl border border-line bg-surface p-4">
          <div className="text-xs font-semibold uppercase tracking-wide text-muted">ID externo</div>
          <div className="mt-1 truncate font-mono text-sm">{publicacao.external_id ?? '—'}</div>
          <div className="text-xs text-muted">publicado {dataHora(publicacao.publicado_em)}</div>
        </div>
      </section>

      {publicacao.ultimo_erro && (
        <Alert tone="red">
          <span className="font-semibold">Último erro do canal:</span> {publicacao.ultimo_erro}
        </Alert>
      )}

      <section className="rounded-xl border border-line bg-surface p-4" aria-labelledby="ident-publicacao">
        <h2 id="ident-publicacao" className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted">
          Identidade
        </h2>
        <dl className="grid gap-3 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-ink-soft">Produto</dt>
            <dd>
              <Link className="font-medium hover:underline" to={`/commerce/produtos/${produto.id}`}>
                {produto.nome}
              </Link>
              <span className="ml-2 text-xs text-muted">
                {produto.sku} · base {grana(produto.preco_base)}
              </span>
            </dd>
          </div>
          <div>
            <dt className="text-ink-soft">Canal</dt>
            <dd>
              <Badge tone="blue">{rotulo}</Badge>
              {publicacao.canal === 'INSTAGRAM_SHOPPING' && (
                <span className="ml-2 text-xs text-muted">REJECTED é o estado final documentado (Graph API).</span>
              )}
            </dd>
          </div>
          <div>
            <dt className="text-ink-soft">Vigência do preço de canal</dt>
            <dd className="tabular-nums">
              {preco.linha
                ? `${preco.linha.vigencia_inicio ?? '—'} → ${preco.linha.vigencia_fim ?? 'sem fim'}`
                : 'sem linha de canal (vale a tabela)'}
            </dd>
          </div>
          <div>
            <dt className="text-ink-soft">Atualizado</dt>
            <dd>{dataHora(publicacao.atualizado_em)}</dd>
          </div>
        </dl>
      </section>

      <section className="rounded-xl border border-line bg-surface p-4" aria-labelledby="metadados-publicacao">
        <h2 id="metadados-publicacao" className="mb-2 text-sm font-semibold uppercase tracking-wide text-muted">
          Metadados por canal
        </h2>
        <p className="mb-2 text-xs text-muted">
          Ex.: <code>ml_category_id</code> exigido pelo Mercado Livre. Edite em{' '}
          <Link className="underline" to={`/commerce/publicacoes/${publicacao.id}/editar`}>
            Editar publicação
          </Link>
          .
        </p>
        <pre className="overflow-x-auto rounded-lg bg-slate-950/60 p-3 text-xs text-slate-200">
          {JSON.stringify(metadados, null, 2)}
        </pre>
      </section>

      <div className="flex flex-wrap gap-3">
        <Link className="btn-secondary" to={`/commerce/produtos/${produto.id}`}>
          <Store className="h-4 w-4" aria-hidden="true" /> Abrir produto
        </Link>
        <Link className="btn-secondary" to="/commerce/eventos">
          <Rocket className="h-4 w-4" aria-hidden="true" /> Eventos
        </Link>
        {podeDespublicar && (
          <button type="button" className="btn-secondary" onClick={() => setConfirmandoDespublicar(true)}>
            Despublicar da vitrine
          </button>
        )}
      </div>

      {confirmandoDespublicar && (
        <ConfirmacaoInline
          open
          title={`Despublicar "${produto.nome}" da vitrine?`}
          message="O item sai do ar da loja própria (estado UNPUBLISHED). Canais externos cancelam o anúncio no próprio canal."
          confirmLabel="Despublicar"
          danger
          busy={ocupado}
          onCancel={() => setConfirmandoDespublicar(false)}
          onConfirm={() => void despublicar()}
        />
      )}
    </div>
  );
}
