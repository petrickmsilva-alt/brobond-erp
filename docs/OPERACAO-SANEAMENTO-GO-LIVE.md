# Operação — saneamento pré-go-live (dados de homologação)

Rotina controlada para neutralizar os dados **fictícios** de homologação antes da
primeira operação oficial, preservando o **estoque físico real**.

> Esta rotina é um **ato operacional** sobre um banco. Ela é distinta do código:
> o código entrega a ferramenta e as provas; a execução no banco publicado é um
> passo separado, registrado em §"Registro da execução".

## O que é preservado (nunca tocado)

- `estoques` — a posição física por SKU × variante × local (a única posição
  operacional real).
- Cadastros: `produtos`, `tamanhos`, `cores`, `colecoes`, `empresas`, `usuarios`,
  permissões.
- Estrutura financeira: `plano_contas`, `contas_financeiras`, `centros_custo`,
  `categorias`.
- Preços de varejo e atacado (`produtos.preco_venda`, `produtos.preco_atacado`).

Nenhuma constraint, trigger ou mecanismo de auditoria é desabilitado. A limpeza
roda numa **única transação**: ou limpa tudo, ou não limpa nada. A posição de
estoque é lida **dentro da transação**, com trava (`FOR UPDATE`) em `estoques` e
`estoque_reservas`, e a comparação antes/depois cobre **quantidade física, custo
unitário e valorização** (não só a quantidade). Duas execuções concorrentes são
serializadas por um advisory lock transacional (`pg_advisory_xact_lock`).

## Cobertura de chaves estrangeiras (aborta antes de apagar)

`server/src/ops/saneamento-cobertura.ts` lê o grafo REAL de FKs do PostgreSQL e
classifica cada aresta que aponta para uma tabela do plano: `LIMPA` (filho é
apagado antes), `DESVINCULA` (coluna zerada por um desvínculo guardado),
`CASCATA`/`SET_NULL` (o banco resolve) ou **`BLOQUEIO`** (NO ACTION/RESTRICT sem
cobertura). Se existir **qualquer** bloqueio, o saneamento aborta **antes do
primeiro DELETE** — jamais se desabilita uma constraint para "fazer passar".

## O que é removido (dados de teste transacionais)

- Vendas: `vendas`, `itens_venda`, `sales`, `sale_items` e satélites (devoluções,
  documentos fiscais nunca transmitidos, histórico de status, atribuição).
- Financeiro: `lancamentos_financeiros`, `gateway_cobrancas`,
  `fin_extrato_transacoes`, comissões/afiliados, transferências financeiras.
- Estoque derivado do teste: movimentações originadas por venda/transferência/
  inventário de teste, `estoque_reservas` (reservas artificiais).
- Commerce/integrações: `commerce_pedidos`, `commerce_outbox` (fila),
  `commerce_reconciliacao`, inbox de webhooks, `connector_events`.
- Pagamentos: `payment_*`, `gateway_webhook_events`.

A lista exata e a ordem de exclusão vivem em `server/src/ops/saneamento.ts`
(`PLANO`, ordem topológica do grafo de FKs; `DESVINCULOS` para as FKs NO ACTION).

## Antes de executar (Fase Zero — bloqueio obrigatório)

1. Identificar o banco/ambiente efetivamente usados pelo ERP publicado.
2. Gerar **backup recuperável** e comprovar integridade, data/hora, tamanho e
   restauração. O dump **não** entra no repositório Git.
3. Produzir a **fotografia do estoque** (o próprio `--dry-run` já imprime a
   fotografia ANTES: empresa, produto, SKU, variante, local, quantidade física,
   reservada, disponível, custo unitário e valor total).

Se não houver backup recuperável nem fotografia, **não executar**.

### O que conta como backup "recuperável" (tamanho NÃO basta)

O script **não** aceita a mera existência/tamanho do arquivo. No modo
`--executar` ele:

1. gera o dump com `pg_dump -Fc` (se não houver manifesto) e grava um manifesto
   com `sha256`, tamanho, identificação da origem (host/porta/banco, sem
   credenciais) e a **contagem por tabela** na origem;
2. confere a integridade: o `sha256` do arquivo bate com o manifesto **e** o
   catálogo interno abre (`pg_restore --list` lista as tabelas do manifesto);
3. **restaura** o dump num banco DESCARTÁVEL vazio (`pg_restore`) e compara a
   contagem de cada tabela entre origem e restaurado;
4. só prossegue se todas as tabelas baterem; o banco descartável é removido no
   fim (sucesso ou falha).

Qualquer divergência (arquivo mudou, catálogo ilegível, contagem diferente)
**aborta** a execução com "BACKUP NÃO RECUPERÁVEL".

## Execução

```bash
# 1) Conferência (não altera nada; transação com ROLLBACK):
DATABASE_URL=... npm exec -- node --import tsx scripts/saneamento-go-live.ts --empresas=1

# 2) Execução real (exige backup verificado + confirmação textual):
DATABASE_URL=... node --import tsx scripts/saneamento-go-live.ts \
  --empresas=1 --executar --confirm=LIMPAR-HOMOLOGACAO \
  --backup=/caminho/fora-do-repo/backup.dump \
  --manifesto=/caminho/fora-do-repo/backup.dump.manifesto.json \
  --ator="Diretor"
```

- `--empresas` é **obrigatório**: o saneamento nunca é global por omissão.
- `--executar` exige `--confirm=LIMPAR-HOMOLOGACAO` **e** `--backup` com
  restauração verificada. Sem isso, a rotina recusa.
- Se `--manifesto` não existir, o script gera o dump e o manifesto na hora.
- O dry-run prova que o plano aplica limpo (sem bloqueio de FK) sem alterar um
  único byte, e imprime o **relatório por SKU** (células, peças, custo, valor).

### Runbook no banco publicado (Render)

O banco publicado é alcançável pela `DATABASE_URL` configurada no painel da
Render (a variável **não** está no repositório — é `sync:false`). Como a
credencial não é versionada, o operador executa o runbook **no próprio ambiente
que já tem a variável** (o host Render, um shell autenticado, ou o sandbox com a
variável exportada). Nunca cole a URL em commit, issue ou log.

```bash
# 0) A variável já precisa estar no ambiente (Render panel → Environment).
#    NUNCA imprima a URL. O script já mostra só host:porta/banco.
test -n "$DATABASE_URL" && echo "DATABASE_URL presente (não exibida)"

# 1) Conferência (ROLLBACK — não altera nada). Imprime a fotografia do estoque.
node --import tsx scripts/saneamento-go-live.ts --empresas=1

# 2) Backup recuperável FORA do repositório (gera dump + manifesto):
mkdir -p /var/backups/brobond
pg_dump -Fc --no-owner --no-privileges \
  -f /var/backups/brobond/brobond_$(date +%Y%m%d_%H%M%S).dump "$DATABASE_URL"

# 3) Execução real (revalida o backup por restauração antes de apagar):
node --import tsx scripts/saneamento-go-live.ts \
  --empresas=1 --executar --confirm=LIMPAR-HOMOLOGACAO \
  --backup=/var/backups/brobond/<arquivo>.dump \
  --ator="Diretor"
```

- Se a etapa 3 abortar com **BACKUP NÃO RECUPERÁVEL**, nada é apagado — repetir
  a etapa 2 e conferir o cliente `pg_dump`/`pg_restore` da MESMA versão maior do
  servidor (16).
- Enquanto a `DATABASE_URL` de produção não estiver no ambiente, a etapa 1 já
  falha com `Saneamento exige DATABASE_URL PostgreSQL.` — nenhum passo destrutivo
  roda sem credencial.

### Carga cadastral no banco publicado (após o saneamento)

A carga passa pela API autenticada (RBAC de gestor em `produtos.create`):

```bash
# preview (não grava): { conteudo: <base64 do .xlsx>, nome: "..." }
curl -sS -X POST "$APP/api/carga/politica-comercial/preview" \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d "{\"conteudo\":\"$B64\",\"nome\":\"TABELA DE PREÇO BASE PARA ERP.xlsx\"}"

# confirmar (grava produtos-pai + variações + preços por condição; idempotente)
curl -sS -X POST "$APP/api/carga/politica-comercial/confirmar" \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d "{\"conteudo\":\"$B64\",\"nome\":\"TABELA DE PREÇO BASE PARA ERP.xlsx\"}"
```

Conferência obrigatória no banco (não basta HTTP 200):

```sql
SELECT count(*) FILTER (WHERE produto_pai_id IS NULL) AS pais,
       count(*) FILTER (WHERE produto_pai_id IS NOT NULL) AS variacoes,
       count(*) FILTER (WHERE codigo_industria <> '') AS codigos_industria
  FROM produtos;
SELECT count(*) FROM produto_precos_condicao;     -- preços oficiais vigentes
SELECT coalesce(sum(quantidade),0) FROM estoques; -- deve permanecer ZERO
```

## Depois de executar (Fase Quatro — critério obrigatório)

O script compara a fotografia ANTES e DEPOIS célula a célula (SKU × variante ×
local) em **três dimensões** (quantidade física, custo unitário e valorização) e
**aborta** se qualquer uma divergir. Nenhuma perda, duplicação ou alteração
inexplicada de estoque é aceita. Ao final imprime o **relatório por SKU** com a
posição física final.

Validações esperadas após a execução:

- total de peças físicas idêntico antes/depois;
- reservas de teste removidas (disponível volta a ser o físico);
- custo unitário e valorização preservados;
- vendas, pedidos, itens e eventos de teste zerados;
- fila sem evento executável e sem indeterminado não resolvido;
- cadastros e estrutura financeira intactos.

Se houver diferença, **interromper a homologação e investigar** antes de
prosseguir.

## Registro da execução (preencher ao executar no banco publicado)

### Fase Zero — pré-checagem (2026-11-11)

| Campo | Valor |
|---|---|
| Ambiente publicado | `https://brobond-erp.onrender.com` — alcançável (`/api/health` → `200`, `banco: conectado`, `version: 0.6.0`) |
| Código publicado | **Anterior à descontinuação**: `/loja` → `200` e `/api/loja/config` → `200`. O deploy da branch `operations/pre-go-live-data-sanitization` **não** foi feito (exige autorização do Diretor). |
| Migration 0115 no repositório | **presente** (`db/migrations/0115_fase9_5_fiscal_layouts.sql`) |
| Migration 0115 aplicada no banco publicado | **não verificável** — sem credencial |
| `DATABASE_URL` do banco publicado | **AUSENTE** no ambiente de execução (`render.yaml` traz a seção `databases` comentada; nenhuma variável de conexão exposta) |
| Backup recuperável do banco publicado | **BLOQUEADO** — sem credencial de conexão não há `pg_dump` nem verificação de restauração |
| Fotografia do estoque real | **BLOQUEADO** — exige conexão ao banco publicado |

### Bloqueio operacional identificado

O saneamento no banco publicado **não foi executado**. Motivo único e preciso:

> Não há credencial (`DATABASE_URL`) de conexão ao banco PostgreSQL publicado
> disponível neste ambiente. Sem ela não é possível (a) gerar o backup
> recuperável obrigatório da Fase Zero, (b) obter a fotografia do estoque real,
> nem (c) executar a limpeza transacional com comparação antes/depois.

Conforme §14 da ordem executiva, **não** foram contornados controles de acesso
nem simulada execução em produção. A entrega de código, testes e documentação
está completa; falta apenas a execução operacional, que exige a credencial do
banco publicado e a autorização expressa do Diretor.

**Desbloqueio necessário:** fornecer a `DATABASE_URL` do banco publicado (banco
vazio **não** é exigido aqui; é o banco de produção) — ou executar o runbook no
próprio host Render — e autorizar o passo operacional.

| Campo | Valor |
|---|---|
| Data/hora | _pendente_ |
| Ambiente / banco | _pendente_ |
| Identificação da execução | _pendente_ |
| Backup (arquivo, tamanho, hora, restauração verificada) | _pendente_ |
| Empresas saneadas | _pendente_ |
| Linhas removidas por tabela | _pendente_ |
| Quantidades preservadas | _pendente_ |
| Divergências de estoque | _pendente_ |
| Resultado | **BLOQUEADO — sem credencial de conexão ao banco publicado** |

O saneamento no banco publicado **só** ocorre após autorização expressa e
backup comprovado. Não confundir o código entregue com os dados efetivamente
saneados.

### Ensaio integral em PostgreSQL 16.14 real (2026-11-12)

O runbook foi executado **de ponta a ponta** contra um PostgreSQL 16.14 real
(`postgres:16.14`, porta 5433), com migrações aplicadas (120 registradas em
`schema_migrations`, incluindo `0120_pim_atributos_produto.sql`) e dados de
teste sintéticos, para provar que cada passo funciona contra o motor real — não
só em teste unitário.

| Campo | Valor |
|---|---|
| Motor | PostgreSQL `16.14` (Debian 16.14-1.pgdg13+1) — mesma versão do gate |
| Migrações aplicadas | 120 (`schema_migrations`); última `0120_pim_atributos_produto.sql` |
| Backup gerado | `pg_dump -Fc` (arquivo **fora** do repositório), manifesto com `sha256` + tamanho + host/porta/banco (sem credenciais) |
| Backup verificado | **RECUPERÁVEL** — `230` tabelas restauradas em banco descartável com contagem idêntica; banco descartável removido |
| Saneamento | `--executar --confirm=LIMPAR-HOMOLOGACAO` — **7 linhas** de teste removidas (vendas, itens, reservas, movimentações, lançamentos, pedidos commerce, outbox) |
| Estoque físico | **PRESERVADO** — 42 peças antes e depois; 1 célula; custo e valorização idênticos |
| Divergências de estoque | **0** |
| Tabelas protegidas | intactas (`estoques`, `produtos`, `tamanhos`, `cores`, `colecoes`, `empresas`, `usuarios`, `plano_contas`, `contas_financeiras`, `centros_custo`, `categorias`) |
| Auditoria | registro `saneamento-homologacao` gravado (`auditoria.id`) |
| Carga cadastral | `POST /api/carga/politica-comercial/confirmar` → **75 produtos-pai**, **384 variações**, **3558 preços** por condição, **1** código de indústria repetido ignorado |
| Idempotência | 2ª carga → `0` produto, `0` preço gravado, `415` ignorados (mesmo valor = no-op) |
| Estoque importado | **nenhum** — nenhuma quantidade física veio da planilha |
| Gate PostgreSQL | `npm run test:pg` — `491` verificações, `0` falhas |

Conclusão do ensaio: **o código e o runbook estão prontos e provados contra
PostgreSQL real**. A execução no banco PUBLICADO continua bloqueada **apenas**
pela ausência da `DATABASE_URL` de produção neste ambiente (ver §"Bloqueio
operacional identificado").
