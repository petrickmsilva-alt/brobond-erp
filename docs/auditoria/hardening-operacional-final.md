# Hardening operacional final

**Classificação: APROVADO COM BLOQUEIO EXTERNO IDENTIFICADO**

Branch da sessão (fixa): `arena/615f44fd-brobond-erp`.  
Pedido de branch `arena/hardening-operacional-final` **não** foi criado: a sessão Arena só publica esta branch.  
Origem preservada: `cf8b519` (ancestral). Sem force-push, merge, deploy, cron ativo ou alteração de produção.

## 1. Preservação

`git merge-base --is-ancestor cf8b519 HEAD` confirmado antes das alterações.  
Lock, lease, heartbeat, fencing token, `cron_job_locks`, `cron_work_items` e testes multiprocessos foram **estendidos**, não substituídos.

## 2. Caminhos alternativos corrigidos

`NODE_ENV=test` **deixou de dispensar** o lock quando há PostgreSQL.

| Função | Job | Proteção |
|---|---|---|
| `executarProcessoCron` | os cinco | lease se há `DATABASE_URL`; 503 em produção sem banco; memória só fora de produção |
| `processarFilaPublicacoes` / `processarPublicacao` | `publicacoes` | `requireJobLease` (retry se ocupado) |
| `processarOutbox` | job do tipo, ou os três em sequência | `requireJobLease` |
| `runPaymentJobs` | `pagamentos` | `requireJobLease` |
| `expirarCheckoutsPendentes` | `pagamentos` | `requireJobLease` |
| `dispararLembretesCrm` | `crm` | `requireJobLease` |
| `processarComercioAgendado` / drenagem da fila | respectivos | `withOptionalJobLease` = skip se ocupado, **também em teste com banco** |
| Relatórios | `relatorios` | só via `executarProcessoCron` + chave dia/empresa |

Sem PostgreSQL: demonstração/teste em memória executa sem lock distribuído e **sem** provedor (SMTP de lembrete exige `smtpConfigurado` ou enviador injetado). Produção sem banco não executa o cron.

## 3. SQL cru

`query()` em `db.ts` encaminha `INSERT`/`UPDATE`/`DELETE` para `fencedPoolQuery` quando há lease no `AsyncLocalStorage`: `BEGIN` + `SELECT … FOR UPDATE` do lock + escrita + `COMMIT`. Worker obsoleto: INSERT direto rejeitado no teste PG.

O `PgStore` continua com `EXISTS` na própria sentença.

## 4. Outbox e efeitos externos

Migration `0099_cron_unknown_outbox.sql`: estados `UNKNOWN` (`cron_work_items`) e `INDETERMINADO` (`commerce_outbox`).

`PROCESSANDO` preso (>10 min) **não** reprocessa: vai para `INDETERMINADO`. Reenvio cego evitado. SMTP/PagBank/ML/Nuvemshop/WhatsApp **não** oferecem exatamente-uma-vez nesta base; ML/Nuvemshop permanecem suspensos. Não houve chamada real.

## 5. CRM

`lembrete_enviado_em` só após `notificarLembreteCrm` retornar verdadeiro. Falha de canal → retry (`entrega_nao_confirmada`), sem carimbo. Envio ok e CAS perdido → `UNKNOWN`. Canal desligado: nenhum carimbo (já era assim).

## 6. JWT e cifra

`segredoJwt()`: produção falha sem variável. Fora de produção, sem variável, usa segredo **efêmero do processo** (nunca `'brobond-dev-secret'`). O literal permanece só como denylist (`security.ts`). Cifra AES-256-GCM inalterada; sem chave em produção lança; fora de produção deriva do JWT (efêmero ou configurado).

## 7. Credenciais

Varredura automatizada: senha admin legada + AKIA + `ghp_` + BEGIN PRIVATE KEY em arquivos rastreados (exceto `.md` e `test/`). Não é scanner geral de todos os literais sintéticos dos testes.

## 8. Testes (esta rodada)

| Gate | Resultado |
|---|---|
| Typecheck raiz | passou |
| Lint | 612 avisos, 0 erros |
| Cron memória + coordenação + credential-scan | 26/26 |
| `npm run test:server` | 1947 pass / 0 fail / 82 skip |
| `test:cron-lock:pg` | 2/2 (inclui fencing de `query()` INSERT) |
| `test:pg` completo | **bloqueado: sem `psql`** |
| PIX sandbox | sem credencial, não executado |
| Cliente isolado (`vitest --pool=forks --maxWorkers=1`) | 1151/1151 |

## 9. Riscos residuais

- Efeito externo at-least-once se o processo morrer após o provedor aceitar e antes de `COMPLETED`/`PROCESSADO`.
- Reconciliação de `INDETERMINADO` não consulta provedor (não há API confiável para SMTP).
- Escritas em transações abertas pelo chamador (`tx.query`) fora do `PgStore` e de `query()` não passam por `fencedPoolQuery`; o `PgStore` cobre o caminho canônico.
- Suíte cliente sob carga e gate PG com `psql` continuam dependências de ambiente.

## 10. Produção

Não houve alteração Render, cron, merge, deploy, migração de produção, pagamento, publicação ou mensagem reais.
