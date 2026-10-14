# Relatório ERP Go-Live 02 — P1-01 (PDV/Caixa) e P1-03 (Fiscal → Expedição)

**Data:** 14/10/2026
**Escopo:** somente **P1-01** e **P1-03** da cadeia VENDA PRESENCIAL → PAGAMENTO → CAIXA → FISCAL → EXPEDIÇÃO
**Commit base:** `3058c8f2b1054ba11b3d6e0d74c2a42a6b657d94` (`main`)
**Branch do ciclo:** `arena/ddc7e9e7-brobond-erp` (branch da sessão; nenhuma troca de branch foi feita)
**Evidências:** `docs/evidencias/erp-golive-02/`
**Veredito técnico:** **PASS técnico das duas correções** — reprodução ANTES, correção DEPOIS, PostgreSQL 16.14 real (local **e** no CI), concorrência, multiempresa, gates e E2E integrado. **Isto NÃO é aprovação de Go-Live; a aprovação é externa.**

---

## 1. Objetivo

Fechar a cadeia VENDA PRESENCIAL → PAGAMENTO → CAIXA → FISCAL → EXPEDIÇÃO, corrigindo exatamente dois
defeitos funcionais, sem abrir novas frentes e sem tocar P1-02, P1-04, P2, P3 ou UX:

- **P1-01 (PDV/Caixa):** eliminar a divergência de **R$ 15,00** no resumo do caixa, atacando a ORIGEM
  (criação do movimento), e não o display do endpoint. Regra de ouro preservada: venda → pagamento →
  movimento de caixa auditáveis; o resumo é DERIVADO dos movimentos válidos, sem segundo livro, segundo
  saldo ou segundo motor de caixa.
- **P1-03 (Fiscal → Expedição):** eliminar o **HTTP 409** que chegava DEPOIS da autorização fiscal, sem
  remover a proteção: documento pendente/rejeitado/cancelado continua bloqueando; NF legitimamente
  autorizada passa AUTORIZADA → SEPARAÇÃO → CONFERÊNCIA → EMBALAGEM → EXPEDIÇÃO, com **um único** fato
  econômico (nenhuma segunda baixa de estoque, nenhum movimento/evento duplicado).

## 2. Commit base

- Base: `3058c8f2b1054ba11b3d6e0d74c2a42a6b657d94` (`main`, HEAD do clone no início do ciclo).
- Ciclo anterior: `5d43c89d…` (ERP-GOLIVE-01-P0, PR #59).
- Nenhuma migration, nenhuma alteração de `db/schema.sql` ou `prisma/schema.prisma` (ver §15).

## 3. P1-01 — reprodução (ANTES)

**Cenário exato do defeito (auditoria ERP-COMMERCE-01):** caixa aberto com **R$ 50,00** de troco inicial;
**uma** venda de **R$ 25,00** paga com **R$ 30,00 em dinheiro** (troco de **R$ 15,00**) + **R$ 10,00 no cartão**.

O sistema respondia `esperado_em_dinheiro = 80,00` (50 + 30) quando a gaveta tinha **65,00** (50 + 15) —
exatamente os **R$ 15,00** da auditoria. O `total_vendido` somava **pagamentos** (40,00) e não **vendas** (25,00).

Reprodução executada (testes escritos ANTES da correção, rodados contra o código do commit base):

| Evidência | Comando | Resultado ANTES |
|---|---|---|
| `docs/evidencias/erp-golive-02/p1-01-antes.log` | `cd server && npm exec -- node --import tsx --test test/pdv-caixa-resumo.test.ts`¹ | **14 testes · 11 pass · 3 fail** — `L: 80 !== 65`, `L/legado: 30 !== 15`, troco inválido aceito |
| `docs/evidencias/erp-golive-02/pg-antes.log` | `DATABASE_URL=… npm exec -- node --import tsx --test test/pg/e424-golive-02-postgresql.test.ts` (fonte revertida: `git checkout 3058c8f -- server/src/{pdv,expedicao}.ts`) | **22 testes · 3 pass · 19 fail** — `o movimento de dinheiro é LÍQUIDO de troco · 30 !== 15`; `linhas LEGADAS… 30 !== 15`; `NFC-e… “Este pedido já foi faturado”` |

¹ caminho real: `server/test/pdv-caixa-resumo.test.ts` (o log traz o comando executado).

## 4. P1-01 — causa raiz

Não era filtro de período, nem corrida, nem duplicidade de linhas: era **origem do dado**.

1. `venderPdv` gravava em `pdv_pagamentos.valor` o dinheiro **ENTREGUE** pelo cliente (30,00) — inclusive a
   parte que sai da gaveta como **troco** (15,00). O troco é dinheiro do cliente, não receita de caixa.
2. `resumoCaixa` somava esse valor bruto (`por_forma.dinheiro`) e calculava
   `esperado_em_dinheiro = abertura + dinheiro_bruto + suprimentos − sangrias` → **50 + 30 = 80**.
3. `total_vendido` somava as linhas de **pagamento** em vez do `total` das **vendas** → 40,00 no lugar de 25,00.
4. Não havia nenhuma validação impedindo `troco > dinheiro recebido` (troco pago com cartão), o que permitiria
   movimento de caixa negativo/absurdo.

O defeito, portanto, **nascia no movimento** e se propagava ao resumo e ao fechamento — coerente com a
auditoria, que encontrou a divergência no `esperado` e não apenas no texto do endpoint.

## 5. P1-01 — correção

Arquivo: `server/src/pdv.ts` (+93 / −7). Nenhum motor novo, nenhuma tabela nova, nenhum segundo saldo:
o **mesmo** ledger (`pdv_pagamentos` + `pdv_caixa_movimentos`) passou a guardar o efeito correto.

- **`dinheiroNaGaveta(pagamentosDaVenda, totalDaVenda)`** (nova, exportada): o dinheiro que FICA na gaveta é
  `min(dinheiro_recebido, max(0, total − outros_meios))`. É a mesma regra lida de volta, o que mantém
  auditáveis as linhas gravadas ANTES da correção (quando `valor` recebia o valor entregue).
- **`venderPdv`**: o pagamento persistido passa pelo abate do troco (`pagamentosParaCaixa`) — o movimento vale o
  efeito **líquido** na gaveta (entregue − troco), e um pagamento que ficaria ≤ 0,009 é simplesmente não gravado.
  O valor entregue e o troco continuam no contrato da resposta (`calculo.total_pago`/`calculo.troco`) e na auditoria.
- **`venderPdv` (guarda nova)**: `troco > emDinheiro + 0,009` → **HTTP 400** antes de qualquer efeito
  (“O troco não pode ser maior que o dinheiro recebido…”). Só dinheiro gera troco.
- **`resumoCaixa`**: deixou de somar pagamentos soltos e passou a **derivar venda a venda** — monta
  `Map<vendaId, Row[]>` dos pagamentos das vendas **vivas** (cancelada não conta), aplica `dinheiroNaGaveta` por
  venda, ignora pagamento de venda inexistente/cancelada e calcula `total_vendido` pela soma de `venda.total`.
  `por_forma.dinheiro` continua sendo exibido apenas quando alguma venda movimentou dinheiro (compatibilidade).
- **`fecharCaixa`** não foi reescrito: usa o MESMO `resumoCaixa`, então `valor_sistema` e `diferenca` passaram a
  bater sem lógica paralela.

## 6. P1-01 — evidência (DEPOIS)

| Evidência | Resultado DEPOIS |
|---|---|
| `docs/evidencias/erp-golive-02/p1-01-depois.log` (14 testes) | **14/14 pass**, 0 fail |
| `docs/evidencias/erp-golive-02/pg-depois.log` (22 testes, PostgreSQL real, banco novo `brobond_pg_after4`) | **22/22 pass**, 0 fail/skip |
| `docs/evidencias/erp-golive-02/e2e-depois.log` | **1/1 pass** |
| `docs/evidencias/erp-golive-02/auditoria-crud-probe.log` | sonda adversarial do CRUD genérico (§18) |
| `docs/evidencias/erp-golive-02/estabilidade-mem.log` | 3 rodadas consecutivas verdes por suíte |
| `docs/evidencias/erp-golive-02/estabilidade-pg.log` | PG 22/22 em 3 rodadas consecutivas (mesmo banco) |

Cenários cobertos por `server/test/pdv-caixa-resumo.test.ts` (14 testes, A–L exigidos):

- **(A)** dinheiro sem troco: movimento = total, resumo = abertura + movimento;
- **(B)** cartão: nada entra na gaveta, forma aparece no `por_forma`;
- **(C)** múltiplas formas (dinheiro+pix+débito): cada movimento entra **uma vez** e Σ formas = total vendido;
- **(D)** resumo derivado (venda a venda) com suprimento e sangria no meio;
- **(E/F)** suprimento e sangria movem a gaveta sem tocar no vendido;
- **(G)** venda cancelada sai do resumo e o estoque volta **uma vez**;
- **(H)** fechamento grava `valor_sistema` dos movimentos e a diferença contada;
- **(I)** duas vendas simultâneas e dois fechamentos simultâneos (um vence, o outro 409);
- **(J)** ler o resumo não move dinheiro; repetir a venda não duplica movimento;
- **(K)** caixas de empresas diferentes não se misturam e B não opera o caixa de A;
- **(L)** **o cenário exato dos R$ 15,00** (25,00 pagos com 30,00 em dinheiro + 10,00 no cartão), a recusa
  de troco maior que o dinheiro recebido, e a **linha LEGADA** (gravada com o valor BRUTO, como o código
  antigo gravava) lida de volta: a gaveta continua 65,00 — a regra de leitura normaliza o histórico sem
  exigir backfill, e uma linha NOVA (já líquida) na mesma gaveta não é abatida duas vezes.

Provas aritméticas exigidas, afirmadas em todos esses cenários:
`saldo inicial + entradas − saídas = saldo final` **e** `saldo calculado = soma dos movimentos válidos`.

## 7. P1-03 — reprodução (ANTES)

**Cenário exato:** venda com NF-e **AUTORIZADA** pela SEFAZ (provedor de teste responde `autorizado`) →
qualquer passo logístico → **HTTP 409**.

Reprodução executada contra o código base:

| Evidência | Resultado ANTES |
|---|---|
| `docs/evidencias/erp-golive-02/p1-03-antes.log` (13 testes) | **3 pass · 10 fail** |
| `docs/evidencias/erp-golive-02/pg-antes.log` (22 testes, PostgreSQL real) | **3 pass · 19 fail** |
| `docs/evidencias/erp-golive-02/e2e-antes.log` | **0/1** — `o movimento de caixa vale o líquido (250 − 50 de troco) · 250 !== 200` |

Mensagem do defeito, literal:

```
not ok 1 - P1-03 (M/A): NF autorizada entra em separação, confere, embala e expede — sem duplicar baixa
  error: 'Este pedido já foi faturado — a separação acontece antes do faturamento.'
    s.transaction.isolation (server/src/expedicao.ts:118:15)
```

O ANTES também expôs o **outro lado** do mesmo defeito, que a auditoria não tinha isolado: os testes de
documento **PENDENTE** e **REJEITADO** falharam com `esperava HTTP 409, mas a operação foi permitida` — ou
seja, o bloqueio antigo era **puramente baseado em `vendas.status`**: bloqueava a venda **autorizada** (que
deveria sair) e **permitia a expedição de venda sem nota autorizada nenhuma** (bypass silencioso).

## 8. P1-03 — causa raiz

1. A autorização fiscal (`aplicarEfeitosDaAutorizacao`, `server/src/fiscal.ts`) leva a venda a
   `status='faturada'` e baixa estoque/lança financeiro — e **não toca em `expedicao_etapa`**.
2. A máquina logística (`server/src/expedicao.ts`) recusava **qualquer** venda `faturada|entregue`
   (`separarPedido` → 409 em `expedicao.ts:118` na fonte ANTES), porque assume que faturamento acontece **dentro** do fluxo logístico.
3. Logo, a única venda que **deve** ser expedida (nota existe, mercadoria no galpão) era a única que **não
   conseguia entrar** no fluxo. A "alternativa" seria refaturar — o que baixaria o estoque **duas vezes**.
4. Ao mesmo tempo, o bloqueio não olhava documento fiscal nenhum: uma venda **aberta** com NF pendente ou
   rejeitada atravessava a expedição inteira e saía do galpão sem autorização (falha de proteção).

Não era permissão, nem tenant, nem filtro: era contrato de estado — a expedição não distinguia
**“faturada pelo fluxo logístico”** de **“faturada pela autorização da nota”**, e não consultava o documento.

## 9. P1-03 — correção

Arquivo: `server/src/expedicao.ts` (+125 / −13). O 409 **não foi removido**: ele passou a ser aplicado ao caso
certo, com a fonte de verdade do documento fiscal.

- **`documentoFiscalAutorizado(vendaId, escopo, tx)`**: último documento vivo da venda; devolve `null` quando
  não há documento.
- **`assertPodeEntrarNaExpedicao(venda, …)`**: venda `faturada|entregue` **sem** documento autorizado continua
  **bloqueada** (proteção preservada) — evita expedir faturamento sem autorização.
- **`documentoFiscalLibera(…){autorizado, bloqueio}`**: sem documento ⇒ `{null,null}`; `pendente`, `rejeitado`,
  `cancelado`, `erro` ⇒ **409** nomeando o número/status do documento (antes, esses casos eram permitidos).
- **`separarPedido` / `conferirPedido` / `embalarPedido` / `expedirPedido`** passam a aceitar a venda faturada
  **quando ela tem documento autorizado** — é o caminho AUTORIZADA → SEPARAÇÃO → CONFERÊNCIA → EMBALAGEM → EXPEDIÇÃO.
- **`expedirPedido`** ganhou `efeitosAplicados = jaFaturado || Boolean(fiscal.autorizado?.estoque_baixado_em)`:
  se o efeito econômico já foi aplicado (pelo faturamento do fluxo **ou** pela autorização), a expedição
  **não** chama `aplicarRegrasPedido`/`syncLancamentoVenda` — só avança a etapa logística. A fonte de verdade
  do “já aplicado” é o **carimbo do documento** (`documentos_fiscais.estoque_baixado_em`, escrito na MESMA
  transação do efeito), e não `vendas.status` — que é campo editável pelo CRUD genérico.
- Nenhum motor novo: estoque/financeiro continuam em `aplicarRegrasPedido` (itens.ts) e `syncLancamentoVenda`
  (financeiro.ts); a etapa logística continua em `avancarEtapa` (CAS em `expedicao_etapa`).

## 10. P1-03 — evidência (DEPOIS)

| Evidência | Resultado DEPOIS |
|---|---|
| `docs/evidencias/erp-golive-02/p1-03-depois.log` (13 testes) | **13/13 pass** |
| `docs/evidencias/erp-golive-02/pg-depois.log` (PostgreSQL real) | **22/22 pass** |
| `docs/evidencias/erp-golive-02/e2e-depois.log` | **1/1 pass** |
| `docs/evidencias/erp-golive-02/estabilidade-*.log` | 3 rodadas consecutivas verdes (memória e PostgreSQL) |

Cenários cobertos por `server/test/fiscal-expedicao.test.ts` (13 testes) e por
`server/test/pg/e424-golive-02-postgresql.test.ts` (22 testes, PostgreSQL real):

- **(A/M)** NF autorizada percorre as quatro etapas e expede — sem duplicar baixa;
- **(B)** documento **PENDENTE** bloqueia (409) — nada muda no banco (sem baixa, sem evento, etapa preservada);
- **(C)** documento **REJEITADO** bloqueia (409);
- **(D)** documento **CANCELADO** depois de autorizado bloqueia;
- venda **faturada sem documento** continua fora do fluxo logístico (proteção preservada);
- **carimbo do documento manda:** se o `status` da venda for revertido à mão (escrita direta, fora do motor),
  a expedição **não** refatura — uma única baixa, nenhum movimento novo, e o status volta ao que o efeito exige;
- **(I)** autorização repetida devolve o MESMO documento; expedição repetida não duplica estoque/evento;
- **(K)** conferência divergente aborta sem baixa e sem mudar a etapa; expedir sem embalar e embalar sem conferir
  são recusados sem efeito;
- **(L)** empresa B não opera a expedição de A (404) e a própria cadeia de B funciona;
- **(N)** venda **ENTREGUE** (o outro status terminal do faturamento): com documento autorizado expede com
  **uma** baixa; **sem** documento autorizado continua bloqueada (409, nada sai do estoque);
- **modelo do documento (contrato atual, pinado por teste):** a trava pergunta pelo documento **autorizado**
  sem restringir o modelo — uma **NFC-e (65)** autorizada também libera a expedição (§18/R6).

## 11. PostgreSQL real

Todos os números abaixo foram obtidos em **PostgreSQL 16.14 real** (`server_version_num` = 160014), não em MemStore.

| Execução | Banco | Resultado |
|---|---|---|
| `pg-antes.log` (fonte base, testes finais) | NOVO `brobond_pg_before4` | 22 testes · **3 pass · 19 fail** |
| `pg-depois.log` (fonte corrigida) | NOVO `brobond_pg_after4` | 22 testes · **22 pass · 0 fail** |
| `gate-test-pg.log` (`npm run test:pg`, suíte inteira) | NOVO `brobond_pg_gate10` | **181 testes · 181 pass · 0 fail · 0 skip · 0 todo** — “ERP-03 GATE PASS: 181 testes PostgreSQL reais; 0 fail/skip/todo.” (118.776 ms) |
| `gate-smoke-pg.log` (`npm run smoke:pg`) | NOVO `brobond_pg_smoke2` | **126/126** — “✅ smoke:pg — smoke E2E aprovado contra PostgreSQL real” |
| `estabilidade-pg.log` (22 testes × 3 rodadas) | `brobond_pg_stab` | **22/22 · 22/22 · 22/22** |
| CI do PR #60 — job `testes-postgres` (GitHub Actions, run [38644698250](https://github.com/petrickmsilva-alt/brobond-erp/actions/runs/38644698250)) | runner do CI (PostgreSQL 16.14) | **PASS** (2m34s) — migrations + `npm run test:pg` + `smoke:pg` no CI |

O que é lido **direto no banco** pelos testes PG (não pelo retorno dos handlers): `pdv_pagamentos.valor`,
`pdv_caixas.valor_sistema/diferenca`, `estoques.quantidade`, `movimentacoes`, `lancamentos_financeiros`
(por `referencia_tipo='venda'`/`referencia_id`), `documentos_fiscais.status/estoque_baixado_em/financeiro_lancado_em`,
`expedicao_eventos` (ordem e `empresa_id`), `vendas.status/expedicao_etapa/nfe_status`, e `empresa_id` de cada linha.
As transições **não dependem de estado em memória**: cada teste cria empresa/usuário/locais no banco e relê o estado.

## 12. Concorrência

| Cenário | Arquivo | Asserção |
|---|---|---|
| Duas vendas simultâneas no mesmo caixa | mem + PG | cada venda grava **um** pagamento; nenhum movimento/estoque duplicado |
| Dois fechamentos simultâneos | mem + PG | **um** vence; o perdedor recebe **409** controlado (nunca dois fechamentos) |
| Duas expedições simultâneas da mesma venda | mem + PG | a baixa de estoque acontece **uma vez**; um `expedicao_eventos` final |
| Duas autorizações simultâneas/repetidas | PG | o mesmo documento é devolvido; nenhum efeito duplicado |
| Ressalva de isolamento | — | sob SERIALIZABLE, ambos os lados podem abortar (40001→409); o teste aceita **≤ 1 vencedor** por rodada e exige que todo perdedor seja **409** controlado, reenviando em seguida para provar que o reenvio é idempotente (nunca duas baixas/dois movimentos) |

## 13. Multiempresa (A × B)

| Cenário | Evidência | Resultado |
|---|---|---|
| Caixa de A não soma em B; B não lê/opera/fecha o caixa de A (404) | `pdv-caixa-resumo.test.ts` (K) + PG | PASS |
| Expedição de A não é operada por B (404) e a de B funciona | `fiscal-expedicao.test.ts` (L) + PG | PASS |
| **Cadeia inteira de A invisível para B** (caixa, estoque, pagamentos, movimentos, eventos, documento fiscal, financeiro — `empresa_id` conferido linha a linha no banco) e a NF de A não é expedida como B | PG, teste “a cadeia inteira de A não aparece em B” | PASS |

## 14. Testes executados (gates)

| Gate | Comando | Resultado | Evidência |
|---|---|---|---|
| `audit:menu` | `npm run audit:menu` | **PASS** — sem erros; 1 aviso não bloqueante já classificado (`/api/health` pública) | `gate-audit-menu.log` |
| `typecheck` | `npm run typecheck` | **PASS** (domain, server, client) | `gate-typecheck.log` |
| `npm test` | `npm test` | **PASS** — server **806** testes / **740 pass** / **0 fail** / 66 skipped; client 28 arquivos / **306 pass** | `gate-test.log` |
| `build` | `npm run build` | **PASS** (Vite + PWA) | `gate-build.log` |
| `lint` | `npm run lint` | **PASS** — exit 0, **0 erros**, 409 warnings | `gate-lint.log` |
| `smoke` | `npm run smoke` (servidor demo :3001) | **PASS** — **126/126** | `gate-smoke.log` |
| `test:pg` | `DATABASE_URL=… npm run test:pg` | **PASS** — **181/181**, 0 fail/skip/todo (PostgreSQL 16.14 real) | `gate-test-pg.log` |
| `smoke:pg` | `DATABASE_URL=… npm run smoke:pg` | **PASS** — **126/126** (PostgreSQL real) | `gate-smoke-pg.log` |
| `git diff --check` | `git diff --check` | **PASS** — exit 0 | `gate-diff-check.log` |
| CI `verificar` (PR #60) | GitHub Actions | **PASS** — 1m16s (run 38644698250) e **1m58s no commit final `ed1e260`** (run 38645820086); inclui `prisma validate` (= `db:validate`) | `gate-ci-pr60.log` |
| CI `testes-postgres` (PR #60) | GitHub Actions | **PASS** — 2m34s e **2m48s no commit final `ed1e260`**; PostgreSQL real 16.14 | `gate-ci-pr60.log` |
| `db:validate` | `npm run db:validate` | **BLOQUEADO (rede) localmente** — o Prisma precisa baixar o schema-engine em `binaries.prisma.sh` e a TLS é bloqueada neste ambiente. **Não foi mascarado**; o passo `prisma validate` do CI cobre este gate | `gate-db-validate.log` |

Suítes novas do ciclo: `server/test/pdv-caixa-resumo.test.ts` (14), `server/test/fiscal-expedicao.test.ts` (13),
`server/test/golive-02-e2e.test.ts` (1), `server/test/pg/e424-golive-02-postgresql.test.ts` (22).

Estabilidade (não basta passar uma vez): `estabilidade-mem.log` — cada suíte de memória **3 rodadas
consecutivas** verdes (14/14, 13/13, 1/1 em todas); `estabilidade-pg.log` — o arquivo PostgreSQL completo
(22 testes, incluindo as quatro corridas) **3 rodadas consecutivas** verdes (22/22 · 22/22 · 22/22) no
mesmo banco.

### 14.1 Matriz requisito → teste (rastreabilidade)

As letras (A–L, A–M) são rótulos internos adotados neste ciclo — o requisito é o **cenário**, e cada cenário
exigido tem teste nominal (e contraparte PostgreSQL), conforme a matriz abaixo.

**P1-01 — PDV/Caixa** (`pdv-caixa-resumo.test.ts` · PG `pg/e424-…test.ts`):

| Cenário exigido | Teste (memória) | Contraparte PostgreSQL |
|---|---|---|
| A · venda em dinheiro | `(A): venda em dinheiro sem troco — movimento = total, resumo bate` | `P1-01 PG: o movimento de caixa é o líquido do troco e o fechamento bate no banco` |
| B · venda no cartão | `(B): venda no cartão não movimenta a gaveta` | idem (PG cobre formas e o líquido) |
| C · múltiplas formas | `(C): venda com múltiplas formas — cada movimento entra UMA vez` | idem |
| D · venda+pagamento → resumo | `(D): o resumo é derivado dos movimentos da venda + gaveta (venda a venda)` | idem + `E2E PG` |
| E · suprimento | `(E/F): suprimento e sangria movem a gaveta sem tocar no vendido` | idem |
| F · sangria | idem (E/F) | idem |
| G · estorno/cancelamento | `(G): venda cancelada sai do resumo e o estoque volta UMA vez` | `P1-01 PG: estorno devolve o estoque UMA vez e tira a venda do caixa` |
| H · fechamento | `(H): fechamento grava o esperado dos movimentos e a diferença contada` | `P1-01 PG: o movimento de caixa é o líquido…e o fechamento bate` |
| I · duas operações concorrentes | `(I): duas vendas simultâneas…` e `(I): dois fechamentos simultâneos — um vence, o outro é recusado` | `duas vendas simultâneas…` e `fechamento concorrente — exatamente um vence` |
| J · idempotência | `(J): ler o resumo não move dinheiro e repetir a venda não duplica movimento` | `idempotência — ler o resumo não move dinheiro e repetir a venda não conta duas vezes` |
| K · duas empresas (A e B) | `(K): caixas de empresas diferentes não se misturam (e B não opera o caixa de A)` | `multiempresa — o caixa de A não soma em B nem é operado por B` + `a cadeia inteira de A não aparece em B` |
| **L · a reprodução EXATA dos R$ 15,00** | `(L): venda de R$ 25,00 paga com R$ 30,00 (troco de R$ 15,00) — o resumo não superestima R$ 15,00` | idem (o PG exercita troco de 50 em 150) + `troco maior que o dinheiro recebido é recusado` |
| histórico legado (linhas gravadas antes da correção) | `(L/legado): linhas gravadas ANTES da correção (valor BRUTO, com troco) não reintroduzem a divergência` | `linhas LEGADAS (valor bruto, com troco) não reintroduzem a divergência` |
| rollback | — | `rollback — venda recusada não deixa rastro no caixa nem no estoque` |

**P1-03 — Fiscal → Expedição** (`fiscal-expedicao.test.ts` · PG `pg/e424-…test.ts`):

| Cenário exigido | Teste (memória) | Contraparte PostgreSQL |
|---|---|---|
| A/M · autorizada → separação → conferência → embalagem → expedição | `(M/A): NF autorizada entra em separação, confere, embala e expede — sem duplicar baixa` | `P1-03 PG: NF autorizada segue para separação → conferência → embalagem → expedição` |
| B · pendente bloqueia | `(B): documento fiscal PENDENTE bloqueia a expedição` | `documento PENDENTE bloqueia a expedição — nada muda no banco` |
| C · rejeitado bloqueia | `(C): documento REJEITADO bloqueia a expedição` | `documento REJEITADO bloqueia a expedição` |
| D · cancelado bloqueia | `(D): documento CANCELADO bloqueia a expedição` | `documento CANCELADO depois de autorizado bloqueia a expedição` |
| proteção preservada (faturada sem documento) | `venda faturada SEM documento fiscal continua bloqueada` | idem |
| autorização repetida | `(I): autorização repetida devolve o MESMO documento e não refatura` | `idempotência — autorização repetida e expedição repetida não duplicam nada` |
| expedição repetida / retry | `(I): expedição repetida não duplica estoque nem evento` | idem (dois reenvios → 409, sem baixa extra) |
| requisições simultâneas | `(J): duas expedições simultâneas — nunca duas baixas (memória)` | `duas expedições concorrentes — uma vence e a baixa acontece UMA vez` |
| refresh/resend | — | corridas com **reenvio** explícito do cliente após a rodada (0 vencedor ⇒ reenvio conclui; 1 vencedor ⇒ reenvio 409), sem segunda baixa |
| erro intermediário | `(K): conferência divergente aborta sem baixa e sem mudar a etapa` | `falha no meio da transição não deixa estado parcial` |
| rollback | idem (a etapa não avança e nada é gravado) | idem + `rollback — venda recusada não deixa rastro` |
| ordem inválida (sem embalar / sem conferir) | `(K): expedir sem embalar e embalar sem conferir são recusados sem efeito` | idem |
| sem segunda baixa (carimbo do documento) | `(A/B): status da venda revertido à mão NÃO refatura — o carimbo do documento manda` | `status da venda revertido à mão não provoca segunda baixa (carimbo do documento)` |
| N · venda `entregue` (outro status terminal) | `(N): venda ENTREGUE — com documento autorizado expede; sem documento continua bloqueada` | `venda ENTREGUE — com documento autorizado expede, sem documento é bloqueada` |
| modelo do documento (NFC-e 65) | — | `NFC-e (modelo 65) autorizada também libera a expedição — contrato atual` |
| L · multiempresa (A × B) | `(L): empresa B não opera a expedição de A (e a dela funciona)` | `multiempresa — B não opera a expedição de A` + `a cadeia inteira de A não aparece em B` |
| auditoria adversarial (caminhos alternativos) | — | `auditoria Q9 PG: o CRUD genérico não fura a proteção fiscal nem duplica o efeito` |

## 15. Migrações

**Nenhuma migração foi criada, alterada ou aplicada.** Nenhuma necessidade estrutural: `pdv_pagamentos`,
`pdv_caixa_movimentos`, `documentos_fiscais.estoque_baixado_em` (migration `0020`), `expedicao_etapa` e
`expedicao_eventos` já existiam. `db/schema.sql` e `prisma/schema.prisma` **não foram alterados** — nenhum
ajuste de banco foi feito “para satisfazer teste”. Rollback: não se aplica (nada a reverter além do código).

## 16. Arquivos alterados

| Arquivo | Tipo | Δ |
|---|---|---|
| `server/src/pdv.ts` | correção P1-01 | +93 / −7 |
| `server/src/expedicao.ts` | correção P1-03 | +125 / −13 |
| `server/test/pdv.test.ts` | ajuste do teste existente à regra líquida de troco | +13 / −4 |
| `server/test/pdv-caixa-resumo.test.ts` | novo (P1-01 A–L, matriz em §14.1) | 522 linhas |
| `server/test/fiscal-expedicao.test.ts` | novo (P1-03 A–M/N, matriz em §14.1) | 622 linhas |
| `server/test/golive-02-e2e.test.ts` | novo (E2E integrado) | 262 linhas |
| `server/test/pg/e424-golive-02-postgresql.test.ts` | novo (PostgreSQL real: P1-01, P1-03, E2E, multiempresa, auditoria CRUD) | 1022 linhas |
| `docs/RELATORIO-ERP-GOLIVE-02.md` | este relatório | novo |
| `docs/evidencias/erp-golive-02/*.log` | evidências ANTES/DEPOIS, gates, estabilidade e CI | 22 arquivos, 93 KB |

`git diff --stat` do código: **3 arquivos, +231 / −24**. Nenhum arquivo de UI, de schema ou de configuração foi tocado.

## 17. Fora do escopo — intocado

P1-02 (Marketplace), P1-04 (Melhor Envio), P2, P3, UX-04, Sidebar, Command Palette, CompanySwitcher, layout,
design, menu, módulos novos, Creators, BI, relatórios, arquitetura geral, integrações externas não relacionadas,
regras de produção, compras, cotação, cadastro e melhorias cosméticas: **nenhuma alteração**. O hub Commerce não
foi tocado. Nenhum problema novo foi “consertado” — o achado extra da auditoria está **documentado** em §18.

## 18. Riscos remanescentes

1. **R1 — CRUD genérico × venda com documento autorizado (documentado, não corrigido neste ciclo).**
   A sonda adversarial (`auditoria-crud-probe.log`, PostgreSQL real) prova:
   - `updateRecord(vendas, {status:'aberta'})` em venda faturada → **409** “Pedido faturado não pode voltar para
     aberto…” — **não existe caminho pela API** para reverter o faturamento;
   - repetir `status:'faturada'` pela API genérica → **sem efeito duplicado** (saldo 49, 1 movimento, 1 lançamento);
   - **porém**: se o `status` for alterado **direto no banco, fora do motor** (`UPDATE vendas SET status='aberta'`,
     o que a sonda fez via store cru), um PUT genérico `status:'faturada'` volta a aplicar o faturamento e produz
     **segunda baixa** (saldo 49 → 48, 2 movimentos).
   Alcance: exige **edição direta de banco** (ou script administrativo) fora de qualquer rota. Pela API o estado
   é inalcançável. A expedição já é robusta a esse estado (uma única baixa — teste PG dedicado). Corrigir o
   faturamento para consultar o carimbo do documento em `faturarVenda` tocaria um motor compartilhado por PDV,
   pedidos, expedição e autorização fiscal — **fora do escopo autorizado deste ciclo**, portanto documentado.
2. **R2 — `db:validate` bloqueado por rede no ambiente local.** Coberto e **verde** no CI do PR #60 (job `verificar`, PASS, 1m16s). O log bruto dos jobs é servido por blob storage do Azure, fora dos hosts acessíveis deste sandbox; a evidência aqui é a conclusão dos checks (`docs/evidencias/erp-golive-02/gate-ci-pr60.log`).
3. **R3 — Provedores fiscais são dublês de teste.** A autorização real em SEFAZ (produção) não foi homologada;
   o contrato idempotente do provedor foi exercitado (chave de idempotência por venda/modelo, 409 sem credencial,
   202 em rejeição).
4. **R4 — Fuso/relógio e arredondamento.** Os cálculos usam `round2` e tolerância de 0,009; nenhuma divergência
   de arredondamento apareceu nas 178 provas PG, mas valores-limite de terceiros (ex.: 0,005) não foram esgotados.
5. **R6 — Modelo do documento fiscal (contrato atual, documentado).** A trava da expedição exige documento
   **AUTORIZADO** sem restringir o modelo: uma **NFC-e (65)** autorizada também libera separação → conferência →
   embalagem → expedição (teste PG dedicado pina o comportamento). Restringir a expedição ao modelo 55 é
   **decisão de produto** e, por isso, ficou fora deste ciclo — nada foi alterado aqui.
6. **R5 — Concorrência sob SERIALIZABLE.** Rodadas podem terminar com **zero** vencedores (ambos abortam com
   40001→409). O sistema é idempotente e não duplica efeito, mas o operador pode precisar reenviar a operação.

## 19. Limitações

- Ambientes: MemStore (demonstração) **não** aprova P1-01 — a aprovação se apoia no PostgreSQL 16.14 real (§11).
- O `smoke` roda em modo demonstração (sem banco); o caminho com banco real é o `smoke:pg` (126/126).
- O E2E é de servidor (handlers/HTTP interno), não de navegador/UI: **nenhuma verificação de UX** foi feita.
- A suíte PG exige `DATABASE_URL` e **falha** (não é pulada) sem ele; no CI roda no job `testes-postgres`.
- Este relatório cobre **somente** P1-01 e P1-03.

## 20. Conclusão

As duas correções estão implementadas na origem, com reprodução ANTES registrada, evidência DEPOIS em MemStore
**e** em PostgreSQL real, provas de concorrência, de multiempresa e de idempotência, sem motor novo, sem
migração e sem tocar escopo negativo. Gates: `audit:menu`, `typecheck`, `npm test`, `build`, `smoke`, `test:pg`
(181/181), `smoke:pg` (126/126), `lint` e `git diff --check` **PASS**; `db:validate` **BLOQUEADO por rede**
localmente e declarado abertamente — no CI do PR #60 os jobs **`verificar` (1m16s) e `testes-postgres` (2m34s)
passaram**, cobrindo `prisma validate`, a suíte PostgreSQL real e o `smoke:pg`. Estabilidade comprovada em
rodadas consecutivas: memória 3× verde por suíte (14/14, 13/13, 1/1) e PostgreSQL 3× verde (22/22 · 22/22 · 22/22).

### Auto-auditoria adversarial (10 perguntas)

| # | Pergunta | Resposta | Base |
|---|---|---|---|
| 1 | Vender e receber duplica dinheiro no caixa? | **NÃO** | 1 pagamento por venda; resumo derivado venda a venda; PG real |
| 2 | O resumo bate com os movimentos reais? | **SIM** | `saldo inicial + entradas − saídas = saldo final` e `saldo calculado = soma dos movimentos válidos` em A–L |
| 3 | Venda de A aparece no caixa de B? | **NÃO** | testes PG multiempresa com `empresa_id` lido no banco |
| 4 | Requisições concorrentes duplicam dinheiro? | **NÃO** | rodadas concorrentes: ≤ 1 vencedor, perdedor 409, reenvio idempotente |
| 5 | NF autorizada chega à expedição? | **SIM** | o 409 foi reproduzido e eliminado; fluxo completo em memória e PG (inclusive na venda `entregue` e na NFC-e autorizada) |
| 6 | NF não autorizada continua bloqueada? | **SIM** | pendente/rejeitado/cancelado ⇒ 409; faturada **e entregue** sem documento ⇒ bloqueada |
| 7 | Repetir a tentativa duplica estoque? | **NÃO** | expedição repetida, autorização repetida e concorrentes: uma baixa, um evento |
| 8 | Uma empresa interfere na expedição da outra? | **NÃO** | B não opera A (404) e a cadeia de A não aparece em B |
| 9 | Existe caminho alternativo (CRUD genérico/rota interna) para furar a proteção? | **NÃO pela API** — o CRUD genérico reusa os motores e recebe 409 na reversão; `expedicao_etapa`/`nfe_*` são readonly; `documentos_fiscais` não é gravável. **Ressalva honesta:** com **escrita direta no banco** (fora do motor) é possível provocar segunda baixa via PUT genérico — **documentado em §18/R1**, inalcançável por rota |
| 10 | Tudo se comprova em PostgreSQL real? | **SIM** | 181/181 em banco novo, com estado lido direto nas tabelas e `empresa_id` conferido; 22/22 estável em 3 rodadas consecutivas |

**GO-LIVE NÃO DECLARADO.** A aprovação deste ciclo é externa e independente; nenhum merge foi feito.
