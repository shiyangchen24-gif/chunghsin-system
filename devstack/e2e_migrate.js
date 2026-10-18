// 搬移工具 E2E：空的新專案 → 工具從「舊專案」（第二個 PostgREST）讀取 → 寫入暫存 → 07_backfill → 08_verify → 新站看得到資料
'use strict';
const { chromium } = require('playwright-core');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const routeCdn = require('./cdn_route');
const { login } = require('./e2e_util');
const BASE = 'http://localhost:8080';
let failures = 0;
function check(c, m) { console.log((c ? 'PASS: ' : 'FAIL: ') + m); if (!c) failures++; }
const P = 'psql -h /var/tmp/zxsock -p 5544 -U postgres -q -At -d zxdev';
const sql = q => execSync(P, { input: q }).toString().trim();

(async () => {
  const anon = fs.readFileSync(path.join(__dirname, '.anon_key'), 'utf8').trim();
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 1000 } });
  await routeCdn(ctx);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('dialog', d => d.accept());
  await page.goto(BASE + '/tools/migrate.html');
  if (await page.isVisible('#zx-login-email')) {
    await page.fill('#zx-login-email', 'admin@zx.test'); await page.fill('#zx-login-pw', 'admin123'); await page.click('.zx-login-btn');
  }
  await page.waitForSelector('#zx-user-chip .zx-role', { timeout: 15000 });
  for (const s of ['tick', 'report', 'quote']) {
    await page.fill(`#src-${s}-url`, BASE + '/old');
    await page.fill(`#src-${s}-key`, anon);
  }
  await page.click('#btn-check');
  await page.waitForFunction(() => !document.querySelector('#btn-run').disabled, null, { timeout: 20000 });
  check((await page.textContent('#cnt-report')).trim() === '1234 / 1', 'source counts read: report ' + (await page.textContent('#cnt-report')));
  await page.click('#btn-run');
  await page.waitForFunction(() => document.querySelector('#log').textContent.includes('全部完成') || document.querySelector('#log').textContent.includes('項失敗'), null, { timeout: 120000 });
  const logText = await page.textContent('#log');
  check(logText.includes('全部完成'), 'migration tool finished all 5 jobs');
  await page.screenshot({ path: path.join(__dirname, 'shots', 'migrate-tool.png') });
  check(sql('select count(*) from public.abnormal_reports') === '1234', 'abnormal_reports: 1234 rows moved (more than one 1000-row page)');
  check(sql('select count(*) from public.master_items') === '2500', 'master_items: 2500 rows moved');
  check(sql('select count(*) from public."Chunghsin_store"') === '7', 'Chunghsin_store: 7 keys moved');
  // 再跑一次：不得重複
  await page.click('#btn-run');
  await page.waitForFunction(() => (document.querySelector('#log').textContent.match(/全部完成/g) || []).length >= 2, null, { timeout: 120000 });
  check(sql('select count(*) from public.abnormal_reports') === '1234', 'running the tool twice does not duplicate rows');

  execSync(`${P} -v ON_ERROR_STOP=1 -f /home/user/zhongxin-sites/supabase/sql/07_backfill.sql`, { stdio: 'pipe' });
  const verify = execSync(`${P} -f /home/user/zhongxin-sites/supabase/sql/08_verify.sql`).toString();
  check(!/\|f$/m.test(verify.split('\n').filter(l => /\|(t|f)$/.test(l)).join('\n')), '08_verify: all ok = true');
  check(sql("select count(*) from public.abnormal_reports where report_date is not null") === '1234', 'all migrated abnormal rows got report_date');
  check(sql("select code from public.customers where name = '神秘店'").startsWith('TK'), 'tick-only customer 神秘店 got provisional TK code');

  const t = await ctx.newPage();
  await t.goto(BASE + '/tick/');
  await t.waitForFunction(() => document.querySelectorAll('.ccard').length >= 3, null, { timeout: 15000 });
  check(true, 'tick site shows migrated customers (' + (await t.$$('.ccard')).length + ' cards)');
  const r = await ctx.newPage();
  await r.goto(BASE + '/report/');
  await r.click('#ab-range [data-preset="all"]');
  await r.waitForFunction(() => document.querySelector('#ab-count').textContent.includes('50+'), null, { timeout: 15000 });
  check(true, 'report site pages migrated rows 50 at a time (shows 50+)');

  check(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
  await browser.close();
  console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
