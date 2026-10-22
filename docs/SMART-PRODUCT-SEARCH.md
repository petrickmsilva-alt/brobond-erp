# Smart Product Search

## Objetivo e estado

Capacidade central de localização de produtos do ERP-Commerce, usada pelos seletores operacionais sem catálogo completo no navegador e sem implementações de ranking independentes por módulo.

A implementação cobre nome, SKU e código de barras (inclusive partes), descrição, cor, categoria, marca e os demais atributos reais já existentes no cadastro. O PDV e os demais fluxos continuam usando suas regras canônicas de preço, estoque e venda.

Não houve alteração de DDL, migration, produção ou contrato público da loja.

## Arquitetura

```text
ProductSelector / Grade de estoque
              |
              v
client/src/lib/productSearch.ts
              |
              v
GET /api/produtos/busca (ou /api/produtos/search)
              |
      autenticação + checkAccess
      empresa ativa da sessão
              |
              v
server/src/productSearch.ts :: searchProducts
              |
       +------+-------+
       |              |
  PostgreSQL       MemStore
  filtro/ranking   mesmo contrato para
  estoque/página   demonstração e testes
       |              |
       +------+-------+
              v
{ rows, total, page, pageSize, hasMore }
```

No PostgreSQL, filtro, ranking, agregação de saldo, ordenação e paginação acontecem no banco. A página retorna os pais encontrados; uma consulta limitada aos IDs da página busca as variações e outra busca os saldos correspondentes. A consulta de total separada só é necessária quando a página solicitada está vazia.

O MemStore é somente o adaptador do modo demonstração/testes. Ele aplica o mesmo contrato e informa erro em vez de retornar silenciosamente um catálogo parcial se os limites seguros da memória forem excedidos.

## API e limites

| Parâmetro | Regra |
| --- | --- |
| `q` | Texto com até 120 caracteres; até 12 termos distintos. Todos os termos precisam ocorrer no documento do produto/variação. |
| `id` | Recupera um único produto do tenant, inclusive para edição. Não troca uma variação pelo pai. |
| `page` | Começa em 1; máximo validado de 10.000. |
| `pageSize` | Padrão 20; mínimo 1; máximo 50. `limit` é aceito como alias na rota. |
| `onlyInStock` | Considera somente famílias com saldo positivo no contexto informado. Alias de rota: `somente_com_estoque`. |
| `inStockFirst` | Depois do rank de identificador/texto, prioriza famílias com saldo. |
| `includeInactive` | Permite inativos para edição/filtros administrativos; o padrão os exclui. |
| `local_id` / `localId` | Limita o contexto de saldo ao local informado. |

Booleanos inválidos, IDs, páginas e limites fora do contrato são recusados com HTTP 400. A rota exige usuário autenticado e permissão de leitura de produtos.

## Campos pesquisados

O documento pesquisável combina dados da variação e do pai, sem criar campos ou relações novas:

- SKU, nome, código de barras, descrição e descrição curta;
- cor, categoria, marca, coleção, grade e fornecedor;
- tags, composição, chave da variação e código do fornecedor;
- localização, unidade, formato, tipo, condição e produção;
- NCM, CEST, GTIN tributário e CFOP de saída.

Categorias, cores e grades seguem o modelo de catálogo compartilhado já existente. Produtos, coleções, fornecedores, saldos e demais dados empresariais permanecem recortados pelo tenant.

## Ranking determinístico

Os pesos são compartilhados entre PostgreSQL e memória:

1. código de barras exato;
2. SKU exato;
3. nome exato;
4. prefixo de SKU;
5. prefixo de nome;
6. ocorrência no nome;
7. ocorrência parcial em SKU/barcode;
8. demais atributos e correspondências por múltiplos termos.

O desempate usa disponibilidade apenas quando `inStockFirst=true`, depois nome e ID. Portanto, a mesma página e os mesmos dados produzem uma ordem determinística. Uma busca vazia não recebe prioridade artificial de prefixo.

## Variações, tamanhos e estoque

- Uma correspondência em qualquer variação apresenta a família e suas variações ativas, cada uma com SKU, barcode, preço, cor e tamanho/saldo.
- O contrato canônico do ERP mantém **SKU/preço na variação**, mas **venda e estoque no produto pai + tamanho + local**.
- O saldo de uma variação é a projeção da célula correspondente do pai. Os saldos de pai e filhos nunca são somados como se fossem estoques diferentes.
- Uma variação sem célula de estoque ainda pode ser apresentada com seu tamanho real e saldo zero.
- Em operações que exigem tamanho, o pai funciona como agrupador e a pessoa escolhe a variação; a UI não apenas bloqueia o produto.
- Em `/vendas`, a seleção de variação envia `produto_id` do pai, `tamanho_id` e preço da variação. O seletor continua exibindo a variação mesmo quando o formulário persiste o pai.
- No PDV, a busca global só localiza. `/api/pdv/buscar` continua sendo a resolução final de SKU/barcode, preço vigente, produto pai, tamanho e estoque antes de adicionar à venda.

## Experiência de uso

`ProductSelector` fornece:

- debounce padrão de 200 ms e 20 pais por página;
- nenhuma precarga do catálogo;
- proteção contra respostas de busca ou de ID fora de ordem;
- setas, Enter, Escape e Tab; `ArrowDown` no último item ou “Mostrar mais” para paginar;
- foco devolvido à busca depois da seleção;
- atributos ARIA de combobox/listbox e estado vazio/erro/carregamento;
- preservação da primeira tecla ao editar uma seleção em formulário controlado.

O caminho de leitor/SKU/barcode do PDV continua disponível com Enter sem abrir a lista.

## Mapeamento dos módulos

| Prioridade | Módulo | Uso |
| --- | --- | --- |
| P0 | `/pdv` | Busca global com saldo e variações; resolução final canônica em `/pdv/buscar`. |
| P0 | `/vendas` | Novos itens usam a busca central, sem precarregar 200 produtos; payload mantém pai + tamanho + preço. |
| P1 | Estoque / grade | `q` vai ao backend com debounce e contexto de local; a grade reutiliza `searchProducts`. |
| P1 | Estoque / inventário | “Achado” de contagem usa o seletor e preenche pai/tamanho. |
| P1 | Produção | Ordem de fabricação e ficha de custo usam o seletor central. |
| P1 | Compras / Suprimentos | Referências genéricas de produto em formulários e filtros usam o seletor. Recursos cujo item é **insumo** continuam usando o seletor de insumos. |
| P1/P2 | Commerce | Referências administrativas de produto cobertas por `RecordForm`/`ModulePage`; a vitrine pública não foi alterada. |
| P2 | Fiscal e demais módulos | Todo campo `ref` de produto em `RecordForm` e filtros equivalentes em `ModulePage` usa a mesma capacidade. |

A Sugestão de Compra não teve sua filtragem alterada: isso poderia mudar seleções e quantidades já em revisão. Não se criou uma segunda busca para esse fluxo.

## Banco e índices

Foram revisados `db/schema.sql`, `db/bootstrap.sql`, Prisma e migrations até `0035`. O modelo já possui índices de tenant, identificadores por empresa, relacionamentos de produto/categoria/cor/coleção/fornecedor, produto pai e células de estoque por produto/tamanho/local.

- Nenhum índice ou migration foi criado.
- Nenhuma migration histórica foi editada.
- A implementação não depende de `pg_trgm`, que não está instalado pelo DDL atual.
- Todos os valores da consulta usam parâmetros do driver; nenhum input é interpolado em SQL.
- Buscas por substring em documentos com muitos atributos podem exigir varredura do recorte do tenant. Antes de propor índices funcionais/trigram, é necessário medir com `EXPLAIN ANALYZE` e volume/distribuição representativos. Criar um índice sem essa medição seria prematuro.

## Segurança e isolamento

- O tenant vem do ator/empresa ativa no backend; parâmetros como `empresa_id` não ampliam o escopo.
- Pai, variações e saldos são filtrados pela mesma empresa.
- Busca por ID de outro tenant retorna vazio; spoofing na query não altera o resultado.
- Mesmo quem possui visão consolidada gerencial seleciona produto somente na empresa ativa.
- Inclusão de inativos não remove o recorte de tenant nem a verificação de leitura.

## Verificação executada

Resultados desta implementação no ambiente de desenvolvimento:

- `npm run typecheck`: domain, server e client aprovados.
- `npm run build`: build Vite/PWA de produção aprovado.
- `npm test`: backend com **898 testes — 832 aprovados, 66 ignorados e 0 falhas**; frontend com **31 arquivos e 334 testes aprovados**.
- Gate oficial PostgreSQL em banco vazio, servidor **16.14**: **238 testes reais aprovados, 0 falhas, 0 skips/todo**. Inclui a suíte de busca com atributos, múltiplos termos, ranking, variantes/saldos e tenants A/B.
- `npm run lint`: **0 erros e 407 avisos** no conjunto atual; o novo seletor está sem avisos.
- `git diff --check`: sem erros de whitespace.

Os 66 skips da suíte backend sem `DATABASE_URL` pertencem ao conjunto já existente de testes PostgreSQL; eles foram efetivamente executados no gate PostgreSQL separado, sem skips.

## Arquivos da implementação

### Backend e testes

- `server/src/productSearch.ts` — contrato, validação, ranking, adaptadores, estoque, variantes e handler HTTP.
- `server/src/index.ts` — rotas `/api/produtos/busca` e `/api/produtos/search`.
- `server/src/openapi.ts` — documentação do endpoint.
- `server/src/pdv.ts` — tamanho canônico da variação e tenant explícito na consulta de saldo.
- `server/src/estoque.ts` — integração da grade com a busca central.
- `server/test/product-search.test.ts` — contrato, ranking, atributos, tenant, estoque, variantes, paginação, API e grade.
- `server/test/pg/product-search-postgresql.test.ts` — prova da implementação SQL em PostgreSQL real.
- `server/test/pdv.test.ts` — regressão da resolução canônica de variações e preço/estoque/venda.

### Frontend e testes

- `client/src/lib/productSearch.ts` — cliente tipado único.
- `client/src/components/ProductSelector.tsx` — seletor compartilhado.
- `client/src/components/RecordForm.tsx` e `client/src/pages/ModulePage.tsx` — refs e filtros genéricos.
- `client/src/pages/PdvPage.tsx`, `OrderPage.tsx`, `EstoqueGradePage.tsx`, `InventarioModulePage.tsx`, `OrdemDetail.tsx` e `CustoPage.tsx` — fluxos operacionais.
- `client/src/components/ProductSelector.test.tsx`, `client/src/pages/PdvPage.test.tsx` e `client/src/pages/OrderPage.test.tsx` — debounce, atributos, saldos, teclado, foco, paginação, corridas de resposta, formulário controlado e integração de venda/PDV.

## Pendências e limites deliberados

1. Medir plano e latência com dados representativos antes de qualquer índice de substring; não há migration nesta entrega.
2. Não se alterou a Sugestão de Compra nem a pesquisa pública da vitrine, pois possuem estados/contratos próprios fora do seletor administrativo.
3. O banco e os clientes PostgreSQL usados nos testes foram temporários e ficaram fora do Git.
4. Não foi feito deploy nem merge em `main`.
