# ADR-0008 — Separação operacional × analítico

* **Identificador:** ADR-0008
* **Título:** Separação operacional × analítico (`vendas` × `sales`)
* **Status:** Aceita
* **Data:** 2026-11-07
* **Relacionados:** ADR-0003, `docs/ADR-001-FONTE-UNICA-FATURAMENTO.md`

## Contexto

`vendas`/`itens_venda` são a estrutura operacional; `sales`/`sale_items` são a
projeção analítica multicanal. A auditoria de duplicidades classificou a relação
como **bounded context**, não duplicidade.

## Problema

Evitar que a projeção analítica se torne fonte operacional (ou vice-versa) e
evitar vendas duplicadas.

## Decisão

1. `vendas`/`itens_venda` = **escrita operacional**.
2. `sales`/`sale_items` = **read model** (projeção + ingestão de canal).
3. BI **não** altera registro operacional.
4. Projeção **não** cria venda duplicada; atualização **idempotente**.
5. Rastreabilidade da origem preservada (`sales.operational_venda_id`).
6. Escopo de empresa em todo relatório.
7. **Não** unificar `vendas` e `sales` (destruiria a rastreabilidade por canal).

## Alternativas consideradas

- Unificar: rejeitada.
- Tratar `sales` como fonte oficial: rejeitada (é projeção).

## Consequências

- Fluxo `vendas → sales` via projeção idempotente (`negocios.ts`).
- BI lê `sales`; operação escreve `vendas`.

## Riscos

- Venda com `pedido_externo_id` ausente no BI → corrigido no Agente 07 (A06-05).
