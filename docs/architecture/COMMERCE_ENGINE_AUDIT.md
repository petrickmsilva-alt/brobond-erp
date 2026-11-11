# BROBOND ERP — COMMERCE ENGINE · AUDITORIA ARQUITETURAL (FASE 1)

> Documento de auditoria da missão **Brobond ERP Commerce Engine**.
> Base: inspeção do repositório `petrickmsilva-alt/brobond-erp`, branch
> `feat/brobond-commerce-engine`, merge de `origin/main` (`c9297a8`).
> Data: 2026-11-11. Nenhuma alteração de produção foi executada.

---

## 1. Arquitetura atual

- **Modular Monolith** em TypeScript. Servidor Express (`server/src`), cliente
  Next.js 15 / React 19 (`client/`), pacotes de domínio (`packages/`) e módulos
  de integração desacoplados (`modules/`).
- **PostgreSQL** é a fonte transacional oficial. `db/schema.sql` (bootstrap
  estrutural) + `db/migrations/*.sql` (cadeia versionada, ordem léxica) +
  `db/bootstrap.sql` (gerado). Prisma cobre apenas o *bounded context* do
  commerce (`prisma/`), e há auditoria que trava a coerência entre os dois.
- **Multiempresa** por `empresa_id` e escopo por ator (`escopoDoAtor`); recursos
  declaram `empresa: true`. Multi-loja por `store_key` (`RETAIL`/`WHOLESALE`).
- **RBAC** no servidor (`checkAccess`), autorização por recurso × perfil.
- **Outbox** único (`commerce_outbox`, claim CAS, backoff, dead-letter) e
  **webhooks** idempotentes por empresa.
- **Auditoria** (`auditoria`, cadeia de hash em `auditChain.ts`).
- **Observabilidade** (`observability.ts`), cron em `scheduled.ts`
  (processos `relatorios|pagamentos|publicacoes|pedidos|crm`).
- **Testes**: `node --test` no servidor (2.477 casos / 111 suítes), vitest no
  cliente (130 arquivos / 1.123 testes), e **gate PostgreSQL real** (`npm run
  test:pg`) exigindo PG 16.14 e banco vazio.

Números do inventário regenerado (`docs/ERP-3.0-ARCHITECTURE-INVENTORY.json`):

| Métrica | Valor |
|---|---|
| Migrações SQL | 117 |
| Tabelas | 233 (21 sem `empresa_id`) |
| Índices | 630 |
| Constraints | 431 |
| Recursos (CRUD) | 188 |
| Rotas HTTP | 505 (223 GET, 243 POST, 22 PUT, 14 DELETE, 3 PATCH) |

> **Conclusão-chave da auditoria:** o "Commerce Engine" pedido **já existe em
> grande parte**. A missão é **evoluir e fechar lacunas reais**, não recriar
> motores. Recriar seria violar a proibição de "segundo motor comercial".

---

## 2. Arquivos e módulos encontrados (por domínio)

### A. Produtos e catálogo
- Recursos canônicos: `produtos` (`resources.ts`, ~2.540 linhas de campos),
  `categorias`, `colecoes`, `tamanhos`, `grades`, `grade_tamanhos`, `marcas`.
- Variações: `server/src/variacoes.ts`, `server/src/commerce/grade.ts`.
- Busca: `server/src/productSearch.ts` (`Smart Product Search` — ranking,
  atributos, variantes, saldo do pai por tamanho).
- Rastreabilidade por lote: `server/src/rastreabilidade.ts`, `loteValidacao.ts`.
- Campos fiscais no produto já existem: `ncm`, `cest`, `origem`, `cfop_saida`,
  `icms_cst`, `icms_aliquota`, `pis_cst`, `pis_aliquota`, `cofins_*`, `ipi_*`.
- **Carga PIM** (entrega imediatamente anterior): `server/src/cargaPoliticaComercial.ts`
  + `db/migrations/0117_pim_carga_politica_comercial.sql` — cadastro e
  **identificadores de origem** (`codigo_item`, `codigo_categoria`,
  `codigo_industria`) preservados como texto.

### B. Preços e políticas comerciais
- `server/src/precoVenda.ts` — aritmética de desconto/líquido (centavos).
- `server/src/listasPreco.ts` — listas de preço versionadas
  (`listas_preco`, `lista_preco_itens`, `listas_preco_historico`), vigência,
  prioridade, `precoDe()`/`precoProduto()`.
- `server/src/politicasComerciais.ts` — `politicas_comerciais` (escopo
  `geral|canal|colecao|catalogo|cliente`, desconto, pedido mínimo, múltiplo,
  reserva), `resolverPoliticaComercial()` e `precoComPolitica()`.
- `server/src/commerce/catalogo.ts` — `commerce_precos` por canal
  (`BROBOND|MERCADOLIVRE|NUVEMSHOP|WOOCOMMERCE|INSTAGRAM_SHOPPING`) e `store_key`,
  `precoEfetivoDeProduto()`.
- `server/src/commerce/promocoes.ts` — `commerce_promocoes` +
  `commerce_promocao_alvos`, cupons, `descontoFinalDoCheckout()`.
- `server/src/valorizacao.ts` — valorização de estoque por canal
  (`preco_atacado || preco_venda`).
- Campos de compatibilidade canônicos: `produtos.preco_venda`,
  `produtos.preco_atacado`, `atacado_min_qtd`.

### C. Vendas e pedidos
- `server/src/commerce/checkout.ts`, `checkout-base.ts` — checkout interno,
  `cotarCarrinho`, `previewInterno`, `pedidoInterno`, `criarCheckoutCommerce`.
- `server/src/commerce/pedidos.ts`, `projecao.ts` (projeção analítica),
  `regras.ts`, `omsEstado.ts`.
- `server/src/oms.ts` — trilha de estado (`vendas_status_historico`, migration 0109).
- `server/src/estoqueCanonico.ts`, `estoque.ts` — reservas, saldo, alocações.
- `server/src/expedicao.ts`, `devolucaoFornecedor.ts`, `devolucaoRefund.ts`.
- **Ponte canônica** `sales → vendas` (`projecao.ts`): operação em `vendas`/
  `itens_venda`; projeção analítica em `sales`/`sale_items`. **Sem duplicidade.**

### D. Fiscal
- `server/src/fiscal.ts` (1.074 linhas) — montagem/emissão de documento,
  situação, eventos, consulta, cancelamento, inutilização, prévia.
- `server/src/fiscalRegras.ts` — `regras_fiscais` (NCM prefixo, UF destino,
  operação, modelo, consumidor final, regime), `resolverTributacao()` com
  precedência produto → regra → padrão, `pendenciasFiscais()` (nunca chuta).
- `server/src/fiscalProvider.ts` — interface `FiscalProvider` + adaptadores
  `focusNfe` e `plugNotas` + `provedorNulo`. `StatusFiscal` e separação
  cálculo × emissão × autorização × cancelamento × consulta.
- `server/src/fiscalLayouts.ts`, `fiscalExecucoes.ts`, `fiscalObrigacoes.ts`,
  `fiscalEfd.ts` — leiautes, execuções, obrigações, EFD.
- `empresa_fiscal_config` — provider, ambiente, certificado, séries, CFOP padrão.
- `impostos_ncm` — alíquota por NCM (tabela simples).

### E. Logística
- `modules/logistics/` — **motor multicanal completo**: `domain/contract.ts`
  (status normalizado com pesos anti-regressão, modalidades, `StoreKey`),
  `domain/rules.ts` (frete grátis, subsídio, restrição, preferência),
  `application/quotes.ts` (cotação com persistência + estado explícito),
  `shipments.ts`, `tracking.ts`, `reconciliation.ts`, `jobs.ts`.
- `providers/registry.ts` — adaptadores **Melhor Envio, Correios, Jadlog,
  Total Express, Loggi, JT Express** (nascem desabilitados sem contrato).
- `infrastructure/webhookInbox.ts`, `webhookSeguranca.ts` — inbox idempotente e
  validação de assinatura.
- Tabelas: `logistics_quotes`, `logistics_packages`, `logistics_labels`,
  `logistics_shipping_rules`, `logistics_webhook_inbox`, `logistics_audit_logs`,
  `envios`, `envio_eventos`, `envio_ocorrencias`.
- `server/src/cep.ts` (ViaCEP), `server/src/frete.ts` (endpoint legado honesto:
  sem provider configurado, devolve `PROVIDER_UNAVAILABLE`).
- **Regra**: sem `LOGISTICS_ENABLED`, opera em modo seguro; nunca inventa valor.

### F. Financeiro
- `server/src/gateway.ts` (1.550 linhas), `server/src/payment*` (Payments Engine
  enterprise): `payment_intents`, `payment_attempts`, `payment_refunds`,
  `payment_disputes`(+evidence/events), `payment_settlements`,
  `payment_routing_rules`, `payment_payouts`(+revisions/unlinks),
  `payment_late_reviews`, `payment_methods`.
- `modules/payments/`, `server/src/financeiro*.ts`, `extrato.ts`, `cnab.ts`,
  `financeiroPeriodos.ts`, `financeiroContabil.ts`.
- **Regra**: pagamento só é confirmado por webhook assinado e idempotente
  (`gateway_webhook_events`), nunca por solicitação enviada.

### G. Segurança e governança
- Multitenancy (`empresa.ts`), RBAC (`resources.ts` + `checkAccess`),
  auditoria (`auditoria` + `auditChain.ts`), outbox/inbox idempotentes,
  cifra AES-256-GCM (`chavesCifra.ts`, `segredos.ts`), LGPD (`lgpd.ts`),
  MFA/TOTP (`mfa.ts`, `totp.ts`), política de senha (`politicaSenha.ts`).
- Guarda de configuração: toda variável de ambiente lida precisa constar em
  `docs/auditoria/matriz-configuracao-producao.md` (teste
  `config-inventario-producao`).

---

## 3. Serviços que devem ser REUTILIZADOS (não recriar)

| Necessidade | Serviço canônico existente |
|---|---|
| Preço por lista/vigência | `listasPreco.precoDe` |
| Política comercial por escopo | `politicasComerciais.resolverPoliticaComercial` |
| Preço por canal de marketplace | `commerce/catalogo.precoEfetivoDeProduto` |
| Promoções/cupons | `commerce/promocoes.descontoFinalDoCheckout` |
| Desconto/líquido (centavos) | `precoVenda.*` |
| Reserva/estoque | `estoqueCanonico.ts` |
| Cotação de frete | `modules/logistics/application/quotes` |
| Regra tributária | `fiscalRegras.resolverTributacao` |
| Emissão fiscal | `fiscal.montarDocumentoDaVenda` + `fiscalProvider` |
| Pagamento/estorno/conciliação | `gateway.ts` + `payment_*` |
| Projeção analítica | `commerce/projecao.ts` (`sales`) |

---

## 4. Duplicidades e inconsistências encontradas

1. **Colisão de migração (RESOLVIDA nesta missão).** O upstream `origin/main`
   publicou `0116_commerce_outbox_estados_terminal.sql` enquanto a entrega da
   carga PIM usava `0116_pim_carga_politica_comercial.sql`. A cadeia é aplicada
   em ordem **lexical** e o nome é a chave em `schema_migrations`: dois arquivos
   `0116_*` coexistem sem erro, mas a ordem fica ambígua por sufixo. **A migração
   da carga foi renumerada para `0117_*`** (nunca foi aplicada a banco
   compartilhado). Referência em `db/schema.sql` atualizada.

2. **Três fontes de preço coexistem, sem duplicidade de motor** (compatibilidade,
   não redundância): `produtos.preco_venda/preco_atacado` (base), `listas_preco`
   (tabela versionada) e `commerce_precos` (override por canal de marketplace).
   O risco é **ordem de precedência implícita**. Ver §5.2.

3. **Sem preço por condição de pagamento.** A planilha oficial traz 8 colunas de
   preço de atacado por condição (boleto/cartão/prazos) e 4 de varejo; o modelo
   atual não tem onde representá-las. Ver §5.2.

4. **`sales` vs `vendas`** — distinção **correta** (operação × projeção), não é
   duplicidade. Mantida.

5. **`frete.ts` (legado) × `modules/logistics`** — o legado é um endpoint
   honesto (recusa sem provider); o motor novo é o canônico. O legado pode ser
   ligado ao motor; não é segundo motor.

---

## 5. Lacunas reais (gaps)

### 5.1 Fase 2 — Modelo comercial canônico
- **Preços oficiais da planilha não importados.** A carga atual importa
  cadastro/identificadores; a planilha tem 14 colunas de preço oficial
  (atacado e varejo por condição de pagamento) e 3 de margem de referência.
- **Mapeamento formal das 72 colunas inexistente** como documento.
- **Faixa de quantidade / múltiplos** existe via `politicas_comerciais`, mas não
  como *tabela de preço por faixa* com preço próprio.

### 5.2 Fase 3 — Motor de preços e rentabilidade
- **Sem preço por condição de pagamento** (Pix/boleto/cartão/prazos) — gap central.
- **Sem preço mínimo / margem mínima / limite de desconto / alçada** como
  parâmetro configurável e bloqueio. Existe aprovação genérica (`approval.ts`).
- **Sem motor de rentabilidade** (receita líquida − custo − impostos − frete −
  taxas = margem de contribuição) com memória de cálculo.
- **Sem serviço de simulação comercial** unificado (carrinho → preço → imposto →
  frete → taxas → total → margem → alertas), embora existam `cotarCarrinho` e
  `previewInterno` (parciais, focados no checkout interno).

### 5.3 Fase 4 — Motor tributário
- **ST, DIFAL, FCP, IBS, CBS ausentes.** `regras_fiscais` cobre ICMS/PIS/COFINS/IPI
  (CST + alíquota + redução), mas não ST/DIFAL/FCP nem o novo regime (IBS/CBS).
- **Sem memória de cálculo fiscal** por item/documento (regra usada, versão,
  vigência, base, alíquota, valor).
- **Sem versionamento de alíquota/regra por vigência** aplicado à memória
  (vigência existe na regra, mas não há snapshot por operação).

### 5.4 Fase 5 — Logística
- **Carriers externos nascem desabilitados** sem credencial — *por design*.
  Não é lacuna de código; é dependência de contrato (Correios/Melhor Envio).
- **Frete no checkout da loja nativa é `nenhum|retirada|manual`** — falta a ponte
  do checkout para o motor `modules/logistics` (cotação real no backend).

### 5.5 Fase 6 — Integração vendas/financeiro
- **Simulação não gera nem reserva** — já é o comportamento correto; falta o
  serviço unificado e o contrato explícito de estados.
- **Proteção de concorrência de estoque** existe (`estoqueCanonico` + índice
  único parcial + `repetirSerial`); falta prova de homologação end-to-end do
  fluxo de simulação.

### 5.6 Fase 7 — Homologação
- Matriz de homologação desta missão (não existente como documento único).

---

## 6. Riscos de segurança identificados

| Risco | Situação atual | Ação |
|---|---|---|
| Preço/desconto/imposto vindos do frontend | Já revalidados no servidor (checkout, política, fiscal) | Manter; provar por teste no novo serviço de simulação |
| IDOR entre empresas | `assertRegistroDaEmpresa` / `escopoDoAtor` aplicados | Manter |
| Webhook sem assinatura | `webhookSeguranca.ts` valida assinatura | Manter |
| Segredos em código | Cifrados AES-256-GCM em `configuracoes`; matriz de config trava env novas | Manter |
| Migration colidida | **Corrigida** (0116 → 0117) | Concluído |
| Logs com dados sensíveis | `semSegredos()` em `fiscalProvider` | Manter |

---

## 7. Dependências externas

| Dependência | Estado | O que falta |
|---|---|---|
| WooCommerce RETAIL/WHOLESALE | Conector implementado (`loja.ts`, registry multi-loja) | Credenciais do cliente |
| Melhor Envio | Adapter implementado | Token (`me_token`) |
| Correios | Adapter implementado | Contrato (usuário/senha/código) |
| Jadlog/Total Express/Loggi/JT | Adapters implementados | Contrato por transportadora |
| Focus NFe / PlugNotas | Adaptadores implementados | Token + certificado |
| Gateways (PagBank etc.) | Payments Engine implementado | Credenciais + webhook |
| ViaCEP | Implementado | — |

> Nenhuma integração externa é declarada "concluída" por ter apenas adapter. Sem
> credencial, o resultado é um **estado explícito**, nunca um valor inventado.

---

## 8. Plano técnico de evolução

Prioridade por **valor real** e **baixo risco de regressão**:

1. **P2 — Documentos do modelo comercial canônico** (Fase 2): mapeamento formal
   das 72 colunas, modelo canônico e validação da importação.
2. **P2 — Preços oficiais da planilha** (Fase 2/3): importar os preços oficiais
   para as estruturas canônicas (`listas_preco` para varejo/atacado base; nova
   tabela `precos_condicao_pagamento` para as condições). **Nunca** sobrescrever
   preço existente sem confirmação; reimportação idempotente.
3. **P3 — Preço por condição de pagamento** (Fase 3): tabela + resolução +
   integração à simulação. Parâmetros configuráveis, sem valores inventados.
4. **P3 — Motor de rentabilidade + memória de cálculo** (Fase 3): serviço puro,
   reusa `precoVenda`/`fiscalRegras`/`listasPreco`; grava memória auditável.
5. **P3 — Serviço de simulação comercial unificado** (Fase 6): entrada
   (empresa/canal/cliente/itens/condição/frete) → preço, desconto, imposto
   estimado, frete, taxas, total, margem, disponibilidade, alertas. **Somente
   leitura**: não cobra, não vende, não reserva.
6. **P4 — Preço mínimo/margem mínima/alçada** (Fase 3): parâmetro configurável
   (desligado por padrão), bloqueio + aprovação com justificativa.
7. **P4 — Extensão fiscal ST/DIFAL/FCP + memória + ganchos IBS/CBS** (Fase 4):
   colunas/regras aditivas, alíquotas **vazias** (dependem de legislação), com
   pendência registrada.
8. **P4 — Ponte do checkout para o motor de logística** (Fase 5): cotação real no
   backend quando o motor estiver habilitado; senão, comportamento atual.
9. **P5 — Matriz de homologação** (Fase 7).

**Fora de escopo (já implementado, não recriar):** listas de preço, promoções,
outbox, fiscal base, logística multicanal, payments engine, OMS, multiempresa.

---

## 9. Ordem de implementação

```
FASE 2 (docs + preços oficiais)  ──▶  FASE 3 (condição de pagamento,
                                        rentabilidade, simulação, mínimo)
      │                                        │
      ├──▶ FASE 4 (fiscal: ST/DIFAL/FCP,       │
      │          memória, ganchos IBS/CBS)     │
      │                                        ▼
      └──▶ FASE 5 (ponte checkout→logística) ──▶ FASE 6 (simulação integrada)
                                                        │
                                                        ▼
                                              FASE 7 (homologação)
```

Cada incremento: migration aditiva + recurso/rota + testes (memória e PG real)
+ documentação, mantendo `typecheck`/`lint`/auditorias verdes.

---

## 10. Critérios de aceite

1. Auditoria documentada (este arquivo). ✅
2. Modelo comercial canônico definido (`docs/commerce/*`).
3. 72 colunas classificadas (mapeada / pendente / ambígua) — sem desaparecimento.
4. Importação com `DRY-RUN`/`VALIDATE`/`IMPORT`, idempotente, auditável, com
   relatório por linha.
5. Preços oficiais preservados; nada sobrescrito sem confirmação.
6. Motor de preços/rentabilidade implementado ou lacuna documentada.
7. Motor tributário dentro do escopo validado; pendências fiscais explícitas.
8. Motor logístico dentro do escopo possível; adapters documentados/testados.
9. Vendas e financeiro integrados **sem duplicidade** (ponte `sales→vendas`).
10. Proteção de concorrência de estoque provada.
11. Cenários críticos de homologação aprovados.
12. Sem regressões conhecidas sem documentação.
13. Migrations revisadas (colisão 0116 resolvida).
14. Documentos técnicos atualizados.
15. Nada executado em produção; nenhum merge em `main`; nenhum deploy.
