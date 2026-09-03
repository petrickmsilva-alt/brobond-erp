# BROBOND ERP

Sistema de controle de estoque e produção para a **BROBOND** (roupas masculinas).
Monorepo com frontend (React) e backend (Node/Express + Postgres).

## Stack

| Camada | Tecnologia |
|---|---|
| Frontend | React + TypeScript + Vite + Tailwind CSS |
| Backend | Node.js + Express + JSON Web Token (JWT) |
| Banco | PostgreSQL (gerenciado na Render) |
| Hospedagem | Render (API + front) · HostGator (domínio/e-mail) |
| CI/CD | GitHub (push → deploy automático) |

## Estrutura

```
brobond-erp/
├── client/      # React (UI, menu lateral, login)
├── server/      # API REST (auth, recursos, dashboard)
├── db/          # schema.sql + seed.sql (Postgres)
├── render.yaml  # deploy na Render (blueprint)
└── package.json # scripts raiz (dev com concurrently)
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

Abra http://localhost:5173 e entre com:

- e-mail: `admin@brobond.com.br`
- senha: `brobond123`

> Sem `DATABASE_URL` a API responde com dados mock — o front funciona mesmo
> sem banco. Ao conectar o Postgres, as telas passam a listar dados reais.

## Banco de dados

```bash
# crie as tabelas
psql "$DATABASE_URL" -f db/schema.sql
# (opcional) dados iniciais
psql "$DATABASE_URL" -f db/seed.sql
```

## Deploy na Render

1. Conecte o repositório GitHub na Render.
2. O arquivo `render.yaml` cria: um serviço web (API que também serve o front)
   e um banco Postgres gratuito, já ligado via `DATABASE_URL`.
3. Defina `ADMIN_PASSWORD` nas variáveis de ambiente.
4. A cada `git push` na `main`, o Render faz o redeploy.

O domínio (`brobond.com.br`) e o e-mail corporativo ficam no HostGator, com o
DNS apontando para a Render.

## Módulos (menu lateral)

Dashboard · Produtos · Insumos · Fornecedores · Representantes · Clientes ·
Tamanhos/Grade · Coleções · Estoque Físico · Movimentações · Inventário ·
Ordens de Fabricação · Ficha Técnica/BOM · Custo de Fabricação · Compras ·
Vendas · Relatórios · Usuários · Configurações.

## Próximos passos sugeridos

- Formulários de cadastro (POST) para cada módulo.
- Cálculo de **custo de fabricação** = insumos (consumo × preço) + mão de obra + indiretos.
- **Ficha técnica / BOM**: insumo → peça, base do preço de custo.
- Alertas de estoque mínimo no Dashboard.
- Perfil da empresa + upload da logo real.
