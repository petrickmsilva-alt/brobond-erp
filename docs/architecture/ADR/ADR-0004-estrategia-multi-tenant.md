# ADR-0004 — Estratégia multi-tenant (`empresa_id`)

* **Identificador:** ADR-0004
* **Título:** Estratégia multi-tenant por `empresa_id`
* **Status:** Aceita
* **Data:** 2026-11-07
* **Relacionados:** ADR-0012

## Contexto

O ERP atende múltiplas empresas (tenants). Já existe o kernel `empresa.ts` com
recorte obrigatório, 404 cross-tenant, carimbo e validação de referências.

## Problema

Garantir isolamento real entre empresas sem confiar em valores enviados pelo
cliente.

## Decisão

1. **Empresa = tenant; usuário = identidade.** `usuario_empresas` = concessões.
2. A empresa ativa é resolvida do **ator + sessão (claim `emp`) + concessão** —
   **nunca** do corpo/query.
3. Listagem de recurso com escopo recebe filtro `empresa_id` obrigatório; o
   `?f.empresa_id` do cliente é **descartado**.
4. Acesso por ID de outra empresa responde **404**.
5. Empresa é **carimbada** na criação e **imutável** na edição.
6. Referências (`type: 'ref'`) validadas contra o mesmo tenant.
7. Consolidação (`pode_consolidar`) é **somente leitura**.

## Alternativas consideradas

- **Schema/database por tenant:** rejeitada. Custo operacional alto e sem
  requisito; o modelo atual é provado por testes.
- **Confiar em `empresa_id` do cliente:** rejeitada (inseguro).

## Consequências

- Tabelas globais (catálogo) não têm `empresa_id` — por desenho.
- Testes negativos A×B obrigatórios para todo recurso multiempresa.

## Riscos

- Tabela sem `empresa_id` indevidamente → auditada na Fase 1
  (`TENANT-GOVERNANCE.md`).
