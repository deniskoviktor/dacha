#!/usr/bin/env node
/*
 * Перенос данных из Google Таблицы (через прежний Apps Script) в PostgreSQL.
 *
 *   node migrate.js --url "https://script.google.com/macros/s/…/exec"   — забрать данные напрямую
 *   node migrate.js --json data.json [--tariff 36]                        — из сохранённого ответа getData
 *
 * Добавьте --replace, чтобы сначала очистить участки и записи в базе (иначе база должна быть пустой).
 * Добавьте --dry-run, чтобы только посмотреть, что будет перенесено.
 */
const fs = require('fs');
const { pool, initSchema, tx, toIsoDate, normDate, num } = require('./db');

const args = process.argv.slice(2);
const opt = name => { const i = args.indexOf('--' + name); return i >= 0 ? (args[i + 1] ?? true) : undefined; };
const flag = name => args.includes('--' + name);

async function fetchJson(u) {
  const r = await fetch(u, { redirect: 'follow' });
  if (!r.ok) throw new Error(`HTTP ${r.status} для ${u}`);
  return r.json();
}

async function main() {
  const url = opt('url'), file = opt('json');
  if (!url && !file) {
    console.log('Укажите источник: --url <адрес Apps Script> или --json <файл>');
    process.exit(2);
  }
  let data, tariff = opt('tariff') ? num(opt('tariff')) : null;
  if (url) {
    const sep = url.includes('?') ? '&' : '?';
    console.log('Загружаю данные из Apps Script…');
    data = await fetchJson(url + sep + 'action=getData&v=9');
    if (tariff === null) {
      try { const t = await fetchJson(url + sep + 'action=getTariff&v=9'); if (t.tariff) tariff = num(t.tariff); } catch {}
    }
  } else {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
  }
  if (data.error) throw new Error('Apps Script вернул ошибку: ' + data.error);

  // Те же фильтры, что в index.html: пустые и служебные строки («Дата…») пропускаем
  const plots = (data.plots || []).filter(p => p.name && !String(p.name).startsWith('Дата'));
  // Ячейка с числом, отформатированная в Таблице как дата, приходит из Apps Script миллисекундами от «нулевой»
  // даты Таблицы 30.12.1899 (в поясе Таблицы). Пересчитываем обратно в число и сообщаем о каждом таком случае.
  const SHEETS_ZERO = new Date(1899, 11, 30).getTime();
  const fixedCells = [];
  const cellNum = (v, where) => {
    if (typeof v === 'number' && Math.abs(v) > 1e11) { const d = Math.round(((v - SHEETS_ZERO) / 864e5) * 100) / 100; fixedCells.push(`${where} = ${d}`); return d; }
    return num(v);
  };
  let recCount = 0, badDates = 0, noPwd = 0;
  const prepared = plots.map((p, i) => {
    if (!p.storedPwd) noPwd++;
    const records = (p.records || []).map(r => {
      const at = (f) => `${String(p.name).trim()}, ${r.date || '?'}, ${f}`;
      const iso = toIsoDate(r.date);
      if (!iso && r.date) badDates++;
      const reading = cellNum(r.reading, at('показание')), consumption = cellNum(r.consumption, at('расход'));
      return {
        date: iso, date_raw: iso ? null : (r.date ? normDate(r.date) : null),
        reading,
        prev_reading: r.prevReading !== undefined && r.prevReading !== '' ? cellNum(r.prevReading, at('пред. показание')) : Math.max(0, reading - consumption),
        consumption, price: cellNum(r.price, at('цена')), cost: cellNum(r.cost, at('стоимость')), topup: cellNum(r.topup, at('пополнение')),
        balance_before: cellNum(r.balanceBefore, at('баланс до')), balance: cellNum(r.balance, at('баланс')),
        check_num: String(r.checkNum ?? '').trim(), note: String(r.note ?? '').trim(),
      };
    });
    recCount += records.length;
    return { name: String(p.name).trim(), password: p.storedPwd ? String(p.storedPwd).trim() : null, sort_order: i, records };
  });

  console.log(`Участков: ${prepared.length}, записей: ${recCount}, тариф: ${tariff ?? '(не найден, останется прежний)'}`);
  if (fixedCells.length) console.log(`Ячейки в формате даты пересчитаны в числа (${fixedCells.length}):\n  ${fixedCells.join('\n  ')}`);
  if (badDates) console.log(`Дат, которые не удалось разобрать (сохранены как текст): ${badDates}`);
  if (noPwd) console.log(`Участков без кода владельца: ${noPwd}`);
  const names = new Set();
  for (const p of prepared) { if (names.has(p.name)) throw new Error('Повторяется название участка: ' + p.name); names.add(p.name); }
  if (flag('dry-run')) { console.log('Пробный запуск — в базу ничего не записано.'); return; }

  await initSchema();
  await tx(async c => {
    const existing = Number((await c.query('SELECT count(*) FROM plots')).rows[0].count);
    if (existing && !flag('replace')) throw new Error(`В базе уже есть ${existing} участков. Запустите с --replace, чтобы заменить данные.`);
    if (flag('replace')) await c.query('TRUNCATE records, plots RESTART IDENTITY CASCADE');
    for (const p of prepared) {
      const id = (await c.query('INSERT INTO plots(name, password, sort_order) VALUES ($1,$2,$3) RETURNING id', [p.name, p.password, p.sort_order])).rows[0].id;
      for (const r of p.records) {
        await c.query(
          `INSERT INTO records(plot_id, date, date_raw, reading, prev_reading, consumption, price, cost, topup, balance_before, balance, check_num, note, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'import')`,
          [id, r.date, r.date_raw, r.reading, r.prev_reading, r.consumption, r.price, r.cost, r.topup, r.balance_before, r.balance, r.check_num, r.note]);
      }
    }
    if (tariff) await c.query("INSERT INTO settings(key, value) VALUES ('tariff',$1) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value", [String(tariff)]);
    await c.query("INSERT INTO audit_log(role, action, details) VALUES ('import','migrate',$1)", [{ source: url ? 'apps-script' : 'json', plots: prepared.length, records: recCount }]);
  });

  // Сверка: последние балансы в базе = последние балансы в таблице
  const check = await pool.query(`SELECT p.name, (SELECT balance FROM records r WHERE r.plot_id=p.id ORDER BY id DESC LIMIT 1) AS b FROM plots p`);
  const inDb = new Map(check.rows.map(r => [r.name, r.b]));
  let mismatch = 0;
  for (const p of prepared) {
    const last = p.records[p.records.length - 1];
    if (last && Math.abs((inDb.get(p.name) ?? 0) - last.balance) > 0.009) { mismatch++; console.log('Не совпал баланс:', p.name); }
  }
  console.log(mismatch ? `Готово, но есть расхождения: ${mismatch}` : 'Готово. Данные перенесены, балансы совпадают с таблицей.');
}

main().catch(e => { console.error('Ошибка:', e.message); process.exitCode = 1; }).finally(() => pool.end());
