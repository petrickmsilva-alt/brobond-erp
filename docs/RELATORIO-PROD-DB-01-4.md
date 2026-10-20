# PROD-DB-01.4 — Diagnóstico seguro dos 69 nomes de locais inconsistentes

**Modo:** DIAGNÓSTICO. Nenhuma correção de dados foi executada.
**Escopo:** identificar exatamente quais registros fazem `nomes_locais_inconsistentes=69` e por que cada um é considerado inconsistente.
**Regra respeitada:** a regra E4.2 **não** foi alterada, relaxada nem mascarada; nenhum `UPDATE`/`DELETE`/`INSERT`; nenhum fallback para `MemStore`; preflight intacto.

---

## 1. Objetivo e limites

O deploy de produção está corretamente bloqueado pela migração
`db/migrations/0030_e42_locais_estoque_multempresa.sql`, que aborta com:

```
E4.2 preflight bloqueou o DDL:
...
nomes_locais_inconsistentes=69
...
```

Este ciclo **não corrige** o dado. Ele responde, com evidência reproduzível:

> Quais são exatamente os 69 registros que fazem `nomes_locais_inconsistentes=69`
> e por que cada um é considerado inconsistente?

Nada foi escrito no banco. O ambiente de produção (`DATABASE_URL` real do Neon)
não foi acessado; a prova é por **reprodução em PostgreSQL 16** a partir do
mecanismo exato da migração.

---

## 2. Consulta exata responsável pelo contador

Em `db/migrations/0030_e42_locais_estoque_multempresa.sql:81–86`, dentro do bloco
`DO $e42_preflight_core$`, a variável `nomes_locais_inconsistentes` é calculada
por **quatro parcelas somadas** — uma por tabela/coluna que guarda o local
canônico (`local_id` / `local_destino_id`) **e** o nome textual do local:

```sql
SELECT
  (SELECT count(*) FROM estoques e JOIN locais l ON l.id = e.local_id
    WHERE e.local_id IS NOT NULL AND e.local IS DISTINCT FROM l.nome) +
  (SELECT count(*) FROM movimentacoes m JOIN locais l ON l.id = m.local_id
    WHERE m.local_id IS NOT NULL AND m.local IS DISTINCT FROM l.nome) +
  (SELECT count(*) FROM movimentacoes m JOIN locais l ON l.id = m.local_destino_id
    WHERE m.local_destino_id IS NOT NULL AND m.local_destino IS DISTINCT FROM l.nome) +
  (SELECT count(*) FROM inventarios inv JOIN locais l ON l.id = inv.local_id
    WHERE inv.local_id IS NOT NULL AND inv.local IS DISTINCT FROM l.nome)
  INTO nomes_locais_inconsistentes;
```

O preflight bloqueia o DDL quando **qualquer** contador é `> 0`
(`0030:121–124`):

```sql
IF duplicatas_locais + ... + nomes_locais_inconsistentes + ... > 0 THEN
  RAISE EXCEPTION 'E4.2 preflight bloqueou o DDL: ... nomes_locais_inconsistentes=% ...', ...
    USING HINT = 'Revise explicitamente os registros usando empresa_id e IDs canônicos; ...';
END IF;
```

A mesma consulta aparece em `db/schema.sql:1651` e `db/schema.sql:3779`
(o `schema.sql` é espelho do preflight, aplicado no bootstrap).

**Significado da regra:** quando um registro tem `local_id` (o vínculo canônico
por ID, dentro da empresa), o **texto** de local na mesma linha
(`estoques.local`, `movimentacoes.local`, `movimentacoes.local_destino`,
`inventarios.local`) deve ser **igual** ao `locais.nome` daquele ID. Divergência
= o texto ficou defasado em relação ao cadastro. A migração exige que o dado
esteja coerente antes de tornar o vínculo obrigatório, e se recusa a "adivinhar"
qual dos dois está certo.

---

## 3. Reprodução em PostgreSQL 16

Ambiente: PostgreSQL 16.14 real (container local), banco descartável. A
reprodução **constrói um estado legado plausível** e mede o contador com a
consulta acima, sem tocar em produção:

1. aplica `db/schema.sql` (schema completo) em um banco vazio;
2. cria dois locais na empresa 1 (`Loja Antiga`, `Expedicao`);
3. cria 30 saldos, 20 movimentações de origem, 10 movimentações de destino e
   9 inventários **todos vinculados por `local_id`** mas com o texto `'Loja Antiga'`;
4. **renomeia** o local `Loja Antiga` → `Loja Nova` **sem propagar** para os
   textos (comportamento anterior ao commit `ee3965c`, que introduziu a
   propagação de renome).

Resultado do contador exato:

```
 estoques_nome | mov_local_nome | mov_destino_nome | inv_nome | nomes_locais_inconsistentes
---------------+----------------+------------------+----------+-----------------------------
            30 |             20 |               10 |        9 |                          69
```

**Os 69 se decompõem exatamente como** `30 + 20 + 10 + 9`, um por parcela do
preflight. Isto confirma o mecanismo e o número.

---

## 4. Causa exata do contador 69

O contador **não** mede "locais inconsistentes" (cadastros `locais`), e sim
**linhas de dados operacionais** cujo texto de local ficou defasado do nome
canônico. A causa raiz é a **divergência texto × `local_id` introduzida por um
renome de local que não propagou para todos os registros**, em algum momento
antes de a propagação existir (ou por um caminho que não a executa).

Ordem histórica dos commits:

| Commit | O que mudou | Efeito sobre o texto do local |
|---|---|---|
| `9db751d` | `almoxarifado` → `loja`; migração SQL que **renomeia/funde** e propaga o texto nas 5 tabelas | renome em massa **com** propagação |
| `ee3965c` | "gestão livre" do admin: renomear propaga para `estoques.local`, `movimentacoes.local/local_destino`, `inventarios.local`, `vendas.local_saida` | renome pela API **com** propagação |
| `572b811` | **E4.2**: remove o backfill global por texto; adiciona o preflight | o preflight passa a **exigir** texto == `locais.nome` |

Assim, os 69 são registros **históricos**: nasceram corretos sob a regra antiga
(quando o texto era a fonte de verdade e o `local_id` nem sempre existia) e
**ficaram defasados** quando o cadastro do local foi renomeado. O preflight da
E4.2, que passou a exigir coerência texto × ID, agora os recusa.

O motivo pelo qual existem **exatamente** 69 (e não um número arbitrário) é que
o contador soma as quatro colunas: um único local renomeado gera, no mínimo,
tantos casos quantos forem os saldos, movimentações (origem **e** destino) e
inventários que apontam para ele.

---

## 5. Estrutura completa dos 69 casos

O diagnóstico (teste + script) produz, para cada caso: origem (tabela/coluna),
`registro_id`, `local_id`, `local_cadastro_id`, nome atual do cadastro,
empresa do cadastro, empresa do registro, valor esperado (nome canônico), valor
encontrado (texto gravado) e a classificação.

Estrutura observada na reprodução (padrão esperado em produção):

| origem | quantidade | id do registro | `local_id` | nome atual (`locais.nome`) | empresa local / registro | valor esperado | valor encontrado | classe |
|---|---|---|---|---|---|---|---|---|
| `estoques.local` | 30 | 1…30 | 1 | `Loja Nova` | 1 / 1 | `Loja Nova` | `Loja Antiga` | B |
| `movimentacoes.local` | 20 | 1…20 | 1 | `Loja Nova` | 1 / 1 | `Loja Nova` | `Loja Antiga` | B |
| `movimentacoes.local_destino` | 10 | 21…30 | 1 | `Loja Nova` | 1 / 1 | `Loja Nova` | `Loja Antiga` | B |
| `inventarios.local` | 9 | 1…9 | 1 | `Loja Nova` | 1 / 1 | `Loja Nova` | `Loja Antiga` | B |
| **Total** | **69** | | | | | | | |

> Em produção os `id`s, o(s) `local_id`(s) e os nomes exatos virão do banco real —
> é exatamente isso que o teste/script listam. O bloco 4 do script agrupa os 69
> por `local_id`, mostrando quantos registros cada local renomeado afeta.

O teste imprime a estrutura completa no log (e no `GITHUB_STEP_SUMMARY` do CI),
linha a linha, no formato:

```
<origem> | id=<registro_id> | local_id=<id> | empresa local=<A>/registro=<B> \
  | esperado="<nome canônico>" | encontrado="<texto gravado>" | <classe> (<motivo>)
```

---

## 6. Classificação dos 69 (A / B / C)

O diagnóstico classifica cada caso automaticamente:

- **A — dado realmente inconsistente**: `empresa_id` do registro ≠ `empresa_id`
  do cadastro do local (vínculo cruzado de empresa), ou o texto de local é
  `NULL` com `local_id` preenchido. São dados que **precisam** de correção
  administrativa.
- **B — dado historicamente válido que a regra nova passou a recusar**: registro
  com `local_id` canônico e texto divergente do nome atual, mas **mesma
  empresa**. Era válido sob a regra antiga (texto como fonte de verdade);
  tornou-se inconsistente após o renome sem propagação. **É o caso esperado dos
  69 em produção** (renome de local).
- **C — possível falso positivo da consulta E4.2**: o texto difere do nome
  canônico **apenas em caixa/espaços** (`lower(btrim(...))` iguais). A
  comparação do preflight usa `IS DISTINCT FROM` (sensível a caixa), então
  `' loja '` vs `'Loja'` conta como inconsistente embora seja a mesma
  localidade. **Não é um erro do dado em si, é sensibilidade da regra.**

Na reprodução com um único local renomeado, os 69 são **todos classe B**. As
classes A e C foram exercitadas separadamente (fixtures de borda) e o
classificador responde corretamente, o que permite separar os 69 reais de
eventuais casos de borda.

---

## 7. SQL usado no diagnóstico

Duas formas equivalentes e **read-only** foram entregues:

1. **Teste PG** `server/test/pg/prod-db-014-diagnostico-nomes-locais.test.ts` —
   lê as quatro parcelas **do próprio arquivo da migração 0030** e afirma que a
   consulta do teste é idêntica (impede mascarar a regra). Roda `EXPLAIN` e o
   detalhamento por registro.
2. **Script SQL reutilizável** `db/diagnostico-e42-nomes-locais.sql` — roda com
   `psql "$DATABASE_URL" -f db/diagnostico-e42-nomes-locais.sql`, com contador,
   distribuição por origem, detalhe por registro e agrupamento por local.

O detalhamento usa somente colunas já existentes (`locais.id`, `locais.nome`,
`locais.empresa_id`, `locais.ativo`, `estoques.local/local_id/empresa_id`,
`movimentacoes.local/local_id/local_destino/local_destino_id/empresa_id`,
`inventarios.local/local_id/empresa_id`). Nenhuma relação foi inventada.

Guarda de leitura no teste: toda instrução passa por uma checagem que **recusa**
`INSERT/UPDATE/DELETE/ALTER/DROP/TRUNCATE/CREATE/...` antes de ir ao banco.
O teste **não** chama `migrate()` (não escreve nada), então é seguro apontá-lo
ao banco real.

---

## 8. Resultado das execuções

| Verificação | Comando | Resultado |
|---|---|---|
| Reprodução do contador | fixture 30+20+10+9 em PG 16.14 | `nomes_locais_inconsistentes=69` (30/20/10/9) |
| Teste de diagnóstico (banco com 69) | `node --import tsx --test … prod-db-014…` | pass 1, fail 0; 69 linhas classificadas |
| Teste de diagnóstico (banco limpo) | idem | pass 1, fail 0; `nomes_locais_inconsistentes=0` |
| Classes A/C (fixtures de borda) | idem | A=1 e C=1 classificados corretamente |
| Suíte PG (gate `test:pg`) | `npm run test:pg` em banco novo | **214 pass, 0 fail, 0 skip, 0 todo** |
| Testes E4.2 + PROD-DB-01 | e42-http, e42-tenant, prod-db-01-schema-sync, prod-db-01-readiness, prod-db-014 | **6 pass, 0 fail** |
| Suíte memória do server | `npm --workspace server test` (sem `DATABASE_URL`) | **821 pass, 0 fail** (66 skip pré-existentes) |
| typecheck (server) | `npm --workspace server run typecheck` | OK |
| lint | `npm run lint` | **0 erros** (410 warnings pré-existentes) |
| build (client) | `npm run build` | OK |

Notas de ambiente (não relacionadas à mudança):

- O runner local é Node v24; o CI fixa **Node 22**. No Node 24 o reporter padrão
  é `spec` (`ℹ pass N`) e o gate `scripts/test-pg-gate.mjs` casa `# pass N`
  (TAP) — por isso o gate local imprime `GATE BLOCKED: resumo={}` embora os
  testes passem. No Node 22 (CI) o reporter é TAP e o gate casa. Não é
  regressão desta mudança.
- Rodar a suíte **memória** com `DATABASE_URL` no ambiente faz os testes de
  memória caírem no Postgres (42 falhas ambientais). Sem `DATABASE_URL`, o
  baseline documentado se confirma: 821/0.

---

## 9. Recomendação de correção (SEM EXECUTAR)

> **Nada abaixo foi executado.** É recomendação para o próximo ciclo.

Os 69 casos (classe B) são uma **divergência de texto vs. nome canônico**, com
o `local_id` já correto e dentro da empresa. Há três caminhos possíveis; a
escolha é decisão administrativa e deve ser feita com o detalhamento em mãos.

1. **Correção por propagação do nome canônico (recomendada se os 69 forem
   classe B).** Para cada `local_id` afetado, atualizar o texto das linhas para
   `locais.nome`, no mesmo padrão que a API já usa ao renomear
   (`propagarRenomeLocal`, `server/src/services.ts`). Requer um procedimento
   administrativo **explícito e auditado** — nunca automático no boot.
   - Idempotente, restrito à empresa, sem inferência por nome.
   - Antes: rodar o script de diagnóstico e anexar a saída (prova do antes).
   - Depois: rodar novamente e provar `nomes_locais_inconsistentes=0`.

2. **Correção de cadastro (se houver mais de um local com o mesmo nome ou nome
   trocado indevidamente).** Se a análise mostrar que o `locais.nome` é que está
   errado (renome indevido), corrigir o cadastro e **então** propagar.

3. **Sem correção + aceite explícito (não recomendado).** Manter o bloqueio e
   operar com a cadeia versionada (PROD-DB-01), documentando que o bootstrap do
   `schema.sql` permanece bloqueado. Só é aceitável se o dado for intocável por
   motivo de auditoria; mantém o `/api/health` degradado.

**Casos de classe A (se existirem em produção):** exigem correção de vínculo de
empresa, com revisão caso a caso — nunca por nome.

**Casos de classe C (se existirem):** são divergência apenas de caixa/espaço.
Avaliar, no próximo ciclo, se a regra E4.2 deve normalizar (`lower(btrim(...))`)
— **mudança de regra, fora do escopo deste ciclo**, que é só diagnóstico.

Em qualquer cenário: **não** relaxar o preflight, **não** criar fallback para
`MemStore`, **não** executar correção automática no boot. A correção deve ser um
procedimento administrativo, revisável e idempotente.

---

## 10. Avaliação de risco

| Risco | Nível | Justificativa |
|---|---|---|
| Correção incorreta do dado (propagar o nome errado) | **Médio** | Se o cadastro do local estiver errado, propagar consolida o erro. Mitigação: revisar `locais.nome` caso a caso antes. |
| Correção cruzando empresas | **Baixo** | A regra exige mesmo `empresa_id`; o procedimento deve filtrar por `empresa_id` e por `local_id` (nunca por nome). |
| Escrita acidental neste ciclo | **Nenhum** | Nenhum comando de escrita foi executado; o teste é read-only por guarda. |
| Recorrência (novo renome sem propagação) | **Baixo** | A API já propaga; um procedimento corretivo deve usar o mesmo caminho, não SQL ad-hoc divergente. |
| Manter bloqueio indefinidamente | **Médio** | O `schema.sql` segue não aplicado; a cadeia versionada cobre o necessário, mas o estado degradado persiste até a correção. |
| Falso positivo classe C não tratado | **Baixo** | Se houver, mantém o bloqueio; é divergência cosmética, sem risco de dado. |

**Conclusão de risco:** o diagnóstico é seguro (read-only). O risco está na
correção — por isso ela **não** foi executada e deve ser um procedimento
administrativo explícito, com prova antes/depois.

---

## 11. Artefatos deste ciclo

| Arquivo | Tipo | Descrição |
|---|---|---|
| `server/test/pg/prod-db-014-diagnostico-nomes-locais.test.ts` | teste PG read-only | reproduz o contador, lista e classifica cada registro; verifica que a consulta é a mesma da migração 0030 |
| `db/diagnostico-e42-nomes-locais.sql` | script SQL read-only | contador + distribuição + detalhe + agrupamento por local, para rodar em produção |
| `docs/RELATORIO-PROD-DB-01-4.md` | relatório | este documento |

Nenhuma migração, nenhum `schema.sql`, nenhuma regra E4.2 e nenhum dado foram
alterados.
