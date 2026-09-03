# Configuração 100 % gratuita — banco de dados e fotos

Este guia deixa o BROBOND ERP rodando em produção **sem custo**, com os dados
seguros (o banco não expira) e as fotos dos produtos servidas por CDN.

| Serviço | Para quê | Plano gratuito | Limite prático |
|---|---|---|---|
| **Render** (já usado) | Hospeda a API + o site | 750 h/mês | Serviço "dorme" após 15 min sem uso; o 1º acesso do dia demora ~30 s |
| **Neon** (novo) | Banco PostgreSQL | 0,5 GB, **sem prazo de expiração** | ~1 milhão de registros ou ~3.000 fotos guardadas no banco |
| **Cloudinary** (opcional) | Fotos em CDN | 25 GB de armazenamento + 25 GB/mês de tráfego | ~150.000 fotos otimizadas |

> **Por que não o Postgres gratuito da Render?** Ele **expira 30 dias** após a
> criação e a Render apaga o banco (com todos os dados) depois de um curto período
> de carência. Não serve para produção.

---

## 1. Banco de dados no Neon (obrigatório) — ~5 minutos

1. Acesse <https://neon.tech> → **Sign up** (pode entrar com a conta do GitHub).
2. **Create project**:
   - Name: `brobond`
   - Postgres version: 17 (ou a mais recente)
   - Region: **AWS South America (São Paulo)** se disponível; senão **US East**.
3. Na tela do projeto clique em **Connect** → copie a **connection string**.
   Ela tem este formato:
   ```
   postgresql://neondb_owner:SENHA@ep-xxxx-xxxx.sa-east-1.aws.neon.tech/neondb?sslmode=require
   ```
4. No painel da **Render** → serviço `brobond-erp` → **Environment**:
   - `DATABASE_URL` = a string copiada acima
   - Salve. A Render faz o redeploy e a API **cria todas as tabelas sozinha**
     (log: `🗄️ Schema verificado/migrado`).
5. Entre no sistema. Em **Configurações › Sistema** deve aparecer
   **Banco de dados: PostgreSQL**.

### Migrar os dados do banco antigo da Render (se houver)

Se você já tem dados no Postgres da Render, antes de trocar a variável:

```bash
# 1) exportar do banco antigo (External Database URL no painel da Render)
pg_dump "postgres://USUARIO:SENHA@HOST.render.com/brobond" --no-owner --no-privileges -Fc -f brobond.dump

# 2) importar no Neon
pg_restore --no-owner --no-privileges -d "postgresql://...neon.tech/neondb?sslmode=require" brobond.dump
```

Depois troque a `DATABASE_URL` na Render conforme o passo 4. A migração para as
tabelas novas (cores, categorias, arquivos…) é automática.

### Backup

O Neon mantém histórico (point-in-time restore) de **24 h** no plano gratuito.
Para um backup mensal manual:

```bash
pg_dump "$DATABASE_URL" -Fc -f brobond-$(date +%Y-%m-%d).dump
```

Guarde o arquivo no Google Drive / OneDrive. (Backup automático diário está
previsto na Fase 6 do roteiro.)

---

## 2. Fotos dos produtos

### Opção A — no próprio banco (padrão, zero configuração)

Não precisa fazer nada. As fotos são reduzidas pelo navegador antes de subir
(~150 KB cada) e ficam no Postgres. Com 0,5 GB do Neon cabem **~3.000 fotos**
além dos dados. Em **Configurações › Sistema** aparece **Fotos: No banco de dados**.

### Opção B — Cloudinary (recomendada quando passar de ~1.000 fotos)

1. Acesse <https://cloudinary.com/users/register_free> → crie a conta.
2. No **Dashboard** copie a **API environment variable**, no formato:
   ```
   CLOUDINARY_URL=cloudinary://123456789012345:AbCdEfGhIjKlMnOpQrStUvWxYz@seu-cloud
   ```
3. Na **Render** → **Environment**:
   - `UPLOAD_PROVIDER` = `cloudinary`
   - `CLOUDINARY_URL` = `cloudinary://...` (só o valor, sem o `CLOUDINARY_URL=`)
   - (opcional) `CLOUDINARY_FOLDER` = `brobond`
4. Salve → redeploy. Em **Configurações › Sistema** aparece **Fotos: Cloudinary (CDN)**.

As fotos já enviadas antes da troca continuam funcionando (ficam no banco);
apenas as novas vão para o Cloudinary.

---

## 3. E-mail do sistema (para a futura recuperação de senha)

A conta informada (`jjustino.sousa@gmail.com`) é **Gmail**. O Gmail não aceita a
senha normal em sistemas — é preciso gerar uma **senha de app**:

1. Ative a verificação em duas etapas na conta Google.
2. Acesse <https://myaccount.google.com/apppasswords> → **Criar** → nome `BROBOND ERP`.
3. Copie a senha de 16 letras.
4. Na Render → **Environment** (quando a funcionalidade for publicada):
   - `SMTP_HOST` = `smtp.gmail.com`
   - `SMTP_PORT` = `587`
   - `SMTP_USER` = `jjustino.sousa@gmail.com`
   - `SMTP_PASS` = a senha de app
   - `SMTP_FROM` = `BROBOND ERP <jjustino.sousa@gmail.com>`

> Nunca envie essa senha por chat ou e-mail; cadastre-a **somente** no painel da Render.

---

## 4. Checklist final

- [ ] `DATABASE_URL` aponta para o Neon (`...neon.tech...sslmode=require`)
- [ ] `ADMIN_PASSWORD` definido (e trocado pela interface após o 1º login)
- [ ] `JWT_SECRET` gerado pela Render (em produção a API **não inicia** sem ele)
- [ ] Configurações › Sistema mostra **PostgreSQL** e a versão **0.3.0**
- [ ] (Opcional) `UPLOAD_PROVIDER=cloudinary` + `CLOUDINARY_URL`
- [ ] Banco gratuito antigo da Render pode ser apagado depois da migração
