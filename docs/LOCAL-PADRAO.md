# Local padrão (origem das movimentações)

> Antes, o ERP assumia um local fixo como origem padrão das movimentações e do
> Estoque Físico. Agora o local de origem é **configurável** e passa a ser
> chamado de **Local padrão**; sem nenhum cadastro, o fallback fixo é **"loja"**.

## Como funciona

1. **Cadastre os locais** em **Estoque → Locais** (incluir/excluir já era
   suportado). O campo `padrao` (**Local padrão**) é uma coluna nova: marque
   o local que deve ser a origem padrão.

2. **Só pode haver um Local padrão ativo.** Ao marcar um novo como `padrao`,
   o anterior é desmarcado automaticamente. Se você excluir o Local padrão
   (e houver outro local ativo), o primeiro local ativo restante assume a
   função.

## Gestão livre (decisão do administrador)

O local **não fica preso ao sistema**: pode ser **incluído, alterado e
excluído mesmo quando já está em uso** (saldos no Estoque Físico,
movimentações, inventários, vendas). A decisão é do **administrador**:

- **Renomear** um local em uso propaga o novo nome para todos os registros que
  guardavam o nome antigo como texto (`estoques.local`, `movimentacoes.local`,
  `movimentacoes.local_destino`, `inventarios.local`, `vendas.local_saida`).
  O nome novo não pode colidir com outro local nem com saldos já gravados.
- **Excluir** um local em uso desfaz apenas os vínculos (`local_id` → vazio);
  saldos, movimentações e inventários **permanecem** no sistema com o nome do
  local como histórico — nada é apagado. Se o local excluído era o padrão,
  o primeiro local ativo restante assume (ou, não havendo nenhum, os fluxos
  usam `"loja"` como último recurso).
- **Gerentes** continuam podendo incluir/alterar locais e excluir locais sem
  uso. Excluir/renomear um local **em uso** — ou excluir o **último local
  ativo** — é decisão exclusiva do administrador (erro 403 para os demais).
- A API de listagem anota cada local com `em_uso`, `uso_saldos`,
  `uso_movimentacoes`, `uso_inventarios` e `eh_ultimo_ativo`; a interface
  mostra esses números na confirmação de exclusão.

3. **Fallback (mesmo sem marcar nada):** se nenhum local estiver marcado como
   `padrao`, o sistema usa o **primeiro local ativo** (por nome); se não houver
   nenhum, usa `"loja"` por segurança.

## Onde o Local padrão é aplicado

| Fluxo | Comportamento |
|---|---|
| **Movimentações** (entrada/saída/ajuste/transferência) | Se o campo `Local de origem` ficar em branco/nenhum selecionado, usa o Local padrão |
| **Estoque Físico** (cadastro/edição de saldo) | Idem |
| **Ordem de Fabricação concluída** | Entrada das peças no Local padrão |
| **Faturamento de venda** | `Local de saída` começa no Local padrão; procura saldo nele quando o local configurado não tem |
| **Inventário** | `Local` sem valor → Local padrão |
| **Importação de saldo inicial** | `local` vazio na planilha → Local padrão |

O `GET /api/meta` agora devolve `defaultLocal: { id, nome }` para o front abrir
os formulários já com o Local padrão pré-selecionado.

## Por que é a melhor forma

- É **centralizado no módulo de Locais** (onde o usuário já gerencia incluir/excluir),
  sem novo módulo.
- A coluna `padrao` é uma flag simples; a regra de "apenas um padrão" é aplicada
  no servidor (`services.ts`), então vale para API, planilha e UI.
- O nome do local padrão é configurável; sem nenhum cadastro ativo, os fluxos
  que criam estoque usam `"loja"` por segurança (**último fallback**), para
  nunca quebrar um banco legado.

## Migração

`db/schema.sql` adiciona `locais.padrao BOOLEAN DEFAULT FALSE` (idempotente) e,
se nenhum local estiver marcado, marca automaticamente o primeiro local ativo
como `padrao`. Portanto, num banco existente a migração acontece no primeiro
`migrate()` ao subir a API.
