# REGRESSION GATES — Fase 9.6

**Data:** 2026-11-09 · **Branch:** `architecture/fases-9-4-9-5-9-6`

Gates obrigatórios que impedem regressão silenciosa. Nenhum gate é configurado
para passar quando o teste não foi executado; nenhum job é desativado; nenhum
`continue-on-error` em teste crítico.

## 1. Gates de CI (`.github/workflows/ci.yml`)

### Job `verificar`

| Passo | Comando | Critério |
|---|---|---|
| Typecheck API | `npm --prefix server run typecheck` | 0 erros |
| Typecheck front | `npm --prefix client run typecheck` | 0 erros |
| Testes das regras de negócio | `npm --prefix server test` | 0 fail |
| Testes client | `npm --prefix client test` | 0 fail |
| Smoke em memória | `npm run smoke` | 200 nos fluxos |
| Auditoria do menu | `npm run audit:menu` | coerente |
| Gate Commerce go-live | `npm run commerce:go-live` | P0 aberto = exit 1 |
| Inventário arquitetural | `npm run architecture:audit` | coerente |
| Typecheck do domínio | `npm run typecheck:domain` | 0 erros |
| Prisma validate | `npx prisma validate` | schema válido |
| Lint | `npm run lint` | 0 **errors** |
| Build do front | `npm --prefix client run build` | build OK |

### Job `testes-postgres`

| Passo | Comando | Critério |
|---|---|---|
| Confirmar PostgreSQL 16.14 | `server_version_num = 160014` | versão oficial |
| Migrations + concorrência | `npm run test:pg` | 0 fail/skip/todo |

O wrapper `scripts/test-pg-gate.mjs` **recusa** banco reaproveitado
(`relações públicas != 0`), exige PG **16.14** e **falha** se o runner reportar
`skip`/`todo`/`cancelled` — "skip não é aprovação" (P2-09).

## 2. Resultado desta execução (SHA local)

| Gate | Resultado | Números |
|---|---|---|
| Typecheck (domínio+server+client) | ✅ PASS | 0 erros |
| Lint | ✅ PASS | 0 errors / 629 warnings (baseline) |
| Server tests (memória) | ✅ PASS | 2504 testes · 2411 pass · 0 fail · 93 skip |
| Client tests | ✅ PASS | 1195 pass · 0 fail |
| PostgreSQL real (`test:pg`) | ✅ PASS | **484** pass · 0 fail · 0 skip · 0 todo |
| Fase 9.6 (PG) | ✅ PASS | 6 pass · 0 fail (novo arquivo) |

> Os **93 skips** da suíte de memória são testes que se auto-declaram
> `skip: 'requer PostgreSQL real'` e **rodam** no job `testes-postgres` (o gate
> PG tem 0 skip). Skip de memória **não** é skip crítico.

## 3. Regras de não-regressão

- **Não remover** teste existente para obter aprovação.
- **Não reduzir** assertions nem cobertura de forma artificial.
- **Não alterar** critério do CI para permitir merge.
- **Não mascarar** exit code nem usar `continue-on-error` em teste crítico.
- Novo teste de banco **não** pode se auto-pular quando `DATABASE_URL` existe
  (o arquivo da Fase 9.6 **lança** sem `DATABASE_URL`, em vez de `skip`).

## 4. Gates de migração e bootstrap

| Gate | Script | Critério |
|---|---|---|
| Schema espelhado | `db/schema.sql` + `db/migrations/*.sql` | tabela nova em ambos |
| Bootstrap sincronizado | `scripts/gerar-bootstrap.mjs --check` (teste `prod-db-02-bootstrap-sync`) | bootstrap = schema estrutural |
| Inventário arquitetural | `scripts/arquitetura-audit.ts` | recurso × tabela × tenant |
| Migração em banco vazio | `test:pg` (banco novo) | aplica sem erro |
| Migração com dados | `test:pg` (dados da bateria) | aditiva, sem perda |

## 5. Como reproduzir o gate PostgreSQL localmente

```bash
sudo docker exec brobond-pg psql -U brobond -d postgres \
  -c "DROP DATABASE IF EXISTS brobond_gate WITH (FORCE);" -c "CREATE DATABASE brobond_gate;"
export DATABASE_URL="postgresql://brobond:brobond@127.0.0.1:5433/brobond_gate"
export ADMIN_PASSWORD="$(node -e "process.stdout.write('A!'+require('crypto').randomBytes(24).toString('hex'))")"
export JWT_SECRET="$(node -e "process.stdout.write(require('crypto').randomBytes(32).toString('hex'))")"
npm run test:pg
```
