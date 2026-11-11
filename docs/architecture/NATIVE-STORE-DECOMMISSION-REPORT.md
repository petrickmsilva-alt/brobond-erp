# NATIVE-STORE-DECOMMISSION-REPORT — relatório de retirada da loja nativa

**Data:** 2026-11-10 · **Branch:** `operations/pre-go-live-data-sanitization`
**Plano de origem:** [`NATIVE-STORE-DECOMMISSION.md`](NATIVE-STORE-DECOMMISSION.md)
· **Decisão:** ADR-0007 (aceita pelo Diretor).

> **Resultado desta fase: EXECUTADA.** A loja pública nativa `/loja` (React +
> `/api/loja/*`) foi retirada do código. A única loja pública de varejo é a
> **RETAIL WooCommerce** (`brobond.com.br`). Os serviços internos
> compartilhados (motor de checkout/pedidos, `checkoutMethods`, frete, cliente,
> Payment Engine, WooCommerce) **permanecem** — conforme a consequência
> obrigatória do ADR-0007. Nenhuma tabela, histórico, pedido, cliente, produto
> ou registro financeiro foi apagado.

---

## 1. O que foi retirado (execução)

| Item | Arquivo / rota | Situação |
|---|---|---|
| Rotas SPA `/loja*` | `client/src/App.tsx` (5 rotas) | **removidas** |
| Páginas da vitrine | `client/src/pages/commerce/loja/*` (5 páginas + shell + componentes) | **removidas** |
| Lógica de vitrine no cliente | `loja/{carrinho,cotacao,quantidade,mascaras}.ts` | **removida** |
| Config da loja (tela) | `client/src/pages/commerce/LojaConfigPage.tsx` | **removida** |
| Menu | `client/src/modules.ts` (`commerce-loja`, `commerce-abrir-loja`, grupo "Experiência") | **removidos** |
| API pública | `server/src/index.ts` (`/api/loja/*` + alias `/api/commerce/checkout/payment-intent` + `/api/commerce/loja/estado`) | **removidas** |
| Backend de vitrine | `server/src/commerce/vitrine.ts` | **removido** |
| SEO/SSR da vitrine | `server/src/commerce/storefront-seo.ts` | **removido** |
| Carrinho (−/+) | `server/src/commerce/quantidade-carrinho.ts` | **removido** (validador puro movido p/ `checkout-base.ts`) |
| Base da loja | `server/src/commerce/loja-base.ts` | **removido** (helpers compartilhados movidos p/ `checkout-base.ts`) |
| Estado da loja | `server/src/commerce/estado-loja.ts` + rota | **removidos** |

## 2. O que foi preservado (serviços compartilhados)

| Item | Arquivo | Por quê |
|---|---|---|
| Motor de pedido/checkout | `server/src/commerce/pedidos.ts` | cria `commerce_pedidos` também na importação WooCommerce |
| Base de checkout interna | `server/src/commerce/checkout-base.ts` (**novo**) | config, frete, responsável e validador de quantidade — agora um serviço interno, sem superfície pública |
| `checkoutMethods` | `modules/payments/api/routes.ts` | passou de pública (`/api/loja/payment-methods`) a **autenticada** (`POST /api/commerce/checkout/payment-methods`) — segue sendo o motor compartilhado |
| Payment Engine | `server/src/commerce/pagamento-ambiente.ts` | resolve o ambiente de pagamento sem depender do tenant da vitrine (`COMMERCE_PAGAMENTO_EMPRESA_ID`) |
| Normalização de comprador | `server/src/commerce/cliente.ts` | contato/consentimento usados por canais |
| Frete | `server/src/commerce/frete.ts` | usado por pedidos e canais |
| WooCommerce | `server/src/commerce/woocommerce/*` | RETAIL/WHOLESALE preservados |

## 3. Tratamento das URLs antigas

`server/src/commerce/loja-nativa-retirada.ts` responde as URLs `/loja*` que
ainda chegam (links salvos, SEO, histórico):

- **301** para a RETAIL quando `STOREFRONT_REDIRECT_URL` está definida
  (decisão de SEO do Diretor, sem alterar DNS);
- **410 Gone** quando não há destino;
- caminhos transacionais (`/loja/carrinho`, `/loja/checkout`, `/loja/pedido/*`)
  respondem **410** mesmo com a variável definida — nunca redirecionam um
  carrinho para outra loja.

A resposta é explícita: nunca um 200 enganoso (index do ERP) nem um 404 mudo.

## 4. Prova de coerência

- `server/test/fase2-loja-coerencia.test.ts` trava o estado final: superfície
  pública retirada, módulos exclusivos removidos, serviços compartilhados
  preservados, URLs antigas com tratamento explícito, menu sem a Loja própria.
- Suíte rápida do servidor e gate PostgreSQL real (`npm run test:pg`) verdes.

## 5. Fora de escopo (permanece)

- Alteração de DNS de `brobond.com.br` / `atacado.brobond.com.br` — não feita.
- Homologação externa das integrações (WooCommerce/Representantes) — pendente.
- Fluxo de compra do RETAIL contra a loja real — depende de credenciais e
  homologação (não é prova de código).

---

*Status:* **retirada executada no código · serviços compartilhados preservados ·
nenhuma alteração de produção (dados ou DNS)**.
