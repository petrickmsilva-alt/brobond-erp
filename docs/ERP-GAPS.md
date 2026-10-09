# BROBOND ERP — GAPS

**Fase E1 — Auditoria estrutural.**
Baseline auditado: `e6cb2f0` (`main`) · Data: 2026-10-09 · Branch: `arena/3b3ee997-brobond-erp`

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

| Fase | Gaps | Críticos |
|---|---|---|
| **E2 — Produção** | 8 | 3 |
| **E3 — Compras** | 5 | 1 |
| **E4 — Estoque avançado** | 5 | 2 |
| **E5 — Financeiro avançado** | 2 | 0 |
| **E6 — Fiscal** | 2 | 0 |
| **E7 — Logística** | 1 | 0 |
| **E8 — Commerce** | 6 | 2 |
| **E9 — Relatórios** | 1 | 0 |
| **E10 — Administração** | 4 | 1 |
| **E11 — UX final** | 2 | 0 |
| **E12 — Homologação** | 3 | 3 |
| Transversais | 3 | 0 |
| **Total** | **42** | **12** |

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

### `GAP-PROD-ESTADOS` — máquina de estados incompleta · **CRÍTICO**
- **Tipo:** banco + backend + frontend
- **O que falta:** a especificação pede `PLANEJADA → LIBERADA → EM_PRODUÇÃO → PARCIAL → CONCLUÍDA` (+ `CANCELADA`).
- **Evidência:** `db/schema.sql:258` declara `status TEXT DEFAULT 'planejada' -- planejada, em_producao, concluida, cancelada`. Não existe `liberada` nem `parcial`. Não há constraint `CHECK` na coluna — qualquer string é aceita (verificado no banco real: `information_schema` não retorna check constraint para `ordens_fabricacao.status`).
- **Aceite:** constraint `CHECK` com os estados válidos + transições validadas no servidor + teste de transição ilegal (409) + teste de concorrência em duas conclusões simultâneas.

### `GAP-PROD-PERDAS` — sem quantidade perdida
- **Tipo:** banco + backend
- **Evidência:** `grep -n "perdid" db/schema.sql server/src/producao.ts` → **zero ocorrências**. `ordens_fabricacao` tem `quantidade` e `itens_ordem.produzido`, e nada para perda.
- **Aceite:** coluna `quantidade_perdida`, registro por apontamento, perda entra no custo real, movimentação de insumo vinculada.

### `GAP-PROD-CUSTO-OP` — sem custo previsto × real na OP
- **Tipo:** banco + backend
- **Evidência:** `grep -n "custo_previsto\|custo_real" db/schema.sql` → zero. O custo é calculado na **ficha técnica** (`fichas_tecnicas`) e aplicado ao produto por `/fichas/:id/aplicar-preco`; a OP não guarda nem o previsto nem o realizado.
- **Aceite:** `custo_previsto` gravado na liberação, `custo_real` acumulado no consumo e na conclusão, diferença exposta na tela.

### `GAP-PROD-CONSUMO-VINCULO` — consumo de insumo sem vínculo formal · **CRÍTICO**
- **Tipo:** banco
- **Evidência:** `movimentacoes_insumos` (`db/schema.sql:358-367`) tem `insumo_id`, `quantidade`, `custo_unitario`, `motivo`, `usuario_id`, `data` — **sem `ordem_id`**. O estorno localiza o consumo por texto: `server/src/producao.ts:240` faz `if (!String(m.motivo || '').startsWith(\`Consumo — OP #${id}\`)) continue;`. Renomear o padrão da string quebra o estorno silenciosamente.
- **Aceite:** `movimentacoes_insumos.ordem_id` com FK + índice + backfill pelo padrão de texto existente + estorno passando a usar a FK.

### `GAP-PROD-APONTAMENTOS` — sem apontamento de produção
- **Tipo:** ausência completa
- **Evidência:** `grep -c "CREATE TABLE IF NOT EXISTS apontamentos" db/schema.sql` → **0**.
- **Aceite:** apontamento parcial por operador/turno, alimenta `produzido`, `perdido` e o custo real, permite o estado `PARCIAL`.

### `GAP-PROD-PLANEJAMENTO` — sem planejamento de produção
- **Tipo:** ausência completa
- **Evidência:** `grep -c "CREATE TABLE IF NOT EXISTS planejamento" db/schema.sql` → **0**.
- **Aceite:** plano por período com capacidade, puxando OPs planejadas; nunca gera OP sozinho (mesmo princípio da sugestão de compra).

### `GAP-PROD-EVENTOS` — sem trilha de transições da OP
- **Tipo:** banco
- **Evidência:** existem `expedicao_eventos`, `envio_eventos`, `proposta_eventos`, `documentos_fiscais_eventos`, `comissoes_eventos` — **não existe `ordens_eventos`**. A OP só tem a trilha genérica em `auditoria`.
- **Aceite:** `ordens_eventos` append-only com empresa derivada por trigger, mesma forma das demais trilhas.

### `GAP-PROD-CUSTO-SEM-TESTE` — cálculo de custo sem cobertura
- **Tipo:** testes
- **Evidência:** `grep -rln "aplicarPrecoFicha\|recalcularFichaValores" server/test/` → **zero arquivos**. Só `client/src/pages/FichaDetail.tsx` consome. `CustoPage.tsx` não tem `.test.tsx`.
- **Aceite:** teste unitário do cálculo (consumo × (1+perda) × custo médio + mão de obra + indiretos), teste de `/fichas/:id/aplicar-preco` e teste de renderização da `CustoPage`.

---

## E3 — COMPRAS

### `GAP-COMP-COTACOES` — sem cotação de compra · **CRÍTICO**
- **Tipo:** ausência completa
- **Evidência:** `grep -c "CREATE TABLE IF NOT EXISTS cotacoes" db/schema.sql` → **0**. Existe `cotacao_decisoes` (`db/schema.sql:1141`), mas ela pertence ao **portal do cliente** (`venda_id NOT NULL REFERENCES vendas(id)`, campo `responsavel`) — é a decisão do cliente sobre uma cotação de venda, **não** uma cotação de fornecedor. Não confundir os dois domínios.
- **Aceite:** `cotacoes` + `cotacao_itens` + `cotacao_fornecedores` com `empresa_id`, decisão que gera pedido de compra de forma idempotente.

### `GAP-COMP-CUSTOS` — sem repasse de custo do recebimento
- **Tipo:** backend
- **Evidência:** `insumos.custo_medio` existe e é lido pelo cálculo de custo (`producao.ts:121`), mas não há rotina que atualize o custo médio a partir do recebimento com nota (impostos e frete rateados). `grep -n "custo_medio" server/src/compras.ts` → sem escrita.
- **Aceite:** recebimento com NF recalcula o custo médio ponderado, com trilha de auditoria e teste de arredondamento em centavos.

### `GAP-COMP-XML-MENU` — importação de XML sem entrada navegável e sem teste
- **Tipo:** menu + testes
- **Evidência:** `POST /api/suprimentos/compras/importar-xml` existe e o handler é `importarXmlCompra` (`server/src/suprimentos.ts:383`), mas:
  • `grep -rn "importarXmlCompra\|importar-xml" server/test/ scripts/` → **zero ocorrências**. O parser de NF-e de entrada **não tem nenhuma cobertura**. (As ocorrências de `nfeProc` em `fiscal.test.ts` são da **emissão** de NF-e, outro caminho.)
  • `MODULES` (`client/src/modules.ts`) não tem entrada para importação de NF-e.
- **Aceite:** testes do parser (fornecedor, CNPJ, itens, SKU, NCM, quantidade, preço, impostos, de-para, empresa) + item no menu **Compras** com preview, validação e erros por linha.

### `GAP-COMP-DEPARA-MENU` — de-para fornecedor × SKU sem entrada navegável nem teste
- **Tipo:** menu + testes
- **Evidência:** o recurso `produto_fornecedor_skus` existe em `RESOURCES` com CRUD, mas `grep -c "produto_fornecedor_skus" server/test/compras.test.ts` → **0**, e nenhuma entrada de menu o alcança (`npm run audit:menu` não avisa porque ele está na lista de sub-recursos).
- **Aceite:** manutenção do de-para acessível pela tela do fornecedor e/ou pela importação de XML, com teste de resolução de SKU.

### `GAP-COMP-CONTAS-MENU` — contas a pagar geradas pela compra sem trilha visível
- **Tipo:** ux
- **Evidência:** a compra gera lançamento financeiro (`financeiro.ts`), mas não há navegação da compra para a conta gerada.
- **Aceite:** link compra → conta a pagar e conta a pagar → compra de origem.

---

## E4 — ESTOQUE AVANÇADO

### `GAP-ESTQ-VENDA-ID` — vínculo formal venda → estoque · **CRÍTICO**
- **Tipo:** banco
- **Evidência executada contra PostgreSQL real:** as colunas de `movimentacoes` após o bootstrap completo são
  `id, tipo, produto_id, tamanho_id, local, quantidade, motivo, usuario_id, data, local_id, local_destino, local_destino_id, transferencia_id, compra_id, estornado, estornado_em, estornado_por, movimentacao_estorno_id, empresa_id`.
  **Não existe `venda_id`.** O estorno de venda localiza as saídas por texto:
  `server/src/itens.ts:390` filtra `motivo: \`Venda #${pedido.id}\`` e
  `itens.ts:394` re-filtra `String(m.motivo) === \`Venda #${pedido.id}\``.
- **Aceite:** migração adding `venda_id INTEGER REFERENCES vendas(id)` + índice `(empresa_id, venda_id)` + backfill seguro a partir do padrão de texto + código passando a usar a coluna + teste A→B→A de multiempresa sobre o novo vínculo.

### `GAP-ESTQ-ORDEM-ID` — vínculo formal OP → estoque · **CRÍTICO**
- **Tipo:** banco
- **Evidência:** mesma consulta acima — sem `ordem_id`. `server/src/producao.ts:160` grava `motivo: \`Produção concluída — OP #${id}\`` e `producao.ts:204` recupera por `filter: { tipo: 'entrada', motivo: \`Produção concluída — OP #${id}\` }`.
- **Aceite:** idem, com `ordem_id` + FK + backfill + teste.

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

## FORA DE ESCOPO (registrado para não virar "gap" repetido)

| Item | Motivo |
|---|---|
| Série diária de faturamento no Meu Negócio | Documentado em `docs/ETAPA-2.1-GAPS.md`; exige agregado novo no motor analítico |
| Bloco antifraude no painel | Nenhuma fonte de risco/chargeback no domínio; inventar violaria a regra 30 |
| Compras atrasadas por data | `/api/dashboard` entrega `comprasPendentes` sem datas; exige agregado dedicado |
| `brobond-ai-commerce` | Proibido por regra. Varredura no repositório não encontrou nenhuma referência |
