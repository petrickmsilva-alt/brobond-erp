# BROBOND ERP — MAPA MESTRE

**Fase E1 — Auditoria estrutural.**
Repositório: `petrickmsilva-alt/brobond-erp` · Branch: `arena/3b3ee997-brobond-erp`
Baseline auditado: `e6cb2f0` (`main`) · Data da auditoria: 2026-10-09

> Regra deste documento: **nenhum status é declarado sem evidência.** Cada linha
> aponta para o arquivo que comprova o que está escrito. O que não pôde ser
> exercitado aqui está marcado como tal — nunca como concluído.
>
> Escopo: exclusivamente o ERP. O repositório `brobond-ai-commerce` não foi
> lido, copiado nem referenciado.

---

## 1. EVIDÊNCIA COLETADA NESTA AUDITORIA

Tudo abaixo foi **executado** neste ambiente, não inferido:

| Verificação | Comando | Resultado |
|---|---|---|
| Tipos (domain + server + client) | `npm run typecheck` | ✅ verde, 0 erros |
| Lint | `npm run lint` | ✅ 0 erros / 362 avisos (todos `no-explicit-any`, `warn` por design) |
| Testes de servidor | `npm --workspace server test` | ✅ **575 testes · 552 passam · 0 falham · 23 pulados** (pulam sem `DATABASE_URL`; rodam no job PG) |
| Testes de front | `npm --workspace client test` | ✅ **176 testes · 176 passam** (17 arquivos) |
| PostgreSQL real, **banco vazio** | `npm run test:pg` | ✅ **49/49 passam** contra PostgreSQL 18.4 em `127.0.0.1:55432`, banco recriado com 0 tabelas antes do boot |
| Smoke HTTP ponta a ponta | `npm run smoke` | ✅ **39/39 verificações** contra o Express bootado em `:3001` |
| Build do front | `npm run build` | ✅ verde (bundle + PWA, 50 entradas de precache) |
| Auditoria de menu × rotas × RBAC × multiempresa | `npm run audit:menu` | ✅ 0 erros · 6 avisos classificados (**ferramenta nova desta fase**, ver §6) |

Estado do banco **após** o bootstrap em banco vazio (medido por `information_schema`):

| Medida | Valor |
|---|---|
| Tabelas | **91** |
| Migrações registradas em `schema_migrations` | **25** (`0001` … `0025`) |
| Tabelas com coluna `empresa_id` | **66** |
| Índices | **316** |

Um teste que estava **quebrado no baseline** foi encontrado e corrigido nesta
fase (ver §7, `GAP-E1-TESTE-FUSO`).

Já existia no baseline — e vale citar porque é um gate estrutural real — o
teste `todo campo não-virtual de resources.ts existe em db/schema.sql`
(`server/test/api.test.ts:174`): ele impede que um recurso declare uma coluna
que o banco não tem. Passa.

---

## 2. ARQUITETURA REAL DO SISTEMA

Como o sistema é montado de fato — importante porque difere do que um leitor
esperaria de um projeto com Prisma na raiz:

| Camada | Onde | Observação |
|---|---|---|
| **Banco (fonte de verdade)** | `db/schema.sql` + `db/migrations/0001…0025.sql` | Aplicado no boot por `server/src/db.ts`, sob `pg_advisory_lock`, com registro em `schema_migrations`. É isto que cria as 91 tabelas. |
| **Prisma** | `prisma/schema.prisma` (11 modelos) | **Dual-track, parcial por design**: só cobre o motor de conectores (`Connector`, `Sale`, `SaleItem`…) mais âncoras (`Usuario`, `Produto`, `Tamanho`, `Empresa`, `ImpostosNcm`). O ERP **não** é gerenciado por `prisma migrate dev`. |
| **Recursos / contratos** | `server/src/resources.ts` (`RESOURCES`, 74 recursos) | Fonte única de validação, SQL, formulários e tabelas. Exposto ao front por `GET /api/meta`. |
| **Persistência** | `server/src/pgstore.ts` (Postgres) / `server/src/memdb.ts` (demonstração) | Duas implementações do mesmo contrato (`store.ts`). Sem `DATABASE_URL` o ERP sobe em modo demonstração. |
| **Serviço** | `server/src/services.ts` + módulos por domínio | `checkAccess`/`checkFluxo` (RBAC), escopo de empresa aplicado no gargalo. |
| **Rotas** | `server/src/index.ts` | `app.use('/api', wrap(requireAuth))` na linha 321: tudo registrado depois é autenticado; o que está antes é público por intenção (auth, convite, portal, catálogo, arquivo com token, health) + os routers de webhook (`publicConnectorsRouter`, `publicGatewayRouter`). |
| **Menu + rotas do front** | `client/src/modules.ts` (`MODULES`, 62 entradas) → `client/src/App.tsx` | Fonte única do menu **e** das rotas. |
| **Conectores** | `modules/connectors/` | Núcleo próprio (OAuth, criptografia, sync, ingestão). |

---

## 3. MAPA POR MÓDULO

Legenda de status: 🟢 COMPLETO · 🟡 PARCIAL · 🟠 DEPENDÊNCIA EXTERNA · 🔴 GAP

Colunas **Banco / API / Frontend / Testes** usam ✅ (existe e foi visto) ·
⚠️ (parcial) · ❌ (não existe). "Testes" = existe teste automatizado que cobre
o domínio (unitário, integração, PG ou front).

### 3.1 Meu Negócio

| Módulo | Função | Banco | API | Frontend | Testes | Integração | Status |
|---|---|---|---|---|---|---|---|
| Meu Negócio (`/`) | Painel analítico: faturamento, margem, CMV, impostos, curva ABC, canais, alertas | ✅ `vendas`, `itens_venda`, `impostos_ncm`, `produto_abc` | ✅ `/api/negocios/{resumo,abc,canais,margens,vendas}`, `/api/dashboard`, `/api/financeiro/resumo` | ✅ `pages/Dashboard.tsx` + 7 componentes em `components/dashboard/` | ✅ `Dashboard.negocios.test.tsx` (11), `negocios*.test.ts`, `pg-negocios`, `pg-dashboard-escopo`, `dashboard-escopo` | — | 🟢 |

**Preservado por regra:** `/` continua sendo o Meu Negócio. Não existe
`/meu-negocio` nem `/dashboard2`, e nenhum foi criado.

Gaps conhecidos do painel estão documentados pelo próprio projeto em
`docs/ETAPA-2.1-GAPS.md` (série diária, antifraude, compras atrasadas por data)
e continuam abertos — ver `docs/ERP-GAPS.md`.

### 3.2 Cadastros

| Módulo | Função | Banco | API | Frontend | Testes | Integração | Status |
|---|---|---|---|---|---|---|---|
| Produtos | Ficha completa: catálogo, classificação, fiscal (NCM/CEST/CFOP/CST), logística (pesos/dimensões), suprimento | ✅ `produtos`, `produto_composicao`, `produto_fornecedor_skus`, `produto_abc` | ✅ CRUD + `/produtos/:id/{detalhe,tamanhos,variacoes,preco,qrcode}` | ✅ CRUD + `ProductDetail.tsx` | ✅ `variacoes.test.ts`, `grades.test.ts`, `api.test.ts` | — | 🟢 |
| Categorias | Tipos de peça | ✅ `categorias` | ✅ | ✅ | ✅ | — | 🟢 |
| Cores | Cores com amostra | ✅ `cores` | ✅ | ✅ | ✅ | — | 🟢 |
| Insumos | Matéria-prima, custo médio | ✅ `insumos`, `estoque_insumos` | ✅ | ✅ | ✅ | — | 🟢 |
| Tamanhos | Dicionário de tamanhos | ✅ `tamanhos` | ✅ | ✅ | ✅ | — | 🟢 |
| Grades | Conjuntos nomeados de tamanhos | ✅ `grades`, `grade_tamanhos` | ✅ | ✅ | ✅ `grades.test.ts` | — | 🟢 |
| Tabela de Medidas | Medidas por tamanho, completude, impressão | ✅ `medidas`, `medida_valores` | ✅ `/grades/:id/medidas`, `/grades/medidas-resumo` | ✅ `MedidasPage.tsx` | ✅ `medidas.test.ts` | — | 🟢 |
| Coleções | Coleções e temporadas | ✅ `colecoes` | ✅ | ✅ | ✅ | — | 🟢 |
| **Marcas** | Marca do produto | ❌ sem tabela | ❌ | ❌ | ❌ | — | 🔴 `GAP-CAD-MARCAS` |
| **Unidades de medida** | Cadastro de unidades | ❌ só a lista fixa `UNIDADES` em `resources.ts` | ❌ | ❌ | ❌ | — | 🔴 `GAP-CAD-UNIDADES` |

> `Representantes` e `Fornecedores` existem e estão completos, mas o menu os
> coloca em **Vendas** e **Compras** — a especificação os pede também em
> Cadastros. É decisão de navegação, não de domínio: **não duplicar**.

### 3.3 Vendas

| Módulo | Função | Banco | API | Frontend | Testes | Integração | Status |
|---|---|---|---|---|---|---|---|
| Pedidos de venda | Itens, condição de pagamento, frete, comissão; faturar baixa estoque | ✅ `vendas`, `itens_venda` | ✅ CRUD + `/vendas/:id/{itens,fiscal,expedicao,checkout,conferir,envio}` | ✅ CRUD + `OrderPage.tsx` | ✅ `pedidos.test.ts`, `itens`, `expedicao.test.ts`, `pg-p1` | — | 🟢 |
| Propostas comerciais | Rascunho → enviada → aprovada → convertida, conversão idempotente | ✅ `propostas`, `proposta_itens`, `proposta_eventos` | ✅ 7 rotas de fluxo | ✅ CRUD | ✅ `propostas.test.ts` | — | 🟢 |
| Clientes | PF/PJ/estrangeiro, IE/IM/SUFRAMA, IBGE, limite de crédito | ✅ `clientes`, `portal_acessos` | ✅ + `/clientes/:id/portal-acessos` | ✅ CRUD + `PortalAccessModal` | ✅ `multiempresa*.test.ts`, `endereco-publico.test.ts` | — | 🟢 |
| Representantes | Vendedores: CPF, cargo, usuário associado, admissão/desligamento | ✅ `representantes` | ✅ | ✅ | ✅ | — | 🟢 |
| Políticas comerciais | Preço, mínimo, múltiplo, reserva, por canal/coleção/catálogo/cliente | ✅ `politicas_comerciais` | ✅ | ✅ | ✅ `regras.test.ts` | — | 🟢 |
| Listas de preço | Vigência, prioridade, histórico; preço resolvido gravado no item | ✅ `listas_preco`, `lista_preco_itens`, `listas_preco_historico` | ✅ `/listas-preco/{:id/itens,:id/historico,resolver}` | ✅ CRUD | ✅ `listas-preco.test.ts` | — | 🟢 |
| Comissões | Apuração no faturamento + efetivação pró-rata no recebimento + estorno | ✅ `comissoes_eventos`, `vendas.comissao_*` | ✅ `/financeiro/comissoes[/:venda]` | ⚠️ visível em Financeiro; **sem entrada própria no menu** | ✅ `financeiro-p2.test.ts` | — | 🟡 `GAP-VEND-COMISSOES-MENU` |
| Catálogos públicos | Compartilhamento por link com preço, sem login | ✅ `catalogos`, `catalogo_compartilhamentos`, `catalogo_eventos` | ✅ + rotas públicas `/api/publico/catalogo/:token*` | ✅ `CatalogoPublico.tsx`, insights, share modal | ✅ `url-publica.test.ts`, `api.test.ts` | — | 🟢 |
| PDV | Venda de balcão: recálculo total no servidor, pagamento, cancelamento | ✅ `pdv_caixas`, `pdv_pagamentos`, `pdv_caixa_movimentos` | ✅ 9 rotas | ✅ `PdvPage.tsx` | ✅ `pdv.test.ts`, `pg-p2` (concorrência de caixa) | — | 🟢 |
| Caixas do PDV | Abertura/fechamento, suprimento, sangria, diferença | ✅ idem | ✅ | ✅ CRUD | ✅ `pdv.test.ts` | — | 🟢 |
| Documentos fiscais | NF-e/NFC-e com chave, protocolo, DANFE, eventos | ✅ `documentos_fiscais`, `documentos_fiscais_eventos` | ✅ `/fiscal/documentos/:id/{emitir,cancelar,consultar,eventos}` | ✅ CRUD | ✅ `fiscal.test.ts`, `pg-fiscal` | 🟠 Focus NFe / PlugNotas | 🟠 |
| Regras fiscais | CFOP, CST/CSOSN e alíquotas por NCM/UF/operação | ✅ `regras_fiscais`, `impostos_ncm`, `empresa_fiscal_config` | ✅ CRUD + `/fiscal/config` | ✅ CRUD | ✅ `regras.test.ts` | — | 🟢 |
| **Alíquotas por NCM** | Fonte de imposto do cálculo de margem | ✅ `impostos_ncm` | ✅ CRUD (minPerfil gerente) | ❌ **nenhum código do front consome** | ✅ `negocios*.test.ts` | — | 🔴 `GAP-FISC-NCM-MENU` |

### 3.4 Compras

| Módulo | Função | Banco | API | Frontend | Testes | Integração | Status |
|---|---|---|---|---|---|---|---|
| Pedidos de compra | Itens, frete, impostos, previsão; aprovação com alçada | ✅ `compras`, `itens_compra`, `aprovacoes` | ✅ `/compras/:id/{itens,aprovar,receber,recebimentos,pdf}` | ✅ CRUD + `OrderPage.tsx` | ✅ `compras.test.ts`, `pg-p1` | — | 🟢 |
| Fornecedores | Espelho fiscal/comercial + contatos | ✅ `fornecedores`, `fornecedor_contatos` | ✅ | ✅ | ✅ | — | 🟢 |
| Recebimentos | Parcial/total; estoque sobe pelo recebido, nunca pelo pedido; cancelar devolve estoque **e** custo | ✅ `compra_recebimentos`, `compra_recebimento_itens` + vínculo por `recebimento_id`/`item_compra_id` (0028) | ✅ | ⚠️ CRUD genérico; sem conferência recebido × pendente | ✅ `compras.test.ts`, `custo-recebimento.test.ts` | — | 🟡 |
| Sugestão de compra | Estoque atual × mínimo × consumo × em aberto × em trânsito; nunca gera pedido sozinha | ✅ (cálculo puro) | ✅ `/suprimentos/sugestao-compra[/gerar]` | ✅ `SugestaoCompraPage.tsx` | ✅ `SugestaoCompraPage.test.tsx` | — | 🟢 |
| Importação NF-e/XML | Validar fornecedor, CNPJ, itens, SKU, NCM, impostos, de-para, empresa | ✅ `importacoes_nfe` | ✅ `/suprimentos/compras/importar-xml` (`importarXmlCompra`, `suprimentos.ts:383`) | ⚠️ **sem entrada própria no menu** | ❌ **handler sem nenhuma cobertura** | — | 🔴 `GAP-COMP-XML-MENU` |
| De-Para fornecedor × SKU | Traduz SKU do fornecedor para SKU do ERP | ✅ `produto_fornecedor_skus` | ✅ CRUD (sub-recurso) | ⚠️ **sem entrada própria no menu** | ❌ | — | 🔴 `GAP-COMP-DEPARA-MENU` |
| **Cotações de compra** | Cotação → convite → comparativo → decisão → pedido | ✅ `cotacoes_compra`, `cotacao_compra_itens`, `cotacao_compra_fornecedores`, `cotacao_compra_precos` (0027); índice único parcial em `compra_id` | ✅ `/cotacoes-compra/:id/{comparativo,itens,convidar,abrir,cotar,recusar,decidir,cancelar}` | ✅ `CotacoesCompraPage.tsx` | ✅ `cotacoes-compra.test.ts` (16) + `pg-cotacoes-compra.test.ts` (7, corrida real) | — | 🟢 |
| **Custo de recebimento** | Custo efetivo (preço + frete rateado + imposto informado) → custo médio ponderado; os 4 caminhos de recebimento na mesma regra | ✅ `movimentacoes.{recebimento_id,item_compra_id,custo_unitario}`, `movimentacoes_insumos.{compra_id,recebimento_id,item_compra_id}`, `itens_compra.{custo_frete_rateado,custo_impostos}` (0028) + 2 índices únicos parciais | ✅ `POST /compras/:id/receber` devolve `custos` com antes/depois do custo médio | ⚠️ **sem tela dedicada** — o backend devolve os números, falta a UI de recebimento | ✅ `custo-recebimento.test.ts` (19) + `pg-custo-recebimento.test.ts` (16: constraints, 3 corridas, rollback, estorno, multiempresa) | — | 🟡 `GAP-COMP-CUSTOS` fechado no backend |

> **Origem oficial da regra de custo de compra (E3.1):** `server/src/custoRecebimento.ts` é a
> **única** implementação. Qualquer outro lugar que precise de custo de recebimento deve
> chamá-lo — não reimplementar. `custo_medio` só é escrito por esse módulo (verificado com
> `grep custo_medio server/src/*.ts`: os demais arquivos apenas **leem**).

### 3.5 Estoque

| Módulo | Função | Banco | API | Frontend | Testes | Integração | Status |
|---|---|---|---|---|---|---|---|
| Estoque físico | Saldo por produto × tamanho × local, mínimo/máximo | ✅ `estoques`, `estoque_insumos` | ✅ `/estoques/grade` | ✅ `EstoqueGradePage.tsx` | ✅ `locais.test.ts`, `pg-concorrencia.test.ts`, `valorizacao.test.ts` | — | 🟢 |
| Movimentações | Entrada/saída/ajuste/transferência + estorno | ✅ `movimentacoes`, `movimentacoes_insumos` | ✅ CRUD + `/movimentacoes/:id/estornar` | ✅ CRUD + grade | ✅ `pg-concorrencia.test.ts` (saldo atômico), `pedidos.test.ts`, `pdv.test.ts`, `expedicao.test.ts` | — | 🟡 |
| Locais de estoque | Loja, expedição, facção | ✅ `locais` | ✅ | ✅ | ✅ `locais.test.ts` | — | 🟢 |
| Inventário | Contagem por local e acerto de saldos | ✅ `inventarios`, `itens_inventario` | ✅ `/inventarios/:id/{itens,fechar}` | ✅ `InventarioModulePage.tsx` | ✅ `locais.test.ts`, `grades.test.ts`, `pg-concorrencia.test.ts`, `auditoria.test.ts` | — | 🟢 |
| **Vínculo formal venda → estoque** | `movimentacoes.venda_id` | ❌ **coluna não existe** | ❌ usa `motivo = 'Venda #ID'` | ❌ | ❌ | — | 🔴 `GAP-ESTQ-VENDA-ID` |
| Vínculo formal OP → estoque | `movimentacoes.ordem_id` | ✅ FK `ON DELETE SET NULL` + índice + backfill (0026) | ✅ estorno e rastreio pela FK | ✅ | ✅ `pg-producao-e2` (backfill, ON DELETE, escopo) | — | 🟢 |
| **Transferências de estoque** | Entidade própria com origem/destino | ⚠️ `movimentacoes.transferencia_id INTEGER` **com 0 foreign keys** (verificado em `information_schema`) e sem tabela `transferencias` | ⚠️ | ❌ | ❌ | — | 🔴 `GAP-ESTQ-TRANSFERENCIAS` |
| **Reserva de estoque** | Reservar por venda/proposta aprovada | ❌ | ❌ | ❌ | ❌ | — | 🔴 `GAP-ESTQ-RESERVA` |

### 3.6 Produção

| Módulo | Função | Banco | API | Frontend | Testes | Integração | Status |
|---|---|---|---|---|---|---|---|
| Ficha técnica / BOM | Insumos, mão de obra, indiretos, perda, margem | ✅ `fichas_tecnicas`, `itens_ficha_tecnica` | ✅ `/fichas/:id/{insumos,aplicar-preco}` (agora exige gerente/admin) | ✅ CRUD + `FichaDetail.tsx` | ✅ `multiempresa-p1.test.ts`, `negocios.test.ts`, `pg-negocios`, **`custo-ficha.test.ts` (13)** | — | 🟢 |
| Ordens de produção | OP por tamanho ou por grade; concluir entra no estoque e baixa insumos | ✅ `ordens_fabricacao`, `itens_ordem` | ✅ `/ordens/:id/{itens,qualidade}`, `/producao/painel` | ✅ CRUD + `OrdemDetail.tsx` | ✅ `regras.test.ts`, `relatorios.test.ts`, `fuso.test.ts`, `pg-fuso`, **`producao-e2.test.ts` (26)** | — | 🟢 |
| Custos | Insumos + mão de obra + indiretos → custo e preço sugerido | ✅ `fichas_tecnicas.*`, `produtos.custo_*` | ✅ `/fichas/:id/aplicar-preco` | ✅ `CustoPage.tsx` | ✅ **`custo-ficha.test.ts` (13) + `CustoPage.test.tsx` (8)** | — | 🟢 |
| Cadeias de fabricação | Etapa + facção na OP | ✅ `ordens_fabricacao.etapa`, `.faccao` | ✅ | ✅ | ✅ | — | 🟢 |
| Consumo de insumos | Baixa por apontamento e na conclusão, bloqueio 409 sem saldo, `?forcar` auditado | ✅ `movimentacoes_insumos.ordem_id` FK `ON DELETE SET NULL` + backfill pela 0026 | ✅ | ✅ dentro da OP | ✅ | — | 🟢 |
| Estados `LIBERADA` / `PARCIAL` | Fluxo `PLANEJADA→LIBERADA→EM_PRODUÇÃO→PARCIAL→CONCLUÍDA` + `CANCELADA` | ✅ CHECK `ordens_fabricacao_status_valido` (0026) | ✅ grafo em `producao.ts`, 409 na transição ilegal | ✅ botões por estado em `OrdemDetail.tsx` | ✅ unit + `pg-producao-e2` (CHECK recusa com `23514`) + concorrência | — | 🟢 |
| Perdas | Peça refugada consome insumo e não entra no estoque | ✅ `quantidade_perdida`, `itens_ordem.perdido` | ✅ | ✅ | ✅ | — | 🟢 |
| Custo previsto × real na OP | Previsto congelado na liberação, real vem da execução | ✅ `custo_previsto`, `custo_real` | ✅ | ✅ cartão com variação | ✅ | — | 🟢 |
| Apontamentos | Produção parcial por operador/turno, idempotente | ✅ `ordens_apontamentos` + unique parcial `(empresa_id, idempotency_key)` | ✅ `POST /ordens/:id/apontamentos` | ✅ modal + tabela | ✅ unit + `pg-producao-e2` (`23505`) | — | 🟢 |
| Planejamento | Plano por semana + necessidade de insumos | ✅ (leitura) | ✅ `GET /producao/planejamento` | ✅ `PlanejamentoProducaoPage.tsx` | ✅ unit + tela + smoke | — | 🟢 |
| Eventos da OP | Trilha de transições append-only | ✅ `ordens_eventos` | ✅ `GET /ordens/:id/eventos` | ✅ painel "Histórico da OP" | ✅ | — | 🟢 |

### 3.7 Logística & Expedição

| Módulo | Função | Banco | API | Frontend | Testes | Integração | Status |
|---|---|---|---|---|---|---|---|
| Expedição | Separação → conferência → embalagem → expedição | ✅ `expedicao_eventos` | ✅ 4 transições + `packing-check` | ✅ `ExpedicaoPage.tsx` | ✅ `expedicao.test.ts` (31 KB) | — | 🟢 |
| Conferência por barcode | Esperado × lido | ✅ | ✅ | ✅ `BarcodeScanner.tsx` | ✅ | — | 🟢 |
| Divergências | Faltando/sobrando com resolução | ✅ `divergencias_conferencia` | ✅ `/expedicao/divergencias[/:id/resolver]` | ✅ CRUD | ✅ `expedicao.test.ts` | — | 🟢 |
| Envios | Cotação, geração, etiqueta, rastreio, status, cancelamento | ✅ `envios`, `envio_eventos` | ✅ `/envios/:id/{status,rastrear,eventos,cancelar}`, `/logistica/{config,frete}` | ✅ `LogisticaPage.tsx` | ✅ `logistica.test.ts` (30 KB) | 🟠 Melhor Envio / Correios | 🟠 |
| Transportadoras | Configuração e credenciais cifradas | ✅ `configuracoes` + `segredos.ts` (AES-GCM) | ✅ `/logistica/config` | ✅ dentro de Logística | ✅ `logistica.test.ts` | 🟠 | 🟠 |
| Devoluções / reversa | Solicitação → autorização → rastreio → recebimento → conferência → estoque → financeiro | ✅ `devolucoes`, `devolucao_itens` | ✅ 6 rotas de fluxo | ✅ `DevolucoesPage.tsx` | ✅ `DevolucoesPage.test.tsx` | — | 🟢 |
| Fretes | Cálculo | ✅ `frete` em vendas | ✅ `/frete/calcular`, `/frete/cep` | ⚠️ dentro das telas | ✅ | 🟠 | 🟡 |

**Sem credencial o provedor não finge**: `PROVEDOR_NULO` (`logistica.ts:236`)
responde `ok:false, motivo:'nao_configurado'`, e ativar Melhor Envio sem
`me_token` devolve **409** — comportamento comprovado pelo smoke
(`ativar Melhor Envio sem credencial → 409`).

### 3.8 Financeiro

| Módulo | Função | Banco | API | Frontend | Testes | Integração | Status |
|---|---|---|---|---|---|---|---|
| Visão geral | Fluxo de caixa, aging, DRE | ✅ | ✅ `/financeiro/resumo`, `/financeiro/rentabilidade` | ✅ `FinanceiroPage.tsx` | ✅ `financeiro-*.test.ts` (5 arquivos) | — | 🟢 |
| Lançamentos | Livro-caixa, receitas/despesas/investimentos/estornos | ✅ `lancamentos_financeiros` | ✅ CRUD + `/lancamentos/:id/baixar` | ✅ CRUD | ✅ | — | 🟢 |
| Contas a receber / pagar | Parcelas reais por título, baixa total/parcial com juros, multa e desconto | ✅ | ✅ | ✅ | ✅ `tryUpdateIf(status='pendente')` | — | 🟢 |
| Contas / Categorias / Centros de custo | Classificação gerencial | ✅ `contas_financeiras`, `categorias_financeiras`, `centros_custo` | ✅ | ✅ | ✅ | — | 🟢 |
| Transferências | Débito/crédito atômicos, DRE-neutras | ✅ `transferencias_financeiras` | ✅ | ✅ | ✅ | — | 🟢 |
| Investidores / Aportes | Capital, participação, distribuição | ✅ `investidores`, `aportes` | ✅ `/financeiro/investidores` | ✅ | ✅ | — | 🟢 |
| Recorrências | Despesas/receitas fixas geradas automaticamente | ✅ `recorrencias_financeiras` | ✅ `/financeiro/recorrencias/gerar` + cron | ✅ | ✅ | — | 🟢 |
| Gateways de pagamento | Arquitetura `PaymentProvider`, cobrança, cancelamento, estorno | ✅ `gateway_configs`, `gateway_cobrancas`, `gateway_webhook_events` | ✅ 8 rotas + webhook público assinado | ✅ dentro de Financeiro | ✅ `financeiro-p2`, smoke (idempotência) | 🟠 Mercado Pago | 🟠 |
| Recebíveis de cartão | Bruto × taxa × líquido por vencimento | ✅ | ✅ `/financeiro/cartao/recebiveis` | ✅ | ✅ | — | 🟢 |
| Conciliação + OFX | Extrato persistente, hash por linha, FITID contra reimportação | ✅ `fin_extrato_transacoes` | ✅ 4 rotas | ✅ | ✅ `pg-p2` (FITID), smoke | — | 🟢 |
| CNAB | Camada de parsers + CNAB240 | ✅ | ✅ `/financeiro/cnab/{parsers,importar}` | ✅ | ✅ smoke | 🟠 banco | 🟡 |
| Comissões | Ver §3.3 | ✅ | ✅ | ⚠️ sem menu próprio | ✅ | — | 🟡 |
| Fluxo projetado | Pendentes + recorrências futuras | ✅ | ✅ em `/financeiro/resumo` | ✅ | ✅ | — | 🟢 |
| DRE | Demonstrativo por período | ✅ | ✅ `/relatorios/dre` | ✅ | ✅ `relatorios.test.ts` | — | 🟢 |

### 3.9 Relatórios

| Módulo | Função | Banco | API | Frontend | Testes | Integração | Status |
|---|---|---|---|---|---|---|---|
| Central de Relatórios | 11 relatórios com exportação | ✅ | ✅ `/relatorios/:nome` + `/relatorios/qualidade` | ✅ `RelatoriosPage.tsx` | ✅ `relatorios.test.ts` | — | 🟡 |

**Relatórios que existem** (extraído de `relatorios.ts`, `nome:`):
`abc`, `comissoes`, `dre`, `estoque-minimo`, `estoque-posicao`, `faturamento`,
`insumos-minimo`, `movimentacoes-periodo`, `producao-periodo`,
`razao-financeiro`, `vendas`.

**Pedidos pela especificação e ausentes**: Produtos, Compras, Fiscal,
Logística, Clientes, Representantes, Rentabilidade, Gerenciais →
`GAP-REL-CENTRAL`.

### 3.10 Administração

| Módulo | Função | Banco | API | Frontend | Testes | Integração | Status |
|---|---|---|---|---|---|---|---|
| Usuários | Criação, edição, bloqueio, senha temporária, convite, sessões, certificação | ✅ `usuarios`, `usuario_empresas`, `sessoes`, `login_tentativas` | ✅ 18 rotas | ✅ `UsuariosPage.tsx` | ✅ `usuarios.test.ts` (45 KB) | — | 🟢 |
| MFA | TOTP, códigos de backup, desafio, reset por admin | ✅ | ✅ 8 rotas | ✅ `ReauthModal`, Config | ✅ `auth-fluxo.test.ts` | — | 🟢 |
| Segurança | Argon2id, política de senha, reautenticação, rate limiting, cabeçalhos | ✅ `login_tentativas`, `politica_senha` | ✅ | ✅ | ✅ `negocios-seguranca.test.ts`, smoke | — | 🟢 |
| Auditoria | Quem/empresa/quando/ação/entidade/ID/dados, **cadeia de hashes verificável** | ✅ `auditoria` | ✅ CRUD + `/admin/auditoria/verificar` | ✅ CRUD | ✅ `auditoria.test.ts` (21 KB), `pg-auditoria-multiempresa` | — | 🟢 |
| Multiempresa | Escopo obrigatório, claim `emp` no JWT revalidada a cada request, 404 (não 403) entre empresas | ✅ 66 tabelas com `empresa_id`, trigger `brobond_herdar_empresa` | ✅ | ✅ `CompanySwitcher.tsx` | ✅ `multiempresa.test.ts`, `multiempresa-p1.test.ts`, `pg-multiempresa`, `auditoria-multiempresa` | — | 🟢 |
| **Empresas (cadastro)** | CNPJ, razão social, endereço, regime, config fiscal, concessões | ✅ `empresas`, `usuario_empresas`, `empresa_fiscal_config` | ✅ `/empresas/ativa` + CRUD `empresas` | ❌ **nenhuma entrada no menu** | ✅ `multiempresa.test.ts`, `pg-multiempresa`, `pg-convite` | — | 🔴 `GAP-ADMIN-EMPRESAS-MENU` |
| Backup | Exportação e XLSX | ✅ | ✅ `/admin/backup*` | ⚠️ | ✅ | — | 🟡 |
| **Migração / importação central** | Preview, validação, mapeamento, erros por linha, dry-run, relatório, rollback | ⚠️ 5 tipos (produtos, clientes, fornecedores, insumos, estoque) | ✅ `/importar/{modelo,preview,confirmar}` — CSV e XLSX | ⚠️ `ImportModal` por módulo, **sem tela central** | ⚠️ sem teste dedicado | — | 🟡 `GAP-ADMIN-IMPORTACAO` |

### 3.11 Integrações (Commerce)

| Módulo | Função | Banco | API | Frontend | Testes | Integração | Status |
|---|---|---|---|---|---|---|---|
| Mercado Livre | OAuth2 oficial, pedidos, painel | ✅ `connectors`, `connector_events`, `connector_oauth_states`, `sales`, `sale_items` | ✅ `/connectors/:provider/{autorizar,sincronizar,painel}` | ✅ `ConectorPage.tsx` | ✅ `connectors.test.ts` (44 KB) | 🟠 OAuth real não exercitado | 🟠 |
| Mercado Pago | Checkout e faturamento | ✅ idem | ✅ `/connectors/mercadopago/conectar*` | ✅ | ✅ | 🟠 | 🟠 |
| Nuvemshop | OAuth2 oficial, catálogo e pedidos | ✅ idem | ✅ | ✅ | ✅ | 🟠 | 🟠 |
| Instagram Shopping | Graph API oficial da Meta, webhook assinado | ✅ idem | ✅ `/connectors/instagram/painel` | ✅ | ✅ | 🟠 Graph API | 🟠 |
| **WooCommerce** | REST API v3 oficial (Basic Auth), idempotente por `WOO-<id>` | ✅ usa `vendas.pedido_cliente` | ✅ `/marketplace/loja/{status,produtos,pedidos,estoque}` | ❌ **nenhuma entrada no menu** | ✅ `loja.test.ts` | 🟠 | 🔴 `GAP-COM-WOO-MENU` |
| Webhooks de saída | Eventos de usuário, entregas, reenvio | ✅ `webhooks`, `webhook_entregas` | ✅ 7 rotas | ✅ `WebhooksPage.tsx` | ✅ `webhooks.test.ts` | — | 🟢 |
| Webhooks de entrada | Gateway e conectores, assinatura + idempotência | ✅ `gateway_webhook_events` | ✅ rotas públicas | ✅ | ✅ `pg-p2`, smoke | — | 🟢 |

**Segredo nunca aparece inteiro no front**: `mascararSegredo` em
`logistica.ts:210` e equivalentes devolvem apenas `*_configurada: boolean`.

### 3.12 Gestão de Commerce (esqueleto honesto)

| Módulo | Função | Banco | API | Frontend | Testes | Integração | Status |
|---|---|---|---|---|---|---|---|
| Produtos | Catálogo unificado por canal | ⚠️ `sales`/`sale_items` existem; sem publicação por canal | ❌ | ⚠️ `CommerceModulePage.tsx` — **zero chamadas de API** | ✅ `modules.test.ts` | — | 🔴 `GAP-COM-PRODUTOS` |
| Pedidos | Inbox omnichannel | ⚠️ ingestão existe (`ingestion/sale-ingestion.service.ts`) mas **nenhuma rota lista `sales`** | ❌ | ⚠️ idem | ✅ | — | 🔴 `GAP-COM-PEDIDOS` |
| Trends | Tendências | ✅ dados reais disponíveis em `/negocios/*` | ⚠️ | ⚠️ idem | ✅ | — | 🔴 `GAP-COM-TRENDS` |
| Delivery | Fila de envios | ✅ `envios` é o domínio real | ✅ `/envios*` | ⚠️ idem | ✅ | — | 🔴 `GAP-COM-DELIVERY` |

Nenhuma destas quatro telas inventa dado: `grep api\\.\\|useApiQuery\\|fetch(`
em `CommerceModulePage.tsx` retorna **zero ocorrências**. Estão marcadas
`planned` em `MODULES` e renderizam `PlannedModule` — coerente com a regra 30.

### 3.13 Ecossistema Creators

| Módulo | Função | Banco | API | Frontend | Testes | Integração | Status |
|---|---|---|---|---|---|---|---|
| Creators / Matches / Outreach AI / Campanhas | Base de creators, matching, abordagem, campanhas, ROI | ❌ nenhuma tabela | ❌ nenhum endpoint | ⚠️ `planned` | ✅ `modules.test.ts` | — | 🔴 `GAP-CREATORS` |

Confirmado por varredura: as únicas ocorrências de "creator" fora do front são
`server/src/backup.ts` (lista de tabelas) e os testes do menu. **Nenhum
vestígio de `brobond-ai-commerce`** foi encontrado no repositório.

---

## 4. MATRIZ DA CADEIA PRINCIPAL

| Elo | Existe | Evidência |
|---|---|---|
| CADASTRO | 🟢 | 9 cadastros completos + 2 ausentes (marcas, unidades) |
| COMPRA | 🟡 | ciclo completo até o financeiro, cotações e custo de recebimento funcionando; faltam a tela de recebimento, o importador de XML no menu e o de-para |
| PRODUÇÃO | 🟡 | OP funciona ponta a ponta; faltam estados, perdas, custo previsto/real, apontamentos |
| ESTOQUE | 🟡 | saldo atômico e testado em PG; **vínculos formais ausentes** (`venda_id`, `ordem_id`) |
| VENDA | 🟢 | pedido → pagamento → estoque → fiscal → expedição → financeiro |
| FISCAL | 🟠 | motor completo; transmissão real depende de credencial |
| LOGÍSTICA | 🟠 | adapters prontos; cotação/etiqueta reais dependem de credencial |
| FINANCEIRO | 🟢 | núcleo + gateway + OFX + CNAB + comissões |
| BI | 🟢 | motor analítico em `/api/negocios/*` |
| COMMERCE | 🔴 | conectores reais; **gestão de commerce é esqueleto** |

---

## 5. GATES DE QUALIDADE — SITUAÇÃO ATUAL

| Gate | Estado |
|---|---|
| `npm run typecheck` | ✅ |
| `npm run lint` | ✅ 0 erros |
| `npm test` | ✅ 552 + 176 |
| `npm run test:pg` | ✅ 49/49 em banco vazio (**agora executável localmente** — ver §6) |
| `npm run build` | ✅ |
| `npm run smoke` | ✅ 39/39 |
| `npm run audit:menu` | ✅ 0 erros |
| `npx prisma validate` | ⚠️ **não executado aqui**: exige download do `schema-engine`, e o sandbox só alcança `registry.npmjs.org`. O CI (`ci.yml`) roda com sucesso. Schema Prisma não foi tocado nesta fase. |

---

## 6. FERRAMENTAS CRIADAS NESTA FASE

### 6.1 `npm run audit:menu` — `scripts/auditar-menu.ts`

Implementa a seção 27 da especificação. Lê as **mesmas** fontes usadas em
produção (não reimplementa nada): `client/src/modules.ts`,
`client/src/App.tsx`, todos os `.tsx` do front, `server/src/resources.ts`,
`server/src/index.ts`, `db/schema.sql` + `db/migrations/*.sql`.

Verificações que **bloqueiam** o PR (`exit 1`):

| Regra | O que pega |
|---|---|
| `MENU_ROTA` | item de menu apontando para rota inexistente |
| `MENU_DUP` | dois módulos na mesma rota |
| `MENU_RECURSO` | módulo declarando recurso que não existe na API |
| `MENU_INTERNO` | menu expondo recurso `internal` |
| `MENU_GRUPO` / `MENU_META` | grupo sem declaração ou sem metadado de Sidebar |
| `RBAC_DERIVA_ADMIN` / `RBAC_DERIVA_GERENTE` | servidor exige mais do que o menu declara → usuário clica e leva 403 |
| `PLANNED_OBSOLETO` | módulo `planned` que já tem backend ou página própria |
| `EMPRESA_SEM_COLUNA` | recurso declara `empresa: true` mas a tabela não tem `empresa_id` |
| `COLUNA_SEM_ESCOPO` | tabela tem `empresa_id` mas o recurso não filtra por empresa |
| `AUTH_GLOBAL` | middleware global de auth removido |

Avisos classificados (não bloqueiam): `RBAC_DERIVA_SOLTA`, `ROTA_SEM_MENU`,
`ROTA_PUBLICA`, `RECURSO_SEM_MENU`, `MENU_GRUPO_VAZIO`.

Exceções documentadas **no próprio código**, com o motivo — não são buracos:
`checkAccess` não aplica `minPerfil` a `catalogos`/`politicas_comerciais`
(alçada vem de `perm_catalogos`/`perm_politicas`); e `empresa_id` não é
dimensão de filtro em `usuarios`, `usuario_empresas`, `empresa_fiscal_config`
e `empresas`.

**Limitação conhecida e declarada:** a ferramenta cobre recursos (`RESOURCES`)
e o menu. Endpoints que não passam por um recurso — como
`/api/marketplace/loja/*` (WooCommerce) — não são verificados quanto a entrada
navegável. Isso é exatamente o que deixou o gap do WooCommerce invisível; está
registrado como `GAP-E1-AUDIT-BLINDSPOT`.

### 6.2 `npm run test:pg` e `npm run smoke` na raiz

Antes só existiam dentro dos workspaces (`npm --workspace server run test:pg`).
Agora os gates citados na seção 26 da especificação rodam com o nome que a
especificação usa.

### 6.3 PostgreSQL local para o gate de banco

O sandbox não tem PostgreSQL de sistema e não alcança repositórios `apt`.
Foi instalado `embedded-postgres` (binários oficiais do PostgreSQL 18.4 vindos
do `registry.npmjs.org`) **fora do repositório** (`/home/user/pglab`, não
versionado) para poder executar o gate de banco real:

```
postgres://brobond:brobond@127.0.0.1:55432/brobond_teste
```

Procedimento usado: recriar o banco (`0 tabelas públicas`) → rodar
`npm run test:pg` → o boot do ERP aplica `db/schema.sql` + as 25 migrações do
zero. **49/49 testes passaram.** Nenhuma dependência nova foi adicionada ao
`package.json` do projeto.

---

## 7. O QUE MUDOU NESTA FASE (E1)

E1 é auditoria. As únicas alterações de código são as duas correções que a
própria auditoria tornou obrigatórias:

| Arquivo | Mudança | Por quê |
|---|---|---|
| `client/src/pages/Dashboard.negocios.test.tsx` | fixture de "vencem hoje" passa a usar `dataISO(new Date())` | O teste montava a data com o dia **local**; a tela compara com o dia civil de **America/Sao_Paulo** (`lib/periodo.ts`). Entre 00:00 e 03:00 UTC os dois divergem e o teste falhava. **Falha reproduzida no baseline `e6cb2f0`** às 01:01 UTC de 2026-10-09 e corrigida: 11/11 passam. |
| `scripts/auditar-menu.ts` (novo) | auditoria automática | Seção 27 |
| `package.json` | `test:pg`, `audit:menu`, `smoke` na raiz; `scripts/**/*.ts` no lint | Seção 26 |
| `eslint.config.mjs` | inclui `scripts/**/*.ts`; global `Buffer` | o script novo passa no lint (0 avisos) |

**Nada foi reescrito.** Nenhum módulo existente teve regra de negócio alterada.

---

## 8. PRÓXIMA FASE

`docs/ERP-GAPS.md` classifica cada gap por fase (E2…E12). A próxima é **E2 —
Produção**, que ataca `GAP-PROD-*` e o vínculo `GAP-ESTQ-ORDEM-ID`.
