// ============================================================================
// COMMERCE — PAINEL WOOCOMMERCE MULTI-STORE (RETAIL / WHOLESALE).
//
// Uma empresa, UM catálogo, DUAS lojas independentes. Este painel vive dentro
// da página Fila & sync (/commerce/fila) — não cria menu paralelo — e mostra,
// por loja, dado REAL lido do servidor:
//
//   • estado da conexão (teste autenticado sob demanda);
//   • produtos vinculados / pendentes e publicações com erro;
//   • última sincronização de estoque e pedidos importados;
//   • falhas e tentativas;
//   • ação manual (sincronizar estoque, importar pedidos, publicar, reconciliar).
//
// Nenhuma credencial chega ao navegador: o servidor devolve diagnóstico, nunca
// CK/CS. Nada aqui é inventado — quando a loja não está configurada o painel
// diz exatamente o que falta.
// ============================================================================
import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, Link2, RefreshCw, ShoppingCart, Store, Webhook } from 'lucide-react';
import { apiFetch, ApiError } from '../../lib/api';
import { Alert, Badge, Spinner, useToast } from '../../components/ui';
import { dataHora } from './shared';

type StatusStore = {
  store_key: 'RETAIL' | 'WHOLESALE';
  habilitada: boolean;
  configurada: boolean;
  url: string | null;
  motivo: string | null;
};

type PainelLoja = {
  store_key: 'RETAIL' | 'WHOLESALE';
  status: StatusStore;
  conexao: { ok: boolean; erro?: string } | null;
  vinculos: { total: number; por_status: Record<string, number> };
  pendentes: { produto_id: number; sku: string; nome: string; motivo: string }[];
  estoque: { sincronizado_em: string | null };
  pedidos_importados: number;
  estado: {
    ultimo_pedido_em: string | null;
    ultima_sincronizacao_estoque_em: string | null;
    ultima_publicacao_em: string | null;
    ultima_reconciliacao_em: string | null;
    ultimo_erro: string | null;
    tentativas: number;
  };
};

type RespostaLojas = { multi_store_habilitado: boolean; dry_run: boolean; lojas: PainelLoja[] };

/** Entrega de webhook (visão do painel; nunca carrega payload nem segredo). */
type EntregaWebhook = {
  id: number;
  topic: string;
  recurso: string;
  external_resource_id: string | null;
  status: string;
  attempts: number;
  assinatura_ok: boolean;
  received_at: string | null;
  processed_at: string | null;
  last_error: string | null;
};

type PainelWebhooks = {
  webhook_habilitado: boolean;
  total: number;
  por_status: Record<string, number>;
  entregas: EntregaWebhook[];
};

type DivergenciaReconciliacao = {
  id: number;
  categoria: 'CATALOGO' | 'PRECO' | 'ESTOQUE' | 'PEDIDOS';
  tipo: string;
  classificacao: 'LEGITIMA' | 'AUTOMATICA' | 'HUMANA';
  produto_id: number | null;
  sku: string | null;
  pedido_ref: string | null;
  detalhe: string;
  status: string;
  detectada_em: string | null;
};

type PainelDivergencias = { total: number; por_categoria: Record<string, number>; divergencias: DivergenciaReconciliacao[] };

const ROTULO_LOJA: Record<string, string> = {
  RETAIL: 'Varejo (brobond.com.br)',
  WHOLESALE: 'Atacado (atacado.brobond.com.br)',
};

const ROTULO_CATEGORIA: Record<string, string> = {
  CATALOGO: 'Catálogo',
  PRECO: 'Preço',
  ESTOQUE: 'Estoque',
  PEDIDOS: 'Pedidos',
};

const TOM_CLASSIFICACAO: Record<string, 'green' | 'amber' | 'red' | 'slate'> = {
  LEGITIMA: 'slate',
  AUTOMATICA: 'amber',
  HUMANA: 'red',
};

const TOM_STATUS_ENTREGA: Record<string, 'green' | 'amber' | 'red' | 'slate'> = {
  processado: 'green',
  enfileirado: 'amber',
  recebido: 'amber',
  erro: 'red',
  rejeitado: 'red',
  duplicado: 'slate',
};

export default function WooLojasPanel() {
  const toast = useToast();
  const [dados, setDados] = useState<RespostaLojas | null>(null);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState('');
  const [ocupado, setOcupado] = useState('');
  const [webhooks, setWebhooks] = useState<Record<string, PainelWebhooks>>({});
  const [reconciliacoes, setReconciliacoes] = useState<Record<string, PainelDivergencias>>({});

  const carregar = useCallback(async (testar = false) => {
    setCarregando(true);
    setErro('');
    try {
      const resposta = await apiFetch<RespostaLojas>(`/commerce/woocommerce/lojas${testar ? '?testar=1' : ''}`);
      if (!Array.isArray(resposta?.lojas)) throw new Error('Resposta do painel de lojas inválida.');
      setDados(resposta);
      // Webhooks e divergências por loja: cada bloco erra por conta própria, sem
      // derrubar o painel (uma loja indisponível não esconde a outra).
      const lojas = resposta.lojas.map((l) => l.store_key);
      const [wh, dv] = await Promise.all([
        Promise.all(
          lojas.map(async (store) => {
            try {
              const r = await apiFetch<PainelWebhooks>(`/commerce/woocommerce/lojas/${store}/webhooks`);
              return [store, r && Array.isArray(r.entregas) ? r : null] as const;
            } catch {
              return [store, null] as const;
            }
          })
        ),
        Promise.all(
          lojas.map(async (store) => {
            try {
              const r = await apiFetch<PainelDivergencias>(`/commerce/woocommerce/lojas/${store}/divergencias`);
              return [store, r && Array.isArray(r.divergencias) ? r : null] as const;
            } catch {
              return [store, null] as const;
            }
          })
        ),
      ]);
      setWebhooks(Object.fromEntries(wh.filter(([, v]) => v !== null)) as Record<string, PainelWebhooks>);
      setReconciliacoes(Object.fromEntries(dv.filter(([, v]) => v !== null)) as Record<string, PainelDivergencias>);
    } catch (e) {
      setDados(null);
      setErro(e instanceof ApiError ? e.message : 'Não foi possível carregar o painel das lojas.');
    } finally {
      setCarregando(false);
    }
  }, []);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  async function acao(chave: string, fn: () => Promise<string>) {
    setOcupado(chave);
    try {
      toast.success(await fn());
      await carregar();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'A ação não foi concluída.');
    } finally {
      setOcupado('');
    }
  }

  async function sincronizarEstoque(store: string) {
    await acao(`estoque:${store}`, async () => {
      const r = await apiFetch<{ atualizados: number; sem_vinculo: number; dry_run: boolean }>(
        `/commerce/woocommerce/lojas/${store}/estoque`,
        { method: 'POST' }
      );
      const sufixo = r.dry_run ? ' (modo de homologação: nada foi escrito)' : '';
      return `${r.atualizados} item(ns) sincronizado(s) na ${store}${sufixo}. ${r.sem_vinculo} sem vínculo.`;
    });
  }

  async function importarPedidos(store: string) {
    await acao(`pedidos:${store}`, async () => {
      const r = await apiFetch<{ importados: unknown[]; ignorados: unknown[]; pendentes: unknown[] }>(
        `/commerce/woocommerce/lojas/${store}/pedidos`,
        { method: 'POST' }
      );
      return `${r.importados.length} pedido(s) importado(s), ${r.ignorados.length} já importado(s), ${r.pendentes.length} pendente(s).`;
    });
  }

  async function reconciliar(store: string) {
    await acao(`reconciliar:${store}`, async () => {
      const r = await apiFetch<{ detectadas: number; abertas: number; resolvidas: number }>(
        `/commerce/woocommerce/lojas/${store}/reconciliar`,
        { method: 'POST' }
      );
      return r.detectadas
        ? `${r.detectadas} divergência(s) na ${store} (${r.resolvidas} resolvida(s)).`
        : `Nenhuma divergência na ${store}.`;
    });
  }

  async function reprocessarWebhooks(store: string) {
    await acao(`reprocessar:${store}`, async () => {
      const r = await apiFetch<{ reenfileirados: number; erros: number }>(
        `/commerce/woocommerce/lojas/${store}/webhooks/reprocessar`,
        { method: 'POST' }
      );
      return `${r.reenfileirados} entrega(s) re-enfileirada(s) na ${store}. ${r.erros} falha(s).`;
    });
  }

  async function reprocessarEntrega(store: string, entregaId: number) {
    await acao(`entrega:${store}:${entregaId}`, async () => {
      await apiFetch(`/commerce/woocommerce/lojas/${store}/webhooks/${entregaId}/reprocessar`, { method: 'POST' });
      return `Entrega #${entregaId} re-enfileirada na ${store}.`;
    });
  }

  async function corrigirDivergencia(store: string, id: number) {
    await acao(`corrigir:${store}:${id}`, async () => {
      const r = await apiFetch<{ acao: string }>(`/commerce/woocommerce/lojas/${store}/divergencias/${id}/corrigir`, { method: 'POST' });
      return r.acao ? `Correção enfileirada (${r.acao}) na ${store}.` : `Divergência corrigida na ${store}.`;
    });
  }

  return (
    <section className="rounded-xl border border-line bg-surface p-4" aria-labelledby="woo-lojas">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="woo-lojas" className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-muted">
          <Store className="h-4 w-4" aria-hidden="true" /> Lojas WooCommerce (multi-loja)
        </h2>
        <div className="flex items-center gap-2">
          {dados?.dry_run && <Badge tone="amber">Homologação (sem escrita)</Badge>}
          <button type="button" className="btn-ghost" disabled={ocupado !== ''} onClick={() => void carregar(true)}>
            <RefreshCw className="h-4 w-4" aria-hidden="true" /> Testar conexões
          </button>
        </div>
      </div>

      {carregando ? (
        <div className="mt-3">
          <Spinner label="Carregando lojas…" />
        </div>
      ) : erro ? (
        <div className="mt-3">
          <Alert tone="red">{erro}</Alert>
        </div>
      ) : !dados ? (
        <p className="mt-3 text-sm text-muted">Painel de lojas indisponível.</p>
      ) : (
        <>
          {!dados.multi_store_habilitado && (
            <p className="mt-3 flex items-start gap-2 text-sm text-muted">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              O modo multi-loja está desligado (<span className="font-mono">WOOCOMMERCE_MULTI_STORE_ENABLED</span>). A integração
              single-store continua ativa até ele ser ligado.
            </p>
          )}
          <div className="mt-3 grid gap-4 lg:grid-cols-2">
            {dados.lojas.map((loja) => (
              <article key={loja.store_key} className="rounded-xl border border-line p-4" aria-label={ROTULO_LOJA[loja.store_key]}>
                <header className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <div className="font-medium">{ROTULO_LOJA[loja.store_key] ?? loja.store_key}</div>
                    <div className="truncate font-mono text-xs text-muted" title={loja.status.url ?? ''}>
                      {loja.status.url ?? 'URL não configurada'}
                    </div>
                  </div>
                  <Badge tone={loja.status.configurada ? 'green' : 'slate'}>
                    {loja.status.configurada ? 'Configurada' : loja.status.habilitada ? 'Incompleta' : 'Desabilitada'}
                  </Badge>
                </header>

                {loja.status.motivo && <p className="mt-2 text-xs text-muted">{loja.status.motivo}</p>}

                {loja.conexao && (
                  <p className={`mt-2 text-xs ${loja.conexao.ok ? 'text-success' : 'text-danger'}`}>
                    {loja.conexao.ok ? 'Conexão e autenticação confirmadas.' : `Falha de conexão: ${loja.conexao.erro ?? 'sem detalhe'}`}
                  </p>
                )}

                <dl className="mt-3 grid grid-cols-2 gap-2 text-sm">
                  <div>
                    <dt className="text-xs uppercase tracking-wide text-muted">Vinculados</dt>
                    <dd className="tabular-nums">{loja.vinculos.total}</dd>
                  </div>
                  <div>
                    <dt className="text-xs uppercase tracking-wide text-muted">Pendentes</dt>
                    <dd className={`tabular-nums ${loja.pendentes.length ? 'text-warning' : ''}`}>{loja.pendentes.length}</dd>
                  </div>
                  <div>
                    <dt className="text-xs uppercase tracking-wide text-muted">Pedidos importados</dt>
                    <dd className="tabular-nums">{loja.pedidos_importados}</dd>
                  </div>
                  <div>
                    <dt className="text-xs uppercase tracking-wide text-muted">Tentativas</dt>
                    <dd className="tabular-nums">{loja.estado.tentativas}</dd>
                  </div>
                  <div className="col-span-2">
                    <dt className="text-xs uppercase tracking-wide text-muted">Última sincronização de estoque</dt>
                    <dd className="text-sm text-muted">
                      {loja.estoque.sincronizado_em ? dataHora(loja.estoque.sincronizado_em) : 'Nunca sincronizado'}
                    </dd>
                  </div>
                  <div className="col-span-2">
                    <dt className="text-xs uppercase tracking-wide text-muted">Último pedido importado</dt>
                    <dd className="text-sm text-muted">
                      {loja.estado.ultimo_pedido_em ? dataHora(loja.estado.ultimo_pedido_em) : 'Nenhum pedido importado'}
                    </dd>
                  </div>
                </dl>

                {loja.estado.ultimo_erro && (
                  <p className="mt-2 line-clamp-3 text-xs text-danger" title={loja.estado.ultimo_erro}>
                    Último erro: {loja.estado.ultimo_erro}
                  </p>
                )}

                {Object.keys(loja.vinculos.por_status).length > 0 && (
                  <p className="mt-2 text-xs text-muted">
                    Vínculos:{' '}
                    {Object.entries(loja.vinculos.por_status)
                      .map(([status, n]) => `${status} ${n}`)
                      .join(' · ')}
                  </p>
                )}

                <div className="mt-3 flex flex-wrap gap-2">
                  <button
                    type="button"
                    className="btn-secondary"
                    disabled={!loja.status.configurada || ocupado !== ''}
                    onClick={() => void sincronizarEstoque(loja.store_key)}
                    aria-label={`Sincronizar estoque da loja ${loja.store_key}`}
                  >
                    {ocupado === `estoque:${loja.store_key}` ? 'Sincronizando…' : 'Sincronizar estoque'}
                  </button>
                  <button
                    type="button"
                    className="btn-secondary"
                    disabled={!loja.status.configurada || ocupado !== ''}
                    onClick={() => void importarPedidos(loja.store_key)}
                    aria-label={`Importar pedidos da loja ${loja.store_key}`}
                  >
                    <ShoppingCart className="h-4 w-4" aria-hidden="true" />
                    {ocupado === `pedidos:${loja.store_key}` ? 'Importando…' : 'Importar pedidos'}
                  </button>
                  <button
                    type="button"
                    className="btn-ghost"
                    disabled={ocupado !== ''}
                    onClick={() => void reconciliar(loja.store_key)}
                    aria-label={`Reconciliar a loja ${loja.store_key}`}
                  >
                    <Link2 className="h-4 w-4" aria-hidden="true" />
                    {ocupado === `reconciliar:${loja.store_key}` ? 'Reconciliando…' : 'Reconciliar'}
                  </button>
                </div>

                {/* Webhooks: estado, último evento, pendentes, falhas e tentativas. */}
                {webhooks[loja.store_key] && (
                  <div className="mt-4 rounded-lg border border-line p-3" aria-label={`Webhooks da loja ${loja.store_key}`}>
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted">
                        <Webhook className="h-3.5 w-3.5" aria-hidden="true" /> Webhooks
                      </span>
                      <div className="flex items-center gap-2">
                        <Badge tone={webhooks[loja.store_key]!.webhook_habilitado ? 'green' : 'slate'}>
                          {webhooks[loja.store_key]!.webhook_habilitado ? 'Habilitado' : 'Desabilitado'}
                        </Badge>
                        <button
                          type="button"
                          className="btn-ghost"
                          disabled={ocupado !== ''}
                          onClick={() => void reprocessarWebhooks(loja.store_key)}
                          aria-label={`Reprocessar entregas da loja ${loja.store_key}`}
                        >
                          {ocupado === `reprocessar:${loja.store_key}` ? 'Reprocessando…' : 'Reprocessar pendentes'}
                        </button>
                      </div>
                    </div>
                    {!webhooks[loja.store_key]!.webhook_habilitado && (
                      <p className="mt-1 text-xs text-muted">
                        Configure <span className="font-mono">WOOCOMMERCE_{loja.store_key}_WEBHOOK_SECRET</span> para aceitar entregas.
                      </p>
                    )}
                    <dl className="mt-2 grid grid-cols-3 gap-2 text-sm">
                      <div>
                        <dt className="text-xs uppercase tracking-wide text-muted">Recebidos</dt>
                        <dd className="tabular-nums">{webhooks[loja.store_key]!.total}</dd>
                      </div>
                      <div>
                        <dt className="text-xs uppercase tracking-wide text-muted">Pendentes</dt>
                        <dd className="tabular-nums">
                          {(webhooks[loja.store_key]!.por_status.recebido ?? 0) + (webhooks[loja.store_key]!.por_status.enfileirado ?? 0)}
                        </dd>
                      </div>
                      <div>
                        <dt className="text-xs uppercase tracking-wide text-muted">Com falha</dt>
                        <dd className={`tabular-nums ${(webhooks[loja.store_key]!.por_status.erro ?? 0) ? 'text-danger' : ''}`}>
                          {(webhooks[loja.store_key]!.por_status.erro ?? 0) + (webhooks[loja.store_key]!.por_status.rejeitado ?? 0)}
                        </dd>
                      </div>
                    </dl>
                    {webhooks[loja.store_key]!.entregas.length === 0 ? (
                      <p className="mt-2 text-xs text-muted">Nenhuma entrega recebida ainda.</p>
                    ) : (
                      <ul className="mt-2 space-y-1 text-xs">
                        {webhooks[loja.store_key]!.entregas.slice(0, 8).map((e) => (
                          <li key={e.id} className="flex flex-wrap items-center gap-1 text-muted">
                            <Badge tone={TOM_STATUS_ENTREGA[e.status] ?? 'slate'}>{e.status}</Badge>
                            <span className="font-mono">{e.topic}</span>
                            {e.external_resource_id && <span className="font-mono">#{e.external_resource_id}</span>}
                            <span>· {e.attempts} tentativa(s)</span>
                            {e.received_at && <span>· {dataHora(e.received_at)}</span>}
                            {(e.status === 'erro' || e.status === 'recebido') && (
                              <button
                                type="button"
                                className="btn-ghost !px-1 !py-0 text-xs"
                                disabled={ocupado !== ''}
                                onClick={() => void reprocessarEntrega(loja.store_key, e.id)}
                                aria-label={`Reprocessar entrega ${e.id} da loja ${loja.store_key}`}
                              >
                                reprocessar
                              </button>
                            )}
                          </li>
                        ))}
                        {webhooks[loja.store_key]!.entregas.length > 8 && (
                          <li className="text-muted">… e mais {webhooks[loja.store_key]!.entregas.length - 8}.</li>
                        )}
                      </ul>
                    )}
                  </div>
                )}

                {/* Divergências de reconciliação por categoria e classificação. */}
                {reconciliacoes[loja.store_key] && (
                  <div className="mt-3 rounded-lg border border-line p-3" aria-label={`Divergências da loja ${loja.store_key}`}>
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="text-xs font-semibold uppercase tracking-wide text-muted">Divergências</span>
                      <span className="text-xs text-muted">
                        Última reconciliação:{' '}
                        {loja.estado.ultima_reconciliacao_em ? dataHora(loja.estado.ultima_reconciliacao_em) : 'nunca'}
                      </span>
                    </div>
                    <p className="mt-1 flex flex-wrap gap-x-2 text-xs text-muted">
                      {(['CATALOGO', 'PRECO', 'ESTOQUE', 'PEDIDOS'] as const).map((c) => (
                        <span key={c}>
                          {ROTULO_CATEGORIA[c]}: <span className="tabular-nums">{reconciliacoes[loja.store_key]!.por_categoria[c] ?? 0}</span>
                        </span>
                      ))}
                    </p>
                    {reconciliacoes[loja.store_key]!.divergencias.length === 0 ? (
                      <p className="mt-2 text-xs text-muted">Nenhuma divergência aberta. ERP e loja estão consistentes.</p>
                    ) : (
                      <ul className="mt-2 space-y-1 text-xs">
                        {reconciliacoes[loja.store_key]!.divergencias.slice(0, 20).map((d) => (
                          <li key={d.id} className="flex flex-wrap items-center gap-1 text-muted">
                            <Badge tone={TOM_CLASSIFICACAO[d.classificacao] ?? 'slate'}>{ROTULO_CATEGORIA[d.categoria] ?? d.categoria}</Badge>
                            <span className="font-mono">{d.sku || d.pedido_ref || (d.produto_id ? `#${d.produto_id}` : '—')}</span>
                            <span>— {d.detalhe}</span>
                            {d.classificacao === 'AUTOMATICA' && d.status === 'ABERTA' && (
                              <button
                                type="button"
                                className="btn-ghost !px-1 !py-0 text-xs"
                                disabled={ocupado !== ''}
                                onClick={() => void corrigirDivergencia(loja.store_key, d.id)}
                                aria-label={`Corrigir divergência ${d.id} da loja ${loja.store_key}`}
                              >
                                corrigir
                              </button>
                            )}
                            {d.classificacao === 'HUMANA' && <span className="text-danger">requer análise humana</span>}
                          </li>
                        ))}
                        {reconciliacoes[loja.store_key]!.divergencias.length > 20 && (
                          <li className="text-muted">… e mais {reconciliacoes[loja.store_key]!.divergencias.length - 20}.</li>
                        )}
                      </ul>
                    )}
                  </div>
                )}

                {loja.pendentes.length > 0 && (
                  <details className="mt-3 text-xs text-muted">
                    <summary className="cursor-pointer">Produtos pendentes nesta loja ({loja.pendentes.length})</summary>
                    <ul className="mt-2 space-y-1">
                      {loja.pendentes.slice(0, 20).map((p) => (
                        <li key={`${loja.store_key}:${p.produto_id}`}>
                          <span className="font-mono">{p.sku || `#${p.produto_id}`}</span> {p.nome} — {p.motivo}
                        </li>
                      ))}
                      {loja.pendentes.length > 20 && <li>… e mais {loja.pendentes.length - 20}.</li>}
                    </ul>
                  </details>
                )}
              </article>
            ))}
          </div>
          <p className="mt-3 text-xs text-muted">
            Cada loja sincroniza por conta própria: uma indisponibilidade da RETAIL não interrompe a WHOLESALE. O estoque do ERP é a
            fonte canônica — o painel mostra o disponível vendável, já descontadas as reservas.
          </p>
        </>
      )}
    </section>
  );
}
