/**
 * Criptografia das credenciais de conector — AES-256-GCM.
 *
 * Fonte: `modules/marketplace/core/crypto.service.ts` do
 * brobond-ai-commerce (PR012), portado sem alteração de contrato: o
 * formato da cifra é o MESMO, então credenciais exportadas do commerce
 * continuam abrindo no ERP com a mesma chave.
 *
 * Todo token OAuth2 / chave de API gravado na tabela `connectors` passa
 * por aqui. Credencial em texto puro NUNCA é gravada, NUNCA é selecionada
 * para um DTO de painel e NUNCA volta para o navegador.
 *
 * Formato da cifra (versionado, pronto para rotação):
 *   `v1.<iv base64url>.<auth-tag base64url>.<texto cifrado base64url>`
 *
 * A chave é a global `CONNECTOR_ENCRYPTION_KEY` já declarada no
 * `server/.env.example` na Fase 1.
 */

import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const VERSION = 'v1';
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const KEY_BYTES = 32;

export class ConnectorCryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConnectorCryptoError';
  }
}

/**
 * Decodifica uma chave AES de exatamente 32 bytes. Uma passphrase NUNCA é
 * silenciosamente derivada por hash: chave fraca é erro de configuração,
 * não um detalhe a ser escondido.
 */
export function decodeConnectorEncryptionKey(value: string | undefined): Buffer {
  if (!value || !value.trim()) {
    throw new ConnectorCryptoError('CONNECTOR_ENCRYPTION_KEY é obrigatória.');
  }
  const trimmed = value.trim();
  const candidate = /^[a-fA-F0-9]{64}$/.test(trimmed) ? Buffer.from(trimmed, 'hex') : Buffer.from(trimmed, 'base64url');
  if (candidate.length !== KEY_BYTES) {
    throw new ConnectorCryptoError(
      'CONNECTOR_ENCRYPTION_KEY precisa decodificar para exatamente 32 bytes (base64/base64url ou 64 caracteres hex).'
    );
  }
  return candidate;
}

/** `true` quando a chave global está presente e é válida (sem lançar). */
export function hasConnectorEncryptionKey(keyValue: string | undefined = process.env.CONNECTOR_ENCRYPTION_KEY): boolean {
  try {
    decodeConnectorEncryptionKey(keyValue);
    return true;
  } catch {
    return false;
  }
}

/** Cifra uma credencial em AES-256-GCM versionado. */
export function encryptConnectorSecret(plaintext: string, keyValue: string | undefined = process.env.CONNECTOR_ENCRYPTION_KEY): string {
  if (!plaintext) {
    throw new ConnectorCryptoError('Não é possível cifrar uma credencial vazia.');
  }
  const key = decodeConnectorEncryptionKey(keyValue);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString('base64url'), tag.toString('base64url'), ciphertext.toString('base64url')].join('.');
}

/** Decifra uma credencial versionada e rejeita qualquer adulteração. */
export function decryptConnectorSecret(ciphertext: string, keyValue: string | undefined = process.env.CONNECTOR_ENCRYPTION_KEY): string {
  const [version, ivEncoded, tagEncoded, valueEncoded, ...extra] = ciphertext.split('.');
  if (version !== VERSION || !ivEncoded || !tagEncoded || !valueEncoded || extra.length > 0) {
    throw new ConnectorCryptoError('Formato inválido de credencial cifrada.');
  }
  try {
    const iv = Buffer.from(ivEncoded, 'base64url');
    const tag = Buffer.from(tagEncoded, 'base64url');
    if (iv.length !== IV_BYTES || tag.length !== AUTH_TAG_BYTES) {
      throw new ConnectorCryptoError('Parâmetros inválidos na credencial cifrada.');
    }
    const decipher = createDecipheriv(ALGORITHM, decodeConnectorEncryptionKey(keyValue), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(Buffer.from(valueEncoded, 'base64url')), decipher.final()]).toString('utf8');
  } catch (error) {
    if (error instanceof ConnectorCryptoError) throw error;
    throw new ConnectorCryptoError('Não foi possível decifrar a credencial do conector.');
  }
}

/** O state de OAuth é persistido como digest de via única, nunca em claro. */
export function hashConnectorOAuthState(state: string): string {
  return createHash('sha256').update(state, 'utf8').digest('hex');
}

/** HMAC-SHA256 (hex) — usado pelo assinador do Mercado Pago (e, futuramente, da Nuvemshop). */
export function hmacSha256Hex(secret: string, payload: string): string {
  return createHmac('sha256', secret).update(payload, 'utf8').digest('hex');
}

/**
 * Prévia mascarada de uma credencial para o painel (ex.: a public key do
 * Mercado Pago): mantém os 4 últimos caracteres e esconde o resto. O valor
 * mascarado não pode ser revertido.
 */
export function maskConnectorSecretPreview(plaintext: string): string {
  return `••••${plaintext.slice(-4)}`;
}
