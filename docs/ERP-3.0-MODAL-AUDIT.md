# BROBOND ERP 3.0 — AUDITORIA DE MODAIS (ZERO MODAL)

> **Regra de produto definitiva:** nenhum fluxo de módulo do ERP usa modal,
> dialog, drawer, sheet ou overlay. Todo cadastro é
> **LISTA → DETALHE → `/recurso/novo` → `/recurso/:id/editar`**, e toda
> confirmação crítica acontece **na própria página**.

- **Data:** 2026-10-27
- **Branch:** `arena/72895db5-brobond-erp`
- **Gate automatizado:** `npm run audit:ux` (script `scripts/auditar-ux.mjs`) e
  `client/src/test/zero-modal.test.ts`. O primeiro falha (exit 1) se aparecer
  assinatura de sobreposição acima do baseline declarado — por arquivo **e** por total; o segundo
  trava o contrato no nível do código de teste.
- **Complemento:** `npm run audit:menu` verifica que cada rota de cadastro tem
  entrada navegável (nenhum cadastro "só por link direto").

---

## 1. Resultado da auditoria

| Métrica | Valor |
| --- | --- |
| Assinaturas de sobreposição encontradas | **9** (todas fora de fluxo de módulo) |
| Exceções declaradas | **6** |
| Modais em fluxo de módulo | **0** |
| Módulos com cadastro em modal | **0** |
| Módulos com página própria (LISTA/PÁGINA) | **42** (`MODULOS_PAGINA_PROPRIA`) |
| Módulos no CRUD genérico LISTA → PÁGINA | todos os demais de `space: 'erp'` |

---

## 2. Inventário (arquivo · componente · módulo · finalidade · substituto · rota · status)

### 2.1 Eliminados nesta evolução (substituídos por página)

| Arquivo | Componente removido | Módulo | Finalidade original | Substituto | Nova rota | Status |
| --- | --- | --- | --- | --- | --- | --- |
| `client/src/components/ui.tsx` | `Modal` | todos | Contêiner de sobreposição usado por CRUDs | Removido: não há mais componente de modal no kit | — | ✅ eliminado |
| `client/src/components/ui.tsx` | `ConfirmDialog` | todos | Confirmação de exclusão/ação destrutiva | `ConfirmacaoInline` (bloco na própria página) | rota corrente | ✅ eliminado |
| `client/src/components/ui.tsx` | `Drawer` / `Sheet` | todos | Painel lateral de formulário | `PainelInline` (seção da página) | rota corrente | ✅ eliminado |
| `client/src/pages/*` (43 arquivos) | uso de `Modal`/`ConfirmDialog` no CRUD | cadastros e documentos | Criar/editar registro | `RegistroPage` genérica (`/recurso/novo`, `/recurso/:id/editar`) | `/recurso/novo`, `/recurso/:id/editar` | ✅ eliminado |
| `client/src/pages/ModulePage.tsx` | `openCreate` em modal | todos os módulos de CRUD | Inclusão de registro | navegação para `${basePath}/novo` | `/<módulo>/novo` | ✅ eliminado |
| `client/src/pages/ModulePage.tsx` | `openEdit` em modal | todos os módulos de CRUD | Edição de registro | `DETALHE_DIRETO` → `/:recurso/:id`; senão `${basePath}/:id/editar` | ver §2.3 | ✅ eliminado |
| `client/src/pages/UsuariosPage.tsx` | diálogo de ações | Usuários | Ações de ciclo de vida | menu de ações + `ConfirmacaoInline` | `/usuarios` | ✅ eliminado |

### 2.2 Exceções DECLARADAS — não são fluxo de módulo

Cada exceção está declarada em **`docs/ERP-3.0-UX-BASELINE.json`** (categoria + motivo + contagem),
validada pelo próprio gate; o
gate **falha** se uma nova aparecer sem declaração.

| Arquivo | Componente/assinatura | Contexto | Por que não é fluxo de módulo | Status |
| --- | --- | --- | --- | --- |
| `client/src/components/CommandPalette.tsx` | `role="dialog"`, `aria-modal`, backdrop | Navegação global (Ctrl+K) | Busca de módulos e ações; nenhum cadastro, edição ou detalhe de registro acontece ali | ⚠️ exceção mantida |
| `client/src/components/Sidebar.tsx` | backdrop mobile | Árvore de navegação | Navegação; nenhum CRUD é renderizado no drawer | ⚠️ exceção mantida |
| `client/src/components/Layout.tsx` | estrutura/comentário do drawer mobile | Casca de layout | Reenvia ao `Sidebar`; nenhum conteúdo de negócio | ⚠️ exceção mantida |
| `client/src/pages/UsuariosPage.tsx` | captura invisível de clique fora | Menu de ações da linha | Elemento sem conteúdo visual (`cursor-default`), não é overlay de conteúdo | ⚠️ exceção mantida |
| `client/src/pages/PortalCliente.tsx` | backdrop | Portal PÚBLICO do cliente (`/portal/:token`) | Fora do ERP; página do cliente final | ⚠️ exceção mantida |
| `client/src/pages/CatalogoPublico.tsx` | `role="dialog"`, `aria-modal`, 3× backdrop | Catálogo PÚBLICO (`/catalogo/:token`) | Ambiente de compra do cliente final (ampliação de foto e carrinho), não módulo interno | ⚠️ exceção mantida |

### 2.3 Rotas canônicas de cada módulo com cadastro

| Padrão | Critério | Rotas |
| --- | --- | --- |
| **LISTA → PÁGINA (genérico)** | `usaCrudGenerico(m)` | `/<módulo>` · `/<módulo>/novo` · `/<módulo>/:id` · `/<módulo>/:id/editar` |
| **DETALHE DIRETO** | `DETALHE_DIRETO.has(m.id)` (OP, ficha técnica, compras) | `/<módulo>` · `/<módulo>/:id` (a página de detalhe é o documento) |
| **FORM DIRETO** | `FORM_DIRETO.has(resource.key)` | `/<módulo>/novo` · `/<módulo>/:id/editar` |
| **PÁGINA PRÓPRIA** | `MODULOS_PAGINA_PROPRIA.has(m.id)` | página dedicada (§3) |

---

## 3. Módulos com página própria (42)

Lista exata, lida de `client/src/modules.ts`:

`usuarios`, `webhooks`, `estoque`, `medidas`, `inventario`, `custo`,
`planejamento-producao`, `relatorios`, `financeiro`, `ajuda`, `pdv`,
`expedicao`, `cotacoes-compra`, `importar-nfe-compra`, `sugestao-compra`,
`devolucoes`, `envios`, `ncm`, `comissoes`, `empresas`, `inutilizacoes`,
`colecoes`, `insumos`, `fornecedores`, `representantes`, `territorios`,
`metas`, `painel-comercial`, `equipes_comerciais`, `equipe_membros`,
`representante_hierarquia`, `representante_cliente`, `venda_atribuicao`,
`planos_comissao`, `regras_comissao`, `crm-painel`, `crm-agenda`,
`transferencias-estoque`, `homologacao-fornecedores`, `producao-capacidade`,
`fiscal-calendario`, `balancete`.

**Páginas novas desta evolução (ERP 3.0):**

| Módulo | Rota | Componente | Por que página própria |
| --- | --- | --- | --- |
| Transferências de estoque | `/estoque/transferencias` | `EstoqueTransferenciasPage.tsx` | Documento com máquina de estados, itens, eventos e disponibilidade — não cabe em formulário genérico |
| Homologação de fornecedores | `/compras/fornecedores` | `ComprasFornecedoresPage.tsx` | Processo com trilha, documentos, pendências e desempenho calculado |
| Capacidade e MRP | `/producao/capacidade` | `ProducaoCapacidadePage.tsx` | Leitura agregada (ocupação, gargalo, necessidade) — não é cadastro |
| Calendário fiscal | `/fiscal/calendario` | `FiscalCalendarioPage.tsx` | Grade de competências com ação de entrega inline |
| Balancete | `/financeiro/balancete` | `FinanceiroBalancetePage.tsx` | Leitura contábil com pendências de classificação |

---

## 4. Como o gate funciona

```bash
npm run audit:ux        # falha (exit 1) em baseline + QUALQUER ocorrência nova
npm run audit:menu      # falha se um cadastro não tiver entrada navegável
npm --workspace client run test   # inclui client/src/test/zero-modal.test.ts
```

`scripts/auditar-ux.mjs`:

1. varre `client/src/**` removendo comentários (`semComentarios()`) — comentário
   que cita "modal" não é ocorrência;
2. procura `role="dialog"`, `aria-modal`, backdrops `fixed inset-0`,
   `Sheet`, `Drawer` e afins;
3. exige que cada ocorrência esteja no baseline **com categoria permitida, justificativa e contagem exata**;
4. valida também que os módulos com cadastro declaram suas rotas de página.

`client/src/test/zero-modal.test.ts` complementa no nível de teste:

- nenhum módulo de ERP usa CRUD em sobreposição;
- `MODULOS_PAGINA_PROPRIA` e `DETALHE_DIRETO` são coerentes com `usaCrudGenerico()`;
- `ConfirmacaoInline`/`PainelInline` existem e são usados no lugar de
  `ConfirmDialog`/`Drawer`.

---

## 5. Dívida residual (honesta)

| Item | Classificação | Observação |
| --- | --- | --- |
| `CatalogoPublico` mantém lightbox e carrinho sobrepostos | **P3** | Ambiente público de compra do cliente final; decisão de produto consciente |
| Drawer de navegação mobile (`Sidebar`) | **P3** | É menu, não cadastro |
| `CommandPalette` (Ctrl+K) | **P3** | Atalho de navegação global |
| `UsuariosPage` — captura de clique fora do menu de ações | **P3** | Elemento invisível, sem conteúdo |

Nenhum item da lista é fluxo de módulo: **não existe CRUD, detalhe ou
formulário dentro de sobreposição no ERP.**

---

## 11. Endurecimento do gate (correção final do PR #92, 2026-10-27)

O gate anterior tinha duas fraquezas reais: as exceções viviam **dentro do
script** (mudar exceção = mudar código, sem diff revisável de política) e só
media **4** assinaturas. Além disso, um arquivo com exceção podia crescer até o
limite sem que o total do repositório fosse conferido.

### 11.1 O que passou a ser medido (10 assinaturas)

| id | O que detecta |
|---|---|
| `role-dialog` | `role="dialog"` |
| `role-alertdialog` | `role="alertdialog"` |
| `aria-modal` | `aria-modal="true"` |
| `overlay-fixo` | `fixed` + `inset-0` no mesmo `className` |
| `overlay-fixo-inverso` | `inset-0` antes de `fixed` (mesma coisa, ordem trocada) |
| `overlay-eixos` | `inset-x-0` **e** `inset-y-0` (tela inteira) |
| `elemento-dialog` | `<dialog>` nativo |
| `show-modal` | `HTMLDialogElement.showModal()` |
| `componente-modal` | `<Modal>`, `<Dialog>`, `<Drawer>`, `<Sheet>`, `<AlertDialog>`, `*Root`, `*Content`… |
| `portal` | `createPortal(...)` |

Barra fixa (`fixed inset-x-0 bottom-0`) **não** é overlay: a assinatura de eixos
exige os dois eixos, para não punir barra de ação legítima.

### 11.2 O baseline (`docs/ERP-3.0-UX-BASELINE.json`)

* cada exceção declara `arquivo`, `categoria`, `motivo` e `padroes` (contagem
  exata por assinatura);
* `categoria` **precisa** ser uma de: `navegacao_global`, `menu_mobile`,
  `infraestrutura`, `portal_publico`, `catalogo_publico`;
* `motivo` com menos de 40 caracteres é recusado;
* `totais` declarados por assinatura — medido **acima** do declarado é falha;
* arquivo inexistente, assinatura desconhecida e JSON inválido são falhas;
* **caminho de formulário/cadastro/detalhe** (`RegistroPage`, `RecordForm`,
  `*Form`, `*Novo`, `*Edicao`, `*Detalhe`, `*Exclusao`, `*Selecao`,
  `*Confirmacao`) **nunca** pode ser exceção.

### 11.3 O que continua não sendo violação

* comentário ou prosa que **menciona** modal/dialog (o gate remove comentários
  antes de varrer — sem isso puniria a própria documentação);
* as 6 exceções declaradas (navegação global, menu mobile, captura invisível de
  clique e ambiente público).

### 11.4 Prova de que o gate morde

`client/src/test/zero-modal-baseline.test.ts` monta raízes temporárias e
verifica: arquivo novo com `<Modal>` falha; `role="dialog"`, `aria-modal`,
`<dialog>`, `showModal()`, `createPortal`, `fixed inset-0` (3 variações) falham;
contagem que cresce em arquivo já exceptuado falha; total acima do declarado
falha; exceção sem categoria / com categoria de fluxo de módulo / com motivo
curto / em página de cadastro falha; baseline ausente falha; e — no sentido
oposto — barra fixa e texto que menciona modal **passam**.
