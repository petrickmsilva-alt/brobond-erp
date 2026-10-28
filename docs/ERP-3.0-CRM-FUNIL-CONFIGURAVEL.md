# CRM — ETAPA REALMENTE CONFIGURÁVEL POR EMPRESA (correção 0057)

**Data:** 2026-10-27 · **Branch:** `arena/72895db5-brobond-erp` · **Migration:** `0057_crm_etapa_configuravel.sql`
**Documentos relacionados:** [`ERP-3.0-ARCHITECTURE-BASELINE.md`](ERP-3.0-ARCHITECTURE-BASELINE.md) · [`ERP-3.0-GAP-MATRIX.md`](ERP-3.0-GAP-MATRIX.md) · [`ERP-3.0-DUPLICITY-AUDIT.md`](ERP-3.0-DUPLICITY-AUDIT.md)

---

## 1. O defeito que esta correção fecha

A rodada anterior entregou `crm_funis` e `crm_etapas` (0051) e declarou
"funil e etapas configuráveis". **Era verdade para o cadastro e mentira para o
uso.** A oportunidade continuava presa ao vocabulário fixo da 0049:

```sql
-- db/schema.sql (antes da 0057)
ALTER TABLE crm_oportunidades ADD CONSTRAINT crm_oportunidades_etapa_valido
  CHECK (etapa IN ('prospeccao','qualificacao','proposta','negociacao','fechamento'));
```

e no código `ETAPAS_CRM` era a autoridade (`mudarEstagioOportunidade`,
`converterLead`, `painel`, `forecast`).

Consequência verificável: cadastrar a etapa **"Demonstração"** no funil da
empresa era aceito, mas usá-la em uma oportunidade falhava no banco
(CHECK) e/ou era recusada pelo serviço. O cadastro existia; o uso, não.

## 2. A correção (Opção A — sem estrutura paralela)

| Antes (0049/0051) | Depois (0057) |
|---|---|
| `etapa` TEXT com CHECK de 5 valores | `etapa_id` INTEGER → `crm_etapas.id` (**referência operacional**) |
| `ETAPAS_CRM` decidia o que era válido | o **cadastro da empresa** decide (tenant + funil + ativo) |
| `etapa` texto = autoridade | `etapa` texto = **chave** (`crm_etapas.chave`), mantida para histórico/relatórios/integrações |
| CHECK de vocabulário | CHECK "não vazio" + FK composta + validação no serviço |

O que **não** foi criado: `etapa_configuravel`, `stage_id_novo`,
`crm_oportunidades_v2`, segunda tabela de funil ou de etapa. `crm_etapas` é a
única tabela de etapa; `crm_oportunidades` continua a única tabela de
oportunidade.

### 2.1 Integridade no banco (padrão E4.2)

```sql
CREATE UNIQUE INDEX uq_e42_crm_etapas_empresa_id ON crm_etapas (empresa_id, id);

ALTER TABLE crm_oportunidades
  ADD CONSTRAINT fk_e42_crm_oportunidades_empresa_etapa
  FOREIGN KEY (empresa_id, etapa_id) REFERENCES crm_etapas (empresa_id, id)
  ON DELETE RESTRICT;
```

A FK é **composta por empresa**: nem SQL manual consegue apontar a oportunidade
da empresa A para uma etapa da empresa B. `ON DELETE RESTRICT` impede que
apagar uma etapa (ou o funil dela) deixe oportunidades órfãs.

### 2.2 Backfill (determinístico, não destrutivo)

1. casa `(empresa_id, chave)` respeitando o funil da oportunidade quando ela já tem um;
2. sem casamento, usa a etapa de mesma chave no funil **padrão** da empresa;
3. o que não casar fica `NULL` e aparece em `RAISE NOTICE` — **nunca é
   inventado**. Empresa sem nenhuma etapa cadastrada continua funcionando pelo
   texto (caminho de compatibilidade, `origem: 'compatibilidade'`).

Nenhum `DROP TABLE`, nenhuma coluna removida, nenhum dado apagado.

## 3. Regras de resolução da etapa

Implementadas em `server/src/crm.ts` (`resolverEtapaDoFunil`), todas dentro da
mesma transação da mudança:

| Situação | Resultado |
|---|---|
| `etapa_id` inexistente | **404** — não vaza existência de outro tenant |
| `etapa_id` de outro tenant | **404** (a FK composta + filtro por empresa escondem o registro) |
| `etapa_id` de outro funil da mesma empresa | **422** "pertence a outro funil" |
| etapa inativa em movimento novo | **422** "inativa" |
| texto casa por `chave` **ou** `nome` | resolve, preferindo o funil da oportunidade e depois a etapa ativa |
| empresa sem nenhuma etapa cadastrada | aceita apenas as chaves canônicas semeadas (compatibilidade) |
| criação sem etapa informada | primeira etapa **ativa** por `ordem` no funil padrão |

**Probabilidade:** precedência `valor explícito do corpo` > `probabilidade da
etapa` > `PROBABILIDADE_PADRAO` (só legado). O "explícito" é lido do corpo CRU
(`probabilidadeFoiInformada`), porque `probabilidade` tem default `0` no schema
e "não informado" ficaria indistinguível de "informado como zero".

## 4. Transição de estágio (uma transação)

```
valida oportunidade (tenant, status) → valida funil → valida etapa
  (existe, é do funil, está ativa) → UPDATE oportunidade →
  INSERT crm_oportunidade_estagio_historico → COMMIT
```

Qualquer falha (inclusive no histórico) desfaz **tudo** — coberto por teste com
`insert` sabotado (`crm-funil-configuravel.test.ts`, caso 8). A operação é
idempotente quando a etapa e o `etapa_id` já são os mesmos (não grava histórico
duplicado). Oportunidade fechada (`ganha`/`perdida`) → **409**.

O histórico guarda: `estagio_anterior`, `estagio_novo`, `status_anterior`,
`status_novo`, `usuario_id`, `empresa_id`, `criado_em`, `observacao`.

> **Correção de bug real encontrada aqui:** `mudarEstagioOportunidade` fazia
> `return s.transaction(...)`, mas o `wrap()` do Express **descarta o valor de
> retorno** do handler. A rota ficava pendurada sem resposta. Agora a resposta é
> enviada explicitamente após o commit.

## 5. Conversão de lead

`POST /api/crm/leads/:id/converter`

1. resolve o **funil padrão** da empresa (`crm_funis.padrao = true`, ativo);
2. escolhe a **primeira etapa ativa** por `ordem` (nunca a inativa);
3. grava `funil_id` + `etapa_id` + `etapa` (chave) na oportunidade;
4. probabilidade: corpo > lead (> 0) > etapa > `PROBABILIDADE_PADRAO`;
5. tudo em uma transação: oportunidade + cliente (se preciso) + `lead.status` +
   `lead_convertido_em` + auditoria;
6. repetir a conversão **devolve a mesma oportunidade** (`idempotente: true`) —
   nunca cria cliente ou oportunidade duplicados.

**Sem funil cadastrado** (empresa legada): a conversão continua funcionando pelo
caminho de compatibilidade e a resposta informa
`etapa.origem = 'compatibilidade'`. **Nenhum funil é criado automaticamente.**

## 6. UI — sem lista fixa

`GET /api/meta` passou a devolver as opções de etapa **da empresa da sessão**
(`optionsFrom`, resolvido em `metaComOpcoesDinamicas`):

* lê `crm_etapas` da empresa, apenas ativas, ordenadas por `ordem`;
* `publicMeta()` **clona** os campos antes de injetar as opções — sem isso a
  etapa da empresa A vazaria para a empresa B no request seguinte;
* sem etapa cadastrada, mantém a lista canônica de semente (fallback);
* `RecordForm`/`ListaFiltros` já consomem `field.options` — **nenhuma lista
  hard-coded** ficou no cliente;
* depois de criar/editar um funil ou uma etapa, `RegistroPage` chama
  `refreshMeta()`, então a mudança aparece **imediatamente** no formulário.

## 7. Cobertura de teste (`server/test/crm-funil-configuravel.test.ts`)

| # | Caso exigido | Teste |
|---|---|---|
| 1 | etapa customizada é usada | `1) empresa A cadastra "Demonstração"...` |
| 2 | "Aprovação Jurídica" | `2) oportunidade avança para "Aprovação Jurídica"...` |
| 3 | B não usa etapas de A | `3) empresa B só enxerga e usa as PRÓPRIAS etapas` |
| 4 | etapa inativa rejeitada | `4) etapa inativa não recebe oportunidade nova...` |
| 5 | etapa de outro funil rejeitada | `5) etapa de outro funil da mesma empresa é rejeitada (422)` |
| 6 | cross-tenant rejeitado (404) | `6) etapa de outro tenant é recusada com 404` |
| 7 | transição grava histórico | `7) mudança de etapa grava histórico...` |
| 8 | falha do histórico faz rollback | `8) falha ao gravar o histórico desfaz a mudança` |
| 9 | lead convertido nasce em etapa válida | `9/10) lead convertido nasce na primeira etapa ATIVA...` |
| 10 | conversão repetida = mesma oportunidade | idem (bloco 9/10) |
| 11 | etapa 65% → 65% | `2)` (`probabilidade` 65) |
| 12 | forecast usa a probabilidade da etapa | `12) forecast e painel usam a probabilidade CADASTRADA` |

Mais: `metadados: /api/meta troca a lista fixa pelas etapas da empresa` prova
`optionsFrom`, isolamento A×B e ausência de mutação do `publicMeta()` global.

## 8. Compatibilidade preservada (a lista canônica continua existindo)

`ETAPAS_CRM` e `PROBABILIDADE_PADRAO` permanecem no código **somente** como:

* **semente** (`mock` do modo demonstração e seed da 0051);
* **fallback** para empresa sem funil/etapa cadastrada;
* **compatibilidade histórica** (registros antigos com `etapa` textual e
  `etapa_id` nulo);
* **vitrine de testes** legados.

Nenhuma decisão de negócio volta a consultá-las quando existe cadastro.
