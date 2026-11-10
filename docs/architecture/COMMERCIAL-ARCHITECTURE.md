# COMMERCIAL-ARCHITECTURE — arquitetura comercial (Fase 9.4)

**Data:** 2026-11-09 · **Branch:** `architecture/fases-9-4-9-5-9-6`
**Base:** `main` (`7c665b5`) · **ADRs:** ADR-0005, ADR-0006, ADR-0007, ADR-0008
**Código:** `server/src/commerce/canaisComerciais.ts`, `server/src/commerce/woocommerce/registry.ts`

> **Regra.** O ERP é o **núcleo operacional e a autoridade** dos dados mestres
> (produto, SKU, variação, preço interno, estoque, cliente, pedido). Nenhum
> conector externo cria um segundo cadastro mestre.

## 1. Canais oficiais

| Canal | Experiência | Endereço | Loja (`store_key`) |
|---|---|---|---|
| RETAIL | WooCommerce | https://brobond.com.br | `RETAIL` |
| WHOLESALE | WooCommerce | https://atacado.brobond.com.br | `WHOLESALE` |
| REPRESENTATIVES | Portal de representantes | https://catalogo.brobond.com.br | — (canal próprio) |

## 2. Visão unificada dos canais

`GET /api/commerce/canais` (`listarCanaisComerciais`,
`server/src/commerce/canaisComerciais.ts`) devolve os **três** canais com:

- `canal`, `rotulo`, `plataforma`, `endereco`;
- `loja` (`store_key`), `preco_fonte`, `canal_venda`;
- `estado`: `nao_configurado` · `configurado` · `conectado` · `erro` ·
  `nao_homologado`;
- `conexao` (`{ ok, erro? }`), `ultima_sincronizacao`, `ultimo_erro`,
  `pendencia`, `evidencia`.

### 2.1 Regra de honestidade (a razão do módulo existir)

- Um canal **nunca** aparece como `conectado` sem **evidência real**: o teto sem
  teste é `configurado`; `conectado` **só** após o teste autenticado
  (`?testar=1`, leitura) responder OK.
- **REPRESENTATIVES** não tem conector no repositório → `nao_homologado`, jamais
  conectado.
- Nenhuma credencial (CK/CS/token) é devolvida.
- RBAC: **gerente**/**admin** apenas (o `operador` recebe 403). Escopo por
  empresa via `escopoDoAtor`.

> **A loja nativa `/loja` NÃO é um canal público oficial.** Ela segue **ativa**
> como superfície, mas a retirada está **BLOQUEADA** por dívidas externas
> (ADR-0007, impedimentos I-1..I-4). Ver
> [`NATIVE-STORE-DECOMMISSION.md`](NATIVE-STORE-DECOMMISSION.md).

## 3. Identidade comercial canônica

Ver [`COMMERCIAL-IDENTITY.md`](COMMERCIAL-IDENTITY.md). Em síntese:

```
pedido externo = empresa + canal + loja (store_key) + plataforma + id externo
referência     = WOO-<store_key>-<id_externo>   (ex.: WOO-RETAIL-1001)
```

`RETAIL` e `WHOLESALE` são **imutáveis** (não derivam da URL nem do nome da
loja): trocar o domínio não reclassifica vínculo histórico. Nenhum ID externo é
globalmente único — o `store_key` é o namespace.

## 4. Autoridade de preço

| Canal | Fonte de preço |
|---|---|
| RETAIL | `produtos.preco_venda` |
| WHOLESALE | `produtos.preco_atacado` |
| regras várias | `atacado_min_qtd` quando aplicável; `commerce_precos` para regra específica de loja |

Preço recebido de plataforma externa **não** substitui automaticamente o preço
autorizado no ERP.

## 5. Isolamento e multi-loja

Ver [`WOOCOMMERCE-INTEGRATION.md`](WOOCOMMERCE-INTEGRATION.md). Uma loja nunca
serve duas empresas; credenciais, pedidos e clientes de lojas diferentes nunca
se misturam.

## 6. Interface

`client/src/pages/commerce/CanaisComerciaisPanel.tsx`, montado em
`OmnichannelPage.tsx`. Apresenta os três canais com estado de conexão/
sincronização e origem dos pedidos, usando o padrão `PageShell` +
`PageLoading`/`PageError`. **Não** exibe canal conectado sem evidência.

## 7. Status

| Item | Status |
|---|---|
| Canais oficiais declarados | **IMPLEMENTADO E TESTADO** |
| Visão unificada + honestidade de estado | **IMPLEMENTADO E TESTADO** |
| RBAC + tenant scope | **IMPLEMENTADO E TESTADO** |
| Isolamento RETAIL/WHOLESALE (registry multi-loja) | **IMPLEMENTADO E TESTADO** |
| Conector REPRESENTATIVES | **NÃO IMPLEMENTADO** (homologação externa) |
| Retirada da `/loja` nativa | **BLOQUEADO** (I-1..I-4) |
