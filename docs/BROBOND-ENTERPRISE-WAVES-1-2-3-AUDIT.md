# BROBOND ENTERPRISE — auditoria das ondas 1, 2 e 3

**Data:** 2026-10-29. **Base:** `origin/main` `2f4c9db9ab8be6bf60ab5ac1697786e2f4e636ae`. **Branch:** `arena/5e0b7882-brobond-erp`. A branch solicitada com outro nome não foi criada nem trocada: o ambiente fixa a branch desta sessão. O histórico `4744752` não estava disponível; não se afirma comparação com ele. Esta auditoria atualiza os achados, sem apagar `ERP-MASTER-ARCHITECTURE.md`, `ERP-3.0-ARCHITECTURE-BASELINE.md`, `ERP-3.0-GAP-MATRIX.md`, `architecture/payment-engine*.md` e `BROBOND-ENTERPRISE-FINAL-AUDIT.md`.

**Critério:** IMPLEMENTADO significa que o recorte descrito tem implementação e prova indicadas; PARCIAL significa caminho real com lacunas de escopo ou evidência; NÃO IMPLEMENTADO não deve ser substituído por mock, tabela ou documentação. Não houve homologação de provedores. Ondas 4 e 5 não foram executadas.

## 1. Readiness

| Gate | Resultado | Motivo |
|---|---|---|
| `WAVE1_CODE_READY` | **NO** | Fechamento limitado, conciliação/payout/disputas e integração contábil/fiscal incompletos; não há prova de ponta a ponta integral. |
| `WAVE1_INTERNAL_GO_LIVE` | **NO** | Sem aceite operacional integrado, controle completo de períodos, ensaio de segurança/DR/carga e homologação. |
| `WAVE2_CODE_READY` | **NO** | WMS avançado, ciclo de requisições e cobertura MRP/TMS não são completos. |
| `WAVE2_INTERNAL_GO_LIVE` | **NO** | Cadeia integral procurement/manufacturing/WMS não comprovada operacionalmente. |
| `WAVE3_CODE_READY` | **NO** | B2B/OMS/marketplaces/returns e E2E completo ainda parciais. |
| `WAVE3_INTERNAL_GO_LIVE` | **NO** | Sem aceite de ponta a ponta com expedição, finanças e canais externos reais. |
| `EXTERNAL_HOMOLOGATION_READY` | **NO** | Não há credenciais/contratos validados e também existem lacunas de implementação. |
| `FULL_ENTERPRISE_GO_LIVE` | **NO — WAVES 4 AND 5 NOT EXECUTED** | Além das lacunas acima, ondas 4/5 explicitamente não executadas. |

Os scripts que dizem `CODE_STRUCTURE_READY: YES` ou `STRUCTURAL_CHECKS_PASSED` verificam presença/coerência de estruturas; não revogam esses gates de escopo.

## 2. Onda 1 — Core Enterprise

| Domínio | Estado | Evidência / limite real |
|---|---|---|
| Payment Engine, métodos e roteamento | **PARCIAL** | Intenções, attempts, operações, idempotência, capabilities, routing por empresa e adapters reais. PIX Mercado Pago/PagBank, Stripe Checkout e manual têm caminhos implementados; cobertura de métodos por provider é incompleta. Sem PAN/CVV no contrato do Engine. |
| Webhook, late payment e refund | **PARCIAL** | Inbox/assinatura e consultas; `0076` cria fila durável, com API/UI e correlação; encerrado não ressuscita. CAS na conversão, releitura transacional, refund cumulativo e captura integral fail-closed. Job também consulta cancelados/expirados e operações ativas; capacidade/SLA não comprovados. Estorno legado histórico sem prova não fecha revisão; Mercado Pago pode fechá-la com consulta que comprova referência, moeda e valor integral. Chargeback legado exige revisão separada. |
| Settlement/MDR/payout/conciliação | **PARCIAL** | `0073` e `0074`: importação manual validada, versões/correção, vínculo de extrato e divergência após refund/chargeback. Não ingere automaticamente extratos/MDR de todos providers; saldo acumulado isolado não prova autoria de cada refund concorrente. |
| Disputas | **PARCIAL** | Registro, transições e evidência interna idempotentes/auditados e RBAC; sem envio de evidências aos providers, sem cobertura de todos eventos e atualização automática de toda mudança posterior do pagamento. |
| Finance/AP/AR/tesouraria | **PARCIAL** | Títulos, baixas, extrato, conciliação, contas a pagar por compras e reversões existentes; não foi demonstrada operação unificada de todos os fluxos e fronteiras de competência. |
| Contabilidade e períodos | **PARCIAL** | Escrituração importada e reversões auditadas; `0071` bloqueia **somente escrituração importada** em período fechado. Não é fechamento integrado de financeiro, fiscal e pagamentos nem comprova imutabilidade de um ledger geral independente. |
| Fiscal | **PARCIAL** | Funcionalidades existentes mantidas; não foram inventadas regras/layouts SEFAZ. Sem homologação de certificado/SEFAZ nem comprovação de cobertura fiscal completa. |
| Outbox e auditoria | **PARCIAL** | `0070` adiciona fencing/índices e hash v2; lease/retry/DLQ/replay e auditoria existentes, entrega at-least-once. Sem exactly-once remoto ou âncora externa que detecte reescrita integral/truncamento. |
| Segurança/observabilidade | **PARCIAL** | Empresa por autorização, RBAC, campos sensíveis reduzidos no inbox, criptografia, IDs e audit trail nos caminhos exercitados. Há cache de autorização, dependências com advisories e não foi feita certificação completa de segregação, redaction, pen-test ou observabilidade distribuída. |

## 3. Onda 2 — Supply Chain

| Domínio | Estado | Evidência / limite real |
|---|---|---|
| Procurement | **PARCIAL** | Compras/cotações e recebimento real → estoque/custo → AP quando aplicável; `0077` adiciona chave/hash com replay, bloqueio de legado ambíguo, serialização e retries locais. Prova PG inclui três processos, uma entrada e isolamento. A cadeia completa requisição → cotação → pedido → recebimento → estoque → AP não foi demonstrada como um único E2E; workflow de requisição empresarial não está completo. |
| WMS | **PARCIAL** | `0072` acrescenta armazém/zona/endereço a locais oficiais; picking/conferência, packing, expedição e inventário existentes. Putaway dirigido, wave, slotting e replenishment empresariais não estão completos; não existe segundo saldo. |
| MRP/capacidade/manufacturing | **PARCIAL** | Ficha/BOM multinível, calendário, OP, demanda, reserva, consumo por OP e compras no horizonte; leituras paginadas, janela até 730 dias, sem prazo destacado e alertas de ciclo/profundidade. Sem snapshot global em todas leituras, planejamento finito/ótimo e alocação de todo consumo; não foi provado E2E completo do planejamento à ordem e custeio. |
| TMS/carriers/tracking | **PARCIAL** | Fluxos de expedição/remessa/rastreamento e configurações existentes; não se afirma integração/homologação de todos carriers, contratação, etiquetas, ocorrências ou conciliação de frete. |

## 4. Onda 3 — Commerce

| Domínio | Estado | Evidência / limite real |
|---|---|---|
| PIM/product master | **PARCIAL** | Produto/variante ERP é a fonte; projeção de catálogo e publicação, preço e disponibilidade existentes. PIM empresarial completo não está demonstrado. |
| Pricing/promoções/cupons | **PARCIAL** | Cálculo de preço e desconto determinístico no servidor; cupom com guarda de uso; promoções avançadas e regras B2B complexas não estão integralmente cobertas. |
| Search/merchandising/storefront | **PARCIAL** | Busca e vitrine locais; snapshot e leitura paginada abrangem produto/preço após a primeira página. Sem prova de escala/search/merchandising corporativo e WCAG completo. |
| OMS/omnichannel/B2B | **PARCIAL** | `commerce_pedidos` projeta a `sales`/`vendas`; estados de pagamento/pedido e reserva, prevenção de reabertura e integração à expedição existem. Fulfillment, pagamento e devoluções não formam ainda um OMS empresarial completamente separado e comprovado; B2B é parcial. |
| Marketplace | **PARCIAL** | Adaptadores/publicações reais sem sucesso simulado. Woo usa credenciais vinculadas ao tenant, paginação limitada e fail-closed; worker/despublicação usam lock/CAS. Uma chamada já enviada pode ter efeito remoto após despublicação. Mercado Livre, Nuvemshop, Woo e outros sem homologação; Instagram individual rejeitado por design. |
| Returns | **PARCIAL** | Devolução/recebimento repõe apenas item bom e devolução total reverte venda/financeiro nos cenários existentes. O encadeamento return → receipt → refund eletrônico → estoque → financeiro não está demonstrado integralmente. |

## 5. Banco e migrations

A base anterior já incluía `0069_payment_engine.sql`. Na branch em relação à base `2f4c9db`:

| Migration | Recorte aditivo |
|---|---|
| `0070_foundation_integrity.sql` | versão de hash da auditoria e `claim_versao`/índices do Outbox. |
| `0071_periodos_contabeis.sql` | competência por empresa, estado e auditoria — apenas escrituração importada. |
| `0072_wms_enderecamento.sql` | hierarquia nos locais canônicos com FK de empresa. |
| `0073_payment_payouts.sql` | payout e vínculo de settlements por empresa. |
| `0074_payment_operations.sql` | disputas/evidências/eventos e correção/desvinculação versionada de payout. |
| `0075_creators_partnerships.sql` | perfis/campanhas/parcerias/atribuições para checkout existente; não cria novo ledger/estoque. |
| `0076_payment_late_reviews.sql` | uma revisão por empresa/pedido, FK composta com pedido/cobrança/intenção, status e índice de fila. |
| `0077_purchase_receipt_idempotency.sql` | chave completa + hash, check de formato e índice único parcial; preserva registros antigos. |

`db/schema.sql` foi alinhado. O gate 16.14 migrou banco novo, sem reset de banco preexistente; backups do usuário não foram tocados. `db:validate` do Prisma **não passou**: o download de `binaries.prisma.sh` foi bloqueado pela rede. Isso não é prova de validação Prisma. A validação SQL/migrations PG executada é distinta.

## 6. API, UI e integrações

- Pagamentos: `/api/commerce/payments/late-reviews[/:id]` (gestão, tenant, paginação e `private, no-store`), transações/refunds/disputes/payouts/reconciliation e operações com `Idempotency-Key`; `/api/gateway/webhooks/:provider` valida assinatura antes do efeito. Dados usados para auditar não incluem mensagem arbitrária de provider. Não se afirma redaction universal de todos os logs legados.
- Períodos: `/api/financeiro/periodos[/:competencia]` e `/:competencia/{fechar,reabrir}`; escopo limitado acima. Procurement: `/api/compras/:id/{receber,recebimentos}`; MRP/capacidade: `/api/producao/{mrp,capacidade}`. Commerce: produtos, preços, publicações, promoções, cupons, pedidos, reservas, fulfillment e delivery em `/api/commerce/...`; loja pública mantém cálculo no servidor.
- UI: `/commerce/pagamentos/atrasados`, transações/repasses/disputas, detalhe do pedido, formulário de recebimento e página de produção/MRP consomem APIs reais e exibem estados/erros. Catálogo público usa `/catalogo/:token/produto/:id` e `/catalogo/:token/pedido`; portal usa `/portal/:token/pedido/:id`, com confirmação inline. Removidas as exceções de sobreposição operacional nesses dois arquivos. A auditoria UX ainda registra exceções para navegação global/menu móvel e captura de clique de infraestrutura; não foi executado ensaio visual/WCAG AA completo em 1440/1280/768/390/320.
- Integrações: Mercado Pago/Stripe/PagBank mencionados aqui são **contratos/adapters em código**, não certificações; frete manual configurado é dado local, não carrier homologado. Mercado Pago, Stripe, PagBank, WooCommerce, Mercado Livre, Nuvemshop, SEFAZ e carriers: credenciais, contratos, fluxos de sandbox/produção e aceite externos pendentes. Nenhuma credencial real foi criada ou usada para declarar sucesso.

## 7. Testes e gates executados

| Comando / evidência | Resultado |
|---|---|
| `npm test` | **PASS:** servidor 1.545 aprovados, 0 falhas, 68 skips PG no runner sem banco; client 1.046 aprovados em 119 arquivos. Os 68 skips não são tratados como pass de memória. |
| `npm run test:pg` | **PASS:** PostgreSQL 16.14, banco vazio, `psql` real, **343 aprovados, 0 falhas/skips/TODO**. Inclui PG real de concorrência/idempotência, RBAC/tenant, Commerce, compras e pagamentos. |
| `npm run smoke:pg -- --keep` | **PASS:** 396/396 verificações HTTP contra API real e banco criado para o smoke, mantido para inspeção. |
| `npm run typecheck`, `npm run build` | **PASS** domínio/servidor/cliente e build/PWA. |
| `npm run lint` | **PASS** com 0 erros e **585 warnings**; warnings não são mascarados. |
| `npm run audit:menu`, `npm run audit:ux`, `npm run architecture:audit`, `npm run go-live:audit` | **PASS estrutural**, com avisos. Não equivalem a WCAG, segurança ou go-live. |
| `npm run test:payments` | **PASS:** 21 testes. |
| `DATABASE_URL=... npm run commerce:go-live` | **PASS estrutural**, 42 P0 e 9/9 tabelas; não homologa parceiros. |
| `DATABASE_URL=... npm run payment:go-live` | **PASS estrutural e banco**; o próprio script declara homologação e escopo pendentes. |
| `DATABASE_URL=... npm run commerce:final-go-live` | **BLOCKED / exit 1**: sem homologação externa e sem prova integral do escopo. |
| `npm run db:validate` | **BLOCKED / exit 1**: engine Prisma indisponível por restrição de rede. |
| `npm audit` e `npm audit --omit=dev` | **exit 1:** 8 pacotes afetados, 4 moderados e 4 baixos; nenhum alto/crítico. Ver §9. |

Na primeira execução concorrente dos gates finais, dois testes de UI expiraram no carregamento e o gate PG bloqueou 13 skips porque o `psql` não estava no `PATH`. Após configurar o cliente e executar os gates separadamente, ambos passaram sem reduzir ou desabilitar testes.

Provas específicas incluem: callback obsoleto depois de refund; CAS entre conversão e estado terminal; refund insuficiente permanece UNCERTAIN e recupera sem novo write; captura parcial recusada; polling de encerrados/operação ativa; webhook legado tardio sem baixa; valor remoto divergente e chargeback; idempotência de recebimento com prefixo antigo >160 caracteres, processo concorrente e custo/AP; MRP com outra empresa; 1.001 produtos/preço; credenciais Woo por tenant e corrida de despublicação. Os mocks de HTTP representam somente respostas de teste. `PublicosSemModal.test.tsx` cobre URLs diretas e legadas, carrinho, confirmações inline, histórico e troca de token com respostas atrasadas; não prova layout ou acessibilidade visual.

## 8. E2E solicitado versus evidência

| Jornada | Evidência real | Status |
|---|---|---|
| Produto → preço → promoção/cupom → carrinho → frete → pagamento → pedido/reserva → OMS → WMS → remessa → finanças | `server/test/pg/commerce-e2e.test.ts`: catálogo, preço, cupom, frete manual, checkout, reserva, webhook **mock de teste** e conversão; expedição e financeiro têm testes separados. | **PARCIAL**, não uma prova única incluindo WMS, remessa real e finanças. |
| Requisição → cotação → pedido → recebimento → estoque → AP | Recebimento/custo/AP e concorrência em `enterprise-wave2-purchase.test.ts`; cotação tem testes próprios. | **PARCIAL**, sem toda a cadeia unificada. |
| Manufacturing | Testes de OP/apontamento/consumo/reabertura, MRP/capacidade e concorrência PG separados. | **PARCIAL**, sem prova integral de planejamento → execução → custo. |
| Payment → settlement → conciliação → Finance → Accounting | `gateway-cadeia-pagamento-e2e.test.ts` e testes de payout/contábil em PG exercitam trechos reais com provider de teste. | **PARCIAL**, não uma jornada única nem provider externo homologado. |
| Return → receipt → refund → estoque → financeiro | `devolucao-e2e.test.ts` prova recebimento, estoque e reversão financeira; refund eletrônico tem provas próprias. | **PARCIAL**, falta encadeamento real de refund no provider. |

## 9. `npm audit`: pacote, severidade, caminho, impacto e correção

Os números contam pacotes/vias, não necessariamente oito falhas independentes. `npm audit` e `--omit=dev` reportaram o mesmo conjunto em 2026-10-29. `npm ls` confirma os caminhos abaixo:

| Pacote(s) e severidade | Caminho instalado / impacto | Correção proposta / breaking |
|---|---|---|
| `react-router@6.30.6` e `react-router-dom@6.30.6` — **moderada** | Client → router; [GHSA-wrjc-x8rr-h8h6](https://github.com/advisories/GHSA-wrjc-x8rr-h8h6) descreve open redirect via backslash e [GHSA-337j-9hxr-rhxg](https://github.com/advisories/GHSA-337j-9hxr-rhxg) afeta hidratação SSR. O projeto é SPA Vite, mas navegações/links devem ser revisados; a evidência não prova ausência de exploração. | npm recomenda `react-router-dom@7.18.5`, **major/breaking**; planejar migração e regressão de rotas, redirects, segurança e UI. IDs gerados em links de erros agora são codificados, não uma correção da biblioteca. |
| `uuid@8.3.2` e `exceljs@4.4.0` — **moderada** | Server → ExcelJS → uuid; [GHSA-w5hq-g745-h8pq](https://github.com/advisories/GHSA-w5hq-g745-h8pq) trata bounds em v3/v5/v6 com buffer. O uso observado em ExcelJS é v4; import/export XLSX existem, mas não foi certificada toda a superfície. | npm sugere `exceljs@3.4.0` (**mudança de major/downgrade**, potencial breaking), não aplicação cega. Avaliar versão corrigida/override com compatibilidade e testes de importação/exportação. |
| `deepmerge@4.3.1`, `@rollup/plugin-node-resolve@16.0.3`, `workbox-build@7.4.1`, `vite-plugin-pwa@1.3.0` — **baixa** | Client → PWA → Workbox → plugin Rollup → deepmerge; [GHSA-gcqx-w48m-w2h4](https://github.com/advisories/GHSA-gcqx-w48m-w2h4) descreve prototype poisoning. Caminho é de build/configuração; avaliar dados não confiáveis no pipeline. | npm sugere `vite-plugin-pwa@0.2.1`, **downgrade/breaking**; buscar upstream/override seguro e testar build/service worker antes da troca. |

Não foi usado `npm audit fix --force` nem upgrade indiscriminado. Verificar novamente advisories/versões antes de cada release.

## 10. Pendências priorizadas

- **P0:** completar e validar fechamento integrado financeiro/fiscal/pagamentos/contabilidade; garantir reconciliação operacional de operações ambíguas/atribuição de refunds concorrentes; revisar e corrigir advisories de router/ExcelJS conforme risco antes de exposição; homologar segurança, DR e consistência de ponta a ponta. Não declarar operação financeira pronta enquanto essas provas faltarem.
- **P1:** WMS avançado e ciclo completo de procurement/manufacturing; E2Es integrados da §8; ingestão automática de repasse/MDR e evidências de disputa; B2B/OMS/returns e integração remota com retry/reconciliação; provar escala e políticas do job de pagamentos.
- **P2:** homologações de APIs externas após implementação/credenciais, tratamento de eventos específicos e observabilidade/SLOs, sem simular sucesso; corrigir advisory do pipeline PWA; testes visuais/responsivos e auditoria WCAG AA.
- **P3:** otimização de MRP/capacidade, merchandising e refino da UX; reduzir warnings técnicos. Ondas 4 e 5 são escopo não executado, não uma aprovação tácita.

## 11. Documentação adicional

Arquitetura: `architecture/enterprise-waves-1-2-3.md`; operação: `operations/enterprise-operations.md`; pagamentos: `payments/enterprise-payments.md`; supply chain: `supply-chain/enterprise-supply-chain.md`; commerce: `commerce/enterprise-commerce.md`. Evidências brutas de execução ficaram no ambiente de teste, não em Git. Este relatório não contém credenciais reais.
