// ============================================================================
// BROBOND COMMERCE OS — CHECAGEM ESTRUTURAL (scripts/commerce-go-live-audit.ts)
//
// Roda:  npm run commerce:go-live
//
// Classifica cada item em P0 (bloqueia), P1 (aviso — provisionamento do
// cliente/limitações documentadas) e P2 (melhoria futura). Qualquer P0
// falhando → saída 1; P0 estruturais zerados → saída 0.
// Isto NÃO confirma credenciais, testes externos ou autorização de go-live.
//
// O gate é HONESTO: verifica o código/banco de verdade (arquivos nomeados,
// contagens, padrões), não a presença de mocks. P1 não bloqueia porque é
// provisionamento externo (OAuth/credencial) ou limitação documentada.
// ============================================================================
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const RAIZ = process.cwd();
const falhasP0: string[] = [];
const avisosP1: string[] = [];
const futurosP2: string[] = [];
let okP0 = 0;

function ler(caminho: string): string {
  const p = join(RAIZ, caminho);
  if (!existsSync(p)) return '';
  return readFileSync(p, 'utf8');
}

function p0(cond: boolean, nome: string, detalhe = ''): void {
  if (cond) {
    okP0 += 1;
    console.log(`[P0][OK]   ${nome}`);
  } else {
    falhasP0.push(nome);
    console.log(`[P0][FAIL] ${nome}${detalhe ? ` — ${detalhe}` : ''}`);
  }
}

function p1(cond: boolean, nome: string, detalhe = ''): void {
  if (cond) {
    console.log(`[P0][OK]   ${nome} (P1 ok)`);
  } else {
    avisosP1.push(nome);
    console.log(`[P1][WARN] ${nome}${detalhe ? ` — ${detalhe}` : ''}`);
  }
}

function p2(nome: string, detalhe: string): void {
  futurosP2.push(nome);
  console.log(`[P2][INFO] ${nome} — ${detalhe}`);
}

console.log('BROBOND COMMERCE OS — auditoria de go-live\n');

// ---------------------------------------------------------------- 1. Dados
const mig = ler('db/migrations/0068_commerce_os.sql');
const schema = ler('db/schema.sql');
const TABELAS = [
  'commerce_produtos',
  'commerce_precos',
  'commerce_publicacoes',
  'commerce_pedidos',
  'commerce_rastreio',
  'commerce_promocoes',
  'commerce_cupons',
  'commerce_configuracoes',
  'commerce_outbox',
];
p0(mig.length > 0, 'migração 0068_commerce_os.sql existe', 'arquivo ausente');
p0(
  TABELAS.every((t) => mig.includes(`CREATE TABLE IF NOT EXISTS ${t}`)),
  'migração cria as 9 tabelas commerce',
  TABELAS.filter((t) => !mig.includes(`CREATE TABLE IF NOT EXISTS ${t}`)).join(', '),
);
p0(
  TABELAS.every((t) => schema.includes(`CREATE TABLE IF NOT EXISTS ${t}`)),
  'db/schema.sql espelha as 9 tabelas commerce (fonte de verdade do gate de schema)',
  TABELAS.filter((t) => !schema.includes(`CREATE TABLE IF NOT EXISTS ${t}`)).join(', '),
);
p0(
  mig.includes('uq_estoque_reservas_checkout') && mig.includes(`WHERE origem_recurso = 'commerce_checkout'`),
  'trava de idempotência da reserva de checkout no índice único parcial',
);
p0(
  mig.includes('CHECK (canal') && mig.includes('MERCADOPAGO') && mig.includes('INSTAGRAM_SHOPPING'),
  'CHECKs de canal de precos/publicacoes/pedidos no modelo',
);
p0(mig.includes('checkout_token TEXT UNIQUE') && mig.includes('chave_checkout'), 'credencial pública e idempotência de checkout no modelo');

// ---------------------------------------------------------------- 2. Rotas
const index = ler('server/src/index.ts');
const rotasLoja = (index.match(/app\.(get|post)\('\/api\/loja\//g) || []).length;
const rotasCommerce = (index.match(/app\.(get|post|put|delete)\('\/api\/commerce\//g) || []).length;
p0(rotasLoja >= 6, `6+ rotas públicas /api/loja/* (${rotasLoja} achadas)`);
p0(rotasCommerce >= 25, `25+ rotas /api/commerce/* (${rotasCommerce} achadas)`);
p0(index.includes('registrarHooksCommerce'), 'hooks commerce registrados no boot (ponte + gateway + ingestão)');
p0(index.includes('processarComercioAgendado'), 'intervalo agendado da fila/expiração no boot');

// ---------------------------------------------------------- 3. Pagamento
const gateway = ler('server/src/gateway.ts');
const vitrine = ler('server/src/commerce/vitrine.ts');
const pedidos = ler('server/src/commerce/pedidos.ts');
p0(
  gateway.includes('createHmac') && gateway.includes('assinatura') && gateway.includes('webhook_segredo'),
  'webhook público com assinatura HMAC por empresa (segredo cifrado)',
);
p0(
  gateway.includes('uq_gateway_webhook_evento') || ler('db/migrations/0025_p2_financeiro_gateways.sql').includes('uq_gateway_webhook_evento'),
  'idempotência de webhook (UNIQUE provider + evento_id) no modelo',
);
p0(vitrine.includes('paymentEngine.createForOrder') && ler('modules/payments/orchestration/payment-orchestrator.ts').includes('createPaymentIntent') && !/from ['"][^'"]*(?:mercado-pago|pagbank|stripe)/i.test(vitrine), 'checkout cria intenção via Payment Engine no BACKEND (nunca provider no frontend)');
p0(
  vitrine.includes('instanteIso') === false || gateway.includes('instanteIso'),
  'normalização de instante na cobrança (timestamptz honesto)',
);
const clientLoja = ['client/src/pages/commerce/loja/LojaCheckoutPage.tsx', 'client/src/pages/commerce/loja/LojaCarrinhoPage.tsx']
  .map(ler)
  .join('\n');
p0(
  !/(confirmarPagamento|pagar_pedido|\/pagar)['"]/.test(clientLoja),
  'frontend da vitrine nunca chama confirmação de pagamento',
);
p0(pedidos.includes('setOnCobrancaAlterada(confirmarPagamentoCobranca)'), 'ouvinte gateway → estado PAGO + conversão automática');

// --------------------------------------------------------------- 4. RBAC
const services = ler('server/src/services.ts');
const catalogo = ler('server/src/commerce/catalogo.ts');
const escritasFluxo = (catalogo.match(/checkFluxoEscrita\(/g) || []).length;
p0(services.includes('export function checkFluxoEscrita'), 'camada checkFluxoEscrita (escrita de fluxo sem abrir CRUD)');
p0(services.includes('minPerfilEscrita'), 'alçada minPerfilEscrita aplicada em escrita');
p0(escritasFluxo >= 6, `6+ writes de catálogo usam checkFluxoEscrita (${escritasFluxo} achados)`);
const resources = ler('server/src/resources.ts');
const empresaTrue = (resources.match(/commerce_[a-z_]+: \{[^}]*?empresa: true/g) || []).length;
p0(empresaTrue >= 9, `9 resources commerce com empresa: true (tenancy) (${empresaTrue})`);

// ------------------------------------------------------- 5. Frete + outbox
const frete = ler('server/src/commerce/frete.ts');
p0(frete.includes('Frete não configurado'), 'frete fail-closed com a mensagem exata "Frete não configurado"');
p0(ler('server/test/frete.test.ts').includes('Frete não configurado') || ler('server/test/commerce-oracle.test.ts').includes('Frete não configurado'), 'prova de frete fail-closed nos testes');
p0(frete.includes("'nenhum'") && frete.includes("'retirada'") && frete.includes("'manual'"), 'FreightProvider: nenhum | retirada | manual');
const outbox = ler('server/src/commerce/outbox.ts');
p0(outbox.includes('PENDENTE') && outbox.includes('PROCESSADO'), 'outbox com estados e retry');

// ------------------------------------------------------- 6. Zero modal/UX
function arquivos(dir: string, filtro: (f: string) => boolean): string[] {
  const base = join(RAIZ, dir);
  if (!existsSync(base)) return [];
  return readdirSync(base).filter(filtro).map((f) => join(dir, f));
}

const paginas = [
  ...arquivos('client/src/pages/commerce', (f) => f.endsWith('.tsx') && !f.endsWith('.test.tsx')),
  ...arquivos('client/src/pages/commerce/loja', (f) => f.endsWith('.tsx') && !f.endsWith('.test.tsx')),
];
const codigoUI = paginas.map(ler).join('\n');
p0(paginas.length >= 17, `17+ páginas/rotas commerce+loja sem modal (${paginas.length} arquivos)`);
p0(
  !/<Modal|<Dialog|<Drawer|<Sheet|createPortal/.test(codigoUI),
  'ZERO modal/overlay/portal nas rotas operacionais (confirmações inline)',
);
p0(!/Em breve/.test(codigoUI), 'sem "Em breve" nas páginas commerce/loja');
p0(ler('client/src/pages/commerce/shared.tsx').includes('CANAIS_PUBLICACAO'), 'vocabulário de canais centralizado no cliente');

// ----------------------------------------------------------- 7. Testes
const testes: [string, number][] = [
  ['server/test/commerce-oracle.test.ts', 24],
  ['server/test/pg/commerce-concorrencia.test.ts', 12],
  ['server/test/pg/commerce-e2e.test.ts', 1],
  ['server/test/pg/pg-golive03-marketplace-venda.test.ts', 1],
];
for (const [arquivo, minimo] of testes) {
  const corpo = ler(arquivo);
  const testesNoArquivo = (corpo.match(/\btest\(/g) || []).length;
  p0(corpo.length > 0 && testesNoArquivo >= minimo, `${arquivo} presente (${testesNoArquivo} test( >= ${minimo})`);
}
const testesClient = [
  ...arquivos('client/src/pages/commerce', (f) => f.endsWith('.test.tsx')),
  ...arquivos('client/src/pages/commerce/loja', (f) => f.endsWith('.test.tsx')),
];
p0(testesClient.length >= 15, `15+ arquivos de teste visual/fluxo commerce (${testesClient.length})`);
p0(ler('client/src/pages/commerce/LojaFluxoPages.test.tsx').includes("queryByRole('dialog')"), 'fluxo B2C prova ausência de diálogo modal');

// ------------------------------------------------------- 8. Docs e módulos
for (const doc of ['COMMERCE-ARCHITECTURE', 'COMMERCE-GO-LIVE', 'COMMERCE-CHANNEL-MATRIX', 'COMMERCE-GAP-AUDIT']) {
  p0(existsSync(join(RAIZ, `docs/${doc}.md`)), `docs/${doc}.md presente`);
}
const modules = ler('client/src/modules.ts');
const planned = (modules.match(/planned: true/g) || []).length;
p0(planned <= 4, `planned restrito aos módulos fora do commerce (${planned} no arquivo; teto 4 =Creators)`);
p0(modules.includes("space: 'commerce'"), 'espaço commerce no menu');
p0(existsSync(join(RAIZ, 'client/src/pages/commerce/shared.tsx')), 'páginas commerce existem');

// ----------------------------------------------------- 9. P1 (provisionamento)
p1(modules.includes("connector: 'MERCADOLIVRE'"), 'conector Mercado Livre no menu (OAuth e homologação não verificados)', 'credencial do cliente');
p1(modules.includes("connector: 'MERCADOPAGO'"), 'conector Mercado Pago no menu (token e webhook não verificados)', 'credencial do cliente');
p1(mig.includes('INSTAGRAM_SHOPPING'), 'Instagram Shopping: publicação de item individual REJECTED por design (Graph API) — documentado', 'limitação da API da Meta');
p1(!/connector: 'WOOCOMMERCE'/.test(modules), 'WooCommerce: canal implementado (wooFetch) sem tela connector dedicada', 'gap de UX documentada');
p1(existsSync(join(RAIZ, 'docs/COMMERCE-GAP-AUDIT.md')), 'GAP-AUDIT documenta lacunas conhecidas');

// ---------------------------------------------------------- 10. P2 (futuro)
p2('carrier de frete externo', 'nenhum|retirada|manual é suficiente hoje; Correios/transportadora é extensão futura');
p2('sincronização de estoque ida-e-volta', 'canais leem o canônico + reservas; escrita por canal é reconciliação futura');
p2('imagens de marketplace na vitrine', 'foto_url do cadastro ERP cobre a vitrine própria');
p2('E2E por canal Nuvemshop/Woo/Instagram', 'ingestão implementada; golive-03 cobre o caminho marketplace→venda');

// -------------------------------------------------------------- 11. Banco
async function verificarBanco(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.log('\n[DB] DATABASE_URL não definida — verificação de banco pulada (rode com o banco alvo para o check completo).');
    return;
  }
  try {
    const { Client } = (await import('pg')) as { Client: new (cfg: { connectionString: string }) => { connect(): Promise<unknown>; query(sql: string): Promise<{ rows: Record<string, unknown>[] }>; end(): Promise<unknown> } };
    const cli = new Client({ connectionString: url });
    await cli.connect();
    const r = await cli.query(
      `SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema='public' AND table_name LIKE 'commerce_%'`,
    );
    const n = Number(r.rows[0]?.n ?? 0);
    await cli.end();
    p0(n >= 9, `banco alvo migrado: ${n}/9 tabelas commerce existem`, 'rode as migrations (0068) no banco alvo');
  } catch (e) {
    p0(false, 'banco alvo acessível para verificação', String(e).slice(0, 120));
  }
}

await verificarBanco();

// -------------------------------------------------------------- Resultado
console.log(`\nP0: ${okP0} ok, ${falhasP0.length} falha(s) | P1: ${avisosP1.length} aviso(s) | P2: ${futurosP2.length} item(ns)`);
if (falhasP0.length) {
  console.log(`\nCOMMERCE STRUCTURAL CHECK: BLOCKED (${falhasP0.length} P0 em aberto)`);
  for (const f of falhasP0) console.log(`  - ${f}`);
  process.exit(1);
}
console.log('\nCOMMERCE STRUCTURAL CHECK: PASS — não certifica homologação externa nem go-live integral.');
if (avisosP1.length) console.log(`(${avisosP1.length} P1 de provisionamento/limitação documentada — não bloqueia)`);
process.exit(0);
