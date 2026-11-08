# CONTEXT-MAP — bounded contexts e contratos (Fase 0)

**Data:** 2026-11-07 · **Branch:** `architecture/fase-0-blueprint`

> **Regra.** Um domínio **não** acessa tabela interna de outro domínio sem
> contrato documentado. Este documento declara, para cada interação: **quem é o
> dono**, **quem pode ler**, **quem pode alterar**, o **contrato de entrada e
> saída**, a **validação**, a **autorização**, o **tratamento de erro**, a
> **idempotência**, a **consistência** e a **auditoria**.

---

## 1. Contextos delimitados

| Contexto | Núcleo | Tabelas internas (privadas) | Exposto a outros contextos |
|---|---|---|---|
| **Core/Tenancy** | identidade, empresa, usuário, RBAC | `empresas`, `usuarios`, `usuario_empresas`, `sessoes`, `auditoria` | `escopoDoAtor`, `assertRegistroDaEmpresa`, `checkAccess`, `enfileirarOutbox` |
| **PIM** | produto/SKU/variação/grade | `produtos`, `variacoes`, `grades`, `tamanhos`, `cores`, `colecoes` | `getResource('produtos')`, `estoqueCanonico`, `productSearch` |
| **WMS** | estoque, reserva, transferência, inventário | `estoques`, `movimentacoes`, `estoque_reservas`, `estoque_transferencias` | `disponivelDoProdutoVendavel`, `criarReservaInterna`, `faturarVenda` |
| **Commerce** | catálogo, publicação, preço por loja | `commerce_produtos`, `commerce_publicacoes`, `commerce_precos` | `precoAutoridade`, `processarPublicacao`, `catalogo` |
| **OMS** | pedido, checkout, venda | `commerce_pedidos`, `vendas`, `itens_venda` | `criarCheckout`, `converterPedido`, `faturarVenda` |
| **Payments** | motor de pagamento | `payment_*`, `gateway_cobrancas` | `paymentEngine.createForOrder`, `checkoutMethods` |
| **TMS** | frete, remessa, rastreio | `envios`, `envio_eventos`, `logistics_*` | `logisticsRouter`, `frete`, `processarAcaoLogistica` |
| **Financeiro** | lançamento, baixa, extrato, CNAB | `lancamentos_financeiros`, `fin_extrato_*`, `cnab_*` | lançamento por evento de venda/compra |
| **Fiscal** | documento fiscal, regra, execução | `documentos_fiscais`, `regras_fiscais`, `fiscal_execucoes` | emissão por venda |
| **CRM** | lead, oportunidade, funil | `crm_*` | `crm.ts` (conversão → venda) |
| **Marketplace** | ingestão multicanal | `connectors`, `connector_events`, `sales` | `upsertIngestedSale`, `reconciliarItensDaIngestao` |
| **BI** | read model analítico | `sales`, `sale_items`, `produto_abc` | `negocios.ts` (somente leitura) |

---

## 2. Contratos entre contextos (tabela formal)

### 2.1 OMS → WMS (reserva e baixa)

| Campo | Valor |
|---|---|
| Dono da informação | WMS (`estoque_reservas`, `movimentacoes`) |
| Pode consultar | OMS, Commerce, PDV, BI (via `estoqueCanonico`) |
| Pode alterar | **apenas** WMS |
| Contrato de entrada | `criarReservaInterna({empresaId, produtoId, tamanhoId, localId, quantidade, pedidoChave})` |
| Contrato de saída | `{reservaId, disponivel}` |
| Validação | tenant, faixa de quantidade, célula canônica (empresa, produto, tamanho, local) |
| Autorização | escopo do ator (representante não vê outra carteira) |
| Erro | 404 para recurso de outro tenant; 409 para saldo insuficiente |
| Idempotência | `uq_estoque_reservas_checkout` por pedido |
| Consistência | transação **SERIALIZABLE** no checkout |
| Auditoria | evento de reserva + `auditoria` |

### 2.2 Commerce/OMS → Payments (cobrança)

| Campo | Valor |
|---|---|
| Dono | Payments |
| Pode consultar | OMS, Financeiro |
| Pode alterar | **apenas** Payments |
| Entrada | `paymentEngine.createForOrder({empresaId, pedido, valor, meio})` |
| Saída | `{cobrancaId, status, pixPayload?}` |
| Validação | valor calculado no **servidor** (o cliente não envia total) |
| Autorização | endpoint público com rate limit + assinatura de webhook |
| Erro | 502 com mensagem PT-BR quando o provider falha |
| Idempotência | `external_reference = checkout:<pedido>` |
| Consistência | outbox para efeitos externos |
| Auditoria | `gateway_webhook_events` + auditoria |

### 2.3 Marketplace → OMS (ingestão)

| Campo | Valor |
|---|---|
| Dono | Marketplace (`sales`) → cria `vendas` (dono: OMS) |
| Pode consultar | BI, painéis |
| Pode alterar | **apenas** ingestão |
| Entrada | pedido normalizado do canal (idempotente) |
| Saída | `vendas` + `itens_venda` + `sales` |
| Validação | SKU conhecido (nunca inventa cadastro), preço decidido pelo ERP |
| Autorização | escopo por conector/loja/tenant |
| Erro | 404 pedido inexistente; 409 conflito de identidade |
| Idempotência | `reference` + índice único de `sales` + retentativa de corrida |
| Consistência | `runInTransactionComCorrida` (23505/40001/40P01) |
| Auditoria | `connector_events` + auditoria |

### 2.4 OMS → TMS (envio)

| Campo | Valor |
|---|---|
| Dono | TMS (`envios`) |
| Pode consultar | OMS, portal |
| Pode alterar | **apenas** TMS |
| Entrada | venda faturada + endereço + itens |
| Saída | `{envioId, rastreio, etiqueta}` |
| Validação | transportadora com contrato (senão **desabilitada**) |
| Autorização | RBAC `envios`; webhook público **assinado** |
| Erro | `logistics_webhook_inbox` guarda falha; não derruba o ERP |
| Idempotência | chave de evento por entrega |
| Consistência | outbox (`logistics-*`) |
| Auditoria | `logistics_audit_logs` |

### 2.5 OMS → Financeiro (lançamento)

| Campo | Valor |
|---|---|
| Dono | Financeiro (`lancamentos_financeiros`) |
| Pode consultar | BI |
| Pode alterar | **apenas** Financeiro |
| Entrada | documento de origem (`documento_origem_recurso`/`_id`) |
| Saída | lançamento/parcela/baixa |
| Validação | competência × data; débito/crédito juntos (CHECK) |
| Autorização | RBAC financeiro |
| Erro | 409 para período travado |
| Idempotência | chave do documento de origem |
| Consistência | mesma transação do fato |
| Auditoria | auditoria |

### 2.6 CRM → OMS (conversão de oportunidade)

| Campo | Valor |
|---|---|
| Dono | CRM (`crm_oportunidades`) → cria venda (dono: OMS) |
| Pode consultar | Vendas |
| Pode alterar | CRM (oportunidade) |
| Entrada | `converterOportunidade(id)` |
| Saída | `vendas` + histórico de estágio |
| Validação | funil/etapa da empresa; motivo de perda obrigatório |
| Autorização | gestor+ para funil; carteira do representante |
| Erro | 404 cross-tenant; 409 estado inválido |
| Idempotência | conversão única por oportunidade |
| Consistência | valida + atualiza + histórico em **uma** transação |
| Auditoria | `crm_oportunidade_estagio_historico` + auditoria |

---

## 3. Contrato genérico do kernel (o que todo domínio herda)

O CRUD genérico é dirigido por `resources.ts`. Todo recurso com `empresa: true`
herda, **sem código adicional**:

| Garantia | Implementação |
|---|---|
| Recorte de tenant na leitura | `aplicarFiltroEmpresa` (descarta `f.empresa_id` do cliente) |
| 404 para recurso de outro tenant | `assertRegistroDaEmpresa` |
| Carimbo de empresa na criação | `carimbarEmpresa` |
| Empresa imutável na edição | `protegerEmpresaNaEdicao` |
| Validação de referências entre tenants | `validarReferenciasDaEmpresa` |
| RBAC de leitura/escrita | `checkAccess` (`minPerfil`, `adminOnly`, `minPerfilEscrita`) |
| Recorte de carteira (representante) | `aplicarFiltroCarteira` / `foraDaCarteira` |
| Auditoria com empresa | `empresaDoRegistroAudit` |
| Validação tipada de entrada | `validate.ts` (parsers por `FieldType`) |

**Regra:** um módulo novo **não** reimplementa essas garantias — ele declara o
recurso e usa o kernel. Reimplementar é a origem clássica de vazamento de tenant.

---

## 4. Fronteiras violáveis (riscos) e regra de contenção

| Fronteira | Risco | Contenção |
|---|---|---|
| `modules/*` → `server/src/*` | Importar **regra de negócio** de um domínio | Permitido apenas infra (`store`/`resources`/`segredos`/`errors`/`utils`) |
| Commerce → WMS | Escrever saldo direto | Proibido: só via `movimentacoes` |
| BI → OMS | Alterar operação | Proibido: `sales` é read model |
| Marketplace → PIM | Criar cadastro | Proibido: "nunca inventa cadastro" |
| Ingestão → preço | Adotar preço externo | Proibido: preço é evidência |

---

*Próximo documento: [`TARGET-ARCHITECTURE.md`](TARGET-ARCHITECTURE.md).*
