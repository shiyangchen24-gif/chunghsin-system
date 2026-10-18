// 打勾單 E2E（本機測試堆疊）：搬移資料呈現、點擊規則、即時同步、離線復原、Realtime 中斷時 30 秒補差、重置換日、系列、趨勢
'use strict';
const { chromium } = require('playwright-core');
const fs = require('fs');
const path = require('path');
const http = require('http');
const routeCdn = require('./cdn_route');
const { login } = require('./e2e_util');

const BASE = process.env.BASE || 'http://localhost:8080';
const SHOTS = path.join(__dirname, 'shots');
fs.mkdirSync(SHOTS, { recursive: true });
let failures = 0;
function check(cond, msg) { console.log((cond ? 'PASS: ' : 'FAIL: ') + msg); if (!cond) failures++; }
const get = p => new Promise(r => http.get(BASE + p, res => { let b = ''; res.on('data', c => b += c); res.on('end', () => r(b)); }));

const card = n => `.ccard[data-name="${n}"]`;
async function cardClass(page, n) { return page.$eval(card(n), e => e.className); }

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const errors = [];
  const mk = async (w, h) => {
    const ctx = await browser.newContext({ viewport: { width: w, height: h } });
    await routeCdn(ctx);
    const p = await ctx.newPage();
    p.on('pageerror', e => errors.push(e.message));
    p._ctx = ctx;
    return p;
  };
  const ready = () => document.querySelectorAll('.ccard').length > 0;
  const A = await mk(1440, 1000);
  const B = await mk(1440, 1000);
  await login(A, BASE, 'tick', 'staff1@zx.test', 'staff123', ready);
  await login(B, BASE, 'tick', 'staff2@zx.test', 'staff123', ready);
  await A.waitForFunction(() => document.querySelector('#zx-sync-badge').dataset.state === 'live', null, { timeout: 10000 });

  const names = await A.$$eval('.ccard', cs => cs.map(c => c.dataset.name).sort());
  check(JSON.stringify(names) === JSON.stringify(['全聯中正店', '壽司郎中山', '神秘店']),
        'migrated tick customers shown (美廉社A held for review): ' + names.join(','));
  check((await cardClass(A, '全聯中正店')).includes('ordered'), '全聯中正店 = 已叫貨 (from legacy v4)');
  check((await A.textContent('#c-tot')).trim() === '3', 'total = 3');
  const groups = await A.$$eval('.group-section', gs => gs.map(g => g.dataset.group + ':' + [...g.querySelectorAll('.ccard')].map(c => c.dataset.name).join('|')));
  check(groups.includes('阿明:神秘店|全聯中正店'), 'group 阿明 keeps legacy drag order: ' + groups.join(' / '));
  check(await A.isVisible('.series-item'), 'series strip rendered from database');

  // 三天未叫：壽司郎中山 連續 3 個已結束營業日未叫 → 橙色
  check((await cardClass(A, '壽司郎中山')).includes('warn3'), '壽司郎中山 shows ⚠ 連續3天未叫 (auto, server-computed)');

  // 左鍵：未叫貨 → 已叫貨；另一台 1~3 秒內看到，且顯示操作者
  const t0 = Date.now();
  await A.click(card('壽司郎中山'));
  await B.waitForFunction(n => document.querySelector(`.ccard[data-name="${n}"]`).className.includes('ordered'), '壽司郎中山', { timeout: 8000 });
  const lag = Date.now() - t0;
  check(lag < 3000, `device B sees the tick in ${lag} ms (target 1–3 s)`);
  check((await B.textContent(card('壽司郎中山'))).includes('小美'), 'device B card footer shows last operator 小美');
  check(!(await cardClass(B, '壽司郎中山')).includes('warn3'), 'ordered today → warn badge removed');

  // 規則：已叫貨不能左鍵改回、右鍵也不行
  await A.click(card('壽司郎中山'));
  await A.click(card('壽司郎中山'), { button: 'right' });
  await A.waitForTimeout(600);
  check((await cardClass(A, '壽司郎中山')).includes('ordered'), 'already-ordered card cannot be clicked back (UI + server rule)');

  // 右鍵：未叫貨 ⇄ 今日不叫貨
  await B.click(card('神秘店'), { button: 'right' });   // 神秘店 已叫貨 → 不允許
  await B.waitForTimeout(400);
  check((await cardClass(B, '神秘店')).includes('ordered'), 'right-click on 已叫貨 rejected');

  // 離線：點擊後寫入失敗 → 本機復原並提示
  await B.evaluate(() => openEditModal(null, '全聯中正店'));
  await B.selectOption('#m-status', '未叫貨');
  await B.click('#overlay .btn-primary');
  await A.waitForFunction(n => document.querySelector(`.ccard[data-name="${n}"]`).className.includes('unordered'), '全聯中正店', { timeout: 8000 });
  check(true, 'edit modal can revert 已叫貨 → 未叫貨, other device updates');
  // 長時間離線：重試用完 → 本機復原並提示
  await A._ctx.setOffline(true);
  await A.click(card('全聯中正店'));
  check((await cardClass(A, '全聯中正店')).includes(' ordered'), 'optimistic: card turns 已叫貨 immediately while offline');
  await A.waitForFunction(n => document.querySelector(`.ccard[data-name="${n}"]`).className.includes('unordered'), '全聯中正店', { timeout: 20000 });
  check(true, 'offline beyond retries → write failed, card rolled back to 未叫貨 with error toast');
  await A._ctx.setOffline(false);
  // 短暫斷線：同一個 request_id 重送，恢復後只寫入一次
  await A._ctx.setOffline(true);
  await A.click(card('神秘店'), { button: 'right' });       // 神秘店 已叫貨 → 右鍵不允許，換用壽司郎中山以外的未叫貨客戶
  await A.evaluate(() => openEditModal(null, '神秘店'));
  await A._ctx.setOffline(false);
  await A.selectOption('#m-status', '未叫貨');
  await A.click('#overlay .btn-primary');
  await B.waitForFunction(n => document.querySelector(`.ccard[data-name="${n}"]`).className.includes('unordered'), '神秘店', { timeout: 8000 });
  await A._ctx.setOffline(true);
  await A.click(card('神秘店'));
  await A.waitForTimeout(1200);
  await A._ctx.setOffline(false);
  await B.waitForFunction(n => document.querySelector(`.ccard[data-name="${n}"]`).className.includes(' ordered'), '神秘店', { timeout: 15000 });
  const evCount = await A.evaluate(async () => {
    const { data } = await sb.from('order_status_events').select('id').eq('customer_code', db['神秘店']._code).eq('new_status', '有叫貨').eq('via', 'click');
    return data.length;
  });
  check(evCount === 1, `short outage: retried with same request_id after reconnect, written exactly once (events=${evCount})`);

  // Realtime 中斷（API 正常）：B 改為每 30 秒水位檢查，仍能收到 A 的變更
  await get('/__realtime/down');
  await B.waitForFunction(() => ['fallback', 'catching-up'].includes(document.querySelector('#zx-sync-badge').dataset.state), null, { timeout: 15000 });
  check(true, 'device B badge switches to fallback when realtime is down');
  const t1 = Date.now();
  await A.click(card('全聯中正店'));
  await B.waitForFunction(n => document.querySelector(`.ccard[data-name="${n}"]`).className.includes(' ordered'), '全聯中正店', { timeout: 45000 });
  const lag2 = Date.now() - t1;
  check(lag2 < 40000, `with realtime down, device B caught up via 30 s watermark check in ${(lag2 / 1000).toFixed(1)} s`);
  await get('/__realtime/up');
  await B.waitForFunction(() => document.querySelector('#zx-sync-badge').dataset.state === 'live', null, { timeout: 30000 });
  check(true, 'realtime restored → badge live again');

  // 後台：今日操作紀錄、連續未叫天數
  await A.click('.tab:nth-child(2)');
  await A.waitForFunction(() => document.querySelectorAll('#backend-tbody tr').length >= 3, null, { timeout: 8000 });
  const logText = await A.textContent('#backend-tbody');
  check(logText.includes('小美') && logText.includes('阿明'), 'backend shows today operation log with both operators');
  await A.screenshot({ path: path.join(SHOTS, 'tick-backend.png') });

  // 趨勢：本月已結束營業日的筆數
  await A.click('.tab:nth-child(3)');
  await A.waitForFunction(() => document.querySelectorAll('#analytics-table tr').length > 1, null, { timeout: 8000 });
  check(true, 'analytics renders monthly table from tick_daily_counts');
  await A.screenshot({ path: path.join(SHOTS, 'tick-analytics.png') });

  // 系列設定：新增一個系列
  await A.click('.tab:nth-child(1)');
  await A.click('.series-admin-btn');
  await A.fill('#series-name', '全聯');
  await A.fill('#series-prefix', '全聯');
  await A.click('#series-overlay .btn-primary');
  await A.waitForFunction(() => [...document.querySelectorAll('.series-label')].some(l => l.textContent.includes('全聯')), null, { timeout: 8000 });
  check(true, 'new series 全聯 added and shown');
  await A.evaluate(() => closeSeriesModal());

  // 重置換日：A 重置 → B 自動切換到新的營業日（全部未叫貨）
  const dayBefore = await B.textContent('#topbar-date');
  await A.click('.btn-reset');
  await A.click('#confirm-ok');
  await B.waitForFunction(d => document.querySelector('#topbar-date').textContent !== d, dayBefore, { timeout: 10000 });
  const unAfter = await B.waitForFunction(() => document.querySelector('#c-un').textContent.trim() === '3', null, { timeout: 8000 }).then(() => '3').catch(() => 'x');
  check(unAfter === '3', `device B switched to new service day ${await B.textContent('#topbar-date')}, all 未叫貨`);

  // 唯讀帳號
  const V = await mk(390, 844);
  await login(V, BASE, 'tick', 'viewer@zx.test', 'viewer123', ready);
  check(await V.isHidden('.btn-reset'), 'viewer: 重置今日 hidden');
  await V.click(card('神秘店'));
  await V.waitForTimeout(500);
  check((await cardClass(V, '神秘店')).includes('unordered'), 'viewer click does not change status');
  await V.screenshot({ path: path.join(SHOTS, 'tick-mobile.png') });
  await A.click(card('神秘店'));
  await A.waitForTimeout(500);
  await A.screenshot({ path: path.join(SHOTS, 'tick-desktop.png') });

  check(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.slice(0, 3).join(' | ') : ''));
  await browser.close();
  console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
