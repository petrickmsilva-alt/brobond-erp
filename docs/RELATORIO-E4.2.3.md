# Relatório E4.2.3 — Correção da Expedição PostgreSQL + Conferência + Teste E2E

**Repositório:** `petrickmsilva-alt/brobond-erp`
**Branch do ciclo:** `arena/36e93522-brobond-erp` (branch fixada pela sessão Arena; a missão sugeria `arena/e423-expedicao-postgresql`, mas a Arena rastreia a sessão por esta branch — mesma situação registrada no E4.2.1).
**Base:** `main` @ `ade61dd239a6eed2da43a2e13bfc8444395e1e24`
**Data:** 2026-10-10
**Escopo:** exclusivamente AUD-01, AUD-02 e AUD-05 (E4.2.3). Nenhum escopo E4.3+ implementado. `brobond-ai-commerce` não foi acessado.

---

## 1. Objetivo

Tornar o fluxo de expedição funcional e comprovado em PostgreSQL real:

```text
pendente → separacao → conferida → embalada → expedida
```

fechando exclusivamente:

| Achado | Gap | Prioridade | Estado |
|---|---|---|---|
| AUD-01 | `GAP-EXPEDICAO-ETAPA-PG` | P0 | ✅ fechado com evidência |
| AUD-02 | `GAP-EXPEDICAO-CONFERENCIA-PG` | P1 | ✅ fechado com evidência |
| AUD-05 | `GAP-EXPEDICAO-SEM-TESTE-PG` | P1 | ✅ fechado com evidência |

## 2. Escopo e restrições respeitadas

- Somente o repositório `brobond-erp`. Nenhuma leitura/alteração em `brobond-ai-commerce`.
- Migration **nova** (`0032`); a migration histórica `0024` **não** foi editada.
- Sem mapeamento artificial permanente (`embalada→embalagem`, `expedida→expedicao`): uma única linguagem de domínio.
- Sem backfill heurístico. Preservação de dados > aparência de limpeza.
- Faturamento e expedição seguem processos distintos (decisão de produto da §3): venda de balcão/POS/retirada pode faturar sem a máquina logística; a operação que exige separação/conferência/embalagem/expedição usa a máquina. **AUD-03/AUD-04** (faturamento direto `PUT /api/vendas/:id {status:'faturada'}` e atalhos `/conferir|/checkout|/packing-check` fora da máquina) ficam **documentados como decisão de produto, não implementados** — E4.2.3 não virou reengenharia do faturamento.
- Nenhum teste removido/enfraquecido; nenhum skip novo; nenhum workflow/CI alterado; sem MemStore como prova de banco; sem vocabulário paralelo; sem segundo motor de expedição/estoque/financeiro.

## 3. Estado inicial (diagnóstico read-only + reprodução "antes")

Documentação obrigatória lida: `ERP-MASTER-MAP.md`, `ERP-GAPS.md`, `RELATORIO-E4.1.md`, `RELATORIO-E4.2.md`, `RELATORIO-E4.2.1.md`.

**`docs/RELATORIO-E4.2.2.md` não existe no repositório** (nem no `main`, nem em branch remota, nem no GitHub via API). A numeração AUD-01…AUD-15 citada na missão foi tratada pelos identificadores estáveis (`GAP-EXPEDICAO-ETAPA-PG`, `GAP-EXPEDICAO-CONFERENCIA-PG`, `GAP-EXPEDICAO-SEM-TESTE-PG`) e confirmada por auditoria direta de código/banco.

**Consultas da seção 15 do E4.2.2:**

```text
PRODUÇÃO NÃO DISPONÍVEL PARA AUDITORIA READ-ONLY
```

Não há credencial de produção/réplica neste ambiente (`render.yaml` declara `DATABASE_URL` com `sync: false`, configurada manualmente no painel; nenhum connection string de produção existe no repositório). Nada foi inventado; a validação funcional usou PostgreSQL efêmero real (fixtures próprias dos testes).

**Reprodução "antes" (PostgreSQL 18.4 real, HEAD `ade61dd` + apenas o script de repro):**

| Sintoma | Resultado observado |
|---|---|
| AUD-01 — `embalar` após separar/conferir | HTTP **500**; SQLSTATE **23514** `expedicao_eventos_etapa_valida`; `detail: Failing row contains (…, embalada, conferida, ok, …)`; rollback completo — venda fica `conferida`/`aberta`, sem evento `embalada` |
| AUD-01 — eventos gravados | vocabulário antigo: `separacao`, `conferencia` (mapeamento `conferida→conferencia` no código) |
| AUD-02 — conferência reprovada (1 de 2 códigos lidos) | HTTP **400** "Valor inválido em um dos campos." (SQLSTATE **22P02** traduzido por `translatePgError`); `divergencias_conferencia` **0 linhas** — nada persistido |
| AUD-05 | nenhum teste PostgreSQL exercitava o fluxo completo de expedição (`pg/e421-estoque-integridade.test.ts` descreve explicitamente que desviava para o PDV por causa do defeito) |

Causas confirmadas em código:

1. **AUD-01:** `expedicao_eventos_etapa_valida` (criado em `0024_p1_comercial_logistica.sql`, espelhado em `db/schema.sql`) aceitava apenas `separacao, conferencia, embalagem, expedicao`, enquanto `vendas.expedicao_etapa_valida` (a máquina real) exige `pendente, separacao, conferida, embalada, expedida`. `registrarEvento` gravava `alvo` (`embalada`, `expedida`) → 23514.
2. **AUD-02:** o driver `pg` converte ARRAY JavaScript em literal de array Postgres (`{"000"}`), que não é JSON válido. `conferirPedido` enviava `esperado/lido/faltando/sobrando` (arrays) direto para colunas JSONB → 22P02 → 400. Em memória não há JSONB, por isso a suíte em memória não pegava.

## 4. AUD-01 — máquina de eventos corrigida

- **`server/src/expedicao.ts`:** `registrarEvento` grava o vocabulário canônico de ESTADOS (`alvo` direto); removido o mapeamento `alvo === 'conferida' ? 'conferencia' : alvo`; o evento da conferência reprovada usa `etapa: 'conferida'` com `resultado: 'divergencia'` (o evento é sobre o passo `conferida`; o `resultado` registra que a transição NÃO ocorreu); parâmetro morto que carregava `'embalagem'` em `avancar()` removido — `embalagem`/`expedicao` não existem mais como valores escritos em parte alguma do backend de expedição.
- **Regra do evento:** `etapa` = etapa-alvo do passo; `de_etapa` = etapa anterior; `resultado` (`ok|divergencia|erro`) qualifica se a transição ocorreu. Trilha feliz: `separacao, conferida, embalada, expedida` na ordem — exatamente o esperado pela §15.

## 5. AUD-02 — conferência reprovada (JSONB + 422)

- **`server/src/pgstore.ts`:** serialização correta para JSONB no ponto único de persistência (`insert`, `update`, `insertMany`): campos `type: 'json'` com valor objeto/array são serializados com `JSON.stringify` — o **mesmo mecanismo já adotado pelo projeto** (`JSON.stringify` na auditoria e no payload fiscal). Strings já serializadas (padrão fiscal) passam como estão; `null` continua `NULL`. Leitura continua devolvendo o JSONB parseado pelo driver. Nenhum segundo mecanismo de persistência, nenhuma tabela paralela, nenhum mudança no domínio de divergências.
- **Operação (`conferirPedido`):** recebe a divergência → valida (`normalizarLeitura`, `compararLeitura`) → serializa corretamente → persiste `divergencias_conferencia` (`esperado`, `lido`, `faltando`, `sobrando` como JSONB válido) → cria o evento (`conferida`/`divergencia`, `dados.divergencia_id`) → auditoria → **na mesma transação** (divergência e trilha nascem juntas; não fica divergência órfã) → responde **HTTP 422** com o padrão de erro do ERP (`{ error, fields }`).
- **Status HTTP:** 422 (não 400) para divergência de negócio; 400 continua sendo para leitura vazia/malformada; 409 para conflito de fluxo.

## 6. AUD-05 — teste E2E PostgreSQL

`server/test/pg/e423-expedicao-postgresql.test.ts` — 9 testes contra PostgreSQL real (sem mock, sem skip; falha sem `DATABASE_URL`):

1. `upgrade: 0032 substitui o CHECK antigo, preserva linhas legadas sem backfill e valida quando pode`
2. `AUD-01: separar → conferir → embalar → expedir persiste embalada e expedida (antes: 23514 ao embalar)`
3. `AUD-01: o CHECK do banco recusa embalagem/expedicao/conferencia — uma única linguagem de domínio`
4. `AUD-02 caso A: conferência aprovada avança para conferida sem divergência e sem baixa`
5. `AUD-02 caso B: conferência reprovada responde 422 e persiste divergência JSONB válida (antes: 400/22P02 sem gravar)`
6. `E2E PG: empresa → cliente → produto → estoque → venda → itens → separar → conferir → embalar → expedir`
7. `rollback: expedição que falha no faturamento reverte tudo (venda, estoque, evento e financeiro)`
8. `multiempresa: empresa B não separa, confere, embala, expede, lê eventos nem resolve divergência de A (404)`
9. `concorrência: duas expedições simultâneas geram UMA baixa, UM evento final e saldo coerente`

Complemento em memória: +1 teste em `server/test/expedicao.test.ts` travando o vocabulário canônico dos eventos (aprovada e reprovada).

## 7. Migration

**`db/migrations/0032_e423_expedicao_vocabulario.sql`** (nova; `0024` intocada; idempotente, no padrão do projeto):

1. **Diagnóstico somente-leitura:** contagem total e por valor de `expedicao_eventos.etapa` via `RAISE NOTICE` (a contagem por banco desconhecido é feita no upgrade real; aqui não há acesso a produção).
2. **Substituição do CHECK:** `DROP CONSTRAINT IF EXISTS expedicao_eventos_etapa_valida` + `ADD CONSTRAINT … CHECK (etapa IN ('pendente','separacao','conferida','embalada','expedida'))`.
3. **Compatibilidade segura sem backfill:** se existir linha incompatível, o CHECK nasce **NOT VALID** — escritas NOVAS já são limitadas ao vocabulário canônico imediatamente, e as linhas históricas permanecem intactas. Sem linha incompatível, `VALIDATE CONSTRAINT` é executado no próprio upgrade. `COMMENT ON CONSTRAINT` documenta a política.
4. **`db/schema.sql` atualizado:** CHECK inline da tabela corrigido para o vocabulário canônico (banco novo) + bloco espelho `0032` com o mesmo conteúdo (bootstrap idempotente).

**Valores históricos (`conferencia`, `embalagem`, `expedicao`) — estratégia declarada:**

| Pergunta | Resposta |
|---|---|
| Quantidade? | **Desconhecida em produção** (`PRODUÇÃO NÃO DISPONÍVEL PARA AUDITORIA READ-ONLY`). No banco de teste da reprodução pré-correção: 3 linhas `conferencia` (gravadas pelo mapeamento antigo em conferências aprovadas); `embalagem`/`expedicao` só existiriam se uma versão anterior do código as tivesse gravado — o código auditado nunca conseguiu gravá-las (falhava antes com 23514). |
| Valores? | `conferencia` (etapa do passo de conferência), `embalagem`, `expedicao` (nomes antigos de passo). |
| Estratégia? | **Preservação total, sem conversão.** A equivalência segura não é determinável: o código antigo gravava nomes de PASSO que não identificam unicamente o ESTADO canônico de destino sem inventar associação (`resultado` não distingue apropriação retroativa). |
| Necessidade de migração futura? | Sim, **opcional e explícita**: uma migração de tratamento pode converter/apagar as linhas históricas com decisão humana e depois `VALIDATE CONSTRAINT`. Fora do escopo E4.2.3. |
| Impossibilidade segura de conversão? | Registrada acima: conversão automática é **backfill heurístico** e foi proibida pela missão (§22). |

## 8. Upgrade

- **Banco vazio:** `npm run test:pg` executado com o banco recriado com **0 tabelas** → bootstrap completo (`schema.sql` + 32 migrations) → **110/110 pass**. Observado no upgrade do banco de teste: a migração `0032` é registrada em `schema_migrations`.
- **Banco já existente (fixture pré-0032):** o teste 1 do arquivo E4.2.3 monta o estado anterior (CHECK de 0024 + 3 linhas legadas `conferencia`/`embalagem`/`expedicao` em uma venda real com estoque), executa **primeiro só o arquivo da migration** (prova independente do espelho) e depois o `migrate()` de produção; valida:
  - tabelas (`expedicao_eventos`, `divergencias_conferencia`) e índice `expedicao_eventos_idx` existem;
  - constraints: CHECK novo no vocabulário canônico; escrita nova `embalada` passa; escrita `embalagem` é recusada com **23514** (mesmo com o CHECK NOT VALID);
  - dados: linhas legadas **preservadas byte a byte** (contagem `conferencia` = 1 na venda da fixture; nada reescrito); venda e estoque intactos;
  - com as linhas incompatíveis removidas (limite explícito: a fixture apaga apenas as linhas que ela própria criou, nunca dado de terceiros), o `VALIDATE CONSTRAINT` do re-upgrade deixa `convalidated = true`.
- **Limite honesto:** o runner aplica `db/schema.sql` antes das migrations versionadas (mesmo limite registrado no E4.2). A prova de upgrade é o cenário real do runner existente sobre banco com dados.

## 9. Testes PostgreSQL

| Suíte | Comando | Resultado |
|---|---|---|
| Completa, banco vazio | `npm run test:pg` (PostgreSQL 18.4 real, `brobond_teste` recriado com 0 tabelas) | **110 pass · 0 fail · 0 skipped** (inclui os 9 novos; 101 é o total registrado na E4.2.1 — 101 + 9 = 110) |
| Reexecução da suíte nova sobre banco já populado | `node --test test/pg/e423-expedicao-postgresql.test.ts` (2ª execução) | **9/9** (idempotência do upgrade em reexecução) |
| Direcionada E4.2.3 | `node --test test/pg/e423-expedicao-postgresql.test.ts` | **9/9** |
| Expedição (memória) | `node --test test/expedicao.test.ts` | **21/21** (20 pré-existentes + 1 novo) |

Ambiente de banco: PostgreSQL **18.4** real (binários oficiais via `embedded-postgres`, instalado **fora do repositório** em `/home/user/pglab`, não versionado — mesma convenção da auditoria E1), `postgres://brobond@127.0.0.1:55432/brobond_teste`. CI segue usando o serviço `postgres:16` do workflow (não alterado). Nenhuma dependência nova no `package.json` do projeto.

## 10. Teste E2E (fluxo completo)

O teste E2E (teste 6) executa e valida **cada etapa**:

```text
criar empresa → criar cliente → criar produto → criar estoque (X = 5)
→ criar venda (aberta) → vincular itens (2 un)
→ separar → conferir → embalar → expedir   [faturamento pelo fluxo válido]
```

**Faturamento conforme fluxo válido (decisão registrada):** nesta máquina, a separação acontece **antes** do faturamento (`separarPedido` recusa pedido `faturada` com 409 explícito) e o faturamento acontece **dentro de `expedir`**, pelo mesmo caminho de sempre (`aplicarRegrasPedido` → `faturarVenda` → comissão → `syncLancamentoVenda`) — `expedir` não é um segundo motor de faturamento. Por isso a cadeia da §13 é executada como `separar → conferir → embalar → expedir`, com o faturamento validado no ato da expedição (`status = faturada`, `faturada_em`, lançamento financeiro).

Após cada passo: `vendas.expedicao_etapa` = `separacao` → `conferida` → `embalada` → `expedida`; `status` = `aberta` até `expedir` → `faturada`.

## 11. Estoque

Comportamento real comprovado (não assumido):

| Momento | Saldo (X = 5, qtd = 2) | Movimentações |
|---|---|---|
| Antes | 5 | 0 |
| Depois de separar / conferir / embalar | **5** (nenhuma baixa) | 0 |
| Depois de expedir | **3** (= X − qtd) | **1** (`tipo='saida'`, `quantidade=2`, `venda_id`=venda, `empresa_id`=empresa) |
| Repetir expedir/embalar/conferir | **3** (409 em todos) | **1** (nenhuma duplicada, nenhuma fantasma) |

- `venda_id` corretamente relacionado (FK composta `(empresa_id, venda_id)` da E4.2.1 exercitada); empresa correta carimbada; local canônico resolvido.
- A baixa acontece **uma única vez**, no faturamento da expedição que deu certo — inclusive no teste de rollback em que a primeira `expedir` falha e a segunda (com saldo) baixa exatamente uma vez.

## 12. Multiempresa

Empresa A e Empresa B reais (tenants criados pelo teste). B tenta: `separar`, `conferir`, `embalar`, `expedir`, `situacaoExpedicao` (eventos) e `resolverDivergencia` sobre registros de A → **404** em tudo (o padrão do ERP: 403 vaza existência; verificado via `assertRegistroDaEmpresa`). A permanece íntegra (etapa, eventos e divergência inalterados) e conclui o próprio fluxo. Nenhuma checagem apenas de frontend — a prova é nos handlers contra PostgreSQL real.

## 13. Rollback

Teste 7: pedido de 10 un com saldo 4 → `separar`/`conferir`/`embalaram` ok (a máquina logística não consulta saldo) → `expedir` falha em `faturarVenda` ("Não há saldo suficiente", 409). Verificado após a falha:

- venda não fica parcialmente alterada (`status = aberta`, `expedicao_etapa = embalada` — o `status → faturada` do início da transação foi revertido);
- estoque sem alteração parcial (saldo 4);
- nenhum evento parcial (`separacao, conferida, embalada` apenas — sem `expedida`);
- nenhuma movimentação fantasma; nenhum lançamento financeiro;
- divergência não fica órfã (caso B: divergência e evento nascem na mesma transação, com `dados.divergencia_id` ligando um ao outro);
- a transação PostgreSQL é realmente revertida — e o mesmo pedido fica expedível quando o saldo aparece (baixa única na expedição que deu certo).

## 14. Concorrência

Teste 9 (PostgreSQL real, `isolation: 'serializable'` do código + CAS `tryUpdateIf` já existente — nenhum mecanismo novo foi criado): duas `expedir` simultâneas sobre a mesma venda embalada → **exatamente uma** conclui; a perdedora é recusada com **409** (CAS ou tradução de `40001` — já existente). Resultado final: **1** baixa, **1** evento `expedida`, saldo `5 − 2 = 3` (nunca `5 − 4`), `status='faturada'` uma única vez.

## 15. Frontend

Auditoria da `ExpedicaoPage` (sem redesign, sem navegação nova):

- **Vocabulário:** a tela já usava exclusivamente `pendente|separacao|conferida|embalada|expedida` (tipo `Etapa`, esteira, filtros). Nenhum `embalagem`/`expedicao` introduzido. Nada a corrigir.
- **Compatibilidade com o backend corrigido (correção mínima):** a tela tratava `esperado/lido/faltando/sobrando` como números, mas o servidor persiste JSONB detalhado (listas de itens com `quantidade` / lista de códigos). Com a divergência finalmente persistindo em PostgreSQL, os totais renderizavam `NaN`. Corrigido com o helper `totalDivergencia` (aceita o JSONB real **e** o número pronto) nos totais do painel e no aviso do 422. Os 6 testes de tela existentes seguem verdes **sem alteração**.
- Observação registrada (fora do ciclo): o toast do 422 e o painel mostram **totais de unidades**; o detalhe item a item do JSONB persistido não tem visual dedicado — decisão futura de UX, não é gap do E4.2.3.

## 16. Gates (execução local, 2026-10-10)

| Gate | Resultado |
|---|---|
| `npm test` — server | **734 tests · 671 pass · 0 fail · 63 skipped** (os 63 skips são os mesmos do baseline E4.2.1: 733/670/63; **+1 teste novo**, nenhum skip novo, nenhum removido) |
| `npm test` — client | **226 tests · 226 pass** (22 arquivos) |
| `npm run test:pg` | **110 pass · 0 fail · 0 skipped** (PostgreSQL real, banco vazio) |
| `npm run typecheck` | EXIT 0 (domain + server + client) |
| `npm run lint` | **0 erros · 401 warnings** (idêntico ao baseline 401 — nenhum warning novo) |
| `npm run build` | EXIT 0 (bundle + PWA) |
| `npm run smoke` | **126/126 verificações** (servidor demo `:3001`, modo demonstração) |
| `npm run audit:menu` | EXIT 0 · 0 erros (avisos conhecidos: `RECURSO_SEM_MENU`, `ROTA_PUBLICA`) |
| `git diff --check` | EXIT 0 |
| Workflows/CI | **não alterados** (`.github/workflows/ci.yml` intocado) |

### 16.1 GATE FINAL — execução em etapa separada (2026-10-10)

Após a implementação, o gate final foi executado como etapa própria (ata completa em [PR #48, comentário](https://github.com/petrickmsilva-alt/brobond-erp/pull/48#issuecomment-6097721573)). **Nenhum código foi alterado nesta etapa.**

**CI do PR #48 (GitHub Actions, `postgres:16`):** `verificar` **PASS** (1m26s) e `testes-postgres` **PASS** (9m32s) — run [38052675901](https://github.com/petrickmsilva-alt/brobond-erp/actions/runs/38052675901). A suíte PG completa (incluindo os 9 testes E4.2.3) passou contra o serviço `postgres:16` do CI — compatibilidade da migration 0032 comprovada em **PG 16 (CI) e PG 18.4 (local)**.

**Bateria local de aceitação (reexecução integral):** `test:pg` **110/110** em banco recriado do zero · `npm test` 734/671/0/63 + 226/226 · typecheck exit 0 · lint 0 erros/401 warnings (= baseline) · build exit 0 · smoke **126/126** · audit:menu exit 0.

**Banco:**
- boot idempotente em banco vazio: **BOOT-1 600 ms** (schema + 32 migrations `0001…0032`), **BOOT-2 88 ms** sem erro; 97 tabelas; CHECK canônico **validado** (`convalidated = true`);
- upgrade com fixture pré-0032 (CHECK antigo + 4 linhas legadas `conferencia:1, embalagem:1, expedicao:2`): linhas **preservadas byte a byte**, escritas novas limitadas ao vocabulário canônico, CHECK `NOT VALID` enquanto houver incompatíveis e `VALIDATE` automático quando limpo (comportamento reconfirmado).

**Auditoria de proibições (§32):** migration `0024` com diff **vazio** · `.github/` com diff **vazio** · testes com **588 linhas só de adição** e **0 removida** · **0 skip/only novo** · produção sem vocabulário paralelo (os nomes antigos só aparecem no teste que prova que são **recusados** e na fixture que prova a **preservação**) · sem escopo E4.3+ · sem backfill heurístico · sem MemStore como prova de banco (teste PG falha sem `DATABASE_URL`) · `brobond-ai-commerce` não acessado.

## 17. Evidências

- **Antes:** reprodução em PostgreSQL real no HEAD base — `embalar` → 500/23514 (`expedicao_eventos_etapa_valida`, `Failing row contains (…, embalada, conferida, ok, …)`); conferência reprovada → 400 (22P02) com `divergencias_conferencia` vazia (§3).
- **Depois:** suíte `test/pg/e423-expedicao-postgresql.test.ts` 9/9 — cada teste nomeia a propriedade que prova (upgrade/sem-backfill, AUD-01, vocabulário, caso A, caso B/JSONB/422, E2E, rollback, multiempresa, concorrência).
- **Banco:** estado das constraints conferido via `pg_constraint` (`conname`, `convalidated`, `pg_get_constraintdef`); `jsonb_typeof` das colunas da divergência = `array` em todas.
- **Trilha:** `expedicao_eventos` conferida linha a linha (etapa/de_etapa/resultado) nos testes; `movimentacoes` com `venda_id`/`empresa_id`; `lancamentos_financeiros` por `referencia_tipo='venda'`/`referencia_id`.
- Logs locais: `/tmp/e423-antes.log` (reprodução), `/tmp/testpg-full.log` (gate PG completo). Nenhuma string de conexão ou credencial registrada.

## 18. Limitações

- **Produção não auditada:** `PRODUÇÃO NÃO DISPONÍVEL PARA AUDITORIA READ-ONLY`. A contagem real de linhas históricas `conferencia/embalagem/expedicao` será emitida pelo próprio upgrade (`RAISE NOTICE`) em cada banco.
- **`docs/RELATORIO-E4.2.2.md` inexistente** no repositório: a seção 15 (consultas) não pôde ser executada literalmente; registrado sem inventar resultado.
- **Upgrade:** prova sobre o runner real (`schema.sql` + migrations) em banco com dados; não substitui upgrade de cópia de produção.
- **Idempotência (§18) — auditoria:** `conferir`, `embalar` e `expedir` **não** têm idempotency key (o mecanismo existe em `devolucoes.idempotency_key`, E4.2.1). Não foi criado mecanismo novo (escopo): a integridade é garantida pela máquina de estados + CAS (`tryUpdateIf`) — repetição cai em 409 e não duplica efeito (provado no E2E e na concorrência). Expandir idempotência HTTP é trabalho futuro, fora do ciclo.
- **`npx prisma validate`:** segue não executável neste sandbox (GAP-E1-PRISMA-VALIDATE); schema Prisma não foi tocado.
- A visualização detalhada (por item) da divergência persistida continua sem tela dedicada (§15).

## 19. Gaps restantes (mapa atualizado)

- **Fechados nesta fase (com evidência):** `GAP-EXPEDICAO-ETAPA-PG` (AUD-01), `GAP-EXPEDICAO-CONFERENCIA-PG` (AUD-02), `GAP-EXPEDICAO-SEM-TESTE-PG` (AUD-05).
- **Registrados como decisão de produto, NÃO implementados (fora de escopo E4.2.3):** AUD-03/AUD-04 — faturamento direto (`PUT /api/vendas/:id {status:'faturada'}`) e atalhos `/api/vendas/:id/{conferir,checkout,packing-check}` que não passam pela máquina de expedição. Venda de balcão/POS/retirada pode faturar sem logística (permitido); uma operação que exige separação/conferência/embalagem/expedição não pode ignorar a máquina — a regra de faturamento que distingue os casos será desenhada em ciclo próprio, sem reengenharia neste.
- **Seguem abertos (mapa `ERP-GAPS.md`):** `GAP-ESTQ-MEMSTORE-TX`, `GAP-ESTQ-TRANSFERENCIAS`, `GAP-ESTQ-RESERVA`, `GAP-ESTQ-RASTREABILIDADE` (E4.3–E4.6), e os demais P1/P2/críticos de outros módulos. **Nenhum avanço a E4.3 foi iniciado.**

## 20. Conclusão e classificação

Todos os itens da classificação final (§28 da missão) foram verificados com evidência executada: AUD-01 corrigido (`embalada` e `expedida` persistem em PostgreSQL); AUD-02 corrigido (divergência JSONB persiste, HTTP 422 correto); AUD-05 com teste E2E PostgreSQL completo; fluxo completo funcional; estoque íntegro (baixa única, sem duplicação); `venda_id` correto; multiempresa comprovado (404); rollback comprovado; migration em banco vazio e upgrade comprovados; `npm test`, `test:pg`, `typecheck`, `lint`, `build`, `smoke` e `audit:menu` verdes; nenhum teste removido; nenhum skip novo; nenhum workflow alterado; nenhum escopo E4.3+ implementado.

```text
🟢 E4.2.3 CONCLUÍDO
```

**Veredito da implementação:**

```text
🟢 APROVADO PARA GATE FINAL
```

**Veredito do gate final (etapa separada, §16.1):** o CI do PR #48 passou nos dois jobs (`verificar` e `testes-postgres`, `postgres:16`), a bateria local de aceitação foi reexecutada integralmente verde, o boot idempotente e o upgrade com dados legados foram reconfirmados e a auditoria de proibições não encontrou nenhuma violação:

```text
🟢 E4.2.3 APROVADO NO GATE FINAL — formalmente fechado
```

O PR [#48](https://github.com/petrickmsilva-alt/brobond-erp/pull/48) está pronto para merge. **O merge não será executado automaticamente** — a decisão é humana. E4.3 não começa antes do fechamento formal (ocorrido) e do merge decidido pelo dono do produto.
