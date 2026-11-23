# Розгортання та обслуговування

## Push для Android

Для FCM задайте `FCM_PROJECT_ID` і `FCM_CREDENTIALS_FILE` в локальному `.env` та додайте `-f deploy/compose.fcm.yaml` до чинної команди Compose. Файл ключа облікового запису має лежати поза репозиторієм. Він монтується в контейнер для читання користувачем застосунку. Для надсилання потрібен дозвіл `cloudmessaging.messages.create` у проєкті Firebase.

Сервер перевіряє стабільні Android-релізи на GitHub кожні 30 хвилин, якщо налаштовано FCM. Перший знайдений тег із готовим APK зберігається в `DATA_DIR/android-release-push.txt`. Після виходу нової версії сервер надсилає її тег у FCM-тему `app-updates`.

## Звичайний Docker Compose

```sh
git clone https://github.com/Daniell2019UKR/esvitlo.git
cd esvitlo
cp .env.example .env
docker compose up -d --build
```

Перед запуском заповніть локальний `.env`. Параметр `REGION` задає регіон за замовчуванням, наприклад `o` або `mykolaiv`. Сервер перевіряє весь каталог і зберігає стан кожного регіону у файлі `state-<code>.json`. Див. [покриття та джерела](../README.md#покриття-та-джерела).

Застосунок запускається непривілейованим користувачем `node`. Стандартний том `schedule-data` зберігає стан у `/app/data`. Якщо замінюєте том bind mount, забезпечте право запису користувачеві контейнера; не використовуйте `chmod 777` як спосіб налаштування сховища.

```sh
docker compose ps
docker compose logs --tail 100 web
curl -f http://localhost:3000/health
curl -f http://localhost:3000/api/v1/regions
curl -i 'http://localhost:3000/api/v1/schedules?region=mykolaiv'
```

`/health` перевіряє HTTP-сервер. Актуальність графіка визначайте окремо за `lastSuccess`, `checkedAt` та повідомленням про помилку у відповіді API.

## Домашнє розгортання

Публічний сайт має адресу https://yesvitlo.pp.ua/. Caddy та вебконтейнер використовують спільну Docker-мережу `dtek-ingress`. Застосунок слухає порт 3000 всередині Docker.

У серверному `.env` задайте `PUBLIC_URL=https://yesvitlo.pp.ua` та `DTEK_DATA_PATH` зі шляхом до постійних даних.

```sh
docker network create dtek-ingress
docker network connect dtek-ingress caddy
docker compose -p dtek-monitor -f compose.yaml -f deploy/compose.server.yaml -f deploy/compose.caddy.yaml up -d --build
```

Додайте мережу `dtek-ingress` до конфігурації Compose Caddy як зовнішню мережу, щоб підключення збереглося після перестворення контейнера. Використайте [фрагмент Caddyfile](../deploy/dtek.Caddyfile) і перевірте конфігурацію перед її застосуванням. Якщо використовуєте VPN, додавайте також `-f deploy/compose.vpn.yaml` перед командою `up`.

## Telegram

1. Створіть бота у [BotFather](https://t.me/BotFather) або використайте токен свого існуючого бота.
2. Збережіть токен у `TELEGRAM_BOT_TOKEN` серверного `.env`.
3. Перестворіть контейнер: `docker compose up -d` із тими самими `-p` та `-f`, які використовували для запуску.
4. Відкрийте бота й надішліть `/start`.

Не запускайте два екземпляри цього застосунку з одним ботом: вони конкуруватимуть за отримання Telegram updates. Також переконайтеся, що цього бота не обслуговує інша програма.

## Необов'язковий PPTP VPN

Додатковий Compose-файл [deploy/compose.vpn.yaml](../deploy/compose.vpn.yaml) запускає `vpn-proxy` в окремому контейнері. Застосунок надсилає через нього лише запити до джерела, вибрані для VPN-маршруту; системний маршрут за замовчуванням хоста не змінюється. Telegram і клієнтський API не потребують цього проксі.

На хості має бути доступний `/dev/ppp` і підтримка PPTP/PPP у ядрі. Сервісу VPN потрібен `NET_ADMIN` у його власному мережевому просторі. Це не привілей для основного контейнера `web`.

У корені проєкту скопіюйте [.env.vpn.example](../.env.vpn.example) у локальний `.env.vpn` та заповніть його. `PPTP_SERVER` має містити IPv4-адресу сервера:

```dotenv
PPTP_SERVER=YOUR_VPN_IPV4
PPTP_USERNAME=YOUR_VPN_USERNAME
PPTP_PASSWORD=YOUR_VPN_PASSWORD
```

Обмежте доступ: `chmod 600 .env.vpn`. Цей файл містить реальні облікові дані, тому він не має потрапляти у Git, README або скриншоти журналів.

```sh
cp .env.vpn.example .env.vpn
# Заповніть .env.vpn перед запуском.
chmod 600 .env.vpn
docker compose -f compose.yaml -f deploy/compose.vpn.yaml build
docker compose -f compose.yaml -f deploy/compose.vpn.yaml create vpn-proxy
sudo python3 deploy/vpn/setup-host.py --env-file .env.vpn --network dtek-schedule_default
docker compose -f compose.yaml -f deploy/compose.vpn.yaml up -d
```

У цьому прикладі каталог клонування називається `dtek-schedule`, тому стандартна мережа Compose — `dtek-schedule_default`. Якщо project name інший, передайте його фактичну мережу у `--network`; не змінюйте project name чинної установки лише для збігу з прикладом.

Для домашнього сервера, де вже підготовлений `compose.server.yaml`:

```sh
docker compose -p dtek-monitor -f compose.yaml -f compose.server.yaml -f deploy/compose.vpn.yaml build
docker compose -p dtek-monitor -f compose.yaml -f compose.server.yaml -f deploy/compose.vpn.yaml create vpn-proxy
sudo python3 deploy/vpn/setup-host.py --env-file .env.vpn --network dtek-monitor_default
docker compose -p dtek-monitor -f compose.yaml -f compose.server.yaml -f deploy/compose.vpn.yaml up -d
docker compose -p dtek-monitor -f compose.yaml -f compose.server.yaml -f deploy/compose.vpn.yaml ps
docker compose -p dtek-monitor -f compose.yaml -f compose.server.yaml -f deploy/compose.vpn.yaml logs --tail 50 vpn-proxy
```

### Підготовка хоста для PPTP через Docker NAT

[deploy/vpn/setup-host.py](../deploy/vpn/setup-host.py) запускається від root **після створення мережі Compose**, до запуску VPN або перед його повторним стартом. Скрипт завантажує модулі `ppp_async`, `ppp_mppe`, `nf_conntrack_pptp`, `nf_nat_pptp` та додає PPTP connection-tracking helper для Docker NAT.

Правило обмежене підмережею вибраної мережі Docker, точною IPv4-адресою PPTP-сервера з `.env.vpn` і TCP-портом `1723`. Скрипт перевіряє наявність правила й не додає повторний екземпляр. Глобальне ввімкнення helper для всього трафіку не потрібне; маршрути хоста не змінюються. Контейнери запускаються без `--privileged`.

Якщо VPN уже стартував до підготовки NAT helper, виконайте скрипт і перезапустіть лише `vpn-proxy` з тими самими Compose-файлами:

```sh
sudo python3 deploy/vpn/setup-host.py --env-file .env.vpn --network dtek-monitor_default
docker compose -p dtek-monitor -f compose.yaml -f compose.server.yaml -f deploy/compose.vpn.yaml restart vpn-proxy
```

Модулі й правило helper потрібно відновлювати після перезавантаження хоста. У домашньому розгортанні для цього налаштований systemd-сервіс. На іншому сервері додайте аналогічний запуск цього скрипту після старту Docker та появи потрібної мережі; якщо змінили підмережу чи PPTP-сервер, перевірте правило заново.

Шляхи додаткових Compose-файлів обчислюються від каталогу першого `compose.yaml`. VPN override сам задає адреси проксі для `web`; вручну переносити їх у `.env` для такого запуску не потрібно.

Маршрути всередині Compose:

| Адреса | Призначення |
| --- | --- |
| `http://vpn-proxy:8888` | HTTP-проксі, який використовує `DTEK_PROXY_URL`. |
| `http://vpn-proxy:8889/health` | Перевірка доступності VPN для `DTEK_PROXY_HEALTH_URL`. |

Ці порти призначені для внутрішньої мережі Docker. Не публікуйте VPN-проксі як відкритий проксі в Інтернеті.

При налаштованому й доступному VPN сервер чергує прямий маршрут і VPN. Цикл регіонів ДТЕК запускається кожні `DTEK_POLL_INTERVAL_SECONDS` (типово п'ять хвилин). За нормальної роботи кожен із двох маршрутів використовується приблизно раз на десять хвилин.

Для кожної дати сервер звіряє час публікації графіка із збереженою версією. Відхилення та зміни записуються в Docker-журнал разом із маршрутом. Зміна або зняття попередження оператора потребує двох послідовних збіжних перевірок.

Якщо перевірка здоров'я VPN не проходить або тунель падає, VPN виключається з поточних спроб до перевірки відновлення. У цей час сервер отримує графіки прямим маршрутом. Якщо сам запит ДТЕК через VPN завершується помилкою, цей цикл повторюється напряму, а VPN позначається недоступним. `VPN_RETRY_SECONDS`, типово `60` і не менше `10`, задає паузу перед повторною перевіркою. Відновлення тунелю повертає VPN у чергування; строгого чергування IP під час аварії немає.

Стан `healthy` означає не лише наявність інтерфейсу PPP: VPN-контейнер також перевіряє вихід в Інтернет через прив'язаний до тунелю проксі. Його внутрішній health API повертає `healthy`, `checkedAt` та `egressIp`. Якщо тунель зникає, проксі зупиняється, а не переходить непомітно на прямий вихід контейнера.

Базовий і VPN Compose-файли потрібно передавати разом; для домашнього сервера додається також серверний override. Після запуску перевірте стан `vpn-proxy`, його healthcheck і журнали, а потім успішний час отримання графіка в API. У журналах не повинно бути пароля PPTP чи Telegram-токена.

```sh
docker compose -f compose.yaml -f deploy/compose.vpn.yaml exec vpn-proxy curl --fail --silent http://127.0.0.1:8889/health
```

У домашній установці додайте до цієї команди ті самі `-p dtek-monitor -f compose.server.yaml`, які використали для запуску.

## Оновлення

Перед оновленням зробіть резервну копію `.env` і каталогу даних. Далі оновіть код та зберіть контейнер з тими самими Compose project і конфігураційними файлами:

```sh
git pull --ff-only
docker compose up -d --build
docker compose ps
docker compose logs --tail 50 web
```

Для домашнього розгортання використовуйте `docker compose -p dtek-monitor -f compose.yaml -f compose.server.yaml` замість короткого `docker compose`. Зміна project name може створити інший том і виглядати як втрата даних, хоча старий том залишиться.

Для приватного репозиторію `git pull` потребує окремої авторизації GitHub на сервері. Альтернатива — доставити перевірений реліз із робочого комп'ютера; не додавайте GitHub-токен у код, Dockerfile або образ.

## Резервне копіювання

Потрібно зберегти:

- локальний `.env` і VPN-секрети, якщо VPN налаштований;
- увесь каталог `DATA_DIR` / том `schedule-data`;
- коміт або тег версії застосунку;
- власні Compose override і конфігурацію reverse proxy.

Для узгодженої копії файлів стану коротко зупиніть контейнер застосунку, скопіюйте каталог даних і запустіть контейнер знову. Зберігайте резервні копії з обмеженим доступом: вони можуть містити Telegram chat IDs та підписки.

## Якщо графік не оновлюється

| Симптом | Що перевірити |
| --- | --- |
| Сайт не відкривається | `docker compose ps`, порт хоста, DNS, reverse proxy. |
| `/health` відповідає, але дані старі | `error` і часи у `/api/schedule`, журнали `web`, доступ контейнера до джерела. |
| Немає графіка на завтра | Чи опублікований добовий графік на джерелі. Відсутність публікації не означає відсутність відключень. |
| Бот мовчить | Токен у серверному `.env`, `/start` у чаті, збережена підписка, відсутність другого отримувача updates. |
| Немає картинки | Журнали Telegram, запуск Chromium, доступність `/dev/shm`; стандартний Compose задає `shm_size: 256mb`. |
| Помилка запису стану | Наявність і права каталогу даних, вільне місце на диску. |

Не вимикайте перевірку TLS для усунення мережевих помилок. Якщо середовище використовує власний HTTPS-проксі та CA, передайте довірений CA через конфігурацію Node/контейнера.
