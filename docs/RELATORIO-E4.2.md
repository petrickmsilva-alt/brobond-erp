# Relatório E4.2 — Gate de aceite e evidência de release

**Repositório:** `petrickmsilva-alt/brobond-erp`
**Branch:** `arena/4cb6e53b-brobond-erp`
**Data da execução:** 2026-10-09
**Escopo:** somente o gate de aceite E4.2; sem ampliar para E4.3–E4.6.

## Veredito

**E4.2 não aprovado nesta sessão: falta a evidência obrigatória atravessando HTTP, autenticação real, middleware, rotas Express, handlers/serviços e PostgreSQL real.** O harness foi adicionado e compilado, mas não foi executado porque não há `DATABASE_URL` nem PostgreSQL disponível neste ambiente. Nenhum status HTTP ou estado PostgreSQL do harness E4.2 pode ser declarado observado.

O smoke em modo demonstração, os testes unitários e o typecheck não substituem essa prova. A migration `0030_e42_locais_estoque_multempresa.sql` e o espelho em `db/schema.sql` foram revisados estaticamente; não foi observada aplicação em banco vazio ou upgrade real nesta sessão.

## Escopo e harness

`server/test/pg/e42-http.test.ts` inicia o `server/src/index.ts` real como processo filho, exige `GET /api/health` com `db=postgres`, autentica por login real com usuário persistido no PostgreSQL e usa os tokens/JWT emitidos pela aplicação para trocar a empresa ativa. Não injeta `req.user`, não chama handlers/services diretamente e não aceita MemStore como prova. Os snapshots de zero-write incluem linhas dos tenants A/B e registros correlacionados por IDs/marcadores de teste, inclusive escrita/auditoria; a comparação é feita diretamente no PostgreSQL.

`server/test/pg/e42-tenant.test.ts` permanece como cobertura PG complementar de serviços/handlers e de migration pelo runner `migrate()`. Por injetar ator/request, seus resultados, quando executados, não substituem a matriz HTTP. Neste ambiente ela também não foi executada.

Nenhuma migration adicional foi criada neste gate. A migration E4.2 em revisão é a `0030` já existente no workspace. A regressão de devolução total, `GAP-ESTQ-VENDA-ID` e o ciclo de vida P2 de `pdv_caixas.local/local_id` permanecem separados e sem correção neste PR.

## EVIDÊNCIA DE ACEITE HTTP + POSTGRESQL

A tabela descreve a evidência que o harness pretende produzir. **“Não observado” significa que o cenário não foi executado; não é pass, falha funcional nem evidência documental de aceite.**

| Cenário | Rota(s) / mecanismo | A/B | HTTP esperado | HTTP observado | PostgreSQL esperado | PostgreSQL observado |
|---|---|---|---|---|---|---|
| Bootstrap vazio e upgrade | `migrate()` existente; `GET /api/health` | N/A | Health `200`, `db=postgres` | Não observado; harness não iniciou | Schema/migration `0030` registrados; upgrade preserva `pdv_caixas.local_id IS NULL` legado, sem backfill heurístico | Não observado; nenhum banco disponível |
| Autenticação e seletor | `POST /api/auth/login`, `GET/POST /api/empresas/ativa`, `GET /api/locais` | A → B → A | Login e seletor `200`; rota protegida sem token `401`; token novo representa a empresa ativa | Não observado; harness não executado | Usuário e concessões persistidos para A/B; ownership permanece na empresa de origem | Não observado |
| Falsificação/alteração de empresa | `POST /api/locais`, `POST /api/produtos`, `PUT /api/produtos/:id`, `PUT /api/locais/:id` | A envia B e B envia A | Criações `201`, alterações próprias `200`; `empresa_id` retornado vem do ator | Não observado | `empresa_id` real não muda por body; locais/produtos permanecem no tenant correto | Não observado |
| Locais, homônimos, defaults e rename | `/locais`, `GET /api/meta`, `PUT /api/locais/:id` | A e B; rename em A | Leitura/meta e rename próprios `200`; cada tenant mantém seu local/default | Não observado | Dois nomes iguais permitidos em tenants distintos; padrão e rename de A não alteram B | Não observado |
| IDs e referências cross-tenant; zero-write | `GET /api/produtos/:id`, `/locais/:id`, `/inventarios/:id`, `/pdv/caixas/:id/resumo`; `POST /api/movimentacoes`, `/api/pdv/caixas`, `/api/importar/confirmar`; fechamento de inventário | A → B e B → A | IDs/referências alheios `404`; snapshots PG antes/depois idênticos após rejeições | Não observado | Nenhum saldo, movimento, inventário, caixa, referência ou auditoria parcial gravado | Não observado |
| Saldos e inventário | `POST /api/movimentacoes`, `POST /api/inventarios`, `GET/PUT /api/inventarios/:id/itens`, `POST /api/inventarios/:id/fechar` | A e B | Rotas próprias `201/200`; leitura/fechamento estrangeiros `404` | Não observado | `tamanho_id IS NULL` e tamanho preenchido são células distintas; inventário e ajustes ficam no tenant/local correto | Não observado |
| Importação | `POST /api/importar/preview`, `POST /api/importar/confirmar` | Sucesso em A; referência estrangeira em B | Preview/confirmação válida `200`; importação com produto estrangeiro `404` | Não observado | `empresa_id=A`, produto/tamanho/local/saldo e movimento persistidos em A; rejeição estrangeira sem write parcial | Não observado |
| Relatórios, exportações e integrações locais | `/api/relatorios/estoque-posicao`, `/api/relatorios/movimentacoes-periodo`, `/api/estoques/export?format=csv|xlsx`, `/api/marketplace/loja/{status,produtos,pedidos,estoque}`, `/api/connectors` | A e B | A vê somente A; B não acessa integração vinculada a A (`404`); sem credenciais, mutações Woo bloqueadas (`409`) antes de chamada externa | Não observado; não foram usadas credenciais reais nem homologação externa | JSON/CSV/XLSX sem dados de B na resposta de A; nenhuma escrita externa ou local indevida | Não observado |

### Resultado observado do gate PG nesta sessão

`npm run test:pg` foi executado sem `DATABASE_URL`: **65 testes carregados, 0 pass, 2 fail, 63 skipped, exit code 1**. Os 63 testes PG preexistentes foram skipped pela ausência de `DATABASE_URL`; os dois módulos E4.2 falharam intencionalmente no carregamento com mensagens exigindo PostgreSQL real. **Nenhum cenário E4.2 chegou a executar uma asserção HTTP ou PostgreSQL.** Os skips não foram contabilizados como pass.

## Gates executados

| Gate | Resultado observado |
|---|---|
| `npm test` | Exit 0. Servidor: **638 pass, 0 fail, 63 skipped** (701 testes; 51 suites). Cliente: **226 pass** (22 arquivos). Skips mantidos separados dos passes. |
| `npm run test:pg` | Exit 1; **0 pass, 2 fail de pré-condição, 63 skipped** (65 testes carregados). Sem PostgreSQL, sem evidência E4.2. |
| `npm run typecheck` | Exit 0; domain, server e client passaram. |
| Typecheck isolado dos dois arquivos E4.2 | Exit 0 com TypeScript strict; valida compilação, não execução funcional. |
| `npm run lint` | Exit 0; **0 erros, 401 avisos**. |
| `npm run build` | Exit 0; Vite transformou **2102 módulos** e gerou PWA com **55 entradas** de precache. |
| `npm run smoke` | **126/126 verificações** passaram contra Express real em modo demonstração. Usa MemStore; não é evidência E4.2/PostgreSQL. |
| `npm run audit:menu` | Exit 0; sem erros e **6 avisos** classificados (3 RBAC/menu, health pública, 2 recursos sem menu). |
| `npm audit` | Exit 1; **22 vulnerabilidades** (9 moderadas, 8 altas, 5 críticas). Não foram feitas atualizações amplas de dependências neste gate. |
| `git diff --check` | Exit 0; sem erros de whitespace. |

## LIMITAÇÕES

- `DATABASE_URL` não está configurado. Não há `psql`, `pg_isready`, `postgres`, `initdb` ou Docker disponível para criar/consultar um PostgreSQL local.
- Consequentemente, não houve execução real de `npm run test:pg`, do harness HTTP E4.2, de bootstrap em banco vazio, do upgrade pela migration runner, de constraints, de snapshots antes/depois ou de estado de estoque/importação no PostgreSQL. A tentativa de `npm run test:pg` terminou com os números acima; não foi convertida em skip geral nem mascarada.
- O runner `migrate()` aplica `db/schema.sql` antes das migrations versionadas. Assim, o teste complementar `e42-tenant.test.ts`, quando disponível, reprocessa a migration `0030` após o bootstrap do schema; ele não prova a migration 0030 isolada sobre um schema pré-0030. Nesta sessão, nenhum upgrade foi observado.
- O smoke passou apenas no modo de demonstração/MemStore. Não prova constraints, persistência, rollback ou ownership em PostgreSQL.
- Nenhuma credencial WooCommerce/integrador real e nenhuma homologação externa foram usadas. O harness remove essas credenciais e cobre somente as decisões locais que não exigem chamada externa.
- A falha remota de CI conhecida, `Docker pull failed with exit code 1`, ocorreu antes de checkout/testes: **INFRAESTRUTURA — TESTE NÃO EXECUTADO**, não pass nem falha funcional. Deve ser acompanhada separadamente da execução local.
- Permanecem bloqueios globais de release fora do aceite E4.2: regressão P1 de devolução total, `GAP-ESTQ-VENDA-ID` crítico e vulnerabilidades reportadas por `npm audit`. O ciclo de vida `pdv_caixas.local/local_id` permanece P2 separado.

## Decisão

Manter `GAP-ESTQ-MULTIEMPRESA` e este gate **abertos**. A implementação/harness e os gates estáticos são úteis, mas não aprovam E4.2. Fechar somente após a execução, em PostgreSQL real e descartável, da matriz HTTP autenticada, da suíte PG sem skips/falhas relevantes e da validação observada de banco vazio + upgrade. Não fazer merge com base nos resultados desta sessão.
