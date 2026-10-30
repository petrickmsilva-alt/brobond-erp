# Supply chain — estado e limites

## Compras e estoque

Pedidos, cotação de compra e recebimentos parciais/integrais reutilizam fornecedores, produtos/insumos, estoque e financeiro oficiais. `POST /api/compras/:id/receber` aceita `idempotency_key` no corpo ou `Idempotency-Key`; a chave completa e um SHA-256 do corpo normalizado são persistidos. Repetir corpo/chave é replay; alterá-lo é 409. Chaves históricas gravadas apenas em `documento` são ambíguas e bloqueadas; inclusive a chave padrão antiga longa é buscada pelo prefixo original, não pelo hash novo. `previsao: true` executa cálculo com rollback, sem gravar. O cliente conserva a chave após resposta incerta.

A transação atualiza as quantidades recebidas, estoque/movimentos, custos e contas a pagar quando aplicável. Lock PostgreSQL por empresa/compra, isolamento serializável, retry local e índices protegem os cenários testados; três processos com a mesma chave produziram uma única entrada. Não assumir isso como prova de todas as combinações entre rotinas antigas e mudanças cadastrais.

## WMS, MRP e logística

Hierarquia armazém → zona → endereço é metadata dos locais canônicos, com FK de empresa. Separação, conferência, embalagem, expedição, divergência e inventário existentes são fluxos parciais; putaway dirigido, waves, slotting e replenishment empresariais não estão completos. Não existe segundo saldo WMS.

`GET /api/producao/{capacidade,mrp}?de=AAAA-MM-DD&ate=AAAA-MM-DD` valida janela de até 730 dias. Calendário/feriados, itens, OPs e compras são paginados sem truncamento silencioso; OP fora do horizonte não cobre demanda, consumo é associado à sua OP e compra sem previsão é destacada. BOM multinível detecta ciclos/corte de profundidade e avisa; MRP não cria compras. Leituras não são todas um snapshot único, e consumo não alocado, alocação ótima, lead times, capacidade finita e cenários grandes ainda exigem validação adicional.

Expedição e logística existentes registram remessa/rastreio e possuem contratos de transportadora configuráveis, sem criar sucesso remoto fictício. Não há certificação completa TMS/carriers/etiquetas nem operação real homologada. A devolução testada atualiza o estoque de itens em bom estado e reverte financeiro em devolução total, mas não comprova a cadeia completa de refund eletrônico no provider.

### Closure Pass — cotação e recebimento

A decisão considera todas as páginas da empresa, só propostas válidas, fornecedor e frete. A assinatura da decisão impede replay com dados diferentes; pedidos históricos sem assinatura exigem consulta/revisão. Vencedores de fornecedores distintos são bloqueados, não reunidos em uma compra falsa; ainda não existe desmembramento automático. Em PostgreSQL foi provado o trecho cotação→pedido→aprovação→recebimento→estoque/custo→conta a pagar→baixa e um caso com 501 itens, não o ciclo de requisição completo. Algumas rotas/CRUD legados permitem receber sem aprovação: o processo deve exigir aprovação operacional e o código ainda necessita bloqueio uniforme antes de go-live.
