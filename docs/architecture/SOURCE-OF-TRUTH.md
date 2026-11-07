# SOURCE-OF-TRUTH — inventário das fontes oficiais (Fase 0)

**Data:** 2026-11-07 · **Branch:** `architecture/fase-0-blueprint`
**Método:** cruzamento de `server/src/resources.ts`, `db/schema.sql`,
`db/migrations/*.sql`, `server/src/*` e
`docs/ERP-3.0-DUPLICITY-AUDIT.md` / `docs/ERP-3.0-MASTER-DATA-AUDIT.md`.

> **Regra.** Uma informação tem **uma** fonte oficial. Se houver duas, a segunda
> é **projeção / cache / cópia de integração / snapshot / legado** — nunca uma
> segunda autoridade. Onde a autoridade **não** está clara, o item aparece como
> **GAP** e a tabela não é escolhida arbitrariamente.

---

## 1. Matriz de autoridade (entidades críticas)

| Entidade | Fonte oficial | Projeções / cópias | Escritores autorizados | Observações |
|---|---|---|---|---|
| **Empresa (tenant)** | `empresas` | — | `empresasApi.ts` (admin) | fronteira de dados |
| **Usuário** | `usuarios` | — | `usuariosAdmin.ts`, `auth.ts` | identidade, não tenant |
| **Vínculo usuário×empresa** | `usuario_empresas` | — | `empresasAcesso.ts` | concessão de acesso |
| **Perfil / permissão** | `usuarios.perfil` + `resources.ts` (`minPerfil`/`adminOnly`) | menu do front | `auth.ts`/`services.ts` | RBAC é do servidor |
| **Produto** | `produtos` | `commerce_produtos` (vitrine) | CRUD genérico, `variacoes.ts` | pai é o dono do saldo/venda |
| **SKU / Variação** | `variacoes` | — | CRUD genérico | empresta SKU/cor/preço do pai |
| **Tamanho / Grade** | `tamanhos`, `grades`, `grade_tamanhos` | — | CRUD genérico | catálogo global |
| **Preço de venda (varejo)** | `produtos.preco_venda` | `commerce_precos` (por loja) | CRUD produto; publicação | **ERP é a autoridade** |
| **Preço de atacado** | `produtos.preco_atacado` | `commerce_precos` (por loja) | idem | **ERP é a autoridade** |
| **Preço recebido de plataforma** | `commerce_*` (evidência) | — | ingestão | **evidência, não autoridade** |
| **Estoque (saldo)** | `estoques` (projeção do evento) | — | **só** via `movimentacoes` | saldo derivado, nunca digitado |
| **Movimentação de estoque** | `movimentacoes` | — | `estoque.ts`, `itens.ts`, produção | é o **evento** |
| **Reserva de estoque** | `estoque_reservas` | — | checkout (SERIALIZABLE) | idempotente por pedido |
| **Disponibilidade** | **derivada** (`estoqueCanonico.ts`) | — | — | `físico − reservado − empenhado − bloqueado` |
| **Cliente** | `clientes` | — | CRUD genérico, conversão CRM | documento único por empresa |
| **Representante** | `representantes` | — | CRUD genérico | carteira resolvida no servidor |
| **Pedido operacional (ERP)** | `vendas` | `sales` (read model) | CRUD, PDV, portal, conversão | **fonte operacional** |
| **Item de pedido** | `itens_venda` | `sale_items` (read model) | idem | — |
| **Pedido externo (ingestão)** | `sales` | gera `vendas` | `modules/connectors/ingestion` | read model do canal |
| **Pedido da vitrine** | `commerce_pedidos` | gera `vendas` | `commerce/pedidos.ts` | estado do checkout |
| **Pagamento** | Payment Engine (`payment_*`) | `gateway_cobrancas` (provider) | `modules/payments` | **única** autoridade |
| **Liquidação financeira** | `lancamentos_financeiros` | — | financeiro, baixa | status do pedido **não** prova |
| **Comissão** | `comissoes_apuradas` + `comissoes_eventos` | — | `comissoes.ts` | livro por representante |
| **Envio / rastreio** | `envios` + `envio_eventos` | `logistics_*` (motor) | `modules/logistics` | não duplicar |
| **Loja / canal** | `commerce_multistore` / `store_key` | — | painel WooCommerce | RETAIL/WHOLESALE |
| **Plataforma externa** | `pedido_externo_canal` | — | ingestão | `WOOCOMMERCE_*`, `MERCADOLIVRE`, … |
| **Integração / conector** | `connectors` + `connector_events` | — | `connectors.ts`, `modules/connectors` | OAuth em `connector_oauth_states` |
| **Campanha / promoção** | `commerce_promocoes`, `commerce_cupons` | — | `commerce/promocoes.ts` | — |
| **Movimentação financeira** | `lancamentos_financeiros` | extrato (`fin_extrato_transacoes`) | financeiro | extrato é conciliação |
| **Auditoria** | `auditoria` (cadeia de hashes) | — | `auditChain.ts` | append-only |
| **Segredo** | `segredos` (AES-256-GCM) | — | `segredos.ts` | nunca em claro |

---

## 2. Detalhamento das decisões de autoridade mais sensíveis

### 2.1 Preço — ERP é a autoridade

- **Varejo:** `produtos.preco_venda`. **Atacado:** `produtos.preco_atacado`.
- **Override por loja:** `commerce_precos` (com `store_key`) respeita a estrutura
  autorizada; a consulta cai para o valor do ERP quando não há override.
- **Preço externo** (recebido do WooCommerce/marketplace) é gravado como
  **evidência** (`preco_externo_recebido`) e **nunca** substitui a autoridade.
  Divergência é registrada em `commerce_reconciliacao_divergencias`.
- Evidência: `server/src/commerce/woocommerce/precoAutoridade.ts`,
  `docs/AGENTE-07-RELATORIO-FINAL.md` (A06-01, A06-12).

### 2.2 Estoque — evento × projeção

- `movimentacoes` é o **evento**; `estoques` é a **projeção** (saldo).
- **Disponível** é **derivado**, nunca coluna:
  `físico − reservas ativas − compromissos − bloqueios`, respeitando
  `empresa × produto × tamanho × local`.
- **Não somar** locais indiscriminadamente: o disponível de uma venda é a célula
  do local de saída (ou o Local padrão) — ver `docs/ESTOQUE-CANONICO.md` §2.
- Evidência: `server/src/estoqueCanonico.ts`, migration `0052`.

### 2.3 Vendas × `sales` — operacional × read model

- `vendas`/`itens_venda` = **estrutura operacional**.
- `sales`/`sale_items` = **projeção analítica** (read model), alimentada por
  ingestão de canal e pela projeção `vendas → sales`.
- **Nunca** criar venda duplicada em projeção; a ingestão é idempotente
  (`upsertIngestedSale` + retentativa de corrida — GAP-P1-06).
- Evidência: `docs/ERP-3.0-DUPLICITY-AUDIT.md` §2.1, `negocios.ts`,
  `modules/connectors/ingestion/sales.service.ts`.

### 2.4 Pagamentos — motor único

- Payment Engine é o **único** mecanismo. `gateway_cobrancas` é o espelho do
  provider; `gateway_webhook_events` é a caixa de entrada.
- **Não** tratar status de pedido como prova de liquidação financeira.
- Evidência: `docs/architecture/payment-engine.md`, `modules/payments/*`.

### 2.5 Comissões — livro preservado

- `comissoes_apuradas` + `comissoes_eventos` + `venda_atribuicao`; ajuste por
  reapuração pós-recebimento (`reconciliarEfetivacaoAposReapuracao`).
- **Não** apagar histórico de comissão.
- Evidência: `server/src/comissoes.ts`, `docs/AGENTE-07-RELATORIO-FINAL.md` (A06-06).

### 2.6 Logística — motor preservado

- `envios`/`envio_eventos` (ERP) + `logistics_*` (motor). Diferenciar
  **cotação · frete · remessa · etiqueta · rastreamento · entrega · ocorrência**.
- **Não** duplicar dado logístico em novo módulo.
- Evidência: `docs/LOGISTICA-MOTOR-MULTICANAL.md`, `modules/logistics/*`.

---

## 3. Entidades sem autoridade clara — GAPs

| Entidade / questão | Situação | Classificação | Encaminhamento |
|---|---|---|---|
| `insumos.unidade` (texto livre) | Sem catálogo de unidades | **GAP-P3-04** | Fase 2/3 — exige migração de dados |
| Preço de canal externo como "autoridade" | Evidência × autoridade | **Resolvido** (A06-01) | Manter |
| Relação `/loja` nativo × RETAIL Woo | Ambíguo no código/rótulos | **Decidido** nesta missão | `NATIVE-STORE-DECOMMISSION.md` |
| Integridade cross-tenant de `crm_*` no banco | Só FK simples | **GAP-P2-04** | Fase 2 — FKs compostas no padrão E4.2 |
| Unidade de medida no MRP | Sem conversão | **GAP-P3-07** | Depende de GAP-P3-04 |

---

## 4. Consumidores e escritores por entidade (resumo)

| Entidade | Sistemas que LEEM | Sistemas que ESCREVEM |
|---|---|---|
| `produtos` | Commerce, OMS, WMS, BI, Compras | CRUD, `variacoes.ts`, importação |
| `estoques` | PDV, Vendas, Commerce, BI | **só** via `movimentacoes` |
| `estoque_reservas` | Commerce (vitrine), OMS | checkout, expiração |
| `vendas`/`itens_venda` | Financeiro, Fiscal, Estoque, BI | CRUD, PDV, portal, conversão, ingestão |
| `sales`/`sale_items` | BI, painéis de commerce | ingestão, projeção `vendas → sales` |
| `payment_*` | OMS, Financeiro | Payment Engine |
| `lancamentos_financeiros` | Financeiro, BI | financeiro, baixa, compras |
| `comissoes_*` | Representantes, Financeiro | `comissoes.ts` |
| `envios`/`envio_eventos` | OMS, TMS, portal | `modules/logistics` |
| `auditoria` | Admin (leitura) | `auditChain.ts` (append-only) |

---

## 5. Regras de atualização (invariantes)

1. **Empresa é carimbada pelo servidor** na criação e **imutável** na edição.
2. **Saldo só muda por movimentação** — nunca por escrita direta em `estoques`.
3. **Evento antes do commit é proibido** — publicar via `commerce_outbox` na
   mesma transação.
4. **Ingestão idempotente** por chave `(empresa, tipo, chave)` na outbox e por
   índice único em `sales`.
5. **Projeção não altera operação** — `sales`/BI nunca escrevem em `vendas`.
6. **Histórico nunca é apagado** — desativar cadastro, cancelar documento.

---

*Próximo documento: [`CONTEXT-MAP.md`](CONTEXT-MAP.md).*
