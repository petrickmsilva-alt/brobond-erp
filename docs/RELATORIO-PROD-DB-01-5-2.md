# PROD-DB-01.5.2 — Normalização controlada de Classe C

**Modo:** IMPLEMENTAÇÃO + TESTE + DOCUMENTAÇÃO.

> ## ⚠️ Esta implementação NÃO foi executada em produção.
> Nenhum `UPDATE` foi rodado contra o banco de produção. Nenhum `APPLY` foi
> executado. Nada foi alterado em Render, `DATABASE_URL` ou deploy. Este
> documento entrega a ferramenta administrativa e a sua prova; a autorização
> para execução em produção é uma etapa **posterior e separada**.

**Continuação direta de:** PROD-DB-01.5 (`docs/RELATORIO-PROD-DB-01-5.md`) e
PROD-DB-01.5.1 (mesmo artefato `005`, endurecido com o AFTER-CHECK fail-closed).

---

## 1. Motivação

O PROD-DB-01.5 entregou uma correção administrativa para a **classe B**
(divergência textual real: um local foi renomeado e o texto histórico ficou
defasado do nome canônico). Essa correção **aborta** diante de qualquer caso que
não seja classe B — inclusive a **classe C** (diferença apenas de caixa/espaço),
tratada como possível falso positivo.

A consulta direta em produção (PROD-DB-01.5, script
`db/admin/005-propagar-nomes-locais-e42.sql` em DRY-RUN) mostrou que **os 69
casos são todos classe C**:

```
modo_apply = off
confirmacao = off

E4.2/01.5 BEFORE nomes_locais_inconsistentes=69

estoques.local:       A=0  C=29  B=0
movimentacoes.local:  A=0  C=40  B=0
```

Todos os 69 casos:

| campo | valor |
|---|---|
| `empresa_id` | `1` |
| `local_id` | `3` |
| `texto_atual` | `"loja"` |
| `nome_canonico` (`locais.nome`) | `"LOJA"` |

Distribuição: `estoques.local` = 29, `movimentacoes.local` = 40 → **29 + 40 = 69**.
Nenhum caso de vínculo inválido, empresa divergente, `local_id` de outra empresa,
`NULL` indevido, divergência semântica ou diferença real de local.

Como a operação classe B **aborta** diante de classe C, era necessário um
mecanismo administrativo **explícito e separado** para a normalização cosmética.
É o que este ciclo entrega.

> Esta evidência **não autoriza** alteração em produção nesta tarefa. Ela define
> o caso que a implementação deve suportar.

---

## 2. Definição de Classe C

Classe C é definida **exclusivamente** quando, para um registro ligado a um local
canônico pela identidade relacional:

```sql
local_id = locais.id AND empresa_id = locais.empresa_id
```

o texto do registro difere do nome canônico **apenas por caixa e/ou espaços**:

```sql
lower(btrim(texto)) = lower(btrim(locais.nome))
AND texto IS DISTINCT FROM locais.nome
```

Exemplos que **são** classe C (cosméticos, normalizáveis):

| texto atual | nome canônico |
|---|---|
| `"loja"` | `"LOJA"` |
| `"Loja"` | `"LOJA"` |
| `" LOJA "` | `"LOJA"` |

Exemplos que **NÃO** são classe C (divergência semântica real → classe B):

| texto atual | nome canônico |
|---|---|
| `"LOJA"` | `"LOJA 2"` |
| `"LOJA"` | `"LOJA CENTRO"` |
| `"LOJA"` | `"ESTOQUE"` |
| `"LOJA"` | `"LOJA-01"` |

A distinção A/B/C do PROD-DB-01.4 é **preservada integralmente**. Nenhuma
normalização transforma diferença semântica em equivalente.

---

## 3. Mecanismo de autorização

O script administrativo `db/admin/005-propagar-nomes-locais-e42.sql` passa a
suportar **duas operações mutuamente exclusivas**:

| Operação | Classe tratada | Parâmetros exigidos no APPLY |
|---|---|---|
| **B** (inalterada) | divergência textual real | `-v apply=on -v confirmacao=PROD-DB-01.5` |
| **C** (nova) | diferença só de caixa/espaço | `-v apply=on -v confirmacao=PROD-DB-01.5.2 -v normalizar_classe_c=on` |

Regras:

- `apply=on` — habilita escrita (senão, DRY-RUN).
- `confirmacao` — chave textual **específica** de cada operação. A operação C
  **não** aceita a confirmação da B (`PROD-DB-01.5`) e vice-versa.
- `normalizar_classe_c=on` — **flag explícita** que autoriza tratar classe C.
  **Sem ela o script nunca normaliza classe C**: a diferença cosmética continua
  abortando, exatamente como no PROD-DB-01.5.
- Ausência de **qualquer** uma das três ⇒ `RAISE EXCEPTION` antes de qualquer
  `UPDATE`.
- B e C são **mutuamente exclusivas**: a operação C aborta se houver classe B; a
  operação B aborta se houver classe C. Nunca se mistura uma com a outra.

A flag é impossível de ativar por acidente: `normalizar_classe_c` é `off` por
padrão e só liga com o valor literal `on`.

---

## 4. Comportamento DRY-RUN (padrão)

Sem parâmetros de APPLY, **nenhum UPDATE** é feito e a transação termina em
`ROLLBACK`. A saída mostra claramente todos os contadores:

```
NOTICE:  E4.2/01.5 BEFORE nomes_locais_inconsistentes=69
NOTICE:  E4.2/01.5 origem=estoques.local A(vínculo/null)=0 C(caixa/espaço)=29 B(a corrigir)=0
NOTICE:  E4.2/01.5 origem=movimentacoes.local A(vínculo/null)=0 C(caixa/espaço)=40 B(a corrigir)=0
NOTICE:  E4.2/01.5 classificação: A=0 B=0 C=69 (B=divergência real; C=diferença só de caixa/espaço)
NOTICE:  E4.2/01.5 DRY-RUN: nenhuma escrita.
NOTICE:  E4.2/01.5 DRY-RUN contadores: classe_A=0, classe_B=0, classe_C=69,
         seria_corrigido_classe_B=0, seria_normalizado_classe_C=69, alterados=0
...
ROLLBACK
E4.2/01.5 DRY-RUN: transação revertida (ROLLBACK). Nenhum dado foi alterado.
```

Cobre o requisito de mostrar quantidade classe A, B, C, quantidade que seria
normalizada e quantidade efetivamente alterada (= 0).

---

## 5. Comportamento APPLY

### 5.1 Operação C (normalização classe C)

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
  -v apply=on -v confirmacao=PROD-DB-01.5.2 -v normalizar_classe_c=on \
  -f db/admin/005-propagar-nomes-locais-e42.sql
```

Cada `UPDATE` usa **identidade relacional** e a restrição cosmética:

```sql
UPDATE estoques e SET local = l.nome
  FROM locais l
 WHERE e.local_id = l.id
   AND e.empresa_id = l.empresa_id
   AND e.local IS DISTINCT FROM l.nome
   AND lower(btrim(e.local)) = lower(btrim(l.nome));
```

Idêntico para `movimentacoes.local`, `movimentacoes.local_destino` e
`inventarios.local`. **Nunca** há `UPDATE ... WHERE local = 'loja'`: o texto nunca
localiza registros.

### 5.2 Somente o campo textual é alterado

São preservados: `id`, `empresa_id`, `local_id`, `quantidade`, `produto`,
`tamanho`, movimentação, referência e **qualquer outra coluna**. Apenas o campo
textual do local é normalizado para `locais.nome`.

### 5.3 Operação B (inalterada)

A correção classe B permanece exatamente como no PROD-DB-01.5: mesma
confirmação (`PROD-DB-01.5`), mesma classificação, mesma pós-validação.

---

## 6. Guardas

| Guarda | Condição | Ação |
|---|---|---|
| **Órfão** | `local_id` aponta para local inexistente | `RAISE EXCEPTION` (aborta) |
| **Classe A** | `empresa_id` do registro ≠ do local, ou texto de local `NULL` | `RAISE EXCEPTION` (aborta) |
| **Classe A (cross-tenant)** | `local_id` pertence a outra empresa | `RAISE EXCEPTION` (aborta) |
| **Operação C vs B** | há casos classe B no APPLY C | `RAISE EXCEPTION` (aborta) |
| **Operação B vs C** | há casos classe C no APPLY B | `RAISE EXCEPTION` (aborta) |
| **Confirmação** | falta a confirmação específica | `RAISE EXCEPTION` (aborta) |
| **Flag C** | APPLY C sem `normalizar_classe_c=on` | não normaliza; classe C aborta |

Classe A **aborta mesmo no DRY-RUN** (exige revisão manual; nunca é resolvida por
nome). A operação B e a operação C abortam-se mutuamente apenas no APPLY — no
DRY-RUN o script reporta os contadores para permitir a decisão.

Não há **fallback textual**: o vínculo é sempre por `local_id + empresa_id`.

---

## 7. Pós-validação (fail-closed)

Depois dos `UPDATE`s e **antes** do `COMMIT`, o script reexecuta **todos** os
contadores relevantes do preflight E4.2 (migração 0030):

- `nomes_locais_inconsistentes` (as quatro parcelas exatas);
- `duplicatas_locais`, `duplicatas_padroes`;
- `duplicatas_saldos`, `duplicatas_itens_inventario`;
- `saldos_invalidos`;
- `vinculos_empresa`, `vinculos_locais`;
- `pdv_vinculos`, `pdv_nomes`;
- `refs_operacionais`.

Se **qualquer** contador for `> 0`: `RAISE EXCEPTION` ⇒ `ROLLBACK`. Nada é
persistido. `nomes_locais_inconsistentes = 0` isolado **não** basta — a
normalização pode revelar outro bloqueio (ex.: duas linhas de `estoques` com
`tamanho_id NULL` que, após normalizadas, viram duplicata de saldo).

---

## 8. Transação, rollback e idempotência

- **Transação única**: `BEGIN` no topo; `COMMIT` somente no caminho APPLY
  autorizado; qualquer erro/guarda ⇒ `ROLLBACK`. Nunca há execução parcialmente
  aplicada.
- **Defesa em profundidade no COMMIT**: o `COMMIT` depende da marca
  `e42.autorizado`, que o próprio bloco só liga ao concluir a pós-validação com
  sucesso. Sem a marca, o wrapper faz `ROLLBACK` mesmo com `apply=on`.
- **Idempotência**: `IS DISTINCT FROM` evita reescrever linhas já corretas. A
  primeira execução normaliza; a segunda executa **0 UPDATEs**, sem duplicação,
  sem alteração adicional, sem degradação.

---

## 9. Escopo de tabelas

Exatamente as estruturas do E4.2:

- `estoques.local`
- `movimentacoes.local`
- `movimentacoes.local_destino`
- `inventarios.local`

Nenhuma tabela nova, nenhuma coluna nova, nenhuma alteração de schema, nenhuma
migration de correção de dados. É uma **operação administrativa de dados**.

---

## 10. O que NÃO foi alterado

- **Migration 0030**: intacta. A regra E4.2 continua protegendo a integridade.
  Classe C **não** foi convertida em "ignorar". Depois da normalização
  administrativa, o banco naturalmente apresenta
  `nomes_locais_inconsistentes = 0` e a 0030 prossegue normalmente.
- **E4.2**: permanece ativo.
- **Boot**: nenhum caminho de boot (`db.ts`, bootstrap, migration runner,
  health/readiness, deploy) chama esta operação. Ela vive em `db/admin/`, fora da
  cadeia automática. O banco continua entrando em `DEGRADED` quando o E4.2
  encontra inconsistências; a decisão de corrigir é administrativa.
- **PROD-DB-01.5 / 01.5.1**: comportamento da operação B preservado; testes
  existentes continuam passando.

---

## 11. Testes

Novo teste PG (wrapper real via `psql`, banco descartável próprio):
`server/test/pg/prod-db-01-52-normalizacao-classe-c.test.ts`.

| Teste | Prova |
|---|---|
| 1 / 1b | DRY-RUN detecta e reporta classe C sem alterar nada (`alterados=0`) |
| 2 | APPLY sem confirmação → aborta, nada alterado |
| 3 | APPLY com confirmação 01.5.2 mas sem `normalizar_classe_c=on` → aborta (classe C protegida) |
| 3b | flag C com confirmação errada (`01.5`) → aborta |
| 4 | APPLY autorizado → normaliza só o texto; `id`/`empresa_id`/`local_id`/`quantidade` preservados |
| 5 | pós-validação: todos os preflight counters = 0 |
| 6 | idempotência: 2ª execução = 0 UPDATEs |
| 7 | classe A (texto `NULL`) → aborta, nada alterado |
| 8 | divergência semântica (`"LOJA 2"`) → classe B; não é classe C; não é alterada |
| 9 | rollback: falha no AFTER-CHECK (`duplicatas_saldos=1`) reverte tudo |
| 10 | cross-tenant (`local_id` de outra empresa) → aborta, nada alterado |

O teste executa o **arquivo SQL inteiro** pelo `psql` real, com o mesmo wrapper
`\if :apply / BEGIN / COMMIT / ROLLBACK` do operador — não reproduz a lógica em
TypeScript. Sem `DATABASE_URL` ele **falha** (não pula). Sem o binário `psql`,
ele se auto-pula localmente, mas o CI instala `postgresql-client-16`, de modo que
o gate **reprova qualquer skip**.

---

## 12. Cenário real Classe C (fixture)

A fixture do teste reproduz o cenário confirmado em produção:

- `locais.nome = "LOJA"`, um local canônico por empresa;
- `estoques.local = "loja"` (29 registros, empresa A) + 1 registro numa segunda
  empresa (empresa B) para provar o isolamento;
- `movimentacoes.local = "loja"` (40 registros).

Resultado observado:

| Passo | Estado |
|---|---|
| ANTES | `nomes_locais_inconsistentes = 70` (30 estoques + 40 movimentações); classe C = 70 |
| DRY-RUN | 0 escritas; contador permanece 70 |
| APPLY autorizado | `estoques.local=30, movimentacoes.local=40, ... (total=70)`; `COMMIT` |
| DEPOIS | `nomes_locais_inconsistentes = 0`; todos os preflight counters = 0 |
| 2ª execução | `0 UPDATEs` (idempotente) |

(Em produção o cenário confirmado é 29 + 40 = 69, todos `empresa_id=1`,
`local_id=3`, `"loja"` → `"LOJA"`.)

---

## 13. Limitações

- A execução local usa um **shim** de `psql` (o binário não está instalado no
  ambiente de desenvolvimento deste ciclo); o CI instala `postgresql-client-16` e
  roda o `psql` real. O comportamento provado é o do `psql` real.
- O teste usa um banco descartável próprio porque o wrapper abre transação
  explícita (não pode usar o banco da suíte).
- A operação **não** resolve classe A (exige revisão manual de `empresa_id`).
- `vendas.local_saida` **não** entra na regra E4.2 e **não** é tocado (achado F2,
  fora do escopo).
- Esta ferramenta **não** foi executada em produção.

---

## 14. Instruções seguras para execução administrativa futura

> **Somente após autorização explícita e com janela de manutenção.** Nada abaixo
> deve ser rodado sem aval.

1. **Backup/snapshot confirmado** do banco (restaurável). Sem isso, não prossiga.
2. **Diagnóstico BEFORE (read-only)**:
   ```bash
   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/diagnostico-e42-nomes-locais.sql
   ```
   Confirmar `nomes_locais_inconsistentes = 69` e a distribuição 29/40.
3. **DRY-RUN operação C**:
   ```bash
   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
     -v normalizar_classe_c=on -f db/admin/005-propagar-nomes-locais-e42.sql
   ```
   Exigir: `classe_A=0, classe_B=0, classe_C=69, seria_normalizado_classe_C=69,
   alterados=0`. Se `classe_A > 0` ou `classe_B > 0`, **parar** e revisar.
4. **APPLY operação C**:
   ```bash
   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
     -v apply=on -v confirmacao=PROD-DB-01.5.2 -v normalizar_classe_c=on \
     -f db/admin/005-propagar-nomes-locais-e42.sql
   ```
   Exigir: `atualizados: ... (total=69)`, `AFTER nomes_locais_inconsistentes=0`,
   `transação COMITADA`. Se aparecer `ERROR`/`ROLLBACK`, **nada** foi persistido.
5. **Diagnóstico AFTER (read-only)**: exigir `nomes_locais_inconsistentes = 0` e
   todos os contadores do preflight E4.2 em 0.
6. **Aplicar o DDL**: rodar o fluxo normal de bootstrap/migração para aplicar a
   0030. Confirmar que o banco sai de `degraded` para `ready`.
7. **Auditoria**: arquivar as saídas dos passos 2–5.

---

## 15. Arquivos entregues

| Arquivo | Tipo | Descrição |
|---|---|---|
| `db/admin/005-propagar-nomes-locais-e42.sql` | script administrativo | operação B (inalterada) + operação C (nova) com tríplice autorização |
| `server/test/pg/prod-db-01-52-normalizacao-classe-c.test.ts` | teste PG (wrapper real) | 11 provas via `psql` em banco descartável |
| `docs/RELATORIO-PROD-DB-01-5-2.md` | relatório | este documento |

> O identificador `01.5.2` refere-se ao mesmo artefato `005`, agora com a
> operação classe C. Não há migration nova; o arquivo continua fora de qualquer
> runner de migração.
