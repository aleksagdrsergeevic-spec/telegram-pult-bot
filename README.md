# Telegram-пульт для OpenCode

Бот для Telegram, который живёт на VPS и кодит за вас: пишете задачу с iPhone в Telegram, а OpenCode выполняет её на сервере в нужной папке.

Репозиторий: `github.com/aleksagdrsergeevic-spec/telegram-pult-bot` (публичный).

Шпаргалка команд для установки на новый сервер: [SETUP.md](SETUP.md).

- Long polling (`getUpdates`, timeout 25) — вебхук не нужен, порты наружу не открываются.
- Белый список по chat id: чужим бот отвечает отказом.
- Модель по умолчанию — `opencode/big-pickle` (Big Pickle, бесплатная в OpenCode Zen), меняется переменной `MODEL`.
- Сессия = рабочая папка внутри `WORKSPACES_DIR` + своя сессия OpenCode (`--continue` / `--session <id>`).
- Ответ агента стримится в одно сообщение с редактированием не чаще раза в 1.2 с (по умолчанию стриминг выключен: в чат идёт «работаю…» и итог, включается `STREAMING=1`).
- Задача ограничена 20 минутами, `/stop` убивает процесс вместе с дочерними.
- Работа от отдельного пользователя `pult`, systemd с автоперезапуском, логи в файл с ротацией по размеру.
- OpenCode получает полный доступ сразу: команды, правки файлов и загрузки выполняются без запросов подтверждений.
- История переписки хранится по сессиям в `history.json` и подгружается в MiniApp при открытии и смене папки.

## Что нужно

1. VPS с Ubuntu/Debian (CentOS/Rocky тоже подойдут) и root-доступом.
2. Токен бота от [@BotFather](https://t.me/BotFather).
3. Ваш chat id — бот покажет его в ответ на любое сообщение.

## Шаг 1. Создать бота

1. Откройте @BotFather → `/newbot` → имя и username.
2. Скопируйте токен вида `123456789:AAH...`.

## Шаг 2. Развернуть на VPS

Руками OpenCode ставить не нужно: `install.sh` сам проверяет Node 20+, `opencode --version` и, если чего-то нет, устанавливает. Уже установленное не переустанавливается.

Всё делает один идемпотентный скрипт: ставит Node 20+ (если нет), ставит `opencode` (если нет), создаёт пользователя `pult`, раскладывает файлы, создаёт `.env`, регистрирует и запускает systemd-сервис.

### Пошагова́я установка с телефона (SSH-приложение)

Что происходит: на сервер кладётся код бота и запускается `install.sh`. Он сам поставит Node, OpenCode, создаст пользователя `pult`, пропишет токен, настроит автозапуск. От вас нужны только команды ниже.

**1. Подключиться к серверу.** В Termius/Blink новый хост: адрес — IP из панели хостера, пользователь — `root`, пароль — из панели. Должно появиться приглашение вида `root@vps:~#`.

**2. Подготовить сервер** (одна строка, минута):

```bash
apt-get update && apt-get install -y git curl
```

**3. Склонировать проект** (репозиторий публичный, ни ключей, ни паролей не нужно):

```bash
git clone https://github.com/aleksagdrsergeevic-spec/telegram-pult-bot.git
cd telegram-pult-bot
```

**4. Запустить установку** (2–5 минут, в конце должна быть строка «токен рабочий, бот: @…»):

```bash
sudo bash install.sh --token=ВАШ_ТОКЕН --allowed=ВАШ_CHAT_ID
```

**5. Войти в OpenCode** — без этого не будет бесплатных моделей:

```bash
pult-opencode auth login
```

(эту команду ставит `install.sh`; она сама заходит под пользователем `pult` в его папку)

В списке выберите провайдер **OpenCode**, появится ссылка и код — откройте ссылку в Safari, войдите и вернитесь в SSH. Проверка:

```bash
pult-opencode models | grep big-pickle
```

Должно вывести `opencode/big-pickle`.

**6. Проверить сервис:**

```bash
systemctl status telegram-pult
```

Нужно `active (running)`. Логи: `journalctl -u telegram-pult -n 50 --no-pager`.

**7. Telegram:** боту `/start`, затем `/new my-project` — и пишите задачу обычным текстом.

Если на каком-то шаге ошибка:

- `не задан TELEGRAM_BOT_TOKEN` — токен не попал в `/opt/telegram-pult/.env`; впишите и `systemctl restart telegram-pult`.
- `EACCES: permission denied, lstat '/root/...'` — команда `runuser ... opencode` запущена из `/root`, куда у `pult` нет доступа. Используйте `pult-opencode auth login` (она сама делает `cd` в домашнюю папку `pult`) или сначала `cd /var/lib/telegram-pult`.
- `opencode: command not found` — `npm i -g opencode-ai@latest`, затем `systemctl restart telegram-pult`.
- В `/model` нет моделей `opencode/*` — не выполнен шаг 5 (`opencode auth login`).

**Способ А. С компьютера или из веб-консоли хостера** (репозиторий уже на машине):

```bash
chmod +x install.sh
sudo bash install.sh
```

Всё встанет в `/opt/telegram-pult`, данные — в `/var/lib/telegram-pult`.

**Способ Б. С любого места — deploy.sh сам подключается к VPS по SSH** (это и есть «автоматически подключается к моему VPS»):

```bash
# один раз: создать ключ и показать публичную часть
./deploy.sh --bootstrap-key
# добавить показанный ключ на сервер (панель хостера → SSH keys, либо ~/.ssh/authorized_keys)

# дальше — одной командой
./deploy.sh --host 203.0.113.10 --user root --token
```

`--token` без значения спросит токен скрытым вводом и передаст его на сервер в `.env`. Пароль вместо ключа: `--password` (нужен `sshpass`).

Токен бота, ваш chat id и модель можно один раз положить в файл `.env` в корне проекта (он в `.gitignore`, на сервер не копируется) — тогда `deploy.sh` возьмёт их сам и хватит одной команды `./deploy.sh --host <ip>`. Аргументы `--token`, `--allowed`, `--model` всегда важнее файла. Там же можно держать `VPS_HOST`, `VPS_USER`, `VPS_PORT` и `VPS_KEY`, чтобы команда была совсем короткой: `./deploy.sh`.

Полезное:

```bash
./deploy.sh --host <ip> --status     # состояние сервиса
./deploy.sh --host <ip> --logs       # журнал
./deploy.sh --host <ip> --restart    # перезапуск
./deploy.sh --host <ip> --check      # node/opencode/git/сервис/модель
./deploy.sh --host <ip> --wait 300   # сначала дождаться, что VPS поднялся, потом деплой
```

Повторный деплой — обычное обновление: файлы перезаливаются, `.env` не перезаписывается.

**Способ В. Автодеплой из GitHub.** В репозитории лежит `.github/workflows/deploy.yml`: каждый push в `main` сам заходит на VPS по SSH и прогоняет `install.sh`.

Добавьте в GitHub → Settings → Secrets and variables → Actions:

- `VPS_HOST` — IP или домен
- `VPS_USER` — обычно `root`
- `VPS_SSH_KEY` — приватный ключ (содержимое `~/.ssh/telegram-pult_ed25519`)
- `VPS_PORT` — по желанию, по умолчанию 22
- `TELEGRAM_BOT_TOKEN` — по желанию, попадёт в `.env` первого деплоя
- `ALLOWED_CHAT_IDS` — по желанию

## Шаг 3. Настроить .env

Файл: `/opt/telegram-pult/.env` (права 600, владелец `pult`).

```ini
TELEGRAM_BOT_TOKEN=123456789:AAH...
ALLOWED_CHAT_IDS=111222333
MODEL=opencode/big-pickle
STREAMING=0
```

`STREAMING=0` — в чат приходит только «⏳ работаю…» (обновляется раз в минуту) и итоговый ответ. Поставьте `STREAMING=1`, если хотите видеть, что OpenCode делает по ходу.

Если токен передан через `deploy.sh --token`, менять нужно только `ALLOWED_CHAT_IDS`:

```bash
nano /opt/telegram-pult/.env
systemctl restart telegram-pult
```

Свой chat id узнать просто: напишите боту что угодно — он ответит «Доступ запрещён» и покажет id.

## Шаг 4. Первый запуск

```bash
systemctl status telegram-pult
journalctl -u telegram-pult -n 50 --no-pager
```

В Telegram: `/start` → `/new my-project` → пишете задачу.

## MiniApp: чат с OpenCode внутри Telegram

Кроме бота есть MiniApp — веб-чат, который открывается кнопкой в меню бота: живой поток ответа, выбор папки-сессии, выбор модели, кнопка «стоп».

Как устроено:

- Тот же процесс бота поднимает HTTP-сервер (`WEB_HOST`/`WEB_PORT`, по умолчанию `127.0.0.1:8787`) и отдаёт `web/index.html`.
- Авторизация — по `Telegram.WebApp.initData` с проверкой подписи HMAC-SHA256 токеном бота, плюс сверка с `ALLOWED_CHAT_IDS`. Чужой не зайдёт даже зная адрес.
- Поток ответа идёт через SSE (`/api/stream`), задачи выполняются тем же `opencode run` через общую очередь и блокировку рабочей папки, что и в боте.
- Список папок (`/api/session`), модели (`/api/models`, `/api/model`), стоп (`/api/stop`).
- История: каждый запрос и ответ (и из Telegram, и из MiniApp) пишется в `history.json` по сессии, в интерфейсе показываются последние 100 сообщений. Файл: `/var/lib/telegram-pult/history.json`, ограничение `HISTORY_LIMIT` (200 сообщений на сессию по умолчанию).
- Индикатор в шапке: зелёный кружок — задача выполняется (рядом таймер и время тишины), красный — простоя. Сообщения, отправленные во время работы, встают в очередь (до 10) и выполняются по одному; «стоп» очищает очередь.
- Вложения: в MiniApp — кнопка 📎 (до 4 картинок), в Telegram — просто отправьте фото или картинку файлом, с подписью или без. Файл сохраняется в `UPLOADS_DIR`, а в промпт подставляется путь с просьбой открыть его через `read`. Задачи с картинками идут на модели из `IMAGE_MODEL` (если она задана), потому что не все модели умеют смотреть изображения — `big-pickle` точно не умеет.

Telegram открывает MiniApp только по **https**. Наружу порт бота светить не нужно — поставьте перед ним HTTPS-прокси.

**Вариант без домена — https прямо на IP (sslip.io).** Let's Encrypt не выдаёт сертификаты на голый IP, но есть бесплатный DNS: имя `1-2-3-4.sslip.io` указывает на `1.2.3.4`. Своего IP не покупаете, сертификат настоящий.

Всё делает один скрипт:

```bash
cd /root/telegram-pult-bot && git pull
sudo bash scripts/https-ip.sh
```

Он сам определит внешний IP, поставит Caddy из официального репозитория, освободит порты 80/443 (останавливает прошлый Caddy, а если там висит nginx/apache — выключает его), напишет `Caddyfile`, получит сертификат, проверит `https://…/` и прописывает адрес боту (`install.sh --web-url`).

Требование одно: порты 80 и 443 должны быть открыты (`ufw allow 80,443/tcp`, если ufw включён; у хостера — в облачном файрволе). Если скрипт ругается на код ответа — смотрите `journalctl -u caddy -n 30 --no-pager`.

Ручной вариант того же самого:

```bash
apt-get install -y caddy
IP=$(curl -s https://api.ipify.org)
HOST="$(printf '%s' "$IP" | tr '.' '-').sslip.io"
printf '%s {\n    reverse_proxy 127.0.0.1:8787\n}\n' "$HOST" > /etc/caddy/Caddyfile
systemctl restart caddy
curl -I "https://$HOST/"
sudo bash install.sh --web-url="https://$HOST"
```

**Вариант с доменом (Caddy):**

```bash
apt-get install -y caddy
cat > /etc/caddy/Caddyfile <<'EOF'
pult.example.com {
    reverse_proxy 127.0.0.1:8787
}
EOF
systemctl restart caddy
```

**Вариант без домена (Cloudflare Tunnel):**

```bash
cloudflared tunnel --url http://127.0.0.1:8787
```

Возьмите выданный `https://…trycloudflare.com` адрес, впишите его в `.env` и перезапустите сервис:

```ini
WEB_PUBLIC_URL=https://pult.example.com
```

```bash
systemctl restart telegram-pult
```

Если `WEB_PUBLIC_URL` задан, бот сам ставит кнопку «Пульт» в меню (Telegram `setChatMenuButton`) — в логе будет «кнопка MiniApp установлена в меню бота». Открывать: меню бота → «Пульт», либо ссылкой `t.me/<бот>?startapp`.

## Команды в Telegram

| Команда | Что делает |
| --- | --- |
| `/sessions` | список сессий с инлайн-кнопками, переключение |
| `/new <имя>` | новая рабочая папка |
| `/new <git-url>` | папка + `git clone --depth 1` |
| `/use <имя>` | переключить текущую сессию |
| `/status` | сессия, путь, модель, идущая задача, аптайм |
| `/stop` | убить процесс задачи |
| `/model` | текущая модель и список доступных |
| `/help`, `/start` | справка и chat id |

Любой другой текст — задача для OpenCode в текущей папке.

## Как выполняется задача

```
opencode run --model opencode/big-pickle [--continue | --session <id>] "<текст задачи>"
```

- Промпт передаётся одним аргументом через `spawn`, без `shell` — инъекции через текст невозможны.
- Каждая задача — отдельный процесс `opencode run` (поэтому «работаю…», а не «запускаю OpenCode»: процесс живёт только на время задачи и продолжает выбранную сессию).
- В тихом режиме итог фильтруется от служебных строк-рамок OpenCode, а промежуточные шаги в чат не отправляются.
- `cwd` — папка сессии; путь проверяется, что он внутри `WORKSPACES_DIR`.
- `install.sh` проверяет `opencode run --help` и пишет в лог, есть ли `--session`, `--continue`, `--model`. Если `--session` есть — бот хранит id сессии (`ses_...`) в `sessions.json`; иначе работает `--continue`.
- Если сохранённая сессия OpenCode пропала, бот честно сообщает в лог и один раз перезапускает задачу с нуля.

## Модель

`opencode/big-pickle` — Big Pickle, бесплатная модель OpenCode Zen (по документации opencode.ai она бесплатна ограниченное время, и её провайдер может использовать данные для улучшения модели).

Провайдер `opencode` появляется только после входа в аккаунт OpenCode:

```bash
pult-opencode auth login
```

Тогда же стоит проверить список: `pult-opencode models`.

Если Big Pickle станет платным или исчезнет, в `.env` можно поставить другую бесплатную модель из того же каталога (например `opencode/iceman-free` или `opencode/deepseek-v4.1-flash-free`), а также любую платную с вашим ключом провайдера.

## Безопасность

- Бот работает не от root: systemd-юнит запускает его от пользователя `pult`.
- **OpenCode работает с полным доступом:** `install.sh` (и бот при старте) кладут конфиг `~/.config/opencode/opencode.json` с `allow` на все действия, включая `external_directory`, и задачи запускаются с флагом `--auto`, если CLI его поддерживает. Агент может выполнять любые команды и читать/править любые файлы, доступные пользователю `pult`, без подтверждений. Это то, что нужно для работы «с телефона без кнопок», но и цена соответствующая: доверяйте задачам, которые отправляете.
- Доступ только для chat id из `ALLOWED_CHAT_IDS` (пусто = отказ всем).
- Никаких shell-строк с текстом пользователя; `git clone` и `opencode` вызываются с массивом аргументов.
- Имена сессий валидируются (`[A-Za-z0-9._-]`, до 64 символов, без `..` и `/`), итоговый путь сверяется с `WORKSPACES_DIR`.
- Лимит длины задачи — `PROMPT_MAX_LENGTH` (4000), таймаут задачи — `TASK_TIMEOUT_MS` (20 минут).
- `.env` не попадает в git; токен не передаётся аргументами командной строки на сервер (он идёт через `.env.deploy`, который install.sh переносит в `.env` и удаляет).
- Логи: `/var/lib/telegram-pult/logs/pult.log`, ротация по 5 МБ, 3 архива.

## Диагностика

**409 Conflict: terminated by other getUpdates request.** Бот запущен дважды. Проверьте: `systemctl status telegram-pult` и `pgrep -af src/bot.js`. Один процесс оставьте, остальные убейте. Сам бот на 409 не падает, ждёт 15 секунд и продолжает.

**Сервис перезапускается в цикле.** Так задумано: `Restart=always`. Если в журнале «не задан TELEGRAM_BOT_TOKEN», бот выходит с кодом 78 и systemd его не поднимает — впишите токен в `.env` и выполните `systemctl restart telegram-pult`.

**`opencode: command not found`.** `npm i -g opencode-ai@latest` (или `@opencode/cli@latest`), затем `systemctl restart telegram-pult`.

**Задача висит без вывода.** Проверьте, что модель доступна: `/model`. 20 минут — жёсткий предел, дальше процесс убивается, а бот пишет таймаут. Плюс есть сторож тишины: если OpenCode не выдал ни строки за `IDLE_TIMEOUT_MS` (по умолчанию 10 минут), задача останавливается с понятным сообщением — это обычно значит, что не выполнен вход (`pult-opencode auth login`) и процесс ждёт интерактивного подтверждения.

**«Работаю», но ничего не происходит и стоп пишет «нечего останавливать».** Запрос стоит в очереди на занятую папку: предыдущая задача держит блокировку. Проверьте `journalctl -u telegram-pult -n 50 --no-pager | grep -iE "блокировка|opencode run|молчит"`. Зависшая блокировка снимается сама через `TASK_TIMEOUT_MS + 2 мин`, а перезапуск сервиса снимает все разом: `systemctl restart telegram-pult`.

**Сервер пропал / переехал.** Запустите `./deploy.sh --host <новый ip>` — скрипт идемпотентный, всё поднимет. Если сервер перезагружается, `--wait 300` подождёт и дождётся.

### Если VPS ещё нет

Бота можно поставить на любую машину с systemd и интернетом: Oracle Cloud Always Free, Hetzner, Timeweb, любой VPS за пару долларов. Минимум — 1 vCPU / 1 ГБ RAM для самого пульта (OpenCode с тяжёлыми сборками любит больше). После создания сервера добавьте SSH-ключ из `./deploy.sh --bootstrap-key` в панели хостера и выполните `./deploy.sh --host <ip>`.

## Структура

```
src/bot.js        — polling, whitelist, очередь на чат, команды, стриминг
src/telegram.js   — Bot API на fetch, ретраи, 429/409
src/sessions.js   — рабочие папки, clone, sessions.json, проверки путей
src/opencode.js   — spawn opencode run, флаги, таймаут, kill дерева процессов
src/config.js     — .env без зависимостей
src/logger.js     — лог в файл с ротацией по размеру
install.sh        — идемпотентная установка на сервере
deploy.sh         — подключение к VPS по SSH и деплой
```

Зависимостей нет: только Node 20+ и встроенный `fetch`.

## Проверки, которые делает install.sh

- `node -v` ≥ 20, иначе ставит Node через NodeSource.
- `opencode --version`; если нет — `npm i -g @opencode/cli@latest`, при неудаче `opencode-ai@latest`.
- `opencode run --help` → в лог пишется, какие флаги доступны.
- `opencode models` → есть ли `MODEL` в списке; если нет — подсказка про `opencode auth login`.
- `git --version`.
- `getMe` у Telegram → в лог пишется имя бота, а при плохом токене — предупреждение.
- конфиг прав OpenCode → `~/.config/opencode/opencode.json` с полным доступом (старая копия сохраняется в `.bak`).
