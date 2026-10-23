#!/usr/bin/env bash
# ============================================================================
# PROD-CONSOLIDAR-LOCAIS-E1 — Executor seguro do script administrativo 007
# (consolidação definitiva do local ID 6 'loja' dentro do local oficial ID 3 'LOJA').
#
# Segue o mesmo contrato de segurança dos executores db/admin/run-005-e42.sh e
# db/admin/run-006-e42.sh:
#   1. exige DATABASE_URL explícita;
#   2. garante que o arquivo 007 contém a tríplice autorização e a revisão esperada;
#   3. em árvore git com commits, recusa cópia divergente do HEAD salvo quando
#      ALLOW_WORKING_TREE=1 é explicitamente definido em homologação/CI;
#   4. executa via psql com ON_ERROR_STOP=1 (DRY-RUN por padrão; ROLLBACK em
#      qualquer erro ou sem tríplice autorização).
#
# Uso:
#   # 1) DRY-RUN (padrão — valida antes, simula e valida depois, faz ROLLBACK):
#   DATABASE_URL=... db/admin/run-007-e42.sh
#
#   # 2) APPLY em produção (após backup com pg_dump):
#   DATABASE_URL=... db/admin/run-007-e42.sh \
#     -v apply=on \
#     -v confirmacao=PROD-CONSOLIDAR-LOCAIS-E1 \
#     -v autorizacao=PROD-CONSOLIDAR-LOCAIS-E1
# ============================================================================
set -euo pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$SELF_DIR/007-consolidar-locais-estoque-empresa1.sql"
REVISAO_ESPERADA='PROD-CONSOLIDAR-LOCAIS-E1'
PSQL_EXEC="${PSQL_BIN:-psql}"

if [ -z "${DATABASE_URL:-}" ]; then
  echo "erro: DATABASE_URL não definida." >&2
  exit 2
fi

if [ ! -f "$SCRIPT" ]; then
  echo "erro: arquivo não encontrado: $SCRIPT" >&2
  exit 2
fi

if ! grep -q 'autorizacao' "$SCRIPT"; then
  echo "erro: o arquivo executado NÃO contém o parâmetro de autorização (autorizacao)." >&2
  exit 2
fi
if ! grep -q "$REVISAO_ESPERADA" "$SCRIPT"; then
  echo "erro: revisão esperada '$REVISAO_ESPERADA' ausente em $SCRIPT." >&2
  exit 2
fi

if [ "${ALLOW_WORKING_TREE:-0}" != "1" ] && command -v git >/dev/null 2>&1 && git -C "$SELF_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  if git -C "$SELF_DIR" ls-files --error-unmatch 007-consolidar-locais-estoque-empresa1.sql >/dev/null 2>&1; then
    if ! git -C "$SELF_DIR" diff --quiet HEAD -- 007-consolidar-locais-estoque-empresa1.sql; then
      echo "erro: db/admin/007-consolidar-locais-estoque-empresa1.sql difere do HEAD do repositório." >&2
      echo "      Faça commit/pull antes de aplicar em produção." >&2
      exit 2
    fi
  else
    echo "erro: db/admin/007-consolidar-locais-estoque-empresa1.sql ainda não está versionado no git HEAD." >&2
    exit 2
  fi
fi

echo "BROBOND/$REVISAO_ESPERADA — executando arquivo verificado: $SCRIPT" >&2
exec "$PSQL_EXEC" "$DATABASE_URL" -v ON_ERROR_STOP=1 "$@" -f "$SCRIPT"
