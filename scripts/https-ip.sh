#!/usr/bin/env bash
# HTTPS для MiniApp прямо на IP сервера: бесплатное имя <ip-с-дефисами>.sslip.io,
# настоящий сертификат Let's Encrypt через Caddy. Идемпотентно.
set -euo pipefail

WEB_PORT="${WEB_PORT:-8787}"
APP_DIR="${APP_DIR:-/opt/telegram-pult}"

log()  { printf '%s [https] %s\n' "$(date '+%H:%M:%S')" "$*"; }
warn() { printf '%s [https][warn] %s\n' "$(date '+%H:%M:%S')" "$*" >&2; }
die()  { printf '%s [https][ошибка] %s\n' "$(date '+%H:%M:%S')" "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "нужен root: sudo bash scripts/https-ip.sh"

if ! command -v curl >/dev/null 2>&1; then
  apt-get update -y >/dev/null
  apt-get install -y curl >/dev/null
fi

IP="$(curl -fsS --max-time 10 https://api.ipify.org || true)"
[ -n "$IP" ] || IP="$(curl -fsS --max-time 10 https://ifconfig.me/ip || true)"
[ -n "$IP" ] || die "не смог определить внешний IP (нет выхода в интернет?)"

HOST="$(printf '%s' "$IP" | tr '.' '-').sslip.io"
log "IP сервера: $IP → адрес MiniApp: https://$HOST"

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
    apt-get install -y caddy || die "Caddy не установился. Смотрите вывод выше; альтернатива — nginx + certbot"
  else
    die "этот скрипт ставит Caddy через apt. Поставьте Caddy вручную и запустите снова"
  fi
fi

# --- конфиг -------------------------------------------------------------
mkdir -p /etc/caddy
if [ -f /etc/caddy/Caddyfile ]; then
  backup="/etc/caddy/Caddyfile.bak.$(date +%s)"
  cp -a /etc/caddy/Caddyfile "$backup"
  log "старый Caddyfile сохранён: $backup"
fi

cat > /etc/caddy/Caddyfile <<EOF
$HOST {
    reverse_proxy 127.0.0.1:$WEB_PORT
}
EOF
log "Caddyfile: $HOST → 127.0.0.1:$WEB_PORT"

systemctl enable caddy >/dev/null 2>&1 || true
systemctl restart caddy
sleep 4

# --- проверка -----------------------------------------------------------
listening="$(ss -ltnp 2>/dev/null | grep -cE ':(80|443)\s' || true)"
if [ "${listening:-0}" -eq 0 ]; then
  warn "Caddy не слушает 80/443 — вероятно, порты закрыты файрволом."
  warn "Проверьте: ufw allow 80,443/tcp и правила в панели хостера."
fi

code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 25 "https://$HOST/" || true)"
if [ "$code" != "200" ]; then
  warn "https://$HOST/ ответил '$code'."
  warn "Последние строки журнала Caddy:"
  journalctl -u caddy -n 25 --no-pager >&2 || true
  die "сертификат не получен. Чаще всего: порт 80 закрыт файрволом или имя ещё не разошлось (подождите минуту и запустите снова)"
fi
log "https://$HOST/ → 200, сертификат получен"

# --- сообщаем боту ------------------------------------------------------
if [ -f "$APP_DIR/install.sh" ]; then
  log "прописываю адрес боту и перезапускаю сервис"
  bash "$APP_DIR/install.sh" --web-url="https://$HOST"
else
  warn "$APP_DIR/install.sh не найден — впишите адрес вручную:"
  warn "  echo 'WEB_PUBLIC_URL=https://$HOST' >> $APP_DIR/.env"
  warn "  systemctl restart telegram-pult"
fi

cat <<EOF

Готово. MiniApp: https://$HOST
Открывать: меню бота в Telegram → «Пульт».
Адрес не меняется, пока не сменится IP сервера. Сменился — запустите этот скрипт снова.
EOF
