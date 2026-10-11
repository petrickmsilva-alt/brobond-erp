# Auditoria independente — ciclos ERP-01 … ERP-04

**Data:** 2026-10-11 · **Commit auditado:** `bb17f19` (branch `arena/fe358944-brobond-erp`, PR
[#49](https://github.com/petrickmsilva-alt/brobond-erp/pull/49))
**Objeto:** os quatro ciclos fechados do roadmap — **P0-02** (ERP-01), **P0-01** (ERP-02),
**P0-04/P0-05** (ERP-03) e **P0-03/P1-07** (ERP-04) — no estado em que foram declarados
fechados, com evidência executada.
**Regra desta auditoria:** leitura + prova. Nada foi corrigido, nada foi mergeado, nenhum
arquivo de produção foi alterado por causa dela (as duas exceções estão declaradas no §6 e
são **documentação**). O objetivo é **tentar derrubar** as conclusões dos ciclos, não
confirmá-las por leitura de resumo.

---

## 0. Método

1. **Estado real do repositório** (`git status`, `git log`, `git remote`, `gh run list`) antes
   de qualquer leitura — a auditoria não parte de resumo.
2. **Leitura integral do código entregue por ciclo** (não do texto do roadmap).
3. **Prova por mutação:** para cada ciclo, o arquivo do fix foi revertido para o commit
   anterior e o teste daquele ciclo **precisou falhar** em PostgreSQL real; depois restaurado.
   Prova por mutação é o que separa "o teste passa" de "o teste mede o defeito".
4. **Bateria completa** (`test:pg`) re-executada — em **banco novo**, porque o banco de teste
   reaproveitado estava poluído (achado **AUD-03**, §6).
5. **Experimentos controlados** em banco descartável para os casos-limite que o ADR-001
   declara (venda sem usuário ativo; empresa sem usuário ativo com outra empresa com).
6. **Verificação dos invariantes declarados:** namespace `erp:`, não-regressão de canal
   externo, escopo por empresa, ausência de vazamento entre empresas.

## 1. Estado do repositório

* `arena/fe358944-brobond-erp` — HEAD `bb17f19`, árvore limpa, push feito.
* Ciclos: `8cab165` (ERP-01), `8ad1c39`/`44c43a8` (docs ERP-01), `e2bb651`/`e499e28` (ERP-02),
  `7caa880`/`4f9ce16`/`ad125f7`/`9bf90c8`/`557d652` (ERP-03), `5d1b410`/`08cc62b`/`1c2b042`/
  `c90eb47`/`bb17f19` (ERP-04).
* CI do último commit com run concluído (`557d652`): **verde** nos dois jobs
  ([38146107860](https://github.com/petrickmsilva-alt/brobond-erp/actions/runs/38146107860) e
  38146103825). O run do push `bb17f19` foi disparado no fechamento desta auditoria.
* **Nenhum arquivo de Commerce foi tocado** em nenhum dos quatro ciclos: os diffs de
  `modules/` nos quatro ciclos somam zero linhas.

---

## 2. ERP-01 — P0-02: webhook de pagamento não confirmava cobrança em PostgreSQL

* **Entrega auditada:** `server/src/gateway.ts` — `lerPayloadWebhook()` (payload lido pelo tipo
  real: objeto JSONB, string JSON, Buffer, nulo), `payloadParaArmazenar()`, reaproveitamento da
  notificação anterior `ignorado`, `23505` em corrida → `200 { duplicado: true }`, nenhuma
  resposta anônima com mensagem de driver, `payload` declarado `type: 'json'` nos dois recursos.
* **Evidência re-executada:** `server/test/pg/e01-gateway-webhook-postgresql.test.ts` — **passa**
  (o `todo` é o P1-11, abaixo). O teste sobe servidor real e usa a **rota pública**.
* **Prova por mutação:** ⏳ (§7).
* **Ressalva declarada no próprio ciclo:** **P1-11** — a assinatura do webhook é validada contra
  todas as configurações do provedor, sem empresa; o segredo de uma empresa pode recusar
  notificação de outra. Não foi corrigido de propósito (decisão de escopo multiempresa) e está
  fixado como teste `todo` — a auditoria confirma que o `todo` **falha pelo motivo documentado**
  (`401 Assinatura inválida` em vez de `200`), ou seja, não é um `todo` cosmético.
* **Verificação adicional da auditoria:** a classe do defeito (texto virando `[object Object]`)
  não reaparece em outro ponto: `grep` por `JSON.parse(String(` nos módulos de gateway/fiscal
  encontrou apenas leituras já protegidas. **Sem achado novo.**

## 3. ERP-02 — P0-01: reabrir/estornar OP devolvia 500 em PostgreSQL

* **Entrega auditada:** `server/src/producao.ts` (`estornarOrdem` usa `tryAdjustStock`,
  UPDATE condicional com row lock, em vez de `adjustStock`/`INSERT … ON CONFLICT` com delta
  negativo) e `server/src/pgstore.ts` (`23514` → `409` sem vazar o nome do constraint).
* **Prova por mutação:** ⏳ (§7). **Evidência re-executada:** ⏳ (§7).
* **Verificação adicional da auditoria (a pergunta certa):** *a mesma classe existe em outro
  ponto?* Varredura de todas as chamadas de `adjustStock`/`tryAdjustStock` no servidor:
  os caminhos com **delta negativo** (inventário, transferência, movimentação de estoque,
  estorno de expedição, estorno da venda) já usam `tryAdjustStock`; os que usam `adjustStock`
  passam delta **positivo** (`custoRecebimento:347`, `estoque:601/606`, `expedicao:763`,
  `itens:520`, `producao:457`, `services:1520/1540`). O único resíduo é `adjustInsumoStock`
  (insumos), já registrado como **P3-07** — confirmado: `estoque_insumos` **não tem CHECK** de
  quantidade não negativa, então o padrão não dispara hoje; a auditoria **concorda com a
  classificação P3** e registra que o risco é de *saldo de insumo negativo silencioso*, não de
  erro 500.

## 4. ERP-03 — P0-04 (onboarding sem SQL manual) e P0-05 (índice global derrubava o boot)

* **Entrega auditada:** `server/src/services.ts` (`provisionarLocalPadrao`, `NOME_LOCAL_PROVISIONADO`,
  `getDefaultLocalInfo` provisionando **só** quando a empresa não tem nenhum local),
  `db/schema.sql` (remoção do `CREATE UNIQUE INDEX` legado **global** de `codigo_barras`),
  `server/src/resources.ts` (7 declarações alinhadas ao banco), `scripts/smoke-pg.mjs` +
  etapa nova no job `testes-postgres` do CI, `server/test/pg/contratoTipos.ts` (inspetor), testes
  e03.
* **Leitura do código:** a regra é **estreita como declarada** — provisiona somente
  `quantidade === 0` locais; empresa com locais (mesmo inativos) segue para o 409 explicativo.
  `audit()` é chamado **com `tx`** (o comentário no código explica o 40001 que motivou isso).
  Corrida tratada por `23505`/409 → relê `{empresa_id, padrao: true}`.
* **Prova por mutação:** ⏳ (§7).
* **Verificação adicional da auditoria:** o índice global não reaparece em nenhum caminho
  (`grep` em `db/schema.sql` + `db/migrations/*.sql` por `CREATE UNIQUE INDEX.*codigo_barras`:
  só as versões **por empresa**, com `regexp`/`empresa_id`). O `DROP` legado continua no lugar.

## 5. ERP-04 — P0-03/P1-07: o ERP alimenta o BI (ADR-001, opção B)

* **Entrega auditada:** `server/src/negocios.ts` (`projetarVendasErp` + projeção em memória +
  agendador com debounce + projeção no ciclo do motor), `server/src/eventosVenda.ts`,
  `server/src/itens.ts` (ganchos), `server/src/relatorios.ts` (`diaISO`), ADR-001, testes.
* **Invariantes verificados por leitura do SQL** (não pelo resumo):
  1. **Namespace** — toda escrita usa `erp:venda:`/`erp:item:`; `DELETE`/`UPDATE` do
     sincronizador filtram `id LIKE 'erp:venda:%'` (o `LIKE` não tem curinga no meio: só
     prefixo). **Confirmado.**
  2. **Idempotência** — `INSERT … ON CONFLICT (id) DO UPDATE`; provado também pelo teste e2e
     (recalcular duas vezes não duplica). **Confirmado.**
  3. **Sem invenção** — `freight_cents = 0`, `external_order_id = NULL`, `discount_cents`
     derivado do subtotal real; canal por tabela explícita, sem inventar marketplace.
     **Confirmado no código e no e2e.**
  4. **Escopo por empresa** — o BI filtra `s.empresa_id` (`negocios.ts:470-473`) e
     `aplicarEscopoEmpresaBi` exige empresa permitida do ator. **Confirmado.**
  5. **Não-regressão de canal externo** — o e2e confere 11 campos da linha de conector depois
     da sincronização. **Confirmado.**
* **Prova por mutação:** ⏳ (§7).
* **Achados do experimento controlado (banco descartável, §6):** **AUD-01** e **AUD-02**.

---

## 6. Achados desta auditoria

### AUD-01 — P2 · código · projeção com **zero** usuários ativos lança `23503` em vez de pular a venda

**Evidência (banco descartável `brobond_aud04`, PostgreSQL real, `projetarVendasErp()` direto):**

```
A) 1 usuário ativo (empresa 1)  → {"vendas":1,"itens":1,...}; sales = erp:venda:1 PAID 10000
B) nenhum usuário ativo         → LANÇOU: insert or update on table "sale_items"
                                  violates foreign key constraint "sale_items_sale_id_fkey"
   estado final: sales erp:% = 1 (inalterado) · itens órfãos = 0
```

**Causa:** o passo 1 (vendas) filtra `AND COALESCE(eu.usuario_id, fb.usuario_id) IS NOT NULL`
— venda sem responsável não entra em `sales`. O passo 2 (itens) **não repete essa condição**:
insere `sale_items` com `sale_id` que não existe, e a FK `sale_items.sale_id REFERENCES
sales(id)` (validada no fim da instrução) aborta **a transação inteira**.
**Impacto:** (a) o ADR-001 §5 (risco residual 3) afirma "a projeção é pulada para essa venda e
logada; nenhuma linha parcial é escrita" — a segunda metade é verdadeira (a transação aborta),
mas o comportamento é **erro**, não pulo; (b) a via `POST /api/negocios/margens/recalcular`
responde **400 "Referência inválida…"** (tradução do 23503) — mensagem enganosa para um caso
que não é erro do usuário; (c) o ciclo do motor registra aviso e **nenhuma** venda é projetada.
**Estado para chegar lá:** todos os usuários do sistema inativos (`usuarios.ativo = false`) —
estado extremo, mas alcançável (não há regra que impeça desativar o último admin).
**Recomendação (não executada):** repetir a condição de responsável no passo 2 (ou derivar as
duas escritas da mesma seleção); e o endpoint devolver mensagem própria. **Não corrigido nesta
auditoria** — documentado para o ciclo que retomar o motor.

### AUD-02 — P3 · documentação · o "responsável" eleito pode ser de **outra** empresa

**Evidência (mesmo experimento, cenário C):** empresa 2 sem usuário ativo, empresa 1 com um —
a venda da empresa 2 **foi projetada** com `usuario_id` = usuário **da empresa 1**:

```
C) venda empresa 2 → {"id":"erp:venda:3","empresa_id":2,"usuario_id":2,"channel":"BROBOND"}
   empresa do usuário eleito → {"id":2,"empresa_id":1}
```

**Divergência:** o ADR-001 §4 ("`usuario_id` = responsável ativo **da empresa**") e o
**P1-14** ("venda de empresa sem usuário ativo **não é projetada**") descrevem o comportamento
como se o fallback fosse por empresa; o SQL tem `fallback_usuario` **global** (primeiro usuário
ativo do sistema, `CROSS JOIN`).
**Por que não é vazamento hoje:** o BI escopa por `empresa_id` (o número mostrado é o da venda);
o painel de conectores lê `sales` por `usuario_id + channel` de **conector**
(`panel.service.ts`), e a projeção só produz `LOJA_FISICA`/`BROBOND` — canais que não existem
no mapa `SALE_CHANNEL_BY_PROVIDER` (`providers.ts:221-230`). **Nenhum dado cruza de empresa em
nenhuma tela atual.**
**Recomendação (não executada):** declarar o fallback no ADR (é o comportamento real) **ou**
restringi-lo à empresa — decisão de escopo multiempresa, não desta auditoria. Correção de
**documentação** aplicada nesta auditoria: ADR §4/§5 e a linha **P1-14** passam a descrever o
comportamento real (fallback global) e a apontar o AUD-01.

### AUD-03 — P2 · testes · `test:pg` **não é repetível em banco reaproveitado**

**Evidência:** a primeira bateria completa desta auditoria reprovou 5 testes de
`server/test/pg/pg-cotacoes-compra.test.ts` com `duplicate key value violates unique constraint
"uq_empresas_cnpj"` (23505) **no banco compartilhado `brobond_teste`** (701 empresas acumuladas).
O mesmo arquivo, sozinho, **passou 7/7 duas vezes seguidas** em banco novo (`brobond_audrep`) e
a bateria completa em banco novo passou sem esse erro.
**Mecanismo:** o índice é único por **dígitos**: `uq_empresas_cnpj ON empresas
(regexp_replace(cnpj, '[^0-9]', '', 'g')) WHERE …` (`db/schema.sql:1466-1468`). O teste gera
`'11' + SUFIXO.slice(0, 12)` com `SUFIXO = Date.now().toString(36) + aleatório` — base36, com
poucos dígitos, dominado por um prefixo temporal que **muda devagar**. O "CNPJ" efetivo tem
**4 a 6 dígitos** (medido no banco: 16 empresas com 4 dígitos, 16 com 5, 16 com 6, 8 com 7),
repetindo-se entre execuções próximas; as empresas criadas pelos testes **nunca são removidas**
(nenhum teardown as apaga), então a execução seguinte colide.
**Impacto:** não afeta produção nem o CI (que roda em banco novo); afeta **a repetibilidade
local** da bateria e qualquer verificação que rode `test:pg` duas vezes no mesmo banco — inclusive
o critério "bateria verde" do §9 do roadmap se ele for avaliado em banco reaproveitado.
**Recomendação (não executada):** derivar 14 dígitos determinísticos do sufixo inteiro
(ex.: `'11' + String(BigInt('0x' + sufixo) % 10n ** 12n).padStart(12, '0')`) ou apagar as
empresas do cenário no `teardown`.

### Confirmações (tentou-se refutar e não se conseguiu)

* **ERP-01:** o `todo` do P1-11 falha **pelo motivo documentado**, e a resposta pública não
  vaza nome de constraint (o e2e confere).
* **ERP-02:** a classe do defeito está eliminada dos caminhos negativos de `estoques`;
  o resíduo é o P3-07 já registrado (confirmado: sem CHECK em `estoque_insumos`).
* **ERP-03:** provisionamento estreito, idempotente e com auditoria na mesma transação;
  o índice global não está em nenhuma migration nem no `schema.sql` atual.
* **ERP-04:** namespace, idempotência, sem invenção de dado, escopo por empresa e
  não-regressão de canal externo — todos conferidos **no código e no banco**, não no resumo.

---

## 7. Prova por mutação e baterias (evidência executada)

### 7.1 Prova por mutação — o arquivo do fix revertido, o teste do ciclo **tem** de falhar

Cada linha é uma execução real: o arquivo de produção foi restaurado para o commit **anterior** ao
fix (ou para o estado pré-ERP-04) na árvore de trabalho, o teste do ciclo rodou em PostgreSQL real
e o arquivo foi restaurado em seguida (a árvore terminou limpa; a bateria do e2e foi reexecutada
passando com o código correto).

| Ciclo | Arquivo revertido | Resultado com o código ANTIGO | Veredito |
|---|---|---|---|
| ERP-01 | `server/src/gateway.ts` (`8cab165~1`) | `# tests 3 · pass 0 · fail 2 · todo 1` (exit 1) — "não processa", "payload JSONB" | ✅ o teste mede o defeito |
| ERP-02 | `server/src/producao.ts` + `server/src/pgstore.ts` (`e2bb651~1`) | `# tests 2 · pass 0 · fail 2` (exit 1) | ✅ |
| ERP-03 (onboarding) | `server/src/services.ts` (`7caa880~1`) | `# tests 1 · pass 0 · fail 1` (exit 1) | ✅ |
| ERP-03 (P0-05) | `db/schema.sql` (`7caa880~1`) com o MESMO EAN em duas empresas | `MIGRATE FALHOU: could not create unique index "uq_produtos_codigo_barras"` | ✅ restaurado: `MIGRATE OK` no mesmo banco/estado |
| ERP-04 (projeção) | `server/src/negocios.ts` (`557d652`) | `# tests 1 · pass 0 · fail 1` — BI `pedidos 0` em vez de 1 (`0 !== 1`) | ✅ |
| ERP-04 (filtro de período) | `server/src/relatorios.ts` (`557d652`) | `# tests 1 · pass 0 · fail 1` — relatório `0` em vez de `20000` (`0 !== 20000`) | ✅ |

Ao final: `git status` limpo (só este documento, novo), e `bi-faturamento-e2e` **1/1** com o código
correto — a mutação não deixou resíduo.

### 7.2 Bateria completa em banco NOVO (a prova de regressão)

```
DATABASE_URL=…/brobond_aud4  npm run test:pg
# tests 124 · # pass 123 · # fail 0 · # cancelled 0 · # skipped 0 · # todo 1 · exit 0
# duration_ms 728869  (12min09s; ~I/O do sandbox — ver nota abaixo)
```

O único `todo` é o **P1-11**, declarado e conhecido. A bateria **só é válida em banco novo**: em
banco reaproveitado ela reprova por **AUD-03** (§6), não por regressão de código.

Repetida no mesmo commit depois da correção do escopo da asserção de canal do BI (`bb17f19`), em
outro banco novo: **`# tests 124 · pass 123 · fail 0 · todo 1`** de novo (`# duration_ms 729026`).

### 7.3 CI no commit auditado (`bb17f19`)

* `testes-postgres` e `verificar`: **success** nos runs
  [38148326540](https://github.com/petrickmsilva-alt/brobond-erp/actions/runs/38148326540) e
  38148323203. O job PG inclui a etapa `Smoke E2E contra PostgreSQL novo (gate ERP-03)` — **success**.
* O run anterior do mesmo fluxo (`557d652`, [38146107860](https://github.com/petrickmsilva-alt/brobond-erp/actions/runs/38146107860)):
  também verde nos dois jobs.
* **Nota de duração (para não gerar suspeita futura):** o job PG varia de **1m30s a 12m24s** entre
  runs. A auditoria mediu a causa: **um único `migrate()` custa ~30 s neste sandbox** (contra
  `user` CPU de 0,3 s — é espera de I/O, não de lógica) e há 24 arquivos de teste, cada um com o seu
  runner. No CI, com disco rápido, o mesmo trabalho cai para a casa do minuto e meio. **Não é o CI
  pulando testes**; o log interno do runner não é baixável deste ambiente (`gh api …/logs` devolve
  vazio) — a bateria local é a evidência primária.

## 8. Veredito

# ✅ GATE APROVADO COM RESSALVAS (P2)

**Os quatro ciclos estão comprovados como declarados.** Nada do que a auditoria tentou derrubar caiu:
cada fix tem teste que **falha com o código antigo e passa com o novo** em PostgreSQL real (6
mutações, §7.1), a bateria completa em banco novo está **0 fail** (§7.2) e o CI do commit auditado
está verde, incluindo o gate de smoke (§7.3). Nenhum arquivo de Commerce foi tocado.

**Ressalvas, todas P2 — nenhuma bloqueia o merge pelo critério do próprio roadmap (P0/P1 = 0):**

1. **P2-08 (novo, código — AUD-01):** projeção do ERP com **zero** usuários ativos lança `23503`
   (`sale_items_sale_id_fkey`) e o endpoint devolve `400` enganoso; o ADR descreve "pulada e
   logada". Estado alcançável, impacto contido (nenhum dado parcial; BI simplesmente não projeta).
   **Candidato ao primeiro ciclo depois do merge** (junto com o P1-13 de `comissoes.ts:261`).
2. **P2-09 (novo, testes — AUD-03):** `test:pg` não é repetível em banco reaproveitado
   (CNPJ de teste com 4–6 dígitos efetivos + índice único por dígitos + empresas sem teardown).
   Não afeta produção nem o CI (banco novo); afeta a verificação local e qualquer auditoria futura.
3. **AUD-02 (documentação, corrigida nesta auditoria):** o "responsável" da projeção pode ser de
   outra empresa (fallback global) — ADR §4/§5 e a linha P1-14 do relatório passaram a descrever o
   comportamento real. Nenhum vazamento nas telas atuais (verificado por canal e por empresa).

**O que este veredito autoriza:** seguir o fluxo combinado (**GATE → decisão de merge pelo dono do
repositório**). **O que ele não faz:** merge. Esta auditoria não mergeou, não corrigiu código e não
apagou nenhuma linha de teste.

## 9. Limitações

* Auditoria **dos quatro ciclos fechados**; não reavalia os domínios do roadmap que ainda não
  têm ciclo executado (ERP-05…ERP-13).
* Não houve auditoria de segurança ofensiva (o escopo de RBAC/multiempresa é o dos ciclos).
* O CI do push final desta auditoria foi observado por `gh run list`; a bateria local é a
  evidência primária.

## 10. Encaminhamento (acrescentado em 2026-10-11, depois desta auditoria)

O ciclo seguinte (**"P1-13 + P2-08"**, roadmap §5) fechou as duas ressalvas de **código** apontadas aqui.
Esta seção é um acréscimo: as seções §0–§9 permanecem **exatamente como foram publicadas** na auditoria
(`750a85e`), porque o papel do documento é registrar o que a auditoria encontrou — não o que foi corrigido
depois dela.

* **P2-08 → fechada.** O passo dos itens passou a repetir a condição de responsável
  (`AND EXISTS (SELECT 1 FROM sales s WHERE s.id = 'erp:venda:' || iv.venda_id)`). Reprodução exata do
  defeito **antes** da correção (experimento em banco descartável, `/tmp/aud-nouser.mts`, com zero usuários
  ativos e sem a venda pai projetada): `projetarVendasErp` lança `23503` —
  `Key (sale_id)=(erp:venda:7) is not present in table "sales"` (constraint `sale_items_sale_id_fkey`).
  **Depois:** `{vendas: 0, itens: 0}`, sem linha parcial; a via sob demanda responde `200`. Prova permanente:
  `server/test/pg/projecao-sem-usuario.test.ts` (mutação: cláusula removida ⇒ `not ok` com o mesmo `23503`).
  Nota de transparência: na **primeira** execução dentro da bateria esse teste falhou — por um defeito **da
  limpeza do próprio teste** (a projeção assinava as vendas com o usuário do teste e `sales_usuario_id_fkey`
  é `RESTRICT`), corrigido antes da publicação do ciclo.
* **P1-13 → fechado por varredura.** `utils.diaISO` passou a ser a **única** normalização de data civil,
  consumida por 17 módulos (18 arquivos com `utils.ts`), incluindo `comissoes.ts:261`, citado nesta auditoria
  como aberto. Provas: `server/test/utils.test.ts` (3/3), `server/test/pg/comissoes-periodo.test.ts` (banco
  novo) e mutação (`comissoes.ts:261` revertido ⇒ `not ok`: "o representante precisa aparecer no relatório do
  período").
* **P2-09 → continua aberto.** É regra de processo da bateria (banco novo como referência, como o CI já faz),
  não defeito de produto; segue registrada no roadmap §8 e em `docs/ERP-GAPS.md`.
