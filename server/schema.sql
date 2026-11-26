-- Схема базы «Учёт электроэнергии — дача». Повторный запуск безопасен.

CREATE TABLE IF NOT EXISTS plots (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,      -- как в таблице, например «Иванов И.И. (уч. 12)»
  password    TEXT,                      -- 4-значный код владельца
  sort_order  INTEGER NOT NULL DEFAULT 0
);

-- Участок можно отключить (продан, не участвует): скрыт для всех, кроме администратора, код владельца не действует
ALTER TABLE plots ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT true;
-- Отдельные поля (раньше всё было в названии «Эмир(+7701…) уч. 1»); название собирается из них
ALTER TABLE plots ADD COLUMN IF NOT EXISTS owner_name  TEXT;
ALTER TABLE plots ADD COLUMN IF NOT EXISTS phone       TEXT NOT NULL DEFAULT '';
ALTER TABLE plots ADD COLUMN IF NOT EXISTS plot_number TEXT NOT NULL DEFAULT '';

CREATE TABLE IF NOT EXISTS records (
  id              SERIAL PRIMARY KEY,    -- порядок записей внутри участка
  plot_id         INTEGER NOT NULL REFERENCES plots(id) ON DELETE CASCADE,
  date            DATE,
  date_raw        TEXT,                  -- исходная дата из таблицы, если её не удалось разобрать
  reading         NUMERIC(14,2) NOT NULL DEFAULT 0,  -- показание счётчика, кВт·ч
  prev_reading    NUMERIC(14,2) NOT NULL DEFAULT 0,
  consumption     NUMERIC(14,2) NOT NULL DEFAULT 0,  -- расход, кВт·ч
  price           NUMERIC(10,2) NOT NULL DEFAULT 0,  -- цена за кВт·ч, ₸
  cost            NUMERIC(14,2) NOT NULL DEFAULT 0,  -- стоимость, ₸
  topup           NUMERIC(14,2) NOT NULL DEFAULT 0,  -- пополнение, ₸
  balance_before  NUMERIC(14,2) NOT NULL DEFAULT 0,
  balance         NUMERIC(14,2) NOT NULL DEFAULT 0,
  check_num       TEXT NOT NULL DEFAULT '',
  note            TEXT NOT NULL DEFAULT '',
  created_by      TEXT NOT NULL DEFAULT '',          -- admin / owner / import
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS records_plot_idx ON records(plot_id, id);

CREATE TABLE IF NOT EXISTS settings (
  key    TEXT PRIMARY KEY,
  value  TEXT NOT NULL
);
INSERT INTO settings(key, value) VALUES ('tariff', '36') ON CONFLICT (key) DO NOTHING;

-- Журнал всех изменений: кто, когда и что менял
CREATE TABLE IF NOT EXISTS audit_log (
  id          SERIAL PRIMARY KEY,
  at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  role        TEXT NOT NULL,
  plot_name   TEXT,
  action      TEXT NOT NULL,
  details     JSONB
);
