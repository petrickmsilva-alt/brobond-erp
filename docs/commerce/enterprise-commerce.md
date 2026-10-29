# Commerce — projeções, checkout e canais

Produto, preço base e saldo têm origem no ERP. Metadados/canais/preço promocional são projeções; preço, regras de cupom e frete são recalculados pelo servidor no preview e checkout. Sem frete configurado o fluxo informa indisponibilidade; o front não declara pagamento. As listas completas do catálogo/vitrine são paginadas internamente e o snapshot PostgreSQL da vitrine evita perder produtos/preços após a primeira página.

`/api/commerce/produtos`, `/publicacoes`, `/promocoes`, `/cupons`, `/pedidos`, `/reservas`, `/fulfillment`, `/delivery` e `/payments` usam os serviços e RBAC existentes; o checkout público usa rate limit, configurações e escopo próprios. Páginas operacionais usam rotas, não modal. A prova PG de Commerce percorre produto → preço → cupom → preview/frete manual → pedido/reserva → webhook de teste → conversão em `vendas`; não é prova do trecho completo WMS/carrier/provedor externo.

Publicação WooCommerce usa credencial do conector da empresa, não segredo global de outra empresa, e pagina consulta remota com limite fail-closed. Despublicação cerca versões/claims locais; não desfaz write externo já enviado. Publicadores/canais restantes exigem credenciais, provas de contrato, retries e homologação. Instagram Shopping não é declarado como publicação individual disponível. PIM, B2B, OMS de ciclo completo, promoção avançada, busca/merchandising e omnichannel ainda são parciais; regras e estoques não são duplicados para mascarar gaps. Consulte a auditoria para os critérios de readiness.

## Catálogo e portal públicos sem sobreposição operacional

`/catalogo/:token` lista produtos; `/catalogo/:token/produto/:id` mostra o detalhe; `/catalogo/:token/pedido` monta e envia a solicitação. O carrinho segue no rascunho local por token, sem ser um pedido financeiro; o resultado é uma confirmação na própria página. Links antigos `#p-<id>` são encaminhados para a rota do produto. `/portal/:token` lista o histórico e `/portal/:token/pedido/:id` contém os itens, decisões e recompra, com confirmação inline antes da chamada. Trocar token desmonta o estado do link anterior. As APIs e a validação no servidor continuam sendo a autoridade.

As exceções operacionais do portal e catálogo foram removidas de `ERP-3.0-UX-BASELINE.json`; `audit:ux` ainda possui exceções de navegação global/menu móvel e um capturador de clique de infraestrutura. Testes de DOM e rotas não substituem ensaio de usabilidade, acessibilidade ou layout em todos os dispositivos.
