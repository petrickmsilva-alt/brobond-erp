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
2. considera **todos** os índices únicos não-primários e válidos cuja chave
   inclua a coluna textual normalizada — **não há lista fixa de índices no
   código**;
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
| `db/admin/005-propagar-nomes-locais-e42.sql` | preflight de colisão de classe C (genérico por catálogo), aborto antes do UPDATE, relatório; revisão `PROD-DB-01.5.3` |
| `db/admin/run-005-e42.sh` | `REVISAO_ESPERADA='PROD-DB-01.5.3'` (guarda contra cópia defasada) |
| `server/test/pg/prod-db-01-521-gate-classe-c.test.ts` | marcador de revisão atualizado para `01.5.3` |
| `server/test/pg/prod-db-01-53-colisao-classe-c.test.ts` | **novo** — 11 cenários de colisão + detecção genérica |
| `docs/RELATORIO-PROD-DB-01-5-3.md` | **novo** — este relatório |

---

## 10. FOLLOW-UPs (fora do escopo deste ciclo)

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
