# Universal Ingestion Engine — hierarquia produto-pai × variação em fonte única

## 1. Estrutura real analisada

O arquivo citado na solicitação (`Brobond_241_Produtos_Canonico_Comercial_Auditado.csv`)
**não está presente** no repositório, nem no ambiente de execução desta branch
(buscado em `/`, no workspace, em `data/migrations/universal-ingestion/` — diretório
ignorado por `.gitignore` para dados confidenciais — e em `/tmp`). A análise da
estrutura foi feita sobre a fonte canônica disponível no repositório
(`TABELA DE PREÇO BASE PARA ERP.xlsx`, aba `Política Comercial Completa`, 241 linhas
de dados, cabeçalho na linha 11) e sobre o dicionário semântico do motor universal:

| Papel | Colunas canônicas / aliases reconhecidos |
| --- | --- |
| Identificador da linha (SKU variante) | `sku`, `codigo_sku`, `codigo_produto`, `codigo_industria`, `codigo_item`, `referencia`, `item` |
| Produto-pai explícito | `sku_pai`, `produto_pai`, `parent_sku`, `codigo_pai`, `sku_master` |
| Referência comercial / família | `referencia_comercial`, `codigo_referencia`, `ref_comercial`, `codigo_industria`, `codigo_item`, `referencia_externa`, `familia_id`, `codigo_familia`, `chave_familia` |
| Código-base / SKU-base | `sku_base`, `codigo_base`, `base_sku`, `codigo_produto_base` |
| Nome / descrição comercial | `nome`, `produto`, `descricao`, `descricao_produto`, `artigo`, `modelo` |
| Eixos de variação | `cor` (`variante cor`), `tamanho` (`tam`, `size`) |
| Família estrutural | `categoria`, `categoria master`, `colecao`, `marca`, `descricao` |
| Códigos / EAN | `codigo_barras`, `ean`, `gtin`, `barcode`, `codigo_industria`, `codigo_categoria` |
| Preço, custo, política comercial | `custo`, `custo_aquisicao`, `custo_fabricacao`, `preco_venda`, `preco_atacado`, `preco_promocional`, `qtd_min_atacado`, `atacado_vista`, `boleto_30`, `varejo_vista`, `margem_atacado_vista`, … (condições por canal × condição de pagamento) |
| Demais campos | `politica_comercial`, `ativo`, `tipo`, `unidade`, `peso_g`, `fornecedor`, `ncm`, `cest` |

Padrões de SKU comprovados na fonte oficial: `SOR15101`…`SOR15105` (código da
indústria por tamanho), `1001P`… (controle de estoque) e `93882-40` × `93882-42`
/`94000-NUDE-GG` (roupas: `PRODUTO[-COR]-TAMANHO`). A descrição-base repete-se
entre tamanhos e cores (`CAMISETA BROBOND GOLA "O" …`), enquanto cor e tamanho
são eixos — nunca identidade de família.

Registros observados: **linha de produto-base** (sem cor/tamanho, ou com
`sku_pai` igual ao próprio SKU), **famílias com variações** (mesma descrição-base,
mesma referência/categoria/coleção/marca, várias cores e tamanhos) e **variantes
individuais** (um SKU por combinação cor × tamanho). O catálogo auditado é uma
única tabela/CSV: **não existe aba física de produtos-pai**.

Fixture de regressão: `server/test/fixtures/catalogo-canonico-comercial.csv`
reproduz esse leiaute (2 famílias: 2 cores × 3 tamanhos e 1 cor × 3 tamanhos,
1 produto independente, SKU/EAN/custo/preços/política por variante). O teste
`real audited catalog CSV is used as fixture when present` usa o CSV real
automaticamente se ele for disponibilizado em qualquer caminho suportado.

## 2. Causa raiz corrigida

`construirModeloDependencias` (em `importacaoUniversalEntidades.ts`) só resolvia a
dependência de uma aba `variacao`/`sku` por (a) aba candidata de pai com vínculo
confirmado ou (b) snapshot do ERP com `produto_pai_id` já existente. Catálogos
planos com `sku + nome + cor + tamanho` eram classificados como `variacao` e, sem
outra aba, recebiam `Não existe aba candidata de pai (sku ou produto)` →
**Variação · Pendente**, bloqueando aprovação e execução. Não havia nenhum
mecanismo no núcleo para construir a família a partir dos próprios registros.

## 3. Correção (toda no núcleo universal)

- `importacaoUniversalHierarquia.ts` (novo componente do núcleo, **não** um
  importador): `construirPlanoHierarquiaUniversal` + `planoHierarquiaDeAnalise` +
  `planoHierarquiaDeMapeamentos`. Reconhece cenários A (pai explícito), B
  (família implícita por `familia_id`, `sku_base` comprovado ou referência
  comercial compartilhada), C (padrão de SKU validado) e D (produto
  independente). Opera em uma aba, um CSV ou várias abas.
- Segurança: cor/tamanho são apenas eixos; nome normalizado sozinho não agrupa;
  prefixo genérico de SKU não agrupa (o sufixo precisa ser explicado pela cor ou
  pelo tamanho da própria linha e a descrição-base precisa ser consistente);
  evidências fortes conflitantes geram `conflito_familia` **não bloqueante**, com
  as linhas afetadas ignoradas na gravação; sem evidência suficiente o registro
  vira produto independente (`familia_sem_evidencia`), nunca variante artificial.
- `importacaoUniversalEntidades.ts`: dependência passa a ser `vinculada` com
  `resolvidaNaOrigem: true` quando o plano resolve a hierarquia na própria aba.
  Nenhuma aba de produto-pai é exigida. O resolvedor usa a classificação
  canônica da aba e exige identidade comercial/familiar (`nome`, `descricao`,
  referência, código-base, família, marca/categoria/coleção): abas de estoque,
  movimentação e listas de preço sem identidade de catálogo NÃO são promovidas a
  produtos. Os bloqueios e a resolução via ERP permanecem intactos para os demais
  cenários.
- `importacaoUniversalAnalise.ts`, `importacaoUniversalHandler.ts`: o plano é
  calculado na análise, no mapeamento confirmado e na reconciliação (com snapshot
  do ERP para `criar`/`atualizar`/`reutilizar`), e faz parte do checkpoint
  coberto pelo hash de aprovação.
- `importacaoUniversalRecon.ts`: prévia consolidada mostra família, produto-pai,
  SKU, cor, tamanho, quantidade de variantes, evidência, confiança, registros a
  criar/atualizar e conflitos/duplicidades. `conflito_familia` e
  `familia_sem_evidencia` são divergências informativas (não entram nos gates de
  bloqueio existentes).
- `importacaoUniversalExecutor.ts`: materializa 1 pai por família (sem duplicar),
  1 filho por combinação válida com `produto_pai_id`, `variacao_chave`,
  `variacao_tamanho_id` e `formato='variacao'`, preservando SKU individual, EAN,
  códigos/referências, custo, preços, condições comerciais e atributos livres.
  Idempotente por SKU; conflitos reais não abortam a transação.
- `importacaoUniversalSemantica.ts`: novos campos canônicos `sku_base`,
  `referencia_comercial`, `familia_id`, `politica_comercial` (aceitos também pelo
  contrato da API e pela interface única).
- `client/src/pages/ImportacaoUniversalPage.tsx`: seção "Hierarquia real de
  produto-pai × variações" + colunas de família/pai/evidência/confiança/ação na
  prévia consolidada. Nenhuma nova página ou fluxo.

Não foi criado importador, pipeline, tabela, modelo de produtos, sistema de SKU
paralelo, rota ou tela adicional. Nenhuma importação real do catálogo foi
executada e nenhum deploy foi feito.
