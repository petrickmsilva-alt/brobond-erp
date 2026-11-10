# RBAC TEST MATRIX — Fase 9.6

**Data:** 2026-11-09 · **Branch:** `architecture/fases-9-4-9-5-9-6`

Prova de que a autorização vive no **backend**. Ocultar botão no frontend **não**
conta como segurança. A matriz de recursos é gerada de `server/src/resources.ts`
(ver `docs/architecture/RBAC-MATRIX.md`).

## 1. Perfis (os existentes — nenhum perfil novo foi inventado)

| Perfil | Rank | Regra geral |
|---|---|---|
| `admin` | 3 | Lê tudo; escreve onde `ops` permite |
| `gerente` | 2 | Lê/opera o que exige gerente; barrado no que exige admin |
| `operador` | 1 | Barrado onde exige gerente/admin; **nunca** exclui |

O perfil vem **sempre** da identidade autenticada — nunca de `role`/`perfil`/
`empresa_id` enviados pelo cliente (`sec04-catalogo-compartilhado-rbac.test.ts`).

## 2. Matriz de ações × recursos sensíveis

| Garantia | Teste |
|---|---|
| admin lê todos os recursos | `rbac-matrix.test.ts` |
| gerente lê os recursos de gerente; operador **não** | `rbac-matrix.test.ts` |
| recursos de admin barram gerente e operador | `rbac-matrix.test.ts` |
| operador lê os recursos abertos; **nunca exclui** | `rbac-matrix.test.ts` |
| catálogo global: operador lê, não escreve | `sec04-catalogo-compartilhado-rbac.test.ts` |
| comercial é fail-closed para operador sem permissão | `rbac-matrix.test.ts` |
| spoofing de role/perfil/empresa_id não eleva privilégio | `sec04-catalogo-compartilhado-rbac.test.ts` |
| plano de contas exige gerente (operador → 403) | `pg/fase9-6-enterprise-validation.test.ts` (B) |
| rotas administrativas exigem alçada por HTTP | `pg/sec03-admin-routes-authorization.test.ts` |
| escopo de carteira (representante) | `representantes-pg.test.ts`, `multiempresa-p1.test.ts` |

## 3. Cobertura desta fase

- **185 recursos** declaram `minPerfil`/`ops`; **83** exigem gerente; **7** exigem
  admin/adminOnly; **90** são somente leitura; **166** são multiempresa.
- Fase 9.5 acrescentou `fiscal_layouts` (minPerfil `gerente`, somente leitura).
- Fase 9.4 não criou recurso de escrita: o painel de canais é **leitura**
  (`GET /api/commerce/canais`).

## 4. Resultado

- **0** falhas de RBAC conhecidas em aberto.
- Nenhuma vulnerabilidade crítica introduzida no diff (segredos ausentes do
  diff — ver `docs/auditoria/matriz-configuracao-producao.md`).
