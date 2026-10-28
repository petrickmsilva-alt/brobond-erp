# BROBOND ERP — ARQUITETURA MASTER

> **ERP 3.0 (2026-10-27) — leia antes deste documento.** Este é um documento
> **histórico**: ele descreve a fase em que foi escrito. O estado REAL do
> código hoje está em [`docs/ERP-3.0-ARCHITECTURE-BASELINE.md`](ERP-3.0-ARCHITECTURE-BASELINE.md)
> (inventário lido do código por `npm run architecture:audit`) e os gaps
> abertos em [`docs/ERP-3.0-GAP-MATRIX.md`](ERP-3.0-GAP-MATRIX.md).
> Onde este arquivo afirmar algo que o baseline desmente — por exemplo
> "ERP single-company" — **vale o baseline**. Nada do conteúdo histórico foi
> apagado: o registro de como cada fase foi executada continua abaixo.

**Status:** documento oficial de arquitetura · **v1.0** · 2026-10-26
**Repositório:** `petrickmsilva-alt/brobond-erp`
**Branch desta fundação:** `arena/1bd3659f-brobond-erp`
**Baseline de código auditado:** `af6d2f4` (`main`, *merge: fornecedores no padrão lista pagina*)
**Documento irmão (mapa de domínios):** [`docs/ERP-DOMAIN-MAP.md`](ERP-DOMAIN-MAP.md)

> **Natureza desta fase.** Esta é a **FASE 1 — FUNDAÇÃO ARQUITETURAL**. Ela
> *não* cria módulo novo, *não* cria tabela, *não* cria CRUD, *não* altera
> módulo finalizado e *não* mexe em nenhuma regra comercial existente. Ela
> registra, com evidência de código, **o que o ERP é hoje**, **quais são os
> domínios**, **onde cada dado mora**, **como um módulo novo deve ser
> construído** e **qual é a expansão futura** de Representantes, Territórios,
> Metas e Comissões.
>
> **Regra deste documento:** nenhuma afirmação de estado sem evidência. Cada
> linha aponta o arquivo que comprova. O que não existe está marcado como
> **⏳ CONCEITUAL — NÃO CRIADO**, nunca como "pronto".

---

## 0. Sumário executivo

O BROBOND ERP é hoje um **ERP modular de cadeia completa** (cadastro → compra →
estoque → produção → venda → expedição → financeiro → comissão → fiscal → BI),
com aproximadamente **50 mil linhas de backend**, **101 tabelas** declaradas em
`db/schema.sql`, **88 recursos** contratados em `server/src/resources.ts` e
**70 módulos de menu** em `client/src/modules.ts`.

O que **existe** e está provado por teste: cadastros mestres, compras com
cotação e custo canônico de recebimento, produção com apontamentos/reabertura/
estorno, estoque canônico multiempresa, vendas com proposta/PDV/expedição/
devolução, financeiro com gateway/OFX/CNAB, fiscal (motor + provider
extensível), BI e a fundação de impressão.

O que **não existe** — e não foi inventado nesta fase: **Território** como
domínio, **Metas**, **Carteira de clientes temporal**, **hierarquia/equipe de
representante**, **plano/regra de comissão com prioridade**, **CRM
(leads/oportunidades)**, **unidades de negócio** e **produto × fornecedor
homologado**. Todos estão documentados como entidades conceituais, com contrato
proposto e fase de execução, para que a implementação futura não invente
estruturas paralelas.

**Decisão central desta fundação:** o ERP separa cinco camadas de dado —
**CADASTRO**, **PARÂMETRO**, **PROCESSO**, **MOVIMENTO** e **EVENTO/INDICADOR** —
e cada entidade tem **um único dono**. Nenhum módulo novo pode gravar no dono de
outro domínio; ele referencia, consulta ou registra evento.

---

## 1. Princípio arquitetural: cadastro ≠ processo ≠ movimento

Esta é a regra que orienta toda a evolução. Ela é a razão pela qual, no ERP
atual, `representantes.comissao_pct` **não** é a regra de comissão e
`clientes.representante_id` **não** é a carteira: são o **default** e o vínculo
**vigente**, respectivamente.

### 1.1 As cinco camadas

| Camada | Pergunta que responde | Ciclo de vida | Exemplos reais no ERP | Quem escreve |
|---|---|---|---|---|
| **1. Cadastro mestre** | "Quem/o que é?" | Longo; **desativa**, nunca apaga | `produtos`, `clientes`, `fornecedores`, `representantes`, `insumos`, `categorias`, `cores`, `colecoes`, `grades`, `tamanhos`, `locais`, `usuarios`, `empresas` | O módulo dono do cadastro |
| **2. Parâmetro / política** | "Qual é a regra ou o valor combinado?" | Vigência + prioridade | `politicas_comerciais`, `listas_preco` + `lista_preco_itens`, `regras_fiscais`, `impostos_ncm`, `empresa_fiscal_config`, `gateway_configs`, `configuracoes` | O domínio que governa a regra |
| **3. Processo / documento** | "O que foi negociado, pedido, produzido?" | Estados (rascunho → … → cancelado) | `propostas`, `vendas`, `compras`, `cotacoes_compra`, `ordens_fabricacao`, `devolucoes`, `inventarios`, `documentos_fiscais`, `envios`, `pdv_caixas` | Serviço de fluxo do domínio (não o CRUD genérico) |
| **4. Movimento** | "O que efetivamente mudou?" | Imutável / compensado por estorno | `movimentacoes`, `movimentacoes_insumos`, `estoques` (saldo), `lancamentos_financeiros`, `comissoes_eventos`, `ordens_apontamentos`, `fin_extrato_transacoes`, `transferencias_financeiras` | Serviço do domínio, dentro de transação |
| **5. Evento / trilha / indicador** | "O que aconteceu, quando e por quem?" / "Quanto deu?" | Append-only ou derivado | `auditoria`, `ordens_eventos`, `expedicao_eventos`, `proposta_eventos`, `catalogo_eventos`, `envio_eventos`, `documentos_fiscais_eventos`, `gateway_webhook_events`, `connector_events`, `produto_abc`, `/api/negocios/*` | Quem executou a ação; indicador é **derivado**, nunca digitado |

### 1.2 Consequências obrigatórias

1. **Um dono por dado.** `estoques` é do domínio Estoque. Vendas não gravam
   saldo: vendas **pedem** a baixa ao serviço de estoque
   (`server/src/estoqueCanonico.ts`, `server/src/estoque.ts`).
2. **Saldo não é fonte de verdade.** O saldo (`estoques.quantidade`) é a
   projeção transacional do movimento (`movimentacoes`), atualizada sob
   `UPDATE` condicional com guarda de não-negatividade
   (`CONSTRAINT estoques_quantidade_nao_negativo`, provado em
   `server/test/pg/e421-estoque-integridade.test.ts`). Recontagem se faz por
   inventário, não por edição manual de saldo.
3. **Preço e custo são congelados no documento.** O preço resolvido é gravado
   no item (`itens_venda.preco_unitario`), a comissão apurada é congelada em
   `vendas.comissao_pct`/`comissao_valor`. Mudar a lista de preço depois não
   reescreve o pedido.
4. **Histórico nunca se apaga.** Regra do projeto em
   [`docs/EXCLUSAO-E-VINCULOS.md`](EXCLUSAO-E-VINCULOS.md): *"cadastro se
   desativa; documento se cancela; histórico nunca se apaga"*.
5. **Indicador é derivado.** Nada de "campo de meta realizado editável" ou
   "faturamento do mês digitado". Realizado é consulta sobre processo/movimento
   (ver §10).
6. **Estado de fluxo não se altera por PUT.** Recursos de processo têm
   `ops: { create:false, update:false, delete:false }` e só mudam de estado por
   endpoint de fluxo com alçada (`checkFluxo`,
   `server/src/services.ts:220`). Exemplo comentado no próprio código: *"um PUT
   em `pdv_caixas` não pode fechar caixa, um PUT em `devolucoes` não pode
   autorizar"*.

### 1.3 Anti-exemplos (o que esta arquitetura proíbe)

| Proibido | Por quê | O correto |
|---|---|---|
| `representantes.clientes` (lista/JSON/texto) | destrói a troca de representante e o histórico | entidade `representante_cliente` com vigência (§12) |
| `representantes.comissao_pct` como motor de comissão | não expressa produto/cliente/faixa/prioridade | `plano_comissao` + `regra_comissao` com prioridade (§11) |
| `clientes.meta_valor` ou `representantes.meta` | meta é período + grão + alvo, não atributo | `representante_meta` / `meta_*` (§10) |
| `clientes.regiao VARCHAR` como território definitivo | não hierarquiza, não tem dono nem status | domínio `territorio` (§9) |
| `produtos.estoque` | duplica saldo e cria divergência | saldo em `estoques`; movimento em `movimentacoes` |
| `vendas.comissao` calculado de novo no recebimento | quebra o congelamento da apuração | apuração em `vendas.comissao_*`; efetivação em `comissoes_eventos` |
| tabela "genérica" (`entidade`, `campo`, `valor`) | perde integridade, FK, índice e RBAC | entidade própria por domínio |
| CASCADE indiscriminado | apaga histórico | `NO ACTION` por padrão; CASCADE só em linha-filha de composição |

---

## 2. Como o ERP é montado de fato

Importante: o projeto **não** é gerenciado por `prisma migrate dev`. O Prisma é
**dual-track e parcial por design** (11 modelos, cobrindo o motor de conectores
e âncoras). A fonte de verdade do banco é `db/schema.sql` + `db/migrations/`.

| Camada | Arquivo / artefato | Papel | Evidência |
|---|---|---|---|
| **Banco** | `db/schema.sql` (4.392 linhas, 101 `CREATE TABLE`) + `db/migrations/0001…0040` | Fonte de verdade do schema. O boot aplica sob `pg_advisory_lock` e registra em `schema_migrations`. `db/schema.sql` é o **consolidado**: toda tabela criada em migration também está nele. | `server/src/db.ts`; `comm` entre tabelas de migrations e `schema.sql` = vazio |
| **Prisma (parcial)** | `prisma/schema.prisma` | Somente `Usuario`, `Produto`, `Tamanho`, `Empresa`, `ImpostosNcm`, `ProdutoAbc` + motor de conectores (`Connector*`, `Sale*`) | `grep '^model ' prisma/schema.prisma` → 11 modelos |
| **Contrato de recurso** | `server/src/resources.ts` (3.837 linhas, 88 recursos) | **Fonte única** de: validação server-side, metadados de formulário/tabela, filtros, ordenação, RBAC declarado (`minPerfil`, `adminOnly`, `minPerfilEscrita`), escopo de empresa (`empresa: true`), rótulos, `ops` | exposto ao front por `GET /api/meta` |
| **Validação** | `server/src/validate.ts` (`validatePayload`) | Revalida **tudo** no servidor; o front nunca é autoridade | `server/src/validate.ts:168` |
| **Persistência** | `server/src/pgstore.ts` (Postgres) e `server/src/memdb.ts` (demonstração) | Duas implementações do **mesmo contrato** (`server/src/store.ts`) | sem `DATABASE_URL` o ERP sobe em modo demonstração |
| **Serviço de domínio** | `server/src/services.ts` + um arquivo por domínio (`vendas`→`itens.ts`, `financeiro.ts`, `producao.ts`, `compras.ts`, `estoque.ts`, `fiscal.ts`, `comissoes.ts`, `expedicao.ts`…) | Regra de negócio, transação, RBAC efetivo (`checkAccess`), escopo de empresa (`empresa.ts`) | `checkAccess` em `services.ts:174` |
| **Rotas HTTP** | `server/src/index.ts` | `app.use('/api', wrap(requireAuth))` na linha **457**: tudo registrado depois é autenticado. Antes disso só há público por intenção (auth, convite, portal, catálogo público, health) + routers de webhook | `index.ts:457`, `index.ts:1077` (404 final) |
| **Menu + rotas do front** | `client/src/modules.ts` (1.483 linhas, 70 módulos, 11 áreas) → `client/src/App.tsx` | **Fonte única** de navegação, breadcrumb, Command Palette, RBAC declarado na UI e `audit:menu` | `scripts/auditar-menu.ts` |
| **Diagnóstico de vínculos** | `server/src/dependencias.ts` (877 linhas) | Descobre quem depende de um cadastro, classifica o vínculo e devolve **409** com diagnóstico + orientação; renderizado **inline** em `DependenciasModal.tsx` (nome legado; o componente usa `PainelInline`, não sobreposição) | `montarDiagnostico`, `erroDependencias` |
| **Trilha de auditoria** | `auditoria` + `server/src/auditChain.ts` | Registro por ação/entidade/empresa + **cadeia de hashes verificável** (`/admin/auditoria/verificar`) | `hashCadeiaAuditoria`, `verificarCadeiaAuditoria` |
| **Conectores** | `modules/connectors/` (núcleo próprio: OAuth, cripto, sync, ingestão) | Integrações externas, fora do núcleo do ERP | `modules/connectors/README.md` |
| **Impressão** | `packages/domain/src/print` (PrintIR) + `print_*` + `print-agent/` | Fila persistente + agente local | migrations `0037`, `0038` |
| **Auditoria de arquitetura** | `scripts/auditar-menu.ts` (`npm run audit:menu`) | Verifica menu × rota × recurso × RBAC × multiempresa e falha o build em derivação | `docs/ERP-MASTER-MAP.md` §6.1 |

### 2.1 O caminho obrigatório de uma requisição

```
Front (react)                                   ── api.get('/api/<recurso>')
  → requireAuth (JWT; claim emp revalidada)     ── server/src/auth.ts
  → escopo de empresa (empresa_id do ator)      ── server/src/empresa.ts
  → checkAccess(resource, actor, op)            ── server/src/services.ts:174
  → validatePayload(resource, body)             ── server/src/validate.ts:168
  → store (pgstore | memdb)                     ── mesma interface
  → auditoria (quando a operação é de escrita)  ── auditChain
```

Nada é autorizado no front. A UI apenas **evita mostrar** o que receberia 403 —
e `npm run audit:menu` falha se o RBAC declarado no menu divergir do servidor.

---

## 3. Os 20 domínios do ERP

Legenda de estado: 🟢 **implementado e testado** · 🟡 **parcial** · 🟠 **depende de
serviço externo** · ⏳ **conceitual — não criado**.

O detalhamento por tabela, recurso, tela e teste está em
[`docs/ERP-DOMAIN-MAP.md`](ERP-DOMAIN-MAP.md). Aqui fica a **classificação
arquitetural** e o **dono do dado**.

| # | Domínio | Estado | Dono dos dados (tabelas) | Observação arquitetural |
|---|---|---|---|---|
| 1 | **Cadastros mestres** | 🟢 | `produtos`, `categorias`, `cores`, `colecoes`, `grades`, `grade_tamanhos`, `tamanhos`, `medidas`, `medida_valores`, `insumos`, `clientes`, `fornecedores`, `representantes`, `locais` | separado de processo; desativação em vez de exclusão |
| 2 | **Estrutura organizacional** | 🟡 | `empresas`, `usuarios`, `usuario_empresas`, `empresa_fiscal_config`, `configuracoes` | falta **unidade de negócio** (estabelecimento/filial comercial) como entidade; hoje `empresas` acumula o papel |
| 3 | **Comercial / Vendas** | 🟢 | `vendas`, `itens_venda`, `propostas`, `proposta_itens`, `proposta_eventos`, `pdv_caixas`, `pdv_pagamentos`, `pdv_caixa_movimentos`, `politicas_comerciais`, `listas_preco`, `lista_preco_itens`, `listas_preco_historico`, `catalogos`, `catalogo_compartilhamentos`, `catalogo_eventos` | pedido é processo; preço vem de política/lista e é congelado no item |
| 4 | **Compras** | 🟢 | `compras`, `itens_compra`, `cotacoes_compra`, `cotacao_compra_itens`, `cotacao_compra_fornecedores`, `cotacao_compra_precos`, `compra_recebimentos`, `compra_recebimento_itens`, `importacoes_nfe`, `produto_fornecedor_skus` | custo de recebimento canônico (`0028`); de-para de SKU do fornecedor |
| 5 | **Estoque** | 🟢 | `estoques`, `movimentacoes`, `locais`, `inventarios`, `itens_inventario`, `estoque_insumos`, `movimentacoes_insumos`, `divergencias_conferencia` | saldo multiempresa por local (`0030`, `0031`); vínculo canônico `movimentacoes.venda_id` / `ordem_id`. `transferencias_financeiras` é **tesouraria**, não estoque |
| 6 | **Produtos** | 🟢 | `produtos`, `produto_composicao`, `produto_fornecedor_skus`, `produto_abc`, `fichas_tecnicas`, `itens_ficha_tecnica` | produto é o **centro** do cadastro; ficha técnica é engenharia (Produção) |
| 7 | **Financeiro** | 🟢 | `lancamentos_financeiros`, `contas_financeiras`, `categorias_financeiras`, `centros_custo`, `recorrencias_financeiras`, `transferencias_financeiras`, `fin_extrato_transacoes`, `gateway_cobrancas`, `gateway_webhook_events`, `gateway_configs`, `investidores`, `aportes` | contas a pagar/receber são `lancamentos_financeiros` + `fin_status` da origem; gateway e conciliação (OFX/CNAB) |
| 8 | **Fiscal** | 🟠 | `documentos_fiscais`, `documentos_fiscais_eventos`, `inutilizacoes_fiscais`, `regras_fiscais`, `impostos_ncm`, `empresa_fiscal_config` | motor e operação prontos; transmissão real depende de credencial (Focus NFe / PlugNotas) |
| 9 | **Produção** | 🟢 | `ordens_fabricacao`, `itens_ordem`, `ordens_apontamentos`, `ordens_eventos`, `fichas_tecnicas`, `itens_ficha_tecnica`, `producao_recursos` (0054) | estados, perdas, custo real, reabertura e estorno (`0026`). O saldo/movimento de insumo é do **Estoque** (`estoque_insumos`, `movimentacoes_insumos`); a OP apenas os solicita |
| 10 | **CRM** | 🟢 | `crm_leads`, `crm_oportunidades`, `crm_atividades`, `crm_funis`, `crm_etapas`, `crm_origens`, `crm_campanhas`, `crm_oportunidade_estagio_historico` (0049/0050/0051/0057) | lead → oportunidade com **funil e etapas configuráveis por empresa** (`etapa_id` é a referência operacional; `etapa` textual é a chave, mantida para histórico/integrações), histórico de estágio transacional, agenda de atividades, score explicável, forecast e painel. O pós-venda (proposta, portal, catálogo) continua sendo **outro** processo |
| 11 | **Comissões** | 🟢 (apuração/efetivação) · ⏳ (motor de regras) | `vendas.comissao_pct`/`comissao_valor` (apuração), `comissoes_eventos` (livro de efetivação), `representantes.comissao_pct` (default) | efetiva no **recebimento**, pró-rata, com estorno e idempotência; regras com prioridade ainda ⏳ (§11) |
| 12 | **Metas** | ⏳ | — | nenhuma tabela. Modelo conceitual em §10 |
| 13 | **Territórios** | ⏳ | — | hoje só `representantes.regiao TEXT` e `clientes` com endereço. Modelo em §9 |
| 14 | **Relacionamento com clientes** | 🟡 | `portal_acessos`, `catalogo_compartilhamentos`, `catalogo_eventos`, `devolucoes`, `devolucao_itens`, `envios`, `envio_eventos` | portal + catálogo + pós-venda; falta histórico de interação e CRM |
| 15 | **Relacionamento com fornecedores** | 🟡 | `fornecedores`, `fornecedor_contatos`, `produto_fornecedor_skus`, `cotacoes_compra*`, `compras`, `compra_recebimentos` | contatos e de-para existem; homologação/documentos/indicadores de fornecedor ⏳ |
| 16 | **Relacionamento com representantes** | 🟡 | `representantes`, `representantes.usuario_id`, `vendas.representante_id`, `comissoes_eventos` | hierarquia, equipe, território, carteira, metas e indicadores ⏳ (§8) |
| 17 | **Relatórios / BI** | 🟢 | `sales`/`sale_items` (fato analítico), `produto_abc`, `vendas`/`itens_venda`, `impostos_ncm` | motor em `/api/negocios/*` e `/api/relatorios/*`; decisão de fonte única no [ADR-001](ADR-001-FONTE-UNICA-FATURAMENTO.md) |
| 18 | **Usuários / RBAC** | 🟢 | `usuarios`, `usuario_empresas`, `sessoes`, `login_tentativas` | 3 perfis (`admin`, `gerente`, `operador`) + permissões comerciais (`perm_*`) + `minPerfil`/`adminOnly`/`minPerfilEscrita` |
| 19 | **Auditoria** | 🟢 | `auditoria` | cadeia de hashes verificável + isolamento por empresa |
| 20 | **Integrações** | 🟠 | `connectors`, `connector_events`, `connector_oauth_states`, `sales`, `sale_items`, `webhooks`, `webhook_entregas`, `gateway_*`, `print_agents`, `print_jobs`, `print_terminals`, `print_pairing_codes`, `print_agent_nonces` | conectores reais; operação externa depende de credencial |

### 3.1 Fronteiras de domínio que já existem no código

- **Venda × Estoque:** venda faturada **pede** baixa; estoque é quem grava
  (`server/src/estoqueCanonico.ts`).
- **Venda × Financeiro:** faturamento gera contas a receber; baixa gera
  efetivação de comissão (`server/src/comissoes.ts` chamado a partir do
  recebimento).
- **Compra × Estoque × Financeiro:** recebimento grava estoque + custo + contas
  a pagar, em transação única (`server/src/custoRecebimento.ts`).
- **Produção × Estoque × Custo:** conclusão consome insumos, grava produção e
  calcula custo real; reabertura estorna por lançamento compensatório
  (`server/src/producao.ts`, provado em `pg-producao-e2`).
- **ERP × Commerce:** `sales`/`sale_items` é o **fato analítico** do BI e o que
  os conectores gravam; a ponte marketplace → venda operacional existe desde
  `0034`. Nada de segundo motor de vendas.

---

## 4. Regras transversais (valem para todo módulo, novo ou existente)

### 4.1 Multiempresa / tenant

| Regra | Como se cumpre | Evidência |
|---|---|---|
| Toda tabela de negócio tem `empresa_id` | `empresa_id INTEGER NOT NULL DEFAULT 1 REFERENCES empresas(id)` | **81 das 101 tabelas** declaram a coluna (42 já no `CREATE TABLE`, o resto por `ALTER TABLE ... ADD COLUMN empresa_id` das migrations `0017`, `0024`–`0040`) |
| Filha herda a empresa do pai | trigger `brobond_herdar_empresa()` | `db/schema.sql:1677` |
| Toda leitura é recortada | `aplicarFiltroEmpresa` / `escopoDoAtor` | `server/src/empresa.ts` |
| Empresa alheia responde **404**, não 403 | não revela existência | `assertRegistroDaEmpresa`, testes `pg-multiempresa`, `multiempresa*` |
| A empresa ativa vem do **token** (`emp`), não do corpo | revalidada por request | `server/src/auth.ts`, `CompanySwitcher.tsx` |
| Recurso declara `empresa: true` | `audit:menu` falha se a tabela não tem `empresa_id` ou se o recurso não filtra | `scripts/auditar-menu.ts` |

**Exceções declaradas (não são buracos):**

1. **Catálogo compartilhado global** — `categorias`, `cores`, `grades`,
   `grade_tamanhos`, `tamanhos`, `medidas`, `medida_valores`, `impostos_ncm`.
   Não têm `empresa_id` **por decisão** (SEC-04/P1-01): a nomenclatura vale para
   todas as empresas. A leitura é aberta aos perfis operacionais; a **escrita**
   exige `minPerfilEscrita: 'gerente'`, para que um operador de uma empresa não
   reescreva o catálogo das outras.
2. **Identidade / grupo** — `empresas`, `usuarios`, `usuario_empresas`,
   `empresa_fiscal_config`, `configuracoes`, `sessoes`, `login_tentativas`: a
   dimensão é o próprio grupo ou a identidade, não a empresa operacional.
   (`usuarios` e `usuario_empresas` têm `empresa_id`, mas **não** são filtrados
   por ele na leitura.)
3. **Filhas de documento já escopado** — `sale_items` herda o canal de `sales`;
   `webhooks`/`webhook_entregas`, `portal_acessos`,
   `catalogo_compartilhamentos`, `catalogo_eventos`, `cotacao_decisoes`,
   `arquivos` são acessórios de entidades que já carregam o tenant.

O `audit:menu` conhece e documenta essas exceções; qualquer **outra** tabela
sem `empresa_id` que passe a ser exposta por um recurso é tratada como defeito
(`EMPRESA_SEM_COLUNA` / `COLUNA_SEM_ESCOPO`).

### 4.2 RBAC

- Perfis com rank: `operador` < `gerente` < `admin`
  (`CHECK usuarios_perfil_valido`, `PERFIL_RANK`).
- Alçadas declaradas **no recurso**: `minPerfil` (leitura+escrita),
  `minPerfilEscrita` (só escrita, para catálogo compartilhado),
  `adminOnly` (exclusivo admin).
- Permissões comerciais por pessoa, com herança: `perm_catalogos`,
  `perm_compartilhar`, `perm_metricas`, `perm_politicas`, `perm_aprovar`,
  `perm_preco_tabela` (`herdar | permitir | negar`).
- Operador não exclui registro (regra fixa em `checkAccess`).
- **UI não é autoridade.** `audit:menu` compara o `minPerfil` declarado no menu
  com o exigido pelo servidor e falha em derivação.

### 4.3 Auditoria

- Toda escrita relevante registra `auditoria` (quem, empresa, quando, ação,
  recurso, registro, dados).
- Encadeamento por hash permite provar que a trilha não foi reescrita
  (`server/src/auditChain.ts`; `/admin/auditoria/verificar`).
- Estorno **também** gera evento e preserva o que reverteu (achado real do
  ciclo ERP-02: campos zerados na OP faziam o custo real "sumir" do registro).

### 4.4 Exclusão, desativação e 409

1. Cadastro **sem uso** → pode excluir.
2. Cadastro **em uso** → **409** com diagnóstico de dependências (módulo,
   contagem exata, até 20 ids, tipo de vínculo, motivo, orientação) e a UI
   oferece **Desativar**.
3. Documento com histórico → **cancelar/reabrir**, nunca DELETE.
4. FKs: **NO ACTION** por padrão. `CASCADE` só em linha-filha de composição
   (`itens_venda`→`vendas`, `itens_ficha_tecnica`→`fichas_tecnicas`).
5. A tentativa recusada roda em transação com rollback e **não** grava auditoria
   nova.

Referência: `server/src/dependencias.ts`, `docs/EXCLUSAO-E-VINCULOS.md`.

### 4.5 Migrations

- Numeração sequencial `NNNN_descricao.sql`; a última é **`0040_colecoes_ativo.sql`**.
- Proibido editar migration histórica. Correção = migration nova (disciplina já
  usada em `0031`, `0032`, `0034`, `0039`).
- Migration é **aditiva e idempotente**; sem DML destrutivo; sem backfill por
  heurística de texto.
- O schema consolidado (`db/schema.sql`) deve receber o mesmo DDL — o boot aplica
  schema + migrations e o gate `prod-db-01-schema-sync` compara os dois.
- Constraint que pode falhar em base legada entra `NOT VALID` **e** é validada
  depois, com inventário (lição do `0035`).

### 4.6 Contrato, validação e performance

- Todo campo de UI vem do **recurso** (`resources.ts`); a UI não inventa campo.
- `validatePayload` revalida tipo, obrigatório, tamanho, domínio, FK e empresa.
- Paginação, busca e ordenação são **server-side**.
- Proibido N+1: contagem de uso é agregada em uma consulta por página
  (`Store.countByColumn`, p.ex. `representantes.uso`).
- Índices: os compostos quentes são `(empresa_id, filtro)` — p.ex.
  `vendas_empresa_status_idx`, `estoques_empresa_produto_idx`,
  `auditoria_empresa_data_idx`.
- TypeScript `strict`; sem `any` novo (o baseline tem 518 avisos de
  `no-explicit-any` como dívida registrada, **0 erros**).

### 4.7 Testes e gates

| Gate | Comando | Critério |
|---|---|---|
| Tipos | `npm run typecheck` | 0 erros (domain + server + client) |
| Lint | `npm run lint` | 0 **erros** (avisos são dívida declarada) |
| Testes | `npm test` | 0 falhas |
| PostgreSQL | `npm run test:pg` | exige `DATABASE_URL`; **sem banco = SKIP declarado, nunca PASS** |
| Build | `npm run build` | bundle do front |
| Menu/arquitetura | `npm run audit:menu` | 0 erros |
| Smoke | `npm run smoke` | HTTP ponta a ponta |
| Schema | `npm run db:validate` | Prisma válido |

Todo módulo novo entra com teste em **memória** e, quando toca saldo, dinheiro,
estado de fluxo ou tenant, também em **PostgreSQL real**.

---

## 5. Blueprint: como se constrói um módulo novo

Ordem obrigatória. Inverter a ordem é o que produz estruturas isoladas.

```
1. DOMÍNIO      → este documento + ERP-DOMAIN-MAP.md: qual domínio, qual dono,
                  qual entidade, qual processo, qual indicador.
2. ADR          → se a decisão cruza domínios (fonte de verdade, prioridade de
                  regra, unidade de negócio), registrar antes do código.
3. MIGRATION    → NNNN_descricao.sql aditiva + espelho em db/schema.sql.
                  empresa_id, FKs explícitas, índices, unicidade por empresa,
                  CHECK de domínio, atualizado_em.
4. RECURSO      → resources.ts: campos, labels, seções, tipo, required,
                  search/list, filterFields, quickFilters, orderBy, ops, RBAC,
                  empresa, notice, uso (contagem agregada).
5. SERVIÇO      → regra de negócio + transação + guards de estado + auditoria.
                  Fluxo NUNCA via PUT genérico.
6. TESTES       → memória (regra) + PG (saldo/dinheiro/tenant/concorrência) +
                  front (lista→página, RBAC, estados de erro).
7. TELA         → LISTA → PÁGINA (padrão §5.1). Nunca modal/drawer gigante.
8. MENU         → modules.ts (área, grupo, subgrupo, path, resource, keywords)
                  + rota em App.tsx + guard de módulo. Rodar `audit:menu`.
9. DOCS         → atualizar ERP-DOMAIN-MAP.md (entidades/relações) e, se mudou
                  decisão estrutural, este documento + ADR.
```

**Definição de pronto arquitetural:** todos os 9 passos + `typecheck`, `lint`,
`test`, `build`, `audit:menu` verdes + entrada no mapa de domínios. Sem isso, o
módulo **não** entra em `MODULES` como ativo — no máximo como `planned`
(renderiza `PlannedModule`, sem API e sem promessa).

### 5.1 Padrão de interface obrigatório: LISTA → PÁGINA

Referência normativa: [`docs/PADRAO-CADASTROS-AUXILIARES.md`](PADRAO-CADASTROS-AUXILIARES.md),
implementada em Coleções, Tamanhos, Fornecedores, Representantes, Cores,
Categorias, Grades, Produtos, Clientes.

- A tela principal é a **lista** (busca server-side, filtro de status,
  paginação, coluna de uso, ações).
- Criar/editar são **páginas próprias** (`/recurso/novo`, `/recurso/:id/editar`)
  registradas em `FORM_DIRETO` (`client/src/modules.ts:1309`).
- Proibido: modal gigante, drawer, sheet, overlay, portal, formulário inteiro em
  modal.
- Erro por campo + resumo acessível; servidor é a autoridade final.

---

## 6. Fluxos canônicos do ERP

Cada seta indica **quem grava** o dado daquele passo. Nenhum passo escreve no
domínio do outro.

### 6.1 VENDA

```
Cliente ──► Proposta ──► Pedido de venda ──► Separação ──► Expedição
            propostas   vendas/itens_venda    expedicao_eventos   envios
                                   │
                                   ├─► Faturamento/NF ──► documentos_fiscais
                                   │        │
                                   │        └─► Estoque (saída)  ──► movimentacoes
                                   │        └─► Financeiro (AR)  ──► lancamentos_financeiros
                                   │        └─► Comissão (APURAÇÃO congelada)
                                   │                              vendas.comissao_valor
                                   ▼
                        Recebimento (baixa/conciliação)
                                   │
                                   ├─► Financeiro ──► fin_extrato_transacoes
                                   └─► Comissão (EFETIVAÇÃO pró-rata) ──► comissoes_eventos
                                              │
                                              └─► Indicadores ──► /api/negocios/*
```

Variantes reais: **PDV** (balcão, `pdv.ts`, baixa e pagamento imediatos),
**portal** (`portal.ts`), **catálogo público** (`catalogos.ts`), **marketplace**
(`0034`, ponte para `vendas`). Devolução (`devolucoes` + `estoqueCanonico` +
financeiro) recompõe estoque e estorna; comissão sofre **estorno único**.

### 6.2 COMPRA

```
Necessidade ──► Solicitação/Sugestão ──► Cotação ──► Pedido de compra
                sugestao-compra        cotacoes_compra   compras/itens_compra
                                                              │
                                                              ▼
                                    Recebimento ──► Estoque (entrada + custo canônico)
                                    compra_recebimentos   movimentacoes + produtos.custo
                                                              │
                                                              ├─► NF de compra ──► importacoes_nfe
                                                              └─► Contas a pagar ──► lancamentos_financeiros
```

### 6.3 PRODUÇÃO

```
Produto ──► Ficha técnica ──► Ordem de produção ──► Consumo de insumos
            fichas_tecnicas    ordens_fabricacao     movimentacoes_insumos
                    │                 │
                    │                 ├─► Apontamentos ──► ordens_apontamentos
                    │                 ├─► Produção ──► movimentacoes (entrada)
                    │                 └─► Custo real ──► ordens_fabricacao.custo_real
                    └─► Engenharia (mão de obra, indiretos, margem)
```

Reabertura/cancelamento estornam por lançamento compensatório e registram em
`ordens_eventos` o que foi revertido.

### 6.4 ESTOQUE

```
Entrada (compra/produção/devolução) ──► Saldo (estoques) ──► Transferência
        movimentacoes                       quantidade       movimentacoes
                                                                 │
                  Inventário ◄──────────────────────────────────┘
                  inventarios/itens_inventario ──► ajuste
                                                                 │
                                                          Auditoria
```

Saldo nunca é digitado: é consequência de movimento; correção é inventário.

---

## 7. Status dos módulos

### 7.1 FINALIZADOS (não reabrir nesta fase)

| Módulo | Executor | Estado | Evidência-chave |
|---|---|---|---|
| **Grades** | Arena | ✅ finalizado | `server/test/grades-cadastro.test.ts`, `pg/grades-pg.test.ts`, `client/src/pages/GradesPage.test.tsx`, `GradesRoute.test.tsx` |
| **Coleções** | OpenHands | ✅ finalizado | `migration 0040` (ativo), `server/test/colecoes-listagem.test.ts`, `pg/colecoes-postgresql.test.ts`, `ColecoesPage/FormPage/Route` tests |
| **Tamanhos** | OpenHands | ✅ finalizado | `server/test/tamanhos-cadastro.test.ts`, `TamanhosPage/Route` tests, `minPerfilEscrita: 'gerente'` |
| **Fornecedores** | Arena | ✅ finalizado | `server/test/fornecedores-cadastro.test.ts`, `pg/fornecedores-pg.test.ts`, `FornecedoresPage/FormPage/Route` tests |
| **Representantes** | Arena | ✅ finalizado | `server/test/representantes-cadastro.test.ts`, `pg/representantes-pg.test.ts`, `RepresentantesPage/FormPage/Route` tests, `uso` agregado, CPF único por empresa |

### 7.2 NÃO EXECUTAR AGORA

- **Insumos** — explicitamente fora de escopo desta fase (existe cadastro e é
  funcional; não será reaberto nem expandido aqui).

### 7.3 Inventário de navegação atual (70 módulos, 11 áreas)

`Meu Negócio` (2) · `Cadastros` (11) · `Vendas` (11) · `Estoque & Suprimentos`
(10) · `Produção` (4) · `Financeiro` (10) · `Fiscal` (4) · `Administração` (4) ·
`Commerce` (8) · `Creators` (4) · `Utilidades Globais` (2) = **70**.

Entre os que estavam em gap em auditorias anteriores e **hoje existem**:
`/comissoes` (Financeiro › Comissões) e `/empresas` (Administração). Módulos
`planned` (apenas Commerce multicanal e Creators) renderizam `PlannedModule` e
**não** têm API nem tabela — nada de tela fictícia.

---

## 8. REPRESENTANTES — arquitetura de expansão futura

> **O cadastro atual está FINALIZADO e NÃO será alterado por esta arquitetura.**
> O que segue é o desenho de evolução. Nenhuma destas tabelas é criada agora.

### 8.1 O que existe hoje (contrato real)

`representantes`: `id`, `empresa_id`, `nome`, `cpf` (único por empresa via
`uq_representantes_cpf_empresa`), `cargo`, `regiao`, `comissao_pct` (default),
`usuario_id` (único por empresa via `uq_representantes_usuario_empresa`),
`telefone`, `whatsapp`, `email`, `admissao`, `desligamento`, `ativo`,
`observacoes`, auditoria. Vínculos de saída: `vendas.representante_id`,
`clientes.representante_id`, `propostas.representante_id`,
`comissoes_eventos.representante_id`.

Decisões já corretas e que a expansão **deve respeitar**:

- `representante.regiao` é **texto livre legado**, não território.
- `representante.comissao_pct` é **default**, não a regra.
- `usuario_id` é o vínculo de acesso (opcional e único) — a identidade do ERP é
  `usuarios`, não o representante.
- Desligar/desativar **não apaga** histórico.

### 8.2 Modelo-alvo (conceitual)

```
REPRESENTANTE (cadastro — finalizado)
│
├── usuario_id ........................ já existe
├── hierarquia ......... representante_hierarquia   ⏳
├── equipe ............. representante_equipe       ⏳
├── território ......... representante_territorio   ⏳
├── carteira ........... representante_cliente      ⏳
├── metas .............. representante_meta         ⏳
├── regras de comissão . plano_comissao / regra_comissao ⏳
├── participação ....... participacao_venda         ⏳ (quando houver divisão de venda)
├── histórico .......... comissoes_eventos          🟢 (livro atual)
└── indicadores ........ derivados (sem tabela)
```

### 8.3 Contratos conceituais (NÃO CRIADOS)

| Entidade | Propósito | Colunas-chave propostas | Regras |
|---|---|---|---|
| `representante_hierarquia` | supervisor → subordinado (N níveis) | `empresa_id`, `supervisor_id`, `subordinado_id`, `nivel`, `vigencia_inicio`, `vigencia_fim` | única por par na vigência; não pode ser o próprio; ciclo proibido |
| `representante_equipe` | equipe comercial (Sales Team) | `empresa_id`, `nome`, `lider_id`, `ativo` | líder é representante ativo |
| `representante_equipe_membro` | composição com participação | `equipe_id`, `representante_id`, `papel`, `participacao_pct`, `vigencia_*` | soma de participação ≤ 100 por equipe quando rateio ativo |
| `representante_territorio` | alocação em território | `empresa_id`, `representante_id`, `territorio_id`, `papel`, `vigencia_*` | histórico preservado |
| `representante_cliente` | **carteira temporal** | `empresa_id`, `representante_id`, `cliente_id`, `inicio`, `fim`, `prioridade`, `territorio_id`, `participacao_pct`, `status` | sobreposição de carteira = erro de negócio explícito; troca fecha `fim`, nunca apaga |
| `representante_meta` | meta por período e grão | ver §10 | realizado **derivado** |
| `plano_comissao` | política (conjunto de regras) | `empresa_id`, `nome`, `vigencia_*`, `status`, `aplicar_sobre` (`faturamento`/`recebimento`/`margem`) | um plano ativo por contexto/vigência |
| `regra_comissao` | regra com escopo e prioridade | `plano_id`, `escopo` (`item`/`produto`/`categoria`/`colecao`/`cliente`/`representante`/`pedido`), `escopo_id`, `tipo_valor` (`percentual`/`fixo`/`por_margem`/`faixa`), `valor`, `base` (`bruto`/`liquido`/`margem`), `prioridade`, `vigencia_*` | maior prioridade vence; empate = erro de configuração (nunca "o último que rodou") |
| `comissao_lancamento` | lançamento do motor novo | `empresa_id`, `regra_id`, `venda_id`, `item_id`, `base`, `pct_ou_valor`, `valor`, `tipo` (`apurada`/`realizada`/`estornada`), `status` | append-only; estorno é linha nova, nunca update |

> **Relação com o que existe:** `comissoes_eventos` continua sendo o **livro de
> efetivação** do fluxo atual. A evolução **não** o substitui de imediato: o
> motor de regras passa a *calcular* a apuração congelada em `vendas.comissao_*`
> (mesmo contrato), e a efetivação continua no livro. Migração aditiva, com
> paridade provada por teste antes de qualquer troca.

### 8.4 Ordem de execução recomendada

1. **Território** (§9) — porque carteira e meta se apoiam nele.
2. **Carteira** (`representante_cliente`) — destrava relatório por carteira e
   troca de representante sem perda de histórico.
3. **Metas** (§10) — depende de território + carteira para o grão "realizado".
4. **Plano/regra de comissão** (§11) — por último: é o de maior risco financeiro
   e exige paridade com o cálculo atual.
5. **Hierarquia/equipe** — paralelo; necessário para meta e comissão de equipe.

---

## 9. TERRITÓRIO — domínio próprio (conceitual)

**Estado:** ⏳ **não existe**. Não há tabela, recurso, tela nem teste. Hoje só
existe `representantes.regiao TEXT` (busca textual) e endereço do cliente.
**Não substituir** `regiao` agora: a coluna é usada por busca e por cadastro
finalizado.

### 9.1 Modelo conceitual

```
TERRITÓRIO
├── empresa_id
├── territorio_pai_id  (auto-relação; NULL = raiz)
├── nivel              (inteiro ou derivado da profundidade)
├── codigo             (único por empresa)
├── nome
├── tipo               (pais | estado | regiao | cidade | zona | canal | cliente | custom)
├── geografia          (opcional: uf, municipio_ibge, poligono)
├── responsavel_id     (representante ou equipe; opcional)
├── status             (ativo | inativo)
├── criado_em, atualizado_em, criado_por
└── auditoria
```

- Hierarquia **livre** (auto-FK), não uma árvore fixa de 6 níveis.
- `tipo` permite território **não geográfico** (canal, segmento, carteira
  estratégica) — requisito explícito.
- Índices: `(empresa_id, territorio_pai_id)`, único `(empresa_id, codigo)`.
- Exclusão: 409 se houver filho, carteira, meta ou venda vinculada; senão
  desativar.
- Migração de `regiao`: futura e opcional — `regiao` permanece como texto; um
  de-para pode preencher `representante_territorio`, sem apagar o texto.

### 9.2 Entidades dependentes (na ordem)

`territorio` → `representante_territorio` → `representante_cliente.territorio_id`
→ `representante_meta.territorio_id` → indicadores por território.

---

## 10. METAS — domínio próprio (conceitual)

**Estado:** ⏳ **não existe** tabela, recurso ou tela.

### 10.1 Modelo conceitual

```
META
├── empresa_id
├── periodo_inicio, periodo_fim   (ou ano + mes/trimestre com CHECK de coerência)
├── granularidade                 (mensal | trimestral | anual)
├── alvo_tipo                     (representante | equipe | territorio | empresa)
├── alvo_id                       (FK conforme alvo_tipo)
├── metrica                       (faturamento | quantidade | margem | comissao | recebimento)
├── recorte                       (produto | categoria | colecao | grade | todos)
├── recorte_id
├── valor_meta                    (numeric)
├── quantidade_meta               (numeric, quando metrica = quantidade)
├── status                        (rascunho | ativa | encerrada | cancelada)
└── auditoria
```

`realizado` e `percentual_atingimento` **não são colunas digitáveis**: são
calculados a partir de `vendas`/`itens_venda` (operacional) e/ou `sales`
(analítico), respeitando o [ADR-001](ADR-001-FONTE-UNICA-FATURAMENTO.md). Se um
snapshot for necessário para fechamento, ele é gerado por job e marcado como
snapshot — nunca editado à mão.

### 10.2 Regras

- Unicidade: um alvo não tem duas metas ativas com o mesmo `metrica`+`recorte`+
  período sobreposto.
- Meta é **planejamento**, não cadastro do representante: nada de coluna em
  `representantes`.
- Exclusão: meta com realizado > 0 é **encerrada/cancelada**, não apagada.
- Grãos futuros suportados pela mesma tabela: mês/trimestre/ano, por
  faturamento/quantidade, por produto/coleção/categoria, por
  território/equipe/representante.

---

## 11. COMISSÕES — apuração, efetivação e motor de regras

### 11.1 O que existe (🟢, provado)

```
FATURAMENTO  → apura e CONGELA     vendas.comissao_pct / comissao_valor
                                   (base = total da venda ou regra vigente)
RECEBIMENTO  → efetiva PRÓ-RATA     comissoes_eventos (tipo='realizada')
CANCELAMENTO → estorna UMA vez      comissoes_eventos (tipo='estornada')
```

Regras já implementadas em `server/src/comissoes.ts`:

- Só efetiva sobre **fatura liquidada** (baixa, conciliação ou pagamento no
  balcão) — nunca pela criação do pedido.
- Recebimento parcial efetiva a fração correspondente; quitação efetiva o saldo.
- Nunca efetiva além da apuração congelada (`saldo = apurado − efetivado`).
- Idempotente: o mesmo recebimento não efetiva duas vezes; estorno é único.
- Provas: `server/test/financeiro-p2.test.ts`,
  `server/test/pg/comissoes-e2e.test.ts`, `comissoes-periodo.test.ts`.
- Tela: `/comissoes` (`client/src/pages/ComissoesPage.tsx`) consome
  `/financeiro/comissoes`, `/financeiro/comissoes/venda/:id`,
  `/relatorios/comissoes`.

### 11.2 O que falta (⏳): motor de regras com prioridade

Ordem de resolução proposta — **do mais específico para o mais genérico**:

```
ITEM (venda/item)
  ↓ se não houver regra de item
PRODUTO (ou categoria / coleção / grade)
  ↓
PEDIDO (canal, condição, campanha)
  ↓
CLIENTE (segmento, contrato)
  ↓
REPRESENTANTE (default do cadastro = representantes.comissao_pct)
```

- "Regra específica sobrescreve a geral" — nunca soma silenciosa.
- Suporta: percentual, valor fixo, por margem, por produto/cliente/categoria,
  por período, por meta, comissão direta e indireta, estorno, gatilho
  (`apos_faturamento` | `apos_recebimento`).
- `regra_comissao.prioridade` explícita + vigência; empate é **erro de
  configuração**, não "o último vence".
- O cálculo continua **congelando na apuração** e **efetivando no recebimento**
  — o motor novo só muda *como* a apuração é calculada.

### 11.3 Contrato de compatibilidade (obrigatório na execução futura)

1. `representantes.comissao_pct` continua válido como *default*.
2. `vendas.comissao_pct`/`comissao_valor` continuam sendo o congelamento.
3. `comissoes_eventos` continua sendo o livro de efetivação.
4. Paridade obrigatória: com um único plano/regra equivalente ao default, o
   resultado tem de ser **idêntico** ao atual — provado por teste PG antes de
   qualquer migração de cálculo.

---

## 12. CLIENTES E CARTEIRA

**Hoje:** `clientes.representante_id` (FK direta) indica o representante
**vigente**. Não é histórico: ao trocar, o vínculo anterior se perde.

**Alvo (⏳):** `representante_cliente` com `inicio`, `fim`, `prioridade`,
`territorio_id`, `status` e `participacao_pct`.

Regras:

- Trocar representante **fecha a vigência**; nunca sobrescreve nem apaga.
- Venda guarda `representante_id` **no documento** (já é assim) — o histórico da
  venda não depende da carteira atual.
- `clientes.representante_id` permanece como "vigente" para conveniência de
  telas e filtros, podendo ser derivado/validado contra a carteira na execução.
- Sobreposição de dois representantes ativos para o mesmo cliente é **erro de
  negócio** (a menos que `participacao_pct` esteja configurado e somando ≤ 100).

---

## 13. PRODUTOS — o centro do cadastro (e o que NÃO duplicar)

```
Produto
├── Categoria           categorias         🟢
├── Coleção             colecoes           🟢
├── Grade / Tamanho     grades/tamanhos    🟢
├── Cor                 cores              🟢
├── SKU / código barras produtos           🟢 (SKU único por empresa)
├── NCM / CEST / CFOP   produtos + impostos_ncm + regras_fiscais 🟢
├── Fornecedor          produto_fornecedor_skus (de-para)        🟢
├── Insumos / Ficha     fichas_tecnicas/itens_ficha_tecnica      🟢
├── Preços              listas_preco + itens_venda (congelado)   🟢
├── Estoque             estoques/movimentacoes                   🟢
├── Custos              produtos.custo + custo de recebimento    🟢
├── Compras             itens_compra                             🟢
├── Vendas              itens_venda                              🟢
└── Fiscal              regras_fiscais/documentos_fiscais        🟢
```

**Não duplicar:** preço não mora no produto (mora em lista/política e é
congelado no item); estoque não mora no produto (mora em `estoques`); custo
unitário é referência (`produtos.custo`), mas o custo **do recebimento** é
calculado e registrado no recebimento; ficha técnica é de Produção.

---

## 14. FORNECEDORES — finalizado, com expansão documentada

> Módulo **FINALIZADO** (Arena). **Não reabrir nesta fase.**

Existe: `fornecedores` (cadastro, `empresa_id`, `ativo`), `fornecedor_contatos`,
`produto_fornecedor_skus` (de-para com código/preço/embalagem do fornecedor),
`cotacoes_compra*`, `compras`, `compra_recebimentos`, `importacoes_nfe`.

Expansão futura (⏳), sem tocar no cadastro atual:

```
Fornecedor
├── cadastro ................ 🟢
├── contatos ................ 🟢 fornecedor_contatos
├── dados fiscais ........... 🟢 (campos fiscais no cadastro)
├── condições comerciais .... ⏳ fornecedor_condicao_comercial
├── contas bancárias ........ ⏳ fornecedor_conta_bancaria
├── produtos fornecidos ..... 🟡 produto_fornecedor_skus (associação; falta homologação)
├── homologação ............. ⏳ fornecedor_homologacao (status, validade, anexo)
├── documentos .............. ⏳ fornecedor_documento
├── pedidos ................. 🟢 compras
├── recebimentos ............ 🟢 compra_recebimentos
├── histórico de compras .... 🟢 derivado
└── indicadores ............. ⏳ derivado (prazo, ruptura, preço)
```

Regra: **Produto × Fornecedor é relação própria** — nunca colunas de fornecedor
dentro de `produtos`.

---

## 15. Padrões proibidos (contrato negativo)

1. Tabela genérica de atributos por domínio (`entidade`/`campo`/`valor`).
2. Coluna de lista (`clientes_ids`, JSON de vínculos) em cadastro.
3. CASCADE fora de linha-filha de composição.
4. Editar migration histórica ou reescrever `db/schema.sql` "na mão" sem espelhar
   a migration.
5. Alterar estado de fluxo por `PUT` do CRUD genérico.
6. Calcular dinheiro no front ou confiar em total enviado pelo cliente.
7. `find`/consulta por linha em listagem (N+1).
8. Ler ou gravar sem recorte de `empresa_id`.
9. Esconder erro de banco cru em endpoint público (nome de constraint/tabela).
10. Módulo novo sem teste, sem entrada em `MODULES` coerente, ou como `planned`
    "para depois" sem registro em roadmap.
11. Documentar como pronto o que não foi executado (este documento é o padrão de
    evidência).
12. Criar tabela "só para parecer completo" — entidade sem uso real é dívida, não
    arquitetura.

---

## 16. Roadmap arquitetural

Alinhado (sem substituir) ao [`docs/ERP-CORE-ROADMAP.md`](ERP-CORE-ROADMAP.md),
que mantém ERP-09…ERP-13. Este roadmap trata da **evolução estrutural** dos
domínios comerciais.

| Fase | Entrega | Depende de | Gate de aceite |
|---|---|---|---|
| **MA-01** | Esta fundação (documentos, mapa, governança) | — | docs revisados; `typecheck`/`lint`/`test`/`build`/`audit:menu` verdes |
| **MA-02** | `territorio` (domínio + CRUD LISTA→PÁGINA) | MA-01 | migration + recurso + tela + testes memória/PG + RBAC + 409 |
| **MA-03** | `representante_territorio` e `representante_cliente` (carteira temporal) | MA-02 | vigência, sobreposição, troca sem perda de histórico |
| **MA-04** | Metas (`representante_meta`/alvos) + realizado derivado + tela de acompanhamento | MA-03 | realizado = consulta; snapshot só por job; sem coluna editável |
| **MA-05** | Plano/regra de comissão com prioridade + paridade com o cálculo atual | MA-04 | paridade PG com regra única = comportamento atual; estorno idempotente |
| **MA-06** | Hierarquia e equipe comercial + participação | MA-03 | ciclo proibido; soma de participação validada |
| **MA-07** | CRM mínimo (lead/oportunidade/interação) mantendo proposta/pedido como processo | MA-03 | lead não é cliente; conversão registrada, sem duplicar cadastro |
| **MA-08** | Unidade de negócio / estabelecimento | MA-01 | não conflita com `empresas`; isolamento preservado |
| **MA-09** | Relacionamento com fornecedores (homologação, condições, indicadores) | MA-01 | sem tocar no cadastro finalizado |
| **MA-10** | Indicadores comerciais por representante/território/equipe | MA-02…MA-06 | derivado de `vendas`/`sales`; sem N+1 |

**Ordem é arquitetural, não de conveniência:** território → carteira → meta →
comissão. Comissão por último porque é a de maior risco financeiro e a única que
pode alterar dinheiro já apurado.

---

### 16.1 Status da evolução Master entregue (numeração da entrega)

A tabela acima é o **roadmap conceitual** (numeração própria). A entrega executada
usou a numeração do mandato e está detalhada, com evidências, em
[`ERP-FUNDACAO-COMERCIAL.md`](./ERP-FUNDACAO-COMERCIAL.md):

| Fase | Entrega | Situação |
| --- | --- | --- |
| MA-02 | Territórios (hierarquia, tipos geográficos e não geográficos, nível derivado) | IMPLEMENTADA |
| MA-03 | Carteira temporal `representante_cliente` (vigência, takeover 100%, 409) | IMPLEMENTADA |
| MA-04 | Metas com realizado derivado + acompanhamento | IMPLEMENTADA |
| MA-05 | Motor de comissão (plano, regra, apuração, evento, fallback legado) | IMPLEMENTADA |
| MA-06 | Equipes, membros e hierarquia (anti-ciclo) | IMPLEMENTADA |
| MA-07 | Atribuição comercial da venda (participação % ≠ comissão) | IMPLEMENTADA |
| MA-08 | Indicadores derivados (representante, território, equipe) | IMPLEMENTADA |
| MA-09 | Integrações mínimas (clientes, vendas, financeiro, produtos, RBAC, auditoria) | IMPLEMENTADA |
| MA-10 | Governança (tenant, RBAC, auditoria, desativação, 409, índices) | IMPLEMENTADA |
| — | Insumos | NÃO EXECUTADO (mantido só como posição arquitetural) |

## 17. Governança deste documento

1. **Quem cria módulo, atualiza o mapa.** Toda entrega que cria entidade,
   relação ou fluxo atualiza `ERP-DOMAIN-MAP.md` no mesmo PR.
2. **Decisão cruzada exige ADR** em `docs/ADR-NNN-*.md` (padrão do
   [ADR-001](ADR-001-FONTE-UNICA-FATURAMENTO.md)), registrada **antes** do
   código.
3. **`planned` só existe sem backend.** Quando backend existir, `audit:menu`
   reprova (`PLANNED_OBSOLETO`) — a documentação não pode ficar atrás do código.
4. **Status exige evidência.** "Finalizado" = testes verdes citados. "Conceitual"
   = nenhuma tabela/recurso/tela.
5. **Nada de reescrever módulo finalizado** para "padronizar". Se um padrão novo
   for necessário, ele vale do módulo seguinte em diante, ou exige decisão
   explícita registrada.
6. **Gates são parte da arquitetura** (§4.7). Branch sem gate verde não é
   entrega.

---

## 18. Referências conceituais (princípios, não código)

Nenhum código, schema ou banco proprietário foi copiado. Foram usados apenas
princípios de modelagem e separação de responsabilidades:

| Sistema | Princípio absorvido | Como aparece no BroBond |
|---|---|---|
| **TOTVS Protheus** | hierarquia de representantes, grupos, vendedores, unidades de negócio, territórios, regras de comissão, relação cliente × produto × vendedor × comissão | §8 (hierarquia/equipe/território/carteira), §11 (motor de regras), §16 (MA-08 unidade de negócio) |
| **ERPNext** | Sales Person + hierarquia, Employee, Territory, Sales Team, Contribution %, Targets, Item Group, Sales Partner | §8.3, §9 (território hierárquico), §10 (metas por grão), §11.2 (participação/comissão indireta) |
| **Odoo** | Sales Teams, Team Leader, salespeople, assignment rules, commission plans, targets/achievement, individual × team performance | §8.3 (`representante_equipe`/líder), §11 (`plano_comissao`/`regra_comissao`), §10 (atingimento individual e de equipe) |

O que **não** foi importado: estruturas de tabela, nomes de campos, motores de
cálculo, fluxos de trabalho e qualquer implementação proprietária.

---

## 19. Riscos arquiteturais identificados

| # | Risco | Impacto | Mitigação |
|---|---|---|---|
| R1 | **Dual-track** `sales`/`sale_items` (analítico) × `vendas`/`itens_venda` (operacional) | relatório divergir da operação | ADR-001 é a decisão vigente; nenhum módulo novo pode criar terceira fonte |
| R2 | `resources.ts` com 88 recursos e 3.837 linhas | acoplamento e conflito de merge | contrato é fonte única **por decisão**; evolução por recurso, com teste de contrato (`api.test.ts`) |
| R3 | Paridade `memdb` × `pgstore` | regra validada só em memória pode falhar em PG | todo domínio com saldo/dinheiro/tenant exige teste PG |
| R4 | Cobertura de `empresa_id` não é 100% das tabelas | risco de vazamento em tabela nova | `audit:menu` (`EMPRESA_SEM_COLUNA`/`COLUNA_SEM_ESCOPO`) + regra §4.1 |
| R5 | Comissão sem motor de regras | regra comercial complexa vira exceção no código | MA-05, com paridade obrigatória |
| R6 | Ausência de território/meta/carteira | relatórios comerciais limitados a `regiao` textual | MA-02…MA-04 |
| R7 | Documentação histórica extensa e parcialmente defasada (65 arquivos em `docs/`) | leitor pode tomar doc antigo como estado atual | estes dois documentos passam a ser a **fonte oficial** de arquitetura; docs de fase são históricos |
| R8 | Gate PostgreSQL depende de `DATABASE_URL` | risco de "verde" sem banco | SKIP declarado, nunca PASS; CI tem job `testes-postgres` |
| R9 | Dívida de `no-explicit-any` (518 avisos) | tipagem frouxa em pontos antigos | não aumentar; corrigir por domínio tocado |
| R10 | `CASCADE` já existente em tabelas-filha | exclusão em cascata de histórico se mal usada | revisão por domínio; `dependencias.ts` bloqueia antes |

---

## 20. Gates executados nesta fundação

Ambiente: Node 22.22.3 · npm 10.9.8 · sem PostgreSQL local · `DATABASE_URL` ausente.

| Gate | Comando | Resultado |
|---|---|---|
| Tipos | `npm run typecheck` | ✅ **0 erros** (domain + server + client) |
| Lint | `npm run lint` | ✅ **0 erros** / 518 avisos (todos `no-explicit-any`/dívida declarada) |
| Testes de servidor | `npm --workspace server test` | ✅ **1.118 testes · 1.050 passam · 0 falham · 68 skip** |
| Testes de front | `npm --workspace client test` | ✅ **794 testes · 67 arquivos · 794 passam** |
| Build do front | `npm run build` | ✅ bundle + PWA (86 entradas de precache) |
| Auditoria de menu/arquitetura | `npm run audit:menu` | ✅ **0 erros · 19 avisos classificados** |
| PostgreSQL | `npm run test:pg` | **SKIP** — `exit 2`: exige `DATABASE_URL` de banco novo; **não** há banco neste ambiente |
| Prisma | `npm run db:validate` | **NÃO EXECUTADO** — o download do `schema-engine` (`binaries.prisma.sh`) está fora do alcance de rede do sandbox; `prisma/schema.prisma` não foi tocado |

### 20.1 Por que 68 testes aparecem como *skip*

Os 68 casos são exatamente os arquivos `server/test/pg/**` e os testes de
`server/test/*-pg/-multiempresa` que dependem de banco real. Eles **não** foram
contados como aprovados: o `TAP` registra `# SKIP requer DATABASE_URL (job
testes-postgres do CI)`. O CI do repositório executa o job `testes-postgres`
(serviço `postgres:16`), onde eles rodam de verdade.

**Nenhum código de aplicação, schema ou domínio foi alterado nesta fase** — a
entrega é documental. Por isso os gates acima medem o **baseline** `af6d2f4`,
que permanece idêntico após as alterações (dois arquivos `.md` novos).

---

## 21. Documentos relacionados

| Documento | Papel |
|---|---|
| [`docs/ERP-FUNDACAO-COMERCIAL.md`](ERP-FUNDACAO-COMERCIAL.md) | **implementação** da fundação comercial (MA-02…MA-10): migrations, recursos, endpoints, telas, testes e limites | 
| [`docs/ERP-DOMAIN-MAP.md`](ERP-DOMAIN-MAP.md) | **mapa formal de domínios** (este documento é a doutrina; o mapa é o inventário) |
| [`docs/ERP-MASTER-MAP.md`](ERP-MASTER-MAP.md) | auditoria estrutural E1 (histórico, evidência de módulo por módulo) |
| [`docs/ERP-CORE-ROADMAP.md`](ERP-CORE-ROADMAP.md) | roadmap de fechamento do ERP CORE (ERP-01…ERP-13) |
| [`docs/ERP-GAPS.md`](ERP-GAPS.md) | gaps por fase, com evidência |
| [`docs/PADRAO-CADASTROS-AUXILIARES.md`](PADRAO-CADASTROS-AUXILIARES.md) | padrão LISTA → PÁGINA |
| [`docs/EXCLUSAO-E-VINCULOS.md`](EXCLUSAO-E-VINCULOS.md) | exclusão, desativação, 409 |
| [`docs/ADR-001-FONTE-UNICA-FATURAMENTO.md`](ADR-001-FONTE-UNICA-FATURAMENTO.md) | fonte única do faturamento |
| [`docs/ESTOQUE-CANONICO.md`](ESTOQUE-CANONICO.md) | semântica canônica de estoque |

---

## 20. Correções de estado (PR #92 — 2026-10-27)

Esta seção corrige três afirmações deste documento que **não** estavam
sustentadas pelo código. A regra é a mesma de sempre: documento sem prova é
dívida.

### 20.1 CRM — "configurável" era meia verdade

Até a migration 0057, `crm_oportunidades.etapa` tinha CHECK de vocabulário fixo
(`prospeccao|qualificacao|proposta|negociacao|fechamento`). Mesmo com
`crm_funis`/`crm_etapas` cadastráveis (0051), **etapa nova não podia ser usada
em oportunidade** — o cadastro aceitava, o uso falhava.

Agora (`docs/ERP-3.0-CRM-FUNIL-CONFIGURAVEL.md`):

```
crm_oportunidades.etapa_id  → crm_etapas.id   (operacional; FK composta por empresa)
crm_oportunidades.etapa     → crm_etapas.chave (texto; histórico/compatibilidade)
```

* validação por cadastro: **tenant** + **funil** + **ativa**;
* transição, validação e histórico em **uma** transação (rollback provado);
* probabilidade vem de `crm_etapas.probabilidade` (fallback legado só quando a
  empresa não tem cadastro);
* UI sem lista fixa: `/api/meta` resolve as opções por empresa (`optionsFrom`).

`ETAPAS_CRM` continua no código apenas como **semente, fallback e
compatibilidade histórica**.

### 20.2 Produção — o MRP é de planejamento/necessidade

`GET /api/producao/mrp` **não** é MRP industrial completo. A rota agora declara
isso na própria resposta (`calculo.tipo = 'mrp_planejamento_necessidade'`,
`coberto[]`, `nao_coberto[]`, `cria_pedido_de_compra: false`) e a fórmula fecha
dupla contagem:

* oferta = **disponível** (físico − reservado − empenhado − bloqueado);
* OP aberta = **planejado − produzido**;
* compra aberta = **pedido − recebido**;
* estoque mínimo = apenas **déficit**;
* falta de produto → necessidade de insumo (a OP existente responde pelo seu
  próprio `faltam`).

Não coberto (declarado): lead time, lote mínimo/econômico, calendário,
capacidade finita, ordens planejadas, consumo real por OP, reservas de material
por OP, pegging/datas de necessidade, horizonte e BOM multinível.

### 20.3 UX — o gate ZERO MODAL agora tem baseline

O gate deixou de ter exceções no código e passou a comparar com
`docs/ERP-3.0-UX-BASELINE.json`. Ele falha em **baseline + qualquer ocorrência
nova**, mede 10 assinaturas (incluindo `<dialog>`, `showModal()`,
`createPortal`, `aria-modal`, `fixed inset-0` em qualquer ordem) e **recusa**
exceção cuja categoria seja fluxo de módulo (cadastro, edição, exclusão,
detalhe, seleção, formulário, workflow). Comentário/texto que menciona modal
continua não sendo violação.
