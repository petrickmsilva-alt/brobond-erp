# FASE 8 — BI & AI CONTROL TOWER

**Escopo:** transformar os dados operacionais já existentes em inteligência
gerencial e executiva — alertas configuráveis e uma Control Tower de leitura que
consolida indicadores, saúde operacional, previsões e recomendações rastreáveis.

> Esta fase **não cria uma segunda fonte de verdade** nem um segundo BI. As
> projeções (`bi_read_models`), a plataforma de IA
> (`ai_providers`/`ai_prompts`/`ai_executions`/`ai_recommendations`) e as
> previsões (`demand_forecasts`/`supply_plans`/`sop_scenarios`) já existiam
> (Ondas 4–5 / D3–D5). A Fase 8 acrescenta a peça que transforma **indicador em
> ação** (alertas) e consolida a **leitura executiva** (Control Tower) sem
> executar operação.

## 1. Estado anterior (reutilizado, não reimplementado)

| Capacidade | Autoridade existente |
|---|---|
| Projeções de BI | `bi_read_models`, `reconstruirBi`, `painelBi` (`server/src/enterprise45.ts`) |
| Recomendações de IA | `ai_recommendations`, `gerarRecomendacoes` (com score e evidência) |
| Execuções de IA | `ai_executions` (custo, estado, fallback, auditoria) |
| Previsões | `demand_forecasts`, `supply_plans`, `sop_scenarios` |
| Estoque canônico | `estoqueCanonico.ts` (`disponibilidadesPorTamanho`) |
| Vendas / financeiro | `vendas`, `itens_venda`, `lancamentos_financeiros` |
| Operação | `commerce_outbox`, `commerce_pedidos`, `service_tickets` |
| Divergências multicanal | reconciliação da Fase 6 (`commerce_reconciliacao`) |

## 2. O que a Fase 8 acrescenta

### 2.1 Motor de alertas — `server/src/alerts.ts`

Um motor **determinístico** com um catálogo fixo de detectores que leem apenas
documentos **canônicos** e devolvem ocorrências. Cada ocorrência tem
**identidade lógica** (`fingerprint` UNIQUE por empresa), de modo que a mesma
ocorrência **REABRE** quando volta a existir e é **RESOLVIDA** quando deixa de
ser detectada — a trilha não empilha linhas nem esconde recaída.

- **Detectores** (catálogo): ruptura de estoque, estoque abaixo do mínimo,
  queda de vendas, margem baixa, inadimplência, divergência de conciliação,
  fila (outbox) em erro, pedidos parados, SLA de atendimento estourado.
- **Regras** (`alert_rules`): limiar, severidade, canal, destinatários, janela
  anti-spam (`frequencia_minima_min`) e silenciamento (`silenciado_ate`). Sem
  regra explícita o detector opera com os limiares padrão; desativar a regra
  suspende o detector.
- **Ocorrências** (`alert_events`): título, detalhe, evidência rastreável,
  contagem de ocorrências, status e histórico de reconhecimento/resolução.
- **Transições idempotentes**: reconhecer, resolver e silenciar — auditadas.

> Alertar não é agir: nenhum detector altera preço, estoque, pagamento, pedido,
> financeiro ou campanha. A recomendação de correção é texto.

APIs:

| Método | Rota | Papel | Descrição |
|---|---|---|---|
| POST | `/api/alerts/avaliar` | gerente+ | Roda os detectores e materializa/atualiza ocorrências |
| GET | `/api/alerts/painel` | gerente+ | Ocorrências + totais + catálogo de detectores |
| POST | `/api/alerts/:id/reconhecer` | gerente+ | Marca como ciente (idempotente, auditado) |
| POST | `/api/alerts/:id/resolver` | gerente+ | Resolve com justificativa (idempotente, auditado) |
| POST | `/api/alerts/:id/silenciar` | gerente+ | Silencia até uma data (não apaga evidência) |

Tela: `/alertas` (painel operacional). Configuração: `/alertas/regras` (CRUD de
`alert_rules`).

### 2.2 AI Control Tower — `server/src/controlTower.ts`

Camada de **LEITURA** executiva que consolida, em uma resposta, o que o gestor
precisa enxergar — sempre a partir dos documentos canônicos e dos resultados já
persistidos. Não inventa número: quando não há dado, devolve `null` com a
limitação declarada.

- **Indicadores** com `definicao`, `formula`, `origem` e `limitacoes`:
  receita, pedidos, ticket médio, margem bruta, crescimento MoM, a receber
  vencido e receita por canal.
- **Saúde operacional**: outbox pendente/em erro, pedidos parados (>24h),
  tickets abertos, SLA estourado, alertas abertos/críticos.
- **Previsões**: top de demanda e de suprimento materializados + **acurácia
  observada** (MAE/MAPE comparando previsões de períodos fechados com a receita
  realizada — proxy declarado).
- **Recomendações pendentes** com score, evidência, impacto estimado (só quando
  a evidência traz valor), confiança e `requer_aprovacao: true`.
- **Pendências críticas** consolidadas e ordenadas por severidade.

API: `GET /api/control-tower/painel` (gerente+). Tela: `/ai/control-tower`.

## 3. Migração 0112 (aditiva/idempotente)

Duas tabelas, um único motor:

- `alert_rules` — a regra configurável por empresa (UNIQUE `(empresa_id, chave)`).
- `alert_events` — a ocorrência real (UNIQUE `(empresa_id, fingerprint)`).

`empresa_id` NOT NULL nas duas; CHECKs de domínio, severidade, canal, status e
contagem. Espelho em `db/schema.sql`; `db/bootstrap.sql` regenerado e
sincronizado. **Nenhum backfill** e nenhuma alteração destrutiva.

## 4. Segurança

- **Multiempresa:** toda função exige `empresaId` e recorta por ele; alerta de
  outra empresa devolve **404** (nunca 403 — não se confirma existência).
- **RBAC:** recursos `alert_events`/`alert_rules` com `minPerfil: gerente`;
  `alert_events.ops.delete = false` (a ocorrência é histórico).
- **Idempotência:** `fingerprint` UNIQUE por empresa; transições idempotentes;
  reabertura controlada.
- **Anti-spam:** `frequencia_minima_min` + `silenciado_ate` suprimem a
  NOTIFICAÇÃO, nunca a ocorrência nem a evidência.
- **Auditoria:** avaliação, reconhecimento, resolução e silenciamento ficam na
  trilha (`acao: 'editar'`/`'ajuste'`).
- **Fail-closed:** sem empresa ativa válida a Control Tower recusa (HTTP 400);
  sem dado, o indicador é `null` com limitação — nunca zero enganoso.

## 5. Limitações

- A acurácia de previsão usa a receita do período como **proxy** (não há
  granularidade de receita por SKU/período confiável) — declarado na resposta.
- CAC/LTV **não** são calculados: exigem metodologia definida e dados de
  investimento por canal.
- O custo usado na margem é o unitário atual do cadastro, não o custo histórico
  do lote da venda.
- Notificação externa (e-mail/WhatsApp/SMS/push) permanece **interna** até
  homologação e credenciais; o motor registra o canal desejado na regra, mas o
  envio externo não é presumido.
- Os agentes de IA analisam e recomendam; **não executam** operações críticas
  (alterar preço/estoque em massa, pagar, estornar, publicar, ativar conector).

## 6. Testes

- `server/test/fase8-alertas-control-tower.test.ts` — catálogo de detectores,
  ruptura/mínimo via estoque canônico, idempotência de `fingerprint`,
  resolver/reabrir, janela anti-spam, regra inativa e override de limiar,
  reconhecer/resolver/silenciar (idempotente + auditado), consolidação da Tower.
- `client/src/pages/ControlTowerPage.test.tsx` e
  `client/src/pages/AlertasPage.test.tsx` — leitura derivada, estado vazio
  honesto e transições chamando os endpoints corretos.
