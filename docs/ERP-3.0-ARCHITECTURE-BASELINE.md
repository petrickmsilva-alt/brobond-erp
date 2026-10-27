# BROBOND ERP 3.0 — BASELINE ARQUITETURAL (estado real do código)

**Status:** documento oficial do ERP 3.0 · gerado em 2026-10-27
**Repositório:** `petrickmsilva-alt/brobond-erp`
**Branch de execução:** `arena/bfa4a15b-brobond-erp` (a partir de `main` @ `743ba24` — *merge: CRM 3.0*)
**Fonte dos números:** `npm run architecture:audit` → [`docs/ERP-3.0-ARCHITECTURE-INVENTORY.json`](ERP-3.0-ARCHITECTURE-INVENTORY.json)

> **Regra deste documento.** Nenhum número aqui foi digitado à mão: todos são
> lidos do código a cada execução do comando acima (`db/schema.sql`,
> `db/migrations/*.sql`, `server/src/resources.ts`, `server/src/index.ts`,
> `prisma/schema.prisma`, `client/src/modules.ts`, `server/test/**`,
> `client/src/**`). Se a documentação antiga divergir deste arquivo, **este
> arquivo vence** — e a divergência é um gap documentado em
> [`docs/ERP-3.0-GAP-MATRIX.md`](ERP-3.0-GAP-MATRIX.md).
>
> **O que este documento NÃO é:** não é um roadmap, não é uma promessa e não
> substitui os documentos históricos (`ERP-MASTER-ARCHITECTURE`,
> `ERP-DOMAIN-MAP`, `ERP-GAPS`, `ERP-CORE-ROADMAP`, relatórios de auditoria).
> É a **fotografia verificável** do que existe hoje.

---

## 1. Inventário real (lido do código)

| Dimensão | Valor | Como foi contado |
|---|---:|---|
| Migrations SQL (`db/migrations/*.sql`) | **50** | arquivos `0001…0050`, numerados e ordenados |
| Migrations Prisma (`prisma/migrations/`) | **7** | diretórios com `migration.sql` (dual-track do commerce) |
| Tabelas no SQL do ERP | **116** | `CREATE TABLE` únicos em `schema.sql` + migrations |
| Tabelas com `empresa_id` | **96** | coluna declarada no `CREATE TABLE` ou em `ALTER TABLE … ADD COLUMN` |
| Tabelas sem `empresa_id` | **20** | ver §3.4 (catálogos globais e tabelas com escopo por relação) |
| Índices nomeados | **369** | `CREATE [UNIQUE] INDEX` únicos |
| Constraints nomeadas | **179** | `ADD CONSTRAINT` + `CONSTRAINT` inline (CHECK/UNIQUE/FK nomeadas) |
| Recursos de API (`RESOURCES`) | **101** | `server/src/resources.ts` |
| Recursos multiempresa (`empresa: true`) | **83** | cobertura de tenant = **82,2%** dos recursos com tabela |
| Recursos somente leitura | **44** | `ops` fechado para create/update/delete |
| Recursos com RBAC restrito | **27** | `minPerfil` (gerente/admin) ou `adminOnly` |
| Módulos de navegação | **85** | `MODULES` (77 navegáveis, 8 `planned`) |
| Áreas da Árvore Master | **11** | `MODULE_AREAS` |
| Grupos de navegação | **28** | `MODULE_GROUPS` |
| Rotas HTTP | **336** | `app.get/post/put/patch/delete` em `server/src/index.ts` |
| Modelos Prisma | **11** | 5 com `empresaId` (bounded context do commerce) |
| Casos de teste declarados | **2.141** | contagem estática: 1.319 server (151 arquivos) + 822 client (71 arquivos) |
| Casos executados neste ambiente | **2.163** | 1.329 server (1.261 pass / 68 skip) + 834 client (834 pass) |
| Verificações HTTP de smoke | **327** | `npm run smoke` (Express real, modo demonstração) **e** `npm run smoke:pg` (PostgreSQL real, banco novo) |

Rotas por método: `GET 147 · POST 157 · PUT 17 · DELETE 12 · PATCH 3`.
Rotas registradas **antes** do `requireAuth` global (públicas por desenho): 44 —
health, autenticação/convites, portal do cliente, catálogo público, arquivos por
token e pareamento de agente de impressão.

### 1.1 Domínios (áreas) e volume de navegação

| Área | Módulos | Domínio coberto |
|---|---:|---|
| Meu Negócio | 3 | dashboard, motor analítico, BI (`sales`, `produto_abc`) |
| Cadastros | 12 | clientes, fornecedores, representantes, produtos/SKU, grades/medidas, cores, coleções, insumos, locais |
| Vendas | 22 | vendas, propostas, PDV, listas de preço, políticas comerciais, CRM 3.0, territórios, equipes, metas, comissões, expedição, devoluções |
| Estoque & Suprimentos | 10 | estoques, movimentações, inventários, compras, cotações, recebimentos, fornecedor × produto (de-para) |
| Produção | 4 | ordens de fabricação, fichas técnicas, apontamentos, custo |
| Financeiro | 12 | lançamentos, contas, centros de custo, transferências, gateway, extrato/conciliação, CNAB, comissões |
| Fiscal | 4 | regras fiscais, NCM, documentos fiscais, inutilizações |
| Administração | 4 | usuários, empresas, auditoria, configurações |
| Commerce | 8 | conectores multicanal, pedidos importados, projeção `sales`, painéis |
| Creators | 4 | creator commerce (parcial) |
| Utilidades Globais | 2 | conta pessoal, ajuda |

---

## 2. Doutrina vigente (o que o código realmente faz)

1. **Cadastro se desativa, documento se cancela, histórico nunca se apaga.**
   `DELETE` só existe onde não há vínculo (diagnóstico de dependências → 409 com
   `dependencias_vinculadas`).
2. **SQL/migrations são a fonte da verdade do schema.** Prisma é *bounded
   context* do commerce (§6).
3. **Empresa = tenant; usuário = identidade.** (§3)
4. **A empresa de um registro é decidida pelo SERVIDOR** — nunca pelo corpo da
   requisição (`server/src/empresa.ts`).
5. **RBAC é do servidor**, não do menu (§4).
6. **Toda operação crítica é auditada** com empresa, usuário, antes/depois e
   encadeamento de hashes (§5).
7. **Movimento ≠ saldo**: `movimentacoes` é evento; `estoques` é projeção.
   **Pedido ≠ receita**: `vendas` é operacional; `sales` é read model (§8).

---

## 3. Tenancy / multiempresa

### 3.1 Modelo

```
Empresa (tenant)  ←  empresa_id em toda tabela de negócio
   ▲
   │ usuário × empresa (usuario_empresas) = autorização/contexto
   │
Usuário (identidade)  →  sessão com claim `emp` (empresa ativa)
```

- `usuarios.empresa_id` = empresa padrão do usuário.
- `usuario_empresas` = concessões (quem pode operar em qual empresa).
- Claim `emp` do JWT = empresa ativa escolhida no seletor; só vale se concedida.
- `usuarios.pode_consolidar` = leitura consolidada do grupo (nunca escrita
  cruzada).

### 3.2 Garantias implementadas (`server/src/empresa.ts`)

| Garantia | Onde |
|---|---|
| Filtro `empresa_id` obrigatório em toda listagem de recurso com `empresa: true`; `?f.empresa_id` do cliente é descartado | `aplicarFiltroEmpresa` |
| Acesso por ID de outra empresa responde **404** (não 403 — não vaza existência) | `assertRegistroDaEmpresa` |
| Empresa carimbada na criação e imutável na edição | `carimbarEmpresa` / `protegerEmpresaNaEdicao` |
| Referências (`type: 'ref'`) validadas contra o mesmo tenant — impede "ID forjado" (venda de A com cliente de B) | `validarReferenciasDaEmpresa` |
| Escrita em modo consolidado é sempre estrita (consolidação amplia leitura) | `assertRegistroDaEmpresaParaEscrita` |
| BI (`Meu Negócio`) valida `empresa_id` pedido contra as concessões do ator | `negocios.aplicarEscopoEmpresaBi` |
| Anexos herdam o tenant do registro-pai (a tabela `arquivos` não tem `empresa_id`) | `uploads.ts` (SEC-01) |
| Webhooks/gateways resolvem a empresa pelo conector/cobrança, não pelo payload | `gateway.ts`, `connectors.ts` |

### 3.3 Cobertura

- **96 de 116** tabelas têm `empresa_id`; **83 recursos** declaram
  `empresa: true` (82,2% dos 101 recursos com tabela).
- Os 18 recursos restantes são: catálogos **globais** (tamanhos, grades,
  medidas, cores, categorias), tabelas **internas** (arquivos, sessões,
  tentativas de login, entregas de webhook) e recursos de **escopo derivado**
  (`sale_items` pertence a `sales`; catálogo compartilhado pertence ao catálogo).
- Auditoria automatizada (`npm run audit:menu` + `npm run architecture:audit`)
  falha se um recurso declarar `empresa: true` sem coluna `empresa_id`, ou se
  uma tabela com `empresa_id` for exposta sem escopo.

### 3.4 Tabelas sem `empresa_id` (20) — e por quê

| Grupo | Tabelas | Motivo |
|---|---|---|
| Catálogos globais compartilhados | `tamanhos`, `grades`, `grade_tamanhos`, `medidas`, `medida_valores`, `cores`, `categorias`, `impostos_ncm` | Nomenclatura única para o grupo; a **escrita** exige gerente/admin (`minPerfilEscrita`) |
| Escopo derivado por relação | `sale_items` (→ `sales`), `catalogo_eventos` (→ `catalogos`), `catalogo_compartilhamentos` (→ `catalogos`), `portal_acessos` (token do cliente), `cotacao_decisoes` (→ `cotacoes_compra`) | Duplicar `empresa_id` criaria duas fontes de verdade |
| Infraestrutura | `arquivos` (herda do pai), `sessoes`, `login_tentativas`, `webhooks`, `webhook_entregas`, `configuracoes` | Não são registros de negócio |
| A própria entidade | `empresas` | É o tenant |

> **Não confundir** "sem `empresa_id`" com "sem isolamento": todos os casos
> acima são alcançados por relação, por token de escopo único ou por serem
> globais por decisão arquitetural. Cada um tem teste ou auditoria dedicada.

---

## 4. RBAC / segurança

Cadeia de autorização: **UI → rota → recurso → serviço → banco**.

| Camada | Implementação |
|---|---|
| Rota | `app.use('/api', wrap(requireAuth))` antes do CRUD; `/api/admin` exige `admin` |
| Recurso | `checkAccess(r, actor, op)` — `minPerfil`, `adminOnly`, `ops`, `minPerfilEscrita`, permissões comerciais (`perm_*`) |
| Fluxo | `checkFluxo(r, actor)` para endpoints de processo (abrir caixa, converter, receber) |
| Banco | CHECKs de vocabulário, FKs, índices únicos por empresa |

- 27 recursos têm restrição explícita (`minPerfil`/`adminOnly`); catálogos
  globais têm escrita restrita (`minPerfilEscrita: 'gerente'`).
- `npm run audit:menu` prova paridade **menu × recurso** e falha quando o menu
  esconde um módulo cuja API está aberta (ou o contrário).
- Recursos historicamente divergentes revalidados nesta execução:
  `politicas_comerciais` (`empresa: true`, `minPerfil: gerente`),
  `listas_preco` (`empresa: true`, `minPerfil: gerente`),
  `envios` (`empresa: true`, `minPerfil: gerente`, `create/delete: false`).
- Operador não exclui registro em nenhum recurso (`checkAccess` regra global).

---

## 5. Auditoria

- Tabela única `auditoria` (`empresa_id` **obrigatório** no tipo `AuditEntry`).
- Encadeamento de hashes (`server/src/auditChain.ts`) → tamper-evidence, com
  verificação via `GET /api/auditoria/verificar`.
- Toda escrita crítica chama `s.audit(...)` dentro da mesma transação do fato.
- A conversão Lead → Oportunidade (nova) grava **duas** entradas: criação da
  oportunidade + edição do lead.
- `AuditEntry.empresa_id` é resolvido **no momento do evento**
  (`empresaDoRegistroAudit` / `empresaDoAtorAudit`) — nunca inferido depois.

---

## 6. ERP SQL / Prisma Boundary

| Lado | Escopo | Regras |
|---|---|---|
| **SQL** (`db/schema.sql` + `db/migrations/*.sql`) | **Fonte oficial do schema do ERP** (PostgreSQL) | Toda tabela nova do ERP nasce em `db/migrations/00NN_*.sql` com espelho em `db/schema.sql`; aplicadas no boot (`server/src/db.ts`) |
| **Prisma** (`prisma/schema.prisma` + `prisma/migrations/`) | **Bounded context técnico do commerce** | 11 modelos (5 com `empresaId`); mapeiam tabelas que o ERP já criou; dual-track (`prisma migrate deploy` aplica o mesmo SQL do boot) |

Regras objetivas:

1. **Nenhuma tabela do ERP existe só no Prisma.** O auditor falha
   (`PRISMA_TABELA_AUSENTE`) se um modelo mapear tabela inexistente no SQL.
2. **`prisma migrate dev` é proibido** contra este banco (shadow database não
   conhece as 105 tabelas fora do Prisma).
3. **Tenancy do Prisma = `empresaId`**. `usuarioId` (herança de
   `organizationId`) é **proveniência/ownership operacional**, não tenant.
4. **Documentação corrigida nesta execução:** o cabeçalho do
   `prisma/schema.prisma` afirmava "O ERP é single-company" e tratava
   `usuarios` como fronteira de tenancy. Isso é **obsoleto desde a migration
   0017** (multiempresa) e foi corrigido; o registro histórico permanece nos
   cabeçalhos das migrations 0012/0033.

Modelos Prisma e tabelas correspondentes:

| Modelo | Tabela | `empresaId` |
|---|---|---|
| `Usuario` | `usuarios` | sim |
| `Produto` | `produtos` | sim |
| `Tamanho` | `tamanhos` | não (catálogo global) |
| `Connector` | `connectors` | sim |
| `ConnectorEvent` | `connector_events` | sim |
| `ConnectorOAuthState` | `connector_oauth_states` | sim |
| `Sale` | `sales` | sim |
| `SaleItem` | `sale_items` | não (escopo por `sale_id`) |
| `Empresa` | `empresas` | é o tenant |
| `ImpostosNcm` | `impostos_ncm` | não (catálogo global) |
| `ProdutoAbc` | `produto_abc` | sim |

---

## 7. CRM 3.0 — funil, conversão e regras de estágio

### 7.1 Modelo (migration 0049, hardening 0050)

```
crm_motivos_perda (catálogo por empresa)
        ▲
        │ motivo_perda_id (obrigatório quando status = perdida — CHECK no banco)
crm_oportunidades ── cliente_id → clientes
        ▲     └── lead_id → crm_leads
        │
crm_atividades (chamada/visita/e-mail/reunião/tarefa/follow-up)
        └── lead_id / oportunidade_id / cliente_id
crm_leads ── cliente_id → clientes (quando já convertido em cliente)
        └── lead_convertido_em (marca de conversão, READONLY na API)
```

- **Multiempresa:** `empresa_id NOT NULL DEFAULT 1` nas quatro tabelas, com
  índices `(empresa_id, …)`.
- **RBAC:** os quatro recursos têm `minPerfil: 'gerente'` e `ops` completos
  (atividades/oportunidades não são expostas a operador).
- **Vocabulário fechado no banco** (CHECK): status do lead, etapa/status da
  oportunidade, tipo/resultado da atividade, probabilidade 0–100.
- **Relação técnica legítima:** `crm_*` referencia `clientes` e `usuarios` por
  FK simples; a validação de mesma empresa é do serviço
  (`validarReferenciasDaEmpresa`), como no restante do ERP.

### 7.2 Conversão Lead → Oportunidade (implementada nesta execução)

`POST /api/crm/leads/:id/converter` — `server/src/crm.ts`

| Garantia | Como |
|---|---|
| Transacional | `s.transaction(..., { isolation: 'serializable' })` |
| Idempotente | `lead_convertido_em` gravado por **compare-and-swap** (`UPDATE … WHERE lead_convertido_em IS NULL`); repetir devolve a **mesma** oportunidade (HTTP 200, `idempotente: true`) |
| Multiempresa | lead lido com `{ id, empresa_id }` → 404 para lead de outra empresa; oportunidade carimbada com a empresa da sessão; referências validadas no tenant |
| Auditável | duas entradas em `auditoria` (criar oportunidade / editar lead), com empresa do fato |
| Sem duplicar cliente | usa o cliente do lead ou **encontra** o cadastro pelo documento (`clientePorDocumento`); nunca cria cliente |
| RBAC | exige ler lead **e** criar oportunidade (gerente/admin) |
| Validação | payload passa pelo `validatePayload` do recurso (mesmas regras do CRUD) |

Interface: ação **"Converter em oportunidade"** na lista de leads
(`client/src/pages/ModulePage.tsx`), visível apenas para lead não convertido e
não encerrado; chamadas repetidas informam a oportunidade existente.

### 7.3 Estágio × status (Fase 6 — hardening sem parametrização)

`etapa` (posição no funil) e `status` (desfecho) são **dimensões separadas**:

| Regra | Comportamento |
|---|---|
| Fechar (ganha/perdida) | preenche `data_fechamento` se vazia |
| Reabrir (aberta) | limpa `data_fechamento` e o `motivo_perda_id` |
| Oportunidade fechada | **não muda de estágio** (409) — o histórico do funil não é reescrito |
| Reabrir + mudar etapa | permitido na mesma operação (é uma decisão de negócio explícita) |
| Motivo de perda | só existe em `perdida`; obrigatório nesse status (400 + CHECK no banco) |

Estágios continuam **hard-coded** (`prospeccao → qualificacao → proposta →
negociacao → fechamento`) — parametrização por empresa é evolução **P2**, não
requisito desta entrega.

### 7.4 Índices do funil (migration 0050)

- `crm_leads (empresa_id, origem)` — filtro de origem (Fase 7).
- `crm_oportunidades (empresa_id, lead_id)` — idempotência da conversão e
  drill-down do funil por lead.

---

## 8. Vendas × `sales` (projeção analítica)

```
vendas (operacional: status, itens, financeiro, estoque)
   │  projeção idempotente (negocios.projetarVendas)
   ▼
sales / sale_items (read model analítico, namespace `erp:`)
   ▼
BI (Meu Negócio, produto_abc, comissões)
```

- A projeção usa `INSERT … ON CONFLICT (id) DO UPDATE`, marca canceladas como
  `CANCELLED` e remove projeções órfãs — repetir a projeção não duplica receita.
- Venda de marketplace **não** é reprojetada (`pedido_externo_id IS NOT NULL`):
  ela já tem a linha de `sales` que a originou (`operational_venda_id`).
- Margem é recalculada **na mesma transação** da projeção.
- Nenhum dashboard/BI é fonte de verdade financeira: a receita é de `vendas` e
  do financeiro; `sales` é derivada.

---

## 9. Evidências executadas nesta execução

| Gate | Resultado |
|---|---|
| `npm run typecheck` (domain + server + client) | **PASS** |
| `npm run lint` | **PASS** — 0 erros (avisos pré-existentes de `no-explicit-any`) |
| `npm test` (server + client) | **PASS** — server 1.261/1.329 (68 skip), client 834/834 |
| `npm run build` | **PASS** |
| `npm run audit:menu` | **PASS** — sem erros |
| `npm run architecture:audit` | **PASS** — 0 erros, 10 avisos classificados (`TENANT_SEM_TESTE` zerado) |
| `npm run smoke` (Express real, HTTP) | **PASS** — 327/327, incluindo 10 verificações de CRM |
| `npm run smoke:pg` (PostgreSQL 16.14 real, banco novo) | **PASS** — 327/327 |
| `npm run test:pg` (PostgreSQL 16.14 real) | **PASS parcial** — 277/290 (12 skip + 1 falha por ausência do cliente `psql` neste sandbox; o job `testes-postgres` do CI é verde com `postgresql-client-16`) |
| `npm run db:validate` | **BLOQUEADO neste sandbox** — `prisma validate` baixa o `schema-engine` de `binaries.prisma.sh` (fora da allowlist de rede); o CI executa o mesmo comando no job `verificar` |

---

## 10. Decisões tomadas nesta execução (registro)

| # | Decisão | Justificativa |
|---|---|---|
| D1 | CRM não ganhou segundo modelo de representante/equipe/território/metas/comissão | Esses domínios já existem (`representantes`, `equipes_comerciais`, `territorios`, `metas`, `planos_comissao`); criar `crm_*` duplicaria a verdade |
| D2 | Conversão Lead → Oportunidade implementada com as tabelas atuais | É o único elo do funil sem caminho; não requer arquitetura paralela |
| D3 | `lead_convertido_em` exposto como campo **readonly** do recurso | O store só grava colunas declaradas (allowlist); `readonly` mantém a escrita fora do CRUD genérico |
| D4 | Estágio congelado após fechamento, reabertura permitida | Impede reescrever histórico sem bloquear operação legítima |
| D5 | Estágios continuam hard-coded | Parametrização é P2; mudar agora aumentaria risco sem fechar gap P0/P1 |
| D6 | Prisma **não** recebeu modelos de CRM | CRM é ERP puro (SQL); o Prisma é bounded context do commerce (§6) |
| D7 | Nenhuma tabela nova no CRM nesta fase, só índices | A 0049 já cobria o modelo; a 0050 cobre o acesso |
| D8 | `npm run architecture:audit` criado em vez de segundo relatório manual | Os números deixam de ser digitados à mão e passam a ser gate de CI |
