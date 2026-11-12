# Diagnóstico de conexão à produção (Neon) — execução manual

Workflow: `.github/workflows/brobond-migracao-producao.yml`
Executor: `scripts/diagnostico-conexao-producao.ts`
Verificador: `scripts/verificar-workflow-diagnostico.mjs`

## O que o workflow faz

Abre **uma** conexão com o PostgreSQL publicado e roda apenas consultas de leitura para
identificar o destino:

- `current_database()`, `current_user`, `current_schema()`, `version()`, `now()`;
- estado da cifra da conexão (`pg_stat_ssl`);
- GUCs publicadas pelo Neon: `neon.project_id`, `neon.branch_id`, `neon.branch_name`,
  `neon.endpoint_id`, `neon.timeline_id`;
- impressão digital do schema: `schema_migrations` e a tabela-marcador (`empresas`).

A sessão roda em transação `READ ONLY` e termina com `ROLLBACK`. O script **nunca** imprime a
`DATABASE_URL`, usuário, senha, tokens ou variáveis de ambiente — a origem aparece apenas como
`host:porta/banco`.

## O que o workflow NÃO faz

Nenhuma escrita: sem `INSERT`, `UPDATE`, `DELETE`, `TRUNCATE`, `DROP`; sem migração, saneamento,
carga cadastral, alteração de estoque, publicação ou sincronização externa. Isso é verificado
automaticamente pelo step "Verificação estática do workflow" (e pelo teste `workflow-diagnostico`).

## Pré-requisitos (GitHub → Settings → Environments → `production`)

| Tipo | Nome | Valor |
|---|---|---|
| Secret | `DATABASE_URL` | credencial do banco publicado (Neon) |
| Variable | `NEON_PROJECT_ID` | id do projeto BROBOND-ERP no Neon (obrigatório) |
| Variable | `NEON_BRANCH_NAME` | `production` (opcional; é o padrão) |
| Variable | `NEON_BRANCH_ID` | id da branch (opcional; alternativa ao nome) |

Sem `NEON_PROJECT_ID` o workflow interrompe antes de conectar: o destino não é confirmável.

## Como executar

1. GitHub → **Actions** → **Brobond — Diagnóstico de conexão à produção (Neon, somente leitura)**.
2. **Run workflow** → branch `ops/workflow-migracao-producao-diagnostico` → **Run**.
3. O job aparece no environment `production` (sujeito às regras de proteção do environment).

Via CLI:

```
gh workflow run brobond-migracao-producao.yml \
  --repo petrickmsilva-alt/brobond-erp \
  --ref ops/workflow-migracao-producao-diagnostico
```

## Como ler o resultado

- `✔ Destino CONFIRMADO` — host do Neon, `neon.project_id` esperado, branch `production` e o
  schema do ERP. Saída 0.
- `✖ DESTINO NÃO CONFIRMADO` — alguma verificação reprovou; a execução para com saída ≠ 0 e
  **nenhuma operação** é executada. As linhas `✖` dizem qual sinal faltou.

## Observação sobre o primeiro disparo

O gatilho `workflow_dispatch` só aparece na aba Actions depois que o arquivo existe na branch
padrão (`main`). Nesta homologação o arquivo vive apenas na branch
`ops/workflow-migracao-producao-diagnostico`; enquanto não houver merge, dispare pelo CLI com
`--ref` (o comando acima) ou faça o merge quando o Diretor autorizar.

## Verificação local (sem banco)

```
node scripts/verificar-workflow-diagnostico.mjs
```

Sem `DATABASE_URL`, contra PostgreSQL local sem TLS:

```
PGSSL=false DATABASE_URL=postgresql://brobond:brobond@127.0.0.1:5433/algum_banco \
  node --import tsx scripts/diagnostico-conexao-producao.ts --projeto=<id> --branch=production
```
