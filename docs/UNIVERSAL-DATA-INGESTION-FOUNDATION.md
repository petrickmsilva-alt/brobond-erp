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

The bootstrap mirror was appended to `db/schema.sql` as required by repository conventions.

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
