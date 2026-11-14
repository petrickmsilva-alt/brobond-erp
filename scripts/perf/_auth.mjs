// ============================================================================
// AUTENTICAÇÃO PARA OS SCRIPTS DE PERFORMANCE — inclusive MFA/TOTP.
//
// O ERP exige MFA para administradores. Este módulo calcula o TOTP (RFC 6238,
// HMAC-SHA1, janela de 30 s, 6 dígitos) localmente a partir de `PERF_TOTP_SECRET`
// sem desabilitar MFA nem criar bypass de autenticação.
//
// EFEITOS COLATERAIS OPERACIONAIS DA AUTENTICAÇÃO (transparência obrigatória):
//   • `POST /api/auth/login` avalia credenciais, atualiza contadores de rate
//     limit e registra evento na trilha de auditoria de acesso;
//   • quando a conta exige segundo fator e `totpSegredo` é informado,
//     `POST /api/auth/login/mfa` valida o código TOTP, cria sessão autenticada
//     na tabela de sessões e grava auditoria de login MFA;
//   • em ambiente de teste onde o administrador ainda não concluiu o cadastro
//     inicial de MFA (`mfa_setup_required` e `totpSegredo` ausente), a chamada
//     a `POST /api/auth/mfa/desafio` seguida de `/api/auth/login/mfa` conclui
//     a ativação do MFA daquela conta técnica (em contas com MFA já ativo, o
//     servidor recusa `/mfa/desafio` e exige `PERF_TOTP_SECRET`).
//
// REGRAS DE SEGURANÇA E PRIVACIDADE:
//   • Utilize exclusivamente conta técnica autorizada para diagnóstico (nunca
//     conta pessoal de usuário real sem autorização explícita).
//   • Senha, token JWT, segredo TOTP, e-mail e cookies NUNCA são impressos em
//     mensagens de erro nem persistidos nos relatórios.
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
 * Faz login e devolve o token de sessão em memória (nunca impresso).
 *
 * `null` = credenciais ausentes (segue só com rotas públicas, sem sessão).
 */
export async function autenticar(base, { email, senha, totpSegredo } = {}) {
  if (!email || !senha) {
    return { token: null, publico: true, mfa: false, efeitosOperacionais: [] };
  }

  const post = async (caminho, corpo) => {
    const res = await fetch(`${base}${caminho}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(corpo),
      credentials: 'omit',
    });
    const dados = await res.json().catch(() => ({}));
    return { res, dados };
  };

  const primeiro = await post('/api/auth/login', { email, password: senha });
  if (!primeiro.res.ok) {
    throw new Error(`login falhou (HTTP ${primeiro.res.status}). Utilize uma conta técnica autorizada.`);
  }
  if (primeiro.dados.token) {
    return {
      token: primeiro.dados.token,
      publico: false,
      mfa: false,
      efeitosOperacionais: ['sessao_criada', 'auditoria_login'],
    };
  }

  const ticket = primeiro.dados.mfa_ticket;
  if (!ticket) throw new Error('login não devolveu token nem ticket de MFA.');

  const efeitos = ['desafio_mfa'];
  let segredo = totpSegredo || '';
  if (!segredo) {
    // Cadastro guiado (apenas contas técnicas recém-criadas sem MFA ativo).
    const desafio = await post('/api/auth/mfa/desafio', { mfa_ticket: ticket });
    if (!desafio.res.ok) {
      throw new Error(
        'MFA já está ativo e PERF_TOTP_SECRET não foi informado — impossível autenticar sem o segundo fator.'
      );
    }
    segredo = desafio.dados.segredo;
    efeitos.push('cadastro_mfa_guiado');
  }

  const codigo = gerarTotp(segredo);
  const segundo = await post('/api/auth/login/mfa', { mfa_ticket: ticket, codigo });
  if (!segundo.res.ok || !segundo.dados.token) {
    throw new Error(`segundo fator recusado (HTTP ${segundo.res.status}). Confira PERF_TOTP_SECRET.`);
  }
  efeitos.push('sessao_criada', 'auditoria_login_mfa');
  return {
    token: segundo.dados.token,
    publico: false,
    mfa: true,
    efeitosOperacionais: efeitos,
  };
}
