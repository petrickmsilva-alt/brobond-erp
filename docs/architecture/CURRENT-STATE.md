# CURRENT-STATE — auditoria do estado atual (Fase 0)

**Data:** 2026-11-07 · **Branch:** `architecture/fase-0-blueprint` · **Base:** `main`
**Método:** leitura direta do código + execução dos gates do repositório.
**Fonte dos números:** `npm run architecture:audit`, `npm run audit:menu`,
`npm run audit:ux`, suítes de teste e inspeção de `db/`, `server/src/`,
`modules/`, `packages/`, `client/src/`.

> **Regra.** Toda afirmação de estado tem evidência. Onde a verificação não pôde
> ser executada no sandbox, o item aparece como **BLOQUEADO** — nunca como
> "aprovado". Os comandos e resultados reais estão em §9.

---

## 1. Identidade do sistema

| Item | Valor | Evidência |
|---|---|---|
| Produto | BROBOND ERP (ERP de cadeia completa) | `README.md`, `package.json` (`brobond-ai-erp`) |
| Stack cliente | React 19 + TypeScript + Vite + Tailwind | `client/package.json`, `client/vite.config.ts` |
| Stack servidor | Node + Express + TypeScript | `server/package.json`, `server/src/index.ts` |
| Banco | PostgreSQL (SQL-first) | `db/schema.sql`, `db/migrations/*.sql` |
| ORM parcial | Prisma **apenas** no bounded context do commerce | `prisma/schema.prisma` (11 modelos) |
| Filas | `commerce_outbox` (fila única, claim CAS, backoff, DLQ) | `server/src/commerce/outbox.ts` |
| Runtime | Node **24** (exigência de CI) | `.github/workflows/ci.yml` |
| Testes | `node --test` (server) + Vitest (client) | `server/package.json`, `client/vitest.config.ts` |

**Natureza real:** monólito modular, multiempresa (`empresa_id`) e multi-loja
(`RETAIL`/`WHOLESALE`), com uma projeção analítica (`sales`) separada da fonte
operacional (`vendas`).

---

## 2. Inventário real (lido do código)

Saída de `npm run architecture:audit` nesta baseline:

| Dimensão | Valor |
|---|---:|
| Migrations SQL (`db/migrations/*.sql`) | **104** |
| Migrations Prisma (`prisma/migrations/`) | **7** |
| Tabelas no SQL do ERP | **212** (com `empresa_id`: **192**) |
| Índices nomeados | **580** |
| Constraints nomeadas | **386** |
| Recursos de API (`RESOURCES`) | **174** (multiempresa: **156**) |
| Cobertura de tenant | **89,7%** dos recursos com tabela |
| Recursos com RBAC restrito | **80** |
| Módulos de navegação (`MODULES`) | **144** (áreas: 11, grupos: 35) |
| Rotas HTTP | **474** |
| Modelos Prisma | **11** (com `empresaId`: 5) |
| Casos de teste declarados | **3.578** em 427 arquivos |

> **Reconciliação numérica (Fases 0–2).** A baseline da Fase 0 reportava
> 103 migrations, 184 tabelas com `empresa_id`, 570 índices e 3.533 casos de
> teste. As diferenças são todas explicadas: a Fase 1 **corrigiu um defeito do
> parser de DDL** que perdia colunas *inline* (8 tabelas `payment_*` apareciam
> sem `empresa_id` — falso positivo), elevando a cobertura real para **192/212**;
> a Fase 2 adicionou a migration aditiva `0104_crm_integridade_multempresa.sql`
> (104 migrations, +10 índices) e 3 arquivos de teste. **Recursos = 174** em
> ambas as fases (nenhum recurso foi criado ou removido). O número **176** que
> já circulou em revisões é o total de linhas da tabela do `RBAC-MATRIX.md`
> (174 recursos + cabeçalho + separador) — não é a contagem de recursos.

Código (linhas): `server/src` + `modules` + `packages` ≈ **254 mil linhas**
de TypeScript; `client/src` com **344** arquivos `.ts/.tsx`; `server/src` com
**178** arquivos `.ts`.

---

## 3. Estrutura de diretórios

```
brobond-erp/
├── client/                  # SPA React (ERP + vitrine pública /loja)
│   └── src/
│       ├── modules.ts       # FONTE ÚNICA da navegação (módulos/áreas/grupos)
│       ├── App.tsx          # roteamento (admin + rotas públicas)
│       ├── pages/           # páginas por módulo
│       └── components/      # design system (ui.tsx, PainelInline…)
├── server/                  # API Express + regras de negócio
│   └── src/
│       ├── resources.ts     # FONTE ÚNICA de recursos (tabela/coluna/validação/RBAC)
│       ├── index.ts         # 474 rotas
│       ├── empresa.ts       # isolamento multiempresa (tenancy)
│       ├── services.ts      # CRUD genérico + RBAC (checkAccess)
│       ├── auth.ts          # autenticação + perfis (admin/gerente/operador)
│       ├── auditChain.ts    # auditoria com cadeia de hashes (tamper-evidence)
│       ├── observability.ts # request/correlation id + logs estruturados
│       ├── commerce/        # vitrine, pedidos, catálogo, outbox, woocommerce/
│       ├── scheduled.ts     # cron (relatorios|pagamentos|publicacoes|pedidos|crm)
│       └── ...
├── modules/                 # bounded contexts desacoplados
│   ├── connectors/          # ingestão multicanal (mercadolivre, nuvemshop, …)
│   ├── payments/            # Payment Engine (domain/application/providers)
│   └── logistics/           # Logistics Engine (domain/application/providers)
├── packages/
│   ├── domain/              # tipos de domínio compartilhados (@brobond/domain)
│   └── infra/               # infraestrutura compartilhada
├── db/
│   ├── schema.sql           # espelho estrutural (bootstrap)
│   ├── bootstrap.sql        # gerado por scripts/gerar-bootstrap.mjs
│   └── migrations/*.sql     # cadeia versionada (ordem léxica)
├── prisma/schema.prisma     # bounded context do commerce (11 modelos)
├── scripts/                 # audits (arquitetura, menu, ux) e utilitários
└── docs/                    # documentação (histórica + este diretório)
```

---

## 4. Doutrina vigente (o que o código realmente faz)

1. **SQL/migrations são a fonte da verdade do schema.** Prisma é *bounded
   context* do commerce; não substitui o SQL. — `AGENTS.md`, `prisma/schema.prisma`.
2. **Empresa = tenant; usuário = identidade.** `empresa_id` recorta dados;
   `usuario_id` é autoria, nunca tenant. — `server/src/empresa.ts`.
3. **A empresa de um registro é decidida pelo SERVIDOR**, nunca pelo corpo da
   requisição. — `carimbarEmpresa`, `aplicarFiltroEmpresa`.
4. **Acesso por ID de outra empresa responde 404** (não 403, para não vazar
   existência). — `assertRegistroDaEmpresa`.
5. **RBAC é do servidor**, não do menu. — `checkAccess` em `services.ts`.
6. **Cadastro se desativa, documento se cancela, histórico nunca se apaga.**
   — `DELETE` só sem vínculo (409 com `dependencias_vinculadas`).
7. **Movimento ≠ saldo:** `movimentacoes` é evento; `estoques` é projeção.
   — `docs/ESTOQUE-CANONICO.md`, `server/src/estoqueCanonico.ts`.
8. **Pedido ≠ receita:** `vendas` é operacional; `sales` é read model.
   — `docs/ERP-3.0-DUPLICITY-AUDIT.md` §2.1.
9. **Toda operação crítica é auditada** com empresa, usuário, antes/depois e
   encadeamento de hashes. — `server/src/auditChain.ts`.
10. **Todo evento externo é idempotente** e passa pela `commerce_outbox`.
    — `server/src/commerce/outbox.ts`.

---

## 5. Superfícies principais

### 5.1 Backend (`server/src`)

- **API genérica dirigida por metadados:** `resources.ts` (174 recursos) declara
  tabela, colunas, validação, RBAC e escopo de empresa; `services.ts` executa o
  CRUD; `store.ts`/`pgstore.ts` montam o SQL. Isso é a espinha dorsal do ERP.
- **Handlers especializados:** comissões, financeiro, fiscal, produção, compras,
  logística, PDV, expedição, portal, marketplace.
- **Integrações:** `commerce/` (vitrine, pedidos, catálogo, publicações,
  reconciliação, outbox) e `loja.ts` (integração WooCommerce legada por env).
- **Jobs:** `scheduled.ts` com 5 processos isolados (`relatorios`, `pagamentos`,
  `publicacoes`, `pedidos`, `crm`), cada um dono dos seus tipos de outbox.
- **Segurança:** `auth.ts`, `security.ts` (CORS, trust-proxy explícito, rate
  limit persistente), `segredos.ts`/`chavesCifra.ts` (AES-256-GCM).

### 5.2 Bounded contexts desacoplados (`modules/`)

| Contexto | Camadas | Providers |
|---|---|---|
| `modules/payments` | api / application / domain / infrastructure / orchestration | mercado-pago, pagbank, stripe, generic, manual, testing |
| `modules/logistics` | api / application / domain / infrastructure / integration | providers por transportadora |
| `modules/connectors` | core / ingestion / webhooks + mercadolivre, nuvemshop, mercadopago, instagram | por plataforma |

### 5.3 Frontend (`client/src`)

- `modules.ts` é a **fonte única** da navegação (144 módulos, 11 áreas, 35
  grupos); `App.tsx` deriva rotas; `ModulePage` resolve CRUD genérico.
- **Zero modal** em fluxo de módulo (gate `audit:ux`); confirmações via
  `ConfirmacaoInline`; padrão **LISTA → DETALHE → `/recurso/novo`**.

---

## 6. Domínios implementados (resumo — detalhe em `DOMAIN-MAP.md`)

| Domínio | Estado | Tabelas-âncora |
|---|---|---|
| ERP Core (cadastros, empresa, usuário) | 🟢 existente e funcional | `empresas`, `usuarios`, `usuario_empresas`, `clientes`, `fornecedores` |
| PIM (produto/SKU/variação/grade) | 🟢 existente e funcional | `produtos`, `variacoes`, `grades`, `grade_tamanhos`, `tamanhos`, `cores`, `colecoes` |
| Commerce / OMS | 🟢 existente e funcional | `commerce_pedidos`, `commerce_produtos`, `commerce_publicacoes` |
| Vendas / PDV / Comissões | 🟢 existente e funcional | `vendas`, `itens_venda`, `pdv_*`, `comissoes_apuradas`, `venda_atribuicao` |
| Estoque / WMS | 🟢 existente e funcional | `estoques`, `movimentacoes`, `estoque_reservas`, `locais`, `estoque_transferencias` |
| Compras / Suprimentos | 🟢 existente e funcional | `compras`, `cotacoes_compra`, `fornecedor_*` |
| Produção | 🟢 existente e funcional | `ordens`, `fichas_tecnicas`, `producao_recursos` |
| TMS / Logística | 🟢 existente e funcional | `envios`, `envio_eventos`, `logistics_*` |
| Payments | 🟢 existente e funcional | `payment_*`, `gateway_cobrancas`, `gateway_webhooks_*` |
| Financeiro | 🟢 existente e funcional | `lancamentos`, `fin_extrato_*`, `cnab_*` |
| Fiscal | 🟡 parcial (NF-e/NFC-e; sem SPED) | `documentos_fiscais`, `regras_fiscais`, `fiscal_execucoes` |
| CRM | 🟢 existente e funcional | `crm_leads`, `crm_oportunidades`, `crm_funis`, `crm_etapas` |
| BI / Meu Negócio | 🟢 existente e funcional | `sales`, `sale_items`, `produto_abc` |
| Marketing / Loyalty / Creators | 🟡 parcial | `commerce_promocoes`, `creators_*` |
| Platform / Security / Governance | 🟢 existente e funcional | `auditoria`, `sessoes`, `segredos` |

---

## 7. Riscos e achados já conhecidos (do repositório)

O repositório já mantém uma matriz de gaps madura (`docs/ERP-3.0-GAP-MATRIX.md`,
`docs/RELATORIO-PR95-AUDITORIA-INTEGRAL.md`). Os achados relevantes para esta
missão, herdados como ponto de partida:

| ID | Severidade | Achado | Situação |
|---|---|---|---|
| GAP-P2-17 | P2 | `test:pg`/`smoke:pg`/`prisma validate` dependem de PG real e rede | CI executa; sandbox local **BLOQUEADO** |
| GAP-P2-11/12 | P2 | Fiscal sem layout SPED/EFD | Aberto (depende do contador) |
| GAP-P2-13 | P2 | Plano de contas sem importação em massa | Aberto |
| GAP-P2-14 | P2 | Lembrete CRM sem notificação ativa | Aberto |
| GAP-P2-21..27 | P2 | Painéis de fluxo de módulo residuais | Aberto (UX) |
| ADR-008 §6 | Decisão | Relação `/loja` nativo × RETAIL Woo (DNS/edge) | **Decidido nesta missão**: retirar o nativo |
| GAP-P2-04 | P2 | Integridade cross-tenant de `crm_*` no banco só por FK simples | Aberto |
| GAP-P3-04 | P3 | `insumos.unidade` texto livre | Aberto |

---

## 8. O que NÃO foi presumido

- Não foi presumido que o nome de um módulo corresponde à implementação: cada
  domínio foi conferido contra `resources.ts` e `db/`.
- Não foi tratado código existente como "implementado nesta missão": ver
  `docs/architecture/MASTER-BACKLOG.md` e os relatórios por fase.
- Não foi criada arquitetura genérica: os documentos apontam arquivo e linha.

---

## 9. Evidência executada (Fase 0)

Todos os comandos rodaram no sandbox desta sessão, com `DATABASE_URL`
**desmarcado** (conforme `AGENTS.md`).

| Verificação | Comando | Resultado |
|---|---|---|
| Typecheck | `npm run typecheck` | ✅ OK (domain + server + client) |
| Testes server | `npm --workspace server test` | ✅ **2.183 pass · 0 fail · 88 skip** |
| Testes client | `npm --workspace client test` | ✅ **1.165 pass · 0 fail** |
| Lint | `npm run lint` | ✅ **0 errors** (615 warnings — baseline) |
| Inventário arquitetural | `npm run architecture:audit` | ✅ OK (34 AVISOS classificados) |
| Auditoria de menu | `npm run audit:menu` | ✅ OK (21 AVISOS classificados) |
| Auditoria de UX | `npm run audit:ux` | ✅ OK (0 sobreposição nova) |
| `test:pg` / `smoke:pg` | — | ⏳ **BLOQUEADO** no sandbox (sem PG local) — CI cobre |
| `prisma validate` | `npx prisma validate` | ⏳ **BLOQUEADO** no sandbox (download do engine) — CI cobre |

> Os `skips` dos testes são auto-pulos por ausência de PostgreSQL/cliente `psql`
> no sandbox; no CI (Node 24 + `postgresql-client-16`) eles executam.

---

*Próximo documento: [`DOMAIN-MAP.md`](DOMAIN-MAP.md).*
