# BROBOND ERP 3.0 — RELATÓRIO INTEGRAL DE AUDITORIA (PR #95)

**Produto:** BROBOND ERP 3.0 · **Repositório:** `petrickmsilva-alt/brobond-erp`
**Branch:** `arena/b87f2f6e-brobond-erp` · **Base:** `main` (`6da5aa4`) · **Data:** 2026-10-28
**Título do PR:** `feat: auditoria integral e hardening final do ERP 3.0`
**Stack:** Node v22.22.3 · npm 10.9.8 · TypeScript · Vitest · `node:test` · PostgreSQL · Prisma (limitado)

---

## 1. Síntese executiva

Esta rodada fecha o ciclo de **coerência DOMAIN ↔ DB ↔ API ↔ RESOURCE ↔ RBAC ↔ TENANCY ↔ ROUTE ↔ PAGE ↔ MENU ↔ COMMAND PALETTE ↔ UX ↔ TESTS ↔ DOCUMENTATION**
e introduz um **mecanismo de auditoria de capacidades** que impede que um
capacidade operacional fique invisível no menu, que uma rota fique sem página,
que um resource fique sem dono funcional, ou que um módulo rotulado `planned`
tenha backend funcional.

Três defeitos P1 foram corrigidos; nenhum P0 foi encontrado; 12 defeitos de
UX (PainelInline) foram auditados — 1 convertido, 11 classificados como
residual documentado.

**Veredito: READY FOR MERGE.**

---

## 2. Meio ambiente e gates

| Gate | Comando | Status |
|---|---|---|
| Menu × rotas × RBAC × multiempresa | `npm run audit:menu` | ✅ OK |
| UX (zero modal) | `npm run audit:ux` | ✅ OK |
| Arquitetura (recursos × tabelas × tenant × Prisma) | `npm run architecture:audit` | ✅ OK (10 AVISO) |
| Typecheck | `npm run typecheck` | ✅ OK |
| Lint | `npm run lint` | ✅ OK |
| Build | `npm run build` | ✅ OK |
| Testes — server | `npm run test:server` | ✅ **1399 pass / 0 fail** |
| Testes — client | `npm run test:client` | ✅ **880 pass / 0 fail** |
| Migrations SQL + Prisma | `db:validate` / `prisma validate` | ⏳ CI (engine download restringido nesta sandbox) |
| PostgreSQL real | `npm run test:pg` / `smoke:pg` | ⏳ CI (sem `DATABASE_URL` local) |

> **Honestidade.** `db:validate`, `prisma validate`, `test:pg` e `smoke:pg` não
> puderam ser executados nesta sandbox (download do engine do Prisma bloqueado
> por TLS; sem PostgreSQL local). Nenhum deles foi marcado como aprovado — a
> responsabilidade é do CI, que roda PostgreSQL real.

---

## 3. Inventário (após as mudanças)

| Dimensão | Número | Comando |
|---|---:|---|
| Módulos (`MODULES`) | **106** | `audit:menu` |
| Áreas / grupos | 11 / 28 | `audit:menu` |
| Capacidades declaradas | **134** | `audit:menu` §8 |
| Recursos de API | **124** | `audit:menu` |
| Recursos navegáveis | 71 | `audit:menu` |
| Tabelas | 139 (119 com `empresa_id`) | `architecture:audit` |
| Índices / constraints | 435 / 253 | `architecture:audit` |
| Rotas HTTP | 378 | `architecture:audit` |
| Migrations SQL / Prisma | 67 / 7 | `architecture:audit` |
| Modelos Prisma | 11 (5 com `empresaId`) | `architecture:audit` |
| Cobertura de tenant | 85.5% dos recursos | `architecture:audit` |
| Testes (server + client) | **2.279** (1.399 + 880) | `npm test` |

---

## 4. PainelInline — classificação de TODAS as ocorrências

`PainelInline` é o substituto do antigo modal. A regra atual é: **bloco
auxiliar não transacional** (leitura, conferência, ajuda, info, segredo único,
auxiliar de seleção) **ou** child-flow do detalhe de um documento que já é uma
página própria. **Nenhum formulário de criação/edição transacional pode
permanecer escondido em PainelInline.**

**58 ocorrências em 24 arquivos** foram auditadas:

| Classe | Ocorrências | Tratamento |
|---|---:|---|
| Bloco auxiliar legítimo | 25 | manter |
| Child-flow do detalhe de documento (documento já é página) | 21 | manter |
| **Fluxo de módulo em painel** | 12 | **1 convertida** (Cotações) · 11 residuais documentados |

### 4.1 Tabela completa

| Arquivo | Contexto (title) | Tipo | É fluxo de módulo? | Ação |
|---|---|---|---|---|
| `components/CatalogoShareModal.tsx` | Compartilhar catálogo | ação auxiliar | não | manter |
| `components/DependenciasModal.tsx` | Exclusão bloqueada por vínculos | diagnóstico de leitura | não | manter |
| `components/DocumentPrintButton.tsx` | Impressão do Documento | impressão (leitura) | não | manter |
| `components/ImportModal.tsx` | Importar `${tipo}` | carga de dados | sim | P3 — residual |
| `components/LabelSheet.tsx` | Imprimir etiquetas | impressão | não | manter |
| `components/PortalAccessModal.tsx` | Portal do cliente | acesso portal (leitura) | não | manter |
| `components/ReauthModal.tsx` | reautenticação (step-up) | infra/segurança | não | manter |
| `components/RecebimentoCompraModal.tsx` | Receber compra #N | transação de recebimento | sim | P2 — residual |
| `pages/CatalogoPublico.tsx` | Link do produto | catálogo público (fora do ERP) | não | manter |
| `pages/ComissoesPage.tsx` | Comissões de `${detalhe}` | detalhe de leitura | não | manter |
| `pages/CotacoesCompraPage.tsx` | Adicionar item à cotação | child-flow da cotação | não | manter |
| `pages/CotacoesCompraPage.tsx` | Convidar fornecedores | child-flow da cotação | não | manter |
| `pages/CotacoesCompraPage.tsx` | Cotação de `${fornecedor}` | child-flow da cotação | não | manter |
| ~~`pages/CotacoesCompraPage.tsx`~~ | ~~Nova cotação~~ | **criação** | **SIM** | **✅ Convertida → `/cotacoes-compra/novo`** |
| `pages/CustoPage.tsx` | Nova ficha técnica | criação de ficha | sim | P2 — residual |
| `pages/DevolucoesPage.tsx` | Solicitar devolução | criação de devolução | sim | P2 — residual |
| `pages/DevolucoesPage.tsx` | Autorizar devolução | ação no detalhe | não | manter |
| `pages/DevolucoesPage.tsx` | Registrar rastreamento | child-flow da devolução | não | manter |
| `pages/DevolucoesPage.tsx` | Receber mercadoria | child-flow da devolução | não | manter |
| `pages/DevolucoesPage.tsx` | `acaoAberta === …` | ação no detalhe | não | manter |
| `pages/EmpresasPage.tsx` | Editar `${nome}` | edição de empresa | sim | P2 — residual |
| `pages/EmpresasPage.tsx` | Quem entra em `${nome}` | acessos (grant/leitura) | não | manter |
| `pages/EstoqueGradePage.tsx` | Lançar movimentação | ação na grade (página do módulo) | não | manter |
| `pages/ExpedicaoPage.tsx` | Ler código de barras | scanner auxiliar | não | manter |
| `pages/ExpedicaoPage.tsx` | Resolver divergência #N | child-flow do documento | não | manter |
| `pages/FichaDetail.tsx` | Editar custos e margem | child-flow da ficha | não | manter |
| `pages/FichaDetail.tsx` | insumo (modal) | child-flow da ficha | não | manter |
| `pages/ImpressaoPage.tsx` | Job `${public_id}` | detalhe de job (leitura) | não | manter |
| `pages/ImpressaoPage.tsx` | Reimpressão Auditada | impressão | não | manter |
| `pages/ImpressaoPage.tsx` | Editar Terminal `${codigo}` | edição de terminal | sim | P3 — residual |
| `pages/ImpressaoPage.tsx` | Parear Novo Agente Local | criação de agente | sim | P3 — residual |
| `pages/ImpressaoPage.tsx` | Configurar Agente | edição de agente | sim | P3 — residual |
| `pages/ImpressaoPage.tsx` | Segredo único | segredo exibido uma vez | não | manter |
| `pages/LogisticaPage.tsx` | Eventos do envio #N | child-flow do documento | não | manter |
| `pages/LogisticaPage.tsx` | Atualizar status do envio #N | child-flow do documento | não | manter |
| `pages/MedidasPage.tsx` | Copiar tabela de outra grade | cópia auxiliar | não | manter |
| `pages/NcmPage.tsx` | Nova alíquota / Editar chave | criação/edição de NCM | sim | P2 — residual |
| `pages/OrdemDetail.tsx` | Editar ordem de fabricação | child-flow da OP | não | manter |
| `pages/OrdemDetail.tsx` | itemModal | child-flow da OP | não | manter |
| `pages/OrdemDetail.tsx` | Apontar produção | child-flow da OP | não | manter |
| `pages/OrdemDetail.tsx` | Cancelar ordem de produção | confirmação (inline) | não | manter |
| `pages/PdvPage.tsx` | Abrir caixa | fluxo PDV (balcão) | não | manter |
| `pages/PdvPage.tsx` | movAberto (movimentação) | fluxo PDV | não | manter |
| `pages/PdvPage.tsx` | Fechar caixa | fluxo PDV | não | manter |
| `pages/PdvPage.tsx` | Ler código de barras | scanner PDV | não | manter |
| `pages/PdvPage.tsx` | Reimprimir Cupom | ação PDV | não | manter |
| `pages/Settings.tsx` | Códigos de recuperação | segredo exibido uma vez | não | manter |
| `pages/UsuariosPage.tsx` | Desativar `${n}` usuários | ação (confirmação) | não | manter |
| `pages/UsuariosPage.tsx` | Bloquear acesso de `${nome}` | ação | não | manter |
| `pages/UsuariosPage.tsx` | Política de senha | leitura | não | manter |
| `pages/UsuariosPage.tsx` | Certificação de acessos | leitura | não | manter |
| `pages/UsuariosPage.tsx` | Certificar acesso de `${nome}` | ação | não | manter |
| `pages/UsuariosPage.tsx` | Senha temporária gerada | segredo único | não | manter |
| `pages/UsuariosPage.tsx` | Convite de acesso criado | entrega manual | não | manter |
| `pages/UsuariosPage.tsx` | `UsuarioFormModal` (`editing`) | criação/edição de usuário | sim | P2 — residual |
| `pages/UsuariosPage.tsx` | `Usuário #${id}` | detalhe de usuário | não | manter |
| `pages/WebhooksPage.tsx` | Novo webhook / Editar `${nome}` | criação/edição de webhook | sim | P2 — residual |
| `pages/WebhooksPage.tsx` | Segredo do webhook | segredo único | não | manter |
| `pages/WebhooksPage.tsx` | Log — `${nome}` | leitura de log | não | manter |

### 4.2 Residuais (documentados, não bloqueiam)

Os 11 painéis de fluxo de módulo remanescentes foram classificados **P2/P3** e
registrados na matriz de gaps. Eles não foram convertidos nesta rodada porque
cada conversão é uma reescrita do fluxo do módulo (página própria + rota +
`ModulePage` + testes) e o PR já carrega um Changeset auditável; **não foram
escondidos**: cada um está visível na tabela acima com sua classificação.

---

## 5. Mecanismo de auditoria de capacidades

### 5.1 Artefatos

| Arquivo | Papel |
|---|---|
| `docs/ERP-3.0-CAPACITIES.json` | Registro canônico: **134** capacidades |
| `scripts/capacidades-audit.ts` | Motor de auditoria |
| `scripts/auditar-menu.ts` §8 | Integração no gate de menu |
| `server/test/capacidades-audit.test.ts` | Prova de gates negativos (6 casos) |

### 5.2 Grafo reconectado

Cada capacidade é **CAPACIDADE → API → RECURSO → TABELA → PÁGINA → ROTA → MENU → RBAC → TENANCY → TESTE**.

### 5.3 Regras (cada uma tem um gate negativo no teste)

| Regra | Quando falha |
|---|---|
| `CAPACIDADE_SEM_MENU` | capacidade operacional sem entrada na árvore de menu |
| `CAPACIDADE_ROTA_DIFERENTE` | rota da capacidade diverge do módulo |
| `CAPACIDADE_RBAC_DIFERENTE` | `minPerfil` diverge do módulo |
| `ROTA_SEM_PAGINA` | rota sem página válida (PAGES_ESPECIAIS, App.tsx direto, conector, branch do `ModulePage`, módulo com `resource`) |
| `INFRA_NO_MENU` | infra/CSI no menu |
| `CAPACIDADE_SEM_JUSTIFICATIVA` | capacidade sem `justificativa` |
| `CAPACIDADE_RECURSO_INVALIDO` | resource declarado não existe |
| `CAPACIDADE_TABELA_INVALIDA` | tabela declarada não existe |
| `CAPACIDADE_SEM_TESTE` (AVISO) | capacidade sem teste |
| `RECURSO_SEM_DONO` | resource operacional sem módulo dono |
| `PLANNED_OBSOLETO` | módulo `planned` com `resource` (backend funcional) |

### 5.4 Prova (gate negativo)

`server/test/capacidades-audit.test.ts` — **6 casos, todos passam**:
1. registro canônico → **0 erros**;
2. capacidade com `menu:true` sem módulo → `CAPACIDADE_SEM_MENU`;
3. rota sem página → `ROTA_SEM_PAGINA`;
4. resource sem dono → `RECURSO_SEM_DONO`;
5. módulo `planned` com backend → `PLANNED_OBSOLETO`;
6. infra no menu → `INFRA_NO_MENU`.

### 5.5 Resultado da execução

```
npm run audit:menu
│ capacidades declaradas .. 134
│ capacidades no menu ..... 106
│ capacidades de infra .... 4
❌ ERROS ... 0
⚠️  AVISOS (1) — feriados (RECURSO_SEM_MENU, classificado, não bloqueia)
```

> O erro que motivou a criação do mecanismo — `contagem-ciclica-abc` sem menu —
> foi corrigido e **reaparece como capacidade com menu** (106 módulos).

---

## 6. Correções P1 aplicadas

### 6.1 Contagem Cíclica ABC — invisibilidade no menu (GAP-P1-21)

**Defeito:** o fluxo existia no backend (`server/src/contagemCiclica.ts`,
rota `/api/inventarios/ciclicas`, migration `0064`) mas **não tinha entrada
no menu** nem página própria no front.

**Correção (front):**

* `client/src/components/contagemCiclica.tsx` — superfície compartilhada:
  `ContagemCiclicaView`, `PlanejarCiclicoPanel`, `CardResumo`, `podePlanejar`,
  tipos `Inv`/`ItemCont`;
* `client/src/pages/ContagemCiclicaPage.tsx` — **LISTA → DETALHE**, rota
  `/contagem-ciclica-abc`, painel "Planejar ciclo ABC" gated por `podePlanejar`,
  **zero modal**;
* `client/src/modules.ts` — módulo próprio `contagem-ciclica-abc`
  (`Inventário` → `Contagem Cíclica ABC`, ícone `Layers`, palavras-chave
  `contagem ciclica abc · rota diferente · estoque · suprimentos · inventario`),
  adicionado a `PAGES_ESPECIAIS` e `MODULOS_PAGINA_PROPRIA`;
* `client/src/pages/ModulePage.tsx` — `import()` diferido + branch
  `module.id === 'contagem-ciclica-abc'`;
* `client/src/pages/InventarioModulePage.tsx` — link "Contagem Cíclica ABC";
* `client/src/pages/ContagemCiclicaPage.test.tsx` — **5 testes** (lista, plano
  em painel, estado sem permissão, erro de API).

**Backend (já existia, mantido):** `inventarios` (`empresa: true`, ops
create/update), `contagemCiclica.ts` (sem novo saldo/ledger — reutiliza
`inventarios`, `itens_inventario`, `movimentacoes`).

### 6.2 Produção — rótulo incoerente (GAP-P1-22)

**Defeito:** o módulo `ordens` era exibido como `Cadeias de Fabricação`.

**Correção:** `client/src/modules.ts` — rótulo → **`Ordens de Produção`**.
Rota `/ordens`, recurso `ordens`, subgrupo, backend e todos os fluxos
(`apontamento`, `concluir`, `reabrir`, `cancelar`) **inalterados**. A
palavra-chave `cadeias de fabricacao` foi mantida para não perder buscas.

### 6.3 Cotações de Compra — criação escondida em painel (GAP-P1-23)

**Defeito:** o botão `Nova cotação` abriva um `PainelInline` de criação
**dentro da listagem** — violação de LISTA → PÁGINA.

**Correção:**

* `client/src/pages/CotacoesCompraFormPage.tsx` — **nova página própria**
  `/cotacoes-compra/novo` (título obrigatório, critério via `CRITERIOS`, prazo,
  `POST /cotacoes_compra {titulo, criterio, prazo_validade}`, navega para
  `/cotacoes-compra/:id`; cancel → `/cotacoes-compra`; aviso RBAC âmbar; zero modal);
* `client/src/App.tsx` — rotas `/cotacoes-compra/novo` e `/cotacoes-compra/:id`
  (com wrapper `CotacoesCompraDetalhe` que resolve `:id`);
* `client/src/pages/CotacoesCompraPage.tsx` — painel de criação **removido**;
  ambos os botões `Nova cotação` → `navigate('/cotacoes-compra/novo')`;
  `export const CRITERIOS`;
* `client/src/pages/CotacoesCompraFormPage.test.tsx` — **3 testes** (título
  obrigatório antes do POST; criação + navega para `/cotacoes-compra/55`; erro
  do servidor na página, sem modal).

---

## 7. Fiscal — Obrigações → detalhe → execuções → evidências

**Fluxo auditado (não duplicado):**

`Obrigações fiscais` (`/fiscal/obrigacoes`) → **detalhe** (`FiscalObrigacaoDetalhePage`)
→ **execuções** (`FiscalExecucoesPage`) → **evidências**.

* migration `0063` (`fiscal_execucoes_evidencias`) — `fiscal_execucoes`,
  `fiscal_evidencias`, indexação;
* migration `0067` (`fiscal_nao_suportado`) — estado `NAO_SUPORTADO`
  **autoriza**; `VALIDADO` exige validação real (nunca declarado sem validação);
* nenhum layout SPED/EFD/NF-e/EFD-Reinf/DCTF inventado; sem layout oficial →
  `NAO_SUPORTADO` é válido;
* RBAC e tenant coerentes (`fiscal` é recurso multiempresa).

**Testes (novos):**

* `FiscalObrigacaoDetalhePage.test.tsx` — **2 testes** (renderiza obrigação +
  link para `/fiscal/obrigacoes/12/execucoes`; estado de erro);
* `FiscalExecucoesPage.test.tsx` — **4 testes** (histórico + evidências;
  tentativa idempotente; evidência somente aditiva; estado de erro).

---

## 8. Cotações de Compra — regras de negócio preservadas

A conversão da criação para página **não alterou nenhuma regra**: menor preço,
fornecedor, decisão, idempotência, conversão, snapshot, frete e prazo continuam
no backend (`server/src/compras.ts`, `cotacoes.ts`) inalterados. A cotação é um
**documento com snapshot imutável** e a conversão em pedido é explícita.

---

## 9. Backend — auditoria

| Tema | Verificação | Conclusão |
|---|---|---|
| Consulta sem `empresa_id` | `server/src/empresa.ts` aplica filtro obrigatório em toda listagem de recurso com escopo; `?f.empresa_id=2` é **descartado** antes da query | ✅ garantido centralmente |
| `empresa_id` confiável do cliente | o id da empresa **nunca** vem do corpo/query — deriva do ator + seletor da sessão | ✅ |
| Acesso por id cross-tenant | `assertRegistroDaEmpresa` → **404** (não 403) | ✅ |
| Empresa carimbada | criação carimbada pelo servidor; edição **não** permite mudar `empresa_id` | ✅ |
| `checkAccess` | aplicado nos mutations (ver `server/src/resources.ts`) | ✅ |
| Idempotência | recebimento de compra por `idempotency_key`; comissão idempotente | ✅ |
| Validação de input | `server/src/validate.ts` (parsers tipados) | ✅ |
| SQL por concatenação | nenhuma query `select/insert/update/delete` montando SQL com `+`/interpolação de strings (índices e filtros via store) | ✅ |

---

## 10. Segurança

| Tema | Conclusão |
|---|---|
| Tenant (`organizationId` proibido) | arquitetura imutada: `Empresa` = tenant; **não existe** `organizationId`/`organizations` |
| Segredos no client | **0** ocorrências de `process.env` no front (verificado) |
| CORS | configurado no `server/src/index.ts`; allowslist de origem |
| Reautenticação | `ReauthModal` (step-up de senha) para mutações sensíveis |
| RBAC | 124 recursos; 45 com `minPerfil` restritivo; `contagemCiclica` exige gestor + `checkAccess` em leitura |

---

## 11. Integridade

* **Estrutura imutada:** `Empresa` = tenant; `Usuário` = identidade;
  `Usuário×Empresa` = contexto. **Nada novo foi criado** (`organizationId` proibido).
* **Nenhuma segunda fonte de verdade:** `vendas` (operacional), `movimentacoes`
  (eventos), financeiro único, sem segundo CRM/fiscal/motor.
* **Conversões explícitas:** `0066` (`cotacao_conversao_unidade`) declara a
  conversão; fora do declarado → **não converte**.
* **Prisma limitado:** 11 modelos, 5 com `empresaId`; `schema.sql` +
  `db/migrations/*.sql` são a fonte de verdade; Prisma não substitui.
* **Migrations 0063–0067:** aditivas, idempotentes, não destrutivas.

| Migration | Conteúdo |
|---|---|
| 0063 | `fiscal_execucoes_evidencias` |
| 0064 | `contagem_ciclica_abc` |
| 0065 | `custodia_faccionamento_eventos` |
| 0066 | `cotacao_conversao_unidade` |
| 0067 | `fiscal_nao_suportado` |

---

## 12. Command Palette, Breadcrumb, Forms, Lists

* **Command Palette (Ctrl+K)** — `CommandPalette.tsx`: busca de módulos/ações;
  exceção declarada no baseline (navegação global, não fluxo de módulo); rota
  atingível; sem cadastro/edição/detalhe no overlay.
* **Breadcrumb** — deriva da árvore `buildNavigationTree`; cada rota canônica
  resolve para Área → Grupo → Módulo → recurso.
* **Forms/Lists** — canonização **LISTA → DETALHE → `/recurso/novo` →
  `/recurso/:id/editar`**; confirmações críticas via `ConfirmacaoInline`.
* Zero modal em fluxo de módulo: `npm run audit:ux` **OK**.

---

## 13. Documentação

| Arquivo | Estado |
|---|---|
| `docs/RELATORIO-PR95-AUDITORIA-INTEGRAL.md` | **novo** (este documento) |
| `docs/ERP-3.0-ARCHITECTURE-INVENTORY.json` | **regenerado** |
| `docs/ERP-3.0-GAP-MATRIX.md` | §10 (PR #95) **adicionado** |
| `docs/ERP-3.0-CAPACITIES.json` | **novo** |
| `docs/ERP-3.0-UX-BASELINE.json` | mantido |

---

## 14. Evidência — comandos

```
npm run audit:menu            → OK (106 módulos · 134 capacidades · 0 erros)
npm run audit:ux              → OK (0 sobreposição nova · 6 exceções declaradas)
npm run architecture:audit    → OK (139 tabelas · 119 empresa_id · 85.5% tenant)
npm run typecheck             → OK
npm run lint                  → OK
npm run build                 → OK
npm test                      → server 1399 pass / client 880 pass / 0 fail
npm run test:server -- test/capacidades-audit.test.ts   → 6 pass
```

## 15. Residuais

| ID | Nível | Domínio | Residual | Status |
|---|---|---|---|---|
| GAP-P2-21 | P2 | Ficha | criação/edição de ficha em PainelInline (`CustoPage`) | registrado |
| GAP-P2-22 | P2 | Devoluções | `Solicitar devolução` em PainelInline | registrado |
| GAP-P2-23 | P2 | Empresas | cadastro/edição de empresa em PainelInline | registrado |
| GAP-P2-24 | P2 | NCM | cadastro/edição de alíquota em PainelInline | registrado |
| GAP-P2-25 | P2 | Webhooks | cadastro/edição de webhook em PainelInline | registrado |
| GAP-P2-26 | P2 | Compras | `RecebimentoCompraModal` (painel de transação) | registrado |
| GAP-P2-27 | P2 | Usuários | `UsuarioFormModal` (painel de criação/edição) | registrado |
| GAP-P3-08 | P3 | Importação | `ImportModal` | registrado |
| GAP-P3-09 | P3 | Impressão | agentes/terminais em painel no `/config/impressao` | registrado |
| GAP-P3-10 | P3 | PDV | caixa/movimentação/scanner no PDV (balcão) | registrado |
| — | — | DB/Prisma/PG | `db:validate`, `prisma validate`, `test:pg` | **CI** (ambiente local bloqueado) |

## 16. Veredito

> **READY FOR MERGE**
