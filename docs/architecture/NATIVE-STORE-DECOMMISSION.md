# NATIVE-STORE-DECOMMISSION — plano de retirada da loja pública nativa `/loja`

**Data:** 2026-11-07 · **Branch:** `architecture/fase-0-blueprint`
**Decisão do Diretor (ADR-0007):** a loja nativa `/loja` **não** é mais
experiência pública de varejo; a **RETAIL WooCommerce** passa a ser a única loja
pública. A retirada foi **planejada para a Fase 2**, mas a **execução está
bloqueada** por ambiente/decisão (impedimentos I-1..I-4) — a superfície nativa
**ainda está ativa**. Ver
[`NATIVE-STORE-DECOMMISSION-REPORT.md`](NATIVE-STORE-DECOMMISSION-REPORT.md).
Este documento é a auditoria e o **plano** de retirada; nada aqui foi executado.

> **Restrições absolutas.** Não apagar tabelas/históricos/pedidos/clientes/
> produtos/financeiro. Não remover rota administrativa só porque o caminho
> contém `/loja`. Não alterar domínio RETAIL, DNS, publicação ou configuração
> externa. Não quebrar serviços internos compartilhados.

---

## 1. Inventário da loja nativa (o que existe hoje)

### 1.1 Experiência pública (a descontinuar)

| Item | Arquivo / rota | Papel |
|---|---|---|
| Rota `/loja` | `client/src/App.tsx:162` → `LojaInicioPage` | vitrine (home) |
| Rota `/loja/produto/:slug` | `App.tsx:163` → `LojaProdutoPage` | página de produto |
| Rota `/loja/carrinho` | `App.tsx:164` → `LojaCarrinhoPage` | carrinho |
| Rota `/loja/checkout` | `App.tsx:165` → `LojaCheckoutPage` | checkout |
| Rota `/loja/pedido/:token` | `App.tsx:166` → `LojaPedidoPage` | acompanhamento do pedido |
| Páginas | `client/src/pages/commerce/loja/*` | `LojaInicioPage`, `LojaProdutoPage`, `LojaCarrinhoPage`, `LojaCheckoutPage`, `LojaPedidoPage`, `LojaShell`, `HeroCarrossel`, `CardProduto` |
| Lógica de vitrine | `client/src/pages/commerce/loja/{carrinho,cotacao,quantidade}.ts` | carrinho/cotação no cliente |
| API pública | `server/src/index.ts:602-613` | `/api/loja/config`, `/api/loja/produtos`, `/api/loja/produtos/:slug`, `/api/loja/preview`, `/api/loja/carrinho/quantidade`, `/api/loja/payment-methods`, `/api/loja/checkout`, `/api/loja/checkout/:chave`, `/api/loja/pedidos/:token` |
| API pública (alias) | `index.ts:610` | `/api/commerce/checkout/payment-intent` |
| Backend de vitrine | `server/src/commerce/vitrine.ts` (1094 l.) | handlers da vitrine pública |
| SEO/SSR | `server/src/commerce/storefront-seo.ts` (193 l.) | rota `/loja` e `/loja/produto/:slug` no servidor |
| Carrinho | `server/src/commerce/quantidade-carrinho.ts` (99 l.) | +/− do carrinho |
| Base da loja | `server/src/commerce/loja-base.ts` (101 l.) | tenant/loja da vitrine |
| Menu | `client/src/modules.ts` (`commerce-loja`, `commerce-abrir-loja`) | "Loja própria" + "Abrir Loja" |

### 1.2 Serviços **compartilhados** (preservar — usados por WooCommerce/ERP)

| Item | Arquivo | Por que preservar |
|---|---|---|
| Motor de pedido/checkout | `server/src/commerce/pedidos.ts` (1474 l.) | cria `commerce_pedidos` também na importação WooCommerce |
| Normalização de comprador | `server/src/commerce/cliente.ts` | contato/consentimento usados por canais |
| Frete | `server/src/commerce/frete.ts` | `FreightProvider` reusado pelo motor de logística |
| Ambiente de pagamento | `server/src/commerce/pagamento-ambiente.ts` | usado pelo Payment Engine |
| Payment Engine | `modules/payments/*` | motor único (não é da vitrine) |
| Reserva de estoque | `server/src/estoqueCanonico.ts` | checkout **e** vendas/PDV |
| Configuração cifrada | `server/src/configuracoes.ts` | frete/pagamento por empresa |
| Integração WooCommerce | `server/src/loja.ts` | **integração externa**, não a vitrine nativa |
| Multi-store Woo | `server/src/commerce/woocommerce/*` | canais oficiais RETAIL/WHOLESALE |

> **Atenção:** `server/src/loja.ts` e as rotas `/api/marketplace/loja/*` e
> `/api/commerce/woocommerce/lojas/*` contêm `/loja` no caminho mas são a
> **integração com o WooCommerce** (canais oficiais). **NÃO** são a loja nativa
> e **não** devem ser removidas.

### 1.3 Área administrativa (revisar, não remover por reflexo)

| Item | Arquivo / rota | Decisão preliminar |
|---|---|---|
| `LojaConfigPage` (`/commerce/loja`) | `client/src/pages/commerce/LojaConfigPage.tsx` | configuração da **vitrine nativa** → revisar; o que for compartilhado (frete) migra para config de canal |
| `/api/commerce/loja/estado` | `index.ts:1106` (`estadoLoja`) | painel do estado da vitrine → revisar na Fase 2 |
| Módulo `commerce-loja` ("Loja própria") | `modules.ts:1929` | vira configuração de canal **ou** é retirado |
| Módulo `commerce-abrir-loja` ("Abrir Loja") | `modules.ts:1946` | **retirar** (apontava para `/loja`) |

### 1.4 Dados (preservar integralmente)

`commerce_pedidos`, `commerce_produtos`, `commerce_checkout`, `commerce_precos`,
`commerce_publicacoes`, `vendas`, `itens_venda`, `sales`, `sale_items`,
`estoque_reservas`, `payment_*` — **nenhuma** tabela é removida. A retirada é da
**superfície pública**, não do dado.

### 1.5 Testes afetados (atualizar na Fase 2)

`client/src/navegacao-loja.test.ts`,
`client/src/pages/commerce/LojaFluxoPages.test.tsx`,
`client/src/pages/commerce/loja/{LojaCarrinhoQuantidade,LojaPedidoPage,LojaCarrinhoPage,HeroCarrossel}.test.tsx`,
`client/src/pages/commerce/LojaConfigPage.test.tsx`,
`server/test/{commerce-cart-quantidade,commerce-pix-mock-flow,commerce-exposure}.test.ts`,
`client/src/modules.test.ts`.

---

## 2. Conflitos identificados entre a loja nativa e a RETAIL WooCommerce

| Conflito | Evidência | Risco |
|---|---|---|
| **Duas superfícies públicas de varejo** | `/loja` (nativo) × `brobond.com.br` (Woo RETAIL) | ambiguidade de canal, SEO duplicado |
| **Duas origens no BI** | ADR-008 §6: `/loja` e RETAIL tratados como origens possivelmente distintas | relatórios não distinguem |
| **Dois checkouts** | `/api/loja/checkout` (nativo) × checkout Woo | divergência de regra |
| **Rótulo** | `modules.ts` aponta `/loja` como "experiência pública oficial" | confusão de navegação |
| **Preço/estoque** | ambos publicam no mesmo catálogo | risco de divergência (mitigado: ERP é autoridade) |

---

## 3. Procedimento de descontinuação segura (Fase 2)

### 3.1 Etapas

1. **Inventário de dependências** (feito — §1). Confirmar por `grep` que nenhum
   serviço compartilhado depende **exclusivamente** da vitrine.
2. **Retirar a navegação pública:** remover/repurpor os módulos `commerce-loja` e
   `commerce-abrir-loja` em `modules.ts`; atualizar `audit:menu`.
3. **Retirar as rotas públicas da SPA:** remover as 5 rotas `/loja/*` de
   `App.tsx`; adicionar rota de tratamento (§3.2).
4. **Retirar/neutralizar a API pública da vitrine:** desregistrar as rotas
   `/api/loja/*` e `/api/commerce/checkout/payment-intent` (alias da vitrine),
   mantendo as rotas de canal WooCommerce.
5. **Preservar serviços compartilhados:** manter `commerce/pedidos.ts`,
   `cliente.ts`, `frete.ts`, `pagamento-ambiente.ts`, Payment Engine, reserva.
6. **Revisar a área administrativa:** decidir o destino de `LojaConfigPage` e
   `estadoLoja` (repurpor config compartilhada; remover o que for só da vitrine).
7. **Atualizar testes:** remover/reescrever os testes da vitrine; adicionar teste
   de **não-regressão do RETAIL** e teste das URLs antigas.
8. **Atualizar documentação:** `docs/INTEGRACAO-LOJA.md`, `docs/STOREFRONT-ENTERPRISE.md`,
   `docs/ERP-3.0-CAPACITIES.json`, `README.md` e este diretório.
9. **Validar:** `typecheck`, `lint`, `audit:menu`, `audit:ux`, `architecture:audit`,
   suítes server/client; fluxo de compra do RETAIL validado **sem compra real**.

### 3.2 Comportamento das URLs antigas (SEO)

| URL | Tratamento proposto | Justificativa |
|---|---|---|
| `/loja` | **301** para a RETAIL (URL configurável) quando definida; senão **410 Gone** com página informativa | preserva link equity para a nova loja; 410 quando não há destino |
| `/loja/produto/:slug` | **301** para a RETAIL (`/produto/:slug`) quando configurada; senão **410** | slug pode coincidir; sem certeza → 410 |
| `/loja/carrinho` | **410 Gone** | caminho transacional sem equivalente |
| `/loja/checkout` | **410 Gone** | idem |
| `/loja/pedido/:token` | **410 Gone** | token é da vitrine; sem equivalente |

> **Decisão pendente do Diretor (não bloqueante):** o destino exato do 301
> depende da decisão de DNS/edge de `brobond.com.br` (ADR-008 §6). Enquanto ela
> não existir, o plano prevê **410** por padrão e **301** quando a variável de
> ambiente `STOREFRONT_REDIRECT_URL` estiver definida — **sem** alterar DNS.

### 3.3 O que NÃO fazer

- Não apagar tabelas nem dados (§1.4).
- Não remover `/api/marketplace/loja/*` nem `/api/commerce/woocommerce/lojas/*`.
- Não remover `server/src/loja.ts` (integração WooCommerce).
- Não alterar DNS, publicação ou configuração externa.
- Não simular a remoção: se algum item não puder ser retirado com segurança na
  Fase 2, entregar o plano e registrar o impedimento exato.

---

## 4. Critérios de aceite da descontinuação

1. Nenhuma rota pública `/loja/*` na SPA nem `/api/loja/*` no servidor.
2. Nenhum item de menu apontando para `/loja`.
3. RETAIL WooCommerce **independente e operacional** (fluxo de compra validado
   sem compra real).
4. Serviços compartilhados intactos (pedido, cliente, frete, pagamento, reserva).
5. Dados históricos intactos (nenhuma tabela removida).
6. URLs antigas respondem 301/410 conforme §3.2.
7. Testes atualizados e verdes; gates de menu/arquitetura sem erro novo.
8. Documentação atualizada.

---

## 5. Riscos da descontinuação

| Risco | Nível | Mitigação |
|---|---|---|
| Remover serviço compartilhado por engano | P1 | inventário §1.2 + revisão por `grep` de imports |
| Quebrar o fluxo RETAIL | P1 | teste de não-regressão do RETAIL |
| SEO (perda de posições) | P2 | 301 quando houver destino; 410 explícito |
| Área administrativa órfã | P2 | decisão explícita sobre `LojaConfigPage`/`estadoLoja` |
| Config de frete usada por canal | P2 | migrar config compartilhada antes de remover a tela |

---

*Status:* **plano entregue (Fase 0)** · execução **tentada na Fase 2 e
bloqueada** por ambiente/decisão (impedimentos I-1..I-4) — ver
[`NATIVE-STORE-DECOMMISSION-REPORT.md`](NATIVE-STORE-DECOMMISSION-REPORT.md).
A retirada está **pendente para a Fase 3** (BL-015 / DEC-004); a superfície
nativa **ainda está ativa**.
