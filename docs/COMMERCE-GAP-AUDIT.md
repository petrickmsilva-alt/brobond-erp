# COMMERCE — GAP AUDIT (capacidades × testes × lacunas honestas)

> Números da rodada de homologação desta entrega. Fonte:
> `docs/ERP-3.0-CAPACITIES.json` (148 capacidades),
> `scripts/capacidades-audit.ts` (exit 0 — **capabilidade sem teste: 0**),
> suites com contagem registrada no relatório final da PR.

## 1. Números da entrega

| Suíte | Resultado |
|---|---|
| `npm run typecheck` (domain+server+client) | 0 erros |
| `npm run test:server` | 1515 testes / 0 falha (unitários, inclusivos `commerce-oracle` 24) |
| `npm run test:client` | 96 arquivos / 947 testes / 0 falha (15 arquivos commerce: 13 rotas + subrotas + `LojaFluxoPages`) |
| `npm run test:pg` (gate) | 312 testes / 0 falha / 0 skip / 0 todo (PG 16.14 + psql 18.4; inclui `commerce-e2e`) |
| `commerce-concorrencia` (12 cenários PG) | 12/12 |
| `commerce-oracle` | 24/24 |
| `npm run audit:menu` | zero erros |
| `npm run capacidades-audit` | exit 0 (`CAPACIDADE_SEM_TESTE=0`) |
| `npm run smoke` / `smoke:pg` | 396 verificações verdes (demo e PG), sendo 10 do bloco COMMERCE |

## 2. Cobertura das áreas Commerce (space `commerce` = 13 rotas + 5 rotas `/loja`)

| Área | Rotas ERP | Testes |
|---|---|---|
| Catálogo (projeção, preço por canal, grade) | Produtos, Produto novo, Detalhe | `catalogo.test`, `produto-preco.test`, `grade.test`, `blocos-catalogo.test` + oracle + cenário 11 (preço ×6) |
| Fila multicanal | Fila de sincronização | `fila-sincronizacao.test` + cenários 01–04 (fila/claim/versão) |
| Publicações | Publicações | `produto-publicacoes.test` + `catalogo.test` (EAN bloqueado, etc.) |
| Pedidos omnichannel | Pedidos, Detalhe | `pedidos.test`, `pedido-detalhe.test` + cenários 07/09/10/12 + E2E |
| Checkout B2C | `/loja` shell + Carrinho/Checkout/Pedido | `LojaFluxoPages.test` (fluxo inteiro, zero modal) + E2E `commerce-e2e` |
| Promoções/cupons | Promoções, Form, Cupons, Form | `promocoes.test`, `cupom-form.test` + cenário 05 (cupom ×6 → 409) |
| Frete | Loja config | `loja-config.test` + `test:server` “Frete não configurado” + E2E fail-closed |
| Trends/analytics | Trends | `trends.test` + E2E (Serie real) |
| Delivery/tracking | Delivery | `delivery.test` + rastreio `create/update` por fluxo |
| Outbox/observabilidade | (API `/commerce/eventos`) | cenário 08 (4×4) + webhook idempotência (única execução) |
| Conectores | 4 módulos `connector:` | páginas reais (OAuth/config) |

## 3. Gaps conhecidos e honestos (P1/P2 — não bloqueiam)

1. **Instagram Shopping — publicação `REJECTED` por design.** A Graph API não
   publica item individual na sacolinha; a fila responde 409 com o motivo e o
   conector entrega catálogo/pedido pela via oficial. Não é “em breve”: é
   comportamento final documentado (`catalogo.ts:14`).
2. **WooCommerce sem módulo de conector na UI.** O canal publica/ingere
   (`wooFetch` em `loja.ts`) com `ConfigLoja` do servidor; falta apenas a tela
   `connector:` dedicada (UX, não capacidade).
3. **Credenciais ML/Nuvemshop/Instagram.** Fluxo completo implementado e
   idempotente; em produção dependem do OAuth do cliente. Sem credencial o
   resultado é `ERROR`/409 honesto. Esperado ser P1 no gate até provisionar.
4. **Enum legado `sale_channel` sem `WOOCOMMERCE`.** Não alteramos a migração
   histórica (regra); `commerce_pedidos.canal` cobre os 6 canais e a ponte
   grava na venda canônica o canal da origem. Item registrado, sem perda de
   dado.
5. **Frete só `nenhum|retirada|manual`.** Nenhum carrier externo (Correios,
   transportadora) — sem config a recusa é explícita. P2.
6. **Estoque por canal é leitura do canônico + reservas.** Não há escrita de
   estoque por canal (por design: um único motor). Reconciliação de ida-e-volta
   de marketplace é P2.
7. **Imagens** vêm do cadastro ERP (`foto_url`); não há upload de imagem do
   marketplace na vitrine. P2.
8. **Marketplace E2E cobre a vitrine própria + ingestão ML** (`golive03`);
   pedidos Nuvemshop/Woo/Instagram na ingestão têm caminho implementado mas
   sem suíte E2E própria — cobertos por fábrica/`loja.ts` (registro P2).

## 4. O que NÃO é gap (já funcional)

- Pagamento confirmado **apenas** por webhook assinado e idempotente (backend).
- Conversão `sales → vendas` pela ponte existente (não há segundo motor).
- Reservas no motor de estoque com garantia de serialidade por banco (índice
  único parcial) e `repetirSerial` em corridas 40001.
- Zero modal nas 13 rotas ERP + 5 da vitrine (prova com
  `queryByRole('dialog') === null`).
- Tenancy 404 cross-tenant; RBAC 403 por perfil; vendas sem escopo → 404.
- Nenhuma migração histórica alterada; nenhum dado apagado; `planned` só nos
  4 módulos que continuam planejados (Creators — fora do Commerce).
