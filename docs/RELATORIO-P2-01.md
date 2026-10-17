# P2-01 — Integridade temporal da cadeia de auditoria ao passar por JSONB

**Ciclo:** P2-01 (único objetivo) · **Base:** `main` após o merge da PR #68 (SEC-04)
**Branch:** `fix/p2-01-audit-date-jsonb` · **HEAD de partida:** `775ef4f`
**Escopo:** `server/src/auditChain.ts`, `server/src/memdb.ts`, `server/src/pgstore.ts` + testes.
**Não houve merge.** Nenhum outro finding foi tocado.

> Observação de rastreio: o achado está catalogado como **P2-01 — auditoria `Date`/JSONB** nas
> listas de *out-of-scope* dos ciclos anteriores (`docs/RELATORIO-SEC-03.md` §out-of-scope,
> `docs/RELATORIO-SEC-04.md` §18, `docs/RELATORIO-FIN-01.md` §19). O arquivo
> `docs/RELATORIO-FULL-FORENSIC-AUDIT.md` **não existe neste repositório** (verificado com
> `find`); a reprodução abaixo parte do código real, não do resumo do achado.

---

## 1. Finding original

A cadeia de auditoria (`auditoria.hash` / `auditoria.hash_anterior`, tamper-evidence) era
calculada sobre o **objeto cru** do evento. Quando o payload (`dados`) continha um `Date`, o
`jsonCanônico` tratava o `Date` como um objeto comum — `Object.keys(date)` é `[]` — e assinava
`{}`. A persistência, porém, grava o `Date` como **string ISO** (o `JSON.stringify` do driver e o
`JSONB` do PostgreSQL não têm tipo nativo de data). Resultado: a assinatura da gravação e a
assinatura recalculada na **releitura** divergiam e a cadeia “quebrava” após qualquer
`Date → serialização → JSONB → leitura`.

## 2. Reprodução antes (mutação)

Com o código pré-correção (`git stash` do fix):

```
LEGADO jsonCanônico(Date) = {"de":{}}                 ← instante virou "{}"
NOVO   jsonCanônico(Date) = {"de":"2026-10-17T12:34:56.789Z"}
hash gravado (legado)  = 023ea2de0ed1f0d3
hash esperado (novo)   = 9498ae819f3810b0
linha histórica revalida pós-correção? false          ← a classe do defeito
```

Prova end-to-end (PostgreSQL real, HTTP real, banco novo):

| Prova | Pré-correção | Pós-correção |
|---|---|---|
| `server/test/p2-01-audit-date-jsonb.test.ts` (memória) | **6 pass / 11 fail** | **17 pass / 0 fail** |
| `server/test/pg/p2-01-audit-date-jsonb-pg.test.ts` (PG+HTTP) | **fail** — `quebras=[4]` | **pass** — `quebras=[]` |

## 3. Causa raiz

`jsonCanônico` (serialização canônica ordenada usada para assinar) não tinha tratamento para
`Date`. A gravação (`memdb.audit` / `pgstore.audit`) assinava o payload com o `Date` **cru**; o
`pgstore` persistia `JSON.stringify(dados)` (string ISO) e o `memdb` guardava o `Date` no Map.
Na releitura, o `pgstore` reconstrói o payload a partir do JSONB (string) e o `verificarCadeia`
recalcula o hash — que não bate. Duas rotas de criação de auditoria sofriam o mesmo defeito:
**criar** (`sanitize(data)`) e **excluir** (`sanitize(before)` — a linha inteira vinda do PG, com
`criado_em`/`atualizado_em` como `Date`).

## 4. Fluxo completo

```
operação de negócio (services.ts: createRecord / updateRecord / deleteRecord)
  → sanitize(payload)                       // pode conter Date (linha lida do PG)
  → store.audit(entry)                       // memdb OU pgstore
      → normalizarPayloadAuditoria(entry.dados)   // ← P2-01: Date → ISO-8601 UTC com ms
      → hashCadeiaAuditoria(hash_anterior, entryNormalizada)   // assina o MESMO formato persistido
      → persistência: memdb (Map) / pgstore (INSERT ... JSON.stringify(dados) → JSONB)
  → leitura: GET /api/auditoria  (listRecords)  /  GET /api/admin/auditoria/verificar
      → verificarCadeiaAuditoria(rows)          // recalcula sobre o JSONB lido
```

## 5. Formato temporal escolhido

**ISO-8601 em UTC com milissegundos** = `Date.prototype.toISOString()`, ex.
`2026-10-17T12:34:56.789Z`. É exatamente o que `JSON.stringify` e o `JSONB` já produziam — logo a
assinatura da gravação e a da releitura passam a ser **idênticas por construção**, sem migração
de formato nem nova arquitetura. Um `Date` inválido (`Invalid Date`) é **recusado explicitamente**
(`throw`), nunca descartado em silêncio. O instante é o que se preserva, não a aparência textual:
`new Date(offset).toISOString()` normaliza para o mesmo instante UTC.

## 6. Invariantes

1. Todo `Date` no payload vira ISO-8601 UTC com ms **antes** de assinar e de persistir.
2. `jsonCanônico(Date) === jsonCanônico(Date.toISOString())` (rede de segurança em `jsonCanônico`).
3. O instante sobrevive: `new Date(persistido).getTime() === original.getTime()`.
4. A ordenação da cadeia é por `id`; o instante preservado é não-decrescente.
5. Auditoria permanece **append-only** (`ops: READ_ONLY`; nenhum evento existente é reescrito).
6. `undefined` (SQL `NULL`) e `null` (JSONB `null`) continuam distintos.
7. Nenhum campo é inventado, perdido, duplicado ou reinterpretado (string temporal que não é
   `Date` permanece string; data civil `YYYY-MM-DD` não é convertida).

## 7. Timezone

Testado em processos com `TZ=UTC`, `TZ=America/Sao_Paulo` e `TZ=Asia/Tokyo`: o formato persistido
é **sempre o mesmo instante em UTC** (`2026-10-17T12:34:56.789Z`) e o `getTime()` é idêntico. O
teste confirma que os três fusos realmente divergem (offsets diferentes), ou seja, tem poder de
detecção. Offset na entrada (`-03:00`) é normalizado para o instante UTC equivalente.

## 8. Nested objects

`{ dados: { criadoEm: Date } }` → `{"dados":{"criadoEm":"2026-…Z"}}`. `normalizarPayloadAuditoria`
percorre o payload **em profundidade** (objetos e arrays recursivamente). O contrato atual suporta
objetos arbitrários no `dados`; o comportamento é consistente e provado.

## 9. Arrays

`{ eventos: [{ criadoEm: Date }, { criadoEm: Date }] }` → array de objetos com ISO. Arrays de
`Date`, arrays aninhados e múltiplos `Date` no mesmo payload (tipos mistos) são preservados.

## 10. PostgreSQL

PostgreSQL **16.14** real, banco novo, migrations reais (`migrate()`), fluxo real de auditoria e
**JSONB real**. O payload persistido é objeto JSONB (`jsonb_typeof(dados) = 'object'`) e o
`criado_em` lido do JSONB é igual ao original (`getTime()` comparado). Equivalência memória × PG:
o mesmo payload normalizado produz o **mesmo conteúdo** no JSONB e a **mesma assinatura**.

## 11. HTTP

`server/test/pg/p2-01-audit-date-jsonb-pg.test.ts` sobe o servidor real (`src/index.ts`), faz
login HTTP real (senha + TOTP, MFA do admin), cria um registro com timestamp (`POST /api/tamanhos`),
**exclui** (`DELETE /api/tamanhos/:id` — o evento carrega a linha com `Date`), lê o JSONB direto no
banco e confirma `GET /api/admin/auditoria/verificar` → `ok=true`, `quebras=[]`. Sem a correção, o
mesmo teste responde `quebras=[4]`.

## 12. Ordenação

Eventos mantêm ordem determinística por `id`; os instantes preservados permanecem em ordem
não-decrescente. A cadeia é verificada em ordem de `id` (`verificarCadeiaAuditoria`), sem
dependência do texto do timestamp.

## 13. Paginação

O feed de auditoria (`listRecords`) pagina por `id` (cursor estável, `sort: 'id'`), não por texto
temporal — a correção não altera o cursor nem a paginação. A verificação lê o feed inteiro
(`pageSize: 5000`), cobrindo o histórico sem perder eventos.

## 14. Multi-company

`server/test/pg/p2-01-audit-date-jsonb-pg.test.ts` (2º teste): empresa A gera auditoria → evento
carimbado com A; empresa B → evento carimbado com B; A não lê o evento de B (404 na leitura
cruzada); a cadeia inteira (A + B) permanece íntegra. Política de multiempresa **inalterada** — a
correção é puramente de serialização do payload.

## 15. Testes adversariais (A–Q)

`server/test/p2-01-audit-date-jsonb.test.ts` (memória) — **17 pass**:

| Caso | Cobertura | Resultado |
|---|---|---|
| invariante | `jsonCanônico(Date) === jsonCanônico(ISO)` | ✔ |
| A | Date simples | ✔ |
| B | Date com milliseconds | ✔ |
| C | Date UTC | ✔ |
| D | Date com offset | ✔ |
| D2 | epoch e virada do dia | ✔ |
| E | mudança de timezone do processo (UTC/−03/+09) | ✔ |
| F | Date aninhado | ✔ |
| G | Date em array (aninhado) | ✔ |
| H | múltiplos Dates, tipos mistos | ✔ |
| I | `null` | ✔ |
| J | campo ausente | ✔ |
| K | string temporal que NÃO é Date | ✔ |
| L | valor inválido (recusa explícita) | ✔ |
| M | leitura após round-trip JSON (≈ JSONB) | ✔ |
| N | ordenação temporal determinística | ✔ |
| Q | 25 eventos concorrentes | ✔ |

P (MemStore × PostgreSQL) e M/N reais são cobertos no arquivo PG. O (paginação) é por `id`, coberto
no fluxo HTTP.

## 16. Regressão

| Gate | Comando | Resultado |
|---|---|---|
| typecheck (domain+server+client) | `npm run typecheck` | 0 erros |
| server tests | `npm --workspace server test` | **878** tests · 812 pass · 0 fail · 66 skip · 0 todo |
| client tests | `npm --workspace client test` | **323** pass (29 arquivos) · 0 fail |
| lint | `npm run lint` | 0 erros · 409 warnings (**igual ao baseline** `775ef4f`) |
| build | `npm run build` | OK |
| audit/menu | `npm run audit:menu` | ✅ sem erros (1 aviso classificado: `/api/health` público) |
| smoke (memória) | `npm run smoke` | **126/126** |
| smoke:pg | `npm run smoke:pg` (PG novo) | **126/126** |
| **test:pg** | `npm run test:pg` (PG 16.14 novo) | **201** pass · 0 fail · 0 skip · 0 todo · **GATE PASS** |

## 17. CI

A referência final é o CI do GitHub Actions, disparado no push da branch. **Run verde** (PR #69):

| Job | Resultado |
|---|---|
| `testes-postgres` (Node 22 + PostgreSQL real) | ✅ passou — 3m07s (run `39035804861`) |
| `verificar` (typecheck/lint/testes/build) | ✅ passou — 2m05s |

Localmente o Node é 24 (reporter `spec`: `ℹ pass`), enquanto o CI usa Node 22 (TAP: `# pass`).
Essa diferença de **reporter** fez o parser local do gate imprimir `BLOCKED: resumo={}` numa
primeira execução; com `NODE_OPTIONS=--test-reporter=tap` o **mesmo** conjunto dá
`GATE PASS: 201 testes; 0 fail/skip/todo`. É o **problema de parser local já conhecido** (Node 24
× Node 22), registrado aqui e **não** alterado neste ciclo.

## 18. Arquivos alterados

| Arquivo | Mudança |
|---|---|
| `server/src/auditChain.ts` | `instanteAuditoriaISO` (formato persistido) + `normalizarPayloadAuditoria` (recursivo) + rede de segurança em `jsonCanônico` |
| `server/src/memdb.ts` | `audit()` normaliza o payload antes de assinar/gravar |
| `server/src/pgstore.ts` | `audit()` normaliza antes de assinar; preserva `undefined`→`NULL` × `null`→JSONB `null` |
| `server/test/p2-01-audit-date-jsonb.test.ts` | **novo** — adversarial A–Q (memória) |
| `server/test/pg/p2-01-audit-date-jsonb-pg.test.ts` | **novo** — PG real + HTTP real + paridade + multiempresa |
| `docs/RELATORIO-P2-01.md` | **novo** — este relatório |

## 19. Histórico afetado

**Não houve migração.** Nenhum registro existente foi alterado (auditoria é append-only). A
simulação com o `jsonCanônico` legado confirma: linhas **históricas** cujo payload continha `Date`
já estavam comprometidas **antes** da correção (o hash foi gravado com o `Date` cru → `{}`) e
**permanecem** sinalizadas pela verificação — a correção **não piora** e não mascara o passado. Só
eventos **novos** passam a revalidar corretamente. Quantificar/legitimar essas linhas antigas exigiria
uma varredura do banco de produção (fora do escopo deste ciclo, que não tem acesso ao banco real);
a decisão de migrar histórico fica **registrada como residual** (§20) e **não** foi executada —
conforme a regra do ciclo (“não fazer migração histórica ampla sem prova de necessidade”).

## 20. Residuals

1. **Histórico legado** com `Date` no `dados`: continua sinalizado pela verificação (comportamento
   honesto). A re-assinatura retroativa exigiria decisão explícita de produto e acesso ao banco de
   produção — **não** executada aqui.
2. **Parser local do gate** (`ERP-03 GATE BLOCKED: resumo={}`) sob Node 24: problema **já conhecido**
   de reporter, não alterado neste ciclo. O CI (Node 22) é a referência.
3. **Escopo do serializer:** a normalização cobre `Date`; não tenta (de propósito) cobrir outros
   tipos exóticos (ex.: `Map`/`Set`/`BigInt`) no payload de auditoria — fora do contrato atual.

---

## 20-A. Ajuste P2-01.1 — endurecer o tratamento de `Invalid Date` na assinatura

Divergência apontada na revisão independente do P2-01: `jsonCanônico()` chamava
`JSON.stringify(instanteAuditoriaISO(v))` diretamente. Para um `Date` inválido,
`instanteAuditoriaISO()` devolve `null` e `JSON.stringify(null)` é a string `"null"` — então um
`Date` inválido que chegasse pela serialização canônica era **assinado como `null`** (descartado em
silêncio), contradizendo a regra documentada de que datas inválidas nunca são descartadas
silenciosamente. `normalizarPayloadAuditoria()` já recusava, mas `jsonCanônico()` — usado por
`hashCadeiaAuditoria()` na escrita e na verificação — não.

**Correção (mínima, localizada em `auditChain.ts`):** o ramo `v instanceof Date` de
`jsonCanônico()` passa a checar o retorno de `instanteAuditoriaISO()` e **lançar**
`Error('Auditoria: instante inválido (Invalid Date) não pode ser assinado.')` quando for `null`.
Datas válidas seguem idênticas (mesmo `JSON.stringify(iso)`).

**Chamadas inspecionadas:**
- `jsonCanônico` ← `payloadAssinavel` ← `hashCadeiaAuditoria` (escrita em `memdb`/`pgstore` e
  `verificarCadeiaAuditoria`); e recursão interna (arrays/objetos aninhados).
- `hashCadeiaAuditoria` ← `memdb.audit`, `pgstore.audit`, `verificarCadeiaAuditoria`.
- Escrita já normaliza antes (`normalizarPayloadAuditoria`); o ajuste fecha o caminho da
  **assinatura** (rede de segurança) e o caminho da **verificação** direta.

**Comportamento antes × depois:**

| Entrada | Antes | Depois |
|---|---|---|
| `jsonCanônico(new Date(NaN))` | `"null"` (silencioso) | **lança** `instante inválido` |
| `jsonCanônico({ a: { b: InvalidDate } })` | `{"a":{"b":null}}` | **lança** |
| `jsonCanônico({ l: [InvalidDate] })` | `{"l":[null]}` | **lança** |
| `hashCadeiaAuditoria('', { dados: { d: InvalidDate } })` | assina `null` | **lança** |
| `jsonCanônico(Date válido)` | `"2026-…Z"` | `"2026-…Z"` (idêntico) |
| `hashCadeiaAuditoria` com datas válidas | h | **h (byte a byte igual)** |

**Testes novos (regressão):** `L2` (`jsonCanônico` recusa `Invalid Date`, aninhado e em array),
`L3` (`hashCadeiaAuditoria` recusa `Invalid Date` dentro de `dados`), `L4` (a recusa **não** altera
hashes de datas válidas — `Date` e a string ISO do mesmo instante assinam igual). Testes P2-01
existentes (datas válidas, aninhados, arrays, paridade memória/PG, integridade da cadeia)
preservados.

**Prova por mutação:** revertendo só o ramo novo de `jsonCanônico`, `L2` e `L3` **falham**
(`18 pass / 2 fail`); com o ajuste, **20 pass / 0 fail**.

**Sem alteração de hash histórico:** comparação direta entre o código do commit anterior
(`07cb84d`) e o atual, com 4 payloads válidos (Date simples, Date aninhado em array + string ISO,
`dados: null`, payload misto): **4/4 hashes idênticos** e `jsonCanônico(Date válido)` idêntico.
**Nenhuma migração** — o formato persistido não mudou.

**Resultados exatos deste ajuste:**

| Gate | Resultado |
|---|---|
| P2-01 memória (adversarial) | **20 pass · 0 fail** (17 → 20) |
| server tests | **881** tests · 815 pass · 0 fail · 66 skip · 0 todo (+3 novos) |
| client tests | **323** pass (29 arquivos) · 0 fail |
| typecheck (domain+server+client) | 0 erros |
| lint | 0 erros · 409 warnings (= baseline) |
| build | OK |
| audit:menu | ✅ sem erros (1 aviso classificado) |
| smoke / smoke:pg | **126/126** · **126/126** |
| **test:pg** (PG 16.14 novo) | **201/201 · GATE PASS** (0 fail/skip/todo) |

### 20-B. Reverificação independente do P2-01.1

O ajuste foi **reconferido do zero** nesta sessão, sem reaproveitar a evidência anterior:

- **Antes × depois (código real):** com o módulo do commit anterior (`07cb84d`) e o atual, lado a lado —
  `jsonCanônico(new Date(NaN))` passou de `"null"` (silencioso) para **lançar**
  `Auditoria: instante inválido (Invalid Date) não pode ser assinado.`; o mesmo para o caso aninhado
  (`{"a":{"b":null}}` → lança), o array (`{"l":[null]}` → lança) e
  `hashCadeiaAuditoria` com `Date` inválido em `dados` (antes devolvia um hash SHA-256 válido, agora lança).
- **Sem alteração de hash válido:** 4 payloads válidos (Date simples; Date aninhado em array + string ISO;
  `dados: null`; payload misto) → **4/4 hashes idênticos** e `jsonCanônico(Date válido)` idêntico.
  Nenhuma migração; nenhum esquema alterado.
- **Caminho de verificação:** `verificarCadeiaAuditoria` com uma linha de `Date` inválido **lança**
  (não assina `null` nem mascara a linha); uma linha válida segue `ok=true, verificadas=1, quebras=[]`.
- **Prova por mutação (independente):** revertendo **só** o ramo novo de `jsonCanônico`, os testes
  `L2` e `L3` **falham** (`18 pass / 2 fail`); restaurado, `20 pass / 0 fail`. A mutação foi desfeita
  (`git diff` limpo) antes do commit.

**Resultados exatos da reverificação:**

| Gate | Resultado |
|---|---|
| P2-01 memória (`test/p2-01-audit-date-jsonb.test.ts`) | **20 pass · 0 fail** |
| server tests | **881** tests · 815 pass · 0 fail · 66 skip · 0 todo |
| client tests | **323** pass (29 arquivos) · 0 fail |
| typecheck (domain+server+client) | 0 erros |
| lint | 0 erros · 409 warnings (= baseline) |
| build | OK |
| audit:menu | ✅ sem erros (1 aviso classificado: `/api/health` público) |
| smoke (memória) | **126/126** |
| smoke:pg (PostgreSQL real, banco novo) | **126/126** |
| **test:pg** (PostgreSQL **16.14** real, container `postgres:16.14`, banco vazio) | **201/201 · GATE PASS** (0 fail/skip/todo) |

**Nota sobre o reporter local:** sob Node 24 o parser do gate imprime
`ERP-03 GATE BLOCKED: resumo={}` mesmo com `201/201 pass` (reporter `spec`: `ℹ pass`), como já
registrado em §17 e §20. Repetindo **com Node 22** (a versão do CI) no mesmo banco novo, o resultado é
`ERP-03 GATE PASS: 201 testes PostgreSQL reais; 0 fail/skip/todo` — confirmando que era apenas o
formato do reporter. **Nenhum teste foi pulado.**

## 21. Out-of-scope (não tocado)

P0-01 portal/token público, P1-03 parcelas, P1-04 `rateLimitPublico`/XFF, P2-04 `NOT VALID`,
P2-05 advisory locks, P2-06 browser E2E, P2-08 CORS, fiscal, financeiro, Commerce, marketplace,
produção, estoque, UX e segurança fora do mecanismo de auditoria. **Nenhuma** refatoração geral de
serialização: a mudança ficou confinada ao mecanismo de auditoria (`auditChain` + os dois `audit()`).

## 22. Conclusão

A causa raiz (ausência de tratamento de `Date` na serialização canônica da cadeia) foi identificada
e corrigida **de forma localizada**, definindo o formato persistido (ISO-8601 UTC com ms) e
normalizando o payload **antes** de assinar e persistir, nos dois stores. O instante sobrevive ao
`Date → serialização → JSONB → leitura → desserialização`, com timezone/milliseconds preservados,
objetos aninhados e arrays cobertos, valores inválidos recusados explicitamente, PostgreSQL real e
HTTP real validados, ordenação determinística, multiempresa intacto e MemStore ≡ PostgreSQL.
Regressão completa verde e gate PostgreSQL **201/201**. **PR aberta, não mergeada.**
