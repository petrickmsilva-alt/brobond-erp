# ADR-004 — PagBank: segredo de webhook dedicado, falha fechada

* **Status:** aceita em 2026-11-04 (Fase 4.3, risco **R-10**). Implementada localmente. **Algoritmo não confirmado no provedor** (H-8 pendente).
* **Escopo:** `server/src/gateway.ts` (rota pública `POST /api/gateway/webhooks/:provider`), `modules/payments/application/configuration.ts`, `modules/payments/providers/pagbank/index.ts`.
* **Relacionados:** ADR-001; `docs/auditoria/matriz-configuracao-producao.md` §13.2; `docs/operacao/runbook-incidentes-conectores.md` §7.3.

---

## 1. Contexto

Um fallback na rota pública usava o **access token** da conta PagBank como segredo de verificação quando a empresa não tinha segredo de webhook próprio. Isso permitia que quem conhecesse o token da conta assinasse notificações aceitas.

## 2. Decisão

- **Nunca** usar o access token como segredo de webhook. Fallback removido em `fd8c64a`.
- Segredo cadastrado por empresa: `webhook_segredo_cifrado` (cifrado, somente escrita).
- Segredo da vitrine por ambiente: `PAGBANK_WEBHOOK_SECRET` (`${prefix}_WEBHOOK_SECRET`), usado junto de `PAGBANK_ACCESS_TOKEN`.
- Segredo ausente, ou igual ao access token, é tratado como **ausente**: a rota responde 401 antes de qualquer efeito (falha fechada).
- Verificação de assinatura antes de qualquer ACK de duplicata e antes de qualquer alteração de registro (um ACK sem assinatura revelaria eventos de outra cobrança).

**Limitação honesta do algoritmo atual (não resolvida nesta fase):** `modules/payments/providers/pagbank/index.ts` (`verifyWebhook`) calcula `SHA256(access_token + '-' + corpo cru)` e compara com `x-authenticity-token`. Ou seja, **a chave da verificação continua sendo o access token**; o segredo dedicado funciona hoje como **gate de presença** (sem ele, nada é aceito). Isso segue o resumo de terceiro da documentação do PagBank, que não foi confirmado no provedor. Se o provedor usar outro token de notificação, a verificação precisa ser revista (H-8). Trocar a chave por `PAGBANK_WEBHOOK_SECRET` sem confirmação quebraria notificações legítimas, por isso não foi feito.

## 3. Consequências

- Notificações legítimas sem segredo cadastrado deixam de ser aceitas até que o segredo seja configurado. Isso é intencional.
- Trocar o fallback por `PAGBANK_WEBHOOK_SECRET` como chave de verificação foi descartado: quebraria notificações legítimas sem segredo dedicado.
- **Pendências:**
  - Confirmar o algoritmo de `x-authenticity-token` com notificação real em sandbox (H-8). O resumo de terceiro indica SHA-256 hex de `{token}-{corpo cru}`, mas a chave (token da conta vs. outro) **não foi confirmada** no provedor. Não há acesso ao painel nesta fase.
  - Criar `PAGBANK_WEBHOOK_SECRET` em qualquer ambiente exige aprovação expressa do Diretor (G2).

## 4. Verificação

- Teste de rota (RED 1/2 → GREEN 2/2, `pagbank-webhook-rota-segredo.test.ts`, rede simulada).
- Unitário 9/9 (`pagbank-webhook-segredo.test.ts`). Regressão 164/164 (incluindo PagBank).
- **Nenhuma chamada financeira real.** Nenhuma notificação real recebida do provedor.
