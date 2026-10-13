# ERP-UX-02 — Auditoria da árvore completa do sistema

**Data:** 2026-10-13 (UTC) · **Modo:** READ-ONLY, com uma única entrega documental.
**Status da planta de produto:** **READY FOR IMPLEMENTATION**, sujeito à revisão independente e aos gates de acesso descritos neste documento. **Não significa sistema homologado, autorização de deploy ou autorização para implementar neste ciclo.**

> **P0 não corrigidos:** ausência de escopo de empresa em seis conjuntos de APIs especializadas; contrato divergente entre menu, URL e API; operação de PDV dependente de caixa vedado ao operador. A qualificação é estática: não houve exploração nem acesso a dados de produção. Ver §6.2/§6.2.1 e UX02-01–03.

**Guia de leitura:** estado/metodologia §1–2 · árvore atual/inventário §3–4 · planta/matriz completa §5 · acesso/órfãos/legado §6 · grafo e jornadas §7 · nomenclatura §8 · problemas §9 · riscos/gates/requisitos/aceite §10–14 · APIs/Resources/branches/models nos Anexos A–E.

## 1. Estado da auditoria e identificação imutável

| Item | Estado registrado antes da análise |
|---|---|
| Repositório obrigatório | `petrickmsilva-alt/brobond-erp` — `https://github.com/petrickmsilva-alt/brobond-erp` |
| Checkout | `/home/user/brobond-erp` |
| Branch de trabalho | `arena/336daf2e-brobond-erp` |
| HEAD | `26d39fbb0193f61d60033e7033fb7f72bd72fe85` |
| Base do ciclo / merge-base com main | `26d39fbb0193f61d60033e7033fb7f72bd72fe85` |
| main e origin/main na abertura | Mesmo SHA do HEAD; main remoto novamente confirmado via GitHub durante a auditoria |
| Working tree inicial | Limpa; `git status --short` vazio, sem diferenças contra a base |
| PRs abertos | **0**, confirmado na abertura e no fechamento do ciclo |
| Último PR consultado | [PR #56](https://github.com/petrickmsilva-alt/brobond-erp/pull/56), “ERP-03 — PostgreSQL official gate for ERP Core”, **MERGED** em 2026-10-13T12:24:06Z |
| Dependências locais | `node_modules` ausente; Node 22.22.3 / npm 10.9.8; `tsx` indisponível |
| Efeito autorizado | Somente criação de `docs/RELATORIO-ERP-UX-02.md`; nenhum relatório equivalente UX-02 encontrado |

**Restrições preservadas:** nenhum código, menu, Sidebar, Layout, router, contrato de recurso, RBAC, endpoint, banco, migration, visual ou arquivo de implementação alterado. Nenhuma dependência instalada. Nenhum serviço iniciado; nenhuma conexão a banco ou API de produção; nenhum PR, commit, push ou merge. As consultas GitHub foram de leitura. Os artefatos intermediários de análise ficaram fora do repositório e não são entregáveis.

### 1.1 Reconciliação de branches paralelas

Foram enumeradas **40 branches remotas: main + 39 outras**. Comparação GitHub `main...branch`: **34 behind**, sem commit exclusivo; **5 diverged**, com **7 ocorrências de commits à frente, 6 SHAs exclusivos distintos** — um SHA aparece em duas branches. O inventário nominal completo está no Anexo D. Não foram incorporadas alterações dessas branches.

| Branch divergente | Ahead / behind | Conteúdo exclusivo na comparação de grafo | Consequência para UX-02 |
|---|---:|---|---|
| `arena/a13793a8-brobond-erp` | 1 / 62 | `0b38968ba555` — auditoria E4.2.2 da expedição, apenas docs; `ERP-GAPS.md` e relatório E4.2.2 | Esse relatório não está no HEAD. A expedição atual tem ciclo posterior E4.2.3; não tratar o texto antigo como comportamento atual |
| `arena/ede50548-brobond-erp` | 1 / 91 | `e8522f517ddb` — backup diário PostgreSQL, advisory lock e alterações de schema/CI/scripts | Os arquivos de backup/lock propostos estão ausentes do HEAD. O patch de backup na raiz não é implementação aplicada |
| `arena/8e2d8964-brobond-erp` | 3 / 110 | `dfcfdea3c4dc`, `ea8e4df347f3`, `97a262a25224` — conectores e CI | [PR #39](https://github.com/petrickmsilva-alt/brobond-erp/pull/39) já MERGED. Divergência de SHA não prova que o efeito funcional esteja pendente: pode haver integração por squash/revisão posterior |
| `arena/55029ae7-brobond-erp` | 1 / 110 | `dfcfdea3c4dc` — correção antiga de conexões ML/MP/TikTok | [PR #38](https://github.com/petrickmsilva-alt/brobond-erp/pull/38) CLOSED, não mergeado. TikTok nativo foi posteriormente removido no main |
| `arena/0430101b-brobond-erp` | 1 / 107 | `b35858e858fe` — hub de conectores/menu Commerce, Sidebar, UI e páginas | Alternativa histórica de navegação; não é uma segunda Sidebar ativa. Não restaurar sobre o contrato atual por cherry-pick automático |

**Critério de verdade:** somente o HEAD identificado acima é a implementação auditada. Ahead/behind é informação de grafo, não um veredito de equivalência funcional. Arquivos e commits das cinco comparações foram conferidos via GitHub; nenhuma troca de branch ou aplicação de patch.

## 2. Metodologia, alcance e limitações

### 2.1 Fontes confrontadas

1. **Registro de navegação:** `client/src/modules.ts`, incluindo os 70 objetos, `MODULE_GROUPS`, `GROUP_META`, `NAV_SECTIONS`, `visibleModules`, `moduleOfPath`, `DETALHE_DIRETO` e `PAGES_ESPECIAIS`.
2. **Renderização e destinos:** `App.tsx`, Sidebar, Layout, CommandPalette, CompanySwitcher, **todos os 37 arquivos de páginas TSX não-testes**, dispatcher de ModulePage e componentes de subfunção (importação, catálogo/compartilhamento/inteligência, portal, formulários, recebimento, etiquetas etc.). Rotas públicas, desenvolvimento, detalhes, hashes/query strings e navegação por links também entram no recorte.
3. **Backend:** todas as declarações de endpoints em `server/src/**/*.ts`, routers montados, handlers e contratos; `resources.ts`, `services.ts`, auth/security/empresa e domínios. Conectores em `modules/connectors`, ingestão, gateway e superfície Socket.IO foram mapeados separadamente.
4. **Dados/relações:** contratos de campos e referências de **80 recursos centrais**, **8 contratos locais internos**, schema SQL, migrations, schema Prisma e serviços de fluxo. Declaração de `ref` não foi confundida com prova de FK ou com execução da relação.
5. **Produto/documentação:** pedido UX-02 e suas seis áreas de referência; `ERP-MASTER-MAP.md`, `ERP-GAPS.md`, `ERP-CORE-ROADMAP.md`, `RELATORIO-ERP-ONLY.md`, UX-01/UX-01-AB, relatórios ERP/E4, ADR de faturamento, documentação de BI, integração da loja e README. A especificação operacional disponível é distribuída nesses documentos; não foi presumido um arquivo externo de especificação não fornecido.
6. **Qualidade:** script `scripts/auditar-menu.ts`, scripts de smoke/PG, CI e testes encontrados — **28 arquivos frontend e 81 arquivos em server/test**, além de testes dos packages. Foram lidas as expectativas relevantes; nenhum resultado histórico foi transformado em execução atual.
7. **Fontes alternativas:** Ajuda, atalhos PWA, links do shell/BI/detalhes, callback HTML OAuth, Swagger/OpenAPI, fallback PlannedModule, código de SW não ligado ao build e patch na raiz.

**Extração sem instalar dependências:** Node nativo removeu tipos e avaliou somente metadados literais de módulos em memória, com os ícones substituídos por nomes inertes; o arquivo de recursos foi carregado como definição de dados. Não foi importado o boot da API. A extração de endpoints foi cruzada com as declarações ancoradas em código, os mounts, a constante da rota Instagram e a ordem dos middlewares; a heurística inicial de handler foi substituída por associação limitada à própria declaração. São **298 registros distintos verbo/template**, não 298 chamadas executadas.

**Convenção de evidência:** nomes de arquivo abreviados nos quadros se referem às fontes de §2.1: domínios backend em `server/src`, navegação/páginas/componentes em `client/src` e documentos em `docs`. `modules.ts` é o registro frontend, `index.ts` nas evidências de API é `server/src/index.ts`, e `auditar-menu.ts` está em `scripts`. Caminhos completos prevalecem; arquivos não presentes no HEAD são explicitamente marcados como ausentes. O Anexo C fornece caminho completo e linha de declaração/handler para cada API.

### 2.2 O que foi e o que não foi executado

| Verificação | Resultado neste ciclo |
|---|---|
| Git/status/diff/base, leitura de arquivos e consultas GitHub | Executados, somente leitura |
| Inventário estático independente de módulos, páginas, recursos, APIs e branches | Executado; contagens reconciliadas nos anexos |
| `npm run audit:menu` | **Tentado: exit 1 ANTES da auditoria**, `ERR_MODULE_NOT_FOUND: Cannot find package 'tsx' imported from /home/user/brobond-erp/` |
| Instalação para destravar o comando | **Não feita**, conforme proibição do usuário |
| Testes, typecheck, lint, build, smokes DEMO/PG e migrações | **Não executados**; exigem dependências e/ou boot/banco; fora do ciclo read-only |
| Navegador/screenshot de desktop/tablet/mobile | **Não executado**; nenhum Chromium/Chrome/Firefox localizado. Requisitos e riscos abaixo derivam do código, não de imagens fabricadas |
| Produção / métricas de uso / credenciais de provedores | Não acessadas; volume e frequência reais de uso não conhecidos |
| `git diff --check` e conferência do escopo final | Executados ao finalizar o documento |

O resultado verde de `audit:menu` em UX-01-AB é **evidência histórica**, não o resultado deste ciclo. A classificação REAL significa **existência de rota/página/handler no HEAD**, não homologação de produção. Erros 403/405/409 descritos são inferências determinísticas do código quando explicitamente indicado; não foram produzidos por testes HTTP nesta sessão.

### 2.3 Definições e denominadores

- **Módulo:** objeto em MODULES. Uma aba, modal, entidade interna ou API não adiciona um módulo automaticamente.
- **Rota/destino frontend:** padrão nomeado de página. **82 = 70 destinos de módulos + 5 detalhes + 1 dev + 6 públicos**. Shell `/` e fallback `*` não são destinos adicionais; hashes/query strings/abas não foram somados como rotas.
- **API:** registro de verbo/template HTTP montado. ALL conta **um registro**, sem expansão de verbos; templates `:resource` não são multiplicados pelos recursos. Middleware CORS/OPTIONS, pass-through `all` do Instagram, arquivos estáticos, fallback SPA e Socket.IO não são novas APIs de negócio no total 298.
- **Resource central:** entrada em RESOURCES: **80 = 46 públicos + 34 internos**, **62 com `empresa: true`**. “Público” nesse contexto significa exposto no CRUD autenticado, não anônimo. Mais 8 contratos internos locais, fora de RESOURCES, totalizam **88 definições de Resource** encontradas.
- **REAL:** existe implementação; pode ser parcial ou possuir defeitos de navegação/RBAC.
- **PLANNED:** intenção declarada sem função de domínio. Os 8 existentes têm páginas de roadmap, não CRUD/integração funcional.
- **ORPHAN:** destino gerado sem rota ou função de backend sem superfície de produto. Ausência de menu, sozinha, não caracteriza órfão: detalhes, públicos, ações e infraestrutura têm acesso legítimo fora da Sidebar.
- **DUPLICADO:** distinguir identidade/path duplicado, rótulo ambíguo, alias compatível, visão alternativa e duplicação de verdade operacional. Não são a mesma métrica.
- **LEGACY:** legado explícito ou compatibilidade anterior ainda ativa; candidatos à limpeza são marcados à parte, sem supor código morto em runtime.
- **FORA DO CORE:** Commerce/Creators; não significa removido do monorepo. Bibliotecas, callbacks e administração técnica não viram novas áreas operacionais.

### 2.4 Totais auditados

| Dimensão | Total / interpretação |
|---|---|
| Módulos / grupos / seções atuais | **70 / 13 / 3**; raiz Meu Negócio fora dos grupos; não há subgrupo modelado |
| Não-planned / planned | **62 / 8**; 27 módulos com página dedicada/dispatcher, 35 com CRUD genérico, 8 roadmaps |
| Visibilidade estática padrão | **admin 70 / gerente 66 / operador 43**; operador com `perm_politicas=permitir` ganha esse item; não representa autorização efetiva de API |
| Páginas fonte / destinos frontend | **37 arquivos TSX / 82 destinos** |
| Destinos fora de MODULES | **12** legítimos: 5 detalhes, 1 dev, 6 públicos; não são bugs por não estar no menu |
| APIs | **298 registros**: index 285 + connectors 10 + gateway público 1 + Instagram 2; GET 129, POST 137, PUT 17, PATCH 1, DELETE 12, ALL 2 |
| Fronteira de sessão das APIs | **275 autenticados / 23 registrados antes da sessão ERP**; estes últimos usam token, assinatura/state, rate limit ou autenticação de login conforme família |
| Recursos | **80 centrais (46/34)** + **8 internos locais** |
| Órfãos de navegação confirmados | **4 famílias de URL gerada**: `/listas_preco/:id`, `/propostas/:id`, `/pdv_caixas/:id`, `/conectores` |
| Backend sem superfície funcional completa | **13 famílias** em §6.3; algumas convivem com página parcial. Não somar com URLs: há sobreposição de domínio |
| Contratos internos sem consumidor funcional localizado | **2**: `fornecedor_contatos`, `produto_composicao`; não implicam criação de menu próprio |
| Duplicidades de identidade / path de módulo / registro verbo-template API | **0 / 0 / 0** |
| Ambiguidades exatas de label | **2 rótulos repetidos**: Produtos e Categorias; domínios distintos, não duplicidade de dado |
| Legado e paralelismo | **1 família explicitamente LEGACY** (marketplace por token), **2 famílias de API paralelas/compatibilidade** (NF-e e frete/CEP); **3 artefatos candidatos à limpeza** (SW fonte, helper sem consumidor, patch não aplicado); **0 segunda Sidebar ativa** |
| Problemas priorizados | **29: P0 3 · P1 12 · P2 10 · P3 4** |

## 3. Árvore ATUAL — o que o sistema realmente declara

O A/B de UX-01 corrigiu a deriva de grupos da Sidebar e o breadcrumb. **Fiscal já existe**, com quatro módulos; NCM, Inutilizações, Comissões e Empresas já têm tela. Não repetir os gaps antigos como se ainda faltassem esses itens. O A/B **não** implementou a árvore definitiva por produto nem subgrupos.

Fontes: `modules.ts:41–358`, `Sidebar.tsx:50–154`, `App.tsx:60–87`, `ModulePage.tsx:84–115`. A ordem visual é MODULE_GROUPS, não a ordem bruta de todos os objetos MODULES. “ERP” e “Commerce / Integrações” são seções; os 13 nomes abaixo são grupos tratados pelo shell como áreas. Não existe hoje o nível Área → Grupo → Subgrupo completo.

```text
BROBOND ERP [shell autenticado]
├─ Meu Negócio [dashboard] /
├─ ERP [erp]
│  ├─ Cadastros (8)
│  │  ├─ Produtos [produtos] /produtos
│  │  ├─ Categorias [categorias] /categorias
│  │  ├─ Cores [cores] /cores
│  │  ├─ Insumos [insumos] /insumos
│  │  ├─ Tamanhos [tamanhos] /tamanhos
│  │  ├─ Grade [grades] /grades
│  │  ├─ Tabela de Medidas [medidas] /medidas
│  │  └─ Coleções [colecoes] /colecoes
│  ├─ Vendas (9)
│  │  ├─ Vendas [vendas] /vendas
│  │  ├─ Políticas comerciais [politicas-comerciais] /politicas-comerciais
│  │  ├─ Clientes [clientes] /clientes
│  │  ├─ Representantes [representantes] /representantes
│  │  ├─ Catálogos públicos [catalogos] /catalogos
│  │  ├─ Listas de preço [listas-preco] /listas-preco
│  │  ├─ Propostas comerciais [propostas] /propostas
│  │  ├─ Caixas do PDV [pdv-caixas] /pdv-caixas
│  │  └─ PDV — venda balcão [pdv] /pdv
│  ├─ Compras (7)
│  │  ├─ Compras [compras] /compras
│  │  ├─ Fornecedores [fornecedores] /fornecedores
│  │  ├─ Cotação de compra [cotacoes-compra] /cotacoes-compra
│  │  ├─ Recebimentos de compra [compra-recebimentos] /compra-recebimentos
│  │  ├─ Importar NF-e de entrada [importar-nfe-compra] /importar-nfe-compra
│  │  ├─ De-Para de produtos [depara-fornecedor] /depara-fornecedor
│  │  └─ Sugestão de compra [sugestao-compra] /sugestao-compra
│  ├─ Estoque (4)
│  │  ├─ Estoque Físico [estoque] /estoque
│  │  ├─ Movimentações [movimentacoes] /movimentacoes
│  │  ├─ Locais de Estoque [locais] /locais
│  │  └─ Inventário [inventario] /inventario
│  ├─ Produção (4)
│  │  ├─ Ficha Técnica / BOM [fichas] /fichas
│  │  ├─ Cadeias de Fabricação [ordens] /ordens
│  │  ├─ Planejamento de Produção [planejamento-producao] /planejamento-producao
│  │  └─ Custos [custo] /custo
│  ├─ Logística & Expedição (4)
│  │  ├─ Expedição [expedicao] /expedicao
│  │  ├─ Divergências de conferência [divergencias] /divergencias
│  │  ├─ Logística e envios [envios] /envios
│  │  └─ Devoluções e reversa [devolucoes] /devolucoes
│  ├─ Financeiro (10)
│  │  ├─ Financeiro [financeiro] /financeiro
│  │  ├─ Lançamentos [lancamentos] /lancamentos
│  │  ├─ Categorias [categorias-financeiras] /categorias-financeiras
│  │  ├─ Contas [contas-financeiras] /contas-financeiras
│  │  ├─ Transferências [transferencias] /transferencias
│  │  ├─ Centros de custo [centros-custo] /centros-custo
│  │  ├─ Investidores / Sócios [investidores] /investidores
│  │  ├─ Aportes [aportes] /aportes
│  │  ├─ Comissões [comissoes] /comissoes
│  │  └─ Recolhimentos e recorrências [recorrencias-financeiras] /recorrencias-financeiras
│  ├─ Fiscal (4)
│  │  ├─ Documentos fiscais [documentos-fiscais] /documentos-fiscais
│  │  ├─ Regras fiscais [regras-fiscais] /regras-fiscais
│  │  ├─ NCM / Tributação [ncm] /ncm
│  │  └─ Inutilizações [inutilizacoes] /inutilizacoes
│  └─ Relatórios (1)
│     └─ Relatórios [relatorios] /relatorios
├─ Commerce / Integrações [commerce]
│  ├─ Integrações (5)
│  │  ├─ Mercado Livre [conector-mercadolivre] /conectores/mercado-livre [conector REAL]
│  │  ├─ Mercado Pago [conector-mercadopago] /conectores/mercado-pago [conector REAL]
│  │  ├─ Nuvemshop [conector-nuvemshop] /conectores/nuvemshop [conector REAL]
│  │  ├─ Instagram Shopping [conector-instagram] /conectores/instagram [conector REAL]
│  │  └─ Webhooks [webhooks] /webhooks
│  ├─ Gestão de Commerce (4)
│  │  ├─ Produtos [commerce-produtos] /commerce/produtos [PLANNED]
│  │  ├─ Pedidos [commerce-pedidos] /commerce/pedidos [PLANNED]
│  │  ├─ Trends [commerce-trends] /commerce/trends [PLANNED]
│  │  └─ 📦 Delivery [commerce-delivery] /commerce/delivery [PLANNED]
│  └─ Ecossistema Creators (4)
│     ├─ Creators [creators] /creators [PLANNED]
│     ├─ Matches [creator-matches] /matches [PLANNED]
│     ├─ Outreach AI [outreach-ai] /outreach-ai [PLANNED]
│     └─ Campanhas [campanhas] /campanhas [PLANNED]
└─ (seção sistema, sem título visível) [sistema]
   └─ Configurações (5)
      ├─ Empresas [empresas] /empresas
      ├─ Usuários [usuarios] /usuarios
      ├─ Auditoria [auditoria] /auditoria
      ├─ Configurações [config] /config
      └─ Ajuda [ajuda] /ajuda
```

### 3.1 Inventário exaustivo dos 70 módulos atuais

Campos abaixo são **literais atuais**, não recomendação. `—` em resource/minPerfil/adminOnly significa ausência do atributo; o perfil efetivo da API deve ser lido em §6/Anexo B. P = página dedicada, G = ResourceCrud genérico, R = roadmap CommerceModulePage. Ícone é nome da referência declarada, não redesign. As APIs e dependências por módulo estão na matriz §5.3; quando resource está vazio uma página pode consumir vários recursos reais.

| # | Label atual | id | path | group | section | resource literal | minPerfil | adminOnly | planned | connector | Página | Status / fonte |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | Meu Negócio | `dashboard` | `/` | raiz | raiz | — | — | — | — | — | P / `Dashboard.tsx` | REAL; modules.ts:85 |
| 2 | Produtos | `produtos` | `/produtos` | Cadastros | erp | `produtos` | — | — | — | — | G / `ModulePage.tsx / ResourceCrud` | REAL; modules.ts:95 |
| 3 | Categorias | `categorias` | `/categorias` | Cadastros | erp | `categorias` | — | — | — | — | G / `ModulePage.tsx / ResourceCrud` | REAL; modules.ts:96 |
| 4 | Cores | `cores` | `/cores` | Cadastros | erp | `cores` | — | — | — | — | G / `ModulePage.tsx / ResourceCrud` | REAL; modules.ts:97 |
| 5 | Insumos | `insumos` | `/insumos` | Cadastros | erp | `insumos` | — | — | — | — | G / `ModulePage.tsx / ResourceCrud` | REAL; modules.ts:98 |
| 6 | Tamanhos | `tamanhos` | `/tamanhos` | Cadastros | erp | `tamanhos` | — | — | — | — | G / `ModulePage.tsx / ResourceCrud` | REAL; modules.ts:99 |
| 7 | Grade | `grades` | `/grades` | Cadastros | erp | `grades` | — | — | — | — | G / `ModulePage.tsx / ResourceCrud` | REAL; modules.ts:100 |
| 8 | Tabela de Medidas | `medidas` | `/medidas` | Cadastros | erp | — | — | — | — | — | P / `MedidasPage.tsx` | REAL; modules.ts:101 |
| 9 | Coleções | `colecoes` | `/colecoes` | Cadastros | erp | `colecoes` | — | — | — | — | G / `ModulePage.tsx / ResourceCrud` | REAL; modules.ts:102 |
| 10 | Ficha Técnica / BOM | `fichas` | `/fichas` | Produção | erp | `fichas` | — | — | — | — | G / `ModulePage.tsx / ResourceCrud` | REAL; modules.ts:103 |
| 11 | Cadeias de Fabricação | `ordens` | `/ordens` | Produção | erp | `ordens` | — | — | — | — | G / `ModulePage.tsx / ResourceCrud` | REAL; modules.ts:106 |
| 12 | Planejamento de Produção | `planejamento-producao` | `/planejamento-producao` | Produção | erp | — | — | — | — | — | P / `PlanejamentoProducaoPage.tsx` | REAL; modules.ts:107 |
| 13 | Custos | `custo` | `/custo` | Produção | erp | — | — | — | — | — | P / `CustoPage.tsx` | REAL; modules.ts:115 |
| 14 | Estoque Físico | `estoque` | `/estoque` | Estoque | erp | — | — | — | — | — | P / `EstoqueGradePage.tsx` | REAL; modules.ts:123 |
| 15 | Movimentações | `movimentacoes` | `/movimentacoes` | Estoque | erp | `movimentacoes` | — | — | — | — | G / `ModulePage.tsx / ResourceCrud` | REAL; modules.ts:124 |
| 16 | Locais de Estoque | `locais` | `/locais` | Estoque | erp | `locais` | — | — | — | — | G / `ModulePage.tsx / ResourceCrud` | REAL; modules.ts:125 |
| 17 | Inventário | `inventario` | `/inventario` | Estoque | erp | — | — | — | — | — | P / `InventarioModulePage.tsx` | REAL; modules.ts:126 |
| 18 | Mercado Livre | `conector-mercadolivre` | `/conectores/mercado-livre` | Integrações | commerce | — | gerente | — | — | MERCADOLIVRE | P / `ConectorPage.tsx` | REAL; modules.ts:136 |
| 19 | Mercado Pago | `conector-mercadopago` | `/conectores/mercado-pago` | Integrações | commerce | — | gerente | — | — | MERCADOPAGO | P / `ConectorPage.tsx` | REAL; modules.ts:146 |
| 20 | Nuvemshop | `conector-nuvemshop` | `/conectores/nuvemshop` | Integrações | commerce | — | gerente | — | — | NUVEMSHOP | P / `ConectorPage.tsx` | REAL; modules.ts:156 |
| 21 | Instagram Shopping | `conector-instagram` | `/conectores/instagram` | Integrações | commerce | — | gerente | — | — | INSTAGRAM | P / `ConectorPage.tsx` | REAL; modules.ts:167 |
| 22 | Produtos | `commerce-produtos` | `/commerce/produtos` | Gestão de Commerce | commerce | — | — | — | true / 3 itens | — | R / `CommerceModulePage.tsx` | PLANNED; modules.ts:183 |
| 23 | Pedidos | `commerce-pedidos` | `/commerce/pedidos` | Gestão de Commerce | commerce | — | — | — | true / 3 itens | — | R / `CommerceModulePage.tsx` | PLANNED; modules.ts:184 |
| 24 | Trends | `commerce-trends` | `/commerce/trends` | Gestão de Commerce | commerce | — | — | — | true / 3 itens | — | R / `CommerceModulePage.tsx` | PLANNED; modules.ts:185 |
| 25 | 📦 Delivery | `commerce-delivery` | `/commerce/delivery` | Gestão de Commerce | commerce | — | — | — | true / 3 itens | — | R / `CommerceModulePage.tsx` | PLANNED; modules.ts:186 |
| 26 | Creators | `creators` | `/creators` | Ecossistema Creators | commerce | — | — | — | true / 3 itens | — | R / `CommerceModulePage.tsx` | PLANNED; modules.ts:189 |
| 27 | Matches | `creator-matches` | `/matches` | Ecossistema Creators | commerce | — | — | — | true / 3 itens | — | R / `CommerceModulePage.tsx` | PLANNED; modules.ts:190 |
| 28 | Outreach AI | `outreach-ai` | `/outreach-ai` | Ecossistema Creators | commerce | — | — | — | true / 3 itens | — | R / `CommerceModulePage.tsx` | PLANNED; modules.ts:191 |
| 29 | Campanhas | `campanhas` | `/campanhas` | Ecossistema Creators | commerce | — | — | — | true / 3 itens | — | R / `CommerceModulePage.tsx` | PLANNED; modules.ts:192 |
| 30 | Vendas | `vendas` | `/vendas` | Vendas | erp | `vendas` | — | — | — | — | G / `ModulePage.tsx / ResourceCrud` | REAL; modules.ts:195 |
| 31 | Políticas comerciais | `politicas-comerciais` | `/politicas-comerciais` | Vendas | erp | `politicas_comerciais` | gerente | — | — | — | G / `ModulePage.tsx / ResourceCrud` | REAL; modules.ts:196 |
| 32 | Clientes | `clientes` | `/clientes` | Vendas | erp | `clientes` | — | — | — | — | G / `ModulePage.tsx / ResourceCrud` | REAL; modules.ts:197 |
| 33 | Representantes | `representantes` | `/representantes` | Vendas | erp | `representantes` | — | — | — | — | G / `ModulePage.tsx / ResourceCrud` | REAL; modules.ts:198 |
| 34 | Catálogos públicos | `catalogos` | `/catalogos` | Vendas | erp | `catalogos` | — | — | — | — | G / `ModulePage.tsx / ResourceCrud` | REAL; modules.ts:199 |
| 35 | Documentos fiscais | `documentos-fiscais` | `/documentos-fiscais` | Fiscal | erp | `documentos_fiscais` | — | — | — | — | G / `ModulePage.tsx / ResourceCrud` | REAL; modules.ts:201 |
| 36 | Regras fiscais | `regras-fiscais` | `/regras-fiscais` | Fiscal | erp | `regras_fiscais` | gerente | — | — | — | G / `ModulePage.tsx / ResourceCrud` | REAL; modules.ts:202 |
| 37 | NCM / Tributação | `ncm` | `/ncm` | Fiscal | erp | `impostos_ncm` | gerente | — | — | — | P / `NcmPage.tsx` | REAL; modules.ts:203 |
| 38 | Inutilizações | `inutilizacoes` | `/inutilizacoes` | Fiscal | erp | `inutilizacoes_fiscais` | gerente | — | — | — | P / `InutilizacoesPage.tsx` | REAL; modules.ts:204 |
| 39 | Listas de preço | `listas-preco` | `/listas-preco` | Vendas | erp | `listas_preco` | gerente | — | — | — | G / `ModulePage.tsx / ResourceCrud` | REAL; modules.ts:205 |
| 40 | Propostas comerciais | `propostas` | `/propostas` | Vendas | erp | `propostas` | — | — | — | — | G / `ModulePage.tsx / ResourceCrud` | REAL; modules.ts:206 |
| 41 | Caixas do PDV | `pdv-caixas` | `/pdv-caixas` | Vendas | erp | `pdv_caixas` | gerente | — | — | — | G / `ModulePage.tsx / ResourceCrud` | REAL; modules.ts:207 |
| 42 | PDV — venda balcão | `pdv` | `/pdv` | Vendas | erp | — | — | — | — | — | P / `PdvPage.tsx` | REAL; modules.ts:208 |
| 43 | Compras | `compras` | `/compras` | Compras | erp | `compras` | — | — | — | — | G / `ModulePage.tsx / ResourceCrud` | REAL; modules.ts:211 |
| 44 | Fornecedores | `fornecedores` | `/fornecedores` | Compras | erp | `fornecedores` | — | — | — | — | G / `ModulePage.tsx / ResourceCrud` | REAL; modules.ts:212 |
| 45 | Cotação de compra | `cotacoes-compra` | `/cotacoes-compra` | Compras | erp | `cotacoes_compra` | — | — | — | — | P / `CotacoesCompraPage.tsx` | REAL; modules.ts:213 |
| 46 | Recebimentos de compra | `compra-recebimentos` | `/compra-recebimentos` | Compras | erp | `compra_recebimentos` | — | — | — | — | G / `ModulePage.tsx / ResourceCrud` | REAL; modules.ts:214 |
| 47 | Importar NF-e de entrada | `importar-nfe-compra` | `/importar-nfe-compra` | Compras | erp | — | gerente | — | — | — | P / `ImportarNfePage.tsx` | REAL; modules.ts:215 |
| 48 | De-Para de produtos | `depara-fornecedor` | `/depara-fornecedor` | Compras | erp | `produto_fornecedor_skus` | — | — | — | — | G / `ModulePage.tsx / ResourceCrud` | REAL; modules.ts:216 |
| 49 | Sugestão de compra | `sugestao-compra` | `/sugestao-compra` | Compras | erp | — | gerente | — | — | — | P / `SugestaoCompraPage.tsx` | REAL; modules.ts:217 |
| 50 | Expedição | `expedicao` | `/expedicao` | Logística & Expedição | erp | — | — | — | — | — | P / `ExpedicaoPage.tsx` | REAL; modules.ts:220 |
| 51 | Divergências de conferência | `divergencias` | `/divergencias` | Logística & Expedição | erp | `divergencias_conferencia` | — | — | — | — | G / `ModulePage.tsx / ResourceCrud` | REAL; modules.ts:221 |
| 52 | Logística e envios | `envios` | `/envios` | Logística & Expedição | erp | `envios` | gerente | — | — | — | P / `LogisticaPage.tsx` | REAL; modules.ts:222 |
| 53 | Devoluções e reversa | `devolucoes` | `/devolucoes` | Logística & Expedição | erp | `devolucoes` | — | — | — | — | P / `DevolucoesPage.tsx` | REAL; modules.ts:223 |
| 54 | Financeiro | `financeiro` | `/financeiro` | Financeiro | erp | — | gerente | — | — | — | P / `FinanceiroPage.tsx` | REAL; modules.ts:226 |
| 55 | Lançamentos | `lancamentos` | `/lancamentos` | Financeiro | erp | `lancamentos_financeiros` | gerente | — | — | — | G / `ModulePage.tsx / ResourceCrud` | REAL; modules.ts:235 |
| 56 | Categorias | `categorias-financeiras` | `/categorias-financeiras` | Financeiro | erp | `categorias_financeiras` | gerente | — | — | — | G / `ModulePage.tsx / ResourceCrud` | REAL; modules.ts:236 |
| 57 | Contas | `contas-financeiras` | `/contas-financeiras` | Financeiro | erp | `contas_financeiras` | gerente | — | — | — | G / `ModulePage.tsx / ResourceCrud` | REAL; modules.ts:237 |
| 58 | Transferências | `transferencias` | `/transferencias` | Financeiro | erp | `transferencias_financeiras` | gerente | — | — | — | G / `ModulePage.tsx / ResourceCrud` | REAL; modules.ts:238 |
| 59 | Centros de custo | `centros-custo` | `/centros-custo` | Financeiro | erp | `centros_custo` | gerente | — | — | — | G / `ModulePage.tsx / ResourceCrud` | REAL; modules.ts:239 |
| 60 | Investidores / Sócios | `investidores` | `/investidores` | Financeiro | erp | `investidores` | gerente | — | — | — | G / `ModulePage.tsx / ResourceCrud` | REAL; modules.ts:240 |
| 61 | Aportes | `aportes` | `/aportes` | Financeiro | erp | `aportes` | gerente | — | — | — | G / `ModulePage.tsx / ResourceCrud` | REAL; modules.ts:241 |
| 62 | Comissões | `comissoes` | `/comissoes` | Financeiro | erp | — | gerente | — | — | — | P / `ComissoesPage.tsx` | REAL; modules.ts:242 |
| 63 | Recolhimentos e recorrências | `recorrencias-financeiras` | `/recorrencias-financeiras` | Financeiro | erp | `recorrencias_financeiras` | gerente | — | — | — | G / `ModulePage.tsx / ResourceCrud` | REAL; modules.ts:252 |
| 64 | Relatórios | `relatorios` | `/relatorios` | Relatórios | erp | — | — | — | — | — | P / `RelatoriosPage.tsx` | REAL; modules.ts:255 |
| 65 | Empresas | `empresas` | `/empresas` | Configurações | sistema | — | admin | — | — | — | P / `EmpresasPage.tsx` | REAL; modules.ts:263 |
| 66 | Usuários | `usuarios` | `/usuarios` | Configurações | sistema | `usuarios` | — | true | — | — | P / `UsuariosPage.tsx` | REAL; modules.ts:273 |
| 67 | Auditoria | `auditoria` | `/auditoria` | Configurações | sistema | `auditoria` | — | true | — | — | G / `ModulePage.tsx / ResourceCrud` | REAL; modules.ts:274 |
| 68 | Webhooks | `webhooks` | `/webhooks` | Integrações | commerce | — | — | true | — | — | P / `WebhooksPage.tsx` | REAL; modules.ts:275 |
| 69 | Configurações | `config` | `/config` | Configurações | sistema | — | — | — | — | — | P / `Settings.tsx` | REAL; modules.ts:276 |
| 70 | Ajuda | `ajuda` | `/ajuda` | Configurações | sistema | — | — | — | — | — | P / `AjudaPage.tsx` | REAL; modules.ts:277 |

**Ícones declarados (mesma ordem; nomes, sem proposta visual):**

| Módulo id | Referência de ícone |
|---|---|
| `dashboard` | `LayoutDashboard` |
| `produtos` | `Shirt` |
| `categorias` | `Layers` |
| `cores` | `Palette` |
| `insumos` | `Scissors` |
| `tamanhos` | `Ruler` |
| `grades` | `LayoutGrid` |
| `medidas` | `Ruler` |
| `colecoes` | `Tags` |
| `fichas` | `ClipboardList` |
| `ordens` | `Cog` |
| `planejamento-producao` | `Factory` |
| `custo` | `Calculator` |
| `estoque` | `Warehouse` |
| `movimentacoes` | `ArrowLeftRight` |
| `locais` | `Building2` |
| `inventario` | `ClipboardCheck` |
| `conector-mercadolivre` | `ShoppingBag` |
| `conector-mercadopago` | `CreditCard` |
| `conector-nuvemshop` | `Cloud` |
| `conector-instagram` | `Instagram` |
| `commerce-produtos` | `Package` |
| `commerce-pedidos` | `ShoppingCart` |
| `commerce-trends` | `TrendingUp` |
| `commerce-delivery` | `Truck` |
| `creators` | `Users` |
| `creator-matches` | `Handshake` |
| `outreach-ai` | `Bot` |
| `campanhas` | `Megaphone` |
| `vendas` | `Receipt` |
| `politicas-comerciais` | `Tags` |
| `clientes` | `Store` |
| `representantes` | `Handshake` |
| `catalogos` | `Share2` |
| `documentos-fiscais` | `FileText` |
| `regras-fiscais` | `Scale` |
| `ncm` | `Calculator` |
| `inutilizacoes` | `FileMinus` |
| `listas-preco` | `Tags` |
| `propostas` | `FileText` |
| `pdv-caixas` | `CreditCard` |
| `pdv` | `Receipt` |
| `compras` | `ShoppingCart` |
| `fornecedores` | `Factory` |
| `cotacoes-compra` | `Scale` |
| `compra-recebimentos` | `Warehouse` |
| `importar-nfe-compra` | `FileUp` |
| `depara-fornecedor` | `ArrowLeftRight` |
| `sugestao-compra` | `Calculator` |
| `expedicao` | `ClipboardList` |
| `divergencias` | `ClipboardCheck` |
| `envios` | `Truck` |
| `devolucoes` | `Repeat` |
| `financeiro` | `Wallet` |
| `lancamentos` | `Coins` |
| `categorias-financeiras` | `CircleDollarSign` |
| `contas-financeiras` | `Landmark` |
| `transferencias` | `ArrowRightLeft` |
| `centros-custo` | `PieChart` |
| `investidores` | `PiggyBank` |
| `aportes` | `Wallet` |
| `comissoes` | `BadgeDollarSign` |
| `recorrencias-financeiras` | `Repeat` |
| `relatorios` | `BarChart3` |
| `empresas` | `Building2` |
| `usuarios` | `Users` |
| `auditoria` | `History` |
| `webhooks` | `Webhook` |
| `config` | `Settings` |
| `ajuda` | `HelpCircle` |

### 3.2 Os 8 planned, sem misturar intenção e implementação

Todos os oito são destinos protegidos de roadmap renderizados por `CommerceModulePage`, com `module.planned`, **sem resource, sem conector e sem API própria de módulo**. Estarem cadastrados e acessíveis não significa catálogo multicanal, inbox, delivery ou campanhas implementados. A UI decorativa é REAL; a função de domínio é PLANNED.

| id / rota | Funções declaradas como intenção | Função atual / API |
|---|---|---|
| `commerce-produtos` / `/commerce/produtos` | Catálogo unificado para todos os canais.; Variações, estoque disponível e regras de publicação.; Fila de publicação com histórico por canal. | roadmap; API própria inexistente |
| `commerce-pedidos` / `/commerce/pedidos` | Inbox único de pedidos de todos os canais.; Reserva de estoque e atualização de status.; Roteamento para separação e expedição. | roadmap; API própria inexistente |
| `commerce-trends` / `/commerce/trends` | Curvas de demanda por SKU e canal.; Comparativos de receita e conversão.; Alertas de oportunidade baseados no histórico. | roadmap; API própria inexistente |
| `commerce-delivery` / `/commerce/delivery` | Fila de kits prontos para expedição.; Etiquetas, transportadora e rastreio.; Atualização de entrega para o pedido de origem. | roadmap; API própria inexistente |
| `creators` / `/creators` | Cadastro e enriquecimento de perfis.; Métricas de alcance, afinidade e performance.; Histórico de parcerias e entregas. | roadmap; API própria inexistente |
| `creator-matches` / `/matches` | Recomendação de creators por objetivo e público.; Score de afinidade por campanha.; Aprovação e histórico dos matches. | roadmap; API própria inexistente |
| `outreach-ai` / `/outreach-ai` | Briefing contextual por creator.; Mensagens assistidas com aprovação humana.; Histórico de contatos e respostas. | roadmap; API própria inexistente |
| `campanhas` / `/campanhas` | Briefing, cronograma e orçamento.; Entregáveis e aprovações por campanha.; Resultados, conversões e ROI. | roadmap; API própria inexistente |

## 4. Páginas, subpáginas e navegação fora da Sidebar

### 4.1 Rotas adicionais: os 12 destinos não declarados como módulos

| Tipo / status | Rota | Página real | API / acesso / vínculo |
|---|---|---|---|
| REAL, público | `/login` | Login.tsx | `/api/auth/login`, login/MFA/desafio/política de senha; sem shell; sessão só depois da autenticação |
| REAL, público | `/esqueci` | ForgotPage em ForgotReset.tsx | `/api/auth/forgot`; não enumera um módulo do ERP |
| REAL, público | `/redefinir/:token` | ResetPage em ForgotReset.tsx | `/api/auth/reset`; token de redefinição |
| REAL, público | `/convite/:token` | Convite.tsx | `/api/convites/:token`, POST aceitar; convite com validade |
| REAL, público comercial | `/catalogo/:token` | CatalogoPublico.tsx | catálogo por token/senha/opções, pedido/eventos; dono operacional Catálogos públicos/Vendas |
| REAL, público comercial | `/portal/:token` | PortalCliente.tsx | histórico, detalhe, decisão e recompra por token; dono Clientes/Vendas |
| REAL, detalhe | `/produtos/:id` | ProductDetail.tsx | `produtos:read` e API detalhe/tamanhos/arquivos; vínculos com grade, estoque, BOM e OP |
| REAL, detalhe | `/vendas/:id` | OrderPage.tsx, tipo venda | `vendas` + itens/pdf/estoque/financeiro; autorização de cada ação no servidor |
| REAL, detalhe | `/compras/:id` | OrderPage.tsx, tipo compra | `compras` + itens/recebimentos/financeiro; ver lacunas de compra por produto e perfil financeiro |
| REAL, detalhe | `/ordens/:id` | OrdemDetail.tsx | `ordens` + itens/apontamentos/eventos/transições/consumo |
| REAL, detalhe | `/fichas/:id` | FichaDetail.tsx | `fichas` + insumos/aplicar preço; BOM/custo |
| REAL, desenvolvimento, fora da operação | `/dev/componentes` | dev/ComponentCatalog.tsx | AdminOnly; ui-kit de referência, sem API de domínio e sem MODULES/menu |

**Não existem no App** os detalhes `/listas-preco/:id`, `/listas_preco/:id`, `/propostas/:id`, `/pdv-caixas/:id`, `/pdv_caixas/:id`, `/envios/:id`, `/devolucoes/:id`, `/cotacoes-compra/:id` ou `/cotacoes_compra/:id`, nem um hub `/conectores`. Isso não condena os três módulos com modal/seleção próprios: Envios, Devoluções e Cotações funcionam por sua página, mas não têm permalink de detalhe. Condena os links efetivamente gerados pelo CRUD para Listas, Propostas e Caixas (§6.3).

### 4.2 Inventário de todos os arquivos de página

| Arquivo em client/src/pages | Destinos/dono ou uso real | Estado |
|---|---|---|
| `AjudaPage.tsx` | ajuda → /ajuda | REAL; ver módulo/subfunção |
| `CatalogoPublico.tsx` | /catalogo/:token (+ #p-id/modal) | REAL; ver módulo/subfunção |
| `ComissoesPage.tsx` | comissoes → /comissoes | REAL; ver módulo/subfunção |
| `CommerceModulePage.tsx` | commerce-produtos → /commerce/produtos; commerce-pedidos → /commerce/pedidos; commerce-trends → /commerce/trends; commerce-delivery → /commerce/delivery; creators → /creators; creator-matches → /matches; outreach-ai → /outreach-ai; campanhas → /campanhas | roadmaps, não função de domínio |
| `ConectorPage.tsx` | conector-mercadolivre → /conectores/mercado-livre; conector-mercadopago → /conectores/mercado-pago; conector-nuvemshop → /conectores/nuvemshop; conector-instagram → /conectores/instagram | REAL; ver módulo/subfunção |
| `Convite.tsx` | /convite/:token | REAL; ver módulo/subfunção |
| `CotacoesCompraPage.tsx` | cotacoes-compra → /cotacoes-compra | REAL; ver módulo/subfunção |
| `CustoPage.tsx` | custo → /custo | REAL; ver módulo/subfunção |
| `Dashboard.tsx` | dashboard → / | REAL; ver módulo/subfunção |
| `DevolucoesPage.tsx` | devolucoes → /devolucoes | REAL; ver módulo/subfunção |
| `EmpresasPage.tsx` | empresas → /empresas | REAL; ver módulo/subfunção |
| `EstoqueGradePage.tsx` | estoque → /estoque | REAL; ver módulo/subfunção |
| `ExpedicaoPage.tsx` | expedicao → /expedicao | REAL; ver módulo/subfunção |
| `FichaDetail.tsx` | /fichas/:id | REAL; ver módulo/subfunção |
| `FinanceiroPage.tsx` | financeiro → /financeiro | REAL; ver módulo/subfunção |
| `ForgotReset.tsx` | /esqueci (ForgotPage); /redefinir/:token (ResetPage) | REAL; ver módulo/subfunção |
| `ImportarNfePage.tsx` | importar-nfe-compra → /importar-nfe-compra | REAL; ver módulo/subfunção |
| `InutilizacoesPage.tsx` | inutilizacoes → /inutilizacoes | REAL; ver módulo/subfunção |
| `InventarioModulePage.tsx` | inventario → /inventario | REAL; ver módulo/subfunção |
| `Login.tsx` | /login | REAL; ver módulo/subfunção |
| `LogisticaPage.tsx` | envios → /envios | REAL; ver módulo/subfunção |
| `MedidasPage.tsx` | medidas → /medidas | REAL; ver módulo/subfunção |
| `ModulePage.tsx` | dispatcher / 68 rotas geradas; 35 ResourceCrud | REAL; ver módulo/subfunção |
| `NcmPage.tsx` | ncm → /ncm | REAL; ver módulo/subfunção |
| `OrdemDetail.tsx` | /ordens/:id | REAL; ver módulo/subfunção |
| `OrderPage.tsx` | /vendas/:id; /compras/:id | REAL; ver módulo/subfunção |
| `PdvPage.tsx` | pdv → /pdv | REAL; ver módulo/subfunção |
| `PlanejamentoProducaoPage.tsx` | planejamento-producao → /planejamento-producao | REAL; ver módulo/subfunção |
| `PlannedModule.tsx` | fallback do dispatcher por falta de resource/meta; sem Route próprio | fallback condicionado, não módulo |
| `PortalCliente.tsx` | /portal/:token (+ pedido em estado) | REAL; ver módulo/subfunção |
| `ProductDetail.tsx` | /produtos/:id | REAL; ver módulo/subfunção |
| `RelatoriosPage.tsx` | relatorios → /relatorios | REAL; ver módulo/subfunção |
| `Settings.tsx` | config → /config | REAL; ver módulo/subfunção |
| `SugestaoCompraPage.tsx` | sugestao-compra → /sugestao-compra | REAL; ver módulo/subfunção |
| `UsuariosPage.tsx` | usuarios → /usuarios | REAL; ver módulo/subfunção |
| `WebhooksPage.tsx` | webhooks → /webhooks | REAL; ver módulo/subfunção |
| `dev/ComponentCatalog.tsx` | /dev/componentes (A, fora da operação) | REAL; ver módulo/subfunção |

### 4.3 Subitens reais que não devem virar novos módulos indiscriminadamente

| Dono | Subpáginas/ações existentes | Rota ou estado da UI / APIs | Evidência e limite |
|---|---|---|---|
| CRUD genérico, aplicado a 35 módulos | busca, filtros, ordenação, seleção, listagem desktop/cartões mobile; criação/edição modal; exclusão, importação/exportação, fotos quando habilitadas | rota do módulo; `/:resource`, `/:resource/:id`, options, export, arquivos | ModulePage.tsx:121–1274. Flags ops/resource/roles limitam ações; existência de formulário não prova fluxo de domínio completo |
| Meu Negócio | período/canal, visão atual/comparativa, margem, ABC, operação/estoque/cadastros/alertas/feed | `/`; `/dashboard`, `/negocios/*`, resumo financeiro para gerente/admin | Dashboard.tsx e componentes/dashboard. BI lê projeção e não substitui pedido/faturamento |
| Produto | edição/fotos, variações, etiquetas/código/QR, grade/saldo, movimentos, ficha e OP relacionadas | `/produtos/:id`, modais/sections; `/produtos/:id/{detalhe,tamanhos,variacoes,qrcode…}` | ProductDetail.tsx; dados relacionados não geram 6 itens de menu |
| Ficha técnica | custos/margem, insumos/consumo/perda, recálculo e aplicação de preço | `/fichas/:id`; `/fichas/:id/insumos`, `/aplicar-preco` | FichaDetail.tsx:200–394; preço sugerido de fabricação não é margem realizada financeira |
| Ordem de produção | grade/tamanho, apontamentos, perdas, custo real, eventos; liberar/iniciar/concluir/cancelar/reabrir, forçar com alçada | `/ordens/:id`; `/ordens/:id/{itens,apontamentos,eventos,…}` | OrdemDetail.tsx:387–946; `quality.ts` é outra superfície de API, não uma aba implementada aqui |
| Pedido de venda | cabeçalho, itens/quantidade/preço/desconto, faturar/cancelar, impressão/PDF | `/vendas/:id`; API itens e mudança de registro | OrderPage.tsx:240–545. Emissão fiscal explícita existe no PDV; não presumir que o detalhe de venda tem todos os botões fiscais/logísticos |
| Pedido de compra | itens, impressão, recebimento com prévia/quantidade/custo, contas a pagar | `/compras/:id`; modal RecebimentoCompraModal; API receber/recebimentos e lancamentos_financeiros | OrderPage.tsx:524–658. Financeiro aparece automaticamente mesmo para operador e pode receber 403 |
| Cotações de compra | lista/seleção, itens, fornecedores convidados, preços, comparativo, abrir/recusar/decidir/cancelar | `/cotacoes-compra`, seleção/modal; `/cotacoes-compra/:id/*` na API | CotacoesCompraPage.tsx; detalhe funcional não depende de rota frontend `/:id` |
| Importar NF-e | arquivo → pré-validação/de-para/prévia → confirmação → ir à compra | `/importar-nfe-compra`; POST `/suprimentos/compras/importar-xml`, flags de simulação/entrada | ImportarNfePage.tsx:67–306; não movimenta estoque como se fosse recebimento ao simplesmente importar |
| Sugestão de compra | período, abaixo do mínimo, revisar quantidade/fornecedor, gerar pedido | `/sugestao-compra`; API sugestao-compra e gerar | SugestaoCompraPage.tsx; demanda estatística de prediction.ts é outra API, ainda sem página |
| Estoque / inventário | matriz produto × tamanho × local, célula com movimento/estorno, alertas; abrir/contar/fechar inventário | `/estoque`, `/inventario`, modais; grade/inventarios/itens/fechar | EstoqueGradePage.tsx / InventarioModulePage.tsx. Transferência física é ação de Movimentações, não `/transferencias` financeiro |
| Medidas | situação das grades, montagem por modelo, valores/instruções, copiar grade/texto, imprimir | `/medidas`; `/grades/medidas-resumo`, `/grades/:id/medidas`, editar grade | MedidasPage.tsx. O cadastro técnico `medidas` é interno, não uma segunda tabela de medidas navegável |
| PDV | caixa aberto/abertura/resumo/movimentos/fechamento, busca/scanner, carrinho/descontos/pagamentos, venda, emissão NFC-e quando elegível | `/pdv`; `/pdv/caixas*`, buscar/vendas, `/vendas/:id/fiscal/emitir` | PdvPage.tsx:165–186, 397–406; dependência pdv_caixas torna o operador padrão incompatível com a tela |
| Expedição | duas abas: Fila e Divergências; separar/conferir/embalar/expedir; scanner e resolução | `/expedicao`, estado `aba`; `/vendas/:id/expedicao/*`, `/expedicao/divergencias` | ExpedicaoPage.tsx:116–131. `/divergencias` também tem listagem genérica: duas visões da mesma ocorrência, não duas verdades |
| Envios | três abas: Envios, Gerar envio, Configuração (admin); rastreio/status/eventos/cancelamento | `/envios`, estado `aba`; `/logistica/*`, `/envios/:id/*`, `/vendas/:id/envio` | LogisticaPage.tsx:111–183; credenciais distintas da execução de expedição |
| Devoluções | seleção, solicitação, itens, autorizar/rastrear/receber/recusar/cancelar | `/devolucoes`, modais/seleção; `/devolucoes/:id/*` API | DevolucoesPage.tsx; condição física e recebimento dirigem estoque; financeiro total/partial tem limites próprios |
| Financeiro | 7 abas: Visão geral, Receber / Pagar, DRE, Fluxo de caixa, Rentabilidade, Investidores, Conciliação; baixa parcial/juros/multa/desconto em modal | `/financeiro`, estado `tab`; resumo/baixar/rentabilidade/investidores/conciliacao | FinanceiroPage.tsx:96–105, 201–222, 731–770. A conciliação da tela é texto/OFX; não é a persistência/revisão de `/financeiro/extrato` nem CNAB/gateway |
| Comissões | apuração por representante/período, detalhe de venda/livro, exportação | `/comissoes`; `/financeiro/comissoes`, `/financeiro/comissoes/venda/:id`, `/relatorios/comissoes` | ComissoesPage.tsx:119–171; recurso local comissoes_eventos, sem criar menu de eventos |
| Fiscal | listagem documentos e regras, CRUD especializado NCM, histórico/formulário Inutilizações | `/documentos-fiscais`, `/regras-fiscais`, `/ncm`, `/inutilizacoes` | NcmPage.tsx:72–151, InutilizacoesPage.tsx:94–151; consulta/cancelamento/eventos/configuração fiscal da API não estão expostos como fluxo completo no front |
| Relatórios | seletor de 11 relatórios, período/filtros variáveis, resultado, CSV/XLSX | `/relatorios?relatorio=<nome>`; `/relatorios/:nome` API | RelatoriosPage.tsx:116–164; qualidade é endpoint adicional sem opção no seletor; não são 11 rotas frontend |
| Usuários | filtros/visões/certificação/lote/política de senha, convite e formulário, reautenticação; ficha modal com Resumo, Segurança, Atividade; sessões/concessões | `/usuarios`, estado/modal; usuários/admin/auth/empresas concessões | UsuariosPage.tsx:145, 825–828, 1618–2181, 2593–2996; não existe `/usuarios/:id` frontend |
| Empresas | cadastro/edição/validação/ativar/desativar/excluir; identidade fiscal básica | `/empresas`; recurso empresas | EmpresasPage.tsx + empresasAdmin.ts. Não confundir cadastro fiscal básico com UI completa de `/fiscal/config` |
| Webhooks administrativos | configurar/testar, entregas/reenvio, confirmações/reauth | `/webhooks`; API administrativa `/webhooks*` | WebhooksPage.tsx; é automação do ERP. Receber webhook de provedor é outro contrato |
| Conta/configuração | Minha conta, senha, MFA, minhas sessões, preferências/tema, sistema/endereço público (admin), backup SQL/XLSX (admin) | `/config`, `/config#senha`, `/config?trocar=1`; auth/admin APIs | Settings.tsx:42–249, 1027–1064. Preferência/senha não deve exigir alçada de administração |
| Público catálogo | senha quando configurada, detalhe de produto/fotos/medidas, carrinho/pedido, evento/métrica | `/catalogo/:token#p-<id>`, modais; `/publico/catalogo/:token/*` | CatalogoPublico.tsx:127–158, 485–564; hash é deep link real, não novo Route |
| Público portal | histórico, pedido selecionado, aprovar/recusar cotação, recomprar | `/portal/:token`, detalhe em estado/modal; `/portal/:token/pedido/:id/*` | PortalCliente.tsx:17–33; autorização por token do cliente, não por perfil de usuário ERP |
| Conectores (4) | status, OAuth/conectar/desconectar/sincronizar, painel, venda/eventos selecionados; MP por ambiente também | quatro rotas `/conectores/<slug>`; `/connectors/:provider/*` | ConectorPage.tsx e connectors.ts; snapshots analíticos externos não provam inbox operacional Commerce |

### 4.4 Fontes de navegação alternativas: unidade atual e deriva restante

| Fonte | Usa MODULES? | Diagnóstico |
|---|---|---|
| Sidebar | Sim, visibleModules + NAV_SECTIONS | **Uma** implementação ativa; sem lista local de grupos. Fiscal é renderizável; não é correto reportá-lo como ausente |
| Layout | Sim, moduleOfPath | Único shell autenticado. Breadcrumb atual = marca → group sem link → módulo → `#id`; não conhece área/subgrupo, entidade ou nome do registro |
| Ctrl/Cmd+K | Sim, visibleModules; extras fixos | Mesmos módulos da Sidebar, mas sem todos os subitens/rotas/ações. “Minha conta” e Configurações apontam ao mesmo destino por intenção; busca lowercase, sem normalização de acentos/status/namespace |
| Menu do usuário no header | Rotas fixas config/senha/sair | Atalhos legítimos para conta; não uma árvore paralela |
| CompanySwitcher | Não é catálogo de módulos | GET/POST empresa ativa, token novo e remount de Outlet; correto preservar. Não filtra disponibilidades de módulo por empresa |
| Ajuda | MODULES para resolver IDs; GUIAS fixa | Links sem visibleModules — pode sugerir Usuários/Auditoria ao operador, e instruções antigas de “dashboard”. Não concede API, mas orientação contraditória |
| PWA manifest | Quatro atalhos fixos | Dashboard `/`, Produtos, Vendas, Estoque. URLs válidas; label Dashboard não coincide com Meu Negócio. A autenticação continua sendo exigida ao abrir |
| Páginas de domínio/BI | Links contextuais fixos | Relações úteis: não contá-las como módulos duplicados; conferir URL/perm/estado em cada link |
| OAuth callbackPage | HTML próprio no backend | “Voltar ao ERP” → `/conectores`, **sem rota**; link órfão confirmado em connectors.ts:319 |
| PAGES_ESPECIAIS | Lista auxiliar usada por audit:menu | Não é dispatcher nem código morto. Lista **15 IDs**, incompleta frente aos **21 casos especiais por id** atuais; omite usuários, webhooks, medidas, planejamento, ajuda e importar NF-e. Fonte auxiliar pode dar falso diagnóstico |
| Swagger/OpenAPI | Recursos + paths escritos à mão | Outra visão de contratos, incompleta frente às 298 declarações. Não é inventário de navegação nem prova de autorização em handler |
| PlannedModule | Fallback por falta de resource/meta | Sem destino próprio. Não confundir erro de contrato/meta com intenção de roadmap |
| SW e patch da raiz | Não | `sw.ts` não está ligado ao bootstrap/build atual; `fixes-bloco-a.patch` não aplicado. Não são menu ativo ou prova de cache antigo instalado |

**Flags/disponibilidade:** não foi encontrado um catálogo de feature flags/entitlements de produto determinando a navegação. `planned`, `connector`, `minPerfil`, `adminOnly` são metadados locais. `DATABASE_URL` troca DEMO/PG e é necessária para conectores; APP_URL/origem pública, SMTP, credenciais de gateways/fiscal/frete/WooCommerce, CORS e chaves de assinatura determinam disponibilidade de serviços, não a posição de um item na árvore. Variáveis de observabilidade/versão VITE não são permissionamento. Nenhum valor secreto foi coletado.


## 5. Árvore PROPOSTA — arquitetura de produto, não espelho do código

### 5.1 Decisões estruturais

A referência de seis áreas é preservada conceitualmente. A proposta tem **oito áreas do ERP CORE**: Meu Negócio, Cadastros, Vendas, Estoque & Suprimentos, Produção, Financeiro, Fiscal e Administração. As duas extensões justificadas são **Produção** e **Fiscal**. Commerce e Creators são **espaços separados**, não subgrupos indistintos de ERP. Minha conta/Ajuda são utilidades globais.

| Área/espaço | Decisão / por que pertence ali | O que não pertence ali |
|---|---|---|
| Meu Negócio / BI | entrada operacional e analítica do negócio; central de relatórios como visão transversal, sem novo motor | cadastro e mutação de pedidos, catálogo multicanal planejado ou automação Creator |
| Cadastros | entidades reutilizadas por várias jornadas: produto, materiais, pessoas e classificações/grade | itens de pedido, movimentos, eventos, recepção ou faturamento |
| Vendas | captar/precificar/negociar, vender em balcão, atender/separar/entregar e tratar pós-venda | receber compra, administrar caixa financeiro geral ou confundir catálogo público ERP com publicação Commerce |
| Estoque & Suprimentos | unir reposição/compra/recebimento e posição/movimentos/inventário, preservando grupos Compras e Estoque | crédito/débito bancário ou tratar saldo físico como cadastro livre sem fluxo |
| Produção | área própria: o produto tem BOM, OP por grade, apontamento/perda, custo real e planejamento. Esses são trabalho fabril, não um ajuste de estoque | parâmetros financeiros de receita/despesa ou catálogo/publicação externa |
| Financeiro | títulos, receber/pagar, tesouraria, conciliação/cobrança, comissões, capital e parâmetros financeiros | ficha técnica/custo de fabricação como se fosse resultado contábil; gateway operacional não é painel de conector MP |
| Fiscal | domínio transversal com ciclo próprio, regimes/regras/NCM, documentos/eventos/inutilização e configuração por empresa | escondê-lo em Vendas/Financeiro a ponto de herdar perfil do pai indevidamente; cadastros ERP não viram emissão fiscal |
| Administração | empresas/acessos/usuários, auditoria, automações/webhooks, manutenção/diagnóstico controlado | senha/preferência pessoal exigir admin; config operacional de frete/gateway/fiscal sem vínculo com seu domínio |
| Commerce, fora do core | conectores/canais reais + roadmap multicanal separado. Consome contratos do core; não vira uma segunda definição de Produto/Venda/Entrega | reimplementar estoque/financeiro/fiscal ou promover inbox/delivery planejados a operação disponível |
| Creators, fora do core | perfis/parcerias/campanhas; hoje 4 roadmaps. Integração por campanhas/resultado será contrato futuro explícito | colocar campanha em ERP Vendas só porque pode gerar conversão; inventar API/dado/score atual |
| Utilidades globais | Minha conta `/config`, Ajuda `/ajuda`, busca e empresa ativa | atalhos de usuário tratados como área administrativa com alçada herdada |

**Produção:** decisão baseada no escopo fabril comprovado por README, BOM/OP/apontamentos/planejamento e serviços. Não se inventou participação de produção na receita ou frequência de uso. A revisão de produto pode priorizar a área conforme telemetria futura, sem rebaixar seu domínio a um campo de estoque.

**Logística:** fica em **Vendas → Atendimento e entrega**, com Expedição e Envios; Devoluções em Pós-venda. Hoje as entidades e handlers de envio/conferência/reversa são vinculados à venda. Não há evidência de domínio independente de frota/roteirização/transporte de compras que justifique uma área principal neste recorte. Se esse domínio surgir, reavaliar com fluxo e responsabilidades, não apenas mover quatro links.

**Fiscal:** mantém área própria porque atende venda/PDV, compra/entrada, empresa e margem/NCM, com credenciais, homologação e auditoria independentes. O operador pode ler documentos conforme contrato atual sem automaticamente acessar regras/configuração de gerente/admin.

**Relatórios:** catálogo transversal em Meu Negócio; atalhos contextualizados em cada área apontam ao **mesmo** relatório com filtros explícitos. Não criar módulos duplicados “Relatório X” em todo grupo nem uma segunda fórmula DRE/margem.

**Pessoas:** Clientes, Fornecedores e Representantes ganham casa canônica em Cadastros/Pessoas. Vendas e Compras oferecem links/contexto para a mesma entidade, sem duplicar ID, URL ou registro. A pessoa é reutilizada por catálogo, portal, proposta, compra, comissão e financeiro.

### 5.2 Planta de navegação canônica

A árvore abaixo contém a casa de **todos os 70 módulos existentes**, conservando IDs e URLs atuais. A classificação de um módulo como subitem/ação não o exclui do inventário nem do acesso direto. Não há implementação desta planta. Os itens `[ação]`/`[subitem]` podem sair do primeiro nível visual; continuam acessíveis por fluxo, busca autorizada e URL. As rotas novas sugeridas em §5.4 são explicitamente futuras.

```text
BROBOND ERP [marca/shell — não nova página]
├─ ERP CORE (8 áreas / 56 módulos)
│  ├─ Meu Negócio
│  │  ├─ Visão do negócio
│  │  │  └─ Meu Negócio [dashboard] /
│  │  └─ Análises
│  │     └─ Central de relatórios
│  │        └─ Relatórios [relatorios] /relatorios
│  ├─ Cadastros
│  │  ├─ Produtos
│  │  │  ├─ Cadastro principal
│  │  │  │  └─ Produtos [produtos] /produtos
│  │  │  ├─ Classificações
│  │  │  │  ├─ Categorias [categorias] /categorias
│  │  │  │  ├─ Cores [cores] /cores
│  │  │  │  └─ Coleções [colecoes] /colecoes
│  │  │  └─ Grades e medidas
│  │  │     ├─ Grades [grades] /grades
│  │  │     ├─ Tamanhos [tamanhos] /tamanhos
│  │  │     └─ Tabela de Medidas [medidas] /medidas
│  │  ├─ Materiais
│  │  │  └─ Insumos
│  │  │     └─ Insumos [insumos] /insumos
│  │  └─ Pessoas
│  │     ├─ Clientes [clientes] /clientes
│  │     ├─ Fornecedores [fornecedores] /fornecedores
│  │     └─ Representantes [representantes] /representantes
│  ├─ Vendas
│  │  ├─ Comercial
│  │  │  ├─ Pedidos e negociação
│  │  │  │  ├─ Pedidos de venda [vendas] /vendas
│  │  │  │  └─ Propostas comerciais [propostas] /propostas
│  │  │  └─ Oferta e preço
│  │  │     ├─ Catálogos públicos [catalogos] /catalogos
│  │  │     ├─ Políticas comerciais [politicas-comerciais] /politicas-comerciais
│  │  │     └─ Listas de preço [listas-preco] /listas-preco
│  │  ├─ Balcão
│  │  │  └─ Venda e gestão de caixa
│  │  │     ├─ PDV (venda de balcão) [pdv] /pdv
│  │  │     └─ Gestão de caixas [pdv-caixas] /pdv-caixas
│  │  ├─ Atendimento e entrega
│  │  │  ├─ Expedição [expedicao] /expedicao
│  │  │  ├─ Divergências de conferência [divergencias] /divergencias [subitem]
│  │  │  └─ Envios e rastreio [envios] /envios
│  │  └─ Pós-venda
│  │     └─ Devoluções
│  │        └─ Devoluções [devolucoes] /devolucoes
│  ├─ Estoque & Suprimentos
│  │  ├─ Compras
│  │  │  ├─ Pedidos e negociação
│  │  │  │  ├─ Pedidos de compra [compras] /compras
│  │  │  │  └─ Cotação de compra [cotacoes-compra] /cotacoes-compra
│  │  │  ├─ Recebimentos
│  │  │  │  └─ Recebimentos de compra [compra-recebimentos] /compra-recebimentos [subitem]
│  │  │  ├─ Entrada por XML
│  │  │  │  └─ Importar NF-e de entrada [importar-nfe-compra] /importar-nfe-compra [ação]
│  │  │  ├─ Reposição
│  │  │  │  └─ Sugestão de compra [sugestao-compra] /sugestao-compra
│  │  │  └─ Parâmetros do fornecedor
│  │  │     └─ Códigos do fornecedor (de-para) [depara-fornecedor] /depara-fornecedor [subitem]
│  │  └─ Estoque
│  │     ├─ Posição e controle
│  │     │  ├─ Estoque Físico [estoque] /estoque
│  │     │  ├─ Movimentações [movimentacoes] /movimentacoes
│  │     │  └─ Inventário [inventario] /inventario
│  │     └─ Locais
│  │        └─ Locais de Estoque [locais] /locais [subitem]
│  ├─ Produção
│  │  ├─ Planejamento
│  │  │  └─ Planejamento de Produção [planejamento-producao] /planejamento-producao
│  │  ├─ Execução
│  │  │  └─ Ordens de produção
│  │  │     └─ Ordens de produção (OP) [ordens] /ordens
│  │  └─ Engenharia
│  │     └─ Ficha técnica e custo
│  │        ├─ Fichas técnicas [fichas] /fichas
│  │        └─ Custo de fabricação [custo] /custo
│  ├─ Financeiro
│  │  ├─ Operação financeira
│  │  │  └─ Visão e títulos
│  │  │     ├─ Visão financeira [financeiro] /financeiro
│  │  │     └─ Títulos e lançamentos [lancamentos] /lancamentos
│  │  ├─ Tesouraria
│  │  │  └─ Contas e transferências
│  │  │     ├─ Contas financeiras [contas-financeiras] /contas-financeiras
│  │  │     └─ Transferências financeiras [transferencias] /transferencias
│  │  ├─ Comissões
│  │  │  └─ Comissões [comissoes] /comissoes
│  │  ├─ Capital
│  │  │  └─ Investidores e aportes
│  │  │     ├─ Investidores / Sócios [investidores] /investidores
│  │  │     └─ Aportes [aportes] /aportes
│  │  └─ Parâmetros financeiros
│  │     ├─ Categorias financeiras [categorias-financeiras] /categorias-financeiras [subitem]
│  │     ├─ Centros de custo [centros-custo] /centros-custo [subitem]
│  │     └─ Recorrências financeiras [recorrencias-financeiras] /recorrencias-financeiras [subitem]
│  ├─ Fiscal
│  │  ├─ Operação fiscal
│  │  │  ├─ Documentos fiscais [documentos-fiscais] /documentos-fiscais
│  │  │  └─ Inutilizações [inutilizacoes] /inutilizacoes
│  │  └─ Parâmetros fiscais
│  │     ├─ Regras fiscais [regras-fiscais] /regras-fiscais
│  │     └─ NCM / Tributação [ncm] /ncm
│  └─ Administração
│     ├─ Organização e acesso
│     │  ├─ Empresas [empresas] /empresas
│     │  └─ Usuários [usuarios] /usuarios
│     ├─ Governança
│     │  └─ Auditoria [auditoria] /auditoria
│     └─ Automações
│        └─ Webhooks e automações [webhooks] /webhooks
├─ Commerce — FORA DO CORE
│  ├─ Canais
│  │  └─ Conectores reais
│  │     ├─ Mercado Livre [conector-mercadolivre] /conectores/mercado-livre [REAL]
│  │     ├─ Mercado Pago [conector-mercadopago] /conectores/mercado-pago [REAL]
│  │     ├─ Nuvemshop [conector-nuvemshop] /conectores/nuvemshop [REAL]
│  │     └─ Instagram Shopping [conector-instagram] /conectores/instagram [REAL]
│  └─ Multicanal
│     └─ Roadmap
│        ├─ Catálogo multicanal [commerce-produtos] /commerce/produtos [PLANNED]
│        ├─ Pedidos multicanal [commerce-pedidos] /commerce/pedidos [PLANNED]
│        ├─ Tendências [commerce-trends] /commerce/trends [PLANNED]
│        └─ Entregas multicanal [commerce-delivery] /commerce/delivery [PLANNED]
├─ Creators — FORA DO CORE
│  └─ Parcerias e campanhas
│     └─ Roadmap
│        ├─ Creators [creators] /creators [PLANNED]
│        ├─ Afinidades [creator-matches] /matches [PLANNED]
│        ├─ Contato assistido [outreach-ai] /outreach-ai [PLANNED]
│        └─ Campanhas [campanhas] /campanhas [PLANNED]
└─ Utilidades globais
   └─ Conta e suporte
      ├─ Minha conta [config] /config
      └─ Ajuda [ajuda] /ajuda
```

**Reconciliação da proposta:** **56 módulos no ERP CORE (8 áreas) + 8 em Commerce (4 conectores reais + 4 planned) + 4 Creators planned + 2 utilidades = 70**. Hoje a seção Commerce possui 13 itens porque inclui Webhooks e Creators; isso é uma decisão de menu atual, não o recorte proposto.

**Árvore simples versus profundidade do contrato:** o modelo de informação pode conter Área → Grupo → Subgrupo → Módulo → Subitem → Rota; a Sidebar não precisa renderizar seis níveis de acordeão. Recomenda-se área com grupos legíveis e, no máximo, dois níveis de expansão visíveis. Subitens de registro, ações, parâmetros pouco frequentes e coleções auxiliares vivem na página/contexto. Cada módulo terá uma única casa canônica, disponibilidade e acesso por ação. O grafo operacional fica em §7, não expande a árvore em centenas de joins.

### 5.3 Matriz completa de navegação e relações — todos os 70 módulos

Esta é a matriz **Área / Grupo–Subgrupo / Módulo / Rota / API / Resource / Perfil / Status / Dependências**. Área e agrupamento são **propostos**; rota, API, resource, acesso e status descrevem o **HEAD atual**. A matriz de literais atuais continua em §3.1.

Notação: `CRUD(r)` = os templates genéricos do Anexo C aplicados ao recurso público, com ops/RBAC/escopo; `r:read/create/update/delete` = verificação real de recurso, não nova string de permissão implementada. O/G/A = operador/gerente/admin. `cap.*` são as cinco capacidades comerciais reais; “G na UI / O na API” é achado, não recomendação de alçada. Dependências são contratos/serviços, não instrução para criar submenu para cada relação. Os detalhes exatos dos 88 recursos e as 298 declarações API estão nos anexos.

| Área proposta | Grupo / subgrupo | Módulo atual (id) | Rota atual | API atual (prefixo /api) | Resource(s) | Perfil/permissão efetiva | Status | Dependências / relações |
|---|---|---|---|---|---|---|---|---|
| Meu Negócio | Visão do negócio | Meu Negócio `dashboard` | `/` | /dashboard; /negocios/{canais,resumo,margens,abc}; /financeiro/resumo (G) | vendas; sales/sale_items [SQL]; produto_abc [SQL]; estoque; ordens; financeiro | O/G/A; margem/recalcular e financeiro G/A | REAL | empresa/escopo, projeção ERP + ingestão externa, período/canal; financeiro por perfil |
| Meu Negócio | Análises / Central de relatórios | Relatórios `relatorios` | `/relatorios` | /relatorios/:nome (11); /relatorios/qualidade (sem UI) | recursos do relatório; qualidade em auditoria/ordens | O/G/A; relatórios financeiros G/A | REAL | estoque/movimentos/produção/vendas/financeiro; filtros e empresa; catálogo não exaustivo |
| Cadastros | Produtos / Cadastro principal | Produtos `produtos` | `/produtos` | CRUD(produtos); /produtos/:id/{detalhe,tamanhos,variacoes,qrcode*}; arquivos | produtos | O/G/A por op; delete operador vedado | REAL / DUPLICADO de label atual | categoria/cor/coleção/grade/tamanho/medidas; fornecedor; BOM/OP; SKU/estoque/preço; P0 QR |
| Cadastros | Produtos / Classificações | Categorias `categorias` | `/categorias` | CRUD(categorias) | categorias | O/G/A por op; delete operador vedado | REAL / DUPLICADO de label atual | grade padrão, produtos e filtros |
| Cadastros | Produtos / Classificações | Cores `cores` | `/cores` | CRUD(cores) | cores | O/G/A por op; delete operador vedado | REAL | produtos/variações e filtros |
| Cadastros | Produtos / Classificações | Coleções `colecoes` | `/colecoes` | CRUD(colecoes) | colecoes | O/G/A por op; delete operador vedado | REAL | produtos, catálogo, políticas e relatórios |
| Cadastros | Produtos / Grades e medidas | Grade `grades` | `/grades` | CRUD(grades); /grades/:id/medidas; /grades/medidas-resumo | grades | O/G/A por op; delete operador vedado | REAL | tamanhos/grade_tamanhos; tabela de medidas; categorias/produtos; instruções |
| Cadastros | Produtos / Grades e medidas | Tamanhos `tamanhos` | `/tamanhos` | CRUD(tamanhos) | tamanhos | O/G/A por op; delete operador vedado | REAL | grade, medidas, SKU/variação; itens de venda/compra/OP, estoque |
| Cadastros | Produtos / Grades e medidas | Tabela de Medidas `medidas` | `/medidas` | /grades/medidas-resumo; /grades/:id/medidas GET/PUT; editar grades | grades; tamanhos; grade_tamanhos; medidas; medida_valores | O/G/A; grades read/update | REAL | grade/tamanho/colunas/instruções; produto/catálogo/etiqueta |
| Cadastros | Materiais / Insumos | Insumos `insumos` | `/insumos` | CRUD(insumos) | insumos | O/G/A por op; delete operador vedado | REAL | fornecedor, unidade/custo, estoque de insumos, BOM/consumo, compra/recebimento |
| Cadastros | Pessoas | Clientes `clientes` | `/clientes` | CRUD(clientes); /clientes/:id/portal-acessos* | clientes | O/G/A por op; delete operador vedado | REAL | representante, venda/proposta/catálogo/portal; contatos; P0 gestão de token sem tenant |
| Cadastros | Pessoas | Fornecedores `fornecedores` | `/fornecedores` | CRUD(fornecedores) | fornecedores | O/G/A por op; delete operador vedado | REAL | insumo/produto, compras/cotações/recebimentos/de-para; contatos internos latentes |
| Cadastros | Pessoas | Representantes `representantes` | `/representantes` | CRUD(representantes) | representantes | O/G/A por op; delete operador vedado | REAL | usuário, cliente, vendas/propostas, %comissão/apuração |
| Vendas | Comercial / Pedidos e negociação | Vendas `vendas` | `/vendas` | CRUD(vendas); /vendas/:id/itens*; pdf; fiscal; expedição/envio; packing-check | vendas | O/G/A por op; delete operador vedado | REAL | cliente/representante/produto/tamanho/lista/política, estoque/local, fiscal/envio/caixa/financeiro/comissão/BI; P0 PDF/NF-e |
| Vendas | Comercial / Pedidos e negociação | Propostas comerciais `propostas` | `/propostas` | POST /propostas (exige itens); GET /propostas/:id; itens/eventos; enviar/aprovar/recusar/cancelar/converter; list CRUD | propostas | O/G/A; proposta read/create, transição com vendas:create (não cap.aprovar) | REAL parcial / ORPHAN; criação genérica sem itens | cliente/representante, item/preço/tamanho, evento/validade, conversão em venda única |
| Vendas | Comercial / Oferta e preço | Catálogos públicos `catalogos` | `/catalogos` | CRUD(catalogos); /catalogos/:id/compartilhar; /catalogos/inteligencia; público token/evento/pedido | catalogos | cap.catálogo/share/métricas (read); write catálogo, share/métricas próprios | REAL | produto/categoria/coleção/grade/medidas/preço/política, cliente, links/eventos/pedido; P0 tenant especializado |
| Vendas | Comercial / Oferta e preço | Políticas comerciais `politicas-comerciais` | `/politicas-comerciais` | CRUD(politicas_comerciais) | politicas_comerciais | cap.políticas; UI G/A ou O com permitir; gerente negar ainda vê | REAL | cliente/catálogo/coleção/canal, quantidade/desconto/pagamento/alçada; reserva_horas não prova reserva |
| Vendas | Comercial / Oferta e preço | Listas de preço `listas-preco` | `/listas-preco` | CRUD(listas_preco); /listas-preco/:id/{itens,historico}; resolver; /produtos/:id/preco | listas_preco | UI G/A; API O/G/A por op (sem minPerfil) | REAL parcial / ORPHAN detalhe/itens | produto/SKU, vigência/prioridade, preço congelado em item de venda/proposta; histórico |
| Vendas | Balcão / Venda e gestão de caixa | PDV — venda balcão `pdv` | `/pdv` | /pdv/{caixas*,buscar,vendas*}; /vendas/:id/fiscal/emitir | vendas/itens_venda; pdv_caixas/pagamentos/movimentos; produtos/tamanhos; financeiro; fiscal | UI O/G/A; caixa G/A, vender vendas:create | REAL / P0 jornada operador | caixa aberto, produto/tamanho/SKU/stock/preço/pagamento, NFC-e/recebíveis; não é Commerce |
| Vendas | Balcão / Venda e gestão de caixa | Caixas do PDV `pdv-caixas` | `/pdv-caixas` | CRUD read(pdv_caixas); /pdv/caixas/{aberto,:id/resumo,:id/movimentos,:id/fechar}; abrir | pdv_caixas | G/A; CRUD CUD fechado, fluxo próprio | REAL parcial / ORPHAN detalhe | usuário/local, abertura/fechamento, movimentos de gaveta, vendas/pagamentos/financeiro |
| Vendas | Atendimento e entrega | Expedição `expedicao` | `/expedicao` | /vendas/:id/expedicao/{separar,conferir,embalar,expedir}; /expedicao/divergencias* | vendas/itens_venda; expedicao_eventos; divergencias_conferencia; estoque/financeiro | O/G/A; checkFluxo(vendas) | REAL | venda/SKU/tamanho/quantidade, scanner/conferência/packing, local/estoque/financeiro; sem nova baixa na conferência |
| Vendas | Atendimento e entrega | Divergências de conferência `divergencias` | `/divergencias` | CRUD read(divergencias_conferencia); /expedicao/divergencias/:id/resolver | divergencias_conferencia | O/G/A; resolução por alçada/fluxo | REAL | venda, conferência esperado/lido/faltando/sobrando, resolução/evento; subitem Expedição |
| Vendas | Atendimento e entrega | Logística e envios `envios` | `/envios` | CRUD(envios); /logistica/{config,frete}; /envios/:id/{eventos,rastrear,status,cancelar}; /vendas/:id/envio | envios | UI G/A; API envios sem minPerfil; config A | REAL | venda/cliente/CEP/peso/volumes, provedor/credenciais/etiqueta/rastreio e eventos; ver alçada em §6.2 |
| Vendas | Pós-venda / Devoluções | Devoluções e reversa `devolucoes` | `/devolucoes` | POST /devolucoes; /devolucoes/:id/{autorizar,rastreamento,receber,recusar,cancelar}; read | devolucoes | O/G/A; checkFluxo(devolucoes), estados/limites por ação | REAL | venda/cliente/item original/tamanho/quantidade/condição, estoque/financeiro/documento fiscal |
| Estoque & Suprimentos | Compras / Pedidos e negociação | Compras `compras` | `/compras` | CRUD(compras); /compras/:id/{itens*,aprovar,recebimentos,receber,pdf} | compras | O/G/A; aprovar G/A; receber compras:update; financeiro G/A | REAL | fornecedor, item produto OU insumo/tamanho, de-para, recebimento/custo/estoque/a pagar; P0 PDF |
| Estoque & Suprimentos | Compras / Pedidos e negociação | Cotação de compra `cotacoes-compra` | `/cotacoes-compra` | CRUD(cotacoes_compra); /cotacoes-compra/:id/{comparativo,itens*,convidar,abrir,cotar,recusar,decidir,cancelar} | cotacoes_compra | O/G/A por op; decidir/cancelar G/A | REAL | fornecedor/item produto ou insumo, preço/prazo/critérios, compras; detalhe em seleção/modal |
| Estoque & Suprimentos | Compras / Recebimentos | Recebimentos de compra `compra-recebimentos` | `/compra-recebimentos` | CRUD read(compra_recebimentos); /compras/:id/{recebimentos,receber} | compra_recebimentos | O/G/A read; ação compras:update; CUD do ledger fechado | REAL | compra, itens recebidos/restantes, custo/estoque/estorno; detalhe de compra |
| Estoque & Suprimentos | Compras / Entrada por XML | Importar NF-e de entrada `importar-nfe-compra` | `/importar-nfe-compra` | POST /suprimentos/compras/importar-xml (prévia/confirmar) | compras; fornecedores; produto_fornecedor_skus; produtos/tamanhos; itens_compra; importacoes_nfe | UI G/A; API compras:create, O/G/A | REAL | XML/hash/chave, fornecedor/de-para/SKU/tamanho; gera compra, não recebimento |
| Estoque & Suprimentos | Compras / Reposição | Sugestão de compra `sugestao-compra` | `/sugestao-compra` | /suprimentos/sugestao-compra GET; POST gerar | compras; fornecedores; produtos; estoques; vendas/itens_venda | UI G/A; API compras:read/create, O/G/A | REAL | mínimos/saldo/consumo/em pedidos/em trânsito, revisar fornecedor/qtd/custo; pedido pendente |
| Estoque & Suprimentos | Compras / Parâmetros do fornecedor | De-Para de produtos `depara-fornecedor` | `/depara-fornecedor` | CRUD(produto_fornecedor_skus) | produto_fornecedor_skus | O/G/A por op; delete operador vedado | REAL | fornecedor+codigo_fornecedor → produto+tamanho; XML; vínculo não cria outro produto |
| Estoque & Suprimentos | Estoque / Posição e controle | Estoque Físico `estoque` | `/estoque` | /estoques/grade; CRUD(movimentacoes); /movimentacoes/:id/estornar | estoques; produtos; tamanhos; locais; movimentacoes | O/G/A; estoque/movimentações por op | REAL | empresa/local/célula por produto+tamanho; mínimo, OP/recebimento/venda; inventário |
| Estoque & Suprimentos | Estoque / Posição e controle | Movimentações `movimentacoes` | `/movimentacoes` | CRUD(movimentacoes); /movimentacoes/:id/estornar | movimentacoes | O/G/A por op; delete operador vedado | REAL | produto/tamanho/local, origem OP/compra/venda/recebimento; transferência/ajuste/estorno |
| Estoque & Suprimentos | Estoque / Posição e controle | Inventário `inventario` | `/inventario` | CRUD(inventarios); /inventarios/:id; /itens GET/PUT; /fechar | inventarios; itens_inventario; locais; produtos/tamanhos; movimentacoes | O/G/A; inventarios read/create/update, fechamento por fluxo | REAL | local/contagem/saldo congelado, ajustes de estoque e auditoria |
| Estoque & Suprimentos | Estoque / Locais | Locais de Estoque `locais` | `/locais` | CRUD(locais) | locais | O/G/A por op; delete operador vedado | REAL | empresa/local padrão, estoques/movimentos/inventário/OP/PDV; histórico |
| Produção | Planejamento | Planejamento de Produção `planejamento-producao` | `/planejamento-producao` | /producao/planejamento | ordens/itens_ordem; produtos; fichas/itens_ficha_tecnica; insumos/estoque_insumos | O/G/A; ordens:read | REAL | OP abertas, BOM, saldos/necessidades; prediction é API distinta sem tela |
| Produção | Execução / Ordens de produção | Cadeias de Fabricação `ordens` | `/ordens` | CRUD(ordens); /ordens/:id/{itens,liberar,iniciar,apontamentos,eventos,concluir,cancelar,reabrir}; qualidade | ordens | O/G/A; liberar/cancelar/reabrir/forçar G/A | REAL | produto/tamanho/grade/BOM, insumos/local/estoque, apontamentos/perdas/custo; qualidade sem UI/P0 |
| Produção | Engenharia / Ficha técnica e custo | Ficha Técnica / BOM `fichas` | `/fichas` | CRUD(fichas); /fichas/:id/insumos*; /fichas/:id/aplicar-preco | fichas | O/G/A; ficha read/update; aplicar preço G/A | REAL | produto, itens/BOM, consumo/perda/insumo, custo/preço sugerido e OP |
| Produção | Engenharia / Ficha técnica e custo | Custos `custo` | `/custo` | CRUD(fichas); /fichas/:id/*; /produtos/options | fichas; produtos; itens_ficha_tecnica; insumos | O/G/A; aplicar preço G/A | REAL | BOM/mão de obra/indiretos/margem; link detalhe ficha; distinto de resultado financeiro |
| Financeiro | Operação financeira / Visão e títulos | Financeiro `financeiro` | `/financeiro` | /financeiro/{resumo,lancamentos,baixar,rentabilidade,investidores,conciliacao,recorrencias/gerar} | lancamentos_financeiros; contas/categorias/centros; vendas/compras; aportes; recorrencias | G/A por recurso/op | REAL | origem compra/venda/PDV, parcelas/baixa/taxas, DRE/fluxo/rentabilidade; gateway/extrato/CNAB sem UI completa |
| Financeiro | Operação financeira / Visão e títulos | Lançamentos `lancamentos` | `/lancamentos` | CRUD(lancamentos_financeiros); /financeiro/lancamentos; /:id/baixar | lancamentos_financeiros | G/A por op; delete operador vedado | REAL | conta/categoria/centro, origem/parcelas/vencimento, bruto/líquido/status, baixa/comissão |
| Financeiro | Tesouraria / Contas e transferências | Contas `contas-financeiras` | `/contas-financeiras` | CRUD(contas_financeiras) | contas_financeiras | G/A por op; delete operador vedado | REAL | títulos, transferência/baixa, PDV/compra/venda, aporte, gateway/extrato |
| Financeiro | Tesouraria / Contas e transferências | Transferências `transferencias` | `/transferencias` | CRUD(transferencias_financeiras) | transferencias_financeiras | G/A por op; delete operador vedado | REAL | contas origem/destino, caixa/lancamentos; NÃO transferência de estoque |
| Financeiro | Comissões | Comissões `comissoes` | `/comissoes` | /financeiro/comissoes; /financeiro/comissoes/venda/:id; /relatorios/comissoes | comissoes_eventos [local]; vendas; representantes; lancamentos_financeiros | G/A; financeiro/comissão read | REAL | representante/venda, apurada/efetivada/estornada, baixa parcial/livro |
| Financeiro | Capital / Investidores e aportes | Investidores / Sócios `investidores` | `/investidores` | CRUD(investidores) | investidores | G/A por op; delete operador vedado | REAL | aporte/distribuição, participação/posição; resumo financeiro |
| Financeiro | Capital / Investidores e aportes | Aportes `aportes` | `/aportes` | CRUD(aportes) | aportes | G/A por op; delete operador vedado | REAL | investidor/conta/valor/tipo/status, caixa e capital |
| Financeiro | Parâmetros financeiros | Categorias `categorias-financeiras` | `/categorias-financeiras` | CRUD(categorias_financeiras) | categorias_financeiras | G/A por op; delete operador vedado | REAL / DUPLICADO de label atual | categoria pai/receita/despesa, títulos/recorrências, DRE |
| Financeiro | Parâmetros financeiros | Centros de custo `centros-custo` | `/centros-custo` | CRUD(centros_custo) | centros_custo | G/A por op; delete operador vedado | REAL | títulos/recorrências, classificação gerencial; NÃO ficha BOM |
| Financeiro | Parâmetros financeiros | Recolhimentos e recorrências `recorrencias-financeiras` | `/recorrencias-financeiras` | CRUD(recorrencias_financeiras); /financeiro/recorrencias/gerar; cron admin | recorrencias_financeiras | G/A por op; delete operador vedado | REAL | categoria/conta/centro, periodicidade/vencimento/título gerado/idempotência |
| Fiscal | Operação fiscal | Documentos fiscais `documentos-fiscais` | `/documentos-fiscais` | CRUD read(documentos_fiscais); /fiscal/documentos/:id/{eventos,consultar,cancelar}; /vendas/:id/fiscal/* | documentos_fiscais | O/G/A read; ações fiscal por vendas read/update; config A | REAL parcial / ciclo sem UI completa | venda/PDV/empresa/regra/NCM/UF, provedor/chave/protocolo/DANFE, eventos/status |
| Fiscal | Operação fiscal | Inutilizações `inutilizacoes` | `/inutilizacoes` | CRUD read(inutilizacoes_fiscais); POST /fiscal/inutilizar | inutilizacoes_fiscais | G/A; checkFluxo; CUD genérico fechado | REAL | empresa/modelo/série/faixa/ano/provedor/homologação/usuário, histórico |
| Fiscal | Parâmetros fiscais | Regras fiscais `regras-fiscais` | `/regras-fiscais` | CRUD(regras_fiscais) | regras_fiscais | G/A por op; delete operador vedado | REAL | NCM/UF/operação/CFOP/CST/CSOSN/alíquotas, documentos e empresa fiscal |
| Fiscal | Parâmetros fiscais | NCM / Tributação `ncm` | `/ncm` | CRUD(impostos_ncm) | impostos_ncm | G/A; impostos_ncm read/CUD | REAL | produto.ncm, prefixo/aliquota/default, margem/BI e regra fiscal |
| Administração | Organização e acesso | Empresas `empresas` | `/empresas` | CRUD(empresas); /empresas/ativa GET/POST; concessões via /usuarios/:id/empresas | empresas; usuario_empresas; usuarios; config fiscal interna | UI A por minPerfil; URL sem AdminOnly; API A | REAL | CNPJ/endereço/regime, empresa ativa, concessões/tenant; config fiscal avançada sem UI |
| Administração | Organização e acesso | Usuários `usuarios` | `/usuarios` | CRUD(usuarios); /usuarios/{resumo,politica-senha,certificacao,:id/ações/sessoes/atividade/empresas} | usuarios | A; reauth nas ações sensíveis | REAL | perfil/capacidades/alçadas, convite/senha/MFA/sessões/bloqueio/certificação, empresas/auditoria |
| Administração | Governança | Auditoria `auditoria` | `/auditoria` | CRUD read(auditoria); /admin/auditoria/verificar | auditoria | A; recorte empresa/consolidado autorizado | REAL | eventos de todos os domínios/origem/ator/empresa, hash-chain; verificar sem UI específica |
| Administração | Automações | Webhooks `webhooks` | `/webhooks` | /webhooks GET/POST; /:id PUT/DELETE/testar/entregas; /entregas/:id/reenviar | webhooks; webhook_entregas [locais] | A; reauth escrita/ações sensíveis | REAL | eventos assináveis/outbound, segredo/URL/entregas/retry; diferente de callbacks externos |
| Commerce — FORA DO CORE | Canais / Conectores reais | Mercado Livre `conector-mercadolivre` | `/conectores/mercado-livre` | /connectors/:provider GET/DELETE; painel; autorizar/sincronizar; callback/webhooks | connectors/credentials/oauth_states/webhook_events/sync logs + sales/sale_items [SQL] | UI G/A; URL Protected; API sessão+DB+ator.id sem minPerfil | REAL / FORA DO CORE | conta externa/OAuth/state/token/HMAC/PG, ingestão SKU/sales/eventos/painel/BI; retorno /conectores órfão |
| Commerce — FORA DO CORE | Canais / Conectores reais | Mercado Pago `conector-mercadopago` | `/conectores/mercado-pago` | /connectors/:provider GET/DELETE; painel; autorizar/sincronizar; callback/webhooks | connectors/credentials/oauth_states/webhook_events/sync logs + sales/sale_items [SQL] | UI G/A; URL Protected; API sessão+DB+ator.id sem minPerfil | REAL / FORA DO CORE | conta externa/OAuth/state/token/HMAC/PG, ingestão SKU/sales/eventos/painel/BI; retorno /conectores órfão |
| Commerce — FORA DO CORE | Canais / Conectores reais | Nuvemshop `conector-nuvemshop` | `/conectores/nuvemshop` | /connectors/:provider GET/DELETE; painel; autorizar/sincronizar; callback/webhooks | connectors/credentials/oauth_states/webhook_events/sync logs + sales/sale_items [SQL] | UI G/A; URL Protected; API sessão+DB+ator.id sem minPerfil | REAL / FORA DO CORE | conta externa/OAuth/state/token/HMAC/PG, ingestão SKU/sales/eventos/painel/BI; retorno /conectores órfão |
| Commerce — FORA DO CORE | Canais / Conectores reais | Instagram Shopping `conector-instagram` | `/conectores/instagram` | /connectors/:provider GET/DELETE; painel; autorizar/sincronizar; callback/webhooks | connectors/credentials/oauth_states/webhook_events/sync logs + sales/sale_items [SQL] | UI G/A; URL Protected; API sessão+DB+ator.id sem minPerfil | REAL / FORA DO CORE | conta externa/OAuth/state/token/HMAC/PG, ingestão SKU/sales/eventos/painel/BI; retorno /conectores órfão |
| Commerce — FORA DO CORE | Multicanal / Roadmap | Produtos `commerce-produtos` | `/commerce/produtos` | — (sem API de módulo) | — | O/G/A sessão; sem entitlement de produto atual | PLANNED / FORA DO CORE / DUPLICADO de label atual | contratos futuros de produto/canal/pedido/entrega; nenhuma relação operacional integrada atual |
| Commerce — FORA DO CORE | Multicanal / Roadmap | Pedidos `commerce-pedidos` | `/commerce/pedidos` | — (sem API de módulo) | — | O/G/A sessão; sem entitlement de produto atual | PLANNED / FORA DO CORE | contratos futuros de produto/canal/pedido/entrega; nenhuma relação operacional integrada atual |
| Commerce — FORA DO CORE | Multicanal / Roadmap | Trends `commerce-trends` | `/commerce/trends` | — (sem API de módulo) | — | O/G/A sessão; sem entitlement de produto atual | PLANNED / FORA DO CORE | contratos futuros de produto/canal/pedido/entrega; nenhuma relação operacional integrada atual |
| Commerce — FORA DO CORE | Multicanal / Roadmap | 📦 Delivery `commerce-delivery` | `/commerce/delivery` | — (sem API de módulo) | — | O/G/A sessão; sem entitlement de produto atual | PLANNED / FORA DO CORE | contratos futuros de produto/canal/pedido/entrega; nenhuma relação operacional integrada atual |
| Creators — FORA DO CORE | Parcerias e campanhas / Roadmap | Creators `creators` | `/creators` | — (sem API de módulo) | — | O/G/A sessão; sem entitlement de produto atual | PLANNED / FORA DO CORE | contratos futuros de creator/parceria/campanha/resultado; nenhuma relação operacional integrada atual |
| Creators — FORA DO CORE | Parcerias e campanhas / Roadmap | Matches `creator-matches` | `/matches` | — (sem API de módulo) | — | O/G/A sessão; sem entitlement de produto atual | PLANNED / FORA DO CORE | contratos futuros de creator/parceria/campanha/resultado; nenhuma relação operacional integrada atual |
| Creators — FORA DO CORE | Parcerias e campanhas / Roadmap | Outreach AI `outreach-ai` | `/outreach-ai` | — (sem API de módulo) | — | O/G/A sessão; sem entitlement de produto atual | PLANNED / FORA DO CORE | contratos futuros de creator/parceria/campanha/resultado; nenhuma relação operacional integrada atual |
| Creators — FORA DO CORE | Parcerias e campanhas / Roadmap | Campanhas `campanhas` | `/campanhas` | — (sem API de módulo) | — | O/G/A sessão; sem entitlement de produto atual | PLANNED / FORA DO CORE | contratos futuros de creator/parceria/campanha/resultado; nenhuma relação operacional integrada atual |
| Utilidades globais | Conta e suporte | Configurações `config` | `/config` | /auth/{me,change-password,mfa*,sessoes*,preferences}; /admin/config/endereco-publico; backup | usuário/sessão; configuracoes [local]; dados de sistema/backup | O/G/A conta própria; cards admin A; reauth | REAL | senha provisória, MFA/sessões, preferências/tema, APP_URL e backup; não área de negócio |
| Utilidades globais | Conta e suporte | Ajuda `ajuda` | `/ajuda` | — (conteúdo/links, sem API própria) | — | O/G/A; links hoje sem visibleModules | REAL | GUIAS/IDs MODULES e jornadas; conteúdo/atalhos devem refletir alçada atual |

**Leitura dos estados:** `DUPLICADO de label atual` marca apenas os dois rótulos repetidos (Produtos e Categorias), não ID/path/registro duplicado; os nomes de apresentação propostos desambiguam. As três famílias de legado/compatibilidade de §6.4 estão fora do registro MODULES: não marcar todo Vendas ou Fiscal como LEGACY só porque ainda consome uma API anterior. Infraestrutura/públicos/detalhes legítimos não viram ORPHAN por estarem fora da Sidebar.

### 5.4 Contrato de destinos e subitens para o próximo ciclo

1. **Preservar as 82 rotas existentes**, inclusive públicos/dev; reagrupamento não é renomear path/ID. Uma migração de URL deve ter alias/redirect explícito, testes e política de descontinuação separada.
2. Definir destino de detalhe **canônico** por módulo, sem derivar frontend de `resource.key`. Para as três lacunas, a recomendação é adicionar no ciclo autorizado **`/listas-preco/:id`**, **`/propostas/:id`** e **`/pdv-caixas/:id`** (preços/itens/histórico; ciclo da proposta; resumo/livro do caixa, respectivamente). **Nenhuma dessas três rotas existe hoje.** Links antigos com underscore não são rotas válidas a preservar como funcionalidade: só criar alias se houver evidência de consumidores/bookmarks.
3. O callback OAuth deve voltar ao conector de origem ou a um hub real aprovado. Não inventar `/conectores` como existente; decidir e testar retorno por provedor e erro/sucesso fora de popup.
4. Detalhes de Envios/Devoluções/Cotações/Usuários podem continuar em modal/seleção. Se for exigido permalink, URL/estado/back-forward devem ser contratados e testados. `detail: true` do backend não basta para declarar que há rota frontend.
5. **Proposta de acesso ao PDV:** operação de venda pelo operador no caixa autorizado; abertura/fechamento, movimentos de gaveta e visões gerenciais ficam com alçada explícita de gestão. Hoje não há atribuição de caixa/permissão granular implementada que sustente esse desenho. Tratar em contrato separado; não resolver liberando todo `pdv_caixas` sem análise nem escondendo PDV do operador sem decisão de produto.
6. Novo metadado de arquitetura deve distinguir identidade estável, espaço/core, área/grupo/subgrupo, dono, página/destino de detalhe, recurso(s), ação(ões), estado REAL/PLANNED/LEGACY e dependências. Hoje esses níveis não existem como contrato. Fonte única **de apresentação** não substitui o servidor como fonte de autorização.
7. Aprovações ficam como fila/subitem de Vendas/Compras com vínculo à origem; Qualidade no detalhe da OP/produção; previsão em planejamento/reposição/BI; gateway/extrato/CNAB/recebíveis em Financeiro. São **lacunas de superfície**, não novos módulos entregues por este relatório.
8. Configurações operacionais fiscais/logísticas/gateway ficam contextualizadas no domínio, com link administrativamente autorizado; manutenção/diagnóstico/backup em Administração. A conta pessoal continua acessível durante troca obrigatória de senha.
9. Os 8 roadmaps ficam em seu espaço e com badge/status inequívoco. Visibilidade por produto/empresa deve ser decisão explícita, também para URL direta. Tirar do menu principal **não** revoga APIs/URLs e não cria permissão que não existe.

## 6. APIs, recursos, autorização e órfãos

### 6.1 Fronteiras de acesso reais

**Frontend:** `Protected` exige sessão/meta e redireciona senha provisória para `/config?trocar=1`; `AdminOnly` protege Usuários, Auditoria, Webhooks e dev. **O router não aplica minPerfil dos módulos.** Empresas tem `minPerfil: admin`, mas não `adminOnly`; Financeiro/Fiscal restrito/conectores/XML/sugestão/caixas podem ser abertos por URL, renderizar e só então receber a recusa (ou aceitação) da API. `visibleModules` filtra a descoberta, não é autorização.

**Backend genérico:** `resourceParam` usa getPublicResource e recusa os internos; `checkAccess` verifica minPerfil/adminOnly, ops, delete de operador e exceções comerciais; listagem/registro/refs aplicam escopo por empresa. Os 46 recursos públicos são autenticados; os 34 internos não recebem CRUD simplesmente por existir no registro. `checkFluxo` usa `read` como alçada de fluxo e **intencionalmente não consulta ops CUD**, evitando que a proteção do CRUD bloqueie abrir caixa/receber/expedir etc. Não impor `update` genérico indiscriminadamente aos endpoints de fluxo no futuro.

**Comercial:** `podeComercial` tem `herdar/permitir/negar`; admin sempre permite, gerente herda permitir, operador herda negar. Catálogos read exige ao menos catálogo/compartilhar/métricas, writes exigem catálogo; políticas exige capacidade políticas; a fila de exceções em approval.ts usa capacidade aprovar. **Aprovar compra** (compras.ts:49–53) exige gerente/admin; **aprovar proposta** (propostas.ts:82–84, 394–396) segue propostas/read + vendas/create, sem cap.aprovar. Não são políticas equivalentes só pelo verbo aprovar. O menu só replica a exceção de **permitir políticas para operador**; não replica a negação de gerente nem o acesso efetivo a Catálogos.

**Routers externos:** publicConnectorsRouter e publicGatewayRouter estão antes de JSON e da sessão para validar bytes crus/state/assinatura. Instagram tem GET handshake/token e POST HMAC dedicado, antes do despachante genérico. A convivência de `/api/webhooks/:provider` ALL com GET/POST Instagram é despacho intencional, não duplicação de uma API. Os 23 registros fora de JWT não são “23 endpoints sem segurança”: incluem login, convite/reset, tokens de catálogo/portal/arquivo, callbacks e webhooks de terceiros.

**Escopo:** preservar CompanySwitcher (novo token e remount), filtro por empresa e respostas 404 para registro fora do escopo. Conectores são escopados por ator/conta externa; gateway/configuração são por empresa. Não tratar essas dimensões como se fossem equivalentes ao mover um item entre espaços. URLs assinadas de arquivo/catálogo/portal não devem entrar em busca pública nem revelar tokens em telemetria.

### 6.2 Matriz RBAC e divergências críticas

| Superfície | Descoberta atual | URL direta | API/ação real | Achado / decisão necessária |
|---|---|---|---|---|
| Usuários/Auditoria/Webhooks | AdminOnly | AdminOnly no App | admin nos handlers/recursos; operações sensíveis com reauth | Boa fronteira geral; preservar por ação, inclusive atividades/sessões/certificação/entregas |
| Empresas | minPerfil admin | Protected somente; gerente/operador entram na rota | recurso adminOnly e validação administrativa | Falta guarda de destino consistente; não afirmar vazamento de dados, API bloqueia |
| Financeiro e seus cadastros | gerente | Protected somente | recursos minPerfil gerente + operações explícitas | URL não tem guarda equivalente; API é a barreira de dados |
| Documentos fiscais | todos | Protected | recurso read, CUD genérico fechado; emissão/cancelamento com contrato fiscal | Listagem real; ciclo de ação não pode ser inferido de permissão do grupo Fiscal inteiro |
| Regras/NCM/Inutilizações | gerente | Protected somente | minPerfil gerente; POST inutilizar com checkFluxo (CRUD permanece fechado) | Itens já existem. Credencial/homologação diferente de autorização do usuário |
| Políticas comerciais | gerente; operador se permitir | Protected somente | capacidade políticas; gerente com negar é recusado | Menu não replica negação. Script ignora minPerfil por exceção comercial, não cobre a tabela completa permitir/negar/herdar |
| Catálogos públicos (gestão) | todos | Protected | read por cap catálogo/compartilhar/métricas; writes por catálogo; share/insights com cap própria | Operador padrão vê menu mas pode receber 403; alçada específica não é modelada na árvore atual |
| Listas de preço | gerente | Protected somente | resource sem minPerfil; r:read/CUD permite operador, salvo delete | Menu mais restrito que API; conteúdo de preços/histórico não tem UI completa |
| Envios | gerente | Protected somente | envios sem minPerfil; operações por recurso/vendas; config de logística admin | Menu mais restrito que API. Não liberar credenciais admin ao ampliar operação |
| Importar NF-e de entrada | gerente | Protected somente | `compras:create`, recurso sem minPerfil | Operador pode chegar por URL/API; ausência no menu não é bloqueio |
| Sugestão de compra | gerente | Protected somente | `compras:read/create`, sem minPerfil | Mesmo descompasso; depende de fornecedor/mínimo/custo e geração do pedido |
| 4 conectores | gerente | Protected somente | sessão + DATABASE_URL + ator.id; handlers sem guarda de gerente | **Contrato de alçada não enforceado na API**. Evidência connectors.ts:148–249; não foi testado contra conta externa |
| PDV | todos | Protected | leitura de caixa exige pdv_caixas minPerfil gerente; vender exige vendas:create | **Operador descobre PDV, mas a carga obrigatória do caixa é recusada por código**; bloqueio da jornada padrão |
| Caixas do PDV | gerente | Protected somente | read gerente; CUD genérico fechado; abrir/mover/fechar via fluxo | UI do PDV cobre essas ações para quem tem alçada; link de detalhe genérico de Caixas não tem rota |
| Compras → contas a pagar | compra para operador | detalhe Protected | compras acessível; lancamentos_financeiros minPerfil gerente | Painel financeiro carrega sem guarda local e pode falhar 403; definir resumo contextual mínimo ou ocultar essa informação com explicação, sem mudar a alçada financeira por conveniência |
| BI | módulo todos; blocos variam por perfil | Protected | leitura por vendas/read + escopo; margem/recalcular exigem gerente; resumo financeiro gerente | Ver autorização por bloco/ação e efeitos dos recalculos; não elevar todo o painel a gerente nem garantir escrita global por um link |
| Aprovar exceções | sem fila de UI | nenhuma rota de função | cap aprovar; perm explícita pode habilitar operador | Capacidade concedida não tem jornada navegável completa |
| Aprovar compra / decidir cotação | módulos acessíveis a operador | destinos Protected | compra aprovar e cotação decidir/cancelar exigem G/A; propostas transições usam read + vendas/create | Distinguir aprovação de exceção, compra, negociação e cotação; a capacidade aprovar não é uma permissão universal |
| OP / aplicar preço BOM | módulos acessíveis a operador | destinos Protected | liberar/cancelar/reabrir OP, forçar consumo e aplicar preço ao produto exigem G/A; iniciar/apontar/concluir seguem ordens/read | Acesso ao módulo não autoriza todas as transições; contratos e botões devem refletir ação específica |
| Importação genérica / anexos / exportação | ação contextual | no módulo dono | recurso/op + tenant; modelos/templates e upload específicos | Não é nova permissão geral de “migração de tudo”; URL de download precisa carregar autenticação |

**Regra futura obrigatória:** descobrir, abrir destino e executar cada ação têm de produzir a mesma política efetiva, respeitando as exceções de fluxo e escopo. Mostrar menu não deve prometer uma ação impossível; esconder menu não deve ser descrito como revogação de acesso. Erro 403 em URL direta não pode virar redirect silencioso que parece falha de navegação.

### 6.2.1 P0 — endpoints especializados que não aplicam o escopo de empresa

A cobertura correta do CRUD/BI/estoque **não é universal em todas as APIs especializadas**. Foram encontrados **seis conjuntos de handlers** que fazem leitura por ID ou listagem no store bruto sem validar empresa autorizada do ator:

| Conjunto | Caminho e evidência de código | Falta confirmada estaticamente |
|---|---|---|
| Catálogos administrativos | catalogos.ts:451–472, 510–557 — compartilhar, inteligência e revogar | verifica capacidade comercial, mas lê catálogo/cliente/compartilhamentos/eventos sem `escopoDoAtor`/assert ou filtro de empresa; métricas agregam listagem global |
| Gestão de acesso ao portal | portal.ts:113–144 — `/clientes/:id/portal-acessos*` | checkAccess clientes read/update, depois get por ID/find do acesso; não valida empresa do cliente contra o ator antes de listar/gerar/revogar acesso |
| PDF de pedido | pdf.ts:56–74 e 216–229 — vendas e compras `/:id/pdf` | checkAccess read de recurso, get pedido pelo ID e carregar relações; não valida empresa do pedido |
| QR/produto/etiqueta | qrcode.ts:gerarConteudoQR, 71–77, 123–128, 132–142 | get bruto de produto/relacionados; sem checagem de empresa. O comentário “público” de qrcode/dados é incorreto sobre o mount: a rota está atrás do JWT global, mas não tem escopo do registro |
| NF-e anterior | nfe.ts:39–48, 114–120, 140–145, 202–210 | dado/status/simulação da venda sem assert de empresa; checkAccess rank/op não limita ID de outra empresa |
| Qualidade | quality.ts:43–61, 80–88, 135–150 | lê OP por ID, grava evento ou agrega auditoria/qualidade sem recorte da empresa do ator; carimbar empresa na auditoria não autoriza o acesso |

**Por que não basta confiar no store:** `pgstore.ts:269–305` monta WHERE a partir dos filtros passados; get usa `WHERE t.id = $1`. `getStore` não recebe ator nem injeta escopo da requisição. `checkAccess` (`services.ts:141–162`) só decide recurso/perfil/op/capacidade, não a empresa do registro. As tabelas/relações têm IDs globais, mas conhecer ID não equivale a autorização. Não foi localizada uma guarda de mount que sane esses caminhos; o middleware global verifica sessão/senha, não o dono de cada registro.

**Conclusão limitada e relevante:** a ausência da checagem na aplicação está confirmada. Há caminho estático para ler/operar registro de empresa não concedida se o ID for informado e as demais condições da ação forem satisfeitas. **Não houve chamada HTTP, exploração, acesso a dados ou validação de eventual política externa de banco em produção.** Tratar como P0 de autorização/tenant antes de expor novas ações ou reagrupá-las como “seguras”. Próximo ciclo: guards de registro/relacionados e filtros, seguidos de testes A/B/C por endpoint, JSON/PDF/PNG e leitura/escrita; não corrigir só o menu.

### 6.3 Matriz de órfãos e superfícies incompletas

#### A. Quatro famílias de URL gerada, sem destino

| ID | URL gerada / dono | Evidência | Status e recomendação |
|---|---|---|---|
| OR-URL-01 | `/listas_preco/:id` — Listas de preço | resources.detail + ResourceCrud navega por resource.key em ModulePage.tsx:368, 451–454, 697, 733, 798; App só lista `/listas-preco` | **ORPHAN / REAL parcial**; novo detalhe explícito proposto, não derivação pelo nome SQL |
| OR-URL-02 | `/propostas/:id` — Propostas | mesma regra detail; abertura de registro aponta ao id; a criação genérica não fornece itens e esbarra no POST especializado (propostas.ts:240–241); App não declara detalhe | **ORPHAN / REAL parcial**; API do ciclo existe, falta destino e operação completa |
| OR-URL-03 | `/pdv_caixas/:id` — Caixas | recurso detail, listagem genérica Caixas, links pelo key; nenhum Route de detalhe | **ORPHAN / REAL parcial**; resumo/livro canônico. Ações no PDV são reais, não chamar todo o domínio de planejado |
| OR-URL-04 | `/conectores` — retorno OAuth | connectors.ts:319; inexistente em MODULES e App | **ORPHAN / REAL**; voltar ao provedor/hub real, cobrindo erro e popup |

São **famílias de links**, não número de registros afetados. O fallback `* → /` faz a quebra parecer retorno ao início, sem 404 diagnóstico. Os outros três resources com detail sem Route (Envios, Devoluções, Cotações) têm página especializada/modal e **não entram nesse total de links quebrados confirmados**.

#### B. Treze famílias de backend sem superfície funcional completa

A classificação ORPHAN abaixo refere-se à **função/ação de produto**, não a cada verbo nem a exigência de um novo item de Sidebar. APIs de infraestrutura, callbacks e cron são inventariados, mas não contam automaticamente como órfãos.

| ID | Função/API real | Resource/perm/relacionamento | Superfície atual e posição proposta |
|---|---|---|---|
| OR-FN-01 | Aprovações: `/aprovacoes`, count, aprovar/rejeitar | vendas/compras + cap.aprovar + empresa | **ORPHAN funcional**; usuários têm alçada, mas nenhuma fila/ação correspondente localizada no cliente; subitem Vendas/Compras |
| OR-FN-02 | Predição: `/predicao/demanda`, `/predicao/insumos` | produtos/read, vendas/estoque/ordens/BOM | **ORPHAN funcional**; diferente da sugestão de compra existente; planejamento/reposição/BI contextual |
| OR-FN-03 | Qualidade: `/ordens/:id/qualidade`, `/relatorios/qualidade` | ordens read/update e recursos/eventos | **ORPHAN funcional**; OP tem apontamentos/perdas, não essa UI de qualidade; subitem OP/relatório contextual |
| OR-FN-04 | Itens/histórico/resolver de listas: `/listas-preco/:id/*`, `/listas-preco/resolver` | listas_preco, lista_preco_itens/historico, produtos; r read/update | **REAL parcial / ORPHAN de ação**; CRUD de cabeçalho existe, preços e histórico não têm tela; detalhe de lista. `/produtos/:id/preco` já é consumido na venda |
| OR-FN-05 | Proposta: detalhe, itens, eventos, enviar/aprovar/recusar/cancelar/converter | propostas, proposta_itens/eventos, clientes, representantes, vendas; propostas/read + vendas/create nas transições | **REAL parcial / ORPHAN de ação**; lista/cabeçalho não cumpre a descrição do módulo; detalhe da negociação |
| OR-FN-06 | Recebíveis cartão: `/financeiro/cartao/recebiveis` | pagamentos PDV/lancamentos/contas; financeiro gerente | **ORPHAN funcional**; consulta/agenda em Financeiro, não conector Commerce |
| OR-FN-07 | Gateway: `/financeiro/gateway/*` | 3 contratos locais de gateway, lancamentos; financeiro, config admin | **ORPHAN funcional**; cobrança/reprocessamento no Financeiro. Callback externo é intencional e não órfão |
| OR-FN-08 | Extrato persistente: `/financeiro/extrato*` | fin_extrato_transacoes, conta/lancamento; read/update financeiro | **ORPHAN funcional**; tela atual só concilia texto/OFX por endpoint antigo; revisão/persistência em conciliação |
| OR-FN-09 | CNAB: `/financeiro/cnab/{parsers,importar}` | parsers de banco, extrato/baixa; financeiro update | **ORPHAN funcional**; ação de importação na conciliação, não menu de cada parser |
| OR-FN-10 | Config fiscal: GET/PUT `/fiscal/config` | empresa_fiscal_config/empresas; admin, segredos/homologação | **ORPHAN funcional**; dados fiscais básicos de Empresas não são credenciais/ambiente/numeração do serviço; Fiscal/Parâmetros |
| OR-FN-11 | Ciclo do documento fiscal: eventos, consultar, cancelar, prévia/situação de venda | documentos_fiscais/eventos, venda; read/fluxo fiscal | **REAL parcial / ORPHAN de ação**; listagem de documentos + NFC-e no PDV + inutilização são reais; falta UI completa de manutenção do documento |
| OR-FN-12 | WooCommerce: `/marketplace/loja/{status,produtos,pedidos,estoque}` | produtos/vendas/itens/movimentos; import/push gerente/admin, tenant e mapeamento de SKU | **ORPHAN de superfície / FORA DO CORE**; módulo de loja real no backend, não quinta tela de conector já disponível. Posicionar em Commerce/Canais após contrato |
| OR-FN-13 | Chat: conversas, não-lidas, mensagens GET/POST | usuários/mensagens + sessão; superfície Socket.IO relacionada | **ORPHAN de superfície / FORA DA OPERAÇÃO CORE**; nenhum componente de cliente consumidor localizado; utilidade de comunicação somente se produto aprovar |

**Dois contratos internos sem consumidor funcional localizado:** `fornecedor_contatos` e `produto_composicao` aparecem na definição/armazenamento, mas não foram localizados serviços/telas consumidores de negócio. São **ORPHAN técnico/latente**, distintos de “resource público sem menu”. Se ativados, pertencem ao detalhe de Fornecedor/Produto, não a novos grupos. Não confundir o campo textual/composição do produto com uso da tabela interna.

**Ausência de menu legítima, não órfão:** tabelas de itens/eventos/saldos de insumos, sessions/tokens/assinaturas, projeção analítica, APIs de cron/Swagger/status/notificações/socket/backup e os 12 destinos frontend adicionais. Os 5 recursos públicos sem `module.resource` direto são empresas, estoques, inventarios (páginas dedicadas), estoque_insumos e movimentacoes_insumos (subdomínio por fluxos). O script de menu não deve transformá-los todos em listagens principais.

### 6.4 Legado, aliases e duplicidades

| Classe | Fonte atual | Diagnóstico / ação futura |
|---|---|---|
| LEGACY explícito, ativo — 1 família | marketplace.ts:1–9 + index.ts:695–696 | token ML antigo, sem UI, separado dos quatro conectores. Não restaurar Shopee/TikTok nativos; definir sunset/consumidores antes de remover |
| API paralela/compatibilidade — 1 família | `/vendas/:id/nfe/*`, nfe.ts, versus `/vendas/:id/fiscal/*` | preparador/rotas anteriores convivem com motor fiscal. Não presumir equivalência de payload/status/alçada; documentar uma fonte de emissão e compatibilidade |
| API paralela/compatibilidade — 1 família | `/frete/cep`, `/frete/calcular` versus `/cep/:cep`, `/logistica/frete` | frete.ts:36–42 devolve **fonte: estimativa**; logística depende de cotação de provedor/config. Não mostrar estimativa como remessa postada/cotação real |
| Aliases intencionais | packingCheck em vendas/pedidos/expedicao, conferir/checkout | 5 declarações usam o mesmo packingCheck; não são 5 engines. Contratar compatibilidade/dono, sem nova entrada de menu para cada alias |
| Visões legítimas sobre a mesma entidade | `/divergencias` e aba de Expedição; cadastros financeiros e abas de Financeiro | Não duplicam registro. Avaliar manter atalho/contexto único e não recriar modelos |
| Projeção, não venda duplicada | vendas/itens_venda → sales/sale_items `erp:` | ADR-001 atual define fonte autoritativa ERP e modelo analítico derivado. Não converter coexistência de tabelas em dois menus de venda ERP |
| Rótulos ambíguos — 2 | Produtos (CORE/Commerce), Categorias (produto/financeiro) | Namespaces e rótulos contextuais. IDs/paths distintos, 0 duplicidade de identidade |
| Duplicidade de descoberta intencional | Configurações e “Minha conta” em Ctrl+K/header | Mesmo destino; busca deve deduplicar resultados equivalentes sem eliminar “Trocar senha” como ação |
| Fonte de SW candidata a limpeza | client/src/sw.ts versus vite.config.ts:15–29/main.tsx | SW fonte cacheia API, mas build ativo usa VitePWA NetworkOnly e não importa esse arquivo. **Não há prova de que SW antigo esteja instalado no navegador do usuário** |
| Helper candidato a limpeza | findModuleByResource em modules.ts:360–362 | Nenhum consumidor localizado; não é outra árvore |
| Patch não aplicado | fixes-bloco-a.patch | propõe backup/lock/docs; não é código em execução e não foi aplicado |
| Registro auxiliar divergente, não legado morto | PAGES_ESPECIAIS × dispatcher | Usado por audit:menu; resolver deriva do contrato em ciclo de qualidade, não deletar por suposto desuso |
| Bibliotecas de domínio/infra não conectadas ao boot | packages/domain IngestOrderUseCase, packages/infra PrismaOrderUnitOfWork | Definições/testes reais, **nenhuma chamada localizada em server/src ou modules**. Não provar fluxo HTTP unificado “salva venda → estoque → financeiro” apenas pela existência desses packages |

## 7. Grafo operacional: relações reais e jornadas

### 7.1 Árvore ≠ grafo

Uma venda relaciona produto, cliente, representante, preço, estoque/local, documento fiscal, envio, caixa, recebíveis/comissões e BI. Isso **não** significa onze submenus dentro de Vendas nem duplicar Produto/Financeiro. O menu fornece um ponto de entrada canônico; detalhes oferecem relações, ações autorizadas e status. O Anexo B registra todas as referências de campos dos recursos centrais, incluindo itens/eventos, com dono. Os vínculos de serviço abaixo explicam as arestas operacionais que a árvore sozinha não mostra.

```text
[empresa ativa + usuário + concessões] ──escopo──► todas as jornadas

[produto + categoria/cor/coleção + grade/tamanho/medidas]
    ├──► [BOM/ficha + insumos + fornecedores] ──► [custo sugerido/preço]
    ├──► [SKU/EAN/variações/de-para] ──► [compra/XML/canal]
    ├──► [estoque por local+tamanho] ◄── [recebimento / OP / movimentos / inventário]
    └──► [lista de preço / catálogo público / proposta / venda / PDV]

[fornecedor + cotação/de-para/XML/sugestão] ──► [compra aprovada]
    ──► [recebimentos por item/quantidade] ──► [estoque + custo]
    ──recebimento completo──► [contas a pagar / financeiro]

[cliente + representante + catálogo/portal/proposta + política/preço]
    ──► [venda + itens] ──alçada/exceção──► [aprovação]
    ──faturamento──► [saída estoque + títulos a receber + comissão congelada]
    ├──► [fiscal/documento/eventos]
    ├──► [separar → conferir → embalar → expedir]
    ├──► [envio/frete/rastreio]
    ├──► [baixa/recebimento → livro de comissões]
    └──► [projeção erp:venda:* → sales/sale_items → margem/ABC/Meu Negócio]

[BOM + insumos disponíveis + planejamento] ──► [OP + grade + apontamentos/perdas]
    ──concluir──► [consumo insumos + entrada produto + custo real]
    ──reabrir/estornar──► [reversão rastreável]

[venda original + itens + motivo/condição]
    ──► [devolução solicitada/autorizada/rastreada]
    ──receber fisicamente──► [entrada de itens bons / registro de perdas]
    ──se total e aplicável──► [cancelamento/reversão financeira da venda]

[canal externo/conta + webhook/OAuth/sync]
    ──► [ingestão externa sales/sale_items + eventos + correspondência SKU]
    ──► [painel de conector + BI]
    - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -
    inbox/reserva/fulfillment Commerce e campanhas Creators = PLANNED,
    não uma aresta operacional ERP completa comprovada pelo menu atual.
```

**Arestas com efeitos devem ser lidas no sentido certo:** conferir não baixa estoque; envio não equivale a faturar; importar XML não equivale a receber; NF-e autorizada não se infere de HTTP sucesso genérico; custo sugerido não é CMV histórico realizado; BI não vira fonte de registro de pedido. As operações podem ter transações/idempotência; este ciclo leu o código, não repetiu a homologação PG.

### 7.2 Relações de serviço e fonte de verdade

| Relação | Fonte de verdade / evidência | Requisito estrutural |
|---|---|---|
| Produto → grade/variações/medidas | resources.ts, detail.ts, medidas.ts, variacoes.ts | Produto mostra grade efetiva e links autorizados, sem criar cadastro duplicado no Commerce |
| Produto → ficha/OP/movimentos/estoque | detail.ts; ProductDetail.tsx | painel relacional de leitura, contexto de empresa preservado; cada registro abre seu dono |
| BOM → insumos → custo/preço | producao.ts e FichaDetail; aplicarPrecoFicha | cálculo servidor; separar custo estimado e custo real da OP/margem financeira |
| Compra → itens produto ou insumo → recebimento | compras.ts, suprimentos.ts, itens.ts; migrations/recursos compra_recebimentos | UI deve representar ambos os tipos, quantidade recebida/restante, tamanho, custo e origem. Hoje OrderPage ainda privilegia insumo |
| Recebimento completo → títulos a pagar | financeiro.ts `syncLancamentoCompra`/parcelas; OrderPage.tsx:584–605 | origem FK/identificador visível, status parcial honesto, sem recalcular obrigação no cliente |
| Proposta → uma venda | propostas.ts `converterProposta`, proposta_itens/eventos; recursos com venda_id/proposta_id | detalhe, status e conversão acessíveis; evitar duas vendas pela mesma proposta; listagem de cabeçalho não cumpre ciclo |
| Lista → preço congelado no item | listasPreco.ts:5–16, 110–135, 142–189 | explicar origem/vigência/precedência, histórico; alteração de lista não reescreve venda antiga |
| Venda → estoque/faturamento | itens.ts:351–378 e services/financeiro | execução no servidor, vínculo produto/tamanho/local/venda, falha de saldo explícita; UI não decide baixa |
| Venda/baixa → comissão | financeiro.ts, comissoes.ts e contrato comissoes_eventos | distinguir apurada/efetivada/estornada; Comissões em Financeiro, relação contextual no representante/venda |
| Venda → documento fiscal | fiscal.ts + documentos/eventos + nfe.ts legado | uma cadeia fiscal/status real; configuração e homologação não viram badge “emitida” sem retorno autorizado |
| Venda → expedição/envio | expedicao.ts:318–358, logistica.ts:879–885 | conferência/packing versus postagem/rastreio distintos; sem dupla baixa por expedir venda já faturada |
| OP → consumo/entrada/custo/reabertura | producao.ts:419–584 e eventos/apontamentos | preservar grade, produzido/refugado, forçar só com alçada, estados e reversibilidade; qualidade como subfunção faltante |
| Inventário/movimento → ajuste/estorno | estoque.ts + movimentacoes/ref/local | congelar contexto da contagem, fechamento idempotente por fluxo; transferência física não é financeira |
| Devolução → estoque e financeiro | expedicao.ts:705–826 | receber itens bons pela quantidade real, não a solicitada; tratamento financeiro total explícito. Crédito/troca/ajuste proporcional completo não deve ser presumido |
| ERP faturado → BI | negocios.ts:1638–1926; ADR-001 | `vendas` é autoritativa; prefixos `erp:` e projeção idempotente. Entradas externas ficam no próprio namespace, sem copiar motor analítico |
| Externo → painel/BI | modules/connectors/ingestion e core/panel.service | correspondência SKU/empresa/conta, log/idempotência; não prometer atendimento e estoque ERP já vinculados para todos os canais |
| Gateway → cobrança/baixa/extrato | gateway.ts, extrato.ts, cnab.ts e financeiro | segredo/admin, assinatura externa e rotina interna separados; superfície financeira faltante, sem outro “Mercado Pago” confundido com conector |
| Administração → todos os domínios | auth, usuariosAdmin, empresa/empresasApi, auditoria, webhooks | concessão de empresa/reauth/perfil por ação; não transportar tokens/segredos para busca/breadcrumb |

### 7.3 Jornadas e dependências de aceite

| Jornada | Caminho atual e relações necessárias | Ruptura/risco atual | Caminho proposto / critério verificável |
|---|---|---|---|
| Produto pronto para operar | Cadastros produto/classificações/grade/medidas → BOM/custo quando fabricado → preço → estoque/local → venda/catálogo/canal | atributos e dados estão espalhados; publicação multicanal é planned; helper/detail não garante composição estruturada implementada | Cadastros/Produto com relações e ações; preço/estoque/origem tipados; nenhum item planejado declarado publicado |
| Venda de balcão / pedido | cliente/opcional representante, produto/tamanho, lista/política → proposta/venda ou PDV → faturamento → estoque/financeiro/comissão → fiscal/entrega → BI | operador PDV depende de caixa gerente; proposta/lista sem detalhe; aprovação sem fila; links fiscais/logísticos incompletos | balcão executável pelo perfil autorizado, caixa atribuído, origem de preço, status e eventos; faturar uma vez, conferir sem baixar, emitida só quando autorizada |
| Compra / reposição | fornecedor/de-para → XML ou cotação/sugestão → compra → aprovar → receber parcial/total → estoque/custo → pagar | compra por produto/tamanho não bem representada no OrderPage; operator compra recebe painel financeiro 403; financeiro só no completo é regra atual | Estoque & Suprimentos/Compras com item tipado, prévia real, recebido/restante, status; acesso contextual a pagar não amplia perm financeira |
| Produção | produto/ficha/insumo → planejamento → OP/grade → apontar/produzir/refugar → concluir → entrada/consumo/custo → auditoria/BI | qualidade/previsão têm API sem superfície; nomenclatura “Cadeias” confunde OP | Produção própria; detalhe com apontamentos/perdas/eventos/qualidade conforme ciclo futuro; consumo/entrada/reabertura/forçar auditados |
| Financeiro | origem compra/venda/PDV/aporte → títulos/parcelas → receber/pagar/baixar → comissão/DRE/rentabilidade → conciliar/cobrar | extrato persistente, CNAB, gateway e cartão sem UI; tela conciliação só endpoint antigo; fiscal/custo/BOM não são financeiro | Financeiro com tesouraria/cobrança/conciliação; origem/valor líquido/parcial/data/status auditáveis; DRE e BI com denominador claro |
| Devolução/reversa | venda/itens/motivo → solicitar/autorizar → rastrear → receber quantidade/condição → estoque → fiscal/financeiro e eventual troca | escopo financeiro parcial/troca/crédito não é integralmente comprovado; menu Logística mascara pós-venda | Vendas/Pós-venda; vínculo ao original e limites disponíveis visíveis; não creditar ou cancelar total por devolução parcial sem contrato |
| Canal externo | autenticar conta → callback/webhook/sync → ingestão/sales/eventos → correspondência catálogo → painel/BI | alçada de conector diferente do menu; retorno OAuth sem rota; inbox/delivery/reserva multicanal planned | Commerce/Canais separado; tratamento de erros/status e escopo de conta/empresa; ponte para ERP somente por contrato e testes de reconciliação |
| Trocar empresa / conta segura | concessão → token da empresa ativa → remount da tela; senha/MFA/sessões/reauth | duas dimensões “empresa ativa” e filtro BI/consolidado podem confundir; menu não representa availability por empresa | escopo sempre visível; nenhuma informação anterior no contexto novo; acesso direto negado sem revelar dados; conta acessível na troca obrigatória de senha |

**Não transformar requisitos em fatos:** lote/validade/rastreabilidade integral, reserva expiráveis, entidade completa de transferência física, troca/crédito financeiro integral, relatório de importações/rollback e central de todos os relatórios continuam dependendo de implementação/decisão. Movimentação de transferência já existe; isso não comprova uma entidade logística de transferência completa. A planta reserva o lugar do fluxo; não cria tabela, motor ou promessa de homologação.

## 8. Nomenclatura e conceitos

| Atual | Proposta de apresentação | Motivo / preservação |
|---|---|---|
| Meu Negócio, classe Dashboard, título da aba raiz BROBOND ERP | **Meu Negócio** como página inicial e BI; marca **BROBOND ERP** | Dashboard é nome técnico interno, não módulo concorrente. Manter `/` e id dashboard, títulos com contexto |
| BROBOUND | **BROBOND** | BROBOUND não foi localizado como rótulo atual no código auditado; não relatar correção fictícia. Marca/arquivo legado em documentação não renomeia domínio |
| Produtos em CORE e Produtos em Commerce | **Produtos** no CORE / **Catálogo multicanal** no espaço Commerce planned | evitar ambiguidade sem fundir entidade autoritativa com publicação de canal |
| Categorias em Cadastros e Financeiro | Categorias de produto / Categorias financeiras quando fora do contexto local | mesmo label atual não é mesmo recurso |
| Grade | Grades e tamanhos (grupo), **Grades** (cadastro), **Tabela de medidas** (função) | plural e relação claras; não fundir tamanhos/medidas em um só resource |
| Cadeias de Fabricação | **Ordens de produção (OP)** | entidade atual é ordem de fabricação com status/itens/apontamentos, não cadeia de suprimento |
| Ficha Técnica / BOM | **Fichas técnicas**; “estrutura de materiais (BOM)” na ajuda/descrição | preservar termo técnico pesquisável sem obrigar inglês no menu |
| Custos (produção) | **Custo de fabricação** | diferente de Centros de custo e rentabilidade financeira |
| Vendas / Compras | **Pedidos de venda / Pedidos de compra** na entrada de operação | esclarece lista de pedidos versus área/jornada; IDs/paths permanecem |
| Caixas do PDV / PDV — venda balcão | **Gestão de caixas** / **PDV (venda de balcão)** | papéis e ações distintos, não duplicar caixa como conta bancária |
| De-Para de produtos | **Códigos do fornecedor (de-para)** | relação fornecedor ↔ SKU/tamanho ERP, não outro produto |
| Logística e envios / Expedição | **Envios e rastreio** / **Expedição** | embalagem/conferência versus transportadora/remessa/etiqueta |
| Devoluções e reversa | **Devoluções** em Pós-venda | logística reversa é etapa da jornada, não dono de todo o processo financeiro/fiscal |
| Recolhimentos e recorrências | **Recorrências financeiras** | UI contém recorrência, não prova engine tributária de recolhimentos |
| Contas / Transferências | **Contas financeiras** / **Transferências financeiras** em busca/contexto global | transferência física é Movimentações; evitar promessa de transporte pelo path `/transferencias` |
| Configurações | **Minha conta** para `/config`; **Administração** para gestão do sistema | sem impedir senha/MFA/sessões ao não-admin; configurações operacionais têm contexto de domínio |
| Webhooks na seção Commerce / Integrações | **Webhooks e automações** em Administração | recurso administrativo outbound/global do ERP, não um canal de venda |
| Trends / Delivery / Matches / Outreach AI | apresentação PT-BR contextual: Tendências, Entregas multicanal, Afinidades, Contato assistido | todos planned e fora do core; definir vocabulário com produto, sem renomear identificador técnico ou fingir tradução implementada |
| admin / gerente / operador | Administrador / Gerente / Operador como rótulos | não migrar valores persistidos. “Membro” da especificação só pode ser alias de apresentação após decisão explícita, não substituir PERFIL_RANK |

Nomes devem ser substantivos de domínio para módulos e verbos para ações. Não usar emoji como informação única (ex.: Delivery), “Mais” como depósito permanente de recursos sem dono, marcas técnicas como áreas, nem labels que prometam função indisponível. Glossário e keywords devem preservar sinônimos úteis: pedido/venda, OP/ordem/fabricação, BOM/ficha, de-para/código do fornecedor, caixa/balcão, contas/títulos.


## 9. Problemas priorizados, impacto e recomendação

Prioridades deste documento são da **implementação futura**, não autorização para corrigir no ciclo de auditoria. **P0 = segurança/escopo ou pré-condição do contrato de acesso/jornada**, P1 = estrutura ou fluxo funcional quebrado/incompleto, P2 = consistência/discoverability/UX e cobertura, P3 = nomenclatura/legado/governança. Nenhum teste de exploração ou dado de produção foi usado para qualificar severidade de segurança.

| ID | Prioridade | Problema | Impacto | Evidência | Recomendação (próximo ciclo) |
|---|---|---|---|---|---|
| UX02-01 | P0 | Tenant ausente em endpoints especializados | Leitura/escrita por ID e agregados de empresa não concedida são possíveis no caminho estático; perfil/sessão não autorizam o registro. Não testado HTTP/produção. | pgstore.ts:269–305; catalogos.ts:451–557; portal.ts:113–144; pdf.ts:56–74,216–229; qrcode.ts:gerarConteudoQR; nfe.ts:39–48,202–210; quality.ts:43–61,135–150; §6.2.1 | Autorizar registro e relacionados + filtrar empresa por endpoint; testes A/B/C JSON/PDF/QR/leitura/escrita antes de nova exposição; sem correção neste ciclo. |
| UX02-02 | P0 | Contrato menu × destino × API não equivalente | Itens escondidos continuam acessíveis por URL/API (conectores/listas/envios/XML/sugestão); gerente negar e catálogos têm descoberta incoerente. Empresas minPerfil não guarda rota. | App.tsx:37–85; modules.ts:382–390; services.ts:129–177; connectors.ts:148–249; suprimentos.ts:388–390; compras.ts:439–441,567–570 | Definir política efetiva por ação/destino e aplicar sem broadening; preservar exceção comercial/fluxo; revisar cron/auth/state e capacidades de aprovação distintas. |
| UX02-03 | P0 | PDV permitido no menu, caixa obrigatório vedado ao operador | Jornada padrão de balcão não carrega caixa para operador; venderPdv usa vendas/create, mas a dependência da UI exige gerente. | PdvPage.tsx:165–181; pdv.ts:117–126,514–533; resources.ts pdv_caixas minPerfil gerente; modules.ts pdv | Contratar operação versus gestão e caixa autorizado; testar operador real com backend. Não liberar todo caixa gerencial nem esconder PDV sem decisão. |
| UX02-04 | P1 | Quatro famílias de links sem rota | Listas/Propostas/Caixas abrem URL por key SQL sem Route; callback OAuth retorna /conectores inexistente. Fallback mascara quebra. | ModulePage.tsx:368,451–454,697,733,798; App.tsx:77–87; connectors.ts:319; §6.3 A | Destino de detalhe explícito e retorno por provedor/hub aprovado; testar criação/view/voltar/callback erro/sucesso, sem renomear URLs neste ciclo. |
| UX02-05 | P1 | Lista de preço tem cabeçalho, não gestão de preços | Backend resolve vigência/precedência e congela origem; sem itens/histórico/explicação na UI o cadastro não cumpre função. | listasPreco.ts:5–16,110–135,142–189,301–327; ModulePage dispatcher; /listas-preco | Detalhe com produtos/preços/vigência/histórico; uma resolução servidor e origem visível no item. Não duplicar preço no frontend. |
| UX02-06 | P1 | Proposta não cumpre ciclo e criação genérica não envia itens | POST especializado exige ao menos um item; RecordForm do cabeçalho não o fornece. Lista não tem detalhe/enviar/aprovar/recusar/converter. | propostas.ts:229–241,332–396,434–471; resources.ts propostas fields/ops; ModulePage.tsx:84–115,451–454 | Tela/contrato de proposta completa, permissões específicas, validade/eventos/conversão única. Não chamar a descrição de processo de funcionalidade pronta. |
| UX02-07 | P1 | Compra de produto/tamanho representada como insumo | XML/cotação/recebimento suportam produto OU insumo; OrderPage compra carrega/renderiza somente insumo e tamanho só para venda, ocultando SKU/grade de compra. | OrderPage.tsx:112–122,391–413; itens_compra resources; suprimentos.ts:importarXmlCompra; compras.ts:receberParcial | Detalhe tipado e quantidade/restante/custo/local/origem corretos para ambos; testes compra produto+grade, insumo e recebimento parcial/total. |
| UX02-08 | P1 | Contas a pagar da compra falham para perfil de compra | Painel carrega lancamentos_financeiros sem verificar alçada; operador de compra tem 403 em recurso gerente. | OrderPage.tsx:524–525,595–605; resources.ts lancamentos_financeiros minPerfil gerente | Definir informação contextual mínima autorizada ou ocultar com explicação; não liberar financeiro por conveniência da tela de compras. |
| UX02-09 | P1 | Fiscal existe no menu, ciclo/configuração não completo | NCM/Inutilizações são reais; documentos genéricos não oferecem todas as ações/eventos/config por empresa; NFC-e no PDV não cobre toda a área. | index.ts:567–575; fiscal.ts:727–767,916–960; ModulePage.tsx:109–112; PdvPage.tsx:406 | Operação documental/config contextualizada, perfil por ação e estado de homologação real; preservar operador read versus gerente/admin parâmetros. |
| UX02-10 | P1 | Gateway/recebíveis cartão sem superfície financeira | APIs reais de cobrança, configuração, estorno, eventos/retry e agenda de cartão não têm UI correspondente; MP conector não substitui gateway. | index.ts:448–460; gateway.ts:502–745,1192–1225; ausência de chamadas cliente /financeiro/gateway/cartao | Planejar cobrança/agenda no Financeiro e config admin; assinatura/tenant/idempotência antes de interface. Não duplicar integração por marca. |
| UX02-11 | P1 | Conciliação atual não cobre extrato persistente/CNAB | Tela concilia texto/OFX pelo endpoint anterior; não lista/diverge/resolve transações persistidas nem importa CNAB por parser. | FinanceiroPage.tsx:201–222,731–761; index.ts:463–470; extrato.ts:77–205; cnab.ts:183 | Conciliação como subfunção com persistência/revisão/origem/conta/baixa; modelos e histórico honestos, sem criar menu por parser. |
| UX02-12 | P1 | Aprovação não tem fila e compra pendente sem ação de aprovar | Capacidade aprovar e APIs existem, mas cliente não chama fila aprovações nem /compras/:id/aprovar; recebimento/cotação geram dependência de status/alçada. | index.ts:527–530,650–652; approval.ts:120–138; compras.ts:49–53; OrderPage.tsx:269–275; CotacoesCompraPage | Fila/contexto da origem e ações por alçada; distinguir exceção, compra, cotação e proposta. Testar pedido pendente → aprovado → recebido/faturado. |
| UX02-13 | P1 | Qualidade/predição sem jornada apesar de APIs reais | Ordens têm apontamento/perda; não UI de quality nem demandas de prediction. Planejamento/sugestão não representam automaticamente essas APIs. | index.ts:522–534; quality.ts; prediction.ts:41–82,166–231; OrdemDetail/Planejamento/Sugestao | Qualidade na OP e previsão em planejamento/reposição/BI com fonte e escopo; primeiro sanar P0 tenant de qualidade, sem fabricar métricas. |
| UX02-14 | P1 | Árvore flat mistura espaços e escolha de página depende de label de grupo | 13 grupos sem níveis funcionais; Commerce/Creators e Webhooks juntos; alteração de group pode afetar dispatcher dos roadmaps. | modules.ts:294–358; ModulePage.tsx:88–90; Sidebar.tsx:50–154 | Aprovar 8 áreas CORE + espaços separados e casa dos 70 IDs; fonte tipada de destino/status independente do label; árvore ≠ grafo. |
| UX02-15 | P1 | Master Map/Gaps/relatórios históricos divergem do HEAD | Ausências superadas (Fiscal/NCM/Empresas/Comissões/sessões) e gates de outros SHAs podem levar a implementação duplicada. | ERP-MASTER-MAP.md:124, §3; ERP-GAPS.md:529–552,621–639; RELATORIO-ERP-UX-01-AB.md:224–265; ADR-001 | Reconciliar estado com SHA e classificação confirmado/superado/parcial/futuro em ciclo documental autorizado; não alterar esses arquivos agora. |
| UX02-16 | P2 | Central de relatórios cobre 11, não todo escopo de produto | Qualidade fora do seletor; compras/fiscal/logística/clientes/representantes/rentabilidade/gerenciais não são catálogo exportável integral. | RelatoriosPage.tsx:24–37,116–164; relatorios.ts; ERP-GAPS.md:607–615 | Uma central transversal e atalhos filtrados por domínio; contratos/export/empresa comuns, sem duplicar motor nem anunciar relatório não existente. |
| UX02-17 | P2 | Sidebar collapsed/planned sem contexto suficiente | Ícones perdem grupos/espaços; 8 roadmaps aparecem como itens operacionais comuns na descoberta. | Sidebar.tsx:135–154,197–269; modules.ts planned; CommerceModulePage | Status/namespace/tooltip/foco claros e profundidade controlada; casa canônica/contexto, não simplesmente esconder e afirmar revogação. |
| UX02-18 | P2 | Breadcrumb/header não conhecem níveis nem entidade nomeada | group é texto, #id extraído da URL; dev mostra só marca; não há área/subgrupo/contexto de registro. | Layout.tsx:17–20,49–76; ui-kit.tsx:1223–1269 | Trilha de destinos reais e registro tipado/nome autorizado; pais sem página não viram links fictícios; preservar responsividade/aria-current. |
| UX02-19 | P2 | Ctrl+K não pesquisa todo o contrato de produto | Lowercase sem acentos, filhos/ações/estado/espaço; labels repetidos e config/minha conta redundantes; mesmo filtro incompleto de alçada. | CommandPalette.tsx:31–98; modules.ts:382–390 | Fonte canônica, acesso efetivo, sinônimos/acento/namespace/tipo/status; deduplicar destino equivalente sem perder ação senha; registros só por API autorizada. |
| UX02-20 | P2 | Menu/persistência não representam empresa/produto/usuário | CompanySwitcher remonta tela corretamente, mas grupos/colapso são preferências globais por label; não há entitlement de módulo por empresa. | CompanySwitcher.tsx; Layout.tsx:31–32; Sidebar.tsx:22–81; Dashboard filtros empresa | Separar empresa ativa/filtro BI/consolidado; availability versus perfil; migrar preferências por identidade estável, sem restaurar contexto de outro usuário/tenant. |
| UX02-21 | P2 | Tablet/mobile/foco não homologados | md transforma menu em sidebar estática; drawer/backdrop sem contrato completo de foco/Escape; ausência de prova visual real. | Sidebar.tsx:110–129; Layout.tsx:97–108; ui-kit breadcrumb; ambiente sem navegador | Aceitar em browser desktop/tablet/mobile, teclado/tema/scroll/touch/foco, inclusive scanner/formulários. Não redesenhar ou fabricar screenshots neste ciclo. |
| UX02-22 | P2 | Configurações mistura conta/admin e explica perfis de modo excessivo | Senha/MFA/sessões/tema e administração no mesmo destino; descrição gerente promete todos exceto Usuários/Auditoria, mas há outras restrições. | Settings.tsx:33–38,90–245,1027–1064; Layout menu usuário | Conta global acessível na troca de senha; Administração e parâmetros contextualizados; descrição baseada em capacidade/op real, sem alterar perfil persistido. |
| UX02-23 | P2 | Fontes auxiliares geram descoberta/diagnóstico divergente | PAGES_ESPECIAIS tem 15 versus 21 casos; Ajuda usa IDs sem visibleModules; PWA/Swagger/links não compartilham todo contrato de estados/destinos. | modules.ts:328; ModulePage.tsx:92–112; auditar-menu.ts:141–146; AjudaPage.tsx:133–140; openapi.ts | Contrato de destinos/ações/status único para apresentação e gates; documentação/atalhos ligados ao acesso; não deletar PAGES_ESPECIAIS como morto. |
| UX02-24 | P2 | Importação não tem gestão central/histórico/rollback comprovados | Prévia/confirmar/modelo e XML são reais, mas não histórico persistente geral de migração/rollback; ação por cadastro e função suprimentos são diferentes. | ImportModal.tsx:103–118; ImportarNfePage.tsx:67–306; importacao.ts; ERP-GAPS.md:626–629 | Preservar ações contextualizadas; tela de migração/admin só após contratos de job/dry-run/erros/reversão e testes, sem inventar endpoint/histórico. |
| UX02-25 | P2 | Fallback mascara URL inválida e contrato/meta inválido | * redireciona a Meu Negócio; falta de recurso dispara PlannedModule. Erro pode parecer início/roadmap em vez de diagnóstico. | App.tsx:87; ModulePage.tsx:114; PlannedModule.tsx:6–12 | Separar 403/404/erro meta/planned/indisponível com retorno/contexto; mudanças de compatibilidade devem ser deliberadas, não novas telas nesta entrega. |
| UX02-26 | P3 | Legado/API paralela sem contrato de sunset explícito | Marketplace antigo token, NF-e de treino/status anterior e frete estimado convivem com conectores/fiscal/logística atuais. | marketplace.ts:1–9; index.ts:556–580,695–701; nfe.ts:124–158; frete.ts:36–42 | Inventariar consumidores/origem/alias, uma fonte autoritativa por operação e estados de estimativa/simulação; remover apenas em ciclo autorizado. |
| UX02-27 | P3 | Artefatos candidatos à limpeza podem confundir diagnóstico | SW fonte cacheia API mas não está no build; helper sem consumidor e patch backup não aplicado; não provam código runtime duplicado. | client/src/sw.ts:44–58; vite.config.ts:15–29; main.tsx; modules.ts:360; fixes-bloco-a.patch | Provar uso/runtime/consumidor antes de remover; estratégia segura de cache; manter achado documental, sem apagar arquivos/patch/branch agora. |
| UX02-28 | P3 | Nomenclatura ambígua/técnica/desalinhada | Cadeias versus OP, Grade singular, Custos, Recolhimentos, Produtos/Categorias repetidos, labels English/emoji planned e PWA Dashboard. | modules.ts labels; manifest.json:shortcuts; AjudaPage; Settings PERFIL_LABEL | Glossário/labels de apresentação e namespace; manter IDs/paths/valores persistidos; BROBOUND não encontrado não gera correção fictícia. |
| UX02-29 | P3 | Branches divergentes/PR mergeado por grafo podem restaurar código velho | 5 diverged, 6 SHAs distintos exclusivos; PR39 MERGED com SHAs divergentes, PR38 CLOSED e patch alternativo; não existe PR aberto. | consultas gh branches/compare/PRs; §1.1 e Anexo D | Usar HEAD auditado; revisão de equivalência/integração por dono, sem cherry-pick/fechar/merge de branches; não assumir funcionalidade pendente por SHA só. |

**Totais da matriz:** **29 achados únicos — P0 3, P1 12, P2 10, P3 4**. As quatro URLs órfãs, treze famílias sem superfície e contratos latentes são inventários dimensionais; não são 19 ou 21 novos achados a somar a esses 29.

### 9.1 Sequenciamento recomendado (sem execução)

1. **Contrato antes de movimentar menu:** aprovar espaços/áreas/donos e a política efetiva por módulo/ação/URL/API/empresa. Resolver os três P0 no próximo ciclo autorizado; não espalhar exceções de alçada pela Sidebar.
2. **Fechar destinos e jornadas P1:** detalhe de lista/proposta/caixa, retorno OAuth, compra tipada e resumo contextual financeiro, operação fiscal/financeira/aprovação/qualidade. Cada escopo funcional precisa de tela, API, permissão, estado e teste; não juntar todos os itens em um único “reorganizar menu”.
3. **Implementar arquitetura de apresentação:** fonte canônica com identidades estáveis, donos e estados; Navbar/Sidebar/breadcrumb/CommandPalette/atalhos derivam dela. Preservar URLs/reauth/multiempresa/públicos e fluxos existentes. Separar reagrupamento de função nova.
4. **UX e visual futuro:** sem redesign neste ciclo; validar desktop/tablet/mobile, foco, teclado, namespaces, preferência/empresa/estado e busca. Não aumentar o menu para “mostrar tudo que tem tabela”.
5. **Documentação e legado:** reconciliar Master Map/Gaps com o HEAD/novos gates; sunset por consumidores, nunca apagar aliases, SW ou branches só pela idade. Nenhuma branch ou PR foi fechada/mergeada aqui.

## 10. Riscos e dependências que a árvore não resolve sozinha

| Risco/dependência | Evidência atual / limite | Condição para evolução |
|---|---|---|
| READ-ONLY versus boot do servidor | index inicia validação/rotinas; db migra no boot; scripts PG são ativos | manter auditoria sem boot/banco. Em implementação usar banco de teste descartável e gates autorizados, nunca execução contra produção por conveniência |
| PostgreSQL versus DEMO | conectores exigem DB; stores alternam persistência; gate PG oficial no repo | REAL estático não prova PG; executar CI/test:pg/smoke:pg e concorrência/upgrade em ciclo autorizado |
| Tenant em APIs especializadas | §6.2.1: 6 conjuntos sem validação de empresa na aplicação | testes A/B/C e guards de registro/relacionados; permissões de menu não mitigam leitura/escrita direta |
| Alçada de menu diferente da API | §6.2 | não ampliar exposição “para acabar com 403”; revisar fonte da alçada por recurso/capacidade/ação e contrato de destino |
| Herança de perfil por área | Fiscal/Docs para operador, regras para gerente, config para admin | pai/grupo visível quando ao menos um filho é autorizado; não herdar a maior restrição do grupo e excluir todo um domínio |
| Perfil do caixa/PDV | PDV para operador; pdv_caixas gerente | desenho explícito de operação versus gestão/caixa atribuído, seguido de testes, antes de chamar jornada balcão pronta |
| Relação de empresa/conta externa | ator.id nos conectores, empresa_id no core/gateway, filtro BI autorizado/consolidado | validar troca/escopo e permissões sem confundir usuário/conector com tenant operacional |
| Credenciais e homologação | logística/fiscal/gateway/Woo dependem de ambiente e segredos; callback/state/HMAC | status de disponibilidade honesto; testes de contrato com sandbox/mock e homologação externa separada. Nenhum segredo ou consentimento novo nesta auditoria |
| Estimativa versus dado real | frete.ts entrega estimativa; fiscal pode registrar solicitação sem homologar; roadmaps sem API | origem/estado/limite explícitos; não usar aparência premium ou HTTP 200 como selo “emitida/publicada/postada” |
| Projeção BI e fontes de faturamento | ADR-001 + negocios.ts, sales externo versus prefixo erp | reconciliar sem double count, preservar namespace e escopo; cadastro/venda manual analítica não substitui fluxo operacional automaticamente |
| Modelos SQL/Prisma e packages | contratos em resources/store, Prisma unificado e packages sem uso no boot | não deduzir que IngestOrderUseCase liga todos os canais a estoque/financeiro; integração real precisa de chamada, transação, tenant, teste e invariantes |
| Ações idempotentes/reversão | faturamento, recebimento, OP, expedição, inventário, proposta, devolução | a UI futura não duplica side effects, não calcula estoque/financeiro localmente e preserva evento/origem/estado no back-forward/retry |
| Histórico de compra/reversa | parcial/completo com efeitos distintos; devolução total versus ajuste parcial | esclarecer alcance atual antes de prometer crédito/troca/fiscal integral; testes por quantidade/condição e vínculo ao original |
| URLs/identificadores persistidos | paths e keys diferentes, bookmarks, callback, localStorage de grupos | identidade de navegação não pode ser label humano nem nome SQL; manter aliases apenas quando intencionais; migrar preferências sem trocar dados |
| Cache/bundle antigo | SW fonte não ligado; build PWA autoUpdate atual | não atribuir bug atual a cache sem navegador/versão/registro do SW; estratégia segura por tenant e sem cache de API sensível |
| Documentos e branches obsoletos | §1.1 e §11 | não promover doc antiga/commit divergente a especificação corrente nem restaurar menu de Commerce sobre o CORE |
| Visibilidade por empresa/produto | nenhum catálogo de entitlements de módulo encontrado | definir disponibilidade separada de perfil; ocultar não revoga dados; URL/API também devem cumprir o contrato |

### 10.1 Dependências externas não comprovadas

Não foram acessados ML, MP, Nuvemshop, Meta/Instagram, WooCommerce, provedores de frete, fiscal, SMTP ou banco real. Endpoints/configurações/testes no repo confirmam **existência de integração no código**, não autorização da conta, entrega de webhook externo, emissão homologada, postagem, sincronização contínua nem SLA em produção. Creators e o produto Commerce planejado não ganham status REAL por compartilharem ícones/estilo com páginas de conector.

## 11. Documentação, testes e `audit:menu`

### 11.1 Reconciliação das fontes de produto

| Documento/fonte | Uso válido neste relatório | Divergência a não propagar |
|---|---|---|
| UX-01 (auditoria) | diagnóstico anterior, referência das seis áreas, problemas fora do menu | parte do estado de Sidebar/Fiscal/header foi superada pelo A/B |
| UX-01-AB | correção de seções/Fiscal/breadcrumb, fonte única da Sidebar e testes históricos | não implementou subgrupos/árvore definitiva; seus gates verdes não foram repetidos neste ciclo |
| ERP-MASTER-MAP | relações e escopo de domínios, roteiro do produto | ainda há entradas “NCM sem frontend”, Empresas sem CRUD/tela, Comissões sem menu e estados antigos. Não são verdade no HEAD |
| ERP-GAPS | critérios de evolução de reservas/lote, relatórios, imports, integrações e jornadas | NCM/Inutilizações/Empresas/Comissões/Minhas sessões e etapas posteriores têm divergências; há até método de revogação citado como DELETE onde o atual é POST |
| ERP-ONLY/CORE-ROADMAP | separar core dos módulos de ecossistema e gates de domínio | existência de menu/lista não prova o ciclo completo; revalidar a cada commit |
| ADR-001-FONTE-UNICA-FATURAMENTO | fonte autoritativa vendas e projeção sales com namespace | o diagnóstico pré-correção não é o estado final: rotina/projeção ERP já está implementada no HEAD |
| MEU-NEGOCIO-MOTOR-ANALITICO / Etapa 2.1 | contratos de cálculo/filtros e declaração honesta dos gaps | NCM não está mais em Configurações; breadcrumb já existe; sem reclassificar cada falta de série/antifraude como função atual |
| README | fábrica/modo DEMO/PG/boot/PWA/conectores; remoção nativos Shopee/TikTok | árvore de arquivos ainda chama modules/connectors de reservado/Fase 2, embora conectores reais existam |
| Relatórios ERP/E4 posteriores | contexto das melhorias em compras/estoque/expedição/financeiro/fiscal | alegação de teste passado, banco ou produção deve manter data/SHA/modo de origem; não reutilizar como gate deste ciclo |

A recomendação é atualizar posteriormente o Master Map/Gaps com referência a este HEAD e registrar cada gap como confirmado, superado, parcial ou requisito futuro. **Esses arquivos não foram alterados nesta entrega**, para cumprir o escopo de documento único.

### 11.2 O que o gate atual cobre e o que não cobre

`audit:menu` é um gate estático útil, **não uma auditoria completa de produto/RBAC**:

- Detecta path duplicado, grupo/metadado ausente, rota de módulo explícita/gerada, resource inexistente, determinadas diferenças de rank, planned obsoleto e inconsistências declaradas de empresa/SQL.
- Assume que uma rota gerada para o módulo e um resource cadastrado bastam para sua cobertura. Não garante UI de itens/ciclo/ações da Proposta ou Lista de preço.
- Examina só os módulos com `module.resource` para comparação simples de RBAC; não segue todas as dependências de páginas sem resource, como PDV/caixa, XML, sugestão, conectores e BI.
- Exceção de minPerfil comercial não prova a matriz permitir/negar/herdar. O comentário de que o menu replica as permissões de Catálogos é mais amplo que visibleModules realmente faz.
- Não valida todos os links de detalhe por resource.key nem os callbacks backend. Ignora rotas com parâmetros/fallback na análise de “rota sem menu”; as 4 famílias de URL quebrada escapam dessa cobertura.
- Usa PAGES_ESPECIAIS incompleto para planned; não é importação do dispatcher real.
- A varredura de rotas antes do auth lê declarações no index, não inspeciona o corpo/segurança dos routers externos montados. Isso não substitui teste de state/token/HMAC.
- Recurso com referência, whitelist de recursos relacionais ou presença de uma string no cliente não é prova de FK, escopo correto de todos os joins ou navegação funcional.
- Comparação estática da Sidebar **não** é evidência de navegador, responsividade, foco, tablet, autorização de URL ou execução de jornada.

**Execução deste ciclo:** o comando falhou por falta de `tsx` antes de percorrer qualquer regra. Logo **não há contagem oficial de erros/avisos emitida pelo gate UX-02**, nem “gate aprovado”. As contagens e achados acima vêm do inventário independente e leitura. Não se repetiu o comando e não se instalou/npx para mascarar a restrição.

### 11.3 Testes encontrados e lacunas de cobertura

| Família existente | Evidência estática | Limite / teste exigido no próximo ciclo |
|---|---|---|
| modules, Sidebar e Layout | tests de visibilidade, Fiscal, grupos/seções, moduleOfPath, header/breadcrumb, Ctrl+K, públicos/sessão | hoje validam o contrato flat; ampliar para espaço/área/subgrupo, labels/status/destinos e negar/permitir/herdar por ação |
| CompanySwitcher e empresas/BI segurança | token/escopo/remount; testes A/B/C de acesso/cross-tenant no backend | troca real em todos os destinos, direct URL, queries/refs/export, filtro BI/consolidado e availability por empresa |
| PDV/caixas/pagamentos/fiscal | frontend PdvPage e backend pdv/fiscal/PG | testes atuais de UI usam mocks; adicionar operador padrão com backend real e alçada de operação/gestão, não só login de admin |
| Listas/preço/Propostas | testes de domínio/preço/conversão e P1 PG | não existe tela de detalhe operacional correspondente; testar URL de criação/view, itens/histórico/ações, idempotência e origem do preço |
| Compras/XML/cotação/sugestão | frontend/back/PG e recebimento parcial | detalhe de compra produto/insumo/tamanho e contas a pagar por perfil; aprovação recebimento, cancelamento e custo |
| Produção/estoque/expedição/reversa | testes unit/PG/concorrência e UI de OP/grade/inventário/expedição | preservar rastreabilidade e estados; qualidade, previsão, cancel/reabrir/forçar e reversa parcial no contrato futuro |
| Financeiro/comissões/extrato/CNAB/gateway | domínio/PG e UI financeiro/comissões | existência de teste de backend não torna superfície frontend implementada; integrar futuras telas e permissões por tenant |
| Auth/usuários/webhooks/fiscal/loja/conectores | suites de sessão, reauth, assinatura, idempotência, isolamento e providers | não demonstram menu/URL guard de gerente para conectores nem retorno `/conectores`; homologação externa distinta de teste mock |
| packages/domain e infra | invariantes de domínio/adapters testadas em isolamento | não demonstram ligação runtime com Express/conectores; provar uso de produção antes de anunciar pipeline unificado |
| Smokes/CI/menu | scripts e gate PG oficial presentes | **não rodados UX-02**; executar só em ciclo autorizado com dependências/banco de teste |

## 12. Requisitos estruturais e visuais futuros — sem redesign

### 12.1 Requisitos funcionais da navegação

1. **Fonte canônica e identidade estável:** Sidebar expandida/colapsada, Layout, Ctrl+K, PWA/Ajuda/atalhos e links de registro devem resolver o mesmo dono/destino/status. Não derivar URL de label, grupo ou nome SQL.
2. **Separação de espaços:** ERP CORE, Commerce e Creators não compartilham lista indistinta. O usuário deve saber onde está; BI pode mostrar canal externo com origem explícita sem mudar a fronteira do core.
3. **Casa única:** registro de cada módulo com domínio/subdomínio, estado, referência de página/detalhe, recursos e ações. Atalho contextual é alias de navegação, não segundo módulo. Renderização por `module.group` humano não pode ser o mecanismo de escolher a página.
4. **Autorizar três camadas e escopo por endpoint:** descoberta, destino direto e ação. Frontend explica indisponibilidade e não depende do esconder menu; servidor decide dados/efeitos/tenant. Grupos vazios não aparecem; grupos mistos não herdam admin/gerente para todos os filhos.
5. **Subitens/fluxo:** listagem, detalhe, criar/editar, abas, modal e histórico têm contexto e botão voltar claros, preservam filtros/back-forward; não usar `detail: true` sem destino. Nunca converter todo item/evento/tabela em menu.
6. **Estados:** REAL parcial, PLANNED, indisponível por configuração/ambiente, sem permissão, vazio, erro e loading são distintos. Falha de meta não vira roadmap; emissão/postagem/cobrança exige estado real da API.
7. **Breadcrumb:** marca/espaço → área/grupo necessários → módulo → entidade/registro nomeado (SKU/nome/número/status, quando autorizado). Só destinos reais são links; containers sem página são texto. Não expor segredo/ID externo sensível no título.
8. **Busca global:** normalizar acentos/case, sinônimos/keywords, espaço/área/subgrupo, status e tipo (módulo, ação, registro); eliminar equivalências redundantes, respeitar acesso efetivo e tenant. Separar planejados de operações e oferecer contexto para “Produtos/Categorias/Transferências”. Registro só com busca de API autorizada; não indexar tokens públicos.
9. **Contexto empresa:** empresa ativa e filtro/consolidado BI distinguíveis; remount/invalidar estado/cache após troca; status/ação/menu não pode operar no tenant anterior.
10. **Conta/administrativo:** senha provisória/MFA/minhas sessões/tema fora da alçada admin; usuários/empresas/auditoria/reauth/backup e automações sob alçada própria; configuração operacional linkada no domínio.
11. **Contadores/alertas:** derivar de API real e escopo; sem badges fictícios/planned como quantidade, sem novos motores de saldo/margem/financeiro no cliente.
12. **Compatibilidade:** aliases packing, NF-e/frete e callbacks têm owner/política; a nova planta não apaga consumidores remotos. PWA e bookmarks seguem o contrato de destino e sessão.

### 12.2 Requisitos por dispositivo e acessibilidade

| Contexto | Observação de código atual | Requisito de aceite futuro |
|---|---|---|
| Desktop expandido | 13 grupos e até 70 itens; grupos persistidos, área ativa abre; shell/Sidebar usam seções | hierarquia legível, labels completos, estado/namespace, posição coerente por papel; sem menu gigante de entidades técnicas |
| Desktop colapsado | ícones dos módulos, grupos/labels ocultos; title/aria-label existem | contexto de área/espaço no foco/tooltip/expansão; módulos com ícone/label repetido desambiguados; acesso por teclado equivalente |
| Tablet (768/820/1024) | breakpoint md torna Sidebar estática com 16.5rem; não há contrato tablet próprio | validar retrato/paisagem, densidade de tabela, drawer/rail oportuno, header empresa/busca/breadcrumb sem colisão; não afirmar regressão visual sem teste |
| Mobile (320/360/390/430) | drawer + backdrop, menu fechar; listas genéricas viram cartões; breadcrumb esconde ancestrais | foco preso/restaurado, Escape, scroll/body controlados, touch targets >=44px, menu ativo visível, títulos/ações/empresa sem overflow, formulários/scanner/teclado usáveis |
| Teclado/leitor de tela | skip-link, aria labels, aria-current breadcrumb, UI kit com componentes acessíveis; drawer não mostra controle completo de foco | ordem de tab/foco, seta/Enter/Escape em busca/menus, expandido/selecionado/status anunciado, links de containers só se tiver destino real |
| Claro/escuro / conectores | shell/UI kit e páginas de conector têm estilos de origens diferentes | linguagem visual e estados coerentes dentro de cada espaço, contraste AA, foco visível; planned e indisponível não indicados apenas por cor/emoji |
| Carregamento/erro/vazio | Suspense e alerts existem, fallback rota redireciona ao início | diferenciar 401/403/404/405/409/503, configuração/sem dados/planned; recuperação sem perder contexto, sem esconder erro em Meu Negócio |
| Ações críticas | confirmar/reauth e estados em páginas diferentes | confirmação explícita de faturar/receber/fechar/concluir/forçar/estornar/cancelar; botão busy/idempotência/resposta auditável, sem decisões financeiras locais |
| PWA/offline | manifest atalhos e VitePWA autoUpdate, intenção NetworkOnly para API | nenhum dado/credencial de tenant em cache reutilizado; comunicar offline e upgrade; sessão/rota correta ao abrir atalho; sem alegar cache antigo sem evidência |

Esses requisitos **não** escolhem nova paleta, redesenham cards, criam telas nem alteram CSS. O ciclo posterior deve apresentar evidência real de navegador nos tamanhos definidos, não apenas teste de componente jsdom.

## 13. Checklist de aceite e limites de entrega

### 13.1 Auditoria UX-02 (esta entrega)

- [x] Repo, branch, HEAD/base, working tree e PRs registrados antes da análise; branches remotas/paralelas e conteúdo divergente identificados sem merge.
- [x] Árvore atual completa, 70 literais de módulo e 13 grupos/seções reconciliados; não repetir Fiscal/Empresas/Comissões como ausentes.
- [x] Rotas além do menu, todos os arquivos de página, subitens/modais/abas, callbacks/atalhos/fontes alternativas mapeados.
- [x] 298 declarações API, 80 recursos centrais e 8 locais inventariados; RBAC/ops/escopo por família, URL direta e dependências confrontados.
- [x] REAL/PLANNED/LEGACY/ORPHAN/DUPLICADO/FORA DO CORE definidos com denominador; 8 planned não tratados como função entregue.
- [x] Planta proposta com 8 áreas CORE, espaços Commerce/Creators e utilidades, uma casa para cada um dos 70 IDs; URLs existentes preservadas como contrato.
- [x] Justificadas Produção, Logística, Fiscal, Relatórios, Pessoas e integrações; árvore de navegação separada do grafo operacional.
- [x] Jornadas Produto/Venda/Compra/Produção/Financeiro/Devolução e canal/empresa cobertas, com relações reais e lacunas explicitadas.
- [x] Matriz completa de navegação/dependências; 29 problemas com impacto/evidência/recomendação e prioridades P0–P3.
- [x] Requisitos estruturais/visuais/acessibilidade e critérios de implementação futura documentados, sem redesign.
- [x] Tentativa real de audit:menu e sua falha por tsx declaradas; nada instalado, nenhum gate passado inventado.
- [x] Única alteração versionável: este documento; sem implementação, PR, commit, push, merge, banco ou alteração de visual.
- [ ] Revisão independente de produto/engenharia e aprovação do recorte de implementação — **pendente por desenho do processo**, não substituída pelo autor da auditoria.

### 13.2 Aceite do ciclo de implementação separado (não executado)

- [ ] Produto aprova a planta/casas/capacidades/nomes; nenhum requisito futuro é apresentado como atual.
- [ ] P0 de segurança/escopo, contrato de acesso e PDV resolvidos com testes dos três perfis, permitir/negar/herdar, destinos diretos e APIs; sem broadening de privilégio por conveniência.
- [ ] Toda função priorizada tem destino/ações/estado/tenant e dono; links de criação/detalhe/callback/PWA válidos; URLs novas marcadas/migradas conforme contrato.
- [ ] Guard de UI e servidor coerentes por ação, preservando ops de CRUD versus fluxo, reauth, senha provisória, públicos e assinatura externa.
- [ ] Nenhuma duplicação de produto/venda/estoque/financeiro/fiscal/margem; projeção BI mantém fonte autoritativa e namespaces.
- [ ] Testes de componentes/router/URL/API e jornadas completos; evidência navegador desktop/tablet/mobile/teclado/tema/PWA.
- [ ] Rodar typecheck, lint, testes de front/back/packages, audit:menu ampliado, build, smokes e gates PostgreSQL oficiais em ambiente de teste autorizado; guardar comando/resultado/SHA.
- [ ] Sem alterações de banco/código/URLs/RBAC escondidas num PR só de menu; cada mudança funcional tem escopo e migração aprovados.
- [ ] Master Map/Gaps e documentação atualizados sem duplicar “verdades”; interfaces fora do core e legacy têm contratos explícitos.

## 14. Conclusão da auditoria

**READY FOR IMPLEMENTATION — da planta documentada, após revisão independente.** O inventário estático e as decisões de produto estão concluídos; a implementação é um ciclo separado e **não foi iniciada**. P0 de segurança/escopo, acesso e PDV e os P1 são pré-condições/escopos dessa implementação, não correções realizadas.

O sistema atual tem **70 módulos, 82 destinos frontend, 298 registros API e 88 contratos Resource (80 centrais + 8 locais)**. A Sidebar atual é única e já contém Fiscal; a lacuna principal não é “falta de um menu bonito”, mas um contrato flat sem todos os níveis de produto, permissões/destinos/ações incompletamente alinhados e funções reais de backend sem superfície de jornada.

A proposta preserva o ERP CORE como núcleo autoritativo, separa Commerce e Creators, mantém Produção e Fiscal autônomos, coloca entrega/pós-venda na jornada de Vendas, une compra/estoque em Estoque & Suprimentos e organiza relatórios como visão transversal. **O grafo operacional não foi transformado em árvore de joins.** Não foi inventada função, dado, homologação externa, execução de teste ou evidência visual.

**Entrega e escopo final:** somente `docs/RELATORIO-ERP-UX-02.md`. HEAD/base permanecem `26d39fbb0193f61d60033e7033fb7f72bd72fe85`; branch `arena/336daf2e-brobond-erp`. O comando oficial de menu ficou **bloqueado antes de executar por falta de tsx**, separado do status de conclusão da auditoria. Nenhum PR/merge/implementação.

---

## Anexo A — Legenda das APIs e políticas por família

O anexo de endpoints C é exaustivo por declaração. Esta tabela agrupa **responsabilidade, recursos e alçada real**, sem multiplicar cada CRUD por 46 recursos ou chamar tudo de nova área. Quando há ação particular, o handler é a evidência final, não a legenda de grupo. As políticas concretas de cada recurso público/ops estão no Anexo B; a matriz de exceções relevantes está em §6.2.

| Família / fonte do handler | Registros | Área/função | Resources/dados | Alçada / fronteira / limite |
|---|---|---|---|---|
| `approval` | 4 | Vendas/Compras / aprovação de exceção | pedidos e alçada/cap.aprovar | JWT, leitura do pedido/escopo; aprovar/rejeitar cap.aprovar (G herda/O pode concessão) |
| `auth` | 15 | Auth / conta / sessão | usuarios/sessoes/reset/prefs; verificar cadeia audit | JWT em conta própria; públicos login/reset/MFA; admin+reauth onde indicado |
| `backup` | 3 | Administração / backup | tabelas do store/SQL/XLSX | admin no download; info JWT pelo mount (handler sem guarda de admin); batch global intencional a contratar |
| `catalogos` | 7 | Vendas / catálogo público/gestão | catálogos, compartilhamentos/eventos, produto/venda | público por token/senha/validade/rate; gestão cap.share/métricas; P0 tenant especializado |
| `cep` | 1 | Cadastro/endereço / CEP | consulta ViaCEP | JWT; consulta/validação CEP, sem mutação de resource |
| `chat` | 4 | Comunicação / chat | auditoria recurso chat + usuários | JWT e pares de usuário; sem UI; dimensões globais/empresa precisam contrato de produto |
| `cnab` | 2 | Financeiro / importar CNAB | R_EXTRATO/lançamento, parsers de banco | importar financeiro update G/A; lista parsers JWT; não novo recurso público |
| `comissoes` | 2 | Financeiro / comissões | vendas/representantes/lancamentos/R_COMISSOES_EVENTOS | G/A; financeiro read; escopo/filtragem de apuração e venda |
| `compras` | 5 | Suprimentos / compra/recebimento/reposição | compras/recebimento/itens/estoque/custo/financeiro | compras read/update/create; aprovar G/A; sugestão O na API/G UI; escopo/refs/estado |
| `configSistema` | 3 | Administração / endereço público | R_CONFIGURACOES | admin; propriedade de sistema/origem de links |
| `connectors` | 10 | Commerce / conectores/callbacks | conta externa/OAuth/state/credenciais/sales/log/eventos | JWT + DB + ator.id no painel (sem rank gerente); callbacks state/assinatura e webhooks HMAC; retorno órfão |
| `cotacoesCompra` | 10 | Suprimentos / cotação/comparativo | cotação/itens/fornecedores/preços/compras | r read/create/update O/G/A; decidir/cancelar exige G/A; tenant/estado |
| `detail` | 2 | Produto / detalhe e tamanhos | produtos/grade/tamanho/estoque/movimentos/ficha/OP | produtos read e serviços de escopo/refs; O/G/A |
| `empresasApi` | 5 | Administração / empresa ativa/concessões | empresas/usuario_empresas/usuários | JWT; trocar só concedida/consolidado autorizado; administrar concessão admin; token novo |
| `estoque` | 6 | Estoque / grade/inventário/estorno | estoques/locais/movimentos/inventários/itens | r read/create/update/ação e alçada específica; tenant/refs/idempotência; gerente em estorno quando requerido |
| `expedicao` | 14 | Vendas / packing/expedição/reversa | vendas/eventos/divergências, devolução/itens, estoque/financeiro | checkFluxo/read do dono + restrições de ação/estado/tenant; não CRUD CUD de ledger |
| `extrato` | 4 | Financeiro / extrato persistente | R_EXTRATO + lancamento/conta | financeiro read/update G/A; filtro/validação empresa |
| `financeiro` | 9 | Financeiro / títulos/resumo/baixa/conciliar/cartão | lancamentos_financeiros, contas/categorias/centros/aportes/recorrências | minPerfil G/A por r/op; cron atrás de JWT + CRON_SECRET condicional (rever) |
| `fiscal` | 9 | Fiscal / ciclo/empresa/inutilizar | vendas/documentos/eventos/regras/NCM/empresa fiscal | vendas read/update; inutilizar checkFluxo G/A; config admin; escopo e provedor/homologação |
| `frete` | 2 | Frete anterior / CEP/estimativa | consulta CEP e estimativa, sem envio | JWT; **fonte estimativa**, não cotação/postagem/homologação |
| `gateway` | 11 | Financeiro / gateway cobrança/webhooks | R_GATEWAY_CONFIGS/COBRANCAS/WEBHOOK_EVENTS + lancamento | financeiro G/A por r/op; configurar A; ingresso assinatura; cron JWT/secret condicional |
| `importacao` | 3 | Importação contextual | produtos/clientes/fornecedores/insumos/saldos | resource/op conforme tipo, validação por linha/empresa; preview/confirmar/modelo |
| `index` | 13 | Shell/API / health/meta/dashboard/CRUD/status | resource público; meta; dashboard; notificações/socket | JWT exceto health; genérico r/op/tenant, options/export/files conforme dono; status técnicos JWT, não admin só pelo path |
| `instagram.controller` | 2 | Commerce / Meta webhook | assinatura/state/ingestão Instagram | pré-JWT: GET verify token/challenge ou liveness; POST raw HMAC + DB; pass-through não contado |
| `itens` | 8 | Vendas/Compras / itens | vendas/compras, itens_venda/itens_compra | r pedido read/update; deletar item inclui controle de alçada; tenant/refs/estado |
| `listasPreco` | 6 | Vendas / listas/preço/origem | listas_preco/itens/histórico, produto | listas read/update (O/G/A API, G UI); preço produto read; escopo/lista/estado |
| `logistica` | 10 | Vendas / envio/rastreio/cotação | envios/eventos/venda/empresa/produto/cliente | envios r/op sem minPerfil; gerar por vendas/update; config admin; empresa/estado/provedor |
| `loja` | 4 | Commerce / WooCommerce | produtos/estoques/vendas/itens + SKU/tenant | status/read JWT por r; importar/push G/A + r/op e tenant/mapeamento |
| `marketplace` | 2 | LEGACY / marketplace por token | status/credencial + trilha audit | JWT; sem guarda de gerente nos dois handlers; não conector nativo e sem UI |
| `medidas` | 3 | Cadastros / grade e tabela de medidas | grades/tamanhos/medidas/valores | grades read/update + escopo; O/G/A, filhos internos por fluxo |
| `mfa` | 5 | Conta / MFA | usuário/sessão/chaves/códigos | JWT conta própria; reauth/estado de ativação |
| `negocios` | 7 | Meu Negócio / canais/BI/projeção | sales/sale_items/produto_abc + projeção vendas ERP | vendas read + escopo BI; margem/recalcular G/A; manual vendas create/ator.id; efeitos de batch a revisar |
| `nfe` | 3 | Fiscal anterior / dados/status/simulação | vendas/cliente/itens/produtos | vendas read/update; simulação/config condicionais; **P0 tenant ausente**; não emissão fiscal real |
| `openapi` | 2 | Documentação API / Swagger | publicMeta e paths manuais | JWT; não prova de cobertura/RBAC de todos os handlers |
| `pdf` | 2 | Pedido / PDF | venda/compra + cliente/fornecedor/itens | r pedido read O/G/A; **P0 tenant ausente**, autenticação no download |
| `pdv` | 9 | Vendas / balcão/caixa/pagamento | caixa/pagamento/gaveta/produtos/vendas/financeiro | caixa read/checkFluxo G/A; buscar/vender por vendas read/create; P0 dependência operador |
| `portal` | 7 | Vendas / portal e acesso do cliente | portal_acessos/cotacao_decisoes, clientes/vendas | público por token do cliente; gestão clientes read/update; P0 tenant nos administrativos |
| `prediction` | 2 | BI/Planejamento / previsão | produto/vendas/itens/estoque/OP/BOM/insumo | produtos read O/G/A e recorte por empresa; sem tela |
| `producao` | 19 | Produção / BOM/OP/planejamento | ficha/insumos, OP/itens/apontamentos/eventos/stock | r read/update; liberar/cancelar/reabrir/aplicar preço/forçar G/A; iniciar/apontar/concluir read; tenant/estado |
| `propostas` | 10 | Vendas / proposta/negociação | proposta/itens/eventos, clientes/representantes/vendas | criar propostas create+itens; transições proposta read+vendas create, sem cap.aprovar; tenant/estado |
| `qrcode` | 4 | Produto / QR e etiqueta | produto/SKU/grade/catálogo | JWT; read produto nos formatos, dados sem guarda local; **P0 tenant ausente**; não público pelo mount |
| `quality` | 3 | Produção / qualidade/relatório | ordens/auditoria (qualidade) | ordens read/update; **P0 tenant ausente** na leitura/gravação/relatório |
| `relatorios` | 1 | Relatórios / central/export | recursos do relatório (11 nomes) | r recurso/financeiro quando aplicável, filtros/tenant/format; qualidade route separada |
| `scheduled` | 3 | Administração / agendamentos | relatórios/notificações/recorrências/motor/loja | run exige admin; status JWT; cron JWT + CRON_SECRET condicional; batch global interno (rever contrato) |
| `suprimentos` | 6 | Suprimentos / XML e packing aliases | compras/de-para/importacoes_nfe; vendas/itens/grade | XML compras create (O na API, G UI); packing vendas update + estado/tenant |
| `uploads` | 5 | Anexos do dono / arquivo | arquivos + resource dono | JWT e recurso/op; GET files por assinatura/token; escopo do recurso |
| `usuariosAdmin` | 21 | Administração / usuários e convites | usuarios, concessões, política/certificação | admin; reauth ações sensíveis; convite/política públicos por token |
| `variacoes` | 3 | Produto / variações | produtos/grade/tamanho/SKU | produto read/write + validação/escopo; prévia/gerar não menu próprio |
| `webhooks` | 7 | Administração / webhook outbound | R_WEBHOOKS/R_ENTREGAS | admin + reauth por ação; não conector/callback; global |

### Superfícies não somadas como novos endpoints REST

- `app.use` de autenticação, senha provisória, CORS/OPTIONS, JSON/raw parser, resourceParam, static/uploads/SPA/error handlers: middlewares e infraestrutura.
- `instagramWebhookRouter.all` em instagram.controller.ts:128 só faz `next()` para verbos não atendidos; não entrega função de domínio e não entra nas 298 declarações de endpoint.
- Socket.IO em `server/src/websocket.ts`: handshake JWT/sessão; eventos chat enviar/ler, dashboard refresh e notificações, salas por usuário/perfil/dashboard. **Não é Route frontend nem novo item ERP.** Revisão de tenant/revogação/fail-open no handshake deve integrar segurança de realtime no ciclo próprio; o isolamento completo não foi homologado aqui.
- Rotinas agendadas, status/notificações, Swagger/docs e backups possuem APIs REST no Anexo C, mas podem legitimamente existir sem menu. `/admin/scheduled/cron` e cron/retry financeiros estão atrás do auth global e ainda leem CRON_SECRET do mesmo Bearer em seus handlers: contrato de cron externo deve ser revisto/testado, não presumido público nem movido para fora do auth sem análise.


## Anexo B — Inventário dos 80 recursos centrais e 8 contratos locais

### B.1 Registro central, exaustivo

P = público no CRUD **autenticado**, I = interno (resourceParam retorna 404). C/U/D são flags literais de create/update/delete; `—` = falso/ausente. Leitura continua condicionada ao perfil/capacidade/tenant. `detail` é propriedade de backend/UX genérico, **não existência de Route**. `empresa` descreve escopo do contrato, não prova de filtro automático no store bruto.

Oito contratos locais do item B.3 não entram em RESOURCES/publicMeta. Tabelas técnicas/analíticas de Prisma, sessões e conectores têm contratos próprios e não foram contadas como novo Resource por mera existência da tabela. A comparação entre os dois schemas não foi uma execução de migration/PG.

| ID | Resource key | Label | Tabela | Exposição | empresa | minPerfil / admin / exceção | Ops CUD | detail | Dono / superfície | Fonte |
|---|---|---|---|---|---|---|---|---|---|---|
| R01 | `portal_acessos` | Acessos do portal | `portal_acessos` | I (sem CRUD) | — | — | ——— | — | Clientes / Portal / Venda (token e decisão, não menu próprio) | resources.ts:190 |
| R02 | `cotacao_decisoes` | Decisões de cotação | `cotacao_decisoes` | I (sem CRUD) | — | — | ——— | — | Clientes / Portal / Venda (token e decisão, não menu próprio) | resources.ts:199 |
| R03 | `catalogo_compartilhamentos` | Compartilhamentos de catálogo | `catalogo_compartilhamentos` | I (sem CRUD) | — | — | ——— | — | Catálogos / compartilhar / inteligência (P0 tenant especializado) | resources.ts:208 |
| R04 | `catalogo_eventos` | Eventos de catálogo | `catalogo_eventos` | I (sem CRUD) | — | — | ——— | — | Catálogos / compartilhar / inteligência (P0 tenant especializado) | resources.ts:225 |
| R05 | `arquivos` | Arquivos | `arquivos` | I (sem CRUD) | — | — | ——— | — | Anexos do recurso dono; infraestrutura autenticada/signed file | resources.ts:246 |
| R06 | `usuarios` | Usuários | `usuarios` | P (JWT) | — | adminOnly | CUD | — | Administração / Usuários / acesso e concessão de empresa | resources.ts:277 |
| R07 | `auditoria` | Auditoria | `auditoria` | P (JWT) | true | adminOnly | ——— | — | Administração / Auditoria; subfluxos armazenam eventos próprios | resources.ts:356 |
| R08 | `locais` | Locais de estoque | `locais` | P (JWT) | true | — | CUD | — | Estoque & Suprimentos / Estoque / local, movimento, inventário | resources.ts:405 |
| R09 | `empresas` | Empresas | `empresas` | P (JWT) | — | adminOnly | CUD | — | Administração / Empresas e seletor (resource não consta em module.resource) | resources.ts:450 |
| R10 | `impostos_ncm` | Alíquotas por NCM | `impostos_ncm` | P (JWT) | — | gerente | CUD | — | Fiscal / documentos, parâmetros, empresa fiscal e inutilização | resources.ts:498 |
| R11 | `usuario_empresas` | Acesso a empresas | `usuario_empresas` | I (sem CRUD) | — | adminOnly | CUD | — | Administração / Usuários / acesso e concessão de empresa | resources.ts:531 |
| R12 | `tamanhos` | Tamanhos / Grade | `tamanhos` | P (JWT) | — | — | CUD | — | Cadastros / Grades e medidas; internos são subfunção, não nova tela | resources.ts:548 |
| R13 | `grades` | Grades | `grades` | P (JWT) | — | — | CUD | — | Cadastros / Grades e medidas; internos são subfunção, não nova tela | resources.ts:579 |
| R14 | `grade_tamanhos` | Itens de grade | `grade_tamanhos` | I (sem CRUD) | — | — | ——— | — | Cadastros / Grades e medidas; internos são subfunção, não nova tela | resources.ts:614 |
| R15 | `medidas` | Medidas da grade | `medidas` | I (sem CRUD) | — | — | ——— | — | Cadastros / Grades e medidas; internos são subfunção, não nova tela | resources.ts:651 |
| R16 | `medida_valores` | Valores de medida | `medida_valores` | I (sem CRUD) | — | — | ——— | — | Cadastros / Grades e medidas; internos são subfunção, não nova tela | resources.ts:669 |
| R17 | `colecoes` | Coleções | `colecoes` | P (JWT) | true | — | CUD | — | Cadastros / Produtos / classificações | resources.ts:685 |
| R18 | `fornecedores` | Fornecedores | `fornecedores` | P (JWT) | true | — | CUD | — | Cadastros / Pessoas / Fornecedor (contatos internos latentes) | resources.ts:714 |
| R19 | `fornecedor_contatos` | Contatos do fornecedor | `fornecedor_contatos` | I (sem CRUD) | true | — | CUD | — | Cadastros / Pessoas / Fornecedor (contatos internos latentes) | resources.ts:754 |
| R20 | `insumos` | Insumos | `insumos` | P (JWT) | true | — | CUD | — | Cadastro Insumos + Produção/Compras/Estoque de insumos por fluxo | resources.ts:777 |
| R21 | `representantes` | Representantes | `representantes` | P (JWT) | true | — | CUD | — | Cadastros / Pessoas; Vendas/Proposta/Catálogo/Comissão contextual | resources.ts:796 |
| R22 | `clientes` | Clientes | `clientes` | P (JWT) | true | — | CUD | — | Cadastros / Pessoas; Vendas/Proposta/Catálogo/Comissão contextual | resources.ts:823 |
| R23 | `categorias` | Categorias | `categorias` | P (JWT) | — | — | CUD | — | Cadastros / Produtos / classificações | resources.ts:873 |
| R24 | `cores` | Cores | `cores` | P (JWT) | — | — | CUD | — | Cadastros / Produtos / classificações | resources.ts:897 |
| R25 | `produtos` | Produtos | `produtos` | P (JWT) | true | — | CUD | true | Cadastros / Produtos (composição estruturada interna latente) | resources.ts:921 |
| R26 | `produto_composicao` | Composição do produto | `produto_composicao` | I (sem CRUD) | true | — | CUD | — | Cadastros / Produtos (composição estruturada interna latente) | resources.ts:1052 |
| R27 | `regras_fiscais` | Regras fiscais | `regras_fiscais` | P (JWT) | true | gerente | CUD | — | Fiscal / documentos, parâmetros, empresa fiscal e inutilização | resources.ts:1071 |
| R28 | `empresa_fiscal_config` | Configuração fiscal | `empresa_fiscal_config` | I (sem CRUD) | — | adminOnly | ——— | — | Fiscal / documentos, parâmetros, empresa fiscal e inutilização | resources.ts:1115 |
| R29 | `documentos_fiscais` | Documentos fiscais | `documentos_fiscais` | P (JWT) | true | — | ——— | — | Fiscal / documentos, parâmetros, empresa fiscal e inutilização | resources.ts:1154 |
| R30 | `documentos_fiscais_eventos` | Eventos do documento fiscal | `documentos_fiscais_eventos` | I (sem CRUD) | true | — | ——— | — | Fiscal / documentos, parâmetros, empresa fiscal e inutilização | resources.ts:1214 |
| R31 | `inutilizacoes_fiscais` | Inutilizações de numeração | `inutilizacoes_fiscais` | P (JWT) | true | gerente | ——— | — | Fiscal / documentos, parâmetros, empresa fiscal e inutilização | resources.ts:1242 |
| R32 | `estoques` | Estoque Físico | `estoques` | P (JWT) | true | — | CUD | — | Estoque & Suprimentos / Estoque / local, movimento, inventário | resources.ts:1274 |
| R33 | `movimentacoes` | Movimentações | `movimentacoes` | P (JWT) | true | — | C—— | — | Estoque & Suprimentos / Estoque / local, movimento, inventário | resources.ts:1296 |
| R34 | `ordens` | Ordens de Fabricação | `ordens_fabricacao` | P (JWT) | true | — | CUD | true | Produção / OP / grade, apontamentos, eventos e custo | resources.ts:1355 |
| R35 | `fichas` | Ficha Técnica / BOM | `fichas_tecnicas` | P (JWT) | true | — | CUD | true | Produção / Ficha técnica e custo / BOM/insumos | resources.ts:1433 |
| R36 | `compras` | Compras | `compras` | P (JWT) | true | — | CUD | true | Estoque & Suprimentos / Compras / item, XML/de-para, recebimento | resources.ts:1460 |
| R37 | `vendas` | Vendas | `vendas` | P (JWT) | true | — | CUD | true | Vendas / Pedido / itens / origem / efeitos de faturamento | resources.ts:1546 |
| R38 | `itens_venda` | Itens de venda | `itens_venda` | I (sem CRUD) | true | — | ——— | — | Vendas / Pedido / itens / origem / efeitos de faturamento | resources.ts:1699 |
| R39 | `itens_compra` | Itens de compra | `itens_compra` | I (sem CRUD) | true | — | ——— | — | Estoque & Suprimentos / Compras / item, XML/de-para, recebimento | resources.ts:1723 |
| R40 | `produto_fornecedor_skus` | De-para de produtos do fornecedor | `produto_fornecedor_skus` | P (JWT) | true | — | CU— | — | Estoque & Suprimentos / Compras / item, XML/de-para, recebimento | resources.ts:1758 |
| R41 | `importacoes_nfe` | Importações de NF-e | `importacoes_nfe` | I (sem CRUD) | true | — | ——— | — | Estoque & Suprimentos / Compras / item, XML/de-para, recebimento | resources.ts:1785 |
| R42 | `itens_ordem` | Itens da OP (grade) | `itens_ordem` | I (sem CRUD) | true | — | ——— | — | Produção / OP / grade, apontamentos, eventos e custo | resources.ts:1811 |
| R43 | `ordens_eventos` | Eventos da OP | `ordens_eventos` | I (sem CRUD) | true | — | ——— | — | Produção / OP / grade, apontamentos, eventos e custo | resources.ts:1833 |
| R44 | `ordens_apontamentos` | Apontamentos de produção | `ordens_apontamentos` | I (sem CRUD) | true | — | ——— | — | Produção / OP / grade, apontamentos, eventos e custo | resources.ts:1879 |
| R45 | `itens_ficha_tecnica` | Insumos da ficha técnica | `itens_ficha_tecnica` | I (sem CRUD) | true | — | ——— | — | Produção / Ficha técnica e custo / BOM/insumos | resources.ts:1902 |
| R46 | `estoque_insumos` | Estoque de Insumos | `estoque_insumos` | P (JWT) | true | — | —U— | — | Cadastro Insumos + Produção/Compras/Estoque de insumos por fluxo | resources.ts:1923 |
| R47 | `movimentacoes_insumos` | Movimentações de Insumos | `movimentacoes_insumos` | P (JWT) | true | — | C—— | — | Cadastro Insumos + Produção/Compras/Estoque de insumos por fluxo | resources.ts:1941 |
| R48 | `inventarios` | Inventários | `inventarios` | P (JWT) | true | — | CU— | — | Estoque & Suprimentos / Estoque / local, movimento, inventário | resources.ts:1985 |
| R49 | `itens_inventario` | Itens do inventário | `itens_inventario` | I (sem CRUD) | true | — | ——— | — | Estoque & Suprimentos / Estoque / local, movimento, inventário | resources.ts:2018 |
| R50 | `politicas_comerciais` | Políticas comerciais | `politicas_comerciais` | P (JWT) | — | gerente [cap.políticas; minPerfil não aplicado] | CUD | — | Vendas / Oferta e preço / Catálogos públicos e políticas | resources.ts:2041 |
| R51 | `catalogos` | Catálogos públicos | `catalogos` | P (JWT) | true | gerente [cap.catálogo/share/métricas; minPerfil não aplicado] | CUD | — | Vendas / Oferta e preço / Catálogos públicos e políticas | resources.ts:2070 |
| R52 | `categorias_financeiras` | Categorias Financeiras | `categorias_financeiras` | P (JWT) | true | gerente | CUD | — | Financeiro / operação, tesouraria, capital e parâmetros | resources.ts:2124 |
| R53 | `contas_financeiras` | Contas Financeiras | `contas_financeiras` | P (JWT) | true | gerente | CUD | — | Financeiro / operação, tesouraria, capital e parâmetros | resources.ts:2183 |
| R54 | `investidores` | Investidores / Sócios | `investidores` | P (JWT) | true | gerente | CUD | — | Financeiro / operação, tesouraria, capital e parâmetros | resources.ts:2222 |
| R55 | `aportes` | Aportes de Investidores | `aportes` | P (JWT) | true | gerente | CUD | — | Financeiro / operação, tesouraria, capital e parâmetros | resources.ts:2255 |
| R56 | `lancamentos_financeiros` | Lançamentos Financeiros | `lancamentos_financeiros` | P (JWT) | true | gerente | CUD | — | Financeiro / operação, tesouraria, capital e parâmetros | resources.ts:2316 |
| R57 | `recorrencias_financeiras` | Recorrências Financeiras | `recorrencias_financeiras` | P (JWT) | true | gerente | CUD | — | Financeiro / operação, tesouraria, capital e parâmetros | resources.ts:2404 |
| R58 | `centros_custo` | Centros de Custo | `centros_custo` | P (JWT) | true | gerente | CUD | — | Financeiro / operação, tesouraria, capital e parâmetros | resources.ts:2484 |
| R59 | `transferencias_financeiras` | Transferências entre Contas | `transferencias_financeiras` | P (JWT) | true | gerente | CUD | — | Financeiro / operação, tesouraria, capital e parâmetros | resources.ts:2509 |
| R60 | `listas_preco` | Listas de Preço | `listas_preco` | P (JWT) | true | — | CUD | true | Vendas / Lista de preço (itens/histórico sem superfície) | resources.ts:2553 |
| R61 | `lista_preco_itens` | Preços da Lista | `lista_preco_itens` | I (sem CRUD) | true | — | ——— | — | Vendas / Lista de preço (itens/histórico sem superfície) | resources.ts:2577 |
| R62 | `listas_preco_historico` | Histórico de Preços | `listas_preco_historico` | I (sem CRUD) | true | — | ——— | — | Vendas / Lista de preço (itens/histórico sem superfície) | resources.ts:2594 |
| R63 | `propostas` | Propostas Comerciais | `propostas` | P (JWT) | true | — | C—D | true | Vendas / Proposta (lista parcial; ciclo/detalhe órfãos) | resources.ts:2614 |
| R64 | `proposta_itens` | Itens da Proposta | `proposta_itens` | I (sem CRUD) | true | — | ——— | — | Vendas / Proposta (lista parcial; ciclo/detalhe órfãos) | resources.ts:2666 |
| R65 | `proposta_eventos` | Eventos da Proposta | `proposta_eventos` | I (sem CRUD) | true | — | ——— | — | Vendas / Proposta (lista parcial; ciclo/detalhe órfãos) | resources.ts:2688 |
| R66 | `pdv_caixas` | Caixas do PDV | `pdv_caixas` | P (JWT) | true | gerente | ——— | true | Vendas / PDV / caixa/pagamento/movimento de gaveta (P0 operador) | resources.ts:2708 |
| R67 | `pdv_pagamentos` | Pagamentos do PDV | `pdv_pagamentos` | I (sem CRUD) | true | — | ——— | — | Vendas / PDV / caixa/pagamento/movimento de gaveta (P0 operador) | resources.ts:2757 |
| R68 | `pdv_caixa_movimentos` | Movimentos do Caixa | `pdv_caixa_movimentos` | I (sem CRUD) | true | — | ——— | — | Vendas / PDV / caixa/pagamento/movimento de gaveta (P0 operador) | resources.ts:2779 |
| R69 | `envios` | Envios | `envios` | P (JWT) | true | — | —U— | true | Vendas / Atendimento e entrega / Expedição/Envios | resources.ts:2799 |
| R70 | `envio_eventos` | Eventos do Envio | `envio_eventos` | I (sem CRUD) | true | — | ——— | — | Vendas / Atendimento e entrega / Expedição/Envios | resources.ts:2854 |
| R71 | `expedicao_eventos` | Eventos de Expedição | `expedicao_eventos` | I (sem CRUD) | true | — | ——— | — | Vendas / Atendimento e entrega / Expedição/Envios | resources.ts:2879 |
| R72 | `divergencias_conferencia` | Divergências de Conferência | `divergencias_conferencia` | P (JWT) | true | — | —U— | — | Vendas / Atendimento e entrega / Expedição/Envios | resources.ts:2903 |
| R73 | `devolucoes` | Devoluções | `devolucoes` | P (JWT) | true | — | ——— | true | Vendas / Pós-venda / Devolução e relação estoque/financeiro/fiscal | resources.ts:2931 |
| R74 | `devolucao_itens` | Itens da Devolução | `devolucao_itens` | I (sem CRUD) | true | — | ——— | — | Vendas / Pós-venda / Devolução e relação estoque/financeiro/fiscal | resources.ts:2994 |
| R75 | `compra_recebimentos` | Recebimentos de Compra | `compra_recebimentos` | P (JWT) | true | — | ——— | — | Estoque & Suprimentos / Compras / item, XML/de-para, recebimento | resources.ts:3016 |
| R76 | `compra_recebimento_itens` | Itens do Recebimento | `compra_recebimento_itens` | I (sem CRUD) | true | — | ——— | — | Estoque & Suprimentos / Compras / item, XML/de-para, recebimento | resources.ts:3038 |
| R77 | `cotacoes_compra` | Cotações de Compra | `cotacoes_compra` | P (JWT) | true | — | CUD | true | Estoque & Suprimentos / Cotação / comparativo/fornecedores/preços | resources.ts:3066 |
| R78 | `cotacao_compra_itens` | Itens da Cotação | `cotacao_compra_itens` | I (sem CRUD) | true | — | ——— | — | Estoque & Suprimentos / Cotação / comparativo/fornecedores/preços | resources.ts:3110 |
| R79 | `cotacao_compra_fornecedores` | Fornecedores da Cotação | `cotacao_compra_fornecedores` | I (sem CRUD) | true | — | ——— | — | Estoque & Suprimentos / Cotação / comparativo/fornecedores/preços | resources.ts:3130 |
| R80 | `cotacao_compra_precos` | Preços Cotados | `cotacao_compra_precos` | I (sem CRUD) | true | — | ——— | — | Estoque & Suprimentos / Cotação / comparativo/fornecedores/preços | resources.ts:3157 |

### B.2 Relações declaradas: todas as Field.ref do registro central

Abaixo estão **todas** as referências declaradas nos campos dos 80 recursos, inclusive virtuais. Não é uma lista de submenus. Campos-pai armazenados como inteiro, vínculo polimórfico (`recurso/registro_id`, `referencia_tipo/id`), JSON, ligações por SKU/hash, owner/company ou projeção de serviço podem não ser Field.ref; são completados pelo dono/fluxos em §7 e pelo schema. Declaração ref não substitui FK, validação de empresa, status ou prova de execução. Relações de grade/itens/BOM/comissão/fiscal/financeiro/publicação não devem ser inferidas como CRUD de todo filho.

| Resource key | Todas as referências de campo declaradas | Relação funcional / dono |
|---|---|---|
| `portal_acessos` | cliente_id → clientes | Clientes / Portal / Venda (token e decisão, não menu próprio) |
| `cotacao_decisoes` | venda_id → vendas; cliente_id → clientes | Clientes / Portal / Venda (token e decisão, não menu próprio) |
| `catalogo_compartilhamentos` | catalogo_id → catalogos; cliente_id → clientes; usuario_id → usuarios | Catálogos / compartilhar / inteligência (P0 tenant especializado) |
| `catalogo_eventos` | compartilhamento_id → catalogo_compartilhamentos; catalogo_id → catalogos; produto_id → produtos; pedido_id → vendas | Catálogos / compartilhar / inteligência (P0 tenant especializado) |
| `arquivos` | — (sem Field.ref; ver chave pai/fluxo) | Anexos do recurso dono; infraestrutura autenticada/signed file |
| `usuarios` | — (sem Field.ref; ver chave pai/fluxo) | Administração / Usuários / acesso e concessão de empresa |
| `auditoria` | empresa_id → empresas | Administração / Auditoria; subfluxos armazenam eventos próprios |
| `locais` | — (sem Field.ref; ver chave pai/fluxo) | Estoque & Suprimentos / Estoque / local, movimento, inventário |
| `empresas` | — (sem Field.ref; ver chave pai/fluxo) | Administração / Empresas e seletor (resource não consta em module.resource) |
| `impostos_ncm` | — (sem Field.ref; ver chave pai/fluxo) | Fiscal / documentos, parâmetros, empresa fiscal e inutilização |
| `usuario_empresas` | usuario_id → usuarios; empresa_id → empresas | Administração / Usuários / acesso e concessão de empresa |
| `tamanhos` | — (sem Field.ref; ver chave pai/fluxo) | Cadastros / Grades e medidas; internos são subfunção, não nova tela |
| `grades` | tamanhos → tamanhos [virtual] | Cadastros / Grades e medidas; internos são subfunção, não nova tela |
| `grade_tamanhos` | tamanho_id → tamanhos | Cadastros / Grades e medidas; internos são subfunção, não nova tela |
| `medidas` | — (sem Field.ref; ver chave pai/fluxo) | Cadastros / Grades e medidas; internos são subfunção, não nova tela |
| `medida_valores` | tamanho_id → tamanhos | Cadastros / Grades e medidas; internos são subfunção, não nova tela |
| `colecoes` | — (sem Field.ref; ver chave pai/fluxo) | Cadastros / Produtos / classificações |
| `fornecedores` | — (sem Field.ref; ver chave pai/fluxo) | Cadastros / Pessoas / Fornecedor (contatos internos latentes) |
| `fornecedor_contatos` | fornecedor_id → fornecedores | Cadastros / Pessoas / Fornecedor (contatos internos latentes) |
| `insumos` | fornecedor_id → fornecedores | Cadastro Insumos + Produção/Compras/Estoque de insumos por fluxo |
| `representantes` | usuario_id → usuarios | Cadastros / Pessoas; Vendas/Proposta/Catálogo/Comissão contextual |
| `clientes` | representante_id → representantes | Cadastros / Pessoas; Vendas/Proposta/Catálogo/Comissão contextual |
| `categorias` | grade_id → grades | Cadastros / Produtos / classificações |
| `cores` | — (sem Field.ref; ver chave pai/fluxo) | Cadastros / Produtos / classificações |
| `produtos` | categoria_id → categorias; grade_id → grades; colecao_id → colecoes; cor_id → cores; produto_pai_id → produtos; variacao_tamanho_id → tamanhos; fornecedor_id → fornecedores | Cadastros / Produtos (composição estruturada interna latente) |
| `produto_composicao` | produto_id → produtos; componente_id → produtos | Cadastros / Produtos (composição estruturada interna latente) |
| `regras_fiscais` | — (sem Field.ref; ver chave pai/fluxo) | Fiscal / documentos, parâmetros, empresa fiscal e inutilização |
| `empresa_fiscal_config` | empresa_id → empresas | Fiscal / documentos, parâmetros, empresa fiscal e inutilização |
| `documentos_fiscais` | venda_id → vendas; criado_por → usuarios | Fiscal / documentos, parâmetros, empresa fiscal e inutilização |
| `documentos_fiscais_eventos` | documento_id → documentos_fiscais; usuario_id → usuarios | Fiscal / documentos, parâmetros, empresa fiscal e inutilização |
| `inutilizacoes_fiscais` | criado_por → usuarios | Fiscal / documentos, parâmetros, empresa fiscal e inutilização |
| `estoques` | produto_id → produtos; tamanho_id → tamanhos; local_id → locais | Estoque & Suprimentos / Estoque / local, movimento, inventário |
| `movimentacoes` | produto_id → produtos; tamanho_id → tamanhos; local_id → locais; local_destino_id → locais; recebimento_id → compra_recebimentos; item_compra_id → itens_compra; ordem_id → ordens; movimentacao_estorno_id → movimentacoes | Estoque & Suprimentos / Estoque / local, movimento, inventário |
| `ordens` | produto_id → produtos; tamanho_id → tamanhos; responsavel_id → usuarios; local_producao_id → locais; liberada_por → usuarios; cancelada_por → usuarios | Produção / OP / grade, apontamentos, eventos e custo |
| `fichas` | produto_id → produtos | Produção / Ficha técnica e custo / BOM/insumos |
| `compras` | fornecedor_id → fornecedores; aprovada_por → usuarios; fin_conta_id → contas_financeiras | Estoque & Suprimentos / Compras / item, XML/de-para, recebimento |
| `vendas` | cliente_id → clientes; representante_id → representantes; fin_conta_id → contas_financeiras; local_saida_id → locais; documento_fiscal_id → documentos_fiscais; proposta_id → propostas; pdv_caixa_id → pdv_caixas; envio_id → envios | Vendas / Pedido / itens / origem / efeitos de faturamento |
| `itens_venda` | produto_id → produtos; tamanho_id → tamanhos; lista_preco_id → listas_preco | Vendas / Pedido / itens / origem / efeitos de faturamento |
| `itens_compra` | insumo_id → insumos; produto_id → produtos; tamanho_id → tamanhos | Estoque & Suprimentos / Compras / item, XML/de-para, recebimento |
| `produto_fornecedor_skus` | fornecedor_id → fornecedores; produto_id → produtos; tamanho_id → tamanhos | Estoque & Suprimentos / Compras / item, XML/de-para, recebimento |
| `importacoes_nfe` | compra_id → compras; fornecedor_id → fornecedores; usuario_id → usuarios | Estoque & Suprimentos / Compras / item, XML/de-para, recebimento |
| `itens_ordem` | tamanho_id → tamanhos | Produção / OP / grade, apontamentos, eventos e custo |
| `ordens_eventos` | ordem_id → ordens; usuario_id → usuarios | Produção / OP / grade, apontamentos, eventos e custo |
| `ordens_apontamentos` | ordem_id → ordens; tamanho_id → tamanhos; usuario_id → usuarios | Produção / OP / grade, apontamentos, eventos e custo |
| `itens_ficha_tecnica` | insumo_id → insumos | Produção / Ficha técnica e custo / BOM/insumos |
| `estoque_insumos` | insumo_id → insumos | Cadastro Insumos + Produção/Compras/Estoque de insumos por fluxo |
| `movimentacoes_insumos` | insumo_id → insumos; compra_id → compras; recebimento_id → compra_recebimentos; item_compra_id → itens_compra; ordem_id → ordens | Cadastro Insumos + Produção/Compras/Estoque de insumos por fluxo |
| `inventarios` | local_id → locais | Estoque & Suprimentos / Estoque / local, movimento, inventário |
| `itens_inventario` | produto_id → produtos; tamanho_id → tamanhos | Estoque & Suprimentos / Estoque / local, movimento, inventário |
| `politicas_comerciais` | colecao_id → colecoes; catalogo_id → catalogos; cliente_id → clientes | Vendas / Oferta e preço / Catálogos públicos e políticas |
| `catalogos` | colecao_id → colecoes; categoria_id → categorias | Vendas / Oferta e preço / Catálogos públicos e políticas |
| `categorias_financeiras` | pai_id → categorias_financeiras | Financeiro / operação, tesouraria, capital e parâmetros |
| `contas_financeiras` | — (sem Field.ref; ver chave pai/fluxo) | Financeiro / operação, tesouraria, capital e parâmetros |
| `investidores` | — (sem Field.ref; ver chave pai/fluxo) | Financeiro / operação, tesouraria, capital e parâmetros |
| `aportes` | investidor_id → investidores; conta_id → contas_financeiras | Financeiro / operação, tesouraria, capital e parâmetros |
| `lancamentos_financeiros` | categoria_id → categorias_financeiras; conta_id → contas_financeiras; centro_custo_id → centros_custo | Financeiro / operação, tesouraria, capital e parâmetros |
| `recorrencias_financeiras` | categoria_id → categorias_financeiras; conta_id → contas_financeiras; centro_custo_id → centros_custo | Financeiro / operação, tesouraria, capital e parâmetros |
| `centros_custo` | — (sem Field.ref; ver chave pai/fluxo) | Financeiro / operação, tesouraria, capital e parâmetros |
| `transferencias_financeiras` | conta_origem_id → contas_financeiras; conta_destino_id → contas_financeiras | Financeiro / operação, tesouraria, capital e parâmetros |
| `listas_preco` | criado_por → usuarios | Vendas / Lista de preço (itens/histórico sem superfície) |
| `lista_preco_itens` | lista_id → listas_preco; produto_id → produtos | Vendas / Lista de preço (itens/histórico sem superfície) |
| `listas_preco_historico` | lista_id → listas_preco; produto_id → produtos; usuario_id → usuarios | Vendas / Lista de preço (itens/histórico sem superfície) |
| `propostas` | cliente_id → clientes; representante_id → representantes; venda_id → vendas; convertido_por → usuarios; criado_por → usuarios | Vendas / Proposta (lista parcial; ciclo/detalhe órfãos) |
| `proposta_itens` | proposta_id → propostas; produto_id → produtos; tamanho_id → tamanhos; lista_preco_id → listas_preco | Vendas / Proposta (lista parcial; ciclo/detalhe órfãos) |
| `proposta_eventos` | proposta_id → propostas; usuario_id → usuarios | Vendas / Proposta (lista parcial; ciclo/detalhe órfãos) |
| `pdv_caixas` | usuario_id → usuarios; local_id → locais; fechado_por → usuarios | Vendas / PDV / caixa/pagamento/movimento de gaveta (P0 operador) |
| `pdv_pagamentos` | venda_id → vendas; caixa_id → pdv_caixas | Vendas / PDV / caixa/pagamento/movimento de gaveta (P0 operador) |
| `pdv_caixa_movimentos` | caixa_id → pdv_caixas; usuario_id → usuarios | Vendas / PDV / caixa/pagamento/movimento de gaveta (P0 operador) |
| `envios` | venda_id → vendas; criado_por → usuarios | Vendas / Atendimento e entrega / Expedição/Envios |
| `envio_eventos` | envio_id → envios; usuario_id → usuarios | Vendas / Atendimento e entrega / Expedição/Envios |
| `expedicao_eventos` | venda_id → vendas; usuario_id → usuarios | Vendas / Atendimento e entrega / Expedição/Envios |
| `divergencias_conferencia` | venda_id → vendas; usuario_id → usuarios; resolvido_por → usuarios | Vendas / Atendimento e entrega / Expedição/Envios |
| `devolucoes` | venda_id → vendas; cliente_id → clientes; autorizado_por → usuarios; recebido_por → usuarios; criado_por → usuarios; documento_fiscal_id → documentos_fiscais | Vendas / Pós-venda / Devolução e relação estoque/financeiro/fiscal |
| `devolucao_itens` | devolucao_id → devolucoes; produto_id → produtos; tamanho_id → tamanhos; item_venda_id → itens_venda | Vendas / Pós-venda / Devolução e relação estoque/financeiro/fiscal |
| `compra_recebimentos` | compra_id → compras; usuario_id → usuarios | Estoque & Suprimentos / Compras / item, XML/de-para, recebimento |
| `compra_recebimento_itens` | recebimento_id → compra_recebimentos; item_compra_id → itens_compra | Estoque & Suprimentos / Compras / item, XML/de-para, recebimento |
| `cotacoes_compra` | compra_id → compras; decidida_por → usuarios | Estoque & Suprimentos / Cotação / comparativo/fornecedores/preços |
| `cotacao_compra_itens` | cotacao_id → cotacoes_compra; insumo_id → insumos; produto_id → produtos; escolhido_fornecedor_id → fornecedores | Estoque & Suprimentos / Cotação / comparativo/fornecedores/preços |
| `cotacao_compra_fornecedores` | cotacao_id → cotacoes_compra; fornecedor_id → fornecedores | Estoque & Suprimentos / Cotação / comparativo/fornecedores/preços |
| `cotacao_compra_precos` | convite_id → cotacao_compra_fornecedores; item_id → cotacao_compra_itens | Estoque & Suprimentos / Cotação / comparativo/fornecedores/preços |

### B.3 Oito contratos locais fora de RESOURCES

Todos internos e sem CUD genérico; perfil é aplicado pelo handler proprietário, não pelo simples fato de o literal não declarar minPerfil. Campos de vínculo abaixo são relações de serviço/dados e não afirmação de que todos foram declarados como Field.ref ou FK.

| Nome do contrato | key / tabela | empresa | Exposição/ops | Dono / estado | Alçada pelo handler | Relações / campos de vínculo | Fonte |
|---|---|---|---|---|---|---|---|
| `R_COMISSOES_EVENTOS` | `comissoes_eventos` / `comissoes_eventos` | true | internal; CUD fechado | Financeiro / Comissões | financeiro read (G/A); ledger | venda_id, representante_id, lancamento_id, empresa_id [inteiros; vínculos de serviço] | `server/src/comissoes.ts:28` |
| `R_CONFIGURACOES` | `configuracoes` / `configuracoes` | — | internal; CUD fechado | Sistema / senha/endereço público | admin config/política; leitura interna de configuração | chave/valor; usuário atualizador, origem de links/política | `server/src/configuracoes.ts:18` |
| `R_EXTRATO` | `fin_extrato_transacoes` / `fin_extrato_transacoes` | true | internal; CUD fechado | Financeiro / Extrato/Conciliação (sem UI) | lancamentos_financeiros read/update (G/A) | empresa_id, conta_id, lancamento_id, gateway_cobranca_id (quando usado); origem/hash/FITID/estado | `server/src/extrato.ts:24` |
| `R_GATEWAY_CONFIGS` | `gateway_configs` / `gateway_configs` | true | internal; CUD fechado | Financeiro / Gateway (sem UI) | config admin; leitura financeiro | empresa/provedor/ambiente, credenciais e segredo cifrados | `server/src/gateway.ts:45` |
| `R_GATEWAY_COBRANCAS` | `gateway_cobrancas` / `gateway_cobrancas` | true | internal; CUD fechado | Financeiro / Cobrança (sem UI) | lancamentos financeiro read/create/update (G/A) | empresa/lancamento/venda/conta, idempotência/provider_ref/webhook | `server/src/gateway.ts:68` |
| `R_GATEWAY_WEBHOOK_EVENTS` | `gateway_webhook_events` / `gateway_webhook_events` | true | internal; CUD fechado | Financeiro / Eventos gateway (sem UI) | assinatura no ingress; leitura/reprocessar financeiro; cron contratual | empresa/provedor/evento/hash/payload/tentativas/próxima tentativa, cobrança | `server/src/gateway.ts:108` |
| `R_WEBHOOKS` | `webhooks` / `webhooks` | — | internal; CUD fechado | Administração / Webhooks | admin/reauth; recurso global, sem empresa flag | eventos/URL/segredo/ativo, entrega | `server/src/webhooks.ts:27` |
| `R_ENTREGAS` | `webhook_entregas` / `webhook_entregas` | — | internal; CUD fechado | Administração / Entregas webhook | admin/reauth para reenvio | webhook_id/evento/idempotência/estado/status/tentativas/corpo | `server/src/webhooks.ts:48` |

## Anexo C — Inventário completo de 298 registros de API

**Denominador:** uma declaração verbo/template montada. Os 12 templates genéricos (options/list/get/create/put/patch/delete/export e 4 arquivos) não foram multiplicados pelos 46 recursos; o Anexo B define sua superfície/op/perfil. ALL não foi expandido em verbos. Rotas específicas registradas antes das genéricas prevalecem (por exemplo POST/detalhe Propostas); não presumir que todo recurso aceita sempre o CRUD de metadata.

**Fronteira e perfil:** JWT = sessão + bloqueio de senha provisória + política da família/ação no Anexo A/B e exceções em §6.2. EXTERNA = registrada fora da sessão ERP, **não sem autenticação externa**; token/state/assinatura/rate/validade conforme a família. Prefixo `/admin` não impõe sozinho perfil admin; olhar handler. Defaults/ops/reauth/estado/idempotência/tenant se aplicam mesmo que a UI não exponha a ação.

**Cobertura de escopo não presumida:** os seis conjuntos P0 em §6.2.1 têm política de perfil, mas falta de checagem de empresa na aplicação. A coluna JWT não é uma certificação de isolamento.

Aliases de importação são explicitados como `alias (export nome)` quando diferem do nome da definição; a linha aponta ao export real. `inline` indica corpo/handler local na própria declaração, não inexistência de função.

**Métodos:** GET 129 · POST 137 · PUT 17 · PATCH 1 · DELETE 12 · ALL 2 = **298**. Fontes: index 285 · connectors 10 · gateway 1 · Instagram 2. Os dois ALL externos são callback genérico e webhook genérico. A rota específica Instagram é resolvida por constante canônica; o terceiro ALL do controller apenas encaminha `next()` e não entra no total.

| ID | Verbo | Template montado | Família (Anexo A) | Fronteira de sessão | Handler / fonte | Declaração |
|---|---|---|---|---|---|---|
| API-001 | GET | `/api/health` | index | EXTERNA / pré-JWT | inline → server/src/index.ts:307 | server/src/index.ts:307 |
| API-002 | POST | `/api/auth/login` | auth | EXTERNA / pré-JWT | login → server/src/auth.ts:218 | server/src/index.ts:310 |
| API-003 | POST | `/api/auth/login/mfa` | auth | EXTERNA / pré-JWT | loginMFA → server/src/auth.ts:364 | server/src/index.ts:312 |
| API-004 | POST | `/api/auth/mfa/desafio` | auth | EXTERNA / pré-JWT | mfaDesafio → server/src/auth.ts:464 | server/src/index.ts:314 |
| API-005 | POST | `/api/auth/forgot` | auth | EXTERNA / pré-JWT | forgotPassword → server/src/auth.ts:887 | server/src/index.ts:316 |
| API-006 | POST | `/api/auth/reset` | auth | EXTERNA / pré-JWT | resetPassword → server/src/auth.ts:934 | server/src/index.ts:317 |
| API-007 | GET | `/api/convites/:token` | usuariosAdmin | EXTERNA / pré-JWT | infoConvite → server/src/usuariosAdmin.ts:137 | server/src/index.ts:319 |
| API-008 | POST | `/api/convites/aceitar` | usuariosAdmin | EXTERNA / pré-JWT | aceitarConvite → server/src/usuariosAdmin.ts:148 | server/src/index.ts:320 |
| API-009 | GET | `/api/auth/politica-senha` | usuariosAdmin | EXTERNA / pré-JWT | politicaSenhaPublica → server/src/usuariosAdmin.ts:806 | server/src/index.ts:322 |
| API-010 | GET | `/api/publico/catalogo/:token` | catalogos | EXTERNA / pré-JWT | catalogoPublico → server/src/catalogos.ts:106 | server/src/index.ts:324 |
| API-011 | GET | `/api/publico/catalogo/:token/embed` | catalogos | EXTERNA / pré-JWT | catalogoEmbed → server/src/catalogos.ts:611 | server/src/index.ts:326 |
| API-012 | POST | `/api/publico/catalogo/:token/pedido` | catalogos | EXTERNA / pré-JWT | criarPedidoCatalogo → server/src/catalogos.ts:302 | server/src/index.ts:328 |
| API-013 | POST | `/api/publico/catalogo/:token/evento` | catalogos | EXTERNA / pré-JWT | eventoCatalogo → server/src/catalogos.ts:494 | server/src/index.ts:329 |
| API-014 | GET | `/api/portal/:token/pedidos` | portal | EXTERNA / pré-JWT | portalPedidos → server/src/portal.ts:61 | server/src/index.ts:331 |
| API-015 | GET | `/api/portal/:token/pedido/:id` | portal | EXTERNA / pré-JWT | portalPedidoDetalhe → server/src/portal.ts:68 | server/src/index.ts:332 |
| API-016 | POST | `/api/portal/:token/pedido/:id/decisao` | portal | EXTERNA / pré-JWT | decidirCotacao → server/src/portal.ts:90 | server/src/index.ts:333 |
| API-017 | POST | `/api/portal/:token/pedido/:id/recomprar` | portal | EXTERNA / pré-JWT | recomprarPedido → server/src/portal.ts:148 | server/src/index.ts:334 |
| API-018 | GET | `/api/files/:id/:token` | uploads | EXTERNA / pré-JWT | serveFile → server/src/uploads.ts:356 | server/src/index.ts:336 |
| API-019 | GET | `/api/auth/me` | auth | JWT + política da família | me → server/src/auth.ts:820 | server/src/index.ts:346 |
| API-020 | POST | `/api/auth/change-password` | auth | JWT + política da família | changePassword → server/src/auth.ts:844 | server/src/index.ts:347 |
| API-021 | POST | `/api/auth/reautenticar` | auth | JWT + política da família | reautenticar → server/src/auth.ts:580 | server/src/index.ts:349 |
| API-022 | POST | `/api/auth/logout` | auth | JWT + política da família | logout → server/src/auth.ts:633 | server/src/index.ts:351 |
| API-023 | POST | `/api/auth/logout-all` | auth | JWT + política da família | logoutAll → server/src/auth.ts:643 | server/src/index.ts:352 |
| API-024 | GET | `/api/auth/sessoes` | auth | JWT + política da família | listarSessoes → server/src/auth.ts:669 | server/src/index.ts:353 |
| API-025 | POST | `/api/auth/sessoes/:sid/revogar` | auth | JWT + política da família | revogarSessaoHandler → server/src/auth.ts:687 | server/src/index.ts:354 |
| API-026 | GET | `/api/auth/mfa/status` | mfa | JWT + política da família | mfaStatus → server/src/mfa.ts:92 | server/src/index.ts:356 |
| API-027 | POST | `/api/auth/mfa/setup` | mfa | JWT + política da família | mfaSetup → server/src/mfa.ts:104 | server/src/index.ts:357 |
| API-028 | POST | `/api/auth/mfa/ativar` | mfa | JWT + política da família | mfaAtivar → server/src/mfa.ts:117 | server/src/index.ts:358 |
| API-029 | POST | `/api/auth/mfa/desativar` | mfa | JWT + política da família | mfaDesativar → server/src/mfa.ts:175 | server/src/index.ts:359 |
| API-030 | POST | `/api/auth/mfa/codigos` | mfa | JWT + política da família | mfaCodigos → server/src/mfa.ts:152 | server/src/index.ts:360 |
| API-031 | GET | `/api/auth/preferences` | auth | JWT + política da família | getPreferences → server/src/auth.ts:1037 | server/src/index.ts:362 |
| API-032 | PUT | `/api/auth/preferences` | auth | JWT + política da família | savePreferences → server/src/auth.ts:1045 | server/src/index.ts:363 |
| API-033 | POST | `/api/usuarios/:id/senha-temporaria` | usuariosAdmin | JWT + política da família | senhaTemporaria → server/src/usuariosAdmin.ts:212 | server/src/index.ts:365 |
| API-034 | POST | `/api/usuarios/:id/reenviar-convite` | usuariosAdmin | JWT + política da família | reenviarConvite → server/src/usuariosAdmin.ts:194 | server/src/index.ts:366 |
| API-035 | POST | `/api/usuarios/:id/resetar-mfa` | usuariosAdmin | JWT + política da família | resetarMfaUsuario → server/src/usuariosAdmin.ts:777 | server/src/index.ts:367 |
| API-036 | GET | `/api/usuarios/resumo` | usuariosAdmin | JWT + política da família | resumoUsuarios → server/src/usuariosAdmin.ts:303 | server/src/index.ts:370 |
| API-037 | GET | `/api/usuarios/politica-senha` | usuariosAdmin | JWT + política da família | obterPoliticaSenha → server/src/usuariosAdmin.ts:812 | server/src/index.ts:372 |
| API-038 | PUT | `/api/usuarios/politica-senha` | usuariosAdmin | JWT + política da família | salvarPoliticaSenha → server/src/usuariosAdmin.ts:819 | server/src/index.ts:373 |
| API-039 | GET | `/api/usuarios/certificacao` | usuariosAdmin | JWT + política da família | certificacaoUsuarios → server/src/usuariosAdmin.ts:893 | server/src/index.ts:374 |
| API-040 | GET | `/api/usuarios/certificacao/export` | usuariosAdmin | JWT + política da família | exportarCertificacao → server/src/usuariosAdmin.ts:900 | server/src/index.ts:375 |
| API-041 | POST | `/api/usuarios/:id/certificar` | usuariosAdmin | JWT + política da família | certificarUsuario → server/src/usuariosAdmin.ts:932 | server/src/index.ts:376 |
| API-042 | GET | `/api/admin/config/endereco-publico` | configSistema | JWT + política da família | obterEnderecoPublico → server/src/configSistema.ts:47 | server/src/index.ts:379 |
| API-043 | PUT | `/api/admin/config/endereco-publico` | configSistema | JWT + política da família | salvarEnderecoPublico → server/src/configSistema.ts:60 | server/src/index.ts:380 |
| API-044 | DELETE | `/api/admin/config/endereco-publico` | configSistema | JWT + política da família | removerEnderecoPublico → server/src/configSistema.ts:92 | server/src/index.ts:381 |
| API-045 | GET | `/api/webhooks` | webhooks | JWT + política da família | listarWebhooks → server/src/webhooks.ts:261 | server/src/index.ts:383 |
| API-046 | POST | `/api/webhooks` | webhooks | JWT + política da família | criarWebhook → server/src/webhooks.ts:292 | server/src/index.ts:384 |
| API-047 | PUT | `/api/webhooks/:id` | webhooks | JWT + política da família | atualizarWebhook → server/src/webhooks.ts:329 | server/src/index.ts:385 |
| API-048 | DELETE | `/api/webhooks/:id` | webhooks | JWT + política da família | excluirWebhook → server/src/webhooks.ts:379 | server/src/index.ts:386 |
| API-049 | POST | `/api/webhooks/:id/testar` | webhooks | JWT + política da família | testarWebhook → server/src/webhooks.ts:411 | server/src/index.ts:387 |
| API-050 | GET | `/api/webhooks/:id/entregas` | webhooks | JWT + política da família | listarEntregas → server/src/webhooks.ts:424 | server/src/index.ts:388 |
| API-051 | POST | `/api/webhooks/entregas/:id/reenviar` | webhooks | JWT + política da família | reenviarEntrega → server/src/webhooks.ts:464 | server/src/index.ts:389 |
| API-052 | GET | `/api/usuarios/:id/atividade` | usuariosAdmin | JWT + política da família | atividadeUsuario → server/src/usuariosAdmin.ts:434 | server/src/index.ts:390 |
| API-053 | GET | `/api/usuarios/:id/sessoes` | usuariosAdmin | JWT + política da família | sessoesUsuario → server/src/usuariosAdmin.ts:494 | server/src/index.ts:391 |
| API-054 | POST | `/api/usuarios/:id/desativar` | usuariosAdmin | JWT + política da família | desativarUsuario → server/src/usuariosAdmin.ts:514 | server/src/index.ts:392 |
| API-055 | POST | `/api/usuarios/:id/ativar` | usuariosAdmin | JWT + política da família | ativarUsuario → server/src/usuariosAdmin.ts:562 | server/src/index.ts:393 |
| API-056 | POST | `/api/usuarios/:id/desbloquear` | usuariosAdmin | JWT + política da família | desbloquearUsuario → server/src/usuariosAdmin.ts:606 | server/src/index.ts:394 |
| API-057 | POST | `/api/usuarios/:id/bloquear` | usuariosAdmin | JWT + política da família | bloquearUsuario → server/src/usuariosAdmin.ts:643 | server/src/index.ts:395 |
| API-058 | POST | `/api/usuarios/:id/encerrar-sessoes` | usuariosAdmin | JWT + política da família | encerrarSessoesUsuario → server/src/usuariosAdmin.ts:687 | server/src/index.ts:396 |
| API-059 | POST | `/api/usuarios/:id/sessoes/:sid/encerrar` | usuariosAdmin | JWT + política da família | revogarSessaoUsuario → server/src/usuariosAdmin.ts:748 | server/src/index.ts:397 |
| API-060 | POST | `/api/usuarios/:id/forcar-troca-senha` | usuariosAdmin | JWT + política da família | forcarTrocaSenha → server/src/usuariosAdmin.ts:718 | server/src/index.ts:398 |
| API-061 | GET | `/api/admin/auditoria/verificar` | auth | JWT + política da família | verificarAuditoriaHandler → server/src/auth.ts:1068 | server/src/index.ts:400 |
| API-062 | GET | `/api/meta` | index | JWT + política da família | inline → server/src/index.ts:403 | server/src/index.ts:403 |
| API-063 | GET | `/api/dashboard` | index | JWT + política da família | inline → server/src/index.ts:425 | server/src/index.ts:425 |
| API-064 | GET | `/api/financeiro/resumo` | financeiro | JWT + política da família | resumoFinanceiro → server/src/financeiro.ts:564 | server/src/index.ts:434 |
| API-065 | POST | `/api/financeiro/lancamentos` | financeiro | JWT + política da família | criarLancamentoManual → server/src/financeiro.ts:1575 | server/src/index.ts:435 |
| API-066 | POST | `/api/financeiro/lancamentos/:id/baixar` | financeiro | JWT + política da família | baixarLancamento → server/src/financeiro.ts:1534 | server/src/index.ts:436 |
| API-067 | POST | `/api/financeiro/recorrencias/gerar` | financeiro | JWT + política da família | gerarRecorrencias → server/src/financeiro.ts:1002 | server/src/index.ts:437 |
| API-068 | GET | `/api/financeiro/rentabilidade` | financeiro | JWT + política da família | rentabilidade → server/src/financeiro.ts:1023 | server/src/index.ts:438 |
| API-069 | GET | `/api/financeiro/investidores` | financeiro | JWT + política da família | resumoInvestidores → server/src/financeiro.ts:1099 | server/src/index.ts:439 |
| API-070 | POST | `/api/financeiro/conciliacao` | financeiro | JWT + política da família | conciliarExtrato → server/src/financeiro.ts:1228 | server/src/index.ts:440 |
| API-071 | POST | `/api/admin/financeiro/recorrencias` | financeiro | JWT + política da família | cronRecorrencias → server/src/financeiro.ts:1011 | server/src/index.ts:441 |
| API-072 | GET | `/api/financeiro/comissoes` | comissoes | JWT + política da família | resumoComissoes → server/src/comissoes.ts:242 | server/src/index.ts:444 |
| API-073 | GET | `/api/financeiro/comissoes/venda/:id` | comissoes | JWT + política da família | comissoesDaVenda → server/src/comissoes.ts:308 | server/src/index.ts:445 |
| API-074 | GET | `/api/financeiro/cartao/recebiveis` | financeiro | JWT + política da família | recebiveisCartao → server/src/financeiro.ts:1280 | server/src/index.ts:448 |
| API-075 | GET | `/api/financeiro/gateway/providers` | gateway | JWT + política da família | listarGateways → server/src/gateway.ts:500 | server/src/index.ts:451 |
| API-076 | PUT | `/api/financeiro/gateway/config` | gateway | JWT + política da família | configurarGateway → server/src/gateway.ts:525 | server/src/index.ts:452 |
| API-077 | POST | `/api/financeiro/gateway/cobrancas` | gateway | JWT + política da família | criarCobranca → server/src/gateway.ts:585 | server/src/index.ts:453 |
| API-078 | GET | `/api/financeiro/gateway/cobrancas` | gateway | JWT + política da família | listarCobrancas → server/src/gateway.ts:692 | server/src/index.ts:454 |
| API-079 | GET | `/api/financeiro/gateway/cobrancas/:id` | gateway | JWT + política da família | detalheCobranca → server/src/gateway.ts:706 | server/src/index.ts:455 |
| API-080 | POST | `/api/financeiro/gateway/cobrancas/:id/cancelar` | gateway | JWT + política da família | cancelarCobranca → server/src/gateway.ts:716 | server/src/index.ts:456 |
| API-081 | POST | `/api/financeiro/gateway/cobrancas/:id/estornar` | gateway | JWT + política da família | estornarCobranca → server/src/gateway.ts:743 | server/src/index.ts:457 |
| API-082 | GET | `/api/financeiro/gateway/webhooks` | gateway | JWT + política da família | listarEventosWebhook → server/src/gateway.ts:1190 | server/src/index.ts:458 |
| API-083 | POST | `/api/financeiro/gateway/webhooks/:id/reprocessar` | gateway | JWT + política da família | reprocessarEvento → server/src/gateway.ts:1203 | server/src/index.ts:459 |
| API-084 | POST | `/api/admin/financeiro/gateway/webhooks/processar` | gateway | JWT + política da família | cronWebhooks → server/src/gateway.ts:1222 | server/src/index.ts:460 |
| API-085 | POST | `/api/financeiro/extrato/importar` | extrato | JWT + política da família | importarExtrato → server/src/extrato.ts:75 | server/src/index.ts:463 |
| API-086 | GET | `/api/financeiro/extrato` | extrato | JWT + política da família | listarExtrato → server/src/extrato.ts:156 | server/src/index.ts:464 |
| API-087 | POST | `/api/financeiro/extrato/:id/conciliar` | extrato | JWT + política da família | conciliarLinhaManual → server/src/extrato.ts:173 | server/src/index.ts:465 |
| API-088 | POST | `/api/financeiro/extrato/:id/divergir` | extrato | JWT + política da família | marcarDivergencia → server/src/extrato.ts:203 | server/src/index.ts:466 |
| API-089 | GET | `/api/financeiro/cnab/parsers` | cnab | JWT + política da família | listarParsersHandler → server/src/cnab.ts:331 | server/src/index.ts:469 |
| API-090 | POST | `/api/financeiro/cnab/importar` | cnab | JWT + política da família | importarCnab → server/src/cnab.ts:181 | server/src/index.ts:470 |
| API-091 | GET | `/api/produtos/:id/detalhe` | detail | JWT + política da família | productDetail → server/src/detail.ts:39 | server/src/index.ts:473 |
| API-092 | GET | `/api/produtos/:id/tamanhos` | detail | JWT + política da família | produtoTamanhos → server/src/detail.ts:19 | server/src/index.ts:475 |
| API-093 | POST | `/api/suprimentos/compras/importar-xml` | suprimentos | JWT + política da família | importarXmlCompra → server/src/suprimentos.ts:388 | server/src/index.ts:480 |
| API-094 | POST | `/api/vendas/:id/packing-check` | suprimentos | JWT + política da família | packingCheck → server/src/suprimentos.ts:636 | server/src/index.ts:482 |
| API-095 | POST | `/api/vendas/:id/conferir` | suprimentos | JWT + política da família | packingCheck → server/src/suprimentos.ts:636 | server/src/index.ts:484 |
| API-096 | POST | `/api/vendas/:id/checkout` | suprimentos | JWT + política da família | packingCheck → server/src/suprimentos.ts:636 | server/src/index.ts:485 |
| API-097 | POST | `/api/pedidos/:id/packing-check` | suprimentos | JWT + política da família | packingCheck → server/src/suprimentos.ts:636 | server/src/index.ts:486 |
| API-098 | POST | `/api/expedicao/packing-check` | suprimentos | JWT + política da família | packingCheck → server/src/suprimentos.ts:636 | server/src/index.ts:487 |
| API-099 | GET | `/api/vendas/:id/itens` | itens | JWT + política da família | listItens → server/src/itens.ts:86 | server/src/index.ts:490 |
| API-100 | POST | `/api/vendas/:id/itens` | itens | JWT + política da família | createItem → server/src/itens.ts:105 | server/src/index.ts:491 |
| API-101 | PUT | `/api/vendas/:id/itens/:itemId` | itens | JWT + política da família | updateItem → server/src/itens.ts:152 | server/src/index.ts:492 |
| API-102 | DELETE | `/api/vendas/:id/itens/:itemId` | itens | JWT + política da família | deleteItem → server/src/itens.ts:200 | server/src/index.ts:493 |
| API-103 | GET | `/api/compras/:id/itens` | itens | JWT + política da família | listItens → server/src/itens.ts:86 | server/src/index.ts:494 |
| API-104 | POST | `/api/compras/:id/itens` | itens | JWT + política da família | createItem → server/src/itens.ts:105 | server/src/index.ts:495 |
| API-105 | PUT | `/api/compras/:id/itens/:itemId` | itens | JWT + política da família | updateItem → server/src/itens.ts:152 | server/src/index.ts:496 |
| API-106 | DELETE | `/api/compras/:id/itens/:itemId` | itens | JWT + política da família | deleteItem → server/src/itens.ts:200 | server/src/index.ts:497 |
| API-107 | GET | `/api/vendas/:id/pdf` | pdf | JWT + política da família | vendaPDF → server/src/pdf.ts:56 | server/src/index.ts:500 |
| API-108 | GET | `/api/compras/:id/pdf` | pdf | JWT + política da família | compraPDF → server/src/pdf.ts:216 | server/src/index.ts:501 |
| API-109 | GET | `/api/clientes/:id/portal-acessos` | portal | JWT + política da família | administrarAcessosPortal → server/src/portal.ts:113 | server/src/index.ts:504 |
| API-110 | POST | `/api/clientes/:id/portal-acessos` | portal | JWT + política da família | gerarAcessoPortal → server/src/portal.ts:125 | server/src/index.ts:505 |
| API-111 | POST | `/api/clientes/:id/portal-acessos/:acessoId/revogar` | portal | JWT + política da família | revogarAcessoPortal → server/src/portal.ts:137 | server/src/index.ts:506 |
| API-112 | GET | `/api/catalogos/inteligencia` | catalogos | JWT + política da família | inteligenciaCatalogos → server/src/catalogos.ts:510 | server/src/index.ts:509 |
| API-113 | POST | `/api/catalogos/compartilhamentos/:id/revogar` | catalogos | JWT + política da família | revogarCompartilhamento → server/src/catalogos.ts:551 | server/src/index.ts:510 |
| API-114 | POST | `/api/catalogos/:id/compartilhar` | catalogos | JWT + política da família | compartilharCatalogo → server/src/catalogos.ts:451 | server/src/index.ts:513 |
| API-115 | GET | `/api/produtos/:id/qrcode` | qrcode | JWT + política da família | produtoQRCode → server/src/qrcode.ts:71 | server/src/index.ts:516 |
| API-116 | GET | `/api/produtos/:id/qrcode/svg` | qrcode | JWT + política da família | produtoQRCodeSVG → server/src/qrcode.ts:101 | server/src/index.ts:517 |
| API-117 | GET | `/api/produtos/:id/qrcode/dados` | qrcode | JWT + política da família | produtoQRDados → server/src/qrcode.ts:124 | server/src/index.ts:518 |
| API-118 | GET | `/api/produtos/:id/qrcode/etiqueta` | qrcode | JWT + política da família | produtoEtiquetaQR → server/src/qrcode.ts:132 | server/src/index.ts:519 |
| API-119 | GET | `/api/ordens/:id/qualidade` | quality | JWT + política da família | listQualidade → server/src/quality.ts:43 | server/src/index.ts:522 |
| API-120 | POST | `/api/ordens/:id/qualidade` | quality | JWT + política da família | createQualidade → server/src/quality.ts:80 | server/src/index.ts:523 |
| API-121 | GET | `/api/relatorios/qualidade` | quality | JWT + política da família | relatorioQualidade → server/src/quality.ts:135 | server/src/index.ts:524 |
| API-122 | GET | `/api/aprovacoes/count` | approval | JWT + política da família | countAprovacoes → server/src/approval.ts:206 | server/src/index.ts:527 |
| API-123 | GET | `/api/aprovacoes` | approval | JWT + política da família | listAprovacoes → server/src/approval.ts:85 | server/src/index.ts:528 |
| API-124 | POST | `/api/aprovacoes/:id/aprovar` | approval | JWT + política da família | aprovarPedido → server/src/approval.ts:121 | server/src/index.ts:529 |
| API-125 | POST | `/api/aprovacoes/:id/rejeitar` | approval | JWT + política da família | rejeitarPedido → server/src/approval.ts:160 | server/src/index.ts:530 |
| API-126 | GET | `/api/predicao/demanda` | prediction | JWT + política da família | predicaoDemanda → server/src/prediction.ts:40 | server/src/index.ts:533 |
| API-127 | GET | `/api/predicao/insumos` | prediction | JWT + política da família | predicaoInsumos → server/src/prediction.ts:165 | server/src/index.ts:534 |
| API-128 | GET | `/api/admin/scheduled/status` | scheduled | JWT + política da família | scheduledStatus → server/src/scheduled.ts:319 | server/src/index.ts:537 |
| API-129 | GET | `/api/admin/scheduled/run` | scheduled | JWT + política da família | runScheduled → server/src/scheduled.ts:264 | server/src/index.ts:538 |
| API-130 | POST | `/api/admin/scheduled/cron` | scheduled | JWT + política da família | cronScheduled → server/src/scheduled.ts:298 | server/src/index.ts:539 |
| API-131 | GET | `/api/admin/notificacoes/status` | index | JWT + política da família | inline → server/src/index.ts:542 | server/src/index.ts:542 |
| API-132 | GET | `/api/docs/openapi.json` | openapi | JWT + política da família | openapiJSON → server/src/openapi.ts:120 | server/src/index.ts:545 |
| API-133 | GET | `/api/docs` | openapi | JWT + política da família | openapiUI → server/src/openapi.ts:124 | server/src/index.ts:546 |
| API-134 | GET | `/api/chat/conversas` | chat | JWT + política da família | listConversas → server/src/chat.ts:22 | server/src/index.ts:549 |
| API-135 | GET | `/api/chat/nao-lidas` | chat | JWT + política da família | countNaoLidas → server/src/chat.ts:127 | server/src/index.ts:550 |
| API-136 | GET | `/api/chat/:userId/mensagens` | chat | JWT + política da família | listMensagens → server/src/chat.ts:62 | server/src/index.ts:551 |
| API-137 | POST | `/api/chat/:userId/mensagens` | chat | JWT + política da família | sendMessage → server/src/chat.ts:97 | server/src/index.ts:552 |
| API-138 | GET | `/api/vendas/:id/nfe/dados` | nfe | JWT + política da família | nfeDados → server/src/nfe.ts:114 | server/src/index.ts:556 |
| API-139 | POST | `/api/vendas/:id/nfe/emitir` | nfe | JWT + política da família | nfeEmitir → server/src/nfe.ts:140 | server/src/index.ts:557 |
| API-140 | GET | `/api/vendas/:id/nfe/status` | nfe | JWT + política da família | nfeStatus → server/src/nfe.ts:202 | server/src/index.ts:558 |
| API-141 | GET | `/api/produtos/:id/variacoes` | variacoes | JWT + política da família | listarVariacoes → server/src/variacoes.ts:314 | server/src/index.ts:561 |
| API-142 | GET | `/api/produtos/:id/variacoes/previa` | variacoes | JWT + política da família | previaVariacoes → server/src/variacoes.ts:153 | server/src/index.ts:562 |
| API-143 | POST | `/api/produtos/:id/variacoes` | variacoes | JWT + política da família | gerarVariacoes → server/src/variacoes.ts:228 | server/src/index.ts:563 |
| API-144 | GET | `/api/vendas/:id/fiscal` | fiscal | JWT + política da família | situacaoFiscalVenda → server/src/fiscal.ts:698 | server/src/index.ts:567 |
| API-145 | GET | `/api/vendas/:id/fiscal/previa` | fiscal | JWT + política da família | previaDocumento → server/src/fiscal.ts:1049 | server/src/index.ts:568 |
| API-146 | POST | `/api/vendas/:id/fiscal/emitir` | fiscal | JWT + política da família | emitirDocumento → server/src/fiscal.ts:388 | server/src/index.ts:569 |
| API-147 | GET | `/api/fiscal/documentos/:id/eventos` | fiscal | JWT + política da família | eventosDocumento → server/src/fiscal.ts:727 | server/src/index.ts:570 |
| API-148 | POST | `/api/fiscal/documentos/:id/consultar` | fiscal | JWT + política da família | consultarDocumento → server/src/fiscal.ts:737 | server/src/index.ts:571 |
| API-149 | POST | `/api/fiscal/documentos/:id/cancelar` | fiscal | JWT + política da família | cancelarDocumento → server/src/fiscal.ts:765 | server/src/index.ts:572 |
| API-150 | POST | `/api/fiscal/inutilizar` | fiscal | JWT + política da família | inutilizarNumeracao → server/src/fiscal.ts:841 | server/src/index.ts:573 |
| API-151 | GET | `/api/fiscal/config` | fiscal | JWT + política da família | obterConfigFiscal → server/src/fiscal.ts:916 | server/src/index.ts:574 |
| API-152 | PUT | `/api/fiscal/config` | fiscal | JWT + política da família | salvarConfigFiscal → server/src/fiscal.ts:960 | server/src/index.ts:575 |
| API-153 | GET | `/api/cep/:cep` | cep | JWT + política da família | consultarCepHandler → server/src/cep.ts:140 | server/src/index.ts:578 |
| API-154 | GET | `/api/frete/cep` | frete | JWT + política da família | consultarCEP → server/src/frete.ts:7 | server/src/index.ts:579 |
| API-155 | POST | `/api/frete/calcular` | frete | JWT + política da família | calcularFrete → server/src/frete.ts:36 | server/src/index.ts:580 |
| API-156 | GET | `/api/listas-preco/resolver` | listasPreco | JWT + política da família | resolverLista → server/src/listasPreco.ts:323 | server/src/index.ts:589 |
| API-157 | GET | `/api/listas-preco/:id/itens` | listasPreco | JWT + política da família | listarItensLista → server/src/listasPreco.ts:143 | server/src/index.ts:590 |
| API-158 | PUT | `/api/listas-preco/:id/itens` | listasPreco | JWT + política da família | gravarItensLista → server/src/listasPreco.ts:182 | server/src/index.ts:591 |
| API-159 | DELETE | `/api/listas-preco/:id/itens/:produtoId` | listasPreco | JWT + política da família | removerItemLista → server/src/listasPreco.ts:276 | server/src/index.ts:592 |
| API-160 | GET | `/api/listas-preco/:id/historico` | listasPreco | JWT + política da família | historicoLista → server/src/listasPreco.ts:302 | server/src/index.ts:593 |
| API-161 | GET | `/api/produtos/:id/preco` | listasPreco | JWT + política da família | precoProduto → server/src/listasPreco.ts:347 | server/src/index.ts:594 |
| API-162 | POST | `/api/propostas` | propostas | JWT + política da família | criarProposta → server/src/propostas.ts:229 | server/src/index.ts:597 |
| API-163 | GET | `/api/propostas/:id` | propostas | JWT + política da família | detalharProposta → server/src/propostas.ts:288 | server/src/index.ts:598 |
| API-164 | GET | `/api/propostas/:id/itens` | propostas | JWT + política da família | listarItensProposta (export listarItens) → server/src/propostas.ts:317 | server/src/index.ts:599 |
| API-165 | POST | `/api/propostas/:id/itens` | propostas | JWT + política da família | reescreverItensProposta (export reescreverItens) → server/src/propostas.ts:332 | server/src/index.ts:600 |
| API-166 | GET | `/api/propostas/:id/eventos` | propostas | JWT + política da família | eventosProposta → server/src/propostas.ts:540 | server/src/index.ts:601 |
| API-167 | POST | `/api/propostas/:id/enviar` | propostas | JWT + política da família | enviarProposta → server/src/propostas.ts:375 | server/src/index.ts:602 |
| API-168 | POST | `/api/propostas/:id/aprovar` | propostas | JWT + política da família | aprovarProposta → server/src/propostas.ts:380 | server/src/index.ts:603 |
| API-169 | POST | `/api/propostas/:id/recusar` | propostas | JWT + política da família | recusarProposta → server/src/propostas.ts:385 | server/src/index.ts:604 |
| API-170 | POST | `/api/propostas/:id/cancelar` | propostas | JWT + política da família | cancelarProposta → server/src/propostas.ts:390 | server/src/index.ts:605 |
| API-171 | POST | `/api/propostas/:id/converter` | propostas | JWT + política da família | converterProposta → server/src/propostas.ts:435 | server/src/index.ts:606 |
| API-172 | GET | `/api/pdv/caixas/aberto` | pdv | JWT + política da família | caixaAberto → server/src/pdv.ts:116 | server/src/index.ts:609 |
| API-173 | POST | `/api/pdv/caixas` | pdv | JWT + política da família | abrirCaixa → server/src/pdv.ts:68 | server/src/index.ts:610 |
| API-174 | GET | `/api/pdv/caixas/:id/resumo` | pdv | JWT + política da família | resumoCaixaHandler → server/src/pdv.ts:176 | server/src/index.ts:611 |
| API-175 | POST | `/api/pdv/caixas/:id/movimentos` | pdv | JWT + política da família | movimentoCaixa → server/src/pdv.ts:186 | server/src/index.ts:612 |
| API-176 | POST | `/api/pdv/caixas/:id/fechar` | pdv | JWT + política da família | fecharCaixa → server/src/pdv.ts:224 | server/src/index.ts:613 |
| API-177 | GET | `/api/pdv/buscar` | pdv | JWT + política da família | pdvBuscarProduto (export buscarProduto) → server/src/pdv.ts:414 | server/src/index.ts:614 |
| API-178 | POST | `/api/pdv/vendas` | pdv | JWT + política da família | venderPdv → server/src/pdv.ts:513 | server/src/index.ts:615 |
| API-179 | POST | `/api/pdv/vendas/:id/cancelar` | pdv | JWT + política da família | cancelarVendaPdv → server/src/pdv.ts:748 | server/src/index.ts:616 |
| API-180 | GET | `/api/pdv/vendas/:id/pagamentos` | pdv | JWT + política da família | pagamentosVenda → server/src/pdv.ts:824 | server/src/index.ts:617 |
| API-181 | GET | `/api/logistica/config` | logistica | JWT + política da família | obterConfigLogisticaHandler (export obterConfigHandler) → server/src/logistica.ts:681 | server/src/index.ts:620 |
| API-182 | PUT | `/api/logistica/config` | logistica | JWT + política da família | salvarConfigLogisticaHandler (export salvarConfigHandler) → server/src/logistica.ts:694 | server/src/index.ts:621 |
| API-183 | GET | `/api/logistica/frete` | logistica | JWT + política da família | cotarFrete → server/src/logistica.ts:754 | server/src/index.ts:622 |
| API-184 | GET | `/api/envios/rastreio/:codigo` | logistica | JWT + política da família | buscarEnvioPorCodigo (export buscarPorCodigo) → server/src/logistica.ts:1104 | server/src/index.ts:623 |
| API-185 | GET | `/api/envios/:id/eventos` | logistica | JWT + política da família | eventosEnvio → server/src/logistica.ts:948 | server/src/index.ts:624 |
| API-186 | POST | `/api/envios/:id/rastrear` | logistica | JWT + política da família | rastrearEnvio → server/src/logistica.ts:963 | server/src/index.ts:625 |
| API-187 | POST | `/api/envios/:id/status` | logistica | JWT + política da família | atualizarStatusEnvio → server/src/logistica.ts:1020 | server/src/index.ts:626 |
| API-188 | POST | `/api/envios/:id/cancelar` | logistica | JWT + política da família | cancelarEnvio → server/src/logistica.ts:1064 | server/src/index.ts:627 |
| API-189 | GET | `/api/vendas/:id/envio` | logistica | JWT + política da família | envioDaVenda → server/src/logistica.ts:933 | server/src/index.ts:628 |
| API-190 | POST | `/api/vendas/:id/envio` | logistica | JWT + política da família | gerarEnvio → server/src/logistica.ts:801 | server/src/index.ts:629 |
| API-191 | GET | `/api/vendas/:id/expedicao` | expedicao | JWT + política da família | situacaoExpedicao → server/src/expedicao.ts:132 | server/src/index.ts:632 |
| API-192 | POST | `/api/vendas/:id/expedicao/separar` | expedicao | JWT + política da família | separarPedido → server/src/expedicao.ts:107 | server/src/index.ts:633 |
| API-193 | POST | `/api/vendas/:id/expedicao/conferir` | expedicao | JWT + política da família | conferirPedido → server/src/expedicao.ts:226 | server/src/index.ts:634 |
| API-194 | POST | `/api/vendas/:id/expedicao/embalar` | expedicao | JWT + política da família | embalarPedido → server/src/expedicao.ts:325 | server/src/index.ts:635 |
| API-195 | POST | `/api/vendas/:id/expedicao/expedir` | expedicao | JWT + política da família | expedirPedido → server/src/expedicao.ts:336 | server/src/index.ts:636 |
| API-196 | GET | `/api/expedicao/divergencias` | expedicao | JWT + política da família | listarDivergencias → server/src/expedicao.ts:390 | server/src/index.ts:637 |
| API-197 | POST | `/api/expedicao/divergencias/:id/resolver` | expedicao | JWT + política da família | resolverDivergencia → server/src/expedicao.ts:405 | server/src/index.ts:638 |
| API-198 | POST | `/api/devolucoes` | expedicao | JWT + política da família | criarDevolucao → server/src/expedicao.ts:465 | server/src/index.ts:641 |
| API-199 | GET | `/api/devolucoes/:id` | expedicao | JWT + política da família | obterDevolucao → server/src/expedicao.ts:584 | server/src/index.ts:642 |
| API-200 | POST | `/api/devolucoes/:id/autorizar` | expedicao | JWT + política da família | autorizarDevolucao → server/src/expedicao.ts:623 | server/src/index.ts:643 |
| API-201 | POST | `/api/devolucoes/:id/rastreamento` | expedicao | JWT + política da família | registrarRastreamento → server/src/expedicao.ts:652 | server/src/index.ts:644 |
| API-202 | POST | `/api/devolucoes/:id/receber` | expedicao | JWT + política da família | receberDevolucao → server/src/expedicao.ts:693 | server/src/index.ts:645 |
| API-203 | POST | `/api/devolucoes/:id/recusar` | expedicao | JWT + política da família | recusarDevolucao → server/src/expedicao.ts:833 | server/src/index.ts:646 |
| API-204 | POST | `/api/devolucoes/:id/cancelar` | expedicao | JWT + política da família | cancelarDevolucao → server/src/expedicao.ts:837 | server/src/index.ts:647 |
| API-205 | POST | `/api/compras/:id/aprovar` | compras | JWT + política da família | aprovarCompra → server/src/compras.ts:49 | server/src/index.ts:650 |
| API-206 | GET | `/api/compras/:id/recebimentos` | compras | JWT + política da família | listarRecebimentos → server/src/compras.ts:346 | server/src/index.ts:651 |
| API-207 | POST | `/api/compras/:id/receber` | compras | JWT + política da família | receberParcial → server/src/compras.ts:123 | server/src/index.ts:652 |
| API-208 | GET | `/api/cotacoes-compra/:id/comparativo` | cotacoesCompra | JWT + política da família | comparativoCotacao → server/src/cotacoesCompra.ts:125 | server/src/index.ts:657 |
| API-209 | POST | `/api/cotacoes-compra/:id/itens` | cotacoesCompra | JWT + política da família | criarItemCotacao → server/src/cotacoesCompra.ts:233 | server/src/index.ts:658 |
| API-210 | PUT | `/api/cotacoes-compra/:id/itens/:itemId` | cotacoesCompra | JWT + política da família | atualizarItemCotacao → server/src/cotacoesCompra.ts:282 | server/src/index.ts:659 |
| API-211 | DELETE | `/api/cotacoes-compra/:id/itens/:itemId` | cotacoesCompra | JWT + política da família | removerItemCotacao → server/src/cotacoesCompra.ts:313 | server/src/index.ts:660 |
| API-212 | POST | `/api/cotacoes-compra/:id/convidar` | cotacoesCompra | JWT + política da família | convidarFornecedores → server/src/cotacoesCompra.ts:338 | server/src/index.ts:661 |
| API-213 | POST | `/api/cotacoes-compra/:id/abrir` | cotacoesCompra | JWT + política da família | abrirCotacao → server/src/cotacoesCompra.ts:396 | server/src/index.ts:662 |
| API-214 | POST | `/api/cotacoes-compra/:id/cotar` | cotacoesCompra | JWT + política da família | cotarFornecedor → server/src/cotacoesCompra.ts:426 | server/src/index.ts:663 |
| API-215 | POST | `/api/cotacoes-compra/:id/recusar` | cotacoesCompra | JWT + política da família | recusarCotacao → server/src/cotacoesCompra.ts:508 | server/src/index.ts:664 |
| API-216 | POST | `/api/cotacoes-compra/:id/decidir` | cotacoesCompra | JWT + política da família | decidirCotacaoCompra → server/src/cotacoesCompra.ts:542 | server/src/index.ts:665 |
| API-217 | POST | `/api/cotacoes-compra/:id/cancelar` | cotacoesCompra | JWT + política da família | cancelarCotacao → server/src/cotacoesCompra.ts:739 | server/src/index.ts:666 |
| API-218 | GET | `/api/suprimentos/sugestao-compra` | compras | JWT + política da família | sugestaoCompra → server/src/compras.ts:439 | server/src/index.ts:669 |
| API-219 | POST | `/api/suprimentos/sugestao-compra/gerar` | compras | JWT + política da família | gerarCompraDaSugestao → server/src/compras.ts:567 | server/src/index.ts:670 |
| API-220 | GET | `/api/empresas/ativa` | empresasApi | JWT + política da família | empresaAtiva → server/src/empresasApi.ts:41 | server/src/index.ts:674 |
| API-221 | POST | `/api/empresas/ativa` | empresasApi | JWT + política da família | trocarEmpresaAtiva → server/src/empresasApi.ts:67 | server/src/index.ts:675 |
| API-222 | GET | `/api/usuarios/:id/empresas` | empresasApi | JWT + política da família | listarEmpresasDoUsuario → server/src/empresasApi.ts:96 | server/src/index.ts:676 |
| API-223 | POST | `/api/usuarios/:id/empresas` | empresasApi | JWT + política da família | concederEmpresa → server/src/empresasApi.ts:119 | server/src/index.ts:677 |
| API-224 | DELETE | `/api/usuarios/:id/empresas/:empresaId` | empresasApi | JWT + política da família | revogarEmpresa → server/src/empresasApi.ts:153 | server/src/index.ts:678 |
| API-225 | GET | `/api/negocios/canais` | negocios | JWT + política da família | negociosCanais → server/src/negocios.ts:1424 | server/src/index.ts:686 |
| API-226 | GET | `/api/negocios/resumo` | negocios | JWT + política da família | negociosResumo → server/src/negocios.ts:1440 | server/src/index.ts:687 |
| API-227 | GET | `/api/negocios/margens` | negocios | JWT + política da família | negociosMargens → server/src/negocios.ts:1454 | server/src/index.ts:688 |
| API-228 | POST | `/api/negocios/margens/recalcular` | negocios | JWT + política da família | negociosMargensRecalcular → server/src/negocios.ts:1485 | server/src/index.ts:689 |
| API-229 | GET | `/api/negocios/abc` | negocios | JWT + política da família | negociosABC → server/src/negocios.ts:1504 | server/src/index.ts:690 |
| API-230 | POST | `/api/negocios/abc/recalcular` | negocios | JWT + política da família | negociosABCRecalcular → server/src/negocios.ts:1528 | server/src/index.ts:691 |
| API-231 | POST | `/api/negocios/vendas` | negocios | JWT + política da família | negociosVendaManual → server/src/negocios.ts:1542 | server/src/index.ts:692 |
| API-232 | GET | `/api/marketplace/status` | marketplace | JWT + política da família | marketplaceStatus → server/src/marketplace.ts:30 | server/src/index.ts:695 |
| API-233 | POST | `/api/marketplace/sincronizar` | marketplace | JWT + política da família | sincronizarPedidos → server/src/marketplace.ts:41 | server/src/index.ts:696 |
| API-234 | GET | `/api/marketplace/loja/status` | loja | JWT + política da família | statusLoja → server/src/loja.ts:161 | server/src/index.ts:698 |
| API-235 | GET | `/api/marketplace/loja/produtos` | loja | JWT + política da família | produtosLoja → server/src/loja.ts:192 | server/src/index.ts:699 |
| API-236 | POST | `/api/marketplace/loja/pedidos` | loja | JWT + política da família | importarPedidosLoja → server/src/loja.ts:327 | server/src/index.ts:700 |
| API-237 | POST | `/api/marketplace/loja/estoque` | loja | JWT + política da família | sincronizarEstoqueLoja → server/src/loja.ts:554 | server/src/index.ts:701 |
| API-238 | GET | `/api/admin/ws/status` | index | JWT + política da família | inline → server/src/index.ts:704 | server/src/index.ts:704 |
| API-239 | GET | `/api/producao/painel` | producao | JWT + política da família | producaoPainel → server/src/producao.ts:1238 | server/src/index.ts:707 |
| API-240 | GET | `/api/producao/planejamento` | producao | JWT + política da família | planejamentoProducao → server/src/producao.ts:1758 | server/src/index.ts:709 |
| API-241 | GET | `/api/ordens/:id/itens` | producao | JWT + política da família | listItensOrdem → server/src/producao.ts:919 | server/src/index.ts:712 |
| API-242 | POST | `/api/ordens/:id/itens` | producao | JWT + política da família | createItemOrdem → server/src/producao.ts:931 | server/src/index.ts:713 |
| API-243 | PUT | `/api/ordens/:id/itens/:itemId` | producao | JWT + política da família | updateItemOrdem → server/src/producao.ts:966 | server/src/index.ts:714 |
| API-244 | DELETE | `/api/ordens/:id/itens/:itemId` | producao | JWT + política da família | deleteItemOrdem → server/src/producao.ts:998 | server/src/index.ts:715 |
| API-245 | POST | `/api/ordens/:id/liberar` | producao | JWT + política da família | liberarOrdem → server/src/producao.ts:1354 | server/src/index.ts:719 |
| API-246 | POST | `/api/ordens/:id/iniciar` | producao | JWT + política da família | iniciarOrdem → server/src/producao.ts:1420 | server/src/index.ts:720 |
| API-247 | GET | `/api/ordens/:id/apontamentos` | producao | JWT + política da família | listApontamentos → server/src/producao.ts:1451 | server/src/index.ts:721 |
| API-248 | POST | `/api/ordens/:id/apontamentos` | producao | JWT + política da família | criarApontamento → server/src/producao.ts:1504 | server/src/index.ts:722 |
| API-249 | GET | `/api/ordens/:id/eventos` | producao | JWT + política da família | listEventosOrdem → server/src/producao.ts:1470 | server/src/index.ts:723 |
| API-250 | POST | `/api/ordens/:id/concluir` | producao | JWT + política da família | concluirOrdemHandler → server/src/producao.ts:1653 | server/src/index.ts:724 |
| API-251 | POST | `/api/ordens/:id/cancelar` | producao | JWT + política da família | cancelarOrdem → server/src/producao.ts:1673 | server/src/index.ts:725 |
| API-252 | POST | `/api/ordens/:id/reabrir` | producao | JWT + política da família | reabrirOrdem → server/src/producao.ts:1722 | server/src/index.ts:726 |
| API-253 | GET | `/api/fichas/:id/insumos` | producao | JWT + política da família | listInsumosFicha → server/src/producao.ts:1063 | server/src/index.ts:727 |
| API-254 | POST | `/api/fichas/:id/insumos` | producao | JWT + política da família | createInsumoFicha → server/src/producao.ts:1083 | server/src/index.ts:728 |
| API-255 | PUT | `/api/fichas/:id/insumos/:itemId` | producao | JWT + política da família | updateInsumoFicha → server/src/producao.ts:1118 | server/src/index.ts:729 |
| API-256 | DELETE | `/api/fichas/:id/insumos/:itemId` | producao | JWT + política da família | deleteInsumoFicha → server/src/producao.ts:1157 | server/src/index.ts:730 |
| API-257 | POST | `/api/fichas/:id/aplicar-preco` | producao | JWT + política da família | aplicarPrecoFicha → server/src/producao.ts:1192 | server/src/index.ts:731 |
| API-258 | GET | `/api/estoques/grade` | estoque | JWT + política da família | estoqueGrade → server/src/estoque.ts:25 | server/src/index.ts:734 |
| API-259 | GET | `/api/grades/medidas-resumo` | medidas | JWT + política da família | resumoMedidasGrades → server/src/medidas.ts:408 | server/src/index.ts:735 |
| API-260 | GET | `/api/grades/:id/medidas` | medidas | JWT + política da família | getMedidasGrade → server/src/medidas.ts:218 | server/src/index.ts:736 |
| API-261 | PUT | `/api/grades/:id/medidas` | medidas | JWT + política da família | saveMedidasGrade → server/src/medidas.ts:225 | server/src/index.ts:737 |
| API-262 | GET | `/api/inventarios/:id` | estoque | JWT + política da família | getInventarioDetalhe → server/src/estoque.ts:463 | server/src/index.ts:738 |
| API-263 | GET | `/api/inventarios/:id/itens` | estoque | JWT + política da família | listItensInventario → server/src/estoque.ts:211 | server/src/index.ts:739 |
| API-264 | PUT | `/api/inventarios/:id/itens` | estoque | JWT + política da família | updateItensInventario → server/src/estoque.ts:268 | server/src/index.ts:740 |
| API-265 | POST | `/api/inventarios/:id/fechar` | estoque | JWT + política da família | fecharInventario → server/src/estoque.ts:353 | server/src/index.ts:741 |
| API-266 | POST | `/api/movimentacoes/:id/estornar` | estoque | JWT + política da família | estornarMovimentacao → server/src/estoque.ts:504 | server/src/index.ts:742 |
| API-267 | GET | `/api/relatorios/:nome` | relatorios | JWT + política da família | inline → server/src/index.ts:745 | server/src/index.ts:745 |
| API-268 | POST | `/api/importar/preview` | importacao | JWT + política da família | previewImportacao → server/src/importacao.ts:199 | server/src/index.ts:746 |
| API-269 | POST | `/api/importar/confirmar` | importacao | JWT + política da família | confirmarImportacao → server/src/importacao.ts:260 | server/src/index.ts:747 |
| API-270 | GET | `/api/importar/modelo` | importacao | JWT + política da família | modeloImportacao → server/src/importacao.ts:331 | server/src/index.ts:748 |
| API-271 | GET | `/api/:resource/export` | index | JWT + política da família | inline → server/src/index.ts:749 | server/src/index.ts:749 |
| API-272 | GET | `/api/admin/backup` | backup | JWT + política da família | adminBackup → server/src/backup.ts:30 | server/src/index.ts:752 |
| API-273 | GET | `/api/admin/backup/xlsx` | backup | JWT + política da família | adminBackupXlsx → server/src/backup.ts:139 | server/src/index.ts:753 |
| API-274 | GET | `/api/admin/backup/info` | backup | JWT + política da família | backupInfo → server/src/backup.ts:80 | server/src/index.ts:754 |
| API-275 | GET | `/api/:resource/:id/arquivos` | uploads | JWT + política da família | listFiles → server/src/uploads.ts:227 | server/src/index.ts:757 |
| API-276 | POST | `/api/:resource/:id/arquivos` | uploads | JWT + política da família | uploadFile → server/src/uploads.ts:236 | server/src/index.ts:758 |
| API-277 | PUT | `/api/:resource/:id/arquivos/:fid` | uploads | JWT + política da família | updateFile → server/src/uploads.ts:290 | server/src/index.ts:759 |
| API-278 | DELETE | `/api/:resource/:id/arquivos/:fid` | uploads | JWT + política da família | deleteFile → server/src/uploads.ts:324 | server/src/index.ts:760 |
| API-279 | GET | `/api/:resource/options` | index | JWT + política da família | inline → server/src/index.ts:763 | server/src/index.ts:763 |
| API-280 | GET | `/api/:resource` | index | JWT + política da família | inline → server/src/index.ts:774 | server/src/index.ts:774 |
| API-281 | GET | `/api/:resource/:id` | index | JWT + política da família | inline → server/src/index.ts:807 | server/src/index.ts:807 |
| API-282 | POST | `/api/:resource` | index | JWT + política da família | inline → server/src/index.ts:818 | server/src/index.ts:818 |
| API-283 | PUT | `/api/:resource/:id` | index | JWT + política da família | updateHandler → server/src/index.ts:830 | server/src/index.ts:838 |
| API-284 | PATCH | `/api/:resource/:id` | index | JWT + política da família | updateHandler → server/src/index.ts:830 | server/src/index.ts:839 |
| API-285 | DELETE | `/api/:resource/:id` | index | JWT + política da família | inline → server/src/index.ts:842 | server/src/index.ts:842 |
| API-286 | GET | `/api/connectors` | connectors | JWT + política da família | inline → server/src/connectors.ts:148 | server/src/connectors.ts:148 |
| API-287 | POST | `/api/connectors/mercadopago/conectar-ambiente` | connectors | JWT + política da família | inline → server/src/connectors.ts:157 | server/src/connectors.ts:157 |
| API-288 | POST | `/api/connectors/mercadopago/conectar` | connectors | JWT + política da família | inline → server/src/connectors.ts:167 | server/src/connectors.ts:167 |
| API-289 | GET | `/api/connectors/:provider` | connectors | JWT + política da família | inline → server/src/connectors.ts:185 | server/src/connectors.ts:185 |
| API-290 | GET | `/api/connectors/:provider/painel` | connectors | JWT + política da família | inline → server/src/connectors.ts:194 | server/src/connectors.ts:194 |
| API-291 | POST | `/api/connectors/:provider/autorizar` | connectors | JWT + política da família | inline → server/src/connectors.ts:218 | server/src/connectors.ts:218 |
| API-292 | POST | `/api/connectors/:provider/sincronizar` | connectors | JWT + política da família | inline → server/src/connectors.ts:231 | server/src/connectors.ts:231 |
| API-293 | DELETE | `/api/connectors/:provider` | connectors | JWT + política da família | inline → server/src/connectors.ts:242 | server/src/connectors.ts:242 |
| API-294 | ALL | `/api/connectors/:provider/callback` | connectors | EXTERNA / pré-JWT | inline → server/src/connectors.ts:325 | server/src/connectors.ts:325 |
| API-295 | ALL | `/api/webhooks/:provider` | connectors | EXTERNA / pré-JWT | inline → server/src/connectors.ts:380 | server/src/connectors.ts:380 |
| API-296 | POST | `/api/gateway/webhooks/:provider` | gateway | EXTERNA / pré-JWT | inline → server/src/gateway.ts:860 | server/src/gateway.ts:860 |
| API-297 | GET | `/api/webhooks/instagram` | instagram.controller | EXTERNA / pré-JWT | inline → server/src/modules/connectors/instagram/instagram.controller.ts:84 | server/src/modules/connectors/instagram/instagram.controller.ts:84 |
| API-298 | POST | `/api/webhooks/instagram` | instagram.controller | EXTERNA / pré-JWT | inline → server/src/modules/connectors/instagram/instagram.controller.ts:100 | server/src/modules/connectors/instagram/instagram.controller.ts:100 |

## Anexo D — Todas as 39 branches remotas não-main na consulta

Main foi confirmado como `26d39fbb0193f61d60033e7033fb7f72bd72fe85`. Branches locais presentes: main e `arena/336daf2e-brobond-erp`; nenhum checkout/troca de branch foi feito. A branch de sessão é o único destino permitido para este trabalho, mas não foi publicada/commitada. Ahead/behind vêm do compare GitHub, sem fetch ou alteração de refs de trabalho. PRs abertos 0; cinco comparações divergentes e PRs associados explicados em §1.1. O estado remoto pode mudar após a data desta auditoria.

| Branch remota (exceto main) | SHA na consulta | Grafo vs main | Ahead | Behind | Observação |
|---|---|---|---|---|---|
| `arena/01a0693c-brobond-erp` | `80990aa20abf6275335ff1c117619a4e97305a4f` | behind | 0 | 206 | sem commit exclusivo; não incorporada |
| `arena/01a0699b-brobond-erp` | `45484e89230bc6d591cf70d5734b7103673dd053` | behind | 0 | 204 | sem commit exclusivo; não incorporada |
| `arena/01a06ea7-brobond-erp` | `b1d605d70cca422e4ff003e418ec98339b345dba` | behind | 0 | 188 | sem commit exclusivo; não incorporada |
| `arena/01a071bf-brobond-erp` | `43f4f4f85a3e258dba73854a2bfca67cc2307980` | behind | 0 | 186 | sem commit exclusivo; não incorporada |
| `arena/01a07306-brobond-erp` | `dc9d2beb50493f64e46b915d05895c6ef7aee941` | behind | 0 | 176 | sem commit exclusivo; não incorporada |
| `arena/01a0809c-brobond-erp` | `ee3965c88349f6b5dccaf7ca72ac26d58471ac7d` | behind | 0 | 174 | sem commit exclusivo; não incorporada |
| `arena/01a080d0-brobond-erp` | `9db751dbf4a2c72fc442e213f6a1e08b433ab117` | behind | 0 | 172 | sem commit exclusivo; não incorporada |
| `arena/01a0824d-brobond-erp` | `671a8ff047f8a1e257285307de370e8cfcf4b94e` | behind | 0 | 166 | sem commit exclusivo; não incorporada |
| `arena/01a0830e-brobond-erp` | `143366fb47d681e1941c0ec84e36131108e009b5` | behind | 0 | 159 | sem commit exclusivo; não incorporada |
| `arena/01a08868-brobond-erp` | `694d5c7e0933642ba752d99c7b5f6fd0217c4d39` | behind | 0 | 128 | sem commit exclusivo; não incorporada |
| `arena/01a08bbf-brobond-erp` | `2998c9dea481c7093f02c732ce9ea215fd07eb44` | behind | 0 | 124 | sem commit exclusivo; não incorporada |
| `arena/01a0a05b-brobond-erp` | `4510ed9908c60c1d1cbfd173bb9a1fe1c6f20fbd` | behind | 0 | 115 | sem commit exclusivo; não incorporada |
| `arena/01a10ce3-brobond-erp` | `3b54b91f424963391ffc198c52148b74e5b54974` | behind | 0 | 113 | sem commit exclusivo; não incorporada |
| `arena/01a10d16-brobond-erp` | `ac41df0b60910a9f6aee91a2274496e8f4185600` | behind | 0 | 112 | sem commit exclusivo; não incorporada |
| `arena/01a10d3e-brobond-erp` | `ce768e58436aa9542adcc9e6cb93bf04c6ebf982` | behind | 0 | 111 | sem commit exclusivo; não incorporada |
| `arena/0430101b-brobond-erp` | `b35858e858fef61696dc2525a8257496358a5d14` | diverged | 1 | 107 | divergente: ver §1.1; não incorporada |
| `arena/07796e62-brobond-erp` | `0be3596266bdb79668436d3319f5cb1b886aa429` | behind | 0 | 98 | sem commit exclusivo; não incorporada |
| `arena/28bb2548-brobond-erp` | `8bb8220ac22cfb917a05d8eb00c319d44b9bc98f` | behind | 0 | 105 | sem commit exclusivo; não incorporada |
| `arena/2cbe7b3b-brobond-erp` | `e730abfc48d95cd218de021bbab3f90fd8b06fa5` | behind | 0 | 92 | sem commit exclusivo; não incorporada |
| `arena/3fa84eab-brobond-erp` | `e4419047c8881517483c4da84b5136f3c99071a6` | behind | 0 | 88 | sem commit exclusivo; não incorporada |
| `arena/4cb6e53b-brobond-erp` | `c22191beb1ef6044f0df5a680414311ddadfc2af` | behind | 0 | 67 | sem commit exclusivo; não incorporada |
| `arena/54c4809e-brobond-erp` | `edf415a2ac97c8042a26bfe501dcf7d73876b545` | behind | 0 | 110 | sem commit exclusivo; não incorporada |
| `arena/55029ae7-brobond-erp` | `dfcfdea3c4dccbcd22a4a40b7afe9b3944f084a9` | diverged | 1 | 110 | divergente: ver §1.1; não incorporada |
| `arena/554c3bc6-brobond-erp` | `c345567886a88e148676513e5691b30b7ef342b3` | behind | 0 | 101 | sem commit exclusivo; não incorporada |
| `arena/5a2cf2f1-brobond-erp` | `d07936a63081b08a2170aaa4b5f32d9fcd57c875` | behind | 0 | 102 | sem commit exclusivo; não incorporada |
| `arena/79f1a8fc-brobond-erp` | `17ce2330107e8fbe88bd4941ef66e2b797c09e5e` | behind | 0 | 82 | sem commit exclusivo; não incorporada |
| `arena/7c5077d6-brobond-erp` | `bfd51591789c2e2451075129dcf6f88cbee9735e` | behind | 0 | 63 | sem commit exclusivo; não incorporada |
| `arena/8e2d8964-brobond-erp` | `97a262a25224c05a6701fcb4c72ce7bd7cd4ead1` | diverged | 3 | 110 | divergente: ver §1.1; não incorporada |
| `arena/96eee2b7-brobond-erp` | `edf415a2ac97c8042a26bfe501dcf7d73876b545` | behind | 0 | 110 | sem commit exclusivo; não incorporada |
| `arena/9e8f7d7c-brobond-erp` | `75ef1d9adfb7ec8173e339b33bf7e6496560a88c` | behind | 0 | 85 | sem commit exclusivo; não incorporada |
| `arena/a13793a8-brobond-erp` | `0b38968ba55502c7f0af64ebaf9d9a0706419224` | diverged | 1 | 62 | divergente: ver §1.1; não incorporada |
| `arena/a239802b-brobond-erp` | `d1dc0224f52064e12acdfe2aedb96f910b5cef0e` | behind | 0 | 103 | sem commit exclusivo; não incorporada |
| `arena/a99c71cd-brobond-erp` | `977b3aec82ebe21e2c14818d9f9e8b9662576074` | behind | 0 | 88 | sem commit exclusivo; não incorporada |
| `arena/c0955593-brobond-erp` | `fe344b383a42a557e4028666a80e854273894528` | behind | 0 | 100 | sem commit exclusivo; não incorporada |
| `arena/c9bc96ca-brobond-erp` | `019dfddd21f59a2843d6ffd80a2e0081bb5a7e18` | behind | 0 | 104 | sem commit exclusivo; não incorporada |
| `arena/cc72b76a-brobond-erp` | `3015b24a00de40f747f5f4d2f97089557395dd5f` | behind | 0 | 107 | sem commit exclusivo; não incorporada |
| `arena/e47d8d0c-brobond-erp` | `d1dc0224f52064e12acdfe2aedb96f910b5cef0e` | behind | 0 | 103 | sem commit exclusivo; não incorporada |
| `arena/e76f13f9-brobond-erp` | `944e0731f642995a284a816d16d5420cc9f908f9` | behind | 0 | 108 | sem commit exclusivo; não incorporada |
| `arena/ede50548-brobond-erp` | `e8522f517ddbf17b9a0c3a48bda0e788f780b47b` | diverged | 1 | 91 | divergente: ver §1.1; não incorporada |

## Anexo E — Modelos Prisma: superfície técnica além do menu

Foram encontrados **11 models** em `prisma/schema.prisma`. Contagem independente de módulos, rotas, recursos e tabelas SQL: há sobreposição de tabelas com contratos de resources/store e modelos técnicos/analíticos adicionais. Nenhum model foi somado aos 88 Resources apenas por possuir classe Prisma. As tabelas técnicas presentes no SQL/migrations e nos models abaixo — conector/credencial/state/webhook/sincronização, `sales/sale_items`/BI e empresas/tenants — são infraestrutura/contrato dos espaços e leitura; **não provaram inbox Commerce, Creators ou pipeline packages em produção**.

O grafo de relações tipadas do schema não é a árvore de produto. Recursos SQL de BOM/OP/caixa/fiscal/financeiro/recebimento podem usar outro nome de tabela/representação que o model Prisma; contratos/fluxos reais no HEAD estão em resources/store/handlers. `tenantId` UUID do domínio de packages não é automaticamente o `empresa_id` inteiro da operação; integração precisa de mapeamento e prova de uso, não de nova entrada de menu.

| Model Prisma | Tabela mapeada | Resource correspondente / fronteira | Relações tipadas | Fonte |
|---|---|---|---|---|
| `Usuario` | `usuarios` | usuarios | connectors → Connector; connectorEvents → ConnectorEvent; connectorOAuthStates → ConnectorOAuthState; sales → Sale | schema.prisma:90 |
| `Produto` | `produtos` | produtos | saleItems → SaleItem; produtoAbcs → ProdutoAbc | schema.prisma:169 |
| `Tamanho` | `tamanhos` | tamanhos | saleItems → SaleItem | schema.prisma:206 |
| `Connector` | `connectors` | fora do registro Resource; técnico/analítico | usuario → Usuario; events → ConnectorEvent | schema.prisma:315 |
| `ConnectorEvent` | `connector_events` | fora do registro Resource; técnico/analítico | usuario → Usuario; connector → Connector | schema.prisma:375 |
| `ConnectorOAuthState` | `connector_oauth_states` | fora do registro Resource; técnico/analítico | usuario → Usuario | schema.prisma:400 |
| `Sale` | `sales` | fora do registro Resource; técnico/analítico | empresa → Empresa; usuario → Usuario; items → SaleItem | schema.prisma:435 |
| `SaleItem` | `sale_items` | fora do registro Resource; técnico/analítico | sale → Sale; product → Produto; size → Tamanho | schema.prisma:515 |
| `Empresa` | `empresas` | empresas | sales → Sale; produtoAbcs → ProdutoAbc | schema.prisma:560 |
| `ImpostosNcm` | `impostos_ncm` | impostos_ncm | — | schema.prisma:581 |
| `ProdutoAbc` | `produto_abc` | fora do registro Resource; técnico/analítico | empresa → Empresa; produto → Produto | schema.prisma:598 |

### Registro final de escopo

**Conferência documental final: PASS.** Reconciliados os 70 IDs/paths e suas casas, os 70 módulos em cada árvore, as 37 páginas, 80 recursos centrais + 8 locais, referências declaradas, 298 pares verbo/template únicos com linhas de fonte, 39 branches não-main e 29 achados com totais P0–P3. Sem placeholders, sem whitespace indevido, sem diferença em arquivos de implementação/índice. `git diff --check` exit 0; `git diff --no-index --check /dev/null docs/RELATORIO-ERP-UX-02.md` sem diagnóstico de whitespace (exit 1 pela diferença do documento novo, não falha de formato). Essa conferência é documental, **não** execução das suites ou do gate `audit:menu`.

**Snapshot de fechamento:** main remoto continua no SHA auditado; PRs abertos 0; branch/HEAD/merge-base inalterados; apenas o relatório novo na working tree. Nenhum commit, stage, push, PR ou merge realizado.

Documento preparado sobre HEAD/base `26d39fbb0193f61d60033e7033fb7f72bd72fe85`, branch `arena/336daf2e-brobond-erp`. **Uma entrega documental, nenhuma alteração de implementação.** Checagem de whitespace/escopo final registrada na conclusão e na resposta do ciclo. Todos os testes/gates não executados e o bloqueio de audit:menu mantêm o estado descrito em §2.2; não há selo de homologação de produção.
