# Автоматизация дача — запуск на NAS

Страница учёта электроэнергии (`index.html`) осталась прежней по возможностям: сводка, участки,
запись показаний, оплата, пароли, тариф. Изменилось место хранения данных: вместо Google Таблицы
и Apps Script они хранятся в базе **PostgreSQL на NAS**.

```
браузер ──► app (Node.js, порт 8095) ──► db (PostgreSQL 16)
                                     └─► backup: копия базы раз в сутки в ./backups (30 дней)
```

## Что в репозитории

| Файл | Назначение |
|---|---|
| `index.html` | Страница. Работает и с NAS, и с GitHub Pages |
| `server/index.js` | Сервер: принимает те же запросы, что раньше принимал Apps Script |
| `server/schema.sql` | Таблицы базы: участки, записи, настройки, журнал изменений |
| `server/migrate.js` | Перенос данных из Google Таблицы |
| `docker-compose.yml`, `Dockerfile` | Стек для Dockge |
| `.env.example` | Образец настроек с паролями |

## 1. Установка через Dockge

1. Скопируйте репозиторий на NAS, например в `/volume1/Docker/dacha`:
   ```bash
   cd /volume1/Docker && git clone -b claude/clever-mendel-c2ct5r https://github.com/deniskoviktor/dacha.git
   ```
2. Создайте `.env` из образца и впишите свои значения (`DB_PASSWORD`, `ADMIN_PASSWORD`, `SESSION_SECRET`):
   ```bash
   cd /volume1/Docker/dacha && cp .env.example .env && nano .env
   ```
3. В Dockge: **Compose → путь `/volume1/Docker/dacha`** (или из консоли `docker compose up -d --build`).
4. Откройте `http://IP-NAS:8095` — должна открыться страница; статус «Обновлено в …».

Таблицы создаются сами при первом запуске.

## 2. Перенос данных из Google Таблицы

Скрипт забирает все участки, записи, коды владельцев и тариф через прежний Apps Script
и сверяет итоговые балансы с таблицей.

```bash
cd /volume1/Docker/dacha
docker compose exec app node migrate.js --url "https://script.google.com/macros/s/AKfycbyBYRqeHlYOqR1iYxL1QpVpuqehvez0qFj0ckCLOG-8Q7us6ie6o2fzcMmVcmozgil4Yw/exec" --dry-run
docker compose exec app node migrate.js --url "https://script.google.com/macros/s/AKfycbyBYRqeHlYOqR1iYxL1QpVpuqehvez0qFj0ckCLOG-8Q7us6ie6o2fzcMmVcmozgil4Yw/exec"
```

Первая команда только показывает, сколько будет перенесено. Повторный перенос поверх уже
заполненной базы — с флагом `--replace`.

Если NAS не достаёт до Google: откройте в браузере адрес Apps Script с `?action=getData`,
сохраните ответ как `data.json` в папку проекта на NAS и выполните:

```bash
docker compose cp data.json app:/tmp/data.json
docker compose exec app node migrate.js --json /tmp/data.json --tariff 36
```

После переноса Google Таблицу лучше не менять — она больше не используется
(оставьте как архив).

## 3. Доступ для владельцев участков

* **Внутри дома (локальная сеть):** `http://IP-NAS:8095`.
* **Снаружи:** нужен HTTPS-адрес NAS. Через обратный прокси (Synology: Панель управления →
  Портал входа → Дополнительно → Обратный прокси) направьте, например, `https://dacha.ваш-домен`
  на `localhost:8095` и выпустите сертификат Let's Encrypt.
* **Страница на GitHub Pages:** впишите внешний адрес в `index.html`:
  `const NAS_API_URL = 'https://dacha.ваш-домен/api';`
  (или администратор указывает его на вкладке «Настройки»). Обычный `http://` с GitHub Pages
  браузер не пропустит — только HTTPS.

## Резервные копии

Сервис `backup` раз в сутки кладёт `dacha_ГГГГ-ММ-ДД_ЧЧММ.sql.gz` в `./backups`, хранит 30 дней.
Восстановление:

```bash
gunzip -c backups/dacha_2026-11-26_0300.sql.gz | docker compose exec -T db psql -U dacha dacha
```

## Что поменялось по сравнению с Google Таблицей

* Пароль администратора больше не записан в коде страницы — он в `.env` на NAS.
* Коды владельцев видит только администратор (раньше их можно было увидеть в ответе таблицы).
* Сервер сам проверяет права: владелец пишет только по своему участку и не может менять
  цену и предыдущее показание; баланс считается на сервере.
* После 10 неверных кодов вход с этого адреса блокируется на 15 минут.
* Все изменения записываются в таблицу `audit_log` (кто, когда, что).
* Вход действует 12 часов (`SESSION_HOURS` в `.env`), потом нужно ввести код снова.
