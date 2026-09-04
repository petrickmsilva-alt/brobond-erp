# BROBOND ERP — Auditoria Completa de Codificação e Integração (v0.5.0)

**Data:** 04/09/2026 · **Branch:** `arena/01a06ea7-brobond-erp`
**Escopo pedido:** auditoria de toda a codificação; verificação dos módulos que se linkam entre si ("conversando entre si"); correção da versão em Configurações; verificação do item "Fotos: No banco de dados"; coluna/mudança de senha em Configurações › Usuários; e 5 sugestões de evolução.
**Resultado:** `typecheck` ✅ · **48 testes** ✅ (38 antes) · `lint` ✅ (0 erros) · fluxo completo validado por HTTP no modo demonstração ✅

---

## 1. Verificação dos itens apontados na tela Configurações

| Item exibido | Situação encontrada | Ação tomada |
|---|---|---|
| **Versão: "BROBOND ERP 0.4.0"** | Desatualizada de fato: os `package.json` (raiz, server, client) estavam em `0.4.0` enquanto o código já continha Fases 3 a 7 (produção, grade, inventário, relatórios, financeiro, e-mail, backup). O fallback interno do código já dizia `0.5.0` — versões divergentes. | **Unificada em `0.5.0`** nos 3 `package.json` + 3 `package-lock.json`. A tela passa a mostrar **BROBOND ERP 0.5.0** (o número vem da API em `/api/meta`). |
| **Banco de dados: PostgreSQL (verde)** | ✅ Correto. Pool do `pg` com migração automática idempotente (`db/schema.sql`); sem `DATABASE_URL` cai em modo demonstração (memória) com aviso "DEMO". | Nada a corrigir. |
| **Fotos: "No banco de dados" (cinza)** | ✅ **Estava tudo funcionando.** O badge usava o tom azul-escuro da marca, que visualmente parece cinza. As fotos são gravadas em `arquivos` (bytes otimizados no navegador) e servidas por `/api/files/:id/:token`; Cloudinary só entra se `UPLOAD_PROVIDER=cloudinary`. | Badge mudado para **verde "No banco de dados — OK"** (e "Cloudinary (CDN) — OK" quando ativo), deixando claro que é uma configuração válida e saudável, não um estado neutro/de alerta. |
| **E-mail (recuperação): SMTP configurado (verde)** | ✅ Correto (`nodemailer` + link de reset no console quando não há SMTP). | Nada a corrigir. |
| **Senhas: bcrypt** | ✅ Correto — inclusive política de senha (mínimo 8, não pode ser o e-mail, lista de óbvias). | Mantido; ver item 3. |

---

## 2. Auditoria da integração entre módulos ("conversando entre si")

Fluxo real executado por HTTP na API (modo demonstração) e por testes automatizados:

| # | Integração (origem → destino) | Resultado | Evidência |
|---|---|:---:|---|
| 1 | Movimentação (entrada/saída/ajuste) → Estoque Físico (saldo único por produto×tamanho×local) | ✅ | Testes `regras.test.ts` + fluxo HTTP: entrada 12+2, saída por venda, saldo conferido |
| 2 | Venda faturada → baixa de estoque no local de saída → comissão congelada (%) → lançamento financeiro pendente | ✅ | Fluxo HTTP: total 450, comissão 36 (8%), saldo 19→16, lançamento "Venda #1" criado |
| 3 | Venda cancelada → estorno de estoque + zerar comissão + cancelar lançamento | ✅ | Teste `pedidos.test.ts` "cancelar estorna" |
| 4 | Compra recebida → entrada de insumo → custo médio ponderado → lançamento financeiro | ✅ | Testes `pedidos.test.ts` (média 20→25 e reversão) |
| 5 | OP concluída → entrada no estoque por tamanho → consumo de insumos da ficha (com perda) → auditoria; reabrir estorna | ✅ | Fluxo HTTP (+5 peças) e teste do painel; regras em `producao.ts` com 409 listando insumos faltando |
| 6 | Inventário fechado → ajustes de estoque + movimentações tipo "ajuste" (uma única vez) | ✅ | `estoque.ts` (`fecharInventario`) com trava de status |
| 7 | Ficha técnica → custo calculado → "aplicar preço" grava custo/preço no produto | ✅ | `fichas/:id/aplicar-preco` (regras + testes existentes) |
| 8 | Catálogo público → pedido sem login → cotação de venda no ERP | ✅ | `catalogos.ts` (`criarPedidoCatalogo`) |
| 9 | Aporte confirmado → lançamento de investimento | ✅ | `financeiro.ts` (`syncAporte`) |
| 10 | Recorrência vencida → lançamento pendente (botão ou cron) | ✅ | Teste "recorrência vencida é gerada" |
| 11 | Dashboard/cockpits → KPIs reais (valor de estoque, alertas, vendas do mês) | ✅ | Fluxo HTTP: valorEstoque 960 = 16×60; vendasMes 450 |
| 12 | **Financeiro na API vs. menu** | 🔴→✅ | **Falha encontrada e corrigida** (item 4.2 abaixo) |
| 13 | **Edição de estoque mínimo em local ≠ almoxarifado** | 🔴→✅ | **Falha encontrada e corrigida** (item 4.1 abaixo) |

**Conclusão:** os módulos estão de fato integrados por transações únicas (venda/compra/OP/inventário tocam estoque + financeiro + auditoria dentro do mesmo `BEGIN/COMMIT`, com rollback em erro). O desenho "resources.ts como fonte única de verdade" mantém API, validação e formulários coerentes.

---

## 3. Configurações › Usuários — coluna "Senha" e troca de senha no Editar

**Pedido:** uma "tabela senha" para ver a senha cadastrada (igual ao login) e, em Ações › Editar, um campo para mudar a senha.

**Implementado:**
- **Coluna "Senha"** na tabela de usuários, com dois estados:
  - 🟢 **Definida pelo usuário** — o usuário já tem senha própria;
  - 🟡 **Provisória — troca pendente** — senha criada/redefinida pelo admin; o sistema obriga a troca no primeiro acesso (já existia internamente; agora está visível).
- **Editar › campo "Senha"** — preenchê-lo define a senha nova na hora (política: mínimo 8 caracteres, não pode ser o e-mail nem óbvia); deixá-lo em branco mantém a senha atual. O texto de ajuda do campo explica exatamente isso. Quando o admin define a senha de outra pessoa, o status vira "Provisória" automaticamente; quando o próprio usuário troca (Configurações › Trocar senha), vira "Definida pelo usuário".
- Testes novos cobrem: status na lista, admin redefine → provisória, usuário troca a própria → própria.

**Por que a senha não pode ser exibida como texto:** ela nunca é guardada como texto — é convertida em **hash bcrypt** (mão única, impossível de reverter, nem pelo administrador). Isso é o padrão de segurança do login e protege a empresa se o banco vazar. A coluna mostra o *estado* da senha, que é a informação útil operacionalmente. Guardar/copiar senha em texto plano (numa coluna visível) quebraria essa proteção — não recomendado e não implementado.

---

## 4. Bugs encontrados e corrigidos nesta auditoria

### 4.1 🔴 Correção de bug — editar estoque mínimo em outro local dava erro 409 falso
Ao editar **somente** o `estoque_min` de um saldo guardado em local ≠ "almoxarifado" (ex.: loja), o `resolveLocal` completava o campo ausente com o padrão "almoxarifado" e o `ensureUniqueStock` acusava "Já existe saldo para este produto, tamanho e local" contra o saldo do almoxarifado — **bloqueando exatamente a tela de controle de estoque mínimo por local**. Corrigido em `services.ts`: edição parcial agora herda o local atual do saldo. Teste de regressão adicionado.

### 4.2 🔴 Correção de segurança/integração — API do financeiro aberta a operadores
O menu esconde Financeiro/Lançamentos/Categorias/Contas/Recorrências de operadores (`minPerfil: gerente` no front), mas a **API aceitava** operador em `/api/lancamentos_financeiros` etc. Corrigido adicionando `minPerfil: 'gerente'` aos 4 recursos no servidor (o menu e a API agora falam a mesma língua; testado: operador recebe 403). Os novos relatórios DRE/razão herdaram a mesma trava.

### 4.3 🟡 Versão desunificada (0.4.0 × 0.5.0)
Corrigida — ver item 1. Fontes: `package.json` raiz/server/client + locks; `index.ts` e `vite.config.ts` já liam `npm_package_version` (agora bate).

### 4.4 🟡 Lint quebrado (ESLint 9 × `.eslintrc.json`)
`npm run lint` não funcionava (ESLint 9 exige flat config). Criado `eslint.config.mjs`; corrigidos os erros reais que ele revelou: tipo `Dashboard` redeclarado, escape inútil em regex (`financeiro.ts`), `let`→`const` (`importacao.ts`). Resultado: **0 erros** (avisos de `any` controlados permanecem, são política do projeto).

### 4.5 🟡 Relatório de comissões existia na API mas não tinha tela
O endpoint `/api/relatorios/comissoes` não era usado em nenhum lugar do front. Agora faz parte da Área de Relatórios, com gráfico mensal (item 5.3).

---

## 5. Sugestões implementadas

### 5.1 Cockpit nos módulos Estoque e Produção ✅
- **Estoque Físico:** faixa de cockpit com 4 cartões — Peças em estoque, Valor a custo (e a preço de venda), Abaixo do mínimo (clicável: filtra a grade só para produtos em alerta) e Atalhos (Movimentar, Inventário, Relatório de mínimos). Painel vermelho listando produto/tamanho/saldo/mínimo/faltando quando há alerta. A grade continua sendo a tela principal — menos poluída, com relatórios detalhados na Área de Relatórios.
- **Produção (Ordens de Fabricação):** cockpit com OPs abertas (planejadas × em produção × peças), Atrasadas (previsão vencida, com lista clicável), Concluídas no mês + peças, gráfico de peças por semana (8 semanas) e atalhos para Ficha Técnica e o relatório de produção. Endpoint novo: `GET /api/producao/painel`.

### 5.2 Resumo de faturamento por período (comparação mensal/anual) ✅
Relatório **"Faturamento por período"** (Área de Relatórios › Vendas): 24 meses com gráfico de barras, colunas Mês / Pedidos / Faturamento / **Mesmo mês do ano anterior** / **Variação %**, e resumo com Faturamento do ano × ano anterior com variação. Só considera vendas faturadas/entregues (faturamento real, não pedido aberto). Exportável em CSV/XLSX. Atalho também no Financeiro.

### 5.3 Controle de estoque mínimo por local melhorado ✅
- Relatório **"Estoque abaixo do mínimo por local"**: produto × tamanho × local com Saldo, Mínimo, **Faltando** e **Custo para repor** (faltando × custo do produto), com filtro por local e resumo (itens em alerta, peças faltando, custo total de reposição).
- Cockpit do Estoque com painel de alertas e filtro rápido (item 5.1).
- **Correção do bug 4.1**, que impedia justamente de editar o mínimo em locais fora do almoxarifado.

### 5.4 Relatório de comissões com gráfico mensal ✅
Relatório **"Comissões (com gráfico mensal)"**: linhas por representante (pedidos, vendas, comissão) + **gráfico de barras com a evolução das comissões nos últimos 12 meses**, filtro por período e exportação CSV/XLSX. O relatório antigo da API foi absorvido por este (mesmo caminho `/api/relatorios/comissoes`, agora com exportação e série mensal).

### 5.5 Backup/exportação mais completa (DRE, razão financeiro, conciliação) ✅
- **Novos relatórios para gerente/admin:** **DRE gerencial por período** (agrupa por categoria com a classe na DRE — receita, CMV, mão de obra, operacionais, impostos, financeiras, investimentos — e calcula lucro bruto, resultado operacional, financeiro e geral) e **Razão financeiro** (livro-caixa com entrada/saída e **saldo acumulado**, filtro por período e tipo). Ambos exportáveis em CSV/XLSX. Botões de atalho na aba DRE do Financeiro.
- **Conciliação bancária:** o resultado (conciliados × pendentes) agora pode ser **exportado em CSV** direto da aba Conciliação.
- **Backup completo em XLSX:** novo `GET /api/admin/backup/xlsx` — planilha com **uma aba por tabela** (cadastros, estoque, produção, vendas, financeiro, usuários, auditoria…), ordenada por dependência, sem colunas secretas (`senha_hash`) nem bytes de fotos. Funciona inclusive no modo demonstração. Botão "Exportar tudo (.xlsx)" em Configurações › Administração (o dump SQL continua disponível para Postgres).

---

## 6. Cobertura de testes (38 → 48 testes)

Novo arquivo `server/test/relatorios.test.ts` cobrindo:
- faturamento mensal + comparação com ano anterior + variação %;
- comissões por representante + série mensal de 12 meses;
- estoque mínimo por local com custo de reposição + filtro por local;
- **regressão do bug 4.1** (edição de mínimo em "loja");
- razão financeiro (entradas/saídas/saldo) e DRE por período;
- bloqueio de operador no financeiro (bug 4.2);
- cockpit de produção (atrasadas, peças do mês, 8 semanas);
- coluna de status de senha + ciclo admin redefine/usuário troca;
- atualização do teste de comissões para o novo formato.

---

## 7. Observações técnicas (mantidas como estão, por decisão consciente)

1. **JWT em localStorage** e **rate limit em memória**: aceitáveis para o estágio/escala atuais (documentados na auditoria anterior como FASE E).
2. **DRE por regime de caixa**: conta apenas lançamentos **confirmados**; pendentes ficam no razão e nas contas a receber/pagar (comportamento documentado na tela).
3. `memdb.findOneWhere` ignora o `tx` (a interface aceita) — sem risco no modo memória (single-thread).
4. **Fotos no banco** é o modo padrão e saudável; se o volume crescer muito, o Cloudinary segue disponível com uma variável de ambiente.

## 8. Como conferir em 2 minutos

1. Entrar como admin → **Configurações**: versão **0.5.0**, Banco **PostgreSQL** verde, Fotos **No banco de dados — OK** verde.
2. **Configurações › Usuários**: coluna **Senha** com estado; Editar → campo "Senha" para mudar (vazio mantém).
3. **Estoque**: cockpit com valor do estoque e alertas (clique no cartão vermelho para filtrar).
4. **Produção › Ordens**: cockpit com OPs, atrasadas e gráfico semanal.
5. **Relatórios**: Faturamento (com comparação anual), Comissões (gráfico mensal), Estoque abaixo do mínimo, DRE e Razão (visíveis para gerente/admin), exportação CSV/XLSX em todos.
6. **Financeiro › DRE/Conciliação**: atalhos de exportação; **Configurações › Administração**: "Exportar tudo (.xlsx)".
