# Relatório E4.2 — Isolamento multiempresa dos fluxos de estoque

**Repositório:** `petrickmsilva-alt/brobond-erp`
**Branch:** `arena/4cb6e53b-brobond-erp`
**Data:** 2026-10-09
**Escopo:** E4.2; não abrange E4.3–E4.6.

## Resultado

Os fluxos especializados de estoque revisados usam o escopo canônico do ator e referências tenant-scoped. Um ID de outra empresa responde 404 sem confirmar o tenant-alvo. Referências compostas incompatíveis também são recusadas no PostgreSQL. Os testes exercitam tentativas A → B → A, verificando leituras, escritas, saldos, contagens e arquivos/exportações.

A integração WooCommerce só opera quando `WOOCOMMERCE_EMPRESA_ID` vincula explicitamente a integração a um tenant. Sem vínculo, os endpoints bloqueiam a operação com 409; para outro tenant, respondem 404.

## Implementação

### Rotas e referências

Handlers especializados usam `escopoDe(currentUser(req))`; leituras e alterações por ID aplicam o filtro de empresa antes de usar os registros. As validações de referências relacionadas cobrem o recurso raiz e os alvos tenant-scoped (produto, local, compra, recebimento, item, OP, insumo e outros conforme o fluxo). Referências compartilhadas, como tamanhos, permanecem globais por definição do domínio.

A cobertura inclui:

- grade de estoque, detalhe de produto e consulta de tamanhos;
- snapshot, detalhe, itens, contagem e fechamento de inventário;
- criação e estorno de movimentações; movimentações manuais de insumos;
- preview, confirmação e modelo de importação de estoque;
- relatórios de posição e movimentações, além de exportações JSON/CSV/XLSX;
- endpoints WooCommerce de status, diagnóstico, importação de pedidos e sincronização de estoque;
- leituras especializadas do PDV tocadas pela alteração de escopo.

A página de detalhe do produto também valida as referências das linhas relacionadas que devolve (estoques, movimentações, OPs e ficha técnica), em vez de validar apenas o produto-raiz.

### Locais e integridade no banco

A migration versionada `db/migrations/0030_e42_locais_estoque_multempresa.sql` e o espelho em `db/schema.sql`:

- substituem a unicidade global de nome por `UNIQUE (empresa_id, nome)` e garantem no máximo um local padrão por empresa;
- incluem `pdv_caixas.local_id` e vínculos compostos que exigem que o ID de local pertença à mesma empresa;
- adicionam FKs compostas para relações de estoque, movimentações, inventário, compras/recebimentos e insumos onde o schema já modela esses vínculos;
- criam unicidade para as células canônicas de saldo com tamanho e sem tamanho, usando o ID de local;
- rodam diagnósticos antes das alterações incompatíveis: nomes/padrões/linhas duplicados, dados obrigatórios ausentes, ownership divergente, local estrangeiro e nome textual inconsistente.

O preflight aborta com diagnóstico quando encontra conflitos que impedem a integridade. Registros históricos com `local_id` ausente são preservados e reportados; caixas PDV legadas não recebem vínculo inferido por nome. Não há backfill heurístico, reatribuição automática ou escolha arbitrária de linha.

### Célula sem tamanho

`tamanho_id = NULL` é uma célula própria, única por empresa/produto/local canônico. Os índices parciais distinguem a chave sem tamanho daquela com tamanho. O PostgreSQL usa `ON CONFLICT` sobre a chave canônica para entradas e uma atualização condicional/atômica para saídas. A matriz PG testa entradas concorrentes convergindo para uma linha e duas saídas concorrentes sobre saldo 5, em que exatamente uma retirada de 4 vence e o saldo termina em 1.

### WooCommerce

O tenant permitido é configurado por `WOOCOMMERCE_EMPRESA_ID`. A checagem ocorre antes de qualquer chamada externa; tenant diferente recebe 404. Sem variável de vínculo, a integração fica bloqueada. O teste não configura credenciais remotas e prova somente a decisão local de autorização/bloqueio.

## Evidência PostgreSQL e migração

O teste obrigatório `server/test/pg/e42-tenant.test.ts` falha explicitamente se `DATABASE_URL` estiver ausente; não transforma falta de PostgreSQL em `skip`.

- A matriz A → B → A cobre produtos, locais homônimos, default local independente, saldo sem tamanho, movimento e estorno, grade/detalhe, inventário e contagem/fechamento, insumos, importação, relatórios/exportações e Woo.
- As tentativas cruzadas verificam 404 e ausência de linhas/saldo/contagem/arquivo estrangeiro; B e A continuam conseguindo ler os próprios registros depois das tentativas.
- FKs compostas são testadas diretamente contra PostgreSQL, com rejeição das combinações empresa A → local/produto B.
- Em banco PostgreSQL vazio, o bootstrap aplicou `db/schema.sql` e as migrações `0001` a `0030`; a matriz passou **1/1**. O teste então removeu `pdv_caixas.local_id`, inseriu uma caixa legada, reexecutou a migration 0030 e confirmou `local_id IS NULL` — não houve backfill por nome.
- O mesmo caso E4.2 passou **1/1** no banco de integração usado pela suíte.

## Gates executados em 2026-10-09

| Gate | Resultado observado |
|---|---|
| `npm test` | Servidor: **638 pass, 0 fail, 63 skipped** (701 testes; 51 suites). Cliente: **226 pass**, 22 arquivos de teste. Exit code 0. |
| `npm run test:pg` | PostgreSQL real: **90 pass, 0 fail, 0 skipped**. Exit code 0. Inclui a matriz E4.2. |
| E4.2 em banco vazio + upgrade | **1 pass, 0 fail, 0 skipped**; migrações `0001`–`0030` aplicadas, migration 0030 reexecutada sem inferência para a caixa legada. |
| `npm run typecheck` | Passou para domain, server e client. |
| `npm run lint` | Exit code 0; **0 erros e 401 avisos** reportados pelo ESLint. |
| `npm run build` | Passou; Vite transformou **2102 módulos** e gerou os artefatos PWA. |
| `npm run smoke` | **126/126 verificações** passaram em servidor Express real no modo demonstração. |
| `npm run audit:menu` | Exit code 0; sem erros. **6 avisos** classificados pelo auditor (3 RBAC/menu, rota health pública e 2 recursos sem menu). |
| `git diff --check` | Passou, sem whitespace errors. |

Os skips da suíte unitária são os skips existentes do conjunto server; os testes PG foram executados separadamente com `DATABASE_URL` e não foram pulados.

## Limites preservados

Este resultado fecha somente o isolamento/ownership E4.2. Permanecem fora desta entrega: entidade formal de transferência de estoque, reservas, lotes/validade/séries, nova política de custo/CMV, novas regras de devolução, mínimo/máximo avançado e demais itens E4.3–E4.6. O preflight pode bloquear uma instalação legada até que um administrador resolva explicitamente dados duplicados ou inconsistentes; nenhum dado ambíguo é corrigido automaticamente.
