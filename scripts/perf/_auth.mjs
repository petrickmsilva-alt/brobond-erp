// ============================================================================
// AUTENTICAÇÃO PARA OS SCRIPTS DE PERFORMANCE — inclusive MFA/TOTP.
//
// O ERP exige MFA para administradores. Sem isto, os scripts de medição só
// funcionariam com uma conta privilegiada sem segundo fator — o que seria uma
// péssima razão para enfraquecer a segurança. Aqui o TOTP (RFC 6238, HMAC-SHA1,
// 30 s, 6 dígitos) é calculado localmente a partir do segredo do usuário de
// TESTE, informado por variável de ambiente.
//
// O segredo MFA nunca é impresso nem incluído no relatório.
// ============================================================================
import { createHmac } from 'node:crypto';

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Decode(texto) {
  const limpo = String(texto || '').toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0;
  let valor = 0;
  const bytes = [];
  for (const ch of limpo) {
    valor = (valor << 5) | B32.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      bytes.push((valor >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/** Código TOTP de 6 dígitos para o instante atual (ou informado). */
export function gerarTotp(segredo, quando = Date.now()) {
  const chave = base32Decode(segredo);
  if (!chave.length) throw new Error('Segredo TOTP inválido.');
  const passo = Math.floor(quando / 1000 / 30);
  const buffer = Buffer.alloc(8);
  buffer.writeUInt32BE(Math.floor(passo / 2 ** 32), 0);
  buffer.writeUInt32BE(passo >>> 0, 4);
  const hmac = createHmac('sha1', chave).update(buffer).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const codigo =
    (((hmac[offset] & 0x7f) << 24) |
      ((hmac[offset + 1] & 0xff) << 16) |
      ((hmac[offset + 2] & 0xff) << 8) |
      (hmac[offset + 3] & 0xff)) %
    1_000_000;
  return String(codigo).padStart(6, '0');
}

/**
 * Faz login e devolve o token de sessão. Trata o fluxo real do ERP:
 *   • administrador sem MFA cadastrado → devolve `mfa_setup_required` +
 *     ticket; o script busca o segredo em `/auth/mfa/desafio` (quando
 *     `TOTP_SEGREDO` não foi informado) e conclui o cadastro;
 *   · MFA já ativo → usa `TOTP_SEGREDO` para responder ao desafio.
 *
 * `null` = credenciais ausentes (segue só com rotas públicas).
 * Lança erro com mensagem clara quando não é possível autenticar.
 */
export async function autenticar(base, { email, senha, totpSegredo } = {}) {
  if (!email || !senha) return { token: null, publico: true };

  const post = async (caminho, corpo) => {
    const res = await fetch(`${base}${caminho}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(corpo),
    });
    const dados = await res.json().catch(() => ({}));
    return { res, dados };
  };

  const primeiro = await post('/api/auth/login', { email, password: senha });
  if (!primeiro.res.ok) {
    throw new Error(`login falhou (HTTP ${primeiro.res.status}). Use uma conta de teste.`);
  }
  if (primeiro.dados.token) return { token: primeiro.dados.token, mfa: false };

  const ticket = primeiro.dados.mfa_ticket;
  if (!ticket) throw new Error('login não devolveu token nem ticket de MFA.');

  let segredo = totpSegredo || '';
  if (!segredo) {
    // Cadastro guiado: o próprio servidor devolve o segredo pendente.
    const desafio = await post('/api/auth/mfa/desafio', { mfa_ticket: ticket });
    if (!desafio.res.ok) {
      throw new Error(
        'MFA já está ativo e PERF_TOTP_SECRET não foi informado — impossível automatizar o segundo fator.'
      );
    }
    segredo = desafio.dados.segredo;
  }

  const codigo = gerarTotp(segredo);
  const segundo = await post('/api/auth/login/mfa', { mfa_ticket: ticket, codigo });
  if (!segundo.res.ok || !segundo.dados.token) {
    throw new Error(`segundo fator recusado (HTTP ${segundo.res.status}). Confira PERF_TOTP_SECRET.`);
  }
  return { token: segundo.dados.token, mfa: true };
}
