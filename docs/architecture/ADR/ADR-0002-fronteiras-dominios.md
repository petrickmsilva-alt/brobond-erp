# ADR-0002 — Fronteiras dos domínios e kernel compartilhado

* **Identificador:** ADR-0002
* **Título:** Fronteiras dos domínios e kernel compartilhado
* **Status:** Aceita
* **Data:** 2026-11-07
* **Relacionados:** ADR-0001, ADR-0003

## Contexto

O ERP tem um kernel transversal (`empresa.ts`, `resources.ts`, `services.ts`,
`store.ts`, `auditChain.ts`, `observability.ts`) reusado por ~100 arquivos, e
bounded contexts em `modules/*` que importam **infraestrutura** do ERP
(`getStore`, `getResource`, `segredos`, `errors`, `utils`).

## Problema

Definir o que cada módulo pode importar do outro sem romper a fronteira do
domínio.

## Decisão

1. **Kernel compartilhado:** tenancy, metadados, CRUD/RBAC, store, validação,
   erros, auditoria, observabilidade e outbox são transversais e podem ser
   importados por qualquer módulo.
2. **Bounded contexts** (`modules/*`) podem importar o **kernel**, nunca a
   **regra de negócio** de outro domínio de ERP.
3. **Acesso a dado de outro contexto** é por serviço/contrato explícito
   (`CONTEXT-MAP.md`), não por SQL direto à tabela interna.
4. **Anunciante folha** para evitar ciclos (`eventosVenda.ts`,
   `sale-events.ts`): o módulo que anuncia não importa o módulo que reage.

## Alternativas consideradas

- **Cada módulo com seu próprio store/tenancy:** rejeitada. Duplicaria tenancy e
  RBAC — origem clássica de vazamento entre empresas.
- **Deixar o acoplamento livre:** rejeitada. Quebraria a extraibilidade futura.

## Consequências

- O kernel é a "biblioteca padrão" do monólito; mudanças nele têm alto impacto
  e exigem cuidado.
- Fronteiras testáveis por gates (`architecture:audit`, `audit:menu`).

## Riscos

- Kernel grande demais → mitigado por proibir regra de negócio nova nele.
