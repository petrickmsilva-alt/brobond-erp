# FASES 9.1, 9.2 e 9.3 — INTEGRIDADE DE DADOS, AUTOMAÇÃO DO CRM E UX OPERACIONAL

**Data:** 2026-11-09 · **Branch:** `architecture/fases-9-1-9-2-9-3` · **Base:** `main` (`37e625e`)
**Método:** leitura direta do código + execução dos gates do repositório.
**Fonte dos números:** `npm run architecture:audit`, `npm run audit:menu`,
`npm run audit:ux`, `node scripts/ux-guard.mjs`, suítes de teste e inspeção de
`db/`, `server/src/`, `client/src/`.

> **Regra.** Toda afirmação de estado tem evidência. Onde a verificação não pôde
> ser executada no sandbox, o item aparece como **BLOQUEADO** — nunca como
> "aprovado". Os comandos e resultados reais estão em §5.

---

## 1. FASE 9.1 — DATA INTEGRITY & PERFORMANCE

### 1.1 Estado anterior (auditado, não presumido)

O histórico registrava a hipótese **BL-016**: a projeção analítica `sale_items`
não tem `empresa_id` e as consultas analíticas liam `filter: {}` (todas as
empresas) para depois descartar as linhas de outro tenant **em memória**.

A auditoria confirmou a hipótese e a causa-raiz:

| Item | Achado |
|---|---|
| Autoridade de dados | `vendas`/`itens_venda` operacional; `sales`/`sale_items` projeção — **preservada** |
| `sale_items.empresa_id` | **ausente por decisão** (projeção; o tenant vem por `sales.empresa_id`) |
| Filtro do Store | igualdade simples por coluna; sem suporte a conjunto |
| `commerce/analytics.ts` | `top produtos` e `trends` liam itens de **todas** as empresas e recortavam em memória |
| Índice | `sale_items_sale_id_idx` já existia |

**Classificação:** `PRECISA DE CORREÇÃO` (over-fetch + recorte em memória).
A decisão arquitetural de **não** adicionar `empresa_id` redundante foi
mantida — o escopo já é garantido pela relação indexada com `sales`.

### 1.2 Correção implementada

- **Store** (`server/src/pgstore.ts`, `server/src/memdb.ts`): filtro de
  igualdade passa a aceitar **lista** → `col = ANY($n)` (PG) e conjunto (mem);
  lista vazia não devolve linha (fail-closed).
- **`server/src/commerce/projecao.ts`**: leitura tenant-scoped —
  `idsDeVendasDaEmpresa`, `itensDeVendas`, `itensDaEmpresa`.
- **`server/src/commerce/analytics.ts`**: `top produtos` e `crescimento` usam o
  recorte **no SQL** (nunca mais `filter: {}`).

**Sem migração** — `sale_items` permanece sem `empresa_id` (decisão mantida).
O ganho é de correção (não se lê o que não é do tenant) e de performance (o
recorte acontece no banco, apoiado em `sale_items_sale_id_idx`).

### 1.3 Testes

- `server/test/fase9-1-data-integrity.test.ts` (6 casos, memória): `= ANY`
  recorta; lista vazia devolve nada; `itensDaEmpresa` isola A de B;
  `itensDeVendas` só das vendas pedidas; `/commerce/analytics` e
  `/commerce/trends` só do tenant do ator; `sale_items` segue sem `empresa_id`.
- `server/test/pg/fase9-1-data-integrity.test.ts` (PG real): isolamento A/B **e**
  prova do plano de execução — **Index Scan** por `sale_items_sale_id_idx`.

---

## 2. FASE 9.2 — CRM LIFECYCLE AUTOMATION

### 2.1 Estado anterior (auditado, não presumido)

O lembrete de atividade já existia: `scheduled.ts` → `dispararLembretesCrm`,
idempotente por `crm_atividades.lembrete_enviado_em` (compare-and-swap). O canal
**externo** (e-mail) é opcional e desligado por padrão. Faltava o canal
**interno** — o que o histórico registrou como **BL-012 / GAP-P2-06 / GAP-P2-14**.

**Classificação:** `PRECISA DE CORREÇÃO` (canal interno ausente).

### 2.2 O que a Fase 9.2 acrescenta (reutilizando a infraestrutura existente)

**Não** foi criado um segundo CRM nem um motor concorrente de notificações.
Foi adicionado o **canal interno** sobre o agendador e a transação de mutação
que já existiam.

- **`db/migrations/0113_fase9_crm_notificacoes.sql`** (aditiva/idempotente):
  tabela `crm_notificacoes` com `empresa_id` NOT NULL, `UNIQUE (empresa_id,
  chave_idempotencia)` — **a idempotência é garantida pelo BANCO**, não só pelo
  código —, CHECKs de `tipo`/`severidade`/`titulo`, índices por
  `(empresa_id, usuario_id, lida_em)` e `(empresa_id, criado_em DESC)`.
  Espelho em `db/schema.sql`. `bootstrap.sql` regenerado e sincronizado.
- **`server/src/crmNotificacoes.ts`**: `criarNotificacaoCrm` idempotente
  (`ON CONFLICT` pela chave) + hooks de ciclo de vida (atribuição, troca de
  responsável, reagendamento, conclusão, cancelamento, vencida, falha) e o
  canal interno do agendador (lembrete idempotente por instante; vencida e falha
  idempotentes **por dia**).
- **`server/src/services.ts`**: os hooks rodam na **mesma transação** da mutação
  — histórico e aviso nascem juntos.
- **`server/src/crm.ts`**: o lembrete interno roda **independente** do canal
  externo (falha externa não impede o aviso interno, e não duplica).
- **Endpoints**: `GET /api/crm/notificacoes`, `POST /api/crm/notificacoes/:id/lida`,
  `POST /api/crm/notificacoes/lidas` — caixa **pessoal** (recorte por empresa **e**
  por usuário).
- **Recurso** `crm_notificacoes` (`empresa: true`, `minPerfil: gerente`,
  `ops.delete = false`) + `RBAC-MATRIX.md` (184 recursos).
- **Tela** `/crm/notificacoes` (`CrmNotificacoesPage.tsx`) + módulo no menu.

### 2.3 Idempotência, confiabilidade e isolamento

| Garantia | Mecanismo |
|---|---|
| Sem notificação duplicada | `UNIQUE (empresa_id, chave_idempotencia)` — reprocessar não duplica |
| Lembrete | chave por instante do lembrete (mesma do carimbo CAS) |
| Vencida / falha | chave por **dia** — uma varredura a mais no mesmo dia não empilha |
| Falha do canal externo | não impede o canal interno, não duplica (teste de retry) |
| Multiempresa | `empresa_id` NOT NULL + recorte por tenant e por usuário na consulta |
| RBAC | `minPerfil: gerente`; operador não lê a caixa |
| "Notificar não é agir" | a notificação **não** altera o estado da atividade |
| Histórico | `atividade_id` com `ON DELETE SET NULL` — a trilha sobrevive |

> Entrega é **at-least-once com deduplicação por chave**, não exactly-once.

### 2.4 Comunicação externa — não ativada

Nada aqui dispara e-mail/WhatsApp/SMS/push. O canal externo do CRM segue
desligado por padrão; a Fase 9.2 entrega **somente** o fluxo interno, com os
contratos preparados para expansão futura **sem** ativar conector.

### 2.5 Testes

- `server/test/fase9-2-crm-lifecycle.test.ts` (**19 casos**, memória): criação →
  atribuição → lembrete sem duplicidade → reagendamento → vencida (1×/dia) →
  conclusão → cancelamento → troca de responsável → isolamento A/B → isolamento
  por usuário → agendador com canal externo desligado → retry após falha →
  caixa pessoal → `/lida` idempotente → `403` ao marcar caixa alheia →
  "marcar todas" só na própria caixa → RBAC → falha crítica idempotente.
- `server/test/pg/fase9-2-crm-lifecycle.test.ts` (PG real): idempotência por
  `UNIQUE`, CHECKs de tipo/severidade/título, isolamento A/B, FK e
  "notificar não é agir".
- `client/src/pages/CrmNotificacoesPage.test.tsx` (6 casos): caixa pessoal,
  estado vazio, marcar lida, sem duplo envio.

---

## 3. FASE 9.3 — OPERATIONAL UX EXCELLENCE

### 3.1 Estado anterior (auditado, não presumido)

Auditoria das **91 páginas** de `client/src/pages`:

| Achado | Número |
|---|---:|
| Páginas que renderizavam `<PageHeader>` | 81 |
| Páginas com moldura própria à mão (`p-4 sm:p-6 [space-y-*]`) | ~15 |
| Páginas com `PageHeader` **sem** `PageShell` | 10 |
| Páginas fora do padrão (login/convite/reset/portal/catálogo público, dispatcher) | 10 |

A moldura canônica `PageShell` (respiro `p-4 sm:p-6`, empilhamento `space-y-4`,
ponto único de `PageLoading`/`PageError`) já existia em
`client/src/components/ui-kit-negocios.tsx`, mas vários módulos repetiam o
recuo à mão e as telas colavam na borda de forma desigual.

**Classificação:** `PRECISA DE CORREÇÃO` (consistência estrutural).

### 3.2 Correção implementada

- Conversão das páginas de layout próprio para `PageShell` — inclusive os
  ramos de **carregando/erro** que usavam `<div className="p-4 sm:p-6">` solto
  (a mesma tela tinha moldura diferente conforme o estado).
- Conversão de `OrderPage` (motores Venda e Compra), `RastreabilidadePage` e
  `ImpressaoPage` (título/descrição/ações migrados para `PageHeader`, moldura
  para `PageShell`).
- **`client/src/test/page-shell.test.ts`** — gate de CI novo, com **3 provas**:
  1. toda página que renderiza `<PageHeader>` **precisa** renderizar `<PageShell>`
     (sem lista de exceções);
  2. **nenhuma** página pode reimplementar a moldura à mão
     (`className="p-4 sm:p-6"` solto) — a regressão que a fase eliminou;
  3. o kit exporta `PageShell`/`PageLoading`/`PageError`.

### 3.3 Painéis auxiliares — preservados

`PainelInline` **não** foi removido em bloco. A classificação de referência
(`RELATORIO-PR95` §4.2, espelhada em `ERP-3.0-GAP-MATRIX` §10.4) mantém:

| Classe | Tratamento |
|---|---|
| Bloco auxiliar legítimo (leitura, impressão, diagnóstico, segredo único, ajuda) | **manter** |
| Child-flow do detalhe de documento (o documento já é página) | **manter** |
| Fluxo de módulo em painel (criação/edição na listagem) | convertido para **página** |

Os 12 fluxos de módulo da auditoria PR95 já estavam convertidos para páginas em
`main` (rotas `/custo/nova`, `/devolucoes/nova`, `/empresas/:id/editar`,
`/ncm/novo`, `/webhooks/novo`, `/config/impressao/…`, `/importar/:tipo`,
`/usuarios/novo`, `/compras/:id/receber`, `/cotacoes-compra/novo`). O gate
`scripts/ux-guard.mjs` (chamado por `audit:ux`) trava cada rota e **proíbe** a
volta do painel antigo (`RecebimentoCompraModal`, `ImportModal`,
`UsuarioFormModal`, etc.) — comprovado verde nesta rodada.

### 3.4 Estados e feedback

`PageLoading` e `PageError` são o ponto único de carregamento/erro de página.
As páginas fora do padrão (login, convite, reset de senha, portal público,
catálogo público) são **públicas** e usam layout próprio por identidade — não
consomem `PageHeader` e ficam fora do gate. O dispatcher
(`CommerceModulePage`) só delega; o `ModulePage` é o roteador de submódulo.

### 3.5 Testes

- `client/src/test/page-shell.test.ts` — gate estrutural (3 casos).
- `scripts/ux-guard.mjs` / `npm run audit:ux` — zero sobreposição nova em fluxo
  de módulo; exceções declaradas no baseline.
- Suíte completa do cliente: **140 arquivos · 1193 casos · 0 fail**.

---

## 4. Migrations

| Migration | Fase | Tipo | Conteúdo |
|---|---|---|---|
| `0113_fase9_crm_notificacoes.sql` | 9.2 | aditiva/idempotente | `crm_notificacoes` (canal interno) |
| `0114_fase9_crm_notificacoes_hardening.sql` | 9.2 (revisão) | aditiva/idempotente | FK composta do tenant + retenção `SET NULL` |

- Aplicada e validada no **gate PostgreSQL real** (`npm run test:pg`), em banco
  criado do zero: `🗄️ Migração aplicada: 0113_fase9_crm_notificacoes.sql`.
- Espelho em `db/schema.sql`; `db/bootstrap.sql` regenerado.
- **Sem** `DROP`, sem exclusão de dados, sem renomeação destrutiva.
- Rollback documentado no cabeçalho da própria migration (manutenção
  autorizada). **Não executada** em base de produção.

**Nenhuma migration na Fase 9.1** — a decisão de manter `sale_items` sem
`empresa_id` foi preservada.

---

## 5. Evidência executada (sandbox desta sessão)

| Verificação | Comando | Resultado |
|---|---|---|
| Typecheck | `npm run typecheck` | ✅ OK (domain + server + client) |
| Testes server | `npm --workspace server test` | ✅ **2382 pass · 0 fail · 93 skip** |
| Testes client | `npm --workspace client test` | ✅ **1195 pass · 0 fail** (140 arquivos) |
| Lint | `npm run lint` | ✅ **0 errors** (627 warnings — baseline) |
| Build | `npm run build` | ✅ OK (PWA gerada) |
| PostgreSQL real | `npm run test:pg` | ✅ **ERP-03 GATE PASS: 478 testes · 0 fail/skip/todo** |
| Fase 9.1 (PG) | dentro do `test:pg` | ✅ Index Scan `sale_items_sale_id_idx`; isolamento A/B |
| Fase 9.2 (PG) | dentro do `test:pg` | ✅ `crm_notificacoes` idempotente e isolada |
| Inventário | `npm run architecture:audit` | ✅ OK |
| Auditoria de menu | `npm run audit:menu` | ✅ OK |
| Auditoria de UX | `npm run audit:ux` | ✅ OK (zero sobreposição nova) |
| Gate UX (`ux-guard`) | `node scripts/ux-guard.mjs` | ✅ OK |

> O `test:pg` rodou contra o container local `postgres:16.14` (`brobond-pg`,
> porta 5433), em banco **vazio** (`brobond_gate`), conforme `AGENTS.md`.

---

## 6. Limitações e pendências

| ID | Sev. | Item | Situação |
|---|---|---|---|
| GAP-P2-14 / BL-012 | P2 | Lembrete do CRM sem notificação | **encerrado na Fase 9.2** (canal interno) |
| BL-016 | P2 | Over-fetch de `sale_items` | **encerrado na Fase 9.1** (recorte no SQL) |
| BL-014 | P2/P3 | Painéis de fluxo de módulo residuais | **convertidos para páginas** (trava no `ux-guard`) |
| — | P3 | Canal **externo** do CRM (e-mail/WhatsApp/SMS) | **não ativado** — fora do escopo autorizado |
| BL-009 | P2 | `smoke:pg`/`prisma validate` no sandbox | CI cobre |
| BL-010/011 | P2 | Fiscal SPED/EFD, importação de plano de contas | Aberto (externo) |
| BL-013 | P3 | `insumos.unidade` texto livre | Aberto |
| BL-015 | P2 | Descontinuação da loja nativa | Aberto — impedimento externo (DNS/credenciais) |

> Notificação externa segue **interna até homologação** — a regra guarda o
> canal, mas o envio externo **não** é presumido (mesma doutrina da Fase 8).

---

## 7. Segurança e integridade

- Nenhuma operação em produção; nenhum deploy; nenhum merge.
- Nenhum conector externo ativado; nenhuma mensagem real enviada.
- Nenhuma migration destrutiva; nenhuma exclusão de histórico.
- Isolamento multiempresa comprovado por teste em todas as três fases
  (A/B no SQL para analytics; A/B na caixa interna do CRM).
- RBAC preservado (`crm_notificacoes` `minPerfil: gerente`); nenhuma permissão
  genérica habilitada para destravar fluxo.
- "Notificar não é agir": a notificação interna não altera estado de negócio.

---

## 8. Revisão corretiva — 3 pontos de auditoria

A revisão endureceu três pontos sobre o PR original, sem reimplementar as fases
nem alterar a autoridade dos dados. Cada item tem teste que falharia antes.

### 8.1 Paginação determinística da projeção analítica (Fase 9.1)

`server/src/commerce/projecao.ts` lia `sales`/`sale_items` com um `pageSize`
fixo de **200.000** — um teto silencioso: uma empresa com mais linhas que o teto
perdia registros sem erro. A correção **pagina de verdade** (`paginarTudo`),
avançando página a página com ordenação estável por `id` até a última página
incompleta; `itensDeVendas` deduplica e ordena os ids e os divide em lotes
(`LOTE_IDS = 500`) para não estourar parâmetros de uma só instrução.
`analytics.ts` passou a consumir `itensDeVendas([...idsVendasPagas])` (só os
itens das vendas **pagas** do período), eliminando a varredura da projeção
inteira. Cobertura: `server/test/fase9-1-data-integrity.test.ts` (memória) e
`server/test/pg/fase9-1-data-integrity.test.ts` (PostgreSQL real — prova que a
leitura não trunca acima de uma página).

### 8.2 Integridade e retenção da caixa interna do CRM (Fase 9.2)

Migration **`0114_fase9_crm_notificacoes_hardening.sql`** (aditiva/idempotente):

| Endurecimento | Antes (0113) | Depois (0114) |
|---|---|---|
| Destinatário removido | `usuario_id` `ON DELETE CASCADE` **apagava** a trilha | `ON DELETE SET NULL` — o aviso sobrevive |
| Atividade de origem | FK **simples** aceitava atividade de outra empresa | FK **composta** `(empresa_id, atividade_id)` — mesmo tenant |
| Destinatário do tenant | sem checagem no app | `destinatarioDoTenant` (empresa padrão **ou** `usuario_empresas`) |

Na aplicação (`server/src/crmNotificacoes.ts`): a contagem de não lidas passou a
usar `countWhere` (sem teto de 500) e `marcarTodasLidas` pagina por **toda** a
caixa do usuário numa transação (o teto de 500 deixava o resto sem marcar);
marcar aviso exige caixa própria (ator sem id → 403, nunca "sem checagem").
A FK composta usa `NOT VALID` + `VALIDATE` (protege escrita nova e confere o
legado — linha cross-tenant faz a migração **falhar em voz alta**). Cobertura:
`server/test/fase9-2-crm-lifecycle.test.ts` (memória, 26 casos) e
`server/test/pg/fase9-2-crm-lifecycle.test.ts` (PG real: FK composta recusa
aviso cross-tenant; `SET NULL` preserva a trilha).

> `usuario_id` **não** recebe FK composta a `usuarios`: `usuarios` não tem
> `(empresa_id, id)` único e um usuário pode ter acesso a várias empresas
> (`usuario_empresas`) — a FK composta proibiria destinatário multiempresa
> legítimo. A garantia "destinatário pertence ao tenant" é da aplicação,
> coberta por teste.

### 8.3 Gate de moldura de página ampliado (Fase 9.3)

`client/src/test/page-shell.test.ts` ganhou duas provas estruturais novas (além
de "`PageHeader` exige `PageShell`"): (B) nenhuma página reimplementa a moldura
à mão (`<div className="… p-4 … sm:p-6 …">` como raiz de um `return`); (C)
nenhuma página entrega `<Spinner>` cru como estado de página inteira (o estado
canônico é `PageLoading`). Páginas fora do padrão foram convertidas para
`PageShell`/`PageLoading` (Impressão ×3, `ConectorPage`, `dev/ComponentCatalog`
e os `return <Spinner>` de página inteira). Suíte completa do cliente: **140
arquivos · 1195 casos · 0 fail**.

### 8.4 Evidência da revisão corretiva (executada nesta sessão)

| Verificação | Comando | Resultado |
|---|---|---|
| Typecheck | `npm run typecheck` | ✅ OK (domain + server + client) |
| Testes server | `npm --workspace server test` | ✅ **2382 pass · 0 fail · 93 skip** |
| Testes client | `npm --workspace client test` | ✅ **1195 pass · 0 fail** (140 arquivos) |
| Lint | `npm run lint` | ✅ **0 errors** (627 warnings — baseline) |
| Build | `npm run build` | ✅ OK (PWA gerada) |
| PostgreSQL real | `npm run test:pg` | ✅ **478 testes · 0 fail/skip/todo** |
| Migration 0114 | `test:pg` (banco novo) | ✅ `Migração aplicada: 0114_...`; FK composta e `SET NULL` no catálogo |
| Bootstrap | `node scripts/gerar-bootstrap.mjs` | ✅ sincronizado (sem alteração) |
| Inventário | `npm run architecture:audit` | ✅ OK |
| Auditoria de menu | `npm run audit:menu` | ✅ OK |

> O `test:pg` rodou contra `postgres:16.14` local (`brobond-pg`, porta 5433),
> em banco **vazio** (`brobond_gate`), conforme `AGENTS.md`.

---

*Ver também: [`MASTER-BACKLOG.md`](architecture/MASTER-BACKLOG.md),
[`CURRENT-STATE.md`](architecture/CURRENT-STATE.md),
[`ERP-3.0-GAP-MATRIX.md`](ERP-3.0-GAP-MATRIX.md).*
