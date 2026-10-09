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

// ---------------------------------------------------------------- E2 PRODUÇÃO (fluxo da OP sobre HTTP real)
// Os testes unitários chamam os handlers diretamente; este bloco é o único que
// prova o wiring das rotas novas (/liberar, /apontamentos, /concluir, /cancelar,
// /reabrir, /producao/planejamento) depois do middleware de auth e do :resource.
const sfx = Date.now();
const insumo = await req('POST', '/insumos', { nome: `Tecido Smoke ${sfx}`, unidade: 'm', custo_medio: 10 });
check('E2: POST /insumos', [200, 201].includes(insumo.status) && !!insumo.json?.id, `status ${insumo.status} ${msg(insumo.json)}`);
const prodOp = await req('POST', '/produtos', { sku: `SMOKE-OP-${sfx}`, nome: 'Produto Smoke OP', preco_venda: 100, custo: 30 });
check('E2: POST /produtos', [200, 201].includes(prodOp.status) && !!prodOp.json?.id, `status ${prodOp.status} ${msg(prodOp.json)}`);
const tamOp = await req('POST', '/tamanhos', { codigo: `S${String(sfx).slice(-4)}`, nome: 'Smoke', ordem: 900 });
check('E2: POST /tamanhos', [200, 201].includes(tamOp.status) && !!tamOp.json?.id, `status ${tamOp.status} ${msg(tamOp.json)}`);

// saldo do insumo: por movimentação, nunca por edição direta do cadastro
const movIn = await req('POST', '/movimentacoes_insumos', { tipo: 'entrada', insumo_id: insumo.json?.id, quantidade: 500, custo_unitario: 10, motivo: 'Saldo inicial smoke' });
check('E2: POST /movimentacoes_insumos dá saldo', [200, 201].includes(movIn.status), `status ${movIn.status} ${msg(movIn.json)}`);

// ficha técnica: 2 m por peça, sem perda, sem mão de obra → custo 20 por peça
const ficha = await req('POST', '/fichas', { produto_id: prodOp.json?.id, mao_obra: 0, custos_indiretos: 0, margem_pct: 100 });
check('E2: POST /fichas', [200, 201].includes(ficha.status) && !!ficha.json?.id, `status ${ficha.status} ${msg(ficha.json)}`);
const itemFicha = await req('POST', `/fichas/${ficha.json?.id}/insumos`, { insumo_id: insumo.json?.id, consumo: 2, perda_pct: 0 });
check('E2: POST /fichas/:id/insumos', [200, 201].includes(itemFicha.status), `status ${itemFicha.status} ${msg(itemFicha.json)}`);

const op = await req('POST', '/ordens', { produto_id: prodOp.json?.id, tipo: 'tamanho', tamanho_id: tamOp.json?.id, quantidade: 10, status: 'planejada', previsao: new Date().toISOString().slice(0, 10) });
check('E2: POST /ordens', [200, 201].includes(op.status) && op.json?.status === 'planejada', `status ${op.status} ${msg(op.json)}`);
const opId = op.json?.id;

// transição ilegal: planejada não pula para parcial
const ilegal = await req('PUT', `/ordens/${opId}`, { status: 'parcial' });
check('E2: planejada → parcial é recusada (409)', ilegal.status === 409, `status ${ilegal.status} ${msg(ilegal.json)}`);
// status fora do vocabulário
const invalido = await req('PUT', `/ordens/${opId}`, { status: 'voando' });
check('E2: status fora do vocabulário é recusado (400)', invalido.status === 400, `status ${invalido.status} ${msg(invalido.json)}`);

const liberada = await req('POST', `/ordens/${opId}/liberar`, {});
// 10 peças × (2 m × R$10) = R$200 de custo previsto
check('E2: POST /liberar congela o custo previsto', liberada.status === 200 && liberada.json?.status === 'liberada' && Number(liberada.json?.custo_previsto) === 200, `status ${liberada.status} custo_previsto=${liberada.json?.custo_previsto} ${msg(liberada.json)}`);

const chaveAp = `smoke-${sfx}`;
const ap1 = await req('POST', `/ordens/${opId}/apontamentos`, { quantidade_produzida: 4, quantidade_perdida: 1, idempotency_key: chaveAp });
check('E2: POST /apontamentos registra produção e perda', ap1.status === 201 && Number(ap1.json?.quantidade_produzida) === 4, `status ${ap1.status} ${msg(ap1.json)}`);
const ap2 = await req('POST', `/ordens/${opId}/apontamentos`, { quantidade_produzida: 4, quantidade_perdida: 1, idempotency_key: chaveAp });
check('E2: mesma chave de idempotência não baixa insumo de novo', ap2.status === 200 && ap2.json?.idempotente === true && Number(ap2.json?.id) === Number(ap1.json?.id), `status ${ap2.status} idempotente=${ap2.json?.idempotente}`);

const parcial = await req('GET', `/ordens/${opId}`);
check('E2: OP foi para "parcial" com 4 boas e 1 refugada', parcial.json?.status === 'parcial' && Number(parcial.json?.quantidade_produzida) === 4 && Number(parcial.json?.quantidade_perdida) === 1, `status=${parcial.json?.status} prod=${parcial.json?.quantidade_produzida} perd=${parcial.json?.quantidade_perdida}`);
// base de consumo = 4 boas + 1 refugada = 5 peças × 2 m = 10 m → custo real R$100
check('E2: custo real vem da execução (5 peças × 2 m × R$10 = R$100)', Number(parcial.json?.custo_real) === 100, `custo_real=${parcial.json?.custo_real}`);

const concluida = await req('POST', `/ordens/${opId}/concluir`, {});
check('E2: POST /concluir entra no estoque só com as peças boas', concluida.status === 200 && concluida.json?.status === 'concluida', `status ${concluida.status} ${msg(concluida.json)}`);
const consumo = await req('GET', `/movimentacoes_insumos?f.ordem_id=${opId}&pageSize=200`);
const saidas = (consumo.json?.rows || []).filter((m) => m.tipo === 'saida');
check('E2: consumo de insumo ligado à OP pela FK, sem duplicar na conclusão', saidas.length === 1 && Number(saidas[0].quantidade) === 10, `saidas=${saidas.length} qtd=${saidas[0]?.quantidade}`);
const entradaOp = await req('GET', `/movimentacoes?f.ordem_id=${opId}&pageSize=200`);
const entradas = (entradaOp.json?.rows || []).filter((m) => m.tipo === 'entrada');
check('E2: entrada de produto acabado ligada à OP pela FK', entradas.length === 1 && Number(entradas[0].quantidade) === 4, `entradas=${entradas.length} qtd=${entradas[0]?.quantidade}`);

const eventos = await req('GET', `/ordens/${opId}/eventos`);
const nomesEvento = (eventos.json || []).map((e) => e.evento);
check('E2: trilha registra liberada → apontamento → perda → concluida', ['liberada', 'apontamento', 'perda', 'concluida'].every((n) => nomesEvento.includes(n)), nomesEvento.join(','));

const reaberta = await req('POST', `/ordens/${opId}/reabrir`, {});
check('E2: POST /reabrir estorna (gerente)', reaberta.status === 200 && reaberta.json?.status === 'planejada', `status ${reaberta.status} ${msg(reaberta.json)}`);
const apsApos = await req('GET', `/ordens/${opId}/apontamentos`);
check('E2: reabrir descarta os apontamentos', Array.isArray(apsApos.json) && apsApos.json.length === 0, `apontamentos=${apsApos.json?.length}`);

const cancelada = await req('POST', `/ordens/${opId}/cancelar`, { motivo: 'Smoke: teste de cancelamento' });
check('E2: POST /cancelar guarda o motivo', cancelada.status === 200 && cancelada.json?.status === 'cancelada' && cancelada.json?.motivo_cancelamento === 'Smoke: teste de cancelamento', `status ${cancelada.status} motivo=${cancelada.json?.motivo_cancelamento}`);
const ressuscitar = await req('PUT', `/ordens/${opId}`, { status: 'em_producao' });
check('E2: OP cancelada é terminal', ressuscitar.status === 409, `status ${ressuscitar.status}`);

const plano = await req('GET', '/producao/planejamento');
check('E2: GET /producao/planejamento responde o plano', plano.status === 200 && typeof plano.json?.resumo?.ops === 'number' && Array.isArray(plano.json?.insumos), `status ${plano.status}`);
const semPlano = await req('GET', '/producao/planejamento?de=2031-01-05&ate=2031-01-11');
check('E2: período sem OP vem vazio (não inventa número)', semPlano.status === 200 && semPlano.json?.resumo?.ops === 0 && semPlano.json?.insumos?.length === 0, `ops=${semPlano.json?.resumo?.ops}`);

// ---------------------------------------------------------------- E3 cotação de compra
// O fluxo inteiro por HTTP: rascunho → itens → convite → cotação → decisão →
// pedido. E a regra que não pode quebrar: decidir duas vezes NÃO duplica.
const listaCot = await req('GET', '/cotacoes_compra?page=1&pageSize=5');
check('E3: GET /cotacoes_compra', listaCot.status === 200 && Array.isArray(listaCot.json?.rows), `status ${listaCot.status}`);

// Insumo e fornecedor: usa o que já existe no demo, cria se não houver.
let insumos = await req('GET', '/insumos?page=1&pageSize=1');
let insumoId = Number(insumos.json?.rows?.[0]?.id ?? 0);
if (!insumoId) {
  const criado = await req('POST', '/insumos', { nome: 'Insumo Smoke E3', unidade: 'un' });
  insumoId = Number(criado.json?.id ?? 0);
}
check('E3: insumo disponível para cotar', insumoId > 0, `insumo_id=${insumoId}`);

let forns = await req('GET', '/fornecedores?page=1&pageSize=1');
let fornId = Number(forns.json?.rows?.[0]?.id ?? 0);
if (!fornId) {
  const criado = await req('POST', '/fornecedores', { nome: 'Fornecedor Smoke E3' });
  fornId = Number(criado.json?.id ?? 0);
}
check('E3: fornecedor disponível para convidar', fornId > 0, `fornecedor_id=${fornId}`);

const cotNova = await req('POST', '/cotacoes_compra', { titulo: `Smoke E3 ${Date.now()}`, criterio: 'menor_preco' });
const cotId = Number(cotNova.json?.id ?? 0);
check('E3: POST /cotacoes_compra → 201 em rascunho', cotNova.status === 201 && cotNova.json?.status === 'rascunho', `status ${cotNova.status} ${msg(cotNova.json)}`);

// Sem item, convidar é recusado: convite sem carrinho não tem o que orçar.
const conviteSemItem = await req('POST', `/cotacoes-compra/${cotId}/convidar`, { fornecedor_ids: [fornId] });
check('E3: convidar sem item → 409', conviteSemItem.status === 409, `status ${conviteSemItem.status} ${msg(conviteSemItem.json)}`);

const itemCot = await req('POST', `/cotacoes-compra/${cotId}/itens`, { insumo_id: insumoId, quantidade: 10 });
const cotItemId = Number(itemCot.json?.id ?? 0);
check('E3: POST item da cotação → 201', itemCot.status === 201 && cotItemId > 0, `status ${itemCot.status} ${msg(itemCot.json)}`);

const itemDup = await req('POST', `/cotacoes-compra/${cotId}/itens`, { insumo_id: insumoId, quantidade: 5 });
check('E3: item duplicado na mesma cotação → 409', itemDup.status === 409, `status ${itemDup.status} ${msg(itemDup.json)}`);

const convite = await req('POST', `/cotacoes-compra/${cotId}/convidar`, { fornecedor_ids: [fornId] });
check('E3: POST convidar → 201 e abre a cotação', convite.status === 201 && convite.json?.convidados === 1, `status ${convite.status} ${msg(convite.json)}`);

const convites = await req('GET', `/cotacoes-compra/${cotId}/comparativo`);
const conviteId = Number(convites.json?.fornecedores?.[0]?.convite_id ?? 0);
check('E3: GET comparativo lista o convidado', convites.status === 200 && conviteId > 0, `status ${convites.status}`);

// Item sem cotação bloqueia a decisão — o sistema não inventa preço.
const decideCedo = await req('POST', `/cotacoes-compra/${cotId}/decidir`, {});
check('E3: decidir com item sem cotação → 409', decideCedo.status === 409, `status ${decideCedo.status} ${msg(decideCedo.json)}`);

const cotou = await req('POST', `/cotacoes-compra/${cotId}/cotar`, { convite_id: conviteId, precos: [{ item_id: cotItemId, preco_unitario: 12.5, prazo_entrega_dias: 7 }] });
check('E3: POST cotar → 201', cotou.status === 201, `status ${cotou.status} ${msg(cotou.json)}`);

const comp2 = await req('GET', `/cotacoes-compra/${cotId}/comparativo`);
check('E3: comparativo traz o menor preço real', comp2.json?.itens?.[0]?.menor_preco === 12.5 && comp2.json?.itens?.[0]?.cotacoes_recebidas === 1, `menor=${comp2.json?.itens?.[0]?.menor_preco}`);
check('E3: comparativo não inventa economia com uma só cotação', comp2.json?.resumo?.economia_potencial_total === 0, `economia=${comp2.json?.resumo?.economia_potencial_total}`);

const decidido = await req('POST', `/cotacoes-compra/${cotId}/decidir`, {});
const compraGerada = Number(decidido.json?.compra_id ?? 0);
check('E3: POST decidir → 201 e gera pedido', decidido.status === 201 && compraGerada > 0 && decidido.json?.idempotente === false, `status ${decidido.status} compra=${compraGerada} ${msg(decidido.json)}`);

const pedidoGerado = await req('GET', `/compras/${compraGerada}`);
check('E3: pedido gerado nasce pendente com total 125', pedidoGerado.status === 200 && pedidoGerado.json?.status === 'pendente' && Number(pedidoGerado.json?.total) === 125, `status=${pedidoGerado.json?.status} total=${pedidoGerado.json?.total}`);

// A regra mais importante: repetir não cria um segundo pedido.
const decidido2 = await req('POST', `/cotacoes-compra/${cotId}/decidir`, {});
check('E3: decidir de novo → 200 idempotente, mesmo pedido', decidido2.status === 200 && Number(decidido2.json?.compra_id) === compraGerada && decidido2.json?.idempotente === true, `compra=${decidido2.json?.compra_id} idempotente=${decidido2.json?.idempotente}`);

const cotDecidida = await req('GET', `/cotacoes_compra/${cotId}`);
check('E3: cotação fica decidida e aponta para o pedido', cotDecidida.json?.status === 'decidida' && Number(cotDecidida.json?.compra_id) === compraGerada, `status=${cotDecidida.json?.status}`);

// Cancelar uma cotação que já gerou pedido é recusado (a trilha da escolha fica).
const cancelaDecidida = await req('POST', `/cotacoes-compra/${cotId}/cancelar`, { motivo: 'smoke' });
check('E3: cancelar cotação já decidida → 409', cancelaDecidida.status === 409, `status ${cancelaDecidida.status} ${msg(cancelaDecidida.json)}`);

// Uma segunda cotação, cancelada antes de decidir, não cria pedido.
const cot2 = await req('POST', '/cotacoes_compra', { titulo: `Smoke E3 cancel ${Date.now()}` });
const cancelada2 = await req('POST', `/cotacoes-compra/${Number(cot2.json?.id)}/cancelar`, { motivo: 'smoke: desistência' });
check('E3: cancelar cotação aberta → 200 cancelada', cancelada2.status === 200 && cancelada2.json?.status === 'cancelada', `status ${cancelada2.status} ${msg(cancelada2.json)}`);

const cotSemAuth = await req('GET', '/cotacoes_compra?page=1&pageSize=1', null, null);
check('E3: /cotacoes_compra sem token → 401', cotSemAuth.status === 401, `status ${cotSemAuth.status}`);

// ------------------------------------------------- E3.1 CUSTO DE RECEBIMENTO
// O que se prova por HTTP: receber em dois lotes NÃO cobra o frete duas vezes,
// o custo médio ponderado é devolvido na resposta e cancelar devolve o estoque.
{
  const forn = await req('POST', '/fornecedores', { nome: 'Fornecedor Custo E31', cnpj: '11222333000181' });
  const insumo = await req('POST', '/insumos', { nome: 'Insumo Custo E31', unidade: 'un', custo_medio: 0 });
  const fornId = forn.json?.id;
  const insumoId = insumo.json?.id;
  check('E3.1: fornecedor e insumo criados', Boolean(fornId && insumoId), `forn=${fornId} insumo=${insumoId}`);

  const compra = await req('POST', '/compras', { fornecedor_id: fornId, data: new Date().toISOString().slice(0, 10), frete: 400 });
  const compraId = compra.json?.id;
  check('E3.1: compra com frete criada', compra.status === 201 && Boolean(compraId), `status ${compra.status} ${msg(compra.json)}`);

  if (!compraId) console.error('DEBUG compra:', JSON.stringify(compra.json));
  const item = await req('POST', `/compras/${compraId}/itens`, { insumo_id: insumoId, quantidade: 100, preco_unitario: 50 });
  const itemId = item.json?.id;
  check('E3.1: item adicionado', item.status === 201 && Boolean(itemId), `status ${item.status} ${msg(item.json)}`);

  const r1 = await req('POST', `/compras/${compraId}/receber`, { itens: [{ item_compra_id: itemId, quantidade: 40 }] });
  const custos1 = r1.json?.custos?.[0];
  check('E3.1: 1º lote (40 un) recebido', r1.status === 201, `status ${r1.status} ${msg(r1.json)}`);
  check('E3.1: resposta traz o custo efetivo aplicado', Number(custos1?.custo_unitario_efetivo) === 54, `efetivo=${custos1?.custo_unitario_efetivo} (preço 50 + frete 160/40)`);
  check('E3.1: resposta traz o antes/depois do custo médio', Number(custos1?.custo_medio_antes) === 0 && Number(custos1?.custo_medio_depois) === 54, `antes=${custos1?.custo_medio_antes} depois=${custos1?.custo_medio_depois}`);
  check('E3.1: compra fica parcial', r1.json?.status === 'parcial', `status=${r1.json?.status}`);

  const r2 = await req('POST', `/compras/${compraId}/receber`, { itens: [{ item_compra_id: itemId, quantidade: 60 }] });
  const custos2 = r2.json?.custos?.[0];
  // Se o frete fosse rateado de novo por inteiro, o 2º lote daria 90/un e o
  // custo médio iria a 75,6 — não 54.
  check('E3.1: 2º lote (60 un) recebido', r2.status === 201, `status ${r2.status} ${msg(r2.json)}`);
  check('E3.1: frete NÃO é cobrado duas vezes', Number(custos2?.custo_unitario_efetivo) === 54, `efetivo=${custos2?.custo_unitario_efetivo} (90 seria frete em dobro)`);
  check('E3.1: custo médio final = 54', Number(custos2?.custo_medio_depois) === 54, `depois=${custos2?.custo_medio_depois}`);
  check('E3.1: compra fica recebida', r2.json?.status === 'recebido', `status=${r2.json?.status}`);

  const insumoDepois = await req('GET', `/insumos/${insumoId}`);
  check('E3.1: custo médio gravado no insumo', Number(insumoDepois.json?.custo_medio) === 54, `custo_medio=${insumoDepois.json?.custo_medio}`);

  const estoque = await req('GET', '/movimentacoes_insumos');
  const entradas = (estoque.json?.rows || []).filter((m) => Number(m.insumo_id) === Number(insumoId) && m.tipo === 'entrada');
  check('E3.1: cada lote é uma movimentação com custo', entradas.length === 2 && entradas.every((m) => Number(m.custo_unitario) === 54), `entradas=${entradas.length} custos=${entradas.map((m) => m.custo_unitario).join(',')}`);
  check('E3.1: movimentação tem vínculo com a compra', entradas.every((m) => Number(m.compra_id) === Number(compraId)), `compra_id=${entradas.map((m) => m.compra_id).join(',')}`);

  const receberDeNovo = await req('POST', `/compras/${compraId}/receber`, { itens: [{ item_compra_id: itemId, quantidade: 10 }] });
  check('E3.1: receber além do pedido é recusado', receberDeNovo.status >= 400, `status ${receberDeNovo.status} ${msg(receberDeNovo.json)}`);

  const cancel = await req('PUT', `/compras/${compraId}`, { status: 'cancelado' });
  check('E3.1: cancelar compra recebida → estorno', cancel.status === 200, `status ${cancel.status} ${msg(cancel.json)}`);
  const insumoEstornado = await req('GET', `/insumos/${insumoId}`);
  check('E3.1: custo médio restaurado pelo estorno', Number(insumoEstornado.json?.custo_medio) === 0, `custo_medio=${insumoEstornado.json?.custo_medio}`);
}

// ------------------------------------ E3.2 CADEIA COMPLETA + CONTAS A PAGAR
// Fornecedor → Compra → Recebimento → Estoque → Custo → Conta a pagar → Parcelas.
await (async () => {
  const forn = await req('POST', '/fornecedores', { nome: 'Fornecedor Cadeia E32', cnpj: '99888777000100' });
  const insumo = await req('POST', '/insumos', { nome: 'Insumo Cadeia E32', unidade: 'un', custo_medio: 0 });
  const fornId = forn.json?.id;
  const insumoId = insumo.json?.id;
  check('E3.2: cadeia — fornecedor e insumo', Boolean(fornId && insumoId), `forn=${fornId} insumo=${insumoId} ${msg(forn.json)} ${msg(insumo.json)}`);
  if (!fornId || !insumoId) return;

  const compra = await req('POST', '/compras', {
    fornecedor_id: fornId,
    data: new Date().toISOString().slice(0, 10),
    frete: 400,
    condicao_pagamento: '30/60/90',
    fin_parcelas: 3,
    fin_vencimento: '2026-11-09',
    fin_forma_pagamento: 'boleto',
  });
  const compraId = compra.json?.id;
  check('E3.2: cadeia — compra com condição de pagamento criada', compra.status === 201 && Boolean(compraId), `status ${compra.status} ${msg(compra.json)}`);
  if (!compraId) return;

  const item = await req('POST', `/compras/${compraId}/itens`, { insumo_id: insumoId, quantidade: 100, preco_unitario: 50 });
  const itemId = item.json?.id;
  check('E3.2: cadeia — item criado', item.status === 201 && Boolean(itemId), `status ${item.status} ${msg(item.json)}`);
  if (!itemId) return;

  // Antes de receber não existe obrigação financeira.
  const antes = await req('GET', `/lancamentos_financeiros?f.referencia_tipo=compra&f.referencia_id=${compraId}&pageSize=50`);
  check('E3.2: compra pendente não gera conta a pagar', (antes.json?.rows || []).length === 0, `parcelas=${(antes.json?.rows || []).length}`);

  // Prévia: calcula sem gravar.
  const previa = await req('POST', `/compras/${compraId}/receber`, { previsao: true, itens: [{ item_compra_id: itemId, quantidade: 40 }] });
  check('E3.2: prévia devolve 200 e aplicado=false', previa.status === 200 && previa.json?.aplicado === false, `status ${previa.status} ${msg(previa.json)}`);
  check('E3.2: prévia projeta o custo efetivo', Number(previa.json?.custos?.[0]?.custo_unitario_efetivo) === 54, `efetivo=${previa.json?.custos?.[0]?.custo_unitario_efetivo}`);
  const saldoPrevia = await req('GET', `/insumos/${insumoId}`);
  check('E3.2: prévia NÃO movimenta estoque', Number(saldoPrevia.json?.custo_medio) === 0, `custo_medio=${saldoPrevia.json?.custo_medio}`);

  // Recebimento parcial de verdade.
  const r1 = await req('POST', `/compras/${compraId}/receber`, { itens: [{ item_compra_id: itemId, quantidade: 40 }] });
  check('E3.2: 1º lote recebido (parcial)', r1.status === 201 && r1.json?.status === 'parcial', `status ${r1.status}/${r1.json?.status} ${msg(r1.json)}`);
  const parc1 = await req('GET', `/lancamentos_financeiros?f.referencia_tipo=compra&f.referencia_id=${compraId}&pageSize=50`);
  check('E3.2: parcial ainda não gera conta a pagar', (parc1.json?.rows || []).length === 0, `parcelas=${(parc1.json?.rows || []).length}`);

  // Completa o pedido.
  const r2 = await req('POST', `/compras/${compraId}/receber`, { itens: [{ item_compra_id: itemId, quantidade: 60 }] });
  check('E3.2: 2º lote completa o pedido', r2.status === 201 && r2.json?.status === 'recebido', `status ${r2.status}/${r2.json?.status} ${msg(r2.json)}`);

  // Estoque e custo.
  const insumoFinal = await req('GET', `/insumos/${insumoId}`);
  check('E3.2: custo médio final = 54 (frete não cobrado duas vezes)', Number(insumoFinal.json?.custo_medio) === 54, `custo_medio=${insumoFinal.json?.custo_medio}`);

  // Contas a pagar.
  const parcelas = await req('GET', `/lancamentos_financeiros?f.referencia_tipo=compra&f.referencia_id=${compraId}&pageSize=50`);
  const rows = [...(parcelas.json?.rows || [])].sort((x, y) => Number(x.parcela) - Number(y.parcela));
  check('E3.2: compra completa gera 3 contas a pagar', rows.length === 3, `parcelas=${rows.length}`);
  if (rows.length === 0) return;
  const soma = rows.reduce((acc, pr) => acc + Number(pr.valor || 0), 0);
  check('E3.2: soma das parcelas fecha no total 5400', Math.round(soma * 100) / 100 === 5400, `soma=${soma}`);
  check('E3.2: parcelas numeradas 1/3, 2/3, 3/3', rows.map((pr) => `${pr.parcela}/${pr.total_parcelas}`).join(',') === '1/3,2/3,3/3', rows.map((pr) => `${pr.parcela}/${pr.total_parcelas}`).join(','));
  const vences = rows.map((pr) => String(pr.vencimento || '').slice(0, 10));
  check('E3.2: vencimentos mensais a partir do informado', vences.join(',') === '2026-11-09,2026-12-09,2027-01-09', vences.join(','));
  check('E3.2: parcelas nascem pendentes e são despesa', rows.every((pr) => pr.status === 'pendente' && pr.tipo === 'despesa'), rows.map((pr) => `${pr.status}/${pr.tipo}`).join(','));
  check('E3.2: parcela tem vínculo estrutural com a compra', rows.every((pr) => pr.referencia_tipo === 'compra' && Number(pr.referencia_id) === Number(compraId)), 'ok');

  // Baixa de uma parcela pelo núcleo financeiro existente (não há segundo motor).
  const baixa = await req('PUT', `/lancamentos_financeiros/${rows[0].id}`, { status: 'confirmado' });
  check('E3.2: baixa da 1ª parcela pelo financeiro', baixa.status === 200, `status ${baixa.status} ${msg(baixa.json)}`);
  const depoisBaixa = await req('GET', `/lancamentos_financeiros?f.referencia_tipo=compra&f.referencia_id=${compraId}&pageSize=50`);
  const conf = (depoisBaixa.json?.rows || []).filter((pr) => pr.status === 'confirmado').length;
  check('E3.2: baixa confirmada aparece no plano', conf === 1, `confirmadas=${conf}`);

  // Estornar a compra cancela as contas a pagar.
  const cancel = await req('PUT', `/compras/${compraId}`, { status: 'cancelado' });
  check('E3.2: cancelar a compra recebida', cancel.status === 200, `status ${cancel.status} ${msg(cancel.json)}`);
  const aposCancelar = await req('GET', `/lancamentos_financeiros?f.referencia_tipo=compra&f.referencia_id=${compraId}&pageSize=50`);
  const canceladas = (aposCancelar.json?.rows || []).filter((pr) => pr.status === 'cancelado').length;
  check('E3.2: contas a pagar canceladas junto com a compra', canceladas >= 1, `canceladas=${canceladas}`);
})();

// -------------------------------------------- E3.2 DE-PARA E XML NO MENU
{
  const depara = await req('GET', '/produto_fornecedor_skus');
  check('E3.2: de-para é navegável pela API', depara.status === 200, `status ${depara.status}`);

  const forn = await req('POST', '/fornecedores', { nome: 'Fornecedor DePara', cnpj: '66555444000100' });
  const prod = await req('POST', '/produtos', { nome: 'Produto DePara', sku: `SKU-DEPARA-${Date.now()}` });
  const criado = await req('POST', '/produto_fornecedor_skus', {
    fornecedor_id: forn.json?.id,
    codigo_fornecedor: 'COD-FORN-XYZ',
    produto_id: prod.json?.id,
    descricao: 'Descrição do fornecedor',
    unidade: 'CX',
    ativo: true,
  });
  check('E3.2: de-para criado com descrição e unidade', criado.status === 201 && criado.json?.descricao === 'Descrição do fornecedor' && criado.json?.unidade === 'CX', `status ${criado.status} ${msg(criado.json)}`);

  const inativado = await req('PUT', `/produto_fornecedor_skus/${criado.json?.id}`, { ativo: false });
  check('E3.2: de-para pode ser inativado', inativado.status === 200 && inativado.json?.ativo === false, `status ${inativado.status} ativo=${inativado.json?.ativo}`);

  const semXml = await req('POST', '/suprimentos/compras/importar-xml', { xml: '<html>não é nfe</html>' });
  check('E3.2: XML inválido é recusado com 422', semXml.status === 422, `status ${semXml.status}`);
  const semNada = await req('POST', '/suprimentos/compras/importar-xml', {});
  check('E3.2: importação sem arquivo é recusada', semNada.status >= 400, `status ${semNada.status}`);
}


// ---------------------------------------------------------------- RBAC
const semToken = await req('GET', '/logistica/config', null, null);
check('sem token → 401', semToken.status === 401, `status ${semToken.status}`);

const ticketComoBearer = await req('GET', '/logistica/config', null, ticket);
check('ticket de MFA não vale como token de acesso → 401', ticketComoBearer.status === 401, `status ${ticketComoBearer.status}`);

console.log(out.join('\n'));
console.log(`\n${out.length - falhas}/${out.length} verificações OK`);
process.exit(falhas ? 1 : 0);
