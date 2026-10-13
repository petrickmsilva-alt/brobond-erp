# ERP-03 — relatório de execução do plano de gate PostgreSQL

O plano de 2026-10-12 foi confrontado com o checkout `a33811f` (merge do ERP-02.1). O gate histórico (`smoke:pg` no CI) já existia; este ciclo independente audita e endurece a aprovação oficial do CORE, sem reabrir ERP-02 nem Commerce.

**Estado inicial: BLOCKED.** `test:pg` retornava 0 com 150 pass e 1 TODO crítico: P1-11, segredo de webhook global por provedor em vez de escopo da empresa dona da cobrança. O comando oficial foi tornado bloqueante e provou a falha no CI. O TODO foi então removido **somente após** reproduzir a falha sem `todo` no PostgreSQL real, corrigir a autenticação na rota e ampliar o teste para 401/409, retry, idempotência e estado final do banco.

**Estado atual: gate técnico local PASS; aprovação processual BLOCKED até auditoria independente.** Uma revisão adversarial *interna* encontrou e corrigiu outro efeito de P1-11: o cron podia processar evento salvo sem assinatura após a empresa ativar segredo. Prova PostgreSQL: falha antes, sucesso depois; três bancos novos com 154 pass, 0 fail, 0 skip, 0 TODO; `smoke:pg` 126/126. A execução anterior do CI passou no head `b77df98` (run [38387952366](https://github.com/petrickmsilva-alt/brobond-erp/actions/runs/38387952366)); aguardar checks do novo head para confirmar a revisão adversarial. Auditoria interna e CI **não** substituem a auditoria independente exigida para declarar ERP-03 concluído. Não fazer merge automático nem prometer cobertura total.

**Evidências e matriz:** [RELATORIO-ERP-03.md](RELATORIO-ERP-03.md). **Inventário arquivo a arquivo:** [ERP-03-TEST-INVENTORY.md](ERP-03-TEST-INVENTORY.md).
