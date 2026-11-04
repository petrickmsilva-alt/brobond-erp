# Coordenação PostgreSQL de cron

A fundação em `server/src/cronLock.ts` e a migration `0098_cron_job_locks.sql`
estão **integradas** a `executarProcessoCron` e às unidades dos cinco jobs.
O relatório de decisão, evidência, limites de provedor externo e rollback está
em `docs/auditoria/conclusao-hardening-distribuido.md`.

Não ativar cron, não fazer merge nem deploy com base neste arquivo.
