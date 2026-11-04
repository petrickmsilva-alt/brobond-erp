# ADR-006 — Nuvemshop 2025-03: escrita bloqueada até evidência oficial dos endpoints

* **Status:** aceita em 2026-11-04 (Ordem Final, pendência 2.5). **Implementada localmente.** Escrita **bloqueada** em produção.
* **Escopo:** `server/src/commerce/publicacaoNuvemshop.ts` (`ESCRITA_NUVEMSHOP_2025_LIBERADA`), `server/src/commerce/catalogo.ts` (`dependenciasPublicacao.nuvemshopEvidenciaOficialEscrita`).
* **Relacionados:** ADR-005, `docs/auditoria/gate-leitura-nuvemshop-2025-03.md` §8, `docs/auditoria/matriz-evidencias-conectores.md`.

## 1. Contexto

A publicação na Nuvemshop 2025-03 usa `GET /products/sku/{sku}`, `POST /products` e `PATCH /products/stock-price`.
A documentação oficial consultada confirma a base `https://api.tiendanube.com/2025-03/{store_id}`, o cabeçalho
`Authorization: Bearer` e o `User-Agent` obrigatório (sem ele a API responde 400). **Não confirma** os endpoints de
escrita, o esquema de variantes, SKU, estoque e preço nessa versão. Um agregador de terceiros foi descartado como fonte.

## 2. Decisão

- `ESCRITA_NUVEMSHOP_2025_LIBERADA = false`. Com esse valor, `publicarItemNuvemshop` falha com `rejeitada = true`
  **antes de qualquer chamada à loja**: nem leitura por SKU, nem criação, nem atualização.
- Liberar exige evidência oficial registrada no gate de leitura e uma alteração revisada desta constante. Não é
  variável de ambiente, de propósito: não pode ser ligada por configuração de produção.
- Os testes do adapter (lógica de vínculo, criação, atualização, erros e fluxo pelo pipeline do catálogo) continuam
  ativos por meio de dois ganchos que a produção **não** liga: o campo `evidenciaOficialEscrita` no contexto e
  `dependenciasPublicacao.nuvemshopEvidenciaOficialEscrita` (padrão `false`). Testes de guarda verificam que
  somente `catalogo.ts` e `publicacaoNuvemshop.ts` referenciam o gancho e que a produção não o liga.
- Autenticação (Bearer + User-Agent) e a base 2025-03 permanecem como estão.

## 3. Por que bloquear a leitura também

O fluxo começa por `GET /products/sku/{sku}`. Como o restante depende de endpoints sem evidência, bloquear a leitura
evita chamadas à loja com um contrato não confirmado. Não há escrita na loja em nenhum caminho com o gate fechado.

## 4. Consequências

- Publicações Nuvemshop ficam **bloqueadas** mesmo com `NUVEMSHOP` em `PUBLICACAO_CANAIS_LIBERADOS`.
  A mensagem exibida ao usuário diz que nenhuma alteração foi enviada à loja.
- O v1 (`nuvemshop.service.ts`) não foi alterado e segue com as mesmas limitações documentadas.
- Os testes do adapter usam dublê de rede. Não houve chamada à Nuvemshop.
