# Matriz de evidências por conector (Fase 7)

Objetivo: separar o que foi **provado no código** do que foi **comunicado com o provedor**. Nenhuma linha abaixo pode ser lida como CONFORME. O critério de CONFORME está na seção 12 do relatório de auditoria e exige evidência de homologação ou produção com data, ambiente, identificador de transação e sem valores de segredo.

Legenda das colunas:

- **Local**: teste ou inspeção de código, sem rede. Mostra a lógica, não a integração.
- **Automatizado**: suíte do servidor (`npm test`). Também é local.
- **Homologação**: ambiente de teste do provedor. **Não executado** em nenhuma linha desta rodada.
- **Provedor real / produção**: comunicação funcional com a conta real. **Não executado.**

Resultado da suíte nesta rodada: servidor 1726 aprovados, 0 falhas, 76 ignorados (já ignorados antes); typecheck do cliente OK; gate `commerce:go-live` estrutural P0 41 OK. Essas execuções são locais.

| Conector | Mudança nesta rodada | Evidência local / automatizada | Homologação | Provedor real / produção |
|---|---|---|---|---|
| Mercado Pago | Webhooks fail-closed (Fase 2) | Teste da Fase 2 (14/14) | NÃO EXECUTADO | NÃO EXECUTADO |
| PagBank | Sem alteração de contrato; placeholder/registro (Fase 3) | Teste da Fase 3 (5/5). Reentrega P3-02 não verificada | NÃO EXECUTADO | NÃO EXECUTADO |
| Stripe | Adaptador real presente; sem alteração nesta rodada | Registro de provedores (Fase 3) | NÃO EXECUTADO (`homologacao-sandbox.md`) | NÃO EXECUTADO |
| Mercado Livre (publicação) | P0-01 corrigido; suspenso por padrão | `publicacao-canais-p0.test.ts` (5/5) | NÃO EXECUTADO | NÃO EXECUTADO. Reconciliação de duplicados NÃO EXECUTADA |
| Nuvemshop (publicação) | Migração 2025-03; suspensa por padrão | `publicacao-nuvemshop-2025` (9/9), `-fluxo` (3/3) | NÃO EXECUTADO (condição da decisão (b)) | NÃO EXECUTADO. Leitura de pedidos ainda em v1 |
| Instagram | Sem alteração nesta rodada | Webhook fail-closed (Fase 2) | NÃO EXECUTADO | NÃO EXECUTADO |
| WhatsApp (envio) | Versão padrão Graph `v26.0` (P2-06) | `commerce-pix-real-flow` atualizado (URL v26.0) | NÃO EXECUTADO | NÃO EXECUTADO. Verificação de templates NÃO EXECUTADA |
| WhatsApp (status / webhook) | Webhook fail-closed, HMAC, máquina de estados (P1-05) | `whatsapp-status-webhook.test.ts` (11/11 medido na Fase 4.1; a contagem 9/9 anterior estava desatualizada); mutação derruba 3 testes | NÃO EXECUTADO | NÃO EXECUTADO. **Inativo**: segredo não autorizado (decisão (d)) |
| SMTP | Verificação `verify()` e teste ao admin (P1-06) | `smtp-verificacao-admin.test.ts` (5/5), `enterprise-mail-security` (4/4) | NÃO EXECUTADO (sem servidor SMTP nesta sandbox) | NÃO EXECUTADO |
| Alerta de falhas (outbox / webhook / notificação) | Seção "Falhas de envio" no relatório diário (P2-08) | `alertas-falhas-entrega.test.ts` (6/6) | NÃO EXECUTADO | NÃO EXECUTADO. Envio agendado real não verificado |
| WooCommerce | Sem alteração nesta rodada (Fase 5 não iniciada) | — | NÃO EXECUTADO | NÃO EXECUTADO |
| Melhor Envio | Sem alteração nesta rodada (Fase 5 não iniciada) | — | NÃO EXECUTADO | NÃO EXECUTADO |
| Focus NFe / PlugNotas | Sem alteração nesta rodada (Fase 5 não iniciada) | — | NÃO EXECUTADO | NÃO EXECUTADO |

## Limitações que valem para toda a matriz

- Sem acesso a Render, Meta, provedores, marketplaces, SMTP real ou credenciais. Nada aqui consultou produção.
- Testes automatizados usam dublês (`fetch`, store em memória). Provam a lógica, não o contrato real do provedor.
- Valores de variáveis no Render não foram verificados (exceto onde indicado como premissa, como `NOTIFICAR_EMAILS`, `WHATSAPP_API_VERSION` e os segredos de webhook, sempre marcados como **não verificados**).
- O relatório diário de alertas foi alterado, mas o disparo agendado não foi executado de ponta a ponta (a função é interna ao agendador).

## Atualização Fase 4.2 (riscos R-1, R-3, R-4, R-10, R-12, R-14, R-15)

Os níveis desta tabela seguem a legenda acima. Nada aqui é CONFORME por existência de arquivo.

| Risco | Conector / área | Local | Automatizado | Homologação | Provedor real / produção |
|---|---|---|---|---|---|
| R-1 | Marketplace legado (sincronização) | Teste de RBAC (`marketplace-legado-autorizacao.test.ts`, 5) | Sim (suíte local) | NÃO EXECUTADO | NÃO EXECUTADO |
| R-3 | Banco obrigatório em produção | Teste (`banco-obrigatorio-producao.test.ts`, 4) | Sim | NÃO EXECUTADO | NÃO EXECUTADO |
| R-4 | Cron de relatórios e recorrências | Teste (`cron-recorrencias-contrato.test.ts`) | Sim | NÃO EXECUTADO | NÃO EXECUTADO. Nenhuma recorrência real disparada |
| R-10 | PagBank (webhook) | Teste (`pagbank-webhook-segredo.test.ts`, 9) | Sim | NÃO EXECUTADO | NÃO EXECUTADO. Sem notificação real |
| R-12 | Relatório de alertas e falhas | Testes cross-tenant (`alertas-isolamento-empresa.test.ts`, 6) | Sim | NÃO EXECUTADO (SMTP real não testável) | NÃO EXECUTADO |
| R-14 | Webhooks: resolução de empresa | Teste (`webhook-empresa-resolucao.test.ts`, 9). Sem migração | Sim | NÃO EXECUTADO | NÃO EXECUTADO |
| R-15 | Nuvemshop 2025-03 (gate de leitura) | Guarda (`nuvemshop-gate-leitura.test.ts`, 5). Não é prova de integração | Sim | **BLOQUEADO** (sem credencial de loja de teste) | NÃO EXECUTADO. Publicação suspensa |

**Observação.** Testes de contrato dos conectores e testes locais não contam como homologação. A coluna "Provedor real / produção" permanece NÃO EXECUTADO em todas as linhas.

## Atualização Fase 4.3 (R-1, R-4, R-10, R-14, R-15, R-3)

Legenda de tipo: **L** = local/unitário; **I** = integração local (PostgreSQL 16.14 real); **M** = mock;
**S** = sandbox de provedor; **P** = provedor real/produção.

| Item | Tipo de evidência | Resultado | Situação |
|---|---|---|---|
| R-12 segregação de notificações | L | 10/10 (RED 2/10) | corrigido localmente |
| R-4 cron por processo | L | 10/10 (RED 10/10); regressões 36/36 e 128/128 | corrigido localmente; reconfiguração do agendador pendente |
| R-1 autorização marketplace | L | 11/11 (RED 4/6) | corrigido localmente |
| R-14 webhooks com empresa | L + I | 11/11 (RED 9/9); PG 5/5 | corrigido localmente; entrega HTTP real pendente |
| R-10 PagBank segredo e fallback | L | 2/2 (RED 1/2); regressão 164/164 | corrigido localmente; confirmação do algoritmo em sandbox pendente |
| R-3 PostgreSQL obrigatório | L + I | 9/9; gate PG 16.14 (ver registro §C) | revalidado |
| R-15 Nuvemshop gate | L (guarda) | 5/5; **nenhuma leitura GET** | **BLOQUEADO** (sem credencial de homologação) |
| Suíte servidor (memória) | L | 1915 total; 1834 ok; 0 falhas; 81 ignorados (execução final) | executada; 1 falha de IPC do runner numa execução anterior, não reproduzida em duas execuções completas |
| PIX Mercado Pago (`commerce-pix-real-flow`) | **M (mock)** | aprovado; `fetch` simulado | não é prova de integração com o provedor real |
| Gate PG 16.14 | I | 410 aprovados, 0 reprovados, 13 ignorados (`psql`) | executado; **gate BLOQUEADO pela própria política** (ignorados críticos) |
| Conector PagBank homologado | — | — | **NÃO homologado** (sem evidência externa) |
| Conector Nuvemshop homologado | — | — | **NÃO homologado** |
| Conector Mercado Livre homologado | — | — | **NÃO homologado** |
