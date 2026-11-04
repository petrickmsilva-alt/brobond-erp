# ADR-007 — Cliente de cron com timeout, retentativa e códigos de saída

* **Status:** aceita em 2026-11-04 (Ordem Final, pendência 2.1). **Implementada localmente.** Nenhum agendador configurado.
* **Escopo:** `scripts/cron-processo.mjs`, `server/src/scheduled.ts` (`executarProcessoCron`, `TIMEOUT_PADRAO_MS`).
* **Relacionados:** ADR-002 (processos independentes), `docs/operacao/cinco-jobs-cron.md`.

## 1. Contexto

O servidor executava os processos sem limite próprio. Um processo lento segurava a trava indefinidamente e não havia
política de repetição. A aplicação não deve decidir repetições de forma opaca; o agendador precisa de um cliente
pequeno e previsível.

## 2. Decisão

1. **No servidor**, cada processo tem timeout (`relatorios` 300 s, `pagamentos` 240 s, `publicacoes` 300 s,
   `pedidos` 240 s, `crm` 120 s). Ao estourar, a resposta é `503` com `motivo = timeout`, mas **a trava só é liberada
   quando o trabalho termina**. Assim um timeout nunca abre espaço para execução concorrente do mesmo processo.
2. **No cliente**, o timeout é o do servidor mais 60 s. São 3 tentativas. Espera de 60 s e depois 300 s, em caso
   de timeout, erro de rede ou `503` transitório (`motivo` `timeout` ou `erro`).
3. `401`, `404` e `503` sem `motivo` **não** são repetidos.
4. `409` (`ja_em_execucao`) é saída **0**, com registro `ignorado_concorrente`.
5. Sucesso é `200` com `ok:true`.

## 3. Alternativas descartadas

- **Retentar no servidor:** esconde falhas e pode repetir efeito financeiro dentro do próprio processo.
- **Trava global em banco:** é a solução correta para múltiplas instâncias, mas exige migração e não foi solicitada.
  Fica registrada como limite (cinco-jobs-cron §3).
- **Repetir também em `500`:** descartado; erro de programa não melhora com repetição idêntica.

## 4. Consequências

- Um processo que estoura o timeout do cliente pode continuar rodando no servidor até o fim. A trava impede
  execução concorrente, mas a idempotência de cada efeito continua sendo responsabilidade do processo.
- Testes: `cron-timeout-concorrencia` (5), `cron-cliente-retentativa` (7), `cron-cliente-integracao-local` (5). Locais, sem rede externa.
