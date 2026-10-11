# BROBOND ERP — ROADMAP DE FECHAMENTO (ERP CORE)

**Repositório:** `petrickmsilva-alt/brobond-erp`
**Baseline:** `0c9fc202c04c288b2ea6f197a2240a98a87efc0c` (`main`) · 2026-10-11
**Relatório irmão:** [`docs/RELATORIO-ERP-ONLY.md`](RELATORIO-ERP-ONLY.md) — onde cada gap deste roadmap tem causa-raiz, arquivo, linha, evidência e severidade.
**Modo deste documento:** PLANEJAMENTO + registro de execução. O status de cada ciclo fica na tabela abaixo; nada além do que está marcado como ✅ foi implementado.

---

## 0.1 Status de execução

| Ciclo | Status | Evidência |
|---|---|---|
| **ERP-01** | ✅ **IMPLEMENTADO** (2026-10-11) | §5 ERP-01, abaixo |
| **ERP-02** | ✅ **IMPLEMENTADO** (2026-10-11) | §5 ERP-02, abaixo |
| **ERP-03** | ✅ **IMPLEMENTADO** (2026-10-11) | §5 ERP-03, abaixo |
| **ERP-04** | ✅ **IMPLEMENTADO** (2026-10-11) | §5 ERP-04 + [ADR-001](ADR-001-FONTE-UNICA-FATURAMENTO.md) |
| **ERP-05** | ✅ **IMPLEMENTADO** (2026-10-11) | §5 ERP-05 — execução abaixo · `audit:menu` **0 `RECURSO_SEM_MENU`** · P1-02 e P1-03 fechados, com **mutação** provando o 405 do P1-03 |
| **ERP-06** | ✅ **IMPLEMENTADO** (2026-10-11) | §5 ERP-06 — execução abaixo · igualdade **tela × relatório** provada em PostgreSQL (`pg/comissoes-e2e.test.ts`) · menu **69 módulos / 13 grupos** |
| **ERP-07** | ✅ **IMPLEMENTADO** (2026-10-11) | §5 ERP-07 — execução abaixo · CRUD de Empresas **`adminOnly` provado por HTTP** (`pg/empresas-admin-e2e.test.ts`: gerente recebe **403** nos quatro verbos e o seletor de empresa ativa **continua 200**) + guardas de exclusão em PostgreSQL · menu **70 módulos / 13 grupos** · **P0-06 descoberto e fechado** no ciclo (criar usuário respondia **sempre 409** em PostgreSQL) |
| **ERP-08** | ✅ **IMPLEMENTADO** (2026-10-11) | §5 ERP-08 — execução abaixo · cadeia de reversa provada ponta a ponta em PostgreSQL (`pg/devolucao-e2e.test.ts`: parcial, avariado **não** volta nem pelo estorno, total cancela a venda e reverte o financeiro, idempotência, multiempresa 404) · **mutação** da guarda de estado ⇒ teste falha |
| **ERP-09 … ERP-13** | ⏳ não iniciados | — |
| **Auditoria independente (ERP-01…04)** | ✅ **EXECUTADA** (2026-10-11) | [`docs/AUDITORIA-INDEPENDENTE-ERP-01-04.md`](AUDITORIA-INDEPENDENTE-ERP-01-04.md) — 6 provas por mutação + bateria em banco novo + CI verde · **GATE APROVADO COM RESSALVAS (P2)** |
| **Ciclo P1-13 + P2-08** (ressalvas de código da auditoria) | ✅ **IMPLEMENTADO** (2026-10-11) | §5 "Ciclo P1-13 + P2-08", abaixo — prova PG + mutação para cada um; **P2-09 segue aberto** (regra de processo) |

**Regra de execução:** um ciclo só muda de ⏳ para ✅ com a bateria completa verde (typecheck · lint · build · `server test` · `client test` · `test:pg` · `smoke`) **e** o teste central falhando antes da correção e passando depois, em PostgreSQL real.

---

## 0. Como ler este roadmap

1. A ordem dos ciclos é **arquitetural**, derivada da árvore de dependências (§4) — não da facilidade da tela.
2. **Nenhum ciclo fecha sem prova executada em PostgreSQL real.** O verde do CI atual (110/110 em `test:pg` + 126/126 no smoke em memória) **conviveu** com duas funcionalidades centrais quebradas; esse é o fato que define a regra de aceite deste roadmap.
3. **Commerce e integrações externas ficam congelados** (§6). Nenhum ciclo abaixo toca conectores, marketplaces, OAuth externo, publicação ou sincronização.
4. Todo ciclo usa o formato: **objetivo · gaps fechados · dependências · banco · backend · frontend · testes · critérios de aceite**.

---

## 1. ERP CORE — definição de pronto

🟢 **O ERP CORE está completo quando as 9 cadeias atravessarem o sistema com prova em PostgreSQL real e nenhum P0/P1 permanecer aberto.**

| # | Cadeia | Status hoje | Ciclos que fecham |
|---|---|---|---|
| 1 | Cadastro → Estoque → Venda → Financeiro → **BI** | 🟢 **pronta (ERP-04 ✅)** | — |
| 2 | Compra → Estoque → Custo → AP → Financeiro | 🟢 **pronta** | — |
| 3 | Produção → Estoque → Custo (com reabertura/estorno) | 🟢 **pronta (ERP-02 ✅)** | — |
| 4 | Venda → Expedição → Estoque | 🟢 **pronta** | — |
| 5 | Venda → Devolução → Estoque → Financeiro | 🟠 sem prova PG | ERP-08 |
| 6 | Pagamento → Recebimento → Conciliação | 🟢 **pronta (ERP-01 ✅)** | — |
| 7 | Venda → Fiscal (documento emitido) | 🟠 arquitetura sem homologação | ERP-05 → ERP-12 |
| 8 | Multiempresa (A/B sem vazamento, 12 domínios) | 🟡 **A/B provado em ERP-03 ✅**; falta a gestão | ERP-07 |
| 9 | RBAC sem dependência do front | 🟡 3 derivações | ERP-10 |

**Placar: 5 de 9 fechadas (1, 2, 3, 4 e 6) · 0 com defeito conhecido aberto · 4 parciais (5 → ERP-08, 7 → ERP-12 — **operação e tributação prontas no ERP-05**, falta a homologação real, 8 → ERP-07, 9 → ERP-10).**

---

## 2. ERP ADVANCED (depois do CORE)

Não impede operar; entra depois do 🟢:

* Reserva e disponibilidade de estoque (saldo disponível × comprometido).
* Cadastro de **Marcas** e **Unidades de medida**.
* Telas de **Comissões**, **NCM/Tributação**, **Inutilização fiscal**, **Empresas**.
* DRE por centro de custo com rateio efetivo.
* CNAB de retorno com baixa em lote.
* Nota fiscal de devolução.
* Planejamento de produção com capacidade e gargalo.
* Cobertura completa dos 11 relatórios no front.

## 3. FUTURO (não impede operar)

Responsividade e acessibilidade · breadcrumbs e atalhos de cadeia · série diária de faturamento · predição de demanda com histórico real · painel antifraude · otimização de índices e cache do BI · `no-explicit-any` (401 avisos).

---

## 4. Dependências — por que esta ordem

```
P0-02 (webhook)  ──> ERP-01 ──> Financeiro fecha confirmação de cobrança
P0-01 (estorno)  ──> ERP-02 ──> Produção volta a reabrir/cancelar
P0-04 (E2E PG)   ──> ERP-03 ──> GATE de todos os ciclos seguintes
P0-03 (BI)       ──> ERP-04 ──> Fonte única do faturamento
                                   │
              ┌────────────────────┼────────────────────┬─────────────┐
              ▼                    ▼                    ▼             ▼
           ERP-05 Fiscal      ERP-06 Comissões     ERP-07 Empresas  ERP-08 Devolução
              │
              ▼
           ERP-12 Homologação fiscal real

ERP-09 Reserva · ERP-10 RBAC · ERP-11 Cadastros/Relatórios  (paralelos, sem dependência dura)
                                   │
                                   ▼
                              ERP-13 Auditoria independente + GATE
```

**Justificativa da ordem:** ERP-01 e ERP-02 são correções de causa-raiz isolada (uma linha cada) e destravam domínios inteiros; ERP-03 é curto mas é o **instrumento de prova** — sem ele os ciclos seguintes repetiriam o ponto cego que escondeu os dois defeitos; ERP-04 depende de decisão de arquitetura (fonte única do faturamento) antes de qualquer código.

---

## 5. Ciclos

### ERP-01 — Confirmação de pagamento volta a funcionar em PostgreSQL

* **Objetivo:** restaurar o ciclo Pagamento → Recebimento → Conciliação, hoje silenciosamente quebrado em PostgreSQL.
* **Gaps fechados:** **P0-02** (webhook de gateway descartado + vazamento de constraint em endpoint público).
* **Dependências:** nenhuma.
* **Evidência que fecha o ciclo (antes):** `wh2 → 202 {"ok":false,"erro":"duplicate key value violates unique constraint \"uq_gateway_webhook_evento\""}`; cobrança permanece `pendente`; `gateway_webhook_events` do evento correto fica `status='ignorado'` com `erro='Nenhuma cobrança deste provedor com essa referência.'` mesmo existindo `gateway_cobrancas.provider_ref` idêntico.
* **Banco:** nenhuma migration prevista. **Se** a decisão for padronizar o tipo, alinhar `R_GATEWAY_WEBHOOK_EVENTS.payload` ao `jsonb` real (`db/schema.sql:2985`) por migration nova — **nunca editando migration antiga** (disciplina já seguida em `0032`).
* **Backend:** `server/src/gateway.ts` — leitura do `payload` tolerante ao tipo real da coluna (objeto **ou** string); `catch` externo da rota pública sem mensagem crua de driver; revisão da regra de duplicidade (`gateway.ts:862-864`) para que uma notificação legítima repetida responda `200 {duplicado:true}`.
* **Frontend:** nenhum.
* **Testes:**
  * PostgreSQL: **novo** `server/test/pg/gateway-webhook-postgresql.test.ts` — cobrança → 1ª notificação → `processado` e cobrança `paga`; 2ª notificação idêntica → `200 duplicado:true`, **uma** baixa, **uma** linha em `gateway_webhook_events`; notificação com `provider_ref` inexistente → `ignorado` sem erro de driver; rota pública responde sem nenhum nome de constraint.
  * Regressão em memória: garantir que o comportamento atual do `MemStore` (que hoje passa) continue passando.
* **Critérios de aceite:**
  1. `producao` (payload jsonb) e `teste` (payload texto) produzem **o mesmo resultado**.
  2. Cobrança `pendente` → `paga` após 1 webhook; **nenhuma** segunda baixa em repetição.
  3. Nenhuma resposta HTTP de endpoint anônimo contém nome de constraint, tabela ou coluna.
  4. `npm run test:pg` verde incluindo o arquivo novo.

#### ✅ Execução (2026-10-11) — CLOSED

**Arquivos:** `server/src/gateway.ts` (+87/−18) · **novo** `server/test/pg/e01-gateway-webhook-postgresql.test.ts` (0 arquivos de Commerce tocados; **nenhuma migration**).

**Causa-raiz corrigida** (uma por sintoma, na ordem em que se manifestam):
1. `processarEvento` lia `JSON.parse(String(evento.payload||'{}'))`. A coluna é **JSONB** e o driver entrega **objeto** → `"[object Object]"` → payload `{}` → `provider_ref` nulo → evento `'ignorado'`. Agora `lerPayloadWebhook()` aceita **objeto, string JSON, Buffer, nulo** — a leitura não depende do tipo devolvido pelo driver.
2. A notificação repetida **inseria** uma segunda linha (a dedup ignora `'ignorado'` de propósito), batia em `uq_gateway_webhook_evento` e o `catch` externo devolvia **202 com o nome da constraint** ao endpoint anônimo. Agora a linha rejeitada é **reaproveitada**, `23505` em corrida responde `200 {duplicado:true}` e nenhuma resposta anônima carrega mensagem de driver (`reportarErro` leva o detalhe para o log estruturado).
3. `payload` passa a ser declarado `type: 'json'` nos recursos `R_GATEWAY_WEBHOOK_EVENTS` e `R_GATEWAY_COBRANCAS` (`gateway_cobrancas.payload` também é JSONB) — a divergência declarado×banco foi a origem da classe do defeito; o corpo é gravado como **objeto JSONB consultável** (`payload->>'event_id'`), com envelope `{bruto}` para corpo não-JSON.
4. `processado` passou a refletir o efeito real (evento ignorado **não** é "processado") e o ACK ganhou `resultado`.

**Prova antes/depois na linha exata** (`/tmp/e01-direct.mts`, mesmo registro, mesmo evento, payload objeto):

```
ANTES  {"resultado":"ignorado","cobranca":"pendente","titulo":"pendente","evento":"ignorado","erro":"Nenhuma cobrança deste provedor com essa referência."}
DEPOIS {"resultado":"paga","cobranca":"paga","titulo":"confirmado","evento":"processado","erro":null}
```

**HTTP real (API 3001 contra `brobond_smoke3`, mesma base do achado da auditoria):**

```
wh1: 200 {"ok":true,"resultado":"paga","processado":true}
wh2: 200 {"ok":true,"duplicado":true}          ← antes: 202 com "duplicate key ... uq_gateway_webhook_evento"
cobrança: paga · evento: processado            ← antes: pendente / ignorado
payload no banco: jsonb_typeof = object · payload->>'status' = 'pago'
```

**Teste de aceite (PostgreSQL real, servidor spawnado, rota pública sem `express.json`):** 5 cenários + 1 teste unitário + 1 `todo`:
A) pagamento → `paga`, título `confirmado`, **uma** baixa, 1 linha de evento, payload JSONB objeto, `empresa_id` correto; 2ª notificação → `duplicado:true` sem segunda baixa ·
B) evento sem efeito → `ignorado`/`processado:false`; retry do **mesmo** `evento_id` com pagamento → processa reaproveitando a linha (não bate mais no índice único) ·
D) **corrida**: duas entregas simultâneas → ambas `200`, **um** evento, **uma** baixa ·
C) assinatura inválida → `401` + registro forense; retry assinado → processa, **1 linha**, `assinatura_ok=true` ·
E) coletor de vazamento sobre **todas** as respostas públicas.

- **Falha antes / passa depois (evidência exigida):** com `gateway.ts` original (stash) o arquivo novo dá **2 falhas** (`intenção resolvida deveria ser 'paga'`, resposta sem `resultado`); com a correção, **2 pass, 0 fail, 1 todo**, exit 0.
- **Regressão:** `server test` **671 pass / 0 fail / 63 skipped** (idêntico ao baseline) · `client test` **226** · `test:pg` **112 pass / 0 fail / 1 todo** (113 testes; baseline 110) · smoke demo **126/126** · typecheck **0** · lint **0 erros / 401 warnings** (idêntico ao baseline) · build OK.
- **CI (PR [#49](https://github.com/petrickmsilva-alt/brobond-erp/pull/49), `main` ← `arena/fe358944-brobond-erp`):** jobs `verificar` (1m27s) e `testes-postgres` (10m12s) **verdes** no run [38138475476](https://github.com/petrickmsilva-alt/brobond-erp/actions/runs/38138475476) — inclui o arquivo novo de prova. **Merge pendente da auditoria independente** (fluxo combinado: auditoria → gate → merge → ERP-02).

**Verificação independente e complemento de prova (2026-10-11, rodada de revisão do ciclo):** o arquivo de prova ganhou os cenários de aceite que ainda não estavam fixados — **(F)** `provider_ref` inexistente (HTTP 200, `resultado:'ignorado'`, `processado:false`, **uma** linha de auditoria com `cobranca_id NULL`, **nenhuma** cobrança criada, **nenhum** lançamento, repetição sem 2ª linha); **(G)** payload inválido (corpo não-JSON e JSON sem referência ⇒ `202 {ok:true, ignorado:true}` da política existente, **zero** linhas novas em `gateway_webhook_events`, medido por delta); **(H)** isolamento por empresa (webhook de A confirma **só** A — B segue `pendente`, uma única baixa — e o evento é atribuído à empresa dona da cobrança). E nasceu o **novo** `server/test/pg/gateway-cadeia-pagamento-e2e.test.ts`, que prova a **cadeia inteira por HTTP autenticado** (sessão real de gerente no PostgreSQL): título por `POST /financeiro/lancamentos` → cobrança PIX por `POST /financeiro/gateway/cobrancas` (com idempotência de criação) → **webhook assinado por HMAC** → `GET` da cobrança `paga` + título `confirmado` com **uma** baixa → **conciliação** autenticada (evento `processado` ligado a cobrança e empresa, `payload` bruto não exposto, cobrança na lista por status) → repetição `duplicado:true` sem segunda baixa → **multiempresa** (404 e listas sem o dado de A) → coletor de vazamento. O mesmo arquivo prova a **atomicidade (§12)** com um teste próprio: cobrança `cancelada` + notificação assinada de pagamento ⇒ ACK `200 {resultado:'erro', processado:false}`, cobrança **segue cancelada**, título **segue pendente**, **nenhuma** baixa e evento em **`erro`** com `tentativas`/`proxima_tentativa_em` visível para reprocessamento — nada de efeito parcial, nada de 500 e nada de vazamento. Provados em **PostgreSQL 16.14 real** neste ambiente: baseline `test:pg` **132 testes · 131 pass · 0 fail · 1 todo**; a suíte final fecha em **136 testes · 135 pass · 0 fail · 0 skipped · 1 todo**, e o arquivo `e01` dá **4 pass / 0 fail / 1 todo**. O "antes" foi reproduzido por **mutação declarada** sobre `git show HEAD:server/src/gateway.ts`: leitura com `JSON.parse(String(payload))` ⇒ `{"ok":true,…,"resultado":"ignorado","processado":false}` com `gateway_webhook_events.status='ignorado'`, `erro='Nenhuma cobrança deste provedor com essa referência.'` e cobrança `pendente`; inserção de 2ª linha + `catch` cru ⇒ `{"ok":false,"erro":"duplicate key value violates unique constraint \"uq_gateway_webhook_evento\""}`. Mutações que **derrubam** as provas novas: `filtro` (busca da cobrança sem `provider_ref`) ⇒ `'erro' !== 'ignorado'` e `'pendente' !== 'paga'`; `payloadVazio` ⇒ a cadeia para em `'ignorado' !== 'paga'`; `semEscopoDetalhe` ⇒ `200 !== 404` (B lendo a cobrança de A); e `semGuardaEstado` (sem a guarda `['pendente','autorizada']` em `aplicarIntencao`) ⇒ `'paga' !== 'erro'` (cobrança **cancelada** seria paga pelo webhook). Relatório dedicado: [`docs/RELATORIO-ERP-01.md`](RELATORIO-ERP-01.md).

**Gap NOVO descoberto durante a implementação — P1-11 (NÃO corrigido neste ciclo):** a validação de assinatura varre **todas** as configs do provedor, sem `empresa_id`; com uma empresa tendo segredo, notificações não assinadas de **outras** empresas passam a ser recusadas com 401 (o ambiente de teste provou isso na prática, com segredos residuais), e a assinatura aceita atribui o evento à empresa **que assinou**, não à dona da cobrança. Reprodução e proposta em [`docs/RELATORIO-ERP-ONLY.md`](RELATORIO-ERP-ONLY.md) §6 **P1-11**; o comportamento correto está fixado como teste `todo` (`ERP-01/P1-11`) para virar teste normal no ciclo que decidir o escopo multiempresa. **Decisão de escopo, não de código — por isso não entrou no ERP-01.**

---

### ERP-02 — Estorno e reabertura de OP em PostgreSQL

* **Objetivo:** devolver ao domínio de Produção a capacidade de desfazer uma conclusão, com erro de negócio correto quando não for possível.
* **Gaps fechados:** **P0-01**, **P1-10**.
* **Dependências:** nenhuma.
* **Evidência que fecha o ciclo (antes):** SQLSTATE **23514**, `constraint=estoques_quantidade_nao_negativo`, `detail="Failing row contains (4, 1, 1, loja, -4, 0, …)"`, stack `PgStore.adjustStock (pgstore.ts:402) ← estornarOrdem (producao.ts:557) ← aplicarRegrasOrdem (producao.ts:735)`; resposta ao cliente `500 Erro interno do servidor`.
* **Banco:** nenhuma migration prevista (a constraint está correta; o código é que a viola).
* **Backend:**
  * `server/src/producao.ts:557` — usar o primitivo de delta negativo já existente e testado (`tryAdjustStock`), tratando `null` como conflito de saldo (409 explicativo), na mesma transação.
  * `server/src/pgstore.ts` — `translatePgError` passa a traduzir **23514** (`check_violation`) para erro de negócio 409/422 em vez de 500.
  * **Auditoria de varredura:** garantir por teste que nenhuma outra chamada de `adjustStock` receba delta negativo (hoje `producao.ts:557` é a única; os outros 7 pontos usam `tryAdjustStock`, e 2 bifurcam explicitamente por sinal).
  * `E2: OP cancelada é terminal` volta a responder 409 com a lista de transições permitidas (P1-10).
* **Frontend:** nenhum obrigatório. Se o ciclo quiser aproveitar: exibir a razão do 409 quando o estorno não couber no saldo.
* **Testes:**
  * PostgreSQL: **novo** `server/test/pg/producao-reabrir-postgresql.test.ts` — OP concluída → `POST /reabrir` → 200, estoque de volta ao saldo anterior, entrada marcada como estornada, apontamentos descartados, trilha com o evento; reabrir duas vezes → idempotente/409 coerente; estorno que **não cabe** no saldo → **409 explicativo** (nunca 500); OP cancelada → 409 terminal.
  * PostgreSQL: teste de tradução de erro — um CHECK violado em qualquer recurso **não** produz `Erro interno do servidor`.
* **Critérios de aceite:**
  1. `POST /api/ordens/:id/reabrir` responde 200 em PostgreSQL e o saldo volta exatamente ao valor anterior.
  2. Nenhuma resposta 500 por violação de CHECK em nenhuma rota de produção/estoque.
  3. Smoke `E2` passa contra PostgreSQL nos 4 passos hoje reprovados.
  4. `npm run test:pg` verde incluindo o arquivo novo.

#### ✅ Execução (2026-10-11) — CLOSED

**Arquivos:** `server/src/producao.ts` (+15/−1) · `server/src/pgstore.ts` (+9) · **novo** `server/test/pg/e02-ordem-reabrir-postgresql.test.ts` — **sem migration**, sem frontend, nenhum arquivo de Commerce.

**Causa-raiz corrigida:**
1. `producao.ts` (`estornarOrdem`) chamava `adjustStock(..., −qtd, ...)`; esse primitivo monta `INSERT ... ON CONFLICT DO UPDATE`, e o CHECK `estoques_quantidade_nao_negativo` avalia o **tuple proposto** (−qtd) **antes** de o conflito resolver — daí o SQLSTATE 23514 mesmo com saldo suficiente na linha correta. Passou a usar `tryAdjustStock` (INSERT 0 com `DO NOTHING` + `UPDATE ... WHERE quantidade + delta >= 0`, com row lock) e o `null` virou **409 explicativo** ("Não há saldo de N peça(s) em ... para estornar a OP #x. Nada foi alterado").
2. `pgstore.ts` — `translatePgError` passou a traduzir **23514** (`check_violation`) para **409** com mensagem que **não** cita tabela/constraint: nenhuma violação de CHECK vira "Erro interno do servidor" em nenhum recurso.
3. **Varredura dos call sites confirmada por evidência:** `adjustStock` é chamado em 11 pontos; só `producao.ts:557` passava delta negativo — os demais são `Math.trunc(qtd)`/`quantidade`/`delta` **com guarda** (`if (delta < 0) → tryAdjustStock`) ou `if (delta > 0)`. Nenhum outro ponto a corrigir.
4. **P1-10 era cascata, não código próprio:** com o estorno funcionando, a OP volta a `planejada`, o `cancelar` responde 200 e o `PUT` numa OP `cancelada` responde **409** (vocabulário terminal). A prova cobre os dois casos.

**Prova antes/depois (mesmo teste, mesmo banco):**

```
ANTES  (código original)  reabrir precisa responder 200 — era o defeito P0-01: {"error":"Erro interno do servidor"}   → 2 falhas
DEPOIS (corrigido)        ok 1 … ok 2 · # pass 2 / # fail 0
```

**Teste de aceite (PostgreSQL real, servidor spawnado, JWT real):** fluxo completo pela API (insumo → produto → tamanho → ficha → OP → liberar → apontar → concluir) e então:
reabrir → **200**, 10 peças fora do estoque, 20 m de insumo devolvidos, **apontamentos descartados (0)**, evento `reaberta` na trilha, **uma** movimentação de estorno (`tipo=saida`, qtd 10), nenhum saldo negativo · reabrir de novo → **409** · **saldo insuficiente** (peças consumidas por fora) → **409** com mensagem de saldo, **sem** `constraint`/`SQLSTATE`/`erro interno`, e **rollback integral** (status segue `concluida`, apontamento intacto, insumo intacto, nenhuma movimentação de estorno, saldo inalterado) · OP cancelada → `PUT` **409** e `reabrir` **409** · unidade: `translatePgError(23514) → 409` sem vazar tabela/constraint.

**Smoke E2E contra PostgreSQL real (o termômetro da auditoria):**

| | Auditoria (antes) | Agora |
|---|---|---|
| `SMOKE_BASE` contra PostgreSQL com local semeado | **119/126** (7 falhas: 4 estorno + 2 cascata + 3 gateway) | **126/126 · 0 FAIL** |

Checks que reprovavam e agora passam: `E2: POST /reabrir estorna (gerente)` (200) · `E2: reabrir descarta os apontamentos` (0) · `E2: POST /cancelar guarda o motivo` (200) · `E2: OP cancelada é terminal` (409) · `webhook pago → processado` · `mesma notificação de novo → duplicado` · `cobrança ficou paga`.

- **Regressão:** `server test` **671 pass / 0 fail / 63 skipped** (idêntico ao baseline) · `client test` **226** · `test:pg` **114 pass / 0 fail / 1 todo** (115 testes) · smoke demo **126/126** · typecheck **0** · lint **0 erros / 401 warnings** · build OK.
- **CI (PR [#49](https://github.com/petrickmsilva-alt/brobond-erp/pull/49)):** jobs `verificar` (1m30s) e `testes-postgres` (10m31s) **verdes** no run [38140231798](https://github.com/petrickmsilva-alt/brobond-erp/actions/runs/38140231798) — inclui o arquivo novo de prova. **Merge pendente da auditoria independente.**
- **Risco residual documentado (não é defeito hoje):** `adjustInsumoStock` usa o mesmo padrão `INSERT delta ON CONFLICT DO UPDATE` para consumo (delta negativo). **Não dispara** porque `estoque_insumos.quantidade` **não tem** CHECK de não-negativo — mas, se um CHECK for adicionado ali, o consumo de insumos quebraria da mesma forma. Registrado como **P3-07** em [`docs/RELATORIO-ERP-ONLY.md`](RELATORIO-ERP-ONLY.md) §11.

---

### ERP-03 — Suíte E2E executável em PostgreSQL (GATE)

* **Objetivo:** o gate de aceite passa a medir o sistema que roda em produção. Este ciclo é **pré-requisito declarado de todos os seguintes**.
* **Gaps fechados:** **P0-04**.
* **Dependências:** ERP-01 e ERP-02 já proveem os casos que este gate vai proteger.
* **Evidência que fecha o ciclo (antes):** `smoke 126/126` em memória × `92/117` em PostgreSQL novo (25 × `409 A empresa ativa não possui um local de estoque ativo`) × `119/126` com `local` semeado; cabeçalho de `scripts/smoke-e2e.mjs` exigindo **modo demonstração**.
* **Banco:**
  * Definir e documentar o **bootstrap de empresa nova em PostgreSQL** (empresa + local padrão ativo + usuário admin), fechando a lacuna de onboarding: hoje uma instalação nova não recebe compra, não fatura e não movimenta estoque antes de alguém cadastrar um local.
  * Se a decisão for semear automaticamente, **migration nova** (nunca editar as 32 existentes).
* **Backend:** nenhuma regra de negócio muda. Possível ajuste em `scripts/smoke-e2e.mjs` para parametrizar por ambiente (`SMOKE_BASE` já existe).
* **Frontend:** nenhum.
* **Testes:**
  * Smoke executável contra PostgreSQL (`DATABASE_URL` apontando para banco recém-migrado) e contra memória, com o mesmo resultado.
  * Adicionar os **fluxos completos do §23** ao job `testes-postgres` do `.github/workflows/ci.yml` (o job já sobe `postgres:16`).
  * **Novo teste de contrato de tipo** — na linha do que já existe ("todo campo não-virtual de `resources.ts` existe em `db/schema.sql`"): para cada campo declarado, comparar o **tipo do recurso** com o **tipo da coluna** no banco. É o teste que teria pego P0-02 (campo `textarea` sobre coluna `jsonb`) e é a defesa estrutural contra a recorrência da mesma classe de defeito (o E4.2.3 corrigiu o lado da escrita; o lado da leitura não tinha guarda).
  * Teste A/B de multiempresa com **mesmo produto e mesmo nome de local** em duas empresas (fecha o risco R6, hoje NÃO TESTADO).
* **Critérios de aceite:**
  1. `npm run smoke` verde contra PostgreSQL real **e** contra memória.
  2. CI executa smoke + E2E PostgreSQL no job `testes-postgres`.
  3. Uma instalação PostgreSQL nova consegue, sem intervenção manual em SQL, receber uma compra e faturar uma venda.
  4. O teste de contrato de tipo roda e passa; e **falha** se um campo for declarado com tipo divergente da coluna (verificação por mutação).

#### ✅ Execução (2026-10-11) — CLOSED

**Arquivos:** `server/src/services.ts` (+~72) · `server/src/resources.ts` (8 declarações) · `db/schema.sql` (P0-05) · **novos** `scripts/smoke-pg.mjs`, `server/test/pg/contratoTipos.ts`, `server/test/pg/contrato-tipo-coluna.test.ts`, `server/test/pg/e03-onboarding-local-padrao.test.ts`, `server/test/pg/e03-multiempresa-ab.test.ts`, `server/test/multiempresa-paridade.test.ts` · `server/test/locais.test.ts` (contrato atualizado) · `.github/workflows/ci.yml` + `package.json` (`smoke:pg`).

**1. Onboarding sem SQL manual (o defeito do banco novo).** O modo demonstração tem `locais.mock` (loja/expedicao/faccao) e o PostgreSQL não tem nenhum — daí as 25 falhas `409 A empresa ativa não possui um local de estoque ativo` num banco recém-migrado. A regra passou a ser explícita e restrita em `getDefaultLocalInfo` (`services.ts`), ponto único por onde passam **todos** os fluxos de estoque (recebimento, faturamento, movimentação, inventário, importação, PDV, produção):

* empresa **sem nenhum local** → a primeira operação provisiona o Local padrão **"Loja"** (ativo, `padrao`), com **entrada na trilha de auditoria** (`usuario: 'sistema'`), e segue o fluxo;
* empresa **com locais** (mesmo inativos) → nada é criado; se não houver padrão ativo, a resposta continua sendo o **409 explicativo** — a decisão de não ter local ativo é do administrador.

Corrida coberta: `uq_e42_locais_empresa_nome` / `uq_e42_locais_padrao_empresa` deixam passar um só; quem perde relê o local do vencedor. **Armadilha vivida e documentada:** `audit()` sem `tx` abre a PRÓPRIA transação (`withTransaction`) e a segunda conexão escrevendo dentro da transação do fluxo faz o PostgreSQL SERIALIZABLE abortar com **40001** — foi o que aconteceu na primeira versão (ver **P3-08**).

**Mudança de contrato declarada:** cadastro de locais **vazio deixou de bloquear** a operação (era o comportamento que o P0-04 mandou mudar). O teste de memória `locais.test.ts` foi atualizado para o contrato novo e `docs/LOCAL-PADRAO.md` deixou de prometer um fallback textual ("loja") que o código nunca implementou.

**2. `npm run smoke:pg` — o gate virou executável.** `scripts/smoke-pg.mjs` cria um **banco novo** a partir do `DATABASE_URL`, sobe a API real nele (migrate + `ensureAdmin` automáticos, esperando o boot **concluir** e não só o `/health`), roda `scripts/smoke-e2e.mjs` apontado para ela e apaga o banco devolvendo o código de saída. Como o banco nasce do zero, o smoke (não idempotente) passou a poder rodar em **qualquer** execução — e o CI ganhou a etapa `Smoke E2E contra PostgreSQL novo` no job `testes-postgres`.

```
$ DATABASE_URL=… npm run smoke:pg     # banco novo, ZERO SQL manual
🗄️  smoke:pg — banco novo: brobond_smoke_mv3uc4xc
✅ smoke:pg — API pronta em http://127.0.0.1:37207 (db=postgres, banco novo, ZERO SQL manual)
126/126 verificações OK
✅ smoke:pg — smoke E2E aprovado contra PostgreSQL real   (4 s)
```

Inspeção do banco criado pelo gate (prova de que nada foi semeado):

| O que | Resultado |
|---|---|
| `SELECT * FROM locais` | **1 linha**: `Loja` · tipo `loja` · ativo · `padrao` · empresa 1 |
| `auditoria` | `usuario='sistema'`, `acao='criar'`, `recurso='locais'`, `dados->>'provisionado'='true'` — “Local padrão "Loja" criado automaticamente: a empresa #1 não tinha nenhum local (ERP-03)” |
| `estoques` / `movimentacoes` | saldos e movimentos com `local_id` do local provisionado (o caminho canônico, não o texto legado) |

**3. Contrato tipo × coluna (a guarda estrutural).** `server/test/pg/contratoTipos.ts` inspeciona **os 88 recursos do sistema** (os de `resources.ts` + os 8 declarados pelos módulos — gateway, webhooks, comissões, configurações, extrato) contra o PostgreSQL real em quatro regras: existência da coluna, **tipo** (a regra que teria pegado o P0-02), **unicidade** (`unique` ⇒ índice global; `uniqueEmpresa` ⇒ índice por empresa — é o que o `memdb` replica) e **interface** (`json` editável em recurso público, que o cliente não sabe renderizar). Divergências passam só por allowlist explícita e justificada (`arquivos.dados/thumb` → `bytea`, escritos por `uploads.ts`).

O inspetor reprovou **7 declarações** que estavam mentindo sobre o banco — todas alinhadas neste ciclo:

| Campo | Declarado | Coluna real | Risco |
|---|---|---|---|
| `catalogo_eventos.dados` | `text` | `jsonb` | leitura como texto (classe do P0-02) |
| `documentos_fiscais_eventos.payload` | `textarea` | `jsonb` | **o gêmeo do P0-02** na resposta do provedor fiscal |
| `compras.fin_parcelas_detalhes` | `text` | `jsonb` | lista de duplicatas lida como texto |
| `itens_compra.dados_fiscais` · `importacoes_nfe.dados_fiscais` | `text` | `jsonb` | impostos da linha da NF-e |
| `produtos.sku` · `produtos.codigo_barras` | `unique` (global) | índice **por empresa** | memória recusava o que o PostgreSQL aceita |
| `empresas.nome` | `unique` | **nenhum índice** | mesma divergência, sem lastro no banco |

O último teste do arquivo é a **prova de mutação**: um recurso sintético com a declaração exata do P0-02 precisa ser reprovado (e é), e as variantes de unicidade e de interface também — sem isso o teste seria uma tautologia que passa sempre.

**4. P0-05 — descoberto pelo A/B e fechado no mesmo ciclo.** O teste A/B (mesmo SKU e mesmo código de barras em duas empresas) criou o estado legítimo "duas empresas com o mesmo EAN" — e **todos os 72 testes seguintes do `test:pg` caíram** com `could not create unique index "uq_produtos_codigo_barras"`: o `db/schema.sql` ainda recriava a cada boot o índice **global** de `codigo_barras` (linha 848) antes do `DROP` do trecho multiempresa. Num banco com duplicidade entre empresas, **a API não subia**.

```
ANTES (schema.sql com o índice legado)   MIGRATE FALHOU: could not create unique index "uq_produtos_codigo_barras"
DEPOIS (CREATE legado removido)          MIGRATE OK
```

**5. A/B multiempresa executável (fecha o risco R6).** `e03-multiempresa-ab.test.ts` (PostgreSQL: 4 testes) e `multiempresa-paridade.test.ts` (memória: 3 testes) provam o mesmo contrato nos dois motores: mesmo SKU e mesmo nome de local em duas empresas coexistindo, duplicata **dentro** da empresa em 409, local padrão **por empresa** (`getDefaultLocalInfo` de A nunca devolve o de B), saldos isolados no local de mesmo nome e troca de padrão em A sem efeito em B.

**Prova antes/depois do provisionamento** (mesmo teste, mesmo banco, `git stash` do `services.ts`):

```
ANTES  not ok 1 — a primeira movimentação precisa funcionar sem local cadastrado: 409 A empresa ativa não possui um local de estoque ativo
DEPOIS ok 1 — # pass 1 / # fail 0
```

**Critérios de aceite:**
1. ✅ `npm run smoke:pg` verde contra PostgreSQL real (126/126, banco novo) **e** smoke do modo demonstração 126/126.
2. ✅ Job `testes-postgres` do CI ganhou a etapa `Smoke E2E contra PostgreSQL novo (gate ERP-03)` — failure com annotation de diagnóstico.
3. ✅ Instalação nova recebe compra, fatura venda e movimenta estoque **sem um único SQL manual** (é o que o smoke faz, dentro dos 126 checks, e o que o teste de onboarding prova ponta a ponta).
4. ✅ Contrato de tipo roda e passa nos 88 recursos e **falha** sob mutação (4 casos).
- **Regressão:** `server test` **674 pass / 0 fail / 63 skipped** (737) · `client test` **226** · `test:pg` **122 pass / 0 fail / 1 todo** (123) · typecheck **0** · lint **0 erros / 401 warnings** · build OK.
- **CI (PR [#49](https://github.com/petrickmsilva-alt/brobond-erp/pull/49)):** run [38145219833](https://github.com/petrickmsilva-alt/brobond-erp/actions/runs/38145219833) **verde** — `verificar` 1m25s e `testes-postgres` **12m24s** (era 10m31s: os ~2 min a mais são a etapa nova `Smoke E2E contra PostgreSQL novo`, concluída com **success**). O gate deixou de ser um script manual e passou a bloquear o merge sozinho.
- **Achados abertos registrados neste ciclo:** **P1-12** (payload fiscal truncado em 20.000 caracteres → JSON inválido; ERP-05) · **P2-07** (`/api/health` responde `db=postgres` antes das migrações terminarem — o gate precisou esperar o boot real) · **P3-08** (`audit()` sem `tx` dentro de transação abre segunda conexão → 40001 em SERIALIZABLE).
- **P2-03 / P2-06 declarados** (fechando a promessa da matriz): memória/modo demonstração é ambiente de demonstração, **não** produção, e a suíte de concorrência continua exclusiva do `PgStore` — agora escrito no cabeçalho de `scripts/smoke-pg.mjs` além deste documento.

---

### ERP-04 — Fonte única do faturamento: o ERP alimenta o BI

* **Objetivo:** o Meu Negócio passa a refletir a operação real do ERP.
* **Gaps fechados:** **P0-03**, **P1-07**.
* **Dependências:** exige **decisão de arquitetura registrada por escrito antes de código** (não é decisão técnica isolada — é a fronteira ERP × Commerce, §6).
* **Evidência que fecha o ciclo (antes):** venda #1 faturada (2 × R$ 100,00) pela API → `GET /api/negocios/resumo` → `faturamentoCents: 0, pedidos: 0, cmvCents: 0`; `GET /api/negocios/abc` → `{A:0, B:0, C:0}`; banco: `vendas=1, itens_venda=1, sales=0, sale_items=0, produto_abc=0`; `GET /api/relatorios/vendas` → 200 (o relatório do ERP vê a venda).
* **Decisão a tomar (uma das três, registrada em ADR):**
  * **(A)** o motor analítico passa a ler `vendas`/`itens_venda` (ERP), mantendo `sales` apenas para ingestão de canais externos;
  * **(B)** manter o motor sobre `sales` e criar uma **projeção** `vendas → sales` (trigger/view/rotina), com o risco de duas verdades persistirem;
  * **(C)** unificar as duas tabelas em uma só (maior custo, migração de dados de Commerce).
  > Recomendação técnica: **(A)**. O motor, a query de margem, a curva ABC e os testes ficam intactos; muda apenas a origem dos dados. Preserva o congelamento de Commerce e não reimplementa `negocios.ts` (proibido pelo escopo da auditoria).
* **Banco:** depende da decisão (A não exige migration de dados; B exige projeção; C exige migração com backfill). **Nunca editar as 32 migrations existentes.**
* **Backend:** `server/src/negocios.ts` — origem dos dados na CTE `vendas_escopo` (linhas 494/502/558) e no `UPDATE` (575). Manter `sources` e a rotina de refresh (`initNegociosEngine`) como estão. Rever o gate de autorização (`negocios.ts:1424,1440`) se a origem mudar de recurso.
* **Frontend:** nenhum obrigatório — o painel já existe e já está testado (`Dashboard.negocios.test.tsx`).
* **Testes:**
  * PostgreSQL: **novo** `server/test/pg/bi-faturamento-e2e.test.ts` — vender e faturar pelo fluxo do ERP → o BI reflete faturamento, pedidos, ticket médio, CMV, impostos e ABC com **os mesmos valores** dos relatórios do ERP.
  * **Critério de igualdade numérica:** `GET /api/negocios/resumo` e `GET /api/relatorios/faturamento` para o mesmo período e empresa devem devolver o **mesmo total** (tolerância zero em centavos).
  * Manter e estender os 3 arquivos de teste existentes do motor (`negocios.test.ts`, `negocios-seguranca.test.ts`, `pg-negocios.test.ts`) sem afrouxar asserções.
* **Critérios de aceite:**
  1. Venda faturada pelo ERP aparece no BI na mesma requisição seguinte (ou após o ciclo de refresh documentado).
  2. Faturamento do BI = faturamento do relatório do ERP = faturamento do DRE, para o mesmo período/empresa.
  3. Curva ABC classifica os produtos vendidos pelo ERP.
  4. Venda de canal externo (Commerce) continua entrando exatamente como hoje — **sem regressão**, apesar do congelamento.

#### ✅ Execução (2026-10-11) — CLOSED

**Decisão registrada antes do código:** [`docs/ADR-001-FONTE-UNICA-FATURAMENTO.md`](ADR-001-FONTE-UNICA-FATURAMENTO.md)
— opção **(B) projeção derivada** (§3 do ADR), que **substitui a recomendação
preliminar (A)** com quatro evidências que a investigação do ciclo levantou: a
ingestão externa escreve `sales` **neste** repositório (`modules/connectors/`), a
margem é materializada **em** `sales` (a união exigiria duas versões da mesma
matemática de CMV/NCM), o painel dos conectores também lê `sales` e o
`POST /api/negocios/vendas` **já** gravava em `sales` — a tabela já era o modelo
de leitura; faltava o fluxo operacional alimentá-la.

**O que foi implementado (sem migration, sem tocar a ingestão):**

1. **`negocios.ts` — projeção `vendas → sales`** (`projetarVendasErp`): linhas no
   namespace `erp:venda:<id>` / `erp:item:<id>`; faturada/entregue → `PAID`;
   cancelada **que já foi projetada** → `CANCELLED`; aberta/cancelada sem venda →
   nada (e projeção órfã é removida); margem materializada **na mesma
   transação** da projeção (o BI nunca vê venda `PAID` sem margem); tabela de
   canal explícita (`pdv`/`balcao` → `LOJA_FISICA`; o resto → `BROBOND`, sem
   inventar qual marketplace — ADR-001 §4). Modo demonstração projeta do store
   de memória com a mesma regra.
2. **Gancho de ciclo de vida da venda** (`server/src/eventosVenda.ts`, módulo
   folha para não criar ciclo `negocios → services → itens → negocios`):
   `faturarVenda` e `estornarVenda` (`itens.ts`) notificam; o motor agenda a
   projeção com debounce de 3 s. Terceira via: `cicloDoMotor` (boot + intervalo +
   cron) e `POST /api/negocios/margens/recalcular` (que agora projeta antes de
   recalcular).
3. **Achado do próprio critério de igualdade — corrigido:** `relatorios.ts`
   comparava `String(Date).slice(0, 10)` (`"Wed Oct 11"`) contra a data pedida em
   **8 pontos** (faturamento, vendas, ABC, comissões, movimentações, produção,
   razão). Em PostgreSQL, TIMESTAMPTZ chega como `Date`: com `?de=&ate=` o filtro
   **descartava linhas reais** — o teste de igualdade do ciclo reprovou por isso
   (`BI 20000` × `relatório 0`). Agora usa `diaISO()` (mesma normalização que o
   `dataISO` do financeiro, `financeiro.ts:41-52`). `comissoes.ts:261` tem o
   mesmo defeito **e ficou aberto de propósito** — é território do ERP-06
   (registrado na matriz).

**Prova (banco NOVO + servidor real): `server/test/pg/bi-faturamento-e2e.test.ts`**
— venda de 2 × R$ 100,00 faturada pelo fluxo do ERP (cadastro → estoque →
pedido → item → `PUT status=faturada`) e, sem nenhuma chamada manual ao motor:

```
BI  kpis: faturamentoCents 20000 · pedidos 1 · ticketMedio 20000
         cmvCents 8000 (2 × custo 40) · impostosCents 2000 (alíquota padrão 10%)
         lucroBrutoCents 10000 · semMargemCalculada 0
IGUALDADE  /negocios/resumo (20000) == /relatorios/faturamento (R$ 200,00)  [tolerância zero]
ABC  produto vendido pelo ERP na curva, classe A, 20000
PROJEÇÃO  sales id=erp:venda:<id> status=PAID channel=BROBOND empresa=1
NÃO-REGRESSÃO  venda de canal externo (NUVEMSHOP) inserida como a ingestão insere:
              11 campos byte a byte iguais depois da sincronização;
              BI soma as duas origens (25000, 2 pedidos); zero linhas duplicadas
```

**Paridade do modo demonstração: `server/test/negocios-projecao-erp.test.ts`
(3/3)** — mapeamento explícito, faturada → `PAID` com margem em centavos,
cancelada → `CANCELLED`, aberta não projetada, idempotência e o **gancho real**
(`initNegociosEngine` + debounce) projetando sem chamada manual.

**Critérios de aceite:**
1. ✅ Venda faturada pelo ERP aparece no BI após o ciclo documentado (gancho com
   debounce; teste espera o ciclo, não força).
2. ✅ Faturamento do BI == faturamento do relatório do ERP, mesmo período/empresa,
   tolerância zero em centavos (o DRE usa a mesma base de vendas do relatório).
3. ✅ Curva ABC classifica o produto vendido pelo ERP (classe A, faturamento exato).
4. ✅ Venda de canal externo continua entrando exatamente como hoje — **sem
   regressão**: campos conferidos um a um e soma preservada no BI.

- **Regressão:** `server test` **677 pass / 0 fail / 63 skipped** (740) · `client test` **226** · `typecheck` 0 · lint **0 erros / 401 warnings** · build OK · smoke demonstração **126/126** · `smoke:pg` (banco novo) **126/126**.
- **Achados registrados neste ciclo:** **P1-13** (filtro de período por `String(Date).slice` — `comissoes.ts:261` fechado no ciclo seguinte; 8 pontos de `relatorios.ts` corrigidos aqui) · **P1-14** (`sales.usuario_id NOT NULL` obriga a projeção a eleger um responsável por empresa — documentado no ADR; venda de empresa sem usuário ativo não é projetada).

---

### Resumo curado dos ciclos ERP-01 … ERP-04 (2026-10-11)

Uma página para quem não vai ler os quatro blocos acima. Cada ciclo fechou um defeito **provado** (dois
deles já observados em produção/auditoria), com teste que **falha antes e passa depois** em PostgreSQL real.

| Ciclo | Defeito que existia | Onde estava | Prova |
|---|---|---|---|
| **ERP-01** | webhook de pagamento **descartado** (cobrança presa em `pendente`) e `202` devolvendo nome de constraint em endpoint anônimo | `gateway.ts`: `JSON.parse(String(payload))` sobre coluna **JSONB** | `pg/e01-gateway-webhook-postgresql.test.ts` · mutação: **2 falhas** · HTTP `wh1 200 {paga}` / `wh2 200 {duplicado}` |
| **ERP-02** | reabrir/estornar OP devolvia **500** (`estoques_quantidade_nao_negativo` disparando no `INSERT … ON CONFLICT`) | `producao.ts` + `pgstore.ts` | `pg/e02-ordem-reabrir-postgresql.test.ts` · mutação: **2 falhas** · `POST /ordens/1/reabrir → 200` |
| **ERP-03** | instalação nova **sem Local padrão** (a primeira operação de estoque falhava) e índice único **global** de `codigo_barras` derrubando o boot | `services.ts` / `db/schema.sql` | `pg/e03-*` (2 arquivos) + `pg/contrato-tipo-coluna.test.ts` (88 recursos) · mutações: **1 falha** e `MIGRATE FALHOU: could not create unique index "uq_produtos_codigo_barras"` |
| **ERP-04** | BI lia `sales` e não enxergava a venda do ERP (`pedidos: 0`); filtro de período do relatório **descartava** linhas | `negocios.ts` / `relatorios.ts` | `pg/bi-faturamento-e2e.test.ts` (banco novo, servidor real): BI `20000` = relatório `20000`, ABC classe A, canal externo intacto · mutações: `fail 1` em cada |

**Estado na data desta curadoria:**

* **Regressão:** `server` **743** testes (680 pass · 0 fail · 63 skip) · `client` **226/226** · lint **0 erros** (401 warnings, igual ao baseline) · `typecheck` **0** · `build` **OK**.
* **PostgreSQL:** `npm run test:pg` em **banco novo** **126 · 125 pass · 0 fail · 1 todo** (P1-11) · `npm run smoke:pg` **126/126** — o mesmo smoke que a auditoria mediu em **119/126** antes das correções (as 7 falhas eram: 4 de estorno, 2 de cascata e 3 de gateway).
* **P0 fechados:** P0-01 (ERP-02) · P0-02 (ERP-01) · P0-03 (ERP-04) · P0-04 e P0-05 (ERP-03).
* **P1 fechados:** P1-07 (ERP-04) · P1-10 (ERP-02, cascata) · P1-13 (ciclo pós-auditoria).
* **Abertos e conhecidos:** P1-11 (escopo multiempresa da assinatura de webhook — decisão de arquitetura) e P2-09 (a bateria só vale em banco novo — regra de processo, não defeito).
* **Fora de escopo por decisão:** E8 Commerce e integrações externas — **nenhum** arquivo do repositório do Commerce foi lido, copiado ou tocado.
* **Merge:** o fluxo combinado é **AUDITORIA → GATE → MERGE → ERP-02 → …**; a auditoria **não mergeia**. A [PR #49](https://github.com/petrickmsilva-alt/brobond-erp/pull/49) segue aberta aguardando a decisão do dono do repositório. Os ciclos **não** foram desenhados para avançar sem essa decisão — o próximo (ERP-05) está descrito e pronto, não iniciado — **implementado em 2026-10-11** (§5, execução do ERP-05).

### Auditoria independente (ERP-01 … ERP-04) — 2026-10-11

**Commit auditado:** `bb17f19` · **documento:** [`docs/AUDITORIA-INDEPENDENTE-ERP-01-04.md`](AUDITORIA-INDEPENDENTE-ERP-01-04.md) · **veredito: ✅ GATE APROVADO COM RESSALVAS (P2)**.

A auditoria foi feita para **tentar derrubar** as conclusões dos quatro ciclos — não para confirmá-las
por leitura de resumo:

* **6 provas por mutação em PostgreSQL real** (o arquivo do fix revertido ⇒ o teste do ciclo falha):
  `gateway.ts` (`pass 0 · fail 2`) · `producao.ts`+`pgstore.ts` (`fail 2`) · `services.ts` (`fail 1`) ·
  `db/schema.sql` com o mesmo EAN em duas empresas (`MIGRATE FALHOU: could not create unique index
  "uq_produtos_codigo_barras"`; restaurado: `MIGRATE OK`) · `negocios.ts` (`BI pedidos 0`, não 1) ·
  `relatorios.ts` (`relatório 0`, não 20000). Todos os arquivos restaurados; árvore limpa no fim.
* **Bateria completa em banco NOVO:** `test:pg` **124 testes · 123 pass · 0 fail · 1 todo (P1-11)**.
* **CI do commit auditado verde** (runs [38148326540](https://github.com/petrickmsilva-alt/brobond-erp/actions/runs/38148326540) e 38148323203), incluindo a etapa `Smoke E2E contra PostgreSQL novo (gate ERP-03)` — que aqui deixou de ser promessa e passou a ser **step executado**.
* **Invariantes do ADR-001 conferidos no código e no banco:** namespace `erp:`, idempotência, sem
  invenção de dado, escopo por `empresa_id`, ingestão externa intacta (11 campos).
* **Experimento controlado em banco descartável** para os casos-limite que o ADR declara (venda sem
  usuário ativo; empresa sem usuário ativo com outra empresa com).

**Achados — registrados, não corrigidos (a auditoria documenta):**

* **P2-08** (AUD-01) — projeção com **zero** usuários ativos: o passo dos itens não repete a condição
  de responsável e a instrução viola `sale_items_sale_id_fkey` (`23503`); a via sob demanda responde
  `400 "Referência inválida"`. O ADR dizia "pulada e logada".
* **P2-09** (AUD-03) — `test:pg` **não é repetível em banco reaproveitado**: o CNPJ gerado pelos testes
  tem 4–6 dígitos efetivos no índice `uq_empresas_cnpj` (que compara só dígitos) e as empresas do
  cenário nunca são removidas (5 testes reprovados em `brobond_teste`; arquivo isolado passa 7/7 duas
  vezes em banco novo). **Por isso a bateria de referência deste roadmap é sempre em banco novo.**
* **AUD-02** (documentação, corrigida aqui) — o responsável eleito pela projeção pode ser de **outra**
  empresa (fallback global); ADR §4/§5 e a linha P1-14 do relatório passaram a descrever o comportamento
  real. **Nenhum vazamento** nas telas atuais (BI por `empresa_id`; painel de conectores por
  `usuario_id + channel` de conector, canal que a projeção não produz).

**Observação de duração do CI (para não virar suspeita):** o job PG varia de **1m30s a 12m24s** entre
runs. A causa foi medida: um único `migrate()` custa **~30 s neste sandbox** (com `user` CPU de 0,3 s —
é I/O) e são 24 arquivos de teste, cada um com a sua migração; em disco rápido o mesmo trabalho cai
para a casa do minuto e meio. O log do runner não é baixável deste ambiente — a bateria local é a
evidência primária.

---

### Ciclo P1-13 + P2-08 — as ressalvas de código da auditoria, fechadas (2026-10-11)

**Origem:** as duas ressalvas de **código** do [§6 da auditoria independente](AUDITORIA-INDEPENDENTE-ERP-01-04.md).
Nenhuma das duas é funcionalidade ausente: são defeitos comprovados em PostgreSQL, na linha do
que o ERP-04 tornou visível (número certo × número que o código destrói). Entraram antes do ERP-05
para a bateria de referência continuar sem "falha conhecida".

**P1-13 — uma única normalização de data civil (`utils.diaISO`).**
A classe do defeito: o driver entrega `TIMESTAMPTZ` como `Date`, `String(date).slice(0, 10)`
produz `"Thu Oct 01"` e **qualquer** comparação lexicográfica de período (ou igualdade de dia)
passa a **descartar linhas reais** — em silêncio, sem erro e sem log. Corrigido em **18 arquivos** (= `utils.ts` + 17 módulos),
com a implementação única em `server/src/utils.ts` (`Date` \| string ISO \| string \| vazio \|
inválido → `''`, comentário explicando o porquê): `relatorios.ts`, `financeiro.ts` (que já tinha a
cópia certa — passou a delegar), `comissoes.ts`, `extrato.ts`, `export.ts` (CSV/XLSX),
`listasPreco.ts`, `propostas.ts`, `quality.ts`, `usuariosAdmin.ts`, `scheduled.ts`,
`producao.ts`, `fiscalRegras.ts`, `politicasComerciais.ts`, `portal.ts`, `nfe.ts`, `gateway.ts` (vencimento vindo do lançamento) e `pdf.ts` (documento impresso). As cinco cópias
locais (`relatorios`, `financeiro`, `listasPreco`, `propostas`, `extrato`) desapareceram.
**Fora de escopo, de propósito:** entradas **externas** (CSV/OFX/XML/corpo JSON — formato que o
sistema não controla, ex.: `financeiro.ts:1180`) e as datas que o próprio Node produz
(`new Date().toISOString().slice(0, 10)`), que não têm o defeito.

**P2-08 — o passo dos itens repete a condição de responsável.**
`sales.usuario_id` é `NOT NULL`: o passo das vendas só projeta com responsável ativo
(`AND COALESCE(eu.usuario_id, fb.usuario_id) IS NOT NULL`). O passo dos itens **não repetia** a
condição — com zero usuários ativos a venda não entrava em `sales` e os itens tentavam entrar:
`23503` (`sale_items_sale_id_fkey`) abortava a transação inteira e a via
`POST /api/negocios/margens/recalcular` respondia `400 "Referência inválida"`
(`translatePgError` em `services.ts:43-50`) — mensagem que esconde a causa real. Corrigido com
`AND EXISTS (SELECT 1 FROM sales s WHERE s.id = 'erp:venda:' || iv.venda_id)` no `INSERT` dos
itens: venda não projetada **não produz itens**, sem linha parcial e sem erro.

**Evidência (PostgreSQL 18.4 real; bancos descartáveis novos):**

| Prova | Comando | Resultado |
|---|---|---|
| P1-13 — unidade | `server/test/utils.test.ts` | **3/3** (inclui o caso `Date` → `"Thu Oct 01"` × `diaISO` → `2026-10-01`) |
| P1-13 — ponta a ponta | `server/test/pg/comissoes-periodo.test.ts` (banco novo) | ✅ venda faturada 28/04 e evento 30/04 aparecem no período; fora do período, nada |
| **P1-13 — mutação** | `comissoes.ts:261` revertido para `String(d \|\| '').slice(0, 10)` | ❌ **`not ok`** — "o representante precisa aparecer no relatório do período" |
| P2-08 — ponta a ponta | `server/test/pg/projecao-sem-usuario.test.ts` (banco novo) | ✅ não lança, **nenhuma linha parcial** (0 em `sales` e 0 em `sale_items`), e projeta quando o responsável volta |
| **P2-08 — mutação** | cláusula `EXISTS` do passo 2 removida | ❌ **`not ok`** — `23503 sale_items_sale_id_fkey` (`Key (sale_id)=(erp:venda:7) is not present in table "sales"`) |
| P2-08 — experimento controlado | `/tmp/aud-nouser.mts` (banco descartável) | **pré-fix:** `projetarVendasErp` LANÇA `23503` e a rota devolve erro; **pós-fix:** `{vendas:0, itens:0}` e a rota responde `200` |
| Bateria completa | `npm run test:pg` em banco NOVO | **126 testes · 125 pass · 0 fail · 1 todo** (P1-11) |
| Regressão | `server test` · `client test` · `lint` · `typecheck` | **743** (680 pass · 0 fail · 63 skip) · **226/226** · **0 erros** / 401 warnings · **0** |
| Smoke PostgreSQL | `npm run smoke:pg` (banco novo) | **126/126** |

**Nenhuma migration, nenhum arquivo do Commerce, nenhuma rota, tela ou menu alterados.**
O `todo` da bateria continua sendo o P1-11 (escopo multiempresa da assinatura de webhook), que
segue **aberto por decisão de arquitetura** — como registrado no ERP-01.

**Smoke E2E contra PostgreSQL real (o termômetro da auditoria), reexecutado no commit deste ciclo:** `npm run
smoke:pg` em banco novo — **126/126 · 0 FAIL** (a auditoria media **119/126** antes do ERP-01/ERP-02). Os checks
que reprovavam e agora passam incluem `E2: POST /reabrir estorna (gerente) → 200`, `E2: reabrir descarta os
apontamentos → 0`, `E2: OP cancelada é terminal → 409`, `webhook pago → processado` (com `cobrança ficou paga`) e
`E3.1: cancelar compra recebida → estorno` com `custo médio restaurado`.

**CI deste ciclo:** commit [`f978ef1`](https://github.com/petrickmsilva-alt/brobond-erp/commit/f978ef1) — runs
[38154792779](https://github.com/petrickmsilva-alt/brobond-erp/actions/runs/38154792779) e
[38154789238](https://github.com/petrickmsilva-alt/brobond-erp/actions/runs/38154789238) **verdes** (jobs `verificar` e
`testes-postgres`, incluindo a etapa `Smoke E2E contra PostgreSQL novo`).

---

### ERP-05 — Fiscal operacional (sem homologação)

* **Objetivo:** tornar o módulo Fiscal utilizável por quem opera: ver, configurar e corrigir a tributação sem chamar API.
* **Gaps fechados:** **P1-02** (NCM sem tela), **P1-03** (inutilização sem tela). **Defeito descoberto durante o ciclo e corrigido:
  a rota `POST /api/fiscal/inutilizar` respondia 405 para todo perfil** (`checkAccess(...,'create')` sobre recurso de fluxo) — detalhe na execução, abaixo.
* **Dependências:** nenhuma dura. Precede ERP-12 (homologação) porque homologar sem conseguir manter a tributação é operação insustentável.
* **Evidência do gap:** `audit:menu` → `[RECURSO_SEM_MENU] impostos_ncm` e `[RECURSO_SEM_MENU] inutilizacoes_fiscais`; `resources.ts:483` e `1217` com ops `cud`; nenhum consumo no client.
* **Banco:** nenhuma migration prevista (tabelas existem).
* **Backend:** nenhuma rota nova esperada; conferir se `inutilizacoes_fiscais` tem todos os campos exigidos pela SEFAZ (faixa, série, justificativa, protocolo, status) antes de expor.
* **Frontend:** telas/entradas de menu para **NCM/Tributação** (lista, cadastro, vigência) e **Inutilizações** (solicitar, consultar, ver protocolo). Grupo **Fiscal** proposto no menu final (relatório irmão, §17.4).
* **Testes:** `client/src/pages` — teste de tela para cada uma; manter `fiscal.test.ts` e `pg-fiscal.test.ts`. Teste PG para inutilização persistida com faixa/justificativa.
* **Critérios de aceite:** operador consegue cadastrar alíquota por NCM e inutilizar uma faixa de numeração **sem** API manual; `audit:menu` passa a reportar **0** `RECURSO_SEM_MENU`.

---

#### ✅ Execução (2026-10-11) — CLOSED (P1-02 e P1-03)

**O que o ciclo entregou:** as duas telas do módulo Fiscal que faltavam, o **grupo Fiscal** no menu
e a correção de um defeito que **nenhum teste cobria** — a inutilização de numeração era
**inalcançável por HTTP**, para qualquer perfil.

**P1-03 — `POST /api/fiscal/inutilizar` respondia 405 para TODO perfil (defeito comprovado).**
`inutilizarNumeracao` chamava `checkAccess(R_INUT(), actor, 'create')` sobre um recurso declarado com
`ops.create = false` (`server/src/fiscal.ts:843`; o recurso está em `resources.ts:1235` com `ops` só de
leitura). A checagem de permissão devolve **405 antes** de qualquer validação, de qualquer consulta ao
provedor e de qualquer gravação — ou seja, a rota existia, tinha tabela, tinha CHECK e **nunca
funcionou**; em memória e em PostgreSQL, para gerente e para administrador. Reprodução preservada:
`/tmp/aud-inut.mts` (gerente + provedor falso) devolvia `405 {"error":"Não é possível incluir registros
em Inutilizações de numeração."}` com **0 registros** no banco.

**A correção usa a alçada certa — a de FLUXO, não a de CRUD.** `checkFluxo(R_INUT(), actor)`
(`services.ts:176`, o mesmo padrão já usado em `expedicao.ts` e `pdv.ts`) mantém `minPerfil: 'gerente'`
e `adminOnly` e **não consulta `ops`** — o `ops` fechado continua fechado, então o CRUD genérico
(`POST /api/inutilizacoes_fiscais`) segue recusando escrita: **não foi aberta nenhuma porta lateral**.
Nenhuma migration, nenhuma tabela, nenhuma rota nova; a tela e o endpoint passaram a ser o caminho
legítimo que o recurso sempre quis ter.

**P1-02 — NCM/Tributação.** `/ncm` (`client/src/pages/NcmPage.tsx`): CRUD de `impostos_ncm` com a linha
**PADRÃO** (chave vazia) destacada, validação de chave 2–8 dígitos e alíquota 0–100, e aviso explícito de
qual alíquota padrão está vigente — ou de que NCMs sem chave ficam em **0%**, que é onde o silêncio do
sistema custava dinheiro. **P1-03 (tela):** `/inutilizacoes` (`client/src/pages/InutilizacoesPage.tsx`):
formulário com modelo/série/faixa/justificativa (≥ 15 caracteres, validado no cliente *e* no servidor) e
histórico de `inutilizacoes_fiscais` com status, protocolo e ambiente reais. A tela **não finge
homologação**: `homologado: true` → sucesso com protocolo; `homologado: false` → alerta âmbar com o
status e a mensagem que o provedor devolveu.

**Menu.** Nasceu o grupo **Fiscal** (entre Financeiro e Relatórios): `documentos-fiscais` e
`regras-fiscais` saíram de *Vendas*, e entraram **`ncm`** e **`inutilizacoes`** (`minPerfil: 'gerente'`).
`npm run audit:menu`: **0 erros · 4 avisos** e, pela primeira vez, **0 `[RECURSO_SEM_MENU]`** — os dois
recursos que a auditoria apontou ficaram navegáveis nas telas novas. **68 módulos / 13 grupos.**

**Evidência executada:**

| Prova | Comando | Resultado |
|---|---|---|
| P1-03 — unidade/HTTP | `server/test/fiscal.test.ts` (19 → **24** testes) | **24/24** — homologado → `200` + protocolo gravado; ainda processando → `202` "sem protocolo"; provedor nulo → `202` com `status: 'erro'` (não homologou); operador → `403`; validações da SEFAZ → `400` |
| **P1-03 — mutação** | `fiscal.ts:850` revertido para `checkAccess(R_INUT(), actor, 'create')` | ❌ **3 falhas**: `405 !== 200` e `405 !== 202` — o teste do ciclo falha exatamente com o defeito original |
| P1-03 — PostgreSQL | `server/test/pg/fiscal-inutilizacao-e2e.test.ts` (**banco novo**, servidor real) | ✅ persistência com `empresa_id`, série, faixa, justificativa e **autor** (FK `criado_por` satisfeita), `ambiente: 'homologacao'`, `protocolo` nulo; histórico pela API; `403` do operador sem gravar; e o CHECK do banco recusando justificativa curta (`23514`) |
| P1-02 — tela | `client/src/pages/NcmPage.test.tsx` | **10/10** (inclui PADRÃO destacada, chave inválida e alíquota fora de 0–100) |
| P1-03 — tela | `client/src/pages/InutilizacoesPage.test.tsx` | **8/8** (inclui o caminho "ainda não homologou" com protocolo ausente) |
| Menu | `client/src/modules.test.ts` + `npm run audit:menu` | **10/10** · **0 erros / 4 avisos** (RBAC_DERIVA_SOLTA ×3 + ROTA_PUBLICA `/api/health`) · **0 `RECURSO_SEM_MENU`** |
| Bateria PostgreSQL | `npm run test:pg` em **banco novo** | **127 testes · 126 pass · 0 fail · 1 todo** (P1-11) — o novo teste e2e entra como `ok 96` |
| Smoke PostgreSQL | `npm run smoke:pg` (banco novo) | **126/126** |
| Regressão | `server test` · `client test` · `typecheck` · `lint` · `build` | **748** (685 pass · 0 fail · 63 skip) · **246/246** · **0** · **0 erros** (401 warnings, igual ao baseline) · **OK** |

**Nenhuma migration, nenhuma alteração de schema, nenhum arquivo do Commerce, nenhuma rota nova e
nenhuma porta de escrita aberta no CRUD genérico.** O `todo` da bateria continua sendo o **P1-11**
(escopo multiempresa da assinatura de webhook), aberto por decisão de arquitetura.

**CI deste ciclo:** commit [`876c46c`](https://github.com/petrickmsilva-alt/brobond-erp/commit/876c46c) — runs
[38159564986](https://github.com/petrickmsilva-alt/brobond-erp/actions/runs/38159564986) e
38159569051 **verdes** nos dois jobs (`verificar` e `testes-postgres`, que já executava o novo e2e de
inutilização na bateria PostgreSQL).

**Ressalva honesta do ciclo:** a inutilização é exercitada contra o provedor **nulo** e contra um
provedor **falso** em teste — nenhuma SEFAZ real foi chamada (é o escopo do **ERP-12**, homologação).
O que este ciclo garante é que a **operação** funciona, o pedido é **persistido com autor** e o sistema
**não afirma homologação** que não aconteceu.

---

### ERP-06 — Comissões: tela, menu e fechamento

* **Objetivo:** dar superfície operacional a um cálculo que já existe e está testado.
* **Gaps fechados:** **P1-05**.
* **Evidência:** rotas `/api/financeiro/comissoes` e `/api/financeiro/comissoes/venda/:id` existem; `grep comissoes client/src/modules.ts` → **vazio**; relatório `comissoes` existe e aparece em `RelatoriosPage`.
* **Banco:** nenhuma migration prevista.
* **Backend:** já pronto (`comissoes.ts`, 335 linhas; `comissoes_eventos`). Confirmar período/status de fechamento antes da tela.
* **Frontend:** tela de Comissões (por vendedor, por venda, comissão devida × paga, estornos) + entrada no grupo Financeiro.
* **Testes:** teste de tela; manter `financeiro-p2.test.ts` (efetivação pró-rata e não-duplicação) e o teste PG de comissão única por lançamento (`pg-p2.test.ts`).
* **Critérios de aceite:** gerente vê e fecha a comissão do período pela interface; a soma da tela bate com o relatório `comissoes`.

---

#### ✅ Execução (2026-10-11) — CLOSED (P1-05)

**O que o ciclo entregou:** a tela que faltava para um cálculo que já existia, já estava testado e
não tinha superfície nenhuma — e a **prova do critério de aceite** que este roadmap escreveu para o
P1-05 ("gerente vê e fecha a comissão do período; a soma da tela bate com o relatório `comissoes`").

**O gap era de exposição, não de cálculo.** `GET /api/financeiro/comissoes` e
`GET /api/financeiro/comissoes/venda/:id` existiam em `server/src/comissoes.ts` (livro de efetivação com
idempotência por lançamento e saldo limitado pela apuração congelada), o relatório `comissoes` existia
(`relatorios.ts`) e `financeiro-p2.test.ts` já cobria recebimento parcial, quitação e não-duplicação.
O que não existia: qualquer consumo no cliente (`grep comissoes client/src/modules.ts` → vazio) e
nenhum teste que comparasse **as duas pontas** do número.

**A tela (`client/src/pages/ComissoesPage.tsx`, `/comissoes`, grupo Financeiro, `minPerfil: gerente`).**
Período (mês atual / mês anterior / datas livres) → cards de **Apurada · Efetivada · Estornada · Saldo**,
tabela por representante com totais, e drill-down: as vendas do representante no período e, por venda, o
**livro de eventos** (`realizada`/`estornada` com base recebida, percentual, origem e usuário).
A tela **diz a regra em voz alta** — apurada ≠ devida; quem efetiva é o dinheiro que entra — e o botão
**"Conferir com o relatório"** compara, no mesmo período, a soma da tela com o total do relatório e
mostra o resultado (inclusive a divergência, se houver).

**O que a tela NÃO faz, de propósito: marcar comissão como "paga".** Esse estado **não existe** no
servidor (a comissão é efetivada pelo recebimento, não por um ato de fechamento), não há coluna, não há
rota e o ciclo não criou migration. Inventar um botão "pagar" seria criar regra de negócio sem lastro —
o "fechamento do período" entregue é a **conferência auditável**: os números que o relatório publica, o
livro de cada venda a um clique e a igualdade verificada na frente do operador.

**Evidência executada:**

| Prova | Comando | Resultado |
|---|---|---|
| **Igualdade tela × relatório (critério de aceite)** | `server/test/pg/comissoes-e2e.test.ts` (**banco novo**, servidor real) | ✅ mesma venda, mesmo período: `resumo.apurada` do endpoint da tela = `resumo.comissao` do relatório — **tolerância zero** |
| Efetivação só no recebimento | idem | ✅ faturada R$ 1.000 com 10%: apurada **100**, efetivada **0**, saldo **0** (nada recebido) |
| Baixa parcial | idem | ✅ R$ 400 recebidos ⇒ efetivada **40**, pendente **60**, evento com `base = 400` (o recebido, não o total) |
| Quitação | idem | ✅ +R$ 600 ⇒ efetivada **100** = apuração; nunca efetiva além dela |
| Estorno por cancelamento | idem | ✅ venda cancelada ⇒ efetivada **0**, estornada **100**, saldo **0**, **3 eventos** no livro (nada é apagado) |
| Tela | `client/src/pages/ComissoesPage.test.tsx` | **8/8** (inclui divergência visível e livro vazio para comissão ainda não recebida) |
| Menu | `npm run audit:menu` | **0 erros · 4 avisos** · **69 módulos / 13 grupos** |
| Bateria PostgreSQL | `npm run test:pg` em **banco novo** | **128 testes · 127 pass · 0 fail · 1 todo** (P1-11) — o novo e2e entra na bateria |
| Smoke PostgreSQL | `npm run smoke:pg` (banco novo) | **126/126** — a tela nova não altera o servidor: nenhuma regressão de fluxo |
| Regressão | `client test` · `server test` · `typecheck` · `lint` · `build` | **254/254** · **748** (685 pass · 0 fail · 63 skip) · **0** · **0 erros** (406 warnings) · **OK** |

**Nenhuma migration, nenhuma tabela nova, nenhuma regra de negócio nova, nenhum arquivo do Commerce.**
O módulo `comissoes` não tem `resource` — como `financeiro` e `relatorios`, é tela de leitura sobre rotas
próprias (`/financeiro/comissoes*`), e por isso **não** abre CRUD lateral nenhum.

---

### ERP-07 — Administração: CRUD de Empresas

* **Objetivo:** tornar multiempresa administrável por quem opera.
* **Gaps fechados:** **P1-04**; fecha a lacuna de gestão do §8 (multiempresa) mantendo intacto o isolamento.
* **Evidência:** recurso `empresas` com ops `cud` (`resources.ts:446`); `GET/POST /api/empresas/ativa` e `/api/usuarios/:id/empresas` existem; o client só consome `/empresas/ativa` (`CompanySwitcher.tsx:35,69`); `audit:menu` **não** sinalizou (ponto cego `GAP-E1-AUDIT-BLINDSPOT`).
* **Banco:** nenhuma migration prevista.
* **Backend:** conferir guardas de exclusão/desativação (uma empresa com dados não deve ser excluível) e o vínculo `usuario_empresas`.
* **Frontend:** tela de Empresas em **Administração** (hoje "Configurações"): criar, editar, ativar/desativar, vincular usuários.
* **Testes:** teste de tela; estender `multiempresa.test.ts` com o CRUD; garantir que desativar empresa não apaga histórico.
* **Critérios de aceite:** criar a empresa B pela interface, vincular um usuário e alternar a empresa ativa — sem SQL manual; nenhum dado de A acessível em B.

---

#### ✅ Execução (2026-10-11) — CLOSED (P1-04 · P0-06 descoberto e fechado)

**O que o ciclo entregou:** a tela de Empresas (o gap de exposição, **P1-04**) **e** o defeito **P0** que
ela desenterrou no caminho: **em PostgreSQL, criar usuário nunca funcionou.** `POST /api/usuarios`
respondia **409 "Outra operação alterou estes dados ao mesmo tempo."** para qualquer perfil e **nenhum
usuário era criado** — o único caminho de cadastro de usuário do sistema. O ciclo não podia declarar
"multiempresa administrável sem SQL manual" (o critério de aceite escrito acima, porque a tela de
Empresas vincula acessos de usuários existentes) sem entender por que o recurso `usuarios` era intocável
no banco real.

**P0-06 — a causa-raiz é uma linha, com efeito de borda.** `gerarConvite()` (`server/src/usuariosAdmin.ts`)
grava a auditoria do convite **dentro** da transação do cadastro (`createRecord`), mas chamava
`store.audit({...})` **sem o `tx`**: o `PgStore` abria uma **segunda conexão** para o `INSERT` em
`auditoria` enquanto a transação principal (`SERIALIZABLE`) ainda estava aberta — o PostgreSQL responde
`40001` (`serialization_failure`) na transação de cadastro e o `translatePgError`
(`server/src/pgstore.ts:116-160`, `40001`/`40P01` → 409) traduzia para a mensagem genérica de conflito.
Efeito de borda que só a leitura do banco revelou: a linha de auditoria do convite **sobrevivia ao
rollback** (era gravada fora da transação), ou seja, o log registrava um convite que nunca existiu.

**Reprodução e prova (antes ⇒ depois), em PostgreSQL real:**

| Momento | Comando | Resultado |
|---|---|---|
| **Antes do fix** | 3× `createRecord(usuarios)` em banco com o código publicado | **3× FALHOU 409** · `usuarios criados: 0` · `auditoria de convite: 7` (linhas de convite **sobrevivendo** aos rollbacks) |
| **Depois do fix** (`store.audit({...}, tx)`) | idem | `ok 8` · `ok 9` · `usuarios criados: 2` — auditoria gravada **na mesma transação** |
| **Mutação** (fix revertido) | `server/test/pg-usuario-convite.test.ts` | **not ok** — volta o `40001` traduzido em 409 "Outra operação alterou estes dados ao mesmo tempo." |
| **Mutação da alçada** (`adminOnly` removido de `empresas`) | `server/test/pg/empresas-admin-e2e.test.ts` | **not ok** — o gerente passa a receber **200** onde o teste exige **403**; restaurado, volta a **ok 1/1** |

`store.audit` sem `tx` aparece em **13 chamadas** de `usuariosAdmin.ts`; as outras 12 pertencem a rotas que
já abrem `tx` própria — a do convite era a **única** chamada dentro de uma transação alheia. O ciclo
corrigiu a chamada, não a assinatura (nenhuma regra de negócio nova, nenhuma migration).

**P1-04 — a tela (`client/src/pages/EmpresasPage.tsx`, `/empresas`, grupo Configurações, `minPerfil: 'admin'`).**
Lista com situação e principal domínio, criação, edição, ativar/desativar, exclusão — com a recusa do
servidor exibida **como veio** (409 da empresa padrão, 409 de vínculos, 409 de FK) — e o **modal de
acessos**, que concede (`POST /api/usuarios/:id/empresas`) e revoga
(`DELETE /api/usuarios/:id/empresas/:empresaId`) o vínculo de cada usuário, carregado em lotes. A empresa
**padrão** (id 1, `EMPRESA_PADRAO_ID`) aparece com desativar/excluir desabilitados **e o motivo escrito** —
e o servidor recusa de novo, porque a guarda é dele. Trocar a **empresa ativa da sessão** continua no
seletor do topo (`POST /api/empresas/ativa`), de propósito: é navegação de sessão, não administração.

**A alçada é backend, não menu.** `empresas` recebeu `adminOnly: true` (`server/src/resources.ts`) —
antes do ciclo um **gerente autenticado** alcançava `POST/PUT/DELETE /api/empresas*` por chamada direta
(a restrição existia só no menu, que sequer tinha entrada). E o seletor de empresa ativa **não** foi
fechado por acidente: é autorizado pela concessão do usuário, não pelo recurso administrativo.

**Guardas de exclusão** (em `deleteRecord`, antes de chegar à FK): (1) id 1 (`EMPRESA_PADRAO_ID`) → **409**;
(2) existir vínculo em `usuario_empresas` → **409** com a contagem; (3) existir dado de domínio na empresa
(`primeiroDominioDaEmpresa`) → **409** citando o módulo. Em memória a guarda **(3)** é a que responde; em
PostgreSQL a FK (`23503`) chega antes e o 409 é a mensagem genérica de "registro em uso" — a diferença é
visível na prova e está registrada aqui de propósito (nenhum usuário de API vê stack, vê 409).

**Evidência executada:**

| Prova | Comando | Resultado |
|---|---|---|
| Criação de usuário volta a funcionar (P0-06) | `server/test/pg-usuario-convite.test.ts` (**banco novo**, PG real) | ✅ **1/1** (com mutação: sem o `tx` o arquivo **falha** com 409) |
| Alçada + guardas de exclusão em PostgreSQL | `server/test/pg-empresas-admin.test.ts` (**banco novo**) | ✅ **1/1** — 7 blocos: `checkAccess` de admin; empresa padrão → 409; empresa com acesso → 409; empresa com produto → 409 + contagem por SQL; `remove` → **23503 → 409**; empresa vazia excluída; limpeza só do que o teste criou |
| **Alçada por HTTP (não pelo contrato)** | `server/test/pg/empresas-admin-e2e.test.ts` (servidor real, **banco novo**, gerente de verdade) | ✅ **1/1** — gerente **403** em `GET`/`POST`/`PUT`/`DELETE`; empresa padrão intacta (`count` e nome **BROBOND**); `GET /api/empresas/ativa` **200** e `POST /api/empresas/ativa` **200** com token novo; **nenhum 500** nos logs |
| Guardas de exclusão (memória) | `server/test/empresas-admin.test.ts` | ✅ **9/9** |
| Tela | `client/src/pages/EmpresasPage.test.tsx` | ✅ **8/8** |
| Menu | `npm run audit:menu` | ✅ **Sem erros** — 70 módulos · 13 grupos · 43 navegáveis · 4 avisos classificados |
| Regressão | `server test` · `client test` · `typecheck` · `lint` · `build` | **759** (694 pass · 0 fail · 65 skip) · **262/262** (26 arquivos) · **0** · **0 erros** (415 warnings) · **OK** |
| **Bateria PostgreSQL** | `npm run test:pg` em **banco novo** (`brobond_e07run2`; log completo em `/tmp/testpg-e07.log`) | ✅ **131 testes · 130 pass · 0 fail · 1 todo** (P1-11) — inclui os três arquivos novos do ciclo (o e2e de devolução do ERP-08 leva a bateria a **132**) |
| **Smoke PostgreSQL** | `npm run smoke:pg` em **banco novo** | ✅ **126/126** — a superfície nova não alterou nenhum fluxo existente |

**Nenhuma migration, nenhuma tabela nova, nenhum arquivo do Commerce.** O vínculo de acessos usa as rotas
que já existiam (`/api/usuarios/:id/empresas`), e a tela **não** inventa estado de empresa: ativa/inativa é
campo do próprio recurso.

---

### ERP-08 — Devolução ponta a ponta em PostgreSQL

* **Objetivo:** provar (e se necessário ajustar) a cadeia de reversa, hoje sem teste E2E.
* **Gaps fechados:** **P1-09**.
* **Evidência do gap:** existe `devoculcoes`/`devolucoes` com rotas (`/api/devolucoes/:id/{autorizar,recusar,receber,cancelar,rastreamento}`), tela `DevolucoesPage.tsx` com teste de componente, mas **nenhum** arquivo de teste PostgreSQL dedicado ao fluxo (`server/test/pg/` não tem devolução).
* **Banco:** conferir se o retorno de estoque passa pelo mesmo primitivo seguro de delta negativo (`tryAdjustStock`) e se a devolução parcial respeita o índice parcial por empresa/local.
* **Backend:** `server/src/expedicao.ts` (devoluções) + financeiro (lançamento de estorno) + eventual evento fiscal de devolução.
* **Frontend:** já existe; conferir os estados devolvidos pelo servidor após o fluxo real.
* **Testes:** **novo** `server/test/pg/devolucao-e2e.test.ts` — venda faturada → devolução **parcial** → autorização → recebimento → estoque volta **apenas o bom estado** → lançamento financeiro correspondente → divergência (item danificado) **não** volta ao estoque → devolução de venda de outra empresa → 404.
* **Critérios de aceite:** a devolução parcial fecha o ciclo em PostgreSQL com estoque, financeiro e auditoria coerentes, e o item danificado comprovadamente **não** retorna ao saldo.

---

#### ✅ Execução (2026-10-11) — CLOSED (P1-09)

**O que o ciclo entregou:** a **prova** que faltava — e **nenhuma linha de código de produto**. A cadeia de
reversa existia inteira (rotas, tela, testes de componente) e nunca havia sido executada contra o banco
real: `server/test/pg/` não tinha arquivo de devolução. O ciclo não encontrou defeito na cadeia; ele
escreveu o **contrato real** dela como teste que falha se alguém o quebrar (mutação abaixo).

**O fluxo provado**, em banco novo e com o servidor de verdade (`server/test/pg/devolucao-e2e.test.ts`):
venda faturada (estoque 5 → 2, com a saída canônica gravada em `movimentacoes.venda_id`) → **devolução
parcial de 2 de 3** → autorizar → rastrear → receber as 2 em **bom** (estoque 2 → **4**; a venda
**continua faturada** e a conta a receber **não** é tocada — devolução parcial **não** reverte o
financeiro, e a própria resposta diz isso: `financeiro: {aplicado: false, motivo: "Devolução parcial…"}`)
→ segunda devolução de **1 unidade**, recebida **avariada** (entradas de estoque: **nenhuma**;
`devolucao_estoque = false`; saldo inalterado) → como **3 de 3** voltaram, o recebimento **cancela a
venda e reverte o financeiro** (`financeiro.aplicado: true`; a conta a receber vira `cancelado`).

**O ponto que o teste tinha de atacar — e ataca:** o estorno da venda cancelada **não** pode ser uma
porta de volta para a peça avariada. O código faz a conta certa (`restaurar = saídas − já recebido em
devolução, qualquer estado`) e a prova é numérica: o saldo final é **4** — as 2 peças boas voltaram pela
devolução, **a avariada não voltou nem pelo estorno**. É exatamente o critério de aceite do ciclo.

**Recusas provadas por HTTP:** receber antes de autorizar (**409**); receber sem código de rastreamento
(**409** — mercadoria sem rastreabilidade não entra no estoque); receber duas vezes a mesma devolução
(**409**, e o saldo **não** sobe de novo); devolver mais do que foi vendido (**409** com a conta
`vendido × em devolução`); receber devolução recusada (**409**); e a repetição da criação com
`idempotency-key` devolve a **mesma** devolução com `idempotente: true` — conferido no banco: **1** linha.

**Multiempresa:** a empresa B recebe **404** ao ler a devolução de A, ao criar devolução para a venda de
A e ao tentar receber a devolução de A — e o estoque de A não se move com nenhuma das tentativas.

**Duas notas de engenharia (FATO, com endereço):**

1. O retorno entra por `s.adjustStock(..., +quantidade)` — **delta positivo** —, então a classe do
   **P0-01** (CHECK de não-negativo avaliado **antes** do `ON CONFLICT` com delta negativo) **não**
   alcança este caminho. É o índice único parcial por empresa/local que faz o upsert encontrar a linha
   certa; a evidência são os saldos exatos em cada passo (5 → 2 → 4 → 4).
2. `devolucoes.documento_fiscal_id` **nunca é escrito** pelo fluxo de devolução: **não existe documento
   nem evento fiscal de devolução** hoje. Não é defeito deste ciclo — emissão fiscal é **ERP-12** — mas é
   limitação **declarada**: quem devolve mercadoria **não** emite nota de devolução.

**Evidência executada:**

| Prova | Comando | Resultado |
|---|---|---|
| Cadeia completa (faturar → parcial → avariado → total → financeiro → auditoria) | `server/test/pg/devolucao-e2e.test.ts` (**banco novo**, servidor real) | ✅ **1/1** |
| **Mutação** — guarda do estado removida (`if (estado !== 'bom') continue;`) | idem | ✅ **not ok**: a entrada do item avariado passa a existir — `esperado 0, veio 1` ⇒ o teste guarda a regra |
| Bateria PostgreSQL (banco novo) | `npm run test:pg` (base `brobond_e07run3`; log em `/tmp/testpg-e08.log`) | ✅ **132 testes · 131 pass · 0 fail · 1 todo** (P1-11) — um a mais que o ciclo anterior: o e2e de devolução entrou na bateria |
| Smoke PostgreSQL (banco novo) | `npm run smoke:pg` (base `brobond_e08smoke`) | ✅ **126/126** |
| Regressão | `server test` · `client test` · `typecheck` · `lint` · `build` · `audit:menu` | **759** (694 pass · 0 fail · 65 skip) · **262/262** (26 arquivos) · **0** · **0 erros** (415 warnings) · **OK** · **Sem erros** (70 módulos / 13 grupos) |

**Nenhuma migration, nenhuma tabela nova, nenhum arquivo do Commerce, nenhuma linha de produto alterada** —
a única mudança do ciclo é o arquivo de teste e este registro.

---

### ERP-09 — Reserva e disponibilidade de estoque

* **Objetivo:** separar **saldo disponível** de **saldo comprometido** — pré-requisito operacional para vender sem oversell em mais de um canal.
* **Gaps fechados:** **P1-06**.
* **Evidência:** `grep reserva server/src/estoque.ts` → 0; `politicas_comerciais` tem parâmetros de reserva declarados, sem entidade que os aplique.
* **Banco:** migration nova — entidade de reserva (venda/item, quantidade, validade, status), com **`empresa_id`**, FK composta por empresa, índice único parcial no padrão dos 4 já existentes em `estoques`, e CHECK de não negativo.
* **Backend:** criar/consumir/liberar reserva; expor `disponivel = saldo − reservado` na grade de estoque e na sugestão de compra; usar o primitivo com guarda **dentro da escrita** para as liberações.
* **Frontend:** coluna/indicador de disponível × comprometido na Estoque Física; reserva visível no detalhe da venda.
* **Testes:** PostgreSQL com **concorrência** (duas vendas disputando a última peça → exatamente uma vence, mesma disciplina do teste de expedição do E4.2.3) + multiempresa + expiração de reserva.
* **Critérios de aceite:** nenhum cenário permite vender mais que o disponível; reserva expirada libera o saldo; o saldo físico continua sendo o único que a movimentação altera.

---

### ERP-10 — RBAC sem deriva e auditoria de menu ampliada

* **Objetivo:** menu, API e servidor contam a mesma história; o auditor de menu enxerga o que falhou.
* **Gaps fechados:** **P1-01**, **P2-05**.
* **Evidência:** `audit:menu` → 3 × `[RBAC_DERIVA_SOLTA]` (`politicas_comerciais`, `listas_preco`, `envios`) e nenhum aviso para `empresas` (que tem CRUD sem menu) — o ponto cego é comprovado pelos dois lados.
* **Banco:** nenhum.
* **Backend:** aplicar a restrição de perfil no servidor nos 3 recursos (ou documentar e codificar a exceção, como já ocorre com `catalogos`/`politicas_comerciais` em `services.ts:149`).
* **Frontend:** nenhum.
* **Testes:** estender `scripts/auditar-menu.ts` para detectar **recurso com CRUD sem módulo** por **tabela** (não apenas por nome de recurso) — é o que faria `empresas` aparecer; teste de autorização por perfil para cada recurso restrito.
* **Critérios de aceite:** `npm run audit:menu` → **0** `RBAC_DERIVA_SOLTA` e **0** recursos com CRUD invisível; teste HTTP que falha com 403 quando o perfil é insuficiente para os 3 recursos.

---

### ERP-11 — Cadastros faltantes e cobertura de relatórios

* **Objetivo:** fechar pendências de cadastro conhecidas desde o E1 e levar ao front os relatórios que só existem na API.
* **Gaps fechados:** **P2-01** (Marcas), **P2-02** (Unidades), **P2-04** (relatórios).
* **Evidência:** `produtos.marca` é coluna `TEXT` (`schema.sql:1740`, `resources.ts:935`) sem tabela; `UNIDADES` é lista fixa (`resources.ts:176`); 11 relatórios existem no backend (`relatorios.ts`) e o `RelatoriosPage` cobre um subconjunto.
* **Banco:** migration nova — `marcas` e `unidades` com `empresa_id`; migração de `produtos.marca` (texto livre) para FK **sem perder o valor atual** (mesma disciplina de backfill da `0026`: nunca inventar vínculo).
* **Backend:** recursos + campos `ref` correspondentes; expor `GET /api/relatorios` com o catálogo, para o front não manter lista paralela.
* **Frontend:** cadastros de Marcas e Unidades em Cadastros; seletor de relatório alimentado pela API.
* **Testes:** teste de migração de dados (texto órfão permanece visível), testes de tela, teste que garante que **todos** os relatórios do backend aparecem na tela.
* **Critérios de aceite:** marca é entidade com filtro; unidade é cadastro; os 11 relatórios acessíveis pela interface.

---

### ERP-12 — Homologação fiscal real

* **Objetivo:** transformar arquitetura fiscal em **documento autorizado**.
* **Gaps fechados:** **P1-08**.
* **Dependências:** ERP-05 (tributação operável) e ERP-03 (gate). Requer credencial/certificado **externos** — a única dependência fora do repositório no roadmap do CORE.
* **Evidência do estado atual:** `fiscalProvider.ts` com `focus` (linha 261) e `plugnotas` (453) e ambiente `homologacao|producao` (241); `nfe.ts` com `NFE_MODO=simulacao` gravando `nfe_status='simulada'` **sem valor fiscal** (linhas 131/165/181).
* **Banco:** conferir armazenamento do XML autorizado e dos eventos (a estrutura existe: `documentos_fiscais`, `documentos_fiscais_eventos`).
* **Backend:** emissão real, consulta de status, cancelamento, inutilização, armazenamento e recuperação do XML; separar explicitamente **simulação** de **autorizado** (hoje o modo simulação é honesto — o risco é ler "emitida" sem saber que é simulação).
* **Frontend:** status fiscal visível na venda e no documento, com carimbo **homologado × simulado**.
* **Testes:** emissão em **homologação** de provedor real (teste marcado, executado com credencial), cancelamento, inutilização, reprocessamento idempotente de evento fiscal, XML recuperável. Contrato do adapter continua coberto pelos testes existentes.
* **Critérios de aceite:** XML **autorizado** pela SEFAZ em ambiente de homologação arquivado e recuperável pela interface, com cancelamento e inutilização executados; **nenhum** status "emitida" descrevendo simulação.

---

### ERP-13 — Auditoria independente e gate de fechamento do CORE

* **Objetivo:** declarar 🟢 **ERP CORE COMPLETO** com evidência nova, produzida por auditoria independente, sobre o commit final.
* **Gaps fechados:** nenhum novo — é o **gate**.
* **Dependências:** ERP-01 … ERP-12.
* **Escopo da auditoria final:**
  * reexecutar **todas** as cadeias do §1 em PostgreSQL real, do zero (banco vazio → migrations → operação);
  * teste A→B→A de isolamento multiempresa nos 12 domínios (fecha R6);
  * varredura de deriva RBAC e de recurso sem tela (`audit:menu` sem avisos);
  * igualdade numérica BI = relatório = DRE;
  * revisão de que **nada de Commerce foi tocado** (diff por domínio);
  * enumeração dos gaps P2/P3 aceitos conscientemente como **ADVANCED/FUTURO**.
* **Critérios de aceite:**
  1. Nenhum P0 ou P1 aberto.
  2. 9/9 cadeias com prova executada em PostgreSQL.
  3. `typecheck`, `lint`, `build`, `test:pg`, `smoke` (memória **e** PostgreSQL), `audit:menu` — todos verdes no mesmo commit.
  4. Relatório de auditoria independente publicado, com contagem de gaps igual a zero para P0/P1.

---

## 6. O que fica congelado (fora deste roadmap)

| Frente | Itens | Regra |
|---|---|---|
| **Commerce** | WooCommerce (`server/src/loja.ts`), mercado livre, Nuvemshop, Instagram Shopping, marketplaces (`marketplace.ts`), motor de conectores (`modules/connectors`, 6.600 LOC), catálogo externo, publicação, sincronização, Commerce Inbox, ingestão de pedidos (`connectors.ts`, `webhooks.ts`) | **Não corrigir, não evoluir, não iniciar (E8)** |
| **Ecossistema Creators** | Creators, Matches, Outreach AI, Campanhas (4 módulos `planned`) | Não implementar |
| **Integrações externas** | Gateways de pagamento em produção, transportadoras, OAuth de terceiros, SEFAZ por terceiro, Cloudinary/SMTP/Sentry | Só quando um item do CORE **depender** |
| **Interface** | Menu atual | **Nenhuma alteração por este roadmap** |

**Exceção declarada — uma única:** o **bug P0-02** vive em `server/src/gateway.ts` (ERP) e a tabela `gateway_webhook_events` é compartilhada com cobranças de Commerce. Ele **é** do ERP e é fechado integralmente em **ERP-01**, sem tocar em nenhum conector.

**Exceção declarada 2 — regressão protegida:** a tabela `sales` (origem dos dados de Commerce) **não pode quebrar**. ERP-04 tem critério de aceite explícito de não-regressão da ingestão externa, mesmo com a frente congelada.

---

## 7. Estrutura de menu proposta (referência)

Detalhada em `docs/RELATORIO-ERP-ONLY.md` §17. Resumo:

```
MENU ATUAL (66 módulos, 12 grupos)
   ↓
FUNCIONALIDADES EXISTENTES não expostas: NCM · Inutilização fiscal · Empresas (CRUD) · Comissões
   ↓
FUNCIONALIDADES QUE FALTAM: Reserva de estoque · Marcas · Unidades · (BI e Fiscal já existem, precisam funcionar)
   ↓
MENU ERP FINAL PROPOSTO (ERP-11 ainda implementa entradas; **grupo Fiscal** ✅ ERP-05, **Comissões** ✅ ERP-06 e
   **Empresas** ✅ ERP-07 já estão no menu real)
   Meu Negócio · Cadastros · Vendas · Compras · Estoque · Produção ·
   Logística & Expedição · Financeiro · FISCAL(novo) · Relatórios · ADMINISTRAÇÃO(renomeado)
   ── CONGELADO: Integrações · Gestão de Commerce · Ecossistema Creators ──
```

**Alterações de menu só acontecem dentro dos ciclos que criam a tela correspondente** — nunca "arrumar o menu" antes de a funcionalidade existir.

---

## 8. Matriz gap × ciclo (rastreabilidade)

| Gap | Severidade | Ciclo |
|---|---|---|
| P0-01 estorno/reabrir OP → 500 em PostgreSQL | 🔴 P0 | **ERP-02 ✅** |
| P0-02 webhook de pagamento descartado + vazamento de constraint | 🔴 P0 | **ERP-01 ✅** |
| P0-03 BI lê `sales`, não `vendas` do ERP | 🔴 P0 | **ERP-04 ✅ (ADR-001, opção B)** |
| P0-04 E2E não roda em PostgreSQL; instalação nova sem local padrão | 🔴 P0 | **ERP-03 ✅** |
| P0-05 índice único GLOBAL legado de `codigo_barras` derruba o boot | 🔴 P0 | **descoberto e fechado em ERP-03 ✅** |
| P1-01 deriva RBAC (3 recursos) | 🟠 P1 | ERP-10 |
| P1-02 NCM sem tela | 🟠 P1 | **ERP-05 ✅** |
| P1-03 inutilização sem tela **+ rota devolvendo 405** | 🟠 P1 | **ERP-05 ✅** |
| P1-04 CRUD de Empresas sem tela | 🟠 P1 | **ERP-07 ✅** (alçada `adminOnly` provada por HTTP + guardas de exclusão em PG) |
| P1-05 comissões sem tela/menu (e filtro de período quebrado: `comissoes.ts:261`) | 🟠 P1 | **ERP-06 ✅** (o filtro caiu no P1-13) |
| **P0-06** criar usuário respondia **sempre 409** em PostgreSQL (`store.audit` sem `tx` em `gerarConvite` ⇒ `40001` na transação de cadastro; auditoria do convite sobrevivia ao rollback) | 🔴 P0 | **descoberto e fechado em ERP-07 ✅** (prova antes/depois + mutação) |
| P1-06 reserva de estoque ausente | 🟠 P1 | ERP-09 |
| P1-07 fonte única do faturamento | 🟠 P1 | **ERP-04 ✅ (BI = relatório = DRE no mesmo período)** |
| P1-08 fiscal sem homologação | 🟠 P1 | ERP-12 |
| P1-09 devolução sem E2E PostgreSQL | 🟠 P1 | **ERP-08 ✅** (parcial/avariado/total, idempotência, multiempresa 404; mutação da guarda de estado) |
| P1-10 `OP cancelada é terminal` responde 500 (cascata de P0-01) | 🟠 P1 | **ERP-02 ✅ (fechado como cascata)** |
| P1-11 assinatura de webhook global por provedor (sem empresa) | 🟠 P1 | **registrado no ERP-01; correção aguarda decisão de escopo multiempresa** |
| P2-01 Marcas | 🟡 P2 | ERP-11 |
| P2-02 Unidades | 🟡 P2 | ERP-11 |
| P2-03 `MemStore` sem isolamento | 🟡 P2 | **declarado em ERP-03 ✅** (cabeçalho de `scripts/smoke-pg.mjs` + §5 ERP-03: memória é demonstração, não produção) |
| P2-04 relatórios no front | 🟡 P2 | ERP-11 |
| P2-05 ponto cego do `audit:menu` | 🟡 P2 | ERP-10 |
| P2-06 concorrência só no `PgStore` | 🟡 P2 | **declarado em ERP-03 ✅** (mesma nota; a suíte de concorrência continua exclusiva do PostgreSQL) |
| P2-07 `/api/health` responde `db=postgres` antes das migrações | 🟡 P2 | **descoberto no ERP-03**; registrado no relatório (liveness × readiness) |
| P1-13 filtro de período por `String(Date).slice(0,10)` (relatórios, comissões e mais 13 módulos) | 🟠 P1 | **fechado em 2026-10-11** (ciclo P1-13 + P2-08: `utils.diaISO` único; prova PG + mutação) |
| P2-08 projeção do ERP com ZERO usuários ativos → `23503`/`400` enganoso (AUD-01) | 🟡 P2 | **fechado em 2026-10-11** (ciclo P1-13 + P2-08: `EXISTS` no passo dos itens; prova PG + mutação) |
| P2-09 `test:pg` não repetível em banco reaproveitado (AUD-03) | 🟡 P2 | **descoberto na auditoria independente (2026-10-11)**; exige banco novo como a bateria de referência |
| P3-01 … P3-06 | 🔵 P3 | **FUTURO** — fora dos ciclos do CORE |

---

## 9. Definição de pronto de qualquer ciclo (Definition of Done)

Um ciclo só é declarado fechado quando **todos** os itens abaixo são verdadeiros no mesmo commit:

1. **Banco:** migration nova (nunca edição de migration existente), aplicada em **banco vazio** e em banco populado.
2. **Backend:** tipo/contrato alinhados a `db/schema.sql` (verificado pelo teste de contrato de tipo de ERP-03).
3. **Frontend:** tela ou entrada de menu quando o gap for de interface — **e só nesse caso**.
4. **Testes:** pelo menos um teste que **falha antes e passa depois** da correção, executado em **PostgreSQL real** (modo demonstração não conta como prova).
5. **Multiempresa:** teste A/B para qualquer entidade nova ou alterada.
6. **Concorrência:** quando o ciclo tocar saldo, caixa, numeração ou idempotência.
7. **CI:** `typecheck` + `lint` + `build` + `server test` + `client test` + `test:pg` + `smoke` verdes.
8. **Rastreabilidade:** o gap correspondente sai de `docs/ERP-GAPS.md` **somente** com a evidência executada anexada.
9. **Registro:** o que foi decidido (ADR) quando o ciclo exigir decisão de arquitetura (ERP-04, ERP-09).
10. **Congelamento respeitado:** nenhum arquivo de Commerce alterado; regressão de ingestão externa verificada quando houver contato.

---

## 10. Veredito deste roadmap

O BROBOND ERP está **mais perto do fim do que o volume de pendências sugere**: duas cadeias já estão fechadas com prova em PostgreSQL (Compra e Expedição) e três das quatro correções P0 têm **causa-raiz isolada em uma linha de código**. O que separa o ERP de "operacionalmente completo" não é quantidade de funcionalidade — é:

* **duas funcionalidades quebradas que o CI apresenta como saudáveis** (ERP-01 e ERP-02);
* **um gate de verificação que não verifica o ambiente de produção** (ERP-03);
* **um painel desconectado da operação** (ERP-04).

# 🟢 ERP ROADMAP DEFINIDO

**Ressalva original (retirada em 2026-10-11):** a implementação **não deveria começar** antes de os 4 gaps P0 serem reconhecidos como bloqueadores (dois deles são defeitos de produção provados, não funcionalidade ausente) e antes de **ERP-03** garantir que nenhum ciclo feche sem prova em PostgreSQL real. As duas condições foram cumpridas (**ERP-01, ERP-02 e ERP-03**) e o roadmap passou a 🟢; **ERP-04** (o painel desconectado da operação) fechou em seguida e a **auditoria independente** dos quatro ciclos foi executada sobre `bb17f19` — **GATE APROVADO COM RESSALVAS (P2)**, registradas como **P2-08** e **P2-09** (nenhuma P0/P1 aberta).

**Progresso em 2026-10-11:** **ERP-01, ERP-02, ERP-03 e ERP-04 fechados** — o BI passou a refletir a operação do ERP (ADR-001, projeção `vendas → sales`), com `BI == relatório` no mesmo período e o filtro de período de `relatorios.ts` corrigido (8 pontos) como efeito colateral do próprio critério de igualdade. A **auditoria independente** dos quatro ciclos (6 provas por mutação, bateria em banco novo, CI verde) foi executada sobre `bb17f19` com veredito **✅ GATE APROVADO COM RESSALVAS (P2)** — P0-02 (webhook de pagamento) e P0-01 (estorno/reabertura de OP) corrigidos, cada um com prova *falha antes → passa depois* em PostgreSQL real, sem tocar em Commerce e sem migration. O termômetro da auditoria (**smoke contra PostgreSQL real**) saiu de **119/126** para **126/126**. **ERP-03 fechou o P0-04** (gate executável em PostgreSQL: `npm run smoke:pg` cria banco novo, sobe a API e roda o smoke — 126/126 sem nenhum SQL manual —, agora no job `testes-postgres` do CI) **e descobriu/fechou o P0-05** (o índice único global legado de `codigo_barras` derrubava o boot em banco com o mesmo código de barras em duas empresas). Com os quatro P0 fechados **e a auditoria independente executada**, a ressalva está retirada: o veredito é 🟢 — e a decisão de **merge** é do dono do repositório (a auditoria não mergeia). No caminho, a implementação do ERP-01 **descobriu e registrou** o P1-11 (escopo multiempresa da assinatura de webhook), que **não** foi corrigido por exigir decisão de arquitetura — coerente com a regra de o ciclo não decidir sozinho o que é de outro ciclo.

**Ressalvas depois da auditoria (ciclo de 2026-10-11):** das duas ressalvas de código, **P2-08 ficou fechada** — o passo dos itens passou a repetir a condição de responsável (`EXISTS` na venda pai), com prova `server/test/pg/projecao-sem-usuario.test.ts` e mutação (`23503` antes, `{vendas:0, itens:0}` depois) — e **P1-13** (o mesmo `String(Date).slice(0,10)` de `comissoes.ts:261`) foi fechado por varredura, com `utils.diaISO` como normalização única em **17 módulos** (18 arquivos com `utils.ts`) e mutação provando que o teste de comissões falha com o código antigo. **P2-09 segue aberto** — `test:pg` não é repetível em banco reaproveitado; é regra de processo da bateria (banco novo como referência, como o CI já faz), não defeito de produto. Recomendações na [auditoria independente](AUDITORIA-INDEPENDENTE-ERP-01-04.md) §6 e §10.

**Progresso (2026-10-11, ciclos ERP-05 → ERP-07):** **ERP-05** tornou o Fiscal operável (telas de NCM e de
Inutilizações, grupo Fiscal novo) e **corrigiu uma rota que nunca funcionou** — `POST /api/fiscal/inutilizar`
respondia **405 para todo perfil** porque a alçada de fluxo era checada como op de CRUD (`ops.create = false`);
**ERP-06** deu tela, menu e conferência às Comissões (a soma da tela **bate com o relatório**, tolerância zero,
provado em `pg/comissoes-e2e.test.ts`); **ERP-07** entregou a administração de Empresas com **alçada provada por
HTTP** (gerente ⇒ **403**) e, no caminho, descobriu e fechou o **P0-06**: **em PostgreSQL, criar usuário
respondia sempre 409 e nenhum usuário era criado** (`store.audit` sem `tx` em `gerarConvite` abria uma segunda
conexão dentro da transação `SERIALIZABLE` ⇒ `40001`), com a linha de auditoria do convite **sobrevivendo ao
rollback** — corrigido com prova antes/depois e **mutação**. Nenhum dos três ciclos tocou o Commerce, nenhum
criou migration, e as ressalvas abertas continuam as mesmas: **P2-09** (processo da bateria) e **P1-11**
(escopo multiempresa da assinatura de webhook, aguardando decisão).

**ERP-08 (2026-10-11)** fechou o último fluxo do §13 que não tinha prova em PostgreSQL: a **cadeia de reversa**
passou a ter `pg/devolucao-e2e.test.ts` — devolução parcial devolve **só o bom estado**, a peça **avariada não
volta ao saldo nem pelo estorno do cancelamento** (saldo final 4, conferido), o pedido **totalmente** devolvido
cancela a venda e reverte o financeiro, a repetição com `idempotency-key` devolve a mesma devolução e a empresa
B não alcança nada de A (**404**). Nenhuma linha de produto mudou: o ciclo é prova, com **mutação** da guarda de
estado provando que o teste falha se a regra cair.

**Nada foi implementado, corrigido, migrado, agendado ou mergeado. O menu não foi alterado. O Commerce não foi tocado.**
*(Atualização: a partir do ERP-01 a implementação passou a ser executada nos ciclos, um a um; o parágrafo acima é registro de execução.*
*A frase do merge continua valendo: nenhum ciclo mergeia — a decisão é do dono do repositório.)*
