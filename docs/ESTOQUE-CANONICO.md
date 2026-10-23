# Estoque canônico — identidade, físico × disponível e venda

## Motivo deste documento

O ERP já respondeu "quanto tem?" de três jeitos diferentes: a Grade somava todas
as linhas de `estoques` de um produto+tamanho em todos os locais, o PDV montava
sua própria soma e o faturamento lia uma única célula via `find` em JS. O
resultado clássico foi a divergência **"Grade mostra M = 10, PDV mostra
disponível = 1"**: não era dado errado, eram três regras distintas.

Hoje existe **uma única implementação**, em `server/src/estoqueCanonico.ts`.
Grade/Estoque Físico, PDV, Vendas, busca de produtos, faturamento e estorno do
cancelamento leem o saldo por lá. Nenhuma tela e nenhum outro módulo somam
`estoques` por conta própria.

## 1. Identidade canônica da célula

```
empresa_id + produto_id + tamanho_id + local_id
```

- `produto_id` é sempre o **produto dono do saldo**. Neste modelo a venda e o
  estoque pertencem ao produto **pai**; a variação empresta SKU, cor e preço.
  Saldo de pai e saldo de variação **nunca** são somados: a variação mostra a
  mesma célula do pai (`productSearch.mapSizes`).
- `tamanho_id` é a coluna da grade (`NULL` = "sem tamanho"). Vender 1 peça do M
  mexe **apenas** na célula do M.
- `local_id` é o local de estoque dentro da empresa. A coluna texto `local`
  existe só para compatibilidade histórica; quem manda é o ID. Linhas antigas
  sem `local_id` são vinculadas ao local **pelo nome** quando ele é único na
  empresa — a leitura não escreve nada no banco.
- Duas linhas que resolvem para a mesma identidade são dado corrompido: a
  leitura **falha fechada (409)** em vez de somar em dobro ou escolher uma.

## 2. Estoque físico × estoque disponível para venda

São duas perguntas diferentes; ambas são explícitas na API e na tela:

| Pergunta | O que é | Onde aparece |
| --- | --- | --- |
| **Estoque físico** | soma de todas as células do par (produto, tamanho) em **todos** os locais da empresa | Grade/Estoque Físico ("Todos os locais (soma)"), `estoque_fisico*`, coluna "Total" do produto |
| **Estoque disponível (vendável)** | o que **uma linha de venda** consegue baixar: a célula do local de saída e, se ela não cobre a quantidade, a do Local padrão | PDV, Vendas (`Estoque disponível em <local>`), `disponivel_no_tamanho`, `/api/estoques/disponivel` |

O faturamento debita **um local por item** (`faturarVenda` em `itens.ts`):
local de saída da venda → Local padrão. Por isso o disponível é o **maior**
entre essas duas células e nunca a soma dos locais. Não existe tabela de
reservas: se um dia existir, ela entra uma vez em `saldoVendavel` e todas as
telas passam a vê-la.

Consequência aceita por desenho: 1 peça na loja + 9 no depósito é **físico 10**
e **disponível 1** quando a venda sai da loja. As duas telas mostram os dois
números com rótulo — nunca um número sem escopo.

## 3. API

```
GET /api/estoques/grade?...&local_id=
  → matriz produto × tamanho + `escopo_saldo`
    escopo_saldo.tipo = "todos" | "local"
    escopo_saldo.semantica = "estoque_fisico_total_da_empresa" |
                             "estoque_fisico_do_local"

GET /api/estoques/disponivel?produto_id=&tamanho_id=&local_id=
  → { quantidade,           /* vendável, célula do local de saída */
      local_id, local,       /* de onde esse número sai */
      por_local,             /* detalhe auditável */
      estoque_fisico,        /* todos os locais */
      outros_locais,         /* físico que a venda NÃO usa */
      semantica: 'estoque_vendavel_no_local_de_saida' }
```

Ambas exigem RBAC `estoques:read`, são recortadas pela empresa ativa e validam
`local_id` no tenant (local de outra empresa → 404).

## 4. PDV e busca

```
GET /api/pdv/buscar?codigo=&tamanho_id=&local_id=
  → disponivel_no_tamanho   vendável no local de saída (o que a venda baixa)
    disponivel_no_local    estoque só naquele local (sem fallback)
    estoque_fisico_no_tamanho  todos os locais
    estoque_disponivel     físico do produto inteiro (todos os tamanhos)
```

O local de saída da busca é, nesta ordem: `local_id` pedido → local do caixa
aberto **quando há exatamente um** → Local padrão. Nunca um caixa escolhido ao
acaso entre dois abertos.

`GET /api/produtos/busca` devolve `tamanhos[]` somados **por tamanho dentro do
mesmo produto** (variação = célula do pai), com `localId` opcional para limitar
o saldo a um local.

## 5. Venda e cancelamento

1. `venderPdv` resolve o local de saída **antes** de precificar e passa esse
   local para `resolverProduto`: a disponibilidade mostrada e a baixa usam a
   mesma célula.
2. `faturarVenda` debita com `tryAdjustStock(-qtd)` exatamente
   `empresa_id + produto_id + tamanho_id + local_id` e grava
   `movimentacoes.tipo = 'saida'`.
3. Cancelar (faturada → cancelada) devolve `saida − devolvido` na **mesma
   célula** e grava `movimentacoes.tipo = 'entrada'` (estorno).
4. Quantidade inválida ou local sem saldo → 409 **antes** de qualquer baixa; o
   saldo nunca fica negativo (garantido por CHECK + `tryAdjustStock`).

## 6. Evidência automatizada

`server/test/pg/estoque-canonico-pdv-grade.test.ts` (PostgreSQL real) cobre:
paridade Grade × PDV, venda de 1 unidade, cancelamento com estorno, múltiplas
linhas por local sem duplicação, pai × variação, isolamento entre empresas,
tamanhos independentes e duas vendas concorrentes da última unidade.
