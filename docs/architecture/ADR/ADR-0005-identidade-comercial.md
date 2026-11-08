# ADR-0005 — Identidade comercial

* **Identificador:** ADR-0005
* **Título:** Identidade comercial (empresa × canal × loja × plataforma × representante)
* **Status:** Aceita
* **Data:** 2026-11-07
* **Relacionados:** `docs/ADR-008-IDENTIDADE-CANAL-COMERCIAL.md`, ADR-0006

## Contexto

O ADR-008 (Agente 07, achado A06-10) mostrou que a identidade de canal colapsava
tudo em `BROBOND`, tornando o BI cego a RETAIL/WHOLESALE/REPRESENTATIVE.

## Problema

Distinguir origem de negócio de forma consistente em pedidos, vendas, relatórios,
integrações, comissões, estoque e financeiro.

## Decisão

Cinco conceitos distintos:

| Conceito | Representação |
|---|---|
| Empresa (tenant) | `empresa_id` |
| Canal comercial | `sale_channel` / `canal_venda` (`BROBOND`/`RETAIL`/`WHOLESALE`/`REPRESENTATIVE`/`MARKETPLACE`/`PDV`) |
| Loja | `store_key` (`RETAIL`/`WHOLESALE`) |
| Plataforma externa | `pedido_externo_canal` (`WOOCOMMERCE_RETAIL`, …) |
| Representante | `representante_id` + canal `REPRESENTATIVE` |

Compatibilidade preservada: `BROBOND` continua válido; a mudança é **aditiva**.

## Alternativas consideradas

- Colapsar em `BROBOND` (status quo): rejeitada.
- Criar enum novo só para Woo: rejeitada (duplicaria o conceito).
- Inferir loja pelo número do pedido: rejeitada (colide entre lojas).

## Consequências

- BI distingue origens reais; operação e analítico usam a mesma semântica.
- Registros legados ambíguos permanecem como estão.

## Riscos

- Relação `/loja` nativo × RETAIL era decisão pendente → **resolvida** em
  ADR-0007.
