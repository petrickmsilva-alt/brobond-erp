# Programa Completo de Impressão Profissional — BroBond ERP (P0 a P6)

Documento arquitetural e operacional consolidado das fases **P0, P1, P2, P3, P4, P5 e P6** do subsistema de impressão do BroBond ERP.

---

## 1. Arquitetura Canônica Ponta-a-Ponta

```text
DOMÍNIO DO ERP (Banco PostgreSQL — Autoridade Única)
       │
       ▼
PrintIR v1 (packages/domain/src/print/print-ir.ts — Neutro de hardware)
       │
       ▼
FILA PERSISTIDA (print_jobs — Claim atômico + Lease + Idempotência)
       │
       ▼  HTTPS Polling (Agente inicia — funciona atrás de NAT/Render)
LOCAL PRINT AGENT (print-agent — Machine Identity + Nonce Anti-Replay)
       │
       ├──► EscPosRenderer (ESC/POS 80mm/72mm/58mm, CP850, QR GS(k, GS k, Cut)
       ├──► ZplRenderer    (ZPL II ^XA..^XZ, EAN-8/UPC-A/EAN-13/GTIN-14/Code128, ^PQ)
       ├──► Epl2Renderer   (EPL2 N..P<n>, B/A, sanitizado contra injeção)
       └──► TextRenderer   (Texto colunar 48 col / Dry-Run Outbox)
       │
       ▼
IMPRESSORA FÍSICA (Windows Spooler RAW / CUPS lp -o raw / TCP JetDirect :9100)
```

### Invariantes Arquiteturais Imutáveis
1. **Backend é autoridade exclusiva**: componentes React enviam apenas intenção (`venda_id`, `documento_id`, `produto_id`, `copies`, `terminal`). Preços, subtotais, descontos, impostos, troco e códigos de barras são reconstruídos no servidor a partir do banco.
2. **Isolamento multiempresa (`empresa_id`)**: aplicado na criação, leitura, listagem, claim, heartbeat, descoberta de impressoras, configuração de terminais, reimpressão e auditoria. Acesso cruzado responde `404` sem vazar metadados.
3. **HTTP 200 de criação ≠ impresso fisicamente**: enfileirar cria job `QUEUED`. Somente a confirmação autenticada do agente local após entrega ao spooler/socket transiciona para `PRINTED`.
4. **Venda nunca reverte por falha de impressão**: no PDV (`POST /api/pdv/vendas`), o enfileiramento do cupom ocorre fora da transação `SERIALIZABLE` da venda. Falha de fila/impressora mantém a venda faturada e expõe contingência imediata (`HTML`/`PDF`).

---

## 2. Máquina de Estados e Garantias de Entrega (`at-least-once` + Journal)

### Estados Físicos (`print_jobs.status`)
- `QUEUED`: aguardando reivindicação (`next_attempt_at <= now`).
- `CLAIMED`: reservado atomicamente por 1 agente (`lease_token_hash`, `lease_expires_at = +45s`).
- `PRINTING`: agente iniciou renderização e envio físico ao spooler/TCP.
- `PRINTED`: confirmação recebida do agente (`printed_at`). Estado terminal imutável.
- `FAILED`: erro permanente (`INVALID_EAN`, `UNSUPPORTED_PROTOCOL`, `LEASE_EXPIRED_MAX_ATTEMPTS`) ou tentativas esgotadas (`attempts >= max_attempts`).
- `CANCELLED`: cancelado manualmente por operador/gerente autorizado (`cancelled_at`).

### Política Explícita contra Duplicação Física (P6.4)
- **Criação lógica (`exactly-once` por chave)**: índice único parcial `(empresa_id, idempotency_key)` garante que refresh de navegador, duplo clique ou retry HTTP devolvam o mesmo job (ou `409` se o payload divergir). No PDV, o cupom automático usa chave determinística `recibo:pdv:venda:<id>` e a venda aceita `idempotency_key` (`uq_vendas_empresa_idempotency`).
- **Entrega física (`at-least-once` mitigada por Journal Local)**: antes de chamar `POST /api/print/agent/jobs/:id/printed`, o `print-agent` grava `jobId` em disco (`printed-journal.log`). Se a rede cair antes do ACK e o lease expirar, ao re-reivindicar o job o agente detecta a entrada no journal e apenas reenvia o ACK `printed (deduplicado=true)` **sem acionar a impressora novamente**.
- **Janela residual documentada**: apenas se a máquina física desligar/travar nos milissegundos entre os bytes saírem na porta USB/TCP e o `fsync` do `printed-journal.log`, outro agente poderá reexecutar após expirar o lease de 45s.
- **Retry vs Reimpressão**:
  - *Retry automático/manual*: atua no mesmo `public_id` quando ainda não houve confirmação física (`FAILED` → `QUEUED`).
  - *Reimpressão*: cria um **novo registro `print_jobs`** com novo `public_id`, `reprint_of` apontando para o job raiz original, `reprint_reason` opcional, `requested_by` do autor e evento dedicado na cadeia de auditoria. Jobs `PRINTED` jamais voltam para `QUEUED`.

---

## 3. Fases Entregues (P2 a P6)

### P2 — Impressão Térmica no PDV (`recibo_pdv` + ESC/POS)
- Persistência aditiva em `vendas` (`idempotency_key`, `pdv_valor_recebido`, `pdv_troco`, `pdv_operador_id`) e `pdv_pagamentos` (`valor_informado`), preservando intacto o cálculo líquido da gaveta (`resumoCaixa`).
- Enfileiramento automático não-bloqueante pós-venda e endpoints:
  - `POST /api/pdv/vendas/:id/cupom`
  - `POST /api/pdv/vendas/:id/reimprimir` (respeita `allow_operator_reprint` do terminal)
  - `GET /api/pdv/vendas/:id/cupom/html` e `GET /api/pdv/vendas/:id/cupom/pdf`
- `EscPosRenderer`: inicialização `ESC @`, página `CP850` (`ESC t 2`), tabelas proporcionais (`32`/`42`/`48` colunas), QR Code nativo `GS ( k` Model 2, código de barras `GS k`, avanço e corte parcial `GS V 66 0`.

### P3 — Documentos Imprimíveis do ERP
- Reconstrução canônica `documento → PrintIR` a partir do banco para 6 entidades existentes:
  1. Pedidos de Venda (`vendas` → `docType='pedido'`)
  2. Pedidos de Compra (`compras` → `docType='compra'`)
  3. Propostas Comerciais / Orçamentos (`propostas` → `docType='orcamento'`)
  4. Cotações de Compra (`cotacoes-compra` → `docType='orcamento'`)
  5. Ordens de Produção (`ordens` → `docType='ordem_producao'`)
  6. Fichas Cadastrais de Usuário (`usuarios` → `docType='ficha_usuario'`, restrito a admin, sem hashes/segredos)
- Rotas unificadas: `POST /api/print/documentos/:tipo/:id`, `POST /api/print/documentos/:tipo/:id/reimprimir`, `GET .../html` e `GET .../pdf`.

### P4 — Etiquetas de Produto (`ZPL II`, `EPL2` e Folha A4/Pimaco)
- Endpoints `POST /api/print/etiquetas` e `POST /api/produtos/:id/etiquetas` integrados ao modal `LabelSheet.tsx` sem remover o modo navegador A4/Pimaco.
- Validação matemática GS1 estrita (`EAN-8`, `UPC-A`, `EAN-13`, `GTIN-14`): dígito verificador incorreto retorna `422 INVALID_EAN` no servidor e erro permanente `INVALID_EAN` no agente — **o sistema jamais recalcula nem falsifica dígito verificador**. SKUs alfanuméricos internos usam `Code 128`.
- Lotes seguros: até `100` linhas por chamada, `200` unidades por variação e `500` etiquetas físicas totais por job (`cut.repeat` mapeado em ZPL `^PQ<n>` e EPL2 `P<n>`).

### P5 — Operação, Terminais Multi-Impressora e Central `/config/impressao`
- Tabela `print_terminals` (`0038_print_p2_p6.sql`): vincula cada posto (`CAIXA-01`, `EXPEDICAO`, etc.) a agente preferencial e impressoras dedicadas de **recibo** (`escpos`/`text`), **etiqueta** (`zpl`/`epl2`/`a4`), **documento** (`pdf`/`escpos`/`text`) e modo de contingência.
- Central Operacional em `/config/impressao`: KPIs em tempo real, fila com filtros (`status`, `doc_type`, `terminal`, `reprint_only`, período, busca textual), inspeção de `PrintIR`, página de teste por terminal, pareamento 1-clique com `127.0.0.1:17831`, rotação/revogação/reativação de credenciais (exibição única do segredo) e trilha de auditoria.

### P6 — Segurança, Recuperação, Retenção e Observabilidade
- **Sanitização anti-injeção por camada**:
  - *ESC/POS*: filtra bytes `0x00..0x1F` e `0x7F` de textos livres (impede abertura indevida de gaveta `ESC p` ou corte forçado).
  - *ZPL II*: aplica `^FH_` convertendo `^` → `_5E`, `~` → `_7E`, `_` → `_5F` (impede injeção `^XZ^XA`).
  - *EPL2*: remove aspas `"`, `\` e quebras `\r/\n` de campos `A`/`B` (impede injeção de comando `P9999`).
  - *HTML Fallback*: escape completo (`&`, `<`, `>`, `"`, `'`) + cabeçalho `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox allow-modals`.
  - *Spooler / Outbox*: `isSafePrinterName` e `sanitizePrinterTarget` bloqueiam metacaracteres/flags (`;`, `|`, `$()`, `` ` ``, `-o`, `..`) e usam `execFile` sem shell; `safeOutboxPath` confina saídas dry-run ao diretório base.
  - *Agente Loopback (`127.0.0.1:17831`)*: valida `Host` loopback (anti-DNS rebinding), `Origin` estrito do ERP e `Sec-Fetch-Site`.
- **Recuperação de órfãos e Poison-Pill**: `claimJob` e `recuperarJobsOrfaos` detectam jobs `CLAIMED`/`PRINTING` com lease vencido; quando `attempts >= max_attempts`, encerram em `FAILED` permanente (`LEASE_EXPIRED_MAX_ATTEMPTS`) sem loop infinito.
- **Política de Retenção (`limparFilaImpressaoPeriodica` em `sessoes.ts`)**:
  - Códigos de pareamento expirados/usados há `> 24h`: removidos.
  - Nonces anti-replay com `> 24h`: removidos.
  - Jobs terminais (`PRINTED`, `CANCELLED`, `FAILED` permanentes) com `> 90 dias` (configurável via `PRINT_JOBS_RETENTION_DAYS`, mín. 7 dias): expurgados, preservando integralmente a trilha imutável em `auditoria`.

---

## 4. Instalação, Pareamento e Contingência na Loja

### Instalar e Parear o Agente Local
1. Na máquina do caixa/expedição (Node.js >= 18):
   ```bash
   cd print-agent
   npm ci && npm run build
   ```
2. No BroBond ERP, acesse **Configurações → Central de Impressão (`/config/impressao`) → Agentes Locais**:
   - Se o agente já estiver rodando localmente em `127.0.0.1:17831`, clique em **"Parear este computador com 1 clique"**; ou
   - Clique em **"Gerar código de pareamento"** e execute no terminal da máquina:
     ```bash
     BROBOND_ERP_URL=https://seu-erp.exemplo.com BROBOND_PRINTER_MODE=system node dist/index.js --pair XXXX-XXXX-XXXX
     ```
3. Em **Terminais & Impressoras**, cadastre o terminal (ex.: `CAIXA-01`), selecione as impressoras reportadas pelo agente para Cupom (`ESC/POS`) e Etiquetas (`ZPL`/`EPL2`) e clique em **Teste Recibo** / **Teste Etiqueta**.

### Operação em Contingência (Impressora ou Agente Offline)
- **PDV**: a venda conclui normalmente; no alerta pós-venda clique em **Cupom navegador** ou **Cupom PDF**. Assim que o agente voltar, jobs `QUEUED` são impressos automaticamente ou podem ser cancelados na Central de Impressão caso já tenham sido emitidos via contingência.
- **Documentos**: clique em **Fila de impressão → Contingência PDF / Imprimir no navegador**.
- **Etiquetas**: no modal de etiquetas do produto, selecione **Folha A4 — 3 colunas (Pimaco)** ou **Bobina 50×30 mm (Navegador)**.

---

## 5. Banco de Dados e Reversibilidade (`0038_print_p2_p6.sql`)

A migração `db/migrations/0038_print_p2_p6.sql` é estritamente aditiva e idempotente (`IF NOT EXISTS`):
- Cria `print_terminals` com `UNIQUE (empresa_id, codigo)` e `FK` para `empresas` e `print_agents (ON DELETE SET NULL)`.
- Adiciona `printer_protocol`, `reprint_reason` e `terminal_id` em `print_jobs` + índices compostos por `(empresa_id, source, source_ref)` e `(empresa_id, reprint_of)`.
- Adiciona `idempotency_key` e `pdv_terminal` em `vendas` (`uq_vendas_empresa_idempotency`) e `valor_recebido`/`troco` em `pdv_pagamentos`.

**Procedimento de reversão manual controlada (apenas homologação/contingência de banco):**
```sql
DROP INDEX IF EXISTS idx_print_jobs_reprint_of;
DROP INDEX IF EXISTS idx_print_jobs_empresa_source_ref;
ALTER TABLE print_jobs DROP COLUMN IF EXISTS terminal_id, DROP COLUMN IF EXISTS reprint_reason, DROP COLUMN IF EXISTS printer_protocol;
DROP TABLE IF EXISTS print_terminals;
DROP INDEX IF EXISTS uq_vendas_empresa_idempotency;
ALTER TABLE vendas DROP COLUMN IF EXISTS pdv_terminal, DROP COLUMN IF EXISTS idempotency_key;
ALTER TABLE pdv_pagamentos DROP COLUMN IF EXISTS troco, DROP COLUMN IF EXISTS valor_recebido;
DELETE FROM _migrations WHERE nome = '0038_print_p2_p6.sql';
```

