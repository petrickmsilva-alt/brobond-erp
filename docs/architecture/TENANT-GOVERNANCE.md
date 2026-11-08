# TENANT-GOVERNANCE — isolamento multiempresa

**Data:** 2026-11-07 · **Branch:** `architecture/fase-1-foundation`
**Referência:** ADR-0004 (multi-tenant), [`SOURCE-OF-TRUTH.md`](SOURCE-OF-TRUTH.md).

> **Invariante.** A empresa ativa é resolvida do **ator autenticado + sessão
> (claim `emp`) + concessão (`usuario_empresas`)** — **nunca** de `empresa_id`
> enviado no corpo/query. Listagem de recurso multiempresa recebe filtro
> `empresa_id` obrigatório; acesso por id de outra empresa responde **404**.

---

## 1. Como o tenant é resolvido (`server/src/empresa.ts`)

| Função | Papel |
|---|---|
| `escopoDoAtor(actor, req)` | Deriva o escopo (empresa ativa, permitidas, consolidado) **do ator**, não do cliente. |
| `escopoDe(empresaId)` | Escopo de um tenant explícito (jobs/workers/cron). |
| `aplicarFiltroEmpresa(r, filtro, escopo)` | Injeta `empresa_id` no filtro da listagem. |
| `carimbarEmpresa(r, data, escopo)` | Grava `empresa_id` na criação. |
| `empresaImutavel` | Bloqueia alteração de `empresa_id` na edição. |
| `validarReferencias` | Valida `type:'ref'` contra o mesmo tenant. |

O seletor `empresa_sessao` é honrado **somente** se a empresa estiver entre as
concedidas; a consolidação exige `pode_consolidar` **e** pedido explícito.

## 2. Superfícies cobertas

| Superfície | Isolamento |
|---|---|
| CRUD genérico (`/api/:recurso`) | `escopoDoAtor` + `aplicarFiltroEmpresa`; 404 cross-tenant |
| Endpoints de fluxo | `escopoDoAtor` no serviço; guard próprio |
| Jobs/cron (`scheduled.ts`) | `escopoDe(empresaId)` explícito por destino; idempotência por empresa |
| Webhooks | Empresa resolvida pelo **conector/rota**, nunca pelo payload (`webhooks.ts`) |
| Outbox | Chave única `(empresa, tipo, chave)`; entrega não cruza tenant |
| Relatórios/exportação | Recorte de empresa somado pelo servidor |
| Consultas analíticas (`sales`) | `empresa_id` na projeção |

## 3. Classificação das tabelas sem `empresa_id`

Nem toda tabela precisa de `empresa_id`; o erro perigoso é a tabela que
**deveria** ter isolamento e não tem. O registro canônico é
`server/src/tenant-tables.ts` (`TABELAS_SEM_EMPRESA_ID`), verificado contra o
DDL real por `server/test/tenant-tables-classificacao.test.ts` (uma tabela nova
sem `empresa_id` e sem classificação **falha o teste**).

| Categoria | Definição | Tabelas |
|---|---|---|
| **global** | não pertence a uma empresa (infra ou raiz de tenancy) | `empresas`, `sessoes`, `login_tentativas`, `cron_job_locks`, `cron_work_items` |
| **compartilhada** | transversal, escopada por outra chave | `configuracoes` (namespace de chave por empresa), `arquivos` (herda do recurso) |
| **referencia** | catálogo global compartilhado | `tamanhos`, `grades`, `grade_tamanhos`, `medidas`, `medida_valores`, `categorias`, `cores`, `impostos_ncm` |
| **herda-tenant** | isolamento herdado do pai tenant-owned (FK) | `catalogo_compartilhamentos`→`catalogos`, `catalogo_eventos`→`catalogos`, `portal_acessos`→`clientes`, `cotacao_decisoes`→`vendas` |
| **projecao** | read model analítico; herda a empresa da fonte | `sale_items`→`sales` |

**Total:** 20 tabelas sem `empresa_id`, **todas** classificadas. As 192
restantes (de 212) têm `empresa_id`.

> **Achado corrigido nesta fase.** O `architecture:audit` reportava **28**
> tabelas sem `empresa_id` por um defeito no parser de DDL (perdia colunas
> *inline*): as 8 tabelas `payment_*` **têm** `empresa_id` e apareciam como
> falso positivo. O parser foi corrigido e há teste de regressão
> (`server/test/arquitetura-audit-parser.test.ts`). Cobertura real de
> `empresa_id`: **192/212 = 90,6%** (antes reportado 184/212).

## 4. Testes negativos de isolamento (obrigatórios)

| Verificação | Onde |
|---|---|
| A não lê dados de B | `multiempresa.test.ts`, `tenant-isolamento-3-0.test.ts` |
| A não altera dados de B | `multiempresa-paridade.test.ts` |
| A não acessa recurso de B por id previsível (404) | `multiempresa-nominal.test.ts` |
| Jobs/cron não cruzam tenant | `cron-processos-independentes.test.ts`, `segregacao-multiempresa-alertas.test.ts` |
| Webhooks não cruzam tenant | `webhooks-empresa-isolamento.test.ts`, `webhook-empresa-resolucao.test.ts` |
| Relatórios não agregam indevidamente | `alertas-isolamento-empresa.test.ts` |
| Outbox não cruza tenant | `outbox-notificacoes-cross-tenant.test.ts` |
| Governança de tenancy (classificação completa) | `tenant-tables-classificacao.test.ts` **(novo)** |

## 5. GAPs e ações

| GAP | Severidade | Ação | Fase |
|---|---|---|---|
| Integridade cross-tenant de `crm_*` só por FK simples | P2 | FK composta E4.2 + `VALIDATE CONSTRAINT` | Fase 2 |
| `arquivos` herda tenant do recurso referenciado | P3 | documentado; revisar se ganhar consulta direta | Fase 2 |

## 6. Regras de evolução

1. Tabela nova com `empresa_id` **precisa** de recurso com `empresa: true` **ou**
   escopo por endpoint próprio (padrão `gateway_*`/`payment_*`/`logistics_*`).
2. Tabela nova **sem** `empresa_id` **precisa** entrar em
   `TABELAS_SEM_EMPRESA_ID` com categoria e motivo — senão o gate falha.
3. Nunca inserir `empresa_id` em tabela global/referência por conveniência.
4. Toda correção de isolamento exige migração segura + teste.
