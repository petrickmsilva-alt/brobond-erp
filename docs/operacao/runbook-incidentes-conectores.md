# Runbook de incidentes — conectores (Fase 7)

Status: **rascunho operacional**. Escrito a partir do código e dos endpoints existentes. Nenhum passo abaixo foi executado em produção nesta rodada. Os passos marcados com **(verificar)** dependem de acesso que a sandbox não tem.

Regras gerais, valem para todos os conectores:

- **Não** copie segredos, tokens, payloads ou telefones para tickets, chats ou e-mails. O relatório de alertas já omite esses dados de propósito.
- Antes de qualquer reenvio, confirme a causa. Reenviar um evento que o provedor já aceitou pode duplicar publicação ou cobrança.
- Mudança de variável de ambiente no Render **exige aprovação expressa do Diretor**.

## 1. Onde o incidente aparece

| Sinal | Origem | Como ver |
|---|---|---|
| Alerta diário "Falhas de Envio" | Relatório diário (`SCHEDULE_ALERTAS=daily`, destinatários em `NOTIFICAR_EMAILS`) | E-mail. Mostra só contagens por empresa, tipo, evento e canal. |
| Status dos canais | `GET /api/admin/notificacoes/status` (admin) | Central de Notificações. Mostra `CONFIGURADO` por presença de variável, não prova de conexão (ver P2-07). |
| Fila de sincronização em `ERRO` | Recurso `commerce_outbox` (gerente ou superior) | Campo `ultimo_erro` (texto bruto: não copiar para fora do sistema). |
| Entrega de webhook de saída com `erro` | Recurso `webhook_entregas` | `POST /api/webhooks/entregas/:id/reenviar` para reenviar, após checagem da causa. |
| Notificação com `FAILED` (WhatsApp) | `commerce_notificacoes.provider_status` | Só aparece se o webhook de status estiver ativo (ver seção 4.2). |

## 2. Procedimento geral de triagem

1. Identifique o conector pelo alerta (empresa, tipo ou canal).
2. Verifique se o problema é **de configuração** (variável ausente, conta desconectada) ou **de provedor** (HTTP 5xx, timeout, recusa de regra de negócio). Configuração: corrija com aprovação. Provedor: aguarde e reprocesse.
3. Para outbox em `ERRO`, leia `ultimo_erro` dentro do sistema. Se a causa for transitória, use `POST /api/commerce/outbox/:id/reprocessar`. Se a causa for duplicidade ou dado inválido, **não reprocesse**; corrija o dado e registre a decisão.
4. Registre o incidente com data, empresa, conector, identificador interno do registro, causa e ação. Não inclua segredo.

## 3. Ação de contenção comum: suspender publicação ML/Nuvemshop

A publicação em marketplace fica **suspensa por padrão** (`PUBLICACAO_CANAIS_LIBERADOS` ausente ou sem o canal). Para conter um problema de publicação:

- Remover o canal da lista `PUBLICACAO_CANAIS_LIBERADOS` (no Render). Isso exige aprovação do Diretor.
- A suspensão bloqueia criação e edição de publicações. Não bloqueia pedidos, webhooks, estoque local, histórico nem identificadores.
- Reverter = devolver o canal à lista. Também exige aprovação.

## 4. Por conector

### 4.1 Mercado Livre e Nuvemshop (publicação)

- **Sintoma:** anúncio duplicado, publicação recusada, `ERRO` na fila de publicação.
- **Verificar:** se o SKU já existe no canal (`GET /products/sku/{sku}` na Nuvemshop; busca por `seller_sku` no ML) antes de qualquer novo envio. Verificar também se o canal está suspenso.
- **Ação:** não reprocessar um item cujo vínculo (`external_id`) é desconhecido. Reconciliar duplicados primeiro (P0-01: reconciliação **não executada**).
- **Escalar:** qualquer duplicidade em produção ao Diretor, com o número de registros afetados.

### 4.2 WhatsApp (envio e status)

- **Sintoma:** mensagens com `REQUEST_ACCEPTED` que nunca viram `DELIVERED`; `FAILED`.
- **Estado atual:** o envio registra `REQUEST_ACCEPTED` (aceite da Meta, **não** entrega). O webhook de status em `/api/webhooks/whatsapp` **recusa tudo** (401 no POST, 403 no GET) até que a fonte do segredo seja autorizada (decisão (d)). Enquanto isso, não há confirmação de entrega pelo sistema.
- **Verificar:** `WHATSAPP_API_VERSION` no Render. Se estiver definida como `v21.0`, ela continua valendo e expira em 21/01/2027 (**verificar**).
- **Ação:** não considerar falha por ausência de `DELIVERED` enquanto o webhook estiver inativo.
- **Escalar:** erro 131xxx ou de janela de 24h; número com template não aprovado (verificação de templates **não executada**).

### 4.3 SMTP (e-mail)

- **Sintoma:** relatórios ou convites não chegam.
- **Verificar:** `POST /api/admin/notificacoes/smtp/verificar` (prova a conexão com `verify()`, sem enviar). Resposta: `nao_configurado`, `dependencia_ausente`, `autenticacao_recusada`, `falha_conexao` ou `ok`.
- **Verificar entrega:** `POST /api/admin/notificacoes/smtp/teste` envia uma mensagem só ao e-mail do administrador logado.
- **Limitação:** a verificação não é persistida. `ok` vale só no momento da chamada. Nesta sandbox não há servidor SMTP real (**não executado**).
- **Ação:** `autenticacao_recusada` → revisar `SMTP_USER`/`SMTP_PASS` com o responsável pelo provedor. Não copie as credenciais.

### 4.4 Mercado Pago e PagBank (pagamento)

- **Sintoma:** webhook recusado (401), pagamento sem baixa.
- **Verificar:** assinatura do webhook e a presença do segredo em produção (**não verificado**: o sistema falha fechado sem segredo; isso é o comportamento esperado).
- **Ação:** pagamentos não são reenviados pelo sistema. Conciliar pela plataforma do provedor. Contrato de reentrega do PagBank: **não verificado** (P3-02).
- **Escalar:** qualquer diferença de valor ou pedido sem baixa ao financeiro.

### 4.5 Stripe

- **Estado:** há adaptador real no registro de provedores, mas a homologação em sandbox **não foi executada** (`docs/pagamentos/homologacao-sandbox.md`). Não considerar o fluxo validado em produção.
- **Ação:** mesma regra de pagamento da seção 4.4: conciliar pela plataforma do provedor e escalar diferenças ao financeiro.

### 4.6 Instagram

- **Sintoma:** webhook de mensagens recusado.
- **Verificar:** segredo do app Meta (`INSTAGRAM_APP_SECRET`) presente. O webhook é fail-closed.
- **Ação:** não reutilizar esse segredo em outro canal.

### 4.7 WooCommerce, Melhor Envio, Focus NFe e PlugNotas

- **Estado:** fora do escopo de correção desta rodada (Fase 5 não iniciada). Tratar qualquer incidente como **sem procedimento validado**: registrar, não improvisar, e escalar ao Diretor.

## 5. O que não está coberto por este runbook

- Reprocessamento em massa de outbox (decisão do operador, caso a caso).
- Rotação de segredos (plano em `docs/seguranca/plano-migracao-segredos.md`, não executado).
- Qualquer ação em conta real de marketplace ou provedor: deve ser feita pelo responsável da conta, com registro.
