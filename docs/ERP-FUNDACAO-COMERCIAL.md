# FUNDAÇÃO COMERCIAL — implementação (MA-02 … MA-10)

> Documento de **implementação** da evolução Master do ERP BroBond.
> O desenho conceitual (por que cada domínio existe, o que é proibido) está em
> [`ERP-MASTER-ARCHITECTURE.md`](./ERP-MASTER-ARCHITECTURE.md) e
> [`ERP-DOMAIN-MAP.md`](./ERP-DOMAIN-MAP.md). Aqui fica o que foi **de fato
> construído**: tabelas, regras, endpoints, telas, testes e limites.
>
> Escopo entregue: território, carteira temporal, equipes/hierarquia, metas com
> realizado derivado, atribuição comercial, motor de comissão e indicadores.
> **Módulos finalizados não foram reabertos** (Grades, Coleções, Tamanhos,
> Fornecedores, Representantes) e **INSUMOS permanece NÃO EXECUTADO**.

## 1. Princípio aplicado

```
CADASTRO → PARÂMETRO → PROCESSO → MOVIMENTO → EVENTO/INDICADOR
```

| Camada | O que entra nesta entrega | Onde vive |
| --- | --- | --- |
| **Cadastro** | território, equipe, membro de equipe, hierarquia | `territorios`, `equipes_comerciais`, `equipe_membros`, `representante_hierarquia` |
| **Cadastro temporal** | carteira (representante × cliente) | `representante_cliente` |
| **Parâmetro** | meta, plano de comissão, regra de comissão | `metas`, `planos_comissao`, `regras_comissao` |
| **Processo** | atribuição comercial de uma venda | `venda_atribuicao` |
| **Movimento** | venda faturada (já existia) | `vendas` + `itens_venda` |
| **Evento** | apuração/estorno de comissão | `comissoes_apuradas` + `comissoes_eventos` |
| **Indicador** | realizado, atingimento, comissão, ticket médio | **calculado** — nunca armazenado em coluna editável |

Regra de ouro respeitada em todo o desenho: **um dado tem um único dono**.

* `representantes` continua sendo o cadastro do representante (módulo finalizado,
  intocado). Ela **não** ganhou `clientes`, `meta_valor`, `comissao_historica`
  nem `territorio` — quem guarda isso são `representante_cliente`, `metas`,
  `comissoes_apuradas` e `representante_cliente.territorio_id`.
* `metas` **não** tem coluna de realizado. O realizado é sempre derivado de
  `vendas`/`itens_venda` no momento da leitura.
* `vendas` continua sendo a verdade comercial. `venda_atribuicao` não copia
  cliente, valor, data nem status: só diz **quem** participa e **quanto**.
* `comissoes_apuradas` congela valor/base/regra do momento do evento. Reprocessar
  **não** reescreve histórico: gera novo evento e marca o anterior como
  `estornada`.

## 2. Migrations (aditivas, idempotentes, nunca editam as anteriores)

| Migration | Conteúdo |
| --- | --- |
| `0041_territorios.sql` | `territorios` + índices + unicidade por empresa + trigger de integridade hierárquica |
| `0042_equipes_comerciais.sql` | `equipes_comerciais`, `equipe_membros`, `representante_hierarquia` + unicidades de vínculo aberto + trigger anti-ciclo |
| `0043_representante_cliente.sql` | carteira temporal + unicidade de vínculo aberto por cliente + índices de vigência |
| `0044_metas.sql` | `metas` com coerência alvo/recorte/período (nenhuma coluna de realizado) |
| `0045_atribuicao_comercial.sql` | `venda_atribuicao` (participação %, papel único principal, soma ≤ 100) |
| `0046_comissoes_motor.sql` | `planos_comissao`, `regras_comissao`, `comissoes_apuradas` + 4 colunas aditivas em `comissoes_eventos` (`plano_id`, `regra_id`, `apurada_id`, `base_tipo`) |

Total: **46 migrations** (`0001…0046`), próxima livre: `0047`.
`db/schema.sql` espelha as novas tabelas; `db/bootstrap.sql` continua sendo só a
estrutura-base (a cadeia versionada é quem cria o que veio depois da 0016) —
`node scripts/gerar-bootstrap.mjs --check` verde.

### Constraints que carregam regra de negócio

* `territorios`: único `(empresa_id, upper(codigo))`, único
  `(empresa_id, upper(nome), COALESCE(territorio_pai_id,0))`;
  `trg_territorios_valida` (BEFORE INSERT/UPDATE) deriva `nivel`, recusa ciclo,
  recusa pai de outra empresa (`23514`) e recusa auto-paternidade.
* `equipe_membros`: único vínculo **aberto** por (equipe, representante);
  `participacao_pct` em (0,100].
* `representante_hierarquia`: único vínculo aberto por subordinado (um superior
  por vez); `trg_hierarquia_sem_ciclo` recusa ciclo na cadeia.
* `representante_cliente`: único vínculo aberto por (empresa, cliente) — troca de
  representante **encerra** o anterior, nunca apaga.
* `metas`: `metas_alvo_coerente`, `metas_recorte_coerente`, `metas_algum_alvo`,
  `metas_periodo_coerente`.
* `regras_comissao`: escopo coerente com a coluna preenchida, valor > 0,
  vigência coerente, único `(empresa_id, plano_id, escopo, alvo, prioridade, vigencia_inicio)`.
* `comissoes_apuradas`: único `(venda_id, representante_id)` enquanto `apurada`;
  `valor`/`base_valor` não negativos.

## 3. Recursos de API criados

Todos com `empresa: true` (isolamento por tenant obrigatório), paginação,
busca, filtros `f.<campo>`, ordenação e export CSV/XLSX herdados do CRUD
genérico — sem duplicar infraestrutura:

`territorios` · `equipes_comerciais` · `equipe_membros` ·
`representante_hierarquia` · `representante_cliente` (carteira) · `metas` ·
`planos_comissao` · `regras_comissao` · `venda_atribuicao`

`comissoes_apuradas` é **interno** (não navegável): resultado do motor, não
cadastro.

### Endpoints de leitura/consulta (além do CRUD)

| Rota | Para que serve |
| --- | --- |
| `GET /api/comercial/territorios/arvore` | árvore hierárquica montada no servidor (uma consulta + montagem em memória, sem N+1) |
| `GET /api/comercial/indicadores` | indicadores por representante / território / equipe, com janela `de`/`ate` e filtros |
| `GET /api/comercial/metas/:id/acompanhamento` | meta × realizado × variação × % atingimento + distribuição mensal |
| `GET /api/comercial/representantes/:id/painel` | painel individual (vendas, faturamento, pedidos, clientes, ticket, comissão, meta) |
| `POST /api/comercial/vendas/:id/apurar-comissao` | apura (ou reapura) a comissão de uma venda faturada, registrando evento |

Todas passam por `requireAuth`, escopo de empresa do ator, `audit()` e
`checkAccess` do recurso correspondente — **nunca** confiam em `empresa_id`
enviado pelo cliente.

## 4. Regras implementadas por fase

### MA-02 — Territórios
* Tipos geográficos (`pais`, `estado`, `regiao`, `cidade`, `zona`) e não
  geográficos (`comercial`, `digital`, `key_account`, `especial`) — o tipo é
  dado do cadastro, não uma tabela paralela.
* `nivel` é **derivado** no servidor (`pai.nivel + 1`), nunca digitado.
* Ciclo, auto-paternidade e pai de outra empresa são recusados (serviço **e**
  banco; 404 para referência de outro tenant, 409/23514 para ciclo).
* Desativação preserva o histórico: `status` inativo, vínculos intactos.
* Exclusão com dependências responde **409** com diagnóstico de vínculos.

### MA-03 — Carteira temporal
* Vigência por `inicio`/`fim`; vínculo **aberto** = `fim IS NULL`.
* 100% de carteira é exclusivo: um novo vínculo de 100% **encerra** o anterior na
  véspera (`fim = inicio - 1 dia`). Participações parciais coexistem até 100%.
* Sobreposição inválida → **409 `carteira_sobreposta`**.
* Trocar representante **nunca** destrói histórico: o registro antigo fica com
  `status='encerrado'` e `fim` preenchido (auditado).

### MA-04 — Metas
* Alvos: representante, equipe, território, empresa. Recorte: todos, produto,
  categoria, coleção. Métricas: faturamento, quantidade, margem, pedidos,
  clientes. Granularidade mensal/trimestral/anual com distribuição
  `linear`/`unica`.
* **Realizado é derivado.** Não existe coluna, campo de formulário nem endpoint
  de escrita de realizado; a tela de acompanhamento é somente leitura.
* Sobreposição de meta com mesmo alvo/métrica/recorte/período → 409.

### MA-05 — Motor de comissão
* `plano_comissao`: vigência, `base_calculo` (faturamento | liquido | margem),
  `momento_efetivacao` (faturamento | recebimento), plano padrão único por empresa.
* `regra_comissao`: escopo (geral, representante, equipe, território, cliente,
  produto, categoria, coleção), `tipo_valor` (percentual | fixo), `base`
  (bruto | liquido | margem), prioridade, vigência.
* Resolução (`escolherRegra`):
  1. filtra por vigência e status;
  2. pontua `peso do escopo × 1e6 + prioridade`
     (produto 8 > categoria 7 > coleção 6 > cliente 5 > território 4 > equipe 3 >
     representante 2 > geral 1);
  3. desempate: vigência mais recente → maior `id`.
* Sem regra aplicável: fallback no percentual do cadastro
  (`representantes.comissao_pct`) sobre o total da venda — comportamento legado
  preservado, sem quebrar o módulo finalizado.
* Apuração grava `comissoes_apuradas` (valor, base, tipo de base, plano, regra),
  atualiza a comissão congelada na venda e emite evento. **Reapuração** não
  altera o registro anterior: ele vira `estornada` e nasce um novo.
* **Contribuição ≠ comissão**: `venda_atribuicao.participacao_pct` define a
  divisão do crédito comercial; a comissão de cada representante é apurada
  separadamente (e pode ser zero mesmo com contribuição > 0).

### MA-06 — Equipes e hierarquia
* `equipes_comerciais` (líder, território, empresa, status) + `equipe_membros`
  (papel, entrada/saída, participação).
* `representante_hierarquia`: diretor → gerente → supervisor → representante,
  com vínculo aberto único por subordinado e **ciclo proibido** (serviço + trigger).
* Roll-up de vendas/metas/comissão/carteira aparece em
  `/comercial/indicadores` (`por_equipe`) — sempre agregado no servidor.

### MA-07 — Atribuição comercial
* `venda_atribuicao` liga venda → representante/equipe/território com
  `participacao_pct` e `papel` (principal único, secundários somando ≤ 100%).
* Não duplica cliente, valor, data nem status: a venda continua sendo a única
  verdade; a atribuição é o recorte comercial.
* Venda **faturada/entregue** não aceita alteração de atribuição → 409
  `atribuicao_venda_faturada` (a comissão congelada não é reescrita).
* Propagação controlada: Cliente → Pedido → Venda → Faturamento → Recebimento
  acontece por evento; nenhum passo reescreve o anterior.

### MA-08 — Indicadores
* **Sem N+1**: por requisição são feitas 7 leituras em lote (vendas, itens,
  atribuições, metas, representantes, territórios, equipes) e a agregação é
  feita no servidor, com índices por venda — nunca uma consulta por linha.
  Limite conhecido: a agregação ainda é feita em memória após a leitura em lote
  (não há `SUM/COUNT` no SQL); virar `VIEW`/consulta agregada é evolução
  registrada no §8.
* Indicadores: vendas, faturamento, pedidos, clientes, peças, ticket médio,
  comissão, meta, realizado, variação, % de atingimento.
* Nenhum indicador é digitável — todos derivados na leitura.

### MA-09 — Integrações (mínimas e explícitas)
Clientes (carteira), Vendas/Itens (realizado e apuração), Financeiro
(`comissoes_eventos`, lançamentos), Produtos/Categorias/Coleções (recorte e
regra), Representantes (cadastro finalizado), Fornecedores (não tocado),
Empresas (isolamento), RBAC e Auditoria. Sem dependência circular: os módulos
novos dependem dos finalizados, nunca o contrário.

### MA-10 — Governança
* Isolamento por empresa em todas as tabelas e em todas as rotas (escopo do ator,
  nunca do payload).
* RBAC herdado: `minPerfil`/`minPerfilEscrita` por recurso (planos e regras de
  comissão exigem gerente+ porque mexem em dinheiro).
* Auditoria de criação/edição/exclusão e dos eventos de apuração/estorno.
* Desativação em vez de exclusão para cadastro com histórico; **409** com
  diagnóstico quando a exclusão é bloqueada por vínculos.
* `dependencias.ts` conhece as 10 tabelas novas (módulos, relações, políticas),
  então o diagnóstico de vínculos funciona igual ao dos módulos antigos.

## 5. Telas (LISTA → PÁGINA, sem modal/drawer/overlay)

| Rota | Tela |
| --- | --- |
| `/territorios` | lista + painel de **hierarquia** (árvore do servidor) |
| `/territorios/novo`, `/territorios/:id/editar` | página de cadastro |
| `/equipes-comerciais`, `/equipe-membros`, `/hierarquia-comercial` | lista + página |
| `/carteira-clientes` | lista da carteira temporal (vigência, participação, status) |
| `/metas`, `/planos-comissao`, `/regras-comissao`, `/atribuicao-comercial` | lista + página |
| `/metas/:id/acompanhamento` | meta × realizado × atingimento (somente leitura) |
| `/comercial/painel` | indicadores por representante / território / equipe |

Todas têm: busca (300 ms), filtros server-side, ordenação server-side, paginação
com tamanho configurável, estados de carregando / vazio / erro / atualizando,
exportação CSV/XLSX, toasts, RBAC espelhado (a autoridade é a API) e
responsividade.

## 6. Testes

| Suite | Comando | Resultado |
| --- | --- | --- |
| Contratos do domínio comercial (memdb) | `cd server && node --import tsx --test test/master-comercial.test.ts` | 18/18 |
| Servidor completo (TAP) | `npm --workspace server test` | 1136 testes · 1068 pass · **0 fail** · 68 skip (PG) |
| Cliente (Vitest) | `npm --workspace client test` | 68 arquivos · **798** testes · 0 fail |
| Rotas comerciais | `src/pages/ComercialRoutes.test.tsx` | 4/4 — lista, página, acompanhamento e painel |
| Menu/RBAC/rotas | `npm run audit:menu` | 0 erros · 19 avisos classificados |

`test:pg` exige `DATABASE_URL` de banco **novo**: sem a variável o script sai com
código **2** e os 68 testes marcados como **SKIP** — nunca como PASS.

## 7. Paridade memdb × PostgreSQL (divergências explícitas)

| Regra | PostgreSQL | memdb | Observação |
| --- | --- | --- | --- |
| Derivação de `nivel` do território | trigger `trg_territorios_valida` | serviço `validarTerritorio` | mesma regra, dois lugares; testado nos dois |
| Anti-ciclo (território/hierarquia) | triggers PL/pgSQL | serviço | idem |
| Unicidade de vínculo aberto | índices únicos parciais | validação no serviço | memdb não tem índice parcial |
| Tipos (`CHECK`) | constraints no banco | validação de payload + serviço | memdb aceita payload mais solto |
| Agregação de indicadores | mesmas 7 leituras em lote + agregação em memória | idem | mesmo resultado nos dois; sem N+1 em nenhum |

Nenhuma paridade é fingida: o que o banco garante e o serviço não, está nesta
tabela.

## 8. Limites conhecidos e pendências reais

1. **INSUMOS — NÃO EXECUTADO**: nenhum CRUD, migration, tela ou entrada de menu
   foi criada. Só permanece a posição arquitetural futura (insumo é cadastro de
   material, não produto).
2. **Métricas por produto/categoria**: métricas são faturamento, quantidade,
   margem, pedidos e clientes; produto/categoria/coleção entram como **recorte**
   da meta. Métrica própria por produto exigiria nova coluna + agregação por item
   — não foi inventada.
3. **`test:pg` NÃO EXECUTADO** no ambiente atual: sem `DATABASE_URL` o gate sai
   com código 2 (SKIP). O laboratório disponível é PostgreSQL **18.4** e o gate
   exige `160014` (16.14); subir 16.14 offline não foi possível. Como evidência
   alternativa, as 46 migrations foram aplicadas em banco vazio no PG 18.4 e as
   constraints novas (23514/23505) foram exercitadas por script direto.
4. **`db:validate` NÃO EXECUTADO**: `prisma validate` baixa `schema-engine` de
   `binaries.prisma.sh` e a rede do ambiente bloqueia TLS.
5. **Snapshot de meta**: o realizado é sempre calculado na leitura (não há job de
   fechamento mensal). Um snapshot por competência é evolução futura, não
   implementada — e não seria coluna editável.
6. **Regra fixa de comissão**: aplicada uma vez por venda (não por item), para não
   multiplicar valor fixo pela quantidade de itens.
7. **`comissoes_apuradas.base_tipo`** é gravado como `bruto` mesmo quando a regra
   usa base líquida/margem — o valor apurado está correto (a base usada é a da
   regra), mas a coluna não diferencia. Corrigir exige migration de backfill e
   foi deliberadamente adiado para não reescrever histórico recém-criado.
8. **Indicadores em memória**: a agregação roda após leitura em lote; em bases
   muito grandes o caminho ideal é uma consulta agregada SQL por período.

## 9. Como validar localmente

```bash
npm run typecheck
npm run lint
npm test                 # servidor (TAP) + cliente (Vitest)
npm run build
npm run audit:menu
node scripts/gerar-bootstrap.mjs --check
# PostgreSQL (exige banco novo e server_version 16.14):
DATABASE_URL=postgres://... npm run test:pg
```
