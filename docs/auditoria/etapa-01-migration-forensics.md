# ETAPA 01 — MIGRATION FORENSICS (P0)

**Data:** 2026-11-14 · **Branch:** `arena/20369110-brobond-erp` · **HEAD inicial:** `774233253f2b1ced204741cba8d2ecb1ba734be0`
**Método:** leitura do runner/gates + reprodução em PostgreSQL 16.14 real (bancos descartáveis isolados).

## 1. Diagnóstico

### Sequência real
- `db/migrations/`: **122 arquivos** `.sql`, prefixos `0001`–`0121`.
- Duplicidade: prefixo `0121` com DOIS arquivos:
  - `0121_operational_control_plane.sql` (Control Plane + OAuth 2.1);
  - `0121_perf_busca_trigram_e_listagens.sql` (PR #136 — pg_trgm + 5 índices GIN).
- Ambos entraram no único commit visível do histórico local (`7742332`, squash do PR #136); o histórico granular anterior não está disponível neste clone. Os cabeçalhos e `AGENTS.md` documentam os dois como trabalhos independentes mesclados a partir da mesma base — causa raiz: **dois PRs paralelos escolheram o mesmo próximo número**.

### Identidade no runner (fonte: `server/src/db.ts`, `aplicarMigrationsVersionadas`)
- Identidade = **nome completo do arquivo** (`schema_migrations.id TEXT PRIMARY KEY`).
- Ordem = **lexical** sobre o nome inteiro (`.sort()`): `0121_operational…` < `0121_perf…`, determinística em qualquer ambiente.
- Registro = INSERT do nome completo na MESMA transação do DDL; falha → ROLLBACK → retry reexecuta; sucesso nunca reaplica.
- **Prefixo não é chave** — é apenas convenção de ordenação.

### Onde a duplicidade doía
- `scripts/final-go-live-audit.ts` exigia `prefixo == posição + 1` (modelo "número único por arquivo" que o runner não usa) → `MIGRATION_SEQUENCIA P0` para `0121_perf…`.
- O runner **não** falha com a duplicidade; o auditor é que usava critério incoerente com o runner.
- `architecture:audit` conta arquivos (122) sem validar sequência; `gerar-bootstrap.mjs` não depende de numeração; `schema.sql`/`bootstrap.sql` não referenciam números de migration na estrutura (o corte do bootstrap é por marcador de seção, não por número).

## 2. Reprodução em banco de teste isolado (PostgreSQL 16.14)

Executado via harness de bancos descartáveis (`server/test/pg/_boot-harness.ts`) e script forense dedicado:

| Cenário | Resultado observado |
|---|---|
| C1 — banco novo, boot completo | 122 migrations aplicadas; os dois `0121` registrados pelo nome completo, `operational` antes de `perf` |
| C2 — segundo boot no mesmo banco | 0 reaplicações (todos os `aplicado_em` intactos) |
| C3 — banco legado (cadeia até `0121_operational`) + boot atual | aplica SOMENTE `0121_perf…`; nenhum registro antigo tocado |
| C4 — rename `0121_perf` → `0122` SEM reconciliação | **REAPLICA** sob o nome novo (nome novo não está em `schema_migrations`) |
| C5 — rename COM reconciliação prévia (`INSERT … SELECT id novo WHERE id antigo`, mesma transação) | 0 reaplicações — caminho seguro comprovado |

Regressão permanente: `server/test/pg/prod-db-04-identidade-migrations.test.ts` (cenários a–e, executado: **3/3 pass** em PG 16.14) e `server/test/migrations-identidade.test.ts` (**8/8 pass**).

## 3. Risco de reaplicação

- **Manter os nomes (opção escolhida): risco ZERO.** A identidade é o nome completo; ambos já aplicam exatamente uma vez em qualquer ambiente, novo ou legado.
- **Renomear sem reconciliação: risco REAL de reaplicação.** A migration perf é idempotente (`CREATE INDEX IF NOT EXISTS`), mas a regra da cadeia é "nunca reaplicar"; além disso o padrão se aplicaria a migrations futuras não idempotentes. C4 comprovou o comportamento.

## 4. Correção implementada (segura sem evidência de produção)

1. **`scripts/migrations-identidade.ts`** (novo): fonte única do critério de sequência, alinhada ao runner:
   - prefixos distintos contíguos a partir de `0001` (buraco = P0);
   - duplicidade de prefixo = P0, EXCETO o conjunto exato registrado em `COLISOES_HISTORICAS` (0121), reportado como P2 com plano de reconciliação — nunca silenciado;
   - registro histórico exige igualdade exata com o disco (rename/terceiro arquivo no prefixo quebra o gate e o teste).
2. **`scripts/final-go-live-audit.ts`**: seção 5 passa a usar `auditarSequenciaMigrations` (mesmo modelo de identidade do runner).
3. **Testes de regressão** (acima): gate não foi afrouxado — duplicidade nova continua P0.
4. **Nenhum arquivo de migration foi renomeado; nenhum DDL/DML em produção.**

## 5. Plano de reconciliação (futura, autorizada)

**BLOQUEADO — EVIDÊNCIA DE PRODUÇÃO INDISPONÍVEL** para o passo (a):

a. Consulta READ-ONLY autorizada em produção: `SELECT id FROM schema_migrations WHERE id LIKE '0121%'`.
b. Se `0121_perf…` registrada: migration aditiva de reconciliação (`INSERT INTO schema_migrations (id, aplicado_em) SELECT '0122_perf…', aplicado_em … WHERE id='0121_perf…' ON CONFLICT DO NOTHING`) publicada ANTES/junto do rename do arquivo; remover entrada de `COLISOES_HISTORICAS`.
c. Se NÃO registrada: rename simples é seguro.
d. Em qualquer hipótese, validar com `prod-db-04` antes do merge.

Enquanto (a) não ocorrer, a colisão permanece registrada e visível (P2) no gate.

## 6. Critério de aceite

- ✅ Nenhuma migration reaplicada indevidamente (C2/C3/C5; teste PG permanente).
- ✅ Runner, inventário e gate com critérios coerentes de identidade (nome completo) e sequência (prefixos distintos contíguos; colisão histórica explícita).
- ✅ Gate continua reprovando duplicidade nova, buraco e nome inválido (testes unitários).
- ⚠️ Ressalva: numeração permanece com colisão histórica até reconciliação autorizada com evidência de produção.
