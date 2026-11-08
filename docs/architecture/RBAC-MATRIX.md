# RBAC-MATRIX — matriz de permissões por domínio

**Data:** 2026-11-07 · **Branch:** `architecture/fase-1-foundation`
**Fonte:** gerada do código real (`server/src/resources.ts`) — não digitada à mão.

## 1. Modelo de autorização

Três perfis, com rank crescente (`server/src/services.ts`, `PERFIL_RANK`):

| Perfil | Rank | Papel |
|---|---|---|
| `operador` | 1 | operação do dia a dia; não exclui registros |
| `gerente` | 2 | cadastros e fluxos gerenciais |
| `admin` | 3 | administração, segurança, MFA obrigatório |

Regras aplicadas por `checkAccess(r, actor, op)`:

1. **`adminOnly`** → só admin.
2. **`minPerfil`** → perfil mínimo para **ler e operar** o recurso.
3. **`minPerfilEscrita`** → piso só para **escrita** (leitura permanece aberta
   para telas operacionais que usam `/options`); usado no catálogo global
   (categorias, cores, grades, tamanhos).
4. **`ops`** → o que o CRUD genérico (`POST/PUT/DELETE /api/:recurso`) permite;
   `ops` fechado força o fluxo por endpoint próprio.
5. **Operador nunca exclui** (403).
6. **Permissões comerciais** (`podeComercial`/`exigirComercial`) recortam
   catálogos, políticas e carteira do representante.

> **O perfil vem sempre da identidade autenticada** — nunca de `role` ou
> `empresa_id` enviados pelo cliente.

## 2. Matriz por recurso (177 recursos)

Colunas: **Recurso** · **Perfil mínimo** (regra de acesso) · **Ops** (C=incluir,
U=alterar, D=excluir no CRUD genérico; `-` = somente leitura) · **Tabela** ·
**Empresa** (recurso multiempresa).

| Recurso | Perfil minimo | Ops | Tabela | Empresa |
|---|---|---|---|---|
| `affiliate_commissions` | gerente | - | affiliate_commissions | sim |
| `ai_executions` | gerente | - | ai_executions | sim |
| `ai_prompts` | admin | CUD | ai_prompts | sim |
| `ai_providers` | admin | CUD | ai_providers | sim |
| `ai_recommendations` | gerente | CUD | ai_recommendations | sim |
| `aportes` | gerente | CUD | aportes | sim |
| `arquivos` | operador+ (leitura) | - | arquivos | - |
| `auditoria` | admin | - | auditoria | sim |
| `bi_read_models` | gerente | - | bi_read_models | sim |
| `catalogo_compartilhamentos` | operador+ (leitura) | - | catalogo_compartilhamentos | - |
| `catalogo_eventos` | operador+ (leitura) | - | catalogo_eventos | - |
| `catalogos` | gerente | CUD | catalogos | sim |
| `categorias` | leitura aberta / escrita gerente | CUD | categorias | - |
| `categorias_financeiras` | gerente | CUD | categorias_financeiras | sim |
| `categorias_insumos` | operador+ (leitura) | CUD | categorias_insumos | sim |
| `centros_custo` | gerente | CUD | centros_custo | sim |
| `clientes` | operador+ (leitura) | CUD | clientes | sim |
| `colecoes` | operador+ (leitura) | CUD | colecoes | sim |
| `commerce_configuracoes` | gerente | CU | commerce_configuracoes | sim |
| `commerce_cupons` | gerente | CUD | commerce_cupons | sim |
| `commerce_notificacoes` | gerente | - | commerce_notificacoes | sim |
| `commerce_outbox` | gerente | - | commerce_outbox | sim |
| `commerce_pedidos` | operador+ (leitura) | - | commerce_pedidos | sim |
| `commerce_precos` | leitura aberta / escrita gerente | - | commerce_precos | sim |
| `commerce_produtos` | leitura aberta / escrita gerente | - | commerce_produtos | sim |
| `commerce_promocoes` | gerente | CUD | commerce_promocoes | sim |
| `commerce_publicacoes` | gerente | - | commerce_publicacoes | sim |
| `commerce_rastreio` | operador+ (leitura) | CU | commerce_rastreio | sim |
| `compra_recebimento_itens` | operador+ (leitura) | - | compra_recebimento_itens | sim |
| `compra_recebimentos` | operador+ (leitura) | - | compra_recebimentos | sim |
| `compras` | operador+ (leitura) | CUD | compras | sim |
| `contas_financeiras` | gerente | CUD | contas_financeiras | sim |
| `cores` | leitura aberta / escrita gerente | CUD | cores | - |
| `cotacao_compra_fornecedores` | operador+ (leitura) | - | cotacao_compra_fornecedores | sim |
| `cotacao_compra_itens` | operador+ (leitura) | - | cotacao_compra_itens | sim |
| `cotacao_compra_precos` | operador+ (leitura) | - | cotacao_compra_precos | sim |
| `cotacao_decisoes` | operador+ (leitura) | - | cotacao_decisoes | - |
| `cotacoes_compra` | operador+ (leitura) | CUD | cotacoes_compra | sim |
| `creator_attributions` | operador+ (leitura) | - | creator_attributions | sim |
| `creator_campaigns` | operador+ (leitura) | - | creator_campaigns | sim |
| `creator_commands` | operador+ (leitura) | - | creator_commands | sim |
| `creator_matches` | operador+ (leitura) | - | creator_matches | sim |
| `creator_outreach` | operador+ (leitura) | - | creator_outreach | sim |
| `creator_partnerships` | operador+ (leitura) | - | creator_partnerships | sim |
| `creator_profiles` | operador+ (leitura) | - | creator_profiles | sim |
| `crm_atividades` | gerente | CUD | crm_atividades | sim |
| `crm_campanhas` | gerente | CUD | crm_campanhas | sim |
| `crm_estagio_historico` | gerente | - | crm_oportunidade_estagio_historico | sim |
| `crm_etapas` | gerente | CUD | crm_etapas | sim |
| `crm_funis` | gerente | CUD | crm_funis | sim |
| `crm_leads` | gerente | CUD | crm_leads | sim |
| `crm_motivos_perda` | gerente | CUD | crm_motivos_perda | sim |
| `crm_oportunidades` | gerente | CUD | crm_oportunidades | sim |
| `crm_origens` | gerente | CUD | crm_origens | sim |
| `customer_consents` | gerente | CUD | customer_consents | sim |
| `customer_preferences` | gerente | CUD | customer_preferences | sim |
| `customer_segments` | gerente | CUD | customer_segments | sim |
| `demand_forecasts` | gerente | - | demand_forecasts | sim |
| `devolucao_itens` | operador+ (leitura) | - | devolucao_itens | sim |
| `devolucao_fornecedor_eventos` | gerente | - | devolucao_fornecedor_eventos | sim |
| `devolucao_fornecedor_itens` | gerente | - | devolucao_fornecedor_itens | sim |
| `devolucoes` | operador+ (leitura) | - | devolucoes | sim |
| `devolucoes_fornecedor` | gerente | - | devolucoes_fornecedor | sim |
| `divergencias_conferencia` | operador+ (leitura) | U | divergencias_conferencia | sim |
| `documentos_fiscais` | operador+ (leitura) | - | documentos_fiscais | sim |
| `documentos_fiscais_eventos` | operador+ (leitura) | - | documentos_fiscais_eventos | sim |
| `empresa_fiscal_config` | admin | - | empresa_fiscal_config | - |
| `empresas` | admin | CUD | empresas | - |
| `envio_eventos` | operador+ (leitura) | - | envio_eventos | sim |
| `envio_ocorrencias` | gerente | CUD | envio_ocorrencias | sim |
| `envios` | gerente | U | envios | sim |
| `epm_assets` | gerente | CUD | epm_assets | sim |
| `epm_budgets` | gerente | CUD | epm_budgets | sim |
| `epm_project_tasks` | gerente | CUD | epm_project_tasks | sim |
| `epm_projects` | gerente | CUD | epm_projects | sim |
| `epm_scenarios` | gerente | CUD | epm_scenarios | sim |
| `equipe_membros` | operador+ (leitura) | CUD | equipe_membros | sim |
| `equipes_comerciais` | operador+ (leitura) | CUD | equipes_comerciais | sim |
| `estoque_insumos` | operador+ (leitura) | U | estoque_insumos | sim |
| `estoque_reservas` | gerente | - | estoque_reservas | sim |
| `estoque_transferencia_eventos` | gerente | - | estoque_transferencia_eventos | sim |
| `estoque_transferencia_itens` | gerente | - | estoque_transferencia_itens | sim |
| `estoque_transferencias` | gerente | - | estoque_transferencias | sim |
| `estoques` | operador+ (leitura) | CUD | estoques | sim |
| `expedicao_eventos` | operador+ (leitura) | - | expedicao_eventos | sim |
| `feriados` | gerente | CUD | feriados | sim |
| `fichas` | operador+ (leitura) | CUD | fichas_tecnicas | sim |
| `fin_importacoes_contabeis` | gerente | - | fin_importacoes_contabeis | sim |
| `fin_periodos_contabeis` | gerente | - | fin_periodos_contabeis | sim |
| `fiscal_execucao_evidencias` | gerente | - | fiscal_execucao_evidencias | sim |
| `fiscal_execucoes` | gerente | - | fiscal_execucoes | sim |
| `fiscal_obrigacao_entregas` | operador+ (leitura) | - | fiscal_obrigacao_entregas | sim |
| `fiscal_obrigacoes` | gerente | CUD | fiscal_obrigacoes | sim |
| `fornecedor_contatos` | operador+ (leitura) | CUD | fornecedor_contatos | sim |
| `fornecedor_documentos` | operador+ (leitura) | CUD | fornecedor_documentos | sim |
| `fornecedor_homologacao_eventos` | operador+ (leitura) | - | fornecedor_homologacao_eventos | sim |
| `fornecedor_scorecards` | gerente | - | fornecedor_scorecards | sim |
| `fornecedores` | operador+ (leitura) | CUD | fornecedores | sim |
| `grade_tamanhos` | operador+ (leitura) | - | grade_tamanhos | - |
| `grades` | leitura aberta / escrita gerente | CUD | grades | - |
| `importacoes_nfe` | operador+ (leitura) | - | importacoes_nfe | sim |
| `impostos_ncm` | gerente | CUD | impostos_ncm | - |
| `insumos` | operador+ (leitura) | CUD | insumos | sim |
| `inutilizacoes_fiscais` | gerente | - | inutilizacoes_fiscais | sim |
| `inventarios` | operador+ (leitura) | CU | inventarios | sim |
| `investidores` | gerente | CUD | investidores | sim |
| `itens_compra` | operador+ (leitura) | - | itens_compra | sim |
| `itens_ficha_tecnica` | operador+ (leitura) | - | itens_ficha_tecnica | sim |
| `itens_inventario` | operador+ (leitura) | - | itens_inventario | sim |
| `itens_ordem` | operador+ (leitura) | - | itens_ordem | sim |
| `itens_venda` | operador+ (leitura) | - | itens_venda | sim |
| `lancamentos_financeiros` | gerente | CUD | lancamentos_financeiros | sim |
| `lista_preco_itens` | operador+ (leitura) | - | lista_preco_itens | sim |
| `listas_preco` | gerente | CUD | listas_preco | sim |
| `listas_preco_historico` | operador+ (leitura) | - | listas_preco_historico | sim |
| `locais` | operador+ (leitura) | CUD | locais | sim |
| `loyalty_movements` | gerente | - | loyalty_movements | sim |
| `loyalty_programs` | gerente | CUD | loyalty_programs | sim |
| `loyalty_tiers` | gerente | CUD | loyalty_tiers | sim |
| `marketing_automation_runs` | gerente | - | marketing_automation_runs | sim |
| `marketing_automations` | gerente | CUD | marketing_automations | sim |
| `medida_valores` | operador+ (leitura) | - | medida_valores | - |
| `medidas` | operador+ (leitura) | - | medidas | - |
| `metas` | operador+ (leitura) | CUD | metas | sim |
| `movimentacoes` | operador+ (leitura) | C | movimentacoes | sim |
| `movimentacoes_insumos` | operador+ (leitura) | C | movimentacoes_insumos | sim |
| `ordens` | operador+ (leitura) | CUD | ordens_fabricacao | sim |
| `ordens_apontamentos` | operador+ (leitura) | - | ordens_apontamentos | sim |
| `ordens_eventos` | operador+ (leitura) | - | ordens_eventos | sim |
| `pdv_caixa_movimentos` | operador+ (leitura) | - | pdv_caixa_movimentos | sim |
| `pdv_caixas` | gerente | - | pdv_caixas | sim |
| `pdv_pagamentos` | operador+ (leitura) | - | pdv_pagamentos | sim |
| `plano_contas` | gerente | CUD | plano_contas | sim |
| `planos_comissao` | gerente | CUD | planos_comissao | sim |
| `politicas_comerciais` | gerente | CUD | politicas_comerciais | sim |
| `portal_acessos` | operador+ (leitura) | - | portal_acessos | - |
| `print_agent_nonces` | operador+ (leitura) | - | print_agent_nonces | sim |
| `print_agents` | operador+ (leitura) | - | print_agents | sim |
| `print_jobs` | operador+ (leitura) | - | print_jobs | sim |
| `print_pairing_codes` | operador+ (leitura) | - | print_pairing_codes | sim |
| `print_terminals` | operador+ (leitura) | - | print_terminals | sim |
| `producao_recursos` | operador+ (leitura) | CUD | producao_recursos | sim |
| `produto_composicao` | operador+ (leitura) | CUD | produto_composicao | sim |
| `produto_fornecedor_skus` | operador+ (leitura) | CU | produto_fornecedor_skus | sim |
| `produtos` | operador+ (leitura) | CUD | produtos | sim |
| `proposta_eventos` | operador+ (leitura) | - | proposta_eventos | sim |
| `proposta_itens` | operador+ (leitura) | - | proposta_itens | sim |
| `propostas` | operador+ (leitura) | CD | propostas | sim |
| `recorrencias_financeiras` | gerente | CUD | recorrencias_financeiras | sim |
| `regras_comissao` | gerente | CUD | regras_comissao | sim |
| `regras_fiscais` | gerente | CUD | regras_fiscais | sim |
| `representante_cliente` | operador+ (leitura) | CUD | representante_cliente | sim |
| `representante_hierarquia` | operador+ (leitura) | CUD | representante_hierarquia | sim |
| `representantes` | operador+ (leitura) | CUD | representantes | sim |
| `sale_items` | operador+ (leitura) | - | sale_items | - |
| `sales` | operador+ (leitura) | - | sales | sim |
| `service_sla_politicas` | gerente | CUD | service_sla_politicas | sim |
| `service_ticket_categorias` | gerente | CUD | service_ticket_categorias | sim |
| `service_ticket_interacoes` | gerente | - | service_ticket_interacoes | sim |
| `service_tickets` | gerente | CUD | service_tickets | sim |
| `sop_scenarios` | gerente | CUD | sop_scenarios | sim |
| `supply_plans` | gerente | CUD | supply_plans | sim |
| `tamanhos` | leitura aberta / escrita gerente | CUD | tamanhos | - |
| `terceirizacao_eventos` | operador+ (leitura) | - | terceirizacao_eventos | sim |
| `terceiros_operacionais` | gerente | CU | terceiros_operacionais | sim |
| `territorios` | operador+ (leitura) | CUD | territorios | sim |
| `transferencias_financeiras` | gerente | CUD | transferencias_financeiras | sim |
| `unidade_conversoes` | gerente | CUD | unidade_conversoes | sim |
| `unidades_medida` | gerente | CUD | unidades_medida | sim |
| `usuario_empresas` | admin | CUD | usuario_empresas | - |
| `usuarios` | admin | CUD | usuarios | - |
| `venda_atribuicao` | operador+ (leitura) | CUD | venda_atribuicao | sim |
| `vendas` | operador+ (leitura) | CUD | vendas | sim |
| `woocommerce_product_links` | operador+ (leitura) | - | woocommerce_product_links | sim |
| `woocommerce_reconciliacao_divergencias` | operador+ (leitura) | - | woocommerce_reconciliacao_divergencias | sim |
| `woocommerce_sync_state` | operador+ (leitura) | - | woocommerce_sync_state | sim |
| `woocommerce_webhook_events` | operador+ (leitura) | - | woocommerce_webhook_events | sim |


> Matriz gerada por `server/src/resources.ts`; regenerar com o comando documentado no `README.md` do diretório.
