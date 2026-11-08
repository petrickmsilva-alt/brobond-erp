# ADR-0012 — Segurança e RBAC

* **Identificador:** ADR-0012
* **Título:** Segurança e RBAC no servidor
* **Status:** Aceita
* **Data:** 2026-11-07
* **Relacionados:** ADR-0004, `SECURITY-ARCHITECTURE.md`

## Contexto

Perfis admin/gerente/operador; RBAC declarado em `resources.ts` e aplicado por
`checkAccess`; MFA obrigatório para admin; segredos cifrados; auditoria com
cadeia de hashes.

## Problema

Padronizar autorização e proteção de dados sensíveis, sem depender do front.

## Decisão

1. **Toda ação protegida tem autorização no backend**; o front não é autoridade.
2. **RBAC por recurso/ação** (`minPerfil`, `adminOnly`, `minPerfilEscrita`,
   `ops`); guard próprio em handlers especializados.
3. **Carteira do representante** resolvida no servidor (fail-closed).
4. **MFA** obrigatório para admin; **step-up** para mutações sensíveis.
5. **Segredos** cifrados (AES-256-GCM); nunca em código/log.
6. **Auditoria** de operações relevantes com empresa/usuário/antes-depois.
7. **Não conceder acesso global** como solução para problema de autorização.

## Alternativas consideradas

- **RBAC só no front:** rejeitada (inseguro).
- **Permissões por usuário (granular):** rejeitada agora; perfis + recurso
  atendem e reduzem erro.

## Consequências

- Matriz de permissões por domínio (`RBAC-MATRIX.md`).
- Testes de acesso permitido e negado.

## Riscos

- Handler novo sem guard → coberto por auditoria de menu/rotas.
