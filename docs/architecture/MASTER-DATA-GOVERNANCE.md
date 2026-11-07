# MASTER-DATA-GOVERNANCE — governança do dado mestre

**Data:** 2026-11-07 · **Branch:** `architecture/fase-2-canonical-erp-data`
**Referência:** [`CANONICAL-DATA-MODEL.md`](CANONICAL-DATA-MODEL.md),
[`ENTITY-OWNERSHIP.md`](ENTITY-OWNERSHIP.md), ADR-0003, ADR-0004.

> **Regra central.** O cadastro mestre (produto, estoque, cliente, pedido,
> financeiro) tem **um dono** e **um caminho de escrita**. Canal externo publica
> e lê; **não** cria cadastro mestre paralelo.

---

## 1. Regras por modelo mestre

### Empresa e tenant
- Identidade em `empresas`; configuração em `configuracoes` (namespace de chave
  por empresa) e tabelas `*_configuracoes` quando a semântica é de domínio.
- Escopo de acesso por `usuario_empresas` (concessão) + `escopoDoAtor`.
- Regra de isolamento: nenhuma consulta multiempresa sem `empresa_id` (ver
  `TENANT-GOVERNANCE.md`).

### Usuários e permissões
- Usuário = identidade; **empresa = tenant** (não confundir).
- Papel: `operador` < `gerente` < `admin`; permissões comerciais
  (`perm_catalogos` etc.) e de preço (`perm_preco_tabela`) explícitas.
- Vínculo com representante quando aplicável; nunca recorte de empresa por
  `usuario_id`.

### Produtos
- Produto **pai** é dono do saldo e da venda; variação empresta SKU/cor/preço.
- Preserva semântica pai × variação (`variacoes.pai_id`).
- Códigos externos entram com **namespace** (loja/plataforma), nunca colidindo.

### Preços
- ERP é a autoridade (`preco_venda` / `preco_atacado`).
- `commerce_precos` = override autorizado por loja (base + canal + vigência).
- Preço de plataforma = evidência. **Proibido** backfill automático de preço
  externo sobre o cadastro.

### Estoque
- Fonte: `estoques` (saldo derivado) escrita **só** via `movimentacoes`.
- Reservas em `estoque_reservas` (`ativa` desconta; `liberada` não).
- Disponibilidade canônica em §2 do `CANONICAL-DATA-MODEL.md`.
- Proibido somar locais diferentes para "atender" uma venda.

### Clientes
- Cadastro mestre em `clientes`; documento único por empresa.
- Não criar cliente novo automaticamente quando houver correspondência segura e
  verificável; **não** fundir por semelhança de nome.
- Identificadores externos com namespace; histórico preservado.

### Pedidos e vendas
- Operacional: `vendas`/`itens_venda`. Analítico: `sales`/`sale_items`.
- Identidade de pedido externo = **empresa + canal + loja (`store_key`) +
  plataforma + id externo**. Lojas diferentes **não colidem** (ADR-0005).
- Conversão read model → operação é **idempotente** (outbox `conversao`).

### Financeiro e pagamentos
- Payment Engine é o mecanismo único (`payment_intents`→`attempts`→
  `settlements`→`refunds`→`disputes`).
- Distinguir: pedido ≠ cobrança ≠ pagamento ≠ liquidação ≠ estorno ≠ taxa ≠
  repasse ≠ conciliação.
- **Status de pedido não prova liquidação** — só `lancamentos_financeiros`.

### Comissões
- Livro em `comissoes_apuradas` + `comissoes_eventos` (ajustes); rastreável por
  representante, venda e recebimento. **Histórico nunca é apagado**.

### Logística
- Logistics Engine central; `envios` + `envio_eventos`; distingue cotação,
  frete, remessa, etiqueta, rastreamento, entrega, ocorrência.
- **Não duplicar** dado logístico em módulo novo.

## 2. Fluxo de escrita permitido (canal externo)

```
plataforma externa ──webhook/REST──▶ ingestão (valida assinatura + tenant)
   └─▶ sales/sale_items (read model, evidência)  ──outbox 'conversao'──▶
        vendas/itens_venda (operacional)  ──▶ estoque/financeiro/comissão
```

O canal **publica** (empurra catálogo/estoque/preço) e **importa** (puxa pedido);
em nenhum ponto ele escreve direto no cadastro mestre.

## 3. Regras de qualidade (aplicadas nesta fase)

1. Sem backfill cego: população identificada, quantificada, com rollback.
2. Sem alteração destrutiva em produção.
3. Constraint só depois de verificar os dados (`NOT VALID` + `VALIDATE`).
4. Código externo sempre com namespace.
5. Toda entidade multiempresa com `empresa_id` ou classificação explícita.

## 4. Critérios de aceite

1. Fonte oficial formalizada por entidade (§1).
2. Duplicidade classificada (operacional/projeção/cache/cópia/snapshot/legado).
3. Escrita mestre por caminho único.
4. Integridade referencial verificável (E4.2).
5. Teste por regra sensível (preço, estoque, identidade, projeção).
