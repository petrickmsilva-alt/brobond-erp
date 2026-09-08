# Auditoria do módulo Tabela de Medidas — 2026-09-08

**Papel:** auditor-chefe. **Escopo:** `server/src/medidas.ts`, `server/src/catalogos.ts`,
`server/src/detail.ts`, `db/schema.sql` + migração, `client/src/pages/MedidasPage.tsx`,
`client/src/pages/CatalogoPublico.tsx`, `client/src/pages/ProductDetail.tsx`,
`client/src/components/LabelSheet.tsx`.

**Método:** leitura linha a linha do caminho de escrita (PUT em lote), dos três pontos de
exposição (editor interno, detalhe do produto, catálogo público) e das etiquetas; depois
sondas reais contra a API em modo demonstração (o que está marcado como _reproduzido_
foi executado e o resultado está anotado). O objetivo pedido — **o cliente ver todas as
informações que necessita** — foi usado como régua: cada achado diz o que o cliente
perdia por falta daquela informação.

## Resumo executivo

| #   | Achado                                                                                                                                                                                                   | Severidade | Estado                                    |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ----------------------------------------- |
| M1  | Catálogo público: a tabela de medidas não era exibida por padrão (`mostrar_medidas` = false) e, quando ligada, era uma tabela de 10px dentro do cartão, sem unidade, sem instruções, ilegível no celular | **P1**     | corrigido                                 |
| M2  | O catálogo não tinha visão de produto: o cliente via 1 foto, descrição truncada em 2 linhas e nunca via a peça inteira (todas as fotos, descrição completa)                                              | **P1**     | corrigido                                 |
| M3  | O PUT da tabela aceitava **qualquer número**: `-5` e `99999` cm eram gravados; `"abc"` virava NULL em silêncio. O cliente podia ver "medida de camiseta: −5 cm"                                          | **P1**     | corrigido                                 |
| M4  | Nenhuma mudança na tabela deixava trilha na cadeia de auditoria — o dado mais visto pelo cliente era o único do sistema editável sem registro                                                            | **P1**     | corrigido                                 |
| M5  | Não existia forma de saber **quando** a tabela foi atualizada (coluna inexistente no banco) — sem confiança para o cliente, sem noção de obsolescência para o time                                       | **P1**     | corrigido                                 |
| M6  | Nenhuma informação de **como medir** / tolerância em lugar nenhum do sistema — a pergunta nº 1 do atendimento ("mediu de quê?") sem resposta padronizada                                                 | **P2**     | corrigido                                 |
| M7  | O time não via o estado das grades: nenhuma tela respondia "quais grades estão sem tabela / pela metade" — grade publicada no catálogo podia estar vazia                                                 | **P2**     | corrigido                                 |
| M8  | Editor sem salvaguardas: sair da tela perdia tudo em silêncio (sem indicador nem aviso), deletar coluna com valores não pedia confirmação, célula inválida não dava sinal nenhum                         | **P2**     | corrigido                                 |
| M9  | Toda grade nova exigia digitar as mesmas colunas de sempre (Largura/Comprimento/Manga...) e repetir valores de peça idêntica                                                                             | **P2**     | corrigido                                 |
| M10 | Sem forma de levar a tabela ao atendimento: nada para imprimir ou copiar a grade do produto (só existia dentro da folha de etiquetas) | **P2** | corrigido |
| M11 | Banco sem qualquer `CHECK` nos valores de medida + `GET`/`catalogo`/`detail` duplicavam a montagem da tabela em 3 códigos diferentes (risco de divergência) | **P3** | corrigido (migração 0002 + builder único) |
| M12 | O rodapé prometia "deixe a célula em branco para remover o valor" — mas o front não envia célula vazia e o server não apagava o que faltava no lote: o valor **continuava no banco e no cliente** | **P2** | corrigido |

**Resultado:** 13 novos testes (106 → **119**, todos verdes), `typecheck` e `lint` sem
erros, e 8 pontos verificados ponta a ponta via HTTP contra a API em execução
(login + MFA → resumo → salvar → validar → auditoria → catálogo público → padrão de
catálogo novo).

---

## 1. O que o cliente perdia (e o que ele vê agora)

### M1/M2 — Visibilidade no catálogo público · P1 · _reproduzido_

**Antes.** Catálogo novo nascia com `mostrar_medidas = false`: o cliente recebia o link
e a informação que mais decide a compra de roupa — as medidas por tamanho — simplesmente
não existia. Com o toggle ligado, cada produto mostrava a tabela **dentro do cartão**,
com fonte de 10px, colunas sem unidade (um "52" sem dizer se é cm), sem instruções de
medição, sem data — e sem página de produto: só 1 foto, descrição cortada em 2 linhas.
No celular (onde o link do WhatsApp é aberto), a tabela virava rolagem horizontal ilegível.

**Depois.**

- Catálogos **novos** nascem com a tabela visível (padrão da API + do banco; catálogos
  já existentes não mudam — a visibilidade continua sendo decisão, agora com um clique).
- O cartão ganhou o botão **"Ver tabela de medidas"** e agora todo o cartão é clicável:
  abre o **detalhe do produto**, com **todas as fotos** (carrossel + miniaturas),
  descrição **completa**, composição, preço, tamanhos com saldo e a tabela de medidas
  profissional:
  - **unidade por coluna** (Largura (A) · cm);
  - **linha do tamanho selecionado destacada** (o cliente cruza o tamanho que vai pedir
    com as medidas sem errar a linha);
  - **"Como medir"** (instruções + tolerância cadastradas por grade);
  - **"Atualizada em dd/mm/aaaa"** (confiança: a grade não está antiga);
  - aviso honesto quando a tabela está parcial ("3 de 10 medidas informadas").
- **Deep link por produto:** o detalhe tem "copiar link" que gera
  `/catalogo/<token>#p-<id>` — dá para compartilhar **a peça específica** com o cliente,
  e abrir o link já com o detalhe (e a tabela) aberto.

### M3 — Validação dos valores · P1 · _reproduzido_

**Antes.** `PUT /api/grades/1/medidas` com `valor: -5` → `200 OK`, gravava `-5`.
Com `valor: "abc"` → `200 OK`, a célula sumia em silêncio (o cliente veria "—" e
ninguém no sistema saberia que alguém tinha tentado preencher).

**Depois.** Cada valor é validado **por unidade** (máx. plausível = 3 m em cada escala:
cm ≤ 300, mm ≤ 3000, pol ≤ 150) e o lote só grava se **todo** ele for válido. Sondas
reais nesta auditoria:

| Envio              | Antes            | Depois                                                                     |
| ------------------ | ---------------- | -------------------------------------------------------------------------- |
| `valor: -5` (cm)   | `200` (gravado)  | `400` — "Medida inválida em "Largura (A)": deve ser maior que 0 cm."       |
| `valor: 9999` (cm) | `200` (gravado)  | `400` — "Medida fora do plausível em "Largura (A)": 9999 (máximo 300 cm)." |
| `valor: "abc"`     | `200` (silêncio) | `400` — "Valor não numérico em "Largura (A)"."                             |
| `valor: "52,5"`    | `200`            | `200` (vírgula decimal continua aceita)                                    |

O front valida na mesma regra antes de enviar (célula inválida fica com borda vermelha,
contador de inválidas no topo e o Salvar é bloqueado) — mas a API é a autoridade:
importação, integração ou chamada direta recebem o mesmo 400.

### M4 — Auditoria da gravação · P1 · _reproduzido_

**Antes.** `saveMedidasGrade` era o único caminho de escrita do módulo e **não chamava
`store.audit`** — em um sistema cuja auditoria tem cadeia de hashes para provar
integridade, a tabela que o cliente vê podia ser reescrita sem nenhum vestígio.

**Depois.** Toda gravação que muda alguma coisa deixa entrada na cadeia, com o diff:

```
Tabela de medidas de "Camiseta PP-GG" atualizada — colunas: +2 · valores: 3 gravado(s), 0 removido(s)
```

(quem, quando, quantas colunas criadas/removidas, quantos valores gravados/removidos —
visível em Configurações → Auditoria).

### M5 — Data de atualização · P1 · _reproduzido_

**Antes.** A tabela `medida_valores` não tinha carimbo de tempo; nenhuma tela sabia
quando a grade foi atualizada pela última vez.

**Depois.** `medida_valores.atualizado_em` (schema idempotente + backfill na migração
0002 a partir da data da coluna). O carimbo aparece em **quatro** lugares: painel de
completude, editor, detalhe do produto, **catálogo público e etiquetas impressas**
("Atualizada em 08/09/2026"). A API também normaliza `Date` (Postgres) × string (demo)
para a data ser idêntica nos dois modos.

### M6 — Instruções de medição · P2

**Antes.** Não existia campo para "medir a peça esticada, tolerância ±1 cm" — a
informação vivia (se vivia) no WhatsApp do vendedor.

**Depois.** Nova coluna `grades.instrucoes_medidas` (editável no editor com salvamento
próprio e no cadastro da grade). Ela desce sozinha para: catálogo público ("Como
medir"), detalhe do produto, folha A4 impressa e bloco de medidas das etiquetas.

### M7 — Painel de completude das grades · P2

**Antes.** A única visão era "selecionar uma grade no dropdown e esperar". Não havia
resposta para "quais grades estão sem tabela para o cliente ver?".

**Depois.** `GET /api/grades/medidas-resumo` + painel **"Situação das grades"** no topo
do módulo: tamanhos, colunas, barra de preenchimento (n/total), badge
**Completa / Parcial · x% / Sem tabela** e data de atualização, em todas as grades,
com contagem "N de M completas". Clicar na linha edita a grade.

### M8 — Salvaguardas do editor · P2

- **Alterações não salvas:** indicador âmbar no topo e no botão, `beforeunload` ao
  fechar a aba e confirmação ao trocar de grade com pendências.
- **Coluna com valores:** excluir pede confirmação (perderia dados).
- **Célula inválida:** borda vermelha + dica no hover + contagem no status; salvar é
  bloqueado no front e revalidado na API.
- **Progresso:** barra "3 de 10 células" e "Faltam N" no rodapé — tabela parcial não
  passa mais por "pronta".

### M9 — Modelos e cópia entre grades · P2

- **Modelos prontos** (Colunas padrão): Camiseta/Regata, Camisa/Social, Calça,
  Bermuda/Shorts, Agasalho/Moletom, Calçado — criam as colunas certas em um toque
  quando a grade está vazia.
- **Copiar de outra grade:** traz colunas, valores **e instruções** de uma grade
  existente (o fluxo comum de "mesmo modelo, peça nova"), com aviso de substituição;
  nada grava sem o Salvar explícito.

### M10 — Levar a tabela ao atendimento · P2

- **Imprimir:** folha A4 limpa (grade, colunas com unidade, instruções, data de
  atualização) via janela de impressão — o mesmo padrão das etiquetas.
- **Copiar texto:** a tabela formatada vai para a área de transferência para colar no
  WhatsApp/e-mail do cliente.

### M11 — Integridade no banco + código único · P3

- **Migração `0002_medidas_integridade.sql`** (mesmo padrão idempotente do 0001):
  `CHECK (valor >= 0 AND valor <= 3000)` como guarda de último recurso contra
  INSERT/UPDATE direto no banco (o limite por unidade continua sendo validado na API,
  que dá a mensagem amigável), backfill de `atualizado_em` e índice em
  `medida_valores(tamanho_id)`.
- A montagem da tabela agora vive em **um único builder** (`montarTabelaMedidas` em
  `medidas.ts`) usado pelo editor, pelo detalhe do produto e pelo catálogo público —
  fim das três cópias que divergiam (o catálogo, por exemplo, descartava a unidade).

### M12 — "Deixar em branco para remover" não funcionava · P2 · *reproduzido*

**Antes.** O editor dizia "Deixe a célula em branco para remover o valor", mas o
frontend filtra células vazias antes de enviar e o PUT só fazia upsert do que
chegava: o valor apagado na tela **sobrevivia no banco** e continuava visível para o
cliente. (O comentário original do código já prometia essa semântica — a implementação
nunca cumpriu.)

**Depois.** O PUT é **substituição integral**: qualquer (coluna × tamanho) da grade que
não veio preenchido no lote perde o valor antigo, com o remanejamento contado na
auditoria ("... 1 removido(s)"). Teste dedicado: preencher PP e P → salvar só P → o
valor do PP some do banco e do catálogo.

---

## 2. Como verificar (reprodução)

```bash
npm run install:all && npm run dev        # modo demonstração (sem DATABASE_URL)
```

1. Entre como administrador e troque a senha padrão (o fluxo pede; depois o MFA).
2. **Cadastros → Tabela de Medidas:** veja o painel de completude; escolha "Camiseta
   PP-GG", aplique o modelo **Camiseta/Regata**, preencha alguns valores, preencha as
   instruções e salve. A barra de progresso, a data "Atualizada em" e a entrada em
   **Auditoria** confirmam (M4/M5/M7/M8).
3. Digite `-5` numa célula: borda vermelha e Salvar bloqueado no front (M3).
4. **Imprimir** gera a folha A4; **Copiar texto** coloca a tabela no clipboard (M10).
5. **Vendas → Catálogos públicos:** crie um catálogo (nasce com "Mostrar tabela de
   medidas" ligado) e abra o link: toque num produto → todas as fotos, descrição
   completa, tamanhos, tabela com unidade/instruções/data e o link compartilhável da
   peça (M1/M2/M6).
6. Testes: `npm test` no `server/` — 119 testes, 13 novos em `server/test/medidas.test.ts`
   (validação por unidade, auditoria, completude, cópia entre grades, padrão do catálogo).

## 3. Decisões de projeto (e o que ficou de fora, de propósito)

- **Catálogos existentes não viram "com medidas" automaticamente.** O padrão mudou
  apenas para **novos** catálogos: ligar a visibilidade numa loja que ainda não tem
  todas as grades preenchidas exibiria tabelas vazias — isso é escolha operacional
  (um clique no cadastro do catálogo).
- **Limite de 3 m por unidade** é sanidade física, não regra de negócio: a mensagem da
  API diz o limite exato da unidade; o `CHECK` do banco (3000) é só o último muro.
- **Cópia entre grades é no front** (GET + PUT no destino), não um endpoint novo: o
  PUT já é "substituir a tabela inteira" — endpoint duplicaria sem agregar.
- **Ficou para os próximos ciclos (P3):** reordenação de colunas por arraste (hoje:
  excluir/recriar ou copiar), imagem de diagrama de medição por grade (hoje o texto
  das instruções cumpre o papel), histórico valor-a-valor (hoje a auditoria guarda o
  resumo da mudança) e teste de concorrência específico do PUT em Postgres (o
  upsert já roda em transação e o 0002 cobre integridade no banco).

## 4. Evidências

- `server/test/medidas.test.ts` — 13 testes (rodam no CI, sem Postgres).
- Sondas HTTP contra a API em execução nesta auditoria (modo demonstração): login +
  MFA → `GET /api/grades/medidas-resumo` → `PUT /api/grades/1/medidas` (resumo
  `{celulas_total: 10, celulas_preenchidas: 3, pct: 30, atualizada_em: 2026-09-08T22:24:27Z}`)
  → `instrucoes_medidas` persistida → 400s de validação (-5 / 9999 / "abc") → entrada
  de auditoria `"Tabela de medidas de \"Camiseta PP-GG\" atualizada — colunas: +2 ·
valores: 3 gravado(s), 0 removido(s)"` → catálogo público com
  `medidas.{instrucoes, atualizada_em, unidade}` → `mostrar_medidas: true` em catálogo
  novo. Todos os 8 pontos passaram.
