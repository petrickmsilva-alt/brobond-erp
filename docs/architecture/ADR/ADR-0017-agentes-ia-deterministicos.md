# ADR-0017 — Agentes de IA determinísticos (06–08) sobre a plataforma existente; alargar CHECK de creator_commands

* **Identificador:** ADR-0017
* **Título:** Trend Hunter, Creator Intelligence e AI Studio/CEO como agentes determinísticos reusando ai_*; correção aditiva do CHECK creator_commands.entity
* **Status:** Aceita (implementada e testada em memória + PostgreSQL 16.14 real)
* **Data:** 2026-11-14
* **Relacionados:** ADR-0016 (plataforma de IA alvo), ADR-0011 (padrão de migrations), ADR-0012 (RBAC), ADR-0004 (tenant)

## Contexto

As Etapas 06–08 pedem Trend Hunter, Creator Intelligence e AI Studio/CEO. A
Etapa 05 (ADR-0016) fixou que a base `ai_providers/ai_prompts/ai_executions/
ai_recommendations` + Control Tower é a **autoridade** e que a camada generativa
externa fica **bloqueada** até adapter + limites + evals + homologação. Também
fixou que descoberta externa sem fonte autorizada + credencial + egress é
bloqueada. Um gap real foi encontrado na 07: `creators.ts` gravava
`creator_commands.entity='match'/'outreach'`, mas o CHECK da 0075 só admitia
`profile|campaign|partnership` — abortava no PostgreSQL real (23514) embora
passasse no store em memória.

## Decisão

1. **Reuso, não plataforma paralela.** Os três agentes gravam em `ai_executions`
   (idempotência por empresa + hash canônico, custo 0, estado sucesso) e
   `ai_recommendations` (score 0..1, evidência JSONB formato 1.0.0, status
   pendente, decisão humana). Nenhum recurso/tabela nova de IA foi criada; o
   catálogo do Studio é derivado do código, não persistido.
2. **Camada determinística apenas.** Scoring com pesos versionados (somam 1),
   fatores com valor/peso/contribuição/origem, fórmula/fonte/justificativa/
   limitações na evidência. Sem rede, sem LLM, sem envio, sem aplicação
   automática. Provider `tipo='externo'` ⇒ 409; `descoberta_externa:false`.
3. **Enforcement de orçamento agora é real.** `executarAnaliseIA` checa
   `limite_mensal_custo` por provider no mês UTC de `data_referencia` antes de
   executar (fecha o gap da Etapa 05 para a camada determinística; o go-live
   generativo continua exigindo rate/concurrency/evals).
4. **CHECK alargado, nunca estreitado.** `creator_commands.entity` passa a aceitar
   `profile|campaign|partnership|match|outreach` via 0075 alinhada (instalações
   novas) + `0122` (bancos já migrados) + espelho em `schema.sql`. Aditivo e
   idempotente; nenhum dado removido; entidade inválida continua rejeitada.
5. **Clock injetável na Control Tower.** `painelControlTower(empresaId, agora)`
   permite briefing reproduzível por `data_referencia` sem mudar o handler HTTP.

## Alternativas consideradas

- **Tabelas/rotas de IA novas (trend_jobs, creator_scores, studio_agents):**
  rejeitadas — duplicariam persistência/RBAC/auditoria já testadas (ADR-0016).
- **LLM para gerar texto de briefing/mensagem:** rejeitada — sem adapter/evals/
  homologação; texto é template determinístico sobre dados reais.
- **Corrigir o CHECK editando só a 0075:** insuficiente para bancos já migrados;
  por isso a 0122 aditiva + espelho (padrão ADR-0011).
- **Aplicação automática da recomendação:** rejeitada — decisão humana mantida.

## Consequências

- 06/07/08 entregues com testes de contrato em memória e PG real (505/505 no
  gate `test:pg`, 0 skip/todo); RBAC gerente+ para gerar, operador 403.
- O primeiro provider generativo continua bloqueado até adapter + limites +
  evals + homologação (ADR-0016 §4–5); o catálogo do Studio declara isso.
- `creator-matches` passa a declarar recomendação determinística com aplicação
  manual; outreach/geração/envio permanecem bloqueados por provedor.
