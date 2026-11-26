/*
 * Учёт электроэнергии — дача. Сервер для NAS.
 * Заменяет прежний Google Apps Script: тот же формат запросов (?action=… и POST с JSON),
 * но данные хранятся в PostgreSQL.
 */
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { pool, initSchema, tx, toIsoDate, fromIsoDate, num } = require('./db');

const PORT = Number(process.env.PORT || 8080);
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const SESSION_HOURS = Number(process.env.SESSION_HOURS || 12);
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '*').split(',').map(s => s.trim()).filter(Boolean);
const STATIC_DIR = process.env.STATIC_DIR || path.join(__dirname, '..');

if (!ADMIN_PASSWORD) console.warn('ВНИМАНИЕ: ADMIN_PASSWORD не задан — вход администратора отключён.');
if (!process.env.SESSION_SECRET) console.warn('ВНИМАНИЕ: SESSION_SECRET не задан — после перезапуска всем придётся войти заново.');

const app = express();
app.set('trust proxy', true);
app.disable('x-powered-by');

/* ─── CORS: страница может открываться с GitHub Pages ─── */
app.use('/api', (req, res, next) => {
  const origin = req.headers.origin;
  if (origin && (ALLOWED_ORIGINS.includes('*') || ALLOWED_ORIGINS.includes(origin))) {
    res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGINS.includes('*') ? '*' : origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
// Страница шлёт JSON как text/plain (как раньше в Apps Script) — принимаем оба варианта
app.use('/api', express.text({ type: '*/*', limit: '1mb' }));

/* ─── токены сессии ─── */
const b64 = s => Buffer.from(s).toString('base64url');
const sign = payload => crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
function makeToken(sess) {
  const payload = b64(JSON.stringify({ ...sess, exp: Date.now() + SESSION_HOURS * 3600 * 1000 }));
  return payload + '.' + sign(payload);
}
function readToken(token) {
  if (!token || typeof token !== 'string') return null;
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return null;
  const good = sign(payload);
  if (sig.length !== good.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good))) return null;
  try {
    const s = JSON.parse(Buffer.from(payload, 'base64url').toString());
    return s.exp > Date.now() ? s : null;
  } catch { return null; }
}

/* ─── защита от подбора кодов: 10 неверных попыток за 15 минут с одного адреса ─── */
const fails = new Map();
const FAIL_WINDOW = 15 * 60 * 1000, FAIL_MAX = 10;
function tooManyFails(ip) {
  const f = fails.get(ip);
  if (!f) return false;
  if (Date.now() - f.first > FAIL_WINDOW) { fails.delete(ip); return false; }
  return f.count >= FAIL_MAX;
}
function addFail(ip) {
  const f = fails.get(ip);
  if (!f || Date.now() - f.first > FAIL_WINDOW) fails.set(ip, { first: Date.now(), count: 1 });
  else f.count++;
}

class UserError extends Error {}

/** Название участка без телефона — для всех, кроме администратора (сайт открыт в интернет). */
function publicName(name) {
  return String(name || '')
    .replace(/\(\s*\+?[\d\s()-]{7,}\)/g, '')   // «(+77011118517)», «( 8 701 111 85 17 )»
    .replace(/\+?\d[\d\s-]{9,}\d/g, '')          // телефон без скобок
    .replace(/\(\s*\)/g, '')                       // «()»
    .replace(/\s{2,}/g, ' ').trim();
}
const round2 = n => Math.round(n * 100) / 100;

async function getTariff(c = pool) {
  const r = await c.query("SELECT value FROM settings WHERE key='tariff'");
  return r.rows.length ? Number(r.rows[0].value) : 36;
}

function needEdit(sess, plot) {
  if (!sess) throw new UserError('Требуется вход');
  if (sess.role === 'admin') return;
  if (sess.role === 'owner' && (sess.plotId === plot.id || sess.plotName === plot.name)) {
    if (plot.active === false) throw new UserError('Участок отключён администратором');
    return;
  }
  throw new UserError('Нет доступа к этому участку');
}
function needAdmin(sess) {
  if (!sess || sess.role !== 'admin') throw new UserError('Требуются права администратора');
}

// «Настоящая» запись — та же проверка, что isReal() в index.html
const REAL = `(date IS NOT NULL OR date_raw IS NOT NULL) AND (reading > 0 OR consumption > 0 OR topup > 0 OR cost > 0)`;

async function lastRecord(c, plotId) {
  const r = await c.query(`SELECT * FROM records WHERE plot_id=$1 AND ${REAL} ORDER BY id DESC LIMIT 1 FOR UPDATE`, [plotId]);
  return r.rows[0] || null;
}
async function plotByName(c, name, lock = false) {
  const r = await c.query(`SELECT * FROM plots WHERE name=$1 ${lock ? 'FOR UPDATE' : ''}`, [name]);
  if (!r.rows.length) throw new UserError('Участок не найден');
  return r.rows[0];
}
/** Участок из запроса: по plotId (новая страница) или по plotName (старая). */
async function plotOf(c, b, lock = false) {
  if (b.plotId !== undefined && b.plotId !== null && b.plotId !== '') {
    const r = await c.query(`SELECT * FROM plots WHERE id=$1 ${lock ? 'FOR UPDATE' : ''}`, [Number(b.plotId)]);
    if (!r.rows.length) throw new UserError('Участок не найден');
    return r.rows[0];
  }
  return plotByName(c, b.plotName, lock);
}
const todayIso = () => new Date(Date.now() + 5 * 3600 * 1000).toISOString().slice(0, 10); // Алматы (UTC+5)
async function audit(c, sess, action, plotName, details) {
  await c.query('INSERT INTO audit_log(role, plot_name, action, details) VALUES ($1,$2,$3,$4)',
    [sess ? sess.role + (sess.plotName ? ':' + sess.plotName : '') : 'anon', plotName || null, action, details || null]);
}

/* ─── чтение ─── */
async function getData(sess) {
  const isAdmin = sess && sess.role === 'admin';
  // отключённые участки видит только администратор
  const plots = (await pool.query(`SELECT * FROM plots ${isAdmin ? '' : 'WHERE active'} ORDER BY sort_order, id`)).rows;
  const recs = (await pool.query('SELECT * FROM records ORDER BY plot_id, id')).rows;
  const byPlot = new Map(plots.map(p => [p.id, []]));
  for (const r of recs) {
    byPlot.get(r.plot_id)?.push({
      date: r.date ? fromIsoDate(r.date) : (r.date_raw || ''),
      reading: r.reading, prevReading: r.prev_reading, consumption: r.consumption,
      price: r.price, cost: r.cost, topup: r.topup,
      balanceBefore: r.balance_before, balance: r.balance,
      checkNum: r.check_num, note: r.note,
    });
  }
  return {
    plots: plots.map(p => {
      const o = { id: p.id, name: isAdmin ? p.name : publicName(p.name), active: p.active, records: byPlot.get(p.id) };
      if (isAdmin) o.storedPwd = p.password || ''; // коды и телефоны видит только администратор
      return o;
    }),
  };
}

async function checkPassword(password, ip) {
  if (tooManyFails(ip)) throw new UserError('Слишком много попыток, попробуйте через 15 минут');
  password = String(password || '').trim();
  if (!password) return { ok: false };
  if (ADMIN_PASSWORD && password === ADMIN_PASSWORD) {
    fails.delete(ip);
    return { ok: true, role: 'admin', token: makeToken({ role: 'admin' }) };
  }
  const r = await pool.query('SELECT id, name, active FROM plots WHERE password=$1', [password]);
  if (r.rows.length === 1 && !r.rows[0].active) { addFail(ip); throw new UserError('Участок отключён — обратитесь к администратору'); }
  if (r.rows.length === 1) {
    fails.delete(ip);
    const { id: plotId, name } = r.rows[0];
    return { ok: true, role: 'owner', plotId, plotName: publicName(name), token: makeToken({ role: 'owner', plotId, plotName: name }) };
  }
  addFail(ip);
  return { ok: false };
}

/* ─── запись ─── */
async function addRecord(sess, b) {
  if (!sess) throw new UserError('Требуется вход');
  const isAdmin = sess.role === 'admin';
  return tx(async c => {
    const plot = await plotOf(c, b, true);
    needEdit(sess, plot);
    const last = await lastRecord(c, plot.id);
    const reading = num(b.reading);
    const topup = num(b.topup);  // оплата вместе с показаниями — можно 0 (показания без оплаты)
    const date = toIsoDate(b.date);
    if (!(reading > 0)) throw new UserError('Укажите текущие показания счётчика');
    if (topup < 0) throw new UserError('Сумма оплаты не может быть отрицательной');
    if (!date) throw new UserError('Укажите дату');
    if (date > todayIso()) throw new UserError('Дата не может быть в будущем');

    // Предыдущее показание и цену может менять только администратор
    const prev = isAdmin && b.prevReading !== undefined && b.prevReading !== '' ? num(b.prevReading) : (last ? last.reading : 0);
    const price = isAdmin && num(b.price) > 0 ? num(b.price) : await getTariff(c);
    if (reading < prev) throw new UserError('Новое показание меньше предыдущего');

    if (last && last.date && date < (typeof last.date === 'string' ? last.date : toIsoDate(last.date))) throw new UserError('Дата раньше последней записи (' + fromIsoDate(last.date) + ')');
    const dup = await c.query(`SELECT 1 FROM records WHERE plot_id=$1 AND date=$2 AND ${REAL}`, [plot.id, date]);
    if (dup.rows.length) throw new UserError('Запись за эту дату уже есть');

    const balanceBefore = last ? last.balance : 0;
    const consumption = Math.max(0, round2(reading - prev));
    const cost = round2(consumption * price);
    const balance = round2(balanceBefore + topup - cost);
    await c.query(
      `INSERT INTO records(plot_id, date, reading, prev_reading, consumption, price, cost, topup, balance_before, balance, check_num, note, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [plot.id, date, reading, prev, consumption, price, cost, topup, balanceBefore, balance,
        String(b.checkNum || '').trim(), String(b.note || '').trim(), sess.role]);
    await audit(c, sess, 'addRecord', plot.name, { date, reading, prev, price, topup, cost, balance });
    return { ok: true, newBalance: balance, consumption, cost };
  });
}

const joinText = (a, b) => (b = String(b || '').trim()) ? (a ? a + ', ' + b : b) : a;

async function updatePayment(sess, b) {
  if (!sess) throw new UserError('Требуется вход');
  const amount = num(b.topup);
  if (!(amount > 0)) throw new UserError('Сумма пополнения должна быть больше 0');
  return tx(async c => {
    const plot = await plotOf(c, b, true);
    needEdit(sess, plot);
    const last = await lastRecord(c, plot.id);
    if (!last) throw new UserError('Нет записей для этого участка');
    const topup = round2(last.topup + amount);
    const balance = round2(last.balance_before + topup - last.cost);
    await c.query('UPDATE records SET topup=$2, balance=$3, check_num=$4, note=$5, updated_at=now() WHERE id=$1',
      [last.id, topup, balance, joinText(last.check_num, b.checkNum), joinText(last.note, b.note)]);
    await audit(c, sess, 'updatePayment', plot.name, { recordId: last.id, amount, topup, balance, checkNum: b.checkNum || '' });
    return { ok: true, newBalance: balance };
  });
}

async function savePasswords(sess, b) {
  needAdmin(sess);
  const list = Array.isArray(b.passwords) ? b.passwords : [];
  const codes = list.map(p => String(p.password || '').trim());
  if (codes.some(c => !/^\d{4}$/.test(c))) throw new UserError('Коды должны состоять из 4 цифр');
  if (new Set(codes).size !== codes.length) throw new UserError('Коды повторяются');
  if (ADMIN_PASSWORD && codes.includes(ADMIN_PASSWORD)) throw new UserError('Код совпадает с паролем администратора');
  return tx(async c => {
    for (const p of list) {
      if (p.plotId !== undefined && p.plotId !== null) await c.query('UPDATE plots SET password=$2 WHERE id=$1', [Number(p.plotId), String(p.password).trim()]);
      else await c.query('UPDATE plots SET password=$2 WHERE name=$1', [p.plotName, String(p.password).trim()]);
    }
    await audit(c, sess, 'savePasswords', null, { count: list.length });
    return { ok: true };
  });
}

async function setPlotActive(sess, b) {
  needAdmin(sess);
  const active = b.active === true || b.active === 'true';
  return tx(async c => {
    const plot = await plotOf(c, b, true);
    await c.query('UPDATE plots SET active=$2 WHERE id=$1', [plot.id, active]);
    await audit(c, sess, active ? 'enablePlot' : 'disablePlot', plot.name, { plotId: plot.id });
    return { ok: true, plotId: plot.id, active };
  });
}

async function setTariff(sess, b) {
  needAdmin(sess);
  const t = num(b.tariff);
  if (!(t > 0)) throw new UserError('Введите корректный тариф');
  return tx(async c => {
    await c.query("INSERT INTO settings(key, value) VALUES ('tariff',$1) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value", [String(t)]);
    await audit(c, sess, 'setTariff', null, { tariff: t });
    return { ok: true, tariff: t };
  });
}

/* ─── маршруты ─── */
function wrap(fn) {
  return async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try { res.json(await fn(req)); }
    catch (e) {
      if (!(e instanceof UserError)) console.error(e);
      res.json({ error: e instanceof UserError ? e.message : 'Ошибка сервера' });
    }
  };
}

app.get('/api', wrap(async req => {
  const sess = readToken(req.query.token);
  switch (req.query.action) {
    case 'getData': return getData(sess);
    case 'getTariff': return { tariff: await getTariff() };
    case 'checkPassword': return checkPassword(req.query.password, req.ip);
    case 'whoami': return sess ? { ok: true, role: sess.role, plotId: sess.plotId, plotName: publicName(sess.plotName) } : { ok: false };
    default: throw new UserError('Неизвестное действие');
  }
}));

app.post('/api', wrap(async req => {
  let b;
  try { b = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {}); }
  catch { throw new UserError('Неверный формат запроса'); }
  const sess = readToken(b.token);
  switch (b.action) {
    case 'checkPassword': return checkPassword(b.password, req.ip);
    case 'addRecord': return addRecord(sess, b);
    case 'updatePayment': return updatePayment(sess, b);
    case 'savePasswords': return savePasswords(sess, b);
    case 'setTariff': return setTariff(sess, b);
    case 'setPlotActive': return setPlotActive(sess, b);
    default: throw new UserError('Неизвестное действие');
  }
}));

app.get('/healthz', async (req, res) => {
  try { await pool.query('SELECT 1'); res.send('ok'); } catch { res.status(500).send('db error'); }
});

// Сама страница и инструкции — тот же index.html, что на GitHub
app.get(['/', '/index.html', '/instrukciya_polzovatelya.pdf', '/instrukciya_polzovatelya1.pdf'], (req, res) => {
  const f = req.path === '/' ? 'index.html' : req.path.slice(1);
  res.sendFile(path.join(STATIC_DIR, f));
});

initSchema().then(() => {
  app.listen(PORT, () => console.log(`Дача: сервер запущен на порту ${PORT}`));
}).catch(e => { console.error('Не удалось подготовить базу:', e); process.exit(1); });
