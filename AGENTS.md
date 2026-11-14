# AGENTS.md — Brobond ERP

Monorepo: Next.js 15 / React 19 / TypeScript (client) + Node/Express/TS (server) + PostgreSQL + Redis. Multiempresa (empresa_id) e multi-loja (RETAIL/WHOLESALE).

## Comandos

- `npm run typecheck` — domínio + servidor + cliente.
- `npm --workspace server test` — suíte do servidor (`node --test`, sem banco).
- `npm --workspace client test` — suíte do cliente (vitest).
- `npm run lint` — ESLint (warnings pré-existentes são baseline; exigir 0 **errors**).
- `npm run architecture:audit` e `npm run audit:menu` — coerência recursos × tabelas × tenant × menu.
- `npm run test:pg` — gate PostgreSQL real; exige `DATABASE_URL` de banco **vazio** e PostgreSQL 16.14.

## CI (GitHub Actions)

- Os jobs `verificar` e `testes-postgres` rodam em **Node 24**. Não volte para o Node 22: o runner de `node --test` do v22.x lê o tamanho do quadro do protocolo como int32 COM SINAL; quando o stdout de um arquivo de teste traz texto NÃO-ASCII (acentos PT-BR + emoji do logger) logo após um quadro de relatório, esses bytes são interpretados como tamanho e o runner pai aborta com `Unable to deserialize cloned data due to invalid or unsupported version`, descartando o arquivo inteiro. É um bug do Node corrigido no v24 (#64706) e NÃO retroportado ao v22 (#65934). O sintoma é um `not ok` aleatório em qualquer arquivo, nunca no mesmo.
- `npm run architecture:audit` regenera `docs/ERP-3.0-ARCHITECTURE-INVENTORY.json`; quando o número de casos muda, o arquivo precisa ser commitado junto.

## Convenções

- **Ambiente de teste:** o shell pode ter `DATABASE_URL` exportado (ex.: `brobond_test`). Isso faz testes que deveriam pular rodarem contra banco sujo. Rode `unset DATABASE_URL` antes da suíte de memória.
- **Banco:** `db/schema.sql` (bootstrap estrutural) + `db/bootstrap.sql` (GERADO por `scripts/gerar-bootstrap.mjs`, testado por `prod-db-02-bootstrap-sync`) + `db/migrations/*.sql` (cadeia versionada, ordem léxica). Tabela nova entra em ambos: migração **e** espelho em `schema.sql`. Migrações são aditivas/idempotentes; nunca destrutivas.
- **Multiempresa:** recursos declaram `empresa: true`; escopo por `escopoDoAtor`. Tabelas com `empresa_id` sem recurso CRUD são aceitas quando o escopo é aplicado por endpoint próprio (padrão `gateway_*`, `payment_*`, `logistics_*`).
- **Outbox:** `commerce_outbox` é a fila única (claim CAS, backoff, dead-letter). Ações `logistics-*` são roteadas em `server/src/commerce/outbox.ts`.
- **Cron:** `server/src/scheduled.ts`, processos `relatorios|pagamentos|publicacoes|pedidos|crm`.
- **Integração WooCommerce:** registry multi-loja em `server/src/commerce/woocommerce/`. Pedido externo = `WOO-<LOJA>-<id>`.
- **Segredos:** nunca no código; cifrados (AES-256-GCM) em `configuracoes`. Toda variável de ambiente lida no código **precisa** de linha em `docs/auditoria/matriz-configuracao-producao.md` (teste `config-inventario-producao` trava isso), e toda chave do `render.yaml` também.

## Motor de logística (modules/logistics)

Desacoplado, reusa `ShippingProvider`/`envios`/`envio_eventos`/outbox/config cifrada.
Sem `LOGISTICS_ENABLED`, opera em modo seguro. Documentação: `docs/LOGISTICA-MOTOR-MULTICANAL.md`.
Transportadoras sem contrato nascem **desabilitadas** e nenhum endpoint é presumido.

## Rastreabilidade por lote (migration 0106)

- **Saldo do lote é DERIVADO** das movimentações (`saldoDoLoteMov`/`saldoDoLoteInsumo` em
  `server/src/rastreabilidade.ts`) — nunca uma coluna de saldo. Não criar uma segunda
  fonte de verdade de estoque.
- `lote_id` é **opcional** em `movimentacoes`, `movimentacoes_insumos`,
  `compra_recebimento_itens` e `devolucao_fornecedor_itens`; FK composta
  `(empresa_id, lote_id)` recusa lote de outra empresa.
- Um lote é de **um produto OU de um insumo** (nunca ambos/nenhum) — `CHECK` no banco e
  `validarLote` em `server/src/loteValidacao.ts`.
- A cadeia usa os vínculos FORMAIS já existentes (compra → recebimento → item →
  movimentação → expedição → envio) + `lote_id`; consulta em
  `/api/rastreabilidade/{painel,lotes/:id,lote-por-codigo,movimentacao/:id,produto/:id,documento}`.
- Recurso `lotes`: `ops.delete = false` (histórico aponta para o lote; desativa-se, não se exclui).

## Gate PostgreSQL local (sandbox)

Há um container `postgres:16.14` rodando (`sudo docker ps` → `brobond-pg`, porta 5433).
Para rodar `npm run test:pg` (exige banco **vazio** e PG 16.14):

```
sudo docker exec brobond-pg psql -U brobond -d postgres \
  -c "DROP DATABASE IF EXISTS brobond_gate WITH (FORCE);" -c "CREATE DATABASE brobond_gate;"
export DATABASE_URL="postgresql://brobond:brobond@127.0.0.1:5433/brobond_gate"
export ADMIN_PASSWORD="$(node -e "process.stdout.write('A!'+require('crypto').randomBytes(24).toString('hex'))")"
export JWT_SECRET="$(node -e "process.stdout.write(require('crypto').randomBytes(32).toString('hex'))")"
npm run test:pg
```

O script `test-pg-gate.mjs` recusa banco reutilizado (`relações públicas != 0`).

O teste de backup (`ops-saneamento-go-live`) chama `pg_dump`/`pg_restore` do PATH. O
cliente precisa ser da MESMA versão maior do servidor (16): um `pg_dump` 17 grava o GUC
`transaction_timeout` no dump e o `pg_restore` contra o 16.14 falha com
`unrecognized configuration parameter "transaction_timeout"`. Instale o cliente 16
(`postgresql-client-16` do PGDG) e aponte `pg_dump`/`pg_restore`/`psql` para ele via
`update-alternatives`. No CI o cliente vem da própria imagem `postgres:16.14`, então só
afeta o sandbox.

Num sandbox RECÉM-CRIADO o daemon Docker pode estar parado e o container `brobond-pg`
ausente. Suba o daemon (`sudo dockerd > /tmp/dockerd.log 2>&1 &`) e recrie o container:
`sudo docker run -d --name brobond-pg -e POSTGRES_USER=brobond -e POSTGRES_PASSWORD=brobond -p 5433:5432 postgres:16.14`.
O `postgresql-client-16` do PGDG depende de `sensible-utils` (só resolvido com o
`apt-get update` completo, que traz o repositório Debian principal).

## Carga da política comercial (migration 0117)

- O importador (`server/src/cargaPoliticaComercial.ts`) lê TODAS as abas de **cadastro**,
  não só a principal: `FONTES_CADASTRO` cobre "Política Comercial Completa" (canônica),
  "BASE CONTROLE DE ESTOQUE" (SKUs `1001P`…) e "Política Comercial Roupas (2)" (fornecedor).
  As abas de **movimentação** (entrada, saída, venda diária, situação de estoque) NUNCA viram
  produto/estoque — só entram na reconciliação (relatório).
- **Produto-pai × variação** — a família agrupa o produto; cor e tamanho são EIXOS:
  - `principal`: categoria + coleção + marca + descrição-base;
  - `controle_estoque`: categoria + descrição-base (cor = `SUBCATEGORIA`, que fica no
    MEIO da descrição — `descricaoSemCor` remove como palavra isolada);
  - `roupas`: o prefixo numérico do código (`93882-40` × `93882-42` = MESMO produto, dois
    tamanhos; `parseCodigoRoupas` separa `PRODUTO[-COR]-TAMANHO`). A **cor vem do CÓDIGO**
    (`94000-nude-gg`), não de coluna: ela alimenta `cor`/`variacao_chave` (`COR:…|TAM:…`).
    Sem isso duas cores do mesmo tamanho colidiam em `TAM:G` e a 2ª linha era REJEITADA —
    variações reais eram perdidas na carga (bug real, corrigido).
  Sem isso cada cor/tamanho virava um produto-pai independente (bug real: 415 produtos
  em vez de 75).
- `descricaoSemTamanho` remove o tamanho só como TOKEN no fim; remover "M" de "MARFIM"
  partia a família (`MARFI`).
- SKU do produto-pai trunca em 40 chars; famílias distintas ainda podem colidir (descrições
  que só diferem depois do corte). `desempatarSkusPai` aplica discriminador estável e reporta
  em `validacoes.skus_pai_colididos`. O `hashChave` usa os dígitos MENOS significativos do
  base36 (os de maior ordem não variam entre chaves vizinhas).
- Quantidade física NUNCA é importada (nem "Qtd. Estoque" das abas de controle): o saldo
  é lançado depois, por operação própria.
- Código de indústria repetido (`93845-42`, linhas 7 e 90 de "Roupas") é LINHA DUPLICADA
  (mesmo produto/tamanho/preço): a variação é idempotente por SKU e a segunda linha é
  ignorada — preservado e reportado em `validacoes.codigos_industria_repetidos`.

## Fases 6–8 (Commerce, CRM, BI/Control Tower)

- **Fase 6 — Omnichannel** (`commerce_reconciliacao`): reconciliação multicanal é LEITURA;
  nunca sobrescreve dado canônico do ERP com dado externo. Painel em `/commerce/omnichannel`.
- **Fase 7 — CRM/Marketing/Loyalty**: RFM em `/customer-segments/rfm` (quintis reais no
  servidor); saldo de fidelidade é SOMA dos movimentos (nunca campo editável); estorno/
  expiração idempotentes por origem; opt-out LGPD bloqueia envio sem consentimento.
- **Fase 8 — BI & AI Control Tower** (migration 0112): motor de alertas
  (`server/src/alerts.ts`) + Tower (`server/src/controlTower.ts`). Regras:
  - Alerta é IDEMPOTENTE por `fingerprint` UNIQUE `(empresa_id, fingerprint)`: reabre
    quando volta a existir, resolve quando deixa de ser detectado. Não empilhar ocorrências.
  - **Alertar não é agir**: nenhum detector altera preço, estoque, pagamento, pedido ou
    campanha. A correção recomendada é texto.
  - Detector lê SOMENTE documento canônico; sem dado → sem alerta (nunca zero enganoso).
  - Tower é camada de LEITURA: indicador carrega `definicao`/`formula`/`origem`/`limitacoes`;
    valor ausente é `null` + limitação declarada, nunca 0. `GET /api/control-tower/painel`.
  - `alert_events.ops.delete = false` (histórico). Notificação externa segue interna até
    homologação — a regra guarda o canal, mas o envio externo não é presumido.

## Fila do commerce — estados honestos (migration 0116)

- `commerce_outbox.estado` tem SETE valores, e a distinção é operacional, não cosmética:
  `ERRO` = falha técnica real (reprocessar após corrigir a causa); **`BLOQUEADO`** = o canal
  de comunicação não está configurado (SMTP/WhatsApp ausente — retry NÃO cria provedor);
  **`OBSOLETO`** = aviso sem efeito, encerrado com trilha. **Nunca** gravar falta de
  configuração como `ERRO`: isso mente no painel ("falha de sincronização" onde só falta uma chave).
- O desfecho `bloqueado` só sai quando **todas** as notificações do evento são
  `provider_status='NAO_CONFIGURADO'`; falha transitória real (provedor respondeu/recusou)
  domina e mantém `retry` com backoff. Regra pura `notificacaoSuperseded` em `regras.ts` é o
  oráculo independente da supersessão (pedido EXPIRADO/CANCELADO/ESTORNADO → aviso sem efeito).
- **Evento financeiro/estoque pendente NUNCA é encerrado pela reconciliação.** OBSOLETO é só
  para aviso de comunicação sem efeito; preserva histórico e é auditado (`motivo_encerramento`,
  `encerrado_em`, `encerrado_por`).
- Reconciliação operacional: `npm run commerce:reconciliar-fila` (`scripts/reconciliar-fila-commerce.ts`)
  é **dry-run por padrão**; escrita exige `--executar --confirm=RECONCILIAR-FILA` e PostgreSQL real.
  Endpoint `POST /api/commerce/outbox/reconciliar` (mesmo RBAC de `reprocessarOutbox`).
- **Migração que reexecuta SÓ PODE AMPLIAR um CHECK.** A 0099 reinstalava o CHECK antigo de 5
  estados e quebrava quando já havia linha `BLOQUEADO`/`OBSOLETO` (o gate PROD-DB-01 pega isso).
  Mesmo defeito que a 0094 documentou para `commerce_outbox_tipo_ck`. Ao adicionar estado novo,
  atualize o CHECK em `schema.sql`, na migração que o criou **e** em toda migração que o reinstala.

## Commerce Engine — precificação (migration 0118)

- **A planilha é FONTE DE CADASTRO e de preços OFICIAIS de ENTRADA; o ERP governa o
  cálculo.** O importador (`server/src/cargaPoliticaComercial.ts`) grava os preços
  "à vista/boleto/cartão" em `produto_precos_condicao` como DADO, nunca fórmula; a BASE
  do canal (`preco_atacado`/`preco_venda`) só é preenchida quando está ZERADA (nunca
  sobrescreve preço já definido). Estoque NÃO é importado.
- `server/src/commerce/motorPrecos.ts` **orquestra** os serviços canônicos
  (`listasPreco.precoDe`, `politicasComerciais`) — não duplica tabelas nem regras.
  Ordem de resolução: **preço OFICIAL por condição (FINAL) → lista vigente → base do
  canal**, e o desconto da política só incide onde é autorizado. Preço ausente é
  `null`, nunca chute; canal ATACADO sem `preco_atacado` NÃO cai para o varejo.
- **Cumulatividade é EXPLÍCITA (0119):** o preço da condição é FINAL por padrão. Um
  desconto adicional só incide com `politicas_comerciais.autoriza_cumulativo` OU uma
  regra de `politica_comercial_descontos_cumulativos` que case (escopo/canal/cliente/
  condição/prioridade/limite). Nada de "desconto sobre desconto" silencioso.
- **Preço por condição é VERSIONADO (0119):** `produto_precos_condicao` tem vigência
  (`vigencia_inicio`/`vigencia_fim`) e uma única linha vigente (`vigencia_fim IS NULL`)
  por (empresa, produto, canal, condição). Reimportar com valor diferente FECHA a
  vigência anterior (vira histórico) e abre a nova, registrando em
  `produto_precos_condicao_historico`; reimportar o mesmo valor não versiona (idempotência).
  A memória de preço é histórico: FK `produto_id`/`empresa_id` é RESTRICT (produto se
  desativa, não se exclui).
- `politica_preco_minimo.bloqueio_ativo` nasce **DESLIGADO**: sem bloqueio ligado, margem
  e desconto são apenas INFORMADOS; nenhum limite é inventado. `precificacao_memoria` é
  append-only (grava a origem do cálculo para auditoria).
- Ordem de declaração em `db/schema.sql` importa: `empresas` só nasce na linha ~1410,
  então tabela nova com `REFERENCES empresas(id)` precisa entrar DEPOIS dela (bloco
  Commerce Engine, ~2440) — senão o bootstrap aborta e a cadeia versionada inteira falha.
- O `regras` da memória é JSONB e precisa de campo `type: 'json'` no recurso, senão o
  memdb (e o PG) não serializam o objeto.
- Auditoria de recurso: todo recurso novo exige linha em `docs/architecture/RBAC-MATRIX.md`
  (o teste `rbac-matrix` trava a contagem e o cabeçalho "(N recursos)").

## Operational Control Plane + Remote MCP (migration 0121)

Núcleo de governança para o Diretor operar o ERP por MCP (ChatGPT) sem entregar
credencial ao agente e sem execução arbitrária. Módulo: `modules/operational-control/`
(domínio `server/src/` continua sendo a autoridade de RBAC).

- **Três identidades separadas, nunca confundidas:** usuário do ERP, cliente OAuth e
  GitHub App installation. O MCP NUNCA aceita `user_id`/`perfil`/`empresa_id`/`role` do
  corpo como prova — a identidade sai do token validado (`identidadeOperacional`).
- **Duas portas de identidade, roteadas pelo ALGORITMO do JWT:** o access token OAuth é
  RS256; a sessão do ERP é HS256. `ehTokenOAuth` lê só o cabeçalho para ROTEAR; a
  validação real é a assinatura em `validarAccessToken`. O router do Control Plane é
  montado ANTES do `requireAuth` global de `/api` justamente porque um Bearer OAuth não
  é sessão do ERP — não mova essa montagem para depois do guard.
- **OAuth 2.1 × JWT do ERP são mecanismos SEPARADOS** (issuer, audience e chave
  próprios). O `oauthRouter` é montado na RAIZ (`.well-known/*`, `/oauth/*`): o ChatGPT
  descobre os caminhos bem conhecidos. PKCE S256 é obrigatório; `redirect_uri` só passa
  por IGUALDADE EXATA (fecha open redirect); o código é de uso único (CAS em
  `consumed_at`); o refresh rotaciona (usar invalida o anterior).
- **Permissão efetiva = escopo OAuth ∩ perfil ∩ política ∩ empresa ∩ allowlist.** Ser
  `admin` NÃO dispensa o escopo: `exigirAutorizacao` exige os dois. Nenhum escopo de
  escrita genérica existe (`brobond:*:read|request|approve|audit`).
- **Repositório/arquivo/branch vêm do REGISTRO INTERNO** (`WORKFLOW_REGISTRY`), nunca do
  cliente. `neon-production-diagnostic` nasce `enabled: false` — só liga após homologação.
  Branch validada no servidor (`resolverRef`); `main` fica fora da allowlist.
- **Aprovação humana é de USO ÚNICO e vinculada ao hash dos parâmetros.** O agente MCP
  nunca aprova (`exigirAprovadorHumano` + `exigirConfirmacaoHumana`, que exige
  reautenticação recente da sessão). O dispatch consome a aprovação e trava a operação em
  `dispatching` sob CAS — duas instâncias nunca despacham a mesma operação.
- **Resultado desconhecido NUNCA é reenviado automaticamente.** Timeout após o envio deixa
  a operação em `dispatching` e a RECONCILIAÇÃO (`reconciliarEmpresa`) confirma pelo
  GitHub. Sem webhook, a reconciliação por consulta é o que impede operação parada.
- **`revogarToken` decodifica o JWT** para achar o `jti`: revogar o access token — o caso
  normal do RFC 7009 — só funciona assim. Aceita também o `jti` cru e o refresh (por hash).
- **Auditoria encadeada por operação** (`operational_audit_events`): SHA-256(hash_anterior
  | payload canônico). O PG devolve `occurred_at` como `Date`; `verificarCadeiaOperacao`
  normaliza para ISO antes de recomputar — sem isso `jsonCanonico` serializa `Date` como
  `{}` e a cadeia aparece quebrada no PG (na memória não, por isso o teste PG existe).
- **Tabelas novas em AMBOS:** migração `0121_operational_control_plane.sql` **e** espelho em
  `db/schema.sql`; `db/bootstrap.sql` é REGERADO (`scripts/gerar-bootstrap.mjs`). Recursos
  são INTERNOS (`internal: true`, `ops: READ_ONLY`): o CRUD genérico não os expõe — o
  acesso passa pelos handlers do módulo. `oauth_clients` é GLOBAL (sem `empresa_id`); as
  demais carregam `empresa_id`. Toda linha nova exige entrada em
  `docs/architecture/RBAC-MATRIX.md` (o teste `rbac-matrix` trava a contagem).
- **Segredos só em ambiente ou em `configuracoes` CIFRADOS** (AES-256-GCM). A chave privada
  da GitHub App e o webhook secret nunca entram no repositório, no frontend, no banco em
  texto aberto nem em log. GitHub App usa installation token temporário (≤1 h), nunca PAT.
- **Ferramentas MCP são uma lista FECHADA e específica** (`mcp/tools.ts`): status do
  sistema/banco, branches/commits/PRs, execuções (`brobond_workflow_runs`,
  `brobond_execution_status`), operações (`brobond_operations_list`,
  `brobond_operation_status`), `brobond_audit_history` e `brobond_request_diagnostic`.
  NÃO existe ferramenta genérica de shell/SQL/HTTP/filesystem/deploy/merge/push — o teste
  de lista fechada reprova qualquer uma. Repositório, arquivo e branch vêm do registro
  interno, nunca do cliente; `tools/list` é filtrado pela permissão efetiva.
- **Testes:** `server/test/operational-control.test.ts` (ciclo/autorização/dispatch com
  stub do GitHub), `server/test/operational-endurecimento.test.ts` (replay/concorrência/
  IDOR entre empresas), `server/test/operational-oauth.test.ts` (PKCE/uso único/refresh/
  revogação/CIMD), `server/test/operational-ssrf.test.ts` (SSRF no registro de cliente),
  `server/test/operational-schema-paridade.test.ts` (índices/CHECKs espelhados em
  `schema.sql`) e `server/test/pg-operational-control.test.ts` (migração aplica, tenant,
  unicidade de idempotência e cadeia no PG real).
- **Interface é PÁGINA (ZERO MODAL):** `/operacional` (lista, `OperacionalPage.tsx`) e
  `/operacional/:id` (detalhe/aprovação, `OperacionalDetalhePage.tsx`). O módulo está em
  `MODULES` (Administração → Automações) e em `PAGES_ESPECIAIS`/`MODULOS_PAGINA_PROPRIA`;
  a rota de detalhe é declarada à mão em `App.tsx` sob `AdminOnly`. Aprovar exige
  confirmação textual e reautenticação (`ReauthModal`) — o agente MCP não aprova. Não
  criar painel/modal para esse fluxo: o gate `audit:ux` reprova (`TETO_PAINEIS_INLINE` é
  imutável).
