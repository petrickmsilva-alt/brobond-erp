# ERP-03 — PostgreSQL como gate oficial do ERP Core

**Data:** 2026-10-13 · **Status: BLOCKED (não fazer merge)** · Repo `petrickmsilva-alt/brobond-erp` · branch `arena/5e23031a-brobond-erp` · base/HEAD inicial `a33811f15d995fb89d1254079de369ab8b078db3` (merge do PR #55, ERP-02.1). Checkout inicial limpo. Commit de implementação `337c82420282391304af33d262536b6c9b14efa3`; PR [#56](https://github.com/petrickmsilva-alt/brobond-erp/pull/56).

## 1. Objetivo e estado inicial auditado

O CORE é cadastros, compras, estoque, produção, vendas, financeiro, fiscal, logística, multiempresa e auditoria. Commerce/Marketplace e serviços externos não são critérios deste gate. `server/test/*.test.ts` (`npm --workspace server test`) roda sem DB; diversos arquivos removem explicitamente `DATABASE_URL`. `client` usa Vitest/jsdom. `scripts/smoke-e2e.mjs` depende de servidor ativo em demo e só é C/PG quando invocado por `scripts/smoke-pg.mjs`. Não confundir testes F com prova de integridade PG.

No checkout havia **81** arquivos de teste TS do servidor, **35** incluídos no glob `test:pg` (`server/test/pg-*.test.ts` + `server/test/pg/*.test.ts`), **28** arquivos de teste client; `server/test/smoke.mjs` manual está fora dos globs. Inventário com classificação A–G e comando por arquivo: [ERP-03-TEST-INVENTORY.md](ERP-03-TEST-INVENTORY.md). Classificação: A unitário, B integração PG, C HTTP/E2E PG, D concorrência PG, E contrato/API, F memória/mock, G externo (fora do CORE). Mistura B/C/D no mesmo arquivo é normal; não contar todo arquivo PG como concorrência. O baseline medido no servidor 16.14, antes das mudanças: **151 testes / 150 pass / 0 fail / 0 skip / 1 TODO, exit 0; 1.059.174 ms (~17m39s)**. O TODO era executado, falhava, mas `node:test` reportava exit 0. CI já tinha `test:pg` e `smoke:pg` como passos não opcionais, e serviço `postgres:16.14` com healthcheck. Entretanto CI usava o script server sem verificar TODO, e `test:pg` não exigia banco vazio (P2-09).

## 2. Inventário de funcionalidades críticas (amostra de provas, não promessa de 100%)

Nas colunas: **atual** é o teste F/A/E em memória quando existente; **PG** aponta para o arquivo invocado pelo gate (B/C/D); `—` = não comprovado. Todos os PG são `DATABASE_URL` real, sem mock de PgStore. Mock de gateway/provedor externo dentro do PG não equivale a mock do banco. **Crítico** significa que a operação participa do CORE; lacunas parciais permanecem lacunas.

| Área → funcionalidade | Atual (F/A) | PG equivalente (B/C/D/E) | Real? / gate? / lacuna |
|---|---|---|---|
| Cadastros → empresa, usuário, convite, SKU, locais | `server/test/empresas-admin.test.ts`, `usuarios.test.ts`, `locais.test.ts` | `server/test/pg-empresas-admin.test.ts`, `pg-usuario-convite.test.ts`, `pg/e03-multiempresa-ab.test.ts`, `pg/e03-onboarding-local-padrao.test.ts` | sim/sim; deleção lógica de todos os cadastros não comprovada |
| Compras → pedido, recebimento parcial, XML/de-para, custo, contas a pagar | `server/test/compras*.test.ts`, `custo-recebimento.test.ts` | `server/test/pg-compras-e32.test.ts`, `pg-custo-recebimento.test.ts`, `pg-cotacoes-compra.test.ts` | sim/sim; XML de ponta a ponta PG não evidenciado |
| Estoque → entrada/saída, devolução, saldo concorrente, inventário | `server/test/e421-estoque.test.ts`, `regras.test.ts` | `server/test/pg-concorrencia.test.ts`, `pg/e421-estoque-integridade.test.ts`, `pg/e42-http.test.ts` | sim/sim; transferência/reserva em PG não comprovadas |
| Produção → OP, consumo, perdas, custo, estorno, reabertura, concorrência, rollback | `server/test/producao-e2.test.ts` | `server/test/pg-producao-e2.test.ts`, `pg/e02-ordem-reabrir-postgresql.test.ts`, `pg/e02-reabertura-estorno-postgresql.test.ts` | sim/sim; NÃO alterado neste ciclo |
| Vendas → pedido, estoque, comissão, expedição, devolução | `server/test/pedidos.test.ts`, `pdv.test.ts` | `server/test/pg/e421-estoque-integridade.test.ts`, `pg/comissoes-e2e.test.ts`, `pg/e423-expedicao-postgresql.test.ts`, `pg/devolucao-e2e.test.ts` | sim/sim; abrangência de todos os meios de pagamento não comprovada |
| Financeiro → baixa, webhook, idempotência, conciliação, caixa | `server/test/financeiro-*.test.ts` | `server/test/pg-p2.test.ts`, `pg/e01-gateway-webhook-postgresql.test.ts`, `pg/gateway-cadeia-pagamento-e2e.test.ts` | sim/sim, **P1-11 TODO crítico**; integração bancária externa G não comprovada |
| Fiscal → documento, CHECK, inutilização | `server/test/fiscal.test.ts` | `server/test/pg-fiscal.test.ts`, `pg/fiscal-inutilizacao-e2e.test.ts` | sim/sim; cancelamento externo real não provado (provedor simulado) |
| Logística → separar/conferir/embalar/expedir/divergência/rollback | `server/test/expedicao.test.ts`, `logistica.test.ts` | `server/test/pg/e423-expedicao-postgresql.test.ts` | sim/sim; múltiplos transportadores reais G fora do gate |
| Multiempresa → CRUD escopado, estoque, compra, venda, financeiro, OP | `server/test/multiempresa*.test.ts` | `server/test/pg/e42-tenant.test.ts`, `pg/e42-http.test.ts`, `pg-compras-e32.test.ts`, `pg/e02-reabertura-estorno-postgresql.test.ts`, `pg/e01-gateway-webhook-postgresql.test.ts` | sim/sim; **webhook P1-11 não isolado por segredo** |
| Auditoria → trilha, histórico, idempotência e integridade | `server/test/auditoria*.test.ts` | `server/test/pg-auditoria-multiempresa.test.ts`, `pg/e02-reabertura-estorno-postgresql.test.ts`, `pg/e03-core-gate.test.ts` | sim/sim; auditoria integral de todos os recursos não provada |

## 3. Matriz por vertical

Legenda ✅ evidência do eixo; 🟡 parcial; 🔴 ausente; ⚪ não aplicável. **E2E** significa caminho operacional real HTTP/PG, não apenas status 200. Uma célula parcial não passa a ✅ só por existir outro teste PG. Referências abaixo são caminhos sob `server/test/`; U executado por `npm --workspace server test`, os demais por `npm run test:pg`. Matriz mapeia eixos testados, **não** declara vertical 100% coberta.

| Vertical | UNIT/F | PG | E2E PG | CONC PG | ROLLBACK PG |
|---|---|---|---|---|---|
| Cadastros | ✅ `empresas-admin.test.ts` | ✅ `pg-empresas-admin.test.ts` | ✅ `pg/empresas-admin-e2e.test.ts` | 🔴 auditoria `rg 'Promise.all' server/test/pg-empresas-admin.test.ts` | 🟡 `pg-usuario-convite.test.ts` |
| Compras | ✅ `compras.test.ts` | ✅ `pg-compras-e32.test.ts` | ✅ `pg-compras-e32.test.ts` | ✅ `pg-custo-recebimento.test.ts` | ✅ `pg-custo-recebimento.test.ts` |
| Estoque | ✅ `e421-estoque.test.ts` | ✅ `pg/e421-estoque-integridade.test.ts` | ✅ `pg/e421-estoque-integridade.test.ts` | ✅ `pg-concorrencia.test.ts` | 🟡 `pg/e421-estoque-integridade.test.ts` |
| Produção | ✅ `producao-e2.test.ts` | ✅ `pg-producao-e2.test.ts` | ✅ `pg/e02-reabertura-estorno-postgresql.test.ts` | ✅ mesmo arquivo, B1–B4 | ✅ mesmo arquivo, C/G1/G2 |
| Vendas | ✅ `pedidos.test.ts` | ✅ `pg/e421-estoque-integridade.test.ts` | ✅ `pg/e423-expedicao-postgresql.test.ts` | ✅ `pg/e421-estoque-integridade.test.ts` | ✅ `pg/e423-expedicao-postgresql.test.ts` |
| Financeiro | ✅ `financeiro-onda-b.test.ts` | 🟡 `pg-p2.test.ts` + P1-11 | 🟡 `pg/gateway-cadeia-pagamento-e2e.test.ts` + P1-11 | ✅ `pg-p2.test.ts` | ✅ `pg/gateway-cadeia-pagamento-e2e.test.ts` |
| Fiscal | ✅ `fiscal.test.ts` | ✅ `pg-fiscal.test.ts` | ✅ `pg/fiscal-inutilizacao-e2e.test.ts` | 🔴 auditoria `rg 'Promise.all' server/test/pg-fiscal.test.ts` | 🟡 `pg-fiscal.test.ts` (negação CHECK, não workflow completo) |
| Logística | ✅ `expedicao.test.ts` | ✅ `pg/e423-expedicao-postgresql.test.ts` | ✅ mesmo arquivo | ✅ mesmo arquivo (2 expedições) | ✅ mesmo arquivo (faturamento falha) |
| Multiempresa | ✅ `multiempresa.test.ts` | 🟡 `pg/e42-tenant.test.ts` + P1-11 | 🟡 `pg/e42-http.test.ts` + P1-11 | 🟡 `pg/e02-reabertura-estorno-postgresql.test.ts` | ✅ mesmo arquivo |
| Auditoria | ✅ `auditoria.test.ts` | ✅ `pg-auditoria-multiempresa.test.ts` | 🟡 `pg/e42-http.test.ts` | 🟡 `pg/e02-reabertura-estorno-postgresql.test.ts` | ✅ mesmo arquivo, eventos G1/G2 |

## 4. Gaps, decisões e mudanças

**Detectados:** (1) TODO P1-11 em `server/test/pg/e01-gateway-webhook-postgresql.test.ts:394` passa silenciosamente pelo runner (apesar de `not ok # TODO`); **crítico e ainda aberto**: assinatura da empresa A pode bloquear webhook de B; não transformar falha em sucesso. (2) `test:pg` sobre DB usado aceita resíduos/ordem (P2-09), risco de flaky/fixture colidindo. (3) nenhum teste explícito reunia JSONB objeto/string/array/JSON-null/SQL-NULL e UNIQUE/FK/NOT NULL no catálogo real. (4) CI `prisma migrate resolve || echo` podia ocultar falha de baseline. (5) `verificar` não executava client test, smoke ou audit:menu. (6) 17m39s baseline eram majoritariamente **espera de pool idle dos workers**, não 1001/5000 registros: duração das operações volumosas ~4,2 s e ~3,8 s (`/tmp/erp03-baseline-pg.log`).

**Corrigidos neste PR:** `npm run test:pg` é o único comando oficial: conecta via driver `pg`, exige URL PG, `server_version_num=160014` e banco *vazio* antes do glob serial; retorna falha em runner fail, summary ausente, skipped ou TODO. O idle timeout do pool de **teste** passa a 1000 ms por child env, sem alterar timeout de query/transação, app nem fixtures: ~98 s solo no mesmo host. `server/test/pg/e03-core-gate.test.ts` verifica todas as 32 migrations registradas, coluna JSONB real, índice único real, leitura `#>>`, cinco formas de payload, códigos 23505/23503/23502, `SAVEPOINT`, rollback total e ausência de resíduo. CI mantém serviço `postgres:16.14`, healthcheck, versão explícita por `current_setting`, shell `pipefail`, `test:pg` + `smoke:pg` obrigatórios, passos adicionais em `verificar` e baseline Prisma sem `|| echo`. **Não corrigido:** P1-11 requer decisão e alteração de segurança do endpoint multiempresa; nenhuma alteração de produção foi feita por oportunismo.

## 5. Arquitetura e reprodução

```bash
# Node 22; PostgreSQL real 16.14. Usuário com permissão CREATE DATABASE para smoke:pg.
npm ci
# criar um NOVO banco de teste para CADA execução; nunca usar produção
DATABASE_URL=postgresql://usuario:senha@host:5432/banco_vazio npm run test:pg
DATABASE_URL=postgresql://usuario:senha@host:5432/banco_admin npm run smoke:pg
# smoke em memória exige API demo recém-iniciada, sem DATABASE_URL
```

O CI tem jobs separados (`verificar`, `testes-postgres`), serviço postgres isolado, healthcheck, migrations via `migrate()` em `server/src/db.ts` (`db/schema.sql` + `db/migrations/0001…0032`, advisory lock e transação por arquivo), fixtures dos testes e boot de `smoke:pg` em banco descartável; o runner encerra processo e apaga o DB (exceto `--keep` local). Prisma é dual-track: baseline `20261005120000` após migrations ERP + `migrate deploy` (etapas diagnósticas executadas mesmo quando `test:pg` falha, sem mudar a conclusão do job). A remoção de `|| echo` torna falha bloqueante. Os logs de falha de test:pg/smoke:pg entram em annotation via `tee` + `pipefail`. GitHub Actions é a autoridade sobre checks do PR: run de pull request [38385195490](https://github.com/petrickmsilva-alt/brobond-erp/actions/runs/38385195490) no commit `9adb1f2`: `verificar` **PASS** (todos os passos, incluindo Prisma validate); `testes-postgres` **FAIL** exatamente no `test:pg` por P1-11 (`152 pass, 0 fail, 1 TODO`, annotation `testpg falhou`). `if: !cancelled()` recolheu evidência adicional **sem** `continue-on-error`: instalar Prisma, baseline, `migrate deploy` e `smoke:pg` **PASS** no mesmo job; o job continua **FAIL**. `Post Run actions/setup-node@v4` foi skipped pela falha anterior, não altera o resultado do gate.

**Schema/drift:** foi comparado o inventário `db/schema.sql`, 32 arquivos `db/migrations` e catálogo PG via `e03-core-gate.test.ts`: todos os IDs presentes, tipo JSONB e índice verificados. Provas específicas de índices/FKs/CHECKs em `pg-concorrencia.test.ts`, `pg-fiscal.test.ts`, `pg/e421-estoque-integridade.test.ts`, `pg/contrato-tipo-coluna.test.ts`. `prisma/migrations` é trilho independente de 6 arquivos; **não** há prova de diff completo de todos os objetos/constraints/enums/triggers do banco contra ambas as árvores SQL. `npx prisma validate`, `migrate resolve` e `migrate deploy` localmente não completaram: sandbox bloqueia `binaries.prisma.sh` (engine Prisma). Não relatar schema Prisma local como validado. CI `verificar` validou o schema Prisma; no run 38385195490 o job PG executou com sucesso `migrate resolve` e `migrate deploy` apesar de permanecer vermelho pela P1-11.

## 6. Evidência executada (PostgreSQL REAL)

Local: binário PostgreSQL **16.14**, `current_setting('server_version_num') = 160014`; pacote binário temporário fora do repositório (`/tmp/erp03-pg`), banco dedicado por rodada. Scripts de teste/smoke apontaram `127.0.0.1:5432`. Nenhuma credencial ou dataset foi adicionada ao Git.

| Prova | Resultado observado |
|---|---|
| Baseline `server test:pg`, DB novo | 150 pass, 0 fail, **1 TODO**, exit 0, 1.059.174 ms |
| Novo teste isolado em DB novo | 2 pass, 0 fail, 2.018 ms |
| Gate ERP-03 RUN 1, DB novo | 152 pass, 0 fail, **1 TODO**, runner 0 → **gate 1**, 98.242 ms |
| Gate RUN 2, DB novo (em paralelo com demais gates) | 152/0/1, **gate 1**, 141.103 ms |
| Gate RUN 3, DB novo | 152/0/1, **gate 1**, 96.547 ms |
| Sem `DATABASE_URL` / banco reutilizado | exit 2 / exit 1 antes da suíte |
| `npm run smoke:pg` (DB criado/descartado) | **126/126**, exit 0 |
| `npm --workspace server test` | 695 pass, 0 fail, 65 skip (PG não incluídos no glob) |
| `npm --workspace client test` | 290 pass / 28 arquivos |
| `npm run smoke` (API demo iniciada antes) | 126/126 |
| `npm run typecheck`, `lint`, `build`, `audit:menu` | exit 0; lint 415 warnings/0 errors; menu 4 warnings |
| `npx prisma validate/resolve/deploy` local | BLOCKED por download de schema-engine (host fora da allowlist); não houve resultado de validação |
| GitHub CI PR #56, run 38385195490 | `verificar` PASS; `testes-postgres` FAIL no `test:pg` por P1-11; Prisma baseline/deploy e `smoke:pg` PASS no mesmo job, sem suprimir falha |

**Mutação controlada:** somente durante a execução, o teste PG de rollback foi alterado para esperar `1` registro após `ROLLBACK` em vez de `0`. Em banco novo o gate respondeu exit **1** com `not ok 95`, `# fail 1`, `# todo 1` (96.769 ms). Arquivo restaurado bit a bit (SHA256 idêntico); RUN 2 e RUN 3 após restauração retornaram `# fail 0` mas gate **continua exit 1 pelo TODO crítico preexistente**. Logo a prova *falha de teste detectada* é **PASS**, mas a prova *gate final verde* é **FAIL**. Não falsificar a segunda. A duração é TAP total, incluindo espera idle; sem fixture volumosa descartada. Desempenho sob paralelismo local variou 96–141 s; mesmas contagens, sem flake observada em três bancos novos, não prova ausência universal de flakiness.

## 7. Auditoria interna / decisão

PG real? sim; CI usa PG? sim, check remoto executado em 16.14; falha de teste bloqueia? sim (mutação); TODO crítico? **sim, P1-11**; multiempresa/rollback/concorrência/idempotência/JSONB/constraints/volume/estado final? há provas concretas acima e nos arquivos da matriz, **não universalmente**; drift Prisma integral? não; testes em banco reutilizado? barrados; todo crítico mascarado? agora **não** (CI fica vermelho). Portanto **ERP-03 NÃO APPROVED**. Para aprovação: decidir/corrigir P1-11 com teste PG não-TODO, obter 0 skip/TODO no gate, executar Prisma e CI em mesmo head, auditar PR independentemente. Não reabrir ERP-02 para obter verde.

## 8. Arquivos deste ciclo e justificativa

- `scripts/test-pg-gate.mjs` — preflight versão/banco vazio + propagação do status e TODO/skip; idle de teste.
- `package.json` — `test:pg` passa pelo gate oficial, reaproveitando o glob server.
- `.github/workflows/ci.yml` — executar comando oficial, remover masking Prisma, incluir testes client/smoke demo/audit/typecheck domínio, consulta versão explícita.
- `server/test/pg/e03-core-gate.test.ts` — evidência PG real de migrations, JSONB, constraints e rollback.
- `docs/ERP-03-TEST-INVENTORY.md` — classificação arquivo a arquivo A–G.
- `docs/ERP-03-POSTGRES-GATE-PLAN.md` — estado final do plano e referência a este relatório.
- `docs/RELATORIO-ERP-03.md` — matriz, gaps, execução e bloqueio auditável.

**Commit/PR:** implementação `337c82420282391304af33d262536b6c9b14efa3` / PR #56; esta atualização de evidência é commit documental posterior na mesma branch (HEAD final informado na entrega). Nenhum merge automático. Limitações: P1-11 crítico; Prisma local sem engine; CI remoto deliberadamente vermelho/auditoria humana pendente; cobertura incompleta nas células parciais/vermelhas, integrações externas G excluídas. Nenhuma alteração frontend, operacional ERP-02, Commerce ou schema SQL.
