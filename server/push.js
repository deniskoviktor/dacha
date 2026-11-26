/*
 * Push-уведомления дачникам (Web Push): долг или давно нет показаний и по оценке баланс ушёл в минус.
 * Только владельцам участков (администратору — нет). Не чаще одного раза в сутки на устройство,
 * рассылка раз в день после PUSH_HOUR (по умолчанию 11:00 Алматы), до 20:00.
 */
const webpush = require('web-push');
const { pool, fromIsoDate } = require('./db');

const TZ_OFFSET_H = 5; // Алматы, UTC+5
const PUSH_HOUR = Number(process.env.PUSH_HOUR || 11);
const PUBLIC_URL = process.env.PUBLIC_URL || 'https://dacha.82-115-48-98.sslip.io';
const MS_MONTH = 864e5 * 30.4;
const log = (...a) => console.log(new Date().toISOString(), 'push:', ...a);

const almatyNow = () => new Date(Date.now() + TZ_OFFSET_H * 3600e3);
const almatyDay = (t = Date.now()) => new Date(t + TZ_OFFSET_H * 3600e3).toISOString().slice(0, 10);
const money = n => Math.round(n).toLocaleString('ru-RU').replace(/ /g, ' ') + ' ₸';
const monthsStr = m => { const n = Math.round(m); return n + ' ' + (n % 10 === 1 && n % 100 !== 11 ? 'месяц' : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? 'месяца' : 'месяцев'); };

let ready = false;
async function init() {
  const get = async k => (await pool.query('SELECT value FROM settings WHERE key=$1', [k])).rows[0]?.value;
  let pub = process.env.VAPID_PUBLIC || await get('vapid_public'), priv = process.env.VAPID_PRIVATE || await get('vapid_private');
  if (!pub || !priv) {
    const k = webpush.generateVAPIDKeys(); pub = k.publicKey; priv = k.privateKey;
    await pool.query("INSERT INTO settings(key, value) VALUES ('vapid_public',$1),('vapid_private',$2) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value", [pub, priv]);
    log('созданы ключи VAPID');
  }
  webpush.setVapidDetails(PUBLIC_URL, pub, priv);
  ready = true;
  return pub;
}
const publicKey = async () => (await pool.query("SELECT value FROM settings WHERE key='vapid_public'")).rows[0]?.value;

/** Состояние участков — та же логика, что на странице (stale, средний расход, оценка). */
async function plotStates() {
  const tariff = Number((await pool.query("SELECT value FROM settings WHERE key='tariff'")).rows[0]?.value || 36);
  const plots = (await pool.query('SELECT id, plot_number FROM plots WHERE active')).rows;
  const recs = (await pool.query(`SELECT plot_id, date, consumption, balance FROM records
    WHERE date IS NOT NULL AND (reading > 0 OR consumption > 0 OR topup > 0 OR cost > 0) ORDER BY plot_id, date, id`)).rows;
  const by = new Map(plots.map(p => [p.id, []]));
  for (const r of recs) by.get(r.plot_id)?.push({ t: new Date(r.date + 'T00:00:00+05:00').getTime(), kwh: Number(r.consumption) || 0, bal: Number(r.balance) || 0, date: r.date });
  const avg = new Map();
  for (const [id, rs] of by) {
    if (rs.length < 2) continue;
    const last = rs[rs.length - 1].t, from = Math.max(rs[0].t, last - 365 * 864e5), months = (last - from) / MS_MONTH;
    const kwh = rs.filter(x => x.t > from && x.t <= last).reduce((a, x) => a + x.kwh, 0);
    if (months >= 1 && kwh > 0) avg.set(id, kwh / months);
  }
  const vals = [...avg.values()].sort((a, b) => a - b), median = vals.length ? vals[Math.floor(vals.length / 2)] : 0;
  const out = new Map();
  for (const p of plots) {
    const rs = by.get(p.id), l = rs[rs.length - 1];
    if (!l) continue;
    const months = (Date.now() - l.t) / MS_MONTH;
    const stale = new Date(l.t).getUTCFullYear() > 2023 && months > 2;
    const est = stale ? l.bal - Math.round((avg.get(p.id) || median) * months) * tariff : l.bal;
    out.set(p.id, { number: p.plot_number || '', bal: l.bal, stale, months, est, lastDate: fromIsoDate(l.date) });
  }
  return out;
}

/** Текст уведомления или null (всё в порядке). */
function message(s) {
  if (!s) return null;
  const who = s.number ? `Участок № ${s.number}` : 'Ваш участок';
  const pay = 'Пополните через Kaspi: Энергосбыт → договор 380716 и отметьте оплату в приложении.';
  if (s.bal < 0 && s.stale) return `${who}: долг ${money(-s.bal)}, а показаний нет ${monthsStr(s.months)} — по оценке баланс ≈ −${money(-s.est)}. Передайте показания. ${pay}`;
  if (s.bal < 0) return `${who}: долг ${money(-s.bal)}. ${pay}`;
  if (s.stale && s.est < 0) return `${who}: показаний нет ${monthsStr(s.months)} (последние ${s.lastDate}), по оценке баланс ≈ −${money(-s.est)}. Передайте показания и пополните баланс.`;
  return null;
}

async function sendTo(sub, body, tag = 'dacha-balance') {
  const payload = JSON.stringify({ title: 'Электроэнергия — дача', body, url: PUBLIC_URL + '/?p=pl', tag });
  try {
    await webpush.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, payload, { TTL: 12 * 3600, urgency: 'normal' });
    await pool.query('UPDATE push_subs SET fails=0 WHERE id=$1', [sub.id]);
    return true;
  } catch (e) {
    if (e.statusCode === 404 || e.statusCode === 410) { await pool.query('DELETE FROM push_subs WHERE id=$1', [sub.id]); log(`подписка ${sub.id} больше не действует — удалена`); }
    else { await pool.query('UPDATE push_subs SET fails=fails+1 WHERE id=$1', [sub.id]); log(`подписка ${sub.id}: ошибка ${e.statusCode || e.message}`); }
    return false;
  }
}

/** Ежедневная рассылка: каждому устройству не чаще раза в сутки (по дню Алматы). */
let running = false;
async function runDaily() {
  if (!ready || running) return { sent: 0, skipped: 0, busy: true };
  running = true;
  try {
    const states = await plotStates(), today = almatyDay();
    const subs = (await pool.query('SELECT s.* FROM push_subs s JOIN plots p ON p.id = s.plot_id AND p.active')).rows;
    let sent = 0, skipped = 0;
    for (const s of subs) {
      const text = message(states.get(s.plot_id));
      if (!text || (s.last_sent_at && almatyDay(new Date(s.last_sent_at).getTime()) === today)) { skipped++; continue; }
      if (await sendTo(s, text)) { sent++; await pool.query('UPDATE push_subs SET last_sent_at=now() WHERE id=$1', [s.id]); }
    }
    await pool.query("INSERT INTO settings(key, value) VALUES ('push_last_run',$1) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value", [new Date().toISOString()]);
    log(`рассылка: отправлено ${sent}, пропущено ${skipped}`);
    return { sent, skipped };
  } finally { running = false; }
}

function schedule() {
  const tick = async () => {
    try {
      const h = almatyNow().getUTCHours();
      if (h < PUSH_HOUR || h >= 20) return;
      const last = (await pool.query("SELECT value FROM settings WHERE key='push_last_run'")).rows[0]?.value;
      if (last && almatyDay(new Date(last).getTime()) === almatyDay()) return;
      await runDaily();
    } catch (e) { log('ошибка расписания:', e.message); }
  };
  setTimeout(tick, 30_000);
  setInterval(tick, 10 * 60_000);
}

async function subscribe(sess, sub, ua) {
  if (!sub || typeof sub.endpoint !== 'string' || !/^https:\/\//.test(sub.endpoint) || !sub.keys?.p256dh || !sub.keys?.auth) throw new Error('bad');
  await pool.query(`INSERT INTO push_subs(plot_id, endpoint, p256dh, auth, ua) VALUES ($1,$2,$3,$4,$5)
    ON CONFLICT (endpoint) DO UPDATE SET plot_id=EXCLUDED.plot_id, p256dh=EXCLUDED.p256dh, auth=EXCLUDED.auth, ua=EXCLUDED.ua, fails=0`,
    [sess.plotId, sub.endpoint.slice(0, 1000), String(sub.keys.p256dh).slice(0, 200), String(sub.keys.auth).slice(0, 100), String(ua || '').slice(0, 300)]);
}
async function unsubscribe(endpoint) { await pool.query('DELETE FROM push_subs WHERE endpoint=$1', [String(endpoint || '')]); }
async function testOwn(sess, endpoint) {
  const sub = (await pool.query('SELECT * FROM push_subs WHERE endpoint=$1 AND plot_id=$2', [String(endpoint || ''), sess.plotId])).rows[0];
  if (!sub) return false;
  const st = (await plotStates()).get(sess.plotId);
  return sendTo(sub, `Уведомления включены ✅ ${message(st) || 'Сейчас всё в порядке — напомним, если появится долг или давно не будет показаний.'}`, 'dacha-test');
}
async function stats() {
  const states = await plotStates();
  const subs = (await pool.query('SELECT plot_id, count(*)::int n, max(last_sent_at) last FROM push_subs GROUP BY plot_id')).rows;
  const last = (await pool.query("SELECT value FROM settings WHERE key='push_last_run'")).rows[0]?.value || null;
  return { lastRun: last, hour: PUSH_HOUR, plots: subs.map(s => ({ plotId: s.plot_id, devices: s.n, lastSent: s.last, due: !!message(states.get(s.plot_id)) })),
    due: [...states].filter(([, s]) => message(s)).map(([id]) => id) };
}

module.exports = { init, publicKey, schedule, runDaily, subscribe, unsubscribe, testOwn, stats, message, plotStates };
