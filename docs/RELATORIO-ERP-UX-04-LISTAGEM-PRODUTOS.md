# RELATÓRIO ERP-UX-04 — Listagem de Produtos (tabela profissional + modo visual)

- **Data:** 2026-10-23 (UTC)
- **Repositório:** `petrickmsilva-alt/brobond-erp`
- **Branch:** `arena/e11a072e-brobond-erp`
- **Base:** `afda40c6a6d585f1406b16a336cde2e96950585e` (`main`)
- **Natureza:** UI/UX da **listagem** de Produtos (`/produtos`). Nenhuma alteração de banco, migration, estoque, `estoqueCanonico.ts`, PDV, vendas, compras, produção, contratos de API, regras de preço, autenticação/RBAC, Smart Product Search/back-end de busca, paginação server-side ou cadastro de produtos.

---

## 1. Resumo

A listagem de `/produtos` passou a ser uma **tabela de ERP** de verdade: a foto é a primeira coluna e é **fixa** (não depende do controle de colunas nem da viewport), o cabeçalho é **sticky** dentro da área de rolagem, valores longos usam **ellipsis + tooltip**, e quando a largura não comporta todas as colunas a tabela **rola na horizontal** em vez de esconder informação.

Busca e filtros foram movidos para uma **área própria acima da tabela** (painel em linha, nunca sobreposto), com **contador de filtros ativos**, **chips removíveis** e ação “Limpar filtros”. A densidade passou a ter **três níveis** (Compacta 48 px / Normal 56 px / Confortável 64 px), e foi adicionado o modo **[TABELA] [VISUAL]** com cartões que consomem **os mesmos dados, filtros e paginação** — sem endpoint novo e sem consulta por linha.

---

## 2. Escopo e mapa de arquivos

Somente o client foi alterado (`git status --short`):

| Arquivo | Papel |
|---|---|
| `client/src/components/ListaTabela.tsx` (**novo**) | Tabela: foto fixa, header sticky, rolagem horizontal controlada, ellipsis, ordenação, ações |
| `client/src/components/ListaCards.tsx` (**novo**) | Modo visual (cartões) responsivo |
| `client/src/components/ListaControles.tsx` (**novo**) | Controles de modo de visualização, densidade e colunas |
| `client/src/components/ListaFiltros.tsx` (**novo**) | Painel de filtros (em linha) + chips dos filtros ativos |
| `client/src/components/ListaValores.tsx` (**novo**) | Renderização das células (status, cor, refs, texto truncado, estoque) e `rowLabel` |
| `client/src/lib/lista.ts` (**novo**) | Configuração de apresentação: ordem/rótulo/largura de colunas, densidade, chips, leitura de saldo |
| `client/src/lib/useLocalStorage.ts` | Nova preferência persistida (`useLocalStorageChoice`) |
| `client/src/components/ImageField.tsx` | `Thumb` reutilizado/estendido (aria-label, foco visível, placeholder) |
| `client/src/pages/ModulePage.tsx` | Composição da listagem; ações da linha em um único lugar (tabela e cartões) |

Testes: `client/src/pages/ProdutosListagem.test.tsx` (novo, 13 casos) e `client/src/lib/lista.test.ts` (novo, 16 casos).

**Não alterados:** `server/**`, `db/**`, `prisma/**`, `modules/**`, `packages/**`, `scripts/**`.

---

## 3. Requisito → implementação

| Requisito | Implementação |
|---|---|
| 2. Tabela padrão com FOTO, PRODUTO, SKU, CATEGORIA, COLEÇÃO, COR, GRADE, PREÇO, ESTOQUE, STATUS, AÇÕES | `lib/lista.ts › CONFIG_PRODUTOS.prioridade` define a ordem; `camposOrdenados` reordena só a apresentação (o `name` do campo — e portanto `sort`/API — não muda) |
| FOTO sempre visível, 56–64 px, sem distorcer, placeholder sem foto | Coluna Foto fora do conjunto “ocultável”; `Thumb` com `object-cover` e placeholder com ícone/`aria-label` |
| Valores longos: ellipsis + tooltip | `TextoTruncado` (truncate + `title`) com `max-w` por coluna |
| Não esconder colunas na viewport menor | `overflow-auto` nos dois eixos + `min-w` por coluna |
| 3. Header sticky | `.table thead th` já é `sticky top-0`; o container passou a ter altura máxima e `overflow-auto` (antes só `overflow-x-auto`) |
| 4. Foto abre Lightbox existente, navegação entre fotos, sem trocar de página | Reuso do `Lightbox` existente + `row.fotos` que já vem no payload; fallback para a miniatura quando só `foto_url` existe |
| 5. Filtros em área separada; não sobrepõem; ativos identificáveis; contador; limpar | `PainelFiltros` em linha (empurra a tabela); chips com remoção individual; badge no botão Filtros; “Limpar filtros” volta à página 1 sem recorte |
| 5. Preservar busca/filtros/paginação server-side | Nenhuma mudança no `load()`/`paramsAtuais`: `q`, `sort`, `dir`, `f.*`, `page`, `pageSize` idênticos |
| 6. Controle de colunas funciona; foto prioritária; sem sobreposição | `ColunasMenu` mantém o `useLocalStorageSet` por recurso; “Foto” aparece marcada e travada; a tabela reflui sozinha |
| 7. Densidade (3 níveis) | `DENSIDADE_INFO` (48/56/64 px) + `DensidadeMenu`; migração automática da antiga chave booleana `brobond_tabela_compacta` |
| 8. [TABELA] [VISUAL] | `ModoVisualizacaoControl` persistido em `brobond_lista_modo`; `ListaCards` recebe as MESMAS `rows` |
| 8. Layout de cartões 3–5 / 2–3 / 1–2 | `grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 2xl:grid-cols-5` |
| 9. Responsividade | Tabela com scroll horizontal; filtros em `grid` que quebra em linhas; barra de controles com `flex-wrap`; FAB de inclusão preservado |
| 10. Performance | Uma única chamada de listagem (a mesma); nenhuma chamada por linha; nenhum `pageSize` artificial |
| 11. Acessibilidade | `aria-sort`, `aria-expanded`/`aria-controls`, `aria-pressed`, `aria-label` nas ações de imagem, foco visível, status com texto + ícone (não só cor) |
| 12. Compatibilidade | Ver §5 |

---

## 4. Decisões de projeto

### 4.1 A foto é uma coluna de primeira classe

A coluna Foto não participa do controle de colunas (entra no menu marcada e `disabled`, com a etiqueta “fixa”). Assim o usuário escolhe colunas **secundárias**, mas nunca perde a identificação visual da peça — exatamente o oposto do comportamento anterior, em que a foto ficava no fim de uma tabela comprimida.

### 4.2 Filtros nunca cobrem a tabela

O painel de filtros é renderizado **no fluxo do documento**, entre a barra de busca e o card da tabela (`region` com `aria-label="Filtros da listagem"`). Não há `absolute`/popover sobre a lista. Os chips ficam numa faixa própria, logo abaixo da busca, e cada um remove **apenas** o seu recorte (faixas de preço/data contam como um único chip).

### 4.3 Densidade com três níveis, preservando a preferência antiga

`brobond_lista_densidade` = `compacta` | `normal` | `confortavel`. Na primeira visita após o deploy, `densidadeLegada()` converte a chave antiga `brobond_tabela_compacta` (`1` → compacta, `0` → normal) e a nova preferência passa a valer.

### 4.4 Modo visual sem duplicar regra

Tabela e cartões recebem o **mesmo array de linhas** e a **mesma função de ações** (`renderAcoesLinha`). Não existe fetch, endpoint, filtro ou cálculo paralelo. O cabeçalho de status, o contador de fotos e o clique na imagem usam os mesmos componentes (`ValorCampo`, `Thumb`, `Lightbox`).

### 4.5 Coluna ESTOQUE — limite explícito do contrato

O contrato atual de `GET /api/produtos` devolve o **cadastro + fotos** (`fotos`, `foto_url`), mas **não** o saldo por tamanho/local — esse dado pertence ao contrato de estoque (`/api/produtos/:id/detalhe`, `/api/estoques/grade`, `/api/estoques/disponivel`).

Preencher a coluna exigiria **uma chamada por linha** (o N+1 que a tarefa proíbe) ou **alterar o contrato/paginação** (fora do escopo). A coluna foi então implementada para ler o saldo **se e quando** ele vier no payload (`saldoDaLinha`), exibindo traço neutro com explicação no `title` quando não vier. Nenhum número é inventado e nenhuma chamada extra é feita. Um follow-up fora deste escopo seria incluir um agregado de saldo no payload da listagem (server-side), decisão do arquiteto.

---

## 5. Compatibilidade preservada

- **Smart Product Search** (OrderPage/PDV/ProductSelector): arquivos não tocados.
- **Filtros server-side, busca, ordenação, paginação e pageSize**: mesmos parâmetros e mesma lógica (`ModulePage` só mudou apresentação; `load`/`paramsAtuais` intactos).
- **Exportação CSV/XLSX**: mesmos botões e mesmo `downloadFile` com o recorte atual.
- **Seleção de colunas**: mesmo `useLocalStorageSet('brobond_colunas_ocultas_<recurso>')`.
- **Importação, cadastro/edição, `/produtos/novo`, `/produtos/:id/editar`**: inalterados.
- **Ações da linha**: convite/senha temporária (Usuários), portal do cliente, compartilhar catálogo, estornar movimentação, detalhe, editar, excluir — todas preservadas em um único ponto (`renderAcoesLinha`). A duplicação acidental do botão “Portal do cliente” que existia no JSX antigo foi removida.
- **Demais recursos** mantêm a coluna `#` (id) e o comportamento anterior; apenas produtos usam a configuração de catálogo (foto + ordem/rotulos próprios).

---

## 6. Testes e evidências

Executados no checkout desta branch, após a implementação:

| Verificação | Comando | Resultado |
|---|---|---|
| Testes do client | `npm --workspace client test` | **39 arquivos / 465 testes — 0 falhas** (base: 37/436; +13 listagem +16 helpers) |
| Testes do server | `npm --workspace server test` | **951 testes: 885 pass, 66 skip, 0 fail** |
| Typecheck (domain/server/client) | `npm run typecheck` | **OK** |
| Lint | `npm run lint` | **0 erros** (440 warnings — mesma classe de `any`/unused pré-existente no repositório) |
| Build | `npm run build` | **OK** (Vite + PWA; CSS gerado com as classes novas) |
| Smoke E2E (servidor real, modo demonstração) | `node scripts/smoke-e2e.mjs` | **126/126 verificações OK** |

### 6.1 Casos obrigatórios cobertos (`ProdutosListagem.test.tsx`)

| Caso | Teste |
|---|---|
| A. Tabela renderiza foto | `renderiza a miniatura clicável com aria-label e a coluna Foto em primeiro lugar` (56 px, `src` da miniatura, cabeçalhos na ordem) |
| B. Produto sem foto → placeholder | `produto sem foto mostra placeholder consistente` |
| C. Clique na foto abre Lightbox | `abre o Lightbox com todas as fotos, sem sair da listagem` (imagem cheia, botão “Próxima”, tabela ainda montada) |
| D. Filtros não escondem a tabela | `abrir os filtros empurra a listagem` e `aplicar um filtro mantém a tabela...` |
| E. Filtros não removem a coluna foto | Mesmo teste D + `esconder uma coluna ... NUNCA remove a Foto` |

Extras cobertos: chips e contador de filtros ativos, remoção individual de chip, “Limpar filtros” (sem `f.categoria_id` na requisição), densidade 48/56/64 px, Foto travada no menu de colunas, modo visual com os mesmos dados **sem requisição nova**, e paginação server-side funcionando no modo visual.

`client/src/lib/lista.test.ts` cobre os helpers puros (ordenação sem mutação, rótulos, larguras, chips de faixa/ref/booleano, migração de densidade, leitura de saldo sem inventar dados).

---

## 7. Pendências e follow-ups (fora do escopo desta tarefa)

1. **Saldo de estoque na listagem** (§4.5): requer decisão de contrato server-side (agregado por página), pois hoje o dado não vem no payload.
2. **Verificação visual automatizada (screenshot)**: o ambiente não tinha navegador/Playwright instalado; a validação foi feita por testes de DOM, build e smoke. Recomenda-se conferência visual no gate.
