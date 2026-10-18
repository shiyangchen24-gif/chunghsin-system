// 免帳號使用 E2E：輸入暱稱即可使用、操作紀錄顯示暱稱、後台看得到裝置 IP、停用裝置、關閉暱稱登入；
// 以及儀表板「異常狀態分析」與「經營月報」
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
  async function mk(ip, w = 1440, h = 900) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, extraHTTPHeaders: ip ? { 'X-Forwarded-For': ip } : {} });
    await routeCdn(ctx);
    const p = await ctx.newPage();
    p.on('pageerror', e => errors.push(e.message));
    return p;
  }
  const dashReady = p => p.waitForFunction(() => !document.querySelector('#kpis').classList.contains('skeleton') &&
                                                 !/讀取中/.test(document.getElementById('aa-summary').textContent), null, { timeout: 15000 });

  // 1. 新裝置：只輸入暱稱就能用
  const N = await mk('203.0.113.21');
  await N.goto(BASE + '/');
  check(await N.isVisible('#zx-login-nick') && await N.isHidden('#zx-login-email'), 'login screen asks only for a nickname');
  await N.screenshot({ path: path.join(SHOTS, 'access-login.png') });
  await N.click('.zx-login-start');
  check((await N.textContent('.zx-login-err')).includes('請輸入暱稱'), 'empty nickname rejected');
  await N.fill('#zx-login-nick', '小陳'); await N.click('.zx-login-start');
  await dashReady(N);
  check((await N.textContent('#hello')).includes('小陳'), 'nickname device enters dashboard without an account');
  check(await N.isHidden('.zx-nav-link[data-key="devices"]') && await N.isHidden('.zx-nav-link[data-key="logout"]'),
        'nickname device: no 裝置管理, no 登出 (would lose device identity)');
  const sum = await N.textContent('#aa-summary');
  check(/\d+ 筆異常|沒有異常/.test(sum) && (await N.$$('#aa-cat .zxc-bars li')).length > 0, 'dashboard abnormal analysis rendered: ' + sum.slice(0, 40));
  await N.click('#aa-seg button[data-days="90"]');
  await N.waitForFunction(() => /近 90 天/.test(document.getElementById('aa-summary').textContent), null, { timeout: 10000 });
  check(true, 'analysis range switch to 90 days');

  // 打勾單：暱稱出現在最後操作者
  await N.click('.zx-nav-link[data-key="tick"]');
  await N.waitForFunction(() => document.querySelectorAll('.ccard').length > 0, null, { timeout: 15000 });
  check(!(await N.$('#zx-login:not([hidden])')), 'same device opens 打勾單 without asking again');
  const name = await N.$eval('.ccard.unordered, .ccard.warn3', c => c.dataset.name);
  await N.click(`.ccard[data-name="${name}"]`);
  await N.waitForFunction(n => document.querySelector(`.ccard[data-name="${n}"]`).textContent.includes('小陳'), name, { timeout: 8000 });
  check(true, `tick by nickname device shows 小陳 as last operator on ${name}`);

  // 再開一次：已記住，不必重輸
  await N.goto(BASE + '/report/');
  await N.waitForSelector('#zx-user-chip .zx-role', { timeout: 15000 });
  check(!(await N.$('#zx-login:not([hidden])')) && (await N.textContent('#zx-user-chip')).includes('改暱稱'), 'reopen: remembered, chip offers 改暱稱');

  // 2. 經營月報
  await N.goto(BASE + '/reports/monthly.html');
  await N.waitForFunction(() => !document.querySelector('#points .muted'), null, { timeout: 15000 });
  const pts = await N.$$eval('#points li', l => l.map(x => x.textContent));
  check(pts.length >= 4 && pts.some(t => t.includes('營業')) && pts.some(t => t.includes('報價匯出')), `monthly report key points (${pts.length})`);
  check((await N.$$('#kpis .kpi')).length === 8 && await N.$('#tick-chart svg path[stroke-dasharray]'), 'monthly KPIs and daily curve');
  check(await N.$('#ab-cat .zxc-bars') && await N.$('#low table, #low p'), 'monthly abnormal breakdown and low-order customers');
  await N.screenshot({ path: path.join(SHOTS, 'monthly.png'), fullPage: true });
  await N.emulateMedia({ media: 'print' });
  check(await N.isHidden('.zx-sidebar') && await N.isVisible('.doc-head') && await N.isHidden('#print'), 'monthly print: doc header, no sidebar/buttons');
  await N.emulateMedia({ media: 'screen' });

  // 3. 管理員：裝置管理看得到 IP，可停用
  const A = await mk('198.51.100.5');
  await A.goto(BASE + '/tools/devices.html');
  check(await A.isVisible('#zx-login-email') && await A.isHidden('#zx-login-nick'), 'devices page asks for an admin account (no nickname option)');
  await loginAcct(A, 'admin@zx.test', 'admin123');
  await A.waitForSelector('#rows tr[data-id]', { timeout: 15000 });
  const row = await A.$$eval('#rows tr', rs => (rs.find(r => r.textContent.includes('小陳')) || {}).innerText || '');
  check(row.includes('203.0.113.21') && row.includes('暱稱裝置'), 'admin sees nickname device with its IP 203.0.113.21');
  await A.screenshot({ path: path.join(SHOTS, 'devices.png') });
  A.once('dialog', d => d.accept());
  await A.click('#rows tr:has-text("小陳") button[data-act="toggle"]');
  await A.waitForFunction(() => [...document.querySelectorAll('#rows tr')].some(r => r.textContent.includes('小陳') && r.textContent.includes('已停用')), null, { timeout: 8000 });
  await N.goto(BASE + '/');
  await N.waitForFunction(() => /停用/.test((document.querySelector('.zx-login-err') || {}).textContent || ''), null, { timeout: 15000 });
  check(true, 'blocked device sees「已被管理員停用」and cannot use the system');
  const w = await N.evaluate(async () => (await window.sb.from('daily_order_status').select('id').limit(1)).data || []);
  check(w.length === 0, 'blocked device reads no data (RLS)');

  // 4. 關閉暱稱登入 → 新裝置被擋
  await A.uncheck('#allow');
  await A.waitForTimeout(500);
  const X = await mk('192.0.2.9');
  await X.goto(BASE + '/');
  await X.fill('#zx-login-nick', '路人'); await X.click('.zx-login-start');
  await X.waitForFunction(() => /關閉暱稱登入/.test(document.querySelector('.zx-login-err').textContent), null, { timeout: 10000 });
  check(true, 'nickname access turned off → new device refused');
  await A.check('#allow');

  check(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.slice(0, 3).join(' | ') : ''));
  await browser.close();
  console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
