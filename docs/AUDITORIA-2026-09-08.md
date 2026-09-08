# Auditoria técnica e de produto — 2026-09-08

Escopo: `server/src` + `client/src` + `db/` (90 arquivos, ~25,5 mil linhas, 38 recursos, 119 rotas).
Método: leitura do código dos caminhos de escrita (estoque, movimentações, inventário, financeiro, fiscal, auth) **e** sondas reais contra a API em modo demonstração. Nada aqui é opinião sem evidência: o que está marcado como *reproduzido* foi executado e tem resultado anotado.

## Resumo executivo

| Dimensão | Nota | Comentário |
|---|---|---|
| Modelo de dados / ERP de confecção | bom | grades, tabela de medidas, locais, ficha/BOM, OP, estorno, catálogo público |
| Integridade de estoque | bom (era **frágil**) | estorno furava o zero e o abate não era atômico — os dois fechados neste PR, com teste de concorrência no Postgres |
| Segurança de acesso | razoável | Argon2id, MFA/TOTP, sessões, reauth, rate limit persistente, cadeia de auditoria com hash |
| Segurança de configuração | bom | o boot **já** abortava sem `JWT_SECRET`/`ADMIN_PASSWORD` em produção (`assertProductionSecrets`); minha afirmação anterior estava errada — ver §1.4. Faltava restringir a escrita com senha provisória (corrigido) |
| Constraints no banco | razoável (era **zero**) | 7 `CHECK` de domínio + índice único de saldos, por migração versionada (`schema_migrations`) |
| Testes | bom | 83 → 106 (2 exigem Postgres e rodam em job próprio); ainda sem cobertura de importação e do fluxo de caixa completo |
| Observabilidade / ops | razoável → bom | log estruturado, health check, backup admin; migração agora versionada (`schema_migrations`) e falha no boot em vez de seguir pela metade |
| Maturidade fiscal | honesto, mas incompleto | NF-e não forja mais documento: simulação é marcada e a emissão real devolve 503 (o cliente do emissor continua inexistente) |

## 1. Corrigido neste PR (com evidência)

### 1.1 Estorno podia deixar saldo negativo — P1 · *reproduzido*

Antes: produto com 10 pç → entrada 10 → saída 10 (saldo 0) → estornar a **entrada** deu `200 OK` e saldo **-10**. O estorno aplicava o delta inverso com `adjustStock` direto, pulando a checagem de saldo que a saída normal faz.

Depois: `409` com "O estorno retiraria 10 peça(s) de "loja", mas só há 0 em estoque. Estorne primeiro as movimentações que consumiram essas peças." e saldo intacto. Regra em `server/src/estoque.ts` (`garantirSaldoParaRetirada`), coberta por teste.

### 1.2 A validação de grade existia só na tela — P1 · *reproduzido*

Antes: `POST /api/movimentacoes` com `produto_id` de calça (grade 36-48) e `tamanho_id` do "M" respondia `201 Created`. Importação de planilha, integração ou chamada direta recriavam exatamente a mistura que as grades vieram resolver.

Depois: `400` com lista do que a grade aceita (`server/src/services.ts`, `validarTamanhoNaGrade`); produto **sem** grade continua livre; o estorno não é barrado (ele reverte um lançamento que era válido na época).

### 1.3 Inventário no modo demonstração nunca abria de fato — P2 · *reproduzido*

`status` do inventário é `readonly` na API e o único `DEFAULT 'aberto'` estava no `db/schema.sql`, que o memdb não executa. Resultado: no modo demonstração o inventário nascia com `status = null`, o snapshot do saldo não rodava (0 itens congelados) e a contagem devolvia *"Este inventário já foi fechado"*. É o motivo pelo qual essa tela parece quebrada em demo.

Depois: `createRecord` marca `status='aberto'` no create (`services.ts`) — mesma semântica do Postgres, e a paridade memdb/Postgres volta. Testes cobrem snapshot **e** fechamento.

### 1.4 ~~Deploy podia subir com segredos forjáveis~~ — RETRATADO

A primeira versão deste relatório afirmou que `JWT_SECRET`/`ADMIN_PASSWORD` ausentes
geravam só `console.warn`. **Está errado.** A checagem já existia no `main`:
`assertProductionSecrets()` (`server/src/security.ts:15`, chamada no boot em
`index.ts:88`) aborta com `exit(1)` quando `JWT_SECRET` tem menos de 24 caracteres
ou é o valor padrão, quando `ADMIN_PASSWORD` falta/é fraca/é `brobond123`, e avisa
sobre `MFA_ENCRYPTION_KEY`. O erro de método foi meu: procurei a constante dentro de
`auth.ts` e generalizei a partir dali, sem rastrear o boot. O `throw` extra que eu
tinha adicionado em `auth.ts` foi revertido neste PR (duplicaria a mesma regra em dois
arquivos).

Sobra daí um item real, mas menor: `SEED_DEMO` não existe neste repositório (só
`db/seed.sql`, aplicado à mão) — não há, portanto, risco de "subir com dados de
demo em produção" via variável esquecida. O que faltava de verdade na área era a
restrição de conta com senha provisória, hoje no **P1-D** (corrigido).

### 1.5 Higiene

`prefer-const` em `catalogos.ts:110-111` (2 erros de lint que vinham do #22) — `npm run lint` não gera mais erro nesses arquivos. Testes: +13 nesta primeira rodada (`grades.test.ts`, `auditoria.test.ts`); a segunda rodada (seção 2) levou a 106.

## 2. Achados e o que foi feito no mesmo PR

Status de cada um; *o que* mudou está no commit, não aqui — esta seção existe para
registrar a decisão e o que ficou de fora.

### P1-A · Saldo com checagem e escrita separadas — ✅ corrigido

Novo método de store `tryAdjustStock(produto, tamanho, local, delta, tx, minimo)`
(`store.ts`, `pgstore.ts`, `memdb.ts`): garante a linha do saldo e abate com a
condição **dentro do `UPDATE`** (`... SET quantidade = quantidade + $4 WHERE ... AND
quantidade + $4 >= $5 RETURNING *`); zero linhas ⇒ `null` ⇒ `409`. Passaram a usar
isto: `createMovimentacao` (saída, ajuste negativo e transferência na origem), o
estorno de inventário (`estoque.ts`), o faturamento de venda (`itens.ts:316`) e a
reabertura de OP (`producao.ts:216`, que antes podia deixar estoque negativo ao
"estornar" peças já vendidas — achado novo, não estava no relatório original).
Prova de concorrência: `server/test/pg-concorrencia.test.ts` (job `testes-postgres`)
— saldo 1, duas saídas simultâneas, exatamente uma vence. No memdb isso não é
testável; ver o teste que documenta a limitação em `auditoria.test.ts`.

### P1-B · Fechamento de inventário sobre saldo congelado — ✅ corrigido (opção b)

`fecharInventario` agora recalcula `delta = contado − saldo_atual` (nunca sobre o
congelado da abertura), recusa empurrar o saldo para negativo, valida o tamanho na
grade antes de gerar o ajuste e devolve `deslocados[]` com o par *congelado → atual*
de toda linha que se moveu durante a contagem (registrado também na auditoria). Não
roteei por `createMovimentacao` porque o fechamento inteiro já corre dentro de uma
transação e o serviço abriria outra — em vez disso ele chama as mesmas primitivas
(`tryAdjustStock` + `insert` em `movimentacoes` com o mesmo formato).

### P1-C · NF-e — ✅ corrigido o engano; a integração continua pendente

Decisão tomada: sem cliente de emissor, **não existe caminho para marcar nota como
emitida**. `vendas.nfe_status` (`nao_emitida | simulada | emitida | cancelada`) é
coluna nova; a simulação (`NFE_MODO=simulacao`) grava `simulada` + número `SIM-*` e
diz na resposta e na auditoria que não tem valor fiscal; com provedor configurado e
sem o modo, o endpoint devolve `503`; sem nada configurado, `409`. A escrita é
condicionada ao valor lido (`tryUpdateIf`), então dois cliques não emitem duas notas,
e o CRUD de vendas descarta `nfe_*` — ninguém forja "emitida" pela tela. Cancelamento
/acerto continuam fora (dependem do emissor real).

### P1-D · Senha provisória com acesso total de escrita — ✅ corrigido

`bloquearSenhaProvisoria` (`security.ts`) montado logo depois de `requireAuth`
(`index.ts:163`): com `trocar_senha` ativo, só `GET` e o fluxo `/api/auth/{me,
change-password,logout,logout-all,reautenticar,sessoes,mfa}`; o resto devolve `403`
com `code: SENHA_PROVISORIA`. O front já mandava esse usuário para Configurações →
Senha, então o fluxo normal não muda — quem insistir em API/ integrações recebe a
regra explícita em vez de silêncio.

### P1-E · MFA que se auto-ativa — ⏸ depende de decisão

A correção honesta exige canal fora-de-banda (o segredo TOTP sair do JSON de
`/api/auth/mfa/desafio` e ir por e-mail, com ativação só depois de reautenticação).
Sem SMTP configurado no deploy do dono, isso quebra o primeiro acesso. Decisão dele;
nenhum dos dois lados foi mexido neste PR.

### P2-A · CSP e moldura — ✅ cabeçalhos; ⏸ token em cookie

CSP no `securityHeaders`: `default-src 'self'`, `script-src 'self'`, `object-src 'none'`,
`base-uri 'self'`, `form-action 'self'`, `frame-ancestors 'self'`, fontes do Google e
Cloudinary liberados onde o app realmente busca, `style-src 'unsafe-inline'` (o React
escreve `style=""`), `upgrade-insecure-requests` em produção, e `X-Frame-Options` em
qualquer ambiente. `/api/docs` fica fora da CSP (Swagger UI de CDN com script inline —
página pública). Consequência unavoidable: a impressão de etiquetas e de pedido
deixou de usar `<script>` inline na janela aberta e passou a disparar `print()` da
janela pai (`LabelSheet.tsx`, `OrderPage.tsx`) — com CSP estrita o documento impresso
perderia o auto-print. Token de `localStorage` → cookie `HttpOnly; SameSite=Lax`
continua aberto: mexe em todo o front de auth e em qualquer integração que use o header.

### P2-B / P2-C · Constraints de domínio + migração versionada — ✅ feito

`db/migrations/0001_integridade_dominio.sql` cria, por um laço em `plpgsql`
idempotente, os `CHECK`: saldo não negativo, `local` não vazio, `tipo` de
movimentação, `quantidade <> 0`, status de inventário, perfil de usuário e
`nfe_status`; e o índice único `(produto_id, tamanho_id, local)` quando não há
duplicatas (com `NOTICE` dizendo o que fazer se houver). `NOT VALID` + `VALIDATE`
tentado: dado legado ilegável não trava o boot, mas a gravação nova é verificada.
O runner (`db.ts:aplicarMigrationsVersionadas`) cria `schema_migrations(id,
aplicado_em)`, aplica em ordem léxica, um arquivo por transação, e aborta o boot em
falha. Os mesmos `CHECK` foram espelhados inline no `schema.sql` (banco novo já
nasce com eles) e a regra de saldo negativo está no CRUD (`garantirSaldoNaoNegativo`)
para o modo demonstração não ficar mais frouxo que o Postgres.

### P2-D · Dois stores, um contrato — ✅ CI com Postgres incluído

Job `testes-postgres` (serviço `postgres:16`, `continue-on-error`) roda
`npm --prefix server run test:pg`; o arquivo só existe rodando com `DATABASE_URL`,
caso contrário se auto-pula — a suíte local não mudou de comportamento. Um passo de
`lint` entrou no job principal.

### P2-E · Round-trips e agregações — ✅ parte feita, ⏸ agregações SQL

O snapshot do inventário passou de um `INSERT` por linha para `insertMany` (um
statement) e o teto deixou de ser 2000 (agora recusa explicitamente acima de 20000,
em vez de contar metade do estoque em silêncio). As somas da matriz de estoque e dos
relatórios continuam em JS sobre páginas carregadas: virar `SUM`/`GROUP BY` no SQL
pede um método de agregação no contrato de store (e uma decisão sobre o que a matriz
precisa mostrar por local) — ficou para a próxima rodada.

### P2-F · Dinheiro — ✅ helper único e soma em centavos

`server/src/utils.ts` já tinha `round2`/`round3` e **ninguém importava**: 10 módulos
reinventavam o arredondamento. Agora importam o compartilhado, e `somaMoeda(vals[])`
acumula em centavos inteiros — usado nos 25 pontos de `financeiro.ts`/`relatorios.ts`
que somavam valores e arredondavam no fim (o lugar onde o centavo andava).

### P2-G · Custo médio de produto acabado — ⏸ decisão de valuacao

Continua como estava. Mexer em entrada de OP/devolução para custo médio ponderado
muda o CMV e o valor de estoque exibidos no relatório que o dono usa hoje; precisa de
uma régua dele (e de aceito de reprocessamento de histórico) antes de ser feito.

### P3 · Produto

Sem alteração: reserva/alocação de saldo (dois vendedores ainda podem vender a mesma
peça — o P1-A só garante que o saldo não fica negativo), contagem cega no inventário,
curva ABC por grade e ponto de reposição ligado a pedido de compra.

## 3. O que já está bom (não mexer por impulso)

- **Auditoria tamper-evident** com cadeia de hash SHA-256 canônica e verificação (`auditChain.ts`) — acima da média para o porte.
- Rate limit de login/reset/MFA/convite **persistente** no banco, com contagem de falhas e aviso de tentativas restantes.
- Backup pelo admin excludes `senha_hash`, `mfa_secret`, tokens de convite/reset; e recusa modo demonstração em vez de entregar dump vazio.
- Upload com sniffing de magic bytes + whitelist JPEG/PNG/WebP; o catálogo público monta payload com campos explícitos (sem `...produto`), então custo/margem não vazam.
- SQL do store genérico interpola apenas identificadores de whitelist de recurso e parametriza valores — não encontrei injection em `sort`/`filter`/`search` (`orderClause`/`searchClause`).
- `render.yaml` já gera `JWT_SECRET` e `MFA_ENCRYPTION_KEY` (`generateValue: true`).

## 4. Próximos passos sugeridos

1. **P1-E (MFA)** — definir o canal fora-de-banda (e-mail de convite com o QR, ou
   código impresso). Aí sai a auto-ativação e o segredo some do `mfaDesafio`.
2. **P2-E restante** — agregação no SQL (matriz/relatórios) com método `aggregate`
   no contrato de store; medir com o catálogo real antes de escolher o shape.
3. **P2-G** — valoração de acabado com custo médio ponderado, depois de acordado o
   tratamento do histórico.
4. **Reserva/alocação** — o próximo problema de estoque verdadeiro: saldo *livre* vs.
   *vendido* (o P1-A fechou só o negativo).
5. **Token em cookie HttpOnly** — remover o `localStorage` do front de auth.

*Nota de método, que vale para a próxima auditoria:* o item 1.4 foi retractado
porque generalizei a partir de um `grep` num único arquivo. Todos os achados desta
rodada foram revalidados contra a base `9c14dae` (`git show 9c14dae:<arquivo>`) e,
quando possível, reproduzidos por chamada HTTP antes de virar código.
