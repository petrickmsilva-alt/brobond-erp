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
| **ERP-03** | ⏳ não iniciado | — |
| **ERP-04 … ERP-13** | ⏳ não iniciados | — |

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
| 1 | Cadastro → Estoque → Venda → Financeiro → **BI** | 🔴 defeito (BI desconectado) | ERP-04 |
| 2 | Compra → Estoque → Custo → AP → Financeiro | 🟢 **pronta** | — |
| 3 | Produção → Estoque → Custo (com reabertura/estorno) | 🔴 defeito (500 no reabrir) | ERP-02 |
| 4 | Venda → Expedição → Estoque | 🟢 **pronta** | — |
| 5 | Venda → Devolução → Estoque → Financeiro | 🟠 sem prova PG | ERP-08 |
| 6 | Pagamento → Recebimento → Conciliação | 🔴 defeito (webhook) | ERP-01 |
| 7 | Venda → Fiscal (documento emitido) | 🟠 arquitetura sem homologação | ERP-05 → ERP-12 |
| 8 | Multiempresa (A/B sem vazamento, 12 domínios) | 🟡 forte, com lacuna de gestão | ERP-07 (+ teste em ERP-03) |
| 9 | RBAC sem dependência do front | 🟡 3 derivações | ERP-10 |

**Placar: 2 de 9 fechadas · 3 com defeito · 4 parcialmente provadas.**

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

---

### ERP-05 — Fiscal operacional (sem homologação)

* **Objetivo:** tornar o módulo Fiscal utilizável por quem opera: ver, configurar e corrigir a tributação sem chamar API.
* **Gaps fechados:** **P1-02** (NCM sem tela), **P1-03** (inutilização sem tela).
* **Dependências:** nenhuma dura. Precede ERP-12 (homologação) porque homologar sem conseguir manter a tributação é operação insustentável.
* **Evidência do gap:** `audit:menu` → `[RECURSO_SEM_MENU] impostos_ncm` e `[RECURSO_SEM_MENU] inutilizacoes_fiscais`; `resources.ts:483` e `1217` com ops `cud`; nenhum consumo no client.
* **Banco:** nenhuma migration prevista (tabelas existem).
* **Backend:** nenhuma rota nova esperada; conferir se `inutilizacoes_fiscais` tem todos os campos exigidos pela SEFAZ (faixa, série, justificativa, protocolo, status) antes de expor.
* **Frontend:** telas/entradas de menu para **NCM/Tributação** (lista, cadastro, vigência) e **Inutilizações** (solicitar, consultar, ver protocolo). Grupo **Fiscal** proposto no menu final (relatório irmão, §17.4).
* **Testes:** `client/src/pages` — teste de tela para cada uma; manter `fiscal.test.ts` e `pg-fiscal.test.ts`. Teste PG para inutilização persistida com faixa/justificativa.
* **Critérios de aceite:** operador consegue cadastrar alíquota por NCM e inutilizar uma faixa de numeração **sem** API manual; `audit:menu` passa a reportar **0** `RECURSO_SEM_MENU`.

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
MENU ERP FINAL PROPOSTO (ERP-05, ERP-06, ERP-07 e ERP-11 implementam as entradas)
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
| P0-03 BI lê `sales`, não `vendas` do ERP | 🔴 P0 | ERP-04 |
| P0-04 E2E não roda em PostgreSQL; instalação nova sem local padrão | 🔴 P0 | ERP-03 |
| P1-01 deriva RBAC (3 recursos) | 🟠 P1 | ERP-10 |
| P1-02 NCM sem tela | 🟠 P1 | ERP-05 |
| P1-03 inutilização sem tela | 🟠 P1 | ERP-05 |
| P1-04 CRUD de Empresas sem tela | 🟠 P1 | ERP-07 |
| P1-05 comissões sem tela/menu | 🟠 P1 | ERP-06 |
| P1-06 reserva de estoque ausente | 🟠 P1 | ERP-09 |
| P1-07 fonte única do faturamento | 🟠 P1 | ERP-04 |
| P1-08 fiscal sem homologação | 🟠 P1 | ERP-12 |
| P1-09 devolução sem E2E PostgreSQL | 🟠 P1 | ERP-08 |
| P1-10 `OP cancelada é terminal` responde 500 (cascata de P0-01) | 🟠 P1 | **ERP-02 ✅ (fechado como cascata)** |
| P1-11 assinatura de webhook global por provedor (sem empresa) | 🟠 P1 | **registrado no ERP-01; correção aguarda decisão de escopo multiempresa** |
| P2-01 Marcas | 🟡 P2 | ERP-11 |
| P2-02 Unidades | 🟡 P2 | ERP-11 |
| P2-03 `MemStore` sem isolamento | 🟡 P2 | declarado em ERP-03 (documentação de operação) |
| P2-04 relatórios no front | 🟡 P2 | ERP-11 |
| P2-05 ponto cego do `audit:menu` | 🟡 P2 | ERP-10 |
| P2-06 concorrência só no `PgStore` | 🟡 P2 | declarado em ERP-03 |
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

# 🟡 ERP ROADMAP DEFINIDO COM RESSALVAS

**Ressalva:** a implementação **não deve começar** antes de os 4 gaps P0 serem reconhecidos como bloqueadores (dois deles são defeitos de produção provados, não funcionalidade ausente) e antes de **ERP-03** garantir que nenhum ciclo feche sem prova em PostgreSQL real. Fechadas essas duas condições — que correspondem exatamente a **ERP-01, ERP-02 e ERP-03** — o roadmap passa a 🟢.

**Progresso em 2026-10-11:** **ERP-01 e ERP-02 fechados** — P0-02 (webhook de pagamento) e P0-01 (estorno/reabertura de OP) corrigidos, cada um com prova *falha antes → passa depois* em PostgreSQL real, sem tocar em Commerce e sem migration. O termômetro da auditoria (**smoke contra PostgreSQL real**) saiu de **119/126** para **126/126**. Resta **ERP-03** (P0-04: tornar o gate executável em PostgreSQL — onboarding/seed de empresa nova e smoke parametrizado) para retirar a ressalva. No caminho, a implementação do ERP-01 **descobriu e registrou** o P1-11 (escopo multiempresa da assinatura de webhook), que **não** foi corrigido por exigir decisão de arquitetura — coerente com a regra de o ciclo não decidir sozinho o que é de outro ciclo.

**Nada foi implementado, corrigido, migrado, agendado ou mergeado. O menu não foi alterado. O Commerce não foi tocado.**
