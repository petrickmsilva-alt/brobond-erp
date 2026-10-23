# BroBond Print Agent (P1)

Agente local de impressão do BroBond ERP. Roda no computador da loja
(Windows é o alvo; desenvolve/testa em qualquer Node ≥ 18), faz **polling**
na fila de impressão do ERP e executa os jobs com **claim/lease** e
**journal anti-duplicação**. Nunca escuta na rede: a API local é
**127.0.0.1:17831** apenas.

## Como funciona

```text
ERP (fila print_jobs) ──claim/lease──► Agente ──► Renderer ──► Impressora
        ▲                                   │
        └──── heartbeat / printed / fail ◄──┘   (agente sempre inicia)
```

- **Pareamento:** no ERP (gerente/admin), `POST /api/print/pairing` gera um
  código de uso único (10 min). No agente: `--pair XXXX-XXXX-XXXX` ou
  `POST http://127.0.0.1:17831/pair`. O agente recebe uma **machine identity**
  própria (machine_id + token revogável) — não é o login de nenhum usuário.
- **Polling com backoff:** ERP hibernado/fora do ar vira espera crescente
  (até 60 s), nunca erro fatal.
- **Não duplica:** lease no servidor (só um agente por job) + journal local
  (`printed-journal.log`): se o agente cair depois de imprimir e antes do
  ack, ao reivindicar de novo ele confirma sem reimprimir.
- **Dry-run por padrão:** na P1 a "impressora" é o arquivo
  `outbox/<jobId>.txt` (renderer de texto). ESC/POS (P2) e ZPL/EPL2 (P4)
  entram como renderer/printer novos, sem mudar fila, lease ou journal.

## Rodando

```bash
npm install
npm run build
BROBOND_ERP_URL=https://erp.exemplo.com.br node dist/index.js --pair ABCD-EFGH-JKLM
BROBOND_ERP_URL=https://erp.exemplo.com.br node dist/index.js
```

Configuração completa: `src/config/config.ts` (arquivo
`agent-config.json` + variáveis `BROBOND_*`). O token de máquina fica em
arquivo separado e restrito (`machine-token`, 0600 onde suportado; no
Windows, dentro de `%LOCALAPPDATA%\BroBond\PrintAgent`). Revogação e
rotação do token são feitas no ERP — um token vazado morre na hora.

## Estrutura

```text
src/
  core/       loop de polling, backoff
  transport/  cliente do ERP (polling) + API local 127.0.0.1
  auth/       machine identity (nonce/timestamp anti-replay)
  queue/      execução de um job (claim → printed/fail)
  printer/    saída física + journal anti-duplicação
  renderer/   PrintIR → carga (texto hoje; ESC/POS P2; ZPL/EPL2 P4)
  config/     configuração local e token
  logging/    log sem segredos
```

## Testes

```bash
npm test
```
