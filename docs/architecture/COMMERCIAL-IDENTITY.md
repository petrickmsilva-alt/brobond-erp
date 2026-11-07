# COMMERCIAL-IDENTITY — identidade comercial (ADR-0005 / ADR-0008)

**Data:** 2026-11-07 · **Branch:** `architecture/fase-2-canonical-erp-data`
**Referência:** [`CANONICAL-DATA-MODEL.md`](CANONICAL-DATA-MODEL.md), ADR-0005.

> **Regra.** A identidade de um pedido externo combina **empresa + canal + loja
> (`store_key`) + plataforma + id externo**. Nenhum desses eixos é opcional; é o
> que impede que o pedido `42` da RETAIL seja confundido com o pedido `42` da
> WHOLESALE.

---

## 1. Os cinco eixos

| Eixo | Onde vive | Valores | Observação |
|---|---|---|---|
| **Empresa** | `empresa_id` (todas as tabelas) | inteiro | fronteira do tenant |
| **Canal comercial** | `canal_venda` / `channel` | `site_varejo`, `site_atacado`, `BROBOND`, … | vocabulário de venda |
| **Loja** | `store_key` | `RETAIL`, `WHOLESALE` | identidade imutável (registry) |
| **Plataforma** | `pedido_externo_canal` / provider | `WOOCOMMERCE_<STORE>`, `MERCADOLIVRE`, … | integração externa |
| **Representante** | `representante_id` | inteiro | REPRESENTATIVES |

## 2. Endereços públicos por canal

| Canal | Loja (`store_key`) | Endereço | Preço-fonte |
|---|---|---|---|
| RETAIL | `RETAIL` | https://brobond.com.br | `produtos.preco_venda` |
| WHOLESALE | `WHOLESALE` | https://atacado.brobond.com.br | `produtos.preco_atacado` |
| REPRESENTATIVES | — | https://catalogo.brobond.com.br | preço de catálogo/representante |

## 3. Referência de pedido externo

```
WOO-<store_key>-<id_externo>      ex.: WOO-RETAIL-1001, WOO-WHOLESALE-1001
```

- Referência **nova** (com loja) é identidade forte — sempre adotada.
- Referência **legada** (`WOO-<id>`) só é adotada quando o canal de origem está
  **comprovado**; caso contrário é tratada como venda distinta e o conflito é
  registrado (`registrarConflitoIdentidade`). Nunca é resolvida por adivinhação.
- Um `store_key` nunca serve duas empresas (`ConfigStore.empresaId`).

Implementação: `server/src/commerce/woocommerce/pedidos.ts` (`referenciaPedido`,
`identidadeDoPedido`); registry: `.../registry.ts` (`STORE_KEYS`, `FONTE_PRECO`,
`CANAL_PEDIDO`, `STORE_LABEL`).

Prova: `server/test/fase2-identidade-comercial.test.ts` — mesmo id externo em
lojas diferentes **não** colide.

## 4. Consistência da identidade

A mesma identidade (`empresa + store_key + canal`) é usada em:

| Consumidor | Como usa |
|---|---|
| Pedidos / vendas | `canal_venda`, `pedido_cliente` = `WOO-<store>-<id>` |
| Relatórios / BI | `sales.channel`, agrupamento por canal |
| Integrações | `pedido_externo_canal = WOOCOMMERCE_<STORE>` |
| Comissões | representante × venda (não depende de store, mas nunca cruza empresa) |
| Estoque | recorte por empresa (célula canônica) |
| Financeiro | lançamento por empresa |

## 5. O que NÃO se faz

- Não reclassificar registro histórico ambíguo sem evidência de origem.
- Não usar o **nome** de uma loja para inferir a loja de um pedido.
- Não tratar `store_key` como sinônimo de `canal_venda` (loja ≠ canal de venda).
- Não permitir que uma loja atenda duas empresas.

## 6. GAPs

| GAP | Severidade | Ação |
|---|---|---|
| Pedidos legados `WOO-<id>` sem canal comprovado | P3 | mantidos como vendas distintas; conflito auditado |
| Portal de representantes sem `store_key` próprio | P3 | canal REPRESENTATIVES por identidade de representante |
