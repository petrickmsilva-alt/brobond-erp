# RECONCILIAÇÃO ARQUITETURAL — 2026-11-14 (Etapa 03)

**Branch:** `arena/20369110-brobond-erp` · **Base:** `7742332` (`main`)
**Método:** espec original × evolução Commerce × código atual, com números de
`npm run architecture:audit` (inventário regenerado nesta data) e leitura direta
de `server/src`, `modules/`, `client/src`, `db/`.

> **Fonte única de estado atual:** `docs/ERP-3.0-ARCHITECTURE-INVENTORY.json`
> (regenerável) + este documento para a classificação por domínio.
> Documentos datados continuam válidos COMO HISTÓRICO da fase que descrevem.

## 1. Números atuais (lidos do código, não digitados)

| Dimensão | Valor |
|---|---:|
| Migrations SQL / Prisma | **122 / 7** |
| Tabelas (com `empresa_id`) | **237 (215)** |
| Índices / constraints nomeados | **663 / 463** |
| Recursos de API (multiempresa) | **199 (179 — 89,9%)** |
| Módulos de navegação (planejados) | **152 (0)** |
| Rotas HTTP | **509** |
| Testes declarados (server+client) | **3.964** |
| `TENANT_SEM_TESTE` | **0** (era 19 — fechado na Etapa 02) |

## 2. Matriz de domínios (espec × evolução × código)

Estados: **IMPLEMENTED** (código+testes) · **PARTIAL** (parte existe, falta
escopo declarado) · **NOT_IMPLEMENTED** (nada no código) · **NOT_PROVEN**
(existe, evidência externa insuficiente) · **DEPRECATED** (retirado por decisão)
· **BLOCKED** (dependência externa).

| Domínio | Espec original (ERP-MASTER/DOMAIN-MAP) | Evolução Commerce | Código atual | Estado | Classificação da divergência |
|---|---|---|---|---|---|
| ERP Core (empresas/usuários/RBAC) | núcleo multiempresa | preservado | `empresa.ts`, `auth.ts`, CRUD+RBAC; testes A×B | **IMPLEMENTED** | evolução legítima |
| PIM (produto/grade/variação) | cadastro confecção | projeção commerce | `resources.ts`, `variacoes.ts`, grade/tamanhos | **IMPLEMENTED** | evolução legítima |
| Commerce (catálogo/canais) | — (veio depois) | Commerce OS (0068) | `commerce/catalogo.ts`, outbox, publicações | **IMPLEMENTED** (estrutura) | evolução legítima documentada (COMMERCE-ARCHITECTURE) |
| Loja pública nativa `/loja` | — | vitrine própria (fase inicial) | **removida**; 301/410 (`loja-nativa-retirada.ts`) | **DEPRECATED** | decisão formal ADR-0007 (Diretor); gate final reconciliado nesta missão |
| OMS (pedidos) | vendas ERP | `commerce_pedidos` + projeção `sales→vendas` | `pedidos.ts`, `garantirPedidoDaSale`, E2E PG | **IMPLEMENTED** | evolução legítima |
| WMS (estoque canônico) | estoques/movimentações | reservas via motor existente | `estoqueCanonico.ts`, `criarReservaInterna`, rollback 25P02 | **IMPLEMENTED** | evolução legítima |
| TMS (logística) | envios | logistics engine multi-canal | `modules/logistics` (Melhor Envio/Correios/manual) | **NOT_PROVEN** (código+testes locais; sem homologação externa; Correios sem SIGEP) | bloqueio externo registrado |
| Payments | gateway ERP | Payment Engine (intents/settlement/disputes) | `modules/payments` (stripe/pagbank/mercado-pago/manual/generic/testing) | **NOT_PROVEN** (estrutura PASS; homologação externa pendente) | bloqueio externo registrado |
| CRM/CX | funil configurável | — | `crm.ts`, tickets, lifecycle | **IMPLEMENTED** | — |
| Marketplace/Omnichannel | — | conectores ML/Nuvemshop/MP/Instagram + Woo multi-loja | `modules/connectors`, `commerce/woocommerce/` | **NOT_PROVEN** (credenciais/homologação ausentes no ambiente) | bloqueio externo registrado |
| Marketing/Loyalty | promoções/cupons | campaigns, automações | `promocoes.ts`, marketing_automation | **IMPLEMENTED** | DOMAIN-MAP §2.10 estava desatualizado (`planned` → ativos); corrigido com nota datada |
| Creators | — | — | `creators.ts` ATIVO_MANUAL: cadastro/campanha/parceria/match/outreach manual + atribuição por cupom; geração/envio `false` | **PARTIAL** | evolução legítima; descoberta/geração/envio dependem das Etapas 05/07 (BLOCKED por provedor) |
| BI/Analytics | dashboards | read models + Control Tower | `enterprise45.ts`, `controlTower.ts`, `alerts.ts`, `negocios.ts` | **IMPLEMENTED** | — |
| AI platform | — | — | `ai_providers/prompts/executions/recommendations` + engine determinística (`heuristica-interna`); **nenhum adapter LLM externo** | **PARTIAL** | gap formalizado na Etapa 05 (arquitetura-alvo) |
| Trend Hunter | — | — | só `commerce/analytics.trendsCommerce` (tendência de vendas internas, não descoberta externa) | **NOT_IMPLEMENTED** | spec nova da missão → Etapa 06 |
| Creator Intelligence/Outreach AI | — | — | matching manual com score/evidência; sem descoberta autorizada nem geração | **NOT_IMPLEMENTED** (descoberta/IA) / **PARTIAL** (registro manual) | Etapa 07 |
| AI Studio / AI CEO | — | — | não existem módulos/serviços com esses nomes; Control Tower cobre leitura executiva | **NOT_IMPLEMENTED** | Etapa 08 |
| Fiscal (SPED/EFD) | obrigações | — | layouts versionados (0115) + `validarArquivoEfd`; **sem geração/transmissão** | **PARTIAL** | incompleto declarado (GAP-P2-11); não anunciar como pronto |
| Operational Control Plane (MCP/OAuth 2.1) | — | — | `modules/operational-control` + 0121; PKCE, hash-chain, workflows | **IMPLEMENTED** (interno) | evolução legítima; `oauth_clients` GLOBAL documentado |
| Chat interno | — | — | `chat.ts` persiste em `auditoria` (`recurso='chat'`, scan pageSize 5000) | **PARTIAL** | **desvio não documentado** — precisa formalização (tabela própria ou justificar reuso; sem quebra funcional comprovada) |

## 3. Divergências documentais corrigidas/marcadas nesta missão

1. **Stack real ≠ prosa histórica.** `COMMERCE_ENGINE_AUDIT.md` (2026-11-11) diz
   "Next.js 15 / React 19"; `CURRENT-STATE.md` (Fase 0) diz "React 19". O código
   real é **Vite 6 + React 18.3.1 + Express + PostgreSQL** (`client/package.json`,
   instalado 18.3.1). **Não é desvio arquitetural** (diretriz da missão): a
   espec Next.js era histórica; o monólito modular Vite/Express é a arquitetura
   aceita (ADR-0001). Prosa corrigida com nota datada, histórico preservado.
2. **Módulos `planned` não existem mais.** `DOMAIN-MAP.md` §2.10 e GAP-P3-03
   falavam de 8 módulos planejados; o inventário atual: **152 módulos, 0
   planejados**. Nota datada adicionada; Creators é ATIVO_MANUAL (capabilities
   honestas), não "planned".
3. **Gate final do Commerce × ADR-0007 eram mutuamente exclusivos.**
   `commerce:final-go-live` exigia `vitrine.ts`/`LojaCarrinhoPage`/rota
   `/loja/checkout` — arquivos que `fase2-loja-coerencia.test.ts` exige que
   NÃO existam (retirada executada por decisão do Diretor). Gate atualizado
   para a arquitetura aceita: checkout interno serializable (`checkout.ts`),
   tratamento 301/410, coerência ADR-0007 travada por teste, E2E PG real.
   Resultado: estrutural **SIM** (0 P0/P1); `CODE_READY`/`FULL_GO_LIVE`
   continuam **NÃO** (o script, por desenho, não certifica homologação externa).
4. **Identidade de migrations** (Etapa 01): gate final alinhado ao runner
   (nome completo; colisão 0121 histórica registrada) — ADR-0015.
5. **Números da Fase 0** (104 migrations/174 recursos) são fotografia histórica;
   o estado atual é o inventário regenerado (§1). `CURRENT-STATE.md` recebeu
   nota de atualização apontando para cá.

## 4. O que permanece pendente de decisão do Diretor

| Item | Estado | Ação |
|---|---|---|
| Reconciliação do prefixo 0121 (rename) | BLOQUEADO — exige consulta read-only ao `schema_migrations` de produção | autorizar consulta + plano (Etapa 01 §5) |
| Chat em `auditoria` | desvio não documentado (funcional) | formalizar (ADR) ou migrar para tabela própria em missão futura |
| SPED/EFD geração | PARTIAL deliberado | escopo com contabilidade antes de implementar |
| Homologação externa (payments/canais/logística) | BLOCKED — credenciais e egress ausentes |matriz em `EXTERNAL-HOMOLOGATION-MATRIX.md` + Etapa 04 |
