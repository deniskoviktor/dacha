#!/bin/sh
# Полная проверка на ТЕСТОВОЙ копии (рабочая база не затрагивается). Запуск на NAS от root:
#   sh tests/run-on-nas.sh /путь/к/коду  /путь/к/рабочему/стеку
# Поднимает стек dacha-test (порт 8097) с копией последней резервной копии, гоняет api- и ui-тесты, удаляет стек.
set -e
SRC=${1:-.}; PROD=${2:-/share/Docker/DockgeD/opt_stacks/dacha}; T=/volume1/Docker/dacha-test; OUT=${OUT:-/tmp/dacha-ui-out}
rm -rf $T && mkdir -p $T $OUT && cp -r $SRC/. $T/ && rm -rf $T/.git $T/data $T/backups $T/.env
printf 'DB_PASSWORD=test-%s\nADMIN_PASSWORD=9999\nSESSION_SECRET=%s\nAPP_PORT=8097\nTZ=Asia/Almaty\n' "$(date +%s)" "$(date +%s%N)" > $T/.env
cd $T && docker compose -p dacha-test up -d --build db app >/dev/null 2>&1
for i in $(seq 1 30); do curl -sf http://127.0.0.1:8097/healthz >/dev/null && break; sleep 2; done
docker compose -p dacha-test exec -T db psql -q -U dacha dacha -c "TRUNCATE records, plots, audit_log RESTART IDENTITY CASCADE" >/dev/null
B=$(ls -t $PROD/backups/*.sql.gz | head -1); echo "копия базы: $B"
gunzip -c "$B" | docker compose -p dacha-test exec -T db psql -q -U dacha dacha >/dev/null 2>&1 || true
docker compose -p dacha-test exec -T db psql -q -U dacha dacha -c "UPDATE plots SET password='1111' WHERE name LIKE 'Вадим В.%'" >/dev/null
docker restart dacha-test-app-1 >/dev/null; sleep 4
echo "=== API ==="; docker cp $T/tests/api.test.mjs dacha-test-app-1:/tmp/ && docker exec dacha-test-app-1 node /tmp/api.test.mjs http://127.0.0.1:8080/api; A=$?
# база заново для UI
docker compose -p dacha-test exec -T db psql -q -U dacha dacha -c "TRUNCATE records, plots, audit_log RESTART IDENTITY CASCADE" >/dev/null
gunzip -c "$B" | docker compose -p dacha-test exec -T db psql -q -U dacha dacha >/dev/null 2>&1 || true
docker compose -p dacha-test exec -T db psql -q -U dacha dacha -c "UPDATE plots SET password='1111' WHERE name LIKE 'Вадим В.%'" >/dev/null
docker restart dacha-test-app-1 >/dev/null; sleep 4
echo "=== UI ==="; docker run --rm --network host --ipc=host -v $T/tests:/t -v $OUT:/out -w /tmp mcr.microsoft.com/playwright:v1.49.1-noble sh -c "npm i --silent playwright@1.49.1 >/dev/null 2>&1; cp /t/ui.test.mjs . && node ui.test.mjs http://127.0.0.1:8097/"; U=$?
docker compose -p dacha-test down -v >/dev/null 2>&1; cd / && rm -rf $T
echo "снимки экрана: $OUT"; [ $A -eq 0 ] && [ $U -eq 0 ]
