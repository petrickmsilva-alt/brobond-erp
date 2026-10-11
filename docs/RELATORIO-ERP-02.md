# RELATÓRIO — ERP-02 (P0-01: reabertura/estorno de ordem de produção em PostgreSQL)

**Repositório:** `petrickmsilva-alt/brobond-erp`
**Branch:** `arena/50e1f16d-brobond-erp` (a partir de `649e0462a2f7f5217ab5f0c10c2d5ddd6752df92` da `main`)
**Data:** 2026-10-11
**Escopo:** exclusivamente o ERP. `brobond-ai-commerce` não foi tocado. ERP-03 não foi iniciado. Nenhum módulo de Commerce, BI ou gateway/pagamentos foi alterado.

> **O que este documento é.** O ERP-02 foi implementado e mergeado na `main` em ciclo anterior (PR #49; a seção ERP-02 do [`docs/ERP-CORE-ROADMAP.md`](ERP-CORE-ROADMAP.md) está marcada como CLOSED, com o arquivo `server/test/pg/e02-ordem-reabrir-postgresql.test.ts` de 2 testes). Esta rodada **não reimplementou** aquele ciclo. Ela (a) **localizou o fluxo inteiro antes de tocar em qualquer linha** (§2 da especificação); (b) **provou o P0-01 e a correção nesta máquina**, contra **PostgreSQL 16.2 real**, por reconstrução do código pré-correção por mutação (o pacote tem um commit único — não existe revisão pré-correção para `checkout`); (c) **encontrou e corrigiu dois defeitos REAIS do mesmo fluxo que a prova existente não cobria** — a conclusão seguinte a uma reabertura produzia **sem consumir insumo** (saldo de insumo inflado, custo real descolado do estoque) e o estorno **não registrava** o custo real nem as perdas que revertia; e (d) fechou a matriz completa de gates do ciclo (conclusão, estorno, reabertura, estorno repetido, concorrência, rollback, perdas, custo, multiempresa, histórico) em PostgreSQL real, com 8 testes novos em arquivo novo e 1 teste de paridade em memória.
>
> **Nada foi presumido:** cada causa-raiz abaixo tem o SQL/erro, o estado antes, o estado parcial (quando existe) e a medição antes/depois da correção.

---

## 1. STATUS FINAL

| Gate do ciclo | Situação | Evidência |
|---|---|---|
| Defeito reproduzido antes da correção | ✅ | §3.1 (500 por 23514, mutação) · §3.2 (1000 ≠ 980) · §3.3 (NaN ≠ 390) |
| Causa-raiz identificada | ✅ | §4 (três, com SQLSTATE/linha) |
| Correção implementada | ✅ | §5 (`server/src/producao.ts`) |
| PostgreSQL real verde | ✅ | §8/§9 (`test:pg` 142 testes · 141 pass · 0 fail · 1 todo) |
| Estorno correto | ✅ | §9/§10 (testes A, B, C) |
| Reabertura correta | ✅ | §10 (A: `concluida → planejada`, estoque e insumo de volta) |
| Estoque correto | ✅ | §10 (A/B/C; nenhum saldo negativo em nenhum cenário) |
| Custo correto | ✅ | §10 (A: 2º ciclo = 200 líquido; E: 390 com perdas/indiretos) |
| Perdas corretas | ✅ | §10 (E: refugadas consomem insumo, não entram no estoque, e ficam na trilha) |
| Histórico correto | ✅ | §10 (E: `revertido` no evento + auditoria; movimentos originais preservados) |
| Idempotência comprovada | ✅ | §13 (estorno repetido 409 sem efeito; 2 ciclos completos sem duplicar) |
| Concorrência comprovada | ✅ | §11 (2 estornos e 2 conclusões simultâneos → uma transição válida) |
| Rollback comprovado | ✅ | §12 (falha na 2ª linha da grade → nada mudou) |
| Multiempresa comprovada | ✅ | §14 (B não alcança A; estorno de A não toca B) |
| Typecheck verde | ✅ | §9 (`npm run typecheck` — domain, server, client) |
| Lint verde | ✅ | §9 (0 erros / 415 warnings — **idêntico ao baseline**) |
| Build verde | ✅ | §9 (`npm run build`) |
| Smoke verde | ✅ | §9 (126/126 em memória) |
| `smoke:pg` verde | ✅ | §9 (126/126 em banco novo PostgreSQL) |
| `audit:menu` verde | ✅ | §9 (sem erros; 4 avisos classificados, inalterados) |
| Nenhuma alteração no Commerce | ✅ | `git diff --stat` só em Produção (`server/src/producao.ts`) e testes/docs |
| Nenhum avanço de ERP-03 | ✅ | nenhuma linha de ERP-03 |
| Documentação criada | ✅ | este arquivo + atualização de `ERP-CORE-ROADMAP.md` e `ERP-GAPS.md` |
| PR aberto, sem merge | ✅ | PR aberto ao final do ciclo (merge é decisão humana) |

## 2. ESTADO INICIAL — inventário do fluxo (antes de alterar código)

Levantamento do caminho por onde o defeito passa, exatamente como a especificação exige (§2 do ciclo):

| Peça do fluxo | Onde está | O que faz |
|---|---|---|
| Máquina de estados | `server/src/producao.ts` (`STATUS_OP`, `TRANSICOES_OP`, `transicaoPermitida`) | `planejada → liberada → em_producao → parcial → concluida` (+ `cancelada` terminal); a única saída de `concluida` é `planejada`/`em_producao` (reabrir) |
| `concluirOrdem` | `producao.ts` (`aplicarRegrasOrdem` → `concluirOrdem`) | entrada de produto acabado por tamanho (`adjustStock` + `movimentacoes` com `ordem_id`), baixa de insumos da ficha e `custo_real` |
| `estornarOrdem` | `producao.ts` (`aplicarRegrasOrdem` → `estornarOrdem`) | reabertura: saída compensatória de produto acabado (`tryAdjustStock`), devolução de insumos (movimentação de entrada com `ordem_id`), descarte de apontamentos, zeragem de produzido/perdido/custo da OP, trilha |
| `reabrir` / `cancelar` | `producao.ts` (`reabrirOrdem`, `cancelarOrdem`) | handlers HTTP; ambos passam por `updateRecord` → `aplicarRegrasOrdem` (um caminho só para estoque/trilha) |
| Estoque de produto | `server/src/pgstore.ts` (`adjustStock`, `tryAdjustStock`, `translatePgError`) | `adjustStock` = `INSERT … ON CONFLICT DO UPDATE`; `tryAdjustStock` = `INSERT 0 DO NOTHING` + `UPDATE` condicional com row lock; `translatePgError` traduz 23514/40001/40P01/23505/23503/23502 |
| Estoque de insumo | `pgstore.ts` (`adjustInsumoStock`, `insumoStock`) + `producao.ts` (`baixarInsumos`, `jaConsumidoNaOrdem`, `calcularCustoReal`) | `movimentacoes_insumos` sem coluna de estorno: a devolução é **lançamento compensatório** (entrada com `ordem_id`) |
| Vínculos | `movimentacoes.ordem_id`, `movimentacoes_insumos.ordem_id` (FK) | o estorno localiza os efeitos pela FK, não pelo texto do `motivo` |
| Trilha | `ordens_eventos` (`criada`, `liberada`, `apontamento`, `perda`, `concluida`, `reaberta`, `cancelada`, `atalho`, `edicao`) + `auditoria` | história da OP; `dados` é gravado no banco e **não sai pela API** (regra de segredo do `memdb.decorate`) |
| Concorrência | `PgStore.transaction` → `withTransaction(..., 'serializable')` + row lock do `UPDATE` do estoque | toda escrita de negócio roda em SERIALIZABLE; conflito vira `40001/40P01` → **409** |

**O que já estava na `main`** (verificado, não presumido): `estornarOrdem` usava `tryAdjustStock`, e `translatePgError` já traduzia 23514 → 409. Os dois arquivos de prova existentes cobriam **2 cenários** (reabertura feliz e a tradução do 23514). O que **não** estava coberto — e é o que esta rodada mediu — é o comportamento **depois** de uma reabertura (§3.2) e o **registro do que foi revertido** (§3.3).

## 3. DEFEITO REPRODUZIDO — ANTES

### 3.0 Ambiente da reprodução

PostgreSQL **16.2 real** neste sandbox (binários embarcados do pacote `pgserver`, cluster em `/tmp/pgdata`, porta **5433**, base `brobond_erp02_e2`, `trust` local), com o **mesmo bootstrap do CI**: `db/schema.sql` + `db/migrations` aplicados pelo `migrate()` da API (migrações **0015…0032** aplicadas no log). O modo demonstração (memória) foi usado **apenas** para comparação de regressão — a referência operacional é o PostgreSQL (§10 da especificação).

### 3.1 P0-01a — reabrir uma OP concluída respondia **500** em PostgreSQL

* **Estado inicial:** OP concluída (10 peças no estoque, 20 m de insumo consumidos, `status='concluida'`).
* **Operação:** `POST /api/ordens/:id/reabrir` (gerente).
* **SQL / constraint / erro:** `estoques_quantidade_nao_negativo` — SQLSTATE **23514**, `Failing row contains (…, -10, …)`; sem tradução, a resposta era `500 {"error":"Erro interno do servidor"}`.
* **Estado parcial:** nenhum (a transação reverte inteira) — o defeito é de **resposta/erro**, não de atomicidade.
* **Esperado:** `200` com a OP de volta em `planejada` e o estoque estornado.
* **Observado:** `500`.

**Reprodução por mutação** (o pacote tem commit único; o código pré-correção foi reconstruído e revertido em seguida):

```
MUTAÇÃO (as duas linhas originais): estornarOrdem com adjustStock(…, −qtd, …)
                                   + translatePgError sem o caso 23514
node --import tsx --test test/pg/e02-ordem-reabrir-postgresql.test.ts
not ok 1 - ERP-02: reabrir OP estorna em PostgreSQL (antes: 500 por SQLSTATE 23514)
  error: reabrir precisa responder 200 — era o defeito P0-01: {"error":"Erro interno do servidor"}
  expected: 200   actual: 500
not ok 2 - ERP-02: 23514 (violação de CHECK) é erro de negócio 409 — nunca 500 nem vazamento
# tests 2 · # pass 0 · # fail 2
```

Prova do mecanismo em SQL cru (teste **F**, executado no PostgreSQL real): com saldo **50**, o padrão do `adjustStock` com delta negativo é recusado **no tuple proposto** mesmo que o resultado final (40) fosse válido:

```
INSERT INTO t (id, quantidade) VALUES (1, -10) ON CONFLICT (id) DO UPDATE SET quantidade = t.quantidade - 10
ERROR:  new row for relation "t" violates check constraint "t_quantidade_check"
DETAIL:  Failing row contains (1, -10)          -- o UPDATE nem chegou a rodar (saldo segue 50)
UPDATE t SET quantidade = quantidade + (-50) WHERE id = 1 AND quantidade + (-50) >= 0   -- ⇒ 0, válido
UPDATE t SET quantidade = quantidade + (-10) WHERE id = 1 AND quantidade + (-10) >= 0   -- ⇒ 0 linhas (saldo 0, nunca negativo)
```

### 3.2 P0-01b — **defeito novo**: depois de reabrir, a OP concluía de novo **sem consumir insumo**

* **Estado inicial:** OP de 10 peças com ficha de 2 m/peça e 1000 m em saldo. Ciclo 1: concluir (insumo 1000 → 980) → reabrir (insumo 980 → **1000**, produto 10 → 0).
* **Operação:** liberar → apontar 10 peças → `POST /concluir` (2ª conclusão).
* **SQL/erro:** nenhum erro — o sistema **aceita** e grava errado: `jaConsumidoNaOrdem` somava **apenas** `movimentacoes_insumos.tipo='saida'` e encontrava os 20 m da 1ª conclusão (que já tinham sido **devolvidos** pelo estorno).
* **Estado parcial:** entrada de 10 peças no estoque **sem** a baixa correspondente de insumo; `custo_real` carregando consumo já estornado.
* **Esperado:** 2ª conclusão baixa 20 m de novo (insumo **980**) e custo real **R$ 200** (o consumo vigente).
* **Observado:** `saldoInsumo = 1000` (`1000 !== 980`) — a peça foi produzida sem consumir insumo; o saldo de insumo fica **inflado** e o custo real **descola** do estoque.

```
not ok 1 - ERP-02/A: o segundo ciclo conclui e estorna de novo — insumo re-consumido e custo líquido
  error: 1000 !== 980
  expected: 980   actual: 1000        (arquivo novo, código SEM a correção, PostgreSQL real)
```

> Este defeito **não existe na suíte em memória** e não existia em nenhuma prova: o teste de ciclo que já existia (`producao-e2.test.ts`, "reabrir estorna estoque e insumos PELA FK e é idempotente") faz três ciclos concluir/reabrir e confere apenas que o **líquido final volta a zero** — ele nunca confere que a conclusão do meio **consumiu**. Ou seja: o saldo final "fecha" enquanto cada produção intermediária consumiu de menos.

### 3.3 P0-01c — **defeito novo**: o estorno **não registrava** o custo real e as perdas que revertia

* **Estado inicial:** OP de 10 peças + 2 refugadas, ficha 2 m/peça a R$ 10, mão de obra R$ 100 e indiretos R$ 50 → `custo_real = 240 + 150 = R$ 390`, `quantidade_perdida = 2`.
* **Operação:** `POST /reabrir`.
* **SQL/erro:** nenhum — a OP é atualizada para `custo_real = 0`, `quantidade_produzida = 0`, `quantidade_perdida = 0`, `concluida_em = NULL` e o evento `reaberta` gravava `dados = { pecas, insumos, apontamentos }` **sem** custo nem perdas.
* **Estado parcial:** a coluna da OP é zerada legitimamente (ela voltou a estar em aberto), mas o valor revertido **não ficava em lugar nenhum consultável** — o custo real e a perda da produção anulada desapareciam do registro da OP (as movimentações de insumo preservam quantidade/custo unitário, mas não o custo da OP nem a perda por apontamento).
* **Esperado:** o evento de estorno e a auditoria carregam o que foi revertido (custo real, peças boas, refugadas, custo previsto, conclusão).
* **Observado:** `dados.custo_real` ausente (`NaN !== 390`) e mensagem sem o custo.

```
not ok 7 - ERP-02/E: o estorno reverte custo e perdas da OP em aberto e preserva o histórico
  error: NaN !== 390
  expected: 390   actual: NaN         (arquivo novo, código SEM a correção, PostgreSQL real)
```

## 4. CAUSA-RAIZ

| # | Causa-raiz | Linha (antes) | Por que o sintoma é esse |
|---|---|---|---|
| 1 | `estornarOrdem` usava `adjustStock(…, −qtd)`; o `INSERT … ON CONFLICT DO UPDATE` faz o PostgreSQL avaliar o CHECK `estoques_quantidade_nao_negativo` no **tuple proposto** (−qtd) **antes** de resolver o conflito — o saldo real nunca é consultado | `producao.ts` (`estornarOrdem`, 1ª etapa) | **23514 garantido** em toda reabertura; sem tradução, `500 Erro interno do servidor` |
| 2 | `jaConsumidoNaOrdem` (e `calcularCustoReal`) somavam **só as saídas** de `movimentacoes_insumos`; o estorno devolve insumo por **lançamento compensatório** (entrada com o mesmo `ordem_id`) | `producao.ts` (`jaConsumidoNaOrdem`, `calcularCustoReal`) | A conclusão seguinte enxerga o consumo **estornado** como vigente → não baixa insumo; e o custo real soma consumo que já não existe |
| 3 | `estornarOrdem` zerava produzido/perdido/custo da OP e gravava na trilha apenas peças/insumos/apontamentos | `producao.ts` (`estornarOrdem`, 3ª etapa) | O que foi **revertido** não ficava registrado — o custo real da produção anulada se perdia |

## 5. CORREÇÃO

**Um só lugar lê o consumo da OP** (`server/src/producao.ts`):

1. **`consumoLiquidoDaOrdem(ordemId, escopo, tx)`** (novo): por insumo, `Σ saídas − Σ entradas` em **quantidade** (`round3`) e em **dinheiro** (`Σ qtd × custo_unitario`, `round2`), a partir das movimentações ligadas à OP pela FK `ordem_id`. Documenta o porquê do líquido (lançamento compensatório, sem coluna de estorno) e recusa insumo de outra empresa (`404`).
2. **`jaConsumidoNaOrdem`** passa a devolver o líquido (> 0) — a baixa de insumo da próxima conclusão **volta a consumir** o que o estorno devolveu.
3. **`calcularCustoReal`** passa a somar o **valor líquido** por insumo — o custo real acompanha o estoque (não carrega consumo estornado, não perde o consumo vigente). Sem reabertura a conta é **idêntica** à anterior (Σ entradas = 0).
4. **`estornarOrdem`** usa o mesmo helper para decidir **quanto** devolver e **a que custo**: quantidade líquida e custo unitário = `valor líquido ÷ quantidade líquida` (arredondado a centavos), de modo que a devolução compensatória devolve exatamente o dinheiro que a OP baixou — mesmo quando o custo médio do insumo mudou entre um consumo e outro.
5. **`estornarOrdem`** grava o bloco **`revertido`** (`quantidade_produzida`, `quantidade_perdida`, `custo_real`, `custo_previsto`, `concluida_em`) no `dados` do evento `reaberta` **e** na auditoria, e a mensagem passa a dizer `… · custo real revertido R$ X` e quantas peças refugadas foram revertidas.

**Estratégia preservada (§4/§5 da especificação):**

* estoque de produto acabado continua com **movimento compensatório** (`movimentacoes` de `saida`) e a entrada original é **marcada** (`estornado=true`, `estornado_em`, `estornado_por`) — **nenhum DELETE** de histórico;
* insumo continua com **entrada compensatória** ligada à OP (`movimentacoes_insumos.ordem_id`), agora com o valor exato;
* **nenhum estado novo** foi inventado na máquina de estados;
* custo previsto congelado, proporcionalidade dos indiretos (`min(1, processadas/planejadas)`), perdas e o caminho `?forcar=true` **intocados**;
* nenhuma mudança de schema, de API pública (payloads) ou de frontend; `dados` do evento segue sendo gravado no banco e não exposto pela API — a diferença visível ao operador é a mensagem, que agora carrega o custo revertido.

## 6. ARQUIVOS ALTERADOS

| Arquivo | Δ | Papel |
|---|---|---|
| `server/src/producao.ts` | +107 / −37 | causa-raiz 2 e 3: helper canônico `consumoLiquidoDaOrdem`, baixa de insumo, custo real e estorno; bloco `revertido` na trilha/auditoria |
| `server/test/pg/e02-reabertura-estorno-postgresql.test.ts` | **novo** (8 testes) | matriz do ciclo em PostgreSQL real (A–F: ciclo duplo, concorrência ×2, conclusão concorrente, rollback, multiempresa, perdas/custo/histórico, causa-raiz em SQL) |
| `server/test/producao-e2.test.ts` | +34 | paridade em memória: depois de reabrir, a próxima conclusão **consome de novo**, e a trilha guarda o custo revertido |
| `docs/RELATORIO-ERP-02.md` | **novo** | este relatório |
| `docs/ERP-CORE-ROADMAP.md` | + | rodada de verificação do ERP-02 (o que foi provado e onde) |
| `docs/ERP-GAPS.md` | + | P0-01 com a prova desta rodada + GAPs novos registrados (fora do escopo, não corrigidos) |

Nenhum arquivo de frontend, de Commerce, de BI, de gateway/pagamentos ou de schema.

## 7. MIGRATION

**Migração não necessária.** A correção é de código sobre estruturas que já existem e já têm os vínculos e constraints corretos: `movimentacoes.ordem_id`, `movimentacoes_insumos.ordem_id`, `ordens_eventos.dados`, `auditoria.dados`. A constraint `estoques_quantidade_nao_negativo` está **certa** — era o código que a violava. Nenhum `db/migrations/*.sql` novo, nenhuma alteração em `db/schema.sql`, nenhuma alteração em `prisma/schema.prisma`.

## 8. TESTES — ANTES

| Suíte | Antes (nesta máquina) |
|---|---|
| `test:pg` **com** o arquivo novo (código sem a correção) | **2 falhas** (`A`: `1000 !== 980`; `E`: `NaN !== 390`) — §9.2 |
| `test:pg` (a **mesma** suíte, com o arquivo novo, **sem** a correção) | **142 testes · 139 pass · 2 fail** (A e E) · 0 skipped · 1 todo |
| `e02-ordem-reabrir-postgresql.test.ts` com as duas linhas pré-correção reconstruídas | **0 pass · 2 fail** (`500 Erro interno do servidor`) — §3.1 |
| `server test` (memória) **antes** da correção | 759 testes · **694 pass · 0 fail** · 65 skipped · 0 todo |
| `client test` | 26 arquivos · 262 pass |
| lint | 0 erros · **415 warnings** (baseline atual da `main`) |

## 9. TESTES — DEPOIS

### 9.1 Bateria completa (todas executadas nesta máquina, nesta rodada)

| Comando | Resultado |
|---|---|
| `npm run typecheck` (domain + server + client) | ✅ 0 erros |
| `npm --workspace server test` | ✅ **760 testes · 695 pass · 0 fail · 65 skipped · 0 todo** (+1 teste: a paridade em memória do §6) |
| `npm --workspace client test` | ✅ 26 arquivos · **262 pass** |
| `npm run test:pg` (PostgreSQL 16.2 real, base `brobond_erp02_e2`) | ✅ **142 testes · 141 pass · 0 fail · 0 cancelled · 0 skipped · 1 todo** (o `todo` é o `ERP-01/P1-11`, pré-existente e de outro ciclo) |
| `npm run smoke` (demonstração, API em `:3001`) | ✅ **126/126 verificações** |
| `npm run smoke:pg` (banco NOVO em PostgreSQL, API real spawnada, banco apagado ao final) | ✅ **126/126 verificações** · `✅ smoke:pg — smoke E2E aprovado contra PostgreSQL real` |
| `npm run lint` | ✅ **0 erros** · 415 warnings (**idêntico ao baseline da `main`** — a correção não adicionou nem removeu aviso) |
| `npm run build` (client) | ✅ build + PWA gerados |
| `npm run audit:menu` | ✅ sem erros (4 avisos classificados, inalterados: 3 `RBAC_DERIVA_SOLTA` de módulos de ERP-10 e o `ROTA_PUBLICA` do `/api/health`) |
| `npm run db:validate` (Prisma) | ⚠️ **não executável neste sandbox** — o CLI exige baixar `schema-engine` de `binaries.prisma.sh`, fora da allow-list de rede do ambiente (`Client network socket disconnected`). Limitação de ambiente, não falha de código: **nenhuma linha de schema/Prisma foi alterada** neste ciclo. Ver §15 |
| `npm run test` (raiz) | ✅ = `server test` + `client test` acima |

### 9.2 Arquivo novo — antes × depois (PostgreSQL real, mesmo arquivo, mesmo banco)

```
SEM a correção  →  # tests 8 · # pass 6 · # fail 2   (A: 1000 !== 980 · E: NaN !== 390)
COM a correção  →  # tests 8 · # pass 8 · # fail 0   (35,8 s)
```

### 9.3 Paridade em memória (evita a regressão silenciosa do P2-03)

O defeito do §3.2 **não** aparecia na suíte de memória. Além do arquivo PostgreSQL, o ciclo adicionou o teste equivalente em `server/test/producao-e2.test.ts` (`E2: depois de reabrir, a próxima conclusão CONSOME o insumo de novo (líquido × bruto)`): 1º ciclo baixa 20 m e devolve; **2º ciclo baixa de novo** (`980`) e custa `R$ 200`; 3º estorno devolve e a mensagem traz `custo real revertido R$ 200.00`.

## 10. EVIDÊNCIA POSTGRESQL

* **Versão/ambiente:** `PostgreSQL 16.2 on x86_64-pc-linux-gnu` (binários embarcados), cluster `/tmp/pgdata`, `listen_addresses=127.0.0.1`, porta **5433**, base `brobond_erp02_e2`; mesmo bootstrap do CI (`db/schema.sql` + `db/migrations`; migrações **0015…0032** aplicadas no log da API).
* **Caminho de prova:** HTTP real (servidor Express de verdade com `src/index.ts`, JWT real, `PgStore`, `PostgreSQL` real) — sem atalho por handler, sem dublê de banco. Sem `DATABASE_URL`, os dois arquivos `e02*.test.ts` **falham por construção** (não pulam).
* **Números do cenário A (ciclo duplo) medidos no banco:** 1ª conclusão → produto `10`, insumo `980`, `custo_real 200`, `status concluida`; 1º estorno → produto `0`, insumo `1000`, `status planejada`, `custo_real 0`, `concluida_em NULL`, apontamentos `0`; 2º reabrir → **409** sem criar movimento; 2ª conclusão → produto `10`, insumo **`980`** (a correção), `custo_real 200`; 2º estorno → produto `0`, insumo `1000`. Movimentos: `entrada:10:estornado · saida:10 · entrada:10:estornado · saida:10`; insumos: `saida:20 · entrada:20 · saida:20 · entrada:20`; dois eventos `reaberta`; **zero** saldos negativos (`estoques` e `estoque_insumos`).
* **Prova por SQL da causa-raiz 1** (teste F): o `INSERT … ON CONFLICT DO UPDATE` com tuple proposto negativo devolve **23514** com 50 em saldo; o `UPDATE` condicional aplica `−50` (⇒ 0) e recusa `−10` com 0 linhas (saldo nunca negativo).

## 11. CONCORRÊNCIA (§7 da especificação)

Três provas em PostgreSQL real, todas com **assertiva de efeito único**:

| Cenário | Resultado medido |
|---|---|
| **B1** — dois `POST /reabrir` simultâneos com **saldo sobrando** (40 peças: 10 da OP + 30 extra) | `[200, 409]`; saldo `40 → 30` (**um só estorno**); **1** movimentação de saída; entrada da OP estornada uma única vez; **1** devolução de insumo; insumo `1000`; nenhum saldo negativo |
| **B2** — dois `POST /reabrir` simultâneos com **saldo exato** (7 peças) | `[200, 409]`; saldo `0` (nunca negativo); insumo `1000` |
| **B3** — dois `POST /concluir` simultâneos | `[200, 409]`; entraram **9** peças (não 18); **1** movimentação de entrada; insumo consumido **uma vez** (`18 m`) |

**Garantias usadas (nenhuma nova criada):** `PgStore.transaction` roda em isolamento **SERIALIZABLE**; o `UPDATE` do `tryAdjustStock` toma **row lock** e reavalia o predicado `quantidade + delta >= 0`; a escrita da OP acontece **depois** dos efeitos, então a transação perdedora recebe `40001` (`could not serialize access due to concurrent update`) — traduzido para **409** por `translatePgError` — e faz **rollback integral**. O B1 é o cenário mais forte: com saldo extra, as duas operações "caberiam" no estoque e sem a garantia transacional teriam saído 20 peças de uma OP de 10.

## 12. ROLLBACK (§8 da especificação)

OP **por grade** com 2 tamanhos (5 + 5), concluída; o saldo do **segundo** tamanho é consumido por fora; `POST /reabrir` devolve **409** de negócio (`Não há saldo de 5 peça(s) em "…" para estornar a OP #N. Nada foi alterado…`) **depois** de a 1ª linha já ter sido estornada dentro da transação. Medido antes/depois no banco: `status` segue `concluida`, `custo_real`/`produzido`/`perdido`/`concluida_em` **idênticos**, **nenhuma** movimentação de estorno, **nenhuma** devolução de insumo, saldo do 1º tamanho **de volta ao valor original**, apontamentos **vivos**, **nenhum** evento novo na trilha, nenhum saldo negativo. Atomicidade provada — não por inspeção de código, por medição.

## 13. IDEMPOTÊNCIA (§6 da especificação)

* **Estorno repetido sequencial:** 2º `POST /reabrir` na mesma OP → **409** com a lista de transições permitidas, **sem** criar movimentação e **sem** mexer em saldo (foto antes/depois das movimentações e dos insumos conferida por igualdade profunda).
* **Ciclo completo (conclusão → estorno → conclusão → estorno):** cada ciclo devolve/baixa **exatamente** o que o anterior fez; o teste confere as **quatro** movimentações de insumo (`saida:20 · entrada:20 · saida:20 · entrada:20`) e as **quatro** de produto (`entrada(estornada) · saída · entrada(estornada) · saída`) — nada duplicado, nada faltando.
* **Estorno simultâneo:** §11 (B1/B2) — a segunda operação **não** duplica a reversão nem em saldo, nem em movimento, nem em insumo.
* **Mecanismo:** a idempotência **já existia** e foi **reutilizada** — o modelo de **líquido por insumo** e a marca `movimentacoes.estornado` para o produto acabado. Nenhum segundo mecanismo foi criado.

## 14. MULTIEMPRESA (§9 da especificação)

Cenário D (empresas A e B independentes, cada uma com insumo, produto, ficha, local e OP concluída própria):

* **B não alcança A**, por nenhuma porta: `GET /ordens/:id` → **404**; `GET /ordens/:id/eventos` → **404**; `GET /ordens/:id/apontamentos` → **404**; `POST /ordens/:id/reabrir` → **404**; `POST /ordens/:id/apontamentos` → **404**.
* **Estornar A não toca B**: OP, insumo (`992`), saldo (`4`) e movimentações de B **idênticos** antes/depois (comparação por igualdade profunda dos registros).
* **Vínculos respeitam `empresa_id`**, conferido no banco: `0` movimentações e `0` movimentações de insumo em que `empresa_id <> ordem.empresa_id`.
* O helper novo mantém o filtro por `empresa_id` em **todas** as leituras (`movimentacoes_insumos`, `insumos`) e recusa insumo de outra empresa com 404 — não abre caminho novo para vazamento.

## 15. IMPACTO E LIMITAÇÕES

**Impacto (raio de alcance):**

* `server/src/producao.ts` é o **único** arquivo de produção alterado. Os três consumidores do helper novo são internos do módulo (baixa de insumo, custo real, estorno); nada mais no repositório lê `movimentacoes_insumos` por `ordem_id`.
* **Sem reabertura, a matemática é idêntica à anterior** (Σ entradas = 0) — o custo real, o consumo e o estorno de uma OP que nunca foi reaberta produzem exatamente os mesmos números (a suíte inteira, memória e PostgreSQL, é a prova).
* Sem mudança de schema, de contrato de API, de menu, de RBAC, de frontend ou de payload. A única diferença visível ao operador é a **mensagem** do evento de reabertura (agora com perdas revertidas e custo real revertido).

**Limitações declaradas:**

1. **`prisma validate` não executado**: o CLI precisa baixar `schema-engine` de `binaries.prisma.sh`, fora da allow-list de rede deste sandbox. Nenhuma linha de schema/Prisma foi alterada no ciclo; quando houver rede, `npm run db:validate` deve ser rodado como parte do gate de CI.
2. **Modo demonstração não é prova** (P2-03/P2-06): a suíte de memória passava **antes e depois**; ela foi atualizada por paridade, mas a referência é o PostgreSQL.
3. **Custo em centavos:** a devolução de insumo usa `valor líquido ÷ quantidade líquida` arredondado a centavos; em consumo com custo médio variando entre lançamentos o resíduo máximo é de centavos por insumo (fica gravado no próprio lançamento compensatório).
4. **Leitura limitada por página:** `estornarOrdem`/`consumoLiquidoDaOrdem` leem até 1000/5000 movimentações da OP — o domínio produz ~1 movimentação por tamanho e por insumo, mas uma OP com mais de 1000 movimentações seria estornada **parcialmente em silêncio** (GAP-E02-02, §16).
5. **`dados` continua fora da API** (regra pré-existente): o `revertido` fica no banco para perícia; o operador vê a mensagem. Sem mudança de contrato.
6. Toda a prova desta rodada é **local** (PostgreSQL 16.2 embarcado). O CI oficial (`postgres:16`) roda a mesma suíte no PR — é ele que dá a leitura final de integração.

## 16. PROBLEMAS ENCONTRADOS FORA DO ESCOPO (registrados, **não** corrigidos)

| GAP | Descrição | Evidência | Por que não entrou |
|---|---|---|---|
| **GAP-E02-01** | `POST /api/movimentacoes_insumos` **não** atualiza `insumos.custo_medio` (só o recebimento de compra atualiza). A ficha usa `custo_medio` → uma OP cujo insumo só teve entrada manual consome a **R$ 0,00** e registra `custo_real` subestimado | No probe desta rodada: insumo cadastrado com `custo: 10`, entrada manual de 1000 @ 10 → `custo_real` da OP = **150** em vez de **390** (só mão de obra + indiretos). Nos testes, o caminho canônico (insumo com `custo_medio`) dá 390 | É comportamento de Estoque de Insumos/Compras (custo médio), não do estorno; corrigir aqui mexeria em outro domínio (proibido pelo §11 do ciclo) |
| **GAP-E02-02** | Leituras de movimentações da OP com `pageSize` fixo (1000 em `estornarOrdem`, 5000 no consumo) truncam **em silêncio** | Leitura de código + contagem de movimentações; não há teste de OP com > 1000 movimentações | Exige mudança de paginação em fluxo compartilhado; cenário improvável no domínio (1 mov./tamanho/insumo). Registrado para o ciclo de Estoque/Produção |
| **GAP-E02-03 (P3-07, já registrado)** | `adjustInsumoStock` usa o **mesmo padrão** `INSERT … ON CONFLICT (insumo_id) DO UPDATE` com delta negativo que causou o P0-01 — hoje não dispara porque `estoque_insumos.quantidade` **não tem** CHECK de não-negativo; se ganhar, o consumo de insumos quebra da mesma forma | Análise do padrão confirmada pelo teste F (o CHECK avalia o tuple proposto) | É decisão de schema de insumos, fora do estorno; mantido como risco documentado |
| **GAP-E02-04** | `auditoria.dados` e `ordens_eventos.dados` não são expostos na API (`memdb.decorate` os apaga) — a perícia exige consulta ao banco | Pré-existente, documentado no próprio código | Regra de segurança global, não do ERP-02 |

Nada disso bloqueia os gates do ciclo; todos ficam registrados em [`docs/ERP-GAPS.md`](ERP-GAPS.md) sem alteração de código.
