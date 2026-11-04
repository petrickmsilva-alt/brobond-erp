# Fase 4.3 — Registro de execução (correções R-12, R-4, R-1, R-14, R-15, R-10, R-3 e auditoria transversal)

> Escopo e regras: ordem integral do Diretor (Fase 4.3). Execução **local**, no branch
> `arena/c0104925-brobond-erp`. **Sem push, PR, merge, deploy, alteração de Render, de `render.yaml`
> ou de variáveis de produção, envio real, operação financeira real, reativação de publicações
> ML/Nuvemshop, nem chamadas a provedores.** Nenhuma nova variável de ambiente foi criada.
> Este registro não declara go-live nem homologação externa.
>
> Histórico anterior (Fases 4.1 e 4.2) foi preservado. Este documento acrescenta a 4.3; não substitui
> `fase-4-2-correcoes.md`.

## A. Estado inicial

| Item | Valor |
|---|---|
| Branch | `arena/c0104925-brobond-erp` (fixo; não renomear) |
| HEAD inicial da 4.3 | `ad8123762fc2c5ca007cef4b563e2c7da80d34ed` (`main`) — a base da sessão |
| Remoto do branch | `34bc655a41e9aae645a211d7bd5cc8edf41ee95b` (Fase 4.2 remota) |
| Árvore inicial | Muitas modificações não commitadas (17 modificados, 17 não rastreados, sobre `34bc655`) |
| Backup pré-reset | `/home/user/backup-fase4-3/worktree-pre-4-3-20261104-111401.tar.gz` (+ `wt_files.txt`) |
| Ação de preservação | Commit de recuperação `3aef54a` (`wip(fase-4.2)`), montado por plumbing a partir do backup, sem tocar a árvore; `git reset --mixed` em `34bc655` antes, árvore preservada |
| Verificação inicial | `git archive` contra o remoto: 0 arquivos exclusivos do remoto; 17 com conteúdo diferente; 17 novos |

Relatórios 4.1 e 4.2 lidos: `docs/auditoria/fase-4-2-correcoes.md`, `docs/auditoria/gate-leitura-nuvemshop-2025-03.md`,
`docs/auditoria/auditoria-segregacao-alertas.md`, `docs/auditoria/matriz-configuracao-producao.md`,
`docs/auditoria/plano-homologacao-conectores.md`, `docs/auditoria/matriz-evidencias-conectores.md`,
`docs/operacao/runbook-incidentes-conectores.md`.

## B. Execução por risco

Cada correção seguiu RED → GREEN: o teste novo foi executado antes da implementação e falhou pelo
motivo esperado; depois da correção, passou. Os logs ficaram em `/tmp` (não versionados).

### R-12 — notificações operacionais segregadas; canal corporativo separado (commit `f1cf8b8`)
- **Risco:** distribuição global de avisos operacionais (alertas, falhas de entrega) por lista global
  (`NOTIFICAR_EMAILS`/`SCHEDULE_EMAILS`), sem vínculo com a empresa do registro.
- **Correção:** avisos operacionais (canal A) exigem empresa do registro; destinatários ativos e
  vinculados à empresa; sem destinatário vigente, nada é enviado. Canal B (corporativo, sem dados
  operacionais) em `server/src/notificacoesCorporativas.ts`, com finalidade fechada e restrito a admin vigente.
- **Arquivos:** `server/src/notifications.ts`, `server/src/notificacoesCorporativas.ts` (novo),
  `server/src/scheduled.ts`, `server/src/alertasFalhas.ts`, `server/test/notificacoes-segregacao.test.ts` (novo).
- **Testes:** RED 2/10 → GREEN 10/10 (negativos cross-tenant incluídos). Regressão alertas/segregação 20/20.

### R-4 — cron separado por processo (commit `0503f82`)
- **Risco:** um único `POST /api/admin/scheduled/cron` executava relatórios, pagamentos, publicações, CRM
  e recuperação de pedidos juntos; falha de um afetava os demais e não havia registro por processo.
- **Correção:** cinco processos independentes, cada um com rota, trava por instância e registro:

| Processo | Responsabilidade | Rota (`POST`, `Authorization: Bearer <CRON_SECRET>`) |
|---|---|---|
| `relatorios` | posição de estoque, vendas, alertas com falhas (escopo por empresa) | `/api/admin/scheduled/cron/relatorios` |
| `pagamentos` | sincronização de pagamentos (`runPaymentJobs`), expiração de checkouts, outbox `refund_devolucao` | `/api/admin/scheduled/cron/pagamentos` |
| `publicacoes` | fila de publicações (respeita suspensão ML/Nuvemshop) e outbox `publicacao` | `/api/admin/scheduled/cron/publicacoes` |
| `pedidos` | recuperação de pedidos de marketplace e outbox de conversão/notificação/alerta/sincronização | `/api/admin/scheduled/cron/pedidos` |
| `crm` | lembretes CRM (só com canal habilitado) | `/api/admin/scheduled/cron/crm` |

- **Regras:** `POST /api/admin/scheduled/cron` (sem sufixo) executa apenas `relatorios`. Processo
  desconhecido → 404. Sem `CRON_SECRET` → 503. Token inválido → 401. Execução concorrente na mesma
  instância → 409. Resposta sem erro bruto; log estruturado sem segredo nem payload.
  **Recorrências financeiras ficam fora do cron** (`POST /api/admin/financeiro/recorrencias`, com
  confirmação própria). Não há agendador interno.
- **Relatório de falhas** não dispara pagamento, publicação nem recuperação de pedidos (teste dedicado).
- **Arquivos:** `server/src/scheduled.ts`, `server/src/commerce/outbox.ts` (`TIPOS_OUTBOX_POR_PROCESSO`),
  `server/src/index.ts`, `server/test/cron-processos-independentes.test.ts` (novo),
  `server/test/cron-recorrencias-contrato.test.ts` (ajuste: o 401 é lido de `erro?.status ?? res.statusCode`).
- **Testes:** RED 10/10 → GREEN 10/10. Regressão cron/recorrências/outbox/d8/segregação 36/36;
  regressão publicações, CRM, outbox, notificações e catálogo 128/128.
- **Pendência de isolamento:** o envio do outbox (`commerce/notificacoes.ts`, ~517) usa `row.destinatario`
  gravado com `empresa_id` do pedido; a seleção filtra por `empresa_id`. Confirmado **por leitura de código**;
  falta teste de regressão cross-tenant específico do outbox.

**Mudança operacional (exige ação do Diretor):** o agendador externo (não há cron no `render.yaml`)
deve ter **um job por processo**. Se o job atual continuar chamando `POST /api/admin/scheduled/cron`,
apenas relatórios rodarão. Ver seção G.

### R-1 — autorização das rotas de marketplace (commit `d66afb9`)
- **Correções:** `GET /api/marketplace/status` só admin (403 para os demais; 401 sem sessão).
  `GET /api/marketplace/loja/status` admin e gerente (403 operador; gerente de outra empresa → 404).
  `?testar=1` não devolve erro bruto. `POST /api/marketplace/sincronizar` devolve só `sincronizados`
  (sem identificadores de pedido externos). Inventário garante que rotas `/api/marketplace` ficam depois de `requireAuth`.
- **Auditado sem alteração:** `/api/loja/*` (vitrine pública com rate limit), `/api/commerce/loja/estado`,
  `loja/produtos`, `loja/pedidos`, `loja/estoque`.
- **Arquivos:** `server/src/marketplace.ts`, `server/src/loja.ts`, `server/test/marketplace-autorizacao-rotas.test.ts` (novo).
- **Testes:** RED 4/6 → GREEN 11/11 (com `marketplace-legado-autorizacao.test.ts`).
- **Remanescente (separado):** `seller=seller_id` em `marketplace.ts` (literal que deveria ser o id do vendedor). Não corrigido nesta fase; registrado em G/E.

### R-14 — webhooks de saída associados à empresa (commit `99b9626`)
- **Risco confirmado por leitura:** `webhooks.disparar(evento, dados)` enviava qualquer evento a todo webhook
  ativo assinante, sem empresa. Eventos `usuario.*` contêm e-mail de usuário: vazamento entre tenants.
- **Decisões de desenho:**
  - Migração **`0097_webhooks_empresa.sql`** (necessária: sem coluna não há como associar). Aditiva:
    `webhooks.empresa_id` e `webhook_entregas.empresa_id` `INTEGER NULL REFERENCES empresas(id)`, índices.
    **Sem `NOT NULL`, sem default, sem backfill.** NULL = global/legado.
  - Empresa do evento = **contexto autenticado do ator** (`empresaDoContexto`, validado por `escopoDoAtor`).
    Nunca vem do corpo nem do payload. Sem empresa única (sem vínculo ou modo consolidado) → global, sem associação automática.
  - `alvosDoEvento(evento, empresa)`: evento de empresa → só webhooks da mesma empresa; evento sem empresa → só webhooks globais.
  - Entregas herdam `empresa_id` do webhook. Listagem, edição, exclusão, teste, entregas e reenvio são restritos
    à empresa do contexto; fora de escopo responde **404** (não revela existência). Webhooks e entregas globais/legados
    ficam ocultos a administradores de empresa.
  - `empresa: true` **não** foi usado nesses recursos: no store em memória aplicaria `DEFAULT 1`, e no Postgres
    filtros automáticos de tenant (inferência proibida). Campo `empresa_id` declarado como somente leitura.
- **Idempotência:** o resolvedor puro `webhookEmpresa.ts` (entrada, por provedor) e `chaveIdempotenciaEvento` já
  existiam (4.2); esta fase não alterou a ingestão de eventos de entrada.
- **Arquivos:** `db/migrations/0097_webhooks_empresa.sql` (novo), `server/src/webhooks.ts`,
  `server/src/usuariosAdmin.ts`, `server/src/services.ts`,
  `server/test/webhooks-empresa-isolamento.test.ts` (novo), `server/test/pg-webhooks-empresa.test.ts` (novo),
  `server/test/webhooks.test.ts` (fixture: administrador com empresa; disparos com empresa explícita).
- **Testes:** RED 9/9 → GREEN 11/11 (store em memória). PostgreSQL 16.14 real: 5/5 (schema/FK, reaplicação e
  rollback preservando legados, `PgStore` com filtro por empresa, listagem). Regressão webhooks, antiSSRF,
  usuários, auth e resolução de entrada 83/83.
- **Limitação:** a entrega HTTP real não é exercitada (sem rede). A gravação de `empresa_id` na entrega é
  coberta por teste de contrato estático.

#### R-14 — procedimento de associação posterior e rollback
- **Webhooks legados** (`empresa_id` NULL) **deixam de receber eventos de empresa** e não aparecem para
  administradores de empresa. Associação só por decisão operacional explícita: confirmar a empresa dona
  (fora do payload e da URL) e então atualizar `webhooks.empresa_id` por operação auditada. Não há automação.
- **Rollback (manual, documentado; não há script de descida na pasta de migrações):**
  1. Desativar os webhooks que dependem de escopo (`UPDATE webhooks SET ativo = false ...`) se necessário.
  2. `ALTER TABLE webhook_entregas DROP COLUMN IF EXISTS empresa_id;`
  3. `ALTER TABLE webhooks DROP COLUMN IF EXISTS empresa_id;`
  Os índices caem junto com as colunas. Nenhuma linha é apagada; o teste PG valida o rollback e a reaplicação.
  Após o rollback, a versão anterior volta a enviar eventos globalmente: **só reverter com decisão do Diretor.**

### R-15 — publicação Nuvemshop: gate de leitura (BLOQUEADO; sem alteração de código)
- **Estado:** a publicação continua **suspensa** por padrão (`PUBLICACAO_CANAIS_LIBERADOS`). Nenhuma publicação foi reativada.
- **Análise de autenticação (não resolvida):** `server/src/commerce/publicacaoNuvemshop.ts` usa `Authorization: Bearer`
  na base `2025-03`; a documentação v1 do conector (`modules/connectors/nuvemshop/nuvemshop.service.ts`) usa
  `Authentication: bearer` com `User-Agent`. Fontes de terceiros divergem. Não há cabeçalho confirmado pelo provedor.
- **Gate:** verificação de **nomes** de variáveis (sem valores): nenhuma variável de credencial Nuvemshop
  (`NUVEMSHOP_CLIENT_ID`, `NUVEMSHOP_CLIENT_SECRET`, etc.) está presente no ambiente. **Nenhuma leitura GET foi feita.**
  Nenhum POST/PATCH/PUT/DELETE. Nenhum cabeçalho de produção alterado.
- **Guarda local:** `server/test/nuvemshop-gate-leitura.test.ts` (5 testes) segue passando.
- **Bloqueio:** falta credencial de homologação de loja de teste em ambiente seguro. Procedimento e matriz de decisão:
  `docs/auditoria/gate-leitura-nuvemshop-2025-03.md` (seção de status 4.3).

### R-10 — PagBank: segredo dedicado de webhook (commit `fd8c64a`)
- **Estado herdado (4.2):** `${prefix}_WEBHOOK_SECRET` (`PAGBANK_WEBHOOK_SECRET`) é o nome do segredo; o verificador
  falha fechado sem ele; segredo igual ao access token é tratado como ausente.
- **Achado da 4.3 (bug real):** a rota pública `POST /api/gateway/webhooks/:provider` tinha um **fallback que usava o
  access token como segredo** quando a empresa não tinha segredo próprio. Resultado: notificação assinada com o token
  da conta era **aceita (200)** sem segredo dedicado. Teste RED: 200 em vez de 401.
- **Correção:** fallback removido (`server/src/gateway.ts`). Sem segredo próprio, a rota responde 401 antes de
  qualquer efeito (cobrança intocada, nenhum evento com assinatura aceita). Lint: `let` → `const` (incorporado ao commit).
- **Verificação do algoritmo:** a documentação pública do PagBank (resumida por fonte secundária, não confirmada no
  provedor) descreve `x-authenticity-token` = SHA-256 hex de `{token da conta}-{corpo cru}`. O código usa esse
  algoritmo. **Limitação:** a chave da verificação continua sendo o access token; o segredo dedicado funciona hoje como
  **gate de presença**, não como chave. Se o PagBank usar outro token de notificação, a verificação precisa ser revista
  (H-8). Detalhes em `docs/ADR-004-PAGBANK-SEGREDO-WEBHOOK-DEDICADO.md`.
- **Nome da variável:** o padrão `${prefix}_WEBHOOK_SECRET` vem da ordem do Diretor para o R-10 e já está em
  `configuration.ts`. Porém a regra permanente exige aprovação expressa para **criar** variáveis de ambiente, e a decisão (d)
  autoriza apenas `WHATSAPP_SECRET`. Nada foi criado nem alterado nesta fase. **Pendência de aprovação expressa** (seção G, G2).
- **Arquivos:** `server/src/gateway.ts`, `server/test/pagbank-webhook-rota-segredo.test.ts` (novo).
- **Testes:** RED 1/2 → GREEN 2/2 (rota real, supertest, store em memória, sem rede). Regressão pagamentos,
  gateway, PagBank, conectores, Nuvemshop e exposição de commerce: 164/164.
- **Sem:** acesso ao painel do PagBank, chamadas ao provedor, cobrança real.

### R-3 — PostgreSQL obrigatório em produção (revalidado; sem alteração de código)
- `bancoAusenteEmProducao`: produção sem `DATABASE_URL` → boot encerra (`assertProductionSecrets`), `getStore()` não cai em memória,
  `/api/health` responde 503 com `db: "ausente-em-producao"`. Corpo do health não expõe texto de erro. Testes existentes: 9/9.
- Gate PostgreSQL 16.14 (ver C) cobre migração e os testes PG.
- `render.yaml` inalterado.

### Auditoria transversal (item 9) — resultados
| Verificação | Resultado |
|---|---|
| Fallbacks de segredo (`\|\| 'valor'`) | `ADMIN_PASSWORD` tem padrão de desenvolvimento (`brobond123`). Em produção o boot é bloqueado sem senha forte (`security.ts`). **Remanescente baixo**: padrão existe no código. |
| `error.message` em resposta 401 | `connectors.ts` e `instagram.controller.ts` devolvem a mensagem de `WebhookSignatureError`, que é fixa e não contém dados. Aceito. |
| Logs com tokens | ML e Nuvemshop omitem o corpo em respostas 2xx. Rejeições (não 2xx) logam o corpo, que não contém credenciais em respostas de erro. Aceito; ver recomendação. |
| Rotas sem `requireAuth` | Lista revisada: login/MFA, convites (token), vitrine (rate limit), portal (token), arquivos (token ≥16 hex), agente de impressão (autenticação própria), cron (`CRON_SECRET`), gateway público (assinatura). Intencionais. |
| Arquivos por token (`/api/files/:id/:token`) | URL de capacidade com token aleatório e cache público de 1 ano. **Remanescente baixo**: anexos sensíveis exigiriam restrição por categoria. |
| Webhooks de entrada sem validação | ML, Meta/Instagram e gateway validam; PagBank fail-closed (R-10). Nuvemshop: validação de assinatura existente (4.2). |
| Escopo por empresa em webhooks de saída | Corrigido (R-14). |
| Outbox de notificações | **Corrigido.** Linha com `payload.empresa_id` de outra empresa agia sobre a empresa do payload (`{ empresa_id, ...payload }`). Agora a empresa da linha prevalece (`{ ...payload, empresa_id }`). RED 1/3 → GREEN 3/3 (`outbox-notificacoes-cross-tenant.test.ts`). |

**Fora do escopo desta fase (documentar e recomendar):** revisão RBAC de todas as ~400 rotas autenticadas; `seller=seller_id`
(marketplace); restrição por categoria dos arquivos; teste de entrega HTTP real de webhook de saída (H-11).

## C. Testes

Tipo de evidência: **local/unitário** (sem banco), **integração local** (PostgreSQL 16.14 real, banco novo),
**mock** (fetch/provedor simulado), **homologação externa** (não realizada).

| Conjunto | Resultado | Tipo |
|---|---|---|
| R-12 `notificacoes-segregacao` | 10/10 (RED 2/10) | local |
| R-4 `cron-processos-independentes` | 10/10 (RED 10/10) | local |
| R-4 regressões cron/outbox/d8/segregação | 36/36 | local |
| R-4 regressões publicações, CRM, outbox, notificações, catálogo | 128/128 | local |
| R-1 `marketplace-autorizacao-rotas` + legado | 11/11 (RED 4/6) | local |
| R-14 `webhooks-empresa-isolamento` | 11/11 (RED 9/9) | local (store em memória) |
| R-14 `pg-webhooks-empresa` | 5/5 | **integração local, PostgreSQL 16.14** |
| R-14/usuários: webhooks, antiSSRF, usuarios, auth | 83/83 | local |
| Outbox cross-tenant `outbox-notificacoes-cross-tenant` | 3/3 (RED 1/3) | local (store em memória) |
| Regressão notificações, outbox, status e segregação (16 arquivos) | 132/132 | local |
| R-10 `pagbank-webhook-rota-segredo` | 2/2 (RED 1/2) | local (rota real, sem rede) |
| R-10 pagamentos, gateway, PagBank, conectores, Nuvemshop, commerce | 164/164 | local/mock |
| R-3 `banco-obrigatorio-producao` + inventário | 9/9 | local |
| R-15 `nuvemshop-gate-leitura` | 5/5 (guarda local) | local |
| **Suíte completa do servidor (memória), execução final** | **1915 total; 1834 aprovados; 0 reprovados; 81 ignorados; EXIT 0** (1912 na execução anterior; +3 = testes do outbox) | local |
| Typecheck servidor (`tsc --noEmit`) | EXIT 0 | local |
| Typecheck cliente (`npm --workspace client run typecheck`) | EXIT 0 | local |
| Typecheck domínio (`npm run typecheck:domain`) | EXIT 0 | local |
| Lint (eslint, arquivos alterados da 4.3) | 0 erros; 48 avisos (estilo, pré-existentes em sua maioria) | local |
| Build do cliente (`npm run build`) | EXIT 0 | local |

**Os 81 ignorados da suíte em memória:** 76 testes `pg` exigem `DATABASE_URL` (job `testes-postgres` do CI); 5 são os
de `pg-webhooks-empresa` (também `DATABASE_URL`). Estão cobertos pelo gate PG abaixo.

**Instabilidade observada (não ocultada):** na primeira execução completa, `commerce-pix-real-flow.test.ts` falhou com
`Unable to deserialize cloned data` (erro de IPC do runner, não uma asserção). Isolado: 18/18. Nas duas execuções completas
seguintes: aprovado (1912 e 1915 testes). **Causa não determinada**; ocorreu uma vez em três execuções completas.

**Classificação do teste PIX (`commerce-pix-real-flow`):** o nome diz "contrato real, sem simulação", mas o arquivo **substitui
`globalThis.fetch` por uma simulação** (`fetchSimulado`). É teste com **mock do provedor**. Não comprova comunicação com o
Mercado Pago. A integração real depende de homologação externa (não realizada).

### Gate PostgreSQL 16.14 (`scripts/test-pg-gate.mjs`, banco novo)
- Execução 1 (banco `erp_gate_*`): 422 testes; 406 aprovados; **3 reprovados**; 13 ignorados.
  - `SEC-03/P1-02` (`sec03-admin-routes-authorization`): esperava que sessão de admin executasse `POST /admin/scheduled/cron`
    (200). O contrato do R-4 (Fase 4.2, já presente em `3aef54a`) aceita **somente** `Bearer CRON_SECRET`. Teste desatualizado.
  - `COMMERCE E2E` (`commerce-e2e`): esperava que o canal ML chegasse a `ERROR` por uma tentativa externa. O canal ML/Nuvemshop
    está **suspenso por padrão** (P0-01). Teste desatualizado; a tentativa só existia por falta de egress.
  - `PG marketplace` (`enterprise-wave3-commerce`): esperava `falhou`; o canal ML suspenso devolve `ignorada`. Teste desatualizado.
  - **Correção:** os três testes foram atualizados para o contrato vigente (suspensão e CRON_SECRET), sem mudar o comportamento
    de produção. O teste de marketplace libera o canal **somente dentro do teste**, com `fetch` mockado, e restaura a variável.
  - Nota: esses testes PG não tinham sido executados na Fase 4.2 (a suíte 4.2 os marcou como ignorados por falta de `DATABASE_URL`).
- Execução 2 (banco novo): 422 testes; 408 aprovados; **1 reprovado**; 13 ignorados. Reprovação: SEC-03, segunda asserção
    (`POST /admin/financeiro/recorrencias` sem confirmação respondeu 400 "Confirmação explícita ausente", que é o comportamento
    correto). O teste foi ajustado para aceitar 400 com essa mensagem, **sem** enviar confirmação. SEC-03 isolado: 2/2.
- Execução 3 (banco novo `erp_gate3_*`, PostgreSQL 16.14, após os ajustes de teste e a correção do outbox):
  **423 testes; 410 aprovados; 0 reprovados; 13 ignorados; 0 cancelados.** O próprio script registrou
  `ERP-03 GATE BLOCKED` e saiu com código 1, porque há 13 ignorados críticos (`psql`). **Portanto, o gate NÃO está aprovado
  pela sua própria política**, apesar de zero falhas. O total difere do da execução 2 (422): a diferença de um teste
  não foi investigada e fica registrada.
  - Evidência: `/tmp/pggate-4-3.log` (fora do repositório).
- **Ignorados PG (13):** testes do wrapper `psql` (`PROD-DB-01.5.x`, `PROD-CONSOLIDAR-LOCAIS-E1`). **Não executados localmente**:
  o binário `psql` não está disponível no sandbox (o pacote PostgreSQL embarcado não o inclui e não há instalação pela rede
  liberada). Dependem do job de CI, que instala o `psql`.

## D. Commits (branch `arena/c0104925-brobond-erp`, locais, não enviados)

| Hash | Mensagem | Conteúdo |
|---|---|---|
| `3aef54a` | wip(fase-4.2): recuperação do trabalho pré-existente das Fases 4.1 e 4.2 | Preservação do trabalho anterior (35 arquivos) |
| `f1cf8b8` | fix(notificacoes): R-12 | Notificações operacionais por empresa; canal corporativo; teste |
| `0503f82` | fix(cron): R-4 | Cinco processos independentes; rota por processo; outbox por tipo; teste |
| `d66afb9` | fix(marketplace): R-1 | Autorização das rotas de marketplace; teste |
| `99b9626` | fix(webhooks): R-14 | Migração 0097; escopo por empresa; testes em memória e PostgreSQL |
| `fd8c64a` | fix(pagamentos): R-10 | Remoção do fallback do access token; teste de rota |
| `175237e` | test(pg): contratos PG desatualizados | SEC-03, commerce-e2e, marketplace PG (ver C) |
| `81cfbbe` | fix(outbox): R-transversal — empresa da linha prevalece sobre o payload | `outbox.ts` (2 pontos) e teste de regressão cross-tenant |
| (este commit) | docs(fase-4.3): registro, ADRs e matrizes | Registro, ADR-002/003/004 e matrizes (acréscimo, sem apagar histórico) |

Hashes de commits anteriores à 4.3 (ex.: `34bc655`, `a2c3032`) são os do clone atual; commits de fases antigas citados em
histórico podem não existir neste clone.

## E. Segurança

**Corrigidas nesta fase:**
- Webhooks de saída com vazamento entre empresas (R-14): eventos de empresa só para webhooks da própria empresa.
- Access token usado como segredo de webhook PagBank (R-10): notificação forjada com o token era aceita.
- Notificações operacionais com lista global (R-12).
- Rotas `GET /api/marketplace/status` e `loja/status` sem restrição administrativa (R-1).
- Cron executando todos os processos num único disparo, sem isolamento de falha (R-4).
- Linha do outbox de notificações podia agir sobre outra empresa por meio de `payload.empresa_id` (corrigido: a empresa da linha prevalece).

**Remanescentes (registrados, não corrigidos nesta fase):**
- `ADMIN_PASSWORD` com padrão de desenvolvimento no código (bloqueado em produção pelo boot).
- Arquivos por token com cache público (`/api/files`): restrição por categoria recomendada.
- `seller=seller_id` em `marketplace.ts`.
- Verificação PagBank: dúvida sobre o token usado como chave (ver R-10 e G).
- Instabilidade do runner observada uma vez (ver C).

**Não resolvidas (dependem de dados externos):**
- Cabeçalho de autenticação da Nuvemshop 2025-03 (R-15).
- Confirmação do algoritmo de assinatura do PagBank com notificação real.
- Associação dos webhooks legados a empresas (R-14).

## F. Homologação

| Nível | Situação |
|---|---|
| Unitário / local | Executado (ver C). |
| Integração local (PostgreSQL 16.14 real) | Gate executado em banco novo (ver C). |
| Mock | Usado em testes de conectores e de fetch; **não é prova de homologação externa**. |
| Sandbox de provedor | **Não realizado.** Sem credenciais de homologação em ambiente seguro. |
| Provedor real / produção | **Não realizado.** Sem acesso a Render, Meta, Nuvemshop, PagBank, Mercado Livre. |

**Dependências externas (registradas, não bloqueiam a revisão local):**
- Nuvemshop: credencial de loja de teste (ausente) → gate R-15 bloqueado.
- PagBank: notificação real assinada em sandbox para confirmar o algoritmo; decisão sobre o nome da variável (G).
- Mercado Livre / Nuvemshop: publicações permanecem suspensas (decisão f).
- Agendador de produção: reconfiguração para cinco jobs (G).
- Ambiente: `psql` para os 13 testes do wrapper (CI).

Nenhum conector foi marcado como homologado. Nenhuma evidência de homologação externa foi criada.

## G. Pendências do Diretor

1. **Agendador de produção (cinco jobs).** Motivo: o cron agora é separado por processo e o agendador é externo.
   Consequência: se o job atual continuar chamando `POST /api/admin/scheduled/cron`, só os relatórios rodam; pagamentos,
   publicações, CRM e recuperação de pedidos param. Opções: (a) configurar cinco jobs (recomendado; matriz em
   `matriz-configuracao-producao.md` §13.1); (b) manter um job agregado temporário com decisão expressa, sabendo que
   a independência de falha fica reduzida.
2. **Nome da variável do segredo PagBank (`PAGBANK_WEBHOOK_SECRET`).** Motivo: a regra vigente autoriza apenas
   `WHATSAPP_SECRET` como nova variável. Consequência: sem aprovação, o PagBank não aceita notificação em produção
   (falha fechada), o que é seguro, mas bloqueia o recebimento de pagamentos por webhook. Não criei nem alterei variável.
3. **Webhooks legados sem empresa (R-14).** Motivo: não há vínculo histórico confiável. Consequência: eles deixam de
   receber eventos de empresa até associação manual. Decisão necessária: quem confirma cada empresa dona e em que prazo.
4. **Confirmação do algoritmo PagBank.** Motivo: o token usado como chave (conta vs. notificação) não foi confirmado
   no provedor. Consequência: sem notificação real em sandbox, a verificação não é homologada.
5. **Publicações ML/Nuvemshop (decisão f).** Permanecem suspensas. Reativação exige homologação e reconciliação e é decisão do Diretor.
6. **Credencial de homologação Nuvemshop (R-15).** Motivo: sem ela, o gate não avança. Decisão: disponibilizar credencial
   de loja de teste em ambiente seguro, ou aceitar o bloqueio.
7. **Go-live.** Não declarado. Decisão do Diretor.

## H. Situação final

- **Pronto para revisão local:** sim, para as correções R-12, R-4, R-1, R-14, R-10 e R-3 (revalidado), com testes locais e
  integração PostgreSQL executados.
- **Concluído:** R-12, R-4, R-1, R-14, R-10 (código), R-3 (revalidação), auditoria transversal, incluindo a correção do outbox cross-tenant.
- **Bloqueado por dependência externa:** R-15 (credencial de homologação ausente). Homologação externa de todos os conectores: não realizada.
- **Não pronto para produção:** depende das pendências G1–G7 (seção G) e de homologação externa.
- **Não enviado:** nenhum push, PR, merge ou deploy foi feito. Os commits estão somente no ambiente local.

## I. Ordem Executiva Master — consolidação (itens 1–19)

Execução local, no branch `arena/c0104925-brobond-erp`. Nenhum push, PR, merge, deploy, alteração em Render ou `render.yaml`, publicação na main, reativação de publicação, pagamento real ou segredo exibido.

### I.1 Mapa dos itens

| # | Item | Situação | Evidência local | Pendência externa |
|---|---|---|---|---|
| 1 | Preservação do repositório | Concluído: histórico preservado, sem reescrita, sem recriar o clone | `git log` com os commits anteriores intactos | — |
| 2 | Isolamento de notificações (R-12, outbox, alertas) | Concluído | `outbox-notificacoes-cross-tenant` 3/3; `notificacoes-segregacao` | SMTP real não testável |
| 3 | R-4, cinco contratos independentes | Concluído (código e teste). **Não agendado.** | `cron-processos-independentes`, `cron-recorrencias-contrato`, SEC-03 (PG) | G1: frequência, timeout e agendador |
| 4 | R-1, rotas de marketplace | Concluído, inclusive `seller=seller_id` | 14/14 marketplace | Credencial ML para prova real |
| 5 | R-14 e reconciliação de webhooks legados | Reconciliação **implementada** (dry-run padrão, confirmação, auditoria, rollback). **Não executada em produção.** | `webhook-reconciliacao-legados` 11/11; `procedimento-reconciliacao-webhooks.md` | G3: backup e execução |
| 6 | R-10, contrato PagBank | Concluído: algoritmo oficial confirmado por documentação; testes de corpo alterado, reformatado, token errado, malformada, segredo ausente. **Replay:** o contrato não define janela; a proteção é idempotência por `evento_id`. | `pagbank-webhook-contrato-oficial` 10/10 (+9 e 2) | H-8: homologação funcional |
| 7 | `PAGBANK_WEBHOOK_SECRET` | Preparado (verificação sem valores). **Não criado.** | `matriz-configuracao-producao.md` §14.2 | G2 |
| 8 | Nuvemshop 2025-03 | Código alinhado à documentação oficial do 2025-03. **Sem escrita, sem reativação, sem GET à loja.** | `nuvemshop-contratos-homologacao`; `gate-leitura-nuvemshop-2025-03.md` §7 | G6: credencial de loja de teste |
| 9 | Mercado Livre | Atualização, reuso de `external_id`, busca por SKU e idempotência: já cobertos (`publicacao-canais-p0`). Relatório de reconciliação **novo**, somente leitura. Publicação suspensa. | `mercadolivre-reconciliacao-relatorio` 8/8; `publicacao-canais-p0` | G5 e credencial ML |
| 10 | Gate PostgreSQL 16.14 com `psql` | **Aprovado:** 428 testes, 0 falhas, 0 ignorados, 0 pendentes. Investigação 422/423 resolvida (ver I.3). | `/tmp/pggate-4-4.log` (EXIT 0) | — |
| 11 | PIX mock × sandbox; instabilidade IPC | Separado: arquivo renomeado para `commerce-pix-mock-flow` (MOCK). Sandbox **não configurado** no projeto. IPC **não reproduzida** em 6 execuções (1 da suíte + 5 isoladas, 18/18 cada). | `commerce-pix-mock-flow` 18/18; loop IPC 5/5 | Credencial de sandbox |
| 12 | Arquivos privados | Concluído: URL assinada com expiração (TTL 900 s), HMAC, comparação em tempo constante, 404 uniforme, `private, no-store`; público mantém cache longo só para catálogo. RED 9/14 → GREEN 14/14. | `arquivos-politica-privados` 14/14; `sec01-anexos-tenant` no gate | — |
| 13 | `ADMIN_PASSWORD`, `seller_id`, logs | Concluído: sem padrão em produção, comparação em tempo constante; `seller` real; logs OAuth sem corpo bruto. | `admin-senha-producao` 5/5; `logs-oauth-sem-corpo` 3/3 | — |
| 14 | Homologação por conector | Documentada com níveis separados (código, teste, sandbox, operação). **Nada declarado como homologado.** | `matriz-evidencias-conectores.md` (atualização 4.3) | G4, G6, G7 |
| 15 | Cinco jobs | Documentados: URL, método, auth, códigos, lacunas declaradas (frequência e timeout não definidos; sem retentativa automática). | `docs/operacao/cinco-jobs-cron.md` | G1 |
| 16 | Documentação consolidada | Concluído por acréscimo | Este registro; `matriz-configuracao-producao.md` §14; ADR-004 §5 | — |
| 17 | Testes finais | Concluído (ver I.2) | — | — |
| 18 | Commits por grupo | Concluído (ver I.4) | `git log` | — |
| 19 | Relatório final | Entregue no chat, com os 15 itens | — | — |

### I.2 Testes finais (medidos nesta execução)

| Suíte | Resultado |
|---|---|
| Servidor (`npm --workspace server test`) | 1969 testes: **1888 pass, 0 fail, 81 skip** (os 81 são PG, "requer DATABASE_URL"; cobertos pelo gate PG) — EXIT 0 |
| Gate PG 16.14 (`npm run test:pg`, banco novo) | **428 pass, 0 fail, 0 skip, 0 todo, 0 cancelled** — `ERP-03 GATE PASS` — EXIT 0 |
| Wrapper psql (7 arquivos, banco novo) | 20/20 — EXIT 0 |
| Cliente (`npm --workspace client test`) | 133 arquivos, **1151 testes pass** — EXIT 0 |
| Typecheck (`npm run typecheck`) | EXIT 0 |
| Lint (arquivos alterados) | **0 erros**, avisos pré-existentes |
| Build (`npm run build`) | EXIT 0 |
| Migrações | Executadas pelo gate PG (428/428), inclusive `0097_webhooks_empresa.sql`, em banco novo |

Cobertura por área pedida (item 17): multiempresa, RBAC, pagamentos, webhooks, outbox, cron, arquivos privados e idempotência estão nos testes listados acima e no gate PG.

### I.3 Investigação 422/423 (item 10)

A diferença entre as execuções antigas (422 e 423 testes) era o subteste `evidência SEC-03`, que só executa se o teste pai passa inteiro, e os 13 testes ignorados por `psql` ausente. Com `psql` 16.2 disponível (cliente de terceiros, via pacote `pgserver`, usado só para testes locais) e banco novo, o gate roda 428 testes sem ignorados. Não houve redução de cobertura.

### I.4 Commits desta execução

Ver `git log` no branch. Organização por grupo: arquivos privados; senha do administrador; reconciliação de webhooks; contrato PagBank e ADR-004; marketplace (`seller`) e reconciliação ML; Nuvemshop (contrato, logs OAuth, gate); PIX mock (renomeação); documentação dos cinco jobs e consolidação.

### I.5 Riscos residuais

- **Frequência e timeout dos cinco jobs** não definidos (G1).
- **Reconciliação de webhooks** não executada em produção (G3).
- **Homologação funcional PagBank (H-8)** sem evidência real.
- **Nuvemshop v1:** o cabeçalho `Authentication: bearer` do conector v1 só aparece em perfil de terceiro; não alterado (escopo separado).
- **Rota legada de marketplace** (`POST /api/marketplace/sincronizar`) usa o token estático da instalação, que não pertence a uma empresa específica. A rota só registra a contagem na auditoria da empresa do ator e não grava pedidos. Os identificadores externos ficam fora da resposta. Se a rota vier a gravar pedidos, a origem do token precisará de decisão do Diretor.
- **Ambiente:** `NODE_ENV` precisa ser `production` no deploy, senão o padrão de desenvolvimento vale para `ADMIN_PASSWORD` e `JWT_SECRET`.
