# Тесты

Запускаются на **тестовой копии** (никогда не на рабочей базе): отдельный стак с копией базы из `backups/`,
порт 8097, `ADMIN_PASSWORD=9999`, одному участку («Вадим В.») выставлен код `1111`.

* `api.test.mjs` — сервер (26 проверок): правила показаний и оплаты, права владельца/администратора,
  скрытие телефонов, совместимость со старой страницей, блокировка подбора кода.
  `docker cp tests/api.test.mjs <app>:/tmp/ && docker exec <app> node /tmp/api.test.mjs http://127.0.0.1:8080/api`
* `run-on-nas.sh` — всё сразу: `sudo sh tests/run-on-nas.sh <код> <рабочий стек>`.
* `ui.test.mjs` — интерфейс в Chromium (28 проверок): iPhone 13 и компьютер, вход, показания с оплатой 0,
  пополнение, история, XSS, горизонтальная прокрутка.
  `docker run --rm --network host -v $PWD/tests:/t -v /tmp/out:/out -w /t mcr.microsoft.com/playwright:v1.49.1-noble sh -c "npm i playwright@1.49.1 && node ui.test.mjs http://127.0.0.1:8097/"`
