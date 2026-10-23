# RELATÓRIO — Evolução do Cadastro de Clientes PF/PJ (Cliente Fase 18)

**Data:** 2026-10-23 · **Escopo:** página própria de clientes PF/PJ com máscaras/validação/normalização brasileiras, prevenção de duplicidade, backend validado, contratos preservados.

---

## 1. O que foi encontrado no sistema atual

- **Cadastro de clientes em MODAL** sobre `/app/clientes` (`clientsPage` em `server/src/meta.ts` → `ModulePage.tsx` → `RecordForm` genérico), com lista paginada + filtros por nome/telefone/e-mail/pessoa.
- **Colunas** `nome`, `pessoa` (enum `pf|pj|estrangeiro`), `cnpj_cpf` (texto, aceitava QUALQUER string ≤ 60), `razao_social`, `nome_fantasia`, `indicador_ie`, `regime_tributario`, `telefone`, `whatsapp`, `email`, `limite_credito` (NUMERIC(12,2)), endereço, `ibge_codigo`, `atraso_medio_dias`.
- **Índice único `uq_clientes_documento_empresa`** (`cnpj_cpf`, `empresa_id`) já existia no `migrations.ts` — suporta bloqueio definitivo de duplicidade sem migration nova.
- **Validação fraca**: `validarEntradaCliente` só exigia nome; `processarCliente` aceitava qualquer documento/telefone/CEP/valor (`es.ts` + `validate.ts` legado).
- **UI compartilhada** `RecordForm.tsx` era o único formulário (modal) e já aplicava máscaras simples (`maskDocumento` alternava CPF/CNPJ por tamanho — injusto com 11-14 dígitos).
- **Contratos públicos**: `GET/POST/PUT/DELETE /api/clientes`, export `Cliente` de `types.ts`, `ClienteListParams`, campos consumidos por **PDV** (`ClienteRef`), **vendas** (`OrderPage`), **financeiro** (parcelas `cliente_nome`), **fiscal** (emitentes, NF-e), **portal do cliente**, **importação CSV**, **módulos por perfil**.
- **Roteamento SPA**: `client/src/App.tsx` → `ModulePage` com apenas as rotas `/app/...` (lista) — não havia página de formulário dedicada.

## 2. O que foi alterado

**Novos:**
- `server/src/clientes.ts` — módulo de clientes: validação PF/PJ/estrangeiro, normalização, duplicidade, service+routes isolados.
- `client/src/pages/ClienteFormPage.tsx` — página de formulário PF/PJ (criar/editar), seções, a11y, máscaras, checagem de duplicidade.
- `server/test/clientes-pf-pj.test.ts` — 33 testes (Fase 15).
- `client/src/lib/format.test.ts` — 17 testes de máscara/validação/normalização.
- `client/src/pages/ClienteFormPage.test.tsx` — 19 testes do formulário.

**Alterados:**
- `server/src/documentos.ts` — `cpfValido`/`cnpjValido` (DV real + repetição), `erroDocumento`, `telefoneBrasileiro`/`telefoneNormalizado`/`erroTelefone`/`formatarTelefone` (DDD oficial, celular 9xxxxxxxx, `+55` sempre Brasil), `emailValido`.
- `server/src/validate.ts` — `validarEntradaCliente` vira wrapper com mensagem específica de CPF/CNPJ (a genérica "Informe um CPF (11 dígitos) ou CNPJ (14 dígitos)" continua nos demais pontos).
- `server/src/services.ts` — `processarCliente` valida documento por `pessoa` e normaliza documento/CEP/telefone/e-mail/razão social.
- `server/src/index.ts` — rota nova `GET /api/clientes/por-documento` ANTES dos CRUDs; alias legado `GET /api/clientes/:id` lida como número.
- `server/src/pgstore.ts` — duplicidade (`criarCliente`/`atualizarCliente`) com `code: 'cliente_duplicado'` (409).
- `server/src/importacao.ts` + `server/src/catalogos.ts` — importação CSV e catálogos usam a validação nova.
- `client/src/lib/format.ts` — `maskCpf`, `maskCnpj`, `maskDocumentoTipo`, `maskPhone`/`maskPhoneFree`/`normalizePhone`/`formatPhone`/`maskPhoneInput`, `maskCep`/`normalizeCep`/`formatCep`, `maskMoneyInput`/`parseMoneyInput`, `UFS_BRASIL` (27 UFs). `formatDocumento` preservado para células existentes.
- `client/src/pages/ModulePage.tsx` + `client/src/modules.ts` — clientes criam/editam por página (`FORM_DIRETO`), o restante continua em modal (`RecordForm` intocado para os outros módulos).
- `client/src/App.tsx` — rotas `/clientes/novo` e `/clientes/:id/editar` (lazy) dentro do `ModuleAccess` de clientes.
- `client/src/components/CatalogoShareModal.tsx` — WhatsApp abre `wa.me/55...` para dígitos BR 10-11 (ex.: `62999999999` → `https://wa.me/5562999999999`).

## 3. Rotas

| Rota | Método | Situação |
|---|---|---|
| `/api/clientes/por-documento?doc=&ignorar_id=` | GET | **NOVA** — achou o cadastro (`{cliente, disponivel}`) ou `{cliente: null, disponivel: true}`; protegida com token; escopo por empresa |
| `/api/clientes` | GET | preservada (lista, filtlos, paginação) |
| `/api/clientes` | POST | preservada + validação/normalização/duplicidade novas (409 `cliente_duplicado`) |
| `/api/clientes/:id` | GET | preservada (alias legado `clientes/:id` numérico continua funcionando) |
| `/api/clientes/:id` | PUT | preservada + regras novas (editar mantendo o próprio documento não conflita) |
| `/api/clientes/:id` | DELETE | preservada |
| `/api/clientes/:id/*` (contatos, endereços, acessos…) | * | preservadas |
| SPA `/clientes/novo`, `/clientes/:id/editar` | — | **NOVAS** (lazy `ClienteFormPage`) |

Nenhum contrato público foi renomeado; campos e formatos de leitura continuam iguais (`telefone` continua sendo texto; agora gravado como `DDD+número` ou `+DDI+número`).

## 4. Componentes de UI

- `ClienteFormPage.tsx` — 3 seções visuais com títulos/ícones/espaçamento (Identificação, Contato, Endereço e financeiro), seletor PF/PJ/Estrangeiro por radiogroup com roteamento nativo de teclado, `aria-pressed`, anel de foco no item ativo.
- `ModulePage` — ações "Novo cliente"/"Editar" levam às rotas novas só para clientes; os demais módulos seguem com `RecordForm` modal intacto.
- Nenhum outro lugar cria cliente na UI (PDV/vendas escolhem cliente existente via `ClienteRef`); `PortalAccessModal`, `ImportModal` etc. intactos.

## 5. Campos PF/PJ

| Tipo | Campos |
|---|---|
| **PF** | Nome completo, apelido, CPF, RG, data de nascimento |
| **PJ** | Razão social, nome fantasia, CNPJ, inscrição estadual, indicador IE (contribuinte/isento/não contribuinte), regime tributário |
| **Comum** | Pessoa (PF/PJ/Estrangeiro), código, e-mail, telefone, WhatsApp, endereço completo, IBGE, limite de crédito, atraso médio, vendedor, observações |
| **Estrangeiro** | Nome, documento livre (8–32), demais campos comuns |

Na UI o "Nome do cliente" virou **Nome completo** (PF) e **Razão social** (PJ, espelhado em `nome` com `-` no apelido), como no PDV.

## 6. Máscaras

| Campo | Máscara aplicada |
|---|---|
| CPF | `000.000.000-00` (`maskCpf`/`maskDocumentoTipo`) |
| CNPJ | `00.000.000/0000-00` (`maskCnpj`) |
| Celular | `+55 (62) 99999-9999` (5-4, adaptativo pelo 9 inicial) |
| Fixo | `+55 (62) 3333-4444` (4-4) |
| Telefone internacional | `+DDI...` livre (8–15 dígitos), usável só para `pessoa: estrangeiro` |
| CEP | `00000-000` |
| Moeda | `R$ 1.500,00` — as-you-type `1.500,5`, exibe `R$` após o blur |
| UF | select fechado com as 27 UFs (`UFS_BRASIL`) |

## 7. Valorações e normalização antes do backend

| Campo | Envio |
|---|---|
| `cnpj_cpf` | **só dígitos** (11 CPF / 14 CNPJ; estrangeiro 8–32 alfanuméricos) |
| `cep` | **só dígitos**, 8 |
| `telefone`/`whatsapp` | `DDD+número` (10–11) ou `+DDI+número`; máscara removida |
| `email` | trim + minúsculas |
| `limite_credito` | `1.500,50` → `1500.5` |
| `nome`/`razao_social` | trim + espaços colapsados |
| troca PF↔PJ | limpa o documento se o nº de dígitos não couber (11↔14) |

## 8. Validações (UI e backend — backend NUNCA confia no front)

- CPF/CNPJ com **dígito verificador real** (algoritmo módulo 11) + recusa de sequências (`000…`, `111…`).
- Mensagens exatas: `CPF inválido.`, `CNPJ inválido.`, `Pessoa física deve usar CPF.`, `Pessoa jurídica deve usar CNPJ.`, `Informe um CPF (11 dígitos) ou CNPJ (14 dígitos)`.
- Telefone: DDD oficial do Brasil (67 DDDs), celular `9xxxxxxxx`, fixo `2–5xxxxxxx`, `+55` **sempre** tratado como Brasil (estrutura BR obrigatória), estrangeiro real `+DDI` (≠55).
- CEP: exatamente 8 dígitos; e-mail sintático; limite de crédito numérico ≥ 0; UF de lista fechada; datas válidas.
- Erro do backend é mostrado no banner do formulário **sem limpar o que foi digitado** (testado).

## 9. Prevenção de duplicidade

- **Consulta durante o preenchimento** (blur do CPF/CNPJ): `GET /api/clientes/por-documento?doc=&ignorar_id=` → se existir, banner vermelho `"Já existe um cliente cadastrado com este CPF."` (+ botão **"Abrir cliente"** → `/clientes/:id/editar`) e **`"Não é possível salvar."`**; se livre, banner verde `"CPF disponível para cadastro."`.
- **Banco/API como garantia definitiva**: índice único `uq_clientes_documento_empresa` + checagem no `pgstore` (409 `cliente_duplicado`, mensagem do spec) + checagem no memdb.
- **Edição não trava**: PUT exclui o próprio `id` da checagem.

## 10. Multi-tenant

- Escopo por empresa em todas as rotas (`escopoEmpresa` no `index.ts`); `empresa_id` presente no índice único de duplicidade; testes (itens 24–25 da Fase 15) validam dois clientes iguais em empresas distintas e no `incluir_empresa_id` compartilhado.

## 11. Banco de dados

**Nenhuma migration nova foi criada.** O schema já suporta tudo (enum `pessoa`, `cnpj_cpf` texto, índice único por empresa). Nada foi alterado no banco.

## 12. Testes executados

| Suíte | Comando | Resultado |
|---|---|---|
| Server (unit + integração memdb) | `npm --workspace server test` | **932 testes — 866 pass, 0 fail, 66 skipped** (skips pré-existentes de gestão de usuários/API keys) |
| Client (vitest) | `npm --workspace client test` | **386 testes — 386 pass, 0 fail** (33 arquivos; inclui os 36 novos) |
| Frontend novo | `npx vitest run src/lib/format.test.ts src/pages/ClienteFormPage.test.tsx` | **36/36** |
| Server novo | `node --import tsx --test test/clientes-pf-pj.test.ts` | **33/33** |
| Smoke HTTP real | `node scripts/smoke-e2e.mjs` (servidor Express real, modo demo) | **126/126** |
| Fluxo HTTP real de clientes | script de verificação (login→criar→duplicidade→editar) | **24/24** (normalização, 409 + code, mensagens do spec, 401 sem token) |
| Typecheck (domain + server + client) | `npm run typecheck` | **0 erros** |
| Lint | `npm run lint` | **0 erros** (411 warnings `no-explicit-any` pré-existentes no repo) |
| Build (vite + PWA) | `npm run build` | **OK** |
| `git diff --check` | — | **OK** (sem espaços/linhas em branco indevidas) |
| PostgreSQL real | `npm run test:pg` | **não executado** — exige `DATABASE_URL` de banco de teste novo; sem PostgreSQL no ambiente de execução (o gate falha com aviso esperado) |

## 13. Testes novos (Fase 15, itens 1–33)

33 testes em `server/test/clientes-pf-pj.test.ts`: CPF/CNPJ válidos/inválidos/sem formatação/com máscara/duplicados/dígito verificador/sequência; telefone brasileiro/internacional/curto/letras/`+55` estruturado; CEP; e-mail; limite de crédito (`'1.500,50'`, `'R$ 1.500,00'`, `'1500.5'`, `''`, negativo, texto); troca PF↔PJ; CRUD completo (criar/listar/buscar/editar/excluir) com **autenticação+empresa reais**; multi-tenant (índice único por empresa); `'estrangeiro'` preservado com `+351...` aceito.

36 testes no frontend: `format.test.ts` (máscaras/validação/normalização, incluindo `+55 (62) 99999-9999` fixado por tipo) e `ClienteFormPage.test.tsx` (troca PF↔PJ, máscaras as-you-type, mensagens do spec, duplicidade + "Abrir cliente", payload normalizado, edição carrega dados, cancelar volta sem salvar, erro do backend preserva dados, loading).

## 14. Problemas encontrados e CORRIGIDOS durante os testes

1. **Colisão de labels**: descrições do seletor PF/PJ citavam "CPF/CNPJ" e quebravam `getByLabelText` (regex ambíguo). Corrigido com textos descritivos distintos.
2. **Mensagem de obrigatório** padronizada para `"Informe o nome completo."` / `"Informe a razão social."` (spec da Fase 15).
3. **BUG REAL de segurança**: `+55 (62) 89999-9999` (celular BR inválido, 8 não pode iniciar celular) era aceito no fallback "internacional". Corrigido nos **dois** lados (`client/src/lib/format.ts` e `server/src/documentos.ts`): `+55`/`55...` 12–13 dígitos é SEMPRE Brasil e precisa fechar DDD+número válido; só `+` com DDI ≠ 55 entra no ramo internacional.
4. `maskPhone` rejeitava `+55` formatado (caía no ramo internacional) e a quebra 4-4/5-4 do fixo. Corrigido (`+55` sempre BR; split adaptativo pelo 9 inicial).
5. **Testes client falhavam** em `toBe(x, 'mensagem')` (vitest desta versão não aceita 2º argumento). Convertido para comentários — tipocheck e testes verdes.

## 15. Pendências

- Rodar `npm run test:pg` quando houver `DATABASE_URL` de banco de teste PostgreSQL novo (roda `database/migrations.ts` + suíte PG completa contra o schema real).
- Desabilitar `pessoa` estrangeiro via config (decisão de produto futura) — hoje o form já oferece o ramo e o backend valida corretamente.

## 16. Commit e branch

- Branch de trabalho da sessão: **`arena/9a75dfed-brobond-erp`** (nome fixado pelo ambiente Arena, equivalente à branch funcional `feat/clientes-pf-pj-professional` solicitada — a sessão só permite trabalhar/commitar neste nome; sem merge com `main`).
- Commit: **`feat(clientes): página PF/PJ com máscaras brasileiras, validação e anti-duplicidade`** (ver `git log`).

## 17. Confirmações finais

- [x] Nenhuma migration criada.
- [x] Nenhum banco alterado.
- [x] Nenhum merge realizado.
- [x] Nenhum deploy realizado.
- [x] Contratos públicos preservados (PDV, vendas, financeiro, fiscal, vendedores intactos — suítes inteiras passando).
- [x] Estado incompleto nunca vaza para o banco (documentação como o cliente/negócio/grupo vem da resposta da API).
- [x] Nomes de campo intactos (`pessoa` era `pj|pf|estrangeiro` e continua); `'estrangeiro'` preservado.
