# RELATÓRIO — SEC-03 / P1-02

## Proteção das rotas `/api/admin/*` por autorização administrativa no servidor

- **Ciclo:** SEC-03
- **Finding:** P1-02 — Rotas `/api/admin/*` sem guard administrativo
- **Base:** `main` (último ciclo merged: SEC-02 / PR #65)
- **Branch:** `fix/sec-03-admin-route-authorization`
- **Commit:** `SEC-03: protect admin routes with server-side authorization`
- **Status:** PASS
- **Merge:** NÃO MERGED (fora do escopo deste ciclo)

---

## 1. Finding original

Do FULL FORENSIC AUDIT (P1-02):

> Um perfil **gerente** consegue consultar dados globais de auditoria que
> deveriam ser restritos a administrador.

O prefixo `admin` no caminho não autoriza nada por si: a decisão precisa ser
verificada no **servidor**. Várias rotas sob `/api/admin/*` chegavam ao handler
**sem nenhuma checagem de perfil administrativo** — a única proteção era a
autenticação genérica (`requireAuth`), que qualquer conta ativa satisfaz.

### Confirmação empírica (antes da correção)

Servidor real (Express) em modo demonstração, **GERENTE** autenticado via
`POST /api/auth/login`, chamando as rotas sem qualquer truque:

| Requisição do GERENTE | Antes |
|---|---|
| `GET /api/admin/auditoria/verificar` | **200** (dados globais de auditoria) |
| `GET /api/admin/scheduled/status` | **200** |
| `GET /api/admin/notificacoes/status` | **200** |
| `GET /api/admin/ws/status` | **200** |
| `GET /api/admin/backup/info` | **200** |
| `POST /api/admin/scheduled/cron` | **200** |
| `POST /api/admin/financeiro/recorrencias` | **200** |
| `POST /api/admin/financeiro/gateway/webhooks/processar` | **200** |

O finding está reproduzido: um gerente lia dados globais de auditoria e disparava
rotinas administrativas.

---

## 2. Rotas auditadas

Todas as rotas registradas sob `/api/admin/*` (levantadas por varredura de
`server/src/*.ts`):

| # | Método | Rota | Handler | Guard ANTERIOR |
|---|--------|------|---------|----------------|
| 1 | GET | `/api/admin/auditoria/verificar` | `verificarAuditoriaHandler` | **nenhum** (só `requireAuth`) |
| 2 | GET | `/api/admin/config/endereco-publico` | `obterEnderecoPublico` | `exigirAdmin` inline (configSistema.ts) |
| 3 | PUT | `/api/admin/config/endereco-publico` | `salvarEnderecoPublico` | `exigirAdmin` inline |
| 4 | DELETE | `/api/admin/config/endereco-publico` | `removerEnderecoPublico` | `exigirAdmin` inline |
| 5 | GET | `/api/admin/scheduled/status` | `scheduledStatus` | **nenhum** |
| 6 | GET | `/api/admin/scheduled/run` | `runScheduled` | `actor.perfil !== 'admin'` inline |
| 7 | POST | `/api/admin/scheduled/cron` | `cronScheduled` | `CRON_SECRET` (fail-open sem a env) |
| 8 | GET | `/api/admin/notificacoes/status` | `notificacoesStatus` | **nenhum** |
| 9 | GET | `/api/admin/ws/status` | `wsStatus` | **nenhum** |
| 10 | GET | `/api/admin/backup` | `adminBackup` | `actor.perfil !== 'admin'` inline (backup.ts) |
| 11 | GET | `/api/admin/backup/xlsx` | `adminBackupXlsx` | `actor.perfil !== 'admin'` inline |
| 12 | GET | `/api/admin/backup/info` | `backupInfo` | **nenhum** |
| 13 | POST | `/api/admin/financeiro/recorrencias` | `cronRecorrencias` | `CRON_SECRET` (fail-open) |
| 14 | POST | `/api/admin/financeiro/gateway/webhooks/processar` | `cronWebhooks` | `CRON_SECRET` (fail-open) |

(14 entradas para 12 caminhos únicos: os 3 verbos de `config` e as 3 variantes de
`backup`.)

---

## 3. Guard anterior

Três regimes coexistiam, nenhum canônico no ponto de entrada:

1. **Nenhum guard** (rotas 1, 5, 8, 9, 12) — o buraco do P1-02. A autorização
   dependia inteiramente de `requireAuth`, que só prova *autenticação*.
2. **Checagem inline ad-hoc** (`actor.perfil !== 'admin'`) espalhada pelos
   handlers (rotas 2–4, 6, 10, 11) — funciona, mas é frágil: cada nova rota
   administrativa precisa lembrar de repetir a checagem; esquecer reabre o gap.
3. **`CRON_SECRET` fail-open** (rotas 7, 13, 14) — protegidas *por token*, e
   apenas **quando** a variável de ambiente está definida. Sem `CRON_SECRET`,
   qualquer requisição autenticada disparava o cron.

### Respostas às perguntas obrigatórias da investigação

1. **Quais endpoints estão sob `/api/admin/*`?** As 14 entradas da seção 2.
2. **Qual guard cada endpoint usa atualmente?** Ver coluna "Guard ANTERIOR".
3. **Quais endpoints deveriam ser exclusivamente ADMIN?** **Todos** os 14: são
   operações globais (auditoria consolidada, backup do banco inteiro, status de
   infra, configuração do sistema, disparo de crons).
4. **Existe endpoint `/api/admin/*` legitimamente acessível por GERENTE?**
   **Não.** Nenhum. O prefixo `admin` é reservado a operações globais; gerente
   atua no escopo das empresas concedidas, nunca na administração da plataforma.
5. **Existe rota administrativa fora de `/api/admin/*` que não deve mudar
   neste ciclo?** **Sim** — e elas **não** foram tocadas: `/api/empresas/*`
   (`exigirAdmin`), `/api/fiscal/config*` (`fiscal.ts`), `/api/gateway/*`
   (`gateway.ts`), webhooks de usuário (`webhooks.ts`) já tinham seus próprios
   guards administrativos. Corrigi-las seria revisão geral de RBAC — fora do
   escopo (ver §18).
6. **Qual é o guard canônico a reutilizar?** `requireRole('admin')`
   (`server/src/auth.ts`), já existente no projeto e — até este ciclo —
   **definido e nunca usado**. Ele deriva o perfil de `req.user` (populado por
   `requireAuth` a partir do JWT + revalidação no banco), nunca do cliente.

---

## 4. Root cause

A autorização administrativa era aplicada **por handler**, caso a caso, em vez
de no **ponto de entrada** do prefixo. Consequências:

- Rotas novas herdavam apenas `requireAuth` e ficavam expostas por omissão.
- O guard canônico (`requireRole`) existia mas estava órfão, então cada autor
  escrevia sua própria variação (`actor.perfil !== 'admin'`), com mensagens e
  formatos distintos.
- `CRON_SECRET` sem valor deixava o cron aberto a qualquer autenticado.

A causa-raiz é **ausência de um guard de prefixo**. A correção é montar o guard
canônico uma única vez sobre `/api/admin`, de forma que a regra
`AUTHENTICATION → ADMIN AUTHORIZATION → HANDLER` seja estrutural, não
lembrada rota a rota.

---

## 5. Guard canônico escolhido

`requireRole('admin')` — `server/src/auth.ts`:

```ts
export function requireRole(...roles: Perfil[]) {
  return (req, res, next) => {
    const u = currentUser(req);
    if (!u || !roles.includes(u.perfil)) {
      return res.status(403).json({ error: 'Você não tem permissão para esta ação.' });
    }
    next();
  };
}
```

Motivos da escolha:

- **Já é o canônico do projeto** (não cria um segundo sistema de autorização).
- Deriva a decisão **apenas** de `req.user.perfil`, resolvido pelo `requireAuth`
  a partir do JWT assinado **e revalidado no banco** (usuário ativo, concessões
  vigentes, sessão não revogada). Nenhum dado do cliente participa.
- Responde **403** com a mensagem canônica — o padrão já usado pelos guards
  inline do projeto.
- É um guard de **prefixo**, cobrindo rotas presentes e futuras: a omissão deixa
  de ser possível.

---

## 6. Alterações realizadas

**Único arquivo de produção alterado:** `server/src/index.ts` (+10 linhas).

```ts
app.use('/api', wrap(requireAuth));
app.use('/api', bloquearSenhaProvisoria);

// SEC-03 — TODO o prefixo /api/admin/* exige privilégio administrativo
// verificado no SERVIDOR (guard canônico requireRole, derivado da identidade
// autenticada do JWT/sessão — nunca de role/perfil/empresa_id do cliente).
app.use('/api/admin', requireRole('admin'));
```

Mais o import do `requireRole` a partir de `./auth`.

Nenhum handler, query, política de multiempresa ou contrato de API foi
modificado. Os guards inline pré-existentes permanecem (defesa em profundidade);
o guard de prefixo é avaliado **antes** deles.

**Ordem de middleware (garantida pela posição no `index.ts`):**

```
REQUEST
  ↓ requireAuth            (401 se não autenticado)
  ↓ bloquearSenhaProvisoria
  ↓ requireRole('admin')   (403 se autenticado sem privilégio)   ← SEC-03
  ↓ handler
```

---

## 7. Endpoints afetados

Os 14 endpoints da seção 2. Efeito por regime anterior:

- **Rotas 1, 5, 8, 9, 12** (sem guard): passaram de **acesso livre para
  qualquer autenticado** para **403 não-admin**. É a correção do finding.
- **Rotas 2–4, 6, 10, 11** (inline): comportamento idêntico para o cliente; o
  bloqueio agora ocorre antes (no prefixo), mantendo o inline como redundância.
- **Rotas 7, 13, 14** (`CRON_SECRET`): agora **exigem admin além do token**.
  Sem `CRON_SECRET`, deixam de ser abertas a qualquer autenticado.

---

## 8. Matriz de autorização

`PASS` = chega ao handler (comportamento legítimo). `403` = bloqueio no guard.
`401` = bloqueio no `requireAuth`.

| Endpoint | ADMIN | GERENTE | OPERADOR | ANÔNIMO |
|----------|-------|---------|----------|---------|
| `GET /api/admin/auditoria/verificar` | PASS | 403 | 403 | 401 |
| `GET /api/admin/config/endereco-publico` | PASS | 403 | 403 | 401 |
| `PUT /api/admin/config/endereco-publico` | PASS¹ | 403 | 403 | 401 |
| `DELETE /api/admin/config/endereco-publico` | PASS¹ | 403 | 403 | 401 |
| `GET /api/admin/scheduled/status` | PASS | 403 | 403 | 401 |
| `GET /api/admin/scheduled/run` | PASS | 403 | 403 | 401 |
| `POST /api/admin/scheduled/cron` | PASS | 403 | 403 | 401 |
| `GET /api/admin/notificacoes/status` | PASS | 403 | 403 | 401 |
| `GET /api/admin/ws/status` | PASS | 403 | 403 | 401 |
| `GET /api/admin/backup` | PASS | 403 | 403 | 401 |
| `GET /api/admin/backup/xlsx` | PASS | 403 | 403 | 401 |
| `GET /api/admin/backup/info` | PASS | 403 | 403 | 401 |
| `POST /api/admin/financeiro/recorrencias` | PASS | 403 | 403 | 401 |
| `POST /api/admin/financeiro/gateway/webhooks/processar` | PASS | 403 | 403 | 401 |

¹ `PASS` = o guard deixa passar; o handler de escrita ainda exige reautenticação
recente / senha definitiva (regras próprias do handler, inalteradas). Na prova
HTTP real o admin troca a senha provisória e o resultado é 200 (seção 10).

---

## 9. Testes adversariais

### 9.1 Unidade do guard — `server/test/sec03-admin-guard.test.ts` (9 testes)

| Caso | Resultado |
|------|-----------|
| A) ADMIN → `next()` chamado, sem resposta de erro | PASS |
| B) GERENTE → 403 | PASS |
| C) OPERADOR → 403 | PASS |
| D) sem usuário → 403 no guard (o 401 vem do `requireAuth` antes) | PASS |
| Perfil desconhecido/ausente (`superadmin`, `ADMIN`, `root`…) não vira admin | PASS |
| E) spoofing de corpo (`role`, `perfil`, `empresa_id`, `is_admin`) ignorado | PASS |
| E) spoofing de query (`role`, `perfil`, `consolidado`, `admin`) ignorado | PASS |
| E) spoofing de headers (`x-perfil`, `x-role`, `role`, `x-admin`…) ignorado | PASS |
| E) parâmetro de rota (`"admin"` no caminho) não autoriza | PASS |

### 9.2 Adversarial fim-a-fim — `server/test/pg/sec03-admin-routes-authorization.test.ts`

Teste **real** com PostgreSQL: sobe o servidor de verdade e percorre
`HTTP → requireAuth → requireRole('admin') → rota → handler → PostgreSQL`, sem
`req.user` injetado. Falha (não “skipa”) sem `DATABASE_URL`.

| Caso | Descrição | Resultado |
|------|-----------|-----------|
| A) | ADMIN acessa os 14 endpoints (`PASS`; config-write respeita regra do handler) | PASS |
| B) | GERENTE → 403 em **todos** os 14 endpoints admin-only | PASS |
| C) | OPERADOR → 403 em todos os 14 | PASS |
| D) | ANÔNIMO → 401 em todos os 14 | PASS |
| E) | spoofing de headers + query + corpo (POST `scheduled/cron`) → 403 | PASS |
| F) | cross-tenant: gerente da empresa B (com `?empresa_id=1`, `?consolidado=1`) → 403; ADMIN global → 200 | PASS |
| G) | regressão: GERENTE em `/meta`, `/dashboard`, `/produtos` → 200 | PASS |

O teste asserta também que o corpo do 403 **não** contém o payload de auditoria
(o handler não é executado).

---

## 10. Teste HTTP real

Evidência capturada pelo teste PG (gerente autenticado via `POST /api/auth/login`):

```
A) ADMIN   GET  /admin/auditoria/verificar              → 200
A) ADMIN   POST /admin/scheduled/cron                    → 200
A) ADMIN   GET  /admin/backup                            → 200
B) GERENTE GET  /admin/auditoria/verificar               → 403
B) GERENTE GET  /admin/scheduled/status                  → 403
B) GERENTE GET  /admin/notificacoes/status               → 403
B) GERENTE GET  /admin/ws/status                         → 403
B) GERENTE GET  /admin/backup/info                       → 403
B) GERENTE POST /admin/scheduled/cron                    → 403
B) GERENTE POST /admin/financeiro/recorrencias           → 403
C) OPERADOR GET /admin/auditoria/verificar               → 403
D) ANÔNIMO  GET /admin/auditoria/verificar               → 401
E) GERENTE  GET /admin/auditoria/verificar + x-perfil=admin → 403
F) GERENTE(B) GET /admin/auditoria/verificar?empresa_id=1 → 403
F) ADMIN   GET  /admin/auditoria/verificar (global)      → 200
```

Contraste antes/depois pelo mesmo token de gerente (servidor real):

| Requisição | Antes | Depois |
|---|---|---|
| `GET /api/admin/auditoria/verificar` | 200 | **403** |
| `GET /api/admin/scheduled/status` | 200 | **403** |
| `GET /api/admin/notificacoes/status` | 200 | **403** |
| `GET /api/admin/ws/status` | 200 | **403** |
| `GET /api/admin/backup/info` | 200 | **403** |
| `POST /api/admin/scheduled/cron` | 200 | **403** |

O bloqueio ocorre **no servidor**, com o handler nunca executado.

---

## 11. PostgreSQL

Executado com o gate oficial do projeto:

```
npm run test:pg   (DATABASE_URL em banco NOVO e vazio, PostgreSQL 16.14)
```

- Preflight do gate: `PostgreSQL 160014; relações públicas 0` ✅.
- Resultado da suíte: **195 pass, 0 fail, 0 cancelled, 0 skipped, 0 todo**.
- Inclui `SEC-03/P1-02: /api/admin/* exige administrador (HTTP real + PostgreSQL)` ✅.

**Ressalva de ferramenta (ver §17):** o parser de resumo do script
`scripts/test-pg-gate.mjs` espera o formato TAP (`# pass N`) mas o Node 24 emite
o formato spec (`ℹ pass N`), então o gate imprime `resumo={}` e "GATE BLOCKED"
apesar do runner ter saído com código 0 e a suíte estar 100% verde. Isso é
**pré-existente** e **não** foi introduzido por este ciclo (o script não foi
tocado; reproduzido com um teste trivial).

Na primeira execução do gate, `test/pg-p0-commerce-tenant.test.ts` falhou com
`duplicate key ... "sales_reference_key"` — teste de ingestão de commerce, que
**não importa `index.ts` nem toca rotas admin**. Reproduzido em isolamento:
**2 falhas em 3 execuções** → **flaky pré-existente** (corrida no dedup
concorrente). Na re-execução completa o teste passou.

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
✅ 0 errors, 409 warnings (todos pré-existentes: `no-explicit-any` e variáveis
não usadas em arquivos não tocados).

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
✅ **126/126 verificações OK** — inclui "sem token → 401" e "ticket de MFA não
vale como token de acesso → 401".

---

## 16. Regressões

| Gate | Resultado |
|------|-----------|
| `npm --workspace server test` | 750 pass, 0 fail, 66 skipped (PG-gated, pré-existentes) |
| `npm --workspace client test` | 323 pass (29 arquivos), 0 fail |
| `npm run typecheck` | ✅ 0 erros |
| `npm run lint` | ✅ 0 erros |
| `npm run build` | ✅ |
| `npm run smoke` | ✅ 126/126 |
| `npm run test:pg` | 195 pass, 0 fail (ver §11) |
| `npm run audit:menu` | ✅ sem erros (1 aviso pré-existente: `/api/health` pública por design) |

Rotas não administrativas seguem funcionando para os perfis que já tinham
autorização (prova G do teste PG: `/meta`, `/dashboard`, `/produtos` → 200 para
gerente).

---

## 17. Residuals

Registrados, **não corrigidos** neste ciclo (fora do escopo SEC-03):

1. **Parser de resumo do gate PG** (`scripts/test-pg-gate.mjs`): formato TAP vs
   spec do Node 24 → `resumo={}` e falso "BLOCKED". A suíte está verde. Correção
   de ferramenta, não do finding.
2. **`test/pg-p0-commerce-tenant.test.ts` flaky** (corrida em
   `sales_reference_key` no dedup concorrente de `sales.service.ts`). Pré-existente,
   alheio a `/api/admin/*`.
3. **Guards inline duplicados** (`actor.perfil !== 'admin'` em `backup.ts`,
   `configSistema.ts`, `gateway.ts`, `fiscal.ts`, `scheduled.ts`, `empresasApi.ts`)
   poderiam migrar para `requireRole` numa futura consolidação de RBAC — mas isso
   seria revisão geral, fora do escopo.
4. **`CRON_SECRET` fail-open**: com o guard de prefixo, o cron já exige admin,
   então o fail-open deixou de ser um buraco. Endurecer o cron para exigir o
   segredo **sempre** (fail-closed) fica como melhoria residual.

---

## 18. Out-of-scope

Explicitamente **não** tratados neste ciclo (STRICT SCOPE):

- SEC-04 catálogo/RBAC; FIN-01 parcelas; `rateLimitPublico`; portal XFF;
  token público de arquivos; auditoria `Date`/JSONB; `NOT VALID`; advisory
  locks; CORS; browser E2E; fiscal; financeiro; UX; Commerce; marketplace;
  produção; estoque; qualquer P2/P3 não diretamente necessário.
- Política de multiempresa: **inalterada**. Nenhuma query passou a filtrar
  `empresa_id`; a pergunta respondida foi *"quem pode executar?"*, não *"como
  limitar à empresa atual?"*.

---

## 19. Critério de aceitação

- [x] todas as `/api/admin/*` auditadas (14 endpoints)
- [x] guard canônico identificado (`requireRole('admin')`)
- [x] rotas realmente administrativas protegidas
- [x] ADMIN continua funcionando
- [x] GERENTE não acessa endpoint ADMIN-only (403)
- [x] OPERADOR não acessa (403)
- [x] anônimo não acessa (401)
- [x] spoofing não eleva privilégio
- [x] multiempresa não degradada
- [x] HTTP real testado
- [x] PostgreSQL real testado (195 pass; ressalva de parser em §17)
- [x] regressões verdes
- [x] nenhum finding fora do escopo corrigido
- [x] relatório criado
- [x] working tree limpa
- [x] branch publicada
- [x] PR aberta
- [x] PR NÃO merged
