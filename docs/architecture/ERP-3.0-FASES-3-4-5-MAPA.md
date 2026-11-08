# ERP 3.0 — Mapa de entregas das Fases 3, 4 e 5

**Base:** `main` @ `f4f8b81` (incremento *Devolução ao Fornecedor*, PR #116, MERGED).
**Regra:** nenhum status sem evidência no código. `pronto` = há tabela/rota/tela/teste
executado; `parcial` = existe fundação real mas falta a cadeia completa; `pendente`
= não existe. Onde a prova depende de homologação externa, o item é `parcial` com a
pendência declarada — nunca `pronto`.

> Este mapa **complementa** (não substitui) `MASTER-BACKLOG.md`, `ERP-3.0-GAP-MATRIX.md`
> e `ENTERPRISE-WAVES-4-5-MATRIX.md`. Ele responde apenas a uma pergunta: *o que das
> Fases 3, 4 e 5 da missão master já existe hoje?*

---

## FASE 3 — Supply Chain

| Capacidade | Estado | Evidência |
|---|---|---|
| Estoque canônico + disponibilidade | **pronto** | `server/src/estoqueCanonico.ts`, `estoqueTransferencia.ts` (`disponivel = físico − reservado − bloqueado − empenho`), `GET /api/estoques/disponivel` |
| Endereçamento WMS (armazém → zona → endereço) | **pronto (fundação)** | `locais.nivel_wms`/`local_pai_id`, `server/src/wmsEnderecamento.ts`, migração `0072` |
| Put-away dirigido, waves, slotting, replenishment | **pendente** | não há tabela/rota; endereço é metadata do local |
| Recebimento de compra (parcial/total, idempotente) | **pronto** | `server/src/compras.ts` `receberParcial`, `POST /api/compras/:id/receber`, `compra_recebimentos` |
| Compras, cotação, homologação de fornecedor | **pronto** | `cotacoesCompra.ts`, `comprasFornecedor.ts`, `fornecedor_scorecards`, `POST /api/compras/:id/aprovar` |
| Requisição interna / solicitação de compra formal | **parcial** | sugestão de compra (`suprimentos.ts`) e cotação existem; requisição interna como documento próprio não |
| Devolução ao fornecedor | **pronto** | `server/src/devolucaoFornecedor.ts`, `devolucoes_fornecedor` (migração `0105`), PR #116 |
| MRP (planejamento/necessidade) | **parcial** | `producaoCapacidade.ts` (`calculo.tipo = mrp_planejamento_necessidade`); sem lead time, lote mínimo, calendário, capacidade finita, pegging |
| Ordens de produção, apontamento, perda/refugo | **pronto** | `producao.ts`, `ordens*`, `ordens_apontamentos`, `ordens_eventos` |
| Ficha técnica / BOM multinível | **pronto** | `fichas`, `itens_ficha_tecnica`, `produto_composicao` |
| TMS: transportadora, remessa, rastreio, eventos | **pronto (fundação)** | `logistica.ts`, `envios`, `envio_eventos`, `GET /api/envios/rastreio/:codigo`, migração `0102` |
| Etiqueta/ocorrência/SLA/devolução logística homologada | **parcial** | contratos configuráveis existem; homologação real de transportadora pendente (`EXTERNAL-HOMOLOGATION-MATRIX.md`) |
| Rastreabilidade ponta a ponta (lote + consulta) | **parcial** | vínculos formais existem (`movimentacoes` FK compra/recebimento/OP/venda/devolução); **lote** e consulta unificada faltavam — **este incremento entrega** |

## FASE 4 — PIM & Pricing

| Capacidade | Estado | Evidência |
|---|---|---|
| Produto mestre (identidade, fiscal, logística, mídia) | **pronto** | `produtos` (60+ campos), `produto_pai_id`/`variacao_tamanho_id`, `commerce_produtos` |
| Variantes / grade / SKU | **pronto** | `variacoes.ts`, `grade_tamanhos`, `SKU único por empresa` (`uq_produtos_sku_empresa`) |
| Atributos configuráveis | **parcial** | cor, composição, marca, tags, medidas; não há motor de atributos por categoria |
| Conteúdo por canal / SEO / publicação | **pronto (fundação)** | `commerce_publicacoes` (DRAFT→PUBLISHED), `commerce_precos`, `publicacaoCanais.ts` |
| Preço por canal / loja | **pronto** | `commerce_precos` (`store_key` RETAIL/WHOLESALE), `precoAutoridade.ts` |
| Tabelas de preço com vigência/prioridade | **pronto** | `listas_preco` + `lista_preco_itens` (prioridade, vigência) |
| Precedência explícita de política de preço | **parcial** | listas + `commerce_precos` + base coexistem; falta política por grupo de cliente/representante |
| Motor de promoções | **parcial** | `commerce_promocoes` + `commerce/regras.ts` (maior desconto vence); sem kits, cupons progressivos, elegibilidade por cliente |
| Simulação de preço / promoção | **parcial** | regra pura testável existe; simulador de impacto não |
| Governança de aprovação de preço | **parcial** | `politicas_comerciais`; sem fluxo de aprovação dedicado |

## FASE 5 — Payments & OMS

| Capacidade | Estado | Evidência |
|---|---|---|
| OMS / ciclo de pedido (venda) | **pronto** | `vendas`/`itens_venda`, faturamento, `expedicao.ts`, `eventosVenda.ts` |
| Identidade comercial por canal/loja | **pronto** | ADR-008, `sales`/`sale_items`, `WOO-<LOJA>-<id>` |
| Máquina de estados de pedido explícita | **parcial** | estados existem (`vendas.status`, `expedicao_eventos`); não há transição única versionada |
| Reserva e confirmação | **pronto** | `estoque_reservas`, `POST /api/estoque/reservas[/:id/liberar]` |
| Payments Engine canônico | **pronto** | `gateway.ts`, `payment_*`, `POST /api/commerce/payments/:id/{refund,capture,cancel,manual-confirm}` |
| Liquidação e conciliação | **parcial** | `extrato.ts`, `cnab.ts`, `GET /api/commerce/payments/{reconciliation,refunds,webhooks}`; ingestão automática de repasse/MDR pendente |
| Devoluções e logística reversa | **pronto (fundação)** | `devolucoes`, `devolucao_itens`, `devolucaoRefund.ts`; reintegração condicionada à conferência |
| Devolução ao fornecedor | **pronto** | `devolucaoFornecedor.ts` (PR #116) |
| Webhooks assinados, dedupe, replay | **pronto** | `webhooks.ts`, `webhookEmpresa.ts`, `webhookReconciliacao.ts`, `payment_webhooks` |

---

## Incrementos abertos priorizados

1. **Fase 3 — Rastreabilidade ponta a ponta** (este PR): lote por recebimento/devolução/
   movimentação + consulta por produto, SKU, lote e documento de origem.
2. **Fase 3 — WMS dirigido** (put-away/picking/packing por endereço, wave, contagem
   cíclica automatizada) — `GAP-P2-16`.
3. **Fase 3 — MRP evoluído** (lead time, lote mínimo, calendário) — `GAP-P2-15`.
4. **Fase 4 — Promoções e precedência de preço** (kits, cupons, elegibilidade, simulador).
5. **Fase 5 — OMS: máquina de estados versionada + conciliação automática de repasse.**

> Decisões que continuam com o Diretor: `DEC-001`…`DEC-004` em `MASTER-BACKLOG.md`
> (retirada da `/loja`, homologação externa). Não são tocadas por este mapa.
