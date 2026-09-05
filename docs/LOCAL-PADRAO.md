# Local padrão (origem das movimentações)

> Antes, o ERP assumia **"almoxarifado"** como o local de origem padrão das
> movimentações e do Estoque Físico. Isso quebrava em ambientes onde esse local
> não existe. Agora o local de origem é **configurável** e passa a ser chamado de
> **Local padrão**.

## Como funciona

1. **Cadastre os locais** em **Estoque → Locais** (incluir/excluir já era
   suportado). O campo `padrao` (**Local padrão**) é uma coluna nova: marque
   o local que deve ser a origem padrão.

2. **Só pode haver um Local padrão ativo.** Ao marcar um novo como `padrao`,
   o anterior é desmarcado automaticamente. Se você excluir o Local padrão
   (e houver outro local ativo), o primeiro local ativo restante assume a
   função. Se tentar excluir o **único** local ativo, o sistema bloqueia
   (é preciso manter ao menos um local).

3. **Fallback (mesmo sem marcar nada):** se nenhum local estiver marcado como
   `padrao`, o sistema usa o **primeiro local ativo** (por nome); se não houver
   nenhum, usa `"almoxarifado"` por segurança (compatibilidade).

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
- O padrão fixo `"almoxarifado"` deixa de ser usado em todos os fluxos que criam
  estoque; ele permanece apenas como **último recurso** (último fallback) para
  nunca quebrar um banco legado.

## Migração

`db/schema.sql` adiciona `locais.padrao BOOLEAN DEFAULT FALSE` (idempotente) e,
se nenhum local estiver marcado, marca automaticamente o primeiro local ativo
como `padrao`. Portanto, num banco existente a migração acontece no primeiro
`migrate()` ao subir a API.
