# BroBond Print Agent (P1–P6)

Agente local de impressão do BroBond ERP. Executa na estação de trabalho da loja/expedição (Windows, Linux ou macOS com Node >= 18), realiza **polling HTTPS** autenticado na fila `print_jobs` do ERP e entrega bytes nativos às impressoras térmicas e de sistema com **claim/lease**, **nonce anti-replay** e **journal local anti-duplicação**.

Nunca abre porta para a rede local: a ponte de diagnóstico/pareamento escuta estritamente em **`127.0.0.1:17831`** com proteção contra DNS Rebinding (`Host`) e CSRF (`Origin` / `Sec-Fetch-Site`).

## Renderers e Transportes Suportados

- **Renderers (`criarRegistryPadrao`)**:
  - `escpos` — Recibos térmicos PDV 80mm (48 col), 72mm (42 col) e 58mm (32 col), CP850, tabelas, QR Code nativo `GS ( k`, códigos de barras `GS k` e corte parcial `GS V 66`.
  - `zpl` — Etiquetas térmicas Zebra/compatíveis (`ZPL II ^XA..^XZ`), validação GS1 estrita (`EAN-8`, `UPC-A`, `EAN-13`, `GTIN-14`), `Code 128` para SKU, repetição nativa `^PQ<n>` e escape `^FH_` contra injeção.
  - `epl2` — Etiquetas térmicas Elgin L42 / Zebra TLP2844 (`EPL2 N..P<n>`), validação GS1 estrita e sanitização de campos.
  - `text` — Texto colunar puro (48 colunas) e inspeção dry-run.
- **Modos de Saída (`BROBOND_PRINTER_MODE`)**:
  - `dry-run` (padrão seguro de desenvolvimento): grava `outbox/<jobId>.<ext>` confinado contra path traversal.
  - `system` (produção): envia bytes RAW via socket `tcp://<ip>:<porta>` (ex.: JetDirect `9100`), spooler RAW do Windows (`RawPrinterHelper` via `execFile` sem shell) ou CUPS (`lp -o raw -d <fila>`), além de listar impressoras instaladas no SO durante o heartbeat.

## Uso Rápido

```bash
npm ci
npm run build

# 1. Parear com código único de 10 min gerado no ERP (/config/impressao)
BROBOND_ERP_URL=https://erp.exemplo.com.br node dist/index.js --pair ABCD-EFGH-JKLM

# 2. Executar em modo produção (spooler do SO / TCP RAW)
BROBOND_ERP_URL=https://erp.exemplo.com.br BROBOND_PRINTER_MODE=system node dist/index.js
```

Credenciais ficam isoladas em `machine-token` (`0600`) fora do `agent-config.json` e jamais aparecem nos logs estruturados. Documentação arquitetural completa em `../docs/IMPRESSAO-P0-P6.md`.
