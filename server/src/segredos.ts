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
// Chave: SEGREDOS_ENCRYPTION_KEY (primária) ou, legado, derivada do JWT_SECRET
// (somente leitura). Em produção, defina SEGREDOS_ENCRYPTION_KEY — `chaveFraca()`
// avisa quando ela está faltando.
// ============================================================================
import { cifrarComDominio, decifrarComDominio } from './chavesCifra';

/** Chave de cifra vem de chavesCifra.ts (fonte única). Ver lá a regra de compatibilidade. */

/** A instalação está usando um segredo dedicado ou caiu no fallback? */
export function chaveFraca(): boolean {
  return !process.env.SEGREDOS_ENCRYPTION_KEY && !process.env.APP_ENCRYPTION_KEY;
}

/** Cifra um segredo. Vazio/nulo entra e sai como `null`. Lança sem chave em produção. */
export function cifrarSegredo(valor: string | null | undefined): string | null {
  const texto = String(valor ?? '');
  if (!texto) return null;
  return cifrarComDominio(texto, 'segredos');
}

/**
 * Decifra. Devolve `null` em qualquer problema (formato errado, tag inválida,
 * chave trocada) — nunca lança, para que uma credencial corrompida vire
 * "provedor não configurado" em vez de derrubar a requisição.
 */
export function decifrarSegredo(payload: string | null | undefined): string | null {
  if (!payload) return null;
  return decifrarComDominio(String(payload), 'segredos');
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
