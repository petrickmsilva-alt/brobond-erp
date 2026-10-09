# Relatório E4.2 — Gate de aceite e evidência de release

**Repositório:** `petrickmsilva-alt/brobond-erp`
**Branch:** `arena/4cb6e53b-brobond-erp`
**Data:** 2026-10-09
**Escopo:** exclusivamente o gate E4.2; sem ampliar para E4.3–E4.6.

## Veredito

**NÃO APROVADO.** O CI executou a matriz contra PostgreSQL real em duas tentativas; ambas terminaram com **90 pass, 1 fail, 0 skipped (91 testes)**. A comparação de SKU do primeiro harness foi corrigida e passou na segunda tentativa. A falha mais recente é outra expectativa incorreta do harness: ele esperava HTTP 200 ao renomear, como gerente, um local B já usado por saldo/movimentação/inventário; a aplicação retornou 403, conforme a regra de produção que reserva rename de local em uso a administrador.

A correção atual, ainda aguardando CI, move o rename HTTP de B para antes de qualquer uso desse local, mantendo o ator gerente, o `empresa_id` falsificado, as asserções de tenant/default e a prova de que o rename de A não altera B. Não se alterou código de produção, workflow nem imagem de CI. O veredito permanece **NÃO APROVADO** até o rerun real passar sem falhas/skips indevidos e todos os critérios de aceite serem comprovados.

## Escopo e harness

`server/test/pg/e42-http.test.ts` inicia `server/src/index.ts` como processo filho e percorre HTTP real, autenticação/login, JWT, middleware, rotas Express, serviços e PostgreSQL. Exige `GET /api/health` com `db=postgres`, persiste o usuário e concessões no banco, e troca a empresa ativa pelas rotas da aplicação. Não injeta `req.user`, não chama handlers diretamente e não aceita MemStore como prova. Os cenários de rejeição comparam snapshots PostgreSQL antes/depois, incluindo dados de tenant, registros relacionados e auditoria.

`server/test/pg/e42-tenant.test.ts` é a cobertura PostgreSQL complementar pelo runner/migration existentes; injeta ator/request e chama handlers/serviços, portanto não substitui a matriz HTTP. Nos dois runs reportados passou, incluindo a reaplicação controlada da migration 0030 e a preservação de `local_id=NULL` em caixa legada.

Nenhuma migration de produção foi criada neste gate. A migration E4.2 é `0030_e42_locais_estoque_multempresa.sql`, já existente no workspace. A regressão de devolução total, `GAP-ESTQ-VENDA-ID` e o ciclo de vida P2 de `pdv_caixas.local/local_id` continuam separados, sem correção neste PR.

## EXECUÇÃO DEFINITIVA — POSTGRESQL REAL

### Runs observados

| Run | Commit | Serviço PostgreSQL | Resultado TAP do job PostgreSQL | Duração TAP / job | Conclusão |
|---|---|---|---|---|---|
| [38003682898](https://github.com/petrickmsilva-alt/brobond-erp/actions/runs/38003682898) | `188961fac8c553bffe94ed725618aa5057f33242` | `postgres:16`, banco efêmero do job `brobond_teste` | **91 testes; 90 pass; 1 fail; 0 skipped; 0 cancelled; 0 todo** | `463965.612748 ms` / ~8m08s | Falhou na comparação sensível a maiúsculas do SKU A em `/marketplace/loja/produtos`. |
| [38004716773](https://github.com/petrickmsilva-alt/brobond-erp/actions/runs/38004716773) | `cd819d8120f1ffeeebcb44ceb38af95664d6feb5` | `postgres:16`, banco efêmero do job `brobond_teste` | **91 testes; 90 pass; 1 fail; 0 skipped; 0 cancelled; 0 todo** | `471523.460259 ms` / ~8m22s | A comparação de SKU passou; falhou depois ao esperar 200 para rename de local B em uso. |

O job `verificar` passou nos dois runs. O job PostgreSQL inicializou os containers e executou a suíte real; portanto, as falhas acima **não** são de infraestrutura nem casos não executados. O valor exato minor de `server_version` foi consultado pelo harness, mas não está disponível nas anotações/API retornadas ao agente; registra-se somente a tag principal `postgres:16`, sem inventar versão minor. Nenhuma string de conexão ou credencial é registrada aqui.

Em ambos os runs, o harness executou `migrate()`, confirmou health check HTTP com `db=postgres`, a migration `0030`, tabelas, FKs e índices E4.2. O teste complementar de upgrade também passou: removeu `local_id` para simular estado legado, inseriu uma caixa sem vínculo, removeu o registro da migration 0030, executou novamente `migrate()` e verificou que a migration foi registrada e que o `local_id` legado permaneceu `NULL`, sem backfill por nome. **Limite:** o runner aplica `db/schema.sql` antes das migrations versionadas; isso não prova a migration 0030 isolada sobre uma instalação pré-0030 intacta nem substitui upgrade de cópia de produção.

### Falhas, causa e ajuste restrito ao harness

**Run 38003682898 — comparação de SKU.** O teste `E4.2 aceite real: HTTP + autenticação + middleware + Express + serviços + PostgreSQL` recebeu HTTP 200 em `GET /marketplace/loja/produtos`, mas falhou na asserção literal de que a resposta continha `String(produtoA.sku)`. O corpo exato não foi preservado na anotação consultável; não se conclui que o produto estivesse ausente nem que houvesse vazamento. O código de `server/src/loja.ts` serializa `sku` após `.trim().toUpperCase()`, enquanto o SKU da fixture pode conter caracteres minúsculos no sufixo UUID. O harness foi alinhado comparando `produtoA.sku.toUpperCase()` e continuando a exigir que `produtoB.sku.toUpperCase()` não apareça.

**Run 38004716773 — rename B.** Após a normalização de SKU, todas as asserções HTTP anteriores, inclusive a leitura local Woo A/B e os bloqueios de integração, passaram. A falha seguinte ocorreu em `server/test/pg/e42-http.test.ts:741`: o harness esperou HTTP 200 no rename do local B, mas observou **403**. A resposta explicava que o local tinha 1 saldo, 1 movimentação e 1 inventário e que renomeá-lo era decisão de administrador. O ator autenticado desse cenário é gerente. `server/src/services.ts` confirma a regra: `validarRenomeLocal` rejeita com 403 (`uso.emUso && actor.perfil !== 'admin'`). Isso é comportamento esperado da aplicação, não defeito de escopo/tenant.

O ajuste atual move o rename de B para logo após a criação/validação dos locais homônimos e antes de criar saldo, movimento ou inventário em B. Assim, o gerente exercita o rename permitido de um local ainda sem uso. As verificações continuam exigindo que A permaneça inalterada, que `empresa_id` venha do ator, que o default de B mantenha seu ID e que o nome/default de cada tenant persistam durante os fluxos posteriores. **A versão com esse ajuste ainda não foi executada no CI PostgreSQL.**

Os dois runs executaram todos os testes sem skips; o teste de upgrade/complementar terminou `ok`. No segundo run, a falha ocorreu no fim do teste HTTP, depois das verificações de SKU Woo, dos endpoints/ações Woo, conectores, snapshots zero-write e estado final de caixas/movimentos; os asserts finais posteriores à tentativa de rename B não foram alcançados. Cada tentativa permanece no histórico deste relatório, sem apagar falhas anteriores.

## EVIDÊNCIA DE ACEITE HTTP + POSTGRESQL

A tabela descreve o último run efetivamente observado (`38004716773`). **“Passou até a falha” não aprova a matriz completa.**

| Cenário | Rotas / mecanismo | Evidência observada no run 38004716773 |
|---|---|---|
| Bootstrap e integridade E4.2 | `migrate()`, `/api/health`, `schema_migrations`, tabelas, FKs e índices | Passou: health confirmou `db=postgres`; migration 0030 registrada; asserções estruturais passaram. PostgreSQL real via serviço `postgres:16`. |
| Upgrade legado | Runner `migrate()` existente; caixa antiga com `local_id=NULL` | Passou no teste PG complementar: 0030 reaplicada/registrada e `local_id` ficou NULL. Limite de `schema.sql` antes das migrations descrito acima. |
| Login, middleware e seletor A→B→A | `/api/auth/login`, `/api/empresas/ativa`, `/api/locais` | Passou: rota protegida sem sessão, login persistido e tokens/empresa ativa foram exercitados. |
| Spoof de empresa, locais e defaults | POST/PUT produtos e locais; `/api/meta` | Passou até a falha: `empresa_id` veio do ator; locais homônimos/defaults e rename de A foram exercitados; rename de A preservou B. O rename B posterior de local já em uso foi rejeitado corretamente com 403 pelo perfil gerente, mas o harness esperava 200. |
| Estoque e inventário | `/api/movimentacoes`, `/api/inventarios`, itens/fechamento | Passou até a falha: células com e sem tamanho, saldos, importação em A, fechamento do inventário A e estado B foram verificados em PostgreSQL. |
| Referências cross-tenant e zero-write | Produtos, locais, inventários, PDV, movimentos e importação | Passou: rejeições anteriores e posteriores entre A/B foram exercitadas; **19 snapshots PostgreSQL antes==depois** incluíram registros/auditoria. |
| Relatórios e exportações | Relatórios JSON, `/estoques/export?format=csv|xlsx`, grade | Passou em A e B: verificações de escopo/conteúdo JSON/CSV/XLSX executadas. |
| WooCommerce e conectores | `/marketplace/loja/{status,produtos,pedidos,estoque}`, `/connectors` | Passou no run 38004716773: A teve status `200/configurado=false`; diagnóstico HTTP 200 incluiu SKU A e excluiu SKU B; mutações A responderam 409 sem credenciais; B recebeu 404 para status/leitura/mutações vinculadas a A; `/connectors` A respondeu 200. Sem chamada/credencial externa. |

### Estado dos gates

| Gate | Resultado observado |
|---|---|
| CI `verificar` nos runs 38003682898 e 38004716773 | Sucesso: typecheck API/front, testes de regras, validação do schema Prisma, lint e build do front concluíram. Anotações existentes de lint não falharam o job. |
| CI `testes-postgres` nos runs 38003682898 e 38004716773 | PostgreSQL real iniciou e executou a suíte: 90/91 passaram, 1 falhou, 0 skipped em cada run. Etapas Prisma seguintes (instalação/baseline/deploy) foram skipped após o step de testes falhar. |
| Typecheck strict isolado do harness atual | Exit 0 para `e42-http.test.ts` e `e42-tenant.test.ts`. Compilação apenas; não substitui rerun PostgreSQL. |
| `git diff --check` no harness atual | Exit 0. |
| Testes locais sem `DATABASE_URL` (histórico desta sessão) | `npm test`: servidor 638 pass/0 fail/63 skipped; cliente 226/226. `npm run test:pg`: 0 pass, 2 falhas de pré-condição, 63 skipped; não foi prova PostgreSQL. |
| Outros gates locais (histórico desta sessão) | Typecheck geral exit 0; lint 0 erros/401 avisos; build 2.102 módulos; smoke 126/126 em MemStore; `audit:menu` exit 0; `npm audit` exit 1 com 22 vulnerabilidades. Esses resultados não substituem E4.2. |

## LIMITAÇÕES E ESCOPO

- A correção atual do caso de rename B ainda não foi validada no CI. O veredito não pode antecipar seu resultado.
- A resposta/corpo do primeiro run e o minor de `server_version` não foram recuperados pelas anotações/API consultadas. Nenhum resultado foi inventado.
- Não houve credenciais WooCommerce nem homologação externa; a matriz cobre status/leitura local e decisões sem conexão externa.
- Os testes locais sem `DATABASE_URL` permanecem registrados como ausência de pré-condição, nunca como pass. Em contrapartida, os dois runs citados executaram PostgreSQL real e falharam em asserções do teste.
- A regressão P1 de devolução total permanece aberta e fora deste gate; `GAP-ESTQ-VENDA-ID` continua crítico e separado; `pdv_caixas.local/local_id` continua P2 separado. Nenhum deles foi corrigido ou reclassificado por esta execução.
- `npm audit` reportou 22 vulnerabilidades no gate local; não foram feitas atualizações amplas de dependências neste PR.

## Decisão

Manter `GAP-ESTQ-MULTIEMPRESA` e o gate E4.2 **abertos**. Registrar as duas falhas observadas, aguardar CI PostgreSQL real para a nova posição do rename B e exigir que a matriz completa passe sem falhas/skips indevidos e com todos os critérios comprovados. **Não fazer merge/fechar o PR #46 e não iniciar E4.3.**
