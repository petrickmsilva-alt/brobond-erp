# BROBOND ERP

Sistema de controle de estoque e produção para a **BROBOND** (roupas masculinas).
Monorepo com frontend (React) e backend (Node/Express + Postgres).

## Stack

| Camada | Tecnologia |
|---|---|
| Frontend | React + TypeScript + Vite + Tailwind CSS + lucide-react (ícones) |
| Backend | Node.js + Express + JSON Web Token (JWT) + **Argon2id** (senhas) + **MFA/TOTP** (administradores) |
| Banco | PostgreSQL (recomendado: **Neon**, gratuito e permanente) — ou modo demonstração em memória |
| Fotos | No próprio banco (padrão) ou **Cloudinary** (gratuito, CDN) |
| Hospedagem | Render (API + front) · HostGator (domínio/e-mail) |
| CI/CD | GitHub (push → deploy automático) |

## Estrutura

```
brobond-erp/
├── client/                 # React (UI, menu lateral, login, CRUD genérico)
│   └── src/
│       ├── components/     # Layout, Sidebar, Logo, RecordForm, ImageField (fotos), LabelSheet (etiquetas), ui
│       ├── pages/          # Login, Dashboard, ModulePage (CRUD), ProductDetail, Settings, PlannedModule
│       ├── lib/            # api.ts, meta.ts, format.ts, images.ts (otimização no navegador), barcode.ts (EAN/Code128)
│       └── modules.ts      # menu lateral + rotas (fonte única de verdade)
├── server/
│   └── src/
│       ├── index.ts        # rotas HTTP (auth, meta, dashboard, CRUD genérico)
│       ├── resources.ts    # DEFINIÇÃO DOS MÓDULOS: campos, tipos, validação, permissões
│       ├── services.ts     # regras de negócio (estoque, OP, usuários) + auditoria
│       ├── uploads.ts      # fotos: upload, principal, ordem, remoção (banco ou Cloudinary)
│       ├── detail.ts       # página de detalhe do produto (grade, movimentações, custo)
│       ├── security.ts     # rate limit PERSISTENTE, cabeçalhos, CORS, segredos de produção
│       ├── password.ts     # hash Argon2id + migração gradual do bcrypt
│       ├── totp.ts / mfa.ts# MFA (RFC 6238) — segredo cifrado em repouso
│       ├── sessoes.ts      # sessões por dispositivo (invalidação)
│       ├── usuariosAdmin.ts# convites, senha temporária (exibição única), reset de MFA
│       ├── auditChain.ts   # cadeia de hashes da auditoria (tamper-evidence)
│       ├── validate.ts     # validação/normalização do payload
│       ├── pgstore.ts      # persistência PostgreSQL
│       ├── memdb.ts        # persistência em memória (modo demonstração)
│       ├── auth.ts         # login (com MFA), JWT+sessões, reautenticação, perfis, troca de senha
│       └── db.ts           # pool + migração automática (db/schema.sql)
├── db/                     # schema.sql (idempotente) + seed.sql (Postgres)
├── docs/                   # relatório de auditoria e guias (banco/fotos gratuitos)
├── .github/workflows/      # CI: typecheck + testes + build a cada push
├── render.yaml             # deploy na Render (blueprint)
└── package.json            # scripts raiz (dev com concurrently)
```

## Como rodar localmente

```bash
# 1) instalar dependências (client + server)
npm run install:all

# 2) (opcional) configurar o banco — copie e ajuste
cp server/.env.example server/.env

# 3) subir tudo (Vite :5173 + API :3001)
npm run dev
```

Abra http://localhost:5173 e entre com o administrador padrão:

- e-mail: `admin@brobond.com.br`
- senha: `brobond123` (ou o valor de `ADMIN_PASSWORD`)

> **Sem `DATABASE_URL`** a API roda em **modo demonstração**: todos os módulos
> cadastram, editam e excluem normalmente, mas os dados ficam em memória e são
> apagados ao reiniciar. O sistema mostra um aviso "DEMO" no menu.

## Banco de dados

> **Atenção:** o Postgres **gratuito da Render expira em 30 dias** e apaga os
> dados. Para produção sem custo use o **Neon** (neon.tech — 0,5 GB, permanente).
> Passo a passo em [`docs/CONFIGURACAO-GRATUITA.md`](docs/CONFIGURACAO-GRATUITA.md).

Com `DATABASE_URL` definida, a API **aplica `db/schema.sql` automaticamente ao
iniciar** (o arquivo é idempotente: cria tabelas novas e adiciona colunas que
faltam em bancos antigos). Não é preciso rodar nada à mão, mas se quiser:

```bash
psql "$DATABASE_URL" -f db/schema.sql   # tabelas / migração
psql "$DATABASE_URL" -f db/seed.sql     # (opcional) grade PP–GG, coleções e fornecedores de exemplo
```

O usuário administrador é criado pela própria API a partir de
`ADMIN_EMAIL`/`ADMIN_PASSWORD`, com a senha em **hash Argon2id** (irreversível).
No primeiro login o administrador troca a senha e cadastra o **MFA obrigatório**
(app autenticador + QR). Para recuperar o acesso, defina
`ADMIN_FORCE_PASSWORD=true` em um deploy e volte para `false` em seguida.

> 🔐 O fluxo completo de autenticação (Argon2id com migração do bcrypt, convites,
> senha temporária de exibição única, MFA/TOTP, reautenticação, sessões,
> rate limit persistente e auditoria com cadeia de hashes) está documentado em
> [`docs/AUTENTICACAO.md`](docs/AUTENTICACAO.md).

## Deploy na Render

1. Conecte o repositório GitHub na Render.
2. O arquivo `render.yaml` cria: um serviço web (API que também serve o front)
   e um banco Postgres gratuito, já ligado via `DATABASE_URL`.
3. Defina `DATABASE_URL` (Neon), `ADMIN_PASSWORD` e, se quiser fotos em CDN,
   `UPLOAD_PROVIDER=cloudinary` + `CLOUDINARY_URL` nas variáveis de ambiente.
4. A cada `git push` na `main`, o Render faz o redeploy.

O domínio (`brobond.com.br`) e o e-mail corporativo ficam no HostGator, com o
DNS apontando para a Render.

## Módulos

| Grupo | Módulo | Incluir | Salvar | Excluir | Observações |
|---|---|:-:|:-:|:-:|---|
| — | Dashboard | | | | KPIs reais: valor do estoque, alertas de mínimo, OPs abertas, vendas/compras, atividade recente |
| Cadastros | **Produtos** | ✔ | ✔ | ✔ | **Até 5 fotos** (principal, ordem, zoom), categoria, cor padronizada **ou** texto livre, código de barras EAN único, composição, NCM, peso, descrição. **Página de detalhe** com grade de estoque, movimentações, OPs, custo/margem e **impressão de etiquetas** com código de barras |
| Cadastros | **Categorias**, **Cores** (com amostra colorida) | ✔ | ✔ | ✔ | Nome único (ignora maiúsculas). Cores antigas em texto são migradas automaticamente |
| Cadastros | Insumos, Fornecedores, Representantes, Clientes, Tamanhos/Grade, Coleções | ✔ | ✔ | ✔ | Busca, ordenação, paginação, validação por campo |
| Estoque | Estoque Físico | ✔ | ✔ | ✔ | Saldo único por produto+tamanho+local; alteração manual gera "ajuste"; só exclui saldo zerado |
| Estoque | Movimentações | ✔ | — | — | Imutáveis. Entrada/saída/ajuste atualizam o saldo; saída sem saldo é bloqueada |
| Estoque | Inventário | | | | Contagem por local com congelamento de saldo, divergências e ajustes ao fechar |
| Produção | Ordens de Fabricação | ✔ | ✔ | ✔ | Status "Concluída" dá entrada automática no estoque (e estorna se reaberta) |
| Produção | Ficha Técnica / BOM | ✔ | ✔ | ✔ | Mão de obra, indiretos e margem por produto |
| Produção | Custo de Fabricação | | | | Calculadora de custo (insumos + mão de obra + indiretos) e preço sugerido |
| Compras | Compras | ✔ | ✔ | ✔ | Pedido por fornecedor, status e total |
| Vendas | Vendas | ✔ | ✔ | ✔ | Pedido por cliente/representante, canal (balcão, site varejo/atacado, marketplace), status e total |
| Vendas | Catálogos públicos | ✔ | ✔ | ✔ | Link sem login com fotos e preços; opções varejo/atacado e **pedido pelo site** (gera cotação no ERP) |
| Financeiro | Financeiro | | | | Painel: fluxo de caixa, contas, resultado do mês, contas a receber/pagar, vendas por canal |
| Financeiro | Lançamentos | ✔ | ✔ | ✔ | Livro-caixa (receita, despesa, investimento, estorno) com link automático em vendas, compras e aportes |
| Financeiro | Categorias / Contas | ✔ | ✔ | ✔ | Classificação (com classe na DRE) e contas (caixa, banco, Pix, cartão, boleto) |
| Financeiro | Investidores / Aportes | ✔ | ✔ | ✔ | Sócios/investidores, capital inicial, rodada, reinvestimento, distribuição de lucro |
| Financeiro | Recorrências | ✔ | ✔ | ✔ | Aluguel, energia, folha, facção etc. — geração automática (botão ou cron) |
| Relatórios | Relatórios | | | | Faturamento por período (comparação mensal/anual), vendas, comissões com gráfico mensal, curva ABC, posição de estoque, estoque abaixo do mínimo por local, movimentações, produção, insumos, DRE gerencial e razão financeiro (gerente). Exportação CSV/XLSX |
| Configurações | Usuários | ✔ | ✔ | ✔ | Somente admin. Perfis, ativar/desativar, **convite por e-mail**, **senha temporária de exibição única**, reset de MFA |
| Configurações | Auditoria | | | | Somente admin. Quem incluiu/alterou/excluiu o quê, logins e trocas de senha |
| Configurações | Configurações | | | | Minha conta, trocar senha, **MFA**, **sessões por dispositivo**, informações do sistema |

### Perfis de acesso

| Perfil | Pode |
|---|---|
| **Administrador** | Tudo, incluindo Usuários e Auditoria |
| **Gerente** | Incluir, salvar e excluir em todos os módulos, exceto Usuários/Auditoria |
| **Operador** | Incluir e salvar; **não exclui** registros |

Regras de segurança: senhas sempre em **hash Argon2id** (migração gradual do bcrypt no
login), **nunca exibidas nem recuperáveis** — não existe cofre de senhas; novos usuários
recebem **convite por e-mail** para definir a própria senha; redefinições pelo admin usam
**senha temporária de exibição única**; **MFA/TOTP obrigatório para administradores**;
`senha_hash` e segredos (`mfa_secret`, tokens) nunca saem da API; **sessões revogáveis por
dispositivo** (troca de senha/reset derrubam sessões); **reautenticação** para ações sensíveis;
**rate limit persistente** (sobrevive a reinícios); auditoria com **cadeia de hashes**
(tamper-evidence, verificável em `/api/admin/auditoria/verificar`); usuário desativado perde o
acesso imediatamente; não é possível desativar/rebaixar/excluir o próprio usuário nem o último
administrador; cabeçalhos de proteção; em produção a API **não inicia sem `JWT_SECRET`** e o
CORS só aceita o próprio domínio (ou `CORS_ORIGINS`).

### API (resumo)

```
GET    /api/health                     { ok, db, uploads, version } — pública (sem login)
POST   /api/auth/login                 { email, password } → { token, user } ou { mfa_*, mfa_ticket }
POST   /api/auth/login/mfa             { mfa_ticket, codigo } → { token, user } (MFA/TOTP)
POST   /api/auth/mfa/setup|ativar|desativar   MFA autogerenciado (QR + código)
POST   /api/auth/reautenticar          { senha } → ações sensíveis por 5 min
GET    /api/auth/sessoes               sessões ativas (+ POST .../revogar)
POST   /api/auth/logout | logout-all   encerra a sessão atual | todas
GET    /api/convites/:token            valida convite (+ POST /api/convites/aceitar)
POST   /api/usuarios/:id/senha-temporaria    senha de exibição única (admin + reauth)
POST   /api/usuarios/:id/resetar-mfa   limpa o MFA do usuário (admin + reauth)
GET    /api/admin/auditoria/verificar  confere a cadeia de hashes da auditoria
GET    /api/auth/me
POST   /api/auth/change-password       { senha_atual, senha_nova } — derruba as outras sessões
GET    /api/meta                       definição dos módulos (campos, tipos, opções)
GET    /api/dashboard
GET    /api/financeiro/resumo          fluxo de caixa, resultado do mês, a receber/pagar, por categoria
GET    /api/publico/catalogo/:token    catálogo público (somente leitura)
POST   /api/publico/catalogo/:token/pedido   cria COTAÇÃO de venda (site varejo/atacado)
GET    /api/:recurso?q=&page=&pageSize=&sort=&dir=&f.campo=valor   (f.* = filtros de igualdade)
GET    /api/:recurso/options           [{ value, label }] para selects
GET    /api/produtos/:id/detalhe       fotos + grade de estoque + movimentações + OPs + custo
GET    /api/vendas/:id/itens           itens do pedido (também /api/compras/:id/itens)
POST   /api/vendas/:id/itens           adiciona item { produto_id, tamanho_id, quantidade, preco_unitario, desconto_pct }
PUT    /api/vendas/:id/itens/:itemId   altera item
DELETE /api/vendas/:id/itens/:itemId   remove item (o total do pedido é sempre recalculado)
GET    /api/relatorios/comissoes?de=&ate=&representante_id=   comissões de representantes no período
```

**Regras de pedidos (vendas/compras):** o `total` é sempre calculado pelo servidor
(itens + frete − desconto) e nunca aceito do cliente. Ao **faturar** uma venda, as
peças saem do estoque (local de saída com fallback para o almoxarifado), a venda sem
saldo é bloqueada (409 com a lista de itens) e a comissão do representante é
congelada; cancelar um pedido faturado/entregue estorna a saída. Ao **receber** uma
compra, os insumos entram no estoque de insumos e o `custo_medio` vira a média
ponderada; cancelar uma compra recebida estorna a entrada. Itens de pedidos
faturados/recebidos ficam bloqueados para edição.

```
GET    /api/:recurso/:id/arquivos      fotos do registro
POST   /api/:recurso/:id/arquivos      { nome, mime, dados (base64), thumb (base64) }
PUT    /api/:recurso/:id/arquivos/:fid { principal: true } ou { ordem: [ids...] }
DELETE /api/:recurso/:id/arquivos/:fid
GET    /api/files/:id/:token.jpg       imagem armazenada no banco (URL pública com token)
GET    /api/:recurso/:id
POST   /api/:recurso                   incluir
PUT    /api/:recurso/:id               salvar (parcial)
DELETE /api/:recurso/:id               excluir
```

Erros de validação voltam como `400 { error, fields: { campo: mensagem } }`;
conflitos (duplicidade, registro em uso) como `409`.

### Fotos de produtos — como funciona

1. O navegador **redimensiona** a foto (máx. 1600 px, JPEG ~85 %) e gera uma
   miniatura de 240 px **antes** de enviar → uma foto de celular de 5 MB vira ~150 KB.
2. A API valida o tipo real do arquivo (JPEG/PNG/WebP), o tamanho e o limite de
   5 fotos por produto, e grava:
   - `UPLOAD_PROVIDER=db` (padrão): bytes no Postgres, servidos por
     `/api/files/:id/:token.jpg` com cache de 1 ano;
   - `UPLOAD_PROVIDER=cloudinary`: envia ao Cloudinary e guarda só as URLs.
3. Toda inclusão/remoção de foto entra na **Auditoria**. Ao excluir um produto,
   as fotos são removidas junto.

### Testes e CI

```bash
npm test         # regras de negócio (estoque, OP, permissões, validação, rate limit)
npm run typecheck
```

O GitHub Actions (`.github/workflows/ci.yml`) roda typecheck, testes e build a
cada push — um PR com erro não passa.

### Como adicionar um campo a um módulo

1. Declare o campo em `server/src/resources.ts` (tipo, obrigatório, rótulo...).
2. Adicione a coluna em `db/schema.sql` (na tabela **e** na seção de migrações
   com `ADD COLUMN IF NOT EXISTS`).
3. Pronto — formulário, tabela, validação e API passam a considerá-lo.

## Roteiro de evolução

Ver [`docs/AUDITORIA-EVOLUCOES.md`](docs/AUDITORIA-EVOLUCOES.md). Situação:

- [x] **Fase 1** — Fotos, categorias, cores, código de barras, detalhe do produto, etiquetas
- [x] **Fase 6 (parcial)** — rate limit, cabeçalhos, CORS, JWT obrigatório, testes + CI
- [x] **Correções 0.3.1** — Configurações exibe a versão real e o provedor de fotos; alerta quando o Cloudinary está configurado mas inválido; `/api/health` informa o provedor
- [x] **Fase 2 (v0.4.0)** — Pedidos com itens e total calculado, faturamento com baixa de estoque (e estorno), compras com entrada de insumos e custo médio ponderado, impressão do pedido, comissões e relatório
- [x] **Fase 3** — OP por grade, ficha técnica com insumos, custo real, estoque de insumos
- [x] **Fase 4** — Locais, transferência, visão em grade, inventário, leitor de código de barras
- [x] **Fase 5** — Exportação, filtros, relatórios, gráficos, importação
- [x] **Fase 6 (restante)** — "esqueci minha senha" por e-mail, backup (SQL e XLSX completo)
- [x] Fase 7 (parcial) — Mobile em cards, PWA, catálogo público
- [x] **Módulo Financeiro** — contas, categorias, lançamentos, painel, auto-lançamento de vendas/compras e aportes de investidores
- [x] Comércio varejo/atacado — preço atacado, canal de venda e pedido pelo catálogo público (cotação)
- [x] **v0.6.0 — Fluxo profissional de autenticação** — fim do cofre de senhas (sem visualização nem armazenamento reversível; coluna `senha_cifrada` destruída); hash **Argon2id** com migração gradual do bcrypt no login; **convites por token** (48 h) para o usuário definir a própria senha; **senha temporária de exibição única** gerada pelo servidor; **MFA/TOTP obrigatório para administradores** (segredo cifrado em repouso, cadastro guiado com QR); **reautenticação (step-up)** para ações sensíveis; **sessões por dispositivo** com revogação individual; **rate limit persistente** no banco; **auditoria com cadeia de hashes** verificável; correção latente: tokens de redefinição não eram persistidos pelos stores. Detalhes em `docs/AUTENTICACAO.md`
- [x] **v0.5.0 — Auditoria + cockpit** — versão unificada em 0.5.0; coluna "Senha" (estado) e troca de senha no Editar de Usuários; cockpit em Estoque e Produção; relatórios de faturamento (comparação mensal/anual), comissões com gráfico mensal, estoque abaixo do mínimo por local, DRE e razão financeiro (gerente/admin); exportação XLSX completa do sistema; correção do 409 falso ao editar estoque mínimo de outro local; API do financeiro restrita a gerente/admin (igual ao menu)
