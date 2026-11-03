# Central de Notificações — diagnóstico, segurança e homologação

- Data da execução: **03/11/2026** (America/Sao_Paulo).
- Branch de trabalho: `arena/63d9951b-brobond-erp`.
- Escopo: diagnóstico administrativo somente leitura. **Sem merge, deploy ou alteração do Render.**

## 1. Causa e auditoria anterior à implementação

`GET /api/commerce/notificacoes/status` exige `Authorization: Bearer <JWT>`.
Digitar a URL da API na barra de endereço não envia esse cabeçalho e deve continuar
retornando **401 / `{"error":"Não autenticado"}`**. A correção é oferecer a consulta
a partir da sessão autenticada do ERP, não remover a proteção da API.

Padrões identificados e reutilizados:

| Responsabilidade                 | Implementação existente                                                                           |
| -------------------------------- | ------------------------------------------------------------------------------------------------- |
| Rotas                            | React Router em `client/src/App.tsx`; rotas de módulos geradas de `MODULES`                       |
| Sessão e proteção de páginas     | `AuthContext`, `Protected` e `ModuleAccess`                                                       |
| Descoberta/menu/breadcrumb/busca | `client/src/modules.ts`, `visibleModules`, TopNavigation, Sidebar e CommandPalette                |
| Cliente HTTP                     | `client/src/lib/api.ts`: `apiFetch` injeta o JWT, trata 401, timeout, retry de GET e cancelamento |
| Troca de empresa                 | `CompanySwitcher` usa o fluxo de sessão existente; `Layout` remonta a página ao trocar empresa    |
| Autorização da API               | `requireAuth` global; `checkAccess(commerce_notificacoes, actor, 'read')` exige gerente/admin     |
| Isolamento                       | `escopoDoAtor(actor)` resolve a empresa da identidade/sessão, não de parâmetros do cliente        |
| Diagnóstico local                | `statusCanaisNotificacao`, em `server/src/commerce/notificacoes.ts`                               |
| Histórico existente              | `situacaoCanaisNotificacao` lê tentativas somente da empresa ativa                                |

O endpoint existente também contém um status histórico legado (`CONECTADO`/`ERRO`).
Ele **não** é usado pela nova tela como prova de configuração, conexão atual ou entrega.
O texto bruto de `ultimo_erro` podia carregar informações de provedores/pedidos;
o diagnóstico agora retorna uma frase fixa em vez de repassar esse conteúdo.

## 2. Implementação e arquivos

- **Acesso:** Commerce → Integrações → Central de Notificações.
- **Página:** `/commerce/notificacoes`.
- **API preservada:** `GET /api/commerce/notificacoes/status`.

A rota frontend é gerada pelo loop de `MODULES` já existente em `App.tsx`, sob
`Protected`/`ModuleAccess`, e usa o dispatcher de páginas do Commerce. Não há rota
pública alternativa, modal, drawer ou segundo mecanismo de autenticação.

| Arquivo                                               | Alteração                                                                                                                                       |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `client/src/pages/commerce/NotificacoesPage.tsx`      | Página dedicada, cards, indicadores locais, variáveis ausentes, pendências, atualização, data/hora e estados de carregamento/erro/sem permissão |
| `client/src/modules.ts`                               | Entrada canônica `commerce-notificacoes`, perfil mínimo gerente, recurso existente e página própria                                             |
| `client/src/pages/CommerceModulePage.tsx`             | Registro no dispatcher existente                                                                                                                |
| `server/src/commerce/notificacoes.ts`                 | Metadados seguros de configuração, data da consulta, `Cache-Control: no-store`, erro genérico e timestamp histórico normalizado                 |
| `server/test/commerce-notificacoes-status.test.ts`    | 14 testes de contrato, JWT, RBAC, privacidade, isolamento e ausência de efeitos colaterais                                                      |
| `client/src/pages/commerce/NotificacoesPage.test.tsx` | 19 testes de UI, cliente HTTP real, rotas reais, permissões, atualização e troca de empresa                                                     |
| `client/src/modules.test.ts`                          | Inclusão da rota e atualização do inventário para 144 módulos / 41 páginas especiais                                                            |
| `client/src/components/TopNavigation.test.tsx`        | Inventário atualizado de 143 para 144 módulos, sem relaxar a validação de navegação                                                             |
| `docs/commerce/central-notificacoes.md`               | Este relatório e roteiro de homologação                                                                                                         |

`server/src/index.ts` permanece inalterado: o mesmo registro de rota continua depois
do `requireAuth`. Também permanecem inalterados os arquivos de autenticação,
autorização, escopo multiempresa, checkout, pagamento, migrations e `render.yaml`.

### Informações exibidas

- **E-mail:** configuração local, presença dos quatro parâmetros SMTP, presença de
  remetente dedicado e nomes das variáveis ausentes. `SMTP_FROM` é sinalizado
  separadamente; sua ausência não altera o comportamento do transporte existente.
- **WhatsApp:** presença de token e Phone Number ID, presença das três variáveis de
  modelos esperados, cobertura por evento, eventos sem modelo, idioma e nomes das
  variáveis ausentes. Os nomes `brobond_pedido_recebido`,
  `brobond_pagamento_confirmado` e `brobond_transacional` são **referências estáticas**,
  não valores de variáveis nem resultados de aprovação na Meta.
- **Fallback:** um modelo transacional pode cobrir eventos sem modelo específico.
  Ausência de variável específica não significa que o evento ficou descoberto.
  Ausência de `WHATSAPP_TEMPLATE_IDIOMA` é informada junto do padrão existente
  `pt_BR`. Idioma em formato inválido tem seu valor ocultado.
- **Link Público:** somente configuração e nomes `APP_URL` / `PUBLIC_BASE_URL`
  quando nenhuma alternativa estiver configurada. Nenhuma URL ou token de pedido.

Os indicadores usam `status_configuracao`, separado do status histórico legado.
Cobertura incompleta de eventos é apresentada como configuração parcial. A tela
explica que configuração **não comprova conexão, entrega ou aprovação de modelos**.
Não há alteração da resolução de templates nem da lógica dos adapters de envio.

As configurações de ambiente continuam globais ao processo, conforme a arquitetura
existente. O histórico continua restrito à empresa ativa; não foi criada uma nova
configuração por empresa nem uma leitura consolidada de notificações.

## 3. Evidências de segurança e critérios testados

| Critério                          | Evidência executável                                                                                                                                                                                                               |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Usuário autenticado/autorizado | HTTP 200 para admin e gerente com JWT assinado e sessão real no store de teste                                                                                                                                                     |
| 2. Sem autenticação               | HTTP 401 sem cabeçalho, com JWT inválido, expirado ou sem sessão                                                                                                                                                                   |
| 3. Sem permissão                  | HTTP 403 para operador; claims/headers/query de privilégio forjado não autorizam; rebaixamento e revogação continuam efetivos                                                                                                      |
| 4. Cliente autenticado            | UI percorre o `apiFetch` **real**, com `fetch` de transporte simulado; verifica URL relativa, Bearer existente, GET e ausência de corpo; não mocka a injeção do JWT                                                                |
| 5. Variáveis ausentes             | Contrato e DOM validam os nomes de SMTP, remetente, token, Phone Number ID, modelos, idioma e base pública                                                                                                                         |
| 6. Nenhum segredo visual          | Testes inserem valores privados de configuração, identificadores, tokens de pedidos e erros arbitrários; API/DOM não os reproduzem; allowlist de nomes/eventos e validação do idioma/data                                          |
| 7. Falha de rede                  | Retry canônico, mensagem segura de conexão, diagnóstico indisponível em vez de falso configurado e recuperação pela atualização                                                                                                    |
| 8. Atualizar Status               | Novo GET, botão bloqueado durante consulta, nova data/hora; erro/403 na atualização remove os indicadores anteriores                                                                                                               |
| 9. Nenhum disparo                 | Consultar duas vezes registra zero chamadas a `fetch` externo, zero abertura SMTP, zero insert/update/remove/CAS e zero logs no teste do handler                                                                                   |
| 10. Isolamento/permissões         | Empresa ativa derivada da sessão; query/header/consolidação não selecionam outra empresa; concessão/revogação verificadas; App/CompanySwitcher/Layout reais trocam o JWT e descartam dados/respostas atrasadas da empresa anterior |

Os testes HTTP usam os middleware `requireAuth`, `checkAccess` e `escopoDoAtor`
existentes, sem injetar `req.user` e sem substituir essas funções. A montagem do
endpoint no servidor de produção é verificada por teste do registro e sua ordem
em `index.ts`. A suíte local usa o store de memória; **não é uma homologação em
PostgreSQL nem uma chamada a provedores reais**.

A consulta não copia valores de SMTP, token Meta, Phone Number ID, remetente,
nomes efetivos dos modelos ou base pública para a resposta. A única informação
textual de configuração retornada é um **código de idioma de formato limitado**,
necessário para o diagnóstico. Erros brutos de provedor não são expostos.

## 4. Comandos e resultados reais

Ambiente: Node **v22.22.3**, npm **10.9.8**. Dependências instaladas com `npm ci`.

| Comando                                                                                                                                                                    | Resultado final                                                                                                                       |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `npm test`                                                                                                                                                                 | **Exit 0**. Backend: 1.738 casos, **1.662 aprovados, 0 falhas, 76 pulados**. Frontend: **1.151 aprovados, 0 falhas**, em 133 arquivos |
| `npm run typecheck`                                                                                                                                                        | **Exit 0** — domínio, servidor e cliente                                                                                              |
| `npm run lint`                                                                                                                                                             | **Exit 0**, 0 erros; **607 avisos**, os mesmos 607 medidos antes da implementação                                                     |
| `npm run build`                                                                                                                                                            | **Exit 0**, build Vite + PWA concluído                                                                                                |
| `npm run audit:menu`                                                                                                                                                       | **Exit 0**, 144 módulos, nenhuma incoerência bloqueante; 18 avisos classificados do inventário                                        |
| `npm run audit:ux`                                                                                                                                                         | **Exit 0**, nenhuma sobreposição nova em fluxo de módulo                                                                              |
| `npm run commerce:go-live`                                                                                                                                                 | **Exit 0**, verificação **estrutural**: 41 P0 aprovados, 0 falhas; não certifica provedores nem go-live                               |
| `npx prettier --check client/src/pages/commerce/NotificacoesPage.tsx client/src/pages/commerce/NotificacoesPage.test.tsx server/test/commerce-notificacoes-status.test.ts` | **Exit 0**                                                                                                                            |
| `git diff --check`                                                                                                                                                         | **Exit 0**                                                                                                                            |

Os **33 testes novos** (14 backend + 19 frontend) foram incluídos na suíte completa
e passaram sem skips. Na primeira execução completa, um teste legado de navegação
apontou a contagem fixa de 143 módulos; a expectativa foi atualizada para incluir
o novo módulo e a suíte completa foi executada novamente, com os resultados acima.

**Limitações explícitas:** todos os 76 skips do backend informam
`requer DATABASE_URL (job testes-postgres do CI)`. O sandbox não possui PostgreSQL
nem `DATABASE_URL`; `npm run test:pg` não foi certificado localmente. O gate
estrutural de Commerce também pulou sua inspeção de banco. Os checks PostgreSQL
do PR devem ser revisados antes de qualquer aprovação para merge. Há avisos
preexistentes de bibliotecas/React em outros testes; não foram convertidos em
alegação de ambiente sem avisos.

Reprodução dos testes específicos, na raiz do repositório:

```bash
node --import tsx --test server/test/commerce-notificacoes-status.test.ts
npm --workspace client test -- src/pages/commerce/NotificacoesPage.test.tsx
```

## 5. Homologação — sem disparos e sem alteração do Render

1. Disponibilizar a branch em **ambiente de homologação autorizado**, sem alterar
   configurações de produção. Não aprovar merge/deploy automaticamente.
2. Entrar no ERP pelo login existente com administrador ou gerente. Concluir MFA
   e eventual troca de senha conforme os controles atuais; não contornar esses passos.
3. Abrir **Commerce → Integrações → Central de Notificações**. Confirmar título,
   descrição, três cards, lista de pendências e última consulta bem-sucedida.
4. No Network do navegador, confirmar **GET** para a rota existente e presença do
   cabeçalho `Authorization`. Não copiar o JWT, registrar seu valor em evidências,
   colocá-lo na URL ou criar outro armazenamento.
5. Conferir as presenças/ausências com a configuração **já existente** no ambiente.
   Verificar fallback, idioma padrão e nomes das variáveis, sem revelar seus valores.
   Não alterar o Render para executar esta homologação.
6. Clicar em **Atualizar Status**. Confirmar nova requisição e nova data/hora,
   bloqueio durante carregamento e nenhum POST de envio/reprocessamento.
7. Simular offline no navegador e atualizar. Confirmar mensagem de conexão,
   ausência de indicadores antigos e possibilidade de recuperar após voltar online.
8. Com operador, confirmar que o item não é descoberto no menu e que o acesso
   direto à página respeita `ModuleAccess`. A API deve continuar retornando 403
   para operador autenticado, conforme os testes HTTP.
9. Em sessão com concessão a duas empresas, alternar pelo seletor existente.
   Confirmar que o conteúdo anterior desaparece enquanto a nova consulta carrega.
   Não alterar `empresa_id` pela URL como mecanismo de seleção.
10. Sem sessão, abrir diretamente a URL da **API**: o resultado esperado continua
    sendo **401 / Não autenticado**. A página do ERP sem sessão encaminha ao login.
11. Revisar os contadores/registros de notificações e outbox: abrir/atualizar a
    central não pode criar mensagens, tentativas de envio, cobranças ou pedidos.

Aprovação de templates e entrega real de mensagens **não são critérios comprovados
por esta tela**. Devem ter homologação própria, explicitamente autorizada.

## 6. Revisão e promoção

O commit e o Pull Request da branch são informados na entrega. O PR reúne o diff,
os testes e este relatório. **Não executar merge nem deploy de produção antes da
auditoria humana, revisão dos checks (incluindo PostgreSQL) e homologação.**
