# BROBOND ERP/Commerce Master Enterprise — auditoria de execução

**Data:** 2026-10-29 (UTC)

**EXECUTION STATUS: PARTIAL**

**Branch:** `arena/5e0b7882-brobond-erp` (branch fixa do ambiente; nenhum merge ou push em `main`).

**Base examinada:** `origin/main` em `2f4c9db9ab8be6bf60ab5ac1697786e2f4e636ae`; HEAD partiu da mesma revisão. O identificador do commit desta execução pode ser obtido com `git log -1` na branch acima.

Esta é uma entrega incremental executada no código, **não uma certificação do Master Enterprise completo**. A tabela abaixo distingue implementação desta rodada, capacidade anterior parcialmente aproveitada, ausência de código e pendência externa. Um teste verde de uma parte não homologa todas as jornadas nem elimina gaps conhecidos. As seções de pagamentos e ERP anteriores em `docs/` são históricas; esta auditoria descreve a presente execução.

## 1. Escopo, método e fontes

Foram inspecionados `server/src`, `server/test`, `client/src`, `db/schema.sql`, migrations e documentos de arquitetura, inclusive `ERP-MASTER-ARCHITECTURE.md`, `ERP-3.0-ARCHITECTURE-BASELINE.md`, `ERP-3.0-GAP-MATRIX.md` e `docs/architecture/payment-engine{,-validation}.md`. Na base havia 69 migrations; agora há 73. Foi feito `git fetch origin` e a comparação do HEAD com `origin/main`. Não houve checkout/pull em `main` por causa da branch fixa da sessão.

O commit histórico solicitado `4744752`, associado à antiga `arena/73786774-brobond-erp`, não estava disponível no remoto/API acessíveis; **não há diff comparativo comprovado desse commit**. A Outbox presente em `main` foi examinada e corrigida diretamente. Dependências, PostgreSQL de teste, bancos e logs foram mantidos fora dos arquivos versionados.

## 2. Resultado por fase

| Fase | Estado | Evidência / limite real |
|---|---|---|
| 1 Foundation, dados, segurança e integração | **PARCIAL; melhorias implementadas** | Outbox com lease/fencing monotônico, seleção de vencidos, erros explícitos e recuperação auditada por empresa; assinatura de auditoria v2; logs HTTP sem URL bruta; retry HTTP seguro. Ainda faltam redaction e tracing ponta a ponta em todas as integrações, armazenamento de auditoria resistente à reescrita e testes exaustivos de indisponibilidade. Entrega é **at-least-once**, não exactly-once. |
| 2 ERP, contabilidade, financeiro e fiscal | **PARCIAL; melhorias implementadas** | Fechamento/reabertura por competência protege **apenas importações de escrituração**; partidas importadas imutáveis no CRUD genérico, replay idempotente e travas compartilhadas. Caixa, todas as alterações contábeis e fiscal não ficam universalmente fechados. Fiscal segue com `NAO_SUPORTADO` para leiautes não implementados; nenhum SPED foi inventado. |
| 3 WMS/MRP/TMS | **PARCIAL; endereçamento implementado** | `locais` existentes passam a aceitar armazém → zona → endereço/bin, FK de pai na mesma empresa, validação de níveis e guarda contra remoção/alteração de pai com dependentes. Não é WMS completo: faltam ondas, estratégias avançadas, equipamentos, slotting e trilhas industriais completas. MRP/capacidade e logística preexistentes são planejamento/fluxos parciais, não APS ou TMS de transportadora homologado. |
| 4 PIM, pricing, promoções e busca | **PARCIAL; correção implementada** | Melhor promoção percorre páginas além das primeiras 500 e não mistura empresas. Cruzamentos de catálogo/ofertas recusam leituras truncadas em vez de inventar preços. PIM, publicação, preço/canal e busca já existiam; a escala dos cruzamentos e políticas enterprise ainda não estão completas. |
| 5 Payment Engine | **PARCIAL; conciliação manual implementada** | Importação normalizada de relatório de repasse em centavos sobre liquidações já existentes; hash idempotente, divergência explícita, vínculo manual a entrada exata do extrato, CAS, auditoria e páginas próprias. Nenhum lançamento de caixa é criado. Não há ingestão automática de relatórios/MDR por provider, correção automatizada de repasse divergente, resolução operacional completa de disputas nem cobertura integral dos métodos dos providers. |
| 6 OMS, commerce, loja e B2B | **PARCIAL; hardening implementado** | Expiração seleciona vencidos antes do limite e executa mudança, reserva, cupom e sale na mesma transação; webhook relê estado em cada retry e não ressuscita pedido expirado. Pagamento tardio fica sinalizado para revisão; **não** há estorno ou atendimento automático desse caso. As jornadas de loja/checkout e ponte para `vendas` já existiam; B2B enterprise integral não foi concluído. |
| 7 Marketplaces | **PARCIAL; segurança Woo implementada** | Envio interno de estoque exige vínculo explícito Woo/empresa; valida retorno de cada lote e acusa paginação incompleta ou SKUs sem correspondência. Integrações e conectores anteriores não equivalem a homologação de todos os canais. |
| 8 CRM/CDP/atendimento | **PARCIAL, preexistente** | CRM tem leads, funil/etapas, atividades e conversão; não foi construída nesta rodada uma CDP unificada, gestão integral de consentimento, identidade, atendimento omnichannel ou SLAs enterprise. |
| 9 Marketing/fidelidade/creators/afiliados/assinaturas | **NÃO IMPLEMENTADO como suíte completa** | Cupons, promoções e campanhas de aquisição CRM existentes não são programas completos de fidelidade, creators, afiliados ou assinaturas. `server/src/creators.ts` informa ausência de persistência/geração/envio e a UI não fabrica dados. |
| 10 BI/dados/IA | **PARCIAL, preexistente** | Há analytics, margens e curva ABC derivados das fontes canônicas. Não foram entregues plataforma de dados enterprise, linhagem completa, governança de modelos, feature store ou IA operacional homologada. |
| 11 Hardening, acessibilidade e operação | **PARCIAL** | Testes automatizados, gates PG/HTTP e auditoria de ausência de novos overlays foram executados conforme §6. Isso não substitui ensaios manuais WCAG AA, carga, restore, segurança independente, recuperação de desastre e homologação em produção. |

## 3. O que foi implementado nesta execução

### 3.1 Foundation

- `0070_foundation_integrity.sql`: `auditoria.hash_versao` e `commerce_outbox.claim_versao`, checks e índices parciais de pendentes/leases. Assinaturas novas incluem empresa e instante; eventos v1 históricos continuam verificáveis, sem reescrevê-los.
- A verificação PostgreSQL percorre a cadeia inteira em páginas de 5.000 registros até o último ID observado, sem o corte silencioso anterior de 100 mil; um teste real com 100.001 registros detectou as quebras além do limite antigo.
- A seleção PostgreSQL filtra itens vencidos/leases expiradas antes do limite; claim e conclusão comparam a versão, impedindo que worker antigo confirme uma lease mais nova, inclusive após reprocessamento manual. Enqueue usa `ON CONFLICT`. A ação de reenfileirar exige sessão, RBAC e empresa ativa, é auditada e não expõe payload; as leituras genéricas também omitem o payload, que continua disponível ao worker interno.
- Tipos/ações inexistentes, publicação ausente e integração não configurada não são sucesso. O agendador informa falhas por etapa e continua tentando as demais; não declara zero como êxito silencioso. A entrega externa pode ser repetida após falha; consumidores devem ser idempotentes.
- `requestObservability` inclui IDs de requisição/correlação limitados e registra método, padrão de rota, status e latência, sem body/query/token/URL bruta. O middleware de erro HTTP usa mensagem/padrão de rota genéricos; um teste HTTP real verifica segredos no corpo, caminho, query e autorização. Não há prova de sanitização de **todos** os logs, erros e integrações legadas.
- O fallback de e-mail não registra destinatário, corpo, link de convite/reset, token ou erro SMTP bruto; convite não entregue continua disponível apenas na resposta autenticada para entrega manual. Sem SMTP, recuperação de senha requer suporte do administrador. Nodemailer foi atualizado para 10.3.1 (requer Node ≥20), e o toolchain Vite/Vitest também foi atualizado; a instalação e os gates foram executados com Node 22. SMTP local foi testado, mas o provedor externo não foi homologado.
- `apiFetch` não repete POST/PUT/PATCH/DELETE após timeout/5xx; GET/HEAD/OPTIONS têm backoff, timeout total e cancelamento por `AbortSignal`. Não presume que um header de idempotência seja implementado por todas as rotas.

**Limite criptográfico:** a cadeia é hash encadeado sem chave/âncora imutável externa. Detecta alterações inconsistentes, mas quem puder reescrever toda a cadeia pode recalculá-la ou remover seu final sem uma âncora externa; v1 não passa a assinar campos que historicamente não assinava.

### 3.2 Contabilidade

- `0071_periodos_contabeis.sql` cria `fin_periodos_contabeis` por empresa/competência, único, com motivo, estado, autor, timestamps e índice. APIs listam, detalham, fecham e reabrem; fechamento por gerente/admin, reabertura só admin. Repetir estado não duplica evento.
- Importação validada em transação: datas civis/competência reais, valores inteiros em centavos, débito = crédito por entrada, plano da própria empresa e replay por hash. Importação e fechamento usam mutex por empresa e advisory transaction lock PostgreSQL em READ COMMITTED; o lote é rejeitado quando competência afetada está fechada. O replay já confirmado permanece seguro mesmo após o fechamento.
- Partidas da importação continuam em `lancamentos_financeiros`, não em novo livro. CRUD genérico rejeita criar origem forjada, editar ou excluir essas partidas; `efetuarBaixa` exige lançamento pendente e as importadas são confirmadas. Essa proteção não é um fechamento universal de caixa, fiscal e todas as escritas diretas do sistema.
- UI em `/financeiro/periodos`, `/novo`, `/:competencia` e `/:competencia/reabrir`, sem modal. Rota de origem a partir do balancete.

### 3.3 WMS, preços, OMS e marketplace

- `0072_wms_enderecamento.sql` acrescenta `nivel_wms`/`local_pai_id` em `locais`, check de forma, FK composta `(empresa_id, local_pai_id)` e índice. Cadastro usa LIST/NEW/DETAIL/EDIT genéricos existentes. Saldo permanece em `estoques` e movimentos/reservas nos recursos canônicos; nenhuma tabela de saldo paralelo foi criada.
- `melhorPromocaoAtiva` processa páginas ordenadas, com limite explícito de segurança. Catálogo e ofertas falham com erro quando os cruzamentos ultrapassam seu limite, sem aplicar preço-base a dados omitidos.
- Expiração de checkout e eventos de pagamento foram protegidos contra seleção que favorecia os primeiros 500, stale state e falhas entre claim/liberação. O pagamento após encerramento conserva o pedido encerrado e registra revisão; falta fluxo financeiro/operacional de solução.
- WooCommerce interno verifica a empresa vinculada mesmo fora do handler HTTP; retorno de lote é conferido por ID/erro e paginação tem limite explícito. Status de fila com SKU faltante é erro a tratar. Conteúdo remoto de erro não é propagado ao log. Integração real não foi acionada.

### 3.4 Payment Engine — repasses

- `0073_payment_payouts.sql`: `payment_payouts` é evidência, com unicidade de empresa/provider/referência, SHA-256 do conteúdo normalizado, moeda BRL, estado e FK composta para `fin_extrato_transacoes`. Índice único parcial impede vincular a mesma linha bancária a dois repasses da empresa. `payment_settlements.payout_id` tem FK composta por empresa.
- Aceita de 1 a 1.000 transações já registradas no Payment Engine; valores em centavos inteiros, taxas/reembolsos/chargebacks e soma líquida são validados. Conteúdo igual é replay; referência igual com conteúdo diferente dá 409. Divergência entre bruto/reembolsos/chargebacks internos e relatório é registrada, não declarada conciliada.
- O vínculo manual exige uma entrada de extrato da empresa, não ignorada, de valor líquido exato; CAS impede concluir com liquidação alterada durante a operação. Não atualiza o extrato nem baixa lançamento financeiro. Reembolso/chargeback posterior invalida o estado e mantém o vínculo como histórico divergente. Um `REFUNDED` integral sem quantia explícita representa o total; quantias contraditórias e estornos parciais sem valor são recusados. Testes PG exercitaram a corrida entre estorno e conciliação/importação, com reprocessamento após abortos de serialização; não substituem testes externos e multiworker exaustivos.
- O formulário manual não interpreta nem promete layouts oficiais; não há importador automático ou API de payout dos providers. Um resultado divergente requer revisão; não existe ainda correção/estorno/desvinculação completa. Definir status `MATCHED` manualmente sem vínculo bancário foi bloqueado.

## 4. API e interfaces adicionadas/alteradas

| Superfície | Operação / alçada |
|---|---|
| `POST /api/commerce/outbox/:id/reprocessar` | reprocessar erro da própria empresa, somente gerência/admin, auditado; 404 para outro tenant |
| `GET /api/financeiro/periodos` e `GET /api/financeiro/periodos/:competencia` | lista paginada/detalhe, sessão e escopo financeiro da empresa |
| `POST /api/financeiro/periodos/:competencia/fechar` e `/reabrir` | motivo obrigatório; fechamento gerencial e reabertura admin; restrito à escrituração importada |
| `GET /api/commerce/payments/payouts` e `GET /api/commerce/payments/payouts/:id` | lista paginada e detalhe, gerente/admin com acesso a pedidos e financeiro da própria empresa |
| `POST /api/commerce/payments/payouts/import` | relatório manual validado, transacional, auditado e idempotente por conteúdo/referência |
| `POST /api/commerce/payments/payouts/:id/match` | vincular extrato da mesma empresa por valor exato; idempotente para o mesmo vínculo |
| `locais` | campos de hierarquia no recurso canônico e nas páginas genéricas já existentes |
| `/commerce/pagamentos/repasses[/novo,/:id,/:id/conciliar]` | páginas próprias com dados de API, estados vazios e erros, sem diálogo |

Todos os endpoints novos dependem da autenticação global existente, RBAC verificado nos handlers, empresa derivada do ator e erros explícitos; listagens novas são paginadas. Testes unitários e PG exercitam tenancy e replay, mas **não** constituem prova exaustiva para todas as combinações de permissão/integração. O comportamento `MATCHED` não comprova recebimento externo: comprova somente comparação do relatório informado com linha de extrato escolhida.

## 5. Banco, migrações e arquitetura

As migrations 0070–0073 foram adicionadas sem exclusão massiva e espelhadas em `db/schema.sql`. Incluem checks, unicidade, índices e FKs compostas descritos acima. O bootstrap/migration runner aplicou as 73 migrations em PostgreSQL 16.14 real em bancos novos de teste. Índices e constraints adicionais podem adquirir locks e consumir tempo em bases grandes; plano de rollout, backup, restauração e teste em cópia de produção são obrigatórios. Não foi feita migração em banco de produção.

A fronteira permanece **Empresa = tenant, Usuário = identidade, Usuário×Empresa = autorização**. Não foi criado `organizationId`, segundo estoque, segundo caixa ou segundo ledger de vendas. `vendas`, `estoques`/`movimentacoes`, `lancamentos_financeiros` e fiscal conservam seus papéis de autoridade; Commerce projeta/orquestra. A metadata WMS e os repasses não são saldos independentes.

## 6. Verificações efetivamente executadas

Os testes sem `DATABASE_URL` pulam casos específicos de PostgreSQL, e não são prova de persistência. As provas PG usam servidor **16.14** real, `psql` genuíno **18.4**, e o gate exige banco novo, versão exata e zero skips. Resultados de comandos finais:

| Comando | Resultado |
|---|---|
| `npm test` | **PASS** após a correção do teste de interface e `npm ci`: servidor 1.575 testes, 1.507 aprovados, 68 skips PG, 0 falhas; cliente 116 arquivos, 1.037 testes aprovados, 0 falhas. |
| Suíte de servidor de `npm test`, sem PG | **1.507 aprovados, 0 falhas, 68 skips PG**, na execução integral com a versão atual do servidor. |
| `npm run test:pg` em banco vazio | **325 aprovados, 0 falhas, 0 skips/TODOs** (`ERP-03 GATE PASS`) em PostgreSQL 16.14, incluindo a leitura segura da Outbox, auditoria com 100.001 linhas e concorrência de estornos com repasses. Execuções anteriores passaram 320/320 e 322/322 antes dos testes adicionais. |
| PG direcionado: `enterprise-integrity` + `commerce-concorrencia` em banco novo | **16/16**, 0 falhas, 0 skips; inclui fencing, concorrência de checkout e repasse. |
| `npm run smoke:pg` | **396/396** verificações HTTP reais em banco PG recém-criado. |
| `npm run smoke` em demonstração | **396/396** após subir API nova em memória. A primeira tentativa, sem servidor na porta, falhou com `ECONNREFUSED`; a repetição com o servidor exigido passou. |
| `npm run typecheck` | **PASS**: domínio, servidor e cliente. |
| `npm run lint` | **PASS**, 0 erros; 600 warnings (não é execução sem avisos). |
| `npm run build` | **PASS**, bundle e PWA gerados. |
| `npm run audit:menu` / `npm run audit:ux` | **PASS**, menu sem erros e UX sem novas sobreposições em módulos; o gate UX mantém 6 exceções globais/públicas preexistentes, não certifica WCAG manual. |
| `npm run test:payments` | **20/20**, 0 falhas/skip; fixtures, não homologação externa. |
| `npm run payment:go-live` / `npm run commerce:go-live` | **PASS estrutural** com DB de teste; Payment: 9 tabelas empresariais, Commerce: 42 checagens P0 e 9/9 tabelas. Nenhum deles valida credenciais externas ou autoriza go-live. |
| `npm audit` / `npm audit --omit=dev` | **Não aprovado (exit 1)**: ambos reportam 8 pacotes afetados: 4 moderados, 4 baixos, 0 altos/críticos. As versões corrigidas de Nodemailer, Vite/Vitest e correções sem `--force` removeram os achados altos/críticos anteriores; React Router, ExcelJS/uuid e dependências do PWA ainda exigem análise/upgrade. `npm ci` passou no Node 22. |
| `npm run go-live:audit` | **PASS estrutural**: P0/P1 = 0 e 2 avisos P3 na verificação de padrões; inclui `architecture:audit`, mas não equivale a homologação nem a `FULL_GO_LIVE`. |
| `npm run commerce:final-go-live` | **BLOCKED (exit 1)** mesmo com verificações estruturais aprovadas: o script não executa homologação externa nem demonstra o escopo integral; credencial presente é apenas configuração, não prova de go-live. |
| `npm run db:validate` | **BLOQUEADO POR AMBIENTE**: Prisma tentou baixar `schema-engine` de `binaries.prisma.sh`, host fora da rede permitida; não é evidência de falha nem de aprovação do schema. |
| Testes adicionais direcionados | Segurança de retry/cancelamento e páginas de repasse/períodos no client (novos testes de períodos: 2/2); períodos/tenancy/WMS, payloads, logging HTTP, falha Woo e estornos/repasse no servidor; 3/3 testes PG novos de estorno integral e concorrência foram aprovados. Ver arquivos de teste listados no §10. |

O gate PG inicial desta sessão havia dado 298 pass e 13 skips por ausência de `psql`; isso **não** foi considerado aprovação. A ferramenta genuína foi provisionada e o gate repetido. A primeira execução integral após as mudanças teve 3 falhas no cliente: duas por um teste de balancete montado sem Router após a inclusão do link de períodos, e uma busca de fornecedor que expirou sob carga concorrente. O teste de balancete passou a usar Router; os dois arquivos passaram em nova execução direcionada (12/12). O resultado da repetição integral aparece na tabela, sem ocultar a falha inicial. Uma execução posterior da suíte completa, concorrente ao gate PG, teve um timeout de 5 s no teste que montava 13 breadcrumbs em sequência (1.024/1.025 testes do cliente passaram). Os 13 casos foram separados em testes parametrizados sem remover as asserções; a regressão `Layout.test.tsx` passou 27/27. O primeiro lint também acusou `no-control-regex` no código novo, corrigido antes da repetição. Os novos testes de estorno reproduziram inicialmente duas falhas (valor integral omitido e valor parcial ambíguo); o fluxo foi corrigido e os testes repetidos passaram. Nenhum teste externo de sandbox financeiro, pagamento real ou credencial de parceiro foi executado.

## 7. Homologação interna versus externa

- **Interna:** fluxos cobertos por testes de memória e PG, inclusive bootstrap, MFA e 396 verificações HTTP do smoke. Faltam testes visuais/manual WCAG, carga e soak com volume real, queda/retomada de workers múltiplos e ensaio de recuperação/restore em infraestrutura de produção.
- **Externa:** nenhuma credencial, conta ou autorização de produção/sandbox foi disponibilizada. Confirmar contratos e certificados de PagBank/Mercado Pago/Stripe, webhooks válidos, settlement/MDR e disputas, WooCommerce/canais, transportadoras, fiscal/SEFAZ/contabilidade e conciliação bancária com dados reais. A ausência de credenciais não foi usada para classificar código inexistente como implementado.
- **Pagamentos:** PagBank disponível no adapter de checkout para PIX, não cartão/débito/boleto completos; outros métodos só onde capacidades realmente implementadas e configuradas os anunciam. Relatório manual não significa ingestão oficial homologada.

## 8. Gaps priorizados e próximos passos

| Prioridade | Gap verificável / ação necessária |
|---|---|
| **P0** | Não autorizar go-live integral com capacidades ausentes ou integrações não homologadas. Executar revisão independente de segurança/tenancy e recuperação de backup antes de qualquer produção; o resultado deste documento não é autorização operacional. |
| **P1** | Dependências: remover os 8 achados remanescentes (4 moderados, 4 baixos), incluindo React Router, ExcelJS/uuid e cadeia PWA; avaliar migrações de versões principais e testar impacto. Não expor ferramentas de desenvolvimento/testes a fontes não confiáveis. |
| **P1** | Fechamento contábil abrangente, trilhas de estorno/ajuste e bloqueio coerente de todas as escritas fiscal/financeiras por competência; governança contábil com profissional habilitado. A implementação atual cobre importação apenas. |
| **P1** | Payment Engine: adapters e métodos faltantes, reconciliação automática baseada em relatórios oficiais, diferenças/MDR e correções, disputas/evidências, regras de repasse e testes cruzados com webhook; homologação externa separada. |
| **P1** | Tratar pagamento confirmado após expiração/cancelamento por fluxo de revisão/estorno explícito e auditado; validar corridas entre provedores, pedido e reserva sob múltiplos processos. |
| **P1** | Outbox at-least-once: idempotência de todos os consumidores, DLQ/monitoramento persistente, recuperação após crash durante efeito externo e testes multiworker; logs e erros legados com sanitização global verificável. |
| **P1** | WMS operacional completo sobre `locais`/estoque existentes; MRP industrial, unidade de medida e capacidade; TMS e transportadoras. Validar concorrência de alterações da hierarquia de locais. |
| **P1** | Suíte de homologação interna abrangente por papel/empresa, E2E ponta a ponta compra→recebimento→produção/MRP→pedido→pagamento→expedição, performance, carga, DR, acessibilidade e segurança. Os testes existentes não provam todas as combinações. |
| **P2** | Trocar limites de segurança de catálogo/ofertas/promoções por consultas paginadas e joins dimensionados; PIM, políticas comerciais, promoções avançadas e busca em escala. |
| **P2** | Conectores de marketplace e logística adicionais com contratos oficiais, replay/webhook, conciliação e homologação por canal; eliminar dependência de configuração global onde necessário. |
| **P2** | CDP/identidade/consentimento, atendimento, SLAs, marketing, loyalty, creators, afiliados e assinaturas com persistência, fluxos e UI próprios; não reaproveitar indevidamente o CRM como se fosse creators. |
| **P2** | Governança de auditoria com assinatura/âncora externa, retenção e evidências, observabilidade distribuída, alertas e limites de dados pessoais em integrações legadas. |
| **P3** | Plataforma de dados/IA, governança de modelos e recomendações reais; somente com fontes, consentimento, explicabilidade e métricas verificáveis. |

## 9. Decisão de prontidão

| Indicador para o escopo **integral Master Enterprise** | Decisão |
|---|---|
| `CODE_READY` | **NO** — existem lacunas de implementação, não só credenciais. |
| `INTERNAL_GO_LIVE` | **NO** — evidência parcial, sem aceite funcional e operacional integral. |
| `EXTERNAL_HOMOLOGATION_READY` | **NO** para o escopo integral; adapters/fluxos oficiais e roteiro completo ainda faltam. Partes implementadas podem ser testadas separadamente com autorização. |
| `FULL_GO_LIVE` | **NO**. |

## 10. Arquivos desta execução

- Banco: `db/schema.sql`, `db/migrations/0070_foundation_integrity.sql`, `0071_periodos_contabeis.sql`, `0072_wms_enderecamento.sql`, `0073_payment_payouts.sql`.
- Servidor: `server/src/{auditChain,auth,mail,notifications}.ts`, `commerce/{outbox,pedidos,promocoes,catalogo}.ts`, `financeiroImportacao.ts`, `financeiroPeriodos.ts`, `index.ts`, `loja.ts`, `memdb.ts`, `observability.ts`, `pgstore.ts`, `resources.ts`, `scheduled.ts`, `services.ts`, `wmsEnderecamento.ts`.
- Payment Engine: `modules/payments/application/payouts.ts`, `api/routes.ts`, `infrastructure/{locking,resources}.ts`, `orchestration/payment-orchestrator.ts`.
- Cliente: `client/src/App.tsx`, `lib/api.ts`, `pages/{ForgotReset,Settings}.tsx`, `pages/FinanceiroBalancetePage.tsx`, `pages/FinanceiroPeriodosPage.tsx`, `pages/commerce/{FilaPage,PaymentEnginePage,PaymentPayoutsPage}.tsx`.
- Testes: `server/test/{enterprise-mail-security,enterprise-observability,enterprise-oms,enterprise-payouts,enterprise-periodos-wms,enterprise-pricing,foundation-outbox-audit,loja,url-publica}.test.ts`, `server/test/pg/enterprise-integrity.test.ts`, `client/src/lib/api.retry.test.ts`, `client/src/components/Layout.test.tsx`, `client/src/pages/{Evolucao30Pages,FinanceiroPeriodosPage,ForgotReset.security}.test.tsx`, `client/src/pages/commerce/PaymentPayoutsPage.test.tsx`.
- Dependências: `server/package.json`, `client/package.json`, `package-lock.json`.
- Scripts/documentação: `docs/AUTENTICACAO.md`, `scripts/{commerce-go-live-audit,commerce-final-go-live-audit,final-go-live-audit,payment-engine-go-live-audit}.ts`, `docs/{COMMERCE-GO-LIVE,COMMERCE-FINAL-ACCEPTANCE,COMMERCE-FINAL-AUDIT,COMMERCE-UNBLOCK-MATRIX}.md`, `docs/architecture/payment-engine.md`.
- Relatório: este arquivo. Nenhum dado de teste, dependência, build ou credencial é parte intencional do commit.
