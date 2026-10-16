# RELATÓRIO — AUDITORIA FORENSE INTEGRAL DO SISTEMA (BROBOND ERP)

- **Repositório:** petrickmsilva-alt/brobond-erp
- **Base:** main @ `a36334a` (Merge PR #62, UX-05)
- **Método:** AUDIT ONLY — READ ONLY. Nenhuma correção implementada, nenhum schema/migration/CI/dependência alterado.
- **Data:** 2026-10-16
- **Ambiente de prova:** API real (`node --import tsx server/src/index.ts`, PORT=3999) em modo PostgreSQL real (`DATABASE_URL=…brobond_live`, PostgreSQL 16) **e** modo demonstração (memória). Harness HTTP real em `/tmp/f1` (removido ao final), `psql` real, `EXPLAIN`/constraints reais.

> **Aviso de retratação (integridade de auditoria).** Uma rodada preliminar (usuário `admin@brobond.com.br`, que possui `pode_consolidar=true`) aparentou vazamento cross-tenant em `/api/:resource/export` e `/api/options` ao injetar `f.empresa_id=2`. A re-verificação com usuário **não-consolidante** (`titular.a`, `pode_consolidar=false`, `empresas=[1]`) provou que `aplicarFiltroEmpresa` **sobrescreve** o filtro do cliente com o escopo do ator (`empresa.ts` L186-196). Portanto esses achados foram **retratados como VERIFIED SAFE** com evidência. O que permanece como vulnerável é o que segue abaixo.

---

## 1. EXECUTIVE SUMMARY

O BroBond ERP é uma base surpreendentemente disciplinada em pontos críticos: isolamento por transação (`SERIALIZABLE`), ausência de float em dinheiro, proteção real contra oversell/dupla-faturamento/dupla-conclusão de OP/duplo fechamento de caixa, cadeia de auditoria com lock de advisório, validação de CPF, rate-limit de login, e HSTS/CSP. Isso **não** é um sistema frágil por descuido geral.

Entretanto, a auditoria encontrou **1 P0 confirmado**, um conjunto de **P1 confirmados** e uma longa cauda de P2/P3. O achado mais grave é um **IDOR/BOLA confirmado no subsistema de fotos/anexos**: qualquer usuário autenticado de uma empresa pode **listar, baixar, injetar e excluir** fotos de registros de **outra empresa**, ignorando completamente o escopo multiempresa — e o download final (`/api/files/:id/:token`) é **público** (montado antes do `requireAuth`), permitindo exfiltração anônima.

Somando-se a isso, **rotas administrativas sensíveis não têm o guard `adminOnly`** (o middleware de autorização existe e funciona em `/api/admin/backup*`, mas `/api/admin/auditoria/verificar` expõe trilha de auditoria a gerente), a **cadeia de auditoria é autoquebrada** por um bug de serialização `Date`→`JSON` (513 eventos, 7+ "quebras" falsas), e o **rate-limit de login é contornável por `X-Forwarded-For`** (spray de 7 tentativas contornou o bloqueio).

**Veredito: NO-GO** para produção com dados reais de múltiplas empresas até a remediação do P0 de anexos e dos P1 listados (§34).

---

## 2. ESCOPO

Auditoria integral, adversarial e sistêmica. Domínios cobertos (§32). **Não** faz parte do escopo: executar carga destrutiva em produção, corrigir qualquer coisa, ou alterar artefatos.

## 3. METODOLOGIA

- Inventário estático (grep/contagem, leitura integral dos módulos centrais).
- Arquitetura e fluxo rastreável (rota → middleware → handler → service → store → PG).
- Prova dinâmica: HTTP real contra a API, usuários/funcionários reais criados para teste, `psql` real para constraints/estado, `EXPLAIN` para planos.
- Concorrência real: promessas simultâneas (20/10/5/3) contra PG real com `SERIALIZABLE`.
- Sempre que possível: reproduzir; quando não, registrar `NOT PROVEN`.
- **Classificação de evidência:** CONFIRMED / PROBABLE / SUSPECTED / NOT PROVEN / VERIFIED SAFE.

### Usuários de prova (criados/ajustados no banco de auditoria)

| Usuário | empresa | perfil | pode_consolidar | empresas |
|---|---|---|---|---|
| `admin@brobond.com.br` (id 1) | 1 | admin | **true** | {1,2} |
| `titular.a@audit.test` (id 6) | 1 | gerente | **false** | {1} |
| `gerente.a@audit.test` (id 5) | 1 | gerente | false | {1} |

---

## 4. INVENTÁRIO DO SISTEMA

| Componente | Quantidade |
|---|---|
| Arquivos `server/src/*.ts` | 84 |
| Linhas `server/src` | **39.948** |
| Arquivos `client/src` (.ts/.tsx) | 116 (96 .tsx) |
| Endpoints (`app.get/post/put/patch/delete`) | **286** |
| Recursos declarados (`resources.ts`) | **82** (64 com `empresa:true`, **18 sem**) |
| Migrations SQL (`db/migrations`) | 34 |
| Migrations Prisma | 20 |
| Arquivos de teste (`server/test/*.test.ts`) | 69 |
| Pacotes workspaces | `packages/{domain,infra}`, `modules/connectors`, `prisma/`, `server/`, `client/` |
| CI | `.github/workflows/ci.yml` (2 jobs: `verificar`, `testes-postgres`) |
| Deploy | `render.yaml` (serviço único web; PG externo Neon via `sync:false`) |
| Docs | 40+ arquivos em `docs/` (auditorias anteriores, relatórios de ciclo) |

Maiores arquivos (concentração de risco/regra): `resources.ts` (3299), `negocios.ts` (2032), `producao.ts` (1878), `services.ts` (1716), `financeiro.ts` (1620), `gateway.ts` (1249), `logistica.ts` (1128), `fiscal.ts` (1074), `auth.ts` (1070), `expedicao.ts` (973), `usuariosAdmin.ts` (963), `pdv.ts` (949), `index.ts` (939).

## 5. MAPA DE ARQUITETURA

```
React (client/src, 96 páginas)
  → fetch wrappers (Bearer JWT; empresa ativa no token/sessão)
  → Express (server/src/index.ts, 286 rotas)
      → securityHeaders / cors / rateLimit
      → PÚBLICO: /api/auth/login, /api/files/:id/:token, /api/portal/:token/*,
                 /api/publico/catalogo/:token, /api/webhooks/:provider (conectores)
      → requireAuth (JWT) → bloquearSenhaProvisoria
      → resourceParam → checkAccess (RBAC: perfil/adminOnly/minPerfil/ops)
      → escopoDe(actor) → EscopoEmpresa {empresaId, consolidado, permitidas}
      → service/domain (negocios, financeiro, producao, fiscal, logistica, pdv…)
      → getStore() → PgStore (SERIALIZABLE) | MemStore (demo)
          → PostgreSQL 16 (97+ tabelas; migrations db/+prisma)
      → gateway.ts (pagamentos: idempotência por índice único + status guard)
      → webhooks.ts (entregas HMAC, retry, log 200)
      → connectors/marketplace (ingestão de pedidos externos)
```

**Onde a regra realmente vive:** o núcleo de regras está em `services.ts` (CRUD genérico, `checkAccess`, `escopoDe`, `optionsFor`, auditoria) e nos módulos de domínio. A engine canônica de faturamento/financeiro é `financeiro.ts` (`reconciliarParcelasPedido`); a de estoque/movimentos é `services.ts` + `negocios.ts`. O **ponto de falha estrutural** é que `uploads.ts` (`ensureRecord`, `ownedFile`, `uploadFile`) e vários endpoints `adminOnly` **não reutilizam** os guards do CRUD genérico.

## 6. MATRIZ DE COBERTURA (resumo — detalhe por finding nos §7+)

| Domínio | Arquivos | Rotas | Banco | Regras | Seg | Conc | Perf | Testes | Obs | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| Meu Negócio/BI | dashboard/relatorios | ✔ | ✔ | parcial | ✔ | n/a | parcial | parcial | parcial | PARTIALLY AUDITED |
| Cadastros | resources.ts/services | ✔ | ✔ | ✔ | ✔ | n/a | ✔ | ✔ | ✔ | AUDITED |
| Vendas | negocios/financeiro | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | AUDITED |
| POS | pdv.ts | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | parcial | ✔ | AUDITED |
| Estoque | services/negocios | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | AUDITED |
| Suprimentos/Compras | cotacoesCompra | ✔ | parcial | parcial | ✔ | n/a | n/a | parcial | parcial | PARTIALLY AUDITED |
| Produção | producao.ts | ✔ | ✔ | ✔ | ✔ | ✔ | n/a | parcial | ✔ | AUDITED |
| Financeiro | financeiro.ts | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | parcial | AUDITED |
| Fiscal | fiscal/fiscalProvider | ✔ | ✔ | ✔ | parcial | n/a | n/a | parcial | parcial | PARTIALLY AUDITED |
| Logística/Expedição | logistica/expedicao | ✔ | parcial | parcial | ✔ | n/a | n/a | parcial | parcial | PARTIALLY AUDITED |
| Devoluções | negocios | ✔ | ✔ | ✔ | ✔ | ✔ | n/a | parcial | ✔ | AUDITED |
| Administração | usuariosAdmin/index | ✔ | ✔ | ✔ | **✘ (P1)** | n/a | ✔ | ✔ | parcial | PARTIALLY AUDITED |
| Commerce/Marketplace | connectors/marketplace | ✔ | parcial | parcial | parcial | n/a | ✘ | parcial | parcial | PARTIALLY AUDITED |
| Integrações/Webhooks | webhooks/gateway | ✔ | ✔ | ✔ | ✔ | ✔ | n/a | ✔ | ✔ | AUDITED |
| Autenticação | auth/totp/security | ✔ | ✔ | ✔ | **✘ (P2 XFF)** | n/a | ✔ | ✔ | parcial | PARTIALLY AUDITED |
| RBAC | services.checkAccess | ✔ | ✔ | ✔ | **✘ (P1)** | n/a | ✔ | ✔ | ✔ | PARTIALLY AUDITED |
| Infraestrutura | render.yaml/ci | ✔ | ✔ | n/a | ✔ | n/a | ✔ | ✔ | ✔ | AUDITED |
| Frontend | client/src | ✔ | n/a | parcial | parcial | parcial | parcial | ✘ | parcial | PARTIALLY AUDITED |
| PostgreSQL | pgstore/schema | ✔ | ✔ | ✔ | ✔ | ✔ | parcial | ✔ | parcial | AUDITED |

Motivos de PARTIAL: ver §7+ (fiscal usa provider real só em ambiente configurado; marketplace depende de conector externo; suprimentos/logística auditados por leitura de código, sem dados vivos suficientes; frontend sem testes E2E de browser).

---

## 7. P0 — CRÍTICOS

### FINDING **P0-01** — IDOR/BOLA em fotos/anexos (cross-tenant read, write, delete) + download público

- **ID:** P0-01
- **SEVERIDADE:** P0
- **STATUS:** **CONFIRMED**
- **DOMÍNIO:** Multi-tenancy / Segurança / API
- **ARQUIVO:** `server/src/uploads.ts` L211-215 (`ensureRecord`), L217-222 (`ownedFile`), L227-300 (`listFiles`/`uploadFile`/`updateFile`/`deleteFile`); montagem em `server/src/index.ts` L336 (`/api/files/:id/:token` antes do `requireAuth` L341), L755-760.
- **FLUXO:** empresa A → `/api/produtos/{id_da_empresa_B}/arquivos`
- **CAUSA:** `ensureRecord` faz `getStore().findOneWhere(r, { id })` **sem** `registroNoEscopo`/`assertRegistroDaEmpresa`. O CRUD genérico correto (`assertRegistroDaEmpresa`, `empresa.ts` L211) **não** é aplicado ao subsistema de fotos. A tabela `arquivos` não tem `empresa_id` e a posse é derivada do registro pai — que nunca é validado contra o escopo do ator.
- **CENÁRIO:** usuário `titular.a` (empresa 1, `pode_consolidar=false`): `GET /api/produtos/25` retorna **404** (correto), mas `GET/POST/DELETE /api/produtos/25/arquivos` operam sobre o produto da empresa 2.
- **IMPACTO:** (a) foto de catálogo/produto de outra empresa pode ser **exfiltrada**; (b) injeção de imagem maliciosa no anúncio alheio (possível XSS por conteúdo — embora `nosniff`+mime sniff mitigue); (c) **exclusão** de fotos de outra empresa; (d) o segredo `token` retornado permite download **anônimo**.
- **PROBABILIDADE:** Alta (exploração trivial por qualquer usuário autenticado; enumerando ids).
- **EVIDÊNCIA (reproduzida):**

```text
user6 empresa=1 consolidar=false
GET /produtos/25            -> 404 {"error":"Produto não encontrado(a)."}   # correto
GET /produtos/25/arquivos   -> 200 [{"id":2,"nome":"segredo-emp2.png",...}]  # VAZAMENTO
GET /api/files/2/0b39987a…  -> 200 bytes=70 png=89504e470d0a1a0a             # download cruzado
POST /produtos/25/arquivos  -> 201 {"id":3,"nome":"inject-emp1.png",...}      # INJEÇÃO
DELETE /produtos/25/arquivos/2 -> 200 {"ok":true}                             # EXCLUSÃO
# download SEM auth (rota pública, antes do requireAuth):
GET /api/files/3/22fa3a7d…  -> 200 Cache-Control: public, max-age=31536000, immutable
```

- **COMO FOI TESTADO:** harness HTTP real (`/tmp/f1/filext_*.mts`), produto 25 e arquivo 2 pertencentes à empresa 2, ator da empresa 1; `curl` anônimo para confirmar ausência de auth.
- **RESULTADO:** acesso cruzado total (leitura, escrita, exclusão) + download público.
- **RISCO:** vazamento e corrupção de dados de outra empresa — quebra do invariante multi-tenant (#1 do §8).
- **RECOMENDAÇÃO:** aplicar `assertRegistroDaEmpresa` em `ensureRecord`; associar `empresa_id` a `arquivos` (ou derivar com validação de escopo); mover `/api/files/:id/:token` para trás do `requireAuth` ou manter token como capability **não** listável cross-tenant. **NÃO CORRIGIR AQUI.**

---

## 8. P1 — GRAVES

### FINDING **P1-01** — Recursos globais (`categorias`, `cores`, `grades`, `tamanhos`) são catálogo único compartilhado, criável/editável por qualquer perfil

- **ID:** P1-01
- **SEVERIDADE:** P1
- **STATUS:** **CONFIRMED**
- **DOMÍNIO:** Multi-tenancy / Cadastros / RBAC
- **ARQUIVO:** `server/src/resources.ts` — `categorias` (~L874), `cores` (~L898), `grades` (~L580), `tamanhos` (~L549): sem `empresa:true`, sem `minPerfil`, `ops: ALL_OPS`.
- **CAUSA:** decisão de design de "catálogo compartilhado" (legítima em muitos ERPs) porém **sem RBAC** e **sem auditoria de tenant** — qualquer operador de qualquer empresa cria/renomeia/exclui categorias que afetam a nomenclatura global.
- **CENÁRIO:** `gerente.a` (empresa 1) cria `POST /api/categorias` → 201. `titular.a` renomeia categoria 4 → 200. Registros ficam **sem dono** (`empresa_id` 1 carimbado por fallback `EMPRESA_PADRAO`? — ver P1-02).
- **IMPACTO:** envenenamento de catálogo mestre entre empresas; `DELETE` de categoria em uso por outra empresa pode quebrar relatórios/produtos alheios; falta de rastreio de autoria por tenant.
- **PROBABILIDADE:** Média-alta.
- **EVIDÊNCIA:**

```text
gerente emp1 cria categoria global: 201 5
categorias visiveis: [ 'AUDIT-XTENANT-CAT-…', 'XTENANT-CAT-…' ]
renomeia categoria 4: 200
```

- **COMO FOI TESTADO:** criação/edição via API com usuário não-admin.
- **RISCO:** integridade de dados compartilhados; efeitos colaterais cross-empresa.
- **RECOMENDAÇÃO:** confirmar intenção de negócio; se compartilhado, exigir `minPerfil:'gerente'`+ auditoria de autor; se por empresa, adicionar `empresa:true` e migração. **NÃO CORRIGIR.**

### FINDING **P1-02** — Endpoints `/api/admin/*` sensíveis sem guard de administrador

- **ID:** P1-02
- **SEVERIDADE:** P1
- **STATUS:** **CONFIRMED**
- **DOMÍNIO:** RBAC / Administração / Observabilidade
- **ARQUIVO:** `server/src/index.ts` L400 (`GET /api/admin/auditoria/verificar`, handler `auth.ts` L1068). O guard correto existe e é usado em `/api/admin/backup*` (L752-754).
- **CAUSA:** o handler `verificarAuditoriaHandler` roda `getStore().verificarAuditoria()` (percurso global da trilha de auditoria, **sem escopo de empresa**) e a rota não aplica `checkAccess`/`adminOnly`, dependendo apenas do `requireAuth` global.
- **CENÁRIO:** `titular.a` (gerente, empresa 1) → `GET /api/admin/auditoria/verificar` → **200**, retornando total/verificadas/quebras de **toda** a trilha (empresa 1 + 2).
- **IMPACTO:** vazamento de metadados de auditoria (contagem de eventos, ids comprometidos) para não-admin; exposição de que a cadeia global está quebrada (findings P2-01); bypass de RBAC funcional.
- **PROBABILIDADE:** Alta.
- **EVIDÊNCIA:**

```text
gerente -> /api/admin/auditoria/verificar: 200 {"ok":false,"total":513,"verificadas":506,"quebras":[26,102,…]}
gerente -> /api/admin/backup/info: 200 {"kind":"postgres",…}   # também sem guard aqui? backup tem guard no GET; info não
gerente -> /api/admin/backup: 403 (guard correto)  # contraste: o guard EXISTE e é aplicado a backup
```

- **COMO FOI TESTADO:** HTTP real com perfil `gerente` contra rotas `admin`.
- **RESULTADO:** 200 em `verificar` e `backup/info`; 403 apenas em `backup`/`backup/xlsx`.
- **RISCO:** elevação horizontal de privilégio; vazamento de observabilidade.
- **RECOMENDAÇÃO:** aplicar o mesmo guard de `adminBackup` a **todas** as rotas `/api/admin/*`. **NÃO CORRIGIR.**

### FINDING **P1-03** — F1: parcelamento pode gerar parcela negativa/zero e (em PG) abortar o faturamento

- **ID:** P1-03
- **SEVERIDADE:** P1
- **STATUS:** **CONFIRMED** (reprodução dupla: memória e PG)
- **DOMÍNIO:** Financeiro / Dinheiro
- **ARQUIVO:** `server/src/financeiro.ts` — `r2(total/n)` (L207), valor por parcela (L230): `valor = i === n ? r2(total - valorParcela*(n-1)) : valorParcela`.
- **CAUSA:** a "última absorve a diferença" faz a última parcela virar `total - valorParcela*(n-1)`. Quando `valorParcela` arredonda para cima (ex.: `r2(0.02/3)=0.01`), a soma das anteriores excede o total e a última fica **negativa**. Ex.: total 0,02 em 3× → [0.01,0.01,0.00]; total 0,01 em 3× → última negativa. Em **PostgreSQL** o CHECK `ck_lanc_fin_valor_positivo` (`valor > 0`, **NOT VALID**) faz o `INSERT` falhar → faturamento retorna 409 e **nada é gravado** (o pedido fica travado, não faturável). Em **memória/demonstração** não há CHECK → parcelas negativas/zero **persistem**.
- **CENÁRIO:** produto/venda de R$ 0,06 em 4× ou R$ 0,01 em 3×.
- **IMPACTO:** venda de baixo valor (brinde/amostra/fracionado) fica **impossível de faturar** em PG (regressão operacional) ou gera **recebível inconsistente** em memória/demonstração.
- **PROBABILIDADE:** Média (vendas de centavos; PDV/KITS).
- **EVIDÊNCIA PG (real):**

```text
total=0.06 n=4 -> faturar=409 "…violam uma regra de consistência… nada foi gravado"
total=0.02 n=3 -> faturar=409
total=0.01 n=3 -> faturar=409
total=10.01 n=4 -> faturar=200 parcelas=[2.51,2.50,2.50,2.50] soma=10.01   # ok
total=0.03 n=2 -> 200 [0.01,0.02]
```

- **EVIDÊNCIA memória (reprodução anterior, `demo`):** `parcelas=[-0.01,0.01,…]` persistidas.
- **COMO FOI TESTADO:** `POST /vendas` + itens + `PUT status=faturada`; leitura de `lancamentos_financeiros`; constraint `\d` no PG.
- **RESULTADO:** PG bloqueia (NOT VALID mas enforcement ativo em INSERT) → transação aborta; memória corrompe.
- **RISCO:** pedidos não faturáveis; inconsistência financeira em demo/testes; **mascarado no CI** porque o smoke de memória não valida valores.
- **RECOMENDAÇÃO:** distribuição de centavos por maior-resto (nunca último absorve tudo) e `valor > 0` garantido. **REMEDIATION PENDING — NÃO CORRIGIR nesta fase.**

### FINDING **P1-04** — Rate-limit de login contornável por `X-Forwarded-For` (com `trust proxy`)

- **ID:** P1-04
- **SEVERIDADE:** P1
- **STATUS:** **CONFIRMED**
- **DOMÍNIO:** Autenticação / Segurança
- **ARQUIVO:** `server/src/index.ts` L234 (`app.set('trust proxy', 1)`) + `server/src/security.ts` (`loginBucketKey` = `rateKey('login', clientIp(req)+'|'+email)`, `WINDOW_MS` 15min, `MAX_ATTEMPTS` 5).
- **CAUSA:** com `trust proxy`, `clientIp` deriva de `X-Forwarded-For`; o bucket de bloqueio é por `IP|email`, permitindo **rotacionar XFF** para nunca atingir `MAX_ATTEMPTS`.
- **CENÁRIO:** 7 tentativas erradas variando `X-Forwarded-For: 10.0.0.1..7` → **sem** bloqueio (401,401,…,403,403); 7 com XFF fixo → bloqueio no 6º (429).
- **IMPACTO:** password spraying / brute-force distribuído, especialmente contra contas de admin.
- **PROBABILIDADE:** Alta (header é livre).
- **EVIDÊNCIA:**

```text
com XFF variando: 401 401 401 401 401 403 403   # não bloqueou por IP-bucket
XFF fixo:         401 401 401 401 401 429 429   # bloqueou corretamente
```

- **COMO FOI TESTADO:** `curl` com/sem rotação de XFF.
- **RESULTADO:** contorno confirmado.
- **RISCO:** comprometimento de credenciais.
- **RECOMENDAÇÃO:** bucket adicional por **conta** (não só IP|email) e/ou rate-limit por conta independente de IP; validar que o proxy de borda sobrescreve XFF. **NÃO CORRIGIR.**

### FINDING **P1-05** — Escrita cross-tenant via `empresa_id` no corpo é **rejeitada** (VERIFIED SAFE), mas `PUT` de movimentação de registro entre empresas tem semântica ambígua a validar

- **ID:** P1-05
- **SEVERIDADE:** P1
- **STATUS:** **VERIFIED SAFE** para o vetor testado / **NOT PROVEN** para mobilidade de tenant
- **DOMÍNIO:** Multi-tenancy/Cadastros
- **ARQUIVO:** `server/src/empresa.ts` (carimbo no create/update — `empresaDoRegistroAudit`, `aplicarFiltroEmpresa`), `services.ts` (update).
- **EVIDÊNCIA:** `POST /clientes` e `POST /produtos` com `empresa_id=2` → 201 com `empresa_id=1` (servidor ignora/sobrescreve). `PUT /produtos/:id {empresa_id:2}` → 200 com `empresa_id=1` (não move de empresa). **VERIFIED SAFE** para spoof/roubo de tenant no corpo.
- **NOT PROVEN:** não foi possível provar comportamento sob combinações de `empresa_id` + `local_id`/`tamanho_id` de outra empresa (alguns creates exigem essas refs). Recomenda-se teste dedicado de referência cruzada.

```text
POST /clientes empresa_id=2 -> 201 empresa_id=1
POST /produtos empresa_id=2 -> 201 empresa_id=1
PUT /produtos/:id empresa_id=2 -> 200 empresa_id=1
```

---

## 9. P2 — RELEVANTES

### FINDING **P2-01** — Cadeia de auditoria (tamper-evidence) se autoquebra por serialização `Date`→JSONB

- **ID:** P2-01
- **SEVERIDADE:** P2 (integridade/observabilidade; pode virar P1 se auditoria for exigida legalmente)
- **STATUS:** **CONFIRMED** (causa raiz provada)
- **DOMÍNIO:** Observabilidade / Segurança / PostgreSQL
- **ARQUIVO:** `server/src/auditChain.ts` (`payloadAssinavel`/`hashCadeiaAuditoria`), `server/src/pgstore.ts` `audit()` (L~594) e `verificarAuditoria()`.
- **CAUSA:** o hash é calculado sobre `dados` **em memória**, onde campos de data são objetos `Date` (→ `jsonCanônico` produz a string de `toJSON`, formato ISO com ms). Ao reler do PG, os mesmos campos voltam como **string** ISO (JSONB), e o hash recomputado difere. **Prova:** para o evento id 102, o hash gravado (`b34904…`) só reproduz quando `criado_em` é convertido de volta para `Date`; com a string do banco o recomputo diverge (`da9848…`).
- **CENÁRIO:** qualquer evento cujo `dados` contenha `criado_em`/`atualizado_em`/`vencimento` etc. rompe a cadeia na verificação.
- **IMPACTO:** o recurso de detecção de adulteração **não é confiável** — `ok:false` com "quebras" espúrias; um ataque real de adulteração fica indistinguível do ruído; verificação de integridade inútil na prática.
- **PROBABILIDADE:** Alta (confirmada em >7 eventos na base de auditoria).
- **EVIDÊNCIA:**

```text
verificar: {"ok":false,"total":516,"verificadas":509,"quebras":[26,102,110,209,307,517,530]}
id 102 gravado:        b349047866fa… 
recomput (como DB):    da9848b8173…  (divergente)
recomput (com Date):   b349047866fa…  (== gravado)
```

- **COMO FOI TESTADO:** recomputação do hash de linhas reais via `auditChain.ts` + inspeção da coluna `dados`.
- **RISCO:** falsa sensação de segurança; relatórios de compliance incorretos.
- **RECOMENDAÇÃO:** canonicalizar datas para string **antes** do hash (na gravação) e na releitura. **NÃO CORRIGIR.**

### FINDING **P2-02** — `internal:true` esconde recursos do CRUD genérico, mas o subsistema de fotos usa `resourceWithImages` sobre `getPublicResource`; `arquivos` também é `internal` — consistência frágil

- **ID:** P2-02 · **SEVERIDADE:** P2 · **STATUS:** **CONFIRMED (code smell estrutural)**
- **ARQUIVO:** `server/src/uploads.ts` L204-208 (`resourceWithImages`), `resources.ts` (`arquivos` internal/READ_ONLY).
- **CAUSA:** duas descrições de "recurso" (público vs interno) com regras divergentes de posse/escopo; o caminho genérico valida escopo, o de arquivos não (raiz do P0-01).
- **RECOMENDAÇÃO:** unificar a checagem de posse em um único helper. **NÃO CORRIGIR.**

### FINDING **P2-03** — `/api/dashboard?empresa_id=N` e `/api/relatorios/:nome?empresa_id=N` aceitam o parâmetro mas ignoram (VERIFIED SAFE) — porém respostas retornam dados globais quando o ator é consolidante

- **ID:** P2-03 · **SEVERIDADE:** P2 · **STATUS:** **VERIFIED SAFE / SUSPECTED**
- **ARQUIVO:** `server/src/index.ts` L426-430 (`dashboard` usa `escopoDe`), `relatorios.ts`.
- **EVIDÊNCIA:** ator não-consolidante vê apenas dados da própria empresa; consolidante vê consolidado (design). `?empresa_id=2` não altera o escopo. Sem vazamento confirmado.

```text
titular.a (não-consolidante): dashboard -> 200 com dados da empresa 1
admin (consolidar=true):      dashboard -> dados consolidados (esperado)
```

### FINDING **P2-04** — Ausência de índices/constraints em alguns pontos + constraints `NOT VALID`

- **ID:** P2-04 · **SEVERIDADE:** P2 · **STATUS:** **CONFIRMED (estrutural)**
- **ARQUIVO:** `db/schema.sql`/migrations.
- **CAUSA:** `ck_lanc_fin_valor_positivo` e `ck_lanc_fin_taxa_pct` são **NOT VALID** (`convalidated=f`) — não foram aplicadas retroativamente a dados antigos.
- **EVIDÊNCIA:** `SELECT conname, convalidated FROM pg_constraint WHERE conname LIKE '%lanc_fin%'` → ambos `f`.

```text
ck_lanc_fin_valor_positivo | f | CHECK ((valor > 0)) NOT VALID
ck_lanc_fin_taxa_pct       | f | CHECK (taxa_pct>=0 AND taxa_pct<100) NOT VALID
```

- **IMPACTO:** dados históricos podem violar a regra; enforcement só em novos INSERT/UPDATE.
- **RECOMENDAÇÃO:** `VALIDATE CONSTRAINT` após saneamento. **NÃO CORRIGIR.**

### FINDING **P2-05** — `pg_advisory_xact_lock(hashtext(...))` na auditoria serializa TODA escrita auditada

- **ID:** P2-05 · **SEVERIDADE:** P2 (performance/concorrência) · **STATUS:** **CONFIRMED (código)**
- **ARQUIVO:** `server/src/pgstore.ts` `audit()`.
- **CAUSA:** lock global único por transação de auditoria, somado a `SERIALIZABLE` em toda operação, cria contenção serial sob carga.
- **IMPACTO:** throughput limitado em picos de escrita; risco de espera/latência. Não é correção, é achado de performance.
- **RECOMENDAÇÃO:** avaliar cadeia por-tenant ou lock mais granular.

### FINDING **P2-06** — Frontend: ausência de testes de browser; `setTimeout`/estado de loading insuficiente em pontos

- **ID:** P2-06 · **SEVERIDADE:** P2 · **STATUS:** **PROBABLE**
- **ARQUIVO:** `client/src` (96 páginas; 16 usos de `setTimeout`, 37 pontos com `toast.success`).
- **CAUSA:** não há harness E2E de browser no CI (o job `verificar` compila o front mas não o exercita interativamente).
- **IMPACTO:** risco de "UI diz sucesso, backend falhou" e duplo submit não detetados por CI.
- **NOT PROVEN:** não foi reproduzido um caso concreto de divergência UI/backend nesta rodada.
- **RECOMENDAÇÃO:** E2E real (Playwright) com asserts de estado.

### FINDING **P2-07** — Autenticação MFA/TOTP: `base32Decode` estoura com `segredo` indefinido

- **ID:** P2-07 · **SEVERIDADE:** P2 · **STATUS:** **CONFIRMED** (observado em harness; crash de processo)
- **ARQUIVO:** `server/src/totp.ts` `base32Decode` (L28), `codigoTOTP` (L50).
- **CAUSA:** falta de guarda para `undefined` ao derivar código fora do fluxo nominal.
- **IMPACTO:** erro 500/crash em caminho de MFA não nominal; superfície de robustez.
- **NOT PROVEN:** impacto em produção depende de caminho só alcançável em testes (não confirmado end-to-end).
- **RECOMENDAÇÃO:** validar entrada e devolver 400. **NÃO CORRIGIR.**

### FINDING **P2-08** — CORS devolve `true` (qualquer origem) quando não é produção

- **ID:** P2-08 · **SEVERIDADE:** P2 · **STATUS:** **CONFIRMED (config)**
- **ARQUIVO:** `server/src/security.ts` `corsOrigin()` → `isProd ? [] : true`.
- **IMPACTO:** se `NODE_ENV` não for `production` num deploy real, CORS libera qualquer origem (com Bearer token, CSRF menos relevante, mas amplia superfície). Depende de `NODE_ENV` correto no Render (`production` no template).
- **RECOMENDAÇÃO:** nunca `true`; exigir lista explícita. **NÃO CORRIGIR.**

---

## 10. P3 — MELHORIAS / DÉBITO

| ID | Achado | Evidência |
|---|---|---|
| P3-01 | `console.log` em código de servidor (19) e client (1) | grep |
| P3-02 | `TODO/FIXME/HACK` (11 em src) e 153 incluindo docs | grep |
| P3-03 | `eslint-disable`/`as any` (5 eslint-disable; 75 ocorrências de cast) | grep |
| P3-04 | 83 ocorrências de `skip` em testes / 4 skips reais | grep |
| P3-05 | Código legado/adapters paralelos (`legado`, engines antigas) mencionados nos docs | docs |
| P3-06 | Sem correlation-id/request-id padronizado (apenas gateway usa `x-request-id`) | grep |
| P3-07 | `arquivos` sem FK para o registro pai (posse derivada em código) | `\d arquivos` |
| P3-08 | 18 recursos sem `empresa_id` (incl. `empresas`, `usuarios` adminOnly) | resmap |
| P3-09 | `sale_items` (fusão commerce) como recurso sem escopo | resources.ts |
| P3-10 | Divergência db/migrations (34) × prisma/migrations (20) — dual-track | contagens |

---

## 11. SEGURANÇA

- **Headers:** CSP, HSTS (prod), X-Frame-Options SAMEORIGIN, nosniff, Referrer-Policy, Permissions-Policy — **bons** (`security.ts`).
- **Segredos em prod:** `assertProductionSecrets` mata o processo se `JWT_SECRET` fraco/`brobond-dev-secret` ou `ADMIN_PASSWORD` fraca — **bom**. Fallback `'brobond-dev-secret'` só fora de produção.
- **.env:** apenas `server/.env.example` versionado; `.env*` no `.gitignore` — **VERIFIED SAFE**.
- **Injeção SQL:** consultas parametrizadas / query builder próprio — sem concatenação óbvia de input; **não exaustivamente provado** → NOT PROVEN para casos extremos.
- **XSS:** CSP + `nosniff`; conteúdo de imagem validado por `sniffMime` (JPEG/PNG/WebP) — **razoável**.
- **Upload inseguro:** MIME sniff + limite de bytes — **bom**, exceto pelo P0 de escopo.
- **Rate limit:** ver P1-04.
- **CSRF:** auth por Bearer (não cookie de sessão) → CSRF baixo.
- **Brute force:** ver P1-04.
- **Exposição PII/segredos em logs:** `console.log` de servidor não analisado linha a linha → **NOT PROVEN**.

## 12. MULTI-TENANCY

- CRUD genérico: robusto (39 de 64 recursos `empresa:true` com `aplicarFiltroEmpresa`/`assertRegistroDaEmpresa`; create/update carimbam empresa; `PUT` não move de tenant) — **VERIFIED SAFE** no caminho testado.
- **Fotos/anexos: QUEBRADO (P0-01).**
- Catálogo global (`categorias`/`cores`/`grades`/`tamanhos`): compartilhado por design, **sem RBAC** (P1-01).
- `arquivos`/`empresas`/`usuarios` sem `empresa_id` — risco estrutural (P2-02/P3-07).
- Export/options: **VERIFIED SAFE** (retratação); o filtro do cliente é sobrescrito pelo escopo do ator.
- Auditoria (`auditoria`, `empresa:true`) — filtrada por escopo. Mas o *verificador* global de cadeia vaza a não-admin (P1-02).

## 13. CONCORRÊNCIA (PG real, `SERIALIZABLE`)

| Cenário | Requisições | Resultado | Veredito |
|---|---|---|---|
| Oversell — faturar último estoque | 20 simultâneas, saldo 1 | **1** OK / 19× 409; saldo final **0**; 1 movimento | **VERIFIED SAFE** |
| OP — concluir | 10 simultâneas | **1** 200 / 9× 409; estoque **10**; 1 movimento | **VERIFIED SAFE** |
| OP — reabrir/estornar | 10 simultâneas | **1** 200 / 9× 409; estoque **0** | **VERIFIED SAFE** |
| PDV — vender no mesmo caixa | 5 simultâneas | **1** 201 / 4× 409 | **VERIFIED SAFE** |
| PDV — fechar caixa | 3 simultâneas | **1** 200 / 2× 409 (OCC); refechar 409 | **VERIFIED SAFE** |
| Abrir mesmo terminal 2× | 2 | 2ª → 409 | **VERIFIED SAFE** |
| Devolver mais que vendido | 5 > 3 | 409 com mensagem de saldo de devolução | **VERIFIED SAFE** |
| Venda faturada → cancelar | — | 200 + reposição de estoque; 2º cancelar 409/200 sem duplicar movimento | **VERIFIED SAFE** |
| Gateway idempotência | — | índice único `(empresa, provider, idempotency_key)` + guard de status | **VERIFIED SAFE** |

**Isolation level:** `PgStore.transaction` usa `'serializable'` por padrão (`pgstore.ts` L265). Isso explica os 409 consistentes ("Outra operação alterou estes dados ao mesmo tempo"). **Ponto de atenção (P2-05):** `SERIALIZABLE` + advisory lock global de auditoria são conservadores — correção em detrimento de throughput.

**Pergunta obrigatória (100 usuários simultâneos):** para faturamento/estoque/OP/caixa, o estado final permanece consistente (saldo nunca negativo; um único efeito), graças a SERIALIZABLE + OCC. **Ressalva:** não testado a 100; a degradação esperada é 409 em massa (retry no cliente), não corrupção.

## 14. DINHEIRO / DECIMAL

- **Banco:** `numeric(12,2)` — **sem float/double** (`information_schema` confirma; nenhuma coluna `double precision`).
- **Servidor:** `r2` (round 2) consistente; sem `Number` monetário ingênuo identificado.
- **Exceção crítica:** distribuição de centavos (P1-03) gera 0/negativo.
- **Testes de fronteira:** 0,01/0,03/0,05 → PG bloqueia faturamento com total 0,01/0,02/0,06 (**regressão**); 0,03 e 0,05 em 2-3× passam; 10,01 em 4× → [2.51,2.50,2.50,2.50] soma correta.
- **Veredito:** representação **VERIFIED SAFE**; distribuição **QUEBRADA (P1-03)**.

## 15. ESTOQUE

- Oversell: protegido (ver §13). Saldo nunca negativo nos testes.
- Devolução acima do vendido: bloqueada com mensagem clara.
- Cancelamento de venda faturada: reposição correta; sem duplo movimento.
- Transferência/ajuste/produção/consumo: revisão de código; sem prova dinâmica de todos os caminhos → PARTIAL.
- `estoque final = entradas − saídas + devoluções + produção − consumo ± ajustes ± transferências`: **consistente** nos cenários testados; **NOT PROVEN** para combinações simultâneas raras.

## 16. PRODUÇÃO

- OP: criar → concluir → reabrir/estornar testados; idempotência e atomicidade **VERIFIED SAFE**.
- Consumo de insumos/custo: revisão de código; sem prova dinâmica completa → PARTIAL.
- Reabertura inválida/estorno duplicado: bloqueados por concorrência (409).
- Histórico/movimentos: 1 movimento por conclusão (coerente).

## 17. VENDAS / POS

- Venda: criação, itens, faturamento, cancelamento, devolução — testados.
- POS: abrir caixa, venda, resumo, fechamento (concorrente) — **VERIFIED SAFE**.
- Operador/gerente (alçada/desconto): revisão de código; sem prova dinâmica → PARTIAL.
- Double-submit: mitigado por OCC/serializable no backend; front não tem E2E (P2-06).

## 18. FISCAL

- `fiscal.ts` delega a `fiscalProvider` (Focus/PlugNotas/nenhum); default `provider:'nenhum'`, `ambiente:'homologacao'`, `habilitado:false`.
- Tratamento de "nota autorizada na SEFAZ, mas efeitos no ERP falharam" existe e é explícito (comentário + fluxo).
- Devolução de número à série quando o documento não existiu na SEFAZ: implementado.
- **Classificação:** ARCHITECTURE PROVEN (fluxo e idempotência por status); **MOCK/SANDBOX não exercitado** — sem credenciais reais e sem provider configurado → **NOT PROVEN** homologação real. **Não** se afirma integração real com SEFAZ.

## 19. LOGÍSTICA / EXPEDIÇÃO

- Revisão de código de `logistica.ts`/`expedicao.ts`; sincronização com venda/estoque/fiscal/financeiro presente.
- Sem dados vivos/simulação de falha intermediária nesta rodada → PARTIALLY AUDITED.

## 20. MARKETPLACE / COMMERCE

- `connectors.ts` + `marketplace.ts`/`marketplaceOperacional.ts`; bridge MARKETPLACE→VENDA (GOLIVE-03).
- Webhooks públicos fora do `requireAuth`, com assinatura HMAC sobre bytes crus (`rawBody`), roteados por provider.
- Idempotência/retry: presentes no `gateway.ts` para pagamentos; para connector depende do provider.
- Sem conector externo ativo → **NOT PROVEN** para duplicação/replay real.

## 21. FRONTEND

- Sem E2E de browser → cobertura falsa é possível (P2-06).
- Não reproduzido caso concreto de divergência UI/backend → **NOT PROVEN**.

## 22. PERFORMANCE

- `SERIALIZABLE` global + advisory lock de auditoria (P2-05) = principal achado.
- Listagens com `pageSize` alto (ex.: `optionsFor` 2000; relatórios 20000) — risco de payload grande/`OFFSET` gigante.
- N+1/SELECT *: não medido com `EXPLAIN ANALYZE` por ausência de carga representativa → **NOT PROVEN**.
- Sem cache global detectado (store injetado por request/escopo).

## 23. POSTGRESQL

- 97+ tabelas; `numeric` para dinheiro; constraints de consistência inclusive com `NOT VALID` (P2-04).
- Sem `double precision`/`real`.
- `arquivos` sem FK para o dono (P3-07).
- Índices: `idx_arquivos_registro`; ausência de índices compostos avaliada pontualmente → PARTIAL.
- Migrations: dual-track (db 34 + prisma 20) — risco de drift (P3-10).

## 24. TESTES

- 69 arquivos `server/test/*.test.ts`; ~83 menções a `skip` (4 skips reais).
- CI tem job `testes-postgres` (PG 16.14 real) — **bom**.
- **Fragilidade comprovada:** o smoke de memória **não** validou valores monetários (por isso P1-03 escapou); testes de memória não substituem PG para invariantes de saldo (o próprio CI reconhece).
- Áreas sem cobertura: E2E de browser; fiscal real; connectors reais; concorrência de transferência de estoque.

## 25. DEAD CODE

- `console.log` (19), `TODO/FIXME/HACK` (11 em src), `eslint-disable` (5), casts (75). Código legado/adapters paralelos citados em docs. Catalogado, não removido.

## 26. DEVOPS / RENDER

- `render.yaml`: serviço único, `NODE_ENV=production`, `PORT=10000`, `healthCheckPath:/api/health`, `JWT_SECRET`/`MFA_ENCRYPTION_KEY` gerados, `ADMIN_PASSWORD`/`DATABASE_URL` via `sync:false` (Neon), `ADMIN_FORCE_PASSWORD=false` — **sólido**.
- **Risco:** `NODE_ENV` errado libera CORS (`true`) e desativa `assertProductionSecrets` (P2-08); banco Neon free expira (documentado).
- Migrations rodam pela própria API no boot — risco de drift dual-track.

## 27. OBSERVABILIDADE

- Auditoria com cadeia de hash — recurso avançado, **mas quebrado** (P2-01), então não é confiável para reconstrução/tamper-evidence.
- Sem correlation-id padronizado (P3-06).
- Resposta à pergunta "se uma venda duplicar, conseguimos reconstruir?": **parcialmente** — há auditoria por evento, mas a cadeia não valida e não há request-id ponta-a-ponta.

## 28. REGRESSÕES

- Verificado que fluxos de estoque/financeiro/produção/multiempresa **mantêm** as proteções de concorrência (não regrediram).
- **Regressão confirmada:** faturamento de vendas de centavos em PG (P1-03) — o CHECK NOT VALID + distribuição de centavos tornam o pedido não faturável, apesar do CI verde.
- Ciclos anteriores (P0/P1/ERP-01..03/GOLIVE/UX/AUDIT-01) não foram tomados como verdade; os docs descrevem CI verde que **não** cobre os achados acima.

## 29. THREAT MODEL (resumo)

| Ameaça | Entrada | Vulnerabilidade | Exploração | Impacto | Mitigação | Risco residual |
|---|---|---|---|---|---|---|
| Usuário emp A → fotos emp B | rota `/arquivos` | P0-01 | enumerar ids | vazamento/corrupção | escopar `ensureRecord` | Alto |
| Anônimo → arquivo | `/api/files/:id/:token` | rota pública | token listado via P0-01 | exfiltração | auth na rota | Alto |
| Gerente → auditoria global | `/admin/auditoria/verificar` | P1-02 | requisição direta | vazamento metadados | adminOnly | Médio |
| Atacante → contas | login | P1-04 XFF | spray | takeover | bucket por conta | Alto |
| Operador → catálogo mestre | `/categorias` | P1-01 | CRUD | corrupção compartilhada | RBAC | Médio |
| Webhook falsificado | `/api/webhooks/:provider` | assinatura HMAC sobre bytes crus | — | forjar pedido | HMAC provider | Baixo (design ok) |
| Marketplace comprometido | ingestão | — | payload inválido | pedido errado | validações | NOT PROVEN |

## 30. VERIFIED SAFE

- Criação/updates não aceitam spoof de `empresa_id` (P1-05).
- Export/options respeitam escopo (retratação).
- Oversell/dupla-fatura/dupla-conclusão OP/duplo fechamento caixa/devolução além do vendido — protegidos.
- Dinheiro em `numeric`, sem float.
- `.env` não versionado; HSTS/CSP/nosniff/X-Frame-Options presentes; boot aborta com segredos fracos em prod.
- Webhook de conector: HMAC sobre bytes crus; gateway: idempotência por índice único + status guard.
- `requireAuth` global cobre `/api` (exceto rotas públicas intencionais — uma delas, `files`, é problema: P0-01).

## 31. NOT PROVEN

- Fiscal real (SEFAZ/homologação) — sem provider.
- Marketplace/connector replay/duplicação real — sem conector.
- Transferência/ajuste de estoque simultâneos (todos os caminhos).
- N+1/SELECT */planos sob carga.
- Exposição de PII em `console.log`.
- Divergência UI/backend no frontend.
- Referência cruzada de `local_id`/`tamanho_id` de outra empresa em create.
- 100 requisições simultâneas (testado até 20).

## 32. RECOMENDAÇÕES (priorizadas)

1. **P0-01:** escopar `ensureRecord`/`ownedFile`; proteger `/api/files`.
2. **P1-02:** `adminOnly` em todas as rotas `/api/admin/*`.
3. **P1-04:** rate-limit por conta + política de XFF na borda.
4. **P1-03 (F1):** distribuição de centavos por maior-resto.
5. **P1-01:** RBAC no catálogo compartilhado.
6. **P2-01:** canonicalizar datas antes do hash da auditoria; `VALIDATE CONSTRAINT` (P2-04).
7. **P2-06:** E2E de browser no CI.
8. Observabilidade: correlation-id; revisar logs.

## 33. ORDEM DE REMEDIAÇÃO

`P0-01 → P1-04 → P1-02 → P1-03 → P1-01 → P2-01 → P2-04 → P2-06 → P3-*`

## 34. GO / NO-GO

# **NO-GO**

Motivos:
1. **P0-01 (CONFIRMED):** IDOR/BOLA cross-tenant em fotos/anexos (listar, baixar, injetar, excluir) + download anônimo. Quebra o invariante central de multi-tenancy. Um ERP multiempresa com vazamento/corrupção de dados de outra empresa não pode ir a produção.
2. **P1-04 (CONFIRMED):** brute-force de login contornável por header.
3. **P1-02 (CONFIRMED):** rotas administrativas sem guard.
4. **P1-03 (CONFIRMED):** faturamento de vendas de centavos falha em PG (P1 confirmado; F1).

Ressalva positiva: concorrência, dinheiro (representação), RBAC do CRUD genérico, gateway e webhooks de conector estão sólidos e **provados** com PG real. Após remediar P0/P1, o sistema tende a `GO WITH RESERVATIONS`.

---

## 37. SCORE

| Dimensão | Nota | Justificativa resumida |
|---|---|---|
| Arquitetura | 7/10 | camadas claras; inconsistência em posse/arquivos |
| Backend | 7/10 | regras sólidas; P0/P1 de acesso |
| Frontend | 6/10 | sem E2E; padrões mistos |
| Banco | 8/10 | numeric, constraints; NOT VALID + sem FK arquivos |
| Segurança | 5/10 | P0 + P1-04 + P1-02 |
| Multi-tenancy | 4/10 | P0 de anexos; catálogo global |
| Concorrência | 9/10 | SERIALIZABLE + OCC provados |
| Financeiro | 6/10 | representação ok; F1 |
| Estoque | 9/10 | oversell/devolução provados |
| Produção | 8/10 | concorrência ok; custo parcial |
| Compras | 6/10 | parcial |
| Vendas | 8/10 | fluxos provados |
| Fiscal | 5/10 | não provado real |
| Logística | 6/10 | parcial |
| Marketplace | 6/10 | não provado real |
| Performance | 5/10 | serializable + advisory lock; sem EXPLAIN sob carga |
| Observabilidade | 4/10 | cadeia quebrada (P2-01) |
| Testes | 6/10 | PG real, sem E2E; cegueira a centavos |
| DevOps | 7/10 | render ok; CORS/NODE_ENV |

**Geral: 6,2/10.** Score **não** esconde P0/P1: o sistema permanece **NO-GO**.

---

## 38. NOTA FINAL DE INTEGRIDADE

- Nenhuma correção implementada; nenhum schema/migration/dependência/CI alterado.
- Único artefato criado: este relatório (branch `audit/full-forensic-system-audit`).
- Harness temporário em `/tmp/f1` (removido ao final).
- Retratação registrada (§ aviso) para eliminar falsos positivos.
