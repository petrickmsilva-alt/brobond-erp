# Brobond ERP/Commerce — Diagnóstico de latência, correções e plano de escala

> **Missão:** reduzir a latência percebida (relato do Diretor: 8–10 s em operações
> frequentes), preparar a aplicação para milhares de pedidos e decidir, com
> evidência, entre Render e VPS.
>
> **Data:** 12/11/2026 · **Base:** `main@1d23a60` · **Branch de trabalho:**
> `arena/7b9cb396-brobond-erp`
>
> **Escopo respeitado:** nenhuma troca de provedor, nenhuma alteração de
> produção, nenhum índice criado sem justificativa, nenhum teste removido,
> nenhuma regra de integridade enfraquecida.

---

## 0. Leia isto primeiro: o que foi medido e o que não foi

Ser honesto sobre a evidência é parte do trabalho — um relatório de performance
com números inventados é pior que nenhum relatório.

| O que | Situação |
|---|---|
| Análise de código, do plano de execução implícito e da configuração de deploy | **Feito**, com referência a arquivo e linha |
| Instrumentação de P50/P95/P99, banco, pool, CPU, memória, event loop, frontend | **Implementada e medida** (execução local desta sessão) |
| Ganho de compressão HTTP | **Medido**: `/api/meta` 277,9 KB → 49,6 KB (**−82%**) |
| Redução de round-trips por listagem | **Medido por contagem de consultas** em teste de regressão |
| Latência atual da produção (`brobond-erp.onrender.com`) | **NÃO medido nesta sessão** — o sandbox onde este trabalho foi feito tem saída de rede restrita a GitHub/npm/PyPI e **não alcança o domínio da aplicação** |
| Teste de carga em produção | **Não executado** — proibido pelo escopo (não gerar carga/dados no banco de produção sem autorização) |
| `EXPLAIN ANALYZE` em banco real | **Ferramenta entregue** (`npm run perf:explain`); execução exige um banco de teste/branch do Neon |

Ou seja: **as correções estão implementadas e testadas; os números de produção
são produzidos em ~15 minutos** rodando os dois comandos da seção 7 contra a
instância real (leitura apenas, nenhum dado criado). O relatório abaixo
identifica as causas com evidência de código e quantifica o que já é
quantificável.

---

## 1. Diagnóstico: onde o tempo realmente vai

A conclusão central, e ela contraria a intuição de "trocar de hospedagem":

> **A maior parte dos 8–10 s não é o PostgreSQL.** É (a) **payload sem
> compressão em rede brasileira**, (b) **round-trips em série** por tela e
> (c) **processo frio / com fração de vCPU**. O banco contribui, mas
> principalmente por *latência de rede por consulta* — não por consulta lenta.

### 1.1 O elo que ninguém vê: quantas vezes o navegador fala com o servidor

Cada requisição, numa conexão nova, custa **TCP + TLS + requisição + resposta**.
Saindo de Goiás para um datacenter nos EUA, isso é tipicamente **120–200 ms de
RTT**. Dois efeitos se multiplicam:

1. **Requisições em série** — a tela espera uma após a outra.
2. **Payload sem compressão** — o tempo de transferência entra inteiro no
   caminho crítico.

O `/api/meta` (metadados de todos os módulos) respondia **277,9 KB de JSON sem
compressão**. Medição desta sessão, no mesmo processo:

```
JSON  277,9 KB → gzip  49,6 KB  (−82%)
```

Numa conexão de 1,5 Mbps (~187 KB/s), 278 KB levam **~1,5 s**; 50 KB levam
**~0,27 s**. Isso é **um** endpoint, e ele é chamado no login/carregamento
inicial. Não existe configuração de plano de hospedagem que resolva isso — só
compressão. **Corrigido** (`server/src/index.ts`, middleware `compression`).

### 1.2 Round-trips em série no servidor

`listRecords` (`server/src/services.ts`) executava as anotações de listagem em
**série**. Para `locais`, `anotarUsoLocal` fazia, **por linha** da página:

```
4 × countWhere (estoques, movimentacoes origem, movimentacoes destino, inventarios)
+ 1 × list (contagem de ativos)
```

Numa página de 10 locais: **50 consultas**. Com RTT API↔Neon de 20 ms, são
**~1 s só de ida e volta**, independentemente de qualquer índice.

| Fluxo | Consultas antes | Depois |
|---|---|---|
| `/api/locais` (10 linhas) | 2 (página) + 50 = **52** | 1 (count+página em paralelo) + 4 + 1 = **6** |
| `/api/locais` (25 linhas) | 2 + 125 = **127** | **6** |
| Listagem genérica | 2 em série (count, depois página) | **1** (paralelo) |
| Telas com anotações múltiplas (grades/insumos) | soma de 5–7 awaits | **maior delas** |

**Corrigido**: `anotarUsoLocal` virou agregação por página (`GROUP BY`, 4
consultas constantes) e as anotações independentes rodam em paralelo
(`Promise.all`), preservando a única dependência real de ordem
(`anotarGrades` lê `uso_vinculado`). Há teste de regressão que **falha se o
N+1 voltar** — ele conta as agregações e exige custo constante.

### 1.3 Busca por SKU/nome: varredura sequencial garantida

`searchClause` (`server/src/pgstore.ts:287`) monta:

```sql
t.nome::text ILIKE '%termo%' OR t.sku::text ILIKE '%termo%' OR t.codigo_barras::text ILIKE '%termo%' OR ...
```

Curinga à esquerda (`%termo%`) **não é atendido por índice B-tree**. Sem
`pg_trgm`, o plano é **Seq Scan em `produtos`** com todos os campos
pesquisáveis avaliados linha a linha. A busca de SKU é a operação mais
frequente do PDV e do estoque — ela degrada linearmente com o catálogo.

**Corrigido**: migração `0121` cria `pg_trgm` e **5** índices GIN (não "um por
campo"): `produtos.nome`, `produtos.sku`, `produtos.codigo_barras`,
`clientes.nome`, `fornecedores.nome`. Deliberadamente **não** indexamos marca,
tags, material, modelagem, gênero e códigos de origem — cada índice GIN custa
escrita, WAL e espaço em todo INSERT/UPDATE do catálogo, para filtros
ocasionais.

### 1.4 O elo que domina o relato "8–10 s": processo frio e CPU escassa

`render.yaml` declara **`plan: free`**. No plano gratuito da Render a instância
é **suspensa após ~15 min sem tráfego** e a próxima requisição paga o boot
completo. Somando o que o processo faz hoje no boot:

| Etapa do boot | Custo |
|---|---|
| `tsx` transpilando ~75 mil linhas de TypeScript sob demanda (`startCommand: npm --workspace server start` → `tsx src/index.ts`) | segundos, e **memória** extra (esbuild em processo) |
| `db/bootstrap.sql` — **335 comandos DDL** executados **a cada boot** | execução no banco + locks de catálogo |
| Conexão ao Neon + cadeia de migrações versionadas | depende do compute acordando |
| `ensureAdmin` + hash de senhas legadas + endereço público + limpeza | 4 idas ao banco **em série** |
| Login (`Argon2id`) | **110 ms de CPU pura** medidos nesta sessão; no `free` (fração de vCPU) multiplica |

E havia um **amplificador de dor** no cliente:
`client/src/lib/apiFetch` repete leituras em 5xx com backoff **1 s + 2 s**
(`api.retry.test.ts` documenta isso). Enquanto o processo subia, o gate
`bloqueioDeProntidao` respondia **503** — então o usuário pagava *boot + 1 s +
2 s* e, se o boot passasse da segunda tentativa, via **erro**.

**Corrigido (sem depender de plano pago):**

- `BOOT_HOLD_MS` (padrão 20 s): durante o boot a requisição **espera a
  prontidão** e segue, em vez de 503 + backoff. Banco **degradado** continua
  503 imediato (ali esperar esconderia incidente).
- Boot com as tarefas independentes **em paralelo**.
- `keepAlive` nas conexões do pool (evita re-TLS a cada consulta ociosa) e
  `application_name` para diagnóstico em `pg_stat_activity`.
- `/api/health/db`: sonda de **latência pura API↔Neon** e endpoint de
  keep-alive para impedir a suspensão do compute do Neon.

**Não corrigido por decisão:** o `plan` continua `free` no arquivo. Subir de
plano é **custo**, exige autorização; está documentado em `render.yaml` com o
efeito exato de cada opção.

### 1.5 Duplicidade de requisições no frontend

Duas telas que montam juntas pediam o **mesmo** recurso no mesmo instante — dois
round-trips para o mesmo dado. Também havia N+1 explícito de HTTP em
`FiscalExecucoesPage.tsx:29` (uma requisição por execução da lista).

**Corrigido**: coalescing de leituras idênticas **concorrentes** em `apiFetch`
(só GET/HEAD, só sem `body`/`signal`, **nunca escrita**), com **cópia** do
resultado para cada chamador (sem aliasing acidental) e sem cache entre
requisições — erro nunca fica cacheado. Coberto por 8 testes.

---

## 2. Instrumentação entregue (item 1 do briefing)

Tudo em processo, **sem APM pago** e sem dependência nova de observabilidade.

| Requisito | Como foi atendido |
|---|---|
| Identificação de requisição | `X-Request-ID` / `X-Correlation-ID` (já existia; preservado e agora **propagado** para as fases) |
| Tempo total HTTP | P50/P95/P99/máx por rota em `/api/admin/metrics` |
| Tempo de processamento da API | fase `app` no cabeçalho `Server-Timing` |
| Tempo de cada consulta PostgreSQL | gancho único no pool (`instrumentarPool`): **toda** consulta do processo, inclusive dentro de transação, com impressão digital (verbo + tabelas) |
| Tempo de espera por conexão | medido em `pool.connect` (fila do `pg`), com pico de `waitingCount` |
| Transações e locks | `application_name` + tempo por consulta; `EXPLAIN (ANALYZE, BUFFERS)` em `npm run perf:explain` |
| Chamadas a serviços externos | `fetch` global instrumentado por **host** (nunca URL com token), mais fase `externo` |
| Processamento frontend / carregamento de telas | RUM próprio: tempo até o 1º paint por rota normalizada, TTFB, bytes e nº de chamadas |
| CPU e memória | `rss`, `heap`, CPU % (5 s), lag do event loop (p50/p95/p99/máx) |

**Privacidade (requisito explícito):** nada de token, senha, e-mail, documento
ou valor financeiro. As consultas aparecem como **impressão digital** com
literais removidos (`impressaoSql`), a rota é o **padrão declarado** e o
recurso só entra se for um slug validado. Há testes que **tentam vazar** CPF,
e-mail e hash e exigem que nada apareça.

Endpoints: `GET /api/admin/metrics` (JSON, admin), `GET /api/admin/metrics.prom`
(Prometheus, admin), `POST /api/metrics/frontend` (RUM, autenticado),
`GET /api/health/db` (sonda pública de latência de banco).

---

## 3. Correções realizadas

| # | Correção | Arquivo | Por quê |
|---|---|---|---|
| PERF‑01 | Métricas de P50/P95/P99 por rota, banco, pool, CPU, memória, event loop | `server/src/metrics.ts` (novo), `observability.ts`, `db.ts`, `index.ts` | Sem medir, otimizar é opinião |
| PERF‑02 | Compressão HTTP (gzip/brotli conforme `Accept-Encoding`) | `server/src/index.ts` | **−82%** de payload medido |
| PERF‑03 | Fim do N+1 em `anotarUsoLocal` (4 agregações por página) | `server/src/services.ts` | 50 → 4 consultas numa página de 10 |
| PERF‑04 | Anotações independentes em paralelo | `server/src/services.ts` | soma de round-trips → maior delas |
| PERF‑05 | `COUNT` + página em **uma** ida ao banco | `server/src/pgstore.ts` | 2 RTT → 1 em toda listagem |
| PERF‑06 | Espera de prontidão no boot em vez de 503 | `server/src/index.ts` | elimina 1 s + 2 s de backoff no cold start |
| PERF‑07 | Boot com tarefas independentes em paralelo | `server/src/index.ts` | menos tempo até a primeira resposta útil |
| PERF‑08 | Coalescing de leituras idênticas concorrentes | `client/src/lib/api.ts` | requisição duplicada deixa de custar RTT |
| PERF‑09 | RUM de tela (paint, TTFB, bytes, chamadas) | `client/src/lib/perf.ts` (novo), `App.tsx` | "tela lenta" deixa de ser adjetivo |
| PERF‑10 | Sonda `/api/health/db` + keep-alive documentado | `server/src/index.ts`, `render.yaml` | mede API↔Neon e evita suspensão do Neon |
| IDX‑01 | `pg_trgm` + 5 índices GIN justificados | `db/migrations/0121_*.sql` | busca com curinga à esquerda |
| PERF‑11 | `keepAlive`, `application_name`, `PG_POOL_MAX` explícito | `server/src/db.ts` | conexão ociosa derrubada não vira re-TLS no meio da requisição |
| PERF‑12 | Log detalhado opcional em dev (`LOG_DETALHADO=1`) | `server/src/log.ts` | fases visíveis no diagnóstico sem poluir o padrão |

Nada disso altera contrato de API, RBAC, multiempresa, auditoria ou cálculo
financeiro. As suítes existentes seguem verdes (**1125 testes de cliente +
suíte de servidor**, mais os novos abaixo).

### Índices: procedimento seguro para produção

A migração roda dentro de transação, e `CREATE INDEX CONCURRENTLY` **não** roda
em transação. Para tabelas já grandes existe o caminho sem bloqueio:

```bash
# 1) backup/recuperação verificados (branch do Neon ou pg_dump)
# 2) dry-run: mostra exatamente o que faria
PERF_DB_URL='postgres://...' npm run perf:indices
# 3) aplica com CONCURRENTLY e valida (indisvalid)
PERF_DB_URL='postgres://...' npm run perf:indices -- --apply
```

Se `pg_trgm` não existir for disponível, **nada quebra**: a migração emite
`NOTICE` e a busca continua correta (apenas sem aceleração).

---

## 4. Metas de performance

Acordadas no briefing, com o critério de aceite:

| Operação | Meta P95 | Como verificar |
|---|---|---|
| Consultas simples | ≤ 500 ms | `GET /api/admin/metrics` → rota |
| Listagens paginadas | ≤ 800 ms | idem |
| Cadastro e edição | ≤ 1 s | `POST/PUT /api/:resource` |
| Operações transacionais | ≤ 1,5 s | checkout/venda/estoque |

**Regra de honestidade:** estas metas **não podem ser declaradas cumpridas nesta
sessão** — a instância de produção não foi alcançável daqui. O que existe é o
instrumento que mede e reporta cada uma delas, com o mesmo corte P50/P95/P99.

Medições **feitas** nesta sessão (modo demonstração, mesma máquina, **sem banco
PostgreSQL** — portanto medem HTTP/CPU/fila e **não** representam a latência de
produção; servem para provar que a instrumentação funciona e para isolar CPU):

| Rota | n | P50 | P95 | P99 |
|---|---|---|---|---|
| `GET /api/produtos` | 40 | 1,17 ms | 1,61 ms | 9,14 ms |
| `GET /api/produtos/busca` | 40 | 0,97 ms | 2,60 ms | 3,19 ms |
| `GET /api/dashboard` | 40 | 1,58 ms | 3,48 ms | 4,19 ms |
| `POST /api/auth/login` (Argon2id) | 1 | **110,64 ms** | — | — |
| `GET /api/meta` | 2 | 10,68 ms | 28,14 ms | — |

Duas leituras importantes:

- **Login custa ~110 ms de CPU pura** num núcleo normal. É o piso inegociável do
  Argon2id. Num plano com fração de vCPU (Render `free`), esse piso sobe
  proporcionalmente — e o login é a primeira coisa que todo usuário faz.
- As rotas de listagem em modo memória mostram que o HTTP/roteamento **não** é o
  gargalo: o tempo de produção virá de banco + rede + payload.

---

## 5. Capacidade e escalabilidade

**O que a aplicação já tem** (verificado no código, não presumido):
monólito modular com CRUD genérico, coordenação distribuída de cron por lease com
*fencing token* (`cronLock.ts`), outbox idempotente com claim CAS e backoff
(`commerce/outbox.ts`), recorte de tenant em toda consulta, RBAC no servidor,
auditoria encadeada por hash.

**O que faltava para múltiplas instâncias** — e agora está tratado ou mapeado:

| Item | Situação |
|---|---|
| Estado em processo (sessões, cache, filas) | Sessões e rate limit são **persistidos**; coordenação de cron é **distribuída por lease**. A instância é essencialmente stateless |
| Conexões de banco por instância | `PG_POOL_MAX` explícito + regra documentada: `instâncias × PG_POOL_MAX ≤ limite do pooler` |
| Duplicidade de processamento | Outbox com chave única `(empresa, tipo, chave)` e claim CAS; cron com fencing |
| Isolamento por tenant | `empresa_id` obrigatório no SQL, não filtrado em JS |
| Bônus por instância | WebSocket (`socket.io`) exige *sticky sessions* ou um adapter (Redis) — **pré-requisito** antes de escalar horizontalmente com tempo real |

**Operação que deve sair do ciclo síncrono** (item 4 do briefing) — o
diagnóstico está feito; a fila **existente** é o caminho (não criar sistema
paralelo):

| Operação | Hoje | Caminho correto |
|---|---|---|
| Importação de planilha (`importacao.ts`, `financeiroImportacao.ts`) | síncrona na requisição | job no outbox + endpoint de status; idempotência por hash do arquivo |
| Relatórios pesados (`relatorios.ts`) | síncronos | já existe processo de cron `relatorios`: enfileirar e devolver `job_id` |
| Sincronização WooCommerce / publicação de canal | outbox (parcial) | já usa outbox — falta o **worker dedicado** consumindo com concorrência limitada |
| Campanhas / notificações | parcialmente assíncrono | outbox `sincronizacao` + `acao='notificacao'` |
| **Baixa de estoque e transação financeira** | **síncrona e transacional** | **MANTER síncrono.** Só o *efeito colateral externo* (publicar no canal, e-mail) pode ser assíncrono. Consistência de saldo não se negocia |

> Regra registrada: **nunca** processar baixa de estoque ou lançamento
> financeiro de forma assíncrona sem garantia transacional. O padrão é
> *transação local grava o fato + outbox grava o evento na mesma transação*;
> o mundo externo converge depois.

---

## 6. Render × HostGator VPS

### 6.1 Como a comparação é feita sem enganar ninguém

A comparação só vale se as duas pontas rodarem **a mesma aplicação, o mesmo
banco, a mesma configuração**:

- mesma imagem/commit (`deploy/vps/Dockerfile` compila do mesmo repositório e
  usa o **mesmo** `tsx` de start da Render — trocar o runtime de um lado mediria
  outra aplicação);
- **mesmo Neon** (`deploy/vps/.env.example`): a latência API↔banco precisa ser
  idêntica, senão mede-se geografia, não hospedagem;
- mesmo `PG_POOL_MAX`, mesmo `BOOT_HOLD_MS`;
- mesmo protocolo (`scripts/perf/benchmark-render-vs-vps.mjs`), mesma janela.

```bash
PERF_EMAIL=... PERF_SENHA=... PERF_TOTP_SECRET=... \
  npm run perf:benchmark -- \
    --render https://brobond-erp.onrender.com \
    --vps http://IP_DA_VPS:8080 \
    --estagios 1,5,10,25 --duracao 30 \
    --custo-render 0 --custo-vps 149 \
    --markdown docs/PERFORMANCE/benchmark-execucao.md
```

O script mede cold start, P50/P95/P99 por rota, RPS, erros e — o que a maioria
dos benchmarks esquece — **a evidência do lado do servidor** (CPU, memória,
pool, event loop), lendo `/api/admin/metrics` antes e depois de cada estágio.
As rotas de escrita só entram se o arquivo de cenário declarar `metodo: POST`.

### 6.2 Custo total de propriedade (TCO), não mensalidade

Comparar mensalidade é o erro clássico. O que o Diretor precisa decidir:

| Item | Render (PaaS) | VPS (HostGator) |
|---|---|---|
| Mensalidade do serviço | Starter/Standard (verificar preço vigente) | VPS + IP |
| Banco | Neon (mantido nos dois) | Neon (mantido nos dois) |
| TLS (HTTPS) | **incluso e renovado sozinho** | Certbot + renovação + monitorar expiração |
| Deploy / rollback | push → deploy, rollback em 1 clique | pipeline próprio ou manual |
| Sistema operacional, patches de segurança | **incluso** | **responsabilidade da Brobond** |
| Backup do volume/imagem | incluso no plano | script + storage + **teste de restauração** |
| Monitoramento / alerta de queda | incluso (health check) | instalar e manter |
| Escala vertical | trocar plano | redimensionar VPS (downtime) |
| Escala horizontal | instâncias + LB | configurar LB/ingress |
| Horas de operação/mês | ~1–2 h | **~6–12 h** (estimar com o time) |

Custo real ≈ `mensalidade + (horas × custo-hora) + risco de indisponibilidade`.
Com custo-hora de R$ 80 e 8 h/mês de operação, a VPS "mais barata" já carrega
**~R$ 640/mês** de trabalho — antes de backup e monitoramento.

### 6.3 A pergunta que o benchmark responde

> A VPS oferece vantagem **real** sobre a Render?

A hipótese técnica plausível é: **sim em CPU**, **não em latência de rede**.

- A VPS entrega **núcleos dedicados**, o que ataca diretamente o custo de CPU
  medido (Argon2id 110 ms; PDF/XLSX; relatórios). Se o benchmark mostrar CPU
  alta na Render e/ou latência de login dominando o P95, a VPS ganha.
- Mas a **latência API↔Neon** e a **latência usuário↔servidor** são
  determinadas por **região**, não por hospedagem. Se a VPS estiver no Brasil e
  o Neon nos EUA, ganha-se no usuário e perde-se no banco. **Escolher a região
  do Neon mais próxima de quem usa o ERP é a decisão de maior impacto e menor
  custo** — vale mais que Render×VPS.
- E o `free` da Render não é comparável a VPS nenhuma: ele **suspende**. A
  comparação honesta é Render **paga** × VPS.

### 6.4 Recomendação (fundamentada)

1. **Curto prazo (esta semana) — sem migrar nada:**
   a. criar os índices de busca **antes** do deploy da migração, pelo caminho
   `CONCURRENTLY` (`npm run perf:indices` → dry-run → `--apply`), após backup.
   Fazendo nessa ordem, quando a `0121` rodar no boot ela encontra os índices
   já criados (`IF NOT EXISTS`) e não bloqueia escrita em `produtos`;
   b. publicar este código (compressão, boot-hold, listagens sem N+1);
   c. ligar um monitor externo em `GET /api/health/db` **a cada 5 min no horário
      comercial** — mantém instância e compute do Neon acordados;
   d. rodar `npm run perf:diagnostico` **antes e depois** e arquivar os dois JSON.
2. **Decisão de plano (autorização de custo):** se o diagnóstico pós-correção
   ainda mostrar P95 acima das metas em horário comercial, o primeiro degrau é
   **Render paga (Starter)** — resolve suspensão e CPU sem ganhar operação nova.
   É a mudança de melhor relação custo/risco.
3. **VPS só se o benchmark comprovar** que CPU dedicada domina o gargalo **e**
   houver quem opere (patch, backup testado, monitoramento, TLS). Recomendação
   preliminar: **manter Render** para a produção e usar VPS apenas como
   ambiente de medição/DR. **Nenhuma migração automática é feita** — o
   `docker-compose` existe para medir, com o mesmo código e o mesmo banco.
4. **Região:** colocar Neon e aplicação **na mesma região**, o mais próximo
   possível dos usuários. Isso reduz a latência por consulta — o multiplicador
   de tudo que foi corrigido aqui.

---

## 7. Como reproduzir tudo (15 minutos, leitura apenas)

```bash
# 1) Diagnóstico por rota (P50/P95/P99, cold start, fases do servidor, payload)
PERF_EMAIL=... PERF_SENHA=... PERF_TOTP_SECRET=... \
  npm run perf:diagnostico -- --base https://brobond-erp.onrender.com \
  --iteracoes 20 --saida antes.json --markdown antes.md

# 2) Teste de carga progressivo (1, 5, 10, 25 simultâneos)
PERF_EMAIL=... PERF_SENHA=... PERF_TOTP_SECRET=... \
  npm run perf:carga -- --base https://brobond-erp.onrender.com \
  --estagios 1,5,10,25 --duracao 30 --saida carga.json

# 3) Planos de execução (em banco de TESTE / branch do Neon, nunca produção)
PERF_DB_URL='postgres://...' npm run perf:explain -- --json antes-planos.json
#    ... aplica 0121 ...
PERF_DB_URL='postgres://...' npm run perf:explain -- --json depois-planos.json

# 4) Estado agregado do servidor a qualquer momento (admin)
curl -H "Authorization: Bearer $TOKEN" https://.../api/admin/metrics | jq '.http'
```

**Guardas de segurança dos scripts:** só `SELECT`/`WITH` no `EXPLAIN` (em
transação `READ ONLY` com `statement_timeout`); recusa URL que pareça produção
sem flag explícita; escrita desabilitada por padrão no teste de carga; segredos
e tokens nunca são impressos; MFA/TOTP é calculado localmente, sem enfraquecer
o segundo fator.

---

## 8. Pendências conhecidas (transparência)

| Pendência | Por que não foi feita | Impacto |
|---|---|---|
| Migrar `tsx` → build compilado no runtime | `moduleResolution: bundler` emite imports sem extensão que o Node ESM não resolve; exigiria bundler e revisão de caminhos de arquivo (`db/*.sql`). Fazer isso **só na VPS** invalidaria o benchmark | Boot frio mais longo e mais memória; caminho: bundle esbuild com testes |
| Boot pular `bootstrap.sql` já aplicado | Enfraquece a garantia de reconstrução estrutural; exige validação de existência de tabelas-base | 335 DDL por boot (segundos) |
| Worker dedicado de importação/relatório | Precisa de endpoint de status + contrato de idempotência com o frontend | Importação/relatório seguem síncronos |
| `socket.io` com adapter distribuído | Pré-requisito para múltiplas instâncias com tempo real | Escala horizontal com WebSocket exige sticky session |
| N+1 de HTTP em `FiscalExecucoesPage` | Precisa de endpoint em lote no servidor | Uma requisição por linha naquela tela |
| Medição real de produção | Sandbox sem saída para o domínio da aplicação | Números de produção devem ser gerados com os comandos da seção 7 |
