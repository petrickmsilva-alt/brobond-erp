# ADR-0014 — Evolução do Prisma e SQL

* **Identificador:** ADR-0014
* **Título:** Evolução do Prisma e do SQL
* **Status:** Aceita
* **Data:** 2026-11-07
* **Relacionados:** ADR-0003, ADR-0011

## Contexto

Prisma é usado em 11 modelos (5 com `empresaId`) no bounded context do commerce;
o restante do ERP é SQL-first. Existe dual-track de migrations.

## Problema

Definir a fronteira do Prisma e como evoluí-lo sem criar segunda fonte de
verdade.

## Decisão

1. **Prisma permanece restrito** aos contextos em que já é usado (commerce).
2. **Não migrar todo o banco para Prisma.**
3. **Não criar modelo Prisma para tabela que o ERP não cria** nem o inverso.
4. Divergência Prisma × SQL é **documentada** e corrigida só no escopo
   necessário.
5. `npx prisma validate` roda no CI (job `verificar`).

## Alternativas consideradas

- **Adotar Prisma em todo o ERP:** rejeitada (risco alto, sem benefício).
- **Remover Prisma:** rejeitada; o bounded context funciona e tem migração
  própria.

## Consequências

- Dual-track mantido e documentado.
- `architecture:audit` separa métricas SQL e Prisma.

## Riscos

- Comentário/doc desatualizado sobre Prisma → corrigido no Agente 07 (GAP-P2-07).
