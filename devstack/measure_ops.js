// 本機實測：7 種操作各自造成的 Supabase 傳輸量（閘道 /__meter；未壓縮、不含 HTTP 標頭）
//   上行（網頁→Supabase）不計入 Supabase Egress；下行（Supabase→網頁，含推播）才計費
// 測試資料內容是固定的範例文字，正式資料的每列大小請用「每列固定負擔 + 文字長度」換算
'use strict';
const { chromium } = require('playwright-core');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');
const routeCdn = require('./cdn_route');
const { login } = require('./e2e_util');
const BASE = 'http://localhost:8080';
const get = p => new Promise(r => http.get(BASE + p, res => { let b = ''; res.on('data', c => b += c); res.on('end', () => r(JSON.parse(b))); }));
const api = m => Object.entries(m.http).filter(([k]) => !k.includes('/auth/'));
const down = m => api(m).reduce((s, [, v]) => s + v.bytes, 0);
const calls = m => api(m).reduce((s, [, v]) => s + v.calls, 0);
const psql = sql => execSync(`psql -h /var/tmp/zxsock -p 5544 -U postgres -d zxdev -At -c "${sql.replace(/"/g, '\\"')}"`).toString().trim();

(async () => {
  // 量測用資料：今天 120 筆異常、120 筆交接、C001 有 200 個報價品項（內容為固定範例文字）
  psql(`insert into abnormal_reports (report_date, store, car_no, reason, exchange_type, category, responsibility, note)
        select (now() at time zone 'Asia/Taipei')::date, '全聯中正店', 'ABC-1234', '10/19 高麗菜 2箱 爛', '退貨', 'A 品質', '倉儲', ''
        from generate_series(1,120)`);
  psql(`insert into handover_reports (report_date, store, content)
        select (now() at time zone 'Asia/Taipei')::date, '全聯中正店', '明天改送下午三點後' from generate_series(1,120)`);
  psql(`insert into customer_quote_items (customer_code, list_kind, line_no, item_code, item_name, unit, price, note)
        select 'C001', 'saved', 100 + g, 'A' || lpad(g::text, 5, '0'), '高麗菜（初秋）', '公斤', '35', '' from generate_series(1,200) g`);
  psql(`update customer_quote_profiles set saved_records_count = (select count(*) from customer_quote_items where customer_code='C001' and list_kind='saved') where customer_code='C001'`);

  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  async function page() { const c = await browser.newContext({ acceptDownloads: true }); await routeCdn(c); return c.newPage(); }
  const out = {};
  const measure = async (name, fn, settle = 1500) => {
    await get('/__meter/reset');
    const extra = await fn();
    await new Promise(r => setTimeout(r, settle));
    const m = await get('/__meter');
    out[name] = Object.assign({ down_bytes: down(m), api_calls: calls(m), ws_broadcast_frames: m.ws.broadcasts, ws_bytes: m.ws.bytes }, extra || {});
  };

  const tickReady = () => document.querySelectorAll('.ccard').length > 0;
  const A = await page(), B = await page();
  await login(A, BASE, 'tick', 'staff1@zx.test', 'staff123', tickReady);
  await login(B, BASE, 'tick', 'staff2@zx.test', 'staff123', tickReady);
  await A.waitForTimeout(2000);
  // 1. 打勾單卡片狀態變更（A 點一下，B 收到）
  await measure('tick_card_change_2_devices', async () => { await A.click('.ccard.unordered, .ccard.warn3'); });
  // 2. 打勾單匯入 Excel（列印用的客戶清單範本）
  const xlsx = path.join(__dirname, 'shots', 'measure_tick.xlsx');
  const XLSX = require('xlsx');
  const wb = XLSX.utils.book_new();
  const names = await A.$$eval('.ccard', cs => cs.map(c => c.dataset.name));
  const day = await A.evaluate(() => today.getDate());   // 匯入時以「今天幾日」的數字欄位對應
  const rows = [['客戶', day, '客戶', day]];
  for (let i = 0; i < 60; i++) rows.push([names[i % names.length], '', names[(i + 1) % names.length], '']);
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), '打勾單');
  XLSX.writeFile(wb, xlsx);
  await measure('tick_import_excel', async () => {
    await A.setInputFiles('#excel-import', xlsx);
    await A.waitForTimeout(1000);
    return { status: await A.textContent('#import-status') };
  });
  // 3. 打勾單匯出 Excel（在匯入的範本上標記已叫貨）
  await measure('tick_export_excel', async () => {
    const dl = A.waitForEvent('download', { timeout: 8000 }).then(() => true, () => false);
    const err = await A.evaluate(() => { try { exportExcel(); return null; } catch (e) { return e.message; } });
    return { downloaded: await dl, has_imported_wb: await A.evaluate(() => !!importedWbData), error: err };
  });

  // 4／5. 異常表、交接表匯出 Excel（今天 120+ 筆；開頁已載入 50 筆，匯出時補齊其餘）
  const R = await page();
  await login(R, BASE, 'report', 'staff1@zx.test', 'staff123', () => document.querySelector('#zx-sync-badge').dataset.state === 'live');
  await R.waitForTimeout(1500);
  await R.evaluate(() => { window.showSaveFilePicker = undefined; });   // 走 a[download]
  const ab0 = await R.evaluate(() => document.querySelectorAll('#ab-tbody tr[data-ab-id]').length);
  await measure('report_abnormal_export_excel', async () => {
    const [dl] = await Promise.all([R.waitForEvent('download'), R.evaluate(() => exportAbnormalExcel())]);
    await dl.path();
    return { rows_total: +psql(`select count(*) from abnormal_reports where report_date = (now() at time zone 'Asia/Taipei')::date`), rows_visible_before: ab0 };
  });
  await R.click('.tab[data-type="handover"]');
  await R.waitForTimeout(1500);
  await measure('report_handover_export_excel', async () => {
    const [dl] = await Promise.all([R.waitForEvent('download'), R.evaluate(() => exportHandoverExcel())]);
    await dl.path();
    return { rows_total: +psql(`select count(*) from handover_reports where report_date = (now() at time zone 'Asia/Taipei')::date`) };
  });

  // 6／7. 報價：設定匯出格式（儲存欄位對應）、匯出（讀品項＋標記已匯出）
  const Q = await page(), Q2 = await page();
  const quoteReady = () => document.querySelectorAll('#custListBody .cust-row').length > 0;
  await login(Q, BASE, 'quote', 'staff1@zx.test', 'staff123', quoteReady);
  await login(Q2, BASE, 'quote', 'staff2@zx.test', 'staff123', quoteReady);
  await Q.waitForTimeout(2000);
  await measure('quote_set_export_format', async () => {
    await Q.evaluate(async () => {
      const r = await sb.rpc('quote_set_mapping', { p_customer_code: 'C002', p_mapping: { dataStartRowIdx: 2, columnMap: { 0: '品名', 1: '單位', 2: '單價', 3: '備註' } } });
      if (r.error) throw r.error;
    });
  });
  await measure('quote_export_1_customer_200_items', async () => {
    const n = await Q.evaluate(async () => {
      const recs = await fetchSavedRecords('C001');
      const r = await sb.rpc('quote_mark_exported', { p_filename: 'measure.xlsx', p_items: [{ customer_code: 'C001', item_count: recs.length }], p_request_id: zxSync.uuid() });
      if (r.error) throw r.error;
      return recs.length;
    });
    return { items: n };
  });
  console.log(JSON.stringify(out, null, 2));
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
