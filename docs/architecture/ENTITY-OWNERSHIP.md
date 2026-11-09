# ENTITY-OWNERSHIP — dono e autoridade por entidade

**Data:** 2026-11-07 · **Branch:** `architecture/fase-2-canonical-erp-data`
**Referência:** [`SOURCE-OF-TRUTH.md`](SOURCE-OF-TRUTH.md),
[`CONTEXT-MAP.md`](CONTEXT-MAP.md), ADR-0002, ADR-0003.

> **Regra.** Cada entidade tem um **dono** (módulo/contexto que decide o dado) e
> **leitores** autorizados. Um contexto não escreve no dado de outro sem
> contrato documentado (ADR-0002). Onde a autoridade não está clara → **GAP**.

---

## 1. Matriz de propriedade

| Entidade / dado | Dono (escreve) | Pode ler | Não pode |
|---|---|---|---|
| `empresas`, `usuario_empresas` | Platform/Security | todos (via `escopoDoAtor`) | contexto escrever tenant |
| `usuarios`, permissões | Platform/Security | todos | — |
| `produtos`, `variacoes`, `tamanhos` | PIM | todos | canal escrever cadastro |
| `produtos.preco_venda` / `preco_atacado` | ERP Core (PIM) | Commerce (leitura) | canal sobrepor base |
| `commerce_precos` (override por loja) | Commerce | PIM (consulta) | canal escrever fora da estrutura |
| `estoques`, `movimentacoes`, `estoque_reservas` | WMS/ERP Core | todos | canal escrever saldo direto |
| Disponibilidade | ERP Core (`estoqueCanonico`) | todos | recomputar fora daqui |
| `clientes` | CRM/CX (cadastro) | OMS, Payments | canal criar mestre paralelo |
| `representantes` | CRM (REPRESENTATIVES) | OMS, Comissões | — |
| `vendas`, `itens_venda` | OMS | Financeiro, BI | BI escrever operação |
| `sales`, `sale_items` (projeção) | Commerce (ingestão) | BI | tratar como operação |
| `commerce_pedidos` | OMS (checkout) | Payments, Logística | — |
| `payment_*` | Payments (Payment Engine) | Financeiro, BI | OMS escrever pagamento |
| `lancamentos_financeiros` | Financeiro | BI | OMS provar liquidação |
| `comissoes_*` | CRM/Comissões | Financeiro, BI | apagar histórico |
| `envios`, `envio_eventos`, `logistics_*` | TMS (Logistics Engine) | OMS, BI | duplicar dado logístico |
| `commerce_multistore`, `store_key` | Commerce (Multi-Store) | todos | — |
| `commerce_outbox` | Commerce (fila única) | workers | criar 2º outbox |
| `auditoria` | Platform/Security | autorizados | editar (append-only) |
| `segredos`, `configuracoes` | Platform/Security | dono do domínio | expor em claro |

## 2. Fronteiras de escrita (contrato)

| De → Para | Mecanismo | Idempotência |
|---|---|---|
| Commerce → ERP (pedido externo) | outbox `conversao` | por `(empresa, tipo, chave)` |
| OMS → WMS (baixa/reserva) | `movimentacoes`/`estoque_reservas` na mesma transação | por venda/pedido |
| OMS → Payments | Payment Engine (intent) | por pedido |
| Payments → Financeiro | liquidação | por tentativa/settlement |
| OMS → Comissões | `comissoes_apuradas` | por (representante, venda) |
| ERP → Canal (publicação/estoque) | outbox `publicacao`/`sincronizacao` | por (loja, produto) |
| Qualquer → BI | leitura das fontes | — (BI **não** escreve) |

## 3. GAPs de propriedade

| GAP | Severidade | Ação |
|---|---|---|
| `sale_items` sem `empresa_id` (projeção) | P3 | herda `sales`; recorte por tenant NO SQL na Fase 9.1 (BL-016) |
| `arquivos` polimórfico (herda do recurso) | P3 | documentado em `TENANT-GOVERNANCE.md` |
| `cotacao_decisoes`/`portal_acessos` (herda-tenant) | P3 | classificados; FK composta é candidata futura |

## 4. Critérios de aceite

1. Todo dado mestre com dono declarado.
2. Escrita entre contextos só por contrato (outbox/endpoint).
3. BI nunca escreve operação.
4. GAP de propriedade registrado no `MASTER-BACKLOG.md`.
