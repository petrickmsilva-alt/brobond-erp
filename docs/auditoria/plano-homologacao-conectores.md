# Plano de homologação dos conectores

**Fase 4.1 · Documento de preparação. Nada deste plano foi executado contra provedor real.**
Data de referência: 2026-11-03. Branch `arena/c0104925-brobond-erp`.
Nomes de variáveis: ver `matriz-configuracao-producao.md`. Valores de segredos não aparecem aqui e não devem aparecer em evidências.

---

## 0. Regras que valem para todos os conectores

### 0.1 Quatro níveis de evidência — nenhum substitui outro
| Nível | O que é | O que prova | O que NÃO prova |
|---|---|---|---|
| **L — Teste local** | Suíte automatizada no repositório, sem rede, store em memória ou PostgreSQL local | Que o código faz o que o teste descreve | Que o provedor aceita o contrato |
| **M — Mock / contrato** | Respostas simuladas (fixtures) do formato documentado do provedor | Que o parser e a montagem da requisição batem com o contrato documentado | Que o provedor responde assim hoje |
| **S — Sandbox do provedor** | Credenciais de teste oficiais do provedor, dados de teste, sem efeito financeiro ou público | Comunicação funcional com o provedor, sem risco de produção | Comportamento de produção, limites reais, conta real do cliente |
| **R — Chamada real** | Conta de produção ou do cliente real | Comportamento em produção | — (exige aprovação expressa e janela) |

Regras:
1. Ordem obrigatória: L → M → S → R. Um nível só começa com o anterior aprovado.
2. **Status "CONFORME" exige S ou R com evidência de comunicação funcional.** L e M sozinhos deixam o conector em "NÃO VERIFICADO".
3. Nesta fase, **nenhum nível R e nenhum nível S com escrita** foram executados. Níveis S que exijam aprovação do Diretor ficam marcados como "AGUARDA APROVAÇÃO".

### 0.2 Proibições desta fase (valem para qualquer teste daqui em diante, sem exceção)
- Criar, editar ou excluir anúncio em marketplace.
- Enviar mensagem real (WhatsApp, e-mail) a cliente ou a qualquer destinatário fora da lista de teste aprovada.
- Pagamento, estorno, cobrança, recorrência ou qualquer operação financeira real.
- Alterar variável de ambiente, o Render ou o `render.yaml`.
- Imprimir, registrar ou exportar segredos, tokens ou credenciais.
- Disparar o relatório diário (`/api/admin/scheduled/run` gera recorrências financeiras; ver auditoria de segregação).

### 0.3 Suspensões vigentes
- **Mercado Livre e Nuvemshop:** publicação suspensa por padrão (`PUBLICACAO_CANAIS_LIBERADOS`, decisão (f)). Criação e edição de publicações **bloqueadas**. Pedidos por webhook, estoque local, histórico e identificadores **não** são bloqueados pela suspensão, mas qualquer chamada real continua exigindo aprovação.

### 0.4 Registro de evidência (modelo)
Cada teste S ou R registra: data/hora (America/Sao_Paulo), executor, commit, ambiente (nome lógico, nunca URL com credencial), IDs de teste retornados pelo provedor, código HTTP, resultado, e o log já sem tokens. Evidência sem essas informações não conta.

### 0.5 Pré-requisitos gerais
- Ambiente de homologação separado da produção (**não existe no repositório**; pendência para o Diretor).
- PostgreSQL com `DATABASE_URL`. Sem ela o sistema sobe em memória (R-3); homologação sem banco não é homologação.
- Variáveis conforme a matriz, definidas por quem tem acesso ao Render. Nenhum valor é gerado ou presumido por este plano.
- Contas de teste de cada provedor, criadas pelo responsável do negócio.
- Janela e aprovação escritas do Diretor para cada nível S/R.

---

## 1. Resumo por conector

Fonte da lista: `auditoria-integral-conectores.md` (C-01 a C-22). Estado de evidência local **medido nesta fase** (nº de testes aprovados em execução direta):

| ID | Conector | L (medido nesta fase) | M | S | R | Status para homologação |
|---|---|---|---|---|---|---|
| C-01 | Mercado Pago | `fase2-seguranca-credenciais` 14/14 (webhooks ML/MP, Fase 2); `payment-engine` 19/19 (motor, não específico do MP) | Não | AGUARDA APROVAÇÃO | NÃO EXECUTADO | Não verificado |
| C-02 | PagBank | `payment-engine` 19/19 (cita PagBank; cobertura por conector não medida) | Não | AGUARDA APROVAÇÃO | NÃO EXECUTADO | Não verificado |
| C-03 | Stripe | `payment-engine` 19/19 (motor; cobertura por conector não medida) | Não | AGUARDA APROVAÇÃO | NÃO EXECUTADO | Não verificado |
| C-04 | Provedores genéricos | — | — | NÃO APLICÁVEL | NÃO APLICÁVEL | Placeholder: **não homologar** |
| C-05 | WhatsApp (envio e status) | `whatsapp-status-webhook` 11/11; `commerce-pix-mock-flow` 18/18 | Não | AGUARDA APROVAÇÃO | NÃO EXECUTADO | Não verificado |
| C-06 | SMTP | `smtp-verificacao-admin` 5/5; `enterprise-mail-security` 4/4 | Não | AGUARDA APROVAÇÃO | NÃO EXECUTADO | Não verificado |
| C-07 | Mercado Livre | `publicacao-canais-p0` 5/5 | Não | AGUARDA APROVAÇÃO (publicação bloqueada) | NÃO EXECUTADO | Bloqueado para publicação |
| C-08 | Nuvemshop | `publicacao-nuvemshop-2025` 9/9; `-fluxo` 3/3; `publicacao-canais-p0` 5/5 | Não | AGUARDA APROVAÇÃO (leitura e OAuth; escrita bloqueada) | NÃO EXECUTADO | Bloqueado para publicação; **R-15 aberto** |
| C-09 | Instagram | Sem arquivo de teste específico identificado (`connectors.test.ts` cita o conector; cobertura não medida) | Não | AGUARDA APROVAÇÃO | NÃO EXECUTADO | Não verificado |
| C-10 | Facebook (canal próprio) | — | — | NÃO APLICÁVEL | NÃO APLICÁVEL | Não existe no código (só Facebook Login no fluxo Instagram) |
| C-11 | WooCommerce | — | — | AGUARDA APROVAÇÃO | NÃO EXECUTADO | Sem teste automatizado específico |
| C-12 | Webhooks de saída | `webhooks-saida-antissrf` 8/8; `url-publica` 22/22 | Não | AGUARDA APROVAÇÃO | NÃO EXECUTADO | Não verificado |
| C-13 | Melhor Envio | — | — | AGUARDA APROVAÇÃO | NÃO EXECUTADO | Sem teste automatizado específico |
| C-14 | Correios | — | — | AGUARDA APROVAÇÃO | NÃO EXECUTADO | Parcial (sem etiqueta) |
| C-15 | Focus NFe | — | — | AGUARDA APROVAÇÃO | NÃO EXECUTADO | Sem teste automatizado específico |
| C-16 | PlugNotas | — | — | AGUARDA APROVAÇÃO | NÃO EXECUTADO | Sem teste automatizado específico |
| C-17 | NF-e por variáveis globais | — | — | NÃO APLICÁVEL | NÃO APLICÁVEL | Simulado: **não homologar como provedor** |
| C-18 | Cloudinary | — | — | AGUARDA APROVAÇÃO | NÃO EXECUTADO | Sem teste automatizado específico |
| C-19 | BrasilAPI / ViaCEP | — | — | Somente leitura (ver §3.19) | Somente leitura, CEP de teste | Sem teste automatizado específico |
| C-20 | IA (LLM) | — | — | — | — | Não existe no código |
| C-21 | Redis / BullMQ | — | — | — | — | Não existe (fila é PostgreSQL) |
| C-22 | S3 / R2 | — | — | — | — | Não existe no código |

**Leitura da tabela:** uma linha "L: N/N" prova que o código passa no teste escrito para ele. Não prova integração. Nenhum conector está CONFORME por homologação.

---

## 2. Nuvemshop: dois contratos, documentados separadamente

Os dois contratos usam hosts, cabeçalhos e finalidades diferentes. Não tratar como um só.

### 2.1 Contrato v1 — leitura, OAuth e webhooks
| Item | Conteúdo |
|---|---|
| Base | `https://api.nuvemshop.com.br/v1` (padrão; `NUVEMSHOP_API_BASE_URL` pode sobrescrever). Espelho documentado: `api.tiendanube.com/v1`. |
| Código | `modules/connectors/nuvemshop/nuvemshop.service.ts` (`NUVEMSHOP_API_BASE_URL`, `getNuvemshopConfig`, `fetchNuvemshopStore`, `fetchNuvemshopOrder`, `fetchNuvemshopProducts`). |
| Cabeçalhos | `Authentication: bearer <token>` (minúsculo; `Authorization` é recusado segundo a documentação) e `User-Agent` com nome e contato (`NUVEMSHOP_USER_AGENT`). **Código confere com a documentação.** |
| Operações usadas | `GET /{store_id}/orders/{id}`; `GET /{store_id}/products?per_page&page`; `GET` de dados da loja (`fetchNuvemshopStore`). |
| OAuth | Troca de código em `POST {NUVEMSHOP_AUTH_BASE_URL}/apps/authorize/token` (padrão `https://www.nuvemshop.com.br`). Documentação encontrada também aponta `https://www.tiendanube.com/apps/authorize/token`. **Divergência de host a confirmar.** |
| Webhook de entrada | Assinatura HMAC com `NUVEMSHOP_CLIENT_SECRET` (`nuvemshop.service.ts`, `verifyNuvemshopWebhookSignature`). |
| Escrita | **Nenhuma** neste contrato no plano. Não criar webhook, não alterar loja. |

**Plano de homologação v1 (somente leitura):**
1. **L:** testes de cabeçalho, base e parsing já existentes (conferir cobertura antes de considerar suficiente).
2. **M:** fixtures de `orders` e `products` conforme documentação v1.
3. **S (aguarda aprovação):** loja de teste da Nuvemshop com app de teste; OAuth feito por humano na loja de teste; depois `GET` de loja, de um pedido de teste e de produtos. Confirmar que o `user_id` retornado é o `store_id` salvo.
4. **Webhook de pedido (S, aguarda aprovação):** criar pedido de teste na loja de teste; verificar que a entrega chega com assinatura válida e que assinatura inválida é recusada. Não é escrita de anúncio.
5. **R:** NÃO EXECUTADO. Requer aprovação escrita, e não é necessário para o go-live parcial de pedidos sem publicação.

**Critério de aprovação v1:** OAuth concluído na loja de teste; `GET` de pedido retorna o pedido de teste com HTTP 200; webhook assinado aceito; webhook com assinatura inválida recusado (HTTP 401 ou equivalente), sem gravar entrega.
**Critério de bloqueio v1:** 401/403 com token recém-emitido; divergência de host que impeça OAuth; webhook sem validação aceito; qualquer chamada de escrita não planejada.

### 2.2 Contrato 2025-03 — publicação de produtos (escrita)
| Item | Conteúdo |
|---|---|
| Base | `https://api.tiendanube.com/2025-03/{store_id}` **fixa no código** (`server/src/commerce/publicacaoNuvemshop.ts:24,132`). `NUVEMSHOP_API_BASE_URL` **não** se aplica a este contrato. |
| Cabeçalhos | O código envia `Authorization: Bearer <token>` e `User-Agent` (`publicacaoNuvemshop.ts:53-55`). **Diverge do v1.** Fontes encontradas nesta fase não concordam entre si sobre o cabeçalho do 2025-03 (R-15). |
| Operações (escrita) | `POST /products` (criação, com `variants`); `PATCH /products/stock-price` (atualização de estoque e preço de vínculo existente). |
| Operações (leitura) | `GET /products/sku/{sku}` (busca antes de criar). |
| Vínculo | `externalId` = `produto:variante`. Sem identificador verificável, o POST não é repetido. Vínculo 404 é recusado. |
| Descrição | Não enviada (decisão da migração). |

**Plano de homologação 2025-03 (com escrita, bloqueado):**
1. **L:** `publicacao-nuvemshop-2025` (9/9) e `publicacao-nuvemshop-fluxo` (3/3) — **provam o contrato que o código escreveu, não o da plataforma.**
2. **M:** fixtures do 2025-03 para `POST /products` e `PATCH /products/stock-price`, conferidas com a documentação oficial atual antes de qualquer S.
3. **S — GATE OBRIGATÓRIO (somente leitura, aguarda aprovação):** um `GET /products/sku/{sku_de_teste}` na loja de teste, **com cada um dos dois cabeçalhos** (`Authorization: Bearer` e `Authentication: bearer`), registrando qual é aceito. Nenhuma escrita antes disso.
   - Se somente `Authentication` funcionar: **publicação 2025-03 não funciona hoje.** Correção de código necessária (aprovação do Diretor). Não publicar.
   - Se os dois funcionarem: registrar e decidir qual manter.
4. **S — escrita (bloqueado; aguarda aprovação escrita, loja de teste, SKU de teste, suspensão mantida):** um `POST /products` e um `PATCH /products/stock-price` em produto de teste; conferir `externalId`, idempotência por SKU e comportamento com retry.
5. **R:** NÃO EXECUTADO. Publicação real em loja de cliente **não é autorizada** nesta fase.

**Critério de aprovação 2025-03:** cabeçalho confirmado por GET; criação e vínculo na loja de teste com IDs retornados e registrados; retry não duplica produto; 404 de vínculo é recusado.
**Critério de bloqueio 2025-03:** 401 com cabeçalho confirmado; criação duplicada; POST sem identificador repetido; qualquer escrita em loja real.

---

## 3. Plano por conector

Formato: pré-requisitos · ambiente · autenticação · conexão · funcional · resultado esperado · evidência · aprova se · bloqueia se.

### 3.1 C-01 Mercado Pago (pagamentos)
- **Pré-requisitos:** `MERCADOPAGO_ACCESS_TOKEN`, `MERCADOPAGO_PUBLIC_KEY`, `MERCADOPAGO_WEBHOOK_SECRET` (matriz §7 e §5). Empresa de teste no sistema.
- **Ambiente:** L (suíte) → M (fixtures de `api.mercadopago.com/v1/orders`) → S (credenciais de **teste** do MP, valor de teste, sem captura real) → R (proibido nesta fase).
- **Autenticação:** Bearer com o token de acesso; webhook com segredo (recusa sem ele, Fase 2).
- **Conexão:** `GET /users/me` com o token de teste (somente leitura) para confirmar que o token é o da conta de teste.
- **Funcional (S, aguarda aprovação):** criar cobrança PIX de valor de teste; receber notificação assinada; conciliar status. Estorno **não** executar.
- **Resultado esperado:** `users/me` 200 com a conta de teste; cobrança criada com ID; webhook assinado aceito e status atualizado; webhook sem assinatura recusado.
- **Evidência:** ID da cobrança de teste, código HTTP, log do webhook sem segredo.
- **Aprova se:** S concluído com os quatro itens acima.
- **Bloqueia se:** token de produção usado em teste; webhook sem assinatura aceito; cobrança real criada.
- **Limitação conhecida:** duas portas de webhook (P1-07) pendentes; cobrança avulsa não migrada.

### 3.2 C-02 PagBank (PIX)
- **Pré-requisitos:** `PAGBANK_ACCESS_TOKEN`, `PAGBANK_WEBHOOK_SECRET` (**não usar o access token como fallback**, R-10), `PAGBANK_ENVIRONMENT` apontando para o sandbox.
- **Ambiente:** S = sandbox oficial do PagBank (host `sandbox.api.pagseguro.com`, conforme código). Produção não autorizada.
- **Autenticação:** Bearer do sandbox.
- **Conexão:** consulta de pedido de teste (somente leitura).
- **Funcional (S, aguarda aprovação):** criar PIX de teste; receber webhook assinado.
- **Resultado esperado:** PIX de teste com ID; webhook com segredo de webhook aceito.
- **Evidência:** ID, HTTP, log sem token.
- **Aprova se:** S com webhook assinado pelo segredo **dedicado** aceito.
- **Bloqueia se:** webhook aceito usando o access token como segredo (R-10 em uso); ambiente de produção.
- **Limitação:** cartão e boleto não homologados (`auditoria-integral`).

### 3.3 C-03 Stripe (Checkout Sessions / PaymentIntents)
- **Pré-requisitos:** `STRIPE_SECRET_KEY` de **teste** (chave de sandbox), `STRIPE_WEBHOOK_SECRET`, `STRIPE_ENVIRONMENT` = teste. Não está no `render.yaml`; leitura por `configuration.ts`.
- **Ambiente:** S = conta de teste Stripe (`api.stripe.com` com chave de teste). Sem captura real.
- **Autenticação:** chave secreta de teste.
- **Conexão:** criar Checkout Session de valor de teste.
- **Funcional (S, aguarda aprovação):** pagamento com cartão de teste oficial; webhook assinado recebido.
- **Resultado esperado:** session com ID; evento assinado aceito; status refletido.
- **Evidência:** IDs de session e evento, HTTP, log sem chave.
- **Aprova se:** S concluído.
- **Bloqueia se:** chave `live` usada; webhook sem assinatura aceito.
- **Limitação:** homologação não executada (`homologacao-sandbox.md` e checklist de go-live).

### 3.4 C-04 Provedores genéricos (placeholder)
- **Status:** `implementado: false`, ocultados da tela (P3-01). **Não homologar.** Qualquer teste aqui seria falso positivo.

### 3.5 C-05 WhatsApp Business Cloud API (envio e status)
- **Pré-requisitos:** `WHATSAPP_CLOUD_API_TOKEN` (token de **envio**), `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_API_VERSION` (padrão `v26.0` se ausente; **se estiver definida como `v21.0` no Render, o padrão não se aplica**, P2-06), `WHATSAPP_TEMPLATE_TRANSACIONAL`, `WHATSAPP_TEMPLATE_IDIOMA`, `WHATSAPP_SECRET` (segredo do app Meta, decisão d).
- **Verificação GET:** o token de verificação do webhook **não tem nome autorizado** e **não existe no código**. Sem ele, a inscrição do webhook na Meta fica bloqueada. Não criar nome.
- **Ambiente:** S = número de **teste** da Meta com template **aprovado**, destinatário de teste cadastrado. R = número real e clientes reais, **proibido**.
- **Autenticação:** Bearer do token de envio; assinatura do webhook (HMAC) com `WHATSAPP_SECRET`.
- **Conexão:** leitura do número (`phone_number_id`) com o token de teste.
- **Funcional (S, aguarda aprovação):** envio de template a destinatário de teste; recepção de eventos de status (`sent`, `delivered`, `read`, `failed`) com assinatura válida; assinatura inválida recusada.
- **Resultado esperado:** `REQUEST_ACCEPTED` → `SENT` → `DELIVERED` → `READ`; `FAILED` terminal; atualização restrita à linha do `provider_message_id`.
- **Evidência:** `wamid` de teste, sequência de estados, HTTP, log sem token.
- **Aprova se:** envio de teste e sequência de estados completa com assinatura válida.
- **Bloqueia se:** `WHATSAPP_CLOUD_API_TOKEN` usado como segredo de webhook; mensagem enviada a número real; webhook aceito sem assinatura.
- **Limitação:** o webhook **não recebe eventos reais** até a Meta inscrever o endpoint, o que depende do token GET pendente. Central de Notificações (P2-07) não implementada.

### 3.6 C-06 SMTP (e-mail)
- **Pré-requisitos:** `SMTP_HOST`, `SMTP_PORT` (**obrigatória** para `smtpConfigurado()`, R-9), `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`. Confirmar `SMTP_SECURE`. Ver matriz §6.
- **Ambiente:** S = caixa de teste (provedor SMTP de teste ou caixa de homologação). Envio apenas a endereço de teste.
- **Autenticação:** usuário e senha do provedor de teste.
- **Conexão:** verificação `verify()` pela rota admin (`/api/admin/notificacoes/smtp/...`), que responde só `ok` ou motivo (`nao_configurado`, `dependencia_ausente`, `autenticacao_recusada`, `falha_conexao`), sem host, usuário ou senha.
- **Funcional (S):** e-mail de teste entregue ao endereço de teste do admin logado.
- **Resultado esperado:** `{ok:true}` e e-mail recebido.
- **Evidência:** motivo retornado (se falhar), identificador da mensagem do provedor, print sem endereço real de cliente.
- **Aprova se:** `verify()` ok e e-mail entregue na caixa de teste.
- **Bloqueia se:** envio a destinatário que não seja a caixa de teste; senha impressa em log.
- **Limitação:** SMTP real não testado nesta fase. Relatório diário não é disparado para validar (ver auditoria de segregação).

### 3.7 C-07 Mercado Livre (OAuth, pedidos por webhook, publicação)
- **Pré-requisitos:** `MERCADOLIVRE_CLIENT_ID`, `MERCADOLIVRE_CLIENT_SECRET`, `MERCADOLIVRE_REDIRECT_URI`, `MERCADOLIVRE_WEBHOOK_SECRET` (secret na query `?secret=`, R-5). **Não usar `MERCADOLIVRE_TOKEN`** (rota legada, R-1).
- **Ambiente:** L (suíte) → M (fixtures de `api.mercadolibre.com`) → S (conta de teste do ML, com aprovação). Sem produção.
- **Autenticação:** OAuth com a conta de teste; token por empresa.
- **Conexão:** `GET /users/me` (leitura).
- **Funcional:**
  - *Pedidos (S, aguarda aprovação; **não bloqueado** pela suspensão):* pedido de teste na conta de teste; notificação assinada recebida; pedido importado uma vez.
  - *Publicação:* **BLOQUEADA** pela suspensão. Nenhuma criação, edição ou alteração de preço/estoque em anúncio.
- **Resultado esperado:** `users/me` 200; webhook aceito com segredo; pedido importado sem duplicidade.
- **Evidência:** ID do pedido de teste, HTTP, log sem `secret` da query.
- **Aprova se:** pedido de teste importado uma vez via webhook assinado.
- **Bloqueia se:** segredo do webhook aparecer em log; publicação criada; pedido duplicado.
- **Limitação:** título não propaga a anúncio existente (P0-01); retry após timeout cobre a janela só parcialmente.

### 3.8 C-08 Nuvemshop (OAuth, pedidos, publicação)
- Ver §2 (contratos separados). Pedidos e OAuth em v1; publicação em 2025-03 (escrita bloqueada, R-15 aberto).

### 3.9 C-09 Instagram Shopping (Meta Graph, OAuth, webhook)
- **Pré-requisitos:** `INSTAGRAM_APP_ID`, `INSTAGRAM_APP_SECRET` (obrigatórias), `INSTAGRAM_REDIRECT_URI` (condicional), `INSTAGRAM_WEBHOOK_VERIFY_TOKEN` (nomes confirmados em `instagram.service.ts:135-137,159`). Ver matriz §7.
- **Ambiente:** S = app de teste da Meta e usuário de teste. Sem conta comercial real.
- **Autenticação:** OAuth com usuário de teste; assinatura do webhook com o secret do app.
- **Conexão:** leitura de perfil com usuário de teste.
- **Funcional (S, aguarda aprovação):** verificação GET do webhook (ver nota: `WEBHOOK_VERIFY_TOKEN` ausente responde 403); evento de teste assinado aceito.
- **Resultado esperado:** verificação responde o desafio; evento assinado aceito; sem assinatura recusado.
- **Evidência:** HTTP da verificação, ID do evento de teste, log sem token.
- **Aprova se:** verificação GET e evento de teste com assinatura válida.
- **Bloqueia se:** verificação aceita sem token; evento sem assinatura aceito.
- **Limitação:** Facebook como canal próprio não existe (C-10).

### 3.10 C-10 Facebook (canal próprio)
- **Status:** não existe no código como canal. Só Facebook Login dentro do fluxo Instagram. **Não há plano de homologação**; criar um exigiria implementação, fora desta fase.

### 3.11 C-11 WooCommerce (loja própria)
- **Pré-requisitos:** `WOOCOMMERCE_URL`, `WOOCOMMERCE_CK`, `WOOCOMMERCE_CS`, `WOOCOMMERCE_EMPRESA_ID` (sem ela, 409 em toda operação). Ver matriz §8.
- **Ambiente:** S = loja WordPress/WooCommerce de **teste** (não a loja pública). Sem sandbox oficial.
- **Autenticação:** chaves REST da loja de teste (`/wp-json/wc/v3`).
- **Conexão:** `GET` de status da loja (`statusLoja`).
- **Funcional (S, aguarda aprovação):** leitura de produtos e pedidos de teste. **Sem escrita de estoque** nesta fase.
- **Resultado esperado:** status 200; produtos e pedidos listados; `WOOCOMMERCE_EMPRESA_ID` correto.
- **Evidência:** HTTP e contagem; log sem chave.
- **Aprova se:** leitura de produtos e pedidos de teste.
- **Bloqueia se:** chaves de loja real usadas; escrita de estoque.

### 3.12 C-12 Webhooks de saída (admin, HMAC)
- **Pré-requisitos:** administrador; destino de teste controlado pelo responsável (URL própria de teste).
- **Ambiente:** L (`webhooks-saida-antissrf` 8/8, `url-publica` 22/22) → S = endpoint de teste sob controle da equipe.
- **Autenticação:** assinatura HMAC com segredo do webhook (gerado pelo sistema; não impresso).
- **Conexão:** `POST /api/webhooks/:id/testar` (evento de teste).
- **Funcional:** entrega com assinatura válida; reenvio manual.
- **Resultado esperado:** entrega 2xx registrada; assinatura verificável pelo destino de teste.
- **Evidência:** ID da entrega, HTTP, assinatura verificada no destino de teste.
- **Aprova se:** entrega de teste assinada e verificada.
- **Bloqueia se:** destino fora de allowlist; URL interna aceita (anti-SSRF); DNS rebinding (risco residual).

### 3.13 C-13 Melhor Envio (cotação, envio, rastreio)
- **Pré-requisitos:** credencial **por empresa** (`me_token`, cifrada no banco; `server/src/logistica.ts:156,168,175`). **Não é variável de ambiente.** Cadastro pela tela de configuração da empresa de teste.
- **Ambiente:** S = `https://sandbox.melhorenvio.com.br` (`logistica.ts:269`), escolhido pela configuração da empresa. Sem etiqueta paga.
- **Autenticação:** `Authorization: Bearer` com o token de sandbox (`logistica.ts:277`).
- **Conexão:** cotação de frete de teste (somente leitura).
- **Funcional:** cotação; **não gerar envio nem etiqueta paga**.
- **Resultado esperado:** lista de serviços com preço de teste.
- **Evidência:** HTTP e quantidade de serviços; log sem token.
- **Aprova se:** cotação de teste retornada.
- **Bloqueia se:** envio/etiqueta real gerada; token de produção.

### 3.14 C-14 Correios (cotação e rastreio; etiqueta não implementada)
- **Pré-requisitos:** credencial **por empresa** (`correios_senha`, cifrada no banco; `server/src/logistica.ts:168`). Não é variável de ambiente.
- **Ambiente:** S (somente leitura) quando houver credencial de teste. Não há host de sandbox identificado no código: **não presumir**.
- **Funcional:** cotação e rastreio de código de teste. Etiqueta não existe.
- **Aprova se:** cotação ou rastreio de teste.
- **Bloqueia se:** credencial de produção; qualquer postagem.

### 3.15 C-15 Focus NFe (fiscal)
- **Pré-requisitos:** credencial por empresa cadastrada no sistema (configuração do tenant, não variável global; `fiscalProvider.ts`). Host de homologação `homologacao.focusnfe.com.br` (código).
- **Ambiente:** S = homologação do provedor. **Nunca produção.**
- **Autenticação:** token da empresa de teste.
- **Funcional (S, aguarda aprovação):** emissão de NF-e de teste na homologação do provedor. Sem envio à SEFAZ de produção.
- **Resultado esperado:** status de homologação retornado.
- **Evidência:** referência da nota de teste, HTTP, log sem token.
- **Aprova se:** nota de homologação emitida e consultada.
- **Bloqueia se:** ambiente de produção; nota real emitida.

### 3.16 C-16 PlugNotas (fiscal)
- **Pré-requisitos:** credencial por empresa; ambiente sandbox/produção por empresa (código).
- **Ambiente:** S = sandbox `https://api.sandbox.plugnotas.com.br` (`server/src/fiscalProvider.ts:440`), escolhido por `cred.ambiente`.
- **Funcional, resultado, evidência, aprova/bloqueia:** análogos ao Focus NFe.

### 3.17 C-17 NF-e por variáveis globais (`NFE_*`, simulação)
- **Status:** `NFE_PROVIDER`, `NFE_API_KEY`, `NFE_MODO` (matriz §8). Modo simulação. **Não homologar como provedor.** Qualquer resultado é simulado.

### 3.18 C-18 Cloudinary (imagens)
- **Pré-requisitos:** `CLOUDINARY_URL` (declarada no `render.yaml`); `UPLOAD_PROVIDER` = `cloudinary` para ativar.
- **Ambiente:** S = cloud de **teste**, com imagem de teste.
- **Funcional:** upload e remoção de uma imagem de teste.
- **Resultado esperado:** URL pública retornada; remoção confirmada.
- **Evidência:** public ID de teste, HTTP.
- **Aprova se:** upload e remoção.
- **Bloqueia se:** cloud de produção usada para teste; imagem real de cliente.

### 3.19 C-19 BrasilAPI / ViaCEP (consulta pública)
- **Ambiente:** leitura pública sem credencial. R somente leitura com **CEP de teste**.
- **Funcional:** consulta de CEP de teste.
- **Aprova se:** resposta 200 com endereço.
- **Bloqueia se:** dado pessoal de cliente real usado como consulta de teste.

### 3.20 C-20, C-21, C-22
- **Não existem no código** (IA, Redis/BullMQ, S3/R2). **Não há plano.** Não tratar como conectores.

---

## 4. Ordem recomendada (quando houver aprovação)
1. Ambiente de homologação separado e PostgreSQL (§0.5).
2. Confirmar variáveis conforme matriz, sem valores impressos.
3. Gate Nuvemshop 2025-03 (leitura com os dois cabeçalhos, §2.2) — decide se a publicação pode ser reaberta.
4. Mercado Pago e PagBank (sandbox) e Stripe (sandbox).
5. WhatsApp: número de teste e template aprovado; depois o token GET (pendente).
6. SMTP: `verify()` e e-mail de teste.
7. Mercado Livre e Nuvemshop (pedidos e webhook; **sem publicação**).
8. Instagram.
9. Logística e fiscal (sandboxes).
10. Só então: decisão de go-live (do Diretor, não declarado).

---

## 5. Pendências que bloqueiam homologação
| # | Pendência | Quem resolve |
|---|---|---|
| P-1 | Ambiente de homologação separado | Diretor |
| P-2 | Nome e valor do token GET de verificação do WhatsApp (sem nome autorizado) | Diretor |
| P-3 | Cabeçalho da Nuvemshop 2025-03 (R-15) | **BLOQUEADO**: gate de leitura sem credencial de loja de teste; decisão do Diretor |
| P-4 | Host de OAuth da Nuvemshop (`nuvemshop.com.br` ou `tiendanube.com`) | Gate S |
| P-5 | `WHATSAPP_API_VERSION` real no Render (`v21.0` explícito?) | Diretor verifica |
| P-6 | Credenciais de sandbox de cada provedor | Responsável do negócio |
| P-7 | Credenciais de Melhor Envio e Correios são por empresa (não Render): confirmar que a empresa de teste está cadastrada | Responsável do negócio |
| P-9 | Go-live | Diretor (não declarado) |

## 6. Limitações desta fase
- Nenhum acesso a Render, Meta, provedores, produção ou credenciais.
- Nenhuma chamada de rede aos provedores.
- Nenhum teste S ou R executado. Todos os níveis acima de L estão marcados como pendentes.
- Contagens de teste da §1 são as medidas nesta fase, em execução direta dos arquivos indicados.

---

## 7. Atualização Fase 4.2 (riscos R-1, R-3, R-4, R-10, R-12, R-14, R-15)

Todos os itens abaixo são **pendentes**. Nenhum foi executado em homologação, provedor real ou produção. Os testes locais citados provam a lógica, não a integração.

| # | Risco | Passo de homologação (quando houver aprovação e ambiente) | Bloqueio atual | Nível alcançado |
|---|---|---|---|---|
| H-1 | R-3 | Subir a aplicação em homologação **sem** `DATABASE_URL` e confirmar 503 no health. Depois com banco de teste e confirmar 200 | Sem ambiente de homologação separado (P-1) | Local |
| H-2 | R-10 | Gravar o `<PREFIXO>_WEBHOOK_SECRET` dedicado no ambiente de teste. Enviar notificação assinada de teste e confirmar aceitação. Enviar uma sem assinatura ou com segredo errado e confirmar recusa | Sem credencial de sandbox PagBank (P-6) | Local |
| H-3 | R-4 | Chamar o cron sem `CRON_SECRET` (503), com token errado (401) e com Bearer correto (200). **Não** chamar com recorrências habilitadas em base real | Sem ambiente de homologação (P-1) | Local |
| H-4 | R-12 | Com SMTP de teste e dois endereços de duas empresas de teste, confirmar que cada um recebe **somente** o relatório da própria empresa. Confirmar que endereço sem vínculo não recebe | SMTP real não testável; sem ambiente (P-1) | Local |
| H-5 | R-14 | Nenhum passo até a decisão sobre a migração de `webhooks`/`webhook_entregas`. Depois: migração em base de teste, contagem de linhas `NULL`, criação com e sem empresa, leitura cruzada negada | Decisão do Diretor | Local |
| H-6 | R-15 | Gate de leitura (documento `gate-leitura-nuvemshop-2025-03.md`): três GET em loja de teste (variantes A, B e controle C). Nenhuma escrita | Sem credencial de loja de teste (P-3) | **Bloqueado** |
| H-7 | R-1 | Verificar que `POST /api/marketplace/sincronizar` responde 403 para gerente e operador, e 403 para administrador sem empresa no contexto (`server/src/marketplace.ts`, `sincronizarPedidos`) | Sem ambiente (P-1) | Local |

**Pendências da Fase 4.2 que permanecem:**
- **§3.13 (Melhor Envio) e §3.16 (PlugNotas)**: as premissas desses conectores não foram revalidadas nesta fase. Os riscos R-1 a R-15 não as incluem. Continuam como estavam na Fase 4.1.
- **P-3 (cabeçalho Nuvemshop 2025-03)**: bloqueado pelo gate R-15 (sem credencial).
- **Cron e fila de comércio**: o cron de relatórios (`cronScheduled`) ainda executa a fila de pagamentos (`runPaymentJobs`), a fila de publicações e lembretes de CRM. Não é recorrência, mas é fluxo financeiro/publicação. **Não alterado nesta fase** (fora da lista autorizada). Decisão do Diretor: manter, separar ou desligar esses passos do cron.

**Regra mantida.** Nenhum passo acima autoriza execução financeira real, envio real, criação/edição de anúncio ou reativação de publicação ML/Nuvemshop.

## 8. Atualização Fase 4.3 (R-1, R-4, R-10, R-14, R-15, R-3)

> Registro: `docs/auditoria/fase-4-3-registro.md`. Nada aqui é homologação externa. Mock, teste local e PostgreSQL
> local não contam como homologação de provedor.

| ID | Item | Tipo | Estado em 2026-11-04 | Evidência local | Bloqueio |
|---|---|---|---|---|---|
| H-8 | PagBank: confirmar o algoritmo de `x-authenticity-token` (token da conta vs. token de notificação) com **notificação real em sandbox** | homologação externa | **PENDENTE** | teste de rota (rede simulada) e unitário | sem credencial de sandbox em ambiente seguro; sem acesso ao painel (proibido nesta fase) |
| H-9 | Nuvemshop 2025-03: confirmar cabeçalho de autenticação (`Authorization` vs `Authentication`) | leitura GET | **BLOQUEADO (R-15)** | guarda `nuvemshop-gate-leitura.test.ts` (5/5) | sem credencial de loja de teste (nenhuma variável `NUVEMSHOP_*` de credencial no ambiente); nenhuma leitura realizada |
| H-10 | Mercado Livre e Nuvemshop: publicações | reativação | **NÃO REALIZADA (suspensas)** | testes de suspensão (cron, catálogo, E2E) | decisão f: reativação só após homologação e reconciliação |
| H-11 | Webhooks de saída com empresa: entrega HTTP real a endpoint de homologação do cliente | homologação | **PENDENTE** | teste de contrato estático e store em memória; PG 16.14 | sem endpoint de homologação definido pelo Diretor |
| H-12 | Gate PostgreSQL 16.14 (`test:pg`, banco novo) | integração local | **EXECUTADO; gate BLOQUEADO** por 13 ignorados do wrapper `psql` (ver registro §C) | `scripts/test-pg-gate.mjs` | 13 testes do wrapper `psql` não executados localmente (binário ausente) |
| H-13 | Agendador de produção com cinco jobs | operação | **PENDENTE** | rotas testadas localmente | configuração fora do repositório (decisão G1) |

Limitações desta fase:
- Nenhuma chamada a provedor (Mercado Livre, Nuvemshop, PagBank, Meta, SMTP) foi feita.
- Nenhum acesso a Render, painel de provedor ou credencial de produção.
- Nenhum conector foi marcado como homologado.

## 9. Atualização Ordem Final (pendências 2.1 a 2.8)

Este plano continua sem homologação declarada. Testes locais e sandbox não são homologação.

| Conector / item | Pré-requisito externo | Teste local | Sandbox | Operação real |
|---|---|---|---|---|
| Cinco jobs de cron (2.1) | `CRON_SECRET` e autorização G1 para agendar | `cron-timeout-concorrencia`, `cron-cliente-retentativa`, `cron-cliente-integracao-local` | Não aplicável | Não ativado |
| PagBank webhook (2.2) | `PAGBANK_WEBHOOK_SECRET` (G2) e token de conta | `pagbank-webhook-sem-vazamento` (3) e suítes existentes | Pendente de credencial | Não executado |
| Reconciliação de webhooks legados (2.3) | Backup lógico e autorização G3 | `webhook-reconciliacao-legados` (11) | Não aplicável | Não executado |
| Mercado Livre (2.4) | Contrato `MERCADOLIVRE_TOKEN_ESTATICO_CONTRATO`; credencial OAuth por empresa como destino | `marketplace-token-estatico-contrato` (6), `mercadolivre-leitura-somente-get` (8), `marketplace-seller-id`, `marketplace-legado-autorizacao`, `marketplace-autorizacao-rotas` | Pendente | Suspenso por padrão |
| Nuvemshop 2025-03 (2.5) | Evidência oficial dos endpoints de escrita e credencial de loja de teste (G6) | `nuvemshop-escrita-bloqueada` (5), suítes de publicação com dublê | Pendente | **Escrita bloqueada** (ADR-006) |
| PIX (2.6) | Credencial de sandbox declarada pelo Diretor | `commerce-pix-mock-flow` (mock), `commerce-orders-pix` (integração local), `pix-sandbox-opcional` (pulado) | Pendente | Não executado |
| Arquivos privados (2.7) | Nenhuma | `arquivos-politica-privados` (14), `arquivos-privados-segregacao-empresa` (2) | Não aplicável | Não aplicável |
| Admin, JWT_SECRET e ADMIN_PASSWORD (2.8) | Valores reais em produção (não lidos) | `admin-senha-producao` (5), `startup-producao-segredos` (8), `fase2-seguranca-credenciais` | Não aplicável | Não verificado no ambiente de produção |

**Ordem sugerida, quando houver autorização:** (1) configuração de segredos e verificação de inicialização;
(2) cron com `relatorios` apenas; (3) PagBank com credencial de sandbox; (4) Nuvemshop somente após evidência de escrita;
(5) Mercado Livre somente após contrato e decisão de reativação. Nenhuma etapa é autorizada por esta documentação.
