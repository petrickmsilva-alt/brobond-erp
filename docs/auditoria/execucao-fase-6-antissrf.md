# Execução — Fase 6 (parcial): anti-SSRF em webhooks de saída (P2-01)

Status: **parcial**. Cobre a checagem de destino e o bloqueio de redirecionamento. Não cobre o rebinding de DNS na conexão (ver limite).

## O que mudou (`server/src/webhooks.ts`)

- `enderecoInterno`: classifica loopback, rede privada, CGNAT (100.64/10), link-local (inclui 169.254.169.254), reservados, multicast, IPv6 de rede local (fc00::/7, fe80::/10, ff00::/8) e IPv4 mapeado em IPv6 (forma decimal e a forma hexadecimal que o WHATWG `URL` produz).
- `hostnameInterno`: literais internos e nomes `localhost`, `*.local`, `*.internal`, `metadata.google.internal`.
- `destinoInterno`: resolve o host e recusa se **qualquer** endereço for interno; falha de resolução também recusa (falha fechada). A mensagem não revela o endereço.
- `postar`: em produção, checa o destino antes de enviar; envia com `redirect: 'manual'` e trata 3xx como erro registrado, sem seguir. Fora de produção o comportamento não muda (ambientes de desenvolvimento).

## Evidência

- LOCAL — `server/test/webhooks-saida-antissrf.test.ts` (8/8) e `webhooks.test.ts` existente (sem regressão).
- Um defeito foi encontrado durante os testes e corrigido: `[::ffff:10.0.0.5]` passava, porque o `URL` normaliza para `::ffff:a00:5`. Coberto por teste.
- RED: os testes importam símbolos novos (`enderecoInterno`, `destinoInterno`, `postar` exportado). Antes da mudança, a importação não existia; não foi feito um RED de comportamento isolado.
- Suíte do servidor: 1706 aprovados / 0 falhas / 76 ignorados.

## Limite conhecido (não resolvido)

Um nome cujo DNS muda entre a checagem e a conexão (rebinding) **não é coberto** por esta checagem. A mitigação completa exige fixar o IP resolvido na conexão (lookup customizado no cliente HTTP), o que não foi implementado. Registrado como risco residual.

## Não verificado

- Comportamento em produção real (sem egress a hosts externos nesta sandbox).
- Nenhum destino de produção foi alterado ou testado.
