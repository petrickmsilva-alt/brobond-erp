# API-CONTRACTS — contratos de API (Fase 0)

**Data:** 2026-11-07 · **Branch:** `architecture/fase-0-blueprint`
**Base:** `server/src/index.ts` (474 rotas), `resources.ts`, `validate.ts`,
`errors.ts`, `paginacaoCompleta.ts`, `services.ts`, `openapi.ts`.

---

## 1. Padrão de rota

| Aspecto | Convenção |
|---|---|
| Prefixo | `/api/*` |
| Recurso CRUD genérico | `/api/<recurso>` (`GET` lista, `POST` cria, `GET/:id`, `PUT/:id`, `DELETE/:id`) |
| Handlers especializados | `/api/<domínio>/<ação>` (ex.: `/api/estoques/disponivel`) |
| Bounded contexts | routers montados: `/api/payments/*`, `/api/logistics/*`, `/api/commerce/*` |
| Rotas públicas | registradas **antes** do `requireAuth` (health, auth, portal, catálogo, arquivos por token, agente de impressão) |
| Rate limit | `rateLimitPublico`/`rateLimitPortal` por rota pública |

---

## 2. Payload e validação

- **Validação tipada por metadados.** Cada `Field` em `resources.ts` declara
  `type` (text, money, date, ref, multiref…), `required`, `unique`,
  `uniqueEmpresa`, `maxLength`, `options`/`optionsFrom`. `validate.ts` coage e
  valida (números `"1.234,56"`, documento com dígito verificador, UF, CEP, GTIN).
- **`empresa_id` do corpo é ignorado** — o servidor carimba.
- **Referências** (`type: 'ref'`) são validadas contra o mesmo tenant.
- Não quebrar contrato existente sem estratégia de compatibilidade.

---

## 3. Respostas

| Situação | Forma |
|---|---|
| Lista | `{ rows, total, page, pageSize }` (paginado no servidor) |
| Item | objeto do recurso |
| Criação | `201` + recurso |
| Erro | `{ error, fields?, code?, details? }` via `HttpError` |

Códigos de erro estáveis para o front reagir (ex.: `reauth_necessaria`).

---

## 4. Erros (contrato)

| Status | Uso |
|---|---|
| `400` | entrada inválida (com `fields`) |
| `403` | sem permissão (RBAC) |
| `404` | inexistente **ou** de outro tenant (não vaza existência) |
| `409` | conflito (dependências vinculadas, período travado, estado inválido) |
| `502` | falha de integração externa (mensagem PT-BR do que conferir) |
| `503` | banco não pronto (bloqueioDeProntidao) |

---

## 5. Paginação, filtros e ordenação

- Listagem genérica: `?page=&pageSize=&sort=&dir=&f.<campo>=`.
- O servidor **sempre** soma o recorte de empresa ao filtro do cliente.
- Leitura completa (sem truncar histórico): `paginacaoCompleta.listarTodos`
  (falha explícita se a paginação vier incompleta).

---

## 6. Idempotência

| Operação | Chave |
|---|---|
| Efeito externo (outbox) | `(empresa_id, tipo, chave)` |
| Ingestão de pedido | `reference` + índice único de `sales` |
| Recebimento de compra | `idempotency_key` |
| Reserva de checkout | `uq_estoque_reservas_checkout` |
| Comissão | chave do fato |

---

## 7. Autorização no contrato

- Todo recurso declara sua alçada (`minPerfil`/`adminOnly`/`ops`).
- Handlers especializados chamam `checkAccess`/guard próprio.
- A empresa é resolvida do ator (`escopoDoAtor`) e validada
  (`assertRegistroDaEmpresa`).

---

## 8. Documentação

- `server/src/openapi.ts` expõe o contrato; `docs/architecture/payment-engine.md`
  e `docs/COMMERCE-WOOCOMMERCE-MULTI-STORE.md` documentam domínios críticos.

Detalhe formal: [`API-STANDARDS.md`](API-STANDARDS.md) (Fase 1).

---

*Próximo documento: [`EVENT-CATALOG.md`](EVENT-CATALOG.md).*
