# RELATÓRIO — SEC-04 / P1-01

## RBAC no catálogo compartilhado (`categorias`, `cores`, `grades`, `tamanhos`)

- **Ciclo:** SEC-04
- **Finding:** P1-01 — Catálogo único compartilhado, criável/editável por qualquer perfil
- **Base:** `main` (último ciclo merged: FIN-01 / PR #67)
- **Branch:** `fix/sec-04-catalog-rbac`
- **Commit:** `SEC-04: enforce write RBAC on shared catalog`
- **Status:** PASS
- **Merge:** NÃO MERGED (fora do escopo deste ciclo)

---

## 1. Finding original

Do FULL FORENSIC AUDIT (PR #63, finding **P1-01**):

> **Recursos globais (`categorias`, `cores`, `grades`, `tamanhos`) são catálogo
> único compartilhado, criável/editável por qualquer perfil.**
>
> - **ARQUIVO:** `server/src/resources.ts` — `categorias`, `cores`, `grades`,
>   `tamanhos`: sem `empresa:true`, sem `minPerfil`, `ops: ALL_OPS`.
> - **CAUSA:** decisão de design de "catálogo compartilhado" (legítima em muitos
>   ERPs) porém **sem RBAC** — qualquer operador de qualquer empresa
>   cria/renomeia/exclui categorias que afetam a nomenclatura global.
> - **CENÁRIO:** `gerente.a` (empresa 1) cria `POST /api/categorias` → 201;
>   renomeia categoria → 200.
> - **IMPACTO:** envenenamento de catálogo mestre entre empresas; `DELETE` de
>   categoria em uso por outra empresa pode quebrar relatórios/produtos alheios.
> - **RECOMENDAÇÃO:** confirmar intenção de negócio; se compartilhado, exigir
>   `minPerfil:'gerente'` + auditoria de autor.
> - **NÃO CORRIGIR** (o PR de auditoria era AUDIT ONLY).

### Confirmação empírica (antes da correção)

Servidor real (Express) em modo demonstração, **OPERADOR** autenticado via
`POST /api/auth/login`, chamando as rotas sem qualquer truque:

| Requisição do OPERADOR | Antes |
|---|---|
| `POST /api/categorias` | **201** (cria categoria global) |
| `PUT /api/categorias/:id` | **200** (renomeia categoria global) |
| `POST /api/cores` | **201** |
| `POST /api/grades` | **201** |
| `POST /api/tamanhos` | **201** |

O finding está reproduzido: um operador reescrevia a nomenclatura que vale para
**todas** as empresas. (O `DELETE` já era barrado por uma regra genérica de
perfil; o furo estava em incluir/alterar.)

---

## 2. Rotas auditadas

O catálogo compartilhado **não** tem rota dedicada: é servido pelo CRUD genérico
de `/api/:resource` (`server/src/index.ts`), cujo guard é `checkAccess(r, actor,
op)` — o ponto único de autorização de recursos.

| # | Método | Rota | Recurso | Guard ANTERIOR |
|---|--------|------|---------|----------------|
| 1 | GET | `/api/categorias` | categorias | `checkAccess(read)` — aberto |
| 2 | GET | `/api/categorias/options` | categorias | `checkAccess(read)` — aberto |
| 3 | POST | `/api/categorias` | categorias | `checkAccess(create)` — **sem piso de perfil** |
| 4 | PUT | `/api/categorias/:id` | categorias | `checkAccess(update)` — **sem piso de perfil** |
| 5 | DELETE | `/api/categorias/:id` | categorias | `checkAccess(delete)` — operador barrado (regra genérica) |
| 6–10 | idem | `/api/cores*` | cores | igual a categorias |
| 11–15 | idem | `/api/grades*` | grades | igual a categorias |
| 16–20 | idem | `/api/tamanhos*` | tamanhos | igual a categorias |

Caminhos únicos: 4 recursos × 5 operações (list, options, get, create, update,
delete — list e options compartilham o mesmo handler de leitura).

### Respostas às perguntas obrigatórias da investigação

1. **Quais endpoints estão sob o catálogo?** Os 4 recursos globais
   `categorias`, `cores`, `grades`, `tamanhos`, servidos pelo CRUD genérico
   (`GET/POST /api/:resource`, `PUT/DELETE /api/:resource/:id`,
   `GET /api/:resource/options`).
2. **Qual guard cada endpoint usa atualmente?** `checkAccess(r, actor, op)` em
   todas as rotas. Antes deste ciclo ele só validava `minPerfil`/`adminOnly`/
   `ops` — e os 4 recursos não declaravam `minPerfil`.
3. **Quais endpoints deveriam ser exclusivamente ADMIN?** **Nenhum.** O catálogo
   é compartilhado (decisão de negócio legítima); gerente é o dono natural do
   cadastro mestre. ADMIN continua acima de gerente.
4. **Existe algum endpoint legitimamente acessível por OPERADOR?** **Sim — a
   LEITURA.** Telas operacionais (vendas, compras, estoque, inventário, ordens,
   expedição) consomem `/options` e listagens desses recursos. Fechar a leitura
   quebraria o operador. O furo é a **escrita**.
5. **Existe rota administrativa fora do catálogo que não deve mudar neste
   ciclo?** **Sim** — e não foi tocada: `/api/admin/*` (SEC-03), `/api/empresas/*`
   (ERP-07, `adminOnly`), `/api/usuarios/*`, `/api/impostos_ncm` (global,
   `minPerfil:'gerente'`). Nenhuma foi alterada.
6. **Qual é o guard canônico a reutilizar?** `checkAccess(r, actor, op)`
   (`server/src/services.ts`) — o ponto único de autorização de recursos, que já
   usa `minPerfil`/`adminOnly`/`ops`. Estendi-o com um **piso de escrita**
   (`minPerfilEscrita`) em vez de criar um segundo sistema.

---

## 3. Guard anterior

O CRUD genérico aplica `checkAccess` corretamente, mas os 4 recursos do catálogo
não declaravam nenhum piso de perfil:

```ts
// resources.ts — categorias, cores, grades, tamanhos
ops: ALL_OPS,          // create/update/delete liberados
// (sem empresa:true — é global por design)
// (sem minPerfil, sem adminOnly)
```

E `checkAccess` só barrava:

```ts
if (r.minPerfil && ...)  throw 403;   // nunca disparava: minPerfil ausente
if (r.adminOnly && ...)  throw 403;   // nunca disparava
if (op === 'delete' && actor.perfil === 'operador') throw 403;  // só delete
```

Resultado: **qualquer perfil autenticado** criava/alterava a nomenclatura
global. O `delete` de operador já era barrado por uma regra genérica — o que
mascarava parcialmente o furo.

---

## 4. Root cause

A autorização de recursos é centralizada em `checkAccess`, mas o modelo
`Resource` só expressava um **piso único de acesso** (`minPerfil`), que se
aplicaria a **leitura e escrita**. Para o catálogo compartilhado isso é errado:
a leitura precisa ser aberta (telas operacionais) e a escrita restrita.

Faltava, portanto, uma dimensão de autorização: **piso por operação de
escrita**. Sem ela, a única alternativa seria fechar o recurso inteiro
(`minPerfil`), degradando a operação, ou adicionar checagens inline rota a rota
— exatamente o anti-padrão que a SEC-03 corrigiu em `/api/admin/*`.

A causa-raiz é **ausência de piso de escrita no schema de recursos**. A correção
é declarativa e central: um campo `minPerfilEscrita` no `Resource`, aplicado no
`checkAccess`.

---

## 5. Guard canônico escolhido

`checkAccess(r, actor, op)` — `server/src/services.ts`, com um piso novo
`minPerfilEscrita` no `Resource`:

```ts
// resources.ts
minPerfilEscrita?: 'gerente' | 'admin';

// services.ts — dentro de checkAccess
if (op !== 'read' && r.minPerfilEscrita
    && (PERFIL_RANK[perfil] ?? 0) < PERFIL_RANK[r.minPerfilEscrita]) {
  throw new HttpError(403, r.minPerfilEscrita === 'admin'
    ? 'Apenas administradores podem incluir, alterar ou excluir este cadastro compartilhado.'
    : 'Apenas gerentes e administradores podem incluir, alterar ou excluir este cadastro compartilhado.');
}
```

Motivos da escolha:

- **É o canônico do projeto** — não cria um segundo sistema de autorização.
- Deriva a decisão **apenas** de `actor.perfil`, que vem da identidade
  autenticada (`req.user`, populado por `requireAuth` a partir do JWT assinado e
  revalidado no banco). Nenhum dado do cliente participa.
- Responde **403** com a mensagem canônica — o mesmo padrão dos demais guards.
- É **declarativo**: o recurso diz o piso de escrita; a regra vale para
  `create`, `update` e `delete` de uma só vez, presente e futuro.
- **Não afeta a leitura** (`op !== 'read'`), preservando o operador.

---

## 6. Alterações realizadas

### Servidor (autorização real)

- `server/src/resources.ts` (+17): campo `minPerfilEscrita` no tipo `Resource`;
  `minPerfilEscrita: 'gerente'` em `tamanhos`, `grades`, `categorias`, `cores`.
- `server/src/services.ts` (+11): enforcement do piso em `checkAccess`.

### Cliente (espelho de UI — a barreira real é a API)

- `client/src/lib/meta.ts`: `minPerfilEscrita` no `ResourceMeta`.
- `client/src/pages/ModulePage.tsx`: `perfilOkEscrita` desabilita os botões de
  escrita para operador nos 4 recursos.
- `client/src/pages/MedidasPage.tsx`: `useAuth` + `podeEditar`; a página grava em
  `grades` (agora gerente+), então os controles de escrita (salvar, copiar,
  editar células/colunas, instruções) são ocultados para operador.

**Nenhuma** query, política de multiempresa, contrato de API, guard de
`/api/admin/*` ou RBAC existente foi modificado.

---

## 7. Endpoints afetados

| Endpoint | Efeito |
|---|---|
| `POST /api/{categorias,cores,grades,tamanhos}` | operador: **201 → 403** |
| `PUT/PATCH /api/{...}/:id` | operador: **200 → 403** |
| `DELETE /api/{...}/:id` | operador: 403 (já era; agora pelo piso de escrita) |
| `GET /api/{...}` e `/options` | **inalterado** (aberto a todos os perfis) |
| `POST/PUT/DELETE` para GERENTE/ADMIN | **inalterado** (200/201) |

---

## 8. Matriz de autorização

`PASS` = chega ao handler (comportamento legítimo). `403` = bloqueio no guard.
`401` = bloqueio no `requireAuth`.

| Endpoint | ADMIN | GERENTE | OPERADOR | ANÔNIMO |
|----------|-------|---------|----------|---------|
| `GET /api/categorias` (+ `/options`) | PASS | PASS | PASS | 401 |
| `POST /api/categorias` | PASS | PASS | 403 | 401 |
| `PUT /api/categorias/:id` | PASS | PASS | 403 | 401 |
| `DELETE /api/categorias/:id` | PASS | PASS | 403 | 401 |
| `GET /api/cores` (+ `/options`) | PASS | PASS | PASS | 401 |
| `POST /api/cores` | PASS | PASS | 403 | 401 |
| `PUT /api/cores/:id` | PASS | PASS | 403 | 401 |
| `DELETE /api/cores/:id` | PASS | PASS | 403 | 401 |
| `GET /api/grades` (+ `/options`) | PASS | PASS | PASS | 401 |
| `POST /api/grades` | PASS | PASS | 403 | 401 |
| `PUT /api/grades/:id` | PASS | PASS | 403 | 401 |
| `DELETE /api/grades/:id` | PASS | PASS | 403 | 401 |
| `GET /api/tamanhos` (+ `/options`) | PASS | PASS | PASS | 401 |
| `POST /api/tamanhos` | PASS | PASS | 403 | 401 |
| `PUT /api/tamanhos/:id` | PASS | PASS | 403 | 401 |
| `DELETE /api/tamanhos/:id` | PASS | PASS | 403 | 401 |

---

## 9. Testes adversariais

### 9.1 Unidade do guard — `server/test/sec04-catalogo-compartilhado-rbac.test.ts` (5 testes)

Harness em memória (`_p1util`), contrato do `checkAccess`:

| Caso | Resultado |
|------|-----------|
| Recursos declaram `minPerfilEscrita:'gerente'` e **não** `minPerfil`/`adminOnly` (leitura aberta) | PASS |
| OPERADOR lê (`read`) mas é 403 em `create`/`update`/`delete` nos 4 recursos | PASS |
| GERENTE e ADMIN passam em todas as operações | PASS |
| E) spoofing: ator com `role`/`is_admin`/`admin`/`perfil_admin` forjados não eleva; operador da empresa B também 403 | PASS |
| Escrita real via serviço: operador 403 (sem gravar); gerente cria/altera/exclui; operador lê | PASS |

### 9.2 Adversarial fim-a-fim — `server/test/pg/sec04-catalogo-compartilhado-rbac.test.ts`

Teste **real** com PostgreSQL: sobe o servidor de verdade e percorre
`HTTP → requireAuth → checkAccess (guard da rota) → handler → PostgreSQL`, sem
`req.user` injetado. Falha (não “skipa”) sem `DATABASE_URL`.

| Caso | Descrição | Resultado |
|------|-----------|-----------|
| A) | ADMIN: CRUD completo nos 4 recursos → 201/200/200 | PASS |
| B) | GERENTE: CRUD completo nos 4 recursos → 201/200/200 | PASS |
| C) | OPERADOR: `create/update/delete` → 403; `GET` e `/options` → 200 | PASS |
| D) | ANÔNIMO: `GET`/`POST` → 401 | PASS |
| E) | spoofing (headers `x-perfil`/`x-role`/`role`/`x-admin` + query + corpo) → 403 | PASS |
| F) | cross-tenant: operador da empresa B (com `?empresa_id=1`, `?consolidado=1`) → 403; leitura → 200; ADMIN global → 201 | PASS |
| G) | regressão: OPERADOR em `/meta`, `/produtos`, `/clientes/options` → 200 | PASS |

### 9.3 Controle negativo (a prova de que o teste detecta o furo)

Desabilitando **temporariamente** o piso (`if (false && ...)` em `checkAccess`) e
re-executando o teste PG, a asserção C falha exatamente como o finding:

```
✖ OPERADOR POST /categorias deve ser 403: {"nome":"Categoria SEC-04 …","id":3,…}
  201 !== 403
```

Com o guard restaurado, o teste volta a passar. O teste **prova** o
comportamento, não apenas o descreve.

---

## 10. Teste HTTP real

Evidência capturada pelo teste PG (operador autenticado via `POST /api/auth/login`):

```
A) ADMIN   POST   /categorias → 201 ; PUT → 200 ; DELETE → 200
B) GERENTE POST   /categorias → 201 ; PUT → 200 ; DELETE → 200
C) OPERADOR POST  /categorias → 403 ; GET /categorias → 200 ; GET /categorias/options → 200
C) OPERADOR PUT   /cores/:id  → 403 ; DELETE /cores/:id → 403
D) ANÔNIMO GET    /tamanhos   → 401 ; POST /tamanhos → 401
E) OPERADOR POST  /categorias?perfil=admin&role=admin&is_admin=true&empresa_id=1 + headers → 403
F) OPERADOR(B) POST /categorias?empresa_id=1 → 403 ; GET /tamanhos/options → 200
F) ADMIN   POST   /cores (global) → 201
G) OPERADOR GET   /meta, /produtos, /clientes/options → 200
```

Contraste antes/depois pelo mesmo token de operador (servidor real):

| Requisição | Antes | Depois |
|---|---|---|
| `POST /api/categorias` | 201 | **403** |
| `PUT /api/categorias/:id` | 200 | **403** |
| `POST /api/cores` | 201 | **403** |
| `POST /api/grades` | 201 | **403** |
| `POST /api/tamanhos` | 201 | **403** |
| `GET /api/categorias/options` | 200 | 200 (inalterado) |

O bloqueio ocorre **no servidor**, com o handler nunca executado.

---

## 11. PostgreSQL

Executado com o gate oficial do projeto:

```
npm run test:pg   (DATABASE_URL em banco NOVO e vazio, PostgreSQL 16.14)
```

- Preflight do gate: `PostgreSQL 160014; relações públicas 0` ✅.
- Resultado da suíte completa: **199 pass, 0 fail, 0 cancelled, 0 skipped,
  0 todo** (plano `1..163` no nível de arquivo; 199 contando os subtests).
- Inclui `ok 162 - SEC-04/P1-01: catálogo compartilhado exige gerente+ para
  ESCREVER (HTTP real + PostgreSQL)` ✅.

**Ressalva de ferramenta (ver §17):** no ambiente local (Node 24) o parser de
resumo do `scripts/test-pg-gate.mjs` espera o formato TAP (`# pass N`) mas o
Node 24 emite o formato spec (`ℹ pass N`) → `resumo={}` e falso "GATE BLOCKED",
apesar do runner sair com código 0 e a suíte estar 100% verde. O script não foi
tocado por este ciclo. (Mesmo artefato documentado na SEC-03 §17.)

---

## 12. Typecheck

```
npm run typecheck   (domain + server + client)
```
✅ 0 erros.

---

## 13. Lint

```
npm run lint
```
✅ 0 errors, 409 warnings (todos pré-existentes: `no-explicit-any` em arquivos
não tocados).

---

## 14. Build

```
npm run build   (client, Vite + PWA)
```
✅ Build concluído (59 entries no precache).

---

## 15. Smoke

```
npm run smoke   (servidor real, modo demonstração)
```
✅ **126/126 verificações OK**.

---

## 16. Regressões

| Gate | Resultado |
|------|-----------|
| `npm --workspace server test` (sem `DATABASE_URL`) | 795 pass, 0 fail, 66 skipped (PG-gated, pré-existentes) |
| `npm --workspace client test` | 323 pass (29 arquivos), 0 fail |
| `npm run typecheck` | ✅ 0 erros |
| `npm run lint` | ✅ 0 erros |
| `npm run build` | ✅ |
| `npm run smoke` | ✅ 126/126 |
| `npm run test:pg` | 199 pass, 0 fail (ver §11) |
| `npm run audit:menu` | ✅ sem erros (1 aviso pré-existente: `/api/health` pública por design) |

Rotas não administrativas e leitura do catálogo seguem funcionando para os
perfis que já tinham autorização (prova G e prova C do teste PG).

---

## 17. Residuals

Registrados, **não corrigidos** neste ciclo (fora do escopo SEC-04):

1. **Parser de resumo do gate PG** (`scripts/test-pg-gate.mjs`): no Node 24 local
   o formato spec substitui o TAP → `resumo={}` e falso "BLOCKED". A suíte está
   verde. Correção de ferramenta, não do finding. (Herdado da SEC-03 §17.)
2. **Flaky pré-existente em `test/pg/e01-gateway-webhook-postgresql.test.ts`**:
   `deadlock detected (40P01)` no provisionamento de tenant sob concorrência.
   Alheio ao catálogo compartilhado; apareceu uma vez em execução paralela e não
   se reproduziu. (Ver §19.)
3. **`minPerfilEscrita` não foi aplicado a outros cadastros globais** (ex.:
   `impostos_ncm`, que já usa `minPerfil:'gerente'`). Consolidação futura, fora
   do escopo.
4. **Auditoria de autor por tenant** no catálogo global: a recomendação do
   finding menciona "auditoria de autor". O store já registra `criado_por`/
   `usuario_id` quando os campos existem; o catálogo global não declara coluna
   de empresa (por design). Rastreio por tenant é evolução de modelo, não RBAC.

---

## 18. Out-of-scope

Explicitamente **não** tratados neste ciclo (STRICT SCOPE):

- SEC-04 é **este** ciclo; os demais findings permanecem intocados: SEC-03
  (merged), FIN-01 (merged), P1-04 `rateLimitPublico`/XFF, P0-01 portal/token
  público, P1-03 parcelas, P2-01 auditoria `Date`/JSONB, P2-04 `NOT VALID`,
  P2-05 advisory locks, P2-06 browser E2E, P2-08 CORS, fiscal, financeiro, UX,
  Commerce, marketplace, produção, estoque.
- Política de multiempresa: **inalterada**. O catálogo é global por design;
  nenhuma query passou a filtrar `empresa_id`. A pergunta respondida foi *"quem
  pode escrever?"*, não *"como limitar à empresa atual?"*.
- RBAC existente: **inalterado** além do piso de escrita novo.

---

## 19. CI

PR #68 — checks do GitHub Actions (GitHub-hosted):

| Commit | Check | Resultado |
|--------|-------|-----------|
| `3c31839` | `verificar` (×2) | ✅ success |
| `3c31839` | `testes-postgres` (×2) | ✅ success |

**4/4 checks verdes.** Inclui os dois jobs `testes-postgres`, que rodam a suíte
PostgreSQL real com o gate oficial — inclusive o SEC-04.

---

## 20. Critério de aceitação

- [x] todas as superfícies do catálogo auditadas (4 recursos × 5 operações)
- [x] guard canônico identificado (`checkAccess` + `minPerfilEscrita`)
- [x] escrita realmente protegida (gerente+)
- [x] ADMIN continua funcionando
- [x] GERENTE continua funcionando (dono do cadastro mestre)
- [x] OPERADOR não escreve (403)
- [x] anônimo não acessa (401)
- [x] spoofing não eleva privilégio
- [x] multiempresa não degradada
- [x] HTTP real testado
- [x] PostgreSQL real testado (199 pass; ressalva de parser em §17)
- [x] regressões verdes
- [x] nenhum finding fora do escopo corrigido
- [x] relatório criado
- [x] working tree limpa
- [x] branch publicada
- [x] PR aberta (#68)
- [x] PR NÃO merged
