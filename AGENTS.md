# AGENTS.md — Brobond ERP

Monorepo: Next.js 15 / React 19 / TypeScript (client) + Node/Express/TS (server) + PostgreSQL + Redis. Multiempresa (empresa_id) e multi-loja (RETAIL/WHOLESALE).

## Comandos

- `npm run typecheck` — domínio + servidor + cliente.
- `npm --workspace server test` — suíte do servidor (`node --test`, sem banco).
- `npm --workspace client test` — suíte do cliente (vitest).
- `npm run lint` — ESLint (warnings pré-existentes são baseline; exigir 0 **errors**).
- `npm run architecture:audit` e `npm run audit:menu` — coerência recursos × tabelas × tenant × menu.
- `npm run test:pg` — gate PostgreSQL real; exige `DATABASE_URL` de banco **vazio** e PostgreSQL 16.14.

## CI (GitHub Actions)

- Os jobs `verificar` e `testes-postgres` rodam em **Node 24**. Não volte para o Node 22: o runner de `node --test` do v22.x lê o tamanho do quadro do protocolo como int32 COM SINAL; quando o stdout de um arquivo de teste traz texto NÃO-ASCII (acentos PT-BR + emoji do logger) logo após um quadro de relatório, esses bytes são interpretados como tamanho e o runner pai aborta com `Unable to deserialize cloned data due to invalid or unsupported version`, descartando o arquivo inteiro. É um bug do Node corrigido no v24 (#64706) e NÃO retroportado ao v22 (#65934). O sintoma é um `not ok` aleatório em qualquer arquivo, nunca no mesmo.
- `npm run architecture:audit` regenera `docs/ERP-3.0-ARCHITECTURE-INVENTORY.json`; quando o número de casos muda, o arquivo precisa ser commitado junto.

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

## Rastreabilidade por lote (migration 0106)

- **Saldo do lote é DERIVADO** das movimentações (`saldoDoLoteMov`/`saldoDoLoteInsumo` em
  `server/src/rastreabilidade.ts`) — nunca uma coluna de saldo. Não criar uma segunda
  fonte de verdade de estoque.
- `lote_id` é **opcional** em `movimentacoes`, `movimentacoes_insumos`,
  `compra_recebimento_itens` e `devolucao_fornecedor_itens`; FK composta
  `(empresa_id, lote_id)` recusa lote de outra empresa.
- Um lote é de **um produto OU de um insumo** (nunca ambos/nenhum) — `CHECK` no banco e
  `validarLote` em `server/src/loteValidacao.ts`.
- A cadeia usa os vínculos FORMAIS já existentes (compra → recebimento → item →
  movimentação → expedição → envio) + `lote_id`; consulta em
  `/api/rastreabilidade/{painel,lotes/:id,lote-por-codigo,movimentacao/:id,produto/:id,documento}`.
- Recurso `lotes`: `ops.delete = false` (histórico aponta para o lote; desativa-se, não se exclui).

## Gate PostgreSQL local (sandbox)

Há um container `postgres:16.14` rodando (`sudo docker ps` → `brobond-pg`, porta 5433).
Para rodar `npm run test:pg` (exige banco **vazio** e PG 16.14):

```
sudo docker exec brobond-pg psql -U brobond -d postgres \
  -c "DROP DATABASE IF EXISTS brobond_gate WITH (FORCE);" -c "CREATE DATABASE brobond_gate;"
export DATABASE_URL="postgresql://brobond:brobond@127.0.0.1:5433/brobond_gate"
export ADMIN_PASSWORD="$(node -e "process.stdout.write('A!'+require('crypto').randomBytes(24).toString('hex'))")"
export JWT_SECRET="$(node -e "process.stdout.write(require('crypto').randomBytes(32).toString('hex'))")"
npm run test:pg
```

O script `test-pg-gate.mjs` recusa banco reutilizado (`relações públicas != 0`).

## Fases 6–8 (Commerce, CRM, BI/Control Tower)

- **Fase 6 — Omnichannel** (`commerce_reconciliacao`): reconciliação multicanal é LEITURA;
  nunca sobrescreve dado canônico do ERP com dado externo. Painel em `/commerce/omnichannel`.
- **Fase 7 — CRM/Marketing/Loyalty**: RFM em `/customer-segments/rfm` (quintis reais no
  servidor); saldo de fidelidade é SOMA dos movimentos (nunca campo editável); estorno/
  expiração idempotentes por origem; opt-out LGPD bloqueia envio sem consentimento.
- **Fase 8 — BI & AI Control Tower** (migration 0112): motor de alertas
  (`server/src/alerts.ts`) + Tower (`server/src/controlTower.ts`). Regras:
  - Alerta é IDEMPOTENTE por `fingerprint` UNIQUE `(empresa_id, fingerprint)`: reabre
    quando volta a existir, resolve quando deixa de ser detectado. Não empilhar ocorrências.
  - **Alertar não é agir**: nenhum detector altera preço, estoque, pagamento, pedido ou
    campanha. A correção recomendada é texto.
  - Detector lê SOMENTE documento canônico; sem dado → sem alerta (nunca zero enganoso).
  - Tower é camada de LEITURA: indicador carrega `definicao`/`formula`/`origem`/`limitacoes`;
    valor ausente é `null` + limitação declarada, nunca 0. `GET /api/control-tower/painel`.
  - `alert_events.ops.delete = false` (histórico). Notificação externa segue interna até
    homologação — a regra guarda o canal, mas o envio externo não é presumido.
