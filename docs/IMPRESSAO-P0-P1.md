# IMPRESSÃO — P0 (Fundação) + P1 (Agente Local)

Programa de impressão profissional do BroBond ERP. Este documento registra o
mapeamento, as decisões e o que foi entregue nas fases P0 e P1.

```text
ERP ──► PrintIR ──► Print Queue (print_jobs) ──► Claim/Lease ──► Agente Local ──► Renderer ──► Impressora
```

Nada nas fases P0/P1 altera estoque, venda, baixa ou financeiro, e nenhuma
impressão existente foi removida: navegador/PDF continua sendo o caminho
visível hoje; a fila e o agente são a fundação sobre a qual P2 (ESC/POS),
P3 (PDV) e P4 (ZPL/EPL2) serão construídos.

> **Evolução completa P2..P6 entregue:** consulte [`docs/IMPRESSAO-P0-P6.md`](./IMPRESSAO-P0-P6.md) para a arquitetura completa de Recibos PDV (`ESC/POS`), Documentos ERP, Etiquetas Térmicas (`ZPL II` / `EPL2`), Central Operacional (`/config/impressao`), Terminais multi-impressora e Hardening P6.

---

## 1. Mapeamento do que já existia (antes do P0)

| Fluxo | Onde | Como imprimia |
|---|---|---|
| Etiquetas de produto | `client/src/components/LabelSheet.tsx` | `window.open` + HTML (A4 3 colunas / bobina 50×30), `w.print()` chamado da janela pai (padrão CSP-seguro) |
| Pedido de venda (PDF) | `client/src/pages/OrderPage.tsx` → `GET /api/vendas/:id/pdf` (`server/src/pdf.ts`) | PDF no servidor (pdfkit) em nova aba |
| Pedido de compra (PDF) | idem → `GET /api/compras/:id/pdf` | idem |
| Ficha do usuário | `client/src/lib/fichaPrint.ts` | `window.open` + HTML com **`onload="window.print()"`** — bloqueado pela CSP (corrigido no P0 §8) |
| Tabela de medidas | `client/src/pages/MedidasPage.tsx` | `window.open` + `w.print()` da pai (já seguro) |
| Portal do cliente | `client/src/pages/PortalCliente.tsx` | `window.print()` da própria página |
| Código de barras | `client/src/lib/barcode.ts` | EAN-8/13 e Code 128 em SVG; `eanCheckDigit` existia mas **não validava o cadastro** |
| PDV | `server/src/pdv.ts`, recurso `pdv_caixas` | **sem impressão** (recibo é P3) |

Padrões existentes reutilizados (não reinventados):

- **Store genérico + `resources.ts`** como fonte de verdade de tabelas/colunas (pg + memória com a mesma semântica);
- **`tryUpdateIf`** (UPDATE condicional) como primitivo de concorrência — o claim é construído sobre ele;
- **Idempotência `(empresa_id, idempotency_key)`** de `documentos_fiscais`/fiscal.ts, adaptada (ver §3);
- **Auditoria encadeada** (`auditChain.ts` via `store.audit`) — nenhuma trilha paralela foi criada;
- **Multiempresa** (`empresa.ts`: escopo derivado do ator, nunca do corpo) e **RBAC** (`checkFluxo`, `requireRole`);
- **Migrations versionadas** `db/migrations/*.sql` idempotentes, espelhadas em `db/schema.sql`.

Nada existia de: PrintIR, fila de impressão, agente local, machine token,
ESC/POS, ZPL/EPL2, integração direta com impressora.

---

## 2. PrintIR — o contrato

Fonte canônica: **`packages/domain/src/print/print-ir.ts`** (tipos +
`validatePrintIR` puro, `PRINT_IR_VERSION = 1`). Descreve a *intenção* de
impressão, nunca bytes de impressora:

- envelope: `jobId` (UUID), versão, `tenantId`/`companyId`, `requestedBy`,
  `terminal`, `printerName`, `source`, `docType`, `related`, `copies`,
  `priority`, `idempotencyKey`, `createdAt`;
- conteúdo em **blocos semânticos**: `text`, `kv`, `table`, `barcode`,
  `qrcode`, `separator`, `spacer`, `cut` — com dicas (`align`, `emphasis`,
  `size`) que cada renderer traduz. Bloco desconhecido = erro de validação;
  o contrato cresce por versão, não por improviso.

O mesmo PrintIR alimenta browser/PDF (hoje), ESC/POS (P2) e ZPL/EPL2 (P4).
O agente revalida versão/forma e recusa com erro permanente (`IR_VERSION`)
o que não conhece — nunca "imprime mesmo assim".

## 3. Fila — `print_jobs` (migration 0037)

Estados: `QUEUED → CLAIMED → PRINTING → PRINTED | FAILED | CANCELLED`
(com CHECK no banco; job em voo exige dono + lease; `PRINTED` exige data).

- **Claim atômico:** `tryUpdateIf` com `{status esperado, agente/lease
  esperados}` dentro de transação **READ COMMITTED** — nesse nível o UPDATE
  espera o lock e reavalia o WHERE, então o perdedor afeta 0 linhas. (No
  padrão SERIALIZABLE do store ele lançaria 40001; provado e corrigido
  contra Postgres real — `server/test/pg-print.test.ts`.)
- **Lease:** `lease_expires_at` + `lease_token_hash` (o token só aparece uma
  vez, na resposta do claim; no banco fica o SHA-256). Agente morto ⇒ lease
  vence ⇒ job volta a ser candidato com `attempts+1`; acks tardios com o
  lease velho são recusados (409).
- **Retry:** falha transitória ⇒ `QUEUED` com `next_retry_at` em backoff
  exponencial (5 s × 2ⁿ, teto 5 min, `max_attempts` padrão 3). Códigos
  permanentes (`IR_INVALID`, `IR_VERSION`, `RENDER_UNSUPPORTED`,
  `PRINTER_NOT_FOUND`) ⇒ `FAILED` direto. Retry manual zera as tentativas.
- **Reimpressão** é sempre um job **novo** (`reprint_of` → origem): o
  original `PRINTED` nunca ressuscita.
- **Idempotência:** `UNIQUE (empresa_id, idempotency_key)` + `content_hash`
  (SHA-256 do JSON canônico do conteúdo). Mesma chave + mesmo conteúdo ⇒
  devolve o job existente (`idempotente: true`); mesma chave + conteúdo
  diferente ⇒ **409**. Diferente do fiscal (onde a chave é opcional e
  protege a emissão de um documento), aqui a chave é **obrigatória**
  (`NOT NULL`) porque o que se protege é um ato físico irreversível;
  quando o cliente não envia chave, o servidor gera um UUID — criação
  válida, mas um retry sem chave é, por definição, um novo pedido.
- **Índices:** claim `(empresa_id, status, priority DESC, criado_em, id)`,
  terminal parcial, lease parcial, público único (`public_id` UUID).

## 4. Agente local e machine identity (P1)

Projeto: **`print-agent/`** (Node ≥ 18, zero dependências de runtime).

- **Pareamento:** gerente/admin gera no ERP um código temporário (uso único,
  10 min, só o hash no banco, rate-limit por IP); o agente o troca por
  `machine_id` + **token de máquina revogável** (mostrado uma vez, hash
  SHA-256 no servidor). O JWT de usuário **não** é credencial do agente.
- **Autenticação:** `Authorization: Bearer <machine token>` +
  `x-print-machine-id`; chamadas mutantes exigem `x-print-nonce` (único por
  agente — replay é 409) e `x-print-timestamp` (± 5 min).
- **Revogação** gira o hash para um valor inalcançável, marca `revogado` e
  expira na hora os leases do agente (outro assume os jobs). Rotação de
  token também existe (gerente+).
- **Polling** (Agent → ERP) com backoff + jitter: a Render pode hibernar e
  a loja pode estar atrás de NAT; o servidor nunca inicia a conversa.
- **Anti-duplicação física:** o agente grava o job no **journal local**
  (`printed-journal.log`) *antes* do ack. Crash entre imprimir e confirmar
  ⇒ lease expira ⇒ job volta ⇒ journal constata ⇒ confirma
  `PRINTED` com `deduplicado: true` sem imprimir de novo. Claim é
  at-least-once; impressão física, effectively-once por máquina.
- **API local** mínima em **`127.0.0.1:17831`** (`/health`, `/status`,
  `/pair`): bind loopback explícito, `Origin` precisa ser a do ERP
  (protege contra site qualquer aberto no mesmo navegador), preflight de
  Private Network Access só para essa origem, nenhum segredo sai por ela.
- **Configuração:** `agent-config.json` (URL do ERP, machine id, terminal,
  polling, impressora padrão) e `machine-token` em arquivo separado
  restrito (0600 onde suportado; no Windows, `%LOCALAPPDATA%\BroBond\
  PrintAgent`). *Hardening futuro registrado:* DPAPI/Credential Manager.
- **Dry-run por padrão:** na P1 o printer escreve `outbox/<jobId>.txt`
  (renderer `text`). ESC/POS (P2) e ZPL/EPL2 (P4) entram pela interface
  `Renderer`/`Printer` sem tocar fila, lease ou journal.

## 5. Segurança — resumo

| Ameaça | Defesa |
|---|---|
| Job de outra empresa | Toda query filtra `empresa_id` do ator (usuário) ou da machine identity (agente); detalhe de outra empresa é 404 |
| Operador mexendo no job alheio | Ownership: operador só vê/cancela/retenta os próprios; gerente/admin, os da empresa |
| Criar agente sem autoridade | Pareamento, lista, revogação e rotação exigem gerente/admin (`requireRole`) |
| Token de máquina vazado | Só hash no servidor; revogável/rotacionável com efeito imediato |
| Replay de chamada do agente | Nonce único + janela de timestamp (409/400) |
| Impressão duplicada (refresh/retry/reconexão/reinício) | Idempotency-Key única por empresa + content_hash; claim exclusivo; lease; journal local |
| Ack forjado de outro agente | Prova de posse do `lease_token` (hash comparado em tempo constante) |
| Falsificar status pelo CRUD genérico | Recursos `internal` com `ops: READ_ONLY`; escritas só pelos handlers da fila/agentes |
| Vazar hashes | Mappers públicos removem `token_hash`/`lease_token_hash`/`content_hash` de toda resposta |
| Site estranho falando com o agente | API local só aceita `Origin` do ERP; PNA preflight restrito |
| Auditoria adulterada | Eventos `acao: 'imprimir'` na cadeia SHA-256 existente (`auditChain.ts`), com `dados.evento` fino (`print.job.created`, `claimed`, `printed`, `failed`, `retry_scheduled`, `cancelled`, `reprinted`, `print.agent.paired/revoked`, …) |

### CSP

`connect-src` ganhou **uma** origem: `http://127.0.0.1:17831` (literal, sem
wildcard, sem `localhost` genérico, nada de rede local). Ela serve apenas à
consulta opcional de status do agente pelo navegador — o caminho de
impressão (polling do agente) não passa pelo navegador. Sobre
`upgrade-insecure-requests` (ativo em produção): ele promove requisições
HTTP para HTTPS, mas 127.0.0.1 é *potencialmente confiável* pelos
navegadores (o agente não pode ter certificado público) — e, se algum
navegador bloquear a consulta de status, a impressão **não é afetada**.
Nenhuma outra diretiva foi afrouxada.

## 6. EAN/GTIN (P0 §7)

`eanCheckDigit` (já existente no desenho da etiqueta) agora valida o
cadastro: `server/src/ean.ts` (autoridade — via flag `gtin` do campo em
`resources.ts` + `validate.ts`) e espelho no cliente
(`barcode.ts`/`produtos.ts`). Cobre EAN-8 (GTIN-8), UPC-A (GTIN-12),
EAN-13 (GTIN-13) e EAN-14 (GTIN-14) — o algoritmo GS1 é o mesmo para os
quatro comprimentos. **SKU interno não é EAN**: continua texto livre,
imprime em Code 128 e nunca passa por essa validação. Efeito consciente:
um produto já cadastrado com dígito errado passa a exigir correção do
código na próxima edição que reenvie o campo (a mensagem explica o dígito
verificador). Amostras inválidas que existiam em testes
(`7891234567890`, `12345678`…) foram trocadas por GTINs válidos.

## 7. fichaPrint (P0 §8)

Removido o `onload="window.print()"` (bloqueado por `script-src 'self'`);
o disparo agora vem da janela pai com `setTimeout + win.print()` — o mesmo
padrão de `LabelSheet`/`MedidasPage`. Teste garante que o HTML gerado não
contém handler inline nem `<script>`.

## 8. API

Usuário (JWT existente):

```text
POST /api/print/jobs                      enfileira (Idempotency-Key ou body.idempotency_key)
GET  /api/print/jobs?status=              lista (operador: os seus)
GET  /api/print/jobs/:public_id           detalhe + PrintIR
POST /api/print/jobs/:public_id/cancelar
POST /api/print/jobs/:public_id/retry     (FAILED → QUEUED)
POST /api/print/jobs/:public_id/reimprimir
POST /api/print/pairing                   (gerente+) código de pareamento
GET  /api/print/agents                    (gerente+)
POST /api/print/agents/:machine_id/revogar          (gerente+)
POST /api/print/agents/:machine_id/rotacionar-token (gerente+)
```

Agente (machine identity, antes do `requireAuth` de usuário):

```text
POST /api/print/agent/pair
POST /api/print/agent/heartbeat
POST /api/print/agent/claim
POST /api/print/agent/jobs/:public_id/printing | printed | fail | lease
```

Cliente (navegador): `client/src/lib/printAgent.ts` —
`enfileirarImpressao`, `cancelarImpressao`, `detectarAgenteLocal`,
`novaChaveIdempotencia`. As telas passam a usá-los nas fases P2/P3; a
impressão atual do navegador/PDF permanece intacta.

## 9. Banco

Migration `db/migrations/0037_print_p0_p1.sql` (espelhada em
`db/schema.sql`), idempotente, sem tocar tabelas existentes:
`print_jobs`, `print_agents`, `print_pairing_codes`, `print_agent_nonces`
(+ índices/constraints listados no cabeçalho da migration; rollback manual
documentado nela). `auditoria.acao` é TEXT sem CHECK — o novo valor
`imprimir` não exigiu DDL.

## 10. Testes

- `server/test/print-p0p1.test.ts` — PrintIR, fila, idempotência, claim,
  lease, backoff, terminal, tenant isolation, ownership, reimpressão,
  revogação, replay/nonce, auditoria íntegra.
- `server/test/pg-print.test.ts` — Postgres real: claim concorrente com um
  vencedor só + criação concorrente idempotente (roda no CI
  `testes-postgres`; validado localmente com Postgres embarcado).
- `server/test/ean.test.ts`, `client/src/lib/barcode.test.ts` — EAN válido/
  inválido/dígito/tamanho/SKU interno, servidor e cliente.
- `client/src/lib/fichaPrint.test.ts` — sem inline, imprime pela pai.
- `print-agent/test/agent.test.ts` — backoff, journal/dedupe, runner,
  loopback+Origin, config/token, conformidade de versão com o domínio.
- Smoke E2E manual sobre HTTP real: login+MFA → pairing → job → agente
  (binário compilado) imprime em dry-run → `PRINTED`.

## 11. Fora de escopo (próximas fases)

- **P2:** renderer ESC/POS + printers rede/USB/serial no agente; descoberta
  de impressoras; instalador Windows (serviço/tray) e DPAPI para o token.
- **P3:** recibo do PDV via fila (sem tocar cálculo/baixa existentes);
  tela da fila/agentes no ERP.
- **P4:** ZPL/EPL2 para etiquetas (o `LabelSheet` atual continua até lá).
- Limpeza periódica de `print_agent_nonces` antigos e de jobs terminais
  (retenção) — job de manutenção futuro; hoje nada é apagado.
