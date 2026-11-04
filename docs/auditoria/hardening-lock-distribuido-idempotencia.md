# Auditoria de hardening de cron — resultado parcial, NÃO APROVADO

## Base e escopo

Em 2026-11-04, `git fetch origin main` confirmou `origin/main` no commit
`5e9bcf53fc358b35bda80f07a6dc13312e19fc78` (merge do PR #104); a árvore
estava limpa. A branch fixa da sessão é `arena/615f44fd-brobond-erp`.
Não se criou a branch solicitada com outro nome. Este relatório registra o que
foi efetivamente feito, não uma aprovação do desenho pedido.

## Segurança: alterações e limitações

`scripts/ux05-fixtures.mjs`, `scripts/smoke-e2e.mjs`,
`scripts/smoke-creators.mjs`, `scripts/smoke-dependencias.mjs`,
`scripts/smoke-pg.mjs` e `server/test/smoke.mjs` exigem senha inicial por
`BROBOND_TEST_ADMIN_PASSWORD`; os smokes exigem também
`BROBOND_TEST_NEW_PASSWORD`. Ausência ou espaços abortam antes da rede, sem
fallback para a senha legada. UX05 continua exigindo `UX05_PASS` (ou seu alias
existente) para a senha nova. O CI gera credenciais aleatórias de curta duração,
mascara-as e as usa apenas em processos de teste. `README.md` documenta o uso.
As funções `msg` dos dois smokes que imprimiam texto de erro remoto agora não
imprimem mais esse texto, que poderia refletir credenciais. Os testes novos usam
segredos gerados aleatoriamente, verificam ausência/fallback e envio da senha
para servidor local de teste, além de não exibição em resposta de erro; os testes
existentes do UX05 continuam verificando não exposição e permissão do arquivo
TOTP. O smoke E2E real de memória não registrou as duas senhas nos logs capturados.

**Não foi concluída a eliminação integral de credenciais literais**. Em particular,
`server/src/senhaAdmin.ts` ainda define fallback para desenvolvimento e testes;
`server/.env.example`, `README.md`, dois testes PG (`prod-db-01-readiness` e
`prod-db-013-emergency-token`), e documentação histórica também contêm o valor
legado. A política de senhas e testes de rejeição contêm o mesmo valor como item
proibido, não como credencial ativa. `server/test/smoke.mjs` ainda contém valores
sintéticos usados em testes negativos; os testes e fixtures do repositório contêm
outras credenciais sintéticas. O JWT de desenvolvimento também possui fallback
em `server/src/chavesCifra.ts`. **Não há evidência aqui de que o valor legado tenha
sido usado em produção**; se uma verificação independente confirmar uso real,
a credencial deve ser rotacionada pelo responsável. Não houve rotação externa.

Uma varredura de arquivos rastreados, lendo também arquivos ignorados pelas buscas
normais quando rastreados, identificou 16 arquivos com o valor legado e 60
arquivos com padrões genéricos de atribuição de senha/segredo/token (incluem
falsos positivos e testes), e zero correspondências para formatos verificados de
chave privada, token GitHub clássico ou chave AWS AKIA. Essa heurística não prova
inexistência de outros segredos; falta revisão completa de todos os resultados,
incluindo artefatos históricos como `fixes-bloco-a.patch`. Histórico Git não foi
reescrito. Não se garante I-12 para todo o repositório.

## Os cinco jobs existentes (nenhum protegido por lock distribuído nesta entrega)

Entrada comum: `POST /api/admin/scheduled/cron/:processo` → `cronProcesso` →
`executarProcessoCron`, em `server/src/scheduled.ts`. A rota compatível sem
sufixo e `runScheduled` também chegam ao processo de relatórios. Autenticação e
retentativa existentes não foram alteradas. Cliente `scripts/cron-processo.mjs`
retenta até três vezes por padrão. Timeouts abaixo são os padrões no servidor,
configuráveis por `CRON_TIMEOUT_<PROCESSO>_MS`; timeout não cancela o trabalho.
Conclusão atual: retorno do executor sem entradas em `falhas`.

| Job | Execução, dependências, unidades observáveis e efeitos | Timeout |
|---|---|---:|
| `relatorios` | `executarRelatoriosCron`: agendas de estoque, vendas e alertas; consulta dados e envia e-mails por empresa/destinatário. A combinação empresa, tipo, período e destinatário precisa ser modelada; hoje não há registro geral de idempotência do envio. Repetir pode reenviar. | 300 s |
| `pagamentos` | `executarPagamentosCron`: `runPaymentJobs`, expiração de checkouts e outbox `refund_devolucao`; unidades incluem intent, evento de webhook, checkout e evento de outbox. Lê provedor e atualiza estado, podendo desencadear efeitos financeiros. Retry depende dos mecanismos de cada domínio. | 240 s |
| `publicacoes` | `executarPublicacoesCron`: fila de catálogo e outbox `publicacao`; unidades são linhas da fila/outbox e vínculos produto/variante/canal; grava e pode publicar externamente, respeitando bloqueios existentes. | 300 s |
| `pedidos` | `executarPedidosCron`: recuperação de eventos de venda/Instagram e outbox de conversão, notificação, alerta e sincronização; unidades são eventos de ingestão/outbox; grava e pode notificar/sincronizar. | 240 s |
| `crm` | `executarCrmCron`: atividades CRM por empresa; usa `lembrete_enviado_em` como reivindicação condicional antes de notificar; falha após marcação pode perder notificação. Canal desabilitado não marca. | 120 s |

`commerce/outbox.ts` já usa CAS de `claim_versao` para concluir a própria linha,
mas isto não blinda necessariamente todos os efeitos executados entre claim e
conclusão. Esses mecanismos existentes não equivalem a idempotência integral
por unidade nem a fencing para todos os cinco jobs.

## Lock, migrações, fencing, idempotência e recuperação

Não foram implementados lock PostgreSQL, lease, heartbeat, fencing integrado,
registro unificado de trabalho, migrações ou rollback. A trava existente
`emExecucao` é um `Set` local ao processo: instâncias distintas podem executar
o mesmo job em paralelo. Nenhuma chave de idempotência nova foi criada. Não há
prova de que trabalho concluído não seja repetido, ou de que worker obsoleto
não persista um efeito. Nenhuma migração foi executada. Um lock isolado de
curta duração não resolveria o problema: os executores abrangem transações,
outboxes e chamadas externas em módulos diversos; é preciso fazer os pontos
críticos verificarem o token dentro de cada transação e tratar os provedores sem
idempotência como efeitos de entrega no mínimo uma vez ou incertos. Não se pode
prometer exatamente uma vez para SMTP ou provedores sem suporte idempotente.

## Evidências dos invariantes

I-01, I-03, I-04, I-05, I-06, I-07, I-08, I-09 e I-11: **não comprovados / não
implementados**. I-02 e I-10: existe independência local entre jobs diferentes,
mas independência distribuída não foi comprovada. I-12: **não comprovado**,
devido aos remanescentes acima. Não há eventos novos de observabilidade de lock.
Não executar jobs reais com a expectativa de exclusividade distribuída.

## Testes executados

- `node --import tsx --test server/test/smoke-credentials-security.test.ts server/test/ux05-fixtures-security.test.ts`: 5 aprovados, 0 falhas, 0 ignorados.
- `npm run test:server`: 2.022 testes; 1.940 aprovados, 0 falhas, 82 ignorados. Os ignorados não são evidência dos cenários correspondentes.
- `npm run test:client`: primeira execução 1.150 aprovados, 1 falha por timeout de 5 s em `NotificacoesPage.test.tsx`, enquanto outras verificações estavam simultâneas. Repetida isoladamente: 1.151 aprovados, 0 falhas, 0 ignorados.
- Smoke E2E real em servidor local de memória com senhas aleatórias: 398/398 verificações, sem ocorrência das senhas nos logs capturados. Nenhum serviço externo de produção foi chamado.
- `npm run typecheck`: passou; `npm run lint`: passou com 612 avisos e 0 erros; `npm run build`: passou.
- `env -u DATABASE_URL npm run test:pg`: bloqueado com exit 2: exige banco PostgreSQL de teste novo. Não havia servidor/banco PostgreSQL de teste configurado nem binários PostgreSQL encontrados. Nenhuma conexão ou migração foi feita em produção.
- Testes de concorrência real multiprocessos, idempotência nova e recuperação distribuída: **não implementados/não executados**; zero instâncias e zero aquisições verificadas. Testes com mocks não foram apresentados como prova de concorrência distribuída.

## Git e produção

As alterações e commits devem ser conferidos por `git log` e `git status`; no
momento da redação ainda não havia commit ou push desta entrega. Não houve merge,
deploy, alteração de Render, migração em produção, execução de job real ou
chamada de escrita a provedor externo. O estado remoto do push deve ser conferido
no resultado efetivo do comando, não inferido deste documento.

Atualização posterior: o commit de implementação e relatório `06cfd67` foi
publicado com sucesso em `origin/arena/615f44fd-brobond-erp`. Esta atualização
será registrada em um commit adicional, identificável por `git log`; o resultado
do push desse commit deve ser verificado no comando de entrega. Não foi aberto PR.
