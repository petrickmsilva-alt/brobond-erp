# Auditoria executada — Commerce, Payment Engine e conectores

**Data:** 2026-11-04
**Escopo:** código e testes do checkout, pedidos, estoque, Payment Engine, conectores de canal/pagamento e comunicações transacionais.
**Resultado:** evidências locais aprovadas nos gates abaixo; **FULL GO-LIVE: NÃO**, pois não houve homologação com contas/providers externos nem cobrança real.

## 1. Correções entregues nesta execução

- `GET /api/commerce/pagamentos` usa o recurso interno correto no RBAC, tenant ativo, filtros no backend, paginação e `private, no-store`; não expõe `provider_ref`.
- O vínculo cobrança → pedido consulta somente os IDs da página, inclusive no PostgreSQL; pedidos além dos primeiros 1.000 registros não perdem a associação. `sale_id` ausente permanece `null`, sem link para o literal `"null"`.
- Resultado ambíguo de criação no provider não é convertido em falha comprovada: pedido e reservas continuam recuperáveis para webhook/conciliação.
- `GET /api/loja/checkout/:chave` recupera somente pedido/sale existentes, sem criar pedido ou cobrança. O cliente faz no máximo um POST para a mesma chave e recupera apenas erro de rede/resultado ambíguo.
- Replay de criação valida o contrato do método antes de aplicar o resultado. Pix incompleto não troca chave nem cria fallback; replay válido reutiliza a operação.
- Disponibilidade pública usa a célula canônica de tamanho/local/reserva: M disponível permanece selecionável e G sem célula/saldo fica esgotado e desabilitado.
- O painel Mercado Pago separa conta importada (`sales`), BroBond Store (`payment_intents`) e conciliação financeira (liquidações, disputas e repasses), sem somar essas visões como se fossem uma única receita.
- Mercado Livre não copia mais corpo bruto de resposta OAuth rejeitada para logs; somente status e código curto são registrados.
- Nuvemshop `authorized` sem captura permanece `PENDING`; somente `paid` confirma receita.
- A auditoria enterprise passou a reconhecer a Central de Notificações existente em Integrações. A galeria administrativa continua com confirmação inline, sem diálogo ou overlay.

## 2. Matriz A01–A24

**CONFORME LOCAL** significa que existe evidência reproduzível em código/teste/banco descartável. Não significa homologação externa nem operação em produção.

| ID | Frente | Status | Evidência executada |
|---|---|---|---|
| A01 | Arquitetura, módulos e rotas existentes | CONFORME LOCAL | `architecture:audit`: 202 tabelas, 170 recursos, 144 módulos e 461 rotas; 0 erros de coerência. `audit:menu` e `go-live:audit` sem erros. |
| A02 | PostgreSQL e migrations aditivas | CONFORME LOCAL | Gate em banco vazio, PostgreSQL `160014`: bootstrap + migrations 0001–0099; 429 testes, 0 falha/skip/TODO. |
| A03 | RBAC e isolamento multiempresa | CONFORME LOCAL | Suítes HTTP/PG `SEC-01`–`SEC-04`, `UX02.1`, testes de pagamentos/conectores e tenant A × B; spoof de perfil/empresa recusado. |
| A04 | Catálogo e vitrine pública | CONFORME LOCAL | `commerce-exposure` 12/12; smoke PG publica produto e confirma projeção pública sem mocks; produto ausente/não publicado segue regra 404/noindex. |
| A05 | Grade e estoque por tamanho | CONFORME LOCAL | Regressão M com 8 disponíveis/G zerado no backend e botão G desabilitado no cliente; testes PG de identidade Grade/PDV/faturamento/cancelamento. |
| A06 | Carrinho persistente e autoritativo | CONFORME LOCAL | Testes de carrinho e `commerce-cart` PG: quantidade, preço/desconto/frete do servidor, anti-tamper, persistência e resposta antiga. |
| A07 | Checkout sem novo motor de venda | CONFORME LOCAL | Commerce E2E PG: catálogo → fila → vitrine → checkout → webhook → conversão; total/preço do browser ignorado; frete fail-closed. |
| A08 | Idempotência e recuperação do checkout | CONFORME LOCAL | `commerce-exposure` e `LojaFluxoPages`: timeout com um único POST seguido de GET pela mesma chave; token/pagamento recuperados sem duplicar pedido. |
| A09 | Timeout/500 ambíguo e preservação de hold | CONFORME LOCAL | `PAYMENT_CREATION_UNCERTAIN`: pedido `AGUARDANDO_PAGAMENTO`, intent/sale `PENDING` e reservas preservadas; falha comprovada continua liberando hold. |
| A10 | Replay e fallback de criação | CONFORME LOCAL | `payment-engine` 19/19: Pix inválido recusado sem nova chave; MP válido reutiliza chave e permanece `PENDING`; fallback após ambiguidade não ocorre. |
| A11 | Webhook autenticado e idempotente | CONFORME LOCAL | Testes PG e memória cobrem assinatura, inbox/deduplicação, referência/tenant, consulta autoritativa, valor/moeda e reentrega concorrente. |
| A12 | Conversão e financeiro canônicos | CONFORME LOCAL | E2E PG e smoke comprovam conversão/estoque/financeiro pelo fluxo existente; replay não cria venda/saída duplicada. |
| A13 | Reserva, baixa e concorrência de estoque | CONFORME LOCAL | C1–C6 PG: pendente, pago, cancelado, recusado, expirado, webhook duplicado, concorrência e tenant cruzado; uma venda/uma saída. |
| A14 | Tela e endpoint de pagamentos reais | CONFORME LOCAL | `commerce-pagamentos-api` 3/3, regressão PG específica e `PagamentosPage` 4/4: dados reais, filtros, paginação, tenant, vínculo >1.000 e ausência de venda. |
| A15 | Mercado Pago — três visões independentes | CONFORME LOCAL | `connector-panel` 3/3 e `ConectorPage` 7/7: conta MP, Store e conciliação separadas; demais conectores não consultam/recebem conciliação MP. |
| A16 | Liquidações, disputas e repasses | CONFORME LOCAL | Consultas tenant-scoped reais e testes enterprise/PG; divergências e indisponibilidade propagam erro, nunca viram zero ou sucesso fictício. |
| A17 | Mercado Livre — OAuth e logs | CONFORME LOCAL | 75 verificações de conectores/segurança aprovadas; regressão estática impede corpo/segredo em log OAuth. Homologação externa não executada. |
| A18 | Nuvemshop — OAuth e estado da venda | CONFORME LOCAL | Regressão comprova `authorized` → `PENDING`, `paid` → `PAID`, cancelamento/estorno preservados; assinatura e estado OAuth testados. |
| A19 | Instagram Shopping | CONFORME LOCAL | Handshake, HMAC, payload multi-entrada e idempotência testados; interação nunca vira venda. Homologação Meta não executada. |
| A20 | E-mail transacional | CONFORME LOCAL | Outbox/templates/responsividade e estados auditados; smoke/testes cobrem enfileiramento e falhas. Nenhum SMTP real foi chamado nesta execução. |
| A21 | WhatsApp e outbox | CONFORME LOCAL | Cloud API/template, HMAC, máquina de estados e outbox idempotente testados; nenhuma mensagem real foi enviada. |
| A22 | UX, acessibilidade e zero modal | CONFORME LOCAL | `audit:ux` sem nova sobreposição; `commerce:enterprise-audit` 32/32; galeria/checkout/pagamentos usam fluxos inline e estados loading/erro/vazio. |
| A23 | Qualidade e build | CONFORME LOCAL | Typecheck domain/server/client aprovado; build Vite/PWA aprovado; lint 0 erros/612 avisos; servidor 2.045 testes sem falha; cliente 1.154/1.154. |
| A24 | Smoke, recovery e prontidão | PARCIAL | Smoke PG 398/398; recovery restaurou 186 tabelas com contagem exata e reaplicação idempotente. Gates estruturais passam, mas homologação externa e go-live real não foram executados. |

## 3. Comandos e resultados finais

| Comando | Resultado |
|---|---|
| `npm run typecheck` | domain, server e client aprovados |
| `npm run lint` | 0 erros; 612 avisos preexistentes de tipagem/hooks |
| `npm run build` | build de produção e PWA concluídos |
| `npm --workspace server test` | 2.045 testes: 1.963 pass, 0 fail, 82 skip de testes que exigem PG |
| `npm --workspace client test -- --run` | 133 arquivos; 1.154/1.154 testes aprovados |
| `npm run test:pg` com PostgreSQL 16.14 e banco vazio | **429 pass, 0 fail, 0 skip, 0 TODO** |
| `npm run smoke:pg` | **398/398 verificações OK** |
| `npm run recovery:check` | **186 tabelas** restauradas com contagem exata; restore idempotente |
| `npm run architecture:audit` | 0 erros de coerência |
| `npm run go-live:audit` | P0/P1/P2 = 0; 2 avisos P3 informativos de tenancy |
| `npm run commerce:go-live` | P0 41/41; P1 0; P2 4 informativos |
| `npm run payment:go-live` | estrutura aprovada; banco/homologação não certificados pelo script |
| `npm run commerce:enterprise-audit` | **32/32**, P0/P1/P2 = 0 |
| `npm run commerce:final-go-live` | P0/P1 = 0 e checks estruturais aprovados; FULL_GO_LIVE continua NÃO por homologação externa |

### Ambiente PostgreSQL reproduzível

- Servidor descartável: `@embedded-postgres/linux-x64@16.14.0-beta.17`, binário verificado como PostgreSQL 16.14.
- Cliente: `pgserver@0.1.4`, `psql` verificado como PostgreSQL 16.2.
- Bancos exclusivamente locais, vazios e separados por execução; nenhum banco de produção/usuário foi acessado.
- As duas primeiras tentativas do gate não são apresentadas como evidência verde: faltavam `ADMIN_PASSWORD` e `psql` no `PATH`, produzindo 17 falhas e 13 skips. A rodada final, com ambiente completo e banco novo, passou 429/429.

## 4. Pendências que continuam bloqueando produção

1. **Homologação externa:** Mercado Livre, Mercado Pago, Nuvemshop e Instagram não foram conectados a contas sandbox/produção nesta execução. Não há evidência de cobrança, webhook ou pedido externo real.
2. **Comunicações reais:** SMTP e WhatsApp Cloud API não receberam chamadas externas; a aprovação cobre contratos, fila, segurança e estados, não entrega ao destinatário.
3. **Escopo do Payment Engine:** o próprio `payment:go-live` mantém como lacunas cartão/débito/boleto PagBank, ingestão automática de repasses/taxas e envio provider-specific de evidências de disputa.
4. **Prisma CLI:** `npm run db:validate` não foi concluído porque o CLI tentou baixar o schema engine de `binaries.prisma.sh`, host indisponível nesta sandbox. O pacote npm correspondente contém apenas o downloader. Isso permanece **NÃO EXECUTADO**; não foi contornado. A aplicação das 99 migrations e os 429 testes PostgreSQL são evidência independente, não uma declaração de que o comando Prisma passou.
5. **Valores do incidente:** R$ 80 e 14 pedidos continuam sem confirmação direta de produção. Nenhum log ou banco real do usuário foi acessado.
6. **Operação:** não houve deploy, alteração de produção, cobrança ou comunicação real. A decisão final de go-live exige homologação externa, credenciais/configuração verificadas e evidência operacional registrada.
