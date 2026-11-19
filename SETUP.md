# Установка на новый VPS — шпаргалка

По порядку, каждая команда с пояснением. Занимает 10–15 минут.

## 1. Зайти на сервер

```bash
ssh root@IP_НОВОГО_СЕРВЕРА
```
Подключение по SSH под root (пароль из панели хостера или ваш ключ).

## 2. Подготовить систему

```bash
apt-get update && apt-get install -y git curl
```
Обновить список пакетов и поставить git (для клонирования) и curl (скрипт проверяет токен и IP).

## 2.1 Открыть порты для https (если включён ufw)

```bash
ufw allow 80,443/tcp
```
Нужно для Let's Encrypt и MiniApp. Если ufw нет — пропустить. В облаке хостера порты открываются ещё и в панели.

## 3. Скачать проект

```bash
git clone https://github.com/aleksagdrsergeevic-spec/telegram-pult-bot.git
cd telegram-pult-bot
```

## 4. Установить бота

```bash
sudo bash install.sh --token=ТОКЕН_ОТ_BOTFATHER --allowed=ВАШ_CHAT_ID
```

Что делает: ставит Node 20+ и OpenCode (если нет), создаёт пользователя `pult`, кладёт код в `/opt/telegram-pult`, пишет `.env` с токеном, проверяет токен через `getMe`, включает полный доступ OpenCode и поднимает systemd-сервис `telegram-pult`.

Ожидаемо в конце: `токен рабочий, бот: @…` и `сервис telegram-pult запущен`.

## 5. Войти в OpenCode (бесплатные модели)

```bash
pult-opencode auth login
```

Выбрать провайдер **OpenCode**, открыть ссылку в Safari, войти, вернуться в SSH. Без этого бесплатный `opencode/big-pickle` не работает. Логин хранится на сервере — на новом VPS вход нужен заново.

## 6. Проверить, что всё на месте

```bash
pult-opencode models | grep big-pickle
```
Должно вывести `opencode/big-pickle`.

```bash
systemctl status telegram-pult
```
Должно быть `active (running)` (выход — `q`). В Telegram боту: `/start`.

## 7. MiniApp (чат в Telegram)

```bash
sudo bash scripts/https-ip.sh
```

Что делает: определяет внешний IP, собирает имя вида `1-2-3-4.sslip.io`, ставит Caddy, освобождает 80/443, получает сертификат Let's Encrypt, проверяет ответ 200 и прописывает адрес боту.

Ожидаемо: `Готово. MiniApp: https://1-2-3-4.sslip.io`. Открывать: меню бота → «Пульт».

---

# Ежедневное

```bash
cd /root/telegram-pult-bot && git pull && sudo bash install.sh
```
Обновить код до последней версии и перезапустить сервис (`.env` с токеном не перезаписывается).

```bash
systemctl restart telegram-pult
```
Просто перезапуск (снимает зависшие задачи и блокировки папок).

```bash
journalctl -u telegram-pult -n 50 --no-pager
```
Последние 50 строк логов.

```bash
pult-opencode run --model opencode/big-pickle "привет" --auto
```
Проверить OpenCode руками в его домашней папке.

```bash
cd /var/lib/telegram-pult/workspaces/ИМЯ_ПАПКИ && PULT_OC_CWD=$(pwd) timeout 180 pult-opencode run --model opencode/big-pickle "привет"; echo "exit=$?"
```
Проверить задачу в конкретной папке-сессии с ограничением по времени.

# Что где лежит

| Что | Где |
| --- | --- |
| код бота | `/opt/telegram-pult` |
| `.env` с токеном | `/opt/telegram-pult/.env` |
| рабочие папки сессий | `/var/lib/telegram-pult/workspaces` |
| `sessions.json` (выбранная сессия, модели) | `/var/lib/telegram-pult/sessions.json` |
| история переписки | `/var/lib/telegram-pult/history.json` |
| логи | `/var/lib/telegram-pult/logs/pult.log` и `journalctl -u telegram-pult` |
| конфиг прав OpenCode | `/var/lib/telegram-pult/.config/opencode/opencode.json` |

# Полезные переменные в `.env`

```ini
STREAMING=0                              # 1 — показывать шаги агента в Telegram
MODEL=opencode/big-pickle                # модель по умолчанию
IDLE_TIMEOUT_MS=600000                   # стоп задаче, если 10 минут нет вывода
TASK_TIMEOUT_MS=1200000                  # жёсткий предел задачи (20 мин)
HISTORY_LIMIT=200                        # сообщений истории на сессию
WEB_PUBLIC_URL=https://…sslip.io         # адрес MiniApp (ставит scripts/https-ip.sh)
```

После правки `.env`: `systemctl restart telegram-pult`.
