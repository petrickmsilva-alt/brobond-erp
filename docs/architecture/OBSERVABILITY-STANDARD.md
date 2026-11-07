# OBSERVABILITY-STANDARD — logs, correlação e saúde

**Data:** 2026-11-07 · **Branch:** `architecture/fase-1-foundation`
**Referência:** `SECURITY-ARCHITECTURE.md`, `INTEGRATION-ARCHITECTURE.md`.

> **Objetivo.** Permitir responder, sem adivinhação: qual operação falhou, em
> qual domínio, em qual empresa, em qual integração, qual o erro, se houve
> retry, se houve duplicidade e se há risco de perda de dados.

---

## 1. Log estruturado (`server/src/log.ts`)

- Em produção (`NODE_ENV=production`) os logs saem como **JSON de uma linha**
  (`{ nivel, msg, ...extra, ts }`) — filtrável por máquina.
- Em desenvolvimento, formato legível com prefixo.
- Níveis: `info`/`warn`/`error`. Erro 5xx vira `log.error`; demais, `log.info`.
- Sentry é **opcional**: só inicializa com `SENTRY_DSN` definido. Sem a
  variável, nada acontece (nenhuma dependência paga é exigida).

## 2. Correlação (`server/src/observability.ts`)

- Middleware `requestObservability` gera/propaga **`X-Request-ID`** e
  **`X-Correlation-ID`**; o segundo herda o primeiro quando ausente.
- **Somente UUID v4** é aceito do cliente — texto opaco pode conter CPF/e-mail/
  credencial. Valor inválido é substituído por `randomUUID()`.
- O log de requisição usa a **rota declarada** (`req.route.path`), nunca o valor
  de `:token`/`:id`; nunca o corpo, a query, o cookie nem o header de auth.
- `res.locals.requestId`/`correlationId` ficam disponíveis ao handler.

## 3. Tenant no log

- A empresa (`empresa_id`) acompanha os logs de operação e de cron, derivada do
  escopo do ator/job — não do payload.
- O cron loga por destino/empresa (`scheduled.ts`), permitindo isolar a falha
  por tenant.

## 4. Saúde e métricas

- `GET /api/health` (rota pública) reporta o estado do processo.
- Contadores operacionais: itens de outbox pendentes/erro, dead-letter,
  tentativas, latência por rota (via log `http_request` com `latency_ms`).
- **Sem** ferramenta externa paga não autorizada.

## 5. Logs de jobs, workers e integrações

- Cron: `scheduled.ts` com `withCronIdempotency` — a chave de idempotência inclui
  empresa + data, evitando execução dupla e permitindo rastrear a execução.
- Outbox: cada transição (`PENDENTE`→`PROCESSANDO`→`CONCLUIDO`/`ERRO`) é
  registrada; `alerta` é o tipo de outbox para falhas que precisam de gente.
- Integrações: falha externa → 502 + dead letter com `ultimo_erro`; nunca 500
  silencioso nem perda silenciosa.

## 6. Matriz pergunta → evidência

| Pergunta | Onde responder |
|---|---|
| Qual operação falhou? | `log` da rota + `auditoria` |
| Em qual domínio? | recurso/módulo + rota |
| Em qual empresa? | `empresa_id` no log/cron |
| Em qual integração? | log do conector/provider + outbox |
| Qual o erro? | `ultimo_erro`/`error_code` + `log.error` |
| Houve retry? | `tentativas` + `proxima_tentativa_em` |
| Houve duplicidade? | chave única `(empresa,tipo,chave)` |
| Risco de perda? | dead-letter + status do outbox |

## 7. Critérios de aceite

1. Requisição carrega request id + correlation id.
2. Log não vaza dado sensível nem valor de `:id`.
3. Cron e outbox rastreáveis por empresa.
4. Health check disponível.
5. Sentry é opt-in (não obrigatório).
