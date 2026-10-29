# Operação segura — ondas 1–3

**Não há autorização de go-live integral nesta entrega.** Os comandos abaixo não substituem backup validado, revisão de migração, janela operacional, plano de rollback sem perda e homologação por domínio/fornecedor. Não executar testes em banco de produção.

## Instalação e verificações

1. Confirme commit e empresa, faça backup e ensaie restauração. Verifique que as migrations versionadas até `0077` ainda não têm deriva; aplique-as pelo boot/migrador existente em ambiente isolado antes de produção. Não altere nem regrave dados históricos para fazer o gate passar.
2. `npm test` executa servidor e cliente; o runner de memória pula testes PG por desenho. `DATABASE_URL=<banco novo e vazio> npm run test:pg` exige PostgreSQL **16.14**, `psql` e zero skips; o runner do gate não aceita banco reutilizado. `DATABASE_URL=<banco administrativo de testes> npm run smoke:pg -- --keep` cria e mantém um banco descartável próprio. Não usar URLs/segredos reais em logs ou commits.
3. Execute `npm run typecheck`, `npm run lint`, `npm run build`, `npm run audit:menu`, `npm run audit:ux`, `npm run architecture:audit`, os gates de comércio/pagamentos e `npm audit`. Diferencie verificação estrutural de homologação financeira. Os resultados desta rodada constam no relatório da auditoria.

## Operação de exceções

- **Pagamento tardio:** acesse `/commerce/pagamentos/atrasados`, filtre OPEN e confira empresa, pedido, cobrança e evidência do provider. O pedido permanece cancelado/expirado; não envie nova venda por atalho. Refund integral confirmado fecha a revisão; parcial/incerto permanece aberto. Em legado, o estado histórico `estornada` sozinho não prova valor: Mercado Pago só fecha após consulta que comprova referência, moeda e total integral; outros casos exigem conciliação manual.
- **Operação UNCERTAIN:** não repetir com outra chave nem trocar de provider. A mesma operação permanece ativa; o job consulta o estado do provider e só libera após evidência suficiente. Cancele a automação e escale se a evidência for divergente. O job usa lotes de até 100 intenções, inclusive canceladas/expiradas e operações ativas: monitorar backlog, limites de API e idade, sem SLA de processamento comprovado. Confirmação manual ambígua não possui resolução automática equivalente.
- **Recebimento:** preserve a chave de idempotência e o mesmo corpo após timeout. Reenvio idêntico devolve o mesmo recebimento; mesma chave/corpo diferente retorna 409. Chave histórica sem hash retorna 409: confira documento, entradas e financeiro antes de qualquer nova operação. A prévia não grava.
- **MRP:** selecione intervalo válido de até 730 dias, revise itens sem ficha, ciclos, limite de profundidade, compras sem prazo e OPs sem recurso. É planejamento, não reserva nem pedido de compra; revise dados e reconcilição física antes de comprar.
- **Publicação:** ao despublicar, as versões/claims locais são cercados; se uma chamada externa já saiu, confira o canal e remova/corrija lá se necessário. Não marque manualmente como publicado sem confirmação externa.
- **Período:** o comando `/api/financeiro/periodos/:competencia/fechar` atua somente na escrituração importada. Não anunciar como fechamento contábil/fiscal/financeiro completo. Reabertura é administrativa e auditada.

Migrations `0070`–`0077` são detalhadas na auditoria. Mantenha `backups/`, credenciais, dados de produção, dumps e artefatos gerados fora do commit. Segredos de providers devem ser configurados por responsável autorizado no ambiente de destino, nunca nesta documentação.
