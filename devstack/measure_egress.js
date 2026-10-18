// 本機實測：各站首載、一次寫入、一則推播的實際回應位元組（閘道 /__meter 統計；未壓縮、不含 HTTP 標頭）
'use strict';
const { chromium } = require('playwright-core');
const http = require('http');
const routeCdn = require('./cdn_route');
const { login } = require('./e2e_util');
const BASE = 'http://localhost:8080';
const get = p => new Promise(r => http.get(BASE + p, res => { let b = ''; res.on('data', c => b += c); res.on('end', () => r(JSON.parse(b))); }));
const sum = m => Object.entries(m.http).filter(([k]) => !k.includes('/auth/')).reduce((s, [, v]) => s + v.bytes, 0);
(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const out = {};
  async function page() { const c = await browser.newContext(); await routeCdn(c); return c.newPage(); }
  for (const [site, ready] of [['tick', () => document.querySelectorAll('.ccard').length > 0],
                              ['report', () => document.querySelector('#zx-sync-badge').dataset.state === 'live'],
                              ['quote', () => document.querySelectorAll('#custListBody .cust-row').length > 0]]) {
    const p = await page();
    await get('/__meter/reset');
    await login(p, BASE, site, 'staff1@zx.test', 'staff123', ready);
    await p.waitForTimeout(1500);
    const m = await get('/__meter');
    out[site + '_first_load_api_bytes'] = sum(m);
    out[site + '_first_load_calls'] = Object.entries(m.http).filter(([k]) => !k.includes('/auth/')).reduce((s, [, v]) => s + v.calls, 0);
    await p.context().close();
  }
  // 一次勾選：寫入回應 + 另一台收到的推播
  const A = await page(), B = await page();
  await login(A, BASE, 'tick', 'staff1@zx.test', 'staff123', () => document.querySelectorAll('.ccard').length > 0);
  await login(B, BASE, 'tick', 'staff2@zx.test', 'staff123', () => document.querySelectorAll('.ccard').length > 0);
  await A.waitForTimeout(1500);
  await get('/__meter/reset');
  await A.click('.ccard.unordered, .ccard.warn3');
  await B.waitForTimeout(2000);
  const m = await get('/__meter');
  out.tick_click_api_bytes = sum(m);
  out.tick_click_ws_frames = m.ws.broadcasts;
  out.tick_click_ws_bytes_total = m.ws.bytes;
  // 閒置 60 秒：心跳與水位檢查
  await get('/__meter/reset');
  await A.waitForTimeout(60000);
  const idle = await get('/__meter');
  out.idle_60s_two_devices_ws_bytes = idle.ws.bytes;
  out.idle_60s_two_devices_heartbeats = idle.ws.heartbeats;
  out.idle_60s_two_devices_api_bytes = sum(idle);
  console.log(JSON.stringify(out, null, 2));
  await browser.close();
})();
