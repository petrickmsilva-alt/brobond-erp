// ============================================================================
// VITRINE — CARRINHO. Rota /loja/carrinho.
//
// • As LINHAS vêm do carrinho persistido (mesmo cart store do restante da loja)
//   — o badge do cabeçalho e esta página leem a MESMA fonte, então nunca existe
//   "Carrinho 1" com zero linhas.
// • PREÇO, ESTOQUE, DESCONTO, FRETE e TOTAL vêm exclusivamente do servidor
//   (/api/loja/preview). Enquanto o servidor recalcula, falha ou o item saiu da
//   loja, a linha continua visível e removível; valores monetários não
//   confirmados aparecem como "—", nunca inventados.
// • Estados explícitos: LOADING | READY | EMPTY | ERROR | INVALID.
// ============================================================================
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { AlertTriangle, Minus, Plus, RefreshCw, ShoppingBag, Trash2 } from 'lucide-react';
import { LojaShell, precoLoja, useConfigDoShell } from './LojaShell';
import { QUANTIDADE_MAXIMA, definirCupom, limparCarrinho, removerDoCarrinho, useCarrinho, type ItemCarrinho } from './carinho';
import { useCotacaoCarrinho, type Cotacao, type ItemCotacao } from './cotacao';
import { useQuantidadeCarrinho } from './quantidade';

export type Preview = Cotacao;

const ROTULO_FRETE: Record<string, string> = { retirada: 'Retirada na loja', manual: 'Entrega', nenhum: 'Frete' };

function linhaDoServidor(item: ItemCarrinho, cotacao: Cotacao | null): ItemCotacao | null {
  return cotacao?.itens.find((l) => l.produto_id === item.produto_id && (l.tamanho_id ?? null) === (item.tamanho_id ?? null)) ?? null;
}

export default function LojaCarrinhoPage() {
  const carrinho = useCarrinho();
  const navigate = useNavigate();
  const { estado, cotacao, sincronizada, atualizando, erro, detalheErro, motivos, recarregar } = useCotacaoCarrinho(carrinho);
  // + / −: a intenção só vira quantidade depois da resposta do servidor.
  const quantidade = useQuantidadeCarrinho(carrinho);
  const configShell = useConfigDoShell();
  const config = configShell?.config ?? null;
  const [cupomInput, setCupomInput] = useState(carrinho.cupom || '');
  const [confirmandoLimpar, setConfirmandoLimpar] = useState(false);

  const aplicarCupom = () => {
    const codigo = cupomInput.trim().toUpperCase();
    if (!codigo) return;
    if ((carrinho.cupom || '') === codigo) recarregar();
    else definirCupom(codigo);
  };
  const removerCupom = () => {
    setCupomInput('');
    definirCupom('');
  };

  const checkoutIndisponivelNaLoja = config?.checkout_disponivel === false;
  const podeAvancar = estado === 'READY' && sincronizada && !checkoutIndisponivelNaLoja;
  const mostrar = (valor: number | undefined) => (sincronizada && cotacao && valor !== undefined ? precoLoja(valor) : '—');

  if (estado === 'EMPTY') {
    return (
      <LojaShell titulo="Carrinho">
        <div className="flex flex-col items-center gap-3 rounded-2xl border border-dashed border-line bg-surface p-10 text-center" data-estado-carrinho="EMPTY">
          <ShoppingBag className="h-8 w-8 text-ink-soft" aria-hidden="true" />
          <h2 className="text-lg font-medium">Seu carrinho está vazio.</h2>
          <p className="text-sm text-ink-soft">Explore a loja e adicione suas peças favoritas.</p>
          <Link to="/loja" className="btn-primary">
            Continuar comprando
          </Link>
        </div>
      </LojaShell>
    );
  }

  return (
    <LojaShell titulo="Carrinho">
      <div className="grid gap-6 lg:grid-cols-3" data-estado-carrinho={estado} aria-busy={estado === 'LOADING' || atualizando}>
        <section className="space-y-4 lg:col-span-2" aria-label="Seus produtos">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-soft">Seus produtos</h2>

          {estado === 'ERROR' && (
            <div className="flex flex-wrap items-start gap-3 rounded-xl border border-red-300 bg-red-50 p-4 text-sm text-red-800" role="alert">
              <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" aria-hidden="true" />
              <div className="min-w-0 flex-1">
                <p className="font-medium">{erro}</p>
                {detalheErro && <p className="mt-0.5 text-xs">{detalheErro}</p>}
              </div>
              <button type="button" className="btn-secondary" onClick={recarregar}>
                <RefreshCw className="h-4 w-4" aria-hidden="true" /> Tentar novamente
              </button>
            </div>
          )}

          {estado === 'INVALID' && motivos.length > 0 && (
            <div className="rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900" role="alert">
              <p className="font-medium">Revise seu carrinho para continuar:</p>
              <ul className="mt-1 list-disc pl-5">
                {motivos.map((m) => (
                  <li key={m}>{m}</li>
                ))}
              </ul>
            </div>
          )}

          <ul className="space-y-3" data-testid="linhas-carrinho">
            {carrinho.itens.map((item) => {
              const l = linhaDoServidor(item, cotacao);
              const nome = l?.nome && !l.indisponivel ? l.nome : item.nome ?? (l ? l.nome : 'Carregando produto…');
              const sku = l && !l.indisponivel ? l.sku : item.sku;
              const foto = l?.foto_url ?? item.foto_url ?? null;
              // Estoque vem SOMENTE da cotação confirmada pelo servidor. Sem
              // cotação sincronizada não travamos o "+" por palpite: a decisão
              // final é sempre do endpoint de quantidade (estoque real).
              const maximo = l && !l.indisponivel && sincronizada ? Math.min(QUANTIDADE_MAXIMA, Math.max(0, l.disponivel)) : QUANTIDADE_MAXIMA;
              const noLimite = l && !l.indisponivel && sincronizada && maximo < QUANTIDADE_MAXIMA && item.quantidade >= maximo;
              const subtotalServidor = l && sincronizada ? l.subtotal : undefined;
              const estadoLinha = quantidade.estado(item);
              // Durante uma mutação, os limites usam a ÚLTIMA INTENÇÃO (e não o
              // número confirmado): assim cliques rápidos "+ + −" são tratados
              // pelo controlador em vez de serem engolidos por um botão disabled.
              const quantidadeControle = estadoLinha.desejada ?? item.quantidade;
              return (
                <li
                  key={`${item.produto_id}-${item.tamanho_id ?? 'un'}`}
                  className="grid gap-4 rounded-2xl border border-line bg-surface p-4 sm:grid-cols-[96px_1fr]"
                  data-linha-carrinho={`${item.produto_id}:${item.tamanho_id ?? ''}`}
                  aria-busy={estadoLinha.pendente}
                >
                  <div className="flex h-24 w-24 items-center justify-center overflow-hidden rounded-xl border border-line bg-canvas">
                    {foto ? (
                      <img src={foto} alt={nome} className="h-full w-full object-cover" loading="lazy" />
                    ) : (
                      <ShoppingBag className="h-8 w-8 text-ink-soft" aria-hidden="true" />
                    )}
                  </div>

                  <div className="min-w-0 space-y-3">
                    <div>
                      <div className="font-medium break-words">{nome}</div>
                      {(sku || l?.variante) && (
                        <div className="text-xs text-ink-soft break-all">
                          {sku ? `SKU: ${sku}` : ''}
                          {sku && l?.variante ? ' · ' : ''}
                          {l?.variante ? `Tamanho: ${l.variante}` : ''}
                        </div>
                      )}
                      {l && !l.ok && (
                        <div className="mt-1 text-xs font-medium text-danger" role="alert">
                          {l.aviso ?? 'Indisponível'}
                        </div>
                      )}
                    </div>

                    <dl className="grid grid-cols-3 gap-3 text-sm">
                      <div>
                        <dt className="text-xs text-ink-soft">Preço unitário</dt>
                        <dd className="tabular-nums">
                          {l && !l.indisponivel ? precoLoja(l.preco_unitario) : '—'}
                          {l?.preco_original != null && l.preco_original > l.preco_unitario && (
                            <span className="ml-1 text-xs text-ink-soft line-through">{precoLoja(l.preco_original)}</span>
                          )}
                        </dd>
                      </div>
                      <div>
                        <dt className="text-xs text-ink-soft">Quantidade</dt>
                        <dd className="flex items-center gap-1">
                          <button
                            type="button"
                            className="btn-ghost h-9 w-9 p-0"
                            aria-label={`Diminuir quantidade de ${nome}`}
                            disabled={quantidadeControle <= 1}
                            onClick={() => quantidade.alterar(item, -1)}
                          >
                            <Minus className="h-4 w-4" aria-hidden="true" />
                          </button>
                          <span className="w-8 text-center tabular-nums" aria-label={`Quantidade de ${nome}`} aria-live="polite">
                            {item.quantidade}
                          </span>
                          <button
                            type="button"
                            className="btn-ghost h-9 w-9 p-0"
                            aria-label={`Aumentar quantidade de ${nome}`}
                            disabled={quantidadeControle >= maximo}
                            onClick={() => quantidade.alterar(item, 1)}
                          >
                            <Plus className="h-4 w-4" aria-hidden="true" />
                          </button>
                        </dd>
                      </div>
                      <div className="text-right">
                        <dt className="text-xs text-ink-soft">Subtotal</dt>
                        <dd className="font-semibold tabular-nums">{subtotalServidor !== undefined ? precoLoja(subtotalServidor) : '—'}</dd>
                      </div>
                    </dl>

                    {/* Feedback INLINE da mutação — zero modal/drawer/overlay.
                        O botão "+" travado por estoque agora EXPLICA o motivo. */}
                    {estadoLinha.pendente && (
                      <p role="status" className="text-xs text-ink-soft">
                        Atualizando quantidade…
                      </p>
                    )}
                    {noLimite && (
                      <p className="text-xs font-medium text-amber-800" role="status">
                        Só há {l?.disponivel} unidades disponíveis.
                      </p>
                    )}
                    {(estadoLinha.erro || estadoLinha.aviso) && (
                      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900" role="alert">
                        <span>{estadoLinha.erro || estadoLinha.aviso}</span>
                        {estadoLinha.temRetry && (
                          <button type="button" className="btn-ghost h-7 px-2 text-xs" onClick={() => quantidade.tentarNovamente(item)}>
                            Tentar novamente
                          </button>
                        )}
                      </div>
                    )}

                    <button
                      type="button"
                      className="inline-flex items-center gap-1 text-sm font-medium text-danger underline-offset-2 hover:underline"
                      aria-label={`Remover ${nome} do carrinho`}
                      onClick={() => removerDoCarrinho(item.produto_id, item.tamanho_id)}
                    >
                      <Trash2 className="h-4 w-4" aria-hidden="true" /> Remover
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>

          {estado === 'LOADING' && (
            <p role="status" className="text-sm text-ink-soft">
              Calculando preço, estoque e frete…
            </p>
          )}

          <div className="rounded-2xl border border-line bg-surface p-4">
            <div className="flex flex-wrap items-end gap-2">
              <label className="text-sm">
                <span className="text-ink-soft">Cupom de desconto</span>
                <input
                  className="input mt-1 w-44 uppercase"
                  value={cupomInput}
                  maxLength={40}
                  placeholder="CÓDIGO"
                  onChange={(e) => setCupomInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      aplicarCupom();
                    }
                  }}
                />
              </label>
              <button type="button" className="btn-secondary" onClick={aplicarCupom} disabled={atualizando || !cupomInput.trim()}>
                Aplicar
              </button>
              {carrinho.cupom && (
                <button type="button" className="btn-ghost" onClick={removerCupom}>
                  Remover cupom
                </button>
              )}
              <div className="ml-auto">
                {confirmandoLimpar ? (
                  <span className="flex items-center gap-2 text-sm">
                    Esvaziar o carrinho?
                    <button
                      type="button"
                      className="btn-ghost text-danger"
                      onClick={() => {
                        limparCarrinho();
                        setConfirmandoLimpar(false);
                      }}
                    >
                      Sim, esvaziar
                    </button>
                    <button type="button" className="btn-ghost" onClick={() => setConfirmandoLimpar(false)}>
                      Cancelar
                    </button>
                  </span>
                ) : (
                  <button type="button" className="btn-ghost text-danger" onClick={() => setConfirmandoLimpar(true)}>
                    Esvaziar
                  </button>
                )}
              </div>
            </div>
            {carrinho.cupom && cotacao?.cupom && (
              <p className={`mt-2 text-sm ${cotacao.cupom.aplicado ? 'text-success' : 'text-danger'}`} aria-live="polite">
                {cotacao.cupom.aplicado
                  ? `Cupom ${cotacao.cupom.codigo} aplicado: − ${precoLoja(cotacao.cupom.desconto)}.`
                  : `${cotacao.cupom.codigo}: ${cotacao.cupom.erro ?? 'não aplicado'}.`}
              </p>
            )}
            {cotacao?.promocao && cotacao.desconto_origem === 'promocao' && (
              <p className="mt-2 text-sm text-success" aria-live="polite">
                Promoção “{cotacao.promocao.nome}” aplicada: − {precoLoja(cotacao.promocao.desconto)} (maior desconto do pedido — cupom não acumula).
              </p>
            )}
          </div>
        </section>

        <aside className="h-fit rounded-2xl border border-line bg-surface p-5 lg:sticky lg:top-20" aria-label="Resumo do pedido">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-soft">Resumo do pedido</h2>
          <dl className="mt-3 space-y-2 text-sm">
            <div className="flex justify-between gap-2">
              <dt className="text-ink-soft">Subtotal</dt>
              <dd className="tabular-nums">{mostrar(cotacao?.totais.subtotal)}</dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt className="text-ink-soft">Desconto</dt>
              <dd className="tabular-nums text-success">{sincronizada && cotacao ? (cotacao.totais.desconto > 0 ? `− ${precoLoja(cotacao.totais.desconto)}` : precoLoja(0)) : '—'}</dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt className="text-ink-soft">{cotacao?.frete.disponivel ? ROTULO_FRETE[cotacao.frete.provedor] ?? 'Frete' : 'Frete'}</dt>
              <dd className="text-right tabular-nums">
                {!sincronizada || !cotacao ? (
                  '—'
                ) : cotacao.frete_indisponivel ? (
                  <span className="text-xs text-danger">
                    Frete indisponível para esta configuração.
                    {cotacao.frete_motivo ? ` (${cotacao.frete_motivo})` : ''}
                  </span>
                ) : (
                  precoLoja(cotacao.totais.frete)
                )}
              </dd>
            </div>
            <div className="flex justify-between gap-2 border-t border-line pt-2 text-base font-semibold">
              <dt>Total</dt>
              <dd className="tabular-nums" data-testid="total-carrinho">
                {mostrar(cotacao?.totais.total)}
              </dd>
            </div>
          </dl>
          {atualizando && cotacao && (
            <p role="status" className="mt-2 text-xs text-ink-soft">
              Recalculando…
            </p>
          )}
          {config && !config.frete.disponivel && (
            <p className="mt-3 rounded-lg bg-canvas p-2 text-xs text-amber-800">
              Frete indisponível para esta configuração ({config.frete.motivo ?? 'Frete não configurado'}). A entrega precisa ser configurada antes do checkout.
            </p>
          )}
          {checkoutIndisponivelNaLoja && (
            <p className="mt-3 text-sm text-amber-800">Pagamento com configuração pendente. O checkout está temporariamente indisponível.</p>
          )}
          <button type="button" className="btn-accent mt-4 w-full" disabled={!podeAvancar} onClick={() => navigate('/loja/checkout')}>
            Continuar para o checkout
          </button>
          <Link to="/loja" className="btn-ghost mt-2 w-full text-center">
            Continuar comprando
          </Link>
          <p className="mt-3 text-[11px] leading-relaxed text-ink-soft">
            Preço, estoque, desconto e frete são recalculados no servidor a cada alteração. Na próxima etapa o pedido é criado com reserva de estoque antes da cobrança.
          </p>
        </aside>
      </div>
    </LojaShell>
  );
}
