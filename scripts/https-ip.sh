#!/usr/bin/env bash
# HTTPS для MiniApp прямо на IP: имя <ip-с-дефисами>.sslip.io + Caddy + Let's Encrypt.
# Идемпотентно; умеет освобождать занятые 80/443 (прошлый Caddy, nginx, apache).
set -euo pipefail

WEB_PORT="${WEB_PORT:-8787}"
APP_DIR="${APP_DIR:-/opt/telegram-pult}"
GRACE_WAIT="${GRACE_WAIT:-25}"

log()  { printf '%s [https] %s\n' "$(date '+%H:%M:%S')" "$*"; }
warn() { printf '%s [https][warn] %s\n' "$(date '+%H:%M:%S')" "$*" >&2; }
die()  { printf '%s [https][ошибка] %s\n' "$(date '+%H:%M:%S')" "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "нужен root: sudo bash scripts/https-ip.sh"

if ! command -v ss >/dev/null 2>&1; then
  apt-get update -y >/dev/null 2>&1 || true
  apt-get install -y iproute2 >/dev/null 2>&1 || true
fi
if ! command -v curl >/dev/null 2>&1; then
  apt-get update -y >/dev/null
  apt-get install -y curl >/dev/null
fi

IP="$(curl -fsS --max-time 10 https://api.ipify.org || true)"
[ -n "$IP" ] || IP="$(curl -fsS --max-time 10 https://ifconfig.me/ip || true)"
[ -n "$IP" ] || die "не смог определить внешний IP (нет выхода в интернет?)"

HOST="$(printf '%s' "$IP" | tr '.' '-').sslip.io"
log "IP сервера: $IP → адрес MiniApp: https://$HOST"

# --- кто держит порт -----------------------------------------------------
port_owner() {
  ss -ltnpH "sport = :$1" 2>/dev/null | sed -n 's/.*users:(("\([^"]*\)".*/\1/p' | head -n1
}

port_free() {
  [ -z "$(ss -ltnH "sport = :$1" 2>/dev/null)" ]
}

free_port() {
  local port="$1" owner
  local i
  for i in $(seq 1 "$GRACE_WAIT"); do
    if port_free "$port"; then
      return 0
    fi
    owner="$(port_owner "$port")"
    case "$owner" in
      '')
        sleep 1
        ;;
      caddy)
        log "порт $port держит прошлый caddy — останавливаю"
        systemctl stop caddy >/dev/null 2>&1 || pkill -x caddy || true
        sleep 1
        ;;
      nginx|apache2|httpd|lighttpd)
        warn "порт $port занят $owner — выключаю его (вернуть: systemctl enable --now $owner)"
        systemctl disable --now "$owner" >/dev/null 2>&1 || pkill -x "$owner" || true
        sleep 1
        ;;
      *)
        warn "порт $port занят процессом «$owner»"
        warn "освободите его или настройте проксирование на 127.0.0.1:$WEB_PORT вручную, затем запустите снова"
        return 1
        ;;
    esac
  done
  warn "порт $port не освободился:"
  ss -ltnpH "sport = :$port" 2>/dev/null >&2 || true
  return 1
}

# --- Caddy --------------------------------------------------------------
if command -v caddy >/dev/null 2>&1; then
  log "Caddy уже установлен: $(caddy version | head -n1)"
else
  log "ставлю Caddy из официального репозитория"
  if command -v apt-get >/dev/null 2>&1; then
    apt-get update -y >/dev/null
    apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl gnupg >/dev/null
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
      | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
      > /etc/apt/sources.list.d/caddy-stable.list
    apt-get update -y >/dev/null
    apt-get install -y caddy || die "Caddy не установился. Смотрите вывод выше"
  else
    die "этот скрипт ставит Caddy через apt. Поставьте Caddy вручную и запустите снова"
  fi
fi

# --- освобождаем порты ---------------------------------------------------
systemctl stop caddy >/dev/null 2>&1 || true
free_port 80 || die "не смог занять порт 80 — без него Let's Encrypt не выдаст сертификат"
free_port 443 || die "не смог освободить порт 443"

# --- конфиг -------------------------------------------------------------
mkdir -p /etc/caddy
if [ -f /etc/caddy/Caddyfile ]; then
  backup="/etc/caddy/Caddyfile.bak.$(date +%s)"
  cp -a /etc/caddy/Caddyfile "$backup"
  log "старый Caddyfile сохранён: $backup"
fi

cat > /etc/caddy/Caddyfile <<EOF
{
    grace_period 5s
}

$HOST {
    reverse_proxy 127.0.0.1:$WEB_PORT
}
EOF
log "Caddyfile: $HOST → 127.0.0.1:$WEB_PORT"

systemctl enable caddy >/dev/null 2>&1 || true
systemctl restart caddy
sleep 4

if ! systemctl is-active --quiet caddy; then
  warn "Caddy не запустился, лог:"
  journalctl -u caddy -n 25 --no-pager || true
  die "см. сообщения выше"
fi

# --- проверка ------------------------------------------------------------
code="$(curl -sk --max-time 25 -o /dev/null -w '%{http_code}' "https://$HOST/" || true)"
if [ "$code" != "200" ]; then
  warn "https://$HOST/ ответил '$code'"
  journalctl -u caddy -n 20 --no-pager || true
  die "сертификат не получен: чаще всего порт 80 закрыт файрволом (или у хостера в панели), либо DNS ещё не обновился — повторите через минуту"
fi
log "https://$HOST/ → 200, сертификат получен"

# --- сообщаем боту -------------------------------------------------------
if [ -f "$APP_DIR/install.sh" ]; then
  log "прописываю адрес боту и перезапускаю сервис"
  bash "$APP_DIR/install.sh" --web-url="https://$HOST"
else
  warn "не нашёл $APP_DIR/install.sh — впишите адрес вручную:"
  warn "  echo 'WEB_PUBLIC_URL=https://$HOST' >> $APP_DIR/.env"
  warn "  systemctl restart telegram-pult"
fi

cat <<EOF

Готово. MiniApp: https://$HOST
Открывать: меню бота в Telegram → «Пульт».
Адрес не меняется, пока не сменится IP сервера. Сменился — запустите скрипт снова.
EOF
