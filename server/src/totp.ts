// ============================================================
// MFA/TOTP (RFC 6238) — sem dependências externas.
//   • Segredo Base32 (20 bytes = 160 bits) gerado com CSPRNG.
//   • HMAC-SHA1, passo de 30 s, 6 dígitos, janela ±1 (relógios dessincronizados).
//   • Comparação em tempo constante.
// ============================================================
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  const clean = s.toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const ch of clean) {
    value = (value << 5) | B32.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

export const TOTP_PERIODO = 30;
export const TOTP_DIGITOS = 6;

/** Código TOTP de um instante (segundos desde a época). */
export function codigoTOTP(segredoBase32: string, tempoSegundos: number = Math.floor(Date.now() / 1000)): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(tempoSegundos / TOTP_PERIODO)));
  const mac = createHmac('sha1', base32Decode(segredoBase32)).update(counter).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const bin =
    ((mac[offset] & 0x7f) << 24) | ((mac[offset + 1] & 0xff) << 16) | ((mac[offset + 2] & 0xff) << 8) | (mac[offset + 3] & 0xff);
  return String(bin % 10 ** TOTP_DIGITOS).padStart(TOTP_DIGITOS, '0');
}

/** Verifica o código com janela de tolerância (±1 passo = ±30 s). */
export function verificarTOTP(segredoBase32: string, codigo: unknown, janela = 1): boolean {
  const alvo = String(codigo ?? '').replace(/\D/g, '');
  if (alvo.length !== TOTP_DIGITOS) return false;
  const agora = Math.floor(Date.now() / 1000);
  for (let i = -janela; i <= janela; i++) {
    const esperado = codigoTOTP(segredoBase32, agora + i * TOTP_PERIODO);
    if (esperado.length === alvo.length && timingSafeEqual(Buffer.from(esperado), Buffer.from(alvo))) return true;
  }
  return false;
}

/** Segredo novo (160 bits, Base32 — o formato que os apps autenticadores esperam). */
export function gerarSegredoTOTP(): string {
  return base32Encode(randomBytes(20));
}

/** URI otpauth:// para apps autenticadores (Google Authenticator, Aegis, 1Password...). */
export function uriTOTP(email: string, segredo: string): string {
  const issuer = 'BROBOND ERP';
  return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(email)}?secret=${segredo}&issuer=${encodeURIComponent(
    issuer
  )}&algorithm=SHA1&digits=${TOTP_DIGITOS}&period=${TOTP_PERIODO}`;
}
