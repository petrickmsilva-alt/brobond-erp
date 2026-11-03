// ============================================================================
// PIX — contrato canônico dos INSTRUMENTOS de pagamento devolvidos pelo PSP.
//
// Um campo, um significado (nunca o mesmo valor em dois papéis):
//   • code          → PIX "Copia e Cola" (BR Code EMV, sempre começa em 000201)
//   • qrCodeBase64  → imagem do QR Code em base64 (PNG/JPEG/GIF/WEBP reais)
//   • ticketUrl     → página oficial do provedor (somente https://)
//   • expiresAt     → expiração informada pelo provedor (ISO-8601)
//
// Nada aqui GERA instrumento: só valida o que o provedor devolveu. Um valor
// fora do formato é descartado (fica AUSENTE) — jamais "consertado", jamais
// renderizado num papel diferente (ex.: EMV como imagem).
// ============================================================================

export type PixInstrumentos = {
  code?: string;
  qrCodeBase64?: string;
  ticketUrl?: string;
  expiresAt?: string;
};

const ASSINATURAS_IMAGEM: Array<[string, number[]]> = [
  ['png', [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]],
  ['jpeg', [0xff, 0xd8, 0xff]],
  ['gif', [0x47, 0x49, 0x46, 0x38]],
  ['webp', [0x52, 0x49, 0x46, 0x46]],
];

/** BR Code EMV do PIX: payload format indicator `000201`, ASCII imprimível. */
export function copiaColaPixValido(valor: unknown): valor is string {
  if (typeof valor !== 'string') return false;
  const v = valor.trim();
  if (v.length < 20 || v.length > 1024 || !v.startsWith('000201')) return false;
  for (let i = 0; i < v.length; i++) {
    const c = v.charCodeAt(i);
    if (c < 0x20 || c > 0x7e) return false;
  }
  return true;
}

/** Base64 de IMAGEM real (assinatura binária conferida), nunca texto/EMV. */
export function qrCodeBase64Valido(valor: unknown): valor is string {
  if (typeof valor !== 'string') return false;
  const v = valor.replace(/\s/g, '');
  if (v.length < 64 || v.length > 2_000_000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(v) || v.length % 4 === 1) return false;
  let bytes: Buffer;
  try {
    bytes = Buffer.from(v.slice(0, 64), 'base64');
  } catch {
    return false;
  }
  return ASSINATURAS_IMAGEM.some(([, assinatura]) => assinatura.every((b, i) => bytes[i] === b));
}

/** Página oficial do provedor: somente URL https:// bem formada. */
export function ticketUrlPixValida(valor: unknown): valor is string {
  if (typeof valor !== 'string') return false;
  const v = valor.trim();
  if (!/^https:\/\//i.test(v) || v.length > 2048) return false;
  try {
    return new URL(v).protocol === 'https:';
  } catch {
    return false;
  }
}

function instanteValido(valor: unknown): valor is string {
  return typeof valor === 'string' && !!valor.trim() && Number.isFinite(Date.parse(valor));
}

/** Mantém apenas os campos válidos, cada um no seu papel. */
export function normalizarInstrumentosPix(bruto: {
  code?: unknown;
  qrCodeBase64?: unknown;
  ticketUrl?: unknown;
  expiresAt?: unknown;
} | null | undefined): PixInstrumentos {
  const out: PixInstrumentos = {};
  if (!bruto) return out;
  if (copiaColaPixValido(bruto.code)) out.code = bruto.code.trim();
  if (qrCodeBase64Valido(bruto.qrCodeBase64)) out.qrCodeBase64 = bruto.qrCodeBase64.replace(/\s/g, '');
  if (ticketUrlPixValida(bruto.ticketUrl)) out.ticketUrl = bruto.ticketUrl.trim();
  if (instanteValido(bruto.expiresAt)) out.expiresAt = new Date(bruto.expiresAt).toISOString();
  return out;
}

/** Pelo menos UM instrumento pagável (QR, Copia e Cola ou link oficial). */
export function temInstrumentoPix(i: PixInstrumentos | null | undefined): boolean {
  return !!(i && (i.code || i.qrCodeBase64 || i.ticketUrl));
}

/** Situação sem expor o valor (diagnóstico do backoffice). */
export function situacaoInstrumentosPix(i: { copia_cola?: unknown; qr_code_base64?: unknown; ticket_url?: unknown }) {
  const s = (ok: boolean) => (ok ? 'DISPONIVEL' : 'AUSENTE') as 'DISPONIVEL' | 'AUSENTE';
  return {
    copia_cola: s(copiaColaPixValido(i.copia_cola)),
    qr_code_base64: s(qrCodeBase64Valido(i.qr_code_base64)),
    ticket_url: s(ticketUrlPixValida(i.ticket_url)),
  };
}
