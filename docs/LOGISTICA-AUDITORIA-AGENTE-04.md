# Logística — diagnóstico e correções parciais (Agente 04)

**Estado: NÃO pronto para produção ou aceite do Agente 04.** Este documento não é uma homologação. A mudança preserva o motor existente e reduz riscos específicos; não entrega o motor multicanal completo solicitado. Não ativar operadores externos com base neste documento.

## Arquitetura encontrada

- O frontend é Vite/React 18, não Next.js/React 19. A tela existente `LogisticaPage` integra o módulo `envios` (`ModulePage.tsx`), não a rota solicitada `/dashboard/logistics`.
- Backend Express/TypeScript; `logistica.ts` registra `ShippingProvider`, configurações cifradas por empresa e handlers de envio; `expedicao.ts` trata separação e embalagem. `envios` e `envio_eventos` existem em `db/schema.sql` e migration 0024. Recursos e permissões usam `services.ts`, `empresa.ts` e `auth.ts`.
- Checkout próprio `commerce/vitrine.ts` recalcula frete no servidor a partir de configuração `nenhum`, `retirada` ou tabela `manual`; não usa este novo cálculo Melhor Envio. WooCommerce importa vendas identificadas por `WOOCOMMERCE_RETAIL` ou `WOOCOMMERCE_WHOLESALE` em `commerce/woocommerce/pedidos.ts`. `commerce/outbox.ts` possui fila persistida em PostgreSQL, claims e retry; não foi identificada integração Redis logística.
- Migrations operacionais são `db/migrations/*.sql` aplicadas pelo boot; há também histórico Prisma. Nenhuma migration foi criada ou aplicada nesta alteração. `render.yaml` usa serviço Express único e serve o build Vite.

## Alterações incluídas

1. `/api/frete/calcular` não fabrica mais PAC/SEDEX/Jadlog; com CEP válido retorna 503 `PROVIDER_UNAVAILABLE` e lista vazia (mudança intencional de contrato). CEP inválido retorna 400. `/api/frete/cep` ganhou timeout e não segue redirecionamentos.
2. Melhor Envio: cotação usa URL de cálculo oficial `/api/v2/me/shipment/calculate`, preço e prazo personalizados; exige CEPs, peso/dimensões reais, quantidade e valor unitário. Não cria volume de medidas fictícias para essa cotação. A documentação oficial informa unidades, `custom_price`, `custom_delivery_time` e User-Agent com contato: https://docs.melhorenvio.com.br/reference/calculo-de-fretes-por-produtos . Sem credencial ou e-mail técnico válido retorna indisponibilidade. Chamadas usam timeout de 10 s e não seguem redirecionamentos. Testado com mock, **não homologado**.
3. Melhor Envio: criação de remessa/compra legada desabilitada; não possuía garantia de idempotência externa e não estava homologada. A tentativa retorna `nao_configurado`, sem chamar o operador. Isso interrompe intencionalmente esse fluxo até implementação segura e homologação.
4. Consulta de rastreio exige permissão de edição; processa eventos contra estado atualizado dentro de transação serializável com atualização condicional. Estados terminais não regridem automaticamente e `em_transito` não regride a `postado`. Os eventos recebidos continuam registrados mesmo quando não mudam o status.
5. Chamadas legadas dos Correios agora usam timeout e não seguem redirecionamentos. Isso não valida seu contrato de API nem corrige seus valores de peso/dimensões de fallback.

## Operadores: o que existe e o que falta

| Operador | Código existente | Evidência | Produção |
|---|---|---|---|
| Melhor Envio | Cotação alterada conforme documentação oficial; rastreio/cancelamento legados não auditados integralmente; geração de remessa bloqueada | Mock local, sem credenciais reais, sem teste de sandbox | Não homologado; não ativar |
| Correios | Adaptador legado de cotação/rastreio; sem geração de etiqueta | Há mocks legados; contrato/endpoints não foram homologados e dados físicos possuem fallback | Não homologado; não ativar |
| Jadlog, Total Express, Loggi, J&T | Nenhum adaptador próprio identificado | Sem testes de API ou credenciais | Não implementado |

Não há evidência de credenciais/contratos no ambiente, nem acesso ou autorização para validar a configuração real de Render ou realizar postagem, cobrança ou cancelamento. Não se deve inferir que estejam ausentes na produção.

## Limitações e riscos bloqueantes

- Cotação persistida, validade, seleção no checkout e revalidação da cotação de transportadora não estão implementadas; o checkout mantém o motor próprio existente. Não há motor de regras completo por loja, múltiplos operadores independentes ou consulta paralela.
- A estrutura legada limita o envio ativo por venda; não há pacotes com rastreio individual, separação parcial, impressão segura de etiquetas nem documentos protegidos conforme solicitado.
- A deduplicação de eventos existente usa código e mensagem e consulta até 500 registros; não é uma garantia completa de idempotência ou preservação de eventos brutos. A normalização textual legada não é contrato homologado para todos os operadores. A atualização manual de status continua possível por usuário autorizado.
- A geração genérica de envio chama o provedor durante transação SQL, antes de gravar a chave; não é garantia de idempotência para operações externas concorrentes ou após falha. A compra Melhor Envio foi bloqueada, mas adaptadores adicionais não devem ser ativados sem corrigir o desenho.
- Webhooks de transportadoras, proteção de replay, polling/worker com lock, outbox para rastreio WooCommerce e reconciliação logística ERP × lojas × transportadora não foram implementados. Não se deve sincronizar informações em massa.
- Painel existente não implementa todos os indicadores/filtros/estados solicitados e não foi desenvolvido `/dashboard/logistics`. Autorização por loja e proteção de documentos exigem implementação e testes próprios. A ausência desses recursos impede afirmar isolamento por loja.
- Nenhum teste PostgreSQL real foi executado neste ambiente: o gate `npm run test:pg` requer `DATABASE_URL` de um banco vazio PostgreSQL 16.14. `npm run db:validate` tentou baixar o Prisma schema engine de host indisponível no ambiente. Nenhuma migração foi alterada; validação completa continua pendente.

## Configuração e operação

`LOGISTICS_CONTACT_EMAIL` é opcional em `render.yaml` e `server/.env.example`; é necessário para cotar pelo Melhor Envio e deve conter e-mail técnico real. O token é configurado pelo administrador no painel existente e cifrado pelo mecanismo `segredos.ts`; `SEGREDOS_ENCRYPTION_KEY` é a chave dedicada existente. Não versionar valores e não alterar chaves sem planejar a leitura dos segredos existentes. A configuração atual de operador é por empresa, não por loja. Não foram criadas variáveis para recursos ainda inexistentes.

Antes de qualquer ativação: obter contrato e credenciais, configurar ambiente de sandbox, verificar documentação oficial atual de todos os endpoints, concluir os bloqueios acima, testar isolamento e concorrência em PostgreSQL real, testar a integração com as duas lojas em dry-run e obter aprovação explícita de homologação/produção. Não usar endpoint legado para preços. Reprocessamento de compra não é seguro até existir idempotência no operador.

## Verificação e rollback

Executar `npm test`, `npm run test:pg` em banco descartável PostgreSQL 16.14 vazio, `npm run typecheck`, `npm run lint`, `npm run build`, `npm audit` e `npm run db:validate`. Testes mock não são prova de operação externa. Revisar `docs/auditoria/matriz-configuracao-producao.md` e os logs dos comandos.

Não há migration nova. Rollback técnico é reverter o commit via Git e redeploy autorizado; entretanto, reverter também reintroduz cotações fictícias e o fluxo de compra legado inseguro. Antes, desabilitar integrações, avaliar dados/pendências e comunicar operadores; não apagar histórico ou credenciais para efetuar rollback.
