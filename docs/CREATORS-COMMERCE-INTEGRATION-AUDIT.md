# CREATORS × COMMERCE — AUDITORIA DE INTEGRAÇÃO (reconstruída; status PLANNED)

> Reconstruído em 2026-10-29 a partir do código real. **Nenhuma
> implementação de Creators foi feita nesta rodada** — o escopo recebido foi
> mantê-la **PLANNED e separada**, sem conflito, duplicação nem sobreposição de
> rotas com o Commerce. Este documento audita exatamente isso.

## 1. Status

| Item | Estado |
| --- | --- |
| Módulo Creators (integração Commerce ↔ Creators) | **PLANNED — sem implementação nesta rodada** |
| Rotas `/api/creators*` ou `/commerce/creators*` | **AUSENTES** (grep em `server/src/index.ts`: nenhuma rota) |
| Páginas `client/src/pages/creators*` | **AUSENTES** |
| Novos módulos no menu | **NENHUM** — `modules.test.ts` segue com os asserts duros 111/92/13/4/2 + 33 páginas especiais, verdes |
| Conflito de rota com `/commerce/*` e `/loja/*` | **NENHUM** — conjunto novo: 33 rotas `commerce` + 6 `loja`, nenhuma colide com padrões existentes |

## 2. Por que NÃO há conflito/duplicação hoje

1. **Superfície de rotas disjointa.** O Commerce usa `/api/commerce/*` e
   `/api/loja/*`. Não existe nenhuma rota com prefixo `creators` no
   `index.ts` (410 rotas), nem handler em `server/src/commerce/*` que
   mencione creators.
2. **Persistência disjointa.** As tabelas novas do Commerce
   (`0068_commerce_os.sql`) são `commerce_*` com `empresa_id`. Nenhuma
   migração desta rodada cria tabela `creator*`.
3. **Menu/módulos intactos.** Os testes de invariantes de módulo (contagens
   duras) passaram em `npm run test:client` (108 arquivos / 986 testes) —
   se esta rodada tivesse inserido módulo ou página especial, quebrariam.
4. **RBAC sem vazio.** Como não há recurso Creators, não há permissão
   `creators` declarada — nenhum papel recebe acesso fantasma.

## 3. Pontos de futura integração (quando sair de PLANNED)

Registrados aqui para a próxima rodada — **hoje são plano, não código**:

| Ponto | Integração prevista | Regra a preservar |
| --- | --- | --- |
| Vitrine/produtos | Criador promove produto já projetado em `commerce_produtos` | reutilizar `escopoDoAtor`; **não** duplicar catálogo |
| Publicação multicanal | Enfileirar via `enfileirarPublicacao` existente | fila canônica única (sem segundo outbox) |
| Pedidos de afiliados | Projetar via `garantirPedidoDaSale` com sale externo próprio | idempotência por `(canal, sale)`; não reescrever `commerce_pedidos` |
| Páginas | Subrotas próprias sob `creators/*` com `<ModuleAccess moduleId="creators">` | módulo novo exige atualizar os asserts de `modules.test.ts` **de propósito** (nunca afiná-los para passar) |

## 4. Veredito da auditoria

- **Sem implementação nesta rodada** ✅ (escopo respeitado).
- **Sem rota, tabela, página ou permissão de Creators** ✅ (verificado por
  grep + invariantes verdes).
- **Sem sobreposição com o Commerce** ✅ (`/commerce/*`, `/loja/*` intactos).
- **Creators permanece PLANNED** — a integração acima só pode ser executada
  em rodada dedicada, com testes próprios.
