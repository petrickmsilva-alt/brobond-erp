// ============================================================================
// POLÍTICA DE ARQUIVOS (Fase 4.3 / ordem executiva, item 12)
//
// `GET /api/files/:id/:token` é uma URL de capacidade: quem tem o token acessa o
// arquivo. Isso é aceitável para fotos de catálogo (públicas por natureza), mas
// NÃO para comprovantes e outros anexos privados, que não podem receber cache
// público de longa duração nem ficar acessíveis só porque alguém conhece o token.
//
// Regras:
//   • PÚBLICO: somente recursos listados em RECURSOS_ARQUIVOS_PUBLICOS (fotos de
//     catálogo). Mantêm `Cache-Control: public` e a URL com token.
//   • PRIVADO: qualquer outro recurso, inclusive recurso desconhecido (fail-closed).
//     Exige URL ASSINADA (HMAC-SHA256) com expiração curta. Resposta sem cache
//     compartilhado (`private, no-store`). Sem assinatura válida → 404 uniforme,
//     para não revelar a existência do arquivo.
//   • A chave deriva do segredo de JWT já existente (sem variável nova). Em
//     produção sem JWT_SECRET, o segredo não existe e a assinatura falha fechada.
//   • A assinatura cobre id, token, variante (imagem/miniatura) e expiração: a URL
//     de um arquivo não serve para outro, nem a miniatura serve para o original.
// ============================================================================
import { createHmac, timingSafeEqual } from 'node:crypto';
import { segredoJwt } from './chavesCifra';

/** Recursos cujas fotos são de catálogo público (vitrine). Qualquer outro é privado. */
export const RECURSOS_ARQUIVOS_PUBLICOS: ReadonlySet<string> = new Set(['produtos']);

/** Validade máxima de uma URL privada assinada (15 min). Rejeita assinaturas com prazo maior. */
export const TTL_URL_PRIVADA_SEGUNDOS = 15 * 60;

export type VarianteArquivo = 'imagem' | 'miniatura';

export function arquivoEhPublico(recurso: string | null | undefined): boolean {
  return typeof recurso === 'string' && RECURSOS_ARQUIVOS_PUBLICOS.has(recurso);
}

function chaveAssinatura(): Buffer {
  // Subchave com rótulo próprio: a chave do JWT não é reutilizada diretamente.
  return createHmac('sha256', segredoJwt()).update('brobond:arquivos-url:v1').digest();
}

function mensagem(id: number, token: string, variante: VarianteArquivo, exp: number): string {
  return `${id}.${token}.${variante}.${exp}`;
}

/** Assinatura hexadecimal de (id, token, variante, expiração). */
export function assinarArquivo(id: number, token: string, variante: VarianteArquivo, exp: number): string {
  return createHmac('sha256', chaveAssinatura()).update(mensagem(id, token, variante, exp)).digest('hex');
}

/** Caminho relativo assinado para um arquivo privado. `agoraSegundos` é injetável em testes. */
export function caminhoArquivoPrivado(
  id: number,
  token: string,
  extensao: string,
  variante: VarianteArquivo,
  agoraSegundos: number = Math.floor(Date.now() / 1000)
): string {
  const exp = agoraSegundos + TTL_URL_PRIVADA_SEGUNDOS;
  const sig = assinarArquivo(id, token, variante, exp);
  const thumb = variante === 'miniatura' ? '&thumb=1' : '';
  return `/api/files/${id}/${token}.${extensao}?exp=${exp}&sig=${sig}${thumb}`;
}

/**
 * Verifica uma URL privada. Retorna false para qualquer defeito (ausente, malformada,
 * expirada, prazo maior que o TTL, assinatura divergente). Comparação em tempo constante.
 */
export function verificarArquivoPrivado(
  id: number,
  token: string,
  variante: VarianteArquivo,
  exp: unknown,
  sig: unknown,
  agoraSegundos: number = Math.floor(Date.now() / 1000)
): boolean {
  if (typeof sig !== 'string' || !/^[a-f0-9]{64}$/i.test(sig)) return false;
  const expNum = typeof exp === 'string' && /^\d{1,12}$/.test(exp) ? Number(exp) : NaN;
  if (!Number.isInteger(expNum)) return false;
  if (expNum <= agoraSegundos) return false; // expirada
  if (expNum - agoraSegundos > TTL_URL_PRIVADA_SEGUNDOS) return false; // prazo acima do permitido
  try {
    const esperado = Buffer.from(assinarArquivo(id, token, variante, expNum), 'hex');
    const recebido = Buffer.from(sig.toLowerCase(), 'hex');
    return esperado.length === recebido.length && timingSafeEqual(esperado, recebido);
  } catch {
    // Sem segredo (ex.: produção sem JWT_SECRET): nega sem vazar o motivo.
    return false;
  }
}
