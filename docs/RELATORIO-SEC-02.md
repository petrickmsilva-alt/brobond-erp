# RELATÓRIO SEC-02 — Bypass do rate limit de login via `X-Forwarded-For`

- **Status:** PASS WITH RESERVATIONS
- **Ciclo:** SEC-02 (remediação P1-04)
- **Base:** `main` após o merge do PR #64 (SEC-01)
- **Branch:** `fix/sec-02-login-rate-limit-proxy`
- **Finding de origem:** FULL FORENSIC SYSTEM AUDIT (PR #63) — `P1-04 — LOGIN
  RATE LIMIT BYPASS VIA X-FORWARDED-FOR`

---

## 1. Finding original

O mecanismo de rate limit do login derivava a identidade do cliente (o "IP") —
usada como parte da chave do bucket — **diretamente do cabeçalho
`X-Forwarded-For`**, um valor totalmente controlável pelo cliente:

```ts
// server/src/auth.ts (ANTES)
export function clientIp(req: Request): string {
  const fwd = (req.headers['x-forwarded-for'] as string) || '';
  return (fwd.split(',')[0] || req.socket.remoteAddress || '').trim();
}
```

Como a chave do bucket de login é `login|<ip>|<email>`
(`server/src/security.ts → loginBucketKey`), trocar o `X-Forwarded-For` a cada
tentativa fazia o atacante **obter um bucket novo** e escapar do limite de 5
tentativas por janela. Agravante: `app.set('trust proxy', 1)` era **fixo**, em
todos os ambientes, inclusive quando não há proxy algum — o Express então aceitava
o XFF do cliente.

## 2. Causa raiz

1. **Fonte de verdade errada:** a identidade do rate limit vinha de um
   *cabeçalho de requisição* em vez do *endereço resolvido segundo uma cadeia de
   confiança verificável*.
2. **Confiança implícita de proxy:** `trust proxy = 1` fixo, sem configuração
   explícita por ambiente, marcando um hop como confiável mesmo sem proxy.
3. **Parser paralelo:** `clientIp` reimplementava um parser de `X-Forwarded-For`
   em vez de usar `req.ip` — que o Express já resolve respeitando `trust proxy`.

## 3. Cadeia de confiança de proxy (documentada)

| Ambientação | Cadeia | Quem define o IP do cliente |
|---|---|---|
| Desenvolvimento / testes | `cliente → app` | endereço TCP real do socket |
| Produção direta (`PORT` exposto) | `cliente → app` | endereço TCP real do socket |
| Produção atrás de proxy confiável | `cliente → proxy → app` | Express a partir do `X-Forwarded-For`, **confiando no hop do proxy** |

A confiança é declarada **explicitamente** por ambiente pela variável
`TRUST_PROXY` (formatos aceitos = os do próprio Express): `false`/ausente (padrão),
`true`, número de hops (`1`, `2`, …), ou lista de nomes/IPs/CIDRs.

**Render (produção real deste projeto):** `render.yaml` agora declara
`TRUST_PROXY: "1"` (um proxy conhecido). O aviso no arquivo impede o uso de
`"true"` (ver riscos residuais).

## 4. Implementação escolhida

Não foi criado um parser próprio nem uma dependência nova. Usou-se a capacidade
nativa do Express:

- **`server/src/security.ts`** — novo `trustProxySetting()`: lê `TRUST_PROXY` e
  devolve `false` (padrão), `true`, número de hops ou string de sub-redes/CIDR.
- **`server/src/index.ts`** — `app.set('trust proxy', trustProxySetting())`
  substitui o `1` fixo.
- **`server/src/auth.ts`** — `clientIp` passou a usar `req.ip` (resolvido pelo
  Express conforme a confiança) com validação `isIP`; qualquer valor não-IP
  (cabeçalho lixo aceito por confiança frouxa) ou ausente cai para o endereço da
  conexão. Assim nenhum valor cru de cabeçalho entra na chave.
- **`server/src/sessoes.ts`** — a derivação do IP da sessão (`clientIpRaw`) foi
  alinhada à mesma regra (`req.ip` → socket), mantendo coerência entre rate
  limit, auditoria e registro de sessão.
- **`render.yaml`** — declara `TRUST_PROXY=1` de forma explícita e comentada.

## 5. Por que o `X-Forwarded-For` arbitrário não funciona mais

Sem proxy confiável (o padrão), o Express compila uma função de confiança que
não considera nenhum hop. `req.ip` passa a ser **o endereço da conexão TCP**,
independentemente do `X-Forwarded-For`. A chave do bucket deixa de conter
qualquer valor do cliente. Verificado empiricamente e por HTTP real:

- `XFF=1.1.1.1` e depois `XFF=2.2.2.2` → **um único** bucket
  `login|127.0.0.1|…` (PostgreSQL).
- 100 valores distintos de XFF → bloqueio na 6ª tentativa e **1** bucket.

Com `TRUST_PROXY=1` (hoje, apenas onde a infraestrutura é comprovada), a
confiança é no hop e o `req.ip` vira o **IP do cliente** encaminhado pelo proxy —
não o `X-Forwarded-For` cru, e não o IP do proxy.

## 6. Comportamento sem proxy

- IP = endereço da conexão real.
- `X-Forwarded-For` do cliente é **ignorado** para efeito de identidade.
- Login legítimo continua funcionando (TESTE F).

## 7. Comportamento com proxy confiável

- `TRUST_PROXY=1` (Render): `req.ip` = IP do cliente na cadeia.
- Prova (TESTE D): requisição chegando de `127.0.0.1` (o proxy) com
  `XFF=198.51.100.10` gera o bucket `login|198.51.100.10|…` — o **IP do
  cliente**, não o do proxy; dois clientes distintos atrás do mesmo proxy têm
  buckets separados.

## 8. Testes adversariais

Arquivo: `server/test/pg/sec02-login-ratelimit-proxy.test.ts` — **PostgreSQL
real**, banco novo, servidor HTTP real (Express), sem memória / injeção de
`req.user` / serviço externo. A prova é **mecanismo-precisa**: além do status
HTTP, conta os **buckets de rate limit persistidos no Postgres**.

| Teste | Cenário | Resultado |
|---|---|---|
| **A** | mesma conexão, `XFF 1.1.1.1` → `2.2.2.2` | 6ª tentativa bloqueada; **1** bucket `login\|127.0.0.1\|…` |
| **B** | `XFF` variando em 100 valores (`10.0.0.x`) | bloqueio na 6ª; **1** bucket |
| **C** | formatos hostis: `1.1.1.1`, `1.1.1.1, 2.2.2.2`, `8.8.8.8, 1.1.1.1`, `invalid`, vazio, cabeçalho repetido | todos bloqueados após 5 falhas; **1** bucket por e-mail |
| **D** | `TRUST_PROXY=1`; proxy=`127.0.0.1`, clientes `198.51.100.10/20` | bucket = IP do cliente; buckets separados por cliente |
| **E** | execução HTTP real pelo Express | ✅ (todo o arquivo) |
| **F** | login legítimo (`200` + JWT) com XFF forjado | ✅ não é bloqueado |
| **G** | `/api/auth/reset` (limiter só por IP, sem lock de usuário): XFF trocado a cada hit | 5×400 + **429** na 6ª; bucket `reset\|127.0.0.1` |

### Reprovação antes da correção (prova do bypass)

Com o `clientIp` antigo restaurado (lendo o XFF cru), o mesmo teste **falha** com:

```
AssertionError: A: a chave deve usar o IP real (127.0.0.1), veio login|1.1.1.1|sec02-a-…@example.test
```

Ou seja, a chave de rate limit passava a ser **o valor escolhido pelo atacante** —
o bypass é reproduzido e, com a correção, deixa de existir.

## 9. Testes de regressão

| Verificação | Resultado |
|---|---|
| `npm --prefix server run typecheck` | ✅ 0 erros |
| `npm run typecheck:domain` | ✅ 0 erros |
| `npm --prefix client run typecheck` | ✅ 0 erros |
| `npm --prefix server test` (memória) | ✅ 741 pass / 0 fail / 66 skip |
| `npm --prefix client test` | ✅ 323 pass / 323 |
| **PostgreSQL real** (`test/pg-*.ts` + `test/pg/*.test.ts`, banco novo) | ✅ **193 pass / 0 fail / 0 skip / 0 todo** |
| `npm run lint` | ✅ 0 erros (409 warnings pré-existentes) |
| `npm run build` | ✅ ok |
| `npm run smoke` (126 verificações) | ✅ 126/126 |
| `npm run audit:menu` | ✅ sem erros |
| Testes específicos SEC-02 (novo + unit) | ✅ inclui A–G |

Notas:
- O gate oficial `npm run test:pg` (`scripts/test-pg-gate.mjs`) exige **PostgreSQL
  16.14 exato** e banco vazio; o container local disponível é **16.15**, então o
  preflight recusa — a suíte PG foi executada diretamente contra um banco novo
  (16.15), com todos os arquivos `test/pg-*.ts` e `test/pg/*.test.ts`. A CI
  (`ci.yml`) continua usando `postgres:16.14`; o novo arquivo segue a convenção
  `test/pg/*.test.ts` e **falha** (não pula) se `DATABASE_URL` faltar.
- A suíte de memória subiu de 740 para 741 passes (novo teste unitário de
  `trustProxySetting`).

## 10. Arquivos alterados

| Arquivo | Mudança |
|---|---|
| `server/src/security.ts` | `trustProxySetting()` (confiança explícita por ambiente) |
| `server/src/index.ts` | `app.set('trust proxy', trustProxySetting())` |
| `server/src/auth.ts` | `clientIp` usa `req.ip` (trust-aware) + validação `isIP` |
| `server/src/sessoes.ts` | IP da sessão alinhado à mesma regra |
| `render.yaml` | `TRUST_PROXY: "1"` explícito e comentado |
| `server/test/api.test.ts` | contrato de `clientIp` atualizado |
| `server/test/regras.test.ts` | + teste unitário de `trustProxySetting` |
| `server/test/pg/sec02-login-ratelimit-proxy.test.ts` | **novo**: prova adversarial A–G |

## 11. Riscos residuais

1. **Configuração do proxy.** A correção depende de `TRUST_PROXY` refletir a
   topologia real. Se produção mantiver o valor em `render.yaml` (`1`) com a
   Render como único proxy, o comportamento é correto. Se alguém usar `"true"`
   (aceitar todo hop), o bypass volta — por isso o `render.yaml` traz um aviso
   explícito. Sem `TRUST_PROXY`, o comportamento é o mais seguro (IP do socket):
   na Render isso agruparia todos os clientes no IP do proxy (um bucket só),
   degradando a granularidade, mas **não** reabre o bypass.
2. **Fail-open do rate limit.** Com o banco de rate limit indisponível, o login
   segue (comportamento pré-existente, não alterado — fora de escopo).
3. **Índice de rede.** Atrás de proxy, o rate limit passa a se apoiar no
   `X-Forwarded-For` — confiável **apenas** porque o hop é marcado como confiável.
   A confiança no IP encaminhado é inerente a qualquer proxy L7; a mitigação é a
   política explícita de hop.
4. **IPv6/socket.** `isIP` aceita IPv4 e IPv6; endereços de socket especiais
   (`::1`, `::ffff:127.0.0.1`) são tratados como o IP apresentado pelo Express —
   sem impacto na corretude do bucket.

## 12. Findings descobertos, mas fora de escopo (NÃO corrigidos)

1. **`P2 — IP de rate limit de endpoints públicos via XFF cru`** — `catalogos.ts:39`
   (`rateLimitPublico`) e `portal.ts:17/133` (`rateLimitPortal` e registro de
   decisão de cotação) ainda leem `X-Forwarded-For` **cru** como identidade.
   Mesma classe de problema; fora do escopo deste ciclo (que é o **login**).
   Recomenda-se alinhá-los a `req.ip` em um ciclo SEC próprio.
2. **`P2 — rate limit público em memória por processo`** — `rateLimitPublico`/
   `rateLimitPortal` usam `Map` em memória (não persistem, não são compartilhados
   entre instâncias). Não é o mecanismo de login; fora de escopo.
3. **`P3 — duplicação de derivação de IP`** — havia três implementações
   (`auth.clientIp`, `sessoes.clientIpRaw`, leitura crua em catalogos/portal).
   As duas do caminho de autenticação foram unificadas; restam as de endpoints
   públicos (item 1).

## 13. Critério de aceitação (auto-avaliação)

| # | Critério | Situação |
|---|---|---|
| 1 | XFF não troca o bucket de rate limit | ✅ CONFIRMED (A/B/C/G + Postgres) |
| 2 | Configuração de proxy explícita | ✅ `TRUST_PROXY` + `render.yaml` |
| 3 | Comportamento atrás de proxy confiável preservado | ✅ TESTE D (IP do cliente) |
| 4 | Teste adversarial reproduz o bypass antes / não após | ✅ ambos demonstrados |
| 5 | Teste HTTP real | ✅ servidor Express real |
| 6 | PostgreSQL real | ✅ 193 passes na suíte PG |
| 7 | Sem regressão relevante | ✅ typecheck/testes/lint/build/smoke |
| 8 | Sem mudança fora do escopo | ✅ apenas login/sessão/proxy |

## 14. Conclusão

**PASS WITH RESERVATIONS.** O bypass por `X-Forwarded-For` está fechado no
caminho de autenticação (login, reset, convite, MFA, sessão e auditoria), com
confiança de proxy explícita e prova adversarial em PostgreSQL real. A ressalva
é operacional (a variável `TRUST_PROXY` precisa refletir a topologia real — hoje
já refletida em `render.yaml`) e de escopo (endpoints públicos
catálogo/portal seguem com o padrão antigo, registrados como findings
separados, não corrigidos neste ciclo).
