# RELATÓRIO P2-04 — Constraints PostgreSQL NOT VALID

Auditoria forense + correção cirúrgica. Repositório `petrickmsilva-alt/brobond-erp`,
base `main` (merge do PR #69 — P2-01 Audit Date → JSONB). Branch:
`audit/p2-04-not-valid-constraints`.

---

## 1. Executive Summary

O achado **P2-04** apontava a existência de constraints PostgreSQL marcadas
`NOT VALID`. O inventário real no catálogo (`pg_constraint.convalidated`) provou
**8 constraints CHECK NOT VALID**, todas em tabelas financeiras, nenhuma FK,
UNIQUE, PK ou EXCLUDE.

Investigação forense concluiu:

- **Causa-raiz**: as migrações `0011` e `0025` criaram os CHECKs com o padrão do
  projeto — `ADD CONSTRAINT ... NOT VALID` (protege toda escrita nova) seguido de
  `VALIDATE CONSTRAINT`. Nessas duas migrações **a VALIDATE foi esquecida**, então
  as constraints ficaram `NOT VALID` para sempre, inclusive em banco novo e vazio
  onde não há linha legada a adiar. É **artefato de migração**, não decisão de
  negócio.
- **Violações atuais**: **0** em todas as 8 regras (comprovado por query de
  diagnóstico equivalente a cada definição).
- **Reprodutibilidade**: as regras são válidas e continuam sendo a lei do
  negócio. O sistema **não** consegue mais produzir violação — com uma exceção
  de paridade, corrigida neste ciclo (ver §9/§17).
- **Decisão**: **A — VALIDAR AGORA** para as 8 (conjunto limpo). A migração
  valida condicionalmente e mantém `NOT VALID` **apenas** se houver violação
  legada comprovada, sem backfill heurístico.
- **Correção de dados**: nenhuma. Não havia dado inválido.
- **Defeito adicional encontrado (paridade MemStore × PostgreSQL)**: o MemStore
  aceitava `valor = 0` onde o PostgreSQL recusa (`23514`). Corrigido na camada de
  domínio para que os dois stores concordem.

Estado final: **8/8 constraints com `convalidated = true`**; **0 constraints NOT
VALID** em banco novo; regressão completa verde.

---

## 2. Finding original

> P2-04 — existem constraints PostgreSQL marcadas como NOT VALID.

O objetivo deste ciclo foi provar o estado real e transformar o achado em estado
comprovadamente seguro, sem "limpeza cosmética" de migrations.

---

## 3. Inventário de constraints

Inventário obtido por consulta direta ao catálogo (não por grep), em PostgreSQL
16.14, banco novo com todas as migrações aplicadas.

| Constraint | Table | Type | Definition | NOT VALID (antes) | Origem | Risk |
|---|---|---|---|---|---|---|
| `ck_lanc_fin_valor_positivo` | `lancamentos_financeiros` | CHECK | `valor > 0` | sim | `0011_financeiro_profissional.sql` | dinheiro com valor ≤ 0 |
| `ck_lanc_fin_taxa_pct` | `lancamentos_financeiros` | CHECK | `taxa_pct >= 0 AND taxa_pct < 100` | sim | `0011_financeiro_profissional.sql` | taxa fora de [0,100) |
| `ck_transf_fin_valor_positivo` | `transferencias_financeiras` | CHECK | `valor > 0` | sim | `0011_financeiro_profissional.sql` | transferência de valor ≤ 0 |
| `ck_transf_fin_contas_diferentes` | `transferencias_financeiras` | CHECK | `conta_origem_id <> conta_destino_id` | sim | `0011_financeiro_profissional.sql` | transferência para si mesma |
| `ck_gateway_cobrancas_valor` | `gateway_cobrancas` | CHECK | `valor > 0` | sim | `0025_p2_financeiro_gateways.sql` | cobrança de valor ≤ 0 |
| `ck_gateway_cobrancas_metodo` | `gateway_cobrancas` | CHECK | `metodo IN ('pix','boleto','cartao_credito','cartao_debito')` | sim | `0025_p2_financeiro_gateways.sql` | método fora do vocabulário |
| `ck_gateway_cobrancas_status` | `gateway_cobrancas` | CHECK | `status IN ('pendente','autorizada','paga','expirada','cancelada','estornada','falhou')` | sim | `0025_p2_financeiro_gateways.sql` | status fora do vocabulário |
| `ck_extrato_valor_positivo` | `fin_extrato_transacoes` | CHECK | `valor > 0` | sim | `0025_p2_financeiro_gateways.sql` | linha de extrato com valor ≤ 0 |

Query de inventário:

```sql
SELECT c.conname, c.conrelid::regclass AS tabela, c.contype,
       pg_get_constraintdef(c.oid) AS definicao, c.convalidated
  FROM pg_constraint c
  JOIN pg_namespace n ON n.oid = c.connamespace
 WHERE n.nspname = 'public' AND NOT c.convalidated
 ORDER BY 1;
```

Resultado **antes** da correção: 8 linhas, todas `contype = 'c'` (CHECK),
`convalidated = false`. Nenhuma FK/UNIQUE/PK/EXCLUDE NOT VALID.

---

## 4. Estado antes

```
conname                         | tabela                     | convalidated
--------------------------------+----------------------------+--------------
 ck_extrato_valor_positivo      | fin_extrato_transacoes     | f
 ck_gateway_cobrancas_metodo    | gateway_cobrancas          | f
 ck_gateway_cobrancas_status    | gateway_cobrancas          | f
 ck_gateway_cobrancas_valor     | gateway_cobrancas          | f
 ck_lanc_fin_taxa_pct           | lancamentos_financeiros    | f
 ck_lanc_fin_valor_positivo     | lancamentos_financeiros    | f
 ck_transf_fin_contas_diferentes| transferencias_financeiras | f
 ck_transf_fin_valor_positivo   | transferencias_financeiras | f
```

---

## 5. Origem / migrations

- `db/migrations/0011_financeiro_profissional.sql:71-81` — cria as 4 constraints
  de `lancamentos_financeiros` e `transferencias_financeiras` com `NOT VALID`.
  O comentário no arquivo declara a intenção: *"NOT VALID primeiro: valida linhas
  antigas…"*. **Não há `VALIDATE CONSTRAINT` no arquivo.**
- `db/migrations/0025_p2_financeiro_gateways.sql:74-83, 173-174` — cria as 4
  constraints de `gateway_cobrancas` e `fin_extrato_transacoes` com `NOT VALID`.
  **Não há `VALIDATE CONSTRAINT` no arquivo.**
- `db/schema.sql` espelhava o mesmo `NOT VALID` sem validação, então um banco
  novo (vazio) também nascia com as 8 `NOT VALID`.
- O padrão **correto** do projeto existe e está documentado em
  `0001_integridade_dominio.sql`, `0002_medidas_integridade.sql`,
  `0030_e42_locais_estoque_multempresa.sql`, `0031_e421_integridade_estoque.sql`:
  `ADD CONSTRAINT ... NOT VALID` → `VALIDATE CONSTRAINT` imediatamente. `0032`
  (`e423_expedicao_vocabulario`) faz a validação **condicional** (valida se
  limpo; mantém NOT VALID com `RAISE NOTICE` se houver legado incompatível).
- Não havia tentativa posterior de validar as 8. Nenhum comentário/documentação
  justificando a permanência em `NOT VALID`.

**Conclusão da origem**: omissão de `VALIDATE CONSTRAINT` em 0011/0025. O motivo
original ("validar linhas antigas") deixou de existir no momento em que os dados
ficaram limpos — e nunca valeu para banco novo.

---

## 6. Diagnóstico de violações

Para cada regra, query equivalente à definição da constraint (somente leitura).
Executadas em banco novo 16.14 com todas as migrações.

| Regra | Violações |
|---|---|
| `lancamentos_financeiros`: `NOT (valor > 0)` | **0** |
| `lancamentos_financeiros`: `NOT (taxa_pct >= 0 AND taxa_pct < 100)` | **0** |
| `transferencias_financeiras`: `NOT (valor > 0)` | **0** |
| `transferencias_financeiras`: `NOT (conta_origem_id <> conta_destino_id)` | **0** |
| `gateway_cobrancas`: `NOT (valor > 0)` | **0** |
| `gateway_cobrancas`: `NOT (metodo IN (...))` | **0** |
| `gateway_cobrancas`: `NOT (status IN (...))` | **0** |
| `fin_extrato_transacoes`: `NOT (valor > 0)` | **0** |

Nenhum registro órfão, nenhuma duplicidade, nenhum dado fora de faixa.

---

## 7. Queries utilizadas

Diagnóstico (usado dentro da migração, somente leitura):

```sql
SELECT COUNT(*) FROM lancamentos_financeiros   WHERE NOT (valor > 0);
SELECT COUNT(*) FROM lancamentos_financeiros   WHERE NOT (taxa_pct >= 0 AND taxa_pct < 100);
SELECT COUNT(*) FROM transferencias_financeiras WHERE NOT (valor > 0);
SELECT COUNT(*) FROM transferencias_financeiras WHERE NOT (conta_origem_id <> conta_destino_id);
SELECT COUNT(*) FROM gateway_cobrancas          WHERE NOT (valor > 0);
SELECT COUNT(*) FROM gateway_cobrancas          WHERE NOT (metodo IN ('pix','boleto','cartao_credito','cartao_debito'));
SELECT COUNT(*) FROM gateway_cobrancas          WHERE NOT (status IN ('pendente','autorizada','paga','expirada','cancelada','estornada','falhou'));
SELECT COUNT(*) FROM fin_extrato_transacoes     WHERE NOT (valor > 0);
```

Verificação final:

```sql
SELECT count(*) FROM pg_constraint
 WHERE NOT convalidated AND connamespace = 'public'::regnamespace;  -- esperado 0
```

---

## 8. Resultados

- Violações: **0** em todas as 8 regras.
- Nenhum dado inválido, portanto **nenhuma correção de dados foi necessária**.
- As regras continuam sendo regra de negócio válida (dinheiro > 0, taxa < 100%,
  contas distintas, vocabulário canônico do gateway).

---

## 9. Multi-company analysis

Separando rigorosamente **(A) violação da constraint PostgreSQL** de
**(B) violação de regra multi-company**:

- **(A)** Nenhuma das 8 constraints é tenant-scoped. São regras de valor/faixa/
  vocabulário; nenhuma envolve `empresa_id` do filho × do pai. Não há
  possibilidade de "FK satisfeita porém cross-tenant" porque **nenhuma das 8 é
  FK**.
- **(B)** O isolamento por empresa é garantido por outro conjunto de artefatos
  (triggers de herança de empresa, índices únicos por empresa, recorte no SQL —
  provados nos testes MULTIEMPRESA existentes do job PG). Este ciclo **não**
  alterou esse mecanismo.
- Verificação adicional: o recorte multi-company continua verde (ver §17 e o job
  PG completo: `MULTIEMPRESA em Postgres real`, `ERP-03 A/B`, `E2/E3 multiempresa`).

Classificação: **não há violação multi-company introduzida nem existente**
associada ao P2-04.

---

## 10. Histórico vs reproduzível

| Regra | Ainda pode ser criada hoje? | Classificação |
|---|---|---|
| `lancamentos_financeiros.valor > 0` | **Não** no PG (CHECK + validação app). No MemStore **sim, até este ciclo** (ver §17) | **Reproduzível (paridade) — corrigido** |
| `lancamentos_financeiros.taxa_pct` | Não (app + CHECK) | Histórica (sem violação) |
| `transferencias_financeiras.valor > 0` | Não (app + CHECK) | Histórica |
| `transferencias_financeiras.contas diferentes` | Não (guard app + CHECK) | Histórica |
| `gateway_cobrancas.*` | Não (vocabulário no app + CHECK) | Histórica |
| `fin_extrato_transacoes.valor > 0` | Não (parser descarta `valor <= 0`) | Histórica |

A única reprodução real no estado atual era a **divergência MemStore ×
PostgreSQL** em `valor = 0` (aceito em memória, recusado no banco). Provada e
corrigida neste ciclo.

---

## 11. Decisão por constraint

Todas na categoria **A — VALIDAR AGORA** (sem violações; validação segura;
constraint necessária).

---

### CONSTRAINT: `ck_lanc_fin_valor_positivo`
- **TABLE**: `lancamentos_financeiros`
- **TYPE**: CHECK
- **DEFINITION**: `valor > 0`
- **BEFORE**: `convalidated = false`
- **VIOLATIONS**: 0
- **ROOT CAUSE**: `0011` criou `NOT VALID` e nunca executou `VALIDATE`.
- **CURRENTLY REPRODUCIBLE**: não no PostgreSQL; sim no MemStore (paridade) — corrigido.
- **MULTI-COMPANY IMPACT**: nenhum (regra não é tenant-scoped).
- **DECISION**: **A — VALIDAR AGORA**.
- **AFTER**: `convalidated = true`.
- **EVIDENCE**: §4 vs §19; teste `P2-04 validity`.

### CONSTRAINT: `ck_lanc_fin_taxa_pct`
- **TABLE**: `lancamentos_financeiros`
- **TYPE**: CHECK
- **DEFINITION**: `taxa_pct >= 0 AND taxa_pct < 100`
- **BEFORE**: `false` · **VIOLATIONS**: 0
- **ROOT CAUSE**: `0011` sem `VALIDATE`.
- **CURRENTLY REPRODUCIBLE**: não (`hookTaxaLancamento` limita; app recusa 150).
- **MULTI-COMPANY IMPACT**: nenhum.
- **DECISION**: **A — VALIDAR AGORA** · **AFTER**: `true`.
- **EVIDENCE**: §19; teste `P2-04 violação` (taxa 100 → 23514).

### CONSTRAINT: `ck_transf_fin_valor_positivo`
- **TABLE**: `transferencias_financeiras`
- **TYPE**: CHECK · **DEFINITION**: `valor > 0`
- **BEFORE**: `false` · **VIOLATIONS**: 0
- **ROOT CAUSE**: `0011` sem `VALIDATE`.
- **CURRENTLY REPRODUCIBLE**: não (guard app + recurso `min`).
- **MULTI-COMPANY IMPACT**: nenhum.
- **DECISION**: **A — VALIDAR AGORA** · **AFTER**: `true`.
- **EVIDENCE**: §19; teste `P2-04 violação` (transferência valor 0 → 23514).

### CONSTRAINT: `ck_transf_fin_contas_diferentes`
- **TABLE**: `transferencias_financeiras`
- **TYPE**: CHECK · **DEFINITION**: `conta_origem_id <> conta_destino_id`
- **BEFORE**: `false` · **VIOLATIONS**: 0
- **ROOT CAUSE**: `0011` sem `VALIDATE`.
- **CURRENTLY REPRODUCIBLE**: não (`services.ts` recusa contas iguais).
- **MULTI-COMPANY IMPACT**: nenhum.
- **DECISION**: **A — VALIDAR AGORA** · **AFTER**: `true`.
- **EVIDENCE**: §19; teste `P2-04 violação` (origem = destino → 23514).

### CONSTRAINT: `ck_gateway_cobrancas_valor`
- **TABLE**: `gateway_cobrancas`
- **TYPE**: CHECK · **DEFINITION**: `valor > 0`
- **BEFORE**: `false` · **VIOLATIONS**: 0
- **ROOT CAUSE**: `0025` sem `VALIDATE`.
- **CURRENTLY REPRODUCIBLE**: não.
- **MULTI-COMPANY IMPACT**: nenhum.
- **DECISION**: **A — VALIDAR AGORA** · **AFTER**: `true`.
- **EVIDENCE**: §19; teste `P2-04 violação`.

### CONSTRAINT: `ck_gateway_cobrancas_metodo`
- **TABLE**: `gateway_cobrancas`
- **TYPE**: CHECK · **DEFINITION**: `metodo IN ('pix','boleto','cartao_credito','cartao_debito')`
- **BEFORE**: `false` · **VIOLATIONS**: 0
- **ROOT CAUSE**: `0025` sem `VALIDATE`.
- **CURRENTLY REPRODUCIBLE**: não.
- **MULTI-COMPANY IMPACT**: nenhum.
- **DECISION**: **A — VALIDAR AGORA** · **AFTER**: `true`.
- **EVIDENCE**: §19; teste `P2-04 violação` (`cheque` → 23514).

### CONSTRAINT: `ck_gateway_cobrancas_status`
- **TABLE**: `gateway_cobrancas`
- **TYPE**: CHECK · **DEFINITION**: `status IN ('pendente','autorizada','paga','expirada','cancelada','estornada','falhou')`
- **BEFORE**: `false` · **VIOLATIONS**: 0
- **ROOT CAUSE**: `0025` sem `VALIDATE`.
- **CURRENTLY REPRODUCIBLE**: não.
- **MULTI-COMPANY IMPACT**: nenhum.
- **DECISION**: **A — VALIDAR AGORA** · **AFTER**: `true`.
- **EVIDENCE**: §19; teste `P2-04 violação`.

### CONSTRAINT: `ck_extrato_valor_positivo`
- **TABLE**: `fin_extrato_transacoes`
- **TYPE**: CHECK · **DEFINITION**: `valor > 0`
- **BEFORE**: `false` · **VIOLATIONS**: 0
- **ROOT CAUSE**: `0025` sem `VALIDATE`.
- **CURRENTLY REPRODUCIBLE**: não (`parseLinhasExtrato` descarta `valor <= 0`).
- **MULTI-COMPANY IMPACT**: nenhum.
- **DECISION**: **A — VALIDAR AGORA** · **AFTER**: `true`.
- **EVIDENCE**: §19; teste `P2-04 violação`.

---

## 12. Implementação

Arquivos alterados/criados:

1. **`db/migrations/0035_p2_04_not_valid_constraints.sql`** (novo)
   - Diagnóstico somente leitura (contagem de violações por regra).
   - `VALIDATE CONSTRAINT` condicional: valida quando o conjunto está limpo;
     mantém `NOT VALID` (com `RAISE NOTICE`) se houver violação legada.
   - `COMMENT ON CONSTRAINT` documentando a política.
   - Idempotente: reexecução em banco já validado não faz nada.

2. **`db/schema.sql`** (bootstrap espelhado)
   - Bloco `gateway_cobrancas`: `ADD ... NOT VALID` seguido de validação
     condicional (antes: `NOT VALID` sem validação).
   - Bloco `fin_extrato_transacoes`: idem.
   - Garante que **banco novo** sobe com as 8 validadas, fechando a porta para
     reintrodução do achado pelo caminho de bootstrap.

3. **`server/src/resources.ts`**
   - `valor` de `lancamentos_financeiros`, `aportes`,
     `recorrencias_financeiras` e `transferencias_financeiras`:
     `min: 0` → `min: 0.01` (paridade com `valor > 0` do banco).

4. **`server/src/financeiro.ts`**
   - `criarLancamento`: guarda `valor > 0` (caminho automático que insere direto
     no store, sem `validatePayload`).
   - `processarRecorrencias`: pula recorrência com `valor <= 0` (determinístico;
     não aborta a geração das demais).

5. **Testes**
   - `server/test/pg/p2-04-not-valid-constraints.test.ts` (8 provas PG reais).
   - `server/test/p204-paridade.test.ts` (6 provas de paridade MemStore).

---

## 13. Migration(s)

`0035_p2_04_not_valid_constraints.sql` — determinística, idempotente,
PostgreSQL 16, compatível com o runner versionado (`schema_migrations`, ordem
léxica, uma transação por arquivo). Não faz `VALIDATE` cego: mede violações antes.
Nenhum `DELETE`/`UPDATE`; nenhum backfill.

---

## 14. Impacto / lock / performance

- Tabelas envolvidas (banco novo 16.14): `lancamentos_financeiros` (168 kB),
  `gateway_cobrancas` (104 kB), `transferencias_financeiras` (96 kB),
  `fin_extrato_transacoes` (80 kB) — todas pequenas.
- `VALIDATE CONSTRAINT` faz um `ACCESS EXCLUSIVE` **curto**, apenas o tempo do
  scan da tabela para conferir a regra; como o conjunto está limpo e as tabelas
  são pequenas, a janela é de milissegundos.
- O `ADD CONSTRAINT ... NOT VALID` (já existente) é o passo barato; a novidade é
  a validação, que ocorre **uma vez** por banco.
- Impacto sobre vendas/estoque/financeiro/produção: **nulo** — nenhuma tabela
  desses domínios é tocada, e nenhum dado é alterado.
- Deploy: roda dentro do advisory lock de bootstrap já existente; boots
  simultâneos ficam serializados.

---

## 15. Testes adversariais

`server/test/pg/p2-04-not-valid-constraints.test.ts` (PostgreSQL real):

- `lancamentos_financeiros.valor = 0` → **23514**.
- `lancamentos_financeiros.valor < 0` → **23514**.
- `lancamentos_financeiros.taxa_pct = 100` → **23514**.
- `transferencias_financeiras.valor = 0` → **23514**.
- `transferencias_financeiras` origem = destino → **23514**.
- `gateway_cobrancas.valor = 0` → **23514**.
- `gateway_cobrancas.metodo = 'cheque'` → **23514**.
- `gateway_cobrancas.status = 'inexistente'` → **23514**.
- `fin_extrato_transacoes.valor = 0` → **23514**.
- FK órfã (`conta_id` inexistente) → **23503**.
- Reexecução da migração 0035 → não regride para `NOT VALID`.

---

## 16. PostgreSQL real

- Versão: **PostgreSQL 16.14** (`server_version_num = 160014`).
- Banco fresco criado por execução; `test:pg` exige banco vazio (preflight
  `ERP-03`).
- Fluxo: banco fresco → migrações → inventário `pg_constraint` → validação →
  testes adversariais → testes funcionais → verificação final de `convalidated`.
- Verificação final por SQL: **0 constraints NOT VALID** em `public`.
- Prova do ramo "sujo" (legado): banco com linha `valor = -5` e constraint
  `NOT VALID` → a migração **mantém NOT VALID**, **preserva a linha** (sem
  backfill) e valida as outras 7 limpas.

---

## 17. MemStore parity

Defeito encontrado e corrigido neste ciclo:

- **Antes**: `MemStore` aceitava `valor = 0` em `lancamentos_financeiros`,
  `aportes` e `recorrencias_financeiras`; `PostgreSQL` recusava (`23514`).
  Divergência `MemStore = aceita / PostgreSQL = rejeita`.
- **Causa**: recurso declarava `min: 0` (permite 0) enquanto o banco exige
  `valor > 0`; e os ganchos automáticos inseriam direto no store, sem validação.
- **Correção**: `min: 0.01` nos quatro recursos de valor + guarda `valor > 0` em
  `criarLancamento` + skip determinístico em `processarRecorrencias`.
- **Depois**: os dois stores recusam `valor = 0` de forma idêntica (400 no app,
  23514 no banco). Nenhuma razão arquitetural para divergir — o banco é a
  autoridade de integridade persistente.

`fin_extrato_transacoes` já tinha paridade (parser descarta `valor <= 0`).

---

## 18. Regressão

| Gate | Resultado |
|---|---|
| `server` test (memória) | **821 pass, 0 fail** (66 skip preexistentes) |
| `client` test | **323 pass, 0 fail** |
| PG completo (`test/pg-*.test.ts` + `test/pg/*.test.ts`) | **209 pass, 0 fail, 0 skip** |
| `typecheck` server | OK |
| `typecheck` client | OK |
| `typecheck:domain` | OK |
| `lint` | **0 errors** (409 warnings preexistentes) |
| `build` (front) | OK |
| `smoke` (modo demonstração) | **126/126 OK** |
| `audit:menu` | ✅ sem erros |
| `prisma validate` | (ver CI; sem mudança de schema Prisma) |

Nenhum teste flaky observado. O único gate que reportou `BLOCKED` foi o wrapper
`scripts/test-pg-gate.mjs`, por **mismatch de reporter** (Node 24 local emite
`ℹ` onde o gate espera o formato TAP `#`, do Node 22 usado no CI) — não é falha
de teste: o runner terminou com `209 pass / 0 fail / 0 skip`. Rodando com
`--test-reporter=tap`, os marcadores `# pass/# fail/# skipped` batem. Achado
**fora de escopo** (§22).

---

## 19. Estado final

```
conname                         | tabela                     | convalidated
--------------------------------+----------------------------+--------------
 ck_extrato_valor_positivo      | fin_extrato_transacoes     | t
 ck_gateway_cobrancas_metodo    | gateway_cobrancas          | t
 ck_gateway_cobrancas_status    | gateway_cobrancas          | t
 ck_gateway_cobrancas_valor     | gateway_cobrancas          | t
 ck_lanc_fin_taxa_pct           | lancamentos_financeiros    | t
 ck_lanc_fin_valor_positivo     | lancamentos_financeiros    | t
 ck_transf_fin_contas_diferentes| transferencias_financeiras | t
 ck_transf_fin_valor_positivo   | transferencias_financeiras | t
```

`SELECT count(*) FROM pg_constraint WHERE NOT convalidated AND connamespace =
'public'::regnamespace;` → **0**.

---

## 20. Evidências

- Inventário antes/depois: §4 e §19 (catálogo `pg_constraint`).
- Diagnóstico de violações: §6/§7 (contagens 0).
- Testes PG reais: `server/test/pg/p2-04-not-valid-constraints.test.ts`
  (8 provas, todas verdes).
- Paridade memória: `server/test/p204-paridade.test.ts` (6 provas verdes).
- Ramo "sujo" (legado preservado, sem backfill): §16.
- Regressão completa: §18.

---

## 21. Riscos residuais

- Se um ambiente legado real contiver linhas violando alguma das 8 regras, a
  constraint correspondente **permanecerá NOT VALID** (por desenho) até decisão
  de negócio. A migração emite `RAISE NOTICE` com a contagem para tornar o
  problema visível. Nenhuma correção especulativa é aplicada.
- O gate `scripts/test-pg-gate.mjs` depende do formato TAP (Node 22). Em
  ambientes com Node ≥ 24 ele reporta `BLOCKED` sem falha real — mitigar é fora
  do escopo deste ciclo.

---

## 22. Achados fora de escopo

1. **Reporter do gate PG**: `scripts/test-pg-gate.mjs` casa o formato TAP
   (`# pass`); o reporter padrão do Node 24 usa `ℹ pass`. Não corrigido (não é
   P2-04). Rodando com `--test-reporter=tap` o gate funciona como esperado.
2. **E4.2.3 / 0032** (`expedicao_eventos_etapa_valida`) mantém o padrão de
   validação condicional por design — coerente, não alterado.
3. Demais achados do FULL FORENSIC AUDIT (SEC-01..04, FIN-01, P2 advisory lock,
   CORS, fiscal, marketplace, etc.) **não** foram tocados.

---

## 23. Conclusão P2-04

O achado era **real mas benigno no estado atual**: 8 constraints CHECK criadas
`NOT VALID` e nunca validadas, por omissão de `VALIDATE CONSTRAINT` nas
migrações `0011` e `0025`. Não havia violação de dados, corrupção ou
vulnerabilidade. A correção validou as 8 de forma condicional e idempotente,
fechou a porta de reintrodução no bootstrap e — durante a investigação —
expôs e corrigiu uma divergência real de paridade MemStore × PostgreSQL
(`valor = 0`), hoje idêntica nos dois stores. Estado final comprovado por SQL:
**0 constraints NOT VALID**, regressão completa verde.

**Veredito: GO.**
