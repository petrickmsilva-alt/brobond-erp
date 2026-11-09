# FASE 7 — CRM, MARKETING & LOYALTY

**Escopo:** fechar o ciclo de relacionamento (CRM, segmentação, marketing,
fidelidade, atendimento e LGPD) sobre o Customer 360 e a plataforma de growth já
existentes.

> Esta fase **não cria um segundo CRM** nem um segundo motor de fidelidade. O
> Customer 360, a segmentação, as automações de marketing, o ledger de pontos e o
> atendimento já existiam (Ondas 4–5 / D1–D2). A Fase 7 completa as peças que
> faltavam para o ciclo ser auditável e conforme à LGPD.

## 1. Estado anterior (reutilizado, não reimplementado)

| Capacidade | Autoridade existente |
|---|---|
| Cliente unificado / histórico | `clientes`, `customer360` (`server/src/service.ts`) |
| Segmentação (regras) | `customer_segments`, `avaliarSegmento` |
| Consentimento LGPD | `customer_consents`, `customer_preferences` |
| Automação de marketing | `marketing_automations`, `marketing_automation_runs`, `dispararAutomacao` |
| Fidelidade | `loyalty_programs`, `loyalty_tiers`, `loyalty_movements` (saldo = soma dos movimentos) |
| Atendimento / pós-venda | `service_tickets`, `service_sla_politicas`, `painelAtendimento` |

## 2. O que a Fase 7 acrescenta

### 2.1 Análise RFM — `GET /api/customer-segments/rfm`

`analiseRfm()` (em `server/src/service.ts`) calcula, no SERVIDOR, os quintis de
**recência**, **frequência** e **valor monetário** sobre as compras reais da
empresa ativa e deriva um segmento de ação por cruzamento das notas:

- Recência: dias desde a última compra faturada/entregue.
- Frequência: número de compras.
- Valor: receita total.
- Segmentos: campeões, leais, potenciais leais, novos promissores, em risco,
  em risco (alto valor), precisa de atenção, hibernando.
- **Clientes sem compra não recebem nota** — são contados à parte (`sem_compra`).
  Sem histórico não há quintil; a base vazia devolve `cortes: null` e zeros
  honestos em vez de números inventados.

Tela: `/customer-segments/rfm`.

### 2.2 Limite de frequência de contato (anti-spam)

`dispararAutomacao()` passou a respeitar `marketing_automations.limite_frequencia_dias`:
antes de disparar, consulta a trilha append-only de execuções
(`marketing_automation_runs`) e recusa (HTTP 429) um novo contato para o mesmo
cliente dentro da janela. NULL/0 = sem limite (comportamento anterior preservado,
sem backfill).

### 2.3 Consentimento e opt-out (LGPD) no envio

Quando a ação da automação é `enviar_mensagem`, o disparo **exige consentimento
de marketing explícito** (`customer_consents.concedido = true`). O silêncio NÃO é
consentimento; `concedido = false` vence e bloqueia o envio (HTTP 409).

### 2.4 Expiração e estorno de pontos (integridade do ledger)

- `expirarPontosFidelidade()` — gera movimentos de `expiracao` para créditos
  vencidos, **idempotentes por crédito** (chave determinística por movimento de
  origem) e **nunca deixa saldo negativo**.
- `estornarPontosVenda()` — estorna os pontos de uma venda (cancelamento/
  devolução), **idempotente por origem** (chave `venda-<id>-<cliente>-<programa>`)
  e **limitado ao saldo remanescente**. Sem crédito de origem, o estorno é
  recusado (HTTP 409).

O saldo continua sendo a SOMA dos movimentos — nunca um campo editável.

### 2.5 Direito do titular — `GET /api/clientes/:id/dados-lgpd`

`exportarDadosTitular()` (em `server/src/lgpd.ts`) reúne, em um único retorno, os
dados que a empresa ativa guarda sobre o cliente (cadastro, consentimentos,
preferências, compras, atendimentos, devoluções, oportunidades, fidelidade),
atendendo ao direito de acesso/portabilidade (LGPD art. 18). Cada exportação é
**auditada** (`acao: 'exportar'`). O retorno declara suas **limitações**
(recorte por empresa; anonimização/exclusão seguem processo jurídico próprio).

## 3. APIs

| Método | Rota | Papel | Descrição |
|---|---|---|---|
| GET | `/api/customer-segments/rfm` | gerente+ | Análise RFM (quintis reais + segmentos de ação) |
| GET | `/api/clientes/:id/dados-lgpd` | gerente+ (carteira) | Exportação dos dados do titular (LGPD) |
| POST | `/api/marketing-automations/:id/disparar` | gerente+ | Disparo com limite de frequência + opt-out |
| POST | `/api/loyalty/pontos/expirar` | gerente+ | Expiração idempotente de pontos vencidos |
| POST | `/api/loyalty/pontos/estornar` | gerente+ | Estorno de pontos por venda (idempotente) |

## 4. Migração 0111 (aditiva/idempotente)

- `marketing_automations.limite_frequencia_dias INTEGER` + CHECK `>= 0`.
- Índice parcial `marketing_automation_runs_frequencia_idx`
  `(empresa_id, automacao_id, cliente_id, criado_em DESC) WHERE cliente_id IS NOT NULL`.
- Espelho em `db/schema.sql`; `db/bootstrap.sql` regenerado e sincronizado.
- **Nenhum backfill:** automações existentes seguem sem limite até serem editadas.

## 5. Segurança

- **Multiempresa:** toda leitura recorta por `empresa_id`; cliente de outra
  empresa devolve **404** (nunca 403 — não se confirma existência).
- **Carteira:** o representante só exporta cliente da própria carteira
  (`foraDaCarteira`), recorte aplicado no servidor.
- **RBAC:** recursos com `minPerfil: gerente`; a exportação LGPD exige `read` em
  `clientes`.
- **Idempotência:** expiração por crédito; estorno por origem; disparo por
  `Idempotency-Key`.
- **Auditoria:** exportação LGPD e execuções de automação ficam na trilha.

## 6. Limitações

- RFM depende de histórico real de vendas faturadas/entregues; base pequena
  produz quintis pouco discriminantes — declarado na própria resposta.
- Anonimização/exclusão LGPD **não** são executadas automaticamente: exigem
  processo jurídico e prazo de retenção.
- Canais externos de comunicação (WhatsApp/E-mail) permanecem desativados até
  homologação e credenciais.

## 7. Extensão — Fase 9.2 (ciclo de vida das atividades)

O **canal INTERNO** de notificação do CRM (lembrete de atividade, vencimento,
atribuição, troca de responsável, conclusão, reagendamento, cancelamento e falha
de processamento) foi entregue na Fase 9.2 sobre o agendador existente
(`scheduled.ts` → `dispararLembretesCrm`) — **sem** segundo motor e **sem**
ativar canal externo. Caixa pessoal em `crm_notificacoes` (migration `0113`),
idempotente por `UNIQUE (empresa_id, chave_idempotencia)` e recortada por empresa
e por usuário. Detalhe e evidências em
[`FASE-9-INTEGRIDADE-CRM-UX.md`](FASE-9-INTEGRIDADE-CRM-UX.md) §2.
