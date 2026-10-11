# RELATÓRIO — ERP-UX-01 · AUDITORIA DO MENU, SHELL E NAVEGAÇÃO

**Repositório auditado:** `petrickmsilva-alt/brobond-erp`
**Branch de auditoria:** `arena/f2c2845a-brobond-erp` (a partir de `649e0462`, que é o **HEAD atual da `main`** — confirmado por `git ls-remote origin`)
**Data:** 2026-10-11
**Modo:** **AUDITORIA SOMENTE — READ-ONLY.** Nenhum arquivo de produção foi criado, alterado, movido ou removido. Nenhum PR. Nenhum merge. Nenhum efeito sobre o repositório `brobond-ai-commerce` (não foi lido, citado nem acessado).
**Único artefato produzido:** este documento (`docs/RELATORIO-ERP-UX-01.md`).

### Como esta auditoria foi feita (método e limites)

| Técnica | O que foi executado | Resultado |
|---|---|---|
| Leitura integral da camada de navegação | `App.tsx`, `main.tsx`, `Layout.tsx`, `Sidebar.tsx`, `CommandPalette.tsx`, `CompanySwitcher.tsx`, `AuthContext.tsx`, `modules.ts`, `ModulePage.tsx` | conforme este relatório |
| Varredura de duplicidade/legado | `grep` exaustivo por `<aside>`, `<nav>`, `Outlet`, `group:`, `label:`, arrays de navegação, service worker, `Breadcrumb` | nenhum segundo shell/menu |
| **Reprodução da Sidebar em jsdom** (execução do componente real, fora do repositório, via vitest com config em `/tmp`) | `Sidebar` renderizada para `admin`, `gerente` e `operador`; `Layout` renderizado em `/`, `/produtos/12`, `/documentos-fiscais`, `/ncm` | **12 grupos / 66 itens** (admin), 12/62 (gerente), 10/42 (operador); header em `/` = **“Dashboard”** |
| Gate existente | `npm run audit:menu` (`scripts/auditar-menu.ts`) | 0 erros · 4 avisos classificados (ver §H) |
| Build real | `npm run build` | ✅ verde · bundle principal 320,95 kB (95,53 kB gzip) · PWA `generateSW` · **59 entradas de precache** (`dist/sw.js`, `dist/registerSW.js`) — artefato de build removido depois da leitura |
| Testes de front | `npm --workspace client test` | ✅ **26 arquivos · 262 testes passam** |
| Histórico da navegação | GitHub API (`gh api`) por caminho de arquivo | última alteração de `Sidebar.tsx`: **2026-10-08**; de `modules.ts`: **2026-10-11** (ver §A) |
| **Limites declarados** | Não houve navegador (o sandbox não instala Chromium: CDN bloqueado) nem acesso ao ambiente publicado; nenhum arquivo foi tocado | **Nada neste relatório é impressão visual.** Todo achado tem arquivo/linha ou execução citada. O que não pôde ser provado está escrito como tal. |

---

## A. RESUMO EXECUTIVO

### A.1 A pergunta: **“Por que o usuário ainda vê o menu antigo?”**

**Resposta em uma frase:** o menu que o usuário vê hoje é, **na letra do código, o menu atual do repositório** — e é “antigo” porque **a nova estrutura nunca foi escrita nele**: existem **um único shell** e **um único menu** em `main`, o menu é montado por **três listas fixas dentro do `Sidebar`** (não pela estrutura declarada em `modules.ts`), e a evolução mais recente da navegação (**o grupo Fiscal da ERP-05, de 2026-10-11**) **não foi ligada no renderizador** — os quatro módulos fiscais têm rota, tela, API, RBAC e teste, e **não aparecem para ninguém**.

**Duas causas comprovadas pelo repositório (P0):**

1. **O grupo `Fiscal` foi declarado e nunca renderizado.** `modules.ts:284-321` declara 13 áreas (`MODULE_GROUPS` + `GROUP_META`) incluindo `Fiscal`; `Sidebar.tsx:25-38` define **as suas próprias três listas** (`ERP_GROUPS` sem `Fiscal`, `COMMERCE_GROUPS`, `SYSTEM_GROUPS`) e renderiza somente a partir delas. Resultado medido por execução do componente: **12 grupos / 66 itens** para admin — `Documentos fiscais`, `Regras fiscais`, `NCM / Tributação` e `Inutilizações` **não existem na barra lateral**, embora existam em `/documentos-fiscais`, `/regras-fiscais`, `/ncm`, `/inutilizacoes` (`App.tsx:83-86` gera rota de todo módulo).
   **Quando isso nasceu (histórico provado):** `Sidebar.tsx` foi alterado pela última vez em **2026-10-08** (`6cc5ee32`, “navegação por áreas de negócio”); o grupo Fiscal entrou em **2026-10-11** (`876c46c4`, ERP-05), que alterou `client/src/modules.ts`, `client/src/modules.test.ts`, `ModulePage.tsx` e as telas novas — **e não tocou `Sidebar.tsx`**. A evolução do ERP e a evolução do menu se separaram nesse commit.

2. **Os gates existentes não enxergam o renderizador.** `scripts/auditar-menu.ts:97-101` valida os grupos contra `MODULE_GROUPS` (a *declaração*), e `modules.test.ts` faz o mesmo — nenhum dos dois lê as listas do `Sidebar`. Também **não existe um único teste que renderize o `Sidebar` ou o `Layout`** (26 arquivos de teste no front; 0 tocam o menu). Por isso o gate sai **verde** (`✅ Sem erros`, 4 avisos) enquanto a interface diverge do código: *o menu pôde ficar “antigo” sem quebrar nenhum teste.*

**Sinais de “menu antigo” visíveis na tela (comprovados por renderização do `Layout`):**

| Tela | Texto renderizado no header | Fonte |
|---|---|---|
| `/` (primeira tela após login) | `BROBOND ERP` → **`Dashboard`** | `Layout.tsx:86` |
| `/documentos-fiscais` | `BROBOND ERP` → **`Fiscal`** → `Documentos fiscais` | `Layout.tsx:78-84` (usa `MODULES`) |
| Busca global (Ctrl+K) | item **`Dashboard`** | `CommandPalette.tsx:65` |
| Atalho do app instalado (PWA) | **`Dashboard`** | `client/public/manifest.json` (`shortcuts`) |
| Comentário de contrato | `/** null = item de topo (Dashboard) */` | `modules.ts:60` |

Ou seja: **o corpo da página e a barra lateral já se chamam “Meu Negócio” (`modules.ts:87`, `Dashboard.tsx:147-148`), mas a moldura da primeira tela ainda se chama “Dashboard”** — o usuário abre o sistema e lê o nome antigo em cima do nome novo.

**E o “menu novo” que o usuário espera?** A arquitetura de navegação da especificação técnica (1. Meu Negócio/BI · 2. Cadastros · 3. Vendas · 4. Estoque & Suprimentos · 5. Financeiro · 6. Configurações/Administração + transversais) **não existe em nenhum lugar de `main`**. O que está renderizado é a estrutura da “Fase 3 (sidebar em 8 categorias)” de 2026-10-05 mais a seção Commerce/Integrações de 2026-10-06/08. Não há *feature flag*, *A/B*, variável de ambiente ou segundo componente: **não há menu novo para aparecer.**

**O que NÃO foi possível comprovar pelo repositório (declarado, não suposto):**

* **“Não comprovado”**: que o navegador do usuário esteja exibindo um *bundle antigo* por cache do **service worker** ou por *deploy* de um commit diferente do `main` HEAD. O repositório prova que existem os vetores (PWA com precache de `index.html` + `registerSW.js` injetado no `index.html`; um `client/src/sw.ts` **manual e órfão**, com política *stale-while-revalidate* para `.js/.css` — ver §F.1), mas não prova que é isso que o usuário está vendo. **Como confirmar em 2 minutos:** abrir DevTools → *Application* → *Service Workers / Cache Storage*; *Network* → desabilitar cache e recarregar; conferir o hash do bundle (`/assets/index-<hash>.js`) e comparar com o build de `649e0462` (`index-LEZha2hD.js` neste ambiente). Alternativa: abrir em janela anônima.
* **“Não foi possível confirmar o artefato atualmente em produção somente pelo repositório.”** (ver §J)

### A.2 Resposta curta às perguntas do ciclo

| # | Pergunta | Resposta |
|---|---|---|
| 1 | Qual componente raiz do shell? | `Layout` (`client/src/components/Layout.tsx`), montado pela rota protegida `/` em `App.tsx:63-72` |
| 2 | Qual componente renderiza o menu? | `Sidebar` (`client/src/components/Sidebar.tsx`), importado só por `Layout.tsx:4` |
| 3 | Qual layout envolve as páginas autenticadas? | Um só: o `Layout` (não existe `Layout` alternativo, nem flag) |
| 4 | Qual rota é carregada após o login? | `/` → `Dashboard` (`App.tsx:75`) — “Meu Negócio” |
| 5 | Quem responde pelo `/`? | `pages/Dashboard.tsx` (título interno **“Meu Negócio”**, `Dashboard.tsx:147-148`) |
| 6 | Existe mais de um layout? | **Não** (1) |
| 7 | Existe mais de um sidebar/menu? | **Não** em componente; **sim** em configuração de grupos (3 listas no `Sidebar` × `MODULE_GROUPS`/`GROUP_META` em `modules.ts`) |
| 8 | Existe menu legado? | Não como componente. Legado **dentro** do menu atual: rótulos (“Dashboard”), 8 entradas `planned` sem funcionalidade, 2 rótulos duplicados, grupo declarado fora do ar |
| 9 | Existe menu novo? | **Não implementado** (nem oculto, nem atrás de flag) |
| 10 | Flags/condições que escolhem o menu? | Só duplicidade de código-fonte; em runtime: perfil (`visibleModules`), `localStorage` de grupos abertos/colapso, largura de viewport |
| 11 | Componentes mortos ligados ao menu? | `client/src/sw.ts` (SW manual órfão), `PAGES_ESPECIAIS` e `findModuleByResource` (exports sem uso), `MODULE_GROUPS` (só os testes consomem), `Breadcrumb`/`Drawer`/`Tooltip` do UI kit sem uso |
| 12 | Código de menu duplicado? | Sim: 3 listas de grupos no `Sidebar` + `MODULE_GROUPS` + `GROUP_META`; e a lógica “qual módulo é a rota atual” escrita **duas vezes** (`Layout.tsx:35-38` e `Sidebar.tsx:68-70`) |

---

## B. ARQUITETURA ATUAL (diagrama textual)

```
ENTRYPOINT
  client/index.html                          (tema dark antes do paint; manifest; registerSW.js injetado no build)
    └─ client/src/main.tsx                   (applyStoredTheme)
         └─ ErrorBoundary → ToastProvider → AuthProvider  (auth/AuthContext.tsx:38)
              └─ App.tsx  ── BrowserRouter
                   └─ Suspense (Loading)
                        ├── ROTAS PÚBLICAS (sem shell)
                        │     /login ............... pages/Login.tsx
                        │     /esqueci ............. pages/ForgotReset.tsx (ForgotPage)
                        │     /redefinir/:token .... pages/ForgotReset.tsx (ResetPage)
                        │     /convite/:token ...... pages/Convite.tsx
                        │     /catalogo/:token ..... pages/CatalogoPublico.tsx
                        │     /portal/:token ....... pages/PortalCliente.tsx
                        │
                        └── ROTA PROTEGIDA  "/"   → <Protected> (App.tsx:37-48)
                              │     loading → <Loading/>
                              │     !user   → <Navigate to="/login" replace/>
                              │     !meta   → <Loading/>
                              │     user.trocar_senha → /config?trocar=1
                              └── SHELL: <Layout/>  (App.tsx:63-72 · Layout.tsx:56)
                                   ├── <Sidebar/>            ← MENU (Layout.tsx:4,57)
                                   │     • visibleModules(user)  (modules.ts:337)
                                   │     • ERP_GROUPS (8) | COMMERCE_GROUPS (3) | SYSTEM_GROUPS (1)
                                   │     • accordions abertos persistidos em localStorage
                                   │     • colapso (trilho de ícones) em localStorage
                                   │     • rodapé: "BROBOND ERP v<meta.version>" + selo DEMO   ← versão do SERVIDOR
                                   ├── <header/> sticky      (Layout.tsx:70-148)
                                   │     • botão hambúrguer (mobile) → abre o drawer
                                   │     • "trilha": BROBOND ERP / <grupo> / <label>   ·  em "/" mostra "Dashboard"
                                   │     • <CompanySwitcher/>  (empresa ativa / consolidado)
                                   │     • busca global (Ctrl/⌘+K) → <CommandPalette/>
                                   │     • menu do usuário: Minha conta · Trocar senha · Sair
                                   ├── <main id="conteudo-principal">  (skip-link "Pular para o conteúdo", Layout.tsx:64-69)
                                   │     └── <div key={escopoVersao}> → <Outlet/>     ← trocar de empresa REMONTA a tela
                                   │            ├── index  "/"        → pages/Dashboard.tsx      [Meu Negócio]
                                   │            ├── "config"          → pages/Settings.tsx
                                   │            ├── "produtos/:id"    → ProductDetail
                                   │            ├── "vendas/:id"      → OrderPage(tipo=venda)
                                   │            ├── "compras/:id"     → OrderPage(tipo=compra)
                                   │            ├── "ordens/:id"      → OrdemDetail
                                   │            ├── "fichas/:id"      → FichaDetail
                                   │            ├── "dev/componentes" → <AdminOnly> ComponentCatalog
                                   │            ├── 68 rotas geradas de MODULES (path.replace('/', ''))
                                   │            └── "*"               → <Navigate to="/" replace/>
                                   └── <CommandPalette/>  (mesma visibleModules)

API / SERVIDOR
  server/src/index.ts
    • app.use('/api', wrap(requireAuth))                      ← gargalo de autenticação (linha ~321)
    • rotas públicas declaradas antes: auth, convite, portal, catálogo, arquivo com token, health, webhooks
    • app.use(express.static(client/dist, { maxAge: '1h' })) + catch-all sendFile(index.html)   (index.ts:861-865)
    • /api/meta  → { resources, mode, version, user }   (fonte do formulário/CRUD e do rodapé do Sidebar)
  server/src/services.ts
    • checkAccess(r, actor, op)  (linha 141) → PERFIL_RANK, r.minPerfil, r.adminOnly, r.ops, permissões comerciais
    • checkFluxo(r, actor)       (linha 176) → alçada dos endpoints de fluxo
  server/src/empresa.ts → escopo por empresa (claim `emp` revalidada; 404 entre empresas; modo consolidado)

ESTADO (React)
  AuthContext (user, meta, login/MFA, logout)  ·  MetaContext (resources/mode/version)
  CompanySwitcher → POST /api/empresas/ativa → novo token → Layout remonta o conteúdo (key={escopoVersao})
```

**Conclusões estruturais do mapeamento**

* **Um shell, um menu, um router.** Não existe shell paralelo, menu legado em componente, rota antiga concorrente, `HashRouter` alternativo, nem segundo entrypoint (`find . -name "*.html"` retorna somente `client/index.html`).
* **A autoridade do menu é do cliente.** O servidor não envia a navegação; ele envia `resources` em `/api/meta` e aplica RBAC por recurso. O menu é um artefato 100% front-end (`modules.ts` + `Sidebar.tsx`).
* **O `Sidebar` não consome `MODULE_GROUPS`.** Ele decide ordem, seção e presença de grupo por três constantes locais (`Sidebar.tsx:25,36,38`) — este é o ponto único de divergência entre “menu declarado” e “menu renderizado”.
* **A resolução “qual item do menu corresponde a esta URL” está duplicada** (`Layout.tsx:35-38` para o título da aba e a trilha; `Sidebar.tsx:68-70` para abrir/realçar o grupo). Duas implementações da mesma regra: qualquer mudança de rota exige lembrar das duas.

---

## C. MENU ATUAL — o que REALMENTE é renderizado

Fonte: `client/src/components/Sidebar.tsx` (listas `ERP_GROUPS`, `COMMERCE_GROUPS`, `SYSTEM_GROUPS`)
× `client/src/modules.ts` (`MODULES`, 70 entradas).

### C.1 Árvore renderizada (admin), reproduzida por execução do componente

```
Meu Negócio  →  /            (item de topo, group: null)
Cadastros   (8)
   ├─ Produtos  [/produtos]
   ├─ Categorias  [/categorias]
   ├─ Cores  [/cores]
   ├─ Insumos  [/insumos]
   ├─ Tamanhos  [/tamanhos]
   ├─ Grade  [/grades]
   ├─ Tabela de Medidas  [/medidas]
   ├─ Coleções  [/colecoes]
Vendas   (9)
   ├─ Vendas  [/vendas]
   ├─ Políticas comerciais  [/politicas-comerciais]
   ├─ Clientes  [/clientes]
   ├─ Representantes  [/representantes]
   ├─ Catálogos públicos  [/catalogos]
   ├─ Listas de preço  [/listas-preco]
   ├─ Propostas comerciais  [/propostas]
   ├─ Caixas do PDV  [/pdv-caixas]
   ├─ PDV — venda balcão  [/pdv]
Compras   (7)
   ├─ Compras  [/compras]
   ├─ Fornecedores  [/fornecedores]
   ├─ Cotação de compra  [/cotacoes-compra]
   ├─ Recebimentos de compra  [/compra-recebimentos]
   ├─ Importar NF-e de entrada  [/importar-nfe-compra]
   ├─ De-Para de produtos  [/depara-fornecedor]
   ├─ Sugestão de compra  [/sugestao-compra]
Estoque   (4)
   ├─ Estoque Físico  [/estoque]
   ├─ Movimentações  [/movimentacoes]
   ├─ Locais de Estoque  [/locais]
   ├─ Inventário  [/inventario]
Produção   (4)
   ├─ Ficha Técnica / BOM  [/fichas]
   ├─ Cadeias de Fabricação  [/ordens]
   ├─ Planejamento de Produção  [/planejamento-producao]
   ├─ Custos  [/custo]
Logística & Expedição   (4)
   ├─ Expedição  [/expedicao]
   ├─ Divergências de conferência  [/divergencias]
   ├─ Logística e envios  [/envios]
   ├─ Devoluções e reversa  [/devolucoes]
Financeiro   (10)
   ├─ Financeiro  [/financeiro]
   ├─ Lançamentos  [/lancamentos]
   ├─ Categorias  [/categorias-financeiras]
   ├─ Contas  [/contas-financeiras]
   ├─ Transferências  [/transferencias]
   ├─ Centros de custo  [/centros-custo]
   ├─ Investidores / Sócios  [/investidores]
   ├─ Aportes  [/aportes]
   ├─ Comissões  [/comissoes]
   ├─ Recolhimentos e recorrências  [/recorrencias-financeiras]
Relatórios   (1)
   ├─ Relatórios  [/relatorios]
Commerce / Integrações  (seção separada)
   Integrações  (5)
      ├─ Mercado Livre  [/conectores/mercado-livre]
      ├─ Mercado Pago  [/conectores/mercado-pago]
      ├─ Nuvemshop  [/conectores/nuvemshop]
      ├─ Instagram Shopping  [/conectores/instagram]
      ├─ Webhooks  [/webhooks]
   Gestão de Commerce  (4)
      ├─ Produtos  [/commerce/produtos]
      ├─ Pedidos  [/commerce/pedidos]
      ├─ Trends  [/commerce/trends]
      ├─ 📦 Delivery  [/commerce/delivery]
   Ecossistema Creators  (4)
      ├─ Creators  [/creators]
      ├─ Matches  [/matches]
      ├─ Outreach AI  [/outreach-ai]
      ├─ Campanhas  [/campanhas]
Configurações  (5)
   ├─ Empresas  [/empresas]
   ├─ Usuários  [/usuarios]
   ├─ Auditoria  [/auditoria]
   ├─ Configurações  [/config]
   ├─ Ajuda  [/ajuda]
════════════════════════════════════════════════════════════
Fiscal   (4)  ← DECLARADO em modules.ts / MODULE_GROUPS / GROUP_META / modules.test.ts
               e NUNCA renderizado: não está em nenhuma das 3 listas do Sidebar.
   ✗─ Documentos fiscais  [/documentos-fiscais]
   ✗─ Regras fiscais  [/regras-fiscais]
   ✗─ NCM / Tributação  [/ncm]
   ✗─ Inutilizações  [/inutilizacoes]
```

### C.2 Tabela completa dos 70 itens

| # | Grupo (declarado) | Item (label) | Rota | Ícone | Permissão exigida | Origem da config | Renderizado no Sidebar? | Status |
|---|---|---|---|---|---|---|---|---|
| 1 | Meu Negócio (topo) | Meu Negócio | `/` | LayoutDashboard | — (RBAC do recurso) | `modules.ts` | sim | [ATIVO] |
| 2 | Cadastros | Produtos | `/produtos` | Shirt | — (RBAC do recurso) | `modules.ts` | sim | [ATIVO] |
| 3 | Cadastros | Categorias | `/categorias` | Layers | — (RBAC do recurso) | `modules.ts` | sim | [ATIVO] |
| 4 | Cadastros | Cores | `/cores` | Palette | — (RBAC do recurso) | `modules.ts` | sim | [ATIVO] |
| 5 | Cadastros | Insumos | `/insumos` | Scissors | — (RBAC do recurso) | `modules.ts` | sim | [ATIVO] |
| 6 | Cadastros | Tamanhos | `/tamanhos` | Ruler | — (RBAC do recurso) | `modules.ts` | sim | [ATIVO] |
| 7 | Cadastros | Grade | `/grades` | LayoutGrid | — (RBAC do recurso) | `modules.ts` | sim | [ATIVO] |
| 8 | Cadastros | Tabela de Medidas | `/medidas` | Ruler | — (RBAC do recurso) | `modules.ts` | sim | [ATIVO] |
| 9 | Cadastros | Coleções | `/colecoes` | Tags | — (RBAC do recurso) | `modules.ts` | sim | [ATIVO] |
| 10 | Vendas | Vendas | `/vendas` | Receipt | — (RBAC do recurso) | `modules.ts` | sim | [ATIVO] |
| 11 | Vendas | Políticas comerciais | `/politicas-comerciais` | Tags | minPerfil=gerente | `modules.ts` | sim | [ATIVO] |
| 12 | Vendas | Clientes | `/clientes` | Store | — (RBAC do recurso) | `modules.ts` | sim | [ATIVO] |
| 13 | Vendas | Representantes | `/representantes` | Handshake | — (RBAC do recurso) | `modules.ts` | sim | [ATIVO] |
| 14 | Vendas | Catálogos públicos | `/catalogos` | Share2 | — (RBAC do recurso) | `modules.ts` | sim | [ATIVO] |
| 15 | Vendas | Listas de preço | `/listas-preco` | Tags | minPerfil=gerente | `modules.ts` | sim | [ATIVO] |
| 16 | Vendas | Propostas comerciais | `/propostas` | FileText | — (RBAC do recurso) | `modules.ts` | sim | [ATIVO] |
| 17 | Vendas | Caixas do PDV | `/pdv-caixas` | CreditCard | minPerfil=gerente | `modules.ts` | sim | [ATIVO] |
| 18 | Vendas | PDV — venda balcão | `/pdv` | Receipt | — (RBAC do recurso) | `modules.ts` | sim | [ATIVO] |
| 19 | Compras | Compras | `/compras` | ShoppingCart | — (RBAC do recurso) | `modules.ts` | sim | [ATIVO] |
| 20 | Compras | Fornecedores | `/fornecedores` | Factory | — (RBAC do recurso) | `modules.ts` | sim | [ATIVO] |
| 21 | Compras | Cotação de compra | `/cotacoes-compra` | Scale | — (RBAC do recurso) | `modules.ts` | sim | [ATIVO] |
| 22 | Compras | Recebimentos de compra | `/compra-recebimentos` | Warehouse | — (RBAC do recurso) | `modules.ts` | sim | [ATIVO] |
| 23 | Compras | Importar NF-e de entrada | `/importar-nfe-compra` | FileUp | minPerfil=gerente | `modules.ts` | sim | [ATIVO] |
| 24 | Compras | De-Para de produtos | `/depara-fornecedor` | ArrowLeftRight | — (RBAC do recurso) | `modules.ts` | sim | [ATIVO] |
| 25 | Compras | Sugestão de compra | `/sugestao-compra` | Calculator | minPerfil=gerente | `modules.ts` | sim | [ATIVO] |
| 26 | Estoque | Estoque Físico | `/estoque` | Warehouse | — (RBAC do recurso) | `modules.ts` | sim | [ATIVO] |
| 27 | Estoque | Movimentações | `/movimentacoes` | ArrowLeftRight | — (RBAC do recurso) | `modules.ts` | sim | [ATIVO] |
| 28 | Estoque | Locais de Estoque | `/locais` | Building2 | — (RBAC do recurso) | `modules.ts` | sim | [ATIVO] |
| 29 | Estoque | Inventário | `/inventario` | ClipboardCheck | — (RBAC do recurso) | `modules.ts` | sim | [ATIVO] |
| 30 | Produção | Ficha Técnica / BOM | `/fichas` | ClipboardList | — (RBAC do recurso) | `modules.ts` | sim | [ATIVO] |
| 31 | Produção | Cadeias de Fabricação | `/ordens` | Cog | — (RBAC do recurso) | `modules.ts` | sim | [ATIVO] |
| 32 | Produção | Planejamento de Produção | `/planejamento-producao` | Factory | — (RBAC do recurso) | `modules.ts` | sim | [ATIVO] |
| 33 | Produção | Custos | `/custo` | Calculator | — (RBAC do recurso) | `modules.ts` | sim | [ATIVO] |
| 34 | Logística & Expedição | Expedição | `/expedicao` | ClipboardList | — (RBAC do recurso) | `modules.ts` | sim | [ATIVO] |
| 35 | Logística & Expedição | Divergências de conferência | `/divergencias` | ClipboardCheck | — (RBAC do recurso) | `modules.ts` | sim | [ATIVO] |
| 36 | Logística & Expedição | Logística e envios | `/envios` | Truck | minPerfil=gerente | `modules.ts` | sim | [ATIVO] |
| 37 | Logística & Expedição | Devoluções e reversa | `/devolucoes` | Repeat | — (RBAC do recurso) | `modules.ts` | sim | [ATIVO] |
| 38 | Financeiro | Financeiro | `/financeiro` | Wallet | minPerfil=gerente | `modules.ts` | sim | [ATIVO] |
| 39 | Financeiro | Lançamentos | `/lancamentos` | Coins | minPerfil=gerente | `modules.ts` | sim | [ATIVO] |
| 40 | Financeiro | Categorias | `/categorias-financeiras` | CircleDollarSign | minPerfil=gerente | `modules.ts` | sim | [ATIVO] |
| 41 | Financeiro | Contas | `/contas-financeiras` | Landmark | minPerfil=gerente | `modules.ts` | sim | [ATIVO] |
| 42 | Financeiro | Transferências | `/transferencias` | ArrowRightLeft | minPerfil=gerente | `modules.ts` | sim | [ATIVO] |
| 43 | Financeiro | Centros de custo | `/centros-custo` | ChartPie | minPerfil=gerente | `modules.ts` | sim | [ATIVO] |
| 44 | Financeiro | Investidores / Sócios | `/investidores` | PiggyBank | minPerfil=gerente | `modules.ts` | sim | [ATIVO] |
| 45 | Financeiro | Aportes | `/aportes` | Wallet | minPerfil=gerente | `modules.ts` | sim | [ATIVO] |
| 46 | Financeiro | Comissões | `/comissoes` | BadgeDollarSign | minPerfil=gerente | `modules.ts` | sim | [ATIVO] |
| 47 | Financeiro | Recolhimentos e recorrências | `/recorrencias-financeiras` | Repeat | minPerfil=gerente | `modules.ts` | sim | [ATIVO] |
| 48 | Relatórios | Relatórios | `/relatorios` | ChartColumn | — (RBAC do recurso) | `modules.ts` | sim | [ATIVO] |
| 49 | Integrações | Mercado Livre | `/conectores/mercado-livre` | ShoppingBag | minPerfil=gerente | `modules.ts` | sim | [ATIVO] |
| 50 | Integrações | Mercado Pago | `/conectores/mercado-pago` | CreditCard | minPerfil=gerente | `modules.ts` | sim | [ATIVO] |
| 51 | Integrações | Nuvemshop | `/conectores/nuvemshop` | Cloud | minPerfil=gerente | `modules.ts` | sim | [ATIVO] |
| 52 | Integrações | Instagram Shopping | `/conectores/instagram` | Instagram | minPerfil=gerente | `modules.ts` | sim | [ATIVO] |
| 53 | Integrações | Webhooks | `/webhooks` | Webhook | adminOnly (admin) | `modules.ts` | sim | [ATIVO] |
| 54 | Gestão de Commerce | Produtos | `/commerce/produtos` | Package | — (RBAC do recurso) | `modules.ts` | sim | [SEM FUNCIONALIDADE / planned] |
| 55 | Gestão de Commerce | Pedidos | `/commerce/pedidos` | ShoppingCart | — (RBAC do recurso) | `modules.ts` | sim | [SEM FUNCIONALIDADE / planned] |
| 56 | Gestão de Commerce | Trends | `/commerce/trends` | TrendingUp | — (RBAC do recurso) | `modules.ts` | sim | [SEM FUNCIONALIDADE / planned] |
| 57 | Gestão de Commerce | 📦 Delivery | `/commerce/delivery` | Truck | — (RBAC do recurso) | `modules.ts` | sim | [SEM FUNCIONALIDADE / planned] |
| 58 | Ecossistema Creators | Creators | `/creators` | Users | — (RBAC do recurso) | `modules.ts` | sim | [SEM FUNCIONALIDADE / planned] |
| 59 | Ecossistema Creators | Matches | `/matches` | Handshake | — (RBAC do recurso) | `modules.ts` | sim | [SEM FUNCIONALIDADE / planned] |
| 60 | Ecossistema Creators | Outreach AI | `/outreach-ai` | Bot | — (RBAC do recurso) | `modules.ts` | sim | [SEM FUNCIONALIDADE / planned] |
| 61 | Ecossistema Creators | Campanhas | `/campanhas` | Megaphone | — (RBAC do recurso) | `modules.ts` | sim | [SEM FUNCIONALIDADE / planned] |
| 62 | Configurações | Empresas | `/empresas` | Building2 | minPerfil=admin | `modules.ts` | sim | [ATIVO] |
| 63 | Configurações | Usuários | `/usuarios` | Users | adminOnly (admin) | `modules.ts` | sim | [ATIVO] |
| 64 | Configurações | Auditoria | `/auditoria` | History | adminOnly (admin) | `modules.ts` | sim | [ATIVO] |
| 65 | Configurações | Configurações | `/config` | Settings | — (RBAC do recurso) | `modules.ts` | sim | [ATIVO] |
| 66 | Configurações | Ajuda | `/ajuda` | CircleQuestionMark | — (RBAC do recurso) | `modules.ts` | sim | [ATIVO] |
| 67 | Fiscal | Documentos fiscais | `/documentos-fiscais` | FileText | — (RBAC do recurso) | `modules.ts` | **NÃO** | [ÓRFÃO NO MENU] |
| 68 | Fiscal | Regras fiscais | `/regras-fiscais` | Scale | minPerfil=gerente | `modules.ts` | **NÃO** | [ÓRFÃO NO MENU] |
| 69 | Fiscal | NCM / Tributação | `/ncm` | Calculator | minPerfil=gerente | `modules.ts` | **NÃO** | [ÓRFÃO NO MENU] |
| 70 | Fiscal | Inutilizações | `/inutilizacoes` | FileMinus | minPerfil=gerente | `modules.ts` | **NÃO** | [ÓRFÃO NO MENU] |

### C.3 Comparação declaração × renderização (por perfil)

| Perfil | Módulos visíveis (`visibleModules`) | Renderizados no Sidebar | Invisíveis (grupo Fiscal) |
|---|---|---|---|
| admin | 70 | 66 | 4 |
| gerente | 66 | 62 | 4 |
| operador | 43 | 42 | 1 |

> Contagem reproduzida executando o componente em jsdom (`Sidebar` + `MemoryRouter`): 12 grupos, 66 links (admin); 12 grupos/62 links (gerente); 10 grupos/42 links (operador).

## D. ROTAS — inventário completo

Rotas declaradas em `client/src/App.tsx`. 6 públicas + 76 protegidas (68 de módulo + 7 telas + raiz) + 1 catch-all = **83 entradas**.

| ROTA | COMPONENTE | MÓDULO | MENU? | RBAC (cliente) | RBAC (servidor) | STATUS |
|---|---|---|---|---|---|---|
| `/login` | Login | — (pública) | n/a | nenhum | rota pública intencional | [PÚBLICA] |
| `/esqueci` | ForgotPage | — (pública) | n/a | nenhum | rota pública intencional | [PÚBLICA] |
| `/redefinir/:token` | ResetPage | — (pública) | n/a | nenhum | rota pública intencional | [PÚBLICA] |
| `/convite/:token` | Convite | — (pública) | n/a | nenhum | rota pública intencional | [PÚBLICA] |
| `/catalogo/:token` | CatalogoPublico | — (pública) | n/a | nenhum | rota pública intencional | [PÚBLICA] |
| `/portal/:token` | PortalCliente | — (pública) | n/a | nenhum | rota pública intencional | [PÚBLICA] |
| `/` (index) | `Dashboard` | dashboard | sim ("Meu Negócio") | — | /api/negocios/* autenticado | [ATIVO] |
| `/config` | `Settings` | config | sim (Configurações) | — | autenticado | [ATIVO] |
| `/produtos/:id` | `ProductDetail` | produtos | indireto (rota filha) | — | escopo de empresa | [ATIVO] |
| `/vendas/:id` | `OrderPage tipo="venda"` | vendas | indireto | — | checkFluxo | [ATIVO] |
| `/compras/:id` | `OrderPage tipo="compra"` | compras | indireto | — | checkFluxo | [ATIVO] |
| `/ordens/:id` | `OrdemDetail` | ordens | indireto | — | checkFluxo | [ATIVO] |
| `/fichas/:id` | `FichaDetail` | fichas | indireto | — | minPerfil=gerente no aplicar-preço | [ATIVO] |
| `/dev/componentes` | `ComponentCatalog` | — | **NÃO** (intencional) | `AdminOnly` | autenticado | [INTENCIONAL] |
| `/produtos` | ModulePage → ResourceCrud (CRUD genérico) | produtos | sim | — | recurso `produtos` | [ATIVO] |
| `/categorias` | ModulePage → ResourceCrud (CRUD genérico) | categorias | sim | — | recurso `categorias` | [ATIVO] |
| `/cores` | ModulePage → ResourceCrud (CRUD genérico) | cores | sim | — | recurso `cores` | [ATIVO] |
| `/insumos` | ModulePage → ResourceCrud (CRUD genérico) | insumos | sim | — | recurso `insumos` | [ATIVO] |
| `/tamanhos` | ModulePage → ResourceCrud (CRUD genérico) | tamanhos | sim | — | recurso `tamanhos` | [ATIVO] |
| `/grades` | ModulePage → ResourceCrud (CRUD genérico) | grades | sim | — | recurso `grades` | [ATIVO] |
| `/medidas` | MedidasPage | medidas | sim | — | endpoints de fluxo | [ATIVO] |
| `/colecoes` | ModulePage → ResourceCrud (CRUD genérico) | colecoes | sim | — | recurso `colecoes` | [ATIVO] |
| `/fichas` | ModulePage → ResourceCrud (CRUD genérico) | fichas | sim | — | recurso `fichas` | [ATIVO] |
| `/ordens` | ModulePage → ResourceCrud (CRUD genérico) | ordens | sim | — | recurso `ordens` | [ATIVO] |
| `/planejamento-producao` | PlanejamentoProducaoPage | planejamento-producao | sim | — | endpoints de fluxo | [ATIVO] |
| `/custo` | CustoPage | custo | sim | — | endpoints de fluxo | [ATIVO] |
| `/estoque` | EstoqueGradePage | estoque | sim | — | endpoints de fluxo | [ATIVO] |
| `/movimentacoes` | ModulePage → ResourceCrud (CRUD genérico) | movimentacoes | sim | — | recurso `movimentacoes` | [ATIVO] |
| `/locais` | ModulePage → ResourceCrud (CRUD genérico) | locais | sim | — | recurso `locais` | [ATIVO] |
| `/inventario` | InventarioModulePage | inventario | sim | — | endpoints de fluxo | [ATIVO] |
| `/conectores/mercado-livre` | ConectorPage | conector-mercadolivre | sim | minPerfil=gerente | endpoints de fluxo | [ATIVO] |
| `/conectores/mercado-pago` | ConectorPage | conector-mercadopago | sim | minPerfil=gerente | endpoints de fluxo | [ATIVO] |
| `/conectores/nuvemshop` | ConectorPage | conector-nuvemshop | sim | minPerfil=gerente | endpoints de fluxo | [ATIVO] |
| `/conectores/instagram` | ConectorPage | conector-instagram | sim | minPerfil=gerente | endpoints de fluxo | [ATIVO] |
| `/commerce/produtos` | CommerceModulePage | commerce-produtos | sim | — | endpoints de fluxo | [ROTA SEM FUNCIONALIDADE] |
| `/commerce/pedidos` | CommerceModulePage | commerce-pedidos | sim | — | endpoints de fluxo | [ROTA SEM FUNCIONALIDADE] |
| `/commerce/trends` | CommerceModulePage | commerce-trends | sim | — | endpoints de fluxo | [ROTA SEM FUNCIONALIDADE] |
| `/commerce/delivery` | CommerceModulePage | commerce-delivery | sim | — | endpoints de fluxo | [ROTA SEM FUNCIONALIDADE] |
| `/creators` | CommerceModulePage | creators | sim | — | endpoints de fluxo | [ROTA SEM FUNCIONALIDADE] |
| `/matches` | CommerceModulePage | creator-matches | sim | — | endpoints de fluxo | [ROTA SEM FUNCIONALIDADE] |
| `/outreach-ai` | CommerceModulePage | outreach-ai | sim | — | endpoints de fluxo | [ROTA SEM FUNCIONALIDADE] |
| `/campanhas` | CommerceModulePage | campanhas | sim | — | endpoints de fluxo | [ROTA SEM FUNCIONALIDADE] |
| `/vendas` | ModulePage → ResourceCrud (CRUD genérico) | vendas | sim | — | recurso `vendas` | [ATIVO] |
| `/politicas-comerciais` | ModulePage → ResourceCrud (CRUD genérico) | politicas-comerciais | sim | minPerfil=gerente | recurso `politicas_comerciais` | [ATIVO] |
| `/clientes` | ModulePage → ResourceCrud (CRUD genérico) | clientes | sim | — | recurso `clientes` | [ATIVO] |
| `/representantes` | ModulePage → ResourceCrud (CRUD genérico) | representantes | sim | — | recurso `representantes` | [ATIVO] |
| `/catalogos` | ModulePage → ResourceCrud (CRUD genérico) | catalogos | sim | — | recurso `catalogos` | [ATIVO] |
| `/documentos-fiscais` | ModulePage → ResourceCrud (CRUD genérico) | documentos-fiscais | **NÃO** | — | recurso `documentos_fiscais` | [ROTA SEM MENU] |
| `/regras-fiscais` | ModulePage → ResourceCrud (CRUD genérico) | regras-fiscais | **NÃO** | minPerfil=gerente | recurso `regras_fiscais` | [ROTA SEM MENU] |
| `/ncm` | NcmPage | ncm | **NÃO** | minPerfil=gerente | recurso `impostos_ncm` | [ROTA SEM MENU] |
| `/inutilizacoes` | InutilizacoesPage | inutilizacoes | **NÃO** | minPerfil=gerente | recurso `inutilizacoes_fiscais` | [ROTA SEM MENU] |
| `/listas-preco` | ModulePage → ResourceCrud (CRUD genérico) | listas-preco | sim | minPerfil=gerente | recurso `listas_preco` | [ATIVO] |
| `/propostas` | ModulePage → ResourceCrud (CRUD genérico) | propostas | sim | — | recurso `propostas` | [ATIVO] |
| `/pdv-caixas` | ModulePage → ResourceCrud (CRUD genérico) | pdv-caixas | sim | minPerfil=gerente | recurso `pdv_caixas` | [ATIVO] |
| `/pdv` | PdvPage | pdv | sim | — | endpoints de fluxo | [ATIVO] |
| `/compras` | ModulePage → ResourceCrud (CRUD genérico) | compras | sim | — | recurso `compras` | [ATIVO] |
| `/fornecedores` | ModulePage → ResourceCrud (CRUD genérico) | fornecedores | sim | — | recurso `fornecedores` | [ATIVO] |
| `/cotacoes-compra` | CotacoesCompraPage | cotacoes-compra | sim | — | recurso `cotacoes_compra` | [ATIVO] |
| `/compra-recebimentos` | ModulePage → ResourceCrud (CRUD genérico) | compra-recebimentos | sim | — | recurso `compra_recebimentos` | [ATIVO] |
| `/importar-nfe-compra` | ImportarNfePage | importar-nfe-compra | sim | minPerfil=gerente | endpoints de fluxo | [ATIVO] |
| `/depara-fornecedor` | ModulePage → ResourceCrud (CRUD genérico) | depara-fornecedor | sim | — | recurso `produto_fornecedor_skus` | [ATIVO] |
| `/sugestao-compra` | SugestaoCompraPage | sugestao-compra | sim | minPerfil=gerente | endpoints de fluxo | [ATIVO] |
| `/expedicao` | ExpedicaoPage | expedicao | sim | — | endpoints de fluxo | [ATIVO] |
| `/divergencias` | ModulePage → ResourceCrud (CRUD genérico) | divergencias | sim | — | recurso `divergencias_conferencia` | [ATIVO] |
| `/envios` | LogisticaPage | envios | sim | minPerfil=gerente | recurso `envios` | [ATIVO] |
| `/devolucoes` | DevolucoesPage | devolucoes | sim | — | recurso `devolucoes` | [ATIVO] |
| `/financeiro` | FinanceiroPage | financeiro | sim | minPerfil=gerente | endpoints de fluxo | [ATIVO] |
| `/lancamentos` | ModulePage → ResourceCrud (CRUD genérico) | lancamentos | sim | minPerfil=gerente | recurso `lancamentos_financeiros` | [ATIVO] |
| `/categorias-financeiras` | ModulePage → ResourceCrud (CRUD genérico) | categorias-financeiras | sim | minPerfil=gerente | recurso `categorias_financeiras` | [ATIVO] |
| `/contas-financeiras` | ModulePage → ResourceCrud (CRUD genérico) | contas-financeiras | sim | minPerfil=gerente | recurso `contas_financeiras` | [ATIVO] |
| `/transferencias` | ModulePage → ResourceCrud (CRUD genérico) | transferencias | sim | minPerfil=gerente | recurso `transferencias_financeiras` | [ATIVO] |
| `/centros-custo` | ModulePage → ResourceCrud (CRUD genérico) | centros-custo | sim | minPerfil=gerente | recurso `centros_custo` | [ATIVO] |
| `/investidores` | ModulePage → ResourceCrud (CRUD genérico) | investidores | sim | minPerfil=gerente | recurso `investidores` | [ATIVO] |
| `/aportes` | ModulePage → ResourceCrud (CRUD genérico) | aportes | sim | minPerfil=gerente | recurso `aportes` | [ATIVO] |
| `/comissoes` | ComissoesPage | comissoes | sim | minPerfil=gerente | endpoints de fluxo | [ATIVO] |
| `/recorrencias-financeiras` | ModulePage → ResourceCrud (CRUD genérico) | recorrencias-financeiras | sim | minPerfil=gerente | recurso `recorrencias_financeiras` | [ATIVO] |
| `/relatorios` | RelatoriosPage | relatorios | sim | — | endpoints de fluxo | [ATIVO] |
| `/empresas` | EmpresasPage | empresas | sim | minPerfil=admin | endpoints de fluxo | [ATIVO] |
| `/usuarios` | UsuariosPage | usuarios | sim | AdminOnly (redirect /) | recurso `usuarios` | [ATIVO] |
| `/auditoria` | ModulePage → ResourceCrud (CRUD genérico) | auditoria | sim | AdminOnly (redirect /) | recurso `auditoria` | [ATIVO] |
| `/webhooks` | WebhooksPage | webhooks | sim | AdminOnly (redirect /) | endpoints de fluxo | [ATIVO] |
| `/ajuda` | AjudaPage | ajuda | sim | — | endpoints de fluxo | [ATIVO] |
| `*` (catch-all) | `Navigate to="/"` | — | n/a | — | — | [REDIRECT] |

---

## E. ERP-MASTER-MAP × FRONTEND — matriz de cobertura da navegação

Fonte da coluna “esperado”: `docs/ERP-MASTER-MAP.md` (§3) + a estrutura oficial da especificação técnica. “Papel na navegação” segue a classificação pedida na §7 do ciclo (menu principal · submenu · ação contextual · tela interna · configuração · serviço sem tela própria).

| Domínio | Backend | Rota | Tela | Menu | RBAC | Grupo correto? | Duplicado? | Órfão? | Papel que DEVE ter | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| 1. Meu Negócio / BI | ✅ `/api/negocios/*`, `/api/dashboard` | ✅ `/` | ✅ `Dashboard.tsx` | ✅ topo | perfil decide blocos financeiros | ✅ topo (group `null`) | não | não | **menu principal** (item âncora) | 🟢 |
| 2. Cadastros | ✅ 9 cadastros | ✅ 8 rotas no front | ✅ CRUD + `MedidasPage` | ✅ 8 itens | — | ✅ | rótulo “Produtos”/“Categorias” repetido em outros grupos | não | menu principal + submenus | 🟢 (faltam marcas/unidades — domínio, fora do escopo) |
| 3. Vendas | ✅ | ✅ 9 rotas | ✅ CRUD + `PdvPage` + `ComissoesPage` | ✅ 9 itens | 4 itens `minPerfil=gerente` | ✅ (Fiscal saiu daqui — correto) | rótulo “Categorias” (financeiro) | não | menu principal | 🟢 |
| 4. Compras | ✅ | ✅ 7 rotas | ✅ CRUD + `CotacoesCompraPage`, `SugestaoCompraPage`, `ImportarNfePage` | ✅ 7 itens | 3 exigem gerente | ✅ | não | não | menu principal (ou submenu de *Estoque & Suprimentos*) | 🟢 |
| 5. Estoque | ✅ | ✅ 4 rotas | ✅ `EstoqueGradePage`, `InventarioModulePage` | ✅ 4 itens | — | ✅ | não | não | menu principal | 🟡 (gaps de vínculo venda→estoque, transferências, reserva — domínio) |
| 6. Produção | ✅ | ✅ 4 rotas | ✅ `OrdemDetail`, `FichaDetail`, `CustoPage`, `PlanejamentoProducaoPage` | ✅ 4 itens | — | ✅ | não | não | menu principal | 🟢 |
| 7. Logística & Expedição | ✅ | ✅ 4 rotas | ✅ `ExpedicaoPage`, `LogisticaPage`, `DevolucoesPage` | ✅ 4 itens | `envios` = gerente | ✅ | não | não | menu principal (transversal) | 🟠 (credenciais externas) |
| 8. Financeiro | ✅ | ✅ 10 rotas | ✅ `FinanceiroPage` + CRUD | ✅ 10 itens | todos `minPerfil=gerente` | ✅ | rótulo “Categorias” | não | menu principal | 🟢 |
| **9. Fiscal** | ✅ `fiscal.ts` + `fiscalRegras.ts` | ✅ 4 rotas | ✅ CRUD + `NcmPage` + `InutilizacoesPage` | **❌ nenhum item aparece** | 3 exigem gerente; `documentos-fiscais` livre | ✅ declarado (`MODULE_GROUPS`) **✗ renderizado** | não | **SIM — 4 módulos** | menu principal (transversal) | 🔴 **`UX01-P0-01`** |
| 10. Relatórios | ✅ 11 relatórios | ✅ `/relatorios` | ✅ `RelatoriosPage` | ✅ 1 item | — | ✅ (grupo de 1 item) | não | não | menu principal | 🟡 (`GAP-REL-CENTRAL`: 11 de ~19) |
| 11. Administração / Configurações | ✅ | ✅ | ✅ `UsuariosPage`, `EmpresasPage`, `Settings` | ✅ 5 itens | `empresas`=admin, `usuarios`/`auditoria`/`webhooks`=adminOnly | parcial: *Administração* não existe como área (tudo em “Configurações”) | não | não | menu principal + seção “Sistema” | 🟡 (`GAP-ADMIN-IMPORTACAO`; sem tela central de importação) |
| 12. Integrações (conectores) | ✅ 4 canais | ✅ 5 rotas (4 conectores + webhooks) | ✅ `ConectorPage` (1 componente, 4 rotas — reuso intencional) | ✅ 4 itens | todos gerente | ✅ | não | não | submenu “Canais” | 🟠 (depende de OAuth real) |
| 12b. WooCommerce | ✅ `/api/marketplace/loja/*` (index.ts:698-701) | ✗ nenhuma rota no front | ✗ nenhuma tela | ✗ | — | — | — | **SIM — funcionalidade sem entrada navegável** | submenu “Canais” ou **ação contextual** dentro de Integrações | 🔴 `GAP-COM-WOO-MENU` (confirmado: `grep marketplace client/src` = 0 consumo) |
| 13. Gestão de Commerce | ✗ (sem API de gestão; ingestão existe) | ✅ 4 rotas | ⚠️ `CommerceModulePage` (0 chamadas de API) | ✅ 4 itens | — | ✅ | rótulo “Produtos”“Pedidos”“Delivery” colidem com ERP | não | submenu **marcado “em preparação”** | 🔴 `GAP-COM-*` (esqueleto honesto) |
| 14. Ecossistema Creators | ✗ (nenhuma tabela/endpoint) | ✅ 4 rotas | ⚠️ `CommerceModulePage` | ✅ 4 itens | — | ✅ | rótulo “Matches”/“Campanhas” livres | não | submenu **“em preparação”** ou fora do menu até existir | 🔴 `GAP-CREATORS` |
| Serviços sem tela própria | ✅ MFA, política de senha, backup/XLSX, e-mail, PDF/DANFE, QR, webhooks de saída | — | parcial | parcial | — | — | — | — | **serviço** (não precisa de menu) | 🟡 (backup só dentro de Configurações) |

**Leitura da matriz:** nenhum módulo do ERP-MASTER-MAP “desapareceu”; o que existe é **um domínio inteiro (Fiscal) sem navegação**, **um serviço com API e sem navegação** (WooCommerce), **duas áreas de esqueleto ocupando 8 posições de menu** e **uma área de administração sem nome próprio**.

---

## F. LEGADO — arquivos e componentes suspeitos

### F.1 órfãos confirmados (nada de produção os consome)

| Arquivo / símbolo | Evidência | Risco |
|---|---|---|
| `client/src/sw.ts` (service worker manual, 100 linhas, política *stale-while-revalidate* para `.js/.css`) | nenhuma referência em todo o repositório (`grep -rn "registerSW\|workbox\|sw.js" client/src` = 0 ocorrências fora do `vite.config.ts`); o build usa `VitePWA` no modo **`generateSW`**, que gera o seu próprio `dist/sw.js` (confirmado no build: `PWA v1.3.0 · mode generateSW · precache 59 entries`) | **ALTO se algum dia foi registrado**: um SW manual servindo JS do cache *sem revisão* mantém um bundle antigo indefinidamente — é exatamente o sintoma “continua vendo o menu antigo”. Hoje é código morto; verificação no navegador (§A.1) |
| `client/src/modules.ts:323` `PAGES_ESPECIAIS` | 0 consumidores em `client/src` (a lista real é o if-chain em `ModulePage.tsx:88-112`) | médio: duas “listas de páginas especiais” que já divergem (`planejamento-producao`, `importar-nfe-compra`, `webhooks`, `medidas` estão no dispatch e não na lista) |
| `client/src/modules.ts:328` `findModuleByResource` | 0 consumidores | baixo |
| `client/src/modules.ts:284` `MODULE_GROUPS` | em produção: **0 consumidores**; só `modules.test.ts` (5 refs) — é a lista que o teste valida e que o `Sidebar` ignora | **alto**: é a raiz do `UX01-P0-01` |
| `Breadcrumb` (`ui-kit.tsx:1214`), `Drawer`, `Tooltip`, `Skeleton`, `SearchInput`, `BulkActions`, `Dropdown`, `Switch`, `Checkbox`, `StatusBadge`, `DeltaBadge`, `STATUS_PRESETS` | 12 exports do UI kit **sem uso em código de produção** (varredura literal) | alto: as peças de um “shell definitivo” (trilha clicável, drawer, tooltip) existem e **nunca foram ligadas** — a evolução do shell parou no meio |
| `fixes-bloco-a.patch` (raiz do repositório, 9 kB) | patch que cria `scripts/backup-postgres.sh`, `.github/workflows/backup.yml`, `server/src/db/advisory-lock.ts` e `docs/AUDITORIA.md` — **nenhum desses arquivos existe na árvore** | baixo/médio: artefato de trabalho esquecido na raiz (não é navegação, mas é legado no repositório) |
| `/dev/componentes` (`App.tsx:78`, `AdminOnly`) | rota intencional, documentada no próprio código como “não entra no menu” | nenhum |
| 8 módulos `planned` (`commerce-*`, `creators`, `matches`, `outreach-ai`, `campanhas`) | `ModulePage.tsx:114` → `PlannedModule`; `CommerceModulePage.tsx` sem nenhuma chamada de API (confirmado no MASTER-MAP §3.12) | médio: 8 posições de menu (para operador, **8 de 42 itens ≈ 19%**) abrem tela sem função |

### F.2 rótulos legados vivos na interface

| Texto antigo | Onde | Deveria ser |
|---|---|---|
| `Dashboard` | `Layout.tsx:86` (trilha em `/`) | `Meu Negócio` |
| `Dashboard` | `CommandPalette.tsx:65` (item fixo da busca) | `Meu Negócio` |
| `Dashboard` | `client/public/manifest.json` (`shortcuts[0].name`) | `Meu Negócio` |
| `Dashboard` | `modules.ts:60` (comentário do tipo) e `Dashboard.tsx:2` (“Etapa 2 do redesign”) | comentário atualizado |
| Prefixo fixo `BROBOND ERP` antes de toda trilha | `Layout.tsx:78` | decidir: marca no topo, trilha sem prefixo redundante |

### F.3 o que **não** é legado (para não ser removido por engano)

`Layout.tsx`, `Sidebar.tsx`, `modules.ts`, `CommandPalette.tsx`, `CompanySwitcher.tsx`, `AuthContext.tsx`, `ui-kit.tsx` (partes usadas), `PlannedModule.tsx` e `CommerceModulePage.tsx` **estão em uso ativo** — os dois últimos são o mecanismo oficial de “módulo sem funcionalidade” (regra 30 do projeto). A remoção, quando ocorrer, será de *entradas de menu*, não de código.

---

## G. DUPLICIDADES — lista detalhada e classificação

| # | Duplicidade | Arquivos | Classificação | Impacto |
|---|---|---|---|---|
| G1 | **Listas de grupos de navegação**: `MODULE_GROUPS` (13) × `GROUP_META` (13) × `ERP_GROUPS` (8, sem Fiscal) + `COMMERCE_GROUPS` (3) + `SYSTEM_GROUPS` (1) | `modules.ts:284,306` × `Sidebar.tsx:25,36,38` | **DESNECESSÁRIA** (a de `Sidebar` deve derivar de `MODULE_GROUPS`) | **P0** — causou o sumiço do grupo Fiscal |
| G2 | **Resolução “módulo da rota atual”** escrita 2× | `Layout.tsx:35-38` × `Sidebar.tsx:68-70` | **DESNECESSÁRIA** | médio: regra duplicada, muda em dois lugares |
| G3 | **“Lista de páginas especiais”**: `PAGES_ESPECIAIS` × if-chain do `ModulePage` | `modules.ts:323` × `ModulePage.tsx:88-112` | **LEGADA** (a primeira está morta e já divergente) | médio |
| G4 | **Rótulos repetidos no menu**: `Produtos` (Cadastros × Gestão de Commerce), `Categorias` (Cadastros × Financeiro) | `modules.ts` | **DESNECESSÁRIA** na paleta de busca (resultados ambíguos); aceitável na barra lateral se os grupos forem visíveis | baixo/médio — o Ctrl+K mostra dois “Produtos” e dois “Pedidos” sem contexto |
| G5 | **Nome da seção Commerce**: rótulo “Commerce / Integrações” (`Sidebar.tsx:157`) × grupos “Integrações” + “Gestão de Commerce” + “Ecossistema Creators” | `Sidebar.tsx` × `modules.ts` | **AMBÍGUA** | baixo |
| G6 | **Dois service workers**: `src/sw.ts` (manual, morto) × `dist/sw.js` (workbox `generateSW`, vivo) | `client/src/sw.ts` × `client/vite.config.ts:12-33` | **LEGADA** | médio/alto (ver F.1) |
| G7 | **Duas noções de versão**: `vite.config.ts` define `VITE_VERSION` (0.6.0) mas o rodapé do `Sidebar` mostra `meta.version` (do **servidor**) | `client/vite.config.ts:39` × `Sidebar.tsx:196` | **AMBÍGUA** | médio: o rodapé não identifica o bundle do cliente — atrapalha diagnosticar “estou vendo versão antiga?” |
| G8 | `OrderPage` servir `/vendas/:id` e `/compras/:id`; `ConectorPage` servir 4 rotas | `App.tsx:76-81` × 4 conectores | **NECESSÁRIA** (mesmo contrato, reuso correto) | nenhum |
| G9 | Duas telas de estoque (`EstoqueGradePage` × `Movimentações` CRUD) e duas de produção (`Ordens` × `Cadeias de Fabricação`) co-existirem no menu | `modules.ts` | **NECESSÁRIA** (visões distintas: grade × lançamento) | nenhum |

---

## H. RBAC — fluxo atual

**Como o menu decide (cliente, `modules.ts:337-346`):**

```
visibleModules(user):
  adminOnly  && perfil !== 'admin'            → esconde
  minPerfil === 'admin' && perfil !== 'admin' → esconde
  minPerfil === 'gerente' && perfil ∉ {admin,gerente}
        exceto politicas-comerciais com perm_politicas === 'permitir'  → senão esconde
  demais                                     → mostra
```

Consumido por **dois** lugares: `Sidebar.tsx:64` e `CommandPalette.tsx:28`. **Não** considera: empresa ativa, `perm_catalogos`, `perm_compartilhar`, `perm_metricas`, `perm_aprovar`, `desconto_max_pct`, `venda_sem_aprovacao_ate`.

**Como o servidor decide (`server/src/services.ts:141-162` + `index.ts` requireAuth):**

```
requireAuth  (gargalo /api)  →  JWT + claim `emp` revalidada
checkAccess(r, actor, op):
  catalogos / politicas_comerciais → permissões comerciais dedicadas
  PERFIL_RANK[perfil] < PERFIL_RANK[r.minPerfil]  → 403
  r.adminOnly && perfil !== 'admin'               → 403
  op ∉ r.ops                                      → 405
  op === 'delete' && perfil === 'operador'        → 403
escopo de empresa → 404 entre empresas (nunca 403)
```

**Respostas objetivas da §12:**

1. O menu **não** é estático: é RBAC-aware por perfil.
2. Existe filtragem por permissão — mas **só** por perfil/`adminOnly`/`minPerfil` (+ `perm_politicas`).
3. **Itens escondidos incorretamente: SIM.** Os 4 módulos fiscais (grupo não renderizado). Agravante: **`documentos-fiscais` não tem `minPerfil` nem `adminOnly`** — pela regra do próprio front, **um operador deveria vê-lo** e não vê (é o “invisível-1” da contagem de órfãos).
4. **Itens visíveis sem autorização: NÃO** (0 erros `RBAC_DERIVA_ADMIN`/`RBAC_DERIVA_GERENTE` no gate).
5. **O frontend apenas esconde; o backend protege** — sim, e o gate confirma 0 derivações perigosas. Porém há **3 derivações soltas** (`RBAC_DERIVA_SOLTA`) em que o **menu restringe e a API não**:
   * `politicas-comerciais` (`minPerfil=gerente` no menu; recurso sem `minPerfil` no servidor — alçada vem de `perm_politicas`);
   * `listas-preco` (`minPerfil=gerente` no menu; `listas_preco` sem restrição equivalente);
   * `envios` (`minPerfil=gerente` no menu; `envios` sem restrição equivalente).
   Tradução: um operador não vê o item, mas **consegue chamar `/api/listas_preco` e `/api/envios`** (a mensagem do próprio gate). É gap de segurança/coerência — **registrado, não corrigido neste ciclo** (`UX01-P1-04`).
6. Não há RBAC por **empresa** no menu: `visibleModules` ignora o contexto de empresa (§13).

---

## I. MEU NEGÓCIO — integração atual

| Pergunta | Resposta com evidência |
|---|---|
| Qual rota é realmente carregada? | `/` → `<Route index element={<Dashboard/>}>` (`App.tsx:75`) |
| Qual componente renderiza? | `client/src/pages/Dashboard.tsx` — `PageHeader title="Meu Negócio"` (linha 147-148) |
| `/` aponta para Meu Negócio? | **Sim** (`modules.ts:86-90`: `id: 'dashboard'`, `label: 'Meu Negócio'`, `path: '/'`, `group: null`) |
| Existe rota antiga concorrente? | **Não** — não existe `/meu-negocio`, `/dashboard`, `/dashboard2` nem redirect equivalente (grep = 0) |
| Existe dashboard antigo? | **Não.** Um único `Dashboard.tsx` (+ 7 componentes em `components/dashboard/`); `Dashboard.test.tsx` e `Dashboard.negocios.test.tsx` cobrem a mesma tela |
| Existem dois dashboards? | **Não** |
| O menu ainda referencia a estrutura antiga? | **Parcialmente, na nomenclatura**: a barra lateral já diz “Meu Negócio”, mas o **header** (`Layout.tsx:86`), a **busca global** (`CommandPalette.tsx:65`) e o **atalho do PWA** (`manifest.json`) ainda dizem “Dashboard” |
| O shell antigo envolve o novo dashboard? | Não há shell “antigo” e “novo”: existe **um** `Layout`. O que envolve o Meu Negócio é o shell dark-premium da Fase 3 (2026-10-05) + navegação por áreas (2026-10-08) |
| A nova implementação está integrada ao shell? | **Sim** — renderizada dentro do `Layout`, com `Protected`, `CompanySwitcher`, busca global e RBAC de perfil (blocos financeiros só para admin/gerente, `Dashboard.tsx:38`) |
| Existe discrepância entre código e interface observada? | **Sim, em dois pontos**: (a) o nome “Dashboard” na moldura da própria tela `/`; (b) o grupo “Fiscal” que o código declara (e o header exibe quando a rota é aberta por URL) e a barra lateral nunca mostra |

### Resposta formal

> **“O novo Meu Negócio está integrado ao shell definitivo?”**
> **PARCIAL.**
> **SIM** para *integração*: há um shell único e o Meu Negócio é a rota raiz dele, com RBAC, multiempresa e busca global funcionando.
> **NÃO** para *definitivo*: o “shell definitivo” da especificação **ainda não existe** no repositório (é a estrutura de 2026-10-05/10-08), e a própria moldura da tela ainda imprime o nome antigo (`Dashboard`).

---

## J. DEPLOY — somente fatos comprováveis

| Fato | Evidência |
|---|---|
| Um único serviço web (Render), API + front no mesmo host | `render.yaml`: `buildCommand: npm install --include=dev && npm run build`; `startCommand: npm --workspace server start`; `healthCheckPath: /api/health` |
| O front é **construído no deploy** (não há `dist` versionado) | `npm run build` = `vite build` (raiz, `package.json`); `.gitignore` exclui `dist/`; `git ls-files` filtrado por `dist/` = vazio |
| O Express serve o build | `server/src/index.ts:861-865` — `express.static(client/dist, { maxAge: '1h', index: false })` + fallback `sendFile(index.html)` |
| O front é um **PWA com service worker auto-registrado** | `vite.config.ts:12-33` (`VitePWA`, `registerType: 'autoUpdate'`, `devOptions.enabled: false`); build real gerou `dist/registerSW.js` (registra `/sw.js` no `window.load`), `dist/sw.js` e **59 entradas de precache**, incluindo `index.html` com *revision* + `navigateFallback: index.html` (denylist `/api/`) |
| **Consequência técnica verificável**: um SW ativo pode servir `index.html`/assets do precache antes de o novo SW assumir; um cliente com a aba aberta continua com o bundle antigo até recarregar; um SW **manual** antigo (como o de `src/sw.ts`) não expira sozinho | mecânica do workbox (`skipWaiting`+`clientsClaim` no `sw.js` gerado) + `src/sw.ts` órfão |
| O rodapé do `Sidebar` mostra a versão do **servidor**, não do cliente | `Sidebar.tsx:196` usa `meta.version`, vinda de `GET /api/meta` (`server/src/index.ts:411`); `VITE_VERSION` (`vite.config.ts:39`) **não é exibido em lugar nenhum** |
| CI valida mas **não publica** | `.github/workflows/ci.yml` — typecheck, testes, lint, build, Postgres; nenhum passo de deploy |
| O código auditado é o topo da `main` | `git rev-parse HEAD` = `649e0462` = `refs/heads/main` em `git ls-remote origin`; **0 PRs abertos** (`gh pr list --state open`) |
| Histórico da navegação | `Sidebar.tsx`: última mudança **2026-10-08** (`6cc5ee32`) · `Layout.tsx`: **2026-10-08** · `modules.ts`: **2026-10-11** (`00ef2a84`/ERP-07, `b62c7b4a`/ERP-06, `876c46c4`/ERP-05) |

> **“Não foi possível confirmar o artefato atualmente em produção somente pelo repositório.”**
> O repositório prova **o que seria publicado** a partir de `649e0462` (build verde; sidebar de 12 grupos/66 itens). Ele **não** prova qual commit está servido agora, nem se há SW/cache antigo no navegador do usuário. Verificação sugerida (sem alterar nada): no navegador, *Network* → desabilitar cache + recarregar; *Application* → conferir `sw.js`, *Cache Storage* e o hash do bundle; comparar com `index-LEZha2hD.js` (build deste ambiente) — e confirmar no painel da Render o commit do último deploy.

---

## K. GAPS — classificação

**P0 — impede navegação correta**

| ID | Gap | Evidência |
|---|---|---|
| `UX01-P0-01` | O grupo **Fiscal** (4 módulos) é declarado e **nunca renderizado**; `documentos-fiscais` deveria ser visível a qualquer perfil com RBAC e não é visível a nenhum | `modules.ts:284-321` × `Sidebar.tsx:25-38`; execução do componente: 12 grupos/66 itens, sem Fiscal; header em `/documentos-fiscais` mostra “Fiscal” |
| `UX01-P0-02` | Os **gates não cobrem o renderizador**: `audit:menu` e `modules.test.ts` validam `MODULE_GROUPS`, não as listas do `Sidebar` → a divergência passa verde | `scripts/auditar-menu.ts:97-101`; `modules.test.ts` (10 testes, todos sobre `MODULES`/`MODULE_GROUPS`) |
| `UX01-P0-03` | **Nenhum teste renderiza** `Sidebar`/`Layout` → nenhuma barreira contra regressão de menu | 26 arquivos de teste no front; `grep -rl "components/Sidebar" client/src/**/*.test.*` = 0 |

**P1 — arquitetura importante**

| ID | Gap | Evidência |
|---|---|---|
| `UX01-P1-01` | O `Sidebar` **não consome a fonte única** (`MODULE_GROUPS`/`GROUP_META`) — ordem, seções e presença de grupo duplicadas em 3 constantes locais | `Sidebar.tsx:25-38`, `152-168` |
| `UX01-P1-02` | A navegação **não segue a estrutura oficial** (§8): não existe “Estoque & Suprimentos” (Compras é grupo separado), “Administração” não existe como área, “Relatórios” é grupo de 1 item, e “Commerce/Integrações” concentra **17 itens** (9 deles sem função para operador) | `modules.ts:284-303`; árvore renderizada §C.1 |
| `UX01-P1-03` | **Sem breadcrumbs**: existe o componente `Breadcrumb` (`ui-kit.tsx:1214`) **sem uso**; a trilha real é texto não clicável no header (`Layout.tsx:78-84`) e some em telas de detalhe além do módulo pai | `grep Breadcrumb client/src` = só `ui-kit.tsx` + comentário |
| `UX01-P1-04` | **RBAC derivado solto** (menu restringe, API não): `politicas_comerciais`, `listas_preco`, `envios` | saída do gate: 3 avisos `RBAC_DERIVA_SOLTA` |
| `UX01-P1-05` | 8 entradas de menu abrem **tela sem funcionalidade** (`PlannedModule`/`CommerceModulePage`) — 19% do menu do operador | `modules.ts` (`planned`), `ModulePage.tsx:114` |
| `UX01-P1-06` | Navegação **não é empresa-aware**: `visibleModules` ignora empresa ativa/consolidação; itens podem levar a 404 dependendo do escopo | `modules.ts:337` × `empresa.ts` (escopo no servidor) |
| `UX01-P1-07` | **WooCommerce sem entrada navegável** (`/api/marketplace/loja/*` existe, front não consome) | `server/src/index.ts:698-701`; `grep marketplace client/src` = 0 uso real |
| `UX01-P1-08` | **Nomenclatura legada** em pontos visíveis (“Dashboard” no header, na busca e no atalho do PWA) | `Layout.tsx:86`, `CommandPalette.tsx:65`, `manifest.json` |
| `UX01-P1-09` | **Rótulos ambíguos** no menu/busca (“Produtos” ×2, “Categorias” ×2, “Pedidos” ×2) | `modules.ts` |
| `UX01-P1-10` | **Legado morto ligado à navegação/carregamento**: `src/sw.ts`, `PAGES_ESPECIAIS`, `findModuleByResource`, `MODULE_GROUPS` (produção), 12 exports do UI kit sem uso | §F.1 |

**P2 — melhoria**

| ID | Gap | Evidência |
|---|---|---|
| `UX01-P2-01` | Sem **submenus** (hoje: 1 nível de accordion) e sem agrupamento semântico dentro de áreas grandes (Financeiro = 10 itens planos; Vendas = 9; Cadastros = 8) | `Sidebar.tsx:180-215` |
| `UX01-P2-02` | **Trilha não clicável** e prefixo redundante “BROBOND ERP” antes de cada trilha | `Layout.tsx:78-84` |
| `UX01-P2-03` | **Colapso do menu esconde os grupos**: no trilho de ícones o usuário perde a área de cada item (só `title`) | `Sidebar.tsx:183-191` |
| `UX01-P2-04` | **Mobile/acessibilidade**: o drawer não fecha com `Esc`, não prende o foco e não devolve o foco ao botão de origem; `Tooltip` do UI kit existe sem uso (só `title` nativo) | `Sidebar.tsx:61-137` (sem handler de `Escape`); `CompanySwitcher.tsx:52-66` **tem** `Escape` — assimetria |
| `UX01-P2-05` | **Versão do front não é visível**: o rodapé mostra a versão da API; não há aviso de “nova versão disponível” (autoUpdate silencioso) — dificulta diagnosticar bundle antigo | `Sidebar.tsx:196`; `vite.config.ts:13` |
| `UX01-P2-06` | Estado ativo/inativo: realce por grupo e item está correto (`NavLink` + `aria-expanded`), mas **não há indicação de escopo de empresa** junto do menu (só no header) | `Sidebar.tsx`, `Layout.tsx` |

**P3 — cosmético**

| ID | Gap | Evidência |
|---|---|---|
| `UX01-P3-01` | Emoji no rótulo do menu: “📦 Delivery” | `modules.ts:186` |
| `UX01-P3-02` | Comentários/contratos legados em `modules.ts` (ex.: `null = item de topo (Dashboard)`) | `modules.ts:60` |
| `UX01-P3-03` | `manifest.json` sem `screenshots` e com atalhos desatualizados | `client/public/manifest.json` |
| `UX01-P3-04` | Seções de navegação **duplicam** os rótulos de grupo na tela (accordion “Integrações” sob a seção “Commerce / Integrações”) | `Sidebar.tsx:152,157` |

---

## L. PROPOSTA DE ARQUITETURA FUTURA (**proposta — nada implementado**)

### L.1 Shell definitivo

* **Um único `AppShell`** — o `Layout` atual evoluído, sem segundo shell e sem flag: `Sidebar` (menu) · `Topbar` (trilha + empresa + busca + usuário) · `Conteúdo` (`<Outlet/>`), com `skip-link` mantido.
* **Responsabilidade explícita por componente:** `AppShell` (geometria), `SidebarNav` (menu declarativo), `Breadcrumbs` (trilha derivada de `MODULES`), `CompanyScopeBadge` (empresa/consolidado sempre visível).
* **Regra de ouro:** *o menu é função da declaração.* `Sidebar` passa a iterar `MODULE_GROUPS`/`GROUP_META`; nenhuma lista local de grupos.

### L.2 Menu definitivo (6 áreas da especificação + transversais)

| Área (nível 1) | Subgrupos (nível 2) | Itens (todos os 70 atuais preservados) |
|---|---|---|
| **Meu Negócio (BI)** | — | `Meu Negócio` (`/`) |
| **Cadastros** | Produtos & Engenharia · Atributos · Parceiros | Produtos, Categorias, Cores, Insumos, Tamanhos, Grade, Tabela de Medidas, Coleções, Clientes, Fornecedores, Representantes |
| **Vendas** | Pedidos & Propostas · Preço & Política · Balcão · Canais | Vendas, Propostas, Listas de preço, Políticas comerciais, PDV, Caixas do PDV, Catálogos públicos, Comissões |
| **Estoque & Suprimentos** | Estoque · Movimentação · Suprimentos | Estoque Físico, Movimentações, Locais, Inventário · Compras, Recebimentos, Cotação de compra, De-Para, Sugestão de compra, Importar NF-e |
| **Financeiro** | Caixa & Bancos · Cadastros · Sócios | Financeiro, Lançamentos, Contas, Transferências, Recorrências · Categorias, Centros de custo · Investidores, Aportes |
| **Configurações & Administração** | Administração · Sistema | Usuários, Empresas, Auditoria, Webhooks · Configurações, Ajuda |
| **Fiscal** (transversal) | Emissão · Regras | Documentos fiscais, Inutilizações · Regras fiscais, NCM / Tributação |
| **Logística & Expedição** (transversal) | Operação · Reversa | Expedição, Divergências, Logística e envios · Devoluções |
| **Produção** (transversal) | Planejamento · Execução | Planejamento de Produção · Cadeias de Fabricação, Ficha Técnica/BOM, Custos |
| **Relatórios** (transversal) | — | Relatórios |
| **Canais & Integrações** | Conectores · Commerce (em preparação) · Creators (em preparação) | 4 conectores, Webhooks · 4 módulos *Commerce* · 4 módulos *Creators* — **com selo “em preparação”** e, para perfis operacionais, preferencialmente **ocultos até existir funcionalidade** |

* **Profundidade máxima: 2 níveis.** Sem “menu de menu de menu”.
* **Uma única fonte** (`MODULES` + `MODULE_GROUPS` + um novo `subgroup` opcional) alimenta barra lateral, busca global, título do documento e trilha.
* **Commerce/Creators:** manter as rotas (documentadas), mas marcar visualmente e tipar como “planejado” — hoje os dois grupos somam 8 dos 42 itens de um operador.

### L.3 Breadcrumbs

`BROBOND ERP › Área › Subgrupo › Módulo › Registro` — derivados de `MODULES` + a URL; **todos os níveis clicáveis** exceto o último; usar o `Breadcrumb` que já existe no UI kit. Em telas de detalhe (`/produtos/:id`, `/vendas/:id`, `/ordens/:id`, `/fichas/:id`) o último nível é o identificador do registro (`#12 · Camiseta Oversized`).

### L.4 RBAC

* **Fonte dupla, com o servidor mandando:** o front mantém `visibleModules` como *filtro de conveniência*, mas deriva `minPerfil`/`adminOnly` do que a API publica em `/api/meta` (evita a divergência menu × API).
* **Fechar as 3 derivações soltas endurecendo a API** (não afrouxando o menu): `listas_preco`, `envios` e o caminho de escrita de `politicas_comerciais`.
* **Menu nunca é fronteira de segurança:** manter `checkAccess` + escopo de empresa como gate real; adicionar teste que prove “item invisível ⇒ endpoint 403/404”.

### L.5 Contexto de empresa

* `CompanyScopeBadge` no topbar (empresa ativa **ou** “Todas as empresas”), sempre visível, junto do seletor.
* Menu **empresa-aware**: itens que dependem de cadastro por empresa (ex.: locais, contas financeiras, regras fiscais) podem indicar vazio/ausência em vez de levar a uma tela vazia.
* Manter o comportamento atual de **remontar** o conteúdo na troca de empresa (`key={escopoVersao}`) — é a defesa correta contra vazamento visual.

### L.6 Padrão de rotas

* Rotas de módulo continuam **geradas de `MODULES`** (fonte única) — e ganham `subgroup` para a trilha.
* Telas de detalhe viram **sub-rotas explícitas** do módulo (`/produtos/:id`, `/vendas/:id`…), como já ocorre.
* Rotas públicas permanecem fora do shell (`/login`, `/convite`, `/catalogo`, `/portal`, `/esqueci`, `/redefinir/:token`).
* **Redirects 308** para qualquer rota antiga que mude no futuro (hoje não há rota antiga a redirecionar — `grep /meu-negocio /dashboard` = 0).

### L.7 Estratégia para o legado

1. **Unificar** o menu em `MODULE_GROUPS` (elimina G1/G2) — é a correção do P0.
2. **Remover** `src/sw.ts` (morto), `PAGES_ESPECIAIS`, `findModuleByResource`; decidir o destino dos 12 exports do UI kit (usar ou remover).
3. **Renomear** os rótulos “Dashboard” (header, busca, manifest, comentários).
4. **Tratar** `fixes-bloco-a.patch` (aplicar num ciclo próprio ou remover da raiz).
5. **Service worker:** política de atualização verificável (`autoUpdate` + aviso “nova versão” + versão do front no rodapé) e, **se** a investigação do navegador confirmar SW antigo, um procedimento de limpeza (`navigator.serviceWorker.getRegistrations()` + `caches.keys()`), executado **uma vez**, documentado — nunca automático.

### L.8 Estratégia de migração

* Sem *feature flag*: navegação nova entra com **redirect e trilha**, preservando 100% das rotas e telas atuais.
* Ordem: **fonte única → renderizador → trilha → agrupamento → RBAC/empresa → limpeza do legado → testes → validação visual.**

---

## M. PLANO DE IMPLEMENTAÇÃO (não executado — apenas proposto)

| Etapa | Objetivo | Entregáveis (proposta) | Critério de aceite |
|---|---|---|---|
| **UX-01-A · Shell** | Consolidar o shell único | `AppShell` = `Layout` atual + `Breadcrumbs` (usando `ui-kit`) + `CompanyScopeBadge`; remover rótulo “Dashboard” do header | Em `/` o header mostra **“Meu Negócio”**; trilha clicável em toda rota autenticada |
| **UX-01-B · Menu** | Acabar com a divergência declarado × renderizado | `Sidebar` passa a iterar `MODULE_GROUPS`/`GROUP_META`; subgrupos opcionais; selo “em preparação”; rótulos únicos | Teste automatizado compara **itens renderizados** com `visibleModules(MODULES)`: igualdade exata; grupo Fiscal presente |
| **UX-01-C · Rotas** | Fonte única e navegabilidade | `subgroup` em `MODULES`; trilha derivada; redirects documentados; `MODULE_GROUPS` como único ordenador | Zero rota de módulo sem item; zero item sem rota (gate) |
| **UX-01-D · RBAC** | Coerência menu × API | Derivar restrições do `/api/meta`; endurecer `listas_preco`, `envios`, `politicas_comerciais` (API) | Teste “menu esconde ⇒ API nega” para todos os itens restritos |
| **UX-01-E · Migração do legado** | Remover o que confunde | Deletar `src/sw.ts`, `PAGES_ESPECIAIS`, `findModuleByResource`; decidir UI kit morto; atualizar `manifest.json`; tratar o `.patch` | Nenhum export morto de navegação; rodapé com versão **do front** |
| **UX-01-F · Testes** | Barreira contra regressão | (1) render do `Sidebar` por perfil comparando com `visibleModules`; (2) render do `Layout` conferindo títulos; (3) smoke visual de login → menu → módulo (Playwright/Cypress ou @testing-library com `App` + API mockada); (4) teste do gate novo de grupos | Um teste falha se um grupo de `MODULE_GROUPS` deixar de renderizar |
| **UX-01-G · Validação visual** | Prova com imagem | Capturas de: sidebar expandida/colapsada, mobile, trilha, Fiscal visível, Ctrl+K, e comparação antes/depois — por perfil (admin/gerente/operador) | Capturas anexadas ao relatório do ciclo; nenhuma tela do ERP sem navegação para voltar |

> **Nada desta seção foi implementado.** É plano para o ciclo de implementação que o gate do usuário autorizar.

---

## 20. MATRIZ FINAL

| ITEM | ATUAL | ESPERADO | GAP | PRIORIDADE | EVIDÊNCIA |
|---|---|---|---|---|---|
| **Shell** | 1 shell único (`Layout.tsx`), header + sidebar + main; remonta na troca de empresa | Shell definitivo único com trilha clicável e escopo visível | sem breadcrumb real; rótulo “Dashboard” | **P1** | `Layout.tsx:56-150`; `App.tsx:63-72`; renderização em jsdom |
| **Header** | `BROBOND ERP / <grupo> / <label>`; em `/` mostra “Dashboard” | Marca + trilha derivada de `MODULES`, clicável | nomenclatura + trilha não clicável | **P1** | `Layout.tsx:78-86` (execução: `[header /] BROBOND ERP Dashboard`) |
| **Menu** | `Sidebar` com 3 listas locais: 12 grupos / 66 itens (admin), 62 (gerente), 42 (operador) | Menu derivado de `MODULE_GROUPS`/`GROUP_META` (13 grupos) | **Fiscal nunca renderiza**; grupos duplicados em 3 listas | **P0** | `Sidebar.tsx:25-38,152-168` × `modules.ts:284-321` |
| **Dashboard** | 1 tela (`Dashboard.tsx`), rota `/` | Igual (não duplicar) | nenhum | — | `App.tsx:75`; `grep = 1 arquivo` |
| **Meu Negócio** | Rótulo novo na sidebar/página; “Dashboard” no header/busca/manifest | Nome único em toda a moldura | nomenclatura inconsistente | **P1** | `modules.ts:87`; `Layout.tsx:86`; `CommandPalette.tsx:65`; `manifest.json` |
| **Cadastros** | 8 itens | 8 itens (+ marcas/unidades quando existirem) | rótulos “Produtos/Categorias” repetidos noutros grupos | P2 | árvore renderizada §C.1 |
| **Vendas** | 9 itens, 4 restritos a gerente | 9 itens | — | P2 | idem |
| **Estoque** | 4 itens | 4 itens | domínio: transferências/reserva/vínculo venda (fora da navegação) | P2 | MASTER-MAP §3.5 |
| **Compras** | 7 itens em grupo próprio | subgrupo de *Estoque & Suprimentos* | agrupamento fora da especificação | **P1** | §8 × `modules.ts:284-303` |
| **Produção** | 4 itens (grupo próprio) | área transversal | ordem/grupo a validar | P2 | §C.1 |
| **Financeiro** | 10 itens planos, todos gerente+ | área com subgrupos | profundidade/agrupamento | P2 | §C.1 |
| **Fiscal** | 4 módulos com rota/tela/API/RBAC e **zero item de menu** | área Fiscal no menu | **órfão integral** | **P0** | §E linha 9; `Sidebar.tsx:25-38` |
| **Logística** | 4 itens; provedores com credencial ausente | idem + estado “não configurado” explícito | dependência externa | P2 | MASTER-MAP §3.7 |
| **Administração** | dentro de “Configurações” (5 itens) | seção Administração separada | agrupamento | P2 | §C.1 |
| **RBAC** | perfil + adminOnly + minPerfil (+`perm_politicas`) no front; `checkAccess` no servidor | front derivado do `/api/meta`; API endurecida | 3 derivações soltas (`listas_preco`, `envios`, `politicas_comerciais`) | **P1** | gate: 3 avisos `RBAC_DERIVA_SOLTA` |
| **Multiempresa** | escopo no servidor (404 entre empresas), remonta conteúdo na troca | menu empresa-aware + escopo sempre visível | menu ignora empresa ativa | **P1** | `modules.ts:337` × `empresa.ts`; `CompanySwitcher.tsx` |
| **Breadcrumbs** | texto não clicável no header; `Breadcrumb` do UI kit sem uso | trilha clicável derivada de `MODULES` | componente existe e não é usado | **P1** | `ui-kit.tsx:1214`; `Layout.tsx:78-84` |
| **Mobile** | drawer com overlay e botão fechar; sem `Esc`, sem foco preso/devolvido | drawer acessível (Esc, foco, `aria-modal`) | drawer sem teclado/foco — operação no celular fica mais lenta | P2 | `Sidebar.tsx:61-137` × `CompanySwitcher.tsx:52-66` (assimetria) |
| **Acessibilidade** | `nav`/`aside` rotulados, `aria-expanded`, `aria-controls`, `skip-link`, foco visível | + Esc no drawer, Tooltip, contraste auditado | drawer sem `Esc`/foco preso; contraste não auditado | P2 | `Sidebar.tsx`, `Layout.tsx:64-69` |

---

## 21. SCORE

| Dimensão | Nota | Justificativa |
|---|---|---|
| Arquitetura do Shell | **6,5** | um shell único, coeso, com skip-link e remontagem por empresa; falta trilha real e o header diverge da sidebar |
| Menu | **5,0** | declarado em 13 grupos, renderizado em 12; 4 módulos invisíveis; 3 listas locais; 8 itens vazios; 2 rótulos ambíguos |
| Rotas | **8,5** | 100% dos módulos com rota; 0 item sem rota; 0 rota duplicada; catch-all correto; públicas isoladas |
| Integração | **7,0** | módulos e API conversam (menu → rota → recurso → RBAC); o vínculo menu×API tem 3 derivações soltas |
| RBAC | **7,5** | perfil/adminOnly/minPerfil + servidor autoritativo + multiempresa testada; gap de coerência menu×API |
| UX | **6,0** | accordions com estado persistido, busca global, colapso; sem submenu, sem breadcrumb clicável, “Dashboard” na moldura |
| Acessibilidade | **6,5** | rótulos/ARIA presentes e foco visível; drawer sem Esc/foco preso; Tooltip existente sem uso |
| Consistência | **5,0** | duas verdades para “quais grupos existem”, duas implementações de “módulo atual”, “Dashboard” × “Meu Negócio” |
| Cobertura | **7,5** | 70 módulos para 14 domínios do MASTER-MAP; Fiscal e WooCommerce fora da navegação; 11 de ~19 relatórios |
| Ausência de legado | **6,0** | um SW órfão, 2 exports mortos de navegação + 12 do UI kit, patch esquecido na raiz, rótulos antigos vivos |

### ERP-UX SCORE = **6,6 / 10**

`(6,5 + 5,0 + 8,5 + 7,0 + 7,5 + 6,0 + 6,5 + 5,0 + 7,5 + 6,0) / 10 = 6,55 → 6,6`

**Explicação da nota.** O ERP tem **fundação boa** (rotas íntegras, RBAC autoritativo, multiempresa real, um único shell, UI kit próprio) e é isso que sustenta o 6,6. O que derruba a nota não é estética: é **governança da navegação** — existem duas verdades sobre a estrutura do menu, e a que o usuário vê não é a que o código declara. Um único P0 (grupo Fiscal) mais os gates que não o enxergam valem, sozinhos, ~1,5 ponto. Corrigidos os P0/P1 propostos (fonte única + trilha + RBAC coerente + Fiscal no menu), a nota projetada é **8,5–9,0** sem tocar em nenhuma funcionalidade de negócio.

---

## 22. GATES DE AUDITORIA

- [x] shell identificado — `client/src/components/Layout.tsx` (único)
- [x] menu real identificado — `client/src/components/Sidebar.tsx` (renderizado e contado: 12 grupos/66 itens)
- [x] rota inicial identificada — `/` → `Dashboard` (“Meu Negócio”)
- [x] Meu Negócio identificado — `pages/Dashboard.tsx`, integração **PARCIAL** (§I)
- [x] todas as rotas inventariadas — 83 entradas (§D)
- [x] menu inventariado — 70 itens declarados / 66 renderizados (§C)
- [x] comparação com ERP-MASTER-MAP — 14 domínios (§E)
- [x] comparação com a especificação — estrutura de 6 áreas avaliada (§E/§L)
- [x] legado investigado — 6 órfãos + rótulos antigos (§F)
- [x] duplicidades investigadas — 9 casos classificados (§G)
- [x] RBAC investigado — fluxo + 3 derivações soltas (§H)
- [x] multiempresa investigada — escopo no servidor, menu não empresa-aware (§H/§L.5)
- [x] testes existentes auditados — 26 arquivos/262 testes; **0** sobre o menu (§F/§M)
- [x] causa do menu antigo determinada — **2 causas P0 comprovadas + 1 vetor declarado não comprovado** (§A.1)
- [x] plano futuro definido — arquitetura proposta + UX-01-A…G (§L/§M)
- [x] **nenhuma alteração de código de produção**
- [x] **nenhum PR aberto/criado**
- [x] **nenhum merge**
- [x] **nenhum impacto no Commerce** (o repositório proibido não foi lido, citado nem acessado)

---

## 23. INTEGRIDADE DO ESCOPO

Problemas encontrados **fora do escopo** desta auditoria foram **registrados e não corrigidos**: gaps de domínio em Estoque (transferências, reserva, vínculo venda→estoque), Relatórios (11 de ~19), administração de importação central, WooCommerce sem navegação, dependências externas de Fiscal/Logística (credenciais), 3 derivações de RBAC no servidor, e o `fixes-bloco-a.patch` na raiz. Nenhum arquivo de produção, banco, migration, Prisma, autenticação, Commerce, BI, financeiro, fiscal ou logística foi tocado neste ciclo.

---

## 24. SAÍDA FINAL

**STATUS: 🟢 AUDITORIA COMPLETA**
*(com uma ressalva declarada: o artefato publicado e o cache do navegador do usuário **não** são observáveis pelo repositório — §J. Todo o restante foi provado por código, por execução do componente ou pelo histórico do Git.)*

1. **Por que o menu antigo aparece** — O menu que o usuário vê **é o menu do `main`**: um único shell e um único `Sidebar`. Ele é “antigo” porque (a) **o grupo Fiscal, criado em 2026-10-11, nunca foi ligado no `Sidebar`** (4 módulos com rota, tela, API, RBAC e teste e **zero** item de menu — `UX01-P0-01`); (b) **os gates não leem o renderizador** (`audit:menu` e `modules.test.ts` validam a declaração, não o que a tela monta — `UX01-P0-02`), então a divergência passou verde; (c) a moldura da primeira tela ainda se chama **“Dashboard”**; e (d) **a estrutura de 6 áreas da especificação nunca foi implementada** — não existe menu novo, oculto ou atrás de flag. *Vetor adicional, **não comprovado**: bundle antigo por service worker/cache ou deploy de commit anterior — verificação indicada em §A.1/§J.*
2. **Shell atual** — `client/src/components/Layout.tsx` (header + sidebar + main + CommandPalette), montado pela rota protegida `/` (`App.tsx:63-72`).
3. **Menu atual** — `client/src/components/Sidebar.tsx`, alimentado por `client/src/modules.ts` e por **3 listas locais de grupos** (`Sidebar.tsx:25,36,38`): 12 grupos, 66 itens (admin), 62 (gerente), 42 (operador).
4. **Rota inicial** — `/` → `pages/Dashboard.tsx` = **Meu Negócio**.
5. **Estado do Meu Negócio** — **PARCIAL**: integrado ao shell único (SIM); “shell definitivo” inexistente e nome antigo na moldura (NÃO).
6. **Quantidade de rotas** — **83 entradas** (6 públicas · 68 de módulo · 7 telas explícitas · 1 raiz · 1 catch-all) para 82 caminhos distintos.
7. **Quantidade de itens de menu** — **70 declarados**; **66 renderizados** (admin) · 62 (gerente) · 42 (operador).
8. **Quantidade de órfãos** — **4 módulos** declarados sem renderização (Fiscal) + **1 rota** intencionalmente fora do menu (`/dev/componentes`) + 5 rotas-filhas contextuais + 6 rotas públicas (por desenho). Órfãos problemáticos: **4**.
9. **Quantidade de duplicidades** — **9** (G1–G9), sendo 4 desnecessárias, 2 legadas, 2 ambíguas e 1 necessária.
10. **Gaps** — **P0: 3** · **P1: 10** · **P2: 6** · **P3: 4** (total 23).
11. **RBAC** — menu filtrado no cliente por perfil/`adminOnly`/`minPerfil` (+`perm_politicas`); servidor autoritativo por `checkAccess`/`checkFluxo` + escopo de empresa; **0** itens visíveis sem autorização; **4** itens escondidos incorretamente (Fiscal); **3** derivações soltas (menu restringe, API não).
12. **Multiempresa** — escopo aplicado no servidor (claim `emp` revalidada, 404 entre empresas) e conteúdo remontado na troca de empresa; **não há vazamento cruzado identificado**; o **menu não é empresa-aware** (registrado como P1).
13. **Arquitetura proposta** — shell único (`AppShell`), menu em **6 áreas + 4 transversais** com subgrupos de 2 níveis, trilha clicável derivada de `MODULES`, RBAC derivado do `/api/meta`, escopo de empresa visível, rotas geradas de uma fonte, plano de remoção de legado e de limpeza de service worker (§L).
14. **Plano UX-01** — A (Shell) · B (Menu) · C (Rotas) · D (RBAC) · E (Migração do legado) · F (Testes) · G (Validação visual) — §M, **nada executado**.
15. **Arquivos analisados** — 112 arquivos/36.669 linhas no `client/src`; 84 arquivos no `server/src`; 26 arquivos de teste de front (262 testes) e 78 de servidor; 3 scripts; 1 workflow; `render.yaml`; `package.json` (raiz, client, server); `prisma/schema.prisma` (por referência documental); 29 documentos em `docs/` (com leitura integral de `ERP-MASTER-MAP.md` e consulta de `MEU-NEGOCIO-MOTOR-ANALITICO.md`, `RELATORIO-ERP-01.md`, `AUDITORIA-INTERFACE-2026-09-09.md`).
16. **Arquivos alterados — NENHUM.** O único artefato produzido é este relatório (`docs/RELATORIO-ERP-UX-01.md`). O build executado para prova gerou `client/dist/` (ignorado pelo `.gitignore`) e foi **removido** ao final; `git status` está limpo.

---

## ANEXO — comandos e provas reproduzíveis

```bash
# Estado do repositório auditado
git rev-parse HEAD                     # 649e0462a2f7f5217ab5f0c10c2d5ddd6752df92 (= main em origin)
gh pr list --state open                # (vazio)

# Gates existentes
npm run audit:menu                     # 0 erros · 4 avisos (3 RBAC_DERIVA_SOLTA + 1 ROTA_PUBLICA)
npm --workspace client test            # 26 arquivos · 262 testes ✅
npm run build                          # ✅ 320,95 kB (95,53 kB gzip) · PWA generateSW · 59 precache

# Prova do menu real (componente executado em jsdom, fora do repositório)
#   admin    -> 12 grupos / 66 itens   (sem grupo Fiscal, sem /documentos-fiscais,/regras-fiscais,/ncm,/inutilizacoes)
#   gerente  -> 12 grupos / 62 itens
#   operador -> 10 grupos / 42 itens
#   [header /]                   BROBOND ERP Dashboard
#   [header /produtos/12]        BROBOND ERP / Cadastros / Produtos
#   [header /documentos-fiscais] BROBOND ERP / Fiscal / Documentos fiscais   <- grupo que a sidebar não mostra

# História da navegação
gh api "repos/petrickmsilva-alt/brobond-erp/commits?path=client/src/components/Sidebar.tsx&per_page=4"
#   2026-10-08  6cc5ee32  feat(frontend): navegação por áreas de negócio e seletor de empresa ativa
gh api repos/petrickmsilva-alt/brobond-erp/commits/876c46c4   # ERP-05 (2026-10-11): modules.ts + tests + telas — SEM Sidebar.tsx
```

**Limitação declarada (1):** não houve captura de tela nem acesso ao ambiente publicado; todo achado visual é uma **renderização de DOM reproduzida do código**, não uma observação do sistema em produção.

**FIM DO RELATÓRIO ERP-UX-01**
