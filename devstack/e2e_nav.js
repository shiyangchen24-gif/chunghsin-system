// 三站整合側邊欄 E2E：首頁 → 側邊欄切換三站、反白、角色、收合、手機抽屜、列印隱藏
'use strict';
const { chromium } = require('playwright-core');
const path = require('path');
const routeCdn = require('./cdn_route');
const { loginAcct } = require('./e2e_util');
const BASE = 'http://localhost:8080';
const SHOTS = path.join(__dirname, 'shots');
let failures = 0;
function check(c, m) { console.log((c ? 'PASS: ' : 'FAIL: ') + m); if (!c) failures++; }

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const errors = [];
  async function mk(w, h) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h } });
    await routeCdn(ctx);
    const p = await ctx.newPage();
    p.on('pageerror', e => errors.push(e.message));
    return p;
  }
  const current = p => p.$eval('.zx-nav-link[aria-current="page"]', a => a.dataset.key).catch(() => null);
  const contentClear = p => p.evaluate(() => {
    const navW = document.querySelector('.zx-sidebar').getBoundingClientRect().right;
    const el = [...document.body.children].find(e => !e.classList.contains('zx-sidebar') && e.getBoundingClientRect().width > 50 && getComputedStyle(e).position !== 'fixed');
    return el ? el.getBoundingClientRect().left >= navW - 1 : true;
  });

  const A = await mk(1440, 900);
  await A.goto(BASE + '/');
  check(await A.isVisible('.zx-sidebar'), 'home page shows the sidebar');
  check((await current(A)) === 'home', 'home item highlighted on home page');
  check(await A.isVisible('#zx-login-nick'), 'dashboard asks for a nickname (no account needed)');
  await loginAcct(A, 'admin@zx.test', 'admin123');
  await A.waitForFunction(() => !document.querySelector('#kpis').classList.contains('skeleton'), null, { timeout: 15000 });
  check((await A.textContent('#hello')).includes('歡迎回來'), 'dashboard greets the member');
  check(await contentClear(A), 'dashboard content starts right of the sidebar');
  const kTick = await A.textContent('#k-tick .val');
  check(/^\d+\/ \d+$/.test(kTick.replace(/\s+/g, ' ').replace(/(\d) \//, '$1/')), `KPI 今日已叫貨 shows x / total (${kTick})`);
  const pts = () => A.$$eval('#trend-table tbody tr', r => r.length);
  const n30 = await pts();
  check(n30 >= 5 && await A.$('#chart svg path[stroke-dasharray]') && /C/.test(await A.$eval('#chart svg path[stroke-dasharray]', e => e.getAttribute('d'))),
        `trend chart drawn as smooth curves with ${n30} service days (solid + dashed)`);
  const box = await A.$eval('#chart .hit', e => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
  await A.mouse.move(box.x + box.w - 2, box.y + box.h / 2);
  check(await A.isVisible('#chart .zxc-tip') && (await A.textContent('#chart .zxc-tip')).includes('已叫貨'), 'hover shows crosshair tooltip');
  await A.screenshot({ path: path.join(SHOTS, 'dashboard.png') });
  await A.click('.seg button[data-days="7"]');
  check((await pts()) === Math.min(7, n30) && (await A.getAttribute('.seg button[data-days="7"]', 'aria-pressed')) === 'true', '7-day range re-draws chart');
  await A.click('#table-toggle');
  check(await A.isVisible('#trend-table table'), 'table view toggle shows data table');
  check((await A.$$('#latest .ab')).length > 0, 'latest abnormal cards listed');

  // 另一台在打勾單勾選 → 儀表板（最快 60 秒重抓一次）更新已叫貨數
  const B = await mk(1280, 860);
  await B.goto(BASE + '/tick/');
  await loginAcct(B, 'staff1@zx.test', 'staff123');
  await B.waitForFunction(() => document.querySelectorAll('.ccard').length > 0, null, { timeout: 15000 });
  const before = parseInt(kTick, 10);
  const card = await B.$('.ccard.unordered, .ccard.warn3');
  if (card) {
    await card.click();
    const t0 = Date.now();
    const ok = await A.waitForFunction(b => parseInt(document.querySelector('#k-tick .val').textContent, 10) === b + 1, before, { timeout: 75000 })
      .then(() => true, () => false);
    check(ok, `dashboard picked up a tick from another device (${((Date.now() - t0) / 1000).toFixed(1)} s, throttle 60 s)`);
  } else check(false, 'found an un-ticked card to click');
  await B.context().close();

  await A.click('.zx-nav-link[data-key="tick"]');
  await A.waitForFunction(() => document.querySelectorAll('.ccard').length > 0, null, { timeout: 15000 });
  check((await current(A)) === 'tick', 'sidebar → 打勾單, highlighted');
  check(await contentClear(A), 'tick content starts right of the sidebar (no overlap)');
  check(await A.isVisible('.zx-nav-link[data-key="tools"]'), 'admin sees 資料搬移 item after login');
  await A.screenshot({ path: path.join(SHOTS, 'nav-tick.png') });

  await A.click('.zx-nav-link[data-key="report"]');
  await A.waitForSelector('#zx-user-chip .zx-role', { timeout: 15000 });
  check(!(await A.$('#zx-login:not([hidden])')), 'login shared: no second login on 異常表');
  check((await current(A)) === 'report' && await contentClear(A), 'sidebar → 異常表與交接表, highlighted, no overlap');
  await A.screenshot({ path: path.join(SHOTS, 'nav-report.png') });

  // 列印：側邊欄隱藏、版面不位移
  await A.emulateMedia({ media: 'print' });
  const printState = await A.evaluate(() => ({ nav: getComputedStyle(document.querySelector('.zx-sidebar')).display,
                                               pad: getComputedStyle(document.body).paddingLeft }));
  check(printState.nav === 'none' && printState.pad === '0px', `print: sidebar hidden and body padding ${printState.pad}`);
  await A.emulateMedia({ media: 'screen' });

  await A.click('.zx-nav-link[data-key="quote"]');
  await A.waitForFunction(() => document.querySelectorAll('#custListBody .cust-row').length > 0, null, { timeout: 15000 });
  check((await current(A)) === 'quote' && await contentClear(A), 'sidebar → 報價單匯出, highlighted, no overlap');
  await A.click('.zx-nav-collapse');
  await A.waitForTimeout(400);
  const w = await A.$eval('.zx-sidebar', e => e.getBoundingClientRect().width);
  check(w < 100, `collapse → icon rail (${w}px)`);
  await A.screenshot({ path: path.join(SHOTS, 'nav-quote-collapsed.png') });
  await A.click('.zx-nav-link[data-key="tick"]');
  await A.waitForURL(/\/tick\//);
  await A.waitForFunction(() => document.querySelectorAll('.ccard').length > 0, null, { timeout: 15000 });
  check(await A.evaluate(() => document.documentElement.classList.contains('zx-nav-mini')), 'collapsed state remembered on next page');
  await A.click('.zx-nav-collapse');
  await A.click('.zx-nav-link[data-key="home"]');
  await A.waitForSelector('#zx-user-chip .zx-role', { timeout: 15000 });
  check(!(await A.$('#zx-login:not([hidden])')) && await A.isVisible('#continue') && (await A.textContent('#continue')).includes('打勾單'),
        'dashboard: no second login, offers「繼續使用」last system');

  // staff 看不到搬移工具
  const S = await mk(1440, 900);
  await S.goto(BASE + '/report/');
  await loginAcct(S, 'staff1@zx.test', 'staff123');
  await S.waitForSelector('#zx-user-chip .zx-role', { timeout: 15000 });
  check(await S.isHidden('.zx-nav-link[data-key="tools"]'), 'staff does not see 資料搬移');

  // 手機：抽屜
  const M = await mk(390, 844);
  await M.goto(BASE + '/');
  await loginAcct(M, 'staff2@zx.test', 'staff123');
  await M.waitForFunction(() => !document.querySelector('#kpis').classList.contains('skeleton'), null, { timeout: 15000 });
  check(await M.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'mobile dashboard: no horizontal scroll');
  await M.screenshot({ path: path.join(SHOTS, 'dashboard-mobile.png'), fullPage: true });
  check(await M.isHidden('.zx-sidebar') || (await M.$eval('.zx-sidebar', e => e.getBoundingClientRect().right)) <= 0, 'mobile: sidebar hidden by default');
  await M.click('.zx-nav-fab');
  await M.waitForTimeout(300);
  check((await M.$eval('.zx-sidebar', e => e.getBoundingClientRect().left)) >= 0, 'mobile: menu button opens drawer');
  await M.screenshot({ path: path.join(SHOTS, 'nav-mobile-open.png') });
  await M.keyboard.press('Escape');
  await M.waitForTimeout(300);
  check((await M.$eval('.zx-sidebar', e => e.getBoundingClientRect().right)) <= 0, 'mobile: Esc closes drawer');
  await M.click('.zx-nav-fab'); await M.waitForTimeout(250);
  await M.click('.zx-nav-link[data-key="report"]');
  await M.waitForSelector('#zx-user-chip .zx-role', { timeout: 15000 });
  check(M.url().includes('/report/'), 'mobile: drawer link navigates to 異常表');

  check(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.slice(0, 3).join(' | ') : ''));
  await browser.close();
  console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
