# RELATÓRIO — REPRESENTANTES NO PADRÃO LISTA → PÁGINA

**Data:** 2026-10-26
**Branch:** `arena/36c19a65-brobond-erp`
**Base SHA:** `cbd22d6c9d884ca2c9381617226cbd648c7c0085` (`main` — “merge: fornecedores no padrão lista pagina”)
**SHA da implementação (código, testes e smoke):** `45b28b79642d8362fd9889f6df904151ae57ac4f`
**HEAD da branch:** commit imediatamente posterior, que inclui este relatório (informado na entrega).
**Escopo:** migrar **somente** o cadastro de `representantes` do CRUD genérico com **modal** para o padrão canônico **LISTA → PÁGINA**, como Clientes, Fornecedores, Insumos, Cores, Coleções, Grades e Tamanhos. Nenhum outro módulo foi redesenhado.

---

## 1. Rotas (todas dentro do mesmo `ModuleAccess`)

| Rota | Componente | Papel |
| --- | --- | --- |
| `/representantes` | `RepresentantesPage` (via `ModulePage`, branch `module.id === 'representantes'`) | LISTA: busca, filtros, ordenação, paginação, densidade, colunas, exportação e ações. **Não** abre formulário. |
| `/representantes/novo` | `RepresentanteFormPage` sob `ModuleAccess moduleId="representantes"` | Página “Novo representante”: mesma `RecordForm` por metadados, botão **Salvar representante**. |
| `/representantes/:id/editar` | `RepresentanteFormPage` sob `ModuleAccess moduleId="representantes"` | Página “Editar representante”: carrega o registro, botão **Salvar alterações**, 404 com caminho de volta. |

O `ModulePage` **não** cai mais no `ResourceCrud` genérico para `representantes`: há um *dispatch* dedicado e o `FORM_DIRETO` inclui o recurso, então `openCreate`/`openEdit` navegam e o bloco de `Modal` existente nunca é montado para este cadastro.

---

## 2. Arquivos

**Novos**

| Arquivo | Conteúdo |
| --- | --- |
| `client/src/pages/RepresentantesPage.tsx` | Lista dedicada (PageHeader, busca com debounce, filtros, tabela/cartões, densidade, colunas persistentes, paginação, exportação, ações e `DependenciasModal`). |
| `client/src/pages/RepresentanteFormPage.tsx` | Página de cadastro/edição (mesmo componente), com `PageHeader`, `Alert`, `Spinner`, `useToast`, `RecordForm` e ações no topo e no rodapé. |
| `client/src/pages/RepresentantesPage.test.tsx` | 23 testes: colunas reais, notice, vazio, erro, busca/filtros/ordenação, paginação, navegação (sem modal), exportação, colunas, ativar/desativar, RBAC e exclusão com diagnóstico. |
| `client/src/pages/RepresentanteFormPage.test.tsx` | 18 testes: página (não sobreposta), seções, campos reais (sem inventados), máscara de CPF, comissão/liquidação, criação, validação, 409 de CPF, usuário opcional, desligamento, anti duplo submit, cancelar, RBAC e edição/404. |
| `client/src/pages/RepresentantesRoute.test.tsx` | 3 testes no `BrowserRouter` real (App): lista, `/novo`, `/:id/editar` e breadcrumb. |
| `server/test/representantes-cadastro.test.ts` | 16 testes (memória): metadado, seções, campos reais, CPF, comissão, busca, filtros, paginação/ordenação, utilização em lote (1 consulta), RBAC, multiempresa, exclusão bloqueada, exclusão simples, desativação e desligamento. |
| `server/test/pg/representantes-pg.test.ts` | PostgreSQL real (auto-skip sem `DATABASE_URL`): CPF único por empresa, usuário único por empresa, busca/filtros, utilização por empresa, FK `NO ACTION` (23503), 409 com diagnóstico e desativação. |

**Modificados**

| Arquivo | Mudança |
| --- | --- |
| `server/src/resources.ts` | `representantes` agora declara as seções reais, `notice`, `filterFields` (`usuario_id`, `ativo`), `quickFilters` de status e `uso` (`vendas.representante_id`). Nenhum campo novo. |
| `server/src/pgstore.ts` | `translatePgError` traduz os dois índices únicos por empresa: `representante_duplicado` (campo `cpf`) e `representante_usuario_duplicado` (campo `usuario_id`). |
| `server/src/dependencias.ts` | `REGRAS_RELACAO` do alvo `representantes` (vendas/comissões/propostas como histórico protegido; clientes como operacional) e `comissoes_eventos.representante_id` em `RELACOES_FK` como `NO_ACTION`. |
| `client/src/lib/lista.ts` | `CONFIG_REPRESENTANTES` (rótulos, larguras, cartão, textos, contagem, `alternarAtivo`) e registro em `LISTA_POR_RECURSO`. |
| `client/src/modules.ts` | `representantes` incluído em `FORM_DIRETO` (demais recursos preservados). |
| `client/src/App.tsx` | Lazy import e rotas `representantes/novo` e `representantes/:id/editar`. |
| `client/src/pages/ModulePage.tsx` | Lazy import e *dispatch* dedicado para `representantes`; comentário do bloco de modal atualizado. |
| `client/src/modules.test.ts` | `FORM_DIRETO` ordenado com `representantes` + teste das rotas filhas. |
| `client/src/lib/lista.test.ts` | Novo `describe` da configuração de representantes. |
| `scripts/smoke-e2e.mjs` | Bloco “CADASTROS › REPRESENTANTES” antes do RBAC final. |

**Sem migration.** `db/schema.sql` e `db/migrations/*` não foram tocados: todos os campos e índices já existiam (migration `0021_cadastros_pessoas.sql`).

---

## 3. Campos reais (nada inventado)

Somente colunas de `representantes` (`db/schema.sql` + migration `0021`):

`nome`, `cpf`, `cargo`, `regiao`, `comissao_pct`, `usuario_id`, `telefone`, `whatsapp`, `email`, `admissao`, `desligamento`, `observacoes`, `ativo`, `criado_em`, `atualizado_em`.

Não existem (e a UI não cria): salário, meta, limite de crédito, banco/PIX, agência/conta, foto, ranking, faturamento, “comissão acumulada”, “vendas totais”, departamento, código interno ou tabela de preço.

### Seções do formulário (via `section` do `RecordForm`)

1. **Identificação** — Nome (obrigatório, wide), CPF (documento/CPF), Cargo, Região.
2. **Comercial** — Comissão padrão (%) `0–100`, com o texto: “a comissão é paga sobre faturas efetivamente **LIQUIDADAS**, não sobre a venda criada”.
3. **Acesso ao ERP** — Usuário do sistema (`ref` → `usuarios`, **opcional**).
4. **Contato** — Telefone, WhatsApp, E-mail.
5. **Situação profissional** — Admissão, Desligamento (com o aviso de que não apaga histórico), Ativo, Observações.

---

## 4. Lista (`/representantes`)

- `PageHeader` **Representantes**, descrição curta, ações **Atualizar**, **CSV**, **XLSX** e **+ Novo representante** (navega).
- Aviso (`notice`) do recurso: desativar/desligar **não apaga** o histórico.
- **Busca server-side** com debounce de 300 ms (`?q=`): nome, CPF (dígitos ou máscara, via comparação por dígitos), cargo, região, telefone, WhatsApp e e-mail.
- **Filtros** (`f.<campo>`): **Status** — Todos / Ativos / Inativos (obrigatório) e **Usuário vinculado** (`f.usuario_id`, opcional; opções de `/usuarios/options`, ausente com segurança quando a API responde 403 a perfis não-admin). Cargo e região são texto livre e entram pela busca, sem inventar endpoint de valores distintos.
- **Colunas**: Representante, CPF, Cargo, Região, Comissão, Usuário, Contato (telefone · e-mail), Status, Utilização — ordenáveis no servidor (`sort`/`dir`), exceto as sintéticas Contato/Utilização.
- **Paginação** server-side (`page`/`pageSize`, 25/50/100), **densidade**, **modo tabela/cartões**, **colunas visíveis persistidas** (`brobond_colunas_ocultas_representantes`) e contador (“1–25 de N representantes”).
- Estados de **carregando**, **erro**, **vazio orientado** e “nada encontrado” com limpeza de recorte.
- **Duplo clique** na linha abre a edição; o menu de ações oferece Editar, Ativar/Desativar e Excluir (conforme RBAC).

## 5. Utilização — contagem real, em lote

- `uso: { recurso: 'vendas', campo: 'representante_id', singular: 'venda', plural: 'vendas' }` no recurso.
- A anotação é feita **no servidor**, uma consulta agregada por página (`anotarUsoVinculado` → `Store.countByColumn`, `GROUP BY`), recortada pela **empresa ativa**; o campo anotado é `uso_vinculado`/`uso_vinculado_label` e é testado para garantir **uma única** chamada agregada (sem N+1).
- O que é contado: **pedidos de venda** da empresa ativa vinculados ao representante. Não é faturamento, meta, ranking nem comissão. Os **clientes atendidos** (`clientes.representante_id`) não entram nesse número; aparecem no diagnóstico de vínculos quando a exclusão é tentada.

---

## 6. Formulário (`/representantes/novo` e `/representantes/:id/editar`)

- Mesmo componente nas duas rotas; diferenças apenas em carregar o registro, título (“Novo representante” / “Editar representante”), descrição, botão (“Salvar representante” / “Salvar alterações”) e tratamento de **404**.
- `PageHeader` com Voltar (link), Cancelar e Salvar; **a mesma dupla no rodapé** do card; breadcrumb do shell.
- `RecordForm` dirigido por `GET /api/meta` (seções, obrigatoriedade, máscaras e dicas do servidor), `Alert` de erro acessível com foco, `Spinner` de carregamento e `useToast` de sucesso.
- **CPF**: máscara compartilhada do ERP, normalização para dígitos no servidor, dígito verificador conferido na API e unicidade por empresa (`uq_representantes_cpf_empresa`). Duplicidade responde **409** `representante_duplicado` com erro no campo e mantém a página aberta.
- **Usuário do sistema**: vínculo **opcional** e único por empresa (`uq_representantes_usuario_empresa` → **409** `representante_usuario_duplicado` no campo `usuario_id`).
- **Comissão**: `comissao_pct` 0–100%, padrão 0; nenhuma alteração em `comissoes.ts` ou no cálculo.
- **Desligamento**: data de situação profissional; não apaga vendas, propostas, clientes, comissões nem auditoria.
- **Multiempresa**: leitura/escrita/exclusão sempre no escopo da empresa ativa; registro de outra empresa responde **404** e a página mostra “Representante não encontrado” com voltar.
- Nenhum `role="dialog"`, `aria-modal`, drawer, sheet ou portal é renderizado pela lista ou pelo formulário.

---

## 7. RBAC e exclusão segura

- **Nenhuma permissão nova**: `representantes` continua cadastro **por empresa** (`empresa: true`), sem `minPerfilEscrita`; o operador lê/cria/edita e **não** exclui (o servidor recusa o DELETE com 403). A UI apenas reflete o servidor, que segue sendo a autoridade.
- **Exclusão**: DELETE de representante com histórico devolve **409** `dependencias_vinculadas` com o diagnóstico completo (módulo, quantidade, ids, motivo) e a tela abre o **“Ver vínculos”** existente, com a ação recomendada **Desativar representante** (`PUT /representantes/:id { ativo: false }`).
- **FKs reais para `representantes`** (todas `NO ACTION`, nenhuma alterada):
  `vendas.representante_id`, `clientes.representante_id`, `propostas.representante_id`, `comissoes_eventos.representante_id`.
- **Nenhum CASCADE novo, nenhuma FK removida, nenhum histórico apagado.** Desativar/desligar mantém o registro e todos os vínculos (testado em memória e no teste PG).

---

## 8. Gates executados

| Gate | Resultado |
| --- | --- |
| `npm run typecheck` (domain + server + client) | **PASS** |
| `npm run lint` | **PASS** — 0 erros; 518 avisos `no-explicit-any` (padrão já usado no repositório, inclusive nos testes) |
| `npm test` — servidor (`node --import tsx --test test/*.test.ts`) | **PASS** — 1118 testes, 1050 pass, 0 fail, 68 skip |
| `npm test` — cliente (`vitest run`) | **PASS** — 67 arquivos, 794 testes |
| `npm run build` (Vite + PWA) | **PASS** |
| `npm run audit:menu` | **PASS** — sem erros; 19 avisos classificados (`ROTA_SEM_MENU` para rotas `/novo` e rotas públicas de impressão/health pré-existentes) |
| `npm run smoke` (API real, modo demonstração) | **PASS** — **289/289** verificações, incluindo o bloco novo de representantes |
| `npm run test:pg` | **SKIP — não executado.** PostgreSQL indisponível neste ambiente (`DATABASE_URL` ausente e sem `psql`/`initdb`); o gate sai com código 2 e a mensagem “test:pg exige DATABASE_URL”. **SKIP ≠ PASS.** |
| `npm run smoke:pg` | **SKIP — não executado** pelo mesmo motivo (código 2). **SKIP ≠ PASS.** |

O teste `server/test/pg/representantes-pg.test.ts` **auto-pula** sem `DATABASE_URL` (mesmo padrão dos demais arquivos PG do repositório) e cobre, quando houver banco: CPF/usuário únicos por empresa, isolamento multiempresa, utilização por empresa, 23503 na FK e o 409 com diagnóstico.

---

## 9. Confirmações da entrega

- [x] `/representantes` é LISTA; cadastro/edição em páginas próprias.
- [x] **Modal eliminado** do cadastro de representantes (o `ResourceCrud` não é montado para o recurso).
- [x] Nenhum drawer, sheet, overlay, `role="dialog"`, `aria-modal` ou `createPortal` no fluxo de cadastro/edição (asserções nos testes de página e de rota).
- [x] Campos reais do banco, sem invenção; sem migration.
- [x] CPF (máscara + dígito verificador + unicidade por empresa) preservado.
- [x] `usuario_id` (vínculo opcional, único por empresa, isolamento) preservado.
- [x] `comissao_pct` 0–100% com a explicação de faturas liquidadas; `comissoes.ts` intocado.
- [x] `desligamento` como situação profissional, sem apagar histórico.
- [x] Multiempresa: cross-company → 404/bloqueio.
- [x] RBAC preservado (sem permissão inventada; servidor como autoridade).
- [x] Exclusão segura: 409 + diagnóstico + desativação; sem CASCADE novo, sem remover FK.
- [x] Nenhum outro módulo alterado (somente integrações de rota/registry/lista/smoke ligadas a Representantes).
- [x] Working tree limpo após o commit.
- [x] Branch pronta, sem merge em `main` e sem deploy.

---

## 10. Observações

- **PostgreSQL:** os gates `test:pg`/`smoke:pg` ficaram **SKIP** (ambiente sem banco). Declarado explicitamente — não foram tratados como PASS.
- **Utilização:** conta **pedidos de venda** (relação real `vendas.representante_id`), agregada no servidor em uma consulta por página. `clientes.representante_id` é vínculo real e aparece no diagnóstico de exclusão, mas não é somado ao número exibido.
- **Importação:** `IMPORT_TIPOS` do `ImportModal` não inclui representantes; nada foi alterado nesse componente (fora do escopo).
- **Máscara na edição:** o formulário exibe o valor gravado (dígitos) e aplica a máscara ao digitar, exatamente como o `RecordForm` compartilhado faz nos demais cadastros; a formatação de CPF/telefone aparece na lista.
- **Testes de consumidores existentes** (`/representantes/options` em Clientes e Vendas, criação via `createRecord` em pedidos/relatórios/financeiro/PDV) continuam verdes — o contrato da API não mudou.
