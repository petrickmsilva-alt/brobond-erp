# GitHub App e MCP — operação de leitura

## Fontes e segurança

A App e a instalação existentes não devem ser recriadas. A configuração completa
`GITHUB_APP_ID`, `GITHUB_APP_INSTALLATION_ID`, `GITHUB_APP_PRIVATE_KEY` do processo
precede o registro legado `operational_github_app` na tabela `configuracoes`. Não
se combinam campos de fontes diferentes. A chave deve ser RSA privada, de pelo menos
2048 bits; PEM com quebras reais ou `\n` escapado é aceito. O blueprint declara os
nomes com `sync: false`; isso não demonstra presença nem atualiza valores no processo.
Confira o comportamento da sincronização do blueprint no serviço antes de aplicá-lo.

A via operacional recomendada é o ambiente. A leitura do registro cifrado existente
foi preservada para não invalidar dados. Não existe rota de gravação do registro;
a função legada de escrita não é um procedimento operacional autorizado. Não
manipule manualmente registros ou segredos para contornar erros.

As chaves existentes não foram alteradas. O domínio `segredos` tenta a chave dedicada
primeiro e depois a derivada do `JWT_SECRET`; MFA tem domínio e salt próprios. Não
é possível inferir qual chave cifrou um valor só pelo prefixo `v1`. Não defina,
remova ou rotacione chaves para resolver esta App: siga o inventário, backup e plano
reversível em `docs/seguranca/plano-migracao-segredos.md`. A leitura legada depende
do `JWT_SECRET` anterior continuar disponível. Nenhuma migração foi executada.

## Diagnóstico sem revelar valores

No ERP autenticado como administrador, consultar `GET /api/operational-control/capabilities`.
`github_app_configured` só comprova resolução local, não autorização no GitHub.
`github_app_diagnostico` contém apenas códigos de fonte, ambiente e banco. Os mesmos
códigos aparecem no log estruturado `github_app_config_boot` e, em falha, em
`github_app_config_indisponivel`. Após alteração de ambiente no Render, aplicar o
mecanismo normal do serviço para disponibilizá-la a novos processos e confirmar o
commit implantado. Nunca compartilhar valores, PEM, tokens ou connection strings.

- `ausente`, `vazio`, `incompleto`, `id_invalido`, `pem_invalido`: verificar no
  processo que atende requisições, e não somente no blueprint. Uma fonte alternativa
  íntegra continua funcionando.
- `registro_inexistente`, `leitura_falhou`, `json_invalido`, `descriptografia_falhou`:
  distinguir falta de registro de erro do banco ou cifra. Não reescrever dados;
  recuperar as chaves antigas pelo cofre e investigar compatibilidade de forma segura.
- `github_app_token_falhou`: 401 sugere autenticação recusada; 403 pode indicar
  permissão ou política; 404 instalação não encontrada **ou inacessível**; 422
  solicitação inválida. `github_api_indisponivel` distingue timeout de rede.
  Os códigos não substituem a verificação de permissões na instalação existente.

## Validação de ponta a ponta

Após CI verde, revisão, e confirmação do deploy e ausência de migrações pendentes não
autorizadas, verificar health e descoberta OAuth; usar sessão/OAuth existente com
os escopos de leitura aprovados. Executar MCP `brobond_github_branches`,
`brobond_github_commits`, `brobond_pull_requests` e `brobond_github_workflows` /
`brobond_github_actions_runs`. Resultados reais de cada chamada são necessários;
resposta vazia de PRs pode ser legítima, experimente state `all`. Consultas GitHub
são auditadas por empresa/ator e nome da ferramenta sem argumentos ou segredos.
`brobond_workflow_runs` é uma lista do banco local e **não** prova acesso ao Actions.
GitHub App precisa das permissões necessárias em Contents, Pull Requests, Actions e
Metadata, somente leitura para esta missão. Nenhum PAT ou escopo OAuth extra deve
ser usado. `github_app_configured: true`, health e testes simulados não demonstram
que o JWT foi aceito ou que a instalação tem acesso.

A ref `ops/workflow-migracao-producao-diagnostico` do registro de dispatch retornou
404; o workflow existe em `main` e o PR #138 foi mergeado. O registro permanece
**desabilitado**. Não trocar a allowlist para `main`, criar branch nem habilitar
write/dispatch durante homologação de leitura; escolher ref somente com o fluxo
futuro de dispatch devidamente avaliado. Nenhum workflow deve ser disparado aqui.
