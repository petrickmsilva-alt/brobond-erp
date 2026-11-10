# SPED / EFD — arquitetura fiscal (Fase 9.5)

**Data:** 2026-11-09 · **Branch:** `architecture/fases-9-4-9-5-9-6`
**Fonte normativa:** [`REGULATORY-SOURCES.md`](REGULATORY-SOURCES.md)

> **Escopo.** O ERP **prepara** a estrutura fiscal e a **validação estrutural**
> dos arquivos SPED/EFD. Não transmite, não assina, não emite documento fiscal
> real e **não é homologado** pela Receita Federal/SEFAZ. A geração a partir de
> documentos reais e a validação no PVA oficial dependem de **contador +
> ambiente fiscal**.

## 1. O que já existia (não duplicado)

O domínio fiscal do ERP já tinha (migrations 0019, 0022, 0023, 0055, 0063, 0067):

- `regras_fiscais` — regras de tributação por produto/operação (CST/CSOSN/CFOP,
  alíquotas, NCM), **fonte dos códigos** — nunca hardcodados no gerador;
- `empresa_fiscal_config` — identificação fiscal da empresa/estabelecimento;
- `documentos_fiscais` — documentos fiscais e itens;
- `fiscal_obrigacoes` / `fiscal_execucoes` — obrigações acessórias e execuções;
- `fiscal_nao_suportado` (0067) — o que o ERP explicitamente **não** emite.

A Fase 9.5 **não** cria um segundo motor fiscal: acrescenta a **tabela de
referência versionada de leiautes** e o **validador estrutural**.

## 2. Registro versionado de leiautes (migration 0115)

Tabela `fiscal_layouts` — **referência global** (sem `empresa_id`): diz, por
`sistema` e `codigo_versao` (campo `COD_VER` do registro `0000`), o
`vigencia_inicio`/`vigencia_fim` em que a versão é válida, o `ato_normativo` e a
`fonte_url` consultada.

| Coluna | Papel |
|---|---|
| `sistema` | `EFD_ICMS_IPI` ou `EFD_CONTRIBUICOES` (CHECK) |
| `codigo_versao` | `COD_VER` do `0000` (ex.: `020`, `006`) |
| `versao_leiaute` | versão "humana" (ex.: `3.2.0`) |
| `ato_normativo` | NT / ADE Cofis / Ato COTEPE que instituiu a versão |
| `vigencia_inicio` / `vigencia_fim` | janela em que a versão vigora (`NULL` = vigente) |
| `fonte_url` / `consultado_em` | rastreabilidade da fonte oficial |
| `registros` | JSONB — autodescrição dos códigos de registro da versão |

Constraints: `fiscal_layouts_sistema_valido`, `fiscal_layouts_vigencia_coerente`
(`fim >= inicio`), `fiscal_layouts_versao_nao_vazia`,
`fiscal_layouts_registros_array` (`jsonb_typeof = 'array'`).
Índices: `uq_fiscal_layouts_sistema_versao` (UNIQUE) e
`fiscal_layouts_sistema_vigencia_idx`.

**Regra de ouro:** geração de arquivo para um período **sem leiaute vigente
cadastrado** é **recusada** (`resolverLeiauteVigente` lança 422) — o ERP **nunca**
presume a versão "mais nova".

## 3. Resolução do leiaute vigente

`server/src/fiscalLayouts.ts › resolverLeiauteVigente(sistema, periodo)`:

1. valida `periodo` no formato `AAAA-MM` (senão 400);
2. filtra leiautes cujo `vigencia_inicio <= período <= vigencia_fim`;
3. **sem candidato → 422** (não presume);
4. havendo sobreposição, escolhe o de `vigencia_inicio` mais recente.

`GET /api/fiscal/layouts/vigente?periodo=AAAA-MM&sistema=...`

## 4. Gramática dos registros

A gramática (campos C/N, obrigação O/OC/N, tamanho, decimais, regex) é
transcrita dos **Guias Práticos** publicados — em `server/src/fiscalLayouts.ts`.
Cobrem, para a EFD ICMS/IPI, os registros `0000, 0001, 0005, 0010, 0150, 0190,
0200, 0990, C001, C100, C170, C190, C990, 9999`.

Regras estruturais validadas (ver [`FISCAL-VALIDATION.md`](FISCAL-VALIDATION.md)):
blocos e `QTD_LIN`, `0000` primeiro / `9999` último, filhos obrigatórios do
`C100` (`C170`/`C190`), integridade referencial (`0150`/`0190`/`0200`),
documento duplicado e divergência de totais (`VL_MERC` × Σ itens).

## 5. Endpoints

| Método | Rota | Descrição |
|---|---|---|
| `GET` | `/api/fiscal/layouts` | registro versionado (filtro `?sistema=`) |
| `GET` | `/api/fiscal/layouts/vigente` | leiaute vigente do período |
| `POST` | `/api/fiscal/efd/validar` | validação estrutural (não grava, não transmite) |

RBAC: leitura por `gerente`/`admin` (recurso `fiscal_layouts`); validação exige
leitura ao recurso de obrigações (`fiscal_obrigacoes`). Escopo de empresa
aplicado no servidor (`escopoDe`).

## 6. Interface

`client/src/pages/FiscalLayoutsPage.tsx` — módulo navegável `fiscal-layouts`
("Leiautes SPED/EFD"), space `erp`. Lista os leiautes e permite resolver o
vigente por período/sistema. Aplica `PageShell`/`PageLoading`/`PageError`.

A tela deixa **explícito** o limite de homologação: o que aparece é a
**referência** de leiaute, não um atestado de conformidade.

## 7. Status

| Item | Status |
|---|---|
| Registro versionado de leiautes (0115) | **IMPLEMENTADO E TESTADO** |
| Resolução de leiaute vigente | **IMPLEMENTADO E TESTADO** |
| Gramática + validação estrutural | **IMPLEMENTADO E TESTADO** |
| Geração de arquivo a partir de documentos do ERP | **IMPLEMENTADO, HOMOLOGAÇÃO EXTERNA PENDENTE** |
| Validação no PVA oficial | **BLOQUEADO POR DEPENDÊNCIA EXTERNA** (contador/ambiente fiscal) |
| Transmissão à RFB/SEFAZ | **NÃO APLICÁVEL** (fora do escopo) |
