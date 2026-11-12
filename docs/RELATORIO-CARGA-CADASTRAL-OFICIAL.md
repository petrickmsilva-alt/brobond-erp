# Relatório — Carga cadastral oficial e reinicialização para go-live

Fonte de cadastro: `TABELA DE PREÇO BASE PARA ERP.xlsx` (11 abas).
Importador oficial: `server/src/cargaPoliticaComercial.ts` (migration 0117),
exposto por `POST /api/carga/politica-comercial/preview` e `.../confirmar`.

Este relatório registra a conferência da carga contra **PostgreSQL real** e a
correção do único defeito que impedia a carga integral (variação de cor na aba
"Política Comercial Roupas (2)").

## 1. Correção aplicada (bug real de identidade de variação)

Na aba **Roupas** o código é `PRODUTO-COR-TAMANHO` (ex.: `94000-caramelo-g`), e a
cor **não** vem de coluna — vem do próprio código (`parseCodigoRoupas`). O
importador lia a cor da coluna (`''` na fonte roupas) e descartava a cor do
código. Efeito: duas cores do MESMO tamanho geravam a MESMA chave de variação
(`TAM:G` para azul claro × caramelo) e a segunda linha era rejeitada como
duplicada — **variações reais eram perdidas** (`ITEM_REJ`).

Correção: a cor parseada do código passa a alimentar o eixo de variação
(`server/src/cargaPoliticaComercial.ts`). Sem inventar cor: só usa o que o
código comprovadamente traz. O tamanho continua vindo do código e a
descrição-base não é afetada quando a cor não aparece nela.

Cobertura: teste de memória
(`server/test/carga-politica-comercial.test.ts` — "cores diferentes do mesmo
tamanho são variações distintas") e teste PostgreSQL real
(`server/test/pg/pim-carga-planilha-pg.test.ts`).

## 2. Reconciliação planilha × banco (PostgreSQL real, banco vazio)

| Controle | Planilha (leitura) | Banco (após carga) |
| --- | --- | --- |
| Linhas de cadastro | 415 | — |
| SKUs distintos | 414 | 414 produtos com SKU próprio |
| Produtos-pai | 75 famílias (30 simples + 45 com variação) | 75 |
| Linhas de variação | 385 | 384 variações (1 SKU repetido) |
| Produtos totais | — | 459 (75 pais + 384 variações) |
| Preços oficiais (entradas) | 3560 | 3558 linhas vigentes |
| Conflitos de preço | 0 | 0 |
| Códigos de barras GTIN válidos | 0 (80 concatenados, 0 inválidos) | 0 importados |
| Rejeitados | — | **0** |
| `estoques` (quantidade física) | — | **0** |
| `movimentacoes` | — | **0** |

Diferença de preços **3560 → 3558**: o SKU `93845-42` aparece em DUAS linhas da
aba Roupas (linhas 7 e 90) com o MESMO produto/tamanho/preço. É linha duplicada
do arquivo, não um segundo preço: a variação é idempotente por SKU e a segunda
linha é ignorada (e reportada). Os 2 preços da linha duplicada convergem para os
mesmos pares (SKU|canal|condição), resultando em 3558 pares distintos — o
número correto. Nenhum preço foi descartado por erro.

Preços por canal/condição gravados em `produto_precos_condicao`:

- atacado: `atacado_vista`, `boleto_30`, `boleto_30_60`, `boleto_30_60_90`,
  `cartao_credito_30_60`, `cartao_credito_30_60_90`, `cartao_credito_vista`,
  `cartao_debito`;
- varejo: `varejo_vista`, `varejo_2un`, `cartao_vista`, `cartao_parcelado`.

Todas as condições usadas pela planilha são cadastradas em `condicoes_pagamento`
(idempotente por empresa+código).

## 3. Atributos novos (migration 0120)

Colunas aditivas em `produtos`, todas nascem vazias (nenhum valor inventado):
`material`, `modelagem`, `genero`, `origem_dados`, `atributos_adicionais`
(JSONB, `NOT NULL DEFAULT '{}'`, `CHECK jsonb_typeof = 'object'`).

Na carga real: `origem_dados='planilha'` em 459/459 produtos; 176 produtos com
`atributos_adicionais` não vazio (colunas próprias de cada aba e fornecedor,
preservadas sem virar coluna tipada). Preço, custo, margem, imposto e movimento
NUNCA entram como atributo — só cadastro livre. `unidade` derivada do "Tipo"
(`PÇ→pc`, `UN→un`): 373 `un`, 86 `pc`; valor sem correspondência fica `null` e
permanece em `atributos_adicionais`.

Interface: `client/src/pages/ProdutoFormPage.tsx` passa a editar a coluna JSONB
como texto (validação de sintaxe, sem `"[object Object]"`) e expõe a seção
"Características" (composição, material, modelagem, gênero, origem do cadastro,
atributos adicionais).

## 4. Idempotência comprovada

Reimportar o MESMO arquivo sobre a base carregada: `produtos: 0`,
`variacoes: 0`, `ignorados: 415`, `rejeitados: 0`; totais de produtos e de
preços inalterados. Mudança real de valor fecha a vigência anterior e abre a
nova, com histórico em `produto_precos_condicao_historico` (append-only).

## 5. Estoque — regra arquitetural

- Local físico canônico único provisionado por empresa sem nenhum local:
  **"Loja"** (`provisionarLocalPadrao`, ERP-03). Comprovado em PostgreSQL real:
  primeira operação cria `Loja` (padrão, ativo) e a segunda é idempotente
  (continua 1 local).
- Fórmula canônica de disponibilidade
  (`server/src/estoqueCanonico.ts`):
  `DISPONÍVEL = FÍSICO − RESERVADO − EMPENHADO − BLOQUEADO`.
- Após a carga: `estoques = 0` e `movimentacoes = 0`. Nenhuma quantidade física
  foi importada da planilha (nem das abas de controle de estoque). Os SKUs ficam
  cadastrados e prontos para o inventário do Diretor.
- ERP e Commerce consultam a MESMA disponibilidade (fonte única); nenhum canal
  tem saldo próprio.

## 6. Como reproduzir a conferência

```
# banco vazio e PostgreSQL 16.14
export DATABASE_URL="postgresql://.../brobond_gate"
npm run test:pg            # inclui pim-carga-planilha-pg e carga-politica-comercial
```

O importador nunca importa quantidade física, nunca sobrescreve preço já
definido (a base do canal só é preenchida quando zerada) e nunca transmite nada
para as lojas externas (WooCommerce permanece em modo seguro/dry-run).
