# Relatório de auditoria técnica E4.1 — Estoque Avançado

**Repositório:** `petrickmsilva-alt/brobond-erp`
**Data:** 2026-10-09 (UTC)
**Base efetivamente revisada:** branch `arena/4cb6e53b-brobond-erp`, HEAD `d13cffa6919f8bf26df770b01124da7395346a92`
**Natureza:** auditoria estática e plano conceitual; sem implementação E4.

> **Conclusão executiva:** há uma base útil de saldo, movimentação, compra, produção e contagem, mas **E4 não está pronto para ser considerado seguro em cenário multiempresa**. Há caminhos HTTP autenticados sem recorte de empresa; o recebimento de uma devolução total pode repor estoque duas vezes (e recolocar unidades avariadas); e faltam vínculos formais e idempotência em operações críticas. Reservas e lotes não existem. A sequência recomendada começa pela fronteira entre empresas, antes de expandir as funções de estoque.

## 1. Escopo, método e limites

Foram examinados schema e migrações, serviços de domínio, handlers e registro de rotas, páginas e navegação do cliente, testes existentes e `docs/ERP-GAPS.md`. A auditoria se limita a estoque de produto acabado e insumos, locais, movimentos, transferências, inventário, ajustes, mínimos/máximos, reserva, custo, integrações e seus fluxos adjacentes de venda, compra e produção.

- **Nenhuma regra de negócio foi alterada.** Este relatório é a única entrega desta etapa; não foram criados migrations, endpoints, componentes, código provisório ou correções.
- **Testes, typecheck, lint, build, smoke e consultas a banco não foram executados nesta auditoria.** As referências a PostgreSQL abaixo vêm do schema/migrações e da cobertura declarada pelos testes existentes, não de uma execução desta etapa.
- O `docs/ERP-GAPS.md` se identifica com baseline `e6cb2f0` e branch `arena/3b3ee997-brobond-erp` (linha 4). Este relatório registra o checkout realmente disponível (`d13cffa`, branch de sessão acima); não presume que a evidência estática equivale a validar um banco implantado.
- A auditoria ficou somente no repositório `brobond-erp`.

### Vocabulário de classificação

- **Completo (no escopo observado):** há fluxo e invariantes coerentes, sem substituir a futura validação de implantação.
- **Parcial:** existe capacidade funcional, mas falta cobertura, vínculo, política ou caso operacional importante.
- **Ausente:** não foi encontrado modelo ou fluxo correspondente.
- **Incorreto/inseguro:** o comportamento existente pode vazar dados, alterar outro tenant ou produzir saldo/custo errado.

## 2. Resumo de situação por capacidade

| Capacidade | Estado | Síntese |
|---|---|---|
| Saldo de produto acabado | **Parcial — base consistente, com exceção para tamanho nulo** | Saldo por produto/tamanho/local, `CHECK` contra negativo e abatimento condicional no PostgreSQL. Como `tamanho_id` é anulável, a chave única e o SQL de abatimento não são null-safe para produtos sem tamanho; além disso, a camada HTTP especializada não aplica sempre o escopo da empresa. |
| Livro de movimentações | **Parcial** | Entrada/saída/ajuste e estorno reverso existem; compra e OP têm alguns vínculos formais. Vendas e inventário ainda dependem de texto para relacionar eventos, e transferência não tem entidade própria. |
| Multiempresa | **Incorreto/inseguro — crítico** | CRUD genérico deriva e valida escopo; handlers diretos, relatórios, importação e WooCommerce têm caminhos sem esse recorte. Ter autenticação global não equivale a autorização por empresa. |
| Concorrência | **Parcial** | Transações PostgreSQL são serializáveis por padrão; produto acabado usa abatimento atômico. Insumos dependem de leitura antes da escrita, sem CHECK não negativo. Não há retry visível para falhas de serialização. |
| Idempotência | **Parcial** | Recebimento de compras, importação de NF-e, expedição e algumas transições têm salvaguardas. Venda de PDV e transferência não oferecem chave de idempotência; uma repetição pode materializar nova operação. |
| Transferências | **Parcial** | A API grava saída e entrada na mesma transação e debita a origem condicionalmente. As duas linhas não pertencem a uma entidade formal e podem ser estornadas separadamente. |
| Inventário físico | **Parcial — fluxo funcional, escopo inseguro** | Snapshot, contagem, fechamento, comparação com o saldo atual e bloqueio de fechamento repetido existem. Snapshot e endpoints especializados não recortam por empresa; itens não garantem que produto e inventário pertençam ao mesmo tenant. |
| Ajustes e estornos | **Parcial** | Alterar saldo pelo Estoque Físico gera ajuste e movimentação pode ser revertida sem permitir saldo acabado negativo. Motivo é opcional em movimentos e não há vínculo formal de inventário/venda. O endpoint de estorno não verifica empresa. |
| Locais | **Incorreto para o modelo multiempresa atual** | A tabela tem `empresa_id`, mas nome é globalmente único e seleção do local padrão é global. Movimentos e saldos ainda usam texto livre como parte da chave. |
| Reservas | **Ausente** | Não há entidade nem saldo reservado. `reserva_horas` existe em política comercial, mas não efetiva reserva. A sugestão de compra desconta pedidos em aberto como projeção, não como bloqueio de saldo. |
| Mínimo/máximo e reposição | **Parcial** | Há mínimo por célula de estoque, mínimo/máximo no cadastro do produto e sugestão de compra; as duas fontes de limite não são a mesma política. Sugestão agrega tamanhos/locais por produto e considera transferências de saída como consumo. Insumos não têm máximo. |
| Custo e valorização | **Parcial/inconsistente** | Recebimento calcula custo médio ponderado e registra custo unitário de entrada; ficha técnica também grava `produtos.custo` com outra semântica. Item de venda não guarda custo histórico; relatório valoriza saldo pelo custo atual. |
| Lote/validade/série | **Ausente; decisão pendente** | Não há vínculo de lote em saldo/movimento. A própria documentação deixa a aplicabilidade como decisão de produto, não como implementação existente. |
| UI e qualidade | **Parcial** | Grade e inventário têm telas próprias; sugestão de compra tem teste de UI. Não foi encontrado teste dedicado das telas de grade/inventário nem teste de rotas especializadas em escopo multiempresa. |

## 3. Evidências de arquitetura e invariantes existentes

### 3.1 Banco e migrações

O schema modela `estoques` por produto, tamanho e nome de local, com unicidade nessa chave e `CHECK (quantidade >= 0)` (`db/schema.sql:223–235`). Movimentações são append-oriented por API (`ops` só permite criar), embora o registro original seja atualizado com flags de estorno (`server/src/resources.ts:1269–1317`; `db/schema.sql:237–250, 530–538`). A tabela de insumos, em contraste, não tem `CHECK` de saldo não negativo (`db/schema.sql:348–366`). Além disso, `tamanho_id` em `estoques` é anulável, mas a unicidade é ordinária `(produto_id, tamanho_id, local)` (`db/schema.sql:224–235`): no PostgreSQL, duas linhas com `tamanho_id IS NULL` não colidem por essa chave. O recebimento canônico declara tamanho opcional (`server/src/custoRecebimento.ts:314–318`), enquanto `adjustStock` usa `ON CONFLICT` nessa chave e `tryAdjustStock` usa `tamanho_id = $2` (`server/src/pgstore.ts:290–300, 327–350`).

`empresa_id` foi acrescentado às raízes e filhas na migração 0017; triggers derivam a empresa de várias tabelas-pai (`db/migrations/0017_multiempresa_isolamento.sql:75–152, 154–165`; espelho em `db/schema.sql:1582–1654`). Isso é uma boa proteção contra `empresa_id` falsificado, **mas não prova que um ator pode acessar a linha**, nem que dois FKs de uma linha filha apontem para registros da mesma empresa. Em particular, o trigger de `itens_inventario` deriva o tenant do inventário; não valida, por si só, que `produto_id` pertença àquela empresa.

Há colunas `local_id` e `local_destino_id`, mas os nomes textuais continuam no schema e a transferência é apenas um inteiro sem FK (`db/schema.sql:509–535`). `inventarios` e `itens_inventario` têm estado e unicidade por inventário/produto/tamanho, mas `movimentacoes` não tem `inventario_id`; o fechamento grava o identificador do inventário em `motivo` (`db/schema.sql:540–565`; `server/src/estoque.ts:279–283`).

### 3.2 Escopo HTTP: o que protege e o que não protege

O middleware global exige autenticação (`server/src/index.ts:339–345`). As rotas CRUD genéricas passam `escopoDe(currentUser(req))` para listagem, leitura e criação (`server/src/index.ts:774–826`); a normalização de filtros descarta `empresa_id` enviado pelo cliente (`server/src/empresa.ts:182–195`). Essa é a fronteira esperada.

O próprio helper declara que `comoEscopo(undefined)` significa **sem recorte**, reservado a chamadas internas (`server/src/services.ts:58–72`). `getRecord` também aceita escopo opcional; sem escopo, `assertRegistroDaEmpresa` não restringe tenant (`server/src/services.ts:238–247`; `server/src/empresa.ts:198–215`). Logo, nenhum middleware global transforma automaticamente um handler customizado em multiempresa seguro: a rota precisa passar o escopo e validar referências.

Há um caso concreto no CRUD: `createRecord` carimba a empresa, mas retorna imediatamente para `movimentacoes` e `movimentacoes_insumos` antes de `validarReferenciasDaEmpresa` (`server/src/services.ts:418–464`). Esses dois caminhos customizados recebem `actor`, não o escopo resolvido. O helper de movimento aceita IDs de produto/local encontrados globalmente (`server/src/services.ts:1204–1269`); o trigger do banco carimba o tenant derivado do produto, mas não impede que um gerente de outra empresa tenha iniciado a operação.

### 3.3 Concorrência

PostgreSQL abre transação `SERIALIZABLE` por padrão e faz rollback em falha (`server/src/db.ts:74–89`; `server/src/pgstore.ts:172–174`). O abatimento de produto acabado usa `UPDATE ... WHERE quantidade + delta >= minimo` (`server/src/pgstore.ts:327–350`), reduzindo a janela de oversell. A camada não mostra retry automático de erro de serialização. O modo em memória só tira snapshot/recupera em exceção, sem isolamento equivalente (`server/src/memdb.ts:128–135`; limitação reconhecida também em `server/test/auditoria.test.ts:185`).

## 4. Achados de risco e comportamento

### E4.1-01 — Escopo multiempresa não é aplicado uniformemente (**CRÍTICO / P0**)

O conjunto de rotas especializadas é registrado antes da rota genérica (`server/src/index.ts:734–743`; a rota genérica só começa em `:774`). Autenticação e `checkAccess` aplicam sessão/RBAC, mas os handlers abaixo consultam ou alteram o `Store` sem `escopoDe`/`assertRegistroDaEmpresa`:

- **Grade:** `/api/estoques/grade` lista produtos e saldos sem `empresa_id` (`server/src/estoque.ts:25–40`). Pode revelar produto, preço, custo e saldo de outras empresas.
- **Inventário:** detalhe, itens, contagem e fechamento buscam inventário/item por ID sem validar empresa (`server/src/estoque.ts:119–131, 169–209, 226–303, 310–315`). O snapshot da abertura filtra apenas por texto de local, sem tenant (`server/src/services.ts:1330–1356`). A inclusão de uma linha de contagem “achada” aceita `produto_id`/`tamanho_id` sem verificar a empresa do produto (`server/src/estoque.ts:199–209`).
- **Estorno:** `/api/movimentacoes/:id/estornar` usa `findOneWhere({id})`, sem validar a empresa do movimento (`server/src/estoque.ts:337–350`). Gerente/admin autenticado de A pode atingir um movimento de B por ID.
- **Detalhe de produto:** `productDetail` chama `getRecord` sem escopo e depois carrega movimentos, estoque, OP e ficha por produto (`server/src/detail.ts:37–52`); `/api/produtos/:id/tamanhos` busca diretamente o produto por ID (`server/src/detail.ts:19–35`).
- **Movimentação manual:** além do early return no serviço, `createMovimentacao` valida existência de local, não titularidade; uma referência de produto/local de outra empresa não é rejeitada ali (`server/src/services.ts:432–433, 1204–1269`). O problema também se estende à criação manual de movimento de insumo (`server/src/services.ts:1302–1326`).
- **Importação:** o preview normaliza SKU, tamanho, categoria, coleção e local por busca global (`server/src/importacao.ts:88–172`). A confirmação recebe `linhas` diretamente e faz `s.insert` em vez de `createRecord`, sem carimbar o escopo ativo (`server/src/importacao.ts:228–281`). Para cadastros raiz, a inserção não informa `empresa_id`; no schema esse campo tem default 1. Para saldo, um SKU de outra empresa pode ser resolvido globalmente. A confirmação também captura qualquer erro de linha e só incrementa `pulados`, sem devolver causa (`:246–279`).
- **Relatórios:** posição, movimentações e mínimo carregam produtos/estoques/movimentos sem filtro de empresa (`server/src/relatorios.ts:49–60, 140–151, 550–557`). A mesma resposta atende JSON e exportação CSV/XLSX (`:26–44`), então o problema alcança os arquivos.
- **WooCommerce:** diagnóstico/importação/sincronização consultam cadastros e saldo sem filtro explícito (`server/src/loja.ts:310–320, 344–357, 506–549`). SKUs podem se repetir entre empresas; a importação escolhe o primeiro produto encontrado e a sincronização monta um índice por SKU que pode sobrescrever uma empresa com outra. A venda importada tampouco grava `empresa_id` no `s.insert` (`:385–444`), enquanto os produtos do mapa não foram recortados pela empresa ativa.

Esses caminhos são diferentes do CRUD genérico. `server/test/multiempresa.test.ts` prova principalmente CRUD e tem um teste que registra que chamadas internas sem escopo continuam irrestritas (`:222`); `server/test/pg-multiempresa.test.ts` verifica triggers/SQL, não a matriz dessas rotas HTTP. Também não foi encontrado teste PG para a chave de estoque com `tamanho_id IS NULL`. **Não considerar as garantias genéricas suficientes para proteger handlers especializados.**

### E4.1-02 — Devolução total pode somar a reposição duas vezes (**ALTO / P1**)

Na devolução recebida, unidades em estado `bom` são adicionadas ao saldo e geram movimento de entrada (`server/src/expedicao.ts:671–698`). Depois, se a quantidade recebida naquela devolução for pelo menos a quantidade vendida, o mesmo fluxo cancela a venda e chama `aplicarRegrasPedido` (`:704–719`). Na transição de venda faturada para cancelada, essa regra chama `estornarVenda` (`server/src/itens.ts:536–555`), que procura as saídas originais pelo texto `Venda #<id>` e adiciona de volta **todas** as unidades vendidas (`:387–411`).

Consequência inferida do código: em uma venda real de duas peças, uma devolução total de duas peças boas aumenta o estoque em quatro; se as duas recebidas estiverem avariadas, o estorno da venda ainda pode devolver as duas ao saldo vendável, embora o recebimento tenha deliberadamente evitado a entrada. É necessário separar reversão financeira da baixa original e entrada física aprovada pela devolução.

Há ainda um caso cumulativo: a decisão de “total” soma `quantidade_recebida` apenas dos itens da devolução corrente (`expedicao.ts:706–711`), embora a solicitação limite o total somando devoluções vivas do pedido (`:468–500`). Duas devoluções parciais que juntas devolvam todo o pedido podem deixar a venda/financeiro sem cancelamento automático.

A cobertura atual não detecta o primeiro problema: `pedidoFaturado` no teste muda o status diretamente (`server/test/expedicao.test.ts:305–310`), sem passar pelo faturamento real e sem criar a saída `Venda #...`; o teste de devolução total espera saldo `+2` nesse estado incompleto (`:389–403`). Isso é uma lacuna da fixture/caso de teste, não evidência de que o fluxo real esteja correto. Esta conclusão é estática; não foi executada uma reprodução nesta etapa.

### E4.1-03 — Transferência tem atomicidade parcial, mas não identidade de operação (**ALTO / P1**)

O fluxo retira da origem condicionalmente e cria saída + entrada dentro da transação (`server/src/services.ts:1243–1270`), o que é um bom núcleo. Porém, as linhas são gravadas como tipos `saida` e `entrada`; a origem aponta `transferencia_id` para si e o destino aponta para a origem. O campo não tem FK e não existe tabela `transferencias_estoque` (`db/schema.sql:525–528`; confirmado no código atual). As pernas podem ser estornadas separadamente.

A rotina de estorno tem um ramo especial para `tipo === 'transferencia'` (`server/src/estoque.ts:357–380, 403–435`), mas o criador não grava nenhuma das duas pernas com esse tipo. Portanto, a inversão em grupo não é o caminho aplicado às transferências que a API cria. Uma repetição do POST também cria outro par: não há chave idempotente/ID de comando nesse contrato. Além de grupo e replay, origem/destino não têm validação de empresa.

### E4.1-04 — Reposição de devolução, PDV e ajustes não compartilham idempotência

`POST /api/pdv/vendas` abre uma venda em nova transação e fatura/baixa estoque no mesmo fluxo (`server/src/pdv.ts:503–515, 638–655`), mas não foi localizado `idempotency_key` no caminho examinado. Se a resposta se perder após o commit e o cliente repetir o POST, o código não identifica que se trata da mesma venda; pode criar nova venda e nova baixa.

Em contraste, a expedição protege a transição por estado/CAS (`server/src/expedicao.ts:339–357`), o recebimento de compra tem trilha/índice e testes de repetição no PostgreSQL (`server/test/pg-custo-recebimento.test.ts:453–472`) e a devolução recebida impede uma segunda entrada pelo status/flag (`server/src/expedicao.ts:638–640, 668–702`). O fechamento de inventário tem guarda sequencial `status === fechado` (`server/src/estoque.ts:236–243`). São salvaguardas úteis, mas não substituem chave de idempotência e resposta repetível em comandos sujeitos a timeout, concorrência ou reenvio.

### E4.1-05 — Insumos não têm a mesma invariável de não negatividade do produto acabado (**ALTO / P1**)

A tabela `estoque_insumos` não declara CHECK de quantidade (`db/schema.sql:348–366`). A saída manual verifica saldo e depois chama atualização aditiva (`server/src/services.ts:1313–1321`; `adjustInsumoStock` em `server/src/pgstore.ts:373–384`). A baixa de OP também lê saldo e, quando gerente/admin usa `?forcar=true`, permite explicitamente que fique negativo (`server/src/producao.ts:351–395`).

O override é documentado/auditado, mas não é uma regra de banco; o estado negativo pode existir sem uma entidade explícita de exceção/justificativa estruturada. Em concorrência, o `SERIALIZABLE` pode abortar uma das transações, mas não há predicado de saldo suficiente no `UPDATE` como há para produto acabado, nem retry geral para serialização. Não foi encontrada cobertura PostgreSQL de saídas manuais de insumo concorrentes.

### E4.1-06 — Local é parcialmente global apesar da coluna por empresa (**ALTO / P1**)

`locais` possui `empresa_id`, mas `nome` é `UNIQUE` global (`db/schema.sql:509–517`) e o recurso também descreve unicidade de nome (`server/src/resources.ts:399–430`). O seletor de local padrão (`getDefaultLocalInfo`, `garantirLocalPadrao` e `ensureLocalPadraoUnico`) pesquisa e altera registros sem escopo de ator/empresa (`server/src/services.ts:1032–1077`). Saldos, inventários e movimentos ainda têm `local` textual, e `resolveLocal` só verifica se o ID existe (`:1204–1219`).

Isso mistura conceitos de tenant e identidade física: criar/selecionar um padrão numa empresa pode desmarcar o padrão de outra; duas empresas não conseguem cadastrar o mesmo nome; movimentos podem cair no nome de um local alheio por ID ou pelo fallback global; renomear propaga por todas as linhas com o mesmo texto (`server/src/services.ts:1159–1176`). O snapshot de inventário por texto de local amplia o risco de misturar saldos (`:1330–1356`). A política de “local físico compartilhado entre empresas” precisa ser decidida explicitamente; se os locais forem privados por empresa, unicidade e padrão devem ser compostos por empresa.

### E4.1-07 — Há dois níveis de mínimo/máximo sem política única (**MÉDIO / P2**)

Há `estoque_min` no saldo por produto/tamanho/local (`server/src/resources.ts:1250–1264`) e `estoque_min`/`estoque_max` no produto (`:1016–1022`, migration 0018). A sugestão de compra usa o limite do cadastro do produto; relatórios e alertas da grade usam o mínimo do saldo (`server/src/compras.ts:418–431, 469–502`; `server/src/relatorios.ts:550–575`). Os valores podem divergir sem uma regra de precedência.

A sugestão agrega estoque e pedidos por produto, somando tamanhos/locais, ao passo que o alerta operacional é por célula. Isso pode esconder falta de um tamanho ou superestocar outro. O cálculo é útil como ponto de partida — considera pedidos em aberto, compras pendentes e consumo histórico — mas não cria reserva de verdade. Além disso, consumo é estimado somando qualquer movimento `tipo === 'saida'` (`server/src/compras.ts:455–465`); como uma transferência é modelada com uma saída na origem, ela pode ser contada como demanda externa e inflar reposição. Não existe `estoque_max` por local/tamanho nem máximo para insumos.

### E4.1-08 — Tamanho nulo não tem unicidade/abatimento seguro (**ALTO / P1**)

`estoques.tamanho_id` aceita `NULL`, e o recebimento de produto permite tamanho opcional (`db/schema.sql:224–235`; `server/src/custoRecebimento.ts:314–318`). A chave `UNIQUE (produto_id, tamanho_id, local)` é a forma ordinária; no PostgreSQL, valores nulos não colidem como duplicata. O serviço de criação de saldo também pula a validação quando não há tamanho (`server/src/services.ts:1020–1027`).

Consequência: uma nova entrada sem tamanho pode criar outra linha em vez de somar à anterior, pois `adjustStock` usa `ON CONFLICT` pela mesma chave (`server/src/pgstore.ts:290–300`). O abatimento `tryAdjustStock` cria/atualiza por `tamanho_id = $2` (`:327–350`); para `NULL`, a igualdade SQL não corresponde a linha. Portanto, a promessa de saldo único e abatimento condicional não cobre o caso sem tamanho. O comportamento precisa ser decidido para produto simples e protegido com chave null-safe e SQL de igualdade compatível, com teste PG para entradas repetidas, saída e concorrência.

### E4.1-09 — Política de custo e CMV histórico não são canônicos (**ALTO / P1**)

A ficha técnica calcula custo com consumo × (1 + perda) × custo médio do insumo, mais mão de obra e indiretos; aplicar preço da ficha grava `custo_calculado` em `produtos.custo` (`server/src/producao.ts:864–885, 1003–1040`). Recebimento de produto também grava em `produtos.custo` a média ponderada do custo efetivo de compra/frete/impostos, sob trava de custo (`server/src/custoRecebimento.ts:308–350`). São duas semânticas para a mesma coluna e podem concorrer: aplicar ficha não usa a mesma trava/política de recebimento.

A posição valorizada multiplica saldo atual pelo custo atual de produto (`server/src/relatorios.ts:61–70`). O item de venda guarda preço usado, mas não encontramos snapshot de custo em `itens_venda` (`server/src/resources.ts:1663–1684`); a baixa real em `faturarVenda` grava produto, tamanho, local, quantidade e motivo, não o custo unitário (`server/src/itens.ts:342–354`). O motor de margem prioriza custo vivo/persistido da ficha e depois `produtos.custo` (`server/src/negocios.ts:493–535`). Portanto, custo/CMV histórico pode mudar após atualização de insumo ou ficha. O custo unitário gravado em movimentos de recebimento (`server/src/custoRecebimento.ts:333–350`) é um avanço, mas não fecha custo histórico da venda nem política de valorização por localização/lote.

## 5. APIs, telas e dependências verificadas

| Fluxo | API/implementação | Tela ou navegação | Testes encontrados / lacuna |
|---|---|---|---|
| Grade de saldo | `GET /api/estoques/grade` (`index.ts:734–743`, `estoque.ts:25–113`) | `MODULES` “Estoque Físico”; `EstoqueGradePage.tsx` (`modules.ts:121`; a tela chama a rota em `:72–89`) | `server/test/grades.test.ts:114–132` confere formato/agrupamento, não tenant. Sem teste de UI ou empresa A→B. A rota limita a leitura a 2.000 produtos/5.000 saldos sem sinalizar truncamento (`estoque.ts:34–41`). |
| Movimento e ajuste | `POST /api/movimentacoes` via CRUD/`createMovimentacao`; edição direta bloqueada (`services.ts:418–433, 1222–1290, 558–570`) | Módulo “Movimentações” (`modules.ts:122`); a grade também inicia ajuste e oferece estorno (`EstoqueGradePage.tsx`) | `auditoria.test.ts:66–116` cobre grade, saldo/estorno e permissão; não cobre bypass multiempresa nem replay de transferência. |
| Estorno | `POST /api/movimentacoes/:id/estornar` (`index.ts:743`; `estoque.ts:337–475`) | Ação na grade/histórico | Existe teste de saldo e perfil; sem A→B para o endpoint. O guard de estorno único é flag + transação; não há teste de corrida específico. |
| Inventário | `POST /api/inventarios` genérico abre snapshot; `GET/PUT /:id/itens`, `POST /:id/fechar` especializados (`services.ts:439–445, 482–484`; `estoque.ts:125–307`) | `InventarioModulePage.tsx` chama listagem, criação, detalhe, itens e fechamento (`:33–71, 245, 347–375`); navegação `modules.ts:125–131` | `auditoria.test.ts:125–165, 210–238` cobre snapshot, fechamento e saldo atual; `grades.test.ts:134–140` cobre dados de agrupamento. Sem teste de escopo, concorrência PostgreSQL de fechamento ou de produto de outra empresa. |
| Detalhe do produto | `/api/produtos/:id/detalhe` e `/:id/tamanhos` (`index.ts:473–476`; `detail.ts:19–52`) | `ProductDetail.tsx`; há atalho Produto → estoque (`docs/ERP-GAPS.md:394–397`) | Sem caso de teste de escopo destas rotas customizadas localizado. |
| Importação de saldo | `/api/importar/preview`, `/confirmar`, `/modelo` (`index.ts:745–750`; `importacao.ts:178–285`) | `ImportModal.tsx`, acionável na experiência de estoque | Não foi localizado teste dedicado do endpoint de importação. Preview não vincula a confirmação a um lote/prévia validada; erros na confirmação viram somente contador `pulados`. |
| Mínimos e reposição | `/api/relatorios/estoque-minimo`, `/api/suprimentos/sugestao-compra` e `/gerar` (`relatorios.ts:550–597`; `compras.ts:410–505`) | Grade, `SugestaoCompraPage.tsx`; item de navegação em `modules.ts:212` | Há `client/src/pages/SugestaoCompraPage.test.tsx` (linhas 116–212), cobrindo exibição/fórmula e criação explícita. Sem teste que prove que saída de transferência não vira consumo nem testes de escopo para relatórios. |
| PDV/expedição/devolução | `POST /api/pdv/vendas`; `/api/vendas/:id/expedicao/expedir`; `/api/devolucoes/:id/receber` | Páginas PDV, Expedição e Devoluções | `expedicao.test.ts:209–237, 313–500` cobre fluxos de venda/retorno; a fixture de retorno total não passa pelo faturamento real (`:305–310`). Não executado nesta auditoria. |
| Compras e custo | Recebimento parcial, entrada e estorno via `custoRecebimento.ts`; migrações 0027–0029 | Compra/recebimentos/NF-e e tela da compra | Testes funcionais/PG de custo e idempotência em `pg-custo-recebimento.test.ts:160–540`, condicionados a banco (`{ skip }`). Eles não resolvem custo de venda por ficha nem transferências. |
| WooCommerce | `/api/marketplace/loja/{status,produtos,pedidos,estoque}` (`index.ts:699–702`; `loja.ts`) | Sem item em `MODULES`; gap `GAP-COM-WOO-MENU` | Há `server/test/loja.test.ts` conforme `ERP-GAPS.md:326–330`; não foi encontrada prova A→B para esses endpoints. A importação por referência Woo é idempotente, mas seu mapeamento/escopo atual não é por empresa. |

**Cobertura geral relevante:** `multiempresa.test.ts` cobre criação/lista/leitura/edição e referências do CRUD genérico; `pg-multiempresa.test.ts` cobre triggers, isolamento SQL e leitura por ID no helper genérico; `pg-concorrencia.test.ts` cobre duas saídas concorrentes de produto acabado e CHECK; não cobre saldo sem tamanho; `auditoria.test.ts` cobre inventário no modo de teste. As suítes PG são declaradas com opção de `skip` e dependem de banco/configuração. Não foi encontrado arquivo de teste de `EstoqueGradePage` ou `InventarioModulePage`; isso não significa ausência total de testes frontend, pois a sugestão de compra tem suite própria.

## 6. Classificação dos gaps existentes em `docs/ERP-GAPS.md`

| Gap documentado | Classificação nesta auditoria | Observação/evidência atual |
|---|---|---|
| `GAP-ESTQ-VENDA-ID` | **Aberto; crítico** | Confirmado: `movimentacoes` não declara `venda_id`; faturamento/estorno continuam associados pelo texto `Venda #id` (`itens.ts:342–354, 387–411`; `ERP-GAPS.md:236–243`). |
| `GAP-ESTQ-ORDEM-ID` | **Resolvido no schema/código atual; evidência do documento está inconsistente** | Migração 0026 declara `movimentacoes.ordem_id` com FK e índice (`db/migrations/0026_producao_completa.sql:120–138`); produção usa `ordem_id` (`server/src/producao.ts:379–393`). O próprio gap está marcado resolvido em E2 (`ERP-GAPS.md:245–249`), mas a tabela de evidência na linha 61 ainda afirma que não existe. A execução de PostgreSQL não foi repetida aqui. |
| `GAP-ESTQ-TRANSFERENCIAS` | **Parcial; aberto** | Há transferência pela tela genérica de Movimentações e par de linhas transacional; faltam entidade, FK e ciclo de vida de grupo. A linha textual “não há item de menu” é ampla demais: há módulo “Movimentações” que declara transferências (`modules.ts:122`). |
| `GAP-ESTQ-RESERVA` | **Ausente; aberto** | Confirmado: `reserva_horas` está no cadastro de política, mas não há reserva/quantidade reservada em estoque; pedidos em aberto são só projeção em sugestão (`resources.ts:2025`; `compras.ts:434–441`). |
| `GAP-ESTQ-RASTREABILIDADE` | **Ausente, condicionado a decisão de produto** | Não há lote/validade/série no modelo de movimento/saldo (`ERP-GAPS.md:261–264`). Não tratar a ausência como bug confirmado até decidir se a operação exige lote. |
| `GAP-COM-WOO-MENU` + `GAP-E1-AUDIT-BLINDSPOT` | **Abertos e relevantes** | Endpoints existem, mas não há item de menu; auditoria automática descrita não cruza endpoints soltos. O presente achado adiciona risco de escopo e mapeamento entre empresas (`ERP-GAPS.md:326–330, 438–447`). |
| `GAP-ADMIN-IMPORTACAO` | **Aberto e relevante diretamente ao saldo inicial** | UI central/histórico/dry-run/rollback continuam incompletos segundo o documento; código também mostra confirmação direta e silenciosa por linha (`ERP-GAPS.md:370–373`; `importacao.ts:228–281`). O achado multiempresa deve ser tratado como prioridade anterior à expansão da tela. |
| `GAP-REL-CENTRAL` | **Parcial e inseguro no recorte multiempresa** | Relatórios básicos de posição, mínimo e movimentos existem (incluindo CSV/XLSX), mas a central pedida está incompleta e as consultas de estoque não recebem empresa (`ERP-GAPS.md:351–359`; `relatorios.ts:49–60, 140–151, 550–557`). |
| `GAP-ADMIN-EMPRESAS-MENU` | **Aberto; dependência operacional** | O documento afirma que criação de nova empresa ainda depende de SQL (`ERP-GAPS.md:365–368`). Não é defeito de saldo, mas impede administração multiempresa completa e segura sem operação técnica. |
| `GAP-UX-CADEIAS` | **Aberto; parcial** | Produto → estoque existe por detalhe; compra/recebimento e OP/consumo/estoque ainda não formam todas as trilhas clicáveis conforme documentação (`ERP-GAPS.md:394–397`). |
| `GAP-E2E-VENDA`, `GAP-E2E-COMPRA`, `GAP-E2E-PRODUCAO` | **Abertos; bloqueiam a homologação do conjunto** | Os critérios listados pedem fluxos ponta a ponta com PostgreSQL e isolamento; não foram executados nesta etapa (`ERP-GAPS.md:401–422`). A fixture de retorno não substitui o fluxo real de faturamento. |

### Inconsistências documentais a preservar até correção própria

Não editei `ERP-GAPS.md`. Há discrepâncias internas que devem continuar visíveis:

1. O resumo marca **5 gaps E4, 5 abertos** (`:34–50`), mas a seção E4 contém cinco entradas e `GAP-ESTQ-ORDEM-ID` está resolvido; restam **quatro abertos**, dos quais venda está marcado crítico (`:236–264`).
2. A evidência de banco em `:61` diz que `movimentacoes` não tem `ordem_id`, conflitando com a própria resolução E2 (`:245–249`) e com migration/schema atuais.
3. A seção E3 afirma 29 migrações (`:14–15`), enquanto a evidência de banco antiga fala em 25 (`:54–57`); o checkout atual contém 29 arquivos versionados. `server/src/db.ts:95–132, 152–190` confirma que o bootstrap aplica `schema.sql` e migrações versionadas em ordem lexicográfica.
4. A linha “sem item de menu” no gap de transferências não diferencia menu dedicado de uma ação de transferência dentro de “Movimentações”. O gap real é a entidade/ciclo de vida/link e operação agrupada.

## 7. Proposta conceitual de banco, APIs e frontend

**Nenhum DDL ou endpoint abaixo foi criado.** São opções para detalhamento de produto e implementação posterior.

### Banco e migrações

1. **Fundação de tenant/local.** Antes do backfill, produzir relatório de dados ambíguos. Tornar padrão/local únicos por empresa (`UNIQUE (empresa_id, nome)` e no máximo um padrão ativo por empresa); introduzir chave canônica de local e índices compostos. Preencher vínculos antigos por empresa + nome somente quando o mapeamento for inequívoco. Não reatribuir silenciosamente linhas ambíguas.
2. **FKs compostas de domínio.** Garantir que inventário, produto/tamanho e local relacionados pertençam à mesma empresa, usando chaves únicas compostas apropriadas e FKs compostas onde suportadas pelo modelo. Para relações que não podem ser comprovadas historicamente, deixar quarentena/backfill auditável em vez de inventar dono.
3. **Livro de movimentos.** Adicionar vínculo formal venda → movimento, movimento → inventário e entidade de transferência de estoque com empresa, origem, destino, estado e movimentos-filhos. Preservar o motivo textual como descrição, não como chave de busca. Não criar tabela chamada `transferencias` que possa confundir com `transferencias_financeiras`.
4. **Idempotência.** Persistir chave de idempotência por empresa e operação, com resposta/recurso criado recuperável; indexar unicamente `(empresa_id, operação, chave)` conforme contrato. Aplicar a PDV, transferência, importação e fechamento quando houver reenvio de cliente.
5. **Reserva e políticas.** Criar reserva por empresa, pedido/linha, produto, tamanho e local (se houver alocação), quantidade, estado e expiração; representar disponível como saldo menos reservas ativas. Definir índices/concorrência antes da API. Manter trilha de consumo, cancelamento e expiração.
6. **Custo e lotes.** Primeiro decidir método canônico (média ponderada, custo da ficha, custo por lote ou política combinada) e se lotes/validade são necessários. Depois versionar custo de entrada/saída e snapshot de CMV por item de venda; não fazer backfill histórico fictício. Se lote for necessário, ligar lote a recebimento de compra/produção e movimentos.
7. **Convenção do repositório.** O bootstrap lê `db/schema.sql` e depois `db/migrations/*.sql` dentro de transações (`server/src/db.ts:95–132, 152–190`). A implementação futura deve seguir o padrão local, atualizar o bootstrap e ter migration versionada idempotente; nomes `0030+` são apenas ilustrativos, não arquivos criados.

### APIs e frontend

- Derivar escopo do ator em toda rota customizada; validar tenant do registro por ID e tenant de cada referência antes de efeitos colaterais. Não usar `undefined` como escopo HTTP.
- Aplicar filtro empresarial a grade, detalhe de produto, inventário, relatórios e exportações. Fazer o `preview` e `confirmar` de importação operar no mesmo tenant; a confirmação deve usar prévia identificada/validada e devolver erro por linha, não contar erro opaco como sucesso parcial.
- Bloquear sincronização/importação Woo até haver política explícita de empresa e mapeamento SKU; se a integração continuar global, restringir a empresa configurada e documentar essa limitação.
- Tornar operações em grupo (transferência, devolução total, encerramento de inventário) visualmente uma operação com histórico e reversão coerentes. A UI não deve oferecer estorno de apenas uma perna de transferência.
- Decidir a fonte de mínimo/máximo: produto como default ou política por produto/tamanho/local, com apresentação consistente na grade, alerta, dashboard e sugestão.
- Acrescentar testes de componente para grade e inventário e testes de contrato das exportações, além dos testes de backend/PG abaixo.

## 8. Plano de fases E4.2–E4.6 e critérios de aceite

| Fase | Objetivo e dependências | Critérios mínimos de aceite |
|---|---|---|
| **E4.2 — Isolamento multiempresa e locais** | Corrigir primeiro a autorização por empresa em APIs customizadas, relatórios, importação, detalhe do produto, estoque e Woo; decidir locais privados ou compartilhados; canonicalizar local e default por empresa. Depende de inventário dos dados existentes e política operacional de tenant. | Testes de rota em PostgreSQL com A→B→A: A não lista grade/saldos de B, não lê/edita/fecha inventário de B, não estorna movimento de B, não importa em B e não exporta dados de B; IDs estrangeiros respondem 404 e referências estrangeiras são recusadas antes de qualquer escrita. Testar locais/defaults homônimos por empresa e verificar que criar/renomear local em A não altera saldos ou padrões de B. Testar `empresa_id` persistido no import. |
| **E4.3 — Livro formal, transferência e idempotência** | Criar vínculos venda/inventário/transferência; tratar transferência como grupo; adicionar chave idempotente em PDV e operações com retry; separar cancelamento financeiro da entrada física de devolução. Depende de E4.2. | Repetir a mesma chave de PDV/transferência devolve o mesmo resultado e altera saldo uma vez; nova chave cria operação distinta. Duas transferências concorrentes não excedem origem; estorno de transferência reverte as duas pernas atomicamente ou nenhuma. Testes de devolução: venda faturada real, devolução total boa, avariada, parcial em duas solicitações, repetição e reprocessamento; nunca dobrar saldo, nunca colocar avariado no vendável e reconciliar o financeiro cumulativo. Backfill de `venda_id`/links só nos casos inequívocos, com relatório de não resolvidos. |
| **E4.4 — Inventário, ajuste e invariantes de saldo** | Fechar lacunas de isolamento/relacionamento do inventário, ligar ajustes ao inventário, manter contagem contra saldo atual e definir política para negativos de insumos. Depende de E4.2 e dos vínculos de E4.3. | Inventário só contém produtos/tamanhos/locais da mesma empresa; contagem de produto novo, zero e grade inválida tem resultado explícito; movimentação durante contagem aparece e delta leva ao contado atual; duas tentativas concorrentes de fechar geram exatamente um conjunto de ajustes. Cada ajuste aponta para inventário/motivo/ator; retry não duplica. PostgreSQL recusa saldo acabado negativo e teste prova política escolhida para insumos (bloqueio por padrão e override explícito auditado, se mantido). Produtos sem tamanho têm uma única linha por produto/local; entradas repetidas somam no mesmo saldo e saídas concorrentes não criam duplicatas nem deixam saldo errado. |
| **E4.5 — Reservas e reposição por dimensão operacional** | Implementar saldo disponível, expiração e liberação/consumo em transições de pedido; escolher mínimo/máximo canônicos por produto/variação/local e refletir nos alertas/sugestão. Depende de E4.2–E4.4 e da política comercial. | Duas reservas concorrentes não consomem o mesmo disponível; confirmar venda consome uma reserva, cancelamento/expiração libera uma vez; saldo físico continua distinto de disponível. Testar relógio/expiração e repetição. Sugestão de compra discrimina tamanhos/locais conforme política, considera apenas demanda externa (transferência interna não conta como venda), pedidos em trânsito não duplicam saldo e geração continua explícita, não automática. |
| **E4.6 — Custo, rastreabilidade decidida, relatórios e homologação** | Aprovar fonte canônica de custo, snapshot histórico de CMV, decisão de lote/validade e consolidar relatórios/integradores com empresa e trilha; rodar homologação completa. Depende de decisão do dono do produto e das fases anteriores. | Recalcular/reimprimir relatório histórico não altera CMV passado; custo de compra, produção, devolução e estorno reconcilia em testes. Se lotes forem requisito, rastrear entrada → consumo/saída → devolução por lote/validade; se não, registrar decisão explícita e critério de revisão. Relatórios JSON/CSV/XLSX são equivalentes e isolados por empresa; Woo só publica o tenant/mapeamento configurado. Executar E2E venda, compra, produção e reversa em PostgreSQL real, concorrência, migration de banco vazio e upgrade de banco existente, typecheck, lint, build, smoke e testes de frontend/backend. |

### Portão recomendado antes de iniciar E4.2

1. Confirmar regra de ownership de locais e integração Woo por empresa.
2. Fazer inventário de anomalias/duplicidades em `local`, vínculos de inventário e movimentos cuja associação só está em `motivo`.
3. Resolver em separado o caso de devolução total com o teste montando venda pelo fluxo real.
4. Só então aprovar DDL/backfills; não corrigir registros históricos por heurística silenciosa.

## 9. Parecer final

**E4.1 pode ser encerrada como auditoria/documentação, não como aceite de segurança funcional da E4.** A prova de saldo de produto acabado é relativamente forte no PostgreSQL; isso não se estende automaticamente a inventário, insumos, importação, relatórios, locais ou integrações. Os bloqueios prioritários são isolamento por empresa, correção do recebimento de devoluções totais, vínculo/idempotência de movimentos e política única de local/custo. Até esses critérios terem testes executados em PostgreSQL e no nível de rota, não recomendar liberar novos fluxos de estoque multiempresa.
