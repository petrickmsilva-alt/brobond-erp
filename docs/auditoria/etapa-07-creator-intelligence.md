# ETAPA 07 — CREATOR INTELLIGENCE (matching determinístico)

**Data:** 2026-11-14 · **Branch:** `arena/20369110-brobond-erp`
**Decisão:** `docs/architecture/ADR/ADR-0017-agentes-ia-deterministicos.md`.
**Módulo:** `server/src/creatorIntelligence.ts` · **Rota:** `POST /api/creators/intelligence/gerar`
**UI:** `client/src/pages/creators/CreatorMatchesPage.tsx` (botão "Creator Intelligence").
**Migration:** `0122_creator_commands_entidades_match_outreach.sql` (+ espelho em `schema.sql`, 0075 alinhada).

## 1. O que foi entregue (e o que NÃO foi)

Matching **determinístico** entre creators ativos e campanhas vigentes, usando
afinidade editorial por tokens + histórico REAL de atribuições pagas. Gera
**recomendações pendentes** (`ai_recommendations`, domínio `marketing`) para
decisão humana.

- **NÃO** cria parceria, match ou outreach automaticamente (testes provam que as
  contagens dessas tabelas não mudam).
- **NÃO** gera mensagem nem envia contato (`geracao_mensagem:false`,
  `envio_automatico:false`); outreach continua manual/registro humano.
- **NÃO** faz descoberta externa de creators/audiência (`descoberta_externa:false`).
- **NÃO** mede engajamento, alcance, brand safety ou ROI; receita atribuída por
  cupom não prova causalidade (limitação explícita).

## 2. Contrato de cálculo (versionado)

`campaign_id` opcional (404 se de outra empresa; 409 se não ACTIVE+vigente).
Campanha vigente = `status=ACTIVE` e `data_referencia` dentro de `starts_on/ends_on`.
Histórico: `creator_attributions.order_id → commerce_pedidos` pagos
(`estado ∈ {PAGO, CONVERTIDO}` e `pagamento_estado ?? 'APPROVED' = 'APPROVED'`),
via `partnership.creator_id`. Tokens: NFD, minúsculas, ≥3 chars, stopwords
removidas; afinidade = comuns / min(len(tokens)).

```
score = 0,50×afinidade_tokens + 0,30×min(pedidos_pagos/5,1) + 0,20×vigencia
```

Mínimo 0,2; máx. 20 recomendações; pesos somam 1; evidência formato 1.0.0 com
fatores/origem/fórmula/justificativa/limitações + dados do creator/campanha.

## 3. Gap corrigido — `creator_commands.entity` (CHECK)

**Achado:** `creators.ts` já gravava `creator_commands.entity='match'/'outreach'`,
mas o CHECK original da 0075 só admitia `profile|campaign|partnership`. No store em
memória o teste passava; no **PostgreSQL real** a transação abortava (23514) depois
de criar o registro. **Correção aditiva** (nenhum valor anterior invalidado):
0075 alinhada para instalações novas + `0122` para bancos já migrados + espelho em
`schema.sql`. Teste PG prova: match/outreach gravam e fazem replay; entidade
inválida continua 23514. Capacidade `creator-matches` agora declara
`recomendacao:true, recomendacao_tipo:'deterministica', aplicacao_automatica:false`.

## 4. Evidência executada

| Gate | Resultado |
|---|---|
| `server/test/etapa07-creator-intelligence.test.ts` (memória) | **3/3 PASS** |
| `server/test/pg/etapa07-creator-intelligence.test.ts` (PG real) | **2/2 PASS** |
| `server/test/creators.test.ts` + `enterprise-creators.test.ts` | **PASS** (capacidade atualizada travada) |
| Suíte servidor / `test:pg` / typechecks / client | **PASS** (ver etapa-06 §4) |
| `migrations-identidade` / `gerar-bootstrap --check` / `go-live:audit` | **PASS** |

Casos: tokens/afinidade normalizados e pesos=1; atribuição paga real ⇒ score 0,76
(1 pedido, afinidade 1, vigência 1); replay 200; match/outreach/parceria inalterados;
campanha inexistente 404; campanha cross-empresa 404; operador 403; no PG,
`creator_commands` aceita match/outreach com replay e rejeita entidade inválida.

## 5. Limitações declaradas

Afinidade é editorial (tokens do nicho × objetivo), não audiência; histórico é
atribuição por cupom, não causalidade; a sugestão exige validação humana de
audiência/termos antes de qualquer contato.
