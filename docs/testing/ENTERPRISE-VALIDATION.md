# ENTERPRISE VALIDATION — Fase 9.6

**Data:** 2026-11-09 · **Branch:** `architecture/fases-9-4-9-5-9-6`
**SHA base (`main`):** `7c665b501fbf06bda436bb4abbf036193f139fb3`

> **Objetivo.** Camada permanente de validação empresarial: provar que os
> domínios funcionam **integrados**, que o PostgreSQL preserva a integridade,
> que não há vazamento entre empresas, que o RBAC é efetivo no backend e que o
> ERP mantém estabilidade. Não é uma rodada manual: são testes reproduzíveis no
> repositório e no CI.

## 1. Como executar

| Suíte | Comando | Escopo |
|---|---|---|
| Regras de negócio (memória) | `unset DATABASE_URL && npm --workspace server test` | 2504 testes |
| Cliente | `npm --workspace client test` | 1195 testes |
| PostgreSQL real (gate) | `npm run test:pg` | 484 testes, banco **vazio** |
| Typecheck | `npm run typecheck` | domínio + servidor + cliente |
| Lint | `npm run lint` | 0 **errors** (warnings = baseline) |
| Build | `npm run build` | front |
| Auditoria arquitetural | `npm run architecture:audit` | recursos × tabelas × tenant |
| Auditoria de menu | `npm run audit:menu` | menu × fonte única |

O gate `test:pg` (`scripts/test-pg-gate.mjs`) **recusa** banco reaproveitado
(`relações públicas != 0`), exige PostgreSQL **16.14** (`160014`) e **falha** se
o runner reportar qualquer `skip`/`todo` — skip crítico não é aprovação.

## 2. Suíte de integração entre domínios

`server/test/pg/fase9-6-enterprise-validation.test.ts` (PostgreSQL real). Sem
`DATABASE_URL` o arquivo **falha** de propósito: a prova deste ciclo é o banco.

| # | Cadeia provada | Asserção central |
|---|---|---|
| A | Tenancy (2 empresas) | A lê/escreve/exclui o seu; B recebe **404** (não 403 — não vaza existência) e não vê na listagem |
| B | RBAC | operador recebe **403** no plano de contas (minPerfil gerente); gerente cria de fato |
| C | Fiscal | leiaute vigente vem da **migração 0115**; período sem leiaute lança **422** (não presume versão); validador estrutural aprova/reprova |
| D | Unidades | converte só o declarado; recusa entre grandezas (**400**); sem regra → `null`; isolamento por empresa |
| E | Produto → Estoque → Venda → Financeiro → Balancete | faturamento baixa estoque (10→8), cria **1 título**, o balancete soma o crédito e rastreia a origem `vendas`; B não alcança |

A cadeia E valida o **estado persistido no banco** (saldo, movimentações,
título, balancete), não apenas o status HTTP.

## 3. PostgreSQL real

- Versão: **16.14** (mesma do CI e do container local `brobond-pg`).
- Cobertura da bateria `test:pg`: migrations, constraints, FKs, índices,
  transações, rollback, locks, concorrência, isolamento, idempotência,
  paginação, integridade referencial e migração em banco com dados.
- Prova de **banco novo**: `scripts/test-pg-gate.mjs` cria/valida banco vazio a
  cada execução; um banco com relações públicas ≠ 0 é rejeitado (P2-09).
- Nenhum teste marcado como aprovado foi ignorado. O gate falha em `skip`.

Resultado desta execução: **484 pass / 0 fail / 0 skip / 0 todo** (ver
`REGRESSION-GATES.md`).

## 4. Tenancy, RBAC e desempenho

As matrizes detalhadas estão em:

- [`TENANCY-TEST-MATRIX.md`](TENANCY-TEST-MATRIX.md)
- [`RBAC-TEST-MATRIX.md`](RBAC-TEST-MATRIX.md)
- [`PERFORMANCE-BASELINE.md`](PERFORMANCE-BASELINE.md)
- [`DOMAIN-INTEGRATION-MATRIX.md`](DOMAIN-INTEGRATION-MATRIX.md)

## 5. Escopo e limites

- **Não** se executa benchmark pesado nem operação destrutiva em produção.
- **Não** se declara conformidade fiscal: a Fase 9.5 entrega estrutura e
  validação **estrutural**; homologação (PVA oficial / contador) é externa.
- **Não** se ativa conector externo, não se sincroniza pedido real, não se
  transmite documento fiscal (ver `docs/fiscal/` e `docs/architecture/`).
