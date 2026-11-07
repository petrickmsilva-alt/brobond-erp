# API-STANDARDS — contratos de API

**Data:** 2026-11-07 · **Branch:** `architecture/fase-1-foundation`
**Referência:** ADR-0009 (padrão de APIs), `API-CONTRACTS.md` (Fase 0).

> **Invariante.** Uma rota declara: validação de entrada, autorização no
> servidor, formato de resposta/erro, paginação e idempotência quando há efeito
> externo. Não quebrar contrato existente sem estratégia de compatibilidade.

---

## 1. Estrutura

- **REST** sob `/api/*`.
- **CRUD genérico** por recurso (`GET/POST/PUT/DELETE /api/:recurso`), dirigido
  por metadados (`resources.ts`).
- **Handlers especializados** por domínio (fluxo, relatório, ação) quando a
  operação não é CRUD.
- **Routers montados** com `app.use('/base', router)`; rota pública **antes** do
  `requireAuth`.

## 2. Validação de entrada

- Declarada como `Field` no `Resource` (`type`, `required`, `unique`,
  `maxLength`, `min`/`max`, `options`/`optionsFrom`, `pattern`, `patternMessage`).
- `validate.ts` valida e converte (trim, número, data, percentual).
- **Sem biblioteca de validação paralela** (ADR-0009): Zod só se um schema
  compartilhado passar a agregar valor real — decisão adiada, não tomada por
  conveniência.
- Referência (`type:'ref'`) é validada contra o **mesmo tenant**.

## 3. Respostas

- Sucesso devolve o registro/lista; campos sensíveis **mascarados**.
- Paginação, ordenação (`?sort=`, `?dir=`) e filtros (`?f.campo=`) no **servidor**;
  o recorte de empresa é somado por fora.
- `GET /api/meta` alimenta os formulários do front (fonte única dos metadados).

## 4. Erros

- `HttpError(status, message, extra?)`: 400 validação, 401 não autenticado, 403
  autorização, 404 cross-tenant/inexistente, 405 operação não permitida no
  recurso, 409 conflito, 502 integração externa.
- Nunca devolver stack trace. Nunca engolir exceção.
- Erro de validação pode trazer `fields` para o formulário.

## 5. Autorização

- Toda ação protegida passa por `checkAccess`/guard **no backend** (ADR-0012).
- `ops` fechado força o fluxo pelo endpoint próprio.
- Frontend **não** é autoridade: esconder botão não autoriza.

## 6. Idempotência

- Endpoint com efeito externo aceita **chave de idempotência** (ex.: checkout,
  webhook, outbox).
- Webhooks de entrada: `at-least-once`, deduplicação por id, out-of-order safe.

## 7. Versionamento e compatibilidade

- Mudança **aditiva** por padrão; campo/rota nova não quebra o cliente.
- Remoção/quebra exige estratégia de compatibilidade documentada no PR.
- Contratos críticos documentados em `API-CONTRACTS.md`.

## 8. Critérios de aceite

1. Rota nova declara validação + autorização.
2. Erro no formato padrão.
3. Paginação/ordenação/filtro no servidor.
4. Efeito externo idempotente.
5. Nenhuma regra comercial só no frontend.
6. Contrato crítico documentado.
