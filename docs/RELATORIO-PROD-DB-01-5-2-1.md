# PROD-DB-01.5.2.1 — Correção do gate de normalização Classe C

**Modo:** INVESTIGAÇÃO + CORREÇÃO + TESTE + DOCUMENTAÇÃO.

> Nada foi executado em produção. Nenhum `UPDATE` foi rodado contra o banco de
> produção. Nenhum `APPLY` foi executado. Render, `DATABASE_URL` e deploy não
> foram tocados.

**Continuação direta de:** PROD-DB-01.5.2 (`docs/RELATORIO-PROD-DB-01-5-2.md`).

---

## 1. Incidente relatado

Em produção, o comando abaixo (idêntico ao documentado no PROD-DB-01.5.2)
abortou a classe C em vez de autorizá-la:

```bash
psql "$DATABASE_URL" \
  -v apply=on \
  -v confirmacao=PROD-DB-01.5.2 \
  -v normalizar_classe_c=on \
  -v ON_ERROR_STOP=1 \
  -f db/admin/005-propagar-nomes-locais-e42.sql
```

Saída observada (transcrita do incidente):

```
modo_apply | confirmacao
-----------+----------------
on         | PROD-DB-01.5.2
(1 row)

BEGIN

E4.2/01.5 BEFORE nomes_locais_inconsistentes=69

ERROR:  E4.2/01.5 ABORTADO: 69 caso(s) classe C (diferença apenas de caixa/espaço). Nada foi alterado.
HINT:  Diferença cosmética: decida com a administração se normaliza; não é propagação de renome.
CONTEXT:  PL/pgSQL function inline_code_block line 128 at RAISE
```

A transação foi abortada; nenhum dado de produção foi alterado.

---

## 2. Causa raiz (comprovada por reprodução)

**A produção executou uma revisão ANTIGA do arquivo** — a de `PROD-DB-01.5.1`
(commit `e592294`) — e não a revisão do `PROD-DB-01.5.2` (commit `e34154a`).

A transcrição do incidente identifica a revisão sem ambiguidade, por dois
marcadores que **não existem** na revisão atual:

| Marcador na saída de produção | Revisão 01.5.1 (`e592294`) | Revisão 01.5.2 / HEAD (`e34154a`+) |
|---|---|---|
| Cabeçalho do `set_config` | 2 colunas: `modo_apply \| confirmacao` | 3 colunas: `... \| normalizar_classe_c` |
| HINT da classe C | `decida com a administração se normaliza` | `use a operação explícita -v normalizar_classe_c=on ...` |
| Parâmetro `normalizar_classe_c` | **não existe** | existe (3º `set_config`) |

Verificação direta no repositório:

```bash
# O texto do HINT de produção só existe nas revisões antigas:
$ grep -rn "decida com a administração" .
# → NÃO ENCONTRADO na árvore atual

# Contagem de set_config('e42...') por revisão:
b43285b (01.5)    : 2   ← sem a flag
e592294 (01.5.1)  : 2   ← sem a flag (REVISÃO DO INCIDENTE)
e34154a (01.5.2)  : 5
HEAD    (7238fdf) : 5
```

**Reprodução do incidente:** rodando o arquivo de `e592294` com o comando EXATO
de produção contra uma fixture de 69 casos classe C, a saída sai byte a byte
igual à transcrição (cabeçalho de 2 colunas, mesmo HINT, `exit 3`). Rodando o
arquivo de HEAD com o mesmo comando, a classe C é autorizada
(`atualizados ... total=69`, `COMMIT`, `exit 0`).

**Conclusão:** não havia defeito de lógica no HEAD. O gate já reconhecia
`normalizar_classe_c=on`; o operador executou uma cópia defasada do arquivo, que
nem possui o parâmetro. O sintoma "o parâmetro foi recebido pelo psql, mas o gate
não autorizou" é exatamente o que uma revisão antiga produz.

---

## 3. Correção aplicada (endurecimento do reconhecimento da flag)

Como o comportamento funcional do HEAD já estava correto, a correção torna o
**reconhecimento da flag** explícito e à prova do sintoma observado, sem alterar
nenhuma outra regra:

1. **Leitura textual normalizada.** A flag é lida como TEXTO e comparada após
   `lower(btrim(...))`. Assim `ON`, `on` e ` on ` (caixa/espaço) são todos
   reconhecidos — antes a comparação era sensível a caixa.

2. **Valor não reconhecido é ERRO explícito.** Um valor fora do conjunto
   booleano conhecido (`on/true/1/yes/off/false/0/no`) aborta informando o valor
   exato recebido. Antes, qualquer valor inesperado caía em `IN (...)` → `false`
   e o script seguia como se a flag **não tivesse sido passada**, produzindo o
   mesmo erro confuso do incidente (`ABORTADO: N caso(s) classe C`).

3. **Marcador de revisão no log.** O bloco emite
   `E4.2/01.5.2.1 revisão do script: reconhece normalizar_classe_c=<valor>`.
   Uma cópia antiga do arquivo não imprime essa linha, de modo que uma execução
   defasada é distinguida imediatamente de uma falha de gate.

Nenhuma guarda foi relaxada: classe A continua fatal, B e C continuam
mutuamente exclusivas, o UPDATE continua por `local_id + empresa_id`, a
pós-validação fail-closed continua exigindo todos os contadores em 0, e o
`COMMIT` continua dependente de `e42.autorizado`.

---

## 4. Comportamento garantido (matriz de autorização)

| Cenário | `apply` | `confirmacao` | `normalizar_classe_c` | Resultado |
|---|---|---|---|---|
| DRY-RUN | ausente | — | — | 0 escritas; ROLLBACK |
| APPLY B | `on` | `PROD-DB-01.5` | ausente | autoriza classe B (inalterado) |
| APPLY C sem confirmação | `on` | ausente | `on` | aborta |
| APPLY C com confirmação B | `on` | `PROD-DB-01.5` | `on` | aborta |
| APPLY C sem a flag | `on` | `PROD-DB-01.5.2` | ausente | aborta (classe C protegida) |
| **APPLY C autorizado** | `on` | `PROD-DB-01.5.2` | `on` | **normaliza 69, COMMIT** |
| Flag com valor inválido | `on` | `PROD-DB-01.5.2` | `ligado` | aborta com o valor exato |
| Flag em caixa alta / com espaço | `on` | `PROD-DB-01.5.2` | `ON` / ` on ` | autoriza |

---

## 5. Arquivos alterados

| Arquivo | Tipo | Descrição |
|---|---|---|
| `db/admin/005-propagar-nomes-locais-e42.sql` | correção | reconhecimento robusto da flag + validação de valor + marcador de revisão |
| `server/test/pg/prod-db-01-521-gate-classe-c.test.ts` | teste (novo) | regressão do incidente via `psql -f` (comando EXATO de produção) |
| `docs/RELATORIO-PROD-DB-01-5-2-1.md` | documento | este relatório |

---

## 6. Testes

Novo teste PG: `server/test/pg/prod-db-01-521-gate-classe-c.test.ts`. Diferente do
teste do 01.5.2 (que injeta o SQL por STDIN), este usa `-f <caminho>` — a MESMA
forma do comando de produção — e executa o **arquivo inteiro** pelo `psql` real.

| Teste | Prova |
|---|---|
| 1 | DRY-RUN: 0 escritas, ROLLBACK, contador permanece 69 |
| 2 | APPLY sem confirmação → aborta, nada alterado |
| 3 | APPLY com confirmação `PROD-DB-01.5` → não autoriza classe C |
| 4 | APPLY com confirmação `01.5.2` sem a flag → classe C aborta |
| 5 | Flag com valor inválido (`ligado`) → aborta com o valor exato |
| 6 | **Comando EXATO de produção (`-f`) → 69→0 (29+40) + COMMIT** |
| 7 | Idempotência: 2ª execução = 0 UPDATEs |
| 8 | Robustez: `ON` e ` on ` autorizam (caixa/espaço normalizados) |

O teste 6 é o teste de regressão do incidente: reproduz a linha de comando que
falhou em produção e prova que a classe C passa a ser autorizada. Também confirma
que `id`, `local_id`, `empresa_id` e `quantidade` permanecem iguais e que só o
campo textual é alterado.

---

## 7. Não alterado

- **Migration 0030** e a regra E4.2: intactas.
- `server/src/db.ts`, `server/src/index.ts`, mecanismo de boot, fail-closed e
  Render: não tocados.
- Nenhuma autocorreção no boot; nenhum `UPDATE` em produção.
- Schema estrutural e qualquer regra funcional não relacionada ao gate classe C.

---

## 8. Diagnóstico para o operador

Se o log **não** exibir a linha
`E4.2/01.5.2.1 revisão do script: reconhece normalizar_classe_c=...`, a cópia
executada é anterior ao 01.5.2.1 — basta atualizar o arquivo
(`git checkout main -- db/admin/005-propagar-nomes-locais-e42.sql`) e repetir o
DRY-RUN antes do APPLY.
