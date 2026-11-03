// ============================================================================
// BROBOND STORE — CHECKOUT. Rota /loja/checkout.
//
// Máquina de etapas REAL (uma etapa por vez, sem pular para frente):
//   0 Seus dados → 1 Entrega/retirada → 2 Pagamento → 3 Revisão → confirmar.
// Cada "Continuar" só avança se os campos da etapa atual estiverem válidos.
// O botão de confirmação existe SOMENTE na etapa Revisão. Voltar é sempre
// permitido, sem perder o que já foi digitado.
//
// O formulário envia carrinho + identificação + endereço. O SERVIDOR revalida
// preço, estoque, cupom, frete, cria o pedido com RESERVA e só então pede a
// cobrança ao Payment Engine. Pagamento NUNCA é confirmado aqui: a tela navega
// para /loja/pedido/:token com o token do BACKEND.
//
// Contato: e-mail + WhatsApp para comunicação TRANSACIONAL do pedido; CPF
// quando o meio de pagamento exige. Consentimento de marketing é SEPARADO e
// opcional (nunca condiciona o pedido).
//
// Falha após o pedido ser criado: o carrinho é PRESERVADO. A chave de
// idempotência NÃO é renovada no cliente: uma falha do provedor pode ser
// ambígua (cobrança possivelmente criada) e gerar outro pedido duplicaria a
// cobrança. Reabrir tentativas seguras depende de validação com o Mercado Pago real.
// ============================================================================
import { useEffect, useRef, useState } from 'react';
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

const ETAPAS = ['Seus dados', 'Entrega', 'Pagamento', 'Revisão'] as const;
const DADOS = 0;
const ENTREGA = 1;
const PAGAMENTO = 2;
const REVISAO = 3;

const ROTULO_METODO: Record<string, string> = { PIX: 'Pix', CREDIT_CARD: 'Cartão de crédito', BOLETO: 'Boleto', MANUAL_PAYMENT: 'Pagamento manual' };

export default function LojaCheckoutPage() {
  const navigate = useNavigate();
  const carrinho = useCarrinho();
  const configShell = useConfigDoShell();
  const config = configShell?.config ?? null;
  const [etapa, setEtapa] = useState(DADOS);
  const [comprador, setComprador] = useState({ nome: '', email: '', whatsapp: '', telefone: '', documento: '', marketing_opt_in: false });
  const [method, setMethod] = useState('PIX');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [validando, setValidando] = useState(true);
  const [endereco, setEndereco] = useState<Endereco>(ENDERECO_VAZIO);
  const [enviando, setEnviando] = useState(false);
  const [erro, setErro] = useState('');
  // Erro da COTAÇÃO é separado do erro de ENVIO: a revalidação não pode apagar a falha do pedido.
  const [erroCotacao, setErroCotacao] = useState('');
  const [resposta, setResposta] = useState<RespostaCheckout | null>(null);
  const etapaRef = useRef<HTMLFieldSetElement | null>(null);

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
        const metodos = cotacao.payment_methods ?? [];
        if (metodos.length) setMethod((atual) => (metodos.some((m) => m.code === atual) ? atual : metodos[0].code));
        setErroCotacao('');
      })
      .catch((e) => { if (ativo && !controller.signal.aborted) setErroCotacao(e instanceof Error ? e.message : 'Não foi possível validar o checkout. Volte ao carrinho e tente novamente.'); })
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
  const metodoDisponivel = preview?.payment_methods === undefined || preview.payment_methods.some((m) => m.code === method);
  const checkoutOk = metodoDisponivel
    && !validando && !!config && config.frete.disponivel && config.checkout_disponivel !== false
    && !!preview?.itens?.length && !preview.frete_indisponivel && preview.itens.every((i) => i.ok)
    && Number.isFinite(preview.totais?.total) && preview.totais.total > 0 && (!preview.cupom || preview.cupom.valido);

  /** Valida somente os campos da etapa atual; mostra o primeiro erro nativo. */
  const etapaValida = (): boolean => {
    const bloco = etapaRef.current;
    if (!bloco) return true;
    const campos = Array.from(bloco.querySelectorAll<HTMLInputElement | HTMLSelectElement>('input, select, textarea'));
    const invalido = campos.find((c) => !c.checkValidity());
    if (invalido) {
      invalido.reportValidity();
      invalido.focus();
      return false;
    }
    return true;
  };

  const avancar = () => {
    setErro('');
    if (!etapaValida()) return;
    if (etapa === PAGAMENTO && cpfNecessario && !comprador.documento.trim()) {
      setEtapa(DADOS);
      setErro('Informe o CPF para o pagamento via Pix.');
      return;
    }
    if (etapa === PAGAMENTO && !metodoDisponivel) {
      setErro('Escolha um método de pagamento disponível.');
      return;
    }
    setEtapa((e) => Math.min(REVISAO, e + 1));
  };

  const voltar = () => {
    setErro('');
    setEtapa((e) => Math.max(DADOS, e - 1));
  };

  const enviar = async (e: React.FormEvent) => {
    e.preventDefault();
    if (etapa !== REVISAO) return avancar();
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
      setErro(e2 instanceof ApiError ? e2.message : 'Não foi possível criar o pedido. Seu carrinho foi mantido. Tente novamente.');
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

  const nomeMetodo = (code: string) => ROTULO_METODO[code] || code;

  return (
    <LojaShell titulo="Checkout">
      <button type="button" className="btn-ghost mb-4 -ml-2" onClick={() => navigate('/loja/carrinho')}>
        <ArrowLeft className="h-4 w-4" aria-hidden="true" /> Voltar ao carrinho
      </button>

      {/* Etapas: só é possível VOLTAR para uma etapa concluída. */}
      <ol className="mb-6 grid grid-cols-4 gap-2" aria-label="Etapas do checkout">
        {ETAPAS.map((rotulo, i) => (
          <li key={rotulo} className="flex items-center gap-2">
            <button
              type="button"
              disabled={i > etapa}
              onClick={() => { setErro(''); setEtapa(i); }}
              aria-current={i === etapa ? 'step' : undefined}
              className="flex items-center gap-2 disabled:cursor-default"
            >
              <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-bold ${i === etapa ? 'bg-navy-900 text-white' : i < etapa ? 'bg-emerald-600 text-white' : 'border border-line bg-surface text-muted'}`}>
                {i < etapa ? <Check className="h-3.5 w-3.5" aria-hidden="true" /> : i + 1}
              </span>
              <span className={`hidden text-xs font-medium uppercase tracking-wider sm:inline ${i === etapa ? 'text-ink' : 'text-muted'}`}>{rotulo}</span>
            </button>
          </li>
        ))}
      </ol>

      <form className="grid gap-6 lg:grid-cols-3" onSubmit={(e) => void enviar(e)}>
        <div className="space-y-6 lg:col-span-2">
          {(erro || erroCotacao) && (
            <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700" role="alert">{erro || erroCotacao}</div>
          )}

          {/* ETAPA 1 — SEUS DADOS + CONTATO */}
          {etapa === DADOS && (
            <fieldset ref={etapaRef} className="rounded-2xl border border-line bg-surface p-5" aria-label="Seus dados">
              <legend className="px-1 text-sm font-semibold uppercase tracking-wider text-ink">1. Seus dados</legend>
              <h2 className="mt-2 text-sm font-medium">Como podemos falar com você?</h2>
              <p className="mt-1 text-xs text-muted">Usamos e-mail e WhatsApp apenas para o acompanhamento do seu pedido.</p>
              <div className="mt-4 grid gap-4 sm:grid-cols-2">
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
              <div className="mt-6 flex justify-end">
                <button type="submit" className="btn-primary min-h-11 text-sm">Continuar para entrega</button>
              </div>
            </fieldset>
          )}

          {/* ETAPA 2 — ENTREGA / RETIRADA */}
          {etapa === ENTREGA && (
            <fieldset ref={etapaRef} className="rounded-2xl border border-line bg-surface p-5" aria-label="Entrega">
              <legend className="px-1 text-sm font-semibold uppercase tracking-wider text-ink">2. Entrega</legend>
              {freteRetirada && (
                <label className="mt-3 flex cursor-pointer items-start gap-3 rounded-xl border border-line bg-canvas p-3 text-sm">
                  <input type="radio" name="entrega" value="retirada" defaultChecked required className="mt-0.5 h-4 w-4 shrink-0" />
                  <span>Retirada na loja — frete grátis, sem entrega no endereço.</span>
                </label>
              )}
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
              <div className="mt-6 flex items-center justify-between gap-3">
                <button type="button" className="btn-secondary min-h-11 text-sm" onClick={voltar}>Voltar</button>
                <button type="submit" className="btn-primary min-h-11 text-sm">Continuar para pagamento</button>
              </div>
            </fieldset>
          )}

          {/* ETAPA 3 — PAGAMENTO (somente métodos devolvidos pelo Payment Engine) */}
          {etapa === PAGAMENTO && (
            <fieldset ref={etapaRef} className="rounded-2xl border border-line bg-surface p-5 space-y-3" aria-label="Pagamento">
              <legend className="px-1 text-sm font-semibold uppercase tracking-wider text-ink">3. Pagamento</legend>
              <label className="block text-sm">
                <span className="text-ink-soft">Método de pagamento *</span>
                <select className="input mt-1" required value={method} onChange={(e) => setMethod(e.target.value)} aria-label="Método de pagamento">
                  {preview?.payment_methods?.map((m) => <option key={m.code} value={m.code}>{nomeMetodo(m.code)}</option>)}
                  {!preview?.payment_methods?.length && <option value="PIX">Pix</option>}
                </select>
              </label>
              {method === 'PIX' && <p className="text-sm text-ink-soft">Pix · pagamento instantâneo. O QR Code e o código Copia e Cola aparecem na página do pedido.</p>}
              {preview?.payment_methods?.length === 0 && <p className="text-sm text-ink-soft" role={preview.payment_methods_erro ? 'alert' : undefined}>{preview.payment_methods_erro ? 'Pagamento temporariamente indisponível. Volte ao carrinho e tente novamente em instantes.' : 'Nenhum método disponível para este pedido.'}</p>}
              <p className="text-xs text-muted">Dados de cartão são fornecidos exclusivamente no ambiente seguro do provider. Access Token e segredos ficam no backend. A confirmação chega por webhook assinado.</p>
              <div className="mt-6 flex items-center justify-between gap-3">
                <button type="button" className="btn-secondary min-h-11 text-sm" onClick={voltar}>Voltar</button>
                <button type="submit" className="btn-primary min-h-11 text-sm" disabled={!metodoDisponivel}>Continuar para revisão</button>
              </div>
            </fieldset>
          )}

          {/* ETAPA 4 — REVISÃO. Único lugar com o botão de confirmação. */}
          {etapa === REVISAO && (
            <fieldset ref={etapaRef} className="rounded-2xl border border-line bg-surface p-5 space-y-4" aria-label="Revisão do pedido">
              <legend className="px-1 text-sm font-semibold uppercase tracking-wider text-ink">4. Revisão</legend>
              <dl className="grid gap-3 text-sm sm:grid-cols-2">
                <div className="rounded-xl bg-canvas p-3">
                  <dt className="text-xs uppercase tracking-wider text-muted">Cliente</dt>
                  <dd className="mt-1 font-medium">{comprador.nome.trim()}</dd>
                  <dd className="text-muted break-all">{comprador.email.trim()}</dd>
                  <dd className="text-muted">WhatsApp: {comprador.whatsapp.trim()}</dd>
                  <dd className="text-xs text-muted">CPF: {comprador.documento.trim() ? 'informado' : 'não informado'}</dd>
                </div>
                <div className="rounded-xl bg-canvas p-3">
                  <dt className="text-xs uppercase tracking-wider text-muted">Entrega</dt>
                  <dd className="mt-1 font-medium">{freteRetirada ? 'Retirada na loja' : 'Entrega no endereço'}</dd>
                  {!freteRetirada && <dd className="text-muted">{[endereco.rua, endereco.numero, endereco.bairro, endereco.cidade, endereco.uf].filter(Boolean).join(', ')}</dd>}
                  <dt className="mt-3 text-xs uppercase tracking-wider text-muted">Pagamento</dt>
                  <dd className="mt-1 font-medium">{nomeMetodo(method)}</dd>
                </div>
              </dl>
              <ul className="space-y-1.5 text-sm" aria-label="Itens do pedido">
                {preview?.itens?.map((i) => (
                  <li key={`${i.produto_id}-${i.tamanho_id}`} className="flex justify-between gap-2">
                    <span className="truncate">{i.nome}{i.variante ? ` · ${i.variante}` : ''} × {i.quantidade}</span>
                    <span className="shrink-0 tabular-nums">{precoLoja(i.subtotal)}</span>
                  </li>
                ))}
              </ul>
              <p className="text-sm text-muted">
                Ao confirmar, o servidor revalida preço e estoque, <b>reserva as peças</b> e cria o pedido com prazo de{' '}
                {config?.checkout_expira_minutos ?? 60} minutos para pagamento.
              </p>
              <div className="flex items-center justify-between gap-3">
                <button type="button" className="btn-secondary min-h-11 text-sm" onClick={voltar} disabled={enviando}>Voltar</button>
                <button type="submit" className="btn-accent min-h-12 px-6 text-sm uppercase tracking-wider" disabled={enviando || !checkoutOk}>
                  {enviando ? 'Criando pedido…' : 'Confirmar pedido e pagar'}
                </button>
              </div>
              {!validando && !checkoutOk && <p role="alert" className="text-sm text-warning">Checkout indisponível: volte ao carrinho para revisar os itens ou aguarde a configuração de frete/pagamento da loja.</p>}
            </fieldset>
          )}
        </div>

        {/* RESUMO — sempre visível; o servidor é a única autoridade dos valores. */}
        <aside className="h-fit rounded-2xl border border-line bg-surface p-5 lg:sticky lg:top-28">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-muted">Resumo</h2>
          {preview?.totais && <dl className="mt-4 space-y-2 text-sm">
            <div className="flex justify-between"><dt>Subtotal</dt><dd>{precoLoja(preview.totais.subtotal)}</dd></div>
            <div className="flex justify-between"><dt>Desconto</dt><dd>{precoLoja(preview.totais.desconto)}</dd></div>
            <div className="flex justify-between"><dt>Frete</dt><dd>{preview.frete_indisponivel ? 'Frete não configurado' : precoLoja(preview.totais.frete)}</dd></div>
            <div className="flex justify-between border-t border-line pt-2 font-semibold"><dt>Total</dt><dd>{precoLoja(preview.totais.total)}</dd></div>
          </dl>}
          <p className="mt-3 flex items-start gap-2 text-xs text-muted">
            <Lock className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            Total oficial recalculado no servidor ao confirmar — o navegador nunca envia preço, frete ou total.
          </p>
          {validando && <p role="status" className="mt-3 text-sm text-muted">Validando preço, estoque e frete…</p>}
          {!validando && checkoutOk && <p className="mt-3 flex items-center gap-1.5 text-xs text-success"><Check className="h-3.5 w-3.5" aria-hidden="true" /> Preço e estoque validados pelo servidor.</p>}
        </aside>
      </form>
    </LojaShell>
  );
}
