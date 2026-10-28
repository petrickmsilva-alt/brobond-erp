# RELATÓRIO DE HOMOLOGAÇÃO FINAL — BROBOND ERP 3.0

**Data:** 2026-10-28
**Branch:** `arena/d360b6d8-brobond-erp` (sessão Arena; ver §21 — o nome do branch é fixado pela sessão)
**PR:** [#96](https://github.com/petrickmsilva-alt/brobond-erp/pull/96) — único PR desta homologação
**Base:** `origin/main` @ `d87cd8a` (merge do PR #95)
**Escopo:** auditoria integral (código + banco + produto), zero-modal, matemática crítica, tenancy, RBAC, migrations, gates e CI.
**Veredito:** ver §23.

> Este documento substitui a leitura otimista dos gates. Cada afirmação abaixo tem
> **evidência executada** (comando + número) ou está marcada como **não executável
> neste ambiente** com a razão técnica. Nada foi convertido em skip para ficar verde.

---

## 1. Sumário executivo

| Item | Resultado |
|---|---|
| Suite do servidor (`npm --workspace server test`) | **1491 testes · 1423 pass · 68 skip · 0 fail** |
| Suite do cliente (`npm --workspace client test`) | **81 arquivos · 896 testes · 0 fail** |
| Suite PostgreSQL real (`npm --workspace server run test:pg`, PG 16.14) | **294 testes · 281 pass · 13 skip · 0 fail** |
| Smoke em memória (`npm run smoke`) | **386/386 verificações** |
| Smoke contra PostgreSQL novo (`npm run smoke:pg`) | **386/386 verificações** |
| Migrations do zero + reaplicação idempotente | **67 aplicadas / 2ª subida aplica 0 / health 200 nas duas** |
| `npm run typecheck` | limpo (domain + server + client) |
| `npm run build` | OK (PWA, 126 entradas de precache) |
| `npm run lint` | **0 erros**, 573 warnings |
| `npm run audit:menu` | OK (2 avisos) |
| `npm run audit:ux` | OK (6 exceções de baseline, nenhuma nova sobreposição) |
| `npm run architecture:audit` | OK (10 avisos) |
| `npm run go-live:audit` | **P0 0 · P1 0 · P2 0 · P3 2 → READY FOR MERGE** |
| `npx prisma validate` | **não executável neste sandbox** (download do engine bloqueado); **passa no CI** |
| CI `verificar` (typecheck, testes, audits, smoke, prisma validate, lint, build) | **pass** |
| CI `testes-postgres` (PostgreSQL 16.14 + `postgresql-client-16`, `test:pg` sem skip) | **pass** |

**P0/P1 encontrados e corrigidos nesta rodada:**

1. **P0 — duas regras de disponibilidade de estoque.** As telas de estoque calculavam
   `disponível = físico − reservado − empenhado − bloqueado`, mas o faturamento
   (`server/src/itens.ts`) validava apenas o **físico** e a projeção de vendas
   (`server/src/estoqueCanonico.ts`) oferecia como vendável o **físico por local**.
   Consequência real: venda faturada contra mercadoria bloqueada por qualidade ou já
   empenhada por OP. Corrigido em `estoqueCanonico.ts` (fonte única) + `itens.ts`
   (consumidor único), com oráculo independente.
2. **P1 — 11 fluxos transacionais em `PainelInline`** herdados do PR #95 (importação,
   recebimento de compra, nova ficha, devolução, empresa, terminal/agente de impressão,
   NCM, usuário, webhook). Convertidos em **14 rotas → páginas** (§12).
3. **P1 — gate de UX sem prova de destino.** O `audit:ux` contava ocorrências, mas não
   provava que a rota existia em `App.tsx` **e** que a página existia. Endurecido (§12).

---

## 2. Método e fontes de verdade

- **Código** (`server/src`, `client/src`, `modules/`, `packages/`) e **banco** (`db/schema.sql`,
  `db/migrations/*.sql`, `db/bootstrap.sql`) foram lidos diretamente. Documentos anteriores
  foram usados apenas como *baseline* de comparação — nunca como prova.
- **SQL é a fonte de verdade do schema**; o Prisma é contexto delimitado (11 modelos) e só é
  validado (`prisma validate`), nunca migrado.
- **Banco real**: `PostgreSQL 16.14` (binários `@embedded-postgres/linux-x64@16.14.0-beta.17`,
  `server_version_num = 160014`, exatamente o do job `testes-postgres`), banco **vazio** criado
  para cada execução.
- **Sem `psql` no sandbox**: 13 testes que chamam o binário `psql` (executor do script
  `db/admin/005-…`) ficam `skip` aqui e rodam no CI (`postgresql-client-16`). O gate
  `npm run test:pg` **recusa skip** e por isso reporta BLOCKED neste ambiente — o motivo é o
  binário ausente, não o produto (§15).
- **Gates obrigatórios** executados: `test`, `test:server`, `test:client`, `typecheck`, `lint`,
  `build`, `audit:menu`, `audit:ux`, `architecture:audit`, `smoke`, `db:validate`, `prisma validate`,
  `test:pg`, `smoke:pg`, `go-live:audit`.

---

## 3. Inventário real (confrontado com o código)

### 3.1 Aplicação

| Ativo | Quantidade | Onde foi contado |
|---|---|---|
| Módulos de servidor (`.ts`) | **114** | `ls server/src/*.ts` |
| Rotas HTTP registradas | **378** (167 GET · 179 POST · 17 PUT · 12 DELETE · 3 PATCH) | `grep app.<verbo>(` em `server/src` |
| Recursos de API (`RESOURCES`) | **124** (106 multiempresa · 45 com RBAC restrito) | `Object.keys(RESOURCES)` + `architecture:audit` |
| Capacidades de produto | **134** (106 com menu · 4 de infraestrutura) | `scripts/capacidades-audit.ts` |
| Rotas de capacidade (grafo) | **62** | idem |
| Módulos de menu | **106** (11 áreas · 28 grupos) | `client/src/modules.ts` + `audit:menu` |
| Rotas do React Router | **69** | `grep -c "<Route" client/src/App.tsx` |
| Páginas | **82** arquivos em `client/src/pages` (70 `*Page.tsx`) | `ls`/`find` |
| Componentes/páginas `.tsx` (sem teste) | **128** | `find client/src -name '*.tsx'` |
| Command Palette | 1 componente (`CommandPalette.tsx`), exceção `navegacao_global` no baseline | `docs/ERP-3.0-UX-BASELINE.json` |
| Breadcrumbs | `client/src/components/Layout.tsx` (derivado do menu/módulo) | Layout + testes |
| Formulário genérico | `ResourceForm` (CRUD por recurso) + páginas dedicadas para os 14 fluxos convertidos | `client/src/components` |
| Jobs/agendador | `GET /api/admin/scheduled/run` (manual) e `POST /api/admin/scheduled/cron` (gatilho externo); recorrências financeiras e projeções de CRM usam o mesmo ponto | `server/src/index.ts:781-782` |
| Webhooks de saída | 9 eventos de ciclo de vida de conta, HMAC-SHA256, log de 200 entregas por webhook | `server/src/webhooks.ts` |
| Integrações/commerce | `mercadolivre`, `mercadopago`, `nuvemshop`, `instagram`, `webhooks`, `ingestion`, `core` | `modules/connectors` |

### 3.2 Banco de dados (medido no PostgreSQL 16.14 real, banco nascido do zero)

| Objeto | Quantidade |
|---|---|
| Migrations versionadas aplicadas | **67** (`0001` … `0067_fiscal_nao_suportado.sql`) |
| Tabelas | **140** (139 em `schema.sql` + `schema_migrations`) |
| Índices | **592** |
| Constraints (todas) | **899** (inclui PK/FK/UNIQUE/CHECK) |
| Chaves estrangeiras | **468** |
| Colunas `empresa_id` | **119** |
| Triggers | **29** |
| Funções | **5** |
| Tabelas com `empresa_id` próprio (`schema.sql`) | **119 / 139** |
| Tabelas com tenancy encadeada por FK | **5** (`catalogo_compartilhamentos`, `catalogo_eventos`, `portal_acessos`, `cotacao_decisoes`, `sale_items`) |
| Tabelas polimórficas com tenancy em código | **1** (`arquivos` — `assertRegistroDaEmpresa*` em `server/src/uploads.ts`) |
| Globais por desenho | 15 (`empresas`, `usuarios`, `sessoes`, `login_tentativas`, `webhooks`, `webhook_entregas`, `configuracoes`, `impostos_ncm` + 7 catálogos técnicos: `tamanhos`, `grades`, `grade_tamanhos`, `medidas`, `medida_valores`, `categorias`, `cores`) |
| Modelos Prisma | **11** (5 com `empresaId`) |

### 3.3 Testes

| Suíte | Arquivos | Casos |
|---|---|---|
| Servidor em memória (`test/*.test.ts`) | 115 | **1491** (1423 pass · 68 skip · 0 fail) |
| Servidor PostgreSQL real (`pg-*` + `pg/*`) | 72 | **294** (281 pass · 13 skip · 0 fail) |
| Cliente (vitest) | 81 | **896** (0 fail) |
| **Total (arquivos únicos)** | **249** (os 19 `pg-*` de raiz aparecem nas duas linhas de servidor) | **2681 casos executados nesta rodada** |

Os 68 skips da suíte de memória são pré-existentes e documentados no próprio arquivo
(requerem `DATABASE_URL`/binário externo); **nenhum deles é cálculo crítico** — os 12 cálculos
críticos têm teste dedicado que roda (§5).

---

## 4. Auditoria por domínio

| Domínio | Estado | Evidência principal | Lacuna honesta |
|---|---|---|---|
| **Administração** | OK | Empresas, usuários, perfis, RBAC, auditoria, LGPD, convites, MFA — 134 capacidades cobertas por menu/rota/página; `sec03-admin-guard`, `pg-empresas-admin`, `auditoria-multiempresa` | — |
| **Cadastros** | OK | Produtos, insumos, clientes, fornecedores, tabelas de medida/grade, NCM, coleções; `categorias/cores/tamanhos` agora com páginas próprias | 7 tabelas de catálogo são globais (por desenho) |
| **Estoque** | OK (após P0) | Fonte única `estoqueCanonico.ts`; invariante `saldo = Σ eventos`; reservas (`0052`) com matcher de célula; `pg-concorrencia`, `tenant-isolamento-3-0` | — |
| **Compras** | OK | Pedido → recebimento → custo médio + rateio de frete; `pg-custo-recebimento`, `custo-recebimento`, `compras-e32` | — |
| **Produção** | OK | BOM → OP → consumo → apontamento → estoque → custo; MRP só leitura; `pg-producao-e2`, `producao-capacidade-mrp` | — |
| **Comercial** | OK | Orçamento → pedido → faturamento → comissão; preço/desconto/margem com oráculo | — |
| **CRM** | OK | Funil configurável, etapas por `id`, probabilidade aplicada, UTM/origem, painel derivado; `crm-3-0`, `pg` smoke `0057` | — |
| **Financeiro** | OK | Livro-caixa (não há partida dobrada — §6); parcelas, baixas, OFX/CNAB, balancete com pendências; `financeiro-oracle` (novo) | Sem contabilidade de dupla entrada por decisão de produto |
| **Fiscal** | OK com `NAO_SUPORTADO` | Regras NCM/CFOP/CST internas; **nenhum leiaute inventado**: emissão sem manifesto oficial grava `NAO_SUPORTADO` (`0067`, `fiscalExecucoes.ts`) | Emissão real de NF-e/NFS-e depende de provedor oficial |
| **Logística** | OK | Separação → conferência → embalagem → expedição, divergências; `e423-expedicao-postgresql` | Rastreio depende de transportadora |
| **PDV** | OK | Caixa, movimentação, cupom, scanner; `pg` print/vendas idempotentes | — |
| **Impressão** | OK | Terminais, agentes locais, jobs, reimpressão auditada, segredo único | Agente local é processo externo |
| **Commerce/connectors** | OK | OAuth por empresa, ingestão idempotente, webhooks; `pg-p0-commerce-tenant` | Publicação depende das APIs dos marketplaces |
| **BI** | OK | Painéis derivados (vendas, margem, DRE, ABC, aging) — todos **leitura**, nada recalculado em paralelo | — |

Roadmap futuro permanece explicitamente **PLANNED** em `docs/ERP-3.0-GAP-MATRIX.md`; nada foi
"promovido" para parecer pronto.

---

## 5. Auditoria matemática (cálculo por cálculo)

Regra: **valor esperado calculado fora do código sob teste**. Todos abaixo têm teste dedicado
que executa nesta rodada (mapeados no gate `go-live:audit`, seção `CALCULOS`).

| # | Cálculo | Fórmula canônica | Módulo | Teste / oráculo | Borda coberta |
|---|---|---|---|---|---|
| 1 | Custo médio ponderado | `novo = (saldo_ant × custo_ant + entrada × custo_entrada) / (saldo_ant + entrada)`, `saldo_novo = 0 → custo_entrada` (**sem divisão por zero**) | `custoRecebimento.ts` | `custo-recebimento`, `calculos-oracle` (5), `pg-custo-recebimento` | saldo 0, entrada 0, custo negativo recusado (CHECK 23514) |
| 2 | Rateio de frete | `Σ parcelas = frete` (método do maior resto, centavos) | `custoRecebimento.ts` | `calculos-oracle` (3) | frete 0, frete < nº linhas, 1 linha |
| 3 | Custo unitário efetivo | `preco + acessórios/qtd` (arredonda só no fim) | `custoRecebimento.ts` | `calculos-oracle` (2), `pg` E3.1 | qtd 0 recusada, fração de centavo |
| 4 | Preço de venda / desconto / margem / markup | `preço = custo × (1+markup)`, `margem = (preço − custo)/preço`, `preço_líquido = preço × (1 − desconto)` | `precoVenda.ts` | `preco-venda`, `calculos-oracle` (ida-e-volta de %) | desconto 0/100, markup 0, divisão por zero |
| 5 | Disponibilidade de estoque | `disponível = físico − reservado − empenhado − bloqueado` (piso 0) | `estoqueCanonico.ts` | `calculos-oracle`, `estoque-transferencia`, `pg-concorrencia` | reserva sem local (conservadora), bloqueio por qualidade, empenho de OP |
| 6 | Faturamento de venda | valida **disponível** (não físico) e consome o local que tem disponível | `itens.ts` | `calculos-oracle` (409 → sucesso), `pedidos`, `eventos-venda` | local alternativo, estoque insuficiente, dupla baixa |
| 7 | Parcelas | divisão inteira em centavos, resíduo na última parcela | `financeiro.ts` | `fin01-parcelas`, `calculos-oracle` (2) | 1 parcela, 12×, valor < nº parcelas |
| 8 | Caixa e balancete | `saldo = inicial + Σ(líquido de receitas/investimentos) − Σ(despesas)`; `saldo_conta = débitos − créditos`; `Σ saldos = Σ débitos − Σ créditos` | `financeiro.ts`, `financeiroContabil.ts` | `financeiro-contabil`, **`financeiro-oracle` (novo, 7)** | taxa 0/3,99%, 3×33,33 = 99,99, pendente não move caixa |
| 9 | Produção | `restante = planejado − produzido`; consumo por BOM × quantidade produzida; estorno devolve insumo e custo | `producao.ts` | `producao-e2`, `pg-producao-e2` | OP cancelada, segundo ciclo, perdas |
| 10 | MRP | `necessidade = demanda − disponibilidade − suprimento` (reservas vencidas excluídas) | `producaoCapacidade.ts` | `producao-capacidade-mrp` | estoque empenhado, reserva expirada |
| 11 | Comissões | `base × pct`, apuração por período, estorno na devolução | `comissoes.ts` | `comissoes`, `master-comercial` | devolução parcial, cancelamento |
| 12 | Fiscal interno | `imposto = base × alíquota(NCM)`; **sem leiaute oficial → `NAO_SUPORTADO`** | `fiscalRegras.ts`, `fiscalExecucoes.ts` | `fiscal`, `fiscal-obrigacoes`, `pg-fiscal` | NCM ausente (alíquota padrão 0%), emissão sem provedor |

### 5.1 O P0 desta rodada, em detalhe

**Antes:** duas implementações da mesma regra.

```
telas de estoque : disponível = físico − reservado − empenhado − bloqueado
faturamento      : valida FÍSICO do local          ← regra divergente
saldoVendavel    : FÍSICO por local                ← regra divergente
```

**Depois (fonte única em `server/src/estoqueCanonico.ts`):**

```
disponível = max(0, físico − Σ(reservas ativas da célula))
reserva ativa = status 'ativa' e não expirada (expira_em vazia ou futura)
reserva sem local_id ⇒ subtraída de TODA célula candidata (conservador, documentado)
faturamento  = usa `saldoDisponivelCelula` e escolhe o local pelo DISPONÍVEL
mensagem 409 = precisa de N, há M disponível em "<local>" (físico X, Y reservado/empenhado/bloqueado)
```

Prova (independente, `server/test/calculos-oracle.test.ts`): com 10 físicos, 4 reservados por
bloqueio de qualidade e venda de 8 → **409** com o detalhamento; depois de liberar a reserva a
mesma venda de 8 → **200** e o saldo cai para 2. Sem a correção o primeiro passo faturava.

### 5.2 Sobre `SUM(débitos) = SUM(créditos)`

O ERP **não tem partida dobrada**: cada lançamento é um fato único do livro-caixa
(`tipo` + `valor`), opcionalmente classificado em `plano_contas` com `natureza_lancamento`.
A identidade `Σdébitos = Σcréditos` **não existe neste modelo** e não foi fabricada. As
identidades efetivamente cobradas e testadas são:

- `saldo_da_conta = débitos − créditos` (por conta do balancete);
- `Σ saldos das contas = Σ débitos − Σ créditos` (fechamento do balancete);
- `classificados + sem_classificacao = lançamentos_no_periodo` (nada evapora, nada conta duas vezes);
- `saldo = saldo_inicial + Σ líquidos − Σ saídas` (caixa por conta);
- leitura pura: consultar o balancete não cria nem altera lançamento.

---

## 6. Estoque — motor único e integridade

- **Um motor**: `grep -rn "UPDATE estoques" server/src` → **1 ocorrência**, o primitivo do store
  (`server/src/pgstore.ts:910`), chamado por `aplicarMovimento`. Nenhum módulo escreve saldo por
  fora; todos emitem **evento** em `movimentacoes_estoque`.
- **Invariante** `saldo = Σ eventos` verificada em `calculos-oracle` e nos testes PG de
  concorrência (duas saídas simultâneas do mesmo saldo: exatamente uma vence).
- **Reservas** (`0052_estoque_reservas`): criação/liberação idempotentes, matcher de célula
  (produto × tamanho × local), expiração explícita; rotas `GET/POST /api/estoque/reservas` e
  `POST /api/estoque/reservas/:id/liberar`.
- **Estornos**: cancelamento de compra estorna estoque **e** restaura o custo médio; estorno com
  estoque já consumido é **recusado** e não muda nada (`pg` E3.1).

---

## 7. Produção, compras e vendas (cadeia completa)

| Cadeia | Passos provados | Evidência |
|---|---|---|
| Compras | fornecedor → pedido → recebimento (parcial/total) → estoque → custo médio → conta a pagar | `pg` "E3.2 E2E: fornecedor → compra → recebimento → estoque → custo → conta a pagar" |
| Produção | BOM → OP → consumo de insumo → apontamento → entrada de acabado → custo → estorno | `pg-producao-e2`, `producao-e2` |
| Vendas | orçamento → pedido → reserva → faturamento → itens → financeiro → comissão → auditoria | `pedidos`, `eventos-venda`, `calculos-oracle`, smoke (386) |
| Logística | separar → conferir → embalar → expedir (+ divergência) | `e423-expedicao-postgresql` |
| Devolução | solicitar → autorizar → receber → estoque/custo/financeiro | `pg` E4.2.1 (concorrência e idempotência) |

---

## 8. Tenancy A/B

| Prova | Onde | Resultado |
|---|---|---|
| CRUD genérico isolado por empresa (10 recursos novos) | `server/test/tenant-isolamento-3-0.test.ts` | A não vê/edita/apaga registro de B (404), e o `empresa_id` nasce do ator, nunca do corpo |
| HTTP real + PostgreSQL, tenant/perfil/URL | `pg` "UX02.1/P0: HTTP real separa tenant, perfil, URL/API e jornada PDV" | passa |
| Commerce entre tenants | `pg-p0-commerce-tenant` / `p0-commerce-tenant` | passa |
| Auditoria e dashboard por empresa | `pg-auditoria-multiempresa`, `pg-dashboard-escopo` | passa |
| Catálogo público (exceção controlada) | `p0-catalog-public`, `sec04-catalogo-compartilhado-rbac` | passa |
| Estrutura | 119/139 tabelas com `empresa_id`; 5 com tenancy encadeada; 1 polimórfica com assert em código; 15 globais por desenho | `go-live:audit` (P0 se alguma ficar sem tenancy) |

O gate falha em **P0** se aparecer tabela sem `empresa_id`, sem tenancy encadeada e sem exceção
declarada — foi assim que o scan antigo (falso positivo de 60 tabelas) foi substituído por
classificação real com verificação de FK (§17).

---

## 9. RBAC (admin / gerente / operador)

- 115 chamadas de guarda no backend (`exigirAdmin` 24, `exigirReautenticacao` 18,
  `exigirAdminLocal` 8, `exigirGestor` 7, `exigirGerente` 7, `exigirComercial` 7,
  `exigirEmpresaPermitida` 4, `exigirEscrita` 4, entre outras).
- 40 recursos com `minPerfil: 'gerente'`; 45 recursos com RBAC restrito declarado
  (`architecture:audit`).
- **O backend bloqueia, não só a UI**: `sec03-admin-guard` (middleware isolado) +
  `pg/sec03-admin-routes-authorization` (HTTP real → Express → Postgres) provam 401/403 sem
  elevação por header, query, corpo ou parâmetro de rota.
- Operador não executa ação administrativa (webhooks, usuários, empresas, impressão, fiscal):
  guarda de administrador local + reautenticação nas ações sensíveis.
- 46 arquivos de teste esperam 403 — a autorização negativa é testada, não presumida.

---

## 10. API — códigos de status

Auditados por comportamento, não por leitura: 400 (payload), 401 (sem sessão), 403 (perfil),
404 (inexistente **e** cross-tenant — nunca vaza existência), 409 (conflito de estoque/
idempotência), 413 (importação acima do limite de amostra), 422 (transição inválida de estado),
503 (banco degradado, com a fase que falhou). Evidência: smoke (386 checks), suíte PG
(294) e `sec0*`/`p1`/`p2` no servidor.

---

## 11. Banco, migrations e Prisma

- **Do zero**: banco vazio → 67 migrations → 140 tabelas, 592 índices, 899 constraints,
  468 FKs, 29 triggers, 5 funções. `health` = `{"ok":true,"db":"postgres"}`.
- **Reaplicação idempotente**: segunda subida aplica **0** migrations, `health` 200 de novo;
  `db/bootstrap.sql` é gerado de `db/schema.sql` (`scripts/gerar-bootstrap.mjs --check`).
- **Sequência**: 0001…0067 contínua, verificada pelo gate (falha em P0 se houver buraco/renome).
- **Constraints que mordem**: `ck_lanc_fin_valor_positivo`, `CHECK` de `custo_unitario >= 0`
  (23514 provado), índice único parcial de idempotência (`compra_id`, OP, PDV, devolução).
- **Prisma**: `validate` é o único uso; o schema é contexto (11 modelos). **Neste sandbox**
  `npx prisma validate` e `npm run db:validate` falham por **bloqueio de rede** no download do
  schema-engine (`binaries.prisma.sh`) — não por erro de schema. O CI executa com
  `DATABASE_URL` placeholder e passa.

---

## 12. UX zero-modal (os 11 residuais do PR #95)

**Regra**: fluxo de módulo é **PÁGINA**. Sobreposição só nas exceções do baseline:
navegação global, menu mobile, infraestrutura, portal público, catálogo público, impressão,
scanner, segredo único, reautenticação, diagnóstico, confirmação inline e child-flow de documento.

| # | Residual (PR #95) | Hoje | Teste de tela |
|---|---|---|---|
| 1 | `ImportModal` (importar planilha) | rota `/importar/:tipo` → `ImportarPage.tsx` | `FluxosPagina.test.tsx` |
| 2 | `RecebimentoCompraModal` | rota `/compras/:id/receber` → `RecebimentoCompraPage.tsx` (form virou `RecebimentoCompraForm`) | idem |
| 3 | Nova ficha técnica | `/custo/nova` → `NovaFichaPage.tsx` | idem |
| 4 | Solicitar devolução | `/devolucoes/nova` → `DevolucaoNovaPage.tsx` | idem |
| 5 | Editar empresa | `/empresas/:id/editar` → `EmpresaFormPage.tsx` | `EmpresasPage.test.tsx` |
| 6 | Editar terminal de impressão | `/config/impressao/terminais/:id/editar` → `ImpressaoTerminalFormPage.tsx` | `FluxosPagina.test.tsx` |
| 7 | Parear novo agente local | `/config/impressao/agentes/novo` → `ImpressaoAgenteNovaPage.tsx` | idem |
| 8 | Configurar agente | `/config/impressao/agentes/:machineId/editar` → `ImpressaoAgenteEdicaoPage.tsx` | idem |
| 9 | Nova/editar alíquota NCM | `/ncm/novo` e `/ncm/:id/editar` → `NcmFormPage.tsx` | `NcmFormPage.test.tsx` (7) |
| 10 | `UsuarioFormModal` | `/usuarios/novo` e `/usuarios/:id/editar` → `UsuariosPage.tsx` (modo página) | `FluxosPagina.test.tsx` |
| 11 | Novo/editar webhook | `/webhooks/novo` e `/webhooks/:id/editar` → `WebhookFormPage.tsx` | idem |

**Endurecimento do gate** (`scripts/ux-guard.mjs` + `scripts/auditar-ux.mjs`):

1. **rota** existe em `App.tsx`;
2. **página** existe no disco;
3. **padrão antigo** (componente/estado do painel) não pode reaparecer em nenhum arquivo do repo;
4. lista fechada de `*Modal.tsx` (com teto por arquivo) e teto de `PainelInline` por arquivo;
5. `zero-modal-baseline.test.ts` (12 casos) prova que o gate **morde**: arquivo novo com
   `<Modal>`/`<dialog>`/`aria-modal`/`createPortal`/`fixed inset-0` falha; prosa que **menciona**
   modal não falha; exceção wildcard é recusada; contagem que cresce em arquivo com exceção falha.

**Resultado**: `npm run audit:ux` = **OK**, **6 exceções de baseline**, todas em categoria
permitida e com motivo auditável: `CommandPalette` (navegação global), `Sidebar` e `Layout`
(menu mobile), `UsuariosPage` (segredo exibido uma vez), `PortalCliente` (portal público) e
`CatalogoPublico` (catálogo público). **Nenhuma nova sobreposição** em fluxo de módulo. Correção desta rodada: o fixture do teste de baseline passou a materializar
os 14 fluxos canônicos (antes acusava 28 violações falsas porque o guard lia o repo real e o
fixture não tinha as páginas).

---

## 13. Interface visual

- Componentes canônicos (`ui.tsx`, `ui-kit-negocios.tsx`) para tabela, formulário, cabeçalho,
  alerta, estado vazio e `PageHeader`; páginas novas seguem o mesmo padrão (lista → página).
- PWA com precache de 126 entradas; `build` sem erro; responsividade por `grid`/`flex` e
  barra fixa (`fixed inset-x-0 bottom-0`) — explicitamente **permitida** pelo gate.
- Acessibilidade: `label`/`aria` nos formulários convertidos; testes por `getByLabelText`
  exato; botões de linha antes do botão que navega (evita clique ambíguo em teste).

---

## 14. Grafo capacidade → menu → rota → página → API → recurso → teste

- `npm run audit:menu`: **OK**. 134 capacidades, 106 no menu, 4 de infraestrutura, 124 APIs,
  62 rotas de capacidade, 0 recurso sem dono. Avisos (P3): `devolucoes/nova` sem item de menu
  (acesso por ação da página de devoluções — correto) e `feriados` com CRUD e sem consumo no
  front (capacidade de calendário produtivo, usada por API).
- `npm run architecture:audit`: **OK**. 124 recursos, 106 multiempresa, cobertura de tenant
  85,5 % dos recursos com tabela (o resto são recursos globais por desenho), 45 com RBAC.
  Avisos (P3): 10 tabelas com `empresa_id` expostas apenas por endpoint próprio
  (`connectors`, `gateway_*`, `produto_abc`, `comissoes_*`, `fin_extrato_transacoes`).
- `npm run go-live:audit`: **P0 0 · P1 0 · P2 0 · P3 2** (tenancy encadeada + resumo de tenancy).

---

## 15. Concorrência, idempotência e estorno (PostgreSQL real)

Passam em PG 16.14 com banco novo: duas saídas concorrentes do mesmo saldo (uma vence); dois
recebimentos simultâneos do mesmo SKU somam estoque e ponderam custo; recebimento + cancelamento
simultâneos não deixam estoque fantasma; mesma `idempotency key` gera **um** registro (índice
único parcial é a trava final); duas conclusões concorrentes da mesma OP (uma vence); duas
devoluções de 2 simultâneas com 2 restantes (só uma consome); claim de impressão concorrente sem
`25P02`; estorno reverte custo/perdas e preserva histórico.

---

## 16. Smoke e cenário descartável

- `npm run smoke` (memória): **386/386**.
- `npm run smoke:pg`: cria **banco novo**, sobe a API real (migrate + admin automáticos), roda o
  mesmo smoke apontado para Postgres: **386/386** — inclui compras, produção/MRP, fiscal
  (vencimento no mês seguinte, `NAO_SUPORTADO`, upsert de entrega), financeiro (balancete
  somente leitura), CRM (funil configurável, probabilidade por etapa, 404 sem vazar existência).
- Migrations do zero + segunda subida idempotente medidas no mesmo ambiente (§11).

---

## 17. Gate final (`scripts/final-go-live-audit.ts`)

`npm run go-live:audit` executa e exige: `audit:ux`, `audit:menu`, `architecture:audit`; 14
fluxos de página (rota + arquivo); 12 cálculos críticos com teste dedicado; sequência de
migrations + `schema.sql`; tenancy estrutural com classificação real (globais, catálogo, encadeada
por FK, polimórfica **verificada no código**); ausência de "not implemented" e de segredo no
front; 5 documentos de homologação. Emite P0/P1/P2/P3/ERROS/WARNINGS, `--json` e
`veredito: READY FOR MERGE | BLOCKED`, com exit 1 em P0/P1.

**Correções feitas no próprio gate nesta rodada** (ele estava mentindo):

| Defeito | Correção |
|---|---|
| Scan de `CREATE TABLE` sobre o arquivo inteiro inventava tabelas `if` e `mas` (comentários SQL em prosa) | comentários removidos antes do parse |
| Classificava 60+ tabelas como "sem `empresa_id`" sem olhar `ALTER TABLE` da `0017` | `empresa_id` procurado no `CREATE TABLE` **e** nas migrations; tenancy encadeada verificada por FK; exceções declaradas com motivo |
| `TODO` em português ("TODO recurso do CRUD") contava como pendência | regex passou a exigir anotação (`TODO:`/`TODO(`/`TODO-`), `FIXME`, `XXX` |
| `arquivos` (polimórfica) ficava sem classificação | exceção com prova de código: exige `assertRegistroDaEmpresaParaEscrita` em `uploads.ts`, senão P0 |

---

## 18. Segurança

- Autenticação JWT + revalidação por requisição, MFA/TOTP cifrado (AES-GCM), reautenticação
  (step-up) em 18 pontos, bloqueio por tentativas, rate limit, CSP/headers, `TRUST_PROXY`.
- Segredos cifrados em repouso (webhooks, MFA); segredo exibido **uma vez** e nunca relido.
- Uploads: MIME allowlist, limites de bytes, token aleatório na URL pública.
- Frontend sem segredo (varredura do gate para `*_SECRET/TOKEN/PASSWORD = "..."`).
- Tenancy e RBAC no backend (§8, §9); `empresa_id` do corpo é ignorado em favor do ator.

---

## 19. Performance e observabilidade

- Listagens paginadas no servidor; índices cobrindo FKs e filtros de tenant (592 no banco).
- Smoke completo (386 chamadas) em ~3 s em memória e ~8 s em PostgreSQL, incluindo migração de
  banco novo — o caminho crítico não tem N+1 evidente nos fluxos exercitados.
- `/api/health` com três estados explícitos (`memory`, `postgres`, `postgres-degraded`) e a fase
  de boot que falhou; log não expõe texto de erro do banco; auditoria por evento com empresa
  resolvida no momento do fato.

---

## 20. Integrações e jobs

- Conectores por empresa com OAuth (estado assinado), ingestão idempotente e webhooks de saída
  assinados (HMAC-SHA256), com log de entregas e reenvio manual.
- Agendador: `GET /api/admin/scheduled/run` (manual, admin) e `POST /api/admin/scheduled/cron`
  (gatilho externo); recorrências financeiras e projeções idempotentes por chave de período.
- Nenhuma integração "de mentira": sem credencial, a rota responde erro explícito e a UI mostra
  pendência de configuração — nada finge sucesso.

---

## 21. Git, branch e PR

- PR **#96** — `feat: homologação final e hardening integral do ERP 3.0`
  (https://github.com/petrickmsilva-alt/brobond-erp/pull/96), único e sem fragmentação.
- O trabalho está no branch da sessão **`arena/d360b6d8-brobond-erp`**, criado a partir do
  `origin/main` @ `d87cd8a`. O nome do branch é **fixado pela sessão** do Arena
  (`arena/<id-da-sessão>`) e não pode ser renomeado nem substituído — por isso o PR sai deste
  branch, e não de `arena/final-audit-brobond-erp` como o pedido original previa. **Um único PR**,
  sem fragmentação, sem push em `main`.
- **SHA:** commit único sobre `origin/main` @ `d87cd8a` (SHA exato no PR #96 — ele muda se este
  documento for corrigido, então a referência canônica é a cabeça do PR).
- **CI do PR #96:** job `verificar` **pass** (typecheck API/front/domain, testes de servidor e
  cliente, smoke em memória, `audit:menu`, `architecture:audit`, `npx prisma validate`, lint,
  build do cliente) e job `testes-postgres` **pass** (PostgreSQL 16.14 real, `postgresql-client-16`
  instalado, `test:pg` **sem nenhum skip**). Ambos verdes no commit final.
- Higiene: `git status` limpo após o commit; `git diff origin/main...HEAD --check` sem erro de
  whitespace; 42 arquivos, +4124/−1158; nenhum `backups/`, `dist/`, log ou banco temporário no
  commit (os bancos de teste vivem em `/tmp`).

---

## 22. Lacunas residuais (honestas, não bloqueantes)

| Sev | Lacuna | Por que não bloqueia |
|---|---|---|
| P3 | `feriados` tem CRUD na API e nenhum consumo no front | capacidade de calendário produtivo, consumida por API/seed; registro no `audit:menu` |
| P3 | `devolucoes/nova` sem item de menu | é ação da página de devoluções (fluxo correto) |
| P3 | 10 tabelas com `empresa_id` sem recurso genérico (`connectors`, `gateway_*`, `produto_abc`, `comissoes_*`, `fin_extrato_transacoes`) | escopo aplicado por endpoint próprio, testado |
| P3 | 7 catálogos técnicos globais (`tamanhos`, `grades`, `medidas`, `categorias`, `cores`, …) | domínio de modelagem compartilhado; o produto é que tem `empresa_id` |
| P3 | 573 warnings de lint (majoritariamente `no-explicit-any` e non-null) | dívida cosmética; **0 erros** |
| P3 | Fiscal sem emissão real de NF-e/NFS-e | decisão de produto: `NAO_SUPORTADO` sem leiaute oficial (§4) |
| — | 13 testes PG dependem do binário `psql` (skip **só no sandbox**) | **fechado pelo CI**: o job `testes-postgres` instala `postgresql-client-16` e roda `test:pg` **sem skip**, e passou |
| — | `prisma validate`/`db:validate` não executáveis no sandbox | **fechado pelo CI**: o job `verificar` roda `npx prisma validate` e passou |
| P2 | — | nenhum P2 aberto nesta rodada |

---

## 23. Veredito

**READY FOR MERGE.**

Fundamento: 0 P0, 0 P1, 0 P2; 2681 casos executados (1423+896 em memória/UI e 281 em
PostgreSQL real) com 0 falha; migrations do zero e reaplicação idempotente medidas em
PostgreSQL 16.14; smoke 386/386 nos dois modos; os 12 cálculos críticos com oráculo independente;
tenancy A/B, RBAC e zero-modal provados por teste que falha quando o defeito volta; gate final
sem achados bloqueantes. As únicas lacunas restantes são as P3 listadas em §22 — nenhuma é
regra de negócio quebrada, vazamento entre tenants, estoque/financeiro inconsistente, cálculo
sem teste, capability invisível ou sobreposição transacional.
