# ADR-003 — Webhooks de saída associados à empresa

* **Status:** aceita em 2026-11-04 (Fase 4.3, risco **R-14**). Implementada localmente (migração `0097`, PG 16.14 local 5/5). **Entrega HTTP real não verificada** (H-11 pendente).
* **Escopo:** `server/src/webhooks.ts`, `server/src/webhookEmpresa.ts`, `server/src/usuariosAdmin.ts`, `server/src/services.ts` (eventos `usuario.*`), `db/migrations/0097_webhooks_empresa.sql`.
* **Relacionados:** `docs/auditoria/fase-4-3-registro.md` (R-14); `docs/operacao/runbook-incidentes-conectores.md` §7.2.

---

## 1. Contexto

Os webhooks de saída eram globais. O disparo de eventos não filtrava por empresa: um evento de uma empresa podia ser entregue a webhooks de outra. Isso é vazamento entre tenants e foi confirmado por leitura de código.

## 2. Decisão

- `webhooks.empresa_id` e `webhook_entregas.empresa_id` **nullable**, com FK e índices. **Sem backfill.** `NULL` = global (legado).
- Evento **de empresa** é entregue **somente** a webhooks da mesma empresa.
- Evento **sem empresa** é entregue **somente** a webhooks globais.
- Gestão (listar, criar, editar, excluir, testar, listar e reenviar entregas) é restrita à empresa do contexto. Webhook global e entrega `NULL` ficam **fora de escopo (404)**, inclusive na listagem.
- A empresa de criação e a de eventos `usuario.*` vêm de `empresaDoContexto(actor)`, validada por `escopoDoAtor`. **Nunca** do corpo da requisição nem do payload. Sem empresa única (sem vínculo ou modo consolidado), o evento é global.
- Os recursos **não** declaram `empresa: true`; `empresa_id` é campo declarado e somente leitura. Declarar `empresa: true` inferia a empresa 1 no store em memória e aplicava filtro automático no PostgreSQL. Essa alternativa foi descartada.

## 3. Consequências

- **Webhooks legados (`empresa_id` NULL) não recebem eventos de empresa** e ficam invisíveis para administradores de empresa até associação posterior auditada. **Decisão pendente do Diretor (G3):** procedimento de associação e destino dos legados.
- Migração `0097` aditiva. Rollback documentado (somente após reverter o código; sem apagar dados de negócio) em `fase-4-3-registro.md`.

## 4. Verificação

- RED 9/9 → GREEN 11/11 (`webhooks-empresa-isolamento.test.ts`, `webhooks.test.ts`, `webhook-empresa-resolucao.test.ts`).
- Regressão 83/83. PG local 5/5 (`pg-webhooks-empresa.test.ts`, banco temporário, removido após o uso).
- Não há entrega HTTP real a endpoint de cliente: isso é H-11, pendente.
