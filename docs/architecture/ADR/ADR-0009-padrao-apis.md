# ADR-0009 — Padrão de APIs

* **Identificador:** ADR-0009
* **Título:** Padrão de APIs (REST + metadados + validação)
* **Status:** Aceita
* **Data:** 2026-11-07
* **Relacionados:** ADR-0003, ADR-0012

## Contexto

A API é dirigida por metadados (`resources.ts`) com CRUD genérico e handlers
especializados; validação em `validate.ts`; erros em `HttpError`.

## Problema

Definir um padrão único de rota, payload, resposta, erro, paginação,
idempotência e autorização.

## Decisão

1. **REST** sob `/api/*`; CRUD genérico por recurso; handlers especializados por
   domínio.
2. **Validação tipada** por `Field` (`type`, `required`, `unique`, `maxLength`,
   `options`/`optionsFrom`); nunca duplicar biblioteca de validação.
3. **Erros** com status + `fields`/`code`/`details` (`HttpError`).
4. **Paginação** no servidor; recorte de empresa sempre somado.
5. **Idempotência** por chave onde há efeito externo.
6. **Autorização** no servidor (`checkAccess`/guard).
7. **Não quebrar contrato** existente sem estratégia de compatibilidade.

## Alternativas consideradas

- **GraphQL:** rejeitada. A API REST + metadados já atende; trocar não traz
  benefício proporcional ao risco.
- **Zod por handler:** rejeitada enquanto duplicaria `validate.ts` (avaliar na
  Fase 1 se um schema compartilhado agrega).

## Consequências

- Um único caminho de validação e autorização.
- `GET /api/meta` alimenta formulários do front.

## Riscos

- Handlers especializados fora do padrão → auditados por gate.
