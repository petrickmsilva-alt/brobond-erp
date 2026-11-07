# AUDIT-STANDARD — padrão de auditoria

**Data:** 2026-11-07 · **Branch:** `architecture/fase-1-foundation`
**Referência:** ADR-0012 (segurança/RBAC), `SECURITY-ARCHITECTURE.md`.

> **Invariante.** Toda operação relevante é auditável: **quem**, **em qual
> empresa**, **o quê**, **sobre qual registro**, **quando**, **de onde**,
> **com que resultado** — sem gravar segredo.

---

## 1. O que é registrado

Tabela `auditoria` (global, sem `empresa_id` — a empresa vai no payload do
evento). Cada evento grava:

| Campo | Origem |
|---|---|
| Usuário | ator autenticado (`actor.id`, `actor.name`) |
| Empresa | `escopoDoAtor` (empresa ativa da operação) |
| Ação | `create`/`update`/`delete`/ação de fluxo |
| Recurso | chave do `Resource` |
| Registro | `id` do registro afetado |
| Data/hora | ISO-8601 UTC com ms (`instanteAuditoriaISO`) |
| Origem | rota declarada (`req.route.path`), IP, user-agent |
| Resultado | sucesso/erro |
| Contexto | request id + correlation id (`observability.ts`) |
| Antes/depois | `diff` campo a campo |

O `diff` (`services.ts`) mascara `senha_hash` como `••••`; campos de segredo
saem **mascarados** (`mascararSegredo`), nunca em claro.

## 2. Cadeia de hashes (tamper-evidence)

`server/src/auditChain.ts`: cada evento grava `hash_anterior` + `hash =
SHA-256(hash_anterior | payload canônico)`. Editar um evento quebra o hash dele;
remover um evento quebra a cadeia do seguinte. `verificarCadeiaAuditoria`
percorre em ordem de `id` e lista registros comprometidos.

Datas são normalizadas para ISO-8601 UTC com ms antes de assinar
(`instanteAuditoriaISO`) — `JSONB` não tem tipo data nativo e a assinatura
precisa ser estável entre gravação e leitura.

## 3. O que NUNCA é registrado

- Senhas, tokens, segredos, chaves de API (mascarados ou omitidos).
- Corpo da requisição, query string, cookie, header `Authorization`
  (`observability.ts` não loga esses campos).
- IDs de texto livre: só UUID v4 é aceito de `X-Request-ID`/`X-Correlation-ID`
  (texto opaco pode conter CPF/e-mail/credencial).

## 4. Onde a auditoria é aplicada

- CRUD genérico: automática em `createRecord`/`updateRecord`/`deleteRecord`.
- Endpoints de fluxo: via `logAudit` explícito no serviço.
- Multiempresa: `auditoria-multiempresa.test.ts` prova o recorte por empresa.
- Retenção/consulta: somente pessoas autorizadas; a consulta passa por RBAC.

## 5. Critérios de aceite

1. Operação relevante gera evento com empresa + ator + antes/depois.
2. Segredo nunca aparece em claro no evento.
3. Cadeia de hashes verificável.
4. Evento consultável apenas por quem tem permissão.
5. Teste cobre gravação e verificação de integridade.
