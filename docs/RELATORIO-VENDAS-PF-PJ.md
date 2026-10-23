# RELATÓRIO — NOVA VENDA PROFISSIONAL PF/CNPJ (`VENDAS`)

**Data:** 2026-10-23  
**Branch:** `arena/09b88384-brobond-erp`  
**Escopo:** Evolução do módulo `VENDAS` para página dedicada fora de modal (`/vendas/novo`, `/vendas/:id`, `/vendas/:id/editar`) com motor único de vendas em modalidades **Pessoa Física (CPF)** e **Pessoa Jurídica (CNPJ)**, busca global inteligente de produtos (`ProductSelector`), tamanhos de confecção (`P / M / G / GG`), financeiro completo e etapa fiscal integrada.

---

## 1. Arquitetura e Rotas

| Rota | Componente | Papel |
| --- | --- | --- |
| `/vendas` | `ModulePage` (`FORM_DIRETO.has('vendas')`) | Listagem principal, filtros, exportação e ações rápidas; **Novo** navega para `/vendas/novo` e **Editar** navega para `/vendas/:id/editar` sem abrir modal `RecordForm`. |
| `/vendas/novo` | `OrderPage` (`tipo="venda" modo="novo"`) | Criação completa em página própria com itens em rascunho local, cliente PF/PJ, descontos/frete, financeiro, resumo e salvamento/faturamento seguro contra duplicação. |
| `/vendas/:id` | `OrderPage` (`tipo="venda"`) | Visualização/operação do pedido de venda existente, itens persistidos, contas a receber geradas e situação/emissão fiscal. |
| `/vendas/:id/editar` | `OrderPage` (`tipo="venda" modo="editar"`) | Edição explícita do pedido com mesma estrutura de 7 seções lógicas do motor único `VendaOrderEngine`. |
| `/compras/:id` | `OrderPage` (`tipo="compra"`) | Fluxo de pedidos de compra preservado integralmente em `CompraOrderEngine`. |

---

## 2. Motor Único de Vendas e Ordem Lógica das Seções

O componente `VendaOrderEngine` centraliza criação, detalhe e edição sem duplicar regras entre PF e PJ:

1. **Seção 1 — Identificação da Venda e Tipo de Cliente (PF / PJ)**: seletor acessível (`role="radiogroup"`) entre Pessoa Física (`CPF`) e Pessoa Jurídica (`CNPJ`), data civil em `dd/mm/aaaa` (convertida para `AAAA-MM-DD` no payload), status, canal de venda, local de saída de estoque e representante.
2. **Seção 2 — Cliente (`ClienteVendaSelector`)**: posicionada antes de produtos; exige cliente válido antes de salvar/faturar conforme contrato `NOT NULL` de `vendas.cliente_id`.
   - **Modo PF (`000.000.000-00`)**: busca por nome, CPF (com ou sem máscara), telefone/WhatsApp (com ou sem máscara) e e-mail; alerta imediato de dígito verificador de CPF inválido sem falso positivo para celulares de 11 dígitos; exibe nome completo, CPF formatado, telefone, e-mail e endereço.
   - **Modo PJ (`00.000.000/0000-00`)**: busca por CNPJ (com ou sem máscara), razão social, nome fantasia e IE; alerta imediato de CNPJ inválido; exibe razão social, nome fantasia, CNPJ formatado, IE, indicador ICMS, inscrição municipal, limite de crédito e prontidão para NF-e 55.
   - **Prevenção de duplicidade**: consulta simultaneamente `GET /api/clientes?f.pessoa=...&q=...` (com normalização de dígitos) e `GET /api/clientes/por-documento?documento=...`; quando o documento pertence a cliente cadastrado na outra modalidade, oferece alternância em 1 clique sem recadastrar.
3. **Seção 3 — Produtos e Grade (`ProductSelector` + `ProductSelection`)**: reutiliza a busca global inteligente (`GET /api/produtos/busca`), suporta busca por nome, SKU e leitura rápida de código de barras (`Enter`), exibe variações e tamanhos (`P`, `M`, `G`, `GG`) com estoque disponível por tamanho, bloqueia pais ambíguos (`requiresExplicitChoice`) e envia sempre `{ produto_id: produtoPaiId, tamanho_id, quantidade, preco_unitario, desconto_pct }`.
4. **Seção 4 — Descontos, Frete e Observações**: campos monetários no padrão brasileiro `R$ 1.500,00` (normalizados para número antes do envio) e observações comerciais.
5. **Seção 5 — Financeiro**: preserva integralmente `fin_conta_id`, `fin_status` (`a_receber`, `recebido`, `sem_financeiro`), `fin_forma_pagamento`, `fin_parcelas` (`1..36`), `fin_vencimento`, `fin_recebido_em` e `fin_documento`, com prévia de centavos idêntica ao motor `gerarParcelasVenda` do servidor e listagem das parcelas reais (`lancamentos_financeiros`) quando faturada. Degrada graciosamente para perfil `operador` sem disparar chamadas `403`.
6. **Seção 6 — Resumo da Venda**: consolida modalidade PF/PJ, documento do cliente, quantidade de linhas/peças, subtotal bruto, desconto, frete, total líquido e condição financeira, com ações de salvar, finalizar e cancelar.
7. **Seção 7 — Fiscal (`FiscalVendaCard`)**: integra `GET /api/vendas/:id/fiscal`, `GET /api/vendas/:id/fiscal/previa?modelo=55|65` e `POST /api/vendas/:id/fiscal/emitir`, sugerindo NF-e (55) para PJ e NFC-e (65) para PF sem inventar regras tributárias fora do motor fiscal existente.

---

## 3. Busca Desformatada no Backend (`PgStore` e `MemStore`)

- `server/src/resources.ts`: habilitado `search: true` em `telefone`, `whatsapp` e `email` de `RESOURCES.clientes` (todas colunas já existentes em `db/schema.sql`, sem necessidade de migração SQL).
- `server/src/pgstore.ts` e `server/src/memdb.ts`: quando o termo de busca contém 3 ou mais dígitos, a busca textual (`q`) também compara `regexp_replace(coluna, '\D', '', 'g') ILIKE $n` (parametrizado) nos campos `type: 'document'` e `type: 'phone'`, além de proteger `id = $n` contra extrapolação de `int4` quando o usuário pesquisa CPF/CNPJ numérico de 11–14 dígitos.
