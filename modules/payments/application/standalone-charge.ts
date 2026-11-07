import { HttpError } from '../../../server/src/errors';
import { decifrarSegredo } from '../../../server/src/segredos';
import {
  configDaEmpresa,
  type CobrancaProviderResult,
  type MetodoCobranca,
} from '../../../server/src/gateway';
import { providerRegistry } from '../providers/registry';
import type { ProviderContext } from '../providers/payment-provider';
import type { PaymentMethod, ProviderCode } from '../domain/payment';

/**
 * Cobrança avulsa do financeiro pelo caminho CANÔNICO (ADR-001).
 *
 * O gateway legado (`server/src/gateway.ts`) permanece como adaptador de
 * compatibilidade: ele reserva a cobrança, aplica a semântica de idempotência e
 * a marcação `UNCERTAIN`, mas NÃO mantém uma segunda criação de cobrança. Esta
 * função é a ÚNICA ponte de criação avulsa: reutiliza os adaptadores do Engine
 * (`providerRegistry`), a configuração cifrada (`gateway_configs`), o vínculo
 * com `gateway_cobrancas`/`lancamentos_financeiros`/`vendas`/empresa e a mesma
 * fila de mutações por intenção (`locked`). Nenhum ledger paralelo é criado.
 */

const METHOD_BY_LEGACY: Record<MetodoCobranca, PaymentMethod> = {
  pix: 'PIX',
  boleto: 'BOLETO',
  cartao_credito: 'CREDIT_CARD',
  cartao_debito: 'DEBIT_CARD',
};

/**
 * Adaptador do Engine correspondente a um id legado do gateway, ou `null`
 * quando o id NÃO é uma integração de provedor — caso do duplo de demonstração
 * `mock`, que nunca existe em produção. O adaptador de compatibilidade usa isto
 * para decidir entre o Engine (provedores reais) e o duplo de demonstração.
 */
export function adaptadorEngineDoLegado(legacyId: string): ProviderCode | null {
  const p = providerRegistry.list().find((x) => x.legacyId === String(legacyId || '').toLowerCase());
  return p ? p.code : null;
}

/** Contexto do adaptador do Engine a partir da configuração empresarial cifrada. */
export async function contextoEngine(empresaId: number, code: ProviderCode, operationKey: string): Promise<ProviderContext> {
  const provider = providerRegistry.get(code);
  const config = await configDaEmpresa(empresaId, provider.legacyId);
  let credentials: Record<string, string> = {};
  try {
    credentials = JSON.parse(decifrarSegredo(config?.credenciais_cifradas) || '{}');
  } catch {
    /* ciphertext corrompido falha fechado */
  }
  return {
    empresaId,
    credentials,
    operationKey,
    webhookSecret: decifrarSegredo(config?.webhook_segredo_cifrado),
    environment: config?.ambiente === 'producao' ? 'producao' : 'teste',
  };
}

/** Estado do contrato legado (`gateway_cobrancas.status`) a partir do Engine. */
export function estadoLegado(status: string): CobrancaProviderResult['status'] {
  const s = String(status || '');
  if (s === 'FAILED') return 'falhou';
  if (s === 'CANCELED' || s === 'EXPIRED') return 'cancelada';
  if (s === 'PAID' || s === 'CAPTURED' || s === 'REFUNDED' || s === 'PARTIALLY_REFUNDED') return 'paga';
  return 'pendente';
}

export type CobrancaAvulsaParams = {
  provider: string;
  metodo: MetodoCobranca;
  valor: number;
  descricao?: string;
  expiraEm?: string | null;
  parcelas?: number;
  payerEmail?: string | null;
  payerDocumento?: string | null;
  payerNome?: string | null;
  token?: string | null;
  idempotencyKey: string;
};

/**
 * Cria a cobrança avulsa pelo adaptador canônico do Engine. A chave de
 * idempotência do chamador é a MESMA `operationKey` do provedor — um retry de
 * rede recupera o MESMO objeto no provedor, nunca cria uma segunda cobrança.
 */
export async function criarCobrancaAvulsaEngine(
  empresaId: number,
  params: CobrancaAvulsaParams
): Promise<CobrancaProviderResult> {
  const code = adaptadorEngineDoLegado(params.provider);
  if (!code) throw new HttpError(404, `Provedor "${params.provider}" não está registrado no Payment Engine.`);
  const method = METHOD_BY_LEGACY[params.metodo];
  const operationKey = String(params.idempotencyKey).slice(0, 120);
  const ctx = await contextoEngine(empresaId, code, operationKey);
  const provider = providerRegistry.get(code);
  if (!provider.supports(ctx, method)) throw new HttpError(409, 'Método indisponível no Payment Engine.');

  const result = await provider.createPaymentIntent(ctx, {
    amount: Math.round(Number(params.valor) * 100),
    currency: 'BRL',
    method,
    reference: operationKey,
    email: params.payerEmail || '',
    customerName: params.payerNome || undefined,
    taxId: params.payerDocumento || undefined,
    token: params.token || undefined,
    installments: params.parcelas || 1,
    expiresAt: params.expiraEm || undefined,
  });

  const reference = String(result.reference || '').trim();
  if (!reference) throw new HttpError(409, 'Provider não retornou referência verificável.');
  const pix = result.action?.type === 'PIX' ? result.action : null;
  return {
    provider_ref: reference,
    status: estadoLegado(result.status),
    expires_em: pix?.expiresAt || result.action?.expiresAt || params.expiraEm || null,
    qr_code: pix?.code ?? null,
    copia_cola: pix?.code ?? null,
    qr_code_base64: pix?.qrCodeBase64 ?? null,
    ticket_url: pix?.ticketUrl ?? null,
    linha_digitavel: result.action?.type === 'BOLETO' ? result.action.code ?? null : null,
    nosso_numero: result.action?.nossoNumero ?? null,
    bruto: null,
  };
}

/** Consulta o provedor pela referência JÁ GRAVADA — nunca cria outra cobrança. */
export async function consultarCobrancaAvulsaEngine(
  empresaId: number,
  provider: string,
  providerRef: string
): Promise<CobrancaProviderResult | null> {
  const code = adaptadorEngineDoLegado(provider);
  if (!code) return null;
  const ctx = await contextoEngine(empresaId, code, `query:${providerRef}`);
  const result = await providerRegistry.get(code).getPayment(ctx, providerRef);
  return {
    provider_ref: result.reference,
    status: estadoLegado(result.status),
    bruto: {
      id: result.reference,
      status: result.status,
      transaction_amount: result.amount != null ? result.amount / 100 : undefined,
      currency_id: result.currency,
      transaction_amount_refunded: result.refunded != null ? result.refunded / 100 : null,
    },
  };
}
