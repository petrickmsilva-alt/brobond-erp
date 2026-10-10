# RELATÓRIO E4.2.2 — AUDITORIA DA EXPEDIÇÃO EM POSTGRESQL

> **Somente auditoria.** Nenhuma correção funcional foi implementada. Nenhuma migration, `schema.sql`, teste, workflow, CHECK, enum, estado, endpoint, transação, frontend ou gate foi alterado para fazer algo passar. Os defeitos abaixo estão **registrados e não corrigidos**.

---

## 1. Identificação

| Item | Valor |
|---|---|
| Repositório | `petrickmsilva-alt/brobond-erp` |
| Branch de trabalho | `arena/a13793a8-brobond-erp` |
| HEAD auditado | `ade61dd239a6eed2da43a2e13bfc8444395e1e24` (`Merge pull request #47`) |
| Base | `main` = `ade61dd` (confirmado: `git rev-parse main` e `HEAD` idênticos) |
| Commit `34de09e` | Existe no GitHub (`fix(stock): close e4.2.1 inventory integrity gaps`) e pertence ao PR #47, mergeado em `ade61dd` (`gh pr view 47`: `MERGED`, merge commit `ade61dd`). **Divergência local:** o clone do sandbox é *shallow* (1 commit visível), então o `34de09e` não aparece em `git log` local. Não é divergência de estado da `main`. |
| PR #46 | `E4.2: isolamento multiempresa dos fluxos de estoque` — **MERGED** em 2026-10-10T00:51:41Z (`gh pr view 46`). **Divergência documental:** `docs/ERP-GAPS.md` (linha ~20) e `docs/RELATORIO-E4.2.md` (linha ~92) dizem que o PR permanece aberto; o GitHub diz que foi mergeado. Registrado em AUD-13. |
| Data da auditoria | 2026-10-10 (UTC) |
| Objetivo | Auditar, com evidência, a máquina de estados da expedição, o gap `GAP-EXPEDICAO-ETAPA-PG` e os efeitos de transação, estoque, multiempresa, idempotência e concorrência. |
| Fora de escopo | `brobond-ai-commerce` — não acessado, não referenciado. |

**Ambiente de teste usado nesta auditoria**

- PostgreSQL **16.2** efêmero (binários do pacote PyPI `pgserver`, cluster em `/tmp/pgdata`, porta 55432, banco `brobond_teste`, usuário `brobond`). Mesma versão *major* do job `testes-postgres` do CI (`postgres:16`). Cluster destruído ao final.
- Dependências instaladas por `npm ci` a partir do `package-lock.json` (sem `npm audit fix`, sem upgrade).
- Scripts de reprodução ficaram **fora do repositório** (`/tmp/repro/`), conforme a regra de não alterar o código. Os comandos e os resultados estão nas seções 6 e 19.

---

## 2. Estado atual da expedição

**Arquitetura real (não é a descrita no gap):**

- Etapas ficam em `vendas.expedicao_etapa` (coluna `TEXT`, sem default no banco, `NULL` tratado como `pendente`).
- Cada transição grava uma linha em `expedicao_eventos` e, quando há divergência, em `divergencias_conferencia`.
- Há **duas rotas de conferência** no backend:
  1. **E4 (canônica para o frontend):** `POST /api/vendas/:id/expedicao/conferir` → `conferirPedido` (`server/src/expedicao.ts`).
  2. **Legada:** `POST /api/vendas/:id/conferir` e `POST /api/expedicao/packing-check` → `packingCheck` (`server/src/suprimentos.ts:636`). Não é usada pelo frontend, mas é roteada (`server/src/index.ts:484`, `:487`) e **não tem nenhum teste de servidor**.
- Faturamento pode ocorrer por três caminhos: `POST …/expedicao/expedir` (E4), `PUT /api/vendas/:id` com `status: 'faturada'` (CRUD genérico) e `packingCheck` (legado). Só o primeiro altera `expedicao_etapa`.

---

## 3. Máquina de estados encontrada

### 3.1 Valores reais, por camada

| Conceito | Valores aceitos pelo PostgreSQL | Valores gravados pelo código | Divergência |
|---|---|---|---|
| `vendas.expedicao_etapa` | `pendente, separacao, conferida, embalada, expedida` (+ `NULL`) | `pendente, separacao, conferida, embalada, expedida` | **Nenhuma** |
| `expedicao_eventos.etapa` | `separacao, conferencia, embalagem, expedicao` | `separacao`, `conferencia` (mapeado de `conferida`), **`embalada`**, **`expedida`** | **Sim — `embalada` e `expedida` não existem no CHECK** |
| `expedicao_eventos.resultado` | `ok, divergencia, erro` | `ok`, `divergencia` | Nenhuma |
| `movimentacoes.tipo` (saída da expedição) | (tipo `saida`) | `saida` | Nenhuma |

### 3.2 Matriz de rastreabilidade (Camada × Valor × Evidência)

| Camada | Valor | Evidência |
|---|---|---|
| PostgreSQL | `pendente, separacao, conferida, embalada, expedida` | `db/migrations/0024_p1_comercial_logistica.sql:513-516`; `db/schema.sql:2826-2829` |
| PostgreSQL | `separacao, conferencia, embalagem, expedicao` (**eventos**) | `db/migrations/0024_p1_comercial_logistica.sql:339-341`; `db/schema.sql:2652-2654` |
| PostgreSQL | `ok, divergencia, erro` (resultado) | `db/migrations/0024_p1_comercial_logistica.sql:342`; `db/schema.sql:2655` |
| Backend | `ETAPAS = ['pendente','separacao','conferida','embalada','expedida']` | `server/src/expedicao.ts:38-41` |
| Backend | grava `embalada` / `expedida` em `expedicao_eventos.etapa` | `server/src/expedicao.ts:85-87` (`avancarEtapa` → `registrarEvento(…, alvo === 'conferida' ? 'conferencia' : alvo, …)`); chamadas em `:319` (`embalagem`→`embalada`) e `:352` (`expedida`) |
| Backend | mapeamento implícito `conferida→conferencia` | `server/src/expedicao.ts:87` |
| Backend | leitura/validação de etapa | `expedicao.ts:80` (`atual`), `:343` (`!== 'embalada'`), `:371` (`!== 'conferida'`) |
| Backend | `resources.ts` (vendas) labels `pendente, separacao, conferida, embalada, expedida` | `server/src/resources.ts:1646-1657` |
| Backend | `expedicao_eventos` é `READ_ONLY`, `internal: true` | `server/src/resources.ts:2851-2858` |
| Backend (legado) | `packingCheck` grava `status: 'faturada'` **sem** tocar em `expedicao_etapa` | `server/src/suprimentos.ts:701` |
| Frontend | tipo `Etapa` e rótulos (`Pendente`, `Em separação`, `Conferida`, `Embalada`, `Expedida`) | `client/src/pages/ExpedicaoPage.tsx:19-35` |
| Frontend | filtros da fila (`pendente, separacao, conferida, embalada`) | `client/src/pages/ExpedicaoPage.tsx:84-90` |
| Frontend | botões: Separar (`pendente`), Conferir (`lidos.length`), **Embalar (`conferida`)**, **Expedir (`embalada`)** | `client/src/pages/ExpedicaoPage.tsx:446-455` |
| Frontend | chamadas: `/vendas/:id/expedicao/{separar,embalar,expedir}`, `/conferir`, `/expedicao/divergencias` | `client/src/pages/ExpedicaoPage.tsx:121, 175, 213` |
| Testes (memória) | `ETAPAS`, `proximaEtapa`, sequência completa, `embalada`/`expedida` | `server/test/expedicao.test.ts:66-79`, `:139-150`, `:218-222` |
| Testes (PG) | CHECK de `vendas.expedicao_etapa` (aceita `conferida`, recusa `voando`) | `server/test/pg-p1.test.ts:553-561` |
| Testes (PG) | **nenhum** teste grava `expedicao_eventos` com `embalada`/`expedida` | — (`grep` sem resultado em `server/test/pg*`) |
| Testes (frontend) | `ETAPAS` e rótulos com mock de API (não é PostgreSQL) | `client/src/pages/ExpedicaoPage.test.tsx:34, 93-94` |

**Conclusão da matriz:** o *modelo de estados da venda* é consistente entre PostgreSQL, backend, frontend e testes. A inconsistência está **somente** na tabela de **eventos**, que usa um vocabulário diferente e incompleto. Não há divergência em `vendas.expedicao_etapa`.

---

## 4. Máquina de estados reconstruída

```
                      separar                conferir (aprovada)          embalar                expedir
 pendente ─────────────────► separacao ─────────────────► conferida ─────────────► embalada ─────────────► expedida
  (NULL)                        │  ▲                          │                                            │
                                │  └── conferir reprovada ─────┘ (422, sem mudança de etapa)               status = faturada
                                │        grava divergencia_conferencia                                      (baixa + financeiro)
                                ▼
                            (cancelada / faturada: separar bloqueado com 409)

 Atalhos FORA da máquina de etapas (encontrados na auditoria):
   A) PUT /api/vendas/:id {status:'faturada'}      → baixa estoque, expedicao_etapa intocado
   B) POST /api/vendas/:id/conferir (packingCheck) → baixa estoque, status faturada, expedicao_etapa intocado
```

### 4.1 Transições (E4 canônico)

| Origem | Destino | Endpoint | Serviço | Estoque | Transação | Auditoria | Pré-condições | Evidência |
|---|---|---|---|---|---|---|---|---|
| `pendente`/NULL | `separacao` | `POST /api/vendas/:id/expedicao/separar` | `separarPedido` | Nenhum | `serializable`, `tryUpdateIf` (CAS) | Sim (`vendas`, `editar`) | Venda não cancelada/faturada/entregue; ≥1 item | `expedicao.ts:98-121`; `:79-95` |
| `separacao` | `conferida` | `POST …/expedicao/conferir` (lidos == pedido) | `conferirPedido` | **Nenhum** ("baixa no faturamento") | `serializable` | Sim | Código de barras em todos os itens; leitura byte a byte | `expedicao.ts:222-313` |
| `separacao`/`conferida` | (sem mudança) | `POST …/expedicao/conferir` (divergente) | `conferirPedido` | Nenhum | 1ª tx aborta; **2ª tx grava divergência** | Sim (`editar`, `divergencia`) | — | `expedicao.ts:266-306` |
| `conferida` | `embalada` | `POST …/expedicao/embalar` | `embalarPedido`→`avancar` | Nenhum | `serializable` | Sim | Etapa exatamente `conferida` | `expedicao.ts:319, 364-377` |
| `embalada` | `expedida` (+ `faturada`) | `POST …/expedicao/expedir` | `expedirPedido` | **Saída** via `aplicarRegrasPedido` (`venda_id`, `local_id`) | `serializable` | Sim (faturamento + etapa) | Etapa exatamente `embalada`; status não faturada/cancelada | `expedicao.ts:329-357`; `itens.ts:370-381` |
| qualquer (≠ cancelada) | `faturada` | `PUT /api/vendas/:id` `{status:'faturada'}` | `updateRecord` (CRUD genérico) | **Saída** via `aplicarRegrasPedido` | `serializable` | Sim | Só alçada comercial (`podeComercial`) | `services.ts:650-662`, `:736-739` — **Atalho A** |
| qualquer (≠ cancelada/faturada) | `faturada` | `POST /api/vendas/:id/conferir` | `packingCheck` | **Saída** via `aplicarRegrasPedido` | `serializable` | Sim | Código de barras em todos os itens; leitura exata | `suprimentos.ts:636-…, :701-705` — **Atalho B** |
| `solicitada`→`autorizada`→`em_transito`→`recebida` (devolução) | — | `…/devolucoes/:id/{autorizar,rastreamento,receber}` | `autorizarDevolucao`, `registrarRastreamento`, `receberDevolucao` | Entrada só para item `bom` | `serializable` / `read committed` + `FOR UPDATE` na venda | Sim | Rastreamento obrigatório antes de receber | `expedicao.ts:604-786` |
| devolução → `recusada`/`cancelada` | — | `…/devolucoes/:id/{recusar,cancelar}` | `fecharDevolucao` | Nenhum | `serializable` | Sim | Não pode estar `recebida` | `expedicao.ts:788-807` |

### 4.2 Transições **não** existentes (confirmadas por teste ou código)

- `pendente → embalada` / `pendente → expedida` / `separacao → embalada`: recusadas com 409 (`expedicao.test.ts:139-150`, MemStore).
- `expedida → *`: nenhuma transição de volta; `embalar` de `embalada` → 409 (`proximaEtapa`, `expedicao.ts:43-50`).
- Cancelamento de pedido **não tem** endpoint próprio de expedição: ocorre pelo `PUT` genérico (`status: 'cancelada'`) com estorno em `aplicarRegrasPedido`. Estorno não foi auditado linha a linha nesta etapa (fora do núcleo da expedição).

---

## 5. Auditoria específica do `GAP-EXPEDICAO-ETAPA-PG`

| # | Pergunta | Resposta (com evidência) |
|---|---|---|
| 1 | Onde o PostgreSQL rejeita? | Na **inserção em `expedicao_eventos`**, constraint `expedicao_eventos_etapa_valida` (`db/schema.sql:2652`). Não na tabela `vendas`. |
| 2 | Qual valor foi tentado? | `embalada` (ao embalar) e `expedida` (ao expedir). Reproduzido: `23514`. |
| 3 | Qual constraint rejeitou? | `expedicao_eventos_etapa_valida` (SQLSTATE `23514`, check_violation). |
| 4 | Qual código gerou o valor? | `avancarEtapa` → `registrarEvento(…, alvo)` (`server/src/expedicao.ts:85-87`), chamado por `avancar` (`:319`) e `expedirPedido` (`:352`). |
| 5 | Qual endpoint? | `POST /api/vendas/:id/expedicao/embalar` e `POST /api/vendas/:id/expedicao/expedir`. |
| 6 | MemStore aceita? | **Sim.** MemStore não aplica CHECK. `memdb.ts` não valida enum/CHECK. |
| 7 | Testes MemStore passam? | **Sim.** `npm test`: servidor 670 pass / 0 fail; `expedicao.test.ts` e `e421-estoque.test.ts` passam. |
| 8 | Testes PG cobrem a mesma operação? | **Não.** Nenhum teste PG chama `embalarPedido` ou `expedirPedido`. `pg/e421-estoque-integridade.test.ts:75-77` **declara** que evita a expedição de propósito por causa deste defeito. |
| 9 | Existe diferença entre os modelos? | **Sim:** MemStore aceita tudo; PG recusa `embalada`/`expedida` em eventos. Ver §13. |
| 10 | A falha ocorre antes ou depois de estoque? | **Em `embalar`:** não há movimento de estoque. **Em `expedir`:** a falha ocorre **depois** de `tryUpdateIf` (status→faturada), `aplicarRegrasPedido` (baixa/comissão) e `syncLancamentoVenda` (financeiro), e **antes** do `COMMIT`. |
| 11 | A transação faz rollback completo? | **Sim** (verificado). `withTransaction` faz `ROLLBACK` em qualquer exceção (`server/src/db.ts:83-86`). Ver §7 e REPRO 2. |
| 12 | Existe risco de estado parcial? | **Não no caminho PG verificado.** Ver §7. |
| 13 | O frontend permite chegar até a operação? | **Sim.** `Embalar` habilita em `conferida` (`ExpedicaoPage.tsx:452`); `Expedir` habilita em `embalada` (`:455`). Como `embalada` é inalcançável no PG, **`Expedir` nunca é alcançável via API no PG**. |
| 14 | Há outros estados com o mesmo problema? | **Sim, por construção:** `expedicao_eventos` aceita 4 valores e o código grava 5 etapas (`separacao, conferencia, embalada, expedida` + `pendente` nunca gravado). Os 2 que falham são `embalada` e `expedida`. Os nomes de evento `embalagem`/`expedicao` no CHECK **não correspondem** a nenhum valor gravado — são vestígio do desenho original. |

### Impacto operacional no PostgreSQL

- Após `separar` e `conferir` aprovada, o pedido fica **preso em `conferida`**: `Embalar` retorna **HTTP 500** ("Erro interno do servidor"), porque `translatePgError` não traduz `23514` (`server/src/pgstore.ts:~93-141`, cai em `default → null`) e `toHttpError` vira 500 genérico (`server/src/services.ts:43-50`).
- **Nenhum pedido consegue chegar a `expedida` pelo fluxo de expedição no PostgreSQL.**
- O pedido **não fica corrompido**: a etapa permanece em `conferida` e nada é baixado (ver §7).

---

## 6. Reprodução do problema

### 6.1 Ambiente

- PostgreSQL 16.2 (`pgserver` 0.1.4 / PyPI), cluster efêmero em `/tmp/pgdata`, `127.0.0.1:55432`, `brobond_teste`.
- Node v22.22.3, npm 10.9.8, dependências de `package-lock.json`.
- Driver `pg` do repositório (`node_modules/pg`).

### 6.2 Gate oficial `npm run test:pg` (com `DATABASE_URL` apontando para o PG acima)

```
DATABASE_URL=postgresql://brobond:brobond@127.0.0.1:55432/brobond_teste npm run test:pg
# tests 101 · pass 101 · fail 0 · skipped 0 · todo 0 · exit 0
```

Resultado: **PASS (101/101)**. Esta suíte **não** exercita a expedição (ver §17). Por isso passar aqui não contradiz o gap.

### 6.3 REPRO 1 — fluxo real separar → conferir → embalar

Comando: `node --import tsx --test /tmp/repro/e422-expedicao-pg-repro.test.mts` (com `DATABASE_URL`), chamando os **handlers reais** de `server/src/expedicao.ts`.

| Campo | Valor observado |
|---|---|
| Input | 1 item, código de barras lido corretamente |
| Endpoint 1 | `POST …/expedicao/separar` → **200**, etapa `separacao` |
| Endpoint 2 | `POST …/expedicao/conferir` → **200**, etapa `conferida` |
| Estado antes | `venda.expedicao_etapa=conferida`, `status=aberta`, eventos: `separacao(ok)`, `conferencia(ok)`, movimentações da venda = 0 |
| Operação | `POST …/expedicao/embalar` |
| Erro PostgreSQL bruto | `code=23514`, `constraint=expedicao_eventos_etapa_valida`, `new row for relation "expedicao_eventos" violates check constraint` |
| Resposta HTTP do handler | **500** — `Erro interno do servidor` |
| Estado final | **Idêntico ao anterior**: `conferida`, `aberta`, eventos inalterados, 0 movimentações (rollback) |

### 6.4 REPRO 2 — `expedir` (estado forçado, para testar atomicidade)

Como a API não chega a `embalada` no PG, o estado foi **forçado por SQL** (`UPDATE vendas SET expedicao_etapa='embalada'`) **somente** para exercitar a transação de `expedirPedido`.

| Campo | Antes | Depois |
|---|---|---|
| `vendas.status` | `aberta` | `aberta` (rollback) |
| `vendas.expedicao_etapa` | `embalada` | `embalada` |
| Saldo do produto | 50 | **50** (nenhuma baixa persistida) |
| Linhas em `auditoria` | 340 | **340** |
| Movimentações da venda | 0 | 0 |
| Eventos da venda | 0 | 0 |
| Resposta HTTP | — | **500** `Erro interno do servidor` |

Resultado: **rollback completo** verificado — `assert` de saldo, auditoria e status passou.

### 6.5 Reprodução do erro bruto (sem handler)

```
INSERT INTO expedicao_eventos (...) VALUES (..., 'embalada', 'conferida', 'ok', ...)
→ 23514 expedicao_eventos_etapa_valida
```

### 6.6 Veredito

> **REPRODUZIDO** — PostgreSQL 16.2 real, handlers reais, `23514` em `expedicao_eventos_etapa_valida`, HTTP 500, sem estado parcial.

---

## 7. Atomicidade

### 7.1 Mecanismo

- `PgStore.transaction` → `withTransaction` (`server/src/db.ts:75-89`): `BEGIN ISOLATION LEVEL SERIALIZABLE` (ou `READ COMMITTED` em `criarDevolucao`/`receberDevolucao`), `COMMIT` no sucesso, `ROLLBACK` em **qualquer** exceção.
- `audit()` recebe o mesmo `tx` (`expedicao.ts:94-101`), então a trilha faz parte da transação.
- `MemStore.transaction` (`memdb.ts:128-136`) restaura um **snapshot** em erro — equivalente em resultado, não em isolamento (ver §13).

### 7.2 Sequência por operação (PG)

| Operação | Ordem dentro da transação | Falha em | Estado final |
|---|---|---|---|
| separar | `assertVenda` → itens → `tryUpdateIf(etapa)` → evento → audit | evento | rollback total |
| conferir aprovada | `assertVenda` → itens → produtos → `avancarEtapa` (CAS + evento + audit) | evento | rollback total |
| conferir reprovada | **tx1:** só leitura, retorna `reprovada` → **tx2:** `INSERT divergencias_conferencia` + evento + audit | `INSERT` (22P02, ver AUD-02) | tx1 não tinha escrita; **nenhuma divergência gravada**, HTTP 400 |
| embalar | `assertVenda` → checagem → `tryUpdateIf(etapa)` → **evento (23514)** → audit | evento | **rollback total** (REPRO 1) |
| expedir | `assertVenda` → checagens → `tryUpdateIf(status→faturada)` → `aplicarRegrasPedido` (baixa, comissão) → `syncLancamentoVenda` → `avancarEtapa` → **evento (23514)** | evento | **rollback total** (REPRO 2) |

### 7.3 Pontos de atenção

- **Divergência intencionalmente fora da transação abortada** (`expedicao.ts:254-258`): a 1ª tx não lança exceção (para não desfazer a divergência). Isso é um desenho correto, mas a **2ª tx não tem tratamento próprio**: se ela falhar (como ocorre no PG — AUD-02), a divergência **não** é registrada e a resposta vira 400 genérico. Não há estado parcial, mas há **perda do registro de auditoria**.
- **Erro sem tradução:** `translatePgError` não cobre `23514`/`22P02` de forma útil; o usuário vê "Erro interno do servidor" (AUD-01) ou "Valor inválido em um dos campos" (AUD-02, sem indicar o campo).
- **Estado parcial possível? Não encontrado** nos caminhos E4 com PostgreSQL. **Estado parcial real encontrado** nos atalhos A/B (AUD-03/04): o pedido vai a `faturada` com `expedicao_etapa` `NULL`/`pendente` — é **inconsistência de máquina de estados**, não de transação (a transação está íntegra, só o caminho é que pula etapas).

---

## 8. Estoque

### 8.1 Movimentos por operação

| Operação | Entrada | Saída | Reserva | Movimentação gravada | Idempotência |
|---|---:|---:|---:|---|---|
| Separação | 0 | 0 | 0 | Nenhuma | Por estado (409 se repetida) |
| Conferência aprovada | 0 | 0 | 0 | Nenhuma ("baixa no faturamento") | Por estado |
| Conferência reprovada | 0 | 0 | 0 | Nenhuma (`expedicao.ts:307-309` declara) | **Nenhuma** — cada repetição grava nova divergência |
| Embalagem | 0 | 0 | 0 | Nenhuma | Por estado |
| **Expedição** | 0 | **Σ itens** | 0 | `movimentacoes` `tipo=saida`, `venda_id`, `local_id`, `motivo='Venda #id'` (`itens.ts:370-381`) | Por estado (`faturada` + etapa) |
| Cancelamento (PUT genérico) | ~ | estorno | 0 | Estorno via `aplicarRegrasPedido` (não auditado linha a linha) | Por status |
| Recebimento de devolução | Σ itens `bom` | 0 | 0 | `movimentacoes` `tipo=entrada`, `venda_id`, `motivo='Devolução #id — Venda #id'` (`expedicao.ts:~746-757`) | Por status (`recebida` → 409) |
| Atalho A (PUT `faturada`) | 0 | Σ itens | 0 | Mesma saída, **sem** etapa | Por status |
| Atalho B (`packingCheck`) | 0 | Σ itens | 0 | Mesma saída, **sem** etapa | Por status |

### 8.2 Reserva

- **Não há reserva.** `politicas_comerciais.reserva_horas` é só campo (`GAP-ESTQ-RESERVA`, já registrado). Logo a expedição **não** reserva estoque entre separação e expedição: duas vendas podem separar o mesmo saldo e só a segunda falha na baixa. Isso é coerente com o gap existente, mas significa que **a separação não garante disponibilidade**.

### 8.3 Efeitos colaterais verificados no REPRO

- REPRO 3 (atalho A): saldo `50 → 49` e `movimentacoes_da_venda = 1` sem nenhuma linha em `expedicao_eventos`.
- REPRO 5a (atalho B): saldo `5 → 3` para 2 unidades, `status=faturada`, `expedicao_etapa=NULL`.

---

## 9. Relação com vendas

- `itens_venda` é a fonte do que separar, conferir e baixar (`expedicao.ts:~111, ~226`). `itens_venda` **não** tem FK composta `(empresa_id, id)` — já registrado na E4.2.1 como endurecimento futuro.
- **Rastreabilidade E4.2.1 (`movimentacoes.venda_id`) preservada na expedição:** a baixa em `itens.ts:370-381` grava `venda_id: Number(pedido.id)`. Verificado no REPRO 3: `movimentacoes_da_venda = 1` após o atalho A, e a saída de `expedir` usa o mesmo caminho. **Confirmado por código e por REPRO 3** (a saída pela rota E4 não foi observada no PG por causa do gap).
- `local_saida_id`: a baixa usa `local_id` canônico quando existe (`itens.ts:316-319`), com fallback para texto só em venda legada — comportamento E4.2.1 preservado.
- Devolução total: o estorno de venda cancelada depende de `quantidadeRecebidaPorItem` e é o caminho coberto por `e421-estoque-integridade.test.ts` (PG).
- **Não encontrado:** devolução sem `venda_id` na entrada. Toda `movimentacoes` de entrada de devolução carrega `venda_id`.

---

## 10. Multiempresa

### 10.1 Matriz por operação (leitura de código)

| Operação | Escopo do ator | Checagem de registro | Tabela filha | Resultado |
|---|---|---|---|---|
| `GET /vendas/:id/expedicao` | `escopoDe(actor)` | `assertVenda` (404 de outra empresa) | `WHERE empresa_id` em eventos, divergências, itens | ✅ |
| `POST …/separar` | idem | `assertVenda` | `WHERE empresa_id` em itens | ✅ |
| `POST …/conferir` | idem | `assertVenda`; produtos `WHERE empresa_id` | — | ✅ |
| `POST …/embalar` | idem | `assertVenda` | — | ✅ |
| `POST …/expedir` | idem | `assertVenda`; `aplicarRegrasPedido(…, escopo)` | — | ✅ |
| `GET /expedicao/divergencias` | `WHERE empresa_id` | — | — | ✅ |
| `POST /expedicao/divergencias/:id/resolver` | idem | `assertRegistroDaEmpresa` | — | ✅ |
| `POST /devolucoes` | idem | `travarVendaParaDevolucao` com `empresa_id` (`expedicao.ts:426-435`) | `comprometidoPorItem` `WHERE empresa_id` | ✅ |
| `…/devolucoes/:id/{autorizar,receber,recusar,cancelar,rastreamento}` | idem | `assertRegistroDaEmpresa` | — | ✅ |
| `POST /vendas/:id/conferir` (legado) | idem | `assertRegistroDaEmpresa` (`suprimentos.ts:~649`) | itens `WHERE empresa_id` | ✅ |
| `PUT /vendas/:id` (CRUD genérico) | idem | `updateRecord` → `assertRegistroDaEmpresaParaEscrita` + `validarReferenciasDaEmpresa` | — | ✅ (não testado para `status`) |
| `PUT /divergencias_conferencia/:id` (CRUD genérico) | idem | idem | — | ⚠️ aceita `venda_id` de outra referência (AUD-06); cruzamento entre empresas **não testado** |

### 10.2 Proteções no banco

- Trigger `brobond_herdar_empresa` (`db/schema.sql:1667-1685`) aplicado a `expedicao_eventos` e `divergencias_conferencia` (`0024:568-569`): **sobrescreve** `empresa_id` pelo da venda-pai em `INSERT/UPDATE`. Isso protege mesmo se a aplicação passar um `empresa_id` errado.
- `expedicao_eventos` **não** tem FK composta `(empresa_id, venda_id)` — depende do trigger.
- `movimentacoes` tem FK composta `(empresa_id, venda_id)` (`0031`; `schema.sql:3990`) — recusa venda de outra empresa com `23503` (provado por `pg/e421-estoque-integridade.test.ts`).

### 10.3 Pontos de atenção (defesa em profundidade)

- `tryUpdateIf` (`pgstore.ts:388-410`) e `update` (`pgstore.ts:338-…`) **não** incluem `empresa_id` no `WHERE`. Todos os chamadores da expedição recebem o ID de uma leitura já escopada, então hoje não há exploração (AUD-11).
- `fallback para empresa padrão`: `pgstore.ts` usa `EMPRESA_PADRAO` quando `empresa_id` é nulo em algumas leituras de produto (`pgstore.ts:~61-64`). Não afeta a expedição diretamente, mas não foi auditado por completo.

**Resultado: nenhuma operação de expedição encontrada sem escopo de empresa.** Há um ponto de atenção no CRUD genérico de divergências (AUD-06).

---

## 11. Idempotência

| Endpoint | Idempotente? | Mecanismo | Risco |
|---|---|---|---|
| `POST …/separar` | Por estado | Repetição → 409 ("Não é possível passar de separacao para separacao") | Baixo (UX: erro em duplo clique) |
| `POST …/conferir` (aprovada) | Por estado | 409 na repetição | Baixo |
| `POST …/conferir` (reprovada) | **Não** | Cada repetição grava nova linha em `divergencias_conferencia` | Médio: inflação de divergências |
| `POST …/embalar` | Por estado | Repetição → 409 **no MemStore**; **500** no PG (AUD-01) | Alto no PG |
| `POST …/expedir` | Por estado | `status` já `faturada` → 409 | Baixo |
| `POST /devolucoes` | **Sim** | `idempotency_key` (header ou corpo) + índice único `uq_e421_devolucoes_empresa_idempotency (empresa_id, idempotency_key)` (`schema.sql:3982-3983`); replay → 200 `idempotente:true`; chave de outra venda → 409 | Baixo |
| `…/autorizar`, `…/rastreamento` | Por estado (`tryUpdateIf`) | 409 | Baixo |
| `…/receber` | Por status | `recebida` → 409 ("o estoque não sobe duas vezes") | Baixo |
| `…/recusar`, `…/cancelar` | Por status | 409 se `recebida` | Baixo |
| `POST /vendas/:id/conferir` (legado) | Por status | `faturada` → 409 | Baixo, mas sem teste |

**Não existe `idempotency_key` em nenhum endpoint de etapa da expedição.** Depende de CAS (`tryUpdateIf`) + checagem de etapa. É suficiente para evitar baixa dupla (a baixa só ocorre em `expedir`, que exige etapa `embalada` e status não faturado), mas não para evitar eventos duplicados em conferência reprovada.

---

## 12. Concorrência

| Cenário | Proteção encontrada | Teste existente | Veredito |
|---|---|---|---|
| Dois usuários avançam a mesma expedição | `tryUpdateIf` (CAS por etapa) + `SERIALIZABLE`; perdedor → `null` → 409 "O pedido mudou" (`expedicao.ts:86-88`) | **Nenhum** (PG) | Protegido por código; **não testado** |
| Duas conferências simultâneas | Idem (a aprovada passa por `avancarEtapa`) | Nenhum | Protegido por código; não testado |
| Duas embalagens | Idem | Nenhum | Idem |
| Duas expedições | Idem + `tryUpdateIf(status)` em `expedirPedido` (`:344-347`) | Nenhum | Idem |
| Expedição + cancelamento | `SERIALIZABLE` + CAS em `status`; estorno em `aplicarRegrasPedido` | Nenhum específico | Provável 40001 → 409 (`translatePgError`, `pgstore.ts:~97`); **não testado** |
| Expedição + devolução | Devolução exige `faturada/entregue` e trava a venda com `FOR UPDATE` | `pg/e421-estoque-integridade.test.ts` (devolução × devolução) | Coberto para devolução × devolução; **expedição × devolução não testado** |
| Retry da mesma requisição | Por estado (ver §11) | Nenhum | Seguro para baixa; ruim para conferência reprovada |
| Duas devoluções sobre o último saldo | `SELECT … FOR UPDATE` na venda (`expedicao.ts:426-435`) | ✅ `pg/e421-estoque-integridade.test.ts` (concorrência real) | Protegido e testado |
| Dois recebimentos da mesma devolução | Status + lock de venda | ✅ `pg/e421-estoque-integridade.test.ts` | Protegido e testado |

**Nenhum lock novo foi criado** (conforme regra). A proteção de expedição depende de `SERIALIZABLE` + CAS, que é correto em teoria, mas **não há nenhum teste de concorrência para expedição em PostgreSQL**.

---

## 13. MemStore × PostgreSQL

| Comportamento | MemStore | PostgreSQL | Divergência | Classe |
|---|---|---|---|---|
| CHECK de `expedicao_eventos.etapa` | Não aplica | Recusa `embalada`/`expedida` (23514) | **Sim** — impede o fluxo completo no PG | **P0** (AUD-01) |
| Gravação de `divergencias_conferencia` com arrays JS em `jsonb` | Aceita | Recusa (22P02) — driver serializa array como `{"000"}` | **Sim** — conferência reprovada não grava no PG | **P1** (AUD-02) |
| Rollback em erro | Snapshot restaurado | `ROLLBACK` real | Mesmo resultado observável | OK |
| Isolamento | Ignorado; sem mutex (`memdb.ts:128`) | `SERIALIZABLE` / `READ COMMITTED` | **Sim** — já registrado em `GAP-ESTQ-MEMSTORE-TX` (P2) | P2 (registrado) |
| `tryUpdateIf` | Sem checagem de empresa (`memdb.ts:388`) | Sem checagem de empresa (`pgstore.ts:388`) | Igual (defesa em profundidade) | P3 (AUD-11) |
| Trigger de herança de empresa | Substituído por `carimbarEmpresa` em código | Trigger no banco | Diferente mecanismo, mesmo resultado para o fluxo testado | P3 |
| Erro `23514` | Não existe | Traduzido para 500 genérico (`pgstore.ts` `default → null`) | Usuário vê 500 | P1 (parte de AUD-01) |
| `ETAPAS` e transições | Idênticas (mesmo código) | Idênticas | Nenhuma | — |
| Cadeia de auditoria | Em memória | `pg_advisory_xact_lock` + hash encadeado (`pgstore.ts:~520-530`) | Só PG é verificado | P3 |
| Atalhos A/B (faturar fora da etapa) | Mesmo comportamento | Mesmo comportamento (REPRO 3, 5a) | **Não divergem** — o problema é de modelo, não de banco | P1 (AUD-03/04) |

**Principal conclusão:** o MemStore **não reproduz** nenhum dos dois defeitos de PostgreSQL (AUD-01 e AUD-02). Por isso o CI em memória fica verde enquanto a expedição quebra no banco real.

---

## 14. Migrações

| Item | Evidência | Situação |
|---|---|---|
| Tabela `expedicao_eventos` criada | `0024_p1_comercial_logistica.sql:328-343` | ✅ |
| CHECK `expedicao_eventos_etapa_valida` criado | `0024:339-341` (espelhado em `schema.sql:2652-2654`) | ⚠️ **Vocabulário de evento incompatível com o código** |
| CHECK `vendas_expedicao_etapa_valida` | `0024:513-516` (espelhado em `schema.sql:2826-2829`) | ✅ Compatível |
| Coluna `vendas.expedicao_etapa` | `0024:510` (`ADD COLUMN IF NOT EXISTS`, sem default) | ✅ (NULL = pendente, tratado no código) |
| Alteração posterior do CHECK de eventos | `grep` em `db/migrations/*.sql`: **nenhuma** | Confirmado: nunca corrigido |
| `0026_producao_completa.sql` | Só cita `expedicao_eventos` em comentário (linha 163) | Sem efeito |
| `0031_e421_integridade_estoque.sql` | Adiciona `movimentacoes.venda_id` (rastreabilidade) | ✅ Não altera expedição |
| `migration ≠ schema.sql ≠ código` | Para os CHECKs de expedição, `schema.sql` e `0024` **são iguais**. O **código** é que diverge. | Divergência é **código × banco**, não migration × schema |
| Bootstrap em banco vazio | `npm run test:pg` aplicou `db/schema.sql` + todas as migrations em banco vazio, sem erro | ✅ Verificado (101/101) |
| Upgrade de banco com dados existentes | Não executado isoladamente nesta auditoria | ⚠️ Não verificado |

**Ordem de execução:** `migrate()` aplica `db/schema.sql` primeiro e depois as migrations (`server/src/db.ts:95-…`). Como `schema.sql` tem os mesmos CHECKs, o resultado é idêntico nos dois caminhos.

---

## 15. Dados legados

**Não medido.** Não há acesso a dados de produção nesta auditoria, e nada foi inventado.

Riscos identificados por código:

| Estado | Quem gera | Compatibilidade | Risco |
|---|---|---|---|
| `vendas.expedicao_etapa = NULL` | Vendas anteriores à 0024 e qualquer venda criada sem a coluna | Tratado como `pendente` (`expedicao.ts:80`, `:142`) | Baixo |
| `expedicao_eventos` com `etapa` fora do CHECK | **Impossível** no PG (CHECK recusa) | — | — |
| `vendas.expedicao_etapa IN ('embalada','expedida')` | Só por SQL direto (CRUD não escreve: campo `readonly`) | Seria aceito pelo CHECK de `vendas` | Médio se existir: pedidos "embalados" sem eventos |
| Venda `faturada` com `expedicao_etapa` ∈ {`NULL`,`pendente`,`separacao`,`conferida`} | **Atalhos A/B** (AUD-03/04) | Aceito por tudo | **Alto**: a trilha de expedição fica inconsistente com o status |
| Divergências com `venda_id`/`usuario_id` alterados | CRUD genérico (AUD-06) | Aceito | Médio para auditoria |

**Consultas somente-leitura sugeridas ao operador** (não executadas, para o dono do dado rodar em réplica ou banco de leitura):

```sql
SELECT COALESCE(expedicao_etapa,'(null)') etapa, status, count(*) FROM vendas GROUP BY 1,2 ORDER BY 1,2;
SELECT etapa, resultado, count(*) FROM expedicao_eventos GROUP BY 1,2;
SELECT count(*) FROM vendas WHERE status IN ('faturada','entregue') AND COALESCE(expedicao_etapa,'pendente') <> 'expedida';
SELECT count(*) FROM divergencias_conferencia WHERE resolvido_em IS NULL;
```

Os resultados determinam se há pedidos faturados fora da expedição em produção (ver decisão em §20).

---

## 16. Frontend

**Tela:** `client/src/pages/ExpedicaoPage.tsx` (rota `/expedicao`, módulo `Logística & Expedição`). A página **não** movimenta estoque por conta própria: delega ao servidor (comentário em `:8`).

| Ação | Condição de habilitação | Endpoint | Comportamento no PG |
|---|---|---|---|
| Iniciar separação | `etapa === 'pendente'` (`:446`) | `…/separar` | ✅ funciona |
| Conferir | `lidos.length > 0` (`:449`) — **não checa etapa** | `…/conferir` | ✅ aprovada; ❌ reprovada → 400 (AUD-02) |
| Embalar | `etapa === 'conferida'` (`:452`) | `…/embalar` | ❌ **500 sempre** (AUD-01) |
| Expedir | `etapa === 'embalada'` (`:455`) | `…/expedir` | ❌ **inalcançável no PG** (AUD-01) |

**Problemas de UX encontrados (P2/P3):**

- A mensagem exibida ao usuário quando `embalar` falha é **"Erro interno do servidor"** (vem de `toHttpError`), sem indicar que a causa é a configuração do banco. (AUD-08)
- O painel de leitura aparece também em `conferida` (`:465`), permitindo reconferir (→ 409 "Não é possível passar de conferida para conferida"). (AUD-08)
- Em conferência **reprovada** o frontend espera HTTP 422 e mostra "Divergência registrada (#id)" (`ExpedicaoPage.tsx:~218-226`). No PG a resposta é 400, então o usuário vê uma mensagem de "valor inválido" e **a divergência não existe**. (AUD-02)
- O frontend **não** usa as rotas legadas (`/conferir`, `/packing-check`) — o atalho B não é acessível pela tela, só pela API. (Verificado por `grep`.)
- Não há botão de faturar fora da expedição na tela de expedição; o atalho A existe na tela de **Vendas** (edição de status) — não auditada em detalhe.

**Telas de vendas e de divergências:** `modules.ts:216` lista `divergencias_conferencia` como módulo (CRUD genérico). Isso expõe o problema de AUD-06 na interface de administração.

---

## 17. Testes existentes

| Arquivo | Ambiente | O que cobre | Transições cobertas | Multiempresa | Concorrência | Idempotência | Rollback | Mock? |
|---|---|---|---|---|---|---|---|---|
| `server/test/expedicao.test.ts` | **MemStore** (`delete DATABASE_URL`, `:12`) | Máquina pura, `compararLeitura`, handlers reais | separar, conferir (ok/reprovada), embalar, expedir, recusas de pulo | ✅ `:532` (404 de outra empresa) | ❌ | ❌ | ❌ | Não (store em memória, sem mock de handler) |
| `server/test/e421-estoque.test.ts` | MemStore | Usa `embalarPedido`/`expedirPedido` como helper (`:83-92`) para criar saídas | expedir (indireto) | — | — | — | — | Não |
| `server/test/pg/e421-estoque-integridade.test.ts` | **PG real** | Devolução, FK 0031, PDV | **Nenhuma** de expedição; **evita de propósito** (`:75-77`) | ✅ (devolução/PDV) | ✅ devolução × devolução | ✅ devolução | ✅ (devolução) | Não |
| `server/test/pg-p1.test.ts` | **PG real** | CHECK de `vendas.expedicao_etapa` (`:553-561`), amarração P1 | Só o CHECK da venda | ✅ herança | ❌ | ❌ | ❌ | Não |
| `server/test/smoke.mjs` / `scripts/smoke-e2e.mjs` | HTTP real, modo demo | `GET /expedicao/divergencias` (`:145-146`) | **Nenhuma** transição | — | — | — | — | Não |
| `client/src/pages/ExpedicaoPage.test.tsx` | jsdom, **API mockada** | Botões, habilitação, chamadas, divergência (422) | Chamadas, sem servidor | — | — | — | — | **Sim** (`apiPost` mock) |
| `packingCheck` (`/vendas/:id/conferir`, `/expedicao/packing-check`) | — | **Nenhum teste** | — | — | — | — | — | — |

**Lacunas críticas**

1. **Nenhum teste PostgreSQL executa `embalar` ou `expedir`** — o defeito AUD-01 está fora do que o CI prova.
2. **Nenhum teste PostgreSQL executa uma conferência reprovada** — AUD-02 fica invisível.
3. **`packingCheck` não tem teste algum** — os atalhos B e a própria rota legada estão sem prova.
4. **Nenhum teste HTTP de expedição** — o smoke só consulta divergências.
5. O teste `pg/e421-estoque-integridade.test.ts` **contorna** o defeito (usa o PDV) — correto como decisão de escopo, mas deixa a expedição sem prova em PG.

---

## 18. Matriz de riscos

| ID | Problema | Severidade | Evidência | Impacto | Correção futura (não implementar agora) |
|---|---|---|---|---|---|
| **AUD-01** | `expedicao_eventos.etapa` não aceita `embalada`/`expedida`; expedição não completa em PG (`GAP-EXPEDICAO-ETAPA-PG`) | **P0** | REPRO 1, 2; `0024:339-341`; `expedicao.ts:85-87, 319, 352` | Bloqueia 100% da expedição em PG: `Embalar` → 500; `Expedir` inalcançável | Decidir vocabulário canônico (ver §20) e alinhar **CHECK + código** numa migration nova; **não** editar 0024. Teste PG do fluxo completo. Traduzir `23514` para erro de domínio. |
| **AUD-02** | Conferência reprovada não grava divergência no PG: arrays JS em colunas `jsonb` (`lido`, `esperado`, `faltando`, `sobrando`) são serializados pelo `pg` como literal de array | **P1** | Diagnóstico: `pg.prepareValue(['000'])` → `"{\"000\"}"`; `conferirPedido` → 400 `Valor inválido`; `SELECT count` = 0 | Registro de auditoria da conferência **perdido** no PG; mensagem enganosa; frontend espera 422 | Serializar `JSON.stringify` para colunas `json`/`jsonb` no `PgStore.insert/update` **ou** nos chamadores. Verificar **todos** os `insert` com array em `jsonb` (ex.: `suprimentos.ts:669`). Teste PG de conferência reprovada. |
| **AUD-03** | `POST /api/vendas/:id/conferir` (`packingCheck`) fatura e baixa estoque **sem separação/embalagem** e não altera `expedicao_etapa` | **P1** | REPRO 5a: `status=faturada`, `expedicao_etapa=NULL`, saldo 5→3; `suprimentos.ts:701-705`; sem teste | Dois caminhos de faturamento por conferência; ordem de controle pode ser pulada via API | Decidir se a rota legada é aposentada ou passa pela máquina de etapas; teste de servidor. |
| **AUD-04** | `PUT /api/vendas/:id {status:'faturada'}` (CRUD genérico) fatura e baixa estoque sem passar pela expedição | **P1** | REPRO 3: `pendente`→`faturada`, saldo 50→49, `expedicao_etapa=NULL`; `services.ts:650-662, :736-739` | Expedição pode ser contornada por qualquer usuário com permissão em `vendas`; inconsistência status × etapa | Decisão de produto: o "Faturar" da tela de Vendas é um caminho válido **fora** da expedição? Se não, restringir `status` a `faturada` para o endpoint de expedição. Medir pedidos existentes (§15). |
| **AUD-05** | Nenhum teste PG exercita expedição; CI verde com fluxo quebrado | **P1** | §17; `pg/e421-estoque-integridade.test.ts:75-77` | Defeitos P0/P1 passam no CI (`npm run test:pg` 101/101 com a expedição quebrada) | Teste PG HTTP-like da expedição completa (separar→conferir→embalar→expedir), inclusive conferência reprovada e rollback. **Não criar agora.** |
| **AUD-06** | Divergência editável pelo CRUD genérico: `venda_id`, `usuario_id`, `resolucao` são `writable` em `divergencias_conferencia` | **P2** | REPRO 4b: `venda_id` 40→41 via `updateRecord`; `resources.ts:~2876-2889` | Trilha de auditoria alterável; vínculo com pedido trocável | Tornar `divergencias_conferencia` append-only no CRUD (`ops.update` só para `resolucao` via endpoint dedicado). |
| **AUD-07** | Vocabulário de eventos diferente do de estados (`conferencia`/`embalagem`/`expedicao` × `conferida`/`embalada`/`expedida`) com mapeamento implícito | **P2** | `expedicao.ts:87`; `0024:340` | Causa raiz de AUD-01; facilita novas divergências | Uma única fonte de verdade (constante compartilhada `ETAPAS`) usada por código, CHECK e testes. |
| **AUD-08** | Frontend habilita `Embalar` em `conferida` (que dá 500 no PG), mostra "Erro interno" e mantém leitura em `conferida` | **P2** | `ExpedicaoPage.tsx:452, 465`; `toHttpError` | UX ruim; operador não sabe a causa | Após AUD-01: mensagem de erro de domínio; ajustar habilitação do painel de leitura. Sem redesenho. |
| **AUD-09** | Conferência **divergente** é aceita em qualquer etapa (inclusive `embalada`/`expedida`) e grava divergência + evento sem checar etapa | **P2** | Leitura de `conferirPedido`: checagem de etapa só na aprovação (`avancarEtapa`), não na divergência (`:266-306`). **Não reproduzido** em PG (bloqueado por AUD-02). | Registros de divergência fora de ordem; ruído na trilha | Checar etapa antes do ramo de divergência. Testar no MemStore e PG. |
| **AUD-10** | Operações de etapa sem `idempotency_key`; conferência reprovada não é idempotente | **P3** | §11 | Duplo clique gera 409 (UX) ou divergências duplicadas | Avaliar chave em conferência reprovada; manter CAS para etapas. |
| **AUD-11** | `tryUpdateIf` e `update` do `PgStore` não filtram por `empresa_id` no `WHERE` | **P3** | `pgstore.ts:338, 388`; `memdb.ts:388` | Sem exploração hoje (IDs vêm de leituras escopadas) | Incluir `empresa_id` no `WHERE` quando o recurso for multiempresa. |
| **AUD-12** | `receberDevolucao` marca `devolucao_estoque` com `find` por produto+tamanho: com linhas duplicadas, a flag pode cair no item errado | **P3** | `expedicao.ts:773` | Não reproduzido; risco de reentrada de estoque em devolução parcial com linhas repetidas | Marcar por `item.id`, não por busca de chave. |
| **AUD-13** | Documentação inconsistente: `ERP-GAPS.md` e `RELATORIO-E4.2.md` dizem que PR #46 "permanece aberto"; GitHub diz MERGED. `GAP-EXPEDICAO-ETAPA-PG` cita "falhou" num teste que hoje **evita** a expedição | **P3** | `gh pr view 46`; `ERP-GAPS.md:20, 244, 485-489`; `pg/e421…:75-77` | Proveniência da evidência pouco clara | Corrigir texto ao fechar o próximo ciclo (sem marcar gaps como resolvidos). |
| **AUD-14** | `vendas.expedicao_etapa` sem `DEFAULT` no banco, mas `resources.ts` declara `default: 'pendente'`; `NULL` legado | **P3** | `0024:510`; `resources.ts:1646-1649` | Inconsistência entre CRUD e banco; sem efeito funcional hoje | Padronizar na mesma migration de AUD-01 (sem backfill heurístico). |
| **AUD-15** | `criarDevolucao` usa `READ COMMITTED` enquanto as demais operações usam `SERIALIZABLE` | **P3** | `expedicao.ts:~568` vs `:333` | Protegido por `FOR UPDATE` na venda (testado); só registrar | Manter; documentar a escolha. |

**Contagem:** P0 = **1** · P1 = **4** · P2 = **4** · P3 = **6** (total 15).

---

## 19. Gates da auditoria

| Gate | Resultado | Detalhe |
|---|---|---|
| `npm test` | **PASS** (exit 0) | Servidor: **670 pass / 0 fail / 63 skipped** (os skips são os `pg-*.test.ts` que se auto-pulam sem `DATABASE_URL`, por desenho). Cliente: **226 passed / 22 arquivos**. |
| `npm run test:pg` | **PASS** (exit 0) | PostgreSQL 16.2 real: **101 pass / 0 fail / 0 skipped**. Migrations em banco vazio aplicadas. **Não cobre expedição** (AUD-05). |
| `npm run typecheck` | **PASS** (exit 0) | domínio + servidor + cliente. |
| `npm run lint` | **PASS** (exit 0) | ESLint em server, modules, packages, client, scripts. |
| `npm run build` | **PASS** (exit 0) | Build do cliente (Vite + PWA, precache 55 entradas). |
| `npm run smoke` | **PASS** — **126/126** | Servidor demo em `:3001`. Cobre apenas `GET /expedicao/divergencias` da expedição. |
| `npm run audit:menu` | **PASS** (exit 0) | "Sem erros". 6 avisos classificados, nenhum sobre expedição. |

Nenhum gate foi alterado, pulado ou reescrito. Nenhum teste foi marcado como `todo`.

### 19.1 Reproduções (scripts fora do repositório)

| Script | Resultado |
|---|---|
| `/tmp/repro/e422-expedicao-pg-repro.test.mts` — REPRO 1 | **PASS** (reproduz AUD-01 com erro bruto `23514`) |
| idem — REPRO 2 | **PASS** (rollback completo verificado) |
| `/tmp/repro/repro5.test.mts` — REPRO 5a / 5b | 5a **PASS** (reproduz AUD-03); 5b reproduz AUD-02 (`invalid input syntax for type json`, 0 divergências gravadas) |
| `/tmp/repro/e422-expedicao-pg-repro.test.mts` — REPRO 3 | Reproduz AUD-04 (saída `ok`, saldo 50→49) |
| `/tmp/repro/repro4b.test.mts` — REPRO 4b | Reproduz AUD-06 (`venda_id` 40→41) |

Os resultados acima foram observados no PG 16.2 efêmero. Para AUD-02, o caminho exato é `conferirPedido`: a 2ª transação falha com `22P02`, e a API responde **HTTP 400** `Valor inválido em um dos campos.`, sem linha em `divergencias_conferencia`.

---

## 20. Decisão de produto necessária antes da implementação

A correção de AUD-01 **não** exige decidir a regra de negócio, mas exige uma escolha de vocabulário. As opções são:

1. **Alinhar o CHECK de eventos ao vocabulário de estados** (`separacao, conferida, embalada, expedida`, mais `pendente` se houver evento inicial). Recomendado: é o vocabulário já usado pela API, pelo frontend e por `vendas`. Custa uma migration nova e uma decisão sobre eventos históricos (`conferencia`).
2. **Manter o CHECK e mapear no código** (`embalada → embalagem`, `expedida → expedicao`). Menor mudança de banco, mas mantém dois vocabulários (AUD-07).

Além disso, para AUD-03 e AUD-04 é preciso decidir: **o faturamento pode ocorrer fora da expedição?** Se a resposta for "não", os atalhos A e B devem ser fechados. Se for "sim" (ex.: venda de balcão), a expedição deve aceitar o pedido já faturado sem violar `expedicao_etapa`. Esta decisão depende das consultas de §15 e de quem usa a tela de Vendas.

---

## 21. Gaps novos ou atualizados

Registrados em `docs/ERP-GAPS.md` **sem marcar nenhum como resolvido**:

| Gap | Status | Origem |
|---|---|---|
| `GAP-EXPEDICAO-ETAPA-PG` | **CRÍTICO — confirmado** (reproduzido na E4.2.2; diagnóstico de E4.2.1 correto; a prova mencionada na E4.2.1 não está mais no teste — ver AUD-13) | §5, §6 |
| `GAP-EXPEDICAO-CONFERENCIA-PG` (novo) | P1 — aberto | AUD-02 |
| `GAP-EXPEDICAO-FATURAMENTO-FORA-DA-ETAPA` (novo) | P1 — aberto, aguarda decisão (§20) | AUD-03, AUD-04 |
| `GAP-EXPEDICAO-SEM-TESTE-PG` (novo) | P1 — aberto | AUD-05 |
| `GAP-EXPEDICAO-DIVERGENCIA-MUTAVEL` (novo) | P2 — aberto | AUD-06 |

---

## 22. Classificação resumida

| Severidade | Quantidade | IDs |
|---|---:|---|
| P0 | 1 | AUD-01 |
| P1 | 4 | AUD-02, AUD-03, AUD-04, AUD-05 |
| P2 | 4 | AUD-06, AUD-07, AUD-08, AUD-09 |
| P3 | 6 | AUD-10, AUD-11, AUD-12, AUD-13, AUD-14, AUD-15 |

---

## 23. Escopo explicitamente NÃO executado

```text
Nenhuma correção funcional foi implementada nesta etapa.
Nenhuma migration foi alterada.
Nenhum teste foi removido ou enfraquecido.
Nenhum workflow CI foi alterado.
Nenhum E4.3/E4.4/E4.5/E4.6 foi implementado.
```

Complementos:

- Nenhum CHECK, enum, estado, endpoint, serviço, transação, frontend, `schema.sql` ou dependência foi alterado. `npm audit fix`, upgrades e refactors não foram executados.
- Nenhum PR foi aberto, alterado, mergeado ou fechado.
- Nenhum dado de produção foi acessado ou modificado. Nenhum backfill foi feito.
- O cluster PostgreSQL efêmero e o servidor de demonstração foram encerrados. Os scripts de reprodução estão em `/tmp/repro/`, fora do repositório.
- O repositório não tem alterações além deste relatório e da atualização de `docs/ERP-GAPS.md`.
- O repositório `brobond-ai-commerce` não foi acessado.

---

## 24. Decisão final

### 🟡 AUDITORIA PARCIAL — EVIDÊNCIA INSUFICIENTE

**Motivos (específicos, não genéricos):**

1. **Dados de produção não auditados (§15).** Não há como medir quantos pedidos já estão `faturada` fora da expedição nem quantos estão em etapas legadas. Sem isso, a correção de AUD-03/04 não tem dimensão de impacto.
2. **Decisão de produto pendente (§20).** Não é possível definir a implementação de AUD-03/04 (faturamento fora da expedição) sem a resposta. A escolha do vocabulário de AUD-01 também precisa ser confirmada.
3. **Upgrade com dados não verificado (§14).** A migration corretiva futura precisa ser testada em banco com dados reais de pré-0024; aqui só foi testado banco vazio.

**O que está completamente caracterizado:** `GAP-EXPEDICAO-ETAPA-PG` (causa, constraint, endpoint, rollback, impacto), AUD-02 (causa raiz e reprodução), AUD-03/04 (reprodução e local exato).

Nada disso autoriza implementação antes da revisão do usuário. Conforme o prompt, o prompt de implementação deve ser criado separadamente após essa aprovação.

---

## 25. Próximo passo recomendado

1. **Revisar este relatório** e responder às duas perguntas de §20:
   - vocabulário canônico de eventos (opção 1 ou 2);
   - se o faturamento pode ocorrer fora da expedição (AUD-03/04).
2. **Rodar as consultas de §15** em réplica ou banco de leitura e enviar os resultados.
3. Depois disso, criar o **prompt de implementação separado** (E4.2.3), com escopo fechado: AUD-01 + AUD-02 + teste PG do fluxo completo (AUD-05), sem tocar em AUD-06 a AUD-15 nesse ciclo.

---

## Anexo A — Comandos executados

```bash
git status; git rev-parse HEAD main; git log --oneline -3          # HEAD confere
gh api repos/petrickmsilva-alt/brobond-erp/commits/34de09e         # commit existe no GitHub
gh pr view 47 --json state,mergeCommit ; gh pr view 46 --json state # PRs
npm ci --no-audit --no-fund                                        # dependências (lockfile)
DATABASE_URL=postgresql://brobond:brobond@127.0.0.1:55432/brobond_teste npm run test:pg
npm test ; npm run typecheck ; npm run lint ; npm run build ; npm run audit:menu
env -u DATABASE_URL PORT=3001 npx tsx src/index.ts &  ;  npm run smoke
cd server && DATABASE_URL=… node --import tsx --test /tmp/repro/e422-expedicao-pg-repro.test.mts
cd server && DATABASE_URL=… node --import tsx --test /tmp/repro/repro5.test.mts
cd server && DATABASE_URL=… node --import tsx --test /tmp/repro/repro4b.test.mts
```

## Anexo B — Arquivos lidos

`docs/ERP-MASTER-MAP.md` (contexto), `docs/ERP-GAPS.md`, `docs/RELATORIO-E4.1.md`, `docs/RELATORIO-E4.2.md`, `docs/RELATORIO-E4.2.1.md`, `server/src/expedicao.ts`, `server/src/suprimentos.ts` (trecho `packingCheck`), `server/src/itens.ts` (trechos), `server/src/services.ts` (trechos), `server/src/pgstore.ts` (trechos), `server/src/db.ts`, `server/src/memdb.ts` (trechos), `server/src/resources.ts` (trechos), `server/src/index.ts` (rotas), `server/src/validate.ts` (trecho), `db/migrations/0024_p1_comercial_logistica.sql`, `db/schema.sql` (trechos), `server/test/expedicao.test.ts`, `server/test/pg-p1.test.ts` (trecho), `server/test/pg/e421-estoque-integridade.test.ts` (trecho), `client/src/pages/ExpedicaoPage.tsx` (trechos), `client/src/pages/ExpedicaoPage.test.tsx` (trechos), `scripts/smoke-e2e.mjs` (trecho), `.github/workflows/ci.yml` (job `testes-postgres`).
