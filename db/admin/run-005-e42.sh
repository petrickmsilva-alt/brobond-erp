#!/usr/bin/env bash
# ============================================================================
# PROD-DB-01.5.2.1 — Executor seguro do script administrativo E4.2 (005).
#
# Motivo: o incidente PROD-DB-01.5.2.1 ocorreu porque o operador executou uma
# CÓPIA DEFASADA do arquivo 005 (a revisão 01.5.1, que nem possui o parâmetro
# `normalizar_classe_c`). O `psql` aceitou `-v normalizar_classe_c=on` sem erro,
# mas a cópia antiga nunca leu o parâmetro — e a classe C foi abortada.
#
# Este wrapper elimina essa classe de erro: ele SEMPRE executa o arquivo 005 que
# está ao seu lado (nunca um caminho arbitrário) e RECUSA a execução quando:
#   1. o arquivo não contém o gate de classe C (cópia anterior ao 01.5.2);
#   2. o arquivo difere do HEAD do repositório (cópia defasada/alterada).
#
# Uso (idêntico ao psql, mas seguro):
#   DATABASE_URL=... db/admin/run-005-e42.sh                 # DRY-RUN
#   DATABASE_URL=... db/admin/run-005-e42.sh -v apply=on -v confirmacao=PROD-DB-01.5
#   DATABASE_URL=... db/admin/run-005-e42.sh -v apply=on \
#       -v confirmacao=PROD-DB-01.5.2 -v normalizar_classe_c=on
# ============================================================================
set -euo pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$SELF_DIR/005-propagar-nomes-locais-e42.sql"
REVISAO_ESPERADA='PROD-DB-01.5.3'

if [ -z "${DATABASE_URL:-}" ]; then
  echo "erro: DATABASE_URL não definida." >&2
  exit 2
fi

if [ ! -f "$SCRIPT" ]; then
  echo "erro: arquivo não encontrado: $SCRIPT" >&2
  exit 2
fi

# (1) O arquivo precisa conter o gate de classe C e o marcador de revisão. Uma
#     cópia anterior ao 01.5.2 falha aqui — é o guarda direto contra o incidente.
if ! grep -q 'normalizar_classe_c' "$SCRIPT"; then
  echo "erro: o arquivo executado NÃO contém o gate de classe C (normalizar_classe_c)." >&2
  echo "      Cópia defasada (anterior ao PROD-DB-01.5.2). Atualize db/admin/005-*.sql." >&2
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
  if ! git -C "$SELF_DIR" diff --quiet HEAD -- 005-propagar-nomes-locais-e42.sql; then
    echo "erro: db/admin/005-propagar-nomes-locais-e42.sql difere do HEAD do repositório." >&2
    echo "      Atualize (git pull --ff-only) ou revise as alterações locais antes de executar." >&2
    exit 2
  fi
fi

echo "E4.2/$REVISAO_ESPERADA — executando arquivo verificado: $SCRIPT" >&2
exec psql "$DATABASE_URL" -v ON_ERROR_STOP=1 "$@" -f "$SCRIPT"
