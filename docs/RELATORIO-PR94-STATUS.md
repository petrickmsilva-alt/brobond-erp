# PR #94 — fechamento dos gaps P2/P3

**Data:** 2026-10-28
**Branch:** `arena/403fb478-brobond-erp`
**Estado funcional:** escopo P2/P3 implementado e validado por testes sem PostgreSQL.
**Banco PostgreSQL:** validação pendente; `DATABASE_URL` não está configurada neste ambiente. Sem afirmação de migration aplicada ou validada em banco.

## Escopo fechado

- **P2-16 — contagem cíclica ABC:** usa `inventarios`/`itens_inventario` e snapshot do saldo canônico; classificação determinística pelas saídas reais no local/período e faixas cumulativas armazenadas; estados planejada, em contagem, conferida, aprovada e cancelada; saldo de sistema imutável; divergência `contado − sistema`; aprovação server-side por gerente/admin; ajustes pelo motor de movimentação existente, auditoria e fechamento idempotente. A tela usa seções inline na página, sem modal/overlay.
- **P3-05/P3-06 — terceiros e faccionamento:** proprietário, empresa, terceiro, custodiante e tipo de material são dados distintos nos eventos; envio/retorno de insumos da empresa usa `movimentacoes_insumos` canônico e consumo líquido da OP; retorno/perda de produto é vinculado ao apontamento, e produto acabado segue o fechamento canônico da OP. Eventos têm chave idempotente, referências e auditoria; leitura/escrita revalida tenant e devolve 404 cross-tenant. Não foi criado saldo/ledger paralelo.
- **Conversão em cotações:** apenas regras declaradas são aplicadas; ausência retorna `409` com `NAO_CONVERTIDA`, sem fator estimado. Quantidade/unidade de origem, unidade de compra, fator, origem, caminho, status e timestamp ficam em snapshot; alteração de quantidade reusa o fator histórico; a decisão copia o snapshot para `itens_compra`. Comparativo e tela de cotação exibem a conversão.
- **MRP agregado:** cenário matemático integrado cobre estoque/reserva, OP restante, consumo real, compras dentro/fora do horizonte, BOM multinível, lead time, calendário e ciclo. O teste encontrou e corrigiu a inclusão da BOM de OPs fora do horizonte; o cenário fecha os valores esperados sem dupla contagem.
- **P2-12 — SPED/EFD:** tentativas idempotentes e tenant-scoped terminam em estado explícito `NAO_SUPORTADO` enquanto não houver manifesto/leiaute oficial. Não há arquivo fabricado nem estado `VALIDADO` fictício; tentativas e evidências têm histórico, hash, RBAC e trilha de auditoria. A extensão do estado foi feita por migration aditiva 0067.

## Verificações executadas

- `npm test`: **passou após a correção** — servidor: 1.393 aprovados, 68 skips condicionados a PostgreSQL, 0 falhas; cliente: 75 arquivos, 861 testes aprovados. Teste direcionado de contagem/faccionamento: 6/6 passou.
- `npm run typecheck`: **passou** (domain, server e client).
- `npm run build`: **passou**.
- `npm run lint`: exit 0, **0 erros / 575 avisos** de lint no repositório.
- `npm run smoke`: **386/386** verificações passaram em modo demonstração.
- `npm run audit:ux`: **passou**, sem novas sobreposições em fluxos de módulo; as 9 assinaturas encontradas correspondem às exceções já declaradas no baseline.
- `npm run audit:menu`: **passou sem erros**; permanece 1 aviso conhecido para o recurso legado `feriados` sem entrada navegável.
- `npm run architecture:audit`: **passou sem erros**; permanecem 10 avisos conhecidos de tabelas endpoint-only sem CRUD genérico.
- `git diff --check`: sem problemas de whitespace.
- Busca de `TODO`/`FIXME`/`GAP`/`PLACEHOLDER`, `organizationId`, escrita direta de saldo e APIs de diálogo do browser nos arquivos tocados: sem ocorrências aplicáveis.
- Testes direcionados de contagem/faccionamento, conversão, MRP e execução fiscal também passaram.

## Limitações de banco

- Localmente, `npm run test:pg` e `npm run smoke:pg` não executam sem `DATABASE_URL`.
- O primeiro CI do PR #94 identificou a divergência do formulário genérico nos JSONs ABC (`inventarios.abc_faixas`/`abc_resultado`); ambos foram marcados `form: false` e ganharam teste unitário de regressão.
- Na execução CI subsequente (`40687280886`), **os dois checks passaram**: `verificar` e `testes-postgres`. Em PostgreSQL 16.14, o gate `test:pg` (migrations, concorrência e contrato tipo×coluna), o dual-track Prisma e o smoke E2E PostgreSQL passaram. As migrations 0063–0067 foram aplicadas no banco descartável do CI; isso não afirma aplicação no banco de produção.
- `npm run db:validate` local ficou bloqueado pelo download do engine Prisma em `binaries.prisma.sh` (erro TLS). No CI, `npx prisma validate` passou.

Nenhum comportamento fiscal, fator de conversão ou outra regra ausente foi inventado. Os gates do PR e as verificações locais não-PG estão aprovados; o estado de qualquer banco de produção depende do procedimento de deploy.
