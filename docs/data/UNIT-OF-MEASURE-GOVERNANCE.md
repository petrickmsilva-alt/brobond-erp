# UNIT-OF-MEASURE-GOVERNANCE — governança de unidades de medida (Fase 9.5)

**Data:** 2026-11-09 · **Branch:** `architecture/fases-9-4-9-5-9-6`
**Código:** `server/src/unidades.ts`, `server/src/resources.ts` (`UNIDADES`)
**Migration:** `db/migrations/0060_unidades_medida_conversao.sql`

> **Regra única.** O ERP **só** converte o que a **empresa declarou** em
> `unidade_conversoes`. Não existe fator "de fábrica", nem conversão por
> semelhança de sigla, nem entre grandezas diferentes. Sem caminho declarado a
> resposta é `null` — nunca uma estimativa.

## 1. O problema que isto resolves

`insumos.unidade` é texto livre. Compra-se em **rolo**, consome-se em **metro**.
Um fator inventado (rolo = 50 m quando o fornecedor entrega 45 m) erra a compra
em 10% **em silêncio**. O fator é **dado cadastral**, não inferência.

## 2. Catálogo canônico

### 2.1 Catálogo do sistema (`UNIDADES`, `server/src/resources.ts`)

Conjunto aceito pelos cadastros de insumo/produto:

| Código | Rótulo |
|---|---|
| `un` | Unidade |
| `pc` | Peça |
| `m` | Metro |
| `cm` | Centímetro |
| `kg` | Quilo |
| `g` | Grama |
| `l` | Litro |
| `rl` | Rolo |
| `cx` | Caixa |
| `pct` | Pacote |

### 2.2 Catálogo por empresa (`unidades_medida`)

| Coluna | Papel |
|---|---|
| `codigo` | código canônico (único por empresa: `uq_unidades_medida_empresa_codigo`) |
| `nome` | rótulo |
| `grandeza` | categoria dimensional (CHECK) |
| `casas_decimais` | precisão decimal |

**Grandezas dimensionais** (CHECK `unidades_medida_grandeza_valida`):
`comprimento`, `massa`, `volume`, `area`, `contagem`, `tempo`.

> **Embalagem.** Caixa/pacote/rolo **não** são grandeza universal. O ERP não
> assume que "uma caixa" equivale a uma quantidade fixa: quando a conversão
> depende do produto, ela é declarada como **regra** entre os códigos — nunca
> inferida. (O CHECK de grandeza não inclui um valor `embalagem`: a decisão
> aprovada mantém a lista acima. Ver §4.)

## 3. Conversão declarada (`unidade_conversoes`)

| Coluna | Papel |
|---|---|
| `de_codigo` / `para_codigo` | par de códigos |
| `fator` | **1 `de` = `fator` `para`** |
| `ativo` | vigência |
| `empresa_id` | isolamento por empresa |

### 3.1 Regras de conversão

- **Mesma unidade é identidade** — não precisa de regra (`origem: identica`).
- A regra vale nos **dois sentidos**: declarar `1 rl = 50 m` já responde "quantos
  rolos são 120 m" (`inversa: true`).
- **Cadeia** é resolvida em largura (BFS), profundidade máxima **3**
  (ex.: rolo → caixa → metro) — `origem: cadeia`.
- O resultado **sempre** devolve o **caminho** percorrido (`PassoConversao[]`) —
  a conversão é **auditável**, não caixa-preta.
- **Grandezas diferentes** (metro ↔ quilo) → regra **recusada** no cadastro; sem
  densidade/contexto explícito não há conversão.
- **Sem regra declarada** → resultado `null`. O MRP marca `conversao_ausente:
  true` em vez de comprar no chute.
- Precisão: `round3` (mesmo contrato do catálogo).

## 4. Migração de valores legados

`unidade_compra` nasceu `NULL` (nada é alterado). Valores históricos mantêm a
unidade **original**. A migração **não** substitui unidade desconhecida por uma
unidade arbitrária: código sem regra declarada permanece como está e é
classificado para resolução segura (o MRP sinaliza `conversao_ausente`).

## 5. Interface

- Catálogo de unidades e regras de conversão (recursos `unidades_medida`,
  `unidade_conversoes`).
- `GET /api/estoque/unidades/conversoes` (`listarConversoes`) — expõe as regras
  da empresa.

## 6. Testes

`server/test/estoque-unidades-medida.test.ts` — identidade, dois sentidos,
cadeia com caminho, ausência → `null`, grandeza incompatível, isolamento
empresa A×B.

## 7. Status

| Item | Status |
|---|---|
| Catálogo canônico + catálogo por empresa | **IMPLEMENTADO E TESTADO** |
| Conversão declarada (identidade/direta/cadeia) | **IMPLEMENTADO E TESTADO** |
| Recusa entre grandezas diferentes | **IMPLEMENTADO E TESTADO** |
| Ausência → `null` (sem estimativa) | **IMPLEMENTADO E TESTADO** |
| Preservação de unidade histórica | **IMPLEMENTADO E TESTADO** |
