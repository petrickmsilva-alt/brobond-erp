# RELATÓRIO — FASE P2 (Financeiro, Caixa, Bancos, Gateways e Conciliação)

**Repositório:** `petrickmsilva-alt/brobond-erp`
**Branch:** `arena/2cbe7b3b-brobond-erp` (a partir de `0be3596` da `main`)
**Data:** 2026-10-07
**Escopo:** exclusivamente o ERP. Nada de `brobond-ai-commerce`.

> Regra seguida à risca: **não declarar 100% sem evidência.** Integração real
> com gateway de produção não foi exercitada neste ambiente (sem credenciais e
> sem saída de rede para os provedores) — está dito onde importa, e o código
> se recusa a inventar resposta de provedor em produção.

---

## 1. STATUS FINAL

## ✅ P2 concluída no que depende de código — com duas ressalvas honestas

| Superfície | Status |
|---|---|
| Banco (migration 0025 + espelho no schema.sql) | ✅ escrita, idempotente; aplicada em CI (`testes-postgres`) |
| Servidor — APIs e regras de negócio | ✅ concluído |
| Multiempresa no financeiro | ✅ re-auditada; vazamentos fechados e testados A×B |
| Testes de memória | ✅ 488 passam / 0 falham (24 novos de P2) |
| Testes PostgreSQL (concorrência + índices únicos) | ✅ **43/43 executados contra Postgres real** (18.4 local — 6 novos + toda a suíte PG pré-existente; o CI roda o mesmo conjunto em postgres:16) |
| Typecheck / lint / build client | ✅ verdes |
| `prisma validate` | ⚠️ não roda neste sandbox (download do schema-engine bloqueado pela rede); schema Prisma **não foi tocado** — financeiro não vive no Prisma |
| Gateway real (MercadoPago) | ⚠️ adapter pronto, mas só exercitado com o mock em teste (ver §9) |

---

## 2. AUDITORIA — o que já existia e foi PRESERVADO

Re-auditoria completa antes de escrever qualquer linha. Isto estava correto e
**não foi reimplementado**:

| Área | Situação encontrada |
|---|---|
| Contas a pagar/receber, parcelas reais por título | ✅ `financeiro.ts` — preservado |
| Baixa total/parcial com juros, multa e desconto (lançamentos filhos) | ✅ preservado; endurecido (ver §3) |
| Transferências entre contas (débito/crédito atômicos, DRE-neutras) | ✅ preservado |
| Taxas de cartão e `valor_liquido` | ✅ preservado |
| Centros de custo, categorias, aging, DRE | ✅ preservado |
| Conciliação por extrato (OFX/CSV em memória) | ✅ preservado e complementado |
| Caixa PDV (abertura/suprimento/sangria/fechamento) | ✅ P1 — preservado; ganharam travas (ver §3) |
| Segredos cifrados AES-GCM (`segredos.ts`) | ✅ reutilizado para credenciais de gateway |

## 3. GAPS REAIS ENCONTRADOS E CORRIGIDOS

| § | Gap (auditoria) | Correção |
|---|---|---|
| §16 | **Multiempresa no financeiro**: `resumoFinanceiro`, baixa, conciliação, recorrências, rentabilidade, resumo de investidores e criação manual **não filtravam por empresa**; lançamentos automáticos nasciam sem carimbo | Escopo de empresa em todas as consultas + carimbo `empresa_id` em toda criação automática (venda, compra, aporte, transferência, baixa) |
| §5 | **Comissões**: apuradas no faturamento (`vendas.comissao_valor`) mas **sem efetivação por recebimento** e sem estorno | Livro `comissoes_eventos` + efetivação pró-rata no recebimento + estorno em cancelamento/estorno de gateway |
| §7 | **Gateway de pagamento**: inexistente | `gateway.ts` — arquitetura de adapters `PaymentProvider` |
| §8 | **Webhooks de entrada**: inexistentes | rota pública + persistência + assinatura + idempotência + retry |
| §12 | **CNAB**: inexistente | `cnab.ts` — camada de parsers (adapter) + CNAB240 |
| §13 | **OFX persistente**: parser existia, mas a importação não persistia linha/FITID nem impedia reimportação | `extrato.ts` — tabela `fin_extrato_transacoes`, hash por linha, FITID guardado |
| §6 | **Caixa**: venda de caixa **fechado** podia ser cancelada por qualquer perfil; fechamento sem campo de justificativa | Bloqueio 409 pós-fechamento (admin ainda pode, com trilha `RETROATIVO`); justificativa no fechamento |
| §4 | **Baixa sem guarda de estado**: duas baixas simultâneas podiam passar | `tryUpdateIf(status='pendente')` — transição condicional atômica |
| §20 | **Store Postgres**: `update`/`tryUpdateIf` quebravam com 42601 quando o payload espelhava a linha inteira (`atualizado_em` duplicado), e conflito de serialização (40001) escapava sem tradução — o perdedor de uma corrida via 500 | `pgstore.ts` filtra colunas geridas pelo store; `efetuarBaixa` traduz conflito em 409 limpo |
| §20 | **Boot concorrente**: dois processos subindo juntos podiam aplicar o bootstrap (schema.sql + migrações) ao mesmo tempo — blocos `DO $$` e o registro em `schema_migrations` corriam em paralelo e o perdedor morria à toa (padrão compatível com a falha do job `testes-postgres`) | `db.ts` serializa o bootstrap inteiro com advisory lock de sessão; validado com banco zerado e 7 boots paralelos (43/43 ×2) |

---

## 4. IMPLEMENTADO (novo nesta fase)

| § | Item | Onde |
|---|---|---|
| §5 | **Livro de comissões** — efetivação por recebimento (pró-rata do principal, nunca sobre juros/multa), limitada pelo saldo do livro (realizada − estornada ≤ apuração); estorno por cancelamento e por estorno de gateway; relatório apurado × efetivado por representante | `server/src/comissoes.ts` (333 linhas) |
| §7 | **Gateway adapter** — interface `PaymentProvider` (cria/consulta/cancela/estorna/parseWebhook/verificaAssinatura); registro de provedores desacoplado; `mockProvider` (só fora de produção) e `mercadopagoProvider` (HTTP real, exige credenciais cifradas) | `server/src/gateway.ts` (1134) |
| §7 | **Cobranças** — PIX (QR + copia-e-cola), boleto (linha digitável + nosso número), cartão; idempotência por chave do chamador; ciclo pendente→paga/cancelada/estornada com reversão financeira | idem |
| §8 | **Webhooks de entrada** — corpo cru (assinatura sobre os bytes originais), validação de assinatura quando há segredo, persistência ANTES do processamento, idempotência por (provedor, evento_id), retry com backoff (cron + reprocessamento manual) | idem |
| §13/§14 | **Extrato persistente** — importação OFX/CSV idempotente por hash da linha, FITID guardado, match automático só com critério confiável (valor+data com candidato único), confirmação manual e divergência | `server/src/extrato.ts` (222) |
| §12 | **CNAB 240** — parser por adapter (`detecta`/`parseRetorno`), liquidação **somente** por identificação (nosso número), movimento `06` = liquidação; rejeição/baixas/desconhecidos viram divergência — **nunca** baixa por posição no arquivo | `server/src/cnab.ts` (332) |
| §10 | **Recebíveis de cartão** — bruto × taxa × líquido projetados por data de recebimento | `financeiro.ts` (`recebiveisCartao`) |
| §6 | **Travas de caixa** — cancelamento de venda em caixa fechado bloqueado sem admin (+ trilha de auditoria `RETROATIVO` quando admin o faz); justificativa opcional no fechamento | `pdv.ts` |
| §3/§4 | **Endurecimento da baixa** — transição `pendente→confirmado` condicional e atômica; trilha de auditoria com método, conta, operador e origem em toda liquidação | `financeiro.ts` (`efetuarBaixa`) |

**Total:** 4 módulos novos (~2.020 linhas de serviço) + endurecimento de
`financeiro.ts`, `pdv.ts` e `index.ts`.

---

## 5. MIGRATION E SCHEMA

`db/migrations/0025_p2_financeiro_gateways.sql` (espelhado em `db/schema.sql`):

| Tabela | Propósito |
|---|---|
| `gateway_configs` | 1 config por empresa × provedor; credenciais e segredo de webhook **cifrados** |
| `gateway_cobrancas` | cobranças emitidas via gateway, com ref do provedor e chave de idempotência |
| `gateway_webhook_events` | eventos de entrada persistidos, com tentativas/erro/última tentativa |
| `comissoes_eventos` | livro de efetivação/estorno de comissões |
| `fin_extrato_transacoes` | linhas de extrato importadas (OFX/CSV/CNAB) |

Índices únicos de idempotência (a trava é o índice, não a sorte):

- `uq_gateway_configs_empresa_provider (empresa_id, LOWER(provider))`
- `uq_gateway_cobrancas_idempotencia (empresa_id, LOWER(provider), idempotency_key) WHERE key IS NOT NULL`
- `uq_gateway_webhook_evento (LOWER(provider), evento_id)`
- `uq_extrato_linha (conta_id, linha_hash)`

**Decisão registrada:** comissão efetivada **não** tem índice único por
lançamento — o mesmo título recebe recebimentos legítimos sucessivos (baixa
parcial + quitação), cada um efetivando sua fração. As travas reais são a
transição atômica de status na baixa (o mesmo ato não roda duas vezes) e o
saldo do livro em código (nunca efetivar além da apuração).

---

## 6. ENDPOINTS NOVOS

```
GET  /api/financeiro/comissoes                     # apurado × efetivado por representante (período)
GET  /api/financeiro/comissoes/venda/:id           # livro de uma venda
GET  /api/financeiro/cartao/recebiveis             # bruto × taxa × líquido por vencimento

GET  /api/financeiro/gateway/providers             # adapters registrados
PUT  /api/financeiro/gateway/config                # config (re-autenticação obrigatória)
POST /api/financeiro/gateway/cobrancas             # criar cobrança (idempotente por chave)
GET  /api/financeiro/gateway/cobrancas[/:id]       # listar / detalhe
POST /api/financeiro/gateway/cobrancas/:id/cancelar
POST /api/financeiro/gateway/cobrancas/:id/estornar
GET  /api/financeiro/gateway/webhooks              # eventos de entrada
POST /api/financeiro/gateway/webhooks/:id/reprocessar
POST /api/admin/financeiro/gateway/webhooks/processar   # cron de retry
POST /api/gateway/webhooks/:provider               # PÚBLICA (antes do express.json, corpo cru)

POST /api/financeiro/extrato/importar              # OFX/CSV persistente
GET  /api/financeiro/extrato
POST /api/financeiro/extrato/:id/conciliar         # confirmação manual
POST /api/financeiro/extrato/:id/divergir

GET  /api/financeiro/cnab/parsers
POST /api/financeiro/cnab/importar
```

---

## 7. ARQUIVOS

**Novos**
- `db/migrations/0025_p2_financeiro_gateways.sql`
- `server/src/gateway.ts`, `server/src/comissoes.ts`, `server/src/extrato.ts`, `server/src/cnab.ts`
- `server/test/financeiro-p2.test.ts` (24 testes, modo memória)
- `server/test/pg-p2.test.ts` (6 testes, PostgreSQL real, auto-skip sem `DATABASE_URL`)

**Alterados**
- `db/schema.sql` (espelho da 0025)
- `server/src/financeiro.ts` (escopo multiempresa, `efetuarBaixa` com guarda atômica e tradução de conflito, ganchos de comissão, recebíveis)
- `server/src/pdv.ts` (bloqueio retroativo pós-fechamento, justificativa)
- `server/src/index.ts` (rotas + montagem do `publicGatewayRouter` **antes** do `express.json`)
- `server/src/pgstore.ts` (correção: `update`/`tryUpdateIf` não atribuem mais colunas de carimbo geridas pelo store)

---

## 8. TESTES

### Memória (`server/test/financeiro-p2.test.ts` — 24 testes, todos verdes)

- **Multiempresa A×B**: resumo não atravessa; baixa em título alheio → 404;
  conciliação só casa títulos do próprio escopo; lançamento automático nasce
  com o `empresa_id` da origem.
- **Comissões**: parcial efetiva a fração; quitação efetiva o resto e nada
  além; sem representante/apuração nada efetiva; PDV (recebido no ato) efetiva
  no faturamento e **estorna no cancelamento**; relatório apurado × efetivado.
- **Caixa**: venda de caixa fechado não se cancela sem admin; suprimento/sangria
  seguem bloqueados após fechamento.
- **Cartão**: recebíveis bruto × taxa × líquido por vencimento.
- **Gateway**: sem config → 503 (nunca inventa); criação idempotente pela
  chave; webhook `paid` confirma cobrança e baixa o título **uma vez**;
  assinatura inválida rejeitada e válida processada; evento com erro fica para
  retry sem duplicar efeito; cancelamento/estorno com reversão financeira.
- **OFX**: FITID persistido, reimportação não duplica; linha sem match fica
  pendente → confirmação manual ou divergência.
- **CNAB**: parser lê T/U e classifica; liquidação por nosso número baixa o
  título uma vez (reprocessar o arquivo não duplica).
- **Liquidação**: método/conta/operador/auditoria registrados; valor acima do
  saldo recusado.

### PostgreSQL real (`server/test/pg-p2.test.ts` — job `testes-postgres` do CI)

**Executados de verdade contra um Postgres real (18.4) neste ambiente — 43/43
verdes, incluindo toda a suíte PG pré-existente.** No CI o mesmo conjunto roda
em `postgres:16`.

A suíte PG roda com `--test-concurrency=1`: todos os arquivos compartilham UM
banco, e arquivos em paralelo disputavam locks serializáveis/dados semeáveis
entre si (falhas intermitentes de 40P01/40001/chave duplicada vistas no CI).
Arquivo por arquivo é o modelo correto para integração com banco único.

- migration 0025 aplicada (5 tabelas + 4 índices únicos);
- **duas baixas simultâneas no mesmo título → exatamente uma vence** (a perdedora
  recebe 409 limpo, nunca 500);
- evento de webhook duplicado bate na trava;
- linha de extrato repetida bate na trava;
- comissão não efetiva além da apuração (saldo do livro);
- duas aberturas concorrentes do mesmo caixa → um único caixa aberto.

### Suíte completa

`npm --workspace server test`: **488 passam / 0 falham / 17 pulados** (os
pulos são os testes que exigem PostgreSQL real e se auto-excluem sem
`DATABASE_URL`). Typecheck verde; lint com **0 erros**; build do client verde.

---

## 9. INTEGRAÇÕES REAIS × MOCKS

| Item | Situação |
|---|---|
| `mockProvider` | **Somente teste/homologação** — recusa rodar em produção (`exigirForaDeProducao`). Nunca simula resposta de gateway em produção. |
| `mercadopagoProvider` | Adapter real (HTTP contra a API do MercadoPago). **Sem credenciais configuradas responde 503** — nunca finge sucesso. Não foi exercitado contra o provedor real neste ambiente (sem credencial de homologação); está pronto para receber `access_token` cifrado via `PUT /api/financeiro/gateway/config`. |
| Futuros PIX/boleto/cartão de outros provedores | Basta implementar `PaymentProvider` e registrar — nenhum acoplamento a um gateway específico. |
| OFX/CSV/CNAB | Parsers locais, sem dependência externa. |

---

## 10. SEGURANÇA (§17/§18)

- **Nenhum segredo em texto puro**: credenciais de gateway e segredos de
  webhook são cifrados com AES-256-GCM (`segredos.ts`) antes de persistir; as
  APIs de leitura devolvem apenas `tem_credenciais` / `tem_segredo_webhook`.
- Configuração de gateway exige **re-autenticação** recente do usuário.
- Webhook com segredo configurado **rejeita** corpo sem assinatura válida
  (registro forense do evento rejeitado + 401).
- Auditoria em: criação/configuração de gateway, cobranças (criar/cancelar/
  estornar), webhooks (recebido/processado/rejeitado/reprocessado), efetivação
  e estorno de comissões, baixa/conciliação/divergência de extrato, fechamento
  e operação retroativa de caixa.

---

## 11. RISCOS E PENDÊNCIAS CONHECIDAS

1. **MercadoPago sem validação contra conta real** — o adapter segue a API
   documentada, mas precisa de um ciclo de homologação com credencial real
   antes de produção (como na P1 com o frete).
2. **`prisma validate` não executado neste sandbox** (download do binário
   bloqueado pela rede restrita). O schema Prisma não foi alterado na P2 —
   o financeiro inteiro vive no Postgres/`schema.sql`, não no Prisma. O CI
   executa o passo normalmente.
3. **Retry de webhook** depende do cron (`POST /api/admin/financeiro/gateway/
   webhooks/processar`) estar agendado no deploy — sem o cron, eventos com
   erro só são reprocessados manualmente.
4. Conciliação automática é **deliberadamente conservadora**: só casa com
   candidato único por valor+data. Tudo o mais exige confirmação manual —
   preferência por segurança sobre conveniência, conforme §14.

---

## 12. ADESÃO À ESPECIFICAÇÃO (§20)

| Critério | Evidência |
|---|---|
| Financeiro preservado | §2 — nada que estava correto foi reescrito; suíte pré-existente verde |
| Gaps reais implementados | §3/§4 — só o que a auditoria acusou |
| Migration aplicada | 0025 idempotente; CI `testes-postgres` aplica em banco limpo |
| Testes OK | 488/0 em memória + 6 de PG no CI |
| PostgreSQL OK | testes de concorrência/índices rodam em PG 16 no CI |
| Typecheck / lint / build OK | verdes neste ambiente |
| Multiempresa OK | testes A×B explícitos (§8) |
| Idempotência OK | chave de cobrança, evento de webhook, linha de extrato, saldo do livro de comissão |
| P3 **não** implementado | §21 respeitado — nenhum item de marketplace/migração/extras |

**P2 = concluída** dentro do que é verificável neste ambiente, com as duas
ressalvas do §1 (homologação real do MercadoPago e `prisma validate` no CI).
