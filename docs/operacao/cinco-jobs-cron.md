# Cinco jobs de cron — contrato operacional (Fase 4.3, item 15)

Documento de operação. Fonte de verdade do comportamento: `server/src/scheduled.ts`
(`processosCron`, `executarProcessoCron`, `cronPara`) e a decisão `docs/ADR-002-CRON-PROCESSOS-INDEPENDENTES.md`.

**Estado:** o código está pronto e testado localmente. **Nenhum agendador está configurado.**
`render.yaml` não declara cron. Configurar o agendamento depende de autorização do Diretor (pendência G1).

## 1. Contrato comum

| Item | Valor comprovado no código |
|---|---|
| URL | `POST /api/admin/scheduled/cron/{processo}` |
| Processos válidos | `relatorios`, `pagamentos`, `publicacoes`, `pedidos`, `crm` |
| Método | `POST` (somente) |
| Autenticação | Cabeçalho `Authorization: Bearer <CRON_SECRET>`. Sessão de usuário **não** é aceita. Comparação em tempo constante. |
| Sem `CRON_SECRET` | `503` com `{"ok":false,"error":"Cron desativado: CRON_SECRET não configurado."}`; nada é executado |
| Token inválido | `401` |
| Processo desconhecido | `404` (inclusive `recorrencias`, que não é processo de cron) |
| Execução concorrente do mesmo processo | `409` (trava por instância; o processo não roda duas vezes ao mesmo tempo) |
| Falha de um processo | `503` com `ok:false`; os outros processos não são afetados |
| Sucesso | `200` com `ok:true`, `itens`, `falhas`, `inicio`, `fim` |
| Registro | Log JSON estruturado, sem payloads, e-mails, tokens ou mensagens de erro brutas |
| Isolamento | Um processo não chama outro; `relatorios` não dispara efeito financeiro, de publicação, de pedido ou de CRM |
| Recorrências financeiras | **Fora do cron.** Só existem em `POST /api/admin/financeiro/recorrencias`, com confirmação explícita. Não há agendador interno. |

Rota de compatibilidade: `POST /api/admin/scheduled/cron` (sem processo) executa **somente** `relatorios`.
`GET /api/admin/scheduled/run` (sessão de administrador) executa `relatorios` e o motor de negócios; responde `processos_fora_desta_rota` com os outros quatro.

## 2. Os cinco jobs

| Processo | URL | Método | Auth | Frequência | Timeout | Retentativa |
|---|---|---|---|---|---|---|
| `relatorios` | `/api/admin/scheduled/cron/relatorios` | POST | Bearer CRON_SECRET | **Não definida** (G1) | **Não declarado pela aplicação** | **Nenhuma automática**; reexecução manual ou por agendador externo |
| `pagamentos` | `/api/admin/scheduled/cron/pagamentos` | POST | Bearer CRON_SECRET | **Não definida** (G1) | **Não declarado pela aplicação** | **Nenhuma automática**; reexecução manual ou por agendador externo |
| `publicacoes` | `/api/admin/scheduled/cron/publicacoes` | POST | Bearer CRON_SECRET | **Não definida** (G1) | **Não declarado pela aplicação** | **Nenhuma automática**; reexecução manual ou por agendador externo |
| `pedidos` | `/api/admin/scheduled/cron/pedidos` | POST | Bearer CRON_SECRET | **Não definida** (G1) | **Não declarado pela aplicação** | **Nenhuma automática**; reexecução manual ou por agendador externo |
| `crm` | `/api/admin/scheduled/cron/crm` | POST | Bearer CRON_SECRET | **Não definida** (G1) | **Não declarado pela aplicação** | **Nenhuma automática**; reexecução manual ou por agendador externo |

Conteúdo de cada processo (verificado em `scheduled.ts`):

- **`relatorios`:** gera posição de estoque, vendas e alertas/falhas de envio, somente quando a agenda correspondente (`POSICAO_ESTOQUE`, `VENDAS`, `ALERTAS`) está devida. Não executa efeito financeiro.
- **`pagamentos`:** sincroniza pagamentos pendentes (`runPaymentJobs`), expira checkouts pendentes e processa até 10 itens da outbox de reembolsos de devolução.
- **`publicacoes`:** processa até 20 itens da fila de publicações (que respeita a suspensão de ML e Nuvemshop) e até 10 itens da outbox de publicações.
- **`pedidos`:** recupera pedidos de marketplace pendentes e processa até 10 itens da outbox de eventos de pedido.
- **`crm`:** dispara lembretes de CRM. Com o canal desligado (`NOTIFICAR_CRM_LEMBRETE` diferente de `true`), não grava nem envia.

Suspensão de publicação: sem `MERCADOLIVRE` e `NUVEMSHOP` em `PUBLICACAO_CANAIS_LIBERADOS`, nada é enviado ao provedor (coberto por `publicacao-canais-p0` e `publicacao-nuvemshop-fluxo`).

## 3. Lacunas declaradas

1. **Frequência:** não há valor aprovado. Escolha e configuração ficam com o Diretor (G1).
2. **Timeout:** a aplicação não impõe limite por processo. Quem chama deve configurar o timeout no próprio agendador. Recomenda-se definir um valor antes de ativar, porque um processo lento não tem teto próprio.
3. **Retentativa:** a aplicação não repete execuções. Uma falha vira `503`. Quem agenda decide se reenvia; a reexecução é segura pela trava de concorrência (`409`), mas a idempotência de efeito depende de cada processo (ver observações acima e ADR-002).
4. **Agendador externo:** não foi escolhido nem testado contra a plataforma de produção. Sem egress nesta sandbox, nenhuma chamada real foi feita.

## 4. Verificação local

- Testes de cron: `server/test/cron-processos-independentes.test.ts`, `server/test/cron-recorrencias-contrato.test.ts` e `server/test/pg/sec03-admin-routes-authorization.test.ts` (PG).
- Nenhuma chamada a produção, Render ou agendador externo foi executada.

## 5. Como ativar (somente após autorização G1)

1. Confirmar `CRON_SECRET` no ambiente (sem colar o valor em lugares públicos).
2. Escolher frequência e timeout para cada processo.
3. Configurar o agendador externo com `POST` e cabeçalho `Authorization: Bearer <CRON_SECRET>`.
4. Validar com uma chamada de `relatorios` e conferir o log `cron_processo`.
5. Ativar os demais um a um, observando `falhas` e `409`.
