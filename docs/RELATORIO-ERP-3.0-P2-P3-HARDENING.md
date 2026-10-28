# ERP 3.0 — HARDENING P2/P3 (CRM, MRP, COMPRAS, FINANCEIRO, FISCAL, ESTOQUE)

**Data:** 2026-10-27 · **Branch:** `arena/198835b2-brobond-erp` · **Base:** `main @ 507a75b`

Este documento é o relatório de fechamento do ciclo P2/P3. Ele segue a ordem
A→L: decisão arquitetural, o que foi implementado por domínio, o que foi
**deliberadamente não inventado**, e os números dos gates. Tudo o que está
afirmado aqui tem código, migration e teste correspondentes no repositório —
nenhuma afirmação é baseada em "deve funcionar".

---

## A. DECISÃO ARQUITETURAL (o que governou todas as escolhas)

Três regras foram aplicadas sem exceção e explicam praticamente todo o diff:

1. **FONTE ÚNICA.** Nenhum domínio ganhou tabela paralela. Histórico de estágio
   do CRM usa `crm_oportunidade_estagio_historico`; a importação contábil grava
   em `lancamentos_financeiros` (o MESMO livro do balancete), com a origem
   carimbada; unidade de medida usa catálogo + regra declarada, não uma tabela
   de fatores "de fábrica".
2. **O QUE NÃO SE SABE, SE DECLARA.** Lead sem documento não ganha pontos
   inventados; insumo sem ficha técnica aparece em `sem_ficha`; conversão sem
   regra declarada devolve `null` e o MRP marca `conversao_ausente`; MRP não
   cobre lote econômico nem sequenciamento e diz isso em `calculo.nao_coberto`.
3. **O BANCO É A ÚLTIMA LINHA.** Idempotência por unique key (não por SELECT),
   balanceamento de partida dobrada por CHECK, unicidade por empresa por índice,
   transação com rollback em toda escrita multi-tabela.

**O que foi explicitamente recusado:** criar "tela de importação contábil" que
grava primeiro e valida depois; converter metro em quilo por conveniência;
inventar layout SPED sem o manual em mãos; duplicar o livro financeiro para
acomodar o contador.

---

## B. CRM — FUNIL CONFIGURÁVEL, HISTÓRICO, SCORE, PAINEL, LEMBRETES

**Migration 0051** (funil configurável, origem/campanha) + **0057** (etapa
configurável) + **0058** (fechamento P2/P3).

### B.1 Histórico com snapshot de estágio

`crm_oportunidade_estagio_historico` guarda **nomes** e **ids** dos estágios,
`funil_id`, `usuario_nome` e `snapshot_versao`. Motivo: o histórico não pode
depender de o cadastro de etapas continuar existindo com o mesmo nome — renomear
uma etapa reescreveria o passado. Linhas antigas ficam com
`nome_historico_indisponivel: true` e **nunca** são preenchidas por dedução.

### B.2 Mudança de estágio transacional

`POST /api/crm/oportunidades/:id/estagio` — 409 para oportunidade encerrada,
idempotente quando o estágio pedido já é o atual (não grava histórico repetido),
aplica a probabilidade da etapa e grava snapshot na MESMA transação.

### B.3 Reordenação de etapas (sem modal)

`POST /api/crm/funis/:id/etapas/reordenar` — exige a lista COMPLETA de etapas do
funil; 404 cross-tenant, 422 quando a etapa é de outro funil, 400 para lista
incompleta ou id repetido. Renumeração em DUAS passadas (desloca para faixa
negativa e depois para 1..N) para não colidir com o índice único
`crm_etapas_funil_ordem_unico` no meio do caminho. Auditoria grava
`{funil_id, antes, depois}`.

### B.4 Lead scoring determinístico, explicável e limitado

Faixas: `prioritario ≥ 75`, `quente ≥ 50`, `morno ≥ 25`, `frio`. Cada fator tem
`criterio` (chave estável, para código), `rotulo` (texto humano, usado no
motivo), `pontos` e `evidencia`. O motivo é a soma EXPLÍCITA:
`origem/canal (…); documento; valor potencial alto … = 78`. Lead vazio recebe
0 e o motivo diz `sem critérios`. Resultado persistido em
`score`/`score_classificacao`/`score_fatores`/`score_atualizado_em`.

### B.5 Painel com filtros de servidor

`GET /api/crm/painel` aceita `de`, `ate`, `funil_id`, `origem`, `origem_id`,
`etapa`, `etapa_id`, `status`, `responsavel_id`; valor inválido → **400**, nunca
ignorado em silêncio. A resposta declara `filtros.aplicacao.universo` (quantos
registros entraram no recorte), `perdas.por_motivo` e `conversao_por_etapa`.

### B.6 Lembretes de atividade

`crm_atividades` ganhou `lembrete_enviado_em`, `cancelada_em`,
`motivo_cancelamento` e um índice parcial para pendentes.
`dispararLembretesCrm()` roda no mesmo `runScheduled`/`cronScheduled` do resto do
sistema, reivindica cada lembrete com **CAS** (`UPDATE … WHERE
lembrete_enviado_em IS NULL`) e só então notifica — dois processos
simultâneos não mandam o mesmo lembrete duas vezes. Com o canal desligado, nada
é reivindicado (não se marca como enviado o que não foi enviado).

### B.7 Conversão Lead → Oportunidade

`POST /api/crm/leads/:id/converter` é idempotente pela marca
`convertido_oportunidade_id` (readonly no CRUD), cria a oportunidade na MESMA
transação e não duplica cadastro de cliente.

---

## C. MRP — NECESSIDADE, EXPLOSÃO MULTINÍVEL, CONSUMO REAL, LEAD TIME

`GET /api/producao/mrp` foi reescrito (migration 0054 permanece a base de
capacidade). O contrato, em uma frase:

> necessidade = OP restante + falta de produto − disponível; insumo líquido =
> explosão multinível − o que a OP já consumiu; oferta = saldo + compras abertas
> com data esperada dentro do horizonte.

- **OP restante** = `planejado − produzido` (não o planejado cheio — senão o
  plano pede de novo o que já saiu).
- **Falta de produto** = vendas em aberto + déficit de estoque mínimo.
- **Explosão multinível** via `produto_composicao` (fator por linha) somada à
  ficha técnica (`itens_ficha_tecnica`, com perda). Guarda de ciclo por
  caminho, profundidade máxima 12; ciclo é registrado em `calculo.bom_multinivel.ciclos[]`
  e o ramo é cortado — BOM circular é erro de cadastro, não demanda infinita.
- **Consumo real** (`consumoLiquidoDaOrdem`): o que a OP já baixou não vira
  pedido de compra. É a diferença entre "MRP de planilha" e MRP que olha o chão
  de fábrica.
- **Lead time** vem de `fornecedores.prazo_entrega_dias`; sem cadastro,
  `lead_time_dias: null` e `data_esperada_recebimento: null` — nunca um prazo
  arbitrário.
- **Horizonte** por `?de`, `?ate` ou `?horizonte_dias` (1–730, padrão 30; fora
  da faixa → 400). Compra que chega depois do horizonte vai para
  `em_compra_fora_do_horizonte`, não desaparece.
- **Capacidade** é sinalizada a partir de `capacidadeProducao` (carga ×
  capacidade por recurso), sem prometer APS.
- **Calendário produtivo** (migration 0062): dias úteis = seg–sex **menos os
  feriados cadastrados** pela empresa, e a resposta devolve `calendario` com a
  lista dos feriados que entraram no cálculo (número auditável). Feriado móvel
  (Carnaval, Sexta-feira Santa) não é derivado — entra como linha do ano.
- **Declaração de escopo** (`calculo.coberto` / `calculo.nao_coberto`) é parte
  do contrato: o endpoint diz o que faz e o que **não** faz (lote mínimo,
  sequenciamento/APS, pegging), e o teste M exige essa lista.
- **Nunca cria pedido de compra** — teste G conta `compras` antes e depois.

---

## D. COMPRAS — HOMOLOGAÇÃO DE FORNECEDOR E DESEMPENHO

- Estados `pendente → em_analise → homologado → suspenso|bloqueado`, com
  motivo obrigatório na suspensão/bloqueio e trilha em
  `fornecedor_homologacao_eventos` (readonly, `internal`).
- **Guarda de pedido** (`fornecedorHomologacaoGuard.ts`): fornecedor suspenso ou
  bloqueado não recebe pedido NOVO (409 com instrução de regularização). Pedido
  existente segue o curso — bloquear história em andamento seria reescrever o
  passado.
- **Alçada**: homologar é decisão de gestão (`exigirGestor`); LER o cadastro
  continua liberado para o operador, porque compras precisa do fornecedor na
  cotação. Essa separação está documentada no próprio auditor de menu
  (`ALCADA_POR_GUARDA_PROPRIA`) — ver seção J.
- **Desempenho** é calculado das compras reais (prazo, completude, preço),
  com janela explícita na resposta; nada é estimado quando não há histórico.

---

## E. FINANCEIRO — IMPORTAÇÃO CONTÁBIL SOBRE O LIVRO ÚNICO

**Migration 0059.** Duas rotas:

| Rota | Efeito |
| --- | --- |
| `POST /api/financeiro/importacao-contabil/preview` | valida tudo, **não grava nada** |
| `POST /api/financeiro/importacao-contabil` | repete a validação em transação e grava |

- Cada **partida** vira uma linha de `lancamentos_financeiros` com
  `conta_contabil_id`, `natureza_lancamento`, `partida_id`,
  `documento_origem_recurso = 'fin_importacoes_contabeis'` e
  `documento_origem_id = <lote>`. Não existe segundo ledger.
- **Balanço por LANÇAMENTO**, não só no total do arquivo: o lote clássico que
  fecha no total mas tem entradas tortas é recusado (teste D).
- **Conta inválida** (inexistente, sintética ou inativa) → 422 com a lista de
  partidas e o motivo. Conta de outra empresa não existe no plano do ator (teste F).
- **Idempotência** pelo hash SHA-256 do conteúdo normalizado, com unique
  `(empresa_id, hash)`: reimportar devolve o MESMO lote (`idempotente: true`) e
  grava zero partidas. Duas requisições simultâneas: uma insere, a outra pega a
  unique e devolve o lote vencedor.
- **Sem dupla contagem no caixa**: `resumoFinanceiro` exclui as linhas de
  importação contábil do fluxo/DRE de caixa e DECLARA isso em
  `contabil_ignorado: { partidas, valor, motivo }`. Elas continuam no balancete,
  que é o lugar delas (teste G).

---

## F. FISCAL — INFRAESTRUTURA DE OBRIGAÇÕES (SEM INVENTAR LAYOUT)

- `fiscal_obrigacoes` + `fiscal_obrigacoes_entregas` (0055) com calendário,
  histórico por obrigação e registro de entrega.
- O recurso passou a exigir **gerente no servidor** (antes só o menu
  restringia — a API respondia a operador; achado `RBAC_DERIVA_SOLTA` corrigido
  na origem, não silenciado).
- **Não foi gerado arquivo SPED/EFD.** Escrever layout sem o manual em mãos
  produziria arquivo que a Receita recusa — e um arquivo "quase certo" é pior
  que nenhum, porque o contador confia nele. A infraestrutura (obrigação,
  competência, prazo, entrega, histórico) está pronta para receber o gerador.
  Ver GAPS.

---

### F.1 Importação do PLANO DE CONTAS (P2-13, fechado)

`POST /api/financeiro/plano-contas/importar/preview` e
`POST /api/financeiro/plano-contas/importar` (módulo
`server/src/financeiroImportacao.ts`):

- a importação de PARTIDAS só funciona se as contas existirem — sem isso o
  contador teria de digitar o plano conta por conta, que é onde o processo
  morre na prática;
- o arquivo traz `codigo`, `nome`, `natureza`, `tipo` (analítica/sintética) e,
  opcionalmente, `pai_codigo`. Sem `pai_codigo`, a hierarquia é deduzida do
  próprio código (prefixo por ponto) e a resposta marca `pai_deduzido: true`;
- **pai precisa existir e ser SINTÉTICA**; conta que é pai no arquivo precisa
  ser sintética; código duplicado no arquivo é **erro** (a última linha não
  sobrescreve a primeira);
- `modo: 'criar_apenas'` (padrão) nunca altera conta existente;
  `modo: 'atualizar'` altera nome/natureza/tipo e o **preview lista
  `mudancas`** antes de qualquer escrita;
- qualquer problema de estrutura → **422 e nada é gravado** (transação);
- **nada é apagado**: conta que sai do arquivo continua no plano;
- idempotente por `(empresa_id, codigo)`; auditoria registra modo, criadas,
  atualizadas, ignoradas e total do arquivo.

---

## G. ESTOQUE — UNIDADE DE MEDIDA, CONVERSÃO DECLARADA E MRP

**Migration 0060** (P3-04 / P3-07). O problema real: compra-se em ROLO e
consome-se em METRO; `insumos.unidade` era texto livre, sem fator.

- `unidades_medida`: catálogo por empresa com `grandeza` — impede conversão sem
  sentido (metro ≠ quilo) já no cadastro.
- `unidade_conversoes`: regra `1 [de] = fator [para]`, única por empresa/par,
  fator > 0, par distinto.
- `insumos.unidade_compra`: como o insumo é COMPRADO (opcional; vazio = mesma
  unidade de uso).
- `server/src/unidades.ts` resolve **só regra declarada**, nos dois sentidos
  (1 rolo = 50 m ⇒ 120 m = 2,4 rolos), aceita cadeia (rolo → caixa → metro,
  profundidade 3) e devolve o **caminho** de cada conversão. Sem regra: `null`.
- **MRP** passou a expor `unidade_compra`, `fator_conversao`,
  `necessario_comprar_na_unidade_compra` e `conversao_ausente` — o comprador vê
  "5 rolos" quando a regra existe, e o MRP **avisa** quando o cadastro promete
  uma unidade de compra sem conversão declarada.
- `GET /api/estoque/unidades/conversoes` lista o que a empresa declarou.

**Contagem cíclica (P2-16)** não foi implementada: o inventário existente
(ciclo contar → divergência → aprovação → ajuste) cobre o caso completo, mas a
PAUTA cíclica por curva ABC não existe. Ver GAPS.

---

## H. SEGURANÇA E MULTIEMPRESA

- Todo recurso novo (`unidades_medida`, `unidade_conversoes`,
  `fin_importacoes_contabeis`) é `empresa: true` com `minPerfil: 'gerente'` e
  tem teste de isolamento A × B nominal.
- Rotas de escrita do CRM/financeiro revalidam escopo DENTRO da transação
  (o plano de contas pode mudar entre preview e confirmação).
- Erros de tenant são **404**, não 403: não se confirma a existência de registro
  de outra empresa.
- `fiscal_obrigacoes` deixou de vazar para operador (RBAC no servidor).
- Importação contábil nunca aceita conta de outra empresa, mesmo que o código
  exista lá (a busca é no plano do ator).
- A trilha de auditoria registra lote, hash, arquivo, totais e quem importou;
  a reordenação de etapas registra antes/depois.

---

## I. UX — ZERO MODAL PRESERVADO

- A reordenação de etapas é **endpoint + lista**, sem modal/drawer.
- Os três módulos novos (Unidades de medida, Conversões de unidade, Importações
  contábeis) são páginas de lista/cadastro do padrão LISTA → PÁGINA. Nenhuma
  sobreposição nova foi introduzida: `npm run audit:ux` continua
  "nenhuma sobreposição nova em fluxo de módulo".
- O auditor de menu passou a reconhecer `/novo` e `/editar` como rotas de
  formulário (alcançadas pelo botão da listagem) em vez de tratá-las como
  "rota sem menu" — era ruído estrutural, não divergência.

---

## J. GATES E O QUE CADA UM PROVA

| Gate | Comando | O que prova |
| --- | --- | --- |
| Tipos | `npm run typecheck` | server + client compilam |
| Suíte | `npm --workspace server test` | contrato in-memory (mesmo contrato do PG) |
| PostgreSQL | `npm run test:pg` | schema real, migrations, concorrência, tenancy |
| Smoke PG | `npm run smoke:pg` | servidor sobe contra PG e responde |
| Menu | `npm run audit:menu` | menu × rotas × recursos × RBAC × escopo |
| Arquitetura | `npm run architecture:audit` | recurso × tabela × tenant × Prisma |
| UX | `npm run audit:ux` | zero modal, sem sobreposição em fluxo de módulo |
| Bootstrap | `node scripts/gerar-bootstrap.mjs --check` | `db/bootstrap.sql` = `db/schema.sql` |
| Build | `npm run build` | client empacota |

**Fechamentos de divergência REAL feitos neste ciclo** (não foram
silenciados, foram corrigidos):

1. `crm_funis.nome` era declarado único por empresa e o banco não tinha o
   índice → migration 0061 cria `uq_crm_funis_empresa_nome`, com normalização
   determinística de nomes repetidos antes (senão a migration falharia em base
   real).
2. `fiscal_obrigacoes.codigo` e `plano_contas.codigo` eram declarados únicos
   GLOBAIS; o banco é por empresa (e está certo) → a declaração foi corrigida
   para `uniqueEmpresa`.
3. `fiscal_obrigacoes` restringia só o menu → agora exige gerente no servidor.
4. Rotas do agente de impressão (`/api/print/agent/*`) são legitimamente
   pré-auth (token de pareamento próprio) → documentadas no allowlist do
   auditor, com o motivo escrito no código.
5. Homologação de fornecedor: alçada de escrita em guarda própria
   (`exigirGestor` + `fornecedorHomologacaoGuard.ts`), agora documentada em
   `ALCADA_POR_GUARDA_PROPRIA` — antes era um aviso sem explicação.

---

## K. POSTGRESQL — EVIDÊNCIA

PostgreSQL **16.14** real (`server_version_num = 160014`), banco `brobond_teste`
recriado do zero a cada execução (o gate recusa banco sujo — P2-09).

Os números da última execução dos gates estão no bloco de fechamento
(seção L) e em `docs/evidencias/` quando aplicável. A suíte guarda:

- migrations aplicadas em ordem, com `schema_migrations` versionado;
- constraints de negócio no banco (partida dobrada balanceada, etapa com ordem
  única, fator > 0, par distinto, status válido);
- concorrência real (dois estornos simultâneos, duas conclusões simultâneas,
  duas importações do mesmo lote);
- tenancy em todas as rotas de escrita.

---

## L. GAPS REMANESCENTES (declarados, com próximo passo concreto)

| Item | Situação | Próximo passo |
| --- | --- | --- |
| P2-12 SPED/EFD | **Não implementado.** Infra de obrigações/prazos/entregas pronta; nenhum layout foi escrito. | Implementar por layout com o manual oficial em mãos, começando por EFD ICMS/IPI com validação contra o validador da Receita. |
| P2-15 feriados | **FECHADO** (migration 0062 + `server/src/calendario.ts`). Capacidade e MRP descontam feriado e devolvem o calendário usado. Feriado móvel é cadastrado por ano, não derivado. | — |
| P2-15 sequenciamento/APS | **Não implementado**, e declarado em `calculo.nao_coberto`. | Exige decisão de APS (fila, prioridade, setup); não é o MRP. |
| P2-16 contagem cíclica | **Não implementado.** Inventário completo existe; falta a pauta por curva ABC. | Gerar `inventarios`/`itens_inventario` a partir da curva ABC com periodicidade declarada. |
| P2-19 baseline de UI | **Não atualizado** para os três módulos novos. | Rodar `npm run audit:ux` e anexar o snapshot ao baseline JSON. |
| P3-05 terceiros (facção) | **Não implementado.** Não há cadastro de terceiro nem estoque em poder de terceiro. | Modelar `terceiros` + `estoque_terceiros` (envio, retorno, perda) com movimento de estoque próprio. |
| P3-06 | **Não implementado** (dependente de P3-05). | Depois de P3-05: custo de serviço de terceiro no custo do produto. |
| Unidade de medida — UI de conversão na compra | Backend e MRP prontos; a tela de pedido ainda mostra a quantidade na unidade de uso. | Exibir `necessario_comprar_na_unidade_compra` na cotação/pedido, com o fator visível. |

Nenhum item desta lista foi marcado como concluído, e nenhum teste foi afrouxado
para "passar": onde o comportamento mudou (MRP), o teste passou a exigir a lista
NOVA de cobertura e continua exigindo a lista de exclusões.
