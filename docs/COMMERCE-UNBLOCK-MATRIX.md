# COMMERCE — MATRIZ DE DESBLOQUEIO (reconstruída a partir do código real)

> Reconstruído em 2026-10-29. Cada linha é um bloqueio que **existia ou podia
> existir**, com o estado REAL resolvido vs. pendente. Nada foi convertdo em
> "warning" para obter READY.

## 1. Legenda

- **DESBLOQUEADO** — removido nesta rodada, com evidência executada.
- **PENDENTE EXTERNO** — não depende do código; exige ação fora do repositório
  (credencial oficial, homologação de marketplace). Alimenta apenas
  `EXTERNAL_HOMOLOGATION_READY`.
- **PENDENTE NÃO-BLOQUEANTE (P2/P3)** — dívida relatada no gate, não bloqueia
  `CODE_READY`.

## 2. Matriz

| # | Bloqueio | Classe | Estado | Evidência / motivo |
| --- | --- | --- | --- | --- |
| 1 | `GET /api/commerce/publicacoes/:id` inexistente (detalhe/editar sem API) | P0 código | **DESBLOQUEADO** | rota registrada (`index.ts:967`) + `obterPublicacaoCommerce` + testes das 3 telas |
| 2 | `PUT /api/commerce/produtos/:id` resolvia projeção pelo id errado | P0 código | **DESBLOQUEADO** | fix `{ produto_id, empresa_id }` em `catalogo.ts` + `commerce-paineis-api.test.ts` |
| 3 | `GET /api/commerce/ofertas` e `/:id` inexistentes | P1 código | **DESBLOQUEADO** | `index.ts:970-971` + `listarOfertasCommerce`/`obterOfertaCommerce` + testes das 3 telas |
| 4 | `GET /api/commerce/erros` inexistente (erros invisíveis no painel) | P1 código | **DESBLOQUEADO** | `index.ts:982` + `listarErrosCommerce` + `commerce-paineis-api.test.ts` (inclui 403 a operador) |
| 5 | 12 páginas operacionais sem rota (pagamentos, reservas, fulfillment, devoluções, eventos, erros, ofertas, publicações ±) | P0/P1 código | **DESBLOQUEADO** | 13 rotas novas em `App.tsx`, todas `<ModuleAccess>`, 12 arquivos de teste novos; suíte client 108/986 verde |
| 6 | Filtro de status das devoluções silenciosamente inócuo (`filter.status` ≠ contrato `f.status`) | P1 código | **DESBLOQUEADO** | correção em `DevolucoesPage.tsx` + teste de contrato (4/4) |
| 7 | `npm run commerce:final-go-live` inexistente (gate independente P0/P1/P2 + vereditos) | P0 processo | **DESBLOQUEADO** | `scripts/commerce-final-go-live-audit.ts` registrado em `package.json`; execução EXIT 0, P0=0, P1=0 |
| 8 | 4 documentos de aceitação ausentes | P2 processo | **DESBLOQUEADO** | `COMMERCE-FINAL-ACCEPTANCE.md`, `COMMERCE-UNBLOCK-MATRIX.md` (este), `COMMERCE-FINAL-AUDIT.md`, `CREATORS-COMMERCE-INTEGRATION-AUDIT.md` reconstruídos do código/execução |
| 9 | PostgreSQL real para `test:pg`/`smoke:pg`/`db:validate` | Infra | **DESBLOQUEADO** | PG **16.14** (`160014`) servida em `127.0.0.1:5433` via `@embedded-postgres/linux-x64@16.14.0-beta.17`; `test:pg` **315/0/0/0**; `smoke:pg` **396/396** |
| 10 | `prisma validate` sem rede para `binaries.prisma.sh` | Infra/ambiente | **DESBLOQUEADO (com nota)** | executado via WASM embutido com engines apontados para `/bin/false` (não invocáveis); prova negativa saiu exit 1 com erro real; ver §3 da `COMMERCE-FINAL-ACCEPTANCE.md` |
| 11 | Credencial oficial **Mercado Livre** | **Externo** | **PENDENTE EXTERNAL** (`EXTERNAL_HOMOLOGATION_BLOCKED`) | `MERCADOLIVRE_TOKEN` ausente; `connectors` sem linha utilizável. Nenhum segredo solicitado ao usuário |
| 12 | Credencial oficial **Nuvemshop** | **Externo** | **PENDENTE EXTERNAL** | idem — loja não conectada |
| 13 | Credencial oficial **Mercado Pago** | **Externo** | **PENDENTE EXTERNAL** | idem — gateway real não configurado (mock existe só p/ fora de produção) |
| 14 | Credencial oficial **Instagram/Meta** | **Externo** | **PENDENTE EXTERNAL** | idem — controller de webhook pronto (`x-hub-signature-256`), app oficial não homologado |
| 15 | Warnings `ROTA_SEM_MENU` das subrotas novas (ofertas/pagamentos/…) | P3 | **RELATADO (não bloqueia)** | navegação por link é o padrão das subrotas (mesma situação de `/devolucoes/nova` pré-existente); `audit:menu` exit 0 |
| 16 | `TENANT_SEM_TESTE` de `commerce_outbox/promocoes/cupons/rastreio` (não citados nominalmente em teste A×B) | P2 | **RELATADO (não bloqueia)** | cobertura de tenancy existe por `escopoDoAtor` + `p0-commerce-tenant` + testes de painéis cross-tenant 404; teste nominal A×B por recurso continua na dívida |
| 17 | 3 warnings novos de lint (588→591) | P3 | **RELATADO (não bloqueia)** | `no-explicit-any` em código de teste/ajuste; lint exit 0 com 0 erros |

## 3. Efeito nos vereditos

- Linhas 1–10 resolvidas → **`CODE_READY = SIM`** (gate `commerce:final-go-live` exit 0, P0=0/P1=0).
- Linhas 11–14 pendentes → **`EXTERNAL_HOMOLOGATION_BLOCKED`** →
  **`FULL_GO_LIVE = NÃO`**, sem qualquer conversão em warning.
- Linhas 15–17 seguem relatadas em `P2`/`P3` no relatório do gate.
