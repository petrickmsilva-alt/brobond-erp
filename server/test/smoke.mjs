// Smoke test E2E do fluxo profissional de autenticação (modo demonstração).
import { execSync } from 'node:child_process';

const BASE = process.env.BASE || 'http://localhost:3101';
let falhas = 0;
function ok(cond, msg) {
  if (cond) console.log(`  ✅ ${msg}`);
  else {
    falhas++;
    console.log(`  ❌ ${msg}`);
  }
}

async function req(method, path, body, token) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

// TOTP: computa o código atual com os mesmos utilitários do servidor
const totpCode = (segredo) =>
  execSync(`node --import tsx -e "import('./src/totp.ts').then(m => console.log(m.codigoTOTP('${segredo}')))"`, { cwd: process.cwd() })
    .toString()
    .trim();

const adminEmail = 'admin@brobond.com.br';
const adminSenha = 'SmokeSenha#2026x';

// 0) garante admin com senha conhecida via ensureAdmin? O admin nasce com brobond123 + trocar_senha.
// Login passo 1
console.log('— Login do administrador (1º acesso: cadastro MFA obrigatório)');
let r = await req('POST', '/api/auth/login', { email: adminEmail, password: 'brobond123' });
ok(r.status === 200 && r.data.mfa_setup_required && r.data.mfa_ticket, 'mfa_setup_required + ticket');
const ticket = r.data.mfa_ticket;

// Desafio (QR + segredo)
r = await req('POST', '/api/auth/mfa/desafio', { mfa_ticket: ticket });
ok(r.status === 200 && r.data.segredo && r.data.qr.startsWith('data:image/'), `desafio devolve QR + segredo (${r.data.qr?.slice(0, 15)}...)`);
const segredoAdmin = r.data.segredo;
const codigo = totpCode(segredoAdmin);
ok(/^\d{6}$/.test(codigo), `código TOTP computado (${codigo})`);

// Conclui login com MFA
r = await req('POST', '/api/auth/login/mfa', { mfa_ticket: ticket, codigo });
ok(r.status === 200 && r.data.token, 'login/mfa emite token');
const adminToken = r.data.token;

// Próximo login pede mfa_required
r = await req('POST', '/api/auth/login', { email: adminEmail, password: 'brobond123' });
ok(r.data.mfa_required === true, '2º login do admin pede mfa_required');

// Troca a senha do admin (para não depender da padrão depois)
r = await req('POST', '/api/auth/change-password', { senha_atual: 'brobond123', senha_nova: adminSenha }, adminToken);
ok(r.status === 200, 'troca de senha própria OK (sessão atual preservada)');

// /auth/me
r = await req('GET', '/api/auth/me', null, adminToken);
ok(r.status === 200 && r.data.user?.perfil === 'admin', '/auth/me funciona com sessão');

// Cria usuário (convite)
console.log('— Convite de acesso');
r = await req('POST', '/api/usuarios', { nome: 'Maria Operadora', email: 'maria@smoke.com.br', perfil: 'operador' }, adminToken);
ok(r.status === 201 && r.data.convite_link, `usuário criado; convite_link devolvido (sem SMTP): ${!!r.data.convite_link}`);
const conviteToken = String(r.data.convite_link).split('/').pop();
r = await req('GET', `/api/convites/${conviteToken}`);
ok(r.status === 200 && r.data.email === 'maria@smoke.com.br' && !r.data.expirado, 'validação pública do convite');
r = await req('POST', '/api/convites/aceitar', { token: conviteToken, senha: 'Fumaca#2026Senha' });
ok(r.status === 200, 'convite aceito — senha definida pela própria usuária');

// Login da usuária (sem MFA — operador)
r = await req('POST', '/api/auth/login', { email: 'maria@smoke.com.br', password: 'Fumaca#2026Senha' });
ok(r.status === 200 && r.data.token && !r.data.mfa_required, 'operador entra sem MFA (não obrigatório)');
const mariaToken = r.data.token;
ok(!!(await req('GET', '/api/auth/sessoes', null, mariaToken)).data.sessoes?.length, 'sessão listada para a operadora');

// Senha temporária (admin reautenticado)
console.log('— Senha temporária de exibição única');
const mariaId = (await req('GET', '/api/auth/me', null, mariaToken)).data.user.id;
r = await req('POST', `/api/usuarios/${mariaId}/senha-temporaria`, {}, adminToken);
ok(r.status === 403 && r.data.code === 'reauth_necessaria', 'sem reautenticação → 403 reauth_necessaria');
r = await req('POST', '/api/auth/reautenticar', { senha: adminSenha }, adminToken);
ok(r.status === 200 && r.data.valido_ate, 'reautenticação do admin OK');
r = await req('POST', `/api/usuarios/${mariaId}/senha-temporaria`, {}, adminToken);
ok(r.status === 200 && r.data.senha_temporaria, `senha temporária exibida UMA vez (${r.data.senha_temporaria?.slice(0, 3)}***)`);
const senhaTemp = r.data.senha_temporaria;

// Sessão antiga da Maria morreu
r = await req('GET', '/api/auth/me', null, mariaToken);
ok(r.status === 401, 'sessão antiga da usuária foi derrubada pela senha temporária');

// Login com a senha temporária funciona
r = await req('POST', '/api/auth/login', { email: 'maria@smoke.com.br', password: senhaTemp });
ok(r.status === 200 && r.data.user?.trocar_senha === true, 'login com senha temporária marca troca obrigatória');

// Cofre removido
r = await req('POST', '/api/usuarios/1/revelar-senha', { adminPassword: 'x' }, adminToken);
ok(r.status === 404, '/api/usuarios/:id/revelar-senha → 404 (cofre removido)');

// Rate limit persistente
console.log('— Rate limit');
for (let i = 0; i < 5; i++) await req('POST', '/api/auth/login', { email: 'block@smoke.com.br', password: 'errada' });
r = await req('POST', '/api/auth/login', { email: 'block@smoke.com.br', password: 'errada' });
ok(r.status === 429, '6ª tentativa → 429 bloqueado');

// Auditoria segura
console.log('— Auditoria');
r = await req('GET', '/api/admin/auditoria/verificar', null, adminToken);
ok(r.status === 200 && r.data.ok === true, `cadeia de auditoria íntegra (${r.data.verificadas}/${r.data.total} eventos)`);

// Sessões: abre uma 2ª sessão do admin e revoga SOMENTE ela
console.log('— Sessões');
let r2fa = await req('POST', '/api/auth/login', { email: adminEmail, password: adminSenha });
let r2 = await req('POST', '/api/auth/login/mfa', { mfa_ticket: r2fa.data.mfa_ticket, codigo: totpCode(segredoAdmin) });
const segundoToken = r2.data.token;
ok(!!segundoToken, '2ª sessão do admin aberta');
r = await req('GET', '/api/auth/sessoes', null, adminToken);
ok(r.data.sessoes.length === 2, `duas sessões listadas (${r.data.sessoes.length})`);
const naoAtual = r.data.sessoes.find((s) => !s.atual);
r = await req('POST', `/api/auth/sessoes/${naoAtual.sid}/revogar`, {}, adminToken);
ok(r.status === 200, `revogação da sessão específica (${naoAtual.sid.slice(0, 8)})`);
r = await req('GET', '/api/auth/me', null, segundoToken);
ok(r.status === 401, 'sessão revogada não autentica mais');
r = await req('GET', '/api/auth/me', null, adminToken);
ok(r.status === 200, 'sessão atual sobrevive à revogação da outra');

// Logout do admin
r = await req('POST', '/api/auth/logout', {}, adminToken);
ok(r.status === 200, 'logout encerra a sessão atual');
r = await req('GET', '/api/auth/me', null, adminToken);
ok(r.status === 401, 'token do admin morre após logout');

console.log(falhas === 0 ? '\n🎉 SMOKE TEST: tudo passou!' : `\n💥 ${falhas} falha(s)`);
process.exit(falhas === 0 ? 0 : 1);
