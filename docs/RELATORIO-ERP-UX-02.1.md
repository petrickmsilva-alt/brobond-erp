# ERP-UX-02.1 — Fechamento dos bloqueadores da arquitetura de navegação

**Repositório:** `petrickmsilva-alt/brobond-erp`
**Branch do ciclo:** `arena/336daf2e-brobond-erp`
**Base auditada:** `26d39fbb0193f61d60033e7033fb7f72bd72fe85`
**Escopo:** somente os bloqueadores P0 do ERP-UX-02. A árvore proposta do UX-02 **não** foi implementada; não houve redesign, reorganização de Sidebar, renomeação de módulos/grupos nem alteração de URLs.

> UX-02 = auditoria/planta. UX-02.1 = correção de segurança/contrato. UX-03 = implementação futura da árvore, **não iniciada**.

## 1. Reprodução antes da correção

### P0-01 — Multiempresa

Evidência estática conclusiva e reprodução executável em harness de handlers (antes da correção): um gerente da empresa A conseguiu:

- ler a lista de acessos de portal de um cliente da empresa B, incluindo o nome do cliente;
- gerar um acesso de portal para o cliente B;
- ler dados de QR de produto B (SKU, nome, preço e token de catálogo B);
- listar a superfície de qualidade da OP B;
- revogar um compartilhamento de catálogo B (`revogado_em` passou a existir).

### P0-02 — Menu × URL × API

- `visibleModules` escondia `empresas`, `listas-preco`, `envios` e os 4 conectores do operador, mas `App.tsx` montava os módulos apenas com `Protected` (exceto `adminOnly`).
- `listas_preco` e `envios` não declaravam `minPerfil` no servidor; logo, o CRUD genérico permitia ao operador o que o menu anunciava como gerente/admin.
- O router autenticado de conectores exigia sessão e banco, mas não aplicava a alçada de gerente declarada nos quatro módulos.
- `politicas_comerciais` não é um falso positivo simples: a autoridade real é a capacidade comercial `herdar/permitir/negar`; operador sem permissão é negado, operador com `permitir` é autorizado e gerente com `negar` é negado.

### P0-03 — PDV

Reprodução antes da correção:

1. gerente abre o caixa;
2. operador chama `GET /api/pdv/caixas/aberto` e recebe **403**;
3. o mesmo operador, conhecendo o `caixa_id`, chama `POST /api/pdv/vendas` e recebe **201**.

A evidência de negócio já existia em `resources.ts` e em `server/test/pdv.test.ts`: **operador vende em caixa aberto; gerente/admin respondem pela gaveta**. Não foi criada uma permissão nova nem liberado o recurso `pdv_caixas` para operador.

### audit:menu

Antes da instalação normal das dependências:

```text
Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'tsx' imported from /home/user/brobond-erp/
```

`tsx` está declarado em `server/package.json` e no lockfile; não é dependência da raiz. O ambiente apenas não tinha `node_modules`. Após `npm install --ignore-scripts --no-audit --no-fund` (instalação normal do workspace, sem alterar manifests), o comando executa. Nenhuma correção de script foi necessária.

## 2. Correções implementadas

### 2.1 P0-01 — isolamento multiempresa nas seis famílias

Foi adicionado um helper em `server/src/empresa.ts` para buscar o registro raiz já com `empresa_id` no predicado, retornando o mesmo 404 usado para ID inexistente/de outra empresa. Escrita usa a variante estrita (`assertRegistroDaEmpresaParaEscrita`), de modo que leitura consolidada não vira autorização de escrita.

| Família | Antes | Depois |
|---|---|---|
| Catálogos administrativos (`catalogos.ts`) | compartilhamento lia catálogo/cliente por ID global; inteligência agregava listas globais; revogação lia compartilhamento sem provar o tenant do catálogo | catálogo e cliente resolvidos no tenant; inteligência filtra catálogos/clientes/compartilhamentos pela empresa (consolidado explícito preservado); revogação prova o catálogo no tenant antes de escrever |
| Portal administrativo (`portal.ts`) | cliente lido por ID global nas rotas `/clientes/:id/portal-acessos*` | cliente resolvido no tenant antes de listar/gerar; revogação exige cliente do tenant e acesso pertencente àquele cliente |
| PDF de pedidos (`pdf.ts`) | venda/compra e relacionados lidos globalmente | pedido resolvido no tenant; cliente/representante/fornecedor, itens e produtos/insumos filtrados pela empresa do pedido. Também foi corrigido o vetor de colunas do PDF de compra, que tinha 6 cabeçalhos e 5 posições e gerava `NaN` no PDFKit |
| QR/produto (`qrcode.ts`) | produto lido globalmente; `/qrcode/dados` não chamava `checkAccess` no handler | todos os formatos resolvem o produto no tenant; catálogos candidatos filtrados pela empresa; `/dados` aplica `produtos:read`. A rota continua montada depois de `requireAuth` |
| NF-e anterior (`nfe.ts`) | dados/status/emissão liam a venda globalmente | venda resolvida no tenant; emissão exige a empresa ativa; cliente/itens/produtos filtrados pela empresa da venda |
| Qualidade (`quality.ts`) | OP lida globalmente; relatório agregava auditoria sem empresa | OP resolvida no tenant para leitura/escrita; eventos listados com `empresa_id`; relatório filtrado pela empresa ativa (ou consolidado explícito) |

O caminho público por token de catálogo/portal **não** foi reutilizado como autorização administrativa; ele continua sendo autenticação por token do próprio compartilhamento/cliente.

### 2.2 P0-02 — contrato menu/rota/API

- `server/src/resources.ts`: `listas_preco` e `envios` agora declaram `minPerfil: 'gerente'`, alinhando o servidor ao menu já existente. Não houve ampliação de privilégio: o operador perde o acesso que a UI já anunciava como gerencial.
- `server/src/connectors.ts`: o router autenticado `/api/connectors` aplica guard de gerente/admin antes de status, painel, autorização, sincronização, conexão e desconexão. Callbacks OAuth e webhooks públicos permanecem no router público e fora deste guard.
- `client/src/App.tsx`: rotas de módulos com `minPerfil` usam `visibleModules` (a mesma fonte da Sidebar/Command Palette) por meio de `ModuleAccess`. URLs existentes não mudaram; isto fecha a UX da URL direta, mas **não** é a barreira de segurança — a barreira é o servidor.
- Empresas já tinha `adminOnly` no recurso e `minPerfil: 'admin'` no módulo; a URL agora também segue a mesma descoberta. Financeiro e demais módulos com `minPerfil` seguem a mesma regra genérica, sem reorganizar grupos ou labels.

### 2.3 P0-03 — PDV

Contrato implementado:

- **Gerente/admin:** abrir caixa, suprimento, sangria, fechamento, resumo endereçável e gestão da gaveta.
- **Operador:** descobrir o caixa **aberto da própria empresa** e vender nele; não abre, não movimenta, não fecha e não lê o resumo gerencial por ID.
- **Outra empresa:** não descobre nem usa o caixa; `POST /api/pdv/vendas` com `caixa_id` alheio retorna 404.

Implementação mínima: `GET /api/pdv/caixas/aberto` passou a ser uma leitura operacional separada, autorizada por `vendas:create` e limitada a `status='aberto'` + empresa do ator. `pdv_caixas` continua `minPerfil: 'gerente'`; abrir/mover/fechar/resumo continuam gerenciais.

## 3. Matrizes de prova

### Multiempresa

| Caso | Resultado esperado | Evidência |
|---|---|---|
| A acessa A | PASS | testes em memória e HTTP/PG positivos |
| A acessa B | DENY (404) | portal, catálogo, PDF, QR, NF-e, qualidade |
| B acessa B | PASS | positivos simétricos no PG |
| B acessa A | DENY (404) | portal, PDF/QR/NF-e/qualidade e PDV |

### Perfil × descoberta × API

| Superfície | Admin | Gerente | Operador |
|---|---:|---:|---:|
| Listas de preço (`/listas_preco`) | 200 | 200 | 403 |
| Envios (`/envios`) | 200 | 200 | 403 |
| Conectores autenticados | permitido | permitido | 403 |
| PDV — descobrir caixa aberto | permitido | permitido | permitido (somente aberto/tenant) |
| PDV — vender em caixa aberto | permitido | permitido | permitido |
| PDV — abrir/mover/fechar/resumo | permitido | permitido | 403 |
| Políticas comerciais | permitido | `herdar/permitir` sim; `negar` não | somente `permitir` explícito |

## 4. Testes e gates executados

- `npm run audit:menu` — **PASS**, 0 erros. Avisos restantes classificados abaixo.
- `server/test/ux021-navigation-blockers.test.ts` — 7 testes em memória: **PASS**.
- `server/test/pg/ux021-navigation-blockers.test.ts` — HTTP real + PostgreSQL 16.14: **PASS** (tenant, perfis, conectores e jornada PDV).
- Testes direcionados de PDV, conectores, listas de preço e logística — **PASS**.
- Testes client de módulos, PDV, Layout e Sidebar — **PASS**.
- `npm test` completo — **PASS**: servidor 702 pass / 0 fail / 65 skipped (arquivos PG sem `DATABASE_URL` nesta invocação); cliente 294/294.
- `npm run test:pg` oficial em banco PostgreSQL 16.14 novo — **PASS**: 158 testes reais, 0 fail/skip/todo (`ERP-03 GATE PASS`).
- `npm run smoke:pg` — **PASS**: 126/126 verificações contra PostgreSQL real em banco novo criado pelo runner.
- `npm run typecheck` (domain + server + client) — **PASS**.
- `npm run build` — **PASS**.
- Lint — **0 erros** (426 warnings pré-existentes no repositório permanecem; os arquivos tocados não introduzem erros).
- CI do PR: status registrado na entrega final do PR (não declarado antes de existir/executar).

## 5. Avisos restantes do audit:menu

1. **`politicas-comerciais` (`RBAC_DERIVA_SOLTA`):** classificado como exceção comercial intencional. A autoridade não é `minPerfil` isolado, e sim `perm_politicas` (`herdar/permitir/negar`) combinada ao perfil. Os testes cobrem operador negado, operador permitido e gerente negado.
2. **`/api/health` (`ROTA_PUBLICA`):** endpoint público intencional de saúde, registrado antes de `requireAuth`; não expõe dados de negócio.

## 6. Limites e não-objetivos confirmados

- Nenhuma URL foi alterada, removida ou renomeada.
- Nenhum grupo, label em massa, Sidebar ou layout visual foi reorganizado.
- A árvore proposta do UX-02 não foi implementada; UX-03 não foi iniciada.
- Nenhum privilégio foi ampliado: listas/envios/conectores foram **restringidos** ao contrato já anunciado; o operador ganhou apenas a leitura operacional mínima do caixa aberto necessária para vender, sem acesso à gestão da gaveta.
- Conectores foram testados quanto à alçada do router; nenhuma conta externa real foi conectada/sincronizada neste ciclo.
