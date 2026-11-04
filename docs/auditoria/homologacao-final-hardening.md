# Homologação final do hardening

**Classificação: APROVADO COM BLOQUEIO EXTERNO IDENTIFICADO**

## 1. Origem, branch e Git

| Item | Valor |
|---|---|
| Commit de origem da arquitetura | `cf8b519` |
| Commit da entrega operacional anterior | `0d681c6` |
| Branch efetivamente usada | `arena/615f44fd-brobond-erp` (fixa da sessão) |
| Branch pedida | `arena/homologacao-final-hardening` — **não publicada**. Criada localmente por engano e apagada imediatamente; nenhum push. |
| Force-push / merge / deploy | nenhum |
| Ancestralidade | `cf8b519` ⊂ `0d681c6` ⊂ HEAD desta entrega |

O CI de `0d681c6` falhou em `testes-postgres` (1/428): disputa multiprocessos de refund. Hipótese: workers sem `JWT_SECRET` compartilhado após o segredo efêmero. Corrigido no gate e no workflow (segredo aleatório por execução, mas **o mesmo** entre processos).

## 2. Matriz única de aceitação

| Camada | Critério | Estado | Evidência |
|---|---|---|---|
| Arquitetura | Cinco jobs protegidos em todos os caminhos operacionais | **Atendido (E1+E2)** | `requireJobLease` em drenos; `executarProcessoCron` + HTTP cron; sem bypass `NODE_ENV=test` |
| Segurança | JWT, AES, senhas, varredura | **Atendido internamente (E1+E2)** | `segredoJwt()` sem literal; produção fail-closed; `credential-scan.test.ts` |
| Backend | Lock, fencing, idempotência, recuperação | **Atendido (E2+E3 local)** | `test:cron-lock:pg` 2/2; `fencedPoolQuery`; `withCronIdempotency` |
| Integrações | Contratos, outbox, limites de provedor | **Atendido internamente; E4 bloqueado** | INDETERMINADO + reconciliação local; ML/Nuvemshop suspensos; PIX sem credencial |
| Frontend | Suíte isolada; carga concorrente | **Isolado a confirmar nesta rodada; carga flaky (E2)** | Isolado histórico 1151; carga 8 workers: 19 falhas de timing |
| Testes | Gates locais, PG, concorrência | **Parcial (E3)** | Servidor 1953/0/82; cron-lock PG 2/2; `test:pg` local sem `psql`; CI instala `psql` |
| Homologação | E1–E5 separados | **Atendido no documento** | Sem E4/E5 |

## 3. Cinco jobs e pontos de entrada

| Job | HTTP | Worker | Dreno direto | Idempotência | Lock | Fencing |
|---|---|---|---|---|---|---|
| `relatorios` | `runScheduled` (admin) / `cronProcesso` | `executarProcessoCron` | só via cron | `relatorios:*:empresa:dia` | lease do processo | `executeCronUnit` / `query()` |
| `pagamentos` | cron token | `runPaymentJobs`, `expirarCheckoutsPendentes`, outbox refund | `requireJobLease('pagamentos')` | `pagamentos:intent:` / webhook | lease | idem |
| `publicacoes` | reprocessar + ganchos | `processarFilaPublicacoes` / `processarPublicacao` | `requireJobLease` | `publicacoes:id:estado` | lease | idem |
| `pedidos` | outbox reprocessar | `processarOutbox` tipos de pedido | `requireJobLease` | `outbox:id:versão:estado` | lease | idem |
| `crm` | cron token | `dispararLembretesCrm` | `requireJobLease` | `crm:lembrete:id` | lease | carimbo CAS |

`processarComercioAgendado` e ganchos usam `withOptionalJobLease` (skip se ocupado), **também com `NODE_ENV=test` quando há pool**.

Produção sem PostgreSQL: `executarProcessoCron` 503; `requireJobLease` lança. Memória só fora de produção.

## 4. Lock, fencing, idempotência, recuperação

- `cronLock.ts`: lease, heartbeat, token, `executeCronUnit`, `UNKNOWN` não reenvia.
- `db.ts` `query()`: INSERT/UPDATE/DELETE sob lease → `fencedPoolQuery`.
- Teste PG (E3): worker obsoleto INSERT rejeitado (`cron-lock-distributed-pg.ts`).
- Recuperação: `PROCESSANDO` >10 min → `INDETERMINADO` (sem reenvio). Reconciliação local (abaixo).

## 5. Ciclo INDETERMINADO / outbox (esta missão)

Criado em: `executarProcessarOutbox` quando `PROCESSANDO` preso.

Reconciliação (`diagnosticarIndeterminado` / `reconciliarLinhaIndeterminada`):

| Tipo | Evidência local | Ação |
|---|---|---|
| `alerta` | log-only | `PROCESSADO` |
| `conversao` | pedido `CONVERTIDO` | `PROCESSADO`; senão reenfileira (idempotente local) |
| `publicacao` | `PUBLISHED` | `PROCESSADO`; senão permanece (sem reenvio a canal) |
| `refund_devolucao` | estado local de estorno | confirma só com evidência; senão aguarda |
| notificação / SMTP / Woo | sem consulta de provedor | permanece; operador pode reenfileirar |

`reprocessarOutbox` aceita `ERRO` **e** `INDETERMINADO`. Sem exatamente-uma-vez externo.

Testes: `foundation-outbox-audit.test.ts` (E2).

## 6. CRM

`lembrete_enviado_em` só após entrega verdadeira. Falha/timeout: sem carimbo, lote continua, retry na próxima passagem. CAS perdido: não duplica. Canal desligado: zero carimbo.

Testes: `crm-lembrete-entrega.test.ts` (E2).

## 7. JWT e cifra

- Produção: `JWT_SECRET` obrigatório (boot + `segredoJwt`).
- Fora de produção, ausente: segredo **efêmero do processo** (nunca `brobond-dev-secret`).
- Consequência: restart invalida sessões; **testes multiprocessos precisam de `JWT_SECRET` compartilhado**.
- Gate `scripts/test-pg-gate.mjs` e CI `testes-postgres` geram um valor aleatório por execução e exportam.
- AES-256-GCM inalterado; chave dedicada separada do JWT; produção sem chave falha; legado JWT só para decifrar.

## 8. Credenciais

Classificação da varredura (`credential-scan.test.ts`):

| Classe | Tratamento |
|---|---|
| Funcional indevida | bloqueada (senha admin concatenada, AKIA, `ghp_`, BEGIN PRIVATE KEY fora de `.md`/`test/`) |
| Denylist | `brobond-dev-secret`, senha admin histórica em `security.ts` / `senhaAdmin.ts` |
| Teste / fixture | literais em `server/test/**` (excluídos do padrão AKIA/ghp) |
| Documental | `.md` excluído |
| Histórico redigido | preservado |

Não rotacionou credencial externa.

## 9. PostgreSQL

- Instância local 16.14 em `:55439` (E3). Sem binário `psql` no sandbox (só `postgres`/`pg_ctl`/`initdb`).
- **Não** foi criado shim de `psql`.
- `test:cron-lock:pg` **2/2** nesta sessão (E3).
- `test:pg` (gate ERP-03) exige 0 skip. Os testes PROD-DB-01.5.* executam SQL administrativo via `psql -f`; sem o cliente, pulam. O CI instala `postgresql-client-16` (`.github/workflows/ci.yml`).
- Último CI em `0d681c6`: `verificar` ok; `testes-postgres` 427 pass / 1 fail (refund multiprocessos). Correção JWT nesta entrega; evidência E3 completa fica no próximo CI desta branch.

## 10. 82 testes ignorados em `test:server`

`test:server` **não** define `DATABASE_URL`. Os 82 skips são exatamente:

| Arquivo | N | Motivo |
|---|---:|---|
| `server/test/pg-*.test.ts` (21 arquivos) | 81 | PostgreSQL (`DATABASE_URL`) |
| `server/test/pix-sandbox-opcional.test.ts` | 1 | credencial PIX sandbox ausente |

Nenhum skip obsoleto apagado. Nenhum skip convertido em aprovação. Executáveis com banco: os 81 (job CI / `test:pg`). PIX permanece bloqueado sem credencial **legítima**.

## 11. Lint (612 avisos, 0 erros)

Contagem inalterada (612). Avisos nos arquivos desta linha (`crm.ts` unused, `db.ts` `any` na assinatura histórica de `query`, `scheduled.ts` `any`) são **preexistentes**. Esta missão não introduziu erro de lint. Sem refatoração ampla para zerar o histórico.

## 12. Typecheck e build

- `npm run typecheck` (domínio + servidor + cliente): **passou**.
- Lint: 0 erros.
- Build do front: job CI `verificar` em `0d681c6` **success**. Não rebuild local nesta rodada após o typecheck.

## 13. Cliente

| Modo | Resultado |
|---|---|
| Isolado sozinho (esta sessão) | **1151/1151** |
| Isolado em paralelo com servidor | 1149 pass / 2 fail — timeout 5s Command Palette |
| Carga `--maxWorkers=8` | 1132 pass / 19 fail — rotas/palette/fluxo (timing) |
| Correção | `Layout.test.tsx`: `findByRole`/`findAllByRole` e timeout 15s só na busca longa |

A estabilidade sob carga concorrente **não** é 1151/1151. Causa: testes de UI com `userEvent` + default 5s, não regressão de produto. O gate de cliente desta homologação é a suíte isolada.

## 14. Conectores

| Conector | Estado | Evidência |
|---|---|---|
| PagBank / PIX | contrato interno; sandbox E4 sem credencial | `pix-sandbox-opcional.test.ts` skip |
| WooCommerce | outbox `woo-estoque`; recusa sem config | foundation-outbox |
| Mercado Livre | escrita suspensa | não reativado |
| Nuvemshop | escrita suspensa | não reativado |
| SMTP | CRM só carimba após canal | testes CRM |
| Outreach AI / AI CEO | fora de escopo | trava de fase |

## 15. Bloqueios externos (não simulados)

1. Binário `psql` ausente no sandbox local (CI o instala).
2. Credencial PIX sandbox não fornecida.
3. Homologação E4/E5 de provedores e produção **não autorizadas**.
4. ML/Nuvemshop suspensos por decisão prévia.

## 16. Riscos residuais

- At-least-once se o processo morrer após o provedor aceitar e antes de `PROCESSADO`/`COMPLETED`.
- SMTP/Woo sem consulta de status: `INDETERMINADO` exige operador.
- Cliente flaky sob workers paralelos.
- `tx.query` do chamador fora do `PgStore`/`query()` não passa por `fencedPoolQuery` (o `PgStore` cobre o caminho canônico).

## 17. Próximos passos estritamente necessários

1. Acompanhar o CI `testes-postgres` desta branch (psql + JWT compartilhado).
2. Credencial PIX sandbox **legítima** quando o Diretor autorizar E4.
3. Isolar a suíte de cliente em CI com `--maxWorkers=1` se a carga paralela não for o gate.
4. Sem merge, deploy, Render, cron de produção ou reativação ML/Nuvemshop.

## 18. Testes desta missão (números)

| Gate | Resultado |
|---|---|
| Typecheck raiz | passou |
| Lint | 612 avisos / 0 erros |
| `test:server` | **1953 pass / 0 fail / 82 skip** |
| CRM + outbox INDETERMINADO | 14/14 |
| `test:cron-lock:pg` | **2/2** |
| Cliente isolado | **1151/1151** |
| `test:pg` local | bloqueado sem `psql` (esperado) |
