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

/** «Эмир(+77011118517) уч. 1» → { ownerName: 'Эмир', phone: '+77011118517', number: '1' } */
function parsePlotName(name) {
  let s = String(name || '').trim(), phone = '', number = '';
  const ph = s.match(/\(\s*(\+?[\d\s()-]{7,})\s*\)/) || s.match(/(\+?\d[\d\s-]{9,}\d)/);
  if (ph) { phone = ph[1].replace(/[^\d+]/g, ''); s = s.replace(ph[0], ' '); }
  const no = s.match(/уч(?:асток)?\.?\s*№?\s*(\d+[а-яa-z]?)/i);
  if (no) { number = no[1]; s = s.replace(no[0], ' '); }
  s = s.replace(/\(\s*\)/g, ' ').replace(/\s{2,}/g, ' ').trim();
  return { ownerName: s, phone, number };
}
/** Обратно — то же «название», что было в таблице (по нему работают старые страницы и журнал). */
function composePlotName({ ownerName, phone, number }) {
  return `${String(ownerName || '').trim()}${phone ? `(${phone})` : ''}${number ? ` уч. ${number}` : ''}`;
}

async function initSchema() {
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  for (let i = 1; ; i++) {
    try {
      await pool.query(sql);
      // поля ФИО / телефон / номер участка — один раз заполняем из названия
      const todo = (await pool.query('SELECT id, name FROM plots WHERE owner_name IS NULL')).rows;
      for (const p of todo) { const x = parsePlotName(p.name); await pool.query('UPDATE plots SET owner_name=$2, phone=$3, plot_number=$4 WHERE id=$1', [p.id, x.ownerName, x.phone, x.number]); }
      if (todo.length) console.log(`Поля участков заполнены из названий: ${todo.length}`);
      return;
    }
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

module.exports = { pool, initSchema, tx, normDate, toIsoDate, fromIsoDate, num, parsePlotName, composePlotName };
