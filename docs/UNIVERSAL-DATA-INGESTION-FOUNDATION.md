# Universal Data Ingestion Engine — Foundation (Fase 1)

## Status
Foundation branch: `feature/universal-data-ingestion-engine`.
This document describes the additive foundation committed for review. Production database migration has **not** been applied.

## Non-negotiable ingestion contract
- Original uploaded bytes are retained unchanged in `arquivo_original`; parsed values never replace the source.
- SHA-256 is computed from the original bytes and used for same-user/company duplicate detection.
- Every session is tenant-scoped (`empresa_id`) and user-owned (`usuario_id`).
- Analysis, interpretation, reconciliation, and preview are stored as separate JSONB checkpoints.
- Writes to ERP records must occur only after explicit approval, and only approved mappings may be used.
- Unknown fields must remain represented in source/inventory and may not be discarded or silently mapped.
- Existing ERP product, variation, price and stock engines remain the canonical write targets.
- Import session state is constrained to the explicit lifecycle: received, analyzing, mapping required, awaiting approval, approved, importing, completed, failed, cancelled.

## Durable schema
Migration `0128_importacao_universal_fundacao.sql` creates `importacao_universal_sessoes` with:
- original filename, MIME, byte count, SHA-256, original file bytes;
- tenant and owner references;
- lifecycle status and version;
- sheet inventory, semantic interpretation, reconciliation, and preview checkpoints;
- approval actor/time, import start/finish, result and error fields;
- tenant/user/status indexes and duplicate-file uniqueness.

Migration 0128 is mirrored in both `db/schema.sql` and `db/bootstrap.sql`; exact parity was checked against the canonical migration.

## Storage decision
Neon Object Storage is unavailable for the existing Neon project because it is hosted in `aws-sa-east-1`, a region unsupported by Neon Object Storage. The foundation therefore stores the original source bytes as PostgreSQL `BYTEA`. This is durable and exact, but implementation must enforce a conservative upload-size ceiling, stream/buffer safely, and monitor database size. Do not migrate region or create another Neon project as a workaround without a separate decision.

## Next implementation checkpoints
1. Confirm migration and bootstrap mirror parity (automated test).
2. Add upload/session endpoints with strict file size and content-type validation.
3. Implement workbook-wide sheet inventory, formulas/cell metadata and CSV parsing.
4. Persist analysis checkpoints without mutating ERP tables.
5. Build semantic mapping, entity detection and reconciliation.
6. Build full preview + mapping review/approval UI.
7. Execute approved writes using existing services inside tenant-scoped transactions.
8. Add idempotency, concurrency protection, retry/checkpoint and post-import audit.
9. Add tests and run repository CI gates.
10. Deploy only after CI and production DB migration review pass.

## Limitations in this execution environment
- A local terminal command was attempted on the authorized desktop but was blocked before execution by the Desktop Commander shell safety check. Therefore local typecheck/test/lint/PG tests have not been run.
- Render exposes one workspace, but the Render integration requires the workspace to be explicitly confirmed by the user before service actions. No service was changed or deployment triggered.
- No SQL has been executed against Neon production. The migration is currently branch-only.

## Blocos 1–9 — checkpoint de retomada (2026-11-19)

- **Estado de base após a interrupção:** worktree `brobond-universal-ingestion` limpo no commit `381591ff302bcd10de16ffe54870d0a269319d25`; branch `feature/universal-data-ingestion-engine` tracking `origin/main`. Nenhum trabalho anterior foi perdido ou sobrescrito.
- **Bloco 1 — concluído (implementação; validação fica para Bloco 9):** editor explícito de relacionamentos entre abas; origem/destino, campos, tipo de relação; sugestões editáveis e criação/remoção manual; validação server-side; persistência no checkpoint `interpretacao.mapeamentoConfirmado.relacionamentos`; contagem de valores coincidentes e confiança recalculadas a partir dos dados originais; confirmação não libera gravação no ERP.
- **Alterações do Bloco 1:** `client/src/pages/ImportacaoUniversalPage.tsx` e `server/src/importacaoUniversalHandler.ts`.
- **Bloco 2 — concluído (implementação; validação fica para Bloco 9):** modelo de dependências por entidade e etapa; classificação ajustada para Produto, SKU, Variação, Estoque, Preço e Movimentação; resolução de abas-pai candidatas e vínculos sugeridos/confirmados; bloqueios quando pai não existe, vínculo não foi confirmado ou chave confirmada não tem coincidência; modelo é retornado na análise e recalculado ao salvar mapeamentos/relacionamentos.
- **Alterações do Bloco 2:** `server/src/importacaoUniversalEntidades.ts`, `server/src/importacaoUniversalHandler.ts` e `client/src/pages/ImportacaoUniversalPage.tsx`.
- **Bloco 3 — concluído (implementação; validação fica para Bloco 9):** reconciliação multidimensional com vínculos confirmados entre abas, métricas de chaves compartilhadas/órfãos/duplicatas, conflitos dimensionais por SKU (barcode, cor, tamanho, categoria e coleção), detecção de dependentes sem produto e refinamento do conflito de barcode para não tratar o mesmo SKU em abas relacionadas como duplicata automática; snapshot ERP passa a carregar cor e tamanho de variações.
- **Alterações do Bloco 3:** `server/src/importacaoUniversalRecon.ts`, `server/src/importacaoUniversalHandler.ts` e `client/src/pages/ImportacaoUniversalPage.tsx`.
- **Bloco 4 — concluído (implementação; validação fica para Bloco 9):** prévia consolidada paginada (50 registros/página) com origem, linha, entidade, principais dimensões, status e campos mapeados; resumo por entidade/status; tabela de correspondências; métricas multidimensionais e divergências; visualização permanece somente leitura.
- **Alterações do Bloco 4:** `server/src/importacaoUniversalRecon.ts` e `client/src/pages/ImportacaoUniversalPage.tsx`.
- **Bloco 5 — concluído (implementação; validação fica para Bloco 9):** gate de aprovação explícita, tenant/owner-scoped; hash SHA-256 da prévia vinculando sessão, empresa, arquivo, versão, mapeamentos confirmados e reconciliação; aprovação compare-and-set por versão; bloqueio de conflitos, ambiguidades, órfãos e campos desconhecidos; status `aprovado` e aprovador/data persistidos. A aprovação não grava produtos nem saldos.
- **Alterações do Bloco 5:** `server/src/importacaoUniversalHandler.ts`, `server/src/index.ts` e `client/src/pages/ImportacaoUniversalPage.tsx`.
- **Bloco 6 — executor transacional implementado (validação pendente do Bloco 9):** executor tenant/owner-scoped, sessão com `FOR UPDATE`, isolamento SERIALIZABLE, hash de aprovação revalidado, criação/atualização de produto por SKU, criação de variação com vínculo pai e tamanho, atualização de preço, movimentação pelo motor oficial, saldo absoluto convertido em delta após movimentos, criação idempotente de cliente/fornecedor por documento/e-mail, rollback total em qualquer erro. Linhas de tabela genérica são marcadas como ignoradas, mas bytes originais são preservados. Executor não escreve no ERP em status diferente de `aprovado`.
- **Alterações do Bloco 6:** `server/src/importacaoUniversalExecutor.ts`, `server/src/services.ts` (suporte a transação externa em `createRecord`), `server/src/index.ts`.
- **Bloco 7 — auditoria/rastreabilidade implementado (validação pendente do Bloco 9):** auditoria por registro com sessão, SHA-256, aba, linha, chave e operação; auditoria de resumo da execução na mesma transação; resultado persistido com total criado/atualizado/ignorado, linhas e timestamps; falha persiste diagnóstico e marca rollback total.
- **Alterações do Bloco 7:** `server/src/importacaoUniversalExecutor.ts`.
- **Bloco 8 — interface operacional e retomada implementado (validação pendente do Bloco 9):** botão de execução explícita pós-aprovação, painel de resultados por linha, status de falha/retomada, endpoint de retry com hash revalidado e CAS de versão, carregamento de sessão pelo UUID reconstruindo a análise a partir dos bytes originais e verificando SHA-256 antes de reabrir. Campos de mapeamento/relacionamento editados invalidam o gate local.
- **Alterações do Bloco 8:** `server/src/importacaoUniversalHandler.ts`, `server/src/importacaoUniversalExecutor.ts`, `server/src/index.ts` e `client/src/pages/ImportacaoUniversalPage.tsx`.
- **Bloco 9 — pendente:** typecheck, lint, testes unitários e de integração disponíveis, revisão de migration/bootstrap parity, auditoria de transação/idempotência/tenant/rollback e correção de todos os achados. Nenhum deploy nem migration de produção.
- **Testes e auditorias:** deliberadamente não executados durante os blocos 1–8. Concentrar todos os testes e auditorias no Bloco 9, conforme autorização do Diretor.
- **Sequência restante:** Bloco 9 — validação completa e correção dos achados, sem deploy.
- **Segurança de ambiente:** `allowedDirectories` do Desktop Commander foi ampliado apenas para o worktree dedicado `C:\Users\Petrick Martins\Desktop\brobond-universal-ingestion`, mantendo os diretórios anteriores. O worktree principal `brobond-erp` com alterações preexistentes permanece intocado.
\n\n## Atualização Bloco 9 — validação em andamento (19-11-2026)\n\n- Typecheck global (domain/server/client): PASS, exit code 0.\n- Prisma schema validation (`DATABASE_URL` de teste sintética): PASS.\n- Testes focados de reconciliação: 17/17 PASS.\n- Testes focados do executor: 4/4 PASS.\n- Build Vite do cliente: PASS.\n- Auditoria arquitetural: PASS, sem erros.\n- ESLint direcionado aos arquivos da ingestão e integrações: 0 erros, 124 warnings (inclui `any` e variáveis não usadas; warnings não bloqueiam).\n- Paridade SQL migration 0128 / schema.sql / bootstrap.sql: PASS, blocos idênticos. `bootstrap.sql` foi corrigido nesta validação para espelhar a migration canônica 0128.\n- Suíte completa de testes de cliente: em execução; resultados parciais até este registro mostram suites aprovadas, além de `src/pwaRotasServidor.test.ts` com 6 testes skip. O processo ainda não retornou resumo final.\n- Suíte completa de testes do servidor e testes PostgreSQL de integração: não concluídos; integração PG requer banco de testes isolado.\n- Nenhum deploy, push, migration de produção ou gravação de dados reais executado.\n\nEsta seção atualiza e substitui as afirmações anteriores de validação pendente deste documento.