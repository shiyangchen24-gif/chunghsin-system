// 報價單匯出系統 E2E（本機測試堆疊）：上傳精靈 → 暫存 → 另一台即時看到 → 批次匯出 → 標記已匯出；無貨號多客戶格式；權限
'use strict';
const { chromium } = require('playwright-core');
const XLSX = require('xlsx');
const ExcelJS = require('exceljs');
const fs = require('fs');
const path = require('path');
const routeCdn = require('./cdn_route');

const BASE = process.env.BASE || 'http://localhost:8080';
const SHOTS = path.join(__dirname, 'shots');
fs.mkdirSync(SHOTS, { recursive: true });
let failures = 0;
function check(cond, msg) { console.log((cond ? 'PASS: ' : 'FAIL: ') + msg); if (!cond) failures++; }

// 測試用客戶報價單：標題在第 2 列、含一列隱藏列、千分位與括號負數、兩組橫向並排「貨號/品名/單價」
function makeQuoteFile(file) {
  const rows = [
    ['某某超市 報價單', '', '', '', '', ''],
    ['貨號', '品名', '單價', '貨號', '品名', '單價'],
    ['A1', '高麗菜', '1,250', 'B1', '蘋果', '(30)'],
    ['A2', '青蔥', '', 'B2', '香蕉', '$45'],
    ['HIDDEN', '不該出現', '99', '', '', ''],
    ['A3', '新品番茄', '60', '', '', '']
  ];
  const ws = XLSX.utils.aoa_to_sheet(rows);
  ws['!rows'] = [undefined, undefined, undefined, undefined, { hidden: true }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '報價');
  XLSX.writeFile(wb, file);
}

const { login: loginAs } = require('./e2e_util');
async function login(page, email, pw) {
  await loginAs(page, BASE, 'quote', email, pw,
    () => document.querySelectorAll('#custListBody .cust-row').length > 0 || document.querySelector('#stageRow .stage-card'));
}

async function stageCount(page, key) {
  return page.$eval(`.stage-card[data-stage="${key}"] .stage-num`, e => +e.textContent.trim()).catch(() => -1);
}

(async () => {
  const quoteFile = path.join(SHOTS, 'customer-quote.xlsx');
  makeQuoteFile(quoteFile);
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const errors = [];
  const mk = async (w, h) => {
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, acceptDownloads: true });
    await routeCdn(ctx);
    const p = await ctx.newPage();
    p.on('pageerror', e => errors.push(e.message));
    p.on('dialog', d => d.accept());
    return p;
  };
  const A = await mk(1600, 1000);
  const B = await mk(1600, 1000);
  await login(A, 'staff1@zx.test', 'staff123');
  await login(B, 'staff2@zx.test', 'staff123');
  await A.waitForFunction(() => document.querySelector('#zx-sync-badge').dataset.state === 'live', null, { timeout: 10000 });
  check(true, 'quote: both devices logged in, realtime live');

  const setupBefore = await stageCount(A, 'setup');
  const readyBefore = await stageCount(B, 'ready');
  check(setupBefore === 2, `stage ① 待設定匯出格式 = ${setupBefore} (C003, C004 have no mapping)`);
  check(readyBefore === 1, `stage ③ 可批次匯出 = ${readyBefore} (C001 has migrated saved records)`);

  // 上傳精靈：C004（尚未設定格式）
  await A.click('.stage-card[data-stage="setup"]');
  await A.fill('#searchInput', 'C004');
  await A.click('#custListBody button[data-act="upload"][data-code="C004"]');
  await A.waitForSelector('#ovWizard.open');
  await A.setInputFiles('#wizFileInput', quoteFile);
  await A.waitForFunction(() => document.querySelector('.wiz-panel[data-panel="2"]').style.display === 'block', null, { timeout: 10000 });
  await A.screenshot({ path: path.join(SHOTS, 'quote-wizard-mapping.png') });
  await A.click('#wizNext');
  await A.waitForFunction(() => document.querySelector('.wiz-panel[data-panel="3"]').style.display === 'block', null, { timeout: 10000 });
  const preview = await A.$$eval('#wizResultPreviewTable tbody tr', trs => trs.map(tr => [...tr.cells].map(td => td.textContent)));
  const codes = preview.map(r => r[2]);
  check(!codes.includes('HIDDEN'), 'hidden Excel row excluded');
  check(codes.length === 5 && codes.includes('B1') && codes.includes('B2'), 'side-by-side groups expanded into 5 items: ' + codes.join(','));
  const a2 = preview.find(r => r[2] === 'A2');
  check(a2 && a2[5] === '0', 'blank price → 0 in preview');
  await A.screenshot({ path: path.join(SHOTS, 'quote-wizard-result.png') });
  const t0 = Date.now();
  await A.click('#wizExport');
  await A.waitForFunction(() => !document.querySelector('#ovWizard').classList.contains('open'), null, { timeout: 10000 });
  await B.waitForFunction(n => +document.querySelector('.stage-card[data-stage="ready"] .stage-num').textContent.trim() === n, readyBefore + 1, { timeout: 8000 });
  check(true, `device B sees C004 move to ③ 可批次匯出 via realtime in ${Date.now() - t0} ms`);

  // 第二次上傳同一客戶：新增品項比對（上次已有 5 項 → 這次全部相同，沒有新增）
  // 批次匯出（有貨號）：勾 C001 + C004 → 匯出 → 兩台都看到已匯出
  await B.click('.stage-card[data-stage="ready"]');
  await B.fill('#searchInput', '');
  await B.dispatchEvent('#searchInput', 'input');
  await B.check('#custListBody input.rowCheckbox[data-code="C001"]');
  await B.check('#custListBody input.rowCheckbox[data-code="C004"]');
  await B.evaluate(() => { window.showSaveFilePicker = undefined; });
  const [dl] = await Promise.all([B.waitForEvent('download', { timeout: 30000 }), B.click('#btnBatchExport')]);
  const outFile = path.join(SHOTS, 'quote-hascode.xlsx');
  await dl.saveAs(outFile);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(outFile);
  const ws = wb.getWorksheet('匯入格式');
  check(!!ws, 'has-code export: worksheet「匯入格式」');
  const header = ws.getRow(1).values.slice(1);
  check(header.length === 13 && header[0] === '*客戶代號' && header[12] === '變價原因', 'has-code export: 13 columns, correct headers');
  check(ws.getRow(1).getCell(1).font.name === '微軟正黑體' && ws.getRow(1).getCell(1).font.size === 11, 'font 微軟正黑體 11pt');
  const dataRows = [];
  ws.eachRow((r, i) => { if (i > 1) dataRows.push(r.values.slice(1)); });
  check(dataRows.length === 7, `exported rows = ${dataRows.length} (C001: 2 migrated + C004: 5 uploaded)`);
  const price = code => (dataRows.find(r => r[2] === code && r[0] === 'C004') || [])[5];
  check(price('A1') === 1250 && price('B1') === -30 && price('B2') === 45 && price('A2') === 0,
        `export cleans numbers: 1,250→${price('A1')}  (30)→${price('B1')}  $45→${price('B2')}  blank→${price('A2')}`);
  const c001Price = dataRows.find(r => r[2] === 'A2' && r[0] === 'C001');
  check(c001Price && c001Price[5] === '時價', 'non-numeric price 時價 preserved through migration and export');
  check(ws.getRow(2).getCell(3).numFmt === '@', 'customer item code column is text format');
  await A.waitForFunction(() => [...document.querySelectorAll('#custListBody .cust-row')].length >= 0 && window.state && state.customers.find(c => c.code === 'C004').exportStatus === '已匯出', null, { timeout: 8000 }).catch(() => {});
  const statusA = await A.evaluate(() => state.customers.find(c => c.code === 'C004').exportStatus);
  check(statusA === '已匯出', 'device A sees C004 marked 已匯出 after B exported');

  // 取消另存新檔 → 不標記已匯出
  await B.evaluate(() => { window.showSaveFilePicker = async () => { const e = new Error('cancel'); e.name = 'AbortError'; throw e; }; });
  await B.click('.stage-card[data-stage="ready"]');
  await B.check('#custListBody input.rowCheckbox[data-code="C001"]').catch(() => {});
  const before = await B.evaluate(() => state.customers.find(c => c.code === 'C001').lastExportTime);
  await B.click('#btnBatchExport');
  await B.waitForTimeout(1500);
  const after = await B.evaluate(() => state.customers.find(c => c.code === 'C001').lastExportTime);
  check(before === after, 'cancel in save dialog → not marked exported');

  // 無貨號：C002 多客戶格式
  await A.fill('#searchInput', '');
  await A.dispatchEvent('#searchInput', 'input');
  await A.click('.tab-btn[data-tab="noCode"]');
  await A.waitForFunction(() => +document.querySelector('#masterItemsCount').textContent > 0, null, { timeout: 8000 });
  await A.click('.stage-card[data-stage="ready"]');
  await A.check('#custListBody input.rowCheckbox[data-code="C002"]');
  await A.evaluate(() => { window.showSaveFilePicker = undefined; });
  const [dl2] = await Promise.all([A.waitForEvent('download', { timeout: 30000 }), A.click('#btnBatchExport')]);
  const noCodeFile = path.join(SHOTS, 'quote-nocode.xlsx');
  await dl2.saveAs(noCodeFile);
  const wb2 = new ExcelJS.Workbook();
  await wb2.xlsx.readFile(noCodeFile);
  const ws2 = wb2.getWorksheet('多客戶報價單格式');
  check(!!ws2, 'no-code export: worksheet「多客戶報價單格式」');
  check(ws2.getRow(1).getCell(1).value === '對象識別' && ws2.getRow(1).getCell(6).value === 1, 'row 1 對象識別 + customer column = 1');
  check(ws2.getRow(2).getCell(6).value === 'C002' && ws2.getRow(3).getCell(1).value === '品項代號', 'row 2 customer code, row 3 headers');
  check(ws2.getRow(1).getCell(1).fill.fgColor.argb === 'FFDEEBF7', 'A–E header fill #DEEBF7');
  check(Math.abs(ws2.getColumn(1).width - 23.875) < 0.01 && Math.abs(ws2.getColumn(5).width - 14.125) < 0.01, 'column widths 23.875 … 14.125');
  const z100 = []; ws2.eachRow((r, i) => { if (r.getCell(1).value === 'Z100') z100.push(r.getCell(6).value); });
  check(z100[0] === 30, 'Z100 price 30 in C002 column');
  let unmatchedFill = false; ws2.eachRow(r => { if (r.getCell(2).value === '奇異果') unmatchedFill = r.getCell(2).fill && r.getCell(2).fill.fgColor.argb === 'FFFFE6D1'; });
  check(unmatchedFill, 'unmatched item 奇異果 appended with orange fill');

  // 權限：staff 不能刪除客戶
  await A.click('#custListBody .cust-row[data-open-code="C002"]').catch(() => {});
  await A.waitForTimeout(300);
  const toastsBefore = await A.$$eval('.toast', t => t.length).catch(() => 0);
  await A.click('#detailCard button[data-act="delete"]').catch(() => {});
  await A.waitForTimeout(800);
  const stillThere = await A.evaluate(() => !!state.customers.find(c => c.code === 'C002'));
  check(stillThere, 'staff cannot delete a customer (admin only)');

  // 唯讀帳號
  const V = await mk(390, 844);
  await login(V, 'viewer@zx.test', 'viewer123');
  check(await V.isHidden('#btnAddCustomer'), 'viewer: 新增客戶 hidden');
  await V.screenshot({ path: path.join(SHOTS, 'quote-mobile.png') });
  await A.click('.tab-btn[data-tab="hasCode"]');
  await A.click('.stage-card[data-stage="ready"]');
  await A.click('#custListBody .cust-row[data-open-code="C001"]').catch(() => {});
  await A.waitForTimeout(400);
  await A.screenshot({ path: path.join(SHOTS, 'quote-desktop.png') });

  check(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.slice(0, 3).join(' | ') : ''));
  await browser.close();
  console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
