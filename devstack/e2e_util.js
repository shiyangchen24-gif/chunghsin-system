// E2E 共用：登入（逾時會留下截圖與畫面上的錯誤訊息，方便追查偶發失敗）
'use strict';
const path = require('path');
// 登入畫面預設是「輸入暱稱」：切換到帳號登入（只限管理員的頁面本來就是帳號模式）
async function acct(page) {
  // 先等登入框出現（暱稱或帳號模式），再決定要不要切換，避免畫面還沒畫好就判斷
  await page.waitForSelector('#zx-login-nick:visible, #zx-login-email:visible', { timeout: 15000 });
  if (await page.isVisible('#zx-login-admin')) await page.click('#zx-login-admin');
  await page.waitForSelector('#zx-login-email', { state: 'visible', timeout: 15000 });
}
async function loginAcct(page, email, pw) {
  await acct(page);
  await page.fill('#zx-login-email', email); await page.fill('#zx-login-pw', pw); await page.click('.zx-login-btn');
}
async function login(page, base, site, email, pw, extraWait) {
  await page.goto(base + '/' + site + '/');
  await page.waitForSelector('#zx-login', { timeout: 15000 });
  await acct(page);
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
module.exports = { login, acct, loginAcct };
