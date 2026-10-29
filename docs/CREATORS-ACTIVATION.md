# Creators — ativação da interface e limites reais

Data: 2026-10-29. Escopo exclusivo: Creators, Matches, Outreach AI e Campanhas de creators.

## Inspeção antes da implementação

- `client/src/modules.ts`: os quatro módulos tinham `planned`, subgrupo `Roadmap` e palavras-chave de planejamento. Sidebar, TopNavigation e CommandPalette derivavam seus selos desse registro.
- `client/src/pages/ModulePage.tsx` encaminhava o espaço Creators para `CommerceModulePage.tsx`. Este continha um esqueleto sem consultas, com cartões sem dados, plano de capacidades e ações desabilitadas.
- `App.tsx`: as quatro rotas já eram geradas por MODULES dentro da sessão protegida; nenhuma possuía CRUD próprio.
- Não foram encontrados recursos, services, repositories, models Prisma, tabelas SQL, migrations, permissões de negócio, endpoints ou engines específicos de creators/matches/outreach/campanhas de creators em `server/src`, `modules`, `packages`, `prisma` ou `db`.
- `crm_campanhas` é aquisição do CRM. Reutilizá-lo como campanha de creators ou transformar clientes/representantes em creators misturaria domínios e inventaria vínculos.
- Os conectores de Instagram e o matcher de catálogo pertencem à ingestão de Commerce; não são cadastro de creators nem matching de creators com campanhas.
- Não existe fonte de registros de Creators a consultar nesta versão. Não foi acessado um banco de produção; a inspeção é do código e dos contratos versionados.

## Entrega

1. Removidos `planned` e o subgrupo de roadmap na origem dos quatro módulos. Os mesmos destinos continuam sujeitos ao mecanismo de sessão e navegação já existente.
2. Dispatcher dedicado a Creators, carregado sob demanda; retirado o antigo esqueleto de Creators do dispatcher compartilhado, sem modificar fluxos de Commerce.
3. Reutilizados PageHeader, Alert, Spinner, EmptyState, botões e tokens de superfície/bordas/tema do ERP/Commerce.
4. Navegação local entre os quatro submódulos; breadcrumb de Matches, Outreach AI e Campanhas retorna de fato a `/creators`. Navegação mobile global preservada.
5. Consulta autenticada `GET /api/creators/capabilities` informa as capacidades **ausentes** da instalação. É metadado, não uma API de listagem: não devolve registros fabricados, arrays de negócio vazios ou totais zero.
6. A API aplica `currentUser`, valida os mesmos três perfis existentes e resolve a Empresa pelo `escopoDoAtor`. Query, corpo ou cabeçalho não definem o tenant; a resposta é `private, no-store`. A rota fica depois dos guards globais de autenticação, senha provisória, prontidão e emergência e antes do CRUD genérico.
7. Loading, falha com retry, sucesso de consulta de capacidades e estado vazio explícito. Erro ou contrato incompatível nunca vira estado vazio silencioso. Respostas de navegação anterior são descartadas.
8. Sem KPIs, filtros, colunas ou CTAs de escrita sem suporte. Sem engines, mensagens, scores, envios ou resultados simulados. Sem seed, nova tabela, migration, `organizationId` ou backend de negócio paralelo.

## Status por submódulo

| Rota | Interface | Operações de negócio disponíveis no repositório |
|---|---|---|
| `/creators` | Ativa; navegação, consulta de capacidades, loading/error/retry/empty | Cadastro, detalhe, edição e métricas: ausentes |
| `/matches` | Ativa; navegação, consulta de capacidades, loading/error/retry/empty | Engine, recomendações e score: ausentes |
| `/outreach-ai` | Ativa; navegação, consulta de capacidades, loading/error/retry/empty | Pipeline, geração, histórico e envio: ausentes |
| `/campanhas` | Ativa; navegação, consulta de capacidades, loading/error/retry/empty | Cadastro, detalhe, edição e resultados de creators: ausentes |

**Não é uma declaração de CRUD, matching ou IA plenamente operacionais.** É o fallback de interface solicitado para capacidades sem backend correspondente, com ausência de integração explicitamente informada ao usuário. Não foram criadas rotas `/novo`, `/:id` ou `/:id/editar` sem persistência correspondente. A ausência de fonte não é apresentada como uma contagem real de zero registros.

## Validação somente do domínio

- Testes de Creators no servidor: 10 aprovados. Incluem HTTP com middleware canônico, sessões reais de teste, perfis admin/gerente/operador, acesso anônimo recusado, seletor de empresa autorizado e rejeição de tenant arbitrário.
- Testes da página de Creators: 17 aprovados. Cobrem as quatro rotas, loading, empty, erro de permissão, retry, atualização, navegação, contrato inválido, resposta atrasada e ausência de CTAs/indicadores fictícios.
- Testes existentes de menu, módulos e breadcrumb atualizados para não exigir mais os selos de planejamento de Creators.
- `npm test`: aprovado; servidor 1463 aprovados e 68 ignorados, cliente 1004 aprovados (109 arquivos). Os testes dependentes de PostgreSQL não foram executados sem `DATABASE_URL`.
- `npm run typecheck`: aprovado (domain, server, client).
- `npm run lint`: aprovado, 0 erros; 591 avisos existentes no conjunto do repositório.
- `npm run build`: aprovado.
- Smoke restrito `scripts/smoke-creators.mjs`: autenticação e MFA reais em servidor de teste em memória; capacidades autenticadas, rejeição anônima e HTTP 200 nas quatro páginas.
- Smoke em Chromium/Playwright: 116 verificações aprovadas nas quatro páginas autenticadas, em larguras 1440, 1280, 768, 390 e 320 px. Sem overflow horizontal, com navegação local e breadcrumb funcionando e sem erros JavaScript.
- O smoke recusa host remoto e banco que não seja em memória antes de alterar o acesso de teste. Não deve ser usado em produção. Browser opcional, com dependências temporárias não adicionadas ao projeto.

## Checklist de interface Creators

- [x] Quatro páginas acessíveis sem classificação de planejamento na fonte do menu.
- [x] Sem textos de roadmap ou disponibilidade futura na interface dos quatro módulos.
- [x] Zero modal/dialog/drawer/sheet nos fluxos do domínio (menu mobile global existente preservado).
- [x] Estados vazios explicam a ausência de integração, sem dados falsos.
- [x] Loading e error/retry distintos do sucesso e do vazio.
- [x] RBAC e resolução de Empresa preservados; nenhum dado de outro domínio usado para preencher telas.
- [x] Responsividade validada em navegador nas cinco larguras acima.
- [x] Contraste e identidade pelo padrão nativo ERP/Commerce, sem opacidade global, overlay ou botões de negócio desabilitados.
- [x] Navegação e breadcrumbs reais.
- [ ] CRUD de Creators e Campanhas, matching e Outreach AI de negócio: não existem no backend desta versão; não foram inventados.

Não foi executada nova auditoria geral do ERP. As suítes de teste obrigatórias foram executadas; documentos históricos de auditoria permanecem como snapshots da versão em que foram escritos.
