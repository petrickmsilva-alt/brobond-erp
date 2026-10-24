#!/usr/bin/env node
// ============================================================================
// SMOKE — DIAGNÓSTICO DE VÍNCULOS ANTES DA EXCLUSÃO (HTTP real, modo demo).
//
// Os testes unitários chamam o serviço; este script sobe o Express de verdade e
// confirma o que o navegador verá:
//   • GET  /api/:resource/:id/dependencias  → payload com módulos/ids;
//   • DELETE sem vínculos                  → 200 e o registro sai;
//   • DELETE com vínculos                  → 409, code 'dependencias_vinculadas'
//                                            e details.dependencias;
//   • nada é apagado quando o DELETE é bloqueado.
//
// Uso (servidor recém-subido em MODO DEMONSTRAÇÃO, sem DATABASE_URL):
//   PORT=3011 npx tsx server/src/index.ts &
//   node scripts/smoke-dependencias.mjs
// ============================================================================
import { createHmac } from 'node:crypto';

const BASE = process.env.SMOKE_BASE || 'http://127.0.0.1:3011/api';
const EMAIL = process.env.SMOKE_EMAIL || 'admin@brobond.com.br';
const SENHA_INICIAL = process.env.SMOKE_SENHA || 'brobond123';
const SENHA_NOVA = process.env.SMOKE_SENHA_NOVA || 'Brobond#2026SenhaForte';

let falhas = 0;
let token = null;
const out = [];

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
  try {
    json = await r.json();
  } catch {
    /* corpo vazio */
  }
  return { status: r.status, json };
}

// ---------------------------------------------------------------- TOTP (RFC 6238)
function base32Decode(s) {
  const ALFA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let valor = 0;
  const bytes = [];
  for (const ch of String(s).replace(/=+$/, '').toUpperCase()) {
    const v = ALFA.indexOf(ch);
    if (v < 0) continue;
    valor = (valor << 5) | v;
    bits += 5;
    if (bits >= 8) {
      bytes.push((valor >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

function totp(segredo) {
  const contador = Math.floor(Date.now() / 1000 / 30);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(contador));
  const h = createHmac('sha1', base32Decode(segredo)).update(buf).digest();
  const off = h[h.length - 1] & 0x0f;
  const cod = (((h[off] & 0x7f) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3]) % 1e6;
  return String(cod).padStart(6, '0');
}

// ---------------------------------------------------------------- acesso
const login1 = await req('POST', '/auth/login', { email: EMAIL, password: SENHA_INICIAL }, null);
const ticket = login1.json?.mfa_ticket;
const setup = await req('POST', '/auth/mfa/desafio', { mfa_ticket: ticket }, null);
const segredo = setup.json?.segredo;
const mfa = await req('POST', '/auth/login/mfa', { mfa_ticket: ticket, codigo: totp(segredo) }, null);
token = mfa.json?.token;
check('acesso: token emitido', !!token, `status ${mfa.status}`);

const troca = await req('POST', '/auth/change-password', { senha_atual: SENHA_INICIAL, senha_nova: SENHA_NOVA });
check('acesso: senha definitiva', troca.status === 200, `status ${troca.status}`);
const login2 = await req('POST', '/auth/login', { email: EMAIL, password: SENHA_NOVA }, null);
const mfa2 = await req('POST', '/auth/login/mfa', { mfa_ticket: login2.json?.mfa_ticket, codigo: totp(segredo) }, null);
token = mfa2.json?.token;
check('acesso: relogin com MFA', !!token, `status ${mfa2.status}`);

const sufixo = Date.now().toString(36).toUpperCase();

// ------------------------------------------------- A) sem vínculos → exclui
const livre = await req('POST', '/produtos', { sku: `SMK-${sufixo}`, nome: 'Produto sem vínculos', preco_venda: 10 });
check('A: produto criado', livre.status === 200 || livre.status === 201, `status ${livre.status}`);
const livreId = livre.json?.id;

const diagLivre = await req('GET', `/produtos/${livreId}/dependencias`);
check(
  'A: GET /dependencias responde 200 e libera',
  diagLivre.status === 200 && diagLivre.json?.podeExcluir === true,
  `status ${diagLivre.status}`
);
const delLivre = await req('DELETE', `/produtos/${livreId}`);
check('A: DELETE sem vínculos → 200', delLivre.status === 200 && delLivre.json?.ok === true, `status ${delLivre.status}`);

// ------------------------------------------------------- B) um vínculo → 409
const cat = await req('POST', '/categorias', { nome: `Categoria vínculo ${sufixo}` });
const catId = cat.json?.id;
check('B: categoria criada', !!catId, `status ${cat.status}`);
const prod = await req('POST', '/produtos', { sku: `SMK2-${sufixo}`, nome: 'Produto da categoria', preco_venda: 10, categoria_id: catId });
check('B: produto vinculado criado', !!prod.json?.id, `status ${prod.status}`);

const diagCat = await req('GET', `/categorias/${catId}/dependencias`);
const vinculoProdutos = (diagCat.json?.vinculos ?? []).find((v) => v.tabela === 'produtos');
check('B: diagnóstico lista o módulo Produtos', diagCat.status === 200 && !!vinculoProdutos, `status ${diagCat.status}`);
check('B: diagnóstico traz quantidade e ids', vinculoProdutos?.quantidade === 1 && vinculoProdutos?.ids?.includes(prod.json.id));
check('B: diagnóstico diz que está bloqueado', diagCat.json?.bloqueado === true);

const delCat = await req('DELETE', `/categorias/${catId}`);
check('B: DELETE bloqueado → 409', delCat.status === 409, `status ${delCat.status}`);
check('B: código estável dependencias_vinculadas', delCat.json?.code === 'dependencias_vinculadas', `code ${delCat.json?.code}`);
const detalhe = delCat.json?.details?.dependencias;
check('B: details.dependencias no corpo do 409', !!detalhe && detalhe.bloqueado === true && detalhe.id === catId);
check(
  'B: mensagem explica o vínculo',
  /não é possível excluir/i.test(String(delCat.json?.error)) && /vinculad/i.test(String(delCat.json?.error)),
  String(delCat.json?.error).slice(0, 80)
);
const aindaExiste = await req('GET', `/categorias/${catId}`);
check('B: nada foi apagado', aindaExiste.status === 200 && !!aindaExiste.json?.id);

// ------------------------------------------- C) cliente com pedido → 409
const cli = await req('POST', '/clientes', { nome: `Cliente vínculo ${sufixo}` });
const cliId = cli.json?.id;
const venda = await req('POST', '/vendas', { cliente_id: cliId, data: '2026-10-24' });
check('C: venda criada', !!venda.json?.id, `status ${venda.status}`);
const delCli = await req('DELETE', `/clientes/${cliId}`);
const detCli = delCli.json?.details?.dependencias;
check('C: DELETE do cliente bloqueado', delCli.status === 409 && detCli?.bloqueado === true, `status ${delCli.status}`);
check(
  'C: módulo Vendas na mensagem',
  (detCli?.modulosBloqueantes ?? []).includes('Vendas'),
  JSON.stringify(detCli?.modulosBloqueantes)
);
const cliDepois = await req('GET', `/clientes/${cliId}`);
check('C: cliente continua (nada apagado)', cliDepois.status === 200);

console.log(out.join('\n'));
console.log(`\n${falhas ? 'SMOKE FALHOU' : 'SMOKE OK'}: ${out.length - falhas}/${out.length} verificações.`);
process.exit(falhas ? 1 : 0);
