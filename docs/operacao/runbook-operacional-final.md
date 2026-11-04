# Runbook operacional — Ordem Final (BroBond ERP)

Documento de operação para quem decide e executa. **Nada deste runbook foi executado em produção.**
Integração Git com a `main` não é deploy nem go-live. Cada seção diz o que está pronto, o que é só teste local e
o que depende de autorização.

## 1. Estado atual (resumo)

| Área | Código | Teste local | Sandbox | Operação real |
|---|---|---|---|---|
| Cinco jobs de cron | Pronto | Sim | — | **Não ativado** |
| PagBank webhook | Pronto | Sim | Não executado | Não executado |
| Reconciliação de webhooks legados | Pronto | Sim | — | **Não executada** em produção |
| Mercado Livre | Pronto (contrato obrigatório) | Sim | Não executado | **Suspenso** |
| Nuvemshop 2025-03 | Escrita **bloqueada** | Sim | Não executado | **Suspensa**; sem escrita |
| PIX | Mock e contrato separados | Sim | **Pulado** sem credencial | Não executado |
| Arquivos privados | Pronto | Sim | — | — |
| JWT_SECRET e ADMIN_PASSWORD | Sem padrão em produção | Sim | — | Não verificado no ambiente real |

Não há deploy, alteração no Render nem em `render.yaml`. Não há reativação de Mercado Livre nem Nuvemshop.

## 2. Cron (cinco jobs)

Detalhes e parâmetros: `docs/operacao/cinco-jobs-cron.md`.

- **Antes de ativar:** autorização G1; `CRON_SECRET` definido no ambiente de execução; agendador escolhido.
- **Comando por job:** `BROBOND_BASE_URL=https://<host> CRON_SECRET=<segredo> node scripts/cron-processo.mjs <processo>`.
- **Diagnóstico:** procurar no log `cron_cliente_sucesso`, `cron_cliente_transitoria`, `cron_cliente_falha`,
  `cron_cliente_ignorado_concorrente`. No servidor: `cron_processo`, `cron_processo_timeout`, `cron_processo_falhou`.
- **Código de saída 2:** configuração inválida. Conferir `BROBOND_BASE_URL` (https) e `CRON_SECRET`.
- **Desativar:** remover o agendamento. Nenhum outro efeito. Recorrências financeiras não dependem do cron.

## 3. Mercado Livre — declaração do contrato do token estático

O token estático `MERCADOLIVRE_TOKEN` só pode ser usado pela rota legada com contrato declarado (ADR-005).

**Quem pode declarar:** o Diretor, por escrito, indicando a empresa e a referência do contrato.

**Como declarar:** definir `MERCADOLIVRE_TOKEN_ESTATICO_CONTRATO=<empresa_id>:<referência>` no ambiente, com referência
de pelo menos 8 caracteres e sem espaços. A referência não deve conter dados pessoais.

**Registro obrigatório:** registrar no registro de operação a data, quem autorizou, a empresa, o motivo e a referência
(fora do repositório). Não colar o token nem a referência em chats ou issues.

**Verificação:** `GET /api/marketplace/status` (somente admin) deve mostrar `contrato_token_estatico: true` para a empresa
correta. Uma tentativa sem contrato gera registro de auditoria `seguranca`.

**Revogação:** remover a variável. A rota volta a responder 409 antes de qualquer chamada externa.

**Leitura de anúncios:** `lerAnunciosMercadoLivre` é somente GET. Não há rota para ela. Qualquer uso é feito por
operador com token autorizado, e o resultado alimenta o relatório de reconciliação (sem alterações).

**Publicação:** continua suspensa por padrão (`PUBLICACAO_CANAIS_LIBERADOS` sem `MERCADOLIVRE`).

## 4. Nuvemshop 2025-03

- **Escrita bloqueada** por constante de código (`ESCRITA_NUVEMSHOP_2025_LIBERADA = false`, ADR-006).
- Não existe variável de ambiente para liberar a escrita. Liberar exige alteração revisada e evidência oficial
  registrada em `docs/auditoria/gate-leitura-nuvemshop-2025-03.md` §8.
- **Diagnóstico:** se uma publicação falhar com "bloqueada", o comportamento é esperado. Não há chamada à loja.
- **Credencial:** continua pendente (G4, G6). Nenhuma credencial deve ser criada ou inventada.

## 5. PagBank

- Segredo dedicado: `PAGBANK_WEBHOOK_SECRET` (G2) ou `webhook_segredo_cifrado` da empresa. Sem segredo, a rota recusa.
- **Não usar o access token como segredo** (R-10).
- Validação: SHA-256 hex de `{token}-{corpo cru}`, comparação em tempo constante. Nenhum valor é registrado.
- **Diagnóstico:** `401` com `assinatura_ok = false` em `gateway_webhook_events` indica assinatura ausente ou divergente.
  O corpo não deve ser reformatado antes da verificação.
- Nenhuma credencial real foi usada. Nenhuma chamada financeira foi feita.

## 6. Reconciliação de webhooks legados

Procedimento completo, com backup, execução e rollback: `docs/operacao/procedimento-reconciliacao-webhooks.md`.

Resumo operacional:

1. **Dry-run** (padrão, não grava): `POST /api/admin/webhooks/reconciliacao` com `{}`.
2. **Backup lógico** das quatro tabelas, fora do repositório (§4 do procedimento).
3. **Aplicar** somente após G3: `{"aplicar":true,"confirmar":"RECONCILIAR_WEBHOOKS"}`.
4. **Conferir:** repetir o dry-run; `associar` deve ser 0.
5. **Rollback** (somente os eventos listados pela auditoria `reconciliacao-webhooks-v1`): `UPDATE gateway_webhook_events SET empresa_id = NULL WHERE id IN (...)`.

Regras: a empresa vem da cobrança inequívoca, nunca do payload; eventos ambíguos ficam sem associação; nada é apagado.
Os webhooks de **saída** legados não são associados automaticamente (G3).

## 7. Arquivos privados (comprovantes e anexos)

- Fotos de **produtos** são públicas (`Cache-Control: public, max-age=31536000, immutable`).
- Todo outro recurso é **privado**: exige URL assinada (`exp` e `sig`), com TTL de 15 minutos. Resposta com
  `Cache-Control: private, no-store` e `X-Content-Type-Options: nosniff`. Assinatura ausente, inválida ou expirada gera
  `404` uniforme.
- A URL assinada é emitida somente para registros que o ator acessa na sua empresa. Outra empresa recebe `404`.
- A chave deriva do `JWT_SECRET`. Em produção sem esse segredo, a assinatura falha fechada.

## 8. Segredos de administração

- Em produção, o processo **não sobe** sem `DATABASE_URL`, sem `JWT_SECRET` forte (mínimo 24 caracteres, diferente do padrão
  de desenvolvimento) ou sem `ADMIN_PASSWORD` forte (mínimo 8, diferente de `brobond123`). Verificado em processo filho.
- `NODE_ENV=production` já está declarado em `render.yaml`. Não remover.
- Nenhum valor de segredo deve ser colado em chat, issue, commit ou log.
- Troca de `JWT_SECRET` invalida sessões e pode afetar a decifragem de segredos legados. Planejar antes.

## 9. PIX — camadas de teste

| Camada | Arquivo | O que prova |
|---|---|---|
| Mock | `commerce-pix-mock-flow.test.ts` | Fluxo com gateway simulado. **Não é integração real.** |
| Contrato | adapters em `modules/payments/providers` | Formato de entrada e saída |
| Integração local | `commerce-orders-pix.test.ts` | Adapter com `fetch` simulado. Nenhuma rede. |
| Sandbox | `pix-sandbox-opcional.test.ts` | Cobrança PIX no sandbox do provedor, **somente** com `PIX_SANDBOX_PROVEDOR` e `PIX_SANDBOX_ACCESS_TOKEN` |

Sem as duas variáveis, o teste de sandbox é pulado. Ele **nunca foi executado** contra um sandbox real.

**Limitação IPC:** uma falha intermitente de IPC apareceu em execuções anteriores. Em 6 execuções isoladas, nenhuma
reproduziu. A causa não foi determinada. Não tratar como resolvida.

## 10. Rollback geral

- **Código:** os commits são aditivos. Reverter um commit específico não exige reescrever o histórico.
- **Configuração:** remover as variáveis novas (`CRON_*`, `MERCADOLIVRE_TOKEN_ESTATICO_CONTRATO`, `PIX_SANDBOX_*`).
  Nenhuma delas é obrigatória para o sistema subir.
- **Banco:** a migração `0097` é aditiva (colunas `empresa_id` nulas). Rollback SQL documentado em `fase-4-3-registro.md`.
- **Nenhuma exclusão** de eventos históricos é feita por este runbook.

## 11. O que este runbook não autoriza

Deploy, alteração no Render ou em `render.yaml`, ativação de cron, reativação de Mercado Livre ou Nuvemshop,
operações reais em provedores, go-live. Cada um depende de decisão expressa do Diretor.
