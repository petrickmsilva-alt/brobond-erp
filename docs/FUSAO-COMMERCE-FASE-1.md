# Fusão Commerce → ERP — Fase 1 (Brobond AI ERP)

> **Decisão arquitetural (Diretoria, 2026-10-05):** o `brobond-erp` é a **base
> principal** do ecossistema e passa a se chamar **Brobond AI ERP**. O
> `brobond-ai-commerce` é integrado a ele como **módulo de conectores
> multicanal**.
>
> A Fase 1 prepara o terreno: unifica os bancos no Prisma, cria a estrutura do
> módulo e as variáveis de ambiente dos canais. **Nenhum código do servidor foi
> alterado** — o middleware de login e toda a segurança atual permanecem
> intactos.

---

## 1. O que foi feito

| #   | Entrega                                                                                             | Onde                                                         |
| --- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| 1   | Schema Prisma **unificado** (modelos âncora do ERP + modelos core de conectores/vendas do commerce) | `prisma/schema.prisma`                                       |
| 2   | Migration inicial **`fusion_commerce_into_erp`** (SQL idempotente)                                  | `prisma/migrations/20261005120000_fusion_commerce_into_erp/` |
| 3   | Mesma migration no runner versionado do ERP (boot aplica sozinho)                                   | `db/migrations/0012_fusion_commerce_into_erp.sql`            |
| 4   | Espelho da fusão no bootstrap idempotente (instalações novas)                                       | `db/schema.sql` (seção 0012)                                 |
| 5   | Pasta do módulo reservada para receber os conectores na Fase 2                                      | `modules/connectors/`                                        |
| 6   | Variáveis de ambiente do Mercado Livre, Shopee, Mercado Pago e TikTok                               | `server/.env.example` (+ chaves opcionais no `render.yaml`)  |
| 7   | Toolchain Prisma (CLI 6.12.0 — mesma versão do commerce) + scripts `db:*`                           | `package.json` (raiz)                                        |
| 8   | CI: `prisma validate` no job principal e `prisma migrate deploy` no job Postgres                    | `.github/workflows/ci.yml`                                   |

## 2. Contrato de migrations (dual-track) — LEIA ANTES DE MIGRAR

O ERP **não é gerenciado pelo `prisma migrate dev`**: ele aplica
`db/schema.sql` + `db/migrations/*.sql` no boot (`server/src/db.ts`), com
histórico em `schema_migrations`. A fusão mantém esse contrato e adiciona o
trilho Prisma (histórico em `_prisma_migrations`):

```
banco novo        boot do ERP ───────────────► tudo criado (schema.sql já espelha a fusão)
banco existente   boot do ERP (0012)  ──ou──  npx prisma migrate deploy
                              └──── os dois convergem: SQL idempotente, o 2º é no-op ────┘
```

**Regras:**

- A migration da fusão cria **apenas objetos novos** — nenhuma tabela, coluna
  ou índice do ERP é alterado (`usuarios` incluída).
- **Nunca** rode `prisma migrate dev` contra este banco: o shadow database não
  conhece as tabelas do ERP e a ferramenta tentaria reescrevê-las.
- Mudanças futuras no lado ERP: `db/schema.sql` + `db/migrations/NNNN_*.sql`
  (como sempre). Lado commerce: migrations Prisma criadas com `--create-only`
  e revisadas à mão.

## 3. Tenancy: `Organization` → `Usuario`

No commerce, todo registro pertencia a uma `Organization` (SaaS multi-tenant).
O ERP é **single-company**: a fronteira de identidade é a tabela `usuarios`
(e-mail + Argon2id + MFA + sessões). Por isso `organizationId` virou
`usuarioId` (FK → `usuarios.id`):

| Ação ON DELETE | Onde                                                               | Por quê                                                                                                                                                             |
| -------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **RESTRICT**   | `Connector`, `Sale`, `ConnectorEvent` → `usuarios`                 | No ERP usuário se **desativa** (`ativo`, `desativado_em`), não se apaga. Um DELETE acidental não pode destruir credenciais de marketplace nem histórico de receita. |
| **CASCADE**    | `ConnectorOAuthState` → `usuarios`                                 | Estado CSRF efêmero (minutos) — descartável por natureza.                                                                                                           |
| **CASCADE**    | `SaleItem` → `Sale`                                                | Item morre com a venda (mesma semântica de `itens_venda.venda_id`).                                                                                                 |
| **SET NULL**   | `SaleItem` → `produtos`/`tamanhos`; `ConnectorEvent` → `Connector` | O histórico sobrevive à exclusão do catálogo/conector.                                                                                                              |

> A unicidade `@@unique([usuarioId, provider])` preserva o contrato do
> commerce (um conector por provedor por responsável) para que o código movido
> na Fase 2 porte com alteração mínima (`organizationId` → `usuarioId`).

## 4. Modelo de dados injetado

**Enums** — `SaleChannel` (BROBOND, TIKTOK, INSTAGRAM, **SHOPEE,
MERCADOLIVRE, MERCADOPAGO**), `SaleStatus` (PENDING, PAID, REFUNDED,
CANCELLED), `ConnectorProvider` (TIKTOK, INSTAGRAM, SHOPEE, MERCADOLIVRE,
MERCADOPAGO), `ConnectionStatus` (DISCONNECTED, CONNECTED, EXPIRED, ERROR,
PENDING_APPROVAL, REAUTH_REQUIRED, SANDBOX_ACTIVE).

```
usuarios (ERP, intacta) ──RESTRICT──┬─ connectors ──SET NULL── connector_events
                                    ├─ sales ──CASCADE── sale_items ──SET NULL── produtos (ERP)
                                    └─ connector_oauth_states (CASCADE)    └──SET NULL── tamanhos (ERP)
```

| Tabela                   | Papel                                                                                                                                                                                                                          |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `connectors`             | Integração ativa com marketplace/meio de pagamento. Credenciais **cifradas em AES-256-GCM** (`CONNECTOR_ENCRYPTION_KEY`), KPIs reais de sincronização.                                                                         |
| `connector_events`       | Eventos brutos de webhook/polling com deduplicação `(usuario, provedor, id externo)`.                                                                                                                                          |
| `connector_oauth_states` | Estado CSRF do fluxo OAuth de conexão (SHA-256, expiração curta).                                                                                                                                                              |
| `sales`                  | Receita multicanal. Valores em **centavos** (convenção do motor financeiro do commerce). Chave de idempotência `(usuario, canal, pedido externo)` para reentregas de webhook. A venda B2B/offline do ERP continua em `vendas`. |
| `sale_items`             | Itens da venda casados no **catálogo real do ERP** (`produtos` + `tamanhos`), com `variacao_externa` para o match da Fase 2.                                                                                                   |

**Adaptações conscientes em relação ao schema do commerce:**

- `Sale.productId/creatorId/campaignId` (vínculos com Product/CreatorProfile/
  Campaign do commerce) foram substituídos por `items SaleItem[]` ligados ao
  catálogo do ERP.
- `SaleItem` é um modelo **novo** — no commerce a `Sale` apontava direto para
  um produto (venda de item único); pedidos de marketplace são compostos.
- Todas as colunas novas seguem o padrão snake_case do banco do ERP
  (`@map` em cada campo); timestamps são `TIMESTAMPTZ` como no ERP (o commerce
  usava `timestamp(3)`).

## 5. Variáveis de ambiente (conectores)

Definidas em `server/.env.example`; todas **opcionais** — sem elas o conector
fica `DISCONNECTED` e nada quebra. Callbacks/webhooks usam o `APP_URL` como
base (`${APP_URL}/api/connectors/<canal>/callback`).

| Canal         | Variáveis                                                                                                             |
| ------------- | --------------------------------------------------------------------------------------------------------------------- |
| Todos         | `CONNECTOR_ENCRYPTION_KEY` (AES-256-GCM das credenciais em repouso)                                                   |
| TikTok Shop   | `TIKTOK_SERVICE_ID`, `TIKTOK_APP_KEY`, `TIKTOK_APP_SECRET`, `TIKTOK_REDIRECT_URI` (todos do Shop Partner Center) |
| Shopee        | `SHOPEE_PARTNER_ID`, `SHOPEE_PARTNER_KEY` (+ `SHOPEE_API_BASE_URL` — Brasil usa host dedicado)                        |
| Mercado Livre | `MERCADOLIVRE_CLIENT_ID`, `MERCADOLIVRE_CLIENT_SECRET` (+ redirect/webhook/overrides)                                 |
| Mercado Pago  | `MERCADOPAGO_ACCESS_TOKEN`, `MERCADOPAGO_PUBLIC_KEY` (+ `MERCADOPAGO_WEBHOOK_SECRET`)                                 |

> ⚠️ A `CONNECTOR_ENCRYPTION_KEY` não deve ser trocada depois de conectar
> contas: a nova chave não decifra o que a antiga cifrou (conector fica
> `REAUTH_REQUIRED` e precisa ser reconectado).

## 6. Validação executada nesta fase (PostgreSQL 16 real)

1. **Três trilhos de aplicação** — boot (`db/schema.sql`), runner versionado
   (`db/migrations/0012`) e `prisma migrate deploy` (SQL da migration Prisma):
   todos aplicam limpo; reaplicação = no-op (idempotente).
2. **Preservação total do ERP** — catálogo comparado com um banco construído
   pelo schema **antes** da fusão: 50 tabelas, **548 colunas, 134 constraints
   e 128 índices sem nenhuma alteração**. As únicas adições são as 5 tabelas
   novas do commerce. O login (`usuarios`/`sessoes`/`login_tentativas`) está
   intacto.
3. **Integridade comportamental** — 30+ testes: FKs inválidas rejeitadas,
   enums restritos aos valores contratados (incl. SHOPEE/MERCADOLIVRE/
   MERCADOPAGO/TIKTOK), uniques de idempotência (reentrega de webhook
   rejeitada; pedido repetido em canal diferente aceito; venda própria com
   `external_order_id` NULL não colide), CASCADE/RESTRICT/SET NULL conforme a
   tabela acima, defaults (`DISCONNECTED`, `BROBOND`, `BRL`, contadores 0).
4. **Equivalência schema ↔ banco** — o `prisma/schema.prisma` foi comparado
   campo a campo (tipo, nulabilidade, default, FK + ação ON DELETE, unique,
   índice) com o catálogo real do banco: **equivalência total** nos 8 modelos.
   _Esta comparação pegou e corrigiu dois deslizes reais durante a fase:
   `@map` ausente em campos camelCase→snake_case e `@db.Timestamptz`
   ausente nos DateTimes do commerce._
5. **Regressão do ERP** — suíte `test:pg` (boot real + concorrência de saldo)
   4/4 no banco fusionado; suíte memdb 226/229 com **1 falha pré-existente**
   (`relatorios.test.ts` — "faturamento: consolida por mês"), reproduzida
   idêntica no commit anterior à fusão (comprovado em worktree do HEAD).
6. **CI** — `prisma validate` entra no job principal; o job Postgres ganhou o
   passo `prisma migrate deploy` para provar o dual-track a cada push.

### Como revalidar localmente

```bash
npx prisma validate            # schema unificado
npx prisma migrate status      # após apontar DATABASE_URL
npx prisma migrate deploy      # aplica a fusão num banco do ERP existente
npm --prefix server run test:pg   # com DATABASE_URL apontada (boot real)
```

## 7. Próximas fases (rascunho)

- **Fase 2** — mover os conectores do `brobond-ai-commerce` para
  `modules/connectors/`; instanciar o `PrismaClient` no servidor do ERP com o
  adapter `@prisma/adapter-pg` sobre o MESMO pool `pg` (a versão 6.12.0 já
  está fixada na raiz para paridade total com o commerce).
- **Fase 3** — painel de conectores no front do ERP (status, KPIs, fluxo
  OAuth por canal) e ingestão de pedidos (`sales`/`sale_items`) com casamento
  de catálogo (`produtos`/`tamanhos`).
- **Fase 4** — dashboards multicanal (split Brobond × Mercado Livre × Shopee ×
  TikTok × Mercado Pago) e conciliação com o financeiro do ERP.

> Nota sobre o nome: o pacote continua `brobond-erp` (scripts e deploys não
> mudam); a identidade "Brobond AI ERP" está na descrição do projeto e nesta
> documentação.
