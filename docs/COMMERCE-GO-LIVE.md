# COMMERCE — Go-live (BROBOND COMMERCE OS)

> Checklist operacional para levar o Commerce de homologação para produção.
> O gate `npm run commerce:go-live` (script `scripts/commerce-go-live-audit.ts`)
> é a autoridade: **READY** só com P0 zerados; qualquer P0 aberto →
> **BLOCKED** e exit 1.

## 1. Sequência oficial de comandos (§54 — rodada completa)

```bash
npm run install:all          # workspaces + dependências
npm run typecheck            # domain + server + client
npm run test:server          # unitários (inclusivos commerce)
npm run test:client          # visuais + fluxos (13 rotas commerce + loja)
npm run audit:menu           # menu/rotas: zero erros
npm run test:pg              # gate PostgreSQL (banco VAZIO; psql 18.4 no PATH)
npm run smoke                # smoke HTTP demo
npm run smoke:pg             # smoke contra PG
npm run commerce:go-live     # gate READY/BLOCKED (exit 1 se P0)
npm run go-live:audit        # auditoria final consolidada (scripts/final-go-live-audit.ts)
```

Requisitos do ambiente: PostgreSQL 16.14 com banco vazio para `test:pg`;
`psql` ≥ 17 no `PATH` (sem ele há skips e o gate falha); variáveis de produção
na seção 3.

## 2. Gate `commerce:go-live` — escopo

O script audita e classifica:

- **P0 (bloqueia)**: migração 0068 espelhada no `schema.sql`; tabelas existindo
  de verdade no banco alvo; checkout→webhook→`PAGO`→conversão com provas de
  teste presentes; frete fail-closed; RBAC `checkFluxoEscrita`/`minPerfilEscrita`
  nos 6 writes de catálogo; tenancy `empresa_id` derivado do ator; zero modal
  no fluxo operacional (audit em `client/src/pages/commerce`); capabilidade
  `CAPACIDADE_SEM_TESTE = 0` (`capacidades-audit`); módulos `planned`
  indevidos zerados; webhooks com assinatura + idempotência.
- **P1 (aviso, não bloqueia)**: credenciais dos conectores ausentes
  (esperado até o cliente provisionar), Instagram `REJECTED` (limitação
  documentada da Graph API), ausência de conector UI WooCommerce.
- **P2 (melhoria)**: extensões futuras (carrier de frete externo, imagens do
  marketplace, sync de estoque ida-e-volta além da leitura do canônico).

Saída: `COMMERCE GO-LIVE: READY` ou `COMMERCE GO-LIVE: BLOCKED (…)`.

## 3. Checklist antes de aceitar o primeiro pedido real

- [ ] **Mercado Pago**: access token de produção nas configs do servidor;
      `webhook_segredo_cifrado` por empresa preenchido; URL pública
      `POST {origem}/api/gateway/webhooks/mercadopago` registrada no painel do
      MP; **testar 1 pagamento real e conferir `commerce_pedidos=PAGO` sem
      toque no frontend**.
- [ ] **Frete**: provider `manual` (tabela/valor por CEP) ou `retirada`;
      confirmar que sem config o checkout responde “Frete não configurado”.
- [ ] **Responsável do checkout**: `responsavelCheckout` resolvido
      (config por empresa ou usuário dono) — usado nas respostas públicas.
- [ ] **Domínio/SSL da vitrine** (`/loja`) com HTTPS e `LOJA_URL`/origem
      coerente com `empresaDaVitrine` (fail-closed por design).
- [ ] **Perfis**: gerente/admin para escrita de catálogo/preço/publicação;
      operador apenas leitura (403 no backend, não só escondido na UI).
- [ ] **CI**: job `testes-postgres` com service PostgreSQL 16.x, `psql` no
      PATH, banco vazio por run (`createuser -s`/`createdb`), fluxo
      `install:all → typecheck → test:server → test:client → test:pg`.
- [ ] **Backup/rollback**: dump antes do deploy da 0068; rollback = não
      remover a migração histórica, apenas desligar as rotas (dados intactos).
- [ ] **Observabilidade**: monitorar
      `/api/commerce/eventos` (outbox/fila `ERROR`), webhook events
      (`assinatura_ok=false` = ataque/segredo trocado) e expirações.

## 4. Pós go-live (primeiras 24 h)

1. Publicar um produto real pelo fluxo (não pela mão no banco) e conferir
   `external_id` + estado `PUBLISHED`.
2. Fazer um checkout real → conferir reserva ativa → webhook → `PAGO` →
   `POST /commerce/pedidos/:saleId/converter` → linha em `vendas` (ponte).
3. Cancelar um pedido pago de teste → conferir liberação da reserva e status.
4. Conferir cupom com `uso_maximo` esgotado → 409 no checkout.

## 5. Comandos úteis

```bash
# fila/observabilidade
curl -H "Authorization: Bearer <token>" $API/commerce/eventos
# reprocessar publicação manualmente
curl -X POST -H "Authorization: Bearer <token>" $API/commerce/publicacoes/:id/reprocessar
# projeção + preço por canal (ex.: ML)
curl -X POST -H "Authorization: Bearer <token>" $API/commerce/produtos/:id/projetar
```
