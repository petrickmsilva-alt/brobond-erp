# ERP-03 — PostgreSQL Gate: diagnóstico e plano controlado

**Preparado em:** 2026-10-12, após o ERP-02.1 ser aprovado no commit `20e14c8d913320da90a4104f98ba8a3a85d0a332` e o PR #55 estar aberto.
**Repositório/branch:** `petrickmsilva-alt/brobond-erp` · `arena/0c720c09-brobond-erp`
**Estado deste arquivo:** diagnóstico e plano; **não implementa ERP-03**.

> **Distinção de escopo e histórico:** `docs/ERP-CORE-ROADMAP.md` já registra ERP-03 como implementado em 2026-10-11: P0-04/P0-05 foram fechados, `smoke:pg` existe e roda no CI. Este plano não reabre nem replica essas mudanças. Ele documenta o baseline PostgreSQL encontrado depois do ERP-02.1, os pré-requisitos e uma sequência verificável para qualquer próximo trabalho de gate. A implementação futura só começa após comando explícito do responsável pelo repositório.

## 1. Diagnóstico do estado atual

### Gate já existente

- `scripts/smoke-pg.mjs` recebe um `DATABASE_URL` administrativo, cria um banco PostgreSQL novo com nome aleatório, inicia a API real (migrations + bootstrap de admin), aguarda o marco final de boot, executa `scripts/smoke-e2e.mjs` e remove o banco com `DROP DATABASE ... WITH (FORCE)`. `--keep` existe apenas para inspeção local.
- `npm run smoke:pg` já está no job `testes-postgres` de `.github/workflows/ci.yml`. O gate verifica que a prova funcional não depende do modo demonstração; o smoke em memória (`npm run smoke`) permanece útil, mas não o substitui.
- `npm run test:pg` executa serialmente (`--test-concurrency=1`) a suíte PostgreSQL de `server/test/pg-*.test.ts` e `server/test/pg/*.test.ts`.
- ERP-03 existente também contém `server/test/pg/contrato-tipo-coluna.test.ts` (contrato dos 88 recursos, incluindo prova por mutação), `e03-onboarding-local-padrao.test.ts` e `e03-multiempresa-ab.test.ts`.
- O job de CI valida o schema Prisma, faz o baseline da migration dual-track já aplicada pelo boot do ERP, executa `prisma migrate deploy` e roda o smoke em banco novo.
- A versão final deste gate fica fixada em **PostgreSQL 16.14**: a imagem de serviço deve ser `postgres:16.14` e o job deve falhar se `SHOW server_version` não retornar exatamente `16.14`. A evidência local ERP-02.1 foi executada em PostgreSQL 16.14 real.

### O que o estado verde não significa

- `smoke` em memória não prova migrations, constraints, transações ou concorrência do PostgreSQL.
- `smoke:pg` mede os 126 fluxos de smoke sobre uma instalação nova, mas não substitui `test:pg`, os testes de contrato nem as provas de mutação.
- ERP-03 implementado historicamente não declara todo o ERP pronto e não elimina novos gaps descobertos por ciclos posteriores, como o GAP-E02-02 tratado no ERP-02.1.
- Este plano não altera regras do produto, schema, migrations, módulos, telas, scripts ou workflow além do pin e da asserção da versão registrados no PR ERP-02.1.

## 2. Dependências e pré-condições

| Dependência | Requisito para execução | Evidência/observação |
|---|---|---|
| PostgreSQL | Servidor **16.14**; mesmo patch na imagem do CI e nas evidências locais. | O workflow fixa `postgres:16.14` e compara `SHOW server_version` com `16.14`. Upgrade é decisão explícita, nunca mudança silenciosa de tag flutuante. |
| Node/npm | Node.js 22 no CI; dependências instaladas nos workspaces `server`, `client` e raiz. | `test:pg` usa `tsx`; o passo da versão usa o pacote `pg` instalado em `server`. |
| Banco | `DATABASE_URL` aponta para uma instância de teste isolada, nunca produção. | `smoke:pg` precisa criar e apagar databases; o serviço CI usa usuário dedicado do container. |
| Bootstrap/migrations | Banco de teste novo, migrações do ERP e usuário admin de teste funcionais. | A API aplica o schema e as migrations no boot; o job valida também a migration Prisma dual-track. |
| Ambiente HTTP | Porta local livre e permissão para o processo Node iniciar/encerrar a API. | O runner escolhe porta disponível e aguarda o marcador de bootstrap, não somente `/health`. |
| Isolamento | Um serviço/database por job; `test:pg` serial, sem compartilhar estado com smoke ou execuções paralelas. | Evita colisão de fixtures e de migrations, além de tornar o resultado reproduzível. |
| Credenciais externas | Nenhuma credencial de produção, marketplace, gateway ou certificado fiscal. | Casos do gate devem continuar usando adapters/fixtures locais. |

## 3. Matriz de cobertura existente a preservar

| Superfície | Artefato/comando | O que precisa continuar provado |
|---|---|---|
| Regressões PostgreSQL do ERP | `DATABASE_URL=… npm run test:pg` | Suíte completa contra o banco real; concorrência, rollback, idempotência, multiempresa, constraints e regressões dos ciclos anteriores. O ERP-02.1 acrescenta o fluxo de estorno acima de 5000 movimentos. |
| E2E de instalação nova | `DATABASE_URL=… npm run smoke:pg` | Banco descartável criado sem SQL manual, migrations + bootstrap real e **126/126** verificações. O banco temporário é removido mesmo após a execução; `--keep` somente para diagnóstico local. |
| Smoke de demonstração | `npm run smoke` | Paridade funcional útil em memória; não é aceitação de PostgreSQL. |
| Contrato de recursos × colunas | `server/test/pg/contrato-tipo-coluna.test.ts` (incluído em `test:pg`) | Tipos, existência e regras declaradas para 88 recursos; deve falhar com declaração errada pela prova de mutação. |
| Onboarding PostgreSQL | `server/test/pg/e03-onboarding-local-padrao.test.ts` | Primeira operação de estoque em empresa sem local padrão, sem semeadura manual; criação e auditoria do Local padrão. |
| Isolamento A/B do ERP-03 | `server/test/pg/e03-multiempresa-ab.test.ts` | Mesmo SKU/nome de local coexistem em empresas distintas; duplicata dentro da mesma empresa é recusada; local e saldo não vazam entre empresas. |
| Produção/estorno | `server/test/pg/e02-ordem-reabrir-postgresql.test.ts` e `server/test/pg/e02-reabertura-estorno-postgresql.test.ts` | G1–G5, GAP-E02-02, conjunto completo de movimentos, custos/perdas/eventos, concorrência `[200,409]`, rollback e isolamento multiempresa. |
| Schema Prisma | `npx prisma validate` / step `Validar schema Prisma unificado` | Schema válido; CI é a fonte de verdade quando a rede local não permite baixar `schema-engine`. |

## 4. Comandos de referência

Rodar apenas em ambiente de teste, com usuário que possa criar banco descartável:

```bash
# Tipos, suites de unidade, lint e build (executados também pelo job verificar)
npm run typecheck
npm test
npm run lint
npm run build

# PostgreSQL real já iniciado, DATABASE_URL apontando para um banco isolado
DATABASE_URL=postgresql://usuario:senha@host:5432/banco_teste npm run test:pg

# Cria um banco novo, sobe a API real, roda 126 verificações e remove o banco
DATABASE_URL=postgresql://usuario:senha@host:5432/banco_admin npm run smoke:pg

# Apenas demonstração/memória; não substitui os dois comandos acima
npm run smoke

# Contrato Prisma sem conectar ao banco; DATABASE_URL precisa existir
DATABASE_URL=postgresql://ci:ci@localhost:5432/ci npm run db:validate
```

No CI, a sequência permanece explícita: instalar API → confirmar a versão 16.14 → rodar a suíte PostgreSQL completa → instalar/validar Prisma e aplicar o baseline/deploy dual-track → `smoke:pg` em banco recém-criado. O job `verificar` continua independente e cobre typecheck, testes de regra, schema Prisma, lint e build.

## 5. Estratégia de CI e critérios para um futuro fechamento

A próxima implementação autorizada, se houver, deverá:

1. Manter a imagem PostgreSQL pinada em `16.14` e a asserção de `server_version`; qualquer upgrade deve atualizar imagem, evidências locais e esta documentação no mesmo ciclo.
2. Rodar `test:pg` integral em banco isolado e `smoke:pg` em banco novo no job `testes-postgres`; não aceitar apenas um subset, smoke em memória ou `--skip` de testes PostgreSQL requeridos.
3. Preservar o teste de contrato tipo × coluna, a prova por mutação, os cenários E03 A/B/onboarding e os gates de Produção do ERP-02/02.1.
4. Capturar TAP/diagnóstico em annotation se `test:pg` falhar; manter a falha visível e sem mascarar o exit code.
5. Verificar no run final do PR os dois jobs (`verificar` e `testes-postgres`) no mesmo head; runs antigos ou de push isolados não substituem os checks do head atual.
6. Declarar contagens de pass/fail/skip/todo e a versão exata do servidor. O TODO conhecido P1-11 permanece identificado; não deve ser contado como teste executado nem ocultado. Uma nova decisão de escopo para P1-11 é independente deste plano.
7. Deixar o PR aberto até decisão humana; não usar merge automático.

## 6. Riscos, limites e controles

- **Tag de imagem flutuante:** `postgres:16` pode mudar patch sem alteração do repositório. Controle: tag `postgres:16.14` + verificação de `SHOW server_version`.
- **Banco temporário residual:** queda do processo ou falta de privilégio pode impedir cleanup. Controle: conta dedicada de CI, log do nome criado, cleanup `WITH (FORCE)`; usar `--keep` só em investigação autorizada.
- **Concorrência de fixtures:** compartilhar uma database entre suites pode mascarar conflitos ou gerar resultados não determinísticos. Controle: job isolado e `--test-concurrency=1` para `test:pg`.
- **Bootstrap parcial:** `/health` pode responder antes de migrations e admin terminarem. Controle existente: `smoke:pg` também espera o marcador de bootstrap.
- **Baseline Prisma dual-track:** o workflow trata como aceitável que a migration já esteja marcada; um futuro ciclo deve conferir o estado de `_prisma_migrations` no banco novo e não confundir mensagem de baseline com evidência funcional do smoke.
- **Engine Prisma local:** a execução local de `db:validate` pode ser bloqueada por rede ao baixar `schema-engine`; registrar a causa e usar o step CI aprovado, sem alterar schema só para contornar rede.
- **Gates distintos:** o smoke amplo não cobre sozinho concorrência, nem `test:pg` substitui os 126 checks de inicialização. Ambos são necessários.
- **Warnings preexistentes:** lint e runner podem emitir warnings; a próxima rodada deve manter a contagem explícita e distinguir warning de falha.

## 7. Fronteira de autorização

**ERP-03 READINESS: READY TO START** significa que o baseline, dependências, comandos, cobertura, riscos e critérios de CI estão mapeados. Não significa que uma próxima feature, migration ou gate tenha sido autorizada. A execução fica bloqueada até um comando futuro que delimite expressamente o trabalho; até lá, não alterar o smoke, módulos, frontend, schema ou migrations de ERP-03.
