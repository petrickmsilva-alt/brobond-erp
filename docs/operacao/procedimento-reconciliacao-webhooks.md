# Procedimento — reconciliação de webhooks legados (Fase 4.3, item 5)

Status: **implementado e testado localmente** (`server/test/webhook-reconciliacao-legados.test.ts`, 11 casos).
**Não foi executado em produção.** A execução real exige autorização do Diretor (G3) e backup lógico prévio.

Fontes: `server/src/webhookReconciliacao.ts`; decisão em `docs/ADR-003-WEBHOOKS-ASSOCIADOS-A-EMPRESA.md`.

## 1. O que é reconciliado

| Tabela | Coluna | Ação automática | Por quê |
|---|---|---|---|
| `gateway_webhook_events` (eventos de pagamento recebidos) | `empresa_id` NULL | **Sim**, somente com evidência inequívoca (ver §2) | Permite à empresa dona enxergar o evento |
| `webhooks` (assinaturas de saída) | `empresa_id` NULL | **Não** | Não há evidência de provedor para decidir a empresa. Só contagem. |
| `webhook_entregas` | `empresa_id` NULL | **Não** | Herda o webhook de saída |

## 2. Regra de associação (somente com evidência no banco)

Para cada evento com `empresa_id` nulo:

1. O provedor precisa estar registrado (parser próprio). Senão: `provedor_desconhecido`, sem associação.
2. A referência de negócio é extraída do payload com o parser do provedor. **Essa referência só localiza candidatas.** Nunca define a empresa.
   Sem referência: `sem_referencia`.
3. Buscam-se as cobranças `gateway_cobrancas` com o mesmo `provider` e `provider_ref`.
4. Decisão:
   - Nenhuma cobrança, ou alguma cobrança sem empresa: `sem_correspondencia`.
   - Cobranças de **mais de uma** empresa: `ambiguo`.
   - Todas as cobranças de **uma** empresa: `associar` (empresa = a da cobrança).

**Garantias:**

- O campo `empresa_id` do payload é **ignorado** (há teste específico).
- A associação **não autentica** o evento: `assinatura_ok`, `status`, `payload` e `evento_id` não mudam.
- Nenhum evento é apagado.
- Eventos já associados nunca são reatribuídos (claim CAS: só atualiza se `empresa_id` ainda for nulo).
- Reexecutar não altera nada (idempotência).

## 3. Execução

A rota é **somente para administrador** (`/api/admin`, `requireRole('admin')`).

```
POST /api/admin/webhooks/reconciliacao
Content-Type: application/json
```

**Passo 1 — dry-run (padrão, não grava):**

```json
{}
```

A resposta traz `modo: "dry-run"`, o resumo por decisão, e as listas `associar_ids` e `pendentes_ids`.
Não traz payloads, referências de cobrança nem tokens.

**Passo 2 — backup lógico (obrigatório antes de aplicar):** ver §4.

**Passo 3 — aplicar (somente após autorização G3 e backup):**

```json
{ "aplicar": true, "confirmar": "RECONCILIAR_WEBHOOKS" }
```

Sem `confirmar` exato, a rota responde `400` e nada é gravado.

**Passo 4 — conferir:** a resposta traz `aplicacao.associados` e `aplicacao.ignorados_por_concorrencia`.
Repetir o dry-run deve mostrar `associar: 0`.

## 4. Backup lógico (antes de aplicar)

Cópia dos dados que a reconciliação pode alterar, fora do repositório:

```
pg_dump --data-only --column-inserts \
  --table=gateway_webhook_events --table=gateway_cobrancas \
  --table=webhooks --table=webhook_entregas \
  --file=/caminho/seguro/backup-webhooks-AAAAMMDD.sql "$DATABASE_URL"
```

Guardar o arquivo com acesso restrito. Ele contém dados de clientes; não o versionar.

## 5. Auditoria e rastreabilidade

Cada associação grava uma linha em `auditoria` com:

- `recurso = 'gateway_webhook_events'`
- `registro_id` = id do evento
- `descricao` contendo `reconciliacao-webhooks-v1`
- `dados` com `origem`, `evento_id`, `provider` e `cobranca_id`

Listar o que a reconciliação associou:

```sql
SELECT registro_id, empresa_id, data
FROM auditoria
WHERE recurso = 'gateway_webhook_events'
  AND descricao LIKE '%reconciliacao-webhooks-v1%'
ORDER BY id;
```

## 6. Rollback

Reverter a associação feita por esta reconciliação (sem tocar em nenhum outro evento):

```sql
UPDATE gateway_webhook_events
SET empresa_id = NULL
WHERE id IN (
  SELECT registro_id FROM auditoria
  WHERE recurso = 'gateway_webhook_events'
    AND descricao LIKE '%reconciliacao-webhooks-v1%'
);
```

Antes de executar, conferir a lista com a consulta da §5 e registrar a reversão no registro de operação.
Em caso de dúvida, restaurar a partir do backup da §4 apenas para as linhas listadas.
A trilha de auditoria **não** é apagada: a reversão fica registrada por fora, no registro de operação.

## 7. Webhooks de saída legados (decisão G3)

Os registros de `webhooks` e `webhook_entregas` com `empresa_id` NULL continuam **globais** (ADR-003): não aparecem para administradores de empresa.
A rota apenas os **conta**. A associação exige decisão operacional, caso a caso, com:

- o destino (URL) e a empresa dona, confirmados pelo responsável comercial;
- registro na auditoria do motivo.

Não existe associação automática para eles.

## 8. Pendências

- **G3:** autorização para executar a aplicação em produção e aprovação do procedimento de decisão dos webhooks de saída.
- Não há evidência de execução em produção. Os testes são locais, com store em memória.
