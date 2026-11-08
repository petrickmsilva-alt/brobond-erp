# CANONICAL-DATA-MODEL — modelo canônico do núcleo ERP

**Data:** 2026-11-07 · **Branch:** `architecture/fase-2-canonical-erp-data`
**Referência:** [`SOURCE-OF-TRUTH.md`](SOURCE-OF-TRUTH.md) (Fase 0), ADR-0003
(fonte canônica), ADR-0005 (identidade comercial), ADR-0008 (operacional ×
analítico).

> **Regra.** Uma informação tem **uma** fonte oficial. Onde há duas, a segunda é
> **projeção / cache / cópia de integração / snapshot / legado** — nunca
> autoridade concorrente.

---

## 1. Fonte canônica por entidade

Para cada entidade: **fonte · identidade · chaves de relacionamento · escopo de
empresa · escopo comercial · escritores · leitores · atualização · projeções**.

| Entidade | Fonte | ID | Relacionamento | Empresa | Comercial | Escritores autorizados | Projeções |
|---|---|---|---|---|---|---|---|
| Empresa | `empresas` | `id` | raiz do tenancy | — (é o tenant) | — | `empresasApi.ts` (admin) | — |
| Usuário | `usuarios` | `id` | `empresa_id` + `usuario_empresas` | vínculo | — | `usuariosAdmin.ts`, `auth.ts` | — |
| Vínculo usuário×empresa | `usuario_empresas` | `id` | `(usuario_id, empresa_id)` | sim | — | `empresasAcesso.ts` | — |
| Produto (pai) | `produtos` | `id` | `categoria_id`, `cor_id`, grade | sim | — | CRUD, `variacoes.ts` | `commerce_produtos` |
| Variação | `variacoes` | `id` | `pai_id` | sim | — | CRUD | — |
| SKU / tamanho | `tamanhos`, `grades`, `grade_tamanhos` | `id` | catálogo global | referência | — | CRUD (gerente p/ escrever) | — |
| Preço de varejo | `produtos.preco_venda` | `produtos.id` | — | sim | RETAIL | CRUD produto | `commerce_precos` (override) |
| Preço de atacado | `produtos.preco_atacado` | `produtos.id` | `atacado_min_qtd` | sim | WHOLESALE | CRUD produto | `commerce_precos` |
| Preço por loja | `commerce_precos` | `id` | `(empresa, produto, canal, store_key)` | sim | por `store_key` | painel de ofertas | — |
| Estoque (saldo) | `estoques` | `id` | `(empresa, produto, tamanho, local_id)` | sim | por local | **só** via `movimentacoes` | — |
| Movimentação | `movimentacoes` | `id` | `(empresa, produto, local)` | sim | — | `estoque.ts`, `itens.ts`, produção | saldo em `estoques` |
| Reserva | `estoque_reservas` | `id` | `(empresa, produto, tamanho, local)` | sim | — | checkout, produção, transferência | — |
| Disponibilidade | **derivada** (`estoqueCanonico.ts`) | — | célula canônica | sim | — | — | — |
| Cliente | `clientes` | `id` | documento | sim | — | CRUD, conversão CRM | — |
| Representante | `representantes` | `id` | carteira | sim | REPRESENTATIVES | CRUD | — |
| Pedido operacional | `vendas` | `id` | `cliente_id`, `itens_venda` | sim | por `store_key` | CRUD, PDV, portal, conversão | `sales` (read model) |
| Item operacional | `itens_venda` | `id` | `venda_id` | herda | — | idem | `sale_items` |
| Pedido externo | `sales` | `id` (cuid) | `external_order_id`, `reference` | sim | `channel` | ingestão de canal | gera `vendas` |
| Item da projeção | `sale_items` | `id` | `sale_id` | herda de `sales` | — | ingestão | — |
| Pagamento | Payment Engine (`payment_*`) | `id` | intent→attempt→settlement | sim | — | `modules/payments` | `gateway_cobrancas` |
| Liquidação | `lancamentos_financeiros` | `id` | origem | sim | — | financeiro, baixa | extrato (conciliação) |
| Comissão | `comissoes_apuradas` | `id` | representante × venda | sim | REPRESENTATIVES | `comissoes.ts` | `comissoes_eventos` |
| Envio / rastreio | `envios` + `envio_eventos` | `id` | pedido | sim | — | `modules/logistics` | `logistics_*` |
| Loja / canal | `commerce_multistore` / `store_key` | `store_key` | empresa | sim | RETAIL/WHOLESALE | painel Woo | — |
| Auditoria | `auditoria` | `id` | append-only (cadeia) | payload | — | `auditChain.ts` | — |
| Segredo | `segredos` / `configuracoes` (cifrado) | `chave` | namespace por empresa | por chave | — | `segredos.ts` | — |

## 2. Disponibilidade canônica

```
disponível(empresa, produto, tamanho, local) =
    físico − reservas_ativas − empenho − bloqueio        (nunca < 0)
```

Implementada **uma única vez** em `server/src/estoqueCanonico.ts`
(`reservasAtivasPorCelula` + `saldoDisponivelCelula` + `saldoVendavel`). O
faturamento (`itens.ts`) usa a **mesma** função — a tela não promete saldo que a
baixa recusa. Reserva **sem local** desconta de qualquer local candidato
(critério conservador). Saldos de locais diferentes **não** são somados
indiscriminadamente; `físico` (soma de todos os locais) e `vendável` (maior
célula de saída) são perguntas distintas e explícitas.

Prova: `server/test/fase2-nucleo-canonico.test.ts` — cobre os quatro
componentes (reserva/empenho/bloqueio), a ausência de dupla dedução (mesma
quantidade descontada 1× na célula e 1× no total), `tipo` desconhecido contando
como compromisso, quantidade ≤ 0 ignorada, o "nunca negativo" e o isolamento por
empresa. O físico é o único componente somado entre locais; o disponível é
sempre por célula.

## 3. Autoridade de preço

- RETAIL → `produtos.preco_venda`; WHOLESALE → `produtos.preco_atacado`.
- Override por loja em `commerce_precos` (com `store_key`) **vence a base**, mas
  a **fonte continua sendo a da loja** (`precoDaLoja` devolve `fonte`).
- Preço recebido de plataforma é **evidência**, nunca autoridade automática.
- Preço de atacado ausente/zero **não é publicado** (`validarPrecoPublicavel`).

## 4. Integridade referencial

- PKs em todas as tabelas; FKs simples onde a relação é global.
- **FKs compostas E4.2** (`(empresa_id, x) → pai(empresa_id, id)`) onde há risco
  de cross-tenant: locais/estoque/compras (0030) e agora **CRM** (0104).
- Constraint nova entra `NOT VALID` + `VALIDATE CONSTRAINT` (protege escrita nova
  e confere o legado; falha em voz alta se houver dado inconsistente).
- Gate: `server/test/fase2-integridade-referencial.test.ts` exige que **todo**
  destino de FK E4.2 tenha `UNIQUE (empresa_id, id)`.

## 5. O que NÃO se faz

- Não criar segunda fonte oficial "por conveniência".
- Não transformar projeção (`sales`/`sale_items`) em autoridade.
- Não unificar `vendas` × `sales` (operacional + read model é intencional).
- Não somar estoque de locais diferentes para "resolver" disponibilidade.
