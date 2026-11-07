# Agente 06 — Auditoria da unificação comercial

**Data:** 2026-11-07
**Base auditada:** `f432ca17be6a68307f4bc0ddebf927a1e02d0774`
**Escopo:** Loja Própria, WooCommerce RETAIL/WHOLESALE e legado, marketplaces, representantes, comissões, catálogo, estoque, pedidos, pagamentos, RBAC, multiempresa e UX operacional.

## Veredito

**NÃO PRONTO PARA PRODUÇÃO E NÃO APROVADO PARA ACEITE DA UNIFICAÇÃO.**

A base possui componentes reais e bem desenvolvidos: catálogo único, motor canônico de estoque, checkout BROBOND, Payment Engine, ponte marketplace → venda, vínculos por loja, inbox/outbox e testes PostgreSQL. Entretanto, a auditoria reproduziu **três defeitos P0** capazes de corrompre valores, vender estoque comprometido ou suprimir pedido legítimo. Também confirmou falhas P1 em variações, analítica, comissões, RBAC, recuperação de marketplace e isolamento do painel.

Este trabalho é somente auditoria. **Nenhum código funcional, migration ou configuração de produção foi alterado.** Os três documentos produzidos são este relatório, o inventário e a matriz.

### Severidade

- **P0:** perda/corrupção de pedido, dinheiro ou estoque; bloqueia ativação.
- **P1:** quebra funcional, de isolamento ou de fechamento financeiro; bloqueia o aceite do fluxo afetado.
- **P2:** limitação operacional/arquitetural ou cobertura incompleta que precisa de decisão/plano.

## 1. Achados P0

### A06-01 — P0: WooCommerce grava preço remoto não confiável no item canônico

**Onde:** `server/src/commerce/woocommerce/pedidos.ts`, `importarUmPedido`; o legado em `server/src/loja.ts` tem a mesma precedência.

O importador usa `line_items[].price` sempre que ele é positivo; o preço do ERP só é fallback. Isso contradiz a autoridade do catálogo ERP para RETAIL (`preco_venda`) e WHOLESALE (`preco_atacado`). Um preço adulterado, obsoleto ou calculado por plugin externo passa a ser o preço da venda, do total, do financeiro e da comissão.

**Reprodução MemStore:** produto com `preco_atacado=60`, pedido WHOLESALE com duas unidades e `line_items[].price=1`.

```text
preco_erp_atacado: 60
preco_recebido_woo: 1
preco_persistido em itens_venda.preco_unitario: 1
```

**Impacto:** receita, margem, contas a receber e comissão erradas. O teste existente usa preço Woo igual ao ERP e não detecta o caso.

**Correção necessária:** definir e implementar uma única política de autoridade de preço na importação; validar/descrever divergências sem gravar preço externo silenciosamente; cobrir RETAIL, WHOLESALE e legado com preço divergente e regras de desconto explicitamente aprovadas.

### A06-02 — P0: sincronização Woo legada publica físico reservado como disponível

**Onde:** `server/src/loja.ts`, `enviarEstoqueLojaInterno`.

O fluxo single-store agrega `estoques.quantidade` por produto/tamanho/texto de local. Não consulta `estoque_reservas`, não distingue reserva/empenho/bloqueio e soma locais em vez de aplicar a célula vendável do motor canônico.

**Reprodução MemStore:** físico 10, reserva ativa 8.

```text
disponivel_canonico: 2
stock_quantity enviado pelo legado: 10
```

**Impacto:** overselling de oito unidades já comprometidas. A diferença também pode ocorrer com múltiplos locais, pois a venda debita uma célula elegível, não necessariamente a soma publicada.

**Correção necessária:** fazer o legado consumir o mesmo disponível canônico ou descontinuar seu caminho de escrita antes de ativá-lo; testar reserva, empenho, bloqueio, locais e variações.

### A06-03 — P0: referência legada de uma loja suprime pedido legítimo da outra

**Onde:** `server/src/commerce/woocommerce/pedidos.ts`, `vendaExistente`.

Antes de inserir, o Multi-Store procura incondicionalmente `WOO-<id>` para preservar histórico. A consulta não verifica se o registro legado pertence à mesma loja/canal. Como os identificadores numéricos Woo são independentes por instalação, `WOO-777` da RETAIL legada faz `WOO-WHOLESALE-777` ser ignorado.

**Reprodução MemStore:** venda RETAIL legada `WOO-777`, novo pedido WHOLESALE `777`.

```text
resultado: { tipo: "ignorado" }
esperado: importar WOO-WHOLESALE-777
```

O índice por `(empresa, pedido_externo_canal, pedido_externo_id)` permitiria corretamente as duas vendas; a consulta prévia impede chegar a ele.

**Impacto:** perda silenciosa de pedido, sem duplicata e sem item pendente para correção.

**Correção necessária:** adoção da referência legada somente com prova de mesma origem/estratégia de migração; nunca deduzir equivalência entre lojas pelo número. Criar teste cruzado RETAIL × WHOLESALE × legado.

## 2. Achados P1

### A06-04 — P1: variação é publicada/sincronizada com estoque zero embora o pai tenha saldo

**Onde:** `commerce/woocommerce/publicacao.ts`, `publicarVariacao`/`disponivelDoProduto`; `commerce/woocommerce/estoque.ts`, `disponiveis`.

O catálogo canônico mantém SKU/preço na variação, mas saldo vendável no pai+tamanho. O Woo Multi-Store calcula disponibilidade pelo ID do filho.

**Reprodução MemStore:** pai com 12 unidades no tamanho M; filho M sem linha de estoque.

```json
{
  "saldo_canonico_pai": [{ "disponivel": 12 }],
  "saldo_consultado_no_filho": [{ "disponivel": 0 }],
  "stock_quantity_enviado_woo": 0,
  "esperado": 12
}
```

**Impacto:** produto legítimo fica indisponível nas duas lojas; a reconciliação pode comparar a mesma leitura errada e não revelar a causa.

**Correção necessária:** resolver pai+tamanho pela relação `produto_pai_id`/`variacao_tamanho_id`, mantendo preço/SKU do filho. Cobrir publicação e sincronização, pai/filho e múltiplos tamanhos.

### A06-05 — P1: vendas Woo Multi-Store ficam fora do BI mesmo depois de faturadas

**Onde:** `commerce/woocommerce/pedidos.ts` e `negocios.ts`, `projetarVendasErp`.

O importador cria somente `vendas` com `pedido_externo_id`; não cria `sales` nem `commerce_pedidos`. A projeção `vendas → sales` exclui toda venda com `pedido_externo_id` porque marketplaces já possuem sua `sale` original. Para Woo, essa original não existe.

**Reprodução MemStore:** uma venda WHOLESALE e uma venda manual, ambas faturadas, projetadas juntas.

```json
{
  "resultado_projecao": { "vendas": 1, "idsProjetados": ["erp:venda:2"] },
  "sales_woo_encontradas": 0,
  "sales_manual_encontradas": 1
}
```

**Impacto:** faturamento, margem, curva ABC e indicadores omitem RETAIL/WHOLESALE; faturar depois não resolve.

**Correção necessária:** criar/adotar representação analítica própria para Woo ou diferenciar explicitamente origens que já possuem `sales`; provar não duplicação no marketplace e presença no Woo.

### A06-06 — P1: comissão dividida perde secundários; reapuração pós-recebimento não fecha o livro

**Onde:** `comercial.ts`, `apurarComissaoDaVenda`; `comissoes.ts`, efetivação e relatórios.

O motor grava apurações para todos, mas copia para `vendas.comissao_valor` apenas o principal. Recebimento e relatório leem somente esse campo e `vendas.representante_id`. O secundário não entra no livro. Além disso, reapurar uma venda já recebida altera a apuração sem criar um evento de ajuste/efetivação.

**Reprodução MemStore:** venda de R$ 100, dois representantes a 50%, 10% cada.

```text
motor: principal R$ 5 + secundário R$ 5 = R$ 10
vendas.comissao_valor após apuração: R$ 5
relatório: somente principal, apurada R$ 5, efetivada R$ 5
comissoes_apuradas ativas: duas linhas de R$ 5
```

**Impacto:** relatório e efetivação subestimam a obrigação; o secundário não possui caminho de pagamento/estorno coerente. Não é duplicidade de motores: apuração e efetivação são estágios distintos com contrato incompleto.

**Correção necessária:** fazer o livro referenciar apurações por representante, reconciliar reapurações e recebimentos anteriores, e testar split, reprocessamento, cancelamento e estorno por participante.

### A06-07 — P1: operador lê comissões apesar do menu exigir gerente

**Onde:** `server/src/comissoes.ts`, `resumoComissoes` e `comissoesDaVenda`; rotas em `server/src/index.ts`; menu em `client/src/modules.ts`.

Os handlers verificam apenas leitura de Vendas e Representantes, recursos sem `minPerfil`. Não exigem gerente como o menu.

**Reprodução direta do handler com ator `operador`:**

```json
{
  "menu_exige": "gerente",
  "resposta_http": 200,
  "acesso_liberado": true,
  "shape_resposta": ["periodo", "linhas", "resumo"]
}
```

**Impacto:** exposição indevida de valores comerciais/remuneração e divergência entre UX e RBAC real.

**Correção necessária:** aplicar alçada gerente/admin nos dois handlers e teste HTTP com operador autenticado, sem depender do menu para segurança.

### A06-08 — P1: reprocessar marketplace com cabeçalho inalterado não recupera item sem catálogo

**Onde:** `modules/connectors/ingestion/sales.service.ts`, `upsertIngestedSale`.

Quando status, total, quantidade e moeda não mudam, a ingestão retorna `unchanged` antes de reescrever/rematchar `sale_items`. É exatamente o cenário de corrigir SKU ou cadastro e reprocessar uma venda em `AGUARDANDO_CORRECAO`.

**Reprodução PostgreSQL 16.14 real:**

```json
{
  "primeira_outcome": "created",
  "product_id_antes": null,
  "reprocessamento_mesmo_cabecalho": {
    "outcome": "unchanged",
    "itemCount": 0,
    "product_id": null
  },
  "reprocessamento_com_valor_alterado": {
    "outcome": "updated",
    "itemCount": 1,
    "product_id": 1359
  }
}
```

**Impacto:** pedido permanece sem produto e sem conversão mesmo após a correção; alterar artificialmente o cabeçalho não é solução operacional válida.

**Correção necessária:** incluir hash/conteúdo dos itens e necessidade de rematch na decisão de unchanged; testar correção de SKU e reprocessamento idempotente sem alterar total/status.

### A06-09 — P1: painel agregado Woo expõe configuração/conexão de loja de outro tenant

**Onde:** `commerce/woocommerce/rotas.ts`, `statusLojas` e `painelLojas`; `registry.statusStores`; `painel.painelTodasLojas`.

As ações individuais chamam `exigirStoreDaEmpresa`, mas as agregadas iteram RETAIL e WHOLESALE sem filtrar `empresaDaStore`. Com `testar=1`, também podem testar a conexão autenticada da outra loja.

**Reprodução:** gerente da empresa 1, RETAIL da empresa 1 e WHOLESALE da empresa 2.

```json
{
  "ator_empresa_id": 1,
  "lojas_expostas": [
    { "store_key": "RETAIL", "url": "https://retail-a.example.com" },
    { "store_key": "WHOLESALE", "url": "https://wholesale-b.example.com" }
  ]
}
```

**Impacto:** vazamento de URL/estado/configuração e ação de leitura externa fora do tenant. O desenho esperado de uma empresa com duas lojas não elimina a necessidade de validar a configuração multiempresa suportada pelo registry.

**Correção necessária:** filtrar ou responder 404 por loja fora do tenant em todas as agregadas; testar duas empresas e `testar=1`.

### A06-10 — P1: identidade de canal e fechamento BROBOND × RETAIL × representante não estão unificados

**Evidências:**

- `sale_channel` contém `BROBOND`, mas não `RETAIL`, `WHOLESALE` ou `REPRESENTATIVE`.
- Woo usa `store_key`/`pedido_externo_canal` em maiúsculas e `vendas.canal_venda` em `site_varejo`/`site_atacado`.
- Representante usa `canal_venda='representante'`; o pacote de domínio possui `REPRESENTATIVE`, mas o banco analítico não.
- `canalErpParaSales` mapeia tudo que não é PDV/balcão para `BROBOND`.
- A loja nativa `/loja` e o RETAIL Woo são identificados em código/rótulos com `brobond.com.br`, mas têm checkouts, pagamentos e projeções diferentes. Não há configuração de DNS/edge no repositório que determine se são a mesma experiência ou experiências distintas.

**Impacto:** relatórios não distinguem as origens; a ausência Woo em A06-05 não pode ser corrigida apenas ligando a projeção sem definir canal. Também não é possível afirmar que “Loja Própria” e “RETAIL” formam uma única jornada pública sem decisão de domínio.

**Correção necessária:** ADR de identidade de canal e de domínio público, migração compatível, mapeamento único para analítica e operação, e estratégia de transição single-store → Multi-Store.

### A06-11 — P1: quantidade mínima WHOLESALE não tem enforcement externo evidenciado

**Onde:** `commerce/woocommerce/precos.ts` e `publicacao.ts`.

O ERP valida a presença do preço e publica `_brobond_atacado_min_qtd`. Não existe no repositório plugin, snippet, webhook de validação ou outro consumer que impeça o WooCommerce de vender abaixo do mínimo. A importação também não verifica `atacado_min_qtd`.

**Impacto:** a documentação “respeita `atacado_min_qtd`” não é demonstrada ponta a ponta; o Woo padrão não deve ser presumido como executor de metadado arbitrário.

**Correção necessária:** identificar/homologar o componente externo ou aplicar política em um checkout controlado; testar pedido abaixo/no/acima do mínimo e importação divergente. Não ativar WHOLESALE afirmando enforcement sem essa evidência.

## 3. Achados P2 e decisões pendentes

### A06-12 — Override de preço não é independente por loja

`commerce_precos` é identificado por empresa/produto/canal, sem `store_key`. `publicacao.ts` busca `canal='WOOCOMMERCE'` para as duas lojas. Assim, uma promoção nesse canal vale tanto para RETAIL quanto para WHOLESALE, apesar das bases distintas. Se a independência comercial incluir campanhas por loja, o modelo precisa de `store_key` ou canais analíticos separados e migração compatível.

### A06-13 — Importação parcial não possui reconciliação automática dos itens ausentes

Se ao menos um item tiver SKU válido, `importarUmPedido` cria a venda com os demais em `pendentes`/observação. Reimportações posteriores retornam `ignorado`; corrigir o SKU não recompõe o pedido. O operador é avisado, portanto não é perda silenciosa como A06-03, mas falta uma jornada de recuperação e reconciliação de itens. A água-marca também pode avançar sobre pendências.

### A06-14 — Representante não é um papel de acesso próprio

`representantes.usuario_id` é vínculo cadastral, não perfil `REPRESENTATIVE`, concessão ou filtro “meus clientes/minhas vendas/minhas comissões”. As páginas encontradas são backoffice. Se o requisito incluir portal do representante, ele não está implementado; deve ser tratado como novo desenho de RBAC, não inferido a partir do cadastro.

### A06-15 — Cutover legado/Multi-Store precisa de runbook explícito

As rotas `/api/marketplace/loja/*` continuam disponíveis e eventos antigos sem `store_key` ainda seguem o executor legado. A flag Multi-Store não desativa esses endpoints. É necessário decidir congelamento de escritas, drenagem do outbox, migração de vínculos e referências e desativação do legado; caso contrário, os defeitos A06-01/A06-02/A06-03 podem coexistir durante a transição.

## 4. O que foi verificado como existente/funcional localmente

- Loja BROBOND calcula preço, estoque, cupom, frete e total no servidor; reserva antes da cobrança e usa Payment Engine.
- A ponte marketplace → `vendas` fatura, baixa estoque e sincroniza financeiro, preservando a `sale` analítica original.
- O motor canônico usa pai+tamanho, local e compromissos; o defeito está em consumidores Woo específicos, não na fórmula central reproduzida.
- Vínculos Woo possuem `store_key`; constraints PostgreSQL permitem o mesmo ID externo em lojas distintas e impedem duplicidade dentro da mesma loja.
- Webhooks Woo falham fechados sem segredo, validam HMAC, deduplicam e confirmam o pedido na API antes de importar.
- Ações individuais Woo exigem gerente/admin e tenant.
- Cadastro, carteira, atribuição, planos/regras, apuração e efetivação por recebimento existem para representante principal.
- Painel Woo operacional existe em Fila & Sync, com reconciliação, divergências e reprocessamento; não é uma interface vazia.

Esses pontos não anulam os achados nem homologam serviços externos.

## 5. Gates e evidências executadas

Ambiente: Node local `v22.22.3`; gates válidos repetidos com Node `v24.22.2`, alinhado ao CI. PostgreSQL descartável `16.14`, provisionado localmente somente para a auditoria e encerrado ao final.

| Comando/gate | Resultado |
|---|---|
| `npm ci --no-audit --no-fund` | 964 pacotes instalados |
| `npm run typecheck` | **PASS** |
| `npm run lint` | **PASS**, 0 erros; 613 warnings existentes |
| `npm run architecture:audit` | **PASS**, 34 avisos; nenhum erro de coerência |
| `npm run audit:menu` | **PASS**, 21 avisos |
| `npm run build` | **PASS** |
| Testes client | **PASS**: 133 arquivos, 1.165 testes |
| Testes server, Node 24 | **PASS**: 2.228 testes; 2.140 aprovados, 88 ignorados, 0 falhas |
| Testes server, arquivo webhook isolado, Node 22 | 15 asserções passam, mas runner falha na desserialização |
| Testes PostgreSQL, Node 24 | **0 falhas**: 446 testes; 433 aprovados, 13 ignorados por ausência de `psql` |
| `npm run smoke` em memória | **PASS**: 398/398 |
| `npm run smoke:pg` em banco novo | **PASS**: 398/398 |
| `npm run commerce:go-live` | **STRUCTURAL CHECK PASS**: 41 P0 estruturais, sem homologação externa |
| `npm run commerce:final-go-live` | **BLOCKED**: `CODE_READY=NÃO`, `FULL_GO_LIVE=NÃO` |
| `npm run db:validate` | **Bloqueado de ambiente**: download de `binaries.prisma.sh` indisponível |

### Ressalvas dos gates

1. O erro Node 22 `Unable to deserialize cloned data due to invalid or unsupported version` ocorre no runner pai depois das asserções de `woocommerce-webhook-rota.test.ts`. Executar o arquivo diretamente produz 15/15; toda a suíte passa no Node 24. O próprio `.github/workflows/ci.yml` documenta o defeito do runner Node 22 e exige Node 24. Não foi classificado como falha funcional.
2. O gate oficial `test:pg` rejeita qualquer skip. Portanto ele **não é declarado PASS**, apesar da suíte PostgreSQL terminar com zero falhas: faltam os 13 testes que exigem o binário `psql`. A primeira invocação também expôs ausência de `ADMIN_PASSWORD`; após configurar credencial efêmera de teste, nenhuma dessas falhas de boot permaneceu.
3. Os 88 skips da suíte sem banco são esperados para testes PostgreSQL; não contam como aprovação desses casos. A execução PostgreSQL separada cobre 433 deles, mas não elimina a exigência dos 13 wrappers `psql`.
4. `architecture:audit` alterou somente o timestamp do inventário gerado durante a execução; essa alteração foi revertida para manter a auditoria sem ruído funcional.

## 6. Bloqueios de produção/homologação

Além dos P0/P1 de código, permanecem bloqueadores externos:

- nenhuma chamada autorizada às lojas `brobond.com.br` ou `atacado.brobond.com.br` foi realizada;
- não foram fornecidas nem usadas credenciais reais; nada se afirma sobre sua ausência na Render;
- URLs, CK/CS, segredos de webhook, DNS/TLS e roteamento entre vitrine nativa e RETAIL não foram verificados;
- não há evidência de plugin/consumer da quantidade mínima WHOLESALE;
- publicação, estoque, preço, pedido, pagamento, cancelamento, webhooks e reconciliação não foram homologados nas instalações reais;
- Mercado Livre, Nuvemshop, Mercado Pago e Instagram não foram homologados externamente;
- `WOOCOMMERCE_MULTI_STORE_ENABLED` e `WOOCOMMERCE_SYNC_DRY_RUN` são `sync:false` na Render; seu valor efetivo de produção não foi inspecionado;
- `render.yaml` não declara `WOOCOMMERCE_RETAIL_EMPRESA_ID` nem `WOOCOMMERCE_WHOLESALE_EMPRESA_ID`; a configuração real deve ser verificada para não depender do fallback empresa 1;
- não se deve ativar escrita externa nem importação em massa com base nos mocks ou no smoke local.

## 7. Ordem recomendada de correção e revalidação

1. **Conter P0:** impedir escrita/ativação Woo afetada; corrigir autoridade de preço, estoque legado e colisão de referência; avaliar pedidos/vendas já afetados sem apagar histórico.
2. **Fechar estoque e pedidos:** variação pai+tamanho, recuperação de itens parciais e reingestão marketplace.
3. **Fechar dinheiro e analítica:** representação Woo no BI, canais, comissão por participante e reapuração.
4. **Fechar segurança:** RBAC de comissões e tenant dos painéis agregados.
5. **Decidir arquitetura pública:** BROBOND × RETAIL, canal único, preço por loja, papel do representante e cutover legado.
6. **Adicionar testes de regressão** para cada reprodução deste relatório, inclusive concorrência PostgreSQL quando aplicável.
7. **Reexecutar todos os gates** com Node 24, PostgreSQL 16.14 e `psql`, até `test:pg` sem skips.
8. **Homologar externamente em dry-run/sandbox**, depois executar piloto limitado e reconciliação antes de produção plena.

## 8. Artefatos e limites da evidência

- `docs/AGENTE-06-INVENTARIO-COMERCIO-UNIFICADO.md`: módulos, tabelas, recursos, rotas, permissões e fluxos.
- `docs/AGENTE-06-MATRIZ-COMERCIO-UNIFICADO.md`: comparações por canal, representante/comissão, RBAC/tenant e estoque.
- `docs/AGENTE-06-RELATORIO-UNIFICACAO-COMERCIAL.md`: achados, reproduções, gates e bloqueios.

As reproduções usaram dados sintéticos em MemStore e PostgreSQL descartável, com `fetch` mockado quando necessário. Nenhum segredo, dado real de cliente ou credencial de produção foi lido ou incluído. Logs e scripts temporários ficaram fora do Git. A evidência prova os comportamentos locais relatados; não prova o estado atual das lojas nem substitui homologação externa.
