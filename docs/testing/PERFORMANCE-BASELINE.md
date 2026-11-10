# PERFORMANCE BASELINE — Fase 9.6

**Data:** 2026-11-09 · **Branch:** `architecture/fases-9-4-9-5-9-6`
**Banco:** PostgreSQL 16.14 local (`brobond_gate`), dados da bateria `test:pg`.

> **Escopo.** Medições **reproduzíveis** em banco de teste com dados
> representativos. Nenhum benchmark pesado, nenhuma operação destrutiva, nenhuma
> alteração de query para "melhorar" número artificialmente. Nenhum índice foi
> criado nesta fase (não houve consulta crítica sem cobertura adequada).

## 1. Consultas críticas medidas (`EXPLAIN (ANALYZE, BUFFERS)`)

Volume de dados: `produtos` 1290 · `lancamentos_financeiros` 10159 ·
`movimentacoes` 2134 · `vendas` 94 · `commerce_outbox` 8.

| Consulta | Plano | Índice | Tempo |
|---|---|---|---|
| Listagem de produtos por empresa (`ORDER BY nome LIMIT 50`) | Index Only Scan | `idx_produtos_empresa_nome_id` | ~0,08 ms |
| Contagem de produtos por empresa | Index Only Scan | `idx_produtos_empresa_nome_id` | ~0,12 ms |
| Soma de lançamentos por empresa e período | Index Scan | `lanc_fin_empresa_data_idx` | ~0,07 ms |
| Contagem de movimentações por produto | Index Only Scan | `e42_mov_empresa_produto_idx` | ~0,07 ms |
| Claim da outbox (PENDENTE/INDETERMINADO por vencimento) | BitmapOr + Sort | `ix_commerce_outbox_fila`, `ix_commerce_outbox_devida` | ~0,06 ms |

## 2. Anti-padrões verificados

- **N+1**: o recorte por empresa é aplicado no SQL (`pg-multiempresa.test.ts`);
  a listagem usa índice composto por empresa + ordenação.
- **Full table scan**: as consultas críticas usam índice; a única Seq Scan
  observada (`vendas` por empresa+status, 94 linhas) é apropriada para tabela
  pequena — o planner escolhe corretamente.
- **Paginação não determinística**: listagens ordenam por campo estável
  (`orderBy` do recurso); `produtos` usa `idx_produtos_empresa_nome_id`.
- **Consultas sem limite**: `pageSize` é limitado pelo serviço; o balancete usa
  `pageSize` explícito (20000 lançamentos) com recorte por empresa e período.
- **Locks prolongados / transações longas**: o outbox usa claim CAS com fencing
  (`claim_versao`) — provado em `pg/enterprise-integrity.test.ts`
  ("fencing rejeita worker antigo após nova lease").
- **Agregações em memória**: o balancete soma em memória **apenas** os
  lançamentos já recortados por empresa e período (não há agregação de toda a
  base); o total do período é conferido no teste da Fase 9.6 (E).

## 3. Índices

Nenhum índice novo foi criado nesta fase. Os índices existentes cobrem as
consultas críticas. A migração 0115 acrescentou **2** índices em `fiscal_layouts`
(`uq_fiscal_layouts_sistema_versao`, `fiscal_layouts_sistema_vigencia_idx`),
ambos justificados:

- `uq_fiscal_layouts_sistema_versao` — impede duplicar a versão de um sistema
  (unicidade semântica real, não só performance);
- `fiscal_layouts_sistema_vigencia_idx` — serve à resolução do leiaute vigente
  por `(sistema, ativo, vigencia_inicio)`, a consulta de `resolverLeiauteVigente`.

Nenhum índice redundante foi adicionado (não há sobreposição com os existentes).

## 4. Conclusão

O desempenho **não regrediu**: as consultas críticas permanecem em índice, com
tempos sub-milissegundo em banco de teste. Não há índice ausente comprovado nem
índice redundante a remover. Recomenda-se repetir estas medições quando o volume
de `lancamentos_financeiros` e `movimentacoes` crescer uma ordem de magnitude.
