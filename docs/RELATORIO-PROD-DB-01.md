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

Regressão completa: server 821/0, client 323/0, PG 212/0 (PostgreSQL 16.14 real),
typecheck (server/domain/client), lint (0 erros), build, smoke 126/126,
smoke:pg 126/126 e audit:menu (0 erros) — todos verdes.

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

## 13. PROD-DB-01.1 — prontidão de produção (readiness)

### 13.1 Lacuna encontrada pela auditoria independente

O PROD-DB-01 fez `migrate()` aplicar a cadeia versionada mesmo com o bootstrap
do `schema.sql` bloqueado — mas o estado resultante ainda **atendia negócio**:

- `server/src/index.ts` capturava a falha do `migrate()` com `console.error` e
  seguia a inicialização;
- `server/src/pgstore.ts` escolhia o `PgStore` pela mera **existência do pool**,
  não pela prontidão real do banco;
- `server/src/services.ts` (`getStore()`) caía para o `MemStore` quando
  `isPgAvailable()` era falso — ou seja, com `DATABASE_URL` definida e o banco
  degradado, a instância aceitaria **escrita em memória como se fosse
  persistência real**.

### 13.2 Decisão de prontidão (um único comportamento seguro)

Sinal canônico: `isDbDegraded()` = `DATABASE_URL` presente **E** `ready === false`.
`ready` só é verdadeiro com bootstrap completo (`db/schema.sql` + cadeia
versionada). Enquanto degradado:

| Superfície | Comportamento |
|---|---|
| `/api/health` | **503** `{ ok: false, db: 'postgres-degraded' }` → a Render não promove a instância |
| Rotas de negócio (`/api/*`, incl. `/api/vendas`) | **503** via `bloqueioDeProntidao` |
| `/api/auth/*` | liberado (diagnóstico/acesso) |
| Webhooks de provedores (`publicConnectorsRouter`, `publicGatewayRouter`) | intactos — montados antes do `express.json()` |
| `getStore()` com `DATABASE_URL` e banco não pronto | lança **503**, nunca `MemStore` |
| Inicialização | em produção: `process.exit(1)` no boot degradado (recuperação = reiniciar) |

O `process.exit(1)` é a política preferida: o processo não fica servindo com
schema incompleto e a plataforma reinicia. A porta continua sendo escutada
**antes** das migrações (exigência da Render, inalterada), e o health responde
503 durante a janela de boot/migração.

### 13.3 Alterações

- `server/src/db.ts`: `ready = false` no início de `migrate()`; distingue falha
  fatal da cadeia versionada de bootstrap incompleto; expõe `isDbDegraded()` e
  `migrationError()`.
- `server/src/pgstore.ts`: `isPgAvailable()` passa a exigir `isDbConnected()`.
- `server/src/services.ts`: `getStore()` não cai para memória quando há
  `DATABASE_URL` e o banco não está pronto.
- `server/src/index.ts`: health 503 quando degradado; `bloqueioDeProntidao`;
  `process.exit(1)` em produção no boot degradado; inicializações de negócio
  (`initConnectors`, `initNegociosEngine`, `ensureAdmin`, …) puladas no estado
  degradado.

### 13.4 Testes antes/depois

`server/test/pg/prod-db-01-readiness.test.ts` (processo real, porta real, JWT
real, PostgreSQL 16.14 real):

| Cenário | Antes | Depois |
|---|---|---|
| A — banco pronto | health 200 | health 200 `db=postgres`; `GET /api/vendas` 200 |
| B — bootstrap incompleto (dado legado E4.2) | health 200 `db=memory` e negócio **atendia** | health **503**; `GET`/`POST /api/vendas` **503** |
| C — `DATABASE_URL` com PostgreSQL indisponível | negócio atendia em memória | health **503**; `GET`/`POST /api/vendas` **503** |
| D — recuperação (corrigida a causa + reinício) | — | health 200 `db=postgres`; `GET /api/vendas` **200** |

`server/test/pg/prod-db-01-schema-sync.test.ts` cobre ainda a falha da cadeia
versionada (migração `9999` que falha de propósito) deixando o banco degradado e
a recuperação posterior.

### 13.5 Limitações

- Não houve acesso ao `DATABASE_URL` de produção; a prova é por reprodução em
  PostgreSQL real e pelo contrato de `readiness`/health.
- As rotas de autenticação permanecem acessíveis no estado degradado (por
  desenho, para diagnóstico); elas não servem dados de negócio.
- `/api/files/:id/:token` (imagens por token) e o catálogo público respondem 503
  no estado degradado — comportamento intencional, mas que altera o contrato de
  disponibilidade durante a janela de migração.

---

## 14. PROD-DB-01.2 — gate final de prontidão

Modo: AUDIT → TEST → FIX ONLY IF PROVEN → CI. Sem merge.

### 14.1 Auditoria de TODA rota liberada no estado degradado

O bloqueio de prontidão libera `/api/health` e, por desenho, o prefixo
`/api/auth/*` (diagnóstico/acesso). A auditoria verificou, rota por rota, se
alguma delas usa PostgreSQL, altera estado persistente ou pode falhar de forma
não controlada quando `isDbDegraded()` é verdadeiro:

| Rota | Usa PostgreSQL? | Altera estado? | Comportamento degradado |
|---|---|---|---|
| `GET /api/health` | não (lê flags em memória) | não | 503 controlado |
| `POST /api/auth/login` | sim | sim (sessão, auditoria) | 503 controlado; **emergência** 200 |
| `POST /api/auth/login/mfa` | sim | sim | 503 controlado |
| `POST /api/auth/mfa/desafio` | sim | sim | 503 controlado |
| `POST /api/auth/forgot` | sim | sim (reset token) | 200 (genérico, sem efeito) |
| `POST /api/auth/reset` | sim | sim | 503 controlado |
| `GET /api/auth/politica-senha` | não (política padrão em memória) | não | 200 leitura |
| `GET /api/auth/me` | best-effort | não | 200 leitura (sem persistir) |
| `POST /api/auth/change-password` | sim | sim | 503 controlado |
| `POST /api/auth/reautenticar` | sim | sim | 503 controlado |
| `POST /api/auth/logout` | sim | sim (revoga sessão) | 503 (não revoga em memória) |
| `POST /api/auth/logout-all` | sim | sim | 503 controlado |
| `GET /api/auth/sessoes` | sim | não | 503 controlado |
| `POST /api/auth/sessoes/:sid/revogar` | sim | sim | 503 controlado |
| `GET /api/auth/mfa/status` | sim | não | 503 controlado |
| `POST /api/auth/mfa/{setup,ativar,desativar,codigos}` | sim | sim | 503 controlado |
| `GET/PUT /api/auth/preferences` | sim | PUT sim | 503 controlado |

Conclusão: **nenhuma** rota de `/api/auth/*` atende pelo `MemStore` no estado
degradado — `getStore()` lança 503 (`isPgAvailable()` exige `isDbConnected()`).
Não há caminho de escrita em memória nem de leitura servida por memória para
dados que só existem no Postgres. As duas únicas rotas que respondem 200 são
estritamente leituras sem persistência (`politica-senha`, `me`).

### 14.2 Correção PROVADA — login de emergência restaurado

A auditoria encontrou uma regressão introduzida pelo PROD-DB-01.1: em
`server/src/auth.ts`, `login()` chamava `getStore()` **fora** do `try`. Depois do
01.1, `getStore()` passa a lançar 503 quando o banco está indisponível — então a
exceção escapava **antes** de `lookupFailed` ser marcado, tornando inalcançável
o **acesso de emergência do administrador** (`auth.ts:345`), que existe
justamente para o caso de banco fora do ar.

Correção mínima: a obtenção do store passou para **dentro** do `try`, de modo
que a falha vira `lookupFailed = true` (comportamento idêntico ao anterior ao
01.1, quando o `PgStore` existia e `findUserByEmail` lançava). Efeitos:

- emergência (`email === ADMIN_EMAIL` e senha de env): **200** com token de 1 h,
  `id: 0` (sem escrita sensível);
- qualquer outro login com banco fora: **503** honesto ("Banco de dados
  indisponível"), em vez de 401 "senha incorreta" ou token de memória.

Prova em PostgreSQL real: cenário C de `prod-db-01-readiness.test.ts`
(login comum 503 sem token; login de emergência 200 `id=0`).

### 14.3 Correção PROVADA — contrato de `/api/health` de três estados

Antes, o estado degradado respondia `db: "memory"`, **confundindo** banco
indisponível com modo demonstração (`ux05-fixtures.mjs` e o cliente tratam
`memory` como demo). Agora `dbStatus()` distingue explicitamente:

| Estado | `db` | HTTP | `ok` |
|---|---|---|---|
| sem `DATABASE_URL` | `memory` | 200 | `true` |
| pronto | `postgres` | 200 | `true` |
| degradado | `postgres-degraded` | 503 | `false` |

A Render usa `healthCheckPath: /api/health`: continua promovendo a instância
apenas com 200 (estado `ready`), preservando o contrato de deploy. O gate
`schema-sync`/`smoke:pg` casa `db === 'postgres'` somente quando o health é 200,
logo segue válido.

### 14.4 Contrato de reinício no boot degradado (produção)

Em produção o processo encerra (`process.exit(1)`) no boot degradado. Documentado:
a Render reinicia o serviço; o deploy é cancelado e a versão anterior continua
servindo quando o health não fica saudável (rollback automático). O log registra
a causa (`migrationError()`), então não há falha silenciosa. Um crash-loop só
persiste enquanto a causa raiz (schema/migração) não for corrigida — que é o
objetivo do gate.

### 14.5 Testes PROD-DB-01.2

`server/test/pg/prod-db-01-readiness.test.ts` (PostgreSQL 16 real + HTTP real):

| Cenário | Prova |
|---|---|
| A — pronto | health 200 `db=postgres`; `/api/vendas` 200 |
| B — bootstrap incompleto | health 503 `db=postgres-degraded ok=false`; login **503 sem token** (sem MemStore); `GET`/`POST /api/vendas` 503 |
| C — Postgres indisponível | health 503 `db=postgres-degraded`; login comum **503 sem token**; login de emergência **200 `id=0`**; `/api/vendas` 503 |
| D — recuperação | health 200 `db=postgres`; `/api/vendas` 200 |
| E — sem `DATABASE_URL` | health 200 `db=memory ok=true` (demonstração explícita) |

### 14.6 Limitações

- A autenticação continua sendo a única superfície não bloqueada no estado
  degradado (por desenho, para diagnóstico). A auditoria mostra que nenhuma rota
  dela serve dados de negócio nem cai para memória.
- `POST /api/auth/logout` responde 503 com banco fora: a revogação persistente
  da sessão não acontece. Alternativa (logout local silencioso) foi rejeitada
  por deixar o token válido no servidor — decisão de segurança, documentada.

## 15. PROD-DB-01.3 — auditoria do token de emergência

### 15.1 Achado da revisão independente

O login de emergência (id `0`, `perfil: 'admin'`) existe para permitir
diagnóstico quando o banco está fora. A revisão apontou que esse token
atravessava caminhos que normalmente revalidam o usuário no banco. A auditoria
confirmou o problema **com prova em PostgreSQL real** (não por leitura de
código).

Mecânica: `requireAuth` **pula** toda revalidação para `id <= 0` — não há
`sid`, `token_versao`, linha em `usuarios` nem MFA a conferir. O token é um JWT
comum de 1 h, com `perfil: 'admin'`.

### 15.2 Vetores PROVADOS (antes da correção)

Servidor real, PostgreSQL real, dois processos com o **mesmo `JWT_SECRET`**:

| Vetor | Estado do banco | Rota | Antes | Depois |
|---|---|---|---|---|
| A1 | degradado | `GET /auth/sessoes` | **200** (`{"sessoes":[]}`) | 403 `EMERGENCIA_RESTRITA` |
| A2 | degradado | `GET /auth/preferences` / `PUT` | **200** | 403 `EMERGENCIA_RESTRITA` |
| B1 | **recuperado** | `GET /auth/me` | **200** (token da queda aceito) | 401 |
| B2 | **recuperado** | `GET /admin/notificacoes/status` | **200** | 401 |
| B3 | **recuperado** | `GET /admin/auditoria/verificar` | **200** | 401 |
| B4 | **recuperado** | `GET /usuarios/resumo` | **200** | 401 |
| B5 | **recuperado** | `GET /vendas` | **200** | 401 |
| B6 | recuperado | `POST /auth/reautenticar` | **200** | 401 |
| B7 | recuperado | `POST /usuarios/1/desativar` (após B6) | passava o guard de admin e reauth | 401 |

**O vetor B é o grave:** um token emitido durante a queda **continua válido como
administrador pleno depois que o banco volta** — e **não há como revogá-lo**
(id 0 não tem linha em `usuarios`, então desativar usuários ou `logout-all` não
o atingem). Basta esperar a recuperação.

### 15.3 Correção aplicada

1. **`server/src/auth.ts` — `requireAuth`:** token com `id <= 0` só é aceito
   quando `isDbDegraded()`. Fora do estado degradado → **401**. Fecha o vetor B
   (o token deixa de sobreviver à recuperação) e elimina o admin sintético
   não revogável.
2. **`server/src/index.ts` — allowlist explícita de emergência:** o token id 0
   só alcança `GET /api/auth/me`, `GET /api/auth/politica-senha` e
   `POST /api/auth/logout`; qualquer outra rota → **403 `EMERGENCIA_RESTRITA`**.
   As rotas de negócio continuam em 503 pelo `bloqueioDeProntidao` (roda antes).
   O `/api/admin/*` (`requireRole('admin')`) deixa de ser alcançável pelo admin
   sintético.
3. **`server/src/auth.ts` — `loginFailed`:** a auditoria passou a ser
   *best-effort* com `try/catch`; `getStore()` pode lançar com o banco fora e a
   falha de login nunca mais vira **500 não controlado** (resposta canônica 401).
4. **`server/src/websocket.ts`:** o handshake recusa o token id 0 quando o banco
   não está degradado, e o id 0 **não entra** nas salas globais (`dashboard`,
   `perfil:*`).

### 15.4 Capacidades efetivas do token de emergência (depois)

- **Só existe** enquanto `isDbDegraded()`.
- Alcança apenas `GET /api/auth/me`, `GET /api/auth/politica-senha`,
  `POST /api/auth/logout` (todas sem dados de negócio).
- **Nunca** alcança `/api/admin/*`, `/api/usuarios/*`, CRUD genérico, financeiro
  ou estoque (403/503).
- Não entra em salas WebSocket globais e não sobrevive à recuperação do banco.

### 15.5 Prova automatizada

`server/test/pg/prod-db-013-emergency-token.test.ts` (PostgreSQL 16 real + HTTP
real + WebSocket real). Sem `DATABASE_URL` o arquivo FALHA (não é permitido
pular). Evidência do run verde:

```
A degradado: login emergência 200 (id=0)
A degradado: /auth/sessoes 403; /auth/preferences 403; /auth/change-password 403; /auth/mfa/setup 403
A degradado: /admin/* e negócio → 503 (prontidão); WebSocket handshake → conectado (sem salas globais)
B recuperado: token da queda → /auth/me 401; /admin/notificacoes/status 401; /usuarios/:id/desativar 401; /vendas 401; WebSocket recusado
C regressão: login normal 200; GET /vendas 200
D loginFailed: senha errada 401 (controlado)
```

### 15.6 Impacto / compatibilidade

- **Nenhuma** mudança no fluxo de recuperação: com o banco fora, o
  administrador continua logando e enxergando o diagnóstico (`/auth/me`).
- O comportamento só fica **mais restrito**, nunca mais permissivo.
- Nenhum usuário real (id > 0) é afetado.

### 15.7 Limitações

- A restrição vale por instância: como `isDbDegraded()` é um estado de processo,
  um deploy com o banco fora aceita o token; após a recuperação (mesmo processo)
  o token deixa de valer — que é exatamente o comportamento desejado.
- `POST /api/auth/logout` continua respondendo 503 com o banco fora (a revogação
  persistente não acontece). Decisão herdada do PROD-DB-01.2, mantida.

---

## Fora do escopo

- Nenhuma mudança em UX, top navigation, commerce, marketplace, fiscal,
  financeiro, segurança, advisory locks, SERIALIZABLE, CORS, rate limit, RBAC,
  uploads, anexos.
- O `catch` silencioso do `migrate()` em `index.ts` foi **documentado** mas não
  alterado (o comportamento degradado agora é visível via `db:"postgres-degraded"`).
- Produção (Render/Neon) não foi tocada diretamente — a correção chega por
  deploy do código.
