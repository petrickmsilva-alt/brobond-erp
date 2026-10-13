# RELATÓRIO ERP-UX-03 — Implementação da Árvore Master de Navegação do BROBOND ERP

- **Data:** 2026-10-13
- **Repositório:** `petrickmsilva-alt/brobond-erp`
- **Branch:** `arena/8dcc39d9-brobond-erp`
- **Base de referência:** `docs/RELATORIO-ERP-UX-02.md` (Árvore Master) e `docs/RELATORIO-ERP-UX-02.1.md` (Hotfix P0 Multi-tenant + RBAC + PDV)
- **Modo de execução:** Implementação Controlada + Testes + Evidência

---

## 1. Resumo Executivo

A fase **ERP-UX-03** implementa no frontend do BROBOND ERP a **Árvore Master de Navegação** aprovada no relatório `docs/RELATORIO-ERP-UX-02.md`, substituindo a antiga lista corrida de 15 grupos na Sidebar por uma arquitetura hierárquica navegável (**Espaço → Área → Grupo → Subgrupo → Módulo → Rota**) com fonte única de verdade em `client/src/modules.ts`.

### Indicadores de Reconciliação e Integridade

| Métrica | Antes (UX-02.1) | Depois (ERP-UX-03) | Status |
|---|---:|---:|---|
| Módulos cadastrados em `MODULES` (`client/src/modules.ts`) | 70 | **70** | 100% preservados (zero adição, zero remoção, zero duplicação) |
| Módulos no **ERP CORE** | 56 | **56** | Reorganizados em 8 Áreas Master do Core |
| Módulos em **Commerce** (fora do Core) | 8 | **8** | 4 Canais reais + 4 Multicanal (`planned`) |
| Módulos em **Creators** (fora do Core) | 4 | **4** | Separados do Core em espaço próprio (`planned`) |
| Módulos em **Utilidades Globais** | 2 | **2** | `config` (`/config`) e `ajuda` (`/ajuda`) |
| Áreas Master (`MODULE_AREAS`) | — | **11** | 8 ERP Core + Commerce + Creators + Utilidades Globais |
| Grupos de navegação (`MODULE_GROUPS`) | 15 | **28** | 100% validados por `npm run audit:menu` (0 erros) |
| Rotas frontend (`App.tsx`) | 82 | **82** | 100% preservadas (70 módulos + 5 detalhes + 6 públicas + `/settings` + `*`) |
| Recursos de API (`server/src/resources.ts`) | 80 | **80** | Inalterados |
| Contratos RBAC (`minPerfil`, `adminOnly`, capacidades comerciais) | 70 / 66 / 42 | **70 / 66 / 42** | `admin`: 70, `gerente`: 66, `operador`: 42 (idênticos) |
| Auditoria estática (`npm run audit:menu`) | 0 erros (2 avisos) | **0 erros (2 avisos)** | Aprovado |
| Testes automatizados (Server + Client) | 702 + 280 | **702 + 305** | 1.007 testes passando (0 falhas) |
| Smoke E2E (`npm run smoke`) | 126/126 | **126/126** | 100% verde |

---

## 2. Arquitetura da Árvore Master Implementada

A navegação foi estruturada em **4 Espaços (`NavSectionId`)**, **11 Áreas Master (`ModuleArea`)**, **28 Grupos (`ModuleGroup`)**, **Subgrupos funcionais** e **70 Módulos (`ModuleDef`)**:

```text
BROBOND ERP
├── SEÇÃO 1: ERP CORE (56 módulos)
│   ├── 1. Meu Negócio (2 módulos)
│   │   ├── Visão do negócio → Meu Negócio (/)
│   │   └── Análises → Central de relatórios → Relatórios (/relatorios)
│   ├── 2. Cadastros (11 módulos)
│   │   ├── Produtos
│   │   │   ├── Cadastro principal → Produtos (/produtos)
│   │   │   ├── Classificações → Categorias (/categorias), Cores (/cores), Coleções (/colecoes)
│   │   │   └── Grades e medidas → Grades de tamanho (/grades), Tamanhos (/tamanhos), Tabela de medidas (/medidas)
│   │   ├── Materiais
│   │   │   └── Insumos → Insumos (/insumos)
│   │   └── Pessoas
│   │       └── Cadastros de pessoas → Clientes (/clientes), Fornecedores (/fornecedores), Representantes (/representantes)
│   ├── 3. Vendas (11 módulos)
│   │   ├── Comercial
│   │   │   ├── Pedidos e negociação → Vendas (/vendas), Propostas comerciais (/propostas)
│   │   │   └── Oferta e preço → Catálogos B2B (/catalogos), Políticas comerciais (/politicas-comerciais), Listas de preço (/listas-preco)
│   │   ├── Balcão
│   │   │   └── Venda e gestão de caixa → PDV (/pdv), Caixas do PDV (/pdv-caixas)
│   │   ├── Atendimento e entrega
│   │   │   └── Expedição e logística → Expedição (/expedicao), Divergências de expedição (/divergencias), Envios e rastreio (/envios)
│   │   └── Pós-venda
│   │       └── Devoluções → Devoluções (/devolucoes)
│   ├── 4. Estoque & Suprimentos (10 módulos)
│   │   ├── Estoque
│   │   │   ├── Posição e controle → Posição de estoque (/estoque), Movimentações (/movimentacoes), Inventário (/inventario)
│   │   │   └── Locais → Locais de estoque (/locais)
│   │   └── Compras
│   │       ├── Pedidos e negociação → Compras (/compras), Cotações de compra (/cotacoes-compra)
│   │       ├── Recebimentos → Recebimentos de compra (/compra-recebimentos)
│   │       ├── Entrada por XML → Importar NF-e de compra (/importar-nfe-compra)
│   │       ├── Reposição → Sugestão de compra (/sugestao-compra)
│   │       └── Parâmetros do fornecedor → De-para de fornecedor (/depara-fornecedor)
│   ├── 5. Produção (4 módulos)
│   │   ├── Planejamento → Planejamento (MRP) (/planejamento-producao)
│   │   ├── Execução → Ordens de produção → Cadeias de Fabricação (/ordens)
│   │   └── Engenharia → Ficha técnica e custo → Fichas técnicas (/fichas), Simulador de custo (/custo)
│   ├── 6. Financeiro (10 módulos)
│   │   ├── Operação financeira → Visão e títulos → Financeiro (/financeiro), Lançamentos (/lancamentos)
│   │   ├── Tesouraria → Contas e transferências → Contas financeiras (/contas-financeiras), Transferências (/transferencias)
│   │   ├── Comissões → Comissões (/comissoes)
│   │   ├── Capital → Investidores e aportes → Investidores (/investidores), Aportes e retiradas (/aportes)
│   │   └── Parâmetros financeiros → Categorias financeiras (/categorias-financeiras), Centros de custo (/centros-custo), Recorrências (/recorrencias-financeiras)
│   ├── 7. Fiscal (4 módulos)
│   │   ├── Operação fiscal → Documentos fiscais (/documentos-fiscais), Inutilizações (/inutilizacoes)
│   │   └── Parâmetros fiscais → Regras fiscais (/regras-fiscais), NCM / Tributação (/ncm)
│   └── 8. Administração (4 módulos)
│       ├── Organização e acesso → Empresas (/empresas), Usuários (/usuarios)
│       ├── Governança → Auditoria (/auditoria)
│       └── Automações → Webhooks (/webhooks)
│
├── SEÇÃO 2: COMMERCE — FORA DO CORE (8 módulos)
│   └── 9. Commerce
│       ├── Canais → Conectores reais → Mercado Livre (/conectores/mercado-livre), Mercado Pago (/conectores/mercado-pago), Nuvemshop (/conectores/nuvemshop), Instagram (/conectores/instagram)
│       └── Multicanal → Roadmap (Em breve) → Produtos (/commerce/produtos), Pedidos (/commerce/pedidos), Trends (/commerce/trends), Delivery (/commerce/delivery)
│
├── SEÇÃO 3: CREATORS — FORA DO CORE (4 módulos)
│   └── 10. Creators
│       └── Parcerias e campanhas → Roadmap (Em breve) → Creators (/creators), Creator Matches (/creator-matches), Outreach AI (/outreach-ai), Campanhas (/campanhas)
│
└── SEÇÃO 4: UTILIDADES GLOBAIS (2 módulos)
    └── 11. Utilidades Globais
        └── Conta e suporte → Configurações (/config), Ajuda (/ajuda)
```

---

## 3. Tabela Completa de Reconciliação dos 70 Módulos

Todos os 70 módulos existentes foram reconciliados com **1 única casa principal** na Árvore Master, mantendo `id`, `label`, `path`, `resource`, `minPerfil`, `adminOnly`, `planned`, `connector` e `description` 100% compatíveis.

| # | Espaço | Área Master | Grupo | Subgrupo | ID (`m.id`) | Rótulo (`m.label`) | Rota (`m.path`) | Recurso (`m.resource`) | Natureza (`kind`) | Status | RBAC |
|---:|---|---|---|---|---|---|---|---|---|---|---|
| 1 | `erp` | Meu Negócio | Visão do negócio | — | `dashboard` | Meu Negócio | `/` | — | `visao` | Operacional | Todos |
| 2 | `erp` | Meu Negócio | Análises | Central de relatórios | `relatorios` | Relatórios | `/relatorios` | — | `consulta` | Operacional | Todos |
| 3 | `erp` | Cadastros | Produtos | Cadastro principal | `produtos` | Produtos | `/produtos` | `produtos` | `cadastro` | Operacional | Todos |
| 4 | `erp` | Cadastros | Produtos | Classificações | `categorias` | Categorias | `/categorias` | `categorias_produto` | `parametro` | Operacional | Todos |
| 5 | `erp` | Cadastros | Produtos | Classificações | `cores` | Cores | `/cores` | `cores` | `parametro` | Operacional | Todos |
| 6 | `erp` | Cadastros | Produtos | Classificações | `colecoes` | Coleções | `/colecoes` | `colecoes` | `parametro` | Operacional | Todos |
| 7 | `erp` | Cadastros | Produtos | Grades e medidas | `grades` | Grades de tamanho | `/grades` | `grades` | `parametro` | Operacional | Todos |
| 8 | `erp` | Cadastros | Produtos | Grades e medidas | `tamanhos` | Tamanhos | `/tamanhos` | `tamanhos` | `parametro` | Operacional | Todos |
| 9 | `erp` | Cadastros | Produtos | Grades e medidas | `medidas` | Tabela de medidas | `/medidas` | `medidas` | `parametro` | Operacional | Todos |
| 10 | `erp` | Cadastros | Materiais | Insumos | `insumos` | Insumos | `/insumos` | `insumos` | `cadastro` | Operacional | Todos |
| 11 | `erp` | Cadastros | Pessoas | Cadastros de pessoas | `clientes` | Clientes | `/clientes` | `clientes` | `cadastro` | Operacional | Todos |
| 12 | `erp` | Cadastros | Pessoas | Cadastros de pessoas | `fornecedores` | Fornecedores | `/fornecedores` | `fornecedores` | `cadastro` | Operacional | Todos |
| 13 | `erp` | Cadastros | Pessoas | Cadastros de pessoas | `representantes` | Representantes | `/representantes` | `representantes` | `cadastro` | Operacional | Todos |
| 14 | `erp` | Vendas | Comercial | Pedidos e negociação | `vendas` | Vendas | `/vendas` | `vendas` | `operacao` | Operacional | Todos |
| 15 | `erp` | Vendas | Comercial | Pedidos e negociação | `propostas` | Propostas comerciais | `/propostas` | `propostas` | `operacao` | Operacional | Todos |
| 16 | `erp` | Vendas | Comercial | Oferta e preço | `catalogos` | Catálogos B2B | `/catalogos` | `catalogos` | `operacao` | Operacional | Todos |
| 17 | `erp` | Vendas | Comercial | Oferta e preço | `politicas-comerciais` | Políticas comerciais | `/politicas-comerciais` | `politicas_comerciais` | `parametro` | Operacional | `gerente` + cap. `politicas` |
| 18 | `erp` | Vendas | Comercial | Oferta e preço | `listas-preco` | Listas de preço | `/listas-preco` | `listas_preco` | `parametro` | Operacional | `gerente` |
| 19 | `erp` | Vendas | Balcão | Venda e gestão de caixa | `pdv` | PDV | `/pdv` | — | `operacao` | Operacional | Todos (Operador vende; Gerente abre/fecha caixa) |
| 20 | `erp` | Vendas | Balcão | Venda e gestão de caixa | `pdv-caixas` | Caixas do PDV | `/pdv-caixas` | `pdv_caixas` | `operacao` | Operacional | `gerente` |
| 21 | `erp` | Vendas | Atendimento e entrega | Expedição e logística | `expedicao` | Expedição | `/expedicao` | `ordens_separacao` | `operacao` | Operacional | Todos |
| 22 | `erp` | Vendas | Atendimento e entrega | Expedição e logística | `divergencias` | Divergências de expedição | `/divergencias` | `divergencias_expedicao` | `consulta` | Operacional | `gerente` |
| 23 | `erp` | Vendas | Atendimento e entrega | Expedição e logística | `envios` | Envios e rastreio | `/envios` | `envios` | `operacao` | Operacional | `gerente` |
| 24 | `erp` | Vendas | Pós-venda | Devoluções | `devolucoes` | Devoluções | `/devolucoes` | `devolucoes` | `operacao` | Operacional | Todos |
| 25 | `erp` | Estoque & Suprimentos | Estoque | Posição e controle | `estoque` | Posição de estoque | `/estoque` | `estoque_produtos` | `visao` | Operacional | Todos |
| 26 | `erp` | Estoque & Suprimentos | Estoque | Posição e controle | `movimentacoes` | Movimentações | `/movimentacoes` | `movimentacoes` | `consulta` | Operacional | Todos |
| 27 | `erp` | Estoque & Suprimentos | Estoque | Posição e controle | `inventario` | Inventário | `/inventario` | `inventarios` | `operacao` | Operacional | Todos |
| 28 | `erp` | Estoque & Suprimentos | Estoque | Locais | `locais` | Locais de estoque | `/locais` | `locais_estoque` | `parametro` | Operacional | Todos |
| 29 | `erp` | Estoque & Suprimentos | Compras | Pedidos e negociação | `compras` | Compras | `/compras` | `compras` | `operacao` | Operacional | Todos |
| 30 | `erp` | Estoque & Suprimentos | Compras | Pedidos e negociação | `cotacoes-compra` | Cotações de compra | `/cotacoes-compra` | `cotacoes_compra` | `operacao` | Operacional | `gerente` |
| 31 | `erp` | Estoque & Suprimentos | Compras | Recebimentos | `compra-recebimentos` | Recebimentos de compra | `/compra-recebimentos` | `compra_recebimentos` | `operacao` | Operacional | Todos |
| 32 | `erp` | Estoque & Suprimentos | Compras | Entrada por XML | `importar-nfe-compra` | Importar NF-e de compra | `/importar-nfe-compra` | `compras` | `operacao` | Operacional | `gerente` |
| 33 | `erp` | Estoque & Suprimentos | Compras | Reposição | `sugestao-compra` | Sugestão de compra | `/sugestao-compra` | `insumos` | `consulta` | Operacional | `gerente` |
| 34 | `erp` | Estoque & Suprimentos | Compras | Parâmetros do fornecedor | `depara-fornecedor` | De-para de fornecedor | `/depara-fornecedor` | `fornecedor_insumo_depara` | `parametro` | Operacional | `gerente` |
| 35 | `erp` | Produção | Planejamento | — | `planejamento-producao` | Planejamento (MRP) | `/planejamento-producao` | — | `visao` | Operacional | Todos |
| 36 | `erp` | Produção | Execução | Ordens de produção | `ordens` | Cadeias de Fabricação | `/ordens` | `ordens_producao` | `operacao` | Operacional | Todos |
| 37 | `erp` | Produção | Engenharia | Ficha técnica e custo | `fichas` | Fichas técnicas | `/fichas` | `fichas_tecnicas` | `cadastro` | Operacional | Todos |
| 38 | `erp` | Produção | Engenharia | Ficha técnica e custo | `custo` | Simulador de custo | `/custo` | — | `consulta` | Operacional | Todos |
| 39 | `erp` | Financeiro | Operação financeira | Visão e títulos | `financeiro` | Financeiro | `/financeiro` | — | `visao` | Operacional | `gerente` |
| 40 | `erp` | Financeiro | Operação financeira | Visão e títulos | `lancamentos` | Lançamentos | `/lancamentos` | `lancamentos_financeiros` | `operacao` | Operacional | `gerente` |
| 41 | `erp` | Financeiro | Tesouraria | Contas e transferências | `contas-financeiras` | Contas financeiras | `/contas-financeiras` | `contas_financeiras` | `cadastro` | Operacional | `gerente` |
| 42 | `erp` | Financeiro | Tesouraria | Contas e transferências | `transferencias` | Transferências | `/transferencias` | `transferencias_financeiras` | `operacao` | Operacional | `gerente` |
| 43 | `erp` | Financeiro | Comissões | — | `comissoes` | Comissões | `/comissoes` | `comissoes` | `operacao` | Operacional | `gerente` |
| 44 | `erp` | Financeiro | Capital | Investidores e aportes | `investidores` | Investidores | `/investidores` | `investidores` | `cadastro` | Operacional | `gerente` |
| 45 | `erp` | Financeiro | Capital | Investidores e aportes | `aportes` | Aportes e retiradas | `/aportes` | `aportes_financeiros` | `operacao` | Operacional | `gerente` |
| 46 | `erp` | Financeiro | Parâmetros financeiros | — | `categorias-financeiras` | Categorias financeiras | `/categorias-financeiras` | `categorias_financeiras` | `parametro` | Operacional | `gerente` |
| 47 | `erp` | Financeiro | Parâmetros financeiros | — | `centros-custo` | Centros de custo | `/centros-custo` | `centros_custo` | `parametro` | Operacional | `gerente` |
| 48 | `erp` | Financeiro | Parâmetros financeiros | — | `recorrencias-financeiras` | Recorrências | `/recorrencias-financeiras` | `recorrencias_financeiras` | `parametro` | Operacional | `gerente` |
| 49 | `erp` | Fiscal | Operação fiscal | — | `documentos-fiscais` | Documentos fiscais | `/documentos-fiscais` | `documentos_fiscais` | `operacao` | Operacional | `gerente` |
| 50 | `erp` | Fiscal | Operação fiscal | — | `inutilizacoes` | Inutilizações | `/inutilizacoes` | `inutilizacoes_fiscais` | `operacao` | Operacional | `gerente` |
| 51 | `erp` | Fiscal | Parâmetros fiscais | — | `regras-fiscais` | Regras fiscais | `/regras-fiscais` | `regras_fiscais` | `parametro` | Operacional | `gerente` |
| 52 | `erp` | Fiscal | Parâmetros fiscais | — | `ncm` | NCM / Tributação | `/ncm` | `regras_ncm` | `parametro` | Operacional | `gerente` |
| 53 | `erp` | Administração | Organização e acesso | — | `empresas` | Empresas | `/empresas` | — | `governanca` | Operacional | `adminOnly` |
| 54 | `erp` | Administração | Organização e acesso | — | `usuarios` | Usuários | `/usuarios` | `users` | `governanca` | Operacional | `adminOnly` |
| 55 | `erp` | Administração | Governança | — | `auditoria` | Auditoria | `/auditoria` | `audit_log` | `governanca` | Operacional | `adminOnly` |
| 56 | `erp` | Administração | Automações | — | `webhooks` | Webhooks | `/webhooks` | — | `governanca` | Operacional | `adminOnly` |
| 57 | `commerce` | Commerce | Canais | Conectores reais | `conector-mercadolivre` | Mercado Livre | `/conectores/mercado-livre` | — | `integracao` | Operacional | `gerente` |
| 58 | `commerce` | Commerce | Canais | Conectores reais | `conector-mercadopago` | Mercado Pago | `/conectores/mercado-pago` | — | `integracao` | Operacional | `gerente` |
| 59 | `commerce` | Commerce | Canais | Conectores reais | `conector-nuvemshop` | Nuvemshop | `/conectores/nuvemshop` | — | `integracao` | Operacional | `gerente` |
| 60 | `commerce` | Commerce | Canais | Conectores reais | `conector-instagram` | Instagram | `/conectores/instagram` | — | `integracao` | Operacional | `gerente` |
| 61 | `commerce` | Commerce | Multicanal | Roadmap | `commerce-produtos` | Produtos | `/commerce/produtos` | — | `roadmap` | `planned` (Em breve) | Todos |
| 62 | `commerce` | Commerce | Multicanal | Roadmap | `commerce-pedidos` | Pedidos | `/commerce/pedidos` | — | `roadmap` | `planned` (Em breve) | Todos |
| 63 | `commerce` | Commerce | Multicanal | Roadmap | `commerce-trends` | Trends | `/commerce/trends` | — | `roadmap` | `planned` (Em breve) | Todos |
| 64 | `commerce` | Commerce | Multicanal | Roadmap | `commerce-delivery` | Delivery | `/commerce/delivery` | — | `roadmap` | `planned` (Em breve) | Todos |
| 65 | `creators` | Creators | Parcerias e campanhas | Roadmap | `creators` | Creators | `/creators` | — | `roadmap` | `planned` (Em breve) | Todos |
| 66 | `creators` | Creators | Parcerias e campanhas | Roadmap | `creator-matches` | Creator Matches | `/creator-matches` | — | `roadmap` | `planned` (Em breve) | Todos |
| 67 | `creators` | Creators | Parcerias e campanhas | Roadmap | `outreach-ai` | Outreach AI | `/outreach-ai` | — | `roadmap` | `planned` (Em breve) | Todos |
| 68 | `creators` | Creators | Parcerias e campanhas | Roadmap | `campanhas` | Campanhas | `/campanhas` | — | `roadmap` | `planned` (Em breve) | Todos |
| 69 | `utilidades` | Utilidades Globais | Conta e suporte | — | `config` | Configurações | `/config` | — | `utilidade` | Operacional | Todos |
| 70 | `utilidades` | Utilidades Globais | Conta e suporte | — | `ajuda` | Ajuda | `/ajuda` | — | `utilidade` | Operacional | Todos |

---

## 4. Matriz de Regressão das 82 Rotas Frontend

Todas as 82 rotas da aplicação (70 rotas de módulos + 5 rotas de detalhe por `:id` + 6 rotas públicas + 1 rota legada `/settings` + fallback `*`) foram preservadas sem quebra de URL ou permissão.

### 4.1 Rotas de Módulos (1 a 70)
As 70 rotas da Tabela 3 acima (`/`, `/relatorios`, `/produtos`, ..., `/config`, `/ajuda`) permanecem mapeadas em `App.tsx` e `ModulePage.tsx` com proteção `Protected` + `ModuleAccess` / `AdminOnly`.

### 4.2 Rotas de Detalhe, Legadas, Públicas e Fallback (71 a 82)

| # | Rota | Componente | Guard / Acesso | Breadcrumb / Comportamento na Árvore Master | Status |
|---:|---|---|---|---|---|
| 71 | `/produtos/:id` | `ProductDetail` | `Protected` | `BROBOND ERP › Cadastros › Produtos › #:id` (auto-expande `Cadastros → Produtos`) | OK |
| 72 | `/fichas/:id` | `FichaDetail` | `Protected` | `BROBOND ERP › Produção › Fichas técnicas › #:id` (auto-expande `Produção → Engenharia`) | OK |
| 73 | `/ordens/:id` | `OrdemDetail` | `Protected` | `BROBOND ERP › Produção › Cadeias de Fabricação › #:id` (auto-expande `Produção → Execução`) | OK |
| 74 | `/compras/:id` | `OrderPage (compra)` | `Protected` | `BROBOND ERP › Estoque & Suprimentos › Compras › #:id` (auto-expande `Estoque & Suprimentos → Compras`) | OK |
| 75 | `/vendas/:id` | `OrderPage (venda)` | `Protected` | `BROBOND ERP › Vendas › Vendas › #:id` (auto-expande `Vendas → Comercial`) | OK |
| 76 | `/settings` | `Navigate to="/config" replace` | `Protected` | Redireciona para `/config` (`Utilidades Globais → Conta e suporte → Configurações`) | OK |
| 77 | `/ui-kit` | `ComponentCatalog` | Pública (DEV) | Catálogo visual de componentes UI | OK |
| 78 | `/login` | `Login` | Pública | Tela de login sem shell autenticado | OK |
| 79 | `/esqueci-senha` | `ForgotPassword` | Pública | Recuperação de senha sem shell autenticado | OK |
| 80 | `/redefinir-senha` | `ResetPassword` | Pública | Redefinição de senha sem shell autenticado | OK |
| 81 | `/convite/:token` | `Convite` | Pública | Aceite de convite sem shell autenticado | OK |
| 82 | `/catalogo/:token` e `/portal/:token` (+ `*`) | `CatalogoPublico` / `PortalCliente` / `Navigate to="/"` | Pública / Fallback | Links externos multi-tenant por token e fallback seguro para `/` | OK |

---

## 5. Mudanças Realizadas por Arquivo

1. **`client/src/modules.ts`**
   - Adicionadas as definições canônicas da Árvore Master: `NavSectionId`, `NAV_SECTIONS`, `MODULE_AREAS` (11 Áreas Master), `AREA_META` (ícones e descrições de cada área), `MODULE_GROUPS` (28 grupos globalmente únicos), `GROUP_META`, `ModuleKind`, `buildNavigationTree(list)` e `findModuleByPathname(pathname, list)`.
   - Mantida 100% da assinatura pública usada pelo restante do sistema e pelo `scripts/auditar-menu.ts`: `MODULES`, `MODULE_GROUPS`, `PAGES_ESPECIAIS` (atualizado para cobrir todas as 21 páginas especiais dedicadas), `visibleModules(user)` e `hasCommercialCapability(user, cap)`.
   - Todos os 70 módulos receberam `space`, `area`, `group`, `subgroup`, `kind` e `keywords` para busca semântica.
2. **`client/src/components/Sidebar.tsx`**
   - Reconstruída para renderizar a hierarquia **Seção → Área (acordeão) → Grupo (acordeão ou inline quando grupo único) → Subgrupo → Módulo**.
   - Auto-expansão inteligente da Área e do Grupo correspondentes à rota ativa (incluindo deep links como `/vendas/123`, `/ordens/45`, `/compras/88`, `/produtos/12`, `/conectores/mercado-livre`).
   - Controle de ruído visual: apenas a Área ativa inicia expandida por padrão; clicar em outra Área alterna o foco no ERP Core sem deixar 70 itens abertos simultaneamente.
   - Modo trilho recolhido (`collapsed`) no desktop/tablet com um ícone por Área Master e acesso direto; drawer mobile com `aria-label="Menu principal"`, botão de fechar e fechamento por tecla `Escape` ou troca de rota.
   - Exibição explícita do selo **`Em breve`** (`data-planned="true"`) para os 8 módulos `planned` (4 Commerce Multicanal + 4 Creators).
3. **`client/src/components/Layout.tsx`**
   - Atualizado `descreverRota(pathname)` para resolver a **Área Master** (`m.area`) e o grupo funcional (`m.group`) diretamente de `MODULES`.
   - Breadcrumb (`aria-label="Trilha de navegação"`) agora exibe `BROBOND ERP › {Área Master} › {Módulo} › #{id}`.
   - Em `/`, a trilha e o `document.title` exibem `Meu Negócio — BROBOND ERP` (eliminado qualquer resquício de `"BROBOND ERP Dashboard"`).
4. **`client/src/components/CommandPalette.tsx`**
   - Consome `visibleModules(user)` da mesma fonte única (`client/src/modules.ts`).
   - Busca sem diferenciação de acentos por rótulo do módulo, Área Master, Grupo, Subgrupo, rota (`/ncm`, `/pdv`), descrição e sinônimos (`keywords`, ex.: `"ordens de producao"` encontra `Cadeias de Fabricação`).
   - Exibe cabeçalho contextual `Área → Grupo` (ou `Área → Grupo → Subgrupo`), caminho da rota (`it.path`) e selo `Em breve` para módulos `planned`.
   - Ordenação prioriza módulos operacionais do Core antes de módulos `planned` em caso de empate ou homônimo (ex.: buscar `"Produtos"` posiciona `/produtos` de `Cadastros` antes de `/commerce/produtos`).
5. **`client/src/pages/ModulePage.tsx` e `client/src/pages/CommerceModulePage.tsx`**
   - `ModulePage.tsx` atualizado para encaminhar módulos `planned` com `module.space === 'commerce' || module.space === 'creators'` para `CommerceModulePage`.
   - `CommerceModulePage.tsx` atualizado para exibir `{module.area} · {module.group}` no cabeçalho de módulos em planejamento.
6. **`client/src/pages/AjudaPage.tsx` e `client/public/manifest.json`**
   - `AjudaPage.tsx` atualizado para referenciar `"O painel Meu Negócio"` e filtrar atalhos por `visibleModules(user)`.
   - `manifest.json` atualizado para usar `"Meu Negócio"` no atalho PWA de `/`.
7. **Suíte de Testes (`client/src/modules.test.ts`, `client/src/components/Sidebar.test.tsx`, `client/src/components/Layout.test.tsx`)**
   - Ampliada de 280 para **305 testes no cliente** (23 em `modules.test.ts`, 18 em `Sidebar.test.tsx`, 11 em `Layout.test.tsx`), cobrindo todos os 16 cenários obrigatórios de ERP-UX-03.

---

## 6. Cobertura dos 16 Cenários Obrigatórios de Teste

| # | Cenário Obrigatório (ERP-UX-03 §35) | Arquivo de Teste | Status |
|---:|---|---|---|
| 1 | Todos os 70 módulos existem na nova árvore | `client/src/modules.test.ts` | PASS |
| 2 | Nenhum módulo foi duplicado como destino principal | `client/src/modules.test.ts` + `Sidebar.test.tsx` | PASS |
| 3 | Nenhum módulo perdeu rota (`path`) ou `resource` | `client/src/modules.test.ts` + `npm run audit:menu` | PASS |
| 4 | `visibleModules(user)` para `admin` (70 módulos) | `client/src/modules.test.ts` + `Sidebar.test.tsx` | PASS |
| 5 | `visibleModules(user)` para `gerente` (66 módulos, sem `Administração`) | `client/src/modules.test.ts` + `Sidebar.test.tsx` | PASS |
| 6 | `visibleModules(user)` para `operador` (42 módulos, sem `Financeiro`/`Fiscal`/`Administração`/gerenciais) | `client/src/modules.test.ts` + `Sidebar.test.tsx` | PASS |
| 7 | `visibleModules(user)` respeitando capacidades comerciais (`politicas-comerciais`) | `client/src/modules.test.ts` + `Sidebar.test.tsx` | PASS |
| 8 | PDV acessível para operador; gestão de caixa (`pdv-caixas`) restrita a gerente/admin | `client/src/modules.test.ts` + `Layout.test.tsx` + `PdvPage.test.tsx` | PASS |
| 9 | Módulos `adminOnly` invisíveis para `gerente` e `operador` | `client/src/modules.test.ts` + `Sidebar.test.tsx` | PASS |
| 10 | Módulos `minPerfil: 'gerente'` invisíveis e bloqueados por URL direta para `operador` | `client/src/components/Sidebar.test.tsx` + `Layout.test.tsx` | PASS |
| 11 | Módulos `planned` identificados com badge `Em breve` (`data-planned="true"`) | `client/src/components/Sidebar.test.tsx` + `Layout.test.tsx` | PASS |
| 12 | Sidebar abre automaticamente o grupo/área da rota ativa | `client/src/components/Sidebar.test.tsx` | PASS |
| 13 | Deep links (`/vendas/:id`, `/ordens/:id`, `/compras/:id`, `/produtos/:id`, `/fichas/:id`) marcam área/grupo correto | `client/src/components/Sidebar.test.tsx` + `Layout.test.tsx` | PASS |
| 14 | Command Palette (`Ctrl+K`) encontra módulos pela nova árvore, rota e sinônimos | `client/src/components/Layout.test.tsx` | PASS |
| 15 | Breadcrumb mostra contexto correto da Árvore Master e `"Meu Negócio"` em `/` | `client/src/components/Layout.test.tsx` | PASS |
| 16 | Troca de empresa (`CompanySwitcher`) preserva navegação e remonta conteúdo do tenant | `client/src/components/Layout.test.tsx` + `CompanySwitcher.test.tsx` | PASS |

---

## 7. Evidências de QA Visual e Gates de Qualidade

### 7.1 Nota de Transparência sobre QA Visual (§36 e §41)
No ambiente sandbox desta execução não há binário de navegador gráfico instalado (`google-chrome`, `chromium`, `firefox` ou `playwright` ausentes no container Linux). Conforme a diretriz explícita da §41 (*"Nunca fingir QA visual se o browser não estiver disponível"*):
- **Status de Browser Local:** `browser visual não disponível` no container local.
- **Verificação realizada:** A estrutura DOM, estados visuais (`data-collapsed`, `data-mobile-open`, `data-active`, `data-planned`), atributos ARIA (`aria-expanded`, `aria-controls`, `aria-current="page"`, `role="dialog"`, `role="option"`), navegação por teclado (`Escape`, `Ctrl+K`) e responsividade por classes Tailwind (`md:static`, `md:w-[17rem]`, `md:w-16`, `-translate-x-full`) foram validados integralmente via React Testing Library / Vitest (`Sidebar.test.tsx` e `Layout.test.tsx`) e build de produção Vite (`npm run build`).

### 7.2 Resultado dos Gates Obrigatórios (§37)

| Gate | Comando | Resultado |
|---|---|---|
| Auditoria de Menu × Rotas × RBAC × Multiempresa | `npm run audit:menu` | **PASS** — 70 módulos, 28 grupos, 80 recursos API, 43 navegáveis, 72 tabelas com `empresa_id`, **0 erros** (2 avisos classificados pré-existentes) |
| Typecheck (Domain + Server + Client) | `npm run typecheck` | **PASS** — 0 erros TypeScript |
| Lint | `npm run lint` | **PASS** — 0 erros ESLint |
| Testes Unitários e Integração (Server + Client) | `npm test` | **PASS** — Server: 702 pass / 0 fail; Client: 28 arquivos / 305 pass / 0 fail |
| Build de Produção Frontend | `npm run build` | **PASS** — Vite build + PWA `generateSW` (59 entradas precache) concluído sem erros |
| Smoke E2E | `npm run smoke` | **PASS** — **126/126 verificações OK** |
| Higiene de Diff | `git diff --check` | **PASS** — 0 erros de whitespace/conflito |
| CI GitHub Actions (incluindo PostgreSQL real `test:pg` e `smoke:pg`) | Push + PR | Validado no GitHub Actions da PR |

---

## 8. O que Fica para Fases Futuras (Fora do Escopo de ERP-UX-03)

Conforme as restrições estritas da fase ERP-UX-03 (que veda alterar rotas, remover módulos ou reescrever páginas operacionais internas), permanecem registrados para ondas futuras:
1. **Consolidação opcional de parâmetros em abas internas (UX-04+):** Módulos hoje mantidos como rotas independentes dentro de subgrupos (ex.: `grades`, `tamanhos` e `medidas` em `Cadastros → Produtos → Grades e medidas`; `categorias-financeiras`, `centros-custo` e `recorrencias-financeiras` em `Financeiro → Parâmetros financeiros`) já estão agrupados em 2º/3º nível na Sidebar sem poluir o topo, podendo no futuro ganhar navegação por abas internas mantendo redirects das URLs atuais.
2. **Aviso classificado `RBAC_DERIVA_SOLTA` em `politicas_comerciais`:** Pré-existente e documentado pelo `audit:menu` (menu exige `gerente` + capacidade `politicas`, enquanto o recurso CRUD genérico no servidor usa autenticação padrão).
3. **Implementação funcional dos 8 módulos `planned` (`Commerce Multicanal` e `Creators`):** Atualmente isolados fora do ERP Core e sinalizados com badge `Em breve`.
