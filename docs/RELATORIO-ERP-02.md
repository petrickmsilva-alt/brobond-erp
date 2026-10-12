# RELATÓRIO — ERP-02: reabertura/estorno de OP em PostgreSQL

**Rodada:** 2026-10-12
**Repositório:** `petrickmsilva-alt/brobond-erp`
**Branch:** `arena/0c720c09-brobond-erp`
**Base:** `b907796f26cc800f06db4ce90046fed7ab390cd4` (merge do PR #54)
**Escopo:** exclusivamente o fluxo de ordens de produção no servidor, suas provas PostgreSQL e os fixtures de memória necessários para a trilha de eventos estrita. Sem alterações em frontend, menu/UX, Fiscal, Commerce/BI, integrações, gateways, schema ou migrations. ERP-03 e outros ciclos não foram iniciados.

> **Leitura do veredito:** a correção histórica do P0-01 já estava na base desta rodada. O P0-01 original **não foi reproduzido** nesta execução e não é apresentado como defeito corrigido por este patch. A investigação seguiu pelas invariantes sem cobertura do mesmo fluxo; os problemas G1–G5 descritos abaixo foram reproduzidos e tratados. Este relatório não certifica o ERP inteiro nem substitui auditoria independente.

## 1. STATUS DESTA RODADA

| Critério | Resultado | Evidência |
|---|---|---|
| Pré-voo e branch alvo | ✅ | `arena/0c720c09-brobond-erp`, base `b907796f…`; somente o repositório alvo |
| Reprodução do P0-01 original nesta base | **Não reproduzido** | os dois testes PostgreSQL focados preexistentes passaram 10/10 antes das alterações; o fluxo já usava `tryAdjustStock` e a tradução de `23514` |
| Falhas correlatas reproduzidas antes da correção | ✅ | G1–G4; G5 também falha com mutação temporária de leitura de uma página (§4) |
| Correção mínima, sem mudança de regra/cálculo | ✅ | `server/src/producao.ts`; detalhes em §5 |
| PostgreSQL real focado | ✅ | 16/16 testes passaram; inclui A, B1–B4, C–F e G1–G5 |
| Bateria PostgreSQL completa | ✅ | banco novo e descartável: 150 testes, 149 pass, 0 fail, 1 todo, 0 skipped |
| `npm test` (servidor + cliente) | ✅ | servidor 695 pass / 0 fail / 65 skipped; cliente 290/290 |
| Typecheck / build / lint | ✅ | typecheck completo e build passaram; lint 0 erros / 415 warnings |
| Smoke em memória / PostgreSQL | ✅ | 126/126 em cada modo |
| `audit:menu` | ✅ | 0 erros / 4 avisos classificados, sem alteração de menu/UI |
| `prisma validate` | ⚠️ bloqueado | tentativa feita; download do `schema-engine` falhou por conexão de rede. Nenhum schema foi alterado |
| Merge / ERP-03 / outro ciclo | Não realizado | permanecem fora do escopo e da decisão desta rodada |

## 2. PRÉ-VOO E REPRODUÇÃO DO P0-01

- O checkout estava na branch exigida e partia do commit `b907796f26cc800f06db4ce90046fed7ab390cd4`, que já incorpora o ciclo anterior do PR #54.
- O PostgreSQL usado para a prova focada é PostgreSQL **16.14 real**, em `127.0.0.1:55432`, base `brobond_teste`. A bateria `test:pg` completa foi executada em um banco novo, `brobond_e02_cb7dfb455067`, removido ao final.
- Antes de editar código, os dois arquivos focados de ERP-02 passaram **10/10** em PostgreSQL. Não houve resposta 500 nem reprodução do P0-01 nesta base.
- A inspeção do código confirmou que a base já fazia a saída de estoque com `tryAdjustStock` (predicado de saldo dentro do `UPDATE`) e já traduzia `23514` para erro de negócio. Portanto, não se atribui a este patch a correção histórica do P0, nem se inventa uma falha não observada.

## 3. INVARIANTES CORRELATAS INVESTIGADAS

| Caso | Reprodução anterior à correção | Causa observada | Resultado depois |
|---|---|---|---|
| **G1 — evento de conclusão** | falha injetada no `INSERT` do evento não abortava a conclusão | `registrarEventoOrdem` capturava e descartava qualquer exceção | resposta de conflito; OP, estoque, insumos, movimentos, eventos e auditoria permanecem no snapshot anterior |
| **G2 — evento de reabertura** | falha injetada no evento não abortava integralmente o estorno | mesmo `catch` silencioso da trilha | resposta de conflito; nenhum efeito de estorno ou apontamento é confirmado |
| **G3 — apontamentos/histórico** | estornar uma OP com 1001 apontamentos deixava 1 ativo; as listas HTTP também tinham limites de página | leitura interna limitada a uma página de 1000; endpoints limitados a 500 | todos os 1001 são processados; a trilha preserva o resumo; os endpoints retornam todos os apontamentos/eventos acima de 500 |
| **G4 — livro de insumos** | cenário com 5001 movimentos não considerava o livro completo no consumo/custo | leitura limitada a 5000 movimentos | leitura paginada inclui os 5001; custo e saldo conferidos diretamente no banco |
| **G5 — entradas de produto** | mutação temporária para uma página falha com `1000 !== 1001` ao estornar | leitura limitada a 1000 entradas de produto | todas as 1001 entradas são marcadas e compensadas; saldo final zero |

A falha de G5 foi demonstrada após a correção permanente já estar no arquivo: substituí temporariamente `listarTodos` por uma leitura só da primeira página, rodei apenas G5 contra PostgreSQL real, observei a asserção falhar (`1000 !== 1001`) e restaurei o arquivo corrigido. A execução normal de G5 passou. Nenhuma mutação de reprodução foi mantida. O teste G5 está imediatamente após o bloco B3 e antes de B4/seção C, no ponto solicitado.

## 4. MATRIZ FUNCIONAL E CONCILIAÇÃO NO BANCO

Os números a seguir são dados determinísticos dos fixtures de teste, não dados de produção.

- **A — dois ciclos completos e retry:** `concluir → reabrir → concluir → reabrir`; retry idêntico de `/concluir` não cria estoque, consumo, custo ou evento duplicado; reabertura repetida retorna 409 sem novo efeito. A segunda conclusão reconsome o insumo e calcula o custo pelo consumo líquido.
- **B1/B2 — estornos concorrentes:** dois pedidos simultâneos resultam em um 200 e um 409, tanto com saldo adicional quanto com saldo exato; saldo nunca fica negativo.
- **B3 — conclusões concorrentes:** duas conclusões simultâneas geram uma única entrada e uma única baixa de insumo.
- **B4 — reabertura/conclusão concorrentes:** os resultados observados deixam um estado serial válido (OP aberta com efeitos revertidos ou novo ciclo concluído); não há estado intermediário, custo fantasma ou saldo negativo.
- **C — atomicidade:** falha na segunda linha de uma OP por grade reverte integralmente a primeira linha e os demais efeitos.
- **D — multiempresa:** empresa B não lê nem opera a OP de A; estorno de A não toca nos saldos de B.
- **E — custo/perdas/histórico:** reabertura preserva custo, perdas e apontamentos revertidos na trilha append-only e nas movimentações históricas.
- **F — mecanismo SQL:** a prova direta em PostgreSQL confirma o comportamento da constraint `CHECK` e do padrão de atualização condicional já usado no estorno.
- **G1/G2 — falha de evento:** triggers PostgreSQL lançam `23514` no evento de conclusão/reabertura; as comparações antes/depois confirmam rollback também de movimentos, saldos e auditoria.
- **G3 — 1001 apontamentos e endpoints:** após reabrir, há zero apontamentos ativos; o evento `reaberta` contém os 1001 resumos. Antes do estorno, as rotas HTTP de apontamentos e eventos foram conferidas com mais de 500 linhas e retornaram todos os registros existentes. Saldos conferidos: produto 0 e insumo 5000.
- **G4 — 5001 movimentos de insumo:** o banco contém as 5000 linhas históricas mais a saída real; saldo do insumo fica 9998 após consumo de 2 e custo real calculado é 20 (2 × 10), sem truncar a última movimentação.
- **G5 — 1001 entradas de produto:** saldo antes do estorno 1010, respaldado por 1001 entradas ligadas à OP; depois do estorno, saldo 0, 1001 entradas marcadas como estornadas e 1001 saídas compensatórias totalizando 1010. O insumo volta a 1000, a OP retorna a `planejada` com custo aberto 0, e a trilha mantém `pecas=1010` e custo original revertido 200. Nenhum saldo negativo.

## 5. ALTERAÇÕES MÍNIMAS

1. **Trilha transacional:** `registrarEventoOrdem` deixou de engolir exceções. Ordem ausente para o escopo gera 404; validação da empresa e `INSERT` do evento continuam na mesma transação da operação. Assim, evento não gravado implica rollback da conclusão/reabertura.
2. **Leituras completas:** foi introduzido `listarTodos`, que percorre as páginas do filtro até atingir o total reportado e falha explicitamente se uma página vazia deixar a leitura incompleta. Foi aplicado às leituras internas de itens da OP, apontamentos, ficha técnica, movimentos de insumo/produto e às listagens de eventos/apontamentos. Os filtros por empresa permanecem nos chamadores.
3. **Validação por insumo:** a leitura do livro completo valida cada insumo uma vez por ID, sem alterar a fórmula de consumo/custo.
4. **Fixtures de memória:** os dois testes de OP em memória usam `usuario_id` nulo quando o ator não existe de fato no store. Não se enfraqueceu a validação nem se criou usuário fictício; os testes PostgreSQL continuam usando usuários persistidos.

**Preservado:** máquina de estados, transições legais, cálculo de custo, composição de perdas, idempotência existente, isolamento por empresa, isolamento transacional/concorrência e trilha append-only. Nenhuma migration/schema, frontend, Sidebar, UX ou módulo fora do fluxo de Produção foi alterado.

## 6. GATES EXECUTADOS

| Gate | Resultado observado |
|---|---|
| Dois arquivos PG focados (`e02-ordem-reabrir` + `e02-reabertura-estorno`) | **16/16 pass**, PostgreSQL real, `--test-concurrency=1` |
| `npm run test:pg` | **150 testes: 149 pass, 0 fail, 1 todo, 0 skipped**; banco novo descartável; ~17m38s |
| `npm test` | **Servidor:** 760 testes, 695 pass, 0 fail, 65 skipped. **Cliente:** 28 arquivos, 290 pass. Exit 0 |
| `npm run typecheck` | Passou para domain, server e client |
| `npm run build` | Passou |
| `npm run lint` | Exit 0; 0 erros / 415 warnings existentes |
| Smoke em memória | **126/126** |
| `npm run smoke:pg` | **126/126**, banco novo removido ao final |
| `npm run audit:menu` | 0 erros / 4 avisos classificados; nenhum arquivo de menu/UI alterado |
| `npm run db:validate` | **Não passou por bloqueio externo:** Prisma não conseguiu baixar `schema-engine.sha256` de `binaries.prisma.sh`; nenhuma mudança de schema nesta rodada |
| `git diff --check` | Passou |

`db:generate` e `db:deploy` não foram executados: não houve alteração de schema ou migration; deploy de banco não se aplica.

## 7. CORRIGIDO × AINDA ABERTO

### Corrigido nesta rodada

- Falhas ao persistir evento deixam de ser ocultadas e abortam a operação transacional.
- Leituras de históricos/listas internas não são truncadas silenciosamente nos limites de 1000/500/5000 registros abrangidos pelo fluxo; G3–G5 cobrem as fronteiras reais.
- Asserções PostgreSQL de retry, concorrência, rollback, multiempresa, custo, perda e reconciliação do banco permanecem verdes.

### Já corrigido na base; não reaberto por este patch

- O tratamento histórico de saída negativa no estorno que motivou P0-01 (23514 / saldo não negativo). O fluxo passou na prova atual, mas o defeito original não foi reproduzido nesta rodada; não se afirma que tenha sido corrigido novamente aqui.

### Ainda aberto / limitações desta evidência

- `prisma validate` permanece sem resultado por indisponibilidade de rede ao baixar o engine. É uma limitação de validação de schema, não uma alteração ou defeito de schema introduzido aqui.
- O resultado é restrito ao fluxo e aos cenários medidos; **não** é declaração de que todo o ERP esteja concluído, certificado ou livre de outros gaps.
- Merge não realizado. A revisão e a decisão de merge permanecem humanas; ERP-03 e outros ciclos continuam fora do escopo.
