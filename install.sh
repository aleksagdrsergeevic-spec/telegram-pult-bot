#!/usr/bin/env bash
# Установка и обновление Telegram-пульта. Идемпотентно: запускать можно сколько угодно раз.
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/telegram-pult}"
DATA_DIR="${DATA_DIR:-/var/lib/telegram-pult}"
PULT_USER="${PULT_USER:-pult}"
SERVICE_NAME="telegram-pult"
SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

log()  { printf '%s [install] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"; }
warn() { printf '%s [install][warn] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >&2; }
die()  { printf '%s [install][ошибка] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >&2; exit 1; }

has() { command -v "$1" >/dev/null 2>&1; }

usage() {
  cat <<'USAGE'
Использование на сервере (от root):
  sudo bash install.sh [опции]

Опции:
  --token <токен>       токен от @BotFather, запишется в .env
  --allowed <id,id>     ALLOWED_CHAT_IDS, кому разрешено управлять ботом
  --model <модель>      модель OpenCode, по умолчанию opencode/big-pickle
  --web-url <https://…> публичный адрес MiniApp (ставит кнопку в меню бота)
  --help                эта справка

Без опций install.sh ничего не перезаписывает: если .env уже есть,
меняются только значения, переданные явно.
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --token)
      if [ $# -ge 2 ] && [ "${2#-}" = "$2" ]; then TELEGRAM_BOT_TOKEN="$2"; shift 2; else die "--token требует значение"; fi
      ;;
    --token=*) TELEGRAM_BOT_TOKEN="${1#*=}"; shift ;;
    --allowed)
      if [ $# -ge 2 ] && [ "${2#-}" = "$2" ]; then ALLOWED_CHAT_IDS="$2"; shift 2; else die "--allowed требует значение"; fi
      ;;
    --allowed=*) ALLOWED_CHAT_IDS="${1#*=}"; shift ;;
    --model)
      if [ $# -ge 2 ] && [ "${2#-}" = "$2" ]; then MODEL="$2"; shift 2; else die "--model требует значение"; fi
      ;;
    --model=*) MODEL="${1#*=}"; shift ;;
    --web-url)
      if [ $# -ge 2 ] && [ "${2#-}" = "$2" ]; then WEB_PUBLIC_URL="$2"; shift 2; else die "--web-url требует значение"; fi
      ;;
    --web-url=*) WEB_PUBLIC_URL="${1#*=}"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) usage; die "неизвестный аргумент: $1" ;;
  esac
done

[ "$(id -u)" -eq 0 ] || die "нужен root: sudo bash install.sh"

# ---------------------------------------------------------------- Node ----

node_ok() {
  has node || return 1
  local major
  major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  [ "${major:-0}" -ge 20 ]
}

install_node() {
  log "Node 20+ не найден — устанавливаю"
  if has apt-get; then
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -y >/dev/null
    apt-get install -y curl ca-certificates gnupg >/dev/null
    curl -fsSL https://deb.nodesource.com/setup_20.x -o /tmp/nodesource_setup.sh
    bash /tmp/nodesource_setup.sh
    apt-get install -y nodejs
  elif has dnf; then
    curl -fsSL https://rpm.nodesource.com/setup_20.x -o /tmp/nodesource_setup.sh
    bash /tmp/nodesource_setup.sh
    dnf install -y nodejs
  elif has yum; then
    curl -fsSL https://rpm.nodesource.com/setup_20.x -o /tmp/nodesource_setup.sh
    bash /tmp/nodesource_setup.sh
    yum install -y nodejs
  else
    die "не знаю, как поставить Node на этой системе. Поставьте Node 20+ вручную и запустите install.sh снова"
  fi
  hash -r
  node_ok || die "Node 20+ так и не появился"
}

# ----------------------------------------------------------------- git ----

ensure_git() {
  if has git; then
    log "git уже установлен: $(git --version | head -n1)"
    return
  fi
  log "git не найден — устанавливаю"
  if has apt-get; then
    apt-get install -y git >/dev/null
  elif has dnf; then
    dnf install -y git >/dev/null
  elif has yum; then
    yum install -y git >/dev/null
  else
    warn "не смог поставить git: /new <git-url> не будет работать"
  fi
}

# ------------------------------------------------------------ OpenCode ----

ensure_opencode() {
  if has opencode; then
    log "opencode уже установлен: $(opencode --version 2>/dev/null | head -n1)"
    return
  fi
  log "opencode не найден — ставлю @opencode/cli@latest"
  if npm install -g @opencode/cli@latest >/tmp/pult-npm.log 2>&1; then
    hash -r
    if has opencode; then
      log "opencode установлен: $(opencode --version 2>/dev/null | head -n1)"
      return
    fi
  fi
  warn "@opencode/cli не встал — пробую opencode-ai@latest"
  if npm install -g opencode-ai@latest >>/tmp/pult-npm.log 2>&1; then
    hash -r
    if has opencode; then
      log "opencode установлен: $(opencode --version 2>/dev/null | head -n1)"
      return
    fi
  fi
  tail -n 40 /tmp/pult-npm.log >&2 || true
  die "не удалось установить OpenCode через npm"
}

# --------------------------------------------------------- пользователь ----

ensure_user() {
  if id -u "$PULT_USER" >/dev/null 2>&1; then
    log "пользователь $PULT_USER уже есть"
  else
    log "создаю системного пользователя $PULT_USER (работать от root бот не будет)"
    useradd --system --create-home --home-dir "$DATA_DIR" --shell /bin/bash "$PULT_USER"
  fi
}

ensure_dirs() {
  mkdir -p "$DATA_DIR/workspaces" "$DATA_DIR/logs"
  chown -R "$PULT_USER:$PULT_USER" "$DATA_DIR"
  chmod 750 "$DATA_DIR" "$DATA_DIR/workspaces"
}

install_opencode_config() {
  # Полный доступ без запросов подтверждений. Формат зависит от версии CLI:
  # v2 — массив permissions, v1 — объект permission.
  local dir="$DATA_DIR/.config/opencode"
  local file="$dir/opencode.json"
  local version major

  mkdir -p "$dir"
  if [ -f "$file" ]; then
    cp -a "$file" "${file}.bak" 2>/dev/null || true
    log "конфиг OpenCode уже есть — сохранил копию в ${file}.bak"
  fi

  version="$(opencode --version 2>/dev/null | head -n1)"
  major="${version%%.*}"
  if printf '%s' "$major" | grep -Eq '^[0-9]+$' && [ "$major" -ge 2 ]; then
    cat > "$file" <<'JSON'
{
  "$schema": "https://opencode.ai/config.json",
  "permissions": [
    { "action": "*", "resource": "*", "effect": "allow" },
    { "action": "read", "resource": "*.env*", "effect": "allow" }
  ]
}
JSON
    log "права OpenCode: полный доступ без подтверждений (v2 permissions)"
  else
    cat > "$file" <<'JSON'
{
  "$schema": "https://opencode.ai/config.json",
  "permission": "allow"
}
JSON
    log "права OpenCode: полный доступ без подтверждений (v1 permission: allow)"
  fi

  chown -R "$PULT_USER:$PULT_USER" "$dir"
  chmod 700 "$dir"
  chmod 600 "$file"
}

# -------------------------------------------------------------- файлы -----

copy_sources() {
  if [ "$SRC_DIR" = "$APP_DIR" ]; then
    log "исходники уже в $APP_DIR — копирование не нужно"
    return
  fi
  mkdir -p "$APP_DIR"
  if has rsync; then
    log "копирую исходники в $APP_DIR"
    rsync -a --delete \
      --exclude '.git' --exclude 'node_modules' --exclude '.env' \
      --exclude '.env.deploy' --exclude 'logs' --exclude 'data' \
      "$SRC_DIR"/ "$APP_DIR"/
  else
    log "rsync нет — копирую через tar"
    ( cd "$SRC_DIR" && tar -czf - --exclude-vcs \
        --exclude './.env' --exclude './.env.deploy' \
        --exclude './logs' --exclude './data' . ) | tar -xzf - -C "$APP_DIR"
  fi
  chmod +x "$APP_DIR/install.sh" "$APP_DIR/deploy.sh" 2>/dev/null || true
}

set_env_value() {
  # $1 файл, $2 ключ, $3 значение — заменяет строку или добавляет её
  local file="$1" key="$2" value="$3" tmp
  tmp="$(mktemp)"
  awk -v k="$key" -v v="$value" '
    BEGIN { done = 0 }
    index($0, k "=") == 1 { if (!done) { print k "=" v; done = 1 } ; next }
    { print }
    END { if (!done) print k "=" v }
  ' "$file" > "$tmp"
  cat "$tmp" > "$file"
  rm -f "$tmp"
}

setup_env() {
  local env_file="$APP_DIR/.env"
  if [ ! -f "$env_file" ]; then
    cp "$APP_DIR/.env.example" "$env_file"
    log "создан .env из .env.example"
  else
    log ".env уже есть — значения не перезаписываю"
  fi

  # deploy.sh заранее кладёт значения в .env.deploy — их переносим и удаляем.
  if [ -f "$APP_DIR/.env.deploy" ]; then
    while IFS='=' read -r key value; do
      [ -n "${key:-}" ] || continue
      case "$key" in \#*) continue ;; esac
      set_env_value "$env_file" "$key" "$value"
      log "в .env записан $key"
    done < "$APP_DIR/.env.deploy"
    rm -f "$APP_DIR/.env.deploy"
  fi

  if [ -n "${TELEGRAM_BOT_TOKEN:-}" ]; then
    set_env_value "$env_file" TELEGRAM_BOT_TOKEN "$TELEGRAM_BOT_TOKEN"
  fi
  if [ -n "${ALLOWED_CHAT_IDS:-}" ]; then
    set_env_value "$env_file" ALLOWED_CHAT_IDS "$ALLOWED_CHAT_IDS"
  fi
  if [ -n "${MODEL:-}" ]; then
    set_env_value "$env_file" MODEL "$MODEL"
  fi
  if [ -n "${WEB_PUBLIC_URL:-}" ]; then
    set_env_value "$env_file" WEB_PUBLIC_URL "${WEB_PUBLIC_URL%/}"
  fi

  chown "$PULT_USER:$PULT_USER" "$env_file"
  chmod 600 "$env_file"
}

run_as_pult() {
  if has runuser; then
    runuser -u "$PULT_USER" -- env HOME="$DATA_DIR" PATH="$PATH" "$@"
  else
    su -s /bin/bash -c "HOME='$DATA_DIR' $(printf '%q ' "$@")" "$PULT_USER"
  fi
}

tmo_as_pult() {
  # $1 — секунды, дальше — команда; timeout стоит между пользователем и программой
  local secs="$1"
  shift
  if has timeout; then
    run_as_pult timeout "$secs" "$@"
  else
    run_as_pult "$@"
  fi
}

# ------------------------------------------------------------- проверки ---

check_opencode() {
  local help_file=/tmp/pult-run-help.txt
  local models_file=/tmp/pult-models.txt
  local model

  log "проверяю флаги opencode run --help"
  if tmo_as_pult 90 opencode run --help >"$help_file" 2>&1; then
    if grep -q -- '--session' "$help_file"; then
      log "  --session: да (продолжаем сессию по id)"
    else
      log "  --session: нет (использую --continue)"
    fi
    if grep -q -- '--continue' "$help_file"; then
      log "  --continue: да"
    else
      warn "  --continue: нет — каждая задача может стать новой сессией"
    fi
    if grep -q -- '--model' "$help_file"; then
      log "  --model: да"
    else
      warn "  --model: нет — модель возьмётся из конфига OpenCode"
    fi
  else
    warn "opencode run --help не отработал"
  fi

  model="$(sed -n 's/^MODEL=//p' "$APP_DIR/.env" | head -n1)"
  [ -n "$model" ] || model="opencode/big-pickle"
  log "проверяю модель $model через opencode models"
  if tmo_as_pult 150 opencode models >"$models_file" 2>&1; then
    if grep -Fq "${model#opencode/}" "$models_file"; then
      log "  модель $model в списке есть"
    else
      warn "  модели $model нет в списке opencode models"
      warn "  для бесплатных моделей нужен вход: pult-opencode auth login"
    fi
  else
    warn "opencode models не отработал"
    warn "если нужны бесплатные модели (в том числе big-pickle), войдите:"
    warn "  pult-opencode auth login"
  fi
}

# -------------------------------------------------------------- systemd ---

write_unit() {
  local node_bin
  node_bin="$(command -v node)"
  case "$node_bin" in
    /root/*|/home/*)
      warn "Node лежит в $node_bin — пользователь $PULT_USER может не иметь к нему доступа."
      warn "Если сервис не стартует, поставьте Node из репозитория: https://github.com/nodesource/distributions"
      ;;
  esac
  cat > "$SERVICE_FILE" <<EOF
[Unit]
Description=Telegram Pult - управление OpenCode из Telegram
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=0

[Service]
Type=simple
User=${PULT_USER}
Group=${PULT_USER}
WorkingDirectory=${APP_DIR}
Environment=HOME=${DATA_DIR}
Environment=NODE_ENV=production
Environment=PATH=/usr/local/bin:/usr/bin:/bin:/usr/local/sbin:/usr/sbin
ExecStart=${node_bin} ${APP_DIR}/src/bot.js
Restart=always
RestartSec=5
RestartPreventExitStatus=78
KillMode=control-group
TimeoutStopSec=20
StandardOutput=journal
StandardError=journal
SyslogIdentifier=${SERVICE_NAME}

[Install]
WantedBy=multi-user.target
EOF
  chmod 644 "$SERVICE_FILE"
}

install_helper() {
  # Обёртка: запускает OpenCode от пользователя pult в его домашней папке.
  # Без неё `runuser ... opencode` из /root падает с EACCES: OpenCode читает cwd,
  # а доступ к /root есть только у root.
  cat > /usr/local/bin/pult-opencode <<EOF
#!/bin/sh
set -e
# PULT_OC_CWD позволяет запускать opencode в конкретной папке (для проверок)
cd "\${PULT_OC_CWD:-${DATA_DIR}}"
exec runuser -u "${PULT_USER}" -- env HOME="${DATA_DIR}" PATH=/usr/local/bin:/usr/bin:/bin:"${PATH}" opencode "\$@"
EOF
  chmod 755 /usr/local/bin/pult-opencode
}

start_service() {
  systemctl daemon-reload
  systemctl enable "$SERVICE_NAME" >/dev/null 2>&1 || true
  systemctl restart "$SERVICE_NAME"
  sleep 3
  if systemctl is-active --quiet "$SERVICE_NAME"; then
    log "сервис $SERVICE_NAME запущен"
  else
    warn "сервис $SERVICE_NAME не активен. Последние строки журнала:"
    journalctl -u "$SERVICE_NAME" -n 30 --no-pager >&2 || true
  fi
}

verify_bot() {
  local token me user
  token="$(sed -n 's/^TELEGRAM_BOT_TOKEN=//p' "$APP_DIR/.env" | head -n1)"
  if [ -z "$token" ]; then
    warn "TELEGRAM_BOT_TOKEN пуст — проверку токена пропускаю"
    return 0
  fi
  if ! has curl; then
    warn "curl не найден — не могу проверить токен через getMe"
    return 0
  fi
  me="$(curl -fsS --max-time 15 "https://api.telegram.org/bot${token}/getMe" 2>/dev/null || true)"
  case "$me" in
    *'"ok":true'*)
      user="$(printf '%s' "$me" | sed -n 's/.*"username":"\([^"]*\)".*/\1/p')"
      log "токен рабочий, бот: @${user:-?}"
      ;;
    *)
      warn "Telegram не подтвердил токен. Проверьте TELEGRAM_BOT_TOKEN в $APP_DIR/.env"
      ;;
  esac
}

# ---------------------------------------------------------------- поток ---

log "проверяю Node.js"
if node_ok; then
  log "Node $(node -v) уже есть"
else
  install_node
fi

ensure_git
ensure_opencode
ensure_user
ensure_dirs
install_opencode_config
copy_sources
setup_env
chown -R "$PULT_USER:$PULT_USER" "$APP_DIR"
chmod +x "$APP_DIR/install.sh" "$APP_DIR/deploy.sh" 2>/dev/null || true

verify_bot
check_opencode
install_helper
write_unit
start_service

TOKEN_LINE="$(sed -n 's/^TELEGRAM_BOT_TOKEN=//p' "$APP_DIR/.env" | head -n1)"
ALLOWED_LINE="$(sed -n 's/^ALLOWED_CHAT_IDS=//p' "$APP_DIR/.env" | head -n1)"

echo
log "готово. Каталоги:"
log "  приложение: $APP_DIR"
log "  рабочие папки: $DATA_DIR/workspaces"
log "  лог: $DATA_DIR/logs/pult.log"
log "  сервис: $SERVICE_NAME ($SERVICE_FILE)"

if [ -z "$TOKEN_LINE" ]; then
  warn "TELEGRAM_BOT_TOKEN пуст — бот выйдет с кодом 78, пока токен не вписан:"
  warn "  nano $APP_DIR/.env    (или: ./deploy.sh --host <vps> --token <токен>)"
  warn "  systemctl restart $SERVICE_NAME"
fi
if [ -z "$ALLOWED_LINE" ]; then
  warn "ALLOWED_CHAT_IDS пуст — бот будет отказывать всем:"
  warn "  впишите свой chat id в $APP_DIR/.env и перезапустите сервис"
  warn "  свой chat id бот покажет в ответе на любое сообщение"
fi

cat <<'DONE'

Дальше:
  1. Напишите боту /start — он покажет ваш chat id.
  2. Впишите этот id в ALLOWED_CHAT_IDS (файл .env) и выполните: systemctl restart telegram-pult
  3. Команды в чате: /new <имя>, /new <git-url>, /sessions, /status, /stop, /model
  4. Если OpenCode не отвечает или модель недоступна:
       pult-opencode auth login
DONE
