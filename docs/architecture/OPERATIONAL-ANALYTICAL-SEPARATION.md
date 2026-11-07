# OPERATIONAL-ANALYTICAL-SEPARATION — operacional × analítico

**Data:** 2026-11-07 · **Branch:** `architecture/fase-2-canonical-erp-data`
**Referência:** ADR-0008, [`CANONICAL-DATA-MODEL.md`](CANONICAL-DATA-MODEL.md).

> **Regra.** BI e relatórios **leem**; nunca escrevem a operação. A projeção
> analítica é **idempotente**, rastreável e **não** cria venda duplicada.

---

## 1. Camadas

| Camada | Papel | Tabelas | Escrita |
|---|---|---|---|
| Operacional (escrita) | transação do ERP | `vendas`, `itens_venda`, `estoques`, `movimentacoes`, `estoque_reservas`, `lancamentos_financeiros`, `comissoes_*`, `envios` | domínios donos |
| Operacional (consulta) | telas/relatórios do ERP | views/agregações sobre o operacional | **não** escreve |
| Projeção analítica | read model de canal | `sales`, `sale_items`, `commerce_pedidos` | ingestão idempotente |
| Agregação / BI | dashboards | `commerce/analytics.ts` | **somente leitura** |

## 2. Fluxo de sincronização

```
pedido externo (plataforma)
   └─▶ sales / sale_items            (projeção, chave: reference = WOO-<store>-<id>)
        └─outbox 'conversao'─▶ vendas / itens_venda   (operação)
             ├─▶ estoque (movimentacoes + reservas)
             ├─▶ financeiro (lancamentos)
             └─▶ comissões (comissoes_apuradas)
```

- A conversão é **idempotente** por `(empresa, tipo, chave)`: reprocessar não
  cria segunda venda.
- `sales.status` é **projeção** (PENDING/PAID/…); não substitui a verdade
  operacional nem a liquidação financeira.
- Rastreabilidade: `sales.operational_venda_id` liga projeção → operação.

## 3. Regras

1. BI **não** altera registro operacional.
2. Projeção **não** cria venda duplicada (idempotência por chave).
3. Venda de canal externo **não** se perde (reconciliação periódica).
4. Atualização de projeção é idempotente e preserva a origem.
5. Todo relatório tem **escopo de empresa** (`empresa_id`).
6. `vendas` × `sales` **não** são unificadas (operacional + read model é
   intencional; unificar criaria fonte concorrente).

## 4. Margem e CMV

`sales.gross_profit_cents`/`margin_pct` existem **só no PostgreSQL** (motor de
margem). No modo demonstração a resposta traz `null` com o motivo — **nunca** um
zero inventado para preencher a tela (`commerce/analytics.ts`).

## 5. Evidência

- `server/test/commerce-oracle.test.ts` — fórmulas de analytics.
- `server/test/agente07-comercio-saneamento.test.ts` — ingestão/reconciliação.
- `server/test/fase2-nucleo-canonico.test.ts` — disponibilidade canônica.

## 6. GAPs

| GAP | Severidade | Ação |
|---|---|---|
| `sale_items` sem `empresa_id` (projeção) | P3 | herda `sales`; recorte no SQL na Fase 3 (BL-016) |
| Analytics lê `sale_items` com `filter:{}` (over-fetch) | P3 | mesmo item acima |
