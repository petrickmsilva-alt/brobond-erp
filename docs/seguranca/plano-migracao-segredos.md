# Plano de migração de segredos e chaves de cifra

Status: **planejado, não executado**. Nenhuma linha de banco foi reescrita. A execução em produção depende de autorização específica do Diretor e de confirmação de presença (nunca do valor) das variáveis no Render.

## 1. Inventário de cifra

| Domínio | Onde é usado | Chave primária | Chave legada (só leitura) | Formato |
|---|---|---|---|---|
| `segredos` | tokens fiscais, certificado A1, CSC, credenciais de gateway (`gateway_configs`), segredo de webhook | `SEGREDOS_ENCRYPTION_KEY` → `APP_ENCRYPTION_KEY` | derivada de `JWT_SECRET` | `v1.iv.tag.ct` (AES-256-GCM, scrypt salt `brobond-segredos-v1`) |
| `mfa` | segredo TOTP de administradores | `MFA_ENCRYPTION_KEY` | derivada de `JWT_SECRET` | `v1.iv.tag.ct` (salt `brobond-mfa-v1`) |
| `conector` | tokens OAuth e chaves de API (`connectors`) | `CONNECTOR_ENCRYPTION_KEY` (32 bytes exatos) | nenhuma | `v1.iv.tag.ct` (chave direta, sem derivação) |

Os três usam o mesmo prefixo `v1.`, mas com chaves e derivações diferentes. Um valor de um domínio **não** é decifrado pelo outro, e o diagnóstico nunca deve tentar isso.

## 2. Estado já implementado (Fase 2)

- `server/src/chavesCifra.ts` é a fonte única de material de chave para `segredos` e `mfa`.
- Chave primária cifra todo valor novo. Chaves legadas são aceitas **somente para leitura**. Definir uma chave dedicada não torna ilegíveis os valores antigos (coberto por `server/test/fase2-seguranca-credenciais.test.ts`).
- Em produção sem nenhuma chave, cifrar lança `ErroChaveCifra` e decifrar devolve `null` (sem usar o literal `brobond-dev-secret`).
- `diagnosticoChaves()` informa a fonte ativa por domínio, sem valores.
- JWT verificado com `algorithms: ['HS256']` (auth e websocket).

## 3. Pré-requisitos antes de qualquer migração

1. Confirmar **presença** (não valor) de `SEGREDOS_ENCRYPTION_KEY`, `MFA_ENCRYPTION_KEY` e `CONNECTOR_ENCRYPTION_KEY` no Render. Sem a confirmação do Diretor, assumir ausência.
2. Gerar a nova chave fora do repositório (32 bytes aleatórios) e registrá-la somente no gerenciador de segredos do Render.
3. Backup lógico das tabelas `gateway_configs`, `connectors`, e as tabelas fiscais com colunas cifradas, antes de qualquer escrita.

## 4. Procedimento proposto (não executado)

1. **Definir a chave dedicada** (`SEGREDOS_ENCRYPTION_KEY`, `MFA_ENCRYPTION_KEY`) no Render, com autorização específica. Pela regra de leitura dupla, nenhum valor antigo deixa de abrir. Mudar `JWT_SECRET` depois disso passa a não afetar os valores gravados com a chave dedicada.
2. **Contagem por fonte (somente leitura):** para cada coluna cifrada, contar quantos valores abrem com a chave primária e quantos só abrem com a legada. Esse diagnóstico ainda não existe como script; deve ser criado antes da reescrita.
3. **Reescrita em lote**, por tabela e em transação: decifrar com a legada, cifrar com a primária, verificar a leitura de volta e só então gravar. Registrar contagens antes e depois. Ferramenta a implementar; sem execução nesta fase.
4. **Validação:** após a reescrita, o diagnóstico deve mostrar zero valores que dependem da chave legada.
5. **Remoção do caminho legado:** somente após dois ciclos de operação sem leituras pela chave legada. Remover a derivação do JWT do código de leitura é uma mudança separada, com teste de regressão.

**Rollback:** manter a chave anterior (legada) disponível até a validação do passo 4. Os valores reescritos continuam abrindo com a chave primária; a reversão exige restaurar o backup do passo 3.

## 5. Domínio `conector`

`CONNECTOR_ENCRYPTION_KEY` não tem legado. Rotacionar essa chave exige reescrever cada linha de `connectors`, com a mesma verificação de leitura de volta. Não há ferramenta de rotação nesta entrega. Até existir, tratar a chave como permanente e armazená-la com o mesmo cuidado do banco.

## 6. Riscos e limites

- O `render.yaml` **não foi alterado**. Declarar as chaves com `sync: false` mudaria o blueprint do Render e exige autorização específica. Hoje o aviso de chave ausente aparece em log e nas telas fiscal e logística.
- `chaveFraca()` continua bloqueando a gravação de credenciais no engine de pagamentos quando não há chave dedicada. Essa regra não mudou.
- Nada disto foi testado contra o banco de produção. Os testes cobrem a lógica de cifra em memória.
