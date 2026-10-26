# Padrão de cadastros auxiliares — LISTA + DRAWER

Cadastros simples do ERP (poucos campos, uso frequente) não usam mais caixa modal
central. A tela é a **lista**; criar/editar abrem um **Drawer lateral**, para o
usuário não perder o contexto da listagem. Coleções é a primeira aplicação
completa do padrão; cores, tamanhos, grades e categorias passam a segui-lo.

## Estrutura da tela

- `PageHeader` com título, descrição curta e ação `+ Novo`.
- `FilterBar` com `SearchInput` (busca server-side via `q`) e o filtro de status
  (`f.ativo`): **Todas / Ativas / Inativas**.
- `DataTable` com colunas só do que existe no modelo + `Status` + `Ações`.
- `EmptyState` orientado: sem registros, explica o que fazer e oferece `+ Novo`;
  com recorte ativo, oferece limpar busca/filtros.
- `Pagination` server-side, preservada.

## Drawer

- Mesmo formulário em **novo** e **edição** (`Drawer` do design system).
- Título "Nova coleção" / "Editar coleção"; rodapé `[Cancelar] [Salvar coleção]`.
- Mostra **exatamente os campos do recurso** (em `colecoes`: nome, temporada, ano,
  ativo). Nenhum campo é inventado na UI.
- Erro por campo na hora + resumo acessível; o servidor revalida tudo
  (`validatePayload`) e é a autoridade final.

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

`client/src/pages/ColecoesPage.test.tsx` (lista, busca, filtro, drawer, RBAC,
diagnóstico) e `server/test/colecoes-listagem.test.ts` (busca, filtros, utilização
agregada, RBAC, multiempresa, exclusão bloqueada, desativação preserva produtos).
