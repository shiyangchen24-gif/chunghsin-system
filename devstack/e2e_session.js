// 登入穩定性 E2E：token 到期、續期暫時失敗、refresh token 失效時，切換頁面不能把使用者踢出或要求重新登記
// （重現正式環境「重置今日後切到異常表會跳出、出現 permission denied for function device_register」的問題）
'use strict';
const { chromium } = require('playwright-core');
const http = require('http');
const routeCdn = require('./cdn_route');
const BASE = 'http://localhost:8080';
let failures = 0;
function check(c, m) { console.log((c ? 'PASS: ' : 'FAIL: ') + m); if (!c) failures++; }
const get = p => new Promise(r => http.get(BASE + p, res => { let b = ''; res.on('data', c => b += c); res.on('end', () => r(JSON.parse(b))); }));
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await routeCdn(ctx);
  const p = await ctx.newPage();
  const errors = [], denied = [];
  p.on('pageerror', e => errors.push(e.message));
  const logs = []; p.on('console', m => logs.push(m.type() + ': ' + m.text().slice(0, 160)));
  p.on('response', async r => {
    if (r.status() === 401 || r.status() === 403) denied.push(r.status() + ' ' + r.url().replace(BASE, '').split('?')[0]);
  });
  const uid = () => p.evaluate(async () => (await window.sb.auth.getSession()).data.session?.user?.id || null);
  const gateShown = () => p.isVisible('#zx-login');
  const ready = (sel, t) => p.waitForSelector(sel, { timeout: t || 20000 }).then(() => true, () => false);

  try {
    await get('/__auth/config?ttl=4&failRefresh=0&revokeRefresh=0');
    await p.goto(BASE + '/tick/');
    await p.fill('#zx-login-nick', '小陳'); await p.click('.zx-login-start');
    await p.waitForFunction(() => document.querySelectorAll('.ccard').length > 0, null, { timeout: 15000 });
    const id0 = await uid();
    check(!!id0, 'nickname device signed in');

    // 重置今日（正式環境回報的操作）
    await p.click('button.btn-reset'); await p.click('#confirm-ok');
    await p.waitForTimeout(1500);

    // 1. token 已到期 + 接下來 3 次續期暫時失敗（503）→ 切到異常表：不應出現登入框、身分不變
    await sleep(5000);
    await get('/__auth/config?failRefresh=3');
    denied.length = 0;
    await p.click('.zx-nav-link[data-key="report"]');
    const ok1 = await ready('#zx-user-chip .zx-role');
    check(ok1 && !(await gateShown()), 'expired token + 3 failed renewals → 異常表 opens without login box');
    check((await uid()) === id0, 'same device identity kept (no re-registration)');
    check(!denied.some(d => d.includes('device_register')), 'no permission denied on device_register' + (denied.length ? ' (' + denied.join(', ') + ')' : ''));

    // 2. 頁面開著時 token 到期、續期暫時失敗 → 寫入仍成功（不會以匿名身分送出）
    await p.click('.zx-nav-link[data-key="tick"]');
    await p.waitForFunction(() => document.querySelectorAll('.ccard').length > 0, null, { timeout: 15000 });
    await sleep(5000);
    await get('/__auth/config?failRefresh=2');
    const name = await p.$eval('.ccard.unordered, .ccard.warn3', c => c.dataset.name);
    await p.click(`.ccard[data-name="${name}"]`);
    const wrote = await p.waitForFunction(n => document.querySelector(`.ccard[data-name="${n}"]`).className.includes('ordered')
                                         && !document.querySelector(`.ccard[data-name="${n}"]`).className.includes('unordered'), name, { timeout: 15000 }).then(() => true, () => false);
    await p.waitForTimeout(1500);
    const st = await p.evaluate(async n => { const c = db[n]._code; const r = await sb.from('daily_order_status').select('status').eq('customer_code', c).eq('service_date', serviceDateISO).maybeSingle(); return r.data && r.data.status; }, name);
    check(wrote && st === '有叫貨', `tick after token expiry with failed renewals is saved on the server (${name}: ${st})`);

    // 2b. 較長的續期中斷（連續 8 次失敗）→ 切到經營月報：應該等到續期成功，不能出現暱稱登記畫面或 permission denied
    await sleep(5000);
    await get('/__auth/config?failRefresh=8');
    denied.length = 0;
    await p.click('.zx-nav-link[data-key="monthly"]');
    const t2b = Date.now();
    const ok2b = await ready('#zx-user-chip .zx-role', 60000);
    console.log('  2b recovered after', ((Date.now() - t2b) / 1000).toFixed(1), 's');
    if (!(ok2b && !(await gateShown()))) {
      await p.screenshot({ path: require('path').join(__dirname, 'shots', 'session-2b.png') });
      console.log('DEBUG 2b: gate', await gateShown(), 'err=', await p.textContent('.zx-login-err').catch(() => ''), 'denied=', denied.join(','), 'cfg=', JSON.stringify(await get('/__auth/config')), 'logs=', JSON.stringify(logs.slice(-8)));
    }
    check(ok2b && !(await gateShown()) && (await uid()) === id0 && !denied.some(d => d.includes('device_register')),
          'long renewal outage (8 failures) → page waits and recovers, same identity, no nickname prompt');

    // 3. refresh token 永久失效（例如被撤銷）→ 切頁：自動以同一暱稱重新登記，不跳出登入框
    await sleep(5000);
    await get('/__auth/config?revokeRefresh=5');
    await p.click('.zx-nav-link[data-key="quote"]');
    const ok3 = await ready('#zx-user-chip .zx-role');
    check(ok3 && !(await gateShown()) && (await p.textContent('#zx-user-chip')).includes('小陳'),
          'refresh token revoked → silently re-registered as 小陳, no login box');
  } finally {
    await get('/__auth/config?ttl=3600&failRefresh=0&revokeRefresh=0');
  }
  check(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.slice(0, 3).join(' | ') : ''));
  await browser.close();
  console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); get('/__auth/config?ttl=3600&failRefresh=0&revokeRefresh=0').finally(() => process.exit(2)); });
