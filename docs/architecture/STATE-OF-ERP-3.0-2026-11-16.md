# BROBOND ERP 3.0 — estado consolidado

**Data da verificação:** 2026-11-16  
**Repositório:** `petrickmsilva-alt/brobond-erp`  
**Branch-base:** `main`  
**HEAD da main após PR #147:** `d10cc4818700773d4b685bbfa9e9f559cf6193bc`  
**PR #147:** merged em 2026-11-16; CI concluído com sucesso.  
**Deploy:** concluído conforme confirmação do Diretor.  
**Branch de reconciliação:** `docs/consolidate-erp-3.0-state-2026-11-16` (mergeado).

## 1. Fonte de verdade e regra de leitura

Este documento registra o estado verificado em 2026-11-16. Documentos de fases
anteriores continuam preservados como histórico; quando houver conflito, o
estado de implementação deve ser confirmado pelo código, pelos testes e pelos
artefatos mais recentes. Uma pendência externa não deve ser descrita como
bloqueio de código quando a implementação interna já foi executada.

## 2. Estado da loja nativa e canais comerciais

**ADR-0007 — EXECUTADA NO CÓDIGO.**

Evidências verificadas na branch `main`:

- `client/src/App.tsx`: rotas SPA públicas antigas não são registradas; há
  tratamento explícito das URLs antigas.
- `server/src/index.ts`: a superfície pública `/api/loja/*` foi retirada.
  O handler `lojaNativaRetirada` trata `/loja` e `/loja/*`.
- `server/src/commerce/loja-nativa-retirada.ts`: aplica 301 quando
  `STOREFRONT_REDIRECT_URL` está configurada; aplica 410 como fallback e nos
  caminhos transacionais.
- `server/test/fase2-loja-coerencia.test.ts`: trava a retirada das rotas,
  remoção dos módulos exclusivos, preservação dos serviços compartilhados,
  tratamento 301/410 e permanência de RETAIL/WHOLESALE.
- `docs/architecture/NATIVE-STORE-DECOMMISSION-REPORT.md`: registra a
  execução, os itens removidos e os serviços preservados.

**Preservado:** RETAIL e WHOLESALE via registry WooCommerce; motor interno de
pedidos/checkout, cliente, frete, Payment Engine e reserva de estoque.

**Fora do escopo já executado:** alteração de DNS, exclusão de dados de produção
e homologação de compra real com credenciais externas. Esses itens não anulam a
retirada da superfície pública no código.

## 3. Reconciliação do backlog

| Item | Estado consolidado em 2026-11-16 | Próxima ação |
|---|---|---|
| BL-001 | **Encerrado** — superfície pública nativa retirada; teste de coerência existente | Manter encerrado; não reabrir por causa de DNS externo |
| BL-002 | **Parcial** — visão unificada dos canais existe; caminho legado Woo ainda requer cutover | Preparar runbook e validar credenciais/janela de cutover |
| BL-009 | **Bloqueado por ambiente** — gates PostgreSQL/prisma dependem de execução CI/ambiente apropriado | Confirmar os jobs CI e registrar evidência |
| BL-015 | **Encerrado** — retirada da loja nativa executada | Manter encerrado |
| BL-017 | **Em execução interna — fase 1**: identidade de portal, vínculo ativo por tenant e bloqueio de APIs gerais | Prosseguir carteira, catálogo/preço, pedidos/cotações, comissões e portal; contrato em `BL-017-REPRESENTATIVES.md` |
| BL-018 | **Aberto externo** — homologação fiscal no PVA oficial/contador | Agendar homologação externa |

BL-001 e BL-015 tratavam da mesma retirada em níveis históricos diferentes.
A evidência atual permite encerrar BL-001 também; ambos não devem continuar como
duas pendências abertas para o mesmo resultado.

## 4. REPRESENTATIVES — fronteira de implementação

O repositório já contém fundamentos de domínio para representantes, equipes,
hierarquia, carteira e apuração de comissões. Também existem catálogo público e
portal de clientes, mas isso **não** equivale a um portal autenticado de
representantes com identidade própria e escopo de carteira.

A implementação de BL-017 deve reutilizar os domínios existentes e garantir:

1. identidade autenticada vinculada a um representante e à empresa;
2. autorização no servidor e isolamento obrigatório da carteira;
3. consulta de catálogo, preços e políticas conforme o canal autorizado;
4. criação de cotação/pedido usando o fluxo canônico de vendas;
5. leitura de comissões sem permitir acesso cruzado;
6. trilha de auditoria e testes negativos entre representantes/empresas.

Não criar um segundo cadastro mestre de produtos, clientes, estoque, vendas ou
comissões. Não tratar link público de catálogo como autenticação do representante.

## 5. Governança e riscos de entrega

- A branch `main` foi consultada pela API e retornou
  `protected: false` / proteção desabilitada. Recomenda-se habilitar proteção
  com CI obrigatório e revisão antes de merge; nenhuma alteração foi feita
  nessa configuração nesta rodada.
- O PR #147 foi mergeado; a execução CI da `main` no HEAD
  `d10cc4818700773d4b685bbfa9e9f559cf6193bc` concluiu com `success`.
- O deploy foi confirmado como concluído pelo Diretor. Esta reconciliação
  documental não alterou runtime, migrations, dados de produção ou DNS.

## 6. Sequência aprovada para continuidade técnica

1. Executar BL-017 conforme o contrato `BL-017-REPRESENTATIVES.md`, começando
   pela identidade exclusiva e pela fronteira server-side de autorização.
2. Implementar carteira e isolamento multiempresa com testes negativos A/B.
3. Habilitar catálogo/preço autorizado e fluxos canônicos de cotação/pedido.
4. Integrar consulta de comissões ao livro oficial, sem escrita direta.
5. Entregar auditoria, testes de isolamento e portal responsivo em PRs pequenos.
6. Tratar BL-002 (cutover Woo legado) em trilha própria.

**Critério de encerramento desta reconciliação:** documentação coerente,
backlog sem duplicidade, evidências de código/teste vinculadas e PR revisado.
