# BROBOND ERP — MAPA FORMAL DE DOMÍNIOS

> **ERP 3.0 (2026-10-27) — leia antes deste documento.** Este é um documento
> **histórico**: ele descreve a fase em que foi escrito. O estado REAL do
> código hoje está em [`docs/ERP-3.0-ARCHITECTURE-BASELINE.md`](ERP-3.0-ARCHITECTURE-BASELINE.md)
> (inventário lido do código por `npm run architecture:audit`) e os gaps
> abertos em [`docs/ERP-3.0-GAP-MATRIX.md`](ERP-3.0-GAP-MATRIX.md).
> Onde este arquivo afirmar algo que o baseline desmente — por exemplo
> "ERP single-company" — **vale o baseline**. Nada do conteúdo histórico foi
> apagado: o registro de como cada fase foi executada continua abaixo.

**Status:** documento oficial · **v1.0** · 2026-10-26
**Repositório:** `petrickmsilva-alt/brobond-erp` · **Branch:** `arena/1bd3659f-brobond-erp`
**Baseline auditado:** `af6d2f4` (`main`)
**Doutrina irmã:** [`docs/ERP-MASTER-ARCHITECTURE.md`](ERP-MASTER-ARCHITECTURE.md) — o *porquê*.
Este documento é o *inventário*: domínios, entidades, donos, relações, limites.

> Regra de leitura: **🟢 implementado** (tabela + API + tela + teste) ·
> **🟡 parcial** (existe parte) · **🟠 dependência externa** · **⏳ conceitual**
> (nada criado: nem tabela, nem API, nem tela). Nenhuma entidade ⏳ foi criada
> nesta fase — ela é **contrato futuro**, não código morto.

---

## 1. Árvore master do ERP

Marcação: `[🟢]` implementado · `[🟡]` parcial · `[⏳]` conceitual/não criado · `[🟠]` externo.

```
BROBOND ERP
│
├── CADASTROS MESTRES
│   ├── Produtos .......................... [🟢] produtos
│   ├── Categorias ........................ [🟢] categorias
│   ├── Subcategoria ...................... [⏳] (hoje: categoria plana)
│   ├── Grades ............................ [🟢] grades + grade_tamanhos
│   ├── Tamanhos .......................... [🟢] tamanhos
│   ├── Cores ............................. [🟢] cores
│   ├── Coleções .......................... [🟢] colecoes
│   ├── Tabela de Medidas ................. [🟢] medidas + medida_valores
│   ├── Insumos ........................... [🟢] insumos (NÃO executar nesta fase)
│   ├── Marcas ............................ [⏳] (não existe)
│   ├── Unidades de medida ................ [⏳] (lista fixa em resources.ts)
│   ├── Locais de estoque ................. [🟢] locais
│   ├── Fornecedores ...................... [🟢] fornecedores + fornecedor_contatos
│   ├── Clientes .......................... [🟢] clientes
│   ├── Representantes .................... [🟢] representantes
│   └── Serviços / Outros ................. [⏳] (não se aplica ainda)
│
├── ESTRUTURA ORGANIZACIONAL
│   ├── Empresas (tenant) ................. [🟢] empresas
│   ├── Configuração fiscal da empresa .... [🟢] empresa_fiscal_config
│   ├── Usuários × Empresas ............... [🟢] usuario_empresas
│   ├── Unidade de negócio / filial ....... [⏳] (hoje papel de empresas)
│   └── Centro de custo ................... [🟢] centros_custo
│
├── COMERCIAL / VENDAS
│   ├── CRM (leads) ....................... [⏳]
│   ├── Oportunidades ..................... [⏳]
│   ├── Propostas ......................... [🟢] propostas + itens + eventos
│   ├── Pedidos / Vendas .................. [🟢] vendas + itens_venda
│   ├── PDV ............................... [🟢] pdv_caixas/pagamentos/movimentos
│   ├── Equipes comerciais ................ [⏳]
│   ├── Representantes (cadastro) ......... [🟢] representantes
│   ├── Territórios ....................... [⏳] (só representantes.regiao TEXT)
│   ├── Carteiras ......................... [🟡] (só clientes.representante_id)
│   ├── Metas ............................. [⏳]
│   ├── Comissões (apuração/efetivação) ... [🟢] vendas.comissao_* + comissoes_eventos
│   ├── Comissões (motor de regras) ....... [⏳]
│   ├── Políticas comerciais .............. [🟢] politicas_comerciais
│   ├── Listas de preço ................... [🟢] listas_preco + itens + histórico
│   ├── Catálogos compartilhados .......... [🟢] catalogos + compartilhamentos + eventos
│   ├── Expedição / Separação ............. [🟢] expedicao_eventos
│   ├── Envios / Logística ................ [🟢] envios + envio_eventos
│   └── Devoluções ........................ [🟢] devolucoes + devolucao_itens
│
├── COMPRAS
│   ├── Solicitações / Sugestão ........... [🟡] (sugestão calculada; sem entidade)
│   ├── Cotações .......................... [🟢] cotacoes_compra + itens/fornecedores/preços
│   ├── Pedidos de compra ................. [🟢] compras + itens_compra
│   ├── Recebimentos ...................... [🟢] compra_recebimentos + itens
│   ├── Importação de NF-e ................ [🟢] importacoes_nfe
│   ├── De-para de fornecedor ............. [🟢] produto_fornecedor_skus
│   ├── Fornecedores (cadastro) ........... [🟢] fornecedores
│   ├── Homologação de fornecedor ......... [⏳]
│   └── Histórico de compras .............. [🟢] derivado
│
├── ESTOQUE
│   ├── Saldos ............................ [🟢] estoques
│   ├── Movimentações ..................... [🟢] movimentacoes
│   ├── Locais ............................ [🟢] locais
│   ├── Transferências .................... [🟡] (via movimentações; sem documento)
│   ├── Inventário ........................ [🟢] inventarios + itens_inventario
│   ├── Lotes ............................. [⏳]
│   ├── Insumos (saldo/movimento) ......... [🟢] estoque_insumos + movimentacoes_insumos
│   └── Divergências de conferência ....... [🟢] divergencias_conferencia
│
├── PRODUTOS (engenharia)
│   ├── Composição ........................ [🟢] produto_composicao
│   ├── Ficha técnica ..................... [🟢] fichas_tecnicas + itens_ficha_tecnica
│   ├── Custo (recebimento canônico) ...... [🟢] custoRecebimento + produtos.custo
│   ├── Preço de venda .................... [🟢] precoVenda + listas_preco
│   └── Curva ABC ......................... [🟢] produto_abc
│
├── FINANCEIRO
│   ├── Contas a pagar / receber .......... [🟢] lancamentos_financeiros
│   ├── Contas financeiras (banco/caixa) .. [🟢] contas_financeiras
│   ├── Categorias financeiras ............ [🟢] categorias_financeiras
│   ├── Centros de custo .................. [🟢] centros_custo
│   ├── Transferências .................... [🟢] transferencias_financeiras
│   ├── Recorrências ...................... [🟢] recorrencias_financeiras
│   ├── Recebimentos / Pagamentos ......... [🟢] baixas em lancamentos + extrato
│   ├── Conciliação (OFX/CNAB) ............ [🟢] fin_extrato_transacoes + cnab.ts
│   ├── Gateway de cobrança ............... [🟠] gateway_cobrancas + webhooks
│   ├── Investidores / Aportes ............ [🟢] investidores + aportes
│   └── Comissões (livro) ................. [🟢] comissoes_eventos
│
├── FISCAL
│   ├── Documentos fiscais ................ [🟠] documentos_fiscais (+ eventos)
│   ├── Inutilizações ..................... [🟢] inutilizacoes_fiscais
│   ├── Regras fiscais (CFOP/CST/alíquota)  [🟢] regras_fiscais
│   ├── Alíquotas por NCM ................. [🟢] impostos_ncm
│   ├── Configuração fiscal da empresa .... [🟢] empresa_fiscal_config
│   └── Obrigações acessórias ............. [⏳] (SPED/obrigações não implementado)
│
├── PRODUÇÃO
│   ├── Ordens de fabricação .............. [🟢] ordens_fabricacao
│   ├── Itens da ordem .................... [🟢] itens_ordem
│   ├── Apontamentos ...................... [🟢] ordens_apontamentos
│   ├── Eventos / estorno ................. [🟢] ordens_eventos
│   ├── Consumo de insumos ................ [🟢] movimentacoes_insumos
│   ├── Custo real da ordem ............... [🟢] ordens_fabricacao.custo_real
│   └── Planejamento com capacidade ....... [🟡] planejamento-producao (estimativa)
│
├── RELACIONAMENTO COM CLIENTES
│   ├── Portal do cliente ................. [🟢] portal_acessos
│   ├── Catálogo compartilhado ............. [🟢] catalogo_compartilhamentos
│   ├── Pós-venda / devoluções ............ [🟢] devolucoes
│   ├── Interações / histórico de contato . [⏳]
│   └── Segmentação ....................... [⏳] (hoje: clientes.tipo textual)
│
├── RELACIONAMENTO COM FORNECEDORES
│   ├── Contatos .......................... [🟢] fornecedor_contatos
│   ├── Produtos fornecidos (de-para) ..... [🟢] produto_fornecedor_skus
│   ├── Homologação ....................... [⏳]
│   ├── Condições comerciais .............. [⏳]
│   └── Indicadores de fornecimento ....... [⏳] derivado
│
├── RELACIONAMENTO COM REPRESENTANTES
│   ├── Usuário vinculado ................. [🟢] representantes.usuario_id
│   ├── Hierarquia ........................ [⏳] representante_hierarquia
│   ├── Equipe ............................ [⏳] representante_equipe(+membro)
│   ├── Território ........................ [⏳] representante_territorio
│   ├── Carteira .......................... [⏳] representante_cliente
│   ├── Metas ............................. [⏳] representante_meta
│   ├── Regras de comissão ................ [⏳] plano_comissao + regra_comissao
│   ├── Histórico de comissão ............. [🟢] comissoes_eventos
│   └── Indicadores ....................... [🟡] /relatorios/comissoes
│
├── RELATÓRIOS / BI
│   ├── Meu Negócio (painel) .............. [🟢] /api/negocios/*
│   ├── Relatórios operacionais ........... [🟢] /api/relatorios/*
│   ├── Relatório de comissões ............ [🟢] /relatorios/comissoes
│   ├── Curva ABC ......................... [🟢] produto_abc
│   └── BI por território/equipe .......... [⏳] depende de MA-02…MA-06
│
├── USUÁRIOS / RBAC
│   ├── Usuários .......................... [🟢] usuarios
│   ├── Perfis ............................ [🟢] admin | gerente | operador
│   ├── Permissões comerciais ............. [🟢] perm_* (herdar/permitir/negar)
│   ├── Sessões ........................... [🟢] sessoes
│   └── Política de senha / MFA / TOTP .... [🟢] politica_senha, mfa, totp
│
├── AUDITORIA
│   ├── Trilha por ação ................... [🟢] auditoria
│   └── Cadeia de hashes verificável ...... [🟢] auditChain
│
└── INTEGRAÇÕES
    ├── Conectores (ML, MP, Nuvemshop, IG)  [🟠] connectors + events + oauth_states
    ├── Vendas de canal (analítico) ....... [🟢] sales + sale_items
    ├── Webhooks de saída ................. [🟢] webhooks + webhook_entregas
    ├── Webhooks de entrada (gateway) ..... [🟢] gateway_webhook_events
    ├── Impressão (fila + agentes) ........ [🟢] print_*
    └── API pública / OpenAPI ............. [🟡] openapi.ts
```

---

## 2. Catálogo de domínios (dono, API, tela, teste, limite)

### 2.1 D1 — Cadastros mestres

- **Dono dos dados:** `produtos`, `categorias`, `cores`, `colecoes`, `grades`,
  `grade_tamanhos`, `tamanhos`, `medidas`, `medida_valores`, `insumos`,
  `clientes`, `fornecedores`, `fornecedor_contatos`, `representantes`, `locais`.
- **API:** recursos `produtos`, `categorias`, `cores`, `colecoes`, `grades`,
  `grade_tamanhos`, `tamanhos`, `medidas`, `medida_valores`, `insumos`,
  `clientes`, `fornecedores`, `fornecedor_contatos`, `representantes`,
  `locais` + `/options` + `/api/meta`.
- **Telas:** `/produtos`, `/categorias`, `/cores`, `/colecoes`, `/grades`,
  `/tamanhos`, `/medidas`, `/insumos`, `/clientes`, `/fornecedores`,
  `/representantes` (+ páginas `novo`/`:id/editar` em `FORM_DIRETO`).
- **Testes:** `grades-cadastro`, `colecoes-listagem`, `tamanhos-cadastro`,
  `fornecedores-cadastro`, `representantes-cadastro`, `insumos-cadastro`,
  `cores-cadastro`, `categorias-listagem`, `variacoes`, `medidas`,
  `clientes-pf-pj`, `vendas-pf-pj`; PG: `grades-pg`, `colecoes-postgresql`,
  `fornecedores-pg`, `representantes-pg`, `insumos-pg`, `cores-pg`.
- **Depende de:** estrutura organizacional (tenant), usuários (RBAC).
- **Tenant:** os cadastros de **pessoa e de negócio** (`produtos`, `clientes`,
  `fornecedores`, `representantes`, `insumos`, `colecoes`, `locais`) são **por
  empresa** (`empresa_id` + unicidade por empresa). Já o **catálogo
  compartilhado** (`categorias`, `cores`, `grades`, `grade_tamanhos`,
  `tamanhos`, `medidas`, `medida_valores`, `impostos_ncm`) é **global por
  decisão** (SEC-04/P1-01): leitura aberta, escrita gerente+ via
  `minPerfilEscrita`.
- **Limite:** **não** contém meta, comissão, carteira, território, estoque,
  preço praticado nem histórico. Cadastro desativa, não apaga.
- **Finalizados (não reabrir):** Grades (Arena), Coleções (OpenHands),
  Tamanhos (OpenHands), Fornecedores (Arena), Representantes (Arena).
  **Insumos: NÃO executar nesta fase.**

### 2.2 D2 — Estrutura organizacional

- **Dono:** `empresas`, `empresa_fiscal_config`, `usuarios`, `usuario_empresas`,
  `configuracoes`, `centros_custo`.
- **API:** `empresas` (adminOnly), `usuario_empresas` (adminOnly),
  `empresa_fiscal_config` (adminOnly), `usuarios` (adminOnly na escrita),
  `centros_custo` (gerente), `/empresas/ativa`, `/empresasAcesso`.
- **Telas:** `/empresas`, `/usuarios`, `/config`, `CompanySwitcher`.
- **Testes:** `multiempresa`, `multiempresa-p1`, `empresas-admin`,
  `usuarios`, `auth-fluxo`, `sec03-admin-guard`; PG: `pg-multiempresa`,
  `pg-empresas-admin`, `empresas-admin-e2e`, `pg-convite`,
  `pg-usuario-convite`, `auditoria-multiempresa`.
- **Limite:** **não** é cadastro comercial. Não há unidade de negócio nem
  filial como entidade — hoje `empresas` acumula os dois papéis (⏳ MA-08).

### 2.3 D3 — Comercial / Vendas

- **Dono:** `propostas`, `proposta_itens`, `proposta_eventos`, `vendas`,
  `itens_venda`, `pdv_caixas`, `pdv_pagamentos`, `pdv_caixa_movimentos`,
  `politicas_comerciais`, `listas_preco`, `lista_preco_itens`,
  `listas_preco_historico`, `catalogos`, `catalogo_compartilhamentos`,
  `catalogo_eventos`, `expedicao_eventos`, `envios`, `envio_eventos`,
  `divergencias_conferencia`, `devolucoes`, `devolucao_itens`.
- **API:** recursos acima + fluxos `/vendas/:id/{itens,fiscal,expedicao,checkout,
  conferir,envio}`, `/propostas/:id/{enviar,aprovar,recusar,converter,cancelar}`,
  `/listas-preco/{:id/itens,:id/historico,resolver}`, `/pdv/*`,
  `/publico/catalogo/:token*`.
- **Telas:** `/vendas`, `/propostas`, `/catalogos`, `/politicas-comerciais`,
  `/listas-preco`, `/pdv`, `/pdv-caixas`, `/expedicao`, `/divergencias`,
  `/envios`, `/devolucoes`.
- **Testes:** `pedidos`, `itens`, `propostas`, `expedicao`, `pdv`,
  `pdv-caixa-resumo`, `devolucoes` (PG `devolucao-e2e`), `listas-preco`,
  `regras`, `url-publica`, `p0-catalog-public`, `p0-commerce-tenant`,
  `logistica`; PG `e423-expedicao-postgresql`, `e424-golive-02`,
  `e02-ordem-reabrir`/`e02-reabertura-estorno`, `pg-p1`, `pg-p2`.
- **Depende de:** cadastros (cliente, produto, representante), estoque, fiscal,
  financeiro, comissões.
- **Limite:** **não** grava saldo, não grava título financeiro, não calcula
  comissão no recebimento. Venda congela preço e apuração; quem movimenta
  estoque/financeiro/comissão são os serviços desses domínios.

### 2.4 D4 — Compras

- **Dono:** `compras`, `itens_compra`, `cotacoes_compra`,
  `cotacao_compra_itens`, `cotacao_compra_fornecedores`,
  `cotacao_compra_precos`, `cotacao_decisoes` (decisão do portal do cliente —
  **homônimo, domínio diferente**), `compra_recebimentos`,
  `compra_recebimento_itens`, `importacoes_nfe`, `produto_fornecedor_skus`.
- **API:** recursos + `/compras/:id/receber`, `/cotacoes-compra/:id/*`,
  `/importar/nfe`, `/sugestao-compra`, `/depara`.
- **Telas:** `/compras`, `/cotacoes-compra`, `/compra-recebimentos`,
  `/importar-nfe-compra`, `/sugestao-compra`, `/depara-fornecedor`.
- **Testes:** `compras`, `cotacoes-compra`, `compras-xml-depara`,
  `custo-recebimento`, `custo-ficha`; PG `pg-compras-e32`,
  `pg-cotacoes-compra`, `pg-custo-recebimento`.
- **Depende de:** fornecedores, produtos, estoque, financeiro, fiscal (XML).
- **Limite:** **não** mantém saldo nem custo médio como atributo próprio: o
  recebimento grava movimento de estoque e custo canônico.
- **Atenção de domínio:** `cotacao_decisoes` **não** é cotação de compra — é
  decisão do cliente sobre cotação no portal.

### 2.5 D5 — Estoque

- **Dono:** `estoques`, `movimentacoes`, `locais`, `inventarios`,
  `itens_inventario`, `estoque_insumos`, `movimentacoes_insumos`.
- **API:** `estoques` (interno), `movimentacoes`, `locais`, `inventarios`,
  `itens_inventario`, `estoque_insumos`, `movimentacoes_insumos`,
  `/estoque/*` (grade, saldos, ajustes), `/inventarios/:id/*`.
- **Telas:** `/estoque`, `/movimentacoes`, `/inventario`, `/locais`.
- **Testes:** `locais`, `e421-estoque`, `estoque-canonico-pdv-grade`,
  `pg-e421-estoque-integridade`, `prod-db-01-*` (locais e colisões).
- **Depende de:** produtos, insumos, locais, empresas.
- **Limite:** **não** decide preço, custo nem comissão. Saldo só muda por
  movimento; correção é inventário; quantidade negativa é impossível por CHECK.
- **Divergência conhecida:** não existe documento de transferência de estoque
  (existe `transferencias_financeiras`, que é tesouraria). Transferência hoje é
  par de movimentações.

### 2.6 D6 — Produtos / engenharia

- **Dono:** `produtos`, `produto_composicao`, `produto_abc`,
  `fichas_tecnicas`, `itens_ficha_tecnica`.
- **API:** `produtos` + `/produtos/:id/{detalhe,tamanhos,variacoes,preco,qrcode}`,
  `produto_composicao`, `fichas`, `itens_ficha_tecnica`, `custo`.
- **Telas:** `/produtos`, `/fichas`, `/custo`.
- **Testes:** `variacoes`, `grades`, `preco-venda`, `custo-ficha`,
  `custo-recebimento`, `produtos-listagem`, `product-search`,
  `smart product search` (front), `pg-product-search-postgresql`,
  `pg-produtos-listagem-postgresql`.
- **Depende de:** categorias, cores, coleções, grades/tamanhos, insumos,
  fornecedores, fiscal (NCM/CEST).
- **Limite:** **não** é dono de estoque, preço praticado, custo de recebimento
  nem movimentação. `produtos.custo` é referência de valorização.

### 2.7 D7 — Financeiro

- **Dono:** `lancamentos_financeiros`, `contas_financeiras`,
  `categorias_financeiras`, `centros_custo`, `recorrencias_financeiras`,
  `transferencias_financeiras`, `fin_extrato_transacoes`, `gateway_configs`,
  `gateway_cobrancas`, `gateway_webhook_events`, `investidores`, `aportes`,
  `comissoes_eventos` (livro — ver D11).
- **API:** recursos + `/financeiro/{resumo,comissoes,fluxo,extrato}`,
  `/financeiro/lancamentos/:id/{baixar,estornar}`, `/gateway/*`,
  `/financeiro/cnab`, `/financeiro/ofx`.
- **Telas:** `/financeiro`, `/lancamentos`, `/contas-financeiras`,
  `/transferencias`, `/comissoes`, `/investidores`, `/aportes`,
  `/categorias-financeiras`, `/centros-custo`, `/recorrencias-financeiras`.
- **Testes:** `financeiro-profissional`, `financeiro-onda-b`,
  `financeiro-onda-c`, `financeiro-p2`, `fin01-parcelas`, `extrato`, `cnab`,
  `pg-p2`, `fin01-parcelas-e2e`, `gateway-cadeia-pagamento-e2e`,
  `e01-gateway-webhook-postgresql`, `p2-01-audit-date-jsonb`, `p2-04-*`.
- **Depende de:** empresas, usuários, vendas/compras (origem do título),
  comissões (efetivação na baixa).
- **Limite:** **não** cria título sem documento de origem; não altera valor de
  venda; não apaga histórico (estorno é lançamento compensatório).

### 2.8 D8 — Fiscal

- **Dono:** `documentos_fiscais`, `documentos_fiscais_eventos`,
  `inutilizacoes_fiscais`, `regras_fiscais`, `impostos_ncm`,
  `empresa_fiscal_config`.
- **API:** recursos + `/fiscal/documentos/:id/{emitir,cancelar,consultar,eventos}`,
  `/fiscal/config`, `/fiscal/inutilizacoes`.
- **Telas:** `/documentos-fiscais`, `/inutilizacoes`, `/regras-fiscais`, `/ncm`.
- **Testes:** `fiscal`, `regras`, `fiscal-expedicao`, `pg-fiscal`,
  `fiscal-inutilizacao-e2e`, `pg-fiscal.test.ts`.
- **Depende de:** vendas/produtos/clientes (dados do documento), empresa.
- **Limite:** não decide preço nem estoque. Transmissão real = **🟠 provider
  externo** (`fiscalProvider.ts`, Focus NFe / PlugNotas).
- **Lacuna:** obrigações acessórias (SPED) ⏳.

### 2.9 D9 — Produção

- **Dono:** `ordens_fabricacao`, `itens_ordem`, `ordens_apontamentos`,
  `ordens_eventos`, `fichas_tecnicas`, `itens_ficha_tecnica`.
  (Saldo e movimento de insumo são do **D5 Estoque**: `estoque_insumos`,
  `movimentacoes_insumos`.)
- **API:** `ordens`, `itens_ordem`, `ordens_apontamentos`, `ordens_eventos`,
  `fichas`, `itens_ficha_tecnica`, `/ordens/:id/{iniciar,concluir,reabrir,
  cancelar,apontar,consumo,custo}`.
- **Telas:** `/ordens`, `/fichas`, `/custo`, `/planejamento-producao`.
- **Testes:** `producao-e2`, `custo-ficha`, `pg-producao-e2`,
  `e02-*` (reabertura/estorno), `planejamento`.
- **Depende de:** produtos, insumos, estoque.
- **Limite:** ficha técnica é engenharia do produto (D6); a OP é processo. OP não
  altera preço de venda.
- **Lacuna:** planejamento com capacidade/gargalo é estimativa, não CRP.

### 2.10 D10 — CRM

- **Estado:** ⏳ **não existe**. Nenhuma tabela, recurso ou tela.
- **O que existe e pode ser confundido:** `propostas` (processo comercial),
  `portal_acessos` (acesso do cliente), `catalogo_eventos` (interação com
  catálogo compartilhado).
- **Limite:** CRM futuro **não** pode duplicar cliente. Lead ≠ cliente;
  oportunidade ≠ proposta. Conversão é registro explícito.
- **Fase:** MA-07.

### 2.11 D11 — Comissões

- **Dono (hoje):** `vendas.comissao_pct`, `vendas.comissao_valor` (apuração
  congelada) e `comissoes_eventos` (livro de efetivação).
- **API:** `/financeiro/comissoes`, `/financeiro/comissoes/venda/:id`,
  `/relatorios/comissoes`.
- **Tela:** `/comissoes` (Financeiro › Comissões).
- **Testes:** `financeiro-p2`, `pg/comissoes-e2e`, `pg/comissoes-periodo`,
  `ComissoesPage.test.tsx`.
- **Depende de:** vendas, financeiro (recebimento), representantes.
- **Limite:** comissão **não** é atributo de representante (só default) nem
  coluna calculada no ato da venda; é apurada no faturamento e efetivada no
  recebimento.
- **Futuro (⏳ MA-05):** `plano_comissao`, `regra_comissao`,
  `comissao_lancamento` — com prioridade e paridade obrigatória.

### 2.12 D12 — Metas

- **Estado:** ⏳ **não existe**.
- **Contrato conceitual:** ver
  [`ERP-MASTER-ARCHITECTURE.md`](ERP-MASTER-ARCHITECTURE.md) §10.
- **Limite:** realizado e atingimento são **derivados**, nunca colunas
  editáveis; meta não mora no cadastro do representante.
- **Fase:** MA-04.

### 2.13 D13 — Territórios

- **Estado:** ⏳ **não existe** como domínio. Único vestígio:
  `representantes.regiao TEXT` (busca textual) e endereço do cliente.
- **Contrato conceitual:** `ERP-MASTER-ARCHITECTURE.md` §9.
- **Limite:** `regiao` **não** será removida; a evolução é aditiva
  (`territorio` + `representante_territorio` + de-para opcional).
- **Fase:** MA-02.

### 2.14 D14 — Relacionamento com clientes

- **Dono:** `portal_acessos`, `catalogo_compartilhamentos`, `catalogo_eventos`,
  `devolucoes`, `devolucao_itens`, `envios`, `envio_eventos`.
- **Testes:** `endereco-publico`, `url-publica`, `p0-catalog-public`,
  `sec04-catalogo-compartilhado-rbac`, `pg/sec04-*`, `devolucao-e2e`.
- **Limite:** portal **não** é CRM; acesso do cliente é credencial de leitura.
- **Futuro:** interações/segmentação (MA-07).

### 2.15 D15 — Relacionamento com fornecedores

- **Dono:** `fornecedor_contatos`, `produto_fornecedor_skus` (+ cadastro
  `fornecedores`, finalizado).
- **Testes:** `fornecedores-cadastro`, `compras-xml-depara`,
  `pg/fornecedores-pg`.
- **Futuro (⏳ MA-09):** homologação, condições comerciais, contas bancárias,
  documentos, indicadores.

### 2.16 D16 — Relacionamento com representantes

- **Dono (hoje):** `representantes` (+ `usuario_id`), `vendas.representante_id`,
  `propostas.representante_id`, `clientes.representante_id`,
  `comissoes_eventos`.
- **Telas:** `/representantes`, `/comissoes`.
- **Testes:** `representantes-cadastro`, `pg/representantes-pg`,
  `RepresentantesPage/FormPage/Route`.
- **Futuro:** `representante_hierarquia`, `representante_equipe(+membro)`,
  `representante_territorio`, `representante_cliente`, `representante_meta`,
  `plano_comissao`, `regra_comissao` — **nenhuma criada**.
- **Limite:** o cadastro atual é finalizado e **não** recebe colunas novas para
  meta/carteira/território.

### 2.17 D17 — Relatórios / BI

- **Dono:** derivado — `sales`, `sale_items`, `produto_abc`, `vendas`,
  `itens_venda`, `impostos_ncm`, `lancamentos_financeiros`.
- **API:** `/api/negocios/{resumo,abc,canais,margens,vendas}`,
  `/api/relatorios/*`, `/api/dashboard`, `/api/financeiro/resumo`.
- **Telas:** `/` (Meu Negócio), `/relatorios`.
- **Testes:** `negocios*`, `dashboard-escopo`, `pg-negocios`,
  `pg-dashboard-escopo`, `bi-faturamento-e2e`, `relatorios`,
  `Dashboard.negocios.test.tsx`.
- **Limite:** **não** grava fato operacional; no máximo materializa coluna de
  margem em `sales` (decisão registrada no
  [ADR-001](ADR-001-FONTE-UNICA-FATURAMENTO.md)).
- **Futuro:** indicadores por território/equipe (MA-10).

### 2.18 D18 — Usuários / RBAC

- **Dono:** `usuarios`, `sessoes`, `login_tentativas`, `usuario_empresas`,
  `politica_senha`.
- **API:** `usuarios`, `/auth/*`, `/admin/usuarios/*`, `/empresas`, `/convite`.
- **Testes:** `usuarios`, `auth-fluxo`, `sec01/02/03/04`, `pg-usuario-convite`,
  `sec03-admin-routes-authorization`, `sec02-login-ratelimit-proxy`.
- **Limite:** perfil e permissão **nunca** vêm do cliente; a empresa vem do
  token.

### 2.19 D19 — Auditoria

- **Dono:** `auditoria` (+ `auditChain`).
- **API:** `auditoria`, `/admin/auditoria/verificar`.
- **Tela:** `/auditoria`.
- **Testes:** `auditoria`, `auditoria-multiempresa`,
  `pg-auditoria-multiempresa`, `p2-01-audit-date-jsonb`.
- **Limite:** append-only; não é editável nem excluível pela aplicação.

### 2.20 D20 — Integrações

- **Dono:** `connectors`, `connector_events`, `connector_oauth_states`,
  `sales`, `sale_items`, `webhooks`, `webhook_entregas`,
  `gateway_webhook_events`, `print_agents`, `print_jobs`,
  `print_terminals`, `print_pairing_codes`, `print_agent_nonces`,
  `print_templates` (via código).
- **API:** `/connectors/:provider/{autorizar,sincronizar,painel}`,
  `/marketplace/loja/*`, `/webhooks/*`, `/print/*`.
- **Telas:** `/conectores/{mercado-livre,mercado-pago,nuvemshop,instagram}`,
  `/webhooks`.
- **Testes:** `connectors`, `webhooks`, `loja`, `print-*`, `pg-print`,
  `p0-commerce-tenant`.
- **Limite:** integração **não** é fonte de verdade do ERP; o fato analítico é
  `sales` e a ponte para venda operacional é explícita (`0034`).

---

## 3. Relacionamentos existentes (FKs reais)

Somente o que está no schema. `NO ACTION` é o padrão; CASCADE aparece onde
indicado e é **linha-filha de composição**.

### 3.1 Núcleo comercial

```
empresas 1─N clientes            clientes 1─N vendas          vendas 1─N itens_venda (CASCADE)
empresas 1─N representantes      representantes 1─N vendas
representantes 1─N clientes      representantes 1─N propostas
clientes 1─N propostas           propostas 1─N proposta_itens
propostas 1─1 vendas             (vendas.id via propostas.venda_id, UNIQUE)
vendas 1─N comissoes_eventos     representantes 1─N comissoes_eventos
vendas 1─N devolucoes            devolucoes 1─N devolucao_itens
vendas 1─N envios (CASCADE)      envios 1─N envio_eventos
vendas 1─N expedicao_eventos (CASCADE)
vendas 1─1 documento fiscal      documentos_fiscais 1─N documentos_fiscais_eventos
```

### 3.2 Produto e catálogo

```
categorias 1─N produtos          colecoes 1─N produtos        cores 1─N produtos
grades 1─N grade_tamanhos        tamanhos 1─N grade_tamanhos
produtos 1─N produto_composicao  insumos 1─N produto_composicao
produtos 1─1 fichas_tecnicas     fichas_tecnicas 1─N itens_ficha_tecnica (CASCADE)
insumos 1─N itens_ficha_tecnica  insumos 1─N estoque_insumos
grades 1─N medidas               medidas 1─N medida_valores
produtos 1─N produto_abc         produtos 1─N produto_fornecedor_skus
fornecedores 1─N produto_fornecedor_skus
produtos 1─N lista_preco_itens   listas_preco 1─N lista_preco_itens
```

### 3.3 Estoque

```
produtos 1─N estoques            tamanhos 1─N estoques        locais 1─N estoques
produtos 1─N movimentacoes       tamanhos 1─N movimentacoes   locais 1─N movimentacoes
vendas 1─N movimentacoes (venda_id — vínculo canônico, 0031)
ordens_fabricacao 1─N movimentacoes (ordem_id)
inventarios 1─N itens_inventario inventarios → movimentacao de ajuste
estoques UNIQUE (empresa_id, produto_id, tamanho_id, local_id) + variantes legadas
CHECK estoques_quantidade_nao_negativo
```

### 3.4 Compras

```
fornecedores 1─N compras         compras 1─N itens_compra (CASCADE de linha)
fornecedores 1─N cotacoes_compra cotacoes_compra 1─N cotacao_compra_itens
cotacoes_compra 1─N cotacao_compra_fornecedores 1─N cotacao_compra_precos
compras 1─N compra_recebimentos  compra_recebimentos 1─N compra_recebimento_itens
compras 1─N importacoes_nfe      fornecedores 1─N fornecedor_contatos
produtos 1─N importacoes_nfe / itens_compra
```

### 3.5 Produção

```
produtos 1─N ordens_fabricacao   tamanhos 1─N ordens_fabricacao
ordens_fabricacao 1─N itens_ordem
ordens_fabricacao 1─N ordens_apontamentos (CASCADE)
ordens_fabricacao 1─N ordens_eventos
insumos 1─N movimentacoes_insumos (ordem_id)
```

### 3.6 Financeiro

```
empresas 1─N lancamentos_financeiros
categorias_financeiras 1─N lancamentos_financeiros
contas_financeiras 1─N lancamentos_financeiros
centros_custo 1─N lancamentos_financeiros
contas_financeiras 1─N transferencias_financeiras
contas_financeiras 1─N fin_extrato_transacoes
lancamentos_financeiros 1─N comissoes_eventos (lancamento_id)
recorrencias_financeiras → lancamentos_financeiros (geração)
gateway_cobrancas 1─N gateway_webhook_events
investidores 1─N aportes
lancamentos_financeiros.referencia_tipo + referencia_id  (venda | compra | aporte | outro)
```

### 3.7 Administração / auditoria

```
empresas 1─N usuarios (via usuario_empresas, N─N explícito)
usuarios 1─N representantes (usuario_id, único por empresa)
empresas 1─1 empresa_fiscal_config
empresas 1─N auditoria        usuarios 1─N sessoes
empresas 1─N webhooks         webhooks 1─N webhook_entregas
```

### 3.8 Integrações

```
connectors 1─N connector_events  connectors 1─N connector_oauth_states
connectors 1─N sales (canal)     sales 1─N sale_items
print_terminals 1─N print_jobs   print_agents 1─N print_jobs
```

---

## 4. Inventário de entidades conceituais (NÃO CRIADAS)

Tabela de controle. **Nenhuma** existe no banco hoje; nenhuma foi criada nesta
fase. Elas entram apenas na fase indicada, com migration própria.

| Entidade | Domínio | Fase | Substitui/evita | Depende de |
|---|---|---|---|---|
| `territorio` | D13 | MA-02 | `representantes.regiao` como solução final | empresas |
| `territorio_geografia` (opcional) | D13 | MA-02 | — | territorio |
| `representante_territorio` | D16 | MA-03 | coluna de território no cadastro | territorio, representantes |
| `representante_cliente` | D16/D3 | MA-03 | lista de clientes no cadastro; perda de histórico ao trocar | representantes, clientes |
| `representante_meta` | D12 | MA-04 | `meta` como coluna | representantes, territorio, equipe |
| `meta_equipe` / `meta_territorio` (alvos) | D12 | MA-04 | — | equipe, territorio |
| `representante_hierarquia` | D16 | MA-06 | hierarquia improvisada em texto | representantes |
| `representante_equipe` | D16 | MA-06 | — | empresas |
| `representante_equipe_membro` | D16 | MA-06 | — | equipe, representantes |
| `participacao_venda` | D3/D11 | MA-06 | rateio manual | vendas, representantes, equipe |
| `plano_comissao` | D11 | MA-05 | comissão como coluna | empresas |
| `regra_comissao` | D11 | MA-05 | regra no código | plano_comissao |
| `comissao_lancamento` | D11 | MA-05 | — | regra_comissao, vendas |
| `lead` | D10 | MA-07 | lead como cliente | empresas, usuarios |
| `oportunidade` | D10 | MA-07 | oportunidade como proposta | lead, clientes |
| `interacao_cliente` | D14 | MA-07 | histórico em observação | clientes, usuarios |
| `unidade_negocio` | D2 | MA-08 | `empresas` acumulando filial | empresas |
| `fornecedor_homologacao` | D15 | MA-09 | homologação em observação | fornecedores |
| `fornecedor_condicao_comercial` | D15 | MA-09 | condição em texto | fornecedores |
| `fornecedor_conta_bancaria` | D15 | MA-09 | dado bancário no cadastro | fornecedores |
| `fornecedor_documento` | D15 | MA-09 | anexo solto | fornecedores, arquivos |
| `marca` | D1 | pós-MA | cor livre/texto | empresas |
| `unidade_medida` | D1 | pós-MA | lista fixa `UNIDADES` | — |
| `lote` / `estoque_lote` | D5 | pós-MA | — | produtos, locais |
| `transferencia_estoque` (documento) | D5 | pós-MA | par manual de movimentações | locais, produtos |

**Regra:** criar qualquer uma delas exige (a) a fase do roadmap, (b) migration
aditiva, (c) recurso + tela LISTA→PÁGINA, (d) testes em memória e PG, (e)
atualização deste mapa. Criar antes é violar a fundação.

---

## 5. Direção de dependência entre domínios

```
                       ┌──────────────────────────┐
                       │ D2 Estrutura organizacional │  (tenant, RBAC)
                       └────────────┬─────────────┘
                                    │ todos dependem
        ┌───────────────────────────┼────────────────────────────┐
        ▼                           ▼                            ▼
  ┌───────────┐              ┌─────────────┐              ┌────────────┐
  │ D1 Cadastros │──────────►│ D6 Produtos │─────────────►│ D5 Estoque │
  └─────┬─────┘              └──────┬──────┘              └─────┬──────┘
        │                           │                           │
        ▼                           ▼                           ▼
  ┌────────────┐             ┌────────────┐             ┌────────────┐
  │ D3 Vendas  │────────────►│ D4 Compras │────────────►│ D9 Produção│
  └─────┬──────┘             └─────┬──────┘             └─────┬──────┘
        │                          │                          │
        ├──────────► D11 Comissões ◄─────────┐                │
        ▼                          ▼         │                ▼
  ┌────────────┐             ┌────────────┐  │         ┌────────────┐
  │ D8 Fiscal  │             │ D7 Financeiro│◄─────────┘         │ D17 BI │
  └────────────┘             └──────┬──────┘                  └────────┘
                                    │
                       D19 Auditoria │ D18 Usuários │ D20 Integrações
```

Regras de dependência (obrigatórias para módulo novo):

1. **D2 é transversal** (tenant/RBAC). Ninguém "importa" estrutura
   organizacional como regra de negócio; apenas obedece ao escopo.
2. **Cadastro não depende de processo.** D1 nunca lê `vendas` para existir.
   (Contagem de uso é *leitura agregada* de diagnóstico, não dependência de
   existência.)
3. **Processo depende de cadastro; nunca o contrário.**
4. **Movimento depende de processo**, e só o domínio dono grava o movimento.
5. **Indicador depende de todos** e ninguém depende de indicador.
6. **D11 (Comissões) depende de D3 e D7**, nunca o inverso — o financeiro não
   calcula comissão; ele dispara o hook de efetivação.
7. **D20 é folha**: integração não pode ser pré-requisito para operar o ERP.
8. **Sem dependência circular entre domínios.** Se aparecer, é sinal de dado no
   domínio errado.

---

## 6. Registry central: menu ↔ recurso ↔ tabela

`client/src/modules.ts` (menu e rotas) + `server/src/resources.ts` (contrato) +
`db/schema.sql` (persistência). **70 módulos**, 11 áreas, 88 recursos.

| Área | Grupo | Módulo | Rota | Recurso | Tabela |
|---|---|---|---|---|---|
| Meu Negócio | Visão do negócio | dashboard | `/` | — (endpoints `/negocios/*`) | `sales`, `vendas` |
| Meu Negócio | Análises | relatorios | `/relatorios` | — (`/relatorios/*`) | derivado |
| Cadastros | Produtos | produtos | `/produtos` | produtos | produtos |
| Cadastros | Produtos | categorias | `/categorias` | categorias | categorias |
| Cadastros | Produtos | cores | `/cores` | cores | cores |
| Cadastros | Produtos | colecoes | `/colecoes` | colecoes | colecoes |
| Cadastros | Produtos | grades | `/grades` | grades | grades |
| Cadastros | Produtos | tamanhos | `/tamanhos` | tamanhos | tamanhos |
| Cadastros | Produtos | medidas | `/medidas` | medidas | medidas |
| Cadastros | Materiais | insumos | `/insumos` | insumos | insumos |
| Cadastros | Pessoas | clientes | `/clientes` | clientes | clientes |
| Cadastros | Pessoas | fornecedores | `/fornecedores` | fornecedores | fornecedores |
| Cadastros | Pessoas | representantes | `/representantes` | representantes | representantes |
| Vendas | Comercial | vendas | `/vendas` | vendas | vendas |
| Vendas | Comercial | propostas | `/propostas` | propostas | propostas |
| Vendas | Comercial | catalogos | `/catalogos` | catalogos | catalogos |
| Vendas | Comercial | politicas-comerciais | `/politicas-comerciais` | politicas_comerciais | politicas_comerciais |
| Vendas | Comercial | listas-preco | `/listas-preco` | listas_preco | listas_preco |
| Vendas | Balcão | pdv | `/pdv` | — (`/pdv/*`) | pdv_caixas |
| Vendas | Balcão | pdv-caixas | `/pdv-caixas` | pdv_caixas | pdv_caixas |
| Vendas | Atendimento e entrega | expedicao | `/expedicao` | — (`/expedicao/*`) | expedicao_eventos |
| Vendas | Atendimento e entrega | divergencias | `/divergencias` | divergencias_conferencia | divergencias_conferencia |
| Vendas | Atendimento e entrega | envios | `/envios` | envios | envios |
| Vendas | Pós-venda | devolucoes | `/devolucoes` | devolucoes | devolucoes |
| Estoque & Suprimentos | Estoque | estoque | `/estoque` | — (`/estoque/*`) | estoques |
| Estoque & Suprimentos | Estoque | movimentacoes | `/movimentacoes` | movimentacoes | movimentacoes |
| Estoque & Suprimentos | Estoque | inventario | `/inventario` | — (`/inventarios/*`) | inventarios |
| Estoque & Suprimentos | Estoque | locais | `/locais` | locais | locais |
| Estoque & Suprimentos | Compras | compras | `/compras` | compras | compras |
| Estoque & Suprimentos | Compras | cotacoes-compra | `/cotacoes-compra` | cotacoes_compra | cotacoes_compra |
| Estoque & Suprimentos | Compras | compra-recebimentos | `/compra-recebimentos` | compra_recebimentos | compra_recebimentos |
| Estoque & Suprimentos | Compras | importar-nfe-compra | `/importar-nfe-compra` | — (`/importar/nfe`) | importacoes_nfe |
| Estoque & Suprimentos | Compras | sugestao-compra | `/sugestao-compra` | — (`/sugestao-compra`) | derivado |
| Estoque & Suprimentos | Compras | depara-fornecedor | `/depara-fornecedor` | produto_fornecedor_skus | produto_fornecedor_skus |
| Produção | Planejamento | planejamento-producao | `/planejamento-producao` | — | derivado |
| Produção | Execução | ordens | `/ordens` | ordens | ordens_fabricacao |
| Produção | Engenharia | fichas | `/fichas` | fichas | fichas_tecnicas |
| Produção | Engenharia | custo | `/custo` | — (`/custo/*`) | fichas_tecnicas |
| Financeiro | Operação financeira | financeiro | `/financeiro` | — (`/financeiro/*`) | lancamentos_financeiros |
| Financeiro | Operação financeira | lancamentos | `/lancamentos` | lancamentos_financeiros | lancamentos_financeiros |
| Financeiro | Tesouraria | contas-financeiras | `/contas-financeiras` | contas_financeiras | contas_financeiras |
| Financeiro | Tesouraria | transferencias | `/transferencias` | transferencias_financeiras | transferencias_financeiras |
| Financeiro | Comissões | comissoes | `/comissoes` | — (`/financeiro/comissoes`) | comissoes_eventos |
| Financeiro | Capital | investidores | `/investidores` | investidores | investidores |
| Financeiro | Capital | aportes | `/aportes` | aportes | aportes |
| Financeiro | Parâmetros financeiros | categorias-financeiras | `/categorias-financeiras` | categorias_financeiras | categorias_financeiras |
| Financeiro | Parâmetros financeiros | centros-custo | `/centros-custo` | centros_custo | centros_custo |
| Financeiro | Parâmetros financeiros | recorrencias-financeiras | `/recorrencias-financeiras` | recorrencias_financeiras | recorrencias_financeiras |
| Fiscal | Operação fiscal | documentos-fiscais | `/documentos-fiscais` | documentos_fiscais | documentos_fiscais |
| Fiscal | Operação fiscal | inutilizacoes | `/inutilizacoes` | inutilizacoes_fiscais | inutilizacoes_fiscais |
| Fiscal | Parâmetros fiscais | regras-fiscais | `/regras-fiscais` | regras_fiscais | regras_fiscais |
| Fiscal | Parâmetros fiscais | ncm | `/ncm` | impostos_ncm | impostos_ncm |
| Administração | Organização e acesso | empresas | `/empresas` | — (`/empresas/*`, adminOnly) | empresas |
| Administração | Organização e acesso | usuarios | `/usuarios` | usuarios | usuarios |
| Administração | Governança | auditoria | `/auditoria` | auditoria | auditoria |
| Administração | Automações | webhooks | `/webhooks` | — (`/webhooks/*`) | webhooks |
| Commerce | Canais | conector-mercadolivre | `/conectores/mercado-livre` | — (`/connectors/*`) | connectors |
| Commerce | Canais | conector-mercadopago | `/conectores/mercado-pago` | — | connectors |
| Commerce | Canais | conector-nuvemshop | `/conectores/nuvemshop` | — | connectors |
| Commerce | Canais | conector-instagram | `/conectores/instagram` | — | connectors |
| Commerce | Multicanal | commerce-produtos | `/commerce/produtos` | — (`planned`) | — |
| Commerce | Multicanal | commerce-pedidos | `/commerce/pedidos` | — (`planned`) | — |
| Commerce | Multicanal | commerce-trends | `/commerce/trends` | — (`planned`) | — |
| Commerce | Multicanal | commerce-delivery | `/commerce/delivery` | — (`planned`) | — |
| Creators | Parcerias e campanhas | creators | `/creators` | — (`planned`) | — |
| Creators | Parcerias e campanhas | creator-matches | `/matches` | — (`planned`) | — |
| Creators | Parcerias e campanhas | outreach-ai | `/outreach-ai` | — (`planned`) | — |
| Creators | Parcerias e campanhas | campanhas | `/campanhas` | — (`planned`) | — |
| Utilidades Globais | Conta e suporte | config | `/config` | — | `configuracoes`/`usuarios` |
| Utilidades Globais | Conta e suporte | ajuda | `/ajuda` | — | — |

### 6.1 Recursos sem entrada própria no menu (47)

São **internos, de fluxo ou de composição** — não são módulos. Existem porque o
contrato é único e a API é a mesma; expô-los no menu seria duplicar navegação.

`options`, `portal_acessos`, `cotacao_decisoes`, `catalogo_compartilhamentos`,
`catalogo_eventos`, `arquivos`, `empresas` (tem tela própria, sem `resource`),
`usuario_empresas`, `grade_tamanhos`, `medidas`, `medida_valores`,
`fornecedor_contatos`, `produto_composicao`, `empresa_fiscal_config`,
`documentos_fiscais_eventos`, `estoques`, `itens_venda`, `sales`, `sale_items`,
`itens_compra`, `importacoes_nfe`, `itens_ordem`, `ordens_eventos`,
`ordens_apontamentos`, `itens_ficha_tecnica`, `estoque_insumos`,
`movimentacoes_insumos`, `inventarios`, `itens_inventario`, `lista_preco_itens`,
`listas_preco_historico`, `proposta_itens`, `proposta_eventos`,
`pdv_pagamentos`, `pdv_caixa_movimentos`, `envio_eventos`,
`expedicao_eventos`, `devolucao_itens`, `compra_recebimento_itens`,
`cotacao_compra_itens`, `cotacao_compra_fornecedores`, `cotacao_compra_precos`,
`print_jobs`, `print_agents`, `print_pairing_codes`, `print_agent_nonces`,
`print_terminals`.

Regra: recurso só entra em `MODULES` se for **tela navegável com uso real**.
`npm run audit:menu` sinaliza `RECURSO_SEM_MENU` como aviso classificado.

---

## 7. Fluxos (visão de mapa)

Detalhamento com dono de cada passo em
[`ERP-MASTER-ARCHITECTURE.md`](ERP-MASTER-ARCHITECTURE.md) §6. Resumo:

| Fluxo | Cadeia | Status |
|---|---|---|
| Venda | cliente → proposta → pedido → separação → expedição → faturamento → recebimento → comissão → indicadores | 🟢 provado em PG |
| Compra | necessidade → cotação → pedido → recebimento → estoque → nota → contas a pagar | 🟢 provado em PG |
| Produção | produto → ficha → OP → consumo → produção → estoque → custo real | 🟢 provado em PG |
| Estoque | entrada → saldo → transferência → saída → inventário → auditoria | 🟡 transferência sem documento |
| Devolução | venda → devolução → estoque → financeiro → estorno de comissão | 🟢 `devolucao-e2e` |
| Financeiro | título → baixa → extrato → conciliação (OFX/CNAB) | 🟢 |
| Fiscal | venda → regra fiscal → documento → eventos | 🟠 transmissão externa |

---

## 8. Gaps arquiteturais (ARQ-GAP)

Classificação: **P1** bloqueia evolução segura · **P2** limita análise ·
**P3** dívida/limpeza. Nenhum deles foi "corrigido" nesta fase — esta fase é
documentação e fundação.

| ID | Gap | Severidade | Impacto | Fase |
|---|---|---|---|---|
| ARQ-GAP-01 | Território inexistente (só `representantes.regiao TEXT`) | P1 | impede carteira, meta e BI territorial | MA-02 |
| ARQ-GAP-02 | Carteira não temporal (`clientes.representante_id`) | P1 | troca de representante perde histórico | MA-03 |
| ARQ-GAP-03 | Meta inexistente | P1 | gestão comercial sem alvo; relatório só realizado | MA-04 |
| ARQ-GAP-04 | Comissão sem motor de regras | P1 | exceção comercial vira código | MA-05 |
| ARQ-GAP-05 | Hierarquia/equipe de representante inexistente | P2 | sem visão de equipe nem comissão indireta | MA-06 |
| ARQ-GAP-06 | CRM inexistente | P2 | funil começa em proposta | MA-07 |
| ARQ-GAP-07 | Unidade de negócio ausente (`empresas` acumula) | P2 | filial/estabelecimento sem identidade | MA-08 |
| ARQ-GAP-08 | Homologação/condições de fornecedor ausentes | P2 | compra sem qualificação formal | MA-09 |
| ARQ-GAP-09 | Transferência de estoque sem documento próprio | P2 | rastreabilidade fraca do par de movimentos | pós-MA |
| ARQ-GAP-10 | Subcategoria de produto ausente (categoria plana) | P3 | agrupamento limitado | pós-MA |
| ARQ-GAP-11 | Marca e unidade de medida ausentes | P3 | texto livre / lista fixa | pós-MA |
| ARQ-GAP-12 | Lote/validade ausente em estoque | P3 | sem rastreio por lote | pós-MA |
| ARQ-GAP-13 | Obrigações fiscais (SPED) ausentes | P2 | fora do escopo fiscal atual | ERP-12+ |
| ARQ-GAP-14 | Commerce multicanal é esqueleto (`planned`) | P2 | telas sem API por decisão | congelado |
| ARQ-GAP-15 | Creators inexistente (`planned`) | P3 | — | congelado |
| ARQ-GAP-16 | `memdb` × `pgstore` exigem paridade manual | P2 | regra pode divergir entre modos | contínuo |
| ARQ-GAP-17 | 518 avisos `no-explicit-any` | P3 | tipagem frouxa legada | por domínio tocado |
| ARQ-GAP-18 | Documentação histórica extensa e parcialmente defasada | P2 | leitura errada do estado | contínuo (estes 2 docs são a fonte oficial) |

Nota importante: **`GAP-VEND-COMISSOES-MENU`, `GAP-ADMIN-EMPRESAS-MENU` e
`GAP-COM-WOO-MENU`** (registrados em `docs/ERP-MASTER-MAP.md`, auditoria E1)
**estão fechados** no baseline `af6d2f4`: `/comissoes` e `/empresas` têm entrada
própria em `client/src/modules.ts`; `/marketplace/loja/*` continua existindo sem
entrada de menu — este último permanece como limitação de navegação
(`ARQ-GAP-19`, P3, congelado junto com Commerce).

---

## 9. Manutenção deste mapa

1. Cada PR que cria/renomeia entidade, recurso, tela ou relação **atualiza a
   seção correspondente** neste arquivo.
2. Cada entidade que sai de ⏳ para 🟢 **remove a linha da §4** e ganha seção no
   catálogo (§2) com testes citados.
3. Cada fase concluída do roadmap é marcada em
   [`ERP-MASTER-ARCHITECTURE.md`](ERP-MASTER-ARCHITECTURE.md) §16.
4. Divergência entre este mapa e o código é **defeito de documentação** e deve
   ser corrigida na mesma entrega — o `npm run audit:menu` cobre a parte
   automatizável (menu × rota × recurso × RBAC × tenant).
