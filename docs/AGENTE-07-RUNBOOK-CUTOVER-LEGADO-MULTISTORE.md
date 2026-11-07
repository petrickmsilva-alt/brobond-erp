# Agente 07 — Runbook de cutover legado → Multi-Store

**Missão:** saneamento da unificação comercial (A06-15).
**Objetivo:** permitir uma ativação controlada do WooCommerce Multi-Store sem
publicar dados incorretos nem misturar RETAIL e WHOLESALE.
**Regra:** este runbook **não** é executado nesta missão. Nenhuma loja real é
tocada, nenhuma flag é ligada, nenhuma importação em massa é feita.

---

## 1. Inventário dos caminhos legados (mapeado)

| Caminho | Tipo | Rota / gatilho | Identificação por loja hoje |
|---|---|---|---|
| `statusLoja` | leitura | `GET /api/marketplace/loja/status` | config única (legado) |
| `produtosLoja` | leitura | `GET /api/marketplace/loja/produtos` | config única (legado) |
| `importarPedidosLoja` | escrita | `POST /api/marketplace/loja/pedidos` | `canal` → RETAIL/WHOLESALE inferido |
| `sincronizarEstoqueLoja` → `enviarEstoqueLojaInterno` | escrita | `POST /api/marketplace/loja/estoque` | config única (legado) |
| Importação de pedidos Multi-Store | escrita | `commerce/woocommerce/pedidos.ts` | `store_key` explícito |
| Outbox `logistics-*` / estoque | escrita | `server/src/commerce/outbox.ts` | `store_key` quando presente |
| Cron `publicacoes` | escrita | `server/src/scheduled.ts` | `store_key` quando presente |
| Webhooks Woo | escrita | rotas de webhook | HMAC + `store_key` |
| Eventos antigos sem `store_key` | escrita | outbox / webhook inbox | **sem loja** — executor legado |

**Estados de correção já aplicados** (esta missão): o legado `importarPedidosLoja`
e `enviarEstoqueLojaInterno` passam a usar a **mesma** política de preço
(`precoAutoridade.ts`) e o **mesmo** motor canônico de disponibilidade. Portanto
os defeitos A06-01/A06-02/A06-03 **não** coexistem mais entre legado e
Multi-Store no código.

## 2. Pré-requisitos (antes de qualquer ativação)

1. `npm run test:pg` **PASS** sem skips (PostgreSQL 16.14, `psql` presente).
2. `WOOCOMMERCE_RETAIL_EMPRESA_ID` e `WOOCOMMERCE_WHOLESALE_EMPRESA_ID`
   declarados no `render.yaml` e conferidos (o fallback empresa 1 não pode
   decidir o tenant da loja).
3. `WOOCOMMERCE_MULTI_STORE_ENABLED` e `WOOCOMMERCE_SYNC_DRY_RUN` no valor
   planejado (começar com `dry_run` ligado).
4. Credenciais CK/CS de cada loja configuradas como segredo (nunca no código).
5. Webhooks de cada loja com segredo e HMAC validados.
6. Decisão de negócio do ADR-008 tomada (domínio público `/loja` × RETAIL).

## 3. Validações ANTES da ativação (dry-run)

- **Preço:** importar pedidos de teste com preço remoto divergente em RETAIL e
  WHOLESALE; conferir que o item grava o preço do ERP e que a divergência é
  registrada. Nenhum preço de produto muda.
- **Estoque:** publicar com `dry_run=1`; conferir que o enviado = disponível
  canônico (físico − reservas − empenhos − bloqueios) por loja.
- **Identidade:** reimportar o pedido externo 777 em RETAIL e em WHOLESALE;
  confirmar duas vendas distintas, sem colisão nem supressão.
- **Mínimo atacado:** importar pedido WHOLESALE abaixo do mínimo; confirmar
  rejeição registrada e item não aceito silenciosamente.
- **BI:** faturar uma venda Woo e confirmar presença em `sales` com o canal
  correto (sem duplicar `sale` de marketplace).

## 4. Sequência de cutover (quando autorizado)

1. Congelar **escritas** legadas: desabilitar `POST /api/marketplace/loja/pedidos`
   e `POST /api/marketplace/loja/estoque` (retornar 409/410 controlado).
2. **Drenar o outbox**: esvaziar a fila pendente antes de trocar o executor.
3. Migrar vínculos e referências legadas para `store_key` explícito — com
   **prova de origem**; pedidos ambíguos ficam marcados, não reatribuídos.
4. Ativar o Multi-Store com `dry_run` ligado; observar uma janela sem erros.
5. Desligar `dry_run`; habilitar escrita por loja.
6. Reconciliar (ver §5).

## 5. Reconciliação pós-cutover

- Rodar `reconciliarLoja` por loja; conferir divergências de vínculo, saldo e
  preço.
- Conferir contagem de pedidos por loja antes × depois (nenhum pedido perdido).
- Conferir que nenhum pedido RETAIL aparece como WHOLESALE e vice-versa.
- Conferir que `sales` cobre as vendas Woo faturadas.

## 6. Plano de rollback

1. Desligar escrita Multi-Store por loja.
2. Reabilitar o caminho legado (agora já usando a política canônica de preço e
   estoque — **não** o comportamento defeituoso original).
3. Reconciliar novamente antes de retomar.

## 7. Indicadores de sucesso e critérios de interrupção

| Indicador | Sucesso | Interrupção |
|---|---|---|
| Pedidos por loja | contagem estável | queda ou colisão |
| Preço persistido | = ERP | remoto vencendo |
| Estoque publicado | = disponível canônico | físico publicado |
| Divergências | registradas e finitas | crescendo sem controle |
| `sales` Woo | presente | ausente após faturamento |

**Interromper imediatamente** se: preço remoto vencer, estoque físico for
publicado como vendável, pedido de uma loja suprimir o de outra, ou venda Woo
não aparecer no BI.

## 8. Caminhos que permanecem legados

Enquanto o cutover não ocorrer: `statusLoja` e `produtosLoja` (leitura) seguem
legados; as escritas legadas **já** obedecem à política canônica de preço e
estoque. A desativação definitiva do legado é passo do cutover (§4.1).
