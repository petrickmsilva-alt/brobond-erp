# Execução — Fase 0 (reprodução) e correções P0-01 / suspensão controlada

Branch: `arena/c0104925-brobond-erp` (único branch usado). Base: `ad81237`.
Nada foi mergeado, publicado na `main`, implantado, nem aplicado em produção. Nenhuma migration; nenhuma variável do Render alterada; nenhum token revogado ou gerado; nenhum anúncio real alterado.

## 1. Reprodução (testes escritos antes da correção)

Arquivo: `server/test/publicacao-canais-p0.test.ts` (5 testes, sem rede e sem credencial: `fetch` e token são dublês em memória).

Antes da correção, os 5 testes falharam pelos motivos esperados:

| Teste | Falha observada | Defeito confirmado |
|---|---|---|
| Editar produto publicado | `external_id` da nova versão = `null` (esperado `MLB1`) | P0-01: vínculo não é herdado |
| Retry após timeout | 2 anúncios no dublê (esperado 1) | P0-01: duplicata em retry |
| Publicar sem SKU | `processada` (esperado `rejeitada`) | Publicação sem chave de identidade |
| Suspensão padrão | `processada` (esperado `ignorada`) | Canal não suspenso |
| Nuvemshop | `falhou` após chamada HTTP ao contrato v1 | Contrato legado sem lookup/atualização |

## 2. Correções implementadas

- `server/src/commerce/publicacaoCanais.ts` (novo): `PublicacaoFalha` (movida; re-exportada por `catalogo.ts`) e adapter do Mercado Livre com `fetch` e token injetáveis.
  - Com vínculo: `PUT /items/{id}` (preço e `available_quantity`). Título não é enviado: o ML bloqueia alteração de título após venda.
  - Sem vínculo: `GET /users/me` e `GET /users/{id}/items/search?seller_sku=`. Um resultado é adotado (PUT); mais de um é recusado; nenhum leva a `POST /items`.
  - 404 em PUT é recusado sem criar anúncio novo.
  - Sem SKU é recusado antes de qualquer chamada externa.
- `server/src/commerce/catalogo.ts`:
  - nova versão herda `external_id` da versão mais recente que o tiver;
  - linhas de canal suspenso são ignoradas antes de qualquer mudança de estado;
  - a varredura filtra canais suspensos antes do limite, para não bloquear os canais liberados;
  - Nuvemshop: publicação automática desligada (o contrato v1 não tem lookup nem atualização). Não é reversível por variável; religar exige migração para 2025-03;
  - `dependenciasPublicacao.obterTokenCanal` é o único ponto de injeção de token (testes).
- `server/src/commerce/publicacaoSuspensao.ts` (novo): ML e Nuvemshop começam **suspensos**. `PUBLICACAO_CANAIS_LIBERADOS=MERCADOLIVRE` libera o ML; remover a variável suspende de novo.
- `server/.env.example`: documenta a nova variável (nenhuma alteração no Render).

Suspensão não afeta pedidos, webhooks, estoque local, histórico nem identificadores; ela só bloqueia o envio de publicações.

## 3. Verificação local

- `tsc --noEmit` (server): EXIT 0.
- `npm --workspace server test`: 1667 pass, 0 fail, 76 skipped (antes: 1662 pass; +5 novos).
  - Uma execução teve falha de IPC do runner (`commerce-pix-real-flow`, "Unable to deserialize cloned data"). O arquivo passou isoladamente (18/18, 2 vezes) e a suíte completa passou na repetição. Tratada como instabilidade do runner, não regressão.
- ESLint nos arquivos alterados: 0 erros.
- `architecture:audit` e `commerce:go-live`: EXIT 0 (P0 41 OK).
- Nota: `architecture:audit` regenera `docs/ERP-3.0-ARCHITECTURE-INVENTORY.json`; o arquivo foi restaurado para não entrar no commit.

Classificação: **teste local/automatizado**. Não é homologação nem evidência de produção.

## 4. Não verificado (exige acesso externo)

- Resposta real do Mercado Livre para `PUT /items`, busca por `seller_sku` e 404 de item encerrado. O contrato foi confirmado na documentação pública, não em conta real.
- Consistência da busca por SKU: o índice do ML pode demorar a refletir um anúncio recém-criado. Um retry imediato após timeout pode não encontrá-lo e criar outro. Mitigação parcial: o vínculo `external_id` é salvo logo após a criação; a janela residual não foi eliminada.
- Anúncios **já duplicados em produção** por P0-01 não são corrigidos por este código. Exigem reconciliação manual no ML (encerrar duplicata) e um vínculo correto. Não foi feito nada em produção.
- Nenhuma credencial, sem egress aos hosts externos; sem acesso ao Render.

## 5. Limitações conhecidas (não tratadas nesta entrega)

- Estoque local não reenfileira publicação no ML: a quantidade só é enviada quando há nova versão. (P1, já registrado na auditoria.)
- Edições de título e descrição não atualizam anúncios já existentes no ML (somente preço e estoque). Título é bloqueado após venda.
- A UI da Central/publicações não explica que a linha está suspensa: ela permanece como `QUEUED`.
- Produto inativo ainda pode ser publicado no ML (regra preexistente, não alterada).

## 6. Decisões pendentes do Diretor

1. Branch/PR: as fases foram commitadas no branch da sessão; não há PR por fase. Confirmar.
2. Migração Nuvemshop para 2025-03 (contrato, base, cabeçalho de autenticação, `variants`, `name` por idioma). Exige homologação com loja real.
3. Liberação do ML em produção: definir `PUBLICACAO_CANAIS_LIBERADOS=MERCADOLIVRE` somente após homologação e após reconciliação dos duplicados.
4. Fail-closed de webhooks ML/MP: exige `MERCADOLIVRE_WEBHOOK_SECRET` e `MERCADOPAGO_WEBHOOK_SECRET` configurados em produção antes do deploy, senão pedidos deixam de entrar.
5. Cifra consolidada de segredos e motor de pagamento canônico (Fases posteriores).

## 7. Reversão

- Suspender ML: remover `PUBLICACAO_CANAIS_LIBERADOS` (ou deixá-la vazia).
- Reverter o código: `git revert` do(s) commit(s) desta entrega. Não há migration a desfazer.
