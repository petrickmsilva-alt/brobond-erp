# BROBOND ERP 3.0 — AUDITORIA DE DUPLICIDADES

> **Regra aplicada:** tabela/estrutura só é classificada como duplicidade
> depois de provar o que cada uma guarda, quem escreve e quem lê. **Nenhuma
> tabela foi removida** nesta auditoria — remoção sem prova quebraria histórico.
> Cada achado recebe uma das quatro classificações pedidas:
> **DUPLICIDADE REAL** · **READ MODEL** · **BOUNDED CONTEXT** ·
> **LEGACY COMPATIBILITY**.

- **Data:** 2026-10-27 · **Branch:** `arena/72895db5-brobond-erp`
- **Base de evidência:** `db/schema.sql` (131 tabelas), `db/migrations/0001..0056`,
  `server/src/resources.ts` (116 recursos), `server/src/index.ts` (361 rotas),
  `docs/ERP-3.0-ARCHITECTURE-INVENTORY.json`.
- **Método:** para cada par candidato → (1) o que cada tabela guarda,
  (2) quem escreve, (3) quem lê, (4) existe fonte única?, (5) classificação e
  ação.

---

## 1. Sumário

| Classificação | Achados | Ação |
| --- | --- | --- |
| **DUPLICIDADE REAL** | **0** | — (nenhum par escreve o mesmo fato duas vezes) |
| **READ MODEL** (derivado, não é fonte) | 4 | Documentado como derivado; nunca escrita concorrente |
| **BOUNDED CONTEXT** (mesmo nome, domínios distintos) | 6 | Mantidos separados de propósito |
| **LEGACY COMPATIBILITY** | 3 | Mantidos; remoção exige migração de dados e não é feita aqui |
| Espelho `schema.sql` × `db/migrations` | 94 tabelas | Convenção do repositório, **não** duplicidade (§5) |

**Conclusão:** o ERP tem **uma fonte de verdade por fato**. As coincidências de
nome são contextos distintos ou espelhos idempotentes do mesmo DDL.

---

## 2. Pares analisados

### 2.1 `vendas` × `sales` — **BOUNDED CONTEXT**

| | `vendas` | `sales` |
| --- | --- | --- |
| O que guarda | Pedido de venda do ERP (cliente, itens, financeiro, fiscal) | Pedido multicanal (marketplace/loja integrada) |
| Quem escreve | CRUD genérico, PDV, portal, conversão de proposta | Conectores (`connectors`), ingestão de pedidos externos |
| Quem lê | Estoque, financeiro, fiscal, relatórios | Painel de commerce, conciliação de canal |
| Vínculo | — | `sales.venda_id` aponta para a venda gerada |

`upsertIngestedSale` mantém a chave de idempotência e cria/atualiza a venda
correspondente. **Não é duplicidade funcional**: um é o pedido do ERP, o outro é
o registro de ingestão do canal. Unificar apagaria a rastreabilidade por canal.

### 2.2 `estoques` × `estoque_insumos` — **BOUNDED CONTEXT**

Produto acabado (por produto/tamanho/local) × insumo (matéria-prima). Unidades,
regras de custo e consumo são diferentes. `estoques.quantidade` é o **físico**
do produto; `estoque_insumos` é saldo de insumo com `estoque_min`.

### 2.3 `movimentacoes` × `movimentacoes_insumos` — **BOUNDED CONTEXT**

Mesmo raciocínio: livro de movimentação de produto × de insumo. Ambos são
append-only e são a **única** forma de alterar saldo.

### 2.4 `estoques` × `estoque_reservas` × `estoque_transferencias` — **READ MODEL**

`estoque_reservas` (migration 0052) **não** duplica saldo: guarda quantidade
comprometida por documento. `estoque_transferencias` guarda o documento e seus
estados; o saldo só muda por `movimentacoes` na expedição e no recebimento.
`disponível = físico − reservado − bloqueado − empenhado` é **calculado**
(`server/src/estoqueTransferencia.ts › calcularDisponibilidade`), nunca gravado.
Nenhuma coluna "disponível" existe no banco — de propósito.

### 2.5 `lancamentos_financeiros` × `fin_extrato_transacoes` — **LEGACY COMPATIBILITY**

`lancamentos_financeiros` é o livro-caixa oficial (fonte). `fin_extrato_transacoes`
guarda linhas importadas de extrato bancário para conciliação; quando conciliada,
aponta para o lançamento. Não substitui o livro nem cria um segundo financeiro.

### 2.6 `categorias_financeiras` × `centros_custo` × `plano_contas` — **BOUNDED CONTEXT**

Três eixos diferentes, todos legítimos:

| Estrutura | Pergunta que responde | Origem |
| --- | --- | --- |
| `categorias_financeiras` | "que tipo de receita/despesa é?" (DRE gerencial) | operação |
| `centros_custo` | "qual área consumiu?" (rateio gerencial) | operação |
| `plano_contas` (nova, 0056) | "qual conta contábil recebe o lançamento?" | contador |

`plano_contas` **não** substitui as duas anteriores e não é preenchido
automaticamente: o lançamento sem conta aparece em `sem_classificacao`.

### 2.7 `transferencias_financeiras` × `estoque_transferencias` — **BOUNDED CONTEXT**

Movimentação de **dinheiro** entre contas × movimentação de **mercadoria** entre
locais. Nomes parecidos, fatos diferentes, tabelas diferentes.

### 2.8 `propostas` × `crm_oportunidades` — **BOUNDED CONTEXT**

Proposta é documento comercial com itens e validade; oportunidade é o registro
do funil com estágio, probabilidade e histórico. Uma proposta pode existir sem
oportunidade e vice-versa; a conversão gera venda, não oportunidade.

### 2.9 `crm_oportunidade_estagio_historico` × `auditoria` — **READ MODEL / TRILHA**

`auditoria` registra toda alteração (cadeia de hash). O histórico de estágio é a
trilha **de negócio** específica do funil, consultável pela tela de histórico
(`GET /api/crm/oportunidades/:id/historico`) sem varrer auditoria. Derivado da
mesma transação, com propósito próprio — não é reescrita do fato.

### 2.10 `ordens_fabricacao.recurso_id` × `locais` — **BOUNDED CONTEXT**

`locais` responde "onde fisicamente está o estoque" (loja, expedição, facção).
`producao_recursos` (nova, 0054) responde "qual capacidade produtiva consome a
OP" (peças/dia, eficiência). Um local pode ter vários recursos e um recurso pode
ser externo (facção). Fundir os dois faria o estoque carregar dado de engenharia.

### 2.11 `arquivos` × `fornecedor_documentos` — **BOUNDED CONTEXT**

`arquivos` guarda bytes/metadados de anexos de qualquer registro.
`fornecedor_documentos` (nova, 0053) guarda o **fato documental** de homologação:
tipo, número, emissão, validade, situação e validação. O binário continua em
`arquivos`/storage e é referenciado por `arquivo_ref` — não há duas cópias do
arquivo, nem dois cadastros de fornecedor.

### 2.12 `fornecedores` × `fornecedor_documentos` × `fornecedor_homologacao_eventos` — **READ MODEL / PROCESSO**

Uma única tabela de fornecedor (`fornecedores`), com o estado de homologação em
colunas próprias (migration 0053), documentos e trilha como tabelas-filhas. Não
existe "fornecedor homologado" como segundo cadastro — a homologação é um
**processo sobre o cadastro existente**.

### 2.13 `fiscal_obrigacoes` × `documentos_fiscais` — **BOUNDED CONTEXT**

`documentos_fiscais` é o documento emitido (NF-e/NFC-e, status SEFAZ, protocolo).
`fiscal_obrigacoes`/`fiscal_obrigacao_entregas` (novas, 0055) são as obrigações
**acessórias** (SPED, DCTFWeb, eSocial...). Nenhuma alíquota ou apuração foi
criada; o motor tributário continua em `fiscalRegras.ts`.

### 2.14 `estoque_transferencia_itens` × `itens_*` — **BOUNDED CONTEXT**

Cada documento tem seus itens (`itens_venda`, `itens_compra`, `itens_ordem`,
`itens_inventario`, `estoque_transferencia_itens`). Não há tabela de itens
genérica — e criá-la agora duplicaria cinco contratos já testados.

### 2.15 `configuracoes` × `empresa_fiscal_config` × `politicas_comerciais` — **BOUNDED CONTEXT**

Configuração global da instalação × configuração fiscal por empresa × política
comercial (alçadas). Escopos diferentes.

---

## 3. Regras que a auditoria confirma

1. **Saldo de estoque** só muda por `movimentacoes` / `movimentacoes_insumos`.
   Nenhum endpoint novo escreve `estoques.quantidade` diretamente
   (`lancarMovimentacaoDentro` é o único caminho, inclusive para transferência).
2. **Financeiro** tem um único livro (`lancamentos_financeiros`); balancete e
   DRE são leituras dele.
3. **Tenancy** tem uma única camada: `empresa_id` em 111 das 131 tabelas.
   Sem `organizationId`, sem segunda camada de empresa.
4. **Prisma** permanece no bounded context commerce (11 modelos, 5 com
   `empresaId`) — métrica distinta da métrica SQL (`tabela possui empresa_id`),
   como o `architecture:audit` imprime separadamente.
5. **Nada foi apagado**: nenhuma tabela, coluna ou recurso removido nesta
   evolução.

---

## 4. Achados que exigem decisão futura (não executados)

| Item | Classificação | Por que não agora | Risco |
| --- | --- | --- | --- |
| Consolidar `fin_extrato_transacoes` em `lancamentos_financeiros` | **LEGACY COMPATIBILITY** | Conciliação bancária depende do par importado × conciliado; migrar exige conversão de dados e re-teste do fluxo | P1 se houver dados de extrato em produção |
| Unificar `sales` e `vendas` | **BOUNDED CONTEXT** | Destruiria a rastreabilidade por canal e o contrato de idempotência `upsertIngestedSale` | P0 proibido pelo escopo |
| Tabela de itens genérica | **DUPLICIDADE EVITADA** | Padronizaria cinco contratos distintos e quebraria relatórios | P3 |

---

## 5. Espelho `schema.sql` × `db/migrations` (não é duplicidade)

94 tabelas aparecem tanto em `db/schema.sql` quanto em alguma migration. Isso é
**convenção obrigatória** do repositório:

- `db/schema.sql` é aplicado a cada boot em banco **novo** (`server/src/db.ts`);
- `db/migrations/*.sql` é a **fonte de verdade** da evolução, aplicada pela
  cadeia versionada;
- todo o DDL é idempotente (`CREATE TABLE IF NOT EXISTS`,
  `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`, `DO $$ ... EXCEPTION
  duplicate_object`), então aplicar os dois **não cria tabela nem coluna dupla**;
- o teste `server/test/api.test.ts › "todo campo não-virtual de resources.ts
  existe em db/schema.sql"` garante que os dois lados não divergem.

As migrations 0051..0056 foram espelhadas em `schema.sql` no bloco
`ESPELHO DAS MIGRATIONS 0051..0056 (ERP 3.0)` — sem isso, um banco novo nasceria
sem as tabelas do 3.0 e o teste de contrato acusaria (foi exatamente o que
aconteceu até o espelho ser adicionado).
