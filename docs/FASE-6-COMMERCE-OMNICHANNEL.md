# FASE 6 — COMMERCE & OMNICHANNEL

**Escopo:** reconciliação multicanal unificada e painel operacional de
sincronização sobre o núcleo comercial já existente.

> Esta fase **não recria** o commerce. Ela completa a camada que faltava: um
> único lugar que responde "quais divergências existem agora, em qualquer canal,
> por empresa, com gravidade e ação recomendada?" — sem duplicar catálogo,
> preço, estoque, pedidos, OMS, pagamento, logística ou integrações.

## 1. Estado anterior (reutilizado, não reimplementado)

| Capacidade | Autoridade existente |
|---|---|
| Catálogo/preço/estoque canônicos | `produtos`, `commerce_produtos`, `commerce_precos`, `commerce_publicacoes`; estoque por `estoqueCanonico`/`disponibilidadesPorTamanho` |
| Pedidos externos | `commerce_pedidos`, `sales`, OMS (migração 0109) |
| Fila/idempotência | `commerce_outbox` (claim CAS, backoff, dead-letter) |
| Reconciliação ERP × loja WooCommerce | `woocommerce_reconciliacao_divergencias` (migração 0101) |
| Conectores | `server/src/connectors.ts`, `modules/connectors/*` |

## 2. O que a Fase 6 acrescenta

### 2.1 Reconciliação multicanal unificada — `commerce_reconciliacao` (migração 0110)

Trilha **aditiva** de divergências entre o ERP e o estado REGISTRADO de cada
canal. Cobre as dimensões `CATALOGO`, `PRECO`, `ESTOQUE`, `PEDIDOS` e
`CONECTOR`, com classificação (`LEGITIMA`/`AUTOMATICA`/`HUMANA`), severidade
(`baixa`/`media`/`alta`/`critica`) e ação recomendada.

Regras de integridade:

- **Identidade lógica por `fingerprint`** (UNIQUE por empresa): a mesma
  ocorrência reabre quando volta a existir, em vez de empilhar linhas; o que
  deixou de ser detectado é fechado como `CORRIGIDA`.
- **Nenhuma sobrescrita automática** de dado canônico do ERP. `AUTOMATICA`
  significa "a correção é segura", não "a correção foi feita".
- **Multiempresa:** `empresa_id` NOT NULL; toda leitura recorta por empresa.
- A trilha WooCommerce (0101) **não é substituída**: o painel a agrega por loja.

### 2.2 Detecção — honesta e determinística

`detectarDivergencias()` (em `server/src/commerce/omnichannel.ts`) lê apenas
documentos REAIS do ERP e detecta:

- `CATALOGO`: publicação `REJECTED`/`ERROR`; publicação travada > 24h; produto
  publicado no site sem vitrine; produto publicado sem preço vendável.
- `PRECO`: produto publicado no canal sem preço no ERP e sem override por canal.
- `ESTOQUE`: produto publicado com disponibilidade canônica zerada (via
  `disponibilidadesPorTamanho` — físico − reservado/empenhado/bloqueado).
- `PEDIDOS`: pedido externo em `ERRO`/`AGUARDANDO_CORRECAO`; pagamento expirado
  ainda aguardando pagamento.
- `CONECTOR`: evento da fila em `ERRO`/`FALHA`.

Não chama a rede: sem credencial homologada o ERP não afirma o estado do canal —
cada linha aponta para um documento que pode ser conferido na tela.

### 2.3 Painel operacional

`GET /api/commerce/omnichannel/painel` devolve totais por canal/categoria/
severidade, as divergências (com filtros), as divergências WooCommerce agrupadas
por loja e a saúde de cada conector (divergências abertas, fila pendente/erro,
último erro). Tela: `/commerce/omnichannel`.

## 3. APIs

| Método | Rota | Papel | Descrição |
|---|---|---|---|
| GET | `/api/commerce/omnichannel/painel` | gerente+ | Painel operacional (filtros `canal`, `categoria`, `severidade`) |
| POST | `/api/commerce/omnichannel/reconciliar` | gerente+ | Executa a reconciliação (corpo opcional `{ canais: [...] }`) |

## 4. Segurança

- RBAC: recurso `commerce_reconciliacao` com `minPerfil: 'gerente'` e `ops`
  fechado (somente leitura no CRUD genérico); a reconciliação roda por endpoint
  próprio, auditado.
- Multiempresa: `escopoDoAtor` recorta empresa; nenhuma linha cruza tenant.
- Idempotência: `fingerprint` UNIQUE por empresa.
- Auditoria: cada execução grava linha em `auditoria`.
- Sem segredos, sem SSRF: a detecção não faz requisição externa.

## 5. Testes

- `server/test/commerce-omnichannel-reconciliacao.test.ts` — detecção real,
  idempotência por fingerprint, reabertura/fechamento, não sobrescrita do dado
  canônico, isolamento A × B, painel agregado, validação de canal/categoria.
- `client/src/pages/commerce/OmnichannelPage.test.tsx` — render das
  divergências reais, reconciliação com confirmação inline (zero modal), estado
  vazio honesto.
- `client/src/modules.test.ts` — menu/rota do novo módulo.

## 6. Limitações conhecidas

- A detecção é feita sobre o registro OPERACIONAL do ERP. A comparação com o
  estado AO VIVO de cada marketplace depende de credenciais homologadas e
  permanece desativada (ver Fase 6 §conectores).
- Nenhum conector é ativado automaticamente em produção.
