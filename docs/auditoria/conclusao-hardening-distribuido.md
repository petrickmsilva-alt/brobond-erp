# Conclusão do hardening distribuído — NÃO APROVADO

## Estado inicial e limites desta entrega

Em 2026-11-04, `git fetch origin main arena/615f44fd-brobond-erp` confirmou
`f965c8c182ebdbbb55d5ca08e07b2f061b2e06ef` tanto no HEAD como na branch
publicada; a árvore estava limpa. Seus ancestrais `06cfd67735418a05e1b5e5772796d39fc416f16c`
e `5e9bcf53fc358b35bda80f07a6dc13312e19fc78` foram preservados. O relatório
anterior e os diffs dos dois commits foram examinados. A branch de trabalho é a
fixa da sessão, `arena/615f44fd-brobond-erp`; não se criou a branch pedida com
outro nome. Não houve reescrita de histórico.

**O núcleo da missão não foi implementado.** Os cinco jobs permanecem com `Set`
local em `server/src/scheduled.ts`; **não existe lock distribuído por job, lease,
heartbeat, fencing integrado aos efeitos, ou registro novo de idempotência**.
Não existe migração para essas estruturas. A mera existência do PostgreSQL ou da
outbox preexistente não prova nenhum desses requisitos. Não há novos testes
multiprocessos para os jobs e não se podem informar aquisições ou tentativas
como se tivessem sido medidas. Esta entrega não deve ser interpretada como
proteção contra dupla execução, nem como autorização para ativar os crons.

O código dos executores envolve gravações em vários módulos, filas e chamadas
externas que não compartilham transação nem fencing: mesmo um lease atômico na
entrada deixaria um worker pausado capaz de persistir ou enviar depois de perder
a propriedade. Não foi adicionada uma trava parcial que ocultasse essa lacuna.
As limitações por job continuam documentadas no relatório anterior. Integração
real, rollback de migração, recuperação e todos os invariantes distribuídos
continuam pendentes. Sem garantias transacionais dos provedores ou idempotência
deles, efeitos externos não podem ser afirmados como exatamente uma vez.

## Credenciais e correções

- `server/src/senhaAdmin.ts`: removido fallback administrativo literal. A
  resolução retorna vazio sem `ADMIN_PASSWORD`; produção continua rejeitando
  valor legado e senha curta. `server/src/index.ts` agora encerra o boot em todos
  os ambientes se `ADMIN_PASSWORD` estiver ausente/vazia, sem imprimir o valor.
  Configurar explicitamente a credencial no ambiente antes de iniciar é uma
  mudança operacional obrigatória; a autenticação de emergência não tem fallback.
- `server/.env.example` e `README.md`: senha de exemplo removida e orientação de
  configuração explícita. As correções dos scripts do commit `06cfd67` foram
  preservadas. CI usa credenciais efêmeras geradas por processo e mascaradas.
- Dois testes PG de prontidão e emergência passaram a gerar uma senha efêmera
  específica e a fornecê-la ao processo filho; o teste da credencial antiga na
  blacklist permanece como teste negativo, não como credencial funcional.
- A documentação histórica e o patch de auditoria substituem a grafia da senha
  antiga por `[CREDENCIAL REDIGIDA]`, preservando o registro de exposição. O
  histórico Git anterior não foi reescrito; não se demonstrou uso real dessa
  senha em produção. Caso confirmado, a rotação cabe ao responsável externo.
- `server/test/admin-boot-credentials.test.ts` testa falha de boot sem senha e
  ausência de vazamento de sentinela. `credential-scan.test.ts` verifica arquivos
  Git rastreados e não ignorados contra a senha legada, com exceções explícitas
  somente para listas de bloqueio e testes negativos, e verifica o resolver.
  Essa verificação **não** é um scanner geral de segredos.

Classificação das ocorrências examinadas: credencial administrativa ativa em
desenvolvimento (fallback removido); credenciais de teste/fixtures (ainda há
literais sintéticos em muitos testes, não revisados individualmente); exemplos
operacionais (senha administrativa removida; URLs e placeholders não são prova
de credenciais válidas); históricos (redigidos sem excluir a evidência); e falsos
positivos/listas de rejeição em `politicaSenha.ts`, `services.ts`, `security.ts`,
`senhaAdmin.ts`, componente de força e testes negativos. Há fallback de JWT de
desenvolvimento em `chavesCifra.ts`, além de possíveis outros valores ainda não
classificados. **A varredura geral e a eliminação integral de credenciais ativas
não estão comprovadas.** Nenhuma credencial externa foi alterada.

## PostgreSQL real de teste

Não havia `postgres`, `psql`, Docker, nem `DATABASE_URL` configurado. Foi obtido
`@embedded-postgres/linux-x64@16.14.0-beta.17` do registro npm para diretório
fora do repositório; `initdb` criou um cluster descartável local, com autenticação
trust para testes, `postgres` 16.14 escutando em `127.0.0.1:55439` e banco novo
`brobond_teste`. Nenhuma dependência nova foi incluída no projeto. Não se acessou
um banco de produção. `npm run test:pg` aplicou bootstrap e migrações existentes:
**423 testes, 410 aprovados, 0 falhas e 13 ignorados**, exit 1 do gate porque
`psql` não veio no pacote e os 13 testes exigem o executável real. O gate
corretamente não aceita skips. Não se usou shim como substituto de `psql`.

Os testes PG existentes incluem processos de servidor reais e testes de
concorrência de outros domínios; **não são evidência de lock/idempotência dos
cinco jobs**. Os testes de prontidão e emergência alterados passaram nesse gate.

## Os 82 testes anteriormente ignorados

Uma comparação por nome dos TAPs encontrou **81** testes dependentes de
PostgreSQL que passaram no gate PG real acima e **1** de PIX sandbox que
continuou bloqueado por ausência de provedor/credencial. A chamada externa PIX
não foi realizada; não se considera o teste aprovado. Nenhum teste foi removido
ou convertido para skip. Os 13 skips por `psql` são adicionais e pertencem à
suíte PG completa, não são parte desses 82. A lista individual segue no apêndice.

## Qualidade e flakiness

- `test:server`, sem `DATABASE_URL`: 2.023 testes, 1.941 aprovados, 0 falhas,
  82 ignorados. O teste de scan foi criado depois do início dessa execução e foi
  executado separadamente; testes direcionados de segurança totalizaram 20
  aprovados, 0 falhas, 0 skips (e recheck posterior de seis passou).
- Cliente sob carga concorrente de servidor, PostgreSQL, lint e build: 1.145
  aprovados e 6 falhas, sendo cinco timeouts de 5 s e uma busca de opção no
  Layout sem elemento após timeout anterior. Repetição sem essas suítes
  concorrentes: 1.151 aprovados, 0 falhas, 0 skips. A evidência aponta contenção
  de recursos como fator provável, não prova causa única para cada falha; nenhum
  timeout foi ampliado nem assertion removida. A execução anterior também passou
  isolada, mas há risco de flakiness sob carga.
- Typecheck e build passaram. Lint passou com **612 avisos e 0 erros**. Comparação
  textual com o log da execução anterior mostra somente deslocamento de linhas
  em `index.ts` após inserir a guarda; mesmo conjunto/quantidade de mensagens,
  portanto **0 avisos novos**. Não são um lint integralmente limpo; os 612 são
  preexistentes no escopo do lint. Esse comando não analisa todos os testes `.ts`.
- Smoke E2E local, API em memória e gateway mock: **398/398**; senhas aleatórias
  não apareceram nos logs capturados. Não substitui o teste PG do gate.

## Git e produção

A implementação anterior foi preservada. O commit e o resultado de push desta
atualização devem ser consultados no `git log`/saída de push; esta seção foi
redigida antes de criá-los. Não houve PR/merge, deploy, mudança do Render,
migração em produção, execução de cron de produção, publicação, pagamento ou
mensagem real. Nenhum lock distribuído foi incluído e nenhuma alteração de dados
de produção foi feita.

## Apêndice — classificação individual dos 82 skips da suíte sem banco

`PG PASS`: nome correspondente aprovado na suíte PostgreSQL real. `BLOQUEADO`:
depende de sandbox externo e não executado.

- **PG PASS** — auditoria multiempresa em Postgres real: carimbo no INSERT e recorte no SQL
- **PG PASS** — pg E3.2: compra COM vencimento recebe e gera parcelas (regressão do RangeError)
- **PG PASS** — pg E3.2: vencimento no dia 31 não vira mês seguinte (31 jan + 1m = 28 fev)
- **PG PASS** — pg E3.2: recebimento PARCIAL não gera conta a pagar; o completo gera
- **PG PASS** — pg E3.2: estornar a compra cancela as contas a pagar
- **PG PASS** — pg E3.2: compra de valor zero não gera parcela de R$ 0,00
- **PG PASS** — pg E3.2: a 0029 está aplicada — colunas e índices do de-para
- **PG PASS** — pg E3.2: o mesmo código no mesmo fornecedor é recusado pelo UNIQUE (23505)
- **PG PASS** — pg E3.2 MULTIEMPRESA: o mesmo código em A e B não colide (escopos separados)
- **PG PASS** — pg E3.2 E2E: fornecedor → compra → recebimento → estoque → custo → conta a pagar
- **PG PASS** — pg E3.2 E2E MULTIEMPRESA: B não enxerga nada da cadeia da A (A → B → A)
- **PG PASS** — duas saídas concorrentes do mesmo saldo: exatamente uma vence
- **PG PASS** — runner de migrações: registra, aplica os CHECK de domínio, é idempotente e o banco recusa saldo negativo
- **PG PASS** — PgStore consulta usuário pelas colunas de autenticação (convite/redefinição)
- **PG PASS** — fluxo do convite funciona de ponta a ponta no Postgres (validar + aceitar)
- **PG PASS** — E3-PG: os CHECKs de status e critério recusam valor fora da lista
- **PG PASS** — E3-PG: o índice único parcial de compra_id é a trava final de idempotência
- **PG PASS** — E3-PG: UNIQUE de convite por fornecedor e de preço por item
- **PG PASS** — E3-PG: itens_compra tem as colunas de rateio de custo, com default 0 e CHECK >= 0
- **PG PASS** — E3-PG: decidir gera um pedido real com itens, e repetir não duplica
- **PG PASS** — E3-PG: decisões simultâneas da mesma cotação geram UM único pedido
- **PG PASS** — E3-PG: a empresa B não lê nem decide a cotação da A
- **PG PASS** — pg E3.1: a 0028 está aplicada — colunas, CHECKs e índices únicos parciais
- **PG PASS** — pg E3.1: custo_unitario NEGATIVO é recusado pelo CHECK (23514)
- **PG PASS** — pg E3.1: a MESMA linha não aceita duas entradas no mesmo recebimento (23505)
- **PG PASS** — pg E3.1: receber 40 + 60 de uma vez só é igual a receber 100 direto
- **PG PASS** — pg E3.1: lote mais caro no segundo recebimento move o custo médio
- **PG PASS** — pg E3.1: dois lotes não cobram o frete duas vezes, e a soma fecha no frete
- **PG PASS** — pg E3.1: o frete da compra entra no custo efetivo e fecha no centavo
- **PG PASS** — pg E3.1: cancelar a compra estorna estoque e restaura o custo médio
- **PG PASS** — pg E3.1: estorno com estoque já consumido RECUSA e não muda nada
- **PG PASS** — pg E3.1 CORRIDA A: dois recebimentos simultâneos do MESMO SKU somam estoque e ponderam custo
- **PG PASS** — pg E3.1 CORRIDA B: dois parciais simultâneos do MESMO pedido nunca passam do pedido
- **PG PASS** — pg E3.1 CORRIDA C: recebimento e cancelamento simultâneos não deixam estoque fantasma
- **PG PASS** — pg E3.1: dois recebimentos com a MESMA idempotency key geram um único recebimento
- **PG PASS** — pg E3.1: transação que falha no meio não deixa estoque nem custo
- **PG PASS** — pg E3.1 MULTIEMPRESA: A e B compram o mesmo insumo por preços diferentes (A → B → A)
- **PG PASS** — pg E3.1: o recebimento grava auditoria com o custo aplicado
- **PG PASS** — painel (PG): estoque, produtos e valorização respeitam a empresa ativa
- **PG PASS** — dependências em PostgreSQL real: catálogo, FK 23503, 409 com diagnóstico e multiempresa
- **PG PASS** — ERP-07 em Postgres real: alçada de administrador e guardas de exclusão de empresa
- **PG PASS** — pg W45: as tabelas das ondas 4–5 existem com empresa_id NOT NULL
- **PG PASS** — pg W45: CHECK de domínio recusa estado inválido (defesa em profundidade)
- **PG PASS** — pg W45: UNIQUE (empresa_id, chave_idempotencia) impede crédito duplicado
- **PG PASS** — pg W45: creditar venda é idempotente e o saldo é a soma dos movimentos
- **PG PASS** — pg W45: BI reconstrói receita/CMV/margem do período real
- **PG PASS** — pg W45: forecast → plano de suprimento → S&OP aprovado com autor
- **PG PASS** — pg W45: EPM calcula variance do realizado e projeta o cenário
- **PG PASS** — pg W45: isolamento por empresa (A × B) em loyalty e affiliate
- **PG PASS** — FISCAL em Postgres real: a nota fantasma é impossível
- **PG PASS** — dashboard (PG): fronteiras SQL de America/Sao_Paulo são 03:00 UTC (independente da sessão)
- **PG PASS** — dashboard (PG): faturamento de 21:00–23:59 BR do último dia entra no mês civil correto
- **PG PASS** — dashboard (PG): produção de domingo 23:59 BR entra na semana civil da segunda anterior
- **PG PASS** — MULTIEMPRESA em Postgres real: triggers, unicidade por empresa e recorte no SQL
- **PG PASS** — motor de margem: lucro bruto materializado nas colunas reais de sales (PG)
- **PG PASS** — curva ABC: classificação 80/15/5 persistida em produto_abc com janela De/Até (PG)
- **PG PASS** — impostos_ncm: a linha-padrão é única — índice parcial recusa a segunda (PG)
- **PG PASS** — filtros estritos de BI: De/Até inclusivos, canal por grupo e empresa_id (PG)
- **PG PASS** — fuso do negócio (PG): De/Até e data seguem o dia civil de Brasília, nas fronteiras
- **PG PASS** — P0-02 PostgreSQL: conexão/evento/venda têm chave tenant e matcher não cruza SKU
- **PG PASS** — P1 em Postgres real: constraints, unicidades e herança de empresa
- **PG PASS** — P2 pg: migration 0025 cria tabelas de gateway/webhook/comissões/extrato
- **PG PASS** — P2 pg: duas baixas simultâneas no mesmo título — exatamente uma vence
- **PG PASS** — P2 pg: o mesmo evento de webhook não entra duas vezes (índice único)
- **PG PASS** — P2 pg: linha de extrato repetida na mesma conta bate na trava (FITID)
- **PG PASS** — P2 pg: comissão não se efetiva duas vezes pelo mesmo lançamento
- **PG PASS** — P2 pg: concorrência em duas operações de caixa (abrir o mesmo terminal)
- **PG PASS** — pg print P0..P6: concorrência real de claim, idempotência sem 25P02, pareamento único, terminais e vendas idempotentes
- **PG PASS** — E2 (PG): a 0026 criou CHECK de vocabulário, FKs ordem_id e índice de idempotência
- **PG PASS** — E2 (PG): status fora do vocabulário é recusado pelo banco, não só pela aplicação
- **PG PASS** — E2 (PG): o backfill liga a movimentação antiga à OP pelo motivo e deixa o órfão NULL
- **PG PASS** — E2 (PG): apagar a OP preserva a movimentação e solta o vínculo (ON DELETE SET NULL)
- **PG PASS** — E2 (PG): a mesma chave de idempotência na mesma empresa é recusada pelo índice único
- **PG PASS** — E2 (PG): duas conclusões concorrentes da mesma OP — exatamente uma vence
- **PG PASS** — E2 (PG): OP, trilha e apontamento não atravessam empresa (A → B → A)
- **PG PASS** — ERP-07/P0-06 em Postgres real: criar usuário funciona e a auditoria do convite é transacional
- **PG PASS** — schema: empresa_id anulável e com FK para empresas em webhooks e webhook_entregas
- **PG PASS** — migração 0097 reaplicada e rollback documentado preservam linhas legadas, sem backfill
- **PG PASS** — PgStore: alvos de evento respeitam empresa; evento global só a webhook global
- **PG PASS** — PgStore: entregas filtradas por empresa excluem legado NULL e a outra empresa
- **PG PASS** — PgStore: listagem de webhooks para admin de A não mostra B nem global
- **BLOQUEADO** — PIX sandbox: cria uma cobrança PIX de teste no provedor declarado
