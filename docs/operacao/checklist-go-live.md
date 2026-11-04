# Checklist de go-live controlado — conectores

**Decisão de go-live: PENDENTE, do Diretor.** Este checklist reúne o que falta para a decisão. Ele não autoriza nada. Marcar um item como feito exige evidência registrada (data, ambiente, identificador, sem segredo).

Legenda: [ ] não feito · [~] feito só localmente · [x] feito com evidência externa (nenhum item está marcado como [x]).

## A. Publicação Mercado Livre e Nuvemshop

- [~] P0-01 corrigido localmente (`0c0e6f5`).
- [ ] Reconciliação de duplicados já criados em produção (NÃO EXECUTADA).
- [ ] Homologação de publicação em conta de teste do ML (NÃO EXECUTADA).
- [ ] Homologação de publicação em loja de teste da Nuvemshop, contrato 2025-03 (condição da decisão (b)).
- [ ] Decisão (f): liberar `PUBLICACAO_CANAIS_LIBERADOS` em produção. **Pendente.**

## B. Mensageria

- [~] SMTP: verificação `verify()` e teste ao administrador (`9b8c18c`, local).
- [ ] SMTP real: executar a verificação e o teste no ambiente de produção pela rota admin (NÃO EXECUTADO).
- [~] WhatsApp: padrão Graph `v26.0` (local). **Verificar** se `WHATSAPP_API_VERSION` no Render está definida como `v21.0`. Se estiver, a produção continuará em v21.0 até alteração aprovada.
- [ ] WhatsApp: homologação de envio com template aprovado (NÃO EXECUTADA).
- [~] WhatsApp: webhook de status implementado e ligado à variável `WHATSAPP_SECRET` (decisão (d), nome informado pelo Diretor). Sem a variável no Render, o endpoint recusa tudo. **Pendente:** criar a variável no Render (ação do Diretor) e definir o token de verificação do GET, que ainda não tem nome autorizado.
- [ ] Central de Notificações com os 8 estados e último envio/erro (P2-07, NÃO IMPLEMENTADO).

## C. Monitoramento

- [~] Alerta de falhas no relatório diário (P2-08): outbox em `ERRO`, entregas de webhook com erro e notificações em falha (local).
- [ ] Destinatários do relatório configurados em produção: **verificar** `NOTIFICAR_EMAILS` ou `SCHEDULE_EMAILS` e `SCHEDULE_ALERTAS` no Render (valores não verificados).
- [ ] Envio agendado de ponta a ponta recebido por um destinatário real (NÃO EXECUTADO).
- [~] Runbook por conector (`docs/operacao/runbook-incidentes-conectores.md`): rascunho, não revisado por operação.
- [ ] Evidências por conector arquivadas (matriz `docs/auditoria/matriz-evidencias-conectores.md`: todas as colunas de homologação estão NÃO EXECUTADO).

## D. Segurança

- [~] Chaves de cifra consolidadas (Fase 2). Produção sem chave dedicada falha fechado ao cifrar. **Verificar** no Render (não verificado).
- [~] Webhooks de ML e MP fail-closed (Fase 2). **Premissa, não verificada:** os segredos já estão em produção (decisão (c)).
- [~] Anti-SSRF em webhooks de saída (P2-01, commit `4b8dceb`). Rebinding de DNS é risco residual.
- [ ] Decisão (e): cifra consolidada e motor canônico confirmados formalmente. **Pendente.**

## E. Decisões que bloqueiam o go-live (somente o Diretor)

1. Decisão (f): liberar ML e Nuvemshop em produção após homologação e reconciliação.
2. Decisão (d): criar `WHATSAPP_SECRET` no Render e autorizar o nome do token de verificação do GET (ativação de P1-05).
3. Decisão (e): confirmar a cifra consolidada e o motor canônico.
4. Decisão de go-live em si, com base nos itens acima.

Enquanto os itens de homologação estiverem NÃO EXECUTADO, o sistema não deve ser declarado integrado com nenhum provedor externo.
