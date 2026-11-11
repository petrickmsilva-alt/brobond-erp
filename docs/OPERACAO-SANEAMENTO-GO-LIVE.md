# Operação — saneamento pré-go-live (dados de homologação)

Rotina controlada para neutralizar os dados **fictícios** de homologação antes da
primeira operação oficial, preservando o **estoque físico real**.

> Esta rotina é um **ato operacional** sobre um banco. Ela é distinta do código:
> o código entrega a ferramenta e as provas; a execução no banco publicado é um
> passo separado, registrado em §"Registro da execução".

## O que é preservado (nunca tocado)

- `estoques` — a posição física por SKU × variante × local (a única posição
  operacional real).
- Cadastros: `produtos`, `tamanhos`, `cores`, `colecoes`, `empresas`, `usuarios`,
  permissões.
- Estrutura financeira: `plano_contas`, `contas_financeiras`, `centros_custo`,
  `categorias`.
- Preços de varejo e atacado (`produtos.preco_venda`, `produtos.preco_atacado`).

Nenhuma constraint, trigger ou mecanismo de auditoria é desabilitado. A limpeza
roda numa **única transação**: ou limpa tudo, ou não limpa nada.

## O que é removido (dados de teste transacionais)

- Vendas: `vendas`, `itens_venda`, `sales`, `sale_items` e satélites (devoluções,
  documentos fiscais nunca transmitidos, histórico de status, atribuição).
- Financeiro: `lancamentos_financeiros`, `gateway_cobrancas`,
  `fin_extrato_transacoes`, comissões/afiliados, transferências financeiras.
- Estoque derivado do teste: movimentações originadas por venda/transferência/
  inventário de teste, `estoque_reservas` (reservas artificiais).
- Commerce/integrações: `commerce_pedidos`, `commerce_outbox` (fila),
  `commerce_reconciliacao`, inbox de webhooks, `connector_events`.
- Pagamentos: `payment_*`, `gateway_webhook_events`.

A lista exata e a ordem de exclusão vivem em `server/src/ops/saneamento.ts`
(`PLANO`, ordem topológica do grafo de FKs; `DESVINCULOS` para as FKs NO ACTION).

## Antes de executar (Fase Zero — bloqueio obrigatório)

1. Identificar o banco/ambiente efetivamente usados pelo ERP publicado.
2. Gerar **backup recuperável** e comprovar integridade, data/hora, tamanho e
   restauração. O dump **não** entra no repositório Git.
3. Produzir a **fotografia do estoque** (o próprio `--dry-run` já imprime a
   fotografia ANTES: empresa, produto, SKU, variante, local, quantidade física,
   reservada, disponível, custo unitário e valor total).

Se não houver backup recuperável nem fotografia, **não executar**.

## Execução

```bash
# 1) Conferência (não altera nada; transação com ROLLBACK):
DATABASE_URL=... npm exec -- node --import tsx scripts/saneamento-go-live.ts --empresas=1

# 2) Execução real (exige backup verificado + confirmação textual):
DATABASE_URL=... node --import tsx scripts/saneamento-go-live.ts \
  --empresas=1 --executar --confirm=LIMPAR-HOMOLOGACAO \
  --backup=/caminho/fora-do-repo/backup-AAAAMMDD.sql --ator="Diretor"
```

- `--empresas` é **obrigatório**: o saneamento nunca é global por omissão.
- `--executar` exige `--confirm=LIMPAR-HOMOLOGACAO` **e** `--backup` existente
  (> 1 KB). Sem isso, a rotina recusa.
- O dry-run prova que o plano aplica limpo (sem bloqueio de FK) sem alterar um
  único byte.

## Depois de executar (Fase Quatro — critério obrigatório)

O script compara a fotografia ANTES e DEPOIS célula a célula (SKU × variante ×
local) e **aborta** se qualquer quantidade física divergir. Nenhuma perda,
duplicação ou alteração inexplicada de estoque é aceita.

Validações esperadas após a execução:

- total de peças físicas idêntico antes/depois;
- reservas de teste removidas (disponível volta a ser o físico);
- custo unitário e valorização preservados;
- vendas, pedidos, itens e eventos de teste zerados;
- fila sem evento executável e sem indeterminado não resolvido;
- cadastros e estrutura financeira intactos.

Se houver diferença, **interromper a homologação e investigar** antes de
prosseguir.

## Registro da execução (preencher ao executar no banco publicado)

| Campo | Valor |
|---|---|
| Data/hora | _pendente_ |
| Ambiente / banco | _pendente_ |
| Identificação da execução | _pendente_ |
| Backup (arquivo, tamanho, hora, restauração verificada) | _pendente_ |
| Empresas saneadas | _pendente_ |
| Linhas removidas por tabela | _pendente_ |
| Quantidades preservadas | _pendente_ |
| Divergências de estoque | _pendente_ |
| Resultado | _pendente_ |

O saneamento no banco publicado **só** ocorre após autorização expressa e
backup comprovado. Não confundir o código entregue com os dados efetivamente
saneados.
