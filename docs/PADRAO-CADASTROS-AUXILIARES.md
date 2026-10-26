# Padrão de cadastros auxiliares — LISTA → PÁGINA

Cadastros simples do ERP (poucos campos, uso frequente) **não** usam caixa modal
central **nem** drawer/sheet lateral. A tela principal é a **lista**; criar e
editar são **páginas próprias do ERP**, para o usuário navegar como em qualquer
outra tela do sistema.

Referência canônica: **Cores** (`client/src/pages/CorFormPage.tsx`, rotas
`/cores/novo` e `/cores/:id/editar`). Coleções, Categorias, Produtos, Clientes e
Vendas seguem o mesmo padrão (`FORM_DIRETO` em `client/src/modules.ts`).

## Estrutura da tela

- `PageHeader` com título, descrição curta e ação `+ Novo` (navega, não abre
  superfície).
- `FilterBar` com `SearchInput` (busca server-side via `q`) e o filtro de status
  (`f.ativo`): **Todas / Ativas / Inativas**.
- `DataTable` com colunas só do que existe no modelo + `Status` + `Ações`.
- `EmptyState` orientado: sem registros, explica o que fazer e oferece `+ Novo`;
  com recorte ativo, oferece limpar busca/filtros.
- `Pagination` server-side, preservada.

## Página de cadastro/edição (não é drawer nem modal)

- Rotas próprias: `/colecoes/novo` e `/colecoes/:id/editar`, registradas no
  roteador do ERP sob o mesmo `ModuleAccess` do módulo (sem roteamento paralelo).
- Mesmo formulário em **novo** e **edição**: o `RecordForm` dirigido por
  metadados, dentro de um `card` da página, com o breadcrumb do shell
  (`BROBOND ERP › Cadastros › Coleções › Novo/Editar`).
- Título "Nova coleção" / "Editar coleção"; ações `Voltar` / `Cancelar` /
  `Salvar coleção` no cabeçalho e no rodapé. Salvar devolve à lista.
- Mostra **exatamente os campos do recurso** (em `colecoes`: nome, temporada, ano,
  ativo). Nenhum campo é inventado na UI.
- Erro por campo na hora + resumo acessível; o servidor revalida tudo
  (`validatePayload`) e é a autoridade final.
- Nenhuma superfície sobreposta: não há `role="dialog"`/`aria-modal`.

## Utilização (contagem real, sem N+1)

`produtos_vinculados` vem do servidor em **uma** consulta agregada
(`Store.countByColumn` → `GROUP BY colecao_id`), recortada por empresa. A tela só
exibe o número; nunca dispara uma consulta por linha.

## Exclusão e desativação

- A exclusão usa o **diagnóstico de dependências existente**
  (`docs/EXCLUSAO-E-VINCULOS.md`) — sem segunda implementação paralela.
- Coleção em uso por produtos responde **409** com o diagnóstico; a UI abre
  "Ver vínculos" e oferece **Desativar**, nunca DELETE forçado, sem remover FK e
  sem CASCADE.
- Desativar **preserva o histórico**: os produtos continuam apontando para a
  coleção; ela só sai das opções de novos cadastros/seleções.

## RBAC e multiempresa

- A autoridade é o **backend** (`checkAccess`). A UI apenas evita mostrar botões
  que receberiam 403; não é a trava.
- `colecoes` é cadastro **por empresa** (`empresa: true`), sem `minPerfilEscrita`
  — operável por quem já acessa o catálogo. Não se introduz restrição nova aqui.
- Uma empresa não vê, edita, exclui nem conta produtos de coleção de outra
  empresa (isolamento no `store`).

## Testes

- `client/src/pages/ColecoesPage.test.tsx` — lista, busca, filtro, **navegação**
  para `/colecoes/novo` e `/colecoes/:id/editar` (sem modal/drawer), RBAC,
  diagnóstico.
- `client/src/pages/ColecaoFormPage.test.tsx` — página de cadastro/edição
  (campos reais, criar, editar, cancelar, sem sobreposição).
- `client/src/pages/ColecoesRoute.test.tsx` — o App registra as rotas próprias.
- `server/test/colecoes-listagem.test.ts` — busca, filtros, utilização agregada,
  RBAC, multiempresa, exclusão bloqueada, desativação preserva produtos.
