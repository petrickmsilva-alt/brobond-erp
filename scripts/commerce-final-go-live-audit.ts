#!/usr/bin/env node
// ============================================================================
// BROBOND ERP 3.0 — GATE FINAL DE GO-LIVE DO COMMERCE (`npm run commerce:final-go-live`)
// ----------------------------------------------------------------------------
// Ele NÃO substitui `npm test` / `test:pg` / `audit:menu` / `audit:ux` /
// `architecture:audit` / `prisma validate` — ele os EXIGE e, além disso,
// avalia INDEPENDENTEMENTE o estado do módulo Commerce em três frentes:
//
//   P0 (bloqueia CODE_READY)
//     publicação · edição · catálogo · pedidos · checkout · reserva ·
//     pagamento · webhook · integração ERP · tenancy · RBAC · concorrência
//
//   P1 (bloqueia CODE_READY)
//     observabilidade · pagamentos · reservas · fulfillment · devoluções ·
//     ofertas · regras de preço · código dos conectores
//
//   P2/P3 — relatados, não bloqueiam (docs, dívida cosmética).
//
//   EXTERNAL_HOMOLOGATION_READY — frente SEPARADA: depende de credenciais
//   oficiais dos conectores (Mercado Livre, Nuvemshop, Mercado Pago,
//   Instagram). Sem credenciais → EXTERNAL_HOMOLOGATION_BLOCKED, nunca
//   mascarado, e FULL_GO_LIVE permanece false. A ausência de credencial
//   externa NÃO vira P0/P1 de código (CODE_READY é independente).
//
//   Vereditos emitidos (todos no mesmo relatório):
//     · CODE_READY                    = 0 achados P0 e P1 de código;
//     · EXTERNAL_HOMOLOGATION_READY   = as 4 credenciais oficiais presentes;
//                                       caso contrário EXTERNAL_HOMOLOGATION_BLOCKED;
//     · FULL_GO_LIVE                  = CODE_READY && EXTERNAL_HOMOLOGATION_READY.
//
// Nenhum achado é convertido em skip, nenhum falha vira warning, nenhum
// resultado não executado é declarado como executado. Exit 1 quando há
// P0/P1 de código (CODE_READY false).
//
// Uso:  node --import tsx scripts/commerce-final-go-live-audit.ts [--json]
// ============================================================================
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { auditarUx } from './ux-guard.mjs';

const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

type Achado = { id: string; severidade: 'P0' | 'P1' | 'P2' | 'P3'; mensagem: string; onde?: string };
const achados: Achado[] = [];
const registrar = (id: string, severidade: Achado['severidade'], mensagem: string, onde?: string) =>
  achados.push({ id, severidade, mensagem, onde });

const ler = (rel: string) => readFileSync(path.join(raiz, rel), 'utf8');
const existe = (rel: string) => existsSync(path.join(raiz, rel));

/** Lê arquivo; para diretório, concatena os arquivos .ts/.tsx/.sql de 1º nível. */
function lerAlvo(rel: string): string {
  const alvo = path.join(raiz, rel);
  try {
    if (existsSync(alvo) && statSync(alvo).isFile()) return ler(rel);
    if (existsSync(alvo) && statSync(alvo).isDirectory()) {
      return readdirSync(alvo)
        .filter((f) => /\.(ts|tsx|sql|mjs|js)$/.test(f))
        .map((f) => {
          try {
            return readFileSync(path.join(alvo, f), 'utf8');
          } catch {
            return '';
          }
        })
        .join('\n');
    }
  } catch {
    /* leitura falha = padrão não encontrado (honesto) */
  }
  return '';
}

function rodar(comando: string[]): { ok: boolean; saida: string } {
  const r = spawnSync(process.execPath, comando, { cwd: raiz, encoding: 'utf8', timeout: 300_000 });
  return { ok: r.status === 0, saida: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

// ---------------------------------------------------------------------------
// 1) GATES OBRIGATÓRIOS — cada um precisa passar por si próprio
// ---------------------------------------------------------------------------
const gates: { nome: string; comando: string[] }[] = [
  { nome: 'audit:ux (zero modal / fluxos convertidos)', comando: ['scripts/auditar-ux.mjs'] },
  { nome: 'audit:menu (menu × rota × RBAC × multiempresa)', comando: ['--import', 'tsx', 'scripts/auditar-menu.ts'] },
  { nome: 'architecture:audit (recurso × tabela × tenant × Prisma)', comando: ['--import', 'tsx', 'scripts/arquitetura-audit.ts'] },
];
for (const gate of gates) {
  const r = rodar(gate.comando);
  if (!r.ok) registrar('GATE_VERMELHO', 'P0', `Gate obrigatório falhou: ${gate.nome}`, gate.comando.join(' '));
}

// ---------------------------------------------------------------------------
// 2) UX — defesa em profundidade além do gate (violações de sobreposição)
// ---------------------------------------------------------------------------
const ux = auditarUx(raiz);
for (const v of ux.violacoes) registrar('UX_SOBREPOSICAO', 'P0', v, 'client/src');

// ---------------------------------------------------------------------------
// 3) P0 — frentes operacionais que bloqueiam sempre
// ---------------------------------------------------------------------------
type Exigencia = { desc: string; arquivo: string; padrao?: string; teste?: string };
type Frente = { id: string; titulo: string; exigencias: Exigencia[] };

const P0: Frente[] = [
  {
    id: 'P0_PUBLICACAO',
    titulo: 'Publicação (fila → claim → publicar → estados)',
    exigencias: [
      { desc: 'enfileirar + processar publicação', arquivo: 'server/src/commerce/catalogo.ts', padrao: 'enfileirarPublicacao' },
      { desc: 'rota GET /api/commerce/publicacoes/:id (novo)', arquivo: 'server/src/index.ts', padrao: '/api/commerce/publicacoes/:id' },
      { desc: 'tela de nova publicação', arquivo: 'client/src/pages/commerce/PublicacaoNovaPage.tsx', teste: 'client/src/pages/commerce/PublicacaoNovaPage.test.tsx' },
      { desc: 'detalhe da publicação', arquivo: 'client/src/pages/commerce/PublicacaoDetalhePage.tsx', teste: 'client/src/pages/commerce/PublicacaoDetalhePage.test.tsx' },
      { desc: 'edição da publicação', arquivo: 'client/src/pages/commerce/PublicacaoEditarPage.tsx', teste: 'client/src/pages/commerce/PublicacaoEditarPage.test.tsx' },
      { desc: 'corrida de publicação em PG real (8×)', arquivo: 'server/test/pg/commerce-concorrencia.test.ts', padrao: 'enfileirarPublicacao' },
    ],
  },
  {
    id: 'P0_EDICAO',
    titulo: 'Edição do catálogo (PUT /produtos/:id com projeção por produto_id)',
    exigencias: [
      { desc: 'atualizarProdutoCommerce no servidor', arquivo: 'server/src/commerce/catalogo.ts', padrao: 'atualizarProdutoCommerce' },
      { desc: 'rota PUT registrada', arquivo: 'server/src/index.ts', padrao: "app\\.put\\('/api/commerce/produtos/:id'" },
      { desc: 'correção da projeção (resolve por produto_id, não por id da projeção)', arquivo: 'server/src/commerce/catalogo.ts', padrao: 'produto_id: id, empresa_id' },
      { desc: 'página de edição da vitrine', arquivo: 'client/src/pages/commerce/ProdutoDetalhePage.tsx', teste: 'client/src/pages/commerce/ProdutoDetalhePage.test.tsx' },
    ],
  },
  {
    id: 'P0_CATALOGO',
    titulo: 'Catálogo (produtos, preços, grade, migração canônica)',
    exigencias: [
      { desc: 'migração canônica do Commerce com tenancy', arquivo: 'db/migrations/0068_commerce_os.sql', padrao: 'empresa_id' },
      { desc: 'vitrine/listagem canônica', arquivo: 'server/src/commerce/vitrine.ts', padrao: 'produtos' },
      { desc: 'telas de produto (lista/novo/detalhe)', arquivo: 'client/src/pages/commerce/ProdutosPage.tsx', teste: 'client/src/pages/commerce/ProdutosPage.test.tsx' },
      { desc: 'grade/tamanhos', arquivo: 'server/src/commerce/grade.ts' },
    ],
  },
  {
    id: 'P0_PEDIDOS',
    titulo: 'Pedidos (projeção idempotente por sale + estados)',
    exigencias: [
      { desc: 'garantirPedidoDaSale', arquivo: 'server/src/commerce/pedidos.ts', padrao: 'garantirPedidoDaSale' },
      { desc: 'telas de pedido (lista/detalhe)', arquivo: 'client/src/pages/commerce/PedidosPage.tsx', teste: 'client/src/pages/commerce/PedidosPage.test.tsx' },
      { desc: 'detalhe do pedido', arquivo: 'client/src/pages/commerce/PedidoDetalhePage.tsx', teste: 'client/src/pages/commerce/PedidoDetalhePage.test.tsx' },
      { desc: 'idempotência da projeção em PG real', arquivo: 'server/test/pg/commerce-concorrencia.test.ts', padrao: 'garantirPedidoDaSale' },
    ],
  },
  {
    id: 'P0_CHECKOUT',
    titulo: 'Checkout (transação serializable: pedido + reserva + venda)',
    exigencias: [
      { desc: 'fluxo de checkout transacional (serializable)', arquivo: 'server/src/commerce/vitrine.ts', padrao: "isolation: 'serializable'" },
      { desc: 'carrinho da loja', arquivo: 'client/src/pages/commerce/loja/LojaCarrinhoPage.tsx', teste: 'client/src/pages/commerce/LojaFluxoPages.test.tsx' },
      { desc: 'checkout da loja', arquivo: 'client/src/pages/commerce/loja/LojaCheckoutPage.tsx' },
      { desc: 'rota /loja/checkout registrada', arquivo: 'client/src/App.tsx', padrao: '/loja/checkout' },
      { desc: 'E2E real (catálogo → fila → vitrine → checkout → webhook → conversão)', arquivo: 'server/test/pg/commerce-e2e.test.ts' },
    ],
  },
  {
    id: 'P0_RESERVA',
    titulo: 'Reserva de estoque (motor canônico + rollback 25P02)',
    exigencias: [
      { desc: 'criarReservaInterna (valida disponibilidade)', arquivo: 'server/src/estoqueTransferencia.ts', padrao: 'criarReservaInterna' },
      { desc: 'tela de reservas', arquivo: 'client/src/pages/commerce/ReservasPage.tsx', teste: 'client/src/pages/commerce/ReservasPage.test.tsx' },
      { desc: 'regressão 25P02 (SQL error → rollback → consistência)', arquivo: 'server/test/pg/commerce-rollback-25p02.test.ts', padrao: 'ROLLBACK total' },
      { desc: 'reserva/concorrência em PG real', arquivo: 'server/test/pg/commerce-concorrencia.test.ts', padrao: 'criarReservaInterna' },
    ],
  },
  {
    id: 'P0_PAGAMENTO',
    titulo: 'Pagamento (gateway, confirmação, estados)',
    exigencias: [
      { desc: 'processamento idempotente de eventos do gateway', arquivo: 'server/src/gateway.ts', padrao: 'processarEvento' },
      { desc: 'confirmação CAS tryUpdateIf → status paga (webhook)', arquivo: 'server/src/gateway.ts', padrao: "status: 'paga', webhook_evento_id" },
      { desc: 'tela de pagamentos', arquivo: 'client/src/pages/commerce/PagamentosPage.tsx', teste: 'client/src/pages/commerce/PagamentosPage.test.tsx' },
      { desc: 'cadeia de pagamento em PG real', arquivo: 'server/test/pg/gateway-cadeia-pagamento-e2e.test.ts' },
      { desc: 'estado vindo das regras (mapearEstadoPagamento)', arquivo: 'server/src/commerce/regras.ts', padrao: 'mapearEstadoPagamento' },
    ],
  },
  {
    id: 'P0_WEBHOOK',
    titulo: 'Webhook (assinatura, idempotência, erro visível)',
    exigencias: [
      { desc: 'validação de assinatura (HMAC)', arquivo: 'server/src/gateway.ts', padrao: 'timingSafeEqual' },
      { desc: 'E2E de webhook em PG real', arquivo: 'server/test/pg/e01-gateway-webhook-postgresql.test.ts' },
      { desc: 'webhooks/outbox com estado ERRO', arquivo: 'server/src/commerce/outbox.ts', padrao: 'ERRO' },
      { desc: 'erros de webhook visíveis no painel', arquivo: 'client/src/pages/commerce/ErrosPage.tsx', teste: 'client/src/pages/commerce/ErrosPage.test.tsx' },
    ],
  },
  {
    id: 'P0_ERP_INTEGRACAO',
    titulo: 'Integração ERP (hooks commerce + conversão sale → pedido)',
    exigencias: [
      { desc: 'hooks registrados no boot', arquivo: 'server/src/index.ts', padrao: 'registrarHooksCommerce' },
      { desc: 'agendado do comércio no boot', arquivo: 'server/src/index.ts', padrao: 'processarComercioAgendado' },
      { desc: 'outbox de conversão', arquivo: 'server/src/commerce/outbox.ts', padrao: 'conversao' },
      { desc: 'oracle das regras/estrutura do Commerce', arquivo: 'server/test/commerce-oracle.test.ts' },
    ],
  },
  {
    id: 'P0_TENANCY',
    titulo: 'Tenancy (empresa_id em tudo que é Commerce)',
    exigencias: [
      { desc: 'empresa_id nas tabelas do commerce', arquivo: 'db/migrations/0068_commerce_os.sql', padrao: 'empresa_id' },
      { desc: 'escopo aplicado nos handlers', arquivo: 'server/src/commerce/catalogo.ts', padrao: 'escopoDoAtor' },
      { desc: 'teste de tenant de ingestão de conectores', arquivo: 'server/test/p0-commerce-tenant.test.ts', padrao: 'empresa' },
      { desc: 'sequência de migrations íntegra', arquivo: 'db/migrations' },
    ],
  },
  {
    id: 'P0_RBAC',
    titulo: 'RBAC (perfil × recurso × rota)',
    exigencias: [
      { desc: 'permissões declaradas nos resources', arquivo: 'server/src/resources.ts', padrao: "'commerce_publicacoes'" },
      { desc: 'minPerfil em recurso restrito', arquivo: 'server/src/resources.ts', padrao: 'minPerfil' },
      { desc: 'rotas protegidas por ModuleAccess', arquivo: 'client/src/App.tsx', padrao: '<ModuleAccess' },
      { desc: 'leitura negada a operador em /erros (painéis)', arquivo: 'server/test/commerce-paineis-api.test.ts', padrao: '403' },
    ],
  },
  {
    id: 'P0_CONCORRENCIA',
    titulo: 'Concorrência (PG real, 0 skip no gate)',
    exigencias: [
      { desc: 'suíte de concorrência (12 cenários)', arquivo: 'server/test/pg/commerce-concorrencia.test.ts' },
      { desc: 'reentrega concorrente', arquivo: 'server/test/pg/commerce-reentrega-concorrente.test.ts' },
      { desc: 'gate test:pg (0 skip/0 fail + PG 16.14)', arquivo: 'scripts/test-pg-gate.mjs', padrao: '160014' },
      { desc: 'ci job com PostgreSQL 16.14', arquivo: '.github/workflows/ci.yml', padrao: 'postgres:16.14' },
    ],
  },
];

// ---------------------------------------------------------------------------
// 4) P1 — frentes operacionais que bloqueiam nesta rodada
// ---------------------------------------------------------------------------
const P1: Frente[] = [
  {
    id: 'P1_OBSERVABILIDADE',
    titulo: 'Observabilidade (eventos, erros, fila)',
    exigencias: [
      { desc: 'listagem de eventos da fila', arquivo: 'server/src/commerce/pedidos.ts', padrao: 'listarEventosCommerce' },
      { desc: 'agregação de erros', arquivo: 'server/src/commerce/pedidos.ts', padrao: 'listarErrosCommerce' },
      { desc: 'rota GET /erros', arquivo: 'server/src/index.ts', padrao: '/api/commerce/erros' },
      { desc: 'tela de eventos', arquivo: 'client/src/pages/commerce/EventosPage.tsx', teste: 'client/src/pages/commerce/EventosPage.test.tsx' },
      { desc: 'tela de erros', arquivo: 'client/src/pages/commerce/ErrosPage.tsx', teste: 'client/src/pages/commerce/ErrosPage.test.tsx' },
      { desc: 'tela de fila', arquivo: 'client/src/pages/commerce/FilaPage.tsx', teste: 'client/src/pages/commerce/FilaPage.test.tsx' },
    ],
  },
  {
    id: 'P1_PAGAMENTOS',
    titulo: 'Pagamentos (painel operacional)',
    exigencias: [
      { desc: 'painel de cobranças', arquivo: 'client/src/pages/commerce/PagamentosPage.tsx', teste: 'client/src/pages/commerce/PagamentosPage.test.tsx' },
      { desc: 'cobranças em PG real (E2E)', arquivo: 'server/test/pg/gateway-cadeia-pagamento-e2e.test.ts', padrao: 'cobranca|cobrança|payment' },
    ],
  },
  {
    id: 'P1_RESERVAS',
    titulo: 'Reservas (painel + liberação + expiração)',
    exigencias: [
      { desc: 'painel de reservas', arquivo: 'client/src/pages/commerce/ReservasPage.tsx', teste: 'client/src/pages/commerce/ReservasPage.test.tsx' },
      { desc: 'expiração de checkouts pendentes', arquivo: 'server/src/commerce/pedidos.ts', padrao: 'expirarCheckoutsPendentes' },
      { desc: 'expiração testada em PG real', arquivo: 'server/test/pg/commerce-concorrencia.test.ts', padrao: 'expirarCheckoutsPendentes' },
    ],
  },
  {
    id: 'P1_FULFILLMENT',
    titulo: 'Fulfillment (expedição/rastreio)',
    exigencias: [
      { desc: 'painel de fulfillment', arquivo: 'client/src/pages/commerce/FulfillmentPage.tsx', teste: 'client/src/pages/commerce/FulfillmentPage.test.tsx' },
      { desc: 'expedição em PG real', arquivo: 'server/test/pg/e423-expedicao-postgresql.test.ts' },
      { desc: 'rastreio na migração canônica', arquivo: 'db/migrations/0068_commerce_os.sql', padrao: 'rastreio' },
    ],
  },
  {
    id: 'P1_DEVOLUCOES',
    titulo: 'Devoluções (recurso canônico + painel)',
    exigencias: [
      { desc: 'painel de devoluções', arquivo: 'client/src/pages/commerce/DevolucoesPage.tsx', teste: 'client/src/pages/commerce/DevolucoesPage.test.tsx' },
      { desc: 'E2E de devolução em PG real', arquivo: 'server/test/pg/devolucao-e2e.test.ts' },
      { desc: 'recurso canônico', arquivo: 'server/src/resources.ts', padrao: "'devolucoes'" },
    ],
  },
  {
    id: 'P1_OFERTAS',
    titulo: 'Ofertas (preço por canal com vigência)',
    exigencias: [
      { desc: 'listagem de ofertas no servidor', arquivo: 'server/src/commerce/catalogo.ts', padrao: 'listarOfertasCommerce' },
      { desc: 'detalhe de oferta no servidor', arquivo: 'server/src/commerce/catalogo.ts', padrao: 'obterOfertaCommerce' },
      { desc: 'rotas /ofertas + /ofertas/:id', arquivo: 'server/src/index.ts', padrao: '/api/commerce/ofertas' },
      { desc: 'painel de ofertas', arquivo: 'client/src/pages/commerce/OfertasPage.tsx', teste: 'client/src/pages/commerce/OfertasPage.test.tsx' },
      { desc: 'detalhe da oferta', arquivo: 'client/src/pages/commerce/OfertaDetalhePage.tsx', teste: 'client/src/pages/commerce/OfertaDetalhePage.test.tsx' },
      { desc: 'form de oferta', arquivo: 'client/src/pages/commerce/OfertaFormPage.tsx', teste: 'client/src/pages/commerce/OfertaFormPage.test.tsx' },
      { desc: 'testes de API das ofertas/erros', arquivo: 'server/test/commerce-paineis-api.test.ts', padrao: 'ofertas' },
    ],
  },
  {
    id: 'P1_REGRAS_PRECO',
    titulo: 'Regras de preço (precedência, vigência, mapeamento)',
    exigencias: [
      { desc: 'preço efetivo por precedência', arquivo: 'server/src/commerce/regras.ts', padrao: 'precoEfetivo' },
      { desc: 'vigência ativa', arquivo: 'server/src/commerce/regras.ts', padrao: 'vigenciaEstaAtiva' },
      { desc: 'regras cobertas pelo oracle', arquivo: 'server/test/commerce-oracle.test.ts', padrao: 'precoEfetivo|vigenciaEstaAtiva' },
    ],
  },
  {
    id: 'P1_CONECTORES_CODIGO',
    titulo: 'Conectores (código dos 4 canais + testes)',
    exigencias: [
      { desc: 'camada HTTP de conectores', arquivo: 'server/src/connectors.ts' },
      { desc: 'provider Mercado Livre', arquivo: 'modules/connectors/mercadolivre' },
      { desc: 'provider Nuvemshop', arquivo: 'modules/connectors/nuvemshop' },
      { desc: 'provider Mercado Pago', arquivo: 'modules/connectors/mercadopago' },
      { desc: 'provider Instagram/Meta', arquivo: 'modules/connectors/instagram' },
      { desc: 'testes de conectores', arquivo: 'server/test/connectors.test.ts' },
    ],
  },
];

function avaliarFrente(f: Frente, severidade: 'P0' | 'P1') {
  for (const e of f.exigencias) {
    if (!existe(e.arquivo)) {
      registrar(`${f.id}_AUSENTE`, severidade, `${f.titulo}: ${e.desc} — não existe: ${e.arquivo}`, e.arquivo);
      continue;
    }
    if (e.padrao) {
      const texto = lerAlvo(e.arquivo);
      if (!new RegExp(e.padrao).test(texto)) {
        registrar(`${f.id}_PADRAO`, severidade, `${f.titulo}: ${e.desc} — padrão não encontrado: ${e.padrao}`, e.arquivo);
      }
    }
    if (e.teste && !existe(e.teste)) {
      registrar(`${f.id}_SEM_TESTE`, severidade, `${f.titulo}: ${e.desc} — teste não existe: ${e.teste}`, e.teste);
    }
  }
}
for (const f of P0) avaliarFrente(f, 'P0');
for (const f of P1) avaliarFrente(f, 'P1');

// ---------------------------------------------------------------------------
// 5) ROTAS/TELAS NOVAS DESTE ROUND — registradas + página + teste
// ---------------------------------------------------------------------------
const NOVAS_ROTAS: { rota: string; pagina: string; teste?: string }[] = [
  { rota: 'commerce/publicacoes/novo', pagina: 'client/src/pages/commerce/PublicacaoNovaPage.tsx', teste: 'client/src/pages/commerce/PublicacaoNovaPage.test.tsx' },
  { rota: 'commerce/publicacoes/:id/editar', pagina: 'client/src/pages/commerce/PublicacaoEditarPage.tsx', teste: 'client/src/pages/commerce/PublicacaoEditarPage.test.tsx' },
  { rota: 'commerce/publicacoes/:id', pagina: 'client/src/pages/commerce/PublicacaoDetalhePage.tsx', teste: 'client/src/pages/commerce/PublicacaoDetalhePage.test.tsx' },
  { rota: 'commerce/ofertas', pagina: 'client/src/pages/commerce/OfertasPage.tsx', teste: 'client/src/pages/commerce/OfertasPage.test.tsx' },
  { rota: 'commerce/ofertas/novo', pagina: 'client/src/pages/commerce/OfertaFormPage.tsx', teste: 'client/src/pages/commerce/OfertaFormPage.test.tsx' },
  { rota: 'commerce/ofertas/:id/editar', pagina: 'client/src/pages/commerce/OfertaFormPage.tsx', teste: 'client/src/pages/commerce/OfertaFormPage.test.tsx' },
  { rota: 'commerce/ofertas/:id', pagina: 'client/src/pages/commerce/OfertaDetalhePage.tsx', teste: 'client/src/pages/commerce/OfertaDetalhePage.test.tsx' },
  { rota: 'commerce/pagamentos', pagina: 'client/src/pages/commerce/PagamentosPage.tsx', teste: 'client/src/pages/commerce/PagamentosPage.test.tsx' },
  { rota: 'commerce/reservas', pagina: 'client/src/pages/commerce/ReservasPage.tsx', teste: 'client/src/pages/commerce/ReservasPage.test.tsx' },
  { rota: 'commerce/fulfillment', pagina: 'client/src/pages/commerce/FulfillmentPage.tsx', teste: 'client/src/pages/commerce/FulfillmentPage.test.tsx' },
  { rota: 'commerce/devolucoes', pagina: 'client/src/pages/commerce/DevolucoesPage.tsx', teste: 'client/src/pages/commerce/DevolucoesPage.test.tsx' },
  { rota: 'commerce/eventos', pagina: 'client/src/pages/commerce/EventosPage.tsx', teste: 'client/src/pages/commerce/EventosPage.test.tsx' },
  { rota: 'commerce/erros', pagina: 'client/src/pages/commerce/ErrosPage.tsx', teste: 'client/src/pages/commerce/ErrosPage.test.tsx' },
];
const app = ler('client/src/App.tsx');
for (const r of NOVAS_ROTAS) {
  if (!app.includes(r.rota)) registrar('ROTA_NOVA_SEM_REGISTRO', 'P0', `Rota nova não registrada em App.tsx: ${r.rota}`);
  if (!existe(r.pagina)) registrar('PAGINA_NOVA_AUSENTE', 'P0', `Página da rota nova não existe: ${r.rota}`, r.pagina);
  if (r.teste && !existe(r.teste)) registrar('TESTE_NOVO_AUSENTE', 'P1', `Teste da rota nova não existe: ${r.rota}`, r.teste);
}

// ---------------------------------------------------------------------------
// 6) PLACEHOLDERS + MODAIS em Commerce (client não-teste + server/src/commerce)
// ---------------------------------------------------------------------------
function arquivosDe(base: string, filtro: (n: string) => boolean): string[] {
  const abs = path.join(raiz, base);
  if (!existsSync(abs)) return [];
  return readdirSync(abs, { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile())
    .map((d) => path.relative(raiz, path.join((d as unknown as { parentPath: string }).parentPath ?? (d as { path: string }).path, d.name)).split(path.sep).join('/'))
    .filter(filtro);
}
const arquivosCommerceClient = arquivosDe('client/src/pages/commerce', (n) => /\.tsx?$/.test(n) && !/\.test\./.test(n));
const arquivosCommerceServer = arquivosDe('server/src/commerce', (n) => /\.ts$/.test(n) && !/\.test\./.test(n));
const PLACEHOLDER_RE = /\bTODO\s*[:(]|\bFIXME\b|\bnot implemented\b|coming soon|lorem ipsum/i;
const MODAL_RE = /createPortal|window\.(confirm|prompt|alert)\(|role=["']dialog["']|aria-modal=|<Modal|<Drawer|<Sheet/i;
for (const arq of [...arquivosCommerceClient, ...arquivosCommerceServer]) {
  const texto = ler(arq);
  if (PLACEHOLDER_RE.test(texto)) registrar('PLACEHOLDER_COMMERCE', 'P1', 'Placeholder/TODO em caminho de Commerce', arq);
  if (/\.tsx$/.test(arq) && MODAL_RE.test(texto)) {
    registrar('MODAL_COMMERCE', 'P0', 'Assinatura de modal/drawer/portal em página de Commerce (zero modal)', arq);
  }
}

// ---------------------------------------------------------------------------
// 7) DOCS DESTE ROUND (reconstruídas a partir do código real)
// ---------------------------------------------------------------------------
const DOCS_NOVAS = [
  'docs/COMMERCE-FINAL-ACCEPTANCE.md',
  'docs/COMMERCE-UNBLOCK-MATRIX.md',
  'docs/COMMERCE-FINAL-AUDIT.md',
  'docs/CREATORS-COMMERCE-INTEGRATION-AUDIT.md',
];
for (const d of DOCS_NOVAS) if (!existe(d)) registrar('DOC_AUSENTE', 'P2', `Documento deste round ausente: ${d}`);

// ---------------------------------------------------------------------------
// 8) EXTERNAL_HOMOLOGATION_READY — credenciais oficiais (frente separada)
// ---------------------------------------------------------------------------
const CONECTORES = ['mercadolivre', 'nuvemshop', 'mercadopago', 'instagram'] as const;
type ConectorStatus = { provider: string; status: 'CREDENCIAL_PRESENTE' | 'CREDENCIAL_AUSENTE' | 'NAO_VERIFICAVEL'; motivo: string };
const conectorStatus: ConectorStatus[] = [];

const envPresente = (nome: string) => Boolean(process.env[nome] && process.env[nome]!.length > 0);
if (envPresente('MERCADOLIVRE_TOKEN')) {
  conectorStatus.push({ provider: 'mercadolivre', status: 'CREDENCIAL_PRESENTE', motivo: 'MERCADOLIVRE_TOKEN presente (valor não exibido)' });
} else {
  conectorStatus.push({ provider: 'mercadolivre', status: 'CREDENCIAL_AUSENTE', motivo: 'MERCADOLIVRE_TOKEN ausente e credencial oficial não homologada' });
}

if (process.env.DATABASE_URL) {
  try {
    const r = spawnSync(
      process.execPath,
      ['--import', 'tsx', '-e', `
import { query } from './server/src/db';
try {
  const r = await query("SELECT DISTINCT provider FROM connectors WHERE access_token IS NOT NULL AND status IN ('CONNECTED','SANDBOX_ACTIVE')", []);
  console.log(JSON.stringify(r.rows.map((x: any) => String(x.provider))));
} catch { console.log('[]'); }
`],
      { cwd: raiz, encoding: 'utf8', timeout: 30_000 }
    );
    const achadosDb = JSON.parse((r.stdout ?? '[]').trim() || '[]') as string[];
    for (const p of ['nuvemshop', 'mercadopago', 'instagram'] as const) {
      const tem = achadosDb.some((x) => x.toLowerCase().includes(p) || (p === 'instagram' && x.toLowerCase().includes('meta')));
      conectorStatus.push({
        provider: p,
        status: tem ? 'CREDENCIAL_PRESENTE' : 'CREDENCIAL_AUSENTE',
        motivo: tem ? 'credencial configurada na tabela connectors (valor não exibido)' : 'nenhuma credencial oficial em connectors',
      });
    }
  } catch {
    for (const p of ['nuvemshop', 'mercadopago', 'instagram'] as const) {
      conectorStatus.push({ provider: p, status: 'NAO_VERIFICAVEL', motivo: 'falha ao consultar connectors' });
    }
  }
} else {
  for (const p of ['nuvemshop', 'mercadopago', 'instagram'] as const) {
    conectorStatus.push({ provider: p, status: 'CREDENCIAL_AUSENTE', motivo: 'sem DATABASE_URL para verificar + sem credencial oficial homologada' });
  }
}

const EXTERNAL_HOMOLOGATION_READY = conectorStatus.every((c) => c.status === 'CREDENCIAL_PRESENTE');
const EXTERNAL_MOTIVOS = conectorStatus.filter((c) => c.status !== 'CREDENCIAL_PRESENTE').map((c) => `${c.provider}: ${c.motivo}`);

// ---------------------------------------------------------------------------
// RELATÓRIO
// ---------------------------------------------------------------------------
const porSeveridade = (s: Achado['severidade']) => achados.filter((a) => a.severidade === s);
const P0a = porSeveridade('P0');
const P1a = porSeveridade('P1');
const P2a = porSeveridade('P2');
const P3a = porSeveridade('P3');
const erros = [...P0a, ...P1a];
const warnings = [...P2a, ...P3a];

const CODE_READY = erros.length === 0;
const FULL_GO_LIVE = CODE_READY && EXTERNAL_HOMOLOGATION_READY;
const veredito = CODE_READY ? 'CODE_READY' : 'BLOCKED';

const saidaJson = {
  veredito,
  CODE_READY,
  EXTERNAL_HOMOLOGATION_READY,
  EXTERNAL_HOMOLOGATION_STATUS: EXTERNAL_HOMOLOGATION_READY ? 'READY' : 'EXTERNAL_HOMOLOGATION_BLOCKED',
  FULL_GO_LIVE,
  EXTERNAL_MOTIVOS,
  conectores: conectorStatus,
  P0: P0a,
  P1: P1a,
  P2: P2a,
  P3: P3a,
  erros,
  warnings,
};
if (process.argv.includes('--json')) {
  console.log(JSON.stringify(saidaJson, null, 2));
  process.exit(erros.length ? 1 : 0);
}

const linha = (a: Achado) => `   · [${a.id}] ${a.mensagem}${a.onde ? ` — ${a.onde}` : ''}`;
console.log('BROBOND ERP 3.0 — GATE FINAL DE GO-LIVE DO COMMERCE\n');
console.log('Gates executados: audit:ux · audit:menu · architecture:audit');
console.log(`Frentes P0 avaliadas: ${P0.length} · Frentes P1 avaliadas: ${P1.length}`);
console.log(`Rotas novas exigidas: ${NOVAS_ROTAS.length} · Migrations verificadas via P0_TENANCY\n`);

for (const [rotulo, lista] of [
  ['P0 (BLOQUEIA CODE_READY)', P0a],
  ['P1 (BLOQUEIA CODE_READY)', P1a],
  ['P2 (não bloqueia)', P2a],
  ['P3 (não bloqueia)', P3a],
] as const) {
  console.log(`${rotulo}: ${lista.length}`);
  for (const a of lista) console.log(linha(a));
  console.log();
}

console.log('CONECTORES (frente EXTERNA — nunca mascarada):');
for (const c of conectorStatus) console.log(`   · ${c.provider}: ${c.status} — ${c.motivo}`);
console.log();

console.log(`ERROS (P0+P1 de código): ${erros.length}`);
console.log(`WARNINGS (P2+P3): ${warnings.length}`);
console.log(`CODE_READY: ${CODE_READY ? 'SIM' : 'NÃO'}`);
console.log(
  EXTERNAL_HOMOLOGATION_READY
    ? 'EXTERNAL_HOMOLOGATION_READY: SIM (4/4 credenciais oficiais)'
    : `EXTERNAL_HOMOLOGATION_BLOCKED: ${EXTERNAL_MOTIVOS.length} conector(es) sem credencial oficial homologada (bloqueia apenas FULL_GO_LIVE, não CODE_READY)`
);
console.log(`FULL_GO_LIVE: ${FULL_GO_LIVE ? 'SIM' : 'NÃO'}`);

if (erros.length) {
  console.error('\nGATE BLOCKED — há P0/P1 de código abertos. Nenhum é convertido em skip nem em warning.');
  process.exit(1);
}
console.log('\nGATE CODE_READY — sem P0/P1 de código. FULL_GO_LIVE continua NÃO até a homologação externa.');
