# PROD-DB-01.5 — Plano e execução controlada da correção dos 69 casos

**Modo:** PLANEJAMENTO + VALIDAÇÃO. **Nenhuma alteração foi feita no banco de
produção.** O script de correção é entregue pronto, mas **não foi executado
contra produção** neste ciclo.

**Contexto:** o PROD-DB-01.4 (`docs/RELATORIO-PROD-DB-01-4.md`) provou que o
preflight E4.2 (`db/migrations/0030_e42_locais_estoque_multempresa.sql`) bloqueia
o DDL por causa de 69 registros operacionais cujo **texto de local** está
defasado do **nome canônico** apontado por `local_id`:

| origem | quantidade |
|---|---|
| `estoques.local` | 30 |
| `movimentacoes.local` | 20 |
| `movimentacoes.local_destino` | 10 |
| `inventarios.local` | 9 |
| **Total** | **69** |

Todos classificados como **classe B** (dado historicamente válido que a regra
nova passou a recusar). A regra E4.2 **não** é alterada.

---

## 1. Objetivo e limites

Entregar um procedimento administrativo **explícito, auditado, reversível e
seguro** para propagar `locais.nome` aos textos históricos usando **sempre**
`local_id + empresa_id` — **nunca** por nome textual.

Restrições respeitadas:

1. Migração 0030 **não** alterada.
2. Preflight **não** removido.
3. Regra **não** relaxada.
4. **Sem** `MemStore`.
5. **Sem** correção automática no boot (o script não é migration).
6. **Sem** `UPDATE` em produção neste ciclo.
7. SQL/procedimento produzido primeiro.
8. Correção **reversível** (transação única; `ROLLBACK` por padrão) e precedida
   de **backup/snapshot confirmado** (ver §7).
9. Toda alteração **auditável** (`RAISE NOTICE` com BEFORE/AFTER e contagem por
   tabela).

---

## 2. Arquivos entregues

| Arquivo | Tipo | Descrição |
|---|---|---|
| `db/admin/005-propagar-nomes-locais-e42.sql` | script administrativo (não-migration) | DRY-RUN por padrão; APPLY com dupla confirmação; guardas; `BEGIN`/`COMMIT`/`ROLLBACK` |
| `server/test/pg/prod-db-015-correcao-nomes-locais.test.ts` | teste PG | prova 69→0, IDs inalterados, isolamento por empresa, A/C abortam, idempotência; roda em transação revertida |
| `docs/RELATORIO-PROD-DB-01-5.md` | relatório | este documento |

O script **não** é referenciado por nenhum runner de migração: a aplicação nunca
o executa. É um arquivo manual em `db/admin/`.

---

## 3. SQL de correção (APPLY)

Núcleo da correção — **junta por `local_id` + `empresa_id`, nunca por nome**.
Cada `UPDATE` só toca linhas cuja empresa é a mesma do local canônico:

```sql
-- estoques.local (30)
UPDATE estoques e SET local = l.nome
  FROM locais l
 WHERE e.local_id = l.id
   AND e.empresa_id = l.empresa_id
   AND e.local IS DISTINCT FROM l.nome;

-- movimentacoes.local (20)
UPDATE movimentacoes m SET local = l.nome
  FROM locais l
 WHERE m.local_id = l.id
   AND m.empresa_id = l.empresa_id
   AND m.local IS DISTINCT FROM l.nome;

-- movimentacoes.local_destino (10)
UPDATE movimentacoes m SET local_destino = l.nome
  FROM locais l
 WHERE m.local_destino_id = l.id
   AND m.empresa_id = l.empresa_id
   AND m.local_destino IS DISTINCT FROM l.nome;

-- inventarios.local (9)
UPDATE inventarios inv SET local = l.nome
  FROM locais l
 WHERE inv.local_id = l.id
   AND inv.empresa_id = l.empresa_id
   AND inv.local IS DISTINCT FROM l.nome;
```

Observações de schema (colunas reais, nada inventado):

- `estoques(local text NOT NULL, local_id integer, empresa_id integer)`.
- `movimentacoes(local text NULL, local_id integer, local_destino text NULL,
  local_destino_id integer, empresa_id integer)`.
- `inventarios(local text NOT NULL, local_id integer, empresa_id integer)`.
- As quatro colunas de texto alimentam exatamente as quatro parcelas do contador
  `nomes_locais_inconsistentes` da migração 0030. `vendas.local_saida` **não**
  entra na regra E4.2 e por isso **não** é tocada.

---

## 4. SQL de DRY-RUN

O DRY-RUN é o **comportamento padrão** do script: sem parâmetro explícito, ele
calcula tudo e faz `ROLLBACK`.

```bash
# DRY-RUN (padrão): não escreve NADA.
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
  -f db/admin/005-propagar-nomes-locais-e42.sql
```

Saída esperada (valores ilustrativos de produção; no teste reproduzido = 69):

```
NOTICE:  E4.2/01.5 BEFORE nomes_locais_inconsistentes=69
NOTICE:  E4.2/01.5 origem=estoques.local A(vínculo/null)=0 C(caixa/espaço)=0 B(a corrigir)=30
NOTICE:  E4.2/01.5 origem=inventarios.local A(vínculo/null)=0 C(caixa/espaço)=0 B(a corrigir)=9
NOTICE:  E4.2/01.5 origem=movimentacoes.local A(vínculo/null)=0 C(caixa/espaço)=0 B(a corrigir)=20
NOTICE:  E4.2/01.5 origem=movimentacoes.local_destino A(vínculo/null)=0 C(caixa/espaço)=0 B(a corrigir)=10
NOTICE:  E4.2/01.5 classificação: A=0 C=0 B=69 (todos classe B: correção segura)
NOTICE:  E4.2/01.5 DRY-RUN: nenhuma escrita. Seriam atualizados 69 registro(s) classe B.
NOTICE:  E4.2/01.5 DRY-RUN: para aplicar use -v apply=on -v confirmacao=PROD-DB-01.5
ROLLBACK
E4.2/01.5 DRY-RUN: transação revertida (ROLLBACK). Nenhum dado foi alterado.
```

---

## 5. Pré-condições

- PostgreSQL **16.14** (mesma versão do CI e da produção).
- Banco no estado **pré-0030** (o DDL da 0030 ainda bloqueado) — é justamente o
  sintoma que se quer resolver.
- `local_id` já presente nas tabelas (coluna aditiva; a 0030 a cria antes do
  preflight, e em produção ela existe).
- **Snapshot/backup confirmado** do banco (ver §7) — pré-requisito obrigatório.
- Janela de manutenção: aplicar com a aplicação parada ou em modo degradado
  (a 0030 bloqueada já deixa o banco degradado e as rotas de negócio barradas).

---

## 6. Pós-condições e critério de aceite

- `nomes_locais_inconsistentes = 0` (o próprio script verifica e **aborta** se
  não zerar; nesse caso a transação é revertida).
- `local_id` e `empresa_id` **inalterados** em todas as linhas.
- Nenhuma linha de outra empresa alterada.
- Com o contador em 0, o preflight E4.2 deixa de bloquear e o DDL da 0030
  (e o restante do `schema.sql`) pode ser aplicado.

---

## 7. Mecanismo de segurança

1. **DRY-RUN por padrão.** Sem `-v apply=on`, o script calcula, registra e faz
   `ROLLBACK`. Não há como escrever por acidente só rodando o arquivo.
2. **Dupla confirmação para APPLY.** Além de `-v apply=on`, exige
   `-v confirmacao=PROD-DB-01.5`. Faltando qualquer um, o script **aborta** antes
   de qualquer `UPDATE`.
3. **Transação única.** `BEGIN` no topo; `COMMIT` **somente** no caminho APPLY;
   qualquer erro/guarda ⇒ `ROLLBACK`. Se o contador não zerar, o script levanta
   exceção e a transação é revertida — nada fica pela metade.
4. **Guardas que abortam** (nada é alterado):
   - **órfão**: `local_id` apontando para local inexistente;
   - **classe A**: `empresa_id` do registro ≠ `empresa_id` do local, ou texto de
     local `NULL` com `local_id` canônico;
   - **classe C**: diferença apenas de caixa/espaço (possível falso positivo).
5. **Junção canônica.** Todo `UPDATE` casa `local_id = locais.id` **e**
   `empresa_id = locais.empresa_id`. É impossível propagar o nome de um local de
   outra empresa (reforçado pela FK composta `fk_e42_*_empresa_local`).
6. **`IS DISTINCT FROM`** evita reescrever linhas já corretas (idempotência).
7. **`ON_ERROR_STOP`** garante que qualquer erro aborte o psql com exit ≠ 0.
8. **Não-migration.** O arquivo vive em `db/admin/`, fora da cadeia versionada;
   o boot nunca o executa.

### Guarda de classe A vs. o que a FK já impede

A FK composta `fk_e42_*_empresa_local` (validada na 0030) impede **novos**
vínculos cruzando empresa, então após a 0030 a classe A alcançável é o **texto
de local `NULL`** em colunas anuláveis (`movimentacoes.local`,
`movimentacoes.local_destino`). A guarda cobre os dois casos (cruzamento e NULL)
de forma defensiva: se a FK ainda não estiver validada, o cruzamento também
aborta. O teste PG exercita o caminho A alcançável (texto NULL).

---

## 8. Quantidade esperada de UPDATEs por tabela

| tabela/coluna | UPDATEs esperados |
|---|---|
| `estoques.local` | 30 |
| `movimentacoes.local` | 20 |
| `movimentacoes.local_destino` | 10 |
| `inventarios.local` | 9 |
| **Total** | **69** |

Resultado esperado após o APPLY: **`nomes_locais_inconsistentes = 0`**.
Segunda execução (idempotente): **0 UPDATEs** em todas as tabelas.

---

## 9. Resultado das execuções (validação local, sem produção)

Tudo foi validado em PostgreSQL 16.14 real, em bancos descartáveis; o teste roda
o script **dentro de uma transação revertida** (nada persiste).

| Verificação | Resultado |
|---|---|
| Reprodução da fixture | `nomes_locais_inconsistentes=69` (30/20/10/9) |
| DRY-RUN | 0 escritas; contador permanece 69 |
| APPLY sem `confirmacao` | **aborta** (`APPLY recusado`), nada alterado |
| APPLY com dupla confirmação | `estoques=30, mov=20, mov_destino=10, inv=9`; `AFTER=0` |
| `local_id` / `empresa_id` | inalterados (snapshot antes/depois) |
| Isolamento por empresa | linha da empresa B recebe o nome do **próprio** local; jamais o da empresa A |
| Classe A (texto NULL) | **aborta** (`classe A`); linha não alterada |
| Classe C (caixa/espaço) | **aborta** (`classe C`); linha não alterada |
| Idempotência | 2ª passada = 0 UPDATEs; contador 0 |
| Rollback do teste | `empresas`/`locais`/`estoques` de fixture = 0 após o teste |

### Verificações do projeto

| Verificação | Resultado |
|---|---|
| Suíte PG (`npm run test:pg`) | **215 pass, 0 fail, 0 skip, 0 todo** |
| E4.2 + PROD-DB-01 | pass, 0 fail |
| Suíte memória do server (sem `DATABASE_URL`) | 821 pass, 0 fail |
| Client (`vitest`) | 323 pass, 0 fail |
| typecheck (domain/server/client) | OK |
| lint | 0 erros (warnings pré-existentes) |
| build (client) | OK |

---

## 10. Procedimento exato de execução em produção

> **Somente após autorização explícita.** Nada abaixo deve ser rodado sem aval.

**Passo 0 — Autorização e janela.** Obter autorização formal e definir janela de
manutenção (aplicação parada ou em modo degradado).

**Passo 1 — Backup/snapshot confirmado.** Criar um snapshot/backup do banco de
produção e **confirmar que é restaurável** antes de seguir. Sem isso, **não
prossiga**.

**Passo 2 — Diagnóstico BEFORE (read-only).** Registrar a prova do "antes":

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/diagnostico-e42-nomes-locais.sql
```

Confirmar `nomes_locais_inconsistentes = 69` e a distribuição 30/20/10/9.

**Passo 3 — DRY-RUN.** Rodar o script sem parâmetros e conferir a classificação:

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/admin/005-propagar-nomes-locais-e42.sql
```

Exigir na saída: `A=0 C=0 B=69`. Se `A>0` ou `C>0`, **parar** e revisar (o script
já abortaria no APPLY; aqui é para decidir manualmente).

**Passo 4 — APPLY.**

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
  -v apply=on -v confirmacao=PROD-DB-01.5 \
  -f db/admin/005-propagar-nomes-locais-e42.sql
```

Exigir na saída: `atualizados: ... (total=69)`, `AFTER nomes_locais_inconsistentes=0`,
`COMMIT`. Se aparecer `ERROR` e `ROLLBACK`, **nada** foi persistido — investigar.

**Passo 5 — Diagnóstico AFTER (read-only).** Provar o "depois":

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/diagnostico-e42-nomes-locais.sql
```

Exigir `nomes_locais_inconsistentes = 0`.

**Passo 6 — Aplicar o DDL.** Com o preflight satisfeito, rodar a migração/
bootstrap (o fluxo normal da aplicação) para aplicar a 0030 e o restante da
cadeia. Confirmar que o banco sai de `degraded` para `ready`.

**Passo 7 — Auditoria.** Arquivar as saídas dos passos 2–5 (BEFORE, DRY-RUN,
APPLY, AFTER) no registro de mudanças.

---

## 11. Riscos

| Risco | Nível | Mitigação |
|---|---|---|
| Aplicar sem backup | **Alto** | Pré-requisito obrigatório (§7, passo 1). O script é transacional e reversível dentro da transação, mas o snapshot protege contra erro de julgamento. |
| Texto propagado de local errado | **Baixo** | Junção por `local_id + empresa_id`; FK composta impede cruzamento de empresa. |
| Caso A/C mascarado | **Baixo** | Guardas abortam; teste cobre os dois caminhos. |
| Reexecução duplicando | **Baixo** | `IS DISTINCT FROM` + teste de idempotência (0 UPDATEs na 2ª passada). |
| Esquecer de aplicar o DDL depois | **Médio** | Passo 6 do procedimento; banco fica `degraded` até o DDL rodar. |
| Diferença só de caixa/espaço (classe C) | **Baixo** | Aborta; exige decisão administrativa (normalizar ou não) — fora do escopo. |
| Aplicar em horário de uso | **Médio** | Janela de manutenção (passo 0). |
| Script rodado por engano no boot | **Nenhum** | Não é migration; vive em `db/admin/` e não é referenciado por nenhum runner. |

---

## 12. Próximo ciclo (sugestão)

1. Obter autorização e executar os passos 1–7 em produção.
2. Confirmar que o `/api/health` volta a `ready` e que o deploy do schema
   completa.
3. Registrar a evidência (BEFORE/DRY-RUN/APPLY/AFTER) no histórico de mudanças.
4. Se surgirem casos classe A ou C, tratá-los como itens administrativos
   separados (A: revisão de empresa; C: decisão de normalização), **sem** afrouxar
   o preflight.
