# BROBOND ERP 3.0 — AUDITORIA DE MASTER DATA E QUALIDADE DE CAMPOS

> **Escopo:** os cadastros que servem de base para todos os demais módulos
> (produtos, insumos, clientes, fornecedores, locais, catálogo compartilhado,
> financeiro, fiscal, produção e CRM), incluindo os cadastros criados nesta
> evolução. Cada item responde: **onde mora o dado, quem manda, o que é
> obrigatório, o que é único, o que tem ciclo de vida e o que é derivado.**

- **Data:** 2026-10-27 · **Branch:** `arena/72895db5-brobond-erp`
- **Fonte:** `server/src/resources.ts` (116 recursos), `db/schema.sql` +
  `db/migrations/0001..0056`, `server/src/services.ts` (validações),
  `docs/ERP-3.0-ARCHITECTURE-INVENTORY.json`.

---

## 1. Modelo de master data do ERP (regras gerais)

| Regra | Como está implementado |
| --- | --- |
| **Tenant = Empresa** | `empresa_id` em 111 das 131 tabelas; o servidor carimba a empresa do **ator** e ignora `empresa_id` do corpo (`test/tenant-isolamento-3-0.test.ts`) |
| **Usuário = identidade** | `usuario_id`/`responsavel_id` **nunca** recortam empresa — são autoria, não tenant |
| **Nada é apagado quando é histórico** | Cadastro em uso é **desativado** (`ativo=false`); exclusão só quando não há vínculo (diagnóstico 409 com lista de vínculos) |
| **Nome é obrigatório e buscável** | Todo cadastro tem `nome` (ou `codigo`) `required: true`, `search: true` e `maxLength` definido |
| **Vocabulário fechado** | Enums de status/tipo vivem em `FieldOption[]` no servidor **e** em `CHECK` no banco (defesa em profundidade) |
| **Campo derivado não é campo gravado** | Custo calculado, disponibilidade, ocupação, score de lead/fornecedor, vencimento fiscal, atraso: todos calculados |
| **Cadastro global × por empresa é explícito** | `empresa: true` (isolado) × `empresa` ausente (catálogo compartilhado: cores, categorias, tamanhos, grades) |

---

## 2. Inventário por domínio

### 2.1 Produto e catálogo

| Cadastro | Escopo | Chave de negócio | Obrigatórios | Únicos | Ciclo de vida | Campos derivados |
| --- | --- | --- | --- | --- | --- | --- |
| `produtos` | empresa | `sku` + `nome` | `sku`, `nome` | — (SKU verificado no serviço por empresa) | `ativo` | custo/preço sugerido (via ficha) |
| `categorias` | **global** | `nome` | `nome` | `nome` | `ativo` | — |
| `cores` | **global** | `nome` | `nome` | `nome` | `ativo` | — |
| `tamanhos` | **global** | `codigo` | `codigo` | `codigo` | sem `ativo` (catálogo fechado) | ordem |
| `grades` | **global** | `nome` | `nome`, `tamanhos` | `nome` | `ativo` | tamanhos derivados do vínculo |
| `colecoes` | empresa | `nome` | `nome` | — | `ativo` | uso (contagem) |
| `insumos` | empresa | `nome` | `nome`, `unidade` | — | `ativo` | saldo, última movimentação, último custo |
| `categorias_insumos` | empresa | `nome` | `nome` | — | `ativo` | — |
| `produto_fornecedor_skus` | empresa | par produto × fornecedor | `produto_id`, `fornecedor_id` | par | — | — |

**Qualidade:** `unidade` do insumo é texto livre com default `un` (P2: catálogo de
unidades exigiria migração de dados e não foi feito). Custo de insumo é
**derivado** de `movimentacoes_insumos` (média), nunca digitado.

### 2.2 Pessoas (clientes e fornecedores)

| Cadastro | Escopo | Obrigatórios | Únicos | Ciclo de vida | Derivados |
| --- | --- | --- | --- | --- | --- |
| `clientes` | empresa | `nome`, `pessoa`, `indicador_ie` | documento por empresa (validado no serviço) | `ativo` | — |
| `fornecedores` | empresa | `nome`, `pessoa`, `indicador_ie`, `homologacao_status` | documento por empresa | `ativo` + `homologacao_status` | desempenho (score calculado), pendências de homologação |
| `fornecedor_documentos` *(novo, 0053)* | empresa | `fornecedor_id`, `tipo` | — | `situacao` (pendente/aprovado/reprovado) | `vencido`, `dias_para_vencer` |
| `fornecedor_homologacao_eventos` *(novo, 0053)* | empresa | `fornecedor_id`, `status_novo` | — | append-only | — |
| `representantes` | empresa | `nome` | código comercial por empresa | `ativo` × desligamento | — |
| `fornecedor_contatos` | empresa | `fornecedor_id`, `nome` | — | — | — |

**Qualidade (PF/PJ):** `pessoa` = `pj|pf|estrangeiro`; documento com dígito
verificador conferido no serviço; `indicador_ie` fechado em `1|2|9` (obrigatório
para NF-e). **Homologação:** só `homologado` carimba `homologado_em`; suspenso e
bloqueado exigem motivo (validado no serviço **e** por `CHECK`); homologar exige
categoria e nenhum documento aprovado vencido.

### 2.3 Local, estoque e produção

| Cadastro | Escopo | Obrigatórios | Únicos | Ciclo de vida | Derivados |
| --- | --- | --- | --- | --- | --- |
| `locais` | empresa | `nome`, `tipo` | nome sem colisão de caixa (serviço) | `ativo` + `padrao` único | uso (saldos/movimentações/inventários) |
| `estoques` | empresa | `produto_id`, `quantidade` | (produto, tamanho, local) | só via movimentação | disponível (reservas) |
| `estoque_reservas` *(novo, 0052)* | empresa | `produto_id`, `quantidade` | — | `ativa|liberada|consumida|expirada` | disponível |
| `estoque_transferencias` *(novo, 0052)* | empresa | `origem_local_id`, `destino_local_id` | — | `solicitada→aprovada→em_transito→recebida` / `cancelada` | em trânsito |
| `producao_recursos` *(novo, 0054)* | empresa | `nome`, `tipo`, `capacidade_diaria` | — | `ativo` | carga, ocupação, gargalo |

**Qualidade:** `locais.tipo` é fechado em `loja|expedicao|faccao`; origem e
destino de transferência precisam ser diferentes (`CHECK`); `disponibilidade`
NUNCA vira coluna.

### 2.4 Financeiro

| Cadastro | Escopo | Obrigatórios | Únicos | Ciclo de vida | Derivados |
| --- | --- | --- | --- | --- | --- |
| `categorias_financeiras` | empresa | `nome`, `tipo` | `nome` | `ativo` + pai | — |
| `centros_custo` | empresa | `codigo`, `nome` | `codigo` | `ativo` | — |
| `contas_financeiras` | empresa | `nome` | — | `ativo` | saldo |
| `plano_contas` *(novo, 0056)* | empresa | `codigo`, `nome`, `natureza`, `tipo` | `codigo` | `ativo` + pai | — |
| `lancamentos_financeiros` | empresa | `data`, `tipo`, `descricao`, `valor` | — | estorno (não DELETE) | líquido, DRE |

**Qualidade:** `natureza` fechada em
`ativo|passivo|patrimonio_liquido|receita|despesa|custo`;
`tipo` = `sintetica|analitica`; conta contábil e débito/crédito andam **juntos**
(`CHECK`); competência separada da data; documento de origem
(`documento_origem_recurso`/`_id`) rastreia venda/compra/aporte.

### 2.5 Fiscal

| Cadastro | Escopo | Obrigatórios | Únicos | Derivados |
| --- | --- | --- | --- | --- |
| `regras_fiscais` | empresa | conforme CFOP/CST | — | tributação aplicável |
| `impostos_ncm` | empresa | `ncm` | `ncm` | alíquota **cadastrada**, nunca hard-coded |
| `fiscal_obrigacoes` *(novo, 0055)* | empresa | `codigo`, `nome`, `tipo`, `periodicidade`, `dia_vencimento` | `codigo` | vencimento por competência |
| `fiscal_obrigacao_entregas` *(novo, 0055)* | empresa | `obrigacao_id`, `competencia` | (obrigação, competência) | status derivado (atraso) |

**Qualidade:** `competencia` no formato `AAAA-MM` (regex no `CHECK`);
entrega `entregue` exige protocolo + data; `dispensada` exige motivo. **Nenhuma
alíquota, nenhum valor apurado e nenhum layout de SPED foi embutido.**

### 2.6 CRM (funil, origem, campanha)

| Cadastro | Escopo | Obrigatórios | Ciclo de vida | Derivados |
| --- | --- | --- | --- | --- |
| `crm_funis` *(0051)* | empresa | `nome` | `ativo` + padrão único por empresa | — |
| `crm_etapas` *(0051)* | empresa | `funil_id`, `nome`, `ordem` | `ativo` | probabilidade padrão |
| `crm_origens` *(0051)* | empresa | `nome` | `ativo` | — |
| `crm_campanhas` *(0051)* | empresa | `nome` | `ativo` | — |
| `crm_motivos_perda` | empresa | `nome` | `ativo` | — |
| `crm_leads` | empresa | `nome` | `status` | **score + motivo do score** |
| `crm_oportunidades` | empresa | `etapa` | `status`, `funil_id` | probabilidade, forecast |
| `crm_atividades` | empresa | `tipo`, `assunto` | `status` | atraso/próximas |

**Qualidade:** origem estruturada (`origem_id`/`campanha_id`/UTM) **convive** com
o texto livre legado (nada foi renomeado nem descartado); o score é
**explicável** (`score_motivo` gravado junto do número).

---

## 3. Consistência entre camadas (o que o gate confirma)

| Verificação | Onde roda | Resultado |
| --- | --- | --- |
| Todo campo não-virtual de `resources.ts` existe em `db/schema.sql` | `server/test/api.test.ts` | ✅ |
| Toda tabela de recurso tem `empresa_id` quando `empresa: true` | `npm run architecture:audit` | ✅ |
| Todo recurso multiempresa tem teste de isolamento A × B | `architecture:audit` (`TENANT_SEM_TESTE`) | ✅ 0 avisos |
| Todo recurso com CRUD tem entrada navegável no menu | `npm run audit:menu` | ✅ |
| Nenhum modal em fluxo de módulo | `npm run audit:ux` | ✅ |
| Nenhuma linha duplicada por competência (fiscal) / por fornecedor (docs) | testes de domínio | ✅ |

---

## 4. Gaps de master data (classificados, não escondidos)

| Gap | Classe | Por que não foi feito agora | Dependência |
| --- | --- | --- | --- |
| Catálogo de unidades de medida para insumos | **P2** | Exigiria migrar `insumos.unidade` (texto) e impactar compras/estoque | Decisão de produto + migração de dados |
| `fornecedores` sem unicidade de documento no MemStore | **P3** | O PostgreSQL já impõe (índice por empresa); o modo demo aceita duplicado | Teste `pg` |
| Recurso produtivo × turno/calendário de feriados | **P2** | Capacidade hoje é por dia útil fixo (seg–sex); feriados exigiriam cadastro de calendário | Cadastro de calendário produtivo |
| Plano de contas sem importação de arquivo | **P2** | O cadastro manual existe; importação exige formato acordado com o contador | Definir layout (CSV/SPED) |
| Endereço estruturado para clientes estrangeiros | **P3** | `pessoa = estrangeiro` existe, mas o endereço segue o padrão brasileiro | Regra fiscal internacional |
