# Relatório E4.2 — Gate de aceite e evidência de release

**Repositório:** `petrickmsilva-alt/brobond-erp`
**Branch:** `arena/4cb6e53b-brobond-erp`
**Data:** 2026-10-09
**Escopo:** exclusivamente o gate E4.2; sem ampliar para E4.3–E4.6.

## Veredito

**NÃO APROVADO.** O CI executou o gate contra PostgreSQL real, mas o primeiro run terminou com **90 pass, 1 fail, 0 skipped (91 testes)**. A falha ocorreu numa asserção do harness HTTP para o diagnóstico local WooCommerce: a rota respondeu HTTP 200, mas a comparação sensível a maiúsculas não encontrou o SKU A. A investigação do código mostrou que a rota normaliza o SKU para maiúsculas; o harness foi corrigido para comparar a forma normalizada, mantendo intactas as exigências de incluir A e excluir B. O resultado da reexecução ainda está pendente; até ela terminar, não há aprovação.

Não foi alterado código de produção, workflow ou imagem de CI para tratar essa falha. A saída do corpo HTTP do primeiro run não ficou disponível nas anotações consultáveis; portanto, não se afirma que o endpoint tenha omitido o produto nem que tenha ocorrido vazamento entre empresas. O rerun é necessário para comprovar a asserção corrigida e executar os cenários que vinham depois dela.

## Escopo e harness

`server/test/pg/e42-http.test.ts` inicia `server/src/index.ts` como processo filho e percorre HTTP real, autenticação/login, JWT, middleware, rotas Express, serviços e PostgreSQL. Exige `GET /api/health` com `db=postgres`, persiste o usuário e as concessões no banco, e troca a empresa ativa pelas rotas da aplicação. Não injeta `req.user`, não chama handlers diretamente e não aceita MemStore como prova. Os cenários de rejeição comparam snapshots PostgreSQL antes/depois, incluindo dados de tenant, registros relacionados e auditoria.

`server/test/pg/e42-tenant.test.ts` é a cobertura PostgreSQL complementar pelo runner/migration existentes; injeta ator/request e chama handlers/serviços, portanto não substitui a matriz HTTP. No run reportado passou, incluindo a reaplicação controlada da migration 0030 e a preservação de `local_id=NULL` em caixa legada.

Nenhuma migration de produção foi criada neste gate. A migration E4.2 é `0030_e42_locais_estoque_multempresa.sql`, já existente no workspace. A regressão de devolução total, `GAP-ESTQ-VENDA-ID` e o ciclo de vida P2 de `pdv_caixas.local/local_id` continuam separados, sem correção neste PR.

## EXECUÇÃO DEFINITIVA — POSTGRESQL REAL

### Run observado (primeira tentativa; não aprovado)

| Campo | Resultado observado |
|---|---|
| CI | [Run 38003682898](https://github.com/petrickmsilva-alt/brobond-erp/actions/runs/38003682898) |
| Commit executado | `188961fac8c553bffe94ed725618aa5057f33242` |
| Jobs | `verificar`: sucesso; `testes-postgres`: falha no step `Migrations + concorrência de saldo no Postgres` |
| PostgreSQL | Serviço do workflow `postgres:16`, banco de job `brobond_teste`; sem expor string de conexão ou credenciais. A suíte consultou `server_version`, mas o valor minor retornado não ficou disponível na API/anotação consultada; o relatório não o inventa. |
| TAP no job PostgreSQL | **91 testes; 90 pass; 1 fail; 0 skipped; 0 cancelled; 0 todo** |
| Duração TAP / job | `463965.612748 ms` / aproximadamente `8m 8s` |
| Resultado do run | Falha de teste após executar PostgreSQL; **não** foi falha de infraestrutura nem teste não executado. |

A base PostgreSQL descartável do serviço foi inicializada pelo workflow e a suíte real chegou a executar `migrate()`, health check HTTP com `db=postgres`, verificação da migration `0030`, tabelas, FKs e índices E4.2. O teste complementar de upgrade também passou: removeu `local_id` para simular o estado legado, inseriu uma caixa legada sem vínculo, removeu o registro da migration 0030, executou novamente `migrate()` e verificou que a migration foi registrada e o `local_id` legado permaneceu `NULL`, sem backfill por nome. **Limite:** o runner aplica `db/schema.sql` antes das migrations versionadas; esse teste não prova a migration 0030 isolada sobre uma instalação pré-0030 intacta nem substitui um upgrade de cópia de produção.

### Falha e correção do harness

A única falha foi o teste TAP `E4.2 aceite real: HTTP + autenticação + middleware + Express + serviços + PostgreSQL`, em `server/test/pg/e42-http.test.ts:704`:

```text
GET /marketplace/loja/produtos -> HTTP 200
assert.ok(JSON.stringify(wooProductsA.body).includes(String(produtoA.sku)))
AssertionError: expected true, actual false
```

A anotação do GitHub não contém o corpo da resposta, então não permite concluir se o item estava ausente. Na implementação consultada em `server/src/loja.ts`, `produtosLoja()` transforma o SKU retornado com `.trim().toUpperCase()`. O SKU de teste inclui sufixo derivado de UUID e pode conter letras minúsculas; logo, a comparação literal do harness não correspondia à representação contratual da rota. A alteração restrita ao harness compara `produtoA.sku.toUpperCase()` e mantém também a negação explícita de `produtoB.sku.toUpperCase()`. Ela **não** remove a asserção de isolamento nem muda endpoint/produção.

Todos os asserts que precedem a linha da falha foram alcançados sem falhar, incluindo bootstrap/health, autenticação e seletor A→B→A, criação/ownership, saldo com `tamanho_id NULL` e preenchido, importação, inventário e seus saldos, relatórios JSON, CSV/XLSX e rejeições cross-tenant com **19 snapshots PostgreSQL antes==depois**. O endpoint de produtos Woo respondeu 200 antes da comparação. Por a falha ocorrer ali, não foram executadas no teste HTTP os asserts seguintes para exclusão do SKU B no diagnóstico Woo, bloqueios 409/404 das operações Woo, `/connectors` A e verificações finais que vêm depois. A falha não prova aprovação nem defeito de produção.

A correção do harness passou no typecheck strict isolado e em `git diff --check`. **A reexecução da CI com a comparação normalizada ainda não foi observada nesta versão deste relatório.** O veredito permanece **NÃO APROVADO** até o rerun terminar sem falhas/skips indevidos e todos os critérios exigidos terem evidência.

## EVIDÊNCIA DE ACEITE HTTP + POSTGRESQL

A tabela separa os trechos efetivamente percorridos no primeiro run daqueles que ficaram depois da falha. “Passou até a falha” não significa aprovação do gate completo.

| Cenário | Rotas / mecanismo | Evidência observada no run 38003682898 |
|---|---|---|
| Bootstrap e integridade E4.2 | `migrate()`, `/api/health`, `schema_migrations`, tabelas, FKs e índices | Passou: health confirmou `db=postgres`; migration 0030 registrada; asserções estruturais passaram. Serviço PostgreSQL 16 real no workflow. |
| Upgrade legado | Runner `migrate()` existente; caixa antiga com `local_id=NULL` | Passou no teste PG complementar: 0030 reaplicada/registrada e `local_id` ficou NULL. Limite de `schema.sql` antes das migrations descrito acima. |
| Login, middleware e seletor A→B→A | `/api/auth/login`, `/api/empresas/ativa`, `/api/locais` | Passou até a falha: rota protegida sem sessão, login real e tokens/empresa ativa foram exercitados. |
| Spoof de empresa, locais e defaults | POST/PUT produtos e locais; `/api/meta` | Passou até a falha: `empresa_id` veio do ator; locais homônimos/defaults foram criados em A/B; rename HTTP de A e preservação de B passaram. O rename HTTP posterior de B não foi alcançado. |
| Estoque e inventário | `/api/movimentacoes`, `/api/inventarios`, itens/fechamento | Passou até a falha: células com e sem tamanho, saldos, importação em A e fechamento do inventário A foram verificados em PostgreSQL; saldo B não foi alterado pelos asserts executados. |
| Referências cross-tenant e zero-write | Produtos, locais, inventários, PDV, movimentos e importação | Passou até a falha: leituras/mutações/referências estrangeiras anteriores foram rejeitadas e **19** snapshots antes/depois permaneceram idênticos, incluindo auditoria. |
| Relatórios e exportações | Relatórios JSON, `/estoques/export?format=csv|xlsx`, grade | Passou até a falha em A e B: verificações de SKU/tenant e conteúdo CSV/XLSX foram executadas antes do erro Woo. |
| WooCommerce e conectores | `/marketplace/loja/{status,produtos,pedidos,estoque}`, `/connectors` | Parcial: status A `200` e `configurado=false`; diagnóstico local A `200`; a asserção sensível a caixa do SKU A falhou. Verificações seguintes não executadas no teste HTTP. Sem credenciais Woo ou chamada externa. |

### Estado dos gates

| Gate | Resultado observado |
|---|---|
| CI `verificar` no run 38003682898 | Sucesso: typecheck API/front, testes de regras de negócio, validação do schema Prisma, lint e build do front concluíram. Anotações de lint existentes não falharam o job. |
| CI `testes-postgres` no run 38003682898 | PostgreSQL real iniciou e executou a suíte: 90/91 passaram, 1 falhou, 0 skipped. As etapas posteriores de instalação/baseline/deploy Prisma foram skipped após o step de testes falhar. |
| Typecheck strict isolado E4.2 após a correção do harness | Exit 0 para `e42-http.test.ts` e `e42-tenant.test.ts`. Compilação apenas; não substitui rerun PostgreSQL. |
| `git diff --check` após a correção do harness | Exit 0. |
| Testes locais sem `DATABASE_URL` (histórico desta sessão) | `npm test`: servidor 638 pass/0 fail/63 skipped; cliente 226/226. `npm run test:pg`: 0 pass, 2 falhas de pré-condição, 63 skipped; não foi prova PostgreSQL. O run remoto acima é a execução real. |
| Outros gates locais (histórico desta sessão) | Typecheck geral exit 0; lint 0 erros/401 avisos; build 2.102 módulos; smoke 126/126 em MemStore; `audit:menu` exit 0; `npm audit` exit 1 com 22 vulnerabilidades; cada resultado mantém seu escopo e não substitui E4.2. |

## LIMITAÇÕES E ESCOPO

- A resposta/corpo exatos da rota Woo no primeiro run não estão disponíveis nas anotações consultáveis. Não se registra ausência do produto, vazamento ou bug de produção sem essa evidência; a correção foi somente alinhar a comparação do harness à normalização uppercase implementada.
- A nova comparação precisa ser executada no CI PostgreSQL real. O teste parou antes dos asserts Woo restantes e verificações finais da matriz HTTP.
- A versão exata `server_version` consultada pelo teste não foi recuperada pela API consultada. Registra-se somente a tag principal `postgres:16` do serviço, sem inferir patch/minor.
- Não houve credenciais WooCommerce nem homologação externa; são exercitados apenas status/leitura local e bloqueios locais sem conexão externa.
- O primeiro run não foi falha de infraestrutura: os containers iniciaram, o PostgreSQL foi utilizado, os testes executaram e o TAP reportou a falha de asserção. Uma falha futura antes dos testes deverá ser classificada como **INFRAESTRUTURA — TESTE NÃO EXECUTADO**, nunca como pass ou falha funcional.
- A regressão P1 de devolução total permanece aberta e fora deste gate; `GAP-ESTQ-VENDA-ID` continua crítico e separado; `pdv_caixas.local/local_id` continua P2 separado. Nenhum deles foi corrigido ou reclassificado por esta execução.
- `npm audit` reportou 22 vulnerabilidades no gate local; não foram feitas atualizações amplas de dependências neste PR.

## Decisão

Manter `GAP-ESTQ-MULTIEMPRESA` e o gate E4.2 **abertos**. Registrar a execução inicial como falha do harness, sem apagá-la do histórico; aguardar CI PostgreSQL real após a correção de comparação. Não aprovar até a reexecução passar, sem skips/falhas relevantes, cobrir também os asserts Woo posteriores e comprovar todos os critérios de aceite. **Não fazer merge/fechar o PR #46 e não iniciar E4.3.**