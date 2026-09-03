# BROBOND ERP — Relatório de Auditoria e Plano de Evoluções

**Data:** 03/09/2026 · **Base auditada:** branch `main` (commit `2672fba`) · **Versão atual:** 0.2
**Objetivo:** identificar o que falta para profissionalizar o sistema e propor um plano de mudanças **para aprovação**.

> **Status (03/09/2026):** plano **aprovado integralmente** pelo proprietário. Decisões:
> banco gratuito (Neon), fotos gratuitas (no banco, com opção Cloudinary), cor como
> cadastro **e** texto livre, OP por tamanho **e** por grade, e-mail `jjustino.sousa@gmail.com`.
> Itens marcados `[x]` já foram entregues.

---

## 1. Resumo executivo

O sistema está **bem construído para o estágio atual**: arquitetura limpa (definição única dos módulos em `resources.ts` gera API, validação, formulário e tabela), auditoria completa, perfis de acesso, senhas com bcrypt, migração automática do banco e deploy contínuo na Render. A base é sólida e vale a pena evoluir sobre ela.

Porém, para operar uma confecção **no dia a dia** há cinco lacunas que pesam mais que todas as outras:

| # | Lacuna | Impacto no negócio |
|---|---|---|
| 1 | **Produto sem foto, sem categoria, sem código de barras** | Catálogo não é apresentável para cliente/representante; conferência física depende de ler SKU |
| 2 | **Vendas e Compras não têm itens** (só "total" digitado à mão) | Venda **não baixa o estoque**; compra **não dá entrada de insumo**; total pode divergir dos produtos |
| 3 | **Ficha técnica sem lista de insumos** | Custo de fabricação real não existe → preço de venda é "chute" |
| 4 | **Inventário e Relatórios são páginas vazias** | Não há como conferir estoque nem exportar nada para contador/sócio |
| 5 | **Riscos operacionais na hospedagem gratuita** | Disco efêmero (arquivos somem no deploy), Postgres free com prazo de expiração, servidor "dorme" |

As tabelas `itens_venda`, `itens_compra` e `itens_ficha_tecnica` **já existem no banco** (schema.sql), mas nunca foram ligadas à API nem à tela — ou seja, o item 2 e o item 3 foram previstos e estão pela metade.

---

## 2. O que está bom (manter)

- Arquitetura orientada a metadados: adicionar campo = 1 linha em `resources.ts` + 1 linha no `schema.sql`.
- Segurança básica correta: JWT, bcrypt, `senha_hash` nunca sai da API, usuário desativado cai na hora, proteção do último admin, SQL 100% parametrizado (nomes de tabela/coluna nunca vêm do usuário).
- Regras de estoque coerentes: movimentação imutável, saída sem saldo bloqueada, OP concluída dá entrada (e estorna se reaberta), saldo único por produto+tamanho+local.
- Auditoria com diff de campos (`de` → `para`).
- Modo demonstração em memória: ótimo para treinar equipe sem sujar o banco.
- UI consistente em português, com validação por campo, toasts, modal de confirmação, busca, ordenação e paginação.

---

## 3. Achados da auditoria (por área)

### 3.1 Cadastro de Produtos (foco do pedido)

| Achado | Situação hoje | Recomendação |
|---|---|---|
| Sem **foto** | Não existe nenhum tipo de campo de arquivo/imagem no sistema | Criar tipo de campo `image` genérico (serve para produto, insumo, logo de cliente) |
| Sem **categoria / tipo de peça** | Só SKU, nome, cor, coleção | Cadastro "Categorias" (camisa, camiseta, calça, bermuda, jaqueta…) |
| Sem **código de barras (EAN/GTIN)** | — | Campo `codigo_barras` + geração de etiqueta imprimível |
| Sem **composição / tecido / gramatura / NCM** | — | Campos opcionais; NCM prepara para NF-e no futuro |
| Cor é texto livre | "Azul", "azul", "AZUL" viram 3 cores | Cadastro "Cores" (nome + hex) com bolinha colorida na tabela |
| Sem página de detalhe | Só a linha da tabela e o modal de edição | Página do produto: foto grande, dados, **grade de estoque por tamanho/local**, últimas movimentações, ficha técnica e custo |
| Sem descrição comercial | — | `descricao` (textarea) para catálogo |

### 3.2 Vendas e Compras

| Achado | Risco |
|---|---|
| `total` é digitado manualmente | Total não bate com os produtos vendidos; erro humano |
| Venda não movimenta estoque | Estoque físico fica errado logo após a primeira venda |
| Compra não movimenta insumo | Não existe controle de estoque de insumos (só "custo médio" estático) |
| Sem condição de pagamento, desconto, frete, prazo de entrega | Pedido não serve como documento comercial |
| Sem impressão/PDF do pedido | Representante não tem o que mandar para o cliente |
| Comissão do representante existe no cadastro mas nunca é calculada | Relatório de comissão impossível |

### 3.3 Produção e Custo

| Achado | Risco |
|---|---|
| OP é por **um único tamanho** | Para produzir uma grade PP–GG são 5 OPs; operação confusa |
| Ficha técnica sem lista de insumos (tabela `itens_ficha_tecnica` órfã) | Custo de fabricação não calcula |
| Módulo "Custo de Fabricação" vazio | Depende do item acima |
| OP concluída não consome insumos | Estoque de insumos nunca baixa |
| Sem etapas (corte → costura → acabamento) nem facção externa | Não se sabe onde a peça está |

### 3.4 Estoque

| Achado | Risco |
|---|---|
| `local` é texto livre | "almoxarifado" ≠ "Almoxarifado" → saldos duplicados |
| Sem transferência entre locais | Precisa de saída + entrada manuais |
| Módulo Inventário vazio | Sem contagem física periódica |
| Sem estoque de **insumos** (só de produtos acabados) | Falta tecido e ninguém sabe |
| Sem visão em **grade** (produto × tamanhos) | Tabela linha a linha dificulta ver o todo |

### 3.5 Segurança

| Achado | Gravidade | Recomendação |
|---|---|---|
| Login **sem limite de tentativas** | Alta | Rate limit (ex.: 5 tentativas / 15 min por IP+e-mail) + registrar na auditoria |
| `JWT_SECRET` tem valor padrão (`brobond-dev-secret`) | Alta em produção | Recusar iniciar em produção sem segredo definido (Render já gera, mas o código deve exigir) |
| CORS aceita qualquer origem (`origin: true`) | Média | Restringir a `brobond.com.br` + localhost em dev |
| Compatibilidade com senha em texto puro (`verifyPassword`) | Média | Migrar e remover o fallback |
| Sem cabeçalhos de segurança (helmet) | Média | Adicionar `helmet` |
| Sem "esqueci minha senha" | Média (operacional) | Reset por e-mail (HostGator SMTP) com token de uso único |
| Sem política de senha (só mínimo 6) | Baixa | Mínimo 8 + bloquear senhas óbvias |
| Sem expiração de sessão por inatividade / "lembrar-me" | Baixa | Refresh token opcional |

### 3.6 Infraestrutura e operação

| Achado | Risco | Recomendação |
|---|---|---|
| **Disco da Render é efêmero** | Qualquer upload salvo em disco **some no próximo deploy** | Fotos precisam ir para armazenamento externo (ver §4.1) |
| Postgres plano **free** da Render tem prazo de expiração e sem backup automático | **Perda total de dados** | Migrar para plano pago (≈US$ 7/mês) **ou** rotina de backup diário (`pg_dump`) para storage externo |
| Serviço web free "dorme" após inatividade | Primeiro acesso do dia demora 30–60 s | Plano pago ou aceitar o comportamento |
| Sem testes automatizados nem CI | Regressão silenciosa nas regras de estoque | GitHub Actions: typecheck + testes das regras de negócio a cada push |
| Sem monitoramento de erros | Erro em produção só aparece se alguém reclamar | Sentry (free) ou ao menos log estruturado |
| Versão inconsistente (`package.json` 0.1.0 / API 0.2.0 / tela "0.2") | Cosmético | Fonte única de versão |
| `.env.example` com senha padrão `brobond123` | Baixa | Forçar troca no primeiro login |

### 3.7 Usabilidade e apresentação

| Achado | Recomendação |
|---|---|
| Listas só têm busca textual | Filtros por status, coleção, categoria, período, ativo/inativo |
| Sem exportação | Botão "Exportar Excel/CSV" em todas as listas |
| Sem importação | Importar produtos/clientes via planilha (migração inicial) |
| Página inicial (Dashboard) sem gráficos | Vendas por mês, produção por semana, top produtos |
| Sem atalhos de teclado / ações em lote | Baixa prioridade |
| Mobile funciona, mas tabelas largas rolam horizontalmente | Cards em telas pequenas para Produtos e Estoque |
| Sem "ajuda" contextual | Tooltip/hint já existe por campo; falta um "guia rápido" |

---

## 4. Plano de mudanças proposto

Organizado em fases. Esforço em **dias úteis de desenvolvimento** (estimativa).

### FASE 1 — Catálogo profissional de produtos (≈ 5 dias)

- [x] **1.1 Fotos de produtos** (até 5 por produto, uma marcada como principal)
  - Novo tipo de campo `image`/`images` no `resources.ts` (reutilizável em qualquer módulo)
  - Upload com redimensionamento **no navegador** (máx. 1600 px, JPEG ~85 %) antes de enviar → arquivos leves
  - Miniatura na tabela de produtos e nos selects de produto (estoque, OP, venda)
  - Galeria na página de detalhe com zoom
  - **Armazenamento (decisão necessária — ver §5):**
    - **Opção A (recomendada): Cloudinary** — plano gratuito (25 GB), redimensiona/otimiza automaticamente, CDN, zero manutenção
    - **Opção B: Cloudflare R2 / AWS S3** — mais barato em escala, mais configuração
    - **Opção C: dentro do Postgres (`bytea`)** — sem serviço externo, mas limita a ~300 KB por foto e pesa o banco (só recomendo como fallback do modo demonstração)
  - Tabela nova `arquivos` (id, recurso, registro_id, url, thumb_url, principal, ordem, criado_por) + auditoria de inclusão/remoção de fotos
- [x] **1.2 Cadastro de Categorias** (camisa, camiseta, calça, bermuda…) e campo `categoria_id` no produto
- [x] **1.3 Cadastro de Cores** (nome + código hex) e troca de `cor` texto por `cor_id`, com migração automática dos valores existentes
- [x] **1.4 Novos campos do produto:** `codigo_barras` (EAN-13, único), `descricao`, `composicao`, `ncm`, `peso_g`
- [x] **1.5 Página de detalhe do produto** (`/produtos/:id`): foto, dados, grade de estoque (tamanhos × locais), últimas movimentações, OPs abertas, ficha técnica/custo
- [x] **1.6 Etiqueta imprimível** com código de barras (SKU, nome, tamanho, cor, preço) — impressão em lote por OP ou por produto

### FASE 2 — Vendas e Compras completas (≈ 6 dias)

- [x] **2.1 Itens do pedido de venda** (produto + tamanho + quantidade + preço unitário + desconto) com **total calculado**
- [x] **2.2 Baixa automática de estoque** ao faturar (e estorno ao cancelar), com bloqueio se não houver saldo
- [x] **2.3 Itens do pedido de compra** (insumo + quantidade + preço) com total calculado; ao "Receber" atualiza **custo médio ponderado** do insumo
- [x] **2.4 Campos comerciais:** condição de pagamento, desconto, frete, previsão de entrega, número do pedido do cliente
- [x] **2.5 PDF do pedido** (logo BROBOND, dados do cliente, itens em grade, totais) para enviar por WhatsApp/e-mail
- [x] **2.6 Comissão calculada** por venda faturada (usa `comissao_pct` do representante) + relatório por período

### FASE 3 — Produção e custo real (≈ 5 dias)

- [ ] **3.1 OP por grade:** uma OP com quantidades PP/P/M/G/GG (em vez de uma OP por tamanho); entrada no estoque por tamanho ao concluir
- [ ] **3.2 Lista de insumos na ficha técnica** (insumo + consumo por peça) — liga a tabela `itens_ficha_tecnica` já existente
- [ ] **3.3 Custo de fabricação calculado:** Σ(consumo × custo médio) + mão de obra + indiretos → custo; custo × (1 + margem) → **preço sugerido**; botão "aplicar ao produto"
- [ ] **3.4 Estoque de insumos:** saldo por insumo, entrada pela compra recebida, baixa automática ao concluir OP (consumo × quantidade)
- [ ] **3.5 Etapas da OP** (corte, costura, acabamento, revisão) com data e responsável/facção — opcional

### FASE 4 — Estoque e Inventário (≈ 3 dias)

- [ ] **4.1 Cadastro de Locais de estoque** (substitui texto livre; migra valores existentes)
- [ ] **4.2 Transferência entre locais** em um único lançamento
- [ ] **4.3 Visão em grade** do estoque (linhas = produto/cor, colunas = tamanhos) com totais e alertas coloridos
- [ ] **4.4 Módulo Inventário:** abrir contagem por local → digitar contado → comparar com sistema → gerar ajustes em lote com auditoria
- [ ] **4.5 Leitura por código de barras** (câmera do celular ou leitor USB) na movimentação e no inventário

### FASE 5 — Relatórios e exportação (≈ 3 dias)

- [ ] **5.1 Exportar Excel/CSV** em todas as listas (respeitando filtro e busca)
- [ ] **5.2 Filtros avançados** (status, coleção, categoria, período, ativo) nas listas
- [ ] **5.3 Relatórios prontos:** posição de estoque valorizada · movimentações por período · produção por período · vendas por cliente/representante/coleção · curva ABC de produtos · comissões
- [ ] **5.4 Gráficos no Dashboard** (vendas por mês, produção por semana, top 10 produtos)
- [ ] **5.5 Importação por planilha** (produtos, clientes, fornecedores, saldo inicial) para migração de dados

### FASE 6 — Segurança e robustez (≈ 2 dias) — recomendo fazer **junto com a Fase 1**

- [x] **6.1 Rate limit no login** + bloqueio temporário + evento na auditoria
- [x] **6.2 Exigir `JWT_SECRET` em produção**; restringir CORS ao domínio; adicionar `helmet`
- [ ] **6.3 "Esqueci minha senha"** por e-mail (SMTP HostGator) e **troca obrigatória no primeiro acesso**
- [ ] **6.4 Remover fallback de senha em texto puro** (após confirmar que não há usuário antigo)
- [ ] **6.5 Backup diário automático do Postgres** (job na Render → arquivo em Cloudflare R2/S3, retenção 30 dias) **ou** upgrade do banco para plano pago
- [x] **6.6 Testes automatizados das regras de estoque/OP/venda + GitHub Actions** (typecheck + testes a cada push; bloqueia deploy quebrado)
- [ ] **6.7 Monitoramento de erros** (Sentry free) e versão única do sistema

### FASE 7 — Acabamento (≈ 2 dias, opcional)

- [ ] **7.1 Cards em vez de tabela no celular** para Produtos e Estoque
- [ ] **7.2 PWA** (ícone na tela do celular, funciona como app)
- [ ] **7.3 Preferências por usuário:** colunas visíveis, itens por página
- [ ] **7.4 Catálogo público somente leitura** (link com senha para representantes/clientes verem fotos, grade e preço) — grande ganho comercial com pouco esforço depois da Fase 1

---

## 5. Decisões que preciso de você

1. **Fotos:** ✅ gratuito — no próprio banco por padrão; Cloudinary (25 GB grátis) opcional via variável de ambiente.
2. **Banco de dados:** ✅ gratuito — **Neon** (permanente) em vez do free da Render (expira em 30 dias). Guia: `docs/CONFIGURACAO-GRATUITA.md`.
3. **Ordem das fases:** ✅ 1 → 6 → 2 → 3 → 4 → 5 → 7 (todas aprovadas).
4. **Cor:** ✅ as duas — cadastro com amostra colorida **e** campo de texto livre.
5. **OP por grade:** ✅ as duas formas (por tamanho, como hoje, e por grade).
6. **E-mail:** ✅ `jjustino.sousa@gmail.com` (Gmail → exige senha de app; ver guia).

---

## 6. Resumo de esforço

| Fase | Conteúdo | Dias |
|---|---|:-:|
| 1 | Fotos, categorias, cores, detalhe do produto, etiquetas | 5 |
| 6 | Segurança, backup, testes/CI | 2 |
| 2 | Itens de venda/compra, baixa de estoque, PDF, comissão | 6 |
| 3 | OP por grade, BOM, custo real, estoque de insumos | 5 |
| 4 | Locais, transferência, grade, inventário, código de barras | 3 |
| 5 | Exportação, filtros, relatórios, gráficos, importação | 3 |
| 7 | Mobile, PWA, preferências, catálogo público | 2 |
| **Total** | | **≈ 26 dias úteis** |

Cada fase é entregue em um Pull Request separado, com migração de banco idempotente (padrão atual), funcionando também no modo demonstração, e com o README atualizado.

---

## 7. Anexo — Especificação técnica da Fase 1.1 (Fotos)

```
db/schema.sql
  CREATE TABLE arquivos (
    id SERIAL PRIMARY KEY,
    recurso TEXT NOT NULL,          -- 'produtos', 'insumos'...
    registro_id INTEGER NOT NULL,
    url TEXT NOT NULL,              -- imagem otimizada (CDN)
    thumb_url TEXT,                 -- miniatura 200px
    nome_original TEXT,
    tamanho_bytes INTEGER,
    principal BOOLEAN DEFAULT FALSE,
    ordem INTEGER DEFAULT 0,
    criado_por INTEGER,
    criado_em TIMESTAMPTZ DEFAULT now()
  );
  CREATE INDEX idx_arquivos_registro ON arquivos (recurso, registro_id);

server/src
  resources.ts   → FieldType += 'images'; produtos.fields += { name:'fotos', type:'images', max:5 }
  uploads.ts     → POST /api/:recurso/:id/arquivos (multipart, máx. 5 MB, só image/jpeg|png|webp)
                   DELETE /api/:recurso/:id/arquivos/:arquivoId
                   PUT    /api/:recurso/:id/arquivos/:arquivoId/principal
                   provider: cloudinary | s3 | db (escolhido por variável de ambiente)
  services.ts    → auditoria "foto incluída/removida"; ao excluir produto remove arquivos

client/src
  components/ImageField.tsx  → arrastar/soltar, redimensiona no navegador, barra de progresso, reordenar, marcar principal
  pages/ProductDetail.tsx    → galeria + grade de estoque + histórico
  ModulePage.tsx             → miniatura (40px) na primeira coluna quando o recurso tem 'images'
  RecordForm.tsx             → renderiza ImageField (após salvar o registro, no caso de inclusão)

render.yaml / .env.example
  UPLOAD_PROVIDER=cloudinary
  CLOUDINARY_URL=cloudinary://...
```

Modo demonstração (sem banco): fotos ficam em memória como data-URL, apagadas ao reiniciar — mesmo comportamento dos demais dados.
