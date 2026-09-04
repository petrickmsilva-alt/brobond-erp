# BROBOND ERP — Auditoria Completa e Plano de Evoluções Profissionais

**Data:** 04/09/2026 · **Base auditada:** branch `arena/01a06d82-brobond-erp`  
**Commit base:** `384b2aa214f0f46b98f5423c8c8f5afdee2c8af5`  
**Versão atual:** 0.4.0 (package.json) / 0.5.0 (VERSION constante no código)  
**Tempo total de auditoria:** análise linha por linha de ~13.680 linhas server + ~8.000 linhas client

---

## 1. Sumário Executivo

O BROBOND ERP está em **estágio avançado de maturidade** para um sistema interno de confecção. A arquitetura é sólida, a lógica de negócio é coerente e o código está majoritariamente bem organizado. A auditoria revelou **pontos positivos expressivos** e **achados que exigem atenção** antes de colocar o sistema em produção com dados reais.

### Pontuação Geral

| Área | Nota (1-10) | Comentário |
|---|:---:|---|
| Arquitetura e padrões | 9 | CRUD genérico orientado a metadados é excelente |
| Segurança | 7 | Bom base, mas com inconsistências e lacunas |
| Qualidade do código | 7 | Bom, mas com duplicação e alguns padrões fracos |
| Consistência | 6 | Versões divergentes, naming inconsistente |
| Testes | 6 | Boas regras de negócio, mas cobertura baixa |
| Banco de dados | 8 | Schema bem estruturado, migrações idempotentes |
| Frontend | 8 | UI polida, componentes reutilizáveis |
| Infraestrutura/Deploy | 7 | CI ok, falta monitoramento e observabilidade |
| Documentação | 7 | README e docs ajudam, mas faltam JSDoc/typedoc |

**Nota geral: 7.2/10** — sistema funcional e bem construído, com oportunidades claras de profissionalização.

---

## 2. O que está EXCELENTE (manter e celebrar)

### 2.1 Arquitetura orientada a metadados ⭐
O sistema tem uma **fonte única de verdade** (`resources.ts`) que define campos, tipos, validação, permissões e dados iniciais. Este é um padrão profissional de alto nível — adicionar um campo em um módulo é uma linha no `resources.ts` + uma coluna no banco. Isso reduz erros e garante consistência entre API, validação, formulários e tabelas.

### 2.2 Segurança da camada de dados ⭐
- SQL 100% parametrizado — nomes de tabela/coluna nunca vêm do input do usuário
- `senha_hash` nunca é exposto na API (filtrado no `SELECT`)
- Transações com rollback consistente (snapshot no `memdb`, `BEGIN/COMMIT/ROLLBACK` no `pg`)
- Controle de acesso por perfil (operador/gerente/admin) com verificação em cada rota

### 2.3 Regras de negócio integradas ⭐
- Movimentações imutáveis (só lançamento inverso)
- Baixa de estoque ao faturar venda + estorno ao cancelar
- Custo médio ponderado ao receber compra + reversão ao cancelar
- OP concluída dá entrada + consome insumos; reabrir estorna tudo
- Inventário congela saldo e gera ajustes

### 2.4 Modo demonstração ⭐
A implementação `MemStore` é um diferencial — permite treinar a equipe sem banco, com regras de negócio idênticas.

### 2.5 UI/UX ⭐
Interface limpa em português, com validação por campo, toasts, modais de confirmação, busca, paginação, gráficos no Dashboard e tema consistente.

---

## 3. Achados da Auditoria (Problemas Identificados)

### 3.1 🔴 CRÍTICOS (corrigir antes de produção)

#### 3.1.1 Inconsistência de Versão
```
package.json (root):  0.4.0
client/package.json:  0.4.0
server/package.json:  0.4.0
server/src/index.ts:  VERSION = '0.5.0'  ← DIVERGENTE
log.ts (Sentry):      '0.4.0' (hardcoded fallback)
```
**Impacto:** Releases no Sentry, health checks e documentação ficam com versão errada.  
**Correção:** Usar uma única fonte de verdade (ler de `package.json` ou definir constante compartilhada).

#### 3.1.2 Senha padrão hardcoded no código-fonte
```typescript
// auth.ts
export const ADMIN_PASSWORD = (process.env.ADMIN_PASSWORD || 'brobond123').trim();
```
A senha `brobond123` está no código-fonte, visível em qualquer `git log`. Se um deploy acontecer sem `ADMIN_PASSWORD` configurado, o admin terá essa senha fraca.  
**Correção:** Em produção, recusar iniciar se `ADMIN_PASSWORD` não estiver definida OU exigir troca forçada no primeiro acesso (já implementado com `trocar_senha`, mas o default ainda é arriscado).

#### 3.1.3 JWT Secret padrão no código
```typescript
const SECRET = process.env.JWT_SECRET || 'brobond-dev-secret';
```
Embora `assertProductionSecrets()` bloqueie em produção, se `NODE_ENV` não estiver `production` por engano em um deploy, o secret fraco será aceito.  
**Correção:** Logar warning visível em qualquer ambiente que não tenha `JWT_SECRET` customizado.

#### 3.1.4 Rate limit em memória (perdido em restart)
```typescript
// security.ts
const buckets = new Map<string, Bucket>();
```
O rate limit de login usa um `Map` em memória. Ao reiniciar o processo (deploy na Render), todos os bloqueios são perdidos.  
**Impacto:** Atacante pode esperar um deploy para retentar login.  
**Correção:** Para sistema em produção com volume baixo, é aceitável. Para alto risco, migrar para Redis.

#### 3.1.5 Pool de conexão sem tratamento robusto de desconexão
```typescript
// db.ts
max: 10
```
Não há configuração de `connectionTimeoutMillis`, `idleTimeoutMillis`, nem retry/reconnect. Se o Postgres cair temporariamente, o pool pode ficar com conexões "zumbis".  
**Correção:** Adicionar `connectionTimeoutMillis: 5000`, `idleTimeoutMillis: 30000` e handler de erro no pool.

### 3.2 🟡 IMPORTANTES (corrigir na próxima sprint)

#### 3.2.1 Duplicação de função `round2`/`round3`
As funções `round2` e `round3` estão duplicadas em **4 arquivos**: `itens.ts`, `producao.ts`, `services.ts`, `memdb.ts`.  
**Correção:** Mover para um `lib/math.ts` ou `utils.ts` compartilhado.

#### 3.2.2 Função `tipoFromPath` frágil
```typescript
// itens.ts
function tipoFromPath(pathname: string): TipoPedido {
  return pathname.split('/').includes('vendas') ? 'venda' : 'compra';
}
```
Depende do path da URL conter "vendas" — se a URL mudar, quebra silenciosamente.  
**Correção:** Passar o tipo como parâmetro explícito nas rotas, ou usar `req.baseUrl`.

#### 3.2.3 `listItens` (vendas) carrega TODOS os produtos para mapear fotos
```typescript
// itens.ts → listItens()
const produtos = await getStore().list(getResource('produtos')!, { page: 1, pageSize: 2000 }, null);
```
Carrega até 2000 produtos só para mapear a URL da foto de cada produto vendido.  
**Correção:** Buscar apenas os produtos referenciados nos itens do pedido, ou fazer query direta de fotos.

#### 3.2.4 `exportarRecurso` lê todas as páginas (até 30.000 linhas em memória)
```typescript
// export.ts
for (;;) {
  const resul = await s.list(r, ...);
  linhas.push(...resul.rows);
  if (page * 500 >= resul.total) break;
  if (page > 60) break; // trava de segurança: 30 mil linhas
}
```
Para bases grandes, consome muita memória.  
**Correção:** Streaming com cursor para CSV; paginação com batch para XLSX.

#### 3.2.5 Cliente (API) sem retry nem timeout configurável
```typescript
// client/src/lib/api.ts
res = await fetch(`/api${path}`, { ... });
```
Sem timeout, sem retry, sem tratamento de rede instável (comum em celular).  
**Correção:** Adicionar `AbortController` com timeout (30s), retry para erros 5xx/rede.

#### 3.2.6 Token JWT em `localStorage` (vulnerável a XSS)
```typescript
const TOKEN_KEY = 'brobond_token';
localStorage.setItem(TOKEN_KEY, token);
```
`localStorage` é acessível por qualquer script na página. Um ataque XSS roubaria o token.  
**Correção:** Para o estágio atual, é aceitável. Alternativa profissional: `httpOnly cookie` no servidor (exige refactor da auth).

#### 3.2.7 Filtro de data com injeção potencial de formato inválido
```typescript
// pgstore.ts → searchClause()
const dia = v.slice(0, 10);
if (!/^\d{4}-\d{2}-\d{2}$/.test(dia)) continue;
params.push(dia);
conds.push(`t.${mDate[1]} >= $${params.length}::date`);
```
O regex valida o formato, mas o valor é enviado como parâmetro — isso é seguro. Porém, `mDate[1]` (nome da coluna) não é validado contra as colunas do recurso antes de montar a query.  
**Correção:** Validar `mDate[1]` contra `cols` (já feito para filtros de igualdade, mas não para data).

#### 3.2.8 `noUnusedLocals: false` e `noUnusedParameters: false`
```json
// client/tsconfig.json
"noUnusedLocals": false,
"noUnusedParameters": false
```
Permite código morto sem warning.  
**Correção:** Habilitar `true` gradualmente e limpar imports não utilizados.

### 3.3 🟢 MELHORIAS (qualidade profissional)

#### 3.3.1 Ausência de logs estruturados no cliente
Erros no frontend só aparecem no console do navegador. Não há envio para Sentry ou serviço similar.  
**Correção:** Adicionar `@sentry/react` no client + capturar erros de renderização com Error Boundary.

#### 3.3.2 Testes cobrem apenas regras de negócio (2 arquivos)
Não há testes de:
- API HTTP (end-to-end com supertest)
- Validação de payloads (edge cases)
- Autenticação (login, reset, token expiration)
- Uploads (fotos)
- Dashboard queries
- Importação/exportação

#### 3.3.3 `any` espalhados no código
```typescript
(req as any).user = payload;
(req as any).resource = r;
const res: any = { status: () => res, json: () => res };
```
Uso extensivo de `any` enfraquece a tipagem.  
**Correção:** Criar interfaces estendidas para `Request` com `user` e `resource`.

#### 3.3.4 Componentes sem separação clara de responsabilidades
`ModulePage.tsx` (671 linhas) e `OrderPage.tsx` (689 linhas) misturam lógica de negócio, fetch de dados e renderização.  
**Correção:** Extrair hooks customizados (`useRecords`, `useOrder`, etc.) para separar dados de UI.

#### 3.3.5 `createRequire` duplicado
```typescript
// mail.ts
const require = createRequire(import.meta.url);
// log.ts
const require = createRequire(import.meta.url);
// catalogos.ts
const require = createRequire(import.meta.url);
```
Repetido em 3 arquivos.  
**Correção:** Centralizar em um utilitário ou usar `import()` dinâmico.

#### 3.3.6 Sem error boundary global no React
Se um componente lançar erro durante renderização, a tela inteira fica em branco.  
**Correção:** Adicionar `ErrorBoundary` no `App.tsx` com tela de erro amigável e opção de recarregar.

---

## 4. Plano de Evoluções Profissionais

### FASE A — Correções Críticas (1-2 dias) 🔴

| Item | Descrição | Esforço |
|---|---|:---:|
| A1 | **Unificar versão** — ler de `package.json` em todos os lugares | 1h |
| A2 | **Exigir ADMIN_PASSWORD em produção** — recusar boot sem ela | 30min |
| A3 | **Configurar pool do Postgres** — timeouts, idle, erro handler | 1h |
| A4 | **Validar coluna de filtro de data** contra colunas conhecidas | 1h |
| A5 | **Adicionar Error Boundary** no frontend | 1h |
| A6 | **Criar interfaces tipadas** para `req.user` e `req.resource` | 2h |

### FASE B — Qualidade de Código (2-3 dias) 🟡

| Item | Descrição | Esforço |
|---|---|:---:|
| B1 | **Extrair `round2`/`round3`** para utilitário compartilhado | 1h |
| B2 | **Refatorar `tipoFromPath`** — passar tipo explicitamente | 2h |
| B3 | **Otimizar `listItens`** — buscar apenas produtos necessários | 2h |
| B4 | **Centralizar `createRequire`** em utilitário | 1h |
| B5 | **Habilitar `noUnusedLocals`/`noUnusedParameters`** e limpar | 2h |
| B6 | **Adicionar retry + timeout** no `apiFetch` | 2h |
| B7 | **Streaming para exportação** (CSV grande) | 3h |

### FASE C — Observabilidade e Monitoramento (2 dias) 📊

| Item | Descrição | Esforço |
|---|---|:---:|
| C1 | **Sentry no frontend** (`@sentry/react`) + Error Boundary integrado | 3h |
| C2 | **Health check enriquecido** — versão, uptime, contagem de tabelas, latência do banco | 2h |
| C3 | **Métricas de uso** — endpoint `/api/admin/metrics` com: usuários ativos, requests/min, erros/min | 3h |
| C4 | **Log de acesso a dados sensíveis** — exportação, backup, alterações de usuário | 2h |
| C5 | **Dashboard de saúde** — tela admin com status do banco, disco, uptime | 3h |

### FASE D — Testes e Confiabilidade (3-4 dias) 🧪

| Item | Descrição | Esforço |
|---|---|:---:|
| D1 | **Testes de API HTTP** (supertest) — login, CRUD, permissões, erro 404 | 4h |
| D2 | **Testes de autenticação** — token, refresh, logout-all, reset | 3h |
| D3 | **Testes de validação** — edge cases, SQL injection, XSS | 3h |
| D4 | **Testes de estoque** — concorrência, saldo negativo, transferência | 3h |
| D5 | **Testes de produção** — OP grade, consumo de insumos, estorno | 3h |
| D6 | **Testes de importação** — CSV mal formado, XLSX, encoding | 2h |
| D7 | **Cobertura de código** — integrar `c8` ou `vitest --coverage` | 2h |

### FASE E — Segurança Avançada (2-3 dias) 🔐

| Item | Descrição | Esforço |
|---|---|:---:|
| E1 | **Política de senha forte** — mínimo 8, não pode ser o e-mail, bloquear lista de comuns | 2h |
| E2 | **2FA opcional** (TOTP) para administradores | 6h |
| E3 | **Auditoria de tentativas de login** — tabela dedicada, não só memória | 3h |
| E4 | **Sessão com refresh token** — access token curto (15min) + refresh token (7d) | 4h |
| E5 | **CSRF protection** — token CSRF para mutations (se migrar para cookie auth) | 3h |
| E6 | **Content Security Policy** — header CSP para mitigar XSS | 2h |
| E7 | **Sanitização de input HTML** — se algum campo aceitar rich text | 2h |

### FASE F — Performance e Escala (2-3 dias) ⚡

| Item | Descrição | Esforço |
|---|---|:---:|
| F1 | **Cache de dashboard** — TTL 60s no servidor (muitas queries SQL) | 2h |
| F2 | **Índices compostos** para queries frequentes (vendas por período, etc.) | 2h |
| F3 | **Paginação com cursor** para listas grandes (em vez de OFFSET) | 4h |
| F4 | **Lazy loading de módulos** no frontend (React.lazy + Suspense) | 2h |
| F5 | **Service Worker / PWA** — cache de assets estáticos | 3h |
| F6 | **Compression** (gzip/brotli) no Express para responses JSON | 1h |
| F7 | **Connection pooling** com PgBouncer ou aumentar `max` do pool | 1h |

### FASE G — Funcionalidades Profissionais (5-7 dias) 🚀

| Item | Descrição | Esforço |
|---|---|:---:|
| G1 | **Notificações** — e-mail automático para: pedido faturado, estoque mínimo, OP concluída | 6h |
| G2 | **Impressão de pedido** em PDF (logo + dados + itens em grade + totais) | 4h |
| G3 | **Leitor de código de barras** (câmera do celular) para movimentação e inventário | 6h |
| G4 | **Multi-empresa** — se o sistema crescer para atender outras confecções | 8h |
| G5 | **API pública documentada** (OpenAPI/Swagger) para integração com marketplace | 6h |
| G6 | **Workflow de aprovação** — operador cria, gerente aprova vendas acima de X reais | 4h |
| G7 | **Relatórios agendados** — enviar por e-mail semanalmente (posição de estoque, vendas) | 4h |
| G8 | **Integração com NF-e** — gerar nota fiscal eletrônica a partir da venda faturada | 8h |
| G9 | **App mobile nativo** (React Native) ou PWA avançado com offline | 12h |

### FASE H — DevOps e Infraestrutura (2-3 dias) 🏗️

| Item | Descrição | Esforço |
|---|---|:---:|
| H1 | **Dockerfile** para containerização consistente | 2h |
| H2 | **docker-compose.yml** — dev local com Postgres + API + client | 2h |
| H3 | **Ambientes separados** — staging + production na Render | 3h |
| H4 | **Backup automatizado** — script cron + upload para R2/S3 | 3h |
| H5 | **Lint e format** — ESLint + Prettier no CI (bloquear merge se falhar) | 2h |
| H6 | **Dependabot / Renovate** — atualização automática de dependências | 1h |
| H7 | **Database migrations versionadas** — em vez de schema.sql monolítico | 4h |

---

## 5. Checklist de Consistência Atual

| Item | Status | Detalhe |
|---|:---:|---|
| Versão unificada | ❌ | `0.4.0` vs `0.5.0` no index.ts |
| TypeScript strict | ✅ | Ambos projetos com `"strict": true` |
| ESLint configurado | ❌ | Nenhum lint configurado |
| Prettier | ❌ | Sem formatter |
| `.env.example` completo | ✅ | Documenta todas as variáveis |
| CI/CD | ✅ | GitHub Actions: typecheck + testes + build |
| Testes | ⚠️ | 2 arquivos (regras + pedidos), boa lógica, baixa cobertura |
| Error handling global | ✅ | Middleware no `index.ts` |
| Logs estruturados (server) | ✅ | JSON em produção, emoji em dev |
| Logs estruturados (client) | ❌ | Só console do navegador |
| Sentry (server) | ✅ | Opcional via `SENTRY_DSN` |
| Sentry (client) | ❌ | Não implementado |
| Docker | ❌ | Sem containerização |
| Documentação de API | ❌ | Sem OpenAPI/Swagger |
| README atualizado | ✅ | Detalhado e em português |
| `.gitignore` | ✅ | Cobre node_modules, dist, .env |
| Deprecation warnings | ⚠️ | `itens_ficha_tecnicica` renomeada (tratado no schema) |

---

## 6. Priorização Recomendada (Roadmap 30 dias)

```
Semana 1:  FASE A (correções críticas) + FASE B (qualidade)
Semana 2:  FASE C (observabilidade) + FASE D (testes)
Semana 3:  FASE E (segurança) + FASE F (performance)
Semana 4:  FASE G items G1-G3 (notificações, PDF, código de barras)
Contínuo: FASE H (DevOps) conforme disponibilidade
```

---

## 7. Métricas de Código

| Métrica | Valor |
|---|---|
| Linhas de código (server) | ~13.680 |
| Linhas de código (client) | ~8.000 |
| Linhas de código (schema SQL) | ~550 |
| Arquivos TypeScript (server) | 22 |
| Arquivos TSX/TS (client) | 35 |
| Tabelas no banco | 22 |
| Recursos/módulos na API | ~18 |
| Testes existentes | 2 arquivos (~20 testes) |
| Dependências server | 9 runtime + 7 dev |
| Dependências client | 10 runtime + 3 dev |
| Tempo estimado total de evolução | ~60 dias úteis |

---

## 8. Conclusão

O BROBOND ERP é um sistema **acima da média** para o estágio em que se encontra. A arquitetura de metadados é um diferencial que poucos sistemas internos possuem. Os pontos críticos são majoritariamente de consistência (versão) e segurança operacional (senhas padrão, rate limit volátil).

As evoluções propostas transformam o sistema de um **MVP funcional** em um **ERP profissional** com:
- Monitoramento e observabilidade (Sentry, métricas)
- Segurança robusta (2FA, refresh tokens, CSP)
- Confiabilidade (testes, CI, error boundaries)
- Escalabilidade (cache, paginação por cursor, streaming)
- Funcionalidades comerciais (PDF, código de barras, notificações)

A base é sólida — trata-se de polir e completar, não de refatorar.
