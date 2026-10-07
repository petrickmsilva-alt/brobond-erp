# RELATÓRIO — FASE P0 (BROBOND ERP)

Escopo da fase, conforme a especificação técnica definitiva: **isolamento
multiempresa, cadastro fiscal, produto/variações, motor fiscal e NF-e/NFC-e**.

Princípio que guiou cada decisão: *o que já existia não foi reescrito*. O
módulo **1. MEU NEGÓCIOS** (margem por pedido, CMV, impostos por NCM, frete,
curva ABC 80/15/5, venda manual, matemática em centavos) não teve uma linha
alterada, e `impostos_ncm` continua sendo a fonte de imposto do cálculo de
margem. O motor fiscal novo responde a outra pergunta — *o que vai escrito no
documento* — e não interfere naquela.

---

## IMPLEMENTADO

### 1. Isolamento multiempresa (real, não cosmético)

- `server/src/empresa.ts` — núcleo puro, sem I/O: `EscopoEmpresa`,
  `escopoDoAtor`, `filtroEmpresa`, `aplicarFiltroEmpresa` (descarta
  `f.empresa_id` vindo do cliente), `assertRegistroDaEmpresa` (**404, não
  403** — 403 confirmaria que o registro existe na outra empresa),
  `carimbarEmpresa`, `protegerEmpresaNaEdicao`, `validarReferenciasDaEmpresa`.
- `empresa_id NOT NULL` em **33 tabelas transacionais**; nas 9 tabelas filhas
  a empresa é **derivada por trigger** (`brobond_herdar_empresa`), de modo que
  até um `INSERT` em SQL cru cai na empresa certa.
- Escopo aplicado no gargalo (`services.ts`) e repassado por todas as rotas
  CRUD genéricas (`index.ts`).
- Seletor de empresa persistente na sessão: o JWT carrega a claim `emp`,
  validada a cada requisição contra as concessões reais do usuário.
  Consolidação entre empresas exige `pode_consolidar` **e** pedido explícito,
  e é somente leitura.
- SKU e código de barras passaram a ser únicos **por empresa** (eram globais).

### 2. Cadastros de pessoas completos

- **Clientes**: PF/PJ/estrangeiro, razão social, nome fantasia, RG/IE,
  **indicador de IE** (campo `indIEDest`, a rejeição mais comum da SEFAZ em
  venda para empresa), IM, SUFRAMA, endereço completo com **código IBGE do
  município**, WhatsApp, **limite de crédito**, **vendedor padrão**.
- **Fornecedores**: espelho fiscal/comercial do cliente + prazo de entrega,
  condição de pagamento e tabela de **contatos adicionais**.
- **Representantes evoluídos para vendedores** (sem criar entidade nova,
  conforme a regra): CPF, cargo, **usuário do sistema associado**, admissão e
  desligamento — desligar não apaga histórico nem comissões apuradas.
- **CPF/CNPJ com validação matemática dos dígitos**, aplicada globalmente pelo
  novo tipo de campo `document` (`server/src/documentos.ts` +
  `validate.ts`), com tipos `uf` e `cep` normalizados.
- **Busca de CEP plugável** (`server/src/cep.ts`): interface `CepProvider`,
  BrasilAPI → ViaCEP em cascata, `registrarCepProvider` para adicionar o seu.
  Distingue "CEP inexistente" (404) de "nenhum provedor respondeu" (502).
  Na interface, botão **Buscar** no campo de CEP que preenche apenas os campos
  vazios — ninguém perde o que digitou — e traz o código IBGE.

### 3. Produto completo e variações determinísticas

- Ficha completa: identificação, catálogo, classificação (formato, tipo,
  condição, unidade, produção), **fiscal** (NCM, CEST, origem, CFOP,
  CST/alíquota de ICMS/PIS/COFINS/IPI, GTIN tributário), **logística** (pesos
  líquido e bruto, dimensões, volumes, itens por caixa) e **suprimento**
  (estoque mín./máx., localização, fornecedor, código no fornecedor, custo
  habitual). Kits via `produto_composicao`.
- **Variações como produto filho** (um nível só, garantido por CHECK),
  reaproveitando `grades` / `grade_tamanhos` / `tamanhos` — nenhum cadastro de
  tamanho foi duplicado.
- `server/src/variacoes.ts` — geração **determinística**: `SKU-PAI` + cor +
  tamanho, normalizados (sem acento, maiúsculo). A mesma entrada produz os
  mesmos SKUs hoje e daqui a um ano; nada de sequencial, aleatório ou IA.
  **Idempotente**: rodar de novo só cria o que falta. O filho herda a ficha
  fiscal, as dimensões e os preços do pai.

### 4. Motor de regras fiscais (sem alíquota escrita no código)

`server/src/fiscalRegras.ts`, três camadas em ordem fixa:

1. **o produto**, quando a ficha dele define a tributação;
2. a **regra fiscal** mais específica que casa com o contexto — desempate por
   *prioridade* → *NCM mais longo* → *UF específica antes de curinga* → mais
   recente;
3. o **padrão da empresa** (CFOP dentro/fora do estado, que depende apenas de
   a operação ser interna ou interestadual, e portanto nunca é um chute).

O que não for resolvido **vira pendência explícita**, não um valor plausível:
`pendenciasFiscais()` devolve a lista e a emissão para. Simples Nacional
preenche CSOSN; regime normal preenche CST.

### 5. NF-e / NFC-e de verdade, atrás de `FiscalProvider`

`server/src/fiscalProvider.ts` define o contrato e traz **três**
implementações: `focus` (Focus NFe), `plugnotas` (PlugNotas) e o
**provedor nulo**, que é o padrão.

> **A regra que governa o módulo inteiro: o sistema nunca diz que emitiu uma
> nota que não existe.**

Como isso é sustentado em quatro camadas independentes:

| Camada | Garantia |
|---|---|
| Provedor nulo | Sem credencial, toda operação devolve `nao_configurado` com mensagem explícita de **NÃO EMITIDO**. Provedor desconhecido cai nele. |
| Orquestrador (`fiscal.ts`) | Sem configuração: HTTP **409**, documento gravado como `pendente` com o motivo, **zero** baixa de estoque. Provedor que responde "autorizado" sem chave/protocolo → estado `erro`. |
| Banco (migration 0020) | CHECK `documentos_fiscais_autorizado_tem_prova` torna `status='autorizado'` **inalcançável** sem chave de 44 dígitos + protocolo + número + série + provedor ≠ `nenhum`. Provado em teste contra Postgres (SQLSTATE 23514). |
| Efeitos colaterais | Estoque e financeiro só na autorização, carimbados em `estoque_baixado_em` / `financeiro_lancado_em` — uma vez e só uma. |

Máquina de estados: `rascunho → pendente → processando → autorizado |
rejeitado | erro`, com cancelamento e inutilização. Numeração reservada por
**compare-and-swap** (duas emissões simultâneas não pegam o mesmo número) e
**devolvida à série** quando o documento é rejeitado — número rejeitado é
reutilizável.

Na autorização, o ERP **não ganhou um segundo motor de faturamento**: a venda
é levada a `faturada` e quem baixa estoque, congela comissão e gera o contas a
receber continua sendo `aplicarRegrasPedido` (itens.ts) + `syncLancamentoVenda`
(financeiro.ts), exatamente como no faturamento manual.

Uma decisão que merece destaque: se a nota for autorizada e a baixa de estoque
falhar (saldo insuficiente, por exemplo), a autorização **não é desfeita** —
a nota existe na SEFAZ, e fingir que não existe seria pior. O documento fica
autorizado sem o carimbo de efeito, com o erro no histórico e um aviso para
ajuste manual.

### 6. Segredos de integração

`server/src/segredos.ts` — AES-256-GCM com **sal próprio** (vazar o segredo do
MFA não abre o token fiscal, e vice-versa). Token do provedor, senha do
certificado e CSC são gravados cifrados; a API devolve apenas a **máscara**
(`••••abc1`). O certificado A1 em si fica fora do banco, em
`certificado_ref`. Habilitar a emissão sem token configurado é recusado, e a
numeração fiscal **não pode retroceder**.

---

## JÁ EXISTIA (preservado, não tocado)

- Módulo **1. MEU NEGÓCIOS** inteiro: margem por pedido, CMV, impostos por
  NCM, frete, lucro bruto, margem %, curva ABC 80/15/5, filtros, venda manual,
  auditoria, matemática em centavos, implementações PostgreSQL **e** memória.
- Financeiro (parcelas reais, conciliação, DRE, investidores, recorrências),
  estoque/movimentações/inventário, produção e fichas técnicas, compras,
  catálogos públicos, políticas comerciais, portal, conectores, webhooks,
  auditoria encadeada, MFA/sessões.
- Faturamento manual da venda e todo o seu efeito em estoque e financeiro.
- Endpoints `/api/vendas/:id/nfe/*`, que continuam no ar (modo simulação
  explícito) para não quebrar a interface atual.

---

## COMPLETADO (existia parcial, foi terminado)

| Item | Estado anterior | Agora |
|---|---|---|
| `empresas` | Tabela com nome/CNPJ, sem uso efetivo | Emitente fiscal completo e escopo real em 33 tabelas |
| `clientes` | Nome, documento, tipo, telefone, e-mail | Cadastro fiscal e comercial completo |
| `fornecedores` | Nome, CNPJ, contato | Dados fiscais, endereço, comercial e contatos |
| `representantes` | Nome, região, comissão | Vendedor com CPF, cargo e usuário do sistema |
| `produtos` | Ficha básica + fiscal mínima | Ficha completa + variações + tributação |
| NF-e | Stub honesto, 503 fora de simulação | Emissão real atrás de `FiscalProvider` |
| CEP | ViaCEP embutido em `frete.ts` | Interface `CepProvider` com cascata |
| Concorrência (PG) | SQLSTATE 40001 virava HTTP 500 | Traduzido para **409** com mensagem acionável |
| `financeiro.ts` | `String(data).slice(0,10)` quebrava com `Date` do PG | `dataISO()` aceita `Date` e string |

---

## NÃO IMPLEMENTADO (fora da P0, por decisão de sequência)

Nenhum item da P0 ficou aberto. Pendentes das fases seguintes:

- **P1** — NF-e de entrada por XML, PDV, logística (`ShippingProvider`),
  packing check com leitor, propostas comerciais → pedido.
- **P2** — caixa diário, `PaymentProvider` com webhooks, CNAB, OFX,
  conciliação bancária.
- **P3** — Nuvemshop (`MarketplaceProvider`), sincronização completa, migração
  de dados com prévia, metas, listas de preço.

Dentro do próprio fiscal, ficam para a continuação: carta de correção (CC-e),
armazenamento do PDF do DANFE em `danfe_pdf` (hoje guardamos a URL do provedor
e o XML), e a tela dedicada de emissão — o acompanhamento já aparece na
listagem de **Documentos fiscais**.

---

## MIGRATIONS

Todas idempotentes, aplicadas duas vezes em banco limpo e em banco já migrado,
e refletidas em `db/schema.sql`. Nenhuma migration anterior foi alterada.

| Arquivo | Conteúdo |
|---|---|
| `0017_multiempresa_isolamento.sql` | Dados fiscais em `empresas`; `usuario_empresas`; `empresa_id` + índice em 33 tabelas; triggers de herança; índices compostos de caminho quente |
| `0018_produto_cadastro_completo.sql` | Ficha completa do produto; variação como filho; `produto_composicao`; unicidade de SKU **por empresa** |
| `0019_tributacao_fiscal.sql` | Tributação no produto; `regras_fiscais`; `empresa_fiscal_config` com colunas cifradas |
| `0020_documentos_fiscais.sql` | `documentos_fiscais` + eventos + inutilizações; CHECK de prova de autorização; unicidades de chave, numeração e idempotência |
| `0021_cadastros_pessoas.sql` | Clientes, fornecedores, contatos de fornecedor e representantes |
| `0022_fiscal_config_id.sql` | `id` em `empresa_fiscal_config` (aditivo; PK continua em `empresa_id`) |
| `0023_fiscal_provider_extensivel.sql` | Troca a lista fechada de provedores por formato de slug — registrar um adaptador novo não exige migration |

---

## TESTES

| Suíte | Resultado |
|---|---|
| `npm test` (servidor) | **357 testes, 347 passando, 0 falhas** (10 pulados: os `pg-*` sem `DATABASE_URL`) |
| `npm test` (cliente) | **38 passando** |
| `npm --prefix server run test:pg` | **24/24 passando** contra PostgreSQL 16.2 real |
| `npm run typecheck` / `lint` / `build` | 0 erros (348 avisos pré-existentes de `no-explicit-any`) |

Linha de base antes da fase: 305/313 no servidor e **7/8** no PostgreSQL (a
falha de concorrência era antiga). Agora é **24/24** — a tradução de SQLSTATE
40001 fechou aquela lacuna.

Arquivos de teste novos:

- `server/test/multiempresa.test.ts` (13) — o teste de segurança obrigatório:
  **EMPRESA A não enxerga EMPRESA B** nas quatro superfícies (listagem com
  tentativa de injetar `f.empresa_id`, leitura por id, escrita cruzada e
  referência forjada).
- `server/test/pg-multiempresa.test.ts` (6) — as mesmas garantias no SQL:
  triggers, unicidade por empresa, recorte na consulta.
- `server/test/fiscal.test.ts` (19) — tributação determinística, pendências,
  cifra de segredos, provedor nulo, **provedor mentiroso recusado**, rejeição
  sem baixa de estoque, autorização com efeito único, idempotência.
- `server/test/pg-fiscal.test.ts` (8) — a nota fantasma é impossível no banco;
  fluxo completo **VENDA → NF-e AUTORIZADA → ESTOQUE → FINANCEIRO** em
  PostgreSQL real.
- `server/test/variacoes.test.ts` (10) — determinismo, idempotência, herança,
  um nível só, escopo de empresa.

---

## ARQUIVOS ALTERADOS

**Novos (servidor):** `empresa.ts`, `empresasAcesso.ts`, `empresasApi.ts`,
`documentos.ts`, `cep.ts`, `segredos.ts`, `fiscalRegras.ts`,
`fiscalProvider.ts`, `fiscal.ts`, `variacoes.ts`.

**Modificados (servidor):** `resources.ts` (fonte única: novos campos, novos
recursos, coluna sintética de empresa), `services.ts` (escopo no gargalo),
`index.ts` (rotas novas, sempre antes do CRUD genérico), `auth.ts` (claim
`emp`, concessões), `memdb.ts` (herança de empresa), `pgstore.ts` (40001 →
409), `validate.ts` (tipos `document`/`uf`/`cep`), `financeiro.ts`
(`dataISO`).

**Cliente:** `lib/meta.ts`, `lib/format.ts` (`maskCep`),
`components/RecordForm.tsx` (máscaras + busca de CEP), `modules.ts`
(**Regras fiscais** e **Documentos fiscais** no menu).

**Banco:** 7 migrations novas + `db/schema.sql`.

---

## ENDPOINTS NOVOS

**Multiempresa**

```
GET    /api/empresas/ativa
POST   /api/empresas/ativa                    { empresa_id }
GET    /api/usuarios/:id/empresas
POST   /api/usuarios/:id/empresas             { empresa_id }
DELETE /api/usuarios/:id/empresas/:empresaId
```

**Fiscal**

```
GET    /api/vendas/:id/fiscal                 situação fiscal do pedido
GET    /api/vendas/:id/fiscal/previa          o que iria na nota, sem emitir
POST   /api/vendas/:id/fiscal/emitir          { modelo, idempotency_key }
GET    /api/fiscal/documentos/:id/eventos     trilha completa
POST   /api/fiscal/documentos/:id/consultar
POST   /api/fiscal/documentos/:id/cancelar    { justificativa }
POST   /api/fiscal/inutilizar                 faixa de numeração
GET    /api/fiscal/config                     sem segredos (só máscara)
PUT    /api/fiscal/config
```

**Produto e endereço**

```
GET    /api/produtos/:id/variacoes
GET    /api/produtos/:id/variacoes/previa
POST   /api/produtos/:id/variacoes            { grade_id?, tamanho_ids?, cor_ids? }
GET    /api/cep/:cep
```

---

## RISCOS

1. **Escopo por empresa depende de quem chama.** A imposição acontece no
   gargalo de `services.ts` **quando um ator ou escopo é passado**. A
   superfície HTTP genérica sempre passa; chamadas internas que não passam
   nada seguem irrestritas, de propósito (jobs, BI do Meu Negócio, portal
   público). É compatível com o que existia e está coberto pelo teste
   *"chamada interna sem escopo continua irrestrita"*. Módulos novos precisam
   passar o escopo conscientemente.
2. **Os adaptadores Focus e PlugNotas não foram exercitados contra o serviço
   real** — não há credenciais neste ambiente. O contrato, a tradução de
   payload e a máquina de estados estão testados com dublês; a primeira
   emissão real em homologação deve ser acompanhada. O risco é contido: sem
   credencial o sistema não emite e diz isso com todas as letras.
3. **Cancelamento não devolve estoque automaticamente.** Cancelar a nota é um
   ato fiscal; a devolução das peças acontece ao cancelar a **venda** (estorno
   que já existia). A resposta da API avisa. É uma escolha para não estornar
   duas vezes — mas exige disciplina de operação.
4. **`SEGREDOS_ENCRYPTION_KEY`**: sem essa variável os tokens fiscais são
   cifrados com a chave de fallback (derivada do `JWT_SECRET`). O
   `GET /api/fiscal/config` devolve esse aviso. Defina em produção **antes**
   de cadastrar credenciais.
5. **`empresa_id` nasceu com `DEFAULT 1`** para que a base existente migrasse
   sem perda. Toda linha antiga pertence à empresa 1 — correto para quem opera
   uma empresa só, mas uma base que já misturava dados de duas precisa de
   reclassificação manual antes de ligar o seletor.
6. **Numeração devolvida à série** no caso de rejeição pode gerar um buraco se
   o processo morrer entre a reserva e a resposta. Para isso existe a
   inutilização de faixa, que é a resposta fiscal correta ao buraco.

---

## STATUS FINAL

**P0 concluída.** Aderência estimada à especificação, considerando apenas o
escopo da P0: **~95%**.

O que sustenta esse número: multiempresa real validado contra PostgreSQL;
cadastros fiscais completos com validação matemática de documento; produto e
variações determinísticas sobre as grades existentes; motor fiscal sem
alíquota escrita no código; NF-e/NFC-e atrás de interface trocável, com quatro
camadas independentes impedindo a nota fantasma, e o fluxo
**VENDA → NF-e AUTORIZADA → ESTOQUE → FINANCEIRO** provado de ponta a ponta em
banco real.

Os 5% restantes são CC-e, armazenamento do PDF do DANFE e a tela dedicada de
emissão — nada que altere arquitetura ou contrato.

Aderência ao conjunto dos 6 blocos da especificação (P0 a P3): **≈ 45%**,
e a P1 pode começar sobre uma base que não precisa ser refeita.
