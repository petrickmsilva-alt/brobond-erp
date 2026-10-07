// ============================================================================
// SMOKE TEST PONTA A PONTA — servidor Express real, HTTP de verdade.
//
// Os testes unitários chamam os handlers diretamente; nenhum deles cobre o boot
// do Express, o wiring de rotas nem a cadeia de middleware. Este script cobre
// exatamente esse vão (§21): superfícies da P1 e da P2 (gateway de pagamento,
// webhooks de entrada idempotentes, extrato OFX persistente, CNAB, comissões).
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

// ---------------------------------------------------------------- P2 §7/§8 gateway de pagamento (adapter + webhooks)
const provs = await req('GET', '/financeiro/gateway/providers');
check('GET /financeiro/gateway/providers', provs.status === 200, `status ${provs.status}`);

// Config é ação sensível: sem reautenticação recente, 403.
const cfgSemReauth = await req('PUT', '/financeiro/gateway/config', { provider: 'mock', ambiente: 'teste', credenciais: { fake: '1' } });
check('PUT gateway/config sem re-auth → 403', cfgSemReauth.status === 403, `status ${cfgSemReauth.status} code=${cfgSemReauth.json?.code}`);

const reauth = await req('POST', '/auth/reautenticar', { senha: SENHA_NOVA });
check('POST /auth/reautenticar', reauth.status === 200, `status ${reauth.status} ${msg(reauth.json)}`);

const cfgMock = await req('PUT', '/financeiro/gateway/config', { provider: 'mock', ambiente: 'teste', credenciais: { fake: '1' } });
check('PUT gateway/config com re-auth → 200', cfgMock.status === 200 && cfgMock.json?.tem_credenciais === true, `status ${cfgMock.status} ${msg(cfgMock.json)}`);

// Cobrança PIX: idempotente pela chave do chamador.
const chaveCob = `smoke-p2-${Date.now()}`;
const cob1 = await req('POST', '/financeiro/gateway/cobrancas', { provider: 'mock', metodo: 'pix', valor: 120, descricao: 'Smoke P2', payer_email: 'smoke@p2.dev', idempotency_key: chaveCob });
check('POST cobrança PIX → 201 + QR code', cob1.status === 201 && !!cob1.json?.cobranca?.qr_code, `status ${cob1.status} ${msg(cob1.json)}`);
const cob2 = await req('POST', '/financeiro/gateway/cobrancas', { provider: 'mock', metodo: 'pix', valor: 120, descricao: 'Smoke P2', payer_email: 'smoke@p2.dev', idempotency_key: chaveCob });
check('mesma chave → idempotente (mesma cobrança)', cob2.status === 200 && cob2.json?.idempotente === true && cob2.json?.cobranca?.id === cob1.json?.cobranca?.id, `status ${cob2.status}`);

// Webhook PÚBLICO de pagamento: processa UMA vez; a mesma notificação é duplicado.
const refCob = cob1.json?.cobranca?.provider_ref;
const wh1 = await req('POST', '/gateway/webhooks/mock', { event: 'payment.paid', data: { id: refCob }, status: 'pago' }, null);
check('webhook pago → processado', wh1.status === 200 && wh1.json?.processado === true, `status ${wh1.status} ${JSON.stringify(wh1.json || {}).slice(0, 80)}`);
const wh2 = await req('POST', '/gateway/webhooks/mock', { event: 'payment.paid', data: { id: refCob }, status: 'pago' }, null);
check('mesma notificação de novo → duplicado (sem 2ª baixa)', wh2.status === 200 && wh2.json?.duplicado === true, `status ${wh2.status}`);
const cobPaga = await req('GET', `/financeiro/gateway/cobrancas/${cob1.json?.cobranca?.id}`);
check('cobrança ficou paga', cobPaga.status === 200 && cobPaga.json?.cobranca?.status === 'paga', `status=${cobPaga.json?.cobranca?.status}`);
const evs = await req('GET', '/financeiro/gateway/webhooks');
check('eventos de webhook auditáveis', evs.status === 200 && (evs.json?.eventos || []).some((e) => e.status === 'processado'), `status ${evs.status}`);

// ---------------------------------------------------------------- P2 §5/§10 relatórios novos
const comissoes = await req('GET', '/financeiro/comissoes');
check('GET /financeiro/comissoes', comissoes.status === 200, `status ${comissoes.status}`);
const recebiveis = await req('GET', '/financeiro/cartao/recebiveis');
check('GET /financeiro/cartao/recebiveis', recebiveis.status === 200, `status ${recebiveis.status}`);

// ---------------------------------------------------------------- P2 §13 extrato persistente (OFX + FITID)
const conta = await req('POST', '/contas_financeiras', { nome: `Banco Smoke P2 ${Date.now()}`, tipo: 'banco', saldo_inicial: 0 });
check('POST conta financeira', [200, 201].includes(conta.status) && !!conta.json?.id, `status ${conta.status} ${msg(conta.json)}`);
const h = new Date();
const dOfx = `${h.getFullYear()}${String(h.getMonth() + 1).padStart(2, '0')}${String(h.getDate()).padStart(2, '0')}`;
const ofx = `OFXHEADER:100\nDATA:OFXSGML\n<OFX>\n<BANKTRANLIST>\n<STMTTRN>\n<TRNTYPE>CREDIT\n<DTPOSTED>${dOfx}120000\n<TRNAMT>555.55\n<FITID>SMOKE-FITID-${Date.now()}\n<NAME>Cliente Smoke\n</STMTTRN>\n</BANKTRANLIST>\n</OFX>`;
const imp1 = await req('POST', '/financeiro/extrato/importar', { texto: ofx, conta_id: conta.json?.id });
check('import OFX → 1 linha nova', [200, 201].includes(imp1.status) && imp1.json?.importadas === 1, `status ${imp1.status} ${msg(imp1.json)}`);
const imp2 = await req('POST', '/financeiro/extrato/importar', { texto: ofx, conta_id: conta.json?.id });
check('reimport OFX → FITID bloqueia duplicata', imp2.json?.importadas === 0 && imp2.json?.duplicadas === 1, `importadas=${imp2.json?.importadas} duplicadas=${imp2.json?.duplicadas}`);
const extrato = await req('GET', '/financeiro/extrato');
check('GET /financeiro/extrato', extrato.status === 200, `status ${extrato.status}`);

// ---------------------------------------------------------------- P2 §12 CNAB (adapter de parsers)
const parsers = await req('GET', '/financeiro/cnab/parsers');
check('GET /financeiro/cnab/parsers (cnab240 presente)', parsers.status === 200 && JSON.stringify(parsers.json || '').includes('cnab240'), `status ${parsers.status}`);

// ---------------------------------------------------------------- RBAC
const semToken = await req('GET', '/logistica/config', null, null);
check('sem token → 401', semToken.status === 401, `status ${semToken.status}`);

const ticketComoBearer = await req('GET', '/logistica/config', null, ticket);
check('ticket de MFA não vale como token de acesso → 401', ticketComoBearer.status === 401, `status ${ticketComoBearer.status}`);

console.log(out.join('\n'));
console.log(`\n${out.length - falhas}/${out.length} verificações OK`);
process.exit(falhas ? 1 : 0);
