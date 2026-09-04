# BROBOND ERP — Auditoria Financeiro & Comércio (Catálogo, Varejo/Atacado e Investidores)

**Data:** 04/09/2026 · **Branch:** `arena/01a06e1e-brobond-erp`
**Base auditada:** `305d0279e22f99c214c7b067fd25207575b8caef` (main)
**Objetivo:** verificar o módulo financeiro, o catálogo público, a ligação de varejo/atacado e o tratamento dos aportes de investidores, e propor a evolução com o que há de melhor no mercado para integrar ao sistema.

---

## 1. Sumário executivo

O BROBOND ERP já tem uma base **acima da média**: cadastro de produtos com fotos/código de barras, estoque por grade, produção com OP/ficha técnica/custo, vendas e compras com itens e baixa automática, catálogo público por link, relatórios, importação/exportação e segurança razoável.

**O que NÃO existia (verificado):**

| Área | Situação antes desta evolução |
|---|---|
| **Módulo financeiro** | **Não existia.** Não havia contas, categorias, livro-caixa, fluxo de caixa, contas a pagar/receber, DRE ou qualquer tela de Finanças. |
| **Link de vendas/compras com finanças** | **Não existia.** Venda faturada e compra recebida só mexiam no estoque/custo médio; nenhum lançamento financeiro era gerado. |
| **Aportes de investidores** | **Não existia.** Não havia cadastro de investidores/sócios, aportes, capital inicial, participação ou distribuição de lucro. |
| **Catálogo para o cliente** | Existia **somente leitura** (link com foto, preço e saldo opcional). Não mostrava preço de atacado, não separava varejo/atacado, não permitia montar pedido. |
| **Varejo × atacado** | O produto tinha apenas `preco_venda`; cliente tinha `tipo` (loja/atacadista/varejo), mas não havia preço de atacado nem quantidade mínima. |
| **Venda pelo site** | **Não existia.** O catálogo não gerava pedido; era apenas um PDF/link de apresentação. |
| **Integração externa** | Havia esqueleto de **NF-e**, **frete**, **marketplace** e **portal do cliente**, mas nenhum conectado de verdade. |

---

## 2. O que já existia (verificado linha a linha)

- **Cadastros:** produtos, categorias, cores, tamanhos, coleções, clientes, fornecedores, representantes, insumos, locais, usuários.
- **Produto:** SKU, fotos (até 5), categoria, coleção, cor padronizada/texto livre, custo, preço venda, EAN, composição, descrição, NCM, peso, grade por tamanho/local, página de detalhe e etiquetas.
- **Estoque:** saldo por produto+tamanho+local, movimentações imutáveis, transferência, inventário com congelamento de saldo e geração de ajustes, estoque de insumos.
- **Produção:** OP por tamanho **e** por grade, etapa (corte/costura/acabamento/revisão), facção, entrada automática ao concluir, consumo de insumos, ficha técnica/BOM, custo calculado (materiais + mão de obra + indiretos) e preço sugerido.
- **Compras:** pedido por fornecedor, itens de insumo, recebimento → entrada no estoque de insumos + custo médio ponderado, PDF, condição de pagamento, frete, NF.
- **Vendas:** pedido por cliente/representante, itens por produto+tamanho, total calculado, faturamento → baixa de estoque + comissão congelada, estorno no cancelamento, PDF, portal do cliente, relatório de comissões.
- **Catálogo público:** `/catalogo/:token`, senha opcional, filtro por categoria/coleção, mostrar preço, mostrar saldo, expiração.
- **Extras:** auditoria, permissões por perfil, PWA, notificações, aprovações, predição de demanda, OpenAPI, frete/CEP, NF-e (skeleton), marketplace (skeleton), chat, backup.

---

## 3. Lacunas encontradas (antes da implementação)

### 3.1 Financeiro
1. **Sem razão/livro financeiro** — não existe o registro que liga receita/despesa ao negócio.
2. **Receitas não reconhecidas** — venda faturada não gera receita a receber, recebida ou cancelada.
3. **Despesas operacionais** — compra recebida não gera conta a pagar/pago; não há despesas de folha, aluguel, energia, marketing, facção etc.
4. **Sem contas** (caixa, banco, Pix, cartão, boleto) nem categorias de receita/despesa.
5. **Sem fluxo de caixa** — não se sabe quanto tem hoje, quanto entra, quanto sai.
6. **Sem DRE** — margem/custo/lucro só parcial (ficha técnica) e sem visão gerencial.
7. **Sem contas a receber/a pagar.**

### 3.2 Catálogo e comércio
1. **Somente leitura**, sem pedido.
2. **Sem varejo/atacado** — um único preço.
3. **Sem origem de venda** (site varejo, site atacado, balcão, representante, WhatsApp, marketplace).
4. **Sem filtro de exibição** (produto visível no site ou só interno).
5. **Sem tabela de preço por cliente/canal.**

### 3.3 Investidores
1. **Sem cadastro de investidores/sócios.**
2. **Sem aportes** (capital inicial, rodada, reinvestimento, empréstimo de sócio, distribuição de lucro).
3. **Sem participação societária.**
4. **Sem impacto no fluxo de caixa (entrada de capital) nem na DRE (não é receita operacional).**

---

## 4. O que foi implementado nesta evolução

### 4.1 Módulo Financeiro (funcional, no padrão do ERP)

Novo menu **Financeiro** com 6 módulos + painel:

| Recurso | O que registra | Como linka |
|---|---|---|
| `categorias_financeiras` | Receita / Despesa / Investimento | Classificação de todos os lançamentos |
| `contas_financeiras` | Caixa, banco, Pix, cartão, boleto, com saldo inicial | Origem/destino do dinheiro |
| `lancamentos_financeiros` | **Livro-caixa**: receita, despesa, investimento, estorno | Referência (`venda`, `compra`, `aporte`, `outro`) |
| `investidores` | Investidores/sócios/emprestadores, participação, contato | Aportes |
| `aportes` | Capital inicial, aporte/rodada, reinvestimento, empréstimo de sócio, distribuição de lucro | Lançamento financeiro automático |
| Painel `Financeiro` | Fluxo de caixa, resultado do mês, contas, categorias, a receber/a pagar, vendas por canal | API `/api/financeiro/resumo` |

**Regras automáticas implementadas:**

- **Venda faturada** → cria lançamento **RECEITA** (`status` = pendente até `fin_status=recebido`).
- **Venda marcada como recebida** → atualiza o lançamento para **confirmado** (entra no saldo da conta).
- **Venda cancelada** → estorna/marca como cancelado.
- **Compra recebida** → cria lançamento **DESPESA** (`status` = pendente até `fin_status=pago`).
- **Compra paga** → atualiza para **confirmado**.
- **Compra cancelada** → estorna.
- **Aporte confirmado** → cria lançamento **INVESTIMENTO** (entrada de capital no caixa; **não** entra como receita operacional na DRE).
- **Aporte estornado/previsto** → cancela/fica pendente.

O painel já calcula:
- saldo por conta (saldo inicial + entradas - saídas)
- receitas, despesas, investimentos e resultado do mês
- **a receber** (vendas faturadas/entregues não recebidas)
- **a pagar** (compras recebidas não pagas)
- fluxo por categoria, vendas por canal, últimos lançamentos

### 4.2 Varejo × Atacado e pedido pelo catálogo

**Produto agora tem:**
- `preco_venda` (varejo)
- `preco_atacado`
- `atacado_min_qtd`
- `exibir_site` (visível para pedido público)
- `destaque` (prioridade visual)

**Venda agora tem:**
- `canal_venda`: balcão, representante, WhatsApp, **site_varejo**, **site_atacado**, marketplace, outro
- dados financeiros: `fin_conta_id`, `fin_status`, `fin_forma_pagamento`, `fin_recebido_em`, `fin_documento`

**Catálogo público agora tem:**
- `canal`: todos / varejo / atacado
- `tabela_preco`: automático / varejo / atacado / ambos
- `aceita_pedido_site`
- `como_comprar` (instruções que aparecem no topo)
- **POST `/api/publico/catalogo/:token/pedido`** — o cliente monta um carrinho e envia como **cotação** (`status=cotacao`, canal `site_varejo`/`site_atacado`).
- O pedido público **não paga online**; ele cria um pedido de venda no ERP para a equipe confirmar, faturar e linkar no financeiro.

### 4.3 Finanças × Custos de produção

A base para linkar **todos os gastos** já existia e continua:
- **Custo do produto** = ficha técnica (Σ insumos com perda × custo médio + mão de obra + indiretos) + preço sugerido.
- **Compra de insumos** → entrada de estoque + custo médio.
- **OP concluída** → consumo de insumos + entrada no estoque.
- **Novo lançamento manual de despesa** cobre: folha, facção, aluguel, energia, marketing, frete, embalagem, impostos, administrativo.

---

## 5. Arquitetura financeira recomendada (próximos passos)

### 5.1 Modelo de dados proposto (já parcialmente implementado)

```
lançamentos_financeiros (livro-caixa / razão única)
├── data, tipo (receita/despesa/investimento/estorno)
├── categoria_id, conta_id
├── valor, forma_pagamento, status
├── referência_tipo (venda/compra/aporte/outro)
├── referência_id
└── observações

contas_financeiras        → caixa, banco, Pix, cartão, boleto
categorias_financeiras    → vendas, compras, folha, aluguel, marketing…
investidores              → sócios/investidores/emprestadores
aportes                   → capital, rodada, reinvestimento, distribuição
```

### 5.2 Como cada gasto/despesa entra automaticamente

| Origem | Entrada automática recomendada |
|---|---|
| Venda faturada | Receita `a receber` → confirmada quando paga |
| Compra recebida | Despesa `a pagar` → confirmada quando paga |
| Custo de produção (BOM) | Despesa de custo variável (computado no demonstrativo, não no caixa) |
| Folha / mão de obra / facção | Despesa manual por mês |
| Aluguel, energia, água | Despesa manual recorrente |
| Marketing e vendas | Despesa manual |
| Frete/embalagem | Despesa manual ou derivada do pedido |
| Impostos / taxas | Despesa manual ou via NF-e |
| **Aporte de investidor** | **Entrada de capital** (não é receita operacional) |
| Retirada/distribuição de lucro | **Saída de capital** para sócio |

### 5.3 Telas sugeridas (Fase 2 do plano financeiro)

1. **Contas a receber** — por cliente, vencimento, canal, desconto/antecipação.
2. **Contas a pagar** — por fornecedor, vencimento, recorrência.
3. **Agenda financeira** — próximos 30/60/90 dias.
4. **DRE gerencial** — Receita − CMV/materials − mão de obra − despesas operacionais = resultado.
5. **Fluxo de caixa projetado** — entradas/saídas por semana/mês.
6. **Recorrência** — aluguel, energia, folha, facção (lançamento automático mensal).
7. **Conciliação bancária** — importar extrato/pix e casar com lançamentos.
8. **Rentabilidade por produto/canal** — margem por peça e por canal.

---

## 6. Catálogo público → cliente / representante → venda

### 6.1 Fluxo atual (após implementação)

```
BROBOND cadastra Catálogo
  ├── escolhe coleção/categoria
  ├── canal (todos/varejo/atacado)
  ├── tabela de preço
  ├── aceita pedido pelo site
  ├── instruções "como comprar"
  └── gera link /catalogo/<token>

Cliente/Representante abre o link (sem login; pode ter senha)
  ├── vê produto: foto, cor, composição, descrição, tamanhos
  ├── vê preço de varejo e/ou atacado conforme a tabela
  ├── escolhe tamanho
  ├── monta carrinho
  └── envia pedido

ERP recebe COTAÇÃO (venda status=cotacao, canal site_varejo/site_atacado)
  ├── cliente criado/atualizado automaticamente
  ├── itens registrados (produto + tamanho + quantidade + preço)
  ├── total calculado no servidor
  └── equipe confirma, fatura, baixa estoque e marca recebido
      → vira receita no módulo Financeiro
```

### 6.2 Diferença varejo × atacado

| Item | Varejo | Atacado |
|---|---|---|
| Cliente | pessoa/pequena loja | loja, distribuidor, representante |
| Preço | `preco_venda` | `preco_atacado` |
| Mínimo | — | `atacado_min_qtd` |
| Canal | `site_varejo` / balcão | `site_atacado` / representante |
| Financeiro | receita confirmada quando paga | receita confirmada quando paga |

### 6.3 Como a equipe usa (interno)

1. `Vendas` → filtro `canal_venda` → aceita/nega a cotação.
2. Se aceitar → marca `faturada` → baixa estoque → lançamento financeiro automático.
3. Marca `fin_status=recebido` + conta financeira + forma de pagamento.
4. Financeiro mostra "a receber" e, quando pago, entra no saldo de caixa/banco.

---

## 7. Integrações externas — o melhor do mercado para o BROBOND

### 7.1 E-commerce / loja virtual (se o cliente for comprar no site com pagamento)

| Solução | Por que usar | Como integrar |
|---|---|---|
| **Nuvemshop** | Brasileira, PIX/cartão/boleto fácil, frete Correios | API + webhooks → criar venda no ERP com canal `site_varejo` |
| **Shopify** | Global, checkout forte, fácil de manter | API GraphQL + webhooks |
| **WooCommerce** | Flexível, custo baixo, WordPress | REST API + webhook de pedido |
| **VTEX** | Escala e B2B nativo (preço por cliente, pedido mínimo) | API + webhooks |
| **Mercado Livre / Shopee** | Marketplace | Já há esqueleto `marketplace.ts`; ligar canal `marketplace` |
| **Bling / Tiny ERP** | B2B/atacado, NF-e, pedido por representante | API NFe + pedidos + conciliação |

**Recomendação:** começar com **catálogo → cotação** (já implementado) e, quando houver tráfego, adicionar **Nuvemshop** ou **VTEX** (B2B) com webhook que cria `venda` no BROBOND com canal `site_varejo`/`site_atacado`. O financeiro já aceita receber esse pedido.

### 7.2 Pagamentos (recebimento)

| Solução | O que entrega |
|---|---|
| **Mercado Pago** | PIX, cartão, boleto, link de pagamento, conciliação |
| **Pagar.me** | GPV/checkout B2B, cartão, boleto, antifraude |
| **Asaas** | PIX e boleto muito bons, contas recorrentes |
| **Stripe (Brasil)** | Cartão, link, PIX, internacional |

**Recomendação:** **Mercado Pago** (popular no Brasil) e **Asaas** (boleto/PIX recorrente). Integrar por webhook de "pagamento confirmado" → marcar venda como `fin_status=recebido` e `fin_forma_pagamento`, gerando a receita automática.

### 7.3 Fiscal / NF-e

| Solução | O que entrega |
|---|---|
| **Focus NFe** | API nacional, emissão simplificada |
| **NFe.io** | Emissão + resumo |
| **eNotas** | Webhooks + DANFE |

O ERP já tem esqueleto de NF-e (`nfe.ts`). Ligar ao faturar (`venda` faturada = NF emitida) e reagir à rejeição/cancelamento.

### 7.4 Contabilidade / ERP financeiro nacional

| Solução | O que entrega |
|---|---|
| **Omie** | ERP financeiro + contábil, ótimo p/ PME | 
| **Bling** | ERP comercial + financeiro |
| **Tiny ERP** | Comercial + financeiro |
| **Conta Azul** | Financeiro e cobrança simples |
| **Granatum** | Orçamento e projeção |
| **Nibo** | Contábil/financeiro |
| **Power BI / Looker Studio / Metabase** | Dashboards gerenciais |

**Recomendação de menor atrito:** usar o **módulo Financeiro interno** como fonte de verdade operacional e exportar/confirmar na **Omie/Bling/Nibo**. Se quiser menos infra, Bling ou Tiny já fazem financeiro + NF-e + catálogo.

### 7.5 Investidores / captação

| Item | Melhor prática |
|---|---|
| Registro | `investidores` + `aportes` (já criado) |
| Forma | capital (entrada), dívida conversível, empréstimo de sócio |
| Documento | contrato, valor, participação, vesting, distribuição |
| Financeiro | entrada de capital entra como **investimento** (não receita) |
| DRE | separar resultado operacional de resultado financeiro |
| Dashboard | % da empresa, valuation, aportes acumulados, lucro por sócio |
| Compliance | cuidar CVM/societário com contador quando houver terceiros |

---

## 8. Roadmap recomendado (próximas 4–6 semanas)

| Fase | Entregável | Esforço | Status |
|---|---|---:|---|
| **F1 — Fundação financeira** | Contas/categorias/lançamentos, painel, auto-posting vendas/compras/aporte | 2 dias | ✅ **entregue** |
| **F2 — Comércio varejo/atacado** | preço atacado, canal de venda, catálogo com pedido/cotação | 2 dias | ✅ **entregue** |
| **F3 — Contas a receber/pagar + recorrência** | agenda 30/60/90, aluguel/energia/folha recorrente | 2–3 dias | ⬜ |
| **F4 — DRE gerencial** | receita − CMV/custo − despesas = resultado por mês | 1–2 dias | ⬜ |
| **F5 — Fluxo projetado** | projeção por semana/mês com dados reais | 2 dias | ⬜ |
| **F6 — Pagamento online** | Mercado Pago/Asaas + webhook → marca recebido | 3–4 dias | ⬜ |
| **F7 — Loja oficial (Nuvemshop/VTEX/Woo)** | webhook pedido → venda `site_varejo/site_atacado` | 4–7 dias | ⬜ |
| **F8 — NF-e** | emitir ao faturar; rejeição/cancelamento trata financeiro | 3–5 dias | ⬜ |
| **F9 — Integração contábil/financeira** | Omie/Bling/Nibo + exportação conciliada | 4–6 dias | ⬜ |
| **F10 — Relatório de investidores** | aportes, participação, distribuição, DRE por sócio | 2 dias | ⬜ |

### Ordem sugerida

1. **F3/F4** (gestão do dia a dia) — mais valor, menos risco.
2. **F6** (PIX/cartão no site) — quando houver venda B2C.
3. **F7** (loja oficial) — quando houver volume.
4. **F8/F9** (NF-e e contábil) — antes de escalar.
5. **F10** — sempre que tiver terceiros/investidores.

---

## 9. O que NÃO fazer agora

1. **Não misturar aporte com receita operacional** (distorce DRE e margem).
2. **Não deixar o cliente comprar sem confirmação de saldo** em atacado — usa cotação primeiro (como implementado) ou trava por saldo disponível.
3. **Não colocar preço no catálogo de atacado sem quantidade mínima** — permite pedido sem viabilidade.
4. **Não pagar gateway só para testar** — começa com Pix manual e `fin_forma_pagamento`.
5. **Não integrar contábil antes do fluxo de caixa interno** estar confiável.

---

## 10. Checklist de verificação rápida (o que testar após o deploy)

- [ ] Login admin → menu **Financeiro** aparece.
- [ ] `Financeiro` mostra saldo de contas (mock: Caixa e Pix).
- [ ] Cria investidor → cria aporte confirmado → saldo da conta aumenta como **investimento**, não como receita.
- [ ] Cria venda e marca `faturada` → aparece em **Lançamentos** como receita pendente e em **a receber**.
- [ ] Marca venda `fin_status=recebido` → receita confirma e entra no saldo da conta.
- [ ] Cria compra e marca `recebido` → aparece como despesa pendente e em **a pagar**.
- [ ] Marca compra `fin_status=pago` → despesa confirma.
- [ ] Cria catálogo com `aceita_pedido_site=true`, `tabela_preco=ambos` → link mostra varejo e atacado.
- [ ] No link público, monta pedido (com tamanho) → venda `status=cotacao`, `canal_venda=site_varejo/site_atacado`.
- [ ] `Vendas` filtro `status=cotacao` → equipe aprova, fatura e vincula financeiro.
- [ ] `db/schema.sql` idempotente roda sem erro em banco novo e em banco antigo.

---

## 11. Conclusão

O BROBOND não tinha **módulo financeiro** e o catálogo era só apresentação. Nesta evolução foram entregues:

1. **Módulo Financeiro funcional** integrado a vendas, compras, custos e aportes.
2. **Varejo × atacado** com preços distintos, canal de venda e quantidade mínima.
3. **Catálogo → pedido/cotação** para cliente ou representante visualizar e pedir as peças fabricadas.
4. **Aportes de investidores** ligados ao caixa, separados de receita operacional.

A arquitetura está pronta para crescer com integrações externas **quando houver demanda**:
- **loja online / B2B**: Nuvemshop, VTEX, WooCommerce, Shopify, Bling/Tiny, Mercado Livre.
- **pagamento**: Mercado Pago, Asaas, Pagar.me, Stripe.
- **fiscal**: Focus NFe, NFe.io, eNotas.
- **contábil/financeiro**: Omie, Bling, Tiny, Conta Azul, Nibo, Granatum.
- **BI**: Power BI, Looker Studio, Metabase.

O caminho de menor risco é: **fluxo de caixa interno confiável → PIX/recorrência → loja oficial → NF-e/contábil → relatórios de investidores.**
