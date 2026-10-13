# ERP-03 — relatório de execução do plano de gate PostgreSQL

O plano de 2026-10-12 foi confrontado com o checkout `a33811f` (merge do ERP-02.1). O gate histórico de ERP-03 (`smoke:pg` no CI) já existia; este ciclo independente audita e endurece a **aprovação oficial do CORE**, sem reabrir ERP-02 nem Commerce.

**Resultado: BLOCKED.** O runner PG tinha `150 pass / 0 fail / 1 TODO` e retornava 0. O TODO P1-11 é uma falha objetiva de isolamento financeiro multiempresa: a assinatura de webhook é validada globalmente por provedor, em vez de por empresa. O novo `npm run test:pg` retorna **1** se existir qualquer TODO/skip ou falha, portanto o PR não pode ser considerado aprovado nem ter CI verde antes da decisão/correção da P1-11. Não converter o TODO em skip, não removê-lo, não desligar a guarda.

**Relatório de implementação, evidências e matriz:** [RELATORIO-ERP-03.md](RELATORIO-ERP-03.md). **Inventário arquivo a arquivo:** [ERP-03-TEST-INVENTORY.md](ERP-03-TEST-INVENTORY.md).
