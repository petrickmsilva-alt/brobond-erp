# PROD-DB-01.5.2.1 — Auditoria da origem da divergência (versão em produção × HEAD)

**Modo:** AUDITORIA READ-ONLY. Nenhuma alteração em produção; nenhum `APPLY`;
nenhum `UPDATE`; nenhum deploy; `DATABASE_URL` de produção não usada.

**Pergunta:** por que a versão do `db/admin/005-propagar-nomes-locais-e42.sql`
executada em produção divergiu da versão presente no `HEAD`/`main`?

**Resposta curta:** a produção não executou o `HEAD`. O operador rodou uma
**cópia local defasada** — a revisão do `PROD-DB-01.5.1` (blob `9285663e`),
que **não possui** o parâmetro `normalizar_classe_c`. Não houve deploy da versão
01.5.2 com o gate; o único deploy que continha o arquivo 005 continha a revisão
01.5.1, e ele **falhou** (fail-closed). O arquivo 005 é uma ferramenta
administrativa **manual**, nunca executada pela aplicação.

---

## 1. Qual commit estava efetivamente implantado no Render no momento do incidente

Fonte primária: **GitHub Deployments API** (o Render é o app `renderinc` que
registra cada deploy). Consulta:

```
gh api "repos/petrickmsilva-alt/brobond-erp/deployments?per_page=100"
gh api repos/petrickmsilva-alt/brobond-erp/deployments/<id>/statuses
```

Deploys de produção recentes (todos em `main - brobond-erp`, `production_environment=true`):

| created_at (UTC) | deployment id | sha (main) | estado final | contém `db/admin/005`? |
|---|---|---|---|---|
| 2026-10-20T16:08:10Z | 7204824834 | `7238fdf` | **failure** | sim — blob `4b2db7b` (01.5.2) |
| 2026-10-20T13:35:20Z | 7201146221 | `f202782` | **failure** | sim — blob `9285663` (01.5.1) |
| 2026-10-20T01:08:18Z | 7188887996 | `1581f61` | **failure** | sim — blob `9285663` (01.5.1) |
| 2026-10-19T17:43:51Z | 7180672479 | `e129882` | **failure** | não (arquivo ainda não existia) |
| 2026-10-19T11:33:14Z | 7172630742 | `04ec939` | **success** | não (arquivo ainda não existia) |

Fatos apurados:

- O arquivo `db/admin/005-propagar-nomes-locais-e42.sql` **entrou no repositório
  apenas em `b43285b`** (`2026-10-19T22:06:12Z`, `PROD-DB-01.5`). Logo, o último
  deploy **bem-sucedido** (`04ec939`, 2026-10-19T11:33Z) é **anterior** ao arquivo.
- Todos os deploys que já continham o arquivo 005 (`1581f61`, `f202782`,
  `7238fdf`) terminaram em **failure** — consistente com o fail-closed do
  PROD-DB-02 (migration 0030 detecta as 69 inconsistências e o health responde
  503, impedindo a promoção da instância).
- **Nenhum deploy bem-sucedido jamais conteve a revisão 01.5.2** (`4b2db7b`) do
  arquivo. O deploy do 01.5.2 (`7238fdf`, 16:08:10Z) **falhou**.

> Observação de precisão: o estado `failure` do deploy reflete o resultado do
> *deploy* (health check/fail-closed), não prova por si só qual blob de arquivo o
> operador executou manualmente. A identificação da revisão executada vem da
> assinatura da saída do incidente (§2).

## 2. Qual versão do arquivo 005 estava naquele commit (e o que a saída prova)

Blobs por revisão (conteúdo do arquivo, hashes Git):

| commit | data (UTC) | blob | bytes | `set_config('e42...')` | refs a `normalizar_classe_c` | HINT "decida com a administração" |
|---|---|---|---|---|---|---|
| `b43285b` (01.5) | 2026-10-19T22:06Z | `28d71af4` | 12979 | 2 | 0 | **sim** |
| `e592294` (01.5.1) | 2026-10-20T01:01Z | `9285663e` | 22487 | 2 | 0 | **sim** |
| `e34154a` (01.5.2) | 2026-10-20T15:37Z | `4b2db7b` | 30045 | 5 | 12 | não |
| `7238fdf` (merge #74 = main) | 2026-10-20T16:08Z | `4b2db7b` | 30045 | 5 | 12 | não |

A transcrição do incidente traz dois marcadores decisivos:

1. **Cabeçalho de 2 colunas** (`modo_apply | confirmacao`). O `HEAD` emite
   **3 colunas** (`modo_apply | confirmacao | normalizar_classe_c`). As revisões
   01.5 e 01.5.1 têm exatamente 2 chamadas `set_config('e42...')` → cabeçalho de
   2 colunas.
2. **HINT** `Diferença cosmética: decida com a administração se normaliza; não é
   propagação de renome.` Esse texto existe **apenas** em `b43285b` e `e592294`
   (linha 193 do 01.5.1); **não existe** em nenhum ponto do `HEAD`.

Além disso, o `ERROR` reportado em "line 128" corresponde, no arquivo 01.5.1, ao
`RAISE` da classe C: o `DO` começa na linha 65 e o `RAISE` está na linha 192 —
**127 linhas depois do início do bloco** (o psql conta a linha do arquivo; a
contagem interna do PL/pgSQL aponta ~128). No `HEAD` o mesmo `RAISE` está 170
linhas após o início do bloco — incompatível com "line 128".

Conclusão: a revisão executada foi a **01.5.1** (`9285663e`), presente em
`e592294` / `1581f61` / `f202782`. É a mesma cópia que reproduz a saída do
incidente byte a byte (reprodução em ambiente descartável, §4).

## 3. O deploy do PROD-DB-01.5.2 realmente continha a versão com `normalizar_classe_c`?

**Sim, o commit continha** — mas o deploy **não foi promovido** (failure) e, mais
importante, **isso é irrelevante para a execução manual**: o arquivo 005 **não é
executado pela aplicação**.

Prova de que o arquivo é operação manual, não código de boot:

- `grep -rn "db/admin" server/src client/src scripts render.yaml` → **vazio**.
- `render.yaml`: `buildCommand: npm install --include=dev && npm run build`;
  `startCommand: npm --workspace server start`. Nem o build nem o start leem
  `db/admin/`.
- O boot/migração versionada lê `db/migrations/*` e `db/schema.sql` (via
  `server/src/db.ts`), não `db/admin/005-*.sql`.

Ou seja: mesmo num deploy bem-sucedido do `7238fdf`, o arquivo `db/admin/005`
**não** é copiado para o runtime como “versão implantada” executável — ele é um
artefato do repositório que um operador roda manualmente, tipicamente de uma
**cópia local**. A divergência nasceu de o operador ter uma cópia local na
revisão 01.5.1 enquanto o repositório já estava em 01.5.2.

## 4. Reprodução do incidente (evidência, não inferência)

Ambiente: PostgreSQL descartável (nenhuma URL de produção). Fixture: 1 local
canônico `LOJA` + 69 textos `loja` (29 estoques + 40 movimentações) — Classe C.

- Executar o arquivo do `HEAD` (`7238fdf`, blob `4b2db7b`) com o comando exato de
  produção → **`COMMIT`, total=69, exit 0**.
- Executar o arquivo de `e592294`/`f202782` (blob `9285663e`, 01.5.1) com o
  **mesmo** comando → **cabeçalho de 2 colunas, HINT "decida com a
  administração", `ABORTADO: 69 caso(s) classe C`, exit 3** — saída idêntica à
  transcrição do incidente.

Isso identifica a revisão executada com precisão e exclui defeito de lógica no
`HEAD`.

## 5. Como impedir que uma operação administrativa execute silenciosamente um arquivo defasado

Proteção objetiva e pequena (sem tocar em migração, boot, fail-closed ou produção):

1. **Marcador de revisão na saída** — o arquivo passa a declarar
   `\set e42_revisao 'PROD-DB-01.5.2.1'` e o cabeçalho emite uma 4ª coluna
   `revisao`. Qualquer execução (inclusive um DRY-RUN colado num chamado)
   identifica **qual arquivo rodou**. A cópia antiga tinha cabeçalho de 2 colunas.
2. **Executor seguro `db/admin/run-005-e42.sh`** — sempre executa o arquivo ao seu
   lado e **RECUSA** rodar quando:
   - o arquivo não contém o gate `normalizar_classe_c` (cópia anterior ao 01.5.2);
   - o arquivo não traz o marcador `PROD-DB-01.5.2.1`;
   - o arquivo difere do `HEAD` do repositório (cópia antiga materializada ou
     edição local não revisada).
3. **Teste de regressão** — prova que o executor recusa as três classes de cópia
   defasada e executa a íntegra.

Uso recomendado no runbook (substitui o `psql -f` direto):

```bash
DATABASE_URL=... db/admin/run-005-e42.sh \
  -v apply=on -v confirmacao=PROD-DB-01.5.2 -v normalizar_classe_c=on
```

## 6. Arquivos alterados nesta auditoria

- `db/admin/005-propagar-nomes-locais-e42.sql` — marcador de revisão + coluna
  `revisao` no cabeçalho.
- `db/admin/run-005-e42.sh` — **novo** executor seguro.
- `server/test/pg/prod-db-01-521-gate-classe-c.test.ts` — teste da guarda contra
  cópia defasada.

## 7. Confirmações

- Migration 0030: **não alterada** (`git diff HEAD -- db/migrations/0030_...` vazio).
- `server/src/db.ts`, `server/src/index.ts`, boot, fail-closed, Render: **não alterados**.
- Produção: **não alterada**; nenhum `APPLY`/`UPDATE`/deploy.
