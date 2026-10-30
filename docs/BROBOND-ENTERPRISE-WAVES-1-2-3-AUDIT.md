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

## 12. Closure Pass sobre `d28f33a` — atualização de 2026-10-29

Esta seção atualiza o diagnóstico anterior; os resultados históricos das seções anteriores continuam identificados como tais. O ponto de partida exato desta passagem é `d28f33a2a2cc914e8f15abc12593d4cde1c3a518`, na branch `arena/5e0b7882-brobond-erp`. Nenhum dado existente ou arquivo em `backups/` foi resetado. As migrations `0078`, `0079` e `0080` são aditivas e não inferem fatos para registros antigos.

### 12.1 Correções implementadas e limites

- **Extrato e baixa:** `server/src/extrato.ts`, `financeiro.ts`, `modules/payments/application/payouts.ts` e `0078` ligam linha bancária ao efeito financeiro específico, incluindo filho de baixa parcial; baixa, vínculo e auditoria são uma transação. A mesma trava PG por empresa protege vínculo de repasse, conciliação e divergência; o CAS de baixa também compara saldo observado. Replay só retorna idempotente se estado, título/filho, conta, direção, valor e data da baixa ainda conferirem. Não há baixa automática por valor/data. Linhas históricas sem prova do efeito ou da data devem ser revisadas; não foram retroativamente marcadas como corretas.
- **Entrada bancária:** OFX/CSV exige data e valor válidos, rejeita conteúdo malformado sem importar parte do arquivo e preserva centavos com vírgula no formato `data;valor;descrição`. Moeda OFX explicitamente diferente de BRL é recusada; ausência de moeda não a comprova. CSV entre aspas não é suportado. Uma linha sem identificador cujo conteúdo coincide com outra bloqueia com `409 EXTRATO_SEM_IDENTIFICADOR_AMBIGUO`, pois não é possível saber se é replay ou outra operação; duplicação indistinguível no próprio arquivo e FITIDs que só diferem em caixa também exigem revisão. Não se afirma que hash de conteúdo identifica uma transação bancária.
- **CNAB:** cada linha nova, a baixa e seu vínculo/auditoria são atômicos; caso a baixa falhe, a transação reverte antes de tentar registrar divergência. Em liquidação, valor pago e data válidos são obrigatórios; o número da cobrança deve ser único e pertencer à conta informada. Um número de documento coincidente com o ID interno e valor não é prova de identidade. O parser FEBRABAN existente é um contrato interno de teste, sem homologação por banco. Linhas `importada` deixadas por versões antigas podem demandar revisão manual; não são automaticamente reaplicadas no replay.
- **Tenancy e recorrências:** referências de conta/categoria/centro na criação manual e conta de baixa são checadas por empresa; uma baixa não atualiza compra/venda de outra empresa. Busca de categorias, parcelas e origem na sincronização financeira foi recortada por empresa. A geração de recorrências usa trava, CAS e transação conjunta para lançamento/avanço/auditoria; recupera agenda histórica cujo lançamento já exista e avança semanal/mensal/anualmente. O escopo do botão respeita a empresa ativa; o cron administrativo existente continua sujeito ao guard de admin. `pgstore.audit` usa READ COMMITTED após a trava para não fixar snapshot anterior ao escritor concorrente.
- **Data e volumes:** `0080` registra `data_baixa` sem reescrever dados legados. O resumo de caixa usa a data da baixa quando conhecida; para dados antigos sem ela mantém fallback para a data histórica do lançamento, que não prova quando o dinheiro entrou. Para webhook sem data externa, a data da baixa é a data da operação local, **não prova a data efetiva do provedor**. Resumo financeiro, investidores, rentabilidade e recebíveis deixam de truncar silenciosamente em limites fixos e leem sob snapshot; o resumo ainda materializa listas em memória e precisa de paginação/agregação eficiente e ensaio de carga.
- **Mercado Pago:** respostas com referência, moeda, total ou refund ausentes/inválidos não são transformadas em sucesso; `null` não vira estorno zero. Testes usam fixtures internas, não demonstram que cada resposta real do provedor terá esses campos nem constituem homologação externa.
- **Cotação:** `server/src/cotacoesCompra.ts` lê todas as páginas da empresa, rejeita propostas recusadas, preço/frete/prazo inválidos e escolhas repetidas, inclui frete no pedido e verifica fornecedor. Um pedido canônico não mistura vencedores de fornecedores distintos: a operação bloqueia e o usuário deve separar a cotação ou escolher um fornecedor. `0079` registra SHA-256 da decisão para replay equivalente; pedido histórico sem assinatura e replay alterado retornam 409. Não foi implementado desmembramento automático multi-fornecedor. `compras.ts` e CRUD legado ainda permitem transições/recebimento sem comprovação de aprovação em todos os caminhos; não afirmar que aprovação é obrigatória.
- **UI de extrato:** lista e revisão em `/financeiro/extrato`, `/financeiro/extrato/:id` e `/financeiro/extrato/:id/editar`, sem diálogo operacional, com paginação e erros explícitos. A API valida perfil/tenant e usa `private, no-store` em detalhe/lista. Há testes focais React e HTTP com sessão; não substituem ensaio visual real em 1440/1280/768/390/320 nem auditoria WCAG AA.

### 12.2 Readiness recalculado — não aprovado

| Gate | Resultado | Motivo e módulo | Risco | Ação para fechar |
|---|---|---|---|---|
| `WAVE1_CODE_READY` | **NO** | `server/src/financeiroPeriodos.ts`, `modules/payments/application/{payouts,disputes}.ts`: fechamento é só de escrituração importada; repasse/contabilidade/fiscal/disputas não estão integrados de ponta a ponta. | Fechar com pendência ou estado financeiro/fiscal divergente. | Implementar preflight determinístico, bloqueio de todos os movimentos e reabertura auditada, integrar impactos comprovados e provar corrida/isolamento. |
| `WAVE1_INTERNAL_GO_LIVE` | **NO** | Os mesmos módulos e operações financeiras; jornadas de provider, chargeback e fechamento integral não foram aceitas. | Caixa, fiscal ou razão não refletirem corretamente eventos tardios. | Executar jornada D e aceite operacional, segurança, carga e recuperação com evidências. |
| `WAVE2_CODE_READY` | **NO** | `server/src/{compras,cotacoesCompra,wmsEnderecamento,producaoCapacidade}.ts`: requisição e desmembramento de compras, aprovação obrigatória, putaway/replenishment e ordem planejada integrada permanecem incompletos. | Compra indevida, saldo/local incorreto ou plano insuficiente. | Fechar transições canônicas, requisição→cotação, WMS e MRP→OP com invariantes e RBAC. |
| `WAVE2_INTERNAL_GO_LIVE` | **NO** | `server/test/pg/closure-procurement.test.ts` prova somente cotação→pedido→recebimento→AP; manufacturing/WMS não têm jornada integral. | Falha operacional entre departamentos mesmo com testes isolados verdes. | Executar jornadas B/C completas em PG, incluindo replays, concorrência e Empresa A/B. |
| `WAVE3_CODE_READY` | **NO** | `server/src/commerce`, `server/src/logistica.ts` e adapters de canais: OMS/WMS, devolução/refund eletrônico e integrações não fecham a cadeia. | Pedido expedido ou devolução paga sem sincronização correta de estoque/financeiro. | Integrar estados e efeitos canônicos com idempotência e evidência de provider. |
| `WAVE3_INTERNAL_GO_LIVE` | **NO** | `server/test/pg/{commerce-e2e,devolucao-e2e}.test.ts` são jornadas parciais. | Falha não observada entre checkout, expedição, retorno e financeiro. | Executar jornadas A/E integrais com retries/tenant e aceite dos canais. |
| `EXTERNAL_HOMOLOGATION_READY` | **NO** | Adapters de pagamento, bancos, fiscal e canais não certificados. | Resposta de teste ser confundida com contrato/aceite real. | Resolver lacunas internas e homologar cada provider/SEFAZ/carrier com ambiente e credenciais autorizados. |
| `FULL_ENTERPRISE_GO_LIVE` | **NO — WAVES 4 AND 5 NOT EXECUTED** | Ondas 4/5 fora de escopo. | Escopo empresarial restante não foi implementado/testado nesta passagem. | Planejar e executar ondas 4/5 separadamente após fechar os gates anteriores. |

### 12.3 E2E solicitado — critério integral

| Jornada | Evidência da passagem | Resultado integral |
|---|---|---|
| A Commerce | `commerce-e2e.test.ts` cobre catálogo/checkout/reserva/webhook de teste; WMS, remessa e financeiro ainda não compõem a mesma prova integral. | **FAIL / parcial** |
| B Procurement | `closure-procurement.test.ts` em PG prova cotação→pedido aprovado→recebimento→estoque/custo→AP→baixa, frete e replay; testa 501 itens e concorrência. Requisição e todos os caminhos de aprovação ainda faltam. | **FAIL / parcial** |
| C Manufacturing | Testes PG de MRP e OP existem, mas não foi provada cadeia única demanda→ordem planejada→OP→consumo→output→custo. | **FAIL / parcial** |
| D Payment→fechamento | Provas focais de baixa/extrato/CNAB/repasse e testes PG de payment/contábil existem separadamente; fechamento integrado e impacto de disputa faltam. | **FAIL / parcial** |
| E Returns | `devolucao-e2e.test.ts` cobre retorno/estoque/reversão local, não encadeia refund eletrônico comprovado e financeiro completo. | **FAIL / parcial** |

### 12.4 Pendências e operação segura

- **P0:** fechamento global com pendências determinísticas e `CLOSE_BLOCKED`/`CLOSED`; bloqueio transacional de todos os movimentos e reabertura auditada; contabilização/fiscal de eventos de pagamento, disputa, chargeback, MDR e ajustes; atribuição de refunds concorrentes. Sem isso não há autorização de fechamento empresarial. Referências bancárias/financeiras legadas sem evidência exigem revisão humana.
- **P1:** WMS avançado, procurement com requisição e compra multifornecedor, aprovação em todos os caminhos, manufacturing planejado, OMS e returns integrados; provar as cinco jornadas completas e limites de job, concorrência e tenant. Testes de partes não são aprovação das jornadas.
- **P2:** homologar providers, bancos, canais e fiscal sem simular sucesso; acessibilidade e layout em dispositivos reais; paginação eficiente/agregações de grandes resumos; observabilidade, DR e carga. A auditoria UX registra exceções de navegação/infraestrutura e não prova ZERO MODAL global ou WCAG AA.
- **P3:** reduzir warnings e otimizar planejamento/operação. As ondas 4/5 não foram executadas.

### 12.5 Execução final, migrations e segurança

Os seguintes comandos foram executados em série sobre o mesmo código. Os testes PG usaram PostgreSQL **16.14** e `brobond_closure_gate_20261029d` **vazio**; o migrador operacional aplicou todas as migrations até `0080`. Resultado:

| Verificação | Resultado real |
|---|---|
| `npm run test:pg` | **PASS 365/365**, 0 falhas, 0 skips, 0 TODOs. Inclui banco, concorrência de processos, retry, rollback, auditoria e recortes A/B; não transforma provas parciais nas jornadas integrais da §12.3. |
| `npm test` — server | **PASS 1.552**, 0 falhas e **68 skips**: os testes marcados exigem `DATABASE_URL`; todos os arquivos identificados têm prefixo `pg-` e foram executados no gate PG separado. |
| `npm test` — client | **PASS 1.049/1.049**, em 120 arquivos. |
| `npm run smoke:pg -- --keep` | **PASS 396/396**, contra PG real em banco de teste criado pelo próprio smoke. |
| `npm run typecheck` / `npm run build` | **PASS / PASS** (domain, server e client). |
| `npm run lint` | **PASS com 0 erros e 585 warnings**; warnings não foram desabilitados. |
| `npm run test:payments` | **PASS 22/22** (mocks internos não são homologação). |
| `audit:menu`, `audit:ux`, `architecture:audit`, `go-live:audit` | **PASS estrutural**. O menu registra avisos de rotas sem entrada direta, incluindo extrato (acessível por link em Financeiro); UX mantém quatro exceções de navegação/infraestrutura. Não são ensaios de WCAG, layout ou operação completa. O inventário arquitetural foi regenerado. |
| `commerce:go-live`, `payment:go-live` | **PASS estrutural/banco**, não constituem go-live funcional ou externo. |
| `commerce:final-go-live` | **BLOCKED / exit 1**: testes estruturais não provam escopo completo e o script não executa homologação externa. |
| `db:validate` / `db:deploy` (Prisma) | **BLOCKED / exit 1**: o download do `schema-engine` em `binaries.prisma.sh` falhou pela restrição de rede. O `db:deploy` foi tentado apenas em banco de teste. A execução operacional de SQL acima não equivale à validação ou deploy Prisma. |
| `npm audit` e `npm audit --omit=dev` | **exit 1** em ambos: 8 pacotes afetados, 4 moderados e 4 baixos, 0 altos/críticos. A análise por pacote, caminho, impacto e sugestão breaking permanece na §9; sem `audit fix --force`. |

**Upgrade isolado:** além do boot em banco vazio, foi aplicado o `db/schema.sql` da base `d28f33a` em outro banco de teste, inseridas linhas legadas de lançamento, extrato e cotação, e executadas individualmente `0078`, `0079` e `0080` **duas vezes**. Os campos anteriores permaneceram iguais, os campos novos ficaram `NULL` sem fatos presumidos, e testes transacionais recusaram baixa duplicada, vínculo de empresa diferente, status incompatível e hash de cotação inválido. Isso não substitui ensaio em cópia de produção nem prova de performance de índices sobre grande volume.

**Histórico de falhas antes do gate final:** a primeira execução PG desta passagem teve 356 aprovações e três falhas de fixtures de cotação; as fixtures foram corrigidas e a bateria repetida. Uma corrida CNAB expôs `40001` em auditoria avulsa depois do efeito financeiro; a auditoria foi corrigida, com teste concorrente de cadeia e repetição PG final. A primeira execução de `npm test` desta passagem teve uma falha em fixture do webhook Commerce que não fornecia identidade/refund exigidos pela nova validação; a fixture foi corrigida sem retirar a asserção e a suíte integral foi repetida. Nenhum desses resultados anteriores é apresentado como o gate final.
