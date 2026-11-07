# Motor de Frete e Logística Multicanal

Módulo desacoplado de cotação, expedição, etiqueta, rastreamento e
reconciliação, integrado às duas lojas WooCommerce (RETAIL / WHOLESALE).

- Código: `modules/logistics/`
- Migração: `db/migrations/0102_logistics_engine.sql`
- Painel: `/dashboard/logistica` (aba **Multicanal**)
- API: `/api/logistics/*` (autenticada) e `/api/logistics/webhooks/:provider` (pública, assinada)

> **Princípio de honestidade.** O módulo **nunca finge** que integrou. Sem
> credencial, sem contrato ou com o motor desligado, toda operação devolve um
> **estado explícito** (`CREDENTIALS_MISSING`, `PROVIDER_UNAVAILABLE`,
> `QUOTE_FAILED`, `NO_SERVICE_AVAILABLE`, `INVALID_DESTINATION`) e o painel
> mostra o motivo. Nenhum valor de frete é inventado e nenhum endpoint de
> transportadora é presumido.

---

## 1. Arquitetura

O módulo é separado em camadas, sem acoplar regra comercial a API de operador:

| Camada | Pasta | Papel |
|---|---|---|
| Domínio | `domain/` | Contratos puros: `StatusLogistico`, `Modalidade`, `StoreKey`, validação de CEP/volumes, normalização de status, motor de regras. Sem rede. |
| Provedores | `providers/` | Contrato `CarrierAdapter`, HTTP externo com timeout/SSRF, registry e adaptadores. |
| Aplicação | `application/` | Cotação, contexto, remessa, rastreamento, reconciliação, painel, jobs do outbox. |
| Infra | `infrastructure/` | Config cifrada, recursos do store, inbox de webhook, segurança HMAC, auditoria. |
| Integração | `integration/` | Publicação do rastreio na loja de origem via outbox. |
| API | `api/` | Rotas autenticadas + router público de webhook. |

### Reuso, não reescrita

O ERP já possuía o contrato `ShippingProvider` (`server/src/logistica.ts`) com
adaptadores **reais** para Melhor Envio (agregador, API pública documentada) e
Correios (contrato corporativo), além do provedor `manual`. O motor novo
**consome a mesma implementação** por uma ponte (`ponteProvedorLegado`), apenas
traduzindo o vocabulário. Não existe uma segunda integração paralela.

Também são reusados, sem duplicar:

- `envios` / `envio_eventos` (tabelas canônicas de remessa e histórico);
- `commerce_outbox` (claim CAS, retry com backoff, dead-letter);
- `configuracoes` + `segredos.ts` (AES-256-GCM) para credenciais cifradas;
- o registry multi-loja do WooCommerce (`configStore`, `exigirStoreDaEmpresa`);
- o RBAC/escopo de empresa (`escopoDoAtor`, `checkAccess`).

---

## 2. Fluxo de cotação

1. O painel chama `POST /api/logistics/quote` com `venda_id` (e opcionalmente
   `provider` / `modalidade`).
2. O backend monta o contexto a partir da **venda persistida** (`montarContextoVenda`):
   CEP de origem, CEP de destino, peso total, dimensões, volumes, valor
   declarado, valor do pedido, modalidade e loja de origem.
3. `cotarFrete` carrega as **regras comerciais** ativas da empresa/loja, aplica-as
   e consulta o operador resolvido (cotação real). O resultado é **persistido**
   em `logistics_quotes` com origem, operador, modalidade, valor, prazo,
   validade, parâmetros e `fingerprint`.
4. A resposta traz `estado`, `motivo`, `quote_id`, `opcoes`, `melhor_opcao`.

**Revalidação no servidor.** `POST /api/logistics/shipments` recebe o
`quote_id`; o backend recarrega a cotação da empresa, exige `estado = OK` e
validade futura, e só então cria a remessa. O valor enviado pelo navegador
**nunca** é confiado.

### Estados de cotação

| Estado | Significado |
|---|---|
| `OK` | Cotação real obtida do operador |
| `CREDENTIALS_MISSING` | Operador não configurado (credenciais ausentes) |
| `PROVIDER_UNAVAILABLE` | Operador indisponível / timeout |
| `QUOTE_FAILED` | Operador respondeu com erro |
| `INVALID_DESTINATION` | CEP inválido ou não atendido |
| `NO_SERVICE_AVAILABLE` | Nenhum serviço atende o trecho/peso |

---

## 3. Fluxo de expedição

Ciclo: **PEDIDO → AGUARDANDO EXPEDIÇÃO → SEPARAÇÃO → EMBALAGEM → REMESSA →
ETIQUETA → COLETA → TRANSPORTE → ENTREGA**.

Estados normalizados (`domain/contract.ts`):

`pendente`, `cotado`, `pronto_expedicao`, `separacao`, `embalada`,
`etiqueta_pendente`, `etiqueta_gerada`, `gerado`, `postado`, `em_transito`,
`em_rota`, `entregue`, `tentativa_falha`, `devolvido`, `extraviado`,
`cancelado`, `erro`.

- A ordem dos status é a **ordem de progresso** (`pesoDoStatus`): estados
  terminais têm peso alto; estados de exceção são "laterais". Isso impede que um
  evento atrasado faça um pedido entregue **regredir** (`podeAvancar`).
- Suporta uma ou mais remessas por pedido, múltiplos volumes
  (`logistics_packages`), rastreio por volume, custo previsto × efetivo.
- Criação de remessa é **idempotente** (`idempotency_key`, default
  `envio:venda:<id>`): repetir a requisição devolve a mesma remessa.

---

## 4. Fluxo de rastreamento

Três entradas convergem em `aplicarEventosRastreio`:

1. **Webhook** do operador → inbox → job `logistics-webhook`;
2. **Polling** (contingência) → `sincronizarRastreio` → eventos com origem
   `polling`;
3. **Consulta manual** pelo painel.

Garantias:

- **Idempotência por evento**: `dedupe_key` + índice único parcial
  `uq_logistics_evento_dedupe`. Reprocessar não duplica.
- **Sem regressão**: `podeAvancar` recusa status que retrocedem.
- **Evento bruto preservado**: o payload original é gravado (auditoria).
- **Normalização determinística**: `normalizarStatus` traduz o vocabulário do
  operador para o do ERP; texto desconhecido **mantém** o status atual (nunca
  inventa progresso).
- **Isolamento por empresa/loja** e auditoria de toda alteração.

---

## 5. Estrutura do banco

Migração **aditiva e não destrutiva** `0102_logistics_engine.sql`:

| Tabela | Papel |
|---|---|
| `logistics_shipping_rules` | Regras comerciais (empresa/loja, prioridade, vigência, condições/ações) |
| `logistics_quotes` | Cotações persistidas (origem, parâmetros, opções, valor final, validade, fingerprint) |
| `logistics_packages` | Volumes da remessa (peso, dimensões, rastreio por volume) |
| `logistics_labels` | Etiquetas (URL externa/arquivo, mime, tamanho, estado, idempotência) |
| `logistics_webhook_inbox` | Inbox de webhooks (assinatura, payload, dedupe, retry) |
| `logistics_audit_logs` | Auditoria de operações logísticas |

Colunas adicionadas a `envios`: `store_key`, `modalidade`, `quote_id`,
`servico_nome`, `custo_previsto`, `custo_efetivo`.
Colunas adicionadas a `envio_eventos`: `status_normalizado`, `external_code`,
`origem`, `dedupe_key`.

Todas respeitam `empresa_id NOT NULL`, FK, índices para consulta por
pedido/rastreio/transportadora/loja/status, e unicidade para idempotência.
Rollback documentado no topo do arquivo (comandos comentados).

---

## 6. Endpoints

### Autenticados (`/api/logistics`)

| Método | Rota | Permissão |
|---|---|---|
| GET | `/providers` | gestão |
| PUT | `/providers/:slug` | admin |
| POST | `/providers/:slug/health` | gestão |
| GET | `/rules` | gestão |
| POST | `/rules` | gestão |
| PUT | `/rules/:id` | gestão |
| POST | `/quote` | gestão |
| GET | `/shipments` | gestão |
| POST | `/shipments` | gestão |
| GET | `/shipments/:id` | gestão |
| POST | `/shipments/:id/status` | gestão |
| POST | `/shipments/:id/label` | gestão |
| POST | `/shipments/:id/track` | gestão |
| POST | `/shipments/:id/publish-tracking` | gestão |
| GET | `/webhooks` | gestão |
| POST | `/webhooks/:id/reprocessar` | gestão |
| POST | `/webhooks/recuperar` | gestão |
| POST | `/reconcile` | gestão |
| GET | `/painel` | gestão |

"gestão" = `vendas:read` **e** perfil `admin` ou `gerente`; "admin" = perfil
`admin`. Toda empresa/loja vem do **ator autenticado** — nunca do corpo.

### Pública

| Método | Rota | Segurança |
|---|---|---|
| GET/HEAD | `/api/logistics/webhooks/:provider` | Liveness (validação da URL) |
| POST | `/api/logistics/webhooks/:provider` | HMAC-SHA256 do corpo cru + timestamp + rate limit |

---

## 7. Permissões

- `exigirGestao`: exige `checkAccess(getResource('vendas'), actor, 'read')` e
  perfil `admin`/`gerente`.
- `exigirAdmin`: só perfil `admin` altera configuração de transportadora.
- Recorte de empresa por `escopoDoAtor`; loja validada contra o registry
  (`exigirStoreDaEmpresa`). Empresa/loja arbitrária do cliente é rejeitada.

---

## 8. Eventos (outbox)

Ações processadas pelo worker do `commerce_outbox`:

| Ação | Efeito |
|---|---|
| `logistics-webhook` | Processa a entrega do inbox (rastreio) |
| `logistics-rastreio` | Polling de um envio específico |
| `logistics-woo-tracking` | Publica o rastreio na loja de origem |
| `logistics-reconciliar` | Reconciliação em lote |

Idempotência por chave; claim CAS; retry com backoff; dead-letter.

O cron `pedidos` também executa, em contingência e **desligados por padrão**:
`reconciliarLogisticaSeHabilitada` (reconciliação) e `pollRastreioLogistica`
(polling). Uma falha logística **não** derruba a sincronização das lojas.

---

## 9. Configurações (Render)

Ver também `docs/auditoria/matriz-configuracao-producao.md` (seção do motor
logístico). Nenhuma credencial de transportadora é versionada — todas ficam
cifradas em `configuracoes` e são preenchidas pelo painel.

| Variável | Padrão | Efeito |
|---|---|---|
| `LOGISTICS_ENABLED` | ausente (desligado) | Liga o motor. Sem ela, **modo seguro**: nenhum operador é chamado. |
| `LOGISTICS_QUOTE_ALLOW_DISABLED` | ausente | Com o motor desligado, permite cotar (homologação). |
| `LOGISTICS_DEFAULT_PROVIDER` | `manual` | Operador padrão quando a empresa não escolhe. |
| `LOGISTICS_DEFAULT_MODALIDADE` | `CIF` | Modalidade padrão. |
| `LOGISTICS_QUOTE_TTL_MIN` | 30 | Validade da cotação (min), teto 1440. |
| `LOGISTICS_SYNC_DRY_RUN` | ausente | Suprime a escrita do rastreio na loja (homologação). |
| `LOGISTICS_TRACKING_POLL_INTERVAL` | 1800 s | Intervalo do polling; `0` desliga. |
| `LOGISTICS_RECONCILIATION_ENABLED` | ausente | Liga a reconciliação periódica (exige `LOGISTICS_ENABLED`). |
| `LOGISTICS_EMPRESA_ID` | 1 | Empresa padrão para webhooks de operador. |
| `LOGISTICS_<PROVIDER>_EMPRESA_ID` | herda acima | Empresa por operador. |
| `LOGISTICS_<PROVIDER>_ENABLED` | ausente | Habilita operador com contrato pendente (homologação). |
| `LOGISTICS_<PROVIDER>_WEBHOOK_SECRET` | ausente | Segredo HMAC do operador. Ausente = endpoint **fecha** (falha fechada). |
| `LOGISTICS_WEBHOOK_MAX_BYTES` | 1 MiB | Teto do payload (máx 8 MiB). |
| `LOGISTICS_WEBHOOK_TOLERANCE_S` | 300 | Tolerância do timestamp (anti-replay); `0` desliga. |
| `LOGISTICS_WEBHOOK_RATE_WINDOW_MS` | 60000 | Janela do rate limit. |
| `LOGISTICS_WEBHOOK_RATE_MAX` | 120 | Entregas por janela/IP. |

As credenciais dos operadores REST (Jadlog, Total Express, Loggi, J&T Express)
são configuradas **por operador**, cifradas, com os campos:

- `<slug>_token` — token do contrato;
- `<SLUG>_BASE_URL_PRODUCAO` — URL base de produção (do contrato);
- `<SLUG>_BASE_URL_HOMOLOGACAO` — URL base de homologação (opcional);
- `<slug>_quote_path` — caminho da cotação;
- `<slug>_track_path` — caminho do rastreio (aceita `{codigo}`).

---

## 10. Credenciais necessárias

| Operador | Credenciais | Origem |
|---|---|---|
| `manual` | nenhuma | funciona sem credencial |
| `melhor_envio` | `me_token` | config legada (tela de logística) |
| `correios` | `correios_usuario`, `correios_senha`, `correios_codigo_administrativo` | config legada |
| `jadlog` | token + URLs/caminhos do contrato | contrato comercial |
| `total_express` | token + URLs/caminhos do contrato | contrato comercial |
| `loggi` | token + URLs/caminhos do contrato | contrato comercial |
| `jt_express` | token + URLs/caminhos do contrato | contrato comercial |

---

## 11. Como homologar cada operador

1. Obter o **contrato** e as credenciais com o operador.
2. No painel, aba **Multicanal → Operadores** (ou `PUT /api/logistics/providers/:slug`),
   cadastrar token, URL base e caminhos. **Nada é inventado**: os caminhos vêm do
   manual do contrato.
3. Rodar `POST /api/logistics/providers/:slug/health` e conferir
   `configurado`/`habilitado`/`motivo`.
4. Cotar um trecho de teste e conferir `estado = OK`.
5. Só então habilitar o operador (`habilitado: true` ou
   `LOGISTICS_<PROVIDER>_ENABLED`). Ativar sem credencial obrigatória é
   **recusado (409)**.

Melhor Envio e Correios já têm adaptadores reais reusados; a homologação
consiste em confirmar credenciais e ambiente.

---

## 12. Como cadastrar webhooks

1. Definir `LOGISTICS_<PROVIDER>_WEBHOOK_SECRET` (segredo do operador).
2. Cadastrar no operador a URL `https://<host>/api/logistics/webhooks/<slug>`.
3. O endpoint responde à verificação `GET`/`HEAD` (liveness).
4. Entregas são validadas por **HMAC-SHA256** do corpo cru + timestamp
   (anti-replay) + rate limit, e caem no inbox idempotente.

Sem segredo, o endpoint **recusa** toda entrega (falha fechada).

---

## 13. Como operar o painel

`/dashboard/logistica` → aba **Multicanal**:

- **Indicadores**: aguardando expedição, em separação, expedidos, em trânsito,
  entregues, atrasadas, ocorrências, falhas de integração, custo previsto ×
  efetivo.
- **Operadores**: capacidades, estado, motivo da indisponibilidade.
- **Remessas**: filtros por loja/operador, busca por pedido/rastreio/CEP.
- **Regras**: criar, ativar/desativar, prioridade e loja.
- **Ações**: reconciliar, reprocessar webhooks.

Estados de carregamento, vazio, erro e indisponibilidade são tratados. O painel
mostra o aviso de **modo seguro** quando o módulo está desligado.

---

## 14. Como reprocessar falhas

- Webhooks com erro: botão **Reprocessar webhooks**
  (`POST /api/logistics/webhooks/recuperar`).
- Entrega específica: `POST /api/logistics/webhooks/:id/reprocessar`.
- Reconciliação: `POST /api/logistics/reconcile` (corrige **apenas**
  divergências `AUTOMATICA`).

---

## 15. Como executar testes

```bash
npm run typecheck          # domínio + servidor + cliente
npm --workspace server test         # suíte do servidor (unit + integração)
npm --workspace client test         # suíte do cliente
npm test                            # tudo
npm run lint
npm run architecture:audit
npm run audit:menu
npm --workspace server run test:pg  # requer DATABASE_URL em PostgreSQL real
```

Testes específicos do módulo:

- `server/test/logistics-engine.test.ts` — 46 testes (segurança de webhook,
  SSRF, retry, dedupe, normalização, regras, adaptadores).
- `server/test/pg-logistics-engine.test.ts` — 6 testes (tabelas, constraints,
  índices, isolamento multiempresa) em PostgreSQL real.
- `client/src/pages/LogisticaPage.test.tsx` — painel multicanal (indicadores,
  operadores, remessas, regras, estados vazio/erro, modo seguro).

---

## 16. Limitações conhecidas

- **Jadlog, Total Express, Loggi e J&T Express** têm adaptador estruturalmente
  completo, mas **desabilitados** até haver contrato + credenciais +
  homologação. Os caminhos **não** são presumidos: vêm da configuração.
- Sem `LOGISTICS_ENABLED`, o módulo opera em modo seguro (nenhum operador é
  chamado).
- A publicação de rastreio na loja depende do pedido externo identificável
  (`WOO-<LOJA>-<id>`); vendas sem essa referência são ignoradas (não publicadas
  em loja errada).
- Geração de etiqueta só existe quando o contrato do operador oferece API; caso
  contrário, o procedimento é manual e documentado (nada é simulado).

---

## 17. Rollback seguro

1. Desligar o motor: remover `LOGISTICS_ENABLED` (e
   `LOGISTICS_RECONCILIATION_ENABLED`). O módulo para de chamar operadores.
2. Reverter a migração com os comandos comentados no topo de
   `db/migrations/0102_logistics_engine.sql` (remove as 6 tabelas e as colunas
   adicionadas, restaurando os CHECK anteriores). A migração é aditiva, então o
   ERP antigo continua funcionando com o esquema presente.
3. Nenhum dado de pedido/financeiro é alterado automaticamente pela logística.

---

## 18. Status real das integrações

| Operador | Adaptador | API oficial | Testes | Credenciais | Homologação | Produção |
|---|---|---|---|---|---|---|
| `manual` | sim | n/a | sim | n/a | n/a | habilitado |
| Melhor Envio | sim (ponte) | pública documentada | sim | a cadastrar | pendente | desabilitado |
| Correios | sim (ponte) | contrato corporativo | sim | a cadastrar | pendente | desabilitado |
| Jadlog | sim (REST) | via contrato | sim (mock) | ausente | pendente | desabilitado |
| Total Express | sim (REST) | via contrato | sim (mock) | ausente | pendente | desabilitado |
| Loggi | sim (REST) | via contrato | sim (mock) | ausente | pendente | desabilitado |
| J&T Express | sim (REST) | via contrato | sim (mock) | ausente | pendente | desabilitado |

**Adaptador implementado ≠ integração homologada.** Nenhum operador externo é
apresentado como "integrado" sem credencial e homologação.
