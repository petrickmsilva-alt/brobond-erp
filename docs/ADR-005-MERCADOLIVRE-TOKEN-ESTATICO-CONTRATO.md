# ADR-005 — Mercado Livre: token estático de instalação só com contrato declarado

* **Status:** aceita em 2026-11-04 (Ordem Final, pendência 2.4). **Implementada localmente.** Não homologada.
* **Escopo:** `server/src/marketplace.ts` (rota legada `POST /api/marketplace/sincronizar`), `server/src/commerce/leituraAnunciosMercadoLivre.ts`, `server/src/commerce/reconciliacaoMercadoLivre.ts`.
* **Relacionados:** ADR-002, ADR-006; `docs/auditoria/matriz-evidencias-conectores.md`; `docs/operacao/runbook-operacional-final.md` §3.

## 1. Contexto

A rota legada de sincronização usa o token **estático** da instalação (`MERCADOLIVRE_TOKEN`), que não pertence a
nenhuma empresa. Antes desta decisão, qualquer administrador com empresa definida conseguia disparar a chamada
ao Mercado Livre com esse token, sem nenhum registro de que a instalação foi contratada para aquela operação.

## 2. Decisão

- A rota só chama o Mercado Livre quando a variável **`MERCADOLIVRE_TOKEN_ESTATICO_CONTRATO`** existe no formato
  `<empresa_id>:<referência>` (referência com pelo menos 8 caracteres, sem espaços) **e** o `empresa_id` é o da
  empresa do administrador que chama.
- Sem contrato válido: `409` **antes de qualquer chamada externa**, com registro de auditoria
  (`acao = seguranca`, `recurso = marketplace`) da tentativa bloqueada. A referência não é exibida nem registrada.
- `GET /api/marketplace/status` informa somente `contrato_token_estatico: true|false`.
- A rota legítima continua a mesma: identidade por `GET /users/me` e depois `GET /orders/search?seller=<id>`.
  O literal `seller_id` continua proibido (há teste de código-fonte).

## 3. Alternativas descartadas

- **Remover a rota:** quebra um fluxo que existe e tem testes de autorização. Descartado.
- **Bloquear só por perfil:** já estava feito (somente admin); não resolvia o problema de contrato.
- **Migrar para OAuth por empresa agora:** é o destino, mas é trabalho maior e depende de credencial real do canal.
  Permanece como pendência.

## 4. Leitura de anúncios (somente GET)

`lerAnunciosMercadoLivre` lista os anúncios ativos do vendedor (`GET /users/{id}/items/search?status=active`) e lê
os detalhes em lotes de 20 (`GET /items?ids=...&attributes=id,seller_custom_field,status`). Não há `PUT`, `POST`,
`PATCH` nem `DELETE` no módulo (teste de código-fonte). Falha de busca lança erro sem expor o token. O resultado
alimenta `reconciliarAnunciosMercadoLivre`, que tem `exclusoes = 0` e `alteracoes = 0` por tipo. O módulo não é
exposto por rota e não é executado pelo sistema.

## 5. Consequências e limites

- Nenhuma chamada real ao Mercado Livre foi feita. Os testes usam `fetch` interceptado.
- A publicação de anúncios continua **suspensa por padrão** (`PUBLICACAO_CANAIS_LIBERADOS`).
- O token estático continua em uso **somente** quando o contrato for declarado. Declarar o contrato é decisão do
  Diretor e exige registro de quem autorizou e por qual motivo (ver runbook §3).
- Os endpoints de anúncio foram confirmados na documentação oficial "Items & Searches". Não foram testados com conta real.
