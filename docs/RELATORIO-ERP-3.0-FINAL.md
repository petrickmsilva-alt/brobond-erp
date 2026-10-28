# BROBOND ERP 3.0 — RELATÓRIO FINAL (MASTER FINAL HARDENING + ERP EVOLUTION)

**Data:** 2026-10-27 · **Executor:** agente de execução técnica · **Arquiteto:** ChatGPT
**PR:** [#92](https://github.com/petrickmsilva-alt/brobond-erp/pull/92)

---

## 1. STATUS / COMMIT / BRANCH

| Campo | Valor |
|---|---|
| Branch de execução | `arena/72895db5-brobond-erp` |
| Baseline de comparação | **`main`** (a partir de `f3ed404`) |
| Commits | `5d424d9` db · `ad6ccbd` server · `90831c7` client · `83f37da` gates · `8883770` docs |
| Push | ✅ `origin/arena/72895db5-brobond-erp` |
| PR | ✅ [#92](https://github.com/petrickmsilva-alt/brobond-erp/pull/92) aberto para `main` |
| Árvore de trabalho | ✅ limpa (`git status` vazio) |
| `main` | ❌ não tocada |
| Deploy | ❌ nenhum (proibido pelo escopo) |

**STATUS GERAL:** evolução entregue e verificada por gates executados, com 6 gaps P2
declarados e nenhum P0 aberto. **Não** é "100% completo" — o que falta está no §12.

---

## 2. MODAIS — ZERO MODAL

| Métrica | Valor |
|---|---:|
| Modais/drawers/sheets em **fluxo de módulo** | **0** |
| Assinaturas de sobreposição no código | 9 |
| Exceções declaradas (navegação / ambiente público) | 6 |
| Componentes removidos do kit | `Modal`, `ConfirmDialog`, `Drawer`/`Sheet` |
| Telas migradas para página | 43 |
| Módulos com página própria | 42 (`MODULOS_PAGINA_PROPRIA`) |
| Módulos no CRUD genérico LISTA → PÁGINA | demais módulos `space: 'erp'` |

**Arquitetura imposta:** LISTA → DETALHE → `/recurso/novo` → `/recurso/:id/editar`.
Confirmação crítica **na página** (`ConfirmacaoInline`); painéis de formulário em
`PainelInline`. **Sem** drawer/sheet/overlay substituto e **sem** "modal gigante
disfarçado de página" (as páginas novas são rotas reais, com URL, deep-link e
botão voltar).

**Gate:** `npm run audit:ux` → exit 1 se surgir sobreposição fora das exceções
declaradas. Complemento no nível de teste: `client/src/test/zero-modal.test.ts`.
Inventário: [`docs/ERP-3.0-MODAL-AUDIT.md`](ERP-3.0-MODAL-AUDIT.md).

**Exceções (todas fora do ERP interno):** CommandPalette (Ctrl+K), backdrop do
menu mobile (`Sidebar`/`Layout`), captura invisível de clique em `UsuariosPage`,
`PortalCliente` e `CatalogoPublico` (ambiente do **cliente final**, com lightbox e
carrinho de compra).

---

## 3. ARQUITETURA

| Dimensão | Antes | Agora |
|---|---:|---:|
| Migrations SQL | 50 | **56** |
| Tabelas | 116 | **131** |
| Tabelas com `empresa_id` | 96 | **111** |
| Recursos de API | 101 | **116** (98 multiempresa — 84,5%) |
| Rotas HTTP | 336 | **361** |
| Módulos de navegação | 85 | **101** |
| Modelos Prisma | 11 (5 com `empresaId`) | 11 (5 com `empresaId`) |
| Casos de teste | 2.163 | **2.179 executados** |

- **`architecture:audit` separa as métricas:** `SQL: 111/131 tabelas com
  empresa_id` × `Prisma: 5/11 modelos com empresaId` — nunca somadas. SQL e
  migrations continuam a **fonte da verdade** do schema; Prisma fica no bounded
  context do commerce.
- **Uma camada de tenancy:** `Empresa = tenant`, `Usuário = identidade`. Nenhum
  `organizationId`, nenhuma tabela `empresas` duplicada, nenhum
  `usuarioId`/`responsavel_id` usado como recorte de empresa.
- **`db/schema.sql` espelha 0051..0056** (banco novo nasce com o 3.0) e o teste
  de contrato de colunas continua verde.
- **Nenhuma tabela, coluna ou recurso foi removido.**

---

## 4. CRM 3.0

| Item pedido | Estado | Onde |
|---|---|---|
| Funil/etapas configuráveis (ordem, ativo, probabilidade, empresa_id) | ✅ **corrigido na 0057** | `crm_funis`, `crm_etapas` (0051) **+ `crm_oportunidades.etapa_id`** (0057). Na 0051 o cadastro era configurável mas a **oportunidade** continuava presa ao CHECK de vocabulário da 0049 — ver §14 |
| Histórico de estágio (tabela própria) | ✅ | `crm_oportunidade_estagio_historico` + `GET /api/crm/oportunidades/:id/historico` |
| Origem/canal/campanha/UTM estruturados, **texto livre preservado** | ✅ | `crm_origens`, `crm_campanhas`, `origem_id`, `utm_*` |
| Lembretes (data/hora, responsável, status, prioridade) | ✅ | `crm_atividades` + `/crm/agenda` com hoje/atrasadas/próximas |
| Score de lead explicável (motivo gravado) | ✅ | `score` + `score_motivo` (regras em código) |
| Forecast e painel | ✅ | `GET /api/crm/painel` (conversão por estágio, ponderado) |
| Sem duplicar representante/equipe/território/meta/comissão | ✅ | reaproveita domínios existentes |

Compatibilidade: sem cadastro em `crm_funis`, o vocabulário anterior
(`prospeccao…fechamento`) continua valendo — nenhuma migração de dados foi
imposta aos registros existentes.

> **Retificação (correção final, 0057).** A frase acima, sozinha, dava a
> impressão de que bastava cadastrar `crm_funis`/`crm_etapas` para a etapa ser
> configurável. **Não era verdade**: a oportunidade tinha CHECK de vocabulário
> fixo, então etapa nova era recusada no uso. O que passou a valer de fato:
> `crm_oportunidades.etapa_id` → `crm_etapas.id` (FK composta por empresa) é a
> referência operacional, `etapa` (texto) é a chave mantida para histórico; a
> validação é por cadastro (tenant + funil + ativa), a transição grava
> oportunidade e histórico **na mesma transação** e a conversão de lead usa o
> funil padrão + primeira etapa ativa. Detalhe e provas:
> `docs/ERP-3.0-CRM-FUNIL-CONFIGURAVEL.md`.

---

## 5. ESTOQUE

| Item pedido | Estado | Evidência |
|---|---|---|
| Transferência como **documento** com estados | ✅ | `estoque_transferencias` + itens + eventos (0052): `solicitada→aprovada→em_transito→recebida` / `cancelada` |
| **Sem escrita direta de saldo** | ✅ | saldo só muda por `lancarMovimentacaoDentro` (expedição/recebimento) |
| Reserva / disponível / empenhado / bloqueado / em trânsito | ✅ | `estoque_reservas` (0052) + `GET /api/estoque/disponibilidade` |
| `disponível = físico − reservado − bloqueado − empenhado` | ✅ **calculado** | coluna de disponível **não existe** no banco, de propósito |
| Inventário com contagem/divergência/aprovação/ajuste | ✅ (já existia) | inventário mantido; contagem cíclica automática = P2 (§12) |
| Terceiros (facção) | ⚠️ parcial | `locais.tipo = faccao` e saldo por local; contrato de posse por terceiro = **P3** |

Regras provadas por HTTP: aprovar exige disponível na origem (409 se não houver);
receber antes de expedir → 409; cancelar depois de expedido → 409; cancelar sem
motivo → 400.

---

## 6. COMPRAS

| Item pedido | Estado | Evidência |
|---|---|---|
| Homologação no cadastro do fornecedor | ✅ | colunas em `fornecedores` (0053) — **nenhum cadastro paralelo** |
| Estados PENDENTE→EM_ANALISE→HOMOLOGADO→SUSPENSO→BLOQUEADO | ✅ | máquina de estados em `comprasFornecedor.ts`; transições inválidas → 422 |
| Documentos com tipo/validade/situação/validação | ✅ | `fornecedor_documentos`; vencido é derivado |
| Categoria, responsável, datas, avaliação manual | ✅ | campos na seção **Homologação** do cadastro |
| Motivo obrigatório para suspender/bloquear | ✅ | validado no serviço **e** por `CHECK` |
| Homologar exige categoria + documento válido | ✅ | 422 com pendências listadas |
| Guard: fornecedor suspenso/bloqueado não recebe pedido novo | ✅ | `fornecedorHomologacaoGuard.ts` → 409 no pedido em andamento? **não**: só bloqueia pedido novo |
| Score de fornecedor a partir de dados existentes | ✅ | prazo 40 / atendimento 30 / preço 20 / cancelamento 10, com fatores explicáveis |
| Histórico comercial | ✅ | `GET /api/compras/fornecedores/:id/desempenho` + `GET /api/compras/painel` |

---

## 7. PRODUÇÃO

| Item pedido | Estado | Evidência |
|---|---|---|
| Recursos produtivos (capacidade diária, eficiência) | ✅ | `producao_recursos` (0054) |
| Capacidade × carga × ocupação × gargalo | ✅ | `GET /api/producao/capacidade?de&ate` (dias úteis × capacidade × eficiência) |
| MRP com pedidos, estoque, mínimo, BOM e compras abertas | ✅ | `GET /api/producao/mrp` |
| **Sem pedido de compra automático** | ✅ | rota é somente leitura; `POST` não existe (404) |
| Planejamento / sequenciamento | ⚠️ parcial | planejamento e ocupação existem; **sequenciamento automático e calendário de feriados = P2** |
| Terceiros/facção como recurso externo | ⚠️ parcial | tipo de recurso permite externo; custo de facção por OP = P3 |

---

## 8. FISCAL

| Item pedido | Estado | Evidência |
|---|---|---|
| Auditoria do que existia antes | ✅ | `regras_fiscais`, `impostos_ncm`, `documentos_fiscais`, inutilizações mantidos |
| Estrutura de obrigações acessórias | ✅ | `fiscal_obrigacoes` (0055) com periodicidade e dia de vencimento |
| Calendário com vencimento calculado | ✅ | `GET /api/fiscal/calendario?de&ate` (dia no mês seguinte, com clamp: 31/01 → 28/02) |
| Status derivado (pendente/atrasada/entregue/dispensada) | ✅ | derivado do vencimento; **nunca gravado como atrasada** |
| Protocolo, arquivo, validação, responsável | ✅ | `fiscal_obrigacao_entregas`; `entregue` sem protocolo → 400; `dispensada` sem motivo → 400 |
| **Nenhuma alíquota inventada / nenhuma regra hard-coded** | ✅ | motor tributário continua em `regras_fiscais`/`impostos_ncm` (cadastro) |
| SPED/EFD com layout oficial | ❌ **P2** | fora do escopo desta rodada — arquivo sem layout validado é pior que ausente |

Upsert por (obrigação, competência) provado por HTTP: reenviar a mesma
competência mantém **uma** linha.

---

## 9. CAMPOS / MASTER DATA / FINANCEIRO

- **Master data auditada por domínio:** chave de negócio, obrigatórios,
  unicidade, ciclo de vida (ativo/inativo) e campos derivados —
  [`docs/ERP-3.0-MASTER-DATA-AUDIT.md`](ERP-3.0-MASTER-DATA-AUDIT.md).
- **Catálogos globais × por empresa são explícitos:** `cores`, `categorias`,
  `tamanhos`, `grades` são globais; o resto carrega `empresa_id`.
- **Financeiro NÃO virou contabilidade completa:** plano de contas, centro de
  custo, natureza, documento de origem, débito/crédito, competência e período
  existem como **estrutura**; o balancete soma o **mesmo** livro-caixa e lista
  `sem_classificacao`. Nenhuma partida dobrada gerada por código.
- **Campos derivados nunca são gravados:** custo, disponibilidade, ocupação,
  score (lead e fornecedor), vencimento fiscal, atraso.
- **Qualidade:** documento PF/PJ com validação, `indicador_ie` fechado, enums com
  `CHECK` no banco, `competencia` com regex.

---

## 10. SEGURANÇA

| Verificação | Resultado |
|---|---|
| `checkAccess` por operação (`read/create/update/delete`) em toda rota nova | ✅ |
| Homologação restrita a gerente/admin; sair de BLOQUEADO só admin | ✅ (403 provado por HTTP) |
| `exigirGestor` em aprovar/expedir/receber/cancelar transferência | ✅ |
| Tenant carimbado pelo servidor (`empresa_id` do ator), corpo ignorado | ✅ |
| Isolamento A × B nominal nos 12 fluxos novos | ✅ `server/test/tenant-isolamento-3-0.test.ts` |
| UI bloqueada = API bloqueada | ✅ (nenhuma regra só no cliente) |
| Rotas públicas | inalteradas (health, auth, portal, catálogo, arquivos por token) |
| Segredos / produção | intocados |

`architecture:audit`: `TENANT_SEM_TESTE` = 0.

---

## 11. TESTES (executados)

| Gate | Comando | Resultado |
|---|---|---|
| Typecheck | `npm run typecheck` | ✅ 0 erros |
| Lint | `npm run lint` | ✅ 0 erros (552 avisos pré-existentes) |
| Server | `npm --workspace server test` | ✅ **1330 pass / 0 fail / 68 skip** |
| Client | `npm --workspace client run test` | ✅ **849 pass / 0 fail** (74 arquivos) |
| Build | `npm run build` | ✅ |
| Menu | `npm run audit:menu` | ✅ 0 erros |
| UX (novo) | `npm run audit:ux` | ✅ 0 modais em fluxo de módulo |
| Arquitetura | `npm run architecture:audit` | ✅ 0 erros / 10 avisos (`TABELA_SEM_RECURSO`, esperados) |
| Smoke HTTP | `npm run smoke` | ✅ **386/386** (50 do ERP 3.0 + 9 da correção 0057) |
| `test:pg` | — | ⛔ **BLOQUEADO** (sem PostgreSQL/`psql` neste sandbox) |
| `smoke:pg` | — | ⛔ **BLOQUEADO** (idem) |
| `db:validate` | — | ⛔ **BLOQUEADO** (`prisma validate` baixa `schema-engine` fora da allowlist) |

Os **68 skips** são os testes PostgreSQL que se auto-pulam sem `psql` — **não**
foram convertidos de falha em skip nesta rodada. Nenhum teste foi mascarado,
relaxado ou removido para "fechar verde"; o único ajuste de expectativa
(`fornecedores-cadastro.test.ts` e `smoke-e2e.mjs`) reflete colunas que a
migration 0053 **realmente** acrescentou.

---

## 12. GAPS (P0–P3)

| Nível | Abertos | Itens |
|---|---:|---|
| **P0** | **0** | — |
| **P1** | **0** | — |
| **P2** | **6** | SPED/EFD com layout oficial · importação de plano de contas · notificação ativa de lembretes · sequenciamento/calendário produtivo · contagem cíclica automatizada · evidência PostgreSQL bloqueada no sandbox |
| **P3** | **3** | catálogo de unidades de insumo · contrato de estoque de terceiros · lightbox/carrinho do catálogo público |

Detalhamento (por que não foi feito, dependência e risco) em
[`docs/ERP-3.0-GAP-MATRIX.md`](ERP-3.0-GAP-MATRIX.md) §8.

---

## 13. PRODUÇÃO E RECOMENDAÇÃO

**Pronto para produção?** O que foi entregue está com integridade preservada,
tenancy mantida e zero regressão. O que impede uma declaração de "pronto sem
ressalvas" é **evidência de ambiente**, não código:

1. `test:pg`, `smoke:pg` e `db:validate` **não rodaram aqui** (sem PostgreSQL e
   sem `psql`; `prisma validate` baixa binário fora da allowlist). O job
   `testes-postgres` do CI cobre os três.
2. O smoke subiu de 327 para 377 verificações: as 50 novas foram provadas no
   **modo demonstração**; o próximo run de CI contra PostgreSQL real precisa
   confirmar as mesmas 377.
3. Gaps P2/P3 do §12 permanecem — nenhum bloqueia operação, todos com caminho de
   fechamento definido.

**RECOMENDAÇÃO: MERGE APÓS CI VERDE** (com as ressalvas acima registradas no PR).

Motivos: zero regressão (1330 + 849 + 377 verdes), zero modal em fluxo de módulo
com gate que falha o CI, nenhuma duplicidade real criada, nenhuma tabela removida,
tenancy e RBAC revalidados, e escopo proibido (`organizationId`, unificar
`sales`/`vendas`, segundo financeiro, alíquota inventada, deploy automático)
**não violado**.

---

## 14. CORREÇÃO FINAL DO PR #92 (migration 0057)

Depois da entrega acima, o arquiteto apontou **três defeitos**. Todos foram
corrigidos nesta rodada. Nenhum foi escondido atrás de "já estava funcionando".

### 14.1 CRM — etapa realmente configurável (🔴 era o mais grave)

| Antes | Depois |
|---|---|
| `etapa` TEXT + CHECK de 5 valores (0049) | `etapa_id` INTEGER → `crm_etapas.id`, FK composta `(empresa_id, etapa_id)`, `ON DELETE RESTRICT` |
| `ETAPAS_CRM` decidia o que era válido | cadastro da empresa decide (tenant + funil + ativo) |
| etapa nova: cadastrava e **não usava** | etapa nova: cadastra e usa (`Demonstração`, `Aprovação Jurídica`) |
| transição parcial | valida + atualiza + histórico em **uma** transação, com rollback provado |
| probabilidade fixa | `crm_etapas.probabilidade` (fallback só legado) |
| UI com lista fixa | `/api/meta` com `optionsFrom` por empresa + `refreshMeta()` |

Bugs reais encontrados **durante** a correção (não estavam no relatório do
arquiteto, apareceram ao testar de verdade):

1. `mudarEstagioOportunidade` devolvia o objeto da transação, mas `wrap()` do
   Express **descarta o retorno** — a rota não respondia. Agora usa `res.json()`.
2. `probabilidade` tem default `0` no schema: "não informado" ficava
   indistinguível de "0 informado" e a probabilidade da etapa nunca era
   aplicada. Corrigido lendo o corpo cru (`probabilidadeFoiInformada`).
3. `crm_leads.probabilidade` também tem default `0`: a conversão aplicava 0 em
   vez da probabilidade da etapa. Corrigido com `> 0` no fallback.
4. O modo demonstração não tinha `crm_funis`/`crm_etapas` semeados — toda
   resolução caía em 404/422 nos testes. Semente adicionada em `resources.ts`.

Dois testes antigos **afirmavam o comportamento antigo** e foram reescritos de
propósito (não pulados): `crm-3-0-evolucao.test.ts` ("etapa inválida" agora é
422 com a lista do funil, não 400 de vocabulário) e `crm-conversao.test.ts`
(conversão entra na **primeira etapa ativa** do funil padrão, não em
`qualificacao` fixo).

Evidência: `server/test/crm-funil-configuravel.test.ts` — **11 blocos / 12 casos**
exigidos, incluindo cross-tenant (404), etapa de outro funil (422), inativa
(422), histórico em transição, rollback por falha do histórico, conversão
idempotente, etapa 65% → 65% e forecast ponderado pela etapa cadastrada.

### 14.2 MRP — delimitação e anti-dupla-contagem (🟠)

* a resposta declara `calculo.tipo = 'mrp_planejamento_necessidade'`,
  `coberto[]`, `nao_coberto[]` (10 itens) e `cria_pedido_de_compra: false`;
* oferta de produto passou a usar **disponível** (físico − reservado −
  empenhado − bloqueado) — antes reserva/empenho eram ignorados;
* estoque mínimo entra **só como déficit** (antes somava o mínimo inteiro em
  cima da demanda de venda: dupla contagem real);
* OP aberta por (planejado − produzido) e compra aberta por (pedido − recebido)
  já estavam corretos e agora têm teste próprio;
* **nenhum pedido de compra é criado** (verificado por contagem invariante).

Evidência: `server/test/producao-capacidade-mrp.test.ts` — 14 testes (6 novos:
reserva não é oferta, OP pelo que falta, mínimo como déficit, compra parcial,
declaração de escopo + não-cria-compra, isolamento por empresa).

### 14.3 UX — gate ZERO MODAL objetivo (🟡)

* baseline versionado `docs/ERP-3.0-UX-BASELINE.json` (categoria + motivo +
  contagem por assinatura + total), com validação do próprio baseline;
* falha em **baseline + qualquer ocorrência nova** (arquivo novo, contagem por
  arquivo ou total acima do declarado);
* 10 assinaturas: `role="dialog"`, `role="alertdialog"`, `aria-modal="true"`,
  `fixed inset-0` (3 variações), `<dialog>`, `showModal()`, componentes de
  sobreposição e `createPortal`;
* exports proibidos ampliados (`AlertDialog`, `ModalRoot`, `DialogContent`,
  `Overlay`, `Backdrop`…);
* exceção **nunca** para cadastro/edição/exclusão/detalhe/seleção/formulário/
  workflow — o gate recusa categoria inexistente e caminho de formulário;
* comentário/texto citando modal **não** é violação (comentários são removidos).

Evidência: `client/src/test/zero-modal-baseline.test.ts` — 9 casos com fixtures
temporárias.

### 14.4 Estado dos gates nesta rodada

| Gate | Resultado |
|---|---|
| `npm run typecheck` (server + client) | **EXIT 0** |
| `npm run test` server | **1.347 pass / 0 fail / 68 skip** (1.415 casos, 55 suítes) |
| `npm run test` client | **858 pass / 0 fail / 75 arquivos** |
| `npm run lint` | **EXIT 0** (0 erros, 554 avisos) |
| `npm run build` | **EXIT 0** |
| `npm run audit:menu` | **PASS** |
| `npm run architecture:audit` | **PASS** — 57 migrations, 131 tabelas, 408 índices, 219 constraints, 361 rotas, 2.252 casos em 235 arquivos |
| `npm run audit:ux` | **PASS** — 0 sobreposição nova; 6 exceções no baseline |
| `npm run test:pg` / `smoke:pg` / `db:validate` | **BLOQUEADOS neste sandbox** (sem PostgreSQL/`psql`/download do `schema-engine`) — cobertos pelo CI |
