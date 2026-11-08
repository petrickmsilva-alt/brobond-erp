# ADR-0006 — RETAIL e WHOLESALE (multi-store WooCommerce)

* **Identificador:** ADR-0006
* **Título:** RETAIL e WHOLESALE como lojas WooCommerce independentes
* **Status:** Aceita
* **Data:** 2026-11-07
* **Relacionados:** ADR-0005, ADR-0007, ADR-0013

## Contexto

A estrutura comercial oficial reconhece RETAIL (WooCommerce, `brobond.com.br`),
WHOLESALE (WooCommerce, `atacado.brobond.com.br`) e REPRESENTATIVES (portal,
`catalogo.brobond.com.br`). Existe registry multi-loja em
`server/src/commerce/woocommerce/` e um caminho legado por env (`loja.ts`).

## Problema

Como duas lojas WooCommerce coexistem sem duplicar cadastro mestre nem colidir
pedidos/preços/estoque.

## Decisão

1. **Cadastro mestre único** (ERP): produto, estoque, cliente, pedido, financeiro
   não são duplicados por loja.
2. Cada loja é uma **instância** identificada por `store_key`
   (`RETAIL`/`WHOLESALE`).
3. **Pedido externo** = `WOO-<LOJA>-<id>` (identidade forte por loja).
4. **Preço por loja:** `commerce_precos.store_key` faz override autorizado;
   ausência → valor do ERP.
5. **WHOLESALE** valida quantidade mínima de atacado no backend.
6. Cada canal é **independente** e operacional por conta própria.

## Alternativas consideradas

- **Uma loja só:** rejeitada. Varejo e atacado têm regras distintas.
- **Duplicar cadastro por loja:** rejeitada (proibido).

## Consequências

- Convivência legado × multi-store gerenciada por runbook de cutover.
- Painéis e ações por loja com RBAC e escopo de tenant.

## Riscos

- Caminho legado (`loja.ts`) ainda ativo → runbook
  `docs/AGENTE-07-RUNBOOK-CUTOVER-LEGADO-MULTISTORE.md`.
