# ADR-0016 — Plataforma de IA: base existente é a autoridade; arquitetura-alvo incremental

* **Identificador:** ADR-0016
* **Título:** Plataforma de IA do ERP — reuso da base D4/D5/Fase 8 e arquitetura-alvo para generativo
* **Status:** Aceita (base validada por testes de contrato); extensões generativas propostas, NÃO implementadas
* **Data:** 2026-11-14
* **Relacionados:** ADR-0001 (monólito modular), ADR-0004 (tenant), ADR-0010 (outbox/inbox), ADR-0012 (RBAC)

## Contexto (inventário lido do código — Etapa 05)

A plataforma de IA JÁ EXISTE e é determinística:

| Peça | Onde | Contrato |
|---|---|---|
| Provedores | `ai_providers` (admin CRUD) | tipo interno/externo/heuristica; `limite_mensal_custo`; `fallback_provider_id`; único por (empresa, nome) |
| Prompts | `ai_prompts` (admin CRUD) | versão parte da identidade: UNIQUE (empresa, chave, versao); nova versão não sobrescreve |
| Execuções | `ai_executions` (gerente RO, append-only) | provider/prompt/finalidade/entrada/resultado/custo/estado (sucesso/falha/fallback)/erro; `chave_idempotencia` UNIQUE parcial por empresa |
| Recomendações | `ai_recommendations` (gerente) | score 0..1 + evidência JSONB; decisão humana (`decidido_por/em`); status pendente→aceita/rejeitada/aplicada; aplicação real é ação humana |
| Engine | `enterprise45.gerarRecomendacoes` | heurística interna determinística (inventory/demand/customer); custo 0; modelo declarado `heuristica-interna` |
| Previsão | `prediction.ts` (WMA 6m), `demand_forecasts`/`supply_plans`/`sop_scenarios` | método/materialização/accuracy observada |
| Leitura executiva | `controlTower.ts` + `alerts.ts` | indicadores com definição/fórmula/origem/limitações; null≠0; alertas idempotentes por fingerprint |
| Creators | `creators.ts` | ATIVO_MANUAL; matches com score+evidência registrados por humano; outreach manual; envio/geração `false` |

**Não existe** adapter LLM externo, fila de jobs de IA, catálogo de agentes/
ferramentas, avaliação (evals) ou controle de tokens. `limite_mensal_custo` é
cadastrado mas **não tem enforcement** (gap registrado). Chat interno persiste
em `auditoria` (desvio documentado na Etapa 03).

## Decisão

1. **A base acima é a autoridade.** Trend Hunter (06), Creator Intelligence
   (07) e AI Studio/CEO (08) REUSAM `ai_executions`/`ai_recommendations`/
   Control Tower/alertas — proibido criar plataforma paralela (ai_jobs v2,
   recommendations v2, etc.).
2. **Camadas separadas:**
   - **Determinística** (existe): scoring/forecast/alertas/regras — reproduzível,
     versionada, custo 0, sem rede;
   - **Generativa** (futura): só via adapter registrado em `ai_providers`
     (tipo externo), executado por job idempotente (`chave_idempotencia`),
     com prompt versionado (`ai_prompts`), custo/tokens medidos, fallback
     declarado e resultado NUNCA aplicado sem decisão humana.
3. **Contratos mínimos antes de qualquer extensão** (travados em
   `server/test/ai-platform-contracts.test.ts`, 8 casos): C1 versão de prompt;
   C2 execução append-only/idempotente/custo≥0; C3 decisão humana; C4
   reprodutibilidade + modelo declarado; C5 RBAC; C6 tenant A×B; C7 Control
   Tower leitura com fórmula/origem/null≠0; C8 nenhum SDK LLM silencioso.
4. **Enforcement de custo/limites** (gap): antes do primeiro provider externo,
   o executor deve checar `limite_mensal_custo` da empresa + rate/concurrency
   por empresa e registrar consumo em `ai_executions`. NÃO implementado nesta
   missão (sem provider externo, custo é 0) — requisito de aceite do go-live
   generativo.
5. **Ferramentas/agentes** (AI Studio): catálogo futuro deve declarar por
   ferramenta: escopo, permissão RBAC, aprovação humana exigida, entrada/
   saída tipadas e auditoria. Nenhuma ferramenta executa escrita sensível
   sem `exigirConfirmacaoHumana` (padrão já existente no Operational Control).
6. **Descoberta externa** (trends/creators): sem fonte autorizada +
   credencial + egress, fica BLOQUEADA — a infraestrutura de scoring/registro
   pode existir, mas nenhuma chamada externa é simulada.

## Alternativas consideradas

- **Nova plataforma de IA paralela:** rejeitada — duplicaria persistência,
  auditoria e RBAC já testados.
- **LLM direto no handler HTTP:** rejeitada — sem idempotência/custo/limite.
- **Aplicação automática de recomendação:** rejeitada — a base já exige
  decisão humana; mantida.

## Consequências

- Etapas 06–08 constroem SOBRE os contratos C1–C8 (gate verde nesta missão).
- O primeiro provider generativo exigirá: adapter + enforcement de limites +
  evals + homologação — tudo com evidência, antes de anunciar capacidade.
