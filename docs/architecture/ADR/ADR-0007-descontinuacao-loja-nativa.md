# ADR-0007 — Descontinuação da loja pública nativa `/loja`

* **Identificador:** ADR-0007
* **Título:** Descontinuação da experiência pública nativa `/loja`
* **Status:** **Aceita (decisão do Diretor)**
* **Data:** 2026-11-07
* **Relacionados:** ADR-0006, `NATIVE-STORE-DECOMMISSION.md`

## Contexto

Existem **duas** superfícies públicas de varejo: a vitrine nativa `/loja`
(React + `/api/loja/*`) e a RETAIL WooCommerce (`brobond.com.br`). O ADR-008 §6
deixou a relação entre elas como decisão de negócio pendente.

## Problema

Duas lojas públicas de varejo geram ambiguidade de canal, risco de divergência
de preço/estoque e confusão de experiência. Qual é a loja pública oficial?

## Decisão (do Diretor)

1. A loja nativa `/loja` **não** será mais uma experiência pública de varejo.
2. A **RETAIL WooCommerce** passa a ser a **única** loja pública de varejo.
3. Descontinuar de forma **segura**: preservar ERP, painel administrativo,
   pedidos, produtos, clientes e serviços não exclusivos da experiência pública.
4. **Não** apagar tabelas, históricos, pedidos, clientes, produtos ou registros
   financeiros.
5. **Não** remover rota administrativa só porque o caminho contém `/loja`.
6. **Não** alterar o domínio RETAIL nem DNS sem autorização específica.

## Alternativas consideradas

- **Manter as duas:** rejeitada pelo Diretor (duplicidade de superfície pública).
- **Retirar sem plano:** rejeitada (risco de quebrar serviços compartilhados).

## Consequências

- A experiência pública passa a ser RETAIL Woo.
- URLs antigas de `/loja` recebem tratamento de SEO (301/410) — ver plano.
- Serviços internos compartilhados (`checkoutMethods`, motor de pedidos)
  permanecem.

## Riscos

- Quebrar serviços compartilhados → mitigado por inventário de remoção segura e
  testes de não-regressão (Fase 2).
