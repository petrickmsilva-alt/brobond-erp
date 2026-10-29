// ============================================================================
// VITRINE — CARRINHO. Rota /loja/carrinho.
// Revalida PREÇO/ESTOQUE/CUPOM/FRETE no servidor (/api/loja/preview) a cada
// mudança — os números exibidos são sempre os do backend.
// ============================================================================
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Minus, Plus, ShoppingBag, Trash2 } from 'lucide-react';
import { apiFetch, ApiError } from '../../../lib/api';
import { LojaShell, precoLoja, type ConfigLoja } from './LojaShell';
import { alterarQuantidade, definirCupom, limparCarrinho, removerDoCarrinho, useCarrinho } from './carinho';

type ItemPreview = {
  produto_id: number;
  tamanho_id: number | null;
  quantidade: number;
  nome: string;
  sku: string;
  preco_unitario: number;
  preco_original: number | null;
  disponivel: number;
  subtotal: number;
  ok: boolean;
  aviso?: string;
};

export type Preview = {
  payment_methods?: {code:string;max_installments:number;required_fields?:string[]}[];
  itens: ItemPreview[];
  subtotal: number;
  cupom: { codigo: string; valido: boolean; aplicado: boolean; desconto: number; erro?: string } | null;
  promocao: { nome: string; desconto: number } | null;
  frete: { disponivel: true; provedor: string; valor: number; gratis: boolean; prazoDias: number | null; observacao?: string } | { disponivel: false; provedor: string; motivo: string };
  desconto: number;
  desconto_origem: 'promocao' | 'cupom' | null;
  totais: { subtotal: number; desconto: number; frete: number; total: number };
  frete_indisponivel: boolean;
  frete_motivo?: string;
};

export default function LojaCarrinhoPage() {
  const carrinho = useCarrinho();
  const navigate = useNavigate();
  const [preview, setPreview] = useState<Preview | null>(null);
  const [erro, setErro] = useState('');
  const [carregando, setCarregando] = useState(true);
  const [cupomInput, setCupomInput] = useState(carrinho.cupom || '');
  const sequencia = useRef(0);
  const [config, setConfig] = useState<ConfigLoja | null>(null);

  useEffect(() => {
    apiFetch<ConfigLoja>('/loja/config').then(setConfig).catch(() => undefined);
  }, []);

  const revalidar = useCallback(
    async (codigoCupom?: string) => {
      const atual = ++sequencia.current;
      if (!carrinho.itens.length) {
        setPreview(null);
        setCarregando(false);
        return;
      }
      setCarregando(true);
      setErro('');
      try {
        const r = await apiFetch<Preview>('/loja/preview', {
          method: 'POST',
          body: JSON.stringify({
            itens: carrinho.itens.map((i) => ({ produto_id: i.produto_id, tamanho_id: i.tamanho_id, quantidade: i.quantidade })),
            cupom: codigoCupom || undefined,
          }),
        });
        if (atual === sequencia.current) setPreview(r);
      } catch (e) {
        if (atual !== sequencia.current) return;
        setErro(e instanceof ApiError ? e.message : 'Não foi possível validar o carrinho.');
        setPreview(null);
      } finally {
        if (atual === sequencia.current) setCarregando(false);
      }
    },
    [carrinho.itens]
  );

  useEffect(() => {
    void revalidar(carrinho.cupom || undefined);
    return () => { sequencia.current++; };
  }, [carrinho.cupom, revalidar]);

  const aplicarCupom = () => {
    if ((carrinho.cupom || '') === cupomInput.trim().toUpperCase()) void revalidar(carrinho.cupom);
    else definirCupom(cupomInput);
  };

  const temItens = carrinho.itens.length > 0;

  return (
    <LojaShell titulo="Carrinho">
      {!temItens ? (
        <div className="flex flex-col items-center gap-3 rounded-2xl border border-dashed border-line bg-surface p-10 text-center">
          <ShoppingBag className="h-8 w-8 text-muted" aria-hidden="true" />
          <h2 className="font-medium">Seu carrinho está vazio</h2>
          <p className="text-sm text-muted">Explore a vitrine e adicione suas peças favoritas.</p>
          <button type="button" className="btn-primary" onClick={() => navigate('/loja')}>
            Ver produtos
          </button>
        </div>
      ) : (
        <div className="grid gap-6 lg:grid-cols-3">
          <div className="space-y-4 lg:col-span-2">
            {erro && (
              <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700" role="alert">
                {erro}
              </div>
            )}

            {(preview?.itens ?? []).map((item) => (
              <div key={`${item.produto_id}-${item.tamanho_id ?? 'un'}`} className="flex flex-wrap items-center gap-4 rounded-2xl border border-line bg-surface p-4">
                <div className="min-w-0 flex-1">
                  <div className="font-medium">{item.nome}</div>
                  <div className="text-xs text-muted">
                    SKU {item.sku}
                    {item.tamanho_id != null ? ` · tamanho #${item.tamanho_id}` : ''}
                  </div>
                  <div className="mt-1 text-sm tabular-nums">
                    {precoLoja(item.preco_unitario)} cada
                    {item.preco_original != null && item.preco_original > item.preco_unitario && (
                      <span className="ml-2 text-muted line-through">{precoLoja(item.preco_original)}</span>
                    )}
                  </div>
                  {!item.ok && <div className="mt-1 text-xs font-medium text-danger">{item.aviso ?? 'Indisponível'}</div>}
                </div>

                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    className="btn-ghost h-9 w-9 p-0"
                    aria-label={`Diminuir quantidade de ${item.nome}`}
                    onClick={() => alterarQuantidade(item.produto_id, item.tamanho_id, item.quantidade - 1)}
                  >
                    <Minus className="h-4 w-4" aria-hidden="true" />
                  </button>
                  <span className="w-8 text-center tabular-nums" aria-label={`Quantidade de ${item.nome}`}>
                    {item.quantidade}
                  </span>
                  <button
                    type="button"
                    className="btn-ghost h-9 w-9 p-0"
                    aria-label={`Aumentar quantidade de ${item.nome}`}
                    disabled={item.quantidade >= item.disponivel}
                    onClick={() => alterarQuantidade(item.produto_id, item.tamanho_id, item.quantidade + 1)}
                  >
                    <Plus className="h-4 w-4" aria-hidden="true" />
                  </button>
                </div>

                <div className="w-28 text-right font-semibold tabular-nums">{precoLoja(item.subtotal)}</div>

                <button
                  type="button"
                  className="btn-ghost h-9 w-9 p-0 text-danger"
                  aria-label={`Remover ${item.nome} do carrinho`}
                  onClick={() => removerDoCarrinho(item.produto_id, item.tamanho_id)}
                >
                  <Trash2 className="h-4 w-4" aria-hidden="true" />
                </button>
              </div>
            ))}

            <div className="flex items-center justify-between gap-3 rounded-2xl border border-line bg-surface p-4">
              <div className="flex flex-1 flex-wrap items-end gap-2">
                <label className="text-sm">
                  <span className="text-ink-soft">Cupom de desconto</span>
                  <input
                    className="input mt-1 w-44 uppercase"
                    value={cupomInput}
                    maxLength={40}
                    placeholder="CÓDIGO"
                    onChange={(e) => setCupomInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') aplicarCupom();
                    }}
                  />
                </label>
                <button type="button" className="btn-secondary" onClick={aplicarCupom} disabled={carregando}>
                  Aplicar
                </button>
              </div>
              <button type="button" className="btn-ghost text-danger" onClick={() => limparCarrinho()}>
                Esvaziar
              </button>
            </div>

            {preview?.cupom && (
              <p className={`text-sm ${preview.cupom.aplicado ? 'text-success' : 'text-danger'}`} aria-live="polite">
                {preview.cupom.aplicado
                  ? `Cupom ${preview.cupom.codigo} aplicado: − ${precoLoja(preview.cupom.desconto)}.`
                  : `${preview.cupom.codigo}: ${preview.cupom.erro ?? 'não aplicado'}.`}
              </p>
            )}
            {preview?.promocao && preview.desconto_origem === 'promocao' && (
              <p className="text-sm text-success" aria-live="polite">
                Promoção “{preview.promocao.nome}” aplicada: − {precoLoja(preview.promocao.desconto)} (maior desconto do
                pedido — cupom não acumula).
              </p>
            )}
          </div>

          <aside className="h-fit rounded-2xl border border-line bg-surface p-5" aria-label="Resumo do pedido">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">Resumo</h2>
            <dl className="mt-3 space-y-2 text-sm">
              <div className="flex justify-between gap-2">
                <dt className="text-muted">Subtotal</dt>
                <dd className="tabular-nums">{preview ? precoLoja(preview.totais.subtotal) : '…'}</dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt className="text-muted">Desconto</dt>
                <dd className="tabular-nums text-success">{preview ? `− ${precoLoja(preview.totais.desconto)}` : '…'}</dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt className="text-muted">Frete</dt>
                <dd className="tabular-nums">
                  {!preview
                    ? '…'
                    : preview.frete_indisponivel
                      ? <span className="text-danger text-xs">{preview.frete_motivo ?? 'Frete não configurado'}</span>
                      : preview.totais.frete === 0
                        ? 'Grátis'
                        : precoLoja(preview.totais.frete)}
                </dd>
              </div>
              <div className="flex justify-between gap-2 border-t border-line pt-2 text-base font-semibold">
                <dt>Total</dt>
                <dd className="tabular-nums">{preview ? precoLoja(preview.totais.total) : '…'}</dd>
              </div>
            </dl>
            {config && !config.frete.disponivel && (
              <p className="mt-3 rounded-lg bg-canvas p-2 text-xs text-warning">{config.frete.motivo ?? 'Frete não configurado'} — a entrega precisa ser configurada antes do checkout.</p>
            )}
            {config?.checkout_disponivel === false && <p className="mt-3 text-sm text-warning">Pagamento com configuração pendente. O checkout está temporariamente indisponível.</p>}
            <button
              type="button"
              className="btn-accent mt-4 w-full"
              disabled={!preview || carregando || preview.itens.some((i) => !i.ok) || preview.frete_indisponivel || !!erro || config?.checkout_disponivel === false || !!(preview.cupom && !preview.cupom.valido)}
              onClick={() => navigate('/loja/checkout')}
            >
              Continuar para o checkout
            </button>
            <button type="button" className="btn-ghost mt-2 w-full" onClick={() => navigate('/loja')}>
              Continuar comprando
            </button>
            <p className="mt-3 text-[11px] leading-relaxed text-muted">
              Preço, estoque e frete são recalculados no servidor a cada alteração. Na próxima etapa o pedido é criado
              com reserva de estoque antes da cobrança.
            </p>
          </aside>
        </div>
      )}
    </LojaShell>
  );
}
