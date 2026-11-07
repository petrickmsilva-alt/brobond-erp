# Agente 07 — Política canônica de preço e de disponibilidade

**Missão:** saneamento da unificação comercial (achados A06-01 a A06-15).
**Base:** `main` em `727c0c18262cd2834b270dbda74cb57d9af96d7a`.
**Escopo:** define as regras que os caminhos de importação, publicação e BI
passam a obedecer. A auditoria do Agente 06 permanece como registro imutável do
diagnóstico original.

---

## 1. Autoridade de preço (A06-01)

### 1.1 Regra única

O ERP é a **única** autoridade dos preços internos. Todo item de venda importado
grava o **preço oficial do ERP** — nunca o preço que a loja externa informou.

| Loja | Base do preço | Override |
|---|---|---|
| `RETAIL` | `produtos.preco_venda` | `commerce_precos` canal `WOOCOMMERCE` **da loja RETAIL** |
| `WHOLESALE` | `produtos.preco_atacado` | `commerce_precos` canal `WOOCOMMERCE` **da loja WHOLESALE** |
| Legado single-store | `preco_venda`/`preco_atacado` pelo canal | linha legada (sem `store_key`) |

Módulo único: `server/src/commerce/woocommerce/precoAutoridade.ts`.
Consumidores: importador Multi-Store (`pedidos.ts`) e importador legado
(`loja.ts`) — ambos passam pela mesma função `decidirPrecoItem`.

### 1.2 Divergência e evidência

- O preço remoto é **evidência**, guardado em `itens_venda.preco_externo_recebido`
  (migration `0103`). Ele **não** alimenta total, financeiro nem comissão.
- Quando o preço remoto difere do oficial, a divergência é **registrada** para
  conferência. Nunca há substituição silenciosa.
- Produto sem preço válido no ERP → o item entra **pendente** (não grava preço
  remoto como oficial).

### 1.3 Exceção legítima: preço negociado

Preço negociado só vence com **autorização explícita e auditada**
(`negociadoAutorizado`), e a evidência do preço remoto continua registrada.
Sem autorização, o remoto não vence.

---

## 2. Disponibilidade de estoque (A06-02, A06-04)

### 2.1 Regra única

O estoque **vendável** nunca é o estoque físico. O motor canônico de
disponibilidade é a única fonte:

```
disponível = físico − reservas ativas − empenhos − bloqueios
```

por **empresa × produto × tamanho × local**, considerando a **melhor célula
vendável** (nunca a soma cega de locais).

### 2.2 Consumidores

- Publicação Multi-Store (`commerce/woocommerce/publicacao.ts`): usa o motor
  canônico; resolve **pai + tamanho** pela relação `produto_pai_id` /
  `variacao_tamanho_id` (A06-04), mantendo preço/SKU no filho.
- Caminho legado (`loja.ts`, `enviarEstoqueLojaInterno`): passa a consumir o
  **mesmo** motor canônico. Não há segunda fórmula de estoque.
- Publicação de estoque indisponível/negativo **não** é enviada como vendável.

### 2.3 Variações

Saldo vive no **pai + tamanho**; preço/SKU no **filho**. Consultar o saldo pelo
id do filho publicava zero mesmo com saldo no pai. A leitura passa a ser pela
relação canônica, sem duplicar saldos.

---

## 3. Identidade de pedido por loja (A06-03)

- Identidade de pedido externo = `(empresa, pedido_externo_canal, pedido_externo_id)`,
  com `store_key` explícito (`WOOCOMMERCE_RETAIL` / `WOOCOMMERCE_WHOLESALE`).
- `RETAIL` e `WHOLESALE` são **namespaces independentes**: o número externo 777
  em cada loja são pedidos distintos.
- A referência legada `WOO-<id>` só é adotada com **prova de mesma origem**.
  Sem prova, o pedido ambíguo **não** é associado automaticamente; o conflito é
  registrado.
- Idempotência preservada: reimportar o mesmo pedido da mesma loja não duplica;
  pedidos de lojas diferentes nunca colidem nem se suprimem.

---

## 4. Referências

- `docs/AGENTE-07-RELATORIO-FINAL.md` — relatório final da missão.
- `docs/adr/ADR-008-IDENTIDADE-CANAL-COMERCIAL.md` — identidade de canal.
- `docs/AGENTE-07-RUNBOOK-CUTOVER-LEGADO-MULTISTORE.md` — cutover.
- `docs/AGENTE-06-RELATORIO-UNIFICACAO-COMERCIAL.md` — diagnóstico original.
