# Gate de leitura — Nuvemshop 2025-03 (R-15, Fase 4.2)

**Status: BLOQUEADO — sem credencial de loja de teste no ambiente.** Nenhuma leitura real foi feita. Nenhuma escrita foi feita. A migração de publicação **não está homologada** e não pode ser considerada homologada sem a leitura real descrita abaixo.

## 1. Objetivo

Decidir, com leitura real em loja de teste, qual cabeçalho de autenticação a API 2025-03 aceita. Só então se decide uma eventual correção de código, com aprovação do Diretor.

## 2. Divergência documentada

| Fonte | Versão | Cabeçalho indicado |
|---|---|---|
| Código de produção (`server/src/commerce/publicacaoNuvemshop.ts`, linhas 53–55) | 2025-03 | `Authorization: Bearer <token>` |
| Conector v1 (`modules/connectors/nuvemshop/nuvemshop.service.ts`, cabeçalho do módulo) | v1 | `Authentication: bearer <token>` (não `Authorization`) |
| Documentação de terceiros (espelho devhub, consulta web de 2026-11-04) | v1 | `Authentication: bearer`; `Authorization` retorna 401 |
| Perfil de terceiro (api-evangelist, consulta web) | 2025-03 | `Authentication`; `Authorization` retorna 401 |
| PR de terceiros (jlima004/indicio-cult #26) | 2025-03 | `Authorization: Bearer` (fonte não oficial) |

**Divergência não resolvida.** Não há confirmação oficial, por leitura direta da documentação do provedor ou por chamada real, sobre o cabeçalho aceito pela 2025-03. A premissa de que v1 e 2025-03 usam o mesmo cabeçalho foi descartada. A premissa de que `Authorization: Bearer` funciona na 2025-03 não está confirmada.

Base de URL do código: `https://api.tiendanube.com/2025-03` (fixa, sem `NUVEMSHOP_API_BASE_URL`). Espelho citado por terceiros: `https://api.nuvemshop.com.br/2025-03/{store_id}`. Não verificado.

## 3. Regras do gate

1. **Somente GET.** Nenhum POST, PUT, PATCH ou DELETE. Nada é criado, editado ou excluído.
2. Loja **de teste** do próprio Diretor, com token obtido por OAuth para essa loja. Nunca loja de produção.
3. Sem escrever o token em arquivo do repositório, em log, em chat ou em commit. Usar variável de sessão local, sem impressão.
4. Cabeçalho de produção **intocado** até a decisão do Diretor.
5. Resultado registrado nesta página, com data, status HTTP e corpo truncado sem dados da loja.

## 4. Procedimento (leitura)

Para cada variante, uma única requisição GET, com `User-Agent` identificando a aplicação:

- Variante A: `GET https://api.tiendanube.com/2025-03/{store_id}/products?per_page=1` com `Authorization: Bearer <token>`.
- Variante B: mesma URL com `Authentication: bearer <token>`.
- Variante C (controle, mesma loja): `GET https://api.tiendanube.com/v1/{store_id}/products?per_page=1` com `Authentication: bearer <token>` (confirma o token e a loja).

Matriz de decisão:

| Controle (C) | A (Authorization) | B (Authentication) | Conclusão |
|---|---|---|---|
| 200 | 200 | 401 | Código atual correto para 2025-03. Gate fechado. |
| 200 | 401 | 200 | Código de publicação precisa de correção. **Não corrigir sem aprovação do Diretor.** |
| 200 | 200 | 200 | Ambos aceitos. Registrar e decidir o padrão. |
| 200 | 401 | 401 | Problema de versão ou URL. Investigar antes de qualquer escrita. |
| 401 ou 403 | — | — | Token ou loja inválidos. Refazer a autorização da loja de teste. |

## 5. Teste automatizado associado

`server/test/nuvemshop-gate-leitura.test.ts` é **local**. Ele não chama a Nuvemshop. Ele apenas garante:
- que este gate existe e declara "somente GET" e o bloqueio atual;
- que o cabeçalho e a base de produção continuam como estão (`Authorization: Bearer` e `2025-03`), até a decisão do Diretor;
- que o conector v1 mantém o cabeçalho documentado.

Ele **não** é homologação. Não comprova que a integração funciona com a Nuvemshop.

## 6. Registro da execução

| Item | Resultado |
|---|---|
| Credencial de loja de teste disponível no ambiente | **Não** (bloqueio) |
| Leitura GET variante A | não executada |
| Leitura GET variante B | não executada |
| Controle C | não executado |
| Escrita de qualquer tipo | **nenhuma** (proibida nesta fase) |
| Decisão sobre cabeçalho | **pendente** (Diretor) |

Evidência necessária para destravar: loja de teste, token obtido por OAuth para ela, e autorização expressa do Diretor para executar apenas as três leituras acima.

## 7. Status na Fase 4.3 (R-15)

- **BLOQUEADO.** Verificação de nomes de variáveis (sem valores): nenhuma variável de credencial Nuvemshop presente
  (`NUVEMSHOP_CLIENT_ID`, `NUVEMSHOP_CLIENT_SECRET`, `NUVEMSHOP_*`). **Nenhuma leitura GET foi realizada.**
- Nenhum POST, PATCH, PUT ou DELETE. Nenhum cabeçalho alterado. Nenhuma publicação reativada.
- A divergência `Authorization` (código atual) vs. `Authentication` (documentação v1) **continua não resolvida**.
- Próximo passo quando houver credencial de loja de teste em ambiente seguro: executar apenas os GET do procedimento da seção 4,
  registrar a resposta (sem tokens) e decidir o cabeçalho com base nessa evidência. Matriz de decisão: seção 4 (procedimento).
