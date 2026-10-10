# BROBOND ERP — GAPS

**Fase E1 — Auditoria estrutural. Fases E2, E3, E3.1 e E3.2 executadas.**
Baseline auditado: `e6cb2f0` (`main`) · Data: 2026-10-09 · Branch: `arena/3b3ee997-brobond-erp`

> **Atualização E2:** os 8 gaps de Produção estão fechados com evidência
> executada (migração em banco vazio, 33 testes novos de servidor, 14 de tela,
> 24 verificações de smoke HTTP). A seção de cada gap guarda o que faltava,
> como foi comprovado que faltava e como foi resolvido.
>
> **Atualização E3 / E3.1 / E3.2:** os 6 gaps de Compras estão fechados —
> cotação de compra (0027), custo de recebimento canônico (0028), tela de
> recebimento, importação de NF-e com prévia, de-para de fornecedor (0029) e
> contas a pagar visíveis na compra. Evidência executada: 29 migrações em banco
> vazio (97 tabelas), 89 testes no PostgreSQL real, 226 testes de tela e smoke
> HTTP ponta a ponta com **126/126** verificações. Junto foram encontrados e
> corrigidos **8** bugs de produção — o mais grave, `receberParcial` devolvendo
> **500** no PostgreSQL real para qualquer compra com `fin_vencimento`.
>
> **Gate E4.2 (2026-10-09):** a execução final do CI contra PostgreSQL real, [run 38005819077](https://github.com/petrickmsilva-alt/brobond-erp/actions/runs/38005819077), passou nos jobs `testes-postgres` e `verificar`; a suíte tem **91 pass, 0 fail, 0 skipped** (a contagem final é derivada, pois o footer TAP não ficou exposto pela API; proveniência em [`docs/RELATORIO-E4.2.md`](RELATORIO-E4.2.md)). As falhas anteriores dos runs 38003682898 e 38004716773 foram preservadas e corrigidas apenas no harness. E4.2 está **APROVADO TECNICAMENTE**; PR #46 permanece aberto, sem merge, e o acompanhamento do gap não autoriza avanço a E4.3 nem altera os gaps P1/P2 separados. Estado, limites e evidência: [`docs/RELATORIO-E4.2.md`](RELATORIO-E4.2.md).
>
> **Atualização E4.2.3 (2026-10-10):** os três gaps da expedição em PostgreSQL
> estão **fechados com evidência executada** — `GAP-EXPEDICAO-ETAPA-PG` (AUD-01,
> CRÍTICO), `GAP-EXPEDICAO-CONFERENCIA-PG` (AUD-02) e `GAP-EXPEDICAO-SEM-TESTE-PG`
> (AUD-05). A migration `0032` alinha o CHECK de `expedicao_eventos` ao
> vocabulário canônico (`pendente → separacao → conferida → embalada → expedida`)
> sem backfill; a conferência reprovada persiste divergência JSONB válida e
> responde 422; há E2E PostgreSQL completo (estoque baixado uma única vez,
> multiempresa 404, rollback e concorrência). `test:pg` **110/110** em banco
> vazio. AUD-03/AUD-04 (faturamento direto/atalhos fora da máquina) seguem como
> decisão de produto documentada, não implementados. Estado e evidência:
> [`docs/RELATORIO-E4.2.3.md`](RELATORIO-E4.2.3.md).

Este é o **registro oficial do que falta**. Regra de manutenção:

> Um gap só sai desta lista quando houver evidência executada — teste passando,
> migração aplicada em banco vazio, endpoint exercitado. Nada de remover por
> decreto.

Cada gap tem: o que falta, **como foi comprovado que falta**, a fase que o
resolve e o critério de aceite.

Classificação do tipo de gap (seção 3 da especificação):
`menu` · `ux` · `frontend` · `backend` · `banco` · `integração` · `ausência completa`

---

## RESUMO

| Fase | Gaps | Abertos | Críticos abertos |
|---|---|---|---|
| **E2 — Produção** | 8 | **0** ✅ | **0** |
| **E3 — Compras** | 6 | **0** ✅ | **0** |
| **E4 — Estoque avançado** | 8 | 4 | 0 |
| **E5 — Financeiro avançado** | 2 | 2 | 0 |
| **E6 — Fiscal** | 2 | 2 | 0 |
| **E7 — Logística** | 1 | 1 | 0 |
| **E8 — Commerce** | 6 | 6 | 2 |
| **E9 — Relatórios** | 1 | 1 | 0 |
| **E10 — Administração** | 4 | 4 | 1 |
| **E11 — UX final** | 2 | 2 | 0 |
| **E12 — Homologação** | 3 | 3 | 3 |
| Transversais | 7 | 4 | 0 |
| **Total** | **50** | **29** | **6** |

---

## EVIDÊNCIA DE BANCO (medida no PostgreSQL real, após bootstrap em banco vazio)

Consultas executadas em `postgres://…:55432/brobond_teste` depois de
`db/schema.sql` + as 25 migrações:

| Consulta | Resultado | Gap |
|---|---|---|
| colunas de `movimentacoes` | `id, tipo, produto_id, tamanho_id, local, quantidade, motivo, usuario_id, data, local_id, local_destino, local_destino_id, transferencia_id, compra_id, estornado, estornado_em, estornado_por, movimentacao_estorno_id, empresa_id` | **sem `venda_id`**, **sem `ordem_id`** |
| colunas de `movimentacoes_insumos` | `id, tipo, insumo_id, quantidade, custo_unitario, motivo, usuario_id, data, empresa_id` | **sem `ordem_id`** |
| foreign keys em `movimentacoes.transferencia_id` | **0** | transferência sem vínculo |
| constraints `CHECK` em `ordens_fabricacao` | **0** | status aceita qualquer string |
| tabelas `ordens_eventos` | **não existe** | sem trilha da OP |
| tabelas `transferencias` / `transferencias_estoque` | **não existe** | sem entidade de transferência |
| tabelas `cotacao%` | **1** (`cotacao_decisoes`, do portal do cliente) | sem cotação de compra |
| `grep -c reserva server/src/estoque.ts` | **0** | sem reserva |
| `grep -c custo_medio server/src/compras.ts` | **0** | recebimento não repassa custo |
| `grep -rn importarXmlCompra server/test/ scripts/` | **0** | importação de NF-e sem teste |
| `grep -rln aplicarPrecoFicha\|recalcularFichaValores server/test/` | **0** | cálculo de custo sem teste |


---

## E2 — PRODUÇÃO

### `GAP-PROD-ESTADOS` — máquina de estados incompleta · ✅ **RESOLVIDO na E2**
- **Tipo:** banco + backend + frontend
- **O que faltava:** a especificação pede `PLANEJADA → LIBERADA → EM_PRODUÇÃO → PARCIAL → CONCLUÍDA` (+ `CANCELADA`).
- **Evidência do gap (antes):** `db/schema.sql` declarava `status TEXT DEFAULT 'planejada' -- planejada, em_producao, concluida, cancelada`, sem `liberada` nem `parcial`, e **sem nenhuma constraint `CHECK`** — qualquer string era aceita.
- **Como foi resolvido:** `db/migrations/0026_producao_completa.sql` adiciona `CHECK ordens_fabricacao_status_valido` com os seis estados (precedido de `UPDATE … SET status='planejada' WHERE status IS NULL` e de um DO-block que lista os `id:status` fora do vocabulário antes de criar a constraint, para não quebrar o boot com dado legado). O grafo de transições vive em `server/src/producao.ts` (`STATUS_OP`, `TRANSICOES_OP`, `transicaoPermitida`) e é validado em `aplicarRegrasOrdem` **dentro da transação**, com 409 e mensagem listando as transições permitidas.
- **Decisões registradas:**
  - `concluida → cancelada` **passou a ser impossível**. O caminho de desfazer é reabrir (estorna) e então cancelar. `services.ts` ainda roteava essa transição para `estornarOrdem`; o ramo ficou como código morto inofensivo.
  - `planejada → concluida` (atalho que existia antes) **foi mantido** e agora é gravado na trilha como evento `atalho`.
  - `cancelada` é terminal.
- **Evidência:** `server/test/producao-e2.test.ts` (transições legais/ilegais, 409, estado terminal, 400 de vocabulário) · `server/test/pg-producao-e2.test.ts` (o CHECK recusa de verdade no Postgres, `code 23514`) · concorrência real: duas conclusões simultâneas, exatamente uma vence.
### `GAP-PROD-PERDAS` — sem quantidade perdida · ✅ **RESOLVIDO na E2**
- **Tipo:** banco + backend + frontend
- **Evidência do gap (antes):** `grep -n "perdid" db/schema.sql server/src/producao.ts` → **zero ocorrências**.
- **Como foi resolvido:** `ordens_fabricacao.quantidade_perdida`, `itens_ordem.perdido` e `ordens_apontamentos.quantidade_perdida`. A regra implementada: **a base de consumo de insumo é `produzida + perdida`** (peça refugada custa material) e **a entrada no estoque é só `produzida`**. Sem apontamento a base continua sendo a quantidade planejada — comportamento idêntico ao pré-E2 (teste de não-regressão em `producao-e2.test.ts`).
- **Evidência:** teste "peça refugada consome insumo e NÃO entra no estoque" (16 m baixados para 6 boas + 2 refugadas; só 6 entram no estoque) · evento `perda` na trilha · coluna "Refugadas" na OP e no planejamento.
### `GAP-PROD-CUSTO-OP` — sem custo previsto × real na OP · ✅ **RESOLVIDO na E2**
- **Tipo:** banco + backend + frontend
- **Como foi resolvido:**
  - `custo_previsto` é **congelado na liberação** (`POST /api/ordens/:id/liberar`): peças planejadas × `fichas_tecnicas.custo_calculado` daquele instante. Editar a ficha depois **não** reescreve o que foi orçado — é de propósito e está comentado no código.
  - `custo_real` = Σ(`movimentacoes_insumos` de saída com `ordem_id`, `quantidade × custo_unitario`) + (`mao_obra` + `custos_indiretos`) × `min(1, processadas/planejadas)`. Recalculado a cada apontamento e na conclusão.
- **Evidência:** `liberar` grava 300 para 10 peças de custo 30 · sem ficha técnica o previsto fica 0 **e a trilha avisa** (não inventa) · custo real 100 para 5 peças × 2 m × R$10 · tela mostra previsto × real com variação (teste de tela `OrdemDetail.test.tsx` verifica `+R$ 40,00`).
### `GAP-PROD-CONSUMO-VINCULO` — consumo de insumo sem vínculo formal · ✅ **RESOLVIDO na E2**
- **Tipo:** banco + backend
- **Evidência do gap (antes):** `movimentacoes_insumos` não tinha `ordem_id`; o estorno localizava o consumo por texto (`motivo.startsWith('Consumo — OP #N')`).
- **Como foi resolvido:** `movimentacoes.ordem_id` e `movimentacoes_insumos.ordem_id`, ambos `REFERENCES ordens_fabricacao(id) ON DELETE SET NULL` + índice. Backfill por `regexp_match(motivo,'OP #(\d+)')` **guardado por `EXISTS` em `ordens_fabricacao`** — motivo sem padrão ou com id órfão fica `NULL`, nunca se inventa vínculo. O `motivo` em texto livre continua sendo escrito (a UI o mostra), mas deixou de ser a fonte de verdade.
- **Correção de projeto importante:** `movimentacoes_insumos` **não tem** coluna `estornado`, então o estorno é feito por **saldo líquido por insumo** (Σsaída − Σentrada filtrando por `ordem_id`). Reverter linha a linha devolveria o mesmo material duas vezes na segunda reabertura.
- **Evidência:** `pg-producao-e2.test.ts` executa **o SQL do próprio arquivo 0026** (extraído por regex) contra linhas fabricadas: liga a que tem `OP #N`, deixa `NULL` a sem padrão e a órfã · `ON DELETE SET NULL` preserva a movimentação e solta o vínculo · `producao-e2.test.ts` prova que dois ciclos concluir/reabrir deixam líquido zero.
### `GAP-PROD-APONTAMENTOS` — sem apontamento de produção · ✅ **RESOLVIDO na E2**
- **Tipo:** ausência completa → banco + backend + frontend
- **Como foi resolvido:** tabela `ordens_apontamentos` (append-only, `internal: true`, sem CRUD genérico) criada **apenas** por `POST /api/ordens/:id/apontamentos`, que é o único ponto que consome insumo, acumula `produzido/perdido`, recalcula o custo real e move a OP para `parcial`. Idempotente por `idempotency_key` com **índice único parcial `(empresa_id, idempotency_key)`** — repetir o POST devolve o mesmo apontamento (`idempotente: true`, HTTP 200) sem baixar insumo de novo.
- **Concorrência:** a transição usa `tryUpdateIf` (`UPDATE … WHERE status = esperado`); a perdedora recebe 409 em vez de acumular sobre a mesma base.
- **Evidência:** 4 testes em `producao-e2.test.ts` (acumulação, perda, idempotência, validação) · `pg-producao-e2.test.ts` prova que o índice único recusa no banco (`23505`) e que chave `NULL` é repetível · smoke HTTP verifica `idempotente=true` na segunda chamada.
### `GAP-PROD-PLANEJAMENTO` — sem planejamento de produção · ✅ **RESOLVIDO na E2**
- **Tipo:** ausência completa → backend + frontend
- **Como foi resolvido:** `GET /api/producao/planejamento?de=&ate=` + tela `/planejamento-producao` (menu Produção). Agrega por semana as OPs `planejada|liberada|em_producao|parcial` do período e calcula a **necessidade de insumos** (consumo da ficha × peças que faltam produzir − saldo atual). Respeita o mesmo princípio da sugestão de compra: **é cálculo, nunca cria OP**.
- **Evidência:** período sem OP devolve `resumo.ops = 0`, `ordens: []`, `insumos: []` — a tela mostra estado vazio com caminho para criar, não número inventado (teste de tela e smoke HTTP).
### `GAP-PROD-EVENTOS` — sem trilha de transições da OP · ✅ **RESOLVIDO na E2**
- **Tipo:** banco + backend + frontend
- **Como foi resolvido:** `ordens_eventos` append-only com `empresa_id` derivado, mesma forma das demais trilhas (`expedicao_eventos`, `proposta_eventos`…). Vocabulário: `criada, liberada, iniciada, apontamento, perda, consumo, parcial, concluida, reaberta, cancelada, atalho, edicao`. `GET /api/ordens/:id/eventos` + painel "Histórico da OP" na tela.
- **Duas decisões que precisam ficar registradas:**
  - `registrarEventoOrdem` **engole erro de propósito** — a trilha é consequência da operação, nunca motivo para desfazê-la.
  - A ordenação é por **`id`**, não por `criado_em`: `apontamento` e `perda` nascem no mesmo milissegundo e o empate deixava a ordem a cargo do banco (o smoke pegou a UI mostrando a perda antes do apontamento).
  - A coluna `dados` é gravada no banco mas **`memdb.decorate()` apaga o campo `dados` em toda leitura da API** (regra geral de segredo, `server/src/memdb.ts:147`). Por isso o conteúdo que o operador precisa ler vai na `mensagem` — inclusive o resumo dos apontamentos anulados numa reabertura.
- **Evidência:** teste de ciclo completo `liberada → iniciada → apontamento → concluida` · smoke HTTP confere a ordem `criada,liberada,apontamento,perda,concluida`.
### `GAP-PROD-CUSTO-SEM-TESTE` — cálculo de custo sem cobertura · ✅ **RESOLVIDO na E2**
- **Tipo:** testes
- **Evidência do gap (antes):** `grep -rln "aplicarPrecoFicha\|recalcularFichaValores" server/test/` → **zero arquivos**; `CustoPage.tsx` sem `.test.tsx`.
- **Como foi resolvido:** `server/test/custo-ficha.test.ts` (13 testes) trava a fórmula `Σ consumo × (1 + perda%/100) × custo_médio + mão de obra + indiretos`, preço `= custo × (1 + margem%)`, recálculo após mudança de consumo, e `aplicarPrecoFicha` (cópia para o produto, regravar, 404, 400 sem produto, auditoria). `client/src/pages/CustoPage.test.tsx` (8 testes) cobre fórmula exibida, totais, "—" para ficha não calculada, busca, estado vazio, erro e RBAC.
- **Bug de permissão encontrado POR estes testes e corrigido:** `fichas` não declara `minPerfil` (o operador precisa editar consumo/perda), então `aplicarPrecoFicha` permitia que **qualquer operador escrevesse custo e preço de venda no produto**. Agora exige gerente/admin no servidor (`exigirGerenteProducao`) e o botão da `FichaDetail.tsx` ficou na mesma régua.
---

## E3 — COMPRAS

### `GAP-COMP-COTACOES` — sem cotação de compra · ✅ **FECHADO na E3**
- **Tipo:** ausência completa
- **Evidência (antes):** `grep -c "CREATE TABLE IF NOT EXISTS cotacoes" db/schema.sql` → **0**. Existe `cotacao_decisoes` (`db/schema.sql:1141`), mas ela pertence ao **portal do cliente** (`venda_id NOT NULL REFERENCES vendas(id)`, campo `responsavel`) — é a decisão do cliente sobre uma cotação de venda, **não** uma cotação de fornecedor. Não confundir os dois domínios. O mesmo vale para o handler `decidirCotacao` de `server/src/portal.ts`, que continua sendo o do portal; o novo é `decidirCotacaoCompra`.
- **Aceite:** `cotacoes` + `cotacao_itens` + `cotacao_fornecedores` com `empresa_id`, decisão que gera pedido de compra de forma idempotente.
- **Como foi fechado (migration 0027):** `cotacoes_compra`, `cotacao_compra_itens`, `cotacao_compra_fornecedores`, `cotacao_compra_precos` — todas com `empresa_id`. Idempotência da decisão garantida em **duas** camadas: `tryUpdateIf` no status (CAS) e o índice único parcial `cotacoes_compra_compra_uniq … WHERE compra_id IS NOT NULL`. Prova real de corrida em `server/test/pg-cotacoes-compra.test.ts`: **3 decisões simultâneas → exatamente 1 pedido**. Nenhum preço é estimado: item sem cotação bloqueia a decisão (409), e proposta com `disponivel: false` aparece riscada no comparativo sem competir no menor preço.

### `GAP-COMP-CUSTOS` — repasse de custo divergente entre os dois caminhos de recebimento · ✅ **FECHADO na E3.1**
- **Tipo:** backend
- **Correção da evidência (re-auditado na E3):** a afirmação original ("não há rotina que
  atualize o custo médio") está **errada**. Existem DOIS caminhos de recebimento e eles se
  comportam diferente:
  • `receberCompra` (`server/src/itens.ts:436`, acionado pela mudança de status para
    `recebido`) **recalcula** `insumos.custo_medio` por média ponderada (`itens.ts:484-488`)
    e grava `custo_unitario: preco` na movimentação.
  • `receberParcial` (`server/src/compras.ts:111`) **não toca** em `custo_medio` e insere a
    `movimentacoes_insumos` **sem `custo_unitario`** (verificado lendo `compras.ts:216-222`).
  Ou seja: receber parcialmente deixa o custo médio do insumo defasado e a movimentação sem
  custo — e é justamente o caminho que a tela de recebimento parcial usa.
  Além disso, **nenhum** dos dois rateia `compras.frete` nem os impostos do item no custo.
- **Aceite:** os dois caminhos convergem para a mesma rotina de custo médio ponderado,
  `custo_unitario` sempre gravado na movimentação, frete rateado por valor de linha, trilha
  de auditoria e teste de arredondamento em centavos.
- **Como foi fechado (migration 0028 + `server/src/custoRecebimento.ts`):** os QUATRO
  caminhos de recebimento (`receberParcial`, `receberCompra`, `estornarCompra` e
  `importarXmlCompra`) agora delegam a **uma** rotina. Regra:
  `C_novo = (S_ant×C_ant + q×C_efetivo)/(S_ant+q)`, com
  `C_efetivo = preço + (freteRateado + impostos)/q`.
  Frete rateado **por valor da linha**, resíduo na última linha (`Σ rateio === frete` ao
  centavo). Imposto **só** o informado — nada é derivado de NCM/CFOP. Lock `FOR UPDATE` no
  insumo/produto, e dois índices únicos parciais
  `uq_mov_{insumos,produtos}_entrada_por_recebimento` sobre `(recebimento_id, item_compra_id)`
  como segunda trava de idempotência no banco. O estorno localiza as entradas por `compra_id`
  (nunca por texto de motivo), usa o `custo_unitario` da própria movimentação e **recusa com
  409** se o estoque já foi consumido ou se o custo ficaria negativo — não zera nada.
- **Bugs encontrados AO FECHAR este gap** (todos provados por teste antes de corrigir):
  1. **Frete cobrado duas vezes.** Cada recebimento parcial rateava o frete **inteiro** da
     compra de novo: 100 un a R$ 50 com R$ 400 de frete, recebidas em 40+60, davam custo médio
     **58** em vez de **54**. Agora o frete é rateado uma única vez ao longo de todos os
     lotes, proporcional ao valor recebido, e `itens_compra.custo_frete_rateado` **acumula**.
  2. **`receberCompra` ignorava `quantidade_recebida`.** Uma compra já recebida em parte que
     fosse marcada como `recebida` recebia a quantidade **cheia** de novo (40 já recebidos +
     100 = 140). Agora entra só o que falta.
  3. **`parcial → cancelado` não estornava.** O gatilho só cobria `recebido → cancelado`,
     então cancelar uma compra recebida pela metade deixava o estoque de insumo para cima
     para sempre.
  4. **Pedido de valor zero devolvia 500.** `reconciliarParcelasPedido` criava parcela de
     R$ 0,00 e estourava `ck_lanc_fin_valor_positivo`. Afetava compra **e** venda (brinde,
     amostra). Agora valor zero não gera conta a pagar/receber.
  5. **`itens_compra.custo_frete_rateado` e `custo_impostos` eram impossíveis de gravar.** As
     colunas foram criadas na 0027 mas nunca declaradas no recurso — e `pgstore.update`
     descarta em silêncio coluna não declarada (`pgstore.ts:251-273`).
- **Prova:** `server/test/custo-recebimento.test.ts` (**19** testes, incluindo 40+60 ≡ 100 e
  lotes de preço diferente) e `server/test/pg-custo-recebimento.test.ts` (**16** testes no
  PostgreSQL real: constraints 23514/23505, três corridas reais, rollback, estorno,
  idempotência e multiempresa A → B → A).
- **A tela faltante foi entregue na E3.2:** `client/src/components/RecebimentoCompraModal.tsx`
  mostra recebido × pendente por item, custo unitário, frete, imposto, custo efetivo, impacto
  projetado no custo médio e no estoque, e exige prévia antes de confirmar. Ver
  `GAP-COMP-RECEBIMENTO-UI`.

### `GAP-COMP-XML-MENU` — importação de XML sem entrada navegável e sem teste · ✅ **FECHADO na E3.2**
- **Tipo:** menu + testes
- **Evidência (antes):** `POST /api/suprimentos/compras/importar-xml` existe e o handler é `importarXmlCompra` (`server/src/suprimentos.ts:383`), mas:
  • `grep -rn "importarXmlCompra\|importar-xml" server/test/ scripts/` → **zero ocorrências**. O parser de NF-e de entrada **não tinha nenhuma cobertura**. (As ocorrências de `nfeProc` em `fiscal.test.ts` são da **emissão** de NF-e, outro caminho.)
  • `MODULES` (`client/src/modules.ts`) não tinha entrada para importação de NF-e.
- **Como foi fechado:** menu **Compras → Importar NF-e** (`modules.ts` id `importar-nfe-compra`, recurso `compras`), página `client/src/pages/ImportarNfePage.tsx` com upload multipart, **prévia obrigatória antes de importar** e lista de pendências por item. No backend, `importarXmlCompra` ganhou o modo `aplicar: false`, que roda **a rotina real dentro de uma transação desfeita** — a prévia não é um cálculo paralelo, é o próprio import com rollback. `resolveProductAndSize` deixou de abortar no primeiro item sem de-para: agora acumula **todas** as pendências e devolve 422 com `details.codigo_fornecedor`, para o comprador resolver de uma vez.
- **Prova:** `server/test/compras-xml-depara.test.ts` (**11** testes com fixture de NF-e real — leiaute `nfeProc/infNFe/ide/emit/det/imposto/ICMSTot/dup`): prévia não grava nada, lista todas as pendências, 422 sem de-para, arquivo que não é NF-e recusado, import real gera compra `recebido` com `compras.frete` gravado + estoque + custo + `mov.custo_unitario`, **409 na segunda importação da mesma `chave_acesso` sem dobrar o estoque**, e isolamento A → B → A com 404. A fixture é dado de teste e nunca é exibida como resposta de provedor.

### `GAP-COMP-DEPARA-MENU` — de-para fornecedor × SKU sem entrada navegável nem teste · ✅ **FECHADO na E3.2**
- **Tipo:** menu + testes
- **Evidência (antes):** o recurso `produto_fornecedor_skus` existia em `RESOURCES` com CRUD, mas `grep -c "produto_fornecedor_skus" server/test/compras.test.ts` → **0**, e nenhuma entrada de menu o alcançava — ele era `internal: true`, então invisível por construção.
- **Como foi fechado (migration 0029):** o recurso saiu de `internal` e ganhou entrada própria **Compras → De-para de fornecedor** (`id: depara-fornecedor`, `resource: produto_fornecedor_skus`), reutilizando o `ModulePage` genérico — não foi criada uma segunda grade. Colunas novas `descricao`, `unidade` e `ativo` (`BOOLEAN NOT NULL DEFAULT true`), mais os índices `produto_fornecedor_skus_produto_idx` e `produto_fornecedor_skus_ativos_idx`. **Sem `delete` de propósito** (`ops: { create, update, delete: false }`): apagar destruiria o rastro das importações que usaram o de-para; o caminho é `ativo: false`.
- **Prova:** CRUD em `server/test/compras-xml-depara.test.ts`; o `UNIQUE (empresa_id, fornecedor_id, codigo_fornecedor)` só existe no PostgreSQL real, então a recusa por duplicidade (23505) e o escopo separado A × B são provados em `server/test/pg-compras-e32.test.ts`.

### `GAP-COMP-CONTAS-MENU` — contas a pagar geradas pela compra sem trilha visível · ✅ **FECHADO na E3.2**
- **Tipo:** ux
- **Evidência (antes):** a compra gerava lançamento financeiro (`financeiro.ts`), mas não havia navegação da compra para a conta gerada — o comprador não tinha como saber que a obrigação existia, muito menos qual parcela venceu.
- **Como foi fechado:** bloco **Contas a pagar** dentro da própria tela da compra (`ContasAPagarDaCompra` em `client/src/pages/OrderPage.tsx`, renderizado para `tipo === 'compra'`), listando parcela, vencimento, valor, forma e status, com totais a pagar / pago / em aberto e atalho textual para **Financeiro → Lançamentos**. A UI **só lê**: `GET /lancamentos_financeiros?f.referencia_tipo=compra&f.referencia_id=<id>`. Nenhum segundo motor de parcelamento foi criado — continua sendo `syncLancamentoCompra`/`reconciliarParcelasPedido`, e a baixa continua no Financeiro. Vazio diferenciado para compra parcial ("nenhuma conta a pagar gerada até o recebimento total") e compra já recebida.
- **Bug encontrado AO FECHAR este gap:** **`receberParcial` devolvia 500 no PostgreSQL real para qualquer compra com `fin_vencimento`.** Colunas `date` voltam do driver como `Date`, e `addMeses` (`financeiro.ts:176`) fazia aritmética de string sobre elas, estourando `RangeError` dentro de `reconciliarParcelasPedido` → `syncLancamentoCompra` → `compras.ts:249`. Os `pg-*.test.ts` antigos nunca pegaram porque nenhum deles setava `fin_vencimento`. Corrigido com `dataISO()` em cinco pontos e `HttpError(422)` para vencimento inválido. Regressão em `server/test/pg-compras-e32.test.ts`.
- **Prova:** smoke ponta a ponta (`scripts/smoke-e2e.mjs`, bloco E3.2): compra `30/60/90` com vencimento 2026-11-09 → parcial não gera conta a pagar → completo gera **3** parcelas somando exatamente o total, numeradas `1/3, 2/3, 3/3`, vencimentos `2026-11-09, 2026-12-09, 2027-01-09`, todas `pendente/despesa` com `referencia_tipo='compra'` → baixa da 1ª pelo Financeiro → cancelamento da compra cancela as três.

### `GAP-COMP-RECEBIMENTO-UI` — recebimento sem tela (só troca de status) · ✅ **FECHADO na E3.2**
- **Tipo:** frontend + backend (prévia)
- **Evidência (antes):** o único jeito de receber era mudar o status da compra para `recebido`,
  o que recebia a quantidade **cheia** sem conferência. `POST /api/compras/:id/receber` e
  `GET /api/compras/:id/recebimentos` existiam, mas nenhum componente do front os chamava
  (`grep -rn "compras/.*receber" client/src` → zero).
- **Como foi fechado:** `RecebimentoCompraModal` (~560 ln) aberto pela própria tela da compra
  por botão dividido ("Registrar recebimento" / "Recebimentos"). Mostra o que já entrou por
  item, deixa informar quantidade, local, frete e imposto por linha, e calcula **antes** o
  custo efetivo e o custo médio resultante. Excesso e quantidade negativa são recusados **no
  cliente, sem chamar a API**. No backend, `receberParcial` ganhou o modo `previsao: true`,
  que devolve `200 { aplicado: false, custos[], itens[], completo, local }` rodando a rotina
  canônica em transação desfeita — mesma abordagem da prévia de XML, para que o número exibido
  seja o número que será gravado.
- **Prova:** `client/src/components/RecebimentoCompraModal.test.tsx` (**17** testes: contadores,
  parcial 100/40/20/40, custo efetivo 54,63 com média 10 → 54,63, frete 160 e impostos vindos
  da API, prévia obrigatória, recusa sem chamada de rede, aviso de que a parcial não gera conta
  a pagar e a completa gera, vazio, "nenhum recebimento", erro + retry nos três caminhos) e
  `server/test/pg-compras-e32.test.ts` (**10** testes no PostgreSQL real).

---

## E4 — ESTOQUE AVANÇADO

### `GAP-ESTQ-MULTIEMPRESA` — ownership nos fluxos especializados de estoque · **GATE E4.2 APROVADO TECNICAMENTE; PR #46 MERGEADO**
- **Tipo:** backend + banco + gate HTTP/PostgreSQL.
- **Escopo de implementação revisado:** grade/detalhe/tamanhos; inventário; movimentações; importação; relatórios/exportações; WooCommerce; ownership de caixas PDV.
- **Implementação no workspace:** handlers usam escopo de empresa; a migration existente `0030_e42_locais_estoque_multempresa.sql` e o espelho em `db/schema.sql` estabelecem constraints/índices. A aprovação foi baseada na evidência executada, não na implementação isolada.
- **Evidência final:** o run [38005819077](https://github.com/petrickmsilva-alt/brobond-erp/actions/runs/38005819077) executou o harness HTTP autenticado e a suíte PostgreSQL real; jobs `testes-postgres` e `verificar` passaram. A contagem da suíte foi 91 pass/0 fail/0 skipped, derivada da invariância do total observado nos dois runs anteriores e do exit 0 do step final; detalhes/proveniência e falhas anteriores estão em [`docs/RELATORIO-E4.2.md`](RELATORIO-E4.2.md).
- **Limite do upgrade:** o runner `migrate()` aplica `db/schema.sql` antes das migrations versionadas; a prova executada preserva `pdv_caixas.local_id=NULL` no upgrade simulado, mas não prova a migration 0030 isolada sobre uma cópia intacta de schema pré-0030. O PostgreSQL minor exato não ficou disponível na API do Actions; a imagem/versão major observada é `postgres:16`.
- **Estado do PR:** o PR #46 (`arena/4cb6e53b-brobond-erp`) foi mergeado em `main` (verificado com `gh pr view 46` na E4.2.1). Este status técnico não autoriza iniciar E4.3.
- **Limites preservados:** E4.3–E4.6, transferência formal, reservas, custo/CMV, devolução e mínimo/máximo avançado seguem fora deste gate. Os gaps P1/crítico/P2 separados permanecem abertos.

### `GAP-ESTQ-DEVOLUCAO-TOTAL` — saldo após devolução total · ✅ **FECHADO na E4.2.1**
- **Origem:** regressão P1 documentada na E4.1 (bloqueador global de release).
- **Regressão reproduzida (antes):** saldo 5 → venda 2 → 3 → devolução total boa 2 → **7** (esperado 5). Reproduzido no PostgreSQL real pelo teste `E4.2.1 PG E2E-1` (`expected 5, actual 7`) no HEAD original, e em memória (`devolução 3: 7 !== 5`).
- **Causa:** `receberDevolucao` somava a entrada da devolução e, ao ver devolução total, cancelava a venda; o estorno da venda cancelada então readicionava todas as saídas `Venda #id`, inclusive as já devolvidas.
- **Correção:** o estorno restaura apenas `saídas − já recebido em devolução` por produto+tamanho (`estornarVenda`, `quantidadeRecebidaPorItem`); o total de "venda devolvida" é acumulado item a item; devolução acima do saldo vendido → 409 transacional, sem movimento; recebimento e criação travam a venda (`SELECT … FOR UPDATE`).
- **Evidência:** `server/test/e421-estoque.test.ts` (devolução 1–12, E2E-1/2/3) — 32/32 em memória; `server/test/pg/e421-estoque-integridade.test.ts` — 10/10 em PostgreSQL real (E2E-1: 5→2→3→2→5, estorno posterior não restaura; E2E-2: 10→6→4→8→recusa 3 com 2 restantes→10; E2E-3: danificado).
- **Limite conhecido (não é este gap):** a devolução de item avariado não volta ao saldo vendável; o financeiro da venda só é revertido na devolução total (comportamento preservado).

### `GAP-ESTQ-PDV-LOCAL-TEXTO` — local de saída por texto no PDV · ✅ **FECHADO na E4.2.1**
- **Origem:** `pdv_caixas.local` (texto) e `vendas.local_saida` (texto) eram a única referência de local; renomear um local desviava a baixa de vendas pendentes.
- **Correção:** `vendas.local_saida_id` (migration 0031, FK composta `(empresa_id, local_saida_id)`, nullable). O PDV grava o ID resolvido a partir do caixa; o faturamento usa o ID quando existe e só usa o texto em venda legada. Editar o texto `local_saida` zera o ID. Sem backfill: vendas e caixas legados ficam com `local_id/local_saida_id IS NULL` e continuam usando o texto.
- **Evidência:** `e421-estoque.test.ts` PDV/local 1–10 (32/32 em memória); `pg/e421-estoque-integridade.test.ts` "PDV: local_saida_id segue o caixa e local de outra empresa é recusado com 404" (PostgreSQL real).
- **Limite conhecido:** o campo legado `pdv_caixas.local` continua existindo ao lado de `local_id`; a remoção dele é decisão administrativa separada.

### `GAP-ESTQ-VENDA-ID` — vínculo formal venda → estoque · ✅ **FECHADO na E4.2.1**
- **Tipo:** banco + backend.
- **Antes:** `movimentacoes` não tinha `venda_id`; o estorno localizava as saídas por texto `Venda #id` (`motivo`).
- **Correção:** migration nova `db/migrations/0031_e421_integridade_estoque.sql` (não altera migrações antigas; espelho em `db/schema.sql`): `movimentacoes.venda_id INTEGER` nullable, FK composta `(empresa_id, venda_id) → vendas(empresa_id, id)`, índice `(empresa_id, venda_id)`. Preenchido pelo faturamento (baixa), pela entrada de devolução e pelo estorno. `venda_id` está na lista de vínculos internos bloqueados em lançamento manual. O texto `Venda #id` continua escrito, mas deixou de ser chave.
- **Sem backfill heurístico (decisão):** saídas anteriores à 0031 **não são associadas** a venda por SKU, data ou texto. Elas ficam com `venda_id IS NULL`. O estorno de venda legada usa o texto exato `Venda #id` **somente** para linhas com `venda_id NULL` da mesma empresa (regra de compatibilidade, sem reescrever dado). A contagem de saídas legadas é informada pela migration via `RAISE NOTICE`. Na simulação de upgrade com dados (banco de teste com 17 movimentações), foram 9 saídas legadas sem `venda_id`.
- **Evidência:** `e421-estoque.test.ts` venda_id 1–7; `pg/e421-estoque-integridade.test.ts` "migração 0031 registrada e colunas/índices/FKs existem" e "FK composta recusa venda_id de OUTRA empresa (23503)"; bootstrap em banco vazio e em banco migrado (duas execuções cada, sem erro).
- **Não tornado NOT NULL:** quebraria o histórico.
- **`itens_venda` sem `uq (empresa_id, id)` nem FK composta (decisão E4.2.1):** não foi adicionado. Nenhum dos três gaps depende disso: `criarDevolucao` só aceita item de `itens_venda` da própria venda (já filtrada por `empresa_id`), e `devolucao_itens.item_venda_id` é conferido no handler. Risco residual: escrita direta no banco fora dos handlers poderia apontar item de outra empresa. Fica como item de endurecimento futuro, não como gap desta entrega.

### `GAP-ESTQ-ORDEM-ID` — vínculo formal OP → estoque · ✅ **RESOLVIDO na E2**
- **Tipo:** banco + backend
- **Evidência do gap (antes):** `movimentacoes` sem `ordem_id`. `producao.ts` gravava `motivo: \`Produção concluída — OP #${id}\`` e o estorno recuperava por `filter: { tipo: 'entrada', motivo: ... }` — renomear a string quebrava o estorno em silêncio.
- **Como foi resolvido:** `movimentacoes.ordem_id REFERENCES ordens_fabricacao(id) ON DELETE SET NULL` + índice + backfill pela 0026 (mesmo padrão seguro de `movimentacoes_insumos`). O `motivo` em texto continua escrito para leitura humana, mas deixou de ser chave de busca.
- **Evidência:** `pg-producao-e2.test.ts` — o backfill roda **o SQL extraído do arquivo 0026**, `ON DELETE SET NULL` preserva a movimentação, e a entrada de produto acabado aparece com `ordem_id` preenchido · smoke HTTP confere `entradas=1 qtd=4` filtrando por `f.ordem_id`.

### `GAP-ESTQ-TRANSFERENCIAS` — transferência sem entidade e sem FK
- **Tipo:** banco + backend
- **Evidência:** `db/schema.sql:525` — `ALTER TABLE movimentacoes ADD COLUMN IF NOT EXISTS transferencia_id INTEGER;` **sem `REFERENCES`**. `grep -c "CREATE TABLE IF NOT EXISTS transferencias" db/schema.sql` → **0** (existe apenas `transferencias_financeiras`). Não há item de menu.
- **Aceite:** entidade `transferencias_estoque` com origem/destino/status, FK real em `movimentacoes.transferencia_id`, transação atômica (saída+entrada) e teste de concorrência.

### `GAP-ESTQ-RESERVA` — sem reserva de estoque
- **Tipo:** ausência completa
- **Evidência:** `politicas_comerciais.reserva_horas` existe como campo (`resources.ts`), mas não há tabela de reserva nem rotina que a efetive. `grep -rn "reserva" server/src/estoque.ts` → zero.
- **Aceite:** reserva com expiração, `disponível = saldo − reservado`, liberação/consumo na venda, teste de duas reservas concorrentes sobre o mesmo saldo.

### `GAP-ESTQ-RASTREABILIDADE` — rastreabilidade de lote não implementada
- **Tipo:** banco
- **Evidência:** nenhuma coluna de lote/evento em `estoques` ou `movimentacoes`.
- **Aceite:** decidir com o dono do produto se lote se aplica à operação; se sim, coluna + vínculo nas entradas de produção e compra. **Marcado como decisão pendente, não como implementado.**

---

## E5 — FINANCEIRO AVANÇADO

O núcleo da P2 está preservado e testado (49/49 em PostgreSQL real, 39/39 no
smoke). Ficam dois gaps de superfície:

### `GAP-FIN-COMISSOES-MENU` — comissões sem entrada própria
- **Tipo:** menu
- **Evidência:** `GET /api/financeiro/comissoes` e `/comissoes/venda/:id` existem e são cobertos por `financeiro-p2.test.ts`. `MODULES` não tem item "Comissões" — a especificação o pede em **Vendas** e em **Financeiro**.
- **Aceite:** uma única entrada (não duas — sem duplicar domínio) com apurado × efetivado × estornado por período e por vendedor.

### `GAP-FIN-CNAB-SAIDA` — CNAB só de retorno
- **Tipo:** backend
- **Evidência:** `server/src/cnab.ts` implementa **parsers** de retorno (CNAB240) — `GET /api/financeiro/cnab/parsers`, `POST /api/financeiro/cnab/importar`. Não há geração de remessa.
- **Aceite:** ou implementar remessa com adapter por banco, ou registrar formalmente que a operação usa o banco direto. **Dependência externa: precisa de layout homologado do banco.**

---

## E6 — FISCAL

### `GAP-FISC-NCM-MENU` — alíquotas por NCM sem tela · 
- **Tipo:** menu + frontend
- **Evidência:** `npm run audit:menu` reporta `[RECURSO_SEM_MENU] O recurso "impostos_ncm" (Alíquotas por NCM) tem CRUD na API mas nenhum código do front o consome`. É a **fonte de imposto do cálculo de margem** (`docs/RELATORIO-P0.md`) e tem `ops: ALL_OPS` com `minPerfil: 'gerente'` — ou seja, é editável pela API sem nenhuma tela.
- **Aceite:** tela em **Cadastros** ou **Vendas → Regras fiscais**, com busca por NCM e validação de 8 dígitos.

### `GAP-FISC-INUTILIZACAO-MENU` — inutilização sem tela
- **Tipo:** menu + frontend
- **Evidência:** `npm run audit:menu` reporta `[RECURSO_SEM_MENU] inutilizacoes_fiscais`. O recurso é read-only (`ops: {create:false, update:false, delete:false}`) e existe `POST /api/fiscal/inutilizar`; não há onde consultar o histórico.
- **Aceite:** histórico de inutilizações visível, com protocolo e justificativa.

**Não homologado (não é gap de código):** a transmissão real à SEFAZ. Os
adapters Focus NFe e PlugNotas existem (`fiscalProvider.ts:601`
`registrarFiscalProvider`) e distinguem `homologacao` de `producao`, mas
**não foram exercitados com credencial real neste ambiente**. Nenhum protocolo,
chave ou status "autorizado" foi fabricado.

---

## E7 — LOGÍSTICA

### `GAP-LOG-PROVEDORES` — cotação/etiqueta/postagem reais não exercitadas
- **Tipo:** integração
- **Evidência:** `ShippingProvider` (`logistica.ts:113`), `criarMelhorEnvio()` (`logistica.ts:277`) e o adapter dos Correios (`CORREIOS_BASE = https://proxyapp.correios.com.br/v1`, linha 428) existem e têm 30 KB de testes. Sem credencial o provedor nulo responde `ok:false, motivo:'nao_configurado'` (`logistica.ts:236`) e ativar Melhor Envio sem `me_token` devolve **409** — comprovado no smoke.
- **Aceite:** rodar cotação + etiqueta + rastreio contra o ambiente de homologação do provedor com credencial real e anexar a resposta. **Depende de credencial e de saída de rede — não pode ser declarado concluído sem isso.**

---

## E8 — COMMERCE

### `GAP-COM-PEDIDOS` — inbox omnichannel inexistente · **CRÍTICO**
- **Tipo:** backend + frontend
- **Evidência:** as tabelas `sales` e `sale_items` existem e a ingestão está implementada (`modules/connectors/ingestion/sale-ingestion.service.ts`), mas `grep -rn "sales" server/src/index.ts` → **zero rotas**. Nenhuma API lista os pedidos ingeridos. A tela `/commerce/pedidos` é `PlannedModule`.
- **Aceite:** `GET /api/commerce/pedidos` com escopo por empresa e canal, inbox com reserva → separação → expedição → rastreio, e a tela ligada. **Sem dado, mostrar vazio — nunca mock.**

### `GAP-COM-PRODUTOS` — catálogo unificado e publicação por canal
- **Tipo:** backend + frontend
- **Evidência:** `/commerce/produtos` é `PlannedModule`; `grep api\\.\\|useApiQuery\\|fetch( client/src/pages/CommerceModulePage.tsx` → **zero ocorrências**. Não há fila de publicação nem status por canal.
- **Aceite:** catálogo unificado com SKU/variação/estoque disponível, mapeamento por canal, fila de publicação com histórico.

### `GAP-COM-WOO-MENU` — WooCommerce funcional mas invisível · **CRÍTICO**
- **Tipo:** menu
- **Evidência:** a integração é **real e oficial**: `server/src/loja.ts` chama a REST API v3 do WooCommerce com Basic Auth (`WOOCOMMERCE_URL/CK/CS`), é idempotente por `vendas.pedido_cliente = 'WOO-<id>'` e recusa item sem SKU conhecido. Tem rotas `/api/marketplace/loja/{status,produtos,pedidos,estoque}` e teste `server/test/loja.test.ts`. **`MODULES` não tem nenhuma entrada** — o operador não tem como chegar lá.
- **Aceite:** entrada no menu **Integrações** com status da conexão, diagnóstico SKU × loja, importação de pedidos e envio de estoque — e a credencial só em configuração segura.
- **Nota:** este gap passou despercebido porque a auditoria automática cobre recursos (`RESOURCES`), não endpoints soltos. Ver `GAP-E1-AUDIT-BLINDSPOT`.

### `GAP-COM-TRENDS` — trends com dados reais do ERP
- **Tipo:** frontend
- **Evidência:** `/commerce/trends` é `PlannedModule`. Os dados reais já existem em `/api/negocios/{resumo,abc,canais,margens}` — falta ligar.
- **Aceite:** curvas por SKU/canal vindas do motor analítico. **Proibido interpolar ou estimar ponto.**

### `GAP-COM-DELIVERY` — delivery ligado ao domínio real
- **Tipo:** frontend
- **Evidência:** `/commerce/delivery` é `PlannedModule`, mas `envios` + `expedicao` já são o domínio real e completo.
- **Aceite:** fila de kits prontos consumindo `/api/envios` e `/api/vendas/:id/expedicao`. Não criar um segundo domínio de entrega.

### `GAP-COM-WEBHOOK-CONECTOR` — sincronização automática dos conectores
- **Tipo:** integração
- **Evidência:** `POST /api/connectors/:provider/sincronizar` é manual; o webhook público dos conectores existe (`publicConnectorsRouter`). A sincronização periódica por conector não foi comprovada.
- **Aceite:** agendamento por conector com `ultimo_sync`, erro e logs visíveis, e idempotência testada.

---

## E9 — RELATÓRIOS

### `GAP-REL-CENTRAL` — central incompleta
- **Tipo:** backend + frontend
- **Evidência:** os relatórios existentes (extraídos de `relatorios.ts`) são
  `abc`, `comissoes`, `dre`, `estoque-minimo`, `estoque-posicao`, `faturamento`,
  `insumos-minimo`, `movimentacoes-periodo`, `producao-periodo`,
  `razao-financeiro`, `vendas` — **11**.
  A especificação pede também: **Produtos, Compras, Fiscal, Logística,
  Clientes, Representantes, Rentabilidade, Gerenciais**.
- **Aceite:** arquitetura reutilizável (filtro por período/empresa/canal/produto/categoria/cliente/fornecedor/representante), exportação CSV/XLSX/PDF, e cada relatório novo com teste de contrato. Rentabilidade já tem endpoint (`/api/financeiro/rentabilidade`) — falta virar relatório exportável.

---

## E10 — ADMINISTRAÇÃO

### `GAP-ADMIN-EMPRESAS-MENU` — cadastro de empresas sem tela · **CRÍTICO**
- **Tipo:** menu + frontend
- **Evidência:** `grep -c "'/empresas'" client/src/modules.ts` → **0**. O recurso `empresas` existe em `RESOURCES` com CRUD e há `GET /api/empresas/ativa` e `empresasApi.ts`, mas não existe tela para cadastrar empresa, endereço, regime tributário ou concessões de acesso. Hoje uma empresa nova só entra por SQL.
- **Aceite:** tela **Administração → Empresas** (adminOnly) com CNPJ validado, regime, configuração fiscal e a lista de usuários com acesso.

### `GAP-ADMIN-IMPORTACAO` — migração sem tela central
- **Tipo:** frontend + backend
- **Evidência:** `server/src/importacao.ts` lê CSV e XLSX (`exceljs`), tem `/importar/{modelo,preview,confirmar}` e cobre 5 tipos (`IMPORT_TIPOS` em `client/src/components/ImportModal.tsx`): produtos, clientes, fornecedores, insumos, saldos de estoque. Falta: **dry-run explícito**, **relatório persistido**, **rollback** e **tela central de migração**. Não há teste dedicado (`grep -rln importacao server/test` → nenhum arquivo com teste de importação).
- **Aceite:** tela central com histórico de importações, dry-run, erros por linha exportáveis e rollback quando a operação for reversível. **Nunca importar dado inválido silenciosamente.**

### `GAP-ADMIN-SESSOES` — sessões do próprio usuário
- **Tipo:** ux
- **Evidência:** `GET /api/auth/sessoes` e `DELETE /api/auth/sessoes/:sid/revogar` existem; a gestão de sessões de terceiros está em `UsuariosPage`. Falta a visão "minhas sessões" na tela de configuração.
- **Aceite:** lista de sessões ativas do próprio usuário com revogação.

### `GAP-ADMIN-RBAC-NOMENCLATURA` — perfis com nome diferente da especificação
- **Tipo:** nomenclatura
- **Evidência:** a especificação pede **membro / gerente / administrador**. O sistema usa **operador / gerente / admin** (`PERFIS` em `resources.ts`). O modelo é equivalente; o rótulo diverge.
- **Aceite:** decidir com o dono do produto. **Não renomear sem migrar** — `usuarios.perfil` é dado persistido e `PERFIL_RANK` (`services.ts`) depende dos valores exatos. Registrado como decisão pendente.

---

## E11 — UX FINAL

### `GAP-UX-AUDIT-RESPONSIVO` — responsividade e acessibilidade não auditadas
- **Tipo:** ux
- **Evidência:** os componentes existem (`ui.tsx`, `ui-kit.tsx`, `ui-kit-negocios.tsx` com testes) e o `ComponentCatalog` está em `/dev/componentes`. **Nenhum teste de teclado/ARIA nem verificação em tablet/mobile foi executado nesta fase.**
- **Aceite:** varredura por tela com navegação por teclado, foco visível, `aria-label` em controles de ícone e quebra em 360 px / 768 px / 1280 px.

### `GAP-UX-CADEIAS` — cadeias de navegação incompletas
- **Tipo:** ux
- **Evidência:** as cadeias da especificação têm elos sem link: produto → estoque funciona (ProductDetail mostra a grade); compra → recebimento → estoque → financeiro tem elos sem atalho (`GAP-COMP-CONTAS-MENU`); OP → consumo → estoque não tem trilha navegável.
- **Aceite:** cada elo da cadeia com atalho clicável e breadcrumb de origem.

---

## E12 — HOMOLOGAÇÃO · **todos críticos**

Nenhum dos quatro fluxos foi executado ponta a ponta neste ambiente. O smoke
existente (`scripts/smoke-e2e.mjs`, 39/39) cobre superfícies de P1/P2 — gateway,
webhook idempotente, OFX/FITID, CNAB, caixa, logística sem credencial — mas
**não percorre** as cadeias completas.

### `GAP-E2E-VENDA`
Cliente → Pedido → Pagamento → Estoque → Fiscal → Expedição → Financeiro → BI.
**Aceite:** script executado contra PostgreSQL real, com asserção em cada elo
(saldo baixado, documento fiscal criado, expedição no estado final, lançamento
financeiro gerado, BI refletindo a venda) e teste A→B→A de isolamento.

### `GAP-E2E-COMPRA`
Fornecedor → Pedido → NF/XML → Recebimento → Estoque → Custo → Financeiro.
**Aceite:** idem, incluindo recebimento parcial, divergência e repasse de custo
(depende de `GAP-COMP-CUSTOS`).

### `GAP-E2E-PRODUCAO`
BOM → OP → Insumo → Produção → Produto acabado → Estoque → Custo.
**Aceite:** idem, com saldo negativo bloqueado (409) e consumo vinculado por FK
(depende de `GAP-PROD-CONSUMO-VINCULO` e `GAP-ESTQ-ORDEM-ID`).

---

## TRANSVERSAIS

### `GAP-E1-TESTE-FUSO` — teste dependente de fuso ✅ **RESOLVIDO NESTA FASE**
- **O que era:** `client/src/pages/Dashboard.negocios.test.tsx:218` montava o
  fixture "vence hoje" com o dia **local** do processo; a tela compara com o
  dia civil de **America/Sao_Paulo** (`dataISO`, `client/src/lib/periodo.ts`).
  Entre 00:00 e 03:00 UTC os dois divergem e o teste falha — inclusive no CI.
- **Evidência da falha:** reproduzida no baseline `e6cb2f0`, em 2026-10-09
  01:01 UTC: `Tests 1 failed | 175 passed (176)`.
- **Correção:** o fixture passou a usar `dataISO(new Date())`, a mesma função da
  tela. **Resultado: 11/11 no arquivo e 176/176 na suíte do front.**

### `GAP-E1-AUDIT-BLINDSPOT` — auditoria não cobre endpoints soltos
- **Tipo:** ferramenta
- **O que é:** `npm run audit:menu` cruza `MODULES` × `RESOURCES` × rotas × RBAC ×
  `empresa_id`. Endpoints que não passam por um recurso — como
  `/api/marketplace/loja/*` — não são verificados quanto a entrada navegável.
  Foi exatamente assim que o WooCommerce funcional ficou invisível
  (`GAP-COM-WOO-MENU`).
- **Aceite:** inventariar as rotas do `index.ts` e exigir que cada uma esteja
  vinculada a um módulo, a uma tela ou a uma lista explícita de rotas de
  integração.

### `GAP-E1-PRISMA-VALIDATE` — `prisma validate` não roda neste sandbox
- **Tipo:** ambiente
- **Evidência:** o `validate` exige baixar o `schema-engine`; o sandbox só
  alcança `registry.npmjs.org`. O job `verificar` do CI (`.github/workflows/ci.yml`)
  roda `npx prisma validate` com sucesso. **O schema Prisma não foi tocado
  nesta fase.**
- **Aceite:** nenhum — é limitação de ambiente, registrada para não ser
  confundida com gate pulado.

---

### `GAP-EXPEDICAO-ETAPA-PG` — expedição falha no PostgreSQL real · ✅ **FECHADO na E4.2.3** (AUD-01)
- **Tipo:** banco + backend (divergência entre código e CHECK).
- **Evidência executada (antes):** `pg/e421-estoque-integridade.test.ts` falhou ao embalar com `new row for relation "expedicao_eventos" violates check constraint "expedicao_eventos_etapa_valida"`. O CHECK criado em `db/migrations/0024_p1_comercial_logistica.sql` (espelhado em `db/schema.sql`) aceita apenas `separacao`, `conferencia`, `embalagem`, `expedicao`. O código grava `registrarEvento(…, alvo)` com `alvo = 'embalada'` (e `'expedida'`). Em memória o CHECK não existe, por isso a suíte em memória não pegou o defeito. Reconfirmado na E4.2.3 em PostgreSQL real: HTTP 500 / SQLSTATE 23514, venda presa em `conferida`, sem evento `embalada`.
- **Impacto:** o fluxo de expedição não completava em PostgreSQL; a venda não chegava a `expedicao_etapa = expedida` pelo caminho real.
- **Como foi fechado (E4.2.3):** migration nova `db/migrations/0032_e423_expedicao_vocabulario.sql` (0024 intocada) substitui o CHECK pelo vocabulário canônico `pendente, separacao, conferida, embalada, expedida` — o mesmo de `vendas.expedicao_etapa`; sem mapeamento artificial (`embalada→embalagem`). Linhas históricas são preservadas sem conversão (CHECK NOT VALID quando existirem; `VALIDATE CONSTRAINT` quando o conjunto estiver limpo; contagens em `RAISE NOTICE`). `db/schema.sql` atualizado (CHECK inline + bloco espelho). `expedicao.ts` grava eventos no vocabulário canônico.
- **Evidência (depois):** `server/test/pg/e423-expedicao-postgresql.test.ts` (testes 1–3): `embalada` e `expedida` persistem; `expedicao_eventos` grava `separacao, conferida, embalada, expedida` na ordem; o CHECK recusa `embalagem/expedicao/conferencia` em escrita nova; upgrade de banco com linhas legadas preserva os dados e restringe escritas novas. `test:pg` 110/110 em banco vazio.

### `GAP-EXPEDICAO-CONFERENCIA-PG` — divergência da conferência não persiste em PostgreSQL · ✅ **FECHADO na E4.2.3** (AUD-02)
- **Tipo:** backend + banco (serialização JS → JSONB).
- **Evidência executada (antes):** a conferência reprovada enviava arrays JS (`esperado/lido/faltando/sobrando`) direto para colunas JSONB; o driver `pg` converte array JS em literal de array Postgres (`{"000"}`), que não é JSON — SQLSTATE **22P02**, a API respondia **400** ("Valor inválido em um dos campos.") e `divergencias_conferencia` ficava **vazia**. Reproduzido em PostgreSQL real na E4.2.3.
- **Como foi fechado (E4.2.3):** `pgstore.ts` serializa campos `type: 'json'` com `JSON.stringify` no ponto único de persistência (mesmo mecanismo já adotado na auditoria e no payload fiscal); sem segundo mecanismo, sem tabela paralela, sem mudança no domínio de divergências. A operação persiste a divergência (JSONB válido), o evento (`conferida`/`divergencia`, `dados.divergencia_id`) e a auditoria em transação íntegra e responde **HTTP 422** (não 400) no padrão de erro do ERP. A tela de expedição passou a renderizar os totais sobre o JSONB real (antes `NaN`).
- **Evidência (depois):** `pg/e423-expedicao-postgresql.test.ts` (testes 4–5): caso A aprovado sem divergência e sem baixa; caso B responde 422 com `jsonb_typeof(...) = 'array'` nas 4 colunas, conteúdo persistido conferido (lido, esperado, faltando), etapa preservada (`separacao`), zero movimentações, evento ligado à divergência; e o fluxo continua (conferência seguinte aprova).

### `GAP-EXPEDICAO-SEM-TESTE-PG` — expedição sem teste E2E em PostgreSQL · ✅ **FECHADO na E4.2.3** (AUD-05)
- **Tipo:** testes.
- **Evidência executada (antes):** nenhum teste PostgreSQL exercitava `separar → conferir → embalar → expedir`; o CI passava porque a suíte PG desviava para o PDV (`pg/e421-estoque-integridade.test.ts` registrava a limitação).
- **Como foi fechado (E4.2.3):** `server/test/pg/e423-expedicao-postgresql.test.ts` — 9 testes em PostgreSQL real cobrindo: upgrade sem backfill; vocabulário canônico; caso A/B da conferência (422 + JSONB); **E2E completo** (empresa → cliente → produto → estoque → venda → itens → separar → conferir → embalar → expedir) com estoque `X − q` baixado uma única vez, `venda_id`/empresa corretos, eventos canônicos na ordem e financeiro lançado; **rollback** (expedição que falha não deixa estado parcial); **multiempresa** (B opera registros de A → 404 em separar/conferir/embalar/expedir/eventos/resolve-divergência); **concorrência** (duas expedições simultâneas → uma baixa, um evento final, saldo coerente). Complemento em memória: vocabulário dos eventos travado em `expedicao.test.ts`.
- **Evidência (depois):** `test:pg` **110 pass · 0 fail · 0 skipped** em banco vazio (101 da E4.2.1 + 9 novos); reexecução da suíte nova sobre banco populado também 9/9.

### `GAP-ESTQ-MEMSTORE-TX` — transação em memória sem isolamento nem exclusão · **P2** · registrado na E4.2.1, **não corrigido**
- **Tipo:** backend (modo demonstração/teste).
- **Evidência:** `server/src/memdb.ts` `transaction()` ignora `options.isolation` e não tem mutex; o rollback restaura um snapshot tirado antes da transação, o que não é seguro com transações concorrentes no mesmo processo.
- **Tratamento:** as provas de concorrência da E4.2.1 rodam somente em PostgreSQL real. O modo demonstração não deve ser usado para validar concorrência. Também não há FK em memória (ex.: `DELETE` de venda com movimentos não é recusado no modo demonstração, mas é recusado no PostgreSQL).
- **Aceite futuro:** mutex por empresa no MemStore ou recusa explícita de transações concorrentes; ou declarar o MemStore fora de qualquer caminho de produção.

## FORA DE ESCOPO (registrado para não virar "gap" repetido)

| Item | Motivo |
|---|---|
| Série diária de faturamento no Meu Negócio | Documentado em `docs/ETAPA-2.1-GAPS.md`; exige agregado novo no motor analítico |
| Bloco antifraude no painel | Nenhuma fonte de risco/chargeback no domínio; inventar violaria a regra 30 |
| Compras atrasadas por data | `/api/dashboard` entrega `comprasPendentes` sem datas; exige agregado dedicado |
| `brobond-ai-commerce` | Proibido por regra. Varredura no repositório não encontrou nenhuma referência |
