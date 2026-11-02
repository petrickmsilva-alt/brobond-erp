// ============================================================================
// STOREFRONT ENTERPRISE — IDENTIFICAÇÃO DO COMPRADOR (checkout).
//
// O checkout deixa de ser "só pagamento": aqui nasce o CONTATO do pedido,
// usado para pagamento, emissão, comunicação transacional e acompanhamento.
// NÃO cria cadastro de cliente paralelo: o contato fica em
// `commerce_pedidos.comprador` (JSONB) e a `sale` canônica já guarda
// buyer_name/buyer_email. O ERP/CRM continua sendo a fonte de clientes.
//
// Separação obrigatória (prompt §31):
//   • comunicação transacional = necessária para o pedido (sem opt-in);
//   • marketing = `marketing_opt_in`, consentimento EXPLÍCITO e separado,
//     registrado com data; nesta rodada NENHUMA mensagem promocional é enviada.
// ============================================================================
import { normalizarWhatsApp } from './notificacoes';

export type CompradorCheckout = {
  nome: string;
  email: string;
  /** E.164 (só dígitos) — canal transacional WhatsApp. */
  whatsapp: string;
  /** Telefone legado, quando diferente do WhatsApp (opcional). */
  telefone: string | null;
  /** CPF somente dígitos, quando necessário ao meio de pagamento/fiscal. */
  documento: string | null;
  marketing_opt_in: boolean;
  consentimento_em: string | null;
  /** Consentimento para comunicação transacional é inerente ao pedido. */
  transacional: true;
};

export type ResultadoComprador =
  | { ok: true; comprador: CompradorCheckout }
  | { ok: false; campo: string; mensagem: string };

const EMAIL_OK = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** CPF real: 11 dígitos, rejeita sequências repetidas e valida os 2 dígitos verificadores. */
export function validarCPF(valor: unknown): boolean {
  const d = String(valor ?? '').replace(/\D/g, '');
  if (d.length !== 11 || /^(\d)\1{10}$/.test(d)) return false;
  const digitos = d.split('').map(Number);
  for (const pos of [9, 10]) {
    let soma = 0;
    for (let i = 0; i < pos; i++) soma += digitos[i] * (pos + 1 - i);
    const resto = (soma * 10) % 11;
    const esperado = resto === 10 ? 0 : resto;
    if (esperado !== digitos[pos]) return false;
  }
  return true;
}

export function normalizarCPF(valor: unknown): string | null {
  const d = String(valor ?? '').replace(/\D/g, '');
  return d.length === 11 ? d : null;
}

/**
 * Sanitiza e valida o comprador. `exigirDocumento` é decisão do SERVIDOR
 * (meio de pagamento), nunca confiada ao navegador. Valores monetários,
 * empresa_id e status de pagamento enviados no corpo são ignorados.
 */
export function normalizarComprador(
  bruto: unknown,
  opcoes: { exigirDocumento?: boolean; agora?: Date } = {}
): ResultadoComprador {
  const c = (bruto && typeof bruto === 'object' ? bruto : {}) as Record<string, unknown>;
  const nome = String(c.nome || '').trim().replace(/\s+/g, ' ').slice(0, 120);
  if (nome.length < 2) return { ok: false, campo: 'nome', mensagem: 'Informe o nome completo do comprador.' };
  const email = String(c.email || '').trim().toLowerCase().slice(0, 160);
  if (!EMAIL_OK.test(email)) return { ok: false, campo: 'email', mensagem: 'E-mail inválido.' };
  const whatsapp = normalizarWhatsApp(c.whatsapp ?? c.telefone);
  if (!whatsapp) return { ok: false, campo: 'whatsapp', mensagem: 'Informe um WhatsApp válido para as atualizações do pedido.' };

  const documentoBruto = c.documento ?? c.cpf;
  let documento: string | null = null;
  if (documentoBruto != null && String(documentoBruto).trim()) {
    if (!validarCPF(documentoBruto)) return { ok: false, campo: 'documento', mensagem: 'CPF inválido.' };
    documento = normalizarCPF(documentoBruto);
  }
  if (opcoes.exigirDocumento && !documento) {
    return { ok: false, campo: 'documento', mensagem: 'CPF é necessário para este meio de pagamento.' };
  }

  const telefoneBruto = c.telefone && String(c.telefone).trim() ? normalizarWhatsApp(c.telefone) : null;
  const marketing = c.marketing_opt_in === true || c.marketing_opt_in === 'true';
  const consentimentoEm = marketing ? (opcoes.agora ?? new Date()).toISOString() : null;
  return {
    ok: true,
    comprador: {
      nome,
      email,
      whatsapp,
      telefone: telefoneBruto && telefoneBruto !== whatsapp ? telefoneBruto : null,
      documento,
      marketing_opt_in: marketing,
      consentimento_em: consentimentoEm,
      transacional: true,
    },
  };
}

/** Máscara de exibição do WhatsApp no pós-pedido (nunca loga o número cru). */
export function mascararWhatsApp(e164: string | null | undefined): string | null {
  const d = String(e164 ?? '').replace(/\D/g, '');
  if (d.length < 12) return null;
  const n = d.slice(-11);
  return `(${n.slice(0, 2)}) ${n.slice(2, 7)}-${n.slice(7)}`;
}

/** Máscara de CPF para exibição (LGPD: nunca CPF completo em tela/log). */
export function mascararCPF(cpf: string | null | undefined): string | null {
  const d = String(cpf ?? '').replace(/\D/g, '');
  if (d.length !== 11) return null;
  return `***.${d.slice(3, 6)}.${d.slice(6, 9)}-**`;
}
