// E2E 共用：登入（逾時會留下截圖與畫面上的錯誤訊息，方便追查偶發失敗）
'use strict';
const path = require('path');
async function login(page, base, site, email, pw, extraWait) {
  await page.goto(base + '/' + site + '/');
  await page.waitForSelector('#zx-login-email', { timeout: 15000 });
  await page.fill('#zx-login-email', email);
  await page.fill('#zx-login-pw', pw);
  await page.click('.zx-login-btn');
  try {
    await page.waitForSelector('#zx-user-chip .zx-role', { timeout: 15000 });
  } catch (e) {
    const err = await page.$eval('.zx-login-err', el => el.textContent).catch(() => '(none)');
    const shot = path.join(__dirname, 'shots', `login-timeout-${site}-${Date.now()}.png`);
    await page.screenshot({ path: shot }).catch(() => {});
    throw new Error(`login timeout for ${email} on ${site}; login error text="${err}"; screenshot ${shot}`);
  }
  if (extraWait) await page.waitForFunction(extraWait, null, { timeout: 15000 });
}
module.exports = { login };
