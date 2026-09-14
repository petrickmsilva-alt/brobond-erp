# Auditoria do Módulo Financeiro — BROBOND ERP

**Data:** 14/09/2026 · **Escopo:** Financeiro (painel), Lançamentos, Categorias, Contas, Investidores/Sócios, Aportes e Recorrências — backend, banco e telas.
**Papel:** auditoria independente da arquitetura financeira + plano de evolução profissional.

---

## 1. Resumo executivo

O módulo já tinha uma base muito acima da média de ERPs de pequena indústria:
livro-caixa único integrado a vendas/compras/aportes, DRE gerencial por classe de
categoria, fluxo de caixa projetado (semanal/mensal), conciliador de extrato,
recorrências com agendador e rentabilidade por produto/canal.

Os gaps encontrados eram os típicos que separam um **livro-caixa digital** de um
**financeiro profissional**: dinheiro que muda de conta sujava o resultado, taxas
de operadora (Mercado Pago) eram invisíveis, não havia rateio gerencial nem travas
de integridade na exclusão de cadastros em uso.

Esta rodada (**Onda A — entregue neste commit**) resolve os gaps críticos e de
governança. O roadmap das Ondas B e C está no fim deste documento.

---

## 2. Pontos fortes (mantidos)

- **Razão única** (`lancamentos_financeiros`): venda faturada, compra recebida e
  aporte confirmado geram lançamento automático; estornos são cancelamentos com
  histórico, nunca apagam.
- **DRE gerencial** por classe de categoria (`classificacao_dre`) + fluxo projetado
  com recorrências futuras.
- **Auditoria encadeada** (tamper-evidence) e trilha por usuário em todos os
  lançamentos.
- **Conciliador** de extrato com casamento por valor/data/descrição.

## 3. Achados (diagnóstico)

| # | Severidade | Achado | Impacto |
|---|---|---|---|
| 1 | 🔴 Crítico | **Sem transferência entre contas.** Mover dinheiro Caixa → Banco Inter → Mercado Pago exigia 2 lançamentos manuais digitados como despesa + receita. | DRE e KPIs inflavam receita/despesa com movimentação interna; lucro fantasma. |
| 2 | 🔴 Crítico | **Taxas de operadora invisíveis.** Mercado Pago/cartão descontam % no repasse; só existia campo de valor bruto. | Extrato nunca batia com o lançamento; custo financeiro sumido do DRE. |
| 3 | 🟠 Alto | **Sem transferências espelhadas + sem trava de exclusão** de conta/categoria em uso (FK sem guarda na aplicação). | Excluir "Banco Inter" com lançamentos quebrava saldo e histórico. |
| 4 | 🟠 Alto | **Parcelamento sem geração de parcelas.** `fin_parcelas = 3` gerava 1 lançamento só com `parcela = total_parcelas`. | Contas a receber/pagar e projeção distorcem vencimentos reais. *(roadmap — Onda B)* |
| 5 | 🟠 Alto | **Sem centro de custo / plano de contas hierárquico.** | Impossível saber se a Loja ou a Produção consome mais caixa. |
| 6 | 🟡 Médio | **Dupla geração de recorrência** possível (cron + botão concorrentes), sem índice único. | Despesa de aluguel duplicada em condições de corrida. |
| 7 | 🟡 Médio | **Conciliador só casa valor bruto.** | Extrato da operadora (líquido) não casava com lançamento bruto. |
| 8 | 🟡 Médio | **Sem semáforo de caixa / saldo previsto por conta.** | Pico de pagamentos descoberto só no dia. |
| 9 | 🟡 Médio | **Sem baixa dedicada** com juros/multa/desconto e sem baixa parcial. | Recebido com juros de atraso distorce valor da venda. *(Onda B)* |
| 10 | 🟢 Melhoria | DRE preso ao mês corrente, sem período/comparativo; sem aging de clientes; sem anexos; sem maker-checker para valores altos; sem OFX/CNAB. | Profundidade analítica. *(Ondas B/C)* |

## 4. O que foi implementado (Onda A)

### 4.1 Transferências entre contas (achado #1)
Novo módulo **Financeiro → Transferências**: origem, destino, valor, data, status.
A API gera automaticamente um **par espelho** de lançamentos
(`referencia_tipo = 'transferencia'`): despesa na origem + receita no destino.
O resumo financeiro **exclui** esses pares de receitas, despesas, DRE e contas a
pagar/receber — eles só movem o saldo entre as contas.

- Editar valor/contas/data **atualiza o par**; **cancelar** cancela o par (histórico preservado).
- Origem ≠ destino obrigatório (API + CHECK no banco).
- Transferência confirmada **não pode ser excluída** — cancele-a (governança de trilha).

> Ex.: repasse semanal Mercado Pago → Banco Inter deixa de aparecer como
> "receita + despesa" e passa a ser o que é: movimentação interna.

### 4.2 Taxas de operadora / valor líquido (achados #2 e #7)
Lançamentos ganharam `taxa_pct` e `valor_liquido`:

- Informe o bruto + a % da operadora; **o líquido é calculado sozinho** (e pode ser ajustado em centavos).
- **Saldo da conta soma o líquido** (o que cai no banco); o DRE mostra a receita bruta e uma linha própria **"Taxas de operadoras (MP/cartão)"**, que entra no resultado financeiro.
- KPI novo **"Taxas MP/cartão (mês)"** na visão geral.
- O conciliador agora casa o lançamento também **pelo valor líquido** — extrato do Mercado Pago (já sem taxa) passa a conciliar.

### 4.3 Centros de custo + plano de contas (achado #5)
- Novo cadastro **Financeiro → Centros de custo** (LOJA, PROD, ADM...) reutilizável em lançamentos e recorrências.
- Painel Financeiro → aba **DRE** mostra **"Por centro de custo (mês)"**.
- Categorias ganharam **categoria-pai**: plano de contas em dois níveis
  (ex.: "Marketing" → "Tráfego pago"), com validação anti-ciclo e anti-terceiro nível.

### 4.4 Semáforo de caixa (achado #8)
- Alerta no topo da visão geral: **vermelho** se o acumulado projetado (12 semanas) fica negativo; **amarelo** se cai mais de 30% do saldo atual.
- Cada conta exibe **saldo previsto** (confirmado + pendente).

### 4.5 Governança e integridade (achados #3 e #6)
- **Travas de exclusão** (409 com orientação de desativar): conta financeira com lançamentos/transferências/vendas/compras/aportes/recorrências; categoria com subcategorias ou uso; centro de custo em uso.
- **Índice único parcial** `(recorrência, vencimento)`: impossível gerar a mesma competência duas vezes, mesmo com cron + botão simultâneos. A migração cria o índice de forma defensiva (uma duplicata histórica gera NOTICE, não derruba o boot).
- **CHECKs** novos (NOT VALID → valem para dados novos imediatamente): valor > 0 nos lançamentos, taxa entre 0 e 100%, valor > 0 e contas diferentes nas transferências.
- Backfill automático: `valor_liquido = valor` em todo o histórico.

### 4.6 Arquivos

| Camada | Arquivos |
|---|---|
| Banco | `db/schema.sql` (§2.11) · `db/migrations/0011_financeiro_profissional.sql` |
| Recursos | `server/src/resources.ts` (centros_custo, transferencias_financeiras, pai_id, taxa_pct, valor_liquido, centro_custo_id) |
| Regras | `server/src/financeiro.ts` (syncTransferencia, hookTaxaLancamento, resumo com exclusões/taxas/semáforo/centros) · `server/src/services.ts` (ganchos + travas) |
| Telas | `client/src/modules.ts` (menu) · `client/src/pages/FinanceiroPage.tsx` (KPI taxas, semáforo, previsto por conta, DRE por centro de custo, botão Transferir) |
| Testes | `server/test/financeiro-profissional.test.ts` (8 cenários) |
| Docs | este arquivo |

**Verificação:** typecheck API+front ✅ · 216 testes servidor (8 novos) ✅ · 31 testes front ✅ · lint (0 erros) ✅ · build front ✅ · smoke do resumo com transferência + taxa de 4,99% sobre R$ 1.000 (líquido R$ 950,10 na conta, R$ 49,90 no DRE) ✅

---

## 4.7 Onda B — contas a pagar/receber de verdade (entregue)

### Parcelamento real (achado #4 — resolvido)
Venda/compra com **N parcelas agora gera N lançamentos** (1/N, 2/N ... N/N) com
**vencimentos mensais reais**, a última parcela absorvendo os centavos da divisão
(ex.: R$ 100 ÷ 3 ⇒ 33,33 + 33,33 + 33,34). A soma das parcelas é sempre exata.
Vencimento em 31/01 pula para 28/02 (nunca vira 03/03).

- **Editar** total/parcelas do pedido **reconcilia** as parcelas (atualiza as que existem, cria as que faltam); reduzir o plano **cancela** as excedentes com histórico.
- **Cancelar o pedido cancela todas as parcelas**, mesmo que a situação financeira não tenha sido mexida.
- Parcela já **confirmada por baixa/conciliação não é revertida** por edições posteriores do pedido.

### Baixa dedicada (achado #9 — resolvido)
Novo endpoint e tela de **recebimento/pagamento**: a partir da aba
**"A receber / pagar"** do Financeiro, cada título tem o botão **Baixar**, com
data, conta, forma de pagamento, **juros, multa e desconto**.

- O principal é confirmado sem alterar o valor da origem;
- juros/multa/desconto viram **lançamentos filhos** (referência `baixa`) nas classes
  de receitas/despesas financeiras — **o caixa e o DRE fecham centavo a centavo com o extrato**;
- a origem fica consistente: venda → "recebido", compra → "pago", com data da baixa;
- DRE ganhou a linha **"Receitas financeiras (juros/multa)"**;
- só se baixa título **pendente**; transferências passam pelo módulo próprio.

### Aging do contas a receber (achado complementar — resolvido)
A mesma aba abre com **envelhecimento por faixa** (a vencer, 1–30, 31–60, 61–90
e 90+ dias) e os **maiores clientes em aberto** com quanto está vencido de cada um.

### DRE por período (achado #10 parcial — verificado: já existia)
Relatórios › **DRE gerencial** aceita qualquer período com exportação; o link fica
na própria aba DRE do Financeiro ("DRE por período").

**Verificação da Onda B:** 9 testes novos ✅ (parcelas reais + centavos exatos + fim de mês +
reconciliação + cancelamento + baixa com caixa fechando no centavo + aging), suite
completa 221 ✅, typecheck API+front ✅, build ✅.

---

## 4.8 Onda C — escala e rotina de fechamento (entregue)

### Baixa parcial (o título que recebe aos poucos)
A baixa aceita **valor parcial**: o título recebe/paga a parte informada em
lançamento confirmado próprio ("Recebimento/Pagamento parcial — restante R$ X")
e **segue pendente pelo saldo restante**, sem perder a trilha. Juros/multa valem
também na parcial; **desconto só na quitação total** (abater dívida em parcela
intermediária inflaria o saldo além do título). A venda/compra só é marcada
como recebida/paga na quitação final.

### Conciliação OFX (achado de integração de extrato — resolvido)
A aba Conciliação aceita agora, além do texto `data;valor;descrição`, o **extrato
OFX do Internet Banking** (Banco Inter, Nubank, Sicoob, Sicredi...): basta colar
o conteúdo do arquivo. Cada lançamento confirmado registra a fonte
(`extrato OFX` ou `extrato texto/CSV`) na trilha.

### Comparativo mensal (achado #10 parcial — resolvido)
Aba DRE: tabela **"Comparativo — últimos 6 meses"** com receita, despesa e
resultado confirmados (líquido de taxas), mês corrente destacado.

### Anexos em lançamentos (achado de comprovação — resolvido)
Cada lançamento aceita **até 4 fotos de comprovante** (Pix, boleto, recibo) —
mesmo armazenamento seguro das fotos de produto (banco ou Cloudinary), com
trilha de auditoria por inclusão/remoção. *(Documentos PDF/OFX ficam para a
Onda D com armazenamento de documentos.)*

**Verificação da Onda C:** 6 testes novos ✅ (parcial com caixa/a receber
fechando no centavo, quitação do saldo, desconto bloqueado na parcial, OFX,
série de 6 meses, galeria em lançamentos), suite 227 ✅, typecheck ✅, build ✅.

---

## 5. Como usar no dia a dia

**Mover dinheiro:** Financeiro → Transferências → *Nova transferência*.
Ex.: `Mercado Pago → Banco Inter, R$ 800,00`. Pronto — não crie despesa/receita manual.

**Venda via Mercado Pago:** no Lançamento, informe `Valor bruto` e
`Taxa da operadora (%)` — o líquido calculado é o valor que deve aparecer no extrato.

**Rateio gerencial:** cadastre os centros de custo (LOJA/PROD/ADM), vincule nas
recorrências (aluguel = ADM ou LOJA, facção = PROD) e nos lançamentos. A aba DRE
mostra o resultado por área todo mês.

**Excluir cadastro financeiro:** o sistema barra exclusão com uso — use *Ativo = não*.

---

## 6. Roadmap sugerido

### Onda B — contas a pagar/receber real ✅ entregue neste commit
Parcelamento real, baixa dedicada com juros/multa/desconto, aging do contas a
receber e confirmação de que a DRE por período já existia em Relatórios.

### Onda C — escala e rotina de fechamento ✅ entregue neste commit
Baixa parcial com saldo rastreado no título, anexos (fotos de comprovante) em
lançamentos, conciliação de extrato **OFX** com trilha da fonte, e comparativo
dos últimos 6 meses na aba DRE.

### Onda D — automação e integrações (próxima prioridade)
1. **Maker-checker** (alçada): lançamento/transferência acima de R$ X exige confirmação de segundo usuário.
2. Parametrizar taxas por forma de pagamento (crédito 1x, 2–6x, débito, Pix MP) com sugestão automática do `taxa_pct`.
3. Previsão de recebimento do cartão por agenda (D+1/D+30) em vez de vencimento único.
4. API/webhook do Mercado Pago: baixa automática do pedido → lançamento → conciliação.
5. Armazenamento de **documentos** (PDF de boleto/NF, arquivo OFX original) ligado ao lançamento — hoje o anexo cobre fotos.
6. **CNAB** (mensalidades/carnês em lote) se a operação adotar boletos registrados.

> Regra de ouro que orienta o roadmap: **o banco é a verdade**. Toda evolução
> deve aproximar o livro-caixa do extrato, e não o contrário.
