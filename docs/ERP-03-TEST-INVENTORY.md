# ERP-03 — inventário por arquivo de teste (checkout a33811f + ERP-03)

Classificação por **arquivo**, não contagem de assertions. A = unitário puro; B = integração PG; C = E2E PG/HTTP; D = corrida PG; E = contrato/API; F = memória/mocks; G = externo. Um arquivo pode conter mais de uma classe. `B/C/D` **só** para arquivos incluídos em `server/package.json:test:pg`. O tipo de caso individual é detalhado no nome do teste; executar `rg -n "^(test|describe)\(" <arquivo>` para listá-los. `server/test/smoke.mjs` não faz parte do glob de `server test`. Nenhum G é critério do CORE.

| Arquivo | Classe (predominante) | PG real? | Mock/in-memory? | Equivalente PG identificado? | Comando |
|---|---|---|---|---|---|
| `server/test/api.test.ts` | F/E | não | sim (predomina) | ver matriz funcional | `npm --workspace server test` |
| `server/test/auditoria-multiempresa.test.ts` | F | não | sim (predomina) | ver matriz funcional | `npm --workspace server test` |
| `server/test/auditoria.test.ts` | F | não | sim (predomina) | ver matriz funcional | `npm --workspace server test` |
| `server/test/auth-fluxo.test.ts` | F/E | não | sim (predomina) | ver matriz funcional | `npm --workspace server test` |
| `server/test/compras-xml-depara.test.ts` | F | não | sim (predomina) | ver matriz funcional | `npm --workspace server test` |
| `server/test/compras.test.ts` | F | não | sim (predomina) | ver matriz funcional | `npm --workspace server test` |
| `server/test/connectors.test.ts` | F | não | sim (predomina) | ver matriz funcional | `npm --workspace server test` |
| `server/test/cotacoes-compra.test.ts` | F | não | sim (predomina) | ver matriz funcional | `npm --workspace server test` |
| `server/test/custo-ficha.test.ts` | F | não | sim (predomina) | ver matriz funcional | `npm --workspace server test` |
| `server/test/custo-recebimento.test.ts` | F | não | sim (predomina) | ver matriz funcional | `npm --workspace server test` |
| `server/test/dashboard-escopo.test.ts` | F | não | sim (predomina) | ver matriz funcional | `npm --workspace server test` |
| `server/test/e421-estoque.test.ts` | F | não | sim (predomina) | ver matriz funcional | `npm --workspace server test` |
| `server/test/empresas-admin.test.ts` | F | não | sim (predomina) | ver matriz funcional | `npm --workspace server test` |
| `server/test/endereco-publico.test.ts` | A | não | sim (predomina) | ver matriz funcional | `npm --workspace server test` |
| `server/test/expedicao.test.ts` | F | não | sim (predomina) | ver matriz funcional | `npm --workspace server test` |
| `server/test/financeiro-onda-b.test.ts` | F | não | sim (predomina) | ver matriz funcional | `npm --workspace server test` |
| `server/test/financeiro-onda-c.test.ts` | F | não | sim (predomina) | ver matriz funcional | `npm --workspace server test` |
| `server/test/financeiro-p2.test.ts` | F | não | sim (predomina) | ver matriz funcional | `npm --workspace server test` |
| `server/test/financeiro-profissional.test.ts` | F | não | sim (predomina) | ver matriz funcional | `npm --workspace server test` |
| `server/test/fiscal.test.ts` | F | não | sim (predomina) | ver matriz funcional | `npm --workspace server test` |
| `server/test/fuso.test.ts` | A | não | sim (predomina) | ver matriz funcional | `npm --workspace server test` |
| `server/test/grades.test.ts` | F | não | sim (predomina) | ver matriz funcional | `npm --workspace server test` |
| `server/test/listas-preco.test.ts` | F | não | sim (predomina) | ver matriz funcional | `npm --workspace server test` |
| `server/test/locais.test.ts` | F | não | sim (predomina) | ver matriz funcional | `npm --workspace server test` |
| `server/test/logistica.test.ts` | F | não | sim (predomina) | ver matriz funcional | `npm --workspace server test` |
| `server/test/loja.test.ts` | F | não | sim (predomina) | ver matriz funcional | `npm --workspace server test` |
| `server/test/medidas.test.ts` | F | não | sim (predomina) | ver matriz funcional | `npm --workspace server test` |
| `server/test/multiempresa-p1.test.ts` | F | não | sim (predomina) | ver matriz funcional | `npm --workspace server test` |
| `server/test/multiempresa-paridade.test.ts` | F | não | sim (predomina) | ver matriz funcional | `npm --workspace server test` |
| `server/test/multiempresa.test.ts` | F | não | sim (predomina) | ver matriz funcional | `npm --workspace server test` |
| `server/test/negocios-fuso.test.ts` | F | não | sim (predomina) | ver matriz funcional | `npm --workspace server test` |
| `server/test/negocios-projecao-erp.test.ts` | F | não | sim (predomina) | ver matriz funcional | `npm --workspace server test` |
| `server/test/negocios-seguranca.test.ts` | F | não | sim (predomina) | ver matriz funcional | `npm --workspace server test` |
| `server/test/negocios.test.ts` | F | não | sim (predomina) | ver matriz funcional | `npm --workspace server test` |
| `server/test/pdv.test.ts` | F | não | sim (predomina) | ver matriz funcional | `npm --workspace server test` |
| `server/test/pedidos.test.ts` | F | não | sim (predomina) | ver matriz funcional | `npm --workspace server test` |
| `server/test/pg-auditoria-multiempresa.test.ts` | B | sim | não (DB); externo depende do caso | — | `npm run test:pg` |
| `server/test/pg-compras-e32.test.ts` | B | sim | não (DB); externo depende do caso | — | `npm run test:pg` |
| `server/test/pg-concorrencia.test.ts` | B/D | sim | não (DB); externo depende do caso | — | `npm run test:pg` |
| `server/test/pg-convite.test.ts` | B | sim | não (DB); externo depende do caso | — | `npm run test:pg` |
| `server/test/pg-cotacoes-compra.test.ts` | B/D | sim | não (DB); externo depende do caso | — | `npm run test:pg` |
| `server/test/pg-custo-recebimento.test.ts` | B/D | sim | não (DB); externo depende do caso | — | `npm run test:pg` |
| `server/test/pg-dashboard-escopo.test.ts` | B | sim | não (DB); externo depende do caso | — | `npm run test:pg` |
| `server/test/pg-empresas-admin.test.ts` | B | sim | não (DB); externo depende do caso | — | `npm run test:pg` |
| `server/test/pg-fiscal.test.ts` | B | sim | não (DB); externo depende do caso | — | `npm run test:pg` |
| `server/test/pg-fuso.test.ts` | B | sim | não (DB); externo depende do caso | — | `npm run test:pg` |
| `server/test/pg-multiempresa.test.ts` | B | sim | não (DB); externo depende do caso | — | `npm run test:pg` |
| `server/test/pg-negocios.test.ts` | B | sim | não (DB); externo depende do caso | — | `npm run test:pg` |
| `server/test/pg-p1.test.ts` | B | sim | não (DB); externo depende do caso | — | `npm run test:pg` |
| `server/test/pg-p2.test.ts` | B/D | sim | não (DB); externo depende do caso | — | `npm run test:pg` |
| `server/test/pg-producao-e2.test.ts` | B/D | sim | não (DB); externo depende do caso | — | `npm run test:pg` |
| `server/test/pg-usuario-convite.test.ts` | B | sim | não (DB); externo depende do caso | — | `npm run test:pg` |
| `server/test/producao-e2.test.ts` | F | não | sim (predomina) | ver matriz funcional | `npm --workspace server test` |
| `server/test/propostas.test.ts` | F | não | sim (predomina) | ver matriz funcional | `npm --workspace server test` |
| `server/test/regras.test.ts` | F | não | sim (predomina) | ver matriz funcional | `npm --workspace server test` |
| `server/test/relatorios.test.ts` | F | não | sim (predomina) | ver matriz funcional | `npm --workspace server test` |
| `server/test/url-publica.test.ts` | A | não | sim (predomina) | ver matriz funcional | `npm --workspace server test` |
| `server/test/usuarios.test.ts` | F | não | sim (predomina) | ver matriz funcional | `npm --workspace server test` |
| `server/test/utils.test.ts` | A | não | sim (predomina) | ver matriz funcional | `npm --workspace server test` |
| `server/test/valorizacao.test.ts` | F | não | sim (predomina) | ver matriz funcional | `npm --workspace server test` |
| `server/test/variacoes.test.ts` | F | não | sim (predomina) | ver matriz funcional | `npm --workspace server test` |
| `server/test/webhooks.test.ts` | F | não | sim (predomina) | ver matriz funcional | `npm --workspace server test` |
| `server/test/pg/bi-faturamento-e2e.test.ts` | B/C | sim | não (DB); externo depende do caso | — | `npm run test:pg` |
| `server/test/pg/comissoes-e2e.test.ts` | B/C | sim | não (DB); externo depende do caso | — | `npm run test:pg` |
| `server/test/pg/comissoes-periodo.test.ts` | B | sim | não (DB); externo depende do caso | — | `npm run test:pg` |
| `server/test/pg/contrato-tipo-coluna.test.ts` | B/E | sim | não (DB); externo depende do caso | — | `npm run test:pg` |
| `server/test/pg/devolucao-e2e.test.ts` | B/C | sim | não (DB); externo depende do caso | — | `npm run test:pg` |
| `server/test/pg/e01-gateway-webhook-postgresql.test.ts` | B/C/D | sim | não (DB); externo depende do caso | — | `npm run test:pg` |
| `server/test/pg/e02-ordem-reabrir-postgresql.test.ts` | B/C | sim | não (DB); externo depende do caso | — | `npm run test:pg` |
| `server/test/pg/e02-reabertura-estorno-postgresql.test.ts` | B/C/D | sim | não (DB); externo depende do caso | — | `npm run test:pg` |
| `server/test/pg/e03-core-gate.test.ts` | B | sim | não (DB); externo depende do caso | — | `npm run test:pg` |
| `server/test/pg/e03-multiempresa-ab.test.ts` | B | sim | não (DB); externo depende do caso | — | `npm run test:pg` |
| `server/test/pg/e03-onboarding-local-padrao.test.ts` | B | sim | não (DB); externo depende do caso | — | `npm run test:pg` |
| `server/test/pg/e42-http.test.ts` | B/C/D | sim | não (DB); externo depende do caso | — | `npm run test:pg` |
| `server/test/pg/e42-tenant.test.ts` | B/D | sim | não (DB); externo depende do caso | — | `npm run test:pg` |
| `server/test/pg/e421-estoque-integridade.test.ts` | B/D | sim | não (DB); externo depende do caso | — | `npm run test:pg` |
| `server/test/pg/e423-expedicao-postgresql.test.ts` | B/D | sim | não (DB); externo depende do caso | — | `npm run test:pg` |
| `server/test/pg/empresas-admin-e2e.test.ts` | B/C | sim | não (DB); externo depende do caso | — | `npm run test:pg` |
| `server/test/pg/fiscal-inutilizacao-e2e.test.ts` | B/C | sim | não (DB); externo depende do caso | — | `npm run test:pg` |
| `server/test/pg/gateway-cadeia-pagamento-e2e.test.ts` | B/C | sim | não (DB); externo depende do caso | — | `npm run test:pg` |
| `server/test/pg/projecao-sem-usuario.test.ts` | B | sim | não (DB); externo depende do caso | — | `npm run test:pg` |
| `client/src/lib/datas.test.ts` | A/F (UI/jsdom) | não | sim (jsdom/mocks) | não: UI não é prova de DB | `npm --workspace client test` |
| `client/src/lib/periodo.test.ts` | A/F (UI/jsdom) | não | sim (jsdom/mocks) | não: UI não é prova de DB | `npm --workspace client test` |
| `client/src/modules.test.ts` | A/F (UI/jsdom) | não | sim (jsdom/mocks) | não: UI não é prova de DB | `npm --workspace client test` |
| `client/src/components/CompanySwitcher.test.tsx` | A/F (UI/jsdom) | não | sim (jsdom/mocks) | não: UI não é prova de DB | `npm --workspace client test` |
| `client/src/components/Layout.test.tsx` | A/F (UI/jsdom) | não | sim (jsdom/mocks) | não: UI não é prova de DB | `npm --workspace client test` |
| `client/src/components/RecebimentoCompraModal.test.tsx` | A/F (UI/jsdom) | não | sim (jsdom/mocks) | não: UI não é prova de DB | `npm --workspace client test` |
| `client/src/components/Sidebar.test.tsx` | A/F (UI/jsdom) | não | sim (jsdom/mocks) | não: UI não é prova de DB | `npm --workspace client test` |
| `client/src/components/ui-kit-negocios.test.tsx` | A/F (UI/jsdom) | não | sim (jsdom/mocks) | não: UI não é prova de DB | `npm --workspace client test` |
| `client/src/components/ui-kit.test.tsx` | A/F (UI/jsdom) | não | sim (jsdom/mocks) | não: UI não é prova de DB | `npm --workspace client test` |
| `client/src/components/ui.test.tsx` | A/F (UI/jsdom) | não | sim (jsdom/mocks) | não: UI não é prova de DB | `npm --workspace client test` |
| `client/src/pages/ComissoesPage.test.tsx` | A/F (UI/jsdom) | não | sim (jsdom/mocks) | não: UI não é prova de DB | `npm --workspace client test` |
| `client/src/pages/ConectorPage.test.tsx` | A/F (UI/jsdom) | não | sim (jsdom/mocks) | não: UI não é prova de DB | `npm --workspace client test` |
| `client/src/pages/CotacoesCompraPage.test.tsx` | A/F (UI/jsdom) | não | sim (jsdom/mocks) | não: UI não é prova de DB | `npm --workspace client test` |
| `client/src/pages/CustoPage.test.tsx` | A/F (UI/jsdom) | não | sim (jsdom/mocks) | não: UI não é prova de DB | `npm --workspace client test` |
| `client/src/pages/Dashboard.negocios.test.tsx` | A/F (UI/jsdom) | não | sim (jsdom/mocks) | não: UI não é prova de DB | `npm --workspace client test` |
| `client/src/pages/Dashboard.test.tsx` | A/F (UI/jsdom) | não | sim (jsdom/mocks) | não: UI não é prova de DB | `npm --workspace client test` |
| `client/src/pages/DevolucoesPage.test.tsx` | A/F (UI/jsdom) | não | sim (jsdom/mocks) | não: UI não é prova de DB | `npm --workspace client test` |
| `client/src/pages/EmpresasPage.test.tsx` | A/F (UI/jsdom) | não | sim (jsdom/mocks) | não: UI não é prova de DB | `npm --workspace client test` |
| `client/src/pages/ExpedicaoPage.test.tsx` | A/F (UI/jsdom) | não | sim (jsdom/mocks) | não: UI não é prova de DB | `npm --workspace client test` |
| `client/src/pages/InutilizacoesPage.test.tsx` | A/F (UI/jsdom) | não | sim (jsdom/mocks) | não: UI não é prova de DB | `npm --workspace client test` |
| `client/src/pages/Login.test.tsx` | A/F (UI/jsdom) | não | sim (jsdom/mocks) | não: UI não é prova de DB | `npm --workspace client test` |
| `client/src/pages/LogisticaPage.test.tsx` | A/F (UI/jsdom) | não | sim (jsdom/mocks) | não: UI não é prova de DB | `npm --workspace client test` |
| `client/src/pages/NcmPage.test.tsx` | A/F (UI/jsdom) | não | sim (jsdom/mocks) | não: UI não é prova de DB | `npm --workspace client test` |
| `client/src/pages/OrdemDetail.test.tsx` | A/F (UI/jsdom) | não | sim (jsdom/mocks) | não: UI não é prova de DB | `npm --workspace client test` |
| `client/src/pages/PdvPage.test.tsx` | A/F (UI/jsdom) | não | sim (jsdom/mocks) | não: UI não é prova de DB | `npm --workspace client test` |
| `client/src/pages/PlanejamentoProducaoPage.test.tsx` | A/F (UI/jsdom) | não | sim (jsdom/mocks) | não: UI não é prova de DB | `npm --workspace client test` |
| `client/src/pages/SugestaoCompraPage.test.tsx` | A/F (UI/jsdom) | não | sim (jsdom/mocks) | não: UI não é prova de DB | `npm --workspace client test` |
| `client/src/pages/UsuariosPage.test.tsx` | A/F (UI/jsdom) | não | sim (jsdom/mocks) | não: UI não é prova de DB | `npm --workspace client test` |

**Total:** 81 arquivos server `.test.ts` (35 PG) e 28 client. `scripts/smoke-e2e.mjs` = E/F em demo (`npm run smoke`) ou C quando invocado por `scripts/smoke-pg.mjs` (`npm run smoke:pg`, PG real). `server/test/smoke.mjs` = F/E, execução manual; não consta dos globs. **Mock em PG:** a suíte pode simular provedores externos e respostas HTTP; `PgStore`/`db` não são mockados.

Inventário não substitui a matriz de funcionalidade nem equivale a prova de integridade. Ver `RELATORIO-ERP-03.md`.
