# ADR-002 — Cron em processos independentes, sem recorrências financeiras

* **Status:** aceita em 2026-11-04 (Fase 4.3, risco **R-4**). Implementada localmente; **não homologada**: a reconfiguração do agendador de produção depende de decisão do Diretor (G1).
* **Escopo:** `server/src/scheduled.ts`, `server/src/index.ts` (rotas de cron), `server/src/commerce/outbox.ts`, `server/src/financeiro.ts`.
* **Relacionados:** ADR-001 (fonte única do faturamento); `docs/auditoria/matriz-configuracao-producao.md` §13.1; `docs/operacao/runbook-incidentes-conectores.md` §7.1.

---

## 1. Contexto

Antes da 4.3, uma única rota de cron executava, em sequência, relatórios, pagamentos, publicações, pedidos, CRM e **recorrências financeiras**. Problemas:

1. Uma falha em um processo interrompia os demais (acoplamento).
2. Não havia como disparar só um processo nem limitar a concorrência por processo.
3. Recorrências financeiras (cobranças reais) rodavam **automaticamente** dentro do cron, sem confirmação humana.
4. O relatório de falhas de entrega podia disparar efeitos colaterais: é um requisito que ele **não** dispare execução financeira, publicação ou recuperação.

## 2. Decisão

- **Cinco processos independentes**, cada um com rota própria, trava de concorrência por instância (409) e registro de execução sem segredo nem payload:
  `relatorios`, `pagamentos`, `publicacoes`, `pedidos`, `crm`.
- Rota: `POST /api/admin/scheduled/cron/:processo`, autenticada **somente** por `Authorization: Bearer <CRON_SECRET>`. Sessão de usuário não autentica o cron.
- `POST /api/admin/scheduled/cron` (legado) executa **somente** `relatorios`.
- **Recorrências financeiras saem do cron.** Só rodam por `POST /api/admin/financeiro/recorrencias`, com confirmação explícita (`PROCESSAR_RECORRENCIAS`).
- O relatório de falhas de entrega é informativo: não aciona pagamentos, publicações nem recuperação.
- Não há agendador interno. O disparo é externo (um job por processo).

## 3. Consequências

- **Operacional (mudança com impacto):** o agendador externo precisa de **um job por processo**. Sem reconfiguração, pagamentos, publicações, CRM e recuperação de pedidos **param**. `render.yaml` não declara cron e não foi alterado.
- A frequência de cada job não é definida neste repositório.
- Recorrências financeiras deixam de ser automáticas. Isso é intencional e exige operação explícita.
- Variáveis: somente `CRON_SECRET` (existente). Nenhuma variável nova.

## 4. Verificação

- RED 10/10 → GREEN 10/10 (`server/test/cron-processos-independentes.test.ts`).
- Regressão 36/36 (cron e recorrências) e 128/128 (publicações, CRM, outbox, notificações, catálogo).
- Nenhuma operação financeira real foi executada; os testes usam store em memória e mocks.

## 5. Alternativas descartadas

- Manter o cron único com flags: mantém o acoplamento e o risco de execução financeira automática.
- Agendador interno (`setInterval`): proibido nesta fase; o disparo externo permanece.
