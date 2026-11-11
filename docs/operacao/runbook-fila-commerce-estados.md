# Runbook — fila do commerce: normalizar as divergências do Omnichannel

Operação controlada para tirar o painel `/commerce/omnichannel` do estado em que
**falta de configuração** aparece como **falha de sincronização**.

> Esta rotina é um **ato operacional** sobre um banco. O código entrega a ferramenta
> e as provas; a execução no banco publicado é um passo separado, autorizado pelo
> Diretor. Nada aqui é executado automaticamente por deploy ou cron.

## Por que existe

O painel agrupava como `outbox_error` (severidade alta) toda linha de
`commerce_outbox` em estado `ERRO`. Três situações diferentes caíam juntas:

| Situação | Estado correto | O painel deve dizer |
|---|---|---|
| Integração quebrou de verdade | `ERRO` | falha de sincronização |
| Canal sem provedor (SMTP/WhatsApp) | `BLOQUEADO` | pendência de configuração |
| Aviso de canal descontinuado, sem efeito | `OBSOLETO` | histórico encerrado com trilha |

O caso observado (18 ocorrências, `pedido:2`, tipo `outbox_error`) era do segundo
tipo: as notificações nunca tinham provedor. Repetir 10× não cria um provedor.

## Pré-condições (conferir antes de rodar)

1. A migration `0116_commerce_outbox_estados_terminal.sql` foi aplicada
   (`SELECT id FROM schema_migrations WHERE id LIKE '0116%';` deve retornar 1 linha).
2. Existe backup recuperável do banco publicado, **validado** (restaurado e conferido).
3. A aplicação está com a versão deste PR publicada — o código novo é quem grava
   `BLOQUEADO`/`OBSOLETO`; sem ele a fila volta a marcar `ERRO`.
4. `DATABASE_URL` aponta para o banco **publicado** e o SSL está normalizado
   (`sslmode` → `verify-full`; `PGSSL=false` só em ambiente local).

## Passo 1 — conferência (NÃO altera nada)

Roda numa transação com `ROLLBACK`. É obrigatório antes da execução real.

```bash
cd /app                                  # raiz do repo no Render Shell
DATABASE_URL="$DATABASE_URL" \
  node --import tsx scripts/reconciliar-fila-commerce.ts --empresas=1 --ator="Diretor"
```

Ou por atalho: `npm run commerce:reconciliar-fila -- --empresas=1`.

A saída lista, evento a evento, o estado anterior, o novo estado e o motivo, e
termina com o total (`obsoletos | reclassificados | reenfileirados | mantidos`).
**Leia a lista inteira** e confirme que cada encerramento faz sentido.

Sem `--empresas`, varre todas as empresas ativas (relatório por empresa).

## Passo 2 — execução real (exige confirmação explícita)

Só depois de revisar o passo 1 e ter autorização do Diretor:

```bash
DATABASE_URL="$DATABASE_URL" \
  node --import tsx scripts/reconciliar-fila-commerce.ts \
    --empresas=1 --executar --confirm=RECONCILIAR-FILA --ator="Diretor"
```

Cada alteração é gravada na auditoria. O que a execução faz e não faz:

- **Faz**: `ERRO` só por falta de configuração → `BLOQUEADO`; aviso cujo pedido já
  é `CANCELADO`/`EXPIRADO`/`ESTORNADO` (ou cobrança resolvida) → `OBSOLETO` com
  motivo/data/responsável; `BLOQUEADO` com provedor já configurado → `PENDENTE`.
- **Não faz**: apagar linha; tocar em dinheiro, estoque, pedido, venda ou pagamento;
  encerrar evento financeiro/de estoque pendente; reenviar para canal descontinuado.

## Passo 3 — conferência do painel

Após a execução, `GET /api/control-tower/painel` e `/commerce/omnichannel` devem
mostrar `outbox_erro` caindo para zero (ou só o que for falha técnica real),
`outbox_bloqueado` com as pendências de configuração e `outbox_obsoleto` como
histórico — **não** como divergência aberta.

Se ainda houver `BLOQUEADO`, a ação correta é **configurar o canal**
(SMTP/WhatsApp em `configuracoes`), não reprocessar.

## Rollback

A operação é reversível em SQL, sem perda de dado (as linhas nunca são apagadas):

```sql
BEGIN;
UPDATE commerce_outbox SET estado = 'ERRO'
 WHERE estado IN ('BLOQUEADO','OBSOLETO') AND empresa_id = 1;
UPDATE commerce_outbox SET motivo_encerramento = NULL, encerrado_em = NULL, encerrado_por = NULL
 WHERE empresa_id = 1;
COMMIT;
```

Reverter a **migration** 0116 está documentado no cabeçalho do próprio arquivo e
exige manutenção autorizada.

## O que este runbook não autoriza

- Executar o saneamento geral pré-go-live (ver `OPERACAO-SANEAMENTO-GO-LIVE.md`) —
  é outra rotina, outra autorização.
- Alterar configuração do Render, DNS ou integrações externas.
- Marcar divergências como resolvidas sem reconciliar contra a verdade canônica.
