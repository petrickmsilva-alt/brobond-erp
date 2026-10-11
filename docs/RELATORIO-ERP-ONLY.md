# BROBOND ERP — AUDITORIA ERP ONLY

**Repositório:** `petrickmsilva-alt/brobond-erp` (o repositório `brobond-ai-commerce` **não** foi lido, clonado nem referenciado)
**Branch auditada:** `main` em `0c9fc202c04c288b2ea6f197a2240a98a87efc0c`
**Data:** 2026-10-11 · **Modo:** AUDITORIA (nenhum código foi alterado na auditoria)
**Autor:** Auditoria técnica sênior assistida por agente

> **Auditoria independente dos ciclos ERP-01…ERP-04 (2026-10-11) — ✅ GATE APROVADO COM RESSALVAS (P2).**
> Executada sobre o commit `bb17f19`, com **6 provas por mutação** em PostgreSQL real (o arquivo do
> fix revertido ⇒ o teste do ciclo falha), bateria completa em **banco novo** (`# tests 124 ·
> pass 123 · fail 0 · todo 1`) e CI verde incluindo o gate de smoke. Documento completo:
> [`docs/AUDITORIA-INDEPENDENTE-ERP-01-04.md`](AUDITORIA-INDEPENDENTE-ERP-01-04.md).
> **Nada foi corrigido pela auditoria** (o papel dela é documentar): as ressalvas viraram gaps —
> **P2-08** (projeção com zero usuários ativos: `23503` em `sale_items_sale_id_fkey` e `400`
> enganoso na via sob demanda — **fechado no ciclo seguinte**, §5 "Ciclo P1-13 + P2-08") e
> **P2-09** (`test:pg` não repetível em banco reaproveitado — **aberto**: é regra de processo da
> bateria, não defeito de produto) — e a linha **P1-14** foi reescrita
> porque o fallback de responsável é **global**, não por empresa (sem vazamento entre empresas:
> verificado por canal e por `empresa_id`).

> **Atualização ERP-08 (2026-10-11) — P1-09 FECHADO: a devolução tem prova ponta a ponta em PostgreSQL.**
> A cadeia de reversa existia inteira e nunca havia sido executada contra o banco real — `server/test/pg/` não tinha
> arquivo de devolução e o §13 só podia dizer "não conseguimos provar". Agora tem: `pg/devolucao-e2e.test.ts` (banco
> novo, servidor real) percorre **faturar → devolução parcial (2 de 3, recebidas em bom, estoque 2 → 4, venda segue
> faturada e conta a receber intacta) → segunda devolução de 1 unidade recebida AVARIADA (nenhuma entrada de estoque,
> `devolucao_estoque = false`) → total ⇒ venda cancelada e financeiro revertido** — e prova o ponto sensível: o saldo
> final é **4**, ou seja, **a peça avariada não volta ao estoque nem pelo estorno da venda**. Também entram as recusas
> (receber antes de autorizar, sem rastreamento, duas vezes, devolver mais do que foi vendido, receber recusada), a
> **idempotência** por chave (1 linha no banco) e o **404 multiempresa**. **Nenhuma linha de produto mudou**: o ciclo é
> prova — e a **mutação** (guarda do estado removida) mostra o teste falhando (`esperado 0, veio 1`), garantindo que a
> regra está de fato coberta. Duas limitações **declaradas**: o retorno usa `adjustStock` com delta **positivo** (não
> toca a classe do P0-01) e `devolucoes.documento_fiscal_id` **nunca é escrito** — não há nota/evento fiscal de
> devolução (é território do ERP-12). Estado do ciclo: [`docs/ERP-CORE-ROADMAP.md`](ERP-CORE-ROADMAP.md) §5.

> **Atualização ERP-07 (2026-10-11) — P1-04 FECHADO e um P0 novo descoberto/fechado: criar usuário nunca funcionou em PostgreSQL.**
> A tela **`/empresas`** (grupo Configurações, `minPerfil: 'admin'`) entrega o CRUD de Empresas com lista, criação,
> edição, ativar/desativar, exclusão com a recusa do servidor **como veio** e o **modal de acessos**
> (`POST`/`DELETE /api/usuarios/:id/empresas`). A alçada passou a ser **do backend**: `empresas` ganhou
> `adminOnly: true` e o **gerente recebe 403 nos quatro verbos por HTTP** — provado com servidor real em
> `server/test/pg/empresas-admin-e2e.test.ts` (banco novo), garantindo também que o **seletor de empresa ativa
> continua 200** para ele. Guardas de exclusão provadas em PostgreSQL (`pg-empresas-admin.test.ts`): empresa
> padrão ⇒ 409, empresa com acesso ⇒ 409, empresa com dado de domínio ⇒ **23503 → 409**, empresa vazia ⇒
> excluída. **No caminho, o ciclo desenterrou o P0-06:** `POST /api/usuarios` — o **único** caminho de cadastro de
> usuário — respondia **sempre 409 "Outra operação alterou estes dados ao mesmo tempo."** e **nenhum usuário era
> criado** em PostgreSQL, porque `gerarConvite()` chamava `store.audit({...})` **sem `tx`** e abria uma segunda
> conexão dentro da transação `SERIALIZABLE` do cadastro (`40001`); a linha de auditoria do convite ainda
> **sobrevivia ao rollback**. Prova antes/depois (`3× FALHOU 409` · `usuarios criados: 0` ⇒ `ok 8` · `ok 9` ·
> `usuarios criados: 2`) e **mutação** (fix revertido ⇒ o teste volta a falhar), em `server/test/pg-usuario-convite.test.ts`.
> Regressão: `server` **759** (694 pass · 0 fail · 65 skip) · `client` **262/262** · `empresas-admin.test.ts` **9/9** ·
> `EmpresasPage.test.tsx` **8/8** · `audit:menu` **Sem erros** (70 módulos / 13 grupos) · typecheck **0** · lint **0 erros**
> (415 warnings) · build **OK** · **bateria `test:pg` em banco novo: 131 testes · 130 pass · 0 fail · 1 todo (P1-11)** ·
> **`smoke:pg` 126/126**. Duas mutações provam as duas metades do ciclo: sem o `tx` o teste do convite volta a falhar;
> sem `adminOnly` o gerente recebe **200** onde o e2e exige **403**. Sem migration, sem tabela nova, sem tocar o Commerce. Estado do ciclo:
> [`docs/ERP-CORE-ROADMAP.md`](ERP-CORE-ROADMAP.md) §5.

> **Atualização ERP-06 (2026-10-11) — P1-05 FECHADO: Comissões têm tela, e o número confere.**
> A tela `/comissoes` (grupo Financeiro, `minPerfil: gerente`) mostra **apurada · efetivada · estornada ·
> saldo** por representante, com drill-down das vendas do período e o **livro de eventos** de cada venda
> (`realizada`/`estornada`, base recebida, origem). O botão **"Conferir com o relatório"** compara a soma
> da tela com o relatório `comissoes` do MESMO período e exibe o resultado. **O estado "comissão paga" não
> existe no servidor e a tela não o inventou** — a efetivação é pelo recebimento (parcial: parte
> proporcional; cancelamento: estorno). Evidência: `server/test/pg/comissoes-e2e.test.ts` em **banco novo**
> (igualdade com o relatório; efetivada 0 antes do recebimento; 40/60 na baixa parcial; 100 na quitação;
> estorno 100 com histórico preservado no cancelamento), `ComissoesPage.test.tsx` **8/8**, `client`
> **254/254**, `server` **748** (685 pass · 0 fail · 63 skip), `audit:menu` **0 erros** (69 módulos /
> 13 grupos). Estado do ciclo: [`docs/ERP-CORE-ROADMAP.md`](ERP-CORE-ROADMAP.md) §5.

> **Atualização ERP-05 (2026-10-11) — P1-02 e P1-03 FECHADOS: o Fiscal passa a ser operável (e uma rota
> que nunca funcionou voltou a funcionar).** Duas telas novas — **NCM / Tributação** (`/ncm`, CRUD de
> `impostos_ncm`) e **Inutilizações** (`/inutilizacoes`, solicitar faixa de numeração + histórico) — dentro
> de um **grupo Fiscal** novo no menu (os quatro itens fiscais saíram de Vendas). O achado do ciclo é de outra
> natureza: **`POST /api/fiscal/inutilizar` respondia 405 para todo perfil** (`checkAccess(..., 'create')` sobre
> um recurso com `ops.create = false`, `server/src/fiscal.ts:843`) — a tabela `inutilizacoes_fiscais` era
> **inalcançável por HTTP** e nenhum teste cobria a rota. Corrigido com a alçada de **fluxo** (`checkFluxo`:
> mantém gerente/admin, não consulta `ops`, **não** abre o CRUD genérico). Evidência: `fiscal.test.ts`
> **24/24** (5 testes novos), `pg/fiscal-inutilizacao-e2e.test.ts` em **banco novo** (persistência com
> empresa/faixa/justificativa/autor + histórico pela API + CHECK recusando justificativa curta + 403 do
> operador), telas **10/10** e **8/8**, e **mutação** (o `checkAccess` de volta ⇒ `405 !== 200/202`).
> Bateria completa em **banco novo**: `test:pg` **127 testes · 126 pass · 0 fail · 1 todo** (P1-11) e
> `smoke:pg` **126/126**; regressão `server` **748** (685 pass · 0 fail · 63 skip), `client` **246/246**,
> typecheck **0**, lint **0 erros** (401 warnings), build **OK**. `audit:menu`: **0 `RECURSO_SEM_MENU`**.
> Estado do ciclo:
> [`docs/ERP-CORE-ROADMAP.md`](ERP-CORE-ROADMAP.md) §5.

> **Atualização ERP-04 (2026-10-11) — P0-03 e P1-07 FECHADOS: o BI passa a ler a operação do ERP.**
> Decisão de arquitetura registrada **antes do código** em
> [`docs/ADR-001-FONTE-UNICA-FATURAMENTO.md`](ADR-001-FONTE-UNICA-FATURAMENTO.md):
> opção **(B) projeção derivada** — `vendas` é a fonte autoritativa do ERP e
> `sales` passa a ser o **modelo de leitura** alimentado por uma projeção
> idempotente no namespace `erp:` (a recomendação preliminar (A) foi substituída
> com quatro evidências; ADR §2). Sem migration e **sem tocar a ingestão de canais
> externos** (critério de não-regressão provado campo a campo).
> O critério de igualdade (BI × relatório, tolerância zero) **reprovou** por um
> defeito real: `relatorios.ts` comparava `String(Date).slice(0,10)`
> (`"Wed Oct 11"`) contra a data pedida em 8 pontos — em PostgreSQL o filtro
> `?de=&ate=` **descartava vendas reais**. Corrigido com `diaISO()`;
> `comissoes.ts:261` tinha o mesmo defeito e foi corrigido no ciclo seguinte
> (**P1-13**, fechado em 2026-10-11: normalização única em `utils.diaISO`, usada por 17 módulos).
> Provas: `server/test/pg/bi-faturamento-e2e.test.ts` (banco novo: BI 20000 ×
> relatório 20000; ABC classe A; canal externo intacto) e
> `server/test/negocios-projecao-erp.test.ts` (paridade em memória 3/3).

> **Atualização ERP-03 (2026-10-11) — P0-04 FECHADO e P0-05 descoberto/fechado.**
> O gate passou a medir o sistema que roda em produção: `npm run smoke:pg` cria um
> **banco novo**, sobe a API real nele (migrate + admin automáticos, **zero SQL
> manual**) e roda o smoke E2E — **126/126**, contra 119/126 da auditoria (92/117
> em banco sem `local`); a etapa entrou no job `testes-postgres` do CI. A causa
> das 25 falhas de onboarding foi fechada na raiz: empresa **sem nenhum local**
> recebe o Local padrão "Loja" na primeira operação de estoque (com trilha de
> auditoria), e empresa com locais inativos continua recebendo o 409 explicativo.
> O contrato tipo × coluna dos **88 recursos** virou teste executável (4 regras +
> prova de mutação) e reprovou 7 declarações que mentiam sobre o banco — todas
> alinhadas. O teste A/B multiempresa (R6, antes **NÃO TESTADO**) revelou o
> **P0-05**: o `db/schema.sql` recriava a cada boot um índice **global** de
> `codigo_barras`; com o mesmo EAN em duas empresas (estado legítimo desde a 0018)
> **a API não subia** (`could not create unique index`) — removido, com prova
> antes/depois. Achados novos ainda abertos: **P1-12**, **P2-07**, **P3-08**.
> Detalhe: [`docs/ERP-CORE-ROADMAP.md`](ERP-CORE-ROADMAP.md) §5.

> **Atualização ERP-02 (2026-10-11) — P0-01 FECHADO.** O estorno/reabertura de OP
> volta a funcionar em PostgreSQL: `estornarOrdem` usava `adjustStock` (padrão
> `INSERT ... ON CONFLICT`) com delta negativo, e o CHECK
> `estoques_quantidade_nao_negativo` reprovava o tuple proposto antes do conflito
> → SQLSTATE 23514 → **500**. Agora usa `tryAdjustStock` (UPDATE condicional com
> row lock) com **409 explicativo** quando o saldo não cobre, e `translatePgError`
> traduz **23514 → 409** sem vazar constraint. Prova antes/depois no mesmo
> teste (`{"error":"Erro interno do servidor"}` → `200`) e **smoke contra
> PostgreSQL real: 119/126 → 126/126**. O P1-02 era cascata e fechou junto;
> novo risco residual preventivo registrado como **P3-07**. Detalhe:
> [`docs/ERP-CORE-ROADMAP.md`](ERP-CORE-ROADMAP.md) §5.

> **Atualização ERP-01 (2026-10-11) — primeiro ciclo do roadmap executado.**
> **P0-02 está FECHADO com evidência executada em PostgreSQL real** (mesma linha,
> antes/depois: `ignorado`/cobrança `pendente` → `paga`/título `confirmado`), com
> teste novo que **falha antes e passa depois**
> (`server/test/pg/e01-gateway-webhook-postgresql.test.ts`), `test:pg` **112 pass,
> 0 fail, 1 todo** e smoke **126/126**. A implementação **descobriu um segundo
> defeito no mesmo endpoint — P1-11 — registrado neste relatório (§6) e
> deliberadamente NÃO corrigido no ciclo**: ele exige decisão de escopo
> multiempresa. Detalhe do ciclo: [`docs/ERP-CORE-ROADMAP.md`](ERP-CORE-ROADMAP.md) §5.

> **Regra de evidência aplicada neste relatório.** Nenhuma afirmação é feita sem
> comando executado ou arquivo citado. Onde não houve execução, está escrito
> **NÃO TESTADO**; onde a conclusão é dedução a partir de evidência, está escrito
> **INFERÊNCIA**. Comentário não foi tratado como implementação, adapter não foi
> tratado como homologação, rota não foi tratada como fluxo completo, tela não foi
> tratada como regra de negócio, teste unitário não foi tratado como prova de
> PostgreSQL, menu não foi tratado como autorização e documentação não foi tratada
> como funcionalidade.

---

## 1. Estado atual

### 1.1 Git — medido, não presumido

| Verificação | Comando | Resultado |
|---|---|---|
| Branch | `git branch -a` | `* arena/fe358944-brobond-erp`, `main`, `remotes/origin/main` |
| HEAD | `git rev-parse HEAD` | `0c9fc202c04c288b2ea6f197a2240a98a87efc0c` |
| Working tree | `git status` | `nothing to commit, working tree clean` |
| Divergência com `origin/main` | — | HEAD **é** o topo de `main` (nenhum commit à frente ou atrás) |
| Último merge | `git log --merges -1` | `0c9fc20 Merge pull request #48 from petrickmsilva-alt/arena/36e93522-brobond-erp` |
| Histórico | `git log --oneline \| wc -l` | 172 commits (clone inicial era shallow de 1 commit — `git fetch --unshallow` executado para a auditoria) |
| Último commit de código | `git log --oneline -3` | `e0dda87 docs(e4.2.3)`, `f2f6e61 docs(e4.2.3)`, `4695e5b test(expedicao)` |
| Arquivos versionados | `find . -type f` (sem `node_modules`/`.git`) | 391 |

**Fato relevante:** o HEAD é um merge de PR **de documentação** (`docs(e4.2.3)`) imediatamente após um PR de correção/teste de expedição. O último merge de funcionalidade foi o E3.2 (`60238bb feat(erp): E3.2 recebimento de compra completo`).

### 1.2 Versão e dimensão

| Medida | Valor | Comando |
|---|---:|---|
| Versão declarada (raiz / server / client) | `1.0.0` / `0.6.0` / `0.6.0` | `package.json` |
| LOC `server/src` | 38.174 | `find server/src -name '*.ts' \| xargs cat \| wc -l` |
| LOC `client/src` | 34.260 | idem |
| LOC `modules/connectors` (Commerce) | 6.600 | idem |
| LOC `db/schema.sql` | 4.057 | `wc -l` |
| Rotas HTTP registradas em `index.ts` | 286 | `grep -cE "app\.(get\|post\|put\|patch\|delete)\("` |
| Recursos de API (`RESOURCES` + `R_*` do gateway) | 83 | introspecção em runtime |
| Módulos no menu do front | 66 | introspecção de `MODULES` |
| Arquivos de teste no servidor | 60 | `find server/test -type f` |

### 1.3 Migrations e schema — medido em PostgreSQL 18.4 real

Bootstrap executado em banco **vazio** (`brobond_smoke`), com o servidor real subindo e aplicando o schema:

| Medida | Valor medido | Comando |
|---|---:|---|
| Migrations aplicadas | **32** (`0001`…`0032`) | log de boot + `SELECT count(*) FROM schema_migrations` |
| Tabelas base | **97** | `information_schema.tables` |
| Colunas `empresa_id` | **72** | `information_schema.columns` |
| Índices | **382** | `pg_indexes` |
| Foreign keys | **289** | `information_schema.table_constraints` |
| UNIQUE | **19** | idem |
| CHECK | **651** | idem |
| Triggers próprios (`trg_empresa_*`) | **26** | `pg_trigger` |
| Views | **0** | `information_schema.views` |

> Os números da documentação anterior (`docs/ERP-MASTER-MAP.md`: 91 tabelas / 66 `empresa_id` / 316 índices) estão **desatualizados** em relação ao HEAD — o valor medido agora é 97 / 72 / 382.

### 1.4 Testes e build — executados neste ambiente

Ambiente provisionado para a auditoria: **PostgreSQL 18.4 real** (`embedded-postgres`, `127.0.0.1:55432`, bases `brobond_teste` e `brobond_smoke`), instalado porque o sandbox não tinha servidor de banco (sem `psql`, sem `apt`).

| Verificação | Comando | Resultado |
|---|---|---|
| Tipos (domain + server + client) | `npm run typecheck` | ✅ **verde, 0 erros** |
| Testes do servidor (memória) | `npm --workspace server test` | ✅ **734 testes · 671 pass · 0 fail · 63 skipped** (51 suítes; os 63 pulam sem `DATABASE_URL`) |
| Testes do front | `npm --workspace client test` | ✅ **22 arquivos · 226 testes · 226 pass** |
| Testes PostgreSQL reais | `npm run test:pg` (DB `brobond_teste`) | ✅ **110 testes · 110 pass · 0 fail · 0 skipped** (534 s) |
| Lint | `npm run lint` | ✅ **0 erros · 401 warnings** (todos `no-explicit-any`) |
| Build do front | `npm run build` | ✅ verde em 13,75 s · bundle principal 319 kB (gzip 95 kB) · PWA 55 entradas de precache |
| Auditoria de menu × rotas × RBAC × multiempresa | `npm run audit:menu` | ✅ **0 erros · 6 avisos** (66 módulos · 80 recursos · 41 navegáveis · 72 tabelas com `empresa_id`) |
| Smoke HTTP ponta a ponta | `npm run smoke` | ⚠️ **126/126 no modo demonstração** · **119/126 contra PostgreSQL real** (7 falhas) |

### 1.5 O que o smoke revelou — e por que isso muda o diagnóstico

`scripts/smoke-e2e.mjs` declara no próprio cabeçalho:

> *"Requer um servidor em **MODO DEMONSTRAÇÃO** (sem DATABASE_URL) recém-subido, com o admin padrão ainda sem MFA."*

Ou seja: **a única suíte E2E HTTP do repositório nunca foi executada contra PostgreSQL**. Executada contra PostgreSQL real nesta auditoria, ela reprova 7 verificações — e três dessas reprovações são **defeitos de produção reais**, invisíveis no modo demonstração porque o `MemStore` não tem as constraints do Postgres.

| Contexto de execução | Resultado |
|---|---|
| Servidor em modo demonstração, recém-subido (`:3002`) | **126/126 OK** |
| Servidor PostgreSQL, banco novo sem `locais` (`:3001`, `brobond_smoke`) | **92/117 OK** — 25 falhas, todas `409 A empresa ativa não possui um local de estoque ativo` |
| Servidor PostgreSQL, com um `local` padrão inserido (`brobond_smoke3`) | **119/126 OK** — **7 falhas reais** (detalhadas em §6 e §8) |

As 7 falhas em PostgreSQL, na íntegra:

```
FAIL  mesma notificação de novo → duplicado (sem 2ª baixa)  — status 202
FAIL  cobrança ficou paga                                   — status=pendente
FAIL  eventos de webhook auditáveis                         — status 200
FAIL  E2: POST /reabrir estorna (gerente)                   — status 500 Erro interno do servidor
FAIL  E2: reabrir descarta os apontamentos                  — apontamentos=1
FAIL  E2: POST /cancelar guarda o motivo                    — status 409 motivo=undefined
FAIL  E2: OP cancelada é terminal                           — status 500
119/126 verificações OK
```

---

## 2. Score por domínio

Escala 0–10. A nota mede **distância até "operacionalmente completo e provado"**, não esforço nem quantidade de código.

| Domínio | Nota | Estado |
|---|---:|---|
| Cadastros | **7,5** | Amplo e completo no essencial; faltam Marca (só coluna texto), Unidades (lista fixa) e telas de NCM/Empresas |
| Vendas | **7,0** | Cadeia inteira existe (proposta→pedido→faturamento→estoque→financeiro→fiscal→expedição); comissões sem menu e BI desconectado |
| Compras | **8,5** | E3/E3.1/E3.2 fechados com evidência PostgreSQL; fluxo mais completo do ERP |
| Estoque | **7,5** | Integridade forte (índices parciais, FK composta empresa+id, CHECK de não negativo); **bug P0 no estorno de OP** e ausência de reserva |
| Produção | **7,0** | E2 completo em memória; **reabrir/cancelar OP quebram com HTTP 500 em PostgreSQL** |
| Financeiro | **6,5** | OFX, CNAB, gateway, DRE, rentabilidade, comissões, recorrências; **webhook de pagamento não confirma nada em PostgreSQL** + dois pipelines de receita paralelos |
| Fiscal | **4,0** | Arquitetura pronta (2 provedores + regras + eventos + inutilização); **nada homologado**, NCM e inutilização sem tela, emissão em modo simulação |
| Logística | **7,5** | E4.2.3 fechado com prova PostgreSQL (vocabulário, divergência JSONB, E2E, concorrência, multiempresa); etiqueta/transportadora real é integração externa |
| BI (Meu Negócio) | **3,0** | Motor analítico bem construído, **apontado para a tabela errada**: lê `sales` (Commerce), não `vendas` (ERP) |
| Administração | **7,5** | RBAC, MFA obrigatório para admin, sessões, auditoria encadeada, política de senha; **CRUD de Empresas sem tela** |
| Frontend | **6,0** | 48 páginas e ui-kit testado; menu mistura ERP com 8 módulos de Commerce ainda planejados; faltam telas de NCM, inutilização, empresas e comissões |
| Segurança | **7,5** | MFA, rate limit, headers, argon2id, auditoria; 3 avisos de deriva RBAC (menu restringe, API não) — **NÃO TESTADO** quanto a pentest |
| E2E | **4,0** | 110/110 em PostgreSQL e 126/126 em memória, mas **as cadeias completas do §23 não têm teste executável em PostgreSQL** |

---

## 3. O que está pronto

Tudo abaixo tem **arquivo + banco + API + tela + teste** e passou nesta auditoria (execução real, salvo indicação).

| Domínio | Pronto | Evidência |
|---|---|---|
| Cadastros | Produtos (ficha completa: SKU, grade, NCM/CEST/CFOP/CST, ICMS/PIS/COFINS/IPI, pesos, dimensões, imagens, composição/kit), Categorias, Cores, Coleções, Tamanhos, Grades, Tabela de Medidas, Insumos, Clientes, Fornecedores, Representantes, Locais de Estoque | `server/src/resources.ts` (83 recursos), `db/schema.sql`, `npm run audit:menu` sem erros |
| Vendas | Venda/orçamento, itens com preço resolvido por lista, propostas com conversão idempotente, PDV com caixa, catálogo público, políticas comerciais, tabelas de preço com histórico | `propostas.test.ts`, `pdv.test.ts`, `listas-preco.test.ts`, `pg-p1.test.ts` |
| Compras | Cotação multi-fornecedor com comparativo e decisão idempotente, recebimento parcial/total, custo unitário efetivo (frete + impostos) e custo médio ponderado, De-Para de fornecedor, importação de XML com prévia, contas a pagar geradas e canceladas junto | `compras.test.ts`, `pg-compras-e32.test.ts`, `pg-custo-recebimento.test.ts`, smoke E3.1/E3.2 **PASS** |
| Estoque | Saldo por produto × tamanho × local, 4 índices únicos parciais por empresa/local, FK composta `(empresa_id, id)`, CHECK `quantidade >= 0`, estorno de movimentação, inventário com ajuste condicional na escrita, `tryAdjustStock` com condição dentro do UPDATE | `e421-estoque.test.ts`, `pg/e421-estoque-integridade.test.ts`, medição de constraints em §1.3 |
| Produção | Máquina de estados com CHECK no banco, apontamentos com perda, custo previsto congelado na liberação, custo real por apontamento, trilha append-only, MRP de insumos | `producao-e2.test.ts`, `pg-producao-e2.test.ts`, smoke E2 **PASS** (exceto reabrir em PG — §8) |
| Financeiro | Lançamentos, parcelamento, baixa parcial, juros/multa/desconto, recorrências, centros de custo, transferências, aportes, OFX com FITID idempotente, CNAB com parsers, conciliação, cartão/recebíveis, DRE, rentabilidade, comissões pró-rata | `financeiro-p2.test.ts`, `pg-p2.test.ts` (concorrência de baixa, FITID, caixa) |
| Logística | Separação → conferência → embalagem → expedição com vocabulário canônico travado por CHECK, divergência de conferência persistida em JSONB e respondida com **422**, rollback, concorrência e isolamento multiempresa provados em PostgreSQL | `pg/e423-expedicao-postgresql.test.ts` (9 testes) |
| Financeiro / Fiscal — arquitetura | `documentos_fiscais`, `documentos_fiscais_eventos`, `inutilizacoes_fiscais`, `regras_fiscais`, `empresa_fiscal_config`, `impostos_ncm`; dois adapters (`focus`, `plugnotas`) + provedor nulo | `fiscal.test.ts`, `pg-fiscal.test.ts` |
| Administração | Login com argon2id, MFA TOTP obrigatório para admin, códigos de recuperação, sessões revogáveis, política de senha, bloqueio por tentativas, auditoria encadeada, troca de empresa ativa | `auth-fluxo.test.ts`, `usuarios.test.ts`, `auditoria.test.ts`, `auditoria-multiempresa.test.ts` |
| Multiempresa | 72 colunas `empresa_id`, **26 triggers** `trg_empresa_*` que derivam a empresa do registro-pai, escopo aplicado no gargalo de `services.ts`, e testes de isolamento A↔B em HTTP e em PostgreSQL | `multiempresa.test.ts`, `pg-multiempresa.test.ts`, `pg-auditoria-multiempresa.test.ts`, contagem de triggers em §1.3 |
| Frontend | 48 páginas, ui-kit com 435 linhas de teste, `ComponentCatalog` em `/dev/componentes`, PWA | `vitest` 226/226 |

---

## 4. O que está parcial

| Item | O que existe | O que falta | Evidência |
|---|---|---|---|
| **NCM / Tributação** · **FECHADO em ERP-05** (tela `/ncm` + menu) | Tabela `impostos_ncm` (recurso `impostos_ncm`, ops `cud`), consumida **pelo motor de BI** para alíquota por item | Tela/entrada de menu. `npm run audit:menu` → `[RECURSO_SEM_MENU] O recurso "impostos_ncm" ... tem CRUD na API mas nenhum código do front o consome` | `server/src/resources.ts:483`, saída de `audit:menu` |
| **Inutilização de numeração fiscal** · **FECHADO em ERP-05** (tela `/inutilizacoes`; a rota respondia **405**) | Tabela `inutilizacoes_fiscais` + rota `POST /api/fiscal/inutilizar` | Tela/entrada de menu (`[RECURSO_SEM_MENU]`) | `resources.ts:1217`, `index.ts` |
| **Empresas (multiempresa)** · **FECHADO em ERP-07** (tela `/empresas`, `adminOnly` provado por HTTP) | Recurso `empresas` com ops `cud` (`resources.ts:446`), rotas `/api/empresas/ativa` e `/api/usuarios/:id/empresas` | **CRUD de empresas sem tela**: o front só consome `/empresas/ativa` (`CompanySwitcher.tsx:35,69`). `audit:menu` **não** sinalizou este caso — confirmando o ponto cego `GAP-E1-AUDIT-BLINDSPOT` já registrado | `resources.ts:446`, `client/src/components/CompanySwitcher.tsx` |
| **Comissões** · **FECHADO em ERP-06** (tela `/comissoes`, conferência com o relatório) | Apuração no faturamento + efetivação pró-rata no recebimento + estorno; rotas `/api/financeiro/comissoes` e `/api/financeiro/comissoes/venda/:id`; relatório `comissoes` | Nenhuma entrada em `MODULES` cria o menu; a tela não existe (só o relatório em `RelatoriosPage`) | `docs/ERP-GAPS.md` `GAP-VEND-COMISSOES-MENU`, `grep comissoes client/src/modules.ts` → vazio |
| **Fiscal — emissão** | Adapters `focus` e `plugnotas` com `ambiente: 'homologacao' \| 'producao'`, eventos, consulta, cancelamento | **Nenhuma emissão homologada.** `nfe.ts` tem `NFE_MODO=simulacao` gravando `nfe_status='simulada'` "sem valor fiscal"; certificado/configuração dependem de credencial externa | `server/src/fiscalProvider.ts:261,453,594`, `server/src/nfe.ts:131,165,181` |
| **Cadastros — Marca** | Coluna `produtos.marca TEXT` (`schema.sql:1740`) e campo texto no recurso (`resources.ts:935`) | Não há tabela `marcas`, nem menu, nem filtro por marca — gap `GAP-CAD-MARCAS` do E1 **continua aberto** | grep por `marcas` em `resources.ts`/`schema.sql` |
| **Cadastros — Unidades** | Lista fixa `UNIDADES` (`resources.ts:176`) usada por insumos e produtos | Não há cadastro de unidades — gap `GAP-CAD-UNIDADES` **continua aberto** | `resources.ts:176,772,975` |
| **Reserva de estoque** | `politicas_comerciais` tem parâmetros de reserva; `estoques` tem saldo por local | Não há tabela/entidade de reserva nem saldo "disponível × comprometido" | `docs/ERP-GAPS.md` (E4 aberto) |
| **Relatórios** | 11 relatórios no backend (`estoque-posicao`, `movimentacoes-periodo`, `producao-periodo`, `vendas`, `abc`, `insumos-minimo`, `faturamento`, `comissoes`, `estoque-minimo`, `razao-financeiro`, `dre`) | `RelatoriosPage.tsx` cobre um subconjunto; a descrição do módulo promete "posição de estoque, movimentações, produção, vendas, curva ABC e insumos mínimos" | `server/src/relatorios.ts`, `client/src/pages/RelatoriosPage.tsx` |
| **Integrações externas** | Adapters de transportadora/gateway/catálogo | Cotação/etiqueta/rastreio reais dependem de credencial externa (o smoke valida o caminho "sem credencial") | `logistica.ts`, `frete.ts`, `cep.ts` |

---

## 5. O que está faltando

### 5.1 Funcionalidade inexistente (sem backend, sem banco, sem tela)

| # | Item | Evidência |
|---|---|---|
| 1 | **Tabela/entidade de reserva de estoque** e conceito de "disponível × comprometido" | `grep -c reserva server/src/estoque.ts` = 0 (registrado no E1; segue igual) |
| 2 | **Cadastro de Marcas** | sem tabela `marcas` |
| 3 | **Cadastro de Unidades de medida** | só a constante `UNIDADES` |
| 4 | ~~**Tela de NCM/tributação**~~ — **fechado em ERP-05** (`/ncm`) | recurso existe, front não consome |
| 5 | ~~**Tela de inutilização fiscal**~~ — **fechado em ERP-05** (`/inutilizacoes`) | recurso existe, front não consome |
| 6 | ~~**CRUD de Empresas**~~ — **fechado em ERP-07** (`/empresas`, com alçada de administrador) | recurso existe, front não consome |
| 7 | ~~**Tela/menu de Comissões**~~ — **fechado em ERP-06** (`/comissoes`) | rotas existem, menu não |

### 5.2 Cadeias que não atravessam o sistema

| # | Ruptura | Evidência executada |
|---|---|---|
| 1 | **Venda do ERP não chega ao Meu Negócio (BI)** | Venda #1 faturada (R$ 200,00) via API → `GET /api/negocios/resumo` continua `faturamentoCents: 0, pedidos: 0, cmvCents: 0`; `GET /api/negocios/abc` → `{A:0,B:0,C:0}`; `SELECT count(*) FROM sales` = 0 e `sale_items` = 0, enquanto `vendas` = 1 e `itens_venda` = 1. O relatório ERP `GET /api/relatorios/vendas` **vê** a venda (200) — a divergência é entre ERP e BI |
| 2 | **Receita/CMV em dois pipelines paralelos** | `financeiro.ts` (DRE e `rentabilidade`) calcula CMV a partir de `itens_venda` + `lancamentos_financeiros`; `negocios.ts` calcula CMV a partir de `sales`/`sale_items` + `fichas_tecnicas`/`impostos_ncm`. São duas contabilidades do mesmo fato econômico |
| 3 | **Confirmação de pagamento (webhook) não fecha o ciclo em PostgreSQL** | §6, bug P0-02 |
| 4 | **Reabertura/estorno de OP não fecha o ciclo em PostgreSQL** | §6, bug P0-01 |

---

## 6. Bugs encontrados

Todos os quatro foram **reproduzidos nesta auditoria**, com causa-raiz identificada. Três só existem em PostgreSQL — o modo demonstração do `MemStore` não tem as constraints e por isso a suíte em memória nunca os veria.

### P0-01 — `POST /api/ordens/:id/reabrir` devolve **HTTP 500** em PostgreSQL (SQLSTATE 23514)

* **Arquivo/linha:** `server/src/producao.ts:557` — `await s.adjustStock(produtoId, tamanhoId, local, -qtd, tx, localId, escopo.empresaId);`
* **Rota:** `POST /api/ordens/:id/reabrir` → `reabrirOrdem` (`producao.ts:1591`) → `updateRecord` (`services.ts:608`) → `aplicarRegrasOrdem` (`producao.ts:735`) → `estornarOrdem` (`producao.ts:532`)
* **Evidência executada** (`node --import tsx /tmp/repro500.mts`, com `DATABASE_URL=...brobond_smoke3`):

```
pg: {
  code: '23514',
  constraint: 'estoques_quantidade_nao_negativo',
  table: 'estoques',
  detail: 'Failing row contains (4, 1, 1, loja, -4, 0, 2026-10-11 11:25:25.256313+00, null, 1, 1).',
  routine: 'ExecConstraints'
}
  at async PgStore.adjustStock (server/src/pgstore.ts:402:17)
  at async estornarOrdem (server/src/producao.ts:557:5)
  at async aplicarRegrasOrdem (server/src/producao.ts:735:24)
ERRO reabrir -> planejada: Erro interno do servidor
  stack: HttpError: Erro interno do servidor
      at toHttpError (server/src/services.ts:49:10)
```

* **Causa-raiz (comprovada com SQL puro):** o `adjustStock` do `PgStore` (`pgstore.ts:402`) faz `INSERT … ON CONFLICT … DO UPDATE` com o **delta como valor da linha candidata**. O PostgreSQL valida a CHECK constraint `quantidade >= 0` sobre a linha candidata **antes** de resolver o `ON CONFLICT` — então um delta `-4` que se somaria ao saldo 4 (resultando 0, perfeitamente válido) **nunca chega à fase de UPDATE** e estoura 23514. Reproduzido com a instrução isolada:

```
INSERT INTO estoques (empresa_id, produto_id, tamanho_id, local, local_id, quantidade, criado_em)
VALUES (1,1,1,'loja',1,-4, now())
ON CONFLICT (empresa_id, produto_id, tamanho_id, local_id) WHERE tamanho_id IS NOT NULL AND local_id IS NOT NULL
DO UPDATE SET quantidade = estoques.quantidade + EXCLUDED.quantidade, ...
→ ERRO code=23514 constraint=estoques_quantidade_nao_negativo
  detail= Failing row contains (5, 1, 1, loja, -4, 0, ...)
```
  (o saldo existente era 4; o resultado correto seria 0).

* **O repositório conhece essa armadilha e a evita em todos os outros pontos.** Existe um método dedicado para delta negativo — `tryAdjustStock` (`pgstore.ts:441`), que faz `INSERT … DO NOTHING` e depois `UPDATE … WHERE quantidade + $4 >= $5`, com a guarda **dentro da escrita**. Ele é usado em **7 pontos** com delta negativo:
  `custoRecebimento.ts:526`, `estoque.ts:425` (inventário), `estoque.ts:586`, `itens.ts:361`, `services.ts:1439`, `services.ts:1458`, `memdb.ts:400`.
  E há dois pontos que **bifurcam explicitamente** por sinal: `estoque.ts:424-430` (`if (delta < 0) tryAdjustStock else adjustStock`) e `estoque.ts:605-606` (`if (deltaInverso < 0) retirar(...) else adjustStock(...)`).
  **`producao.ts:557` é o único ponto do código que chama `adjustStock` com delta negativo literal.** É por isso que só a reabertura de OP quebra.
* **Agravante:** `translatePgError` (`pgstore.ts:116`) trata 23505, 23503, 23502, 40001, 40P01, 22P02, 22003, 22007, 22008, 42P01 e 42703 — **não trata 23514**. O erro de negócio vira `500 Erro interno do servidor` em vez de 409/422 explicativo.
* **Impacto:** `POST /api/ordens/:id/reabrir` é inutilizável em PostgreSQL. A OP permanece `concluida`, os apontamentos **não** são descartados (`apontamentos=1` após a chamada) e o estoque **não** é estornado — mas a transação reverte, então não há corrupção, há **indisponibilidade funcional**. Em cascata, o smoke falha em `OP cancelada é terminal` (esperava 409, recebeu 500) porque o passo de reabertura anterior não mudou o estado.
* **Severidade:** 🔴 **P0** — função de negócio essencial (desfazer conclusão de OP) devolve 500 em produção com PostgreSQL.
* **Recomendação (não executada):** trocar `adjustStock(..., -qtd, ...)` por `tryAdjustStock(..., -qtd, tx, 0, localId, empresaId)` em `producao.ts:557` e tratar `null` como 409 explicativo; adicionar `case '23514'` em `translatePgError`; criar teste PG de `reabrirOrdem`.

### P0-02 — Webhook de pagamento nunca confirma a cobrança em PostgreSQL (e vaza nome de constraint no endpoint público)

* **Arquivos/linhas:**
  * `server/src/gateway.ts:949` — `payload = JSON.parse(String(evento.payload || '{}')) as Record<string, unknown>;`
  * `db/schema.sql:2985` (tabela `gateway_webhook_events`) — coluna `payload JSONB`
  * `server/src/gateway.ts:864` — caminho correto do duplicado (`res.json({ ok: true, duplicado: true })`)
  * `server/src/gateway.ts:928` — `catch` externo que devolve `202` com a mensagem crua
* **Rota:** `POST /api/gateway/webhooks/:provider` (**pública, sem autenticação**, montada antes do `express.json` e do `requireAuth`)
* **Evidência executada** (autenticado com TOTP derivado da base `brobond_smoke3`):

```
cobranca: 201 ref= mock-794a1bec9aa6
wh1: 200 {"ok":true,"evento_id":"payment.paid:mock-794a1bec9aa6:364e...","processado":true}
wh2: 202 {"ok":false,"erro":"duplicate key value violates unique constraint \"uq_gateway_webhook_evento\""}
cobranca depois: 200 status= pendente
eventos: 200 []
```
  E no banco, a razão de tudo:
```
gateway_webhook_events:
 id=3  evento_id=payment.paid:mock-794a1bec9aa6:...  status='ignorado'
       erro='Nenhuma cobrança deste provedor com essa referência.'
gateway_cobrancas:
 id=2  provider='mock'  provider_ref='mock-794a1bec9aa6'  status='pendente'   ← existe!
```

* **Causa-raiz (comprovada com o payload lido do banco):** o driver `pg` devolve uma coluna `jsonb` como **objeto JavaScript**, não como string. `String(objeto)` produz `"[object Object]"`; o `JSON.parse` lança; o `try/catch` engole e `payload = {}`; `extrairRefDoPayload` passa a devolver `null`; `processarEvento` não encontra a cobrança e marca o evento como `'ignorado'`. **Toda notificação de pagamento é descartada em PostgreSQL.** Reprodução do defeito de tipo:

```
payload armazenado (jsonb) : { data: {...}, event: 'payment.paid', status: 'pago' }
JSON.parse(String(payload)) → SyntaxError: "[object Object]" is not valid JSON
```

  Efeito dominó: como o evento fica `'ignorado'`, a checagem de duplicidade (`gateway.ts:862-864`, que ignora de propósito eventos `'ignorado'`) **não reconhece a repetição**, o `INSERT` bate no índice único `uq_gateway_webhook_evento` e o `catch` externo responde **HTTP 202 com a mensagem crua do Postgres** — em um endpoint **anônimo**. É erro de tipo do mesmo gênero do `GAP-EXPEDICAO-CONFERENCIA-PG` (audiência E4.2.3: arrays JS → JSONB, SQLSTATE 22P02), mas do lado da **leitura**, e não foi coberto pela correção do store.
* **Contraste que confirma o diagnóstico:** as outras duas ocorrências do mesmo padrão — `server/src/webhooks.ts:454` e `webhooks.ts:475`, e `politicaSenha.ts:79` — operam sobre colunas **`TEXT`** (`webhook_entregas.payload TEXT`, `configuracoes.valor TEXT`, medido em `information_schema`), portanto **estão corretas**. Só `gateway.ts:949` aponta para uma coluna `jsonb`.
* **Impacto:** nenhuma cobrança Pix/boleto/cartão vira `'paga'` por webhook em PostgreSQL; o ciclo Financeiro → Recebimento não fecha automaticamente; a conciliação fica dependente de baixa manual; e o endpoint público devolve metadado do schema. `pg-p2.test.ts` passa 110/110 porque só verifica que o índice único **existe**, nunca exercita a rota.
* **Severidade:** 🔴 **P0** — quebra o ciclo financeiro principal e expõe informação de schema em endpoint anônimo.
* **Recomendação (não executada):** aceitar objeto **ou** string em `gateway.ts:949` (normalizar conforme o tipo real da coluna), alinhar o `type` do campo `payload` no recurso `R_GATEWAY_WEBHOOK_EVENTS` (`gateway.ts:118`, hoje `type: 'textarea'`) ao `jsonb` do banco, e trocar o `catch` externo por resposta sem mensagem crua de driver.

### P0-03 — O BI (Meu Negócio) não lê as vendas do ERP

> **✅ FECHADO em ERP-04 (2026-10-11).** Decisão no [ADR-001](ADR-001-FONTE-UNICA-FATURAMENTO.md) (projeção `vendas → sales`, namespace `erp:`); prova em `server/test/pg/bi-faturamento-e2e.test.ts` — BI e relatório de faturamento no mesmo período, tolerância zero. A "incoerência adicional" abaixo (autorização em `vendas`, dados em `sales`) deixou de existir como divergência: os dados agora são derivados de `vendas`.

* **Arquivo:** `server/src/negocios.ts` — a CTE `vendas_escopo` (linhas 494, 502, 558) é construída **exclusivamente sobre `sales`**, e a materialização faz `UPDATE sales s` (linha 575). Não existe view `vendas_escopo` (`information_schema.views` → **0 views**) nem vínculo com `vendas`.
* **Evidência executada** — venda real criada e faturada pela API do ERP, contra PostgreSQL:

```
cliente: 201 1
venda : 201 status=aberta
item  : 201 quantidade=2 preco_unitario=100.00 subtotal=200.00
faturar: 200 status=faturada
BI ANTES : 200 kpis.faturamentoCents=0 pedidos=0 cmvCents=0
BI DEPOIS: 200 kpis.faturamentoCents=0 pedidos=0 cmvCents=0      ← não mudou
BI ABC   : 200 [{classe:A,itens:0},{classe:B,itens:0},{classe:C,itens:0}]
```
  E no banco: `vendas=1, itens_venda=1, sales=0, sale_items=0, produto_abc=0, movimentacoes=2, lancamentos_financeiros=5`.
  O relatório **do ERP** vê a venda: `GET /api/relatorios/vendas` → `200 {"titulo":"Vendas por Cliente", ...}`.
* **Quem escreve em `sales`:** apenas `server/src/negocios.ts` (venda manual, `INSERT INTO sales`) e o motor de conectores em `modules/connectors/ingestion/` (`sales.service.ts`, `sale-ingestion.service.ts`, `catalog-matcher.ts`) — todos **Commerce**. Não há `sales.venda_id` (medido em `information_schema`) nem trigger ligando `vendas` a `sales`.
* **Incoerência adicional:** os endpoints do BI gateiam por `RESOURCES.vendas` (`negocios.ts:1424,1440`) — a **autorização** está ligada ao ERP, os **dados** vêm do Commerce.
* **Impacto:** o painel de entrada do produto (`/`, Meu Negócio) mostra zero para toda a operação feita pelo ERP — vendas, PDV, catálogo público e propostas convertidas. Faturamento, ticket médio, CMV, impostos, margem, curva ABC e análise de canais ficam desconectados da operação real. Além disso, `financeiro.ts` mantém um **segundo** cálculo de receita/CMV (`rentabilidade`, `DRE`) sobre `itens_venda` — duas fontes para o mesmo número.
* **Severidade:** 🔴 **P0** — é a proposta central do produto (BI do "Meu Negócio") reportando zero.
* **Recomendação (não executada):** decidir a **fonte única de verdade do faturamento** (a especificação do §30 manda VENDAS → FINANCEIRO → BI atravessarem a cadeia) e alimentar o motor a partir de `vendas`/`itens_venda`, mantendo `sales` apenas para a ingestão dos canais externos. **Não reimplementar** `negocios.ts` (proibido pelo escopo): o motor já existe e está testado — o que falta é a origem dos dados.

### P0-04 — A suíte E2E obrigatória não roda contra PostgreSQL

* **Arquivo:** `scripts/smoke-e2e.mjs` (cabeçalho, linhas 19-20 e 24): *"Requer um servidor em MODO DEMONSTRAÇÃO (sem DATABASE_URL) recém-subido, com o admin padrão ainda sem MFA."*
* **Evidência:** 126/126 em memória vs 92/117 em PostgreSQL novo; 119/126 em PostgreSQL com `local` semeado. As 25 falhas do banco novo são todas:

```
FAIL  E3.1: 1º lote (40 un) recebido — status 409 A empresa ativa não possui um local de estoque ativo.
FAIL  E3.2: prévia devolve 200 e aplicado=false — status 409 ...
(…21 ocorrências idênticas…)
```

* **Causa-raiz:** uma instalação PostgreSQL nova **não tem nenhum registro em `locais`** (medido: `SELECT * FROM locais` → `[]`, `empresas` → 1 linha `BROBOND`). O fluxo de recebimento/faturamento/movimentação exige um local ativo e único por empresa (`compras.ts:167`, `itens.ts:313`, `services.ts:1133`, `services.ts:1367` via `getDefaultLocalInfo`, `services.ts:1138`). No modo demonstração o `MemStore` semeia três locais a partir do `mock` do recurso (`resources.ts:435-439`: `loja` com `padrao: true`), por isso o smoke passa lá e só lá.
* **Impacto:**
  1. **Nenhum dos 4 fluxos E2E exigidos pela E12 do `docs/ERP-GAPS.md` ("script executado contra PostgreSQL real") jamais rodou** — o gate declarado como critério de aceite não existe como execução.
  2. Foi exatamente esse vão que deixou P0-01 e P0-02 invisíveis: `test:pg` passa 110/110 e o smoke passa 126/126 enquanto duas funcionalidades centrais estão quebradas em produção.
  3. Lacuna de onboarding real: a primeira instalação com PostgreSQL não consegue receber uma compra, faturar uma venda ou movimentar estoque antes de alguém cadastrar um local manualmente (o erro é claro, mas é um pré-requisito não documentado no fluxo de instalação).
* **Severidade:** 🔴 **P0** — é o gate de verificação do ERP que não verifica o ERP.
* **Recomendação (não executada):** tornar o smoke parametrizável por ambiente (semear `local` padrão + empresa quando `DATABASE_URL` existir) e adicioná-lo ao job `testes-postgres` do CI, que já sobe `postgres:16`.

### P0-06 — `POST /api/usuarios` responde **sempre 409** em PostgreSQL e **nenhum usuário é criado** (*descoberto e fechado no ERP-07*)

* **Arquivo:** `server/src/usuariosAdmin.ts` — `gerarConvite()` (linha 87 na auditoria; o `store.audit({...})` sem `tx`).
* **Evidência:** 3 tentativas consecutivas de `createRecord(usuarios)` em PostgreSQL real ⇒ **3× falha 409** com a mensagem
  *"Outra operação alterou estes dados ao mesmo tempo. Nada foi gravado — confira os valores e tente novamente."*, e
  `SELECT count(*) FROM usuarios` **inalterado** (nenhum usuário criado). Em paralelo, `SELECT count(*) FROM auditoria WHERE acao = 'convite'`
  crescia a cada tentativa (**7 linhas**) — as auditorias dos convites "que não aconteceram" **sobreviveram ao rollback**.
* **Causa-raiz:** o cadastro roda em transação `SERIALIZABLE` (`createRecord`). Dentro dela, `gerarConvite()` chamava
  `store.audit({...})` **sem o `tx`**: o `PgStore` abria uma **segunda conexão** para inserir em `auditoria` enquanto a
  transação principal estava aberta ⇒ PostgreSQL `40001` (`serialization_failure`) na transação de cadastro ⇒
  `translatePgError` (`server/src/pgstore.ts:116-160`) traduz `40001`/`40P01` em **409 "Outra operação alterou estes dados ao mesmo tempo."**.
  O `catch(() => undefined)` no `audit` engolia o erro da segunda conexão; o defeito só aparecia na transação principal.
* **Impacto:** **nenhum usuário podia ser criado em PostgreSQL** — painel de usuários, convites, primeiro acesso de equipe.
  O modo demonstração (`MemStore`, sem transações reais) **nunca** reproduzia o defeito: o mesmo vão de ambiente dos P0-01/P0-02.
  O log de auditoria registrava convites inexistentes (efeito de borda de compliance).
* **Severidade:** 🔴 **P0** — funcionalidade administrativa central inoperante no banco real, com mensagem que acusa o operador
  ("outra operação alterou") por um defeito do servidor.
* **Correção (ERP-07, 2026-10-11):** `store.audit({...}, tx)` — a auditoria entra na **mesma transação** do cadastro. Uma linha,
  sem migration, sem regra nova. Varredura: `usuariosAdmin.ts` tem **13** chamadas de `store.audit`; as outras **12** pertencem a
  rotas que já gravam em `tx` própria — a do convite era a única dentro de transação alheia.
* **Prova:** `server/test/pg-usuario-convite.test.ts` (banco novo): usuário criado **dentro** da transação, auditoria do convite
  gravada **na mesma transação** (contagem conferida por SQL), política de senha validada — e **mutação**: removido o `tx`, o teste
  **falha** com o 409 do `40001`. Antes/depois do fix: `3× FALHOU` · `usuarios criados: 0` ⇒ `ok 8` · `ok 9` · `usuarios criados: 2`.

### P1-01 — Divergência de RBAC entre menu e API (3 casos)

* **Evidência:** `npm run audit:menu` → 3× `[RBAC_DERIVA_SOLTA]`:
  * módulo `politicas-comerciais` (menu `minPerfil=gerente`) → recurso `politicas_comerciais` sem restrição no servidor;
  * módulo `listas-preco` (menu `minPerfil=gerente`) → recurso `listas_preco` sem restrição;
  * módulo `envios` (menu `minPerfil=gerente`) → recurso `envios` sem restrição.
* **Impacto:** a restrição existe só no front. Um operador autenticado alcança a API por chamada direta. `services.ts:149` até abre exceção explícita para `catalogos` e `politicas_comerciais`, confirmando que a exceção é intencional em um dos casos — os outros dois exigem decisão de produto.
* **Severidade:** 🟠 **P1**.

### P1-02 — `EFEITO COLATERAL`: `E2: OP cancelada é terminal` retorna 500 em vez de 409

* **Evidência:** `FAIL E2: OP cancelada é terminal — status 500`. Como a reabertura falhou (P0-01), a OP continuou `concluida`; a tentativa de "ressuscitar" cai no mesmo `estornarOrdem` e devolve 500 em vez do 409 de estado terminal.
* **Severidade:** 🟠 **P1** (sintoma do P0-01, mas com mensagem errada ao usuário — o correto seria a transição inválida de `TRANSICOES_OP`).
* **Fechado em ERP-02 (2026-10-11) como cascata:** com o estorno funcionando, a OP volta a `planejada`, `POST /cancelar` responde 200 e `PUT` numa OP `cancelada` responde **409** — coberto pelo teste novo (`e02-ordem-reabrir-postgresql.test.ts`) e pelo smoke PostgreSQL **126/126**. Nenhum código foi mudado por causa deste item.

### P1-11 — A assinatura do webhook é global por provedor (não por empresa) — *descoberto na implementação do ERP-01*

* **Arquivo:** `server/src/gateway.ts` — a validação de assinatura lista as configs **sem filtro de empresa**:

```ts
const configs = await s.list(R_GATEWAY_CONFIGS, { page: 1, pageSize: 50, filter: { provider: providerId } });
...
for (const c of configs.rows) {
  const segredo = decifrarSegredo(c.webhook_segredo_cifrado);
  if (!segredo) continue;
  temSegredo = true;                                    // ← qualquer empresa do sistema
  if (provider.verificaAssinatura(ctxLocal, corpo, headers)) { assinaturaOk = true; empresaId = Number(c.empresa_id); break; }
}
if (temSegredo && !assinaturaOk) return res.status(401).json({ error: 'Assinatura inválida.' });
```
* **Evidência executada** (apareceu como falha do cenário de concorrência do teste novo, e depois isolada em teste próprio):

```
not ok — a empresa que não configurou segredo não pode ser recusada por causa de outra;
          veio 401 {"error":"Assinatura inválida."}
```
  Reprodução mínima: empresa A com `webhook_segredo_cifrado` configurado + empresa B **sem** segredo → notificação legítima de B (não assinada) é recusada com **401** e o pagamento de B não é processado. O `todo` correspondente vive em `server/test/pg/e01-gateway-webhook-postgresql.test.ts` ("ERP-01/P1-11"). Efeito colateral medido na prática: **segredos residuais de execuções anteriores** na mesma base recusaram webhooks não assinados de empresas criadas depois — o ambiente só voltou a passar depois de suspender/limpar as configs com segredo.
* **Caminho inverso (INFERÊNCIA a partir do mesmo trecho, não exercitada):** quando a assinatura é aceita, `empresaId` recebe a empresa da config **que aceitou** — uma notificação com assinatura da empresa A cujo payload referencia cobrança da empresa B grava o evento com `empresa_id` de **A**. O efeito financeiro continua sendo aplicado na cobrança correta (o processamento usa `cobranca.empresa_id`), mas a **atribuição do evento e o registro de auditoria ficam na empresa errada**.
* **Impacto:** em operação multiempresa, basta **uma** empresa configurar segredo para que todos os webhooks não assinados do provedor passem a ser recusados — e o evento vai para `'ignorado'`. O endpoint público é único para todas as empresas (`POST /api/gateway/webhooks/:provider`), então não há como o provedor saber de qual empresa é a notificação antes de a assinatura ser validada.
* **Severidade:** 🟠 **P1** — quebra o ciclo de pagamento de terceiros (multiempresa) e cria atribuição incorreta de evento; não é explorável para movimentar saldo (o efeito segue a cobrança).
* **Recomendação (não executada):** resolver o `provider_ref` → cobrança **antes** de validar a assinatura e exigir o segredo **da empresa dona da cobrança**; para notificação sem cobrança conhecida (órfã), registrar como `'ignorado'` com `empresa_id` nulo em vez de 401 global. A correção depende da decisão de escopo multiempresa (§20) e por isso **não** foi feita no ERP-01.

### Observação de conformidade (não é bug)

`FAIL E2: POST /cancelar guarda o motivo — status 409 motivo=undefined` **não é defeito do servidor**: `TRANSICOES_OP` (`producao.ts:85-92`) define `concluida: ['planejada','em_producao']` e `cancelada: []` — cancelar uma OP concluída é proibido de propósito (o caminho é reabrir e então cancelar), e a API responde 409 com a lista de transições permitidas. O smoke, porém, **espera 200** nesse passo. Ou seja: há uma **divergência entre o smoke e a regra de negócio** que precisa ser resolvida em um dos dois lados — e ela ficou escondida porque, em modo demonstração, a reabertura anterior funciona (o `MemStore` não tem CHECK) e a OP chega cancelável ao passo seguinte.

---

## 7. Duplicidades encontradas

Classificação: 🔴 perigosa · 🟠 funcional · 🟡 aceitável · 🔵 refatoração futura. **Nada foi refatorado.**

| # | Duplicidade | Onde | Classe | Comentário |
|---|---|---|---|---|
| 1 | **Dois motores de receita/CMV** | `negocios.ts` (sobre `sales`/`sale_items`) × `financeiro.ts` (`rentabilidade` e `DRE`, sobre `itens_venda`/`lancamentos_financeiros`) | 🟠 **reduzido em ERP-04** | A causa direta (P0-03) foi fechada: o BI agora deriva de `vendas`, então BI e ERP partem do **mesmo** fato (igualdade BI × relatório de faturamento provada). O DRE do `financeiro.ts` continua com motor próprio — **igualdade BI × DRE não foi provada** neste ciclo (candidata a teste no ERP-13) |
| 2 | **Dois caminhos de escrita de saldo** | `adjustStock` (INSERT…ON CONFLICT) × `tryAdjustStock` (INSERT…DO NOTHING + UPDATE condicional), ambos em `pgstore.ts:389` e `441` | 🟠 | Duplicação **intencional e documentada** (`store.ts:170-176` explica a janela de corrida). O problema não é a duplicação: é o único ponto (`producao.ts:557`) que escolhe o caminho errado. Fechá-la é o caminho natural para P0-01 |
| 3 | **Três implementações do conceito "custo do produto"** | `custoRecebimento.ts` (média ponderada do insumo no recebimento), `producao.ts:336` (`calcularCustoReal` da OP), `negocios.ts` (CMV por ficha técnica com fallback `custo_calculado` → `produtos.custo`), `detail.ts:91` (margem real da ficha) | 🟠 | Cada um responde a uma pergunta diferente, mas os três alimentam "custo" e "margem". Sem uma definição canônica escrita, os números vão divergir |
| 4 | **Duas implementações do `Store`** | `pgstore.ts` × `memdb.ts` | 🟡 | Decisão de arquitetura declarada (modo demonstração). Risco conhecido e já registrado como `GAP-ESTQ-MEMSTORE-TX`. O custo real dele apareceu nesta auditoria: **o modo demonstração não reproduz o banco**, e é nele que o smoke roda |
| 5 | **Duas superfícies de venda** | `pdv.ts` (PDV/balcão) × `itens.ts`+`services.ts` (venda de pedido) | 🟡 | Ambas terminam no mesmo `vendas`/`itens_venda` e reutilizam os cálculos de total; risco baixo, mas a regra de desconto/limite está em dois lugares |
| 6 | **Webhooks internos × webhooks de gateway** | `server/src/webhooks.ts` (saída, `webhook_entregas`) × `gateway.ts` (entrada, `gateway_webhook_events`) | 🟡 | Domínios distintos (notificar × receber), sem sobreposição de dados. Mas P0-02 nasce justamente daqui: os dois leem `payload` com o mesmo helper mental, e só uma das colunas é `TEXT` |
| 7 | **Extrato OFX × CNAB** | `extrato.ts` × `cnab.ts` | 🔵 | Dois formatos bancários, dois parsers, destino comum (`fin_extrato_transacoes`). Coeso |
| 8 | **Conciliação manual × por linha × por gateway** | `financeiro.ts` (`conciliacao`), `extrato.ts` (linha), `gateway.ts` (webhook) | 🔵 | Três entradas para o mesmo objetivo. Sem conflito comprovado |

**Não encontrados:** engines de autenticação duplicados, dois RBACs, dois motores fiscais, duas implementações de expedição ou de produção. O padrão de "fonte única" (`RESOURCES` para contrato, `services.ts` para RBAC/escopo, `store.ts` para persistência) está de fato aplicado — com a exceção notável de `negocios.ts`, que é um **motor analítico inteiro fora do contrato de recursos**.

---

## 8. Gaps P0 — BLOCKING

| ID | Gap | Domínio | Evidência | Depende de |
|---|---|---|---|---|
| **P0-01** | Reabrir/estornar OP devolve 500 em PostgreSQL (23514; `adjustStock` com delta negativo) · **FECHADO em ERP-02 (2026-10-11)** | Produção / Estoque | §6 P0-01 · evidência do ciclo na §5 do roadmap | — |
| **P0-02** | Webhook de pagamento não confirma cobrança em PostgreSQL (jsonb lido como objeto) e vaza constraint no endpoint público · **FECHADO em ERP-01 (2026-10-11)** | Financeiro / Segurança | §6 P0-02 · evidência do ciclo na §5 do roadmap | — |
| **P0-03** | BI não vê as vendas do ERP (lê `sales`, escreve nada em `vendas`) · **FECHADO em ERP-04 (2026-10-11)** | BI / Vendas / Arquitetura | §6 P0-03 · [ADR-001](ADR-001-FONTE-UNICA-FATURAMENTO.md) · `server/test/pg/bi-faturamento-e2e.test.ts` | — |
| **P0-04** | Suíte E2E não executa contra PostgreSQL; sem `local` padrão a instalação nova não opera estoque · **FECHADO em ERP-03 (2026-10-11)** | Testes / Estoque / Onboarding | §6 P0-04 · evidência do ciclo na §5 do roadmap | — |
| **P0-06** | `POST /api/usuarios` responde **sempre 409** em PostgreSQL (nenhum usuário é criado) e a auditoria do convite sobrevive ao rollback: `gerarConvite` chama `store.audit` **sem `tx`** ⇒ segunda conexão dentro da transação `SERIALIZABLE` ⇒ `40001` · **descoberto e FECHADO em ERP-07 (2026-10-11)** | Administração / Banco / Auditoria | §6 P0-06 · `server/test/pg-usuario-convite.test.ts` (mutação) | — |
| **P0-05** | `db/schema.sql` recriava a cada boot o índice **global** `uq_produtos_codigo_barras`: com o mesmo código de barras em duas empresas (legítimo desde a 0018) **o boot falhava** (`could not create unique index`) e a API não subia · **descoberto e FECHADO em ERP-03 (2026-10-11)** | Banco / Boot / Multiempresa | §5 ERP-03 (prova antes/depois do `migrate`) | — |

**Critério de saída dos P0:** cada um com teste que **falha antes e passa depois**, executado em PostgreSQL real, e nenhum deles com cobertura apenas em memória.

---

## 9. Gaps P1 — CRÍTICO

| ID | Gap | Backend | Banco | API | Frontend | Menu | RBAC | Testes |
|---|---|---|---|---|---|---|---|---|
| **P1-01** | Deriva RBAC em 3 recursos (`politicas_comerciais`, `listas_preco`, `envios`) | existe | existe | existe | — | restringe | **falta no servidor** | falta |
| **P1-02** | NCM/`impostos_ncm` sem tela (bloqueia operação fiscal real) · **FECHADO em ERP-05 (2026-10-11)** | ✅ | ✅ | ✅ | ✅ `NcmPage` | ✅ grupo Fiscal | ✅ (`minPerfil: gerente`) | ✅ `fiscal.test.ts` + `NcmPage.test.tsx` 10/10 |
| **P1-03** | Inutilização fiscal sem tela **e a rota respondendo 405 para todo perfil** · **FECHADO em ERP-05 (2026-10-11)** | ✅ | ✅ | ✅ (corrigida) | ✅ `InutilizacoesPage` | ✅ grupo Fiscal | ✅ (`checkFluxo`: gerente/admin) | ✅ `fiscal.test.ts` 24/24 + `pg/fiscal-inutilizacao-e2e.test.ts` |
| **P1-04** | CRUD de Empresas sem tela (multiempresa administrável só por API) · **FECHADO em ERP-07 (2026-10-11)** | ✅ | ✅ | ✅ (alçada `adminOnly` + seletor preservado) | ✅ `EmpresasPage` + modal de acessos | ✅ grupo Configurações (`minPerfil: 'admin'`) | ✅ **403 para gerente por HTTP** (`pg/empresas-admin-e2e.test.ts`) | ✅ `empresas-admin.test.ts` 9/9 + `pg-empresas-admin.test.ts` + `EmpresasPage.test.tsx` 8/8 |
| **P1-05** | Comissões sem tela e sem menu (apuração existe e está testada) · **FECHADO em ERP-06 (2026-10-11)** | ✅ | ✅ | ✅ | ✅ `ComissoesPage` | ✅ grupo Financeiro | ✅ (`gerente`) | ✅ `financeiro-p2.test.ts` + `pg/comissoes-e2e.test.ts` (igualdade tela × relatório) + `ComissoesPage.test.tsx` 8/8 |
| **P1-06** | Reserva de estoque / disponível × comprometido | ❌ | ❌ | ❌ | ❌ | ❌ | — | ❌ |
| **P1-07** | Fonte única do faturamento (correção estrutural de P0-03) · **FECHADO em ERP-04** | ✅ | ✅ | ✅ | — | — | — | ✅ BI = relatório no mesmo período (`bi-faturamento-e2e`) |
| **P1-08** | Fiscal sem homologação real (adapters existem, nada emitido) | ✅ | ✅ | ✅ | parcial | parcial | ✅ | só contrato |
| **P1-09** | Cadeia de devolução sem prova ponta a ponta em PostgreSQL · **FECHADO em ERP-08 (2026-10-11)** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ `pg/devolucao-e2e.test.ts` (parcial · avariado não volta nem pelo estorno · total cancela e reverte · idempotência · multiempresa 404) + **mutação** |
| **P1-10** | `E2: OP cancelada é terminal` responde 500 (mensagem errada) — **fechado em ERP-02 como cascata** | ✅ | — | ✅ | — | — | — | smoke + `e02-ordem-reabrir-postgresql.test.ts` |
| **P1-12** | `fiscal.ts` grava o payload do evento fiscal com `JSON.stringify(payload).slice(0, 20000)`: acima de 20.000 caracteres o JSON é **truncado no meio** e o `jsonb` recusa com 22P02 — a emissão falha com um 400 enganoso ("valor inválido em um dos campos"). Descoberto pelo contrato tipo × coluna do ERP-03 (o campo era `textarea` sobre `jsonb`; agora o tipo está alinhado, o corte continua) | ✅ | ✅ | ✅ | — | — | ✅ | contrato de tipo (ERP-03) | endereçado em **ERP-05** (Fiscal) |
| **P1-11** | Assinatura de webhook é global por provedor (sem empresa): segredo de A recusa notificação de B; evento pode ser gravado com `empresa_id` de quem assinou | ✅ | ✅ | ✅ | — | — | ✅ | **todo** em `server/test/pg/e01-gateway-webhook-postgresql.test.ts` (descoberto no ERP-01) |
| **P1-13** | Filtro de período comparava `String(Date).slice(0, 10)` com a data pedida: em PostgreSQL (TIMESTAMPTZ → `Date`) o valor vira `"Thu Oct 01"` e `?de=&ate=` **descarta linhas reais**. Achado pelo critério de igualdade do ERP-04 (8 pontos de `relatorios.ts`); **varredura completa em 2026-10-11: 17 módulos** passaram a usar a **única** normalização `utils.diaISO` (`Date` \| ISO \| vazio \| inválido), e as cópias locais de `relatorios`, `financeiro`, `listasPreco`, `propostas` e `extrato` desapareceram. Corrigidos também `comissoes.ts:261` (relatório de comissões), `quality.ts`, `usuariosAdmin.ts`, `scheduled.ts`, `producao.ts`, `fiscalRegras.ts`, `politicasComerciais.ts`, `portal.ts`, `nfe.ts`, `export.ts` (CSV/XLSX), `gateway.ts` e `pdf.ts`. Fora de escopo **de propósito**: entradas externas (CSV/OFX/XML/corpo JSON) e datas geradas pelo próprio Node | ✅ | ✅ | ✅ | — | — | — | ✅ `utils.test.ts` 3/3 + `pg/comissoes-periodo.test.ts` (banco novo) + **mutação** (`comissoes.ts:261` revertido ⇒ `not ok`) | **fechado em 2026-10-11** (ciclo P1-13 + P2-08) |
| **P1-14** | `sales.usuario_id` é `NOT NULL` (FK para `usuarios`): a projeção do ERP elege um **responsável técnico** — primeiro usuário ativo **da empresa** e, se a empresa não tiver nenhum, o primeiro usuário ativo **do sistema** (fallback global, **verificado na auditoria**: a venda da empresa 2 saiu assinada por usuário da empresa 1, sem vazamento em tela alguma: o BI escopa por `empresa_id` e o painel dos conectores escopa por `usuario_id + channel` de conector, canal que a projeção não produz). Com **zero** usuários ativos, ver **P2-08** | ✅ | ✅ | ✅ | — | — | — | ✅ `bi-faturamento-e2e` + `negocios-projecao-erp` | ADR-001 §4/§5 revisado + auditoria §6 (AUD-02) |

---

## 10. Gaps P2 — IMPORTANTE

| ID | Gap | Observação |
|---|---|---|
| **P2-01** | Cadastro de **Marcas** (hoje só `produtos.marca TEXT`) | `GAP-CAD-MARCAS` do E1 segue aberto; não impede operar |
| **P2-02** | Cadastro de **Unidades de medida** (hoje lista fixa `UNIDADES`) | `GAP-CAD-UNIDADES` segue aberto |
| **P2-03** | `MemStore` sem isolamento real de transação/concorrência | `GAP-ESTQ-MEMSTORE-TX`; já registrado, ganhou relevância nesta auditoria por ser o ambiente em que o único E2E roda |
| **P2-04** | Cobertura de relatórios no front menor que o backend | 11 relatórios no servidor; `RelatoriosPage` cobre um subconjunto |
| **P2-05** | `audit:menu` não cobre recursos com CRUD sem módulo cujo nome difira do recurso | Ponto cego comprovado: `empresas` não foi sinalizado, `impostos_ncm` foi |
| **P2-06** | Teste de concorrência apenas no `PgStore` | correto por design; **declarado em ERP-03** (cabeçalho de `scripts/smoke-pg.mjs` + §5 do roadmap): memória/demonstração não é produção |
| **P2-07** | `/api/health` responde `{ok:true, db:'postgres'}` **antes** de as migrações e o `ensureAdmin` terminarem: um orquestrador que confie só no health pode rotear tráfego para uma instância ainda migrando (o gate `smoke:pg` precisou esperar o marco real do boot). Descoberto no ERP-03 | liveness × readiness; correção sugerida: só responder `ok` depois do boot completo |
| **P2-08** | **Projeção do ERP com ZERO usuários ativos abortava com `23503`:** o passo das vendas exige responsável (`AND COALESCE(eu.usuario_id, fb.usuario_id) IS NOT NULL`), o passo dos **itens não repetia a condição** e a instrução violava a FK `sale_items_sale_id_fkey` — a projeção inteira falhava (nenhuma linha parcial, transação abortada) e a via `POST /api/negocios/margens/recalcular` respondia **400 "Referência inválida"** (tradução do 23503 em `services.ts:43-50`, mensagem enganosa). **Descoberto na auditoria independente (AUD-01)**; o ADR dizia "pulada e logada". **Corrigido em 2026-10-11:** o `INSERT` dos itens ganhou `AND EXISTS (SELECT 1 FROM sales s WHERE s.id = 'erp:venda:' \|\| iv.venda_id)` — venda não projetada não produz itens, sem linha parcial e sem erro | ✅ | ✅ | ✅ | — | — | — | ✅ `pg/projecao-sem-usuario.test.ts` (banco novo) + **mutação** (cláusula removida ⇒ `23503`) + experimento `/tmp/aud-nouser.mts` | **fechado em 2026-10-11** (ciclo P1-13 + P2-08) |
| **P2-09** | **`test:pg` não é repetível em banco reaproveitado:** `pg-cotacoes-compra` gera CNPJs cujo valor efetivo no índice `uq_empresas_cnpj` é `regexp_replace(cnpj,'[^0-9]','','g')` → **4–6 dígitos** derivados de um prefixo temporal base36 que muda devagar; as empresas de teste nunca são removidas e a execução seguinte colide em 23505 (5 testes reprovados em `brobond_teste` com 701 empresas; o mesmo arquivo passa 7/7 duas vezes em banco novo). **Descoberto na auditoria independente (AUD-03)** | ✅ | ✅ | ✅ | — | — | — | ❌ | derivar 14 dígitos do sufixo inteiro **ou** limpar as empresas do cenário no teardown |

---

## 11. Gaps P3 — FUTURO

| ID | Gap |
|---|---|
| **P3-01** | Responsividade/acessibilidade (teclado, foco, ARIA, 360/768/1280 px) — nenhuma varredura executada (`GAP-UX-AUDIT-RESPONSIVO`) |
| **P3-02** | Cadeias de navegação sem atalho (compra → recebimento → estoque → financeiro; OP → consumo → estoque) |
| **P3-03** | Série diária de faturamento no Meu Negócio (`docs/ETAPA-2.1-GAPS.md`) |
| **P3-04** | Compras atrasadas por data no dashboard (exige agregado novo) |
| **P3-05** | `no-explicit-any`: 401 warnings de lint (dívida de tipagem, sem impacto funcional) |
| **P3-06** | `prisma validate` não roda no sandbox (limitação de ambiente; roda no CI) |
| **P3-08** | `audit()` **sem `tx`** dentro de uma transação abre a PRÓPRIA conexão (`withTransaction`) — em PostgreSQL SERIALIZABLE a segunda conexão escrevendo durante a transação do fluxo aborta a operação com **40001** ("could not serialize access … during write"). Vivido na primeira versão do provisionamento do ERP-03 (corrigido passando `tx`); são ~150 chamadas de auditoria no servidor e o padrão não é verificado por teste nem lint | recomendação: helper que exija `tx` quando há transação aberta (ou auditoria enfileirada e gravada no commit) |
| **P3-07** | `adjustInsumoStock` usa o mesmo padrão `INSERT delta ON CONFLICT DO UPDATE` para consumo (delta negativo). Hoje **não dispara** — `estoque_insumos.quantidade` não tem CHECK de não-negativo — mas se um CHECK for adicionado ali, o consumo de insumos quebra como o estorno quebrou (P0-01). Recomendação preventiva: migrar o consumo para o padrão de UPDATE condicional |

---

## 12. Backend × Frontend × Menu

### 12.1 Matriz de módulos do ERP (medida em runtime a partir de `MODULES`)

Legenda: **B** banco · **API** existe · **FE** tela própria · **M** entrada de menu · **RBAC** restrição no servidor · **T** teste automatizado · **PG** teste PostgreSQL.

| Módulo | Rota FE | Recurso API | B | API | FE | M | RBAC | T | PG | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| Meu Negócio | `/` | `/api/negocios/*` | ✅ | ✅ | ✅ | ✅ | ✅ (`vendas:read`) | ✅ | ✅ | 🟢 **ERP-04** (projeção `vendas → sales`) |
| Produtos | `/produtos` | `produtos` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | 🟢 |
| Categorias | `/categorias` | `categorias` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ⚠️ | 🟢 |
| Cores | `/cores` | `cores` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ⚠️ | 🟢 |
| Coleções | `/colecoes` | `colecoes` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | 🟢 |
| Tamanhos | `/tamanhos` | `tamanhos` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | 🟢 |
| Grades | `/grades` | `grades` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | 🟢 |
| Tabela de Medidas | `/medidas` | `/grades/:id/medidas` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | 🟢 |
| Insumos | `/insumos` | `insumos` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | 🟢 |
| **Marcas** | — | ❌ | ❌ | ❌ | ❌ | ❌ | — | ❌ | ❌ | 🔴 ausente (P2-01) |
| **Unidades** | — | ❌ | ❌ | ❌ | ❌ | ❌ | — | ❌ | ❌ | 🔴 ausente (P2-02) |
| **NCM / Tributação** | `/ncm` | `impostos_ncm` | ✅ | ✅ | ✅ | ✅ | ✅ (`minPerfil: gerente`) | ✅ | ✅ | 🟢 **ERP-05** (P1-02 fechado) |
| **Empresas** | `/empresas` | `empresas` | ✅ | ✅ | ✅ | ✅ | ✅ `adminOnly` (403 ao gerente **provado por HTTP**) | ✅ | ✅ | 🟢 **ERP-07** (P1-04 fechado; **P0-06** descoberto e fechado) |
| Vendas | `/vendas` | `vendas` | ✅ | ✅ | ✅ (`OrderPage`) | ✅ | ✅ | ✅ | ✅ | 🟢 |
| Propostas | `/propostas` | `propostas` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | 🟢 |
| PDV / Caixas | `/pdv`, `/pdv-caixas` | `pdv_caixas` + rotas | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | 🟢 |
| Clientes | `/clientes` | `clientes` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | 🟢 |
| Representantes | `/representantes` | `representantes` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ⚠️ | 🟢 |
| Listas de preço | `/listas-preco` | `listas_preco` | ✅ | ✅ | ✅ | ✅ | ⚠️ **deriva** | ✅ | ✅ | 🟡 P1-01 |
| Políticas comerciais | `/politicas-comerciais` | `politicas_comerciais` | ✅ | ✅ | ✅ | ✅ | ⚠️ **deriva** | ✅ | ✅ | 🟡 P1-01 |
| Catálogos públicos | `/catalogos` | `catalogos` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | 🟢 |
| **Comissões** | `/comissoes` | `/financeiro/comissoes` | ✅ | ✅ | ✅ | ✅ | ✅ (`gerente`) | ✅ | ✅ | 🟢 **ERP-06** (P1-05 fechado) |
| Compras | `/compras` | `compras` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | 🟢 |
| Cotações de compra | `/cotacoes-compra` | `cotacoes_compra` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | 🟢 |
| Recebimentos | `/compra-recebimentos` | `compra_recebimentos` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | 🟢 |
| Importar NF-e | `/importar-nfe-compra` | `/suprimentos/...` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | 🟢 |
| De-Para | `/depara-fornecedor` | `produto_fornecedor_skus` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | 🟢 |
| Sugestão de compra | `/sugestao-compra` | `/suprimentos/sugestao-compra` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ⚠️ | 🟢 |
| Fornecedores | `/fornecedores` | `fornecedores` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | 🟢 |
| Estoque físico | `/estoque` | `/estoques/grade` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | 🟢 |
| Movimentações | `/movimentacoes` | `movimentacoes` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | 🟢 |
| Locais | `/locais` | `locais` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | 🟢 |
| Inventário | `/inventario` | `/inventarios/*` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | 🟢 |
| **Reservas** | — | ❌ | ❌ | ❌ | ❌ | ❌ | — | ❌ | ❌ | 🔴 ausente (P1-06) |
| Fichas / BOM | `/fichas` | `fichas` | ✅ | ✅ | ✅ (`FichaDetail`) | ✅ | ✅ | ✅ | ✅ | 🟢 |
| Ordens (OP) | `/ordens` | `ordens` + subrotas | ✅ | ✅ | ✅ (`OrdemDetail`) | ✅ | ✅ | ✅ | ✅ | 🟢 (P0-01 **fechado em ERP-02**: reabrir/estornar com prova PostgreSQL) |
| Planejamento | `/planejamento-producao` | `/producao/planejamento` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | 🟢 |
| Custos | `/custo` | `/fichas/:id/aplicar-preco` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | 🟢 |
| Expedição | `/expedicao` | `/vendas/:id/expedicao/*` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | 🟢 |
| Divergências | `/divergencias` | `divergencias_conferencia` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | 🟢 |
| Envios | `/envios` | `envios` | ✅ | ✅ | ✅ | ✅ | ⚠️ **deriva** | ✅ | ✅ | 🟡 P1-01 |
| Devoluções | `/devolucoes` | `devolucoes` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | 🟢 **ERP-08** (P1-09 fechado — cadeia de reversa provada em PG) |
| Financeiro | `/financeiro` | `/financeiro/*` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | 🟢 (P0-02 **fechado em ERP-01**: webhook confirma a cobrança em PG) |
| Lançamentos | `/lancamentos` | `lancamentos_financeiros` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | 🟢 |
| Contas / Categorias / Centros / Recorrências / Transferências / Investidores / Aportes | 7 rotas | 7 recursos | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | 🟢 |
| Relatórios | `/relatorios` | `/relatorios/:nome` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | 🟡 P2-04 |
| Documentos fiscais | `/documentos-fiscais` | `documentos_fiscais` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | 🟠 P1-08 |
| Regras fiscais | `/regras-fiscais` | `regras_fiscais` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | 🟢 |
| **Inutilizações** | `/inutilizacoes` | `inutilizacoes_fiscais` | ✅ | ✅ | ✅ | ✅ | ✅ (`checkFluxo`: gerente/admin) | ✅ | ✅ | 🟢 **ERP-05** (P1-03 fechado — a rota respondia **405**) |
| Usuários | `/usuarios` | `usuarios` + 17 rotas | ✅ | ✅ | ✅ | ✅ | ✅ adminOnly | ✅ | ✅ | 🟢 |
| Auditoria | `/auditoria` | `auditoria` | ✅ | ✅ | ✅ | ✅ | ✅ adminOnly | ✅ | ✅ | 🟢 |
| Webhooks (saída) | `/webhooks` | `webhooks` | ✅ | ✅ | ✅ | ✅ | ✅ adminOnly | ✅ | ✅ | 🟢 |
| Configurações / Ajuda | `/config`, `/ajuda` | `/auth/*`, `/admin/*` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | 🟢 |

### 12.2 Tela sem backend · rota órfã · menu órfão

| Categoria | Achado | Evidência |
|---|---|---|
| **Tela sem backend** | **nenhuma** | não encontrado em 48 páginas |
| **Backend sem tela** | **nenhum** — ~~`impostos_ncm`~~, ~~`inutilizacoes_fiscais`~~ (**ERP-05**) e ~~`empresas`~~ (**ERP-07**: `/empresas`) fechados | `audit:menu` segue **0 `[RECURSO_SEM_MENU]`** (70 módulos / 13 grupos) |
| **Rota órfã** | nenhuma rota `/api/*` sem handler de recurso; as 286 registradas resolvem | `app.use('/api', …404)` ao final garante o resto |
| **Menu órfão** | nenhum: todos os 66 módulos apontam para rota existente em `App.tsx` | `npm run audit:menu` → "Sem erros: menu, rotas, recursos, permissões e escopo por empresa estão coerentes" |
| **Módulo duplicado** | nenhum | — |
| **Tela duplicada** | nenhuma | 48 páginas, 0 colisões |
| **Endpoint duplicado** | nenhum detectado | 286 rotas, sem par (método, caminho) repetido |
| **Fluxo incompleto** | 4 rupturas de cadeia | §5.2 |

---

## 13. Fluxos E2E — o que está provado e o que não está

| Fluxo exigido (§23) | Teste em memória | Teste PostgreSQL | Smoke HTTP | Veredito |
|---|---|---|---|---|
| **VENDA** Produto→Cliente→Venda→Pagamento→Estoque→Financeiro→Fiscal→Expedição→BI | parcial (`pg-p1`, `propostas`, `pdv`) | parcial (`pg/e423` até expedição+financeiro; **`bi-faturamento-e2e` fecha venda→BI**) | parcial | 🟠 **GAP parcial** — **o BI agora recebe** (ERP-04 ✅: venda faturada → KPIs = relatório, ABC); resta **Fiscal não emitido** e a cadeia nunca executada como uma única prova |
| **COMPRA** Fornecedor→Compra→XML→Recebimento→Estoque→Custo→AP→Financeiro | ✅ `compras.test.ts`, `custo-recebimento.test.ts` | ✅ `pg-compras-e32`, `pg-custo-recebimento`, `pg-cotacoes-compra` | ✅ E3.1 e E3.2 **PASS** (inclusive em PG, após semear `local`) | 🟢 **o fluxo mais bem provado do ERP** |
| **PRODUÇÃO** Produto→Ficha→OP→Consumo→Perda→Produção→Estoque→Custo | ✅ `producao-e2.test.ts` (inclui `reabrir`) | ✅ `pg-producao-e2.test.ts` + `e02-ordem-reabrir-postgresql.test.ts` (CHECK, FK, concorrência; **reabrir/estornar**) | ✅ E2 **PASS** | 🟢 **P0-01 fechado em ERP-02** — a cadeia e a reversão têm prova PostgreSQL |
| **DEVOLUÇÃO** Venda→Devolução parcial→Estoque→Financeiro→Estorno | ✅ `devolucoes` (front + `DevolucoesPage.test.tsx`) | ✅ **`pg/devolucao-e2e.test.ts`** (parcial 2/3 bom ⇒ saldo 4; avariado **não** entra; total ⇒ venda cancelada + financeiro revertido; idempotência; multiempresa 404) | ✅ (a cadeia roda por HTTP no e2e) | 🟢 **P1-09 fechado em ERP-08** — com **mutação** provando a guarda do estado |
| **EXPEDIÇÃO** Venda→Separação→Conferência→Embalagem→Expedição→Estoque | ✅ `expedicao.test.ts` | ✅ **completo** `pg/e423-expedicao-postgresql.test.ts` (E2E, rollback, concorrência, multiempresa 404) | ✅ | 🟢 **fechado com evidência** |

**Resposta direta ao §22 — "quais fluxos do ERP não conseguimos provar ponta a ponta?"**

1. **VENDA completa com Fiscal e BI**: não conseguimos provar. Faltam dois elos, e um deles (BI) está **comprovadamente quebrado**, não apenas sem teste.
2. **DEVOLUÇÃO completa**: **fechado em ERP-08** — `pg/devolucao-e2e.test.ts` prova a parcial, o item avariado fora do saldo (inclusive no estorno) e o total com reversão financeira.
3. **PRODUÇÃO com reabertura/estorno**: **fechado em ERP-02** — `e02-ordem-reabrir-postgresql.test.ts` prova reabrir/estornar em PostgreSQL.
4. **Financeiro completo com confirmação por webhook de gateway**: **fechado em ERP-01** — o webhook confirma a cobrança em PostgreSQL (P0-02).
5. **COMPRA e EXPEDIÇÃO completas**: **conseguimos provar** — são as duas cadeias maduras.

---

## 14. Multiempresa

**Veredito: 🟢 robusto, com uma lacuna de gestão (não de isolamento).**

| Mecanismo | Evidência |
|---|---|
| Coluna `empresa_id` nas tabelas de domínio | **72 colunas** (`information_schema.columns`) |
| Herança automática para tabelas filhas | **26 triggers `trg_empresa_*`** (ex.: `trg_empresa_itens_venda`, `trg_empresa_estoques`, `trg_empresa_movimentacoes`, `trg_empresa_ordens_apontamentos`) que derivam a empresa do registro-pai |
| Espelho em memória | `MemStore.herdarEmpresa` (`memdb.ts:88`) reproduz o trigger — o modo demonstração não permite filho órfão de escopo |
| Escopo aplicado no gargalo | `services.ts` (`escopoDe`, `escopoDe(currentUser(req))` em toda rota de recurso); comentário explícito: *"o recorte do ator é aplicado dentro do serviço — um `?f.empresa_id=` enviado pelo cliente é descartado lá"* |
| FKs compostas por empresa | `fk_e42_estoques_empresa_produto → produtos(empresa_id, id)`, `fk_e42_estoques_empresa_local → locais(empresa_id, id)` (medido em `pg_constraint`) |
| Índices únicos por empresa | `uq_e42_estoques_empresa_prod_tam_local_id` e mais 3 variantes parciais (medido em `pg_indexes`) |
| Provas executadas | `multiempresa.test.ts`, `multiempresa-p1.test.ts`, `auditoria-multiempresa.test.ts`, `pg-multiempresa.test.ts`, `pg-auditoria-multiempresa.test.ts`, `pg/e42-tenant.test.ts`, e o caso **B não expede/embala/conferir A → 404** em `pg/e423` |
| Troca de empresa | `GET/POST /api/empresas/ativa` + `CompanySwitcher.tsx` |

**O que falta:** o **CRUD de Empresas não tem tela** — criar/editar/desativar uma segunda empresa só é possível por API (`resources.ts:446`), e o vínculo usuário↔empresa existe por API (`/api/usuarios/:id/empresas`) com tela em `UsuariosPage`. Multiempresa é operável; a **gestão do cadastro** de empresas é que não é (P1-04).

**NÃO TESTADO:** não foi executado um teste A→B→A de troca de empresa ativa com escrita e leitura cruzada nos 12 domínios; o que existe são os testes por domínio listados acima, todos passando.

---

## 15. Banco de dados

**O schema representa fielmente o modelo operacional do ERP?** Em grande medida **sim** — e com rigor incomum: 651 `CHECK`, 289 FKs, 19 UNIQUE, 26 triggers de tenant, índices únicos parciais desenhados para o `ON CONFLICT` (e um deles, `uq_gateway_webhook_evento`, é justamente onde P0-02 estoura). **Atualização 2026-10-11: as duas divergências que produziam defeito (abaixo, #1 e #2) foram corrigidas** — #1 em **ERP-02** (`tryAdjustStock` no estorno) e #2 em **ERP-01** (`payload` é `json: 'json'` e a leitura é pelo tipo real). A #3 foi **conferida como benigna** (ver a linha).

| # | Divergência | Evidência | Efeito |
|---|---|---|---|
| 1 | `estoques.quantidade` tem `CHECK (quantidade >= 0)` e o Postgres a valida **antes** do `ON CONFLICT`; o código em `producao.ts:557` assume que o merge acontece primeiro | §6 P0-01, `ExecConstraints` no stack | 500 na reabertura de OP |
| 2 | `gateway_webhook_events.payload` é **JSONB**; o recurso o declara como `type: 'textarea'` (`gateway.ts:118`) e o código o lê com `JSON.parse(String(...))` (`gateway.ts:949`) | §6 P0-02 | Webhook descartado + vazamento de constraint |
| 3 | Tabela `estoques` tem **duas** fontes de unicidade coexistindo: `estoques_produto_id_tamanho_id_local_key UNIQUE(produto_id, tamanho_id, local)` **sem `empresa_id`** (legado) e os 4 índices parciais por empresa | `pg_indexes` | **FATO (reconferido em 2026-10-11): benigna.** `produtos.id` é único **globalmente**, e `produto_id` é a primeira coluna do índice legado — a mesma tupla (produto, tamanho, local) só pode existir para o produto daquela empresa. O índice é **redundante**, não conflitante; o A/B de ERP-03 (mesmo SKU e mesmo código de barras em duas empresas) roda com os dois índices presentes |
| 4 | Nenhuma view no banco | `information_schema.views` → 0 | Toda agregação é feita em SQL dentro do código; não há camada semântica compartilhada entre BI e relatórios — origem estrutural da duplicidade nº 1 (§7) |

**Migrations:** 32 arquivos, aplicados em ordem, sem duplicidade nem conflito (`0001`…`0032`), registrados em `schema_migrations`, com `pg_advisory_lock` e política declarada de "não editar migration antiga, criar nova" (seguida em `0032`, que substitui o CHECK de `0024` sem tocar no arquivo original). **Nada de anormal encontrado aqui** — é a parte mais disciplinada do repositório.

**Registros órfãos:** não foram encontrados nos bancos exercitados (os testes de integridade E4.2.1 cobrem isso). **NÃO TESTADO** em base de produção.

---

## 16. Segurança / RBAC

| Controle | Situação | Evidência |
|---|---|---|
| Autenticação | ✅ argon2id (`@node-rs/argon2`), JWT com TTL, senha provisória bloqueando escrita | `password.ts`, `autenticacao`, `security.ts` (`bloquearSenhaProvisoria`) |
| MFA | ✅ TOTP obrigatório para admin, códigos de recuperação, reset administrativo, alerta de "admin sem MFA" | `mfa.ts`, `mfaBackup.ts`, `totp.ts`, `usuariosAdmin.ts:353` |
| Sessões | ✅ listagem, revogação individual e em massa, limpeza periódica | `sessoes.ts`, `/api/auth/sessoes`, `/api/usuarios/:id/sessoes` |
| Política de senha | ✅ configurável e exposta em `/api/auth/politica-senha` | `politicaSenha.ts` |
| Rate limit | ✅ login (IP+e-mail) e MFA; limites registrados em auditoria | `security.ts`, `pgstore` (rate limit persistente) |
| Cabeçalhos/transporte | ✅ `securityHeaders`, `trust proxy`, CORS com allowlist, Sentry opcional | `security.ts`, `log.ts`, `index.ts` |
| **Autorização no servidor** | ✅ no gargalo (`checkAccess`, `checkFluxo`, `PERFIL_RANK = {operador:1, gerente:2, admin:3}`), **nunca confiando no front** | `services.ts:33,149,152,159` |
| Segredos em repouso | ✅ AES-256-GCM para credenciais de conector, segredos fiscais e segredo MFA, com salt distinto por domínio | `segredos.ts`, `mfa.ts`, `modules/connectors/core/crypto.service.ts` |
| Auditoria | ✅ encadeada (`auditChain.ts`), isolada por empresa, com verificação | `auditoria.test.ts`, `/api/admin/auditoria/verificar` |
| **Deriva RBAC** | 🟠 3 recursos com restrição só no menu | §6 P1-01, saída de `audit:menu` |
| **Vazamento de schema** | 🔴 endpoint público anônimo devolve `duplicate key value violates unique constraint "uq_gateway_webhook_evento"` | §6 P0-02 |
| Endpoint público de pagamento | Sem assinatura obrigatória quando não há segredo configurado (`temSegredo=false` → processa) | `gateway.ts:876-890` — **INFERÊNCIA/RISCO**: com provider configurado sem `webhook_segredo`, qualquer origem que conheça um `provider_ref` pode forjar `payment.paid` |

**NÃO TESTADO:** nenhum teste de penetração, fuzzing de entrada ou verificação de dependências (`npm audit`) foi executado nesta auditoria.

---

## 17. Estrutura de menu proposta

> **Nada foi alterado no menu.** Esta seção é proposta, conforme §17.

### 17.1 Menu atual — como está (medido)

66 módulos em 12 grupos:

| Grupo | Seção | Módulos |
|---|---|---|
| Cadastros | erp | 8 — Produtos, Categorias, Cores, Insumos, Tamanhos, Grade, Tabela de Medidas, Coleções |
| Vendas | erp | 11 — Vendas, Políticas comerciais, Clientes, Representantes, Catálogos, Regras fiscais, Documentos fiscais, Listas de preço, Propostas, Caixas do PDV, PDV |
| Compras | erp | 7 — Compras, Fornecedores, Cotação, Recebimentos, Importar NF-e, De-Para, Sugestão |
| Estoque | erp | 4 — Estoque Físico, Movimentações, Locais, Inventário |
| Produção | erp | 4 — Ficha Técnica/BOM, Cadeias de Fabricação, Planejamento, Custos |
| Logística & Expedição | erp | 4 — Expedição, Divergências, Envios, Devoluções |
| Financeiro | erp | 9 — Financeiro, Lançamentos, Categorias, Contas, Transferências, Centros de custo, Investidores, Aportes, Recorrências |
| Relatórios | erp | 1 — Relatórios |
| Integrações | **commerce** | 5 — Mercado Livre, Mercado Pago, Nuvemshop, Instagram Shopping, Webhooks |
| Gestão de Commerce | **commerce** | 4 — Produtos, Pedidos, Trends, Delivery (**todos `planned`**) |
| Ecossistema Creators | **commerce** | 4 — Creators, Matches, Outreach AI, Campanhas (**todos `planned`**) |
| Configurações | sistema | 4 — Usuários, Auditoria, Configurações, Ajuda |

**Problemas objetivos do menu atual:**
1. **8 dos 66 módulos são `planned`** — telas de prontidão sem domínio. Todos em Commerce/Creators (congelados por decisão de arquitetura).
2. **Fiscal está espalhado**: "Regras fiscais" e "Documentos fiscais" moram dentro do grupo **Vendas**; NCM e Inutilizações não têm entrada nenhuma.
*(Atualização 2026-10-11: o menu medido hoje tem **70 módulos em 13 grupos** — o grupo **Fiscal** nasceu no ERP-05, **Comissões** entrou em Financeiro no ERP-06 e **Empresas** entrou em Configurações no ERP-07.)*

3. **`Webhooks` (saída, adminOnly) está em "Integrações"** junto com conectores de Commerce, misturando um recurso administrativo do ERP com integração de marketplace.
4. **Sem grupo "Fiscal"**, sem "Administração" (o grupo se chama "Configurações" e mistura Usuários/Auditoria com Configurações pessoais e Ajuda).
5. Cadastros compartilhados aparecem em grupos operacionais (`Clientes`/`Representantes` em Vendas, `Fornecedores` em Compras). É decisão defensável de navegação — **não duplicar**.

### 17.2 Funcionalidades existentes que o menu não expõe

| Funcionalidade | Backend | Tela | Menu |
|---|---|---|---|
| ~~NCM / Tributação (`impostos_ncm`)~~ | ✅ | ✅ | ✅ **ERP-05** |
| ~~Inutilização de numeração~~ | ✅ | ✅ | ✅ **ERP-05** |
| ~~Empresas (CRUD)~~ | ✅ | ✅ | ✅ **ERP-07** |
| ~~Comissões (apuração, efetivação, estorno)~~ | ✅ | ✅ | ✅ **ERP-06** |

*(Nada mais nesta lista: toda funcionalidade de backend do ERP tem tela **e** entrada de menu.)*

### 17.3 Funcionalidades que faltam (menu não resolve)

Reserva de estoque · disponível × comprometido · cadastro de Marcas · cadastro de Unidades · BI lendo a operação real · homologação fiscal · telas de devolução com prova E2E.

### 17.4 MENU ERP FINAL PROPOSTO

> **Implementado no ERP-05 (2026-10-11):** o **grupo 9 (Fiscal)** e os dois itens novos dele —
> **NCM / Tributação** (`/ncm`) e **Inutilizações** (`/inutilizacoes`) — existem hoje no menu real, e os
> quatro itens fiscais saíram de dentro de *Vendas*. **Também já implementados:** ~~Comissões~~ (**ERP-06**,
> grupo Financeiro) e ~~Empresas~~ (**ERP-07**, grupo Configurações — a entrada vive no grupo atual, **sem**
> renomeá-lo para "Administração"). **O restante desta proposta continua NÃO implementado:**
> Marcas, Unidades, Reservas, Cobranças/Gateway, Conciliação, Importar XML e o renomeio
> `Configurações → Administração`. As contagens atuais (70 módulos / 13 grupos) estão no
> [`docs/ERP-CORE-ROADMAP.md`](ERP-CORE-ROADMAP.md) §5.

```
1. Meu Negócio                      (raiz — passa a ler a operação real do ERP)
2. Cadastros
     Produtos · Categorias · Cores · Marcas(novo) · Coleções · Tamanhos · Grades ·
     Tabela de Medidas · Insumos · Unidades(novo) · Clientes · Fornecedores ·
     Representantes · Locais de Estoque
3. Vendas
     Vendas · Propostas · PDV · Caixas do PDV · Listas de Preço ·
     Políticas Comerciais · Catálogos
4. Compras
     Compras · Cotações · Recebimentos · Importar NF-e · De-Para · Sugestão de Compra
5. Estoque
     Posição de Estoque · Movimentações · Inventário · Reservas(novo) · Locais
6. Produção
     Fichas Técnicas / BOM · Ordens de Produção · Planejamento · Custos
7. Logística & Expedição
     Expedição · Divergências · Envios · Devoluções
8. Financeiro
     Painel · Lançamentos · Contas · Categorias · Centros de Custo · Transferências ·
     Recorrências · Comissões(novo) · Cobranças / Gateway(novo) · Conciliação e Extrato(novo) ·
     Investidores · Aportes
9. Fiscal(novo grupo)
     Documentos Fiscais · Regras Fiscais · Configuração Fiscal · NCM / Tributação(novo) ·
     Inutilizações(novo) · Importar XML
10. Relatórios
11. Administração(renomeado de "Configurações")
     Usuários · Empresas(novo) · Auditoria · Webhooks(saída) · Configurações · Ajuda
─────────────────────────────────────────────────────────────────────────
CONGELADO — não navegar até o ERP CORE fechar:
     Integrações · Gestão de Commerce · Ecossistema Creators
```

**Diferenças em relação ao menu atual:** cria o grupo **Fiscal** (tirando Fiscal de Vendas), renomeia **Configurações → Administração** e move **Webhooks** para lá, cria o grupo **Estoque** como catálogo de posição (hoje "Estoque Físico" fica ambíguo com "Movimentações"), e acrescenta **Comissões**, **Cobranças/Gateway**, **Conciliação**, **NCM**, **Inutilizações**, **Empresas**, **Reservas**, **Marcas** e **Unidades**. **Nenhum item do ERP atual é removido.**

---

## 18. Dependências

### 18.1 Cadeia de dados alvo (§30) — o que atravessa e o que não atravessa

```
CADASTROS ──✅──> COMPRAS ──✅──> ESTOQUE ──✅──> PRODUÇÃO ──✅──> VENDAS
                                                                     │
                                        ┌────────────────────────────┼────────────────────┐
                                        │                            │                    │
                                     ✅ FINANCEIRO              ⚠️ FISCAL            🔴 BI
                                  (lançamentos, DRE,        (arquitetura pronta,    (lê sales,
                                   comissões)               nada homologado)        não vendas)
                                        │
                                     ✅ LOGÍSTICA
```

O elo que **não** atravessa é **VENDAS → BI**. O elo **VENDAS → FISCAL** existe no código (`documentos_fiscais` criado, eventos, cancelamento) mas nunca emitiu um documento real.

### 18.2 Árvore de dependências dos gaps

```
P0-02 (webhook/gateway)
   └─> Financeiro: confirmação automática de cobrança
          └─> DRE / conciliação / comissões sobre recebimento
          └─> P1-08 (Fiscal: baixa por pagamento confirmado)

P0-01 (estorno OP)
   └─> Produção: reabrir / cancelar
          └─> Estoque: credibilidade do estorno em geral
          └─> P1-10 (mensagem correta de estado terminal)

P0-03 (BI)
   └─> P1-07 (fonte única do faturamento)
          ├─> Meu Negócio: faturamento, ticket, CMV, margem, ABC, canais
          ├─> Relatórios de faturamento
          ├─> Comissões sobre receita realizada
          └─> Fiscal: base para apuração

P0-04 (E2E em PostgreSQL)
   └─> gate de aceite de TODOS os ciclos seguintes
   └─> P1-09 (devolução E2E)
   └─> onboarding: local padrão na primeira instalação

P1-02 (NCM sem tela) ──┐
P1-03 (inutilização) ──┼─> P1-08 (homologação fiscal real)
regras fiscais ────────┘

P1-04 (Empresas sem tela) ──> operação real multiempresa
P1-06 (reserva) ──> venda multi-canal ──> sincronização de estoque (FUTURO/Commerce)
```

### 18.3 Ordem de correção determinada pelas dependências

1. **P0-04** primeiro? **Não.** É o *gate*, e o gate precisa de casos de teste que só existirão depois. A ordem correta é: **P0-01 e P0-02** (defeitos com causa-raiz isolada, correção cirúrgica), **ao mesmo tempo** em que se torna o smoke executável em PostgreSQL (**P0-04**), porque é ele que vai **provar** as duas correções. Depois **P0-03**, que exige decisão de arquitetura antes de código.

---

## 19. ERP CORE

### 🟢 Declaração

> O **BROBOND ERP CORE** estará completo quando as **9 cadeias abaixo** atravessarem o sistema com **prova executada em PostgreSQL real** — sem exceção, sem elo em memória, formando **um** sistema operacional e não módulos isolados — e quando **nenhum** dos 4 gaps P0 permanecer aberto.

| # | Cadeia do CORE | Critério de pronto |
|---|---|---|
| 1 | **Cadastro → Estoque → Venda → Financeiro** | Venda faturada baixa estoque **uma vez**, gera lançamento e aparece no relatório **e** no BI com o mesmo valor |
| 2 | **Compra → Estoque → Custo → AP → Financeiro** | ✅ **já pronto** (smoke E3.1/E3.2 em PostgreSQL + `pg-compras-e32`) |
| 3 | **Produção → Estoque → Custo** | OP planeja, libera, aponta (com perda), conclui, **reabre** e estorna — tudo em PostgreSQL, sem 500 |
| 4 | **Venda → Expedição → Estoque** | ✅ **já pronto** (`pg/e423`) |
| 5 | **Venda → Devolução → Estoque → Financeiro** | Devolução parcial com retorno de estoque, lançamento e estorno, provados ponta a ponta em PostgreSQL |
| 6 | **Pagamento → Recebimento → Conciliação** | Webhook confirma cobrança **uma vez**; repetição é idempotente e responde 200/duplicado; extrato concilia |
| 7 | **Venda → Fiscal (documento)** | Documento emitido, armazenado, consultável e cancelável — com provedor homologado, **não** simulação |
| 8 | **Multiempresa** | Nenhum dado homônimo vaza entre A e B em nenhum dos 12 domínios, com teste A/B em PostgreSQL |
| 9 | **RBAC** | Nenhuma operação crítica depende do front: menu, API e serviço coerentes (`audit:menu` sem `RBAC_DERIVA_SOLTA`) |

**ERP CORE = cadeias 1 a 9 sem nenhum P0/P1 aberto.**

**Atualização 2026-10-11 (depois de ERP-01 → ERP-08): nenhum P0 aberto** — P0-01 e P0-02 (ERP-01/02), P0-03 (ERP-04), P0-04 e P0-05 (ERP-03), P0-06 (ERP-07, descoberto na execução) estão todos fechados com prova em PostgreSQL. Estado das cadeias:

| # | Cadeia | Estado em 2026-10-11 |
|---|---|---|
| 1 | Cadastro → Estoque → Venda → Financeiro | 🟢 **provas encadeadas**: baixa única (`pg/e423`), conta a receber (`pg/comissoes-e2e`), **BI = relatório** no mesmo período (`bi-faturamento-e2e`) — falta a cadeia inteira numa única execução (candidata a teste de fechamento) |
| 2 | Compra → Estoque → Custo → AP → Financeiro | ✅ **pronta** (smoke E3.1/E3.2 em PG + `pg-compras-e32`) |
| 3 | Produção → Estoque → Custo | ✅ **fechada em ERP-02** — planejar/liberar/apontar/concluir/**reabrir/estornar** em PG (`e02-ordem-reabrir-postgresql`) |
| 4 | Venda → Expedição → Estoque | ✅ **pronta** (`pg/e423`) |
| 5 | Venda → Devolução → Estoque → Financeiro | ✅ **fechada em ERP-08** — parcial/avariado/total, com o avariado **fora** do saldo inclusive no estorno (`pg/devolucao-e2e`) |
| 6 | Pagamento → Recebimento → Conciliação | 🟡 **webhook provado em ERP-01** (confirma uma vez; repetição idempotente); **conciliação/extrato sem prova PG dedicada** |
| 7 | Venda → Fiscal (documento) | 🔴 **pendente** (ERP-12): nada emitido com provedor homologado; **não há nem evento/nota de devolução** |
| 8 | Multiempresa | 🟡 **isolamento provado** (`e03-multiempresa-ab`, guardas do ERP-07, 404 no e2e de devolução); **P1-11 aberto** (assinatura de webhook global por provedor) |
| 9 | RBAC | 🟠 **P1-01 aberto** (3 recursos com deriva menu × servidor) — ciclo **ERP-10**; `empresas` deixou de ser ponto cego em ERP-07 |

**Leitura honesta:** o CORE está a **dois ciclos de prova** (ERP-09 reserva é funcionalidade nova; ERP-10 fecha RBAC; ERP-12 é homologação externa) — e a cadeia 1 merece um teste único de ponta a ponta antes do gate final.

### ERP ADVANCED (importante, depois do CORE)

Reserva e disponibilidade de estoque · cadastro de Marcas e Unidades · telas de NCM/Inutilização/Empresas/Comissões · DRE por centro de custo com rateio · CNAB de retorno com baixa em lote · devolução com nota de devolução · planejamento de produção com capacidade · relatórios completos no front.

### FUTURO (não impede operar)

Responsividade/acessibilidade · breadcrumbs e atalhos de cadeia · série diária de faturamento · predição de demanda com histórico real · painel antifraude · otimização de índice e cache de BI.

---

## 20. Roadmap ERP-01 → ERP-N

> O roadmap completo, ciclo a ciclo, com banco/backend/frontend/testes e critérios de aceite, está em **[`docs/ERP-CORE-ROADMAP.md`](ERP-CORE-ROADMAP.md)** — documento irmão deste relatório. Resumo da sequência:

| Ciclo | Objetivo | Gaps fechados |
|---|---|---|
| **ERP-01** | Confirmação de pagamento volta a funcionar em PostgreSQL | P0-02 |
| **ERP-02** | Estorno/reabertura de OP em PostgreSQL + erros de negócio traduzidos | P0-01, P1-10 |
| **ERP-03** | Suíte E2E executável em PostgreSQL (gate de todos os ciclos seguintes) | P0-04 |
| **ERP-04** | Fonte única do faturamento: ERP alimenta o BI | P0-03, P1-07 |
| **ERP-05** | Fiscal operacional: NCM, inutilização, configuração, regras | P1-02, P1-03 |
| **ERP-06** | Comissões: tela, menu e fechamento | P1-05 → **✅ implementado em 2026-10-11** |
| **ERP-07** | Administração: CRUD de Empresas (+ P0-06) | P1-04, P0-06 → **✅ implementado em 2026-10-11** |
| **ERP-07** | Administração: CRUD de Empresas | P1-04 · **P0-06 (descoberto no ciclo)** → **✅ implementado em 2026-10-11** |
| **ERP-08** | Devolução ponta a ponta em PostgreSQL | P1-09 → **✅ implementado em 2026-10-11** |
| **ERP-09** | Reserva / disponível × comprometido | P1-06 |
| **ERP-10** | RBAC sem deriva e auditoria de menu ampliada | P1-01, P2-05 |
| **ERP-11** | Cadastros faltantes (Marcas, Unidades) e telas de relatório | P2-01, P2-02, P2-04 |
| **ERP-12** | Homologação fiscal real | P1-08 |
| **ERP-13** | Auditoria independente + gate de fechamento do CORE | — |

---

## 21. O que fica congelado

Por decisão de arquitetura (§2 e §29), **nada disto entra no roadmap do ERP CORE** — fica em **FUTURO — APÓS ERP CORE**:

* **Commerce:** WooCommerce (`server/src/loja.ts`, 688 linhas), catálogo externo e publicação, mercado livre, Nuvemshop, Instagram Shopping, marketplace (`server/src/marketplace.ts`), motor de conectores (`modules/connectors`, **6.600 linhas**), Commerce Inbox, ingestão e sincronização de pedidos, `server/src/connectors.ts` (419 linhas), `server/src/webhooks.ts` (495 linhas, webhooks de saída).
* **Ecossistema Creators:** os 4 módulos `planned` (Creators, Matches, Outreach AI, Campanhas) — nenhum tem domínio.
* **Integrações externas:** gateways de pagamento externos em produção, transportadoras, OAuth de terceiros, homologação com SEFAZ por terceiro, credenciais de Cloudinary/SMTP/Sentry.
* **Regra de fronteira:** código de Commerce só entra na fila do ERP se **impedir** a conclusão de um item do CORE. Hoje, **nenhum impede** — a única zona de contato real é o **bug P0-02** (tabela `gateway_webhook_events`, que existe no ERP e também serve cobranças de Commerce), e ele se resolve inteiramente dentro do ERP.
* **Atenção de fronteira (registro):** `negocios.ts` — o motor de BI — está hoje alimentado pela tabela `sales`, que é **tabela de Commerce**. Isso não torna o BI "Commerce": o módulo é do ERP e o defeito (P0-03) é do ERP. Mas é o ponto exato onde a fronteira ERP/Commerce precisa ser redesenhada, e é por isso que **P0-03 é o item mais sensível do roadmap inteiro**.

---

## 22. Riscos

| # | Risco | Probabilidade | Impacto | Mitigação proposta |
|---|---|---|---|---|
| R1 | **Corrigir P0-01/P0-02 e nada mais** — os defeitos voltam em outra superfície porque a classe de erro (tipo schema×código) não está tratada | Alta | Alto | Acrescentar em ERP-03 um teste de contrato **tipo de coluna × expectativa do código** para os campos `jsonb`/`numeric`, na linha do teste que já existe ("todo campo não-virtual de `resources.ts` existe em `db/schema.sql`") |
| R2 | **P0-03 virar refatoração de `negocios.ts`** — proibido pelo escopo e alto risco de regressão | Média | Alto | Mudar apenas a **origem dos dados**; manter o motor e seus testes; decidir a fonte única por escrito antes de tocar em código |
| R3 | **Dois números para "faturamento" conviverem em produção** (BI e Financeiro) | Alta | Alto | ERP-04 como ciclo único com critério de aceite de **igualdade numérica** entre `GET /api/negocios/resumo` e `GET /api/relatorios/faturamento` para o mesmo período |
| R4 | **Confiar no verde do CI como prova de operação** — foi exatamente o que escondeu P0-01 e P0-02 (110/110 e 126/126 com funcionalidade quebrada) | Alta | Alto | ERP-03 é pré-requisito declarado de todos os ciclos seguintes; nenhum ciclo fecha sem prova em PostgreSQL |
| R5 | **Fiscal virar "pronto" por existir adapter** | Média | Alto | Regra explícita: adapter ≠ homologação. Só fecha com **XML autorizado por SEFAZ** arquivado e recuperável (ERP-12) |
| R6 | **Multiempresa:** índice legado `UNIQUE(produto_id, tamanho_id, local)` sem `empresa_id` | Baixa (não comprovado) | Alto | Teste A/B com mesmo produto e mesmo nome de local em duas empresas — **NÃO TESTADO** hoje |
| R7 | **Crescimento do congelado:** 6.600 linhas de conectores e 8 módulos planejados continuarem a puxar manutenção durante o CORE | Média | Médio | Congelamento explícito no §21; não corrigir nada em Commerce |
| R8 | **`MemStore` continuar sendo o ambiente de prova de qualquer coisa** | Média | Médio | Declarar o modo demonstração como **não-produtivo e não-probatório** na documentação de operação |

---

## 23. Conclusão

O BROBOND ERP é **muito maior e mais disciplinado** do que o esperado para o estágio: 97 tabelas, 32 migrations sem conflito, 651 CHECK, 289 FKs, 26 triggers de tenant, 286 rotas, 83 recursos, 1.100+ testes verdes (671 no servidor, 226 no front, 110 em PostgreSQL real), 401 avisos de lint e **zero** erros — e um histórico de auditoria que **já registrou honestamente** os próprios gaps em `docs/ERP-GAPS.md`, com a regra correta: *"um gap só sai desta lista quando houver evidência executada"*.

Onde este relatório chega a um resultado diferente do estado declarado é **exatamente na aplicação dessa regra**:

1. **Duas funcionalidades centrais estão quebradas em PostgreSQL** e ninguém sabia: a reabertura/estorno de OP (P0-01) e a confirmação de pagamento por webhook (P0-02). Ambas provadas com SQLSTATE capturado e causa-raiz isolada em uma linha de código cada. Ambas invisíveis porque **o modo demonstração não tem as constraints do banco** e porque **a suíte E2E obrigatória nunca rodou contra PostgreSQL** (P0-04).
2. **O painel principal do produto está desconectado da operação**: uma venda faturada de R$ 200,00 pelo ERP não move um único número do Meu Negócio (P0-03) — comprovado executando a venda e lendo os KPIs em seguida.
3. **A cadeia do §30 tem um elo rompido** (VENDAS → BI) e um elo não provado (VENDAS → FISCAL). Compra e Expedição são as duas cadeias maduras; são, não por acaso, as duas que têm prova E2E em PostgreSQL.

Nada disso invalida o que foi construído: o ERP está **mais perto** do fim do que o tamanho deste relatório sugere. Dos 9 critérios do ERP CORE, **2 estão fechados**, **3 têm defeito de uma linha de correção** e **4 dependem de decisão (BI) ou de execução de teste (devolução, homologação fiscal, RBAC)**. Os 13 ciclos do roadmap foram ordenados por dependência arquitetural, não por facilidade — e o ciclo **ERP-03** (tornar o gate executável em PostgreSQL) é declaradamente pré-requisito dos outros doze, porque foi a ausência dele que produziu este relatório.

**Veredito do agente (não há aprovação ou reprovação de merge nesta etapa):**

# 🟡 ERP ROADMAP DEFINIDO COM RESSALVAS

**Motivo objetivo:** o roadmap está completo, ordenado por dependência e com critérios de aceite verificáveis para todos os ciclos — mas **não é seguro iniciar a implementação antes de duas condições**, ambas de escopo pequeno e mensurável:

1. **Os 4 gaps P0 precisam ser reconhecidos como bloqueadores.** Dois deles (P0-01 e P0-02) não são "funcionalidade faltando": são **funcionalidade quebrada em produção com PostgreSQL**, provadas nesta auditoria, e que o estado declarado do repositório (110/110 e 126/126 verdes) apresenta como saudável. Um roadmap que trate o ERP como "faltando telas" começaria pela prioridade errada.
2. **Nenhum ciclo pode fechar sem prova em PostgreSQL real.** Enquanto a única suíte E2E do repositório estiver restrita ao modo demonstração, todo ciclo seguinte herdará o mesmo ponto cego que escondeu estes dois defeitos.

Fechadas essas duas condições — que são precisamente o escopo de **ERP-01, ERP-02 e ERP-03** — o roadmap deixa de ter ressalva.

**NÃO IMPLEMENTADO. NÃO CORRIGIDO. NÃO MERGEADO. COMMERCE NÃO TOCADO.**

---

### Anexo A — Prova de execução (ambiente desta auditoria)

```
PostgreSQL 18.4 (embedded-postgres, binários @embedded-postgres/linux-x64)
  127.0.0.1:55432 · user brobond · bases: brobond_teste, brobond_smoke, brobond_smoke3

npm install                                  → 959 pacotes, ok
npm run typecheck                            → verde (domain + server + client)
npm --workspace server test                  → 734 testes · 671 pass · 0 fail · 63 skip
npm --workspace client test                  → 22 arquivos · 226 pass
npm run test:pg  (DATABASE_URL=brobond_teste) → 110 testes · 110 pass · 0 fail · 0 skip
npm run lint                                 → 0 erros · 401 warnings
npm run build                                → verde · 319 kB principal · PWA 55 precache
npm run audit:menu                           → 0 erros · 6 avisos
npm run smoke  (demo, :3002)                 → 126/126
npm run smoke  (PG novo, :3001)              → 92/117   (25 × 409 "sem local de estoque ativo")
npm run smoke  (PG + local semeado)          → 119/126  (7 falhas reais → P0-01, P0-02 e 2 efeitos)
node --import tsx /tmp/repro500.mts          → SQLSTATE 23514 em PgStore.adjustStock ← producao.ts:557
node /tmp/pgboot/webhook-repro.mjs           → wh2 = 202 {"erro":"duplicate key … uq_gateway_webhook_evento"}
node /tmp/pgboot/bi-repro.mjs                → venda faturada R$200 → BI faturamentoCents = 0
```

### Anexo B — Arquivos lidos nesta auditoria (amostra representativa)

`server/src/index.ts` (286 rotas) · `server/src/resources.ts` (83 recursos) · `server/src/services.ts` (RBAC, escopo, `updateRecord`) · `server/src/pgstore.ts` (`adjustStock`, `tryAdjustStock`, `translatePgError`) · `server/src/memdb.ts` · `server/src/producao.ts` (`TRANSICOES_OP`, `estornarOrdem`, `reabrirOrdem`) · `server/src/gateway.ts` (webhook público) · `server/src/negocios.ts` (motor de BI) · `server/src/financeiro.ts` · `server/src/estoque.ts` · `server/src/expedicao.ts` · `server/src/fiscalProvider.ts` · `server/src/nfe.ts` · `server/src/log.ts` · `server/src/db.ts` · `server/src/store.ts` · `server/src/segredos.ts` · `server/src/mfa.ts` · `db/schema.sql` · `db/migrations/0001…0032` · `client/src/modules.ts` · `client/src/components/CompanySwitcher.tsx` · `client/src/pages/*` · `scripts/smoke-e2e.mjs` · `scripts/auditar-menu.ts` · `.github/workflows/ci.yml` · `docs/ERP-GAPS.md` · `docs/ERP-MASTER-MAP.md` · `server/test/**` · `modules/connectors/**`.
