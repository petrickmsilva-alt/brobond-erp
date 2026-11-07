# ADR-008 — Identidade comercial: empresa × canal × loja × plataforma × representante

* **Status:** aceita em 2026-11-07 (Agente 07, achado **A06-10**). Decisão arquitetural implementada e documentada. **Sem mudança destrutiva de dados.**
* **Escopo:** identidade de canal/loja na operação (`vendas`, `pedido_externo_canal`, `store_key`) e na analítica (`sales`, `sale_channel`); `server/src/negocios.ts` (projeção `vendas → sales`); `db/migrations/0103`.
* **Relacionados:** `docs/AGENTE-06-MATRIZ-COMERCIO-UNIFICADO.md` §1–2; `docs/AGENTE-07-RELATORIO-FINAL.md`; `docs/AGENTE-07-RUNBOOK-CUTOVER-LEGADO-MULTISTORE.md`.

---

## 1. Contexto

A auditoria do Agente 06 (A06-10) mostrou que a identidade de canal não fecha:

- `sale_channel` (analítico) continha `BROBOND`, mas não `RETAIL`, `WHOLESALE` ou `REPRESENTATIVE`.
- Woo usava `store_key` / `pedido_externo_canal` em maiúsculas (`WOOCOMMERCE_RETAIL`, `WOOCOMMERCE_WHOLESALE`), enquanto `vendas.canal_venda` usava texto operacional (`site_varejo`, `site_atacado`).
- Representante usa `canal_venda = 'representante'`; o pacote de domínio tinha `REPRESENTATIVE`, mas o banco analítico não.
- `canalErpParaSales` mapeava tudo que não era PDV/balcão para `BROBOND`.
- A loja nativa `/loja` e o RETAIL Woo apareciam em código/rótulos com `brobond.com.br`, sem decisão de DNS/edge no repositório que determinasse se são a mesma experiência ou experiências distintas.

Sem essa decisão, relatórios não distinguem origens e a ausência Woo no BI (A06-05) não pode ser corrigida apenas ligando a projeção.

## 2. Decisão

Cinco conceitos distintos, com relação explícita:

| Conceito | Definição | Representação canônica |
|---|---|---|
| **Empresa** | Tenant (`empresa_id`). Fronteira de dados. | `empresa_id` em todo registro |
| **Canal comercial** | Origem de negócio: `BROBOND`, `RETAIL`, `WHOLESALE`, `REPRESENTATIVE`, `MARKETPLACE`, `PDV` | `sale_channel` (analítico) / `canal_venda` (operacional) |
| **Loja** | Instância de vitrine dentro de um canal: `RETAIL` / `WHOLESALE` | `store_key` (`RETAIL`/`WHOLESALE`) |
| **Plataforma externa** | Sistema de origem do pedido: `WOOCOMMERCE`, `MERCADOLIVRE`, … | `pedido_externo_canal` (`WOOCOMMERCE_RETAIL`, …) |
| **Representante** | Pessoa de venda, ligada a `representantes` | `representante_id` + canal `REPRESENTATIVE` |

Regras:

1. **Empresa ≠ canal ≠ loja ≠ plataforma ≠ representante.** Um não substitui o outro.
2. O canal analítico passa a distinguir as origens reais (`RETAIL`, `WHOLESALE`, `REPRESENTATIVE`), não mais colapsando tudo em `BROBOND`.
3. A loja de origem é sempre resolvida por `store_key`; a plataforma por `pedido_externo_canal`.
4. A projeção `vendas → sales` (A06-05) usa essa identidade para representar pedidos Woo no BI **sem** duplicar a `sale` original de marketplaces que já a possuem.
5. Representante é atribuído por `venda_atribuicao` + canal `REPRESENTATIVE`, coerente com `comissoes_apuradas`.

## 3. Alternativas consideradas

- **Colapsar tudo em `BROBOND`** (status quo): rejeitada — é a causa do achado; torna o BI cego a RETAIL/WHOLESALE.
- **Criar um enum analítico novo só para Woo**: rejeitada — duplicaria o conceito de canal e criaria uma segunda estrutura concorrente (proibido pelo escopo).
- **Inferir loja pelo número externo do pedido**: rejeitada — colide entre lojas (A06-03) e não é prova de origem.

## 4. Consequências

- BI passa a distinguir RETAIL/WHOLESALE/REPRESENTATIVE; relatórios e operação usam a **mesma** semântica.
- Compatibilidade preservada: `BROBOND` continua válido; a mudança é **aditiva** no vocabulário de canal.
- Nenhum campo histórico é renomeado ou removido. Não há migration destrutiva.
- A identidade de domínio público (DNS/edge de `brobond.com.br` × RETAIL) permanece **decisão de negócio pendente**, fora do escopo desta missão (ver §6).

## 5. Estratégia de compatibilidade e migração

- **Sem migration de dados** para esta decisão: os campos já existem (`store_key`, `pedido_externo_canal`, `canal_venda`).
- A projeção analítica passa a **derivar** o canal a partir desses campos, com queda para `BROBOND` quando a origem não for distinguível (registros legados).
- Registros legados ambíguos (sem `store_key`) permanecem como estão — **não** são reatribuídos arbitrariamente.
- A migration `0103` (deste saneamento) adiciona apenas escopo de loja em `commerce_precos` e a coluna de evidência de preço; não altera a identidade de canal.

## 6. Plano de transição (não executado nesta missão)

1. Definir com o negócio se `/loja` nativo e RETAIL Woo são a mesma jornada pública (decisão de DNS/edge).
2. Se forem distintos, fixar o canal analítico de cada um e cobrir com teste de projeção.
3. Homologar com dados reais em dry-run antes de qualquer cutover (ver runbook).

## 7. Riscos residuais

- A decisão de domínio público depende do Diretor; enquanto não tomada, relatórios tratam `/loja` e RETAIL como origens potencialmente distintas.
- A homologação externa das lojas não foi feita; a decisão é de código/documento, não de produção.
