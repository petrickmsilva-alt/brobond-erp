// UX-05 — provisiona o estado de teste no modo demonstração (dados em memória).
//
// O modo demo zera tudo a cada reinício do servidor. Este script recria o que os
// testes de browser precisam: admin com MFA ativo, os perfis GERENTE e OPERADOR,
// uma segunda empresa e as concessões de acesso multiempresa.
//
// Uso:
//   node scripts/ux05-fixtures.mjs
// Saída: exporta as variáveis de ambiente que os scripts de check consomem.
import { createHmac } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { totpAgora } from './ux05-totp.mjs';

const API = process.env.UX05_API || 'http://localhost:3001';
const ADMIN_EMAIL = 'admin@brobond.com.br';
const ADMIN_INICIAL = process.env.ADMIN_PASSWORD || 'brobond123';
const SENHA_NOVA = process.env.UX05_PASS || process.env.UX05_SENHA_NOVA;
const SENHA_TEMP_FIXA = process.env.UX05_SENHA_PERFIL || SENHA_NOVA;
if (!SENHA_NOVA) {
  console.error('❌ Defina UX05_PASS (senha de teste do admin) antes de provisionar.');
  process.exit(1);
}

const chamar = async (metodo, caminho, corpo, token) => {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const r = await fetch(`${API}${caminho}`, {
    method: metodo,
    headers,
    body: corpo === undefined ? undefined : JSON.stringify(corpo),
  });
  let dados = null;
  try {
    dados = await r.json();
  } catch {
    /* sem corpo */
  }
  return { status: r.status, dados };
};

/** CNPJ sintaticamente válido (dígitos verificadores corretos). */
function cnpjValido(base12) {
  const nums = base12.split('');
  for (const pesos of [
    [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2],
    [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2],
  ]) {
    const soma = nums.reduce((acc, n, i) => acc + Number(n) * pesos[i], 0);
    const resto = soma % 11;
    nums.push(resto < 2 ? '0' : String(11 - resto));
  }
  return nums.join('');
}

// ---------------------------------------------------------------------------
// 1. Admin: primeiro login (setup de MFA) → ativa TOTP → troca a senha padrão.
// ---------------------------------------------------------------------------
const passo1 = await chamar('POST', '/api/auth/login', { email: ADMIN_EMAIL, password: ADMIN_INICIAL });
if (passo1.status !== 200 || !passo1.dados?.mfa_ticket) {
  console.error('❌ Login inicial do admin falhou:', passo1.status, passo1.dados);
  process.exit(1);
}
const ticket = passo1.dados.mfa_ticket;

let segredo = null;
if (passo1.dados.mfa_setup_required) {
  const desafio = await chamar('POST', '/api/auth/mfa/desafio', { mfa_ticket: ticket });
  if (desafio.status !== 200) {
    console.error('❌ Desafio MFA falhou:', desafio.status, desafio.dados);
    process.exit(1);
  }
  segredo = desafio.dados.segredo;
  writeFileSync('/tmp/segredo.txt', segredo);
  console.log('✅ Segredo TOTP do admin gerado → /tmp/segredo.txt');
} else {
  // MFA já ativo: o segredo veio de uma execução anterior.
  segredo = process.env.UX05_TOTP_SECRET || readFileSync('/tmp/segredo.txt', 'utf8').trim();
}
process.env.UX05_TOTP_SECRET = segredo;

const passo2 = await chamar('POST', '/api/auth/login/mfa', { mfa_ticket: ticket, codigo: totpAgora() });
if (passo2.status !== 200 || !passo2.dados?.token) {
  console.error('❌ Segundo fator falhou:', passo2.status, passo2.dados);
  process.exit(1);
}
let tokenAdmin = passo2.dados.token;
console.log('✅ Admin autenticado (MFA ativo)');

// Troca da senha padrão (obrigatória no primeiro acesso).
if (passo2.dados.user?.trocar_senha || passo2.dados.trocar_senha) {
  const troca = await chamar('POST', '/api/auth/change-password', { senha_atual: ADMIN_INICIAL, senha_nova: SENHA_NOVA }, tokenAdmin);
  if (troca.status !== 200) {
    console.error('❌ Troca de senha do admin falhou:', troca.status, troca.dados);
    process.exit(1);
  }
  // A sessão antiga é invalidada; refaz o login completo.
  const l1 = await chamar('POST', '/api/auth/login', { email: ADMIN_EMAIL, password: SENHA_NOVA });
  const l2 = await chamar('POST', '/api/auth/login/mfa', { mfa_ticket: l1.dados.mfa_ticket, codigo: totpAgora() });
  tokenAdmin = l2.dados.token;
  console.log('✅ Senha do admin definida e sessão renovada');
}

// ---------------------------------------------------------------------------
// 2. Segunda empresa + concessão de acesso ao admin (multiempresa).
// ---------------------------------------------------------------------------
const empresas = await chamar('GET', '/api/empresas?pageSize=50', undefined, tokenAdmin);
const temFilial = (empresas.dados?.rows || []).some((e) => e.id === 2);
if (!temFilial) {
  const criar = await chamar(
    'POST',
    '/api/empresas',
    {
      nome: 'BROBOND FILIAL',
      razao_social: 'BROBOND CONFECCOES LTDA FILIAL',
      cnpj: cnpjValido('123456780002'),
      ativo: true,
    },
    tokenAdmin
  );
  console.log(
    criar.status < 300 ? '✅ Empresa filial criada (id 2)' : `⚠️  Empresa filial: ${criar.status} ${JSON.stringify(criar.dados)}`
  );
}
const conceder = await chamar('POST', '/api/usuarios/1/empresas', { empresa_id: 2 }, tokenAdmin);
console.log(conceder.status < 300 ? '✅ Acesso do admin à filial concedido' : `⚠️  Concessão: ${conceder.status}`);

// ---------------------------------------------------------------------------
// 3. Perfis GERENTE e OPERADOR com senha conhecida.
// ---------------------------------------------------------------------------
async function garantirPerfil(email, nome, perfil) {
  const lista = await chamar('GET', `/api/usuarios?pageSize=200&filter[email]=${encodeURIComponent(email)}`, undefined, tokenAdmin);
  const existente = (lista.dados?.rows || []).find((u) => String(u.email).toLowerCase() === email.toLowerCase());
  let id = existente?.id;
  if (!id) {
    const criar = await chamar('POST', '/api/usuarios', { nome, email, perfil, ativo: true, empresa_id: 1 }, tokenAdmin);
    if (criar.status >= 300) {
      console.error(`❌ Criar ${perfil}:`, criar.status, criar.dados);
      return null;
    }
    id = criar.dados?.id || criar.dados?.row?.id;
    console.log(`✅ Usuário ${perfil} criado (id ${id})`);
  } else {
    console.log(`ℹ️  Usuário ${perfil} já existe (id ${id})`);
  }

  // Reautenticação exigida para gerar senha temporária.
  await chamar('POST', '/api/auth/reautenticar', { senha: SENHA_NOVA }, tokenAdmin);
  const temp = await chamar('POST', `/api/usuarios/${id}/senha-temporaria`, {}, tokenAdmin);
  const senhaTemp = temp.dados?.senha_temporaria;
  if (!senhaTemp) {
    console.error(`❌ Senha temporária de ${perfil} falhou:`, temp.status, temp.dados);
    return id;
  }
  // Define uma senha estável: login com a provisória + troca.
  const l1 = await chamar('POST', '/api/auth/login', { email, password: senhaTemp });
  if (!l1.dados?.token) {
    console.error(`❌ Login provisório de ${perfil} falhou:`, l1.status, l1.dados);
    return id;
  }
  const troca = await chamar('POST', '/api/auth/change-password', { senha_atual: senhaTemp, senha_nova: SENHA_TEMP_FIXA }, l1.dados.token);
  if (troca.status >= 300) {
    console.error(`❌ Troca de senha de ${perfil} falhou:`, troca.status, troca.dados);
  } else {
    console.log(`✅ ${perfil}: senha estável definida`);
  }
  return id;
}

const idGerente = await garantirPerfil('gerente@brobond.com.br', 'Gerente Teste', 'gerente');
const idOperador = await garantirPerfil('operador@brobond.com.br', 'Operador Teste', 'operador');

console.log('\n--- Variáveis para os scripts de check ---');
console.log(`export UX05_TOTP_SECRET_FILE=/tmp/segredo.txt`);
console.log(`export UX05_PASS='${SENHA_NOVA}'`);
console.log(`export UX05_SENHA_GERENTE='${SENHA_TEMP_FIXA}'`);
console.log(`export UX05_SENHA_OPERADOR='${SENHA_TEMP_FIXA}'`);
console.log(
  `export UX05_ESPERADO='{"GERENTE":{"proibidos":["/empresas","/usuarios","/auditoria"]},"OPERADOR":{"proibidos":["/empresas","/usuarios","/auditoria","/politicas-comerciais"]}}'`
);
console.log(`\nids: gerente=${idGerente} operador=${idOperador}`);
