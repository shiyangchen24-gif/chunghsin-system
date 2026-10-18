// 三站整合側邊欄 E2E：首頁 → 側邊欄切換三站、反白、角色、收合、手機抽屜、列印隱藏
'use strict';
const { chromium } = require('playwright-core');
const path = require('path');
const routeCdn = require('./cdn_route');
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
  check((await A.$$('.sys')).length === 3, 'home page has 3 system cards');
  await A.screenshot({ path: path.join(SHOTS, 'nav-home.png') });

  await A.click('.zx-nav-link[data-key="tick"]');
  await A.fill('#zx-login-email', 'admin@zx.test'); await A.fill('#zx-login-pw', 'admin123'); await A.click('.zx-login-btn');
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
  check(await A.isVisible('#continue') && (await A.textContent('#continue')).includes('打勾單'), 'home offers「繼續使用」last system');

  // staff 看不到搬移工具
  const S = await mk(1440, 900);
  await S.goto(BASE + '/report/');
  await S.fill('#zx-login-email', 'staff1@zx.test'); await S.fill('#zx-login-pw', 'staff123'); await S.click('.zx-login-btn');
  await S.waitForSelector('#zx-user-chip .zx-role', { timeout: 15000 });
  check(await S.isHidden('.zx-nav-link[data-key="tools"]'), 'staff does not see 資料搬移');

  // 手機：抽屜
  const M = await mk(390, 844);
  await M.goto(BASE + '/');
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
  await M.waitForSelector('#zx-login-email');
  check(true, 'mobile: drawer link navigates to 異常表');

  check(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.slice(0, 3).join(' | ') : ''));
  await browser.close();
  console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
