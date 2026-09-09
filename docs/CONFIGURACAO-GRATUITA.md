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
   - `APP_URL` = o endereço público do ERP — **obrigatório junto com o SMTP**: é a
     base dos links que saem por e-mail. Na URL da Render, use algo como
     `https://brobond-erp.onrender.com`; com domínio próprio, `https://erp.brobond.com.br`.

> Nunca envie essa senha por chat ou e-mail; cadastre-a **somente** no painel da Render.

### Por que o `APP_URL` importa tanto

O convite de acesso e a redefinição de senha mandam um link
(`…/convite/<token>`). Se o servidor não sabe o próprio endereço público, o link
sai **pela metade** — sem `https://dominio` na frente — e o Gmail/Outlook responde
**“URL inválida”** para quem clica (foi o que aconteceu com convites antigos).

Desde a correção, sem `APP_URL` o servidor deduz o endereço de quem gerou o
convite (cabeçalho `X-Forwarded-Proto`/`Host`) e o aviso aparece no boot e em
**Configurações › Sistema**; ainda assim, em produção **defina `APP_URL`** — é o
único jeito de garantir o link certo se o ERP mudar de domínio, porta ou proxy.

**Atenção ao valor:** em produção a `APP_URL` precisa ser um endereço público.
`http://localhost:5173` (o valor que vem no `.env.example`, de desenvolvimento)
produz um link “bonito” que não abre para ninguém — o sócio clica e vê **“URL
inválida”**. Endereços internos (localhost, `127.0.0.1`, `10.x`, `192.168.x`,
nome sem domínio, `.local`) são **descartados** pelo servidor: ele usa a origem
da requisição, avisa no boot e mostra `APP_URL ignorada` em Configurações ›
Sistema.

Depois de corrigir a variável, **reenvie o convite** (Usuários → linha do usuário
→ Reenviar convite): o convite antigo continua quebrado porque o link já saiu.

---

## 4. Checklist final

- [ ] `DATABASE_URL` aponta para o Neon (`...neon.tech...sslmode=require`)
- [ ] `ADMIN_PASSWORD` definido (e trocado pela interface após o 1º login)
- [ ] `JWT_SECRET` gerado pela Render (em produção a API **não inicia** sem ele)
- [ ] Configurações › Sistema mostra **PostgreSQL** e a versão **0.3.0**
- [ ] `SMTP_*` **e** `APP_URL` definidos juntos (e-mail com link que abre)
- [ ] (Opcional) `UPLOAD_PROVIDER=cloudinary` + `CLOUDINARY_URL`
- [ ] Banco gratuito antigo da Render pode ser apagado depois da migração
