# BROBOND ERP 3.0 — MATRIZ DE GAPS

**Gerado em:** 2026-10-27 · **Branch:** `arena/bfa4a15b-brobond-erp`
**Baseline real:** [`docs/ERP-3.0-ARCHITECTURE-BASELINE.md`](ERP-3.0-ARCHITECTURE-BASELINE.md) + [`docs/ERP-3.0-ARCHITECTURE-INVENTORY.json`](ERP-3.0-ARCHITECTURE-INVENTORY.json)
**Como regenerar os números:** `npm run architecture:audit`

## Classificação

| Nível | Significado |
|---|---|
| **P0** | Segurança, integridade de dados ou bloqueador de operação. Impede homologação. |
| **P1** | Necessário para o ERP 3.0 ficar consistente (ou evidência obrigatória ausente). |
| **P2** | Evolução planejada — não bloqueia a operação atual. |
| **P3** | Desejável / produto futuro. |

> **Regra de honestidade.** Gap não é "o que seria bom ter"; é o que **foi
> verificado** como ausente, com o caminho de verificação indicado. Onde a
> evidência não pôde ser executada neste ambiente, o item aparece como
> **BLOQUEADO** — nunca como "aprovado".

---

## 1. Resumo

| Nível | Abertos | Fechados nesta execução |
|---|---:|---:|
| **P0** | **0** | 0 |
| **P1** | **0** | 3 |
| **P2** | **9** | 3 |
| **P3** | **3** | 0 |

**Nenhum gap P0 foi encontrado** no escopo auditado (tenancy, RBAC, conversão
CRM, projeção de vendas, anexos, webhooks). Isso **não é prova de ausência
absoluta** — é o resultado das verificações listadas em §3 e dos gates de §4.

---

## 2. Gaps P1 — fechados nesta execução

> Esta rodada fechou os dois P1 que estavam abertos e **encontrou e fechou um
> terceiro**, revelado pelo próprio gate (o P1-06, defeito intermitente de
> concorrência na ingestão). O que segue é a evidência **executada**, com os
> comandos e os números reais — inclusive a única verificação que permanece
> impossível neste sandbox.

### GAP-P1-01 — Evidência de PostgreSQL real · **FECHADO**

| Campo | Valor |
|---|---|
| Domínio | Infraestrutura de teste / evidência de release |
| Sintoma (antes) | `test:pg`, `smoke:pg` e `db:validate` não rodavam no ambiente de trabalho: sem servidor PostgreSQL e sem acesso a `binaries.prisma.sh` |
| Como foi fechado | PostgreSQL **16.14 real** (binários `embedded-postgres` 16.14.0-beta.17) subiu em `127.0.0.1:5433`; banco **novo e vazio** por rodada; a suíte inteira do job `testes-postgres` foi executada |
| Evidência local — `npm run test:pg` | **293 testes · 280 pass · 12 skip · 1 fail** (detalhe abaixo) |
| Evidência local — `npm run smoke:pg` | **327/327 PASS** contra PostgreSQL real em banco criado do zero (migrate + `ensureAdmin` automáticos, zero SQL manual) |
| Evidência local — `npm run db:validate` | **BLOQUEADO**: `prisma validate` baixa `schema-engine` de `binaries.prisma.sh` (fora da allowlist de rede do sandbox). O CI executa `npx prisma validate` como passo do job `verificar` |
| Evidência de CI | runs **40578401850** (`f3bf3f8`) e **40569720909** (`ab6e254`): job `testes-postgres` ✓ (PG 16.14 oficial + `psql`; passos `test:pg` e `smoke:pg` verdes) e job `verificar` ✓ (inclui `npx prisma validate`). O run **40579160432** foi vermelho por um defeito real de concorrência — ver `GAP-P1-06` |
| Falha local remanescente (não mascarada) | `PROD-DB-01.5.3 — o executor recusa cópia defasada do script 005` (`server/test/pg/prod-db-01-521-gate-classe-c.test.ts`): `spawnSync(psql …)` → `exec: psql: not found`, exit 127. O pacote de binários disponível aqui traz `initdb`/`pg_ctl`/`postgres` e **não** traz o cliente `psql`; os 12 `# SKIP` da rodada têm a mesma causa (`binário psql indisponível; no CI ele é instalado (postgresql-client-16)`). No CI, com `postgresql-client-16` instalado, o mesmo teste passa — é o que o job verde de `ab6e254` mostra |
| O que **não** foi feito | Não relaxei a asserção de versão (`server_version_num = 160014`), não converti o teste em skip e não substituí nada por mock para "fechar verde" |
| Severidade residual | **Nenhuma de código.** Dívida de ambiente: o sandbox não tem cliente `psql` |

### GAP-P1-02 — Isolamento A × B nominal em 22 recursos · **FECHADO**

| Campo | Valor |
|---|---|
| Domínio | Tenancy / testes |
| Sintoma (antes) | `npm run architecture:audit` listava **22** recursos `empresa: true` sem teste que os citasse nominalmente (regra `TENANT_SEM_TESTE`) |
| Como foi fechado | Um caso nominal por recurso, em duas camadas: serviço (`server/test/multiempresa-nominal.test.ts`, 155 casos) e HTTP real sobre PostgreSQL (`server/test/pg/multiempresa-nominal-http.test.ts`, 15 casos) cobrindo os **11** recursos do gap que têm rota pública — 10 com CRUD e `inutilizacoes_fiscais` somente leitura |
| Recursos cobertos (22) | `fornecedor_contatos`, `produto_composicao`, `regras_fiscais`, `documentos_fiscais_eventos`, `inutilizacoes_fiscais`, `importacoes_nfe`, `categorias_financeiras`, `investidores`, `aportes`, `recorrencias_financeiras`, `centros_custo`, `transferencias_financeiras`, `listas_preco_historico`, `proposta_itens`, `proposta_eventos`, `compra_recebimento_itens`, `print_pairing_codes`, `print_agent_nonces`, `print_terminals`, `planos_comissao`, `regras_comissao`, `venda_atribuicao` |
| O que cada caso prova | A cria/lê/lista/edita/(exclui) o próprio registro **e** o registro é dela no banco; B **não lê** (404), **não lista** (`total = 0`), **não edita** (404 + registro idêntico) e **não exclui** (404 + registro intacto). Depois disso A ainda edita e exclui — ou seja, o bloqueio de B vem do **recorte de empresa**, não de o registro ser imutável. Na camada HTTP, as fixtures da A (fornecedor, cliente, conta, representante, venda) também são inacessíveis para B, e a trilha de auditoria da A não aparece para B (403 por RBAC ou lista vazia) |
| Semântica preservada | 404 (não 403) para registro de outra empresa — o ERP não confirma existência de dado alheio. Recursos `internal`/append-only continuam sem rota pública (`GET /api/print_terminals` → 404) e continuam recusando escrita pelo próprio contrato |
| Evidência do audit | `TENANT_SEM_TESTE`: **22 → 0**. Avisos totais do `architecture:audit`: **32 → 10** (nenhum deles de tenancy) |
| Falhas de produto encontradas | **Nenhuma de isolamento.** O que os testes acharam foram divergências de **contrato de payload** entre modo memória e PostgreSQL — `planos_comissao` exige `vigencia_inicio`/`padrao` (o `INSERT` do `pgstore` envia a coluna explicitamente; o modo memória preenche o default) e `NUMERIC` volta como `"7.0000"` —, tratadas no próprio teste, sem tocar em código de produção |
| Severidade residual | **Nenhuma.** `GAP-P2-12` (duplicata deste item) também é baixado |

### GAP-P1-06 — Reentrega simultânea do mesmo pedido derrubava a ingestão · **FECHADO**

| Campo | Valor |
|---|---|
| Domínio | Commerce / ingestão de marketplace (webhook "at-least-once") |
| Como apareceu | O gate de PostgreSQL ficou vermelho no CI **da rodada anterior** (`40579160432`, commit só de documentação): `not ok — P0-02 … duplicate key value violates unique constraint "sales_empresa_usuario_channel_external_order_id_key"` (`23505`) |
| Causa | `upsertIngestedSale` arbitra o `ON CONFLICT` por `reference`, mas o PostgreSQL verifica os índices únicos na **ordem de criação** da tabela: duas entregas do mesmo pedido ao mesmo tempo podem estourar o índice composto antes de chegar ao árbitro. Em concorrência maior aparece também `40P01` (deadlock entre inserções especulativas das mesmas chaves) |
| Reprodução | Probe com transação real: 200 rodadas × 8 entregas simultâneas → **6–7 falhas**, todas com o pedido já gravado pela entrega vencedora |
| Correção | `runInTransactionComCorrida` em `modules/connectors/ingestion/sales.service.ts`: retentativa CURTA (até 3 tentativas, espera crescente de 5 ms) apenas quando o erro é a corrida conhecida — `23505` nos três índices de idempotência de `sales`, `40001` ou `40P01`. Nenhum dos três grava nada, então repetir é seguro; fora desse conjunto o erro sobe intacto |
| Prova | Probe: **0 falhas em 200 rodadas** (era 6–7). Teste de regressão novo `server/test/pg/commerce-reentrega-concorrente.test.ts` (40 rodadas × 8 entregas): **falha sem a correção** e passa com ela; `pg-p0-commerce-tenant`, `pg-golive03-marketplace-venda` e `bi-faturamento-e2e` seguem verdes |
| O que **não** mudou | Nenhum DDL, nenhum índice, nenhum contrato público: a chave de idempotência e a semântica do upsert continuam as mesmas. A retentativa não esconde erro de negócio |
| Severidade residual | Nenhuma. Era um defeito intermitente de produção (webhook reentregue podia receber 500), agora reproduzível e protegido por teste |

---

## 3. Auditoria por domínio (o que foi verificado)

| Domínio | O que foi verificado | Resultado |
|---|---|---|
| **Tenancy** | `empresa_id` em 96/116 tabelas; 83/101 recursos com escopo; ausência de query sem recorte nos fluxos auditados; BI com validação de concessão; anexos herdam tenant do pai; webhooks resolvem empresa pelo conector | **SEM P0.** 20 tabelas sem `empresa_id` justificadas (catálogo global, escopo derivado, infraestrutura) |
| **Prisma × SQL** | 11 modelos × tabelas reais; nenhuma tabela exclusiva do Prisma; dual-track documentado | **CORRIGIDO** — comentários "single-company" removidos (GAP-P2-07 fechado) |
| **CRM 3.0** | 4 recursos com tenant/RBAC/CHECK; motivo de perda obrigatório; conversão transacional | **CONSOLIDADO** — conversão + regras de funil implementadas e testadas |
| **Comercial / representantes / territórios / metas / comissões** | `representantes`, `equipes_comerciais`, `representante_hierarquia`, `territorios`, `representante_territorio`, `representante_cliente`, `metas`, `regras_comissao`, `planos_comissao`, `comissoes_apuradas`, `comissoes_eventos`, `venda_atribuicao` | **SEM DUPLICIDADE** — CRM não criou `crm_representantes`/`crm_metas`/etc. |
| **Vendas × `sales`** | Projeção `INSERT … ON CONFLICT`, cancelamento, remoção de órfãos, exclusão de venda de marketplace (`pedido_externo_id`), margem na mesma transação | **IDEMPOTENTE** — sem segunda fonte de verdade |
| **Estoque** | `movimentacoes` (evento) × `estoques` (saldo); unicidade de célula por empresa/local; inventário com snapshot; transferência só por movimentação | **SEM P0.** Transferência sem documento próprio = P2 |
| **Compras** | cotação → compra → recebimento → estoque → financeiro; custo canônico (média ponderada); de-para de fornecedor; contas a pagar | **SEM P0.** Homologação de fornecedor = P2 |
| **Produção** | OP → apontamento → conclusão → entrada de estoque; estorno/reabertura com histórico preservado; idempotência | **SEM P0.** MRP/capacidade/sequenciamento = P2 |
| **Financeiro** | lançamentos/parcelas/baixas, contas, transferências, gateway idempotente, extrato/conciliação, CNAB, comissões | **SEM P0.** BI/dashboards não são fonte de verdade |
| **Fiscal** | regras fiscais por empresa, NCM, documentos, inutilização, eventos, provider extensível | **SEM P0.** SPED/obrigações acessórias ausentes = P2 |
| **RBAC** | cadeia UI → rota → recurso → serviço; 27 recursos restritos; paridade menu × API; `politicas_comerciais`, `listas_preco`, `envios` revalidados; operador não exclui | **SEM P0** — `audit:menu` sem erros |
| **Auditoria** | entradas com `empresa_id` obrigatório; cadeia de hashes; auditoria dentro da transação do fato | **SEM P0** |
| **Performance** | índices das consultas quentes do CRM; projeção de vendas em lote; listagens paginadas no servidor | **ÍNDICES ADICIONADOS** (0050). Nenhum N+1 evidente nos fluxos auditados |

---

## 4. Fechados nesta execução

| ID | Item | Evidência |
|---|---|---|
| **GAP-P1-06** | Reentrega simultânea do mesmo pedido retornava `23505`/`40P01` na ingestão | `runInTransactionComCorrida` + `server/test/pg/commerce-reentrega-concorrente.test.ts` (falha sem a correção, passa com ela) |
| **GAP-P1-01** | Gates de PostgreSQL sem execução real | PG 16.14 real: `smoke:pg` 327/327; `test:pg` 277 pass (1 falha só por `psql` ausente no sandbox); CI run **40578401850** em `f3bf3f8` verde nos dois jobs (`testes-postgres` e `verificar`, este com `npx prisma validate`) |
| **GAP-P1-02** | 22 recursos multiempresa sem prova nominal de isolamento | `server/test/multiempresa-nominal.test.ts` (155) + `server/test/pg/multiempresa-nominal-http.test.ts` (13); `TENANT_SEM_TESTE` 22 → 0 |
| **GAP-P1-03** | Funil sem elo Lead → Oportunidade (não havia endpoint nem ação de tela) | `server/src/crm.ts` + rota + ação na lista + 10 testes de servidor + 6 de tela + 10 verificações HTTP |
| **GAP-P1-04** | Estágio/status do funil sem coerência (fechada mudava de etapa; motivo de perda órfão; data de fechamento não derivada) | `normalizarOportunidadeCrm` em `services.ts` + testes |
| **GAP-P1-05** | Inventário arquitetural inexistente como comando (números digitados à mão em docs) | `npm run architecture:audit` + JSON + gate de CI |
| **GAP-P2-01** | Consultas quentes do CRM sem índice (`origem` do lead; `lead_id` + empresa na conversão) | `db/migrations/0050_crm_funil_indices.sql` |
| **GAP-P2-07** | Prisma documentava ERP "single-company" e tenancy por usuário | Cabeçalho de `prisma/schema.prisma` reescrito com o boundary SQL × Prisma |

---

## 5. Gaps P2 (abertos)

| ID | Domínio | Gap | Impacto hoje | Fechamento sugerido |
|---|---|---|---|---|
| GAP-P2-02 | CRM | Estágios do funil **hard-coded** (5 etapas fixas) | Empresas não configuram o próprio pipeline | Tabela `crm_estagios` por empresa + FK em `crm_oportunidades.etapa`, mantendo o vocabulário atual como seed |
| GAP-P2-03 | CRM | Histórico de estágio só na auditoria (sem tabela de eventos da oportunidade) | Relatório de conversão por estágio exige ler auditoria (JSONB) | Tabela `crm_oportunidade_eventos` (de/para estágio, autor, quando) |
| GAP-P2-04 | CRM | Integridade cross-tenant no **banco** para `crm_*` é só por FK simples | API garante (404); SQL manual poderia cruzar empresas | Índices `UNIQUE (empresa_id, id)` + FKs compostas, no padrão E4.2 (`uq_e42_*`) |
| GAP-P2-05 | CRM | Origem do lead é texto com vocabulário fechado no formulário | Sem campanha/UTM rastreável | Catálogo `crm_origens` (ou campos `campanha_id`/`utm_*`) — hoje indexada e validada |
| GAP-P2-06 | CRM | Sem lembrete/notificação de atividade vencida | Follow-up depende de consulta manual | Job em `scheduled.ts` + notificação existente |
| GAP-P2-08 | Estoque | Transferência entre locais não tem **documento** próprio (só movimentações par espelhado) | Sem rastreio de solicitação/aprovação da transferência | Documento `transferencias_estoque` + itens + eventos |
| GAP-P2-09 | Compras | Sem homologação/cotação formal de fornecedor (qualificação cadastral) | Compra direta com fornecedor não homologado | Fluxo de homologação (documentos, aprovação, validade) |
| GAP-P2-10 | Produção | Sem MRP, capacidade ou sequenciamento | Planejamento manual | MRP a partir de demanda + ficha técnica |
| GAP-P2-11 | Fiscal | SPED/obrigações acessórias não implementados | Escrituração é feita fora do ERP | Exportações SPED (ICMS/IPI, contribuições), EFD-Reinf |

---

## 6. Gaps P3

| ID | Domínio | Gap |
|---|---|---|
| GAP-P3-01 | CRM | Lead scoring / previsão de fechamento (hoje probabilidade manual) |
| GAP-P3-02 | CRM | Painel de conversão por estágio (depende de GAP-P2-03) |
| GAP-P3-03 | Commerce/Creators | 8 módulos `planned` (produtos/pedidos/trends/delivery, creators, matches, outreach, campanhas) |

---

## 7. O que **não** foi feito (e por quê)

| Tentação | Decisão | Motivo |
|---|---|---|
| Criar `crm_equipes`, `crm_metas`, `crm_comissoes` | **Não** | Duplicaria domínios oficiais já existentes (`equipes_comerciais`, `metas`, `planos_comissao`) |
| Modelos Prisma para CRM/estoque/financeiro | **Não** | Prisma é bounded context do commerce; o ERP é SQL-first |
| Parametrizar o funil nesta entrega | **Não** | Aumentaria risco sem fechar P0/P1; registrado como P2 |
| Otimizações especulativas (cache, GIN/trgm) | **Não** | Sem evidência de plano ruim; índices só nas consultas quentes reais |
| Unificar `vendas` e `sales` | **Não** | Arquitetura é operacional + read model; unificar criaria segunda fonte de verdade |
| Declarar "compliance fiscal completo" | **Não** | NF-e/NFC-e existem; SPED e obrigações acessórias **não** — registrado como P2 |
