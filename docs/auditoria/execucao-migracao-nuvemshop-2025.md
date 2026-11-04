# Execução — migração Nuvemshop para 2025-03 (decisão (b) aprovada)

Status: **parcial**. A publicação de produtos migrou para o contrato 2025-03. A leitura de pedidos e produtos e o fluxo OAuth continuam no contrato v1 e são pendência. Nada foi enviado a loja real: a publicação continua **suspensa por padrão**.

## Contrato usado (documentação pública da plataforma)

- Base: `https://api.tiendanube.com/2025-03/{store_id}`.
- Cabeçalhos: `Authorization: Bearer <token>` e `User-Agent` obrigatório (sem ele a API responde 400). Fonte: página "Getting Started" da Admin API, versão 2025-03.
- `POST /products` com `variants` (`price` em string, `stock_management`, `stock`, `sku`); nome como string aplicada a todos os idiomas.
- `GET /products/sku/{sku}` para localizar produto existente antes de criar.
- `PATCH /products/stock-price` com `[{id, variants:[{id, price, inventory_levels:[{stock}]}]}]`.
- Fonte da forma de resposta de `GET /products/sku/{sku}` e de `PATCH` (`success` por variante): documentação de recurso. **Não verificado em loja real.**

Contrato legado (não usado mais na publicação): `https://api.nuvemshop.com.br/v1` com `X-Auth-Token`, preço e estoque no produto.

## O que foi feito

| Item | Evidência |
|---|---|
| Adapter `server/src/commerce/publicacaoNuvemshop.ts`: vínculo → PATCH; SKU existente → adota; senão POST. Sem SKU ou título recusa antes de chamar. POST sem identificador verificável não é repetido (próxima tentativa busca pelo SKU). | LOCAL — `server/test/publicacao-nuvemshop-2025.test.ts` (9/9). RED: módulo inexistente antes da implementação. |
| `publicarNuvemshop` em `catalogo.ts` usa o adapter; o stub desligado foi removido. A suspensão continua sendo checada antes. | LOCAL — `server/test/publicacao-nuvemshop-fluxo.test.ts` (3/3). RED comprovado: com o `catalogo.ts` anterior, 2 dos 3 falham (publicação liberada e edição). |
| Teste P0 "Nuvemshop recusada sem HTTP" reescrito: exigia recusa mesmo com a canal liberado, o que era o stub. Novo requisito: liberada, a chamada vai só à base 2025-03, nunca ao v1. | `server/test/publicacao-canais-p0.test.ts` |
| `userAgentNuvemshop()` exportado de `nuvemshop.service.ts`; a mesma regra de `NUVEMSHOP_USER_AGENT` com padrão foi reaproveitada (sem variável nova). | Revisão de código; typecheck EXIT 0 |

Suíte do servidor: 1698 aprovados / 0 falhas / 76 ignorados.

## O que NÃO foi feito (e por quê)

- **Leitura de pedidos, produtos e loja (`nuvemshop.service.ts`) continua em v1.** Migrar exige verificar a forma de resposta de pedidos 2025-03 (status, pagamento, itens). Sem isso, o risco é quebrar a ingestão de vendas silenciosamente. Pendência para a próxima entrega.
- **Fluxo OAuth e troca de token** não foram revisados contra a documentação 2025-03. A página de autenticação foi lida e não há mudança de endpoint de token identificada até agora, mas isso não foi testado contra a plataforma.
- **Descrição do produto não é enviada.** O formato multilíngue de `description` não foi verificado.
- **Dois contratos coexistem** no mesmo módulo: publicação em 2025-03 e leitura em v1. Isto é transitório e deve ser fechado antes de religar a publicação.
- **Não verificado:** se houve publicações Nuvemshop v1 em produção antes da suspensão. Sem essa resposta, não há como afirmar ausência de duplicatas.

## Para religar a publicação (ação do Diretor, não executada)

1. Homologar em loja de teste: criar, atualizar preço e estoque, adotar produto existente pelo SKU.
2. Só então incluir `NUVEMSHOP` em `PUBLICACAO_CANAIS_LIBERADOS` no Render. Isto é uma alteração de variável de ambiente de produção e não foi feita.
3. Antes disso, reconciliar eventuais duplicatas (P0-01).

## Limitações

- Nenhuma chamada real à Nuvemshop foi feita. Os testes usam fetch simulado e token falso.
- Nada de produção foi alterado.

> **Correção (Fase 4.1):** o cabeçalho `Authorization: Bearer` citado acima para o 2025-03 é **não verificado**. Outras fontes encontradas na Fase 4.1 dizem que a plataforma usa `Authentication: bearer` (o próprio v1 do código usa esse cabeçalho). Ver R-15 em `matriz-configuracao-producao.md` e o gate de leitura em `plano-homologacao-conectores.md` §2.2. Até a verificação, a publicação 2025-03 não deve ser considerada funcional.
