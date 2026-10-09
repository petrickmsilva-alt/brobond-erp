# Relatório E4.2 — Gate de aceite e evidência de release

**Repositório:** `petrickmsilva-alt/brobond-erp`
**Branch:** `arena/4cb6e53b-brobond-erp`
**Data:** 2026-10-09
**Escopo:** exclusivamente o gate E4.2; sem ampliar para E4.3–E4.6.

## Veredito

**E4.2 APROVADO TECNICAMENTE** no CI PostgreSQL real do run [38005819077](https://github.com/petrickmsilva-alt/brobond-erp/actions/runs/38005819077): `testes-postgres` e `verificar` concluíram com sucesso e a suíte completa não teve falhas. A contagem é **91 pass, 0 fail, 0 skipped**. O footer TAP dessa execução não ficou exposto pela API do Actions; os 91 testes são a mesma suíte (sem mudança de declarações) que totalizou 91 nos dois runs anteriores, e o step final executou com sucesso, com `DATABASE_URL` configurado e sem skips de pré-condição. Essa origem da contagem está explicitada abaixo; não se atribui duração TAP não observada.

As duas falhas anteriores foram preservadas e corrigidas apenas no harness: (1) comparação literal de SKU que ignorava a normalização uppercase da rota; (2) tentativa do perfil gerente de renomear, após uso, um local cujo rename é reservado a administrador. A correção posicionou o rename B permitido antes do uso e preservou a cobertura HTTP de tenant/default. Nos commits que trataram essas falhas, só mudaram harness/documentação; não se alteraram produção, workflow ou imagem de CI. As mudanças de produção originais de E4.2 permanecem restritas a esse escopo.

A aprovação é **somente do gate E4.2**; não aprova release global nem fecha gaps fora de escopo. A regressão P1 de devolução total e `GAP-ESTQ-VENDA-ID` crítico permanecem abertos, e `pdv_caixas.local/local_id` segue P2 separado. O PR #46 permanece aberto, sem merge/fechamento; E4.3 não foi iniciado.

## Escopo e harness

`server/test/pg/e42-http.test.ts` inicia `server/src/index.ts` como processo filho e percorre HTTP real, autenticação/login, JWT, middleware, rotas Express, serviços e PostgreSQL. Exige `GET /api/health` com `db=postgres`, persiste usuário/concessões no banco e troca a empresa ativa pelas rotas da aplicação. Não injeta `req.user`, não chama handlers diretamente e não aceita MemStore como prova. As rejeições cross-tenant comparam snapshots PostgreSQL antes/depois, incluindo registros relacionados e auditoria.

`server/test/pg/e42-tenant.test.ts` é cobertura PostgreSQL complementar pelo runner/migration existentes; injeta ator/request e chama handlers/serviços, portanto não substitui a matriz HTTP. Na execução final passou, incluindo a reaplicação controlada da migration 0030 e a preservação de `local_id=NULL` em caixa legada.

Nenhuma migration de produção foi criada neste gate. A migration E4.2 é `0030_e42_locais_estoque_multempresa.sql`, já existente no workspace. Devolução total, `GAP-ESTQ-VENDA-ID` e ciclo de vida P2 de `pdv_caixas.local/local_id` continuam separados, sem correção neste PR.

## EXECUÇÃO DEFINITIVA — POSTGRESQL REAL

### Histórico dos runs

| Run | Commit | PostgreSQL | Resultado do job `testes-postgres` | Duração observada | Resultado |
|---|---|---|---|---|---|
| [38003682898](https://github.com/petrickmsilva-alt/brobond-erp/actions/runs/38003682898) | `188961fac8c553bffe94ed725618aa5057f33242` | Serviço `postgres:16`; banco efêmero do job `brobond_teste` | **91 testes; 90 pass; 1 fail; 0 skipped; 0 cancelled; 0 todo** | TAP `463965.612748 ms`; job ~8m08s | Falhou na comparação literal de SKU A no diagnóstico Woo. |
| [38004716773](https://github.com/petrickmsilva-alt/brobond-erp/actions/runs/38004716773) | `cd819d8120f1ffeeebcb44ceb38af95664d6feb5` | Serviço `postgres:16`; banco efêmero do job `brobond_teste` | **91 testes; 90 pass; 1 fail; 0 skipped; 0 cancelled; 0 todo** | TAP `471523.460259 ms`; job ~8m22s | SKU normalizado passou; falhou expectativa de HTTP 200 no rename de local B em uso. |
| [38005819077](https://github.com/petrickmsilva-alt/brobond-erp/actions/runs/38005819077) | `19ea1b4c939470557b8d3278567ff5cf184a0e8c` | Serviço `postgres:16`; banco efêmero do job `brobond_teste` | **91 pass; 0 fail; 0 skipped; 0 cancelled; 0 todo** | Job `testes-postgres` 8m37s; step PG ~7m53s | **Sucesso**; `verificar`, suíte PG e etapas Prisma dual-track concluíram. |

**Proveniência da contagem final:** a API/log acessível do Actions confirmou sucesso do step no run 38005819077, mas não retornou o footer TAP nem o valor minor de `server_version`. O total de 91 vem dos footers observados nos dois runs anteriores; entre o segundo e o final não foram adicionados/removidos testes, somente assertions/dados no mesmo teste. O comando final encerrou com exit 0; o job fornece `DATABASE_URL`, e os testes PG condicionais usam essa variável para desabilitar o skip. Assim, 91 pass/0 fail/0 skipped é uma contagem derivada do mesmo conjunto de testes e do sucesso final, não um footer recuperado. A imagem declara PostgreSQL major 16; o minor exato não é inventado. Nenhuma string de conexão ou credencial é registrada.

### Bootstrap e upgrade observados

O workflow iniciou serviço PostgreSQL descartável e a suíte real executou `migrate()`, health check HTTP `db=postgres`, verificação da migration `0030`, tabelas, FKs e índices E4.2. O teste complementar simulou upgrade no banco PostgreSQL real: removeu `local_id`, inseriu uma caixa legada sem vínculo, removeu o registro da migration 0030, executou novamente o `migrate()` de produção e confirmou que a migration foi registrada e o `local_id` legado continuou `NULL`, sem backfill por nome.

**Limite do upgrade:** o runner aplica `db/schema.sql` antes das migrations versionadas; a execução não prova a migration 0030 isolada sobre uma instalação pré-0030 intacta nem substitui upgrade de cópia de produção. O resultado observado é o cenário real do runner existente no banco efêmero do job.

### Falhas anteriores e correções do harness

**Run 38003682898 — SKU.** `GET /marketplace/loja/produtos` respondeu HTTP 200, mas a comparação literal `String(produtoA.sku)` falhou. O corpo não foi preservado na anotação acessível, então a primeira falha não prova ausência do produto nem vazamento. `server/src/loja.ts` serializa o SKU com `.trim().toUpperCase()`; a fixture pode conter letras minúsculas no sufixo UUID. O harness passou a comparar a forma uppercase e a continuar exigindo inclusão de A e exclusão de B. No run 38004716773 essas verificações passaram.

**Run 38004716773 — rename B.** O teste tentou renomear B depois de criar saldo, movimento e inventário, usando o perfil gerente. O endpoint respondeu HTTP 403 (esperado 200 pelo harness) e informou que o local estava em uso por 1 saldo, 1 movimentação e 1 inventário. `server/src/services.ts::validarRenomeLocal` confirma a regra de produção: renomear local em uso exige administrador. Não era bug de escopo. O harness foi reposicionado para renomear B por HTTP logo após criar/validar os locais homônimos, antes de qualquer uso, mantendo gerente, spoof de `empresa_id`, verificação do default e assertiva de que A não muda. O run final passou.

## MATRIZ DOS 20 ITENS DE EVIDÊNCIA DO GATE

Todos os itens abaixo foram percorridos pela suíte final com exit 0. A contagem de testes segue a proveniência acima; o resumo por cenário também aparece no `GITHUB_STEP_SUMMARY` do job.

| # | Evidência | Resultado final |
|---:|---|---|
| 1 | Banco PostgreSQL efêmero do job iniciado e usado pelo runner real | Passou |
| 2 | Health HTTP confirma `db=postgres`; não aceita memória | Passou |
| 3 | Migration 0030 registrada e estrutura de tabelas, FKs e índices E4.2 conferida | Passou |
| 4 | Upgrade pelo runner existente preserva `pdv_caixas.local_id=NULL` legado | Passou, com limite de bootstrap descrito acima |
| 5 | Rota protegida sem token retorna 401 | Passou |
| 6 | Login real de usuário persistido no PostgreSQL emite sessão/JWT | Passou |
| 7 | Seletor A→B→A e empresa ativa confirmados por HTTP | Passou |
| 8 | `empresa_id` falsificado em criação/alteração de produto/local não transfere ownership | Passou |
| 9 | Locais homônimos podem existir em A/B com defaults independentes | Passou |
| 10 | Rename HTTP de B permitido antes do uso não altera local/default A | Passou |
| 11 | Rename HTTP de A preserva nome, default e dados de B | Passou |
| 12 | Caixa PDV A/B persiste ownership e `local_id` do tenant correto | Passou; ciclo de vida P2 segue fora do gate |
| 13 | `tamanho_id IS NULL` e tamanho preenchido permanecem células distintas com saldos conferidos | Passou |
| 14 | Inventários A/B, contagem/fechamento e saldos finais conferidos no PostgreSQL | Passou |
| 15 | Preview/confirmação válida de importação grava estoque/movimento em A | Passou |
| 16 | Importações e referências estrangeiras são rejeitadas sem escrita parcial | Passou |
| 17 | IDs estrangeiros em produto/local/inventário/caixa e mutações cruzadas são rejeitados | Passou |
| 18 | 19 snapshots PostgreSQL antes/depois, inclusive auditoria, permanecem idênticos nas rejeições | Passou |
| 19 | Filtros forjados não ampliam grade/relatórios; JSON, CSV e XLSX ficam isolados por tenant | Passou |
| 20 | Woo A inclui SKU A e exclui B; sem credencial POST A=409; B não acessa Woo de A (404); `/connectors` autenticado=200 | Passou; nenhuma chamada externa/credencial usada |

## Gates CI e locais

| Gate | Resultado observado |
|---|---|
| CI run 38005819077 — `verificar` | Sucesso: typecheck API/front, testes de regras, validação schema Prisma, lint e build do front. Avisos preexistentes não falharam o job. |
| CI run 38005819077 — `testes-postgres` | Sucesso contra PostgreSQL real; 91 pass/0 fail/0 skipped conforme contagem derivada e explicada; etapas posteriores Prisma install/baseline/deploy passaram. |
| Typecheck strict isolado do harness | Exit 0 para `e42-http.test.ts` e `e42-tenant.test.ts`. |
| `git diff --check` | Exit 0. |
| Gates locais anteriores sem `DATABASE_URL` | `npm test`: servidor 638 pass/0 fail/63 skipped; cliente 226/226. `npm run test:pg`: 0 pass, 2 falhas de pré-condição, 63 skipped; não foi prova PG e não substitui os runs remotos. |
| Outros gates locais anteriores | Typecheck geral exit 0; lint 0 erros/401 avisos; build 2.102 módulos; smoke 126/126 em MemStore; `audit:menu` exit 0; `npm audit` exit 1 com 22 vulnerabilidades. Escopo separado. |

## Limitações, gaps e decisão de release

- O footer TAP e o minor exato de `server_version` do run final não ficaram acessíveis pela API/log consultado. O resultado final não inventa esses campos: major PostgreSQL 16 e contagem 91 derivada são explicitados acima.
- Nenhuma credencial WooCommerce ou homologação externa foi usada; foram provados somente caminhos locais/sem credencial.
- E4.2 aprovação técnica não fecha a decisão global de release: permanece P1 a regressão de devolução total (saldo 5 → venda 2 → 3 → devolução 2 → 7, esperado 5), fora deste gate; `GAP-ESTQ-VENDA-ID` permanece crítico e separado; `pdv_caixas.local/local_id` permanece P2 separado. Nenhum foi corrigido/reclassificado.
- `npm audit` local registrou 22 vulnerabilidades; não houve atualização ampla de dependências neste PR.
- PR #46 continua aberto; não houve merge/fechamento. E4.3 não foi iniciado.

**Decisão:** aceitar tecnicamente o gate **E4.2** com base no CI PostgreSQL real e nos 20 itens acima; manter os gaps P1/crítico/P2 e a decisão de release global separados. A conclusão não autoriza merge nem início de E4.3.
