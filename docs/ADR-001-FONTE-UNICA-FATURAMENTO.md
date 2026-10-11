# ADR-001 — Fonte única do faturamento (o ERP alimenta o BI)

* **Status:** aceita em 2026-10-11 (ciclo ERP-04, gaps **P0-03** e **P1-07**).
* **Escopo:** módulo 1. MEU NEGÓCIOS (`server/src/negocios.ts`), tabela `sales`/
  `sale_items` e a fronteira com a ingestão de canais externos
  (`modules/connectors`).
* **Regra do ciclo:** esta decisão é registrada **antes** do código — o roadmap
  (§ERP-04) exige decisão de arquitetura por escrito na fronteira ERP × Commerce,
  e a recomendação preliminar do roadmap era a opção (A). Este ADR **a substitui**
  com a justificativa abaixo; a recomendação preliminar não conhecia dois fatos
  que a investigação do ciclo levantou (evidências 3 e 4).

---

## 1. O problema (com evidência)

O painel 1. MEU NEGÓCIOS lê a tabela `sales` (criada na fusão do Commerce,
`db/migrations/0012_fusion_commerce_into_erp.sql`) — e **só ela**:

* `server/src/negocios.ts:494/501/557/568/573` (margens), `:643/704/717/727`
  (leitura e contagem), `:831` (curva ABC) — todas as queries do motor apontam
  para `sales`/`sale_items`;
* a materialização de margem (`SQL_RECALCULAR_MARGENS`) **grava** as colunas
  `net_cents`, `cmv_cents`, `tax_cents`, `gross_profit_cents`, `margin_pct` em
  `sales`;
* a ingestão de canais externos grava `sales`/`sale_items`
  (`modules/connectors/ingestion/sales.service.ts`, `sale-ingestion.service.ts`).

A venda do ERP vive em **outra** tabela: `vendas`/`itens_venda` (`db/schema.sql`
+ `migrations/0017`, `0020`, `0024`, `0031`), alimentada pelo PDV
(`server/src/pdv.ts:619`), pelo site (`server/src/catalogos.ts:371`), por
representante (`server/src/propostas.ts:466`), pelo portal (`server/src/portal.ts:156`),
e faturada por `faturarVenda` (`server/src/itens.ts:302`).

**Resultado (evidência que abriu o P0-03):** venda faturada pela API →
`GET /api/negocios/resumo` devolve `faturamentoCents: 0, pedidos: 0`, enquanto
`GET /api/relatorios/vendas` mostra a venda. O painel do ERP não enxerga o
faturamento do ERP.

## 2. Evidências que a recomendação preliminar (opção A) não considerava

1. **A ingestão externa escreve `sales` e é código DESTE repositório.** Os
   conectores (Instagram, Mercado Livre, Mercado Pago, Nuvemshop) não são um
   sistema externo que "só manda arquivo": o `INSERT INTO sales` está em
   `modules/connectors/` e é exercitado por `server/test/connectors.test.ts`
   (435, 519, 550, 794, 845). Trocar a origem do motor para `vendas` faria o BI
   **perder** as vendas de canal externo — a menos que o motor passe a ler as
   duas tabelas em união.
2. **O motor materializa a margem em `sales`.** Um `UPDATE sales` não tem onde
   escrever a margem de uma venda do ERP: a união exigiria **duas versões da
   mesma matemática de CMV/NCM** (a do `UPDATE` para `sales` e uma versão
   `SELECT` para `vendas`) — exatamente a "regra duplicada" que a auditoria
   classifica como risco (§18 do relatório).
3. **A curva ABC e o painel dos conectores também leem `sales`** (`negocios.ts:643`
   e `modules/connectors/core/panel.service.ts:127/137/153`). O painel é escopado
   por `usuario_id + channel` e o mapa `SALE_CHANNEL_BY_PROVIDER`
   (`modules/connectors/core/providers.ts:221`) **só** produz
   `MERCADOLIVRE`, `MERCADOPAGO`, `NUVEMSHOP` e `INSTAGRAM_SHOPPING` — os canais
   do ERP (`LOJA_FISICA`, `BROBOND`) **não** são canal de conector nenhum.
   Consequência: uma linha do ERP dentro de `sales` não vaza para painel de
   conector.
4. **Já existe precedente de escrita do ERP em `sales`.** `POST /api/negocios/vendas`
   (venda manual, `negocios.ts:781-830`) insere em `sales` **e** roda a mesma
   query de margem na mesma transação. A tabela `sales` já é, de fato, o modelo
   de leitura analítico — o que falta é o fluxo operacional alimentá-la.

## 3. Opções avaliadas

| # | Opção | O que custa | Risco |
|---|---|---|---|
| **A** | Motor passa a ler `vendas`/`itens_venda` (mantendo `sales` para canais externos) | Reescrever 6 queries + curva ABC + filtros para uma união; criar a versão `SELECT` da matemática de margem; recalcular CMV/impostos a cada leitura das vendas do ERP | Matemática duplicada (CMV/NCM `UPDATE` × `SELECT`); toca o código de ingestão congelado; sem `margem_calculada_em` para as vendas do ERP |
| **B** | `sales` é **modelo de leitura derivado**: projeção idempotente `vendas → sales` | Uma rotina de sincronização (~150 linhas) + gancho pós-faturamento | "Duas verdades" se a projeção vazar do namespace ou for editada à mão → mitigado por invariantes (abaixo) |
| **C** | Unificar as duas tabelas numa só | Migração de dados com backfill das duas origens; reescrever tudo o que toca `vendas` **ou** `sales` | Maior custo e maior risco; muda o modelo operacional (PDV, fiscal, expedição, financeiro leem `vendas`) |

## 4. Decisão

**Opção (B) — projeção derivada, com disciplina de namespace.**

Justificativa: (A) duplica a matemática de margem e mexe no caminho congelado da
ingestão; (C) migra dados sem necessidade; (B) reusa tudo o que já é testado
(margem materializada, curva ABC, filtros de canal, painéis) e **não** altera a
ingestão nem uma linha. A "duas verdades" deixa de ser risco quando a tabela é
tratada pelo que ela é: **`vendas` é a fonte autoritativa da venda do ERP;
`sales` é o modelo de leitura analítico, derivado e re-derivável.**

### Invariantes (não negociáveis)

1. **Namespace:** toda linha derivada do ERP usa `sales.id = 'erp:venda:<id>'` e
   `sale_items.id = 'erp:item:<id>'`. O que não tem esse prefixo é de outra
   origem.
2. **O sincronizador nunca escreve fora do namespace `erp:`** — nenhum `UPDATE`
   ou `DELETE` do sincronizador pode tocar uma linha de conector.
3. **Idempotência e re-derivação:** a sincronização usa `INSERT … ON CONFLICT
   (id) DO UPDATE`; rodar duas vezes seguidas tem o mesmo resultado de rodar uma,
   e apagar as linhas `erp:` e ressincronizar reconstrói o estado.
4. **Sem invenção de dado:** campo que o ERP não tem vira `NULL`/`0` e está
   documentado (frete da venda, desconto por item, `external_order_id`); o canal
   é mapeado por tabela explícita (abaixo); nenhum marketplace é inventado.
5. **Uma origem por linha:** nenhuma linha `erp:` é editada à mão — quem manda é
   a venda; a projeção é reescrita pela sincronização.
6. **Escopo por empresa:** `empresa_id` vem da venda; o BI já aplica escopo de
   ator por empresa (`aplicarEscopoEmpresaBi`) e a projeção não abre exceção.

### Mapeamento (o que muda de vocabulário, e por quê)

| ERP (`vendas`) | `sales` (`sale_status`) | Regra |
|---|---|---|
| `status = faturada`, `entregue` | `PAID` | é o que conta como faturamento no relatório (`FATURADAS` em `relatorios.ts`) |
| `status = cancelada` **com** `faturada_em` | `CANCELLED` | venda faturada e depois estornada — histórico preservado, fora dos totais |
| `status = aberta` / `cancelada` sem `faturada_em` | (não projetada) | pedido/proposta não é venda; se existir projeção antiga, ela é removida |

| ERP (`canal_venda`) | `sales.channel` | Por quê |
|---|---|---|
| `pdv`, `balcao` | `LOJA_FISICA` | venda presencial |
| `site_varejo`, `site_atacado`, `representante`, `whatsapp`, `outro` | `BROBOND` | canal próprio do ERP |
| `marketplace` | `BROBOND` | **limitação declarada:** o ERP registra "vendeu em marketplace", não *qual*; inventar `MERCADOLIVRE`/`MERCADOPAGO` seria criar dado. A venda entra no canal próprio até o ERP registrar a origem |

Outros campos: `occurred_at = COALESCE(faturada_em, data, criado_em)`;
`amount_cents = ROUND(total × 100)`; `quantity = Σ itens_venda.quantidade`;
`reference = 'ERP-<empresa>-<venda>'`; `usuario_id` = **responsável técnico** eleito pela
projeção (a coluna é `NOT NULL` no schema do Commerce): o **primeiro usuário ativo da empresa** da
venda e, se essa empresa não tiver nenhum, o **primeiro usuário ativo do sistema** (fallback
global). O `empresa_id` da linha é sempre o da venda — quem lê o BI é escopado por ele.

## 5. Consequências

* **BI passa a refletir a operação** sem reimplementar `negocios.ts`, sem
  migration e sem tocar a ingestão de canais externos.
* **Curva ABC, margens e filtros de canal continuam com uma única
  implementação** — a que já existia e já é testada.
* **Risco residual 1 — projeção atrasada:** mitigado por (a) gancho
  pós-faturamento com debounce, (b) ciclo contínuo do motor (boot + intervalo +
  cron), (c) `POST /api/negocios/recalcular` sob demanda. O critério de aceite do
  ciclo admite "na requisição seguinte ou após o ciclo de refresh documentado".
* **Risco residual 2 — divergência de vocabulário** (status/canal citados
  acima): documentada na tabela de mapeamento; o teste e2e fixa o
  comportamento.
* **Risco residual 3 — venda de empresa sem usuário ativo (revisado pela auditoria
  independente de 2026-10-11):** enquanto existir **um** usuário ativo em qualquer empresa, a
  venda é projetada e assinada pelo fallback global (acima) — o `empresa_id` continua o da venda
  e **nenhum dado cruza de empresa em tela alguma** (o BI escopa por `empresa_id`; o painel dos
  conectores lê por `usuario_id + channel` de **conector**, e a projeção só produz
  `LOJA_FISICA`/`BROBOND`). Com **zero** usuários ativos no sistema, a venda não entra em `sales`
  — e o passo dos itens, que não repetia a condição de responsável, fazia a instrução violar a FK
  `sale_items_sale_id_fkey` e abortar a projeção inteira (erro `23503`, exposto como `400
  "Referência inválida"` na via sob demanda). **Registrado como P2-08** em
  [`docs/RELATORIO-ERP-ONLY.md`](RELATORIO-ERP-ONLY.md) e detalhado na
  [auditoria independente](AUDITORIA-INDEPENDENTE-ERP-01-04.md) §6 — **não corrigido** (a
  auditoria documenta, não corrige).

## 6. Plano de prova (critérios de aceite do ERP-04)

1. `server/test/pg/bi-faturamento-e2e.test.ts` (banco novo, servidor real):
   vender **e faturar pelo fluxo do ERP** → o BI reflete faturamento, pedidos,
   ticket médio, CMV, impostos e ABC **com os mesmos valores** dos relatórios.
2. **Igualdade numérica:** `GET /api/negocios/resumo` × `GET /api/relatorios/faturamento`
   para o mesmo período/empresa, tolerância **zero** em centavos.
3. **Curva ABC** classifica o produto vendido pelo ERP.
4. **Não-regressão declarada:** uma venda de canal externo inserida como a
   ingestão insere continua intacta depois da sincronização (bytes conferidos) e
   continua somando no BI.
5. Regressão: suítes existentes do motor (`negocios.test.ts`,
   `negocios-seguranca.test.ts`, `pg-negocios.test.ts`) passam **sem afrouxar
   asserção**.
