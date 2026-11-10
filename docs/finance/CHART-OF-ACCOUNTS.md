# CHART-OF-ACCOUNTS — plano de contas (Fase 9.5)

**Data:** 2026-11-09 · **Branch:** `architecture/fases-9-4-9-5-9-6`
**Código:** `server/src/services.ts` (`validarContaContabil`), `server/src/financeiroContabil.ts`
**Migration:** `db/migrations/0056_financeiro_estrutura_contabil.sql`

> **Escopo.** O plano de contas é o **cadastro da empresa/contador**. O ERP **não**
> semeia um plano "padrão" e **não** gera partida dobrada automática. Sem plano
> mapeado, o lançamento fica **sem classificação** e aparece assim no balancete —
> nunca jogado numa conta "diversos" inventada.

## 1. Estrutura

Tabela `plano_contas` (migration 0056), **isolada por empresa** (`empresa_id`):

| Coluna | Papel |
|---|---|
| `codigo` | código da conta (ex.: `1.01.02`) |
| `nome` / `descricao` | identificação |
| `natureza` | `ativo`, `passivo`, `patrimonio_liquido`, `receita`, `despesa`, `custo` (CHECK) |
| `tipo` | `sintetica` (agrupa) ou `analitica` (recebe lançamento) (CHECK) |
| `pai_id` | conta-pai (FK para `plano_contas.id`) |
| `ativo` | situação |
| `criado_em` / `atualizado_em` | auditoria |

Índices: `plano_contas_codigo_unico` (UNIQUE `(empresa_id, codigo)`) e
`plano_contas_empresa_idx` (`(empresa_id, natureza, ativo)`).

## 2. Regras de hierarquia (validadas no serviço)

A FK simples **não** impede ciclo nem exige pai sintético — por isso existem as
validações em `validarContaContabil` (`server/src/services.ts`), aplicadas em
criação e edição:

1. **Auto-referência** — a conta não pode ser pai de si mesma → **400**.
2. **Pai de outro tenant** — o pai precisa existir na **mesma empresa** → **404**.
3. **Ciclo** — subir a cadeia de pais não pode voltar à própria conta → **400**.
4. **Pai analítico** — o pai precisa ser **sintético** (conta com filhas só
   agrupa) → **400**.
5. **Conta com filhas não vira analítica** → **409**.

## 3. Exclusão

Excluir uma conta com **filhas** ou com **lançamento classificado** é bloqueado
→ **409** ("desative-a em vez de excluir"). O histórico contábil aponta para a
conta; não há exclusão física de estrutura em uso.

## 4. Importação em lote

A importação contábil (`db/migrations/0059`) grava partidas no **livro único**
(`lancamentos_financeiros`), com cabeçalho `fin_importacoes_contabeis` para
idempotência (hash único por empresa) e conferência (Σ débitos × Σ créditos).
Conta citada na importação **precisa existir** no plano **da empresa** — validado
dentro da transação. Ver [`ACCOUNTING-INTEGRATION.md`](ACCOUNTING-INTEGRATION.md).

## 5. Interface

- Módulo de plano de contas (CRUD genérico do recurso `plano_contas`).
- `GET /api/financeiro/balancete?de=AAAA-MM&ate=AAAA-MM` lê o **mesmo** livro e
  mostra débitos/créditos/saldo por conta + a lista de `sem_classificacao`.

## 6. Status

| Item | Status |
|---|---|
| Estrutura (`plano_contas`) + constraints | **IMPLEMENTADO E TESTADO** (0056) |
| Hierarquia / ciclo / sintética×analítica | **IMPLEMENTADO E TESTADO** |
| Exclusão protegida | **IMPLEMENTADO E TESTADO** |
| Importação contábil transacional | **IMPLEMENTADO E TESTADO** (0059) |
| Contabilidade legalmente homologada | **NÃO APLICÁVEL** (depende do contador) |
