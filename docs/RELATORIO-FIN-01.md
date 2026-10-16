# RELATÓRIO FIN-01 — Correção de cálculo e persistência de parcelas

## 1. Finding original

**FIN-01 / P1-03 — parcelas zeradas/negativas e soma de parcelas que não fecha no
centavo.**

A auditoria forense provou que a materialização do plano de parcelas
(`reconciliarParcelasPedido`, `server/src/financeiro.ts`) calculava cada parcela
como `r2(total / n)` e jogava a diferença na última linha:

- `R$ 0,01` em `3x` produzia `[0,00, 0,00, 0,01]` — **duas parcelas zeradas**;
- `R$ 0,02` em `3x` produzia `[0,01, 0,01, 0,00]` — parcela final zerada;
- totais pequenos com muitas parcelas podiam gerar **valor negativo** na última;
- **MemStore e PostgreSQL divergiam**: o MemStore aceitava a parcela `0`, mas o
  `CHECK ck_lanc_fin_valor_positivo (valor > 0)` do PostgreSQL recusava — a
  regra dependia do banco para aparecer e o resultado mudava conforme o store.

O efeito prático: contas a receber/pagar com parcelas nulas ou inválidas,
divergência de comportamento entre ambientes e risco de erro de banco (constraint)
vazando como falha genérica em vez de uma resposta de negócio clara.

## 2. Rotas auditadas

O ponto de entrada do parcelamento é o financeiro de venda/compra, atingido por
qualquer caminho que materialize o lançamento:

| Origem | Caminho até `reconciliarParcelasPedido` |
|--------|-----------------------------------------|
| PDV (venda de balcão) | `POST /api/pdv/vendas` → `venderPdv` → `syncLancamentoVenda` |
| Faturamento de venda | `expedicao`/`fiscal` → `syncLancamentoVenda` |
| Marketplace | `marketplaceOperacional` → `syncLancamentoVenda` |
| Recebimento de compra | `POST /api/compras/:id/receber*` → `syncLancamentoCompra` |
| Edição genérica | `PUT/PATCH /api/vendas/:id` e `/api/compras/:id` → `updateRecord` → `sync*` |

## 3. Guard anterior

Não havia guarda de valor: a função apenas distribuía `total / n` e empurrava o
resíduo para a última parcela, sem validar que **cada parcela fosse > 0** nem
que o número de parcelas coubesse no total. A validação de `valor > 0` ficava a
cargo do `CHECK` do PostgreSQL (que é `NOT VALID`), o que fazia o MemStore e o
banco divergirem.

## 4. Root cause

1. Divisão em ponto flutuante (`total / n` + `r2`) sem trabalhar em **centavos
   inteiros** — a soma podia não fechar e o resíduo gerava zero/negativo.
2. **Ausência de validação de pré-condição**: `n` inteiro ≥ 1, `total > 0` e
   `total (em centavos) ≥ n`. Combinações impossíveis (ex.: `R$ 0,01` em `3x`)
   eram aceitas e produziam parcelas inválidas.
3. A falha acontecia **dentro/depois** do insert, deixando a regra dependente da
   constraint (`ck_lanc_fin_valor_positivo`) — divergência MemStore × PostgreSQL.

## 5. Guard canônico escolhido

`dividirParcelas(total, numeroParcelas)` — função pura, exportada, com regra
única reutilizada por **venda e compra**:

- valida `n` inteiro ≥ 1, `total > 0` e `totalCentavos ≥ n` **antes** de
  qualquer persistência (rejeita `HttpError` 400/422);
- trabalha **exclusivamente em centavos inteiros** (`Math.round(total * 100)`);
- distribui `base = floor(totalCentavos / n)` e joga o resíduo nas **últimas**
  parcelas, garantindo `Σ parcelas === total` sem perder/ganhar centavo e
  **nenhuma parcela ≤ 0**.

`materializarParcelas` aplica a mesma regra respeitando os detalhes do XML da
compra (duplicatas positivas mandam; a última fecha o total) e valida cada valor
antes de gravar.

## 6. Alterações realizadas

- `server/src/financeiro.ts`
  - **novo** `export function dividirParcelas(total, numeroParcelas): number[]`;
  - **novo** `dividirParcelasCentavos(totalCentavos, n)` — núcleo inteiro, única
    implementação da regra; `dividirParcelas` só converte entrada/saída;
  - **novo** `function materializarParcelas(total, n, detalhes): number[]` e
    `materializarParcelasCentavos(totalCentavos, n, detalhes)`;
  - `reconciliarParcelasPedido` passa a usar `materializarParcelas(total, n,
    detalhes)` e remove o cálculo `valorParcela = r2(total / n)` — o plano é
    validado **antes** do loop de gravação (atomicidade: nada sobra em falha).
  - **hardening FIN-01.1** (§18): detalhes tratados explicitamente, sem
    `find || index` ambíguo, com rejeição de valores não numéricos, duplicados e
    de somas que não fecham; normalização de `fin_parcelas` documentada.
- `server/test/fin01-parcelas.test.ts` (**novo**) — 40 testes de unidade
  (canônica + adversarial + persistência venda/compra + atomicidade + retry +
  desconto/juros/frete + detalhes do XML + limites/normalização de parcelas).
- `server/test/pg/fin01-parcelas-e2e.test.ts` (**novo**) — prova HTTP real +
  PostgreSQL (ver §10).

## 7. Endpoints afetados

Todos os que geram parcelas de contas a receber/pagar: `POST /api/pdv/vendas`,
`PUT/PATCH /api/vendas/:id`, `PUT/PATCH /api/compras/:id`, recebimentos de compra
e os fluxos de faturamento/marketplace. Nenhum contrato de API foi alterado para
os casos válidos; apenas os casos impossíveis passam a responder erro de negócio.

## 8. Matriz de validação (canônica)

| Entrada | Antes | Depois |
|---------|-------|--------|
| `100,00` em `3x` | `[33,33, 33,33, 33,34]` (ok) | `[33,33, 33,33, 33,34]` (Σ exata) |
| `0,10` em `3x` | `[0,03, 0,03, 0,04]` (ok) | `[0,03, 0,03, 0,04]` (Σ exata) |
| `0,02` em `2x` | `[0,01, 0,01]` (ok) | `[0,01, 0,01]` (ok) |
| `0,01` em `3x` | `[0,00, 0,00, 0,01]` ❌ | **422** — nenhuma parcela zerada |
| `0,02` em `3x` | `[0,01, 0,01, 0,00]` ❌ | **422** |
| total `0` / negativo | parcela inválida ❌ | **400/422** (rejeitado) |
| `n = 0` / negativo / fracionário | divisão inválida ❌ | **400** |
| `1,00` em `100x` | risco de negativo ❌ | `100 × 0,01` (Σ exata) |

## 9. Testes adversariais (unidade)

`server/test/fin01-parcelas.test.ts` — **40/40 verdes**. Cobrem: combinação
impossível (`0,01` em `2x`/`3x`/`100x`), `0,10` em `3x`, valores grandes
(`1.000.000` em `7x`), `1,00` em `100x`, determinismo, persistência venda e
compra, atomicidade (nada persistido na falha), retry sem duplicação (idempotência),
desconto/juros/frete embutidos, detalhes de duplicatas do XML, **ordem/lacunas**,
**duplicata de parcela**, **valor zero/negativo/não numérico**, **soma que não
fecha (acima ou 1 centavo abaixo)** e **normalização de `fin_parcelas`**
(0/negativo/NaN/ausente → 1x; fracionário trunca; teto 60x).

## 10. Teste HTTP real

`server/test/pg/fin01-parcelas-e2e.test.ts` sobe o **servidor real** contra um
**banco novo** e percorre `HTTP → requireAuth → POST /api/pdv/vendas →
venderPdv → transação → sincronizarParcelas → PostgreSQL`, sem `req.user`
injetado e sem memória:

- **A/B)** venda real de `R$ 100,00` em `3x` grava `[33,33, 33,33, 33,34]` no
  banco (`Σ = 100,00`, resíduo na última); todos os `total_parcelas = 3`.
- **C/D)** venda de `R$ 0,01` em `3x` → **422** e **nada persiste**
  (contagem de `vendas` e `lancamentos_financeiros` inalterada — rollback real).
- **D)** `SELECT count(*) ... WHERE valor <= 0` no banco = **0**.
- **E)** `PUT /api/vendas/:id` (retry do mesmo plano) mantém **3 parcelas, os
  mesmos ids `[1,2,3]`**, `Σ = 100,00` — sem duplicação.

Evidência (dentro do gate oficial, TAP):

```
ok 144 - FIN-01: parcelas válidas e exatas via HTTP real + PostgreSQL
#   A/B) venda #1 100,00 em 3x → [33.33,33.33,33.34] (Σ=100,00)
#   C/D) venda 0,01 em 3x → 422; vendas 1→1, lançamentos 3→3 (sem resíduo)
#   D) lançamentos com valor <= 0 no banco: 0
#   E) retry de reconciliação → 3 parcelas, mesmos ids [1,2,3], Σ 100.00
```

**Detalhes do documento (XML/NF-e) pelo mesmo stack (FIN-01.1):** o segundo teste
do arquivo prova o produtor **real** de `fin_parcelas_detalhes` — a importação de
NF-e — por `POST /api/suprimentos/compras/importar-xml`:

```
ok 145 - FIN-01: detalhes do XML (duplicatas) via HTTP real + PostgreSQL — válidos e inconsistentes
#   detalhes válidos) XML 300,00 em 3 dup [100,100,100] → compra #1, [100,100,100], Σ=300,00
#   detalhes inconsistentes) XML 300,00 em 3 dup [100,100,99] → 422; compras 1→1, lançamentos 3→3, importações 1→1 (sem gravação parcial)
#   lançamentos com valor <= 0 no banco: 0
```

O caso inconsistente (`100/100/99`, **1 centavo abaixo**) responde **422** e
**nada grava**: a compra, a importação (`importacoes_nfe`) e os lançamentos ficam
inalterados (rollback total — a validação roda antes de qualquer insert).

## 11. PostgreSQL

Gate oficial do projeto (`npm run test:pg`, `scripts/test-pg-gate.mjs`) sobre um
**banco vazio novo** em **PostgreSQL 16.14**, com o reporter TAP (o mesmo que o
CI usa no Node 22):

```
ERP-03 GATE PASS: 197 testes PostgreSQL reais; 0 fail/skip/todo.
```

## 12. Typecheck

`npm run typecheck` (domain + server + client): **verde** (0 erros).

## 13. Lint

`npm run lint`: **0 erros**, 409 warnings — todas pré-existentes
(`@typescript-eslint/no-explicit-any`); nenhum warning novo nas linhas alteradas
de `server/src/financeiro.ts`.

## 14. Build

`npm run build` (client): **verde** (PWA gerado, `built in ~11s`).

## 15. Smoke

`npm run smoke` contra servidor real em modo demonstração: **126/126 verificações
OK** (inclui o fluxo de compra parcelada: “compra completa gera 3 contas a pagar”,
“soma das parcelas fecha no total 5400”).

## 16. Regressões

- Server (memória): **777 pass / 0 fail / 66 skipped** (skips pré-existentes).
- Client: **323 pass / 0 fail**.
- `audit:menu`: **sem erros** (menu × rotas × recursos × permissões × multiempresa
  coerentes; 1 aviso pré-existente sobre `/api/health` ser público).
- Gate PostgreSQL oficial: **197 pass / 0 fail / 0 skip / 0 todo**.

## 17. Residuals

Nenhum residual novo introduzido por este ciclo restrito.

## 18. Hardening FIN-01.1 (revisão independente do PR #67)

Após a revisão do PR #67, o materializador foi endurecido **sem mudar o contrato**
dos casos válidos. As fragilidades endereçadas:

| Achado da revisão | Antes | Depois |
|-------------------|-------|--------|
| Seleção do detalhe por parcela (`find` + fallback `detalhes[i-1]`) podia casar valor e vencimento de itens diferentes quando `parcela` estava ausente/fora de 1..N | ambíguo | `numeroDeParcelaDoDetalhe(detalhe, índice, n)` — mesma regra para valor **e** vencimento |
| Detalhe com valor **não numérico** (ex.: `"abacaxi"`) virava `NaN` e caía no canônico silenciosamente | adivinhação | **422** explícito |
| Detalhe com `parcela` **repetida** — valores conflitantes | último vencia | **422** explícito |
| Detalhes cuja soma **excedia** o total eram absorvidos pela última parcela (reinterpretação) | silencioso | **422** (`não fecha o total`) |
| Detalhes cuja soma ficava **1 centavo abaixo** eram corrigidos na última parcela | silencioso | **422** (`não fecha o total`) |
| Duas representações de centavos (reais↔centavos) em `dividirParcelas`/`materializar` | risco de dupla conversão | núcleo único `dividirParcelasCentavos`; conversão para reais só na saída |
| Normalização de `fin_parcelas` (0/negativo/NaN → 1x; fracionário trunca; teto 60x) era implícita | não documentada | explícita em `reconciliarParcelasPedido` e coberta por teste |

Casos válidos preservados: duplicatas positivas do documento continuam mandando,
com a **última parcela residual** fechando a soma; XMLs com formato BR (`"40,50"`)
seguem aceitos; lacunas usam a divisão canônica daquela parcela.

## 19. Out-of-scope

Conforme o escopo estrito do FIN-01, **não** foram tocados: SEC-04 (catálogo/RBAC),
rate limit público, portal XFF, token público de arquivos, auditoria Date/JSONB,
constraints `NOT VALID`, advisory locks, CORS, E2E de browser, fiscal, financeiro
além do parcelamento, UX, Commerce, marketplace, produção e estoque. Qualquer
outro achado foi apenas registrado, não implementado.
