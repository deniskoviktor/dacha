const fs = require('fs');
const path = require('path');
const { Pool, types } = require('pg');

// NUMERIC → число, DATE → строка как есть (без сдвига часового пояса)
types.setTypeParser(1700, v => (v === null ? null : parseFloat(v)));
types.setTypeParser(1082, v => v);

const pool = new Pool({
  host: process.env.PGHOST || 'localhost',
  port: Number(process.env.PGPORT || 5432),
  user: process.env.PGUSER || 'dacha',
  password: process.env.PGPASSWORD || '',
  database: process.env.PGDATABASE || 'dacha',
});

async function initSchema() {
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  for (let i = 1; ; i++) {
    try { await pool.query(sql); return; }
    catch (e) {
      if (i >= 30) throw e;
      console.log(`База ещё не готова (${e.code || e.message}), повтор через 2 с…`);
      await new Promise(r => setTimeout(r, 2000));
    }
  }
}

async function tx(fn) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const res = await fn(c);
    await c.query('COMMIT');
    return res;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

/* ─── даты: та же логика, что в index.html (normDate) ─── */
function normDate(str) {
  if (str === null || str === undefined || str === '') return '';
  str = String(str).trim();
  let m;
  // ISO из Google Sheets: 2024-05-17T19:00:00.000Z / 2024-05-17
  m = str.match(/^(\d{4})-(\d{2})-(\d{2})(T.*)?$/);
  if (m) {
    if (m[4]) { // время есть — дата в часовом поясе таблицы, берём ближайшую полночь
      const d = new Date(str);
      if (!isNaN(d)) {
        const shifted = new Date(d.getTime() + 12 * 3600 * 1000);
        return `${String(shifted.getUTCDate()).padStart(2, '0')}.${String(shifted.getUTCMonth() + 1).padStart(2, '0')}.${shifted.getUTCFullYear()}`;
      }
    }
    return `${m[3]}.${m[2]}.${m[1]}`;
  }
  if (/^\d{2}\.\d{2}\.\d{4}$/.test(str)) return str;
  m = str.match(/^(\d{1,2})\.(\d{1,2})\.(\d{2})$/);
  if (m) return m[1].padStart(2, '0') + '.' + m[2].padStart(2, '0') + '.20' + m[3];
  m = str.match(/^(\d{1,2})[.,](\d{1,2})[.,](\d{2,4})$/);
  if (m) { const y = m[3].length === 2 ? '20' + m[3] : m[3]; return m[1].padStart(2, '0') + '.' + m[2].padStart(2, '0') + '.' + y; }
  m = str.match(/^(\d{2})(\d{2})(\d{4})$/);
  if (m) return m[1] + '.' + m[2] + '.' + m[3];
  m = str.match(/^(\d{1,2})\.(\d{2})(\d{4})$/);
  if (m) return m[1].padStart(2, '0') + '.' + m[2] + '.' + m[3];
  m = str.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
  if (m) { const y = m[3].length === 2 ? '20' + m[3] : m[3]; return m[1].padStart(2, '0') + '.' + m[2].padStart(2, '0') + '.' + y; }
  return str;
}

/** «дд.мм.гггг» → «гггг-мм-дд» для PostgreSQL, либо null */
function toIsoDate(str) {
  const n = normDate(str);
  const m = n.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  if (!m) return null;
  const d = Number(m[1]), mo = Number(m[2]), y = Number(m[3]);
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return `${m[3]}-${m[2]}-${m[1]}`;
}

/** «гггг-мм-дд» → «дд.мм.гггг» */
function fromIsoDate(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-');
  return `${d}.${m}.${y}`;
}

const num = v => {
  if (v === null || v === undefined || v === '') return 0;
  const n = typeof v === 'number' ? v : parseFloat(String(v).replace(/\s/g, '').replace(',', '.'));
  return isFinite(n) ? n : 0;
};

module.exports = { pool, initSchema, tx, normDate, toIsoDate, fromIsoDate, num };
