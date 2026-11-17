# Política Comercial Unificada Brobond — Arquitetura Canônica

**Status:** proposta arquitetural para implementação incremental  
**Data:** 2026-11-17  
**Base:** `main` em `fd60d1e56c53b9e9896a21855e0697cbc0d728b8`  
**Escopo:** Brobond ERP + Commerce integrado  
**Regra:** uma política, um resolvedor autoritativo, múltiplos consumidores.

---

## 1. Decisão arquitetural

O Brobond ERP é a base transacional e o Commerce está integrado ao mesmo monólito modular e ao mesmo PostgreSQL. Não devem existir políticas comerciais paralelas, uma para ERP e outra para Commerce.

A política comercial é um domínio central. ERP é o plano de controle (cadastro, parametrização, aprovação, auditoria e análise); Commerce, PDV, representantes, catálogo público e conectores são canais consumidores do mesmo resolvedor.

**Fonte única:** PostgreSQL do ERP + serviços de domínio do servidor. O frontend nunca calcula preço autoritativo.

## 2. Diagnóstico do estado encontrado

### 2.1 Componentes já existentes no código

| Capacidade | Estrutura/serviço atual | Estado observado |
|---|---|---|
| Preço-base | `produtos.preco_venda`, `produtos.preco_atacado` | Existe e está preenchido nos 22 produtos atuais |
| Lista de preços | `listas_preco`, `lista_preco_itens`, `listas_preco_historico`, `listasPreco.ts` | Estrutura e resolvedor existem; falta atribuição robusta a cliente/segmento/canal e faixas |
| Política comercial | `politicas_comerciais`, `politicasComerciais.ts` | Escopos geral, canal, coleção, catálogo e cliente; uma regra vencedora por especificidade/prioridade |
| Preço por condição | `condicoes_pagamento`, `produto_precos_condicao`, histórico | Estrutura por SKU/canal/condição/faixa e vigência existe |
| Desconto cumulativo | `politica_comercial_descontos_cumulativos` | Estrutura existe, com autorização explícita |
| Piso de preço | `politica_preco_minimo`, `avaliarPrecoMinimo()` | Função existe; bloqueio é desligado por padrão |
| Promoções e cupons | `commerce_promocoes`, `commerce_promocao_alvos`, `commerce_cupons` | Motor separado; promoção e cupom competem pelo maior desconto, sem acumular |
| Preço por canal externo | `commerce_precos`, `commerce/catalogo.ts` | Override por canal e store_key existe |
| Segmentação | `customer_segments` | Regras dinâmicas existem; não há vínculo tipado com a seleção de listas/políticas/promoções |
| Formação e memória de preço | colunas de `produtos`, `memoria_formacao_preco`, `produto_precos_condicao.regra_calculo`, `precificacao_memoria` | Base de cálculo e trilha existem, mas a integração ponta a ponta não está provada |
| Fiscal | `regras_fiscais`, `impostos_ncm`, `fiscalRegras.resolverTributacao` | Motor fiscal separado; não deve ser substituído por alíquotas comerciais estimadas |
| Pagamentos | Payment Engine e `condicoes_pagamento` | Infraestrutura existe; custo efetivo por método/provedor precisa ser conectado à rentabilidade |

### 2.2 Fotografia do banco de produção consultado

Consulta somente leitura no projeto Neon de produção, empresa 1:

- 22 produtos cadastrados.
- 22/22 com `preco_venda`, `preco_atacado` e custo preenchidos.
- 0/22 com NCM preenchido; 0/22 com CEST preenchido.
- 0 registros em `politicas_comerciais`, `listas_preco`, `lista_preco_itens`, `produto_precos_condicao`, `condicoes_pagamento`, `politica_comercial_descontos_cumulativos`, `politica_preco_minimo`, `commerce_promocoes`, `commerce_cupons`, `customer_segments`, `regras_fiscais` e `impostos_ncm`.
- 1 registro em `commerce_precos`: produto 17, canal BROBOND, preço 80,00.
- Há registros operacionais em `vendas`, `itens_venda`, `sales` e `sale_items`; estes devem permanecer históricos e não podem ser recalculados retroativamente.

A fotografia é um retrato do banco consultado, não uma declaração de que a planilha já foi importada.

### 2.3 Defeito de integração prioritário

Em `server/src/commerce/checkout.ts`, o checkout calcula `precoPublico()`, chama `resolverPrecoComercial()`, mas substitui o preço público pelo resultado do resolvedor somente quando `origem_preco === 'condicao'`. Resultado: preço de lista ou política comercial resolvido pode ser ignorado pelo carrinho do Commerce.

Este é um bloqueador P0 para declarar ERP e Commerce consistentes. O checkout deve consumir o resultado completo do resolvedor central, sem segundo caminho de cálculo.

### 2.4 Outros gaps confirmados

1. `politicasComerciais.resolverPoliticaComercial()` retorna pedido mínimo em valor, mínimo de peças, mínimo por produto e múltiplo, mas a função em si não aplica essas restrições. O contrato precisa separar elegibilidade, preço e validação do pedido.
2. `listas_preco` não define atribuições por cliente, segmento, canal ou representante. A tabela de itens atual não suporta faixas múltiplas nem variante/tamanho.
3. `commerce_precos` é um override por canal/store_key separado do preço/lista/política. Sem precedência única, pode divergir do preço aprovado no ERP.
4. Promoções/cupom não estão ligadas a segmentos ou listas comerciais; têm regras próprias.
5. `customer_segments` é uma definição dinâmica, não um vínculo de elegibilidade comercial.
6. `avaliarPrecoMinimo()` e `registrarMemoriaPrecificacao()` existem, mas não foi encontrada evidência de chamada no fluxo do checkout. Cobertura de função isolada não prova integração operacional.
7. `precificacao_memoria` não referencia diretamente `itens_venda.id`; isso dificulta provar qual memória corresponde a cada linha do pedido.
8. O motor fiscal tem estrutura própria, mas o catálogo de produção está sem NCM e regras fiscais cadastradas. Impostos dependentes de operação/destino/regime não podem ser inferidos de percentuais genéricos.
9. Comissão, custo de pagamento, frete, impostos e margem devem compor a análise de rentabilidade, mas continuam pertencendo aos seus domínios donos.

---

## 3. Modelo operacional da Política Comercial Brobond

### 3.1 Dimensões de decisão

Cada cotação precisa ser resolvida com contexto completo:

- empresa/tenant;
- canal comercial: varejo, atacado, representante ou venda direta digital;
- origem do pedido: PDV/balcão, site, WhatsApp, representante ou marketplace;
- loja/marketplace de destino e identificador de loja;
- cliente, grupo/segmento e lista atribuída;
- produto, SKU, variante/tamanho, categoria e coleção;
- quantidade da linha e quantidade total do pedido;
- condição de pagamento e parcelas;
- data/hora da cotação;
- moeda (BRL como padrão atual);
- endereço/UF e natureza da operação para o motor fiscal;
- modalidade/local de entrega para o motor logístico.

**Não confundir canal comercial com origem do pedido.** Ex.: um pedido originado no Mercado Livre pode ser varejo; um representante pode fechar um pedido atacadista. Os dois atributos são necessários.

### 3.2 Tipos de regra

1. **Formação de preço:** custo de fabricação/aquisição, custos variáveis, tributos conhecidos e margem-alvo.
2. **Preço de tabela/lista:** preço fixo ou fórmula por produto/variante/categoria, com vigência e quantidade mínima.
3. **Preço por condição de pagamento:** preço final explícito por SKU/canal/condição/faixa ou ajuste financeiro configurado. Um preço explícito por condição é terminal; não se reaplica outra margem/fórmula sobre ele.
4. **Política comercial:** elegibilidade, desconto, pedido mínimo, mínimo por SKU, múltiplos, canal, cliente, segmento, catálogo e coleção.
5. **Promoção/cupom:** campanha de curto prazo, alvos, público, período, limite de uso e cumulatividade explícita.
6. **Proteção de margem:** margem mínima, desconto máximo, bloqueio e alçada de aprovação.
7. **Rentabilidade:** custo, tributos, frete, taxas de pagamento e comissão, apresentados separadamente e consolidados em margem de contribuição.
8. **Publicação por canal:** preço resolvido que será publicado/sincronizado para a loja ou marketplace; não é uma segunda fonte de preço.

### 3.3 Precedência determinística proposta

A ordem abaixo é uma decisão do produto Brobond, a ser implementada e testada; não é apresentada como cópia literal de um fornecedor:

1. Validar tenant, estado do produto, cliente, canal, loja e vigência.
2. Resolver lista atribuída ao cliente/segmento/canal; maior especificidade vence, depois prioridade e vigência mais recente.
3. Resolver regra do produto/variante; produto/variante específico prevalece sobre categoria e regra geral.
4. Resolver faixa de quantidade aplicável (maior mínimo elegível, sem combinar faixas incompatíveis).
5. Resolver preço explícito por condição de pagamento. Se existir, é o preço final daquela condição, exceto descontos cumulativos explicitamente autorizados.
6. Se não houver preço explícito de condição, aplicar ajuste financeiro da condição à base resolvida, somente se houver parâmetro cadastrado.
7. Aplicar uma política comercial vencedora por especificidade/prioridade; empilhamento de políticas só quando houver regra expressa de cumulatividade.
8. Aplicar promoção ou cupom: por padrão vence o maior desconto elegível; empilhar apenas quando as duas regras autorizarem cumulatividade e limites forem respeitados.
9. Aplicar piso de preço/margem e alçada. Se não houver custo confiável, a margem fica desconhecida; não converter ausência em margem zero nem aprovar silenciosamente.
10. Calcular impostos no motor fiscal e frete no motor logístico, cada um com suas próprias regras e memória. Não misturar tributo estimado à margem como se fosse imposto fiscal apurado.
11. Produzir snapshot imutável da cotação; no fechamento do pedido, congelar preço, descontos, condição, política, lista, campanha, imposto, frete, taxas, custo e versão do motor.

**Regra anti-dupla-contagem:** preço explícito por condição, preço promocional e desconto adicional não podem ser somados sem uma autorização e uma ordem de aplicação registradas.

### 3.4 Fórmulas de formação

A formação deve distinguir margem sobre preço de markup sobre custo:

- Custo carregado = custo de aquisição/fabricação + componentes de custo válidos e documentados.
- Preço por margem bruta-alvo = custo carregado / (1 − margem-alvo).
- Preço por markup = custo carregado × (1 + markup).
- Preço líquido = preço bruto − desconto comercial − desconto promocional, segundo a cumulatividade aprovada.
- Margem de contribuição = receita líquida − CMV − impostos − taxas de pagamento − frete subsidiado − comissão variável.

A planilha já contém famílias de fórmulas diferentes por aba. Cada fórmula deve ser registrada por versão e origem. Os preços explícitos são dados comerciais de entrada e devem ser preservados; resultados derivados são recalculados. Custos ausentes ou inválidos deixam os campos dependentes pendentes, nunca preenchidos por estimativa.

---

## 4. Contrato único do resolvedor

Criar/estabilizar um serviço puro e único, por exemplo:

`resolverCotacaoComercial(contexto, itens, tx?)`

Entrada:
- contexto comercial completo (empresa, canal, origem, loja, cliente/segmento, data, pagamento, destino);
- linhas com produto/variante/quantidade;
- cupom opcional;
- modo `preview` ou `confirmacao`.

Saída por linha:
- preço-base e sua origem;
- lista e regra selecionadas;
- preço por condição e ajuste financeiro;
- política comercial e motivo de elegibilidade;
- faixa de quantidade;
- promoção/cupom e regra de cumulatividade;
- preço unitário final, desconto em valor e percentual;
- custo conhecido/desconhecido;
- imposto/frete/taxa conhecidos ou pendentes;
- margem de contribuição ou `null`;
- alertas, bloqueios e alçadas;
- versão do motor e snapshot/hash de regras.

Saída do pedido:
- subtotal, descontos, frete, tributos, taxas e total;
- regras aplicadas e regras rejeitadas com motivo;
- resultado de piso/alçada;
- snapshot íntegro e reprodutível.

O browser envia identificadores e quantidades, nunca preço, desconto, imposto, frete ou total autoritativo. O servidor recalcula em preview e repete a resolução no fechamento dentro da transação.

---

## 5. O que deve ser adicionado ou alterado

### P0 — Consistência e autoridade

- Fazer o checkout do Commerce usar integralmente `resolverPrecoComercial`; remover o caminho concorrente `precoPublico` como autoridade de preço. A publicação pode continuar exibindo preço derivado, mas deve receber o resultado do mesmo resolvedor.
- Fazer PDV, venda manual, proposta, catálogo público, checkout interno e conectores consumirem o mesmo serviço.
- Aplicar de fato pedido mínimo, mínimo por SKU, múltiplos, quantidade mínima, vigência e canal.
- Centralizar promoção/cupom no pipeline, preservando a regra atual de maior desconto até haver cumulatividade explícita.
- Garantir que ausência de preço para um canal bloqueie a venda; nunca cair de atacado para varejo.
- Impedir que o front envie preço ou desconto autoritativo.
- Garantir snapshot de preço no item/documento e não recalcular pedidos históricos.

### P1 — Modelo comercial completo

- Criar atribuição de lista de preço por empresa + cliente/segmento + canal + representante + loja, com vigência e prioridade.
- Criar regras de lista com produto/variante/categoria, quantidade mínima/máxima, tipo (fixo/desconto/fórmula), base de cálculo, vigência e prioridade.
- Ligar segmentos dinâmicos a políticas, listas e promoções por associação tipada e validada.
- Distinguir canal comercial de origem/canal técnico externo.
- Formalizar condição de pagamento e seus custos reais (parcelas, prazo, taxa do adquirente/provedor, antecipação), reutilizando o Payment Engine e sem inventar taxa.
- Tratar `commerce_precos` como publicação/override governado pelo motor: armazenar origem, versão/hash da cotação, vigência e aprovação para override manual.
- Vincular memória de precificação à linha da venda, além do produto e venda, e persistir a versão/hash do motor.
- Adicionar workflow de aprovação para exceção de preço abaixo do piso, desconto fora da alçada e override manual.
- Definir contrato de sincronização de preço: ERP → canais; retorno do canal não pode sobrescrever silenciosamente o preço mestre.

### P2 — Formação, rentabilidade e inteligência

- Modelos versionados de formação por canal: varejo, atacado, representante e digital.
- Custos fixos/variáveis e custo de servir por canal, com parâmetros reais.
- Simulador comercial para comparar margem por preço, condição, quantidade, canal e cliente.
- Histórico de alteração de margem, custo, preço e regra; análise de impacto antes de publicar.
- Segmentação RFM/valor/recência/frequência ligada a campanhas e listas, respeitando consentimentos e LGPD.
- Painel de rentabilidade por SKU, coleção, canal, cliente, representante e pedido.

### P3 — Fiscal e expansão

- Completar classificação fiscal de produtos e parâmetros da empresa.
- Ligar a simulação ao motor fiscal existente, com memória por item (regra, vigência, base, alíquota, valor).
- Adicionar os campos e ganchos de evolução tributária brasileira conforme regras oficiais e parametrização validada; taxas não configuradas permanecem pendentes.
- Testar cenários multi-UF, consumidor final/contribuinte, regimes e operações aplicáveis antes de habilitar emissão real.

---

## 6. Papéis dos dois ambientes

### ERP — plano de controle

- Cadastro de custos, margens-alvo e fórmulas versionadas.
- Administração de listas, políticas, condições de pagamento, promoções, cupons e segmentos.
- Definição de vigência, prioridades, limites, alçadas e aprovações.
- Simulador de preço e rentabilidade.
- Relatórios de exceções, margens e alterações.
- Autoridade para publicar/revogar preços nos canais.

### Commerce — plano de execução

- Consulta ao preço calculado pelo mesmo serviço.
- Exibição de preço normal, preço de condição, desconto e economia sem distorção.
- Validação de elegibilidade de cliente/segmento e quantidade.
- Revalidação no carrinho e no checkout.
- Consumo de promoções/cupons sem duplicar regra.
- Persistência de snapshot no pedido.
- Sincronização de preços para WooCommerce/Nuvemshop/marketplaces por adaptador, sem alterar a política central.

---

## 7. Benchmark externo incorporado

Referências oficiais consultadas em 17/11/2026:

- **Odoo:** listas com regras por cliente, país, período, quantidade mínima, variante, preço fixo, desconto ou fórmula, incluindo base em custo e arredondamento: https://www.odoo.com/documentation/17.0/applications/sales/sales/products_prices/prices/pricing.html
- **Shopify B2B:** catálogos atribuídos a mercados/empresas, preços fixos ou percentuais, regras de quantidade mínima/máxima/múltiplo e preços por volume: https://help.shopify.com/en/manual/b2b/catalogs
- **Shopify B2B — quantidade:** incrementos, mínimo/máximo por variante e descontos por volume: https://help.shopify.com/en/manual/b2b/catalogs/quantity-pricing
- **Adobe Commerce:** preço por grupo de clientes e preço por faixas de quantidade; regra de precedência e cálculo final: https://experienceleague.adobe.com/pt-br/docs/commerce-admin/catalog/products/pricing/product-price-group e https://experienceleague.adobe.com/pt-br/docs/commerce-admin/catalog/products/pricing/product-price-tier
- **Adobe Commerce B2B:** catálogos compartilhados com seleção de produtos, preços personalizados e atribuição a empresas: https://experienceleague.adobe.com/en/docs/commerce-admin/b2b/shared-catalogs/catalog-shared

A Brobond deve adotar os padrões de mercado úteis (listas por público, variantes, quantidade, vigência, fórmula, grupo/segmento e explicabilidade), sem copiar a complexidade ou criar dependência de fornecedor.

---

## 8. Plano de implementação

1. **P0 — Contrato e testes de regressão:** especificar o contrato do resolvedor e corrigir a integração do checkout; testar ERP/Commerce com a mesma matriz de entradas.
2. **P1 — Regras e atribuições:** listas por cliente/segmento/canal/representante e faixas por produto/variante; enforcement de mínimos/múltiplos.
3. **P1 — Publicação multicanal:** converter `commerce_precos` em projeção controlada pelo motor e registrar divergência/override.
4. **P2 — Formação e rentabilidade:** modelos versionados, custos e taxas reais, simulação e memória por linha.
5. **P3 — Fiscal:** classificar produtos, parametrizar regras válidas e integrar memória fiscal.
6. **Homologação:** matriz de ponta a ponta, banco PostgreSQL real, tenant, concorrência, idempotência, auditoria, histórico e canais externos.

Toda alteração de schema do ERP deve seguir `db/migrations/NNNN_*.sql` + espelho em `db/schema.sql`; não usar `prisma migrate dev`. Prisma permanece bounded context técnico do Commerce.

## 9. Critérios de aceite

- Mesmo contexto e SKU retornam exatamente o mesmo preço no ERP, PDV, catálogo, checkout e conectores.
- Testes cobrem prioridade, vigência, escopo, cliente, segmento, canal, variante, quantidade, condição, promoção, cupom e cumulatividade.
- Nenhum desconto é aplicado duas vezes.
- Nenhum canal recebe preço de outro canal por fallback.
- Limite de margem/desconto e alçada funcionam no servidor.
- Toda cotação tem trilha explicável; toda venda congela seu snapshot.
- Reimportação de dados é idempotente e não altera histórico de vendas.
- Custo/fiscal ausente produz pendência explícita, não valor inventado.
- Testes PostgreSQL reais, typecheck, lint, build, auditorias de arquitetura, menu e UX passam.
- ERP e Commerce usam um único resolvedor, sem implementação paralela.

## 10. Fora do escopo desta especificação

- Não alterar estoque físico nem movimentações.
- Não reescrever preços de vendas já confirmadas.
- Não inventar custo, taxa financeira, comissão, frete ou alíquota fiscal.
- Não ativar bloqueio de margem com limites arbitrários.
- Não publicar preços externos sem homologar o mapeamento de canal e loja.
