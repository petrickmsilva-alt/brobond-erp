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
| **P1** | **2** | 3 |
| **P2** | **8** | 2 |
| **P3** | **3** | 0 |

**Nenhum gap P0 foi encontrado** no escopo auditado (tenancy, RBAC, conversão
CRM, projeção de vendas, anexos, webhooks). Isso **não é prova de ausência
absoluta** — é o resultado das verificações listadas em §3 e dos gates de §4.

---

## 2. Gaps P1 (abertos)

### GAP-P1-01 — Gates de PostgreSQL não executados neste ambiente (BLOQUEADO)

| Campo | Valor |
|---|---|
| Domínio | Infraestrutura de teste / evidência de release |
| Sintoma | `npm run test:pg`, `npm run smoke:pg` e `npm run db:validate` **não rodaram**: o sandbox não tem servidor PostgreSQL nem acesso a `binaries.prisma.sh` |
| Impacto | As regras provadas "no banco de verdade" (concorrência de saldo, migrações em banco vazio, smoke E2E pós-migração) ficam **sem evidência nova** nesta execução |
| Verificação | `npx prisma validate` → `Error: request to https://binaries.prisma.sh/... failed`; `which psql postgres initdb` → vazio |
| Mitigação nesta execução | `npm run smoke` (Express real, modo demonstração) 327/327; suíte de servidor com 1.106 testes verdes, 68 skips declarados (os skips são, em sua maioria, os casos que exigem PG) |
| Fechamento | Rodar o job `testes-postgres` do CI (`.github/workflows/ci.yml`) ou `npm run test:pg` + `npm run smoke:pg` contra PostgreSQL 16 |
| Severidade | **P1** (evidência, não defeito de código) |

### GAP-P1-02 — Cobertura nominal de isolamento A × B em 22 recursos multiempresa

| Campo | Valor |
|---|---|
| Domínio | Tenancy / testes |
| Sintoma | `npm run architecture:audit` aponta 22 recursos `empresa: true` sem um teste que os cite nominalmente em cenário A × B (ex.: `regras_fiscais`, `documentos_fiscais_eventos`, `inutilizacoes_fiscais`, `centros_custo`, `transferencias_financeiras`, `proposta_itens`, `compra_recebimento_itens`, `planos_comissao`, `venda_atribuicao`, `print_terminals`) |
| Impacto | O isolamento **existe** (declarado em `resources.ts` e aplicado por `empresa.ts`), mas a prova é indireta (testes genéricos de multiempresa) |
| Verificação | `npm run architecture:audit` → avisos `TENANT_SEM_TESTE` |
| Fechamento | Um teste A × B por recurso (ou por família), no molde de `server/test/crm-3-0.test.ts` e `server/test/crm-conversao.test.ts` |
| Severidade | **P1** (consistência de evidência) |

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
| GAP-P2-12 | Tenancy | 22 recursos sem teste de isolamento **nominal** (ver GAP-P1-02) | Evidência indireta | Um teste por família de recurso |

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
