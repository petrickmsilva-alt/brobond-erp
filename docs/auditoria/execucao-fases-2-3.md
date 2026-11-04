# Execução — Fases 2 e 3 (segredos, webhooks e pagamentos)

Branch: `arena/c0104925-brobond-erp` (sem PR, sem merge, sem deploy, sem alteração no Render, conforme decisão (a)).
Commits: `300ba0c` (Fase 2) e `1e5e57c` (Fase 3). Fase 0–1 em `0c0e6f5` (ver `execucao-fase-0-1.md`).

Legenda de evidência: **LOCAL** = teste automatizado sem rede; **HOMOLOG.** = sandbox do provedor; **PROD.** = produção. Nesta entrega só há evidência LOCAL.

## Fase 2 — segredos e webhooks

### Feito

| Item | Evidência |
|---|---|
| Webhook ML do conector recusa entrega sem `MERCADOLIVRE_WEBHOOK_SECRET` (antes aceitava) | LOCAL — `fase2-seguranca-credenciais.test.ts` (RED antes, GREEN depois) |
| Webhook MP do conector e MP do legado recusam sem segredo | LOCAL — idem |
| Deduplicação ML por `_id` ou hash do corpo (não mais `topic:resource`, que colapsava eventos distintos) | LOCAL — idem |
| P2-10: conflito de `evento_id` sem assinatura válida responde 401 uniforme e não toca no registro alheio | LOCAL — idem |
| Cifra consolidada em `server/src/chavesCifra.ts` para `segredos` e MFA; chave primária cifra, legadas só leem | LOCAL — testes de compatibilidade de leitura |
| Produção sem chave de cifra falha explicitamente; literal de desenvolvimento não é usado | LOCAL |
| JWT verificado com `algorithms: ['HS256']` (auth e websocket) | LOCAL — suíte de auth existente |
| `.env.example` documenta `SEGREDOS_ENCRYPTION_KEY`, `MFA_ENCRYPTION_KEY`, `APP_ENCRYPTION_KEY` (comentados, sem valor) | Revisão de texto |
| Plano de migração de segredos (não executado) | `docs/seguranca/plano-migracao-segredos.md` |

Suíte do servidor após a Fase 2: 1681 aprovados / 0 falhas / 76 ignorados (linha de base 1667). `tsc --noEmit` do servidor: EXIT 0.

### Não feito (com motivo)

- **`render.yaml` não alterado** (`sync: false` para as chaves): mudança de blueprint exige autorização específica.
- **`APP_URL` como base única (P2-05):** não iniciado; exige mapeamento de todos os usos de URL pública.
- **Migração efetiva dos valores cifrados:** não executada. Depende da confirmação de presença das chaves no Render e da ferramenta de contagem por fonte (ver plano).
- **Rotação de `CONNECTOR_ENCRYPTION_KEY`:** fora da consolidação; sem ferramenta.

### Premissa não verificada

A segurança dos webhooks ML/MP em produção depende de `MERCADOLIVRE_WEBHOOK_SECRET` e `MERCADOPAGO_WEBHOOK_SECRET` estarem configurados. O Diretor informou que estão; **não verifiquei**. Sem eles, esses webhooks passam a recusar todas as entregas — o deploy só deve ocorrer após essa confirmação.

## Fase 3 — pagamentos

### Feito

| Item | Evidência |
|---|---|
| Caminho canônico definido: Payment Engine (`modules/payments/`); gateway legado vira adaptador de compatibilidade | `docs/pagamentos/ADR-001-motor-canonico.md` (proposta, sem decisão específica do Diretor) |
| P3-01: placeholders (`PIX_DIRECT`, `BOLETO_GENERIC`, `ACQUIRER_GENERIC`) saem da configuração e das regras; continuam no registro | LOCAL — `fase3-pagamentos-canonico.test.ts`; `PaymentEnginePage.test.tsx` 3/3; typecheck do cliente EXIT 0 |
| Contratos locais do engine: Stripe (sem segredo recusa; janela de 300 s; corpo adulterado recusa), PagBank (sem token recusa; hash confere), placeholders falham fechados | LOCAL — 5/5 |
| Checklist de homologação sandbox (MP, PagBank, Stripe) com critério de evidência | `docs/pagamentos/homologacao-sandbox.md` — **NÃO EXECUTADA** |

Achado durante o teste: a verificação inicial por `instanceof` marcaria todos os adaptadores reais como placeholder, porque herdam da base fail-closed. Corrigido com comparação de classe exata e coberto por teste.

Suíte do servidor após a Fase 3: 1686 aprovados / 0 falhas / 76 ignorados.

### Não feito

- **Migração da cobrança avulsa do Mercado Pago** (`/api/financeiro/gateway/cobrancas`) para o engine: não iniciada; decisão de cronograma pendente.
- **Ponto único de webhook (P1-07):** duas portas de entrada continuam ativas.
- **P3-02 (PagBank):** deduplicação por hash do corpo mantida. Não alterei sem confirmar o contrato de reentrega do PagBank, que não verifiquei.
- **Homologação com provedores:** nenhuma. Sem egress e sem credenciais de sandbox nesta sandbox.

### Observação de comportamento (não alterada)

A cobrança avulsa sem `idempotency_key` gera a chave pelo hash do corpo da requisição. Duas cobranças idênticas intencionais dentro da mesma requisição lógica retornam a primeira (`idempotente: true`). É o comportamento desejado para reenvio, mas um operador que quiser uma segunda cobrança igual precisa informar outra chave. Registrado para revisão.

## Pendências que dependem de decisão do Diretor

- **(b) Migração Nuvemshop v1 → 2025-03:** **aprovada pelo Diretor depois desta execução.** A publicação migrou (commit `2c93e33`, ver `execucao-migracao-nuvemshop-2025.md`); a leitura de pedidos e produtos segue pendente.
- **(d) Novas variáveis:** **não autorizada** pelo Diretor. Sem novo secret do WhatsApp, o webhook de status do WhatsApp não pode ter verificação de assinatura; fica pendente.
- **(f) Liberação do ML em produção:** depende de homologação e reconciliação de anúncios duplicados por P0-01 (não feita).

## Limitações

- Sem acesso a produção, Render, Meta, ML, Nuvemshop, PagBank, Stripe ou Mercado Pago em sandbox.
- Nenhuma afirmação de integração funcional com provedor externo foi feita nesta entrega.
- Os valores dos secrets de webhook em produção não foram lidos nem verificados.
