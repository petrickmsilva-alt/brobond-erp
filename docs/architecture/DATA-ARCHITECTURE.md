# DATA-ARCHITECTURE — arquitetura de dados (Fase 0)

**Data:** 2026-11-07 · **Branch:** `architecture/fase-0-blueprint`
**Base:** `db/schema.sql`, `db/migrations/*.sql`, `prisma/schema.prisma`,
`docs/ESTOQUE-CANONICO.md`, `docs/ERP-3.0-MASTER-DATA-AUDIT.md`,
`docs/ERP-3.0-DUPLICITY-AUDIT.md`.

---

## 1. Princípios

1. **SQL-first.** `db/schema.sql` + `db/migrations/*.sql` são a referência
   estrutural oficial. `db/bootstrap.sql` é **gerado** por
   `scripts/gerar-bootstrap.mjs` e testado por `prod-db-02-bootstrap-sync`.
2. **Prisma é bounded context do commerce** (11 modelos, 5 com `empresaId`).
   Não migrar todo o banco para Prisma; não criar segunda fonte de verdade.
3. **Aditivo e idempotente.** Migrações nunca destrutivas; ordem léxica.
4. **Tabela nova entra em dois lugares:** migração **e** espelho em
   `schema.sql`.
5. **Derivado não é coluna.** Saldo, disponibilidade, custo, score, vencimento
   fiscal, atraso e ocupação são **calculados**, nunca gravados.

---

## 2. Modelo de dados (visão geral)

```
Empresa (tenant)
   │  empresa_id em toda tabela de negócio
   ├── Usuário × Empresa (usuario_empresas)  → autorização/contexto
   ├── PIM: produtos → variacoes · grades · tamanhos · cores · colecoes
   ├── WMS: locais → estoques (projeção) ← movimentacoes (evento)
   │        estoque_reservas · estoque_transferencias · inventarios
   ├── Commerce: commerce_produtos · commerce_publicacoes · commerce_precos
   ├── OMS: commerce_pedidos → vendas → itens_venda
   ├── Analítico: sales · sale_items (read model) · produto_abc
   ├── Payments: payment_* · gateway_cobrancas · gateway_webhook_events
   ├── TMS: envios · envio_eventos · logistics_*
   ├── Financeiro: lancamentos_financeiros · fin_extrato_* · cnab_*
   ├── Fiscal: documentos_fiscais · regras_fiscais · fiscal_execucoes
   ├── CRM: crm_leads · crm_oportunidades · crm_funis · crm_etapas
   └── Governance: auditoria · sessoes · segredos · configuracoes
```

---

## 3. Identidade canônica da célula de estoque

```
empresa_id + produto_id + tamanho_id + local_id
```

- `produto_id` é **sempre o produto pai** (a venda e o saldo pertencem ao pai;
  a variação empresta SKU/cor/preço).
- `tamanho_id` = coluna da grade (`NULL` = "sem tamanho").
- `local_id` = local dentro da empresa; a coluna texto `local` é compatibilidade
  histórica.
- Duas linhas que resolvem para a mesma identidade = dado corrompido → a leitura
  **falha fechada (409)** em vez de somar em dobro.

### 3.1 Físico × disponível

| Pergunta | Definição | Onde aparece |
|---|---|---|
| **Físico** | soma de todas as células do par (produto, tamanho) em **todos** os locais | Grade/Estoque Físico |
| **Disponível (vendável)** | o que **uma linha de venda** consegue baixar | PDV, Vendas, `/api/estoques/disponivel` |

```
Disponível = Físico − Reservas ativas − Compromissos − Bloqueios
```

Respeita **empresa × produto × tamanho × local**. **Não** somar locais
indiscriminadamente. Evidência: `server/src/estoqueCanonico.ts`, migration
`0052` (`estoque_reservas`).

---

## 4. Operacional × analítico

| Camada | Tabelas | Escrita | Leitura |
|---|---|---|---|
| **Operacional (ERP)** | `vendas`, `itens_venda`, `estoques`, `movimentacoes`, `lancamentos_financeiros` | CRUD, PDV, portal, conversão, ingestão | operação, telas |
| **Analítico (read model)** | `sales`, `sale_items`, `produto_abc` | ingestão + projeção `vendas → sales` | BI, painéis |

**Regras:** BI **não** altera operação; projeção **não** cria venda duplicada;
atualização **idempotente**; rastreabilidade da origem preservada
(`sales.operational_venda_id`); escopo de empresa em todo relatório.

---

## 5. Estratégia de migração e integridade

| Tema | Regra |
|---|---|
| Nomeação | `NNNN_descricao.sql` (ordem léxica), Prisma em `prisma/migrations/` |
| Idempotência | `IF NOT EXISTS` / `ON CONFLICT` / `DO $$` |
| Compatibilidade | aditiva; nunca remover coluna/tabela/índice sem plano |
| Constraints | `NOT VALID` quando os dados legados podem violar (validar depois) |
| Índices | só para consultas quentes reais (ex.: CRM `0050`) |
| Chaves estrangeiras | FK composta por empresa no padrão E4.2 (`uq_e42_*`) |
| Rollback | migração aditiva é reversível por não-uso; destrutiva exige plano |
| Integridade referencial | validar referências entre tenants (`validarReferenciasDaEmpresa`) |

Detalhe: [`DATABASE-MIGRATION-STANDARD.md`](DATABASE-MIGRATION-STANDARD.md) (Fase 1).

---

## 6. Dados sensíveis e cifra

- Segredos de integração são cifrados (AES-256-GCM) em `configuracoes`
  (`server/src/segredos.ts`, `chavesCifra.ts`). Nunca em claro, nunca em log.
- `auditoria` é append-only com cadeia de hashes (`auditChain.ts`).
- Anexos herdam o tenant do registro-pai (`arquivos` sem `empresa_id`).

---

## 7. Tabelas sem `empresa_id` (classificação)

Segundo o baseline, **28** das 212 tabelas não têm `empresa_id`. Classes:

| Classe | Exemplo | Isolamento |
|---|---|---|
| **Global** | `tamanhos`, `cores`, `grades`, `categorias` | catálogo compartilhado por desenho |
| **Compartilhada / referência** | `municipios`, `feriados` | dados de referência |
| **Escopo derivado** | `arquivos` (herda do pai), `itens_venda` (herda da venda) | FK ao dono |
| **Infraestrutura** | `schema_migrations`, `cron_locks` | sem dado de negócio |
| **Tenant-owned sem isolamento adequado** | — | **não identificado** (auditar na Fase 1) |
| **Indefinida** | — | **não identificado** (auditar na Fase 1) |

A Fase 1 (`TENANT-GOVERNANCE.md`) audita e formaliza cada caso.

---

## 8. Gaps de dados (herdados)

| ID | Descrição | Nível |
|---|---|---|
| GAP-P2-04 | Integridade cross-tenant de `crm_*` no banco (só FK simples) | P2 |
| GAP-P3-04 | `insumos.unidade` texto livre | P3 |
| GAP-P3-07 | MRP sem unidade de medida por componente | P3 |
| GAP-P2-13 | Plano de contas sem importação em massa | P2 |

---

*Próximo documento: [`INTEGRATION-ARCHITECTURE.md`](INTEGRATION-ARCHITECTURE.md).*
