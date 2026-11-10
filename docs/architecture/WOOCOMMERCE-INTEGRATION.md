# WOOCOMMERCE-INTEGRATION — integração WooCommerce multi-loja (Fase 9.4)

**Data:** 2026-11-09 · **Branch:** `architecture/fases-9-4-9-5-9-6`
**Código:** `server/src/commerce/woocommerce/` (registry, cliente, estado, sync,
webhookRouter, rotas), `server/src/loja.ts` (single-store legado)
**Migrations:** 0100 (multi-loja), 0101 (webhooks/reconciliação), 0103 (preço × store_key)

> **Escopo.** RETAIL e WHOLESALE usam **componentes e contratos compartilhados**
> com **configuração isolada por loja**. Não há serviço duplicado "para RETAIL" e
> "para WHOLESALE". Nada é publicado/sincronizado em produção por este documento.

## 1. Registry multi-loja (`registry.ts`)

| Constante | Valor |
|---|---|
| `STORE_KEYS` | `['RETAIL', 'WHOLESALE']` (imutável, ordem estável) |
| `STORE_LABEL` | rótulo humano (nunca identidade) |
| `FONTE_PRECO` | `RETAIL → preco_venda`, `WHOLESALE → preco_atacado` |
| `CANAL_PEDIDO` | `RETAIL → site_varejo`, `WHOLESALE → site_atacado` |
| `configStore(store)` | URL + CK + CS + `empresaId` (uma loja **nunca** serve duas empresas) |

## 2. Configuração por loja (ambiente, nunca versionada)

```
WOOCOMMERCE_MULTI_STORE_ENABLED   liga o modo multi-loja (default false)
WOOCOMMERCE_RETAIL_ENABLED        habilita a loja RETAIL
WOOCOMMERCE_RETAIL_URL / _CK / _CS
WOOCOMMERCE_WHOLESALE_ENABLED     habilita a loja WHOLESALE
WOOCOMMERCE_WHOLESALE_URL / _CK / _CS
WOOCOMMERCE_SYNC_DRY_RUN          true = nada é escrito nas lojas
```

Toda variável lida no código **tem** linha em
`docs/auditoria/matriz-configuracao-producao.md` (teste
`config-inventario-producao` trava isso) e **toda** chave do `render.yaml`.

**Compatibilidade:** com o modo multi-loja **desligado**, o comportamento é o de
sempre (`WOOCOMMERCE_URL/CK/CS` single-store, canal por `WOOCOMMERCE_CANAL`).
`loja.ts` continua sendo a implementação desse caminho.

## 3. Componentes compartilhados

| Componente | Papel |
|---|---|
| adaptador/cliente | chamadas à API WooCommerce por loja (credencial explícita) |
| mapeamento de produtos/variantes/SKUs | `woocommerce_product_links.store_key` |
| mapeamento de clientes | por loja, sem colisão entre lojas |
| importação de pedidos | referência `WOO-<store_key>-<id>` |
| atualização de status | por loja |
| reconciliação | leitura; nunca sobrescreve dado canônico do ERP |
| webhooks | assinatura verificada quando aplicável (`webhookRouter`) |
| idempotência | chave com `store_key` no outbox |
| retry com backoff | outbox (`commerce_outbox`: claim CAS, backoff, dead-letter) |
| observabilidade | histórico de sincronização + última sincronização/erro |

## 4. Ciclo completo de pedido

```
WooCommerce → Webhook/API → Identificação da loja → Validação → Idempotência
            → Pedido ERP → Itens → Pagamento → Estoque → Reconciliação
```

- O mesmo evento recebido mais de uma vez **não** gera pedido duplicado nem
  movimentação financeira repetida (idempotência por origem).
- Isolamento por **loja** e **empresa**: evento que tenta operar sobre loja/
  empresa não autorizada é **recusado**.
- Eventos fora de ordem e payload inválido são tratados/recusados; falhas
  transitórias recuperam via retry.

## 5. Painel e rotas

| Método | Rota | Papel |
|---|---|---|
| `GET` | `/api/commerce/canais` | visão unificada (Fase 9.4) |
| `GET` | `/api/commerce/woocommerce/status` | status das lojas |
| `GET` | `/api/commerce/woocommerce/lojas` | painel multi-loja |
| `GET` | `/api/commerce/woocommerce/lojas/:store` | painel por loja |
| `GET` | `/api/commerce/woocommerce/lojas/:store/reconciliacao` | reconciliação |
| `POST` | webhook público | eventos da plataforma (assinatura verificada) |

A loja vem **do path** e é validada contra o registry; o escopo de empresa vem
do ator. Não há acesso cruzado por identificador previsível.

## 6. Limites de homologação externa

| Item | Status |
|---|---|
| Contratos internos, isolamento, idempotência, retry, reconciliação | **IMPLEMENTADO E TESTADO** (com fixtures/simulação) |
| Validação contra WooCommerce **real** | **HOMOLOGAÇÃO EXTERNA PENDENTE** (faltam credenciais de homologação; sem compra real) |
| Ativação de conector / sincronização real | **BLOQUEADO POR DEPENDÊNCIA EXTERNA** |
| REPRESENTATIVES | **NÃO IMPLEMENTADO** (sem conector no repositório) |
