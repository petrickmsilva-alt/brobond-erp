# Fase 4.2 — registro de correções por risco

Autorização do Diretor: R-12, R-4, R-14, R-15 (somente gate de leitura), R-1, R-10 e R-3.
Branch `arena/c0104925-brobond-erp`. Sem merge, PR, push, deploy, alteração de Render ou variáveis de produção, chamadas de escrita a provedores, envios reais, pagamentos ou recorrências reais.

Cada seção traz: problema, correção, testes (RED → GREEN), limitações e pendências.

---

## R-3 — PostgreSQL obrigatório em produção

**Problema.** Sem `DATABASE_URL`, `getStore()` caía em `MemStore` mesmo com `NODE_ENV=production`, com apenas um aviso no log.

**Correção.**
- `bancoAusenteEmProducao(env, temBanco)` (`server/src/security.ts`): função pura. Verdadeira somente quando `NODE_ENV=production` e não há banco.
- `assertProductionSecrets()` encerra o processo (`exit 1`) com aviso claro quando a condição é verdadeira. É chamado no boot antes de escutar a porta.
- `getStore()` (`server/src/services.ts`): em produção sem banco lança `HttpError 503`. Nunca cria `MemStore`.
- `/api/health` responde 503 com `db: "ausente-em-producao"` quando a condição é verdadeira. O corpo não expõe detalhes.
- Middleware de prontidão bloqueia rotas de negócio com 503 nessa condição (defesa além do boot).

Fora de produção (`NODE_ENV` ausente, `test` ou `development`) a memória continua permitida, para testes isolados e desenvolvimento.

**Testes** (`server/test/banco-obrigatorio-producao.test.ts`, 4 testes; cenários de boot e store rodam em processo filho):
- RED antes da correção: 3 falhas (`MemStore` em produção sem banco; processo não encerrou no boot; função inexistente). O cenário de controle com `DATABASE_URL` passava, como esperado.
- GREEN depois da correção: 4/4.

**Limitações.** O teste de health não sobe o servidor HTTP; a cobertura do health é por leitura do código e pelo bloqueio no boot. Não houve teste contra PostgreSQL real nesta fase.

**Pendência.** Confirmar no Render que `DATABASE_URL` está definida no serviço de produção. Isso não foi verificado (sem acesso ao Render). Se estiver ausente, a instância passará a não subir, o que é o comportamento desejado, mas deve ser planejado.

---

## R-10 — PagBank: sem access token como segredo de webhook

**Problema.** Quando `PAGBANK_WEBHOOK_SECRET` (ou o segredo cadastrado) estava ausente, `configuration.ts` gravava o access token como `webhook_segredo_cifrado` (`webhook || token`) e usava o token como `webhookSecret`. O verificador do PagBank aceitava assinatura válida mesmo com `webhookSecret` nulo.

**Correção.**
- `segredoWebhookEfetivo(code, cadastrado, credentials)` (`modules/payments/application/configuration.ts`): o segredo de webhook só existe se for próprio. Se estiver vazio, ou se for igual ao access token (configuração legada gravada com o token), o resultado é `null`.
- `configuracaoAmbientePagamento(code, env, empresaId, legacyId)`: fallback por variáveis de ambiente. Só cria configuração quando há `*_WEBHOOK_SECRET` próprio, tanto para PAGBANK quanto para STRIPE. O segredo gravado é o dedicado.
- `PagBankProvider.verifyWebhook`: retorna `false` quando `webhookSecret` é nulo (falha fechada). `capabilities` já não anuncia PIX sem segredo.

**Conflito de contrato (decisão necessária do Diretor).** A documentação oficial do PagBank ("Confirmar autenticidade da notificação") define `x-authenticity-token = SHA-256 hex de "{access_token}-{corpo cru}"`. Ou seja, **o access token é a chave do esquema de autenticação do próprio provedor**. Por isso:
- o fallback de *configuração* foi removido (era um erro de modelagem: o segredo gravado era o token);
- a **chave criptográfica da verificação não foi trocada** por um segredo que o PagBank não usa. Trocar quebraria todas as notificações legítimas, e isso não foi feito sem autorização;
- o `PAGBANK_WEBHOOK_SECRET` passa a ser exigido como segredo próprio da configuração (requisito do Diretor), e a verificação só ocorre quando ele existe.

Se o Diretor preferir outro comportamento (por exemplo, uma camada adicional com segredo dedicado além do esquema do PagBank), isso precisa de nova decisão e de homologação com notificação real.

**Efeito em configurações existentes.** Configurações cadastradas antes desta correção, com o token gravado como segredo, passam a falhar fechadas (não são aceitas). É preciso regravar o segredo dedicado na tela de configuração. Impacto operacional: PIX PagBank fica indisponível até a regravação.

**Testes.**
- `server/test/pagbank-webhook-segredo.test.ts` (9 testes). RED antes da correção: 4 falhas (`segredo ausente` aceitava assinatura válida; funções inexistentes). GREEN: 9/9.
- Testes de caracterização existentes (`fase3-pagamentos-canonico`, `payment-engine`) asseveravam a aceitação sem segredo próprio. Foram atualizados para o novo contrato: sem segredo próprio → recusado; com segredo próprio → aceito.

**Limitações.** Sem notificação real do PagBank (sem egress). Verificado apenas o cálculo local da assinatura documentada.

---

## R-1 — Rota legada `/api/marketplace/sincronizar`

**Problema.** A rota estava sob `requireAuth`, sem papel nem empresa. Qualquer usuário autenticado, de qualquer perfil, disparava chamadas ao Mercado Livre com o token estático `MERCADOLIVRE_TOKEN`. O token não pertence a nenhuma empresa, e o registro de auditoria saía com a empresa do ator.

**Correção** (`server/src/marketplace.ts`, `sincronizarPedidos`):
- `checkAccess(RESOURCES.vendas, actor, 'create')`: RBAC por recurso, igual ao módulo de loja.
- Perfil `admin` obrigatório (403 para `gerente` e `operador`). Motivo: o token é da instalação, então qualquer gerente de uma empresa receberia pedidos de uma conta que não é dele. Restringir a administrador é a forma segura enquanto a rota existir.
- Contexto de empresa explícito (`empresa_id > 0`), 403 caso contrário.
- Funcionalidade mantida. Não foi removida: `grep` em `client/`, `server/test/` e `scripts/` não encontrou dependências, mas a rota continua como legado até a migração para o conector OAuth por empresa.

**Testes** (`server/test/marketplace-legado-autorizacao.test.ts`, 5 testes; `fetch` mockado):
- RED antes da correção: 3 falhas (operador, gerente e admin sem empresa recebiam resposta/chamada). Admin com empresa já era aceito, como esperado.
- GREEN: 5/5. Verifica que a chamada externa **não ocorre** para quem é negado.

**Remanescente.**
- `GET /api/marketplace/status` continua para qualquer usuário autenticado. Ele devolve apenas `configurado`/`ativo`, sem segredo. Recomendação: restringir da mesma forma.
- O endereço de pedidos usa o literal `seller=seller_id` (bug de código; não é o id do vendedor). Não foi corrigido nesta fase, porque a correção depende da migração.

---

## R-12 — Isolamento dos alertas por empresa

**Problema.** Os relatórios de posição de estoque, vendas e alertas liam os recursos sem recorte por empresa e enviavam **o mesmo HTML** a todos os endereços de `SCHEDULE_EMAILS`/`NOTIFICAR_EMAILS`. O relatório de falhas somava outbox, webhooks e notificações de todas as empresas. Além disso, o **lembrete de CRM** (ativo no agendador) usava a mesma lista global com nome de lead e oportunidade de uma empresa.

**Correção.**
- `server/src/destinatariosEmpresa.ts` (novo): `destinosPorEmpresa(permitidos, recursos)`. Regras:
  - a lista configurada **só restringe**; nunca amplia a distribuição;
  - destinatário é resolvido pelo caminho do login (`findUserByEmail`, `SELECT *`), com `empresa_id` e permissões;
  - exige acesso vigente (ativo e não expirado), vínculo com a empresa (`empresasDoUsuario`) e leitura de **todos** os recursos do e-mail (RBAC existente, `checkAccess`);
  - empresa sem destinatário identificado não recebe envio.
- `server/src/scheduled.ts`: `relatorioPosicaoEstoque`, `relatorioVendas` e `relatorioAlertas` iteram por empresa. Cada leitura usa `aplicarFiltroEmpresa` (mesmo padrão das rotas). O envio é injetável (`enviar`), para teste.
- `server/src/alertasFalhas.ts`: `coletarFalhasEntrega(agora, { empresaId })` exige escopo. Lê apenas outbox e notificações da empresa. **Webhooks ficam fora** (R-14).
- `server/src/notifications.ts`: `enviar()` exige `empresaId` e `recursos`. Sem isso, não envia. Lembrete de CRM passa a usar o recorte por empresa. As `notificar*` de evento (estoque, insumo, OP, venda, compra) **não têm chamador ativo**, e ficam desativadas até receberem escopo explícito (aviso no log).

**Decisões que dependem do Diretor.**
1. Com esta correção, a distribuição **diminui** para quem não está vinculado e autorizado. Quem está na lista e não tem vínculo deixa de receber. Ampliar a distribuição (lista por empresa no cadastro) é decisão separada e não foi feita.
2. Operador deixa de receber relatórios de alerta e de falhas: `commerce_outbox` e `commerce_notificacoes` exigem gerente (`minPerfil`). O relatório só vai a quem tem leitura de todo o conteúdo.
3. Notificações de evento sem escopo ficam desativadas. Religá-las exige passar `empresaId` e `recursos` em cada chamada.

**Achado durante a correção.** O recurso `usuarios` não declara `empresa_id`, embora o banco tenha a coluna (migração 0017). Listar usuários pelo recurso faria todos caírem na empresa padrão, e o destinatário receberia dados de outra empresa. Por isso a resolução usa `findUserByEmail`.

**Testes.**
- `server/test/alertas-isolamento-empresa.test.ts`: 8 testes. Cobrem isolamento de dados por destinatário, falha de fila sem vazamento cruzado, webhook global fora do relatório, destinatário sem vínculo/expirado não recebe, sem destinatário a empresa não envia, posição e vendas por empresa, lembrete de CRM por empresa, evento sem escopo não enviado.
- RED: 6 falhas antes da correção nos alertas. Os testes de CRM e de evento falharam por ausência da injeção de envio; o vazamento do CRM foi confirmado por leitura do código (`destinatarios()` global). GREEN: 8/8.
- Atualizados os testes da Fase 4.1 que documentavam a leitura global (`segregacao-multiempresa-alertas`, 3 testes), e os de `alertas-falhas-entrega` (2 testes), para o novo contrato com escopo. Os testes de caracterização "comportamento atual" foram trocados por asserções de isolamento. Isso é a correção autorizada, não um enfraquecimento.

**Remanescentes.**
- Falhas de webhook de saída não aparecem em nenhum relatório por empresa até a decisão de modelagem (R-14).
- Entrega real de e-mail não testada (SMTP não configurado no ambiente). Validação local apenas.

---

## R-4 — Recorrências financeiras fora do relatório; contrato do cron

**Problema.** `runScheduled` (relatório manual) e `cronScheduled` (cron externo) executavam `processarRecorrencias`, que **gera lançamentos financeiros**. Um relatório, portanto, tinha efeito financeiro. Além disso, o cron tinha dois defeitos: (a) com `CRON_SECRET` vazio, a checagem era ignorada (fail-open); (b) o endpoint ficava atrás de `requireAuth`, então o segredo do cron nunca era aceito e a rota só funcionava com sessão de administrador. A rota administrativa de recorrências tinha o mesmo ramo de segredo fail-open e executava com identidade fictícia "Agendador", sem escopo de empresa.

**Correção.**
- `server/src/scheduled.ts`: `runScheduled` e `cronScheduled` **não** importam nem chamam `processarRecorrencias`. Relatórios e lembretes continuam como antes.
- Contrato do cron (`cronConfigurado`, `cronAutorizado`):
  - método e rota: `POST /api/admin/scheduled/cron`;
  - autenticação: `Authorization: Bearer <CRON_SECRET>`, comparada em tempo constante (hash SHA-256 de tamanho fixo);
  - sem `CRON_SECRET` definido: **503**, nada é executado;
  - segredo ausente ou errado: **401**;
  - sessão de usuário (Bearer de sessão) **não** autentica o cron;
  - montado em `server/src/index.ts` **antes** de `app.use('/api', requireAuth)`. Está fora de `/api/admin` e da guarda de administrador, porque a autenticação dele é o segredo, não a sessão.
- `server/src/financeiro.ts` — `cronRecorrencias` (rota `POST /api/admin/financeiro/recorrencias`, que continua exigindo sessão de administrador):
  - exige confirmação explícita no corpo: `{"confirmar":"PROCESSAR_RECORRENCIAS"}`, senão **400**;
  - aplica `checkAccess` (lançamentos: criar; recorrências: ler) e `escopoDoAtor`: processa só a empresa do administrador (ou o grupo, se ele tiver consolidação);
  - removidos o ramo de `CRON_SECRET` e a identidade "Agendador".
- Fluxo de usuário `POST /api/financeiro/recorrencias/gerar` (já existente, usado pelo front): sem alteração. Já tinha `checkAccess` e escopo.

**Contrato documentado (resumo).**
| Item | Valor |
|---|---|
| Relatórios agendados | `SCHEDULE_*` (ver matriz de configuração); destinatários conforme R-12 |
| Cron externo | `POST /api/admin/scheduled/cron`, `Authorization: Bearer <CRON_SECRET>` |
| Recorrências (usuário) | `POST /api/financeiro/recorrencias/gerar`, sessão + permissão de lançamentos |
| Recorrências (admin) | `POST /api/admin/financeiro/recorrencias`, sessão de admin + `{"confirmar":"PROCESSAR_RECORRENCIAS"}` |
| Agendador interno | **Não criado.** Nada dispara recorrências sozinho. |

**Impacto operacional (requer ciência do Diretor).** Antes, as recorrências eram geradas como efeito colateral do relatório/cron. Agora **nenhum processo automático gera lançamentos**: a geração passa a ser feita pelo usuário (rota de usuário) ou por ação administrativa confirmada. Se o Diretor quiser geração automática, isso é um novo fluxo, com autorização e aprovação próprias. Não foi criado nesta fase.

**Variável.** `CRON_SECRET` é a variável já existente e documentada. Nenhuma variável nova. Nenhuma alteração no Render, em `render.yaml` ou em valores. O valor da variável não foi lido nem impresso.

**Testes** (`server/test/cron-recorrencias-contrato.test.ts`, 8 testes):
- RED antes da correção: 5 falhas (cron sem segredo executava; relatório executava recorrências; execução sem confirmação rodava; execução sem escopo; cron atrás da sessão). Controles que já passavam: sessão não autentica o cron; segredo correto funciona; rota admin continua protegida.
- GREEN: 8/8.
- Teste da Fase 4.1 `segregacao-multiempresa-alertas` ("rotas admin depois da guarda"): a lista deixou de incluir o cron, que agora é intencionalmente montado antes da guarda. Justificativa no próprio teste.

**Verificação de não disparo.** Nenhum teste chama `processarRecorrencias` com dados reais. Os testes de cron usam o store em memória, sem recorrências cadastradas, e sem rede. A ausência de chamada é verificada pela leitura do código-fonte e pelo teste de contrato.

**Remanescentes.**
- O cron ainda executa rotinas de publicação e fila de comércio (`processarComercioAgendado`). A suspensão de publicação ML/Nuvemshop (flag `PUBLICACAO_CANAIS_LIBERADOS`) continua valendo. Não foi alterada nesta fase.
- O documento `docs/RELATORIO-SEC-03.md` registra o cron como fail-open. Esse registro é o estado anterior à correção e fica como histórico.

---

## R-14 — Associação segura de evento de webhook a empresa (proposta; sem migração aplicada)

**Problema.** `webhooks` e `webhook_entregas` (`db/schema.sql` 1157/1168; migração `0010_onda4_governanca.sql` 22/34) **não têm `empresa_id`**. Configuração e entregas de webhook de saída são globais, criadas só por administrador. Por isso, uma falha de entrega não pode ser atribuída a uma empresa com segurança. Por outro lado, a entrada de pagamento (`gateway_webhook_events`) **já tem** `empresa_id` e índice único `(LOWER(provider), evento_id)`.

**Correção implementada (sem alterar esquema).** `server/src/webhookEmpresa.ts`, função pura `resolverEmpresaDoEvento`:
1. Assinatura inválida → recusado. Nenhuma associação.
2. Empresa da configuração (endpoint/conexão) é a fonte confiável. O payload não decide tenant sozinho.
3. Identificador do provedor só associa quando resolve para **uma** empresa. Conflito com a configuração, ou mais de uma empresa → recusado (ambíguo).
4. Evento sem empresa (configuração global, sem identificador) permanece **global**.
5. `chaveIdempotenciaEvento(provedor, eventoId)`: sem id do evento, recusa (não há como deduplicar).
6. Puro: sem banco e sem consulta cruzada (verificado por teste).

**Testes** (`server/test/webhook-empresa-resolucao.test.ts`, 9 testes): RED por ausência do módulo; GREEN 9/9.

**Proposta de modelagem (NÃO aplicada; depende de aprovação).**
- `webhooks.empresa_id INTEGER NULL REFERENCES empresas(id)`. `NULL` = configuração global, como hoje. Linhas existentes ficam `NULL` (sem backfill automático, para não atribuir dados a uma empresa por suposição).
- `webhook_entregas.empresa_id INTEGER NULL` (desnormalizado a partir do webhook no momento da entrega), com índice `(empresa_id, estado, concluida_em)`.
- Criação de webhook pela interface exige escolher empresa **ou** marcar explicitamente "global". Não há valor padrão.
- Nenhuma tabela de entrada nova: `gateway_webhook_events` já cobre a idempotência de pagamento.
- Riscos da migração: relatórios que dependem de `webhook_entregas` ficam sem atribuição para linhas antigas (permanecem globais). Rollback: remover as colunas (sem perda de dados existentes).
- Testes previstos antes de aplicar: migração em base de homologação, contagem de linhas `NULL` antes e depois, criação com e sem empresa, leitura cruzada negada, e a chave de idempotência em entrega duplicada.

**Decisão necessária do Diretor.** (a) Aprovar a migração acima ou manter webhooks globais por decisão. (b) Definir se webhooks de saída devem ser por empresa. Até a decisão, falhas de webhook ficam **fora** dos relatórios por empresa (ver R-12).

## R-15 — Gate de leitura Nuvemshop 2025-03 (BLOQUEADO; sem escrita)

**Problema.** A publicação Nuvemshop 2025-03 usa `Authorization: Bearer` (`server/src/commerce/publicacaoNuvemshop.ts`, 53–55). O conector v1 documenta `Authentication: bearer`. Fontes de terceiros divergem sobre a 2025-03. Não há confirmação oficial nem leitura real.

**Entrega nesta fase.** Documento `docs/auditoria/gate-leitura-nuvemshop-2025-03.md` com a divergência, as regras do gate (somente GET, loja de teste, token fora do repositório), o procedimento de três leituras GET e a matriz de decisão. Teste de guarda `server/test/nuvemshop-gate-leitura.test.ts` (5/5, local). A guarda confirma que o cabeçalho e a base de produção **não mudaram**.

**Estado.** BLOQUEADO. Sem credencial de loja de teste no ambiente. Nenhuma leitura feita. Nenhuma escrita feita. Migração de publicação **não considerada homologada**. Não houve correção de cabeçalho: qualquer correção depende de leitura real e de aprovação do Diretor.

**Natureza dos testes de R-15.** São guardas (estado atual) e não RED→GREEN de correção. O risco não é corrigido nesta fase; é bloqueado com evidência necessária registrada.

## Atualização Fase 4.3 (ponteiro)

Os riscos desta tabela foram tratados na Fase 4.3. Ver `docs/auditoria/fase-4-3-registro.md`:
- R-12 (`f1cf8b8`), R-4 (`0503f82`), R-1 (`d66afb9`), R-14 (`99b9626`), R-10 (`fd8c64a`), R-3 (revalidado), R-15 (bloqueado).
Este histórico da 4.2 foi preservado sem alteração.
