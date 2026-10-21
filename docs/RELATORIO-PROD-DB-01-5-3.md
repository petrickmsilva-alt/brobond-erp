# PROD-DB-01.5.3 — Detecção prévia de colisão na normalização Classe C

**Modo:** INVESTIGAÇÃO + CORREÇÃO + TESTE + DOCUMENTAÇÃO.

> Nada foi executado em produção. Nenhum `UPDATE` foi rodado contra o banco de
> produção. Nenhum `APPLY` foi executado. Render, `DATABASE_URL` de produção e
> deploy não foram tocados. A migration `0030` **não** foi alterada.

**Continuação direta de:** PROD-DB-01.5.2.1
(`docs/RELATORIO-PROD-DB-01-5-2-1.md`).

---

## 1. Problema encontrado

A execução real do PROD-DB-01.5.2.1 confirmou a classificação:

```
A = 0
B = 0
C = 69
```

Ao tentar normalizar a classe C, o `UPDATE` em `estoques.local` violou uma
constraint real e abortou a transação **sem `COMMIT`**:

```
duplicate key value violates unique constraint
  "estoques_produto_id_tamanho_id_local_key"
chave conflitante: (produto_id, tamanho_id, local) = (7, 5, LOJA)
```

### Por que Classe C não é automaticamente segura

A premissa do PROD-DB-01.5.2 era: "se a única diferença é caixa/espaço, a
normalização é cosmética e segura". Isso é **falso** quando o texto normalizado
participa de um índice `UNIQUE`.

`estoques` tem, no schema real, a constraint `estoques_produto_id_tamanho_id_local_key`
sobre `(produto_id, tamanho_id, local)`. No caso real coexistiam:

| produto_id | tamanho_id | local | local_id |
|-----------:|-----------:|:------|:---------|
| 7 | 5 | `LOJA` | `NULL` (linha legada) |
| 7 | 5 | `loja` | `<id do local canônico>` |

Normalizar `'loja' → 'LOJA'` faria a segunda linha ocupar exatamente a chave
`(7, 5, 'LOJA')` da primeira. Duas linhas **distintas** passariam a ter a mesma
chave → violação de unicidade. O PostgreSQL descobriu isso **durante** o
`UPDATE`, abortando o comando inteiro.

Lição: **diferença apenas de caixa/espaço é condição necessária, mas não
suficiente, para normalizar**. A suficiência depende das constraints reais da
tabela e dos dados existentes.

---

## 2. Nova regra de segurança (implementada)

Antes de qualquer `UPDATE` de classe C, o script executa um **preflight de
colisão** que:

1. inspeciona o **catálogo real** (`pg_index` / `pg_attribute`) das tabelas que a
   normalização pode alterar;
2. considera **todos** os índices únicos (inclusive a chave primária) e válidos
   cuja chave inclua a coluna textual normalizada — **não há lista fixa de
   índices no código**;
3. considera também índices parciais cujo **predicado** referencia a coluna
   normalizada (fail-closed: aborta em vez de assumir que o índice deixa de
   valer);
4. avalia o estado **pós-update da tabela inteira** (não só das linhas
   candidatas), porque a colisão pode ser entre uma linha atualizada e outra
   **não** atualizada — exatamente o caso real;
5. preserva a semântica `NULL` do índice btree: uma chave com qualquer coluna
   nula nunca colide;
6. **aborta TODO o APPLY** se houver qualquer colisão, **antes** de executar
   qualquer `UPDATE`.

O PostgreSQL nunca mais é quem descobre a violação.

### Tabelas/colunas cobertas (todas as que o script de classe C atualiza)

| tabela | coluna textual | vínculo canônico |
|:-------|:---------------|:-----------------|
| `estoques` | `local` | `local_id` |
| `movimentacoes` | `local` | `local_id` |
| `movimentacoes` | `local_destino` | `local_destino_id` |
| `inventarios` | `local` | `local_id` |

O preflight é genérico: se novas tabelas/colunas entrarem na normalização, a
mesma varredura de catálogo as protege — a cobertura vem do schema, não de um
`CASE` hardcoded.

---

## 3. Ordem obrigatória do APPLY (preservada e ampliada)

```
1. BEGIN
2. validar parâmetros de autorização (apply + confirmacao + normalizar_classe_c)
3. preflight A/B/C
4. preflight de colisão de Classe C
5. se colisões > 0: RAISE EXCEPTION; nenhum UPDATE; nenhum COMMIT
6. somente se colisões = 0:
     - executar UPDATEs de Classe C
     - reexecutar o preflight completo do E4.2/0030 (AFTER-CHECK fail-closed)
     - validar todas as contagens esperadas
     - COMMIT somente se tudo estiver consistente
```

O `COMMIT` continua dependendo de `e42.autorizado`, ligado pelo próprio bloco
apenas quando a operação autorizada completou a pós-validação.

---

## 4. Relatório da colisão

O DRY-RUN (e o APPLY abortado) informa, com os **dados reais** (nunca
fictícios), uma linha por chave conflitante:

```
E4.2/01.5.3 COLISÃO: tabela=estoques índice=estoques_produto_id_tamanho_id_local_key
  coluna=local chaves_conflitantes=1 linhas_envolvidas=2
  • tabela=estoques índice=estoques_produto_id_tamanho_id_local_key
    chave_conflitante={"local": "LOJA", "produto_id": 7, "tamanho_id": 5}
    empresa_id={9001} local_id={5001,NULL} local_atual={LOJA,loja}
    local_canonico={LOJA,NULL} linhas=2 registros={5,6}
```

Campos: tabela, índice/constraint, chave conflitante completa, `empresa_id`,
`local_id`, local atual, local canônico/destino, demais colunas da chave
(embutidas em `chave_conflitante`), linhas e ids de registro envolvidos e a
quantidade de colisões.

---

## 5. Caso exato reproduzido (banco descartável)

Fixture idêntica ao incidente — `produto_id=7`, `tamanho_id=5`, `locais.nome='LOJA'`:

```
=== BEFORE ===
 id | produto_id | tamanho_id | local | local_id
  5 |          7 |          5 | LOJA  |  (NULL)
  6 |          7 |          5 | loja  |    5001
```

**DRY-RUN:**

```
E4.2/01.5.3 COLISÃO: tabela=estoques índice=estoques_produto_id_tamanho_id_local_key
  coluna=local chaves_conflitantes=1 linhas_envolvidas=2
  • ... chave_conflitante={"local": "LOJA", "produto_id": 7, "tamanho_id": 5}
    empresa_id={9001} local_id={5001,NULL} local_atual={LOJA,loja} registros={5,6}
E4.2/01.5.3 DRY-RUN: 1 colisão(ões) ... O APPLY abortaria ANTES de qualquer UPDATE.
ROLLBACK — nenhum dado alterado
```

**APPLY:**

```
ERROR: E4.2/01.5.3 ABORTADO: a normalização classe C faria 1 chave(s) única(s)
  colidir (2 linha(s) envolvida(s)). Nenhum UPDATE foi executado e nada será persistido.
EXIT=3  (nenhum COMMIT)
```

**AFTER:** exatamente as mesmas duas linhas (`LOJA`/NULL e `loja`/5001). Nenhuma
linha alterada, nenhum `COMMIT`.

---

## 6. Testes

Arquivo novo: `server/test/pg/prod-db-01-53-colisao-classe-c.test.ts` (3 testes,
executam o arquivo real pelo `psql -f`, em bancos descartáveis próprios).

| # | Cenário | Resultado |
|--:|:--------|:----------|
| 1 | Classe C sem colisão → normaliza, COMMIT, 2ª execução = 0 | ✅ |
| 2 | Classe C com colisão → detecta no preflight, sem UPDATE, dados idênticos, aborta | ✅ |
| 3 | Caso exato (7, 5, `loja→LOJA`, `estoques_produto_id_tamanho_id_local_key`) | ✅ |
| 4 | Mais de uma colisão → todas reportadas, APPLY aborta integralmente | ✅ |
| 5 | Classe A continua abortando | ✅ |
| 6 | Classe B continua não sendo tratada como Classe C | ✅ |
| 7 | Isolamento por `empresa_id` — sem colisão cruzada entre tenants | ✅ |
| 8 | DRY-RUN nunca altera dados | ✅ |
| 9 | APPLY autorizado sem colisão → executa, valida pós-condição, COMMIT | ✅ |
| 10 | Rollback: falha pós-update (`duplicatas_saldos`) reverte tudo | ✅ |
| 11 | Wrapper continua recusando cópia defasada do script | ✅ (teste existente) |
| + | Detecção genérica (índice único adicional em `inventarios`) e predicado sobre a coluna normalizada = fail-closed | ✅ |

### 6.1 Verificação final (execução limpa, PostgreSQL 16.14)

| camada | comando | resultado |
|:-------|:--------|:----------|
| PostgreSQL | `npm run test:pg` | **227 pass / 0 fail / 0 skipped** (224 baseline + 3 novos) |
| Memória | `npm --workspace server test` (sem `DATABASE_URL`) | **824 pass / 0 fail / 66 skipped** |
| Client | `npm --workspace client test` | **323 pass** (29 arquivos) |
| typecheck | `npm run typecheck` | exit 0 |
| lint | `npm run lint` | exit 0 (0 erros; 410 warnings pré-existentes) |
| build | `npm run build` | exit 0 |
| auditoria de menu | `npm run audit:menu` | exit 0 |
| smoke | `npm run smoke` (servidor demo em :3001) | **126/126** |
| smoke PostgreSQL | `npm run smoke:pg` | **126/126** |

Nota de ambiente: `npm run test:pg` e `npm --workspace server test` **não** devem
rodar com `DATABASE_URL` exportado ao mesmo tempo. A suíte de memória pressupõe
modo demonstração; com `DATABASE_URL` presente ela tenta tocar o banco e falha
(artefato de ambiente, não regressão). O smoke simples exige um servidor em
modo demonstração já no ar na porta 3001.

A mensagem `ERP-03 GATE BLOCKED: resumo={}` **não** é uma falha de teste. O
`scripts/test-pg-gate.mjs` lê o resumo no formato TAP (`# pass 227`), que é o
reporter padrão do `node --test` em **Node 22 não-TTY** (a versão fixada no CI).
Em **Node 24** o reporter padrão passou a ser `spec` (`ℹ pass 227`), então o
parser do gate não encontra o resumo e bloqueia — mesmo com 227 pass / 0 fail.
Rodando o runner com `--test-reporter=tap` (equivalente ao CI), o resumo aparece
como `# pass 227 / # fail 0 / # skipped 0` e o gate aprova. É um artefato de
versão de Node, **pré-existente** (o gate não foi alterado neste ciclo) e
registrado como FOLLOW-UP.

---

## 7. Decisões deliberadas (o que a normalização NÃO faz)

- **Nenhum merge automático.** Se duas linhas colidem, o script **não** soma
  quantidades nem escolhe uma para manter.
- **Nenhuma exclusão.** O script nunca deleta linhas.
- **Nenhuma correção automática de estoque.** A decisão sobre a linha duplicada
  é do operador, depois de ver o relatório.
- **`0030` intacta.** A migration não foi tocada; o preflight E4.2 não foi
  relaxado.
- **DRY-RUN continua o padrão.** O `APPLY` continua exigindo as confirmações já
  existentes (nada foi enfraquecido).

---

## 8. Riscos / residuais

- O preflight é **fail-closed** por design: um índice parcial cujo predicado
  referencie a coluna normalizada aborta mesmo quando talvez não houvesse
  colisão. É intencional (não se assume segurança sem prova).
- A detecção cobre índices **únicos**. Índices não-únicos não podem causar
  violação de unicidade e não são bloqueantes.
- Se o schema ganhar um índice único com **expressão** (não coluna) sobre a
  coluna textual, ele não é coberto pela comparação por nome de coluna. Não
  existe caso desses hoje; registrado como FOLLOW-UP caso apareça.
- Idempotência preservada: após uma normalização bem-sucedida, a segunda
  execução retorna `0` alterações e não cria colisão artificial.

---

## 9. Arquivos alterados

| arquivo | mudança |
|:--------|:--------|
| `db/admin/005-propagar-nomes-locais-e42.sql` | preflight de colisão de classe C (genérico por catálogo), aborto antes do UPDATE, relatório determinístico (`COLLATE "C"`); revisão `PROD-DB-01.5.3` |
| `db/admin/run-005-e42.sh` | `REVISAO_ESPERADA='PROD-DB-01.5.3'` (guarda contra cópia defasada) |
| `server/test/pg/prod-db-01-521-gate-classe-c.test.ts` | marcador de revisão atualizado para `01.5.3` |
| `server/test/pg/prod-db-01-53-colisao-classe-c.test.ts` | **novo** — 11 cenários de colisão + detecção genérica + determinismo sob collation ICU |
| `server/test/pg/prod-db-01-53-1-schema-search-path.test.ts` | **novo (hotfix 01.5.3)** — regressão: a colisão `(7,5,LOJA)` ainda é detectada quando `current_schema() != public` |
| `docs/RELATORIO-PROD-DB-01-5-3.md` | **novo** — este relatório |

---

## 10. HOTFIX de CI — ordem de `array_agg` dependente de collation

Depois de o PR #76 ficar tecnicamente pronto, o job `CI / testes-postgres`
falhou no GitHub (225 pass / 2 fail) enquanto local dava 227/0. Causa raiz:

- O relatório de colisão montava `local_atual` com `array_agg(DISTINCT r.local)`
  **sem `ORDER BY`**. A ordem de `array_agg(DISTINCT ...)` segue a **collation
  do banco**.
- O serviço `postgres:16.14` do CI nasce com `en_US.utf8` (**ICU**) e devolve
  `{loja,LOJA}`; o host local (`C.UTF-8`) devolve `{LOJA,loja}` para o **mesmo**
  dado.
- As asserções `/local_atual=\{LOJA,loja\}/` (caso exato e cenário de múltiplas
  colisões) passavam local e falhavam no CI.

Correção (determinismo, não mascaramento): o relatório agora ordena as colunas
textuais com `COLLATE "C"` (`array_agg(DISTINCT x COLLATE "C" ORDER BY x COLLATE "C")`)
e as numéricas com `ORDER BY` explícito. A ordem passa a ser byte a byte,
idêntica em qualquer collation. Como cada coluna textual aparece duas vezes no
`format()`, os argumentos passaram a ser posicionais (`%1$s`…`%7$s`).

Teste de regressão: `PROD-DB-01.5.3 — o relatório de colisão é determinístico
sob collation ICU (ordem do CI)` cria um banco descartável com
`LOCALE_PROVIDER icu`, confirma que a ordem nativa é `{loja,LOJA}` e exige que o
relatório continue `{LOJA,loja}`. Revertendo a correção, esse teste falha com o
**mesmo** erro do CI (`local_atual={loja,LOJA}`).

Não foi uma regressão do PROD-DB-01.5.3 (o comportamento de detecção estava
correto); era um defeito de **portabilidade do relatório**. A suíte rodou verde
nas duas collations: **228 pass / 0 fail / 0 skipped** em `C.UTF-8` e em ICU.

---

## 11. HOTFIX 01.5.3 — a varredura de índices escopava por `current_schema()` (o defeito que ainda deixava a produção falhar)

### 11.1 Diagnóstico

Mesmo com o preflight de colisão do PROD-DB-01.5.3 instalado, a produção voltou
a abortar com a mensagem **nativa** do PostgreSQL:

```
duplicate key value violates unique constraint
  "estoques_produto_id_tamanho_id_local_key"
Key (produto_id, tamanho_id, local)=(7, 5, LOJA) already exists.
```

com a classificação `A=0 B=0 C=69` — ou seja, a preflight **não** detectou a
colisão antes do `UPDATE`.

Causa raiz: a varredura do catálogo escopava por **`current_schema()`**:

```sql
JOIN pg_namespace n ON n.oid = t.relnamespace
WHERE n.nspname = current_schema()      -- PRIMEIRO schema EXISTENTE do search_path
  AND t.relname = tgt.tabela
```

`current_schema()` **não** devolve necessariamente o schema onde as tabelas
vivem: ele devolve o **primeiro schema existente** do `search_path`. O
`search_path` padrão do PostgreSQL é `"$user", public`. Num Postgres gerenciado
(Neon/Render) é comum existir um schema com o **nome da role conectante**; nesse
caso `current_schema()` passa a ser esse schema — que **não tem** os índices das
tabelas do ERP.

Resultado: a varredura enxergava **ZERO** índices e anunciava "nenhuma colisão
prevista", enquanto o `UPDATE` (sem qualificação de schema) resolvia
`estoques` corretamente pelo `search_path` para `public.estoques` — e o
PostgreSQL era quem descobria a violação **durante** o `UPDATE`.

Os dois lados usavam resoluções de nome **diferentes**: o `UPDATE` usava o
`search_path`; a varredura usava `current_schema()`. A divergência entre elas é
o defeito.

### 11.2 Reprodução empírica

Banco descartável com `search_path = <role>, public` (existindo um schema com o
nome da role) e a fixture do caso exato (`produto_id=7`, `tamanho_id=5`, uma
linha `'LOJA'` e outra `'loja'`):

| versão do script | `current_schema()` | DRY-RUN | APPLY |
|:-----------------|:-------------------|:--------|:------|
| **antes do hotfix** | `brobond` (schema da role) | `índices únicos verificados=0` → **não detecta** | **`duplicate key ... estoques_produto_id_tamanho_id_local_key`** (PostgreSQL descobre) |
| **depois do hotfix** | `brobond` (schema da role) | `índices únicos verificados=3` → **colisão detectada** | **aborta antes do UPDATE** (`ABORTADO ... 1 chave(s) ... colidir`), sem `COMMIT` |

É a assinatura exata do incidente: classificação correta (`C=69`) e, ainda
assim, violação de constraint descoberta pelo PostgreSQL.

### 11.3 Correção

1. **Escopo pela tabela REAL.** O OID da tabela alvo é resolvido por
   `to_regclass(tgt.tabela)` — a **mesma** resolução de nome que o `UPDATE`
   usa — e a varredura passa a ser escopada por `i.indrelid = tgt_oid`:

   ```sql
   tgt_oid := to_regclass(tgt.tabela);
   ...
   WHERE i.indrelid = tgt_oid
   ```

   Assim a varredura enxerga os índices da **mesma tabela** que o `UPDATE` toca,
   qualquer que seja o `search_path` da sessão.

2. **Fail-closed na tabela não resolvível.** Se `to_regclass` devolver `NULL`, o
   preflight **aborta** antes de qualquer escrita (em vez de, silenciosamente,
   não achar índice algum).

3. **Defesa em profundidade.** Se houver **classe C** para normalizar, mas a
   varredura inspecionar **zero** índices únicos nas tabelas alvo, o bloco
   **aborta** — nunca anuncia segurança sem prova. Esse guarda, por si só, já
   teria impedido o incidente mesmo se a resolução de schema voltasse a divergir.

Nada mais mudou: A/B/C preservados; a identificação do registro continua por
`local_id` + `empresa_id`; nenhum fallback textual; nenhum `DELETE`/`MERGE`. A
migration `0030` não foi alterada.

### 11.4 Teste de regressão

`server/test/pg/prod-db-01-53-1-schema-search-path.test.ts` (novo). O banco
descartável nasce com um schema com o nome da role **à frente** do `public` no
`search_path`, de modo que `current_schema() != public`. A fixture reproduz o
caso exato (`produto_id=7`, `tamanho_id=5`, `'LOJA'` + `'loja'`) e prova:

- **DRY-RUN** detecta a colisão (e reporta a chave `(7, 5, LOJA)`);
- **APPLY** aborta **antes** do `UPDATE`;
- **nenhuma** linha é alterada (snapshot byte a byte idêntico);
- **nenhuma** exclusão/merge ocorre (o número de linhas permanece 2);
- **não há `COMMIT`**, e a mensagem **nativa** de constraint **não** aparece
  (o PostgreSQL nunca chega a descobrir a violação).

Revertendo o escopo para o comportamento anterior, o teste **falha** com o
sintoma do incidente (`índices únicos verificados=0` e depois `duplicate key`),
o que prova que ele cobre o defeito.

---

## 12. FOLLOW-UPs (fora do escopo deste ciclo)

- **Operação classe B tem risco latente análogo.** A correção de classe B também
  troca texto por `locais.nome`; uma linha de classe B poderia colidir com outra
  linha sob `estoques_produto_id_tamanho_id_local_key`. Hoje isso é contido pelo
  **AFTER-CHECK** (`duplicatas_saldos` → `RAISE EXCEPTION` → `ROLLBACK`), que
  reverte tudo, mas a colisão ainda é descoberta pelo PostgreSQL **durante** o
  UPDATE, não por um preflight. Não é uma falha de dados (nada é persistido),
  mas a mensagem é menos explicativa. Estender o preflight genérico à operação B
  é o próximo passo natural — **fora do escopo do PROD-DB-01.5.3**.
- Investigar a **origem** das linhas legadas com `local_id IS NULL` e `local`
  preenchido (por que existem duplicatas cosméticas em produção).
- Definir, com a administração, a política de resolução das 69 linhas de classe
  C (e das que colidem): qual linha manter, se há ajuste de saldo.
- Avaliar se o schema deve ganhar índices únicos com expressão `lower(btrim(...))`
  (mudaria a análise de colisão; exigiria estender o preflight).
- **`scripts/test-pg-gate.mjs` assume TAP.** Ele parseia `# pass`/`# fail`, mas o
  reporter padrão do `node --test` mudou de TAP para `spec` no Node 24 (em Node
  22 não-TTY, o do CI, continua TAP). Em Node ≥ 24 o gate bloqueia mesmo com
  suíte verde. Corrigir o parser (aceitar `ℹ pass`, ou fixar
  `--test-reporter=tap` no `server/package.json#test:pg`) é uma mudança de
  infraestrutura de teste — **fora do escopo do PROD-DB-01.5.3**.
