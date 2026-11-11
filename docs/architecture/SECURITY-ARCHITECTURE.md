# SECURITY-ARCHITECTURE — segurança (Fase 0)

**Data:** 2026-11-07 · **Branch:** `architecture/fase-0-blueprint`
**Base:** `server/src/security.ts`, `auth.ts`, `empresa.ts`, `mfa.ts`, `totp.ts`,
`segredos.ts`, `chavesCifra.ts`, `auditChain.ts`, `politicaSenha.ts`,
`docs/AUTENTICACAO.md`, `docs/RELATORIO-SEC-*.md`.

---

## 1. Modelo de segurança

```
Usuário (identidade) ──autentica──► Sessão (JWT) ──claim emp──► Empresa ativa (tenant)
        │                                   │
        └── usuario_empresas (concessões) ──┘
                                            │
                          RBAC (perfil × recurso × ação) no SERVIDOR
                                            │
                       Auditoria (empresa, usuário, antes/depois, hash-chain)
```

**Invariantes:**
- O tenant **nunca** vem do cliente (corpo/query); vem do ator + sessão + concessão.
- Acesso a recurso de outra empresa responde **404** (não vaza existência).
- RBAC é aplicado no **backend**; o front não é autoridade de autorização.
- Empresa é **carimbada** na criação e **imutável** na edição.

---

## 2. Autenticação

| Mecanismo | Detalhe | Evidência |
|---|---|---|
| Login | e-mail + senha (hash) | `auth.ts` |
| MFA (TOTP) | obrigatório para **admin**; códigos de recuperação | `mfa.ts`, `totp.ts`, `mfaBackup.ts` |
| Política de senha | validada no servidor (medidor público) | `politicaSenha.ts` |
| Bloqueio | manual (admin) ou temporário por tentativas | `auth.ts` |
| Reautenticação (step-up) | para mutações sensíveis | `ReauthModal` + `code: 'reauth_necessaria'` |
| Sessões | JWT com claim `emp`; logout/expiração | `sessoes.ts`, `auth.ts` |
| Agente de impressão | machine identity (pareamento + nonce anti-replay) | `printAgents.ts` |
| Login de emergência | banco indisponível + credenciais do admin | `auth.ts` |

**Fail-closed:** em produção, ausência de `JWT_SECRET`/`ADMIN_PASSWORD` fortes
aborta a inicialização (`security.ts`, testes `auth-fail-closed`).

---

## 3. Autorização (RBAC)

- Perfis: **admin · gerente · operador** (`auth.ts` `Perfil`).
- Regras por recurso em `resources.ts`: `minPerfil`, `adminOnly`,
  `minPerfilEscrita`, `ops` (fechar create/update/delete).
- `checkAccess` aplica a alçada (leitura × escrita) no servidor.
- **Carteira do representante** (A06-14): recorte resolvido no servidor; admin/
  gerente não são recortados; operador sem vínculo não acessa comissão alheia.
- Evidência: `server/src/services.ts`, testes `agente07-*`, `audit:menu`.

Detalhe formal: [`RBAC-MATRIX.md`](RBAC-MATRIX.md) (Fase 1).

---

## 4. Multi-tenancy

- `empresa_id` em toda tabela de negócio; kernel `empresa.ts` aplica recorte.
- Tabelas globais (catálogo) não têm `empresa_id` — por desenho.
- Anexos herdam tenant do pai.
- Webhooks/gateways resolvem empresa pelo conector/cobrança.
- Testes negativos A×B: `multiempresa-nominal`, `tenant-isolamento-3-0`,
  `arquivos-privados-segregacao-empresa`.

Detalhe formal: [`TENANT-GOVERNANCE.md`](TENANT-GOVERNANCE.md) (Fase 1).

---

## 5. Segredos

- Cifra **AES-256-GCM** (`chavesCifra.ts`), armazenados em `configuracoes`.
- Nunca em código, doc, commit ou log (`credential-scan.test.ts`).
- Chave de cifra via variável de ambiente; rotação documentada
  (`docs/seguranca/plano-migracao-segredos.md`).

---

## 6. Auditoria

- `auditoria` com empresa, usuário, ação, recurso, id, data/hora, antes/depois.
- **Cadeia de hashes** (tamper-evidence): editar/remover um evento quebra a cadeia
  (`auditChain.ts`, `verificarCadeiaAuditoria`).
- Auditoria gravada **na mesma transação** do fato.
- Nunca registra senha/token/segredo.

Detalhe formal: [`AUDIT-STANDARD.md`](AUDIT-STANDARD.md) (Fase 1).

---

## 7. Superfície HTTP

| Controle | Implementação |
|---|---|
| CORS restrito | `security.ts` (produção, same-domain) |
| Headers de proteção | `security.ts` |
| Rate limit de login | persistente por IP + e-mail (`login_tentativas`) |
| Rate limit público | por rota pública (catálogo, loja, portal) |
| `trust proxy` explícito | `TRUST_PROXY` (padrão: não confiar) |
| Rotas públicas | registradas **antes** do `requireAuth` (44 por desenho) |
| Observabilidade | request/correlation id; nunca loga corpo/token |

---

## 8. Riscos de segurança abertos

| Risco | Nível | Situação |
|---|---|---|
| Integridade cross-tenant de `crm_*` só por FK simples (banco) | P2 | API garante; FK composta na Fase 2 (GAP-P2-04) |
| Loja nativa `/loja` (superfície pública) | P2 | **descontinuada e retirada** (ADR-0007, executada). Superfície pública extinta; URLs antigas respondem 301/410. O motor de checkout segue interno e autenticado. |
| Homologação externa de integrações pendente | P2 | documentada; não ativada |

Nenhum risco **P0** de segurança foi identificado no escopo auditado
(`docs/ERP-3.0-GAP-MATRIX.md` §3).

---

*Próximo documento: [`API-CONTRACTS.md`](API-CONTRACTS.md).*
