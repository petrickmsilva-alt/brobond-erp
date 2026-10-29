# Arquitetura e invariantes — ondas 1, 2 e 3

Data: 2026-10-29. Esta é uma descrição do código e dos limites observados, não uma certificação de implantação. Leia também `../ERP-MASTER-ARCHITECTURE.md`, `../ERP-3.0-ARCHITECTURE-BASELINE.md`, `../ERP-3.0-GAP-MATRIX.md` e `../BROBOND-ENTERPRISE-WAVES-1-2-3-AUDIT.md`.

## Fontes oficiais e tenancy

- **Empresa** é o tenant; **Usuário** é identidade; o vínculo usuário–empresa determina autorização. Nenhuma capacidade nova usa `organizationId` como tenant. Autorização é aplicada no servidor; ID fornecido pelo browser não seleciona empresa arbitrária.
- Produtos e estoque/movimentos/reservas do ERP são canônicos. `vendas` é a venda operacional; `sales` e `commerce_pedidos` são ingestão/projeção/orquestração. O checkout não cria um segundo estoque, venda operacional, cashbook ou ledger.
- Checkout calcula preço, promoção/cupom e frete no servidor, reserva estoque e cria intenção. A confirmação vem do provider; a ponte converte para `vendas`. Consulta autenticada do provider pode descobrir pagamento após cancelamento/expiração, mas o pedido fechado não é reaberto: uma revisão durável é criada.
- Para um pedido, projeção da conversão usa compare-and-swap (CAS), e callback relê cobrança/pedido em cada transação serializável. O financeiro relê intenção e cobrança antes de baixar o título. Essas guardas reduzem corridas; não provam todos os interleavings, sobretudo os que atravessam serviços externos.
- `payment_operations` e chave no provider cercam comandos; um resultado externo ambíguo mantém `UNCERTAIN` e trava ativa. Refund só é concluído quando o acumulado confirmado cobre o valor solicitado. Captura parcial é bloqueada, pois a projeção atual pressupõe captura integral. Alterações externas simultâneas ainda exigem identificação/conciliação por operação para comprovar atribuição.
- Recebimento de compra serializa por empresa/pedido, tem chave completa e hash do conteúdo, CAS de quantidades, transação de estoque/custo/financeiro e retry **apenas da transação local**. Um prefixo histórico sem hash não prova identidade: falha fechado para conciliação.
- O WMS usa hierarquia no cadastro de locais e os saldos oficiais. MRP é leitura/sugestão, com janela e avisos; não gera compra automaticamente. Publicação da vitrine é projeção: snapshot/cercamento local não desfaz uma solicitação externa já enviada.
- Outbox é **at-least-once**, com lease e versão de fencing para evitar conclusão de claim antigo. Não há garantia exactly-once no provedor remoto. A cadeia de auditoria de versão 2 inclui tenant e tempo, mas sem âncora externa não prova resistência a reescrita integral/truncamento.

## Transações e limites conhecidos

PostgreSQL 16.14 é o banco usado nas provas. Migrations SQL são aditivas; `db/schema.sql` acompanha os novos objetos. Os retries serializáveis não repetem automaticamente uma escrita remota. Fila, locks e testes de três processos demonstram os cenários especificados, não substituem prova de carga, desastre, observabilidade operacional ou consistência de todas as integrações. O fechamento de competência atual protege **somente a escrituração importada**; não bloqueia ainda todos os fatos financeiros, fiscais e de pagamentos.
