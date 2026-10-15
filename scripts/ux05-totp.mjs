// UX-05 — gera o código TOTP no momento do login.
//
// O código tem validade de 30 s: calculá-lo uma vez no shell e reutilizá-lo em
// várias execuções faz a segunda falhar. Aqui ele é derivado a cada login.
//
// Fonte do segredo: `UX05_TOTP_SECRET` (base32) ou `UX05_TOTP_SECRET_FILE`.
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';

const ALFABETO = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Decodificar(valor) {
  const limpo = String(valor).toUpperCase().replace(/[\s=]/g, '');
  let bits = 0;
  let acumulado = 0;
  const bytes = [];
  for (const c of limpo) {
    const idx = ALFABETO.indexOf(c);
    if (idx < 0) continue;
    acumulado = (acumulado << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((acumulado >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

function segredo() {
  const direto = process.env.UX05_TOTP_SECRET;
  if (direto) return direto.trim();
  const arquivo = process.env.UX05_TOTP_SECRET_FILE;
  if (arquivo) return readFileSync(arquivo, 'utf8').trim();
  throw new Error('Defina UX05_TOTP_SECRET (base32) ou UX05_TOTP_SECRET_FILE.');
}

/** Código TOTP de 6 dígitos para o instante atual (RFC 6238, SHA-1, 30 s). */
export function totpAgora() {
  const chave = base32Decodificar(segredo());
  const contador = Math.floor(Date.now() / 1000 / 30);
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(contador));
  const hash = createHmac('sha1', chave).update(msg).digest();
  const offset = hash[hash.length - 1] & 0x0f;
  const bin =
    ((hash[offset] & 0x7f) << 24) | ((hash[offset + 1] & 0xff) << 16) | ((hash[offset + 2] & 0xff) << 8) | (hash[offset + 3] & 0xff);
  return String(bin % 1_000_000).padStart(6, '0');
}
