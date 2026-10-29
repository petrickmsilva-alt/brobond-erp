// ============================================================================
// VITRINE — CHECKOUT. Rota /loja/checkout.
//
// O formulário envia carrinho + comprador + endereço; o SERVIDOR valida preço,
// estoque, cupom, frete, cria a venda analítica com RESERVA e só então pede a
// cobrança ao gateway. O pagamento NUNCA é confirmado aqui — a tela só espera
// o retorno do servidor e depois acompanha /loja/pedido/:token.
// ============================================================================
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Lock, ShieldCheck } from 'lucide-react';
import { apiFetch, ApiError } from '../../../lib/api';
import type { Preview } from './LojaCarrinhoPage';
import { LojaShell, precoLoja, type ConfigLoja } from './LojaShell';
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

export default function LojaCheckoutPage() {
  const navigate = useNavigate();
  const carrinho = useCarrinho();
  const [config, setConfig] = useState<ConfigLoja | null>(null);
  const [comprador, setComprador] = useState({ nome: '', email: '', telefone: '', documento: '' });
  const [method, setMethod] = useState('PIX');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [validando, setValidando] = useState(true);
  const [endereco, setEndereco] = useState<Endereco>(ENDERECO_VAZIO);
  const [enviando, setEnviando] = useState(false);
  const [erro, setErro] = useState('');
  const [resposta, setResposta] = useState<RespostaCheckout | null>(null);

  useEffect(() => {
    let ativo = true;
    setValidando(true);
    setPreview(null);
    Promise.all([apiFetch<ConfigLoja>('/loja/config'), apiFetch<Preview>('/loja/preview', { method: 'POST', body: JSON.stringify({ itens: carrinho.itens, cupom: carrinho.cupom || undefined }) })])
      .then(([cfg, cotacao]) => { if (ativo) { setConfig(cfg); setPreview(cotacao); if(cotacao.payment_methods?.length)setMethod(cotacao.payment_methods[0].code); setErro(''); } })
      .catch((e) => { if (ativo) setErro(e instanceof Error ? e.message : 'Não foi possível validar o checkout. Volte ao carrinho e tente novamente.'); })
      .finally(() => { if (ativo) setValidando(false); });
    return () => { ativo = false; };
  }, [carrinho]);

  useEffect(() => {
    if (!carrinho.itens.length && !resposta) navigate('/loja/carrinho', { replace: true });
  }, [carrinho.itens.length, resposta, navigate]);

  const freteRetirada = config?.frete.provedor === 'retirada';
  const freteManual = config?.frete.provedor === 'manual';
  const exigeEndereco = freteManual;
  const checkoutOk = (preview?.payment_methods === undefined || preview.payment_methods.some(m=>m.code===method)) && !validando && config?.frete.disponivel && config.checkout_disponivel !== false && preview?.itens?.length && !preview.frete_indisponivel && preview.itens.every((i) => i.ok) && Number.isFinite(preview.totais?.total) && preview.totais.total > 0 && (!preview.cupom || preview.cupom.valido);

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
            telefone: comprador.telefone.trim() || undefined,
            documento: comprador.documento.trim() || undefined,
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

  // ---- confirmação de pagamento (só servidor manda) -------------------------
  if (resposta) {
    return (
      <LojaShell titulo="Pedido criado">
        <div className="mx-auto max-w-xl space-y-4 rounded-2xl border border-line bg-surface p-6">
          <div className="flex items-center gap-3">
            <span className="flex h-10 w-10 items-center justify-center rounded-full bg-emerald-100">
              <ShieldCheck className="h-5 w-5 text-emerald-700" aria-hidden="true" />
            </span>
            <div>
              <h2 className="font-semibold">Pedido recebido!</h2>
              <p className="text-sm text-muted">
                Nº <b>{resposta.pedido?.pedido_externo ?? '—'}</b> · estoque reservado para você.
              </p>
            </div>
          </div>
          <div className="rounded-xl bg-canvas p-4 text-sm">
            <p className="font-medium">Aguardando pagamento</p>
            <p className="mt-1 text-muted">
              Pague pelo PIX abaixo (se disponível). O pedido só avança quando o pagamento for confirmado pelo
              processador — nada aqui confirma por conta própria.
            </p>
            {resposta.pagamento.copia_cola && (
              <code className="mt-3 block max-h-32 overflow-auto rounded border border-line bg-surface p-3 text-xs break-all">
                {resposta.pagamento.copia_cola}
              </code>
            )}
            {!resposta.pagamento.copia_cola && !resposta.pagamento.qr_code && (
              <p className="mt-2 text-xs text-muted">Consulte a página do pedido: o QR/Código PIX é atualizado lá conforme o gateway.</p>
            )}
          </div>
          <p className="text-center text-xs text-muted">
            Guarde o link do pedido para acompanhar o pagamento e a entrega.
          </p>
        </div>
      </LojaShell>
    );
  }

  return (
    <LojaShell titulo="Checkout">
      <button type="button" className="btn-ghost mb-4 -ml-2" onClick={() => navigate('/loja/carrinho')}>
        <ArrowLeft className="h-4 w-4" aria-hidden="true" /> Voltar ao carrinho
      </button>

      <form className="grid gap-6 lg:grid-cols-3" onSubmit={(e) => void enviar(e)}>
        <div className="space-y-6 lg:col-span-2">
          {erro && (
            <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700" role="alert">
              {erro}
            </div>
          )}

          <fieldset className="rounded-2xl border border-line bg-surface p-5">
            <legend className="px-1 text-sm font-semibold text-ink">Seus dados</legend>
            <div className="mt-2 grid gap-3 sm:grid-cols-2">
              <label className="block text-sm sm:col-span-2">
                <span className="text-ink-soft">Nome completo *</span>
                <input className="input mt-1" required maxLength={120} value={comprador.nome} onChange={(e) => setComprador((c) => ({ ...c, nome: e.target.value }))} autoComplete="name" />
              </label>
              <label className="block text-sm">
                <span className="text-ink-soft">E-mail *</span>
                <input className="input mt-1" type="email" required maxLength={160} value={comprador.email} onChange={(e) => setComprador((c) => ({ ...c, email: e.target.value }))} autoComplete="email" />
              </label>
              <label className="block text-sm">
                <span className="text-ink-soft">Telefone / WhatsApp</span>
                <input className="input mt-1" maxLength={40} value={comprador.telefone} onChange={(e) => setComprador((c) => ({ ...c, telefone: e.target.value }))} autoComplete="tel" />
              </label>
            </div>
          </fieldset>

          <fieldset className="rounded-2xl border border-line bg-surface p-5 space-y-3">
            <legend className="px-1 text-sm font-semibold text-ink">Pagamento</legend>
            <label className="block text-sm">Método de pagamento<select className="input mt-1" value={method} onChange={e=>setMethod(e.target.value)}>{preview?.payment_methods?.map(m=><option key={m.code} value={m.code}>{({PIX:'Pix',CREDIT_CARD:'Cartão de crédito',BOLETO:'Boleto',MANUAL_PAYMENT:'Pagamento manual'} as Record<string,string>)[m.code]||m.code}</option>)}</select></label>
            {preview?.payment_methods?.length===0&&<p className="text-sm text-muted">Nenhum método disponível para este pedido.</p>}
            <label className="block text-sm">CPF/CNPJ (quando exigido pelo método)<input className="input mt-1" required={preview?.payment_methods?.find(m=>m.code===method)?.required_fields?.includes('tax_id')} inputMode="numeric" maxLength={18} value={comprador.documento} onChange={e=>setComprador(c=>({...c,documento:e.target.value}))}/></label>
            <p className="text-xs text-muted">Dados de cartão são fornecidos exclusivamente no ambiente seguro do provider. A confirmação é feita pelo servidor.</p>
          </fieldset>
          <fieldset className="rounded-2xl border border-line bg-surface p-5">
            <legend className="px-1 text-sm font-semibold text-ink">Entrega</legend>
            {freteRetirada && <p className="mt-2 text-sm">Retirada na loja — frete grátis, sem entrega no endereço.</p>}
            {!freteRetirada && (
              <div className="mt-3 grid gap-3 sm:grid-cols-6">
                <label className="block text-sm sm:col-span-6">
                  <span className="text-ink-soft">CEP *</span>
                  <input
                    className="input mt-1 w-40"
                    required={exigeEndereco}
                    maxLength={9}
                    inputMode="numeric"
                    value={endereco.cep}
                    onChange={(e) => setEndereco((en) => ({ ...en, cep: e.target.value }))}
                    placeholder="00000-000"
                    autoComplete="postal-code"
                  />
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
        </div>

        <aside className="h-fit rounded-2xl border border-line bg-surface p-5">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">Confirmação</h2>
          <p className="mt-2 text-sm text-muted">
            Ao confirmar, o servidor revalida preço e estoque, <b>reserva as peças</b> e cria o pedido com prazo de{' '}
            {config?.checkout_expira_minutos ?? 60} minutos para pagamento.
          </p>
          <p className="mt-3 flex items-start gap-2 text-xs text-muted">
            <Lock className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            Pagamento via Payment Engine. A confirmação chega por webhook assinado — a loja nunca marca “pago”
            por conta própria.
          </p>
          <button type="submit" className="btn-accent mt-4 w-full" disabled={enviando || !checkoutOk}>
            {enviando ? 'Criando pedido…' : 'Confirmar pedido'}
          </button>
          {validando && <p role="status" className="mt-3 text-sm text-muted">Validando preço, estoque e frete…</p>}
          {!validando && !checkoutOk && <p role="alert" className="mt-3 text-sm text-warning">Checkout indisponível: volte ao carrinho para revisar os itens ou aguarde a configuração de frete/pagamento da loja.</p>}
          {preview?.totais && <dl className="mt-4 space-y-2 text-sm">
            <div className="flex justify-between"><dt>Subtotal</dt><dd>{precoLoja(preview.totais.subtotal)}</dd></div>
            <div className="flex justify-between"><dt>Desconto</dt><dd>{precoLoja(preview.totais.desconto)}</dd></div>
            <div className="flex justify-between"><dt>Frete</dt><dd>{preview.frete_indisponivel ? 'Frete não configurado' : precoLoja(preview.totais.frete)}</dd></div>
            <div className="flex justify-between font-semibold border-t border-line pt-2"><dt>Total</dt><dd>{precoLoja(preview.totais.total)}</dd></div>
          </dl>}
          <p className="mt-3 text-center text-xs text-muted">Total revalidado no servidor ao confirmar.</p>
        </aside>
      </form>
    </LojaShell>
  );
}
