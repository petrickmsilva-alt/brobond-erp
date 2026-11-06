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
import { AlertTriangle, Link2, RefreshCw, ShoppingCart, Store } from 'lucide-react';
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
    ultimo_erro: string | null;
    tentativas: number;
  };
};

type RespostaLojas = { multi_store_habilitado: boolean; dry_run: boolean; lojas: PainelLoja[] };

type Divergencia = { produto_id: number; sku: string; tipo: string; detalhe: string };

const ROTULO_LOJA: Record<string, string> = {
  RETAIL: 'Varejo (brobond.com.br)',
  WHOLESALE: 'Atacado (atacado.brobond.com.br)',
};

const ROTULO_DIVERGENCIA: Record<string, string> = {
  SEM_VINCULO: 'Sem vínculo',
  SALDO_DIVERGENTE: 'Saldo divergente',
  VINCULO_ORFAO: 'Vínculo órfão',
};

export default function WooLojasPanel() {
  const toast = useToast();
  const [dados, setDados] = useState<RespostaLojas | null>(null);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState('');
  const [ocupado, setOcupado] = useState('');
  const [divergencias, setDivergencias] = useState<Record<string, Divergencia[]>>({});

  const carregar = useCallback(async (testar = false) => {
    setCarregando(true);
    setErro('');
    try {
      const resposta = await apiFetch<RespostaLojas>(`/commerce/woocommerce/lojas${testar ? '?testar=1' : ''}`);
      if (!Array.isArray(resposta?.lojas)) throw new Error('Resposta do painel de lojas inválida.');
      setDados(resposta);
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
      const r = await apiFetch<{ total: number; divergencias: Divergencia[] }>(`/commerce/woocommerce/lojas/${store}/reconciliacao`);
      setDivergencias((atual) => ({ ...atual, [store]: r.divergencias }));
      return r.total ? `${r.total} divergência(s) encontrada(s) na ${store}.` : `Nenhuma divergência na ${store}.`;
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

                {(divergencias[loja.store_key]?.length ?? 0) > 0 && (
                  <ul className="mt-3 space-y-1 text-xs">
                    {divergencias[loja.store_key]!.slice(0, 20).map((d) => (
                      <li key={`${d.tipo}:${d.produto_id}:${d.sku}`} className="text-muted">
                        <Badge tone={d.tipo === 'VINCULO_ORFAO' ? 'red' : 'amber'}>{ROTULO_DIVERGENCIA[d.tipo] ?? d.tipo}</Badge>{' '}
                        <span className="font-mono">{d.sku || `#${d.produto_id}`}</span> — {d.detalhe}
                      </li>
                    ))}
                    {divergencias[loja.store_key]!.length > 20 && (
                      <li className="text-muted">… e mais {divergencias[loja.store_key]!.length - 20}.</li>
                    )}
                  </ul>
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
