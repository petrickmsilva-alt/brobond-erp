# FISCAL-VALIDATION — gerador e validador EFD (Fase 9.5)

**Data:** 2026-11-09 · **Branch:** `architecture/fases-9-4-9-5-9-6`
**Código:** `server/src/fiscalLayouts.ts` (`validarEfd`), `server/src/fiscalEfd.ts`
**Fonte normativa:** [`REGULATORY-SOURCES.md`](REGULATORY-SOURCES.md)

> **Limite.** A validação é **ESTRUTURAL** (gramática, formatos, blocos,
> referências, totais). **Não** substitui o **PVA oficial** nem declara
> homologação. O `POST /api/fiscal/efd/validar` **não grava** e **não transmite**
> nada.

## 1. Entrada

`POST /api/fiscal/efd/validar`

```jsonc
{ "sistema": "EFD_ICMS_IPI", "periodo": "2026-01",
  "linhas": ["|0000|020|...|", "|0001|0|", "..."] }
// ou
{ "sistema": "EFD_CONTRIBUICOES", "periodo": "2026-01",
  "conteudo": "|0000|...|\n|0001|...|\n" }
```

O período resolve o **leiaute vigente**; sem leiaute vigente → **422**.

## 2. Códigos de erro/aviso produzidos

| Código | Nível | Quando |
|---|---|---|
| `REGISTRO_DESCONHECIDO` | erro | código de registro fora da gramática |
| `QTD_CAMPOS` | erro | nº de campos diferente do leiaute |
| `CAMPO_OBRIGATORIO` | erro | campo O vazio |
| `CAMPO_NAO_NUMERICO` | erro | campo N não numérico |
| `CAMPO_LONGO` | erro | valor excede o tamanho |
| `CAMPO_FORMATO` | erro | regex do campo (data, CNPJ, CFOP, NCM, UF, chave) |
| `SEM_0000` / `PRIMEIRO_REGISTRO` | erro | `0000` ausente ou fora do início |
| `ULTIMO_REGISTRO` | erro | `9999` não é o último |
| `PERIODO_INCOERENTE` | erro | `DT_INI`/`DT_FIN` em meses diferentes |
| `BLOCO_INCOERENTE` | erro | bloco sem `xxxx`/`xxx9` ou fora de ordem |
| `QTD_LIN_DIVERGENTE` | erro | `QTD_LIN` declarado ≠ contado |
| `C100_SEM_C170` / `C100_SEM_C190` | erro | `C100` sem filhos obrigatórios |
| `TOTAL_DIVERGENTE` | erro | `VL_MERC` ≠ Σ itens (`C170`) |
| `DOCUMENTO_DUPLICADO` | erro | `C100` repetido (modelo/série/número/chave) |
| `PARTICIPANTE_INEXISTENTE` | erro | `COD_PART` não consta em `0150` |
| `ITEM_INEXISTENTE` | erro | `COD_ITEM` não consta em `0200` |
| `UNIDADE_INEXISTENTE` | erro | `UNID` não consta em `0190` |
| `VERSAO_DIVERGENTE` | aviso | `COD_VER` do arquivo ≠ versão validada |

Resultado: `{ sistema, codigo_versao, total_linhas, registros, erros, avisos,
valido }` — `valido = erros.length === 0`.

## 3. Sem dado → sem arquivo

O validador **não** inventa conteúdo. Ausência de um leiaute vigente é erro
duro (**422**) e nunca um "zero enganoso". A geração do arquivo a partir de
documentos do ERP reusa `regras_fiscais`/`empresa_fiscal_config` como fonte dos
códigos (CFOP/CST/NCM) — nunca hardcodados.

## 4. Testes

- `server/test/fase9-5-fiscal-efd.test.ts` — gramática, coerência de seed com a
  migração 0115, mapeamento de campos `C100`/`C170`.
- `server/test/fase9-5-plano-contas.test.ts` — hierarquia do plano de contas,
  ciclo, sintética/analítica, isolamento multiempresa.

## 5. Fixtures e versão normativa

As fixtures dos testes derivam dos campos **publicados** nos Guias Práticos
(versão registrada em `fiscal_layouts.fonte_url` / `REGULATORY-SOURCES.md`). Não
são exemplos fiscais inventados: servem para provar a **estrutura**, não a
conformidade tributária.

## 6. Procedimento de homologação (futuro)

1. Gerar o arquivo em ambiente de teste a partir de documentos reais.
2. Validar no **PVA oficial** (ICMS/IPI) e no validador da EFD-Contribuições.
3. Registrar cada divergência do PVA; se for mudança de leiaute, atualizar a
   `fiscal_layouts`.
4. Rodar novamente. Só então a geração é **homologada** — com o contador.
