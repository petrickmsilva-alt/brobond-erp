# Payment Engine — evidências deste round

Data: 2026-10-29. Branch de trabalho: `arena/e5252aca-brobond-erp`.
Não houve merge em main. Nenhuma credencial externa foi criada ou homologada.

## Comandos efetivamente executados

| Gate | Resultado observado |
|---|---|
| `npm test` | PASS. Servidor: 1.483 aprovados, 0 falhas, 68 testes PG pulados **neste runner sem DATABASE_URL**. Client: 1.016 aprovados, 112 arquivos. |
| `npm run test:pg` | PASS em banco novo PostgreSQL **16.14**. **316 aprovados, 0 falhas, 0 skips, 0 TODOs.** Inclui os testes PostgreSQL pulados pelo runner sem banco. CLI psql real foi disponibilizada para as provas SQL existentes. |
| `npm run test:payments` | PASS: 20 verificações do Engine e regressão de exposure/checkout. |
| `npm run typecheck` | PASS: domínio, servidor e client. |
| `npm run lint` | PASS: 0 erros; 600 warnings no conjunto do repositório (não são tratados como aprovação sem avisos). |
| `npm run build` | PASS: bundle de produção e PWA gerados. |
| `DATABASE_URL=... npm run smoke:pg` | PASS: **396/396** verificações HTTP reais, incluindo Commerce, contra banco novo. |
| `npm run audit:menu` | PASS. |
| `npm run audit:ux` | PASS: sem novas sobreposições em fluxo de módulo. |
| `npm run architecture:audit` | PASS: sem erros de coerência; avisos de inventário/tenancy existentes são mantidos. |
| `DATABASE_URL=... npm run commerce:go-live` | PASS: 42 verificações P0, 0 falhas, 9/9 tabelas Commerce encontradas. |
| `DATABASE_URL=... npm run payment:go-live` | PASS estrutural + 8 tabelas empresariais do Engine verificadas. Não certifica cobertura funcional não implementada. |

O PostgreSQL de testes foi provisionado fora do código versionado. Binários,
dados do banco, dependências, builds e logs brutos não entram no commit.
As fixtures de APIs oficiais são explicitamente de teste: não constituem
pagamento externo, health financeiro, saldo ou homologação real.

## Provas novas

- Máquina de estados formal; eventos atrasados não regridem pago para pendente.
- Roteamento por tenant/canal/loja/limites/moeda/horário/capabilities/health.
- Regras explicitamente desativadas não reativam o fallback de compatibilidade.
- Fallback **executado** com HTTP 429: duas tentativas preservadas; recusa de
  negócio e write ambíguo não passam ao segundo provider.
- Recuperação de criação ambígua usando o mesmo provider e a mesma chave externa.
- Dez criações concorrentes em PostgreSQL: uma intenção, uma tentativa externa.
- FK PostgreSQL rejeita attempt de outra empresa associado à intenção.
- Assinatura falsa rejeitada; inbox assinado, hash de payload e deduplicação reais.
- Corpo de webhook com campos sensíveis de fixture não é retido no inbox.
- Refund duplicado retorna o resultado anterior; alteração dos parâmetros com a
  mesma chave é recusada. Refunds concorrentes não excedem o saldo disponível.
- Isolamento A/B, RBAC operacional e respostas administrativas sem credenciais.
- Provider exige admin + reautenticação; PAN não é um campo de configuração.
- Credencial de ambiente é preservada na configuração administrativa explícita.
- Pagamento manual permanece pendente até confirmação autorizada e idempotente.
- UI com rotas próprias, estados vazios verdadeiros e campos de segredo mascarados.
- Regressão Commerce → pagamento → pedido → `vendas`/Finance executada em PG real.

## Limites do aceite

O núcleo e sua integração estão implementados e testados. Entretanto, **este
round não satisfaz integralmente todo o escopo enterprise solicitado**:

1. PagBank implementa PIX Orders e refund/consulta da charge, não os fluxos de
   cartão, débito e boleto. Esses métodos não são anunciados nesse adapter.
2. Mercado Pago mantém o fluxo PIX Payments no checkout; os demais fluxos
   legados são preservados no gateway financeiro, não promovidos a capabilities
   de checkout sem fluxo seguro completo.
3. Settlement/reconciliation têm domínio, persistência e resolução auditada,
   mas não há ingestão automática de extratos/payout/MDR dos providers.
4. Disputas possuem domínio e persistência; não há envio externo completo de
   evidências por provider nem cobertura de todos os tópicos de disputa.
5. Não houve teste financeiro real de produção/sandbox autorizado. Credenciais
   e homologação externas continuam pendentes; não há certificação de WCAG por
   ensaio visual/manual, apenas implementação e auditorias automatizadas.

Logo, `CODE_STRUCTURE_READY=YES` da auditoria **não** deve ser confundido com
`CODE_READY=YES` para o aceite integral deste pedido. Para esse aceite integral,
`CODE_READY=NO`, `EXTERNAL_HOMOLOGATION=NO`, `FULL_GO_LIVE=NO`.
Ausência de credencial é **EXTERNAL CONFIGURATION PENDING**; as lacunas de código
listadas acima são lacunas de implementação, não são escondidas como pendências
externas.

## Atualização posterior

Para os resultados e limites das ondas 1–3 em 2026-10-29, consulte `../BROBOND-ENTERPRISE-WAVES-1-2-3-AUDIT.md`. Os números acima são históricos da rodada indicada, não os resultados desta branch.
