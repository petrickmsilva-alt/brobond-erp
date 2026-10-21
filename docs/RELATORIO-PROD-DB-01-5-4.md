# PROD-DB-01.5.4 — Resolução das colisões de estoque de Classe C

**Modo:** INVESTIGAÇÃO + CORREÇÃO + TESTE + DOCUMENTAÇÃO.

> Nada foi executado em produção. Nenhum `UPDATE`/`DELETE` foi rodado contra o
> banco de produção. Nenhum `APPLY` foi executado em produção. Render,
> `DATABASE_URL` de produção e deploy não foram tocados. A migration `0030`
> **não** foi alterada. Nenhum merge foi feito.

**Branch:** `fix/prod-db-01-5-4-resolver-colisoes-estoque`
**Continuação direta de:** PROD-DB-01.5.3.1
(`docs/RELATORIO-PROD-DB-01-5-3.md`).

---

## 1. Problema

O PROD-DB-01.5.3.1 (pré-detecção de colisão do script 005) detecta corretamente,
na cópia de produção restaurada de `brobond-prod-2026-10-20.dump`, **16 colisões
de chave única na tabela `public.estoques`**, envolvendo **32 registros**.

Todos os pares têm:

| campo | valor |
|:------|:------|
| `empresa_id` | `1` |
| `local_id` | `3` |
| `produto_id` | o mesmo nos dois registros do par |
| `tamanho_id` | o mesmo nos dois registros do par |
| texto `local` | divergente **apenas por caixa**: `"loja"` × `"LOJA"` |
| `quantidade` | **diferente** (ex.: `9` × `1`) |

Exemplo (produto 5 / tamanho 1): `id 5 → "loja", quantidade 9` e
`id 139 → "LOJA", quantidade 1`.

### 1.1 Por que a normalização de classe C (005) não resolve

O `estoques` tem DUAS chaves de unicidade sobrepostas:

* a **canônica** (E4.2 / migration 0030):
  `(empresa_id, produto_id, tamanho_id, local_id)`;
* a **legada por texto** (schema-base / migration 0001):
  `(produto_id, tamanho_id, local)`, índice
  `estoques_produto_id_tamanho_id_local_key`.

As duas linhas de cada par apontam para o **mesmo `local_id`** — logo, pela chave
canônica são a MESMA célula de saldo; pela chave legada por texto são linhas
distintas. Normalizar `'loja' → 'LOJA'` (operação de classe C do script 005)
faria as duas linhas ocuparem a MESMA chave de texto e violaria a constraint —
que é exatamente o que o preflight do PROD-DB-01.5.3 detecta e recusa.

**Conclusão:** a colisão precisa ser resolvida (consolidada) **antes** da
normalização de classe C. É o objetivo deste ciclo.

---

## 2. Regra de consolidação — derivada do código/schema (não inventada)

| decisão | regra | origem |
|:--------|:------|:-------|
| **Chave de identidade** | `empresa_id + local_id + produto_id + tamanho_id` | índice único canônico `uq_e42_estoques_empresa_prod_tam_local_id` (0030) e `PgStore.canonicalStockCell` (`server/src/pgstore.ts`) |
| **Quantidade consolidada** | **SOMA** das quantidades do grupo | `estoqueGrade` (`server/src/estoque.ts`) já **soma** `quantidade` (e `estoque_min`) de todas as linhas da mesma célula produto × tamanho antes de exibir. `estoques` é um saldo que **agrega** |
| **Linha sobrevivente** | a de **menor `id`** | precedente documentado na migration 0001: `DELETE FROM estoques a USING estoques b WHERE a.id > b.id ...` (mantém o menor id) |
| **Texto normalizado** | `locais.nome` do vínculo canônico | 0030: `estoques.local IS DISTINCT FROM locais.nome` é a inconsistência contada pelo preflight |
| **Histórico** | `movimentacoes` **não é tocada** | é a trilha imutável; `estoques` é saldo corrente (README: "saldo único por produto+tamanho+local") |

Nenhuma linha é criada. A consolidação **soma** o saldo da linha redundante na
sobrevivente e depois remove a redundante — nada de saldo é perdido e nenhum
movimento é apagado ou criado.

**Nenhuma FK aponta para `estoques.id`** (verificado em
`pg_constraint`/`confrelid`), então a escolha do id sobrevivente não quebra
integridade referencial.

---

## 3. Implementação

### 3.1 Ferramenta administrativa

`db/admin/006-consolidar-colisoes-estoque-classe-c.sql` — procedimento manual,
**nunca** executado pelo boot da aplicação (`server/src/db.ts` não o referencia).

Ordem de execução do bloco (uma transação explícita):

```
1.  BEGIN
2.  validar o parâmetro `apply` (token booleano conhecido)
3.  BEFORE: contar grupos em colisão pela chave canônica
4.  GUARDAS (abortam antes de escrever, inclusive no DRY-RUN):
      B.1  local_id órfão / de outra empresa
      B.2  texto NÃO cosmético em grupo em colisão (classe B)
      B.3  quantidade ou estoque mínimo negativo
5.  RELATÓRIO dos pares + ação prevista (dados reais, ordenação determinística)
6.  DRY-RUN: reporta e RETURN (ROLLBACK no wrapper) — nada escrito
7.  APPLY: exige apply=on + confirmacao=PROD-DB-01.5.4 + autorizacao=PROD-DB-01.5.4
8.  por grupo:
      8.1 DELETE por ID explícito E chave canônica completa (nunca cego)
      8.2 UPDATE da sobrevivente: soma + texto canônico
9.  AFTER: reexecuta os contadores do preflight E4.2 (0030) — fail-closed
10. se qualquer contador de integridade/colisão > 0: RAISE EXCEPTION ⇒ ROLLBACK
11. marca e42.autorizado=on ⇒ wrapper faz COMMIT
```

### 3.2 Wrapper verificado

`db/admin/run-006-e42.sh` — mesmo padrão do `run-005-e42.sh`: executa sempre o
arquivo 006 ao lado, recusa cópia defasada (sem `autorizacao`), recusa revisão
divergente e recusa arquivo que difere do `HEAD`.

### 3.3 Comandos

```bash
# DRY-RUN (padrão — não escreve nada)
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
  -f db/admin/006-consolidar-colisoes-estoque-classe-c.sql

# APPLY (tríplice autorização explícita; COMMIT ao final)
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
  -v apply=on -v confirmacao=PROD-DB-01.5.4 -v autorizacao=PROD-DB-01.5.4 \
  -f db/admin/006-consolidar-colisoes-estoque-classe-c.sql

# Wrapper verificado
DATABASE_URL=... db/admin/run-006-e42.sh                       # DRY-RUN
DATABASE_URL=... db/admin/run-006-e42.sh -v apply=on \
  -v confirmacao=PROD-DB-01.5.4 -v autorizacao=PROD-DB-01.5.4
```

### 3.4 O que o script NÃO faz

* **NÃO altera a migration 0030.**
* **NÃO roda no boot** da aplicação.
* **NÃO usa DELETE cego** — a remoção é por ID explícito + chave canônica.
* **NÃO identifica a linha pelo nome textual** — a junção é sempre por
  `local_id` + `empresa_id`.
* **NÃO inventa regra de negócio** — soma e escolha do menor id vêm do código e
  do precedente da migration 0001.
* **NÃO toca `movimentacoes`** (histórico).
* **NÃO faz merge automático** de saldos de classes divergentes (classe B
  aborta).

---

## 4. Relatório dos 16 pares (dados reais)

Reproduzidos em banco descartável (PostgreSQL 16.14) com o mesmo estado de
produção (`empresa_id=1`, `local_id=3`, `"loja"`×`"LOJA"`). O DRY-RUN emite, por
grupo, a ação prevista. Trecho (log completo em
`docs/evidencias/prod-db-01-5-4/dry-run.log`):

```
E4.2/01.5.4 BEFORE: chaves canônicas em colisão=16 linhas envolvidas=32
E4.2/01.5.4 RELATÓRIO DOS PARES (ação prevista por grupo):
  • empresa_id=1 local_id=3 produto_id=5  tamanho_id=1 | ids={105,205} locais={loja,LOJA} quantidades={9,1} | AÇÃO: manter id=105 com local=LOJA quantidade=10 (soma) estoque_min=0 ; remover ids={205}
  • empresa_id=1 local_id=3 produto_id=6  tamanho_id=1 | ids={106,206} locais={loja,LOJA} quantidades={9,1} | AÇÃO: manter id=106 com local=LOJA quantidade=10 (soma) estoque_min=0 ; remover ids={206}
  ...
  • empresa_id=1 local_id=3 produto_id=20 tamanho_id=1 | ids={120,220} locais={loja,LOJA} quantidades={9,1} | AÇÃO: manter id=120 com local=LOJA quantidade=10 (soma) estoque_min=0 ; remover ids={220}
```

A tabela completa dos 16 pares está em
`docs/evidencias/prod-db-01-5-4/before-pares.csv` (32 linhas) e o estado final em
`docs/evidencias/prod-db-01-5-4/after-pares.csv` (16 linhas).

---

## 5. Evidência BEFORE / AFTER

Banco descartável `prod54_evid` (bootstrap real `migrate()` + fixture dos 16
pares). Nenhum dado de produção.

| | linhas em `estoques` | colisões canônicas | `nomes_locais_inconsistentes` |
|:--|:--:|:--:|:--:|
| **BEFORE** | 32 | 16 | 16 |
| **AFTER (APPLY)** | 16 | 0 | 0 |

Exemplo (produto 5 / tamanho 1): `{105,"loja",9; 205,"LOJA",1}` →
`{105,"LOJA",10}` — **soma preservada** (`9+1=10`) e texto **normalizado**.

O APPLY registra:

```
E4.2/01.5.4 atualizados: sobreviventes=16, linhas_removidas=16 (grupos=16 )
E4.2/01.5.4 AFTER colisoes_canonicas_restantes=0 (fail-closed) contadores:
  nomes_locais_inconsistentes=0, duplicatas_locais=0, duplicatas_padroes=0,
  duplicatas_saldos=0, duplicatas_itens_inventario=0, saldos_invalidos=0,
  vinculos_empresa=0, vinculos_locais=0, pdv_vinculos=0, pdv_nomes=0,
  refs_operacionais=0
E4.2/01.5.4 APPLY: transação COMITADA.
```

---

## 6. Evidência de idempotência

Segunda execução do APPLY sobre o mesmo banco
(`docs/evidencias/prod-db-01-5-4/idempotencia.log`):

```
E4.2/01.5.4 BEFORE: chaves canônicas em colisão=0 linhas envolvidas=0
E4.2/01.5.4 atualizados: sobreviventes=0, linhas_removidas=0 (grupos=0 )
E4.2/01.5.4 AFTER OK: colisões canônicas=0, duplicatas_saldos=0, ...
```

Nenhuma linha é criada, alterada ou removida; a contagem permanece 16.

---

## 7. Checks do PROD-DB-01.5.3.1 reexecutados após a correção

O script 005 (PROD-DB-01.5.3.1) roda em seguida e **passa** — não há mais
colisão a detectar
(`docs/evidencias/prod-db-01-5-4/005-apos-006.log`):

```
E4.2/01.5 BEFORE nomes_locais_inconsistentes=0
E4.2/01.5 classificação: A=0 B=0 C=0
E4.2/01.5.3 preflight de colisão: índices únicos verificados=3, chaves em colisão=0, linhas envolvidas=0
E4.2/01.5.3 ... a normalização pode ser aplicada com segurança.
E4.2/01.5 AFTER OK: todos os contadores do preflight E4.2 = 0
```

Ou seja, a cadeia completa funciona: **006 consolida → 005 normaliza → preflight
E4.2 (0030) destravado**.

---

## 8. Testes PostgreSQL reais

`server/test/pg/prod-db-01-54-consolidar-colisoes.test.ts` (4 testes; executam o
**arquivo real** pelo `psql -f`, em bancos descartáveis próprios):

| # | Cenário | Resultado |
|--:|:--------|:----------|
| 1 | Os **16 conflitos** reproduzidos; DRY-RUN reporta e não escreve; APPLY **soma+normaliza+remove** (16→0); 2ª execução **idempotente** (0); o 005 normaliza a classe C depois | ✅ |
| 2 | Guarda de **classe B** (texto não cosmético) e identificação **por `local_id`** (nunca por texto) | ✅ |
| 3 | **ROLLBACK** fail-closed: falha na pós-validação (`duplicatas_saldos=1`) reverte TUDO; `movimentacoes` intactas | ✅ |
| 4 | **Wrapper** `run-006-e42.sh` fail-closed (sem `DATABASE_URL` e cópia defasada recusadas) | ✅ |

Cobertura explícita dos itens exigidos: 16 conflitos ✅ · quantidades diferentes
✅ · normalização ✅ · rollback ✅ · APPLY ✅ · segunda execução idempotente ✅.

---

## 9. Gates

| camada | comando | resultado |
|:-------|:--------|:----------|
| PostgreSQL | `npm run test:pg` | ver §9.1 |
| Memória | `npm --workspace server test` | ver §9.1 |
| Client | `npm --workspace client test` | ver §9.1 |
| typecheck | `npm run typecheck` | ver §9.1 |
| lint | `npm run lint` | ver §9.1 |
| build | `npm run build` | ver §9.1 |
| auditoria de menu | `npm run audit:menu` | ver §9.1 |
| smoke | `npm run smoke` | ver §9.1 |
| smoke PostgreSQL | `npm run smoke:pg` | ver §9.1 |

### 9.1 Resultado

_preenchido na seção de evidência de gates deste ciclo (ver `docs/evidencias/prod-db-01-5-4/`)._

---

## 10. Arquivos alterados/adicionados

| arquivo | mudança |
|:--------|:--------|
| `db/admin/006-consolidar-colisoes-estoque-classe-c.sql` | **novo** — consolidação das colisões de classe C (dry-run default, tríplice autorização, transacional, idempotente, guardas A/B, fail-closed) |
| `db/admin/run-006-e42.sh` | **novo** — wrapper verificado (recusa cópia defasada) |
| `server/test/pg/prod-db-01-54-consolidar-colisoes.test.ts` | **novo** — 4 testes PostgreSQL reais |
| `docs/RELATORIO-PROD-DB-01-5-4.md` | **novo** — este relatório |
| `docs/evidencias/prod-db-01-5-4/*` | **novo** — logs BEFORE/AFTER, DRY-RUN, APPLY, idempotência, 005 pós-006 |

`db/migrations/0030_e42_locais_estoque_multempresa.sql` **não foi alterada**.
Nenhum arquivo de boot foi alterado.
