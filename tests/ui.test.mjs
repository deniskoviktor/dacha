import { chromium, devices } from 'playwright';
const URL = process.argv[2] || 'http://127.0.0.1:8097/';
const OUT = '/out';
let pass = 0, fail = 0;
const ok = (c, t, x = '') => { if (c) { pass++; console.log('  ✓', t); } else { fail++; console.log('  ✗', t, x); } };
const browser = await chromium.launch();

async function run(label, ctxOpts, fn) {
  console.log(label);
  const ctx = await browser.newContext(ctxOpts);
  const page = await ctx.newPage();
  const errors = []; let alerts = 0;
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/favicon|tabler|jsdelivr/.test(m.text())) errors.push(m.text()); });
  page.on('dialog', async (d) => { if (d.type() === 'alert') alerts++; await d.accept(); });
  await page.goto(URL, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => document.getElementById('st').textContent.startsWith('Обновлено'));
  await fn(page);
  ok(!errors.length, 'нет ошибок JavaScript', errors.join(' | '));
  ok(alerts === 0, 'код из примечания не выполнился (XSS)');
  await ctx.close();
}
const noHScroll = (p) => p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

await run('Телефон (iPhone 13), без входа:', { ...devices['iPhone 13'] }, async (p) => {
  ok(await noHScroll(p), 'нет горизонтальной прокрутки');
  ok(await p.locator('nav.tabs').evaluate((e) => getComputedStyle(e).position === 'fixed'), 'вкладки внизу экрана');
  const txt = await p.locator('#pg-ov').innerText();
  ok(!/\+?7\d{10}/.test(txt.replace(/\s/g, '')), 'телефонов на странице нет');
  ok(await p.locator('#ov-d .row').count() === 13, 'в балансах 13 участков');
  const fs = await p.locator('#pin').evaluate((e) => getComputedStyle(e).fontSize);
  ok(parseFloat(fs) >= 16, 'поле ввода не меньше 16px (iPhone не увеличивает страницу)');
  await p.screenshot({ path: `${OUT}/1-сводка-телефон.png`, fullPage: true });
});

await run('Телефон, владелец (код 1111):', { ...devices['iPhone 13'] }, async (p) => {
  await p.click('#btn-login'); await p.fill('#pin', '1111'); await p.click('#login-btn');
  await p.waitForSelector('#ov-mine .mine');
  ok(await p.locator('#ov-mine').innerText().then((t) => t.includes('Мой участок')), 'после входа — карточка «Мой участок»');
  await p.screenshot({ path: `${OUT}/2-мой-участок.png`, fullPage: true });
  await p.click('#ov-mine button:has-text("Показания")');
  ok(await p.locator('#a-plot.plot-fixed').count() === 1, 'участок подставлен сам (без выбора)');
  ok(await p.locator('#a-prev').isHidden(), 'владельцу не видны поля цены и предыдущего показания');
  const hint = await p.locator('#a-prev-hint').innerText();
  const prev = Number(hint.match(/Предыдущее: ([\d\s ,]+)/)[1].replace(/[\s ]/g, '').replace(',', '.'));
  await p.fill('#a-read', String(prev + 5));
  ok((await p.locator('#a-preview').innerText()).includes('180'), 'предпросмотр: стоимость 5 × 36 = 180 ₸');
  await p.fill('#a-note', '<img src=x onerror=alert(1)>');
  await p.screenshot({ path: `${OUT}/3-показания.png`, fullPage: true });
  await p.click('#a-btn');
  await p.waitForSelector('#a-msg .msg');
  const m = await p.locator('#a-msg').innerText();
  ok(m.includes('Записано'), 'показания с оплатой 0 сохранены', m);
  await p.click('#a-btn'); await p.fill('#a-read', String(prev + 6)); await p.click('#a-btn');
  await p.waitForTimeout(300);
  ok((await p.locator('#a-msg').innerText()).includes('уже есть'), 'вторая запись за сегодня — понятный отказ');
  await p.click('nav.tabs [data-p=pay]');
  await p.fill('#pay-amount', '0'); await p.click('#pay-btn');
  ok((await p.locator('#pay-msg').innerText()).includes('больше 0'), 'пополнение на 0 — отказ');
  await p.fill('#pay-amount', '300');
  ok((await p.locator('#pay-preview').innerText()).includes('Новый баланс'), 'предпросмотр нового баланса');
  await p.click('#pay-btn'); await p.waitForSelector('#pay-msg .mok');
  ok((await p.locator('#pay-msg').innerText()).includes('Оплата внесена'), 'пополнение на 300 сохранено');
  await p.screenshot({ path: `${OUT}/4-оплата.png`, fullPage: true });
  await p.click('nav.tabs [data-p=pl]');
  await p.locator('.pc').first().locator('.pch').click();
  ok(await p.locator('.pc.open .recs-m .rc').first().isVisible(), 'история записей — карточками на телефоне');
  ok((await p.locator('.pc.open .recs-m').innerText()).includes('<img src=x'), 'примечание показано как текст');
  ok(await noHScroll(p), 'нет горизонтальной прокрутки на вкладке «Участки»');
  await p.screenshot({ path: `${OUT}/5-участки.png`, fullPage: true });
});

await run('Компьютер, администратор (9999):', { viewport: { width: 1280, height: 900 } }, async (p) => {
  await p.click('#btn-login'); await p.fill('#pin', '9999'); await p.press('#pin', 'Enter');
  await p.waitForSelector('#nav-pwd:visible');
  ok(await p.locator('nav.tabs').evaluate((e) => getComputedStyle(e).position !== 'fixed'), 'вкладки сверху');
  await p.click('#nav-pwd');
  ok(await p.locator('.pwd-row').count() === 13, 'коды всех 13 участков');
  await p.click('nav.tabs [data-p=add]');
  ok(await p.locator('select#a-plot option').count() === 13, 'администратор выбирает любой участок');
  ok(await p.locator('#a-prev').isVisible() && await p.locator('#a-price').isVisible(), 'администратору видны цена и предыдущее показание');
  await p.click('nav.tabs [data-p=pl]'); await p.locator('.pc').nth(1).locator('.pch').click();
  ok(await p.locator('.pc.open .recs-d table').isVisible(), 'история — таблицей на компьютере');
  await p.screenshot({ path: `${OUT}/6-администратор-компьютер.png`, fullPage: false });
});

await browser.close();
console.log(`\nИТОГ: ${pass} пройдено, ${fail} не пройдено`);
process.exit(fail ? 1 : 0);
