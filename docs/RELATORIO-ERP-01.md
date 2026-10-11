# RELATÓRIO — ERP-01 (P0-02: confirmação de pagamento volta a funcionar em PostgreSQL)

**Repositório:** `petrickmsilva-alt/brobond-erp`
**Branch:** `arena/eb6990d1-brobond-erp` (a partir de `8a578d4` da `main`)
**Data:** 2026-10-11
**Escopo:** exclusivamente o ERP. Nada de `brobond-ai-commerce`.

> **O que este documento é.** O ciclo ERP-01 foi implementado e mergeado na `main`
> (PR #49; base desta rodada: `8a578d4`). Esta rodada **não reimplementou** o ciclo: ela (a) **provou
> o defeito e a correção neste ambiente**, contra **PostgreSQL 16.14 real**, por
> reconstrução do código pré-correção (o pacote tem um commit único — não existe
> revisão pré-correção para `checkout`); (b) **fechou os cenários de aceite que
> faltavam** no arquivo de prova (`provider_ref` inexistente, payload inválido e
> isolamento por empresa — §15/§17 da especificação); e (c) produziu **este
> relatório**, que não existia. Nenhuma linha de produção foi alterada nesta
> rodada — a única alteração de código é o arquivo de teste.

---

## 1. STATUS FINAL

| Item | Situação |
|---|---|
| Cobrança `pendente` → `paga` por webhook em PostgreSQL real | ✅ provado (antes/depois) |
| Webhook repetido → `200 {duplicado:true}`, uma única baixa | ✅ provado |
| Vazamento de constraint em endpoint público | ✅ provado (antes/depois) por mutação |
| `provider_ref` inexistente, payload inválido | ✅ cenários novos, verdes |
| Isolamento por empresa preservado | ✅ cenário novo, verde |
| Concorrência (duas entregas simultâneas) | ✅ uma baixa, um evento, ambos `200` |
| MemStore (regressão) | ✅ verde |
| Migration | ✅ **não necessária** (schema já é JSONB) |
| Frontend / Commerce / ERP-02 / ERP-03 | ✅ intocados |

## 2. ESTADO INICIAL — o que já estava na `main`

O ERP-01 fechou o **P0-02** em ciclo anterior (evidência em
[`docs/ERP-CORE-ROADMAP.md`](ERP-CORE-ROADMAP.md) §5 e
[`docs/ERP-GAPS.md`](ERP-GAPS.md)). Ao iniciar esta rodada, a árvore `8a578d4`
já continha:

* `server/src/gateway.ts` — `lerPayloadWebhook()` (leitura tolerante ao tipo),
  `payloadParaArmazenar()` (escrita como objeto JSONB), reaproveitamento da linha
  `'ignorado'` no retry, `23505` → `200 {duplicado:true}`, respostas anônimas sem
  mensagem de driver;
* `server/test/pg/e01-gateway-webhook-postgresql.test.ts` — prova em PostgreSQL
  real (cenários A–E);
* `server/test/pg/contrato-tipo-coluna.test.ts` — a guarda estrutural que teria
  pego o P0-02 (declarado `textarea` sobre coluna `jsonb`).

**O que faltava e foi entregue nesta rodada:**

1. `docs/RELATORIO-ERP-01.md` (este arquivo) — não existia;
2. cenários de aceite obrigatórios da especificação ainda **não fixados em
   teste**: `provider_ref` inexistente (teste 3), payload inválido (teste 6) e
   isolamento por empresa (§17);
3. **reprodução do defeito neste ambiente**, contra PostgreSQL real.

## 3. REPRODUÇÃO — ANTES (PostgreSQL real, neste ambiente)

Sem PostgreSQL instalado no sandbox, o ciclo usou **PostgreSQL 16.14 real**
(binários `@embedded-postgres/linux-x64`, cluster em `/tmp/pgdata`, porta 55432),
na mesma configuração do job `testes-postgres` do CI (`postgres:16`, usuário
`brobond`, base `brobond_teste`).

Para produzir o "antes" sem inventar código, as três linhas originais citadas na
auditoria ([`docs/RELATORIO-ERP-ONLY.md`](RELATORIO-ERP-ONLY.md) §P0-02 — leitura
linha 949, duplicidade 862–864, `catch` externo 928) foram **reconstruídas** por
mutação em `/tmp/evidence/mutacao.mjs`, sempre a partir de
`git show HEAD:server/src/gateway.ts` (nunca do estado do disco).

### 3.1 Mutação `leitura` — `JSON.parse(String(evento.payload || '{}'))`

```
npm... node --import tsx --test test/pg/e01-gateway-webhook-postgresql.test.ts
not ok 1 - ERP-01: webhook de pagamento processa em PostgreSQL, é idempotente e não vaza schema
  error: evento de pagamento precisa ser processado:
         {"ok":true,"evento_id":"evt-pago-e01mv4ai1wnaq16-5","resultado":"ignorado","processado":false}
# tests 3 · # pass 1 · # fail 1 · # todo 1        (exit 1)
```

E no banco, exatamente o estado relatado pela auditoria:

```
gateway_webhook_events.id=13  status='ignorado'
  erro='Nenhuma cobrança deste provedor com essa referência.'
  cobranca_id=NULL  empresa_id=NULL
gateway_cobrancas.id=13  provider='mock'  provider_ref='mock-e01-e01mv4ai1wnaq16-4'  status='pendente'
```

### 3.2 Mutação `duplicidade` — inserir 2ª linha no retry + `catch` externo cru

```
# B: retry legítimo: resposta anônima vazou detalhe de banco →
#   {"ok":false,"erro":"duplicate key value violates unique constraint \"uq_gateway_webhook_evento\""}
# tests 3 · # pass 1 · # fail 1 · # todo 1        (exit 1)
```

É o `wh2 → 202` com **nome de constraint** em endpoint anônimo, como na auditoria.

### 3.3 Código corrigido (o que está na `main`)

```
ok 1 - ERP-01: webhook de pagamento processa em PostgreSQL, é idempotente e não vaza schema
ok 2 - ERP-01: o payload JSONB é lido nos dois formatos (objeto e string)
# tests 3 · # pass 2 · # fail 0 · # todo 1        (exit 0)
```

## 4. CAUSA-RAIZ

1. **Leitura**: `gateway_webhook_events.payload` é **JSONB**
   (`db/schema.sql:2985`); o driver `pg` entrega **objeto**. O código lia com
   `JSON.parse(String(payload))` ⇒ `String(objeto)` = `"[object Object]"` ⇒
   `JSON.parse` lança ⇒ payload `{}` ⇒ `provider_ref` nulo ⇒ evento
   `'ignorado'` e cobrança presa em `'pendente'` — em **toda** notificação.
2. **Duplicidade**: como o primeiro evento ficava `'ignorado'` (e a dedup ignora
   `'ignorado'` de propósito, para não envenenar retry de assinatura rejeitada),
   a repetição **inseria** segunda linha, batia no índice único
   `uq_gateway_webhook_evento` (`(LOWER(provider), evento_id)` global) e o
   `catch` externo devolvia **202 com a mensagem crua do driver**.
3. **Contrato**: o recurso declarava `payload` como `textarea` enquanto a coluna
   real é `jsonb` — a divergência declarado×banco que originou a classe do
   defeito.

## 5. ARQUIVOS ALTERADOS

**Nesta rodada (verificação + cenários que faltavam):**

| Arquivo | Alteração |
|---|---|
| `server/test/pg/e01-gateway-webhook-postgresql.test.ts` | +2 testes (cenários F/G/H): cobrança inexistente + payload inválido + isolamento por empresa (+130 linhas) |
| `docs/RELATORIO-ERP-01.md` | **novo** — este relatório |
| `docs/ERP-CORE-ROADMAP.md` | §5 ERP-01 — ponteiro para este relatório e para a prova desta rodada |

**Do ciclo ERP-01 (já na `main`, PR #49):** `server/src/gateway.ts` (+87/−18),
`server/test/pg/e01-gateway-webhook-postgresql.test.ts` (novo),
`server/test/pg/contrato-tipo-coluna.test.ts` (novo), docs. **Nenhum arquivo de
frontend, Commerce, BI ou produção foi tocado.**

## 6. SOLUÇÃO

* `lerPayloadWebhook(bruto)` — normalização explícita e segura: objeto ⇒ objeto;
  string ⇒ `JSON.parse` com `try/catch`; `Buffer` ⇒ string; `null`/vazio/inválido
  ⇒ `{}`. **Nunca** `JSON.parse(String(objeto))` como estratégia genérica.
* `payloadParaArmazenar(corpo)` — corpo JSON vira **objeto JSONB consultável**
  (`payload->>'event_id'`); corpo não-JSON é preservado no envelope `{ bruto }`.
* Duplicidade: linha `'ignorado'` **reaproveitada** no retry legítimo (mesma
  linha, sem 2ª inserção); `23505` em corrida ⇒ `200 {duplicado:true}`.
* `catch` externo da rota pública ⇒ `202` genérico + `reportarErro()` (log
  estruturado); nenhuma resposta anônima carrega tabela/coluna/constraint/SQL.
* Contrato: `payload` declarado `type: 'json'` em `R_GATEWAY_WEBHOOK_EVENTS` e
  `R_GATEWAY_COBRANCAS` (ambas as colunas são JSONB).

## 7. MIGRATION

**MIGRATION NÃO NECESSÁRIA — o schema PostgreSQL já possui JSONB correto; a
correção é de contrato/leitura.** Nenhuma migration foi criada, nenhuma
migration antiga foi editada, `db/schema.sql` não precisou mudar.

## 8. COMPORTAMENTO DO JSONB

| | PostgreSQL (coluna `jsonb`) | MemStore (modo demonstração) |
|---|---|---|
| O que o store devolve ao ler `payload` | **objeto** JavaScript (driver `pg`) | o que foi gravado (string JSON) |
| Por que o P0-02 não aparecia | — | `String(string)` + `JSON.parse` funciona; **não há divergência de tipo** em memória |
| Depois da correção | objeto ⇒ usado como está | string JSON ⇒ `JSON.parse` com `try/catch` |
| Gravação | objeto JSONB consultável (`jsonb_typeof = 'object'`) | objeto/string equivalente |

## 9. IDEMPOTÊNCIA

Regras finais, distinguindo os cinco casos:

1. **evento legítimo processado** ⇒ `200 {ok:true, resultado, processado:true}`;
2. **evento legítimo repetido** ⇒ `200 {ok:true, duplicado:true, evento_id}` — sem
   segunda baixa (a baixa só ocorre em título `pendente`) e sem segunda linha;
3. **cobrança inexistente** ⇒ `200 {ok:true, resultado:'ignorado', processado:false}`,
   uma linha de auditoria, **nenhum** efeito financeiro e **nenhuma** cobrança criada;
4. **payload inválido** ⇒ `202 {ok:true, ignorado:true}` (política existente),
   sem persistir e sem efeito;
5. **evento inválido / sem efeito** ⇒ `'ignorado'`, cobrança intocada.

Evento inexistente **não** é transformado em sucesso financeiro (`processado:false`).

## 10. CONCORRÊNCIA

Duas entregas idênticas simultâneas (cenário D do arquivo de prova): ambas
respondem `200 {ok:true}` (uma processa, a outra recebe `duplicado:true` ou o
`23505` tratado como duplicata), **um** evento, **uma** baixa, **um** título
confirmado. Transacionalmente, o efeito roda na infraestrutura existente
(`s.transaction(..., { isolation: 'serializable' })`) e a transição de estado usa
`tryUpdateIf` (guarda de estado atômica) — **nenhum** motor transacional novo.

## 11. SEGURANÇA

* Rota pública por design — **nenhuma** alteração de autenticação; as demais rotas
  não foram tocadas.
* Nenhuma resposta anônima expõe constraint, tabela, coluna, SQL ou stack trace:
  o coletor `semVazamento` inspeciona **todas** as respostas públicas dos cinco
  testes (regex sobre `constraint|duplicate key|SQLSTATE|violates|relation "|column "|gateway_|pg_`).
* Validações existentes preservadas: provedor desconhecido ⇒ `404`; corpo vazio ⇒
  `400`; assinatura inválida (quando há segredo) ⇒ `401` + registro forense.

## 12. MULTIEMPRESA

O gateway é financeiro: o evento é atribuído à empresa **dona da cobrança**
(`empresa_id` vem da cobrança encontrada), e a prova nova (cenário H) confirma
que o webhook de A confirma **só** A: B permanece `pendente` (cobrança e título),
A recebe **uma** baixa, e o caminho inverso não reabre A. **Nenhuma regra nova de
multiempresa foi criada.**

> **P1-11 continua aberto** (não é deste ciclo): a validação de assinatura varre
> todas as configs do provedor, sem `empresa_id`. Permanece registrado como teste
> `todo` (`ERP-01/P1-11`) — falha esperada, **não** um skip para esconder defeito.

## 13. TESTES

### 13.1 Cenários novos (esta rodada) — `e01-gateway-webhook-postgresql.test.ts`

| Cenário | O que prova |
|---|---|
| **F** — `provider_ref` inexistente | `200`, `resultado:'ignorado'`, `processado:false`; **1** linha de evento com `cobranca_id NULL`; **0** cobranças criadas; **0** lançamentos; repetição ⇒ ainda **1** linha |
| **G** — payload inválido | corpo não-JSON e JSON sem referência ⇒ `202 {ok:true, ignorado:true}`; **zero** linhas novas em `gateway_webhook_events` (medido por delta) |
| **H** — isolamento por empresa | A fica `paga` + título `confirmado` + **uma** baixa; B segue `pendente`; evento com `empresa_id`/`cobranca_id` de A; webhook de B não altera A; repetição de A ⇒ `duplicado:true` |

**Prova de que os cenários novos não são tautologia** (mutação `filtro`, busca da
cobrança sem `provider_ref`): cenário F falha com `'erro' !== 'ignorado'` e o
cenário H falha com `'pendente' !== 'paga'` — os dois testes pegam o defeito.

### 13.2 Por que os testes anteriores não pegaram o P0-02

O webhook **público** de gateway só era exercitado em **MemStore**
(`server/test/financeiro-p2.test.ts:283/311/341`), onde `payload` nunca passa por
uma coluna `jsonb` — `String(string)` + `JSON.parse` funciona e o defeito de tipo
não existe. `server/test/pg-p2.test.ts` só verificava que o **índice único existia**
e `server/test/webhooks.test.ts` é o domínio de **saída**
(`webhook_entregas.payload TEXT`). O vão era de **ambiente e de caminho**, como a
auditoria descreveu.

## 14. GATES (executados nesta rodada)

| Gate | Resultado |
|---|---|
| `npm run typecheck` | ✅ 0 erros (domain + server + client) |
| `npm test` | ✅ server **759 testes · 694 pass · 0 fail · 65 skipped**; client **262 pass (26 arquivos)** |
| `npm run test:pg` (PostgreSQL 16.14 real) | ✅ **134 testes · 133 pass · 0 fail · 0 skipped · 1 todo** (16m31s) — baseline antes dos cenários novos: 132/131/0/1 |
| `npm run lint` | ✅ 0 erros (415 warnings pré-existentes) |
| `npm run build` | ✅ OK |
| `npm run smoke` (MemStore, servidor recém-subido) | ✅ **126/126** |
| `npm run smoke:pg` (PostgreSQL novo, banco criado pelo runner) | ✅ **126/126** (inclui `webhook pago → processado`, `mesma notificação de novo → duplicado`, `cobrança ficou paga`) |
| `npm run audit:menu` | ✅ 0 erros (1 aviso `[ROTA_PUBLICA]` em `/api/health`, pré-existente) |
| `npx prisma validate` | ⚠️ **NÃO EXECUTADO — MOTIVO**: o `schema-engine` do Prisma é baixado de `binaries.prisma.sh`, host inacessível neste sandbox. O schema Prisma **não foi tocado** e nenhuma migration foi criada; no CI o passo permanece. |

## 15. LIMITAÇÕES

* O gateway **real** (Mercado Pago) não foi exercitado — sem credenciais e sem
  saída de rede para o provedor. A prova é com o provedor `mock`, como no CI.
* **P1-11** (escopo multiempresa da assinatura) segue aberto e é decisão de
  arquitetura, não deste ciclo.
* `npx prisma validate` não roda neste sandbox (rede).
* A reconstrução do código pré-correção é **por mutação declarada** (§3), não por
  `checkout` de revisão antiga — o pacote tem um commit único.
* A rodada é de **verificação e complemento de prova**; a implementação do P0-02
  já estava na `main` (PR #49).
* **Janela de atomicidade do evento (pré-existente, não alterada):** o evento é
  gravado **antes** do processamento (é o que garante o ACK e o retry sem perder
  notificação). Se o processo cair **entre** o commit do efeito financeiro e a
  atualização do evento para `'processado'`, a linha fica em `'recebido'`: o
  efeito financeiro está aplicado **uma única vez** e a cobrança está correta, mas
  o `cronWebhooks` reprocessa apenas `status='erro'` — a recuperação dessa janela
  exige o **reprocessamento manual** (`POST /api/financeiro/gateway/webhooks/:id/reprocessar`,
  que aceita `'recebido'`). Não foi mexido neste ciclo (fora do escopo cirúrgico);
  fica registrado como limitação, sem afirmar defeito não demonstrado.

## 16. EVIDÊNCIAS

| Evidência | Onde |
|---|---|
| Mutação `leitura` (antes) | `/tmp/evidence/antes-leitura.txt` |
| Mutação `duplicidade` (antes) | `/tmp/evidence/antes-duplicidade.txt` |
| Código corrigido (depois) | `/tmp/evidence/depois-correcao.txt` |
| Arquivo de prova com cenários F/G/H | `/tmp/evidence/e01-complementos.txt` |
| Mutação `filtro` nos cenários novos | `/tmp/evidence/mutacao-novos-cenarios.txt` |
| Suíte PostgreSQL completa | `/tmp/evidence/test-pg-final.log` |
| Reconstrução do código pré-correção | `/tmp/evidence/mutacao.mjs` |

## 17. GAP FECHADO

**P0-02 — FECHADO**, com prova antes/depois em PostgreSQL real nesta rodada e
registro em [`docs/ERP-GAPS.md`](ERP-GAPS.md):

> Pagamento → Webhook → Cobrança → Recebimento → Conciliação volta a fechar em
> PostgreSQL; o endpoint público não devolve mais metadado de schema; e as
> notificações repetidas são idempotentes (uma única baixa).
