# Relatório ERP Go-Live 01 — Correções P0

**Data:** 14/10/2026  
**Escopo:** somente P0-01, P0-02 e P0-03  
**Baseline analisada:** `5d43c89dbd6df827309491132b705c7c90565419`  
**Veredito técnico:** **PASS para as correções P0 e gates locais executáveis**. Isso **não é aprovação de Go-Live**: a validação em PostgreSQL real permanece pendente porque este ambiente não fornece `DATABASE_URL` nem ferramentas/servidor PostgreSQL.

## Resumo executivo

| Bloqueador | Resultado | Evidência principal |
|---|---|---|
| **P0-01 — catálogo público cross-tenant** | **PASS** | Tenant derivado do catálogo confiável; consultas de produtos, estoque, clientes e políticas limitadas à empresa; pedidos públicos validam os itens no mesmo escopo. Testes adversariais exercitam catálogo/embed, coleção cruzada, produto de outra empresa, compartilhamento ligado a cliente de outro tenant e política de preço de outro tenant. |
| **P0-02 — ingestão Commerce e matcher sem escopo de empresa** | **PASS em testes locais; confirmação PostgreSQL pendente** | Empresa + responsável percorrem OAuth, conexão, webhook, evento, matcher, venda, painel e recálculo. Chaves de unicidade passam a incluir empresa. Matcher consulta produtos somente no tenant informado; webhook com identidade de loja ambígua falha fechado. Teste de integração PostgreSQL foi incluído, mas não executado por falta de banco. |
| **P0-03 — credencial Correios vulnerável à troca concorrente de contexto** | **PASS** | Removido o contexto mutável global. Cada chamada logística recebe a empresa explicitamente e obtém configuração daquela empresa localmente. Teste paralelo com duas empresas e credenciais sintéticas confirma que cada chamada usa a credencial correspondente, sem rede externa. |

**P1 ALTERADOS: OBRIGATORIAMENTE = NÃO.** Nenhuma alteração de P1/P2/P3, UX-04, Sidebar, Command Palette, CompanySwitcher, layout, design ou módulo novo foi incluída. Não houve homologação de integração externa real.

## Evidência antes/depois

### P0-01 — Catálogo público

- **Antes (baseline):** os filtros públicos de produto consideravam coleção/categoria sem impor `empresa_id`; estoque era lido sem filtro de empresa; política comercial podia ser escolhida entre linhas de todas as empresas. A criação de pedido também procurava cliente por e-mail/nome sem tenant.
- **Depois:** o tenant é obtido de `catalogo.empresa_id`, nunca de parâmetro público. Catálogo público e embed filtram produtos e estoque pela empresa; coleção selecionada é validada contra ela; compartilhamento valida que o cliente pertence ao tenant; políticas são filtradas por `empresa_id`. Pedido público limita cliente, venda e item ao tenant, e rejeita produto/tamanho sem vínculo de estoque daquele produto na mesma empresa. Evento público valida o produto informado antes de gravá-lo.
- **Testes executados:** cinco testes P0-01 cobrem visibilidade de catálogo/embed com SKUs e nomes repetidos entre empresas, filtro por coleção de outro tenant, tentativa de pedir produto de B pelo token de A sem venda parcial, link adulterado para cliente de B e política geral de B não alterando preço em A.

### P0-02 — Conectores, ingestão e matcher

- **Antes (baseline):** conexão e eventos eram identificados por responsável/provedor; venda era única por responsável/canal/pedido; o matcher consultava SKU, código de barras, prefixo e título sem `empresa_id`.
- **Depois:** empresa ativa validada pelo servidor é propagada com o responsável. State OAuth persiste ambos e revalida o vínculo no callback. Conexões, eventos, vendas, painéis e recálculo usam o tenant explícito. As chaves passam a ser `(empresa_id, usuario_id, provider)` para conexão, `(empresa_id, usuario_id, provider, external_event_id)` para evento e `(empresa_id, usuario_id, channel, external_order_id)` para venda. A chave de referência também incorpora empresa e responsável. Todas as buscas de produto do matcher incluem `empresa_id`; SKU/título não servem para inferir tenant.
- Webhook sem sessão resolve a empresa pela conexão persistida. Se a identidade externa da loja corresponder a mais de uma conexão, o sistema não desempata por ordem: ignora/recusa a resolução para não escolher um tenant arbitrariamente.
- **Testes locais executados:** mesmo SKU/nome em A e B casa com o produto da empresa chamada; SKU e título exclusivos de B não casam em A; tenant inválido é recusado; entregas simultâneas/repetidas não duplicam venda/itens; o mesmo pedido externo fica independente entre empresas; evento e conexão são consultados/deduplicados com empresa + usuário; identidade de loja ambígua falha fechado.
- **Teste PostgreSQL adicionado:** `server/test/pg-p0-commerce-tenant.test.ts` cria duas empresas, mesmo responsável e dados externos sintéticos; exercita unicidades concorrentes de conexão/evento/venda, matcher e persistência dos itens. Ele foi **ignorado**, não executado, na ausência de `DATABASE_URL`.

### P0-03 — Isolamento de credenciais logísticas

- **Antes (baseline):** o provedor Correios lia a empresa de uma variável global mutável (`EMPRESA_CONTEXTO`/`empresaCorrente()`), sujeita a troca por requisições simultâneas; o adaptador Melhor Envio também mantinha cache mutável de empresa/configuração.
- **Depois:** `ContextoEnvio` exige `empresaId`; disponibilidade, rastreio e cancelamento também recebem empresa explicitamente. Cotação/geração usam a empresa do contexto. Cada adaptador lê a configuração diretamente para a chamada, sem cache compartilhado nem fallback global. Os handlers derivam empresa da linha autorizada e passam esse valor às operações. A API de configuração devolve somente máscara fixa sem sufixos e não devolve usuário/código administrativos em claro. Mensagens de falha não propagam corpos brutos, exceções de rede ou conteúdo que possa expor credenciais.
- **Testes executados:** a resposta da API não contém usuário, código, senha ou fragmento do segredo; duas cotações Correios em paralelo, com usuários, CEPs e credenciais sintéticas distintos e `fetch` interceptado, mostram que cada chamada usou somente a credencial esperada. Nenhuma chamada alcançou serviço externo.

## Migrações e tratamento de legado

Arquivos adicionados/atualizados:

- `db/migrations/0033_p0_commerce_tenant_scope.sql`
- `prisma/migrations/20261014090000_p0_commerce_tenant_scope/migration.sql`
- `prisma/schema.prisma`
- `db/schema.sql`

A migration adiciona escopo empresarial às conexões, eventos e states OAuth; recria índices de unicidade com tenant; troca a chave de idempotência de vendas e prefixa referências externas; adiciona empresa às políticas comerciais. O backfill usa, conservadoramente, a empresa primária atual do responsável (fallback `1`) para conectores/states; eventos preferem a empresa do conector, depois a do responsável, depois `1`. Política vinculada só é atribuída automaticamente quando catálogo/cliente/coleção apontam para uma única empresa; política geral legada ou relações conflitantes vão para a empresa padrão `1`.

O SQL da migration em `db/`, sua cópia Prisma e `db/schema.sql` passaram por análise sintática com `pglast`. **Isso valida somente parsing SQL; não prova execução, constraints ou backfill em PostgreSQL.** Como o backfill legado usa informação histórica limitada, revisar o mapeamento dos registros legados antes de qualquer rollout real.

## Gates e estado do ambiente

| Comando/verificação | Resultado |
|---|---|
| `npm run audit:menu` | **PASS** — sem erros; 1 aviso não bloqueante já classificado: `/api/health` é pública antes do `requireAuth` global. |
| `npm run typecheck` | **PASS** — domain, server e client. |
| `npm run lint` | **PASS** — exit 0, 0 erros e 409 warnings. |
| `npm test` | **PASS** — server: 778 testes, 712 pass, 0 fail, 66 skipped; client: 28 arquivos e 306 testes pass. Um skip é o novo teste PostgreSQL sem `DATABASE_URL`. |
| `npm run build` | **PASS** — Vite compilou 2.108 módulos. |
| `npm run smoke` | **PASS** — 126/126 verificações. |
| `test:pg` / `smoke:pg` | **NÃO EXECUTADOS** — `DATABASE_URL` ausente; `psql`, `postgres`, `pg_ctl`, `initdb` e `pg_isready` não estão disponíveis. O gate PostgreSQL exige ambiente próprio. |
| `npm run db:validate` | **BLOQUEADO PELO AMBIENTE** — falhou ao baixar o schema engine Prisma por interrupção TLS em `binaries.prisma.sh`; não contar como validação Prisma bem-sucedida. |
| Análise sintática SQL (`pglast`) | **PASS — somente sintaxe**, sem execução PostgreSQL. |

O smoke executou o servidor em modo demonstração, sem banco. As credenciais do teste logístico são sintéticas e o `fetch` é interceptado; nenhuma integração externa real foi homologada.

## Arquivos alterados

**Catálogo e política pública:** `server/src/catalogos.ts`, `server/src/politicasComerciais.ts`, `server/src/resources.ts`, `server/test/p0-catalog-public.test.ts`, `server/test/regras.test.ts`.

**Commerce/conectores:** `modules/connectors/README.md`; `modules/connectors/core/{connector.interface.ts,connector.repository.ts,connector.service.ts,oauth-state.service.ts,panel.service.ts,sale-events.ts,sync.service.ts,types.ts}`; `modules/connectors/ingestion/{catalog-matcher.ts,sale-ingestion.service.ts,sales.service.ts}`; `modules/connectors/instagram/{instagram.connector.service.ts,instagram.connector.ts}`; `modules/connectors/mercadolivre/mercadolivre.connector.ts`; `modules/connectors/mercadopago/mercadopago.connector.ts`; `modules/connectors/nuvemshop/nuvemshop.connector.ts`; `modules/connectors/webhooks/handlers.ts`; `server/src/connectors.ts`; `server/src/negocios.ts`; `server/test/connectors.test.ts`; `server/test/p0-commerce-tenant.test.ts`; `server/test/pg-p0-commerce-tenant.test.ts`; `prisma/schema.prisma` e migrations listadas acima.

**Logística:** `server/src/logistica.ts`, `server/test/logistica.test.ts`.

Nenhum componente ou código de UI foi alterado; somente o fixture de `client/src/pages/LogisticaPage.test.tsx` foi atualizado para a máscara fixa devolvida pela API.

## Limite do veredito

O resultado é **PASS das correções P0 e dos gates executáveis localmente**, não uma homologação de banco ou de operação. O teste PostgreSQL adicionado ainda precisa rodar no job PostgreSQL apropriado; migrations e constraints devem ser exercitadas em PostgreSQL real antes de qualquer decisão operacional. **GO-LIVE NÃO DECLARADO.**