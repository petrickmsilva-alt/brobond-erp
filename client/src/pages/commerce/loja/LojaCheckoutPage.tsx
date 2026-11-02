// ============================================================================
// BROBOND STORE — CHECKOUT. Rota /loja/checkout.
//
// O formulário envia carrinho + IDENTIFICAÇÃO COMPLETA + endereço. O SERVIDOR
// revalida preço, estoque, cupom, frete, cria a venda analítica com RESERVA e
// só então pede a cobrança ao Payment Engine. Pagamento NUNCA é confirmado
// aqui: a tela navega para /loja/pedido/:token com o token do BACKEND.
//
// Contato: e-mail + WhatsApp para comunicação TRANSACIONAL do pedido; CPF
// quando o meio de pagamento exige. Consentimento de marketing é SEPARADO e
// opcional (nunca condiciona o pedido).
//
// Performance: NÃO refaz /loja/config — usa `useConfigDoShell()` (antes havia
// requisição duplicada a cada montagem). AbortController cancela cotação velha.
// ============================================================================
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Check, Lock, MessageCircle, ShieldCheck } from 'lucide-react';
import { apiFetch, ApiError } from '../../../lib/api';
import type { Preview } from './LojaCarrinhoPage';
import { LojaShell, precoLoja, useConfigDoShell } from './LojaShell';
import { lerCarrinho, limparCarrinho, useCarrinho } from './carinho';

type RespostaCheckout = {
  ok: boolean;
  idempotente?: boolean;
  sale_id: string;
  pedido: {
    pedido_externo: string;
    estado: string;
    total: number;
    expira_em: string | null;
    checkout_token: string | null;
  } | null;
  pagamento: { status: string; provider: string | null; qr_code: string | null; copia_cola: string | null; expira_em: string | null };
  itens: unknown[];
};

type Endereco = { nome: string; rua: string; numero: string; complemento: string; bairro: string; cidade: string; uf: string; cep: string };
const ENDERECO_VAZIO: Endereco = { nome: '', rua: '', numero: '', complemento: '', bairro: '', cidade: '', uf: '', cep: '' };

const ETAPAS = ['Seus dados', 'Entrega', 'Pagamento', 'Revisão'];

export default function LojaCheckoutPage() {
  const navigate = useNavigate();
  const carrinho = useCarrinho();
  const configShell = useConfigDoShell();
  const config = configShell?.config ?? null;
  const [comprador, setComprador] = useState({ nome: '', email: '', whatsapp: '', telefone: '', documento: '', marketing_opt_in: false });
  const [method, setMethod] = useState('PIX');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [validando, setValidando] = useState(true);
  const [endereco, setEndereco] = useState<Endereco>(ENDERECO_VAZIO);
  const [enviando, setEnviando] = useState(false);
  const [erro, setErro] = useState('');
  const [resposta, setResposta] = useState<RespostaCheckout | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    let ativo = true;
    setValidando(true);
    setPreview(null);
    // Só a cotação: a identidade/frete já veio do LojaShell (1 request).
    apiFetch<Preview>('/loja/preview', {
      method: 'POST',
      signal: controller.signal,
      body: JSON.stringify({ itens: carrinho.itens, cupom: carrinho.cupom || undefined }),
    })
      .then((cotacao) => {
        if (!ativo) return;
        setPreview(cotacao);
        if (cotacao.payment_methods?.length) setMethod(cotacao.payment_methods[0].code);
        setErro('');
      })
      .catch((e) => { if (ativo && !controller.signal.aborted) setErro(e instanceof Error ? e.message : 'Não foi possível validar o checkout. Volte ao carrinho e tente novamente.'); })
      .finally(() => { if (ativo && !controller.signal.aborted) setValidando(false); });
    return () => { ativo = false; controller.abort(); };
  }, [carrinho]);

  useEffect(() => {
    if (!carrinho.itens.length && !resposta) navigate('/loja/carrinho', { replace: true });
  }, [carrinho.itens.length, resposta, navigate]);

  const freteRetirada = config?.frete.provedor === 'retirada';
  const freteManual = config?.frete.provedor === 'manual';
  const exigeEndereco = freteManual;
  const cpfNecessario = method === 'PIX' || !!preview?.payment_methods?.find((m) => m.code === method)?.required_fields?.includes('tax_id');
  const checkoutOk = (preview?.payment_methods === undefined || preview.payment_methods.some(m => m.code === method))
    && !validando && !!config && config.frete.disponivel && config.checkout_disponivel !== false
    && !!preview?.itens?.length && !preview.frete_indisponivel && preview.itens.every((i) => i.ok)
    && Number.isFinite(preview.totais?.total) && preview.totais.total > 0 && (!preview.cupom || preview.cupom.valido);

  const enviar = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!checkoutOk || enviando) return;
    setEnviando(true);
    setErro('');
    try {
      const r = await apiFetch<RespostaCheckout>('/loja/checkout', {
        method: 'POST',
        body: JSON.stringify({
          payment_method: method,
          chave: lerCarrinho().chave,
          itens: carrinho.itens.map((i) => ({ produto_id: i.produto_id, tamanho_id: i.tamanho_id, quantidade: i.quantidade })),
          cupom: carrinho.cupom || undefined,
          comprador: {
            nome: comprador.nome.trim(),
            email: comprador.email.trim(),
            whatsapp: comprador.whatsapp.trim(),
            telefone: comprador.telefone.trim() || undefined,
            documento: comprador.documento.trim() || undefined,
            marketing_opt_in: comprador.marketing_opt_in,
          },
          endereco:
            freteRetirada
              ? null
              : {
                  nome: endereco.nome || comprador.nome,
                  rua: endereco.rua,
                  numero: endereco.numero,
                  complemento: endereco.complemento || null,
                  bairro: endereco.bairro,
                  cidade: endereco.cidade,
                  uf: endereco.uf,
                  cep: endereco.cep,
                },
        }),
      });
      setResposta(r);
      limparCarrinho();
      // segue para a página do acompanhamento com o token do pedido
      const token = r.pedido?.checkout_token;
      if (token) navigate(`/loja/pedido/${token}`, { replace: true });
    } catch (e2) {
      setErro(e2 instanceof ApiError ? e2.message : 'Não foi possível criar o pedido. Tente novamente.');
      setEnviando(false);
    }
  };

  // ---- confirmação de pedido (só servidor manda) ---------------------------
  if (resposta) {
    return (
      <LojaShell titulo="Pedido criado">
        <div className="mx-auto max-w-xl space-y-4 rounded-2xl border border-line bg-surface p-6">
          <div className="flex items-center gap-3">
            <span className="flex h-10 w-10 items-center justify-center rounded-full bg-emerald-100">
              <ShieldCheck className="h-5 w-5 text-emerald-700" aria-hidden="true" />
            </span>
            <div>
              <h2 className="font-semibold">Pedido realizado!</h2>
              <p className="text-sm text-muted">
                Pedido <b>#{resposta.pedido?.pedido_externo ?? '—'}</b> · estoque reservado para você.
              </p>
            </div>
          </div>
          <div className="rounded-xl bg-canvas p-4 text-sm">
            <p className="font-medium">Você receberá atualizações em</p>
            <p className="mt-1 break-all text-muted">{comprador.email.trim()}</p>
            <p className="mt-0.5 flex items-center gap-1.5 text-muted"><MessageCircle className="h-3.5 w-3.5" aria-hidden="true" /> WhatsApp: {comprador.whatsapp.trim()}</p>
          </div>
          <div className="rounded-xl bg-canvas p-4 text-sm">
            <p className="font-medium">Pagamento pendente</p>
            <p className="mt-1 text-muted">Finalize o pagamento via PIX na página do pedido. O pedido só avança quando o pagamento for confirmado pelo processador — nada aqui confirma por conta própria.</p>
            {resposta.pagamento.copia_cola && (
              <code className="mt-3 block max-h-32 overflow-auto rounded border border-line bg-surface p-3 text-xs break-all">
                {resposta.pagamento.copia_cola}
              </code>
            )}
          </div>
          <p className="text-center text-xs text-muted">Guarde o link do pedido para acompanhar o pagamento e a entrega.</p>
        </div>
      </LojaShell>
    );
  }

  return (
    <LojaShell titulo="Checkout">
      <button type="button" className="btn-ghost mb-4 -ml-2" onClick={() => navigate('/loja/carrinho')}>
        <ArrowLeft className="h-4 w-4" aria-hidden="true" /> Voltar ao carrinho
      </button>

      {/* Etapas VISUAIS — experiência equivalente sem quebrar o backend único. */}
      <ol className="mb-6 grid grid-cols-4 gap-2" aria-label="Etapas do checkout">
        {ETAPAS.map((etapa, i) => (
          <li key={etapa} className="flex items-center gap-2">
            <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-bold ${i === 0 ? 'bg-navy-900 text-white' : 'border border-line bg-surface text-muted'}`}>{i + 1}</span>
            <span className={`hidden text-xs font-medium uppercase tracking-wider sm:inline ${i === 0 ? 'text-ink' : 'text-muted'}`}>{etapa}</span>
          </li>
        ))}
      </ol>

      <form className="grid gap-6 lg:grid-cols-3" onSubmit={(e) => void enviar(e)}>
        <div className="space-y-6 lg:col-span-2">
          {erro && (
            <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700" role="alert">{erro}</div>
          )}

          {/* 1. SEUS DADOS + CONTATO */}
          <fieldset className="rounded-2xl border border-line bg-surface p-5">
            <legend className="px-1 text-sm font-semibold uppercase tracking-wider text-ink">1. Seus dados</legend>
            <h2 className="mt-2 text-sm font-medium">Como podemos falar com você?</h2>
            <p className="mt-1 text-xs text-muted">Usamos e-mail e WhatsApp apenas para atualizações deste pedido: confirmação, PIX, pagamento aprovado, preparação, envio e entrega.</p>
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <label className="block text-sm sm:col-span-2">
                <span className="text-ink-soft">Nome completo *</span>
                <input className="input mt-1" required maxLength={120} value={comprador.nome} onChange={(e) => setComprador((c) => ({ ...c, nome: e.target.value }))} autoComplete="name" />
              </label>
              <label className="block text-sm">
                <span className="text-ink-soft">E-mail *</span>
                <input className="input mt-1" type="email" required maxLength={160} value={comprador.email} onChange={(e) => setComprador((c) => ({ ...c, email: e.target.value }))} autoComplete="email" placeholder="voce@email.com" />
              </label>
              <label className="block text-sm">
                <span className="text-ink-soft">WhatsApp *</span>
                <input className="input mt-1" required maxLength={40} value={comprador.whatsapp} onChange={(e) => setComprador((c) => ({ ...c, whatsapp: e.target.value }))} autoComplete="tel" inputMode="tel" placeholder="(00) 00000-0000" />
              </label>
              <label className="block text-sm">
                <span className="text-ink-soft">Telefone alternativo (opcional)</span>
                <input className="input mt-1" maxLength={40} value={comprador.telefone} onChange={(e) => setComprador((c) => ({ ...c, telefone: e.target.value }))} inputMode="tel" />
              </label>
              <label className="block text-sm">
                <span className="text-ink-soft">CPF {cpfNecessario ? '*' : '(quando exigido)'}</span>
                <input className="input mt-1" required={cpfNecessario} inputMode="numeric" maxLength={18} value={comprador.documento} onChange={(e) => setComprador((c) => ({ ...c, documento: e.target.value }))} placeholder="000.000.000-00" autoComplete="off" />
                {cpfNecessario && <span className="mt-1 block text-[11px] text-muted">Necessário para identificação do pagador no PIX. Mantido apenas no servidor.</span>}
              </label>
            </div>
            {/* Consentimento de marketing é SEPARADO do transacional. */}
            <label className="mt-4 flex cursor-pointer items-start gap-3 rounded-xl border border-line bg-canvas p-3 text-sm">
              <input type="checkbox" className="mt-0.5 h-4 w-4 shrink-0" checked={comprador.marketing_opt_in} onChange={(e) => setComprador((c) => ({ ...c, marketing_opt_in: e.target.checked }))} />
              <span>
                <span className="font-medium">Quero receber novidades e ofertas da BroBond.</span>
                <span className="mt-0.5 block text-xs text-muted">Opcional e independente: as atualizações do pedido são enviadas mesmo sem esta autorização. Nenhuma mensagem promocional é enviada sem este consentimento.</span>
              </span>
            </label>
          </fieldset>

          {/* 2. ENTREGA */}
          <fieldset className="rounded-2xl border border-line bg-surface p-5">
            <legend className="px-1 text-sm font-semibold uppercase tracking-wider text-ink">2. Entrega</legend>
            {freteRetirada && <p className="mt-2 text-sm">Retirada na loja — frete grátis, sem entrega no endereço.</p>}
            {!freteRetirada && (
              <div className="mt-3 grid gap-3 sm:grid-cols-6">
                <label className="block text-sm sm:col-span-6">
                  <span className="text-ink-soft">CEP *</span>
                  <input className="input mt-1 w-40" required={exigeEndereco} maxLength={9} inputMode="numeric" value={endereco.cep}
                    onChange={(e) => setEndereco((en) => ({ ...en, cep: e.target.value }))} placeholder="00000-000" autoComplete="postal-code" />
                </label>
                <label className="block text-sm sm:col-span-4">
                  <span className="text-ink-soft">Rua *</span>
                  <input className="input mt-1" required={exigeEndereco} maxLength={160} value={endereco.rua} onChange={(e) => setEndereco((en) => ({ ...en, rua: e.target.value }))} autoComplete="address-line1" />
                </label>
                <label className="block text-sm sm:col-span-2">
                  <span className="text-ink-soft">Número *</span>
                  <input className="input mt-1" required={exigeEndereco} maxLength={20} value={endereco.numero} onChange={(e) => setEndereco((en) => ({ ...en, numero: e.target.value }))} />
                </label>
                <label className="block text-sm sm:col-span-3">
                  <span className="text-ink-soft">Complemento</span>
                  <input className="input mt-1" maxLength={80} value={endereco.complemento} onChange={(e) => setEndereco((en) => ({ ...en, complemento: e.target.value }))} />
                </label>
                <label className="block text-sm sm:col-span-3">
                  <span className="text-ink-soft">Bairro *</span>
                  <input className="input mt-1" required={exigeEndereco} maxLength={80} value={endereco.bairro} onChange={(e) => setEndereco((en) => ({ ...en, bairro: e.target.value }))} />
                </label>
                <label className="block text-sm sm:col-span-4">
                  <span className="text-ink-soft">Cidade *</span>
                  <input className="input mt-1" required={exigeEndereco} maxLength={80} value={endereco.cidade} onChange={(e) => setEndereco((en) => ({ ...en, cidade: e.target.value }))} autoComplete="address-level2" />
                </label>
                <label className="block text-sm sm:col-span-2">
                  <span className="text-ink-soft">UF *</span>
                  <input className="input mt-1 uppercase" required={exigeEndereco} maxLength={2} value={endereco.uf} onChange={(e) => setEndereco((en) => ({ ...en, uf: e.target.value.toUpperCase() }))} autoComplete="address-level1" />
                </label>
              </div>
            )}
          </fieldset>

          {/* 3. PAGAMENTO */}
          <fieldset className="rounded-2xl border border-line bg-surface p-5 space-y-3">
            <legend className="px-1 text-sm font-semibold uppercase tracking-wider text-ink">3. Pagamento</legend>
            <label className="block text-sm">
              <span className="text-ink-soft">Método de pagamento</span>
              <select className="input mt-1" value={method} onChange={(e) => setMethod(e.target.value)} aria-label="Método de pagamento">
                {preview?.payment_methods?.map((m) => <option key={m.code} value={m.code}>{({ PIX: 'Pix', CREDIT_CARD: 'Cartão de crédito', BOLETO: 'Boleto', MANUAL_PAYMENT: 'Pagamento manual' } as Record<string, string>)[m.code] || m.code}</option>)}
                {!preview?.payment_methods?.length && <option value="PIX">Pix</option>}
              </select>
            </label>
            {preview?.payment_methods?.length === 0 && <p className="text-sm text-ink-soft" role={preview.payment_methods_erro ? 'alert' : undefined}>{preview.payment_methods_erro ? 'Pagamento temporariamente indisponível. Volte ao carrinho e tente novamente em instantes.' : 'Nenhum método disponível para este pedido.'}</p>}
            <p className="text-xs text-muted">Dados de cartão são fornecidos exclusivamente no ambiente seguro do provider. Access Token e segredos ficam no backend. A confirmação chega por webhook assinado.</p>
          </fieldset>
        </div>

        {/* 4. REVISÃO */}
        <aside className="h-fit rounded-2xl border border-line bg-surface p-5 lg:sticky lg:top-28">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-muted">4. Revisão</h2>
          <p className="mt-2 text-sm text-muted">
            Ao confirmar, o servidor revalida preço e estoque, <b>reserva as peças</b> e cria o pedido com prazo de{' '}
            {config?.checkout_expira_minutos ?? 60} minutos para pagamento.
          </p>
          <ul className="mt-3 space-y-1.5 text-xs text-muted" aria-label="Itens do pedido">
            {preview?.itens?.map((i) => (
              <li key={`${i.produto_id}-${i.tamanho_id}`} className="flex justify-between gap-2">
                <span className="truncate">{i.nome}{i.variante ? ` · ${i.variante}` : ''} × {i.quantidade}</span>
                <span className="shrink-0 tabular-nums">{precoLoja(i.subtotal)}</span>
              </li>
            ))}
          </ul>
          {preview?.totais && <dl className="mt-4 space-y-2 text-sm">
            <div className="flex justify-between"><dt>Subtotal</dt><dd>{precoLoja(preview.totais.subtotal)}</dd></div>
            <div className="flex justify-between"><dt>Desconto</dt><dd>{precoLoja(preview.totais.desconto)}</dd></div>
            <div className="flex justify-between"><dt>Frete</dt><dd>{preview.frete_indisponivel ? 'Frete não configurado' : precoLoja(preview.totais.frete)}</dd></div>
            <div className="flex justify-between border-t border-line pt-2 font-semibold"><dt>Total</dt><dd>{precoLoja(preview.totais.total)}</dd></div>
          </dl>}
          <p className="mt-2 flex items-start gap-2 text-xs text-muted">
            <Lock className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            Total oficial recalculado no servidor ao confirmar — o navegador nunca envia preço, frete ou total.
          </p>
          <button type="submit" className="btn-accent mt-5 min-h-12 w-full text-sm uppercase tracking-wider" disabled={enviando || !checkoutOk}>
            {enviando ? 'Criando pedido…' : 'Confirmar pedido'}
          </button>
          {validando && <p role="status" className="mt-3 text-sm text-muted">Validando preço, estoque e frete…</p>}
          {!validando && !checkoutOk && <p role="alert" className="mt-3 text-sm text-warning">Checkout indisponível: volte ao carrinho para revisar os itens ou aguarde a configuração de frete/pagamento da loja.</p>}
          {!validando && checkoutOk && <p className="mt-3 flex items-center gap-1.5 text-xs text-success"><Check className="h-3.5 w-3.5" aria-hidden="true" /> Preço e estoque validados pelo servidor.</p>}
        </aside>
      </form>
    </LojaShell>
  );
}
