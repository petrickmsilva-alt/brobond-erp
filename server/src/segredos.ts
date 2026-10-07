// ============================================================================
// SEGREDOS DE INTEGRAÇÃO — cifra simétrica para credenciais guardadas no banco.
//
// Token de provedor fiscal, senha de certificado A1, CSC da NFC-e, token de
// gateway de pagamento: nada disso pode dormir em texto puro numa coluna.
// Aqui o esquema é o mesmo já validado no MFA (AES-256-GCM, formato
// versionado `v1.iv.tag.ciphertext` em base64url), mas com SAL PRÓPRIO — a
// chave derivada aqui não abre os segredos do MFA e vice-versa. Vazar um não
// entrega o outro.
//
// Chave: SEGREDOS_ENCRYPTION_KEY, ou APP_ENCRYPTION_KEY, ou JWT_SECRET.
// Em produção, defina SEGREDOS_ENCRYPTION_KEY — `chaveFraca()` avisa quando
// ela está faltando.
// ============================================================================
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';

const SAL = 'brobond-segredos-v1';

function material(): string {
  return (
    process.env.SEGREDOS_ENCRYPTION_KEY ||
    process.env.APP_ENCRYPTION_KEY ||
    process.env.JWT_SECRET ||
    'brobond-dev-secret'
  );
}

let cache: { base: string; chave: Buffer } | null = null;

function chave(): Buffer {
  const base = material();
  if (!cache || cache.base !== base) cache = { base, chave: scryptSync(base, SAL, 32) };
  return cache.chave;
}

/** A instalação está usando um segredo dedicado ou caiu no fallback? */
export function chaveFraca(): boolean {
  return !process.env.SEGREDOS_ENCRYPTION_KEY && !process.env.APP_ENCRYPTION_KEY;
}

/** Cifra um segredo. Vazio/nulo entra e sai como `null`. */
export function cifrarSegredo(valor: string | null | undefined): string | null {
  const texto = String(valor ?? '');
  if (!texto) return null;
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', chave(), iv);
  const dados = Buffer.concat([cipher.update(texto, 'utf8'), cipher.final()]);
  return [
    'v1',
    iv.toString('base64url'),
    cipher.getAuthTag().toString('base64url'),
    dados.toString('base64url'),
  ].join('.');
}

/**
 * Decifra. Devolve `null` em qualquer problema (formato errado, tag inválida,
 * chave trocada) — nunca lança, para que uma credencial corrompida vire
 * "provedor não configurado" em vez de derrubar a requisição.
 */
export function decifrarSegredo(payload: string | null | undefined): string | null {
  if (!payload) return null;
  const [versao, iv, tag, dados] = String(payload).split('.');
  if (versao !== 'v1' || !iv || !tag || !dados) return null;
  try {
    const decipher = createDecipheriv('aes-256-gcm', chave(), Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(dados, 'base64url')), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

/** Já está cifrado neste formato? Evita cifrar duas vezes num update. */
export function pareceCifrado(valor: string | null | undefined): boolean {
  return /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(String(valor ?? ''));
}

/**
 * Máscara para exibir na tela sem revelar o segredo: só o tamanho e os
 * últimos 4 caracteres. Use SEMPRE isto em respostas de API.
 */
export function mascararSegredo(valor: string | null | undefined): string | null {
  const texto = String(valor ?? '');
  if (!texto) return null;
  if (texto.length <= 4) return '••••';
  return `${'•'.repeat(Math.min(12, texto.length - 4))}${texto.slice(-4)}`;
}
