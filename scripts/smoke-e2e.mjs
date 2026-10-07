// ============================================================================
// SMOKE TEST PONTA A PONTA — servidor Express real, HTTP de verdade.
//
// Os testes unitários chamam os handlers diretamente; nenhum deles cobre o boot
// do Express, o wiring de rotas nem a cadeia de middleware. Este script cobre
// exatamente esse vão (§21).
//
// O admin recém-criado chega com MFA pendente E senha provisória. As duas travas
// existem de propósito — `bloquearSenhaProvisoria` (server/src/security.ts)
// recusa toda escrita enquanto `trocar_senha` estiver ligado. O script percorre
// o fluxo real de acesso (cadastro TOTP → troca de senha → relogin) e só então
// testa as superfícies da P1.
//
// Uso:
//   PORT=3001 npx tsx server/src/index.ts &
//   node scripts/smoke-e2e.mjs
//
// Requer um servidor em MODO DEMONSTRAÇÃO (sem DATABASE_URL) recém-subido, com
// o admin padrão ainda sem MFA. Sai com código 1 se qualquer verificação falhar.
// ============================================================================
import { createHmac } from 'node:crypto';

const BASE = process.env.SMOKE_BASE || 'http://127.0.0.1:3001/api';
const EMAIL = process.env.SMOKE_EMAIL || 'admin@brobond.com.br';
const SENHA_INICIAL = process.env.SMOKE_SENHA || 'brobond123';
const SENHA_NOVA = process.env.SMOKE_SENHA_NOVA || 'Brobond#2026SenhaForte';

const out = [];
let falhas = 0;
let token = null;

function check(nome, cond, extra = '') {
  if (!cond) falhas++;
  out.push(`${cond ? 'PASS' : 'FAIL'}  ${nome}${extra ? '  — ' + extra : ''}`);
}

async function req(method, path, body, bearer = token) {
  const r = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await r.json(); } catch { /* corpo vazio */ }
  return { status: r.status, json };
}

const msg = (j) => String(j?.erro || j?.error || '').slice(0, 70);

// ---------------------------------------------------------------- TOTP (RFC 6238)
function base32Decode(s) {
  const ALFA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0, valor = 0;
  const bytes = [];
  for (const ch of String(s).replace(/=+$/, '').toUpperCase()) {
    const v = ALFA.indexOf(ch);
    if (v < 0) continue;
    valor = (valor << 5) | v;
    bits += 5;
    if (bits >= 8) { bytes.push((valor >>> (bits - 8)) & 0xff); bits -= 8; }
  }
  return Buffer.from(bytes);
}

function totp(segredo) {
  const contador = Math.floor(Date.now() / 1000 / 30);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(contador));
  const h = createHmac('sha1', base32Decode(segredo)).update(buf).digest();
  const off = h[h.length - 1] & 0x0f;
  const cod = ((h[off] & 0x7f) << 24 | h[off + 1] << 16 | h[off + 2] << 8 | h[off + 3]) % 1e6;
  return String(cod).padStart(6, '0');
}

// ---------------------------------------------------------------- acesso
const login1 = await req('POST', '/auth/login', { email: EMAIL, password: SENHA_INICIAL }, null);
check('POST /auth/login exige MFA do admin', login1.json?.mfa_setup_required === true, `status ${login1.status}`);

const ticket = login1.json?.mfa_ticket;
// O cadastro pré-login é /auth/mfa/desafio com o ticket no CORPO: o ticket tem
// typ:'mfa' e requireAuth o recusa como Bearer (server/src/auth.ts).
const setup = await req('POST', '/auth/mfa/desafio', { mfa_ticket: ticket }, null);
check('POST /auth/mfa/desafio (cadastro TOTP)', setup.status === 200 && !!setup.json?.segredo, `status ${setup.status}`);
const segredo = setup.json?.segredo;

const mfa = await req('POST', '/auth/login/mfa', { mfa_ticket: ticket, codigo: totp(segredo) }, null);
token = mfa.json?.token;
check('POST /auth/login/mfa → token (TOTP real)', !!token, `status ${mfa.status}`);

// A senha provisória bloqueia escrita — comportamento de segurança esperado.
const antesDaTroca = await req('POST', '/pdv/caixas', { valor_abertura: 100 });
check('senha provisória bloqueia escrita (SENHA_PROVISORIA)',
  antesDaTroca.status === 403 && antesDaTroca.json?.code === 'SENHA_PROVISORIA',
  `status ${antesDaTroca.status} code=${antesDaTroca.json?.code}`);

const troca = await req('POST', '/auth/change-password', { senha_atual: SENHA_INICIAL, senha_nova: SENHA_NOVA });
check('POST /auth/change-password', troca.status === 200, `status ${troca.status} ${msg(troca.json)}`);

const login2 = await req('POST', '/auth/login', { email: EMAIL, password: SENHA_NOVA }, null);
const mfa2 = await req('POST', '/auth/login/mfa', { mfa_ticket: login2.json?.mfa_ticket, codigo: totp(segredo) }, null);
token = mfa2.json?.token;
check('relogin com senha definitiva + MFA', !!token, `status ${mfa2.status}`);

// ---------------------------------------------------------------- §6 listas de preço
const listas = await req('GET', '/listas_preco?page=1&pageSize=5');
check('GET /listas_preco', listas.status === 200 && Array.isArray(listas.json?.rows), `status ${listas.status}`);

const novaLista = await req('POST', '/listas_preco', {
  nome: 'Atacado SP', tipo: 'percentual', valor: -10, prioridade: 10,
  vigente_de: '2026-01-01', vigente_ate: '2026-12-31', ativa: true,
});
check('POST /listas_preco', [200, 201].includes(novaLista.status), `status ${novaLista.status} ${msg(novaLista.json)}`);

// ---------------------------------------------------------------- §7 propostas
const propostas = await req('GET', '/propostas?page=1&pageSize=5');
check('GET /propostas', propostas.status === 200, `status ${propostas.status}`);

// ---------------------------------------------------------------- §8 PDV
const caixaAberto = await req('GET', '/pdv/caixas/aberto');
check('GET /pdv/caixas/aberto', caixaAberto.status === 200 && 'caixa' in (caixaAberto.json || {}), `status ${caixaAberto.status}`);

const caixa = await req('POST', '/pdv/caixas', { valor_abertura: 200 });
check('POST /pdv/caixas → 201', caixa.status === 201, `status ${caixa.status} ${msg(caixa.json)}`);

// Caixa aberto é único por empresa — abrir de novo deve dar 409.
const caixa2 = await req('POST', '/pdv/caixas', { valor_abertura: 300 });
check('segundo caixa aberto → 409', caixa2.status === 409, `status ${caixa2.status}`);

// ---------------------------------------------------------------- §13 logística
const cfgLog = await req('GET', '/logistica/config');
check('GET /logistica/config', cfgLog.status === 200 && Array.isArray(cfgLog.json?.provedores),
  `provedores=${JSON.stringify((cfgLog.json?.provedores || []).map((p) => p.slug))}`);

const semCred = await req('PUT', '/logistica/config', { provider: 'melhor_envio' });
check('ativar Melhor Envio sem credencial → 409', semCred.status === 409, `status ${semCred.status}: ${msg(semCred.json)}`);

const manual = await req('PUT', '/logistica/config', { provider: 'manual', cep_origem: '74000000' });
check('ativar provedor manual → 200', manual.status === 200, `status ${manual.status}`);

const envios = await req('GET', '/envios?page=1&pageSize=5');
check('GET /envios', envios.status === 200, `status ${envios.status}`);

// ---------------------------------------------------------------- §14 / §15 / §16 / §17
const divs = await req('GET', '/expedicao/divergencias?page=1&pageSize=5');
check('GET /expedicao/divergencias', divs.status === 200, `status ${divs.status}`);

const devs = await req('GET', '/devolucoes?page=1&pageSize=5');
check('GET /devolucoes', devs.status === 200 && Array.isArray(devs.json?.rows), `status ${devs.status}`);

const compras = await req('GET', '/compras?page=1&pageSize=5');
check('GET /compras', compras.status === 200, `status ${compras.status}`);

const sug = await req('GET', '/suprimentos/sugestao-compra');
check('GET /suprimentos/sugestao-compra nunca é automática', sug.status === 200 && sug.json?.automatico === false,
  `automatico=${sug.json?.automatico}, itens=${sug.json?.total_itens}`);

// ---------------------------------------------------------------- RBAC
const semToken = await req('GET', '/logistica/config', null, null);
check('sem token → 401', semToken.status === 401, `status ${semToken.status}`);

const ticketComoBearer = await req('GET', '/logistica/config', null, ticket);
check('ticket de MFA não vale como token de acesso → 401', ticketComoBearer.status === 401, `status ${ticketComoBearer.status}`);

console.log(out.join('\n'));
console.log(`\n${out.length - falhas}/${out.length} verificações OK`);
process.exit(falhas ? 1 : 0);
