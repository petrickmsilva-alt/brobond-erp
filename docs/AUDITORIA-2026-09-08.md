# Auditoria técnica e de produto — 2026-09-08

Escopo: `server/src` + `client/src` + `db/` (90 arquivos, ~25,5 mil linhas, 38 recursos, 119 rotas).
Método: leitura do código dos caminhos de escrita (estoque, movimentações, inventário, financeiro, fiscal, auth) **e** sondas reais contra a API em modo demonstração. Nada aqui é opinião sem evidência: o que está marcado como *reproduzido* foi executado e tem resultado anotado.

## Resumo executivo

| Dimensão | Nota | Comentário |
|---|---|---|
| Modelo de dados / ERP de confecção | bom | grades, tabela de medidas, locais, ficha/BOM, OP, estorno, catálogo público |
| Integridade de estoque | **frágil** | saldo dependia de checagem fora de transação atômica; estorno furava o zero (**reproduzido**) |
| Segurança de acesso | razoável | Argon2id, MFA/TOTP, sessões, reauth, rate limit persistente, cadeia de auditoria com hash |
| Segurança de configuração | **frágil** | segredo/credencial padrão só geravam *warning* no boot (**corrigido**) |
| Constraints no banco | baixo | **zero** `CHECK`/`ENUM`; toda a domínio vive na aplicação |
| Testes | razoável → bom | 83 → 96 nesta entrega; ainda sem cobertura de financeiro, NF-e e importação |
| Observabilidade / ops | razoável | log estruturado, health check, backup admin, migração idempotente no boot |
| Maturidade fiscal | **enganosa** | NF-e grava número de nota sem chamar emissor (**não corrigido — decisão de produto**) |

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

### 1.4 Deploy podia subir com credenciais e chave forjáveis — P1-segurança · *confirmado no código*

`JWT_SECRET` ausente ⇒ assinava com `'brobond-dev-secret'` (só um `console.warn`); `ADMIN_PASSWORD` ausente ⇒ admin nascia com `brobond123`, senha que está publicada no README. Em ambos os casos o serviço subia e ficava "normal". Agora, com `NODE_ENV=production`, o boot **falha** com mensagem do que definir (`server/src/auth.ts`). Dev e teste seguem com fallback.

### 1.5 Higiene

`prefer-const` em `catalogos.ts:110-111` (2 erros de lint que vinham do #22) — `npm run lint` não gera mais erro nesses arquivos. Testes: +13 (`grades.test.ts`, `auditoria.test.ts`).

## 2. Achados abertos (recomendações, em ordem de execução)

### P1-A · Saldo: checagem e escrita não são atômicas

`createMovimentacao` lê o saldo (`findOneWhere`), decide, e só então chama `adjustStock`. No Postgres há um round-trip de rede entre os dois — duas vendas concorrentes do mesmo SKU podem ambas ver "saldo 1" e ambas abater. O `adjustStock` é atômico (`ON CONFLICT DO UPDATE`), a **decisão** não é.

Sugestão: `UPDATE estoques SET quantidade = quantidade + $d WHERE id = $1 AND quantidade + $d >= 0 RETURNING *`; 0 linhas afetadas ⇒ `409`. Alternativa: `SELECT ... FOR UPDATE` na linha do estoque dentro da transação. Testar com 2 requisições simultâneas em Postgres real (aqui, no memdb single-thread, a janela não aparece — por isso o teste de concorrência precisa de PG).

### P1-B · Fechamento de inventário ignora o que se moveu durante a contagem

O ajuste é `contado - saldo_sistema` (saldo **congelado na abertura**) aplicado sobre o saldo **atual**. Se alguém movimentar o SKU com a contagem aberta, o resultado não é o contado — e pode ficar negativo. `fecharInventario` ainda escreve em `movimentacoes` por `s.insert`, pulando `createMovimentacao` (e portanto as regras do item 1.2).

Sugestão (duas opções, escolher uma): (a) bloquear movimentações no local enquanto houver inventário aberto do local (o ERP de verdade faz isso, com exceção para o próprio contador); (b) no fechar, recalcular contra o saldo atual e, se divergir do congelado, exigir recontagem da linha. Em ambos, rotear o ajuste por `createMovimentacao`.

### P1-C · NF-e escreve número de nota sem emitir nada

`nfeEmitir` (server/src/nfe.ts:116) monta os dados, grava a auditoria "emissão solicitada", gera `NFE-<id>-<timestamp>` e **persiste** `nfe_numero`, `nfe_emitida_em`, `nfe_provider` no pedido. A resposta diz "(simulação)", mas o registro fica indistinguível de uma nota emitida: bloqueia nova emissão (`já possui NF-e`), aparece como emitida em listagens e relatórios. Fiscalmente, número inventado em banco é o pior tipo de dado.

Sugestão: coluna `nfe_status` (`não emitida | solicitada | simulada | autorizada`), não gravar número enquanto não houver chamada ao provedor, badge vermelho na tela, e só liberar `nfe_numero` real. É decisão de produto — por isso **não** alterei neste PR.

### P1-D · Conta com senha provisória tem acesso total de escrita

`trocar_senha = true` não restringe nada na API: só alimenta o rótulo `senha_status`. Um convite aceito (ou o admin padrão) pode criar movimentações, fechar inventário e mexer em financeiro antes de trocar a senha.

Sugestão: middleware negando `POST/PUT/PATCH/DELETE` (exceto `/api/auth/trocar-senha`, ` logout`, leituras) enquanto `trocar_senha` estiver ativo.

### P1-E · O MFA do administrador se auto-ativa sem prova de posse

Fluxo verificado ponta a ponta com `curl`: `login` (só a senha) → `mfa_ticket` → `POST /api/auth/mfa/desafio` com o ticket devolve o **segredo TOTP** em JSON → o cliente gera o código → `POST /api/auth/login/mfa` valida → `auth.ts:274-287` grava `mfa_ativado_em` ali mesmo. Quem sabe a senha, portanto, ativa o próprio autenticador, passa no segundo fator e ainda passa a ser "usuário MFA" para sempre — o controle não agrega nada no momento em que mais importa (primeiro acesso de uma conta nova, exatamente o estado de um deploy recém-criado).

Sugestão: o desafio de cadastro só depois de reautenticação; ativar MFA somente via `POST /api/auth/mfa/ativar` com código conferido; opcional enviar o segredo por canal fora da banda (e-mail de convite). Registrar na auditoria qualquer ativação.

### P2-A · Superfície de XSS/CSRF do token

Token em `localStorage` (`client/src/lib/api.ts`) e sem `Content-Security-Policy`; `X-Frame-Options` só em produção. O único `dangerouslySetInnerHTML` do front (etiqueta, `LabelSheet.tsx:154`) está **protegido** por `escapeXml` no `barcodeSvg` — verificado, não há vetor ali. Sugestão: CSP com `default-src 'self'`, `frame-ancestors 'self'`, cookie `HttpOnly; SameSite=Lax` para o token (com o header ainda servindo APIs de integração), e `X-Frame-Options` sempre.

### P2-B · Banco sem constraints de domínio

`grep -c CHECK db/schema.sql` = **0**. `status` de inventário, `tipo` de movimentação, `quantidade <> 0`, `quantidade >= 0`, `perfil` de usuário, `UNIQUE(grades.nome)` — tudo vive só no TypeScript. Bugs como o 1.1/1.3 existem porque o banco aceita qualquer coisa. Sugestão: `CHECK` onde a regra é imutável + `UNIQUE` de nomes de cadastro + `NOT NULL` em FKs obrigatórias; `ALTER TABLE ... ADD CONSTRAINT ... NOT VALID` para não travar dados legados, `VALIDATE` depois.

### P2-C · Migração = schema.sql idempotente no boot

`db.ts` executa o arquivo inteiro na subida. Serve para criar, não para evoluir: não expressa rename/backfill, e uma falha no meio do arquivo deixa o banco pela metade, sem versionamento nem "já aplicado". Sugestão: arquivos numerados + tabela `schema_migrations`, `npm run migrate` no deploy, e o boot apenas **validando** a versão esperada (falha rápido, não conserta).

### P2-D · Dois stores com regras espelhadas

`pgstore.ts` e `memdb.ts` implementam o mesmo contrato; regra de negócio e comportamento de default escapam de um para o outro (o item 1.3 é um caso clássico). Sugestão: rodar a mesma suíte contra Postgres no CI (`services: postgres:16`) e manter o memdb como seed de demonstração, não como segunda implementação de referência.

### P2-E · Agregações em JS sobre páginas carregadas

A matriz de estoque e os relatórios fazem `list(..., pageSize: 2000/5000/10000)` e somam em JS; `abrirInventarioSnapshot` insere linha a linha (até 2000 `INSERT` sequenciais). Com catálogo e histórico crescendo, isso vira latência e memória de processo. Sugestão: `INSERT ... SELECT` no snapshot, `SUM`/`GROUP BY` no SQL para totais, e paginação real (ou cursor) na matriz. Índices dos filtros quentes já existem (`idx_movimentacoes_produto_tamanho`, `idx_movimentacoes_prod`, `idx_estoques_produto`) — conferir apenas os de data+local.

### P2-F · Dinheiro em float na camada de cálculo

O schema usa `NUMERIC(12,2)` (certo), mas a aplicação calcula com `Number` + `Math.round(x*100)/100` espalhado (`financeiro.ts:20`, `catalogos.ts:316`, `detail.ts:79`...). Em agregação longa, o centavo anda. Sugestão: somar no SQL; onde somar em JS, usar centavos inteiros e formatar na borda; um único helper de arredondamento.

### P2-G · Custo médio só de insumo

`custo_medio` existe e é atualizado no recebimento/estorno de compra — para **insumos**. Produto acabado é valorizado por `produtos.custo` fixo, então o valor de estoque e o CMV não acompanham o custo real de produção. Sugestão: custo médio ponderado de acabado na entrada (OP concluída / devolução de venda), com `estoque_valorizacao` por local se quiser rigor de acerto de inventário.

### P3 · Lacunas de "ERP profissional" (produto)

- Reserva/alocação: pedido faturado desconta direto; não há saldo *disponível* (reservado vs. livre), então dois vendedores vendem a mesma peça.
- Contagem cega por aplicação no inventário (o digitador não deveria ver o saldo do sistema) — hoje a tela mostra `Saldo no sistema` ao lado do campo de contagem, o que vicia a conferência.
- Lote/cor/tamanho como eixos de relatório: a matriz tem grade, mas curva ABC/ruptura por grade ainda não é cidadão de primeira classe.
- Ponto de reposição + sugestão de compra (existem `estoque_min` e previsão; falta o elo com pedido de compra automático).
- Acerto/cancelamento de NF-e e carta de correção dependem da decisão do P1-C.

## 3. O que já está bom (não mexer por impulso)

- **Auditoria tamper-evident** com cadeia de hash SHA-256 canônica e verificação (`auditChain.ts`) — acima da média para o porte.
- Rate limit de login/reset/MFA/convite **persistente** no banco, com contagem de falhas e aviso de tentativas restantes.
- Backup pelo admin excludes `senha_hash`, `mfa_secret`, tokens de convite/reset; e recusa modo demonstração em vez de entregar dump vazio.
- Upload com sniffing de magic bytes + whitelist JPEG/PNG/WebP; o catálogo público monta payload com campos explícitos (sem `...produto`), então custo/margem não vazam.
- SQL do store genérico interpola apenas identificadores de whitelist de recurso e parametriza valores — não encontrei injection em `sort`/`filter`/`search` (`orderClause`/`searchClause`).
- `render.yaml` já gera `JWT_SECRET` e `MFA_ENCRYPTION_KEY` (`generateValue: true`).

## 4. Ordem sugerida

1. P1-B + P1-A juntos (mesmo arquivo, mesmo teste de concorrência) — é o que ainda pode corromper estoque em produção.
2. P1-D e P1-E (auth, ~1 dia somado, sem impacto no fluxo feliz de quem já trocou senha e ativou MFA).
3. P1-C depois da sua decisão de produto (simulação explícita).
4. P2-B + P2-C (constraints + versionamento de migração) antes de o histórico crescer.
5. P2-D (CI com Postgres) como pré-requisito de 1.
6. P2-A, P2-E, P2-F, P2-G, P3 no ritmo das sprints.
