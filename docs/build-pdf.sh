#!/bin/sh
# Пересборка PDF-инструкции на NAS (от root): sh docs/build-pdf.sh /путь/к/коду
SRC=$(cd "${1:-.}" && pwd)
docker run --rm -v "$SRC":/src -w /tmp mcr.microsoft.com/playwright:v1.49.1-noble sh -c \
  "npm i --silent playwright@1.49.1 >/dev/null 2>&1; cp /src/docs/build-pdf.cjs . && node build-pdf.cjs /src/docs/instrukciya.html /src/instrukciya_polzovatelya.pdf"
cp "$SRC/instrukciya_polzovatelya.pdf" "$SRC/instrukciya_polzovatelya1.pdf"
