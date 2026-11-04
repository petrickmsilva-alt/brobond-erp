# Cinco jobs de cron — contrato operacional (Fase 4.3, item 15; Ordem Final, pendência 2.1)

Documento de operação. Fontes de verdade: `server/src/scheduled.ts` (`processosCron`, `TIMEOUT_PADRAO_MS`,
`executarProcessoCron`, `cronPara`), `scripts/cron-processo.mjs` (cliente de execução) e a decisão
`docs/ADR-002-CRON-PROCESSOS-INDEPENDENTES.md` e `docs/ADR-007-CLIENTE-CRON-RETENTATIVA.md`.

**Estado:** código e testes locais prontos. **Nenhum agendador está configurado e nenhum job está ativo.**
`render.yaml` não declara cron e não foi alterado. A ativação depende de autorização do Diretor (pendência G1).
Parâmetros abaixo são **propostos e implementados no cliente**, não ativados.

## 1. Contrato comum (servidor)

| Item | Valor comprovado no código |
|---|---|
| URL | `POST /api/admin/scheduled/cron/{processo}` |
| Processos válidos | `relatorios`, `pagamentos`, `publicacoes`, `pedidos`, `crm` |
| Método | `POST` (somente) |
| Autenticação | `Authorization: Bearer <CRON_SECRET>`. Sessão de usuário **não** é aceita. Comparação em tempo constante. |
| Sem `CRON_SECRET` | `503` com `{"ok":false,"error":"Cron desativado: CRON_SECRET não configurado."}` (sem campo `motivo`); nada é executado |
| Token inválido | `401` |
| Processo desconhecido | `404` (inclusive `recorrencias`, que não é processo de cron) |
| Já em execução (processo local ou lease PostgreSQL) | `409` com `motivo: "ja_em_execucao"` |
| Timeout do processo | `503` com `motivo: "timeout"`; a trava só é liberada quando o trabalho realmente termina |
| Erro no executor | `503` com `motivo: "erro"` (mensagem bruta não é exposta nem registrada) |
| Falha parcial (itens com falha) | `503` sem `motivo` (ex.: `falhas` não vazio) |
| Sucesso | `200` com `ok:true`, `itens`, `falhas`, `inicio`, `fim` |
| Registro | Log JSON estruturado (`cron_processo`, `cron_processo_timeout`, `cron_processo_falhou`, `cron_processo_recusado`), sem payloads, e-mails, tokens ou mensagens brutas |
| Isolamento | Um processo não chama outro; `relatorios` não dispara efeito financeiro, de publicação, de pedido ou de CRM |
| Recorrências financeiras | **Fora do cron.** Só existem em `POST /api/admin/financeiro/recorrencias`, com confirmação explícita. Não há agendador interno. |

Rota de compatibilidade: `POST /api/admin/scheduled/cron` (sem processo) executa **somente** `relatorios`.
`GET /api/admin/scheduled/run` (sessão de administrador) executa `relatorios` e o motor de negócios; responde `processos_fora_desta_rota` com os outros quatro.

## 2. Parâmetros dos cinco jobs (definidos pelo agente; não ativados)

| Processo | Endpoint | Método | Auth | Frequência proposta (BRT, UTC‑3) | Expressão cron (UTC) | Timeout servidor | Timeout cliente (servidor + 60 s) | Retentativa (cliente) | Concorrência | Idempotência | Critério de sucesso |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `relatorios` | `/api/admin/scheduled/cron/relatorios` | POST | Bearer `CRON_SECRET` | diária 06:00 | `0 9 * * *` | 300 s | 360 s | até 3 tentativas | lease PostgreSQL por job (409) | Relatórios por empresa/dia; e-mail at-least-once | 200 `ok:true` |
| `pagamentos` | `/api/admin/scheduled/cron/pagamentos` | POST | Bearer `CRON_SECRET` | a cada 5 min | `*/5 * * * *` | 240 s | 300 s | até 3 tentativas | lease PostgreSQL por job (409) | Intent/webhook + outbox; provedor at-least-once | 200 `ok:true` |
| `publicacoes` | `/api/admin/scheduled/cron/publicacoes` | POST | Bearer `CRON_SECRET` | a cada 10 min | `*/10 * * * *` | 300 s | 360 s | até 3 tentativas | lease PostgreSQL por job (409) | Fila com CAS + chave `publicacoes:{id}:{estado}`; ML e Nuvemshop suspensos | 200 `ok:true` |
| `pedidos` | `/api/admin/scheduled/cron/pedidos` | POST | Bearer `CRON_SECRET` | a cada 5 min | `*/5 * * * *` | 240 s | 300 s | até 3 tentativas | lease PostgreSQL por job (409) | Outbox com claim_versao + chave persistente | 200 `ok:true` |
| `crm` | `/api/admin/scheduled/cron/crm` | POST | Bearer `CRON_SECRET` | diária 08:00 | `0 11 * * *` | 120 s | 180 s | até 3 tentativas | lease PostgreSQL por job (409) | Marcador `lembrete_enviado_em` + chave `crm:lembrete:{id}` | 200 `ok:true` |

Timeouts do servidor podem ser ajustados por `CRON_TIMEOUT_<PROCESSO>_MS` (inteiro entre 10 000 e 1 800 000 ms;
valor inválido usa o padrão). `CRON_CLIENT_TIMEOUT_MS` ajusta o timeout do cliente (mínimo 5 000 ms).

### 2.1 Cliente de execução (`scripts/cron-processo.mjs`)

Uso pelo agendador externo (um comando por job):

```
BROBOND_BASE_URL=https://<host-do-erp> CRON_SECRET=<segredo> node scripts/cron-processo.mjs <processo>
```

- `BROBOND_BASE_URL` deve ser `https` (`http` só para `localhost`/`127.0.0.1`).
- Variáveis opcionais: `CRON_MAX_TENTATIVAS` (padrão 3; intervalo 1–5), `CRON_BACKOFF_MS` (padrão 60 000),
  `CRON_CLIENT_TIMEOUT_MS`.
- **Retenta** somente: timeout do cliente, erro de rede, `503` com `motivo` `timeout` ou `erro`.
  Espera: `CRON_BACKOFF_MS × 5^(n−1)`, com teto de 600 s. Com o padrão, a espera é 60 s e depois 300 s.
- **Não retenta:** `401`, `404`, `503` sem `motivo` (ex.: `CRON_SECRET` ausente no servidor), demais códigos.
- `409` (`ja_em_execucao`) é encerrado com **saída 0** e registrado como `cron_cliente_ignorado_concorrente`.
- Códigos de saída: `0` sucesso ou ignorado; `1` falha; `2` configuração inválida (nenhuma chamada feita).
- Nunca imprime o `CRON_SECRET`, cabeçalhos nem o corpo bruto da resposta.

## 3. Limites declarados

1. **Trava de concorrência.** Sem `DATABASE_URL` (demonstração) a trava continua só no processo. Com PostgreSQL,
   `cron_job_locks` arbitra os cinco `job_id` entre instâncias (lease, heartbeat, fencing nas escritas do
   `PgStore` e idempotência em `cron_work_items`). Efeito em provedor externo não é exatamente uma vez.
   Detalhe e evidência: `docs/auditoria/conclusao-hardening-distribuido.md`. **Nenhum cron está ativo.**
2. **Frequência e timeout** são propostas. Não foram aprovadas pelo Diretor; a ativação é G1.
3. **Retentativa de efeito:** o cliente repete a chamada. A idempotência de cada efeito depende do próprio processo
   (outbox, chave de evento, marcadores). Um processo lento que estoura o timeout do cliente pode continuar rodando
   no servidor; por isso a trava (409) impede uma segunda execução concorrente na mesma instância.
4. **Agendador externo:** não escolhido nem testado contra a plataforma de produção. Nesta sandbox não há egress.
5. **Testes:** `server/test/cron-timeout-concorrencia.test.ts` (5), `server/test/cron-cliente-retentativa.test.ts` (7),
   `server/test/cron-cliente-integracao-local.test.ts` (5, handler real em Express local), além de
   `cron-processos-independentes` e `cron-recorrencias-contrato`. Todos locais; nenhuma chamada a produção.

## 4. Como ativar (somente após autorização G1)

1. Confirmar `CRON_SECRET` no ambiente, sem colar o valor em lugares públicos.
2. Confirmar frequência e timeouts (tabela §2) ou alterá-los pelas variáveis acima.
3. Configurar o agendador externo para executar `node scripts/cron-processo.mjs <processo>` com as variáveis da §2.1.
4. Validar primeiro com `relatorios` (verificar o log `cron_cliente_sucesso`) e conferir `falhas` e `409`.
5. Ativar os demais um a um, observando `cron_cliente_falha` e `cron_cliente_transitoria`.
6. Não ativar publicações de ML ou Nuvemshop: a suspensão padrão continua valendo (`PUBLICACAO_CANAIS_LIBERADOS`).
