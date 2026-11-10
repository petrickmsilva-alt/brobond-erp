# ACCOUNTING-INTEGRATION — integração financeira e contábil (Fase 9.5)

**Data:** 2026-11-09 · **Branch:** `architecture/fases-9-4-9-5-9-6`
**Código:** `server/src/financeiroContabil.ts`, `server/src/services.ts`
**Migrations:** 0056 (estrutura contábil), 0059 (importação contábil), 0071 (períodos contábeis)

> **Regra fundadora.** O BROBOND tem **um** financeiro: `lancamentos_financeiros`
> (livro único). Não existe segundo ledger nem motor contábil paralelo. Tudo que
> é contábil é **classificação** num lançamento que já existe.

## 1. O que é classificado

O lançamento financeiro carrega a classificação contábil **opcional** (0056):

| Coluna | Papel |
|---|---|
| `conta_contabil_id` | conta do plano (FK `plano_contas`) |
| `natureza_lancamento` | `debito` ou `credito` (CHECK) |
| `documento_origem_recurso` / `documento_origem_id` | proveniência (venda, compra, aporte, transferência) |
| `competencia` | regime de competência (separado da `data`) |
| `partida_id` (0059) | nº do lançamento (ENTRY) no lote importado |

**Coerência:** conta e natureza andam juntas (constraint
`lancamentos_classificacao_coerente`) — uma sem a outra não classifica nada.

## 2. Conta contábil no lançamento

`validarClassificacaoLancamento` (`server/src/services.ts`): quando o formulário
informa `conta_contabil_id`, a conta precisa existir **na empresa** e ser
**ANALÍTICA**. Lançar em conta **sintética** → **422** (erro de escrituração).

## 3. Balancete (leitura, sem recalcular)

`GET /api/financeiro/balancete?de=AAAA-MM&ate=AAAA-MM`
(`balanceteFinanceiro`):

- SOMA o que já está lançado — **não** recalcula valor;
- por conta: `debitos`, `creditos`, `saldo`, `lancamentos`;
- separadamente: `sem_classificacao` — o que **não** tem conta/natureza. O
  balancete **nunca** "fecha" escondendo lançamento sem conta;
- competência ausente usa a `data` (regime de caixa como *fallback* explícito).

`GET /api/financeiro/plano-contas/resumo` (`resumoPlanoContas`) apresenta o
plano com a movimentação **observada**.

## 4. Importação contábil em lote (0059)

- Cabeçalho `fin_importacoes_contabeis`: hash único por empresa (**idempotência**),
  rastreabilidade (quem/quando/arquivo) e conferência (Σ débitos = Σ créditos);
- partidas gravadas em `lancamentos_financeiros` com
  `documento_origem_recurso = 'fin_importacoes_contabeis'`;
- **efeito no caixa:** lançamento de competência **não** é movimento de caixa — o
  resumo de fluxo **exclui** explicitamente essas linhas, senão a receita já
  lançada pela venda seria contada duas vezes.

## 5. Centros de custo e categorias (conceitos distintos)

| Conceito | Finalidade |
|---|---|
| Categoria financeira | classificação **operacional** do lançamento |
| Conta contábil | classificação **contábil** (plano de contas) |
| Centro de custo | **onde** o custo ocorre (unidade/projeto) |

Não se cria categoria duplicada para suprir ausência de centro de custo: cada
entidade tem finalidade própria.

## 6. Limite honesto

O ERP **não** tem contabilidade legalmente homologada: tem a **estrutura**
pronta (plano, débito/crédito, competência, origem, balancete) para quando o
contador ligar a escrituração. Nada é apresentado como contabilidade legal.

## 7. Status

| Item | Status |
|---|---|
| Classificação no livro único | **IMPLEMENTADO E TESTADO** |
| Balancete + sem classificação honesto | **IMPLEMENTADO E TESTADO** |
| Importação contábil idempotente | **IMPLEMENTADO E TESTADO** |
| Escrituração contábil legal | **NÃO APLICÁVEL** (contador) |
