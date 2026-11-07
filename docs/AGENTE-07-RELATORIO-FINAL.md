# Agente 07 — Relatório final do saneamento da unificação comercial

**Missão:** corrigir integralmente os 15 achados (A06-01 … A06-15) da auditoria
do Agente 06.
**Base:** `main` em `727c0c18262cd2834b270dbda74cb57d9af96d7a` (integração
documental pela PR #110).
**Regra respeitada:** nenhuma nova arquitetura comercial foi iniciada; o escopo é
saneamento e estabilização.

> A auditoria do Agente 06 (`AGENTE-06-*.md`) permanece **imutável** como registro
> do diagnóstico original. Este documento é o registro das correções do Agente 07.

---

## A. Identificação Git

| Item | Valor |
|---|---|
| Repositório | `petrickmsilva-alt/brobond-erp` |
| Branch de trabalho | `agente-07-saneamento-comercial` |
| Branch de destino | `main` |
| SHA inicial | `727c0c18262cd2834b270dbda74cb57d9af96d7a` |
| SHA final | preenchido no merge (ver PR) |
| PR | preenchida na abertura (ver PR) |

---

## B. Resultado por achado

| ID | Achado | Causa raiz | Correção | Arquivos | Teste | Resultado |
|---|---|---|---|---|---|---|
| A06-01 | Autoridade de preço | Importador usava `line_items[].price` como preço do item | Política única `decidirPrecoItem`: ERP vence; remoto é evidência (`preco_externo_recebido`); divergência registrada; negociado só com autorização | `commerce/woocommerce/precoAutoridade.ts`, `pedidos.ts`, `loja.ts`, `reconciliacao.ts`, `resources.ts`, `db/migrations/0103`, `db/schema.sql` | `agente07-comercio-saneamento.test.ts` (A06-01) | **Corrigido e testado** |
| A06-02 | Estoque disponível | Legado publicava físico sem descontar reservas/empenhos/bloqueios e somava locais | Legado passa a consumir o motor canônico (`disponivelDoProdutoVendavel`) | `loja.ts` (`enviarEstoqueLojaInterno`), `commerce/catalogo.ts` | `agente07-comercio-saneamento.test.ts` (A06-02) | **Corrigido e testado** |
| A06-03 | Identidade de pedidos | `vendaExistente` adotava `WOO-<id>` sem provar a loja | Identidade forte por `store_key`; legada só com prova de mesma origem; conflito registrado | `pedidos.ts`, `reconciliacao.ts` | `agente07-comercio-saneamento.test.ts` (A06-03) | **Corrigido e testado** |
| A06-04 | Estoque de variações | Saldo consultado no filho, não no pai+tamanho | `disponivelDoProdutoVendavel` resolve o vínculo canônico pai+tamanho | `commerce/catalogo.ts`, `woocommerce/estoque.ts`, `publicacao.ts` | `agente07-comercio-saneamento.test.ts` (A06-04) | **Corrigido e testado** |
| A06-05 | Vendas ausentes no BI | Projeção pulava toda venda com `pedido_externo_id` | Pula só a venda já representada (`sales.operational_venda_id`); Woo passa a projetar | `negocios.ts` | `agente07-comercio-saneamento.test.ts` (A06-05) | **Corrigido e testado** |
| A06-06 | Comissões secundárias | Efetivação/relatório liam só o principal congelado; reapuração pós-recebimento sem ajuste | Livro por representante (`alvosComissaoDaVenda`); `reconciliarEfetivacaoAposReapuracao` gera ajuste; relatório por participante | `comissoes.ts`, `comercial.ts` | `agente07-comissoes.test.ts` | **Corrigido e testado** |
| A06-07 | RBAC de comissões | Handlers só exigiam leitura de Vendas/Representantes | `exigirAcessoComissao`: gerente/admin; representante só a própria linha; operador sem vínculo recusado (403) | `comissoes.ts` | `agente07-comissoes.test.ts`, `agente07-carteira-representante.test.ts` | **Corrigido e testado** |
| A06-08 | Rematch de itens | `unchanged` retornava antes de refazer `sale_items` | `reconciliarItensDaIngestao` refaz o match quando o vínculo muda, preservando idempotência | `modules/connectors/ingestion/sales.service.ts` | `connectors.test.ts` (A06-08) | **Corrigido e testado** |
| A06-09 | Painéis sem isolamento | Agregadas iteravam todas as lojas sem filtrar tenant | `lojasDaEmpresa`/`statusStoresDaEmpresa`; `painelDaLoja` 404 para loja de outro tenant | `woocommerce/registry.ts`, `painel.ts`, `rotas.ts` | `woocommerce-multistore-rotas.test.ts` (A06-09) | **Corrigido e testado** |
| A06-10 | Identidade comercial | Canal analítico colapsava tudo em `BROBOND` | ADR-008: 5 conceitos distintos; canal analítico por origem; compatibilidade preservada | `docs/ADR-008-IDENTIDADE-CANAL-COMERCIAL.md` | Revisão documental + projeção (A06-05) | **Decisão arquitetural implementada e documentada** |
| A06-11 | Quantidade mínima atacado | Só metadado publicado; importação não validava | `validarMinimoAtacado` no backend (Multi-Store e legado); rejeição registrada; exceção auditada | `woocommerce/precos.ts`, `pedidos.ts`, `loja.ts`, `reconciliacao.ts` | `agente07-comercio-saneamento.test.ts` (A06-11) | **Enforcement comprovado no ERP** |
| A06-12 | Preços sem `store_key` | Override compartilhado entre RETAIL e WHOLESALE | `commerce_precos.store_key` + unicidade por loja; consulta por loja com queda para legado | `db/migrations/0103`, `db/schema.sql`, `precoAutoridade.ts`, `catalogo.ts`, `publicacao.ts`, `reconciliacao.ts`, `resources.ts` | `agente07-comercio-saneamento.test.ts` (A06-12) | **Corrigido e testado** |
| A06-13 | Reconciliação parcial | Reimportação de pedido parcial retornava `ignorado` | `reconciliarItensDeVendaExistente` adiciona itens que resolvem agora (só em cotação; nunca remove) | `pedidos.ts` | `agente07-comercio-saneamento.test.ts` (A06-13) | **Corrigido e testado** |
| A06-14 | RBAC de representantes | `representantes.usuario_id` era vínculo cadastral, não papel | Carteira resolvida no servidor; recorte de listagem/leitura/escrita; fail-closed | `empresasAcesso.ts`, `empresa.ts`, `auth.ts`, `services.ts`, `resources.ts` | `agente07-carteira-representante.test.ts` | **Corrigido e testado** |
| A06-15 | Cutover sem runbook | Rotas legadas e eventos sem `store_key` coexistindo | Runbook completo (pré-requisitos, validações, sequência, rollback, indicadores) | `docs/AGENTE-07-RUNBOOK-CUTOVER-LEGADO-MULTISTORE.md` | Revisão documental | **Runbook completo** |

---

## C. Resultado técnico (gates executados)

Ambiente: Node local; PostgreSQL **16.14** (`server_version_num=160014`); banco
descartável por execução; `psql` presente.

| Gate | Comando | Resultado |
|---|---|---|
| Typecheck | `npm run typecheck` | **PASS** (domain + server + client) |
| Lint | `npm run lint` | **PASS**, **0 errors** (615 warnings pré-existentes) |
| Testes client | `npm --workspace client test` | **PASS**: 133 arquivos, 1.165 testes |
| Testes server | `npm --workspace server test` | **PASS**: 2.271 testes; 2.183 aprovados, 88 ignorados (PG), **0 falhas** |
| Testes PostgreSQL | `npm run test:pg` | **PASS**: 451 testes reais; **0 fail/skip/todo** |
| Build | `npm run build` | **PASS** |
| Auditoria arquitetura | `npm run architecture:audit` | **PASS** (0 erros de coerência) |
| Auditoria menu/RBAC | `npm run audit:menu` | **PASS** (0 erros) |
| Go-live estrutural | `npm run go-live:audit` | **PASS estrutural** (0 erros; FULL_GO_LIVE: NÃO — homologação externa pendente) |
| Commerce go-live | `npm run commerce:go-live` | **PASS estrutural** (41 P0 ok, 0 falhas) |
| Bootstrap sync | `prod-db-02-bootstrap-sync` | **PASS** (bootstrap regenerado, sem DML) |
| Migrations | `0103_agente07_preco_autoridade_store_key.sql` | Aditiva, idempotente, com rollback documentado |

**Regressões de contrato tratadas nesta missão:**

1. `server/src/services.ts` — `updateRecord` deixou de retornar o registro
   atualizado (código inalcançável detectado pelo lint). Corrigido: a transação
   é capturada e devolvida após o efeito pós-commit da carteira.
2. `server/test/pg-p2.test.ts` — o contrato de `registrarComissaoPorRecebimento`
   mudou de `Row | null` para `Row[]` (A06-06, um evento por representante). O
   teste foi atualizado preservando a garantia de não dupla efetivação.

---

## D. Estado final do Git

Preenchido após o merge (ver seção A e o rodapé).

---

## E. Riscos residuais

- **Correção implementada e validada em teste:** A06-01 a A06-09, A06-11 a A06-14
  (memória + PostgreSQL 16.14 reais onde aplicável).
- **Decisão arquitetural implementada e documentada:** A06-10 (ADR-008).
- **Runbook completo (não executado):** A06-15.
- **Dependência externa NÃO homologada:** a aplicação efetiva do
  `_brobond_atacado_min_qtd` **pela loja externa** não é presumida nem afirmada.
  O ERP garante o enforcement interno (A06-11); a garantia externa depende de
  plugin/consumer e de homologação real.
- **Depende de autorização do Diretor:** o cutover real (A06-15) e a decisão de
  domínio público `/loja` × RETAIL (ADR-008 §6). Nenhum dos dois foi executado.
- **Bloqueios de produção mantidos:** nenhuma loja real foi tocada; nenhuma
  credencial real usada; nenhuma publicação/importação em massa; nenhum deploy.

---

## F. Declaração final

Ver a mensagem final da missão para o estado (`CONCLUÍDO` / `NÃO CONCLUÍDO`),
que depende da confirmação de `merged=true` da PR.
