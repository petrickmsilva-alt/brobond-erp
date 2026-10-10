# Relatório E4.2.1 — Integridade, rastreabilidade e localização dos movimentos de estoque

**Repositório:** `petrickmsilva-alt/brobond-erp`
**Branch do ciclo:** `arena/7c5077d6-brobond-erp` (sessão atual). A missão citava `arena/4cb6e53b-brobond-erp`, que é a branch do E4.2 já mergeado (PR #46); o trabalho ficou na branch da sessão.
**Base:** `main` @ `c22191beb1ef6044f0df5a680414311ddadfc2af`
**Escopo:** somente os três gaps do ciclo. E4.3–E4.6 não foram implementados.

---

## 1. Veredito

Ver a seção 16 (Conclusão) e a resposta final ao usuário. Este relatório descreve a evidência; o veredito decide sobre os três gaps do ciclo e não sobre o release global.

## 2. Escopo e restrições respeitados

- Três gaps: `GAP-ESTQ-DEVOLUCAO-TOTAL`, `GAP-ESTQ-VENDA-ID`, `GAP-ESTQ-PDV-LOCAL-TEXTO`.
- Nenhum motor novo: a devolução usa `criarDevolucao`/`receberDevolucao`, o estorno usa `estornarVenda`, a idempotência usa a chave de `devolucoes` com índice único parcial, e o bloqueio de vínculo manual usa `validarReferenciasMovimentacaoManual`.
- Sem backfill heurístico de `venda_id` nem de `local_id`. Nenhum dado legado foi reescrito.
- Migrações antigas não foram editadas. Mudança estrutural somente em `0031_e421_integridade_estoque.sql` (nova), com espelho em `db/schema.sql`.
- `venda_id` não é `NOT NULL`.
- Não foram alterados `.github/workflows/*`, `main` nem o repositório `brobond-ai-commerce`.
- Nenhum `skip` novo e nenhum teste removido ou enfraquecido.

## 3. Mudanças de código

| Arquivo | Mudança |
|---|---|
| `db/migrations/0031_e421_integridade_estoque.sql` | Nova. Preflight de vínculo cruzado (bloqueia o DDL sem alterar linhas), colunas `movimentacoes.venda_id`, `vendas.local_saida_id`, `devolucoes.idempotency_key`, índices, FKs compostas `NOT VALID` → `VALIDATE`, diagnóstico de legado por `RAISE NOTICE`. |
| `db/schema.sql` | Bloco "0031 E4.2.1" com o mesmo conteúdo, para banco vazio. |
| `server/src/resources.ts` | Declara as três colunas novas (únicas persistidas por `pgstore`). |
| `server/src/expedicao.ts` | `travarVendaParaDevolucao` (`SELECT … FOR UPDATE` na venda), `comprometidoPorItem`, `criarDevolucao` com saldo `vendido − (recebido + pendente)` e idempotência; `receberDevolucao` trava a venda, recusa venda cancelada, só sobe estoque de item `bom` e acumula o total de devolução item a item. Removido o atalho `devolucao_estoque` vindo do cliente. |
| `server/src/itens.ts` | `faturarVenda` grava `venda_id` e prefere `local_saida_id`; `estornarVenda` reescrito (restaura `saídas − já recebido`, recusa excedente sem gravar nada); helpers `chaveItemVenda` e `quantidadeRecebidaPorItem`. |
| `server/src/pdv.ts` | `venderPdv` grava `local_saida_id` resolvido a partir do caixa. |
| `server/src/services.ts` | `venda_id` entra na lista de vínculos internos bloqueados; editar o texto `local_saida` zera `local_saida_id`. |

## 4. Gaps: estado antes e depois

| Gap | Antes (HEAD) | Depois (E4.2.1) | Prova |
|---|---|---|---|
| `GAP-ESTQ-DEVOLUCAO-TOTAL` | 5→2→3→2 devolvido → **7** | **5** | PG E2E-1 e memória devolução 3 |
| `GAP-ESTQ-VENDA-ID` | sem `venda_id`; estorno por texto | `venda_id` canônico, FK composta, índice, sem backfill | PG FK cruzada 23503; memória venda_id 1–7 |
| `GAP-ESTQ-PDV-LOCAL-TEXTO` | local só por texto | `local_saida_id` canônico em novas vendas de PDV; legado NULL | PG PDV/local; memória PDV/local 1–10 |
| `GAP-EXPEDICAO-ETAPA-PG` (novo, registrado) | não conhecido | **não corrigido**, registrado como CRÍTICO | PG falha ao embalar (CHECK) |
| `GAP-ESTQ-MEMSTORE-TX` (novo, registrado) | não conhecido | **não corrigido**, registrado como P2 | leitura de `memdb.ts` |

## 5. Reprodução do bug antes da correção

- **Em memória (HEAD original, via `git stash`):** a suíte `e421-estoque.test.ts` (31 testes na ocasião) deu **11 pass / 20 fail**, incluindo `devolução 3: 7 !== 5`.
- **Em PostgreSQL real (HEAD original, `brobond_antes`, arquivo PG de 10 testes):** **1 pass / 9 fail**. O único que passa é a guarda de multiempresa. `E4.2.1 PG E2E-1` falhou com `actual 7, expected 5`.
- Log: `/tmp/e421-pg-antes.log`; logs do código novo: `/tmp/e421-pg.log`.

## 6. Devolução (provar 5 → 2 → 3 → 2 → 5, não 7)

- Saldo inicial 5; venda de 2 (saldo 3); devolução total boa de 2 (saldo **5**); estorno posterior da venda já devolvida **não** restaura de novo (saldo continua 5).
- Devolução acima do vendido: 409, transacional, nenhuma devolução e nenhum movimento gravados.
- Danificado: 3 vendidos, 1 bom e 1 danificado devolvidos, 3ª peça volta boa → saldo 4 (5 − 1 danificada). A peça danificada não entra no saldo vendável e o cliente não consegue forçar a entrada.
- Matriz 10/6/4/+2=6/+2=8/não pode mais 2/8: após 4 devolvidas, restam 2 vendidas e devolver 2 é permitido (vai a 10). A prova de recusa correta é tentar devolver **3** com 2 restantes → 409 sem movimento. Essa é a versão implementada em E2E-2, memória e PG. O enunciado original ("não pode mais 2") não bate com a aritmética e foi registrado.

## 7. Vínculo venda_id

- Faturamento grava `venda_id` na baixa; devolução grava na entrada; estorno grava na entrada de restauração.
- Lançamento manual com `venda_id` é recusado (400), e a linha manual não recebe `venda_id`.
- Estorno usa `venda_id`, não o texto do motivo.
- Saída legada (`venda_id NULL`) é estornada pelo texto exato `Venda #id` **somente** da mesma empresa, sem reescrever a linha.
- FK composta `(empresa_id, venda_id)` recusa `venda_id` de outra empresa com `23503` no próprio banco.

## 8. Ambiguidades de dados legados (sem backfill)

- Simulação de upgrade com dados (`brobond_antes`, migrado da base HEAD): **17 movimentações**, das quais **9 saídas de venda sem `venda_id`**. Essas 9 não foram associadas a venda. O estorno delas usa o texto exato, por compatibilidade.
- **9 vendas com `local_saida_id IS NULL`**: continuam usando o texto `local_saida`.
- Em produção a contagem é desconhecida; a migration imprime a contagem via `RAISE NOTICE` no momento do upgrade.

## 9. PDV e local

- `venderPdv` grava `local_saida_id` a partir do caixa (memória e PG).
- Local de outra empresa é recusado com 404, sem vazar o registro (PG).
- Renomear o local não desvia a baixa de venda pendente, porque o faturamento usa o ID.
- Caixa legado sem `local_id` resolve o local na nova venda, sem backfill do caixa.

## 10. Idempotência

- Mecanismo: `devolucoes.idempotency_key` com índice único parcial `(empresa_id, idempotency_key)`, consultado dentro da transação depois do lock da venda.
- Repetição com a mesma chave → HTTP 200 com `idempotente: true` e a mesma devolução, sem nova linha.
- Mesma chave em outra venda → 409.
- Corrida (duas requisições simultâneas com a mesma chave, PG real): uma cria (201), a outra reaproveita (200); há uma única devolução.

## 11. Concorrência em PostgreSQL real

- Caso: venda de 4 com 2 já devolvidas. Duas devoluções de 2 simultâneas, com 2 restantes → **exatamente uma** criada; a outra recebe 409 `Não é possível devolver`.
- Dois recebimentos simultâneos da mesma devolução → só um sobe o estoque. Estoque final 10 (nunca 12); uma única entrada de estoque; venda cancelada uma vez.
- Mecanismo: `SELECT … FOR UPDATE` na venda antes de qualquer leitura de saldo; a transação passou a `read committed` (cada instrução lê o que já foi confirmado após o lock). Não depende de retry por `40001`.

## 12. Multiempresa

- Empresa B não cria devolução de venda da A (404 sem vazar dados), não recebe devolução da A (404), não baixa saldo da A e não ganha saldo. O saldo da A permanece 3 e a devolução da A segue `em_transito`.
- IDs reais do PostgreSQL (tenants criados pelo próprio teste), não fixtures em memória.
- Os testes de tenant já existentes também passaram no `test:pg`: `e42-http.test.ts` (HTTP real contra o servidor) e `e42-tenant.test.ts` (PostgreSQL com handlers e ator injetado). A suíte E4.2.1 de multiempresa usa handlers em PostgreSQL real, então não substitui a matriz HTTP.

## 13. Banco (migração e bootstrap)

- **Banco vazio** (`brobond_vazio`): `migrate()` aplicou tudo, incluindo `0031`; segunda execução sem erro (BOOT-1 774 ms, BOOT-2 77 ms); registro `0031_e421_integridade_estoque.sql` presente.
- **Banco migrado com dados** (`brobond_antes`): `0031` aplicada; segunda execução sem erro; dados preservados.
- **Bug encontrado e corrigido durante a validação:** o preflight lia `movimentacoes.venda_id` antes do `ALTER TABLE`, e o bootstrap de um banco já existente falhava com `column "venda_id" does not exist`. O diagnóstico foi movido para depois do `ALTER`, nas duas cópias (migration e `schema.sql`).
- O preflight de vínculo cruzado (`devolucoes` com venda ou item de outra empresa) bloqueia o DDL sem corrigir nada automaticamente.

## 14. Testes (números reais)

| Suíte | Comando | Resultado |
|---|---|---|
| Direcionada, memória (novo) | `node --import tsx --test test/e421-estoque.test.ts` | **32 pass / 0 fail** |
| Direcionada, PostgreSQL (novo) | `node --import tsx --test test/pg/e421-estoque-integridade.test.ts` | **10 pass / 0 fail** |
| Expedição (memória) | `test/expedicao.test.ts` | 20/20 |
| Completa, memória | `npm --prefix server test` | **733 tests, 670 pass, 0 fail, 63 skip** (os 63 skips são anteriores; nenhum é novo) |
| Completa, PostgreSQL real | `npm run test:pg` em banco limpo `brobond_full` | **101 pass, 0 fail, 0 skip** (inclui os 10 novos) |

Os 63 skips de `npm test` são anteriores a esta entrega e não estão nos arquivos novos.

## 15. Gates, CI e demais verificações

| Gate | Resultado |
|---|---|
| `npm run typecheck` | EXIT 0 |
| `npm run lint` | 0 erros; **401 warnings**, igual ao HEAD original (401). Nenhum warning novo |
| `npm run build` | EXIT 0 |
| `npm run smoke` (`scripts/smoke-e2e.mjs`, servidor demo na porta 3001) | **126/126** |
| `npm run audit:menu` | EXIT 0; avisos `RECURSO_SEM_MENU` já registrados como GAP-FISC |
| `git diff --check` (com os arquivos novos staged) | EXIT 0, sem problemas de espaço |
| CI do GitHub no PR #47, run [38014271118](https://github.com/petrickmsilva-alt/brobond-erp/actions/runs/38014271118) (`ci.yml`, `postgres:16`) | `verificar` **pass** (1m23s); `testes-postgres` **pass** (8m57s) |

Observação: o log TAP do job `testes-postgres` não é acessível pela API do Actions neste ambiente; os números da seção 14 são da execução local em banco limpo, e o CI registra apenas o status de sucesso.

## 16. Conclusão

- Os três gaps do ciclo estão fechados com prova executada em PostgreSQL real e em memória, e o bug de devolução foi reproduzido antes da correção.
- Dois defeitos encontrados no caminho foram **registrados e não implementados**, conforme a missão: `GAP-EXPEDICAO-ETAPA-PG` (CRÍTICO) e `GAP-ESTQ-MEMSTORE-TX` (P2).
- Continuam abertos, fora de escopo: `GAP-ESTQ-TRANSFERENCIAS`, `GAP-ESTQ-RESERVA`, `GAP-ESTQ-RASTREABILIDADE` (E4.3–E4.6) e `GAP-ESTQ-MULTIEMPRESA`, que já tinha gate aprovado no E4.2.
- Limite de dados: saídas e vendas legadas não têm `venda_id` nem `local_saida_id`; permanecem assim por decisão (sem backfill heurístico).
