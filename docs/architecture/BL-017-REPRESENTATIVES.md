# BL-017 — REPRESENTATIVES / Portal Comercial

**Estado:** em implementação interna · **Data:** 2026-11-16  
**Branch inicial:** `feat/bl-017-representative-portal-identity`

## 1. Objetivo

Entregar um portal autenticado para representantes comerciais da Brobond, integrado aos domínios oficiais do ERP. O portal não é um segundo ERP e não mantém cadastros paralelos.

## 2. Fontes de verdade existentes

- Identidade mestre: `representantes`; vínculo com login: `representantes.usuario_id`.
- Usuários, convite, senha Argon2id, sessões, MFA e revogação: módulo `auth.ts` / `usuariosAdmin.ts`.
- Tenant: `usuarios.empresa_id`, concessões `usuario_empresas` e sessão.
- Carteira temporal: `representante_cliente`.
- Catálogo e preços: domínios `catalogos`, `listas_preco`, `politicas_comerciais` e produtos.
- Pedidos: fluxo canônico `vendas` / propostas, sem criar uma tabela paralela de pedidos.
- Comissão: `planos_comissao`, `regras_comissao`, `comissoes_apuradas` e livro `comissoes_eventos`.

## 3. Identidade e autorização

A primeira entrega acrescenta `usuarios.portal_representante`, falso por padrão. A conta continua usando o fluxo normal de convite e login do ERP; não haverá senha paralela nem token próprio.

Para habilitar o portal, são necessários:
1. usuário ativo com perfil `operador`;
2. `portal_representante = true`;
3. vínculo `representantes.usuario_id = usuarios.id`;
4. representante ativo na mesma empresa ativa da sessão.

A validação é fail-closed em toda requisição autenticada. Sem vínculo, com representante inativo, perfil incompatível ou tenant divergente, o login/uso do portal é recusado.

Contas habilitadas ficam restritas no servidor a:
- metadados mínimos da aplicação;
- identidade e gestão da própria sessão/senha/MFA;
- rotas autenticadas sob `/api/representante/portal/*`.

Qualquer endpoint geral do ERP retorna 403, mesmo que seja chamado manualmente fora da interface. O Control Plane operacional e a autorização OAuth também recusam contas portal, inclusive tokens OAuth antigos já emitidos antes da ativação da flag. O vínculo de carteira é resolvido pelo servidor na empresa ativa, nunca por ID informado no cliente.

## 4. Sequência funcional

| Fase | Entrega | Critério de aceite |
|---|---|---|
| 1 | Identidade e autenticação | convite/login existente, vínculo único por empresa, portal exclusivo e fail-closed |
| 2 | Carteira e isolamento multiempresa | clientes atuais e históricos da própria carteira, testes A/B e IDs forjados |
| 3 | Catálogo e preços autorizados | catálogo ativo, preço por canal/cliente, sem expor custo/margem nem alterar tabela |
| 4 | Pedidos e cotações | fluxo canônico, autorização, idempotência e sem duplicar pedido |
| 5 | Comissões | somente apuração/efetivação própria, com período e trilha do livro |
| 6 | Auditoria e segurança | eventos, rate limits, testes negativos e tenant/representante cruzados |
| 7 | Portal comercial | navegação responsiva, visão inicial, carteira, catálogo, pedidos, cotações e comissões |

### Regras de autorização da Fase 2

- Leitura, Customer 360 e exportação LGPD preservam clientes de vínculos não cancelados que já começaram, vigentes ou encerrados; vínculos cancelados e com início futuro não autorizam acesso.
- Escrita em cadastro e operações comerciais exige vínculo ativo e vigente. Um vínculo histórico não concede permissão para editar o cadastro nem iniciar nova operação.
- Compartilhamento só admite vínculos ativos sem data final, com participação individual inferior a 100% e soma agregada de no máximo 100%.
- Sobreposições temporais incompatíveis são recusadas pela aplicação e pelo trigger transacional, que serializa por empresa/cliente e também protege gravações SQL diretas.

## 5. Restrições

- Não criar cadastro paralelo de representante, cliente, produto, estoque, venda, preço ou comissão.
- Não aceitar `empresa_id`, `representante_id` ou `cliente_id` como autoridade de escopo do browser.
- Não permitir escrita direta em comissões ou atribuições já congeladas.
- Não expor CPF/CNPJ, dados bancários, custo, margem ou dados de outros representantes no portal.
- Não alterar produção/DNS fora do fluxo normal de PR, CI e deploy.

## 6. Primeira entrega

- Migration aditiva `0123_representative_portal_identity.sql`.
- Flag de acesso exclusivo no cadastro de usuários.
- Verificação de vínculo ativo e tenant na fronteira de autenticação.
- Allowlist server-side para impedir acesso direto às APIs gerais.
- Página inicial autenticada com identidade comercial mínima.
