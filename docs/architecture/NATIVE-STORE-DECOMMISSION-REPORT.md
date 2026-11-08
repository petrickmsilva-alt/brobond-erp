# NATIVE-STORE-DECOMMISSION-REPORT — relatório de retirada da loja nativa

**Data:** 2026-11-07 · **Branch:** `architecture/fase-2-canonical-erp-data`
**Plano de origem:** [`NATIVE-STORE-DECOMMISSION.md`](NATIVE-STORE-DECOMMISSION.md)
(Fase 0) · **Decisão:** ADR-0007 (aceita pelo Diretor).

> **Resultado desta fase: NÃO EXECUTADA.** O §6.8 do PROMPT MASTER autoriza
> entregar o plano completo e registrar **exatamente** o impedimento quando a
> retirada não puder ser feita com segurança. É o caso: **não** se simula uma
> remoção concluída.

---

## 1. O que foi confirmado (auditoria executada)

| Item | Evidência | Situação |
|---|---|---|
| Rotas públicas na SPA | `client/src/App.tsx:162-166` (5 rotas `/loja/*`) | confirmado |
| Páginas da vitrine | `client/src/pages/commerce/loja/*` (5 páginas + shell + componentes) | confirmado |
| Lógica de vitrine no cliente | `loja/{carrinho,cotacao,quantidade}.ts` | confirmado |
| API pública da vitrine | `server/src/index.ts:602-613` (`/api/loja/*` + alias `/api/commerce/checkout/payment-intent`) | confirmado |
| Backend da vitrine | `server/src/commerce/vitrine.ts` (1094 l.) | confirmado |
| SEO/SSR | `server/src/commerce/storefront-seo.ts` (193 l.), `index.ts:1510` | confirmado |
| Menu | `client/src/modules.ts` (`commerce-loja`, `commerce-abrir-loja`) | confirmado |
| **Serviços compartilhados** | `commerce/pedidos.ts`, `cliente.ts`, `frete.ts`, `pagamento-ambiente.ts`, `estoqueCanonico.ts`, `loja.ts`, `commerce/woocommerce/*` | **preservar** |
| **Falso positivo** | `/api/marketplace/loja/*` e `/api/commerce/woocommerce/lojas/*` contêm `/loja` mas são **integração WooCommerce** | **não remover** |
| Dados | nenhuma tabela é removida | **preservar** |

## 2. Por que a remoção NÃO foi executada com segurança

### 2.1 Gate de validação impossível neste ambiente

O critério de aceite §4.3 do plano exige **validar o fluxo de compra do RETAIL
sem compra real**. Isso requer:

- **PostgreSQL 16.14 real** — `npm run test:pg` exige `DATABASE_URL` de banco
  vazio. No sandbox atual está **bloqueado** (BL-009).
- **Credenciais WooCommerce** (CK/CS) de RETAIL/WHOLESALE — **não disponíveis**
  e **proibido** ativar integração externa nesta missão (§8 do PROMPT MASTER).

Sem esses dois, remover as rotas públicas deixaria o sistema **sem prova de que
o RETAIL permanece operacional** — exatamente o risco P1 que o plano manda
evitar. Não se remove a loja nativa "no escuro".

### 2.2 Decisão pendente do Diretor (DEC-001)

O comportamento das URLs antigas (301 vs 410) depende da decisão de DNS/edge de
`brobond.com.br`. A remoção **sem** essa decisão deixaria URLs públicas órfãs
(risco de SEO). O fallback 410 existe, mas a remoção física das rotas deve
acontecer junto com o tratamento de URL — não antes.

### 2.3 Escopo de superfície grande e compartilhado

A remoção toca **~15 arquivos de teste** e um serviço (`commerce_configuracoes`)
lido por `frete.ts`/`estado-loja.ts`/`services.ts` — que **não** é exclusivo da
vitrine. Sem banco real para rodar as suítes completas, o risco de quebra
silenciosa de um serviço compartilhado é alto.

## 3. O que permanece pronto para execução

1. Inventário completo (§1) — feito.
2. Etapas ordenadas (§3.1 do plano) — feitas.
3. Comportamento de URLs antigas (§3.2) — definido (301 com
   `STOREFRONT_REDIRECT_URL`, senão 410).
4. Critérios de aceite (§4) — definidos.
5. Teste de **não-regressão do RETAIL** — a ser criado na execução.
6. Registro do bloqueio em `MASTER-BACKLOG.md` (BL-015) e decisão DEC-004.

## 4. Impedimentos (exatos)

| # | Impedimento | Bloqueia | Como remover |
|---|---|---|---|
| I-1 | Sem PostgreSQL real (`test:pg` bloqueado) | prova do fluxo RETAIL | habilitar `DATABASE_URL` + PG 16.14 (CI) |
| I-2 | Sem credenciais WooCommerce | validação do RETAIL | secret de homologação |
| I-3 | Decisão de DNS/SEO pendente (DEC-001) | tratamento das URLs antigas | decisão do Diretor |
| I-4 | Sem ambiente para rodar suítes completas após remoção | prova de não-regressão | CI verde no PR de remoção |

## 5. Recomendação

Executar a descontinuação na **Fase 3**, em um PR dedicado, com:

- CI verde nos dois jobs (incluindo `testes-postgres`);
- credenciais WooCommerce de **homologação** (sem compra real);
- decisão DEC-001 tomada (301/410);
- teste de não-regressão do RETAIL;
- URLs antigas respondendo conforme §3.2 do plano.

Até lá, a loja nativa **permanece como está** — nenhum estado intermediário
inseguro foi introduzido.

---

*Status:* **plano confirmado · execução bloqueada (impedimentos I-1..I-4)** ·
**nenhuma alteração de produção**.
