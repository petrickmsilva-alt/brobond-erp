# DOMAIN INTEGRATION MATRIX — Fase 9.6

**Data:** 2026-11-09 · **Branch:** `architecture/fases-9-4-9-5-9-6`

Cadeias operacionais entre domínios e a prova de cada uma. Cada linha indica a
**entrada**, a **regra**, a **persistência** e o **teste** que a trava. Quando a
cadeia depende de PostgreSQL real (constraint, transação, índice, isolamento), o
teste vive em `server/test/pg/`.

| # | Cadeia | Teste que prova | Nível |
|---|---|---|---|
| 1 | Produto → Estoque → Venda → Financeiro → BI | `pg/fase9-6-enterprise-validation.test.ts` (E), `pg/bi-faturamento-e2e.test.ts` | PG real |
| 2 | Compra → Estoque → Custo → Contas a pagar → Financeiro | `pg/enterprise-wave2-purchase.test.ts`, `pg/closure-procurement.test.ts` | PG real |
| 3 | Produção → Estoque → Custo | `pg/enterprise-wave2-mrp.test.ts`, `pg/pg-supply-chain-mrp.test.ts` | PG real |
| 4 | Venda → Expedição → Estoque | `pg/e423-expedicao-postgresql.test.ts` | PG real |
| 5 | Venda → Devolução → Estoque → Financeiro | `pg/devolucao-e2e.test.ts` | PG real |
| 6 | Pagamento → Recebimento → Conciliação | `pg/payment-engine.test.ts`, `pg/closure-bank.test.ts`, `pg/closure-payment-safety.test.ts` | PG real |
| 7 | Pedido WooCommerce → ERP → Estoque → Financeiro | `pg/woocommerce-multistore-pg.test.ts`, `pg/commerce-e2e.test.ts` | PG real |
| 8 | CRM → Atividade → Notificação | `fase9-2-crm-lifecycle.test.ts`, `pg/fase9-2-crm-lifecycle.test.ts` | memória + PG |
| 9 | Financeiro → Plano de contas → Centro de custo | `pg/fase9-6-enterprise-validation.test.ts` (E), `financeiro-contabil.test.ts`, `pg/enterprise-integrity.test.ts` | memória + PG |
| 10 | Insumo → Unidade de medida → Conversão → Produção | `estoque-unidades-medida.test.ts`, `pg/fase9-6-enterprise-validation.test.ts` (D) | memória + PG |
| 11 | Documento fiscal → Validação → Exportação (estrutural) | `fase9-5-fiscal-efd.test.ts`, `pg/fase9-6-enterprise-validation.test.ts` (C) | memória + PG |
| 12 | Multiempresa → Autorização → Auditoria | `pg/fase9-6-enterprise-validation.test.ts` (A/B), `pg/e03-multiempresa-ab.test.ts`, `pg/pg-auditoria-multiempresa.test.ts` | PG real |

## O que cada cadeia prova

Para cada cadeia valida-se: **entrada**, **regras**, **persistência**,
**transação**, **resultado**, **eventos**, **efeitos colaterais**, **auditoria**,
**tratamento de erro** e **recuperação**. Não basta status HTTP 200 — a prova
lê o **estado persistido** no banco (saldo, título, movimentação, balancete).

### Fase 9.4 — cadeia comercial

- **Identidade comercial** (`fase9-4-canais-comerciais.test.ts`): RETAIL e
  WHOLESALE isolados por `store_key`; REPRESENTATIVES sem conector aparece como
  `nao_homologado` (nunca "conectado").
- **Webhooks** (`woocommerce-webhooks-reconciliacao.test.ts`,
  `pg/woocommerce-multistore-pg.test.ts`): idempotência por chave, isolamento
  por loja/empresa, reprocessamento seguro.

### Fase 9.5 — cadeia financeira e fiscal

- **Plano de contas** (`fase9-5-plano-contas.test.ts`): hierarquia, ciclo,
  conta sintética × analítica, isolamento multiempresa.
- **Importação contábil** (`financeiro-importacao-contabil.test.ts`,
  `pg/enterprise-integrity.test.ts`): idempotência, período fechado, replay.
- **Fiscal** (`fase9-5-fiscal-efd.test.ts`): leiaute versionado + validador
  estrutural (gramática, filhos obrigatórios, referências, totais, duplicidade,
  período). Homologação externa pendente — ver `docs/fiscal/`.

## Fontes de verdade (não duplicadas)

- Estoque: derivado das movimentações (`saldoDoLoteMov`) — nunca coluna de saldo.
- Financeiro: livro único `lancamentos_financeiros`; o balancete **soma** o que
  já está lançado, sem segundo livro nem partida dobrada gerada por código.
- Fiscal: `regras_fiscais` é a fonte dos códigos; `fiscal_layouts` (0115) governa
  a **versão** do leiaute por período.
- Unidades: o ERP converte **somente** o que a empresa declarou em
  `unidade_conversoes`; sem regra → `null`, nunca estimativa.
