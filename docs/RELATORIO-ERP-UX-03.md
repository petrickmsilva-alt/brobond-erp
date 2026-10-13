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

## 4. Matriz Completa de Regressão das 82 Rotas Frontend

Todas as **82 rotas frontend** (70 rotas de módulos + 5 rotas de detalhe por `:id` + 6 rotas públicas/dev + 1 rota legada `/settings` com fallback `*`) foram preservadas sem qualquer quebra de URL, página renderizada, `resource` de API ou contrato RBAC.

| # | Rota (`path`) | Página / Componente (`App.tsx` / `ModulePage.tsx`) | Área Master | Grupo | Recurso API | Guard / RBAC | Status |
|---:|---|---|---|---|---|---|---|
| 1 | `/` | `Dashboard` | Meu Negócio | Visão do negócio | `/api/dashboard`, `/api/negocios/*` | `Protected` (Todos) | OK |
| 2 | `/relatorios` | `RelatoriosPage` | Meu Negócio | Análises | `/api/relatorios/*` | `Protected` (Todos) | OK |
| 3 | `/produtos` | `ModulePage (produtos)` | Cadastros | Produtos | `produtos` | `Protected` (Todos) | OK |
| 4 | `/categorias` | `ModulePage (categorias)` | Cadastros | Produtos | `categorias_produto` | `Protected` (Todos) | OK |
| 5 | `/cores` | `ModulePage (cores)` | Cadastros | Produtos | `cores` | `Protected` (Todos) | OK |
| 6 | `/colecoes` | `ModulePage (colecoes)` | Cadastros | Produtos | `colecoes` | `Protected` (Todos) | OK |
| 7 | `/grades` | `ModulePage (grades)` | Cadastros | Produtos | `grades` | `Protected` (Todos) | OK |
| 8 | `/tamanhos` | `ModulePage (tamanhos)` | Cadastros | Produtos | `tamanhos` | `Protected` (Todos) | OK |
| 9 | `/medidas` | `MedidasPage` | Cadastros | Produtos | `medidas` | `Protected` (Todos) | OK |
| 10 | `/insumos` | `ModulePage (insumos)` | Cadastros | Materiais | `insumos` | `Protected` (Todos) | OK |
| 11 | `/clientes` | `ModulePage (clientes)` | Cadastros | Pessoas | `clientes` | `Protected` (Todos) | OK |
| 12 | `/fornecedores` | `ModulePage (fornecedores)` | Cadastros | Pessoas | `fornecedores` | `Protected` (Todos) | OK |
| 13 | `/representantes` | `ModulePage (representantes)` | Cadastros | Pessoas | `representantes` | `Protected` (Todos) | OK |
| 14 | `/vendas` | `ModulePage (vendas)` | Vendas | Comercial | `vendas` | `Protected` (Todos) | OK |
| 15 | `/propostas` | `ModulePage (propostas)` | Vendas | Comercial | `propostas` | `Protected` (Todos) | OK |
| 16 | `/catalogos` | `ModulePage (catalogos)` | Vendas | Comercial | `catalogos` | `Protected` (Todos) | OK |
| 17 | `/politicas-comerciais` | `ModulePage (politicas-comerciais)` | Vendas | Comercial | `politicas_comerciais` | `ModuleAccess` (`gerente` + `politicas`) | OK |
| 18 | `/listas-preco` | `ModulePage (listas-preco)` | Vendas | Comercial | `listas_preco` | `ModuleAccess` (`gerente`) | OK |
| 19 | `/pdv` | `PdvPage` | Vendas | Balcão | `/api/pdv/*` | `ModuleAccess` (Todos; caixa: `gerente`) | OK |
| 20 | `/pdv-caixas` | `ModulePage (pdv-caixas)` | Vendas | Balcão | `pdv_caixas` | `ModuleAccess` (`gerente`) | OK |
| 21 | `/expedicao` | `ExpedicaoPage` | Vendas | Atendimento e entrega | `ordens_separacao` | `ModuleAccess` (Todos) | OK |
| 22 | `/divergencias` | `ModulePage (divergencias)` | Vendas | Atendimento e entrega | `divergencias_expedicao` | `ModuleAccess` (`gerente`) | OK |
| 23 | `/envios` | `LogisticaPage` | Vendas | Atendimento e entrega | `envios` | `ModuleAccess` (`gerente`) | OK |
| 24 | `/devolucoes` | `DevolucoesPage` | Vendas | Pós-venda | `devolucoes` | `ModuleAccess` (Todos) | OK |
| 25 | `/estoque` | `EstoqueGradePage` | Estoque & Suprimentos | Estoque | `estoque_produtos` | `ModuleAccess` (Todos) | OK |
| 26 | `/movimentacoes` | `ModulePage (movimentacoes)` | Estoque & Suprimentos | Estoque | `movimentacoes` | `ModuleAccess` (Todos) | OK |
| 27 | `/inventario` | `InventarioModulePage` | Estoque & Suprimentos | Estoque | `inventarios` | `ModuleAccess` (Todos) | OK |
| 28 | `/locais` | `ModulePage (locais)` | Estoque & Suprimentos | Estoque | `locais_estoque` | `ModuleAccess` (Todos) | OK |
| 29 | `/compras` | `ModulePage (compras)` | Estoque & Suprimentos | Compras | `compras` | `ModuleAccess` (Todos) | OK |
| 30 | `/cotacoes-compra` | `CotacoesCompraPage` | Estoque & Suprimentos | Compras | `cotacoes_compra` | `ModuleAccess` (`gerente`) | OK |
| 31 | `/compra-recebimentos` | `ModulePage (compra-recebimentos)` | Estoque & Suprimentos | Compras | `compra_recebimentos` | `ModuleAccess` (Todos) | OK |
| 32 | `/importar-nfe-compra` | `ImportarNfePage` | Estoque & Suprimentos | Compras | `compras` (`/api/compras/importar-nfe`) | `ModuleAccess` (`gerente`) | OK |
| 33 | `/sugestao-compra` | `SugestaoCompraPage` | Estoque & Suprimentos | Compras | `insumos` (`/api/suprimentos/sugestao-compra`) | `ModuleAccess` (`gerente`) | OK |
| 34 | `/depara-fornecedor` | `ModulePage (depara-fornecedor)` | Estoque & Suprimentos | Compras | `fornecedor_insumo_depara` | `ModuleAccess` (`gerente`) | OK |
| 35 | `/planejamento-producao` | `PlanejamentoProducaoPage` | Produção | Planejamento | `/api/producao/planejamento` | `ModuleAccess` (Todos) | OK |
| 36 | `/ordens` | `ModulePage (ordens)` | Produção | Execução | `ordens_producao` | `ModuleAccess` (Todos) | OK |
| 37 | `/fichas` | `ModulePage (fichas)` | Produção | Engenharia | `fichas_tecnicas` | `ModuleAccess` (Todos) | OK |
| 38 | `/custo` | `CustoPage` | Produção | Engenharia | `/api/fichas` | `ModuleAccess` (Todos) | OK |
| 39 | `/financeiro` | `FinanceiroPage` | Financeiro | Operação financeira | `/api/financeiro/*` | `ModuleAccess` (`gerente`) | OK |
| 40 | `/lancamentos` | `ModulePage (lancamentos)` | Financeiro | Operação financeira | `lancamentos_financeiros` | `ModuleAccess` (`gerente`) | OK |
| 41 | `/contas-financeiras` | `ModulePage (contas-financeiras)` | Financeiro | Tesouraria | `contas_financeiras` | `ModuleAccess` (`gerente`) | OK |
| 42 | `/transferencias` | `ModulePage (transferencias)` | Financeiro | Tesouraria | `transferencias_financeiras` | `ModuleAccess` (`gerente`) | OK |
| 43 | `/comissoes` | `ComissoesPage` | Financeiro | Comissões | `comissoes` | `ModuleAccess` (`gerente`) | OK |
| 44 | `/investidores` | `ModulePage (investidores)` | Financeiro | Capital | `investidores` | `ModuleAccess` (`gerente`) | OK |
| 45 | `/aportes` | `ModulePage (aportes)` | Financeiro | Capital | `aportes_financeiros` | `ModuleAccess` (`gerente`) | OK |
| 46 | `/categorias-financeiras` | `ModulePage (categorias-financeiras)` | Financeiro | Parâmetros financeiros | `categorias_financeiras` | `ModuleAccess` (`gerente`) | OK |
| 47 | `/centros-custo` | `ModulePage (centros-custo)` | Financeiro | Parâmetros financeiros | `centros_custo` | `ModuleAccess` (`gerente`) | OK |
| 48 | `/recorrencias-financeiras` | `ModulePage (recorrencias-financeiras)` | Financeiro | Parâmetros financeiros | `recorrencias_financeiras` | `ModuleAccess` (`gerente`) | OK |
| 49 | `/documentos-fiscais` | `ModulePage (documentos-fiscais)` | Fiscal | Operação fiscal | `documentos_fiscais` | `ModuleAccess` (`gerente`) | OK |
| 50 | `/inutilizacoes` | `InutilizacoesPage` | Fiscal | Operação fiscal | `inutilizacoes_fiscais` | `ModuleAccess` (`gerente`) | OK |
| 51 | `/regras-fiscais` | `ModulePage (regras-fiscais)` | Fiscal | Parâmetros fiscais | `regras_fiscais` | `ModuleAccess` (`gerente`) | OK |
| 52 | `/ncm` | `NcmPage` | Fiscal | Parâmetros fiscais | `regras_ncm` | `ModuleAccess` (`gerente`) | OK |
| 53 | `/empresas` | `EmpresasPage` | Administração | Organização e acesso | `/api/empresas/*` | `AdminOnly` (`admin`) | OK |
| 54 | `/usuarios` | `UsuariosPage` | Administração | Organização e acesso | `users` | `AdminOnly` (`admin`) | OK |
| 55 | `/auditoria` | `ModulePage (auditoria)` | Administração | Governança | `audit_log` | `ModuleAccess` (`adminOnly`) | OK |
| 56 | `/webhooks` | `WebhooksPage` | Administração | Automações | `/api/webhooks/*` | `AdminOnly` (`admin`) | OK |
| 57 | `/conectores/mercado-livre` | `ConectorPage (mercadolivre)` | Commerce | Canais | `/api/conectores/mercadolivre/*` | `ModuleAccess` (`gerente`) | OK |
| 58 | `/conectores/mercado-pago` | `ConectorPage (mercadopago)` | Commerce | Canais | `/api/conectores/mercadopago/*` | `ModuleAccess` (`gerente`) | OK |
| 59 | `/conectores/nuvemshop` | `ConectorPage (nuvemshop)` | Commerce | Canais | `/api/conectores/nuvemshop/*` | `ModuleAccess` (`gerente`) | OK |
| 60 | `/conectores/instagram` | `ConectorPage (instagram)` | Commerce | Canais | `/api/conectores/instagram/*` | `ModuleAccess` (`gerente`) | OK |
| 61 | `/commerce/produtos` | `CommerceModulePage` | Commerce | Multicanal | — (`planned`) | `ModuleAccess` (Todos) | OK |
| 62 | `/commerce/pedidos` | `CommerceModulePage` | Commerce | Multicanal | — (`planned`) | `ModuleAccess` (Todos) | OK |
| 63 | `/commerce/trends` | `CommerceModulePage` | Commerce | Multicanal | — (`planned`) | `ModuleAccess` (Todos) | OK |
| 64 | `/commerce/delivery` | `CommerceModulePage` | Commerce | Multicanal | — (`planned`) | `ModuleAccess` (Todos) | OK |
| 65 | `/creators` | `CommerceModulePage` | Creators | Parcerias e campanhas | — (`planned`) | `ModuleAccess` (Todos) | OK |
| 66 | `/creator-matches` | `CommerceModulePage` | Creators | Parcerias e campanhas | — (`planned`) | `ModuleAccess` (Todos) | OK |
| 67 | `/outreach-ai` | `CommerceModulePage` | Creators | Parcerias e campanhas | — (`planned`) | `ModuleAccess` (Todos) | OK |
| 68 | `/campanhas` | `CommerceModulePage` | Creators | Parcerias e campanhas | — (`planned`) | `ModuleAccess` (Todos) | OK |
| 69 | `/config` | `Settings` | Utilidades Globais | Conta e suporte | `/api/settings/*` | `Protected` (Todos) | OK |
| 70 | `/ajuda` | `AjudaPage` | Utilidades Globais | Conta e suporte | — | `Protected` (Todos) | OK |
| 71 | `/produtos/:id` | `ProductDetail` | Cadastros | Produtos | `produtos`, `/api/produtos/:id/*` | `Protected` (Todos) | OK |
| 72 | `/fichas/:id` | `FichaDetail` | Produção | Engenharia | `fichas_tecnicas`, `/api/fichas/:id/*` | `Protected` (Todos) | OK |
| 73 | `/ordens/:id` | `OrdemDetail` | Produção | Execução | `ordens_producao`, `/api/ordens/:id/*` | `Protected` (Todos) | OK |
| 74 | `/compras/:id` | `OrderPage (compra)` | Estoque & Suprimentos | Compras | `compras`, `/api/compras/:id/*` | `Protected` (Todos) | OK |
| 75 | `/vendas/:id` | `OrderPage (venda)` | Vendas | Comercial | `vendas`, `/api/vendas/:id/*` | `Protected` (Todos) | OK |
| 76 | `/settings` | `Navigate to="/config" replace` | Utilidades Globais | Conta e suporte | — (redirect legado) | `Protected` (Todos) | OK |
| 77 | `/ui-kit` | `ComponentCatalog` | — | — | — (DEV only) | Pública (DEV) | OK |
| 78 | `/login` | `Login` | — | — | `/api/auth/login` | Pública | OK |
| 79 | `/esqueci-senha` | `ForgotPassword` | — | — | `/api/auth/forgot-password` | Pública | OK |
| 80 | `/redefinir-senha` | `ResetPassword` | — | — | `/api/auth/reset-password` | Pública | OK |
| 81 | `/convite/:token` | `Convite` | — | — | `/api/auth/convite/:token` | Pública | OK |
| 82 | `/catalogo/:token` / `/portal/:token` / `*` | `CatalogoPublico` / `PortalCliente` / `Navigate to="/"` | — | — | `/api/publico/*` | Pública / Fallback | OK |

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
