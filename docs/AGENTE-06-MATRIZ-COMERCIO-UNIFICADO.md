# Agente 06 — Matrizes do comércio unificado

**Base:** `f432ca17be6a68307f4bc0ddebf927a1e02d0774`
**Legenda:** **Sim** = caminho implementado e localizado; **Parcial** = existe, mas com lacuna/ressalva; **Não** = caminho ausente; **N/A** = não se aplica ao desenho. Os IDs A06-xx remetem ao relatório de achados.

## 1. Matriz por origem comercial

| Etapa | Loja Própria `BROBOND` | Woo `RETAIL` | Woo `WHOLESALE` | Woo single-store legado | Marketplace/conector | Representante |
|---|---|---|---|---|---|---|
| Catálogo único `produtos` | Sim | Sim | Sim | Sim | Sim, por casamento SKU/variação | Sim |
| Preço-base | `preco_venda` + `commerce_precos.BROBOND` | `preco_venda` + override `WOOCOMMERCE` | `preco_atacado` + override `WOOCOMMERCE` | `preco_venda` ou `preco_atacado` pelo canal | Preço real recebido | Preço/lista/política da venda |
| Independência de promoção por loja | N/A | **Parcial:** override compartilhado com WHOLESALE (A06-12) | **Parcial:** mesmo override de RETAIL (A06-12) | N/A | N/A | N/A |
| Quantidade mínima de atacado | N/A | N/A | **Parcial:** só metadado `_brobond_atacado_min_qtd`; consumer externo não evidenciado (A06-11) | Não há enforcement no ERP | N/A | Regras comerciais do ERP |
| Estoque/disponível | Pai+tamanho, reservas, melhor local | **Parcial:** filho consultado no lugar do pai (A06-04) | **Parcial:** mesmo defeito | **Não canônico:** físico sem reservas e soma locais (A06-02) | Reserva/consumo pelo fluxo quando aplicável | Motor canônico no faturamento |
| Checkout/origem | `/loja`, total no servidor | Pedido criado no Woo e importado | Pedido criado no Woo e importado | Pedido criado no Woo e importado | Webhook/API oficial | Pedido manual no ERP |
| Pedido analítico `sales` | Sim | **Não** (A06-05) | **Não** (A06-05) | **Não** (A06-05) | Sim | Projetado após faturamento |
| Projeção `commerce_pedidos` | Sim | Não | Não | Não | Sim | Não |
| Pedido operacional `vendas` | Sim, após conversão | Sim, em `cotacao` | Sim, em `cotacao` | Sim, em `cotacao` | Sim, pela ponte | Sim |
| Identificador externo | `BROBOND`/referência do checkout | `WOOCOMMERCE_RETAIL` | `WOOCOMMERCE_WHOLESALE` | `WOOCOMMERCE` | Canal do conector | N/A |
| Canal operacional | Não grava `site_varejo` no checkout nativo; origem BROBOND na `sale` | `site_varejo` | `site_atacado` | `site_varejo`/`site_atacado` | `marketplace` | `representante` |
| Idempotência | Checkout + pagamento + conversão | Índice por loja, **mas colide com legado** (A06-03) | Índice por loja, **mas colide com legado** (A06-03) | `WOO-<id>` | Upsert e ponte idempotente | Regras de status/conversão |
| Reserva antes de cobrança | Sim | Não no ERP; pedido entra para conferência | Não no ERP | Não no ERP | Quando originado em checkout; marketplace externo segue ingestão | Não obrigatória no pedido manual |
| Pagamento | Payment Engine/webhook | Confirmado no Woo; financeiro ERP após faturamento | Confirmado no Woo; financeiro ERP após faturamento | Idem legado | Status do conector + financeiro após conversão | Financeiro por faturamento/recebimento |
| Faturamento/baixa | Automático após pagamento/conversão | Manual na Venda | Manual na Venda | Manual na Venda | Automático na ponte | Manual na Venda |
| Preço persistido no item | Preço confirmado no checkout | **Remoto tem precedência indevida** (A06-01) | **Remoto tem precedência indevida** (A06-01) | Mesma ressalva | Preço real do item recebido | Preço autorizado no ERP |
| BI Meu Negócios | `sales` original | **Ausente mesmo após faturamento** (A06-05) | **Ausente mesmo após faturamento** (A06-05) | **Ausente** (A06-05) | `sales` original | Projetado como `BROBOND`, sem canal próprio (A06-10) |
| Comissão | Se houver representante na venda | Se atribuído manualmente | Se atribuído manualmente | Se atribuído manualmente | Se atribuído | Sim; divisão é inconsistente (A06-06) |
| Interface administrativa | Commerce + Pedidos | Seção Woo em Fila & Sync + Vendas | Mesma seção + Vendas | Rotas legadas + Vendas | Conectores + Commerce Pedidos | Vendas/Representantes/Comissões |
| Homologação externa evidenciada | Não, somente local/PG | Não | Não | Não | Não | N/A |

## 2. Loja Própria × RETAIL × WHOLESALE: o que está unificado e o que não está

| Dimensão | Resultado da leitura cruzada |
|---|---|
| Produto e estoque | Uma fonte de cadastro, mas três leituras nem sempre equivalentes: nativa canônica, Multi-Store com erro de variação e legado com físico bruto. |
| Preço | Bases corretas por loja na publicação; importação Woo aceita preço remoto. Override `commerce_precos.WOOCOMMERCE` não distingue RETAIL/WHOLESALE. |
| Pedido | BROBOND usa `sales → commerce_pedidos → vendas`; RETAIL/WHOLESALE usam `Woo → vendas`. Não há modelo analítico próprio para Woo. |
| Pagamento | BROBOND usa Payment Engine; Woo usa o pagamento da plataforma e o ERP recebe o pedido para operação/faturamento. |
| Identidade | `BROBOND` é enum analítico; `RETAIL`/`WHOLESALE` são `store_key`/canal externo; `site_varejo`/`site_atacado` são texto operacional. |
| Domínio público | Código e rótulos associam tanto a loja nativa quanto RETAIL a `brobond.com.br`. O repositório não contém decisão de DNS/edge que explique se são experiências distintas ou a mesma loja. |
| Operação | BROBOND automatiza pagamento/conversão; pedidos Woo ficam em cotação para ação humana. |
| Conclusão | Existe catálogo compartilhado e integração por loja, mas não um fechamento único de canal, analítica e operação. Ver A06-10. |

## 3. Representantes × vendas × comissões

| Cenário | Atribuição | Apuração | Recebimento/efetivação | Cancelamento/estorno | Resultado |
|---|---|---|---|---|---|
| Venda sem representante | Nenhum | Não há comissão | Nenhum evento | Nada a estornar | Suportado |
| Um representante, sem plano | `vendas.representante_id` | Percentual do cadastro congelado no faturamento ou apuração explícita | Proporcional ao recebimento, limitado ao valor da venda | Evento de estorno | Suportado pelos testes existentes |
| Um representante, com plano/regra | Principal em `venda_atribuicao` ou campo da venda | Regra por item, vigência, escopo e prioridade em `comissoes_apuradas` | Livro lê valor do principal na venda | Livro estorna o efetivado | Caminho principal suportado |
| Principal + secundário | Participações somam até 100% | Motor retorna total por todos | **Somente principal entra no livro/relatório** | Secundário não possui livro próprio | **Falha A06-06** |
| Reapuração antes de receber | Apurações anteriores viram `estornada` | Novo valor do principal é gravado na venda | Recebimento posterior usa o novo valor | Histórico preservado | Suportado para principal |
| Reapuração depois de recebimento integral | Novas linhas de apuração | Campo da venda muda | **Nenhum novo recebimento é criado; diferença pode ficar pendente** | Requer reconciliação | **Falha A06-06** |
| Venda faturada | Atribuição não pode ser alterada pelo CRUD | Apuração explícita gerente/admin | Recebimento efetiva | Cancelamento estorna | Regra localizada |
| Representante desativado | Histórico permanece | Venda antiga preserva referência | Eventos antigos permanecem | Histórico preservado | Suportado |
| Operador consulta comissões | N/A | Menu exige gerente | **API responde 200 para operador** | N/A | **Falha A06-07** |
| Representante acessa somente próprios dados | `usuario_id` opcional no cadastro | Não há perfil/escopo próprio | Não há portal de comissão do representante | N/A | **Não implementado como papel RBAC** |

## 4. Matriz RBAC e tenant

| Superfície | Autenticação/alçada | Escopo encontrado | Avaliação |
|---|---|---|---|
| Vendas/representantes | Usuário autenticado; regras genéricas | `empresa_id` nos recursos | Cobertura PG existente |
| Planos/regras de comissão | Gerente/admin | Empresa do ator | Coerente com menu |
| Apurar comissão | Gerente/admin explícito + update Vendas | Empresa do ator | Coerente |
| Resumo/livro de comissões | Somente `checkAccess` de leitura Vendas/Representantes | Empresa do ator | **Operador autorizado indevidamente** (A06-07) |
| Ação Woo por loja | Gerente/admin + `exigirStoreDaEmpresa` | Empresa e loja | Coerente |
| Painel Woo agregado | Gerente/admin | Consulta dados da empresa, mas configuração/conexão das duas lojas | **Sem filtro por dono** (A06-09) |
| Webhook Woo | HMAC por loja; sem sessão por contrato | Empresa resolvida pela loja | Fail-closed sem segredo |
| Vitrine pública | Sem sessão por contrato | Env ou única configuração | Ambiguidade falha fechado |
| Acompanhamento `/loja/pedidos/:token` | Token de 64 hex | Empresa da vitrine + token | Mesma 404 para outro tenant |
| Conectores | Gerente/admin conforme rota | Empresa + usuário responsável | Testes de tenant existentes |

## 5. Estoque × variação × canal

| Caso | Motor canônico | Multi-Store Woo | Legado Woo |
|---|---|---|---|
| Produto simples | Pai/produto + tamanho + local | Usa disponibilidade canônica | Soma físico por produto/local textual |
| Variação filha com SKU próprio | Preço/SKU no filho; saldo no pai+tamanho | Consulta saldo pelo filho | Procura SKU/tamanho no mapa de físico |
| Reserva ativa | Reduz disponível | Reduz disponível | **Não reduz** |
| Empenho/bloqueio | Reduz disponível via `estoque_reservas` | Reduz disponível | **Não reduz** |
| Dois locais vendáveis | Melhor célula por tamanho/linha | Segue o motor | **Soma células**, podendo prometer mais que uma linha consegue baixar |
| Variação sem saldo no filho e 12 no pai | 12 vendáveis | **0 publicado** (A06-04) | Pode enviar 12 se o SKU casar, mas sem reservas |
| Baixa | Faturamento/conversão | Faturamento manual da Venda | Faturamento manual da Venda |

## 6. Cobertura de aceite por jornada

| Jornada | Evidência local | Lacuna que impede aceite |
|---|---|---|
| BROBOND catálogo → checkout → pagamento → reserva → venda → financeiro | Testes memória/PG e smoke PG 398/398 | Sem homologação externa/produção; falhas Woo não são cobertas por esse caminho |
| RETAIL publicação → pedido → Venda | Mocks + constraints PG | Preço remoto, variação, analítica e colisão legada |
| WHOLESALE publicação → mínimo → pedido → Venda | Mocks de preço/metadado + constraints PG | Mesmas falhas + enforcement externo do mínimo não demonstrado |
| Marketplace ingestão → pedido → venda | Testes PG da ponte | Recuperação de item sem match não funciona com cabeçalho inalterado |
| Representante → venda → apuração → recebimento → estorno | Testes memória/PG para principal | Secundários, reapuração pós-recebimento e RBAC do relatório |
| Multiempresa Woo | Testes PG/MemStore para ações individuais | Painel agregado expõe configuração/conexão da outra loja |
| Go-live externo | Nenhum teste remoto autorizado | Credenciais, DNS, plugin, webhooks e contratos reais não verificados |

## 7. Decisão da matriz

A arquitetura possui bons componentes canônicos e caminhos reais, mas a equivalência entre canais não fecha. O aceite não deve ser dado por etapa isolada de publicação ou por testes estruturais: os pontos de quebra estão exatamente nas transições **variação → estoque externo**, **pedido externo → preço operacional**, **venda externa → BI**, **atribuição → efetivação**, **erro de catálogo → reprocessamento** e **tenant → painel agregado**.
