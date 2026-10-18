// 異常表／交接表 E2E（本機測試堆疊）：兩台「裝置」同時開啟，驗證登入、新增、即時同步、衝突、權限、列印與匯出
'use strict';
const { chromium } = require('playwright-core');
const fs = require('fs');
const path = require('path');
const routeCdn = require('./cdn_route');

const BASE = process.env.BASE || 'http://localhost:8080';
const SHOTS = path.join(__dirname, 'shots');
fs.mkdirSync(SHOTS, { recursive: true });
let failures = 0;
function check(cond, msg) { console.log((cond ? 'PASS: ' : 'FAIL: ') + msg); if (!cond) failures++; }

const { login: loginAs } = require('./e2e_util');
async function login(page, email, pw) { await loginAs(page, BASE, 'report', email, pw); }

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const errors = [];
  const mk = async (w, h) => {
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, acceptDownloads: true });
    await routeCdn(ctx);
    const p = await ctx.newPage();
    p.on('pageerror', e => errors.push(e.message));
    p.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
    return p;
  };
  const A = await mk(1400, 1000);   // 裝置 A：staff1
  const B = await mk(1400, 1000);   // 裝置 B：admin

  await login(A, 'staff1@zx.test', 'staff123');
  await login(B, 'admin@zx.test', 'admin123');
  check(await A.textContent('#zx-user-chip') .then(t => t.includes('小美')), 'device A logged in as 小美 (staff)');
  await A.waitForFunction(() => document.querySelector('#zx-sync-badge').dataset.state === 'live', null, { timeout: 10000 });
  check(true, 'device A realtime badge = live');

  // 全部範圍：搬移資料應出現（3 筆異常）
  await A.click('#ab-range [data-preset="all"]');
  await A.waitForFunction(() => document.querySelectorAll('#ab-tbody tr[data-ab-id]').length >= 3);
  check((await A.$$('#ab-tbody tr[data-ab-id]')).length === 3, 'range=全部 shows 3 migrated abnormal rows');
  check(await A.isHidden('#ab-tbody .btn-ghost[aria-label="刪除"]'), 'staff sees no ✕ delete buttons');

  // 今天：新增一筆 → 裝置 B 1~3 秒內看到
  await A.click('#ab-range [data-preset="today"]');
  await B.click('#ab-range [data-preset="today"]');
  await A.fill('#ab-store', '全聯中正店');
  await A.dispatchEvent('#ab-store', 'input');
  await A.waitForFunction(() => document.querySelector('#ab-car-source').textContent.includes('車號來源'), null, { timeout: 5000 });
  check((await A.inputValue('#ab-carNo')) === 'ABC-123', 'store autofill → car ABC-123 from latest history, with source label');
  await A.fill('#ab-reason', '10/18 高麗菜 3箱 壓傷');
  const t0 = Date.now();
  await A.click('#form-abnormal .btn-primary');
  await B.waitForFunction(() => [...document.querySelectorAll('#ab-tbody td')].some(td => td.textContent.includes('壓傷')), null, { timeout: 8000 });
  const lag = Date.now() - t0;
  check(lag < 3000, `device B received new row via realtime in ${lag} ms (target 1–3 s)`);
  check((await A.textContent('#ab-count')).trim() === '1', 'device A count = 1 for today');

  // 衝突：A 開行內編輯，B 先改同一筆 → A 保留草稿並顯示提示
  const rowId = await A.getAttribute('#ab-tbody tr[data-ab-id]', 'data-ab-id');
  await A.click(`#ab-tbody tr[data-ab-id="${rowId}"] .btn-ghost[aria-label="編輯"]`);
  await A.fill(`#edit-ab-note-${rowId}`, 'A 的草稿');
  await B.click(`#ab-tbody tr[data-ab-id="${rowId}"] .btn-ghost[aria-label="編輯"]`);
  await B.fill(`#edit-ab-responsibility-${rowId}`, '倉儲');
  await B.click('.inline-edit-row .btn-primary');
  await A.waitForSelector('.edit-conflict', { timeout: 8000 });
  check((await A.inputValue(`#edit-ab-note-${rowId}`)) === 'A 的草稿', 'A keeps its draft and shows「資料已在別處更新」');
  await A.screenshot({ path: path.join(SHOTS, 'report-conflict.png') });
  await A.click('[data-conflict="overwrite"]');
  await B.waitForFunction(id => document.querySelector(`tr[data-ab-id="${id}"]`).textContent.includes('A 的草稿'), rowId, { timeout: 8000 });
  check(true, 'A overwrote deliberately; B sees the result');

  // 刪除只限 admin：B(admin) 刪除 → A 即時移除
  B.once('dialog', d => d.accept());
  await B.click(`#ab-tbody tr[data-ab-id="${rowId}"] .btn-ghost[aria-label="刪除"]`);
  await A.waitForFunction(id => !document.querySelector(`tr[data-ab-id="${id}"]`), rowId, { timeout: 8000 });
  check(true, 'admin delete propagates to device A (tombstone)');

  // 交接表 + 列印預覽 + 匯出 Excel（原版格式）
  await A.click('.tab[data-type="handover"]');
  await A.fill('#ho-store', '美廉社A XYZ-9');
  await A.fill('#ho-content', '明早 7 點前送達');
  await A.click('#form-handover .btn-primary');
  await A.waitForFunction(() => document.querySelector('#ho-count').textContent.trim() === '1');
  await A.click('[onclick="openHandoverPrintPreview()"]');
  await A.waitForSelector('#print-preview-overlay.show');
  const title = await A.textContent('.ho-print-table thead th');
  check(/\d+月\d+日交接事項/.test(title), 'handover print preview title = M月D日交接事項');
  await A.screenshot({ path: path.join(SHOTS, 'report-print-preview.png') });
  await A.click('.preview-actions .btn-secondary');

  await A.click('.tab[data-type="abnormal"]');
  await A.click('#ab-range [data-preset="all"]');
  await A.waitForFunction(() => document.querySelectorAll('#ab-tbody tr[data-ab-id]').length >= 3);
  // 沒有 showSaveFilePicker 的情境：走 a[download]
  await A.evaluate(() => { window.showSaveFilePicker = undefined; });
  const [dl] = await Promise.all([A.waitForEvent('download', { timeout: 20000 }), A.click('[onclick="exportAbnormalExcel()"]')]);
  const file = path.join(SHOTS, 'abnormal.xlsx');
  await dl.saveAs(file);
  check(fs.statSync(file).size > 5000, 'abnormal Excel downloaded (' + fs.statSync(file).size + ' bytes)');

  // 手機版
  const M = await mk(390, 844);
  await login(M, 'viewer@zx.test', 'viewer123');
  await M.waitForTimeout(800);
  check(await M.isDisabled('#form-abnormal .btn-primary'), 'viewer: add button disabled (read-only)');
  await M.screenshot({ path: path.join(SHOTS, 'report-mobile.png'), fullPage: false });
  await A.click('#ab-range [data-preset="today"]');
  await A.waitForTimeout(300);
  await A.screenshot({ path: path.join(SHOTS, 'report-desktop.png'), fullPage: false });

  check(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.slice(0, 3).join(' | ') : ''));
  await browser.close();
  console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
