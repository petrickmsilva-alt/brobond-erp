# AGENTS.md — Brobond ERP

Monorepo: Next.js 15 / React 19 / TypeScript (client) + Node/Express/TS (server) + PostgreSQL + Redis. Multiempresa (empresa_id) e multi-loja (RETAIL/WHOLESALE).

## Comandos

- `npm run typecheck` — domínio + servidor + cliente.
- `npm --workspace server test` — suíte do servidor (`node --test`, sem banco).
- `npm --workspace client test` — suíte do cliente (vitest).
- `npm run lint` — ESLint (warnings pré-existentes são baseline; exigir 0 **errors**).
- `npm run architecture:audit` e `npm run audit:menu` — coerência recursos × tabelas × tenant × menu.
- `npm run test:pg` — gate PostgreSQL real; exige `DATABASE_URL` de banco **vazio** e PostgreSQL 16.14.

## Convenções

- **Ambiente de teste:** o shell pode ter `DATABASE_URL` exportado (ex.: `brobond_test`). Isso faz testes que deveriam pular rodarem contra banco sujo. Rode `unset DATABASE_URL` antes da suíte de memória.
- **Banco:** `db/schema.sql` (bootstrap estrutural) + `db/bootstrap.sql` (GERADO por `scripts/gerar-bootstrap.mjs`, testado por `prod-db-02-bootstrap-sync`) + `db/migrations/*.sql` (cadeia versionada, ordem léxica). Tabela nova entra em ambos: migração **e** espelho em `schema.sql`. Migrações são aditivas/idempotentes; nunca destrutivas.
- **Multiempresa:** recursos declaram `empresa: true`; escopo por `escopoDoAtor`. Tabelas com `empresa_id` sem recurso CRUD são aceitas quando o escopo é aplicado por endpoint próprio (padrão `gateway_*`, `payment_*`, `logistics_*`).
- **Outbox:** `commerce_outbox` é a fila única (claim CAS, backoff, dead-letter). Ações `logistics-*` são roteadas em `server/src/commerce/outbox.ts`.
- **Cron:** `server/src/scheduled.ts`, processos `relatorios|pagamentos|publicacoes|pedidos|crm`.
- **Integração WooCommerce:** registry multi-loja em `server/src/commerce/woocommerce/`. Pedido externo = `WOO-<LOJA>-<id>`.
- **Segredos:** nunca no código; cifrados (AES-256-GCM) em `configuracoes`. Toda variável de ambiente lida no código **precisa** de linha em `docs/auditoria/matriz-configuracao-producao.md` (teste `config-inventario-producao` trava isso), e toda chave do `render.yaml` também.

## Motor de logística (modules/logistics)

Desacoplado, reusa `ShippingProvider`/`envios`/`envio_eventos`/outbox/config cifrada.
Sem `LOGISTICS_ENABLED`, opera em modo seguro. Documentação: `docs/LOGISTICA-MOTOR-MULTICANAL.md`.
Transportadoras sem contrato nascem **desabilitadas** e nenhum endpoint é presumido.
