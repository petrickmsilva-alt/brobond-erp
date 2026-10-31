# Homologação externa final — execução e continuação

Data: 2026-10-31.

BASE_MAIN_SHA=d9f29ddf52eee99c4019e43f03fd0e88b0107653

Branch fixa: `arena/50a466c4-brobond-erp`. A execução inicial confirmou HEAD igual a origin/main após fetch. A continuação parte de `42b652dd54a5780f11ffa3f3c7bce2bc59fdce57`. Não houve merge, troca de branch ou alteração em `backups/`.

## Decisão

**FULL_ENTERPRISE_GO_LIVE = NO. EXTERNAL_HOMOLOGATION_READY = NO.**

Os bloqueios locais de PostgreSQL e Chromium descritos na primeira entrega foram removidos. Os gates operacionais internos abaixo estão verdes. Ainda não há evidência de operação externa real nem validação Prisma concluída; por conservadorismo, **INTERNAL_ENTERPRISE_READY = NO (recertificação integral pendente)**. Isso não revoga a homologação histórica nem significa que os testes internos falharam.

Nenhuma cobrança de produção foi efetuada. Nenhum parceiro recebeu PASS com base em mock, presença de adapter ou configuração. A matriz externa permanece em `EXTERNAL-HOMOLOGATION-MATRIX.md`.

## Correções implementadas

### 1. Vazamento em fixtures UX-05

Defeito encontrado: `scripts/ux05-fixtures.mjs` imprimia senhas em exports de shell e corpos completos de respostas de autenticação, além de gravar TOTP em caminho compartilhado previsível sem proteção explícita.

Correção:

- Não imprime senhas, tokens ou corpos de autenticação em sucesso/erro.
- Diagnósticos de erro mostram somente status HTTP.
- Arquivo TOTP em diretório temporário exclusivo ou caminho explicitamente configurado, com `mode=0600` e criação exclusiva `wx`.
- Variáveis de senha permanecem no ambiente; não são gerados exports com seus valores.
- Na execução dos checks, a senha local foi gerada somente em memória; o TOTP temporário foi removido ao terminar. Nenhuma credencial externa foi inventada.

Regressões: `server/test/ux05-fixtures-security.test.ts`, dois testes executados: caminho de sucesso/permissões e caminho de falha de autenticação. Respostas de um servidor **local simulado** servem exclusivamente para detectar vazamento, não homologar provedores.

### 2. Backup que não restaurava dados operacionais

O recovery real falhou inicialmente por FK `documentos_fiscais → vendas`. Após resolver os ciclos, revelou ausência de pais fora de RESOURCES e, ao incluir recursos de pagamentos, os guards de períodos financeiros expuseram ordem incorreta de restore.

Correções no gerador canônico `server/src/backup.ts`:

- Snapshot de leitura `REPEATABLE READ`, em uma conexão, para o backup servido pelo endpoint e pelo recovery.
- Inventário inclui recursos canônicos de pagamentos e fechamento transitivo das tabelas-pai por FKs reais.
- Ciclos anuláveis e autorreferências são restaurados em duas fases: INSERT com referência temporariamente nula e UPDATE após os registros existirem. Constraints permanecem habilitadas.
- Períodos financeiros são inseridos ao final, depois do histórico e dos vínculos: não se desabilitam guards e não se reabrem períodos existentes.
- Strings numéricas preservam zeros iniciais; escaping SQL e comentário de usuário não permitem inserir nova instrução pelo nome do ator.
- Tabelas vazias também são truncadas no destino; reaplicação não preserva resíduos antigos.
- Sequences são alinhadas aos IDs restaurados para não colidir no próximo cadastro.
- Senhas, MFA, credenciais cifradas e campos de segredo não são exportados. Tokens públicos e hashes de token são substituídos por marcadores **inválidos/revogados**, não por novas credenciais utilizáveis. Rotas públicas exigem formato hexadecimal e/ou comparação com hash calculado.
- Restore não pretende recuperar credenciais: reprovisionamento de acessos, links públicos, agentes, integrações e eventual reconciliação de operações externas pendentes continua obrigatório.

`recovery-check.mjs` agora confere a contagem **exata de todas as tabelas do snapshot**, incluindo as vazias, além dos marcadores multiempresa e da reaplicação idempotente.

Regressão: `server/test/pg/backup-recovery.test.ts`, PostgreSQL real em schema isolado. Exercita pai fora do inventário, ciclo obrigatório/anulável, autorreferência fora de ordem, texto com zeros, tokens revogados, tabela vazia, sequence e fechamento financeiro com trigger ativo. Não há segunda arquitetura, ledger ou estoque operacional.

Limite: backup administrativo de recursos canônicos/pais não é substituto de backup físico/PITR da instância, fotos/bytes e credenciais. Ciclos não anuláveis não suportados falham explicitamente, não são silenciosamente ignorados.

## Evidências finais

| Gate | Resultado efetivamente executado |
|---|---|
| npm test | Exit 0: servidor 1.660 testes, 1.584 PASS, 0 FAIL, 76 skips PG preexistentes; cliente 123 arquivos / 1.067 PASS |
| npm run test:pg | **414 PASS, 0 FAIL, 0 SKIP, 0 TODO**, banco vazio novo, PostgreSQL 16.14; psql real 16.14 |
| npm run smoke:pg | **398/398**, API real contra PostgreSQL descartável |
| npm run smoke (primeira execução) | 398/398 contra memória; não usado como substituto do smoke PG |
| npm run recovery:check | Exit 0: **185 tabelas** com contagem exata, restore em banco novo e reaplicação sem duplicar |
| UX-05 browser | Exit 0: desktop/tablet/mobile, teclado, overflow, menus e deep links previstos no script |
| UX-05 drawer | Exit 0: navegação mobile/tablet e CompanySwitcher/multiempresa |
| UX-05 RBAC | Exit 0: ADMIN/GERENTE/OPERADOR com fixtures locais provisionadas e expectativas explícitas |
| Regressões adicionadas | 2 testes de segurança local + 1 teste PG de restore: 3/3 PASS na repetição final |
| multiempresa-p1 isolado | 9/9 PASS; demais testes multiempresa também nas suites completas |
| npm run typecheck | Exit 0, repetido depois das alterações finais |
| npm run build | Exit 0; avisos de bundle preexistentes |
| npm run lint | Exit 0: 0 erros, 600 warnings; não se afirma lint sem warnings |
| npm audit --json | Exit 1 preservado: **0 HIGH, 0 CRITICAL, 27 MODERATE, 2 LOW** |
| audit:ux / audit:menu / architecture:audit | Exit 0 |
| go-live:audit / commerce:go-live / payment:go-live | Exit 0; são verificações estruturais, não aprovação externa |
| commerce:final-go-live | Exit 1 preservado: faltam evidências externas; estrutural verde |
| capacidades-audit | Exit 0 |
| db:validate | Não aprovado: engine exige download de binaries.prisma.sh, bloqueado pelo egress |

Checks UX-05 validam a navegação e as rotas declaradas, não uma auditoria visual de todas as telas do ERP. O audit estático aceita quatro exceções preexistentes de navegação/infraestrutura; não foram introduzidos modais de módulo.

### Restart real e recuperação de outbox

Banco local dedicado: evento `alerta` persistido em PROCESSANDO com lease expirado, seguido de parada real do processo PostgreSQL e novo boot com o mesmo diretório de dados. Um novo processo de worker, após o bootstrap canônico, recuperou e concluiu o evento; um segundo processo verificou 0 novos processamentos e uma única linha/versão de claim.

Resultado: PASS para persistência após DB restart, recuperação de lease e não repetição de evento concluído. O efeito testado é um alerta interno, não uma cobrança/refund externo. A primeira tentativa do probe sem bootstrap foi corretamente rejeitada com 503 e foi repetida com inicialização correta; esse erro de montagem do teste não foi tratado como aprovação.

### Infraestrutura de teste

Ferramentas provisionadas fora do Git via hosts permitidos:

- PostgreSQL 16.14: pacote npm `@embedded-postgres/linux-x64@16.14.0-beta.17`.
- psql: compilado do código oficial PostgreSQL tag `REL_16_14` obtido no GitHub; ferramentas auxiliares fora do projeto.
- Chromium 153.0.8010.0 via pacote npm, Puppeteer/Playwright disponíveis temporariamente para checks existentes.
- PostgreSQL escuta somente em loopback; autenticação local trust, sem secret externo e sem `.env`. Bancos são descartáveis e não representam ambiente do usuário.

Nenhum binário, SQL com dados, pacote de infraestrutura ou credencial foi adicionado ao Git. As dependências extras foram ligadas apenas dentro de node_modules ignorado. O manifesto e o lockfile do projeto não foram alterados.

## Blocos A–I e jornadas

| Bloco | Evidência | Limite |
|---|---|---|
| A Payments | payment-engine, testes PG de operações/concorrência, refund/disputes/payouts e routing | Sem operação de provider real |
| B Marketplaces | connectors, ingestion/webhook e PG marketplace→venda | Sem OAuth, seller/loja, publicação ou pedido real |
| C Meta | Contratos oficiais Graph/OAuth e testes de segurança | Sem conta Business/permissões reais |
| D Logistics | logistica, WMS/expedição e jornadas PG | Sem carrier real; SIGEP não implementado |
| E ERP | Journeys PG, vendas canônicas, estoque/financeiro e projections | Sem cadeia externa integral |
| F Tenancy/RBAC | Testes PG A×B e browser ADMIN/GERENTE/OPERADOR | Sem webhook externo real |
| G Recovery/Security | Restore, reaplicação, DB restart/outbox e correções de vazamento | Sem timeout/retry/reconciliation reais do provider |
| H Enterprise E2E | Suites internas completas e smoke PG | F1–F8 externos não comprovados integralmente |
| I Final audit | Gates existentes, revisões e documentos atualizados | Prisma bloqueado por egress |

| Jornada | Evidência interna | Resultado externo |
|---|---|---|
| F1 Loja | Loja/catálogo/checkout/pedido/ERP nos testes e smoke PG | BLOCKED_EXTERNAL_CREDENTIAL |
| F2 Payment | Engine/estado/financeiro/concorrência/idempotência PG | BLOCKED_EXTERNAL_CREDENTIAL |
| F3 Marketplace | Connector/inbox/marketplace→venda PG | BLOCKED_EXTERNAL_CREDENTIAL |
| F4 Omnichannel | OMS e Commerce ondas 1–3 e PG | BLOCKED_EXTERNAL_CREDENTIAL |
| F5 Refund | Refund/disputa/financeiro e operações PG | BLOCKED_EXTERNAL_CREDENTIAL |
| F6 CRM | Customer 360 e D1–D8 exercitados em suites locais/PG | CODE_READY_EXTERNAL_UNTESTED para origem externa real |
| F7 Supply | Supply/WMS/expedição/TMS interno e PG | BLOCKED_EXTERNAL_CREDENTIAL para carrier real |
| F8 Finance | Contábil/settlement/reconciliation interno e PG; restore com guards ativos | BLOCKED_EXTERNAL_CREDENTIAL para extratos/payouts reais |

D1–D8: testes internos/PG verdes, não reexecução manual de toda a matriz UI de homologação anterior. Idempotência/concorrência/webhooks em PostgreSQL são evidências internas reais, mas eventos de parceiros continuam simulados nos testes de contrato.

## Segurança e falhas históricas preservadas

A lista de advisories e comandos está no JSON de evidências. Os 29 LOW/MODERATE são preexistentes: cadeias glob/minimatch, uuid, deepmerge, React Router, ESLint, ExcelJS e PWA/workbox. Na primeira execução, `npm audit fix --ignore-scripts` atualizou dependências transitivas sem reduzir os achados; mudanças sem benefício foram descartadas e o lockfile original reinstalado. Não foi usado --force, downgrade major ou migração incompatível para fabricar audit verde. Ausência de HIGH/CRITICAL não significa ausência de explorabilidade; a dívida permanece documentada.

Falhas de recovery intermediárias estão registradas com exit 1 nas evidências, seguidas pelas correções e repetições aprovadas. Skips não foram introduzidos para esconder falhas; o teste PG novo também foi executado explicitamente contra banco real. Logs brutos não são versionados para evitar dados internos; o JSON contém resultados e hashes dos logs locais.

## Bloqueios restantes

1. Credenciais/contas autorizadas sandbox de Mercado Pago, PagBank, Stripe, Mercado Livre, Nuvemshop e Meta indisponíveis; configurações reais de carrier no banco do usuário não acessíveis.
2. Egress aos provedores e callback público de webhook homologado indisponíveis. Não há OAuth, transação, webhook, cancelamento, refund, disputa ou payout real comprovado.
3. Prisma: host do engine bloqueado. Não foi substituído por engine falso nem declarada validação concluída.
4. Gaps explícitos existentes de escopo, independentes de credencial: PagBank cartão/boleto; Correios SIGEP; ingestão automática de payout/fees e submissão de evidência de disputa específicos de provider. Exigem implementação/contrato quando essenciais ao go-live; não foram inventadas APIs nem assumido suporte.

PostgreSQL, psql, Chromium, recovery e teste de restart **não são mais bloqueios locais**.

## Gate final

O SHA literal do commit desta continuação é informado na entrega após commit/push, evitando autorreferência de hash no arquivo.

```text
BASE_MAIN_SHA: d9f29ddf52eee99c4019e43f03fd0e88b0107653
BRANCH: arena/50a466c4-brobond-erp
FINAL_COMMIT: commit que contém este relatório; SHA literal na entrega

PAYMENTS: BLOCKED_EXTERNAL_CREDENTIAL
MERCADO_PAGO: BLOCKED_EXTERNAL_CREDENTIAL
PAGBANK: BLOCKED_EXTERNAL_CREDENTIAL
STRIPE: BLOCKED_EXTERNAL_CREDENTIAL

MARKETPLACES: BLOCKED_EXTERNAL_CREDENTIAL
MERCADO_LIVRE: BLOCKED_EXTERNAL_CREDENTIAL
NUVEMSHOP: BLOCKED_EXTERNAL_CREDENTIAL
INSTAGRAM_META: BLOCKED_EXTERNAL_CREDENTIAL

LOGISTICS: BLOCKED_EXTERNAL_CREDENTIAL
CARRIERS: BLOCKED_EXTERNAL_CREDENTIAL

D1_CUSTOMER: PASS — interno/PG
D2_GROWTH: PASS — interno/PG
D3_DATA_BI: PASS — interno/PG
D4_AI: PASS — interno/PG
D5_SUPPLY: PASS — interno/PG
D6_WMS_TMS_SUPPLIER: PASS — interno/PG
D7_FINANCE_EPM: PASS — interno/PG
D8_GOVERNANCE: PASS — interno/PG

F1_LOJA: BLOCKED_EXTERNAL_CREDENTIAL
F2_PAYMENT: BLOCKED_EXTERNAL_CREDENTIAL
F3_MARKETPLACE: BLOCKED_EXTERNAL_CREDENTIAL
F4_OMNICHANNEL: BLOCKED_EXTERNAL_CREDENTIAL
F5_REFUND: BLOCKED_EXTERNAL_CREDENTIAL
F6_CRM: CODE_READY_EXTERNAL_UNTESTED
F7_SUPPLY: BLOCKED_EXTERNAL_CREDENTIAL
F8_FINANCE: BLOCKED_EXTERNAL_CREDENTIAL

P0: 0 detectados no audit estrutural final; externo NÃO TESTADO
P1: 0 detectados no audit estrutural final; externo NÃO TESTADO

POSTGRES: PASS — 414/414, sem skip
SERVER: PASS — 1584 PASS; 76 skips sem DB, cobertos pelo gate PG separado
CLIENT: PASS — 1067 testes
SMOKE: PASS — 398/398 PostgreSQL
TYPECHECK: PASS
BUILD: PASS
LINT: PASS — 0 erros, 600 warnings
SECURITY: 0 HIGH/CRITICAL; audit exit 1, 27 MODERATE e 2 LOW
RECOVERY: PASS — 185 tabelas, reaplicação e restart/outbox locais
TENANCY: PASS — interno/PG/browser; externo NÃO TESTADO
RBAC: PASS — interno/PG/browser; externo NÃO TESTADO
IDEMPOTENCY: PASS — interno/PG; externo NÃO TESTADO
CONCURRENCY: PASS — interno/PG; externo NÃO TESTADO
WEBHOOKS: CODE_READY_EXTERNAL_UNTESTED

EXTERNAL_HOMOLOGATION_READY: NO
INTERNAL_ENTERPRISE_READY: NO — recertificação integral pendente do Prisma
FULL_ENTERPRISE_GO_LIVE: NO

BLOCKERS: credenciais/contas e rede/callback externos; engine Prisma; gaps de escopo de providers descritos no relatório.
```
