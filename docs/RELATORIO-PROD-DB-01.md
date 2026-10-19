# RELATÓRIO PROD-DB-01 — Sincronização do schema do banco de produção

Diagnóstico e correção da divergência entre o banco PostgreSQL de produção
(Render) e o código atual. Base: `main`. Branch: `fix/prod-db-01-schema-sync`.

---

## 1. Sintoma observado

Em produção (`https://brobond-erp.onrender.com`), a tela `/vendas` responde:

> Coluna "t.local_saida_id" não encontrada no banco. Execute db/schema.sql para migrar.

O código do repositório já possui a coluna:

- `db/migrations/0031_e421_integridade_estoque.sql` →
  `ALTER TABLE vendas ADD COLUMN IF NOT EXISTS local_saida_id INTEGER;`
- `db/schema.sql:3998` → o mesmo `ADD COLUMN IF NOT EXISTS`.
- O backend usa a coluna no recurso `vendas` (`resources.ts:1660`).

O erro é a tradução do SQLSTATE `42703` (undefined_column) em
`server/src/pgstore.ts:172`. Classificação: **CONFIRMED**.

---

## 2. Causa raiz

O bootstrap do banco (`server/src/db.ts → migrate()`) aplicava, na mesma
sessão e **antes** das migrações versionadas:

```ts
await lockClient.query(sql);            // db/schema.sql inteiro
await aplicarMigrationsVersionadas(lockClient);
```

O driver `pg` executa um arquivo com vários comandos como **uma única transação
implícita**: se qualquer comando falhar, TODO o lote volta atrás — inclusive os
`ADD COLUMN` que já tinham "passado". O `db/schema.sql` contém **preflights que
recusam dados legados**, p.ex. a E4.2:

```sql
IF duplicatas_locais + ... > 0 THEN
  RAISE EXCEPTION 'E4.2 preflight bloqueou o DDL: ...';
END IF;
```

Se o banco de produção tem qualquer dado legado que o preflight recusa (dois
locais com o mesmo nome na mesma empresa, saldo com produto inexistente, vínculo
de outra empresa etc.), o `lockClient.query(sql)` **lança**, o
`aplicarMigrationsVersionadas` logo abaixo **nunca é alcançado** e o banco fica
**congelado no estado antigo**. Foi assim que a cadeia versionada (incl. 0031)
nunca rodou e a coluna `vendas.local_saida_id` nunca foi criada.

O `index.ts` ainda engolia o erro (`catch { console.error(...) }`), então o
serviço subia parecendo normal.

**Confirmação independente pelo endpoint público de saúde:**

```
GET https://brobond-erp.onrender.com/api/health
{"ok":true,"db":"memory","uploads":"db","version":"0.6.0"}
```

`db:"memory"` significa `isDbConnected() === false`, isto é, `ready` nunca foi
marcado — exatamente o efeito de `migrate()` ter lançado. Ao mesmo tempo o pool
existe (`hasDatabaseUrl()`), então o `PgStore` é usado: as consultas vão ao
Postgres real e falham em 42703. **Produção está com o banco de dados pela
metade em relação ao código.**

Classificação: **CONFIRMED**.

---

## 3. Estado do banco antes

Sem acesso ao `DATABASE_URL` de produção neste ambiente (nenhuma credencial
Render/Neon exposta; a instrução permite diagnóstico somente se houver acesso
autorizado). O estado foi reconstruído por:

1. leitura do mecanismo (`db.ts`, `index.ts`, `render.yaml`);
2. **reprodução em PostgreSQL real** do estado "produção atrás".

Estado reproduzido (e, por inferência, o de produção):

| Objeto | Esperado no `main` | Em produção (inferido/reproduzido) |
|---|---|---|
| `vendas.local_saida_id` | existe | **ausente** |
| FK `fk_e421_vendas_empresa_local_saida` | existe | ausente |
| índice `e421_vendas_empresa_local_saida_idx` | existe | ausente |
| migrações ≥ 0031 registradas em `schema_migrations` | sim | **não** |
| `db/schema.sql` integral | aplicado | **abortado por preflight** |

Classificação: **PROBABLE** (mecanismo CONFIRMED + reprodução CONFIRMED; o
conteúdo exato do banco de produção não foi inspecionado por falta de acesso).

---

## 4. Migrations faltantes

A cadeia versionada roda em ordem léxica, uma vez por banco. Como ela **nunca
executou**, todas as migrações que dependem de a cadeia estar ativa ficaram
pendentes. Na reprodução, `SELECT count(*) FROM schema_migrations WHERE id >=
'0031'` retornou **0** antes e **5** depois da correção (0031–0035).

Objeto concreto quebrado: **`vendas.local_saida_id` + FK + índice (0031)**.
Demais objetos posteriores só não apareciam porque a cadeia estava parada no
mesmo ponto.

---

## 5. Comparação schema × produção

A matriz é a da seção 3. Não foi possível enumerar cada tabela/índice/trigger do
banco real (sem acesso). O que se prova por reprodução é a **classe** do
problema: qualquer objeto introduzido pela cadeia versionada após o ponto de
falha está ausente. Por isso a correção ataca o **mecanismo**, não apenas a
coluna — ver seção 6.

---

## 6. Correção aplicada

**Não** foi criada migração paralela nem duplicado o `ADD COLUMN`. A migração
oficial (`0031`) já existe e é idempotente. A correção foi no **mecanismo de
bootstrap** (`server/src/db.ts`):

```ts
try {
  await lockClient.query(sql);          // bootstrap do schema.sql
} catch (e) {
  bootstrapError = e;                   // não aborta o boot
}
// SEMPRE roda: a cadeia versionada é a autoridade para bancos existentes e não
// pode ser bloqueada por um preflight de dado legado.
await aplicarMigrationsVersionadas(lockClient);   // erro aqui CONTINUA fatal
...
if (bootstrapError) {
  console.error('⚠️  db/schema.sql não pôde ser aplicado por inteiro ... Causa: ...');
  return;                                // sem `ready = true`
}
ready = true;
```

Decisões de segurança embutidas:

- **Migração falha = fatal** (inalterado): o serviço não sobe com a cadeia pela
  metade; o `throw` continua.
- **Falha do schema.sql = não-fatal e visível**: as migrações versionadas são
  aplicadas mesmo assim, o erro é logado com a causa e `ready` **não** é
  marcado — `isDbConnected()` continua `false`, `/api/health` reporta
  `db:"memory"` e o gate PostgreSQL não aceita esse estado como aprovado.
  Nada é "escondido".
- **Nenhum dado é alterado.** Não há `UPDATE`/`DELETE`/backfill; o preflight
  continua recusando o DDL e os dados legados ficam intactos.

Observação: **não** se executou `db/schema.sql` cegamente contra produção. A
correção apenas garante que a **cadeia versionada idempotente** chegue ao banco
existente — que é o objetivo. O `schema.sql` continua sendo espelho/bootstrap,
aplicado em bancos novos; em banco legado ele pode continuar bloqueado até o
dado ser corrigido, sem impedir as migrações.

Classificação: **VERIFIED SAFE** (ver seção 11).

---

## 7. Mecanismo de deploy atual

`render.yaml`:

```yaml
buildCommand: npm install --include=dev && npm run build
startCommand: npm --workspace server start     # = tsx src/index.ts
```

- **Não existe etapa de migration no deploy.** O deploy só sobe o processo.
- A sincronização do banco acontece **no boot da aplicação** (`start()` →
  `migrate()`), que aplica `db/schema.sql` + `db/migrations/*.sql`.
- `DATABASE_URL` é configurada manualmente no painel (`sync: false`), apontando
  para um Postgres permanente (Neon).
- Não há `prisma migrate deploy` no boot do ERP operacional; Prisma é usado para
  validação de schema (`prisma validate`), não como runner do banco do ERP.

O mecanismo **existia** (runner versionado com `schema_migrations`), mas estava
**bloqueado** pela ordem de execução descrita na seção 2.

---

## 8. Risco de recorrência

**Alto antes da correção**, por dois motivos independentes:

1. o runner versionado só rodava se o `schema.sql` inteiro passasse;
2. o erro do `migrate()` era engolido no `index.ts`, mascarando a falha.

**Baixo depois da correção**: a cadeia versionada é independente do resultado do
`schema.sql`, e qualquer falha do `schema.sql` é logada com a causa exata
(incluindo a contagem de duplicatas do preflight) e mantém `db:"memory"` visível
no health — o estado degradado deixa de ser silencioso.

---

## 9. Alteração feita no deploy

**Nenhuma** alteração em `render.yaml` ou no comando de start foi necessária. O
mecanismo de migration próprio já existia; corrigiu-se o mecanismo (seção 6) em
vez de criar outro — conforme a instrução. Não foi adicionado `schema.sql` a cada
boot, nem duplicação de migrations, nem bloqueio de boot sem necessidade.

---

## 10. Testes executados

Novo teste (PostgreSQL real, `server/test/pg/prod-db-01-schema-sync.test.ts`):

1. **estado inicial**: após `migrate()`, `vendas.local_saida_id` existe;
2. **cenário "produção atrás"**: `DROP COLUMN local_saida_id`, limpa
   `schema_migrations >= 0031` e insere dois locais homônimos na mesma empresa
   (o que o preflight da E4.2 recusa);
3. **reproduz o sintoma**: `GET /api/vendas` → **HTTP 500** com
   `Coluna "t.local_saida_id" não encontrada no banco…` (o erro real de
   produção);
4. **aplica o mecanismo corrigido**: `migrate()` não lança e cria a coluna via
   cadeia versionada, mesmo com o `schema.sql` bloqueado;
5. **confirma a FK composta** `fk_e421_vendas_empresa_local_saida`;
6. **rota volta**: `GET /api/vendas` → **HTTP 200**;
7. **venda real**: cria produto + cliente + venda (201) e lê de volta (200);
8. **multiempresa**: `local_saida_id` de **outra** empresa é recusado (23503);
   local da **própria** empresa é aceito.

Evidência registrada pelo teste:

```
- estado inicial: vendas.local_saida_id EXISTE; migrações >= 0031 = 5
- cenário montado: local_saida_id AUSENTE; migrações >= 0031 = 0; locais homônimos = 2
- GET /api/vendas antes: HTTP 500 — "Coluna "t.local_saida_id" não encontrada no banco. Execute db/schema.sql para migrar.…"
- após migrate(): local_saida_id EXISTE; migrações >= 0031 = 5
- GET /api/vendas depois: HTTP 200
- venda criada e lida: id=1, HTTP 201/200
- multiempresa: local de outra empresa recusado (23503); local da própria empresa aceito
```

Regressão completa (seção 18 do formato): server 821/0, client 323/0, PG 210/0,
typecheck/lint/build/smoke/audit:menu verdes.

---

## 11. Prova da correção

- **Antes** (reprodução, `migrate()` antigo): `vendas.local_saida_id=MISSING`,
  `migrations>=0031=0`, `migrate(): FALHOU -> E4.2 preflight bloqueou o DDL…`.
- **Depois** (mecanismo corrigido): `migrate(): retornou SEM erro`,
  `vendas.local_saida_id=EXISTS`, `migrations>=0031=5`, `/api/vendas` → 200.

Classificação: **VERIFIED SAFE** — as migrações versionadas são aplicadas mesmo
com o bootstrap bloqueado; dados legados preservados; nenhuma escrita
especulativa; falha do `schema.sql` permanece visível e não finge sucesso.

---

## 12. Riscos residuais

1. **Dado legado em produção ainda precisa ser corrigido** para o `db/schema.sql`
   completar (o log do boot traz a contagem exata do preflight). Até lá, o banco
   opera com a cadeia versionada aplicada, mas sem o restante do bootstrap do
   `schema.sql`. O log agora aponta exatamente o que corrigir.
2. **Sem acesso ao `DATABASE_URL` de produção** neste ambiente, o conteúdo exato
   do banco não foi inspecionado; a causa foi provada por reprodução e pelo
   `db:"memory"` do health. Recomenda-se, após o deploy, conferir no log do boot
   a linha `⚠️ db/schema.sql não pôde ser aplicado por inteiro … Causa: …` para
   identificar o dado legado a corrigir.
3. O `index.ts` continua engolindo o erro no `catch` do `migrate()` (apenas loga).
   Não alterado por estar fora do mecanismo de schema; o efeito visível
   (`db:"memory"`) agora é intencional e detectável.

---

## Fora do escopo

- Nenhuma mudança em UX, top navigation, commerce, marketplace, fiscal,
  financeiro, segurança, advisory locks, SERIALIZABLE, CORS, rate limit, RBAC,
  uploads, anexos.
- O `catch` silencioso do `migrate()` em `index.ts` foi **documentado** mas não
  alterado (o comportamento degradado agora é visível via `db:"memory"`).
- Produção (Render/Neon) não foi tocada diretamente — a correção chega por
  deploy do código.
