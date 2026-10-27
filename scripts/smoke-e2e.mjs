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

// ------------------------------- CADASTROS › CORES (padrão LISTA → PÁGINA)
// A tela de Cores é metadado-dirigida: `/meta` precisa declarar `uso` e
// `quickFilters` (coluna Utilização e recorte de status). O formulário NÃO é
// uma superfície sobreposta: o metadado não declara `editor` de drawer/modal —
// a inclusão e a edição vivem nas páginas /cores/novo e /cores/:id/editar, e o
// contrato de API abaixo (POST/PUT/GET/DELETE) é o que essas páginas usam.
// A prova é no Express de verdade — sem chamar handler na mão.
{
  const meta = await req('GET', '/meta');
  const cores = meta.json?.resources?.cores;
  check('cores: /meta NÃO declara drawer/modal (formulário é página)', !('editor' in (cores || {})), `editor=${cores?.editor}`);
  check('cores: /meta declara uso por produtos.cor_id',
    cores?.uso?.recurso === 'produtos' && cores?.uso?.campo === 'cor_id', JSON.stringify(cores?.uso));
  check('cores: /meta entrega os filtros rápidos Todas/Ativas/Inativas',
    JSON.stringify((cores?.quickFilters?.[0]?.options || []).map((o) => o.label)) === '["Todas","Ativas","Inativas"]');
  const campoHex = (cores?.fields || []).find((f) => f.name === 'hex');
  check('cores: HEX segue opcional e buscável', campoHex?.required !== true && campoHex?.search === true);

  const nomeCor = `Azul Petróleo ${Date.now().toString().slice(-6)}`;
  const nova = await req('POST', '/cores', { nome: nomeCor, hex: '172038', ativo: true });
  check('POST /cores normaliza HEX para #172038', nova.status === 201 && nova.json?.hex === '#172038',
    `status ${nova.status} hex=${nova.json?.hex}`);
  const corId = nova.json?.id;

  const buscaNome = await req('GET', '/cores?q=azul%20petr&page=1&pageSize=25');
  check('cores: busca por nome na listagem do servidor', (buscaNome.json?.rows || []).some((r) => r.id === corId));
  const buscaHex = await req('GET', '/cores?q=172038&page=1&pageSize=25');
  check('cores: busca alcança o HEX', (buscaHex.json?.rows || []).some((r) => r.id === corId));
  const inativas = await req('GET', '/cores?f.ativo=false&page=1&pageSize=25');
  check('cores: filtro f.ativo=false', inativas.status === 200 && (inativas.json?.rows || []).every((r) => r.ativo === false));

  // Produto continua escolhendo a cor do cadastro e recebendo a amostra.
  const produtoCor = await req('POST', '/produtos', { sku: `SMOKE-COR-${Date.now()}`, nome: 'Camiseta Smoke Cor', cor_id: corId, preco_venda: 99.9 });
  check('produtos: cor do cadastro aceita no produto', [200, 201].includes(produtoCor.status), `status ${produtoCor.status}`);
  const detalhe = await req('GET', `/produtos/${produtoCor.json?.id}`);
  check('produtos: rótulo e amostra da cor resolvidos',
    detalhe.json?.cor_id__label === nomeCor && detalhe.json?.cor_id__color === '#172038',
    `${detalhe.json?.cor_id__label} / ${detalhe.json?.cor_id__color}`);
  const opcoes = await req('GET', '/cores/options');
  check('cores: /options alimenta a seleção do produto', Array.isArray(opcoes.json) && opcoes.json.some((o) => String(o.value) === String(corId)));

  const listaUso = await req('GET', '/cores?page=1&pageSize=50');
  const linhaUso = (listaUso.json?.rows || []).find((r) => r.id === corId);
  check('cores: Utilização traz a contagem real (1 produto)',
    linhaUso?.uso_vinculado === 1 && linhaUso?.uso_vinculado_label === '1 produto', `${linhaUso?.uso_vinculado_label}`);

  // Exclusão bloqueada: diagnóstico do PR #83 + saída por desativação.
  const bloqueada = await req('DELETE', `/cores/${corId}`);
  const diagCor = bloqueada.json?.details?.dependencias;
  check('cores: DELETE vinculado → 409 dependencias_vinculadas',
    bloqueada.status === 409 && bloqueada.json?.code === 'dependencias_vinculadas', `status ${bloqueada.status}`);
  check('cores: diagnóstico diz onde/quantos/por quê',
    diagCor?.bloqueado === true && diagCor?.modulosBloqueantes?.includes('Produtos') &&
    diagCor?.vinculos?.some((v) => v.tabela === 'produtos' && v.quantidade === 1 && Array.isArray(v.ids) && v.motivo));
  const desativada = await req('PUT', `/cores/${corId}`, { ativo: false });
  check('cores: desativar preserva o registro', desativada.status === 200 && desativada.json?.ativo === false, `status ${desativada.status}`);

  // Cor sem vínculo segue o fluxo normal.
  const semUso = await req('POST', '/cores', { nome: `Cor sem uso ${Date.now().toString().slice(-6)}` });
  const excluida = await req('DELETE', `/cores/${semUso.json?.id}`);
  check('cores: DELETE sem vínculo segue o fluxo normal', [200, 204].includes(excluida.status), `status ${excluida.status}`);
}


// ---------------------------- CADASTROS › COLEÇÕES (padrão LISTA → DRAWER)
// Coleções é cadastro POR EMPRESA (empresa: true): o formulário vive num Drawer
// sobre a própria listagem, e a exclusão passa pelo diagnóstico de dependências
// — coleção em uso pelos produtos é DESATIVADA, nunca apagada.
{
  const meta = await req('GET', '/meta');
  const col = meta.json?.resources?.colecoes;
  check('colecoes: /meta NÃO declara drawer/modal (formulário é página)', !('editor' in (col || {})), `editor=${col?.editor}`);
  check('colecoes: cadastro por empresa (empresa: true)', col?.empresa === true, `empresa=${col?.empresa}`);
  check('colecoes: RBAC preservado — SEM minPerfilEscrita',
    !('minPerfilEscrita' in (col || {})), `minPerfilEscrita=${col?.minPerfilEscrita}`);
  check('colecoes: nome é o único campo obrigatório e é buscável',
    (col?.fields || []).filter((f) => f.required).map((f) => f.name).join(',') === 'nome' &&
    (col?.fields || []).find((f) => f.name === 'nome')?.search === true);

  const nomeCol = `Verão Smoke ${Date.now().toString().slice(-6)}`;
  const nova = await req('POST', '/colecoes', { nome: nomeCol, temporada: 'Verão', ano: 2027, ativo: true });
  check('POST /colecoes cria a coleção', nova.status === 201, `status ${nova.status}`);
  const colId = nova.json?.id;

  const busca = await req('GET', '/colecoes?q=ver%C3%A3o%20smoke&page=1&pageSize=25');
  check('colecoes: busca por nome na listagem', (busca.json?.rows || []).some((r) => r.id === colId));
  const inativasCol = await req('GET', '/colecoes?f.ativo=false&page=1&pageSize=25');
  check('colecoes: filtro f.ativo=false', inativasCol.status === 200 && (inativasCol.json?.rows || []).every((r) => r.ativo === false));

  // Produto referencia a coleção e a utilização é contada de forma AGREGADA.
  const produtoCol = await req('POST', '/produtos', { sku: `SMOKE-COL-${Date.now()}`, nome: 'Camiseta Smoke Coleção', colecao_id: colId, preco_venda: 129.9 });
  check('produtos: coleção do cadastro aceita no produto', [200, 201].includes(produtoCol.status), `status ${produtoCol.status}`);
  const listaCol = await req('GET', '/colecoes?page=1&pageSize=50');
  const linhaCol = (listaCol.json?.rows || []).find((r) => r.id === colId);
  check('colecoes: Utilização traz a contagem real (1 produto)',
    linhaCol?.produtos_vinculados === 1 && linhaCol?.em_uso === true, `produtos_vinculados=${linhaCol?.produtos_vinculados}`);

  // Exclusão bloqueada por histórico protegido + saída por desativação.
  const bloqueadaCol = await req('DELETE', `/colecoes/${colId}`);
  const diagCol = bloqueadaCol.json?.details?.dependencias;
  check('colecoes: DELETE vinculado → 409 dependencias_vinculadas',
    bloqueadaCol.status === 409 && bloqueadaCol.json?.code === 'dependencias_vinculadas', `status ${bloqueadaCol.status}`);
  check('colecoes: diagnóstico diz onde/quantos/por quê',
    diagCol?.bloqueado === true && diagCol?.modulosBloqueantes?.includes('Produtos') &&
    diagCol?.vinculos?.some((v) => v.tabela === 'produtos' && v.quantidade === 1 && Array.isArray(v.ids) && v.motivo));
  const desativadaCol = await req('PUT', `/colecoes/${colId}`, { ativo: false });
  check('colecoes: desativar preserva a coleção e o produto vinculado',
    desativadaCol.status === 200 && desativadaCol.json?.ativo === false, `status ${desativadaCol.status}`);
  const produtoApos = await req('GET', `/produtos/${produtoCol.json?.id}`);
  check('produtos: continuam apontando para a coleção desativada', String(produtoApos.json?.colecao_id) === String(colId));

  // Coleção sem vínculo segue o fluxo normal de exclusão.
  const semUsoCol = await req('POST', '/colecoes', { nome: `Coleção sem uso ${Date.now().toString().slice(-6)}` });
  const excluidaCol = await req('DELETE', `/colecoes/${semUsoCol.json?.id}`);
  check('colecoes: DELETE sem vínculo segue o fluxo normal', [200, 204].includes(excluidaCol.status), `status ${excluidaCol.status}`);
}

// ------------------------------ CADASTROS › TAMANHOS (padrão LISTA → PÁGINA)
// O dicionário de tamanhos migrou do modal central para o padrão canônico do
// ERP: a inclusão e a edição vivem nas páginas /tamanhos/novo e
// /tamanhos/:id/editar. O metadado não declara `editor` de drawer/modal — a
// prova é no Express de verdade, com o MESMO contrato de API que a página usa.
{
  const meta = await req('GET', '/meta');
  const tam = meta.json?.resources?.tamanhos;
  check('tamanhos: /meta NÃO declara drawer/modal (formulário é página)', !('editor' in (tam || {})), `editor=${tam?.editor}`);
  check('tamanhos: campos reais (codigo, descricao, ordem) e nenhum "ativo" inventado',
    JSON.stringify((tam?.fields || []).filter((f) => !['criado_em', 'atualizado_em'].includes(f.name)).map((f) => f.name)) ===
      '["codigo","descricao","ordem"]',
    JSON.stringify((tam?.fields || []).map((f) => f.name)));
  const campoCodigo = (tam?.fields || []).find((f) => f.name === 'codigo');
  check('tamanhos: codigo é obrigatório, único e buscável',
    campoCodigo?.required === true && campoCodigo?.unique === true && campoCodigo?.search === true);
  check('tamanhos: RBAC do catálogo compartilhado preservado (gerente+)', tam?.minPerfilEscrita === 'gerente', `minPerfilEscrita=${tam?.minPerfilEscrita}`);

  const codTam = `SM${Date.now().toString().slice(-6)}`;
  const novo = await req('POST', '/tamanhos', { codigo: codTam, descricao: 'Smoke Tamanho', ordem: 42 });
  check('POST /tamanhos cria o tamanho (o que a página /tamanhos/novo envia)', novo.status === 201 && !!novo.json?.id,
    `status ${novo.status} ${msg(novo.json)}`);
  const tamId = novo.json?.id;

  const buscaCod = await req('GET', `/tamanhos?q=${encodeURIComponent(codTam)}&page=1&pageSize=25`);
  check('tamanhos: busca por código na listagem do servidor', (buscaCod.json?.rows || []).some((r) => r.id === tamId));
  const buscaDesc = await req('GET', '/tamanhos?q=Smoke%20Tamanho&page=1&pageSize=25');
  check('tamanhos: busca alcança a descrição', (buscaDesc.json?.rows || []).some((r) => r.id === tamId));

  // A página de edição carrega pelo GET e salva pelo PUT — o mesmo contrato.
  const detalheTam = await req('GET', `/tamanhos/${tamId}`);
  check('GET /tamanhos/:id devolve o registro para a página de edição',
    detalheTam.status === 200 && detalheTam.json?.codigo === codTam && Number(detalheTam.json?.ordem) === 42);
  const editado = await req('PUT', `/tamanhos/${tamId}`, { descricao: 'Smoke Tamanho editado', ordem: 43 });
  check('PUT /tamanhos/:id salva a edição', editado.status === 200 && Number(editado.json?.ordem) === 43, `status ${editado.status}`);

  const opcoesTam = await req('GET', '/tamanhos/options');
  check('tamanhos: /options alimenta Grades e Estoque', Array.isArray(opcoesTam.json) && opcoesTam.json.some((o) => String(o.value) === String(tamId)));

  // Exclusão: o vínculo REAL do domínio é o estoque (movimentação/saldo).
  const prodTam = await req('POST', '/produtos', { sku: `SMOKE-TAM-${Date.now()}`, nome: 'Camiseta Smoke Tam', preco_venda: 59.9 });
  const mov = await req('POST', '/movimentacoes', { tipo: 'entrada', produto_id: prodTam.json?.id, tamanho_id: tamId, quantidade: 3 });
  check('estoque aceita movimentação com o tamanho do dicionário', [200, 201].includes(mov.status), `status ${mov.status} ${msg(mov.json)}`);
  const bloqueadaTam = await req('DELETE', `/tamanhos/${tamId}`);
  const diagTam = bloqueadaTam.json?.details?.dependencias;
  check('tamanhos: DELETE vinculado → 409 dependencias_vinculadas',
    bloqueadaTam.status === 409 && bloqueadaTam.json?.code === 'dependencias_vinculadas', `status ${bloqueadaTam.status}`);
  check('tamanhos: diagnóstico diz onde/quantos/por quê',
    diagTam?.bloqueado === true && diagTam?.modulosBloqueantes?.includes('Estoque') &&
    diagTam?.vinculos?.some((v) => v.tabela === 'movimentacoes' && v.quantidade >= 1 && Array.isArray(v.ids) && v.motivo));

  // Tamanho sem vínculo segue o fluxo normal.
  const semUsoTam = await req('POST', '/tamanhos', { codigo: `SV${Date.now().toString().slice(-6)}`, ordem: 44 });
  const excluidaTam = await req('DELETE', `/tamanhos/${semUsoTam.json?.id}`);
  check('tamanhos: DELETE sem vínculo segue o fluxo normal', [200, 204].includes(excluidaTam.status), `status ${excluidaTam.status}`);
}

// ------------------------------ CADASTROS › GRADES (padrão LISTA → PÁGINA)
// Grades seguem o mesmo padrão de Cores, com uma diferença de domínio: a relação
// grade × tamanho é ORDENADA (`grade_tamanhos.ordem`). O formulário vive nas
// páginas /grades/novo e /grades/:id/editar — `/meta` não declara drawer/modal —
// e o contrato abaixo é exatamente o que elas usam: POST/PUT com `tamanhos` na
// ordem desejada, listagem anotada (ordem, utilização, estado da tabela de
// medidas) e exclusão com diagnóstico de vínculos.
{
  const meta = await req('GET', '/meta');
  const grades = meta.json?.resources?.grades;
  check('grades: /meta NÃO declara drawer/modal (formulário é página)', !('editor' in (grades || {})), `editor=${grades?.editor}`);
  check('grades: /meta declara uso por produtos.grade_id',
    grades?.uso?.recurso === 'produtos' && grades?.uso?.campo === 'grade_id', JSON.stringify(grades?.uso));
  check('grades: /meta entrega os filtros rápidos Todas/Ativas/Inativas',
    JSON.stringify((grades?.quickFilters?.[0]?.options || []).map((o) => o.label)) === '["Todas","Ativas","Inativas"]');
  const campoTamanhos = (grades?.fields || []).find((f) => f.name === 'tamanhos');
  check('grades: tamanhos é a relação ordenada e obrigatória do domínio',
    campoTamanhos?.type === 'multiref' && campoTamanhos?.ref === 'tamanhos' && campoTamanhos?.required === true,
    JSON.stringify({ type: campoTamanhos?.type, ref: campoTamanhos?.ref, required: campoTamanhos?.required }));

  // Tamanhos reais do dicionário, na ordem do próprio cadastro. Um banco novo
  // (smoke:pg) pode vir sem dicionário — aí o smoke cadastra os tamanhos que usa,
  // pelo mesmo POST /tamanhos da tela (nada de dado de exemplo injetado à mão).
  const sufixoTam = Date.now().toString().slice(-6);
  let opcoesTamanhos = await req('GET', '/tamanhos/options');
  let idsTamanhos = (opcoesTamanhos.json || []).slice(0, 4).map((o) => Number(o.value));
  while (idsTamanhos.length < 3) {
    const novoTamanho = await req('POST', '/tamanhos', {
      codigo: `SM${sufixoTam}${idsTamanhos.length + 1}`,
      ordem: 900 + idsTamanhos.length,
    });
    if (![200, 201].includes(novoTamanho.status) || !novoTamanho.json?.id) break;
    idsTamanhos.push(Number(novoTamanho.json.id));
  }
  opcoesTamanhos = await req('GET', '/tamanhos/options');
  check('grades: /tamanhos/options alimenta a seleção da página', idsTamanhos.length >= 3, `${idsTamanhos.length} tamanhos`);

  const nomeGrade = `Camiseta Smoke ${Date.now().toString().slice(-6)}`;
  const novaGrade = await req('POST', '/grades', {
    nome: nomeGrade,
    descricao: 'Grade do smoke',
    instrucoes_medidas: 'Meça a peça sobre uma superfície plana, sem esticar.',
    ativo: true,
    tamanhos: idsTamanhos,
  });
  const gradeId = novaGrade.json?.id;
  check('POST /grades grava a grade com os tamanhos NA ORDEM enviada',
    novaGrade.status === 201 && JSON.stringify(novaGrade.json?.tamanhos) === JSON.stringify(idsTamanhos),
    `status ${novaGrade.status} tamanhos=${JSON.stringify(novaGrade.json?.tamanhos)}`);

  const gradeCriada = await req('GET', `/grades/${gradeId}`);
  const codigos = new Map((opcoesTamanhos.json || []).map((o) => [Number(o.value), String(o.label)]));
  const rotuloEsperado = idsTamanhos.map((t) => codigos.get(t)).join(' · ');
  check('grades: rótulo dos tamanhos segue a ordem da grade',
    gradeCriada.json?.tamanhos__label === rotuloEsperado && gradeCriada.json?.tamanhos_total === idsTamanhos.length,
    `${gradeCriada.json?.tamanhos__label} (total ${gradeCriada.json?.tamanhos_total})`);
  check('grades: instruções de medição persistem no campo existente',
    String(gradeCriada.json?.instrucoes_medidas || '').includes('superfície plana'));

  // Reordenação (o ↑ ↓ da página) reescreve a ordem — sem recriar a grade.
  const reordenada = idsTamanhos.slice().reverse();
  const putOrdem = await req('PUT', `/grades/${gradeId}`, { tamanhos: reordenada });
  check('PUT /grades reordena os tamanhos (ordem = posição)',
    putOrdem.status === 200 && JSON.stringify(putOrdem.json?.tamanhos) === JSON.stringify(reordenada),
    `status ${putOrdem.status} tamanhos=${JSON.stringify(putOrdem.json?.tamanhos)}`);
  // Duplicata não entra duas vezes (UNIQUE grade_id + tamanho_id): a primeira
  // ocorrência vence e a ordem recebida é preservada.
  const duplicada = await req('PUT', `/grades/${gradeId}`, { tamanhos: [...reordenada, reordenada[0]] });
  check('grades: tamanho duplicado é descartado na gravação',
    duplicada.status === 200 && JSON.stringify(duplicada.json?.tamanhos) === JSON.stringify(reordenada),
    `tamanhos=${JSON.stringify(duplicada.json?.tamanhos)}`);
  await req('PUT', `/grades/${gradeId}`, { tamanhos: reordenada });

  // Grade sem tamanho é recusada (a obrigatoriedade já é do domínio).
  const semTamanho = await req('POST', '/grades', { nome: `Sem tamanho ${Date.now().toString().slice(-6)}`, tamanhos: [] });
  check('grades: criação sem tamanho é recusada', semTamanho.status === 400, `status ${semTamanho.status}`);

  // Utilização real: produto da empresa ativa + categoria que usa a grade.
  const produtoGrade = await req('POST', '/produtos', {
    sku: `SMOKE-GRD-${Date.now()}`,
    nome: 'Camiseta Smoke Grade',
    grade_id: gradeId,
    preco_venda: 89.9,
  });
  check('produtos: grade do cadastro aceita no produto', [200, 201].includes(produtoGrade.status), `status ${produtoGrade.status}`);
  const categoriaGrade = await req('POST', '/categorias', { nome: `Categoria Smoke ${Date.now().toString().slice(-6)}`, grade_id: gradeId });
  check('categorias: grade padrão aceita na categoria', [200, 201].includes(categoriaGrade.status), `status ${categoriaGrade.status}`);

  const listaGrades = await req('GET', '/grades?page=1&pageSize=100');
  const linhaGrade = (listaGrades.json?.rows || []).find((r) => r.id === gradeId);
  check('grades: Utilização traz produtos E categorias (contagem real, em lote)',
    linhaGrade?.uso_vinculado === 1 && linhaGrade?.uso_categorias === 1 &&
    linhaGrade?.uso_vinculado_label === '1 produto · 1 categoria',
    `${linhaGrade?.uso_vinculado_label}`);

  // Estado da tabela de medidas: mesma regra de completude do módulo de medidas.
  check('grades: MEDIDAS começa "sem tabela" (estado real, não inventado)',
    linhaGrade?.medidas_status === 'sem_tabela' && linhaGrade?.medidas_colunas === 0,
    `status=${linhaGrade?.medidas_status}`);
  const valoresMedidas = reordenada.slice(0, 2).map((tamanho_id) => ({ medida_nome: 'Largura (A)', tamanho_id, valor: 50 }));
  const tabela = await req('PUT', `/grades/${gradeId}/medidas`, {
    medidas: [{ nome: 'Largura (A)', unidade: 'cm' }, { nome: 'Comprimento (B)', unidade: 'cm' }],
    valores: valoresMedidas,
  });
  check('grades: tabela de medidas salva pelo endpoint do módulo', tabela.status === 200, `status ${tabela.status}`);
  const depoisMedidas = (await req('GET', '/grades?page=1&pageSize=100')).json?.rows?.find((r) => r.id === gradeId);
  // 2 colunas × N tamanhos da grade = total de células; preenchidas = as enviadas.
  const celulasTotal = 2 * reordenada.length;
  const celulasPreenchidas = valoresMedidas.length;
  const pctEsperado = Math.round((celulasPreenchidas / celulasTotal) * 100);
  check('grades: MEDIDAS vira "parcial" com o percentual real',
    depoisMedidas?.medidas_status === 'parcial' && depoisMedidas?.medidas_pct === pctEsperado &&
    depoisMedidas?.medidas_colunas === 2 && depoisMedidas?.medidas_celulas_total === celulasTotal &&
    depoisMedidas?.medidas_celulas_preenchidas === celulasPreenchidas,
    `status=${depoisMedidas?.medidas_status} pct=${depoisMedidas?.medidas_pct}/${pctEsperado} celulas=${depoisMedidas?.medidas_celulas_total}`);
  const resumo = await req('GET', '/grades/medidas-resumo');
  const linhaResumo = (resumo.json?.grades || []).find((g) => g.id === gradeId);
  check('grades: painel de completude continua dizendo o mesmo',
    linhaResumo?.celulas_total === celulasTotal && linhaResumo?.celulas_preenchidas === celulasPreenchidas &&
    linhaResumo?.pct === pctEsperado,
    JSON.stringify({ total: linhaResumo?.celulas_total, preenchidas: linhaResumo?.celulas_preenchidas, pct: linhaResumo?.pct }));

  // Busca e filtro de status pela mesma listagem paginada.
  const buscaGrade = await req('GET', `/grades?q=${encodeURIComponent('camiseta smoke')}&page=1&pageSize=25`);
  check('grades: busca por nome na listagem do servidor', (buscaGrade.json?.rows || []).some((r) => r.id === gradeId));
  const gradesInativas = await req('GET', '/grades?f.ativo=false&page=1&pageSize=25');
  check('grades: filtro f.ativo=false', gradesInativas.status === 200 && (gradesInativas.json?.rows || []).every((r) => r.ativo === false));

  // Exclusão bloqueada: diagnóstico real + saída por desativação.
  const bloqueada = await req('DELETE', `/grades/${gradeId}`);
  const diag = bloqueada.json?.details?.dependencias;
  check('grades: DELETE vinculado → 409 dependencias_vinculadas',
    bloqueada.status === 409 && bloqueada.json?.code === 'dependencias_vinculadas', `status ${bloqueada.status}`);
  check('grades: diagnóstico diz onde/quantos/por quê',
    diag?.bloqueado === true && diag?.modulosBloqueantes?.includes('Produtos') &&
    diag?.vinculos?.some((v) => v.tabela === 'produtos' && v.quantidade === 1 && Array.isArray(v.ids) && v.motivo) &&
    /desative/i.test(String(diag?.orientacao || '')));
  check('grades: a composição (tamanhos/medidas) aparece sem bloquear',
    diag?.vinculos?.some((v) => v.tabela === 'grade_tamanhos' && v.bloqueia === false));

  const desativada = await req('PUT', `/grades/${gradeId}`, { ativo: false });
  const aposDesativar = await req('GET', `/grades/${gradeId}`);
  check('grades: desativar preserva tamanhos, medidas e vínculos',
    desativada.status === 200 && aposDesativar.json?.ativo === false &&
    aposDesativar.json?.tamanhos_total === reordenada.length &&
    (await req('GET', `/grades/${gradeId}/medidas`)).json?.medidas?.length === 2,
    `status ${desativada.status} tamanhos=${aposDesativar.json?.tamanhos_total}`);

  // Grade sem vínculo segue o fluxo normal (a composição sai junto).
  const gradeOrfa = await req('POST', '/grades', { nome: `Órfã ${Date.now().toString().slice(-6)}`, tamanhos: idsTamanhos.slice(0, 2) });
  const excluida = await req('DELETE', `/grades/${gradeOrfa.json?.id}`);
  check('grades: DELETE sem vínculo segue o fluxo normal', [200, 204].includes(excluida.status), `status ${excluida.status}`);
  const sumiu = await req('GET', `/grades/${gradeOrfa.json?.id}`);
  check('grades: a grade excluída não volta na leitura', sumiu.status === 404, `status ${sumiu.status}`);
}

// ------------------------------ CADASTROS › INSUMOS (padrão LISTA → PÁGINA)
// Insumos seguem o mesmo padrão de Cores, Coleções e Grades: o formulário vive
// nas páginas /insumos/novo e /insumos/:id/editar — `/meta` não declara
// drawer/modal. O contrato abaixo é exatamente o que elas usam.
//
// DOMÍNIO REAL de `insumos` (db/schema.sql + migration 0041): codigo_insumo,
// nome, categoria_id, unidade, custo_medio, fornecedor_id, ativo. NÃO existem
// SKU/NCM/descrição/marca/cor/imagem/estoque mínimo/localização — e o smoke
// trava essa verdade: um campo que não existe no banco não pode aparecer no
// formulário.
{
  const meta = await req('GET', '/meta');
  const insumos = meta.json?.resources?.insumos;
  check('insumos: /meta NÃO declara drawer/modal (formulário é página)', !('editor' in (insumos || {})), `editor=${insumos?.editor}`);
  check('insumos: cadastro por empresa (empresa: true)', insumos?.empresa === true, `empresa=${insumos?.empresa}`);
  check('insumos: RBAC preservado — SEM minPerfilEscrita (é cadastro por empresa)', insumos?.minPerfilEscrita === undefined, `minPerfilEscrita=${insumos?.minPerfilEscrita}`);
  check('insumos: /meta entrega os filtros rápidos Todos/Ativos/Inativos',
    JSON.stringify(insumos?.quickFilters?.[0]?.options?.map((o) => o.label)) === JSON.stringify(['Todos', 'Ativos', 'Inativos']));
  check('insumos: /meta declara a utilização real pelas fichas técnicas',
    insumos?.uso?.recurso === 'itens_ficha_tecnica' && insumos?.uso?.campo === 'insumo_id',
    JSON.stringify(insumos?.uso));
  check('insumos: /meta declara o filtro de categoria (server-side)',
    Array.isArray(insumos?.filterFields) && insumos.filterFields.includes('categoria_id'),
    JSON.stringify(insumos?.filterFields));

  // NENHUM campo inventado no formulário. `codigo_insumo` e `categoria_id`
  // EXISTEM em `insumos` (migration 0041) — identificador operacional e
  // agrupamento, não campos inventados.
  const camposInsumo = (insumos?.fields || []).map((f) => f.name);
  check('insumos: o formulário usa só os campos reais do banco',
    ['codigo_insumo', 'nome', 'categoria_id', 'unidade', 'custo_medio', 'fornecedor_id', 'ativo'].every((c) => camposInsumo.includes(c)) &&
    !camposInsumo.some((c) => ['sku', 'ncm', 'descricao', 'marca', 'cor_id', 'imagem', 'estoque_min', 'estoque_max', 'localizacao'].includes(c)),
    `campos=${camposInsumo.join(',')}`);
  check('insumos: a categoria do formulário é a taxonomia PRÓPRIA (categorias_insumos)',
    insumos?.fields?.find((f) => f.name === 'categoria_id')?.ref === 'categorias_insumos');

  // Categoria de insumo: cadastro POR EMPRESA, taxonomia própria, página própria.
  const categoriasIns = meta.json?.resources?.categorias_insumos;
  check('categorias_insumos: cadastro por empresa', categoriasIns?.empresa === true, `empresa=${categoriasIns?.empresa}`);
  check('categorias_insumos: taxonomia própria (não é a categoria de produto)',
    (categoriasIns?.fields || []).map((f) => f.name).join(',') === 'nome,descricao,pai_id,ativo,criado_em,atualizado_em',
    (categoriasIns?.fields || []).map((f) => f.name).join(','));

  // Fornecedor: a referência real (fornecedor_id → fornecedores), com as
  // opções do endpoint padrão de opções (nenhum endpoint paralelo).
  const fornecedor = await req('POST', '/fornecedores', { nome: `Fornecedor Smoke ${Date.now().toString().slice(-6)}` });
  check('insumos: o fornecedor do smoke foi cadastrado', [200, 201].includes(fornecedor.status), `status ${fornecedor.status}`);
  const opcoesForn = await req('GET', '/fornecedores/options');
  check('insumos: /fornecedores/options alimenta a seleção do fornecedor',
    Array.isArray(opcoesForn.json) && opcoesForn.json.some((o) => Number(o.value) === Number(fornecedor.json?.id)),
    `${Array.isArray(opcoesForn.json) ? opcoesForn.json.length : 0} opções`);

  // Cadastro pela PÁGINA: o mesmo contrato do CRUD genérico.
  const categoriaIns = await req('POST', '/categorias_insumos', { nome: `Malhas Smoke ${Date.now().toString().slice(-6)}` });
  check('insumos: a categoria de insumo do smoke foi cadastrada', [200, 201].includes(categoriaIns.status), `status ${categoriaIns.status} ${msg(categoriaIns.json)}`);
  const codigoIns = `INS-SMK-${Date.now().toString().slice(-6)}`;
  const criado = await req('POST', '/insumos', {
    codigo_insumo: codigoIns,
    nome: `Insumo Smoke ${Date.now().toString().slice(-6)}`,
    categoria_id: categoriaIns.json?.id,
    unidade: 'm',
    custo_medio: 7.5,
    fornecedor_id: fornecedor.json?.id,
    ativo: true,
  });
  check('insumos: POST cria o insumo com o contrato real', [200, 201].includes(criado.status) && !!criado.json?.id, `status ${criado.status}`);
  const insumoId = criado.json?.id;

  // Código operacional: único por empresa, entra na BUSCA (server-side).
  const buscaCodigo = await req('GET', `/insumos?q=${encodeURIComponent(codigoIns)}`);
  check('insumos: a busca encontra o insumo pelo CÓDIGO (server-side)',
    buscaCodigo.json?.rows?.some((r) => Number(r.id) === Number(insumoId)), `status ${buscaCodigo.status}`);
  const codigoDup = await req('POST', '/insumos', { codigo_insumo: codigoIns, nome: `Duplicado ${Date.now()}`, unidade: 'm' });
  check('insumos: código repetido na MESMA empresa é recusado (409)', codigoDup.status === 409, `status ${codigoDup.status}`);

  // Listagem: busca + filtro de status + filtro de unidade + filtro de categoria.
  const listaIns = await req('GET', `/insumos?q=${encodeURIComponent(criado.json?.nome || '')}`);
  check('insumos: busca por nome na listagem do servidor', listaIns.json?.rows?.some((r) => Number(r.id) === Number(insumoId)));
  check('insumos: a listagem devolve a unidade e o custo médio reais',
    listaIns.json?.rows?.find((r) => Number(r.id) === Number(insumoId))?.unidade === 'm' &&
    Number(listaIns.json?.rows?.find((r) => Number(r.id) === Number(insumoId))?.custo_medio) === 7.5);
  const listaAtivos = await req('GET', '/insumos?f.ativo=true&pageSize=200');
  check('insumos: filtro f.ativo=true', listaAtivos.json?.rows?.some((r) => Number(r.id) === Number(insumoId)));
  const listaPorUnidade = await req('GET', '/insumos?f.unidade=kg&pageSize=200');
  check('insumos: filtro f.unidade recorta no servidor',
    !listaPorUnidade.json?.rows?.some((r) => Number(r.id) === Number(insumoId)));
  const listaPorCategoria = await req('GET', `/insumos?f.categoria_id=${categoriaIns.json?.id}&pageSize=200`);
  check('insumos: filtro f.categoria_id recorta no servidor',
    listaPorCategoria.json?.rows?.some((r) => Number(r.id) === Number(insumoId)));

  // A categoria agrupa: a utilização dela é a contagem REAL de insumos.
  const catsIns = await req('GET', `/categorias_insumos?q=${encodeURIComponent(categoriaIns.json?.nome || '')}`);
  check('insumos: a categoria de insumo conta os insumos vinculados (utilização real)',
    Number(catsIns.json?.rows?.find((r) => Number(r.id) === Number(categoriaIns.json?.id))?.uso_vinculado) === 1,
    `uso=${catsIns.json?.rows?.find((r) => Number(r.id) === Number(categoriaIns.json?.id))?.uso_vinculado}`);

  // ESTOQUE: o saldo REAL de estoque_insumos, agregado no servidor (nunca
  // um N+1, nunca um número inventado). Insumo sem movimentação = null.
  const semSaldo = listaIns.json?.rows?.find((r) => Number(r.id) === Number(insumoId));
  check('insumos: insumo sem movimentação tem estoque null (nunca zero inventado)', semSaldo?.estoque_saldo === null, `estoque_saldo=${semSaldo?.estoque_saldo}`);
  const movInsumo = await req('POST', '/movimentacoes_insumos', {
    tipo: 'entrada',
    insumo_id: insumoId,
    quantidade: 120,
    custo_unitario: 7.5,
    motivo: 'Saldo inicial smoke insumos',
  });
  check('insumos: a movimentação de insumo dá saldo', [200, 201].includes(movInsumo.status), `status ${movInsumo.status}`);
  const listaComSaldo = await req('GET', `/insumos?q=${encodeURIComponent(criado.json?.nome || '')}`);
  check('insumos: a coluna Estoque traz o saldo REAL agregado',
    Number(listaComSaldo.json?.rows?.find((r) => Number(r.id) === Number(insumoId))?.estoque_saldo) === 120,
    `estoque_saldo=${listaComSaldo.json?.rows?.find((r) => Number(r.id) === Number(insumoId))?.estoque_saldo}`);

  // DERIVADOS da ficha: situação, última movimentação e último custo de entrada
  // vêm do estoque real (agregados em lote), nunca de campo manual.
  const linhaDeriv = listaComSaldo.json?.rows?.find((r) => Number(r.id) === Number(insumoId));
  check('insumos: a ficha deriva a situação do estoque (saldo 120 > 0 → normal)',
    linhaDeriv?.estoque_status === 'normal', `estoque_status=${linhaDeriv?.estoque_status}`);
  check('insumos: a ficha deriva a última movimentação e o último custo de entrada',
    linhaDeriv?.ultima_movimentacao_tipo === 'entrada' && !!linhaDeriv?.ultima_movimentacao && Number(linhaDeriv?.ultimo_custo_entrada) === 7.5,
    `tipo=${linhaDeriv?.ultima_movimentacao_tipo} custo=${linhaDeriv?.ultimo_custo_entrada}`);

  // CUSTO MÉDIO: depois da 1ª movimentação é DADO CALCULADO — o servidor recusa
  // um PUT que tente editá-lo à mão (a autoridade é o recebimento de compras).
  const custoManual = await req('PUT', `/insumos/${insumoId}`, { custo_medio: 99 });
  check('insumos: custo médio calculado NÃO é editável à mão (409)',
    custoManual.status === 409, `status ${custoManual.status}`);

  // UTILIZAÇÃO: contagem real das fichas técnicas (agregada, em lote).
  const produtoIns = await req('POST', '/produtos', { sku: `INS-SMOKE-${Date.now().toString().slice(-6)}`, nome: 'Produto Insumo Smoke' });
  const fichaIns = await req('POST', '/fichas', { produto_id: produtoIns.json?.id });
  check('insumos: a ficha técnica do smoke foi criada', [200, 201].includes(fichaIns.status), `status ${fichaIns.status}`);
  const itemFichaIns = await req('POST', `/fichas/${fichaIns.json?.id}/insumos`, { insumo_id: insumoId, consumo: 2, perda_pct: 0 });
  check('insumos: o insumo entrou na ficha técnica', [200, 201].includes(itemFichaIns.status), `status ${itemFichaIns.status}`);
  const listaUso = await req('GET', `/insumos?q=${encodeURIComponent(criado.json?.nome || '')}`);
  const linhaUso = listaUso.json?.rows?.find((r) => Number(r.id) === Number(insumoId));
  check('insumos: Utilização traz a contagem real (fichas técnicas)',
    Number(linhaUso?.uso_vinculado) === 1 && linhaUso?.uso_vinculado_label === '1 ficha técnica',
    `uso=${linhaUso?.uso_vinculado_label}`);

  // Exclusão bloqueada por histórico protegido + saída por desativação.
  const bloqueadaIns = await req('DELETE', `/insumos/${insumoId}`);
  const diagIns = bloqueadaIns.json?.details?.dependencias;
  check('insumos: DELETE vinculado → 409 dependencias_vinculadas',
    bloqueadaIns.status === 409 && bloqueadaIns.json?.code === 'dependencias_vinculadas', `status ${bloqueadaIns.status}`);
  check('insumos: diagnóstico diz onde/quantos/por quê',
    diagIns?.bloqueado === true && diagIns?.modulosBloqueantes?.length > 0 &&
    diagIns?.vinculos?.some((v) => v.quantidade >= 1 && Array.isArray(v.ids) && v.motivo));
  const desativadoIns = await req('PUT', `/insumos/${insumoId}`, { ativo: false });
  check('insumos: desativar preserva o insumo e o histórico',
    desativadoIns.status === 200 && desativadoIns.json?.ativo === false, `status ${desativadoIns.status}`);
  const aindaLa = await req('GET', `/insumos/${insumoId}`);
  check('insumos: o insumo desativado continua na leitura', aindaLa.status === 200 && aindaLa.json?.ativo === false);
  const saldoApos = await req('GET', `/insumos?q=${encodeURIComponent(criado.json?.nome || '')}`);
  check('insumos: o saldo do insumo desativado continua no estoque',
    Number(saldoApos.json?.rows?.find((r) => Number(r.id) === Number(insumoId))?.estoque_saldo) === 120);

  // Insumo sem vínculo segue o fluxo normal de exclusão.
  const semUsoIns = await req('POST', '/insumos', { nome: `Insumo sem uso ${Date.now().toString().slice(-6)}`, unidade: 'un' });
  const excluidaIns = await req('DELETE', `/insumos/${semUsoIns.json?.id}`);
  check('insumos: DELETE sem vínculo segue o fluxo normal', [200, 204].includes(excluidaIns.status), `status ${excluidaIns.status}`);
}

// --------------------------- CADASTROS › FORNECEDORES (padrão LISTA → PÁGINA)
// Fornecedores seguem o mesmo padrão de Cores, Coleções, Grades e Insumos: o
// formulário vive nas páginas /fornecedores/novo e /fornecedores/:id/editar —
// `/meta` não declara drawer/modal. O contrato abaixo é exatamente o que elas
// usam (o MESMO contrato genérico de antes: POST/PUT/DELETE /fornecedores).
//
// DOMÍNIO REAL de `fornecedores` (db/schema.sql + migration 0021): nome,
// pessoa (pf/pj/estrangeiro), cnpj (CPF/CNPJ com dígito verificador),
// razao_social, nome_fantasia, fiscal (ie, indicador_ie, im), endereço,
// contato (contato, telefone, whatsapp, email), comercial (prazo_entrega_dias,
// condicao_pagamento, observacoes) e ativo. NÃO existem código/SKU próprio,
// NCM, categoria, limite de crédito, banco/PIX, foto ou tabela de preços — e
// o smoke trava essa verdade.
{
  const meta = await req('GET', '/meta');
  const forn = meta.json?.resources?.fornecedores;
  check('fornecedores: /meta NÃO declara drawer/modal (formulário é página)', !('editor' in (forn || {})), `editor=${forn?.editor}`);
  check('fornecedores: cadastro por empresa (empresa: true)', forn?.empresa === true, `empresa=${forn?.empresa}`);
  check('fornecedores: RBAC preservado — SEM minPerfilEscrita (é cadastro por empresa)', forn?.minPerfilEscrita === undefined, `minPerfilEscrita=${forn?.minPerfilEscrita}`);
  check('fornecedores: /meta entrega os filtros rápidos Todos/Ativos/Inativos',
    JSON.stringify(forn?.quickFilters?.[0]?.options?.map((o) => o.label)) === JSON.stringify(['Todos', 'Ativos', 'Inativos']));
  check('fornecedores: /meta declara os filtros reais (pessoa, uf, ativo)',
    JSON.stringify(forn?.filterFields) === JSON.stringify(['pessoa', 'uf', 'ativo']),
    `filterFields=${JSON.stringify(forn?.filterFields)}`);
  check('fornecedores: /meta declara a utilização real pelos pedidos de compra',
    forn?.uso?.recurso === 'compras' && forn?.uso?.campo === 'fornecedor_id',
    JSON.stringify(forn?.uso));
  check('fornecedores: /meta declara as seções reais do formulário',
    ['Identificação', 'Fiscal', 'Endereço', 'Contato', 'Comercial'].every((s) =>
      (forn?.fields || []).some((f) => f.section === s)));

  // NENHUM campo inventado no formulário.
  const camposForn = (forn?.fields || []).map((f) => f.name);
  check('fornecedores: o formulário usa só os campos reais do banco',
    ['nome', 'pessoa', 'cnpj', 'razao_social', 'nome_fantasia', 'ie', 'indicador_ie', 'im', 'cep', 'logradouro',
     'numero', 'complemento', 'bairro', 'cidade', 'uf', 'codigo_municipio', 'contato', 'telefone', 'whatsapp',
     'email', 'prazo_entrega_dias', 'condicao_pagamento', 'observacoes', 'ativo'].every((c) => camposForn.includes(c)) &&
    !camposForn.some((c) => ['sku', 'codigo', 'codigo_fornecedor', 'ncm', 'categoria_id', 'limite_credito', 'banco',
      'pix', 'agencia', 'conta', 'foto', 'imagem', 'tabela_preco'].includes(c)),
    `campos=${camposForn.join(',')}`);

  // Cadastro pela PÁGINA: o mesmo contrato do CRUD genérico. PJ com CNPJ
  // mascarado — o servidor confere o dígito verificador e grava só dígitos.
  // (CNPJ 12.345.678/0001-95 é válido; o smoke E3.1 usa outro documento.)
  const criadoForn = await req('POST', '/fornecedores', {
    nome: `Têxtil Smoke ${Date.now().toString().slice(-6)}`,
    pessoa: 'pj',
    cnpj: '12.345.678/0001-95',
    cidade: 'Goiânia',
    uf: 'GO',
    telefone: '+55 (62) 3333-4444',
    email: 'smoke@textil.com.br',
    ativo: true,
  });
  check('fornecedores: POST cria o fornecedor com o contrato real', [200, 201].includes(criadoForn.status) && !!criadoForn.json?.id, `status ${criadoForn.status} ${msg(criadoForn.json)}`);
  const fornId = criadoForn.json?.id;
  check('fornecedores: CNPJ normalizado para dígitos e telefone canônico',
    criadoForn.json?.cnpj === '12345678000195' && criadoForn.json?.telefone === '6233334444',
    `cnpj=${criadoForn.json?.cnpj} telefone=${criadoForn.json?.telefone}`);

  // Documento inválido (dígito verificador errado) é recusado com erro no campo.
  const docInvalido = await req('POST', '/fornecedores', { nome: 'Doc inválido Smoke', cnpj: '12345678000196' });
  check('fornecedores: CNPJ com dígito verificador errado → 400 com erro no campo cnpj',
    docInvalido.status === 400 && !!docInvalido.json?.fields?.cnpj,
    `status ${docInvalido.status} ${msg(docInvalido.json)}`);

  // PF com CPF válido (529.982.247-25): o dicionário pf/pj/estrangeiro é o do
  // servidor e a mesma validação de documento se aplica.
  const criadoPf = await req('POST', '/fornecedores', { nome: `PF Smoke ${Date.now().toString().slice(-6)}`, pessoa: 'pf', cnpj: '529.982.247-25' });
  check('fornecedores: PF criada com CPF válido (dígitos normalizados)',
    [200, 201].includes(criadoPf.status) && criadoPf.json?.cnpj === '52998224725',
    `status ${criadoPf.status} cnpj=${criadoPf.json?.cnpj}`);

  // Listagem: busca por nome e por dígitos do documento + filtros reais.
  const listaForn = await req('GET', `/fornecedores?q=${encodeURIComponent(criadoForn.json?.nome || '')}`);
  check('fornecedores: busca por nome na listagem do servidor', listaForn.json?.rows?.some((r) => Number(r.id) === Number(fornId)));
  const porDoc = await req('GET', '/fornecedores?q=12345678000195');
  check('fornecedores: busca por dígitos do CNPJ encontra o registro', porDoc.json?.rows?.some((r) => Number(r.id) === Number(fornId)));
  const porCpf = await req('GET', '/fornecedores?q=52998224725');
  check('fornecedores: busca por dígitos do CPF encontra o registro', porCpf.json?.rows?.some((r) => Number(r.id) === Number(criadoPf.json?.id)));
  const porPessoa = await req('GET', '/fornecedores?f.pessoa=pf&pageSize=200');
  check('fornecedores: filtro f.pessoa recorta no servidor',
    porPessoa.json?.rows?.some((r) => Number(r.id) === Number(criadoPf.json?.id)) &&
    !porPessoa.json?.rows?.some((r) => Number(r.id) === Number(fornId)));
  const porUf = await req('GET', '/fornecedores?f.uf=GO&pageSize=200');
  check('fornecedores: filtro f.uf recorta no servidor', porUf.json?.rows?.some((r) => Number(r.id) === Number(fornId)));
  const porAtivo = await req('GET', '/fornecedores?f.ativo=true&pageSize=200');
  check('fornecedores: filtro f.ativo=true', porAtivo.json?.rows?.some((r) => Number(r.id) === Number(fornId)));

  // Leitura e edição pelo contrato genérico (a página /fornecedores/:id/editar).
  const lidoForn = await req('GET', `/fornecedores/${fornId}`);
  check('fornecedores: GET /:id devolve o registro', lidoForn.status === 200 && lidoForn.json?.id === fornId, `status ${lidoForn.status}`);
  const editadoForn = await req('PUT', `/fornecedores/${fornId}`, { nome_fantasia: 'Smoke Malharia', condicao_pagamento: '30/60/90 dias' });
  check('fornecedores: PUT edita pelo contrato real',
    editadoForn.status === 200 && editadoForn.json?.nome_fantasia === 'Smoke Malharia', `status ${editadoForn.status}`);

  // UTILIZAÇÃO: contagem real dos pedidos de compra (agregada, em lote).
  const compraForn = await req('POST', '/compras', { fornecedor_id: fornId, data: '2026-10-01' });
  check('fornecedores: a compra do smoke foi criada', [200, 201].includes(compraForn.status), `status ${compraForn.status} ${msg(compraForn.json)}`);
  const listaUsoForn = await req('GET', `/fornecedores?q=${encodeURIComponent(criadoForn.json?.nome || '')}`);
  const linhaUsoForn = listaUsoForn.json?.rows?.find((r) => Number(r.id) === Number(fornId));
  check('fornecedores: Utilização traz a contagem real (pedidos de compra)',
    Number(linhaUsoForn?.uso_vinculado) === 1 && linhaUsoForn?.uso_vinculado_label === '1 compra',
    `uso=${linhaUsoForn?.uso_vinculado_label}`);

  // Exclusão bloqueada por histórico protegido + saída por desativação.
  const bloqueadaForn = await req('DELETE', `/fornecedores/${fornId}`);
  const diagForn = bloqueadaForn.json?.details?.dependencias;
  check('fornecedores: DELETE vinculado → 409 dependencias_vinculadas',
    bloqueadaForn.status === 409 && bloqueadaForn.json?.code === 'dependencias_vinculadas', `status ${bloqueadaForn.status}`);
  check('fornecedores: diagnóstico diz onde/quantos/por quê (Compras)',
    diagForn?.bloqueado === true && diagForn?.modulosBloqueantes?.includes('Compras') &&
    diagForn?.vinculos?.some((v) => v.tabela === 'compras' && v.quantidade >= 1 && Array.isArray(v.ids) && v.motivo));
  const sobreviveu = await req('GET', `/fornecedores/${fornId}`);
  check('fornecedores: nada foi apagado — o registro permanece', sobreviveu.status === 200);
  const desativadoForn = await req('PUT', `/fornecedores/${fornId}`, { ativo: false });
  check('fornecedores: desativar preserva o fornecedor e o histórico',
    desativadoForn.status === 200 && desativadoForn.json?.ativo === false, `status ${desativadoForn.status}`);
  const aindaLaForn = await req('GET', `/fornecedores/${fornId}`);
  check('fornecedores: o fornecedor desativado continua na leitura', aindaLaForn.status === 200 && aindaLaForn.json?.ativo === false);
  const compraIntacta = await req('GET', `/compras/${compraForn.json?.id}`);
  check('fornecedores: a compra continua apontando para o fornecedor desativado',
    compraIntacta.status === 200 && Number(compraIntacta.json?.fornecedor_id) === Number(fornId));
  const listaInativos = await req('GET', '/fornecedores?f.ativo=false&pageSize=200');
  check('fornecedores: o desativado aparece no filtro de inativos', listaInativos.json?.rows?.some((r) => Number(r.id) === Number(fornId)));

  // Fornecedor sem vínculo segue o fluxo normal de exclusão.
  const semUsoForn = await req('POST', '/fornecedores', { nome: `Fornecedor sem uso ${Date.now().toString().slice(-6)}` });
  const excluidaForn = await req('DELETE', `/fornecedores/${semUsoForn.json?.id}`);
  check('fornecedores: DELETE sem vínculo segue o fluxo normal', [200, 204].includes(excluidaForn.status), `status ${excluidaForn.status}`);
  const sumiu = await req('GET', `/fornecedores/${semUsoForn.json?.id}`);
  check('fornecedores: o excluído some da leitura (404)', sumiu.status === 404, `status ${sumiu.status}`);
}
// --------------------------- CADASTROS › REPRESENTANTES (padrão LISTA → PÁGINA)
// Representantes seguem o mesmo padrão de Cores, Coleções, Grades, Insumos e
// Fornecedores: o formulário vive nas páginas /representantes/novo e
// /representantes/:id/editar — `/meta` não declara drawer/modal. O contrato
// abaixo é exatamente o que elas usam (o MESMO contrato genérico de antes:
// POST/PUT/DELETE /representantes).
//
// DOMÍNIO REAL de `representantes` (db/schema.sql + migration 0021): nome,
// cpf (único por empresa), cargo, regiao, comissao_pct, usuario_id (vínculo
// opcional e único por empresa), telefone, whatsapp, email, admissao,
// desligamento, observacoes e ativo. NÃO existem salário, meta, limite de
// crédito, banco/PIX, foto, ranking, faturamento nem "vendas totais" — e o
// smoke trava essa verdade.
//
// A UNICIDADE (CPF e usuário por empresa) é índice do BANCO: fica coberta em
// test/pg/representantes-pg.test.ts, não aqui (o modo demonstração não impõe
// índice único).
{
  const meta = await req('GET', '/meta');
  const rep = meta.json?.resources?.representantes;
  check('representantes: /meta NÃO declara drawer/modal (formulário é página)', !('editor' in (rep || {})), `editor=${rep?.editor}`);
  check('representantes: cadastro por empresa (empresa: true)', rep?.empresa === true, `empresa=${rep?.empresa}`);
  check('representantes: RBAC preservado — SEM minPerfilEscrita (é cadastro por empresa)', rep?.minPerfilEscrita === undefined, `minPerfilEscrita=${rep?.minPerfilEscrita}`);
  check('representantes: /meta entrega os filtros rápidos Todos/Ativos/Inativos',
    JSON.stringify(rep?.quickFilters?.[0]?.options?.map((o) => o.label)) === JSON.stringify(['Todos', 'Ativos', 'Inativos']));
  check('representantes: /meta declara os filtros reais (tipo, pessoa, território, usuário, ativo)',
    JSON.stringify(rep?.filterFields) === JSON.stringify(['tipo_representante', 'tipo_pessoa', 'territorio_id', 'usuario_id', 'ativo']),
    `filterFields=${JSON.stringify(rep?.filterFields)}`);
  check('representantes: /meta declara a utilização real pelos pedidos de venda',
    rep?.uso?.recurso === 'vendas' && rep?.uso?.campo === 'representante_id',
    JSON.stringify(rep?.uso));
  check('representantes: /meta declara as seções reais do formulário 2.0',
    ['Identificação', 'Dados profissionais', 'Contato', 'Endereço', 'Comercial', 'Acesso ao ERP', 'Observações'].every((sec) =>
      (rep?.fields || []).some((f) => f.section === sec)));

  // NENHUM campo inventado no formulário.
  const camposRep = (rep?.fields || []).map((f) => f.name);
  check('representantes: o formulário usa só os campos reais do banco (cadastro mestre 2.0)',
    ['codigo', 'tipo_pessoa', 'nome', 'razao_social', 'nome_fantasia', 'cpf', 'cnpj', 'data_nascimento',
      'tipo_representante', 'cargo', 'registro_profissional', 'orgao_registro', 'admissao', 'desligamento',
      'ativo', 'telefone', 'celular', 'whatsapp', 'email', 'cep', 'logradouro', 'numero', 'complemento',
      'bairro', 'cidade', 'uf', 'pais', 'comissao_pct', 'territorio_id', 'regiao', 'usuario_id',
      'observacoes'].every((c) => camposRep.includes(c)) &&
    !camposRep.some((c) => ['salario', 'meta', 'limite_credito', 'banco', 'pix', 'agencia', 'conta', 'foto',
      'imagem', 'ranking', 'faturamento', 'comissao_acumulada', 'vendas_total', 'departamento'].includes(c)),
    `campos=${camposRep.join(',')}`);

  // Cadastro pela PÁGINA: mesmo contrato do CRUD genérico. CPF mascarado — o
  // servidor confere o dígito verificador e grava só dígitos.
  const criadoRep = await req('POST', '/representantes', {
    nome: `Ana Smoke ${Date.now().toString().slice(-6)}`,
    cpf: '529.982.247-25',
    cargo: 'Vendedora',
    regiao: 'Centro-Oeste',
    comissao_pct: 3.5,
    telefone: '+55 (62) 3333-4444',
    whatsapp: '(62) 99999-8888',
    email: 'ana.smoke@brobond.com.br',
    admissao: '2024-03-01',
    ativo: true,
  });
  check('representantes: POST cria o representante com o contrato real',
    [200, 201].includes(criadoRep.status) && !!criadoRep.json?.id,
    `status ${criadoRep.status} ${msg(criadoRep.json)}`);
  const repId = criadoRep.json?.id;
  check('representantes: CPF normalizado para dígitos e telefone canônico',
    criadoRep.json?.cpf === '52998224725' && criadoRep.json?.telefone === '6233334444',
    `cpf=${criadoRep.json?.cpf} telefone=${criadoRep.json?.telefone}`);
  check('representantes: comissão padrão em % gravada como número',
    Number(criadoRep.json?.comissao_pct) === 3.5, `comissao_pct=${criadoRep.json?.comissao_pct}`);
  // 2.0 — código comercial gerado, tipo de representante e contato profissional.
  check('representantes: código comercial gerado (REP00001) e único por empresa',
    /^REP\d{5}$/.test(String(criadoRep.json?.codigo || '')), `codigo=${criadoRep.json?.codigo}`);
  check('representantes: celular normalizado como telefone profissional',
    criadoRep.json?.celular === null || /^\d{10,11}$/.test(String(criadoRep.json?.celular || '')), `celular=${criadoRep.json?.celular}`);
  check('representantes: tipo de representante tem default de PAPEL comercial (não o cargo)',
    String(criadoRep.json?.tipo_representante || '') === 'REPRESENTANTE_COMERCIAL' &&
      criadoRep.json?.cargo === 'Vendedora',
    `tipo=${criadoRep.json?.tipo_representante} cargo=${criadoRep.json?.cargo}`);

  // 2.0 — PJ usa CNPJ (nunca CPF) e o documento é gravado sem máscara.
  const sufixoSmoke = Date.now().toString().slice(-6);
  const repPj = await req('POST', '/representantes', {
    nome: `Distribuidora Smoke ${sufixoSmoke}`,
    tipo_pessoa: 'PJ',
    cnpj: '11.222.333/0001-81',
    razao_social: 'Distribuidora Smoke Ltda',
    tipo_representante: 'PARCEIRO',
    cargo: 'Parceiro comercial',
  });
  check('representantes: PJ exige e normaliza o CNPJ',
    [200, 201].includes(repPj.status) && repPj.json?.cnpj === '11222333000181' && repPj.json?.tipo_pessoa === 'PJ',
    `status ${repPj.status} ${msg(repPj.json)}`);
  const pjSemCnpj = await req('POST', '/representantes', { nome: `PJ sem CNPJ ${sufixoSmoke}`, tipo_pessoa: 'PJ' });
  check('representantes: PJ sem CNPJ → 400 com erro no campo cnpj',
    pjSemCnpj.status === 400 && !!pjSemCnpj.json?.fields?.cnpj,
    `status ${pjSemCnpj.status} ${msg(pjSemCnpj.json)}`);
  const pfComCnpj = await req('POST', '/representantes', { nome: `PF com CNPJ ${sufixoSmoke}`, tipo_pessoa: 'PF', cnpj: '11222333000181' });
  check('representantes: PF com CNPJ → 400 (documento incoerente com o tipo de pessoa)',
    pfComCnpj.status === 400 && !!pfComCnpj.json?.fields?.cnpj,
    `status ${pfComCnpj.status} ${msg(pfComCnpj.json)}`);

  // 2.0 — endereço ESTRUTURADO: CEP/UF canônicos e país padrão.
  const repEndereco = await req('POST', '/representantes', {
    nome: `Endereço Smoke ${sufixoSmoke}`,
    cep: '74.000-000',
    logradouro: 'Avenida Central',
    numero: '100',
    bairro: 'Setor Bueno',
    cidade: 'Goiânia',
    uf: 'go',
  });
  check('representantes: endereço estruturado normalizado (CEP, UF, país)',
    [200, 201].includes(repEndereco.status) && repEndereco.json?.cep === '74000000' &&
      repEndereco.json?.uf === 'GO' && repEndereco.json?.pais === 'Brasil' && repEndereco.json?.cidade === 'Goiânia',
    `status ${repEndereco.status} cep=${repEndereco.json?.cep} uf=${repEndereco.json?.uf} pais=${repEndereco.json?.pais}`);

  // CPF com dígito verificador errado é recusado com erro no campo.
  const cpfInvalido = await req('POST', '/representantes', { nome: 'CPF inválido Smoke', cpf: '11144477736' });
  check('representantes: CPF com dígito verificador errado → 400 com erro no campo cpf',
    cpfInvalido.status === 400 && !!cpfInvalido.json?.fields?.cpf,
    `status ${cpfInvalido.status} ${msg(cpfInvalido.json)}`);

  // Segundo representante com vínculo REAL ao usuário do sistema (opcional):
  // é o que o filtro `f.usuario_id` da tela recorta.
  const opcoesUsuarios = await req('GET', '/usuarios/options');
  const usuarioId = Array.isArray(opcoesUsuarios.json) ? opcoesUsuarios.json[0]?.value : null;
  let repComUsuario = null;
  if (usuarioId != null) {
    repComUsuario = await req('POST', '/representantes', {
      nome: `Carlos Smoke ${Date.now().toString().slice(-6)}`,
      cargo: 'Representante',
      regiao: 'Norte',
      usuario_id: usuarioId,
      ativo: true,
    });
    check('representantes: vínculo OPCIONAL com o usuário do sistema (mesma empresa)',
      [200, 201].includes(repComUsuario.status) && Number(repComUsuario.json?.usuario_id) === Number(usuarioId),
      `status ${repComUsuario.status} ${msg(repComUsuario.json)}`);
  }

  // Busca (server-side): nome, CPF com e sem máscara, cargo, região, telefone,
  // WhatsApp e e-mail — os campos `search: true` do recurso.
  const nomeRep = String(criadoRep.json?.nome || '');
  const porNomeRep = await req('GET', `/representantes?q=${encodeURIComponent(nomeRep)}`);
  check('representantes: busca por nome na listagem do servidor', porNomeRep.json?.rows?.some((r) => Number(r.id) === Number(repId)));
  const porCpfDigitos = await req('GET', '/representantes?q=52998224725');
  check('representantes: busca por dígitos do CPF encontra o registro', porCpfDigitos.json?.rows?.some((r) => Number(r.id) === Number(repId)));
  const porCpfMascara = await req('GET', `/representantes?q=${encodeURIComponent('529.982.247-25')}`);
  check('representantes: busca pelo CPF COM máscara encontra o mesmo registro', porCpfMascara.json?.rows?.some((r) => Number(r.id) === Number(repId)));
  const porCargoRep = await req('GET', '/representantes?q=Vendedora');
  check('representantes: busca por cargo', porCargoRep.json?.rows?.some((r) => Number(r.id) === Number(repId)));
  const porRegiaoRep = await req('GET', '/representantes?q=Centro-Oeste');
  check('representantes: busca por região', porRegiaoRep.json?.rows?.some((r) => Number(r.id) === Number(repId)));
  const porTelefoneRep = await req('GET', '/representantes?q=6233334444');
  check('representantes: busca por telefone', porTelefoneRep.json?.rows?.some((r) => Number(r.id) === Number(repId)));
  const porEmailRep = await req('GET', '/representantes?q=ana.smoke%40brobond.com.br');
  check('representantes: busca por e-mail', porEmailRep.json?.rows?.some((r) => Number(r.id) === Number(repId)));

  // Filtros reais na MESMA listagem paginada (contrato `f.<campo>`).
  const repAtivos = await req('GET', '/representantes?f.ativo=true&pageSize=200');
  check('representantes: filtro f.ativo=true', repAtivos.json?.rows?.some((r) => Number(r.id) === Number(repId)));
  if (repComUsuario?.json?.id != null) {
    const porUsuario = await req('GET', `/representantes?f.usuario_id=${usuarioId}&pageSize=200`);
    check('representantes: filtro f.usuario_id recorta no servidor',
      porUsuario.json?.rows?.some((r) => Number(r.id) === Number(repComUsuario.json.id)) &&
      !porUsuario.json?.rows?.some((r) => Number(r.id) === Number(repId)));
  }

  // 2.0 — filtros de TIPO e de TERRITÓRIO (server-side, mesma listagem).
  const repGerentes = await req('GET', '/representantes?f.tipo_representante=PARCEIRO&pageSize=200');
  check('representantes: filtro f.tipo_representante recorta no servidor',
    repGerentes.json?.rows?.some((r) => Number(r.id) === Number(repPj.json?.id)) &&
      !repGerentes.json?.rows?.some((r) => Number(r.id) === Number(repId)));
  const repPjFiltro = await req('GET', '/representantes?f.tipo_pessoa=PJ&pageSize=200');
  check('representantes: filtro f.tipo_pessoa recorta no servidor',
    repPjFiltro.json?.rows?.some((r) => Number(r.id) === Number(repPj.json?.id)));

  const territorioSmoke = await req('POST', '/territorios', {
    nome: `Território Smoke ${sufixoSmoke}`,
    codigo: `TS${sufixoSmoke}`,
    tipo: 'regiao',
  });
  check('representantes: território criado no DOMÍNIO existente (não há segunda tabela)',
    [200, 201].includes(territorioSmoke.status) && !!territorioSmoke.json?.id,
    `status ${territorioSmoke.status} ${msg(territorioSmoke.json)}`);
  const repComTerritorio = await req('PUT', `/representantes/${repEndereco.json?.id}`, {
    territorio_id: territorioSmoke.json?.id,
    tipo_representante: 'GERENTE',
  });
  check('representantes: vínculo com território estruturado',
    repComTerritorio.status === 200 && Number(repComTerritorio.json?.territorio_id) === Number(territorioSmoke.json?.id),
    `status ${repComTerritorio.status} ${msg(repComTerritorio.json)}`);
  const porTerritorio = await req('GET', `/representantes?f.territorio_id=${territorioSmoke.json?.id}&pageSize=200`);
  check('representantes: filtro f.territorio_id recorta no servidor',
    porTerritorio.json?.rows?.some((r) => Number(r.id) === Number(repEndereco.json?.id)) &&
      !porTerritorio.json?.rows?.some((r) => Number(r.id) === Number(repId)));
  const listaComTerritorio = await req('GET', `/representantes?q=${encodeURIComponent(`Endereço Smoke ${sufixoSmoke}`)}`);
  const linhaTerritorio = listaComTerritorio.json?.rows?.find((r) => Number(r.id) === Number(repEndereco.json?.id));
  check('representantes: a listagem projeta o rótulo do território (join do domínio)',
    String(linhaTerritorio?.territorio_id__label || '') === `Território Smoke ${sufixoSmoke}`,
    `label=${linhaTerritorio?.territorio_id__label}`);
  check('representantes: a listagem projeta equipe e carteira em lote (sem N+1)',
    linhaTerritorio != null && 'equipe_label' in linhaTerritorio && 'carteira_vinculos' in linhaTerritorio);

  // Leitura e edição pelo contrato genérico (a página /representantes/:id/editar).
  const lidoRep = await req('GET', `/representantes/${repId}`);
  check('representantes: GET /:id devolve o registro', lidoRep.status === 200 && lidoRep.json?.id === repId, `status ${lidoRep.status}`);
  const editadoRep = await req('PUT', `/representantes/${repId}`, { cargo: 'Gerente comercial', regiao: 'Sudeste', comissao_pct: 5 });
  check('representantes: PUT edita pelo contrato real',
    editadoRep.status === 200 && editadoRep.json?.cargo === 'Gerente comercial' && Number(editadoRep.json?.comissao_pct) === 5,
    `status ${editadoRep.status} ${msg(editadoRep.json)}`);

  // UTILIZAÇÃO: contagem real dos pedidos de venda (agregada, em lote).
  const clienteRep = await req('POST', '/clientes', { nome: `Cliente Smoke Rep ${Date.now().toString().slice(-6)}`, pessoa: 'pj' });
  check('representantes: cliente do smoke para a venda', [200, 201].includes(clienteRep.status), `status ${clienteRep.status} ${msg(clienteRep.json)}`);
  const vendaRep = await req('POST', '/vendas', { cliente_id: clienteRep.json?.id, representante_id: repId, data: '2026-10-01' });
  check('representantes: a venda do smoke foi criada', [200, 201].includes(vendaRep.status), `status ${vendaRep.status} ${msg(vendaRep.json)}`);
  const listaUsoRep = await req('GET', `/representantes?q=${encodeURIComponent(nomeRep)}`);
  const linhaUsoRep = listaUsoRep.json?.rows?.find((r) => Number(r.id) === Number(repId));
  check('representantes: Utilização traz a contagem real (pedidos de venda)',
    Number(linhaUsoRep?.uso_vinculado) === 1 && linhaUsoRep?.uso_vinculado_label === '1 venda',
    `uso=${linhaUsoRep?.uso_vinculado_label}`);

  // 2.0 — PAINEL da página /representantes/:id (derivado, nada digitado).
  const painelRep = await req('GET', `/comercial/representantes/${repId}/painel`);
  check('representantes: painel do representante responde com cadastro + estrutura + carteira + metas + comissão',
    painelRep.status === 200 && Number(painelRep.json?.representante?.id) === Number(repId) &&
      painelRep.json?.estrutura != null && painelRep.json?.carteira != null &&
      painelRep.json?.metas != null && painelRep.json?.comissao != null && painelRep.json?.ranking != null,
    `status ${painelRep.status} ${msg(painelRep.json)}`);
  // O representante do smoke tem 1 venda PENDENTE (não faturada): o painel não
  // pode inventar faturamento nem ranking — o realizado só existe com venda
  // faturada, e o ranking é recortado pela mesma fonte.
  check('representantes: o painel NÃO inventa faturamento (venda pendente não conta)',
    Number(painelRep.json?.indicadores?.faturamento) === 0 &&
      Number(painelRep.json?.ranking?.faturamento) === 0 &&
      painelRep.json?.ranking?.posicao === null,
    `faturamento=${painelRep.json?.indicadores?.faturamento} ranking=${JSON.stringify(painelRep.json?.ranking)}`);

  // Exclusão bloqueada por histórico protegido + saída por desativação.
  const bloqueadaRep = await req('DELETE', `/representantes/${repId}`);
  const diagRep = bloqueadaRep.json?.details?.dependencias;
  check('representantes: DELETE vinculado → 409 dependencias_vinculadas',
    bloqueadaRep.status === 409 && bloqueadaRep.json?.code === 'dependencias_vinculadas', `status ${bloqueadaRep.status}`);
  check('representantes: diagnóstico diz onde/quantos/por quê (Vendas)',
    diagRep?.bloqueado === true && diagRep?.modulosBloqueantes?.includes('Vendas') &&
    diagRep?.vinculos?.some((v) => v.tabela === 'vendas' && v.quantidade >= 1 && Array.isArray(v.ids) && v.motivo));
  const sobreviveuRep = await req('GET', `/representantes/${repId}`);
  check('representantes: nada foi apagado — o registro permanece', sobreviveuRep.status === 200);
  const desativadoRep = await req('PUT', `/representantes/${repId}`, { ativo: false });
  check('representantes: desativar preserva o representante e o histórico',
    desativadoRep.status === 200 && desativadoRep.json?.ativo === false, `status ${desativadoRep.status}`);
  const desligadoRep = await req('PUT', `/representantes/${repId}`, { desligamento: '2026-01-31' });
  check('representantes: desligamento registra a situação profissional (não apaga histórico)',
    desligadoRep.status === 200 && String(desligadoRep.json?.desligamento || '').slice(0, 10) === '2026-01-31',
    `status ${desligadoRep.status}`);
  const aindaLaRep = await req('GET', `/representantes/${repId}`);
  check('representantes: o representante desativado continua na leitura', aindaLaRep.status === 200 && aindaLaRep.json?.ativo === false);
  const vendaIntactaRep = await req('GET', `/vendas/${vendaRep.json?.id}`);
  check('representantes: a venda continua apontando para o representante desativado',
    vendaIntactaRep.status === 200 && Number(vendaIntactaRep.json?.representante_id) === Number(repId));
  const listaInativosRep = await req('GET', '/representantes?f.ativo=false&pageSize=200');
  check('representantes: o desativado aparece no filtro de inativos', listaInativosRep.json?.rows?.some((r) => Number(r.id) === Number(repId)));

  // Representante sem vínculo segue o fluxo normal de exclusão.
  const semUsoRep = await req('POST', '/representantes', { nome: `Representante sem uso ${Date.now().toString().slice(-6)}` });
  const excluidaRep = await req('DELETE', `/representantes/${semUsoRep.json?.id}`);
  check('representantes: DELETE sem vínculo segue o fluxo normal', [200, 204].includes(excluidaRep.status), `status ${excluidaRep.status}`);
  const sumiuRep = await req('GET', `/representantes/${semUsoRep.json?.id}`);
  check('representantes: o excluído some da leitura (404)', sumiuRep.status === 404, `status ${sumiuRep.status}`);
}
// ---------------------------------------------------------------- CRM 3.0
// Funil Lead → Oportunidade pela superfície HTTP real: rota registrada,
// RBAC do recurso, conversão transacional/idempotente e coerência de funil.
{
  const sufixo = Date.now().toString().slice(-6);
  const lead = await req('POST', '/crm_leads', {
    nome: `Lead smoke ${sufixo}`,
    origem: 'site',
    status: 'novo',
    valor_estimado: '4800,00',
    probabilidade: 40,
    previsao_contato: '2026-12-31',
  });
  check('CRM: POST /crm_leads cria lead', [200, 201].includes(lead.status), `status ${lead.status} ${msg(lead.json)}`);
  const leadId = lead.json?.id;

  const conversao = await req('POST', `/crm/leads/${leadId}/converter`, { etapa: 'qualificacao' });
  check('CRM: POST /crm/leads/:id/converter → 201', conversao.status === 201, `status ${conversao.status} ${msg(conversao.json)}`);
  check('CRM: conversão devolve oportunidade vinculada ao lead',
    Number(conversao.json?.oportunidade?.lead_id) === Number(leadId),
    `oportunidade=${conversao.json?.oportunidade_id}`);

  const repetida = await req('POST', `/crm/leads/${leadId}/converter`, {});
  check('CRM: conversão repetida é idempotente (200, mesma oportunidade)',
    repetida.status === 200 && repetida.json?.idempotente === true &&
    Number(repetida.json?.oportunidade_id) === Number(conversao.json?.oportunidade_id),
    `status ${repetida.status} id=${repetida.json?.oportunidade_id}`);

  const doLead = await req('GET', `/crm_oportunidades?f.lead_id=${leadId}&pageSize=50`);
  check('CRM: o lead convertido tem exatamente UMA oportunidade',
    doLead.status === 200 && (doLead.json?.rows || []).length === 1,
    `total=${doLead.json?.total}`);

  const leadDepois = await req('GET', `/crm_leads/${leadId}`);
  check('CRM: lead marcado como convertido e promovido a qualificação',
    leadDepois.status === 200 && !!leadDepois.json?.lead_convertido_em && leadDepois.json?.status === 'qualificacao',
    `status=${leadDepois.json?.status}`);

  const perdaSemMotivo = await req('PUT', `/crm_oportunidades/${conversao.json?.oportunidade_id}`, { status: 'perdida' });
  check('CRM: oportunidade perdida sem motivo → 400',
    perdaSemMotivo.status === 400 && !!perdaSemMotivo.json?.fields?.motivo_perda_id,
    `status ${perdaSemMotivo.status}`);

  const motivo = await req('POST', '/crm_motivos_perda', { nome: `Preço ${sufixo}` });
  const perdida = await req('PUT', `/crm_oportunidades/${conversao.json?.oportunidade_id}`,
    { status: 'perdida', motivo_perda_id: motivo.json?.id });
  check('CRM: fechar como perdida com motivo → 200 e data de fechamento',
    perdida.status === 200 && !!perdida.json?.data_fechamento, `status ${perdida.status}`);

  const etapaCongelada = await req('PUT', `/crm_oportunidades/${conversao.json?.oportunidade_id}`, { etapa: 'proposta' });
  check('CRM: estágio de oportunidade fechada é congelado → 409',
    etapaCongelada.status === 409, `status ${etapaCongelada.status}`);

  const semTokenCrm = await req('POST', `/crm/leads/${leadId}/converter`, {}, null);
  check('CRM: conversão exige autenticação → 401', semTokenCrm.status === 401, `status ${semTokenCrm.status}`);
}

// ---------------------------------------------------------------- RBAC
const semToken = await req('GET', '/logistica/config', null, null);
check('sem token → 401', semToken.status === 401, `status ${semToken.status}`);

const ticketComoBearer = await req('GET', '/logistica/config', null, ticket);
check('ticket de MFA não vale como token de acesso → 401', ticketComoBearer.status === 401, `status ${ticketComoBearer.status}`);

console.log(out.join('\n'));
console.log(`\n${out.length - falhas}/${out.length} verificações OK`);
process.exit(falhas ? 1 : 0);
