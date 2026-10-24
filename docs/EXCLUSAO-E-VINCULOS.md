# Excluir × Cancelar — e por que o ERP recusa a exclusão

Documento curto para quem usa e para quem mantém o ERP. Ele explica **quando**
um registro pode ser excluído, **por que** a exclusão é recusada e **como** o
sistema descobre os vínculos.

> Regra de ouro: **cadastro se desativa; documento se cancela; histórico nunca
> se apaga.**

---

## 1. Resumo em uma tabela

| Situação | O que fazer | O que o ERP faz |
| --- | --- | --- |
| Cadastro **sem uso** (produto, cliente, categoria, fornecedor, local…) | **Excluir** | Remove o registro |
| Cadastro **já usado** em outro módulo | **Desativar** (campo *Ativo*) | Recusa a exclusão e mostra **quem** usa |
| Pedido de venda/compra **em aberto**, sem histórico | **Excluir** | Remove o pedido e os itens |
| Pedido **faturado / recebido** | **Cancelar** (estorna sozinho) | Recusa a exclusão antes de tocar em qualquer coisa |
| Pedido **cancelado** com histórico | **Manter cancelado** | Recusa a exclusão: o histórico é a prova do que aconteceu |
| Ordem de produção **concluída** | **Reabrir ou cancelar** | Recusa a exclusão |
| Transferência entre contas **confirmada** | **Cancelar** (estorna o par) | Recusa a exclusão |

---

## 2. O que mudou na experiência

Antes, a resposta era sempre a mesma:

> “Este registro está em uso em outro módulo e não pode ser excluído.”

Agora o servidor devolve um **diagnóstico de dependências** e a tela abre o
modal **“Ver vínculos”**, com:

- a mensagem explicando **por que** a exclusão está bloqueada;
- os **módulos** que apontam para o registro, com ícone e **quantidade**;
- os **ids** dos registros dependentes (até 20 por vínculo, a contagem é
  sempre exata);
- o **tipo** de cada vínculo — histórico, operacional, composição, trilha,
  anexo — e o **motivo** em português;
- a **orientação** do que fazer no lugar de excluir (cancelar, desativar,
  manter como está).

Exemplo real de uma venda cancelada:

```
Venda cancelada com histórico. A exclusão física não é permitida —
3 registros vinculados em Estoque e Financeiro.

Estoque         2 registros   histórico de movimentação de estoque (saída e estorno)
Financeiro      1 registro    histórico financeiro (contas a receber/pagar)
Itens da venda  1 registro    composição (não impede a exclusão)
Auditoria       5 registros   trilha preservada (não impede a exclusão)
```

Nada é apagado quando o diagnóstico é exibido: a tentativa é recusada dentro da
mesma transação, com *rollback*, e **não** grava evento novo de auditoria.

---

## 3. Como o diagnóstico encontra os vínculos

A camada é única e reutilizável (`server/src/dependencias.ts`), usada por
**qualquer** recurso — vendas, compras, clientes, produtos, categorias,
fornecedores, locais, contas etc. Nada é específico de venda.

### 3.1 PostgreSQL (produção)

As relações de entrada são descobertas no **catálogo do banco**
(`pg_constraint`), não em uma lista escrita à mão:

- toda FK real que aponta para a tabela do registro aparece — inclusive as
  criadas por migrations futuras;
- a **ação referencial** (`ON DELETE NO ACTION / RESTRICT / CASCADE /
  SET NULL`) vem do catálogo e decide se o banco recusaria o `DELETE`;
- a contagem e os ids são lidos da tabela dependente, **sempre** recortados por
  `empresa_id` (ou pela chave composta `empresa_id + id`);
- nomes de tabela e coluna vêm do catálogo e passam por validação antes de
  entrar no SQL; **valores são sempre parâmetros** (`$1`, `$2`…). Nenhum
  fragmento de SQL é montado a partir de input do usuário;
- a operação é **somente leitura**.

Um teste de contrato (`server/test/pg-dependencias.test.ts`) compara o catálogo
real com o mapa declarativo e falha se uma FK nova aparecer — assim o mapa nunca
envelhece em silêncio.

### 3.2 Modo demonstração (memória)

Sem banco, o mesmo diagnóstico usa o mapa declarativo (`resources.ts` +
`RELACOES_FK`): as referências `ref`/`multiref` dos recursos e as FKs que não são
campos de formulário (ex.: `movimentacoes.venda_id`). É o mesmo contrato de
resposta, com `origem: "memoria"`.

### 3.3 Vínculos sem FK (“lógicos”)

Alguns módulos guardam a referência em coluna de texto, sem constraint:

| Vínculo | Coluna | Tratamento |
| --- | --- | --- |
| Financeiro | `lancamentos_financeiros.referencia_tipo` + `referencia_id` | histórico protegido (vendas/compras) |
| Impressão | `print_jobs.source_ref` (`venda:4`, `compra:7`…) | operacional (não bloqueia) |
| Auditoria | `auditoria.recurso` + `registro_id` | trilha (não bloqueia) |
| Anexos | `arquivos.recurso` + `registro_id` | anexos (removidos junto) |

São **relações reais** — nunca uma FK inventada.

---

## 4. O que bloqueia e o que não bloqueia

O diagnóstico classifica cada relação:

| Tipo | Exemplo | Bloqueia? |
| --- | --- | --- |
| **Composição** | itens do pedido, tamanhos da grade | Não — somem junto quando a exclusão é permitida |
| **Histórico** | movimentação de estoque, lançamento financeiro, comissão, devolução, documento fiscal, envio | **Sim** |
| **Operacional** | proposta convertida, pedido multicanal, caixa do local | Depende da política; normalmente sim |
| **Trilha** | auditoria, eventos de impressão | Não |
| **Anexo** | fotos e arquivos do registro | Não |

Além da ação da FK, existe a **política do ERP**: uma relação `ON DELETE
CASCADE` pode ser protegida (por exemplo, pagamentos do PDV, envios e
divergências de conferência de uma venda). A FK até apagaria, mas o ERP **não
permite**: apagar o pedido apagaria a prova do recebimento e da expedição.

A FK continua sendo a **última linha de defesa**. Se algum caminho de código
tentar o `DELETE` mesmo assim, o banco responde `23503` e a camada de serviço
converte o erro no mesmo diagnóstico.

### Exceção: locais

Excluir um **local** é decisão de administrador e **desfaz** o vínculo: saldos,
movimentações e inventários continuam existindo, com o nome do local preservado
como histórico em texto. Por isso, para local, esses vínculos aparecem como
“desfeito na exclusão” e **não** bloqueiam.

---

## 5. Venda cancelada — o caso central

Cancelar **não apaga** nada: o cancelamento estorna estoque, caixa, financeiro e
comissão criando os lançamentos inversos e mantendo os originais. Por isso uma
venda cancelada tem, tipicamente, estes vínculos reais:

| Relação | FK no PostgreSQL | Por que bloqueia |
| --- | --- | --- |
| `itens_venda` | `ON DELETE CASCADE` | composição — não bloqueia |
| `movimentacoes` (saída + estorno) | `NO ACTION` (composta com `empresa_id`) | histórico de estoque |
| `lancamentos_financeiros` | vínculo lógico (`referencia_tipo = 'venda'`) | histórico financeiro |
| `comissoes_eventos` | `NO ACTION` | comissão do representante |
| `devolucoes` | `NO ACTION` | histórico de devolução |
| `gateway_cobrancas` | `NO ACTION` | cobrança do gateway |
| `pdv_pagamentos`, `pdv_caixa_movimentos` | `ON DELETE CASCADE` | **protegido por política** (caixa) |
| `envios`, `expedicao_eventos`, `divergencias_conferencia` | `ON DELETE CASCADE` | **protegido por política** (expedição) |
| `documentos_fiscais`, `propostas`, `sales` | `ON DELETE SET NULL` | **protegido por política** (fiscal/comercial) |
| `auditoria` | vínculo lógico | trilha — não bloqueia |

Resposta ao tentar excluir:

```
409 Conflict
{
  "error": "Venda cancelada com histórico. A exclusão física não é permitida — 3 registros vinculados em Estoque e Financeiro.",
  "code": "dependencias_vinculadas",
  "details": { "dependencias": { ... } }
}
```

E a orientação mostrada na tela: **“Este pedido deve permanecer como CANCELADO.
A exclusão física não é permitida porque existem registros históricos
vinculados.”**

---

## 6. Multiempresa

- O registro-alvo é lido **no escopo da empresa ativa** do usuário; registro de
  outra empresa responde **404** (não 403), para não revelar a existência do id.
- Toda contagem é recortada por `empresa_id` — inclusive quando a FK não carrega
  a empresa (defesa em profundidade).
- Os ids devolvidos são apenas da empresa ativa.
- Teste com PostgreSQL real cobre o caso: vínculos e ids da empresa B não
  aparecem no diagnóstico da empresa A.

---

## 7. API

### `GET /api/:resource/:id/dependencias`

Somente leitura. Exige a mesma permissão de leitura do recurso.

```json
{
  "recurso": "vendas",
  "id": 4,
  "empresaId": 1,
  "origem": "postgresql",
  "bloqueado": true,
  "podeExcluir": false,
  "titulo": "Não é possível excluir Pedido de venda #4",
  "resumo": "Venda cancelada com histórico. …",
  "orientacao": "Este pedido deve permanecer como CANCELADO. …",
  "totalRegistros": 9,
  "totalBloqueantes": 3,
  "modulos": ["Estoque", "Financeiro", "Itens da venda", "Auditoria"],
  "modulosBloqueantes": ["Estoque", "Financeiro"],
  "vinculos": [
    {
      "modulo": "Estoque",
      "tabela": "movimentacoes",
      "colunas": ["empresa_id", "venda_id"],
      "recurso": "movimentacoes",
      "quantidade": 2,
      "ids": [12, 13],
      "idsTruncados": false,
      "tipo": "historico",
      "acao": "NO_ACTION",
      "impeditivo": true,
      "protegido": false,
      "bloqueia": true,
      "motivo": "histórico de movimentação de estoque (saída e estorno do pedido)"
    }
  ],
  "geradoEm": "2026-10-24T12:00:00.000Z"
}
```

### `DELETE /api/:resource/:id`

- **200** `{ "ok": true }` quando não há vínculo bloqueante;
- **409** `{ error, code: "dependencias_vinculadas", details: { dependencias } }`
  quando há — e **nada** é apagado.

---

## 8. O que NÃO mudou

- Nenhuma FK foi removida e nenhum `ON DELETE CASCADE` novo foi criado.
- Não existe exclusão forçada (“force delete”).
- Cancelamento e estorno continuam exatamente como estavam (nenhuma linha da
  lógica de estorno foi alterada).
- A numeração automática do ERP não mudou: o `#id` interno (`Pedido ERP #004`)
  continua separado do **Nº do pedido no cliente** (campo externo).
- Nenhuma migration foi necessária.
- A auditoria da exclusão bem-sucedida continua sendo **um** evento; a tentativa
  bloqueada não gera evento duplicado.

---

## 9. Onde está o código

| Arquivo | Papel |
| --- | --- |
| `server/src/dependencias.ts` | classificação, mapa de relações, montagem do diagnóstico |
| `server/src/pgstore.ts` | descoberta das FKs no catálogo + contagens por empresa |
| `server/src/memdb.ts` | mesmo contrato no modo demonstração |
| `server/src/services.ts` | `diagnosticarDependencias()` e a guarda antes do `DELETE` |
| `server/src/index.ts` | `GET /api/:resource/:id/dependencias` e `details` no erro |
| `client/src/components/DependenciasModal.tsx` | modal “Ver vínculos” |
| `client/src/pages/ModulePage.tsx` | abre o modal no 409 (em vez do toast genérico) |

Testes: `server/test/dependencias.test.ts` (cenários A–F, modo memória),
`server/test/pg-dependencias.test.ts` (catálogo, FK 23503, multiempresa) e
`client/src/components/DependenciasModal.test.tsx`.
