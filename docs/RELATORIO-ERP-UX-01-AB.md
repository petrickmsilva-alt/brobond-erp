# RELATÓRIO — ERP-UX-01 · IMPLEMENTAÇÃO CICLO A/B (SHELL + MENU)

**Repositório:** `petrickmsilva-alt/brobond-erp` (único repositório oficial; nenhum outro foi procurado, consultado ou referenciado)
**Branch:** `arena/f2c2845a-brobond-erp` · **Data:** 2026-10-11
**Ciclo:** UX-01-A (Shell) + UX-01-B (Menu) — implementação controlada + testes + evidências
**Natureza da mudança:** front-end apenas (navegação/shell/testes). Nenhum backend, banco, migration, Prisma, API, autenticação ou regra de negócio foi tocada.

---

## 1. BASE E ESTADO INICIAL (pré-voo do §1)

| Verificação | Resultado |
|---|---|
| Branch de trabalho | `arena/f2c2845a-brobond-erp` |
| HEAD da `main` (local = remoto, `git ls-remote`) | `649e0462a2f7f5217ab5f0c10c2d5ddd6752df92` |
| Último commit da `main` | `649e046 Merge pull request #51` (ERP-01) |
| `git status` no início | somente `?? docs/RELATORIO-ERP-UX-01.md` (relatório da auditoria aprovada, produzido no ciclo anterior — incluído neste PR para não se perder) |
| PRs abertos | **#52** — “ERP-01 (complemento) — prova da cadeia inteira do pagamento por HTTP autenticado”, branch `arena/eb6990d1-brobond-erp`. **Não relacionado a este ciclo** (não toca navegação) e **não foi tocado**. |
| Working tree | limpo exceto pelo relatório da auditoria (acima) |

---

## 2. ARQUIVOS ALTERADOS

**Modificados (8)** — 196 inserções / 76 remoções:

| Arquivo | O que mudou |
|---|---|
| `client/src/modules.ts` | Fonte única: `NAV_SECTIONS` (derivada de `MODULE_GROUPS` + `GROUP_META`) e `moduleOfPath()` (regra única rota → módulo); comentário de contrato corrigido (“Meu Negócio”, não “Dashboard”) |
| `client/src/components/Sidebar.tsx` | **Removidas** as listas locais `ERP_GROUPS` / `COMMERCE_GROUPS` / `SYSTEM_GROUPS`; a barra renderiza `NAV_SECTIONS`; área ativa via `moduleOfPath` |
| `client/src/components/Layout.tsx` | Breadcrumb real (componente do UI kit) derivado de `MODULES`; título da aba e trilha por `moduleOfPath`; removido o rótulo fixo “Dashboard” |
| `client/src/components/ui-kit.tsx` | `Breadcrumb`: novo campo opcional `semLink` (nível sem destino) e clique com modificador (Ctrl/Cmd/Shift/Alt) deixa de ser interceptado |
| `client/src/components/CommandPalette.tsx` | Item de topo da busca deixa de ser “Dashboard” hardcoded e passa a vir do módulo de `/` |
| `client/src/pages/PlannedModule.tsx` | Botão “Voltar ao Dashboard” → “Voltar ao {nome do módulo de `/`}” (derivado) |
| `client/src/modules.test.ts` | +6 testes: integridade de `NAV_SECTIONS` e regra de `moduleOfPath` |
| `client/src/test/setup.ts` | No-op de `scrollIntoView` (jsdom não implementa; o CommandPalette usa em efeito) |

**Novos (2, testes):** `client/src/components/Sidebar.test.tsx` (14 testes), `client/src/components/Layout.test.tsx` (8 testes)
**Documento (1):** `docs/RELATORIO-ERP-UX-01.md` (auditoria aprovada que autorizou este ciclo)

**Nada mais foi tocado.** Nenhum arquivo em `server/`, `prisma/`, `db/`, `modules/`, `packages/`, `scripts/` ou `.github/`.

---

## 3. ARQUITETURA ANTES

```
MODULES (70, modules.ts)          ← declara módulos, grupos e rotas
MODULE_GROUPS (13) + GROUP_META   ← declara as áreas (só o gate/teste liam)
        │
        ✗ (nada ligava os dois)
        │
Sidebar.tsx                       ← 3 listas locais próprias
   ERP_GROUPS (8 áreas, SEM Fiscal)
   COMMERCE_GROUPS (3) · SYSTEM_GROUPS (1)
        ↓
menu renderizado: 12 grupos / 66 itens (admin) · 62 (gerente) · 42 (operador)
        ↑ divergência: 4 módulos declarados (Fiscal) nunca renderizados

Layout.tsx: “BROBOND ERP / Grupo / Rótulo” (texto puro)
            em “/” mostrava o literal “Dashboard”
```

## 4. ARQUITETURA DEPOIS

```
MODULES / MODULE_GROUPS / GROUP_META        (modules.ts — fonte única)
        │
        ├─ NAV_SECTIONS  = seções da Sidebar derivadas de GROUP_META.section
        │        ↓
        │   visibleModules(user)  →  filtro RBAC  →  agrupamento  →  render
        │        ↓
        │   Sidebar: 13 grupos / 70 itens (admin) · 66 (gerente) · 43 (operador)
        │
        └─ moduleOfPath(pathname)  = rota → módulo (exato ou filho)
                 ↓                        ↓
            Layout: título da aba     Layout: breadcrumb
                                      BROBOND ERP › Área › Módulo › Registro
```

**Uma única regra de agrupamento** (`NAV_SECTIONS`), **uma única regra de rota→módulo** (`moduleOfPath`, usada por Sidebar **e** Layout), **zero lista local** de grupos.

---

## 5. P0 CORRIGIDO

| P0 da auditoria | Situação agora | Evidência |
|---|---|---|
| `UX01-P0-01` Fiscal declarado e nunca renderizado | **CORRIGIDO** — a área Fiscal renderiza como qualquer outra | renderização real: admin e gerente veem `Documentos fiscais`, `Regras fiscais`, `NCM / Tributação`, `Inutilizações`; operador vê `Fiscal › Documentos fiscais` (o único sem `minPerfil`) |
| `UX01-P0-02` gates não cobrem o renderizador | **CORRIGIDO** — o gate estrutural agora nasce da fonte única e o teste executa o componente | `modules.test.ts` (NAV_SECTIONS) + `Sidebar.test.tsx` (componente real) |
| `UX01-P0-03` nenhum teste renderiza Sidebar/Layout | **CORRIGIDO** — 22 testes novos renderizam os dois componentes | `Sidebar.test.tsx` (14) · `Layout.test.tsx` (8) |

## 6. COMO FISCAL PASSOU A APARECER

Não houve tratamento especial para Fiscal — foi consequência de remover a causa:

1. `MODULE_GROUPS` e `GROUP_META` já declaravam `Fiscal: { icon: Scale, section: 'erp' }` (ERP-05, 2026-10-11);
2. `NAV_SECTIONS` é **derivada**: `MODULE_GROUPS.filter(g => GROUP_META[g].section === id)` — um grupo novo entra na seção sem editar a Sidebar;
3. a Sidebar deixou de ter lista própria e itera `NAV_SECTIONS`;
4. os 4 módulos fiscais já existiam em `MODULES` (rota, tela, API e RBAC herdados — nada foi criado).

**Prova de ordem:** a área Fiscal aparece entre Financeiro e Relatórios, exatamente na ordem declarada em `MODULE_GROUPS`.

## 7. COMO A FONTE ÚNICA FOI IMPLEMENTADA

```ts
// modules.ts (novo)
export const NAV_SECTIONS: NavSection[] = (['erp','commerce','sistema'] as const).map((id) => ({
  id, label: SECTION_LABEL[id],
  groups: MODULE_GROUPS.filter((g) => GROUP_META[g].section === id),
}));

export function moduleOfPath(pathname: string, modulos: Module[] = MODULES): Module | undefined {
  return modulos.find((m) => m.path === pathname)
      || modulos.filter((m) => m.path !== '/').find((m) => pathname.startsWith(m.path + '/'));
}
```

```tsx
// Sidebar.tsx (depois) — nenhuma lista de grupos
{NAV_SECTIONS.map((section) => {
  const grupos = section.groups.filter((g) => visible.some((m) => m.group === g));
  if (!grupos.length) return null;
  return <div key={section.id} className="mt-4 space-y-0.5">
    {collapsed ? <Divider/> : section.label ? <SectionLabel>{section.label}</SectionLabel> : null}
    {grupos.map(renderGroup)}
  </div>;
})}
```

O perfil **não** escolhe um menu diferente: `visibleModules(user)` filtra a mesma fonte e a seção/área desaparece quando não sobra item visível (era assim que o operador perdia o rótulo “Commerce / Integrações”).

## 8. COMO O RBAC CONTINUA FUNCIONANDO

Fluxo inalterado: `MODULES` → `visibleModules` (adminOnly · minPerfil · `perm_politicas`) → filtro → render. Nada de RBAC foi alterado no servidor.

Evidência por execução (ferramenta nova, `Sidebar.test.tsx`):

| Perfil | Renderizado | `visibleModules(MODULES)` | Antes |
|---|---|---|---|
| admin | **70** itens / 13 grupos | 70 | 66 / 12 |
| gerente | **66** itens / 13 grupos | 66 | 62 / 12 |
| operador | **43** itens / 11 grupos | 43 | 42 / 10 |

* Operador **não** vê nenhum item `adminOnly` (Usuários, Auditoria, Webhooks) nem de `minPerfil=gerente` (12 itens) — testado item a item.
* Operador **continua** sem ver `regras-fiscais`, `ncm`, `inutilizacoes` (gerente) e **passa a ver** `documentos-fiscais`.
* `perm_politicas='permitir'` continua abrindo `Políticas comerciais` para o operador (testado).
* **As 3 derivações de API (`politicas-comerciais`, `listas-preco`, `envios`) NÃO foram corrigidas** — permanecem como P1 do UX-01-D, com os mesmos avisos no `audit:menu` (registrado em “AINDA ABERTO”).

## 9. TESTES ADICIONADOS

| Arquivo | Testes | O que barra |
|---|---|---|
| `Sidebar.test.tsx` | 14 | renderizado **=** `visibleModules(MODULES)` nos 3 perfis; item sem módulo correspondente; rótulo divergente; grupo declarado ausente; área vazia renderizada; Fiscal ausente; RBAC (adminOnly/minPerfil/`perm_politicas`); área ativa em rota filha; toda área declarada com seção |
| `Layout.test.tsx` | 8 | “/” mostra **Meu Negócio** e nenhum “Dashboard” no shell; breadcrumb clicável e coerente (inclusive nível fiscal); Sidebar/skip-link/busca de pé; Ctrl+K funcionando; troca de empresa remontando o conteúdo; rota pública sem shell; “/” sem sessão → login |
| `modules.test.ts` | +6 | `NAV_SECTIONS` cobre toda área declarada exatamente uma vez, na ordem declarada; cada área na seção que `GROUP_META` declara; Fiscal renderizável; `moduleOfPath` (exata, filha, inexistente, respeitando `visibleModules`) |

### Prova de que a barreira funciona (teste de mutação)

Reintroduzi deliberadamente o defeito antigo (filtrar `Fiscal` fora do render da Sidebar): **9 testes falharam** — inclusive `admin não vê a área Fiscal`, `admin/gerente/operador: renderiza exatamente os módulos de visibleModules(MODULES)` e `renderiza toda área declarada`. Com o código correto restaurado, **14/14 passam**. Sem essa mutação o teste poderia passar por acidente; com ela, está provado que ele pega exatamente a regressão que motivou o ciclo.

## 10. COMANDOS EXECUTADOS

```bash
npm run typecheck                     # domain + server + client
npx eslint <10 arquivos do ciclo>      # escopo do ciclo
npm run lint                          # repositório
npm --workspace client test           # suíte de front
npm run audit:menu                    # gate de menu × rotas × RBAC × multiempresa
npm run build                         # bundle + PWA
node scripts/smoke-e2e.mjs            # servidor DEMO real em :3001
git diff --check                      # whitespace/quebra de linha
git status --short                    # escopo da mudança
node scripts/smoke-pg.mjs             # (não executado — ver §11)
```

## 11. RESULTADOS DOS GATES

| # | Gate | Comando | Resultado |
|---|---|---|---|
| 1 | Testes frontend | `npm --workspace client test` | ✅ **28 arquivos · 290 testes** (antes: 26/262) |
| 2 | Teste do Sidebar renderizado | `vitest run src/components/Sidebar.test.tsx` | ✅ 14/14 |
| 3 | Teste do Layout/breadcrumb | `vitest run src/components/Layout.test.tsx` | ✅ 8/8 |
| 4 | Gate de menu | `npm run audit:menu` | ✅ 0 erros · 4 avisos (os mesmos 3 `RBAC_DERIVA_SOLTA` + 1 `ROTA_PUBLICA` pré-existentes) |
| 5 | Typecheck | `npm run typecheck` | ✅ 0 erros (domain + server + client) |
| 6 | Lint | `npm run lint` | ✅ 0 erros · 415 avisos (`no-explicit-any`, pré-existentes). **Arquivos do ciclo: 0 erros / 0 avisos** |
| 7 | Build | `npm run build` | ✅ bundido em 17,66s · `index-*.js` 322,01 kB (gzip 96,06 kB) · PWA `generateSW` 59 entradas |
| 8 | Smoke existente | `node scripts/smoke-e2e.mjs` (servidor DEMO em `:3001`) | ✅ **126/126 verificações OK** |
| 9 | `git diff --check` | — | ✅ limpo |
| 10 | `git status` | — | ✅ 8 modificados + 2 testes novos + o relatório da auditoria; nada fora do escopo |
| 11 | Alterações fora do escopo | conferência arquivo a arquivo | ✅ nenhuma (nenhum arquivo de servidor/banco/API/regra de negócio) |

**Gates NÃO executados (declarado):** `npm run test:pg` / `npm run smoke:pg` (exigem PostgreSQL real). Nenhuma linha de backend/banco/migration foi alterada neste ciclo, então o resultado seria decorativo aqui; a configuração do gate PostgreSQL **não foi alterada** e o CI continua rodando esses jobs normalmente.

## 12. EVIDÊNCIA VISUAL

**“Validação visual bloqueada por ausência de navegador no ambiente.”** Confirmado por tentativa real: não há `chromium`/`chrome`/`firefox` instalados e `npx playwright install chromium` falha no download (`Download failure, code=1` — CDN bloqueado neste sandbox). Nenhuma captura de tela foi inventada ou fabricada.

No lugar dela, **evidência de renderização** dos componentes reais (jsdom, fora do repositório, sem alterar nada):

```
### SIDEBAR ADMIN (13 grupos / 70 itens)
Meu Negócio · ERP: Cadastros(8) · Vendas(9) · Compras(7) · Estoque(4) · Produção(4) ·
Logística & Expedição(4) · Financeiro(10) · FISCAL(4) · Relatórios(1) ·
Commerce / Integrações: Integrações(5) · Gestão de Commerce(4) · Ecossistema Creators(4) ·
Sistema: Configurações(5)

### FISCAL
admin:      /documentos-fiscais=true /regras-fiscais=true /ncm=true /inutilizacoes=true
gerente:    (idem)
operador:   /documentos-fiscais=true /regras-fiscais=false /ncm=false /inutilizacoes=false

### HEADER /                          → BROBOND ERP › Meu Negócio   (aria-current="page")
### HEADER /produtos/12               → BROBOND ERP › Cadastros › Produtos(link) › #12
### HEADER /documentos-fiscais        → BROBOND ERP › Fiscal › Documentos fiscais
### HEADER /regras-fiscais            → BROBOND ERP › Fiscal › Regras fiscais
### HEADER /ncm                       → BROBOND ERP › Fiscal › NCM / Tributação
### HEADER /inutilizacoes             → BROBOND ERP › Fiscal › Inutilizações
### HEADER /vendas/7                  → BROBOND ERP › Vendas › Vendas(link) › #7
```

Marcação semântica do breadcrumb: `<nav aria-label="Trilha de navegação"><ol>…`, último nível com `aria-current="page"`, níveis intermediários como `<a href>` (SPA, sem recarregar), área como texto (`semLink`). No trilho colapsado o conteúdo continua apenas com ícones (`title`/`aria-label`), como antes.

## 13. PROBLEMAS ENCONTRADOS FORA DO ESCOPO (registrados, **não** corrigidos)

1. **As 3 derivações de RBAC menu × API** (`politicas_comerciais`, `listas_preco`, `envios`) — P1 do UX-01-D; continuam com aviso no gate.
2. **Menu não é empresa-aware** (nenhum item muda com a empresa ativa/consolidada) — P1 (`UX01-P1-06`), ciclo futuro.
3. **Itens de menu sem tela funcional** (8 `planned`: Commerce e Creators) e **WooCommerce sem entrada navegável** — fora do A/B.
4. **Legado morto ligado à navegação** (`client/src/sw.ts` órfão, `PAGES_ESPECIAIS`, `findModuleByResource`, 12 exports do UI kit sem uso) — UX-01-E. O `Breadcrumb` deixou de estar nessa lista neste ciclo (passou a ser usado pelo shell).
5. **`client/public/manifest.json`** ainda chama o atalho de “Dashboard” (o PWA instalado). É nomenclatura, não navegação — ciclo de limpeza.
6. **`fixes-bloco-a.patch`** na raiz (patch não aplicado) — achado da auditoria, mantido.
7. **`Escape`/foco no drawer mobile** e **Tooltip** sem uso — P2 de acessibilidade, UX-01-G.
8. Comentários internos (“para o Dashboard”, “estilo Dashboard”) em `Charts.tsx`, `periodo.ts`, `EstoqueGradePage.tsx` — cosmético (P3), sem efeito na interface.
9. **Ambiente sem navegador** — evidência visual completa fica para o UX-01-G.

## 14. RISCOS REMANESCENTES

| Risco | Avaliação |
|---|---|
| Bundle cresceu ~1 kB (322,01 vs 320,95 kB) | esperado (breadcrumb + seções); gzip 96,06 kB; nenhum impacto perceptível |
| Breadcrumb em telas estreitas | o componente esconde os níveis do meio abaixo de `sm` e o último nível trunca; `flex-wrap` não estoura o header de 64 px — **não validado em navegador real** (ver §12) |
| Rotas filhas fora do padrão de id (`/dev/componentes`) | mostram apenas “BROBOND ERP”; nenhuma rota foi criada, renomeada ou removida |
| Menu de quem já usava o sistema | ganha 4 itens (Fiscal) para admin/gerente e 1 para operador; grupos abertos/colapsados continuam em `localStorage` (`brobond_nav_groups`, `brobond_nav_collapsed`) |
| Cache/service worker | **não tratado neste ciclo por decisão de escopo** — a hipótese de bundle antigo no cliente continua não comprovada; a estratégia pertence ao UX-01-E (nada foi apagado, nenhum SW foi alterado) |

## 15. CONCLUSÃO OBJETIVA

**CORRIGIDO**

* divergência “declarado × renderizado” eliminada: a Sidebar renderiza `NAV_SECTIONS` (fonte única) — **0 listas locais de grupos**;
* **Fiscal** entra no menu quando o perfil autoriza (4 módulos; operador só o irrestrito);
* menu renderizado **=** `visibleModules(MODULES)` nos 3 perfis (70/66/43);
* shell único, agora com **breadcrumb clicável** derivado de `MODULES` (com `aria-current` e sem duplicar definição de rotas);
* “Dashboard” eliminado do shell (header, busca global e o botão “Voltar ao …”);
* **22 testes novos** de navegação/shell, com **prova de mutação** (o teste falha se um módulo declarado deixar de ser renderizado);
* RBAC, multiempresa (remontagem na troca de empresa), CommandPalette, responsividade e acessibilidade preservados;
* todos os gates do §15 verdes (frontend, testes novos, audit:menu, typecheck, lint, build, smoke 126/126, `diff --check`, escopo).

**AINDA ABERTO** (explicitamente fora do A/B)

* 3 derivações de RBAC menu × API (UX-01-D);
* menu empresa-aware (P1);
* agrupamento definitivo por áreas da especificação + submenus (UX-01-C);
* limpeza de legado e estratégia de service worker (UX-01-E);
* E2E visual/regressão de interface em navegador (UX-01-F/G);
* validação visual publicada — **bloqueada neste ambiente por ausência de navegador**.

**Este relatório não declara o ciclo “100% concluído”**: o escopo A/B está implementado e verificado por testes e renderização; a validação visual em navegador real e os ciclos C–G permanecem pendentes por decisão de escopo.

### Critérios de aceite do §16

- [x] Existe um único shell · [x] “/” apresenta “Meu Negócio”, não “Dashboard” · [x] Breadcrumb funciona nas rotas autenticadas · [x] Breadcrumb não cria definição duplicada de rotas
- [x] Sidebar com fonte única de grupos/módulos · [x] Sem listas independentes admin/gerente/operador · [x] Fiscal aparece quando autorizado · [x] Os 4 módulos fiscais alcançáveis pelo menu quando autorizados
- [x] Menu renderizado = módulos visíveis esperados · [x] Teste falha se um módulo declarado deixar de ser renderizado (provado por mutação) · [x] Teste falha se um item for renderizado sem correspondência oficial
- [x] Admin, gerente e operador testados · [x] CompanySwitcher funciona · [x] Escopo multiempresa não enfraquecido · [x] CommandPalette funciona · [x] Rotas existentes continuam funcionando
- [x] Nenhuma funcionalidade de negócio alterada · [x] Nenhuma migration criada · [x] Nenhum P1 fora do escopo misturado
- [x] Build verde · [x] Testes verdes · [x] Lint/typecheck verdes · [x] `git diff --check` verde · [x] Working tree final coerente
