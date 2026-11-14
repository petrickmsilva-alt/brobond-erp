# ETAPA 08 — AI STUDIO / AI CEO (catálogo fechado + briefing)

**Data:** 2026-11-14 · **Branch:** `arena/20369110-brobond-erp`
**Decisão:** `docs/architecture/ADR/ADR-0017-agentes-ia-deterministicos.md`.
**Módulo:** `server/src/aiStudio.ts` · **Rotas:** `GET /api/ai/studio/capabilities`,
`POST /api/ai/ceo/briefing/gerar` · **UI:** `client/src/pages/ControlTowerPage.tsx`
(botão "AI CEO Briefing"). **Clock injetável:** `painelControlTower(empresaId, agora)`.

## 1. O que foi entregue (e o que NÃO foi)

- **AI Studio = catálogo fechado** dos agentes determinísticos homologados
  internamente (trend-hunter, creator-intelligence, ai-ceo) + ferramentas de
  **leitura** (`control-tower.ler`) e **decisão humana**
  (`ai-recommendations.decidir`). Cada item declara endpoint, RBAC, versão/modelo,
  aplicação automática e aprovação humana.
- **AI CEO = briefing executivo determinístico** derivado da Control Tower
  (indicadores com definição/fórmula/origem/limitações, saúde operacional,
  pendências críticas), gravado como recomendação pendente (domínio `commerce`).
- **NÃO** existe ferramenta genérica de shell/SQL/HTTP/deploy; **NÃO** há LLM
  externo (`generativo_externo:false`, motivo
  `ADAPTER_LLM_EVALS_HOMOLOGACAO_PENDENTES`); **NÃO** há aplicação automática.

## 2. Contrato de priorização (versionado)

```
prioridade = 0,30×min(alertas_criticos/5,1) + 0,20×min(outbox_erro/10,1)
           + 0,20×min(pedidos_parados/10,1) + 0,15×min(sla_estourado/10,1)
           + 0,15×min(receber_vencido/10000,1)
```

`receber_vencido=null` ⇒ fator 0 **sinalizado em `dados_ausentes`** (null ≠ zero
realizado). A Tower é lida com relógio injetado (`data_referencia` 00:00 UTC) para
reprodutibilidade; evidência carrega período, indicadores, saúde, pendências e
recomendações pendentes. Texto lista até 5 prioridades ou declara ausência de
pendência crítica — nunca inventa número.

## 3. Evidência executada

| Gate | Resultado |
|---|---|
| `server/test/etapa08-ai-studio.test.ts` (memória) | **1/1 PASS** |
| `server/test/pg/etapa08-ai-studio.test.ts` (PG real) | **1/1 PASS** |
| `fase8-alertas-control-tower` + `d2-d7-enterprise45` (clock injetável) | **PASS** |
| Suíte servidor / `test:pg` / typechecks / client | **PASS** (ver etapa-06 §4) |

Casos: catálogo sem ferramenta arbitrária e generativo bloqueado; capabilities
gerente OK / operador 403; prioridade saturada = 1; briefing com evidência
(indicadores/fórmula) e `aplicacao_automatica:false`; replay 200; divergência 409;
operador 403; tenant A×B com a mesma chave (2 execuções distintas).

## 4. Limitações declaradas

Briefing é leitura executiva derivada — não substitui decisão humana nem auditoria
contábil; indicadores carregam suas próprias limitações na Tower; sem geração
generativa externa nem aplicação automática.
