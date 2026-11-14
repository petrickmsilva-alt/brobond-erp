# ETAPA 05 — AI ARCHITECTURE GAP (P2)

**Data:** 2026-11-14 · **Gate das Etapas 06–08:** `server/test/ai-platform-contracts.test.ts` — **8/8 PASS** (executado).
**Decisão:** `docs/architecture/ADR/ADR-0016-plataforma-ia-alvo.md`.

## 1. Inventário da plataforma existente (lido do código)

| Capacidade | Estado | Evidência |
|---|---|---|
| Providers (config) | IMPLEMENTED | `ai_providers`: tipo interno/externo/heuristica, modelo, limite mensal, fallback; admin; único (empresa,nome) |
| Prompts + versão | IMPLEMENTED | `ai_prompts`: UNIQUE(empresa,chave,versao); execução referencia prompt_id |
| Execuções auditáveis | IMPLEMENTED | `ai_executions`: append-only, custo≥0, estados sucesso/falha/fallback, chave_idempotencia UNIQUE parcial |
| Recomendações + decisão humana | IMPLEMENTED | `ai_recommendations`: score 0..1, evidencia JSONB, decidido_por/em; decidir não executa operação |
| Engine determinística | IMPLEMENTED | `gerarRecomendacoes` (inventory/demand/customer) — `heuristica-interna`, custo 0, reproduzível (C4 provou) |
| Agentes / ferramentas (catálogo) | NOT_IMPLEMENTED | nenhum registro/catálogo; ferramentas futuras precisam permissão+aprovação (ADR-0016 §5) |
| Adapter LLM externo | NOT_IMPLEMENTED | nenhum SDK/pipeline; C8 trava inclusão silenciosa |
| Fila/jobs de IA | NOT_IMPLEMENTED (parcial: outbox commerce existe) | jobs generativos futuros usam chave de idempotência + outbox pattern |
| Limites de custo/tokens/rate/concurrency | PARTIAL — **cadastro sem enforcement** | `limite_mensal_custo` existe; nenhum código o consome (grep). Gap registrado; obrigatório antes do 1º provider externo |
| Custos por empresa | PARTIAL | `ai_executions.custo` por empresa (hoje sempre 0 — honesto) |
| Evals/avaliação | NOT_IMPLEMENTED | futuro: conjunto de casos + métrica antes de promover prompt/modelo |
| Logs/observabilidade | IMPLEMENTED (base) | auditoria + executions + Control Tower |
| Permissões | IMPLEMENTED | admin: providers/prompts; gerente: executions/recommendations (C5) |
| Isolamento por tenant | IMPLEMENTED | C6 A×B nos 4 recursos; empresa_id em todas as tabelas |
| Aprovação humana | IMPLEMENTED | decidirRecomendacao + `exigirConfirmacaoHumana` no Operational Control |
| Trends (interno) | IMPLEMENTED (limitado) | `trendsCommerce`: projeção linear de vendas por SKU — não é descoberta externa |
| Creators Intelligence | PARTIAL | matching manual com score/evidência; descoberta/geração/envio bloqueados por provedor |
| Chat | PARTIAL (desvio) | persiste em `auditoria` recurso='chat' — formalização pendente (Etapa 03) |

## 2. Separação de camadas (contrato)

- **Determinística (autorizada hoje):** heurísticas, WMA, alertas por fingerprint,
  scoring com pesos versionados. Reproduzível: mesma entrada ⇒ mesma saída (C4).
  Sem rede, custo 0, modelo declarado.
- **Generativa (bloqueada até homologação):** adapter registrado em ai_providers
  → job idempotente → prompt versionado → custo/tokens medidos → fallback →
  resultado vira RECOMENDAÇÃO (nunca ação). Enforcement de limites + evals +
  aprovação humana são pré-requisitos (ADR-0016 §4–5).

## 3. Arquitetura-alvo (incremental, sem duplicar)

```
┌─ Domínios (06/07/08) ────────────────────────────────────────────┐
│ Trend Hunter · Creator Intelligence · AI Studio/CEO             │
│   → produzem EVIDÊNCIA + SCORE versionados                      │
├─ Plataforma existente (AUTORIDADE — reuso obrigatório) ─────────┤
│ ai_executions (idempotência/custo/estado/fallback)              │
│ ai_prompts (versão) · ai_providers (config/fallback/limite)     │
│ ai_recommendations (score/evidência/decisão humana)             │
│ Control Tower + alerts (leitura executiva/idempotência)         │
├─ Extensões futuras (NÃO implementadas; contrato no ADR-0016) ───┤
│ adapter LLM homologado · enforcement custo/rate/concurrency     │
│ catálogo agentes/ferramentas c/ permissão · evals · jobs outbox │
└──────────────────────────────────────────────────────────────────┘
```

Persistência/eventos/jobs: reusa `commerce_outbox` (claim CAS/backoff/DLQ) para
processamento assíncrono; nenhuma tabela nova sem justificativa + migration +
espelho + RBAC-MATRIX (regras do AGENTS.md).

## 4. Checklist de validação da base (gate 06–08)

| # | Contrato | Resultado |
|---|---|---|
| C1 | Prompt versionado, identidade (empresa,chave,versao) | ✅ teste |
| C2 | Execução append-only, custo≥0, estados, idempotência por empresa | ✅ teste |
| C3 | Recomendação com evidência + decisão humana FK real | ✅ teste |
| C4 | Engine reproduzível; modelo/custo declarados | ✅ teste |
| C5 | RBAC admin/gerente correto | ✅ teste |
| C6 | Tenant A×B nos 4 recursos | ✅ teste |
| C7 | Control Tower: definição/fórmula/origem/limitações; null≠0 | ✅ teste |
| C8 | Nenhum SDK LLM silencioso | ✅ teste |

**Veredito:** base APTA para receber 06/07/08 no modo determinístico/registro.
Capacidade generativa externa: **BLOQUEADA** (sem adapter/limites/evals/homologação).
