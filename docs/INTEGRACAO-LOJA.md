# Loja (varejo/atacado) + ERP

Integração entre o **site** (WordPress + WooCommerce — `https://brobond.com.br`) e o
**ERP**. Três partes:

1. [Corrigir o botão “Adicionar ao carrinho” da home](#1-corrigir-o-botão-adicionar-ao-carrinho-da-home) (defeito na loja)
2. [Integração ERP ↔ loja](#2-integração-erp--loja) (pedidos e estoque)
3. [Usar o catálogo público do ERP no site](#3-usar-o-catálogo-público-do-erp-no-site) (iframe/JSON)

---

## 1. Corrigir o botão “Adicionar ao carrinho” da home

### Diagnóstico (feito em 11/09/2026)

- Em `/produtos/` está correto: cada produto aponta para a sua página
  (`/produto/calca-jeans-clara/`, `/produto/camiseta-bordada-bb-areia/`…) e o
  botão é **“Ver opções”**.
- Na **home**, todos os botões “Adicionar ao carrinho” apontam para o mesmo
  endereço: `https://brobond.com.br/produto/camiseta-basica-azul/`.
- Resultado: quem clica em “Adicionar ao carrinho” na **Calça Jeans Clara**
  (R$ 130) cai na página da **Camiseta Básica Azul** (R$ 90) e **nada é
  adicionado ao carrinho**.

**Causa:** todos os produtos da loja são **variáveis** (atributo “Tamanho
Camiseta”). Produto variável não aceita “adicionar ao carrinho” direto — o
cliente precisa escolher o tamanho na página do produto. O botão correto é
**“Ver opções”** (ou “Escolher opções”), como o WooCommerce já monta na loja.
Os carrosséis da home receberam um link manual copiado de um único produto.

### Correção (duas opções — a primeira é a recomendada)

**Opção A — deixar o WooCommerce montar os botões (recomendado).**
Substitua o carrossel manual da home por um shortcode de produtos, que já gera
botão e link corretos para cada item:

```text
[products columns="4" limit="8" orderby="popularity" visibility="featured"]
```

ou, para escolher exatamente quais produtos aparecem:

```text
[products columns="4" ids="ID1,ID2,ID3,ID4"]
```

(Os IDs aparecem na lista **Produtos** do painel, na coluna ID, ou na URL ao
editar o produto: `/wp-admin/post.php?post=ID&action=edit`.)

**Opção B — corrigir cada botão do carrossel.**
Onde hoje está o link `https://brobond.com.br/produto/camiseta-basica-azul/`,
troque pelo endereço do produto daquele slide e pelo rótulo correto:

```html
<a class="button" href="https://brobond.com.br/produto/calca-jeans-clara/">Ver opções</a>
```

Endereços conferidos na loja (use o de cada produto do slide):

| Produto                                    | Endereço                                               |
| ------------------------------------------ | ------------------------------------------------------ |
| Calça Jeans Clara                          | `/produto/calca-jeans-clara/`                          |
| Calça Jeans Escura                         | `/produto/calca-jeans-escura/`                         |
| Camiseta Básica Azul                       | `/produto/camiseta-basica-azul/`                       |
| Camiseta Básica Branca                     | `/produto/camiseta-basica-branca/`                     |
| Camiseta Básica Preta                      | `/produto/camiseta-basica-preta/`                      |
| Camiseta Básica Vermelha                   | `/produto/camiseta-basica-vermelha/`                   |
| Camiseta Básica Verde Floresta             | `/produto/camiseta-basica-verde-floresta/`             |
| Camiseta Bordada BB Areia                  | `/produto/camiseta-bordada-bb-areia/`                  |
| Camiseta Bordada BB Azul                   | `/produto/camiseta-bordada-bb-azul/`                   |
| Camiseta Bordada BB Branca                 | `/produto/camiseta-bordada-bb-branca/`                 |
| Camiseta Bordada BB Preta                  | `/produto/camiseta-bordada-bb-preta/`                  |
| Camiseta Bordada BB Verde Floresta         | `/produto/camiseta-bordada-bb-verde-floresta/`         |
| Camiseta Bordada BB Vermelha               | `/produto/camiseta-bordada-bb-vermelha/`               |
| Camiseta Azul Estampa DTF Brobond          | `/produto/camiseta-azul-estampa-dtf-brobond/`          |
| Camiseta Preta Estampa DTF Brobond         | `/produto/camiseta-preta-estampa-dtf-brobond/`         |
| Camiseta Branca Estampa DTF Brobond        | `/produto/camiseta-branca-estampa-dtf-brobond/`        |
| Camiseta Vermelha Estampa DTF Brobond      | `/produto/camiseta-vermelha-estampa-dtf-brobond/`      |
| Camiseta Verde Major Estampa DTF Brobond   | `/produto/camiseta-verde-major-estampa-dtf-brobond/`   |
| Camiseta Verde Major Estampa DTF Unlimited | `/produto/camiseta-verde-major-estampa-dtf-unlimited/` |
| Short de linho Mauricinho (Marfim)         | `/produto/short-de-linho-mauricinho-marfim/`           |

> **Importante:** enquanto o SKU não estiver igual no ERP e na loja, a
> importação de pedidos não consegue casar os itens. Veja a seção 2.

---

## 2. Integração ERP ↔ loja

Módulo: `server/src/loja.ts`. Usa a **REST API v3 do WooCommerce** (Basic Auth
sobre HTTPS) e grava tudo no ERP com auditoria.

### 2.1 Configurar (uma vez)

1. No painel do WordPress: **WooCommerce › Configurações › Avançado › API REST**
   → _Adicionar chave_. Descrição “ERP”, usuário = um admin, permissões
   **Leitura/Gravação**. Copie a **Consumer key** (`ck_…`) e a
   **Consumer secret** (`cs_…`).
2. Na Render (Environment) do ERP:

   ```text
   WOOCOMMERCE_URL = https://brobond.com.br
   WOOCOMMERCE_CK  = ck_...
   WOOCOMMERCE_CS  = cs_...
   WOOCOMMERCE_STATUS = processing        # opcional: status dos pedidos importados
   WOOCOMMERCE_CANAL  = site_varejo       # ou site_atacado (lança o canal na venda)
   CATALOGO_EMBED_ORIGENS = https://brobond.com.br   # sites que podem incorporar o catálogo
   ```

3. Reinicie o serviço (a Render faz isso ao salvar).

### 2.2 Endpoints

| Método | Rota                                    | O que faz                                                      |
| ------ | --------------------------------------- | -------------------------------------------------------------- |
| GET    | `/api/marketplace/loja/status?testar=1` | Diz se está configurado e se a loja responde                   |
| GET    | `/api/marketplace/loja/produtos`        | Relatório: SKU do ERP × loja (saldo, preço, se existe na loja) |
| POST   | `/api/marketplace/loja/pedidos`         | Importa pedidos da loja como **Vendas**                        |
| POST   | `/api/marketplace/loja/estoque`         | Empurra o saldo do ERP para a loja                             |

Exemplo (importar os pedidos “processing” dos últimos 7 dias):

```bash
curl -X POST "$ERP/api/marketplace/loja/pedidos" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"dias": 7, "status": "processing", "limite": 50}'
```

Resposta:

```json
{
  "ok": true,
  "importados": [{ "pedido": "5001", "venda_id": 812, "total": 190 }],
  "ignorados": [],
  "pendentes": [],
  "total_encontrados": 1
}
```

### 2.3 Regras (para não dar prejuízo)

- **Idempotente:** o nº do pedido da loja é gravado em `vendas.pedido_cliente`
  como `WOO-<id>`. Rodar duas vezes **não duplica** — o pedido volta em
  `ignorados`.
- **Não inventa cadastro:** item cujo SKU não existe no ERP fica fora do pedido
  e aparece em `pendentes` (com o nome/SKU) e nas observações da venda.
- **Pedido entra como “Cotação / Pedido do site”** (`status=cotacao`): não baixa
  estoque nem fatura sozinho — alguém confere e fatura.
- **Tamanho:** vem do atributo da variação (`pa_tamanho`, `Tamanho`…); se não
  vier, usa o primeiro tamanho com saldo do produto.
- **Cliente:** criado (ou reaproveitado) pelo e-mail, como tipo `varejo`
  (ou `atacadista`, quando `WOOCOMMERCE_CANAL=site_atacado`).
- **Estoque:** só envia produtos com `exibir_site` ativo; casa por SKU exato e,
  para variações, por `<SKU>-<TAMANHO>`; o que não encontra volta em
  `nao_encontrados` — o ERP nunca cria produto na loja.
- **Falha da loja ≠ erro do sistema:** rede/credencial ruim vira **502** com
  mensagem dizendo o que conferir.

### 2.4 Casamento de SKU (o ponto crítico)

O ERP procura o produto pelo **SKU** (`produtos.sku`, único). Na loja, o SKU
pode estar no produto ou em cada variação. Convenção adotada:

| Onde               | Formato aceito                        |
| ------------------ | ------------------------------------- |
| Produto simples    | `CAM-BB-AZUL`                         |
| Variação (tamanho) | `CAM-BB-AZUL-M` (SKU + `-` + tamanho) |

Se a loja usar o mesmo SKU em todas as variações, cadastre o SKU por variação
(WooCommerce › Produto › Variações › cada tamanho tem campo SKU) — assim o
saldo por tamanho chega certo no site.

---

## 3. Usar o catálogo público do ERP no site

O ERP já publica catálogos por link (token). Agora eles também podem ser
**incorporados no site** e **consumidos por JavaScript** (CORS liberado para
leitura dos endpoints `/api/publico/*`).

### 3.1 Incorporar (mais simples)

Em qualquer página/bloco HTML do WordPress:

```html
<iframe
  src="https://erp.brobond.com.br/api/publico/catalogo/SEU_TOKEN/embed"
  style="width:100%;height:900px;border:0"
  loading="lazy"
  title="Catálogo BROBOND"
></iframe>
```

- O botão **Comprar** de cada produto leva para a busca do produto na loja pelo
  SKU (`https://brobond.com.br/?post_type=product&s=SKU`) — a vitrine do ERP
  alimenta o carrinho do WooCommerce sem duplicar cadastro.
- Se o catálogo tiver senha, a própria página incorporada pede a senha.
- Só os sites listados em `CATALOGO_EMBED_ORIGENS` conseguem incorporar
  (o CSP `frame-ancestors` é uma lista fechada — nunca `*`).

### 3.2 Consumir os dados (JSON)

```js
const r = await fetch('https://erp.brobond.com.br/api/publico/catalogo/SEU_TOKEN');
const { nome, produtos } = await r.json();
// produtos[0] = { id, sku, nome, cor, preco, preco_venda, preco_atacado, foto_url, tamanhos: [...] }
```

O endpoint `/api/publico/catalogo/:token/pedido` continua recebendo carrinhos e
gerando a cotação no ERP — dá para montar a vitrine inteira no site e usar o
ERP só como “motor” de preço/estoque/pedido.

### 3.3 Varejo × atacado

- Catálogo com `canal = atacado` mostra a tabela de atacado (`preco_atacado`).
- Pedidos importados da loja entram com `canal_venda = site_varejo` ou
  `site_atacado` (conforme `WOOCOMMERCE_CANAL`), e aparecem nos relatórios por
  canal.

---

## 4. Rotina sugerida

| Quando                      | Ação                                                                    |
| --------------------------- | ----------------------------------------------------------------------- |
| Diário                      | `POST /api/marketplace/loja/pedidos` (últimos 7 dias)                   |
| Após conferência de estoque | `POST /api/marketplace/loja/estoque`                                    |
| Semanal                     | `GET /api/marketplace/loja/produtos` — confere SKUs sem correspondência |

Tudo fica registrado na **Auditoria** do ERP (quem sincronizou, quantos pedidos
entraram, o que ficou pendente).
