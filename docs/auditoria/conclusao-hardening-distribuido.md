# Conclusão do hardening distribuído — APROVADO COM BLOQUEIO EXTERNO IDENTIFICADO

## Decisão

**APROVADO COM BLOQUEIO EXTERNO IDENTIFICADO.**

Os cinco jobs (`relatorios`, `pagamentos`, `publicacoes`, `pedidos`, `crm`) passam
a coordenar exclusão, lease, heartbeat, fencing de escrita PostgreSQL e
idempotência persistente por unidade estável. A evidência multiprocessos foi
medida em PostgreSQL 16.14 isolado, localhost, bancos novos vazios. **Não há
autorização para ativar cron, merge ou deploy.** Efeitos em provedor externo
continuam no máximo at-least-once: nenhum provedor usado aqui oferece
transação distribuída nem chave de idempotência comprovada ponta a ponta.

## O que foi implementado

Migração versionada `db/migrations/0098_cron_job_locks.sql` (reversível por SQL
documentado no próprio arquivo; o runner do projeto não executa descida
automática). Tabelas:

- `cron_job_locks`: uma linha por `job_id`, `owner_id`, `execution_id`,
  `fencing_token` monotônico, aquisição, heartbeat, expiração, estados
  `HELD`/`RELEASED`.
- `cron_work_items`: único `(job_id, idempotency_key)`, `entity_id`, estados
  `PENDING`, `PROCESSING`, `COMPLETED`, `FAILED`, `RETRYABLE`, `ABANDONED`,
  tentativas, token da execução.

`server/src/cronLock.ts` atomiza aquisição com `INSERT … ON CONFLICT … DO UPDATE
… WHERE` (liberado ou expirado). Renovação e liberação exigem dono + execução +
token + não expirado. Heartbeat sinaliza perda uma vez. `executeCronUnit` valida
o lease com `SELECT … FOR UPDATE` no mesmo cliente da unidade interna; callback
não pode chamar provedor externo. `claimCronUnit` / `completeCronUnit` /
`failCronUnit` cobrem o ciclo em que o efeito sai do banco. `withCronIdempotency`
no-op sem lease (demonstração/memória) e persiste a chave quando o cron detém o
lease. Escritas do `PgStore` (`insert`/`update`/`remove`/`tryUpdateIf`) acrescentam
`EXISTS` no `cron_job_locks` vigente via `AsyncLocalStorage`; token expirado não
confirma a linha.

`executarProcessoCron` mantém o `Set` local (mesma instância, inclusive timeout)
e, com `DATABASE_URL`, adquire o lease distribuído antes do executor. Recusa
cruzada: `409 ja_em_execucao`. Falha de banco na aquisição: `503` motivo `erro`
(fail-closed; o job não corre sem lock). Heartbeat acompanha o trabalho; a
liberação só ocorre quando o trabalho termina, inclusive após timeout da
resposta. `processarComercioAgendado` (intervalo interno fora de teste) e as
drenagens oportunistas da fila de publicação disputam os mesmos `job_id`. Em
`NODE_ENV=test` esses caminhos oportunistas não entram na disputa, para não
flocular as suítes existentes; o cron HTTP/testes multiprocessos sempre
disputam.

Unidades estáveis (quando há lease):

| Job | Chave | Observação |
|---|---|---|
| `relatorios` | `relatorios:{tipo}:{empresaId}:{YYYY-MM-DD}` | Reexecução no mesmo dia civil não reenvia. E-mail é at-least-once se a queda ocorrer após o SMTP e antes de `COMPLETED`. |
| `pagamentos` | `pagamentos:intent:{id}:{status}` e `pagamentos:webhook:{id}:{tentativas}` | Motor e outbox de reembolso já tinham CAS; a chave soma a camada persistente. |
| `publicacoes` | `publicacoes:{id}:{estado}` | CAS `QUEUED→PUBLISHING` permanece; ML/Nuvemshop seguem suspensos. |
| `pedidos` | `outbox:{id}:{claim_versao}:{estado}` | Ingestão de marketplace conserva o claim próprio; o job inteiro é exclusivo pelo lease. |
| `crm` | `crm:lembrete:{atividadeId}` | CAS `lembrete_enviado_em` permanece; notificação após claim ainda pode se perder se o canal falhar (regra anterior). |

## Evidência multiprocessos (PostgreSQL real)

Cluster descartável 16.14 em `127.0.0.1:55439`, autenticação trust, sem dados de
produção. Comando:

```
CRON_LOCK_TEST_DATABASE_URL=<brobond_test_* vazio>
CRON_JOBS_TEST_DATABASE_URL=<outro brobond_test_* vazio>
npm run test:cron-lock:pg
```

Resultado desta sessão: **2 testes, 2 passaram, 0 falhas, 0 skips.**

1. Primitivas (`cron-lock-distributed-pg.ts`), banco só com a migration 0098:
   quatro processos por job (20 tentativas, 5 aquisições); cinco jobs em
   paralelo; duas unidades concorrentes → uma escrita; heartbeat válido e de
   dono perdido; rollback de unidade + retry; morte `SIGKILL`, expiração, duas
   recuperações simultâneas (uma vence); token antigo recusado em renovar,
   liberar e `executeCronUnit`; expiração no meio da transação reverte o
   efeito; recusa após pool fechado.
2. Jobs reais (`cron-jobs-distributed-pg.ts`), bootstrap + cadeia versionada:
   quatro processos chamam `executarProcessoCron` de cada job → **1×200 e 3×409
   `ja_em_execucao` por job**; os cinco jobs em paralelo → cinco `200`; token
   expirado não altera `empresas` via `PgStore.update`; token vigente escreve;
   reexecução após liberar → `200`.

CI (`testes-postgres`) cria dois bancos vazios e roda o mesmo script. Nada
disso foi mockado nem serializado no mesmo processo como prova.

## O que o lock não cobre

- SMTP, gateway de pagamento, Mercado Livre, Nuvemshop, WhatsApp: sem
  exatamente-uma-vez. Crash após envio e antes de `COMPLETED` pode reenviar.
- Chamadas diretas a `processarFilaPublicacoes` / `processarOutbox` /
  `runPaymentJobs` **sem** lease (testes e alguns ganchos) continuam só com o
  CAS da fila.
- Worker interno em `NODE_ENV=test` não disputa o lock.
- CRM ainda pode marcar lembrete e falhar o canal depois (comportamento
  anterior).
- Escritas que não passam pelo `PgStore` (SQL cru em conectores, por exemplo)
  não herdam o `EXISTS` automaticamente.
- A trava local sem `DATABASE_URL` (demonstração) não coordena instâncias.

Não foram removidos os bloqueios de Mercado Livre e Nuvemshop. Recorrências
financeiras continuam fora do cron.

## Credenciais (entrega anterior, preservada)

Fallback de senha administrativa removido; boot recusa `ADMIN_PASSWORD` vazia;
CI e testes PG geram senha; valor legado só em denylist/testes negativos.
Varredura geral de segredos **não** está comprovada. Nenhuma credencial externa
foi rotacionada. PIX sandbox sem credencial permanece não executado.

## Gates desta sessão

| Gate | Resultado | Limite |
|---|---|---|
| `npm run typecheck` (domain + server + client) | passou | — |
| `npm run lint` | 0 erros, 612 avisos pré-existentes | nenhum aviso novo nos arquivos desta correção |
| `npm run build` | passou (`✓ built in 21.31s`) | — |
| Cron em memória | 30/30 | sem PostgreSQL, como o contrato desses testes |
| Matriz de env (`config-inventario-producao`) | 5/5 após remover variável de teste | hold de disputa é `definirHoldDeTesteCron`, não env |
| `npm run test:cron-lock:pg` | 2/2 | PostgreSQL 16.14 isolado, dois bancos `brobond_test_*` vazios |
| Suíte servidor completa | **2024 testes, 1942 passaram, 0 falhas, 82 skips** | 82 skips: 81 cobertos pelo gate PG com `psql`; 1 PIX sandbox sem credencial. |
| Gate `test:pg` | bloqueado neste ambiente: **não há `psql`** | 13 testes exigem o binário; o gate recusa skip. Sem shim. |
| Cliente sob carga | não reexecutado nesta correção | retry isolado anterior 1.151/1.151 |

Os 82 skips do servidor foram classificados no relatório anterior desta branch
(`docs/auditoria/conclusao-hardening-distribuido.md` na revisão `bcdbf9f`): 81
cobertos pelo gate PG, 1 sem credencial PIX. Não se inventou credencial.

## Rollback

Somente manutenção autorizada, workers parados, nunca em produção sem ordem:

```sql
BEGIN;
DROP TABLE IF EXISTS cron_work_items;
DROP TABLE IF EXISTS cron_job_locks;
DELETE FROM schema_migrations WHERE id = '0098_cron_job_locks.sql';
COMMIT;
```

Não reverte e-mail, cobrança nem publicação já enviados. O runner reaplica 0098
no próximo boot se o registro sumir.

## Git

Branch fixa da sessão: `arena/615f44fd-brobond-erp`. Sem force-push, sem merge,
sem deploy, sem PR encerrado. Commits anteriores da entrega parcial
(`06cfd67`, `f965c8c`, `7044a34`, `bcdbf9f`) preservados.
