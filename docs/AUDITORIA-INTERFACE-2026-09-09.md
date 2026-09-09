# BROBOND ERP — Auditoria de Interface (UI/UX) e Plano de Evolução para "Autonível" — 2026-09-09

**Papel:** auditor-chefe. **Escopo:** exclusivamente a camada de interface — `client/src` (52 arquivos,
~15.700 linhas), design system (`tailwind.config.js`, `src/index.css`, `components/ui.tsx`), navegação
(`Sidebar`, `Layout`, `modules.ts`), formulários (`RecordForm`, `ModulePage`), páginas especializadas
(Dashboard, Financeiro, Estoque em Grade, Medidas, Usuários, Login/MFA, Catálogo público) e ativos
visuais (logo, PWA, manifest).

**Método:** leitura linha a linha de todos os componentes e páginas, build de produção real
(`vite build`), execução da API em modo demonstração com sondas HTTP para validar o que a tela
consome, e checagem cruzada com as 5 auditorias anteriores (`docs/AUDITORIA-*.md`) para não repetir
achados já corrigidos. **Não houve captura de screenshot** nesta rodada — o sandbox não teve acesso
de rede para baixar o binário do Chromium (`playwright install` falhou por bloqueio de DNS/TLS aos
CDNs de download). Todo achado abaixo é rastreável a um trecho de código citado, não a impressão
visual.

**Resultado da leitura de código:** `npm run build` do client ✅ (692 KB / 184 KB gzip num único
chunk — ver achado I-9). Nenhum teste automatizado de UI existe (`client/package.json` não tem
`vitest`/`jest`/Testing Library) — ver achado I-10.

---

## Resumo executivo

O BROBOND ERP já tem uma **identidade visual consistente e uma arquitetura de UI raramente vista em
sistemas internos**: paleta única controlada por CSS variables (`navy`/`brand`/`charcoal`), um design
system pequeno mas coerente (`btn-*`, `.card`, `.input`, `.badge`, `Modal`, `Toast`, `EmptyState`),
responsividade real (tabela → cards no mobile, FAB de criação, sidebar retrátil), MFA com QR code,
skip de estados de carregamento/erro/vazio em praticamente toda tela, e uma página de Ajuda dedicada.
Isso já coloca o produto **acima da média de ERPs internos de pequeno porte**.

Para chegar a "autonível" (o padrão que um usuário reconhece de SaaS de referência como Linear,
Notion, Vercel, ou ERPs como Omie/Bling) faltam, nesta ordem de impacto:

| Prioridade | Achado | Por quê importa |
|---|---|---|
| **P1** | Sem modo escuro, sem densidade de tabela ajustável, bundle JS único de 692 KB | Percepção de performance e de "produto SaaS moderno" |
| **P1** | Tabelas genéricas (`ModulePage`) não têm colunas fixas/reordenáveis nem larguras controladas — em recursos com muitos campos (Produtos, Usuários) a tabela vira parede de texto | Legibilidade em telas de 13"-15", o caso mais comum de uso corporativo |
| **P1** | Command palette / busca global inexistente — navegar entre os 30 módulos depende só da sidebar | Velocidade operacional, o que mais diferencia "profissional" de "básico" |
| **P2** | Inconsistências pontuais de cor fora da paleta (`blue-600`, `green-500`, `gray-*` soltos em 3 arquivos) | Quebra a identidade de marca que o resto do sistema respeita à risca |
| **P2** | Sem testes de interface (Vitest/RTL/Playwright) e sem Storybook/catálogo de componentes | Risco de regressão visual silenciosa a cada mudança |
| **P2** | Acessibilidade: contraste não auditado, sem "pular para o conteúdo", poucos `aria-live`, `window.confirm`/`window.prompt` nativos em 3 fluxos | Barreira para usuários com necessidades de acessibilidade e mancha visual (diálogo do navegador quebra a identidade) |
| **P3** | Onboarding/vazio "dia 1" pouco guiado além do Dashboard; sem tour do produto | Primeira impressão de quem abre o sistema pela primeira vez |
| **P3** | Meta tags de compartilhamento (Open Graph) ausentes; screenshots do `manifest.json` vazios | PWA/instalação e compartilhamento de link parecem incompletos |

Nenhum achado é bloqueante — o sistema funciona e é usável hoje. São refinamentos de **acabamento**
que separam "bem feito" de "nível de produto comercial".

---

## 1. O que já está no nível esperado (não mexer)

Para não perder nesses pontos ao evoluir:

- **Design tokens centralizados**: toda cor de marca vive em `--navy-*`/`--brand-*` (`index.css`) e é
  consumida via Tailwind (`tailwind.config.js`). Trocar a marca é editar 20 linhas em um arquivo.
- **Componentes base reutilizados de verdade**: `Modal`, `ConfirmDialog`, `Badge`, `Alert`,
  `EmptyState`, `Spinner`, `PageHeader`, `Toast` — usados por praticamente todas as páginas
  (`components/ui.tsx`), sem duplicação de estilo de modal/confirmação.
  entre módulos.
- **Responsividade real, não cosmética**: `ModulePage` renderiza uma tabela `hidden md:block` e uma
  lista de cards `md:hidden` com o mesmo conjunto de ações (editar/excluir/estornar) — não é só
  "encolher a fonte", é um layout mobile de verdade com FAB de criação (linha ~750 de
  `ModulePage.tsx`).
- **Formulário 100% orientado a metadados** (`RecordForm.tsx` + `resources.ts` no servidor): todo
  campo (texto, moeda, percentual, cor, referência, multirreferência, senha com "mostrar/ocultar",
  telefone/documento com máscara) tem um único ponto de renderização — qualquer novo campo em
  qualquer dos 30 recursos herda automaticamente o visual e a validação corretos.
- **Login/MFA com produção real de QR code**, códigos de recuperação de exibição única, e tabs
  visuais (app autenticador × código de recuperação) — nível de segurança/UX de produto SaaS pago.
- **Feedback consistente de estado**: toasts com auto-dismiss diferenciado por severidade (erro fica
  6 s, sucesso/info 3,5 s), `EmptyState` com ação contextual ("Cadastre primeiro em..."), paginação
  com contagem "1–25 de 340".
- **Página de Ajuda dedicada** (`AjudaPage.tsx`) e descrição de cada módulo já embutida em
  `modules.ts` (usada tanto na sidebar quanto no cabeçalho da página) — reduz a curva de aprendizado
  sem precisar de manual externo.

---

## 2. Achados detalhados e evoluções recomendadas

### 2.1 [P1] Sem modo escuro

`grep -rn "dark:" client/src` não retorna nenhuma ocorrência e `tailwind.config.js` não declara
`darkMode`. Hoje é 100% claro. Para um sistema usado o dia inteiro (operação de estoque, PDV,
financeiro), a ausência de tema escuro é o item mais citado em pesquisas de satisfação de ERPs
modernos, e o custo de implementação é baixo dado que **as cores já são CSS variables** — o mesmo
padrão de `--navy-*`/`--brand-*` permite um segundo conjunto de variáveis sob `.dark` sem reescrever
componentes.

**Recomendação:** adicionar `darkMode: 'class'`, um segundo bloco de variáveis em `index.css` sob
`.dark`, um toggle em `Settings.tsx` (já existe `PreferenciasCard`, é o lugar natural) persistido em
`localStorage` (o padrão `brobond_prefs` já existe e é usado para outras preferências, ex.:
`gradeLocal` em `EstoqueGradePage.tsx`).

### 2.2 [P1] Bundle único de 692 KB (184 KB gzip) sem code-splitting

```
dist/assets/index-DrFs6cj5.js   692.60 kB │ gzip: 184.64 kB
(!) Some chunks are larger than 500 kB after minification.
```

`App.tsx` importa estaticamente **todas** as páginas (`UsuariosPage` com 2.879 linhas,
`ModulePage` com 1.178, `FinanceiroPage`, `CatalogoPublico` com quase 1.000 linhas) mesmo que o
usuário nunca abra Financeiro ou Usuários na sessão. Isso atrasa o primeiro carregamento —
especialmente perceptível em conexões de loja/fábrica, que costumam ser piores que as do escritório.

**Recomendação:** trocar os `import` de página em `App.tsx` por `React.lazy` + `<Suspense
fallback={<Loading />}>` (o componente `Loading` já existe no próprio arquivo). Isso sozinho deve
cortar o chunk inicial para menos de 150 KB. Prioridade alta para `UsuariosPage`,
`CatalogoPublico`/`PortalCliente` (só usados fora do login, nunca deveriam entrar no bundle do ERP
interno) e `FinanceiroPage`.

### 2.3 [P1] Tabela genérica sem controle de densidade/colunas

`ModulePage.tsx` monta a tabela a partir de `resource.fields` sem paginação de colunas, sem opção de
esconder colunas, e sem modo compacto. Em recursos com muitos campos (Produtos, Usuários — que tem
2.879 linhas de página dedicada por causa da complexidade dos dados) a tabela desktop rola
horizontalmente ou fica com muita informação por linha. O CSS já cuida do `overflow-x-auto`
(`index.css`, `.table`), mas isso é o "menos pior", não a solução.

**Recomendação:** no cabeçalho de `ModulePage`, adicionar um botão "Colunas" (dropdown de checkboxes
sobre `listFields`, persistido em `localStorage` por recurso) e um toggle "compacto/confortável" que
alterna o padding vertical de `.table tbody td` via uma classe modificadora. Não exige mudança de
schema — é puramente de apresentação sobre o array `listFields` que já existe.

### 2.4 [P1] Sem busca global / command palette

A navegação depende 100% da `Sidebar` (30 itens agrupados em 8 seções). Não há atalho de teclado
(`Cmd/Ctrl+K`) para pular direto a "Novo pedido de venda" ou buscar um produto pelo SKU sem entrar
primeiro em Produtos. Esse é o recurso que mais separa uma ferramenta "profissional-percebida" de uma
"básica" hoje em dia (é padrão em Linear, Notion, GitHub, Vercel, Slack).

**Recomendação:** um componente `CommandPalette` (modal centralizado, reaproveitando `Modal` de
`ui.tsx`) que:
1. Lista os 30 módulos de `modules.ts` (já tem `label`, `icon`, `path` prontos) navegáveis por texto;
2. Opcionalmente busca por API (`/produtos?q=...`, `/clientes?q=...`) quando o texto não bate com
   nenhum módulo — os endpoints de busca já existem, é o mesmo `q` usado em `ModulePage`;
3. Atalho global `Ctrl/Cmd+K` registrado em `Layout.tsx`.

### 2.5 [P2] Cores fora da paleta em pontos pontuais

A auditoria anterior (2026-09-04) já corrigiu um badge azul-navy sendo lido como "neutro". Nesta
auditoria, `grep` encontrou resíduos de cores Tailwind puras (`blue-600`, `green-500`) que não
existem na paleta `navy`/`brand`:

```
client/src/pages/Convite.tsx:106      text-green-500
client/src/pages/FinanceiroPage.tsx:612/622/632   text-blue-600 / bg-blue-50
client/src/pages/UsuariosPage.tsx:878/2761        bg-blue-600
```

São poucos pontos (6 ocorrências em 3 arquivos, contra um sistema de ~15.700 linhas que na imensa
maioria usa `emerald`/`red`/`navy`/`brand`/`slate` corretamente), mas são visíveis justamente em
telas de alto tráfego (Financeiro, Usuários, tela de convite aceito). Antes de uma auditoria de marca
formal, isso é o tipo de detalhe que denuncia "feito por mãos diferentes em momentos diferentes".

**Recomendação:** trocar `blue-*` por `navy-*` (mesmo papel semântico — "informativo") e `green-500`
solto por `emerald-500` (para bater com o `emerald` já usado em toda parte para "sucesso"/"positivo").
Baixo esforço, ganho de consistência imediato.

### 2.6 [P2] Sem testes de interface nem inventário de componentes

`client/package.json` não tem `vitest`, `@testing-library/react`, nem qualquer framework de teste de
UI — apenas `tsc --noEmit` (typecheck) protege o front. O backend tem 119+ testes automatizados
(`server/test`); o frontend tem zero. Isso significa que qualquer refino visual desta auditoria (ou
qualquer mudança futura) só é validado manualmente.

**Recomendação, em duas camadas:**
1. **Testes de fumaça com Vitest + Testing Library** para os componentes de `ui.tsx` (Modal abre/
   fecha, Toast expira, Badge aplica o tom certo) e para o fluxo de login — baixo custo, alto retorno.
2. **Catálogo de componentes leve** (Storybook ou uma página interna `/dev/componentes` só em modo
   desenvolvimento) documentando as variações de `Badge`, `Alert`, `btn-*`, para qualquer pessoa (ou
   agente) que for adicionar UI nova saber o que já existe em vez de reinventar uma cor.

### 2.7 [P2] Acessibilidade: diálogos nativos do navegador e poucos `aria-live`

Encontrados 5 usos de `window.confirm`/`window.prompt`, que quebram a identidade visual (o navegador
desenha um diálogo cinza padrão do sistema operacional em cima do app azul-marinho/âmbar) e não são
navegáveis do mesmo jeito por leitor de tela que o `ConfirmDialog` já existente:

```
components/CatalogoInsights.tsx:30   window.confirm('Revogar este link?...')
components/ImageField.tsx:114        window.confirm('Remover esta foto?')
pages/CatalogoPublico.tsx:509        window.prompt('Copie o link do produto:', url)
pages/MedidasPage.tsx:149/233        window.confirm(...) × 2
```

O componente `ConfirmDialog` (em `ui.tsx`) já resolve exatamente esse caso e é usado em toda a
`ModulePage` (exclusão, estorno) — só não foi propagado a esses 5 pontos, provavelmente por serem
adições de auditorias anteriores focadas em regra de negócio, não em UI.

Além disso: só 1 ocorrência de `role="alert"` em todo o client (deveria estar em toda mensagem de
erro de formulário/toast para leitores de tela anunciarem automaticamente), e não há um link "Pular
para o conteúdo" no topo do `Layout` para quem navega por teclado pular a sidebar de 30 itens.

**Recomendação:**
1. Trocar os 5 `window.confirm`/`window.prompt` por `ConfirmDialog`/um pequeno modal de "copiar link"
   (o padrão para copiar já existe em `Login.tsx`, com `navigator.clipboard.writeText` + toast de
   confirmação — é só reaproveitar);
2. Adicionar `role="alert"` (ou `aria-live="polite"`) nas mensagens de erro de campo em
   `RecordForm.tsx` (`help` quando `error` existe) e no container de toasts;
3. Adicionar link "Pular para o conteúdo" no início de `Layout.tsx`, visível só no foco por teclado
   (`sr-only focus:not-sr-only`).
4. Rodar uma auditoria de contraste (axe-core ou Lighthouse) sobre a paleta atual — os tons `brand-50`
   sobre texto `brand-700` usados em `Alert`/`Badge` (âmbar sobre âmbar) merecem checagem formal de
   WCAG AA, já que é a cor mais "clara" da paleta.

### 2.8 [P3] Onboarding e primeira experiência

O Dashboard (`Dashboard.tsx`) já é bom para quem já usa o sistema (KPIs, "precisa de atenção",
gráfico de vendas, atalhos rápidos), mas não há nada para o **primeiro acesso de uma empresa nova**
sem nenhum dado: os KPIs aparecerão zerados, o gráfico dirá "sem vendas faturadas", e não há um
checklist de "cadastre sua primeira categoria → seu primeiro produto → seu primeiro cliente". Hoje
esse papel é parcialmente coberto pela `AjudaPage`, mas ela precisa ser procurada, não aparece
proativamente.

**Recomendação:** um banner "Primeiros passos" no Dashboard, condicionado a `data.totais.produtos ===
0` (o campo já vem da API), com checklist de 3–4 itens levando direto aos módulos (mesmo padrão visual
de `QuickLink`, que já existe no arquivo).

### 2.9 [P3] PWA/compartilhamento incompletos

- `manifest.json` tem `"screenshots": []` — PWAs instaláveis com screenshots preenchidos ganham um
  cartão de instalação mais rico no Chrome/Edge/Android; hoje aparece só o ícone.
- `index.html` não tem meta tags Open Graph/Twitter Card (`og:title`, `og:image`, `og:description`).
  Isso não afeta o ERP interno em si (fica atrás de login), mas afeta diretamente o **Catálogo
  público** e o **Portal do cliente** (`/catalogo/:token`, `/portal/:token`), que são as únicas telas
  do sistema pensadas para serem compartilhadas por link (WhatsApp, e-mail) — hoje esses links não
  geram nenhuma pré-visualização (thumbnail/título) quando colados num chat.
- `vite-plugin-pwa` está instalado (`client/package.json`) mas **não está configurado** em
  `vite.config.ts` (nenhuma menção a `VitePWA(...)`) — ou seja, a dependência existe mas o app não
  registra service worker, não tem cache offline nem prompt de instalação automático.

**Recomendação:** (a) tirar 2–3 screenshots reais do Dashboard/Estoque para o manifest; (b) gerar
meta tags Open Graph dinâmicas nas páginas de catálogo/portal (o SSR não existe, mas dá para injetar
via `document.title`/meta tags client-side ou, melhor, um endpoint leve no servidor que sirva HTML
com OG tags para bots de preview, já que a página é pública); (c) decidir entre configurar de fato o
`vite-plugin-pwa` ou remover a dependência não utilizada — hoje ela é peso morto no `package.json`.

### 2.10 [P3] Consistência de ícones/idioma em áreas menores

- `PlannedModule.tsx` continua existindo — hoje nenhum módulo do `modules.ts` declara `planned`
  ativo (todos os 30 têm `resource` ou página própria), então o componente está órfão/não referenciado
  em nenhum lugar visível ao usuário atual. Correto manter o componente pronto para o próximo módulo
  que entrar em desenvolvimento, mas vale um teste de typecheck/lint garantindo que não fique código
  morto sem uso real.
- `ErrorBoundary.tsx` usa um SVG de alerta escrito à mão em vez de um ícone do `lucide-react` (usado
  em 100% do resto do sistema) — pequena inconsistência de biblioteca de ícones num dos poucos
  componentes que o usuário vê justamente num momento de erro, onde a confiança visual mais importa.

---

## 3. Plano de evolução sugerido (ordem de execução)

| Fase | Itens | Esforço estimado |
|---|---|---|
| **A — Acabamento imediato** | 2.5 (cores fora da paleta), 2.7.1 (trocar `window.confirm`/`prompt` por `ConfirmDialog`), 2.10.2 (ícone do ErrorBoundary) | < 1 dia |
| **B — Performance percebida** | 2.2 (code-splitting com `React.lazy`), 2.9.c (decidir sobre `vite-plugin-pwa`) | 1–2 dias |
| **C — Produtividade do usuário avançado** | 2.4 (command palette), 2.3 (colunas/densidade de tabela) | 3–4 dias |
| **D — Modo escuro e acessibilidade** | 2.1 (dark mode), 2.7.2–2.7.4 (aria-live, skip link, auditoria de contraste) | 3–4 dias |
| **E — Qualidade de longo prazo** | 2.6 (testes de UI + catálogo de componentes) | contínuo, começar com 5–10 testes de fumaça |
| **F — Primeira experiência e compartilhamento** | 2.8 (onboarding), 2.9.a/b (screenshots + Open Graph) | 1–2 dias |

Nenhuma dessas mudanças exige alterar schema de banco nem regra de negócio — são 100% de
apresentação, então podem ser feitas em paralelo ao trabalho de backend sem risco de regressão nos
fluxos que as auditorias anteriores já validaram (estoque, financeiro, produção).

---

## 4. Como validar cada item quando implementado

- **Code-splitting (2.2):** repetir `npm run build` e conferir que o aviso de chunk > 500 KB some, com
  ao menos 4–5 chunks separados (páginas pesadas isoladas do bundle inicial).
- **Cores (2.5):** `grep -rn "blue-\|green-500\|gray-" client/src` deve retornar zero fora dos tons da
  paleta.
- **Diálogos nativos (2.7.1):** `grep -rn "window.confirm\|window.prompt" client/src` deve retornar
  zero.
- **Dark mode (2.1):** alternar o toggle em Configurações e conferir visualmente as páginas com mais
  cor (Dashboard, Financeiro) sob luz baixa.
- **Command palette (2.4):** `Ctrl/Cmd+K` de qualquer tela abre o modal e navega para qualquer um dos
  30 módulos digitando parte do nome.
- **Testes de UI (2.6):** `npm --prefix client test` (a criar) rodando em CI junto ao `typecheck` e
  `lint` já existentes em `package.json` da raiz.

---

*Auditoria realizada por leitura estática de 100% dos arquivos de `client/src`, build de produção real
e sondagem HTTP da API em modo demonstração. Sem acesso de rede para renderização headless
(Playwright/Chromium) neste ambiente — recomenda-se complementar esta auditoria com uma passada
visual (screenshots reais) assim que possível para confirmar contraste, alinhamento pixel-a-pixel e
comportamento de hover/foco que a leitura de código não captura por completo.*
