# RELATÓRIO — ERP-02.1: fechamento do GAP de leituras completas na Produção

**Data:** 2026-10-12
**Repositório:** `petrickmsilva-alt/brobond-erp`
**Branch:** `arena/0c720c09-brobond-erp`
**Base:** `b907796f26cc800f06db4ce90046fed7ab390cd4` (merge do PR #54)
**Commit da correção ERP-02.1:** `20e14c8d913320da90a4104f98ba8a3a85d0a332`
**Head validado com PostgreSQL 16.14 pinado:** `da619c7eca9ce5363bc29fb12bf00075074d4e8c`
**PR:** [#55](https://github.com/petrickmsilva-alt/brobond-erp/pull/55) — aberto, sem merge
**PostgreSQL oficial para esta evidência:** **16.14**. O servidor local retornou `SHOW server_version = 16.14`; `.github/workflows/ci.yml` fixa a imagem `postgres:16.14` e valida a versão reportada pelo servidor.

**Escopo:** leituras completas do caminho de custo/insumos e do ciclo de produção/estorno, regressões PostgreSQL e documentação; fixação da versão do PostgreSQL usada como evidência. Sem alteração de frontend/UX/menu, Commerce/Marketplace/BI, Fiscal, Financeiro, RBAC, reservas, devoluções, schema ou migrations. Nenhuma implementação funcional de ERP-03 foi iniciada.

> **Separação obrigatória:** P0-01 é histórico e já estava fechado na base; G1–G5 são as proteções do ERP-02 preservadas; **GAP-E02-02** é a auditoria específica da cardinalidade das movimentações acima dos limites antigos. O defeito recém-reproduzido nas duas leituras da ficha técnica também está discriminado, sem confundir sua correção com P0-01 ou com a prova de movimentações.

## Veredito e estado dos PRs

**ERP-02.1 FINAL GATE: APPROVED** — a leitura truncada foi reproduzida antes da correção; a menor correção reutiliza `listarTodos`; as regressões em PostgreSQL real passam; os dois jobs de CI do commit de correção passaram. A evidência em PostgreSQL foi executada em banco isolado, na versão oficial 16.14. A atualização que fixa a mesma versão no CI é revalidada pelos checks atuais do PR antes do fechamento desta rodada.

**ERP-03 READINESS: READY TO START** — somente diagnóstico e plano em [`ERP-03-POSTGRES-GATE-PLAN.md`](ERP-03-POSTGRES-GATE-PLAN.md). Isto **não** autoriza implementação nem altera o estado histórico do ERP-03; qualquer implementação depende de comando futuro explícito.

- **PR #54:** merged; é a base `b907796f…` e contém a correção histórica do P0-01.
- **PR #55:** aberto na branch indicada acima. A atualização ERP-02.1 reaproveita o PR já aberto desta branch; não foi criado PR paralelo e não houve merge.
- **CI da correção `20e14c8`:** push run [38285230730](https://github.com/petrickmsilva-alt/brobond-erp/actions/runs/38285230730) e PR run [38285235716](https://github.com/petrickmsilva-alt/brobond-erp/actions/runs/38285235716) — ambos `verificar` e `testes-postgres` **success**. Naquela execução a imagem do workflow ainda era `postgres:16`; a configuração subsequente fixa `16.14` e faz asserção de versão para as evidências finais.
- Os checks que cobrem a versão fixada são a validação final exigida no PR #55; não se usa estado de CI anterior como substituto desses checks.

## 1. P0-01 histórico — separado desta rodada

P0-01 foi a falha histórica de estorno causada pelo uso de `INSERT ... ON CONFLICT DO UPDATE` com delta negativo contra a constraint de saldo não negativo: o PostgreSQL avaliava o tuple proposto antes de resolver o conflito e retornava SQLSTATE `23514`. A correção com atualização condicional/`tryAdjustStock` e tradução do erro de negócio já está na base do PR #54 (`b907796f…`).

ERP-02.1 **não** reapresenta P0-01 como defeito novo nem reivindica tê-lo corrigido. Os testes atuais preservam a prova de saldo condicional, concorrência e ausência de saldos negativos; a reprodução original pertence ao registro histórico do ciclo que a fechou.

## 2. G1–G5 — proteções ERP-02 mantidas

| Gate | Invariante protegida | Evidência/regressão mantida |
|---|---|---|
| **G1** | A falha ao persistir o evento de conclusão aborta a conclusão inteira. | Trigger PostgreSQL injeta erro; snapshot confirma rollback de OP, saldos, movimentos, eventos e auditoria. |
| **G2** | A falha ao persistir o evento de reabertura aborta o estorno inteiro. | Trigger PostgreSQL injeta erro; snapshot confirma que OP, custo, perdas, apontamentos, saldos, movimentos, eventos e auditoria não mudam parcialmente. |
| **G3** | Apontamentos e eventos não são truncados no histórico nem no endpoint. | 1001 apontamentos; zero ativos depois do estorno; evento de reabertura retém os 1001 resumos; endpoints retornam o conjunto completo acima de 500 linhas. |
| **G4** | O livro de consumo de insumos atravessa o limite antigo de 5000 linhas. | Reforçado pelo teste ERP-02.1/GAP-E02-02 abaixo: 5000 linhas históricas mais lançamentos operacionais, leitura e conciliação do conjunto inteiro. |
| **G5** | O estorno processa todo o histórico de produto acima de 1000 entradas. | 1001 entradas vinculadas à OP, quantidade total 1010; 1001 saídas compensatórias; todas as entradas marcadas como estornadas; saldo final de produto zero e custo/perdas preservados no evento. |

Além desses gates, seguem cobertos: retry/idempotência, concorrência com resultados `[200, 409]`, rollback de falha em uma linha de OP por grade, isolamento A/B por empresa e ausência de saldo negativo. O bloco G5 continua imediatamente depois de B3 e antes de B4/seção C, conforme a organização solicitada.

## 3. GAP-E02-02 — auditoria do caminho transacional acima de 5000 movimentos

### Reprodução, investigação e prova de completude

O fluxo auditado foi `estornarOrdem → consumoLiquidoDaOrdem → movimentações/estoque/insumos/custos → apontamentos/eventos`. Antes de alterar qualquer leitura, verificou-se o helper já existente `listarTodos`: ele solicita páginas até alcançar o `total` retornado pelo store e lança erro explícito se receber uma página vazia antes de completar o conjunto. `PgStore` e `MemStore` têm ordenação determinística por `id` como padrão.

- `consumoLiquidoDaOrdem` lê todas as movimentações de insumo filtradas por `empresa_id` e `ordem_id`, agrega saídas menos entradas (quantidade e valor) e valida cada insumo uma única vez no escopo da empresa.
- `estornarOrdem` lê todas as movimentações de produto da OP, ordenadas por `id` decrescente; percorre apenas entradas ainda não estornadas e grava a saída compensatória dentro da transação existente.
- `apontamentosDaOrdem`, os itens de grade consumidos pela operação e as rotas de eventos/apontamentos usam `listarTodos`; eventos mantêm ordem estável por `id`.
- Ajustes de estoque não dependem de varrer páginas: usam a escrita transacional/condicional já existente. As validações de produto e insumo são buscas por chave com filtro de empresa.
- As duas leituras descobertas como não completas eram adjacentes ao caminho de custo: o recálculo da ficha técnica usava apenas uma página de **500** itens e `GET /fichas/:id/insumos` apenas uma página de **200**. Elas não chamavam `listarTodos` e, portanto, ainda podiam truncar custo/listagem mesmo com o ledger de estorno completo.

A reprodução pré-correção usou o código de `ea27998c53e709791a99d7ed05bcd09958f06147` (teste novo já presente, implementação ainda com as leituras de página única) em PostgreSQL real 16.14: uma ficha com **502 linhas** retornou **200** pelo endpoint e gravou custo **519.00**, quando o esperado para todas as linhas era **521.00**. Com a correção, o mesmo teste retorna **502** e calcula **521.00**.

### Correção mínima aplicada

`server/src/producao.ts` agora chama o `listarTodos` existente em `recalcularFichaValores` e `listInsumosFicha`, preservando os filtros `empresa_id`/`ficha_id`, ordenação determinística por `id ASC` e o `tx` já recebido pelo recálculo. Não foi criado mecanismo novo, não se alterou fórmula de custo e não houve migration. O custo continua sendo calculado para cada linha da ficha e validado no escopo da empresa.

### Prova adversarial do GAP-E02-02 em PostgreSQL

`server/test/pg/e02-reabertura-estorno-postgresql.test.ts` executa em PostgreSQL real:

1. Cria **5000** movimentos históricos balanceados (2500 saídas + 2500 entradas), valida saldo físico inicial **10000** e registra uma saída operacional posterior às primeiras 5000 linhas.
2. Conclui a OP com **2 peças boas + 1 perdida**; consome 6 m a R$10; custo real **120** (R$60 insumos + R$30 mão de obra + R$30 indiretos).
3. Disputa duas reaberturas simultâneas: uma confirma (`200`), a outra recebe conflito (`409`); produto e insumo são compensados uma única vez, sem duplicar auditoria/evento.
4. Reabre/libera, conclui de novo com a mesma perda e faz o segundo estorno. No final: estoque de produto **0**, estoque do insumo **10000**, OP planejada com custo ativo **0**, nenhum saldo negativo ou residual.
5. Compara o livro inteiro: **5004** movimentos de insumo (5000 históricos + quatro operacionais), **2502 saídas e 2502 entradas**, quantidades/valores conciliados em **2512 / R$25120** por tipo; as 5000 linhas históricas permanecem intactas. Há exatamente duas conclusões e dois eventos de reabertura, com perda, custo revertido e apontamento registrados; dois estornos geram exatamente duas auditorias.
6. O teste adicional da ficha cria **502 linhas**, verifica a resposta HTTP completa e o custo calculado incluindo todas as linhas.

O conjunto também prova que as duas conclusões reconsomem o material líquido já estornado: não há consumo duplicado, custo fantasma, evento duplicado nem saldo residual depois do segundo estorno.

## 4. Evidência e gates executados

| Gate | Resultado observado |
|---|---|
| PostgreSQL oficial da rodada | **16.14 real** (`SHOW server_version`); CI fixado em `postgres:16.14` com asserção explícita da versão. |
| PG focado ERP-02/02.1 | **17/17** entre `e02-ordem-reabrir-postgresql.test.ts` e `e02-reabertura-estorno-postgresql.test.ts`. |
| `npm run test:pg` completo | Em banco isolado novo `brobond_erp021_final`: **151 testes, 150 pass, 0 fail, 0 skipped, 1 todo**; duração aproximada **17m39s**. O TODO é P1-11, não relacionado a Produção e já declarado como decisão multiempresa de webhook. |
| Teste da ficha técnica | Pré-correção: 200/502 linhas, custo 519/521. Pós-correção: 502/502 linhas e custo 521.00. |
| G3 / G5 | 1001 apontamentos e 1001 entradas de produto processados; compensações completas e saldo final zero. |
| GAP-E02-02 | 5000 movimentos históricos + 4 operacionais reconciliados depois do segundo ciclo; nenhum movimento eliminado ou duplicado. |
| `npm test` | Servidor: **760** (695 pass, 0 fail, 65 skipped); cliente: **290/290**. |
| `npm run typecheck` | Passou (domain, API e client). |
| `npm run lint` | Exit 0; 0 erros / 415 warnings existentes. |
| `npm run build` | Passou. |
| `npm run smoke` | **126/126** em modo demonstração. |
| `DATABASE_URL=… npm run smoke:pg` | **126/126** em banco PostgreSQL novo; API real, migrations/boot e limpeza automática. |
| `npm run audit:menu` | 0 erros / 4 avisos classificados; nenhum arquivo de menu/UI alterado. |
| CI do commit de correção | Push [38285230730](https://github.com/petrickmsilva-alt/brobond-erp/actions/runs/38285230730) e PR [38285235716](https://github.com/petrickmsilva-alt/brobond-erp/actions/runs/38285235716): `verificar` e `testes-postgres` ambos **success**. |
| CI final com PostgreSQL 16.14 fixado (head `da619c7`) | Push [38288430233](https://github.com/petrickmsilva-alt/brobond-erp/actions/runs/38288430233) e PR [38288437317](https://github.com/petrickmsilva-alt/brobond-erp/actions/runs/38288437317): `verificar` e `testes-postgres` ambos **success**; versão numérica `160014`, suíte PG, Prisma baseline/deploy e `smoke:pg` passaram. |
| `npm run db:validate` local | Bloqueado ao baixar `schema-engine` por desconexão TLS com `binaries.prisma.sh`; a validação Prisma equivalente passou em CI. Nenhum schema mudou. |
| `git diff --check` | Passou. |

A primeira versão da asserção de versão no head `abdb266` falhou antes de migrations/testes; os logs detalhados terminaram em EOF. A verificação foi ajustada para `SHOW server_version_num = 160014`; o head final `da619c7` confirmou a versão e passou nos dois jobs. A falha inicial era do step de verificação, não evidência de falha funcional do ERP.

`db:generate` e `db:deploy` não foram necessários: sem alteração de schema ou migration. As contagens acima não transformam o TODO P1-11 nem os warnings existentes em falhas do ERP-02.1.

## 5. Resultado, limitações e fronteiras

### Fechado nesta rodada

- Leituras da ficha técnica usadas para listagem e custo deixam de parar em 200/500 linhas.
- GAP-E02-02 é exercitado acima de 5000 linhas no fluxo completo de conclusão/estorno/reabertura/reconclusão/novo estorno.
- O caminho crítico preserva consumo líquido, compensações append-only, custos, perdas, eventos, isolamento por empresa, rollback, concorrência/idempotência e saldos sem truncagem ou duplicação.
- A versão de PostgreSQL da evidência final é fixada em 16.14 e checada no CI.

### Limitações declaradas

- A tentativa local de `db:validate` não conseguiu baixar o Prisma `schema-engine` por restrição de rede; o step correspondente de CI passou. Nenhum schema foi alterado.
- A bateria completa conserva **um TODO P1-11** de webhook multiempresa, fora deste fluxo; não foi silenciosamente contado como aprovação.
- Lint reporta 415 warnings não bloqueantes e o runner GitHub reporta avisos de depreciação de Node/`ubuntu-latest`; nenhum deles alterou o resultado dos jobs.
- A evidência é limitada aos cenários de Produção descritos; não certifica todos os módulos ou todo o ERP.
- PR #55 continua aberto, sem merge automático; revisão e merge dependem de decisão humana.

---

**ERP-02.1 FINAL GATE: APPROVED**
**ERP-03 READINESS: READY TO START** — somente o plano foi preparado; aguardar comando explícito antes de qualquer implementação.
