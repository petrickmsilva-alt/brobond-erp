#!/usr/bin/env bash
# ============================================================================
# PROD-DB-01.5.4 — Executor seguro do script administrativo 006 (consolidação
# das colisões de estoque de classe C).
#
# Mesmo padrão de segurança do db/admin/run-005-e42.sh (PROD-DB-01.5.3): o
# wrapper SEMPRE executa o arquivo 006 que está ao seu lado (nunca um caminho
# arbitrário) e RECUSA a execução quando:
#   1. o arquivo não contém a tríplice autorização (apply/confirmacao/autorizacao);
#   2. o arquivo não contém a revisão esperada (cópia defasada);
#   3. o arquivo difere do HEAD do repositório (cópia antiga materializada ou
#      edição local não revisada).
#
# Uso (idêntico ao psql, mas seguro):
#   DATABASE_URL=... db/admin/run-006-e42.sh                       # DRY-RUN
#   DATABASE_URL=... db/admin/run-006-e42.sh -v apply=on \
#       -v confirmacao=PROD-DB-01.5.4 -v autorizacao=PROD-DB-01.5.4
# ============================================================================
set -euo pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$SELF_DIR/006-consolidar-colisoes-estoque-classe-c.sql"
REVISAO_ESPERADA='PROD-DB-01.5.4'

if [ -z "${DATABASE_URL:-}" ]; then
  echo "erro: DATABASE_URL não definida." >&2
  exit 2
fi

if [ ! -f "$SCRIPT" ]; then
  echo "erro: arquivo não encontrado: $SCRIPT" >&2
  exit 2
fi

# (1) O arquivo precisa conter a tríplice autorização e o marcador de revisão.
#     Uma cópia anterior/alterada falha aqui — guarda direta contra execução de
#     arquivo defasado.
if ! grep -q 'autorizacao' "$SCRIPT"; then
  echo "erro: o arquivo executado NÃO contém o parâmetro de autorização (autorizacao)." >&2
  echo "      Cópia defasada. Atualize db/admin/006-*.sql." >&2
  exit 2
fi
if ! grep -q "$REVISAO_ESPERADA" "$SCRIPT"; then
  echo "erro: revisão esperada '$REVISAO_ESPERADA' ausente em $SCRIPT." >&2
  echo "      Atualize o arquivo (git pull --ff-only) antes de executar." >&2
  exit 2
fi

# (2) Se estivermos num repositório git, recusar arquivo que difere do HEAD
#     (cópia antiga materializada ou edição local não revisada).
if command -v git >/dev/null 2>&1 && git -C "$SELF_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  if ! git -C "$SELF_DIR" diff --quiet HEAD -- 006-consolidar-colisoes-estoque-classe-c.sql; then
    echo "erro: db/admin/006-consolidar-colisoes-estoque-classe-c.sql difere do HEAD do repositório." >&2
    echo "      Atualize (git pull --ff-only) ou revise as alterações locais antes de executar." >&2
    exit 2
  fi
fi

echo "E4.2/$REVISAO_ESPERADA — executando arquivo verificado: $SCRIPT" >&2
exec psql "$DATABASE_URL" -v ON_ERROR_STOP=1 "$@" -f "$SCRIPT"
