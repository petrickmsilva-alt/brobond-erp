# Execução — Fase 4 (mensageria) e Fase 7 (go-live controlado e monitoramento)

Status: **parcial**. Itens de código e de teste local concluídos. Nenhuma homologação, nenhum provedor real e nenhuma produção foram executados. A decisão de go-live é do Diretor e **não foi tomada**.

Ordem do Diretor: "PODE CONTINUAR EXECUTAR AS FASES 4 E 7 … COM O PASSO NATURAL." Restrições mantidas: sem variável de ambiente nova (decisão (d)), sem merge, deploy, Render, `render.yaml` ou produção.

## Fase 4 — Mensageria

| Item | O que mudou | Nível de evidência | Commit |
|---|---|---|---|
| P1-06 SMTP `verify()` | `criarTransporteSmtp()` extraído (usado por envio e verificação). `verificarConexaoSmtp()` devolve `nao_configurado`, `dependencia_ausente`, `autenticacao_recusada`, `falha_conexao` ou `ok`, sem host, usuário nem senha. Rotas admin: `POST /api/admin/notificacoes/smtp/verificar` e `POST /api/admin/notificacoes/smtp/teste` (teste só ao e-mail do próprio administrador, com destino mascarado). | Local e automatizado: `smtp-verificacao-admin.test.ts` 5/5 (inclui servidor recusando conexão em loopback, sem vazar credenciais). Mensagem real: NÃO EXECUTADO. | `9b8c18c` |
| P1-05 webhook de status WhatsApp | `GET`/`POST /api/webhooks/whatsapp` (montado antes de `/api/webhooks/:provider`). Fail-closed: sem segredo autorizado, 403 no GET e 401 no POST. HMAC `x-hub-signature-256` em tempo constante. Máquina de estados: `REQUEST_ACCEPTED < SENT < DELIVERED < READ`; `FAILED` é terminal e não sobrescreve `DELIVERED`/`READ`; evento atrasado é ignorado. Persistência por `provider_message_id` com `tryUpdateIf`. Telefone do destinatário é descartado na extração. | Local e automatizado: `whatsapp-status-webhook.test.ts` 9/9. **Mutação** (assinatura desligada e regra de estado removida) derruba 3 testes e volta a 9/9 após restaurar. Ativação: depende de criar `WHATSAPP_SECRET` no Render (ação do Diretor) e de autorizar o nome do token de verificação do GET (ainda sem nome; sem ele, a Meta não consegue inscrever o webhook). | `9b8c18c` |
| P2-06 versão Graph | Padrão de `WHATSAPP_API_VERSION` passa de `v21.0` para `v26.0`, alinhado ao Instagram. `v21.0` deixa de ser atendida em 21/01/2027. Fonte: documentação pública da Meta, lida por busca web (não é o changelog direto). | Local: `commerce-pix-real-flow` atualizado para a URL v26.0. Chamada real na v26.0: NÃO EXECUTADO. | `9b8c18c` |
| P2-07 Central de Notificações | **Não implementado.** Os 8 estados, o último envio e o último erro ficam para a próxima rodada. | — | — |
| Verificação de modelo aprovado (metadados Meta) | **Não implementado.** Exige acesso à conta Meta. | — | — |

Correções que o código não sustentava e que foram tratadas:

- O envio de WhatsApp grava `REQUEST_ACCEPTED`, que significa aceite da Meta, não entrega. Nada na Central deve chamar isso de "entregue" até o webhook estar ativo.
- `statusCanaisNotificacao` marca `CONFIGURADO` por presença de variável. Isso **não** prova conexão. A prova passa a existir pela rota `smtp/verificar`, mas não é persistida: `ok` vale só no momento da chamada (limitação documentada).

## Fase 7 — Monitoramento e go-live controlado

| Item | O que mudou | Nível de evidência |
|---|---|---|
| Alerta de outbox em `ERRO` (P2-08) | Seção "Falhas de envio nas últimas 24h" no relatório diário (`relatorioAlertas`). Agrupa por empresa e tipo. | Local e automatizado: `alertas-falhas-entrega.test.ts` 6/6. Disparo agendado de ponta a ponta: NÃO EXECUTADO. |
| Alerta de falhas de webhook de saída | Mesma seção, agrupada por empresa e evento, com entregas `erro` nas últimas 24h. | Idem. |
| Alerta de falhas de envio (WhatsApp/e-mail) | Mesma seção, agrupada por empresa e canal: `ERRO` ou `provider_status = FAILED`, deduplicado por registro. | Idem. |
| Privacidade do alerta | Só contagens. Não entram payload, telefone, URL, segredo nem `ultimo_erro`/`erro` brutos. O teste verifica que um token e um telefone gravados nesses campos não aparecem no HTML. | Automatizado (local). |
| Runbook por conector | `docs/operacao/runbook-incidentes-conectores.md` (rascunho, não revisado por operação). | Documental. |
| Matriz de evidências | `docs/auditoria/matriz-evidencias-conectores.md`. Todas as colunas de homologação e de provedor real estão NÃO EXECUTADO. | Documental. |
| Checklist de go-live | `docs/operacao/checklist-go-live.md`. Decisão do Diretor: **PENDENTE**. | Documental. |

Observação de código: o relatório de alertas **já era enviado sem condição** quando havia destinatários configurados (não só com alerta de estoque, como a nota anterior dizia). Por isso não foi alterado o controle de envio, apenas acrescentada a seção de falhas.

Destinatários: o relatório vai para `SCHEDULE_EMAILS` ou, na falta dele, `NOTIFICAR_EMAILS`. A leitura é do sistema inteiro, sem escopo de empresa, como já ocorria com o alerta de estoque. Por isso as falhas aparecem por empresa, e isso deve ser avaliado pelo Diretor antes do go-live (pode ser necessário restringir o destinatário).

## Testes

- Servidor (`npm test`): **1726 aprovados, 0 falhas, 76 ignorados** (76 já eram ignorados antes desta rodada).
- Typecheck do cliente: OK. Lint: 0 erros (608 avisos, anteriores a esta rodada).
- Gate `commerce:go-live` (estrutural, sem banco): P0 41 OK, 0 falha. Ele não certifica homologação.
- Novos testes desta rodada: 5 (SMTP) + 9 (WhatsApp) + 6 (alertas) = 20 casos locais.
- Não houve teste de PostgreSQL nesta rodada (PostgreSQL local indisponível).

## Limitações

- Nenhuma comunicação com Meta, SMTP real, provedores ou marketplaces. Os testes usam dublês, store em memória e loopback.
- O webhook WhatsApp **recusa todas as chamadas** até a decisão (d). Por isso não há confirmação de entrega pelo sistema hoje.
- `WHATSAPP_API_VERSION` no Render é `sync: false` (valor fora do blueprint). Se estiver fixada em `v21.0`, a produção continua nela. **Verificar.**
- Não foi verificado se `SCHEDULE_ALERTAS`, `NOTIFICAR_EMAILS` ou `SCHEDULE_EMAILS` estão configuradas em produção.

## Próximos passos (não executados)

1. Fase 4: P2-07 (Central com os 8 estados) e verificação de templates (exige acesso à Meta).
2. Fase 4: criar `WHATSAPP_SECRET` no Render (o código já a lê) e autorizar o nome do token de verificação do GET para inscrever o webhook.
3. Fase 7: o Diretor decide se o relatório de falhas segue para todos os destinatários configurados ou se é restringido.
4. Fase 7: executar homologação e registrar a matriz; só então considerar o go-live.
