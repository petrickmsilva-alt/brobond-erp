# ADR — Architecture Decision Records (ERP 3.0)

**Diretório:** `docs/architecture/ADR/`
**Data:** 2026-11-07 · **Branch:** `architecture/fase-0-blueprint`

> **Regra.** Cada ADR registra uma decisão **tomada** (não uma pergunta aberta).
> As decisões já aprovadas pelo Diretor aparecem como **aceitas**.

## ADRs deste programa

| ID | Título | Status |
|---|---|---|
| [ADR-0001](ADR-0001-modular-monolith.md) | Arquitetura Modular Monolith | Aceita |
| [ADR-0002](ADR-0002-fronteiras-dominios.md) | Fronteiras dos domínios e kernel compartilhado | Aceita |
| [ADR-0003](ADR-0003-fonte-canonica-dados.md) | Fonte canônica dos dados (SQL-first) | Aceita |
| [ADR-0004](ADR-0004-estrategia-multi-tenant.md) | Estratégia multi-tenant (`empresa_id`) | Aceita |
| [ADR-0005](ADR-0005-identidade-comercial.md) | Identidade comercial (empresa×canal×loja×plataforma×representante) | Aceita |
| [ADR-0006](ADR-0006-retail-wholesale.md) | RETAIL e WHOLESALE (multi-store WooCommerce) | Aceita |
| [ADR-0007](ADR-0007-descontinuacao-loja-nativa.md) | Descontinuação da loja pública nativa `/loja` | Aceita (Diretor) |
| [ADR-0008](ADR-0008-operacional-analitico.md) | Separação operacional × analítico (`vendas` × `sales`) | Aceita |
| [ADR-0009](ADR-0009-padrao-apis.md) | Padrão de APIs (REST + metadados + validação) | Aceita |
| [ADR-0010](ADR-0010-eventos-outbox-inbox.md) | Eventos e Outbox/Inbox | Aceita |
| [ADR-0011](ADR-0011-padrao-migrations.md) | Padrão de migrations | Aceita |
| [ADR-0012](ADR-0012-seguranca-rbac.md) | Segurança e RBAC | Aceita |
| [ADR-0013](ADR-0013-integracao-externa.md) | Estratégia de integração externa | Aceita |
| [ADR-0014](ADR-0014-prisma-sql.md) | Evolução do Prisma e SQL | Aceita |

## ADRs históricos (migrados / referenciados)

Os ADRs abaixo foram escritos antes deste programa e continuam válidos; são
**referenciados**, não duplicados:

| Documento | Tema |
|---|---|
| `docs/ADR-001-FONTE-UNICA-FATURAMENTO.md` | fonte única de faturamento |
| `docs/ADR-002-CRON-PROCESSOS-INDEPENDENTES.md` | cron em processos independentes |
| `docs/ADR-003-WEBHOOKS-ASSOCIADOS-A-EMPRESA.md` | webhooks por empresa |
| `docs/ADR-004-PAGBANK-SEGREDO-WEBHOOK-DEDICADO.md` | segredo de webhook por provider |
| `docs/ADR-005-MERCADOLIVRE-TOKEN-ESTATICO-CONTRATO.md` | token estático ML |
| `docs/ADR-006-NUVEMSHOP-GATE-ESCRITA-2025-03.md` | gate de escrita Nuvemshop |
| `docs/ADR-007-CLIENTE-CRON-RETENTATIVA.md` | retentativa de cron de cliente |
| `docs/ADR-008-IDENTIDADE-CANAL-COMERCIAL.md` | identidade de canal comercial (base do ADR-0005) |

**Convenção de ID:** os ADRs deste programa usam o prefixo `ADR-0000` para não
colidir com os históricos `ADR-001..008`.
