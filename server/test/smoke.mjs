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
ok(Array.isArray(r.data.mfa_backup_codigos) && r.data.mfa_backup_codigos.length === 10, '1ª ativação emite 10 códigos de recuperação');
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

// Onda 3: códigos de recuperação, bloqueio manual, revogação pontual, série e export
console.log('— Onda 3: códigos, bloqueio, série e lote');
r = await req('GET', '/api/auth/mfa/status', null, adminToken);
ok(r.data.ativado === true && r.data.backup_restantes === 10, `status MFA informa 10 códigos restantes (${r.data.backup_restantes})`);
r = await req('POST', '/api/auth/mfa/codigos', {}, adminToken);
ok(Array.isArray(r.data.codigos) && r.data.codigos.length === 10 && /^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(r.data.codigos[0]), 'regeneração de códigos devolve lote novo no formato XXXX-XXXX');
const loteNovo = r.data.codigos;
r2fa = await req('POST', '/api/auth/login', { email: adminEmail, password: adminSenha });
r2 = await req('POST', '/api/auth/login/mfa', { mfa_ticket: r2fa.data.mfa_ticket, codigo: loteNovo[0] });
ok(r2.status === 200 && !!r2.data.token && r2.data.mfa_backup_restantes === 9, 'login com código de recuperação consome 1 uso (restam 9)');
const backupToken = r2.data.token;
r2fa = await req('POST', '/api/auth/login', { email: adminEmail, password: adminSenha });
r2 = await req('POST', '/api/auth/login/mfa', { mfa_ticket: r2fa.data.mfa_ticket, codigo: loteNovo[0] });
ok(r2.status === 401, 'código de recuperação usado não vale de novo');

// Bloqueio manual da operadora (reautentica de novo por segurança)
r = await req('POST', '/api/auth/reautenticar', { senha: adminSenha }, adminToken);
ok(r.status === 200, 'reautenticação renovada para o bloqueio');
r = await req('POST', `/api/usuarios/${mariaId}/bloquear`, { motivo: 'Suspeita de fraude (smoke)' }, adminToken);
ok(r.status === 200 && r.data.manual === true, 'bloqueio manual sem prazo aplicado');
r = await req('POST', '/api/auth/login', { email: 'maria@smoke.com.br', password: senhaTemp });
ok(r.status === 403 && /bloqueado pelo administrador: Suspeita de fraude/.test(r.data.error || ''), 'login bloqueado cita o motivo');
r = await req('POST', `/api/usuarios/${mariaId}/desbloquear`, {}, adminToken);
ok(r.status === 200, 'desbloqueio libera a conta');
r = await req('POST', '/api/auth/login', { email: 'maria@smoke.com.br', password: senhaTemp });
ok(r.status === 200 && !!r.data.token, 'operadora entra após o desbloqueio');
const maria0 = r.data.token;
const mariaA = (await req('POST', '/api/auth/login', { email: 'maria@smoke.com.br', password: senhaTemp })).data.token;
const mariaB = (await req('POST', '/api/auth/login', { email: 'maria@smoke.com.br', password: senhaTemp })).data.token;

// Revogação pontual: só UMA das sessões da operadora cai
r = await req('GET', '/api/auth/sessoes', null, mariaA);
const antes = (r.data.sessoes || []).length;
ok(antes >= 3, `operadora com várias sessões abertas (${antes})`);
const sidAlvo = (r.data.sessoes || []).find((x) => !x.atual)?.sid;
r = await req('POST', `/api/usuarios/${mariaId}/sessoes/${sidAlvo}/encerrar`, {}, adminToken);
ok(r.status === 200 && r.data.sessoes_restantes === antes - 1, `admin revoga 1 sessão da operadora (restam ${r.data.sessoes_restantes})`);
r = await req('GET', '/api/auth/sessoes', null, mariaA);
ok(r.status === 200 && (r.data.sessoes || []).length === antes - 1, 'relistagem confirma: só a escolhida caiu');
r = await req('GET', '/api/auth/me', null, backupToken);
ok(r.status === 200, 'sessão via código de recuperação segue válida');

// Série de acessos + export da seleção
r = await req('GET', '/api/usuarios/resumo', null, adminToken);
ok(r.status === 200 && Array.isArray(r.data.serie_logins_7d) && r.data.serie_logins_7d.length === 7, 'resumo traz a série de 7 dias');
ok((r.data.totais?.falhas_24h ?? 0) >= 1, `falhas de login das 24h contabilizadas (${r.data.totais?.falhas_24h})`);
const expRes = await fetch(`${BASE}/api/usuarios/export?format=csv&ids=${mariaId}`, { headers: { Authorization: `Bearer ${adminToken}` } });
const expTxt = await expRes.text();
ok(expRes.status === 200 && expTxt.includes('maria@smoke.com.br') && !expTxt.includes('senha_hash'), 'export ?ids= traz só a seleção, sem segredos');

// Onda 4: política de senha, webhooks, certificação, XLSX da seleção
console.log('— Onda 4: política, webhooks, certificação');
r = await req('GET', '/api/auth/politica-senha');
ok(r.status === 200 && r.data.politica?.tamanho_minimo === 8, 'regras públicas da política (sem login)');
r = await req('GET', '/api/usuarios/politica-senha', null, adminToken);
ok(r.status === 200 && r.data.politica?.historico_qtd === 0 && !!r.data.limites, 'política completa + limites (admin)');
r = await req('POST', '/api/auth/reautenticar', { senha: adminSenha }, adminToken);
ok(r.status === 200, 'reautenticação renovada para a Onda 4');
r = await req('PUT', '/api/usuarios/politica-senha', { tamanho_minimo: 3 }, adminToken);
ok(r.status === 400, 'política inválida rejeitada (mínimo < 6)');
r = await req('PUT', '/api/usuarios/politica-senha', { tamanho_minimo: 10, exigir_numero: true, historico_qtd: 2, expiracao_dias: 90 }, adminToken);
ok(r.status === 200 && r.data.politica?.tamanho_minimo === 10, 'política válida gravada');

// Webhooks: cria (URL morta), testa, evento real entrega, reenvia, exclui
r = await req('POST', '/api/webhooks', { nome: 'Smoke SIEM', url: 'http://127.0.0.1:9/hook', eventos: ['usuario.bloqueado'] }, adminToken);
ok(r.status === 201 && !!r.data.segredo && r.data.tem_segredo === true, 'webhook criado; segredo devolvido uma vez');
const hookId = r.data.id;
r = await req('GET', '/api/webhooks', null, adminToken);
const hookListado = (r.data.webhooks || []).find((w) => w.id === hookId);
ok(r.status === 200 && !!hookListado && hookListado.segredo === undefined && hookListado.segredo_cifrado === undefined, 'lista traz o webhook sem o segredo');
r = await req('POST', `/api/webhooks/${hookId}/testar`, {}, adminToken);
ok(r.status === 200 && r.data.ok === false && !!r.data.entrega_id, 'teste contra URL morta registra falha');
r = await req('POST', `/api/usuarios/${mariaId}/bloquear`, { motivo: 'Smoke Onda 4' }, adminToken);
ok(r.status === 200, 'bloqueio dispara evento para o webhook');
let entregas = 0;
for (let i = 0; i < 30 && entregas < 2; i++) {
  await new Promise((okSleep) => setTimeout(okSleep, 100));
  entregas = (await req('GET', `/api/webhooks/${hookId}/entregas`, null, adminToken)).data.total;
}
ok(entregas >= 2, `evento real entregue (log com ${entregas})`);
r = await req('GET', `/api/webhooks/${hookId}/entregas?estado=ok`, null, adminToken);
ok((r.data.entregas || []).length === 0, 'filtro estado=ok vazio (tudo falhou na URL morta)');
const entregaErro = (await req('GET', `/api/webhooks/${hookId}/entregas`, null, adminToken)).data.entregas[0].id;
r = await req('POST', `/api/webhooks/entregas/${entregaErro}/reenviar`, {}, adminToken);
ok(r.status === 200 && r.data.tentativas === 2, 'reenvio conta a 2ª tentativa');
r = await req('POST', `/api/usuarios/${mariaId}/desbloquear`, {}, adminToken);
ok(r.status === 200, 'desbloqueio (evento não assinado não gera entrega)');
r = await req('DELETE', `/api/webhooks/${hookId}`, {}, adminToken);
ok(r.status === 200, 'webhook excluído');
r = await req('GET', '/api/webhooks', null, adminToken);
ok(!(r.data.webhooks || []).some((w) => w.id === hookId), 'sumiu da lista');

// Certificação: carimba, matriz reflete, quatro olhos vale, exporta
r = await req('POST', `/api/usuarios/${mariaId}/certificar`, { observacao: 'Smoke: revisão OK' }, adminToken);
ok(r.status === 200 && !!r.data.certificado_em, 'acesso certificado com observação');
r = await req('GET', '/api/usuarios/certificacao', null, adminToken);
const linhaMaria = (r.data.linhas || []).find((l) => l.id === mariaId);
ok(r.status === 200 && linhaMaria && linhaMaria.precisa_recertificar === false && linhaMaria.certificado_por, 'matriz mostra Maria certificada');
r = await req('POST', '/api/usuarios/1/certificar', {}, adminToken);
ok(r.status === 400, 'ninguém certifica o próprio acesso');
const certRes = await fetch(`${BASE}/api/usuarios/certificacao/export?format=csv`, { headers: { Authorization: `Bearer ${adminToken}` } });
ok(certRes.status === 200 && (await certRes.text()).includes('maria@smoke.com.br'), 'export da matriz em CSV');
const xlsxRes = await fetch(`${BASE}/api/usuarios/export?format=xlsx&ids=${mariaId}`, { headers: { Authorization: `Bearer ${adminToken}` } });
const xlsxBuf = Buffer.from(await xlsxRes.arrayBuffer());
ok(xlsxRes.status === 200 && xlsxBuf[0] === 0x50 && xlsxBuf[1] === 0x4b, 'export XLSX da seleção (arquivo zip válido)');

// Restaura a política padrão (não vazar estado para o logout/auditoria final)
r = await req('PUT', '/api/usuarios/politica-senha', { tamanho_minimo: 8, exigir_maiuscula_minuscula: false, exigir_numero: false, exigir_simbolo: false, proibir_obvias: true, historico_qtd: 0, expiracao_dias: 0 }, adminToken);
ok(r.status === 200, 'política padrão restaurada');

// Logout do admin
r = await req('POST', '/api/auth/logout', {}, adminToken);
ok(r.status === 200, 'logout encerra a sessão atual');
r = await req('GET', '/api/auth/me', null, adminToken);
ok(r.status === 401, 'token do admin morre após logout');

console.log(falhas === 0 ? '\n🎉 SMOKE TEST: tudo passou!' : `\n💥 ${falhas} falha(s)`);
process.exit(falhas === 0 ? 0 : 1);
