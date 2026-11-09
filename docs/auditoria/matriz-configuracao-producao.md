# Matriz de configuração de produção — conectores BroBond ERP

Escopo: auditoria **somente leitura** do código (`server/src`, `modules/`, `render.yaml`, `server/.env.example`). Nenhum valor de variável foi lido, impresso ou exportado. Os nomes foram extraídos do código-fonte, não presumidos. Esta matriz não consultou o painel do Render: quem está configurado em produção é **não verificado**.

Legenda de **Obrigatória**:
- **Sim**: sem ela, o recurso não funciona ou o processo recusa subir.
- **Condicional**: obrigatória só para um uso específico (indicado).
- **Não**: opcional, com padrão no código.

Legenda de **Render**: `declarada` = aparece em `render.yaml`; `generateValue` = gerada pelo Render; `sync:false` = valor fica só no painel; `ausente` = não está no blueprint.

Versão auditada: branch `arena/c0104925-brobond-erp`, commit `34bc655` (+ docs posteriores).

---

## 1. Núcleo da aplicação e banco

| Variável | Conector/área | Arquivo:linha | Obrigatória | Quando ausente | Ambiente | Dependências | Render |
|---|---|---|---|---|---|---|---|
| `NODE_ENV` | Todos | vários (28 usos; ex.: `server/src/security.ts`) | Sim em produção | Trata como desenvolvimento: CORS aberto (`true`), JWT com literal de desenvolvimento | produção | Altera CORS, segredos e cookies | declarada (`production`) |
| `PORT` | Servidor | `server/src/index.ts:1476` | Não | Padrão `3001` | Todos | Usada na URL de desenvolvimento (`urlPublica.ts:156`) | declarada (`10000`) |
| `DATABASE_URL` | Banco | `server/src/db.ts:28`, `services.ts` (`getStore`) | **Sim em produção** | **Usa `MemStore` (memória), com aviso no log.** Não há trava que recuse subir em produção | produção | `PGSSL`, `PG_*` | declarada (ver nota R-3) |
| `PGSSL` | Banco | `server/src/db.ts:75` | Não | SSL ativo se `NODE_ENV=production` ou `PGSSL=true` (desligável com `PGSSL=false` ou `sslmode=disable`) | Todos | Com `DATABASE_URL` | ausente |
| `PG_POOL_MAX`, `PG_IDLE_TIMEOUT`, `PG_CONNECT_TIMEOUT` | Banco | `server/src/db.ts` | Não | Padrões do código (`PG_CONNECT_TIMEOUT` = `10000` ms) | Todos | — | ausente |
| `PG_STARTUP_TIMEOUT_MS`, `PG_STARTUP_RETRY_BASE_MS`, `PG_STARTUP_RETRY_MAX_MS`, `PG_STARTUP_MAX_ATTEMPTS` | Banco | `server/src/db.ts` | Não | Padrões: `60000` ms total, `500` ms base, `8000` ms teto, `20` tentativas | Todos | Com `DATABASE_URL` | ausente |
| `TRUST_PROXY` | HTTP | `server/src/security.ts:38` | Condicional (atrás de proxy) | Sem confiança em proxy | produção | IP real para rate limit | declarada (`"1"`) |
| `CORS_ORIGINS` | HTTP e WebSocket | `server/src/security.ts:69` (HTTP); `server/src/websocket.ts:27` (WS) | Condicional | HTTP: produção bloqueia origens externas (`[]`). **WS: reflete qualquer origem com `credentials: true`** (ver R-6) | produção | — | ausente |
| `CLIENT_DIST_DIR` | Front | `server/src/commerce/storefront-seo.ts:76` | Não | Usa `client/dist` relativo | Todos | — | ausente |
| `npm_package_version` | Observabilidade | `server/src/log.ts:47`, `server/src/index.ts:425` | Não (automática do npm) | — | Todos | — | — |

## 2. URLs públicas e URLs internas

| Variável | Conector/área | Arquivo:linha | Obrigatória | Quando ausente | Ambiente | Dependências | Render |
|---|---|---|---|---|---|---|---|
| `APP_URL` | Links de convite, OAuth, webhooks | `server/src/urlPublica.ts:274,332,366,424`; `server/src/commerce/notificacoes.ts:244`; `modules/connectors/core/connector.service.ts:493` | **Sim para OAuth em produção** (ver abaixo) | Origem vem do banco (Configurações › Sistema) ou da requisição. Em produção, OAuth exige `*_REDIRECT_URI` ou `APP_URL` em HTTPS público | produção | `APP_URL_PERMITIR_INTERNA`, `APP_URL_CACHE_MS` | declarada |
| `PUBLIC_BASE_URL` | Notificações | `server/src/commerce/notificacoes.ts:244` | Não | Fallback de `APP_URL` | Todos | Alias | ausente |
| `APP_URL_PERMITIR_INTERNA` | Links | `server/src/urlPublica.ts:86,390` | Não (padrão desligado) | Filtro de origem interna ativo | Todos | Quando `true`, desliga o filtro e aceita endereços internos | ausente |
| `APP_URL_CACHE_MS` | Links | `server/src/urlPublica.ts:193` | Não | 60 000 ms | Todos | — | ausente |
| `DEV_FRONT_PORT` | Desenvolvimento | `server/src/urlPublica.ts:37` | Não | 5173 | Desenvolvimento | — | ausente |
| `GATEWAY_MP_API_BASE_URL` | Mercado Pago (legado) | `modules/payments/providers/mercado-pago/legacy.ts:18` | Não | `https://api.mercadopago.com` | Todos | **Recebe o access token em cada chamada: override indevido vaza o token** (R-7) | ausente |
| `MERCADOLIVRE_API_BASE_URL`, `MERCADOLIVRE_AUTH_BASE_URL` | Mercado Livre | `modules/connectors/mercadolivre/mercadolivre.service.ts:54-55` | Não | Padrões `api.mercadolibre.com` | Todos | Recebe o client secret no OAuth | ausente |
| `MERCADOPAGO_API_BASE_URL` | Mercado Pago | `modules/connectors/mercadopago/mercadopago.service.ts:21-22` | Não | Padrão `api.mercadopago.com` | Todos | Mesmo risco de R-7 | ausente |
| `NUVEMSHOP_API_BASE_URL` | Nuvemshop (leituras v1) | `modules/connectors/nuvemshop/nuvemshop.service.ts:87` | Não | `https://api.nuvemshop.com.br/v1` | Todos | **Não afeta a publicação 2025-03** (base fixa em `publicacaoNuvemshop.ts:24`) | ausente |
| `NUVEMSHOP_AUTH_BASE_URL` | Nuvemshop | `nuvemshop.service.ts:88` | Não | Padrão do código | Todos | Recebe o client secret | ausente |
| `INSTAGRAM_GRAPH_BASE_URL`, `INSTAGRAM_AUTH_BASE_URL` | Instagram | `modules/connectors/instagram/instagram.service.ts:138-139` | Não | `graph.facebook.com` e `www.facebook.com` | Todos | Recebe App Secret | ausente |
| `WOOCOMMERCE_URL` | WooCommerce | `server/src/loja.ts:42,82`; `server/src/catalogos.ts:700` | Condicional (loja) | Integração desligada | Todos | Base de `CATALOGO_EMBED_ORIGENS` | ausente |

## 3. Autenticação e administração

| Variável | Arquivo:linha | Obrigatória | Quando ausente | Dependências | Render |
|---|---|---|---|---|---|
| `JWT_SECRET` | `server/src/auth.ts:23`, `server/src/chavesCifra.ts:53,80`, `server/src/security.ts:52` | **Sim em produção** | Produção: `process.exit(1)` se ausente, curto (<24) ou o literal de desenvolvimento. Fora de produção, sem variável: segredo **efêmero do processo** (nunca o literal `brobond-dev-secret`) | Base da derivação legada das chaves de cifra. **Trocar invalida cifras derivadas** | `generateValue` |
| `JWT_TTL` | `server/src/auth.ts:26` | Não | `8h` | — | ausente |
| `ADMIN_EMAIL` | `server/src/auth.ts:27` | Não | `admin@brobond.com.br` | Bootstrap do administrador | declarada |
| `ADMIN_PASSWORD` | `server/src/auth.ts:28`, `server/src/security.ts:57` | **Sim em produção** | Produção: `process.exit(1)` se ausente, <8 caracteres ou igual ao valor padrão de desenvolvimento. Desenvolvimento: usa um valor padrão **literal no código** (R-8) | `ADMIN_FORCE_PASSWORD` | declarada (`sync:false`) |
| `ADMIN_FORCE_PASSWORD` | `server/src/auth.ts:214` | Não | Não redefine a senha | `'true'` redefine a senha do admin **a cada boot** | declarada (`"false"`) |
| `RESET_TTL_MINUTES`, `REAUTH_TTL_MS`, `INVITE_TTL_HOURS` | `auth.ts:29-30`, `usuariosAdmin.ts:31` | Não | 60 min; 5 min; padrão do código | — | ausente |
| `LOGIN_MAX_ATTEMPTS`, `LOGIN_WINDOW_MS`, `USER_LOCK_MAX_ATTEMPTS`, `USER_LOCK_MINUTES` | `server/src/security.ts:174-175`, `server/src/auth.ts:33-34` | Não | Padrões de limite e bloqueio | — | ausente |
| `ARGON2_MEMORY_KIB`, `ARGON2_TIME_COST`, `ARGON2_PARALLELISM` | `server/src/password.ts:18-20` | Não | Padrões do código | Alterar exige recalcular hashes? **Não verificado** | ausente |
| `CRON_SECRET` | `server/src/scheduled.ts:337`, `server/src/gateway.ts:1483`, `server/src/financeiro.ts:1177` | Não (ver nota) | Se vazio, a checagem é **pulada** | As rotas ficam sob `/api/admin`: exigem **sessão de administrador** antes (R-4) | ausente |

## 4. Cifra e chaves

| Variável | Arquivo:linha | Obrigatória | Quando ausente | Dependências | Render |
|---|---|---|---|---|---|
| `SEGREDOS_ENCRYPTION_KEY` | `server/src/chavesCifra.ts:46`, `server/src/segredos.ts:21`, `server/src/logistica.ts:697` | **Recomendada** (chave dedicada) | Cifra deriva de `JWT_SECRET` (legado). **Produção não falha**; só há aviso em `logistica` | Primária quando definida; `JWT_SECRET` vira legada (leitura) | **ausente** (R-2) |
| `APP_ENCRYPTION_KEY` | `server/src/chavesCifra.ts:46`, `server/src/segredos.ts:21` | Alias de `SEGREDOS_ENCRYPTION_KEY` | Idem | Idem | ausente |
| `MFA_ENCRYPTION_KEY` | `server/src/chavesCifra.ts:47`, `server/src/security.ts:62` | Recomendada | Aviso no boot; deriva de `JWT_SECRET` | Trocar muda a leitura de segredos TOTP | `generateValue` |
| `CONNECTOR_ENCRYPTION_KEY` | `modules/connectors/core/crypto.service.ts:55,65,78` | **Sim para conectores** | Conector não conecta (entra em `connectorConfigurationMissing`) | 32 bytes base64 ou 64 hex. Trocar sem re-cifrar inutiliza tokens de conectores | declarada |

Regra de cifra (Fase 2, `chavesCifra.ts`): a primária é a chave dedicada, quando existe; a legada é derivada de `JWT_SECRET` e serve só para leitura. Sem nenhuma chave em produção, cifrar lança `ErroChaveCifra`. **Porém**, como `JWT_SECRET` existe em produção, a cifra funciona com a chave legada e a dedicada nunca é exigida. A decisão (e) não cobriu essa migração de chave.

## 5. Segredos de webhook e verificação

| Variável | Conector | Arquivo:linha | Obrigatória | Quando ausente | Verificação | Render |
|---|---|---|---|---|---|---|
| `MERCADOLIVRE_WEBHOOK_SECRET` | Mercado Livre | `modules/connectors/webhooks/handlers.ts:103` | **Sim** (fail-closed) | Recusa toda entrega (`WebhookSignatureError`) | Comparado com `?secret=` **na query string** (R-5) | declarada |
| `MERCADOPAGO_WEBHOOK_SECRET` | Mercado Pago | `modules/connectors/mercadopago/mercadopago.service.ts:295` | **Sim** (fail-closed) | `false` (recusa) | `x-signature` (HMAC) com `x-request-id` | declarada |
| `MERCADOPAGO_WEBHOOK_SECRET` (vitrine) | Mercado Pago | `server/src/commerce/pagamento-ambiente.ts:12` | Condicional | Não cria configuração de vitrine | Idem | declarada |
| `NUVEMSHOP_CLIENT_SECRET` (HMAC) | Nuvemshop | `modules/connectors/nuvemshop/nuvemshop.service.ts:513` | **Sim** | `false` (recusa) | HMAC-SHA256 do corpo com o client secret, cabeçalho `x-linkedstore-hmac-sha256`. **Premissa do esquema não verificada na plataforma** | declarada (como client secret) |
| `INSTAGRAM_WEBHOOK_VERIFY_TOKEN` | Instagram | `modules/connectors/instagram/instagram.service.ts:137,493` | Condicional (registrar webhook) | GET de verificação responde 403 | Comparação em tempo constante | ausente |
| `INSTAGRAM_APP_SECRET` | Instagram | `instagram.service.ts:136,515` | **Sim** | Conector não conecta; assinatura falha | HMAC `x-hub-signature-256` | ausente |
| `INSTAGRAM_APP_ID` | Instagram | `modules/connectors/instagram/instagram.service.ts:135` (`requiredEnv`), `:146` | **Sim** | `ConnectorConfigError`; conector não conecta | Com `INSTAGRAM_APP_SECRET` | ausente |
| `INSTAGRAM_REDIRECT_URI` | Instagram | `instagram.service.ts:159` (`resolveStaticRedirectUri`) | Condicional | Em produção, usa `APP_URL` em HTTPS (ver seção 2) | — | ausente |
| `INSTAGRAM_GRAPH_VERSION` | Instagram | `instagram.service.ts:140`; padrão na constante `:59` | Não | Padrão `v26.0` | Independente de `WHATSAPP_API_VERSION` | ausente |
| `WHATSAPP_SECRET` | WhatsApp (status) | `server/src/commerce/whatsappStatus.ts:34` | **Sim para ativar** | POST responde 401 e GET 403 (recusa tudo) | HMAC `x-hub-signature-256` | **ausente** (criar no Render pelo Diretor) |
| Token de verificação GET do WhatsApp | WhatsApp | **não existe no código** | — | GET recusado (`segredoVerificacaoWhatsApp()` = `null`) | — | **Sem nome autorizado. Não presumir** |
| `CRON_SECRET` | Rotinas | ver seção 3 | Não | — | — | ausente |

## 6. Mensageria: e-mail (SMTP) e notificações

| Variável | Arquivo:linha | Obrigatória | Quando ausente | Dependências | Render |
|---|---|---|---|---|---|
| `SMTP_HOST` | `server/src/mail.ts:24,96` | **Sim para e-mail** | `enviarEmail` retorna `nao_enviado` | Todas as quatro abaixo | declarada |
| `SMTP_USER` | `mail.ts:24,101,149` | **Sim** | Idem | Também é o remetente padrão | declarada |
| `SMTP_PASS` | `mail.ts:24,101` | **Sim** | Idem | — | declarada |
| `SMTP_PORT` | `mail.ts:24,94` | **Sim pelo código** | `smtpConfigurado()` é falso **mesmo com as outras três**. O transporte usaria 587 por padrão (desalinhado, R-9) | — | declarada |
| `SMTP_SECURE` | `mail.ts:98-100` | Não | `true` se porta 465; senão `false` | Aceita `1/true/yes/on` | declarada |
| `SMTP_FROM` | `mail.ts:149` | Não | Usa `SMTP_USER` | — | declarada |
| `NOTIFICAR_EMAILS` | `server/src/notifications.ts:44`, `server/src/scheduled.ts:40` | **Sim para receber** | Nenhum destinatário; alertas não saem | Lista separada por vírgula; **fallback** de `SCHEDULE_EMAILS` | ausente |
| `SCHEDULE_EMAILS` | `server/src/scheduled.ts:40` | Não | Usa `NOTIFICAR_EMAILS` | Prioridade sobre `NOTIFICAR_EMAILS` | ausente |
| `SCHEDULE_ALERTAS` | `server/src/scheduled.ts:295,345,369` (`getSchedule('ALERTAS')`) | **Sim para o relatório** | Padrão `off`: **relatório de alertas e de falhas nunca roda** | `daily`, `weekly` (segunda) | ausente |
| `SCHEDULE_POSICAO_ESTOQUE`, `SCHEDULE_VENDAS` | `scheduled.ts:144` e vizinhança | Não | `off` | Mesmo mecanismo | ausente |
| `NOTIFICAR_ESTOQUE_MIN` | `notifications.ts:55` | Não | Ligado (`!== 'false'`) | — | ausente |
| `NOTIFICAR_OP_CONCLUIDA` | `notifications.ts:57` | Não | Desligado (`=== 'true'`) | — | ausente |
| `NOTIFICAR_PEDIDO` | `notifications.ts:60` | Não | Desligado | — | ausente |
| `NOTIFICAR_CRM_LEMBRETE` | `notifications.ts:65`, `scheduled.ts:373` | Não | Desligado | Sem SMTP, o lembrete segue na agenda | ausente |

### WhatsApp (envio)

| Variável | Arquivo:linha | Obrigatória | Quando ausente | Dependências | Render |
|---|---|---|---|---|---|
| `WHATSAPP_CLOUD_API_TOKEN` | `server/src/commerce/notificacoes.ts:255` | **Sim para envio** | Canal `NAO_CONFIGURADO` | **Token de envio (Bearer), não é o App Secret.** Usado só para chamadas à Graph API | declarada (`sync:false`) |
| `WHATSAPP_PHONE_NUMBER_ID` | `notificacoes.ts:256` | **Sim para envio** | Canal `NAO_CONFIGURADO` | Com o token acima | declarada (`sync:false`) |
| `WHATSAPP_API_VERSION` | `notificacoes.ts:258` | Não | **Padrão `v26.0`** (alterado nesta rodada, antes era `v21.0`) | Se estiver fixada em `v21.0` no painel, **continua em v21.0** até 21/01/2027 | declarada (`sync:false`) — **valor não verificado** |
| `WHATSAPP_TEMPLATE_TRANSACIONAL` | `notificacoes.ts:250,277` | **Sim** (ou um específico por evento) | Eventos sem modelo ficam `NAO_CONFIGURADO` | Fallback de `WHATSAPP_TEMPLATE_<EVENTO>` | declarada |
| `WHATSAPP_TEMPLATE_<EVENTO>` (ex.: `ORDER_CREATED`, `PAYMENT_APPROVED`) | `notificacoes.ts:249,275-276` (leitura dinâmica) | Não | Usa o transacional | Prioridade sobre o transacional | ausente |
| `WHATSAPP_TEMPLATE_IDIOMA` | `notificacoes.ts:297,316,319,545` | Não | `pt_BR` | Código de idioma do modelo aprovado | declarada |
| `COMMERCE_STORE_NAME` | `notificacoes.ts:113` | Não | Nome padrão | — | ausente |

## 7. Conectores de marketplace e pagamento

### Mercado Livre

| Variável | Arquivo:linha | Obrigatória | Quando ausente | Dependências | Render |
|---|---|---|---|---|---|
| `MERCADOLIVRE_CLIENT_ID` | `mercadolivre.service.ts` (`getMercadoLivreConfig`); `modules/connectors/core/providers.ts:145` | **Sim** | `ConnectorConfigError` | Com o secret | declarada |
| `MERCADOLIVRE_CLIENT_SECRET` | `mercadolivre.service.ts` (`getMercadoLivreConfig`) | **Sim** | Idem | — | declarada |
| `MERCADOLIVRE_REDIRECT_URI` | `providers.ts:159`; `connector.service.ts:490` | Condicional | Em produção, usa `APP_URL` em HTTPS | — | declarada |
| `MERCADOLIVRE_WEBHOOK_SECRET` | seção 5 | **Sim** | Recusa tudo | — | declarada |
| `MERCADOLIVRE_TOKEN` | `server/src/marketplace.ts:26,46,58` | **Não usar** | Rota legada responde 409 | **Token estático que não é o OAuth do conector** (R-1) | ausente |
| `PUBLICACAO_CANAIS_LIBERADOS` | `server/src/commerce/publicacaoSuspensao.ts:15` | Não | **Suspenso** (padrão para ML e Nuvemshop) | CSV dos canais liberados. Controla a decisão (f) | ausente |

### Nuvemshop

| Variável | Arquivo:linha | Obrigatória | Quando ausente | Dependências | Render |
|---|---|---|---|---|---|
| `NUVEMSHOP_CLIENT_ID` | `nuvemshop.service.ts` (`getNuvemshopConfig`); `providers.ts:147` | **Sim** | Conector não conecta | Com o secret | declarada |
| `NUVEMSHOP_CLIENT_SECRET` | `nuvemshop.service.ts:513` (HMAC) | **Sim** | Webhooks recusados | **Trocar o secret quebra a validação dos webhooks** | declarada |
| `NUVEMSHOP_REDIRECT_URI` | `providers.ts:161` | Condicional | Idem ML | — | declarada |
| `NUVEMSHOP_USER_AGENT` | `nuvemshop.service.ts:53` | Não | Padrão `NUVEMSHOP_DEFAULT_USER_AGENT` | Exigido pela plataforma | ausente |

### Mercado Pago

| Variável | Arquivo:linha | Obrigatória | Quando ausente | Dependências | Render |
|---|---|---|---|---|---|
| `MERCADOPAGO_ACCESS_TOKEN` | `modules/connectors/core/connector.service.ts:361`; `server/src/commerce/pagamento-ambiente.ts:11` | **Sim** | Conector não conecta; vitrine não recebe fallback | Com `MERCADOPAGO_PUBLIC_KEY` | declarada |
| `MERCADOPAGO_PUBLIC_KEY` | `mercadopago.service.ts:48`; `connector.service.ts:361` | **Sim** | Idem | — | declarada |
| `MERCADOPAGO_WEBHOOK_SECRET` | seção 5 | **Sim** | Recusa tudo | — | declarada |
| `GATEWAY_MP_API_BASE_URL` | seção 2 | Não | Padrão | Risco R-7 | ausente |

### Stripe e PagBank (fallback de vitrine via ambiente)

Lidos por família de prefixo em `modules/payments/application/configuration.ts:16-31` e `server/src/commerce/pagamento-ambiente.ts`. Só valem para a empresa da vitrine (`empresaDaVitrine()`), e não estão no `render.yaml`:

| Família | Variáveis | Comportamento |
|---|---|---|
| `STRIPE_*` | `STRIPE_SECRET_KEY` (obrigatória), `STRIPE_WEBHOOK_SECRET` (obrigatória para criar a configuração), `STRIPE_ENVIRONMENT` (`producao` ou teste), `STRIPE_ENABLED_METHODS`, `STRIPE_RETURN_URL`, `STRIPE_NOTIFICATION_URL`, `STRIPE_CAPTURE_MODE` | Sem o secret de webhook, a configuração **não é criada** |
| `PAGBANK_*` | `PAGBANK_ACCESS_TOKEN` (obrigatória), `PAGBANK_WEBHOOK_SECRET` (opcional), `PAGBANK_ENVIRONMENT` e os demais como no Stripe | **Se o secret de webhook estiver ausente, o access token passa a ser o segredo de webhook** (R-10) |

## 8. Outros conectores e fiscal

| Variável | Conector | Arquivo:linha | Obrigatória | Quando ausente | Render |
|---|---|---|---|---|---|
| `WOOCOMMERCE_CK`, `WOOCOMMERCE_CS` | WooCommerce | `server/src/loja.ts:43-44` | Condicional (loja) | Integração desligada (`configLoja` = `null`) | ausente |
| `WOOCOMMERCE_EMPRESA_ID` | WooCommerce | `loja.ts:55` | **Sim para operar** | 409 em toda operação | ausente |
| `WOOCOMMERCE_STATUS` | WooCommerce | `loja.ts:72` | Não | `processing` | ausente |
| `WOOCOMMERCE_CANAL` | WooCommerce | `loja.ts:77` | Não | `site_varejo` | ausente |
| `WOOCOMMERCE_TIMEOUT_MS` | WooCommerce | `loja.ts:85` | Não | 20 000 ms | ausente |
| `COMMERCE_LOJA_EMPRESA_ID` | Vitrine | `server/src/commerce/loja-base.ts:25` | Condicional | Vitrine usa a regra padrão | ausente |
| *Nota (não são variáveis)* | Melhor Envio (`me_token`), Correios (`correios_senha`), Focus NFe e PlugNotas | `server/src/logistica.ts:156,168,175`; `server/src/fiscalProvider.ts:440` | — | Credenciais **por empresa**, cifradas no banco; cadastradas na tela de configuração, não no Render | — |
| `CATALOGO_EMBED_ORIGENS` | Catálogo | `server/src/catalogos.ts:700` | Não | Usa `WOOCOMMERCE_URL` | ausente |
| `CATALOGO_LIMIT` | Catálogo | `server/src/catalogos.ts:34` | Não | Padrão | ausente |
| `NFE_PROVIDER`, `NFE_API_KEY`, `NFE_MODO` | Fiscal (NF-e) | `server/src/nfe.ts:173-175,244-245` | Condicional | `configurado: false` | ausente |
| `NFE_EMITENTE_CNPJ`, `NFE_EMITENTE_IE`, `NFE_EMITENTE_RAZAO` | Fiscal | `server/src/nfe.ts:106-108` | Condicional | Emissão não monta o emitente | ausente |
| `FISCAL_TIMEOUT_MS` | Fiscal | `server/src/fiscalProvider.ts:188` | Não | Padrão | ausente |
| `CEP_PROVIDERS`, `CEP_TIMEOUT_MS` | CEP | `server/src/cep.ts:95,39` | Não | `brasilapi,viacep`; padrão | ausente |
| `LOGISTICS_CONTACT_EMAIL` | Cotação Melhor Envio | `server/src/logistica.ts` | Condicional, e-mail técnico exigido pela API | Sem valor válido, cotação fica indisponível | ausente |

### WooCommerce MULTI-STORE (RETAIL / WHOLESALE) — migration 0100

Uma empresa, um catálogo, DUAS lojas independentes. Com o modo desligado, vale
exatamente o bloco single-store acima (`WOOCOMMERCE_*`).

| Variável | Arquivo | Obrigatória | Quando ausente | Render |
|---|---|---|---|---|
| `WOOCOMMERCE_MULTI_STORE_ENABLED` | `server/src/commerce/woocommerce/registry.ts` | Não | Modo multi-loja DESLIGADO (fluxo single-store preservado) | ausente |
| `WOOCOMMERCE_RETAIL_ENABLED` | `registry.ts` | Condicional | Loja RETAIL não configurada (`configStore('RETAIL')` = `null`) | ausente |
| `WOOCOMMERCE_RETAIL_URL` | `registry.ts` | Condicional | Loja RETAIL incompleta | ausente |
| `WOOCOMMERCE_RETAIL_CK`, `WOOCOMMERCE_RETAIL_CS` | `registry.ts` | Condicional | Loja RETAIL incompleta | ausente |
| `WOOCOMMERCE_RETAIL_EMPRESA_ID` | `registry.ts` | Não | Cai em `WOOCOMMERCE_EMPRESA_ID` e, por fim, na empresa padrão (1) | ausente |
| `WOOCOMMERCE_WHOLESALE_ENABLED` | `registry.ts` | Condicional | Loja WHOLESALE não configurada | ausente |
| `WOOCOMMERCE_WHOLESALE_URL` | `registry.ts` | Condicional | Loja WHOLESALE incompleta | ausente |
| `WOOCOMMERCE_WHOLESALE_CK`, `WOOCOMMERCE_WHOLESALE_CS` | `registry.ts` | Condicional | Loja WHOLESALE incompleta | ausente |
| `WOOCOMMERCE_WHOLESALE_EMPRESA_ID` | `registry.ts` | Não | Igual à RETAIL | ausente |
| `WOOCOMMERCE_SYNC_DRY_RUN` | `registry.ts` | Não | Escrita REAL nas lojas; `true` suprime toda escrita (homologação) | ausente |

### WooCommerce MULTI-STORE — WEBHOOKS E RECONCILIAÇÃO — migration 0101

Evolução da 0100: webhooks assinados por loja, inbox idempotente e
reconciliação. Todas opcionais; sem elas os padrões seguros valem.

| Variável | Arquivo | Obrigatória | Quando ausente | Render |
|---|---|---|---|---|
| `WOOCOMMERCE_RETAIL_WEBHOOK_SECRET` | `server/src/commerce/woocommerce/webhookSeguranca.ts` | Condicional (webhook RETAIL) | Endpoint da RETAIL recusa toda entrega (falha fechada) | ausente |
| `WOOCOMMERCE_WHOLESALE_WEBHOOK_SECRET` | `webhookSeguranca.ts` | Condicional (webhook WHOLESALE) | Endpoint da WHOLESALE recusa toda entrega | ausente |
| `WOOCOMMERCE_WEBHOOK_MAX_BYTES` | `webhookSeguranca.ts` | Não | 1 MiB (teto 8 MiB) | ausente |
| `WOOCOMMERCE_WEBHOOK_TOLERANCE_S` | `webhookSeguranca.ts` | Não | 300 s (0 desliga a checagem de timestamp) | ausente |
| `WOOCOMMERCE_WEBHOOK_RATE_WINDOW_MS` | `webhookSeguranca.ts` | Não | 60 000 ms | ausente |
| `WOOCOMMERCE_WEBHOOK_RATE_MAX` | `webhookSeguranca.ts` | Não | 120 entregas por janela/IP | ausente |
| `WOOCOMMERCE_RECONCILIACAO_MAX_PAGINAS` | `reconciliacao.ts` | Não | 10 páginas de 100 produtos por loja | ausente |
| `WOOCOMMERCE_RECONCILIACAO_INTERVALO_MIN` | `server/src/scheduled.ts` | Não | 60 min (mínimo 5) | ausente |

### Motor de Frete e Logística Multicanal — `modules/logistics` — migration 0102

Motor desacoplado de cotação, expedição, etiqueta, rastreamento e reconciliação.
Reusa `envios`/`envio_eventos`, `commerce_outbox` e o registry multi-loja. Sem
`LOGISTICS_ENABLED`, o módulo sobe em MODO SEGURO: nenhum operador é chamado e
toda cotação devolve estado explícito (`CREDENTIALS_MISSING`).

| Variável | Arquivo | Obrigatória | Quando ausente | Render |
|---|---|---|---|---|
| `LOGISTICS_ENABLED` | `modules/logistics/application/quotes.ts` | Não | Módulo DESLIGADO (modo seguro): cotação não chama operador, devolve `CREDENTIALS_MISSING` | ausente |
| `LOGISTICS_QUOTE_ALLOW_DISABLED` | `quotes.ts` | Não | Com `LOGISTICS_ENABLED=false`, permite cotar mesmo assim (homologação) | ausente |
| `LOGISTICS_DEFAULT_PROVIDER` | `quotes.ts` | Não | `manual` (nenhuma cotação automática) | ausente |
| `LOGISTICS_SYNC_DRY_RUN` | `modules/logistics/integration/woocommerce.ts` (`logisticsDryRun`) | Não | Publica de verdade na loja (respeitando ainda o `WOOCOMMERCE_SYNC_DRY_RUN` global) | ausente |
| `LOGISTICS_TRACKING_POLL_INTERVAL` | `modules/logistics/application/quotes.ts` (`intervaloPollMin`) | Não | 1800 s (30 min). `0` desliga o polling de rastreio | ausente |
| `LOGISTICS_RECONCILIATION_ENABLED` | `modules/logistics/application/quotes.ts` (`reconciliacaoHabilitada`) | Não | Reconciliação periódica DESLIGADA (exige também `LOGISTICS_ENABLED`) | ausente |
| `LOGISTICS_DEFAULT_MODALIDADE` | `modules/logistics/application/contexto.ts` | Não | `CIF` | ausente |
| `LOGISTICS_QUOTE_TTL_MIN` | `quotes.ts` | Não | 30 min (teto 1440) — validade da cotação | ausente |
| `LOGISTICS_EMPRESA_ID` | `modules/logistics/infrastructure/webhookRecebimento.ts` | Não | Empresa padrão (1) para webhooks de operador | ausente |
| `LOGISTICS_<PROVIDER>_EMPRESA_ID` | `webhookRecebimento.ts` | Não | Cai em `LOGISTICS_EMPRESA_ID` e na padrão (1) | ausente |
| `LOGISTICS_<PROVIDER>_ENABLED` | `modules/logistics/providers/registry.ts` | Não | Operador com contrato pendente fica DESABILITADO mesmo com credencial | ausente |
| `LOGISTICS_<PROVIDER>_WEBHOOK_SECRET` | `modules/logistics/infrastructure/webhookSeguranca.ts` | Condicional (webhook) | Endpoint do operador recusa toda entrega (falha fechada) | ausente |
| `LOGISTICS_WEBHOOK_MAX_BYTES` | `webhookSeguranca.ts` | Não | 1 MiB (teto 8 MiB) | ausente |
| `LOGISTICS_WEBHOOK_TOLERANCE_S` | `webhookSeguranca.ts` | Não | 300 s (0 desliga a checagem de timestamp) | ausente |
| `LOGISTICS_WEBHOOK_RATE_WINDOW_MS` | `webhookSeguranca.ts` | Não | 60 000 ms | ausente |
| `LOGISTICS_WEBHOOK_RATE_MAX` | `webhookSeguranca.ts` | Não | 120 entregas por janela/IP | ausente |

## 9. Armazenamento, observabilidade e ajustes

| Variável | Arquivo:linha | Obrigatória | Quando ausente | Render |
|---|---|---|---|---|
| `UPLOAD_PROVIDER` | `server/src/uploads.ts:71` | Não | `db` | declarada (`db`) |
| `CLOUDINARY_URL` | `uploads.ts:72` | Condicional (`cloudinary`) | Aviso e volta ao banco | declarada |
| `CLOUDINARY_FOLDER` | `uploads.ts:110,357` | Não | Padrão | ausente |
| `SENTRY_DSN` | `server/src/log.ts:39` | Não | Sem envio de erros | ausente |
| `SENTRY_TRACES_SAMPLE_RATE` | `log.ts:48` | Não | `0` | ausente |
| `VITE_SENTRY_DSN` | `client/` (build) | Não | Sem Sentry no front | declarada. **Variável pública por natureza** |
| `PRINT_JOBS_RETENTION_DAYS`, `PRINT_LEASE_MS`, `PRINT_RETRY_BASE_MS` | `server/src/printJobs.ts:60,62,894` | Não | Padrões | ausente |
| `NEGOCIOS_AUTO_REFRESH_MS` | `server/src/negocios.ts:2009` | Não | Padrão | ausente |
| `APPROVAL_VENDA_LIMITE`, `APPROVAL_COMPRA_LIMITE`, `APPROVAL_DESCONTO_MAX` | `server/src/approval.ts:35-37` | Não | `0` (aprovação desligada) | ausente |
| `CATALOGO_*` (demais) | — | — | — | — |

---

## 10. Dependências entre variáveis (resumo)

- **ML:** `MERCADOLIVRE_CLIENT_ID` + `CLIENT_SECRET` + `REDIRECT_URI` (ou `APP_URL` HTTPS) + `WEBHOOK_SECRET`. Mais `CONNECTOR_ENCRYPTION_KEY`.
- **Nuvemshop:** `CLIENT_ID` + `CLIENT_SECRET` (também chave HMAC) + `REDIRECT_URI`. Publicação depende de `PUBLICACAO_CANAIS_LIBERADOS`.
- **Mercado Pago:** `ACCESS_TOKEN` + `PUBLIC_KEY` + `WEBHOOK_SECRET`.
- **Instagram:** `APP_ID` + `APP_SECRET` + `REDIRECT_URI` + `WEBHOOK_VERIFY_TOKEN` (para registrar o webhook).
- **WhatsApp envio:** `CLOUD_API_TOKEN` + `PHONE_NUMBER_ID` + modelo (`TEMPLATE_TRANSACIONAL` ou por evento). Versão: `API_VERSION`.
- **WhatsApp status:** `WHATSAPP_SECRET` (criar) + token de verificação GET (**sem nome**).
- **E-mail:** `SMTP_HOST` + `SMTP_USER` + `SMTP_PASS` + `SMTP_PORT`. Destinatários: `NOTIFICAR_EMAILS` (ou `SCHEDULE_EMAILS`). Disparo: `SCHEDULE_ALERTAS` ≠ `off` **e um cron externo** (não existe no repositório).
- **Cifra:** `CONNECTOR_ENCRYPTION_KEY` (conectores); `SEGREDOS_ENCRYPTION_KEY` ou `APP_ENCRYPTION_KEY` (segredos; ausente = legado); `MFA_ENCRYPTION_KEY`; `JWT_SECRET` (base legada).

## 11. Riscos de configuração identificados

| ID | Risco | Evidência | Severidade | Recomendação (não executada) |
|---|---|---|---|---|
| R-1 | Rota legada `/api/marketplace/sincronizar` faz chamada HTTP real ao Mercado Livre com o token estático `MERCADOLIVRE_TOKEN`, acessível a qualquer usuário autenticado (sem `requireRole`). O endereço usa o texto literal `seller=seller_id`. | `marketplace.ts:46,57`; `index.ts:1249` (após `requireAuth`, sem `requireRole`) | **Alta** | Remover a rota ou restringir a administrador e desligar o token estático. Decisão do Diretor |
| R-2 | Chave dedicada de segredos (`SEGREDOS_ENCRYPTION_KEY`) não está no blueprint. Em produção, a cifra segue derivada de `JWT_SECRET`. | `render.yaml` (ausente); `chavesCifra.ts:53` | Alta | Verificar o painel. Se ausente, criar a chave em decisão separada (requer aprovação, pois é variável nova) |
| R-3 | Sem `DATABASE_URL`, o sistema sobe em modo demonstração (memória) **inclusive em produção**, só com aviso no log. | `services.ts getStore`; `index.ts:1554` | Alta (operacional) | Trava de boot em produção sem banco. Código novo (não feito) |
| R-4 | `CRON_SECRET` não é aceito por `requireAuth`, e não há cron no `render.yaml`. Análise do código (não testada por requisição HTTP): com `CRON_SECRET` definido, `/api/admin/scheduled/cron` responde 401 a qualquer chamada, porque o Bearer de sessão não é igual ao segredo e o segredo não passa em `requireAuth`. Sem o segredo, só funciona com sessão de administrador. Nenhum agendador interno dispara os relatórios. | `auth.ts:752`; `scheduled.ts:334-340`; `index.ts:641,876` | **Alta** (operacional) | Decisão do Diretor sobre agendador e autenticação de cron. Código novo, fora desta fase |
| R-5 | Segredo do webhook do Mercado Livre trafega na query string (`?secret=`), que pode ser registrada em logs e no Sentry. | `handlers.ts:104-105` | Média | Migrar para cabeçalho. Exige alteração no lado do ML |
| R-6 | WebSocket reflete qualquer origem com `credentials: true` quando `CORS_ORIGINS` está vazio, diferente da API HTTP. A autenticação usa token no handshake, não cookie, então a exploração é limitada. | `websocket.ts:27` vs `security.ts:69-81` | Baixa/média | Usar a mesma lista de origens de `corsOrigin()` |
| R-7 | Variáveis `GATEWAY_MP_API_BASE_URL`, `MERCADOPAGO_API_BASE_URL`, `MERCADOLIVRE_*_BASE_URL`, `NUVEMSHOP_*_BASE_URL` e `INSTAGRAM_*_BASE_URL` trocam o destino de chamadas que levam tokens ou segredos. Sem validação de host. | arquivos citados na seção 2 | Média | Lista de hosts permitidos, ou remover os overrides em produção |
| R-8 | Senha padrão de desenvolvimento escrita no código (literal omitido deste documento). Em produção é bloqueado pelo `assertProductionSecrets`. | `auth.ts:28`; `security.ts:57` | Baixa (bloqueado em produção) | Remover o literal do código |
| R-9 | `smtpConfigurado()` exige `SMTP_PORT`, mas o transporte usa 587 por padrão. Sem a porta, o e-mail é desligado mesmo com credenciais válidas. | `mail.ts:24` vs `mail.ts:94` | Baixa | Alinhar a condição |
| R-10 | PagBank: sem `PAGBANK_WEBHOOK_SECRET`, o access token vira o segredo de webhook. | `configuration.ts` (`webhook_segredo_cifrado: cifrarSegredo(webhook || token)`) | **Média/alta** | Exigir o secret de webhook, sem fallback. Código novo (não feito) |
| R-11 | `ADMIN_FORCE_PASSWORD=true` redefine a senha do administrador a cada boot. Hoje está `"false"` no blueprint. | `auth.ts:214`; `render.yaml` | Baixa | Manter `false` e documentar a reversão |
| R-12 | Dados de todas as empresas no alerta de estoque e no relatório de falhas, enviados a destinatários de variável de ambiente. | ver `docs/auditoria/auditoria-segregacao-alertas.md` | **Alta** (privacidade multiempresa) | Decisão do Diretor sobre destinatários e escopo |
| R-13 | `WHATSAPP_CLOUD_API_TOKEN` e `WHATSAPP_SECRET` são credenciais diferentes. Sem o App Secret no `WHATSAPP_SECRET`, o webhook de status não valida nada (recusa tudo). | `whatsappStatus.ts:34` | Informativa | Confirmar o nome e o valor (pelo Diretor, no painel) |
| R-14 | Relatório de falhas (Fase 7): falhas de webhook saem como empresa nula (“—”), porque `webhooks` e `webhook_entregas` não têm `empresa_id` no esquema. Webhooks são configuração global do administrador (`internal: true`, criação só por admin). A promessa “contagem por empresa” vale só para fila e notificações. | `db/schema.sql:1157,1168`; `server/src/webhooks.ts` (R_WEBHOOKS); `server/src/alertasFalhas.ts` (`coletarFalhasEntrega`); teste `segregacao-multiempresa-alertas.test.ts` (caracterização) | Média | Decisão do Diretor: webhooks globais (manter e rotular) ou por empresa (migração de esquema, fora desta fase) |
| R-15 | Cabeçalho de autenticação divergente entre contratos Nuvemshop. O v1 (`nuvemshop.service.ts`, ~linha 227) envia `Authentication: bearer <token>`, que é o contrato documentado. A publicação 2025-03 (`publicacaoNuvemshop.ts:54`) envia `Authorization: Bearer`. Fontes encontradas nesta fase divergem sobre o 2025-03 (um espelho diz `Authentication` e chama `Authorization` de 401; outra fonte cita `Authorization`). **Não verificado com a plataforma.** | `modules/connectors/nuvemshop/nuvemshop.service.ts:227`; `server/src/commerce/publicacaoNuvemshop.ts:54` | **Alta** (bloqueia publicação 2025-03) | Gate do plano de homologação: um GET de leitura na loja de teste decide o cabeçalho antes de qualquer escrita. Se for `Authentication`, correção de código, com aprovação do Diretor |

## 12. Pendências de verificação externa

- Valores reais de todas as variáveis no Render: **não verificado**.
- Se `WHATSAPP_API_VERSION` está fixada em `v21.0`: **não verificado**.
- Se `NOTIFICAR_EMAILS`, `SCHEDULE_EMAILS` e `SCHEDULE_ALERTAS` estão definidas: **não verificado**.
- Se `DATABASE_URL` está definida em produção: **não verificado** (o blueprint declara `DATABASE_URL`, mas o valor não foi visto).
- Se `CRON_SECRET` e algum agendador externo existem: **não verificado** (não há no repositório).
- Premissa do esquema de assinatura Nuvemshop (`x-linkedstore-hmac-sha256` com o client secret): **não verificada na documentação da plataforma nesta rodada**.
- Nome do token de verificação GET do WhatsApp: **não existe**. Precisa ser decidido.
- Nuvemshop 2025-03: cabeçalho de autenticação **não verificado** (R-15). Até a verificação, a publicação 2025-03 não deve ser considerada funcional.
- Se os segredos de webhook ML/MP já estão em produção (premissa da decisão (c)): **não verificado**.

---

## 9. Atualização Fase 4.2 (riscos R-1, R-3, R-4, R-10, R-12, R-14, R-15)

Nenhuma variável nova. Nenhuma alteração em `render.yaml`. Nenhuma alteração no Render. Os valores não foram verificados em produção: as colunas abaixo descrevem o **comportamento do código** após a correção.

| Variável / ponto | Mudança na Fase 4.2 | Efeito operacional | Verificado em |
|---|---|---|---|
| `DATABASE_URL` (produção) | R-3: `assertProductionSecrets` passa a exigir banco. Sem ele, a aplicação não cai mais em `MemStore`, e o health responde 503 | Ambiente de produção sem banco deixa de responder 200 | Teste local (`banco-obrigatorio-producao.test.ts`) |
| `CRON_SECRET` | R-4: contrato do cron de relatórios. Sem a variável, `POST /api/admin/scheduled/cron` responde 503. Token inválido responde 401. Aceita só `Authorization: Bearer <CRON_SECRET>`, montado antes da sessão | O cron externo precisa enviar o Bearer. Sessão de usuário não passa | Teste local (`cron-recorrencias-contrato.test.ts`). Não executado em ambiente real |
| `<PREFIXO>_WEBHOOK_SECRET` (PagBank) | R-10: obrigatório e separado do token. Sem ele, a verificação falha fechada. O token de API não é mais aceito como chave | Configurações antigas que gravaram o token como segredo passam a falhar. É preciso gravar o segredo dedicado do webhook | Teste local (`pagbank-webhook-segredo.test.ts`, 9 testes). Não testado com notificação real |
| `SCHEDULE_EMAILS` / `NOTIFICAR_EMAILS` | R-12: o relatório só envia a destinatários que são usuários vigentes **vinculados à empresa** do dado. Sem destinatário identificado, não envia | Endereços sem vínculo deixam de receber o relatório. **Decisão do Diretor pendente** (ver auditoria de segregação, §8) | Teste local (`alertas-isolamento-empresa.test.ts`) |
| `NOTIFICAR_EMAILS` (notificações transacionais) | Não alterado. `notifications.ts` ainda envia para a lista global | Continua global. Pendência explícita | — |
| `SCHEDULE_ALERTAS` | Não alterado. Padrão `off` | Sem alteração | — |
| Rota de recorrências | R-4: `POST /api/admin/financeiro/recorrencias` exige sessão de administrador, confirmação `{"confirmar":"PROCESSAR_RECORRENCIAS"}` e escopo da empresa do administrador. Relatórios não executam recorrências | Recorrências não são mais geradas pelo cron | Teste local |
| Rota legada de marketplace (`/api/marketplace/...`) | R-1: sincronização de pedidos exige admin e RBAC | Sem efeito em configuração | Teste local (`marketplace-legado-autorizacao.test.ts`) |
| `WHATSAPP_SECRET` | Não alterado (decisão d) | Sem alteração | — |
| `MERCADOLIVRE_TOKEN` (token estático) | R-1: não identifica empresa; uso restrito a admin | Não pode ser usado por usuário comum | Teste local |
| `NUVEMSHOP` 2025-03 (cabeçalho) | R-15: **não alterado**. Gate de leitura bloqueado | Publicação continua suspensa (ver decisão f) | Guarda local (`nuvemshop-gate-leitura.test.ts`) |
| Webhooks de saída (`webhooks`, `webhook_entregas`) | R-14: sem migração. Resolver puro criado, não ligado a rotas de entrada | Sem efeito | Teste local (`webhook-empresa-resolucao.test.ts`, 9 testes) |

**Limitação.** Os valores reais de `CRON_SECRET`, `DATABASE_URL`, `<PREFIXO>_WEBHOOK_SECRET`, `SCHEDULE_EMAILS` e `NOTIFICAR_EMAILS` no Render não foram verificados. Nenhum valor foi lido ou impresso.

## 13. Atualização Fase 4.3 (R-4, R-10, R-14, R-3)

> Registro completo: `docs/auditoria/fase-4-3-registro.md`. Nenhuma variável nova foi criada nesta fase.
> Nenhuma alteração em Render, em `render.yaml` ou em variáveis de produção.

### 13.1 Cron externo — cinco jobs, um por processo (R-4)

O agendador é **externo** ao repositório (`render.yaml` não declara cron). Cada job deve chamar **um** processo:

| Job | Método e rota | Autenticação | Efeito |
|---|---|---|---|
| 1 | `POST /api/admin/scheduled/cron/relatorios` | `Authorization: Bearer <CRON_SECRET>` | estoque, vendas, alertas com falhas |
| 2 | `POST /api/admin/scheduled/cron/pagamentos` | idem | sincronização de pagamentos, expiração de checkouts, outbox de estorno |
| 3 | `POST /api/admin/scheduled/cron/publicacoes` | idem | fila de publicações (respeita suspensão ML/Nuvemshop) |
| 4 | `POST /api/admin/scheduled/cron/pedidos` | idem | recuperação de pedidos de marketplace e outbox de pedidos |
| 5 | `POST /api/admin/scheduled/cron/crm` | idem | lembretes CRM (só com canal habilitado) |

- `POST /api/admin/scheduled/cron` (sem sufixo) executa **somente** `relatorios`. Um job legado que aponte para essa rota
  **não** executa pagamentos, publicações, CRM nem recuperação de pedidos.
- Respostas: 503 sem `CRON_SECRET`; 401 com token inválido (sessão de usuário não autentica o cron); 404 para processo
  desconhecido (inclui `recorrencias`); 409 para execução concorrente na mesma instância.
- **Frequência:** não definida neste repositório; a definir pela operação, por processo.
- **Recorrências financeiras** ficam fora do cron: `POST /api/admin/financeiro/recorrencias`, com confirmação explícita.
- Variável usada: apenas `CRON_SECRET` (existente). Nenhuma variável nova.

**Decisão pendente do Diretor (G1):** configurar os cinco jobs ou manter um agregado com decisão expressa.

### 13.2 Segredo de webhook PagBank (R-10)

| Item | Situação |
|---|---|
| Fonte do segredo (empresa) | `webhook_segredo_cifrado` na configuração da empresa (cifrado, somente escrita; leitura mascarada). |
| Fonte do segredo (vitrine, ambiente) | `PAGBANK_WEBHOOK_SECRET`, usado só junto de `PAGBANK_ACCESS_TOKEN` (`modules/payments/application/configuration.ts`). O nome já existe no código e segue a ordem R-10 (`${prefix}_WEBHOOK_SECRET`). |
| Segredo ausente | Falha fechada: a rota `POST /api/gateway/webhooks/pagbank` responde 401 antes de qualquer efeito. |
| Segredo igual ao access token | Tratado como ausente (`segredoWebhookEfetivo`). |
| Fallback para access token na rota pública | **Removido** em `fd8c64a` (R-10), `server/src/gateway.ts`. |
| Aprovação pendente (G2) | Criar `PAGBANK_WEBHOOK_SECRET` em qualquer ambiente exige aprovação expressa do Diretor (regra de nova variável). Não foi criada nem alterada nesta fase. |
| Chave da verificação (limitação) | `SHA256(access_token + '-' + corpo)`: a chave continua sendo o access token. O segredo dedicado é **gate de presença**. Ver ADR-004 §3. |
| Transição para produção | Só após G2 e confirmação do algoritmo e da chave com notificação real em sandbox (H-8). Sem acesso ao painel do provedor. |

### 13.3 Banco obrigatório em produção (R-3, revalidado)

- Produção sem `DATABASE_URL`: o boot encerra; `getStore()` não usa memória; `/api/health` responde 503 com `db: "ausente-em-producao"`.
- Migração nova nesta fase: `db/migrations/0097_webhooks_empresa.sql` (aditiva, colunas NULL). Aplicada pelo runner no boot, em ordem.
- Antes de qualquer deploy: aplicar a migração em um banco de homologação e confirmar `information_schema` (ver registro, §R-14).

### 13.4 Webhooks de saída (R-14)

- Nenhuma variável nova. Eventos sem empresa (globais) são entregues só a webhooks globais.
- Webhooks legados (`empresa_id` NULL) não recebem eventos de empresa até associação manual (registro, §R-14).

## 14. Atualização Fase 4.3 — Ordem Executiva Master (itens 6, 7, 12, 13, 15)

### 14.1 `ADMIN_PASSWORD` (item 13)

- Fora de produção (`NODE_ENV` diferente de `production`), ausente usa o padrão de desenvolvimento. Isso preserva os testes e o ambiente local.
- Em produção (`NODE_ENV=production`), ausente, com menos de 8 caracteres ou igual ao padrão de desenvolvimento **resolve para vazio**. Vazio **não autentica** em nenhum caminho: login normal, login de contingência com banco indisponível e reautenticação de sessão.
- Comparação em tempo constante (`senhasIguais`).
- A criação do administrador é recusada quando não há senha efetiva, para não criar conta com senha vazia.
- Código: `server/src/senhaAdmin.ts`, `server/src/auth.ts`. Testes: `server/test/admin-senha-producao.test.ts` (5 casos).
- Ação operacional: definir `ADMIN_PASSWORD` com pelo menos 8 caracteres e diferente do padrão, **sem colar o valor em canais públicos**. Nenhum valor foi criado nem impresso nesta execução.

### 14.2 `PAGBANK_WEBHOOK_SECRET` (item 7) — preparação sem criação

- Variável já lida em `modules/payments/application/configuration.ts`, junto de `PAGBANK_ACCESS_TOKEN`.
- Verificação feita: nenhum arquivo `.env` na raiz; nenhuma variável `PAGBANK_*` definida no ambiente desta sandbox (somente nomes verificados); `render.yaml` **não** declara a variável.
- Criar a variável em qualquer ambiente exige aprovação expressa do Diretor (**G2**). Nada foi criado, configurado nem solicitado.
- Segredo cadastrado por empresa (`webhook_segredo_cifrado`) tem precedência no fluxo de empresa; a variável só serve à vitrine.
- Verificador com segredo ausente ou só espaços: recusa (teste `pagbank-webhook-contrato-oficial.test.ts`).

### 14.3 Não configurado nesta execução (sem autorização)

- `render.yaml`, Render, agendador externo: não alterados.
- `CRON_SECRET`: não criado nem alterado.

### 14.4 Riscos residuais de configuração

- `NODE_ENV` desconfigurado em produção faz o sistema usar o padrão de desenvolvimento para `ADMIN_PASSWORD` **e** para `JWT_SECRET`. Confirmar `NODE_ENV=production` antes de qualquer deploy.

### 14.5 Cinco jobs (item 15)

- Documentação completa: `docs/operacao/cinco-jobs-cron.md` (URL, método, autenticação, frequência, timeout, retentativa, códigos de resposta).
- Frequência e timeout não estão definidos: pendência **G1**.

## 15. Atualização Ordem Final (pendências 2.1 a 2.8)

Nenhuma variável de produção foi criada, alterada ou lida. Os valores abaixo são **nomes declarados**, sem valor.

| Variável | Quem usa | Obrigatória? | Padrão e comportamento |
|---|---|---|---|
| `CRON_SECRET` | `POST /api/admin/scheduled/cron/:processo`, `scripts/cron-processo.mjs` | Sim, para cron | Ausente: 503 sem executar |
| `CRON_TIMEOUT_<PROCESSO>_MS` | servidor (`relatorios`, `pagamentos`, `publicacoes`, `pedidos`, `crm`) | Não | Padrão do processo; inteiro entre 10 000 e 1 800 000 |
| `CRON_CLIENT_TIMEOUT_MS` | cliente `scripts/cron-processo.mjs` | Não | Padrão: timeout do servidor + 60 s; mínimo 5 000 |
| `CRON_MAX_TENTATIVAS` | cliente | Não | 3; intervalo 1–5 |
| `CRON_BACKOFF_MS` | cliente | Não | 60 000; espera `× 5^(n−1)`, teto 600 000 |
| `BROBOND_BASE_URL` | cliente | Sim (cliente) | `https`; `http` só para localhost |
| `MERCADOLIVRE_TOKEN_ESTATICO_CONTRATO` | `POST /api/marketplace/sincronizar` | Sim, para a rota legada com token estático | Formato `<empresa_id>:<referência ≥ 8>`; ausente: 409 sem chamada externa (ADR-005) |
| `PIX_SANDBOX_PROVEDOR` | teste `pix-sandbox-opcional` | Não | `mercadopago` ou `pagbank`; ausente: teste pulado |
| `PIX_SANDBOX_ACCESS_TOKEN` | teste `pix-sandbox-opcional` | Não | Token de **sandbox** do provedor escolhido; nunca o de produção |
| `NODE_ENV` | servidor | Sim, em produção | `production` (já declarado em `render.yaml`). Fora de produção, há padrões de desenvolvimento |
| `JWT_SECRET` | servidor | Sim, em produção | Sem padrão. Ausente ou curto (< 24) em produção: o processo não sobe (testado) |
| `ADMIN_PASSWORD` | administrador inicial | Sim, em produção | Sem padrão. Ausente, curta (< 8) ou igual ao padrão de desenvolvimento: o processo não sobe (testado) |
| `DATABASE_URL` | servidor | Sim, em produção | Ausente em produção: o processo não sobe (R-3) |

**Verificação local:** `server/test/startup-producao-segredos.test.ts` (8) executa o guard em processo filho com
`NODE_ENV=production` e confirma saída 1 nos casos inválidos e 0 no caso válido, sem imprimir valores.

**Não configurado:** `CRON_SECRET`, `PAGBANK_WEBHOOK_SECRET`, `PIX_SANDBOX_*`, `MERCADOLIVRE_TOKEN_ESTATICO_CONTRATO` e
qualquer agendador. Todos dependem de autorização do Diretor.
