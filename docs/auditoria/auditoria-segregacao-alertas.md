# Auditoria de segregação — relatório diário de alertas e falhas de envio

**Fase 4.1 · Somente leitura de código e testes locais.** Nenhum e-mail foi enviado, nenhum
agendador foi acionado, nenhuma variável foi alterada e nenhum dado externo foi lido.
Esta auditoria NÃO amplia a distribuição do relatório.

Escopo: `server/src/scheduled.ts`, `server/src/alertasFalhas.ts`, `server/src/mail.ts`,
`server/src/index.ts` (rotas `/api/admin/*`), `server/src/webhooks.ts`,
`server/src/commerce/whatsappStatus.ts`, `server/src/resources.ts` (flag `empresa`),
`server/src/empresa.ts` (escopo), `db/schema.sql`.

---

## 1. Resumo das conclusões

| # | Pergunta | Resposta | Evidência |
|---|---|---|---|
| 1 | Quem recebe o relatório diário? | Os e-mails listados em `SCHEDULE_EMAILS` ou, se ausente, em `NOTIFICAR_EMAILS`. Lista de variável de ambiente, sem vínculo com usuário, empresa ou perfil. | `scheduled.ts:39-42` (`scheduleEmails`) |
| 2 | Os destinatários são autorizados? | **Não há verificação no código.** Qualquer endereço digitado na variável recebe. A autorização é apenas operacional (quem configura o Render). | `scheduled.ts:58-63` (`enviarRelatorio`) |
| 3 | A consulta é segregada por empresa? | **Não, no alerta de estoque e na seção de falhas.** Ambas leem o store diretamente, sem escopo de sessão. | `scheduled.ts:182-192`; `alertasFalhas.ts` (`coletarFalhasEntrega`) |
| 4 | Uma empresa pode ver dados de outra? | **Sim, pelo relatório por e-mail.** Quem recebe vê produtos, insumos, locais, saldos e contagens de falhas de **todas** as empresas. Pelas rotas HTTP de usuário de empresa, o relatório não aparece. | §3 |
| 5 | Quando o relatório sai? | Só quando `SCHEDULE_ALERTAS` ≠ `off` **e** alguém dispara: `GET /api/admin/scheduled/run` (admin) ou `POST /api/admin/scheduled/cron` (admin). Não há agendador interno. | §2 |

**Premissas corrigidas nesta fase** (registradas para não repetir o erro):
- Premissa anterior: "o relatório de falhas segrega por empresa". **Falsa.** O relatório lê sem escopo.
- Premissa anterior: "o relatório é enviado sem condição". **Falsa.** Exige `SCHEDULE_ALERTAS` diferente de `off` e destinatários.
- Premissa anterior: "falhas de webhook saem por empresa". **Falsa.** Webhooks não têm `empresa_id` (R-14).

---

## 2. Quem recebe e quando

### 2.1 Destinatários
- Fonte: `SCHEDULE_EMAILS`; se vazia, `NOTIFICAR_EMAILS` (`scheduled.ts:39-42`).
- Se a lista estiver vazia, o envio é cancelado com aviso no log (`scheduled.ts:60-63`).
- **Não há** checagem de: pertencimento do e-mail a usuário ativo, perfil, vínculo com empresa,
  consentimento ou lista de destinatários permitidos.
- `NOTIFICAR_EMAILS` é a mesma variável que dirige as notificações transacionais (`notifications.ts:43-44`).
  Quem altera uma delas altera as duas distribuições.

### 2.2 Condição de envio
- `SCHEDULE_ALERTAS` (padrão `off`, `scheduled.ts:44-46`): `daily` envia sempre; `weekly` só às segundas (`deveExecutar`).
- SMTP precisa estar configurado (`mail.ts`); sem ele, o envio não ocorre.

### 2.3 Disparo (nenhum agendador interno)
| Caminho | Quem pode chamar | Efeito colateral além do e-mail |
|---|---|---|
| `GET /api/admin/scheduled/run` → `runScheduled` | Perfil `admin` (`scheduled.ts:283`) | **Executa também `processarRecorrencias`**: gera lançamentos financeiros recorrentes. Não é só leitura. |
| `POST /api/admin/scheduled/cron` → `cronScheduled` | Admin, pela guarda de `/api/admin` (`index.ts:641`). Ver R-4: com `CRON_SECRET` definido, o Bearer de sessão não bate com o segredo, e o segredo não passa em `requireAuth` (`auth.ts:752`), então a rota responde 401. | Mesmo que `runScheduled`, pelo que se lê do código. |

Consequência: **o relatório não sai sozinho.** Ele depende de um agendador externo que não existe no
repositório e não está no `render.yaml`. Esse agendador, se existir, precisará de autenticação que o
código hoje não aceita (R-4). Esta é a principal lacuna operacional.

**Não disparar** `GET /scheduled/run` em homologação sem decisão: o efeito financeiro é real no banco.

---

## 3. Dados enviados e segregação

### 3.1 Alerta de estoque (`relatorioAlertas`, `scheduled.ts:182-240`)
| Dado | Origem | Filtro de empresa | Situação |
|---|---|---|---|
| Produto, local, saldo, mínimo | `estoques` + `produtos` | **Nenhum** (`s.list` direto) | Cross-tenant. `estoques` e `produtos` são `empresa: true` no CRUD genérico (`resources.ts`), mas o relatório ignora esse filtro. |
| Insumo, saldo, mínimo | `estoque_insumos` + `insumos` | **Nenhum** | Idem. |
| Limite de 20 linhas por tabela | `slice(0, 20)` | — | O contador do título mostra o total de **todas** as empresas. |

Observação: o relatório associa produto a estoque por `id` sem checar empresa. Se os ids forem globais
(sequência única), a associação funciona, mas mistura empresas na mesma tabela.

### 3.2 Seção de falhas de envio (Fase 7, `alertasFalhas.ts`)
| Fonte | Filtro de empresa | O que aparece | Situação |
|---|---|---|---|
| `commerce_outbox` (estado `ERRO`) | **Nenhum** (`list`, linha 110-115) | Contagem por `empresa_id` e tipo | Cross-tenant (revela ids e volume de cada empresa). |
| `webhook_entregas` (estado `erro`) | **Nenhum** | Contagem por evento; empresa sempre nula | Ver R-14. |
| `commerce_notificacoes` (`ERRO` ou `FAILED`) | **Nenhum** | Contagem por `empresa_id` e canal | Cross-tenant. |
| Payload, destinatário, URL, segredo, texto de erro | — | **Não aparecem** | Coberto por teste (§5). |

O código documenta a escolha ("job de sistema, como o relatório de estoque", `alertasFalhas.ts`).
Ou seja, é uma decisão de desenho, não um esquecimento. Mesmo assim, ela **expõe a
existência e o volume de falhas de cada empresa** a qualquer destinatário da lista.

### 3.3 Webhooks (R-14)
- `webhooks` e `webhook_entregas` **não têm `empresa_id`** (`db/schema.sql:1157-1180`; migração `0010`; `bootstrap.sql`).
- São recursos `internal: true` (`resources.ts:185`): fora da API genérica (`resources.ts:7169`).
- Listagem e entregas exigem `perfil === 'admin'` no handler (`webhooks.ts:91,345,508`).
- Logo, a seção "Webhooks de saída" mostra falhas sem empresa (“—”). O texto "por empresa" da seção
  não vale para webhooks.
- **Pendência de decisão:** se um administrador de uma empresa não deve ver webhooks de outras, o modelo
  de perfis precisa dizer se `admin` é global ou restrito à empresa. Não foi possível confirmar isso
  só com a leitura desta fase (**não verificado**).

---

## 4. Outras superfícies verificadas (multiempresa)

| Superfície | Achado | Situação |
|---|---|---|
| CRUD genérico `/api/:resource` | 154 recursos com `empresa: true` (filtro por empresa ativa, verificação por id e carimbo na criação) | Isolamento declarado na arquitetura; não auditado recurso a recurso nesta fase. |
| Status de entrega WhatsApp (`whatsappStatus.ts`) | Atualização por `provider_message_id` com `tryUpdateIf`; sem filtro de empresa na busca | **Testado** (§5): só a linha do wamid é alterada. A busca global é aceitável **sob a premissa** de que o `wamid` é único no provedor (não verificado com a Meta). |
| `WHATSAPP_PHONE_NUMBER_ID` | Variável única: **um número de envio para todas as empresas** | Decisão a confirmar com o Diretor (ver matriz §6). Não é isolamento por tenant. |
| `pgstore.list` | Sem escopo no próprio store (`pgstore.ts:374`). O isolamento depende de quem chama | Padrão de risco: qualquer leitura direta (como as deste relatório) ignora o escopo. |

---

## 5. Testes de isolamento criados (locais, sem rede)

Arquivo: `server/test/segregacao-multiempresa-alertas.test.ts` (6 testes, todos verdes).

| Teste | Tipo | O que prova |
|---|---|---|
| Resumo global de falhas | **Caracterização** de R-12 | As contagens de empresas 101 e 202 aparecem no mesmo relatório. Se o escopo for corrigido, o teste quebra de propósito. |
| Falha de webhook | **Caracterização** de R-14 | A falha não é atribuída a empresa (nula). Se webhooks ganharem empresa, o teste quebra de propósito. |
| Status WhatsApp por wamid | **Isolamento** | Evento do wamid da empresa 402 altera só a linha 402; a 401 permanece `REQUEST_ACCEPTED`. |
| HTML sem dados brutos | **Isolamento** | Payload, corpo de resposta, texto de erro, `Bearer` e URL não aparecem no HTML. O nome do evento (contagem) continua visível. |
| Execução manual exige admin | **Controle** | `runScheduled` com perfil `gerente` é recusado com 403. |
| Ordem das rotas `/api/admin/*` | **Estrutural** | A guarda `requireRole('admin')` vem antes de `scheduled/run`, `scheduled/cron` e `smtp/teste` em `index.ts`. |

Matriz de inventário de variáveis (`config-inventario-producao.test.ts`, 5 testes) cobre a
parte de configuração. Ver `matriz-configuracao-producao.md`.

**Limite:** são testes de função e de código-fonte. Não há teste HTTP ponta a ponta com duas empresas
reais, nem envio real de e-mail. Esses são pendentes de homologação.

---

## 6. Riscos e recomendações (não implementadas nesta fase)

| Risco | Severidade | Recomendação | Quem decide |
|---|---|---|---|
| **R-12** Dados de todas as empresas no e-mail de alertas, para destinatários de variável | **Alta** | Escolher entre: (a) relatório por empresa com destinatários vinculados à empresa; (b) relatório consolidado restrito a um perfil global, com destinatários cadastrados e autorizados. Antes disso, **não ampliar** a lista de `SCHEDULE_EMAILS`/`NOTIFICAR_EMAILS`. | Diretor |
| **R-4** Sem agendador e sem autenticação de cron | Alta | Definir o agendador (externo ou interno) e o mecanismo de autenticação. Código novo, fora desta fase. | Diretor |
| **R-14** Webhooks sem empresa | Média | Decidir se webhooks são globais (manter e rotular a seção) ou por empresa (migração de esquema). | Diretor |
| Efeito financeiro em `runScheduled` | Média | Separar a geração de recorrências do disparo de relatórios. | Diretor |
| Distribuição: destinatários não validados | Média | Validar destinatários contra usuários ativos ou lista explícita aprovada. | Diretor |
| Número único de WhatsApp para todas as empresas | A confirmar | Confirmar se é intencional. | Diretor |

**Não ampliar** a distribuição do relatório até decisão sobre R-12 e R-4.

---

## 7. Pendências e limitações
- **Não verificado:** se `perfil = admin` é global ou por empresa (afeta §3.3).
- **Não verificado:** envio real de e-mail; entrega ao destinatário; o conteúdo que chega ao provedor de e-mail.
- **Não verificado:** isolamento HTTP ponta a ponta com duas empresas reais.
- **Não executado:** `runScheduled`/`cronScheduled` (efeitos financeiros e de e-mail).
- Nenhum dado de produção foi lido.

---

## 8. Estado após a Fase 4.2 (R-12 e R-4)

As seções 1 a 3 acima descrevem o **estado anterior** à Fase 4.2 e continuam como registro de linha de base. O estado atual é este.

| # | Pergunta | Antes (Fase 4.1) | Depois (Fase 4.2) | Evidência |
|---|---|---|---|---|
| 1 | Quem recebe o relatório? | Qualquer e-mail em `SCHEDULE_EMAILS` ou `NOTIFICAR_EMAILS` | Só e-mails de **usuários vigentes vinculados à empresa** do dado (`SCHEDULE_EMAILS` ∩ usuários vinculados). Sem destinatário identificado, não envia | `server/src/scheduled.ts`; `alertas-isolamento-empresa.test.ts` |
| 2 | Destinatários são autorizados? | Não verificado no código | Sim para o relatório: vínculo com a empresa via `empresasDoUsuario` e `checkAccess` de leitura nos recursos do relatório | idem |
| 3 | A consulta é segregada por empresa? | Não (estoque, vendas, alertas e falhas liam sem escopo) | Sim: estoque, vendas e alertas filtram pela empresa do envio. Falhas de entrega por empresa leem só `commerce_outbox` e `commerce_notificacoes` (têm `empresa_id`) | `scheduled.ts`; `alertasFalhas.ts` (`coletarFalhasEntrega`) |
| 4 | Uma empresa vê dados de outra pelo relatório? | Sim | Não pelo desenho e pelos testes negativos cross-tenant. Webhooks ficam **fora** do relatório por empresa (sem `empresa_id`, R-14) | Testes R-12 |
| 5 | O relatório executa efeito financeiro? | Não (o `runScheduled` admin executava recorrências) | Não. Recorrências saem do relatório e do cron. Execução só pela rota admin com confirmação (R-4) | `scheduled.ts`; `financeiro.ts` (`cronRecorrencias`) |
| 6 | Quando o relatório sai? | Só com `SCHEDULE_ALERTAS` ≠ `off` e disparo manual/externo | Igual. Nenhum agendador interno foi criado | §2.3 |

**Conteúdo do e-mail.** Sem payloads, tokens, telefones, URLs sensíveis ou erros brutos. A seção de falhas mostra contagens e categorias agrupadas.

**Decisões pendentes do Diretor (não tomadas nesta fase):**
- **D-A.** Confirmar que o relatório por e-mail deve ser restrito a usuários vinculados. Efeito: endereços da lista sem vínculo deixam de receber.
- **D-B.** `notifications.ts` (`destinatarios()`, linhas 43–44) mantém envio global por `NOTIFICAR_EMAILS`. **Não alterado.** Mistura dados de empresas se alguma notificação carregar dados de tenant. Decidir: restringir por empresa ou manter com justificativa.
- **D-C.** Webhooks por empresa: depende da migração proposta em R-14.
- **D-D.** Cron (`cronScheduled`) ainda executa fila de pagamentos, fila de publicações, lembretes de CRM e recuperação de pedidos de marketplace. Não é recorrência. Decidir se permanece no cron.

**Limitação.** O envio real por SMTP não foi testado. O isolamento foi verificado por testes locais com envio injetado, não por entrega de e-mail.
