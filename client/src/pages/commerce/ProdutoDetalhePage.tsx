// ============================================================================
// COMMERCE — DETALHE DO PRODUTO NA VITRINE. Rota /commerce/produtos/:id.
//
// Quatro blocos, todos em páginas (ZERO MODAL):
//   1. conteúdo da vitrine (slug/resumo/ordem/metadados de canal);
//   2. preço por canal (linha própria, vigência opcional);
//   3. publicação por canal (fila com estados + retry manual);
//   4. disponibilidade por tamanho (somente leitura do estoque canônico).
// Escrita exige gerente (espelhado do servidor: minPerfilEscrita/gerente na
// publicação) — a API continua sendo a autoridade.
// ============================================================================
import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, ExternalLink, Globe, RefreshCw, Rocket, Save, Store } from 'lucide-react';
import { apiFetch, ApiError } from '../../lib/api';
import { Alert, Badge, PageHeader, Spinner, useToast } from '../../components/ui';
import { EstadoBadge, TONE_PUBLICACAO, ROTULO_PUBLICACAO, CANAIS_PUBLICACAO, grana, rotuloCanal } from './shared';
import { useAuth } from '../../auth/AuthContext';

type Detalhe = {
  produto: {
    id: number;
    sku: string;
    nome: string;
    descricao: string;
    ativo: boolean;
    preco_base: number;
    foto_url: string | null;
    fotos: unknown[];
  };
  projecao: { id: number; slug: string; resumo: string | null; ordem: number; canal_metadados: Record<string, unknown> } | null;
  precos: { canal: string; preco: number; preco_promo: number | null; vigencia_inicio: string | null; vigencia_fim: string | null }[];
  publicacoes: {
    id: number;
    canal: string;
    versao: number;
    estado: string;
    external_id: string | null;
    tentativas: number;
    ultimo_erro: string | null;
    proxima_tentativa_em: string | null;
    publicado_em: string | null;
    atualizado_em: string | null;
  }[];
  disponibilidade: { tamanho_id: number | null; codigo: string | null; fisico: number; disponivel: number; local: string | null }[];
};

type LinhaPreco = { preco: string; preco_promo: string; vigencia_inicio: string; vigencia_fim: string };

export default function CommerceProdutoDetalhePage() {
  const { id } = useParams();
  const toast = useToast();
  const navigate = useNavigate();
  const { user } = useAuth();
  const podeGerir = user?.perfil === 'gerente' || user?.perfil === 'admin';

  const [detalhe, setDetalhe] = useState<Detalhe | null>(null);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState('');

  const [resumo, setResumo] = useState('');
  const [slug, setSlug] = useState('');
  const [ordem, setOrdem] = useState('0');
  const [metadados, setMetadados] = useState('{}');
  const [salvandoConteudo, setSalvandoConteudo] = useState(false);

  const [precos, setPrecos] = useState<Record<string, LinhaPreco>>({});
  const [salvandoCanal, setSalvandoCanal] = useState<string | null>(null);

  const [publicando, setPublicando] = useState<string | null>(null);
  const [acaoErro, setAcaoErro] = useState('');

  const carregar = useCallback(async () => {
    setCarregando(true);
    setErro('');
    try {
      const r = await apiFetch<Detalhe>(`/commerce/produtos/${id}`);
      setDetalhe(r);
      setResumo(r.projecao?.resumo ?? '');
      setSlug(r.projecao?.slug ?? '');
      setOrdem(String(r.projecao?.ordem ?? 0));
      setMetadados(JSON.stringify(r.projecao?.canal_metadados ?? {}, null, 2));
      const mapa: Record<string, LinhaPreco> = {};
      for (const canal of CANAIS_PUBLICACAO) {
        const existente = r.precos.find((p) => p.canal === canal.valor);
        mapa[canal.valor] = {
          preco: existente ? String(existente.preco) : '',
          preco_promo: existente?.preco_promo != null ? String(existente.preco_promo) : '',
          vigencia_inicio: existente?.vigencia_inicio ?? '',
          vigencia_fim: existente?.vigencia_fim ?? '',
        };
      }
      setPrecos(mapa);
    } catch (e) {
      setErro(e instanceof ApiError ? e.message : 'Não foi possível carregar o produto.');
    } finally {
      setCarregando(false);
    }
  }, [id]);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  const salvarConteudo = async () => {
    if (!podeGerir) return;
    setSalvandoConteudo(true);
    setAcaoErro('');
    try {
      let metadadosObj: Record<string, unknown> = {};
      const texto = metadados.trim() || '{}';
      try {
        const parsed = JSON.parse(texto);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('objeto');
        metadadosObj = parsed as Record<string, unknown>;
      } catch {
        setAcaoErro('Metadados por canal precisam ser um JSON válido no formato {"ml_category_id": "MLB123"}.');
        return;
      }
      await apiFetch(`/commerce/produtos/${id}`, {
        method: 'PUT',
        body: JSON.stringify({ resumo, slug, ordem: Number(ordem) || 0, canal_metadados: metadadosObj }),
      });
      toast.success('Conteúdo da vitrine salvo. Canais publicados ganharam nova versão na fila.');
      await carregar();
    } catch (e) {
      setAcaoErro(e instanceof ApiError ? e.message : 'Falha ao salvar o conteúdo.');
    } finally {
      setSalvandoConteudo(false);
    }
  };

  const salvarPreco = async (canal: string) => {
    if (!podeGerir) return;
    const linha = precos[canal];
    if (!linha.preco.trim()) {
      setAcaoErro(`Informe o preço do canal ${rotuloCanal(canal)} ou mantenha a base sem linha de canal.`);
      return;
    }
    setSalvandoCanal(canal);
    setAcaoErro('');
    try {
      await apiFetch(`/commerce/produtos/${id}/precos`, {
        method: 'PUT',
        body: JSON.stringify({
          canal,
          preco: Number(linha.preco),
          preco_promo: linha.preco_promo.trim() ? Number(linha.preco_promo) : null,
          vigencia_inicio: linha.vigencia_inicio || null,
          vigencia_fim: linha.vigencia_fim || null,
        }),
      });
      toast.success(`Preço de ${rotuloCanal(canal)} salvo.`);
      await carregar();
    } catch (e) {
      setAcaoErro(e instanceof ApiError ? e.message : 'Falha ao salvar o preço.');
    } finally {
      setSalvandoCanal(null);
    }
  };

  const publicar = async (canal: string) => {
    setPublicando(canal);
    setAcaoErro('');
    try {
      await apiFetch('/commerce/publicacoes', {
        method: 'POST',
        body: JSON.stringify({ produto_id: Number(id), canais: [canal] }),
      });
      toast.success(`${rotuloCanal(canal)}: publicação enviada para a fila.`);
      await carregar();
    } catch (e) {
      setAcaoErro(e instanceof ApiError ? e.message : 'Falha ao enfileirar a publicação.');
    } finally {
      setPublicando(null);
    }
  };

  const reprocessar = async (publicacaoId: number) => {
    setPublicando(String(publicacaoId));
    setAcaoErro('');
    try {
      await apiFetch(`/commerce/publicacoes/${publicacaoId}/reprocessar`, { method: 'POST' });
      toast.success('Publicação reenfileirada.');
      await carregar();
    } catch (e) {
      setAcaoErro(e instanceof ApiError ? e.message : 'Falha ao reprocessar.');
    } finally {
      setPublicando(null);
    }
  };

  const despublicar = async (canal: string) => {
    setPublicando(canal);
    setAcaoErro('');
    try {
      await apiFetch(`/commerce/produtos/${id}/despublicar`, { method: 'POST', body: JSON.stringify({ canal }) });
      toast.success('Produto removido da vitrine própria.');
      await carregar();
    } catch (e) {
      setAcaoErro(e instanceof ApiError ? e.message : 'Falha ao despublicar.');
    } finally {
      setPublicando(null);
    }
  };

  if (carregando) return <Spinner label="Carregando produto…" />;
  if (!detalhe) {
    return (
      <div className="space-y-4">
        <Alert tone="red">{erro || 'Produto não encontrado.'}</Alert>
        <button type="button" className="btn-ghost" onClick={() => navigate('/commerce/produtos')}>
          <ArrowLeft className="h-4 w-4" aria-hidden="true" /> Voltar ao catálogo
        </button>
      </div>
    );
  }

  const publicacaoDe = (canal: string) => detalhe.publicacoes.find((p) => p.canal === canal) ?? null;
  const brobond = publicacaoDe('BROBOND');

  return (
    <div className="space-y-6">
      <PageHeader
        title={
          <span className="flex flex-wrap items-center gap-2">
            {detalhe.produto.nome}
            <Badge tone={detalhe.produto.ativo ? 'green' : 'slate'}>{detalhe.produto.ativo ? 'Ativo' : 'Inativo'}</Badge>
            {brobond?.estado === 'PUBLISHED' && (
              <a className="inline-flex items-center gap-1 text-sm font-normal text-primary hover:underline" href={`/loja/produto/${detalhe.projecao?.slug ?? ''}`} target="_blank" rel="noreferrer">
                Ver na loja <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
              </a>
            )}
          </span>
        }
        description={`SKU ${detalhe.produto.sku} · preço base ${grana(detalhe.produto.preco_base)} · disponibilidade lida do estoque canônico.`}
        actions={
          <button type="button" className="btn-ghost" onClick={() => navigate('/commerce/produtos')}>
            <ArrowLeft className="h-4 w-4" aria-hidden="true" /> Catálogo
          </button>
        }
      />

      {acaoErro && <Alert tone="red">{acaoErro}</Alert>}
      {erro && !detalhe && <Alert tone="red">{erro}</Alert>}

      {/* 1. Conteúdo da vitrine */}
      <section className="rounded-xl border border-line bg-surface p-4" aria-labelledby="conteudo-vitrine">
        <h2 id="conteudo-vitrine" className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-muted">
          <Store className="h-4 w-4" aria-hidden="true" /> Conteúdo da vitrine
        </h2>
        {detalhe.projecao ? (
          <div className="mt-3 grid gap-3 md:grid-cols-2">
            <label className="block text-sm">
              <span className="text-ink-soft">Slug público</span>
              <input className="input mt-1" value={slug} disabled={!podeGerir} onChange={(e) => setSlug(e.target.value)} />
              <span className="mt-1 block text-xs text-muted">URL: /loja/produto/{slug || '…'}</span>
            </label>
            <label className="block text-sm">
              <span className="text-ink-soft">Ordem na vitrine</span>
              <input className="input mt-1" type="number" min={0} value={ordem} disabled={!podeGerir} onChange={(e) => setOrdem(e.target.value)} />
            </label>
            <label className="block text-sm md:col-span-2">
              <span className="text-ink-soft">Resumo (até 300 caracteres)</span>
              <textarea className="input mt-1" rows={2} maxLength={300} value={resumo} disabled={!podeGerir} onChange={(e) => setResumo(e.target.value)} />
            </label>
            <label className="block text-sm md:col-span-2">
              <span className="text-ink-soft">Metadados por canal (JSON)</span>
              <textarea className="input mt-1 font-mono text-xs" rows={3} value={metadados} disabled={!podeGerir} onChange={(e) => setMetadados(e.target.value)} spellCheck={false} />
              <span className="mt-1 block text-xs text-muted">
                Ex.: ml_category_id exigido pelo Mercado Livre — sem ele a publicação responde o erro real da API.
              </span>
            </label>
            {podeGerir && (
              <div className="md:col-span-2">
                <button type="button" className="btn-primary" onClick={() => void salvarConteudo()} disabled={salvandoConteudo}>
                  <Save className="h-4 w-4" aria-hidden="true" /> {salvandoConteudo ? 'Salvando…' : 'Salvar conteúdo'}
                </button>
              </div>
            )}
          </div>
        ) : (
          <Alert tone="amber">
            Produto ainda não projetado na vitrine — use “Projetar produto” na lista do catálogo.
          </Alert>
        )}
      </section>

      {/* 2. Preço por canal */}
      <section className="rounded-xl border border-line bg-surface p-4" aria-labelledby="precos-canal">
        <h2 id="precos-canal" className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-muted">
          <Globe className="h-4 w-4" aria-hidden="true" /> Preço por canal
        </h2>
        <p className="mt-1 text-xs text-muted">
          Sem linha vigente, o canal usa o preço de tabela ({grana(detalhe.produto.preco_base)}). O preço promocional só
          vale quando for menor que o normal e durante a vigência.
        </p>
        <div className="mt-3 overflow-x-auto">
          <table className="table">
            <caption className="sr-only">Preços por canal de publicação</caption>
            <thead>
              <tr>
                <th scope="col">Canal</th>
                <th scope="col">Preço (R$)</th>
                <th scope="col">Promocional (R$)</th>
                <th scope="col">Início</th>
                <th scope="col">Fim</th>
                <th scope="col"><span className="sr-only">Ações</span></th>
              </tr>
            </thead>
            <tbody>
              {CANAIS_PUBLICACAO.map((canal) => {
                const linha = precos[canal.valor] ?? { preco: '', preco_promo: '', vigencia_inicio: '', vigencia_fim: '' };
                return (
                  <tr key={canal.valor}>
                    <td className="font-medium">{canal.rotulo}</td>
                    <td>
                      <input
                        className="input w-28"
                        inputMode="decimal"
                        value={linha.preco}
                        disabled={!podeGerir}
                        aria-label={`Preço ${canal.rotulo}`}
                        onChange={(e) => setPrecos((p) => ({ ...p, [canal.valor]: { ...linha, preco: e.target.value } }))}
                      />
                    </td>
                    <td>
                      <input
                        className="input w-28"
                        inputMode="decimal"
                        value={linha.preco_promo}
                        disabled={!podeGerir}
                        aria-label={`Preço promocional ${canal.rotulo}`}
                        onChange={(e) => setPrecos((p) => ({ ...p, [canal.valor]: { ...linha, preco_promo: e.target.value } }))}
                      />
                    </td>
                    <td>
                      <input
                        type="date"
                        className="input w-36"
                        value={linha.vigencia_inicio}
                        disabled={!podeGerir}
                        aria-label={`Início da vigência ${canal.rotulo}`}
                        onChange={(e) => setPrecos((p) => ({ ...p, [canal.valor]: { ...linha, vigencia_inicio: e.target.value } }))}
                      />
                    </td>
                    <td>
                      <input
                        type="date"
                        className="input w-36"
                        value={linha.vigencia_fim}
                        disabled={!podeGerir}
                        aria-label={`Fim da vigência ${canal.rotulo}`}
                        onChange={(e) => setPrecos((p) => ({ ...p, [canal.valor]: { ...linha, vigencia_fim: e.target.value } }))}
                      />
                    </td>
                    <td className="text-right">
                      {podeGerir && (
                        <button
                          type="button"
                          className="btn-secondary"
                          disabled={salvandoCanal === canal.valor}
                          onClick={() => void salvarPreco(canal.valor)}
                        >
                          {salvandoCanal === canal.valor ? 'Salvando…' : 'Salvar'}
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      {/* 3. Publicação por canal */}
      <section className="rounded-xl border border-line bg-surface p-4" aria-labelledby="publicacoes-canal">
        <h2 id="publicacoes-canal" className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-muted">
          <Rocket className="h-4 w-4" aria-hidden="true" /> Publicação por canal
        </h2>
        <p className="mt-1 text-xs text-muted">
          Fila com idempotência (empresa + produto + canal + versão). PUBLISHED só depois da confirmação da API externa
          — ou da própria vitrine no canal BROBOND.
        </p>
        <div className="mt-3 overflow-x-auto">
          <table className="table">
            <caption className="sr-only">Estados de publicação por canal</caption>
            <thead>
              <tr>
                <th scope="col">Canal</th>
                <th scope="col">Estado</th>
                <th scope="col">Versão</th>
                <th scope="col">ID externo</th>
                <th scope="col">Última mensagem</th>
                <th scope="col"><span className="sr-only">Ações</span></th>
              </tr>
            </thead>
            <tbody>
              {CANAIS_PUBLICACAO.map((canal) => {
                const pub = publicacaoDe(canal.valor);
                return (
                  <tr key={canal.valor}>
                    <td className="font-medium">{canal.rotulo}</td>
                    <td>
                      {pub ? (
                        <EstadoBadge estado={pub.estado} mapa={TONE_PUBLICACAO} rotulos={ROTULO_PUBLICACAO} />
                      ) : (
                        <Badge tone="slate">Nunca publicado</Badge>
                      )}
                    </td>
                    <td className="tabular-nums">{pub ? `v${pub.versao}` : '—'}</td>
                    <td className="font-mono text-xs">{pub?.external_id ?? '—'}</td>
                    <td className="max-w-xs truncate text-xs text-muted" title={pub?.ultimo_erro ?? undefined}>
                      {pub?.ultimo_erro ?? (pub?.estado === 'PUBLISHED' ? 'Confirmado pelo canal' : '—')}
                    </td>
                    <td className="text-right">
                      <div className="flex justify-end gap-2">
                        {podeGerir && (
                          <button
                            type="button"
                            className="btn-accent"
                            disabled={publicando === canal.valor || !detalhe.projecao}
                            onClick={() => void publicar(canal.valor)}
                          >
                            {pub ? 'Atualizar' : 'Publicar'}
                          </button>
                        )}
                        {podeGerir && pub && ['ERROR', 'READY'].includes(pub.estado) && (
                          <button
                            type="button"
                            className="btn-secondary"
                            disabled={publicando === String(pub.id)}
                            onClick={() => void reprocessar(pub.id)}
                          >
                            <RefreshCw className="h-4 w-4" aria-hidden="true" /> Reprocessar
                          </button>
                        )}
                        {podeGerir && pub?.estado === 'PUBLISHED' && canal.valor === 'BROBOND' && (
                          <button type="button" className="btn-ghost" disabled={publicando === canal.valor} onClick={() => void despublicar(canal.valor)}>
                            Despublicar
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      {/* 4. Disponibilidade canônica */}
      <section className="rounded-xl border border-line bg-surface p-4" aria-labelledby="disponibilidade">
        <h2 id="disponibilidade" className="text-sm font-semibold uppercase tracking-wide text-muted">
          Estoque disponível (canônico)
        </h2>
        <p className="mt-1 text-xs text-muted">
          Somente leitura: físico menos reservas/empenhos/bloqueios, escolhido pelo mesmo local que o faturamento usaria.
        </p>
        <div className="mt-3 overflow-x-auto">
          <table className="table">
            <caption className="sr-only">Disponibilidade por tamanho</caption>
            <thead>
              <tr>
                <th scope="col">Tamanho</th>
                <th scope="col" className="text-right">Físico</th>
                <th scope="col" className="text-right">Disponível</th>
                <th scope="col">Local de saída</th>
              </tr>
            </thead>
            <tbody>
              {detalhe.disponibilidade.map((d) => (
                <tr key={`${d.tamanho_id ?? 'un'}`}>
                  <td>{d.codigo ?? d.tamanho_id ?? 'Único'}</td>
                  <td className="text-right tabular-nums">{d.fisico}</td>
                  <td className={`text-right tabular-nums ${d.disponivel > 0 ? '' : 'text-danger'}`}>{d.disponivel}</td>
                  <td className="text-muted">{d.local ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
