# Etapa 2.1 — Gaps, limites e itens NÃO IMPLEMENTADOS

Regra da etapa: sem endpoint real, a tela documenta o gap — nunca inventa dado.
Este arquivo é o registro oficial do que ficou de fora do "Meu Negócio" e por quê.

Data: 2026-10-08 · Branch: `arena/9e8f7d7c-brobond-erp`.

## 1. Gaps de backend (a tela não tem de onde tirar o dado)

### GAP-NEGOCIOS-DAILY-SERIES — sem série diária de faturamento
- **O que falta:** `GET /api/negocios/resumo` entrega `porMes` (agregado mensal),
  mas não há série dia a dia (nem `porDia` no resumo, nem endpoint dedicado).
- **O que a tela faz:** o gráfico "Faturamento por mês" usa o `porMes` real do
  servidor. Não há gráfico diário — e nenhum ponto é interpolado/estimado.
- **Status: NÃO IMPLEMENTADO** (série diária). Evolução futura exige o agregado
  no motor analítico (`server/src/negocios.ts`).

### GAP-NEGOCIOS-ANTIFRAUDE — sem fonte de risco/fraude
- **O que falta:** nenhum endpoint expõe risco de pedido, suspeita de fraude,
  chargeback ou estorno. Busca em `server/src` e `client/src` retorna zero
  ocorrências (as menções a "fraude" em `UsuariosPage.tsx` são sobre bloqueio
  de conta por suspeita — outro assunto, sem dado agregado).
- **O que a tela faz:** não há bloco de antifraude no "Meu Negócio".
  Inventar um placar sem fonte seria violar a regra da etapa.
- **Status: NÃO IMPLEMENTADO** (bloco antifraude). Evolução futura exige
  endpoint real (ex.: pedidos contestados/estornados por período).

### GAP-COMPRAS-ATRASADAS-POR-DATA — sem agregado pronto
- **O que falta:** `GET /api/dashboard` entrega `comprasPendentes` como contagem
  pura, sem datas. Não há "compras com entrega vencida" agregado.
- **O que a tela faz:** o alerta "Compras pendentes" usa a contagem real, e o
  rodapé do "Precisa de atenção" declara explicitamente o que não foi
  verificado: *"compras atrasadas por data (o painel recebe só a quantidade de
  pendentes, sem datas)"*.
- **Nota de escopo (decisão, não gap de backend):** o recurso `/api/compras`
  possui o campo opcional `previsao_entrega`, então seria possível evoluir com
  uma nova consulta paginada filtrando os 3 status em aberto
  (`pendente`, `aprovado`, `parcial`). Optou-se por não fazer nesta etapa para
  não pendurar no painel uma listagem pesada sem agregado dedicado.
- **Status: NÃO IMPLEMENTADO** (alerta de atraso por data).

## 2. Deixou de ser gap nesta etapa

### Contas que vencem hoje — IMPLEMENTADO
- A primeira varredura tratava "contas que vencem hoje" como sem consulta, mas
  `GET /api/financeiro/resumo` (já consumido pelo painel, gerente/admin) entrega
  `aPagarLista`/`aReceberLista` com `vencimento` por conta.
- A tela agora filtra essas listas pela data de hoje (mesmo padrão do alerta de
  OPs em atraso — comparação de data para exibição, sem recalcular nada) e
  alerta "Contas a pagar/receber vencem hoje" com quantidade e total.
- O rodapé do "Precisa de atenção" foi atualizado e não cita mais esse item.

## 3. Componentes de ui-kit NÃO criados (sem uso honesto na tela)

A etapa pedia priorizar DataTable, Pagination, Combobox, DatePicker,
DateRangePicker e Tabs — **todos implementados, testados e em uso real**:
Tabs (níveis da valorização), Combobox (filtro de canal), DatePicker +
DateRangePicker (período personalizado), DataTable + Pagination (curva ABC),
além dos já existentes (StatCard, DeltaBadge, ErrorState, LoadingState…).

Os abaixo foram avaliados e **NÃO IMPLEMENTADOS** de propósito — criá-los sem
uso na tela seria código morto, e a etapa proíbe inventar:

| Componente | Motivo |
|---|---|
| Switch | Nenhum liga/desliga no painel (filtros são seleção, não booleanos). |
| Checkbox | Nenhuma multi-seleção (canal/período/empresa são escolha única). |
| DropdownMenu (menu de ações) | Nenhum menu de ações por item/bloco; seleção com busca já é o Combobox. |
| BulkActions (ações em lote) | Nenhuma seleção múltipla para agir em lote. |
| Breadcrumb | O painel é a raiz (`/`); navegação de nível único, sem trilha. |

Se uma tela futura precisar deles, o padrão está estabelecido em
`client/src/components/ui-kit.tsx` + `ui-kit.test.tsx` + catálogo
(`client/src/pages/dev/ComponentCatalog.tsx`, rota restrita a admin).

## 4. Itens da etapa atendidos (resumo de conformidade)

- Tela "Meu Negócio" só com APIs reais + ui-kit; sem mock; sem recalcular
  margem/CMV/impostos/ABC (somas e percentuais de *exibição* — participação por
  canal, totais do alerta — usam valores do servidor, como já faziam os blocos
  originais).
- Filtros: período (7/30/90 dias, mês atual, personalizado) + canal; KPIs com
  DeltaBadge vs. período anterior de mesma duração; gráfico mensal real;
  cascata de margem; ABC rotulada "histórico acumulado (não segue o período)";
  canais/top produtos reais; operação/estoque/cadastros; alertas só com fonte
  real + declaração do não verificado.
- `audit()` grava `empresa_id` no momento do evento; feed isolado por empresa
  (testes A/B/C/D + prova em Postgres).
- `/api/dashboard` agrupa dia/semana/mês civil em America/Sao_Paulo
  (`server/src/fuso.ts`, fonte única; 13 testes de fuso + 3 em Postgres).
- Navegação "Meu Negócio" em `/` (Sidebar + rota; já existia, mantido).
- Acessibilidade: blocos com `aria-label`, loading `role=status`, erro
  `role=alert`, tabs/combobox/tabela/paginação com papéis ARIA e navegação por
  teclado (cobertos por testes), sem depender só de cor.
