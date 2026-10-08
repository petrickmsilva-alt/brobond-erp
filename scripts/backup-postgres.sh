#!/usr/bin/env bash
# ============================================================================
# BROBOND ERP — backup diário do Postgres (pg_dump custom + zstd + prova de restore)
#
#   Uso:
#     DATABASE_URL="postgres://user:pass@host:5432/brobond" scripts/backup-postgres.sh
#
#   O que ele faz, nesta ordem:
#     1. pg_dump em FORMATO CUSTOM (-Fc) com a compressão interna DESLIGADA;
#     2. comprime o arquivo com zstd e confere o frame com `zstd --test`;
#     3. prova que o dump é restaurável: descompacta, cria um banco temporário
#        `brobond_restore_check_*`, roda pg_restore --exit-on-error e confere
#        se as tabelas voltaram;
#     4. aplica retenção estrita: some com tudo mais velho que 30 dias.
#
#   Saída (em $BACKUP_DIR, padrão <repo>/backups):
#     brobond-<AAAA-MM-DD>T<HHMMSS>Z.dump.zst          o dump comprimido
#     brobond-<AAAA-MM-DD>T<HHMMSS>Z.dump.zst.sha256   checksum + metadados
#
#   Código de saída: 0 só se o dump EXISTE, COMPRIME e RESTAURA. Qualquer
#   outra coisa é != 0 — é isso que dispara o alerta no workflow backup.yml.
#
# ----------------------------------------------------------------------------
# POR QUE -Fc COM COMPRESSÃO INTERNA DESLIGADA (-Z 0)?
#
# O formato custom do pg_dump já comprime com zlib por padrão. Passar esse
# arquivo por cima do zstd não ganha quase nada: o segundo compressor só acha
# entropia residual e queima CPU à toa. Desligar a compressão interna deixa o
# zstd fazer o trabalho inteiro — razão melhor, descompressão muito mais rápida
# — e o resultado continua sendo um archive custom válido: depois do `zstd -d`,
# `pg_restore -l` e o restore seletivo por tabela seguem funcionando.
#
# Recuperar:
#     zstd -d brobond-<stamp>.dump.zst
#     pg_restore -d "$DATABASE_URL" --no-owner --no-privileges brobond-<stamp>.dump
# ============================================================================

set -Eeuo pipefail

# Backup contém dado de cliente (documento, endereço, financeiro). Arquivo novo
# sai 0600 e diretório novo 0700 — nunca legível por grupo/outros.
umask 077

readonly SCRIPT_NAME="$(basename "${BASH_SOURCE[0]}")"
readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ---------------------------------------------------------------------------
# Configuração (tudo sobrescrevível por variável de ambiente)
# ---------------------------------------------------------------------------
BACKUP_DIR="${BACKUP_DIR:-${SCRIPT_DIR}/../backups}"
RETENTION_DAYS="${RETENTION_DAYS:-30}"
ZSTD_LEVEL="${ZSTD_LEVEL:-19}"
ZSTD_THREADS="${ZSTD_THREADS:-0}"                     # 0 = todos os núcleos
RESTORE_CHECK_TIMEOUT="${RESTORE_CHECK_TIMEOUT:-900}" # segundos
SKIP_RESTORE_CHECK="${SKIP_RESTORE_CHECK:-0}"

# Prefixo do banco temporário da prova de restore. Fixo de propósito: é por ele
# que o operador (e a limpeza do cleanup) reconhece um banco de verificação.
readonly CHECK_DB_PREFIX='brobond_restore_check'

# ---------------------------------------------------------------------------
# Log
# ---------------------------------------------------------------------------
if [[ -t 1 ]]; then
  C_INFO=$'\033[1;34m'; C_OK=$'\033[1;32m'; C_WARN=$'\033[1;33m'; C_ERR=$'\033[1;31m'; C_OFF=$'\033[0m'
else
  C_INFO=''; C_OK=''; C_WARN=''; C_ERR=''; C_OFF=''
fi

log()  { printf '%s[%s]%s %s\n'       "$C_INFO" "$(date -u +%H:%M:%S)" "$C_OFF" "$*"; }
ok()   { printf '%s[%s]%s %s\n'       "$C_OK"   "$(date -u +%H:%M:%S)" "$C_OFF" "$*"; }
warn() { printf '%s[%s] AVISO:%s %s\n' "$C_WARN" "$(date -u +%H:%M:%S)" "$C_OFF" "$*" >&2; }
die()  { printf '%s[%s] ERRO:%s %s\n'  "$C_ERR"  "$(date -u +%H:%M:%S)" "$C_OFF" "$*" >&2; exit 1; }

usage() {
  cat <<EOF
${SCRIPT_NAME} — backup do Postgres do BROBOND ERP (custom + zstd + prova de restore)

Uso: DATABASE_URL=... ${SCRIPT_NAME} [opção]

Opções:
  -h, --help          mostra esta ajuda
  -d, --dir DIR       diretório de destino   (padrão: ${BACKUP_DIR})
  -r, --retencao DIAS retenção em dias       (padrão: ${RETENTION_DAYS})
      --sem-restore   pula a prova de restore (só em emergência)

Variáveis de ambiente:
  DATABASE_URL            obrigatória — URL de conexão do Postgres
  BACKUP_DIR              diretório de destino
  RETENTION_DAYS          retenção em dias (padrão 30)
  ZSTD_LEVEL              nível do zstd, 1-19 (padrão ${ZSTD_LEVEL})
  ZSTD_THREADS            threads do zstd, 0 = auto (padrão ${ZSTD_THREADS})
  RESTORE_CHECK_TIMEOUT   timeout da prova de restore, em segundos (padrão ${RESTORE_CHECK_TIMEOUT})
  SKIP_RESTORE_CHECK      1 para pular a prova de restore
EOF
}

# ---------------------------------------------------------------------------
# Argumentos
# ---------------------------------------------------------------------------
while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help)     usage; exit 0 ;;
    -d|--dir)      [[ $# -ge 2 ]] || die "$1 exige um argumento"; BACKUP_DIR="$2"; shift 2 ;;
    -r|--retencao) [[ $# -ge 2 ]] || die "$1 exige um argumento"; RETENTION_DAYS="$2"; shift 2 ;;
    --sem-restore) SKIP_RESTORE_CHECK=1; shift ;;
    *)             usage >&2; die "opção desconhecida: $1" ;;
  esac
done

# ---------------------------------------------------------------------------
# Validação do ambiente — falha ANTES de abrir conexão, com mensagem clara.
# ---------------------------------------------------------------------------
[[ "${RETENTION_DAYS}" =~ ^[0-9]+$ ]]        || die "RETENTION_DAYS precisa ser inteiro >= 0 (veio: ${RETENTION_DAYS})"
[[ "${ZSTD_LEVEL}" =~ ^([1-9]|1[0-9])$ ]]    || die "ZSTD_LEVEL precisa estar entre 1 e 19 (veio: ${ZSTD_LEVEL})"
[[ "${ZSTD_THREADS}" =~ ^[0-9]+$ ]]          || die "ZSTD_THREADS precisa ser inteiro >= 0 (veio: ${ZSTD_THREADS})"
[[ "${RESTORE_CHECK_TIMEOUT}" =~ ^[0-9]+$ ]] || die "RESTORE_CHECK_TIMEOUT precisa ser inteiro >= 0 (veio: ${RESTORE_CHECK_TIMEOUT})"

for bin in pg_dump pg_restore psql zstd; do
  command -v "$bin" >/dev/null 2>&1 \
    || die "\`${bin}\` não está no PATH. Instale postgresql-client e zstd antes de rodar o backup."
done

[[ -n "${DATABASE_URL:-}" ]] \
  || die "DATABASE_URL não definida. Exemplo: DATABASE_URL=\"postgres://user:pass@host:5432/brobond\" ${SCRIPT_NAME}"

# Nunca deixa a senha vazar no log.
url_sem_segredo() { sed -E 's#(://[^:/@]+:)[^@]+@#\1***@#' <<<"$1"; }

# ---------------------------------------------------------------------------
# URL do MESMO cluster apontando para OUTRO banco.
#
# Só troca o segmento de dbname na autoridade da URL — usuário, senha, host,
# porta e query string (sslmode, options…) são preservados. É assim que a prova
# de restore cria e conecta no `brobond_restore_check_*` sem precisar de uma
# segunda variável de ambiente.
#
# Obs.: senha com "/" precisa vir percent-encoded (%2F) na URL, como manda a
# RFC 3986; nesse formato o regex abaixo é exato.
# ---------------------------------------------------------------------------
url_para_banco() {
  local banco="$1"
  sed -E "s#^(postgres(ql)?://[^/]*/)[^/?]*#\1${banco}#" <<<"${DATABASE_URL}"
}

# ---------------------------------------------------------------------------
# Total de linhas de todas as tabelas do schema public, EXATO.
#
# Monta um `SELECT count(*) … UNION ALL …` com o nome das tabelas e executa.
# De propósito não usa `query_to_xml`: builds do Postgres sem libxml respondem
# "unsupported XML feature", e uma contagem que falha em silêncio faria o
# script relatar como íntegro um dump que voltou sem dados.
#
# Também não usa `pg_class.reltuples`: é estimativa do autovacuum, e num banco
# recém-restaurado ela vem zerada — daria falso positivo.
# ---------------------------------------------------------------------------
contar_linhas() {
  local url="$1" uniao
  uniao="$(psql "${url}" -v ON_ERROR_STOP=1 -tA -c \
    "SELECT string_agg(format('SELECT count(*) AS n FROM %I', table_name), ' UNION ALL ')
       FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE';")" || return 1
  # Banco sem nenhuma tabela: nada a somar.
  if [[ -z "${uniao}" ]]; then
    echo 0
    return 0
  fi
  psql "${url}" -v ON_ERROR_STOP=1 -tA -c \
    "SELECT COALESCE(SUM(n), 0)::bigint FROM (${uniao}) AS contagens(n);" || return 1
}

# ---------------------------------------------------------------------------
# Limpeza garantida: o banco temporário e os arquivos soltos saem sempre —
# inclusive em CTRL+C, timeout ou falha no meio do restore.
# ---------------------------------------------------------------------------
CHECK_DB=''
TMP_DIR=''

cleanup() {
  local codigo=$?
  if [[ -n "${CHECK_DB}" ]]; then
    # pg_restore pode ter deixado sessão aberta; sem derrubar, o DROP trava.
    psql "$(url_para_banco "${CHECK_DB}")" -v ON_ERROR_STOP=0 -q -c \
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${CHECK_DB}' AND pid <> pg_backend_pid();" \
      >/dev/null 2>&1 || true
    psql "${DATABASE_URL}" -v ON_ERROR_STOP=0 -q -c "DROP DATABASE IF EXISTS \"${CHECK_DB}\";" \
      >/dev/null 2>&1 \
      || warn "não consegui apagar o banco de verificação \"${CHECK_DB}\" — apague manualmente."
    CHECK_DB=''
  fi
  if [[ -n "${TMP_DIR}" && -d "${TMP_DIR}" ]]; then
    rm -rf "${TMP_DIR}"
  fi
  TMP_DIR=''
  return "${codigo}"
}
trap cleanup EXIT
trap 'die "interrompido pelo usuário"' INT TERM

# ---------------------------------------------------------------------------
# Lock de execução: dois backups simultâneos no mesmo host brigam por disco e
# podem pegar o banco no meio de uma transação. `flock` é best-effort — sem o
# util-linux, seguimos com aviso em vez de morrer.
# ---------------------------------------------------------------------------
mkdir -p "${BACKUP_DIR}" || die "não consegui criar o diretório de backup: ${BACKUP_DIR}"
readonly LOCK_FILE="${BACKUP_DIR}/.backup-postgres.lock"

if command -v flock >/dev/null 2>&1; then
  exec 9>"${LOCK_FILE}"
  flock --nonblock 9 || die "já existe um backup em andamento (lock: ${LOCK_FILE})."
else
  warn "\`flock\` indisponível — seguindo sem proteção contra execuções simultâneas."
fi

# ---------------------------------------------------------------------------
# 0. Conectividade
# ---------------------------------------------------------------------------
log "Destino: ${BACKUP_DIR}"
log "Banco:   $(url_sem_segredo "${DATABASE_URL}")"

SERVER_VERSION="$(psql "${DATABASE_URL}" -v ON_ERROR_STOP=1 -tAc 'SHOW server_version;' 2>&1)" \
  || die "não consegui conectar no Postgres: ${SERVER_VERSION}"
readonly SERVER_VERSION
ok "Conectado — PostgreSQL ${SERVER_VERSION}"

SOURCE_DB="$(psql "${DATABASE_URL}" -v ON_ERROR_STOP=1 -tAc 'SELECT current_database();' 2>&1)" \
  || die "não consegui descobrir o banco de origem: ${SOURCE_DB}"
readonly SOURCE_DB

# Carimbo UTC: o nome do arquivo precisa ser ordenável em qualquer fuso.
readonly STAMP="$(date -u +%Y-%m-%dT%H%M%SZ)"
readonly BASE_NAME="brobond-${STAMP}"
readonly DUMP_ZST="${BACKUP_DIR}/${BASE_NAME}.dump.zst"
readonly CHECKSUM_FILE="${DUMP_ZST}.sha256"

TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/brobond-backup.XXXXXXXX")"
readonly RAW_DUMP="${TMP_DIR}/${BASE_NAME}.dump"

INICIO="$(date +%s)"

# ---------------------------------------------------------------------------
# 1. pg_dump — formato custom, compressão interna desligada (ver cabeçalho)
# ---------------------------------------------------------------------------
log "Gerando dump (custom, -Z 0) de \"${SOURCE_DB}\"…"

# --no-owner / --no-privileges: o restore não depende do dono original nem dos
# GRANTs do cluster de origem — essencial para subir em outro ambiente.
if ! pg_dump \
      --dbname="${DATABASE_URL}" \
      --format=custom \
      --compress=0 \
      --no-owner \
      --no-privileges \
      --file="${RAW_DUMP}" \
      >"${TMP_DIR}/pg_dump.log" 2>&1; then
  tail -20 "${TMP_DIR}/pg_dump.log" >&2 || true
  die "pg_dump falhou — nenhum backup foi gerado."
fi

[[ -s "${RAW_DUMP}" ]] || die "pg_dump terminou mas o arquivo está vazio: ${RAW_DUMP}"

readonly BYTES_RAW="$(wc -c <"${RAW_DUMP}")"
readonly TAM_RAW="$(numfmt --to=iec "${BYTES_RAW}" 2>/dev/null || echo "${BYTES_RAW} bytes")"
log "Dump bruto: ${TAM_RAW}"

# ---------------------------------------------------------------------------
# 2. Compressão zstd
# ---------------------------------------------------------------------------
log "Comprimindo com zstd -${ZSTD_LEVEL} (${ZSTD_THREADS} = auto-threads)…"
# NB: o zstd escreve com `-o ARQUIVO`; não existe `--output-file` nele.
zstd --quiet --force "-${ZSTD_LEVEL}" --threads="${ZSTD_THREADS}" \
     -o "${DUMP_ZST}" "${RAW_DUMP}" 2>"${TMP_DIR}/zstd.log" \
  || { cat "${TMP_DIR}/zstd.log" >&2 || true; die "zstd falhou ao comprimir o dump."; }

[[ -s "${DUMP_ZST}" ]] || die "zstd terminou mas o arquivo está vazio: ${DUMP_ZST}"

# O arquivo tem que ser um frame zstd de verdade — senão o "backup" é lixo que
# só seria descoberto no dia do desastre.
zstd --test --quiet "${DUMP_ZST}" || die "o arquivo comprimido não passou no \`zstd --test\`."

readonly BYTES_ZST="$(wc -c <"${DUMP_ZST}")"
readonly TAM_ZST="$(numfmt --to=iec "${BYTES_ZST}" 2>/dev/null || echo "${BYTES_ZST} bytes")"
readonly RAZAO="$(awk -v a="${BYTES_RAW}" -v b="${BYTES_ZST}" \
  'BEGIN { if (b > 0 && a > 0) printf "%.1fx", a / b; else print "n/d" }')"
ok "Comprimido: ${TAM_ZST} (${RAZAO} do original)"

# O bruto não é mais necessário: a prova de restore descompacta do .zst, que é
# exatamente o caminho real de recuperação.
rm -f "${RAW_DUMP}"

# ---------------------------------------------------------------------------
# 3. Prova de restore — o único passo que prova que o backup PRESTA.
#
#    Descompacta o .zst, cria `brobond_restore_check_<stamp>_<pid>`, roda
#    pg_restore --exit-on-error e confere se as tabelas voltaram. O banco
#    temporário é apagado no trap de saída, dê certo ou dê errado.
# ---------------------------------------------------------------------------
RESTORE_OK='pulado'
TABELAS_RESTORE=0
TABELAS_ORIGEM=0
LINHAS_ORIGEM='?'
LINHAS_RESTORE='?'

if [[ "${SKIP_RESTORE_CHECK}" == '1' ]]; then
  warn "SKIP_RESTORE_CHECK=1 — o dump NÃO foi testado. O restore pode falhar no dia do desastre."
else
  log "Validando restore em banco temporário…"

  CHECK_DB="${CHECK_DB_PREFIX}_${STAMP//[.:]/}_$$"
  # NAMEDATALEN do Postgres é 63 bytes; o sufixo não pode estourar isso.
  CHECK_DB="${CHECK_DB:0:63}"

  psql "${DATABASE_URL}" -v ON_ERROR_STOP=1 -q -c "CREATE DATABASE \"${CHECK_DB}\";" \
    || die "não consegui criar o banco de verificação \"${CHECK_DB}\"."
  log "Banco de verificação criado: ${CHECK_DB}"

  readonly RESTORE_SRC="${TMP_DIR}/restore-check.dump"
  zstd --quiet --decompress --force -o "${RESTORE_SRC}" "${DUMP_ZST}" 2>"${TMP_DIR}/zstd-d.log" \
    || { cat "${TMP_DIR}/zstd-d.log" >&2 || true; die "falha ao descompactar o dump para a prova de restore."; }

  # timeout sem `timeout` (macOS sem coreutils): degrada para execução direta.
  if command -v timeout >/dev/null 2>&1; then
    TIMEOUT_CMD=(timeout "${RESTORE_CHECK_TIMEOUT}")
  else
    warn "\`timeout\` indisponível — a prova de restore roda sem limite de tempo."
    TIMEOUT_CMD=()
  fi

  readonly URL_CHECK="$(url_para_banco "${CHECK_DB}")"
  readonly PGRESTORE_ARGS=(--no-owner --no-privileges --exit-on-error --dbname="${URL_CHECK}")

  # RESTORE EM TRÊS FASES — pre-data, data, post-data.
  #
  # Não é preciosismo: o restore em passo único QUEBRA neste schema, por dois
  # motivos independentes, e ambos só aparecem quando o banco tem dados.
  #
  # 1) CHECK que chama função SQL que lê OUTRA tabela:
  #      itens_compra_nao_excede_pedido CHECK (brobond_qtd_recebida_item(id) <= quantidade)
  #      brobond_qtd_recebida_item() → SELECT … FROM compra_recebimento_itens …
  #    O pg_restore ordena os objetos pelo grafo de dependências que ele CONSEGUE
  #    ver, e o corpo de uma função é opaco para ele. No passo único o COPY de
  #    `itens_compra` roda antes de `compra_recebimento_itens` existir e o banco
  #    responde "relation does not exist".
  #    → resolvido pela fase pre-data, que cria TODAS as tabelas (e os CHECK)
  #      antes de qualquer linha.
  #
  # 2) Ordem de carga entre tabelas com FK:
  #    com `--data-only` puro, `auditoria` entra antes de `empresas` e estoura
  #    `auditoria_empresa_id_fkey`.
  #    → resolvido pela fase post-data, que cria FK, índice e trigger SÓ DEPOIS
  #      de os dados estarem carregados (e ainda valida tudo no final).
  #
  # É o procedimento padrão do pg_dump para essa classe de problema e não exige
  # superusuário (ao contrário de --disable-triggers).
  for fase in pre-data data post-data; do
    case "${fase}" in
      data)      fase_args=(--data-only) ;;
      *)         fase_args=(--section="${fase}") ;;
    esac
    if ! "${TIMEOUT_CMD[@]}" pg_restore "${fase_args[@]}" "${PGRESTORE_ARGS[@]}" "${RESTORE_SRC}" \
          >"${TMP_DIR}/pg_restore_${fase//-/_}.log" 2>&1; then
      tail -20 "${TMP_DIR}/pg_restore_${fase//-/_}.log" >&2 || true
      die "pg_restore (${fase}) falhou em \"${CHECK_DB}\" — o dump de hoje NÃO é restaurável."
    fi
    log "Fase ${fase} concluída."
  done

  TABELAS_RESTORE="$(psql "${URL_CHECK}" -v ON_ERROR_STOP=1 -tAc \
    "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE';")" \
    || die "não consegui contar as tabelas no banco de verificação."

  # Não basta a tabela existir: o restore só vale se os DADOS voltaram.
  TABELAS_ORIGEM="$(psql "${DATABASE_URL}" -v ON_ERROR_STOP=1 -tAc \
    "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE';")"

  LINHAS_ORIGEM="$(contar_linhas "${DATABASE_URL}")" || die "não consegui contar as linhas do banco de origem."
  LINHAS_RESTORE="$(contar_linhas "${URL_CHECK}")"   || die "não consegui contar as linhas do banco de verificação."

  [[ "${TABELAS_RESTORE}" =~ ^[0-9]+$ ]] || die "a prova de restore não devolveu uma contagem de tabelas (veio: ${TABELAS_RESTORE})."
  [[ "${TABELAS_RESTORE}" -gt 0 ]]       || die "o restore subiu sem nenhuma tabela — dump corrompido ou vazio."
  [[ "${TABELAS_RESTORE}" -eq "${TABELAS_ORIGEM}" ]] \
    || die "o restore recriou ${TABELAS_RESTORE} tabela(s), mas a origem tem ${TABELAS_ORIGEM} — schema incompleto."

  # Banco com 10 mil linhas que volta com 9 mil é backup perdido, não backup.
  [[ "${LINHAS_RESTORE}" -eq "${LINHAS_ORIGEM}" ]] \
    || die "o restore trouxe ${LINHAS_RESTORE} linha(s), mas a origem tem ${LINHAS_ORIGEM} — dados perdidos no dump."

  rm -f "${RESTORE_SRC}"
  RESTORE_OK='ok'
  ok "Restore validado: ${TABELAS_RESTORE}/${TABELAS_ORIGEM} tabela(s), ${LINHAS_RESTORE}/${LINHAS_ORIGEM} linha(s) em \"${CHECK_DB}\""
fi

# ---------------------------------------------------------------------------
# 4. Checksum + manifesto
# ---------------------------------------------------------------------------
(
  cd "${BACKUP_DIR}"
  sha256sum "$(basename "${DUMP_ZST}")" >"$(basename "${CHECKSUM_FILE}")"
) || die "não consegui calcular o sha256 do dump."

{
  echo "# BROBOND ERP — backup ${STAMP}"
  echo "banco_origem=${SOURCE_DB}"
  echo "dump=$(basename "${DUMP_ZST}")"
  echo "servidor_postgres=${SERVER_VERSION}"
  echo "tamanho_bruto=${TAM_RAW}"
  echo "tamanho_comprimido=${TAM_ZST}"
  echo "razao_compressao=${RAZAO}"
  echo "restore_validado=${RESTORE_OK}"
  echo "tabelas_no_restore=${TABELAS_RESTORE}/${TABELAS_ORIGEM}"
  echo "linhas_no_restore=${LINHAS_RESTORE}/${LINHAS_ORIGEM}"
  echo "segundos_total=$(( $(date +%s) - INICIO ))"
} >>"${CHECKSUM_FILE}"

ok "Checksum gravado: $(basename "${CHECKSUM_FILE}")"

# ---------------------------------------------------------------------------
# 5. Retenção estrita — some com tudo mais velho que N dias.
#
#    `-mmin +43200` em vez do óbvio `-mtime +30`: o -mtime arredonda a idade
#    para BAIXO em dias inteiros, então "-mtime +30" só apaga a partir de 31
#    dias completos. Contando em minutos (30 × 1440 = 43200) o corte é
#    exatamente 30 × 24 h, que é o que a política pede.
# ---------------------------------------------------------------------------
readonly RETENCAO_MIN=$(( RETENTION_DAYS * 1440 ))
log "Aplicando retenção: apagar dumps com mais de ${RETENTION_DAYS} dia(s) (${RETENCAO_MIN} min)…"

ANTIGOS=()
while IFS= read -r linha; do
  [[ -n "${linha}" ]] && ANTIGOS+=("${linha}")
done < <(find "${BACKUP_DIR}" -maxdepth 1 -type f -name 'brobond-*.dump.zst' -mmin "+${RETENCAO_MIN}" -print 2>/dev/null || true)

if [[ ${#ANTIGOS[@]} -eq 0 ]]; then
  log "Nada para apagar — todos os dumps estão dentro da janela."
else
  for velho in "${ANTIGOS[@]}"; do
    rm -f -- "${velho}" "${velho}.sha256"
    log "Removido (> ${RETENTION_DAYS}d): $(basename "${velho}")"
  done
  ok "Retenção aplicada: ${#ANTIGOS[@]} dump(s) antigo(s) removido(s)."
fi

# ---------------------------------------------------------------------------
# Resumo final — o workflow lê estas linhas no log do GitHub Actions.
# ---------------------------------------------------------------------------
echo
echo "==================== BACKUP CONCLUÍDO ===================="
echo "arquivo : ${DUMP_ZST}"
echo "tamanho : ${TAM_ZST} (bruto ${TAM_RAW}, ${RAZAO})"
echo "banco   : ${SOURCE_DB} @ PostgreSQL ${SERVER_VERSION}"
echo "restore : ${RESTORE_OK} (${TABELAS_RESTORE}/${TABELAS_ORIGEM} tabelas, ${LINHAS_RESTORE}/${LINHAS_ORIGEM} linhas)"
echo "retenção: ${RETENTION_DAYS} dia(s)"
echo "tempo   : $(( $(date +%s) - INICIO ))s"
echo "=========================================================="
