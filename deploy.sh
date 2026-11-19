#!/usr/bin/env bash
# Автоматический деплой Telegram-пульта на VPS по SSH.
# Идемпотентно: повторный запуск = обновление. Умеет ждать, пока сервер перезагрузится.
set -euo pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

HOST="${VPS_HOST:-}"
REMOTE_USER="${VPS_USER:-root}"
PORT="${VPS_PORT:-22}"
REMOTE_DIR="${VPS_DIR:-/opt/telegram-pult}"
SSH_KEY="${VPS_KEY:-}"
PASSWORD="${VPS_PASSWORD:-}"
TOKEN="${TELEGRAM_BOT_TOKEN:-}"
ALLOWED="${ALLOWED_CHAT_IDS:-}"
MODEL_VALUE="${MODEL:-}"

ACTION="deploy"
WAIT_SECONDS=0
ASSUME_YES=0
ASK_TOKEN=0
ASK_PASSWORD=0
START_TS="$(date +%s)"

# Значения по умолчанию из .env рядом со скриптом: токен, chat id, модель.
ENV_FILE="$SELF_DIR/.env"

env_from_file() {
  [ -f "$ENV_FILE" ] || return 0
  sed -n "s/^$1=//p" "$ENV_FILE" | head -n1 | tr -d '\r'
}

if [ -z "$TOKEN" ]; then
  TOKEN="$(env_from_file TELEGRAM_BOT_TOKEN)"
fi
if [ -z "$ALLOWED" ]; then
  ALLOWED="$(env_from_file ALLOWED_CHAT_IDS)"
fi
if [ -z "$MODEL_VALUE" ]; then
  MODEL_VALUE="$(env_from_file MODEL)"
fi

# Адрес VPS тоже можно держать в .env, чтобы команда была совсем короткой.
if [ -z "$HOST" ]; then
  HOST="$(env_from_file VPS_HOST)"
fi
if [ "$REMOTE_USER" = "root" ]; then
  file_user="$(env_from_file VPS_USER)"
  if [ -n "$file_user" ]; then
    REMOTE_USER="$file_user"
  fi
fi
if [ "$PORT" = "22" ]; then
  file_port="$(env_from_file VPS_PORT)"
  if [ -n "$file_port" ]; then
    PORT="$file_port"
  fi
fi
if [ -z "$SSH_KEY" ]; then
  SSH_KEY="$(env_from_file VPS_KEY)"
fi
ENV_USED=0
if [ -n "$TOKEN" ] || [ -n "$ALLOWED" ]; then
  ENV_USED=1
fi

log() { printf '%s [deploy] %s\n' "$(date '+%H:%M:%S')" "$*"; }
warn() { printf '%s [deploy][warn] %s\n' "$(date '+%H:%M:%S')" "$*" >&2; }
die() { printf '%s [ошибка] %s\n' "$(date '+%H:%M:%S')" "$*" >&2; exit 1; }

if [ "$ENV_USED" -eq 1 ]; then
  log "беру настройки бота из $ENV_FILE"
fi

usage() {
  cat <<'USAGE'
Использование:
  ./deploy.sh --host <ip|домен> [--user root] [опции]

Подключение:
  --host <адрес>        хост VPS (обязателен)
  --user <имя>          SSH-пользователь, обычно root
  --port <порт>         SSH-порт, по умолчанию 22
  --key <файл>          приватный ключ (по умолчанию ~/.ssh/telegram-pult_ed25519, потом id_ed25519)
  --password [пароль]   вход по паролю (нужен sshpass); без значения — спросит
  --bootstrap-key       создать ключ ~/.ssh/telegram-pult_ed25519 и показать публичную часть

Настройка бота:
  --token [токен]       токен от @BotFather (лучше не вводить в командной строке — будет запрос)
  --allowed <id...>     ALLOWED_CHAT_IDS через запятую
  --model <model>       модель, по умолчанию opencode/big-pickle
  --dir <путь>          каталог на сервере (по умолчанию /opt/telegram-pult)

Поведение:
  --wait <секунды>      сначала ждать, пока сервер поднимется (после перезагрузки)
  --yes                 не спрашивать подтверждение
  --status              показать состояние сервиса
  --logs                последние строки журнала сервиса
  --restart             перезапустить сервис
  --check               проверить node/opencode/git и сервис
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --host) HOST="${2:-}"; shift 2 ;;
    --host=*) HOST="${1#*=}"; shift ;;
    --user) REMOTE_USER="${2:-}"; shift 2 ;;
    --user=*) REMOTE_USER="${1#*=}"; shift ;;
    --port) PORT="${2:-}"; shift 2 ;;
    --port=*) PORT="${1#*=}"; shift ;;
    --dir) REMOTE_DIR="${2:-}"; shift 2 ;;
    --dir=*) REMOTE_DIR="${1#*=}"; shift ;;
    --key) SSH_KEY="${2:-}"; shift 2 ;;
    --key=*) SSH_KEY="${1#*=}"; shift ;;
    --password)
      if [ $# -ge 2 ] && [ "${2#-}" = "$2" ]; then PASSWORD="$2"; shift 2; else ASK_PASSWORD=1; shift; fi
      ;;
    --password=*) PASSWORD="${1#*=}"; shift ;;
    --token)
      if [ $# -ge 2 ] && [ "${2#-}" = "$2" ]; then TOKEN="$2"; shift 2; else ASK_TOKEN=1; shift; fi
      ;;
    --token=*) TOKEN="${1#*=}"; shift ;;
    --allowed) ALLOWED="${2:-}"; shift 2 ;;
    --allowed=*) ALLOWED="${1#*=}"; shift ;;
    --model) MODEL_VALUE="${2:-}"; shift 2 ;;
    --model=*) MODEL_VALUE="${1#*=}"; shift ;;
    --wait) WAIT_SECONDS="${2:-0}"; shift 2 ;;
    --yes|-y) ASSUME_YES=1; shift ;;
    --status) ACTION="status"; shift ;;
    --logs) ACTION="logs"; shift ;;
    --restart) ACTION="restart"; shift ;;
    --check) ACTION="check"; shift ;;
    --bootstrap-key) ACTION="bootstrap"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "неизвестный аргумент: $1 (см. --help)" ;;
  esac
done

if [ "$ASK_TOKEN" -eq 1 ]; then
  read -rsp "Токен бота от @BotFather: " TOKEN
  echo
fi
if [ "$ASK_PASSWORD" -eq 1 ]; then
  read -rsp "SSH-пароль для ${REMOTE_USER}@${HOST}: " PASSWORD
  echo
fi

if [ -n "$TOKEN" ] && ! printf '%s' "$TOKEN" | grep -Eq '^[0-9]+:[A-Za-z0-9_-]{30,}$'; then
  die "TELEGRAM_BOT_TOKEN выглядит неправильно (ожидается 123456:AA...). Проверьте токен и .env"
fi
if [ -n "$ALLOWED" ] && ! printf '%s' "$ALLOWED" | grep -Eq '^-?[0-9]+([[:space:],]+-?[0-9]+)*$'; then
  warn "ALLOWED_CHAT_IDS выглядит необычно: $ALLOWED"
fi

resolve_key() {
  if [ -n "$SSH_KEY" ]; then
    [ -f "$SSH_KEY" ] || die "нет файла ключа: $SSH_KEY"
    return 0
  fi
  local candidate
  for candidate in "$HOME/.ssh/telegram-pult_ed25519" "$HOME/.ssh/id_ed25519" "$HOME/.ssh/id_rsa"; do
    if [ -f "$candidate" ]; then
      SSH_KEY="$candidate"
      return 0
    fi
  done
  return 1
}

build_ssh_opts() {
  SSH_OPTS=(-o StrictHostKeyChecking=accept-new -o ConnectTimeout=15 -o ServerAliveInterval=15 -o ServerAliveCountMax=3 -p "$PORT")
  if [ -n "$PASSWORD" ]; then
    command -v sshpass >/dev/null 2>&1 \
      || die "для входа по паролю нужен sshpass: apt-get install -y sshpass (или используйте ключ: --bootstrap-key)"
    SSH_OPTS+=(-o PreferredAuthentications=password,keyboard-interactive -o PubkeyAuthentication=no)
  else
    SSH_OPTS+=(-o BatchMode=yes -o PreferredAuthentications=publickey)
    resolve_key || die "не нашёл SSH-ключ. Создайте его: $0 --bootstrap-key"
    SSH_OPTS+=(-i "$SSH_KEY")
  fi
}

ssh_do() {
  local cmd="$1"
  if [ -n "$PASSWORD" ]; then
    sshpass -p "$PASSWORD" ssh "${SSH_OPTS[@]}" "${REMOTE_USER}@${HOST}" "$cmd"
  else
    ssh "${SSH_OPTS[@]}" "${REMOTE_USER}@${HOST}" "$cmd"
  fi
}

confirm() {
  if [ "$ASSUME_YES" -eq 1 ]; then
    return 0
  fi
  printf 'Развернуть Telegram-пульт на %s@%s:%s в %s ? [y/N] ' "$REMOTE_USER" "$HOST" "$PORT" "$REMOTE_DIR"
  local answer
  read -r answer
  case "$answer" in
    y|Y|yes|YES|д|да|Д) ;;
    *) die "отменено" ;;
  esac
}

cmd_bootstrap() {
  local key="$HOME/.ssh/telegram-pult_ed25519"
  mkdir -p "$HOME/.ssh"
  chmod 700 "$HOME/.ssh"
  if [ ! -f "$key" ]; then
    ssh-keygen -t ed25519 -N "" -C "telegram-pult-deploy" -f "$key"
  else
    log "ключ уже есть: $key"
  fi
  echo
  log "добавьте этот публичный ключ на VPS (панель хостера или ~/.ssh/authorized_keys):"
  echo
  cat "${key}.pub"
  echo
  log "потом: $0 --host <ip> --user root --key $key"
}

wait_for_ssh() {
  log "жду, пока ${HOST}:${PORT} ответит по SSH (до ${WAIT_SECONDS} с)"
  local deadline=$(( $(date +%s) + WAIT_SECONDS ))
  while :; do
    if ssh_do "echo ok" >/dev/null 2>&1; then
      log "сервер на связи"
      return 0
    fi
    if [ "$(date +%s)" -ge "$deadline" ]; then
      die "сервер не ответил за ${WAIT_SECONDS} с"
    fi
    sleep 5
  done
}

require_host() {
  [ -n "$HOST" ] || die "укажите сервер: --host <ip|домен> (см. --help)"
  build_ssh_opts
}

cmd_deploy() {
  require_host
  confirm

  ssh_do ":" >/dev/null 2>&1 || die "не могу подключиться к ${REMOTE_USER}@${HOST}:${PORT}"
  log "соединение есть"

  ssh_do "mkdir -p '${REMOTE_DIR}'"

  log "копирую файлы на сервер"
  tar -czf - -C "$SELF_DIR" \
      --exclude-vcs \
      --exclude './.env' \
      --exclude './.env.deploy' \
      --exclude './node_modules' \
      --exclude './logs' \
      --exclude './data' . \
    | ssh_do "tar -xzf - -C '$REMOTE_DIR'"

  if [ -n "$TOKEN" ] || [ -n "$ALLOWED" ] || [ -n "$MODEL_VALUE" ]; then
    log "передаю настройки"
    {
      if [ -n "$TOKEN" ]; then printf 'TELEGRAM_BOT_TOKEN=%s\n' "$TOKEN"; fi
      if [ -n "$ALLOWED" ]; then printf 'ALLOWED_CHAT_IDS=%s\n' "$ALLOWED"; fi
      if [ -n "$MODEL_VALUE" ]; then printf 'MODEL=%s\n' "$MODEL_VALUE"; fi
      :
    } | ssh_do "cat > '${REMOTE_DIR}/.env.deploy'"
  fi

  log "запускаю install.sh на сервере (идемпотентно)"
  if ! ssh_do "bash '${REMOTE_DIR}/install.sh'"; then
    die "установка завершилась ошибкой. Логи: $0 --host $HOST --logs"
  fi

  log "проверяю сервис"
  ssh_do "systemctl is-active telegram-pult || true"
  log "готово за $(( $(date +%s) - START_TS )) с"
  log "проверить в любой момент: $0 --host $HOST --status"
}

cmd_status() {
  require_host
  ssh_do "systemctl --no-pager --full status telegram-pult | head -n 20 || true"
  echo "---"
  ssh_do "systemctl is-active telegram-pult || true"
  ssh_do "journalctl -u telegram-pult -n 15 --no-pager || true"
}

cmd_logs() {
  require_host
  ssh_do "journalctl -u telegram-pult -n 120 --no-pager"
}

cmd_restart() {
  require_host
  ssh_do "systemctl restart telegram-pult && sleep 2 && systemctl is-active telegram-pult"
}

cmd_check() {
  require_host
  log "node:     $(ssh_do 'node -v 2>/dev/null || echo нет')"
  log "opencode: $(ssh_do 'opencode --version 2>/dev/null | head -n1 || echo нет')"
  log "git:      $(ssh_do 'git --version 2>/dev/null | head -n1 || echo нет')"
  log "сервис:   $(ssh_do "systemctl is-active telegram-pult || true")"
  log "модель: $(ssh_do "sed -n 's/^MODEL=//p' '$REMOTE_DIR/.env' 2>/dev/null | head -n1")"
}

case "$ACTION" in
  bootstrap) cmd_bootstrap ;;
  *)
    if [ -n "$HOST" ] && [ "$WAIT_SECONDS" -gt 0 ]; then
      build_ssh_opts
      wait_for_ssh
    fi
    case "$ACTION" in
      deploy) cmd_deploy ;;
      status) cmd_status ;;
      logs) cmd_logs ;;
      restart) cmd_restart ;;
      check) cmd_check ;;
    esac
    ;;
esac
