# BROBOND ERP

Sistema de controle de estoque e produção para a **BROBOND** (roupas masculinas).
Monorepo com frontend (React) e backend (Node/Express + Postgres).

## Stack

| Camada | Tecnologia |
|---|---|
| Frontend | React + TypeScript + Vite + Tailwind CSS + lucide-react (ícones) |
| Backend | Node.js + Express + JSON Web Token (JWT) + bcrypt |
| Banco | PostgreSQL (gerenciado na Render) — ou modo demonstração em memória |
| Hospedagem | Render (API + front) · HostGator (domínio/e-mail) |
| CI/CD | GitHub (push → deploy automático) |

## Estrutura

```
brobond-erp/
├── client/                 # React (UI, menu lateral, login, CRUD genérico)
│   └── src/
│       ├── components/     # Layout, Sidebar, Logo, RecordForm, ui (Modal, Toast...)
│       ├── pages/          # Login, Dashboard, ModulePage (CRUD), Settings, PlannedModule
│       ├── lib/            # api.ts (fetch + token), meta.ts (tipos), format.ts (pt-BR)
│       └── modules.ts      # menu lateral + rotas (fonte única de verdade)
├── server/
│   └── src/
│       ├── index.ts        # rotas HTTP (auth, meta, dashboard, CRUD genérico)
│       ├── resources.ts    # DEFINIÇÃO DOS MÓDULOS: campos, tipos, validação, permissões
│       ├── services.ts     # regras de negócio (estoque, OP, usuários) + auditoria
│       ├── validate.ts     # validação/normalização do payload
│       ├── pgstore.ts      # persistência PostgreSQL
│       ├── memdb.ts        # persistência em memória (modo demonstração)
│       ├── auth.ts         # login, JWT, bcrypt, perfis, troca de senha
│       └── db.ts           # pool + migração automática (db/schema.sql)
├── db/                     # schema.sql (idempotente) + seed.sql (Postgres)
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

Com `DATABASE_URL` definida, a API **aplica `db/schema.sql` automaticamente ao
iniciar** (o arquivo é idempotente: cria tabelas novas e adiciona colunas que
faltam em bancos antigos). Não é preciso rodar nada à mão, mas se quiser:

```bash
psql "$DATABASE_URL" -f db/schema.sql   # tabelas / migração
psql "$DATABASE_URL" -f db/seed.sql     # (opcional) grade PP–GG, coleções e fornecedores de exemplo
```

O usuário administrador é criado pela própria API a partir de
`ADMIN_EMAIL`/`ADMIN_PASSWORD`, com a senha em **hash bcrypt**. Depois disso a
senha pode ser trocada pela interface; para recuperar o acesso, defina
`ADMIN_FORCE_PASSWORD=true` em um deploy e volte para `false` em seguida.

## Deploy na Render

1. Conecte o repositório GitHub na Render.
2. O arquivo `render.yaml` cria: um serviço web (API que também serve o front)
   e um banco Postgres gratuito, já ligado via `DATABASE_URL`.
3. Defina `ADMIN_PASSWORD` nas variáveis de ambiente.
4. A cada `git push` na `main`, o Render faz o redeploy.

O domínio (`brobond.com.br`) e o e-mail corporativo ficam no HostGator, com o
DNS apontando para a Render.

## Módulos

| Grupo | Módulo | Incluir | Salvar | Excluir | Observações |
|---|---|:-:|:-:|:-:|---|
| — | Dashboard | | | | KPIs reais: valor do estoque, alertas de mínimo, OPs abertas, vendas/compras, atividade recente |
| Cadastros | Produtos, Insumos, Fornecedores, Representantes, Clientes, Tamanhos/Grade, Coleções | ✔ | ✔ | ✔ | Busca, ordenação, paginação, validação por campo |
| Estoque | Estoque Físico | ✔ | ✔ | ✔ | Saldo único por produto+tamanho+local; alteração manual gera "ajuste"; só exclui saldo zerado |
| Estoque | Movimentações | ✔ | — | — | Imutáveis. Entrada/saída/ajuste atualizam o saldo; saída sem saldo é bloqueada |
| Estoque | Inventário | | | | Planejado |
| Produção | Ordens de Fabricação | ✔ | ✔ | ✔ | Status "Concluída" dá entrada automática no estoque (e estorna se reaberta) |
| Produção | Ficha Técnica / BOM | ✔ | ✔ | ✔ | Mão de obra, indiretos e margem por produto |
| Produção | Custo de Fabricação | | | | Planejado |
| Compras | Compras | ✔ | ✔ | ✔ | Pedido por fornecedor, status e total |
| Vendas | Vendas | ✔ | ✔ | ✔ | Pedido por cliente/representante, status e total |
| Relatórios | Relatórios | | | | Planejado |
| Configurações | Usuários | ✔ | ✔ | ✔ | Somente admin. Perfis, ativar/desativar, redefinir senha |
| Configurações | Auditoria | | | | Somente admin. Quem incluiu/alterou/excluiu o quê, logins e trocas de senha |
| Configurações | Configurações | | | | Minha conta, trocar senha, informações do sistema |

### Perfis de acesso

| Perfil | Pode |
|---|---|
| **Administrador** | Tudo, incluindo Usuários e Auditoria |
| **Gerente** | Incluir, salvar e excluir em todos os módulos, exceto Usuários/Auditoria |
| **Operador** | Incluir e salvar; **não exclui** registros |

Regras de segurança: senhas sempre com bcrypt; `senha_hash` nunca sai da API;
usuário desativado perde o acesso imediatamente (token rejeitado); não é
possível desativar/rebaixar/excluir o próprio usuário nem o último administrador.

### API (resumo)

```
POST   /api/auth/login                 { email, password } → { token, user }
GET    /api/auth/me
POST   /api/auth/change-password       { senha_atual, senha_nova }
GET    /api/meta                       definição dos módulos (campos, tipos, opções)
GET    /api/dashboard
GET    /api/:recurso?q=&page=&pageSize=&sort=&dir=
GET    /api/:recurso/options           [{ value, label }] para selects
GET    /api/:recurso/:id
POST   /api/:recurso                   incluir
PUT    /api/:recurso/:id               salvar (parcial)
DELETE /api/:recurso/:id               excluir
```

Erros de validação voltam como `400 { error, fields: { campo: mensagem } }`;
conflitos (duplicidade, registro em uso) como `409`.

### Como adicionar um campo a um módulo

1. Declare o campo em `server/src/resources.ts` (tipo, obrigatório, rótulo...).
2. Adicione a coluna em `db/schema.sql` (na tabela **e** na seção de migrações
   com `ADD COLUMN IF NOT EXISTS`).
3. Pronto — formulário, tabela, validação e API passam a considerá-lo.

## Próximos passos sugeridos

- Itens de compra/venda (grade de produtos por pedido) e cálculo automático do total.
- Lista de insumos por peça na ficha técnica → **custo de fabricação**.
- Inventário (contagem × saldo → ajustes automáticos).
- Relatórios com exportação.
