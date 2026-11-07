# DOMAIN-MAP — mapa de domínios (Fase 0)

**Data:** 2026-11-07 · **Branch:** `architecture/fase-0-blueprint`
**Base:** `docs/ERP-DOMAIN-MAP.md` (histórico) + `docs/ERP-3.0-ARCHITECTURE-BASELINE.md`
+ inspeção de `server/src/resources.ts`, `db/schema.sql`, `db/migrations/*.sql`,
`client/src/modules.ts`.

> **Regra.** Um domínio só é marcado 🟢 quando tem **tabela + API + (tela ou
> endpoint) + teste**. `🟡 parcial` = existe parte. `⏳ conceitual` = nada
> criado. `🟠 externo` = dependência de sistema de terceiro. Nenhum domínio
> artificial foi criado para "preencher a lista".

**Classificação pedida pela missão:** *Existente e funcional* · *Existente, mas
incompleto* · *Parcialmente implementado* · *Duplicado* · *Legado* · *Ausente*.

---

## 1. Domínios-alvo e estado real

| # | Domínio | Estado | Tabelas-âncora | API | Evidência |
|---|---|---|---|---|---|
| 1 | **ERP Core** | 🟢 Existente e funcional | `empresas`, `usuarios`, `usuario_empresas`, `clientes`, `fornecedores` | `empresa.ts`, `auth.ts`, CRUD genérico | `server/test/api.test.ts`, `multiempresa-*` |
| 2 | **PIM** (produto/SKU/variação/grade) | 🟢 Existente e funcional | `produtos`, `variacoes`, `grades`, `grade_tamanhos`, `tamanhos`, `cores`, `colecoes`, `medidas` | `resources.ts`, `variacoes.ts`, `medidas.ts` | `server/test/*produto*`, `categorias-listagem` |
| 3 | **Commerce** | 🟢 Existente e funcional | `commerce_produtos`, `commerce_publicacoes`, `commerce_precos`, `commerce_product_links` | `commerce/catalogo.ts`, `commerce/regras.ts` | `commerce-*` |
| 4 | **OMS** (Order Management) | 🟢 Existente e funcional | `commerce_pedidos`, `vendas`, `itens_venda`, `sales`, `sale_items` | `commerce/pedidos.ts`, `itens.ts` | `commerce-orders-pix`, `commerce-oracle` |
| 5 | **WMS** (Warehouse) | 🟢 Existente e funcional | `estoques`, `movimentacoes`, `locais`, `estoque_reservas`, `estoque_transferencias`, `inventarios` | `estoqueCanonico.ts`, `estoque.ts`, `estoqueTransferencia.ts` | `estoque*`, `tenant-isolamento-3-0` |
| 6 | **TMS** (Transportation) | 🟢 Existente e funcional | `envios`, `envio_eventos`, `logistics_quotes`, `logistics_labels`, `logistics_packages` | `modules/logistics`, `frete.ts`, `expedicao.ts` | `docs/LOGISTICA-MOTOR-MULTICANAL.md`, `logistics-*` |
| 7 | **Payments** | 🟢 Existente e funcional | `payment_*`, `gateway_cobrancas`, `gateway_configs`, `gateway_webhook_events` | `modules/payments`, `gateway.ts` | `docs/architecture/payment-engine.md`, `payment-engine.test.ts` |
| 8 | **CRM / CX** | 🟢 Existente e funcional | `crm_leads`, `crm_oportunidades`, `crm_funis`, `crm_etapas`, `crm_origens`, `crm_campanhas` | `crm.ts` | `crm-3-0*`, `crm-funil-configuravel` |
| 9 | **Marketplace / Omnichannel** | 🟢 Existente e funcional | `connectors`, `connector_events`, `sales`, `commerce_reconciliacao_divergencias` | `modules/connectors`, `marketplace.ts`, `commerce/woocommerce/` | `connectors.test.ts`, `woocommerce-multistore-rotas` |
| 10 | **Marketing / Loyalty / Creators** | 🟡 Existente, mas incompleto | `commerce_promocoes`, `commerce_cupons`, `creators_*` | `commerce/promocoes.ts`, `creators.ts` | `creators.test.ts` (módulos `planned`) |
| 11 | **BI / AI** | 🟢 Existente e funcional | `sales`, `sale_items`, `produto_abc` | `negocios.ts`, `prediction.ts`, `analytics.ts` | `bi-*`, `Dashboard.negocios.test` |
| 12 | **Platform / Security / Governance** | 🟢 Existente e funcional | `auditoria`, `sessoes`, `segredos`, `configuracoes` | `security.ts`, `auditChain.ts`, `observability.ts` | `auditoria*`, `auth-*`, `credential-scan` |

### 1.1 Domínios de negócio adicionais (fora dos 12 alvo, mas operacionais)

| Domínio | Estado | Tabelas-âncora | Evidência |
|---|---|---|---|
| **Vendas / PDV** | 🟢 | `vendas`, `itens_venda`, `pdv_*`, `propostas` | `calculos-oracle`, `pdv` |
| **Comissões / Representantes** | 🟢 | `representantes`, `comissoes_apuradas`, `comissoes_eventos`, `planos_comissao`, `venda_atribuicao` | `agente07-comissoes`, `agente07-carteira-representante` |
| **Compras / Suprimentos** | 🟢 | `compras`, `cotacoes_compra`, `fornecedor_homologacao` | `compras*` |
| **Produção** | 🟢 | `ordens`, `fichas_tecnicas`, `producao_recursos` | `producao-capacidade-mrp` |
| **Financeiro** | 🟢 | `lancamentos`, `fin_extrato_transacoes`, `cnab_*`, `categorias_financeiras` | `financeiro*` |
| **Fiscal** | 🟡 parcial | `documentos_fiscais`, `regras_fiscais`, `fiscal_execucoes` | `fiscal*` (sem SPED — GAP-P2-11/12) |
| **Impressão** | 🟢 | `print_*` | `docs/IMPRESSAO-P0-P6.md` |

---

## 2. Responsabilidade, dados e contratos por domínio

Formato: **responsabilidade · entidades principais · tabelas · APIs · eventos
publicados · eventos consumidos · dependências · fonte oficial · permissões ·
testes · estado · gaps.**

### 2.1 ERP Core

- **Responsabilidade:** identidade de tenant, usuários, autorização, cadastros
  mestres de pessoas (clientes/fornecedores) e a espinha dorsal CRUD.
- **Entidades:** Empresa, Usuário, Vínculo Usuário×Empresa, Cliente, Fornecedor.
- **Tabelas:** `empresas`, `usuarios`, `usuario_empresas`, `clientes`,
  `fornecedores`, `fornecedor_contatos`, `categorias*`, `centros_custo`.
- **APIs:** CRUD genérico (`services.ts`) + `empresa.ts`, `usuariosAdmin.ts`,
  `empresasApi.ts`, `empresasAcesso.ts`.
- **Eventos publicados:** nenhum (é a base; emite auditoria).
- **Eventos consumidos:** nenhum.
- **Dependências:** nenhuma (raiz).
- **Fonte oficial:** as próprias tabelas (`SOURCE-OF-TRUTH.md`).
- **Permissões:** `usuarios`/`empresas` são `adminOnly`/`minPerfil: admin`.
- **Testes:** `api.test.ts`, `multiempresa-*`, `auditoria-multiempresa`.
- **Estado:** 🟢 Existente e funcional.
- **Gaps:** nenhum P0/P1. Unidade de negócio/filial é papel de `empresas`.

### 2.2 PIM

- **Responsabilidade:** cadastro mestre de produto, SKU, variação, grade,
  tamanho, cor, coleção e medidas. **Autoridade do cadastro** — os canais
  consomem, não criam.
- **Entidades:** Produto, Variação, Grade, Tamanho, Cor, Coleção, Medida.
- **Tabelas:** `produtos`, `variacoes`, `grades`, `grade_tamanhos`, `tamanhos`,
  `cores`, `colecoes`, `medidas`, `medida_valores`, `produto_composicao`.
- **APIs:** `resources.ts` (CRUD), `variacoes.ts`, `medidas.ts`, `productSearch.ts`.
- **Eventos publicados:** implicitamente `ProductUpdated`/`PriceChanged` via
  publicação de canal (`commerce_publicacoes`).
- **Consumidos:** nenhum.
- **Dependências:** ERP Core (tenant), PIM é dependido por Commerce, OMS, WMS,
  BI.
- **Fonte oficial:** `produtos` (pai) — a **variação empresta SKU/cor/preço**;
  saldo e venda pertencem ao **produto pai** (`docs/ESTOQUE-CANONICO.md` §1).
- **Permissões:** `produtos` CRUD padrão; preço sensível (ver 2.3).
- **Testes:** `categorias-listagem`, `colecoes-listagem`, `variacoes`, oracle.
- **Estado:** 🟢 Existente e funcional.
- **Gaps:** `insumos.unidade` texto livre (GAP-P3-04); sem marca/subcategoria.

### 2.3 Commerce

- **Responsabilidade:** vitrine/catálogo, publicação em canais, preços por loja,
  vínculo produto×canal.
- **Tabelas:** `commerce_produtos`, `commerce_publicacoes`, `commerce_precos`,
  `commerce_product_links`, `commerce_configuracoes*`, `commerce_multistore`.
- **APIs:** `commerce/catalogo.ts`, `commerce/regras.ts`, `commerce/vitrine.ts`,
  `commerce/woocommerce/`.
- **Eventos publicados:** `publicacao` (outbox) → `processarPublicacao`.
- **Consumidos:** `sincronizacao` (estoque/pedido) da outbox.
- **Dependências:** PIM (produto), ERP Core (tenant).
- **Fonte oficial:** catálogo no ERP (`produtos`/`commerce_produtos`);
  **preço** é autoridade do ERP (`precoAutoridade.ts`); externo é evidência.
- **Permissões:** `commerce_*` multiempresa; painéis por loja com RBAC.
- **Testes:** `commerce-exposure`, `commerce-paineis-api`, `woocommerce-*`.
- **Estado:** 🟢 Existente e funcional.
- **Gaps:** `store_key` legado convivendo com multi-store (runbook Agente 07).

### 2.4 OMS

- **Responsabilidade:** ciclo de vida do pedido — do carrinho/ingestão à venda
  faturada, reserva e baixa.
- **Tabelas:** `commerce_pedidos`, `vendas`, `itens_venda`, `sales`,
  `sale_items`, `commerce_rastreio`.
- **APIs:** `commerce/pedidos.ts`, `itens.ts`, `modules/connectors/ingestion/`.
- **Eventos publicados:** `conversao` (outbox) → cria venda; hooks
  `sale-events.ts`, `eventosVenda.ts`.
- **Consumidos:** `sincronizacao` (woo-pedidos), webhooks.
- **Dependências:** PIM, WMS (reserva/baixa), Payments, TMS.
- **Fonte oficial:** `vendas` (operacional) × `sales` (read model) — **não** há
  segunda fonte (`docs/ERP-3.0-DUPLICITY-AUDIT.md` §2.1).
- **Permissões:** `vendas` multiempresa; ingestão escopada por conector.
- **Testes:** `commerce-orders-pix`, `commerce-oracle`, `commerce-cart-quantidade`.
- **Estado:** 🟢 Existente e funcional.
- **Gaps:** identidade de pedido entre lojas (A06-03 — **corrigido** no Agente 07).

### 2.5 WMS

- **Responsabilidade:** saldo, movimento, reserva, transferência, inventário.
- **Tabelas:** `estoques`, `movimentacoes`, `locais`, `estoque_reservas`,
  `estoque_transferencias`, `inventarios`, `itens_inventario`.
- **APIs:** `estoqueCanonico.ts`, `estoque.ts`, `estoqueTransferencia.ts`,
  `contagemCiclica.ts`, `wmsEnderecamento.ts`.
- **Eventos publicados:** movimentação (evento) → projeção `estoques`.
- **Consumidos:** reserva de checkout, baixa de faturamento.
- **Dependências:** PIM, ERP Core.
- **Fonte oficial:** **movimento ≠ saldo** — `movimentacoes` é o evento,
  `estoques` é a projeção; disponível = `físico − reservado − empenhado −
  bloqueado` (`docs/ESTOQUE-CANONICO.md` §2).
- **Permissões:** `estoques` RBAC `read`; escrita por papéis de estoque.
- **Testes:** `tenant-isolamento-3-0`, `contagem-ciclica`, `agente07-*`.
- **Estado:** 🟢 Existente e funcional.
- **Gaps:** contagem cíclica automatizada por curva (GAP-P2-16).

### 2.6 TMS

- **Responsabilidade:** cotação de frete, remessa, etiqueta, rastreio, entrega.
- **Tabelas:** `envios`, `envio_eventos`, `logistics_quotes`,
  `logistics_shipping_rules`, `logistics_labels`, `logistics_packages`,
  `logistics_webhook_inbox`, `logistics_audit_logs`.
- **APIs:** `modules/logistics/api/*`, `frete.ts`, `expedicao.ts`.
- **Eventos publicados:** ações `logistics-*` na outbox.
- **Consumidos:** webhooks de transportadora (`logistics_webhook_inbox`).
- **Dependências:** OMS, ERP Core.
- **Fonte oficial:** `envios`/`envio_eventos` (não duplicar em novo módulo).
- **Permissões:** `envios` RBAC; webhook público assinado.
- **Testes:** `logistics-*`, `docs/LOGISTICA-MOTOR-MULTICANAL.md`.
- **Estado:** 🟢 Existente e funcional (transportadoras sem contrato nascem
  **desabilitadas**).
- **Gaps:** nenhum P0. Homologação externa pendente por contrato.

### 2.7 Payments

- **Responsabilidade:** motor único de pagamentos (autorização, liquidação,
  estorno, repasse, disputa, conciliação).
- **Tabelas:** `payment_*` (intents, charges, disputes, payouts…),
  `gateway_cobrancas`, `gateway_configs`, `gateway_webhook_events`.
- **APIs:** `modules/payments/api/routes.ts`, `gateway.ts`.
- **Eventos publicados:** `payment_status` (webhook → outbox).
- **Consumidos:** webhooks de provider (assinados).
- **Dependências:** OMS.
- **Fonte oficial:** Payment Engine é a **única** autoridade de pagamento;
  status de pedido **não** prova liquidação.
- **Permissões:** `payment_*` por endpoint próprio (escopo por cobrança).
- **Testes:** `payment-engine.test.ts`, `commerce-pagamentos-api`.
- **Estado:** 🟢 Existente e funcional.
- **Gaps:** nenhum P0.

### 2.8 CRM / CX

- **Responsabilidade:** lead → oportunidade → conversão; funil configurável;
  agenda; score; painel de conversão; Customer 360.
- **Tabelas:** `crm_leads`, `crm_oportunidades`, `crm_funis`, `crm_etapas`,
  `crm_origens`, `crm_campanhas`, `crm_oportunidade_estagio_historico`.
- **APIs:** `crm.ts`.
- **Eventos publicados:** nenhum (emite auditoria + histórico de estágio).
- **Consumidos:** `crm` (cron de lembretes).
- **Dependências:** ERP Core, Vendas.
- **Fonte oficial:** `crm_*`; **não** duplica representantes/metas/comissões.
- **Permissões:** `crm_*` multiempresa; gestor+ para funil.
- **Testes:** `crm-3-0*`, `crm-funil-configuravel`, `crm-conversao`.
- **Estado:** 🟢 Existente e funcional.
- **Gaps:** integridade cross-tenant no banco (GAP-P2-04); notificação ativa de
  lembrete (GAP-P2-14).

### 2.9 Marketplace / Omnichannel

- **Responsabilidade:** ingestão de pedidos multicanal, publicação, reconciliação
  ERP × loja, divergências.
- **Tabelas:** `connectors`, `connector_events`, `connector_oauth_states`,
  `sales`, `commerce_reconciliacao_divergencias`, `commerce_sync_state`.
- **APIs:** `modules/connectors/*`, `marketplace.ts`, `commerce/woocommerce/*`.
- **Eventos publicados:** `sincronizacao` (woo-estoque, woo-pedidos,
  woo-publicacao, woo-webhook).
- **Consumidos:** webhooks de canal.
- **Dependências:** PIM, OMS, WMS.
- **Fonte oficial:** `sales` (read model de ingestão) → cria `vendas`; ERP é a
  autoridade de preço/estoque.
- **Permissões:** escopo por conector/loja; painéis por tenant.
- **Testes:** `connectors.test.ts`, `woocommerce-multistore-rotas`,
  `commerce-reentrega-concorrente`.
- **Estado:** 🟢 Existente e funcional.
- **Gaps:** ADR-008 §6 (relação `/loja` × RETAIL) — **decidido nesta missão**.

### 2.10 Marketing / Loyalty / Creators

- **Responsabilidade:** promoções, cupons, creator commerce.
- **Tabelas:** `commerce_promocoes`, `commerce_cupons*`, `creators_*`.
- **APIs:** `commerce/promocoes.ts`, `creators.ts`.
- **Estado:** 🟡 Existente, mas incompleto (módulos `planned`).
- **Gaps:** GAP-P3-03 (8 módulos `planned`).

### 2.11 BI / AI

- **Responsabilidade:** projeção analítica, dashboards, ABC, previsão.
- **Tabelas:** `sales`, `sale_items`, `produto_abc`.
- **APIs:** `negocios.ts`, `prediction.ts`, `commerce/analytics.ts`.
- **Fonte oficial:** `sales` é **read model** (nunca fonte operacional).
- **Permissões:** `negocios.aplicarEscopoEmpresaBi` valida concessão.
- **Estado:** 🟢 Existente e funcional.
- **Gaps:** nenhum P0.

### 2.12 Platform / Security / Governance

- **Responsabilidade:** autenticação, RBAC, tenancy, auditoria, observabilidade,
  segredos, backup, configuração.
- **Tabelas:** `auditoria`, `sessoes`, `login_tentativas`, `segredos`,
  `configuracoes`.
- **APIs:** `security.ts`, `auth.ts`, `auditChain.ts`, `observability.ts`,
  `backup.ts`, `configSistema.ts`.
- **Estado:** 🟢 Existente e funcional.
- **Gaps:** nenhum P0.

---

## 3. Grafo de dependências (resumo — detalhe em `DEPENDENCY-MAP.md`)

```
Platform/Security ──(transversal)──► todos os domínios
ERP Core (tenant, auth, store, resources)
   ├── PIM ─────────────► Commerce ──► OMS ──► Payments
   │                        │           │
   │                        │           ├──► WMS ──► TMS
   │                        │           └──► BI (read model)
   ├── Compras ──► WMS
   ├── Produção ──► WMS
   ├── CRM ──► Vendas/OMS
   ├── Marketplace ──► PIM + OMS + WMS
   └── Financeiro / Fiscal ◄── OMS + Compras + Vendas
```

---

## 4. Riscos de fronteira identificados

| Achado | Domínio | Evidência | Severidade |
|---|---|---|---|
| `vendas` × `sales` poderiam ser confundidos como duplicidade | OMS/BI | `docs/ERP-3.0-DUPLICITY-AUDIT.md` §2.1 — **bounded context**, não duplicidade | P3 (documental) |
| `estoques` × `estoque_insumos` | WMS | idem §2.2 — bounded context | P3 |
| `modules/*` importa `server/src/*` (infra reusada) | Modular | `modules/logistics/infrastructure/*` | P2 (fronteira controlada — ver `DEPENDENCY-MAP.md`) |
| CRM sem FK composta cross-tenant no banco | CRM | GAP-P2-04 | P2 |
| Loja nativa `/loja` × RETAIL Woo | Commerce | ADR-008 §6 | **decidido** — ver `NATIVE-STORE-DECOMMISSION.md` |

---

*Próximo documento: [`DEPENDENCY-MAP.md`](DEPENDENCY-MAP.md).*
