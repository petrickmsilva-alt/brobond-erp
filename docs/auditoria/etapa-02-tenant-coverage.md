# ETAPA 02 — TENANT COVERAGE (P1)

**Data:** 2026-11-14 · **Branch:** `arena/20369110-brobond-erp`
**Entrada:** inventário `docs/ERP-3.0-ARCHITECTURE-INVENTORY.json` com **19** avisos `TENANT_SEM_TESTE` (199 recursos; 179 multiempresa).
**Saída:** inventário regenerado com **0** avisos `TENANT_SEM_TESTE`; 1 defeito real encontrado e corrigido; classificação GLOBAL reconciliada com evidência.

> Ausência de teste nominal NÃO foi tratada como vulnerabilidade: cada recurso
> foi investigado (tabela → empresa → handler → rota → auth → derivação de
> tenant → filtro SQL → CRUD → relações → testes existentes) antes de concluir.

## 1. Mapa dos 19 recursos (empresa dona → handler → isolamento)

| Recurso | Escrita real | Leitura | Isolamento comprovado |
|---|---|---|---|
| `creator_commands` | `server/src/creators.ts` (idempotência; `Idempotency-Key`) | interno (sem CRUD genérico) | chave única por `(empresa_id, idempotency_key)`; mesma chave em A e B = operações distintas |
| `service_ticket_categorias` | CRUD genérico (`ALL_OPS`, gerente) | CRUD genérico | `listRecords/getRecord/updateRecord/deleteRecord` com escopo; cross-tenant 404 |
| `condicoes_pagamento` | CRUD genérico (gerente) | CRUD genérico | idem |
| `produto_precos_condicao` | CRUD genérico + carga versionada (`cargaPoliticaComercial.ts`) | CRUD + `motorPrecos.precoCondicaoDetalhe` (filtro `empresa_id`) | idem + referência cruzada a produto de B recusada |
| `produto_precos_condicao_historico` | carga versionada (append-only) | interno | empresa explícita na carga; leitura recortada |
| `politica_comercial_descontos_cumulativos` | CRUD genérico (gerente) | CRUD + resolver | escopo genérico |
| `politica_preco_minimo` | CRUD genérico (gerente) | CRUD + `avaliarPrecoMinimo` | escopo genérico |
| `precificacao_memoria` | **`registrarMemoriaPrecificacao`** (append-only) | CRUD RO | **DEFEITO REAL** — ver §2 |
| `devolucoes_fornecedor` | `devolucaoFornecedor.ts` (domainLock + idempotency) | handler dedicado | compra/itens validados `WHERE empresa_id`; documento de A → 404 para B |
| `devolucao_fornecedor_itens` | handler (dentro da tx do documento) | interno | empresa carimbada; filtro por empresa |
| `devolucao_fornecedor_eventos` | handler (trilha) | interno | idem |
| `woocommerce_product_links` | `woocommerce/vinculos.ts` | painel/reconciliação | chave lógica `(empresa_id, store_key, produto_id)`; mesmo ID externo em A/B não cruza |
| `woocommerce_sync_state` | `woocommerce/estado.ts` | painel | `(empresa_id, store_key)`; água-marca de A não toca B |
| `woocommerce_webhook_events` | `webhookInbox.registrarEntrega` | painel | idempotência por empresa+entrega; `entregaPorId(B, idA)=null`; B não reenfileira A |
| `woocommerce_reconciliacao_divergencias` | `reconciliacao.registrarDivergencia` | painel | fingerprint única por `(empresa_id, store_key, fingerprint)` |
| `operational_audit_events` | `audit.auditarOperacao` (hash-chain) | interno | cadeia por empresa; 1º evento de B não encadeia em hash de A |
| `oauth_consents` | `/oauth/authorize` (empresa da SESSÃO) | interno | empresa do usuário no consentimento |
| `oauth_authorization_codes` | `codes.criarCodigo` (PKCE) | interno | código carimba empresa; troca devolve a empresa do código |
| `oauth_tokens` | `tokens.emitir*` | interno | `emp` claim + coluna; revogar token de A não revoga B |

**Arquitetura de tenancy** (fonte: `server/src/empresa.ts`, `services.ts`): o recorte entra como filtro obrigatório AND; `f.empresa_id` do cliente é descartado; cross-tenant responde **404** (403 vazaria existência); escrita carimba `escopoDe(actor)`; recursos `internal: true` não passam pelo CRUD genérico (`getPublicResource`).

## 2. Defeito real encontrado e corrigido — `precificacao_memoria`

**Sintoma (reproduzido antes da correção):** `registrarMemoriaPrecificacao` não informava `empresa_id`.
- MemStore: linha de um produto da **empresa 2** era gravada com `empresa_id = 1` (default) → **escrita cross-tenant** na trilha de preços;
- PostgreSQL real: a coluna é `NOT NULL` **sem default e sem trigger de herança** → INSERT recusado (`null value … violates not-null constraint`) — a trilha nunca era gravada em produção.

**Correção (cirúrgica, `server/src/commerce/motorPrecos.ts`):** a empresa é derivada do **produto** no servidor (nunca do cliente/default); produto inexistente → `null` (sem trilha órfã). Nenhuma migration necessária (a coluna já existia correta).

**Regressões:** `server/test/etapa02-tenant-coverage.test.ts` (memória) + `server/test/pg-precificacao-memoria-tenant.test.ts` (PG real: gravação, leitura recortada A/B, órfã recusada).

**Impacto:** o helper hoje só é chamado por testes (nenhum fluxo de produção o invocava ainda — `grep` em `server/src`); o defeito era **latente**, e a correção impede que o primeiro uso real nasça cross-tenant. Classificação: problema real de código (não exploit em produção).

## 3. Classificação GLOBAL reconciliada no gate final

O gate `go-live:audit` tinha P0 **preexistente** (confirmado na baseline intacta via `git stash`): `TABELA_SEM_EMPRESA_ID: fiscal_layouts, oauth_clients`. Investigação:
- `fiscal_layouts` (0115): **referência oficial versionada** de leiautes SPED/EFD (ato normativo, `fonte_url`, vigência); recurso `READ_ONLY`, semeado por migração — não é dado de empresa;
- `oauth_clients` (0121, linha ~191): **GLOBAL documentado** — "o cliente é a aplicação (ChatGPT), não o tenant"; codes/tokens/consents **têm** `empresa_id`.

Correção: entradas adicionadas ao conjunto `GLOBAIS` do gate **com a justificativa inline** + teste que TRAVA a evidência (`server/test/final-gate-globais.test.ts`): se o desenho mudar (empresa:true, escrita liberada, documentação removida), o teste falha. Não é exceção silenciosa.

## 4. Testes executados (resultados reais)

| Suíte | Resultado |
|---|---|
| `server/test/etapa02-tenant-coverage.test.ts` (novo; 19 recursos, A×B, ID-bypass, batch filter forjado, webhook, hash-chain, OAuth) | **15/15 pass** |
| `server/test/final-gate-globais.test.ts` (novo) | **3/3 pass** |
| `server/test/commerce-motor-precos.test.ts` (existente, pós-correção) | **14/14 pass** |
| Suíte completa de memória do servidor (`npm --workspace server test`) | **2607 pass / 0 fail / 95 skip** (skips = arquivos PG-dependent sem DATABASE_URL, padrão do repo) |
| Gate PG (`npm run test:pg`, PG 16.14, banco vazio, Node 24, psql no PATH) | **500/500 pass, 0 fail/skip/todo — GATE PASS** (inclui as 2 regressões novas) |
| `npm run architecture:audit` (regenerado) | **0 erros; TENANT_SEM_TESTE: 19 → 0** |
| `npm run go-live:audit` | **exit 0** — P0: 0, P1: 0; P2: colisão histórica 0121 (Etapa 01, com plano); 17/17 testes HTTP obrigatórios de autorização passaram |
| `npm run typecheck` (domain+server+client) | **exit 0** |

**Nota de honestidade:** a primeira execução do `test:pg` falhou (1 fail / 13 skip) por **ambiente** — `psql` fora do PATH (o wrapper psql e testes classe-C exigem o binário). Com `psql` 16 disponível, reexecução em banco novo: 500/500. O bloqueio anterior foi registrado, não escondido.

## 5. Ressalvas

- `oauth_clients` GLOBAL: cadastro da aplicação é compartilhado entre empresas por desenho documentado; segregation dos dados sensíveis está em codes/tokens/consents (por empresa). Registro dinâmico é restrito a callbacks oficiais (RFC 7591 limitador).
- Os testes A×B usam o mecanismo real de escopo do servidor, mas em MemStore os constraints UNIQUE do PG não são reproduzidos — a autoridade de idempotência concorrente continua nos testes PG (`pg-operational-control`, `pg/e03-multiempresa-ab`, gate 500/500).
- Cobertura nominal ≠ exaustão: o inventário agora aponta teste para os 19, e os comportamentos críticos (ID-bypass, batch, webhook, async, relações) estão provados; novos fluxos multi-tenant futuros devem nascer com teste A×B (regra do AGENTS.md).
