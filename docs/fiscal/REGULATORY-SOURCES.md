# REGULATORY-SOURCES — fontes normativas usadas pelo módulo fiscal (Fase 9.5)

**Data da consulta:** 2026-11-09 · **Branch:** `architecture/fases-9-4-9-5-9-6`

> **Regra dura.** Este documento registra **fonte oficial, versão, data de
> consulta e escopo** de cada regra fiscal implementada. Nenhuma alíquota, CST,
> CSOSN, CFOP ou NCM é hardcodada: esses códigos vêm das regras da empresa
> (`regras_fiscais`) e da configuração fiscal (`empresa_fiscal_config`). O que o
> ERP guarda aqui é apenas **qual leiaute vigora em cada período** e a
> **gramática** publicada dos registros.

## 1. Obrigações consideradas

| Obrigação | Arquivo | Registro-chave | Natureza |
|---|---|---|---|
| EFD ICMS/IPI | arquivo texto `\|` | `0000` (COD_VER) | escrituração fiscal mensal (ICMS/IPI) |
| EFD-Contribuições | arquivo texto `\|` | `0000` (COD_VER) | escrituração de PIS/COFINS |

EFD ICMS/IPI e EFD-Contribuições **não** são o mesmo arquivo nem têm os mesmos
registros. O ERP trata cada um como sistema independente (`sistema` em
`fiscal_layouts`).

> **Não presumir obrigatoriedade.** Nem toda empresa está sujeita às duas
> obrigações. O enquadramento (regime tributário, atividade, UF) é decisão do
> contador — o ERP **não** decide isso.

## 2. Fontes oficiais

### 2.1 EFD ICMS/IPI

- **Portal SPED (RFB)** — pasta oficial do leiaute:
  <http://sped.rfb.gov.br/pasta/show/1573>
- **Guia Prático da EFD ICMS/IPI** (versão citada na migração 0115: v3.2.2,
  atualização 11/02/2026) e **Manual de Orientação do Leiaute**.
- **Atos COTEPE/ICMS / Notas Técnicas** que instituem cada versão de leiaute:
  - Nota Técnica 2025.001 — leiaute **020**
  - Nota Técnica 2024.001 — leiaute **019**
  - Nota Técnica 2023.001 — leiaute **018**

### 2.2 EFD-Contribuições

- **Portal SPED (RFB)** — item oficial:
  <http://sped.rfb.gov.br/item/show/1989>
- **Guia Prático da EFD-Contribuições** (versão citada: v1.35) e a **Tabela
  3.1.1** (versões do leiaute × ADE Cofis):
  - ADE Cofis — leiaute **006** (versão 3.2.0)
  - ADE Cofis nº 82/2018 — leiaute **005** (versão 3.1.0)
  - ADE Cofis nº 20/2012 — leiaute **004** (versão 3.0.0)

## 3. O que está implementado (com fonte)

| Item | Onde | Fonte / versão |
|---|---|---|
| Registro versionado de leiautes | `db/migrations/0115_fase9_5_fiscal_layouts.sql`, tabela `fiscal_layouts` | fontes acima (coluna `fonte_url`, `consultado_em`) |
| Resolução do leiaute vigente por período | `server/src/fiscalLayouts.ts` (`resolverLeiauteVigente`) | vigência de cada leiaute (NT/ADE) |
| Gramática dos registros (C100, C170, C190, 0000, …) | `server/src/fiscalLayouts.ts` | Guia Prático (campos publicados) |
| Validação estrutural do arquivo | `server/src/fiscalEfd.ts` (`validarArquivoEfd`) | gramática + regras de bloco/total |

## 4. Limites de homologação (o que NÃO foi feito)

- **Nenhuma transmissão** à Receita Federal ou SEFAZ.
- **Nenhuma assinatura digital** nem emissão de documento fiscal real.
- **Nenhuma declaração de homologação.** O ERP **não** é homologado pela RFB ou
  SEFAZ por este módulo.
- **A geração do arquivo** a partir dos documentos do ERP e a validação no **PVA
  oficial** dependem de **contador + ambiente fiscal** e estão **pendentes de
  homologação externa**.

## 5. Procedimento de homologação (etapa futura)

1. Confirmar no **Portal SPED** a versão de leiaute vigente para o período de
   apuração (a `fiscal_layouts` deve ser atualizada quando uma NT/ADE nova sair).
2. Gerar o arquivo a partir de documentos reais **em ambiente de teste**.
3. Validar no **PVA oficial** (ICMS/IPI) e no validador da EFD-Contribuições.
4. Corrigir divergências apontadas pelo PVA e registrar no `fiscal_layouts`
   quando a causa for mudança de leiaute.
5. Somente então considerar a geração **homologada** — com o contador.

> **Risco de não executar:** sem a homologação no PVA, o arquivo pode ser
> recusado na entrega. O ERP entrega a **estrutura** e a **validação
> estrutural**; a prova normativa é externa.
