# ADR-004 — PagBank: segredo de webhook dedicado, falha fechada

* **Status:** aceita em 2026-11-04 (Fase 4.3, risco **R-10**). Implementada localmente. **Algoritmo confirmado pela documentação oficial** (atualização de 2026-11-04, seção 5); **homologação funcional com notificação real ainda pendente** (H-8).
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

## 5. Atualização — contrato oficial (Fase 4.3, Ordem Master)

Fonte: documentação oficial do PagBank, "Confirmar autenticidade da notificação"
(`https://developer.pagbank.com.br/reference/confirmar-autenticidade-da-notificacao`; índice em `https://developer.pagbank.com.br/llms.txt`).

Conforme a documentação:

- O cabeçalho `x-authenticity-token` é o SHA-256 em hexadecimal de `{token}-{corpo cru}`.
- O `token` é o **token da conta** (obtido via iBanking/`obter-access-token`). A chave da verificação é, portanto, o token da conta, como o código já calculava.
- O corpo deve ser usado **exatamente como recebido**; reformatar o JSON invalida a assinatura.
- A documentação **não define timestamp nem janela de validade** no cabeçalho ou no corpo. Não há janela temporal a implementar por contrato.

Consequências no código:

- A verificação continua em `modules/payments/providers/pagbank/index.ts`. Agora é **comprovada por contrato** (`server/test/pagbank-webhook-contrato-oficial.test.ts`, 10 casos): assinatura oficial aceita; token da conta diferente recusado; corpo alterado recusado; corpo reformatado recusado; espaço extra recusado; cabeçalho malformado recusado sem exceção; segredo ausente ou só espaços recusado; identificador de evento determinístico; verificação independente da data no corpo.
- Segredo dedicado (`webhook_segredo_cifrado` ou `PAGBANK_WEBHOOK_SECRET`) **continua** como gate de presença fail-closed. Ele **não** é chave criptográfica do contrato oficial. Isso é uma decisão de defesa em profundidade, e não uma exigência do PagBank.
- Replay: sem timestamp no contrato, a proteção contra repetição fica na **idempotência por `evento_id`** e na verificação do corpo cru. Não se inventa janela de validade.
- Trocar o segredo dedicado por chave única continua descartado (quebraria notificações legítimas).

Pendências que permanecem:

- **H-8 (homologação funcional):** nenhuma notificação real do PagBank foi recebida nesta sandbox. Sem egress e sem credencial de sandbox, a prova ponta a ponta não foi executada. Os testes acima são de contrato local e não contam como homologação.
- **G2:** criar `PAGBANK_WEBHOOK_SECRET` em qualquer ambiente exige aprovação expressa do Diretor. Nenhum valor foi criado, impresso ou solicitado.


## 6. Ordem Final (pendência 2.2) — evidências locais

- **Algoritmo:** `x-authenticity-token` = SHA-256 hex de `{token}-{corpo cru}`, comparado com `timingSafeEqual` sobre
  valores hexadecimais de 64 caracteres (`modules/payments/providers/pagbank/index.ts`). Formato ou tamanho inválido é
  recusado antes da comparação.
- **Falha fechada:** sem segredo dedicado não-vazio (`webhook_segredo_cifrado` ou `PAGBANK_WEBHOOK_SECRET`), nada é aceito.
- **Sem segredo em saída:** `server/test/pagbank-webhook-sem-vazamento.test.ts` (3) captura `console.*` durante as requisições
  e verifica que o segredo dedicado, o token da conta e o valor do cabeçalho não aparecem em log, resposta ou registros
  de `gateway_webhook_events`. A auditoria de rejeição registra somente o provedor e o `evento_id`.
- **Limitação mantida:** o algoritmo oficial usa o token da conta. Uma assinatura calculada com esse token é aceita quando
  há segredo dedicado. O segredo é o gate de presença, não uma chave independente. Esta limitação segue declarada.
- **Não realizado:** nenhuma credencial PagBank real, nenhuma chamada financeira, nenhum `PAGBANK_WEBHOOK_SECRET` criado (G2).
