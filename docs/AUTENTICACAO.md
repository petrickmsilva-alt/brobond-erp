# BROBOND ERP — Fluxo profissional de autenticação (v0.6.0)

> Documento de referência do desenho de segurança de acesso implementado nesta versão.
> Substitui o modelo anterior (bcrypt puro + "cofre de senhas" reversível).

## Sumário

1. [Princípios](#1-princípios)
2. [Hash de senhas: Argon2id com migração gradual do bcrypt](#2-hash-de-senhas-argon2id-com-migração-gradual-do-bcrypt)
3. [Fim do cofre de senhas (visualização e armazenamento reversível)](#3-fim-do-cofre-de-senhas)
4. [Convites de acesso (o usuário define a própria senha)](#4-convites-de-acesso)
5. [Senha temporária de exibição única](#5-senha-temporária-de-exibição-única)
6. [MFA/TOTP obrigatório para administradores](#6-mfatotp-obrigatório-para-administradores)
7. [Reautenticação (step-up) para ações sensíveis](#7-reautenticação-step-up)
8. [Sessões e invalidação por dispositivo](#8-sessões-e-invalidation-por-dispositivo)
9. [Rate limit persistente](#9-rate-limit-persistente)
10. [Auditoria segura (cadeia de hashes)](#10-auditoria-segura-cadeia-de-hashes)
11. [Política de senha](#11-política-de-senha)
12. [Referência de endpoints](#12-referência-de-endpoints)
13. [Variáveis de ambiente](#13-variáveis-de-ambiente)
14. [Migração e operação (o que muda no deploy)](#14-migração-e-operação)
15. [Recuperação de emergência](#15-recuperação-de-emergência)
16. [Testes](#16-testes)

---

## 1. Princípios

- **Senhas nunca são exibidas nem recuperáveis.** Só existem em forma de hash unidirecional.
- **Nenhuma credencial trafega ou repousa em texto puro**, com uma única exceção deliberada e efêmera: a senha temporária gerada pelo servidor, exibida **uma única vez** na tela do administrador (item 5).
- **Defesa em profundidade**: MFA obrigatório para administradores, rate limit persistente, invalidação de sessões, reautenticação para ações sensíveis e auditoria à prova de adulteração.
- **Sem dependências exóticas**: Argon2id via `@node-rs/argon2` (binários pré-compilados); TOTP implementado com `node:crypto` (RFC 6238); QR via `qrcode` (já era dependência).

## 2. Hash de senhas: Argon2id com migração gradual do bcrypt

| Aspecto | Antes | Agora |
|---|---|---|
| Algoritmo | bcrypt (10 rounds) | **Argon2id** — m=19 MiB (19456 KiB), t=2, p=1 (parâmetros OWASP) |
| Verificação | só bcrypt | Argon2id **e** bcrypt legado |
| Migração | — | **Gradual e transparente**: no login bem-sucedido com hash bcrypt (ou Argon2id com parâmetros fracos), o hash é regravado em Argon2id e o evento é registrado na auditoria |

- Formato gravado: `$argon2id$v=19$m=19456,t=2,p=1$<salt>$<hash>`.
- Módulo: `server/src/password.ts` (`hashPassword`, `verifyPassword`, `verifyPasswordDetailed`, `hashAtualizado`).
- Parâmetros configuráveis por ambiente: `ARGON2_MEMORY_KIB`, `ARGON2_TIME_COST`, `ARGON2_PARALLELISM` (se aumentados, `hashAtualizado` passa a exigir os novos valores e a migração ocorre no próximo login).
- Senhas em **texto puro** (versões muito antigas) continuam sendo invalidadas no boot (`migrarSenhasLegadas`): o hash é substituído por um aleatório e o usuário recupera o acesso por e-mail.

## 3. Fim do cofre de senhas

O modelo anterior gravava uma segunda cópia cifrada da senha (`senha_cifrada`, AES-256-GCM com `VAULT_KEY`) e permitia ao administrador **visualizar** a senha de outro usuário após confirmação. Isso foi **removido por completo**:

- ❌ `server/src/passwordVault.ts` — apagado.
- ❌ Rotas `POST /api/usuarios/:id/revelar-senha` e `POST /api/usuarios/cofre/solicitar-email` — removidas (404).
- ❌ Coluna `senha_cifrada` — **destruída** na migração (`ALTER TABLE usuarios DROP COLUMN IF EXISTS senha_cifrada`). Os dados são irrecuperáveis por desenho.
- ❌ `VAULT_KEY` — não é mais necessária (a verificação em produção foi retirada do `security.ts`).
- ❌ Modal "Ver senha" na tela de Usuários — substituído pelos fluxos de convite e senha temporária.
- ✅ Backup (`/api/admin/backup`) nunca incluiu segredos e segue sem incluir: `senha_hash`, `mfa_secret`, `convite_token_hash`, `reset_token_hash`, além dos bytes de fotos.

**Por que remover?** Senha reversível significa que um vazamento do banco + chave expõe as senhas reais (reuso de senha em outros serviços), elimina a responsabilidade individual e conflita com auditoria confiável. O estado da senha (coluna **Acesso** em Usuários) continua visível: `Convite pendente`, `Provisória — troca pendente` ou `Definida pelo usuário`.

## 4. Convites de acesso

Novos usuários **não recebem senha do administrador**. Em vez disso:

1. O admin cadastra o usuário (nome, e-mail, perfil) — **sem campo de senha no formulário** (o payload com `senha` é rejeitado).
2. O servidor gera um **token de 256 bits**, grava apenas o **hash SHA-256** (`convite_token_hash`) com validade de **48 h** (`INVITE_TTL_HOURS`) e envia o link `APP_URL/convite/<token>` por e-mail.
   - Sem SMTP configurado (dev/demonstração), o link volta na resposta da criação (`convite_link`) para entrega manual — o mesmo comportamento do "esqueci minha senha" sem SMTP (link no console).
3. O usuário abre o link (página pública com rate limit), que mostra nome/e-mail e permite **definir a própria senha** (validada pela política).
4. O aceite limpa o token (uso único), grava o hash Argon2id, define `senha_definida_em` e registra o evento `convite` na auditoria.
5. O admin pode **reenviar o convite** (`POST /api/usuarios/:id/reenviar-convite`) enquanto a senha não existir; cada reenvio invalida o token anterior.

Estados visíveis na coluna **Acesso**: `Convite pendente` (sem `senha_definida_em`), `Provisória` (`trocar_senha=true`) e `Definida pelo usuário`.

## 5. Senha temporária de exibição única

Para redefinir o acesso de alguém já com senha (ex.: esquecimento, suspeita de comprometimento):

1. Admin aciona **"Gerar senha temporária"** na linha do usuário (módulo Usuários).
2. O servidor exige **reautenticação recente do admin** (item 7).
3. O servidor **gera** a senha (16 caracteres de um alfabeto sem ambiguidades, garantindo maiúscula/minúscula/dígito), grava **apenas o hash Argon2id**, marca `trocar_senha` + `senha_provisoria`, **derruba todas as sessões** do usuário e devolve a senha em claro **uma única vez** na resposta (com `Cache-Control: no-store`).
4. A tela mostra a senha com botão copiar e aviso de que ela **não pode ser vista novamente** — não existe "ver de novo", não existe recuperação; só gerar outra.
5. A senha temporária nunca é logada, nunca vai para a auditoria em claro e não é armazenada em texto puro.

Endpoint: `POST /api/usuarios/:id/senha-temporaria` (403 `reauth_necessaria` sem reautenticação).

## 6. MFA/TOTP obrigatório para administradores

TOTP (RFC 6238: HMAC-SHA1, 30 s, 6 dígitos, janela ±1) implementado em `server/src/totp.ts`, com segredo Base32 de 160 bits.

- O segredo é gravado **cifrado** (AES-256-GCM, chave derivada por scrypt de `MFA_ENCRYPTION_KEY` ou `JWT_SECRET`) — nunca em texto puro no banco.
- **Login de administrador** (perfis `admin`), passo a passo:
  1. `POST /api/auth/login` — senha correta → resposta `mfa_setup_required: true` + `mfa_ticket` (JWT de 10 min, `typ: 'mfa'`, não dá acesso à API) na primeira vez; `mfa_required: true` nas seguintes.
  2. `POST /api/auth/mfa/desafio` — devolve segredo + URI `otpauth://` + **QR (PNG data-URL)** para o app autenticador.
  3. `POST /api/auth/login/mfa` com o código — na primeira vez **ativa** o MFA (o código correto prova que o app foi configurado) e emite o token de acesso com `sid`; nas seguintes, apenas valida.
- Usuários `gerente`/`operador` podem ativar por conta própria (Configurações › MFA); quem tem MFA ativado sempre enfrenta o desafio, independente do perfil.
- **Desativação** exige reautenticação recente + código válido e encerra as sessões dos outros dispositivos.
- **Reset por administrador**: `POST /api/usuarios/:id/resetar-mfa` (admin + reautenticação) limpa o MFA de um usuário que perdeu o app autenticador; ele refaz o cadastro guiado no próximo login.
- Códigos errados contam em bucket de rate limit próprio (5 erros → 429) e viram eventos de auditoria.

## 7. Reautenticação (step-up)

Ações sensíveis exigem **senha recente**, não apenas a sessão válida:

- `POST /api/auth/reautenticar { senha }` — confirma a senha e abre uma janela de **5 minutos** (`REAUTH_TTL_MS`) para o usuário logado.
- Endpoints protegidos por `exigirReautenticacao()` devolvem **403 com `code: "reauth_necessaria"`** — o front abre o `ReauthModal` e refaz a chamada.
- Protegidos hoje: gerar senha temporária, resetar MFA de terceiros, desativar o próprio MFA.
- Falhas de reautenticação (senha errada) são limitadas por rate limit e auditadas; trocar a senha encerra a janela de reautenticação.

## 8. Sessões e invalidação por dispositivo

Cada login cria um registro em `sessoes` com um **JTI** (24 bytes aleatórios); o JWT carrega `sid`.

- `requireAuth` (e o WebSocket) validam: assinatura, `typ: 'access'`, **presença de `sid`** (tokens do modelo anterior são recusados), usuário ativo, `token_versao` e **sessão não revogada/não expirada**. Há cache de 30 s por usuário+sid; ações de revogação invalidam o cache na hora.
- TTL: 8 h, ou 30 dias com "Lembrar-me" (mesmo prazo do JWT). Limpeza diária de sessões encerradas há mais de 7 dias.
- **Invalidação automática:**

| Evento | Efeito |
|---|---|
| Logout (`POST /api/auth/logout`) | encerra a sessão atual |
| "Sair de todos" (`logout-all`) | revoga todas + `token_versao+1` |
| Troca da própria senha | revoga **as outras** sessões; a atual continua |
| Redefinição por token ("esqueci minha senha") | revoga **todas** + `token_versao+1` |
| Senha temporária gerada pelo admin | revoga **todas** + `token_versao+1` |
| Convite aceito | revoga **todas** + `token_versao+1` |
| MFA desativado (próprio ou resetado) | revoga **todas** |
| Usuário desativado/excluído | recusado no requireAuth (como antes) |

- Endpoints: `GET /api/auth/sessoes` (lista com IP, user-agent, data e flag `atual`) e `POST /api/auth/sessoes/:sid/revogar`.

## 9. Rate limit persistente

- Antes: `Map` em memória — reinício do serviço zerava os bloqueios (e múltiplas instâncias não compartilhavam contadores).
- Agora: tabela **`login_tentativas`** (chave, contagem, primeira tentativa, bloqueado até) no Postgres; no modo demonstração, `Map` com a mesma semântica.
- Buckets: `login|ip|email` (login e esqueci-minha-senha), `reset|ip` (redefinição), `mfa|usuario|ip` (códigos TOTP), `convite|ip` (aceite de convite), `reauth|ip|usuario`.
- Janela de 15 min e máximo de 5 tentativas (`LOGIN_WINDOW_MS`, `LOGIN_MAX_ATTEMPTS`); bloqueio devolve 429 com `Retry-After`.
- **Fail-open documentado**: se o banco de rate limit estiver indisponível o login segue (as credenciais continuam obrigatórias) e o problema vai para o log — prioriza disponibilidade do acesso de emergência.
- Limpeza diária de buckets encerrados há mais de 24 h.

## 10. Auditoria segura (cadeia de hashes)

- Toda a trilha de auditoria (criar/editar/excluir/login/senha/**mfa**/**segurança**/**convite**/importar/ajuste) agora forma uma **cadeia de hashes**: cada evento grava `hash_anterior` e `hash = SHA-256(hash_anterior | payload canônico)`.
- Editar um evento quebra o próprio hash; **remover** um evento quebra a cadeia do seguinte — tamper-evidence sem mudar o fluxo de escrita.
- Verificação: `GET /api/admin/auditoria/verificar` → `{ ok, total, verificadas, quebras[] }` (posterior a 100 mil eventos, verifica o recorte).
- Higiene: `dados` de auditoria passam por `sanitize()` que remove `senha`, `senha_hash`, `mfa_secret`, `convite_token_hash`, `reset_token_hash`; a troca de campos sensíveis registra apenas `••••`.
- Migração idempotente cria as colunas; eventos antigos (sem hash) fazem a verificação partir deles — a cadeia vale a partir do primeiro evento assinado.

## 11. Política de senha

Configurável pelo administrador (Usuários → Política de senha; `GET/PUT /api/usuarios/politica-senha`, gravação com reautenticação). O padrão reproduz a regra original — mínimo 8, ≠ e-mail, fora da lista de óbvias — e pode endurecer: tamanho 6–64, maiúsculas+minúsculas, número, símbolo, histórico (não repetir as últimas N, até 10) e expiração (30–365 dias ou nunca). Aplicada em **todos** os pontos de definição de senha do usuário (convite, troca própria, redefinição); senhas temporárias (geradas, 16+ caracteres) seguem isentas. Senha vencida vira troca obrigatória no login (com aviso de "vence em X dias" em `/auth/me` e nas Configurações) e alimenta os alertas do painel. As regras de composição são públicas (`GET /api/auth/politica-senha`, sem login) para o medidor das telas de convite/reset.

## 12. Referência de endpoints

### Públicos (com rate limit)
| Método | Rota | Descrição |
|---|---|---|
| POST | `/api/auth/login` | 1º passo → token **ou** `mfa_required`/`mfa_setup_required` + `mfa_ticket` |
| POST | `/api/auth/login/mfa` | 2º passo `{ mfa_ticket, codigo }` → token + `sid` |
| POST | `/api/auth/mfa/desafio` | `{ mfa_ticket }` → segredo + QR (só para MFA ainda não ativado) |
| POST | `/api/auth/forgot` | sempre 200; envia link de 1 h se o e-mail existir |
| POST | `/api/auth/reset` | `{ token, senha }` → troca e derruba todas as sessões |
| GET | `/api/convites/:token` | valida convite (nome, e-mail, expirado) |
| POST | `/api/convites/aceitar` | `{ token, senha }` → define a própria senha |
| GET | `/api/auth/politica-senha` | regras de composição (medidor de senha, sem login) |

### Autenticados
| Método | Rota | Descrição |
|---|---|---|
| GET | `/api/auth/me` | usuário logado + aviso de vencimento da senha |
| POST | `/api/auth/change-password` | troca própria (exige senha atual; derruba outras sessões) |
| POST | `/api/auth/reautenticar` | step-up de 5 min |
| POST | `/api/auth/logout` / `logout-all` | encerra atual / todas |
| GET/POST | `/api/auth/sessoes`, `/api/auth/sessoes/:sid/revogar` | lista e revogação por dispositivo |
| GET/POST | `/api/auth/mfa/status`, `setup`, `ativar`, `desativar` | MFA autogerenciado |
| GET/PUT | `/api/auth/preferences` | preferências (como antes) |

### Administração (admin + reautenticação quando indicado)
| Método | Rota | Descrição |
|---|---|---|
| POST | `/api/usuarios/:id/senha-temporaria` | senha de exibição única (reauth) |
| POST | `/api/usuarios/:id/reenviar-convite` | novo link de convite |
| POST | `/api/usuarios/:id/resetar-mfa` | limpa MFA (reauth) |
| GET | `/api/admin/auditoria/verificar` | confere a cadeia de hashes |
| GET/PUT | `/api/usuarios/politica-senha` | política de senha (gravação com reauth) |
| GET | `/api/usuarios/certificacao` (+ `/export?format=csv\|xlsx`) | matriz quem-tem-o-quê |
| POST | `/api/usuarios/:id/certificar` | carimbo de revisão (reauth; nunca o próprio) |
| GET/POST/PUT/DELETE | `/api/webhooks`, `/api/webhooks/:id` | gestão de webhooks (mutação com reauth) |
| POST | `/api/webhooks/:id/testar` | evento de teste + resultado |
| GET/POST | `/api/webhooks/:id/entregas`, `/api/webhooks/entregas/:id/reenviar` | log e reenvio |

### Webhooks (contrato da entrega)

POST JSON `{ evento, ocorrido_em, dados }` com headers `X-Brobond-Event` e `X-Brobond-Signature: sha256=HMAC_SHA256(segredo, corpo_bruto)`. Eventos: `usuario.criado`, `usuario.convite_enviado`, `usuario.desativado`, `usuario.ativado`, `usuario.bloqueado`, `usuario.desbloqueado`, `usuario.senha_temporaria`, `usuario.mfa_resetado`, `usuario.acesso_certificado` (+ `webhook.teste`). Timeout 6 s; HTTP 2xx = ok; log das 200 entregas mais recentes por webhook, com reenvio manual. O segredo sai da API uma única vez (criação/regeneração) e dorme cifrado (AES-GCM).

## 13. Variáveis de ambiente

| Variável | Padrão | Papel |
|---|---|---|
| `JWT_SECRET` | (exigida em produção) | assina tokens; **deriva a chave do MFA se `MFA_ENCRYPTION_KEY` não existir** |
| `MFA_ENCRYPTION_KEY` | deriva de `JWT_SECRET` | chave (qualquer string forte) para cifrar os segredos TOTP em repouso. **Defina uma dedicada e não a troque** — trocá-la inutiliza os segredos cadastrados (os admins precisariam de reset de MFA) |
| `JWT_TTL` | `8h` | validade do token de acesso |
| `REAUTH_TTL_MS` | `300000` | janela de reautenticação |
| `INVITE_TTL_HOURS` | `48` | validade do convite |
| `RESET_TTL_MINUTES` | `60` | validade do link de redefinição |
| `ARGON2_MEMORY_KIB` / `ARGON2_TIME_COST` / `ARGON2_PARALLELISM` | `19456` / `2` / `1` | parâmetros Argon2id |
| `LOGIN_WINDOW_MS` / `LOGIN_MAX_ATTEMPTS` | `900000` / `5` | rate limit |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` / `ADMIN_FORCE_PASSWORD` | — | bootstrap do admin (como antes) |
| ~~`VAULT_KEY`~~ | — | **removida** — não é mais usada nem verificada |

## 14. Migração e operação

A migração é **idempotente** e roda sozinha no boot (`db/schema.sql`):

1. Cria `sessoes` e `login_tentativas`; adiciona colunas de MFA, convite e estado de senha em `usuarios`; adiciona `hash`/`hash_anterior` em `auditoria`.
2. Preenche `senha_definida_em` de quem já tem hash.
3. **`DROP COLUMN senha_cifrada`** — o armazenamento reversível é destruído (não há como reverter; este é o objetivo).
4. Em produção, `assertProductionSecrets` não exige mais `VAULT_KEY`.

Consequências para usuários existentes:

- **Todos são desconectados uma vez** no primeiro acesso após o deploy (tokens antigos não têm `sid`) — comportamento desejado para um upgrade de segurança deste tamanho.
- Hashes bcrypt continuam válidos e migram para Argon2id no login, um por um, sem action em massa nem janela de indisponibilidade.
- Administradores farão o **cadastro guiado do MFA** no primeiro login (QR + código).

## 15. Recuperação de emergência

- **Admin perdeu a senha**: outro admin gera senha temporária; ou defina `ADMIN_FORCE_PASSWORD=true` com `ADMIN_PASSWORD` nova (o boot reaplica a senha padrão) e volte para `false`.
- **Admin perdeu o app autenticador**: outro admin usa `POST /api/usuarios/:id/resetar-mfa` (com reautenticação); o usuário refaz o cadastro no próximo login. Único admin? Use `ADMIN_FORCE_PASSWORD` para reentrar — o fluxo de primeiro login pedirá o cadastro do MFA de novo.
- **Banco fora do ar**: o acesso de emergência por `ADMIN_EMAIL`/`ADMIN_PASSWORD` continua existindo (token de 1 h, id 0), agora sem burlar o rate limit persistente quando disponível.
- **`JWT_SECRET`/`MFA_ENCRYPTION_KEY` trocados**: todos os tokens caem (esperado); segredos TOTP ficam indecifráveis → resetar MFA por usuário.

## 16. Testes

- `server/test/auth-fluxo.test.ts` — 25 testes do fluxo completo: Argon2id + migração bcrypt; fim do cofre (arquivo/rotas/payload); convites (validade, aceite, uso único, política); senha temporária (reauth, exibição única, hash no banco); TOTP (RFC 6238, cadastro guiado, `mfa_required`, rate limit de códigos, MFA por escolha do operador, segredo cifrado); sessões (criação, logout, token sem `sid`, troca de senha, revogação); reset por token; reautenticação; rate limit persistente; cadeia de auditoria (integridade + detecção de adulteração).
- `server/test/api.test.ts`, `regras.test.ts`, `relatorios.test.ts` — atualizados ao novo fluxo (rate limit assíncrono/persistente, status `convite_pendente`).
- `server/test/smoke.mjs` — E2E por HTTP (servidor real em modo demonstração): login admin com cadastro MFA, convite até o primeiro acesso, senha temporária derrubando sessões, rate limit 429, cadeia de auditoria e revogação de sessões. Executar com o servidor no ar:
  ```bash
  PORT=3101 npm --prefix server run dev   # em um terminal
  cd server && node --import tsx test/smoke.mjs BASE=http://localhost:3101
  ```
- Suíte padrão: `npm test` (73 testes) + `npm run typecheck` + `npm run lint`.
