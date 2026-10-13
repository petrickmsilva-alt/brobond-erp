# ERP-03 — relatório de execução do plano de gate PostgreSQL

O plano de 2026-10-12 foi confrontado com o checkout `a33811f` (merge do ERP-02.1). O gate histórico (`smoke:pg` no CI) já existia; este ciclo independente audita e endurece a aprovação oficial do CORE, sem reabrir ERP-02 nem Commerce.

**Estado inicial: BLOCKED.** `test:pg` retornava 0 com 150 pass e 1 TODO crítico: P1-11, segredo de webhook global por provedor em vez de escopo da empresa dona da cobrança. O comando oficial foi tornado bloqueante e provou a falha no CI. O TODO foi então removido **somente após** reproduzir a falha sem `todo` no PostgreSQL real, corrigir a autenticação na rota e ampliar o teste para 401/409, retry, idempotência e estado final do banco.

**Estado atual: gate local PASS; CI final em verificação.** Três bancos novos: 153 pass, 0 fail, 0 skip, 0 TODO; `smoke:pg` 126/126. Ainda não autoriza merge automático nem promessa de cobertura total; relatório final deve registrar os checks do head do PR.

**Evidências e matriz:** [RELATORIO-ERP-03.md](RELATORIO-ERP-03.md). **Inventário arquivo a arquivo:** [ERP-03-TEST-INVENTORY.md](ERP-03-TEST-INVENTORY.md).
