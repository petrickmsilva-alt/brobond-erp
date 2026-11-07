# FOUNDATION-STANDARDS — padrões de domínio e de módulo

**Data:** 2026-11-07 · **Branch:** `architecture/fase-1-foundation`
**Referência:** [`TARGET-ARCHITECTURE.md`](TARGET-ARCHITECTURE.md) (Fase 0),
ADR-0001 (Modular Monolith), ADR-0002 (fronteiras e kernel).

> **Princípio.** Os padrões abaixo **descrevem e travam** o que o ERP já faz de
> forma consistente. Não introduzem abstração nova sem benefício concreto — a
> missão é governar, não reescrever.

---

## 1. Camadas

| Camada | Onde vive | Responsabilidade | Não pode |
|---|---|---|---|
| **Apresentação** | `client/src/pages/*`, `client/src/components/*` | UI, navegação, formulários | decidir autorização, conter regra comercial |
| **API** | `server/src/index.ts` + routers | rota, middleware, `requireAuth`, rate limit, correlação | conter regra de domínio |
| **Aplicação** | `server/src/*.ts` (serviços de caso de uso: `comercial.ts`, `pedidos.ts`…) | orquestrar, transação, validar entrada, autorizar | SQL cru fora do store |
| **Domínio** | `modules/*` (bounded contexts) | regra do contexto (pagamentos, logística, conectores) | conhecer HTTP |
| **Infraestrutura** | `server/src/store.ts`, `db/*`, `modules/*/infrastructure` | persistência, cifra, providers externos | conter regra de negócio |

## 2. Organização de módulo

Um módulo é um diretório com fronteira explícita. O ERP usa dois formatos
legítimos:

1. **Recurso de ERP** (CRUD + fluxo): declarado em `server/src/resources.ts`
   (`Resource`) e servido pelo CRUD genérico + endpoints de fluxo. A maior parte
   do ERP é assim.
2. **Bounded context** (`modules/<nome>/`): camadas internas
   (`domain`/`application`/`infrastructure`), contrato público em `index.ts`,
   provider por plataforma. Ex.: `modules/payments`, `modules/logistics`,
   `modules/connectors`.

**Regra de importação:** um bounded context importa o **kernel** do ERP
(`store`, `resources`, `services`, `empresa`, `segredos`, `errors`, `utils`),
**nunca** a regra de negócio de outro contexto (ADR-0002).

## 3. Entidades e Value Objects

- **Entidade:** tem identidade (`id`) e ciclo de vida — ex.: `produtos`,
  `vendas`, `clientes`. Persistida em tabela com PK.
- **Value Object:** não tem identidade própria, é comparado por valor — ex.:
  valor monetário em centavos (`*_cents`), instante ISO-8601 UTC, código de
  barras. **Não** criar tabela para VO.
- **Derivado não é coluna:** saldo, disponibilidade, custo, score são
  calculados a partir da fonte (ver `SOURCE-OF-TRUTH.md`). Quando materializados,
  são **projeção** e não podem virar fonte oficial.

## 4. Serviços

- **Serviço de domínio:** regra que não pertence a uma entidade só; puro sempre
  que possível (ex.: cálculo de disponibilidade, conversão de unidade).
- **Serviço de aplicação:** orquestra caso de uso — recebe ator, autoriza
  (`checkAccess`/guard), abre transação, chama domínio/store, publica outbox.
- **Serviço de integração:** fala com o externo por `ShippingProvider`,
  `FreightProvider`, gateway, conector. Isola HTTP/credencial; nunca vaza
  payload externo para dentro sem validação.

## 5. Repositórios e acesso a dados

- O acesso passa por `getStore()` (`server/src/store.ts`) com `Resource` —
  nunca SQL interpolado com dado de usuário.
- Consulta é **sempre recortada por empresa** quando o recurso é multiempresa
  (`aplicarFiltroEmpresa` + `escopoDoAtor`) — ver `TENANT-GOVERNANCE.md`.
- Transações: `runInTransaction`/`runInTransactionComCorrida`. Efeito externo
  entra na **mesma transação** via outbox (`EVENT-STANDARDS.md`).
- Prisma só no bounded context do commerce (ADR-0014).

## 6. DTOs, validação e erros

- **Entrada:** declarada como `Field` no `Resource` (`type`, `required`,
  `unique`, `maxLength`, `min`/`max`, `options`/`optionsFrom`, `pattern`).
  `validate.ts` valida e converte. **Não** duplicar biblioteca de validação
  (ADR-0009).
- **Saída:** o store devolve a linha; a listagem tem paginação/ordenação/filtro
  no servidor. Campos sensíveis (segredos) saem **mascarados**
  (`mascararSegredo`).
- **Erros:** `HttpError(status, message, extra?)`. Nunca engolir exceção;
  nunca devolver stack ao cliente. Erro de integração externa → 502 + dead
  letter, não 500 silencioso.

## 7. Contratos entre módulos

Todo acesso a dado de outro contexto declara: **dono** da informação, quem
**consulta**, quem **altera**, contrato de entrada/saída, validação,
autorização, tratamento de erro, **idempotência**, consistência e auditoria
(ver `CONTEXT-MAP.md` §3). Sem contrato documentado, o acesso é um GAP.

## 8. Estrutura de referência (aplicada)

O padrão já está materializado em módulos selecionados pela auditoria:

- `modules/logistics` — bounded context completo (domain/application/
  infrastructure, providers, outbox, inbox, config cifrada). **Referência
  canônica** de contexto extraível.
- `modules/payments` — Payment Engine (intents, attempts, settlements,
  refunds, routing). Referência de máquina de estado.
- `modules/connectors` — integração multi-plataforma (OAuth, webhook, sync).

Nenhum código novo de framework foi criado: o objetivo é que os próximos
módulos sigam **estes** moldes.

## 9. Convenções de código (do `AGENTS.md`)

- TypeScript strict; sem `any` injustificado nem cast para esconder erro.
- Sem tratamento silencioso de exceção nem fallback que mascara falha.
- Sem código duplicado para contornar módulo existente.
- Comentário só quando expressa invariante/trade-off não óbvio.
- Node **24** no CI (não voltar ao 22 — bug do runner `node --test`).

## 10. Critérios de aceite do padrão

1. Módulo novo declara sua camada e sua fronteira.
2. Recurso novo tem `Resource` com validação, `ops` e perfil mínimo.
3. Regra comercial **nunca** só no frontend.
4. Efeito externo sempre via outbox.
5. Consulta multiempresa sempre recortada.
6. Teste de isolamento A×B para recurso multiempresa.
