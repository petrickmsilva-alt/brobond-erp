# 1. MEU NEGÓCIO — Motor Analítico

> Substitui os mocks do módulo **1. MEU NEGÓCIO** por cálculo real: margem por
> pedido materializada nas colunas de `sales`, curva ABC nativa persistida em
> `produto_abc` e agregadores de BI com filtros estritos de período, empresa e
> canal. Nada é "estimado": todo número sai de uma fórmula auditável, em
> centavos inteiros.

## A fórmula do lucro bruto

Para cada pedido (`sales`) o motor calcula:

```
Valor Líquido      = amount_cents (total pago, já líquido dos descontos de item)
CMV                = Σ (quantidade do item × custo unitário médio do produto)
Impostos           = Σ (subtotal do item × alíquota do NCM do produto)
Frete pago         = freight_cents (custo de envio, padrão 0)

Lucro Bruto (¢)    = Líquido − CMV − Impostos − Frete
Margem (%)         = Lucro Bruto / Líquido × 100      (0 se Líquido ≤ 0)
```

**Custo unitário (CMV)** usa a ficha técnica quando existe e está calculada:
`custo_calculado` da ficha viva > `produtos.custo` > 0. Ou seja, o mesmo custo
médio que aparece no módulo de produção.

**Impostos por NCM** vêm da tabela editável `impostos_ncm` (`Configurações >
Impostos/NCM`, gerente/admin). A chave casa com `produtos.ncm` **normalizado**
(só dígitos) e aceita:

| Chave     | Significado                        | Exemplo                 |
|-----------|------------------------------------|-------------------------|
| 8 dígitos | NCM exato                          | `61091000`              |
| 6/4/2     | Prefixo (subposição/posição/cap.)  | `6109`, `61`            |
| vazio     | **Alíquota padrão** (`ncm IS NULL`, única linha) | 5% para quem não tem NCM |

Vence sempre a chave **mais longa** que casa com o NCM do produto. Sem
casamento e sem linha-padrão: **0%** — o motor nunca inventa imposto. Não há
seeds: o padrão é 0% até alguém cadastrar.

## O que fica gravado (migração 0016)

- `sales`: `empresa_id` (FK, padrão 1), `freight_cents`, e as colunas reais
  `net_cents`, `cmv_cents`, `tax_cents`, `gross_profit_cents`,
  `margin_pct NUMERIC(12,4)`, `margem_calculada_em`.
- `produto_abc`: classificação por empresa+produto (`A|B|C`), faturamento,
  % total, % acumulado e a janela usada (`janela_de/janela_ate`).
- `empresas`: multi-empresa pronta (BROBOND é a id 1).
- `impostos_ncm`: alíquotas editáveis; índice parcial garante **uma única**
  linha-padrão (`ncm IS NULL`).

Arredondamento idêntico ao `ROUND` do Postgres (half-away-from-zero) em JS e
SQL — os dois caminhos dão o mesmo número até o 4º decimal.

## Curva ABC (80/15/5)

Faturamento **acumulado** por produto em vendas `PAID`, ordenado do maior para
o menor:

- **A** — até fechar 80% do faturamento acumulado;
- **B** — até 95% (+15%);
- **C** — os 5% restantes.

O produto que cruza um limite pertence à **classe anterior** (produto único =
A, nunca C). Empate de faturamento desempata pelo menor `produto_id` — a
classificação é determinística. O motor recalcula a curva:

1. a cada venda manual registrada (classificação contínua),
2. ao receber venda nova dos conectores (debounce de 5 s),
3. num ciclo automático (`NEGOCIOS_AUTO_REFRESH_MS`, padrão 15 min, `0` desliga),
4. no agendador (`scheduled.ts`) e sob demanda (`POST /api/negocios/abc/recalcular`),
   com janela `De/Até` opcional para análise de período.

## Canais de venda

| Grupo       | Canais                                                        |
|-------------|---------------------------------------------------------------|
| Loja Física | `LOJA_FISICA` (novo enum, canal padrão da venda manual)       |
| E-commerce  | `BROBOND`, `NUVEMSHOP`, `INSTAGRAM_SHOPPING`, `MERCADOPAGO`   |
| Marketplaces| `MERCADOLIVRE`                                                |

O filtro `canal` aceita o canal específico **ou** o grupo (`loja_fisica`,
`ecommerce`, `marketplace`). `GET /api/negocios/canais` devolve o mapa para a
UI montar os seletors.

## Endpoints (`/api/negocios/*`)

| Método | Rota                  | Acesso            | O que faz |
|--------|-----------------------|-------------------|-----------|
| GET    | `/canais`             | leitura/vendas    | Mapa de grupos e canais |
| GET    | `/resumo`             | leitura/vendas    | KPIs (faturamento, lucro bruto, margem, ticket, pendentes), por canal/mês/status, top produtos |
| GET    | `/margens`            | gerente/admin     | Margem por pedido (item a item: líquido, CMV, impostos, frete, lucro, margem %) |
| POST   | `/margens/recalcular` | gerente/admin     | Recalcula o lucro de todos os pedidos no filtro (retroativo ao editar alíquota/custo) |
| GET    | `/abc`                | leitura/vendas    | Curva ABC com filtro opcional por classe |
| POST   | `/abc/recalcular`     | gerente/admin     | Reclassifica a curva (opcional `de`/`ate` no corpo) |
| POST   | `/vendas`             | criar/vendas      | **Venda manual** (Loja Física/checkouts): grava, calcula margem na mesma transação e reclassifica a ABC |

Filtros de BI (todos estritos — valor inválido devolve 400, nunca lista "quase
certa"): `de`/`ate` (`AAAA-MM-DD`, inclusivos), `empresa_id`, `canal`,
`status`. Faturamento no resumo considera apenas `PAID`; `PENDING` aparece
como pedidos pendentes.

### Venda manual

```json
POST /api/negocios/vendas
{
  "canal": "LOJA_FISICA",            // padrão; qualquer um dos 6
  "status": "PAID",                  // PAID (padrão) ou PENDING
  "occurred_at": "2026-01-15",       // AAAA-MM-DD (12:00 UTC) ou ISO; padrão hoje
  "freight_cents": 500,              // custo do frete pago
  "empresa_id": 1,                   // padrão 1
  "itens": [
    { "product_id": 42, "size_id": 3, "quantity": 2,
      "unit_price_cents": 5000, "discount_cents": 1000 }
  ]
}
```

`amount_cents = Σ (quantidade × preço − desconto)`; a margem sai calculada na
resposta (201) e gravada nas colunas reais; a venda é atribuída ao usuário
autenticado (`sales.usuario_id`) com `reference = manual:<uuid>` e trilha de
auditoria.

## Roteiro

- [x] Motor de margem por pedido (query SQL materializada + espelho em memória)
- [x] Curva ABC nativa contínua com janela
- [x] Agregadores de BI com filtros estritos (De/Até, empresa, canal)
- [x] Venda manual transacional (Loja Física/checkouts)
- [x] Impostos por NCM editáveis + alíquota padrão única
- [x] Multi-empresa (`empresas`) pronta para uso
- [ ] Front-end consumindo os endpoints (próxima fase)

## Testes

- `server/test/negocios.test.ts` — a prova matemática em modo memória: números
  calculados à mão centavo a centavo (margem, imposto por NCM, ABC 80/15/5,
  filtros estritos, permissões, validações da venda manual).
- `server/test/pg-negocios.test.ts` — a mesma prova contra Postgres real (job
  `testes-postgres` do CI): query materializada, janela na `produto_abc`,
  unicidade da linha-padrão de `impostos_ncm`.
