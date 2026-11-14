# ETAPA 06 — TREND HUNTER (determinístico, interno)

**Data:** 2026-11-14 · **Branch:** `arena/20369110-brobond-erp`
**Decisão:** `docs/architecture/ADR/ADR-0017-agentes-ia-deterministicos.md` (reuso da plataforma ADR-0016).
**Módulo:** `server/src/trendHunter.ts` · **Rota:** `POST /api/ai/trend-hunter/gerar`
**UI:** `client/src/pages/commerce/TrendsPage.tsx` (botão "Trend Hunter interno").

## 1. O que foi entregue (e o que NÃO foi)

Trend Hunter **interno**: compara duas janelas civis UTC consecutivas de vendas
reais do ERP (`vendas` + `itens_venda` + `produtos`) e grava **recomendações
pendentes** na plataforma existente (`ai_executions` + `ai_recommendations`).

- **NÃO** há descoberta externa (sem fonte autorizada + credencial + egress —
  ADR-0016 §6). `descoberta_externa: false` é explícito na evidência.
- **NÃO** altera preço, estoque, pedido ou qualquer documento operacional.
- **NÃO** chama LLM/provedor externo. Provider `tipo='externo'` é bloqueado (409).
- Custo declarado **0** (heurística interna), modelo `trend-hunter-deterministico`
  v1.0.0, reproduzível: mesma entrada ⇒ mesma saída.

## 2. Contrato de cálculo (versionado, auditável)

Janela: `data_referencia` (default hoje UTC), `janela_dias` inteiro 7–90 (default 28).
Duas janelas iguais e consecutivas terminando na referência. Documento elegível:
`vendas.status ∈ {faturada, entregue}`; dia = `faturada_em ?? data ?? criado_em`;
receita do item = `subtotal ?? quantidade × preco_unitario`.

Elegibilidade do produto: ativo, variação > 0, **base anterior > 0** (sem base ⇒
`null`, contado em `produtos_sem_base_anterior`, nunca recomenda), quantidade
atual ≥ 3, pedidos ≥ 2, dias distintos com venda ≥ 2. Máx. 20 recomendações,
domínio `sales`.

```
score = 0,45×min(max(variacao_pct/100,0),1)
      + 0,30×min(quantidade_atual/20,1)
      + 0,25×(dias_com_venda/janela_dias)
```

Pesos somam 1; cada fator carrega valor/peso/contribuição/origem; evidência traz
fórmula, fonte, janelas, atual/anterior, justificativa e limitações (formato 1.0.0).

## 3. Plataforma reusada (ADR-0016) — `server/src/aiPlatform.ts`

`executarAnaliseIA`: lock de domínio `ai-platform`, idempotência por
(empresa, `Idempotency-Key` 8–160) com hash canônico do payload; replay devolve a
mesma execução/recomendações (200); payload divergente ⇒ 409; provider externo ⇒
409; **enforcement de orçamento mensal** (`limite_mensal_custo`, mês UTC) antes de
executar; execução custo 0 + recomendações pendentes + auditoria, tudo na mesma
transação. `listarTodosIA` pagina 1000/página (sem truncar silently).

## 4. Evidência executada

| Gate | Resultado |
|---|---|
| `server/test/etapa06-trend-hunter.test.ts` (memória) | **4/4 PASS** |
| `server/test/pg/etapa06-trend-hunter.test.ts` (PG 16.14 real) | **2/2 PASS** |
| `server/test/ai-platform-contracts.test.ts` (C1–C8) | **8/8 PASS** |
| Suíte servidor (memória) | **2626 pass / 0 fail / 95 skip** |
| `npm run test:pg` (banco novo, 0 skip/todo) | **505/505 PASS** |
| `npm --workspace server run typecheck` | **PASS** |
| `npm --workspace client run typecheck` | **PASS** |
| `npm --workspace client test` | **1139/1139 PASS (132 arquivos)** |
| `go-live:audit` | exit 0 (P0=0, P1=0, P2=1 colisão histórica 0121) |
| `architecture:audit` / `audit:menu` / `audit:ux` | **PASS** |
| `gerar-bootstrap.mjs --check` / `migrations-identidade` | **PASS** |

Casos travados: janelas/agregação determinísticas; crescimento sem base = null;
recomendação sobre vendas reais com score 0,626 (2→7 un., 250%); replay 200 com
mesmos ids; divergência 409; operador 403; estoque inalterado; tenant A×B com a
mesma chave (2 execuções distintas, B sem tendência de A); unicidade parcial
(empresa, chave) no PG; orçamento mensal por provider/mês UTC (9,5 no mês, 100 no
mês anterior ignorado) e bloqueio 409 quando estourado; provider externo 409 sem
gravar execução.

## 5. Limitações declaradas (na evidência)

Tendência interna observada ≠ previsão garantida; não considera ruptura, margem,
causalidade de campanha nem sazonalidade externa; crescimento sem base é null.
