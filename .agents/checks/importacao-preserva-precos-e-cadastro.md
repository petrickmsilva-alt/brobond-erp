---
files:
  - "server/src/importacaoUniversal*.ts"
  - "server/src/cargaPoliticaComercial.ts"
---

# Importação nunca apaga preço, histórico ou cadastro já existente no ERP

A planilha é fonte de ENTRADA; o ERP governa o dado existente (AGENTS.md, "Commerce
Engine — precificação"). Todo caminho de importação — motor universal
(`importacaoUniversalExecutor.ts`, `importacaoUniversalPrecos.ts`, adaptadores) e carga da
política comercial (`cargaPoliticaComercial.ts`) — precisa respeitar, ao gravar produto,
variação ou preço:

1. **Preço por condição é VERSIONADO.** Escrita em `produto_precos_condicao` passa por
   `persistUniversalConditionPrice` (ou pelo caminho equivalente da carga): mesmo valor →
   sem nova versão; valor diferente → fecha a vigência atual (`vigencia_fim`), insere a
   nova linha e grava `produto_precos_condicao_historico`. `UPDATE ... SET preco=` na
   linha vigente, upsert `ON CONFLICT DO UPDATE` ou `DELETE` + `INSERT` apagam a trilha.
2. **Preço base só é preenchido quando está zerado.** `preco_venda`/`preco_atacado` de um
   produto existente passam por `preserveNonzeroBasePrices` antes do `update`, em
   TODO caminho (produto, variação, pai inferido, aba de preços).
3. **Faixa de quantidade igual à política oficial.** O `quantidade_minima` de cada
   condição precisa casar com `PRECOS_OFICIAIS` em `cargaPoliticaComercial.ts` (ex.:
   `cartao_parcelado` e "VRJ 2 Un" = 2). Faixa 1 onde a política exige 2 dá o preço de
   multiunidade numa venda de uma peça, porque `motorPrecos` aplica toda faixa ≤ quantidade.
4. **Atualização mescla, não substitui.** `atributos_adicionais` de produto/variação
   existente é mesclado com o armazenado (`{...existente, ...novo}` /
   `mergeExtraAttributes`); colunas marcadas "Ignorar campo" não entram nos extras.

Por que importa: reimportação é rotina; cada violação apagou preço oficial, histórico de
vigência ou atributo mantido no ERP sem nenhum erro visível (PR #169).

Incorreto:

```ts
// sobrescreve o preço vigente e perde o histórico; base sobrescrita sem guarda
await tx.query('UPDATE produto_precos_condicao SET preco=$1 WHERE id=$2', [preco, vigente.id]);
await s.update(productosResource, Number(existing.id), validatePayload(productosResource, payload, 'update'), tx);
```

Correto:

```ts
await persistUniversalConditionPrice(tx, { empresaId, produtoId, canal: cp.canal, condicao: cp.condicao,
  preco, quantidadeMinima: cp.min, margemPct, criadoPor, regraCalculo });
const data = validatePayload(productosResource, preserveNonzeroBasePrices(existing, payload), 'update');
```

Se a mudança cria um novo campo de preço por condição, ele precisa entrar em
`UNIVERSAL_CONDITION_PRICE_FIELDS` com o mesmo `canal`/`condicao`/`min` da política oficial.
