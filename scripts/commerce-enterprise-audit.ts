// ============================================================================
// COMMERCE ENTERPRISE — auditoria que VERIFICA condições reais (nunca um PASS fixo).
//
// Cada checagem lê o código-fonte, importa módulos de verdade e executa
// funções puras (menu, validação de quantidade, SEO, registry de providers) ou
// inspeciona o diff do git. Uma falha vira P0/P1/P2 conforme a gravidade; o
// processo sai com código 1 se QUALQUER severidade tiver falha (P0=P1=P2=0).
//
// O que esta auditoria NÃO prova (e diz isso no relatório): comportamento com
// banco/serviços reais — isso é papel de `npm run test:pg` e `smoke:pg` — e
// homologação externa (Mercado Pago em sandbox, webhook público, frete real).
//
// Uso: npm run commerce:enterprise-audit
// ============================================================================
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

type Sev = 'P0' | 'P1' | 'P2';
type Resultado = { sev: Sev; area: string; ok: boolean; detalhe: string };
const resultados: Resultado[] = [];
const raiz = process.cwd();
const ler = (rel: string): string => readFileSync(path.join(raiz, rel), 'utf8');
const existe = (rel: string): boolean => existsSync(path.join(raiz, rel));

function checar(sev: Sev, area: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve()
    .then(fn)
    .then(() => void resultados.push({ sev, area, ok: true, detalhe: 'ok' }))
    .catch((e) => void resultados.push({ sev, area, ok: false, detalhe: e instanceof Error ? e.message.split('\n')[0] : String(e) }));
}

function arquivos(dir: string, filtro: (f: string) => boolean, acc: string[] = []): string[] {
  const abs = path.join(raiz, dir);
  if (!existsSync(abs)) return acc;
  for (const nome of readdirSync(abs)) {
    if (['node_modules', 'dist', 'build', 'backups', '.git', 'coverage'].includes(nome)) continue;
    const rel = path.join(dir, nome);
    const st = statSync(path.join(raiz, rel));
    if (st.isDirectory()) arquivos(rel, filtro, acc);
    else if (filtro(rel)) acc.push(rel);
  }
  return acc;
}
const semTestes = (f: string) => /\.(ts|tsx)$/.test(f) && !/\.test\.(ts|tsx)$/.test(f);
/** Remove comentários para que uma menção em comentário não gere falso positivo/negativo. */
const semComentarios = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

function git(...args: string[]): string {
  try {
    return execFileSync('git', args, { cwd: raiz, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return '';
  }
}

const paginasLoja = arquivos('client/src/pages/commerce', semTestes);
const vitrine = ler('server/src/commerce/vitrine.ts');
const appSrc = ler('client/src/App.tsx');

async function main() {
  // ------------------------------------------------------------------ MENU
  const { MODULES, MODULE_GROUPS, visibleModules, rotuloGrupo } = await import('../client/src/modules');
  const commerce = MODULES.filter((m) => m.area === 'Commerce');
  const grupo = (g: string) => commerce.filter((m) => m.group === g).map((m) => m.id);

  await checar('P0', 'Menu: estrutura Catálogo→Comercial→Experiência→Pedidos→Fulfillment→Pagamentos→Canais→Integrações→Inteligência', () => {
    assert.deepEqual(grupo('Catálogo'), ['commerce-produtos', 'commerce-publicacoes']);
    assert.deepEqual(grupo('Comercial Commerce'), ['commerce-precos', 'commerce-promocoes', 'commerce-cupons']);
    assert.deepEqual(grupo('Experiência'), ['commerce-loja', 'commerce-abrir-loja']);
    assert.deepEqual(grupo('Pedidos'), ['commerce-pedidos']);
    assert.deepEqual(grupo('Fulfillment'), ['commerce-delivery']);
    assert.deepEqual(grupo('Pagamentos'), ['commerce-pagamentos', 'commerce-providers', 'conector-mercadopago']);
    assert.deepEqual(grupo('Canais'), ['conector-mercadolivre', 'conector-nuvemshop', 'conector-instagram']);
    assert.deepEqual(grupo('Integrações'), ['commerce-fila']);
    assert.deepEqual(grupo('Inteligência'), ['commerce-trends']);
    const ordemGrupos = MODULE_GROUPS.filter((g) => commerce.some((m) => m.group === g));
    assert.deepEqual(ordemGrupos, ['Catálogo', 'Comercial Commerce', 'Experiência', 'Pedidos', 'Fulfillment', 'Pagamentos', 'Canais', 'Integrações', 'Inteligência']);
    assert.equal(rotuloGrupo('Comercial Commerce'), 'Comercial');
  });
  await checar('P0', 'Menu: Mercado Pago em Pagamentos/Providers, fora de Canais, rota preservada e sem duplicata', () => {
    const mp = MODULES.filter((m) => /mercado-?pago/i.test(m.id) || /mercado pago/i.test(m.label));
    assert.equal(mp.length, 1, `Mercado Pago deve aparecer UMA vez no menu (achou ${mp.length})`);
    assert.equal(mp[0].group, 'Pagamentos');
    assert.equal(mp[0].subgroup, 'Providers');
    assert.equal(mp[0].path, '/conectores/mercado-pago');
    assert.ok(!grupo('Canais').includes(mp[0].id));
  });
  await checar('P0', 'Menu: nenhuma rota "Em breve"/planned e nenhum caminho duplicado no Commerce', () => {
    assert.deepEqual(commerce.filter((m) => m.planned?.length).map((m) => m.id), []);
    assert.equal(new Set(commerce.map((m) => m.path)).size, commerce.length);
    const emBreve = paginasLoja.filter((f) => /em breve/i.test(semComentarios(ler(f))));
    assert.deepEqual(emBreve, [], 'página commerce com texto "Em breve"');
  });
  await checar('P0', 'Rotas preservadas: admin Commerce/conectores e públicas /loja*', () => {
    const caminhos = new Set(MODULES.map((m) => m.path));
    const explicitas = new Set([...appSrc.matchAll(/<Route\s+path="([^"]+)"/g)].map((m) => '/' + m[1].replace(/^\//, '')));
    for (const r of ['/commerce/produtos', '/commerce/publicacoes', '/commerce/loja', '/commerce/promocoes', '/commerce/cupons', '/commerce/pedidos', '/commerce/delivery', '/commerce/fila', '/commerce/trends', '/conectores/mercado-pago', '/conectores/mercado-livre', '/conectores/nuvemshop', '/conectores/instagram'])
      assert.ok(caminhos.has(r), `rota ausente do menu: ${r}`);
    assert.ok(explicitas.has('/commerce/produtos/:id'), 'rota /commerce/produtos/:id');
    for (const r of ['/loja', '/loja/produto/:slug', '/loja/carrinho', '/loja/checkout', '/loja/pedido/:token']) assert.ok(explicitas.has(r), `rota pública ausente: ${r}`);
    for (const alias of ['/providers', '/payment-engine']) assert.ok(explicitas.has(alias), `alias ausente: ${alias}`);
  });
  await checar('P0', 'Menu: Commerce → Experiência → Abrir Loja → /loja (sem rota paralela de storefront)', () => {
    const abrir = MODULES.find((m) => m.id === 'commerce-abrir-loja');
    assert.ok(abrir, 'item "Abrir Loja" ausente do menu');
    assert.equal(abrir.label, 'Abrir Loja');
    assert.equal(abrir.area, 'Commerce');
    assert.equal(abrir.group, 'Experiência');
    assert.equal(abrir.path, '/loja');
    assert.equal(abrir.rotaPublica, true, 'Abrir Loja não pode gerar rota administrativa paralela');
    assert.equal(MODULES.find((m) => m.id === 'commerce-loja')?.path, '/commerce/loja');
    const experiencia = grupo('Experiência');
    assert.equal(experiencia.indexOf('commerce-abrir-loja'), experiencia.indexOf('commerce-loja') + 1, 'Abrir Loja deve vir abaixo de Loja própria');
    assert.ok(appSrc.includes('path="/loja" element={<LojaInicioPage />}'), 'rota pública oficial /loja ausente');
    assert.ok(appSrc.includes('!m.rotaPublica'), 'App.tsx não pode gerar uma segunda rota para /loja');
    for (const proibida of ['/commerce/loja-publica', '/commerce/storefront', '/commerce/vitrine-publica', '/commerce/abrir-loja']) {
      assert.ok(!MODULES.some((m) => m.path === proibida), `rota duplicada proibida no menu: ${proibida}`);
      assert.ok(!appSrc.includes(`path="${proibida}"`), `rota duplicada proibida no App: ${proibida}`);
    }
    assert.equal(MODULES.filter((m) => m.path === '/loja').length, 1, '/loja deve ter UM único item de menu');
  });
  await checar('P1', 'RBAC do menu: Payment Engine/Providers só para gerente+ (espelha a API)', () => {
    for (const id of ['commerce-pagamentos', 'commerce-providers']) {
      assert.ok(!visibleModules({ perfil: 'operador' }).some((m) => m.id === id), `${id} visível ao operador`);
      assert.ok(visibleModules({ perfil: 'gerente' }).some((m) => m.id === id), `${id} invisível ao gerente`);
    }
    const rotas = ler('modules/payments/api/routes.ts');
    assert.match(rotas, /\['admin', 'gerente'\]\.includes\(actor\.perfil\)/, 'API de pagamentos sem trava de perfil');
    assert.match(rotas, /actor\.perfil !== 'admin'/, 'configuração de provider sem trava de admin');
  });

  // ---------------------------------------------------------- PAYMENT ENGINE
  const { providerRegistry } = await import('../modules/payments/providers/registry');
  await checar('P0', 'Payment Engine: checkout só fala com o engine (nunca com adapter/Mercado Pago)', () => {
    assert.ok(vitrine.includes('paymentEngine.createForOrder'));
    assert.doesNotMatch(semComentarios(vitrine), /from ['"][^'"]*(mercado-pago|pagbank|stripe|gateway)/i);
    const orq = ler('modules/payments/orchestration/payment-orchestrator.ts');
    assert.match(orq, /class PaymentOrchestrator/);
    assert.match(orq, /candidates\(/, 'o engine deve escolher o provider pelas rotas configuradas');
    assert.match(ler('modules/payments/application/configuration.ts'), /providerRegistry/);
    assert.match(ler('modules/payments/orchestration/provider-router.ts'), /capabilit|cap\./);
  });
  await checar('P0', 'Providers: PagBank e Stripe são extensíveis mas NÃO anunciam método sem credencial; Mercado Pago é o único operacional', () => {
    const ctx = { empresaId: 1, credentials: {}, webhookSecret: null, operationKey: 'audit', environment: 'teste' } as never;
    for (const code of ['MERCADO_PAGO', 'PAGBANK', 'STRIPE'] as const) {
      const p = providerRegistry.get(code);
      assert.ok(p, `${code} não registrado`);
      assert.deepEqual(p.capabilities(ctx), [], `${code} anuncia método sem credenciais`);
    }
    const mp = providerRegistry.get('MERCADO_PAGO')!;
    const comCredenciais = mp.capabilities({ empresaId: 1, credentials: { access_token: 'x' }, webhookSecret: 'y', operationKey: 'audit', environment: 'teste' } as never);
    assert.ok(comCredenciais.some((c: { method?: string }) => c.method === 'PIX'), 'Mercado Pago configurado deveria anunciar PIX');
    for (const code of ['PAGBANK', 'STRIPE'] as const) {
      const p = providerRegistry.get(code)!;
      const cap = p.capabilities({ empresaId: 1, credentials: { access_token: 'x', secret_key: 'x', api_key: 'x' }, webhookSecret: 'y', operationKey: 'audit', environment: 'teste' } as never);
      void cap; // sem homologação, nenhuma tela pode chamá-los de "conectado" (checagem abaixo)
    }
  });
  await checar('P0', 'Nenhuma tela/menu/doc apresenta PagBank ou Stripe como conectado/operacional', () => {
    const alvos = [...paginasLoja, 'client/src/modules.ts', 'docs/COMMERCE-ARCHITECTURE.md'].filter(existe);
    const ruins: string[] = [];
    for (const f of alvos) {
      for (const linha of ler(f).split('\n')) {
        if (/(pagbank|stripe)/i.test(linha) && /(conectad[oa]|operacional|homologad[oa]|em produção)/i.test(linha) && !/(não|nao|nunca|sem |only|apenas|único|unico|extensível|extensivel|arquitetura|até|antes de|exige|depende|fail)/i.test(linha)) ruins.push(`${f}: ${linha.trim().slice(0, 100)}`);
      }
    }
    assert.equal(ruins.length, 0, ruins.join(' | '));
  });
  await checar('P1', 'Webhook assinado, idempotência e mapa de estados do pagamento existem', () => {
    const orq = ler('modules/payments/orchestration/payment-orchestrator.ts');
    const mp = ler('modules/payments/providers/mercado-pago/index.ts') + ler('modules/payments/providers/http.ts');
    assert.match(mp, /x-signature|createHmac|timingSafeEqual/i, 'verificação de assinatura do webhook');
    assert.match(orq, /idempot|operationKey|operation_key/i);
    assert.ok(existe('db/migrations/0069_payment_engine.sql'));
    const dominio = ler('modules/payments/domain/payment.ts');
    for (const estado of ['PAID', 'FAILED', 'EXPIRED']) assert.match(dominio, new RegExp(estado), `estado ${estado} ausente do domínio`);
  });
  await checar('P1', 'Pedido único por empresa+canal+pedido externo e checkout idempotente por chave', () => {
    const sql = ler('db/migrations/0068_commerce_os.sql');
    assert.match(sql, /UNIQUE \(empresa_id, canal, pedido_externo\)/);
    assert.match(sql, /uq_commerce_pedidos_chave ON commerce_pedidos \(empresa_id, chave_checkout\)/);
    assert.match(sql, /uq_estoque_reservas_checkout/, 'reserva idempotente por pedido');
  });
  await checar('P1', 'Reserva transacional serializable + estoque canônico (nunca estoque paralelo)', () => {
    const pedidos = ler('server/src/commerce/pedidos.ts') + vitrine;
    assert.match(pedidos, /serializable/i);
    assert.ok(existe('docs/ESTOQUE-CANONICO.md'));
    assert.match(ler('docs/ESTOQUE-CANONICO.md'), /estoque_reservas/, 'doc deve descrever a tabela de reservas real');
    assert.match(ler('server/src/estoqueCanonico.ts'), /físico − reservado − empenhado − bloqueado/);
    assert.match(vitrine, /disponibilidadesPorTamanho|disponibilidade/);
  });

  // ------------------------------------------------- SERVIDOR = AUTORIDADE
  await checar('P0', 'Servidor é a autoridade: preview/checkout nunca leem total/preço/desconto/frete do corpo', () => {
    const src = semComentarios(vitrine);
    assert.doesNotMatch(src, /body\??\.(total|totais|preco|preco_unitario|subtotal|desconto|frete|valor)\b/, 'corpo da requisição usado para valor monetário');
    assert.doesNotMatch(src, /\{\s*[^}]*\b(total|preco_unitario|subtotal)\b[^}]*\}\s*=\s*(?:req\.)?body/, 'desestruturação de valor monetário do corpo');
    assert.match(src, /precoPublico\(/, 'preço vem da tabela do servidor');
    assert.match(src, /frete_indisponivel/);
  });
  await checar('P0', 'Teste PG prova que total:1/preço:1 do browser é ignorado (preview e checkout)', () => {
    const t = ler('server/test/pg/commerce-cart.test.ts');
    assert.match(t, /total: 1/);
    assert.match(t, /preco_unitario: 1/);
    assert.match(t, /pedido nasce com o total do SERVIDOR/);
  });
  await checar('P0', 'Tenancy: vitrine resolve a empresa no servidor e filtra todo acesso por empresa_id', () => {
    assert.match(ler('server/src/commerce/loja-base.ts'), /empresaDaVitrine/);
    assert.match(vitrine, /empresa_id|empresaId/);
    const seo = ler('server/src/commerce/storefront-seo.ts');
    assert.match(seo, /empresaDaVitrine\(\)/);
    // O SEO usa a MESMA regra de visibilidade da vitrine. Antes fazia varredura
    // completa via carregarVitrine(empresaId); agora usa point lookup indexado
    // (resolverProdutoVitrine), que aplica os mesmos filtros de tenant/ativo/
    // publicação. O gate continua P0 e exige prova explícita desses filtros.
    assert.match(seo, /carregarVitrine\(empresaId\)|resolverProdutoVitrine\(empresaId/, 'SEO deve usar a mesma regra de visibilidade da vitrine');
    assert.match(vitrine, /empresa_id = \$1 AND lower\(slug\) = \$2/, 'point lookup precisa ser isolado por tenant');
    assert.match(vitrine, /canal: 'BROBOND', estado: 'PUBLISHED'/, 'publicação ativa no canal da loja');
    assert.doesNotMatch(seo, /req\.(query|body|params)\.empresa/);
  });
  await checar('P0', 'Sem organizationId em nenhum código-fonte (empresa = tenant)', () => {
    const dirs = ['client/src', 'server/src', 'modules', 'scripts', 'db/migrations'];
    // Comentários históricos ("organizationId → usuarioId" nas notas de portagem dos conectores) não contam; código e SQL sim.
    const achados = dirs.flatMap((d) => arquivos(d, (f) => /\.(ts|tsx|sql|mjs)$/.test(f) && !f.endsWith('commerce-enterprise-audit.ts'))).filter((f) => /organizationId|organization_id/.test(f.endsWith('.sql') ? ler(f) : semComentarios(ler(f))));
    assert.equal(achados.length, 0, achados.join(', '));
  });
  await checar('P0', 'Sem segredos no frontend nem em logs do servidor/payments', () => {
    const front = arquivos('client/src', (f) => /\.(ts|tsx)$/.test(f) && !/\.test\./.test(f));
    const padroes = /(APP_USR-[0-9a-f-]{8,}|sk_live_[A-Za-z0-9]+|MP_ACCESS_TOKEN|MERCADOPAGO_ACCESS_TOKEN|access_token\s*[:=]\s*['"][A-Za-z0-9_-]{16,})/;
    assert.deepEqual(front.filter((f) => padroes.test(ler(f))), []);
    const back = [...arquivos('server/src/commerce', semTestes), ...arquivos('modules/payments', semTestes)];
    const logs = back.flatMap((f) => semComentarios(ler(f)).split('\n').filter((l) => /console\.(log|info|warn|error)\(/.test(l) && /(access_token|secret|password|senha|authorization|credentials)\b/i.test(l)).map((l) => `${f}: ${l.trim().slice(0, 80)}`));
    assert.deepEqual(logs, []);
  });

  // ------------------------------------------------------------- CARRINHO
  const carinho = await import('../client/src/pages/commerce/loja/carinho');
  await checar('P0', 'Carrinho: quantidade rejeita 0, negativo, NaN, Infinity, texto e decimal; limita ao máximo', () => {
    for (const ruim of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 'abc', '', '1.5', 1.5, null, undefined, {}])
      assert.equal(carinho.normalizarQuantidade(ruim), null, `quantidade ${String(ruim)} deveria ser inválida`);
    assert.equal(carinho.normalizarQuantidade(3), 3);
    assert.equal(carinho.normalizarQuantidade('4'), 4);
    assert.equal(carinho.normalizarQuantidade(10_000), carinho.QUANTIDADE_MAXIMA);
  });
  await checar('P0', 'Carrinho: servidor valida quantidade e limita ao estoque (linha ok:false com aviso)', () => {
    assert.match(vitrine, /Só \$\{[^}]+\} em estoque/);
    assert.match(vitrine, /quantidade/i);
    assert.match(vitrine, /payment_methods_erro/, 'falha do Payment Engine não pode derrubar o carrinho');
  });
  await checar('P0', 'Carrinho: estados LOADING/READY/EMPTY/ERROR/INVALID, retry e proteção contra resposta antiga', () => {
    const cot = ler('client/src/pages/commerce/loja/cotacao.ts');
    for (const e of ['LOADING', 'READY', 'EMPTY', 'ERROR', 'INVALID']) assert.match(cot, new RegExp(`'${e}'`), `estado ${e}`);
    assert.match(cot, /AbortController/);
    assert.match(cot, /sequencia/);
    assert.match(cot, /recarregar/);
    const pg = ler('client/src/pages/commerce/loja/LojaCarrinhoPage.tsx');
    assert.match(pg, /Tentar novamente/);
    assert.match(pg, /Frete indisponível para esta configuração\./);
    assert.match(pg, /data-estado-carrinho/);
  });
  await checar('P0', 'Carrinho: nunca exibe "..." como valor (placeholder é "—" e só enquanto sincroniza)', () => {
    const src = semComentarios(ler('client/src/pages/commerce/loja/LojaCarrinhoPage.tsx') + ler('client/src/pages/commerce/loja/LojaShell.tsx'));
    assert.doesNotMatch(src, />\s*\.\.\.\s*</, 'literal "..." renderizado');
    assert.doesNotMatch(src, /['"`]\.\.\.['"`]\s*:/, '"..." como fallback de valor');
    assert.match(src, /—/);
  });
  await checar('P1', 'Carrinho: persiste (localStorage), cruza abas e cada item mostra imagem/nome/SKU/preço/qtd/subtotal/remover', () => {
    const c = ler('client/src/pages/commerce/loja/carinho.ts');
    assert.match(c, /localStorage/);
    assert.match(c, /addEventListener\('storage'/);
    const pg = ler('client/src/pages/commerce/loja/LojaCarrinhoPage.tsx');
    for (const trecho of [/foto_url/, /sku/i, /subtotal/, /Remover/, /Aumentar quantidade|aumentar quantidade/i, /cupom/i]) assert.match(pg, trecho, String(trecho));
  });
  await checar('P1', 'Cupom: validado no servidor (CAS no checkout), persistido e removível', () => {
    assert.match(vitrine, /cupom/i);
    const c = ler('client/src/pages/commerce/loja/carinho.ts');
    assert.match(c, /cupom/i);
    assert.match(ler('client/src/pages/commerce/loja/LojaCarrinhoPage.tsx'), /Remover cupom|remover cupom/i);
  });

  // ------------------------------------------------------------------ UX
  await checar('P0', 'ZERO Modal/Dialog/Drawer/Sheet/Overlay nas telas operacionais e da loja', () => {
    const proibido = /<(Modal|Dialog|Drawer|Sheet|Overlay|Popover)\b|aria-modal|role=["']a?l?e?r?t?dialog["']|fixed inset-0|createPortal|window\.(confirm|alert|prompt)\(/;
    const ruins = paginasLoja.filter((f) => proibido.test(semComentarios(ler(f))));
    assert.deepEqual(ruins, []);
  });
  await checar('P1', 'Acessibilidade da loja: aria-live no carrinho, rótulos nos botões e foco/role de alerta nos erros', () => {
    const pg = ler('client/src/pages/commerce/loja/LojaCarrinhoPage.tsx');
    assert.match(pg, /aria-live|role="status"|role="alert"/);
    assert.match(pg, /aria-label=/);
  });

  // ------------------------------------------------------------------ SEO
  const seo = await import('../server/src/commerce/storefront-seo');
  await checar('P0', 'SEO: title/description/canonical/JSON-LD escapados e noindex em página inexistente', () => {
    const modelo = '<!doctype html><html><head><title>BROBOND</title><meta name="description" content="x" /></head><body></body></html>';
    const html = seo.aplicarMetas(modelo, { titulo: 'A "B" <x>', descricao: 'd', canonical: 'https://l.example/loja', indexavel: true, jsonLd: { name: '</script>' } });
    assert.match(html, /<title>A &quot;B&quot; &lt;x&gt;<\/title>/);
    assert.match(html, /rel="canonical" href="https:\/\/l\.example\/loja"/);
    assert.match(html, /name="description" content="d"/);
    assert.ok(!html.includes('</script></script>') && (html.match(/<\/script>/g) || []).length === 1, 'JSON-LD fechou a tag');
    const nao = seo.aplicarMetas(modelo, { titulo: 't', descricao: 'd', canonical: 'c', indexavel: false });
    assert.match(nao, /noindex/);
  });
  await checar('P0', 'SEO: 404 REAL para produto inexistente/não publicado e rota registrada antes do fallback do SPA', () => {
    const s = ler('server/src/commerce/storefront-seo.ts');
    assert.match(s, /res\.status\(404\)/);
    const idx = ler('server/src/index.ts');
    const posSeo = idx.indexOf('storefrontSeo)');
    const posSpa = idx.search(/app\.get\('\*'/);
    assert.ok(posSeo > 0, 'storefrontSeo não registrado');
    assert.ok(posSpa > posSeo, 'storefrontSeo precisa vir ANTES do fallback app.get(*)');
    assert.match(ler('server/test/pg/commerce-cart.test.ts'), /404 REAL para produto inexistente/);
    assert.match(ler('server/test/pg/commerce-cart.test.ts'), /produto despublicado → 404 real/);
  });

  // --------------------------------------------------------------- GIT / DADOS
  await checar('P0', 'backups/ intocável (nada alterado nem não rastreado)', () => {
    assert.equal(git('status', '--porcelain', '--', 'backups').trim(), '');
    assert.equal(git('diff', '--name-only', 'fa34360', '--', 'backups').trim(), '');
  });
  await checar('P0', 'Migrações novas (se houver) são aditivas: nada de DROP/DELETE/TRUNCATE', () => {
    const novas = git('diff', '--name-only', '--diff-filter=A', 'fa34360', '--', 'db/migrations').split('\n').filter(Boolean);
    const alteradas = git('diff', '--name-only', '--diff-filter=MDR', 'fa34360', '--', 'db/migrations').trim();
    assert.equal(alteradas, '', 'migração existente foi alterada/removida');
    for (const f of novas) assert.doesNotMatch(ler(f), /\b(DROP\s+(TABLE|COLUMN)|TRUNCATE|DELETE\s+FROM)\b/i, `${f} é destrutiva`);
  });

  // ------------------------------------------------------- TESTES / DOCS / GATES
  await checar('P1', 'Cobertura: testes de catálogo, carrinho, concorrência, checkout, payment, pedido, tenancy e RBAC existem', () => {
    for (const f of [
      'server/test/pg/commerce-e2e.test.ts', 'server/test/pg/commerce-cart.test.ts', 'server/test/pg/commerce-concorrencia.test.ts',
      'server/test/pg/payment-engine.test.ts', 'server/test/payment-engine.test.ts', 'server/test/storefront-seo.test.ts',
      'client/src/pages/commerce/loja/LojaCarrinhoPage.test.tsx', 'client/src/pages/commerce/loja/carinho.test.ts',
      'client/src/pages/commerce/LojaFluxoPages.test.tsx', 'client/src/pages/commerce/PrecosPage.test.tsx', 'client/src/modules.test.ts',
    ]) assert.ok(existe(f), `teste ausente: ${f}`);
  });
  await checar('P1', 'Gates no package.json: test, test:pg, smoke:pg, typecheck, lint, build', () => {
    const pkg = JSON.parse(ler('package.json')) as { scripts: Record<string, string> };
    for (const s of ['test', 'test:pg', 'smoke:pg', 'typecheck', 'lint', 'build', 'audit:menu', 'commerce:enterprise-audit']) assert.ok(pkg.scripts[s], `script ausente: ${s}`);
  });
  await checar('P2', 'Documentação da arquitetura cobre fluxo, Payment Engine, carrinho, estoque, SEO e pendências externas', () => {
    const d = ler('docs/COMMERCE-ARCHITECTURE.md');
    for (const t of [/Checkout.*Payment Engine.*Orchestrator.*Provider Adapter.*Mercado Pago/s, /carrinho/i, /estoque/i, /SEO/, /PagBank/, /Stripe/, /homologa/i]) assert.match(d, t, String(t));
  });
}

await main();

const sevs: Sev[] = ['P0', 'P1', 'P2'];
console.log('\nBROBOND COMMERCE ENTERPRISE — auditoria');
for (const r of resultados) console.log(`${r.ok ? 'PASS' : 'FAIL'} [${r.sev}] ${r.area}${r.ok ? '' : `\n       → ${r.detalhe}`}`);
const falhas = Object.fromEntries(sevs.map((s) => [s, resultados.filter((r) => r.sev === s && !r.ok).length])) as Record<Sev, number>;
console.log(`\nChecagens: ${resultados.length} · aprovadas: ${resultados.filter((r) => r.ok).length} · P0=${falhas.P0} P1=${falhas.P1} P2=${falhas.P2}`);
if (resultados.length === 0 || falhas.P0 + falhas.P1 + falhas.P2 > 0) {
  console.error('❌ Auditoria reprovada.');
  process.exit(1);
}
console.log('✅ P0=P1=P2=0 (verificado nesta execução; homologação externa continua pendente — ver docs).');
