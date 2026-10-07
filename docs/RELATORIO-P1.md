# RELATÓRIO — FASE P1 (Comercial, Fiscal, Logística e Suprimentos)

**Repositório:** `petrickmsilva-alt/brobond-erp`
**Branch:** `arena/07796e62-brobond-erp` (a partir de `fe344b3`)
**Data:** 2026-10-07
**Escopo:** exclusivamente o ERP. Nada de `brobond-ai-commerce`.

> Regra seguida à risca: **não declarar 100% sem evidência.** Onde algo foi
> exercitado só com test double, está dito. Onde existe gap, está listado como
> gap — não maquiado como implementado.

---

## 1. STATUS FINAL

## ⚠️ P1 **PARCIAL** — backend e telas concluídos; falta validar frete com provedor real

| Superfície | Status |
|---|---|
| Banco (migration + schema) | ✅ aplicada e provada em banco vazio |
| Servidor — APIs e regras de negócio | ✅ concluído |
| Multiempresa | ✅ re-auditado, 2 vazamentos fechados |
| Testes (memória + PostgreSQL real + telas) | ✅ verdes |
| Typecheck / lint / build | ✅ verdes |
| Client — telas dedicadas | ✅ **5 construídas e testadas**: PDV (+ NFC-e), Expedição, Sugestão de compra, Devoluções, Logística |
| Client — menu | ✅ 10 entradas, grupo novo `Logística & Expedição` |
| Smoke test ponta a ponta (HTTP real) | ✅ 22/22 contra o Express bootado |
| **Integração de frete com provedor real** | ⚠️ **só test double** (ver §4.1) |
| **`movimentacoes.venda_id`** | ⚠️ adiado para a P2 (ver §4.2) |

Backend e interface da P1 estão completos e testados. O que impede declarar P1
concluída são dois itens que **não dependem de mais código nesta fase**: a
validação dos adapters de frete contra provedor real (exige credencial de
homologação e saída de rede) e a coluna `movimentacoes.venda_id` (decisão de
schema adiada de propósito para não tocar em tabela estável dentro da P1).

---

## 2. IMPLEMENTADO (novo nesta fase)

| § | Item | Onde |
|---|---|---|
| 6 | **Listas de preço** — múltiplas, por produto e variação, vigência, prioridade, histórico; preço resolvido gravado no item da venda | `server/src/listasPreco.ts` (355 linhas) |
| 7 | **Propostas comerciais** — rascunho → enviada → aprovada/recusada → convertida; conversão idempotente em três camadas | `server/src/propostas.ts` (548) |
| 8 | **PDV** — caixa, abertura/fechamento, suprimento, sangria, busca por código/SKU, venda com recálculo total no servidor, cancelamento controlado | `server/src/pdv.ts` (779) |
| 13 | **Logística** — interface `ShippingProvider`, cotação, geração de envio, etiqueta, rastreio, status, cancelamento | `server/src/logistica.ts` (1115) |
| 14 | **Expedição** — separação → conferência → embalagem → expedição, com divergência registrada | `server/src/expedicao.ts` (773) |
| 15 | **Devolução / reversa** — solicitação → autorização → rastreio → recebimento → conferência → estoque → financeiro | `server/src/expedicao.ts` |
| 16 | **Compras** — aprovação com alçada, recebimento parcial/total, cancelamento | `server/src/compras.ts` (555) |
| 17 | **Sugestão de compra** — cálculo puro, agrupamento por fornecedor, geração de pedido só por POST explícito | `server/src/compras.ts` |

**Total:** 6 módulos novos, 4.125 linhas de código de serviço.

---

## 3. JÁ EXISTIA (não reimplementado)

Re-auditoria do P0 antes de escrever qualquer linha. Estes itens estavam prontos
e **não foram duplicados**:

| § | Item | Onde já estava |
|---|---|---|
| 3 | Produto completo: simples/variações/kit, SKU pai-filho, auto SKU de variação, pesos/dimensões/volumes/itens-caixa, GTIN, NCM/CEST/origem/CFOP/ICMS/PIS/COFINS/IPI, suprimento, imagens | `resources.ts` (`produtos`, `variacoes`), `variacoes.ts` |
| 4 | Clientes PF/PJ com validação de CPF/CNPJ **no backend** e unicidade por documento+empresa | `resources.ts`, índice `uq_clientes_documento_empresa` |
| 5 | Fornecedores fiscais e comerciais | `resources.ts`, `uq_fornecedores_documento_empresa` |
| 9–10 | NF-e/NFC-e atrás de `FiscalProvider`: emitir, consultar, cancelar, inutilizar, status, XML, DANFE, estados explícitos | `fiscal.ts`, `0023_fiscal_provider_extensivel.sql` |
| 11 | NF-e de entrada por XML: validação → fornecedor → NF → de-para → conferência → custo → estoque → contas a pagar | `suprimentos.ts` |
| 12 | De-para fornecedor × SKU persistente | tabela `produto_fornecedor_skus` |
| 18 | Integridade transacional venda→estoque→financeiro→fiscal | `services.ts` (`transaction`, `tryUpdateIf`) |

---

## 4. PARCIAL

### 4.1 Logística — adapters escritos, não exercitados contra o provedor real

`criarMelhorEnvio()` e `criarCorreios()` estão escritos contra as APIs públicas
documentadas, mas **neste ambiente só são exercitáveis com test double** — não
há credencial real, e não há saída de rede para `api.melhorenvio.com.br` ou
`proxyapp.correios.com.br`.

O que está provado de verdade:
- o contrato `ShippingProvider` (cotação, envio, rastreio, cancelamento);
- a recusa quando falta credencial (503, nunca envio fictício);
- o bloqueio no banco: `envios_postado_tem_prova` recusa status
  `postado`/`em_transito`/`entregue` sem `codigo_rastreamento` nem `provider_ref`;
- a idempotência (`uq_envios_idempotency`, `uq_envios_venda_vivo`).

O que **não** está provado: que o XML/JSON que o adapter monta é aceito pelo
provedor real. `criarCorreios().gerarEnvio` e `.cancelar` devolvem
`nao_configurado`. **Isto é gap, não entrega.**

### 4.2 `movimentacoes` não tem coluna `venda_id`

O vínculo venda → movimentação de estoque é feito por texto
(`motivo = 'Venda #<id>'`). Um `filter: { venda_id }` é **silenciosamente
ignorado** pelo store (chave desconhecida → `continue`) e devolve todas as
linhas — um falso positivo fácil de escrever. A rastreabilidade existe, mas é
frágil. Corrigir exige coluna nova + backfill; ficou para a P2.

### 4.3 Client — cinco telas construídas nesta fase ✅

PDV, Expedição, Sugestão de compra, Devolução e Logística deixaram de ser
página de planejamento e passaram a ter tela própria, com testes de contrato:

| Tela | Arquivo | Testes |
|---|---|---|
| PDV — venda de balcão + emissão NFC-e | `client/src/pages/PdvPage.tsx` | 11 |
| Expedição e divergências | `client/src/pages/ExpedicaoPage.tsx` | 6 |
| Sugestão de compra | `client/src/pages/SugestaoCompraPage.tsx` | 7 |
| Devoluções e logística reversa | `client/src/pages/DevolucoesPage.tsx` | 8 |
| Logística e envios | `client/src/pages/LogisticaPage.tsx` | 11 |

As cinco usam o `BarcodeScanner` que já existia no repositório (câmera via
`BarcodeDetector`, com entrada manual de fallback) e os componentes de UI já
consagrados (`PageHeader`, `Alert`, `Badge`, `Modal`, `useToast`).

**Logística (§13) — a tela não pode fingir que integrou.** Este é o módulo onde
seria mais fácil mentir: bastaria desenhar uma cotação bonita. As decisões:

- Sem credencial, o servidor responde **503 com o motivo** e a tela mostra o
  motivo. Não aparece nenhuma opção de frete — há teste afirmando que o botão
  "Gerar" nem chega a existir nesse caso.
- O token e a senha **nunca aparecem inteiros**. O servidor devolve o valor
  mascarado e o booleano `*_configurado`; o campo de senha nasce vazio e só é
  enviado se o operador digitar algo. Vazio não limpa a credencial existente.
- Ativar Melhor Envio ou Correios sem credencial é recusado com **409** pelo
  servidor; a tela repete o motivo e aponta o provedor `manual` como saída que
  funciona de verdade sem integração.
- Frete grátis é **regra do ERP**, não do provedor: a cotação mostra o valor
  original riscado e o rótulo "frete grátis (regra do ERP)".
- Geração de envio idempotente: quando o servidor devolve `idempotente: true`,
  a tela diz "já existia — nenhum duplicado foi criado" em vez de comemorar
  uma segunda remessa.

**Devolução (§15) — a tela não decide o fluxo.** As ações disponíveis são
exatamente as que o servidor devolve em `proximas_acoes`. Se a máquina de
estados mudar no backend, a tela acompanha sem edição. Há teste travando isso:
uma devolução `autorizada` mostra "Registrar rastreio" e "Receber", e **não**
mostra "Autorizar" nem "Cancelar".

A conferência de recebimento separa o que volta ao estoque do que não volta,
item a item: só `bom` soma saldo; `avariado`, `usado` e `faltando_acessorio`
ficam registrados sem somar. O campo de quantidade corta no solicitado — não
dá para receber mais do que foi devolvido. E sem `codigo_rastreamento` o botão
de recebimento nasce desabilitado, com a explicação do 409 na tela.

**Ponto de compliance preservado na tela do PDV:** o total exibido enquanto o
operador digita está rotulado como **prévia**, com a frase "O servidor
recalcula preço, desconto, frete, impostos e total ao registrar". Depois do
POST, a tela mostra o `calculo` devolvido pelo servidor — e, se ele diferir da
prévia, avisa o operador em vez de fingir que estava certo desde o início.
Há teste travando exatamente esse comportamento.

**Emissão de NFC-e a partir do PDV (§8).** A venda elegível ganhou botão
"Emitir NFC-e", que chama `POST /api/vendas/:id/fiscal/emitir` com
`modelo: '65'`. A regra aqui é absoluta: **a tela nunca marca como emitida por
conta própria.** Ela mostra o que o servidor respondeu:

| Resposta do servidor | O que a tela mostra |
|---|---|
| `autorizado` | "NFC-e autorizada", com protocolo e chave devolvidos |
| `processando` | "Enviada — aguardando autorização da SEFAZ" |
| qualquer outro status | o motivo da rejeição, em vermelho |
| exceção (ex.: 503) | a mensagem de falha, em vermelho |

Os três últimos casos têm teste afirmando que **"NFC-e autorizada" NÃO aparece**
na tela. Nenhum protocolo nem chave é fabricado no cliente — os valores exibidos
vêm literalmente do corpo da resposta.

**Um defeito real que os testes pegaram:** em `ExpedicaoPage`, recarregar a
situação do pedido depois de uma conferência chamava `setErro('')`, o que
**apagava a mensagem de divergência antes do operador ler**. A divergência
continuava gravada no banco, mas sumia da tela. Corrigido com o parâmetro
`manterErro` — recarregar não pode limpar um resultado que acabou de acontecer.

---

## 5. NÃO IMPLEMENTADO (fora do escopo, registrado)

- Integração real com Melhor Envio / Correios em produção (ver 4.1).
- DANFE em PDF para NFC-e de balcão.
- Coluna `movimentacoes.venda_id` (ver 4.2).
- **Nada de P2 foi implementado**, conforme a instrução.

---

## 6. MIGRATIONS

**Uma migration nova:** `db/migrations/0024_p1_comercial_logistica.sql`,
espelhada integralmente em `db/schema.sql`. Total do repositório: **24**.

Seções:

| | Conteúdo |
|---|---|
| A | `listas_preco`, `lista_preco_itens`, `listas_preco_historico` |
| B | `propostas`, `proposta_itens`, `proposta_eventos` |
| C | `pdv_caixas`, `pdv_caixa_movimentos`, `pdv_pagamentos` |
| D | `envios`, `envio_eventos` |
| E | `expedicao_eventos`, `divergencias_conferencia` |
| F | `devolucoes`, `devolucao_itens` |
| G | `compra_recebimentos`, `compra_recebimento_itens`, função `brobond_qtd_recebida_item`, CHECK `itens_compra_nao_excede_pedido` |
| H | Colunas aditivas em `vendas` (`proposta_id`, `pdv_caixa_id`, `envio_id`, `expedicao_etapa`, `canal_venda`), `itens_compra.quantidade_recebida`, `compras.recebida_em` |
| — | Trigger `brobond_herdar_empresa` em **12 tabelas-filhas** + índices `(empresa_id, …)` |

**Verificado:** a migration roda em banco **vazio** (`brobond_schema`), e
`db/schema.sql` aplicado do zero produz **85 tabelas** em `brobond_p1`.

### Garantias que o banco impõe sozinho (provadas em `pg-p1.test.ts`)

| Constraint / índice | O que impede |
|---|---|
| `itens_compra_nao_excede_pedido` | receber mais do que foi pedido |
| `itens_compra_recebida_valida` | `quantidade_recebida > quantidade` |
| `propostas_convertida_tem_pedido` | proposta `convertida` sem pedido |
| `uq_vendas_proposta` (parcial) | duas vendas da mesma proposta |
| `uq_pdv_caixas_aberto` (parcial, por empresa) | dois caixas abertos com o mesmo número |
| `uq_envios_idempotency` / `uq_envios_venda_vivo` | envio duplicado / dois envios vivos por venda |
| `envios_postado_tem_prova` | envio "postado" sem rastreio nem referência |
| `uq_lista_preco_item` | dois preços para o mesmo produto na mesma lista |
| `listas_preco_vigencia_coerente` | vigência com fim antes do início |
| `uq_devolucao_item` | o mesmo item duas vezes na mesma devolução |
| `devolucoes_recebida_tem_autorizacao` | devolução recebida sem autorização |
| `devolucao_itens_recebida_valida` | receber mais do que foi devolvido |
| `trg_empresa_*` (12 tabelas) | filha nascer sem empresa ou na empresa errada |

**Honestidade sobre o CHECK de recebimento:** `brobond_qtd_recebida_item` é
marcada `IMMUTABLE` porque o Postgres não aceita `STABLE` em CHECK. Ela **não**
é dobrada em constante (o argumento é referência de coluna), mas o CHECK só é
reavaliado quando a linha de `itens_compra` é tocada. **Um CHECK de linha não é
guarda suficiente contra over-receipt.** A guarda primária é o CAS
(`tryUpdateIf`) em `itens_compra.quantidade_recebida` no app; o CHECK é a
segunda camada.

---

## 7. TESTES

### 7.1 Números medidos

| Checagem | Comando | Resultado |
|---|---|---|
| Typecheck completo | `npm run typecheck` | **limpo** (domain + server + client) |
| Suíte server (memória) | `npm --workspace server test` | **475 / 464 pass / 0 fail / 11 skipped** |
| Suíte client (inclui as 5 telas P1) | `npm --workspace client test` | **81 pass / 11 arquivos** |
| PostgreSQL real, arquivo por arquivo | `for f in test/pg-*.test.ts; do tsx --test $f; done` | **37 / 37 pass** |
| Lint | `npm run lint` | **0 erros**, 356 warnings (`no-explicit-any`, pré-existentes) |
| Build | `npm run build` | **OK**, PWA gerado |
| Smoke test ponta a ponta (HTTP real) | `node scripts/smoke-e2e.mjs` contra o Express bootado | **22 / 22 verificações** |

PostgreSQL 18.4 real (`@embedded-postgres/linux-x64`), banco `brobond_p1`.

**12 casos da suíte de memória da P0 só passam sem `DATABASE_URL`.** Isso não é
regressão desta fase — é o estado da base. Medido nos dois pontos:

| | base `fe344b3` | esta branch |
|---|---|---|
| `tsx --test test/*.test.ts` com `DATABASE_URL` | 371 tests / 359 pass / **12 fail** | 501 tests / 489 pass / **12 fail** |
| delta | — | **+130 tests, +130 pass, +0 fail** |

Os 12 nomes são idênticos nos dois pontos. **A origem não são os `pg-*.test.ts`**
— estes seis passam sempre, isolados ou juntos. As falhas estão em arquivos da
suíte de memória, e só aparecem quando `DATABASE_URL` troca o store para
Postgres:

| Arquivo | Falhas sob PG | Sem `DATABASE_URL` |
|---|---|---|
| `test/fiscal.test.ts` | 6 | 19 / 19 pass |
| `test/variacoes.test.ts` | 5 | pass |
| `test/multiempresa.test.ts` | 1 | pass |

O erro é sempre o mesmo padrão — `TypeError: Cannot read properties of
undefined (reading 'id')` em `fiscal.test.ts:259`, dentro de `montarCenario`:

```ts
const tamanho = (await s.list(RESOURCES.tamanhos, { page: 1, pageSize: 1 })).rows[0];
await s.adjustStock(Number(produto.id), Number(tamanho.id), LOCAL, 50);
```

O cenário pega **a primeira linha de `tamanhos`** e assume que é a que ele mesmo
acabou de semear. Contra o memdb vazio isso é verdade; contra um Postgres que já
tem linhas de outros testes, não é. É fragilidade de fixture, não defeito de
regra de negócio — e não foi introduzido nesta fase.

O que esta fase prova é o **delta**: +130 casos, +130 aprovações, zero falha
nova.

**Mas essa combinação não é como o projeto roda a suíte.** Os dois runners estão
separados de propósito em `server/package.json`:

```json
"test":    "node --import tsx --test test/*.test.ts",     // memória, sem DATABASE_URL
"test:pg": "node --import tsx --test test/pg-*.test.ts"   // Postgres real
```

E o CI (`.github/workflows/ci.yml`) respeita essa separação: o job `verificar`
roda `npm --prefix server test` **sem `DATABASE_URL`** (a única referência a ela
nesse job é um placeholder isolado no passo `prisma validate`, que não conecta
no banco); o job `testes-postgres` é que define `DATABASE_URL` no nível do job e
roda `npm --prefix server run test:pg` — só os `pg-*.test.ts`.

Ou seja: rodar `test/*.test.ts` **com** `DATABASE_URL` é uma invocação que o
projeto não faz. Os 12 casos não estão quebrados no caminho que o CI percorre.
Foi eu quem cruzou os dois runners ao medir a não-regressão — e o delta acima
continua válido justamente porque a base e a branch foram medidas do mesmo jeito.

**Como os testes PostgreSQL são verificados, então.** Pelo runner do projeto,
`npm --prefix server run test:pg`, com banco recriado do zero:
2 + 2 + 9 + 7 + 4 + 13 = **37/37**.

**Smoke test ponta a ponta.** Nenhum teste unitário cobre o boot do Express, o
wiring de rotas e a cadeia de middleware. Por isso o servidor foi subido de
verdade (`PORT=3001 npx tsx src/index.ts`) e as rotas da P1 foram chamadas por
HTTP, com login real. As 22 verificações atravessam o fluxo completo de acesso
e depois cada superfície nova:

| O que foi provado por HTTP | Resultado |
|---|---|
| Login exige MFA do admin; cadastro TOTP real e `login/mfa` devolvem token | 4 PASS |
| `bloquearSenhaProvisoria` recusa escrita com `code: SENHA_PROVISORIA` | 1 PASS |
| Troca de senha e relogin com senha definitiva + MFA | 2 PASS |
| §6 `GET`/`POST /listas_preco` (201) | 2 PASS |
| §7 `GET /propostas` | 1 PASS |
| §8 `GET /pdv/caixas/aberto`, `POST /pdv/caixas` (201) e **segundo caixa → 409** | 3 PASS |
| §13 `GET /logistica/config`, ativar Melhor Envio **sem credencial → 409**, `manual → 200`, `GET /envios` | 4 PASS |
| §14/§15/§16 `GET /expedicao/divergencias`, `/devolucoes`, `/compras` | 3 PASS |
| §17 `GET /suprimentos/sugestao-compra` devolve `automatico: false` | 1 PASS |
| Sem token → 401; **ticket de MFA não vale como token de acesso** → 401 | 2 PASS |

O 409 de "segundo caixa aberto" e o 409 de "provedor sem credencial" valem mais
do que os 200: são os dois lugares onde seria fácil o sistema mentir dizendo que
fez.

### 7.2 Testes novos da P1 — 172 casos

| Arquivo | Casos | Cobre |
|---|---|---|
| `listas-preco.test.ts` | 10 | §6 resolução, vigência, prioridade, histórico, preço persistido no item |
| `propostas.test.ts` | 14 | §7 transições, expiração, conversão idempotente |
| `pdv.test.ts` | 21 | §8 caixa, recálculo no servidor, pagamento, troco, cancelamento |
| `logistica.test.ts` | 26 | §13 cotação, envio, rastreio, credencial ausente, rollback |
| `expedicao.test.ts` | 20 | §14 etapas, divergência; §15 devolução ponta a ponta |
| `compras.test.ts` | 17 | §16 aprovação, recebimento parcial, idempotência; §17 sugestão |
| `multiempresa-p1.test.ts` | 9 | §19 as duas superfícies corrigidas + listas, propostas, consolidação |
| **`pg-p1.test.ts`** | **12** subtestes | **§20 constraints e unicidades em Postgres real** |
| `PdvPage.test.tsx` | 11 | §8 prévia ≠ total do servidor, caixa obrigatório, preço manual, troco, **NFC-e autorizada/rejeitada/falha** |
| `ExpedicaoPage.test.tsx` | 6 | §14 esteira sem pular etapa, leitura, divergência auditada |
| `SugestaoCompraPage.test.tsx` | 7 | §17 `automatico:false`, revisão de qtd, pedido nasce pendente |
| `DevolucoesPage.test.tsx` | 8 | §15 ações vindas do servidor, rastreio obrigatório, só `bom` volta ao estoque |
| `LogisticaPage.test.tsx` | 11 | §13 503 sem credencial, token mascarado, 409 ao ativar sem credencial, envio idempotente |

### 7.3 Idempotência e concorrência (§20)

- **NF:** `uq_documentos_fiscais` + estado (P0, re-verificado).
- **Proposta:** três camadas — UNIQUE `propostas.venda_id`, índice parcial
  `uq_vendas_proposta`, `tryUpdateIf` no status. Testado em memória e em PG.
- **Recebimento de compra:** chave explícita ou derivada
  (`recebimento:compra:<id>:<itemId>x<qtd>,…`); repetição devolve 200 com
  `{idempotente:true}` e **não** sobe o estoque duas vezes.
- **Envio:** `idempotency_key` (default `envio:venda:<id>`), 201 depois 200.
- **Pagamento/estoque:** cobertos por `pg-concorrencia.test.ts` (P0) —
  "duas saídas concorrentes do mesmo saldo: exatamente uma vence".

---

## 8. ENDPOINTS

### Listas de preço
`GET /api/listas-preco/resolver` · `GET|PUT /api/listas-preco/:id/itens` ·
`DELETE /api/listas-preco/:id/itens/:produtoId` · `GET /api/listas-preco/:id/historico`

### Propostas
`POST /api/propostas` · `GET /api/propostas/:id` ·
`GET|POST /api/propostas/:id/itens` · `GET /api/propostas/:id/eventos` ·
`POST /api/propostas/:id/{enviar,aprovar,recusar,cancelar,converter}`

### PDV
`POST /api/pdv/caixas` · `GET /api/pdv/caixas/aberto` ·
`GET /api/pdv/caixas/:id/resumo` · `POST /api/pdv/caixas/:id/movimentos` ·
`POST /api/pdv/caixas/:id/fechar` · `GET /api/pdv/buscar` ·
`POST /api/pdv/vendas` · `POST /api/pdv/vendas/:id/cancelar` ·
`GET /api/pdv/vendas/:id/pagamentos`

### Logística
`GET|PUT /api/logistica/config` · `GET /api/logistica/frete` ·
`GET /api/envios/rastreio/:codigo` · `GET /api/envios/:id/eventos` ·
`POST /api/envios/:id/{rastrear,status,cancelar}` · `GET|POST /api/vendas/:id/envio` · `POST /api/vendas/:id/fiscal/emitir`
(mesmo endpoint da NF-e, com `modelo:'65'` para NFC-e)

### Expedição e devolução
`GET /api/vendas/:id/expedicao` ·
`POST /api/vendas/:id/expedicao/{separar,conferir,embalar,expedir}` ·
`GET /api/expedicao/divergencias` · `POST /api/expedicao/divergencias/:id/resolver` ·
`POST /api/devolucoes` · `GET /api/devolucoes/:id` ·
`POST /api/devolucoes/:id/{autorizar,rastreamento,receber,recusar,cancelar}`

### Compras
`POST /api/compras/:id/aprovar` · `GET /api/compras/:id/recebimentos` ·
`POST /api/compras/:id/receber` ·
`GET /api/suprimentos/sugestao-compra` · `POST /api/suprimentos/sugestao-compra/gerar`

---

## 9. ARQUIVOS

**Novos (27):**
```
db/migrations/0024_p1_comercial_logistica.sql
server/src/compras.ts            server/src/expedicao.ts
server/src/listasPreco.ts        server/src/logistica.ts
server/src/pdv.ts                server/src/propostas.ts
server/test/_p1util.ts
server/test/compras.test.ts      server/test/expedicao.test.ts
server/test/listas-preco.test.ts server/test/logistica.test.ts
server/test/multiempresa-p1.test.ts
server/test/pdv.test.ts          server/test/pg-p1.test.ts
server/test/propostas.test.ts
client/src/pages/PdvPage.tsx     client/src/pages/ExpedicaoPage.tsx
client/src/pages/SugestaoCompraPage.tsx
client/src/pages/DevolucoesPage.tsx
client/src/pages/LogisticaPage.tsx
client/src/pages/PdvPage.test.tsx
client/src/pages/ExpedicaoPage.test.tsx
client/src/pages/SugestaoCompraPage.test.tsx
client/src/pages/DevolucoesPage.test.tsx
client/src/pages/LogisticaPage.test.tsx
scripts/smoke-e2e.mjs
```

**Alterados (13) — extensão aditiva, sem reescrita:**
```
client/src/modules.ts    client/src/pages/ModulePage.tsx
db/schema.sql
server/src/approval.ts   server/src/index.ts
server/src/itens.ts      server/src/memdb.ts
server/src/pgstore.ts    server/src/prediction.ts
server/src/resources.ts  server/src/services.ts
server/src/suprimentos.ts server/src/validate.ts
```
`13 files changed, 1460 insertions(+), 55 deletions(-)` (`git diff --shortstat`).

**17 recursos novos** em `resources.ts`: `listas_preco`, `lista_preco_itens`,
`listas_preco_historico`, `propostas`, `proposta_itens`, `proposta_eventos`,
`pdv_caixas`, `pdv_pagamentos`, `pdv_caixa_movimentos`, `envios`,
`envio_eventos`, `expedicao_eventos`, `divergencias_conferencia`,
`devolucoes`, `devolucao_itens`, `compra_recebimentos`,
`compra_recebimento_itens`.

---

## 10. INTEGRAÇÕES EXTERNAS

| Integração | Estado real |
|---|---|
| **Melhor Envio** | Adapter escrito contra a API pública documentada. **Testado apenas com test double.** Sem credencial e sem rota de rede neste ambiente. |
| **Correios** | Adapter escrito; `gerarEnvio` e `cancelar` devolvem `nao_configurado`. **Testado apenas com test double.** |
| **Consulta de CEP** | Já existia (`cep.ts` / `frete.ts`); não foi alterada. |
| **SEFAZ / NF-e** | Já existia atrás de `FiscalProvider` (P0). Não houve simulação de autorização nesta fase. |

**Credenciais:** nunca no código. Ficam em `logistica_config:<empresaId>`, com
`me_token` e `correios_senha` **criptografados** via `SEGREDOS_ENCRYPTION_KEY`
(ou derivado de `JWT_SECRET`). Faltando a chave, o endpoint responde 503 — não
inventa envio.

**Nenhum mock em produção. Nenhum protocolo, chave de acesso ou autorização
fiscal fabricados.**

---

## 11. RISCOS

1. **Adapters de frete não validados contra o provedor real** (4.1). Risco de o
   payload ser rejeitado em produção. Mitigação: contrato único, test doubles e
   o CHECK `envios_postado_tem_prova`.
2. **`movimentacoes` sem `venda_id`** (4.2). Filtro inexistente é ignorado em
   silêncio — teste pode dar falso positivo.
3. **CHECK `IMMUTABLE`** que lê tabela (6). Se alguém remover o CAS do app, o
   banco sozinho não segura over-receipt em todos os caminhos.
4. **12 fixtures da P0 assumem banco vazio** (7.1). `fiscal.test.ts`,
   `variacoes.test.ts` e `multiempresa.test.ts` pegam "a primeira linha" de
   `tamanhos`. Não afeta o CI — que separa `test` (memória) de `test:pg`
   (Postgres) — mas quem rodar a suíte de memória com `DATABASE_URL` vai ver
   vermelho e pode confundir com regressão.
5. **Tela de logística depende de credencial para ser exercitada de ponta a
   ponta** (4.1). O caminho `manual` funciona sem integração; Melhor Envio e
   Correios só foram validados com test doubles.
6. **`sort:'id'`** com tiebreak `b.id - a.id` ignora `dir` em empate. Deliberado,
   registrado, não corrigido.
7. **356 warnings de lint** (`no-explicit-any`), todos pré-existentes.

---

## 12. ADERÊNCIA À SPEC

| § | Requisito | Aderência |
|---|---|---|
| 3 | Produto completo | ✅ já existia, não duplicado |
| 4 | Clientes PF/PJ com validação no backend | ✅ já existia |
| 5 | Fornecedores | ✅ já existia |
| 6 | Listas de preço | ✅ implementado |
| 7 | Propostas com conversão idempotente | ✅ implementado |
| 8 | PDV com recálculo no servidor | ✅ implementado (backend + tela) |
| 9–10 | NF-e/NFC-e real, sem simulação | ✅ já existia; nada simulado |
| 11 | NF-e de entrada por XML | ✅ já existia |
| 12 | De-para fornecedor × SKU | ✅ já existia |
| 13 | Logística com adapter e credencial segura | ⚠️ parcial — código e tela prontos; falta provedor real (4.1) |
| 14 | Packing/conferência | ✅ implementado (backend + tela) |
| 15 | Devolução com rastreabilidade | ✅ implementado (backend + tela) |
| 16 | Compras com recebimento parcial | ✅ implementado |
| 17 | Sugestão sem gerar compra automaticamente | ✅ implementado (`automatico:false`, backend + tela) |
| 18 | Integridade transacional | ✅ já existia, estendida |
| 19 | Re-auditoria multiempresa | ✅ 2 vazamentos fechados |
| 20 | Testes obrigatórios | ✅ 172 casos novos (129 servidor/memória + 43 de tela); 37 em PG real |
| 21 | Migration + testes + typecheck + lint + build | ✅ todos verdes; não-regressão medida contra a base (+130/+130/+0) |
| 22 | Não avançar para P2 | ✅ nada de P2 foi feito |
| 23 | Este relatório | ✅ |

---

## 13. BUGS ENCONTRADOS E CORRIGIDOS

Além do código novo, a auditoria achou defeitos reais — inclusive anteriores à P1:

**Multiempresa (§19) — dois vazamentos que existiam antes desta fase:**
- `approval.ts`: `listAprovacoes` listava sem `empresa_id`; `aprovarPedido` e
  `rejeitarPedido` faziam `s.get` sem `assertRegistroDaEmpresa`;
  `countAprovacoes` contava o banco inteiro. **O gerente da Empresa A aprovava e
  rejeitava pedidos da Empresa B.** Corrigido com 404 (não 403, para não
  confirmar existência).
- `prediction.ts`: nove consultas sem recorte. A previsão de demanda e de
  insumos calculava com vendas, estoque, OPs e fichas técnicas de **todas** as
  empresas.

**Fase P1:**
- `logistica.ts`: checagem de credencial hardcoded para dois provedores →
  mapa `CREDENCIAL_DO_PROVEDOR`; `atualizarStatusEnvio` ignorava
  `codigo_rastreamento` enviado na mesma requisição; `inferirStatus` não
  reconhecia "Em trânsito" simples.
- `expedicao.ts`: a divergência de conferência era apagada pelo rollback da
  transação; a guarda de devolução excessiva era pulada sem `item_venda_id`;
  devoluções recusadas/canceladas bloqueavam novas.
- `itens.ts` / `suprimentos.ts`: escopo multiempresa faltando.
- `memdb.ts` / `pgstore.ts`: `sort:'id'` era silenciosamente ignorado pelos dois
  stores.
**Client (achado pelos testes de tela desta fase):**
- `ExpedicaoPage.tsx`: recarregar a situação do pedido chamava `setErro('')` e
  **apagava a mensagem de divergência da tela** antes do operador ler. O
  registro continuava no banco, mas a operação ficava cega. Corrigido com
  `carregarSituacao(id, manterErro)`.

- Classe de bug **coluna não declarada**: os dois stores montam a lista de
  colunas do INSERT/UPDATE a partir de `columnsOf(resource)` — qualquer coluna
  real ausente de `resources.ts` é **descartada em silêncio**. Todas as lacunas
  da P1 foram declaradas. Só `envios.etiqueta_pdf` (BYTEA, zero referências)
  permanece não declarada, de propósito.

---

## 14. COMO REPRODUZIR

```bash
npm install                                    # node_modules não é versionado
npm run typecheck                              # domain + server + client
npm --workspace server test                    # 475 / 464 / 0 / 11
npm --workspace client test                    # 81 / 11 arquivos
npm run lint                                   # 0 erros
npm run build

# PostgreSQL real (banco vazio, schema do zero)
createdb brobond_p1
psql -d brobond_p1 -f db/schema.sql            # 85 tabelas
# PostgreSQL real — arquivo por arquivo (ver 7.1): 37 / 37
for f in server/test/pg-*.test.ts; do
  node --import tsx --test "$f"
done

# Smoke test ponta a ponta — servidor real, HTTP de verdade (ver 7.1)
PORT=3001 npx tsx server/src/index.ts &
node scripts/smoke-e2e.mjs                        # 22/22

# Não-regressão medida contra a base (ver 7.1):
#   git worktree add /tmp/base fe344b3
#   DATABASE_URL=… tsx --test /tmp/base/server/test/*.test.ts   # 371/359/12
#   DATABASE_URL=… tsx --test server/test/*.test.ts             # 501/489/12
```

---

## 15. O QUE FALTA PARA DECLARAR P1 CONCLUÍDA

As cinco telas (PDV + NFC-e, Expedição, Sugestão de compra, Devolução,
Logística) foram construídas e testadas nesta fase. Todo fluxo da P1 já tem
operação guiada. Restam três itens e nenhum deles é "código que falte escrever":

1. **Validação dos adapters de frete contra provedor real**, com credencial de
   homologação. A tela, a API, a cotação, a geração, o rastreio e o rollback
   estão prontos e testados — o que falta é apontar para o Melhor Envio ou
   Correios de verdade. Depende de saída de rede e de credencial, indisponíveis
   neste ambiente. **É o único item que impede considerar §13 fechado.**
2. **Coluna `movimentacoes.venda_id`** + backfill. Decisão de schema adiada de
   propósito para não tocar em tabela estável dentro da P1. Hoje o vínculo é
   `motivo = 'Venda #<id>'`, e `filter:{venda_id}` é ignorado em silêncio pelos
   dois stores.
3. **12 fixtures da P0 que assumem banco vazio** (ver 7.1). Não afeta o CI, que
   separa os dois runners. Melhorar é trocar essas fixtures por cenários que
   semeiem o próprio registro em vez de pegar "a primeira linha" — trabalho de
   infra de teste da P0, fora do escopo da P1.
